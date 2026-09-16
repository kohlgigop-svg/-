/* =============================================================================
 * AI 代理（Edge Function 逻辑）测试
 * -----------------------------------------------------------------------------
 * 用 Node 24 原生的 Request/Response 与注入的 fetch 完整验证代理行为，
 * 不需要 Deno、不需要真的部署、也不会消耗 AI 额度。
 * ========================================================================== */
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { handleRequest, sha256Hex } from '../supabase/functions/ai-proxy/handler.js';

let pass = 0, fail = 0;
const failures = [];
const ok = (c, n, extra) => { if (c) pass++; else { fail++; failures.push(n + (extra ? '  → ' + extra : '')); } };

const ACCESS_CODE = 'qc-eval-2026';
const ACCESS_HASH = createHash('sha256').update(ACCESS_CODE, 'utf8').digest('hex');
const ANON = 'anon-key-for-test';
const SB = 'https://test.supabase.co';
const REAL_KEY = 'sk-super-secret-do-not-leak-1234567890';

const ENV = {
  DEEPSEEK_API_KEY: REAL_KEY,
  ACCESS_CODE_HASH: ACCESS_HASH,
  SUPABASE_URL: SB,
  SUPABASE_ANON_KEY: ANON,
};

/** 构造一次代理请求 */
function req(body, opts) {
  opts = opts || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Origin: 'https://kohlgigop-svg.github.io' },
    opts.headers || {}
  );
  if (opts.token !== null) headers.Authorization = 'Bearer ' + (opts.token || 'valid-session-token');
  return new Request('https://test.supabase.co/functions/v1/ai-proxy', {
    method: opts.method || 'POST',
    headers: headers,
    body: opts.method === 'OPTIONS' || opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

/** 记录被调用的上游请求，便于断言 */
function makeFetch(opts) {
  opts = opts || {};
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    if (String(url).indexOf('/auth/v1/user') >= 0) {
      const okSession = opts.sessionOk !== false;
      return new Response(okSession ? '{"id":"u1"}' : '{"error":"invalid"}', {
        status: okSession ? 200 : 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (opts.upstreamFail) {
      return new Response('{"error":{"message":"insufficient balance"}}', { status: 402 });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      model: opts.echoModel || 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { impl, calls };
}

const validBody = {
  accessCode: ACCESS_CODE,
  model: 'deepseek-flash',
  max_tokens: 16000,
  temperature: 0.3,
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
};

console.log('=== 1. 访问码校验必须在服务端完成 ===');
{
  const f = makeFetch();
  const r = await handleRequest(req(validBody), ENV, f.impl);
  ok(r.status === 200, '正确访问码通过', 'HTTP ' + r.status);
  const j = await r.json();
  ok(j.choices && j.choices[0].message.content === '{"summary":"ok"}', '原样回传上游结果');
}
{
  const f = makeFetch();
  const r = await handleRequest(req(Object.assign({}, validBody, { accessCode: 'wrong' })), ENV, f.impl);
  ok(r.status === 401, '错误访问码被拒绝', 'HTTP ' + r.status);
  const j = await r.json();
  ok(/ACCESS_DENIED/.test(j.error), '错误信息为 ACCESS_DENIED', j.error);
  ok(f.calls.filter((c) => c.url.indexOf('/auth/v1/user') < 0).length === 0,
    '访问码错误时不会向上游发起请求（不消耗额度）');
}
{
  const f = makeFetch();
  const r = await handleRequest(req(Object.assign({}, validBody, { accessCode: '' })), ENV, f.impl);
  ok(r.status === 401, '缺少访问码被拒绝', 'HTTP ' + r.status);
}

console.log('=== 2. 会话校验（滥用门槛）===');
{
  const f = makeFetch();
  const r = await handleRequest(req(validBody, { token: null }), ENV, f.impl);
  ok(r.status === 401, '缺少会话令牌被拒绝', 'HTTP ' + r.status);
  const j = await r.json();
  ok(/NO_SESSION/.test(j.error), '错误信息为 NO_SESSION', j.error);
}
{
  const f = makeFetch({ sessionOk: false });
  const r = await handleRequest(req(validBody, { token: 'expired' }), ENV, f.impl);
  ok(r.status === 401, '无效会话被拒绝', 'HTTP ' + r.status);
  ok(/NO_SESSION/.test((await r.json()).error), '错误信息为 NO_SESSION');
}
{
  const f = makeFetch();
  await handleRequest(req(validBody), ENV, f.impl);
  const authCalls = f.calls.filter((c) => c.url.indexOf('/auth/v1/user') >= 0);
  ok(authCalls.length === 1, '确实调用了会话校验接口', String(authCalls.length));
  ok(authCalls[0].init.headers.Authorization === 'Bearer valid-session-token', '用调用方的令牌校验');
}

console.log('=== 3. Key 绝不外泄 ===');
{
  const f = makeFetch();
  const r = await handleRequest(req(validBody), ENV, f.impl);
  const text = await r.text();
  ok(text.indexOf(REAL_KEY) < 0, '响应体中不含 API Key');
  ok(text.indexOf('sk-') < 0, '响应体中不含任何 sk- 前缀字符串');

  // 上游报错时也不能泄漏
  const f2 = makeFetch({ upstreamFail: true });
  const r2 = await handleRequest(req(validBody), ENV, f2.impl);
  const t2 = await r2.text();
  ok(t2.indexOf(REAL_KEY) < 0, '上游报错时响应也不含 API Key', t2.slice(0, 120));
  ok(r2.status === 402, '上游状态码被透传', 'HTTP ' + r2.status);
}
{
  // 检查发往上游的请求头里确实带了 key（证明它被正确使用）
  const f = makeFetch();
  await handleRequest(req(validBody), ENV, f.impl);
  const up = f.calls.find((c) => c.url.indexOf('/chat/completions') >= 0);
  ok(!!up, '确实向上游发起了请求');
  ok(up.init.headers.Authorization === 'Bearer ' + REAL_KEY, 'Key 只在发往上游的请求头里出现');
}

console.log('=== 4. 模型白名单与预算上限 ===');
{
  const f = makeFetch();
  const r = await handleRequest(req(Object.assign({}, validBody, { model: 'gpt-4' })), ENV, f.impl);
  ok(r.status === 400, '非白名单模型被拒绝', 'HTTP ' + r.status);
  ok(/不支持的模型/.test((await r.json()).error), '给出可读错误');
}
{
  const f = makeFetch();
  const r = await handleRequest(req(Object.assign({}, validBody, { model: 'deepseek-v4-pro' })), ENV, f.impl);
  ok(r.status === 200, '白名单内第二个模型允许', 'HTTP ' + r.status);
}
{
  const f = makeFetch();
  await handleRequest(req(Object.assign({}, validBody, { max_tokens: 999999 })), ENV, f.impl);
  const up = f.calls.find((c) => c.url.indexOf('/chat/completions') >= 0);
  const sent = JSON.parse(up.init.body);
  ok(sent.max_tokens === 32000, 'max_tokens 被限制到上限 32000', String(sent.max_tokens));
}
{
  const f = makeFetch();
  await handleRequest(req(Object.assign({}, validBody, { max_tokens: 0 })), ENV, f.impl);
  const up = f.calls.find((c) => c.url.indexOf('/chat/completions') >= 0);
  ok(JSON.parse(up.init.body).max_tokens >= 1, 'max_tokens 下限被保护');
}

console.log('=== 5. 输入校验 ===');
{
  const f = makeFetch();
  const r = await handleRequest(req({ accessCode: ACCESS_CODE, messages: [] }), ENV, f.impl);
  ok(r.status === 400, '缺少 messages 被拒绝', 'HTTP ' + r.status);
}
{
  // 非对象请求体：字符串 / 数组 / null 都必须被明确拒绝，且错误信息可读
  const cases = [
    ['字符串', '"not-an-object"'],
    ['数组', '[1,2,3]'],
    ['null', 'null'],
    ['非法 JSON', '{broken'],
  ];
  for (const [label, payload] of cases) {
    const f = makeFetch();
    const r = new Request('https://x/f', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://kohlgigop-svg.github.io', Authorization: 'Bearer t' },
      body: payload,
    });
    const res = await handleRequest(r, ENV, f.impl);
    ok(res.status === 400, label + ' 请求体被拒绝（400）', 'HTTP ' + res.status);
    const j = await res.json();
    ok(/请求体/.test(j.error || ''), label + ' 给出可读错误', j.error);
  }
}
{
  const f = makeFetch();
  const big = Object.assign({}, validBody, { messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] });
  const r = await handleRequest(req(big), ENV, f.impl);
  ok(r.status === 413, '超大请求体被拒绝', 'HTTP ' + r.status);
}

console.log('=== 6. 服务端配置缺失时的提示 ===');
{
  const f = makeFetch();
  const r = await handleRequest(req(validBody), Object.assign({}, ENV, { DEEPSEEK_API_KEY: '' }), f.impl);
  ok(r.status === 500, '未配置 Key 时返回 500', 'HTTP ' + r.status);
  ok(/DEEPSEEK_API_KEY/.test((await r.json()).error), '错误信息指明缺哪个变量');
}
{
  const f = makeFetch();
  const r = await handleRequest(req(validBody), Object.assign({}, ENV, { ACCESS_CODE_HASH: '' }), f.impl);
  ok(r.status === 500, '未配置访问码哈希时返回 500', 'HTTP ' + r.status);
  ok(/ACCESS_CODE_HASH/.test((await r.json()).error), '错误信息指明缺哪个变量');
}

console.log('=== 7. CORS ===');
{
  const r = await handleRequest(req(null, { method: 'OPTIONS' }), ENV, makeFetch().impl);
  ok(r.status === 204, 'OPTIONS 预检返回 204', 'HTTP ' + r.status);
  ok(r.headers.get('Access-Control-Allow-Origin') === 'https://kohlgigop-svg.github.io',
    '允许线上站点来源', String(r.headers.get('Access-Control-Allow-Origin')));
  ok(/authorization/i.test(r.headers.get('Access-Control-Allow-Headers') || ''),
    '允许 authorization 头', String(r.headers.get('Access-Control-Allow-Headers')));
}
{
  const r = await handleRequest(req(null, { method: 'GET' }), ENV, makeFetch().impl);
  ok(r.status === 405, 'GET 被拒绝（只允许 POST）', 'HTTP ' + r.status);
  ok(r.headers.get('Access-Control-Allow-Origin') === 'https://kohlgigop-svg.github.io',
    '错误响应同样带 CORS 头（否则浏览器读不到错误信息）');
}
{
  const bad = new Request('https://x/', {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(validBody),
  });
  const r = await handleRequest(bad, ENV, makeFetch().impl);
  ok(r.headers.get('Access-Control-Allow-Origin') === 'https://kohlgigop-svg.github.io',
    '未知来源不会回显（防止任意站点盗用）', String(r.headers.get('Access-Control-Allow-Origin')));
}

console.log('=== 8. sha256Hex 与 Sub 端一致性 ===');
{
  const h = await sha256Hex(ACCESS_CODE);
  const expect = createHash('sha256').update(ACCESS_CODE, 'utf8').digest('hex');
  ok(h === expect, 'sha256Hex 与 Node crypto 结果一致', h);
  ok(h.length === 64, '哈希长度 64', String(h.length));
  ok((await sha256Hex('')) === createHash('sha256').update('', 'utf8').digest('hex'), '空串哈希正确');
  ok((await sha256Hex(null)) === createHash('sha256').update('', 'utf8').digest('hex'), 'null 被当作空串处理');
  // 与数据库端 Postgres 的 digest 结果必须一致（这是能对上的前提）
  ok(h === ACCESS_HASH, '与数据库 access_code 哈希一致');
}

console.log('=== 9. 代理地址归一化（前端易错点）===');
{
  // 载入 cloud.js 以测试 normalizeProxyUrl（它必须保留路径，不能像 normalizeUrl 那样截断）
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/cloud.js', import.meta.url), 'utf8');
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  (0, eval)(src);
  const CL = globalThis.QCCloud;

  const cases = [
    ['完整函数地址', 'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy',
      'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy'],
    ['尾部斜杠', 'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy/',
      'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy'],
    ['控制台地址', 'https://supabase.com/dashboard/project/ofdtgchdkhgvksuohzoq',
      'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy'],
    ['仅项目域名', 'https://ofdtgchdkhgvksuohzoq.supabase.co',
      'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy'],
    ['仅项目 ref', 'ofdtgchdkhgvksuohzoq',
      'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy'],
    ['空值', '', ''],
    ['前后空白', '  https://x.supabase.co/functions/v1/ai-proxy  ',
      'https://x.supabase.co/functions/v1/ai-proxy'],
  ];
  for (const [label, input, expect] of cases) {
    const got = CL.normalizeProxyUrl(input);
    ok(got === expect, label + ' 归一化正确', got + ' ≠ ' + expect);
  }
  // 关键回归：不能沿用 normalizeUrl（它会丢掉路径）
  const keptPath = CL.normalizeProxyUrl('https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy');
  ok(/\/functions\/v1\/ai-proxy$/.test(keptPath), '代理地址的路径被保留（不套用 normalizeUrl）', keptPath);
  ok(CL.normalizeUrl('https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy')
      === 'https://ofdtgchdkhgvksuohzoq.supabase.co',
    '对照：normalizeUrl 确实会截断路径（故代理地址必须用专用函数）');
}

console.log('\n────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
else console.log('AI 代理逻辑全部通过 ✓');
