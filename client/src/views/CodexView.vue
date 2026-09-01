<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/http';
import CardFace from '../components/CardFace.vue';

const cards = ref([]);
onMounted(async () => {
  cards.value = await api.cards();
});

const groups = [
  { key: 'character', title: '角色牌', desc: '开局从牌库抽取若干张（明牌+暗牌），双方弃置轮选后分配。体力归零进入濒死，可由倾慕者相救。' },
  { key: 'monster', title: '怪兽牌', desc: '战斗阶段翻取：触发方胜利则收为宠物（同五行限一只）并执行胜利结算，失败执行惩罚。一次性使用。' },
  { key: 'event', title: '事件牌', desc: '事件阶段可抽取一张并立即结算。一次性使用。' },
  { key: 't1', title: '特殊牌（白）', desc: '在特定时机使用：冰心诀反制、灵葫仙丹救场、隐蛊抵消伤害。' },
  { key: 't2', title: '装备牌（蓝）', desc: '技牌阶段装备：武器/防具各一件（双剑角色可双武器），重复装备替换旧的。' },
  { key: 't3', title: '技牌（绿）', desc: '仅当前回合玩家的技牌阶段使用。' },
  { key: 't4', title: '战牌（红）', desc: '仅战斗的战牌阶段使用，双方交替指定玩家打出，每人一次机会。' },
];

const byGroup = (g) => {
  if (g.key.startsWith('t')) return cards.value.filter((c) => c.type === 'card' && c.type2 === Number(g.key.slice(1)));
  return cards.value.filter((c) => c.type === g.key);
};
</script>

<template>
  <div class="codex">
    <header class="topbar panel">
      <RouterLink to="/lobby" class="back">← 返回大厅</RouterLink>
      <h1>卡牌图鉴</h1>
      <span class="count" v-if="cards.length">{{ cards.length }} 张卡</span>
    </header>

    <section v-for="g in groups" :key="g.key" class="panel group">
      <h2>{{ g.title }}<small>{{ g.desc }}</small></h2>
      <div class="cards">
        <CardFace v-for="c in byGroup(g)" :key="c.id" :card="c" />
        <span v-if="!byGroup(g).length" class="empty">加载中…</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.codex { max-width: 1100px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.topbar { display: flex; align-items: center; gap: 18px; padding: 12px 20px; }
.back { color: var(--jade); text-decoration: none; font-size: 13px; }
.topbar h1 { font-size: 18px; margin: 0; letter-spacing: 3px; }
.count { color: var(--dim); font-size: 12px; }

.group { padding: 18px 22px; }
.group h2 { margin: 0 0 12px; font-size: 16px; }
.group h2 small { display: block; font-weight: normal; color: var(--dim); font-size: 12px; margin-top: 4px; line-height: 1.6; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; }
.empty { color: var(--dim); font-size: 13px; }
</style>
