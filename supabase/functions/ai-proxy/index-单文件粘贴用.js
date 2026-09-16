// =============================================================================
// Supabase Edge Function: ai-proxy（单文件版，直接粘贴到控制台编辑器）
// -----------------------------------------------------------------------------
// 部署：Supabase → Edge Functions → Deploy a new function → Via Editor
//       函数名必须填：ai-proxy
//       全文粘贴本文件 → Deploy
// 然后到 Edge Functions → Secrets 添加四个变量：
//   DEEPSEEK_API_KEY   = sk-开头的真实 Key
//   ACCESS_CODE_HASH   = 2b3ac575436c0f15e2eae20a595c9b868fe47c3e0bd5c9228a870adbcf8af5d1
//   SUPABASE_URL       = https://ofdtgchdkhgvksuohzoq.supabase.co
//   SUPABASE_ANON_KEY  = 你的 anon public key
//
// 本文件由 supabase/functions/ai-proxy/ 下的 handler.js 与 index.ts 合并生成，
// 逻辑与仓库中带测试的版本完全一致。
// =============================================================================
/* =============================================================================
 * AI 代理逻辑（可测试核心）
 * -----------------------------------------------------------------------------
 * 这个文件是纯逻辑，不依赖 Deno 专有 API，因此可以用 Node 直接跑测试。
 * 真正部署到 Supabase Edge Function 的入口是 supabase/functions/ai-proxy/index.ts，
 * 它只负责把它包上 Deno.serve。
 *
 * 设计要点：
 *   - DeepSeek API Key 只从环境变量读取，永不返回给客户端
 *   - 访问码在服务端校验（比对 SHA-256 哈希，明文不入库不入代码）
 *   - 校验调用方带有 Supabase 会话（匿名登录即可），提高滥用门槛
 *   - 只允许白名单模型，避免被用来调用其它昂贵模型
 *   - 限制请求体大小与输出预算上限，降低被滥用的损失
 * ========================================================================== */

/** 允许的模型白名单 */
const ALLOWED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/** 输出预算上限（防止有人用超大 max_tokens 刷额度） */
const MAX_TOKENS_CAP = 32000;

/** 请求体大小上限（字节） */
const MAX_BODY_BYTES = 256 * 1024;

/** 计算访问码的 SHA-256（十六进制小写） */
async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text == null ? '' : text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 允许的来源（GitHub Pages 站点与本地调试） */
function buildCorsHeaders(origin) {
  const allowed = [
    'https://kohlgigop-svg.github.io',
    'http://127.0.0.1:8791',
    'http://localhost:8791',
  ];
  const allow = allowed.indexOf(origin) >= 0 ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors),
  });
}

/**
 * 处理一次 AI 代理请求
 * @param {Request} req
 * @param {object} env { DEEPSEEK_API_KEY, ACCESS_CODE_HASH, SUPABASE_URL, SUPABASE_ANON_KEY, DEEPSEEK_BASE }
 * @param {function} fetchImpl 便于测试注入
 */
async function handleRequest(req, env, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const cors = buildCorsHeaders(req.headers.get('origin') || '');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return json({ error: '仅支持 POST' }, 405, cors);
  }

  // ---------- 1. 服务端配置自检 ----------
  const apiKey = env.DEEPSEEK_API_KEY;
  const codeHash = (env.ACCESS_CODE_HASH || '').trim().toLowerCase();
  if (!apiKey) {
    return json({ error: '服务端未配置 DEEPSEEK_API_KEY，请到 Edge Functions 的 Secrets 里添加。' }, 500, cors);
  }
  if (!codeHash) {
    return json({ error: '服务端未配置 ACCESS_CODE_HASH，请到 Edge Functions 的 Secrets 里添加。' }, 500, cors);
  }

  // ---------- 2. 请求体大小限制 ----------
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: '请求体过大' }, 413, cors);
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    return json({ error: '请求体不是合法 JSON' }, 400, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: '请求体必须是 JSON 对象' }, 400, cors);
  }

  // ---------- 3. 访问码校验（明文只在请求里，服务端只比对哈希） ----------
  const code = String(body.accessCode || '');
  if (!code) {
    return json({ error: 'ACCESS_DENIED: 缺少访问码' }, 401, cors);
  }
  const gotHash = await sha256Hex(code);
  if (gotHash !== codeHash) {
    return json({ error: 'ACCESS_DENIED: 访问码不正确' }, 401, cors);
  }

  // ---------- 4. 会话校验（提高滥用门槛：必须带有效的 Supabase 会话） ----------
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = env.SUPABASE_ANON_KEY || '';
  const auth = req.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (supabaseUrl && anonKey) {
    if (!token) {
      return json({ error: 'NO_SESSION: 缺少会话令牌，请刷新页面重试' }, 401, cors);
    }
    let ok = false;
    try {
      const r = await doFetch(supabaseUrl + '/auth/v1/user', {
        headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
      });
      ok = r.ok;
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      return json({ error: 'NO_SESSION: 会话无效或已过期，请刷新页面重试' }, 401, cors);
    }
  }

  // ---------- 5. 参数白名单与上限 ----------
  const model = String(body.model || 'deepseek-flash');
  if (ALLOWED_MODELS.indexOf(model) < 0) {
    return json({ error: '不支持的模型：' + model + '，允许：' + ALLOWED_MODELS.join('、') }, 400, cors);
  }
  const maxTokens = Math.min(
    MAX_TOKENS_CAP,
    Math.max(1, parseInt(body.max_tokens, 10) || 16000)
  );
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: '缺少 messages' }, 400, cors);
  }

  // ---------- 6. 转发到 DeepSeek（key 只在服务端） ----------
  const base = (env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  let upstream;
  try {
    upstream = await doFetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model,
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        stream: false,
      }),
    });
  } catch (e) {
    return json({ error: '上游模型请求失败：' + e.message }, 502, cors);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // 只回传上游错误信息，绝不回传 key
    return json({ error: '上游模型返回 ' + upstream.status + '：' + text.slice(0, 300) }, upstream.status, cors);
  }

  // ---------- 7. 原样回传（结构与会话内直连一致，前端解析逻辑无需改动） ----------
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return json({ error: '上游返回不是合法 JSON' }, 502, cors);
  }
  return json(payload, 200, cors);
}

Deno.serve(async (req) => {
  return await handleRequest(req, {
    DEEPSEEK_API_KEY: Deno.env.get('DEEPSEEK_API_KEY'),
    ACCESS_CODE_HASH: Deno.env.get('ACCESS_CODE_HASH'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    DEEPSEEK_BASE: Deno.env.get('DEEPSEEK_BASE') || 'https://api.deepseek.com',
  });
});
