const mongoose = require('mongoose');

const QUESTION_TYPES = ['single', 'multiple', 'text', 'number'];

const optionSchema = new mongoose.Schema(
  {
    oid: { type: String, required: true },
    label: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const conditionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['option', 'number'], required: true },
    oid: { type: String },
    op: { type: String, enum: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'] },
    value: { type: Number },
    value2: { type: Number },
  },
  { _id: false }
);

const jumpRuleSchema = new mongoose.Schema(
  {
    condition: { type: conditionSchema, required: true },
    targetQid: { type: String, required: true },
  },
  { _id: false }
);

const questionSchema = new mongoose.Schema(
  {
    qid: { type: String, required: true },
    order: { type: Number, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    required: { type: Boolean, default: false },
    options: { type: [optionSchema], default: undefined },
    minSelect: { type: Number, default: null },
    maxSelect: { type: Number, default: null },
    minLength: { type: Number, default: null },
    maxLength: { type: Number, default: null },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    integerOnly: { type: Boolean, default: null },
    jumpRules: { type: [jumpRuleSchema], default: [] },
  },
  { _id: false }
);

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
    questions: { type: [questionSchema], default: [] },
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
    ...this.toListJSON(),
    questions: this.sortedQuestions().map((q) => ({
      qid: q.qid, order: q.order, type: q.type, title: q.title, required: q.required,
      options: q.options || [], minSelect: q.minSelect, maxSelect: q.maxSelect,
      minLength: q.minLength, maxLength: q.maxLength, min: q.min, max: q.max,
      integerOnly: q.integerOnly, jumpRules: q.jumpRules || [],
    })),
  };
};

module.exports = mongoose.model('Survey', surveySchema);
module.exports.QUESTION_TYPES = QUESTION_TYPES;