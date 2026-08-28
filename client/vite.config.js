import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发时把 /api 与 /socket.io 代理到后端 3000 端口
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
