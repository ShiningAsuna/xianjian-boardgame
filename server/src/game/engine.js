// 《仙剑奇侠传·逍遥游》游戏引擎
// 规则来源：工作区《游戏规则.md.txt》
//   - 4/6 人、双阵营、阵营交替行动
//   - 每回合四阶段：事件 -> 技牌 -> 战斗 -> 补牌
//   - 战斗阶段翻开怪兽牌：战胜收为宠物，战败执行惩罚
//   - 胜利：怪兽翻完比宠物总战力，或一方角色全灭
//
// 引擎本身不含传输细节，所有变更通过 onState() 广播给房间层。

const config = require('../config');
const cardDefs = require('../data/cards');
const effects = require('./effects');

const HAND_LIMIT = config.HAND_LIMIT;
const SKILL_DECK_COPIES = 3;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let uidSeq = 0;
function instantiate(def, tag) {
  uidSeq += 1;
  return { uid: `${tag}_${def.id}_${uidSeq}`, ...structuredClone(def) };
}

class XianjianGame {
  /**
   * @param {object} opts
   * @param {Array<{id:number|string,name:string,isBot?:boolean}>} opts.players 加入房间的玩家（顺序即座位顺序）
   * @param {'pvp'|'pve'} opts.mode
   * @param {Function} opts.onState (roomId) => void，状态变化通知房间层广播
   * @param {Function} [opts.onEnd] (matchRecord) => void，终局持久化回调
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.mode = opts.mode;
    this.size = opts.players.length;
    this.onState = opts.onState;
    this.onEnd = opts.onEnd || null;

    this.over = false;
    this.result = null;
    this.startedAt = new Date().toISOString();
    this.phase = 'event'; // event | skill | battle | draw
    this.logEntries = [];
    this.lastMonster = null;
    this._botToken = 0;

    // ---- 座位与阵营 ----
    // 按加入顺序交替分入两个阵营，保证平衡
    this.seats = opts.players.map((p, i) => {
      const charDef = cardDefs.characters[i % cardDefs.characters.length];
      return {
        id: p.id,
        name: p.name,
        isBot: !!p.isBot,
        offline: false,
        faction: i % 2 === 0 ? 'a' : 'b',
        char: { id: charDef.id, name: charDef.name, desc: charDef.desc },
        hp: charDef.hp,
        maxHp: charDef.hp,
        basePower: charDef.power,
        hand: [],
        pets: [],
        field: [],   // 装备牌（持续生效）
        tempBuff: 0, // 本次战斗临时加成
        alive: true,
      };
    });

    // ---- 牌堆 ----
    const monsterDefs = shuffle(cardDefs.monsters.flatMap((d) =>
      Array.from({ length: config.MONSTER_DECK_COPIES }, () => instantiate(d, 'mon'))
    ));
    this.eventDeck = [];
    for (const d of cardDefs.events) {
      for (let c = 0; c < config.EVENT_DECK_COPIES + 1; c++) this.eventDeck.push(instantiate(d, 'evt'));
    }
    this.eventDeck = shuffle(this.eventDeck);

    this.skillDeck = [];
    this.discardPile = [];   // 技牌弃牌堆（洗回技牌堆）
    this.eventDiscard = [];  // 事件牌弃牌堆（不参与洗回）
    for (const d of cardDefs.skills) {
      for (let c = 0; c < SKILL_DECK_COPIES; c++) this.skillDeck.push(instantiate(d, 'skl'));
    }
    this.skillDeck = shuffle(this.skillDeck);
    this.monsterDeck = monsterDefs;

    // ---- 开局 ----
    for (const seat of this.seats) {
      for (let i = 0; i < config.INITIAL_HAND; i++) this.drawSkill(seat);
    }

    // 骰子决定先攻阵营（获胜方可指定1号玩家，框架版由系统随机指定）
    const rollA = 1 + Math.floor(Math.random() * 6);
    const rollB = 1 + Math.floor(Math.random() * 6);
    const winnerFaction = rollA >= rollB ? 'a' : 'b';
    this.dice = { a: rollA, b: rollB };
    const fName = config.FACTIONS.find((f) => f.key === winnerFaction).name;

    // 回合顺序：两阵营成员交替排列（不可一方连续），先攻方排头
    const byFaction = (k) => shuffle(this.seats.filter((s) => s.faction === k)).map((s) => s.id);
    const orderA = byFaction('a');
    const orderB = byFaction('b');
    const first = winnerFaction === 'a' ? orderA : orderB;
    const second = winnerFaction === 'a' ? orderB : orderA;
    this.turnOrder = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
      if (first[i] !== undefined) this.turnOrder.push(first[i]);
      if (second[i] !== undefined) this.turnOrder.push(second[i]);
    }
    this.turnIdx = 0;

    this.log(`骰子判定：【蜀山派】掷出 ${rollA} 点，【拜月教】掷出 ${rollB} 点。`);
    this.log(`【${fName}】获胜，系统指定 ${this.seatById(first[0]).name} 为 1 号玩家！`);
    this.log(`对局开始：${this.size} 名玩家，怪兽牌共 ${this.monsterDeck.length} 张。`);
  }

  get HAND_LIMIT() { return HAND_LIMIT; }

  // ================= 查询工具 =================
  seatById(id) { return this.seats.find((s) => s.id === id); }
  currentSeat() { return this.seatById(this.turnOrder[this.turnIdx]); }
  isCurrent(id) { return !this.over && this.currentSeat()?.id === id; }

  aliveSeats(factionKey) {
    return this.seats.filter((s) => s.alive && (!factionKey || s.faction === factionKey));
  }

  totalPower(seat) {
    let p = seat.basePower;
    for (const eq of seat.field) if (eq.effect?.key === 'power_bonus') p += eq.effect.value || 0;
    p += seat.tempBuff;
    return p;
  }

  factionScore(k) {
    return this.seats.filter((s) => s.faction === k)
      .reduce((sum, s) => sum + s.pets.reduce((x, pet) => x + pet.power, 0), 0);
  }

  log(text) {
    this.logEntries.push({ t: Date.now(), text });
    if (this.logEntries.length > 200) this.logEntries.splice(0, this.logEntries.length - 200);
  }

  // ================= 玩家动作 =================
  actionDrawEvent(playerId) {
    const seat = this._guard(playerId, 'event');
    if (!seat) return { ok: false, error: '现在无法抽取事件牌。' };
    if (!this.eventDeck.length) {
      this.log('事件牌堆已经空了……跳过事件阶段。');
      this._toPhase('skill');
      return { ok: true };
    }
    const evt = this.eventDeck.pop();
    this.log(`${seat.name} 抽取了事件牌【${evt.name}】：${evt.desc}`);
    effects.run(evt.effect.key, this, { seat, card: evt, value: evt.effect.value, effect: evt.effect });
    this.eventDiscard.push(evt);
    this._afterDamageCheck();
    this._toPhase('skill');
    return { ok: true };
  }

  actionSkipEvent(playerId) {
    const seat = this._guard(playerId, 'event');
    if (!seat) return { ok: false, error: '现在不是你的事件阶段。' };
    this.log(`${seat.name} 稳扎稳打，跳过了事件阶段。`);
    this._toPhase('skill');
    return { ok: true };
  }

  actionPlayCard(playerId, uid) {
    const seat = this._guard(playerId, 'skill');
    if (!seat) return { ok: false, error: '现在无法出牌。' };
    const idx = seat.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return { ok: false, error: '手牌不存在。' };

    const card = seat.hand[idx];
    if (card.kind === 'equip') {
      seat.hand.splice(idx, 1);
      seat.field.push(card);
      effects.run('power_bonus', this, { seat, card, effect: card.effect });
      this.log(`${seat.name} 装备了【${card.name}】。`);
    } else {
      seat.hand.splice(idx, 1);
      this.log(`${seat.name} 打出了【${card.name}】！`);
      effects.run(card.effect.key, this, { seat, card, value: card.effect.value, effect: card.effect });
      this.discardPile.push(card);
      this._afterDamageCheck();
    }
    // 出牌改变了手牌/装备/他人气血，必须广播最新状态
    this.onState && this.onState(this.roomId);
    return { ok: true };
  }

  actionGoBattle(playerId) {
    const seat = this._guard(playerId, 'skill');
    if (!seat) return { ok: false, error: '现在不在技牌阶段。' };
    this._toPhase('battle');
    return { ok: true };
  }

  actionFlipMonster(playerId) {
    const seat = this._guard(playerId, 'battle');
    if (!seat) return { ok: false, error: '现在无法翻怪。' };
    if (!this.monsterDeck.length) return { ok: false, error: '怪兽牌已全部翻开。' };

    const mon = this.monsterDeck.pop();
    const power = this.totalPower(seat);
    const win = power > mon.power; // 平局视为失败
    this.log(`${seat.name} 翻开了怪兽牌【${mon.name}】（战力 ${mon.power}）！自己的战力为 ${power} —— ${win ? '战斗胜利！' : '战斗失败…'}`);

    if (win) {
      seat.pets.push(mon);
      this.log(`${seat.name} 将【${mon.name}】收为了宠物！（阵营得分 +${mon.power}）`);
    } else {
      effects.run(mon.penalty.key, this, { seat, card: mon, value: mon.penalty.value, effect: mon.penalty });
    }
    seat.tempBuff = 0; // 一次性加成在战斗结算后消耗
    this.lastMonster = { name: mon.name, power: mon.power, outcome: win ? 'win' : 'lose', by: seat.name };
    this._afterDamageCheck();

    if (this.over) return { ok: true };
    if (!this.monsterDeck.length) { this._settleByScore(); return { ok: true }; }
    this._toPhase('draw');
    return { ok: true };
  }

  actionFinishTurn(playerId) {
    const seat = this._guard(playerId, 'draw');
    if (!seat) return { ok: false, error: '现在不能结束回合。' };

    // 补牌阶段：补到手牌上限，超出则随机弃掉
    while (seat.hand.length < HAND_LIMIT && (this.skillDeck.length || this.discardPile.length)) {
      if (!this.drawSkill(seat)) break;
    }
    while (seat.hand.length > HAND_LIMIT) {
      const [extra] = seat.hand.splice(Math.floor(Math.random() * seat.hand.length), 1);
      this.discardPile.push(extra);
      this.log(`${seat.name} 手牌超限，弃掉了【${extra.name}】。`);
    }
    this._advanceTurn();
    return { ok: true };
  }

  markOffline(playerId, offline) {
    const seat = this.seatById(playerId);
    if (!seat || seat.isBot) return;
    seat.offline = offline;
    this.log(offline ? `${seat.name} 暂时离开了座位（回合将由系统代管）。` : `${seat.name} 回到了座位。`);
  }

  // ================= 内部流程 =================
  _guard(playerId, expectedPhase) {
    if (this.over) return null;
    const seat = this.seatById(playerId);
    if (!seat || !seat.alive) return null;
    if (this.currentSeat()?.id !== playerId) return null;
    if (this.phase !== expectedPhase) return null;
    return seat;
  }

  _toPhase(p) {
    this.phase = p;
    this.onState && this.onState(this.roomId);
  }

  /** 技牌堆摸牌；堆空则洗回弃牌堆。返回是否成功 */
  drawSkill(seat, reasonText) {
    if (!this.skillDeck.length) {
      if (!this.discardPile.length) return false;
      this.skillDeck = shuffle(this.discardPile);
      this.discardPile = [];
      this.log('技牌弃牌堆已洗回牌堆。');
    }
    const card = this.skillDeck.pop();
    seat.hand.push(card);
    if (reasonText) this.log(reasonText);
    return true;
  }

