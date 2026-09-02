// 效果注册表：按卡牌 id 关联执行逻辑。
// 签名统一为 (game, ctx)，ctx 含触发的玩家、卡牌、战斗上下文等。
// 引擎只调用这里注册的函数；新增卡牌 = data/cards.js 加数据 + 此处注册。

const { characters, monsters, events, cards } = require('../data/cards');

// ---------- 卡牌类型常量 ----------
const CARD_TYPE = { SPECIAL: 1, EQUIP: 2, SKILL: 3, WAR: 4 };
const EQV_TYPE = { WEAPON: 1, ARMOR: 2 };
const CARD_TYPE_NAME = { 1: '特殊牌', 2: '装备牌', 3: '技牌', 4: '战牌' };

// ---------- 装备属性 ----------
const EQUIP_STATS = {
  5: { power: 2, range: 0 },   // 魔刀天吒：战力+2
  6: { power: 1, range: 1 },   // 无尘剑：战力+1，命中+1
  8: { power: 0, range: 2 },   // 彩环：命中+2
  10: { power: 1, range: 0 },  // 五彩霞衣：战力+1
  11: { power: 1, range: 0 },  // 乾坤道袍：战力+1
};

// ---------- 技牌（type=3）：需要 targetId，弃牌堆结算 ----------
const SKILL_CARDS = {
  15: { // 鼠儿果：指定一人补2张
    needTarget: true,
    async run(game, { seat, target }) {
      game.drawCards(target, 2);
      game.log(`${seat.name} 使用【鼠儿果】，${target.name} 补了 2 张牌。`);
    },
  },
  16: { // 偷盗：抽取任意玩家1张手牌
    needTarget: true,
    async run(game, { seat, target }) {
      if (!target.hand.length) { game.log(`${target.name} 没有手牌，【偷盗】落空。`); return; }
      const i = Math.floor(game.random() * target.hand.length);
      const [c] = target.hand.splice(i, 1);
      seat.hand.push(c);
      game.log(`${seat.name} 使用【偷盗】，抽走了 ${target.name} 的 1 张手牌。`);
    },
  },
  17: { // 铜钱镖：弃任意玩家1张手牌或装备（targetKind: 'hand'|'equip'）
    needTarget: true,
    async run(game, { seat, target, targetKind }) {
      const equips = game.equipsOf(target);
      if (targetKind === 'equip') {
        const eq = equips[Math.floor(game.random() * equips.length)];
        game.unequip(target, eq);
        game.discardPile.push(eq.card);
        game.log(`${seat.name} 使用【铜钱镖】，弃掉了 ${target.name} 的装备【${eq.card.name}】。`);
        return;
      }
      if (!target.hand.length) { game.log(`${target.name} 没有手牌，【铜钱镖】落空。`); return; }
      const i = Math.floor(game.random() * target.hand.length);
      const [c] = target.hand.splice(i, 1);
      game.discardPile.push(c);
      game.log(`${seat.name} 使用【铜钱镖】，弃掉了 ${target.name} 的 1 张手牌。`);
    },
  },
  18: { // 天雷破：指定一名玩家HP-2（雷属性）
    needTarget: true,
    async run(game, { seat, target }) {
      game.log(`${seat.name} 使用【天雷破】，雷光直劈 ${target.name}！`);
      await game.damage(target, 2, { source: seat, kind: 'skill', element: '雷' });
    },
  },
};

// ---------- 特殊牌（type=1）----------
// 冰心诀(1)：响应他人出牌时打出（引擎在 playCard 流程中询问）
// 灵葫仙丹(2)：技牌阶段自用 HP+2（此处）；濒死救援在引擎 dying 流程
// 隐蛊(3)：受伤时响应（引擎 damage 流程）
const SPECIAL_CARDS = {
  2: { // 灵葫仙丹：自用+2HP
    needTarget: false,
    async run(game, { seat }) {
      seat.hp = Math.min(seat.hp + 2, seat.maxHp);
      game.log(`${seat.name} 服下【灵葫仙丹】，HP+2（当前 ${seat.hp}/${seat.maxHp}）。`);
    },
  },
};

