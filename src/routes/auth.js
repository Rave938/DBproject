const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function sign(user) {
  return jwt.sign(
    { uid: user._id.toString(), username: user.username },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const name = String(username).trim();
    if (name.length < 3 || name.length > 32) return res.status(400).json({ error: '用户名长度需为 3~32 个字符' });
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (await User.exists({ username: name })) return res.status(409).json({ error: '用户名已存在' });

    const user = await User.create({ username: name, passwordHash: await User.hashPassword(String(password)) });
    res.status(201).json({ token: sign(user), user: user.toSafeJSON() });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: '用户名已存在' });
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

    const user = await User.findOne({ username: String(username).trim() });
    if (!user || !(await user.verifyPassword(String(password)))) return res.status(401).json({ error: '用户名或密码错误' });
    res.json({ token: sign(user), user: user.toSafeJSON() });
  } catch (e) { next(e); }
});

router.get('/me', authRequired, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.uid);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    res.json({ user: user.toSafeJSON() });
  } catch (e) { next(e); }
});

module.exports = router;