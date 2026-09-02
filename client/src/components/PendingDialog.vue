<script setup>
// 引擎询问响应弹窗：所有选择仅保存在本地，提交时携带当前 pending.id
import { computed, ref, watch } from 'vue';
import { useGameStore } from '../stores/game';

const game = useGameStore();
const p = computed(() => game.state?.pending);
const isMine = computed(() => !!p.value?.id && p.value.kind !== 'waiting');
const candidates = computed(() => p.value?.data?.candidates || []);

const selected = ref([]);
const selectedAction = ref('');
const warCard = ref(null);

watch(
  () => p.value?.id,
  () => {
    selected.value = [];
    selectedAction.value = '';
    warCard.value = null;
  },
  { immediate: true }
);

const titles = {
  choose_player: '选择玩家',
  choose_players: '选择多名玩家',
  choose_cards: '选择手牌',
  choose_zone: '选择区域',
  choose_pet: '选择宠物',
  choose_lover: '选择倾慕者',
  choose_turn_order: '指定行动顺序',
  counter_card: '是否反制？',
  character_skill: '角色技能',
  war_character_skill: '战斗技能',
  yes_no: '请确认',
  use_card: '是否使用？',
  use_equip_burst: '装备爆发',
  use_pet_burst: '宠物爆发',
  battle_confirm: '战斗确认',
  pick_supporter: '指定支援者',
  pick_obstructer: '指定妨碍者',
  war_pick_player: '战牌阶段',
  war_play_card: '打出战牌',
};

const directPlayerKinds = ['choose_player', 'pick_supporter', 'pick_obstructer', 'war_pick_player'];
const yesNoKinds = ['yes_no', 'use_card', 'use_equip_burst', 'use_pet_burst'];
const multiKind = computed(() => ['choose_players', 'choose_cards'].includes(p.value?.kind));
const minCount = computed(() => Number(p.value?.data?.min ?? 0));
const maxCount = computed(() => Number(p.value?.data?.max ?? minCount.value));
const multiOptions = computed(() => p.value?.kind === 'choose_cards' ? (p.value?.data?.options || []) : candidates.value);
const multiUnit = computed(() => p.value?.kind === 'choose_players' ? '名' : '张');
const canSubmitMulti = computed(() => selected.value.length >= minCount.value && selected.value.length <= maxCount.value);

function submit(answer) {
  game.submitPending(answer);
}

function optionValue(option) {
  return option.uid ?? option.id ?? option.key;
}

function toggleValue(value, max = maxCount.value) {
  const index = selected.value.indexOf(value);
  if (index >= 0) {
    selected.value = selected.value.filter((item) => item !== value);
  } else if (selected.value.length < max) {
    selected.value = [...selected.value, value];
  }
}

function submitMulti() {
  if (canSubmitMulti.value) submit(selected.value.slice());
}

const turnOrderCount = computed(() => Number(p.value?.data?.count || candidates.value.length));
const expectedFaction = computed(() => {
  const first = p.value?.data?.firstFaction;
  return selected.value.length % 2 === 0 ? first : (first === 'a' ? 'b' : 'a');
});
const canSubmitOrder = computed(() => selected.value.length === turnOrderCount.value);
function pickOrder(candidate) {
  const index = selected.value.indexOf(candidate.id);
  if (index >= 0) {
    if (index === selected.value.length - 1) selected.value = selected.value.slice(0, -1);
    return;
  }
  if (selected.value.length < turnOrderCount.value && candidate.faction === expectedFaction.value) {
    selected.value = [...selected.value, candidate.id];
  }
}
function orderNumber(id) {
  const index = selected.value.indexOf(id);
  return index >= 0 ? index + 1 : '';
}

function warPickCard(card) {
  if (card.needTargetSide) warCard.value = card;
  else submit({ uid: card.uid });
}
function warPickSide(side) {
  if (warCard.value) submit({ uid: warCard.value.uid, targetSide: side });
}

const characterOptions = computed(() => p.value?.data?.options || []);
const characterKeys = computed(() => characterOptions.value.map((option) => option.key));
function usePendingSkill(key, args = {}) {
  game.useCharacterSkill(key, args, p.value?.id || null);
}
function chooseWangCard(uid) {
  usePendingSkill('wang_reroll_card', { cardUid: uid });
}