// ---------- 战牌（type=4）----------
//合法性由引擎校验；run 返回是否生效
const WAR_CARDS = {
  21: { // 天玄五音：指定一方本场战力+2，未参战可用
    needTargetSide: true,
    async run(game, { seat, battle, targetSide }) {
      battle.warBonus[targetSide] += 2;
      game.log(`${seat.name} 打出【天玄五音】，${game.factionName(targetSide)}本场战力+2！`);
    },
  },
  22: { // 金蚕王：自己本场战力+3，须参战且命中
    needCombatantHit: true,
    async run(game, { seat, battle }) {
      battle.warPersonal[seat.id] = (battle.warPersonal[seat.id] || 0) + 3;
      game.log(`${seat.name} 打出【金蚕王】，本场战斗其战力+3！`);
    },
  },
  23: { // 天罡战气：自己本场战力（基础部分）加倍，须参战且命中
    needCombatantHit: true,
    async run(game, { seat, battle }) {
      const base = game.effPower(seat);
      battle.warDouble[seat.id] = true;
      battle.warPersonal[seat.id] = (battle.warPersonal[seat.id] || 0) + base; // 加倍=基础+基础
      game.log(`${seat.name} 打出【天罡战气】，本场战斗其战力加倍（+${base}）！`);
    },
  },
  24: { // 金蝉脱壳：强制结束战斗，参战者即可（未命中也可）
    needCombatant: true,
    async run(game, { seat, battle }) {
      battle.escaped = true;
      game.log(`${seat.name} 打出【金蝉脱壳】，本场战斗被强制结束，胜负结算皆无效！`);
    },
  },
};

