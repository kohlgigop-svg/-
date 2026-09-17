/* =============================================================================
 * 多用户同步一致性测试（真实 Supabase + 真实 store 模块）
 * -----------------------------------------------------------------------------
 * 模拟两个独立客户端（各自独立的 localStorage 与云端会话），验证：
 *   1. 删除能否同步消失（不再残留）
 *   2. 已删除记录会不会被复活（核心回归）
 *   3. 陈旧副本不会覆盖他人新数据
 *   4. 并发写同周期不产生重复
 *   5. 云端删掉的项目能否从本地清掉
 *   6. 「先云端后本地」是否保证本地不含云端没有的记录
 * ========================================================================== */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire('E:/布偶/qc-eval/');
const SB = 'https://ofdtgchdkhgvksuohzoq.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZHRnY2hka2hndmtzdW9oem9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MTkwOTcsImV4cCI6MjEwNTA5NTA5N30.7tZhOUgN-VOLjUUzZveHrnEKECTZhEI7-DFXoUq3xRw';
const CODE = 'qc-eval-2026';
const RUN = Date.now().toString(36);
const PROJECT = '__E2E_SYNCFIX__' + RUN;

const out = [];
const log = (s) => { out.push(s); console.log(s); };

let pass = 0, fail = 0;
const failures = [];
const ok = (c, n, extra) => { if (c) pass++; else { fail++; failures.push(n + (extra ? '  → ' + extra : '')); } };

/* ---------------- 云端（真实） ---------------- */
async function signIn() {
  const r = await fetch(SB + '/auth/v1/signup', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
  });
  const j = await r.json();
  return { token: j.access_token, uid: j.user ? j.user.id : null };
}
async function rpc(session, fn, args) {
  const r = await fetch(SB + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const t = await r.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch (e) { body = t; }
  return { status: r.status, body, raw: t };
}

/* ---------------- 客户端：真实 store + 真实 cloud 模块 ---------------- */
const cloudSrc = await readFile('E:/布偶/qc-eval/src/cloud.js', 'utf8');
const storeSrc = await readFile('E:/布偶/qc-eval/src/store.js', 'utf8');

function makeClient(name, session) {
  const kv = {};
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null),
      setItem: (k, v) => { kv[k] = String(v); },
      removeItem: (k) => { delete kv[k]; },
    },
    fetch: (url, init) => fetch(url, init),
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    escape: globalThis.escape,
    unescape: globalThis.unescape,
    TextEncoder: globalThis.TextEncoder,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cloudSrc, sandbox);
  vm.runInContext(storeSrc, sandbox);

  const S = sandbox.QCStore;
  const CL = sandbox.QCCloud;

  const settings = {
    cloudUrl: SB, cloudKey: ANON, cloudCode: CODE, cloudMode: 'dual',
  };

  const hooks = {
    ensureProject: (n, id) => S.ensureProject(n, id, null),
    mergeRecordsAuthoritative: (pid, recs) => S.mergeRecordsAuthoritative(pid, recs),
    pruneProjectsNotIn: (names) => S.pruneProjectsNotIn(names),
    currentProjectId: () => S.getCurrentProjectId(),
  };

  return {
    name, S, CL, settings, localStorage: sandbox.localStorage,
    /** 建立并持久化本客户端自己的会话；之后所有操作都用它 */
    async login() {
      await CL.connect(settings);
      this.uid = CL.currentUserId();
      this.token = CL.sessionToken();
      return this.uid;
    },
    async pull() { return CL.syncToLocal(settings, hooks); },
    /** 模拟 app 的「先云端、成功后再本地」保存流程 */
    async save(period, payload) {
      const res = await CL.upsertRecord(settings, {
        projectName: PROJECT, periodLabel: period, inspector: 'sync-test', payload,
      });
      if (!res || !res.id) throw new Error('云端写入未返回 id');
      const proj = S.ensureProject(PROJECT, null, null);
      S.addRecord(proj.id, {
        periodLabel: period,
        input: payload.input, counts: payload.counts, metrics: payload.metrics,
        savedAt: Date.now(), cloudId: res.id, cloudSubmitter: CL.currentUserId(),
      }, true);
      return res;
    },
    /** 模拟 app 的删除流程：云端先删，再删本地 */
    async remove(period) {
      const proj = S.listProjects().find((p) => p.name === PROJECT);
      if (!proj) return { skipped: true };
      const rec = (S.getProject(proj.id).records || []).find((r) => r.periodLabel === period);
      if (!rec) return { skipped: true };
      if (!rec.cloudId) return { skipped: true, reason: '本地无 cloudId' };
      const r = await CL.deleteRecord(settings, rec.cloudId);
      S.deleteRecord(proj.id, rec.id);
      return r;
    },
    localRecords() {
      const proj = S.listProjects().find((p) => p.name === PROJECT);
      if (!proj) return [];
      return (S.getProject(proj.id).records || []).map((r) => r.periodLabel).sort();
    },
    localProjectNames() { return S.listProjects().map((p) => p.name).sort(); },
  };
}

