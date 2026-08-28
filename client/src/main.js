import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './style.css';

const app = createApp(App);

// 全局错误捕获：渲染异常记录到 window.__xjErr，便于线上诊断
app.config.errorHandler = (err, _instance, info) => {
  window.__xjErr = `${err && err.stack ? err.stack : String(err)} || hook=${info}`;
  console.error('[xianjian] render error:', err, info);
};

app.use(createPinia()).use(router).mount('#app');
