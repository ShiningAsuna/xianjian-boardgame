// 全局配置：后续可改为读取 .env
module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'xianjian-dev-secret-change-me',
  DB_FILE: process.env.DB_FILE || null, // null 时使用默认路径 server/data/xianjian.db

  // 游戏常量（《游戏规则.md》）
  GAME_SIZES: [4, 6],      // 支持的游戏人数
  // 手牌/补牌等规则常量已收敛进 game/engine.js（HAND_START=3 / HAND_KEEP=3 / DRAW_PER_TURN=2）
  // 角色抽取数量等房间配置由创建房间时传入（rooms.pickConfig），引擎内做合法性收敛

  FACTIONS: [
    { key: 'a', name: '蜀山派' },
    { key: 'b', name: '拜月教' },
  ],
};
