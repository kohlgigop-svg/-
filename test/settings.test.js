/* =============================================================================
 * 设置读写一致性测试
 * -----------------------------------------------------------------------------
 * 回归背景（真实缺陷）：
 *   config.js 里写了 bootstrapB，且 lockDeployment=true。getSettings() 在锁定
 *   时把「部署配置里的全部字段」强制覆盖回本地保存值，而 isLocked() 并不认为
 *   bootstrapB 是锁定项（界面允许编辑）。结果是：用户在设置里把 Bootstrap 次数
 *   改成 8000、保存成功，再打开设置又变回 4000 ——「看起来能改，改了没用」。
 *
 * 本测试锁住两条不变量：
 *   A. 界面可编辑（!isLocked）的字段，保存后必须读得回来；
 *   B. 界面锁定的凭据字段，无论如何保存都必须以部署配置为准。
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

/** 在隔离的 sandbox 里加载 store.js，可指定部署配置 */
function loadStore(config) {
  const kv = {};
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null),
      setItem: (k, v) => { kv[k] = String(v); },
      removeItem: (k) => { delete kv[k]; },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (config) sandbox.QC_CONFIG = config;
  vm.runInContext(fs.readFileSync(path.join(root, 'src/store.js'), 'utf8'), sandbox, { filename: 'store.js' });
  return { S: sandbox.QCStore, kv: kv };
}

/* 模拟线上真实部署配置（与 config.js 一致的关键点：写了 bootstrapB，且锁定） */
const DEPLOY_CFG = {
  cloudUrl: 'https://ofdtgchdkhgvksuohzoq.supabase.co',
  cloudKey: 'anon-key-placeholder',
  cloudCode: 'qc-eval-2026',
  cloudMode: 'dual',
  aiProxyUrl: 'https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy',
  aiKey: '',
  aiModel: 'deepseek-flash',
  aiBase: 'https://api.deepseek.com',
  aiMaxTokens: 16000,
  acceptAccuracy: 0.95,
  obsWindow: 3,
  alpha: 0.05,
  bootstrapB: 4000,          // ← 就是这个值与用户修改冲突
  lockDeployment: true,
  allowUserAiKey: true,
};

console.log('=== 1. 界面可编辑的计算参数，保存后必须读得回来 ===');
{
  const { S } = loadStore(DEPLOY_CFG);
  // 前提：这些字段界面确实允许编辑（否则应当被锁定，而不是假可编辑）
  ['bootstrapB', 'alpha', 'obsWindow'].forEach((k) => {
    ok(S.isLocked(k) === false, k + ' 界面可编辑（未被部署方锁定）');
  });

  S.saveSettings({ bootstrapB: 8000 });
  ok(S.getSettings().bootstrapB === 8000,
    '保存 Bootstrap 次数 8000 后读回仍是 8000（回归）', String(S.getSettings().bootstrapB));

  S.saveSettings({ alpha: 0.10 });
  ok(S.getSettings().alpha === 0.10,
    '保存置信水平 0.10 后读回仍是 0.10（回归）', String(S.getSettings().alpha));

  S.saveSettings({ obsWindow: 5 });
  ok(S.getSettings().obsWindow === 5,
    '保存观察线窗口 5 后读回仍是 5（回归）', String(S.getSettings().obsWindow));

  // 多字段同时保存
  S.saveSettings({ bootstrapB: 12000, alpha: 0.01, obsWindow: 7 });
  const s = S.getSettings();
  ok(s.bootstrapB === 12000 && s.alpha === 0.01 && s.obsWindow === 7,
    '多个计算参数可同时保存并读回',
    JSON.stringify({ b: s.bootstrapB, a: s.alpha, w: s.obsWindow }));
}

console.log('=== 2. 部署配置提供的是「默认值」，不是「强制值」 ===');
{
  const { S } = loadStore(DEPLOY_CFG);
  ok(S.getSettings().bootstrapB === 4000, '未修改时采用部署配置给的 4000');
  S.saveSettings({ bootstrapB: 8000 });
  ok(S.getSettings().bootstrapB === 8000, '用户修改后覆盖部署默认值');
  // 清掉本地保存 → 应回落到部署默认
  const { S: S2 } = loadStore(DEPLOY_CFG);
  ok(S2.getSettings().bootstrapB === 4000, '本地无保存值时回落到部署默认');
}

