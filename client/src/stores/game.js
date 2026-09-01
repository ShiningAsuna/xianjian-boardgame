// Socket.IO 状态中心：大厅房间信息、对局状态、动作发送
import { defineStore } from 'pinia';
import { io } from 'socket.io-client';
import { loadAuth } from '../api/http';
import { useAuthStore } from './auth';

export const useGameStore = defineStore('game', {
  state: () => ({
    socket: null,
    connected: false,
    room: null,     // lobbyView(room)：等待中的房间信息
    state: null,    // 引擎 viewFor(uid) 裁剪后的对局状态
    error: '',      // 最近一次动作错误提示
  }),

  actions: {
    ensureSocket() {
      if (this.socket) return;
      this.socket = io('/', {
        auth: { token: loadAuth()?.token },
        reconnectionDelayMax: 3000,
      });
      this.socket.on('connect', () => { this.connected = true; });
      this.socket.on('disconnect', () => { this.connected = false; });
      this.socket.on('connect_error', (e) => {
        // token 失效时回登录页
        useAuthStore().logout();
        location.href = '/login';
        console.warn('socket connect_error:', e.message);
      });
      this.socket.on('room_info', (room) => { this.room = room; });
      this.socket.on('game_state', (state) => { this.state = state; });
      this.socket.on('action_error', (e) => {
        this.error = e?.error || '操作失败';
        const msg = this.error;
        setTimeout(() => { if (this.error === msg) this.error = ''; }, 2600);
      });
    },

    joinRoom(roomId) {
      this.ensureSocket();
      this.socket.emit('room_join', { roomId }, (res) => {
        if (res?.error) this.error = res.error;
        else this.room = res.room;
      });
    },

    startGame() {
      if (!this.room) return;
      this.socket.emit('start_game', {}, (res) => {
        if (res?.error) this.error = res.error;
      });
    },

    // 角色选择：弃置/选择一张角色牌
    pickSelect(key) {
      this.socket.emit('pick_select', { key });
    },

    // 引擎询问响应（濒死救援/隐蛊/冰心诀/参战者指定/战牌等）
    submitPending(answer) {
      this.socket.emit('submit_pending', { answer });
    },

    action(type, opts = {}) {
      this.ensureSocket();
      this.socket.emit('game_action', { type, ...opts });
    },

    leaveAndReset() {
      if (!this.socket) return;
      this.socket.emit('room_leave');
      this.room = null;
      this.state = null;
    },

    reset() {
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
        this.connected = false;
      }
      this.$reset();
    },
  },
});
