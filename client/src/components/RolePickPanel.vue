<script setup>
// 角色选择阶段面板：明/暗牌池 + 弃置/轮选交互
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useGameStore } from '../stores/game';

const auth = useAuthStore();
const game = useGameStore();

const pick = computed(() => game.state?.pick);
const st = computed(() => game.state);
const myFaction = computed(() => st.value?.you?.faction);
const myTurn = computed(() => !!pick.value && pick.value.currentSide === myFaction.value);
const modeText = computed(() => {
  if (!pick.value) return '';
  return pick.value.currentMode === 'discard' ? '弃置一张角色牌' : `选择角色（本轮 ${pick.value.currentCount} 张）`;
});
const stepText = computed(() => {
  if (!pick.value) return '';
  return `第 ${pick.value.stepIdx + 1}/${pick.value.totalSteps} 步 · ${factionLabel(pick.value.currentSide)}${modeText.value}`;
});
function factionLabel(k) {
  return k === 'a' ? '蜀山派' : k === 'b' ? '拜月教' : '';
}

function ownerLabel(owner) {
  if (owner === 'a') return '蜀山';
  if (owner === 'b') return '拜月';
  if (owner === 'discard') return '已弃置';
  return '';
}

function selectCard(item) {
  if (!myTurn.value || item.owner !== null) return;
  game.pickSelect(item.key);
}
</script>

<template>
  <section v-if="pick" class="pick panel">
    <header class="pick-head">
      <h2>角色选择阶段</h2>
      <span class="cfg">抽取 {{ pick.config.total }} 张（明牌 {{ pick.config.open }} / 暗牌 {{ pick.config.hidden }}）</span>
      <div class="steps">{{ stepText }}</div>
    </header>

    <div class="picked-row">
      <div class="picked a">
        <b>蜀山派已选：</b>{{ pick.factionRoles.a.join('、') || '（空）' }}
      </div>
      <div class="picked b">
        <b>拜月教已选：</b>{{ pick.factionRoles.b.join('、') || '（空）' }}
      </div>
    </div>

    <div class="pool">
      <div v-for="item in pick.pool" :key="item.key"
           class="pool-card" :class="{
             open: item.open, hidden: !item.open,
             mine: myTurn && item.owner === null,
             taken: item.owner !== null,
           }"
           @click="selectCard(item)">
        <div class="pc-top">
          <span class="pc-vis">{{ item.open ? '明牌' : '暗牌' }}</span>
          <span v-if="item.owner" class="pc-owner">{{ ownerLabel(item.owner) }}</span>
        </div>
        <div class="pc-name">
          <template v-if="item.name">{{ item.name }}</template>
          <template v-else>？？？</template>
        </div>
        <div class="pc-brief" v-if="item.detail">{{ item.detail }}</div>
        <div class="pc-brief dim" v-else>只有选择它的阵营能看见内容</div>
      </div>
    </div>

    <p class="hint">
      <template v-if="myTurn">轮到您阵营{{ modeText }}：点击上方卡片确认。</template>
      <template v-else>等待{{ factionLabel(pick.currentSide) }}行动……</template>
      规则：双方各弃置一张后，先手方选 1 张，之后交替各选 2 张，直到选完。
    </p>
  </section>
</template>

<style scoped>
.pick { grid-column: 1 / 3; padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
.pick-head { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.pick-head h2 { margin: 0; font-size: 18px; letter-spacing: 3px; }
.cfg { color: var(--dim); font-size: 12px; }
.steps { margin-left: auto; font-size: 13px; color: var(--gold); letter-spacing: 1px; }

.picked-row { display: flex; gap: 14px; flex-wrap: wrap; }
.picked { flex: 1; font-size: 12.5px; padding: 8px 12px; border-radius: 8px; background: rgba(15, 22, 38, .6); }
.picked.a b { color: var(--blue); }
.picked.b b { color: var(--red); }
.picked b { margin-right: 4px; }

.pool { display: flex; flex-wrap: wrap; gap: 10px; }
.pool-card {
  width: 128px; border-radius: 10px; padding: 9px 10px;
  border: 1px solid var(--panel-border);
  background: linear-gradient(165deg, #17233a, #10182a);
  display: flex; flex-direction: column; gap: 5px;
  transition: transform .1s ease, box-shadow .15s ease;
}
.pool-card.open { border-color: rgba(223, 187, 102, .55); }
.pool-card.hidden { border-color: rgba(99, 169, 234, .45); }
.pool-card.mine { cursor: pointer; }
.pool-card.mine:hover { transform: translateY(-4px); box-shadow: 0 0 0 2px var(--jade); }
.pool-card.taken { opacity: .5; }

.pc-top { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--dim); }
.pc-owner { color: var(--gold); }
.pc-name { font-size: 15px; font-weight: 700; }
.pc-brief { font-size: 10.5px; color: var(--dim); }
.dim { font-style: italic; }
.hint { color: var(--dim); font-size: 12px; line-height: 1.7; margin: 0; }
</style>
