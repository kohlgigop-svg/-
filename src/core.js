/* =============================================================================
 * 质检人员质量评估 · 计算内核 (core)
 * -----------------------------------------------------------------------------
 * 纯计算，无 DOM 依赖。浏览器经 <script> 引入，Node 经 loadCore() 引入。
 * 约定：
 *   - 正例 = 驳回（坏数据），负例 = 通过（好数据）
 *   - 分母为 0 时一律返回 null，表示「不可计算」，绝不用 0 冒充
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 0. 基础工具
   * ------------------------------------------------------------------------ */

  /** 二项分布期望的连续四舍五入，保证各行/列合计与边际一致 */
  function apportion(weights, total) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return weights.map(() => 0);
    const raw = weights.map((w) => (w * total) / sum);
    const base = raw.map((v) => Math.floor(v));
    let rest = total - base.reduce((a, b) => a + b, 0);
    const order = raw
      .map((v, i) => ({ i, frac: v - base[i] }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k].i] += 1;
    return base;
  }

  /** 安全除法：分母为 0 → null */
  function div(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
    if (denominator === 0) return null;
    return numerator / denominator;
  }

  function clamp01(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
  }

  /* ---------------------------------------------------------------------------
   * 1. 种子随机数（保证同一份数据每次得到的 Bootstrap 区间完全一致）
   * ------------------------------------------------------------------------ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 线性插值分位数（与 numpy percentile 默认一致） */
  function quantile(sortedArr, q) {
    if (!sortedArr.length) return null;
    if (sortedArr.length === 1) return sortedArr[0];
    const pos = (sortedArr.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
  }

  function median(values) {
    const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
    if (!v.length) return null;
    const s = v.slice().sort((a, b) => a - b);
    return quantile(s, 0.5);
  }

  /* ---------------------------------------------------------------------------
   * 2. 比例型指标的置信区间：Wilson 区间（不用 Wald）
   * ------------------------------------------------------------------------ */

  const Z95 = 1.959963984540054;

  /**
   * Wilson score interval
   * @param {number} k 成功数
   * @param {number} n 总数
   * @param {number} z 分位（默认 95%）
   * @returns {{p:number|null, lo:number|null, hi:number|null, n:number, k:number}}
   */
  function wilson(k, n, z) {
    z = z || Z95;
    const out = { k: k, n: n, p: div(k, n), lo: null, hi: null };
    if (n <= 0) return out;
    const phat = k / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (phat + z2 / (2 * n)) / denom;
    const half =
      (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
    out.lo = clamp01(center - half);
    out.hi = clamp01(center + half);
    return out;
  }

  /* ---------------------------------------------------------------------------
   * 3. F 族公式
   * ------------------------------------------------------------------------ */

  function fbetaFromPR(P, R, beta) {
    if (P === null || R === null) return null;
    const b2 = beta * beta;
    const denom = b2 * P + R;
    if (denom === 0) return null;
    return ((1 + b2) * P * R) / denom;
  }

  /** 由混淆矩阵直接算 Fβ（等价于由 P、R 计算，做交叉校验用） */
  function fbetaFromCM(cm, beta) {
    const P = div(cm.TP, cm.TP + cm.FP);
    const R = div(cm.TP, cm.TP + cm.FN);
    if (P === null || R === null) return null;
    const b2 = beta * beta;
    const denom = (1 + b2) * cm.TP + b2 * cm.FN + cm.FP;
    if (denom === 0) return null;
    return ((1 + b2) * cm.TP) / denom;
  }

  /* ---------------------------------------------------------------------------
   * 4. 全量指标计算
   * ------------------------------------------------------------------------ */

  /**
   * @param {{TP:number,FP:number,FN:number,TN:number}} cmRaw 抽样混淆矩阵
   * @param {{TP:number,FP:number,FN:number,TN:number}|null} cmPop 总体混淆矩阵（可选）
   */
  function computeMetrics(cmRaw, cmPop) {
    const TP = Math.max(0, Math.round(cmRaw.TP || 0));
    const FP = Math.max(0, Math.round(cmRaw.FP || 0));
    const FN = Math.max(0, Math.round(cmRaw.FN || 0));
    const TN = Math.max(0, Math.round(cmRaw.TN || 0));
    const N = TP + FP + FN + TN;

    const precision = div(TP, TP + FP);
    const recall = div(TP, TP + FN);
    const specificity = div(TN, TN + FP);
    const accuracy = div(TP + TN, N);
    const npv = div(TN, TN + FN); // 负例预测值：判通过的里面有多少真该通过
    const fpr = specificity === null ? null : 1 - specificity; // 误判率（假正率）
    const fnr = recall === null ? null : 1 - recall; // 漏判率（假负率）
    const piActual = div(TP + FN, N); // 实际应驳回率（项目结构量）
    const tauQc = div(TP + FP, N); // 质检驳回率（行为倾向）
    const delta = piActual === null || tauQc === null ? null : tauQc - piActual; // 净偏离

    const m = {
      counts: { TP, FP, FN, TN, N },
      // 结构量
      piActual,
      tauQc,
      delta,
      // 主指标点估计
      accuracy,
      precision,
      recall,
      specificity,
      npv,
      fpr,
      fnr,
      f05: fbetaFromPR(precision, recall, 0.5),
      f1: fbetaFromPR(precision, recall, 1),
      f2: fbetaFromPR(precision, recall, 2),
      // 区间
      ci: {
        accuracy: wilson(TP + TN, N),
        precision: wilson(TP, TP + FP),
        recall: wilson(TP, TP + FN),
        specificity: wilson(TN, TN + FP),
        npv: wilson(TN, TN + FN),
        piActual: wilson(TP + FN, N),
        tauQc: wilson(TP + FP, N),
      },
    };

    // 加权还原到总体（P/R/F1/Fβ 为比值，加权后不变；Acc 会变）
    if (cmPop) {
      const pTP = Math.max(0, Math.round(cmPop.TP || 0));
      const pFP = Math.max(0, Math.round(cmPop.FP || 0));
      const pFN = Math.max(0, Math.round(cmPop.FN || 0));
      const pTN = Math.max(0, Math.round(cmPop.TN || 0));
      const pN = pTP + pFP + pFN + pTN;
      m.pop = {
        counts: { TP: pTP, FP: pFP, FN: pFN, TN: pTN, N: pN },
        accuracy: div(pTP + pTN, pN),
        precision: div(pTP, pTP + pFP),
        recall: div(pTP, pTP + pFN),
        specificity: div(pTN, pTN + pFP),
        piActual: div(pTP + pFN, pN),
        tauQc: div(pTP + pFP, pN),
      };
    }
    return m;
  }

  /* ---------------------------------------------------------------------------
   * 5. Bootstrap：F 族指标（P、R 的非线性组合，不能套比例公式）
   * ------------------------------------------------------------------------ */

  /**
   * 参数 Bootstrap。以样本为总体，按多项分布重采样 B 次。
   * @param {object} cm {TP,FP,FN,TN}
   * @param {object} opts {B, seed, alpha, maxN}
   * @returns {object} 各 F 指标的区间
   */
  function bootstrapF(cm, opts) {
    opts = opts || {};
    const B = opts.B || 4000;
    const seed = opts.seed === undefined ? 20240617 : opts.seed;
    const alpha = opts.alpha || 0.05;
    const maxN = opts.maxN || 200000;

    const cells = [
      Math.max(0, Math.round(cm.TP || 0)),
      Math.max(0, Math.round(cm.FP || 0)),
      Math.max(0, Math.round(cm.FN || 0)),
      Math.max(0, Math.round(cm.TN || 0)),
    ];
    const N = cells.reduce((a, b) => a + b, 0);
    const keys = ['f05', 'f1', 'f2', 'precision', 'recall'];
    const acc = { f05: [], f1: [], f2: [], precision: [], recall: [] };
    if (N <= 0) return { n: 0, B: 0, alpha: alpha, result: {} };

    const rnd = mulberry32(seed);
    const probs = cells.map((c) => c / N);
    const exact = N <= maxN; // 小样本用精确逐条抽样，避免多项式近似的舍入误差

    for (let it = 0; it < B; it++) {
      let t = 0, f = 0, n = 0, q = 0;
      if (exact) {
        for (let i = 0; i < N; i++) {
          const u = rnd();
          let c = 0;
          let cum = probs[0];
          while (u > cum && c < 3) { c++; cum += probs[c]; }
          if (c === 0) t++; else if (c === 1) f++; else if (c === 2) n++; else q++;
        }
      } else {
        // 大样本：用「期望 + 残差整分配」保证总数与边际一致
        const exp = probs.map((p) => p * N);
        const draw = exp.map((e) => Math.floor(e));
        let rest = N - draw.reduce((a, b) => a + b, 0);
        const fr = exp.map((e, i) => ({ i, frac: e - draw[i] })).sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < fr.length && rest > 0; k++, rest--) draw[fr[k].i] += 1;
        t = draw[0]; f = draw[1]; n = draw[2]; q = draw[3];
      }
      const P = div(t, t + f);
      const R = div(t, t + n);
      if (P === null || R === null) continue; // 分母为 0 的重采样直接丢弃
      acc.precision.push(P);
      acc.recall.push(R);
      acc.f1.push(fbetaFromPR(P, R, 1));
      acc.f05.push(fbetaFromPR(P, R, 0.5));
      acc.f2.push(fbetaFromPR(P, R, 2));
    }

    const result = {};
    for (const k of keys) {
      const arr = acc[k].filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      result[k] = arr.length
        ? { lo: quantile(arr, alpha / 2), hi: quantile(arr, 1 - alpha / 2), used: arr.length }
        : { lo: null, hi: null, used: 0 };
    }
    return { n: N, B: B, alpha: alpha, seed: seed, exact: exact, result: result };
  }

  /* ---------------------------------------------------------------------------
   * 6. 分层抽样：有效样本量（设计效应参考）
   * ------------------------------------------------------------------------ */

  /**
   * 由各层「总体数」与「抽样数」计算有效样本量
   *
   * 返回两个口径，因为它们回答的问题不同：
   *   nEffClassic = (Σw)²/Σw²   —— 加权估计的经典有效样本量
   *   nEffFpc     —— 计入有限总体校正 (1−f)，抽样比例 f 高时更贴近真实方差
   * 只报告经典口径会在「整层全取」时严重低估精度，故两者并列展示。
   *
   * @param {Array<{name:string,pop:number,sample:number}>} strata
   */
  function effectiveSampleSize(strata) {
    const valid = (strata || []).filter((s) => s && s.pop > 0 && s.sample > 0);
    if (!valid.length) return null;

    let sumW = 0;
    let sumW2 = 0;
    let varTermFpc = 0;

    const detail = valid.map((s) => {
      const f = Math.min(1, s.sample / s.pop); // 抽样比
      const w = 1 / f; // 权重 = 入样概率的倒数
      const wSum = w * s.sample; // = pop
      sumW += wSum;
      sumW2 += w * w * s.sample;
      // Σ N_h² · (1 − f_h) · s_h²，其中 s_h² = f(1−f) ≈ p(1−p) 取最保守 p=1/2
      varTermFpc += Math.pow(s.pop, 2) * (1 - f) * (0.25 / s.sample) * s.sample / s.sample;
      return {
        name: s.name,
        pop: s.pop,
        sample: s.sample,
        weight: w,
        fpc: f,
        oversampled: f > 0.5 + 1e-9,
      };
    });

    const nRaw = valid.reduce((a, s) => a + s.sample, 0);
    const nEffClassic = sumW2 === 0 ? null : (sumW * sumW) / sumW2;
    const nEffFpc = varTermFpc > 0 ? (sumW * sumW) / varTermFpc : null;

    return {
      nRaw: nRaw,
      nEff: nEffClassic, // 向后兼容：默认口径
      nEffClassic: nEffClassic,
      nEffFpc: nEffFpc,
      designEffect: nEffClassic && nRaw > 0 ? nRaw / nEffClassic : null,
      strata: detail,
      anyOversampled: detail.some((d) => d.oversampled),
      fullyEnumerated: detail.some((d) => d.fpc >= 1 - 1e-9),
    };
  }

  /* ---------------------------------------------------------------------------
   * 7. 警戒线策略
   *   a. 基线 B = 前三次评估的实际驳回率中的最高值（不足三次取全部）
   *   b. 容忍率 T = 1 - 需求方要求的验收准确率
   *   c. 召回率下限 R_min = 1 - T/B；R_min <= 0 时取历史最差召回率
   *   d. 可容忍漏判条数 = max(1, 实际应驳回数 × (1 - R_min))
   * ------------------------------------------------------------------------ */

  /**
   * @param {object} p
   * @param {number[]} p.historyPi   历史「实际应驳回率」，按时间倒序（最新在前）
   * @param {number[]} p.historyRecall 历史「召回率点估计」，按时间倒序
   * @param {number} p.acceptAccuracy 需求方要求的验收准确率，如 0.95
   * @param {number} p.piCurrent 本次实际应驳回率
   * @param {number} p.actualPositiveCount 本次抽样内实际应驳回数（TP+FN）
   * @param {number} p.round 取整方式（默认 floor）
   */
  function computeWarningLine(p) {
    const accept = p.acceptAccuracy;
    const T = 1 - accept;

    const histPi = (p.historyPi || []).filter((v) => Number.isFinite(v));
    const used = histPi.slice(0, 3);
    let baselineB;
    let basis;
    if (used.length > 0) {
      baselineB = Math.max.apply(null, used);
      basis = '前' + used.length + '次评估的实际驳回率最大值';
    } else if (Number.isFinite(p.piCurrent)) {
      baselineB = p.piCurrent;
      basis = '无历史数据，取本次实际驳回率';
    } else {
      baselineB = null;
      basis = '无可用数据';
    }

    const out = {
      acceptAccuracy: accept,
      toleranceT: T,
      baselineB: baselineB,
      baselineBasis: basis,
      historyUsed: used.length,
      fallbackToWorstRecall: false,
      rMin: null,
      rMinRaw: null,
      worstRecallUsed: null,
      tolerableMissCount: null,
      tolerableMissBasis: null,
    };

    if (baselineB === null || baselineB <= 0) {
      out.note = '实际驳回率为 0 或缺失，无法推导召回率下限。';
      return out;
    }

    const rMinRaw = 1 - T / baselineB;
    out.rMinRaw = rMinRaw;

    // 注意：严格按 R_min ≤ 0 判断，B 恰好等于 T 时 rMinRaw = 0 也必须退化
    if (rMinRaw <= 0) {
      out.fallbackToWorstRecall = true;
      const histR = (p.historyRecall || []).filter((v) => Number.isFinite(v));
      if (histR.length) {
        out.worstRecallUsed = Math.min.apply(null, histR);
        out.rMin = clamp01(out.worstRecallUsed);
        out.note =
          '基线 B=' + fmtPct(baselineB) + ' ≤ 容忍率 T=' + fmtPct(T) +
          '，理论下限 ' + fmtPct(rMinRaw) + ' ≤ 0（即不做质检也能达标），故退化为历史最差召回率。';
      } else {
        out.rMin = null;
        out.note =
          '基线 B=' + fmtPct(baselineB) + ' ≤ 容忍率 T=' + fmtPct(T) +
          '，理论下限 ≤ 0，且无历史召回率可用，本项不设下限（建议积累历史后再启用）。';
      }
    } else {
      out.rMin = clamp01(rMinRaw);
    }

    if (out.rMin !== null && Number.isFinite(p.actualPositiveCount)) {
      const gross = p.actualPositiveCount * (1 - out.rMin);
      out.tolerableMissCountRaw = gross;
      out.tolerableMissCount = Math.max(1, Math.floor(gross));
      out.tolerableMissBasis =
        '抽样实际应驳回数 ' + p.actualPositiveCount + ' × (1 − ' + fmtPct(out.rMin) + ')';
    }
    return out;
  }

  /* ---------------------------------------------------------------------------
   * 8. 观察线策略
   *   a. 各指标取前 k 次统计的中位数
   *   b. 不足 k 次取全部可用值的中位数
   *   c. 连续两次低于观察线 → 提示纳入观察
   * ------------------------------------------------------------------------ */

  const OBS_METRICS = [
    'accuracy', 'precision', 'recall', 'specificity', 'npv',
    'f05', 'f1', 'f2', 'fpr', 'fnr', 'tauQc', 'piActual',
  ];

  /**
   * @param {Array<object>} history 历史记录（含 metrics），按时间倒序（最新在前，不含本次）
   * @param {number} k 窗口大小
   */
  function computeObservationLines(history, k) {
    k = Math.max(1, Math.round(k || 3));
    const lines = {};
    for (const key of OBS_METRICS) {
      const vals = [];
      for (let i = 0; i < history.length && vals.length < k; i++) {
        const v = history[i] && history[i].metrics ? history[i].metrics[key] : null;
        if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
      }
      lines[key] = {
        value: vals.length ? median(vals) : null,
        used: vals.length,
        window: k,
        values: vals,
        sufficient: vals.length >= k,
      };
    }
    return lines;
  }

  /**
   * 连续低于观察线的判定（directions: 'up' 越大越好 / 'down' 越小越好）
   * @param {Array<object>} series 最近若干次记录，按时间倒序（含本次，最新在前）
   */
  function consecutiveBreach(series, key, lineValue, direction, threshold) {
    if (lineValue === null || lineValue === undefined) {
      return { breach: false, count: 0, reason: '无观察线' };
    }
    const thr = direction === 'down' ? lineValue * (1 + (threshold || 0)) : lineValue * (1 - (threshold || 0));
    let count = 0;
    for (const rec of series) {
      const v = rec && rec.metrics ? rec.metrics[key] : null;
      if (!Number.isFinite(v)) break;
      const bad = direction === 'down' ? v > thr : v < thr;
      if (bad) count++; else break;
    }
    return { breach: count >= 2, count: count, line: lineValue, threshold: thr };
  }

  /* ---------------------------------------------------------------------------
   * 9. 三态判定（信号 / 噪声）
   *   方向 up（越大越好）：用区间下限比警戒线
   *   方向 down（越小越好）：用区间上限比警戒线
   * ------------------------------------------------------------------------ */

  function verdict(point, ci, line, direction) {
    if (line === null || line === undefined) {
      return { state: 'no-line', label: '未设线', pass: null };
    }
    if (point === null || point === undefined) {
      return { state: 'na', label: '不可计算', pass: null };
    }
    if (!ci || ci.lo === null || ci.hi === null) {
      // 无区间时退化为点估计比较，并标注
      const ok = direction === 'down' ? point <= line : point >= line;
      return { state: ok ? 'point-ok' : 'point-bad', label: ok ? '点估计达标（无区间）' : '点估计未达标（无区间）', pass: ok };
    }
    if (direction === 'down') {
      if (ci.hi <= line) return { state: 'pass', label: '达到警戒线要求', pass: true };
      if (ci.lo > line) return { state: 'fail', label: '确证低于要求', pass: false };
      return { state: 'unclear', label: '不确定（区间跨越警戒线）', pass: null };
    }
    if (ci.lo >= line) return { state: 'pass', label: '达到警戒线要求', pass: true };
    if (ci.hi < line) return { state: 'fail', label: '确证低于要求', pass: false };
    return { state: 'unclear', label: '不确定（区间跨越警戒线）', pass: null };
  }

  /* ---------------------------------------------------------------------------
   * 10. 格式化
   * ------------------------------------------------------------------------ */

  function fmtPct(v, digits) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return v.toFixed(digits === undefined ? 3 : digits);
  }

  /* ---------------------------------------------------------------------------
   * 导出
   * ------------------------------------------------------------------------ */

  const Core = {
    apportion: apportion,
    div: div,
    clamp01: clamp01,
    mulberry32: mulberry32,
    quantile: quantile,
    median: median,
    wilson: wilson,
    Z95: Z95,
    fbetaFromPR: fbetaFromPR,
    fbetaFromCM: fbetaFromCM,
    computeMetrics: computeMetrics,
    bootstrapF: bootstrapF,
    effectiveSampleSize: effectiveSampleSize,
    computeWarningLine: computeWarningLine,
    computeObservationLines: computeObservationLines,
    consecutiveBreach: consecutiveBreach,
    verdict: verdict,
    fmtPct: fmtPct,
    fmtNum: fmtNum,
    OBS_METRICS: OBS_METRICS,
  };

  global.QCCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
