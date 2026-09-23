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
   * 11. 分层抽样：加权估计与设计校正区间
   * ------------------------------------------------------------------------ */

  /**
   * 分层依据必须是「质检判定」——分层要在拿到金标准之前完成，
   * 而「实际应驳回」需要先有金标准，无法用来分层。因此：
   *     驳回层（positive）= 质检判为驳回 → 内含 TP 与 FP
   *     通过层（negative）= 质检判为通过 → 内含 FN 与 TN
   */
  function strataRole(s) {
    if (!s) return null;
    if (s.role === 'positive' || s.role === 'negative') return s.role;
    const n = String(s.name || '');
    if (/驳回/.test(n)) return 'positive';
    if (/通过/.test(n)) return 'negative';
    return null;
  }

  /**
   * 由「层内比例的设计方差」反解有效样本量。
   *
   * 常规情形用 n_eff = v(1−v)/Var(v̂)。
   * 但 v 取到 0 或 1 时 v(1−v)=0 会让定义退化，此时改用「层内比例取 p=0.5
   * 的最大方差」来定义，得到一个保守但明确的有效样本量。
   * 若连保守方差都为 0（整层全取 → 无抽样误差），返回 null 表示无抽样误差。
   */
  function effNFromVar(value, variance, conservativeVariance) {
    if (value === null || value === undefined) return null;
    if (variance > 0 && value > 0 && value < 1) return (value * (1 - value)) / variance;
    if (conservativeVariance > 0) return 0.25 / conservativeVariance;
    return null;
  }

  /** 按有效样本量构造 Wilson 区间；有效样本量为 null 表示无抽样误差 */
  function ciFromEffN(value, nEff, z) {
    if (value === null || value === undefined) return { lo: null, hi: null };
    if (nEff === null || !Number.isFinite(nEff) || nEff <= 0) return { lo: value, hi: value };
    return wilson(value * nEff, nEff, z);
  }

  /** 以设计方差抽取一个层内比例（保留有限总体校正） */
  function drawStratumProportion(rnd, pHat, n, f) {
    if (pHat === null) return null;
    if (f >= 1 - 1e-12) return pHat;          // 整层全取：无抽样误差
    // 令 n_eff = n/(1−f)，则 Bin(n_eff, p)/n_eff 的方差恰为 p(1−p)(1−f)/n
    const nEff = n / (1 - f);
    if (nEff <= 20000) {
      const m = Math.max(1, Math.round(nEff));
      let hit = 0;
      for (let i = 0; i < m; i++) if (rnd() < pHat) hit++;
      return hit / m;
    }
    // 极大有效样本量：改用正态近似（此时离散性已无影响）
    const se = Math.sqrt((pHat * (1 - pHat)) / nEff);
    const u1 = Math.max(1e-12, rnd());
    const u2 = rnd();
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(1, Math.max(0, pHat + gauss * se));
  }

  /**
   * 分层抽样下的加权估计。
   *
   * 为什么必须加权：非等概率分层（例如对「已驳回层」过采样）时，
   * 直接用抽样内计数算出的 R / Spec / Acc / π / τ 都是有偏的，
   * 实测偏差可达数十个百分点（见 test/stratified.test.js 的蒙特卡洛验证）。
   * 只有 P（精确率）与 NPV 不受影响，因为它们完全落在单一层内部。
   *
   * @param {Array<{name?:string, role?:string, pop:number, sample:number}>} strata
   * @param {object} cm {TP,FP,FN,TN}
   * @param {object} [opts] {alpha, z, B, seed}
   * @returns {object|null}
   */
  function computeStratified(strata, cm, opts) {
    opts = opts || {};
    if (!strata || !strata.length || !cm) return null;

    const alpha = opts.alpha || 0.05;
    const z = opts.z || 1.959963985;

    let pos = null;
    let neg = null;
    strata.forEach((s) => {
      if (!s || !(s.pop > 0) || !(s.sample > 0)) return;
      const role = strataRole(s);
      if (role === 'positive' && !pos) pos = s;
      else if (role === 'negative' && !neg) neg = s;
    });
    if (!pos || !neg) return null;

    const TP = Math.max(0, Math.round(cm.TP || 0));
    const FP = Math.max(0, Math.round(cm.FP || 0));
    const FN = Math.max(0, Math.round(cm.FN || 0));
    const TN = Math.max(0, Math.round(cm.TN || 0));

    const n1 = pos.sample;
    const n2 = neg.sample;
    const N1 = pos.pop;
    const N2 = neg.pop;
    const f1 = Math.min(1, n1 / N1);
    const f2 = Math.min(1, n2 / N2);
    const w1 = N1 / n1;
    const w2 = N2 / n2;
    const N = N1 + N2;

    /* --- 一致性：层样本量必须与混淆矩阵对应 --- */
    const reasons = [];
    if (TP + FP !== n1) reasons.push('驳回层抽样数 ' + n1 + ' 与 TP+FP=' + (TP + FP) + ' 不符');
    if (FN + TN !== n2) reasons.push('通过层抽样数 ' + n2 + ' 与 FN+TN=' + (FN + TN) + ' 不符');
    const consistent = reasons.length === 0;

    /* --- 加权到总体的四格计数 --- */
    const A = w1 * TP;   // 总体 TP
    const Dp = w1 * FP;  // 总体 FP
    const Bn = w2 * FN;  // 总体 FN
    const Cn = w2 * TN;  // 总体 TN

    /* --- 层内比例 --- */
    const p1 = div(TP, n1);   // 驳回层中「确实该驳回」的比例（数学上即精确率）
    const p2 = div(FN, n2);   // 通过层中「漏判」的比例

    /* --- 设计方差（含有限总体校正 1−f） --- */
    const varA = w1 * w1 * n1 * (p1 === null ? 0 : p1 * (1 - p1)) * (1 - f1);
    const varD = varA;        // FP = n1 − TP，方差同量
    const varB = w2 * w2 * n2 * (p2 === null ? 0 : p2 * (1 - p2)) * (1 - f2);
    const varC = varB;        // TN = n2 − FN
    // p=0.5 的保守方差，供比例取到 0/1 时定义有效样本量
    const varAc = w1 * w1 * n1 * 0.25 * (1 - f1);
    const varBc = w2 * w2 * n2 * 0.25 * (1 - f2);

    /* --- 加权点估计 --- */
    const recall = div(A, A + Bn);
    const precision = div(A, A + Dp);         // 数学上等于 p1
    const specificity = div(Cn, Cn + Dp);
    const npv = div(Cn, Cn + Bn);             // 数学上等于 1 − p2
    const accuracy = div(A + Cn, N);
    const piActual = div(A + Bn, N);
    const tauQc = div(A + Dp, N);             // = N1/N，已知常数
    const fnr = recall === null ? null : 1 - recall;
    const fpr = specificity === null ? null : 1 - specificity;

    /* --- 各指标的设计方差（比值用 delta 法；两层相互独立） --- */
    const ratioVar = (num, den, varNum, varDen) => {
      const tot = num + den;
      if (!(tot > 0)) return 0;
      return (den * den * varNum + num * num * varDen) / Math.pow(tot, 4);
    };
    const vRecall = ratioVar(A, Bn, varA, varB);
    const vRecallC = ratioVar(A, Bn, varAc, varBc);
    const vSpec = ratioVar(Cn, Dp, varC, varD);
    const vSpecC = ratioVar(Cn, Dp, varBc, varAc);
    const vPrec = p1 === null ? 0 : (p1 * (1 - p1) * (1 - f1)) / n1;
    const vPrecC = (0.25 * (1 - f1)) / n1;
    const vNpv = p2 === null ? 0 : (p2 * (1 - p2) * (1 - f2)) / n2;
    const vNpvC = (0.25 * (1 - f2)) / n2;
    const vAcc = (varA + varC) / (N * N);
    const vAccC = (varAc + varBc) / (N * N);
    const vPi = (varA + varB) / (N * N);
    const vPiC = (varAc + varBc) / (N * N);

    /* --- 有效样本量与区间 --- */
    const nEff = {
      recall: effNFromVar(recall, vRecall, vRecallC),
      precision: effNFromVar(precision, vPrec, vPrecC),
      specificity: effNFromVar(specificity, vSpec, vSpecC),
      npv: effNFromVar(npv, vNpv, vNpvC),
      accuracy: effNFromVar(accuracy, vAcc, vAccC),
      piActual: effNFromVar(piActual, vPi, vPiC),
      tauQc: null,   // τ 是已知常数，无抽样误差
    };
    const ci = {
      recall: ciFromEffN(recall, nEff.recall, z),
      precision: ciFromEffN(precision, nEff.precision, z),
      specificity: ciFromEffN(specificity, nEff.specificity, z),
      npv: ciFromEffN(npv, nEff.npv, z),
      accuracy: ciFromEffN(accuracy, nEff.accuracy, z),
      piActual: ciFromEffN(piActual, nEff.piActual, z),
      tauQc: { lo: tauQc, hi: tauQc },
    };

    /* --- F 族：在分层设计下重采样（P 与 R 经 TP 相关，不能套比例公式） ---
     * skipBootstrap：调用方若已判定不会采用加权口径（等抽样比或分层不自洽），
     * 可跳过多项式重采样。否则主程序会先把这里算一遍、再算一遍朴素 Bootstrap，
     * 等于每次计算做两遍重采样，B 调大时开销直接翻倍。 */
    const bootF = {};
    const B = opts.B || 4000;
    const seed = opts.seed === undefined ? 20240617 : opts.seed;
    if (!opts.skipBootstrap) {
      const rnd = mulberry32(seed);
      const accF = { f05: [], f1: [], f2: [], precision: [], recall: [] };
      for (let it = 0; it < B; it++) {
        const s1 = drawStratumProportion(rnd, p1, n1, f1);
        const s2 = drawStratumProportion(rnd, p2, n2, f2);
        if (s1 === null || s2 === null) continue;
        const Aw = w1 * n1 * s1;
        const Bw = w2 * n2 * s2;
        const P = s1;                       // 精确率即驳回层内比例
        const R = div(Aw, Aw + Bw);
        if (P === null || R === null) continue;
        accF.precision.push(P);
        accF.recall.push(R);
        accF.f1.push(fbetaFromPR(P, R, 1));
        accF.f05.push(fbetaFromPR(P, R, 0.5));
        accF.f2.push(fbetaFromPR(P, R, 2));
      }
      ['f05', 'f1', 'f2', 'precision', 'recall'].forEach((k) => {
        const arr = accF[k].filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
        bootF[k] = arr.length
          ? { lo: quantile(arr, alpha / 2), hi: quantile(arr, 1 - alpha / 2), used: arr.length }
          : { lo: null, hi: null, used: 0 };
      });
    }

    /* --- 样本内（未加权）口径：保留下来用于对照与警示 --- */
    const nAll = TP + FP + FN + TN;
    const sampleMetrics = {
      recall: div(TP, TP + FN),
      precision: div(TP, TP + FP),
      specificity: div(TN, TN + FP),
      npv: div(TN, TN + FN),
      accuracy: div(TP + TN, nAll),
      piActual: div(TP + FN, nAll),
      tauQc: div(TP + FP, nAll),
    };
    sampleMetrics.fnr = sampleMetrics.recall === null ? null : 1 - sampleMetrics.recall;
    sampleMetrics.fpr = sampleMetrics.specificity === null ? null : 1 - sampleMetrics.specificity;

    /* --- 设计效应：原始计数 / 有效样本量 --- */
    const rawDen = {
      recall: TP + FN, precision: TP + FP, specificity: TN + FP,
      npv: TN + FN, accuracy: nAll, piActual: nAll,
    };
    const designEffect = {};
    Object.keys(rawDen).forEach((k) => {
      designEffect[k] = nEff[k] && nEff[k] > 0 ? rawDen[k] / nEff[k] : null;
    });

    /* --- 加权与样本内口径的最大偏离：供诊断卡判断是否必须警示 --- */
    const weighted = { recall, precision, specificity, npv, accuracy, piActual, tauQc };
    let maxDeviation = 0;
    Object.keys(weighted).forEach((k) => {
      if (weighted[k] === null || sampleMetrics[k] === null) return;
      maxDeviation = Math.max(maxDeviation, Math.abs(weighted[k] - sampleMetrics[k]));
    });

    return {
      consistent: consistent,
      inconsistencyReason: reasons.length ? reasons.join('；') : null,
      selfWeighting: Math.abs(f1 - f2) < 1e-9,
      fullyEnumerated: f1 >= 1 - 1e-9 || f2 >= 1 - 1e-9,
      anyOversampled: f1 > 0.5 + 1e-9 || f2 > 0.5 + 1e-9,
      popTotal: N,
      popCounts: { TP: A, FP: Dp, FN: Bn, TN: Cn, N: N },
      strata: [
        { name: pos.name || '驳回层', role: 'positive', pop: N1, sample: n1, weight: w1, fpc: f1 },
        { name: neg.name || '通过层', role: 'negative', pop: N2, sample: n2, weight: w2, fpc: f2 },
      ],
      metrics: {
        accuracy: accuracy, precision: precision, recall: recall,
        specificity: specificity, npv: npv, fpr: fpr, fnr: fnr,
        piActual: piActual, tauQc: tauQc,
        delta: tauQc === null || piActual === null ? null : tauQc - piActual,
        f05: fbetaFromPR(precision, recall, 0.5),
        f1: fbetaFromPR(precision, recall, 1),
        f2: fbetaFromPR(precision, recall, 2),
      },
      sampleMetrics: sampleMetrics,
      ci: ci,
      nEff: nEff,
      designEffect: designEffect,
      bootF: bootF,
      maxDeviation: maxDeviation,
      alpha: alpha,
      seed: seed,
    };
  }

  /**
   * 把分层加权结果合并进标准指标对象。
   *
   * 以 computeMetrics 的结果为底（保证字段形状完全一致），
   * 再用加权口径覆盖点估计与区间，并挂上样本内口径供对照。
   * 这样下游所有代码（渲染、判定、诊断、提示词）无需区分两条路径。
   */
  function mergeWeightedMetrics(base, strat) {
    if (!base || !strat) return base;
    const m = Object.assign({}, base);
    ['accuracy', 'precision', 'recall', 'specificity', 'npv', 'fpr', 'fnr',
      'f05', 'f1', 'f2', 'piActual', 'tauQc', 'delta'].forEach((k) => {
      if (strat.metrics[k] !== undefined) m[k] = strat.metrics[k];
    });
    m.ci = Object.assign({}, base.ci, strat.ci);
    m.stratified = true;
    m.sampleMetrics = strat.sampleMetrics;
    m.popCounts = strat.popCounts;
    return m;
  }

  /**
   * 判断本次是否应采用加权口径。
   *
   * 只有两个条件同时成立才切换：
   *   1. 分层信息与混淆矩阵自洽——否则权重必然是错的，宁可不加权并告警；
   *   2. 各层抽样比不同（非自加权）——等概率时加权与样本内在数学上相同，
   *      切换只会让用户困惑。
   */
  function shouldUseWeighted(strat) {
    return !!(strat && strat.consistent && !strat.selfWeighting);
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
    computeStratified: computeStratified,
    mergeWeightedMetrics: mergeWeightedMetrics,
    shouldUseWeighted: shouldUseWeighted,
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
