const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Question = require('../models/Question');
const Survey = require('../models/Survey');
const SurveyResponse = require('../models/SurveyResponse');
const { authRequired } = require('../middleware/auth');
const { BadRequestError, buildQuestion } = require('../services/questionBuilder');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res) => {
  const questions = await Question.aggregate([
    { $match: { $or: [{ creatorId: new mongoose.Types.ObjectId(req.user.uid) }, { isShared: true }] } },
    { $lookup: { from: 'users', localField: 'creatorId', foreignField: '_id', as: 'creatorInfo' } },
    { $unwind: { path: '$creatorInfo', preserveNullAndEmptyArrays: true } },
    { $addFields: { creatorName: { $ifNull: ['$creatorInfo.username', '未知用户'] } } },
    { $project: { creatorInfo: 0 } },
    { $sort: { createdAt: -1 } }
  ]);
  res.json({ questions });
});

router.post('/', async (req, res, next) => {
  try {
    const q = buildQuestion(req.body || {}, 'temp', 0);
    const newQ = await Question.create({
      lineageId: crypto.randomUUID(), version: 1, creatorId: req.user.uid,
      type: q.type, title: q.title, required: q.required, options: q.options,
      minSelect: q.minSelect, maxSelect: q.maxSelect, minLength: q.minLength, maxLength: q.maxLength, min: q.min, max: q.max, integerOnly: q.integerOnly
    });
    res.status(201).json({ question: newQ });
  } catch (e) {
    if (e instanceof BadRequestError) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/:id/share', async (req, res) => {
  const q = await Question.findById(req.params.id);
  if (!q) return res.status(404).json({ error: '题目不存在' });
  if (String(q.creatorId) !== req.user.uid) return res.status(403).json({ error: '只能操作自己的题目' });
  q.isShared = !q.isShared;
  await q.save();
  res.json({ question: q });
});

router.post('/:id/new-version', async (req, res, next) => {
  try {
    const oldQ = await Question.findById(req.params.id);
    if (!oldQ) return res.status(404).json({ error: '源题目不存在' });
    const q = buildQuestion(req.body || {}, 'temp', 0);
    const newQ = await Question.create({
      lineageId: oldQ.lineageId, parentId: oldQ._id, version: oldQ.version + 1, creatorId: req.user.uid,
      type: oldQ.type, title: q.title, required: q.required, options: q.options,
      minSelect: q.minSelect, maxSelect: q.maxSelect, minLength: q.minLength, maxLength: q.maxLength, min: q.min, max: q.max, integerOnly: q.integerOnly
    });
    res.status(201).json({ question: newQ });
  } catch (e) {
    if (e instanceof BadRequestError) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// 合并接口：获取题目详情、被引用情况、以及每个问卷独立的数据统计
router.get('/:id/details', async (req, res, next) => {
  try {
    const targetQ = await Question.findById(req.params.id);
    if (!targetQ) return res.status(404).json({ error: '题目不存在' });

    const lineageId = targetQ.lineageId;
    const versions = await Question.find({ lineageId }).sort({ version: 1 });
    const versionIds = versions.map(v => String(v._id));
    
    // 全局选项映射表
    const optionMap = {};
    if (targetQ.type === 'single' || targetQ.type === 'multiple') {
      versions.forEach(v => { (v.options || []).forEach(o => { optionMap[o.oid] = o.label; }); });
    }

    // 查引用的问卷，并关联查出发布者名字
    const surveys = await Survey.aggregate([
      { $match: { 'questions.questionId': { $in: versionIds.map(id => new mongoose.Types.ObjectId(id)) } } },
      { $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', as: 'owner' } },
      { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
      { $project: { title: 1, status: 1, ownerName: '$owner.username', questions: 1 } }
    ]);

    // 遍历每个问卷，计算单卷统计
    const usages = [];
    for (const s of surveys) {
      // 找到该问卷中引用当前题目的那一道题
      const sq = s.questions.find(q => versionIds.includes(String(q.questionId)));
      if (!sq) continue;

      let surveyStats = null;
      if (targetQ.type === 'single' || targetQ.type === 'multiple') {
        const agg = await SurveyResponse.aggregate([
          { $match: { surveyId: s._id } },
          { $unwind: '$answers' },
          { $match: { 'answers.qid': sq.qid } },
          { $unwind: '$answers.optionIds' },
          { $group: { _id: '$answers.optionIds', count: { $sum: 1 } } }
        ]);
        
        const total = agg.reduce((sum, item) => sum + item.count, 0);
        surveyStats = agg.map(x => ({
          label: optionMap[x._id] || x._id,
          count: x.count,
          percent: total ? Math.round((x.count / total) * 100) : 0
        })).sort((a, b) => b.count - a.count);
      }

      usages.push({
        _id: s._id,
        title: s.title,
        status: s.status,
        ownerName: s.ownerName || '未知用户',
        stats: surveyStats // 单卷统计结果
      });
    }

    // 跨卷总体统计
    let totalAnswers = 0;
    let overallStats = null;
    if (targetQ.type === 'single' || targetQ.type === 'multiple') {
      const agg = await SurveyResponse.aggregate([
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': { $in: versionIds } } },
        { $unwind: '$answers.optionIds' },
        { $group: { _id: '$answers.optionIds', count: { $sum: 1 } } }
      ]);
      const total = agg.reduce((sum, item) => sum + item.count, 0);
      overallStats = agg.map(x => ({
        label: optionMap[x._id] || x._id,
        count: x.count,
        percent: total ? Math.round((x.count / total) * 100) : 0
      })).sort((a, b) => b.count - a.count);
      totalAnswers = total;
    } else if (targetQ.type === 'number') {
      const agg = await SurveyResponse.aggregate([
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': { $in: versionIds } } },
        { $group: { _id: null, avg: { $avg: '$answers.number' }, min: { $min: '$answers.number' }, max: { $max: '$answers.number' }, total: { $sum: 1 } } }
      ]);
      overallStats = agg[0] || { avg: 0, min: 0, max: 0, total: 0 };
      totalAnswers = overallStats.total;
    }

    res.json({ type: targetQ.type, totalAnswers, overallStats, usages });
  } catch (e) {
    next(e);
  }
});

module.exports = router;