// ---------- 怪物效果 ----------
// appear: 出场；win: 触发方胜利结算；lose: 触发方失败结算；pets: 收为宠物后的持续属性（引擎解析 petBonus）
const MONSTER_EFFECTS = {
  MO001: {
    async win(game, { trigger }) {
      const target = await game.askChoosePlayer(trigger, game.aliveSeats(), { reason: '积粮隐者：指定一名玩家HP+2' });
      if (target) {
        target.hp = Math.min(target.hp + 2, target.maxHp);
        game.log(`【积粮隐者】胜利结算：${target.name} HP+2。`);
      }
    },
    async lose(game, { trigger }) {
      game.log(`【积粮隐者】失败结算：${trigger.name} HP-3。`);
      await game.damage(trigger, 3, { kind: 'monster', element: '雷' });
    },
  },
  MO002: {
    async appear(game, { battle }) {
      if (battle.supporter) {
        battle.supporterBonus = (battle.supporterBonus || 0) + 2;
        game.log(`【赤鬼王】出场：支援者 ${battle.supporter.name} 本场战斗战力+2。`);
      }
    },
    async win(game, { trigger }) {
      const target = await game.askChoosePlayer(trigger, game.aliveSeats(), { reason: '赤鬼王：指定一名玩家补2张牌' });
      if (target) {
        game.drawCards(target, 2);
        game.log(`【赤鬼王】胜利结算：${target.name} 补 2 张牌。`);
      }
    },
    async lose(game, { trigger }) {
      game.log(`【赤鬼王】失败结算：${trigger.name} 先受到 2 点伤害，再失去全部装备并补充等量手牌。`);
      await game.damage(trigger, 2, { kind: 'monster', element: '雷' });
      const lost = game.unequipAll(trigger);
      for (const card of lost) game.discardPile.push(card);
      game.drawCards(trigger, lost.length);
      if (lost.length) game.log(`${trigger.name} 失去了 ${lost.length} 件装备，补了 ${lost.length} 张手牌。`);
    },
  },
  MO005: {
    async win(game, { trigger }) {
      game.drawCards(trigger, 1);
      game.log(`【叶灵】胜利结算：${trigger.name} 补 1 张牌。`);
    },
    async lose(game, { trigger }) {
      game.log(`【叶灵】失败结算：${trigger.name} HP-2。`);
      await game.damage(trigger, 2, { kind: 'monster', element: '风' });
    },
  },
  MO008: {
    async win(game, { trigger }) {
      const enemySide = game.enemyFactionOf(trigger.faction);
      const decider = game.factionDecider(enemySide);
      const target = decider
        ? await game.askChoosePlayer(decider, game.aliveSeats(enemySide), { reason: '蝶精：敌方任选一人HP+2' })
        : null;
      if (target) {
        target.hp = Math.min(target.hp + 2, target.maxHp);
        game.log(`【蝶精】胜利结算：敌方 ${target.name} HP+2。`);
      }
    },
    async lose() { /* 无 */ },
  },
  MO009: {
    async appear(game, { battle }) {
      const victims = game.seats.filter((seat) => seat.alive && !game.isCombatant(seat, battle));
      game.log('【刑天】出场：参战者以外的所有角色HP-（其手牌数）。');
      await game.damageBatch(victims.map((seat) => ({ seat, amount: seat.hand.length })), { kind: 'monster', element: '土' });
    },
  },
  MO012: {
    async lose(game, { trigger, monster, battle }) {
      const holders = game.aliveSeats(trigger.faction).filter((seat) => seat.pets.some((pet) => pet.elements.id === 3));
      if (!holders.length) return;
      const decider = game.factionDecider(trigger.faction);
      const holder = holders.length === 1 ? holders[0]
        : await game.askChoosePlayer(decider, holders, { reason: '天鬼皇：选择一名拥有土属性宠物的角色' });
      if (!holder) return;
      const earthPets = holder.pets.filter((pet) => pet.elements.id === 3);
      const old = earthPets.length === 1 ? earthPets[0]
        : await game.askChoosePet(holder, earthPets, { reason: '天鬼皇：选择要被替换的土属性宠物' });
      if (!old) return;
      const yes = await game.askYesNo(holder, { reason: `是否用【天鬼皇】替换【${old.name}】？` });
      if (!yes) return;
      holder.pets.splice(holder.pets.indexOf(old), 1);
      game.monsterDiscard.push(old);
      holder.pets.push(monster);
      battle.monsterClaimed = true;
      game.log(`【天鬼皇】失败结算：${holder.name} 弃置【${old.name}】，将当前这张【天鬼皇】收为宠物。`);
    },
  },
  MO013: {
    async appear(game, { battle }) {
      const trigger = battle.trigger;
      const obstructer = battle.obstructer;
      if (!obstructer) return;
      const hand = trigger.hand;
      trigger.hand = obstructer.hand;
      obstructer.hand = hand;
      game.log(`【千杯不醉】出场：${trigger.name} 与妨碍者 ${obstructer.name} 手牌对调。`);
    },
    async lose(game, { trigger }) {
      trigger.tapped = true;
      game.log(`【千杯不醉】失败结算：${trigger.name} 的角色横置，将跳过其下一个回合。`);
    },
  },
  MO016: {
    async win(game, { trigger, battle }) {
      const enemies = game.aliveSeats(game.enemyFactionOf(trigger.faction));
      game.log('【水魔兽】胜利结算：敌方全体HP-1。');
      await game.damageBatch(enemies.map((seat) => ({ seat, amount: 1 })), { kind: 'monster', element: '水' });
      if (battle.obstructer?.alive) {
        await game.stealRandomFromNonEmptyZone(trigger, battle.obstructer, '水魔兽：选择从妨碍者的手牌或装备区抽取');
      }
    },
    async lose(game, { trigger, battle }) {
      game.log(`【水魔兽】失败结算：${trigger.name} HP-2。`);
      await game.damage(trigger, 2, { kind: 'monster', element: '水' });
      if (battle.obstructer?.alive && trigger.alive) {
        await game.stealRandomFromNonEmptyZone(battle.obstructer, trigger, '水魔兽：选择从触发者的手牌或装备区抽取');
      }
    },
  },
  MO019: {
    async appear(game, { battle, trigger }) {
      if (!battle.supporter?.alive) return;
      const amount = Math.max(0, game.effPower(trigger) - 1);
      if (!amount) return;
      game.log(`【狐妖女】出场：支援者 ${battle.supporter.name} HP-${amount}。`);
      await game.damage(battle.supporter, amount, { kind: 'monster', element: '火' });
    },
    async win(game, { battle }) {
      if (!battle.obstructer?.alive) return;
      game.log(`【狐妖女】胜利结算：妨碍者 ${battle.obstructer.name} HP-3。`);
      await game.damage(battle.obstructer, 3, { kind: 'monster', element: '火' });
    },
    async lose(game, { trigger }) {
      const enemySide = game.enemyFactionOf(trigger.faction);
      const decider = game.factionDecider(enemySide);
      const candidates = game.aliveSeats();
      if (!decider || !candidates.length) return;
      const targets = await game.askChoosePlayers(decider, candidates, 2, { reason: '狐妖女：选择现有最多两名不同的存活角色，各HP-3' });
      if (!targets.length) return;
      game.log(`【狐妖女】失败结算：${targets.map((seat) => seat.name).join('、')} HP-3。`);
      await game.damageBatch(targets.map((seat) => ({ seat, amount: 3 })), { kind: 'monster', element: '火' });
    },
  },
  MO020: {
    async appear(game) {
      game.log('【熔岩兽王】出场：全体角色HP-2！');
      await game.damageBatch(game.aliveSeats().map((seat) => ({ seat, amount: 2 })), { kind: 'monster', element: '火' });
    },
    async win(game, { trigger }) {
      const enemies = game.aliveSeats(game.enemyFactionOf(trigger.faction));
      game.log('【熔岩兽王】胜利结算：敌方全体HP-2！');
      await game.damageBatch(enemies.map((seat) => ({ seat, amount: 2 })), { kind: 'monster', element: '火' });
    },
    async lose(game, { trigger, battle }) {
      const victims = [trigger, battle.supporter].filter((seat) => seat?.alive);
      game.log('【熔岩兽王】失败结算：触发者与支援者HP各-2。');
      await game.damageBatch(victims.map((seat) => ({ seat, amount: 2 })), { kind: 'monster', element: '火' });
    },
  },
};

