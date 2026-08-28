<script setup>
// 对战主界面：等待区 + 四阶段流程对战台
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';
import SeatPanel from '../components/SeatPanel.vue';
import CardFace from '../components/CardFace.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const game = useGameStore();

game.joinRoom(route.params.id);

const st = computed(() => game.state);
const room = computed(() => game.room);
const me = computed(() => auth.user);
const isHost = computed(() => !!room.value && room.value.hostId === me.value?.id);
const isMyTurn = computed(() => !!st.value && !st.value.over && st.value.turnPlayerId === me.value?.id);
const canPlayCard = computed(() => isMyTurn.value && st.value.phase === 'skill');

const PHASES = [
  { key: 'event', label: '① 事件' },
  { key: 'skill', label: '② 技牌' },
  { key: 'battle', label: '③ 战斗' },
  { key: 'draw', label: '④ 补牌' },
];

const turnSeat = computed(() =>
  st.value ? st.value.players.find((p) => p.id === st.value.turnPlayerId) : null
);
const currentPhaseIdx = computed(() =>
  st.value ? PHASES.findIndex((p) => p.key === st.value.phase) : -1
);
const seatsBy = (k) => (st.value ? st.value.players.filter((p) => p.faction === k) : []);
const factionName = (k) => st.value?.factions.find((f) => f.key === k)?.name ?? k;
const emptySlots = computed(() =>
  room.value ? Math.max(room.value.size - room.value.players.length, 0) : 0
);

function act(type, uid) {
  game.action(type, uid);
}
function backToLobby() {
  game.leaveAndReset();
  router.push('/lobby');
}

const logBox = ref(null);
watch(
  () => st.value?.log?.length,
  async () => {
    await nextTick();
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  },
  { immediate: true }
);

const resultPlayers = computed(() =>
  st.value ? st.value.players.slice().sort((a, b) => b.petScore - a.petScore) : []
);
</script>

