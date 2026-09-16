/* 计算内核单元测试 —— 用独立的参考实现交叉验证 */
'use strict';
const Core = require('../src/core.js');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
}
function near(a, b, tol, name) {
  const t = tol === undefined ? 1e-9 : tol;
  const good = a !== null && b !== null && Math.abs(a - b) <= t;
  ok(good, name, 'got ' + a + ' expect ' + b);
}
function isNull(v, name) { ok(v === null, name, 'got ' + v); }

console.log('=== 1. Wilson 区间：与独立参考实现 / 已知值交叉验证 ===');
{
  // 参考实现（独立写一遍，避免同源错误）
  function wilsonRef(k, n, z = 1.959963984540054) {
    const p = k / n, z2 = z * z, d = 1 + z2 / n;
    const c = (p + z2 / (2 * n)) / d;
    const h = (z / d) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return [c - h, c + h];
  }
  const cases = [
    [0, 100], [1, 100], [50, 100], [8, 10], [80, 100], [9, 10],
    [0, 1], [1, 1], [359, 400], [3, 7], [0, 10], [10, 10],
  ];
  for (const [k, n] of cases) {
    const got = Core.wilson(k, n);
    const ref = wilsonRef(k, n);
    near(got.lo, ref[0], 1e-12, `Wilson lo k=${k} n=${n}`);
    near(got.hi, ref[1], 1e-12, `Wilson hi k=${k} n=${n}`);
    near(got.p, k / n, 1e-12, `Wilson p k=${k} n=${n}`);
  }
  // 教科书反例：n=100, k=0 → Wald 给 [0,0]，Wilson 必须给出单边宽度
  const z = Core.wilson(0, 100);
  near(z.lo, 0, 1e-12, 'Wilson n=100 k=0 下限为 0');
  ok(z.hi > 0.03 && z.hi < 0.045, 'Wilson n=100 k=0 上限约 3.7%', 'got ' + z.hi);
  // 区间必须包含点估计
  for (const [k, n] of cases) {
    const w = Core.wilson(k, n);
    ok(w.lo <= w.p + 1e-12 && w.p <= w.hi + 1e-12, `区间包含点估计 k=${k} n=${n}`);
    ok(w.lo >= 0 && w.hi <= 1, `区间在 [0,1] 内 k=${k} n=${n}`);
  }
  // 分母 0
  const none = Core.wilson(0, 0);
  isNull(none.p, 'Wilson n=0 → p 为 null');
  isNull(none.lo, 'Wilson n=0 → lo 为 null');
  isNull(none.hi, 'Wilson n=0 → hi 为 null');
  // 样本量越大区间越窄
  const a1 = Core.wilson(8, 10), a2 = Core.wilson(80, 100), a3 = Core.wilson(800, 1000);
  ok(a1.hi - a1.lo > a2.hi - a2.lo && a2.hi - a2.lo > a3.hi - a3.lo, '样本量增大区间单调收窄');
}

console.log('=== 2. Fβ 公式：两种算法（由 P,R 与由混淆矩阵）必须一致 ===');
{
  const cms = [
    { TP: 9, FP: 99, FN: 1, TN: 891 },
    { TP: 5, FP: 5, FN: 5, TN: 985 },
    { TP: 900, FP: 100, FN: 100, TN: 8900 },
    { TP: 1, FP: 1, FN: 1, TN: 1 },
  ];
  for (const cm of cms) {
    const m = Core.computeMetrics(cm);
    for (const b of [0.5, 1, 2]) {
      const viaPR = Core.fbetaFromPR(m.precision, m.recall, b);
      const viaCM = Core.fbetaFromCM(cm, b);
      near(viaPR, viaCM, 1e-12, `F${b} 两种算法一致 cm=${JSON.stringify(cm)}`);
    }
    near(m.f1, (2 * m.precision * m.recall) / (m.precision + m.recall), 1e-12, 'F1 = 2PR/(P+R)');
  }
  // β=1 退化为 F1
  const m = Core.computeMetrics({ TP: 9, FP: 99, FN: 1, TN: 891 });
  near(Core.fbetaFromPR(m.precision, m.recall, 1), m.f1, 1e-12, 'β=1 退化为 F1');
  // 文档中的示例：A 全通过 / B 9驳1错 / C 全驳回（N=1000, 实际正例 10）
  const A = Core.computeMetrics({ TP: 0, FP: 0, FN: 10, TN: 990 });
  isNull(A.precision, 'A 全通过 → P 不可计算（0/0，不得报 0）');
  near(A.recall, 0, 1e-12, 'A 全通过 → R=0');
  const B = Core.computeMetrics({ TP: 9, FP: 1, FN: 1, TN: 989 });
  near(B.precision, 0.9, 1e-12, 'B → P=90%');
  near(B.recall, 0.9, 1e-12, 'B → R=90%');
  near(B.f1, 0.9, 1e-12, 'B → F1=90%');
  const C = Core.computeMetrics({ TP: 10, FP: 990, FN: 0, TN: 0 });
  near(C.precision, 0.01, 1e-12, 'C 全驳回 → P=1%');
  near(C.recall, 1, 1e-12, 'C 全驳回 → R=100%');
  near(C.f1, 2 / 101, 1e-12, 'C 全驳回 → F1≈2%');
}

