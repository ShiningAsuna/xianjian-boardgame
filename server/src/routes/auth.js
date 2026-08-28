const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, config.JWT_SECRET, { expiresIn: '7d' });
}

// 中间件：校验 Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: '账号不存在' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 2 || username.length > 16) {
    return res.status(400).json({ error: '用户名需要 2-16 个字符' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: '密码至少 4 位' });
  }
  const name = username.trim();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) return res.status(409).json({ error: '用户名已被占用' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, hash);
  const user = { id: Number(info.lastInsertRowid), username: name };
  res.json({ token: signToken(user), user });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const user = { id: row.id, username: row.username };
  res.json({ token: signToken(user), user });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = { router, requireAuth };
