const { findJumpCycle } = require('./logic');

const ALLOWED_TYPES = ['single', 'multiple', 'text', 'number'];

class BadRequestError extends Error {
  constructor(message) {
    super(message); this.name = 'BadRequestError'; this.status = 400;
  }
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestError(`不是合法数字: ${v}`);
  return n;
}

function nextQid(survey) {
  let max = 0;
  for (const q of survey.questions) {
    const m = /^q(\d+)$/.exec(q.qid || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `q${max + 1}`;
}

function buildQuestion(input, qid, order) {
  const type = input.type;
  if (!ALLOWED_TYPES.includes(type)) throw new BadRequestError('题型错误');
  const title = String(input.title || '').trim();
  if (!title) throw new BadRequestError('题目标题不能为空');

  const q = { qid, order, type, title, required: !!input.required, jumpRules: [] };

  if (type === 'single' || type === 'multiple') {
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    if (rawOptions.length < 2) throw new BadRequestError('选择题至少需要 2 个选项');
    q.options = rawOptions.map((o, i) => {
      const label = String(typeof o === 'string' ? o : o.label || '').trim();
      if (!label) throw new BadRequestError(`第 ${i + 1} 个选项内容不能为空`);
      return { oid: o && o.oid ? String(o.oid) : `o${i + 1}`, label };
    });
    if (new Set(q.options.map((o) => o.oid)).size !== q.options.length) throw new BadRequestError('选项 id 重复');

    if (type === 'multiple') {
      q.minSelect = numOrNull(input.minSelect);
      q.maxSelect = numOrNull(input.maxSelect);
      if (q.minSelect != null && q.minSelect < 1) throw new BadRequestError('最少选择数量不能小于 1');
      if (q.maxSelect != null && q.maxSelect > q.options.length) throw new BadRequestError('最多选择数量超出');
      if (q.minSelect != null && q.maxSelect != null && q.minSelect > q.maxSelect) throw new BadRequestError('最少大于最多');
    }
  }

  if (type === 'text') {
    q.minLength = numOrNull(input.minLength);
    q.maxLength = numOrNull(input.maxLength);
    if (q.minLength != null && q.minLength < 0) throw new BadRequestError('最少字数不能为负');
    if (q.minLength != null && q.maxLength != null && q.minLength > q.maxLength) throw new BadRequestError('最少大于最多字数');
  }

  if (type === 'number') {
    q.min = numOrNull(input.min);
    q.max = numOrNull(input.max);
    q.integerOnly = input.integerOnly == null ? null : !!input.integerOnly;
    if (q.min != null && q.max != null && q.min > q.max) throw new BadRequestError('最小值不能大于最大值');
  }

  const rules = Array.isArray(input.jumpRules) ? input.jumpRules : [];
  q.jumpRules = rules.map((r, i) => {
    const targetQid = String((r && r.targetQid) || '').trim();
    if (!targetQid) throw new BadRequestError(`第 ${i + 1} 条跳转规则缺少目标题目`);
    const cond = (r && r.condition) || {};

    if (cond.kind === 'option') {
      if (type !== 'single' && type !== 'multiple') throw new BadRequestError('只有选择题可以设置选项跳转');
      const oids = new Set((q.options || []).map((o) => o.oid));
      if (!oids.has(cond.oid)) throw new BadRequestError(`引用了不存在的选项`);
      return { condition: { kind: 'option', oid: cond.oid }, targetQid };
    }

    if (cond.kind === 'number') {
      if (type !== 'number') throw new BadRequestError('只有数字题可以设置数值跳转');
      const op = cond.op;
      if (!['eq', 'gt', 'gte', 'lt', 'lte', 'between'].includes(op)) throw new BadRequestError('比较符不合法');
      const value = Number(cond.value);
      if (!Number.isFinite(value)) throw new BadRequestError('跳转值必须是数字');
      const condition = { kind: 'number', op, value };
      if (op === 'between') {
        const value2 = Number(cond.value2);
        if (!Number.isFinite(value2)) throw new BadRequestError('between 需要两个数值');
        condition.value2 = value2;
      }
      return { condition, targetQid };
    }
    throw new BadRequestError('跳转条件类型不合法');
  });

  return q;
}

function validateSurveyForPublish(survey) {
  const errors = [];
  const ordered = survey.sortedQuestions();
  const qids = new Set(ordered.map((q) => q.qid));

  for (const q of ordered) {
    (q.jumpRules || []).forEach((r, i) => {
      if (r.targetQid !== '__END__' && !qids.has(r.targetQid)) errors.push(`题目「${q.title}」跳转目标不存在`);
      if (r.targetQid === q.qid) errors.push(`题目「${q.title}」不能跳转自己`);
    });
  }
  const cycle = findJumpCycle(ordered);
  if (cycle) errors.push(`存在环路: ${cycle.join(' -> ')}`);
  return errors;
}

module.exports = { BadRequestError, buildQuestion, nextQid, validateSurveyForPublish };