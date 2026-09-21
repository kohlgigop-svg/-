/* =============================================================================
 * 分层抽样加权估计测试（TDD：先写测试，看它失败，再实现）
 * -----------------------------------------------------------------------------
 * 背景：非等概率分层抽样下，直接用「抽样内计数」算出的指标是有偏的。
 *       实测偏差可达 ±77pp（见 README「分层抽样」一节）。
 *       本测试锁定加权估计的正确性、无偏性与区间覆盖率。
 *
 * 分层依据：必须是「质检判定」——分层要在拿到金标准之前完成，
 *           而「实际应驳回」需要先有金标准，无法用来分层。
 *             驳回层 = 质检判为驳回 → 内含 TP 与 FP
 *             通过层 = 质检判为通过 → 内含 FN 与 TN
 * ========================================================================== */
'use strict';
const Core = require('../src/core.js');

// 功能尚未实现时用桩替代，好让整份清单跑完、一次看清要实现什么
const C = Object.assign({}, Core, {
  computeStratified: typeof Core.computeStratified === 'function'
    ? Core.computeStratified
    : () => null,
});
if (typeof Core.computeStratified !== 'function') {
  console.log('（computeStratified 尚未实现，以下为待实现清单）\n');
}

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name, extra) => {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, tol, name, extra) => ok(
  a !== null && a !== undefined && Math.abs(a - b) <= tol,
  name, (extra ? extra + '　' : '') + '实际 ' + a + '，期望 ' + b + ' ±' + tol);

/* ---------- 已知真值的总体（与模拟脚本一致） ---------- */
const POP = { TP: 8000, FP: 2000, FN: 1000, TN: 89000 };
const POP1 = POP.TP + POP.FP;      // 驳回层 10000
const POP2 = POP.FN + POP.TN;      // 通过层 90000
const NPOP = POP1 + POP2;          // 100000
const TRUE = {
  recall: POP.TP / (POP.TP + POP.FN),          // 0.888888...
  precision: POP.TP / POP1,                     // 0.80
  specificity: POP.TN / (POP.TN + POP.FP),      // 0.978021...
  npv: POP.TN / (POP.TN + POP.FN),              // 0.988888...
  accuracy: (POP.TP + POP.TN) / NPOP,           // 0.97
  piActual: (POP.TP + POP.FN) / NPOP,           // 0.09
  tauQc: POP1 / NPOP,                            // 0.10
};

console.log('=== 1. 接口存在性与基本结构 ===');
// 注意：这里必须查 Core 本身，不能查带桩的 C，否则会假通过
ok(typeof Core.computeStratified === 'function', 'core 暴露 computeStratified');

const strataEqual = [
  { name: '驳回层', pop: POP1, sample: 100 },
  { name: '通过层', pop: POP2, sample: 900 },
];
const cmEqual = { TP: 80, FP: 20, FN: 10, TN: 890 };   // 驳回层 100 条、通过层 900 条

const rEqual = C.computeStratified(strataEqual, cmEqual);
ok(rEqual !== null && typeof rEqual === 'object', '返回对象');
if (rEqual) {
  ok(rEqual.popCounts && typeof rEqual.popCounts.TP === 'number', '含加权后的总体计数 popCounts');
  ok(rEqual.metrics && typeof rEqual.metrics.recall === 'number', '含加权指标 metrics');
  ok(rEqual.sampleMetrics && typeof rEqual.sampleMetrics.recall === 'number', '同时保留样本内指标 sampleMetrics');
  ok(typeof rEqual.selfWeighting === 'boolean', '标注是否自加权 selfWeighting');
  ok(rEqual.designEffect === null || typeof rEqual.designEffect === 'object', '给出各指标的设计效应');
}

console.log('=== 2. 等概率抽样时，加权结果应与样本内一致（自加权） ===');
if (rEqual) {
  ok(rEqual.selfWeighting === true, '等抽样比被识别为自加权');
  ['recall', 'precision', 'specificity', 'npv', 'accuracy', 'piActual', 'tauQc'].forEach((k) => {
    near(rEqual.metrics[k], rEqual.sampleMetrics[k], 1e-9, '自加权时 ' + k + ' 与样本内相同');
  });
}