<template>
  <div class="game-page">
    <!-- 等待开局 -->
    <section v-if="!st" class="waiting panel">
      <h2>{{ room?.name || '……' }}</h2>
      <div v-if="room">
        <p class="dim">
          {{ room.mode === 'pve' ? '闯关模式（不足员时由人机补位）' : '对战模式' }} · 目标 {{ room.size }} 人 ·
          已就座 {{ room.players.length }}
        </p>
        <div class="slots">
          <div v-for="p in room.players" :key="p.id" class="slot filled">
            👤 {{ p.name }}
            <span v-if="p.id === room.hostId" class="crown">👑 房主</span>
          </div>
          <div v-for="i in emptySlots" :key="'e' + i" class="slot empty">虚位 · 开局后人机补足</div>
        </div>
        <div class="actions-row">
          <button v-if="isHost" class="btn primary big" @click="game.startGame()">开始对局</button>
          <span v-else class="dim">等待房主开始…</span>
          <button class="btn ghost" @click="backToLobby">离开房间</button>
        </div>
      </div>
      <div v-else>
        <p class="dim">{{ game.error || '正在连接房间…' }}</p>
        <button class="btn" @click="backToLobby">返回大厅</button>
      </div>
    </section>

    <!-- 对战台 -->
    <template v-else-if="!st.over">
      <header class="hud panel">
        <div class="scores">
          <span class="fc-name a">{{ factionName('a') }}</span>
          <b>{{ st.scores.a }}</b><i>:</i><b>{{ st.scores.b }}</b>
          <span class="fc-name b">{{ factionName('b') }}</span>
        </div>
        <ol class="steps">
          <li v-for="(p, i) in PHASES" :key="p.key"
              :class="{ on: p.key === st.phase, past: currentPhaseIdx > i }">
            {{ p.label }}
          </li>
        </ol>
        <div class="turn-info">
          当前回合：<b>{{ turnSeat?.name }}</b>（{{ turnSeat?.factionName }}）
          <span v-if="isMyTurn" class="my-turn">—— 轮到你行动！</span>
        </div>
      </header>

      <main class="battle-main">
        <div class="factions-row">
          <div class="fc panel" v-for="f in ['a', 'b']" :key="f" :class="`faction-${f}`">
            <h3>{{ factionName(f) }} <em>{{ st.scores[f] }} 分</em></h3>
            <SeatPanel v-for="s in seatsBy(f)" :key="s.id" :seat="s"
                       :is-you="s.id === me.id" :is-turn="s.id === st.turnPlayerId" />
          </div>
          <div class="deck-box panel">
            <h4>怪兽牌堆</h4>
            <div class="deck-count">{{ st.deckLeft.monster }}</div>
            <span class="dim">剩 {{ st.deckLeft.monster }} 张待翻</span>
            <div class="divider"></div>
            <h4>事件牌堆</h4>
            <div class="deck-count small">{{ st.deckLeft.event }}</div>
            <div class="last-monster" v-if="st.lastMonster">
              <div class="lm-title">上一只怪兽</div>
              <div>{{ st.lastMonster.name }}（战力 {{ st.lastMonster.power }}）</div>
              <div :class="['outcome', st.lastMonster.outcome]">
                {{ st.lastMonster.by }} {{ st.lastMonster.outcome === 'win' ? '收服 ✓' : '战败 ✗' }}
              </div>
            </div>
          </div>
        </div>

        <footer class="my-zone panel" :class="{ active: isMyTurn }">
          <div class="left">
            <div class="my-char">
              <div class="nm">{{ st.you.name }}<small>· {{ st.you.factionName }} · {{ st.you.char.name }}</small></div>
              <div class="hp-line">气血 <b>{{ st.you.hp }}</b>/{{ st.you.maxHp }}</div>
              <div class="pw-line">
                战力 <b>{{ st.you.totalPower }}</b>
                <small>（基础 {{ st.you.basePower }}{{ st.you.tempBuff ? ` + 临时 ${st.you.tempBuff}` : '' }}）</small>
              </div>
              <div class="tag" v-if="!st.you.alive">你已阵亡，观战中</div>
            </div>
          </div>

          <div class="center hand-wrap">
            <div class="label">手牌（{{ st.you.hand.length }}/{{ st.handLimit }}）</div>
            <div class="hand">
              <div v-for="c in st.you.hand" :key="c.uid"
                   :class="['hand-slot', { playable: canPlayCard }]"
                   :title="canPlayCard ? '点击打出' : ''"
                   @click="canPlayCard && act('play_card', c.uid)">
                <CardFace :card="c" mini />
                <span class="kind-tag">{{ c.kind === 'equip' ? '装备' : '即时' }}</span>
              </div>
              <span v-if="!st.you.hand.length" class="empty-hand">空空如也</span>
            </div>
          </div>

          <div class="right actions-col">
            <div class="phase-label">
              {{ ['event','skill','battle','draw'].includes(st.phase) ? PHASES[PHASES.findIndex(p=>p.key===st.phase)].label.replace(/^[①②③④] /,'') : '' }}
            </div>
            <template v-if="isMyTurn">
              <template v-if="st.phase === 'event'">
                <button class="btn primary" @click="act('draw_event')">抽取事件牌</button>
                <button class="btn" @click="act('skip_event')">跳过事件</button>
              </template>
              <template v-else-if="st.phase === 'skill'">
                <span class="hint">点击手牌即可打出/装备</span>
                <button class="btn primary" @click="act('go_battle')">进入战斗阶段 →</button>
              </template>
              <template v-else-if="st.phase === 'battle'">
                <button class="btn danger big-flip" @click="act('flip_monster')">翻开怪兽牌！</button>
              </template>
              <template v-else-if="st.phase === 'draw'">
                <span class="hint">结束回合时自动补牌至 {{ st.handLimit }} 张</span>
                <button class="btn primary" @click="act('finish_turn')">结束回合 ↦ 下一位</button>
              </template>
            </template>
            <span v-else class="hint">{{ turnSeat?.name }} 正在行动…</span>
          </div>
        </footer>
      </main>

      <aside class="logbox panel" ref="logBox">
        <ul>
          <li v-for="(l, i) in st.log" :key="i">{{ l.text }}</li>
        </ul>
      </aside>
    </template>

    <!-- 终局结算 -->
    <div v-else class="result-overlay">
      <div class="result panel">
        <h1>
          {{ st.result.winnerFaction ? `${factionName(st.result.winnerFaction)} 获胜！` : '平局！' }}
        </h1>
        <p class="score-line">蜀山派 {{ st.result.scores.a }} 分 —— 拜月教 {{ st.result.scores.b }} 分</p>
        <table class="result-table">
          <thead><tr><th>玩家</th><th>角色</th><th>阵营</th><th>宠物</th><th>得分</th><th>结局</th></tr></thead>
          <tbody>
            <tr v-for="p in resultPlayers" :key="p.id" :class="{ yourow: p.id === me.id }">
              <td>{{ p.name }}<i v-if="p.isBot"> 🤖</i></td>
              <td>{{ p.char.name }}</td>
              <td>{{ p.factionName }}</td>
              <td>{{ p.pets.length }}</td>
              <td><b>{{ p.petScore }}</b></td>
              <td>{{ p.alive ? '存活' : '阵亡' }}</td>
            </tr>
          </tbody>
        </table>
        <button class="btn primary" @click="backToLobby">返回大厅</button>
      </div>
    </div>

    <transition name="fade">
      <div v-if="game.error" class="toast">{{ game.error }}</div>
    </transition>
  </div>
