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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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

    // 房间配置：抽取角色数 / 明牌数 / 暗牌数
    this.pickConfig = this._normalizePickConfig(opts.pickConfig, this.size);

    this.over = false;
    this.result = null;
    this.phase = 'pick';
    this.logEntries = [];
    this.pending = null;      // 当前等待响应的询问 {seatId,kind,data,resolve,timer,deadline}
    this.battle = null;       // 战斗上下文
    this._busy = false;       // 引擎互斥锁
    this._botToken = 0;
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
    this.monsterDeck = shuffle(R.defs.monsters.map((d) => this.instantiateMonster(d)));
    this.monsterDiscard = [];
    this.eventDeck = shuffle(R.defs.events.flatMap((d) => Array.from({ length: d.num || 1 }, () => ({ ...d, uid: nextUid('ev', d.id) }))));
    this.eventDiscard = [];
    this.skillDeck = shuffle(R.defs.cards.flatMap((d) => Array.from({ length: d.num || 1 }, () => this.instantiateCard(d))));
    this.discardPile = [];

    // 角色牌库：每种角色 2 份（梦蛇为变身形态，不进选择池）
    const rolePoolDefs = R.defs.characters.filter((c) => c.id !== 'XJ103');
    this.roleLibrary = shuffle(rolePoolDefs.flatMap((d) => Array.from({ length: 2 }, () => ({ ...d }))));

    // ---- 掷骰子定先手 ----
    const rollA = 1 + Math.floor(Math.random() * 6);
    const rollB = 1 + Math.floor(Math.random() * 6);
    this.dice = { a: rollA, b: rollB };
    this.firstFaction = rollA >= rollB ? 'a' : 'b';

    // 行动顺序：两阵营交替（先手方排头）
    const orderA = shuffle(this.seats.filter((s) => s.faction === 'a')).map((s) => s.id);
    const orderB = shuffle(this.seats.filter((s) => s.faction === 'b')).map((s) => s.id);
    const first = this.firstFaction === 'a' ? orderA : orderB;
    const second = this.firstFaction === 'a' ? orderB : orderA;
    this.turnOrder = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
      if (first[i] !== undefined) this.turnOrder.push(first[i]);
      if (second[i] !== undefined) this.turnOrder.push(second[i]);
    }
    this.turnIdx = 0;

    // ---- 角色选择阶段状态 ----
    const { total, open } = this.pickConfig;
    const drawn = shuffle(this.roleLibrary).slice(0, total);
    this.pick = {
      pool: drawn.map((c, i) => ({
        key: `pk_${i}`,
        card: c,
        open: i < open,       // 明牌 / 暗牌
        owner: null,          // 'a' | 'b' | 'discard'
      })),
      steps: this._buildPickSteps(total),
      stepIdx: 0,
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
    const libSize = (R.defs.characters.length - 1) * 2; // 梦蛇除外，每种2份
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

  // ================= 查询工具 =================
  seatById(id) { return this.seats.find((s) => s.id === id); }
  currentSeat() { return this.seatById(this.turnOrder[this.turnIdx]); }
  aliveSeats(fk) { return this.seats.filter((s) => s.alive && (!fk || s.faction === fk)); }
  enemyFactionOf(fk) { return fk === 'a' ? 'b' : 'a'; }
  factionName(fk) { return config.FACTIONS.find((f) => f.key === fk)?.name || fk; }
  factionDecider(fk) { return this.aliveSeats(fk)[0] || null; } // 阵营决策人（行动序第一位）
  factionScore(fk) {
    return this.seats.filter((s) => s.faction === fk)
      .reduce((sum, s) => sum + s.pets.reduce((x, p) => x + p.power, 0), 0);
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
  ask(seatId, { kind, data = {}, timeoutMs = 15000, botFn }) {
    return new Promise((resolve) => {
      const seat = this.seatById(seatId);
      const wrap = {
        seatId, kind, data,
        deadline: Date.now() + timeoutMs,
        resolve: (ans) => { clearTimeout(wrap.timer); this.pending = null; resolve(ans); this.emit(); },
        timer: null,
      };
      wrap.timer = setTimeout(() => {
        if (this.pending === wrap) {
          const def = botFn ? botFn() : null;
          this.log(`（${seat.name} 响应超时，自动处理）`);
          wrap.resolve(def);
        }
      }, timeoutMs);
      this.pending = wrap;
      this.emit();
      // Bot 立即按策略决策
      if (seat?.isBot || seat?.offline) {
        setTimeout(() => {
          if (this.pending === wrap) wrap.resolve(botFn ? botFn() : null);
        }, 650);
      }
    });
  }

  submitPending(playerId, answer) {
    const p = this.pending;
    if (!p || p.seatId !== playerId) return { ok: false, error: '当前没有等待您的询问。' };
    p.resolve(answer);
    return { ok: true };
  }

  async askChoosePlayer(seat, candidates, { reason, optional = false } = {}) {
    if (!candidates.length) return null;
    const list = candidates.map((s) => s.id);
    const ans = await this.ask(seat.id, {
      kind: 'choose_player',
      data: { reason, candidates: list, optional },
      botFn: () => list[0],
    });
    return this.seatById(ans) || null;
  }

  async askYesNo(seat, { reason }) {
    const ans = await this.ask(seat.id, {
      kind: 'yes_no',
      data: { reason },
      botFn: () => true,
    });
    return !!ans;
  }

  // ================= 摸牌 / 伤害 / 濒死 =================
  drawCards(seat, n) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!this.skillDeck.length) {
        if (!this.discardPile.length) break;
        this.skillDeck = shuffle(this.discardPile);
        this.discardPile = [];
        this.log('手牌弃牌堆已洗回抽牌堆。');
      }
      seat.hand.push(this.skillDeck.pop());
      drawn++;
    }
    return drawn;
  }

  /** 统一伤害入口：隐蛊抵消 → 乾坤道袍免疫技牌伤害 → 扣血 → 濒死结算 */
  async damage(seat, amount, { source = null, kind = 'skill', element = null, fromLove = false } = {}) {
    if (this.over || !seat.alive || amount <= 0) return false;

    // 隐蛊：抵消一次自己受到的HP伤害（倾慕除外）
    if (!fromLove) {
      const hiddenGu = seat.hand.find((c) => c.id === 3);
      if (hiddenGu) {
        const use = await this.ask(seat.id, {
          kind: 'use_card',
          data: { reason: `是否使用【隐蛊】抵消这 ${amount} 点伤害？`, cardUid: hiddenGu.uid },
          botFn: () => amount >= 2,
        });
        if (use) {
          seat.hand.splice(seat.hand.indexOf(hiddenGu), 1);
          this.discardPile.push(hiddenGu);
          this.log(`${seat.name} 使用【隐蛊】，抵消了 ${amount} 点伤害。`);
          return false;
        }
      }
    }

    // 乾坤道袍：免疫技牌导致的HP伤害
    if (kind === 'skill' && seat.equips.some((e) => e.card.id === 11)) {
      this.log(`${seat.name} 身着【乾坤道袍】，免疫技牌伤害。`);
      return false;
    }

    seat.hp -= amount;
    this.log(`${seat.name} 受到 ${amount} 点${element ? element + '属性' : ''}伤害，剩余气血 ${Math.max(seat.hp, 0)}。`);
    if (seat.hp > 0) return false;
    return await this.dyingProcess(seat, fromLove);
  }

  /** 濒死结算：灵葫仙丹 → 五彩霞衣爆发 → 蝶精爆发 → 倾慕者 → 阵亡。返回是否死亡 */
  async dyingProcess(seat, fromLove = false) {
    this.log(`${seat.name} 的【${seat.char?.name || '?'}】进入濒死！`);
    this.emit();

    // 1) 灵葫仙丹：所有存活玩家依次可救（濒死者优先）
    const saviors = this.aliveSeats();
    saviors.sort((x, y) => (x.id === seat.id ? -1 : y.id === seat.id ? 1 : 0));
    for (const s of saviors) {
      const pill = s.hand.find((c) => c.id === 2);
      if (!pill) continue;
      const use = await this.ask(s.id, {
        kind: 'use_card',
        data: { reason: `${seat.name} 濒死，是否使用【灵葫仙丹】令其复活并恢复 2 点HP？`, cardUid: pill.uid },
        botFn: () => (s.id === seat.id || s.faction === seat.faction),
      });
      if (use) {
        s.hand.splice(s.hand.indexOf(pill), 1);
        this.discardPile.push(pill);
        seat.hp = 2;
        this.log(`${s.name} 使用【灵葫仙丹】，${seat.name} 复活并恢复至 2 点HP！`);
        return false;
      }
    }

    // 2) 五彩霞衣爆发：自己弃衣复活+2HP
    const robe = seat.equips.find((e) => e.card.id === 10);
    if (robe) {
      const use = await this.ask(seat.id, {
        kind: 'use_equip_burst',
        data: { reason: '是否爆发【五彩霞衣】？丢弃后复活并恢复 2 点HP。', cardUid: robe.card.uid },
        botFn: () => true,
      });
      if (use) {
        this.unequip(seat, robe);
        this.discardPile.push(robe.card);
        seat.hp = 2;
        this.log(`${seat.name} 爆发【五彩霞衣】，复活并恢复至 2 点HP！`);
        return false;
      }
    }

    // 3) 蝶精爆发：蝶精主人弃蝶精，令濒死者满血复活
    for (const s of this.aliveSeats()) {
      const butterfly = s.pets.find((p) => p.id === 'MO008');
      if (!butterfly) continue;
      const use = await this.ask(s.id, {
        kind: 'use_pet_burst',
        data: { reason: `是否爆发【蝶精】？放弃蝶精，令 ${seat.name} 满HP复活。`, petUid: butterfly.uid },
        botFn: () => (s.faction === seat.faction || s.id === seat.id),
      });
      if (use) {
        s.pets.splice(s.pets.indexOf(butterfly), 1);
        this.monsterDiscard.push(butterfly);
        seat.hp = seat.maxHp;
        this.log(`${s.name} 爆发【蝶精】，${seat.name} 满HP复活！`);
        await this.checkTransform();
        return false;
      }
    }

    // 4) 倾慕者结算
    const loverIds = seat.char?.loveById || [];
    const lover = this.aliveSeats().find((s) => s.id !== seat.id && loverIds.includes(s.char?.id));
    if (lover) {
      this.log(`${lover.name}（${lover.char.name}）是 ${seat.name} 的倾慕者，必须扣减 1 点体力相救！`);
      seat.hp = 1;
      this.emit();
      await this.damage(lover, 1, { kind: 'love', fromLove: true });
      this.log(`${seat.name} 被倾慕者救回，体力回到 1。`);
      return false;
    }

    // 5) 阵亡
    seat.alive = false;
    this.log(`【${seat.char?.name}】${seat.name} 阵亡了……（宠物战力仍计入阵营）`);
    await this.checkTransform();
    await this.checkFactionWiped();
    return true;
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
    const item = this.pick.pool.find((p) => p.key === key && p.owner === null);
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

    this.pick.stepIdx++;
    if (this.pick.stepIdx >= this.pick.steps.length) {
      this._finishPick();
    } else {
      this.emit();
    }
    return { ok: true };
  }

  /** 选牌结束：分配角色到玩家（每人1张，多余进阵营备用区） */
  _finishPick() {
    for (const fk of ['a', 'b']) {
      const members = this.seats.filter((s) => s.faction === fk);
      const roles = this.pick.factionRoles[fk];
      members.forEach((m, i) => {
        const role = roles[i];
        if (role) this._assignRole(m, role);
      });
      // 多余角色留在阵营备用区（框架占位，不参与战斗）
      const spare = roles.slice(members.length);
      if (spare.length) this.log(`${this.factionName(fk)}的备用角色：${spare.map((r) => r.name).join('、')}（暂不上场）。`);
    }
    for (const s of this.seats) this.drawCards(s, HAND_START);
    this.log('角色选择结束，所有角色已就位，对局正式开始！');
    this.phase = 'event';
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
    if (!seat) return { ok: false, error: '现在无法抽取事件牌。' };
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
    if (!seat) return { ok: false, error: '现在不是你的事件阶段。' };
    this.log(`${seat.name} 跳过了事件阶段。`);
    this.phase = 'skill';
    this.emit();
    return { ok: true };
  }

  /** 技牌阶段：出技牌/装备/特殊牌(灵葫仙丹自用)；带 targetId 的技牌由前端附带目标 */
  actionPlayCard(playerId, uid, targetId = null, targetKind = null) {
    const seat = this._guard(playerId, 'skill');
    if (!seat) return { ok: false, error: '现在无法出牌。' };
    const idx = seat.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return { ok: false, error: '手牌不存在。' };
    const card = seat.hand[idx];
    if (card.type === CARD_TYPE.WAR) return { ok: false, error: '战牌只能在战斗的战牌阶段使用。' };
    if (card.type !== CARD_TYPE.EQUIP && card.type !== CARD_TYPE.SKILL && card.type !== CARD_TYPE.SPECIAL) {
      return { ok: false, error: '无法使用此牌。' };
    }

    (async () => {
      await this._runLocked(async () => {
        const target = targetId != null ? this.seatById(targetId) : null;
        if (card.type === CARD_TYPE.EQUIP) {
          seat.hand.splice(idx, 1);
          this._equip(seat, card);
        } else if (card.type === CARD_TYPE.SKILL) {
          const def = R.SKILL_CARDS[card.id];
          if (def?.needTarget && !target) { this.emit(); return; }
          seat.hand.splice(idx, 1);
          this.log(`${seat.name} 使用了【${card.name}】。`);
          // 冰心诀响应窗口
          const cancelled = await this._askCounter(seat, card);
          if (!cancelled) {
            try { await def?.run(this, { seat, target, targetKind }); } catch (e) { console.error('[engine] skill card failed:', e); }
          }
          this.discardPile.push(card);
        } else {
          // 特殊牌：灵葫仙丹自用
          const def = R.SPECIAL_CARDS[card.id];
          if (!def) { this.emit(); return; }
          seat.hand.splice(idx, 1);
          this.log(`${seat.name} 使用了【${card.name}】。`);
          const cancelled = await this._askCounter(seat, card);
          if (!cancelled) {
            try { await def.run(this, { seat }); } catch (e) { console.error('[engine] special card failed:', e); }
          }
          this.discardPile.push(card);
        }
        await this.checkFactionWiped();
        if (!this.over) this.emit();
      });
    })();
    return { ok: true };
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

  /** 冰心诀响应：其他拥有冰心诀的玩家可令此牌无效。返回是否被抵消 */
  async _askCounter(playSeat, card) {
    for (const s of this.aliveSeats()) {
      if (s.id === playSeat.id) continue;
      const bing = s.hand.find((c) => c.id === 1);
      if (!bing) continue;
      const use = await this.ask(s.id, {
        kind: 'use_card',
        data: { reason: `${playSeat.name} 使用了【${card.name}】，是否打出【冰心诀】令其无效？`, cardUid: bing.uid },
        botFn: () => s.faction !== playSeat.faction && Math.random() < 0.5,
      });
      if (use) {
        s.hand.splice(s.hand.indexOf(bing), 1);
        this.discardPile.push(bing);
        this.log(`${s.name} 打出【冰心诀】，${playSeat.name} 的【${card.name}】被无效！`);
        return true;
      }
    }
    return false;
  }

  /** 技牌阶段 → 战斗阶段 */
  actionGoBattle(playerId) {
    const seat = this._guard(playerId, 'skill');
    if (!seat) return { ok: false, error: '现在不在技牌阶段。' };
    this.phase = 'battle';
    this.emit();
    (async () => { await this._runLocked(() => this.runBattlePhase(seat)); })();
    return { ok: true };
  }

  // ================= 战斗阶段（8 子阶段）=================
  get b() { return this.battle; }

  async runBattlePhase(trigger) {
    if (this.over) return;
    const battle = {
      trigger,
      supporter: null,
      obstructer: null,
      monster: null,
      stage: 'confirm',   // confirm|roles|flip|appear|hit|cards|resolve|settle
      skipped: false,
      escaped: false,
      supporterHit: false,
      obstructerHit: false,
      supporterBonus: 0,
      warBonus: { a: 0, b: 0 },
      warPersonal: {},
      warDouble: {},
      actedWar: [],
      firstWarSide: null,
      winnerSide: null,
      extraBattle: false, // 酒剑仙第二次战斗标记
    };
    this.battle = battle;
    this.emit();

    // —— ① 开始确认阶段：双方阵营决定是否开战（任一方拒绝则跳过）
    const enemySide = this.enemyFactionOf(trigger.faction);
    const dA = this.factionDecider(trigger.faction);
    const dB = this.factionDecider(enemySide);
    const openA = dA ? await this.ask(dA.id, {
      kind: 'battle_confirm',
      data: { reason: `是否对即将翻开的怪兽开启战斗？（不开战则怪兽直接弃置，且您方触发者本回合只能补 1 张牌）` },
      botFn: () => Math.random() < 0.85,
    }) : false;
    const openB = dB ? await this.ask(dB.id, {
      kind: 'battle_confirm',
      data: { reason: `对方阵营触发了战斗，是否同意开战？（不开战则怪兽直接弃置，对方补牌减为 1 张）` },
      botFn: () => Math.random() < 0.7,
    }) : false;

    if (!openA || !openB) {
      this.log(`${!openA ? this.factionName(trigger.faction) : this.factionName(enemySide)}选择不开战，怪兽牌堆顶的怪兽直接进入弃牌堆。`);
      const mon = this.monsterDeck.pop();
      if (mon) this.monsterDiscard.push(mon);
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
    const mon = battle.monster;
    this.lastMonster = { name: mon.name, power: mon.power, element: mon.elements.name, by: trigger.name };
    this.log(`翻取阶段：翻开了怪兽【${mon.name}】（${mon.elements.name}属性·战力${mon.power}·闪避${mon.range}·${mon.type === 3 ? 'BOSS' : mon.type === 2 ? '强敌' : '小怪'}）！`);
    this.emit();

    // 飞龙探云手：我方参战者、怪物闪避≤2 → 抽妨碍者手牌
    for (const s of this.aliveSeats()) {
      if (R.skillsOf(s).onBattleFlip && this.isCombatant(s, battle) && s.faction === trigger.faction) {
        try { await R.skillsOf(s).onBattleFlip(this, s, battle); } catch (e) { console.error(e); }
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
      try { await R.MONSTER_EFFECTS[mon.id]?.win?.(this, ctx); } catch (e) { console.error(e); }
      if (!battle.escaped && !this.over) this._gainPet(trigger, mon);
    } else {
      try { await R.MONSTER_EFFECTS[mon.id]?.lose?.(this, ctx); } catch (e) { console.error(e); }
    }
    if (this.over) return;

    // 嫉恶如仇等战斗结束技能
    for (const s of this.aliveSeats()) {
      const sk = R.skillsOf(s);
      if (sk.onBattleEnd) {
        try { await sk.onBattleEnd(this, s, battle); } catch (e) { console.error(e); }
      }
    }
    if (this.over) return;

    await this._finishBattle(battle);
  }

  /** 触发方阵营='a'侧？统一按“触发方/怪物方”计算战力再映射到展示 */
  battlePower(battle, sideKey) {
    // sideKey: 'a'=触发方阵营合计；'b'=怪物方合计
    const trigger = battle.trigger;
    let a = this.effPower(trigger);
    if (battle.supporter && battle.supporterHit) {
      a += this.effPower(battle.supporter) + (battle.supporterBonus || 0);
    }
    // 梦蛇·女娲：梦蛇在场时，其所在阵营战斗战力+2
    const mengshe = this.seats.find((s) => s.alive && s.char?.id === 'XJ103');
    if (mengshe) {
      const mengsheSideIsTrigger = mengshe.faction === trigger.faction;
      if (mengsheSideIsTrigger === (sideKey === 'a')) a += 2;
    }
    if (sideKey === 'a') {
      a += battle.warBonus[trigger.faction];
      a += battle.warPersonal[trigger.id] || 0;
      if (battle.supporter) a += battle.warPersonal[battle.supporter.id] || 0;
      return a;
    }
    // 怪物方
    let b = battle.monster ? battle.monster.power : 0;
    if (battle.obstructer && battle.obstructerHit) b += this.effPower(battle.obstructer);
    const enemyFk = this.enemyFactionOf(trigger.faction);
    b += battle.warBonus[enemyFk];
    if (battle.obstructer) b += battle.warPersonal[battle.obstructer.id] || 0;
    return b;
  }

  async _warCardsLoop(battle) {
    // 双方所有存活玩家各有一次出牌机会，阵营交替指定出牌玩家（两步：决策人指定 → 出牌人选择）
    while (!battle.escaped && !this.over) {
      const side = battle.warTurnSide;
      const remain = this.aliveSeats(side).map((s) => s.id).filter((id) => !battle.actedWar.includes(id));
      if (!remain.length) {
        const other = this.enemyFactionOf(side);
        const remainOther = this.aliveSeats(other).map((s) => s.id).filter((id) => !battle.actedWar.includes(id));
        if (!remainOther.length) break; // 全员行动完毕
        battle.warTurnSide = other;
        continue;
      }
      const decider = this.factionDecider(side);
      const pid = await this.ask(decider.id, {
        kind: 'war_pick_player',
        data: { reason: `战牌阶段：为${this.factionName(side)}指定一名玩家出战牌`, candidates: remain },
        botFn: () => this._botWarPick(battle, remain),
      });
      const seat = this.seatById(pid);
      if (!seat || seat.faction !== side || battle.actedWar.includes(pid)) continue;
      battle.actedWar.push(pid);

      const legal = seat.hand
        .filter((c) => c.type === CARD_TYPE.WAR && this._warCardLegal(seat, c, battle))
        .map((c) => ({ uid: c.uid, name: c.name, desc: c.desc, needTargetSide: !!R.WAR_CARDS[c.id]?.needTargetSide }));
      const ans = await this.ask(seat.id, {
        kind: 'war_play_card',
        data: { reason: '选择要打出的战牌（可不出）', legal },
        botFn: () => (legal.length ? { uid: legal[0].uid, targetSide: seat.faction } : { pass: true }),
      });

      if (ans && ans.uid && !ans.pass) {
        const idx = seat.hand.findIndex((c) => c.uid === ans.uid);
        if (idx >= 0) {
          const card = seat.hand[idx];
          if (this._warCardLegal(seat, card, battle)) {
            seat.hand.splice(idx, 1);
            this.log(`${seat.name} 打出战牌【${card.name}】！`);
            const def = R.WAR_CARDS[card.id];
            const targetSide = ans.targetSide === 'a' || ans.targetSide === 'b' ? ans.targetSide : seat.faction;
            try { await def?.run(this, { seat, battle, targetSide }); } catch (e) { console.error(e); }
            this.discardPile.push(card);
          } else {
            this.log(`${seat.name} 的【${card.name}】不满足使用条件，未生效。`);
          }
        }
      } else {
        this.log(`${seat.name} 选择不出战牌。`);
      }
      battle.warTurnSide = this.enemyFactionOf(side);
      this.emit();
    }
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

  /** 收为宠物：同五行只能留一只（保留新宠，旧宠弃置） */
  _gainPet(seat, monster) {
    const elem = monster.elements.id;
    const dup = seat.pets.find((p) => p.elements.id === elem);
    if (dup) {
      this.monsterDiscard.push(dup);
      seat.pets.splice(seat.pets.indexOf(dup), 1);
      this.log(`${seat.name} 已有${monster.elements.name}属性宠物【${dup.name}】，只能保留一只——【${dup.name}】被弃至怪兽弃牌堆。`);
    }
    seat.pets.push(monster);
    const bonus = R.PET_BONUS[monster.id];
    this.log(`${seat.name} 将【${monster.name}】收为宠物！${bonus ? `宠物效果：${monster.pets}` : ''}（阵营得分 +${monster.power}）`);
  }

  async _finishBattle(battle) {
    battle.trigger._battleCount = (battle.trigger._battleCount || 0) + 1;
    this.battle = null;
    this.emit();
    if (this.over) return;
    await this.checkTransform();
    await this.checkFactionWiped();
    if (this.over) return;
    await this._settleIfMonsterEmpty();
    if (this.over) return;

    // 酒剑仙·醉仙望月步：可触发第二场战斗
    const seat = this.currentSeat();
    if (seat && this.hasSkill(seat, '醉仙望月步') && !battle.extraBattle && !battle.skipped && this.monsterDeck.length) {
      const again = await this.ask(seat.id, {
        kind: 'yes_no',
        data: { reason: '【醉仙望月步】是否再触发一场战斗？' },
        botFn: () => false,
      });
      if (again) {
        const second = {
          trigger: seat, supporter: null, obstructer: null, monster: null,
          stage: 'confirm', skipped: false, escaped: false,
          supporterHit: false, obstructerHit: false, supporterBonus: 0,
          warBonus: { a: 0, b: 0 }, warPersonal: {}, warDouble: {},
          actedWar: [], firstWarSide: null, winnerSide: null, extraBattle: true,
        };
        this.battle = second;
        this.emit();
        this.log(`【醉仙望月步】${seat.name} 再战一场！`);
        // 第二场直接开战（已确认过），从指定参战者开始
        await this._runBattleFromRoles(second);
        return;
      }
    }
    this.phase = 'draw';
    this.emit();
  }

  /** 第二场战斗：跳过开始确认，直接指定参战者 */
  async _runBattleFromRoles(battle) {
    if (this.over) return;
    const trigger = battle.trigger;
    const enemySide = this.enemyFactionOf(trigger.faction);
    battle.stage = 'roles';
    this.emit();
    const allies = this.aliveSeats(trigger.faction).filter((s) => s.id !== trigger.id);
    if (allies.length) {
      const sid = await this.ask(trigger.id, {
        kind: 'pick_supporter',
        data: { reason: '指定一名队友作为支援者参战', candidates: allies.map((s) => s.id) },
        botFn: () => allies.sort((x, y) => this.effPower(y) - this.effPower(x))[0].id,
      });
      battle.supporter = this.seatById(sid) || null;
    }
    const enemies = this.aliveSeats(enemySide);
    if (enemies.length) {
      const decider = this.factionDecider(enemySide);
      const oid = await this.ask(decider?.id || enemies[0].id, {
        kind: 'pick_obstructer',
        data: { reason: '指定一名本方玩家作为妨碍者参战', candidates: enemies.map((s) => s.id) },
        botFn: () => enemies.sort((x, y) => this.effPower(y) - this.effPower(x))[0].id,
      });
      battle.obstructer = this.seatById(oid) || null;
    }
    // 后续与第一场一致：复制主流程
    battle.stage = 'flip';
    if (!this.monsterDeck.length) { this.battle = null; this.phase = 'draw'; this.emit(); return; }
    battle.monster = this.monsterDeck.pop();
    const mon = battle.monster;
    this.lastMonster = { name: mon.name, power: mon.power, element: mon.elements.name, by: trigger.name };
    this.log(`翻取阶段：翻开了怪兽【${mon.name}】（${mon.elements.name}属性·战力${mon.power}·闪避${mon.range}）！`);
    this.emit();
    battle.stage = 'appear';
    try { await R.MONSTER_EFFECTS[mon.id]?.appear?.(this, { battle, trigger, monster: mon }); } catch (e) { console.error(e); }
    if (this.over) return;
    if (battle.escaped) return await this._finishBattle(battle);
    battle.stage = 'hit';
    this.emit();
    if (battle.supporter) {
      let hit = this.effRange(battle.supporter);
      const sk = R.skillsOf(battle.supporter);
      if (sk.supportHitBonus) hit += sk.supportHitBonus(this, battle.supporter, battle);
      battle.supporterHit = hit >= mon.range;
      this.log(`命中结算：支援者 ${battle.supporter.name} 命中 ${hit} VS 闪避 ${mon.range} —— ${battle.supporterHit ? '成功' : '失败'}。`);
    }
    if (battle.obstructer) {
      const hit = this.effRange(battle.obstructer);
      battle.obstructerHit = hit >= mon.range;
      this.log(`命中结算：妨碍者 ${battle.obstructer.name} 命中 ${hit} VS 闪避 ${mon.range} —— ${battle.obstructerHit ? '成功' : '失败'}。`);
    }
    battle.stage = 'cards';
    const a0 = this.battlePower(battle, 'a');
    const b0 = this.battlePower(battle, 'b');
    battle.firstWarSide = a0 < b0 ? trigger.faction : this.enemyFactionOf(trigger.faction);
    battle.warTurnSide = battle.firstWarSide;
    this.log(`初始战力：触发方 ${a0} VS 怪物方 ${b0}。${this.factionName(battle.firstWarSide)}先出战牌。`);
    this.emit();
    await this._warCardsLoop(battle);
    if (battle.escaped) return await this._finishBattle(battle);
    battle.stage = 'resolve';
    const af = this.battlePower(battle, 'a');
    const bf = this.battlePower(battle, 'b');
    battle.winnerSide = af >= bf ? trigger.faction : this.enemyFactionOf(trigger.faction);
    this.log(`战力结算：触发方 ${af} VS 怪物方 ${bf} —— ${battle.winnerSide === trigger.faction ? '触发方胜利！' : '怪物方获胜！'}`);
    this.emit();
    battle.stage = 'settle';
    const ctx = { battle, trigger, monster: mon };
    if (battle.winnerSide === trigger.faction) {
      try { await R.MONSTER_EFFECTS[mon.id]?.win?.(this, ctx); } catch (e) { console.error(e); }
      if (!battle.escaped && !this.over) this._gainPet(trigger, mon);
    } else {
      try { await R.MONSTER_EFFECTS[mon.id]?.lose?.(this, ctx); } catch (e) { console.error(e); }
    }
    if (this.over) return;
    for (const s of this.aliveSeats()) {
      const sk = R.skillsOf(s);
      if (sk.onBattleEnd) { try { await sk.onBattleEnd(this, s, battle); } catch (e) { console.error(e); } }
    }
    await this._finishBattle(battle);
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
    if (!seat) return { ok: false, error: '现在不能结束回合。' };
    (async () => {
      await this._runLocked(async () => {
        await this.drawPhase(seat);
        if (this.over) return;
        this._advanceTurn();
      });
    })();
    return { ok: true };
  }

  async drawPhase(seat) {
    // 阿奴·万蛊蚀天：补牌阶段开始时无手牌
    if (this.hasSkill(seat, '万蛊蚀天') && !seat.hand.length) {
      this.log(`【万蛊蚀天】${seat.name} 补牌阶段开始时没有手牌！我方全体补 1 张牌，随后其他所有角色 HP-1。`);
      for (const ally of this.aliveSeats(seat.faction)) this.drawCards(ally, 1);
      for (const other of this.aliveSeats().filter((s) => s.id !== seat.id)) {
        await this.damage(other, 1, { source: seat, kind: 'skill' });
      }
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
    // 弃至 3 张
    while (seat.hand.length > HAND_KEEP) {
      const i = Math.floor(Math.random() * seat.hand.length);
      const [c] = seat.hand.splice(i, 1);
      this.discardPile.push(c);
      this.log(`${seat.name} 手牌超过 ${HAND_KEEP} 张，弃掉了【${c.name}】。`);
    }
    this.emit();
  }

  _lastBattleSkipped(seat) { return !!seat._battleSkipped; }
  _battlesThisTurn(seat) { return seat._battleCount || 0; }

  _advanceTurn() {
    do {
      const cur = this.currentSeat();
      if (cur && cur.tapped) {
        cur.tapped = false;
        this.log(`${cur.name} 的角色处于横置状态，跳过本回合并重置。`);
      }
      this.turnIdx = (this.turnIdx + 1) % this.turnOrder.length;
    } while (!this.seatById(this.turnOrder[this.turnIdx]).alive);

    const next = this.currentSeat();
    next._battleSkipped = false;
    next._battleCount = 0;
    this.phase = 'event';
    this.log(`—— 轮到 ${next.name}（${next.char?.name}）的回合 ——`);
    this.emit();
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
            score: s.pets.reduce((x, p) => x + p.power, 0), pets: s.pets.length,
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
          this.eventDeck.length && Math.random() < 0.6 ? this.actionDrawEvent(seat.id) : this.actionSkipEvent(seat.id);
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
          if (usable.length && Math.random() < 0.7) {
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
      turnPlayerId: this.over ? null : (this.phase === 'pick' ? null : this.currentSeat()?.id),
      dice: this.dice,
      firstFaction: this.firstFaction,

      // 角色选择阶段
      pick: this.phase === 'pick' ? this._pickView(viewerSeat) : null,

      // 战斗上下文（公开信息）
      battle: b ? {
        stage: b.stage,
        trigger: { id: b.trigger.id, name: b.trigger.name, faction: b.trigger.faction },
        supporter: b.supporter ? { id: b.supporter.id, name: b.supporter.name, faction: b.supporter.faction } : null,
        obstructer: b.obstructer ? { id: b.obstructer.id, name: b.obstructer.name, faction: b.obstructer.faction } : null,
        monster: b.monster ? {
          name: b.monster.name, power: b.monster.power, range: b.monster.range,
          element: b.monster.elements.name, type: b.monster.type,
          appear: b.monster.appear, win: b.monster.win, lose: b.monster.lose,
        } : null,
        supporterHit: b.supporterHit,
        obstructerHit: b.obstructerHit,
        warTurnSide: b.warTurnSide || null,
        actedWar: b.actedWar,
        powerA: this.battlePower(b, 'a'),
        powerB: this.battlePower(b, 'b'),
        escaped: b.escaped,
        winnerSide: b.winnerSide,
        extraBattle: b.extraBattle,
      } : null,

      // pending 询问（仅目标玩家可见）
      pending: this.pending && this.pending.seatId === viewerId ? {
        kind: this.pending.kind,
        data: this._pendingViewData(),
        deadline: this.pending.deadline,
      } : (this.pending ? { kind: 'waiting', data: { seatName: this.seatById(this.pending.seatId)?.name } } : null),

      you: viewerSeat ? this._viewSeat(viewerSeat, true) : null,
      players: this.seats.map((s) => this._viewSeat(s, s.id === viewerId)),
      log: this.logEntries.slice(-60),
    };
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
      petScore: s.pets.reduce((x, p) => x + p.power, 0),
      handCount: s.hand.length,
    };
    if (full) base.hand = s.hand;
    return base;
  }
}

module.exports = XianjianGame;
