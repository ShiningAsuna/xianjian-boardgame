// 卡池数据（《游戏规则.md》定义的四类卡牌）
//
// 本文件为纯数据定义，效果的执行逻辑统一实现在 src/game/rules.js 的效果注册表中，
// 通过卡牌 id 关联（新增卡牌时：在此加数据 + 在 rules.js 注册效果）。
//
// 字段说明：
//   characters: hp 体力 / power 战力 / range 命中 / sex 1男2女 / loveById 倾慕者
//               canChoose为false选人时不进入可选角色池（XJ103 赵灵儿·梦蛇 为 XJ102 的变身形态，不进入角色选择池）
//   monsters:   elements 五行 / power 战力 / range 闪避 / type 1弱2强3boss
//               appear 出场效果 / pets 宠物效果 / win 胜利结算 / lose 失败结算（文本描述）
//   events:     num 该事件牌数量
//   cards:      手牌 type 1特殊牌 2装备牌 3技牌 4战牌；eqvType 1武器 2防具；num 数量

const characters = [
  {
    id: 'XJ101',
    name: '李逍遥',
    hp: 8,
    power: 4,
    range: 3,
    sex: 1,
    loveById: ['XJ102', 'XJ103', 'XJ104', 'XJ105'],
    skill: [
      { name: '侠骨柔肠', desc: '您支援女性角色触发的战斗时，您的命中+1' },
      { name: '飞龙探云手', desc: '您参与我方触发的战斗时，若怪物的闪避小于等于2，战斗开始阶段，您抽取每名妨碍者1张手牌' },
    ],
  },
  {
    id: 'XJ102',
    name: '赵灵儿',
    hp: 7,
    power: 3,
    range: 4,
    sex: 2,
    loveById: ['XJ101'],
    skill: [
      { name: '双剑', desc: '您可同时装备两件武器，效果叠加' },
      { name: '梦蛇', desc: '敌方合计拥有3个或以上宠物时，您变身为赵灵儿·梦蛇，当前HP不变' },
    ],
  },
  {
    id: 'XJ103',
    name: '赵灵儿·梦蛇',
    hp: 7,
    power: 4,
    range: 5,
    sex: 2,
    canChoose: false,
    loveById: ['XJ101'],
    skill: [
      { name: '双剑', desc: '您可同时装备两件武器，效果叠加' },
      { name: '女娲', desc: '当您在场时，任意战斗中我方战力额外+2' },
      { name: '变身', desc: '当敌方宠物合计不足3个时，您还原为赵灵儿，当前HP不变' },
    ],
  },
  {
    id: 'XJ104',
    name: '林月如',
    hp: 9,
    power: 2,
    range: 5,
    sex: 2,
    loveById: ['XJ101'],
    skill: [
      { name: '林家剑法', desc: '当您装备任意武器时，战力额外+1' },
      { name: '嫉恶如仇', desc: '您参与任何战斗时，若本方失败，战斗结束阶段，敌方所有参战者HP-1' },
    ],
  },
  {
    id: 'XJ105',
    name: '阿奴',
    hp: 5,
    power: 4,
    range: 2,
    sex: 2,
    loveById: [],
    skill: [
      { name: '鬼灵精', desc: '您的技牌阶段，您可将任意数量的手牌交给一名或多名玩家' },
      { name: '万蛊蚀天', desc: '您的补牌阶段开始时，若您没有手牌，则我方全体玩家补一张牌，之后自己以外的所有角色（包括队友）HP-1' },
    ],
  },
  {
    id: 'XJ106',
    name: '酒剑仙',
    hp: 8,
    power: 5,
    range: 1,
    sex: 1,
    loveById: [],
    skill: [
      { name: '御剑术', desc: '当您装备任意武器时，您的命中额外+1' },
      { name: '醉仙望月步', desc: '您的战斗阶段中，您可以触发两次战斗，若只触发一次战斗，补牌阶段您多补1张牌' },
    ],
  },
  {
    id: 'XJ107',
    name: '拜月教主',
    hp: 8,
    power: 3,
    range: 3,
    sex: 1,
    loveById: ['MO016'],
    skill: [
      { name: '水魔兽合体', desc: '参与水、火属性怪物的战斗时，自身战力+2' },
      { name: '召唤水魔兽', desc: '参战时（无论是否命中），战牌阶段可丢弃2张手牌，我方战力+5。若发动此技能，本场战斗中您不可使用战牌' },
    ],
  },
  {
    id: 'XJ201',
    name: '王小虎',
    hp: 11,
    power: 2,
    range: 3,
    sex: 1,
    loveById: ['XJ202', 'XJ203'],
    skill: [
      { name: '发挥不稳定', desc: '您在战斗开始阶段进行掷骰判定，本场战斗中您的战力=基础战力+骰子点数。6点算作1点' },
      { name: '不屈不饶', desc: '您进行掷骰判定时，若对骰子点数不满意，每丢弃1张手牌或扣减1点HP可重投一次' },
    ],
  },
  {
    id: 'XJ202',
    name: '苏媚',
    hp: 7,
    power: 3,
    range: 3,
    sex: 2,
    loveById: ['XJ201'],
    skill: [
      { name: '狡猾', desc: '您触发战斗时，战斗开始阶段可丢弃此怪牌，重新翻取1张。每回合只能使用一次。若没有选择重新翻取，本次战斗您的战力+1' },
      { name: '拒绝', desc: '您可以将任意特殊类手牌当做【冰心诀】使用' },
    ],
  },
  {
    id: 'XJ203',
    name: '沈欺霜',
    hp: 8,
    power: 3,
    range: 2,
    sex: 2,
    loveById: ['XJ201'],
    skill: [
      { name: '仙霞五奇', desc: '您在场时，若我方支援未命中或没有支援，触发者战力+3。若我方妨碍未命中或没有妨碍，怪物战力+3' },
      { name: '元灵归心术', desc: '在您的技牌阶段，您每丢弃1张技牌，回复任意玩家2点HP' },
    ],
  },
  {
    id: 'XJ204',
    name: '孔璘',
    hp: 10,
    power: 4,
    range: 2,
    sex: 1,
    loveById: [],
    skill: [
      { name: '辣手摧花', desc: '您的技牌阶段，若您的HP大于等于2，您可选定一名在场女性角色，令其与您自己HP各-1，一回合不能对同一角色反复使用' },
      { name: '生命献祭', desc: '您死亡后变为【魔尊】，装备、手牌、宠物保留' },
    ],
  },
  {
    id: 'XJ205',
    name: '魔尊',
    hp: 5,
    power: 8,
    range: 2,
    sex: 1,
    canChoose: false,
    loveById: [],
    skill: [
      { name: '蓄势待发', desc: '您的回合开始阶段，您补充1张手牌' }
    ],
  },
  {
    id: 'XJ302',
    name: '唐雪见',
    hp: 6,
    power: 2,
    range: 4,
    sex: 2,
    loveById: [],
    skill: [
      { name: '追打', desc: '当有玩家HP减少时，您可丢弃1张手牌，本次HP减少的全部玩家（可能包括自己）HP额外-1 ' },
      { name: '连击', desc: '战牌阶段，您每丢弃1张战牌以外的手牌，本次战斗内您的战力+2' },
      { name: '好胜', desc: '您参战时，可在战牌阶段扣减自己2HP后，补2张牌，每场战斗只能使用一次。本伤害隐蛊无效' }
    ],
  },
  {
    id: 'XJ305',
    name: '紫萱',
    hp: 7,
    power: 3,
    range: 4,
    sex: 2,
    loveById: [],
    skill: [
      { name: '关爱', desc: '您在场时，我方每得到一个宠物，您指定一人补充2张手牌' },
      { name: '连击', desc: '您拥有的宠物战力额外+3' },
    ],
  },
];

