<script setup>
// 对战主界面：等待区 → 角色选择 → 四阶段对战台（含战斗 8 子阶段展示）
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';
import SeatPanel from '../components/SeatPanel.vue';
import CardFace from '../components/CardFace.vue';
import RolePickPanel from '../components/RolePickPanel.vue';
import PendingDialog from '../components/PendingDialog.vue';

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

const PHASES = [
  { key: 'event', label: '① 事件' },
  { key: 'skill', label: '② 技牌' },
  { key: 'battle', label: '③ 战斗' },
  { key: 'draw', label: '④ 补牌' },
];

const battle = computed(() => st.value?.battle);
const turnSeat = computed(() =>
  st.value ? st.value.players.find((p) => p.id === st.value.turnPlayerId) : null
);
const seatsBy = (k) => (st.value ? st.value.players.filter((p) => p.faction === k) : []);
const factionName = (k) => st.value?.factions.find((f) => f.key === k)?.name ?? k;
const emptySlots = computed(() =>
  room.value ? Math.max(room.value.size - room.value.players.length, 0) : 0
);

const BATTLE_STAGES = [
  ['confirm', '确认'], ['roles', '参战者'], ['flip', '翻取'], ['appear', '出场'],
  ['hit', '命中'], ['cards', '战牌'], ['resolve', '结算'], ['settle', '胜负'],
];
const stageIdx = computed(() => {
  const i = BATTLE_STAGES.findIndex(([k]) => k === battle.value?.stage);
  return i;
});

// ---------- 手牌 ----------
const TYPE_LABEL = { 1: '特殊', 2: '装备', 3: '技牌', 4: '战牌' };
const SKILL_NEED_TARGET = [15, 16, 17, 18];
const needTarget = (c) => c.type === 3 && SKILL_NEED_TARGET.includes(c.id);
const hasGhost = computed(() => !!(st.value?.you?.char?.skill || []).some((s) => s.name === '鬼灵精'));
const canPlay = (c) => {
  if (!isMyTurn.value || st.value.phase !== 'skill') return false;
  if (c.type === 2 || c.type === 3) return true;
  if (c.type === 1) return c.id === 2; // 灵葫仙丹可自用；冰心诀/隐蛊为响应牌
  return false;
};

// 目标选择模式（技牌/赠牌）
const targeting = ref(null); // { mode: 'skill'|'give', uid }
function startTarget(card) {
  if (!canPlay(card)) return;
  if (needTarget(card)) { targeting.value = { mode: 'skill', uid: card.uid }; return; }
  game.action('play_card', { uid: card.uid });
}
function startGive(card) {
  targeting.value = { mode: 'give', uid: card.uid };
}
function clickSeat(seat) {
  if (!targeting.value || seat.id === me.value.id || !seat.alive) return;
  if (targeting.value.mode === 'skill') {
    const card = st.value.you.hand.find((c) => c.uid === targeting.value.uid);
    const kind = card && card.id === 17 ? (seat.equips.length ? 'equip' : 'hand') : undefined;
    game.action('play_card', { uid: targeting.value.uid, targetId: seat.id, targetKind: kind });
  } else {
    game.action('give_card', { uid: targeting.value.uid, toId: seat.id });
  }
  targeting.value = null;
}
function cancelTargeting() { targeting.value = null; }

