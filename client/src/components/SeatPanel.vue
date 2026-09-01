<script setup>
// 座位面板：玩家公开信息（角色/血条/战力命中/装备/宠物/横置）
const props = defineProps({
  seat: { type: Object, required: true },
  isYou: { type: Boolean, default: false },
  isTurn: { type: Boolean, default: false },
  targetable: { type: Boolean, default: false },
});
</script>

<template>
  <div class="seat" :class="[`faction-${seat.faction}`, { you: isYou, turn: isTurn, dead: !seat.alive, tap: seat.tapped, targetable }]">
    <div class="seat-head">
      <span class="player">{{ seat.name }}<template v-if="isYou">（你）</template></span>
      <span v-if="seat.isBot" class="tag">人机</span>
      <span v-else-if="seat.offline" class="tag warn">托管</span>
      <span v-if="seat.tapped" class="tag warn">横置</span>
      <span class="tag faction-tag">{{ seat.factionName }}</span>
    </div>

    <template v-if="seat.char">
      <div class="char-line">
        <b>{{ seat.char.name }}</b>
        <span v-if="!seat.alive" class="dead-mark">阵亡</span>
        <span class="hand-n">{{ seat.handCount }}牌</span>
      </div>
      <div class="hp-row" v-if="seat.alive">
        <div class="hp-bar"><i :style="{ width: Math.max(seat.hp / seat.maxHp * 100, 0) + '%' }"></i></div>
        <span class="hp-num">{{ seat.hp }}/{{ seat.maxHp }}</span>
      </div>
      <div class="info-row">
        <span>战力 <b class="gold">{{ seat.effPower }}</b></span>
        <span>命中 <b class="gold">{{ seat.effRange }}</b></span>
        <span>宠物 {{ seat.pets.length }}/{{ seat.petScore }}分</span>
      </div>
      <div class="skill-line" v-if="seat.char.skill?.length" :title="seat.char.skill.map(s => s.name + '：' + s.desc).join('；')">
        ✦ {{ seat.char.skill.map((s) => s.name).join(' · ') }}
      </div>
      <div class="equip-line" v-if="seat.equips?.length">
        🎒 {{ seat.equips.map((e) => e.name).join(' · ') }}
      </div>
      <div class="pet-chips" v-if="seat.pets.length">
        <span v-for="p in seat.pets" :key="p.uid" class="pet-chip" :title="p.pets">{{ p.name }}·{{ p.element }}+{{ p.power }}</span>
      </div>
    </template>
    <div v-else class="char-line"><span class="dim">未选角色</span></div>
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
  transition: box-shadow .15s ease;
}
.seat.turn { box-shadow: 0 0 0 2px var(--gold); }
.seat.you { background: rgba(55, 201, 154, 0.07); }
.seat.dead { opacity: 0.45; filter: grayscale(0.7); }
.seat.tap { opacity: 0.6; }
.seat.targetable { cursor: pointer; box-shadow: 0 0 0 2px var(--red); animation: blink 1s infinite; }
@keyframes blink { 50% { box-shadow: 0 0 0 2px rgba(226,106,106,.2); } }

.seat-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.player { font-weight: 700; font-size: 13px; }
.faction-tag { color: var(--faction); border-color: var(--faction); }
.tag.warn { color: var(--gold); }

.char-line { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.hand-n { margin-left: auto; color: var(--dim); font-size: 11px; }
.dead-mark { color: var(--red); font-size: 11px; }
.dim { color: var(--dim); }

.hp-row { display: flex; align-items: center; gap: 6px; }
.hp-bar { flex: 1; height: 6px; background: #1a2740; border-radius: 4px; overflow: hidden; }
.hp-bar i { display: block; height: 100%; background: linear-gradient(90deg, #3fd68f, #23a973); transition: width .3s; }
.hp-num { font-size: 11px; color: var(--dim); width: 44px; text-align: right; }

.info-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); gap: 4px; }
.info-row .gold { color: var(--gold); }
.skill-line { font-size: 10.5px; color: var(--jade); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help; }
.equip-line { font-size: 11px; color: #9fc3ec; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pet-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pet-chip {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(226, 106, 106, 0.14);
  color: #f2a9a9;
  cursor: help;
}
</style>