function payload(tag, tp, fp, fn, tn) {
  const N = tp + fp + fn + tn;
  return {
    input: { periodLabel: tag, inspector: 'sync-test', sampleTotal: N, cm: { TP: tp, FP: fp, FN: fn, TN: tn } },
    counts: { TP: tp, FP: fp, FN: fn, TN: tn, N: N },
    metrics: {
      piActual: (tp + fn) / N, tauQc: (tp + fp) / N,
      recall: tp / (tp + fn), precision: tp / (tp + fp), f1: 0.9, marker: tag,
    },
    warning: { rMin: 0.5 }, acceptAccuracy: 0.95, obsWindow: 3, diagnostics: [],
  };
}

const sA = await signIn();
const sB = await signIn();
const A = makeClient('A', sA);
const B = makeClient('B', sB);
log('成员 A：' + String(sA.uid).slice(0, 8) + '　成员 B：' + String(sB.uid).slice(0, 8));
log('测试项目：' + PROJECT);
log('');

/* ============ 0. 两个客户端各自建立会话 ============ */
log('=== 0. 两个客户端各自登录（建立并持久化会话）===');
const uidA = await A.login();
const uidB = await B.login();
log('  A 会话成员：' + String(uidA).slice(0, 8) + '　B 会话成员：' + String(uidB).slice(0, 8));
ok(!!uidA && !!uidB, '两个客户端都取得会话');
ok(uidA !== uidB, '两个客户端是不同成员标识', uidA + ' vs ' + uidB);
log('');

/** 按记录归属选择对应会话（A 或 B） */
function sessionFor(submitter) {
  if (submitter === uidA) return A;
  if (submitter === uidB) return B;
  return null;
}

/* ============ 1. 初始写入与双端拉取 ============ */
log('=== 1. A 写入两条，B 拉取 ===');
await A.save('S1', payload('S1', 72, 26, 8, 894));
await A.save('S2', payload('S2', 70, 30, 10, 890));
await A.pull();
const pullB1 = await B.pull();
log('  A 本地：' + JSON.stringify(A.localRecords()));
log('  B 本地：' + JSON.stringify(B.localRecords()) + '　（本次新增 ' + pullB1.added + '）');
ok(A.localRecords().length === 2, 'A 有 2 条');
ok(B.localRecords().join(',') === 'S1,S2', 'B 拉到 2 条', B.localRecords().join(','));
log('');

/* ============ 2. 删除同步（核心回归 1） ============ */
log('=== 2. A 删除 S2 → B 拉取后应同步消失 ===');
await A.remove('S2');
const pullB2 = await B.pull();
log('  B 拉取统计：' + JSON.stringify(pullB2));
log('  B 本地：' + JSON.stringify(B.localRecords()));
ok(B.localRecords().indexOf('S2') < 0, '【核心】已删记录从 B 本地移除',
  '实际仍存在：' + B.localRecords().join(','));
ok(pullB2.removed >= 1, '拉取统计如实报告移除数量', String(pullB2.removed));
log('');

/* ============ 3. 复活防护（核心回归 2） ============ */
log('=== 3. 已删除记录不得被复活（核心回归） ===');
// A 再写一条 S3，B 拉取；然后 A 删除 S3；B 在未拉取的情况下直接保存一个不同的周期
await A.save('S3', payload('S3', 60, 40, 20, 880));
await B.pull();
await A.remove('S3');
// B 此时本地仍有 S3（尚未拉取），执行一次保存操作
const cloudNow = await rpc(sA, 'qc_fetch_all', { p_code: CODE });
const before = (cloudNow.body.find((p) => p.project_name === PROJECT).records || [])
  .map((r) => r.periodLabel).sort();