const warSkillCards = computed(() => {
  const cards = p.value?.data?.cards || [];
  return selectedAction.value === 'tang_combo' ? cards.filter((card) => card.type !== 4) : cards;
});
const warSkillMin = computed(() => selectedAction.value === 'bayue_summon' ? 2 : 1);
const warSkillMax = computed(() => selectedAction.value === 'bayue_summon' ? 2 : warSkillCards.value.length);
const canSubmitWarSkill = computed(() => selected.value.length >= warSkillMin.value && selected.value.length <= warSkillMax.value);
function beginWarSkill(key) {
  selectedAction.value = key;
  selected.value = [];
}
function submitWarSkill() {
  if (canSubmitWarSkill.value) usePendingSkill(selectedAction.value, { cardUids: selected.value.slice() });
}

function zoneLabel(zone) {
  return ({ hand: '手牌区', equip: '装备区' })[zone] || zone;
}
</script>

<template>
  <transition name="fade">
    <div v-if="isMine" class="pd-mask">
      <div class="pd panel">
        <h3>{{ titles[p.kind] || '询问' }}</h3>
        <p class="reason">{{ p.data.reason }}</p>

        <div v-if="directPlayerKinds.includes(p.kind)" class="cands">
          <button v-for="c in candidates" :key="c.id" class="btn cand" @click="submit(c.id)">
            <b>{{ c.name }}</b><small v-if="c.char">{{ c.char }}</small>
          </button>
          <button v-if="p.kind === 'choose_player' && p.data.optional" class="btn ghost" @click="submit(null)">跳过</button>
        </div>

        <div v-else-if="multiKind" class="choice-block">
          <div class="count">已选 {{ selected.length }} {{ multiUnit }} / 需要 {{ minCount === maxCount ? minCount : `${minCount}–${maxCount}` }} {{ multiUnit }}</div>
          <div class="cands">
            <button v-for="option in multiOptions" :key="optionValue(option)"
                    class="btn cand" :class="{ selected: selected.includes(optionValue(option)) }"
                    @click="toggleValue(optionValue(option))">
              <b>{{ option.name }}</b>
              <small v-if="option.char">{{ option.char }}</small>
              <small v-if="option.type">{{ ({ 1: '特殊', 2: '装备', 3: '技牌', 4: '战牌' })[option.type] }}</small>
            </button>
          </div>
          <button class="btn primary submit-btn" :disabled="!canSubmitMulti" @click="submitMulti">确认选择</button>
        </div>

        <div v-else-if="p.kind === 'choose_turn_order'" class="choice-block">
          <div class="count">已排 {{ selected.length }}/{{ turnOrderCount }} · 下一位：{{ expectedFaction === 'a' ? '蜀山派' : '拜月教' }}</div>
          <div class="cands">
            <button v-for="c in candidates" :key="c.id" class="btn cand order-cand"
                    :class="{ selected: selected.includes(c.id) }"
                    :disabled="!selected.includes(c.id) && c.faction !== expectedFaction"
                    @click="pickOrder(c)">
              <i v-if="orderNumber(c.id)">{{ orderNumber(c.id) }}</i>
              <b>{{ c.name }}</b><small>{{ c.char }} · {{ c.faction === 'a' ? '蜀山派' : '拜月教' }}</small>
            </button>
          </div>
          <div class="yn">
            <button class="btn primary" :disabled="!canSubmitOrder" @click="submit(selected.slice())">确认顺序</button>
            <button class="btn ghost" :disabled="!selected.length" @click="selected = []">重排</button>
          </div>
        </div>

        <div v-else-if="p.kind === 'choose_zone'" class="cands">
          <button v-for="zone in (p.data.zones || [])" :key="zone" class="btn" @click="submit(zone)">{{ zoneLabel(zone) }}</button>
        </div>

        <div v-else-if="p.kind === 'choose_pet'" class="cands">
          <button v-for="pet in (p.data.options || [])" :key="pet.uid" class="btn cand" @click="submit(pet.uid)">
            <b>{{ pet.name }}</b><small>{{ pet.element }} · 战力 {{ pet.power }}</small>
          </button>
        </div>

        <div v-else-if="p.kind === 'choose_lover'" class="cands">
          <button v-for="lover in (p.data.options || [])" :key="lover.key" class="btn" @click="submit(lover.key)">{{ lover.name }}</button>
        </div>

        <div v-else-if="p.kind === 'counter_card'" class="choice-block">
          <button v-for="card in (p.data.options || [])" :key="card.uid" class="btn war-btn" @click="submit(card.uid)">
            <b>{{ card.name }}</b><small>作为【{{ card.as }}】打出</small>
          </button>
          <button class="btn ghost" @click="submit(null)">不反制</button>
        </div>

        <div v-else-if="p.kind === 'character_skill'" class="choice-block">
          <button v-if="characterKeys.includes('sumei_cunning')" class="btn primary" @click="usePendingSkill('sumei_cunning')">发动【狡猾】重新翻取</button>
          <template v-if="characterKeys.includes('wang_reroll_card')">
            <div class="count">弃置一张手牌并重投</div>
            <div class="cands">
              <button v-for="card in (p.data.cards || [])" :key="card.uid" class="btn cand" @click="chooseWangCard(card.uid)">
                <b>{{ card.name }}</b><small>{{ ({ 1: '特殊', 2: '装备', 3: '技牌', 4: '战牌' })[card.type] }}</small>
              </button>
            </div>
          </template>
          <button v-if="characterKeys.includes('wang_reroll_hp')" class="btn danger" @click="usePendingSkill('wang_reroll_hp')">扣 1 HP 重投</button>
          <button v-if="characterKeys.includes('pass')" class="btn ghost" @click="usePendingSkill('pass')">不发动</button>
        </div>

        <div v-else-if="p.kind === 'war_character_skill'" class="choice-block">
          <template v-if="!selectedAction">
            <button v-if="characterKeys.includes('bayue_summon')" class="btn primary" @click="beginWarSkill('bayue_summon')">召唤水魔兽（弃2张手牌）</button>
            <button v-if="characterKeys.includes('tang_combo')" class="btn primary" @click="beginWarSkill('tang_combo')">连击（弃1张或更多非战牌）</button>
            <button v-if="characterKeys.includes('tang_compete')" class="btn danger" @click="usePendingSkill('tang_compete')">确认发动【好胜】（扣2 HP并补2张）</button>
            <button class="btn ghost" @click="usePendingSkill('pass')">完成，不再发动</button>
          </template>
          <template v-else>
            <div class="count">已选 {{ selected.length }} 张 / {{ selectedAction === 'bayue_summon' ? '必须2张' : '至少1张' }}</div>
            <div class="cands">
              <button v-for="card in warSkillCards" :key="card.uid" class="btn cand"
                      :class="{ selected: selected.includes(card.uid) }"
                      @click="toggleValue(card.uid, warSkillMax)">
                <b>{{ card.name }}</b><small>{{ ({ 1: '特殊', 2: '装备', 3: '技牌', 4: '战牌' })[card.type] }}</small>
              </button>
            </div>
            <div class="yn">
              <button class="btn primary" :disabled="!canSubmitWarSkill" @click="submitWarSkill">确认发动</button>
              <button class="btn ghost" @click="selectedAction = ''; selected = []">返回</button>
            </div>
          </template>
        </div>

        <div v-else-if="p.kind === 'war_play_card' && !warCard" class="war-list">
          <button v-for="card in (p.data.legal || [])" :key="card.uid" class="btn war-btn" @click="warPickCard(card)">
            <b>{{ card.name }}</b><small>{{ card.desc }}</small>
          </button>
          <button class="btn ghost" @click="submit({ pass: true })">不出战牌</button>
        </div>
        <div v-else-if="p.kind === 'war_play_card' && warCard" class="war-list">
          <p class="reason">为【{{ warCard.name }}】选择生效阵营（本场战斗战力+2）：</p>
          <button class="btn" @click="warPickSide('a')">蜀山派 +2</button>
          <button class="btn" @click="warPickSide('b')">拜月教 +2</button>
          <button class="btn ghost" @click="warCard = null">返回</button>
        </div>

        <div v-else-if="yesNoKinds.includes(p.kind)" class="yn">
          <button class="btn primary" @click="submit(true)">是</button>
          <button class="btn ghost" @click="submit(false)">否</button>
        </div>

        <div v-else-if="p.kind === 'battle_confirm'" class="yn">
          <button class="btn danger" @click="submit(true)">开启战斗</button>
          <button class="btn ghost" @click="submit(false)">不开战（怪兽弃置·补牌减为1张）</button>
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
.pd { width: 520px; max-width: 92vw; max-height: 82vh; overflow-y: auto; padding: 22px 26px; }
.pd h3 { margin: 0 0 8px; font-size: 16px; letter-spacing: 2px; color: var(--gold); }
.reason { color: var(--dim); font-size: 13px; line-height: 1.6; margin: 0 0 14px; }
.choice-block, .war-list { display: flex; flex-direction: column; gap: 8px; }
.count { color: var(--gold); font-size: 12px; }
.cands { display: flex; flex-wrap: wrap; gap: 8px; }
.cand { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.cand small, .war-btn small { color: var(--dim); font-weight: normal; }
.cand.selected { border-color: var(--jade); color: var(--jade); }
.order-cand { position: relative; padding-left: 30px; }
.order-cand i { position: absolute; left: 10px; color: var(--gold); font-style: normal; }
.war-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; }
.war-btn small { font-size: 11px; }
.submit-btn { align-self: flex-start; margin-top: 4px; }
.yn { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