console.log('=== 3. β 权重关系：wR/wP = β²，F 的倒数按 β² 加权调和 ===');
{
  // 严格表述：1/Fβ = (wP·(1/P) + wR·(1/R)) / (wP + wR)，其中 wR/wP = β²
  // 即 —— Fβ 的「坏度」(1/F) 是 1/P 与 1/R 的加权算术平均，权重比正是 β²。
  for (const b of [0.5, 1, 2, 3]) {
    const P = 0.73, R = 0.41;
    const b2 = b * b;
    const wR = b2, wP = 1;
    const expect = (wP + wR) / (wP / P + wR / R);
    near(Core.fbetaFromPR(P, R, b), expect, 1e-12, `β=${b}：1/F = (1/P + β²/R)/(1+β²)`);
  }
  // 由上式反解权重比：wR/wP = (1/F − 1/P) / (1/R − 1/F) = β²
  for (const b of [0.5, 1, 2, 3]) {
    const P = 0.6, R = 0.9;
    const F = Core.fbetaFromPR(P, R, b);
    const ratio = (1 / F - 1 / P) / (1 / R - 1 / F);
    near(ratio, b * b, 1e-9, `β=${b}：由 F 反解出的权重比 = β²`);
  }
  // β=2 时 wR/wP = 4（文档强调的「4 倍，不是 2 倍」）
  {
    const P = 0.6, R = 0.9;
    const F2 = Core.fbetaFromPR(P, R, 2);
    const F1 = Core.fbetaFromPR(P, R, 1);
    const ratio = (1 / F2 - 1 / P) / (1 / R - 1 / F2);
    near(ratio, 4, 1e-9, 'β=2 → 召回权重是精确率的 4 倍');
    ok(F2 !== F1, 'β 改变确实改变取值');
  }
}

console.log('=== 4. 指标计算：结构与派生量 ===');
{
  const m = Core.computeMetrics({ TP: 90, FP: 10, FN: 10, TN: 890 });
  near(m.accuracy, 0.98, 1e-12, 'Accuracy');
  near(m.precision, 0.9, 1e-12, 'Precision');
  near(m.recall, 0.9, 1e-12, 'Recall');
  near(m.specificity, 890 / 900, 1e-12, 'Specificity');
  near(m.fpr, 1 - 890 / 900, 1e-12, 'FPR = 1 - Specificity');
  near(m.fnr, 0.1, 1e-12, 'FNR = 1 - Recall');
  near(m.piActual, 0.1, 1e-12, '实际应驳回率 π=(TP+FN)/N');
  near(m.tauQc, 0.1, 1e-12, '质检驳回率 τ=(TP+FP)/N');
  near(m.delta, 0, 1e-12, 'Δ = τ − π');
  // Δ 的方向性
  const aggr = Core.computeMetrics({ TP: 9, FP: 99, FN: 1, TN: 891 });
  const cons = Core.computeMetrics({ TP: 5, FP: 5, FN: 5, TN: 985 });
  ok(aggr.delta > 0, '激进型 Δ>0', 'got ' + aggr.delta);
  near(cons.delta, 0, 1e-12, '保守型（驳回量与标准一致）Δ=0');
  // NPV
  near(m.npv, 890 / 900, 1e-12, 'NPV = TN/(TN+FN)');
  // 空前例
  const noPos = Core.computeMetrics({ TP: 0, FP: 0, FN: 0, TN: 100 });
  isNull(noPos.recall, '无正例 → R 不可计算');
  isNull(noPos.precision, '无驳回 → P 不可计算');
  near(noPos.specificity, 1, 1e-12, '无正例 → 特异度=100%');
  near(noPos.accuracy, 1, 1e-12, '无正例 → 准确率=100%');
}

