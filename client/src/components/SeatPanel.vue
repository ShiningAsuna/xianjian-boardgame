<script setup>
// 座位面板：玩家/角色公开信息（自己、对手、人机通用）
const props = defineProps({
  seat: { type: Object, required: true },
  isYou: { type: Boolean, default: false },
  isTurn: { type: Boolean, default: false },
});
</script>

<template>
  <div class="seat" :class="[`faction-${seat.faction}`, { you: isYou, turn: isTurn, dead: !seat.alive }]">
    <div class="seat-head">
      <span class="player">{{ seat.name }}<template v-if="isYou">（你）</template></span>
      <span v-if="seat.isBot" class="tag">人机</span>
      <span v-else-if="seat.offline" class="tag warn">离线托管</span>
      <span class="tag faction-tag">{{ seat.factionName }}</span>
    </div>
    <div class="char-line">
      <b>{{ seat.char?.name }}</b>
      <span v-if="!seat.alive" class="dead-mark">阵亡</span>
    </div>
    <div class="hp-row" v-if="seat.alive">
      <div class="hp-bar"><i :style="{ width: Math.max(seat.hp / seat.maxHp * 100, 0) + '%' }"></i></div>
      <span class="hp-num">{{ seat.hp }}/{{ seat.maxHp }}</span>
    </div>
    <div class="info-row">
      <span>战力 {{ seat.totalPower }}</span>
      <span>宠物 {{ seat.pets.length }} 只 / {{ seat.petScore }} 分</span>
    </div>
    <div class="equip-line" v-if="seat.field?.length">
      🎒 {{ seat.field.map((e) => e.name).join(' · ') }}
    </div>
    <div class="pet-chips" v-if="seat.pets.length">
      <span v-for="(p, i) in seat.pets.slice(-6)" :key="i" class="pet-chip">{{ p.name }}+{{ p.power }}</span>
    </div>
  </div>
</template>

<style scoped>
.seat {
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--faction);
  border-radius: 10px;
  background: rgba(15, 22, 38, 0.75);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.seat.turn { box-shadow: 0 0 0 2px var(--gold); }
.seat.you { background: rgba(55, 201, 154, 0.07); }
.seat.dead { opacity: 0.45; filter: grayscale(0.7); }

.seat-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.player { font-weight: 700; font-size: 13px; }
.faction-tag { color: var(--faction); border-color: var(--faction); }
.tag.warn { color: var(--gold); }

.char-line { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.dead-mark { color: var(--red); font-size: 11px; }

.hp-row { display: flex; align-items: center; gap: 6px; }
.hp-bar { flex: 1; height: 6px; background: #1a2740; border-radius: 4px; overflow: hidden; }
.hp-bar i { display: block; height: 100%; background: linear-gradient(90deg, #3fd68f, #23a973); transition: width .3s; }
.hp-num { font-size: 11px; color: var(--dim); width: 44px; text-align: right; }

.info-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); }
.equip-line { font-size: 11px; color: var(--jade); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pet-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pet-chip {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(226, 106, 106, 0.14);
  color: #f2a9a9;
}
</style>