</template>

<style scoped>
.game-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    'hud log'
    'main log';
  gap: 14px;
  height: 100vh;
  padding: 14px;
}

/* ---------- 等待区 ---------- */
.waiting { grid-column: 1 / 3; align-self: center; justify-self: center; width: 520px; padding: 26px 30px; text-align: center; }
.waiting h2 { margin: 0 0 6px; letter-spacing: 2px; }
.dim { color: var(--dim); font-size: 13px; }
.slots { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 18px 0; }
.slot {
  min-width: 130px; padding: 10px 14px; border-radius: 10px;
  border: 1px dashed var(--panel-border); font-size: 13px; color: var(--dim);
}
.slot.filled { border-style: solid; background: rgba(55, 201, 154, 0.08); color: var(--ink); }
.crown { font-size: 11px; color: var(--gold); margin-left: 6px; }
.actions-row { display: flex; gap: 12px; justify-content: center; align-items: center; margin-top: 8px; }

/* ---------- HUD ---------- */
.hud {
  grid-area: hud;
  display: flex; align-items: center; gap: 26px;
  padding: 12px 20px;
}
.scores { display: flex; align-items: baseline; gap: 10px; font-size: 22px; font-weight: 800; }
.scores i { opacity: .5; font-style: normal; padding: 0 2px; }
.fc-name { font-size: 13px; font-weight: normal; color: var(--dim); letter-spacing: 2px; }
.steps { list-style: none; display: flex; gap: 4px; margin: 0; padding: 0; flex: 1; justify-content: center; }
.steps li {
  font-size: 12px; color: #5f759b; padding: 4px 12px; border-radius: 999px;
  border: 1px solid transparent;
}
.steps li.on { color: var(--gold); border-color: rgba(223, 187, 102, .5); background: rgba(223,187,102,.08); }
.steps li.past { color: #37507a; text-decoration: line-through; }
.turn-info { font-size: 13px; color: var(--dim); }
.turn-info b { color: var(--ink); }
.my-turn { color: var(--jade); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .45; } }

