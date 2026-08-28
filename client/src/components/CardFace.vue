<script setup>
// 通用卡面：四类卡共用（角/怪/事/技）
const props = defineProps({
  card: { type: Object, required: true },
  mini: { type: Boolean, default: false },
});

const KIND_META = {
  character: { badge: '角色', cls: 'face-character' },
  monster:   { badge: '怪兽', cls: 'face-monster' },
  event:     { badge: '事件', cls: 'face-event' },
  skill_equip:   { badge: '装备', cls: 'face-skill-equip' },
  skill_instant: { badge: '技法', cls: 'face-skill-instant' },
};

// 手牌中的技牌实例不带 type 字段（引擎实例化时未注入），通过 kind 兜底识别
const resolveType = () => {
  if (props.card.type) return props.card.type;
  if (props.card.kind) return 'skill';
  return '';
};

const meta = () => {
  const t = resolveType();
  if (t === 'character') return KIND_META.character;
  if (t === 'monster') return KIND_META.monster;
  if (t === 'event') return KIND_META.event;
  if (t === 'skill') return props.card.kind === 'equip' ? KIND_META.skill_equip : KIND_META.skill_instant;
  return { badge: '卡牌', cls: '' };
};

const mainStat = () => {
  const c = props.card;
  const t = resolveType();
  if (t === 'character') return `战力 ${c.power} · 血 ${c.hp}`;
  if (t === 'monster') return `战力 ${c.power}`;
  if (t === 'skill') return c.kind === 'equip' ? '挂场装备' : '打出生效';
  if (t === 'event') return '回合开始可选';
  return '';
};
</script>

<template>
  <div class="card-face" :class="[meta().cls, { mini }]">
    <div class="card-top">
      <span class="badge">{{ meta().badge }}</span>
      <span class="stat">{{ mainStat() }}</span>
    </div>
    <div class="card-name">{{ card.name }}</div>
    <div class="card-desc">{{ card.desc }}</div>
  </div>
</template>

<style scoped>
.card-face {
  position: relative;
  width: 150px;
  border-radius: 12px;
  padding: 10px 12px;
  border: 1px solid var(--panel-border);
  background: linear-gradient(165deg, #17233a, #10182a);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mini { width: 108px; padding: 7px 9px; gap: 3px; }

.card-top { display: flex; justify-content: space-between; align-items: center; }
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  letter-spacing: 1px;
}
.stat { font-size: 11px; color: var(--gold); }
.mini .stat { display: none; }

.card-name { font-size: 16px; font-weight: 700; letter-spacing: 1px; }
.mini .card-name { font-size: 13px; }

.card-desc { font-size: 11px; line-height: 1.5; color: var(--dim); min-height: 30px; }
.mini .card-desc { display: none; }

.face-character { border-color: rgba(223, 187, 102, 0.65); box-shadow: inset 0 0 24px rgba(223, 187, 102, 0.09); }
.face-character .badge { color: var(--gold); }
.face-monster { border-color: rgba(226, 106, 106, 0.6); box-shadow: inset 0 0 24px rgba(226, 106, 106, 0.1); }
.face-monster .badge { color: var(--red); }
.face-event { border-color: rgba(99, 169, 234, 0.55); box-shadow: inset 0 0 24px rgba(99, 169, 234, 0.1); }
.face-event .badge { color: var(--blue); }
.face-skill-equip, .face-skill-instant { border-color: rgba(55, 201, 154, 0.55); box-shadow: inset 0 0 24px rgba(55, 201, 154, 0.09); }
.face-skill-equip .badge, .face-skill-instant .badge { color: var(--jade); }
</style>