// 宠物持续加成（pets 效果）：按怪物 id
const PET_BONUS = {
  MO002: { drawExtra: 1 },       // 补牌阶段多补1张
  MO009: { range: 1 },           // 主人命中+1
  MO012: { power: 2, range: 1 }, // 主人战力+2，命中+1
  MO013: { power: 1 },           // 主人战力+1
  MO016: { power: 1, range: 1 }, // 主人战力+1，命中+1
  MO019: { power: 2 },           // 主人战力+2
  MO020: { power: 2 },           // 主人战力+2
};

// ---------- 事件牌 ----------
const EVENT_EFFECTS = {
  EV001: async (game, seat) => {
    if (seat.sex === 1) {
      game.drawCards(seat, 1);
      game.log(`${seat.name} 触发【仙灵岛的邂逅】：补 1 张牌后扣 1 HP。`);
      await game.damage(seat, 1, { kind: 'event' });
    } else {
      const armors = game.equipsOf(seat).filter((e) => e.card.eqvType === EQV_TYPE.ARMOR);
      if (armors.length) {
        const eq = armors[0];
        game.unequip(seat, eq);
        game.discardPile.push(eq.card);
        game.log(`${seat.name} 触发【仙灵岛的邂逅】：弃掉防具【${eq.card.name}】。`);
      } else {
        game.log(`${seat.name} 触发【仙灵岛的邂逅】：没有防具可弃。`);
      }
      const males = game.aliveSeats().filter((s) => s.sex === 1 && s.id !== seat.id);
      if (males.length) {
        const t = await game.askChoosePlayer(seat, males, { reason: '仙灵岛的邂逅：选择一名男性角色（视为使用天雷破）', optional: true });
        if (t) {
          game.log(`${seat.name} 对 ${t.name} 视为使用了 1 张【天雷破】！`);
          await game.damage(t, 2, { source: seat, kind: 'skill', element: '雷' });
        }
      }
    }
  },
  EV002: async (game) => {
    const t = game.aliveSeats().filter((s) => !s.pets.length);
    game.log(`【深入将军冢】：没有宠物的角色各补 1 张牌。`);
    for (const s of t) game.drawCards(s, 1);
  },
  EV003: async (game, seat) => {
    const ally = await game.askChoosePlayer(seat, game.aliveSeats(seat.faction), { reason: '走出圣姑小屋：指定我方一人补2张牌' });
    const enemySide = game.enemyFactionOf(seat.faction);
    const enemy = await game.askChoosePlayer(seat, game.aliveSeats(enemySide), { reason: '走出圣姑小屋：指定敌方一人补2张牌' });
    if (ally) game.drawCards(ally, 2);
    if (enemy) game.drawCards(enemy, 2);
    game.log(`【走出圣姑小屋】：${ally ? ally.name : '无人'} 与 ${enemy ? enemy.name : '无人'} 各补 2 张牌。`);
  },
  EV005: async (game) => {
    const t = game.aliveSeats().filter((s) => s.hp <= 3);
    game.log(`【寻找天使绘卷】：当前HP≤3的玩家各补 1 张牌。`);
    for (const s of t) game.drawCards(s, 1);
  },
};