console.log('=== 5. P 被 π 稀释（文档核心论据）复核 ===');
{
  // 固定特异度 99%、召回率 90%，改变 π，观察 P
  const expect = [
    [0.01, 0.4762], [0.05, 0.8257], [0.20, 0.9574], [0.50, 0.9890],
  ];
  for (const [pi, want] of expect) {
    const N = 100000;
    const pos = Math.round(N * pi), neg = N - pos;
    const TP = Math.round(pos * 0.9), FN = pos - TP;
    const FP = Math.round(neg * 0.01), TN = neg - FP;
    const m = Core.computeMetrics({ TP, FP, FN, TN });
    near(m.precision, want, 5e-4, `π=${pi * 100}% → P≈${(want * 100).toFixed(1)}%`);
  }
}

console.log('=== 6. Bootstrap F 族区间 ===');
{
  const cm = { TP: 9, FP: 99, FN: 1, TN: 891 };
  const bs = Core.bootstrapF(cm, { B: 4000, seed: 42 });
  const m = Core.computeMetrics(cm);
  ok(bs.result.f1.lo <= m.f1 && m.f1 <= bs.result.f1.hi, 'F1 点估计落在 Bootstrap 区间内');
  ok(bs.result.f1.lo > 0, 'F1 区间下限 > 0');
  ok(bs.result.f1.hi < 1, 'F1 区间上限 < 1');
  ok(bs.result.f2.lo > bs.result.f1.lo, 'F2 区间下限高于 F1（本例 P 被结构压低）');
  // 可复现性
  const bs2 = Core.bootstrapF(cm, { B: 4000, seed: 42 });
  near(bs.result.f1.lo, bs2.result.f1.lo, 1e-15, '同种子结果完全可复现');
  near(bs.result.f1.hi, bs2.result.f1.hi, 1e-15, '同种子结果完全可复现(hi)');
  // 样本量增大 → 区间收窄
  const big = Core.bootstrapF({ TP: 900, FP: 9900, FN: 100, TN: 89100 }, { B: 2000, seed: 42 });
  const w1 = bs.result.f1.hi - bs.result.f1.lo;
  const w2 = big.result.f1.hi - big.result.f1.lo;
  ok(w2 < w1, '样本量增大后 F1 区间收窄', `${w2} vs ${w1}`);
  // 空矩阵
  const empty = Core.bootstrapF({ TP: 0, FP: 0, FN: 0, TN: 0 }, { B: 100 });
  ok(empty.n === 0, '全零矩阵 → n=0（不报错）');
}

