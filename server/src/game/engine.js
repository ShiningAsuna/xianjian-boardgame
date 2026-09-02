// 《仙剑奇侠传·逍遥游》游戏引擎 v2
// 规则来源：《游戏规则.md》（2026-09 更新版）
//
// 主要流程：
//   pick（角色选择：抽 n 张 → 双方各弃 1 → 交替轮选）
//   → 回合循环（事件 → 技牌 → 战斗(8 子阶段) → 补牌）
//   → over（怪兽翻完比宠物总战力 / 一方全灭）
//
// 引擎为异步状态机：需要玩家决策的点通过 ask() 挂起等待，
// Socket 层用 submitPending 提交答案；Bot 由房间层驱动 needAutomation。

const crypto = require('crypto');
const config = require('../config');
const R = require('./rules');
const { CARD_TYPE, EQV_TYPE } = R;

let uidSeq = 0;
const nextUid = (tag, id) => `${tag}${id}_${++uidSeq}`;

function shuffle(arr, random = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const HAND_START = 3;   // 起始手牌
const HAND_KEEP = 3;    // 回合结束时保留的手牌上限
const DRAW_PER_TURN = 2;

class XianjianGame {
  constructor(opts) {
    this.roomId = opts.roomId;
    this.mode = opts.mode;
    this.size = opts.players.length;
    this.onState = opts.onState;
    this.onEnd = opts.onEnd || null;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;

    // 房间配置：抽取角色数 / 明牌数 / 暗牌数
    this.pickConfig = this._normalizePickConfig(opts.pickConfig, this.size);

    this.over = false;
    this.result = null;
    this.phase = 'pick';
    this.logEntries = [];
    this.pending = null;      // 当前等待响应的询问 {id,seatId,kind,data,validate,resolve,timer,deadline}
    this.battle = null;       // 战斗上下文
    this._busy = false;       // 引擎互斥锁
    this._botToken = 0;
    this._dyingSeats = new Set();
    this._damageSeq = 0;
    this.startedAt = new Date().toISOString();

    // ---- 座位 ----
    this.seats = opts.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      offline: false,
      faction: i % 2 === 0 ? 'a' : 'b',
      char: null,          // 角色牌（pick 结束后分配）
      hp: 0, maxHp: 0, sex: 0,
      hand: [],
      equips: [],          // 装备实例 {card, uid}
      pets: [],            // 宠物（怪兽实例）
      alive: true,
      tapped: false,       // 横置：跳过下一回合
      factionRoles: null,  // 本阵营选到的角色池（pick 期）
    }));

    // ---- 牌堆 ----
    // 怪兽牌/事件牌一次性使用（不洗回）；手牌弃牌堆可洗回
    this.monsterDeck = shuffle(R.defs.monsters.map((d) => this.instantiateMonster(d)), this.random);
    this.monsterDiscard = [];
    this.eventDeck = shuffle(R.defs.events.flatMap((d) => Array.from({ length: d.num || 1 }, () => ({ ...d, uid: nextUid('ev', d.id) }))), this.random);
    this.eventDiscard = [];
    this.skillDeck = shuffle(R.defs.cards.flatMap((d) => Array.from({ length: d.num || 1 }, () => this.instantiateCard(d))), this.random);
    this.discardPile = [];

    // 角色牌库：每种角色 2 份（梦蛇为变身形态，不进选择池）
    const rolePoolDefs = R.defs.characters.filter((c) => c.canChoose !== false);
    this.roleLibrary = shuffle(rolePoolDefs.flatMap((d) => Array.from({ length: 2 }, () => ({ ...d }))), this.random);

    // ---- 掷骰子定先手 ----
    let rollA;
    let rollB;
    let rerolls = 0;
    do {
      rollA = 1 + Math.floor(this.random() * 6);
      rollB = 1 + Math.floor(this.random() * 6);
      if (rollA === rollB) rerolls++;
    } while (rollA === rollB);
    this.dice = { a: rollA, b: rollB, rerolls };
    this.firstFaction = rollA > rollB ? 'a' : 'b';

    // 选将完成后由先手阵营决策人指定；此处仅准备合法的默认顺序供 Bot/超时使用。
    this.turnOrder = this._defaultAlternatingOrder();
    this.turnIdx = 0;

    // ---- 角色选择阶段状态 ----
    const { total, open } = this.pickConfig;
    const drawn = shuffle(this.roleLibrary, this.random).slice(0, total);
    this.pick = {
      pool: drawn.map((c, i) => ({
        key: `pk_${i}`,
        card: c,
        open: i < open,       // 明牌 / 暗牌
        owner: null,          // 'a' | 'b' | 'discard'
      })),
      steps: this._buildPickSteps(total),
      stepIdx: 0,
      stepTaken: 0,
      factionRoles: { a: [], b: [] },
    };

    this.log(`骰子判定：蜀山派 ${rollA} 点 VS 拜月教 ${rollB} 点，${this.factionName(this.firstFaction)}获得先手。`);
    this.log(`角色选择阶段：抽取 ${total} 张角色牌（明牌 ${open} 张 / 暗牌 ${total - open} 张）。`);
    this.log(`先手阵营先弃置 1 张角色，随后另一方也弃置 1 张；再由先手方开始交替选择角色。`);
    this.onState && this.onState(this.roomId);
  }

  instantiateCard(def) { return { ...def, uid: nextUid('c', def.id) }; }
  instantiateMonster(def) { return { ...def, uid: nextUid('m', def.id) }; }

  _normalizePickConfig(cfg = {}, size) {
    const libSize = R.defs.characters.filter((c) => c.canChoose !== false).length * 2;
    let total = Number(cfg.total) || 12;
    // n 至少覆盖“双方各弃1 + 每名玩家1张”，且不超过牌库
    const min = size + 2;
    total = Math.max(min, Math.min(total, libSize));
    total -= total % 2; // 必须为偶数
    if (total < min) { total = min % 2 === 0 ? min : min + 1; }
    let open = Number(cfg.open);
    if (!Number.isFinite(open)) open = total / 2;
    open = Math.max(0, Math.min(open, total));
    if (open % 2 !== total % 2) open = Math.max(0, open - 1); // x 与 n 同奇偶（均为偶数）
    return { total, open, hidden: total - open };
  }

  /** 弃置/轮选步骤序列：先手弃、后手弃、先手选1、后手选2、先手选2、后手选2……直到分完 */
  _buildPickSteps(total) {
    const steps = [
      { side: this.firstFaction, mode: 'discard', count: 1 },
      { side: this.enemyFactionOf(this.firstFaction), mode: 'discard', count: 1 },
    ];
    const rest = total - 2;
    let side = this.firstFaction;
    let remain = rest;
    let firstRound = true;
    while (remain > 0) {
      const take = firstRound ? 1 : Math.min(2, remain);
      steps.push({ side, mode: 'choose', count: take });
      remain -= take;
      side = this.enemyFactionOf(side);
      firstRound = false;
    }
    return steps;
  }

  _defaultAlternatingOrder() {
    const first = this.seats.filter((seat) => seat.faction === this.firstFaction).map((seat) => seat.id);
    const second = this.seats.filter((seat) => seat.faction !== this.firstFaction).map((seat) => seat.id);
    return first.flatMap((id, index) => [id, second[index]]).filter(Boolean);
  }

  _validTurnOrder(order) {
    if (!Array.isArray(order) || order.length !== this.seats.length || new Set(order).size !== order.length) return false;
    if (!order.every((id) => this.seatById(id))) return false;
    return order.every((id, index) => this.seatById(id).faction === (index % 2 === 0 ? this.firstFaction : this.enemyFactionOf(this.firstFaction)));
  }

  // ================= 查询工具 =================
  seatById(id) { return this.seats.find((s) => s.id === id); }
  currentSeat() { return this.seatById(this.turnOrder[this.turnIdx]); }
  aliveSeats(fk) { return this.seats.filter((s) => s.alive && (!fk || s.faction === fk)); }
  enemyFactionOf(fk) { return fk === 'a' ? 'b' : 'a'; }
  factionName(fk) { return config.FACTIONS.find((f) => f.key === fk)?.name || fk; }
  factionDecider(fk) {
    return this.turnOrder.map((id) => this.seatById(id)).find((seat) => seat?.alive && seat.faction === fk)
      || this.aliveSeats(fk)[0]
      || null;
  }
  petScore(seat) {
    const base = seat.pets.reduce((value, pet) => value + pet.power, 0);
    return base + (seat.char?.id === 'XJ305' ? seat.pets.length * 3 : 0);
  }
  factionScore(fk) {
    return this.seats.filter((seat) => seat.faction === fk)
      .reduce((sum, seat) => sum + this.petScore(seat), 0);
  }
  isCombatant(seat, battle) {
    if (!battle) return false;
    return [battle.trigger, battle.supporter, battle.obstructer].some((s) => s && s.id === seat.id);
  }
  log(text) {
    this.logEntries.push({ t: Date.now(), text });
    if (this.logEntries.length > 300) this.logEntries.splice(0, this.logEntries.length - 300);
  }
  emit() { this.onState && this.onState(this.roomId); }

  equipsOf(seat) { return seat.equips; }
  weaponSlots(seat) {
    const sk = R.skillsOf(seat);
    return sk.weaponSlots || 1;
  }
  unequip(seat, eq) {
    const i = seat.equips.indexOf(eq);
    if (i >= 0) seat.equips.splice(i, 1);
    return eq;
  }
  unequipAll(seat) {
    const lost = seat.equips.map((e) => e.card);
    seat.equips = [];
    return lost;
  }

  // 生效战力：角色 + 装备 + 宠物 + 技能被动
  effPower(seat) {
    if (!seat.char) return 0;
    let p = seat.char.power;
    for (const eq of seat.equips) p += R.EQUIP_STATS[eq.card.id]?.power || 0;
    for (const pet of seat.pets) p += R.PET_BONUS[pet.id]?.power || 0;
    const sk = R.skillsOf(seat);
    if (sk.powerBonus) p += sk.powerBonus(this, seat);
    return p;
  }

  // 生效命中：角色 + 装备 + 宠物 + 技能被动
  effRange(seat) {
    if (!seat.char) return 0;
    let r = seat.char.range;
    for (const eq of seat.equips) r += R.EQUIP_STATS[eq.card.id]?.range || 0;
    for (const pet of seat.pets) r += R.PET_BONUS[pet.id]?.range || 0;
    const sk = R.skillsOf(seat);
    if (sk.rangeBonus) r += sk.rangeBonus(this, seat);
    return r;
  }

  hasSkill(seat, name) { return (seat.char?.skill || []).some((s) => s.name === name); }

  // ================= 询问（pending）=================
  _defaultPendingValidate(kind, data, answer) {
    if (['yes_no', 'battle_confirm', 'use_card', 'use_equip_burst', 'use_pet_burst'].includes(kind)) {
      return typeof answer === 'boolean';
    }
    if (['pick_supporter', 'pick_obstructer', 'war_pick_player'].includes(kind)) {
      return Array.isArray(data.candidates) && data.candidates.includes(answer);
    }
    if (kind === 'war_play_card') {
      if (!answer || typeof answer !== 'object') return false;
      if (answer.pass === true) return true;
      const legal = Array.isArray(data.legal) ? data.legal : [];
      const option = legal.find((item) => item.uid === answer.uid);
      if (!option) return false;
      return !option.needTargetSide || answer.targetSide === 'a' || answer.targetSide === 'b';
    }
    return false;
  }

  ask(seatId, { kind, data = {}, timeoutMs = 15000, botFn, validate = null }) {
    return new Promise((resolve) => {
      const seat = this.seatById(seatId);
      const wrap = {
        id: crypto.randomUUID(),
        seatId,
        kind,
        data,
        validate: validate || ((answer) => this._defaultPendingValidate(kind, data, answer)),
        deadline: Date.now() + timeoutMs,
        resolve: (answer) => {
          clearTimeout(wrap.timer);
          if (this.pending === wrap) this.pending = null;
          resolve(answer);
          this.emit();
        },
        timer: null,
      };
      wrap.timer = setTimeout(() => {
        if (this.pending !== wrap) return;
        this.log(`（${seat?.name || seatId} 响应超时，自动处理）`);
        wrap.resolve(botFn ? botFn() : null);
      }, timeoutMs);
      this.pending = wrap;
      this.emit();
      if (seat?.isBot || seat?.offline) {
        setTimeout(() => {
          if (this.pending === wrap) wrap.resolve(botFn ? botFn() : null);
        }, 650);
      }
    });
  }

  submitPending(playerId, pendingId, answer) {
    const pending = this.pending;
    if (!pending || pending.seatId !== playerId) return { ok: false, error: '当前没有等待您的询问。' };
    if (!pendingId || pending.id !== pendingId) return { ok: false, error: '询问已过期，请按最新状态重新操作。' };
    if (pending.validate && !pending.validate(answer)) return { ok: false, error: '提交内容不在服务端允许的候选范围内。' };
    pending.resolve(answer);
    return { ok: true };
  }

  async askChoosePlayer(seat, candidates, { reason, optional = false } = {}) {
    const list = candidates.filter((candidate) => candidate?.alive).map((candidate) => candidate.id);
    if (!list.length) return null;
    const answer = await this.ask(seat.id, {
      kind: 'choose_player',
      data: { reason, candidates: list, optional },
      validate: (value) => (optional && value == null) || list.includes(value),
      botFn: () => list[0],
    });
    return list.includes(answer) ? this.seatById(answer) : null;
  }

  async askChoosePlayers(seat, candidates, count, { reason } = {}) {
    const list = candidates.filter((candidate) => candidate?.alive).map((candidate) => candidate.id);
    const actualCount = Math.min(Math.max(0, count), list.length);
    if (!actualCount) return [];
    const answer = await this.ask(seat.id, {
      kind: 'choose_players',
      data: { reason, candidates: list, min: actualCount, max: actualCount },
      validate: (value) => Array.isArray(value) && value.length === actualCount
        && new Set(value).size === actualCount && value.every((id) => list.includes(id)),
      botFn: () => list.slice(0, actualCount),
    });
    return Array.isArray(answer) ? answer.map((id) => this.seatById(id)).filter(Boolean) : [];
  }

  async askChooseCards(seat, cards, count, { reason, min = count, max = count } = {}) {
    const list = cards.map((card) => card.uid);
    if (list.length < min) return [];
    const answer = await this.ask(seat.id, {
      kind: 'choose_cards',
      data: {
        reason,
        options: cards.map((card) => ({ uid: card.uid, name: card.name, type: card.type })),
        min,
        max,
      },
      validate: (value) => Array.isArray(value) && value.length >= min && value.length <= max
        && new Set(value).size === value.length && value.every((uid) => list.includes(uid)),
      botFn: () => list.slice(0, count),
    });
    return answer.map((uid) => cards.find((card) => card.uid === uid)).filter(Boolean);
  }

  async askChooseZone(seat, zones, { reason } = {}) {
    if (!zones.length) return null;
    const answer = await this.ask(seat.id, {
      kind: 'choose_zone',
      data: { reason, zones },
      validate: (value) => zones.includes(value),
      botFn: () => zones[0],
    });
    return zones.includes(answer) ? answer : null;
  }

  async askChoosePet(seat, pets, { reason } = {}) {
    if (!pets.length) return null;
    const options = pets.map((pet) => ({ uid: pet.uid, name: pet.name, element: pet.elements.name, power: pet.power }));
    const answer = await this.ask(seat.id, {
      kind: 'choose_pet',
      data: { reason, options },
      validate: (value) => options.some((option) => option.uid === value),
      botFn: () => pets.slice().sort((a, b) => b.power - a.power)[0].uid,
    });
    return pets.find((pet) => pet.uid === answer) || null;
  }

  async stealRandomFromNonEmptyZone(receiver, source, reason) {
    if (!receiver?.alive || !source?.alive) return null;
    const zones = [];
    if (source.hand.length) zones.push('hand');
    if (source.equips.length) zones.push('equip');
    const zone = await this.askChooseZone(receiver, zones, { reason });
    if (zone === 'hand' && source.hand.length) {
      const index = Math.floor(this.random() * source.hand.length);
      const [card] = source.hand.splice(index, 1);
      receiver.hand.push(card);
      this.log(`${receiver.name} 从 ${source.name} 的手牌区随机抽取了1张牌。`);
      return card;
    }
    if (zone === 'equip' && source.equips.length) {
      const index = Math.floor(this.random() * source.equips.length);
      const [equip] = source.equips.splice(index, 1);
      receiver.hand.push(equip.card);
      this.log(`${receiver.name} 从 ${source.name} 的装备区随机抽取了【${equip.card.name}】并收入手牌。`);
      return equip.card;
    }
    return null;
  }

  async askYesNo(seat, { reason, defaultValue = true } = {}) {
    const answer = await this.ask(seat.id, {
      kind: 'yes_no',
      data: { reason },
      validate: (value) => typeof value === 'boolean',
      botFn: () => defaultValue,
    });
    return answer === true;
  }

  // ================= 摸牌 / 伤害 / 濒死 =================
  drawCards(seat, n) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!this.skillDeck.length) {
        if (!this.discardPile.length) break;
        this.skillDeck = shuffle(this.discardPile, this.random);
        this.discardPile = [];
        this.log('手牌弃牌堆已洗回抽牌堆。');
      }
      seat.hand.push(this.skillDeck.pop());
      drawn++;
    }
    return drawn;
  }

  /** 单体伤害也走事务入口，保证追打、批量伤害和濒死只结算一次。 */
  async damage(seat, amount, options = {}) {
    const transaction = await this.damageBatch([{ seat, amount }], options);
    return transaction.deadIds.includes(seat?.id);
  }

  async damageBatch(entries, { source = null, kind = 'skill', element = null, fromLove = false, bypassHidden = false, noChase = false } = {}) {
    const transaction = {
      id: `damage_${++this._damageSeq}`,
      sourceId: source?.id || null,
      kind,
      actualIds: [],
      deadIds: [],
    };
    for (const entry of entries) {
      const seat = entry?.seat;
      const amount = Number(entry?.amount) || 0;
      const lost = await this._applyDamageWithoutDying(seat, amount, { source, kind, element, fromLove, bypassHidden });
      if (lost > 0 && !transaction.actualIds.includes(seat.id)) transaction.actualIds.push(seat.id);
    }

    if (!noChase && transaction.actualIds.length) {
      const originalVictims = transaction.actualIds.map((id) => this.seatById(id)).filter(Boolean);
      for (const tang of this.aliveSeats().filter((seat) => seat.char?.id === 'XJ302' && seat.hp > 0 && seat.hand.length)) {
        const chosen = await this.askChooseCards(tang, tang.hand.slice(), 0, {
          reason: `【追打】可弃 1 张手牌，令本次实际掉血的 ${originalVictims.map((seat) => seat.name).join('、')} 各额外HP-1`,
          min: 0,
          max: 1,
        });
        if (!chosen.length) continue;
        const card = chosen[0];
        const index = tang.hand.findIndex((item) => item.uid === card.uid);
        if (index < 0) continue;
        tang.hand.splice(index, 1);
        this.discardPile.push(card);
        this.log(`【追打】${tang.name} 弃置【${card.name}】，本次实际掉血的全部角色额外HP-1。`);
        for (const victim of originalVictims) {
          const lost = await this._applyDamageWithoutDying(victim, 1, { source: tang, kind: 'skill' });
          if (lost > 0 && !transaction.actualIds.includes(victim.id)) transaction.actualIds.push(victim.id);
        }
      }
    }

    this.lastDamage = { id: transaction.id, sourceId: transaction.sourceId, kind, actualIds: transaction.actualIds.slice() };
    for (const id of transaction.actualIds) {
      const victim = this.seatById(id);
      if (victim?.alive && victim.hp <= 0 && !this._dyingSeats.has(id)) {
        const died = await this.dyingProcess(victim, fromLove);
        if (died) transaction.deadIds.push(id);
      }
    }
    return transaction;
  }

  async _applyDamageWithoutDying(seat, amount, { kind, element, fromLove, bypassHidden }) {
    if (this.over || !seat?.alive || amount <= 0) return 0;
    if (!fromLove && !bypassHidden) {
      const hiddenGu = seat.hand.find((card) => card.id === 3);
      if (hiddenGu) {
        const use = await this.ask(seat.id, {
          kind: 'use_card',
          data: { reason: `是否使用【隐蛊】抵消这 ${amount} 点伤害？`, cardUid: hiddenGu.uid },
          botFn: () => amount >= 2,
        });
        if (use && seat.hand.includes(hiddenGu)) {
          seat.hand.splice(seat.hand.indexOf(hiddenGu), 1);
          this.log(`${seat.name} 使用【隐蛊】响应伤害。`);
          const cancelled = await this._askCounter(seat, hiddenGu);
          this.discardPile.push(hiddenGu);
          if (!cancelled) {
            this.log(`【隐蛊】生效，${seat.name} 抵消了 ${amount} 点伤害。`);
            return 0;
          }
          this.log(`【隐蛊】被反制，伤害继续结算。`);
        }
      }
    }
    if (kind === 'skill' && seat.equips.some((equip) => equip.card.id === 11)) {
      this.log(`${seat.name} 身着【乾坤道袍】，免疫技牌伤害。`);
      return 0;
    }
    seat.hp -= amount;
    this.log(`${seat.name} 受到 ${amount} 点${element ? `${element}属性` : ''}伤害，剩余气血 ${Math.max(seat.hp, 0)}。`);
    return amount;
  }

  /** 濒死结算：仙丹 → 装备/宠物爆发 → 倾慕者 → 生命献祭 → 阵亡。 */
  async dyingProcess(seat, fromLove = false) {
    if (!seat?.alive || seat.hp > 0 || this._dyingSeats.has(seat.id)) return false;
    this._dyingSeats.add(seat.id);
    try {
      this.log(`${seat.name} 的【${seat.char?.name || '?'}】进入濒死！`);
      this.emit();

      const saviors = this.aliveSeats().sort((a, b) => (a.id === seat.id ? -1 : b.id === seat.id ? 1 : 0));
      for (const savior of saviors) {
        const pill = savior.hand.find((card) => card.id === 2);
        if (!pill) continue;
        const use = await this.ask(savior.id, {
          kind: 'use_card',
          data: { reason: `${seat.name} 濒死，是否使用【灵葫仙丹】令其恢复 2 点HP？`, cardUid: pill.uid },
          botFn: () => savior.id === seat.id || savior.faction === seat.faction,
        });
        if (!use || !savior.hand.includes(pill)) continue;
        savior.hand.splice(savior.hand.indexOf(pill), 1);
        this.log(`${savior.name} 使用【灵葫仙丹】响应濒死。`);
        const cancelled = await this._askCounter(savior, pill);
        this.discardPile.push(pill);
        if (cancelled) continue;
        seat.hp = Math.min(2, seat.maxHp);
        this.log(`【灵葫仙丹】生效，${seat.name} 恢复至 ${seat.hp} 点HP。`);
        return false;
      }

      const robe = seat.equips.find((equip) => equip.card.id === 10);
      if (robe) {
        const use = await this.ask(seat.id, {
          kind: 'use_equip_burst',
          data: { reason: '是否爆发【五彩霞衣】？丢弃后恢复 2 点HP。', cardUid: robe.card.uid },
          botFn: () => true,
        });
        if (use && seat.equips.includes(robe)) {
          this.unequip(seat, robe);
          this.discardPile.push(robe.card);
          seat.hp = Math.min(2, seat.maxHp);
          this.log(`${seat.name} 爆发【五彩霞衣】，恢复至 ${seat.hp} 点HP！`);
          return false;
        }
      }

      for (const owner of this.aliveSeats()) {
        const butterfly = owner.pets.find((pet) => pet.id === 'MO008');
        if (!butterfly) continue;
        const use = await this.ask(owner.id, {
          kind: 'use_pet_burst',
          data: { reason: `是否爆发【蝶精】令 ${seat.name} 满HP复活？`, petUid: butterfly.uid },
          botFn: () => owner.faction === seat.faction || owner.id === seat.id,
        });
        if (!use || !owner.pets.includes(butterfly)) continue;
        owner.pets.splice(owner.pets.indexOf(butterfly), 1);
        this.monsterDiscard.push(butterfly);
        seat.hp = seat.maxHp;
        this.log(`${owner.name} 爆发【蝶精】，${seat.name} 满HP复活！`);
        await this.checkTransform();
        return false;
      }

      const loverIds = seat.char?.loveById || [];
      const characterLovers = this.aliveSeats().filter((lover) => lover.id !== seat.id
        && loverIds.includes(lover.char?.id) && !lover._loveUsed);
      const monsterLovers = this.seats.flatMap((owner) => owner.pets
        .filter((pet) => loverIds.includes(pet.id) && !pet.loveUsed)
        .map((pet) => ({ owner, pet })));
      const choices = [
        ...characterLovers.map((lover) => ({ key: `seat:${lover.id}`, name: `${lover.name}（${lover.char.name}）` })),
        ...monsterLovers.map(({ owner, pet }) => ({ key: `pet:${pet.uid}`, name: `${owner.name}的宠物【${pet.name}】` })),
      ];
      if (choices.length) {
        const answer = await this.ask(seat.id, {
          kind: 'choose_lover',
          data: { reason: '选择一名尚未相救过的倾慕者', options: choices },
          validate: (value) => choices.some((choice) => choice.key === value),
          botFn: () => choices[0].key,
        });
        const character = characterLovers.find((lover) => `seat:${lover.id}` === answer);
        const monsterEntry = monsterLovers.find(({ pet }) => `pet:${pet.uid}` === answer);
        seat.hp = 1;
        if (character) {
          character._loveUsed = true;
          this.log(`${character.name}（${character.char.name}）作为倾慕者相救，必须扣减 1 点体力。`);
          await this.damage(character, 1, { kind: 'love', fromLove: true, noChase: true });
        } else if (monsterEntry) {
          monsterEntry.pet.loveUsed = true;
          this.log(`${monsterEntry.owner.name}的宠物【${monsterEntry.pet.name}】作为倾慕者相救，不扣减HP。`);
        }
        this.log(`${seat.name} 被倾慕者救回，体力回到 1。`);
        return false;
      }

      if (seat.char?.id === 'XJ204') {
        const demon = R.defs.characters.find((character) => character.id === 'XJ205');
        seat.char = demon;
        seat.maxHp = 5;
        seat.hp = 5;
        seat.sex = demon.sex;
        this.log(`【生命献祭】${seat.name} 变为【魔尊】，恢复至 5/5 HP，手牌、装备与宠物全部保留。`);
        return false;
      }

      seat.alive = false;
      this.log(`【${seat.char?.name}】${seat.name} 阵亡了……（宠物战力仍计入阵营）`);
      await this.checkTransform();
      await this.checkFactionWiped();
      return true;
    } finally {
      this._dyingSeats.delete(seat.id);
    }
  }

  // ================= 变身（赵灵儿 ↔ 梦蛇）=================
  async checkTransform() {
    for (const s of this.seats) {
      if (!s.alive || !s.char) continue;
      const enemyPets = this.aliveSeats(this.enemyFactionOf(s.faction))
        .reduce((n, x) => n + x.pets.length, 0);
      if (s.char.id === 'XJ102' && enemyPets >= 3) {
        s.char = R.defs.characters.find((c) => c.id === 'XJ103');
        this.log(`敌方宠物合计已达 ${enemyPets} 只，${s.name} 变身为【赵灵儿·梦蛇】！（HP不变，战力/命中提升，获得【女娲】）`);
        this.emit();
      } else if (s.char.id === 'XJ103' && enemyPets < 3) {
        s.char = R.defs.characters.find((c) => c.id === 'XJ102');
        this.log(`敌方宠物合计不足 3 只，${s.name} 还原为【赵灵儿】。（HP不变）`);
        this.emit();
      }
    }
  }

  async checkFactionWiped() {
    if (this.over) return;
    for (const k of ['a', 'b']) {
      if (this.aliveSeats(k).length === 0) {
        this._endGame(this.enemyFactionOf(k), 'faction_wiped');
        return;
      }
    }
  }

  // ================= 角色选择阶段 =================
  get pickStep() { return this.pick.steps[this.pick.stepIdx]; }

  actionPickSelect(playerId, key) {
    if (this.phase !== 'pick' || !this.pickStep) return { ok: false, error: '当前不在角色选择阶段。' };
    const seat = this.seatById(playerId);
    if (!seat || seat.faction !== this.pickStep.side) return { ok: false, error: '当前不是您阵营的选择回合。' };
    const item = this.pick.pool.find((entry) => entry.key === key && entry.owner === null);
    if (!item) return { ok: false, error: '该角色牌不可选。' };

    const step = this.pickStep;
    if (step.mode === 'discard') {
      item.owner = 'discard';
      this.log(`${this.factionName(seat.faction)}弃置了一张角色牌${item.open ? `【${item.card.name}】` : '（暗牌）'}。`);
    } else {
      item.owner = seat.faction;
      this.pick.factionRoles[seat.faction].push(item.card);
      this.log(`${this.factionName(seat.faction)}选择了${item.open ? `【${item.card.name}】` : '一张暗牌'}。`);
    }

    this.pick.stepTaken++;
    if (this.pick.stepTaken >= step.count) {
      this.pick.stepIdx++;
      this.pick.stepTaken = 0;
    }
    if (this.pick.stepIdx >= this.pick.steps.length) {
      this.phase = 'pick_order';
      this.emit();
      this._finishPick().catch((error) => console.error('[engine] finish pick failed:', error));
    } else {
      this.emit();
    }
    return { ok: true };
  }

  /** 选牌结束：分配角色，并由先手阵营决策人指定完整交替行动顺序。 */
  async _finishPick() {
    for (const faction of ['a', 'b']) {
      const members = this.seats.filter((seat) => seat.faction === faction);
      const roles = this.pick.factionRoles[faction];
      members.forEach((member, index) => {
        if (roles[index]) this._assignRole(member, roles[index]);
      });
      const spare = roles.slice(members.length);
      if (spare.length) this.log(`${this.factionName(faction)}的备用角色：${spare.map((role) => role.name).join('、')}（暂不上场）。`);
    }

    const decider = this.seats.find((seat) => seat.faction === this.firstFaction);
    const fallback = this._defaultAlternatingOrder();
    const order = await this.ask(decider.id, {
      kind: 'choose_turn_order',
      data: {
        reason: '请指定完整行动顺序：先手阵营开始，两个阵营必须严格交替。',
        candidates: this.seats.map((seat) => seat.id),
        firstFaction: this.firstFaction,
        count: this.seats.length,
      },
      validate: (value) => this._validTurnOrder(value),
      botFn: () => fallback,
    });
    this.turnOrder = this._validTurnOrder(order) ? order.slice() : fallback;
    this.turnIdx = 0;
    for (const seat of this.seats) this.drawCards(seat, HAND_START);
    this.log(`行动顺序：${this.turnOrder.map((id, index) => `${index + 1}号 ${this.seatById(id).name}`).join('；')}。`);
    this.log('角色选择结束，所有角色已就位，对局正式开始！');
    this.phase = 'event';
    await this._onTurnStart(this.currentSeat());
    this.log(`—— 轮到 ${this.currentSeat().name}（${this.currentSeat().char.name}）的回合 ——`);
    this.emit();
  }

  _assignRole(seat, role) {
    seat.char = role;
    seat.maxHp = role.hp;
    seat.hp = role.hp;
    seat.sex = role.sex;
  }

  // ================= 回合流程 =================
  _guard(playerId, phase) {
    if (this.over) return null;
    if (this.phase === 'pick') return null;
    const seat = this.seatById(playerId);
    if (!seat || !seat.alive) return null;
    if (this.currentSeat()?.id !== playerId) return null;
    if (this.phase !== phase) return null;
    return seat;
  }

  actionDrawEvent(playerId) {
    const seat = this._guard(playerId, 'event');
    if (!seat || this._eventBusy || this._busy) return { ok: false, error: '现在无法抽取事件牌。' };
    if (!this.eventDeck.length) {
      this.log('事件牌堆已空，跳过事件阶段。');
      this.phase = 'skill';
      this.emit();
      return { ok: true };
    }
    const evt = this.eventDeck.pop();
    this.log(`${seat.name} 抽取事件牌【${evt.name}】：${evt.desc}`);
    this._eventBusy = true;
    (async () => {
      await this._runLocked(async () => {
        try {
          await R.EVENT_EFFECTS[evt.id]?.(this, seat);
        } catch (e) { console.error('[engine] event effect failed:', e); }
        this.eventDiscard.push(evt);
        await this.checkFactionWiped();
        this._eventBusy = false;
        if (!this.over && this.phase === 'event') this.phase = 'skill';
        if (!this.over) this.emit();
      });
    })();
    return { ok: true };
  }

  actionSkipEvent(playerId) {
    const seat = this._guard(playerId, 'event');
    if (!seat || this._eventBusy || this._busy) return { ok: false, error: '现在不是你的事件阶段。' };
    this.log(`${seat.name} 跳过了事件阶段。`);
    this.phase = 'skill';
    this.emit();
    return { ok: true };
  }

  /** 技牌阶段：所有目标、区域和资源均在耗牌前校验。 */
  actionPlayCard(playerId, uid, targetId = null, targetKind = null) {
    const seat = this._guard(playerId, 'skill');
    if (!seat || this._busy) return { ok: false, error: '现在无法出牌。' };
    const card = seat.hand.find((item) => item.uid === uid);
    if (!card) return { ok: false, error: '手牌不存在。' };
    const validation = this._validateSkillPhaseCard(seat, card, targetId, targetKind);
    if (!validation.ok) return validation;

    this._runLocked(async () => {
      const index = seat.hand.findIndex((item) => item.uid === uid);
      if (index < 0) return;
      const target = targetId != null ? this.seatById(targetId) : null;
      if (card.type === CARD_TYPE.EQUIP) {
        seat.hand.splice(index, 1);
        this._equip(seat, card);
      } else {
        seat.hand.splice(index, 1);
        this.log(`${seat.name} 使用了【${card.name}】。`);
        const cancelled = await this._askCounter(seat, card);
        if (!cancelled) {
          const def = card.type === CARD_TYPE.SKILL ? R.SKILL_CARDS[card.id] : R.SPECIAL_CARDS[card.id];
          try { await def.run(this, { seat, target, targetKind }); }
          catch (error) { console.error('[engine] card effect failed:', error); }
        }
        this.discardPile.push(card);
      }
      await this.checkFactionWiped();
      if (!this.over) this.emit();
    });
    return { ok: true };
  }

  _validateSkillPhaseCard(seat, card, targetId, targetKind) {
    if (card.type === CARD_TYPE.WAR) return { ok: false, error: '战牌只能在战牌阶段使用。' };
    if (card.type === CARD_TYPE.EQUIP) return { ok: true };
    if (card.type === CARD_TYPE.SPECIAL) {
      return R.SPECIAL_CARDS[card.id] ? { ok: true } : { ok: false, error: '该特殊牌不能在此时使用。' };
    }
    if (card.type !== CARD_TYPE.SKILL || !R.SKILL_CARDS[card.id]) return { ok: false, error: '无法使用此牌。' };
    const target = this.seatById(targetId);
    if (!target?.alive) return { ok: false, error: '目标必须存在且存活。' };
    if (card.id === 16 && !target.hand.length) return { ok: false, error: '目标没有可抽取的手牌。' };
    if (card.id === 17) {
      if (!['hand', 'equip'].includes(targetKind)) return { ok: false, error: '必须指定手牌区或装备区。' };
      if (targetKind === 'hand' && !target.hand.length) return { ok: false, error: '目标手牌区为空。' };
      if (targetKind === 'equip' && !target.equips.length) return { ok: false, error: '目标装备区为空。' };
    }
    return { ok: true };
  }

  actionUseCharacterSkill(playerId, key, args = {}, pendingId = null) {
    if (this.pending?.seatId === playerId && ['character_skill', 'war_character_skill'].includes(this.pending.kind)) {
      return this.submitPending(playerId, pendingId, { ...(args || {}), key });
    }
    const seat = this._guard(playerId, 'skill');
    if (!seat || this._busy) return { ok: false, error: '现在无法发动角色技能。' };

    if (key === 'yuanling_heal' && seat.char?.id === 'XJ203') {
      const card = seat.hand.find((item) => item.uid === args.cardUid);
      const target = this.seatById(args.targetId);
      if (!card || card.type !== CARD_TYPE.SKILL) return { ok: false, error: '必须弃置一张有效技牌。' };
      if (!target?.alive) return { ok: false, error: '回复目标必须存在且存活。' };
      seat.hand.splice(seat.hand.indexOf(card), 1);
      this.discardPile.push(card);
      target.hp = Math.min(target.maxHp, target.hp + 2);
      this.log(`【元灵归心术】${seat.name} 弃置【${card.name}】，令 ${target.name} 回复2点HP。`);
      this.emit();
      return { ok: true };
    }

    if (key === 'kong_lash' && seat.char?.id === 'XJ204') {
      const target = this.seatById(args.targetId);
      if (seat.hp < 2) return { ok: false, error: 'HP不足，无法发动【辣手摧花】。' };
      if (!target?.alive || target.sex !== 2) return { ok: false, error: '目标必须是在场的女性角色。' };
      if (seat._lashTargets?.has(target.id)) return { ok: false, error: '本回合不能对同一角色重复发动。' };
      if (!seat._lashTargets) seat._lashTargets = new Set();
      seat._lashTargets.add(target.id);
      this._runLocked(async () => {
        this.log(`【辣手摧花】${seat.name} 与 ${target.name} 各HP-1。`);
        await this.damageBatch([{ seat, amount: 1 }, { seat: target, amount: 1 }], { source: seat, kind: 'skill' });
        this.emit();
      });
      return { ok: true };
    }
    return { ok: false, error: '该角色当前没有可发动的此项技能。' };
  }

  /** 阿奴·鬼灵精：技牌阶段把手牌交给他人 */
  actionGiveCard(playerId, uid, toId) {
    const seat = this._guard(playerId, 'skill');
    if (!seat) return { ok: false, error: '现在无法给牌。' };
    if (!this.hasSkill(seat, '鬼灵精')) return { ok: false, error: '您没有【鬼灵精】技能。' };
    const to = this.seatById(toId);
    const idx = seat.hand.findIndex((c) => c.uid === uid);
    if (!to || !to.alive || idx < 0) return { ok: false, error: '给牌目标或手牌无效。' };
    const [c] = seat.hand.splice(idx, 1);
    to.hand.push(c);
    this.log(`【鬼灵精】${seat.name} 将 1 张手牌交给了 ${to.name}。`);
    this.emit();
    return { ok: true };
  }

  _equip(seat, card) {
    const slot = card.eqvType === EQV_TYPE.WEAPON ? '武器' : '防具';
    if (card.eqvType === EQV_TYPE.WEAPON) {
      const weapons = seat.equips.filter((e) => e.card.eqvType === EQV_TYPE.WEAPON);
      const max = this.weaponSlots(seat);
      if (weapons.length >= max) {
        // 挤掉最旧的武器（双剑=2槽）
        const old = weapons[0];
        this.unequip(seat, old);
        this.discardPile.push(old.card);
        this.log(`${seat.name} 的旧武器【${old.card.name}】被替换进入弃牌堆。`);
      }
    } else {
      const armors = seat.equips.filter((e) => e.card.eqvType === EQV_TYPE.ARMOR);
      if (armors.length >= 1) {
        const old = armors[0];
        this.unequip(seat, old);
        this.discardPile.push(old.card);
        this.log(`${seat.name} 的旧防具【${old.card.name}】被替换进入弃牌堆。`);
      }
    }
    seat.equips.push({ card, uid: card.uid });
    this.log(`${seat.name} 装备了${slot}【${card.name}】（${card.desc}）。`);
  }

  /** 冰心诀连续反制链；苏媚可将任意特殊牌当作冰心诀。奇数次反制时原牌无效。 */
  async _askCounter(playSeat, card) {
    let currentSeat = playSeat;
    let currentCard = card;
    let counterCount = 0;
    while (!this.over) {
      let response = null;
      for (const seat of this._orderedAliveSeats()) {
        if (seat.id === currentSeat.id) continue;
        const options = seat.hand.filter((candidate) => candidate.id === 1
          || (seat.char?.id === 'XJ202' && candidate.type === CARD_TYPE.SPECIAL));
        if (!options.length) continue;
        const answer = await this.ask(seat.id, {
          kind: 'counter_card',
          data: {
            reason: `${currentSeat.name} 打出【${currentCard.name}】，是否反制？`,
            options: options.map((candidate) => ({
              uid: candidate.uid,
              name: candidate.name,
              as: candidate.id === 1 ? '冰心诀' : '拒绝',
            })),
            optional: true,
          },
          validate: (value) => value == null || options.some((candidate) => candidate.uid === value),
          botFn: () => (seat.faction !== currentSeat.faction && this.random() < 0.5 ? options[0].uid : null),
        });
        const responseCard = options.find((candidate) => candidate.uid === answer);
        if (!responseCard || !seat.hand.includes(responseCard)) continue;
        seat.hand.splice(seat.hand.indexOf(responseCard), 1);
        this.discardPile.push(responseCard);
        counterCount++;
        this.log(`${seat.name} ${responseCard.id === 1 ? '打出【冰心诀】' : `以【拒绝】将【${responseCard.name}】当作【冰心诀】`}，反制【${currentCard.name}】。`);
        response = { seat, card: responseCard };
        break;
      }
      if (!response) break;
      currentSeat = response.seat;
      currentCard = response.card;
    }
    return counterCount % 2 === 1;
  }

  _orderedAliveSeats() {
    const ordered = this.turnOrder.map((id) => this.seatById(id)).filter((seat) => seat?.alive);
    return ordered.length ? ordered : this.aliveSeats();
  }

  /** 技牌阶段 → 战斗阶段 */
  actionGoBattle(playerId) {
    const seat = this._guard(playerId, 'skill');
    if (!seat || this._busy) return { ok: false, error: '现在不在技牌阶段。' };
    this.phase = 'battle';
    this.emit();
    (async () => { await this._runLocked(() => this.runBattlePhase(seat)); })();
    return { ok: true };
  }

  // ================= 战斗阶段（8 子阶段）=================
  get b() { return this.battle; }

  async runBattlePhase(trigger, { skipConfirm = false, extraBattle = false } = {}) {
    if (this.over) return;
    const battle = {
      trigger,
      supporter: null,
      obstructer: null,
      monster: null,
      stage: skipConfirm ? 'roles' : 'confirm',
      skipped: false,
      escaped: false,
      monsterClaimed: false,
      supporterHit: false,
      obstructerHit: false,
      supporterBonus: 0,
      characterPowerBonus: {},
      warBonus: { a: 0, b: 0 },
      warPersonal: {},
      warDouble: {},
      skillUses: {},
      rolls: {},
      actedWar: [],
      firstWarSide: null,
      winnerSide: null,
      extraBattle,
    };
    this.battle = battle;
    this.emit();

    // —— ① 开始确认阶段：第二战复用同一流程，但跳过重复确认。
    const enemySide = this.enemyFactionOf(trigger.faction);
    if (!skipConfirm) {
      const triggerDecider = this.factionDecider(trigger.faction);
      const enemyDecider = this.factionDecider(enemySide);
      const openTrigger = triggerDecider ? await this.ask(triggerDecider.id, {
        kind: 'battle_confirm',
        data: { reason: '是否对即将翻开的怪兽开启战斗？（不开战则怪兽弃置，触发者本回合只补1张牌）' },
        botFn: () => this.random() < 0.85,
      }) : false;
      const openEnemy = enemyDecider ? await this.ask(enemyDecider.id, {
        kind: 'battle_confirm',
        data: { reason: '对方触发了战斗，是否同意开战？（不开战则怪兽弃置，对方补牌减为1张）' },
        botFn: () => this.random() < 0.7,
      }) : false;
      if (!openTrigger || !openEnemy) {
        this.log(`${!openTrigger ? this.factionName(trigger.faction) : this.factionName(enemySide)}选择不开战，怪兽牌堆顶的怪兽直接进入弃牌堆。`);
        const monster = this.monsterDeck.pop();
        if (monster) this.monsterDiscard.push(monster);
        battle.skipped = true;
        battle.stage = 'done';
        this.battle = null;
        trigger._battleSkipped = true;
        this.phase = 'draw';
        this.log(`${trigger.name} 本回合跳过了战斗，补牌阶段只能补 1 张牌。`);
        this.emit();
        await this._settleIfMonsterEmpty();
        return;
      }
    }

    // —— ② 指定参战者阶段：触发方选支援者（己方队友），对方选妨碍者
    battle.stage = 'roles';
    this.emit();
    const allies = this.aliveSeats(trigger.faction).filter((s) => s.id !== trigger.id);
    if (allies.length) {
      const sid = await this.ask(trigger.id, {
        kind: 'pick_supporter',
        data: { reason: '指定一名队友作为支援者参战（战力计入我方）', candidates: allies.map((s) => s.id) },
        botFn: () => allies.sort((x, y) => this.effPower(y) - this.effPower(x))[0].id,
      });
      battle.supporter = this.seatById(sid) || null;
    }
    if (battle.supporter) this.log(`支援者：${battle.supporter.name}（${battle.supporter.char.name}）`);

    const enemies = this.aliveSeats(enemySide);
    if (enemies.length) {
      const decider = this.factionDecider(enemySide);
      const oid = await this.ask(decider?.id || enemies[0].id, {
        kind: 'pick_obstructer',
        data: { reason: '指定一名本方玩家作为妨碍者参战（战力计入怪物方）', candidates: enemies.map((s) => s.id) },
        botFn: () => enemies.sort((x, y) => this.effPower(y) - this.effPower(x))[0].id,
      });
      battle.obstructer = this.seatById(oid) || null;
    }
    if (battle.obstructer) this.log(`妨碍者：${battle.obstructer.name}（${battle.obstructer.char.name}）`);

    // —— ③ 翻取阶段
    battle.stage = 'flip';
    if (!this.monsterDeck.length) {
      this.log('怪兽牌堆已空，无法翻取，战斗结束。');
      battle.stage = 'done';
      this.battle = null;
      this.phase = 'draw';
      this.emit();
      await this._settleIfMonsterEmpty();
      return;
    }
    battle.monster = this.monsterDeck.pop();
    let mon = battle.monster;
    this.lastMonster = { name: mon.name, power: mon.power, element: mon.elements.name, by: trigger.name };
    this.log(`翻取阶段：翻开了怪兽【${mon.name}】（${mon.elements.name}属性·战力${mon.power}·闪避${mon.range}·${mon.type === 3 ? 'BOSS' : mon.type === 2 ? '强敌' : '小怪'}）！`);
    this.emit();

    await this._runBattleStartSkills(battle);
    mon = battle.monster;
    for (const seat of this.aliveSeats()) {
      const skills = R.skillsOf(seat);
      if (skills.onBattleFlip && this.isCombatant(seat, battle)) {
        try { await skills.onBattleFlip(this, seat, battle); } catch (error) { console.error(error); }
      }
    }

    // —— ④ 怪物出场阶段
    battle.stage = 'appear';
    this.emit();
    try { await R.MONSTER_EFFECTS[mon.id]?.appear?.(this, { battle, trigger, monster: mon }); }
    catch (e) { console.error('[engine] appear failed:', e); }
    if (this.over) return;
    if (battle.escaped) return await this._finishBattle(battle);

    // —— ⑤ 初始战力 & 命中结算阶段
    battle.stage = 'hit';
    this.emit();
    battle.supporterHit = false;
    if (battle.supporter) {
      let hit = this.effRange(battle.supporter);
      const sk = R.skillsOf(battle.supporter);
      if (sk.supportHitBonus) hit += sk.supportHitBonus(this, battle.supporter, battle);
      battle.supporterHit = hit >= mon.range;
      this.log(`命中结算：支援者 ${battle.supporter.name} 命中 ${hit} VS 闪避 ${mon.range} —— ${battle.supporterHit ? '命中成功' : '命中失败（战力不计入）'}。`);
    }
    battle.obstructerHit = false;
    if (battle.obstructer) {
      const hit = this.effRange(battle.obstructer);
      battle.obstructerHit = hit >= mon.range;
      this.log(`命中结算：妨碍者 ${battle.obstructer.name} 命中 ${hit} VS 闪避 ${mon.range} —— ${battle.obstructerHit ? '命中成功（战力计入怪物方）' : '命中失败（战力不计入）'}。`);
    }
    this.emit();

    // —— ⑥ 战牌阶段
    battle.stage = 'cards';
    const a0 = this.battlePower(battle, 'a');
    const b0 = this.battlePower(battle, 'b');
    battle.firstWarSide = a0 < b0 ? trigger.faction : this.enemyFactionOf(trigger.faction); // 战力低者先出，相等则怪物方先出
    this.log(`初始战力：${this.factionName(trigger.faction)}（触发方）${a0} VS 怪物方 ${b0}。战牌阶段由${this.factionName(battle.firstWarSide)}先出。`);
    battle.warTurnSide = battle.firstWarSide;
    battle.actedWar = [];
    this.emit();
    await this._warCardsLoop(battle);
    if (battle.escaped) return await this._finishBattle(battle);

    // —— ⑦ 战力结算阶段
    battle.stage = 'resolve';
    const af = this.battlePower(battle, 'a');
    const bf = this.battlePower(battle, 'b');
    battle.winnerSide = af >= bf ? trigger.faction : this.enemyFactionOf(trigger.faction);
    this.log(`战力结算：${this.factionName(trigger.faction)}合计 ${af} VS 怪物方合计 ${bf} —— ${battle.winnerSide === trigger.faction ? '触发方战斗胜利！' : '怪物方获胜！'}`);
    this.emit();

    // —— ⑧ 战斗结算阶段
    battle.stage = 'settle';
    this.emit();
    const ctx = { battle, trigger, monster: mon };
    if (battle.winnerSide === trigger.faction) {
      try { await R.MONSTER_EFFECTS[mon.id]?.win?.(this, ctx); } catch (error) { console.error(error); }
      if (!battle.escaped && !this.over) await this._gainPet(trigger, mon);
    } else {
      try { await R.MONSTER_EFFECTS[mon.id]?.lose?.(this, ctx); } catch (error) { console.error(error); }
    }
    if (this.over) return;

    for (const seat of this.aliveSeats()) {
      const skills = R.skillsOf(seat);
      if (skills.onBattleEnd) {
        try { await skills.onBattleEnd(this, seat, battle); } catch (error) { console.error(error); }
      }
    }
    if (battle.winnerSide !== trigger.faction && !battle.monsterClaimed) {
      this.monsterDiscard.push(mon);
    }
    if (this.over) return;

    await this._finishBattle(battle);
  }

  async _runBattleStartSkills(battle) {
    const trigger = battle.trigger;
    if (trigger.char?.id === 'XJ202' && !trigger._cunningUsedThisTurn) {
      let answer = { key: 'pass' };
      if (this.monsterDeck.length) {
        answer = await this.ask(trigger.id, {
          kind: 'character_skill',
          data: {
            reason: '【狡猾】是否弃置当前怪兽并重新翻取？若不使用，本场自身战力+1。',
            options: [{ key: 'sumei_cunning' }, { key: 'pass' }],
          },
          validate: (value) => value && ['sumei_cunning', 'pass'].includes(value.key),
          botFn: () => ({ key: 'pass' }),
        });
      }
      if (answer?.key === 'sumei_cunning' && this.monsterDeck.length) {
        trigger._cunningUsedThisTurn = true;
        this.monsterDiscard.push(battle.monster);
        battle.monster = this.monsterDeck.pop();
        const monster = battle.monster;
        this.lastMonster = { name: monster.name, power: monster.power, element: monster.elements.name, by: trigger.name };
        this.log(`【狡猾】${trigger.name} 弃置原怪兽，重新翻开【${monster.name}】。`);
      } else {
        battle.characterPowerBonus[trigger.id] = (battle.characterPowerBonus[trigger.id] || 0) + 1;
        this.log(`【狡猾】${trigger.name} 不重新翻取，本场自身战力+1。`);
      }
    }

    for (const seat of [battle.trigger, battle.supporter, battle.obstructer].filter((item) => item?.alive && item.char?.id === 'XJ201')) {
      let rolling = true;
      while (rolling && seat.alive) {
        const raw = 1 + Math.floor(this.random() * 6);
        const value = raw === 6 ? 1 : raw;
        battle.rolls[seat.id] = { raw, value };
        battle.characterPowerBonus[seat.id] = value;
        this.log(`【发挥不稳定】${seat.name} 掷出 ${raw} 点，本场战力增加 ${value}。`);
        const options = [{ key: 'pass' }];
        if (seat.hand.length) options.unshift({ key: 'wang_reroll_card' });
        if (seat.hp > 0) options.unshift({ key: 'wang_reroll_hp' });
        const answer = await this.ask(seat.id, {
          kind: 'character_skill',
          data: {
            reason: '【不屈不饶】是否支付一张手牌或1点HP重投？',
            options,
            cards: seat.hand.map((card) => ({ uid: card.uid, name: card.name, type: card.type })),
          },
          validate: (value) => {
            if (!value || !options.some((option) => option.key === value.key)) return false;
            return value.key !== 'wang_reroll_card' || seat.hand.some((card) => card.uid === value.cardUid);
          },
          botFn: () => ({ key: 'pass' }),
        });
        if (answer.key === 'wang_reroll_card') {
          const card = seat.hand.find((item) => item.uid === answer.cardUid);
          if (!card) break;
          seat.hand.splice(seat.hand.indexOf(card), 1);
          this.discardPile.push(card);
          this.log(`【不屈不饶】${seat.name} 弃置【${card.name}】重投。`);
        } else if (answer.key === 'wang_reroll_hp') {
          await this.damage(seat, 1, { source: seat, kind: 'cost', bypassHidden: true });
          if (!seat.alive || seat.hp <= 0) break;
          this.log(`【不屈不饶】${seat.name} 支付1点HP重投（隐蛊无效）。`);
        } else {
          rolling = false;
        }
      }
    }
  }

  /** sideKey: a=触发方，b=怪物方；同名角色实例的在场加成分别叠加。 */
  battlePower(battle, sideKey) {
    if (!battle?.trigger) return 0;
    const triggerFaction = battle.trigger.faction;
    const faction = sideKey === 'a' ? triggerFaction : this.enemyFactionOf(triggerFaction);
    const rolePower = (seat) => {
      let value = this.effPower(seat);
      value += battle.characterPowerBonus?.[seat.id] || 0;
      value += battle.warPersonal?.[seat.id] || 0;
      if (seat.char?.id === 'XJ107' && this.isCombatant(seat, battle)
        && [4, 5].includes(battle.monster?.elements?.id)) value += 2;
      return value;
    };

    let total = battle.warBonus?.[faction] || 0;
    if (sideKey === 'a') {
      total += rolePower(battle.trigger);
      if (battle.supporter?.alive && battle.supporterHit) total += rolePower(battle.supporter) + (battle.supporterBonus || 0);
    } else {
      total += battle.monster?.power || 0;
      if (battle.obstructer?.alive && battle.obstructerHit) total += rolePower(battle.obstructer);
    }

    total += this.aliveSeats(faction).filter((seat) => seat.char?.id === 'XJ103').length * 2;
    const shenCount = this.aliveSeats(faction).filter((seat) => seat.char?.id === 'XJ203').length;
    const missingOrMissed = sideKey === 'a'
      ? !battle.supporter || !battle.supporterHit
      : !battle.obstructer || !battle.obstructerHit;
    if (missingOrMissed) total += shenCount * 3;
    return total;
  }

  async _warCardsLoop(battle) {
    while (!battle.escaped && !this.over) {
      const side = battle.warTurnSide;
      const remain = this.aliveSeats(side).map((seat) => seat.id).filter((id) => !battle.actedWar.includes(id));
      if (!remain.length) {
        const other = this.enemyFactionOf(side);
        const remainOther = this.aliveSeats(other).map((seat) => seat.id).filter((id) => !battle.actedWar.includes(id));
        if (!remainOther.length) break;
        battle.warTurnSide = other;
        continue;
      }
      const decider = this.factionDecider(side);
      const playerId = await this.ask(decider.id, {
        kind: 'war_pick_player',
        data: { reason: `战牌阶段：为${this.factionName(side)}指定一名玩家行动`, candidates: remain },
        botFn: () => this._botWarPick(battle, remain),
      });
      const seat = this.seatById(playerId);
      if (!seat?.alive || seat.faction !== side || battle.actedWar.includes(playerId)) continue;
      battle.actedWar.push(playerId);

      const blockWarCard = await this._warSkillWindow(seat, battle);
      if (this.over || battle.escaped) break;
      const legal = blockWarCard ? [] : seat.hand
        .filter((card) => card.type === CARD_TYPE.WAR && this._warCardLegal(seat, card, battle))
        .map((card) => ({ uid: card.uid, name: card.name, desc: card.desc, needTargetSide: !!R.WAR_CARDS[card.id]?.needTargetSide }));
      const answer = await this.ask(seat.id, {
        kind: 'war_play_card',
        data: { reason: blockWarCard ? '本场已发动【召唤水魔兽】，不可再使用战牌。' : '选择要打出的战牌（可不出）', legal },
        botFn: () => (legal.length ? { uid: legal[0].uid, targetSide: seat.faction } : { pass: true }),
      });

      if (answer?.uid && !answer.pass) {
        const index = seat.hand.findIndex((card) => card.uid === answer.uid);
        const card = seat.hand[index];
        if (index >= 0 && this._warCardLegal(seat, card, battle)) {
          seat.hand.splice(index, 1);
          this.log(`${seat.name} 打出战牌【${card.name}】！`);
          const cancelled = await this._askCounter(seat, card);
          if (!cancelled) {
            const def = R.WAR_CARDS[card.id];
            const targetSide = ['a', 'b'].includes(answer.targetSide) ? answer.targetSide : seat.faction;
            try { await def.run(this, { seat, battle, targetSide }); } catch (error) { console.error(error); }
          }
          this.discardPile.push(card);
        }
      } else {
        this.log(`${seat.name} 选择不出战牌。`);
      }
      battle.warTurnSide = this.enemyFactionOf(side);
      this.emit();
    }
  }

  async _warSkillWindow(seat, battle) {
    let blockWarCard = false;
    while (seat.alive && !this.over) {
      const options = [{ key: 'pass' }];
      if (seat.char?.id === 'XJ107' && this.isCombatant(seat, battle)
        && !battle.skillUses[`bayue_summon:${seat.id}`] && seat.hand.length >= 2) {
        options.unshift({ key: 'bayue_summon' });
      }
      const hit = seat.id === battle.trigger.id
        || (seat.id === battle.supporter?.id && battle.supporterHit)
        || (seat.id === battle.obstructer?.id && battle.obstructerHit);
      if (seat.char?.id === 'XJ302' && this.isCombatant(seat, battle) && hit
        && seat.hand.some((card) => card.type !== CARD_TYPE.WAR)) options.unshift({ key: 'tang_combo' });
      if (seat.char?.id === 'XJ302' && this.isCombatant(seat, battle)
        && !battle.skillUses[`tang_compete:${seat.id}`]) options.unshift({ key: 'tang_compete' });
      if (options.length === 1) return blockWarCard;

      const answer = await this.ask(seat.id, {
        kind: 'war_character_skill',
        data: {
          reason: '可发动战牌阶段角色技能，或选择完成。',
          options,
          cards: seat.hand.map((card) => ({ uid: card.uid, name: card.name, type: card.type })),
        },
        validate: (value) => this._validateWarSkillAnswer(seat, battle, options, value),
        botFn: () => ({ key: 'pass' }),
      });
      if (answer.key === 'pass') return blockWarCard;
      const cards = (answer.cardUids || []).map((uid) => seat.hand.find((card) => card.uid === uid)).filter(Boolean);
      if (answer.key === 'bayue_summon') {
        for (const card of cards) {
          seat.hand.splice(seat.hand.indexOf(card), 1);
          this.discardPile.push(card);
        }
        battle.skillUses[`bayue_summon:${seat.id}`] = true;
        battle.warBonus[seat.faction] += 5;
        blockWarCard = true;
        this.log(`【召唤水魔兽】${seat.name} 弃置2张手牌，本方战力+5，且本场不可使用战牌。`);
        return true;
      }
      if (answer.key === 'tang_combo') {
        for (const card of cards) {
          seat.hand.splice(seat.hand.indexOf(card), 1);
          this.discardPile.push(card);
        }
        battle.warPersonal[seat.id] = (battle.warPersonal[seat.id] || 0) + cards.length * 2;
        this.log(`【连击】${seat.name} 弃置${cards.length}张非战牌，本场自身战力+${cards.length * 2}。`);
      }
      if (answer.key === 'tang_compete') {
        battle.skillUses[`tang_compete:${seat.id}`] = true;
        this.log(`【好胜】${seat.name} 支付2点HP（隐蛊无效）并补2张牌。`);
        await this.damage(seat, 2, { source: seat, kind: 'cost', bypassHidden: true });
        if (seat.alive) this.drawCards(seat, 2);
      }
    }
    return blockWarCard;
  }

  _validateWarSkillAnswer(seat, battle, options, answer) {
    if (!answer || !options.some((option) => option.key === answer.key)) return false;
    if (answer.key === 'pass' || answer.key === 'tang_compete') return true;
    if (!Array.isArray(answer.cardUids) || new Set(answer.cardUids).size !== answer.cardUids.length) return false;
    const cards = answer.cardUids.map((uid) => seat.hand.find((card) => card.uid === uid));
    if (cards.some((card) => !card)) return false;
    if (answer.key === 'bayue_summon') return cards.length === 2;
    return answer.key === 'tang_combo' && cards.length >= 1 && cards.every((card) => card.type !== CARD_TYPE.WAR);
  }

  _botWarPick(battle, remain) {
    // 优先指定手里有合法战牌的玩家（决策人自己优先）
    for (const pid of remain) {
      const s = this.seatById(pid);
      if (s.hand.some((c) => c.type === CARD_TYPE.WAR && this._warCardLegal(s, c, battle))) return pid;
    }
    return remain[0];
  }

  _warCardLegal(seat, card, battle) {
    const def = R.WAR_CARDS[card.id];
    if (!def) return false;
    if (def.needCombatant || def.needCombatantHit) {
      const combatant = this.isCombatant(seat, battle);
      if (!combatant) return false;
      if (def.needCombatantHit) {
        const hitOk = seat.id === battle.trigger.id
          || (seat.id === battle.supporter?.id && battle.supporterHit)
          || (seat.id === battle.obstructer?.id && battle.obstructerHit);
        if (!hitOk) return false;
      }
    }
    return true;
  }

  /** 收为宠物：同五行冲突时由获得者选择保留哪一个。 */
  async _gainPet(seat, monster) {
    const duplicate = seat.pets.find((pet) => pet.elements.id === monster.elements.id);
    if (duplicate) {
      const kept = await this.askChoosePet(seat, [duplicate, monster], {
        reason: `已有${monster.elements.name}属性宠物，只能保留一只`,
      });
      const discarded = kept?.uid === monster.uid ? duplicate : monster;
      this.monsterDiscard.push(discarded);
      if (discarded.uid === monster.uid) {
        this.log(`${seat.name} 选择保留【${duplicate.name}】，新获得的【${monster.name}】进入怪兽弃牌堆。`);
        return;
      }
      seat.pets.splice(seat.pets.indexOf(duplicate), 1);
    }
    seat.pets.push(monster);
    if (this.battle?.monster?.uid === monster.uid) this.battle.monsterClaimed = true;
    const bonus = R.PET_BONUS[monster.id];
    this.log(`${seat.name} 将【${monster.name}】收为宠物！${bonus ? `宠物效果：${monster.pets}` : ''}（基础阵营分 +${monster.power}）`);

    for (const purple of this.aliveSeats(seat.faction).filter((ally) => ally.char?.id === 'XJ305')) {
      const target = await this.askChoosePlayer(purple, this.aliveSeats(), { reason: '【关爱】我方得到宠物，请指定一人补2张手牌' });
      if (!target) continue;
      this.drawCards(target, 2);
      this.log(`【关爱】${purple.name} 指定 ${target.name} 补2张手牌。`);
    }
  }

  async _finishBattle(battle) {
    battle.trigger._battleCount = (battle.trigger._battleCount || 0) + 1;
    if (battle.escaped && battle.monster && !battle.monsterClaimed) {
      this.monsterDiscard.push(battle.monster);
      battle.monsterClaimed = true;
      this.log(`【${battle.monster.name}】因【金蝉脱壳】进入怪兽弃牌堆。`);
    }
    this.battle = null;
    this.emit();
    if (this.over) return;
    await this.checkTransform();
    await this.checkFactionWiped();
    if (this.over) return;
    await this._settleIfMonsterEmpty();
    if (this.over) return;

    const seat = this.currentSeat();
    if (seat && this.hasSkill(seat, '醉仙望月步') && !battle.extraBattle && !battle.skipped && this.monsterDeck.length) {
      const again = await this.askYesNo(seat, { reason: '【醉仙望月步】是否再触发一场战斗？', defaultValue: false });
      if (again) {
        this.log(`【醉仙望月步】${seat.name} 再战一场！`);
        await this.runBattlePhase(seat, { skipConfirm: true, extraBattle: true });
        return;
      }
    }
    this.phase = 'draw';
    this.emit();
  }

  async _settleIfMonsterEmpty() {
    if (this.over) return;
    if (this.monsterDeck.length) return;
    // 最后一张怪兽战斗结算完毕，进入终局结算
    const sa = this.factionScore('a');
    const sb = this.factionScore('b');
    this.log(`所有怪兽均已翻完，进行终局结算：蜀山派 ${sa} 分 VS 拜月教 ${sb} 分。`);
    if (sa === sb) this._endGame(null, 'monsters_clear');
    else this._endGame(sa > sb ? 'a' : 'b', 'monsters_clear');
  }

  // ================= 补牌阶段 =================
  actionFinishTurn(playerId) {
    const seat = this._guard(playerId, 'draw');
    if (!seat || this._busy) return { ok: false, error: '现在不能结束回合。' };
    (async () => {
      await this._runLocked(async () => {
        await this.drawPhase(seat);
        if (this.over) return;
        await this._advanceTurn();
      });
    })();
    return { ok: true };
  }

  async drawPhase(seat) {
    // 阿奴·万蛊蚀天：补牌阶段开始时无手牌
    if (this.hasSkill(seat, '万蛊蚀天') && !seat.hand.length) {
      this.log(`【万蛊蚀天】${seat.name} 补牌阶段开始时没有手牌！我方全体补 1 张牌，随后其他所有角色 HP-1。`);
      for (const ally of this.aliveSeats(seat.faction)) this.drawCards(ally, 1);
      const others = this.aliveSeats().filter((other) => other.id !== seat.id);
      await this.damageBatch(others.map((other) => ({ seat: other, amount: 1 })), { source: seat, kind: 'skill' });
      if (this.over) return;
    }

    let n = DRAW_PER_TURN;
    if (this._lastBattleSkipped(seat)) n = 1;                       // 跳过战斗只补1
    if (this.hasSkill(seat, '醉仙望月步') && this._battlesThisTurn(seat) === 1) n += 1; // 只打了一场：多补1
    for (const pet of seat.pets) n += R.PET_BONUS[pet.id]?.drawExtra || 0; // 赤鬼王宠物+1
    if (n > 0) {
      const got = this.drawCards(seat, n);
      this.log(`补牌阶段：${seat.name} 补了 ${got} 张牌。`);
    }
    const excess = seat.hand.length - HAND_KEEP;
    if (excess > 0) {
      const chosen = await this.askChooseCards(seat, seat.hand.slice(), excess, {
        reason: `回合结束，请选择 ${excess} 张手牌弃置至刚好 ${HAND_KEEP} 张`,
      });
      for (const card of chosen) {
        const index = seat.hand.findIndex((item) => item.uid === card.uid);
        if (index < 0) continue;
        seat.hand.splice(index, 1);
        this.discardPile.push(card);
        this.log(`${seat.name} 回合末弃置【${card.name}】。`);
      }
    }
    this.emit();
  }

  _lastBattleSkipped(seat) { return !!seat._battleSkipped; }
  _battlesThisTurn(seat) { return seat._battleCount || 0; }

  async _onTurnStart(seat) {
    if (!seat) return;
    seat._battleSkipped = false;
    seat._battleCount = 0;
    seat._cunningUsedThisTurn = false;
    seat._lashTargets = new Set();
    if (seat.char?.id === 'XJ205') {
      const drawn = this.drawCards(seat, 1);
      this.log(`【蓄势待发】${seat.name} 回合开始补充 ${drawn} 张手牌。`);
    }
  }

  async _advanceTurn() {
    let checked = 0;
    while (checked++ < this.turnOrder.length * 2) {
      this.turnIdx = (this.turnIdx + 1) % this.turnOrder.length;
      const candidate = this.currentSeat();
      if (!candidate?.alive) continue;
      if (candidate.tapped) {
        candidate.tapped = false;
        this.log(`${candidate.name} 的角色处于横置状态，跳过本回合并重置。`);
        continue;
      }
      await this._onTurnStart(candidate);
      this.phase = 'event';
      this.log(`—— 轮到 ${candidate.name}（${candidate.char?.name}）的回合 ——`);
      this.emit();
      return;
    }
    await this.checkFactionWiped();
  }

  _endGame(winnerFaction, reason) {
    if (this.over) return;
    this.over = true;
    this.phase = 'over';
    this.result = {
      winnerFaction, reason,
      scores: { a: this.factionScore('a'), b: this.factionScore('b') },
      dice: this.dice, endedAt: new Date().toISOString(),
    };
    this.log(winnerFaction
      ? `=== 游戏结束：${this.factionName(winnerFaction)}获胜！ ===`
      : '=== 游戏结束：平局 ===');
    this.emit();
    if (this.onEnd) {
      try {
        this.onEnd({
          mode: this.mode, size: this.size,
          winner_faction: winnerFaction, ended_reason: reason,
          detail: JSON.stringify(this.seats.map((s) => ({
            name: s.name, faction: s.faction, char: s.char?.name || '(未选)',
            score: this.petScore(s), pets: s.pets.length,
            hp: Math.max(s.hp, 0), alive: s.alive, isBot: s.isBot,
          }))),
          started_at: this.startedAt,
        });
      } catch (e) { console.error('[engine] persist match failed:', e.message); }
    }
    this._botToken++;
  }

  // ================= 互斥锁 =================
  async _runLocked(fn) {
    while (this._busy) await new Promise((r) => setTimeout(r, 60));
    this._busy = true;
    try { await fn(); } finally { this._busy = false; }
  }

  // ================= Bot / 托管 =================
  needAutomation() {
    if (this.over) return false;
    if (this.pending) {
      const s = this.seatById(this.pending.seatId);
      return !!s && (s.isBot || s.offline);
    }
    if (this.phase === 'pick') {
      // 角色选择阶段：当前行动阵营存在 bot/托管玩家才需要自动推进
      const step = this.pickStep;
      if (!step) return false;
      return this.seats.some((s) => (s.isBot || s.offline) && s.faction === step.side);
    }
    const cur = this.currentSeat();
    return !!cur && (cur.isBot || cur.offline);
  }

  cancelAutomation() { this._botToken++; }

  async runBotLoop(token) {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let guard = 0;
    while (!this.over && token === this._botToken && guard++ < 500) {
      await delay(600);
      if (token !== this._botToken || this.over) return;
      if (this._busy) continue;
      if (this.pending) continue; // ask() 内部已对 bot 定时自动响应
      if (this.phase === 'pick') { this._botPick(); continue; }
      const seat = this.currentSeat();
      if (!(seat && (seat.isBot || seat.offline))) return;
      if (!seat.char) continue;
      switch (this.phase) {
        case 'event':
          this.eventDeck.length && this.random() < 0.6 ? this.actionDrawEvent(seat.id) : this.actionSkipEvent(seat.id);
          break;
        case 'skill': {
          const equips = seat.hand.filter((c) => c.type === CARD_TYPE.EQUIP);
          if (equips.length) { this.actionPlayCard(seat.id, equips[0].uid); break; }
          const skills = seat.hand.filter((c) => c.type === CARD_TYPE.SKILL);
          const usable = skills.filter((c) => {
            const def = R.SKILL_CARDS[c.id];
            if (!def) return false;
            if (def.needTarget) return this.aliveSeats().some((t) => t.id !== seat.id);
            return true;
          });
          if (usable.length && this.random() < 0.7) {
            const card = usable[0];
            const def = R.SKILL_CARDS[card.id];
            const target = def.needTarget ? this.aliveSeats().find((t) => t.id !== seat.id) : null;
            this.actionPlayCard(seat.id, card.uid, target?.id || null);
          } else {
            this.actionGoBattle(seat.id);
          }
          break;
        }
        case 'draw':
          this.actionFinishTurn(seat.id);
          break;
        default:
          return;
      }
      await delay(350);
    }
  }

  _botPick() {
    // 当前选择回合所属阵营的第一个 bot 提交（明牌优先，暗牌随机）
    const step = this.pickStep;
    if (!step) return;
    const bot = this.seats.find((s) => s.isBot && s.faction === step.side) ||
      this.seats.find((s) => s.offline && s.faction === step.side);
    if (!bot) return;
    const avail = this.pick.pool.filter((p) => p.owner === null);
    if (!avail.length) return;
    const opens = avail.filter((p) => p.open);
    const pool = (step.mode === 'choose' && opens.length) ? opens : avail;
    // 弃置时弃战力最低的明牌或随机暗牌；选择时选战力最高的明牌
    let pick;
    if (step.mode === 'discard') {
      pick = pool.sort((x, y) => x.card.power - y.card.power)[0];
    } else {
      pick = pool.sort((x, y) => y.card.power - x.card.power)[0];
    }
    this.actionPickSelect(bot.id, pick.key);
  }

  markOffline(playerId, offline) {
    const seat = this.seatById(playerId);
    if (!seat || seat.isBot) return;
    seat.offline = offline;
    this.log(offline ? `${seat.name} 暂时离开了座位（由系统代管）。` : `${seat.name} 回到了座位。`);
  }

  // ================= 视图 =================
  viewFor(viewerId) {
    const viewerSeat = this.seatById(viewerId);
    const b = this.battle;
    return {
      kind: 'xianjian2',
      roomId: this.roomId,
      mode: this.mode,
      size: this.size,
      phase: this.over ? 'over' : this.phase,
      over: this.over,
      result: this.result,
      factions: config.FACTIONS,
      handKeep: HAND_KEEP,
      drawPerTurn: DRAW_PER_TURN,
      scores: { a: this.factionScore('a'), b: this.factionScore('b') },
      deckLeft: { monster: this.monsterDeck.length, event: this.eventDeck.length, hand: this.skillDeck.length + this.discardPile.length },
      lastMonster: this.lastMonster,
      lastDamage: this.lastDamage || null,
      turnPlayerId: this.over || ['pick', 'pick_order'].includes(this.phase) ? null : this.currentSeat()?.id,
      turnOrder: this.turnOrder.slice(),
      dice: this.dice,
      firstFaction: this.firstFaction,
      availableSkills: this._availableSkills(viewerSeat),

      // 角色选择阶段
      pick: ['pick', 'pick_order'].includes(this.phase) ? this._pickView(viewerSeat) : null,

      // 战斗上下文（公开信息）
      battle: b ? {
        stage: b.stage,
        trigger: { id: b.trigger.id, name: b.trigger.name, faction: b.trigger.faction },
        supporter: b.supporter ? { id: b.supporter.id, name: b.supporter.name, faction: b.supporter.faction } : null,
        obstructer: b.obstructer ? { id: b.obstructer.id, name: b.obstructer.name, faction: b.obstructer.faction } : null,
        monster: b.monster ? {
          uid: b.monster.uid, name: b.monster.name, power: b.monster.power, range: b.monster.range,
          element: b.monster.elements.name, type: b.monster.type,
          appear: b.monster.appear, win: b.monster.win, lose: b.monster.lose,
        } : null,
        supporterHit: b.supporterHit,
        obstructerHit: b.obstructerHit,
        supporterBonus: b.supporterBonus,
        characterPowerBonus: { ...b.characterPowerBonus },
        warBonus: { ...b.warBonus },
        warPersonal: { ...b.warPersonal },
        skillUses: { ...b.skillUses },
        rolls: { ...b.rolls },
        warTurnSide: b.warTurnSide || null,
        actedWar: b.actedWar.slice(),
        powerA: this.battlePower(b, 'a'),
        powerB: this.battlePower(b, 'b'),
        escaped: b.escaped,
        winnerSide: b.winnerSide,
        extraBattle: b.extraBattle,
      } : null,

      // pending 询问（仅目标玩家可见）
      pending: this.pending && this.pending.seatId === viewerId ? {
        id: this.pending.id,
        kind: this.pending.kind,
        data: this._pendingViewData(),
        deadline: this.pending.deadline,
      } : (this.pending ? { kind: 'waiting', data: { seatName: this.seatById(this.pending.seatId)?.name } } : null),

      you: viewerSeat ? this._viewSeat(viewerSeat, true) : null,
      players: this.seats.map((s) => this._viewSeat(s, s.id === viewerId)),
      log: this.logEntries.slice(-60),
    };
  }

  _availableSkills(seat) {
    if (!seat?.alive || this.over) return [];
    if (this.pending?.seatId === seat.id && ['character_skill', 'war_character_skill'].includes(this.pending.kind)) {
      return (this.pending.data.options || []).filter((option) => option.key !== 'pass').map((option) => ({
        key: option.key,
        timing: this.pending.kind,
        pendingId: this.pending.id,
      }));
    }
    if (this.phase !== 'skill' || this.currentSeat()?.id !== seat.id) return [];
    const available = [];
    if (seat.char?.id === 'XJ203') {
      const cards = seat.hand.filter((card) => card.type === CARD_TYPE.SKILL);
      if (cards.length) available.push({
        key: 'yuanling_heal',
        timing: 'skill',
        cardUids: cards.map((card) => card.uid),
        targetIds: this.aliveSeats().map((target) => target.id),
      });
    }
    if (seat.char?.id === 'XJ204' && seat.hp >= 2) {
      const used = seat._lashTargets || new Set();
      const targets = this.aliveSeats().filter((target) => target.sex === 2 && !used.has(target.id));
      if (targets.length) available.push({ key: 'kong_lash', timing: 'skill', targetIds: targets.map((target) => target.id) });
    }
    return available;
  }

  _pendingViewData() {
    const p = this.pending;
    const d = { ...p.data };
    if (Array.isArray(d.candidates)) {
      d.candidates = d.candidates.map((id) => {
        const s = this.seatById(id);
        return { id, name: s?.name, char: s?.char?.name, faction: s?.faction };
      });
    }
    return d;
  }

  _pickView(viewerSeat) {
    const step = this.pickStep;
    return {
      config: this.pickConfig,
      stepIdx: this.pick.stepIdx,
      totalSteps: this.pick.steps.length,
      currentSide: step?.side || null,
      currentMode: step?.mode || null,
      currentCount: step?.count || 0,
      takenInCurrentStep: this.pick.stepTaken,
      remainingInCurrentStep: step ? step.count - this.pick.stepTaken : 0,
      pool: this.pick.pool.map((p) => {
        const visible = p.open || p.owner === viewerSeat?.faction || p.owner === 'discard';
        return {
          key: p.key,
          open: p.open,
          owner: p.owner,
          name: visible ? p.card.name : null,
          detail: visible ? this._roleBrief(p.card) : null,
        };
      }),
      factionRoles: {
        a: this.pick.factionRoles.a.map((c) => c.name),
        b: this.pick.factionRoles.b.map((c) => c.name),
      },
    };
  }

  _roleBrief(c) {
    return `体力${c.hp} 战力${c.power} 命中${c.range}`;
  }

  _viewSeat(s, full) {
    const base = {
      id: s.id,
      name: s.name,
      faction: s.faction,
      factionName: this.factionName(s.faction),
      char: s.char ? {
        id: s.char.id, name: s.char.name, hp: s.char.hp, power: s.char.power,
        range: s.char.range, sex: s.sex, skill: s.char.skill,
        loveById: s.char.loveById,
      } : null,
      hp: s.hp,
      maxHp: s.maxHp,
      effPower: this.effPower(s),
      effRange: this.effRange(s),
      alive: s.alive,
      tapped: s.tapped,
      isBot: s.isBot,
      offline: s.offline,
      pets: s.pets.map((p) => ({ uid: p.uid, name: p.name, power: p.power, element: p.elements.name, pets: p.pets })),
      equips: s.equips.map((e) => ({ uid: e.card.uid, name: e.card.name, eqvType: e.card.eqvType, desc: e.card.desc })),
      petScore: this.petScore(s),
      handCount: s.hand.length,
    };
    if (full) base.hand = s.hand;
    return base;
  }
}

module.exports = XianjianGame;
