<script setup>
// 引擎询问响应弹窗：濒死救援/隐蛊/冰心诀/开战确认/参战者指定/战牌选择等
import { computed } from 'vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
const p = computed(() => game.state?.pending);

const isMine = computed(() => !!p.value && p.value.kind !== 'waiting');

function submit(answer) {
  game.submitPending(answer);
}

// choose_player / pick_supporter / pick_obstructer / war_pick_player 共用候选列表
const candidates = computed(() => p.value?.data?.candidates || []);

function pickCandidate(id) {
  if (p.value.kind === 'war_pick_player') submit(id);
  else submit(id);
}

// 战牌：需要选阵营的牌（天玄五音）
const warSidePicking = computed(() => p.value?.kind === 'war_play_card' && !!p.value?.data?.warNeedSide);
function warPickSide(side) {
  submit({ uid: p.value.data.warUid, targetSide: side });
}
function warPickCard(card) {
  if (card.needTargetSide) {
    // 进入阵营选择（本地状态由模板直接驱动）
    p.value.data.warNeedSide = true;
    p.value.data.warUid = card.uid;
  } else {
    submit({ uid: card.uid });
  }
}
</script>

<template>
  <transition name="fade">
    <div v-if="isMine" class="pd-mask">
      <div class="pd panel">
        <h3>{{ ({ choose_player: '选择玩家', yes_no: '请确认', use_card: '是否使用？', use_equip_burst: '装备爆发', use_pet_burst: '宠物爆发', battle_confirm: '战斗确认', pick_supporter: '指定支援者', pick_obstructer: '指定妨碍者', war_pick_player: '战牌阶段', war_play_card: '打出战牌' })[p.kind] || '询问' }}</h3>
        <p class="reason">{{ p.data.reason }}</p>

        <!-- 候选玩家列表 -->
        <div v-if="candidates.length" class="cands">
          <button v-for="c in candidates" :key="c.id" class="btn cand" @click="pickCandidate(c.id)">
            <b>{{ c.name }}</b>
            <small v-if="c.char"> · {{ c.char }}</small>
          </button>
        </div>

        <!-- 战牌选择 -->
        <div v-if="p.kind === 'war_play_card' && !warSidePicking" class="war-list">
          <button v-for="c in (p.data.legal || [])" :key="c.uid" class="btn war-btn" @click="warPickCard(c)">
            <b>{{ c.name }}</b>
            <small>{{ c.desc }}</small>
          </button>
          <button class="btn ghost" @click="submit({ pass: true })">不出战牌</button>
        </div>
        <div v-else-if="warSidePicking" class="war-list">
          <p class="reason">为【天玄五音】选择生效阵营（本场战斗战力+2）：</p>
          <button class="btn" @click="warPickSide('a')">蜀山派 +2</button>
          <button class="btn" @click="warPickSide('b')">拜月教 +2</button>
        </div>

        <!-- 是/否 -->
        <div v-if="['yes_no', 'use_card', 'use_equip_burst', 'use_pet_burst'].includes(p.kind)" class="yn">
          <button class="btn primary" @click="submit(true)">是</button>
          <button class="btn ghost" @click="submit(false)">否</button>
        </div>

        <!-- 开战确认 -->
        <div v-if="p.kind === 'battle_confirm'" class="yn">
          <button class="btn danger" @click="submit(true)">开启战斗</button>
          <button class="btn ghost" @click="submit(false)">不开战（怪兽弃置·补牌减为1张）</button>
        </div>

        <!-- choose_player 可选跳过 -->
        <div v-if="p.kind === 'choose_player' && p.data.optional" class="yn">
          <button class="btn ghost" @click="submit(null)">跳过</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.pd-mask {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(5, 9, 18, 0.66);
  display: grid; place-items: center;
  backdrop-filter: blur(2px);
}
.pd { width: 480px; max-width: 92vw; padding: 22px 26px; }
.pd h3 { margin: 0 0 8px; font-size: 16px; letter-spacing: 2px; color: var(--gold); }
.reason { color: var(--dim); font-size: 13px; line-height: 1.6; margin: 0 0 14px; }

.cands { display: flex; flex-wrap: wrap; gap: 8px; }
.cand { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.cand small { color: var(--dim); font-weight: normal; }

.war-list { display: flex; flex-direction: column; gap: 8px; }
.war-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; }
.war-btn small { color: var(--dim); font-weight: normal; font-size: 11px; }

.yn { display: flex; gap: 10px; margin-top: 14px; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
