const mongoose = require('mongoose');

// 问卷里的题目只保存引用关系
const surveyQuestionRefSchema = new mongoose.Schema({
  qid: { type: String, required: true }, // 用于问卷内部跳转逻辑
  order: { type: Number, required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  jumpRules: { type: [mongoose.Schema.Types.Mixed], default: [] } // 跳转规则存在问卷侧
}, { _id: false });

const surveySchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 2000 },
    allowAnonymous: { type: Boolean, default: false },
    allowMultipleSubmissions: { type: Boolean, default: true },
    status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft', index: true },
    deadline: { type: Date, default: null },
    
    questions: { type: [surveyQuestionRefSchema], default: [] }, // 题目引用数组
    
    responseCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
  },
  { collection: 'surveys', versionKey: false }
);

surveySchema.index({ ownerId: 1, createdAt: -1 });

surveySchema.methods.sortedQuestions = function () {
  return [...this.questions].sort((a, b) => a.order - b.order);
};

surveySchema.methods.effectiveStatus = function () {
  if (this.status === 'closed') return 'closed';
  if (this.deadline && this.deadline.getTime() <= Date.now()) return 'closed';
  return this.status;
};

surveySchema.methods.toListJSON = function () {
  return {
    id: this._id, publicId: this.publicId, title: this.title, description: this.description,
    status: this.effectiveStatus(), rawStatus: this.status,
    allowAnonymous: this.allowAnonymous, allowMultipleSubmissions: this.allowMultipleSubmissions,
    deadline: this.deadline, questionCount: this.questions.length, responseCount: this.responseCount,
    createdAt: this.createdAt, publishedAt: this.publishedAt,
  };
};

surveySchema.methods.toOwnerJSON = function () {
  return {
    ...this.toListJSON()
  };
};

module.exports = mongoose.model('Survey', surveySchema);