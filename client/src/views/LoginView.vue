<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

const mode = ref('login'); // login | register
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    if (mode.value === 'login') await auth.login(username.value.trim(), password.value);
    else await auth.register(username.value.trim(), password.value);
    router.push('/lobby');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-box panel">
      <h1>仙剑奇侠传<span>·逍遥游</span></h1>
      <p class="slogan">御剑乘风来，除魔天地间</p>

      <div class="tabs">
        <button :class="{ on: mode === 'login' }" @click="mode = 'login'">登 录</button>
        <button :class="{ on: mode === 'register' }" @click="mode = 'register'">注 册</button>
      </div>

      <form @submit.prevent="submit">
        <input v-model="username" placeholder="用户名" maxlength="16" autocomplete="username" />
        <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
        <button class="btn primary big" type="submit" :disabled="busy">
          {{ busy ? '请稍候…' : mode === 'login' ? '进入江湖' : '踏入江湖' }}
        </button>
      </form>
      <p v-if="error" class="err">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.login-box { width: 360px; padding: 34px 34px 26px; text-align: center; }
h1 { margin: 0; font-size: 26px; letter-spacing: 4px; }
h1 span { color: var(--jade); font-size: 20px; }
.slogan { color: var(--dim); font-size: 13px; letter-spacing: 6px; margin: 8px 0 22px; }

.tabs { display: flex; gap: 10px; justify-content: center; margin-bottom: 18px; }
.tabs button {
  background: none; border: none; color: var(--dim);
  font-size: 15px; cursor: pointer; padding: 4px 14px;
  border-bottom: 2px solid transparent;
}
.tabs button.on { color: var(--ink); border-color: var(--jade); }

form { display: flex; flex-direction: column; gap: 12px; }
.btn.big { padding: 11px; font-size: 15px; letter-spacing: 4px; }
.err { color: var(--red); font-size: 13px; margin-top: 12px; }
</style>
