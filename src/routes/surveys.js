const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const { authRequired } = require('../middleware/auth');
const { buildQuestion, nextQid, validateSurveyForPublish, BadRequestError } = require('../services/questionBuilder');
const { getSurveyStats, getQuestionStats } = require('../services/stats');

const router = express.Router();
router.use(authRequired);

async function generatePublicId() {
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    if (!(await Survey.exists({ publicId: id }))) return id;
  }
  throw new Error('无法生成唯一问卷链接');
}

async function loadOwned(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ error: '问卷 id 格式错误' }); return null; }
  const survey = await Survey.findById(req.params.id);
  if (!survey) { res.status(404).json({ error: '问卷不存在' }); return null; }
  if (String(survey.ownerId) !== req.user.uid) { res.status(403).json({ error: '无权访问该问卷' }); return null; }
  return survey;
}

router.get('/', async (req, res, next) => {
  try {
    const list = await Survey.find({ ownerId: req.user.uid }).sort({ createdAt: -1 });
    res.json({ surveys: list.map((s) => s.toListJSON()) });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { title, description = '', allowAnonymous = false, allowMultipleSubmissions = true, deadline = null } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: '问卷标题不能为空' });
    const survey = await Survey.create({
      publicId: await generatePublicId(), ownerId: req.user.uid, title: String(title).trim(),
      description: String(description || ''), allowAnonymous: !!allowAnonymous,
      allowMultipleSubmissions: allowMultipleSubmissions !== false, deadline: deadline ? new Date(deadline) : null,
    });
    res.status(201).json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    const { title, description, allowAnonymous, allowMultipleSubmissions, deadline } = req.body || {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: '问卷标题不能为空' });
      survey.title = String(title).trim();
    }
    if (description !== undefined) survey.description = String(description || '');
    if (allowAnonymous !== undefined) survey.allowAnonymous = !!allowAnonymous;
    if (allowMultipleSubmissions !== undefined) survey.allowMultipleSubmissions = !!allowMultipleSubmissions;
    if (deadline !== undefined) survey.deadline = deadline ? new Date(deadline) : null;

    survey.updatedAt = new Date();
    await survey.save();
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    if (survey.status === 'published') return res.status(400).json({ error: '已发布的问卷不能删除，请先关闭' });
    await Survey.deleteOne({ _id: survey._id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function assertEditable(survey, res) {
  if (survey.status !== 'draft') { res.status(400).json({ error: '问卷已发布/关闭，不能再修改题目' }); return false; }
  return true;
}

router.post('/:id/questions', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;
    const qid = nextQid(survey);
    const order = survey.questions.length + 1;
    const question = buildQuestion(req.body || {}, qid, order);
    survey.questions.push(question);
    survey.updatedAt = new Date();
    await survey.save();
    res.status(201).json({ survey: survey.toOwnerJSON(), question });
  } catch (e) {
    if (e instanceof BadRequestError) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.put('/:id/questions/:qid', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;
    const idx = survey.questions.findIndex((q) => q.qid === req.params.qid);
    if (idx < 0) return res.status(404).json({ error: '题目不存在' });

    const oldOrder = survey.questions[idx].order;
    const rebuilt = buildQuestion(req.body || {}, req.params.qid, oldOrder);
    survey.questions.set(idx, rebuilt);
    survey.updatedAt = new Date();
    await survey.save();
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) {
    if (e instanceof BadRequestError) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.delete('/:id/questions/:qid', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;
    const target = req.params.qid;
    if (!survey.questions.some((q) => q.qid === target)) return res.status(404).json({ error: '题目不存在' });

    survey.questions.pull({ qid: target });
    for (const q of survey.questions) {
      q.jumpRules = (q.jumpRules || []).filter((r) => r.targetQid !== target);
    }
    [...survey.questions].sort((a, b) => a.order - b.order).forEach((q, i) => { q.order = i + 1; });

    survey.updatedAt = new Date();
    await survey.save();
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.post('/:id/publish', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    if (survey.status === 'closed') return res.status(400).json({ error: '问卷已关闭，不能重新发布' });
    if (survey.questions.length === 0) return res.status(400).json({ error: '问卷至少需要一道题目才能发布' });

    const errors = validateSurveyForPublish(survey);
    if (errors.length) return res.status(400).json({ error: '跳转规则校验未通过', details: errors });

    survey.status = 'published';
    survey.publishedAt = survey.publishedAt || new Date();
    survey.updatedAt = new Date();
    await survey.save();
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.post('/:id/close', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    survey.status = 'closed';
    survey.updatedAt = new Date();
    await survey.save();
    res.json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

router.get('/:id/stats', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    res.json(await getSurveyStats(survey));
  } catch (e) { next(e); }
});

router.get('/:id/stats/:qid', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    const q = survey.questions.find((x) => x.qid === req.params.qid);
    if (!q) return res.status(404).json({ error: '题目不存在' });
    res.json(await getQuestionStats(survey._id, q));
  } catch (e) { next(e); }
});

module.exports = router;