  damageSeat(seat, amount, source) {
    if (!seat.alive || amount <= 0) return;
    seat.hp -= amount;
    this.log(`${seat.name} 受到 ${amount} 点伤害（${source}），剩余气血 ${Math.max(seat.hp, 0)}。`);
    if (seat.hp <= 0) {
      seat.alive = false;
      this.log(`【${seat.char.name}】阵亡了……${seat.name} 退出行动序列（其宠物战力仍计入阵营）。`);
    }
  }

  _afterDamageCheck() {
    if (this.over) return;
    for (const k of ['a', 'b']) {
      if (this.aliveSeats(k).length === 0) {
        const winner = k === 'a' ? 'b' : 'a';
        const wName = config.FACTIONS.find((f) => f.key === winner).name;
        this._endGame(winner, 'faction_wiped');
        return;
      }
    }
    // 当前行动者因伤害/惩罚阵亡：终止其剩余阶段，立即移交下一位
    const cur = this.currentSeat();
    if (cur && !cur.alive) this._advanceTurn();
  }

  _advanceTurn() {
    // 向后找下一位存活玩家
    do {
      this.turnIdx = (this.turnIdx + 1) % this.turnOrder.length;
    } while (!this.seatById(this.turnOrder[this.turnIdx]).alive);
    this.phase = 'event';
    this.log(`—— 轮到 ${this.currentSeat().name} 的回合 ——`);
    this.onState && this.onState(this.roomId);
  }