// ---------- 角色技能（被动/触发式，引擎在对应时机调用）----------
const CHAR_SKILLS = {
  XJ101: {
    // 侠骨柔肠：支援女性角色触发的战斗时命中+1（强制）
    supportHitBonus(game, seat, battle) {
      if (battle.trigger && battle.trigger.sex === 2) {
        game.log(`【侠骨柔肠】${seat.name}（支援女性角色 ${battle.trigger.name} 触发的战斗）命中+1。`);
        return 1;
      }
      return 0;
    },
    // 飞龙探云手：参与我方触发的战斗且怪物闪避≤2，战斗开始抽每名妨碍者1张手牌
    async onBattleFlip(game, seat, battle) {
      if (battle.trigger.faction !== seat.faction) return;
      if (battle.monster.range > 2) return;
      const robFrom = [battle.obstructer].filter(Boolean);
      for (const v of robFrom) {
        if (!v.hand.length) continue;
        const i = Math.floor(game.random() * v.hand.length);
        const [c] = v.hand.splice(i, 1);
        seat.hand.push(c);
        game.log(`【飞龙探云手】${seat.name} 抽走了妨碍者 ${v.name} 的 1 张手牌。`);
      }
    },
  },
  XJ102: {
    // 双剑：武器槽2
    weaponSlots: 2,
  },
  XJ103: {
    weaponSlots: 2,
  },
  XJ104: {
    // 林家剑法：装备武器时战力+1
    powerBonus(game, seat) {
      return game.equipsOf(seat).some((e) => e.card.eqvType === EQV_TYPE.WEAPON) ? 1 : 0;
    },
    // 嫉恶如仇：参战且本方失败时，敌方所有参战者HP-1
    async onBattleEnd(game, seat, battle) {
      if (!game.isCombatant(seat, battle)) return;
      const mySideWon = battle.winnerSide === 'a' ? seat.faction === 'a' : seat.faction === 'b';
      if (battle.winnerSide && !mySideWon) {
        const enemySide = game.enemyFactionOf(seat.faction);
        const victims = [battle.trigger, battle.supporter, battle.obstructer].filter(Boolean)
          .filter((s) => s.alive && s.faction === enemySide);
        game.log(`【嫉恶如仇】${seat.name} 所在阵营战败，敌方参战者HP-1！`);
        for (const v of victims) await game.damage(v, 1, { source: seat, kind: 'skill' });
      }
    },
  },
  XJ106: {
    // 御剑术：装备武器时命中+1
    rangeBonus(game, seat) {
      return game.equipsOf(seat).some((e) => e.card.eqvType === EQV_TYPE.WEAPON) ? 1 : 0;
    },
  },
};

// 按实例取角色技能包（含变身后的当前角色）
function skillsOf(seat) {
  return CHAR_SKILLS[seat.char.id] || {};
}

module.exports = {
  CARD_TYPE, EQV_TYPE, CARD_TYPE_NAME,
  EQUIP_STATS, SKILL_CARDS, SPECIAL_CARDS, WAR_CARDS,
  MONSTER_EFFECTS, PET_BONUS, EVENT_EFFECTS, CHAR_SKILLS,
  skillsOf,
  defs: { characters, monsters, events, cards },
};