function act(type) { game.action(type); }
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
          <template v-if="room.pickConfig">· 角色配置：抽{{ room.pickConfig.total }}张（明{{ room.pickConfig.open }}/暗{{ room.pickConfig.total - room.pickConfig.open }}）</template>
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

    <template v-else>
      <!-- 角色选择阶段 -->
      <RolePickPanel v-if="st.phase === 'pick'" />

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
                :class="{ on: p.key === st.phase, past: PHASES.findIndex(x => x.key === st.phase) > i }">
              {{ p.label }}
            </li>
          </ol>
          <div class="turn-info">
            当前回合：<b>{{ turnSeat?.name }}</b>
            <span v-if="isMyTurn" class="my-turn">—— 轮到你！</span>
          </div>
        </header>

        <main class="battle-main">
          <!-- 战斗面板 -->
          <section v-if="battle" class="battlebox panel">
            <div class="bt-head">
              <h3>⚔ 战斗阶段</h3>
              <ol class="bt-stages">
                <li v-for="(s, i) in BATTLE_STAGES" :key="s[0]"
                    :class="{ on: i === stageIdx, past: i < stageIdx }">{{ s[1] }}</li>
              </ol>
            </div>
            <div class="bt-body">
              <div class="bt-side">
                <div class="bt-role">触发者<br><b>{{ battle.trigger.name }}</b></div>
                <div class="bt-role" v-if="battle.supporter">支援者<br><b>{{ battle.supporter.name }}</b>
                  <i :class="battle.supporterHit ? 'hit' : 'miss'">{{ battle.supporterHit ? '命中✓' : '未命中✗' }}</i>
                </div>
                <div class="bt-power">{{ battle.powerA }}</div>
              </div>
              <div class="bt-monster" v-if="battle.monster">
                <div class="bt-mname">{{ battle.monster.name }}</div>
                <div class="bt-mmeta">{{ battle.monster.element }}属性 · 战力{{ battle.monster.power }} · 闪避{{ battle.monster.range }}</div>
                <div class="bt-mfx" v-if="battle.monster.appear">出场：{{ battle.monster.appear }}</div>
                <div class="bt-mfx" v-if="battle.obstructer">
                  妨碍者 <b>{{ battle.obstructer.name }}</b>
                  <i :class="battle.obstructerHit ? 'hit' : 'miss'">{{ battle.obstructerHit ? '命中✓（战力计入怪物）' : '未命中✗' }}</i>
                </div>
              </div>
              <div class="bt-side right">
                <div class="bt-power">{{ battle.powerB }}</div>
                <div class="bt-role">怪兽方<br><b>战力合计</b></div>
              </div>
            </div>
            <div class="bt-war" v-if="battle.stage === 'cards'">
              战牌阶段：轮到 <b>{{ battle.warTurnSide === 'a' ? '蜀山派' : '拜月教' }}</b> 指定出牌
              <span class="dim">（已行动 {{ battle.actedWar.length }} 人）</span>
            </div>
            <div class="bt-result" v-if="battle.winnerSide">
              {{ battle.escaped ? '本场战斗被【金蝉脱壳】强制结束' : (battle.winnerSide === battle.trigger.faction ? '触发方战斗胜利！' : '怪物方获胜！') }}
            </div>
          </section>

          <div class="factions-row">
            <div class="fc panel" v-for="f in ['a', 'b']" :key="f" :class="`faction-${f}`">
              <h3>{{ factionName(f) }} <em>{{ st.scores[f] }} 分</em></h3>
              <SeatPanel v-for="s in seatsBy(f)" :key="s.id" :seat="s"
                         :is-you="s.id === me.id" :is-turn="s.id === st.turnPlayerId"
                         :targetable="!!targeting && s.id !== me.id && s.alive"
                         @click="clickSeat(s)" />
            </div>
            <div class="deck-box panel">
              <h4>怪兽牌堆</h4>
              <div class="deck-count">{{ st.deckLeft.monster }}</div>
              <span class="dim">剩 {{ st.deckLeft.monster }} 张（用完即终局）</span>
              <div class="divider"></div>
              <h4>事件牌堆</h4>
              <div class="deck-count small">{{ st.deckLeft.event }}</div>
              <span class="dim">剩 {{ st.deckLeft.event }} 张</span>
              <div class="divider"></div>
              <h4>手牌堆</h4>
              <div class="deck-count small blue">{{ st.deckLeft.hand }}</div>
              <div class="last-monster" v-if="st.lastMonster">
                <div class="lm-title">最近怪兽</div>
                <div>{{ st.lastMonster.name }}（{{ st.lastMonster.element }}·力{{ st.lastMonster.power }}）</div>
              </div>
            </div>
          </div>

          <footer class="my-zone panel" :class="{ active: isMyTurn }">
            <div class="left">
              <div class="my-char" v-if="st.you?.char">
                <div class="nm">{{ st.you.name }}<small>· {{ st.you.factionName }} · {{ st.you.char.name }}</small></div>
                <div class="hp-line">气血 <b>{{ st.you.hp }}</b>/{{ st.you.maxHp }}</div>
                <div class="pw-line">
                  战力 <b>{{ st.you.effPower }}</b> · 命中 <b>{{ st.you.effRange }}</b>
                </div>
                <div class="skill-list">
                  <div v-for="s in st.you.char.skill" :key="s.name" class="skill-item" :title="s.desc">✦ {{ s.name }}</div>
                </div>
                <div class="equip-list" v-if="st.you.equips.length">
                  🎒 <span v-for="e in st.you.equips" :key="e.uid" class="eq-chip" :title="e.desc">{{ e.name }}</span>
                </div>
                <div class="pet-list" v-if="st.you.pets.length">
                  🐾 <span v-for="p in st.you.pets" :key="p.uid" class="pet-chip" :title="p.pets">{{ p.name }}·{{ p.element }}</span>
                </div>
              </div>
            </div>

            <div class="center hand-wrap">
              <div class="label">
                手牌（{{ st.you.hand.length }}/{{ st.handKeep }}+）
                <template v-if="targeting">
                  <span class="targeting-hint">→ 请点击要指定{{ targeting.mode === 'give' ? '接收' : '' }}的玩家</span>
                  <button class="btn ghost tiny" @click="cancelTargeting">取消</button>
                </template>
              </div>
              <div class="hand">
                <div v-for="c in st.you.hand" :key="c.uid"
                     :class="['hand-slot', `ht-${c.type}`, { playable: canPlay(c), targeting: targeting?.uid === c.uid }]"
                     @click="startTarget(c)">
                  <CardFace :card="c" mini />
                  <span class="kind-tag">{{ TYPE_LABEL[c.type] }}</span>
                  <button v-if="hasGhost && isMyTurn && st.phase === 'skill' && targeting?.mode !== 'give'"
                          class="give-btn" title="鬼灵精：将此牌赠予他人"
                          @click.stop="startGive(c)">赠</button>
                </div>
                <span v-if="!st.you.hand.length" class="empty-hand">空空如也</span>
              </div>
            </div>

            <div class="right actions-col">
              <template v-if="isMyTurn">
                <template v-if="st.phase === 'event'">
                  <button class="btn primary" @click="act('draw_event')" :disabled="!st.deckLeft.event">抽取事件牌</button>
                  <button class="btn" @click="act('skip_event')">跳过事件</button>
                </template>
                <template v-else-if="st.phase === 'skill'">
                  <span class="hint">点手牌出牌/装备（需指定目标的牌：先点牌再点玩家）</span>
                  <button class="btn primary" @click="act('go_battle')">进入战斗阶段 →</button>
                </template>
                <template v-else-if="st.phase === 'battle'">
                  <span class="hint">战斗进行中，请按弹窗指引操作…</span>
                </template>
                <template v-else-if="st.phase === 'draw'">
                  <span class="hint">结束回合时自动补牌并弃至 {{ st.handKeep }} 张</span>
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
          <h1>{{ st.result.winnerFaction ? `${factionName(st.result.winnerFaction)} 获胜！` : '平局！' }}</h1>
          <p class="score-line">
            蜀山派 {{ st.result.scores.a }} 分 —— 拜月教 {{ st.result.scores.b }} 分
            （{{ st.result.reason === 'faction_wiped' ? '阵营全灭' : '怪兽翻完结算' }}）
          </p>
          <table class="result-table">
            <thead><tr><th>玩家</th><th>角色</th><th>阵营</th><th>宠物</th><th>得分</th><th>结局</th></tr></thead>
            <tbody>
              <tr v-for="p in resultPlayers" :key="p.id" :class="{ yourow: p.id === me.id }">
                <td>{{ p.name }}<i v-if="p.isBot"> 🤖</i></td>
                <td>{{ p.char?.name || '-' }}</td>
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
    </template>

    <PendingDialog />
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
.waiting { grid-column: 1 / 3; align-self: center; justify-self: center; width: 540px; padding: 26px 30px; text-align: center; }
.waiting h2 { margin: 0 0 6px; letter-spacing: 2px; }
.dim { color: var(--dim); font-size: 13px; }
.slots { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 18px 0; }
.slot { min-width: 130px; padding: 10px 14px; border-radius: 10px; border: 1px dashed var(--panel-border); font-size: 13px; color: var(--dim); }
.slot.filled { border-style: solid; background: rgba(55, 201, 154, 0.08); color: var(--ink); }
.crown { font-size: 11px; color: var(--gold); margin-left: 6px; }
.actions-row { display: flex; gap: 12px; justify-content: center; align-items: center; margin-top: 8px; }

