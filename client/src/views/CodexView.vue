<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api/http';
import CardFace from '../components/CardFace.vue';

const groups = [
  { key: 'character', title: '角色牌', desc: '每位玩家随机扮演一名角色，决定初始气血与基础战力。' },
  { key: 'monster', title: '怪兽牌', desc: '战斗阶段翻开：战胜收为宠物计入阵营总分，战败执行惩罚。' },
  { key: 'event', title: '事件牌', desc: '回合开始时可选择抽一张并立即结算。' },
  { key: 'skill', title: '手牌（技牌）', desc: '装备类挂场持续生效；技法类打出生效后进入弃牌堆。' },
];

const cards = ref([]);
onMounted(async () => {
  cards.value = await api.cards();
});
const byType = (t) => cards.value.filter((c) => c.type === t);
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
        <CardFace v-for="c in byType(g.key)" :key="c.id" :card="c" />
        <span v-if="!byType(g.key).length" class="empty">加载中…</span>
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
.group h2 small { display: block; font-weight: normal; color: var(--dim); font-size: 12px; margin-top: 4px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; }
.empty { color: var(--dim); font-size: 13px; }
</style>