log('  A 删除 S3 后云端记录：' + JSON.stringify(before));
await B.save('S4', payload('S4', 50, 50, 30, 870));
const cloudAfter = await rpc(sA, 'qc_fetch_all', { p_code: CODE });
const after = (cloudAfter.body.find((p) => p.project_name === PROJECT).records || [])
  .map((r) => r.periodLabel).sort();
log('  B 保存 S4 后云端记录：' + JSON.stringify(after));
ok(after.indexOf('S3') < 0, '【核心】已删除的 S3 未被复活', '云端又出现了 S3');
ok(after.indexOf('S4') >= 0, 'B 新增的 S4 正常写入');
log('');

/* ============ 4. 陈旧副本不得覆盖他人新数据 ============ */
log('=== 4. B 用陈旧副本覆盖 A 的新数据应被拒绝 ===');
// A 更新 S1
const newer = await A.save('S1', payload('S1', 90, 5, 5, 900));
log('  A 更新 S1 → revision=' + (newer.revision || 1));
const cloudS1 = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT).records.find((r) => r.periodLabel === 'S1');
log('  云端 S1 现在 recall=' + cloudS1.payload.metrics.recall + '（A 写入 0.947）');
// B 未拉取，直接用陈旧数据推
let staleRes = null;
try { staleRes = await B.save('S1', payload('S1', 72, 26, 8, 894)); } catch (e) { staleRes = { error: e.message }; }
const cloudS1b = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT).records.find((r) => r.periodLabel === 'S1');
log('  B 陈旧写入结果：' + (staleRes.error ? staleRes.error : 'HTTP ' + staleRes.status));
log('  云端 S1 最终 recall=' + cloudS1b.payload.metrics.recall);
// 注意：云端存的是完整精度（0.9473684...），比较需用容差而非严格相等
ok(Math.abs(cloudS1b.payload.metrics.recall - (90 / 95)) < 1e-9,
  'A 的新数据未被陈旧副本覆盖',
  '实际 ' + cloudS1b.payload.metrics.recall + '，期望 ' + (90 / 95));
ok(cloudS1b.payload.metrics.marker === 'S1' && cloudS1b.payload.metrics.recall > 0.94,
  '云端仍是 A 写入的版本（高召回率）');
log('');

/* ============ 5. 并发写同周期不产生重复 ============ */
log('=== 5. 两人同时写同周期 ===');
const conc = await Promise.allSettled([
  A.save('S5', payload('S5', 80, 10, 10, 900)),
  B.save('S5', payload('S5', 20, 20, 20, 940)),
]);
const concStatus = conc.map((c) => (c.status === 'fulfilled' ? '成功' : '被拒：' + String(c.reason.message).slice(0, 60)));
log('  A：' + concStatus[0]);
log('  B：' + concStatus[1]);
const s5 = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT).records.filter((r) => r.periodLabel === 'S5');
log('  云端 S5 条数：' + s5.length);
ok(s5.length === 1, '并发写同周期只留一条记录（唯一约束生效）', String(s5.length));
ok(concStatus.filter((s) => s.indexOf('被拒') >= 0).length <= 1, '最多一方被拒，数据未损坏');
log('');

/* ============ 6. 云端删项目 → 本地清理 ============ */
log('=== 6. 云端删掉项目后，本地也应清掉 ===');
const projCloud = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT);
log('  项目下记录（含归属）：');
(projCloud.records || []).forEach((r) => {
  log('    ' + r.periodLabel + '　submitter=' + String(r.submitter).slice(0, 8)
    + (sessionFor(r.submitter) === A ? '（A）' : sessionFor(r.submitter) === B ? '（B）' : '（未知）'));
});
// 用各自的会话删除自己名下的记录
let allDeleted = true;
for (const rec of projCloud.records || []) {
  const sess = sessionFor(rec.submitter);
  if (!sess) { allDeleted = false; log('    ⚠ ' + rec.periodLabel + ' 归属未知会话，无法删除'); continue; }
  const r = await rpc(sess, 'qc_delete_record', { p_code: CODE, p_record_id: rec.id });
  if (r.status !== 200) { allDeleted = false; log('    删除 ' + rec.periodLabel + ' 失败：' + String(r.raw).slice(0, 100)); }
}
ok(allDeleted, '项目内所有记录均可由各自会话删除');