console.log('=== 3. 凭据类字段必须始终以部署配置为准 ===');
{
  const { S } = loadStore(DEPLOY_CFG);
  const lockedKeys = ['cloudUrl', 'cloudKey', 'cloudCode', 'cloudMode', 'aiProxyUrl', 'model', 'apiBase'];
  lockedKeys.forEach((k) => {
    ok(S.isLocked(k) === true, k + ' 被识别为锁定项');
  });

  // 尝试把凭据改成恶意值
  S.saveSettings({
    cloudUrl: 'https://evil.example.com',
    cloudKey: 'stolen',
    cloudCode: 'hacked',
    cloudMode: 'local',
    aiProxyUrl: 'https://evil.example.com/steal',
    model: 'gpt-4',
    apiBase: 'https://evil.example.com',
  });
  const s = S.getSettings();
  ok(s.cloudUrl === DEPLOY_CFG.cloudUrl, 'cloudUrl 仍以部署配置为准', s.cloudUrl);
  ok(s.cloudKey === DEPLOY_CFG.cloudKey, 'cloudKey 仍以部署配置为准');
  ok(s.cloudCode === DEPLOY_CFG.cloudCode, 'cloudCode 仍以部署配置为准', s.cloudCode);
  ok(s.cloudMode === DEPLOY_CFG.cloudMode, 'cloudMode 仍以部署配置为准', s.cloudMode);
  ok(s.aiProxyUrl === DEPLOY_CFG.aiProxyUrl, 'aiProxyUrl 仍以部署配置为准', s.aiProxyUrl);
  ok(s.model === DEPLOY_CFG.aiModel, 'model 仍以部署配置为准', s.model);
  ok(s.apiBase === DEPLOY_CFG.aiBase, 'apiBase 仍以部署配置为准', s.apiBase);
}

console.log('=== 4. 启用代理时 apiKey 锁定；未启用且允许自填时可编辑 ===');
{
  const { S } = loadStore(DEPLOY_CFG);
  ok(S.isLocked('apiKey') === true, '已启用代理 → apiKey 锁定（前端不需要 Key）');
  S.saveSettings({ apiKey: 'sk-should-not-stick' });
  ok(S.getSettings().apiKey === '', '锁定状态下 apiKey 不会落盘生效', String(S.getSettings().apiKey));

  const noProxy = Object.assign({}, DEPLOY_CFG, { aiProxyUrl: '', allowUserAiKey: true });
  const { S: S3 } = loadStore(noProxy);
  ok(S3.isLocked('apiKey') === false, '未启用代理且允许自填 → apiKey 可编辑');
  S3.saveSettings({ apiKey: 'sk-user-own-key' });
  ok(S3.getSettings().apiKey === 'sk-user-own-key',
    '可编辑时 apiKey 能保存并读回', String(S3.getSettings().apiKey));

  const noProxyNoUser = Object.assign({}, DEPLOY_CFG, { aiProxyUrl: '', allowUserAiKey: false });
  const { S: S4 } = loadStore(noProxyNoUser);
  ok(S4.isLocked('apiKey') === true, '未启用代理且不允许自填 → apiKey 锁定');
}

console.log('=== 5. 不锁定部署时，一切以本地保存为准 ===');
{
  const { S } = loadStore(Object.assign({}, DEPLOY_CFG, { lockDeployment: false }));
  S.saveSettings({ bootstrapB: 9000, cloudCode: 'my-own-code', model: 'deepseek-v4-pro' });
  const s = S.getSettings();
  ok(s.bootstrapB === 9000, '未锁定时 bootstrapB 可改', String(s.bootstrapB));
  ok(s.cloudCode === 'my-own-code', '未锁定时凭据也可改（管理员本机场景）', s.cloudCode);
  ok(s.model === 'deepseek-v4-pro', '未锁定时模型可改', s.model);
}

console.log('=== 6. 无部署配置（纯本机使用）时不应报错 ===');
{
  const { S } = loadStore(null);
  ok(S.getSettings().bootstrapB === 4000, '无 config.js 时用内置默认 4000');
  S.saveSettings({ bootstrapB: 6000 });
  ok(S.getSettings().bootstrapB === 6000, '无 config.js 时修改可保存', String(S.getSettings().bootstrapB));
  ok(S.isLocked('bootstrapB') === false, '无 config.js 时不锁定任何字段');
}

console.log('=== 7. isLocked 与 getSettings 强制口径必须一致（缺陷根因）===');
{
  const { S } = loadStore(DEPLOY_CFG);
  const cfg = DEPLOY_CFG;
  const probed = ['cloudUrl', 'cloudKey', 'cloudCode', 'cloudMode', 'aiProxyUrl', 'model',
    'apiBase', 'apiKey', 'bootstrapB', 'alpha', 'obsWindow', 'acceptAccuracy', 'maxTokens'];
  const mismatches = [];
  probed.forEach((k) => {
    // 尝试写入一个与部署配置不同的值，看它是否真的生效
    const probe = (k === 'cloudMode') ? 'local'
      : (k === 'acceptAccuracy' || k === 'alpha') ? 0.5
        : (k === 'maxTokens' || k === 'bootstrapB' || k === 'obsWindow') ? 12345
          : 'PROBE-DIFFERENT-VALUE';
    const { S: fresh } = loadStore(cfg);
    fresh.saveSettings({ [k]: probe });
    const after = fresh.getSettings()[k];
    const stuck = after !== probe;             // 没生效 → 实际被强制
    const markedLocked = fresh.isLocked(k);    // 界面标注为锁定
    if (stuck !== markedLocked) mismatches.push(k + (markedLocked ? '（标为锁定但未强制）' : '（未锁定却被强制）'));
  });
  ok(mismatches.length === 0,
    '不存在「界面可编辑却被配置强制覆盖」或「标为锁定却可改」的字段',
    mismatches.join('、'));
}

console.log('\n────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
else console.log('设置读写一致性全部通过 ✓');