console.log('=== 3. 非等概率抽样时，加权估计应还原总体真值 ===');
// 驳回层抽 10%（1000 条），通过层抽 1%（900 条）
// 期望计数：TP=800 FP=200 FN=10 TN=890
const strataOver = [
  { name: '驳回层', pop: POP1, sample: 1000 },
  { name: '通过层', pop: POP2, sample: 900 },
];
const cmOver = { TP: 800, FP: 200, FN: 10, TN: 890 };
const rOver = C.computeStratified(strataOver, cmOver);
ok(rOver !== null, '过采样场景返回结果');
if (rOver) {
  ok(rOver.selfWeighting === false, '非等抽样比被识别为非自加权');
  near(rOver.popCounts.TP, 8000, 1, '还原总体 TP');
  near(rOver.popCounts.FP, 2000, 1, '还原总体 FP');
  near(rOver.popCounts.FN, 1000, 1, '还原总体 FN');
  near(rOver.popCounts.TN, 89000, 1, '还原总体 TN');

  near(rOver.metrics.recall, TRUE.recall, 1e-6, '加权召回率还原真值');
  near(rOver.metrics.specificity, TRUE.specificity, 1e-6, '加权特异度还原真值');
  near(rOver.metrics.accuracy, TRUE.accuracy, 1e-6, '加权准确率还原真值');
  near(rOver.metrics.npv, TRUE.npv, 1e-6, '加权 NPV 还原真值');
  near(rOver.metrics.piActual, TRUE.piActual, 1e-6, '加权 π 还原真值');
  near(rOver.metrics.tauQc, TRUE.tauQc, 1e-6, '加权 τ 还原真值');

  // 样本内口径必须同时保留，且确实是有偏的（这正是要警示用户的）
  near(rOver.sampleMetrics.recall, 800 / 810, 1e-9, '样本内召回率保留原值');
  ok(Math.abs(rOver.sampleMetrics.recall - TRUE.recall) > 0.05,
    '样本内召回率确实显著偏离真值（应被警示）',
    '偏差 ' + ((rOver.sampleMetrics.recall - TRUE.recall) * 100).toFixed(2) + 'pp');
}

console.log('=== 4. 精确率不受加权影响（完全落在驳回层内） ===');
if (rOver) {
  near(rOver.metrics.precision, TRUE.precision, 1e-9, '加权精确率 = 真值');
  near(rOver.sampleMetrics.precision, TRUE.precision, 1e-9, '样本内精确率也 = 真值（无偏）');
  near(rOver.metrics.precision, rOver.sampleMetrics.precision, 1e-12, '两种口径的精确率完全相同');
}

console.log('=== 5. τ 是已知常数，不应有抽样误差 ===');
if (rOver) {
  near(rOver.metrics.tauQc, POP1 / NPOP, 1e-12, 'τ 恰为驳回层占总体比例');
  ok(rOver.ci && rOver.ci.tauQc && rOver.ci.tauQc.lo === rOver.ci.tauQc.hi,
    'τ 的区间宽度为零（它是已知量，不是估计量）',
    rOver.ci && rOver.ci.tauQc ? '[' + rOver.ci.tauQc.lo + ', ' + rOver.ci.tauQc.hi + ']' : '(缺失)');
}

console.log('=== 6. 设计效应：过采样应显著降低召回率的有效样本量 ===');
if (rOver) {
  ok(rOver.nEff && typeof rOver.nEff.recall === 'number', '给出召回率的有效样本量');
  if (rOver.nEff) {
    const rawRecallN = cmOver.TP + cmOver.FN;   // 810
    ok(rOver.nEff.recall < rawRecallN * 0.5,
      '召回率有效样本量远小于原始计数（过采样的代价）',
      '有效 ' + rOver.nEff.recall.toFixed(1) + ' vs 原始 ' + rawRecallN);
    ok(rOver.nEff.precision >= cmOver.TP + cmOver.FP,
      '精确率有效样本量不低于驳回层样本量（层内有限总体校正只会增益）',
      '有效 ' + rOver.nEff.precision.toFixed(1) + ' vs 原始 ' + (cmOver.TP + cmOver.FP));
  }
}

