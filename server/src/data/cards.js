// 卡池数据（《游戏规则.md.txt》中定义的四类卡牌）
// type: character 角色牌 / monster 怪兽牌 / event 事件牌 / skill 手牌(技牌)
// skill 分两种用法：equip 挂到场上永久生效；instant 打出后立即结算进弃牌堆
//
// effect 为效果注册表的调用键（见 game/effects.js），是扩展新卡的唯一入口。

const characters = [
  { id: 'char_lixiaoyao',  name: '李逍遥', hp: 12, power: 3, desc: '余杭镇客栈店小二，机缘巧合踏上仙途。' },
  { id: 'char_zhaolinger', name: '赵灵儿', hp: 10, power: 4, desc: '女娲后人，温柔坚韧，可召唤水灵之力。' },
  { id: 'char_linyueru',   name: '林月如', hp: 13, power: 3, desc: '林家堡大小姐，鞭法凌厉，刀子嘴豆腐心。' },
  { id: 'char_anu',        name: '阿奴',   hp: 10, power: 3, desc: '白苗圣女，驯养灵蛊，鬼马精灵。' },
  { id: 'char_jiujianxian',name: '酒剑仙', hp: 11, power: 4, desc: '醉里乾坤大，壶中日月长。' },
  { id: 'char_jingtian',   name: '景天',   hp: 12, power: 3, desc: '永安当伙计，前世为神界将军飞蓬。' },
  { id: 'char_xuejian',    name: '唐雪见', hp: 11, power: 3, desc: '唐门外孙女，脾气火爆，随身不离花楹。' },
  { id: 'char_longkui',    name: '龙葵',   hp: 10, power: 4, desc: '千年等待的公主，红蓝两魂。' },
  { id: 'char_xuzhangqing',name: '徐长卿', hp: 12, power: 3, desc: '蜀山弟子，胸怀天下，情关难渡。' },
  { id: 'char_zixuan',     name: '紫萱',   hp: 11, power: 4, desc: '女娲后裔，三世痴恋，风华绝代。' },
  { id: 'char_wangpengxu', name: '王小虎', hp: 13, power: 2, desc: '盛渔村少年，天生神力。' },
  { id: 'char_shenqixue',  name: '沈欺霜', hp: 11, power: 3, desc: '峨眉弟子，仙霞剑法传人。' },
];

const monsters = [
  // power 为战力；战胜后收为宠物（战力计入阵营总分），战败则执行 penalty
  { id: 'mon_hamster',   name: '仓鼠精',   power: 2, penalty: { key: 'lose_hp', value: 1 }, desc: '偷吃粮仓的小妖怪。' },
  { id: 'mon_monkey',    name: '猴妖',     power: 3, penalty: { key: 'lose_hp', value: 1 }, desc: '手段灵活，劫道惯犯。' },
  { id: 'mon_snakeman',  name: '半人蛇',   power: 4, penalty: { key: 'lose_hp', value: 2 }, desc: '盘踞南诏的水泽之患。' },
  { id: 'mon_ghost',     name: '尸妖',     power: 4, penalty: { key: 'lose_hp', value: 2 }, desc: '怨气不散，行走于夜。' },
  { id: 'mon_tree',      name: '树妖',     power: 5, penalty: { key: 'lose_hp', value: 2 }, desc: '百年成精，根须缠人。' },
  { id: 'mon_toad',      name: '蛤蟆精',   power: 5, penalty: { key: 'lose_hp', value: 2 }, desc: '鼓噪一时的毒物首领。' },
  { id: 'mon_flower',    name: '蝴蝶精彩依', power: 5, penalty: { key: 'lose_hp', value: 2 }, desc: '本是彩蝶，误入妖途。' },
  { id: 'mon_stone',     name: '石长老',   power: 7, penalty: { key: 'lose_hp', value: 3 }, desc: '拜月教护法，石身铁骨。' },
  { id: 'mon_gambling',  name: '赌鬼',     power: 3, penalty: { key: 'discard_1' }, desc: '输了就想赖账的无赖。' },
  { id: 'mon_shadow',    name: '影妖',     power: 6, penalty: { key: 'lose_hp', value: 3 }, desc: '潜行于暗处，无声无息。' },
  { id: 'mon_swordguard',name: '剑冢守卫', power: 6, penalty: { key: 'lose_hp', value: 3 }, desc: '守着万剑归宗秘密的亡魂。' },
  { id: 'mon_fox',       name: '狐妖',     power: 4, penalty: { key: 'discard_1' }, desc: '魅惑众生的九尾一族。' },
  { id: 'mon_dragon',    name: '蛟龙',     power: 8, penalty: { key: 'lose_hp', value: 4 }, desc: '锁妖塔底层最强的凶兽。' },
  { id: 'mon_moonpriest',name: '拜月教徒', power: 3, penalty: { key: 'lose_hp', value: 2 }, desc: '狂信者的执念化作了力量。' },
];

