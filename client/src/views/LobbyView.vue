<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/http';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

const rooms = ref([]);
const matches = ref([]);
const showHistory = ref(false);
const creating = ref(false);
const form = reactive({
  mode: 'pve',
  size: 4,
  name: '',
  pickTotal: 12, // 抽取角色数 n（须为偶数）
  pickOpen: 6,   // 明牌数 x
});
let timer = null;

async function refresh() {
  try { rooms.value = await api.listRooms(); } catch { /* 忽略轮询错误 */ }
}

async function createRoom() {
  creating.value = true;
  try {
    const room = await api.createRoom({
      ...form,
      name: form.name.trim(),
      pickConfig: { total: Number(form.pickTotal), open: Number(form.pickOpen) },
    });
    router.push(`/game/${room.id}`);
  } catch (e) {
    alert(e.message);
  } finally {
    creating.value = false;
  }
}

async function loadHistory() {
  if (!showHistory.value) return;
  try { matches.value = await api.matches(); } catch {}
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="lobby">
    <header class="topbar panel">
      <div class="brand">仙剑 · 逍遥游</div>
      <nav>
        <RouterLink to="/codex">卡牌图鉴</RouterLink>
      </nav>
      <div class="spacer"></div>
      <span class="hello">侠士：{{ auth.user?.username }}</span>
      <button class="btn ghost" @click="auth.logout(); router.push('/login')">退出</button>
    </header>

    <main class="content">
      <section class="panel block">
        <h2>创建房间</h2>
        <div class="form-row">
          <label>
            模式
            <select v-model="form.mode">
              <option value="pve">闯关（人机补位）</option>
              <option value="pvp">对战（真人）</option>
            </select>
          </label>
          <label>
            人数
            <select v-model.number="form.size">
              <option :value="4">4 人</option>
              <option :value="6">6 人</option>
            </select>
          </label>
          <label class="grow">
            房间名
            <input v-model="form.name" maxlength="20" placeholder="留空则默认为 你的房间名" />
          </label>
          <button class="btn primary" :disabled="creating" @click="createRoom">创建并进入</button>
        </div>
        <div class="form-row">
          <label>
            抽取角色数 n（偶数）
            <input v-model.number="form.pickTotal" type="number" min="6" max="12" step="2" />
          </label>
          <label>
            明牌数 x
            <input v-model.number="form.pickOpen" type="number" :min="0" :max="form.pickTotal" step="2" />
          </label>
          <label>
            暗牌数 y（自动）
            <input :value="Math.max(form.pickTotal - form.pickOpen, 0)" disabled />
          </label>
          <span class="pick-hint">角色牌库每种 2 份共 10 张，n 超出时自动收敛；双方各弃 1 张后交替轮选。</span>
        </div>
        <p class="tip">规则速览：开局先进行「角色选择阶段」（明暗牌 + 双方弃置 + 交替轮选）；每回合依次经过【事件 → 技牌 → 战斗 → 补牌】四阶段；战斗阶段含确认/参战者/翻取/出场/命中/战牌/结算/胜负 8 个子阶段；怪兽翻完比双方宠物总战力，或一方全灭即分胜负。</p>
      </section>

      <section class="panel block">
        <h2>等待中的房间（3 秒刷新）</h2>
        <table v-if="rooms.length" class="rooms">
          <thead><tr><th>房间名</th><th>房主</th><th>模式</th><th>角色配置</th><th>座位</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in rooms" :key="r.id">
              <td>{{ r.name }}</td>
              <td>{{ r.hostName }}</td>
              <td>{{ r.mode === 'pve' ? '人机' : '对战' }} · {{ r.size }} 人</td>
              <td>抽{{ r.pickConfig?.total ?? '-' }}（明{{ r.pickConfig?.open ?? '-' }}/暗{{ (r.pickConfig?.total ?? 0) - (r.pickConfig?.open ?? 0) }}）</td>
              <td>{{ r.filled }}/{{ r.size }}</td>
              <td><button class="btn" @click="router.push(`/game/${r.id}`)">加入</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">暂无等待中的房间，创建一个吧。</p>
      </section>

      <section class="panel block">
        <h2>对局战绩
          <button class="btn ghost small" @click="showHistory = !showHistory; $nextTick(loadHistory)">
            {{ showHistory ? '收起' : '展开' }}
          </button>
        </h2>
        <ul v-if="showHistory" class="history">
          <li v-for="m in matches" :key="m.id">
            <span class="when">{{ m.started_at.slice(0, 16).replace('T', ' ') }}</span>
            <span>{{ m.mode === 'pve' ? '人机局' : '对战局' }} · {{ m.size }}人</span>
            <span class="verdict">{{ m.winner_faction === 'a' ? '🏆 蜀山派胜' : m.winner_faction === 'b' ? '🏆 拜月教胜' : '平局' }}</span>
            <span>
              MVP：{{ m.detail.slice().sort((x, y) => y.score - x.score).slice(0, 2).map((p) => `${p.name}(${p.score}分)`).join(' / ') }}
            </span>
          </li>
        </ul>
        <p v-else class="empty">完成一局后可在此查看战绩。</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.lobby { max-width: 1000px; margin: 0 auto; padding: 20px; }
.topbar { display: flex; align-items: center; gap: 20px; padding: 12px 20px; }
.brand { font-weight: 800; letter-spacing: 3px; color: var(--gold); }
.topbar nav a { color: var(--dim); text-decoration: none; margin-right: 14px; }
.topbar nav a:hover { color: var(--ink); }
.spacer { flex: 1; }

.content { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
.block { padding: 18px 22px; }
.block h2 { margin: 0 0 12px; font-size: 17px; display: flex; align-items: center; gap: 12px; }
.btn.small { padding: 4px 12px; font-size: 12px; }

.form-row { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; }
.form-row label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dim); }
.form-row .grow { flex: 1; min-width: 220px; }
.form-row input[type="number"] { width: 110px; }
.pick-hint { font-size: 11.5px; color: var(--dim); align-self: center; max-width: 420px; line-height: 1.6; }
.tip { color: var(--dim); font-size: 12.5px; line-height: 1.7; margin: 14px 0 0; }

.rooms { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.rooms th, .rooms td { text-align: left; padding: 9px 8px; border-bottom: 1px solid rgba(39, 57, 92, 0.5); }
.rooms th { color: var(--dim); font-weight: normal; font-size: 12px; }
.empty { color: var(--dim); font-size: 13px; }

.history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.history li { display: flex; gap: 22px; font-size: 13px; color: var(--dim); border-bottom: 1px dashed rgba(39,57,92,.4); padding-bottom: 7px; }
.when { color: #5f759b; }
</style>
