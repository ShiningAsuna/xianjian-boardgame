// Socket.IO 实时层：房间加入/开局/游戏动作/询问响应/断线代管
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');
const hub = require('./hub');

function setup(io) {
  // 握手鉴权：socket.auth = { token }
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token || '', config.JWT_SECRET);
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(payload.uid);
      if (!user) return next(new Error('账号不存在'));
      socket.user = user;
      next();
    } catch {
      next(new Error('登录已过期，请重新登录'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`[io] ${user.username} connected (${socket.id})`);

    function pushRoomInfo(room) {
      if (!room?.emitter) return;
      for (const s of room.emitter.values()) s.emit('room_info', hub.lobbyView(room));
    }

    socket.on('room_join', ({ roomId }, ack) => {
      let room = hub.findRoomByPlayer(user.id); // 断线重连时直接回原房间
      if (!room || room.id !== roomId) {
        const res = hub.joinRoom(roomId, { id: user.id, username: user.username });
        if (res.error) {
          ack && ack({ error: res.error });
          return;
        }
        room = hub.rooms.get(roomId);
      }
      hub.attachSocket(room, user.id, socket);
      socket.data.roomId = room.id;
      ack && ack({ ok: true, room: hub.lobbyView(room) });
      if (room.status === 'waiting') pushRoomInfo(room);
    });

    socket.on('room_leave', () => {
      const room = hub.rooms.get(socket.data.roomId);
      if (!room) return;
      hub.detachSocket(room, user.id);
      hub.leaveRoom(room.id, user.id);
      pushRoomInfo(room);
    });

    socket.on('start_game', async (_payload, ack) => {
      const roomId = socket.data.roomId;
      if (!roomId) return ack && ack({ error: '不在任何房间里' });
      const res = hub.startGame(roomId, user.id);
      if (res.error) return ack && ack({ error: res.error });
      hub.broadcastState(hub.rooms.get(roomId));
      ack && ack({ ok: true });
    });

    // 角色选择阶段：弃置/选择一张角色牌
    socket.on('pick_select', ({ key } = {}) => {
      const room = hub.rooms.get(socket.data.roomId);
      if (!room || !room.game) return socket.emit('action_error', { error: '还没有开始对局。' });
      const result = room.game.actionPickSelect(user.id, key);
      if (!result.ok) socket.emit('action_error', { error: result.error });
    });

    // 引擎询问响应（隐蛊/冰心诀/濒死救援/参战者指定/战牌出牌/是否开战等）
    socket.on('submit_pending', ({ pendingId, answer } = {}) => {
      const room = hub.rooms.get(socket.data.roomId);
      if (!room || !room.game) return socket.emit('action_error', { error: '还没有开始对局。' });
      const result = room.game.submitPending(user.id, pendingId, answer);
      if (!result.ok) socket.emit('action_error', { error: result.error });
    });

    socket.on('use_character_skill', ({ key, args, pendingId } = {}) => {
      const room = hub.rooms.get(socket.data.roomId);
      if (!room || !room.game) return socket.emit('action_error', { error: '还没有开始对局。' });
      const result = room.game.actionUseCharacterSkill(user.id, key, args || {}, pendingId || null);
      if (!result.ok) socket.emit('action_error', { error: result.error });
    });

    // 游戏动作统一入口
    socket.on('game_action', ({ type, uid, targetId, targetKind, toId, key, args, pendingId } = {}) => {
      const room = hub.rooms.get(socket.data.roomId);
      if (!room || !room.game) return socket.emit('action_error', { error: '还没有开始对局。' });
      const g = room.game;
      const actions = {
        draw_event: () => g.actionDrawEvent(user.id),
        skip_event: () => g.actionSkipEvent(user.id),
        play_card: () => g.actionPlayCard(user.id, uid, targetId ?? null, targetKind ?? null),
        give_card: () => g.actionGiveCard(user.id, uid, toId),
        use_character_skill: () => g.actionUseCharacterSkill(user.id, key, args || {}, pendingId || null),
        go_battle: () => g.actionGoBattle(user.id),
        finish_turn: () => g.actionFinishTurn(user.id),
      };
      const fn = actions[type];
      if (!fn) return socket.emit('action_error', { error: `未知动作: ${type}` });
      const result = fn();
      if (!result.ok) socket.emit('action_error', { error: result.error });
    });

    socket.on('disconnect', () => {
      console.log(`[io] ${user.username} disconnected`);
      const affected = [];
      for (const room of hub.rooms.values()) {
        if (room.players.some((p) => p.id === user.id)) affected.push(room);
      }
      hub.handleDisconnect(user);
      for (const room of affected) {
        if (hub.rooms.has(room.id)) pushRoomInfo(room);
      }
    });
  });
}

module.exports = setup;
