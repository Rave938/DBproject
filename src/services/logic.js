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

function walkSurvey(questions, submittedAnswers) {
  const ordered = [...questions].sort((a, b) => a.order - b.order);
  if (ordered.length === 0) {
    return { errors: [{ qid: null, message: '问卷没有题目' }], answers: [], visited: [] };
  }
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
    if (v.hasValue) answers.push({ qid: q.qid, type: q.type, ...v.normalized });

    currentQid = resolveNext(q, v.hasValue ? v.normalized : null, ordered);
  }

  const extra = Object.keys(submittedAnswers || {}).filter((qid) => !visited.includes(qid));
  return { errors, answers, visited, ignoredAnswers: extra };
}

function findJumpCycle(questions) {
  const ordered = [...questions].sort((a, b) => a.order - b.order);
  const adj = new Map();

  ordered.forEach((q, i) => {
    const outs = (q.jumpRules || []).filter((r) => r.targetQid !== '__END__').map((r) => r.targetQid);
    if (i + 1 < ordered.length) outs.push(ordered[i + 1].qid);
    adj.set(q.qid, outs);
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

  for (const q of ordered) {
    if (!color.get(q.qid) && dfs(q.qid)) return cycle;
  }
  return null;
}

module.exports = { isPresent, validateAnswer, evaluateCondition, resolveNext, walkSurvey, findJumpCycle };