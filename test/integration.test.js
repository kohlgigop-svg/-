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

  const metrics = Core.computeMetrics(cm);
  const effSS = input.strata && input.strata.length ? Core.effectiveSampleSize(input.strata) : null;
  const bootstrap = Core.bootstrapF(cm, { B: settings.bootstrapB, alpha: settings.alpha, seed: 20240617 });

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
    history, settings, bootstrap, effSS, consecutive,
  };
  const diagnostics = D.run(ctx);
  ctx.diagnostics = diagnostics;
  return { metrics, bootstrap, effSS, warning, observation, verdicts, recallVerdict, diagnostics, ctx, input, acceptAccuracy: acceptAcc, obsWindow };
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
  try { AI.extractJSON('完全没有 JSON'); } catch (e) { threw = true; ok(/无法解析|未返回/.test(e.message), '错误信息可读'); }
  ok(threw, '无 JSON 时抛出可读错误');

  threw = false;
  try { AI.extractJSON(''); } catch (e) { threw = true; }
  ok(threw, '空返回时抛出错误');
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
