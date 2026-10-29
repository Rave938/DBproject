function isPresent(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function validateAnswer(question, raw) {
  const errors = [];
  const fail = (msg) => {
    errors.push({ qid: question.qid, message: msg });
    return { ok: false, errors, hasValue: false, normalized: null };
  };

  if (!isPresent(raw)) {
    if (question.required) return fail(`「${question.title}」为必答题`);
    return { ok: true, errors: [], hasValue: false, normalized: null };
  }

  switch (question.type) {
    case 'single': {
      if (typeof raw !== 'string') return fail('单选题答案格式错误');
      const opt = (question.options || []).find((o) => o.oid === raw);
      if (!opt) return fail('所选选项不存在');
      return { ok: true, errors: [], hasValue: true, normalized: { optionIds: [raw] } };
    }
    case 'multiple': {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every((v) => typeof v === 'string')) return fail('多选题答案格式错误');
      const uniq = [...new Set(arr)];
      const validOids = new Set((question.options || []).map((o) => o.oid));
      const bad = uniq.filter((x) => !validOids.has(x));
      if (bad.length) return fail(`选项不存在: ${bad.join(', ')}`);
      if (question.minSelect != null && uniq.length < question.minSelect)
        return fail(`至少选择 ${question.minSelect} 项`);
      if (question.maxSelect != null && uniq.length > question.maxSelect)
        return fail(`最多选择 ${question.maxSelect} 项`);
      return { ok: true, errors: [], hasValue: true, normalized: { optionIds: uniq } };
    }
    case 'text': {
      if (typeof raw !== 'string') return fail('文本题答案格式错误');
      const s = raw.trim();
      if (question.minLength != null && s.length < question.minLength)
        return fail(`最少输入 ${question.minLength} 个字符`);
      if (question.maxLength != null && s.length > question.maxLength)
        return fail(`最多输入 ${question.maxLength} 个字符`);
      return { ok: true, errors: [], hasValue: true, normalized: { text: s } };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return fail('必须填写数字');
      if (question.integerOnly && !Number.isInteger(n)) return fail('必须是整数');
      if (question.min != null && n < question.min) return fail(`不能小于 ${question.min}`);
      if (question.max != null && n > question.max) return fail(`不能大于 ${question.max}`);
      return { ok: true, errors: [], hasValue: true, normalized: { number: n } };
    }
    default: return fail(`未知题型: ${question.type}`);
  }
}

function evaluateCondition(condition, normalizedAnswer) {
  if (!condition || !normalizedAnswer) return false;
  if (condition.kind === 'option') {
    const ids = normalizedAnswer.optionIds || [];
    return ids.includes(condition.oid);
  }
  if (condition.kind === 'number') {
    const n = normalizedAnswer.number;
    if (typeof n !== 'number') return false;
    switch (condition.op) {
      case 'eq': return n === condition.value;
      case 'gt': return n > condition.value;
      case 'gte': return n >= condition.value;
      case 'lt': return n < condition.value;
      case 'lte': return n <= condition.value;
      case 'between': return n >= condition.value && n <= condition.value2;
      default: return false;
    }
  }
  return false;
}

function resolveNext(question, normalizedAnswer, orderedQuestions) {
  for (const rule of question.jumpRules || []) {
    if (evaluateCondition(rule.condition, normalizedAnswer)) {
      return rule.targetQid === '__END__' ? null : rule.targetQid;
    }
  }
  const idx = orderedQuestions.findIndex((q) => q.qid === question.qid);
  if (idx < 0) return null;
  return idx + 1 < orderedQuestions.length ? orderedQuestions[idx + 1].qid : null;
}

/**
 * 第二阶段：服务端路径重放机制
 * 由于题目变成了引用，这里需要先去 Question 集合查出题目详情，再进行推演。
 * 注意：此函数现在是 async 异步函数。
 */