/* ---------- 主战区 ---------- */
.battle-main { grid-area: main; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.factions-row {
  flex: 1; display: grid; min-height: 0;
  grid-template-columns: 1fr 190px 1fr; gap: 12px;
}
.fc { padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.fc h3 { margin: 0 0 2px; font-size: 15px; letter-spacing: 2px; }
.fc h3 em { float: right; color: var(--gold); font-style: normal; font-size: 13px; }

.deck-box { padding: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.deck-box h4 { margin: 2px 0 0; font-size: 12px; color: var(--dim); letter-spacing: 2px; }
.deck-count {
  width: 74px; height: 100px; line-height: 100px; text-align: center;
  font-size: 30px; font-weight: 800; color: var(--gold);
  border-radius: 10px; border: 1px solid rgba(226,106,106,.5);
  background:
    repeating-linear-gradient(-45deg, rgba(226,106,106,.09) 0 8px, transparent 8px 16px),
    linear-gradient(160deg, #20293f, #131c2e);
  box-shadow: 0 8px 18px rgba(0,0,0,.35), inset 0 0 22px rgba(0,0,0,.3);
}
.deck-count.small { width: 60px; height: 78px; line-height: 78px; font-size: 20px; color: var(--blue); border-color: rgba(99,169,234,.45); background: linear-gradient(160deg, #1c2740, #12192b); box-shadow: none; }
.divider { width: 80%; border-top: 1px dashed var(--panel-border); margin: 8px 0 4px; }
.last-monster { font-size: 11.5px; color: var(--dim); text-align: center; }
.lm-title { color: var(--ink); margin-bottom: 3px; }
.outcome.win { color: var(--jade); }
.outcome.lose { color: var(--red); }

/* ---------- 我的区域 ---------- */
.my-zone {
  display: grid; grid-template-columns: 200px minmax(0, 1fr) 210px;
  gap: 16px; padding: 14px 16px; min-height: 208px;
}
.my-zone.active { border-color: rgba(55, 201, 154, .65); box-shadow: 0 0 24px rgba(55,201,154,.12); }
.nm { font-weight: 700; }
.nm small { color: var(--dim); font-weight: normal; }
.hp-line, .pw-line { font-size: 13px; color: var(--dim); margin-top: 8px; }
.pw-line b, .hp-line b { color: var(--gold); font-size: 17px; }

.label { font-size: 12px; color: var(--dim); margin-bottom: 8px; letter-spacing: 1px; }
.hand { display: flex; gap: 8px; flex-wrap: wrap; overflow-y: auto; max-height: 168px; }
.hand-slot { position: relative; transition: transform .12s ease; }
.hand-slot.playable { cursor: pointer; }
.hand-slot.playable:hover { transform: translateY(-6px) scale(1.03); }
.kind-tag {
  position: absolute; right: -4px; top: -7px; font-size: 10px;
  background: #101a2c; border: 1px solid var(--panel-border);
  padding: 1px 6px; border-radius: 999px; color: var(--jade);
}
.empty-hand { color: var(--dim); font-size: 13px; align-self: center; }

.actions-col { display: flex; flex-direction: column; gap: 10px; justify-content: center; }
.phase-label { font-size: 12px; color: var(--gold); letter-spacing: 2px; }
.hint { font-size: 12px; color: var(--dim); }
.big-flip { padding: 14px; font-size: 15px; letter-spacing: 2px; }

/* ---------- 日志 ---------- */
.logbox { grid-area: log; overflow-y: auto; padding: 14px; }
.logbox ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.logbox li { font-size: 12px; line-height: 1.6; color: var(--dim); border-bottom: 1px dashed rgba(39,57,92,.35); padding-bottom: 6px; }
.logbox li:last-child { color: var(--ink); }

/* ---------- 结算 ---------- */
.result-overlay { grid-column: 1 / 3; display: grid; place-items: center; }
.result { width: 640px; padding: 30px 34px; text-align: center; }
.result h1 { margin: 0 0 8px; letter-spacing: 3px; color: var(--gold); }
.score-line { color: var(--dim); margin-bottom: 18px; }
.result-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
.result-table th, .result-table td { padding: 7px 6px; border-bottom: 1px solid rgba(39,57,92,.5); }
.result-table th { color: var(--dim); font-weight: normal; font-size: 12px; }
.yourow td { background: rgba(55,201,154,.06); }

/* ---------- 其他 ---------- */
.toast {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  background: #3b1d1d; border: 1px solid rgba(226,106,106,.6);
  color: #ffd9d9; padding: 10px 22px; border-radius: 999px; font-size: 13px;
  z-index: 99; box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