/* ---------- HUD ---------- */
.hud { grid-area: hud; display: flex; align-items: center; gap: 26px; padding: 12px 20px; flex-wrap: wrap; }
.scores { display: flex; align-items: baseline; gap: 10px; font-size: 22px; font-weight: 800; }
.scores i { opacity: .5; font-style: normal; padding: 0 2px; }
.fc-name { font-size: 13px; font-weight: normal; color: var(--dim); letter-spacing: 2px; }
.steps { list-style: none; display: flex; gap: 4px; margin: 0; padding: 0; flex: 1; justify-content: center; }
.steps li { font-size: 12px; color: #5f759b; padding: 4px 12px; border-radius: 999px; border: 1px solid transparent; }
.steps li.on { color: var(--gold); border-color: rgba(223, 187, 102, .5); background: rgba(223, 187, 102, .08); }
.steps li.past { color: #37507a; text-decoration: line-through; }
.turn-info { font-size: 13px; color: var(--dim); }
.turn-info b { color: var(--ink); }
.my-turn { color: var(--jade); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .45; } }

/* ---------- 战斗面板 ---------- */
.battle-main { grid-area: main; display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow-y: auto; }
.battlebox { padding: 12px 18px; display: flex; flex-direction: column; gap: 10px; border-color: rgba(226, 106, 106, .5); }
.bt-head { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.bt-head h3 { margin: 0; font-size: 15px; color: var(--red); letter-spacing: 2px; }
.bt-stages { list-style: none; display: flex; gap: 3px; margin: 0; padding: 0; flex-wrap: wrap; }
.bt-stages li { font-size: 11px; color: #5f759b; padding: 2px 9px; border-radius: 999px; }
.bt-stages li.on { color: var(--gold); border: 1px solid rgba(223, 187, 102, .5); }
.bt-stages li.past { color: #37507a; }
.bt-body { display: grid; grid-template-columns: 1fr auto 1fr; gap: 14px; align-items: center; }
.bt-side { display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
.bt-side.right { flex-direction: row-reverse; justify-content: flex-start; }
.bt-role { font-size: 11px; color: var(--dim); text-align: center; line-height: 1.5; }
.bt-role b { color: var(--ink); font-size: 13px; }
.bt-role i { display: block; font-style: normal; font-size: 10.5px; }
.bt-role i.hit { color: var(--jade); }
.bt-role i.miss { color: var(--red); }
.bt-power { font-size: 30px; font-weight: 800; color: var(--gold); min-width: 52px; text-align: center; }
.bt-monster { text-align: center; max-width: 340px; }
.bt-mname { font-size: 17px; font-weight: 800; color: var(--red); letter-spacing: 2px; }
.bt-mmeta { font-size: 11.5px; color: var(--dim); margin-top: 2px; }
.bt-mfx { font-size: 11px; color: var(--dim); margin-top: 3px; line-height: 1.6; }
.bt-mfx b { color: var(--ink); }
.bt-war { font-size: 12.5px; color: var(--gold); }
.bt-result { font-size: 14px; font-weight: 700; color: var(--gold); }

/* ---------- 阵营区 ---------- */
.factions-row { display: grid; grid-template-columns: 1fr 190px 1fr; gap: 12px; }
.fc { padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; max-height: 360px; }
.fc h3 { margin: 0 0 2px; font-size: 15px; letter-spacing: 2px; }
.fc h3 em { float: right; color: var(--gold); font-style: normal; font-size: 13px; }

.deck-box { padding: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.deck-box h4 { margin: 2px 0 0; font-size: 12px; color: var(--dim); letter-spacing: 2px; }
.deck-count {
  width: 74px; height: 96px; line-height: 96px; text-align: center;
  font-size: 30px; font-weight: 800; color: var(--gold);
  border-radius: 10px; border: 1px solid rgba(226, 106, 106, .5);
  background:
    repeating-linear-gradient(-45deg, rgba(226, 106, 106, .09) 0 8px, transparent 8px 16px),
    linear-gradient(160deg, #20293f, #131c2e);
  box-shadow: 0 8px 18px rgba(0, 0, 0, .35), inset 0 0 22px rgba(0, 0, 0, .3);
}
.deck-count.small { width: 60px; height: 74px; line-height: 74px; font-size: 20px; color: var(--blue); border-color: rgba(99, 169, 234, .45); background: linear-gradient(160deg, #1c2740, #12192b); box-shadow: none; }
.deck-count.small.blue { color: #9fc3ec; }
.divider { width: 80%; border-top: 1px dashed var(--panel-border); margin: 8px 0 4px; }
.last-monster { font-size: 11.5px; color: var(--dim); text-align: center; }
.lm-title { color: var(--ink); margin-bottom: 3px; }

/* ---------- 我的区域 ---------- */
.my-zone { display: grid; grid-template-columns: 250px minmax(0, 1fr) 220px; gap: 16px; padding: 14px 16px; min-height: 212px; }
.my-zone.active { border-color: rgba(55, 201, 154, .65); box-shadow: 0 0 24px rgba(55, 201, 154, .12); }
.nm { font-weight: 700; }
.nm small { color: var(--dim); font-weight: normal; }
.hp-line, .pw-line { font-size: 13px; color: var(--dim); margin-top: 6px; }
.hp-line b, .pw-line b { color: var(--gold); font-size: 16px; }
.skill-list { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.skill-item { font-size: 10.5px; color: var(--jade); cursor: help; }
.equip-list { margin-top: 8px; font-size: 11.5px; color: #9fc3ec; display: flex; gap: 5px; flex-wrap: wrap; }
.eq-chip { border: 1px solid rgba(99, 169, 234, .4); padding: 1px 7px; border-radius: 999px; cursor: help; }
.pet-list { margin-top: 6px; font-size: 11.5px; display: flex; gap: 5px; flex-wrap: wrap; }
.pet-chip { border: 1px solid rgba(226, 106, 106, .4); color: #f2a9a9; padding: 1px 7px; border-radius: 999px; cursor: help; }

.label { font-size: 12px; color: var(--dim); margin-bottom: 8px; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.targeting-hint { color: var(--red); animation: pulse 1s infinite; }
.btn.tiny { padding: 2px 10px; font-size: 11px; }
.hand { display: flex; gap: 8px; flex-wrap: wrap; overflow-y: auto; max-height: 168px; }
.hand-slot { position: relative; transition: transform .12s ease; }
.hand-slot.playable { cursor: pointer; }
.hand-slot.playable:hover { transform: translateY(-6px) scale(1.03); }
.hand-slot.targeting { transform: translateY(-6px); box-shadow: 0 0 0 2px var(--red); border-radius: 12px; }
.kind-tag {
  position: absolute; right: -4px; top: -7px; font-size: 10px;
  background: #101a2c; border: 1px solid var(--panel-border);
  padding: 1px 6px; border-radius: 999px;
}
.ht-1 .kind-tag { color: #e8eef7; }
.ht-2 .kind-tag { color: var(--blue); }
.ht-3 .kind-tag { color: var(--jade); }
.ht-4 .kind-tag { color: var(--red); }
.give-btn {
  position: absolute; left: -4px; top: -7px; font-size: 10px;
  background: #1a2740; border: 1px solid rgba(55, 201, 154, .5); color: var(--jade);
  padding: 1px 6px; border-radius: 999px; cursor: pointer;
}
.empty-hand { color: var(--dim); font-size: 13px; align-self: center; }

.actions-col { display: flex; flex-direction: column; gap: 10px; justify-content: center; }
.hint { font-size: 12px; color: var(--dim); line-height: 1.6; }

/* ---------- 日志 ---------- */
.logbox { grid-area: log; overflow-y: auto; padding: 14px; }
.logbox ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.logbox li { font-size: 12px; line-height: 1.6; color: var(--dim); border-bottom: 1px dashed rgba(39, 57, 92, .35); padding-bottom: 6px; }
.logbox li:last-child { color: var(--ink); }

/* ---------- 结算 ---------- */
.result-overlay { grid-column: 1 / 3; display: grid; place-items: center; }
.result { width: 640px; padding: 30px 34px; text-align: center; }
.result h1 { margin: 0 0 8px; letter-spacing: 3px; color: var(--gold); }
.score-line { color: var(--dim); margin-bottom: 18px; }
.result-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px; }
.result-table th, .result-table td { padding: 7px 6px; border-bottom: 1px solid rgba(39, 57, 92, .5); }
.result-table th { color: var(--dim); font-weight: normal; font-size: 12px; }
.yourow td { background: rgba(55, 201, 154, .06); }

.toast {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  background: #3b1d1d; border: 1px solid rgba(226, 106, 106, .6);
  color: #ffd9d9; padding: 10px 22px; border-radius: 999px; font-size: 13px;
  z-index: 99; box-shadow: 0 8px 24px rgba(0, 0, 0, .4);
}
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
