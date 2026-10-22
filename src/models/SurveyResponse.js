const mongoose = require('mongoose');
const { QUESTION_TYPES } = require('./Survey');

const answerSchema = new mongoose.Schema(
  {
    qid: { type: String, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    optionIds: { type: [String], default: undefined },
    text: { type: String },
    number: { type: Number },
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    surveyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Survey', required: true, index: true },
    respondentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isAnonymous: { type: Boolean, default: false },
    answers: { type: [answerSchema], default: [] },
    visitedQids: { type: [String], default: [] },
    submittedAt: { type: Date, default: Date.now },
  },
  { collection: 'responses', versionKey: false }
);

responseSchema.index({ surveyId: 1, submittedAt: -1 });
responseSchema.index({ surveyId: 1, 'answers.qid': 1 });
responseSchema.index({ surveyId: 1, respondentId: 1 });

module.exports = mongoose.model('SurveyResponse', responseSchema);