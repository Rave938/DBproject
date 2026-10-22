const jwt = require('jsonwebtoken');

function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function verify(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
  } catch {
    return null;
  }
}

function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: '请先登录' });
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  req.user = { uid: payload.uid, username: payload.username };
  next();
}

function authOptional(req, res, next) {
  const token = readToken(req);
  if (token) {
    const payload = verify(token);
    if (payload) req.user = { uid: payload.uid, username: payload.username };
  }
  next();
}

module.exports = { authRequired, authOptional };