// 若还有残留（例如之前测试遗留的未知归属记录），用管理员函数兜底
const stillProj = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT);
if (stillProj && (stillProj.records || []).length > 0) {
  log('  仍有 ' + stillProj.records.length + ' 条无法归属的记录，改用管理员清理函数');
  const adm = await rpc(sA, 'qc_admin_cleanup', {
    p_code: CODE, p_confirm: 'CONFIRM_DELETE', p_project_ids: [stillProj.project_id],
  });
  log('  管理员清理结果：HTTP ' + adm.status + ' ' + String(adm.raw).slice(0, 120));
}

const projB = (await rpc(sB, 'qc_fetch_all', { p_code: CODE })).body
  .find((p) => p.project_name === PROJECT);
log('  云端项目是否已删：' + (projB ? '否（仍有记录 ' + (projB.records || []).length + ' 条）' : '是'));

// 直接测试项目删除接口，看它到底返回什么
if (projB) {
  const tryDel = await rpc(sB, 'qc_delete_project', { p_code: CODE, p_project_id: projB.project_id });
  log('  用 B 会话再删一次项目 → HTTP ' + tryDel.status + ' ' + String(tryDel.raw).slice(0, 160));
  const tryDelA = await rpc(sA, 'qc_delete_project', { p_code: CODE, p_project_id: projB.project_id });
  log('  用 A 会话再删一次项目 → HTTP ' + tryDelA.status + ' ' + String(tryDelA.raw).slice(0, 160));
}
// 决定性诊断：把同步的输入输出全打出来
const remoteNow = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body;
log('  拉取前云端项目名：' + JSON.stringify(remoteNow.map((p) => p.project_name)));
log('  B 本地库原始项目：' + JSON.stringify(Object.values(
  JSON.parse(B.localStorage.getItem('qceval:projects') || '{}')).map((p) => p.name)));
const beforePullNames = B.localProjectNames();
const pullB3 = await B.pull();
log('  B 拉取统计：' + JSON.stringify(pullB3));
log('  B 拉取前项目：' + JSON.stringify(beforePullNames));
log('  B 拉取后项目：' + JSON.stringify(B.localProjectNames()));
ok(B.localProjectNames().indexOf(PROJECT) < 0,
  '【核心】云端已删项目从本地清除',
  '本地仍残留（拉取统计 ' + JSON.stringify(pullB3) + '）');
log('');

/* ============ 清理 ============ */
log('=== 清理 ===');
const left = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .filter((p) => p.project_name.indexOf('__E2E_') === 0);
log('  待清理测试项目：' + (left.map((p) => p.project_name + '(' + (p.records || []).length + '条)').join(', ') || '（无）'));
let cleanupFailed = [];
for (const p of left) {
  for (const rec of p.records || []) {
    const sess = sessionFor(rec.submitter);
    if (!sess) { cleanupFailed.push('记录 ' + rec.periodLabel + ' 归属未知'); continue; }
    const dr = await rpc(sess, 'qc_delete_record', { p_code: CODE, p_record_id: rec.id });
    if (dr.status !== 200) cleanupFailed.push('删记录 ' + rec.periodLabel + ' HTTP ' + dr.status);
  }
  let dp = await rpc(sA, 'qc_delete_project', { p_code: CODE, p_project_id: p.project_id });
  if (dp.status !== 200) dp = await rpc(sB, 'qc_delete_project', { p_code: CODE, p_project_id: p.project_id });
  if (dp.status !== 200) {
    cleanupFailed.push('删项目 ' + p.project_name + ' HTTP ' + dp.status + ' ' + String(dp.raw).slice(0, 80));
    await rpc(sA, 'qc_admin_cleanup', {
      p_code: CODE, p_confirm: 'CONFIRM_DELETE', p_project_ids: [p.project_id],
    });
  }
}
// 清理失败必须显式暴露，绝不静默吞掉（否则会留下空项目干扰后续排查）
ok(cleanupFailed.length === 0, '清理过程无失败', cleanupFailed.join('；'));
const remain = (await rpc(sA, 'qc_fetch_all', { p_code: CODE })).body
  .filter((p) => p.project_name.indexOf('__E2E_') === 0);
log('  残留测试项目：' + remain.length);
ok(remain.length === 0, '测试数据已清理', remain.map((p) => p.project_name).join(','));

log('');
log('────────────────────────────────');
log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { log(''); log('失败明细：'); failures.forEach((f) => log('  ✗ ' + f)); process.exitCode = 1; }
else log('多用户同步一致性全部通过 ✓');
await writeFile('E:/布偶/_sync_fix_result.txt', out.join('\n'), 'utf8');
