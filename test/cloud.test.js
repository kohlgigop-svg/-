/* =============================================================================
 * 云端同步端到端测试（对真实 Supabase 项目执行）
 * -----------------------------------------------------------------------------
 * 前置：Supabase 已执行 supabase/schema.sql，且已开启 Anonymous sign-ins
 * 覆盖：访问码校验、匿名登录、上传/修订、仅本人可改删、跨用户可见性、
 *       项目级取数、删除保护
 * 注意：会写入测试数据，跑完自动清理
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const URL_ = 'https://ofdtgchdkhgvksuohzoq.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZHRnY2hka2hndmtzdW9oem9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MTkwOTcsImV4cCI6MjEwNTA5NTA5N30.7tZhOUgN-VOLjUUzZveHrnEKECTZhEI7-DFXoUq3xRw';
const CODE = 'qc-eval-2026';
const WRONG_CODE = 'not-the-code';
// 每次运行使用唯一名称，避免上一次失败残留的数据造成互相干扰
const RUN_ID = Date.now().toString(36);
const PROJECT = '__E2E_TEST_PROJECT__' + RUN_ID;
const PERIOD = '__E2E_PERIOD__' + RUN_ID;
// 历史遗留的测试项目名前缀（用于开头清场）
const TEST_PREFIX = '__E2E_TEST_PROJECT__';

let pass = 0, fail = 0;
const failures = [];
const ok = (c, n, extra) => { if (c) pass++; else { fail++; failures.push(n + (extra ? '  → ' + extra : '')); } };
const log = (s) => console.log(s);

/* 两个独立「成员」会话 */
async function anonSignIn() {
  const r = await fetch(URL_ + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('匿名登录失败 HTTP ' + r.status + '：' + t.slice(0, 240));
  const j = JSON.parse(t);
  return { access_token: j.access_token, user_id: j.user ? j.user.id : null };
}

async function rpc(session, fn, args) {
  const r = await fetch(URL_ + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + (session ? session.access_token : KEY),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });
  const t = await r.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch (e) { body = t; }
  return { status: r.status, ok: r.ok, body: body, raw: t };
}

function samplePayload(tp, fp, fn, tn, label) {
  const N = tp + fp + fn + tn;
  return {
    input: { periodLabel: label, inspector: 'E2E', populationTotal: 100000, sampleTotal: N, cm: { TP: tp, FP: fp, FN: fn, TN: tn } },
    counts: { TP: tp, FP: fp, FN: fn, TN: tn, N: N },
    metrics: { piActual: (tp + fn) / N, tauQc: (tp + fp) / N, recall: tp / (tp + fn), precision: tp / (tp + fp) },
    warning: { rMin: 0.375, baselineB: 0.08 },
    acceptAccuracy: 0.95,
    obsWindow: 3,
    diagnostics: [],
  };
}