// elements.id: 1雷 2风 3土 4水 5火；type: 1弱 2强 3boss
// appear/pets/win/lose 为面向玩家的效果文本，逻辑见 rules.js MONSTER_EFFECTS
const monsters = [
  {
    id: 'MO001', name: '积粮隐者', elements: { id: 1, name: '雷' }, power: 3, range: 3, type: 1,
    appear: '', pets: '',
    win: '您指定一名玩家HP+2', lose: '您的HP-3',
  },
  {
    id: 'MO002', name: '赤鬼王', elements: { id: 1, name: '雷' }, power: 8, range: 5, type: 2,
    appear: '支援者在本场战斗中战力+2', pets: '主人在补牌阶段可多补1张牌',
    win: '您指定任意一名玩家补2张牌', lose: '您的HP-2，失去全部装备并补充失去装备数量的手牌',
  },
  {
    id: 'MO005', name: '叶灵', elements: { id: 2, name: '风' }, power: 2, range: 2, type: 1,
    appear: '', pets: '',
    win: '您补1张牌', lose: '您的HP-2',
  },
  {
    id: 'MO008', name: '蝶精', elements: { id: 2, name: '风' }, power: 6, range: 4, type: 3,
    appear: '', pets: '爆发：任意角色HP降到0时，您可以放弃蝶精，令其满HP复活',
    win: '敌方一人HP+2(由敌方任选)', lose: '无',
  },
  {
    id: 'MO009', name: '刑天', elements: { id: 3, name: '土' }, power: 5, range: 3, type: 1,
    appear: '参战者以外的所有角色HP-n，n=持有该角色的玩家手牌数', pets: '主人命中+1',
    win: '无', lose: '无',
  },
  {
    id: 'MO012', name: '天鬼皇', elements: { id: 3, name: '土' }, power: 10, range: 2, type: 3,
    appear: '', pets: '主人战力+2，命中+1',
    win: '无', lose: '如果敌方有土属性宠物，可以选择用天鬼皇替换该宠物',
  },
  {
    id: 'MO013', name: '千杯不醉', elements: { id: 4, name: '水' }, power: 4, range: 4, type: 1,
    appear: '您和一名妨碍者手牌对调', pets: '主人战力+1',
    win: '无', lose: '您的角色横置',
  },
  {
    id: 'MO016', name: '水魔兽', elements: { id: 4, name: '水' }, power: 7, range: 6, type: 3,
    appear: '', pets: '主人战力+1，命中+1',
    win: '敌人全体HP-1，之后您抽取妨碍者1件装备或手牌', lose: '您的HP-2，之后妨碍者抽取您的1件装备或手牌',
  },
  {
    id: 'MO019', name: '狐妖女', elements: { id: 5, name: '火' }, power: 6, range: 1, type: 2,
    appear: '支援者受到伤害，伤害=您（触发者）的战力-1', pets: '主人战力+2',
    win: '妨碍者HP-3', lose: '由敌方指定两名角色HP-3',
  },
  {
    id: 'MO020', name: '熔岩兽王', elements: { id: 5, name: '火' }, power: 10, range: 4, type: 3,
    appear: '全体角色HP-2', pets: '主人战力+2',
    win: '敌方全体HP-2', lose: '您与支援者HP各-2',
  }
];

