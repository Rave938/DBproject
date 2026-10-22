const express = require('express');
const Survey = require('../models/Survey');
const SurveyResponse = require('../models/SurveyResponse');
const { authOptional } = require('../middleware/auth');
const { validateAnswer, resolveNext, walkSurvey } = require('../services/logic');

const router = express.Router();

function publicView(survey) {
  return {
    publicId: survey.publicId, title: survey.title, description: survey.description,
    allowAnonymous: survey.allowAnonymous, allowMultipleSubmissions: survey.allowMultipleSubmissions,
    status: survey.effectiveStatus(), deadline: survey.deadline,
    questions: survey.sortedQuestions().map((q) => ({
      qid: q.qid, order: q.order, type: q.type, title: q.title, required: q.required,
      options: q.options || [], minSelect: q.minSelect, maxSelect: q.maxSelect,
      minLength: q.minLength, maxLength: q.maxLength, min: q.min, max: q.max, integerOnly: q.integerOnly,
      jumpRules: (q.jumpRules || []).map((r) => ({ condition: r.condition, targetQid: r.targetQid })),
    })),
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
    res.json({ survey: publicView(survey), requiresLogin: !survey.allowAnonymous, loggedIn: !!req.user });
  } catch (e) { next(e); }
});

router.post('/surveys/:publicId/validate-answer', authOptional, async (req, res, next) => {
  try {
    const survey = await findOpen(req, res);
    if (!survey) return;

    const { qid, value } = req.body || {};
    const q = survey.questions.find((x) => x.qid === qid);
    if (!q) return res.status(400).json({ error: '题目不存在' });

    const v = validateAnswer(q, value);
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });

    const ordered = survey.sortedQuestions();
    const nextQid = resolveNext(q, v.hasValue ? v.normalized : null, ordered);
    res.json({ ok: true, hasValue: v.hasValue, nextQid });
  } catch (e) { next(e); }
});

router.post('/surveys/:publicId/responses', authOptional, async (req, res, next) => {
  try {
    const survey = await findOpen(req, res);
    if (!survey) return;

    const { answers, isAnonymous: clientSelectedAnonymous } = req.body || {};
    let respondentId = null;
    let isAnonymous = false;

    // 如果未登录且问卷不允许匿名，拒绝
    if (!req.user && !survey.allowAnonymous) {
      return res.status(401).json({ error: '该问卷要求登录后才能填写' });
    }

    if (!req.user) {
      // 未登录且问卷允许匿名，强制匿名
      isAnonymous = true;
      respondentId = null;
    } else {
      // 已登录用户
      if (survey.allowAnonymous && clientSelectedAnonymous === true) {
        // 用户主动勾选了“匿名提交”
        isAnonymous = true;
        respondentId = null; // 彻底隐藏用户ID，统计页查不到此人
      } else {
        // 实名提交
        isAnonymous = false;
        respondentId = req.user.uid;
      }
    }

    if (respondentId && !survey.allowMultipleSubmissions) {
      const exists = await SurveyResponse.exists({ surveyId: survey._id, respondentId });
      if (exists) return res.status(409).json({ error: '该问卷不允许重复提交' });
    }

    const result = walkSurvey(survey.questions, answers || {});

    if (result.errors.length) {
      return res.status(400).json({ error: '答案校验未通过', details: result.errors, visited: result.visited });
    }

    const doc = await SurveyResponse.create({
      surveyId: survey._id, respondentId, isAnonymous, answers: result.answers, visitedQids: result.visited,
    });

    await Survey.updateOne({ _id: survey._id }, { $inc: { responseCount: 1 } });
    res.status(201).json({ ok: true, responseId: doc._id, visited: result.visited, ignoredAnswers: result.ignoredAnswers });
  } catch (e) { next(e); }
});

module.exports = router;