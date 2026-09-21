/* =============================================================================
 * 集成测试：compute → diagnostics → AI payload 全链路
 * 用 vm 在 Node 中加载浏览器脚本（它们挂在 globalThis 上），验证数值与文案。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

// 浏览器脚本挂载到 globalThis，Node 下直接 eval 即可
const Core = require(path.join(root, 'src/core.js'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'src/diagnostics.js'), 'utf8'), { filename: 'diagnostics.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'src/ai.js'), 'utf8'), { filename: 'ai.js' });

const D = globalThis.QCDiag;
const AI = globalThis.QCAI;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) pass++; else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
}
function has(str, sub, name) {
  const s = String(str || '');
  ok(s.indexOf(sub) >= 0, name, '未包含「' + sub + '」；实际：' + s.slice(0, 160));
}

/* 复刻 app.js 的 compute 链路（保持与界面一致） */
function computeChain(opts) {
  const settings = Object.assign({ bootstrapB: 4000, alpha: 0.05, obsWindow: 3, tolerancePct: 0 }, opts.settings || {});
  const input = opts.input;
  const cm = input.cm;

  const metrics0 = Core.computeMetrics(cm);
  const effSS = input.strata && input.strata.length ? Core.effectiveSampleSize(input.strata) : null;

  // 与 app.js 的 compute 保持一致：非等概率分层时改用加权口径
  const stratified = input.strata && input.strata.length
    ? Core.computeStratified(input.strata, cm,
      { alpha: settings.alpha, B: settings.bootstrapB, seed: 20240617 })
    : null;
  const useWeighted = Core.shouldUseWeighted(stratified);
  const metrics = useWeighted ? Core.mergeWeightedMetrics(metrics0, stratified) : metrics0;
  const bootstrap = useWeighted
    ? { n: stratified.popTotal, B: settings.bootstrapB, alpha: settings.alpha,
      seed: 20240617, stratified: true, result: stratified.bootF }
    : Core.bootstrapF(cm, { B: settings.bootstrapB, alpha: settings.alpha, seed: 20240617 });

  const history = opts.history || [];
  const historyPi = history.map((r) => r.metrics && r.metrics.piActual).filter(Number.isFinite);
  const historyRecall = history.map((r) => r.metrics && r.metrics.recall).filter(Number.isFinite);

  const acceptAcc = input.acceptAccuracy !== null && input.acceptAccuracy !== undefined ? input.acceptAccuracy : 0.95;
  const warning = Core.computeWarningLine({
    historyPi, historyRecall, acceptAccuracy: acceptAcc,
    piCurrent: metrics.piActual, actualPositiveCount: cm.TP + cm.FN,
  });
  const obsWindow = input.obsWindow || settings.obsWindow;
  const observation = Core.computeObservationLines(history, obsWindow);
  const recallVerdict = Core.verdict(metrics.recall, metrics.ci.recall, warning.rMin, 'up');

  const verdicts = {};
  const ROWS_KEYS = ['accuracy', 'precision', 'recall', 'specificity', 'npv', 'f05', 'f1', 'f2', 'fpr', 'fnr'];
  const DIRS = { fpr: 'down', fnr: 'down' };
  ROWS_KEYS.forEach((k) => {
    const line = observation[k] ? observation[k].value : null;
    verdicts[k] = { obsLine: line, obsUsed: observation[k] ? observation[k].used : 0 };
    if (line !== null) {
      const series = [{ metrics }].concat(history);
      verdicts[k].obsBreach = Core.consecutiveBreach(series, k, line, DIRS[k] || 'up', settings.tolerancePct);
    }
  });

  let consecutive = null;
  const priority = ['recall', 'precision', 'f1', 'specificity', 'accuracy'];
  for (const k of priority) {
    if (verdicts[k] && verdicts[k].obsBreach && verdicts[k].obsBreach.breach) {
      consecutive = {
        key: k, label: { recall: '召回率', precision: '精确率', f1: 'F1', specificity: '特异度', accuracy: '准确率' }[k],
        breach: true, count: verdicts[k].obsBreach.count,
        line: verdicts[k].obsBreach.line, window: verdicts[k].obsUsed,
        sufficient: observation[k].sufficient,
      };
      break;
    }
  }

  const ctx = {
    metrics, warning, observation, input, projectName: opts.projectName || '测试项目',
    history, settings, bootstrap, effSS, stratified, useWeighted, consecutive,
  };
  const diagnostics = D.run(ctx);
  ctx.diagnostics = diagnostics;
  return { metrics, bootstrap, effSS, stratified, useWeighted, warning, observation,
    verdicts, recallVerdict, diagnostics, ctx, input, acceptAccuracy: acceptAcc, obsWindow };
}