  _settleByScore() {
    const sa = this.factionScore('a');
    const sb = this.factionScore('b');
    this.log(`所有怪兽均已翻完，进入结算：蜀山派 ${sa} 分 VS 拜月教 ${sb} 分。`);
    if (sa === sb) {
      this.log('双方战力总和持平——平局！');
      this._endGame(null, 'monsters_clear');
    } else {
      const w = sa > sb ? 'a' : 'b';
      const wName = config.FACTIONS.find((f) => f.key === w).name;
      this.log(`【${wName}】以更多宠物战力获得最终胜利！`);
      this._endGame(w, 'monsters_clear');
    }
  }

  _endGame(winnerFaction, reason) {
    this.over = true;
    this.result = {
      winnerFaction,
      reason,
      scores: { a: this.factionScore('a'), b: this.factionScore('b') },
      dice: this.dice,
      endedAt: new Date().toISOString(),
    };
    this.log(winnerFaction
      ? `=== 游戏结束：${config.FACTIONS.find((f) => f.key === winnerFaction).name} 获胜！ ===`
      : '=== 游戏结束：平局 ===');
    this.onState && this.onState(this.roomId);
    if (this.onEnd) {
      try {
        this.onEnd({
          mode: this.mode,
          size: this.size,
          winner_faction: winnerFaction,
          ended_reason: reason,
          detail: JSON.stringify(this.seats.map((s) => ({
            name: s.name,
            faction: s.faction,
            char: s.char.name,
            score: s.pets.reduce((x, p) => x + p.power, 0),
            pets: s.pets.length,
            hp: Math.max(s.hp, 0),
            alive: s.alive,
            isBot: s.isBot,
          }))),
          started_at: this.startedAt,
        });
      } catch (e) {
        console.error('[engine] persist match failed:', e.message);
      }
    }
    this._botToken++; // 终止一切 bot 循环
  }

