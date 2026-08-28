import { defineStore } from 'pinia';
import { api, loadAuth, saveAuth } from '../api/http';

export const useAuthStore = defineStore('auth', {
  state: () => {
    const saved = loadAuth();
    return {
      token: saved?.token || '',
      user: saved?.user || null,
    };
  },
  getters: {
    isLoggedIn: (s) => !!s.token,
  },
  actions: {
    _save({ token, user }) {
      this.token = token;
      this.user = user;
      saveAuth({ token, user });
    },
    async login(username, password) {
      this._save(await api.login(username, password));
    },
    async register(username, password) {
      this._save(await api.register(username, password));
    },
    logout() {
      this.token = '';
      this.user = null;
      saveAuth(null);
    },
  },
});