function mkHistory(items) {
  return items.map(([pi, r, P, f1], i) => ({
    periodLabel: 'H' + (i + 1),
    metrics: { piActual: pi, recall: r, precision: P, f1: f1, accuracy: 0.97, tauQc: pi, specificity: 0.99 },
    counts: { TP: 0, FP: 0, FN: 0, TN: 0 },
  }));
}

console.log('=== 1. 正常数据（低驳回率 8%）全链路 ===');
{
  const r = computeChain({
    input: {
      periodLabel: 'W07', inspector: '张三', populationTotal: 100000, sampleTotal: 1000,
      cm: { TP: 72, FP: 26, FN: 8, TN: 894 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  ok(r.metrics.counts.N === 1000, '混淆矩阵合计 = 1000');
  ok(Math.abs(r.metrics.piActual - 0.08) < 1e-12, 'π = 8%', String(r.metrics.piActual));
  ok(Math.abs(r.metrics.recall - 0.9) < 1e-12, 'R = 90%');
  // 实际应驳回数 = TP+FN = 80；R_min = 1 − 5%/8% = 37.5%；可容忍漏判 = 80 × 62.5% = 50 条
  ok(Math.abs(r.warning.rMin - 0.375) < 1e-12, 'R_min = 37.5%', String(r.warning.rMin));
  ok(r.warning.tolerableMissCount === 50, '可容忍漏判 = 80×62.5% = 50 条', String(r.warning.tolerableMissCount));
  ok(r.warning.tolerableMissCount >= r.metrics.counts.FN, '本次漏判 8 条在容忍范围内');
  ok(r.warning.rMin !== null, 'R_min 已计算');
  ok(r.diagnostics.length > 0, '至少产出一条诊断');
  ok(r.recallVerdict.state === 'pass' || r.recallVerdict.state === 'unclear', '召回率判定已生成：' + r.recallVerdict.state);

  // 诊断应包含「准确率被稀释」与「样本量」相关提示
  const titles = r.diagnostics.map((d) => d.title).join(' | ');
  has(titles, '准确率', '诊断指出准确率在低 π 下失效');
  has(titles, '召回率', '诊断包含召回率相关条目');
}

console.log('=== 2. 回归：P 被 π 稀释的场景必须给出结构层警告 ===');
{
  const r = computeChain({
    input: { periodLabel: 'W01', cm: { TP: 9, FP: 10, FN: 1, TN: 980 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  });
  const acc = r.diagnostics.find((d) => /准确率/.test(d.title));
  ok(!!acc, '触发了准确率相关诊断');
  has(acc.detail, 'π=', '诊断中给出 π 作为依据');
  ok(Math.abs(r.metrics.piActual - 0.01) < 1e-12, 'π = 1%');
  // 精确率应被显著稀释
  ok(r.metrics.precision < 0.5, '精确率被 π 稀释到 50% 以下：' + r.metrics.precision.toFixed(3));
}

console.log('=== 3. 样本量不足必须触发 alert（结构性缺陷）===');
{
  const r = computeChain({
    input: { periodLabel: 'W02', cm: { TP: 8, FP: 4, FN: 2, TN: 986 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  });
  const posCard = r.diagnostics.find((d) => /实际应驳回样本仅/.test(d.title));
  ok(!!posCard, '触发「实际应驳回样本不足」诊断');
  ok(posCard.level === 'alert', '级别为 alert', posCard.level);
  has(posCard.detail, '区间', '说明中给出置信区间');
}

console.log('=== 4. 零分母不得报 0 ===');
{
  const r = computeChain({
    input: { periodLabel: 'W03', cm: { TP: 0, FP: 0, FN: 5, TN: 995 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  });
  ok(r.metrics.precision === null, '全通过 → 精确率为 null（不报 0）');
  ok(r.metrics.f1 === null, '全通过 → F1 为 null');
  const t = r.diagnostics.map((d) => d.title).join(' | ');
  has(t, '零值单元', '提示混淆矩阵零值单元');
}

console.log('=== 5. 消极判定信号必须被识别 ===');
{
  // τ 远低于 π，但 P 很高
  const r = computeChain({
    input: { periodLabel: 'W04', cm: { TP: 4, FP: 1, FN: 36, TN: 959 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  });
  // π = 40/1000 = 4%, τ = 5/1000 = 0.5% → τ < π/2
  ok(r.metrics.tauQc < r.metrics.piActual / 2, 'τ 不足 π 的一半');
  ok(r.metrics.precision >= 0.7, 'P 很高：' + r.metrics.precision);
  const card = r.diagnostics.find((d) => /消极判定/.test(d.title));
  ok(!!card, '触发「消极判定信号」诊断');
  if (card) {
    ok(card.level === 'alert', '级别 alert', card.level);
    has(card.actions.join(' '), '行为问题', '明确指出属行为问题而非能力问题');
  }
}

console.log('=== 6. 过度驳回（特异度低）必须被识别 ===');
{
  const r = computeChain({
    input: { periodLabel: 'W05', cm: { TP: 90, FP: 200, FN: 10, TN: 700 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  });
  ok(r.metrics.specificity < 0.9, '特异度 < 90%：' + r.metrics.specificity.toFixed(3));
  const card = r.diagnostics.find((d) => /特异度偏低/.test(d.title));
  ok(!!card, '触发特异度诊断');
  has(card.detail, '不能用精确率代替', '说明为何不能用 P 代替');
}

console.log('=== 7. 结构变动检测 ===');
{
  const r = computeChain({
    input: { periodLabel: 'W06', cm: { TP: 100, FP: 50, FN: 100, TN: 750 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
    history: mkHistory([[0.01, 0.9, 0.4, 0.55], [0.012, 0.88, 0.42, 0.56], [0.011, 0.86, 0.41, 0.55]]),
  });
  // π = 20% vs 历史最高 1.2% → 比值 16.7
  const card = r.diagnostics.find((d) => /结构性变动/.test(d.title));
  ok(!!card, '触发结构变动诊断');
  if (card) ok(card.level === 'alert', '结构变动为 alert', card.level);
}

console.log('=== 8. 连续两次低于观察线 ===');
{
  // 观察线 = median([0.80, 0.88, 0.86]) = 0.86；本次 R = 50/60 = 0.8333 与上期 0.80 均低于线
  const hist = mkHistory([
    [0.08, 0.80, 0.7, 0.75],
    [0.08, 0.88, 0.7, 0.79],
    [0.08, 0.86, 0.7, 0.78],
  ]);
  const r = computeChain({
    input: { periodLabel: 'W08', cm: { TP: 50, FP: 20, FN: 10, TN: 920 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
    history: hist,
  });
  const line = r.observation.recall.value;
  ok(Math.abs(line - 0.86) < 1e-12, '观察线 = 0.86', String(line));
  ok(r.metrics.recall < line, '本次 \(' + r.metrics.recall.toFixed(4) + '\) 低于观察线');
  ok(r.verdicts.recall.obsBreach.count === 2, '连续低于次数 = 2', String(r.verdicts.recall.obsBreach.count));
  const card = r.diagnostics.find((d) => /纳入观察/.test(d.title));
  ok(!!card, '触发「连续低于观察线」提示');
  if (card) has(card.title, '召回率', '提示中指出是哪个指标');
}

console.log('=== 9. 分层抽样 ===');
{
  const r = computeChain({
    input: {
      periodLabel: 'W09', cm: { TP: 36, FP: 30, FN: 4, TN: 930 },
      strata: [{ name: '驳回层', pop: 1000, sample: 400 }, { name: '通过层', pop: 99000, sample: 600 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  ok(r.effSS !== null, '有效样本量已计算');
  ok(r.effSS.nEffClassic < r.effSS.nRaw, 'n_eff < n_raw');
  ok(r.metrics.counts.TP + r.metrics.counts.FP + r.metrics.counts.FN + r.metrics.counts.TN === 1000, '矩阵合计正确');
}

console.log('=== 9b. 非等概率分层：主口径必须切换为加权估计 ===');
{
  // 驳回层抽 10%（1000 条）、通过层抽 1%（900 条）
  // 总体真值：R=88.89%、Spec=97.80%、π=9.00%
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-1', cm: { TP: 800, FP: 200, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  ok(r.stratified !== null && r.stratified !== undefined, '返回分层加权结果 stratified');
  ok(r.useWeighted === true, '非等抽样比时启用加权口径');
  ok(Math.abs(r.metrics.recall - 8000 / 9000) < 1e-6,
    '主口径召回率 = 加权真值 88.89%', String(r.metrics.recall));
  ok(Math.abs(r.metrics.piActual - 0.09) < 1e-6,
    '主口径 π = 加权真值 9.00%', String(r.metrics.piActual));
  ok(Math.abs(r.metrics.specificity - 89000 / 91000) < 1e-6,
    '主口径特异度 = 加权真值 97.80%', String(r.metrics.specificity));
  ok(r.metrics.sampleMetrics && Math.abs(r.metrics.sampleMetrics.recall - 800 / 810) < 1e-9,
    '同时保留样本内口径供对照', r.metrics.sampleMetrics ? String(r.metrics.sampleMetrics.recall) : '(缺失)');
  // 警戒线必须用加权 π，否则基线 B 会被严重高估
  ok(Math.abs(r.warning.baselineB - 0.09) < 1e-6,
    '警戒线基线 B 采用加权 π（而非样本内 42.6%）', String(r.warning.baselineB));
  // 区间必须展宽
  ok(r.metrics.ci.recall.hi - r.metrics.ci.recall.lo > 0.05,
    '召回率区间因设计效应显著展宽',
    '宽度 ' + (r.metrics.ci.recall.hi - r.metrics.ci.recall.lo).toFixed(4));
  ok(r.metrics.ci.recall.lo < 8000 / 9000 && r.metrics.ci.recall.hi > 8000 / 9000,
    '召回率区间覆盖真值');
  // 诊断卡必须明确警示两种口径的差异
  const titles = r.diagnostics.map((d) => d.title).join(' | ');
  ok(/加权|分层|口径/.test(titles), '诊断卡提示了加权口径', titles);
  const card = r.diagnostics.find((d) => /加权/.test(d.title) || /口径/.test(d.title));
  ok(!!card, '存在加权口径说明卡');
  if (card) {
    ok(card.level === 'warn' || card.level === 'alert',
      '口径差异达数十个百分点时应为警告级', card.level);
    has(card.detail, '样本内', '说明卡指出样本内口径有偏');
  }
}

console.log('=== 9c. 等概率分层：不应切换口径（自加权） ===');
{
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-2', cm: { TP: 80, FP: 20, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 100 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  ok(r.useWeighted === false, '等抽样比时不切换口径（结果本就相同）');
  ok(Math.abs(r.metrics.recall - 80 / 90) < 1e-9, '召回率与样本内一致', String(r.metrics.recall));
  const card = r.diagnostics.find((d) => /加权/.test(d.title) || /口径/.test(d.title));
  ok(!card, '自加权时不产生口径差异警示（避免噪声）', card ? card.title : '');
}

console.log('=== 9d. 分层信息与混淆矩阵不一致：必须报错而非默默加权 ===');
{
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-3', cm: { TP: 800, FP: 200, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 999 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  ok(r.useWeighted === false, '不一致时不启用加权（避免用错误权重算出错误结论）');
  const card = r.diagnostics.find((d) => /不一致|不符|对不上/.test(d.title + d.detail));
  ok(!!card, '存在不一致的诊断卡', r.diagnostics.map((d) => d.title).join(' | '));
  if (card) ok(card.level === 'alert', '不一致应为最高级别告警', card.level);
}

console.log('=== 9e. AI 提示词必须包含加权口径与设计效应 ===');
{
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-4', cm: { TP: 800, FP: 200, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
  });
  const p = AI.buildUserPayload(r.ctx);
  has(p, '非等概率分层', '提示词声明为非等概率分层');
  has(p, '加权', '提示词含加权口径说明');
  has(p, '设计效应', '提示词含设计效应');
  has(p, '样本内口径', '提示词同时给出样本内口径以便模型识别差异');
  ok(/加权后总体估计[^\n]*88\.8|88\.89/.test(p) || p.indexOf('88.89') >= 0,
    '提示词含加权后的召回率数值', p.slice(0, 200));
}

console.log('=== 9f. 历史混用两种口径：观察线不可比，必须告警 ===');
{
  // 历史前两期是样本内口径，本期切换为加权口径 → 中位数会混用两种尺度
  const hist = [
    { periodLabel: 'H1', metrics: { piActual: 0.42, recall: 0.98, precision: 0.8, f1: 0.88, accuracy: 0.89, tauQc: 0.52, specificity: 0.81 }, counts: { TP: 800, FP: 200, FN: 10, TN: 890 }, weighting: { mode: 'sample' } },
    { periodLabel: 'H2', metrics: { piActual: 0.43, recall: 0.98, precision: 0.79, f1: 0.87, accuracy: 0.88, tauQc: 0.53, specificity: 0.80 }, counts: { TP: 790, FP: 210, FN: 11, TN: 889 }, weighting: { mode: 'sample' } },
  ];
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-5', cm: { TP: 800, FP: 200, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
    history: hist,
  });
  ok(r.useWeighted === true, '本期启用加权');
  const card = r.diagnostics.find((d) => /口径不一致|不可比|混用/.test(d.title + d.detail));
  ok(!!card, '存在历史口径混用的告警卡', r.diagnostics.map((d) => d.title).join(' | '));
  if (card) ok(card.level === 'alert' || card.level === 'warn', '混用口径应至少为警告级', card.level);
}

console.log('=== 9g. 历史口径一致时不产生噪声告警 ===');
{
  const hist = [
    { periodLabel: 'H1', metrics: { piActual: 0.09, recall: 0.89, precision: 0.8, f1: 0.84, accuracy: 0.97, tauQc: 0.10, specificity: 0.978 }, counts: { TP: 800, FP: 200, FN: 10, TN: 890 }, weighting: { mode: 'weighted' } },
    { periodLabel: 'H2', metrics: { piActual: 0.09, recall: 0.88, precision: 0.79, f1: 0.83, accuracy: 0.97, tauQc: 0.10, specificity: 0.977 }, counts: { TP: 790, FP: 210, FN: 11, TN: 889 }, weighting: { mode: 'weighted' } },
  ];
  const r = computeChain({
    input: {
      periodLabel: 'STRAT-6', cm: { TP: 800, FP: 200, FN: 10, TN: 890 },
      strata: [{ name: '驳回层', pop: 10000, sample: 1000 }, { name: '通过层', pop: 90000, sample: 900 }],
      acceptAccuracy: 0.95, obsWindow: 3,
    },
    history: hist,
  });
  const card = r.diagnostics.find((d) => /口径不一致|不可比|混用/.test(d.title + d.detail));
  ok(!card, '口径一致时不告警', card ? card.title : '');
}

console.log('=== 10. 首次评估（无历史）===');
{
  const r = computeChain({
    input: { periodLabel: 'W10', cm: { TP: 72, FP: 26, FN: 8, TN: 894 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
    history: [],
  });
  const card = r.diagnostics.find((d) => /首次评估/.test(d.title));
  ok(!!card, '提示首次评估观察线不可用');
  ok(r.warning.baselineB !== null, '无历史时基线取本次 π');
  has(r.warning.baselineBasis, '无历史数据', '基线来源说明正确');
  ok(r.observation.recall.value === null, '观察线为 null');
}

console.log('=== 11. AI 提示词：纪律与事实完整性 ===');
{
  const hist = mkHistory([[0.08, 0.9, 0.4, 0.55]]);
  const r = computeChain({
    input: { periodLabel: 'W11', inspector: '李四', populationTotal: 100000, sampleTotal: 1000,
      cm: { TP: 72, FP: 26, FN: 8, TN: 894 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
    history: hist,
  });
  const p = AI.buildUserPayload(r.ctx);

  // 事实必须齐全
  ['一、项目与本次评估', '二、混淆矩阵', '四、指标与置信区间', '五、结构量', '六、警戒线推导',
    '七、观察线与连续判定', '八、工具预判诊断', '九、历史记录', '十、本次任务'].forEach((s) => {
    has(p, s, '提示词包含章节：' + s);
  });
  has(p, 'TP 正确驳回 = 72', 'TP 数值正确传入');
  has(p, 'FP 误驳回 = 26', 'FP 数值正确传入');
  has(p, 'FN 错误通过（漏判）= 8', 'FN 数值正确传入');
  has(p, 'TN 正确通过 = 894', 'TN 数值正确传入');
  has(p, '实际应驳回率 π = (TP+FN)/N = 8.00%', 'π 正确传入并附公式');
  has(p, '质检驳回率 τ = (TP+FP)/N = 9.80%', 'τ 正确传入');
  has(p, '净偏离 Δ = τ − π = +1.80%', 'Δ 与方向说明正确传入');
  has(p, '禁止重算', '提示词声明禁止重算');

  // 系统提示词纪律
  const sp = AI.SYSTEM_PROMPT;
  has(sp, '禁止对质检人员作出能力评价', '系统提示词禁止评价个人');
  has(sp, '禁止设定通用及格线', '系统提示词禁止编及格线');
  has(sp, 'β²', '系统提示词写明 β² 权重关系');
  has(sp, '特异度', '系统提示词区分特异度与精确率');
  has(sp, '区间跨越警戒线', '系统提示词要求区间三态判断');
  has(sp, '"actions"', '系统提示词指定 JSON 结构');
  has(sp, 'needsHuman', '要求输出需人工确认项');
  has(sp, '不得输出 JSON 以外的任何内容', '限定输出格式');

  // 结构化契约：所有必需键都在提示词中声明
  ['summary', 'reliability', 'rootCause', 'structure', 'behavior', 'capability',
    'standardSuggestion', 'trainingSuggestion', 'followUp'].forEach((k) => {
    has(sp, '"' + k + '"', 'JSON 契约包含键：' + k);
  });
}

console.log('=== 12. AI 返回解析容错 ===');
{
  const good = AI.extractJSON('{"summary":"ok","actions":[]}');
  ok(good.summary === 'ok', '解析纯 JSON');

  const fenced = AI.extractJSON('```json\n{"summary":"ok"}\n```');
  ok(fenced.summary === 'ok', '剥离 Markdown 代码围栏');

  const noisy = AI.extractJSON('好的，以下是分析结果：\n{"summary":"ok"}\n希望有帮助。');
  ok(noisy.summary === 'ok', '从噪声文本中截取 JSON');

  let threw = false;
  try { AI.extractJSON('完全没有 JSON'); } catch (e) { threw = true; ok(/无法修复|无法解析|不是合法/.test(e.message), '错误信息可读'); }
  ok(threw, '无 JSON 时抛出可读错误');

  threw = false;
  try { AI.extractJSON(''); } catch (e) { threw = true; ok(/预算|空/.test(e.message), '空返回的错误提示指向预算问题', e.message); }
  ok(threw, '空返回时抛出错误');
}

console.log('=== 12b. 回归：输出被截断时的 JSON 修复（deepseek-flash 为推理模型）===');
{
  // 背景：该模型思维链与正文共用 max_tokens，预算不足会导致输出被截断。
  // 曾因此报「JSON 无法解析」，此处固化为回归测试，确保不再直接失败。
  const cases = [
    ['截断在字符串中间', '{"summary":"这是一段没有结尾的话', '这是一段没有结尾的话'],
    ['截断在数组元素之间', '{"summary":"s","actions":[{"priority":"P0","action":"a1"},{"priority":"P1","act', 's'],
    ['截断在对象中间', '{"summary":"s","actions":[{"priority":"P0"', 's'],
    ['数组被截断', '{"summary":"s","needsHuman":["第一项","第二', 's'],
  ];
  for (const [name, input, expect] of cases) {
    let r = null, err = null;
    try { r = AI.parseModelJSON(input); } catch (e) { err = e.message; }
    ok(r !== null, name + ' 应能修复后解析', err || '');
    if (r) {
      ok(r.repaired === true, name + ' 标记为已修复');
      ok(r.data.summary === expect, name + ' 抢救出 summary', String(r.data.summary));
    }
  }

  // 尾随逗号与缺逗号
  ok(AI.parseModelJSON('{"summary":"s","followUp":["a","b",],}').data.summary === 's', '修复尾随逗号');
  ok(AI.parseModelJSON('{"summary":"s" "reliability":"r"}').data.summary === 's', '修复缺失逗号');

  // rootCause 展平字段应被重组为对象（契约一致）
  const flat = AI.parseModelJSON('{"summary":"s","structure":"a","behavior":"b","capability":"c"');
  ok(flat.data.rootCause && flat.data.rootCause.structure === 'a', '展平的 structure/behavior/capability 重组为 rootCause');
  ok(flat.data.structure === undefined, '重组后不残留展平键');

  // 完全无结构时才失败
  let threw = false;
  try { AI.parseModelJSON('这里没有任何 JSON'); } catch (e) { threw = true; }
  ok(threw, '完全无 JSON 结构时仍抛出错误');

  // 合法 JSON 不应被标记为修复
  const clean = AI.parseModelJSON('{"summary":"ok"}');
  ok(clean.repaired === false, '合法 JSON 不触发修复路径');
}

console.log('=== 12c. 输出预算：推理模型必须给足 max_tokens ===');
{
  // 该模型 reasoning_tokens 与正文共用预算，实测同一输入思维链可达 4000~8700 token。
  // 预算默认值若过小，会出现「思维链吃光预算 → 正文为空 → JSON 解析失败」。
  ok(AI.DEFAULT_MAX_TOKENS >= 12000, '默认 max_tokens ≥ 12000', String(AI.DEFAULT_MAX_TOKENS));
  ok(AI.MAX_MAX_TOKENS > AI.DEFAULT_MAX_TOKENS, '重试上限高于默认值');
  const n = AI.buildUserPayload(computeChain({
    input: { periodLabel: 'W', cm: { TP: 72, FP: 26, FN: 8, TN: 894 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
  }).ctx).length;
  ok(n < 20000, '提示词长度可控（字符）', String(n));
}

console.log('=== 13. 存档记录结构可被再次读取（模拟 store 记录 → 历史）===');
{
  // 模拟 app.js 保存的精简记录结构，确认 computeChain 能消费
  const saved = {
    periodLabel: 'W07',
    metrics: { piActual: 0.08, recall: 0.9, precision: 0.735, f1: 0.81, accuracy: 0.966, tauQc: 0.098, specificity: 0.972 },
    counts: { TP: 72, FP: 26, FN: 8, TN: 894 },
  };
  const r = computeChain({
    input: { periodLabel: 'W08', cm: { TP: 70, FP: 30, FN: 10, TN: 890 }, strata: [], acceptAccuracy: 0.95, obsWindow: 3 },
    history: [saved],
  });
  ok(r.warning.historyUsed === 1, '警戒线使用到 1 次历史');
  ok(Math.abs(r.warning.baselineB - 0.08) < 1e-12, '基线取自历史 π');
  ok(r.observation.recall.used === 1, '观察线使用到 1 次历史');
  ok(Math.abs(r.observation.recall.value - 0.9) < 1e-12, '观察线 = 0.9');
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