  // ================= 视图（按观察者裁剪，对手手牌不泄露）=================
  viewFor(viewerId) {
    const viewerSeat = this.seatById(viewerId);
    return {
      kind: 'xianjian',
      roomId: this.roomId,
      mode: this.mode,
      size: this.size,
      phase: this.over ? 'over' : this.phase,
      over: this.over,
      result: this.result,
      factions: config.FACTIONS,
      handLimit: HAND_LIMIT,
      scores: { a: this.factionScore('a'), b: this.factionScore('b') },
      deckLeft: { monster: this.monsterDeck.length, event: this.eventDeck.length },
      lastMonster: this.lastMonster,
      turnPlayerId: this.over ? null : this.currentSeat().id,
      you: viewerSeat ? this._viewSeat(viewerSeat, true) : null,
      players: this.seats.map((s) => ({
        ...this._viewSeat(s, s.id === viewerId),
        handCount: s.hand.length,
        hidden: s.id !== viewerId,
      })),
      log: this.logEntries.slice(-50),
    };
  }

  _viewSeat(s, full) {
    const base = {
      id: s.id,
      name: s.name,
      faction: s.faction,
      factionName: config.FACTIONS.find((f) => f.key === s.faction).name,
      char: s.char,
      hp: s.hp,
      maxHp: s.maxHp,
      basePower: s.basePower,
      totalPower: this.totalPower(s),
      tempBuff: s.tempBuff,
      alive: s.alive,
      isBot: s.isBot,
      offline: s.offline,
      pets: s.pets.map((p) => ({ name: p.name, power: p.power })),
      field: full ? s.field : s.field.map((c) => ({ uid: c.uid, name: c.name })),
      petScore: s.pets.reduce((x, p) => x + p.power, 0),
    };
    if (full) base.hand = s.hand;
    return base;
  }

  // ================= Bot / 掉线代打 =================
  needAutomation() {
    if (this.over) return false;
    const cur = this.currentSeat();
    return !!cur && (cur.isBot || cur.offline);
  }

  cancelAutomation() { this._botToken++; }

  async runBotLoop(token) {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    while (this.needAutomation() && token === this._botToken) {
      await delay(700);
      if (token !== this._botToken || this.over) break;
      const seat = this.currentSeat();
      if (!(seat.isBot || seat.offline)) break;

      switch (this.phase) {
        case 'event':
          Math.random() < 0.65 ? this.actionDrawEvent(seat.id) : this.actionSkipEvent(seat.id);
          break;
        case 'skill': {
          // 先挂装备，再打出至多两张即时技牌
          const equip = seat.hand.find((c) => c.kind === 'equip');
          if (equip) { this.actionPlayCard(seat.id, equip.uid); break; }
          const instants = seat.hand.filter((c) => c.kind === 'instant');
          if (instants.length && Math.random() < 0.8) {
            const pick = instants[Math.floor(Math.random() * instants.length)];
            this.actionPlayCard(seat.id, pick.uid);
          } else {
            this.actionGoBattle(seat.id);
          }
          break;
        }
        case 'battle':
          this.actionFlipMonster(seat.id);
          break;
        case 'draw':
          this.actionFinishTurn(seat.id);
          break;
        default:
          return;
      }
      await delay(400);
    }
  }
}

module.exports = XianjianGame;
