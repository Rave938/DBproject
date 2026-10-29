const mongoose = require('mongoose');
const SurveyResponse = require('../models/SurveyResponse');
const Question = require('../models/Question');

async function getQuestionStats(surveyId, question) {
  const base = [
    { $match: { surveyId: new mongoose.Types.ObjectId(surveyId) } },
    { $lookup: { from: 'users', localField: 'respondentId', foreignField: '_id', as: 'userInfo' } },
    { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
    { $unwind: '$answers' },
    { $match: { 'answers.qid': question.qid } },
  ];

  if (question.type === 'single' || question.type === 'multiple') {
    const [facet] = await SurveyResponse.aggregate([
      ...base,
      {
        $facet: {
          answered: [{ $count: 'n' }],
          options: [
            { $unwind: '$answers.optionIds' },
            { $group: { _id: '$answers.optionIds', count: { $sum: 1 }, users: { $push: { username: { $ifNull: ['$userInfo.username', '匿名用户'] } } } } },
          ],
        },
      },
    ]);
    const answeredCount = facet?.answered?.[0]?.n || 0;
    const aggOptions = facet?.options || [];
    const options = (question.options || []).map((o) => {
      const aggData = aggOptions.find((x) => x._id === o.oid);
      const c = aggData ? aggData.count : 0;
      return { oid: o.oid, label: o.label, count: c, users: aggData ? aggData.users : [], percent: answeredCount ? Math.round((c / answeredCount) * 10000) / 100 : 0 };
    });
    const out = { qid: question.qid, type: question.type, title: question.title, answeredCount, options };
    if (question.type === 'multiple') {
      const totalSelected = options.reduce((s, o) => s + o.count, 0);
      out.avgSelected = answeredCount ? Math.round((totalSelected / answeredCount) * 100) / 100 : 0;
    }
    return out;
  }

  if (question.type === 'text') {
    const LIMIT = 500;
    const [facet] = await SurveyResponse.aggregate([
      ...base,
      { $facet: { answered: [{ $count: 'n' }], texts: [{ $limit: LIMIT }, { $project: { _id: 0, text: '$answers.text', username: { $ifNull: ['$userInfo.username', '匿名用户'] } } }] } },
    ]);
    const answeredCount = facet?.answered?.[0]?.n || 0;
    return { qid: question.qid, type: 'text', title: question.title, answeredCount, samples: (facet?.texts || []).map((t) => ({ text: t.text, username: t.username })), samplesTruncated: answeredCount > LIMIT };
  }

  if (question.type === 'number') {
    const [facet] = await SurveyResponse.aggregate([
      ...base,
      { $facet: { answered: [{ $count: 'n' }], agg: [{ $group: { _id: null, avg: { $avg: '$answers.number' }, min: { $min: '$answers.number' }, max: { $max: '$answers.number' }, numbers: { $push: { number: '$answers.number', username: { $ifNull: ['$userInfo.username', '匿名用户'] } } } } }] } },
    ]);
    const answeredCount = facet?.answered?.[0]?.n || 0;
    const a = facet?.agg?.[0] || {};
    return { qid: question.qid, type: 'number', title: question.title, answeredCount, avg: a.avg != null ? Math.round(a.avg * 100) / 100 : null, min: a.min != null ? a.min : null, max: a.max != null ? a.max : null, numbers: a.numbers || [] };
  }
  return { qid: question.qid, type: question.type, title: question.title, answeredCount: 0 };
}

async function getSurveyStats(survey) {
  const surveyId = survey._id;
  const totalResponses = await SurveyResponse.countDocuments({ surveyId });
  
  // 查出所有引用的题目详情
  const qIds = survey.questions.map(q => q.questionId);
  const dbQuestions = await Question.find({ _id: { $in: qIds } });
  const qMap = new Map(dbQuestions.map(q => [String(q._id), q]));

  const questions = await Promise.all(
    survey.questions.sort((a,b)=>a.order-b.order).map(async (sq) => {
      const detail = qMap.get(String(sq.questionId));
      if (!detail) return null;
      return getQuestionStats(surveyId, { ...detail.toObject(), qid: sq.qid });
    })
  );

  return { surveyId: String(surveyId), totalResponses, questions: questions.filter(Boolean) };
}

module.exports = { getSurveyStats, getQuestionStats };