async function main() {
  log('=== 0. 环境前置检查 ===');
  const authSettings = await fetch(URL_ + '/auth/v1/settings', { headers: { apikey: KEY } });
  const asJson = await authSettings.json();
  const anonOn = asJson.external && asJson.external.anonymous_users === true;
  ok(anonOn, 'Supabase 已开启 Anonymous sign-ins', anonOn ? '' : '请到 Authentication → Sign In / Providers 打开');
  if (!anonOn) { report(); return; }

  const schemaCheck = await rpc(null, 'qc_check_access', { p_code: CODE });
  const schemaReady = schemaCheck.status === 200;
  ok(schemaReady, 'schema.sql 已执行（能找到 qc_check_access 函数）',
    schemaReady ? '' : 'HTTP ' + schemaCheck.status + ' ' + schemaCheck.raw.slice(0, 160));
  if (!schemaReady) { report(); return; }

  // 两个成员会话，供本次运行与清理共用
  let userA = null, userB = null;

  /** 清场：删除本项目下能删的记录，再删项目；两个会话都试一遍 */
  async function cleanup(label) {
    const sessions = [userA, userB].filter(Boolean);
    if (!sessions.length) return;
    let deletedRecs = 0, deletedProj = 0, remaining = null;
    for (const s of sessions) {
      const cur = await rpc(s, 'qc_fetch_all', { p_code: CODE });
      const proj = (cur.body || []).find((p) => p.project_name === PROJECT);
      if (!proj) continue;
      for (const rec of proj.records || []) {
        const r = await rpc(s, 'qc_delete_record', { p_code: CODE, p_record_id: rec.id });
        if (r.status === 200) deletedRecs++;
      }
      const dp = await rpc(s, 'qc_delete_project', { p_code: CODE, p_project_id: proj.project_id });
      if (dp.status === 200) deletedProj++;
    }
    const after = await rpc(sessions[0], 'qc_fetch_all', { p_code: CODE });
    remaining = (after.body || []).find((p) => p.project_name === PROJECT) || null;
    if (label) log('  [' + label + '] 清理记录 ' + deletedRecs + ' 条，项目 ' + deletedProj + ' 个，'
      + (remaining ? '仍有残留' : '已清空'));
    return !remaining;
  }

  try {
    await runAll(userA, userB);
  } catch (e) {
    ok(false, '测试执行过程未抛异常', e.message);
    log('\n⚠ 测试中断：' + e.message);
  } finally {
    log('\n=== 12. 清理测试数据（无论成败都会执行）===');
    const clean = await cleanup('收尾');
    ok(clean !== false, '测试数据已清理干净', clean === false ? '仍有残留，请到 Supabase 控制台手动删除' : '');
    report();
  }

  /* ---------------- 正文 ---------------- */
  async function runAll(_a, _b) {
    log('\n=== 1. 访问码校验（数据库层）===');
    ok(schemaCheck.body === true, '正确访问码返回 true', JSON.stringify(schemaCheck.body));
    const bad = await rpc(null, 'qc_check_access', { p_code: WRONG_CODE });
    ok(bad.body === false, '错误访问码返回 false', JSON.stringify(bad.body));
    const empty = await rpc(null, 'qc_check_access', { p_code: '' });
    ok(empty.body === false, '空访问码返回 false', JSON.stringify(empty.body));

    log('\n=== 2. 直接访问数据表必须被拒绝（RLS 生效）===');
    const directRead = await fetch(URL_ + '/rest/v1/qc_records?select=*', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY },
    });
    const directBody = await directRead.text();
    ok(directRead.status !== 200 || directBody === '[]',
      '匿名 key 无法直接读取 qc_records 表', 'HTTP ' + directRead.status + ' ' + directBody.slice(0, 120));

    log('\n=== 3. 匿名登录与成员标识 ===');
    userA = await anonSignIn();
    userB = await anonSignIn();
    ok(!!userA.access_token && !!userA.user_id, '成员 A 匿名登录成功');
    ok(!!userB.access_token && !!userB.user_id, '成员 B 匿名登录成功');
    ok(userA.user_id !== userB.user_id, '两个成员标识不同（可区分提交者）',
      userA.user_id + ' vs ' + userB.user_id);

    log('\n=== 3b. 历史遗留测试项目清场 ===');
    // 本项目同时是「测试污染会被归属保护拦住」的活体验证：
    // 上次失败残留的记录归旧会话所有，新会话无法修订，必须先清场。
    {
      const pre = await rpc(userA, 'qc_fetch_all', { p_code: CODE });
      const strays = (pre.body || []).filter((p) => String(p.project_name).indexOf(TEST_PREFIX) === 0);
      let cleaned = 0, blocked = 0;
      for (const p of strays) {
        const r = await rpc(userA, 'qc_delete_project', { p_code: CODE, p_project_id: p.project_id });
        if (r.status === 200) cleaned++;
        else blocked++;
      }
      log('  发现遗留测试项目 ' + strays.length + ' 个：已清理 ' + cleaned + ' 个，'
        + '因含他人记录无法整体删除 ' + blocked + ' 个');
      ok(blocked === 0, '无遗留测试项目阻塞本次运行',
        blocked ? '需到 Supabase 控制台手动清理 ' + blocked + ' 个历史测试项目' : '');
    }
    const a = userA, b = userB;

    log('\n=== 4. 未带访问码的写入必须被拒绝 ===');
    const noCode = await rpc(a, 'qc_upsert_record', {
      p_code: WRONG_CODE, p_project_name: PROJECT, p_period: PERIOD, p_inspector: 'E2E',
      p_payload: samplePayload(9, 1, 1, 989, PERIOD),
    });
    ok(noCode.status >= 400, '错误访问码写入被拒绝', 'HTTP ' + noCode.status);
    ok(/ACCESS_DENIED/.test(noCode.raw), '错误信息为 ACCESS_DENIED', noCode.raw.slice(0, 120));

    log('\n=== 5. 成员 A 首次提交 ===');
    const upA = await rpc(a, 'qc_upsert_record', {
      p_code: CODE, p_project_name: PROJECT, p_period: PERIOD, p_inspector: 'E2E-A',
      p_payload: samplePayload(72, 26, 8, 894, PERIOD),
    });
    ok(upA.status === 200, '成员 A 提交成功', 'HTTP ' + upA.status + ' ' + upA.raw.slice(0, 160));
    const recA = upA.body;
    ok(recA && recA.id, '返回记录 id');
    ok(recA && recA.revision === 1, '首次提交 revision=1', String(recA && recA.revision));
    if (!recA || !recA.id) return;

    log('\n=== 6. 成员 B 能看到该项目与记录（共享生效）===');
    const fetchB = await rpc(b, 'qc_fetch_all', { p_code: CODE });
    ok(fetchB.status === 200, '成员 B 拉取成功', 'HTTP ' + fetchB.status);
    const projB = (fetchB.body || []).find((p) => p.project_name === PROJECT);
    ok(!!projB, '成员 B 看到了成员 A 创建的项目');
    ok(projB && projB.records.length >= 1, '成员 B 看到了成员 A 的记录',
      String(projB && projB.records.length));

    log('\n=== 7. 同周期重复提交＝修订，且仅本人可改 ===');
    const upA2 = await rpc(a, 'qc_upsert_record', {
      p_code: CODE, p_project_name: PROJECT, p_period: PERIOD, p_inspector: 'E2E-A',
      p_payload: samplePayload(70, 28, 10, 892, PERIOD),
    });
    ok(upA2.status === 200, '成员 A 可修订自己的记录', 'HTTP ' + upA2.status);
    ok(upA2.body && upA2.body.revision === 2, 'revision 递增为 2', String(upA2.body && upA2.body.revision));
    ok(upA2.body && upA2.body.id === recA.id, '修订后记录 id 不变（未产生重复记录）');

    const upB = await rpc(b, 'qc_upsert_record', {
      p_code: CODE, p_project_name: PROJECT, p_period: PERIOD, p_inspector: 'E2E-B',
      p_payload: samplePayload(1, 1, 1, 997, PERIOD),
    });
    ok(upB.status >= 400, '成员 B 不能修订成员 A 的记录', 'HTTP ' + upB.status);
    ok(/NOT_OWNER/.test(upB.raw), '错误信息为 NOT_OWNER', upB.raw.slice(0, 140));

    log('\n=== 8. 同项目同周期不产生重复记录 ===');
    const after = await rpc(a, 'qc_fetch_all', { p_code: CODE });
    const projAfter = (after.body || []).find((p) => p.project_name === PROJECT);
    const samePeriod = (projAfter.records || []).filter((r) => r.periodLabel === PERIOD);
    ok(samePeriod.length === 1, '同项目同周期只有一条记录', String(samePeriod.length));

    log('\n=== 9. 仅本人可删除 ===');
    const delOther = await rpc(b, 'qc_delete_record', { p_code: CODE, p_record_id: recA.id });
    ok(delOther.status >= 400, '成员 B 不能删除成员 A 的记录', 'HTTP ' + delOther.status);
    ok(/NOT_OWNER/.test(delOther.raw), '删除他人记录报 NOT_OWNER', delOther.raw.slice(0, 140));
    const stillThere = await rpc(a, 'qc_fetch_all', { p_code: CODE });
    const stillRec = ((stillThere.body || []).find((p) => p.project_name === PROJECT) || {}).records || [];
    ok(stillRec.length === 1, '他人删除尝试后记录仍存在（未被误删）', String(stillRec.length));

    log('\n=== 10. 项目删除保护（存在他人记录时不可删）===');
    const projId = projAfter.project_id;
    const bPeriod = PERIOD + '_B';
    const upB2 = await rpc(b, 'qc_upsert_record', {
      p_code: CODE, p_project_name: PROJECT, p_period: bPeriod, p_inspector: 'E2E-B',
      p_payload: samplePayload(5, 5, 5, 985, bPeriod),
    });
    ok(upB2.status === 200, '成员 B 提交自己的周期成功', 'HTTP ' + upB2.status);
    const delProjByA = await rpc(a, 'qc_delete_project', { p_code: CODE, p_project_id: projId });
    ok(delProjByA.status >= 400, '项目下存在他人记录时不可删除', 'HTTP ' + delProjByA.status);
    ok(/PROJECT_HAS_OTHERS_RECORDS/.test(delProjByA.raw), '错误信息为 PROJECT_HAS_OTHERS_RECORDS',
      delProjByA.raw.slice(0, 160));

    log('\n=== 11. 项目级取数（警戒线基线用「该项目全部记录」）===');
    const allRecs = await rpc(a, 'qc_fetch_all', { p_code: CODE });
    const projFinal = (allRecs.body || []).find((p) => p.project_name === PROJECT);
    ok(projFinal.records.length === 2, '项目下共 2 条记录（两位成员各一条）',
      String(projFinal.records.length));
    const submitters = new Set(projFinal.records.map((r) => r.submitter));
    ok(submitters.size === 2, '两条记录来自不同提交者（可用于区分归属）', String(submitters.size));
    const piList = projFinal.records
      .map((r) => r.payload && r.payload.metrics && r.payload.metrics.piActual)
      .filter((v) => typeof v === 'number');
    ok(piList.length === 2, '可从云端记录中取出各周期的 π 用于基线计算', JSON.stringify(piList));
    ok(projFinal.records.every((r) => r.payload && r.payload.input), '记录 payload 结构完整（含 input）');
  }
}

function report() {
  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
  else console.log('云端端到端全部通过 ✓');
}

main().catch((e) => { console.error('测试异常：', e.message); process.exitCode = 1; });