console.log('=== 7. 警戒线策略：闭环回代验证 ===');
{
  // 例：验收准确率 95% → T=5%；B=10% → R_min=50%；应驳回 10 条 → 可容忍漏判 5 条
  const w = Core.computeWarningLine({
    historyPi: [0.10, 0.08, 0.06],
    historyRecall: [0.9, 0.85, 0.8],
    acceptAccuracy: 0.95,
    piCurrent: 0.09,
    actualPositiveCount: 10,
  });
  near(w.toleranceT, 0.05, 1e-12, 'T = 1 − 验收准确率');
  near(w.baselineB, 0.10, 1e-12, 'B = 前三次 π 的最大值');
  near(w.rMin, 0.5, 1e-12, 'R_min = 1 − T/B = 50%');
  ok(w.tolerableMissCount === 5, '可容忍漏判 = 10 × 50% = 5 条', 'got ' + w.tolerableMissCount);

  // 闭环回代：按 R_min 恰好执行，回代得到的准确率必须 ≥ 验收要求
  for (const pi of [0.02, 0.05, 0.10, 0.20, 0.50]) {
    for (const acc of [0.90, 0.95, 0.99]) {
      const T = 1 - acc;
      const B = pi;
      const rMin = 1 - T / B;
      if (rMin <= 0) continue;
      // 该质检员的判定：召回 rMin，特异度未知 → 准确率上界为「除漏判外全部正确」
      // 即 Accuracy ≤ 1 − π×(1−rMin)，且当特异度=1 时取等号
      const accBest = 1 - pi * (1 - rMin);
      ok(accBest >= acc - 1e-12,
        `回代闭环 π=${pi} 验收=${acc} → 最优准确率 ${accBest.toFixed(4)} ≥ ${acc}`);
    }
  }

  // R_min ≤ 0 的退化分支：B ≤ T（严格边界：B 恰好等于 T 也必须退化）
  const deg = Core.computeWarningLine({
    historyPi: [0.01, 0.01],
    historyRecall: [0.95, 0.88, 0.91],
    acceptAccuracy: 0.99, // T = 1%
    piCurrent: 0.01,
    actualPositiveCount: 100,
  });
  ok(deg.fallbackToWorstRecall, 'B=1% = T=1% → 触发退化分支（≤0）');
  near(deg.rMin, 0.88, 1e-12, '退化为历史最差召回率 0.88');
  ok(deg.tolerableMissCount === 12, '可容忍漏判 = 100 × 12% = 12 条', 'got ' + deg.tolerableMissCount);

  // B < T 时同样退化
  const deg2 = Core.computeWarningLine({
    historyPi: [0.005], historyRecall: [0.9, 0.75],
    acceptAccuracy: 0.99, piCurrent: 0.005, actualPositiveCount: 40,
  });
  ok(deg2.fallbackToWorstRecall, 'B=0.5% < T=1% → 退化');
  near(deg2.rMin, 0.75, 1e-12, '取历史最差 0.75');

  // 历史不足三次
  const few = Core.computeWarningLine({
    historyPi: [0.04], historyRecall: [0.8],
    acceptAccuracy: 0.95, piCurrent: 0.03, actualPositiveCount: 50,
  });
  near(few.baselineB, 0.04, 1e-12, '不足三次 → 取全部（1 次）');
  ok(few.fallbackToWorstRecall, 'R_min 原始值 1 − 5%/4% = −25% 为负 → 退化');
  near(few.rMinRaw, -0.25, 1e-12, '原始（未退化）的 R_min = −25% 被如实记录');
  near(few.rMin, 0.8, 1e-12, '退化后取历史最差召回率 0.8');
  ok(/退化为历史最差召回率/.test(few.note), '退化原因写入说明');
  ok(few.historyUsed === 1, '记录使用次数=1');

  // 无历史
  const none = Core.computeWarningLine({
    historyPi: [], historyRecall: [],
    acceptAccuracy: 0.95, piCurrent: 0.12, actualPositiveCount: 20,
  });
  near(none.baselineB, 0.12, 1e-12, '无历史 → 用本次 π 作基线');
  ok(/无历史数据/.test(none.baselineBasis), '标注了数据来源');

  // 驳回率 0
  const zero = Core.computeWarningLine({
    historyPi: [0], historyRecall: [], acceptAccuracy: 0.95, piCurrent: 0, actualPositiveCount: 0,
  });
  isNull(zero.rMin, '实际驳回率为 0 → 不下结论');

  // max(1, ...) 下限
  const tiny = Core.computeWarningLine({
    historyPi: [0.5, 0.5, 0.5], historyRecall: [0.9],
    acceptAccuracy: 0.99, // T=1% → R_min=1-0.02=0.98
    piCurrent: 0.5, actualPositiveCount: 10,
  });
  near(tiny.rMin, 0.98, 1e-12, 'R_min=98%');
  ok(tiny.tolerableMissCount === 1, '10×2%=0.2 → 取 max(1,…)=1 条', 'got ' + tiny.tolerableMissCount);
}

