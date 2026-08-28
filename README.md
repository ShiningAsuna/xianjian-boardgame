# 仙剑奇侠传 · 逍遥游 —— 在线卡牌游戏框架

一个可运行的多人在线卡牌对战框架，规则取自本目录《**游戏规则.md.txt**》（仙剑奇侠传·逍遥游）。

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vue 3 + Vite + Pinia + Vue Router + Socket.IO Client | 登录/大厅/图鉴/对局四页面 |
| 后端 | Node.js + Express + Socket.IO | REST API + 实时对战通信 |
| 数据库 | better-sqlite3 | 单文件库 `server/data/xianjian.db`，自动建表+导入卡池 |

## 快速开始

```bash
# 1) 安装依赖（服务端 & 客户端）
npm run setup

# 2) 开发模式：同时启动后端(3000)与前端(5173)
npm run dev
```

打开 <http://localhost:5173> 注册账号 → 创建房间 → 开始对局。
人数不满时由"人机"补位，单人也可以完整跑通整局流程。

生产模式（可选）：

```bash
npm run build   # 构建 client/dist
npm start       # 由 Express 直接托管静态页面，访问 http://localhost:3000
```

## 已实现的规则（《游戏规则.md.txt》）

- **4/6 人、双阵营**（蜀山派 vs 拜月教），按座位交替入队，两阵营玩家轮流行动；
- 开局**掷骰子**决定先攻阵营，先攻方随机指定一名玩家为 1 号玩家；
- 卡牌四类：**角色牌 / 怪兽牌 / 事件牌 / 手牌（技牌=装备+技法）**，全部在 `server/src/data/cards.js` 中定义并入库；
- 每回合四阶段：
  - **事件阶段**：可选抽取一张事件牌立即结算；
  - **技牌阶段**：打出装备（挂场永久加成）/ 技法（即时生效）；
  - **战斗阶段**：翻开怪兽牌，`角色战力+装备加成+临时加成 > 怪兽战力` 则收为宠物，否则执行战斗失败惩罚；平局按失败处理；
  - **补牌阶段**：自动补至手牌上限（5 张）后结束回合；
- 玩家阵亡后跳过行动序列（宠物分仍计入阵营）；若一方全员阵亡则另一方直接获胜；
- 胜利条件：**怪兽翻完后比双方宠物战力总和**，或一方阵营全灭。终局写入 `matches` 表并在大厅可查战绩。

## 目录结构

```
xianjian/
├─ 游戏规则.md.txt            # 规则文档（需求来源）
├─ package.json               # 根目录一键启动脚本
├─ server/                    # Node.js 后端
│  ├─ data/xianjian.db        # SQLite 数据文件（自动生成）
│  └─ src/
│     ├─ index.js             # Express + Socket.IO 入口
│     ├─ config.js            # 端口/密钥/游戏常量
│     ├─ db.js                # better-sqlite3 连接、建表、卡池 seed
│     ├─ hub.js / rooms.js    # 房间管理器（等待/开局/重连/托管）
│     ├─ socket.js            # 实时事件层（join/start/game_action）
│     ├─ routes/              # auth 认证 + api（卡池/房间/战绩）
│     └─ game/
│        ├─ engine.js         # 《逍遥游》引擎：座位/牌堆/四阶段/胜利判定
│        └─ effects.js        # 效果注册表（新卡效果在此扩展）
└─ client/                    # Vue3 前端
   └─ src/
      ├─ views/               # Login / Lobby / Codex / Game
      ├─ components/          # CardFace 卡面、SeatPanel 座位
      └─ stores/              # Pinia：auth、game(socket 状态中心)
```

## 关键设计

- **状态权威在服务端**：所有动作经 `game_action` 事件提交给引擎校验，前端只渲染广播的裁剪视图（对手手牌不泄露）。
- **断线托管与重连**：对局中掉线的真人座位转为系统代管，逻辑与人机一致；重新进入 `/game/:id` 即回原对局。
- **扩展点**：
  - 新卡：在 `server/src/data/cards.js` 加定义即可（自动 seed 进库，`effects.js` 里如缺新 key 补注册即可）；
  - 新玩法/换规则：仿照 `game/engine.js` 另写引擎类，替换 `rooms.js` 中的实例化即可。

## API 一览

REST：`POST /api/auth/register|login` · `GET /api/auth/me` · `GET /api/cards` · `GET|POST /api/rooms` · `GET /api/matches`

Socket.IO（握手带 token）：`room_join` / `room_leave` / `start_game` / `game_action{draw_event|skip_event|play_card|go_battle|flip_monster|finish_turn}` ← 服务端推送 `room_info`、`game_state`、`action_error`

> 默认 JWT 密钥写在 `server/src/config.js`，正式部署请改用环境变量 `JWT_SECRET`。

## 本机环境备注（Windows / 无 Visual Studio）

`better-sqlite3` 是原生模块，`npm install` 时会先尝试下载预编译二进制，失败则回退源码编译（需要 VS C++ 工具链）。本机网络下载 GitHub 预编译包容易中断，**当前 `server/node_modules` 已装好可用的二进制，请勿整体删除重装**。

如确需重装依赖，按下面步骤恢复 better-sqlite3：

```bash
cd server
npm install --ignore-scripts
cd node_modules/better-sqlite3
curl -sSL -o bs3.tar.gz https://registry.npmmirror.com/-/binary/better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz
tar -xzf bs3.tar.gz && del bs3.tar.gz
```

验证：`node -e "require('better-sqlite3'); console.log('ok')"`（在 server 目录下执行）。

另附端到端测试脚本（自动注册账号→开人机房→打完整局→校验战绩入库）：

```bash
# 服务端用小牌堆启动可加速测试
set XJ_MONSTER_DECK_COPIES=1&& node src/index.js
# 另开终端
node scripts/smoke.js
```
