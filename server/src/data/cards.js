// 卡池数据（《游戏规则.md.txt》中定义的四类卡牌）
// type: character 角色牌 / monster 怪兽牌 / event 事件牌 / cards 手牌
// skill 分两种用法：equip 挂到场上永久生效；instant 打出后立即结算进弃牌堆
//
// effect 为技能函数

const characters = [
  {
    id: "XJ101",
    name: "李逍遥",
    hp: 8,
    power: 4,
    range: 3,
    sex: 1,
    loveById: ["XJ102", "XJ103", "XJ104", "XJ105"],
    loveByName: ["赵灵儿", "林月如", "阿奴"],
    skill: [
      {
        name: "侠骨柔肠",
        desc: "您支援女性角色触发的战斗时，您的命中+1",
        optional: false, // 强制发动，不需要询问
        trigger: ['battleStart'],
        cost: null,
        effect(self, ctx, game) {
          // 判断是否是战斗触发者，且支援者是女性
          if (1) {
            self.range += 1
            game.registerTrigger('battleEnd', (self, ctx, game) => {
              self.range -= 1
            })
          }
        }
      },
      {
        name: "飞龙探云手",
        desc: "您参与我方触发的战斗时，若怪物的闪避小于等于2，战斗开始阶段，您抽取每名妨碍者1张手牌",
      },
    ],
  },
  {
    id: "XJ102",
    name: "赵灵儿",
    hp: 7,
    power: 3,
    range: 4,
    sex: 2,
    loveById: ["XJ101"],
    loveByName: ["李逍遥"],
    skill: [
      {
        name: "双剑",
        desc: "您可同时装备两件武器，效果叠加",
      },
      {
        name: "梦蛇",
        desc: "敌方合计拥有3个或以上宠物时，您变身为赵灵儿（梦蛇），当前HP不变",
      },
    ],
  },
  {
    id: "XJ103",
    name: "赵灵儿·梦蛇",
    hp: 7,
    power: 4,
    range: 5,
    sex: 2,
    loveById: ["XJ101"],
    loveByName: ["李逍遥"],
    skill: [
      {
        name: "双剑",
        desc: "您可同时装备两件武器，效果叠加",
      },
      {
        name: "女娲",
        desc: "当您在场时，任意战斗中我方战力额外+2",
      },
      {
        name: "变身",
        desc: "当敌方宠物合计不足3个时，您还原为赵灵儿，当前HP不变",
      },
    ],
  },
  {
    id: "XJ104",
    name: "林月如",
    hp: 9,
    power: 2,
    range: 5,
    sex: 2,
    loveById: ["XJ101"],
    loveByName: ["李逍遥"],
    skill: [
      {
        name: "林家剑法",
        desc: "当您装备任意武器时，战力额外+1",
      },
      {
        name: "嫉恶如仇",
        desc: "您参与任何战斗时，若本方失败，战斗结束阶段，敌方所有参战者HP-1",
      },
    ],
  },
  {
    id: "XJ105",
    name: "阿奴",
    hp: 5,
    power: 4,
    range: 2,
    sex: 2,
    loveById: [],
    loveByName: [],
    skill: [
      {
        name: "鬼灵精",
        desc: "您的技牌阶段，您可将任意数量的手牌交给一名或多名玩家",
      },
      {
        name: "万蛊蚀天",
        desc: "您的补牌阶段开始时，若您没有手牌，则我方全体玩家补一张牌，之后自己以外的所有角色（包括队友）HP-1",
      },
    ],
  },
  {
    id: "XJ106",
    name: "酒剑仙",
    hp: 8,
    power: 5,
    range: 1,
    sex: 1,
    loveById: [],
    loveByName: [],
    skill: [
      {
        name: "御剑术",
        desc: "当您装备任意武器时，您的命中额外+1",
      },
      {
        name: "醉仙望月步",
        desc: "您的战斗阶段中，您可以触发两次战斗，若只触发一次战斗，补牌阶段您多补1张牌",
      },
    ],
  },
];

