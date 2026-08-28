// 房间管理（内存态）：创建/加入/开始，以及游戏实例生命周期。
// 房间元数据同时通过 REST 暴露给大厅轮询；对局内实时状态走 Socket.IO。

const crypto = require('crypto');
const XianjianGame = require('./game/engine');
const config = require('./config');
const db = require('./db');

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> room
  }

  createRoom(hostUser, { size, mode, name }) {
    if (!config.GAME_SIZES.includes(size)) size = 4;
    mode = mode === 'pvp' ? 'pvp' : 'pve';
    const id = crypto.randomUUID().slice(0, 8);
    const room = {
      id,
      name: (name || `${hostUser.username} 的房间`).slice(0, 20),
      hostId: hostUser.id,
      hostName: hostUser.username,
      size,                 // 总座位数：4 或 6
      mode,                 // pvp: 坐满人开局(含补位bot)；pve: 创建即带 bot
      status: 'waiting',    // waiting | playing | finished
      players: [{ id: hostUser.id, name: hostUser.username, isBot: false, online: true }],
      game: null,
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return this.lobbyView(room);
  }

  joinRoom(roomId, user) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: '房间不存在或已解散。' };
    if (room.status !== 'waiting') return { error: '游戏已开局，无法加入。' };
    let seat = room.players.find((p) => p.id === user.id);
    if (!seat) {
      if (room.players.length >= room.size) return { error: '房间已满。' };
      seat = { id: user.id, name: user.username, isBot: false, online: true };
      room.players.push(seat);
    }
    seat.online = true;
    return { room: this.lobbyView(room) };
  }

  leaveRoom(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    room.players = room.players.filter((p) => p.id !== userId || p.isBot);
    if (room.players.length === 0 || (userId === room.hostId && !room.players.some((p) => p.id === userId))) {
      // 房主离开则解散
      this.rooms.delete(roomId);
    }
  }

  /** 正式开局。pve 时用 bot 补齐剩余座位；pvp 人数未满也可以由房主强行开始 */
  startGame(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: '房间不存在。' };
    if (room.status !== 'waiting') return { error: '已经开局了。' };
    if (userId !== room.hostId) return { error: '只有房主可以开局。' };

    const seats = room.players.map((p) => ({ id: p.id, name: p.name, isBot: false }));
    for (let i = seats.length; i < room.size; i++) {
      seats.push({ id: `bot_${crypto.randomUUID().slice(0, 6)}`, name: `仙灵·${i}`, isBot: true });
    }
    room.players = seats.map((s) => ({
      id: s.id, name: s.name, isBot: s.isBot, online: !s.isBot,
    }));

    room.game = new XianjianGame({
      roomId: room.id,
      players: seats,
      mode: room.mode,
      onState: () => this.broadcastState(room),
      onEnd: (record) => this.persistMatch(record),
    });
    room.status = 'playing';
    this.maybeRunBots(room);
    return { ok: true };
  }

  /**
   * 离开房间：
   * - 等待中：直接移除座位（房主离开则解散）；
   * - 进行中：座位保留并转为“离线托管”，可随时重连回原房间；
   * - 已结束：移除座位，全员走光后自动清理房间。
   */
  leaveRoom(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.status === 'waiting') {
      room.players = room.players.filter((p) => p.id !== userId);
      if (room.players.length === 0 || userId === room.hostId) {
        this.rooms.delete(roomId);
      }
      return;
    }

    room.players = room.players.filter((p) => p.id !== userId || p.isBot);
    if (room.game?.over && !room.players.some((p) => !p.isBot)) {
      this.rooms.delete(roomId);
    }
  }

  broadcastState(room) {
    if (!room.emitter || !room.game) return;
    for (const [userId, socket] of room.emitter.entries()) {
      socket.emit('game_state', room.game.viewFor(userId));
    }
    this.maybeRunBots(room);
  }

  attachSocket(room, userId, socket) {
    if (!room.emitter) room.emitter = new Map();
    room.emitter.set(userId, socket);
    if (room.status === 'playing' && room.game) {
      room.game.markOffline(userId, false); // 重连恢复
      socket.emit('game_state', room.game.viewFor(userId));
    }
  }

  detachSocket(room, userId) {
    if (!room.emitter) return;
    room.emitter.delete(userId);
    if (room.status === 'playing' && room.game && !room.game.over) {
      room.game.markOffline(userId, true);
      this.maybeRunBots(room);
    }
  }

  findRoomByPlayer(userId) {
    for (const room of this.rooms.values()) {
      if (room.players.some((p) => p.id === userId)) return room;
    }
    return null;
  }

  handleDisconnect(user) {
    for (const room of this.rooms.values()) {
      if (room.players.some((p) => p.id === user.id)) {
        this.detachSocket(room, user.id);
        if (room.status === 'waiting') this.leaveRoom(room.id, user.id);
        break;
      }
    }
  }

  maybeRunBots(room) {
    const g = room.game;
    if (!g || g.over || !g.needAutomation()) return;
    const token = g._botToken; // 引擎内部计数，动作后推进会被 cancelAutomation 影响
    setTimeout(async () => {
      await g.runBotLoop(token);
      // 一局结束后若还有房间挂着，允许房主直接留在结算界面
    }, 50);
  }

  persistMatch(record) {
    try {
      db.prepare(
        'INSERT INTO matches (mode, size, winner_faction, ended_reason, detail, started_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(record.mode, record.size, record.winner_faction, record.ended_reason, record.detail, record.started_at);
    } catch (e) {
      console.error('[rooms] persist match failed:', e.message);
    }
  }

  lobbyView(room) {
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      hostName: room.hostName,
      size: room.size,
      filled: room.players.filter((p) => !p.isBot).length,
      mode: room.mode,
      status: room.status,
      players: room.players.filter((p) => !p.isBot).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  listRooms() {
    return [...this.rooms.values()]
      .filter((r) => r.status === 'waiting')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.lobbyView(r));
  }
}

module.exports = RoomManager;
