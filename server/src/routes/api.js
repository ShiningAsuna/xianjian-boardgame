const express = require('express');
const db = require('../db');
const hub = require('../hub');
const { requireAuth } = require('./auth');

const router = express.Router();

// 卡池目录（前端图鉴/说明用）
router.get('/cards', (_req, res) => {
  const rows = db.prepare('SELECT id, type, name, data FROM cards ORDER BY type, name').all();
  res.json(rows.map((r) => {
    const d = JSON.parse(r.data);
    return { ...d, type: r.type, type2: typeof d.type === 'number' ? d.type : null };
  }));
});

// 大厅：等待中的房间列表（前端每 3 秒轮询）
router.get('/rooms', (_req, res) => {
  res.json(hub.listRooms());
});

// 创建房间
router.post('/rooms', requireAuth, (req, res) => {
  const { size, mode, name, pickConfig } = req.body || {};
  const sizeNum = Number(size) === 6 ? 6 : 4;
  res.json(hub.createRoom(req.user, { size: sizeNum, mode, name, pickConfig }));
});

// 对局历史
router.get('/matches', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM matches ORDER BY id DESC LIMIT 30').all();
  res.json(rows.map((r) => ({
    ...r,
    detail: JSON.parse(r.detail),
    ended_at: r.ended_at,
  })));
});

module.exports = router;
