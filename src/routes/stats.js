const express = require('express');
const mongoose = require('mongoose');
const Question = require('../models/Question');
const SurveyResponse = require('../models/SurveyResponse');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// 跨问卷统计某一个题目的宏观数据 (基于 lineageId)
router.get('/lineage/:lineageId', async (req, res, next) => {
  try {
    const { lineageId } = req.params;
    
    // 1. 找出这道题的所有版本
    const versions = await Question.find({ lineageId });
    if (!versions.length) return res.status(404).json({ error: '未找到该题目的版本' });
    
    // 拿到第一个版本的题型作为基准
    const baseType = versions[0].type;
    // 转换所有版本 ID 为字符串用于匹配 answers.questionId
    const versionIds = versions.map(v => String(v._id));

    // 2. 在所有答卷的 answers 数组中查找匹配的 questionId
    const baseMatch = [
      { $unwind: '$answers' },
      { $match: { 'answers.questionId': { $in: versionIds } } }
    ];

    let resultData = {};

    if (baseType === 'single' || baseType === 'multiple') {
      const stats = await SurveyResponse.aggregate([
        ...baseMatch,
        { $unwind: '$answers.optionIds' },
        { $group: { _id: '$answers.optionIds', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      // 对于选择题，我们直接用选项的 oid 作为结果
      resultData = { type: baseType, stats };
    } 
    else if (baseType === 'number') {
      const stats = await SurveyResponse.aggregate([
        ...baseMatch,
        { 
          $group: { 
            _id: null, 
            avg: { $avg: '$answers.number' }, 
            min: { $min: '$answers.number' }, 
            max: { $max: '$answers.number' },
            total: { $sum: 1 }
          } 
        }
      ]);
      resultData = { type: baseType, stats: stats[0] || { avg: 0, min: 0, max: 0, total: 0 } };
    } 
    else if (baseType === 'text') {
      const samples = await SurveyResponse.aggregate([
        ...baseMatch,
        { $project: { _id: 0, text: '$answers.text' } },
        { $limit: 100 } // 只取前100条看看
      ]);
      resultData = { type: baseType, samples };
    }

    const totalAnswers = await SurveyResponse.countDocuments({ 
      'answers.questionId': { $in: versionIds } 
    });

    res.json({ totalAnswers, ...resultData });
  } catch (e) {
    next(e);
  }
});

module.exports = router;