console.log('=== 7. 区间应比朴素 Wilson 更宽（反映真实不确定性） ===');
if (rOver) {
  const naive = C.wilson(cmOver.TP, cmOver.TP + cmOver.FN, 1.959963985);
  const wStrat = rOver.ci.recall.hi - rOver.ci.recall.lo;
  const wNaive = naive.hi - naive.lo;
  ok(wStrat > wNaive * 2,
    '分层区间显著宽于朴素区间', '分层 ' + wStrat.toFixed(4) + ' vs 朴素 ' + wNaive.toFixed(4));
  ok(rOver.ci.recall.lo < TRUE.recall && rOver.ci.recall.hi > TRUE.recall,
    '分层区间覆盖真值',
    '[' + rOver.ci.recall.lo.toFixed(4) + ', ' + rOver.ci.recall.hi.toFixed(4) + '] 真值 ' + TRUE.recall.toFixed(4));
  ok(!(naive.lo < TRUE.recall && naive.hi > TRUE.recall),
    '朴素区间【未能】覆盖真值（证明现行做法会误导）',
    '[' + naive.lo.toFixed(4) + ', ' + naive.hi.toFixed(4) + '] 真值 ' + TRUE.recall.toFixed(4));
}

console.log('=== 8. 整层全取时该层无抽样误差 ===');
const strataFull = [
  { name: '驳回层', pop: 1000, sample: 1000 },   // 全取
  { name: '通过层', pop: 99000, sample: 500 },
];
const cmFull = { TP: 800, FP: 200, FN: 5, TN: 495 };
const rFull = C.computeStratified(strataFull, cmFull);
ok(rFull !== null, '整层全取场景返回结果');
if (rFull) {
  near(rFull.popCounts.TP, 800, 1e-9, '全取层计数直接等于总体真值');
  ok(rFull.fullyEnumerated === true, '标注存在整层全取');
  ok(rFull.ci.precision.hi - rFull.ci.precision.lo < 1e-9,
    '全取层内部的精确率无抽样误差（区间退化为点）',
    '[' + rFull.ci.precision.lo.toFixed(6) + ', ' + rFull.ci.precision.hi.toFixed(6) + ']');
}

console.log('=== 9. 一致性校验：层样本量必须与混淆矩阵对应 ===');
const bad1 = C.computeStratified(
  [{ name: '驳回层', pop: 10000, sample: 999 }, { name: '通过层', pop: 90000, sample: 900 }],
  { TP: 800, FP: 200, FN: 10, TN: 890 });
ok(bad1 && bad1.consistent === false, '驳回层样本量 ≠ TP+FP 时标记为不一致');
ok(bad1 && /驳回层/.test(bad1.inconsistencyReason || ''), '给出可读的不一致原因',
  bad1 ? bad1.inconsistencyReason : '(无)');

const bad2 = C.computeStratified(
  [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 111 }],
  { TP: 800, FP: 200, FN: 10, TN: 890 });
ok(bad2 && bad2.consistent === false, '通过层样本量 ≠ FN+TN 时标记为不一致');

const good = C.computeStratified(strataOver, cmOver);
ok(good && good.consistent === true, '对应正确时标记为一致');

console.log('=== 10. 退化与边界 ===');
ok(C.computeStratified(null, cmOver) === null, '无分层信息返回 null');
ok(C.computeStratified([], cmOver) === null, '空分层返回 null');
ok(C.computeStratified(strataOver, null) === null, '无混淆矩阵返回 null');
const zeroFN = C.computeStratified(
  [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 900 }],
  { TP: 1000, FP: 0, FN: 0, TN: 900 });
ok(zeroFN !== null, '零计数场景不崩溃');
if (zeroFN) {
  near(zeroFN.metrics.recall, 1, 1e-9, '无漏判时召回率为 1');
  ok(zeroFN.ci.recall.lo < 1, '召回率为 1 时区间下界仍小于 1（Wilson 特性）',
    String(zeroFN.ci.recall.lo));
}