// 怪物的type：1弱，2强，3boss
// elements: 1:雷属性 2:风属性 3:土属性 4:水属性 5:火属性
const monsters = [
  {
    id: 'MO001',
    name: '积粮隐者',
    elements: {
      id: 1,
      name: '雷'
    },
    power: 3,
    range: 3,
    type: 1,
    appear: '',
    pets: '',
    win: '您指定一名玩家HP+2',
    lose: '您的HP-3',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO002',
    name: '赤鬼王',
    elements: {
      id: 1,
      name: '雷'
    },
    power: 8,
    range: 5,
    type: 2,
    appear: '支援者在本场战斗中战力+2',
    pets: '主人在补牌阶段可多补1张牌',
    win: '您指定任意一名玩家补2张牌',
    lose: '您的HP-2，失去全部装备并补充失去装备数量的手牌',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO005',
    name: '叶灵',
    elements: {
      id: 2,
      name: '风'
    },
    power: 2,
    range: 2,
    type: 1,
    appear: '',
    pets: '',
    win: '您补1张牌',
    lose: '您的HP-2',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO008',
    name: '蝶精',
    elements: {
      id: 2,
      name: '风'
    },
    power: 6,
    range: 4,
    type: 3,
    appear: '',
    pets: '爆发：任意角色HP降到0时，您可以放弃蝶精，令其满HP复活',
    win: '敌方一人HP+2(由敌方任选)',
    lose: '无',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO009',
    name: '刑天',
    elements: {
      id: 3,
      name: '土'
    },
    power: 5,
    range: 3,
    type: 1,
    appear: '参战者以外的所有角色HP-n，n=持有该角色的玩家手牌数',
    pets: '主人命中+1',
    win: '无',
    lose: '无',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO012',
    name: '天鬼皇',
    elements: {
      id: 3,
      name: '土'
    },
    power: 10,
    range: 2,
    type: 3,
    appear: '',
    pets: '主人战力+2，命中+1',
    win: '无',
    lose: '如果敌方有土属性宠物，可以选择用天鬼皇替换该宠物',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO013',
    name: '千杯不醉',
    elements: {
      id: 4,
      name: '水'
    },
    power: 4,
    range: 4,
    type: 1,
    appear: '您和一名妨碍者手牌对调',
    pets: '主人战力+1',
    win: '无',
    lose: '您的角色横置',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
  {
    id: 'MO020',
    name: '熔岩兽王',
    elements: {
      id: 5,
      name: '火'
    },
    power: 10,
    range: 4,
    type: 3,
    appear: '全体角色HP-2',
    pets: '主人战力+2',
    win: '敌方全体HP-2',
    lose: '您与支援者HP各-2',
    appearHandler(){},
    winHandler(){},
    loseHandler(){}
  },
];

// num为该种类卡牌数量
const events = [
  {
    id: 'EV001',
    name: "仙灵岛的邂逅",
    effect: (self, ctx, game) {
          if (self.sex === 1) {
            self.hp -= 1
            game.drawCard(self, 1)
          } else {
            
          }
        },
    desc: "如果您使用男性角色，则补1张牌后扣1HP；若使用女性角色则弃掉防具，然后可选择一位男性角色，视为对其使用了1张【天雷破】",
    num: 2
  },
  {
    id: 'EV002',
    name: "深入将军冢",
    effect: (self, ctx, game) {
        },
    desc: "在场没有宠物的角色，各补1张牌",
    num: 1
  },
  {
    id: 'EV003',
    name: "走出圣姑小屋",
    effect: (self, ctx, game) {
        },
    desc: "由您指定我方一人和敌方一人各补2张牌",
    num: 1
  },
  {
    id: 'EV005',
    name: "寻找天使绘卷",
    effect: (self, ctx, game) {
        },
    desc: "当前HP小于等于3的玩家，每人补1张牌",
    num: 1
  },
];

// num为该种类卡牌数量
// type: 1特殊牌 2装备牌 3技牌 4战牌
// eqvType: 1武器牌，2防具牌，同类型最多装备一个
const cards = [
  {
    id: 1,
    name: "冰心诀",
    type: 1
    effect(self, ctx, game){
      
    },
    desc: "任意玩家使用技牌、战牌、特殊牌时打出。可令当前打出的这张牌无效",
    num: 3
  },
  {
    id: 2,
    name: "灵葫仙丹",
    type: 1
    effect(self, ctx, game){
      
    },
    desc: "您的技牌阶段使用，您自己的HP+2。当有玩家HP为0时使用，可令其复活并恢复2点HP",
    num: 3
  },
  {
    id: 3,
    name: "隐蛊",
    type: 1
    effect(self, ctx, game){
      
    },
    desc: "抵消一次您自己受到的HP伤害（倾慕除外）",
    num: 4
  },
  {
    id: 5,
    name: "魔刀天吒",
    type: 2,
    eqvType: 1,
    effect(self, ctx, game){
      
    },
    desc: "战力+2",
    num: 1
  },
  {
    id: 6,
    name: "无尘剑",
    type: 2,
    eqvType: 1,
    effect(self, ctx, game){
      
    },
    desc: "战力+1",
    num: 1
  },
  {
    id: 8,
    name: "彩环",
    type: 2,
    eqvType: 1,
    effect(self, ctx, game){
      
    },
    desc: "命中+2",
    num: 1
  },
  {
    id: 10,
    name: "五彩霞衣",
    type: 2,
    eqvType: 2,
    effect(self, ctx, game){
      
    },
    desc: "战力+1 爆发：装备后，您HP为0时，可丢弃五彩霞衣，复活并恢复2点HP。",
    num: 1
  },
  {
    id: 11,
    name: "乾坤道袍",
    type: 2,
    eqvType: 2,
    effect(self, ctx, game){
      
    },
    desc: "战力+1 装备后，您免疫技牌导致的HP伤害",
    num: 1
  },
  {
    id: 15,
    name: "鼠儿果",
    type: 3,
    effect(self, ctx, game){
      
    },
    desc: "您指定一人补2张手牌",
    num: 3
  },
  {
    id: 16,
    name: "偷盗",
    type: 3,
    effect(self, ctx, game){
      
    },
    desc: "您抽取任意玩家的1张手牌",
    num: 2
  },
  {
    id: 17,
    name: "铜钱镖",
    type: 3,
    effect(self, ctx, game){
      
    },
    desc: "弃掉任意玩家的1张手牌或装备",
    num: 3
  },
  {
    id: 18,
    name: "天雷破",
    type: 3,
    effect(self, ctx, game){
      
    },
    desc: "您指定一名玩家HP-2（此伤害为雷属性）",
    num: 3
  },
  {
    id: 21,
    name: "天玄五音",
    type: 4,
    effect(self, ctx, game){
      
    },
    desc: "您指定一方本场战斗中战力+2，未参战亦可使用",
    num: 8
  },
  {
    id: 22,
    name: "金蚕王",
    type: 4,
    effect(self, ctx, game){
      
    },
    desc: "本场战斗中您的战力+3，参战并命中才会生效",
    num: 5
  },
  {
    id: 23,
    name: "天罡战气",
    type: 4,
    effect(self, ctx, game){
      
    },
    desc: "本场战斗您的战力（含装备、宠物）加倍。但对战牌、爆发等临时增加的战力无效。参战并命中才会生效。",
    num: 2
  },
  {
    id: 24,
    name: "金蝉脱壳",
    type: 4,
    effect(self, ctx, game){
      
    },
    desc: "强制结束本场战斗，胜率条件、失败条件皆无效。参战者可使用，即使未命中",
    num: 2
  }
];

module.exports = { characters, monsters, events, cards };
