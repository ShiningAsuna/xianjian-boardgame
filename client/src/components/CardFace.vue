<script setup>
// 通用卡面：角色/怪兽/事件/手牌（特殊·装备·技牌·战牌）
const props = defineProps({
  card: { type: Object, required: true },
  mini: { type: Boolean, default: false },
});

const TYPE_NAME = { 1: '特殊', 2: '装备', 3: '技牌', 4: '战牌' };

// 解析卡牌类别（手牌实例 type 为数字；图鉴数据带字符串 type）
const kind = () => {
  const c = props.card;
  if (typeof c.type === 'string') {
    if (c.type === 'character') return 'character';
    if (c.type === 'monster') return 'monster';
    if (c.type === 'event') return 'event';
    return 'card';
  }
  return 'card';
};

const cls = () => `face-${kind()}`;

const badge = () => {
  const c = props.card;
  const k = kind();
  if (k === 'character') return '角色';
  if (k === 'monster') return `怪兽·${c.elements?.name || ''}`;
  if (k === 'event') return '事件';
  if (k === 'card') {
    let t = TYPE_NAME[c.type] || '手牌';
    if (c.type === 2) t += c.eqvType === 1 ? '·武器' : '·防具';
    return t;
  }
  return '卡牌';
};

const stat = () => {
  const c = props.card;
  const k = kind();
  if (k === 'character') return `体${c.hp} 力${c.power} 命中${c.range}`;
  if (k === 'monster') return `力${c.power} 闪${c.range}${c.type === 3 ? ' ·BOSS' : c.type === 2 ? ' ·强敌' : ''}`;
  if (k === 'event') return '回合开始可选';
  return '';
};
</script>

<template>
  <div class="card-face" :class="[cls(), { mini }]">
    <div class="card-top">
      <span class="badge">{{ badge() }}</span>
      <span class="stat" v-if="stat()">{{ stat() }}</span>
    </div>
    <div class="card-name">{{ card.name }}</div>
    <div class="card-desc">{{ card.desc || (kind() === 'monster' ? [card.appear, card.pets && `宠物：${card.pets}`, card.win && `胜：${card.win}`, card.lose && `败：${card.lose}`].filter(Boolean).join(' / ') : '') || (kind() === 'character' ? (card.skill || []).map((s) => `${s.name}：${s.desc}`).join('；') : '') }}</div>
  </div>
</template>

<style scoped>
.card-face {
  position: relative;
  width: 158px;
  border-radius: 12px;
  padding: 10px 12px;
  border: 1px solid var(--panel-border);
  background: linear-gradient(165deg, #17233a, #10182a);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mini { width: 112px; padding: 7px 9px; gap: 3px; }

.card-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  letter-spacing: 1px;
  white-space: nowrap;
}
.stat { font-size: 11px; color: var(--gold); white-space: nowrap; }

.card-name { font-size: 16px; font-weight: 700; letter-spacing: 1px; }
.mini .card-name { font-size: 13px; }

.card-desc { font-size: 11px; line-height: 1.55; color: var(--dim); min-height: 30px; }
.mini .card-desc { display: none; }

.face-character { border-color: rgba(223, 187, 102, 0.65); box-shadow: inset 0 0 24px rgba(223, 187, 102, 0.09); }
.face-character .badge { color: var(--gold); }
.face-monster { border-color: rgba(226, 106, 106, 0.6); box-shadow: inset 0 0 24px rgba(226, 106, 106, 0.1); }
.face-monster .badge { color: var(--red); }
.face-event { border-color: rgba(99, 169, 234, 0.55); box-shadow: inset 0 0 24px rgba(99, 169, 234, 0.1); }
.face-event .badge { color: var(--blue); }
/* 手牌按颜色分类：特殊白 / 装备蓝 / 技牌绿 / 战牌红 */
.face-card { border-color: rgba(150, 165, 190, 0.55); }
.face-card .badge { color: #aab8d0; }
</style>