async function walkSurvey(surveyQuestions, submittedAnswers) {
  // 动态引入避免循环依赖
  const Question = require('../models/Question');

  // 1. 收集所有需要的 questionId
  const qIds = surveyQuestions.map(q => q.questionId);
  
  // 2. 一次性从题库查出所有题目详情
  const dbQuestions = await Question.find({ _id: { $in: qIds } });
  const qMap = new Map(dbQuestions.map(q => [String(q._id), q]));

  // 3. 组装题目，将问卷侧的跳转规则（jumpRules）与题库侧的题目内容合并
  const ordered = surveyQuestions
    .slice() // 创建副本，避免影响原数组排序
    .sort((a, b) => a.order - b.order)
    .map(sq => {
      const detail = qMap.get(String(sq.questionId));
      if (!detail) return null; // 如果题目被删除则跳过
      return {
        ...detail.toObject(), // 题库里的内容（title, type, options 等）
        qid: sq.qid,          // 问卷内部标识（用于跳转逻辑）
        jumpRules: sq.jumpRules || [], // 跳转规则是存在问卷里的
        questionId: String(sq.questionId) // 记录实际引用的版本ID
      };
    })
    .filter(Boolean);

  if (ordered.length === 0) {
    return { errors: [{ qid: null, message: '问卷没有可用题目' }], answers: [], visited: [] };
  }

  // --- 以下为原有的重放和校验逻辑 ---
  const byQid = new Map(ordered.map((q) => [q.qid, q]));
  const errors = [];
  const answers = [];
  const visited = [];
  const guard = new Set();
  let currentQid = ordered[0].qid;

  while (currentQid) {
    if (guard.has(currentQid)) {
      errors.push({ qid: currentQid, message: '检测到跳转环路，问卷配置有误' });
      break;
    }
    guard.add(currentQid);
    const q = byQid.get(currentQid);
    if (!q) {
      errors.push({ qid: currentQid, message: '跳转目标题目不存在' });
      break;
    }
    visited.push(q.qid);
    const raw = submittedAnswers ? submittedAnswers[q.qid] : undefined;
    const v = validateAnswer(q, raw);

    if (!v.ok) errors.push(...v.errors);
    
    if (v.hasValue) {
      // 重点：在答卷里同时记录 qid（问卷内跳转用）和 questionId（跨问卷统计用）
      answers.push({ qid: q.qid, questionId: q.questionId, type: q.type, ...v.normalized });
    }

    currentQid = resolveNext(q, v.hasValue ? v.normalized : null, ordered);
  }

  const extra = Object.keys(submittedAnswers || {}).filter((qid) => !visited.includes(qid));
  return { errors, answers, visited, ignoredAnswers: extra };
}

/**
 * 发布前的环路检测。
 * 因为跳转规则是存在问卷的引用数组里的，直接拿引用来检测即可，不需要查数据库。
 */
function findJumpCycle(surveyQuestions) {
  const ordered = [...surveyQuestions].sort((a, b) => a.order - b.order);
  const adj = new Map();

  ordered.forEach((sq, i) => {
    const outs = (sq.jumpRules || []).filter((r) => r.targetQid !== '__END__').map((r) => r.targetQid);
    if (i + 1 < ordered.length) outs.push(ordered[i + 1].qid);
    adj.set(sq.qid, outs);
  });

  const color = new Map();
  const stack = [];
  let cycle = null;

  function dfs(u) {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      const c = color.get(v) || 0;
      if (c === 1) { cycle = [...stack.slice(stack.indexOf(v)), v]; return true; }
      if (c === 0 && dfs(v)) return true;
    }
    color.set(u, 2);
    stack.pop();
    return false;
  }

  for (const sq of ordered) {
    if (!color.get(sq.qid) && dfs(sq.qid)) return cycle;
  }
  return null;
}

module.exports = { isPresent, validateAnswer, evaluateCondition, resolveNext, walkSurvey, findJumpCycle };