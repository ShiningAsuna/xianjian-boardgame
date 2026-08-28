// 效果注册表：所有卡牌的效果都通过这里的 key 实现。
// 新增卡牌/新增效果时，只需在 data/cards.js 里定义 effect.key，
// 并在此处注册对应的处理函数，引擎无需改动。
//
// 签名：fn(game, ctx) => void
//   game : XianjianGame 实例
//   ctx  : { seat 施法者, card 卡牌实例, value/effect 原始参数 }
//
// 返回 true 表示处理成功；返回 false 表示无法执行（由调用方回滚/提示）。

const REGISTRY = {
  // 摸 n 张牌
  draw_cards(game, { seat, value }) {
    for (let i = 0; i < value; i++) {
      if (seat.hand.length >= game.HAND_LIMIT) {
        game.log(`${seat.name} 手牌已满，无法再摸。`);
        return false;
      }
      game.drawSkill(seat, `${seat.name} 因卡牌效果摸了一张牌。`);
    }
    return true;
  },

  // 自身回复 n 点气血
  heal(game, { seat, value }) {
    const healed = Math.min(value, seat.maxHp - seat.hp);
    seat.hp += healed;
    game.log(`${seat.name} 回复了 ${healed} 点气血（当前 ${seat.hp}/${seat.maxHp}）。`);
    return true;
  },

  // 自身损失 n 点气血
  lose_hp(game, { seat, value }) {
    game.damageSeat(seat, value, '卡牌效果');
    return true;
  },

  // 其他所有存活玩家各损失 n 点气血
  damage_others_all(game, { seat, value }) {
    const victims = game.aliveSeats().filter((s) => s.id !== seat.id);
    if (!victims.length) return false;
    game.log(`${seat.name} 的攻击波及了所有其他玩家！`);
    for (const v of victims) game.damageSeat(v, value, `${seat.name} 的攻击`);
    return true;
  },

  // 本次战斗战力临时 +n（战斗结算后消耗）
  temp_power(game, { seat, value }) {
    seat.tempBuff += value;
    game.log(`${seat.name} 获得了本次战斗 +${value} 的临时战力加成。`);
    return true;
  },

  // 场上装备：永久战力加成（数值记录在装备实例上，结算时动态累计）
  power_bonus(game, { card }) {
    card.applied = true;
    return true;
  },

  // 组合效果：本次战斗 +power 且立即摸 draw 张
  buff_and_draw(game, { seat, effect }) {
    seat.tempBuff += effect.power || 0;
    game.log(`${seat.name} 获得了本次战斗 +${effect.power || 0} 的临时战力加成。`);
    for (let i = 0; i < (effect.draw || 0); i++) {
      if (seat.hand.length >= game.HAND_LIMIT) break;
      game.drawSkill(seat);
    }
    return true;
  },

  // 弃掉一张手牌（作为惩罚等）；无手牌则损失气血代替
  discard_1(game, { seat }) {
    if (!seat.hand.length) {
      game.log(`${seat.name} 无牌可弃，改为损失 1 点气血。`);
      game.damageSeat(seat, 1, '弃牌失败');
      return true;
    }
    const idx = Math.floor(Math.random() * seat.hand.length);
    const [lost] = seat.hand.splice(idx, 1);
    game.discardPile.push(lost);
    game.log(`${seat.name} 被迫弃掉了【${lost.name}】。`);
    return true;
  },
};

module.exports = {
  has(key) {
    return Object.prototype.hasOwnProperty.call(REGISTRY, key);
  },
  run(key, game, ctx) {
    const fn = REGISTRY[key];
    if (!fn) {
      console.warn(`[effects] 未注册的效果: ${key}`);
      return false;
    }
    return fn(game, ctx);
  },
};