console.log('=== 11. 蒙特卡洛：加权估计无偏、区间覆盖率≈95% ===');
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hypergeometric(rnd, K, M, n) {
  let k = K, m = M, s = 0;
  for (let i = 0; i < n; i++) {
    const tot = k + m;
    if (tot <= 0) break;
    if (rnd() < k / tot) { s++; k--; } else { m--; }
  }
  return s;
}
{
  const rnd = mulberry32(20260917);
  const TRIALS = 1500;
  const n1 = 1000, n2 = 900;
  let sumRecall = 0, coverRecall = 0, coverNaive = 0, sumPi = 0, coverPi = 0;
  let skipped = false;
  for (let t = 0; t < TRIALS; t++) {
    const tp = hypergeometric(rnd, POP.TP, POP.FP, n1);
    const fp = n1 - tp;
    const fn = hypergeometric(rnd, POP.FN, POP.TN, n2);
    const tn = n2 - fn;
    const res = C.computeStratified(
      [{ name: '驳回层', pop: POP1, sample: n1 }, { name: '通过层', pop: POP2, sample: n2 }],
      { TP: tp, FP: fp, FN: fn, TN: tn });
    if (!res) { skipped = true; break; }
    sumRecall += res.metrics.recall;
    sumPi += res.metrics.piActual;
    if (res.ci.recall.lo <= TRUE.recall && res.ci.recall.hi >= TRUE.recall) coverRecall++;
    if (res.ci.piActual.lo <= TRUE.piActual && res.ci.piActual.hi >= TRUE.piActual) coverPi++;
    const nv = C.wilson(tp, tp + fn, 1.959963985);
    if (nv.lo <= TRUE.recall && nv.hi >= TRUE.recall) coverNaive++;
  }
  const meanRecall = sumRecall / TRIALS;
  const meanPi = sumPi / TRIALS;
  const covR = coverRecall / TRIALS;
  const covPi = coverPi / TRIALS;
  const covN = coverNaive / TRIALS;
  if (skipped) {
    ok(false, '蒙特卡洛：加权召回率均值无偏（功能未实现）');
    ok(false, '蒙特卡洛：加权 π 均值无偏（功能未实现）');
    ok(false, '蒙特卡洛：分层区间覆盖率接近 95%（功能未实现）');
    ok(false, '蒙特卡洛：π 区间覆盖率接近 95%（功能未实现）');
    ok(false, '蒙特卡洛：朴素区间覆盖率极低（功能未实现）');
  } else {
    console.log('  加权召回率均值 ' + (meanRecall * 100).toFixed(2) + '%（真值 ' + (TRUE.recall * 100).toFixed(2) + '%）');
    console.log('  加权 π 均值    ' + (meanPi * 100).toFixed(2) + '%（真值 ' + (TRUE.piActual * 100).toFixed(2) + '%）');
    console.log('  分层区间覆盖率 ' + (covR * 100).toFixed(1) + '%　朴素区间覆盖率 ' + (covN * 100).toFixed(1) + '%');
    near(meanRecall, TRUE.recall, 0.005, '加权召回率均值无偏（±0.5pp 内）');
    near(meanPi, TRUE.piActual, 0.003, '加权 π 均值无偏（±0.3pp 内）');
    ok(covR >= 0.92 && covR <= 0.99, '分层区间覆盖率接近 95%', (covR * 100).toFixed(1) + '%');
    ok(covPi >= 0.92 && covPi <= 0.99, 'π 区间覆盖率接近 95%', (covPi * 100).toFixed(1) + '%');
    ok(covN < 0.5, '朴素区间覆盖率极低（证明必须修正）', (covN * 100).toFixed(1) + '%');
  }
}

console.log('=== 12. F 族在分层设计下的区间 ===');
if (rOver) {
  ok(rOver.bootF && rOver.bootF.f1 && typeof rOver.bootF.f1.lo === 'number', '给出分层 Bootstrap 的 F1 区间');
  if (rOver.bootF) {
    const trueF1 = 2 * TRUE.precision * TRUE.recall / (TRUE.precision + TRUE.recall);
    ok(rOver.bootF.f1.lo <= trueF1 && rOver.bootF.f1.hi >= trueF1,
      '分层 F1 区间覆盖总体真值',
      '[' + rOver.bootF.f1.lo.toFixed(4) + ', ' + rOver.bootF.f1.hi.toFixed(4) + '] 真值 ' + trueF1.toFixed(4));
    ok(rOver.bootF.f1.lo < rOver.bootF.f1.hi, 'F1 区间非退化');
    ok(rOver.bootF.f2 && rOver.bootF.f05, '同时给出 F2 与 F0.5 区间');
  }
  // 可复现性
  const again = C.computeStratified(strataOver, cmOver);
  ok(again.bootF.f1.lo === rOver.bootF.f1.lo && again.bootF.f1.hi === rOver.bootF.f1.hi,
    '同一输入两次计算结果完全一致（种子固定）');
}

console.log('\n────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
else console.log('分层加权估计全部通过 ✓');