// 事件牌：effect 逻辑见 rules.js EVENT_EFFECTS
const events = [
  {
    id: 'EV001', name: '仙灵岛的邂逅', num: 2,
    desc: '如果您使用男性角色，则补1张牌后扣1HP；若使用女性角色则弃掉防具，然后可选择一位男性角色，视为对其使用了1张【天雷破】',
  },
  {
    id: 'EV002', name: '深入将军冢', num: 1,
    desc: '在场没有宠物的角色，各补1张牌',
  },
  {
    id: 'EV003', name: '走出圣姑小屋', num: 1,
    desc: '由您指定我方一人和敌方一人各补2张牌',
  },
  {
    id: 'EV005', name: '寻找天使绘卷', num: 1,
    desc: '当前HP小于等于3的玩家，每人补1张牌',
  },
];

// 手牌：type 1特殊牌 2装备牌 3技牌 4战牌；eqvType 1武器 2防具
// 效果逻辑见 rules.js CARD_EFFECTS / EQUIP_STATS
const cards = [
  { id: 1, name: '冰心诀', type: 1, desc: '任意玩家使用技牌、战牌、特殊牌时打出。可令当前打出的这张牌无效', num: 3 },
  { id: 2, name: '灵葫仙丹', type: 1, desc: '您的技牌阶段使用，您自己的HP+2。当有玩家HP为0时使用，可令其复活并恢复2点HP', num: 3 },
  { id: 3, name: '隐蛊', type: 1, desc: '抵消一次您自己受到的HP伤害（倾慕除外）', num: 4 },
  { id: 5, name: '魔刀天吒', type: 2, eqvType: 1, desc: '战力+2', num: 1 },
  { id: 6, name: '无尘剑', type: 2, eqvType: 1, desc: '战力+1，命中+1', num: 1 },
  { id: 8, name: '彩环', type: 2, eqvType: 1, desc: '命中+2', num: 1 },
  { id: 10, name: '五彩霞衣', type: 2, eqvType: 2, desc: '战力+1 爆发：装备后，您HP为0时，可丢弃五彩霞衣，复活并恢复2点HP。', num: 1 },
  { id: 11, name: '乾坤道袍', type: 2, eqvType: 2, desc: '战力+1 装备后，您免疫技牌导致的HP伤害', num: 1 },
  { id: 15, name: '鼠儿果', type: 3, desc: '您指定一人补2张手牌', num: 3 },
  { id: 16, name: '偷盗', type: 3, desc: '您抽取任意玩家的1张手牌', num: 2 },
  { id: 17, name: '铜钱镖', type: 3, desc: '弃掉任意玩家的1张手牌或装备', num: 3 },
  { id: 18, name: '天雷破', type: 3, desc: '您指定一名玩家HP-2（此伤害为雷属性）', num: 3 },
  { id: 21, name: '天玄五音', type: 4, desc: '您指定一方本场战斗中战力+2，未参战亦可使用', num: 8 },
  { id: 22, name: '金蚕王', type: 4, desc: '本场战斗中您的战力+3，参战并命中才会生效', num: 5 },
  { id: 23, name: '天罡战气', type: 4, desc: '本场战斗您的战力（含装备、宠物）加倍。但对战牌、爆发等临时增加的战力无效。参战并命中才会生效。', num: 2 },
  { id: 24, name: '金蝉脱壳', type: 4, desc: '强制结束本场战斗，胜率条件、失败条件皆无效。参战者可使用，即使未命中', num: 2 },
];

module.exports = { characters, monsters, events, cards };
