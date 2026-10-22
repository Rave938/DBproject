const mongoose = require('mongoose');
const SurveyResponse = require('../models/SurveyResponse');

async function getQuestionStats(surveyId, question) {
  const base = [
    { $match: { surveyId: new mongoose.Types.ObjectId(surveyId) } },
    {
      $lookup: {
        from: 'users',
        localField: 'respondentId',
        foreignField: '_id',
        as: 'userInfo'
      }
    },
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
            {
              $group: {
                _id: '$answers.optionIds',
                count: { $sum: 1 },
                users: {
                  $push: {
                    username: { $ifNull: ['$userInfo.username', '匿名用户'] },
                    isAnonymous: '$isAnonymous'
                  }
                }
              }
            },
          ],
        },
      },
    ]);

    const answeredCount = facet?.answered?.[0]?.n || 0;
    const aggOptions = facet?.options || [];

    const options = (question.options || []).map((o) => {
      const aggData = aggOptions.find((x) => x._id === o.oid);
      const c = aggData ? aggData.count : 0;
      const users = aggData ? aggData.users : [];
      
      return {
        oid: o.oid,
        label: o.label,
        count: c,
        users: users,
        percent: answeredCount ? Math.round((c / answeredCount) * 10000) / 100 : 0,
      };
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
      {
        $facet: {
          answered: [{ $count: 'n' }],
          texts: [
            { $limit: LIMIT }, 
            { $project: { _id: 0, text: '$answers.text', username: { $ifNull: ['$userInfo.username', '匿名用户'] } } }
          ],
        },
      },
    ]);
    const answeredCount = facet?.answered?.[0]?.n || 0;
    return {
      qid: question.qid, type: 'text', title: question.title, answeredCount,
      samples: (facet?.texts || []).map((t) => ({ text: t.text, username: t.username })),
      samplesTruncated: answeredCount > LIMIT,
    };
  }

  if (question.type === 'number') {
    const [facet] = await SurveyResponse.aggregate([
      ...base,
      {
        $facet: {
          answered: [{ $count: 'n' }],
          agg: [
            {
              $group: {
                _id: null,
                avg: { $avg: '$answers.number' },
                min: { $min: '$answers.number' },
                max: { $max: '$answers.number' },
                numbers: { $push: { number: '$answers.number', username: { $ifNull: ['$userInfo.username', '匿名用户'] } } }
              },
            },
          ],
        },
      },
    ]);
    const answeredCount = facet?.answered?.[0]?.n || 0;
    const a = facet?.agg?.[0] || {};
    return {
      qid: question.qid, type: 'number', title: question.title, answeredCount,
      avg: a.avg != null ? Math.round(a.avg * 100) / 100 : null, min: a.min != null ? a.min : null, max: a.max != null ? a.max : null,
      numbers: a.numbers || []
    };
  }

  return { qid: question.qid, type: question.type, title: question.title, answeredCount: 0 };
}

async function getSurveyStats(survey) {
  const surveyId = survey._id;
  const totalResponses = await SurveyResponse.countDocuments({ surveyId });
  const ordered = survey.sortedQuestions();
  const questions = await Promise.all(ordered.map((q) => getQuestionStats(surveyId, q)));
  return { surveyId: String(surveyId), totalResponses, questions };
}

module.exports = { getSurveyStats, getQuestionStats };