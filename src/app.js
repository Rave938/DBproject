require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/questions', require('./routes/questions')); // 新增题库路由
app.use('/api/stats', require('./routes/stats'));         // 新增跨卷统计路由
app.use('/api/surveys', require('./routes/surveys'));
app.use('/api/public', require('./routes/public'));

app.get('/survey/:publicId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'fill.html'));
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (err.name === 'ValidationError') return res.status(400).json({ error: '数据校验失败', details: Object.values(err.errors).map((e) => e.message) });
  if (err.name === 'CastError') return res.status(400).json({ error: '参数格式错误' });
  if (err.code === 11000) return res.status(409).json({ error: '数据重复', details: err.keyValue });
  if (err.status) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: '服务器内部错误' });
});

module.exports = app;