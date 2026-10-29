const express = require('express');
const mongoose = require('mongoose'); // 引入 mongoose
const Survey = require('../models/Survey');
const SurveyResponse = require('../models/SurveyResponse');
const Question = require('../models/Question');
const { authOptional } = require('../middleware/auth');
const { validateAnswer, resolveNext, walkSurvey } = require('../services/logic');

const router = express.Router();

async function publicView(survey) {
  // 强制转换为 ObjectId，防止数据格式不匹配导致查不到详情
  const qIds = survey.questions.map(q => {
    try { return new mongoose.Types.ObjectId(q.questionId); } catch { return null; }
  }).filter(Boolean);
  
  const dbQuestions = await Question.find({ _id: { $in: qIds } });
  const qMap = new Map(dbQuestions.map(q => [String(q._id), q]));

  return {
    publicId: survey.publicId, title: survey.title, description: survey.description,
    allowAnonymous: survey.allowAnonymous, allowMultipleSubmissions: survey.allowMultipleSubmissions,
    status: survey.effectiveStatus(), deadline: survey.deadline,
    questions: survey.sortedQuestions().map(sq => {
      const detail = qMap.get(String(sq.questionId));
      if (!detail) {
        // 如果没查到，打印错误日志帮助排查
        console.error(`[publicView] 警告: 无法在题库中找到题目 ID ${sq.questionId}`);
        return null;
      }
      return {
        qid: sq.qid, 
        order: sq.order, 
        title: detail.title, 
        type: detail.type, 
        required: detail.required,
        options: detail.options || [], 
        minSelect: detail.minSelect, 
        maxSelect: detail.maxSelect,
        minLength: detail.minLength, 
        maxLength: detail.maxLength, 
        min: detail.min, 
        max: detail.max, 
        integerOnly: detail.integerOnly,
        jumpRules: sq.jumpRules || []
      };
    }).filter(Boolean)
  };
}

async function findOpen(req, res) {
  const survey = await Survey.findOne({ publicId: req.params.publicId });
  if (!survey) { res.status(404).json({ error: '问卷不存在' }); return null; }
  const eff = survey.effectiveStatus();
  if (eff !== 'published') { res.status(400).json({ error: eff === 'closed' ? '问卷已关闭/已过截止时间' : '问卷尚未发布' }); return null; }
  return survey;
}

router.get('/surveys/:publicId', authOptional, async (req, res, next) => {
  try {
    const survey = await Survey.findOne({ publicId: req.params.publicId });
    if (!survey) return res.status(404).json({ error: '问卷不存在' });
    const view = await publicView(survey);
    res.json({ survey: view, requiresLogin: !survey.allowAnonymous, loggedIn: !!req.user });
  } catch (e) { next(e); }
});

router.post('/surveys/:publicId/validate-answer', authOptional, async (req, res, next) => {
  try {
    const survey = await findOpen(req, res);
    if (!survey) return;
    const { qid, value } = req.body || {};
    const sq = survey.questions.find((x) => x.qid === qid);
    if (!sq) return res.status(400).json({ error: '题目不存在' });
    
    const detail = await Question.findById(sq.questionId);
    if (!detail) return res.status(404).json({ error: '题库缺失' });

    const q = { ...detail.toObject(), qid: sq.qid, jumpRules: sq.jumpRules || [] };
    const v = validateAnswer(q, value);
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });

    const nextQid = resolveNext(q, v.hasValue ? v.normalized : null, survey.sortedQuestions().map(s => ({ qid: s.qid })));
    res.json({ ok: true, hasValue: v.hasValue, nextQid });
  } catch (e) { next(e); }
});

router.post('/surveys/:publicId/responses', authOptional, async (req, res, next) => {
  try {
    const survey = await findOpen(req, res);
    if (!survey) return;

    const { answers, isAnonymous: clientSelectedAnonymous } = req.body || {};
    let respondentId = null, isAnonymous = false;

    if (!req.user && !survey.allowAnonymous) return res.status(401).json({ error: '该问卷要求登录后才能填写' });
    if (!req.user) { isAnonymous = true; respondentId = null; }
    else {
      if (survey.allowAnonymous && clientSelectedAnonymous === true) { isAnonymous = true; respondentId = null; }
      else { isAnonymous = false; respondentId = req.user.uid; }
    }

    if (respondentId && !survey.allowMultipleSubmissions) {
      const exists = await SurveyResponse.exists({ surveyId: survey._id, respondentId });
      if (exists) return res.status(409).json({ error: '该问卷不允许重复提交' });
    }

    const result = await walkSurvey(survey.questions, answers || {}); 
    if (result.errors.length) return res.status(400).json({ error: '答案校验未通过', details: result.errors, visited: result.visited });

    const doc = await SurveyResponse.create({ surveyId: survey._id, respondentId, isAnonymous, answers: result.answers, visitedQids: result.visited });
    await Survey.updateOne({ _id: survey._id }, { $inc: { responseCount: 1 } });

    res.status(201).json({ ok: true, responseId: doc._id, visited: result.visited, ignoredAnswers: result.ignoredAnswers });
  } catch (e) { next(e); }
});

module.exports = router;