console.log('=== 8. 观察线：中位数与窗口 ===');
{
  const mk = (r) => ({ metrics: { recall: r, precision: r, f1: r } });
  const hist = [mk(0.9), mk(0.8), mk(0.7), mk(0.6), mk(0.5)];
  const l3 = Core.computeObservationLines(hist, 3);
  near(l3.recall.value, 0.8, 1e-12, 'k=3 → 前三次中位数 0.8');
  ok(l3.recall.used === 3, 'k=3 用了 3 个值');
  ok(l3.recall.sufficient === true, 'k=3 标记为充分');
  const l2 = Core.computeObservationLines(hist, 2);
  near(l2.recall.value, 0.85, 1e-12, 'k=2 → 中位数 0.85');
  const l5 = Core.computeObservationLines(hist, 5);
  near(l5.recall.value, 0.7, 1e-12, 'k=5 → 中位数 0.7');
  const lAll = Core.computeObservationLines(hist, 3);
  ok(lAll.recall.window === 3, '窗口值被记录');
  // 不足 k 次
  const short = Core.computeObservationLines([mk(0.9)], 3);
  near(short.recall.value, 0.9, 1e-12, '不足 k 次 → 用上一（唯一）次值');
  ok(short.recall.sufficient === false, '标记为不充分');
  // 无历史
  const none = Core.computeObservationLines([], 3);
  isNull(none.recall.value, '无历史 → 观察线为 null');
  // 偶数个值的中位数
  const even = Core.computeObservationLines([mk(1.0), mk(0.8)], 2);
  near(even.recall.value, 0.9, 1e-12, '偶数个值 → 取中间两数均值');
}

console.log('=== 9. 连续低于观察线 ===');
{
  const mk = (r) => ({ metrics: { recall: r } });
  // 最新在前
  const s1 = [mk(0.7), mk(0.75), mk(0.95)];
  const b1 = Core.consecutiveBreach(s1, 'recall', 0.8, 'up', 0);
  ok(b1.breach === true && b1.count === 2, '连续两次低于 → 触发提示', JSON.stringify(b1));
  const s2 = [mk(0.7), mk(0.95), mk(0.7)];
  const b2 = Core.consecutiveBreach(s2, 'recall', 0.8, 'up', 0);
  ok(b2.breach === false && b2.count === 1, '中断一次 → 不触发');
  const s3 = [mk(0.9), mk(0.7), mk(0.7)];
  const b3 = Core.consecutiveBreach(s3, 'recall', 0.8, 'up', 0);
  ok(b3.breach === false, '最新一次正常 → 不触发');
  // 方向 down：越大越坏
  const d = [mk(0.3), mk(0.25)];
  const b4 = Core.consecutiveBreach(d, 'recall', 0.2, 'down', 0);
  ok(b4.breach === true && b4.count === 2, 'down 方向：连续高于 → 触发');
  const b5 = Core.consecutiveBreach(d, 'recall', null, 'down', 0);
  ok(b5.breach === false && b5.reason === '无观察线', '无观察线 → 不触发');
}

console.log('=== 10. 三态判定（信号 vs 噪声）===');
{
  // up 方向：区间下限 ≥ 线 → 通过
  const passV = Core.verdict(0.9, { lo: 0.85, hi: 0.95 }, 0.8, 'up');
  ok(passV.state === 'pass' && passV.pass === true, 'up：区间下限高于线 → 通过');
  const failV = Core.verdict(0.5, { lo: 0.4, hi: 0.6 }, 0.8, 'up');
  ok(failV.state === 'fail' && failV.pass === false, 'up：区间上限低于线 → 确证不达标');
  const unclearV = Core.verdict(0.78, { lo: 0.6, hi: 0.9 }, 0.8, 'up');
  ok(unclearV.state === 'unclear' && unclearV.pass === null, 'up：区间跨越线 → 不确定（不作结论）');
  // down 方向
  const dPass = Core.verdict(0.03, { lo: 0.01, hi: 0.05 }, 0.08, 'down');
  ok(dPass.state === 'pass', 'down：区间上限低于线 → 通过');
  const dFail = Core.verdict(0.2, { lo: 0.15, hi: 0.26 }, 0.08, 'down');
  ok(dFail.state === 'fail', 'down：区间下限高于线 → 确证不达标');
  const dUnclear = Core.verdict(0.07, { lo: 0.02, hi: 0.12 }, 0.08, 'down');
  ok(dUnclear.state === 'unclear', 'down：区间跨越线 → 不确定');
  // 无区间退化
  const noCi = Core.verdict(0.9, null, 0.8, 'up');
  ok(noCi.state === 'point-ok', '无区间 → 退化为点估计比较并标注');
  // 不可计算
  const na = Core.verdict(null, null, 0.8, 'up');
  ok(na.state === 'na', '点估计为 null → 不可计算');
  // 未设线
  const nl = Core.verdict(0.9, { lo: 0.85, hi: 0.95 }, null, 'up');
  ok(nl.state === 'no-line', '未设线');
}

