// 全局配置：后续可改为读取 .env
module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'xianjian-dev-secret-change-me',
  DB_FILE: process.env.DB_FILE || null, // null 时使用默认路径 server/data/xianjian.db

  // 游戏常量（《游戏规则.md.txt》）
  GAME_SIZES: [4, 6],      // 支持的游戏人数
  HAND_LIMIT: 5,           // 手牌上限（补牌阶段补到此数）
  INITIAL_HAND: 3,         // 开局手牌数
  // 牌堆复制份数：可用环境变量缩小以加速测试，默认按规则配置
  MONSTER_DECK_COPIES: Number(process.env.XJ_MONSTER_DECK_COPIES) || 2,
  EVENT_DECK_COPIES: Number(process.env.XJ_EVENT_DECK_COPIES) || 1,

  FACTIONS: [
    { key: 'a', name: '蜀山派' },
    { key: 'b', name: '拜月教' },
  ],
};
