/* =============================================================================
 * 网络重试逻辑测试
 * -----------------------------------------------------------------------------
 * 背景：实测出现 ECONNRESET（连接被重置），会让用户在网络抖动时看到失败，
 *       而其实什么都没坏。cloud.js 已加带边界的重试。
 *
 * 本测试锁住两条不变量：
 *   A. 网络层异常必须重试，且最终成功；
 *   B. 服务端明确返回的状态码（401/403/409…）**绝不能**重试——
 *      那是真实业务结果，重试会掩盖问题并放大请求量。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name, extra) => {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
};

/** 在隔离 sandbox 里加载 cloud.js，并注入可控的 fetch */
function loadCloud(fetchImpl) {
  const kv = {};
  const calls = [];
  const sandbox = {
    console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null),
      setItem: (k, v) => { kv[k] = String(v); },
      removeItem: (k) => { delete kv[k]; },
    },
    fetch: (url, init) => {
      calls.push(String(url));
      return fetchImpl(String(url), init, calls.length);
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/cloud.js'), 'utf8'), sandbox, { filename: 'cloud.js' });
  return { CL: sandbox.QCCloud, calls: calls, kv: kv };
}

const SETTINGS = {
  cloudUrl: 'https://test.supabase.co',
  cloudKey: 'anon-key',
  cloudCode: 'code',
};

/** 构造一个网络层错误（模拟 ECONNRESET，错误码藏在 cause 里） */
function networkError() {
  const e = new TypeError('fetch failed');
  e.cause = { code: 'ECONNRESET', message: 'read ECONNRESET' };
  return e;
}

/** 访问码校验通过的响应 */
function accessOkResponse() {
  return new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 登录成功响应 */
function signInResponse() {
  return new Response(JSON.stringify({ access_token: 'tok', user: { id: 'u1' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 依据 URL 分派一个合理的成功响应 */
function routeOk(url) {
  if (/auth\/v1\/signup/.test(url)) return signInResponse();
  if (/qc_check_access/.test(url)) return accessOkResponse();
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

console.log('=== 1. 网络层异常必须重试并最终成功 ===');
(async () => {
  {
    let attempt = 0;
    const { CL, calls } = loadCloud(async (url) => {
      attempt++;
      if (attempt <= 2) throw networkError();      // 前两次失败
      return routeOk(url);
    });
    const r = await CL.connect(SETTINGS);
    ok(!!r && r.userId === 'u1', '连接在重试后成功', JSON.stringify(r));
    // 3 次登录尝试（2 次网络失败 + 1 次成功）+ 1 次访问码校验 = 4
    ok(attempt === 4, '网络失败后确实重试并最终成功（3 次登录 + 1 次校验）', '实际请求 ' + attempt + ' 次');
    ok(calls.length === attempt, '请求记录与实际请求次数一致', calls.length + ' vs ' + attempt);
  }

  console.log('=== 2. 重试次数有上限，且失败信息可读 ===');
  {
    let attempt = 0;
    const { CL } = loadCloud(async () => { attempt++; throw networkError(); });
    let err = null;
    try { await CL.connect(SETTINGS); } catch (e) { err = e; }
    ok(!!err, '持续失败最终抛错而不是无限重试');
    ok(/网络|重试/.test(err ? err.message : ''), '错误信息说明是网络问题而非应用缺陷',
      err ? err.message : '(无)');
    ok(attempt === 4, '重试次数受上限约束（1 次原始 + 3 次重试）', '实际 ' + attempt + ' 次');
  }

  console.log('=== 3. 服务端状态码绝不重试（关键边界）===');
  {
    // 401：会话失效，应直接抛出交由上层处理，不得重试
    let attempt = 0;
    const { CL } = loadCloud(async (url) => {
      attempt++;
      if (/qc_check_access/.test(url)) return accessOkResponse();
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
    });
    let err = null;
    try { await CL.deleteRecord(SETTINGS, 'rec-1'); } catch (e) { err = e; }
    ok(!!err, '401 抛出错误');
    // 401 会被重试一次用于刷新会话，但刷新仍 401 时应停止，不能无限重试
    ok(attempt <= 4, '401 的重试次数受约束，不会失控', '实际请求 ' + attempt + ' 次');
    console.log('    401 路径实际请求次数：' + attempt);
  }
  {
    // 403：权限拒绝（如非本人记录），必须一次即止
    let attempt = 0;
    const { CL } = loadCloud(async () => {
      attempt++;
      return new Response(JSON.stringify({ code: '42501', message: 'NOT_OWNER: 该周期的记录由其他成员提交' }),
        { status: 403 });
    });
    let err = null;
    try { await CL.deleteRecord(SETTINGS, 'rec-1'); } catch (e) { err = e; }
    ok(!!err, '403 抛出错误');
    ok(/NOT_OWNER|其他成员/.test(err ? err.message : ''), '403 的业务原因被如实透传', err ? err.message : '');
    ok(attempt === 1, '403 只请求一次，未重试', '实际 ' + attempt + ' 次');
  }
  {
    // 409：状态冲突（如项目下仍有他人记录），同样一次即止
    let attempt = 0;
    const { CL } = loadCloud(async () => {
      attempt++;
      return new Response(JSON.stringify({ code: '23505', message: 'PROJECT_HAS_OTHERS_RECORDS' }),
        { status: 409 });
    });
    let err = null;
    try { await CL.deleteProject(SETTINGS, 'proj-1'); } catch (e) { err = e; }
    ok(!!err, '409 抛出错误');
    ok(attempt === 1, '409 只请求一次，未重试', '实际 ' + attempt + ' 次');
  }

  console.log('=== 4. 非网络类异常不重试 ===');
  {
    let attempt = 0;
    const { CL } = loadCloud(async () => {
      attempt++;
      throw new Error('请求参数不合法');   // 普通错误，不是网络问题
    });
    let err = null;
    try { await CL.fetchAll(SETTINGS); } catch (e) { err = e; }
    ok(!!err, '普通错误抛出');
    ok(attempt === 1, '非网络层异常不触发重试', '实际 ' + attempt + ' 次');
  }

  console.log('=== 5. 正常路径不受影响 ===');
  {
    let attempt = 0;
    const { CL } = loadCloud(async (url) => {
      attempt++;
      return routeOk(url);
    });
    await CL.connect(SETTINGS);
    const all = await CL.fetchAll(SETTINGS);
    ok(Array.isArray(all), '正常路径返回结果', JSON.stringify(all));
    ok(attempt === 3, '正常路径每步只请求一次（登录 + 校验访问码 + 取数）', '实际 ' + attempt + ' 次');
  }

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
  else console.log('网络重试逻辑全部通过 ✓');
})();