console.log('=== 11. 分层抽样有效样本量 ===');
{
  const r = Core.effectiveSampleSize([
    { name: '驳回层', pop: 1000, sample: 400 },
    { name: '通过层', pop: 99000, sample: 600 },
  ]);
  // w1 = 1000/400 = 2.5, w2 = 99000/600 = 165
  // Σw = 2.5*400 + 165*600 = 1000 + 99000 = 100000
  // Σw² = 6.25*400 + 27225*600 = 2500 + 16335000 = 16337500
  // n_eff = 1e10 / 16337500 = 612.086...
  near(r.nEffClassic, 1e10 / 16337500, 1e-6, 'n_eff(经典) = (Σw)²/Σw²');
  ok(r.nEffClassic < r.nRaw, '过采样时 n_eff < 原始样本数', `${r.nEffClassic} vs ${r.nRaw}`);
  ok(r.nEffFpc > r.nEffClassic, '有限总体校正后有效样本量上升');
  ok(r.designEffect > 1 && r.designEffect < 2, '设计效应略大于 1', 'got ' + r.designEffect);
  ok(r.anyOversampled === false, '抽样比 0.4 / 0.006 均未超过 50% → 不算过采样');
  ok(r.strata.length === 2, '层明细数正确');

  // 整层全取：有限总体校正应使方差趋近 0（该层不再引入不确定性）
  const full = Core.effectiveSampleSize([
    { name: '驳回层', pop: 100, sample: 100 },
    { name: '通过层', pop: 10000, sample: 200 },
  ]);
  ok(full.fullyEnumerated === true, '标记整层全取');
  near(full.strata[0].fpc, 1, 1e-12, '整层全取的抽样比 = 1');
  ok(full.strata[0].oversampled === true, '整层全取属过采样');

  // 等概率（自加权）抽样 → 设计与简单随机等价
  const srs = Core.effectiveSampleSize([
    { name: 'A', pop: 99000, sample: 990 },
    { name: 'B', pop: 1000, sample: 10 },
  ]);
  near(srs.nEffClassic, srs.nRaw, 1e-9, '自加权抽样 → n_eff = n_raw');
  near(srs.designEffect, 1, 1e-9, '自加权抽样 → 设计效应 = 1');
  // 空输入
  isNull(Core.effectiveSampleSize([]), '空分层 → null');
}

console.log('=== 12. 数值工具 ===');
{
  near(Core.median([1, 2, 3, 4]), 2.5, 1e-12, 'median 偶数');
  near(Core.median([3, 1, 2]), 2, 1e-12, 'median 奇数');
  isNull(Core.median([]), 'median 空 → null');
  isNull(Core.median([null, undefined]), 'median 全非数 → null');
  near(Core.quantile([1, 2, 3, 4], 0.5), 2.5, 1e-12, 'quantile 0.5');
  near(Core.quantile([1, 2, 3, 4], 0.25), 1.75, 1e-12, 'quantile 0.25');
  const ap = Core.apportion([0.9, 0.1], 1000);
  ok(ap[0] + ap[1] === 1000, 'apportion 总数守恒', JSON.stringify(ap));
  near(ap[0], 900, 1e-9, 'apportion 9:1 分成 900/100');
  // 随机数可复现
  const r1 = Core.mulberry32(7), r2 = Core.mulberry32(7);
  ok(r1() === r2(), '同种子随机数一致');
}

console.log('\n────────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
