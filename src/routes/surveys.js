const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const Question = require('../models/Question');
const { authRequired } = require('../middleware/auth');
const { validateSurveyForPublish, BadRequestError } = require('../services/questionBuilder');
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
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: '问卷 id 格式错误' });
    return null;
  }
  const survey = await Survey.findById(req.params.id);
  if (!survey) {
    res.status(404).json({ error: '问卷不存在' });
    return null;
  }
  if (String(survey.ownerId) !== req.user.uid) {
    res.status(403).json({ error: '无权访问该问卷' });
    return null;
  }
  return survey;
}

/**
 * 核心辅助函数：将问卷的题目引用与题库中的题目详情合并
 */
async function populateSurveyQuestions(survey) {
  const surveyObj = survey.toObject ? survey.toObject() : survey;
  
  // 强制转换为 ObjectId
  const questionIds = surveyObj.questions.map(q => {
    try { return new mongoose.Types.ObjectId(q.questionId); } catch { return null; }
  }).filter(Boolean);
  
  const dbQuestions = await Question.find({ _id: { $in: questionIds } });
  const qMap = new Map(dbQuestions.map(q => [String(q._id), q]));

  surveyObj.questions = surveyObj.questions.sort((a, b) => a.order - b.order).map(sq => {
    const detail = qMap.get(String(sq.questionId));
    if (!detail) return null;
    return {
      qid: sq.qid, order: sq.order, questionId: String(sq.questionId),
      jumpRules: sq.jumpRules || [],
      title: detail.title, type: detail.type, required: detail.required, options: detail.options || [],
      minSelect: detail.minSelect, maxSelect: detail.maxSelect, minLength: detail.minLength, maxLength: detail.maxLength,
      min: detail.min, max: detail.max, integerOnly: detail.integerOnly,
    };
  }).filter(Boolean);
  return surveyObj;
}

// ============ 列表 / 创建 ============

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
      publicId: await generatePublicId(),
      ownerId: req.user.uid,
      title: String(title).trim(),
      description: String(description || ''),
      allowAnonymous: !!allowAnonymous,
      allowMultipleSubmissions: allowMultipleSubmissions !== false,
      deadline: deadline ? new Date(deadline) : null,
    });
    res.status(201).json({ survey: survey.toOwnerJSON() });
  } catch (e) { next(e); }
});

// ============ 单卷详情 ============

router.get('/:id', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    
    // 组装题目详情后返回
    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
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
    
    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
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

// ============ 题目引用管理 ============

function assertEditable(survey, res) {
  if (survey.status !== 'draft') {
    res.status(400).json({ error: '问卷已发布/关闭，不能再修改题目' });
    return false;
  }
  return true;
}

// 从题库添加题目到问卷
router.post('/:id/questions', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;

    const { questionId } = req.body;
    if (!questionId) return res.status(400).json({ error: '缺少 questionId' });

    // 校验题目是否合法（自己的或者被共享的）
    const q = await Question.findById(questionId);
    if (!q) return res.status(404).json({ error: '题库中不存在该题目' });
    if (String(q.creatorId) !== req.user.uid && !q.isShared) {
      return res.status(403).json({ error: '无权使用该题目' });
    }

    // 生成新序号
    const qid = `q${survey.questions.length + 1}`;
    const order = survey.questions.length + 1;

    // 存入引用
    survey.questions.push({ qid, order, questionId: q._id, jumpRules: [] });
    survey.updatedAt = new Date();
    await survey.save();

    const populated = await populateSurveyQuestions(survey);
    res.status(201).json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
  } catch (e) { next(e); }
});

// 修改问卷内题目的配置（只能改跳转规则，不能改题干内容）
router.put('/:id/questions/:qid', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;

    const idx = survey.questions.findIndex((q) => q.qid === req.params.qid);
    if (idx < 0) return res.status(404).json({ error: '题目不存在' });

    // 第二阶段：题干内容从题库读，问卷里只改 jumpRules
    const { jumpRules } = req.body;
    if (jumpRules !== undefined) {
      survey.questions[idx].jumpRules = jumpRules;
    }

    survey.updatedAt = new Date();
    await survey.save();

    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
  } catch (e) { next(e); }
});

// 从问卷移除题目
router.delete('/:id/questions/:qid', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey || !assertEditable(survey, res)) return;

    const target = req.params.qid;
    if (!survey.questions.some((q) => q.qid === target)) return res.status(404).json({ error: '题目不存在' });

    survey.questions.pull({ qid: target });
    
    // 清理其它题目指向被删题目的跳转规则
    for (const q of survey.questions) {
      q.jumpRules = (q.jumpRules || []).filter((r) => r.targetQid !== target);
    }
    
    // 重新排序并更新 qid (可选，如果不更新 qid，直接重排 order 也可以)
    [...survey.questions].sort((a, b) => a.order - b.order).forEach((q, i) => { q.order = i + 1; });

    survey.updatedAt = new Date();
    await survey.save();

    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
  } catch (e) { next(e); }
});

// ============ 发布 / 关闭 / 统计 ============

router.post('/:id/publish', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    if (survey.status === 'closed') return res.status(400).json({ error: '问卷已关闭，不能重新发布' });
    if (survey.questions.length === 0) return res.status(400).json({ error: '问卷至少需要一道题目才能发布' });

    // 环检测（依赖 survey.questions 里的 jumpRules 和 qid）
    const errors = validateSurveyForPublish(survey);
    if (errors.length) return res.status(400).json({ error: '跳转规则校验未通过', details: errors });

    survey.status = 'published';
    survey.publishedAt = survey.publishedAt || new Date();
    survey.updatedAt = new Date();
    await survey.save();
    
    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
  } catch (e) { next(e); }
});

router.post('/:id/close', async (req, res, next) => {
  try {
    const survey = await loadOwned(req, res);
    if (!survey) return;
    survey.status = 'closed';
    survey.updatedAt = new Date();
    await survey.save();
    
    const populated = await populateSurveyQuestions(survey);
    res.json({ survey: { ...survey.toOwnerJSON(), questions: populated.questions } });
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
    
    // 统计单个题目时，需要去题库拿一下题目详情
    const surveyQ = survey.questions.find((x) => x.qid === req.params.qid);
    if (!surveyQ) return res.status(404).json({ error: '题目不存在' });
    
    const detail = await Question.findById(surveyQ.questionId);
    if (!detail) return res.status(404).json({ error: '题库中的题目已被删除' });

    res.json(await getQuestionStats(survey._id, { ...detail.toObject(), qid: surveyQ.qid }));
  } catch (e) { next(e); }
});

module.exports = router;