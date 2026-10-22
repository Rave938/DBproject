const test = require('node:test');
const assert = require('node:assert');
const RUN = process.env.RUN_API_TESTS === '1';
const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';

async function api(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

test('I-01~09 完整问卷流程', { skip: !RUN }, async () => {
  const suffix = Date.now(); const username = 'tester_' + suffix; const password = 'secret123';
  let r = await api('POST', '/api/auth/register', { username, password }); assert.strictEqual(r.status, 201); const token = r.data.token;
  r = await api('POST', '/api/surveys', { title: '集成测试问卷', description: '自动化测试', allowAnonymous: true }, token); assert.strictEqual(r.status, 201); const survey = r.data.survey; assert.ok(survey.publicId);
  r = await api('POST', '/api/surveys/' + survey.id + '/questions', { type: 'single', title: '你满意吗？', required: true, options: ['满意', '不满意'] }, token); assert.strictEqual(r.status, 201); const q1 = r.data.survey.questions[0];
  r = await api('POST', '/api/surveys/' + survey.id + '/questions', { type: 'text', title: '建议', required: false, minLength: 2, maxLength: 20 }, token); assert.strictEqual(r.status, 201);
  r = await api('POST', '/api/surveys/' + survey.id + '/publish', undefined, token); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.survey.status, 'published');
  const answers = {}; answers[q1.qid] = 'o1';
  r = await api('POST', '/api/public/surveys/' + survey.publicId + '/responses', { answers }); assert.strictEqual(r.status, 201);
  r = await api('POST', '/api/public/surveys/' + survey.publicId + '/responses', { answers: {} }); assert.strictEqual(r.status, 400);
  r = await api('GET', '/api/surveys/' + survey.id + '/stats', undefined, token); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.totalResponses, 1); const q1Stats = r.data.questions.find((q) => q.qid === q1.qid); assert.strictEqual(q1Stats.answeredCount, 1); assert.strictEqual(q1Stats.options.find((o) => o.oid === 'o1').count, 1);
  const r2 = await api('POST', '/api/auth/register', { username: username + '_x', password }); const r3 = await api('GET', '/api/surveys/' + survey.id, undefined, r2.data.token); assert.strictEqual(r3.status, 403);
});