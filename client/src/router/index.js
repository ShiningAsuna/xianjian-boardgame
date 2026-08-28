import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const LoginView = () => import('../views/LoginView.vue');
const LobbyView = () => import('../views/LobbyView.vue');
const CodexView = () => import('../views/CodexView.vue');
const GameView = () => import('../views/GameView.vue');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/lobby' },
    { path: '/login', component: LoginView },
    { path: '/lobby', component: LobbyView },
    { path: '/codex', component: CodexView },
    { path: '/game/:id', component: GameView },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!auth.token && to.path !== '/login') return '/login';
  if (auth.token && to.path === '/login') return '/lobby';
});

export default router;
