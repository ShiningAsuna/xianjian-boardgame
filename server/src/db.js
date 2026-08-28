const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = config.DB_FILE || path.join(dataDir, 'xianjian.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ---- 建表 ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- character | monster | event | skill
  name TEXT NOT NULL,
  data TEXT NOT NULL           -- 定义 JSON，引擎读取的唯一事实来源
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,          -- pvp | pve
  size INTEGER NOT NULL,       -- 4 或 6
  winner_faction TEXT,         -- a | b（无胜负则为 NULL）
  ended_reason TEXT,           -- monsters_clear | faction_wiped
  detail TEXT NOT NULL,        -- 各玩家成绩 JSON
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- 卡池导入 seed ----
function seedCards() {
  const def = require('./data/cards');
  const insert = db.prepare(
    'INSERT INTO cards (id, type, name, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  );
  const tx = db.transaction(() => {
    for (const c of def.characters) insert.run(c.id, 'character', c.name, JSON.stringify(c));
    for (const m of def.monsters) insert.run(m.id, 'monster', m.name, JSON.stringify(m));
    for (const e of def.events) insert.run(e.id, 'event', e.name, JSON.stringify(e));
    for (const s of def.skills) insert.run(s.id, 'skill', s.name, JSON.stringify(s));
  });
  tx();
  const n = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
  console.log(`[db] cards seeded: ${n}`);
}

const cardCount = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
if (cardCount === 0) seedCards();

module.exports = db;