const events = [
  // 回合开始时可以选择摸一张并立即结算
  { id: 'evt_yujianfeixing', name: '御剑飞行', effect: { key: 'draw_cards', value: 2 }, desc: '乘风而起，再抓两张手牌。' },
  { id: 'evt_qiliaoshu',     name: '灵气疗伤', effect: { key: 'heal', value: 2 }, desc: '回复自身 2 点气血。' },
  { id: 'evt_toudan',        name: '妖气反噬', effect: { key: 'lose_hp', value: 1 }, desc: '倒霉！自己损失 1 点气血。' },
  { id: 'evt_lianyunshou',   name: '飞龙探云手', effect: { key: 'draw_cards', value: 1 }, desc: '顺手牵羊，再抓一张牌。' },
  { id: 'evt_zhanqianlijin', name: '战前激励', effect: { key: 'temp_power', value: 1 }, desc: '本次战斗战力 +1（一次性）。' },
  { id: 'evt_longyanbao',    name: '龙岩咆哮', effect: { key: 'damage_others_all', value: 1 }, desc: '其他所有玩家损失 1 点气血。' },
  { id: 'evt_tianjiang',     name: '天降横祸', effect: { key: 'lose_hp', value: 2 }, desc: '屋漏偏逢连夜雨，损失 2 点气血。' },
  { id: 'evt_shanling',      name: '山灵庇佑', effect: { key: 'temp_power', value: 2 }, desc: '本次战斗战力 +2（一次性）。' },
];

const skills = [
  // kind: equip = 装备，挂场持续加成；instant = 用完即弃的一次性技牌
  { id: 'sk_feijian',    name: '御剑术',   kind: 'equip',   effect: { key: 'power_bonus', value: 2 }, desc: '场上装备：战力永久 +2。' },
  { id: 'sk_lingfu',     name: '灵符',     kind: 'equip',   effect: { key: 'power_bonus', value: 1 }, desc: '场上装备：战力永久 +1。' },
  { id: 'sk_jianjue',    name: '万剑诀',   kind: 'instant', effect: { key: 'damage_others_all', value: 2 }, desc: '打出：其他所有玩家损失 2 点气血。' },
  { id: 'sk_shaohong',   name: '烧红印',   kind: 'instant', effect: { key: 'temp_power', value: 2 }, desc: '打出：本次战斗战力 +2（一次性）。' },
  { id: 'sk_qiliao',     name: '气疗术',   kind: 'instant', effect: { key: 'heal', value: 3 }, desc: '打出：回复自身 3 点气血。' },
  { id: 'sk_duanshi',    name: '断石诀',   kind: 'instant', effect: { key: 'buff_and_draw', power: 1, draw: 1 }, desc: '打出：本次战斗 +1 且立即抽 1 张牌。' },
  { id: 'sk_shuihun',    name: '水灵护盾', kind: 'equip',   effect: { key: 'power_bonus', value: 1 }, desc: '场上装备：战力永久 +1。' },
  { id: 'sk_leizhou',    name: '雷咒',     kind: 'instant', effect: { key: 'damage_others_all', value: 1 }, desc: '打出：其他所有玩家损失 1 点气血。' },
];

module.exports = { characters, monsters, events, skills };
