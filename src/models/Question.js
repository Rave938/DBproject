const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema(
  { oid: { type: String, required: true }, label: { type: String, required: true, trim: true } },
  { _id: false }
);

const questionSchema = new mongoose.Schema(
  {
    // 用于标识同一道题的不同版本（v1, v2, v3 共享同一个 lineageId）
    lineageId: { type: String, required: true, index: true },
    
    // 版本链条
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
    version: { type: Number, required: true, default: 1 },
    
    // 归属与共享
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isShared: { type: Boolean, default: false },

    // 具体内容
    type: { type: String, enum: ['single', 'multiple', 'text', 'number'], required: true },
    title: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    options: { type: [optionSchema], default: undefined },
    minSelect: { type: Number, default: null },
    maxSelect: { type: Number, default: null },
    minLength: { type: Number, default: null },
    maxLength: { type: Number, default: null },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
    integerOnly: { type: Boolean, default: null },

    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'questions', versionKey: false }
);

module.exports = mongoose.model('Question', questionSchema);