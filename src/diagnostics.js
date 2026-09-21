/* =============================================================================
 * 质检人员质量评估 · 结构层诊断 (diagnostics)
 * -----------------------------------------------------------------------------
 * 三层诊断顺序固定：结构层 → 行为层 → 可靠性层。
 * 产出「确定性结论」，不交给模型自由发挥——模型只做解读与动作建议。
 * ========================================================================== */
(function (global) {
  'use strict';

  const C = global.QCCore;

  const LEVEL = { info: 'info', warn: 'warn', alert: 'alert', ok: 'ok' };

  function pct(v, d) { return C.fmtPct(v, d === undefined ? 1 : d); }

  /**
   * @param {object} ctx
   * @param {object} ctx.metrics      C.computeMetrics 的结果
   * @param {object} ctx.warning      C.computeWarningLine 的结果
   * @param {object} ctx.observation  C.computeObservationLines 的结果
   * @param {object} ctx.input        原始录入（含 sampleTotal / strata / periodLabel 等）
   * @param {Array}  ctx.history      历史记录（最新在前，不含本次）
   * @param {object} ctx.settings     工具设置
   * @param {object} ctx.consecutive  连续低于观察线的判定结果
   * @returns {Array<{level,title,detail,evidence,actions}>}
   */
  function run(ctx) {
    const m = ctx.metrics;
    const w = ctx.warning;
    const obs = ctx.observation;
    const input = ctx.input || {};
    const history = ctx.history || [];
    const cards = [];

    const push = (level, title, detail, evidence, actions) =>
      cards.push({ level: level, title: title, detail: detail, evidence: evidence || [], actions: actions || [] });

    /* ======================= 第 1 层：结构层 ======================= */

    // 1.1 准确率是否被 TN 稀释
    if (m.accuracy !== null) {
      const pi = m.piActual;
      if (pi !== null && (pi < 0.2 || pi > 0.8)) {
        push(
          pi < 0.2 ? LEVEL.warn : LEVEL.info,
          '准确率在当前类别分布下不可作为主指标',
          '本次实际应驳回率 π=' + pct(pi) + '，偏离均衡（20%~80%）。准确率 = (TP+TN)/N 会被数量占优的类别稀释：' +
          (pi < 0.2
            ? '在本例中「全部判通过」的人准确率也能拿到 ' + pct(1 - pi) + '，但召回率为 0，坏数据全部流向了下游。'
            : '正例占多数时同理，准确率主要由正例主导，对「冤枉好数据」几乎不敏感。'),
          ['π = ' + pct(pi) + '（结构量，非质检成绩）', '准确率 = ' + pct(m.accuracy)],
          ['解读报表时把准确率降级为「整体协调性参考」，不进入主指标', '以 R（召回率）与特异度替代其诊断职能']
        );
      }
    }

    // 1.2 样本量是否支撑召回率（最常被忽略的结构性缺陷）
    const pos = m.counts.TP + m.counts.FN;
    const ciR = m.ci.recall;
    if (m.recall !== null && ciR && ciR.lo !== null) {
      const width = ciR.hi - ciR.lo;
      if (pos < 100) {
        push(
          LEVEL.alert,
          '召回率的判定基础不足：实际应驳回样本仅 ' + pos + ' 条',
          '召回率的分母是「实际应驳回数」，本次仅 ' + pos + ' 条。95% 置信区间为 [' +
          pct(ciR.lo) + ', ' + pct(ciR.hi) + ']，宽度 ' + pct(width) +
          '。在此样本量下，区间宽度过大，召回率的排序与达标判定都不成立。',
          ['实际应驳回数（R 的分母）= ' + pos, 'R 的 95% 区间宽度 = ' + pct(width)],
          [
            '不要用本次召回率做个人评价或排名',
            '增大样本量，或对「已驳回层」分层过采样（过采样后必须按加权口径重算，并报告有效样本量）',
            '若暂时无法补样本，则以区间下限参与判断，并在记录中标注「仅供趋势参考」',
          ]
        );
      } else if (width > 0.10) {
        push(
          LEVEL.warn,
          '召回率的置信区间偏宽（' + pct(width) + '）',
          '实际应驳回 ' + pos + ' 条，95% 区间为 [' + pct(ciR.lo) + ', ' + pct(ciR.hi) + ']。' +
          '区间宽度超过 10 个百分点，意味着点估计的差异可能主要来自抽样波动而非真实能力差异。',
          ['R 的 95% 区间 = [' + pct(ciR.lo) + ', ' + pct(ciR.hi) + ']'],
          ['比较不同质检员时检验「差值的区间」是否包含 0，而不是直接比点估计', '累积多个周期样本后再做结论']
        );
      }
    }

    // 1.3 精确率的分母是否过小
    const rejCount = m.counts.TP + m.counts.FP;
    const ciP = m.ci.precision;
    if (m.precision !== null && ciP && ciP.lo !== null && rejCount < 100) {
      push(
        LEVEL.warn,
        '精确率的判定基础偏薄：质检驳回样本仅 ' + rejCount + ' 条',
        '精确率的分母是「被质检员驳回的数据数」，本次仅 ' + rejCount + ' 条，95% 区间为 [' +
        pct(ciP.lo) + ', ' + pct(ciP.hi) + ']（宽度 ' + pct(ciP.hi - ciP.lo) + '）。' +
        '另需注意：本次实际应驳回率 π=' + (m.piActual !== null ? pct(m.piActual) : '—') +
        '，π 偏低本身就会把精确率压低，因此精确率不能与「误判程度」划等号。',
        ['驳回数（P 的分母）= ' + rejCount, 'P 的 95% 区间 = [' + pct(ciP.lo) + ', ' + pct(ciP.hi) + ']'],
        [
          '衡量「误判」请用特异度（上方指标表中的「特异度」行），其分母是实际合格数，不受 π 影响',
          '把 π 与 P 并列展示，避免把结构现象读成个人能力问题',
        ]
      );
    }

    // 1.4 驳回量偏离标准的整体倾向
    if (m.delta !== null && m.piActual !== null && m.piActual > 0) {
      const relDev = m.delta / m.piActual;
      if (Math.abs(relDev) > 0.3) {
        push(
          m.delta > 0 ? LEVEL.warn : LEVEL.warn,
          m.delta > 0 ? '驳回倾向偏激进：质检驳回量高于标准驳回量' : '驳回倾向偏保守：质检驳回量低于标准驳回量',
          '质检驳回率 τ=' + pct(m.tauQc) + '，标准应驳回率 π=' + pct(m.piActual) +
          '，净偏离 Δ=' + pct(m.delta) + '（相对偏差 ' + pct(relDev, 0) + '）。' +
          (m.delta > 0
            ? '多驳回的部分会转化为误驳回（FP=' + m.counts.FP + ' 条），代价是返修工时与标注员积极性。'
            : '少驳回的部分会转化为漏判（FN=' + m.counts.FN + ' 条），代价可能不可逆（坏数据流向训练/下游）。'),
          ['τ = ' + pct(m.tauQc), 'π = ' + pct(m.piActual), 'Δ = ' + pct(m.delta), 'FP=' + m.counts.FP + '，FN=' + m.counts.FN],
          m.delta > 0
            ? ['抽取 FP 样本查看：是否集中在标准模糊的类别上', '若多名质检员同时偏激进，优先修标准而非培训个人']
            : ['抽取 FN 样本查看：漏判集中在哪一类错误', '先核对驳回量基线，区分行为问题与能力问题']
        );
      }
    }

    // 1.5 项目结构是否发生变动（与历史比较）
    if (history.length) {
      const histPi = history.slice(0, 3).map((r) => r.metrics && r.metrics.piActual).filter((v) => Number.isFinite(v));
      if (histPi.length && m.piActual !== null) {
        const histMax = Math.max.apply(null, histPi);
        const ratio = histMax > 0 ? m.piActual / histMax : null;
        if (ratio !== null && (ratio > 1.5 || ratio < 0.5)) {
          push(
            LEVEL.alert,
            '实际驳回率相对历史出现结构性变动，横向可比性受影响',
            '本次 π=' + pct(m.piActual) + '，历史前 ' + histPi.length + ' 次最高 π=' + pct(histMax) +
            '，比值 ' + ratio.toFixed(2) + '。项目结构变化时，指标的变化可能来自数据/标准/任务构成的变化，而非质检人员能力的变化。',
            ['本次 π = ' + pct(m.piActual), '历史最高 π = ' + pct(histMax)],
            ['先确认标准或任务构成是否变更', '结构变动周期内的指标不纳入纵向比较，必要时重设基线']
          );
        }
      }
    }

    /* ======================= 第 2 层：行为层 ======================= */

    // 2.1 召回率 vs 警戒线（唯一设绝对线的指标，且只对不可逆错误）
    if (w && w.rMin !== null && m.recall !== null) {
      const v = C.verdict(m.recall, m.ci.recall, w.rMin, 'up');
      const lineTxt = '召回率下限 R_min=' + pct(w.rMin) +
        '（由基线 B=' + pct(w.baselineB) + '、容忍率 T=' + pct(w.toleranceT) + ' 推导；' + w.baselineBasis + '）';
      if (v.state === 'fail') {
        push(
          LEVEL.alert,
          '召回率确证低于警戒线（漏判风险）',
          lineTxt + '。本次召回率 ' + pct(m.recall) + '，95% 区间 [' + pct(m.ci.recall.lo) + ', ' + pct(m.ci.recall.hi) +
          ']，区间上限已低于下限，判为确证不达标。可容忍漏判条数 = ' + w.tolerableMissCount + ' 条，实际漏判 ' + m.counts.FN + ' 条。',
          ['R = ' + pct(m.recall) + '，区间 [' + pct(m.ci.recall.lo) + ', ' + pct(m.ci.recall.hi) + ']', 'R_min = ' + pct(w.rMin),
            '可容忍漏判 = ' + w.tolerableMissCount + ' 条，实际 FN = ' + m.counts.FN + ' 条'],
          ['对全部 FN 样本做错误归因，按错误类型归类统计', '若 FN 集中在某一类错误 → 培训问题；若均匀分布 → 标准理解或判定阈值问题',
            '触发本项时应进入人工复核，并核对本周期数据是否已流出']
        );
      } else if (v.state === 'unclear') {
        push(
          LEVEL.warn,
          '召回率不确定：置信区间跨越警戒线',
          lineTxt + '。本次召回率 ' + pct(m.recall) + '，区间 [' + pct(m.ci.recall.lo) + ', ' + pct(m.ci.recall.hi) +
          '] 跨越了 R_min，样本量不足以判定是否达标。',
          ['R 的区间 = [' + pct(m.ci.recall.lo) + ', ' + pct(m.ci.recall.hi) + ']', 'R_min = ' + pct(w.rMin)],
          ['不作达标/不达标结论，先补样本量再判', '若本周期必须出结论，改用区间下限做保守判断并在记录中标注']
        );
      } else if (v.state === 'pass') {
        push(LEVEL.ok, '召回率达到警戒线要求',
          lineTxt + '。本次召回率 ' + pct(m.recall) + '，区间下限 ' + pct(m.ci.recall.lo) + ' 已高于 R_min。',
          ['R = ' + pct(m.recall), 'R_min = ' + pct(w.rMin)], []);
      }
    }

    // 2.2 消极判定信号：驳回量显著低于基线而 P 很高
    if (m.delta !== null && m.piActual !== null && m.precision !== null) {
      const lowReject = m.tauQc !== null && m.piActual > 0 && m.tauQc < m.piActual * 0.5;
      if (lowReject && m.precision >= 0.7) {
        push(
          LEVEL.alert,
          '消极判定信号：驳回量明显偏低，但驳回的准确性很高',
          '质检驳回率 τ=' + pct(m.tauQc) + '，不足标准应驳回率 π=' + pct(m.piActual) + ' 的一半；' +
          '同时精确率 P=' + pct(m.precision) + '。这种「少驳但驳得准」的形态，通常意味着只对最确定的错误下判断，' +
          '其余一律放行——风险全部转移到下游，且在本指标体系中表现为漏判（FN=' + m.counts.FN + ' 条）。',
          ['τ/π = ' + (m.piActual > 0 ? (m.tauQc / m.piActual).toFixed(2) : '—'), 'P = ' + pct(m.precision), 'FN = ' + m.counts.FN],
          ['先与驳回量团队基线对照，确认是否为个体行为差异', '调取该质检员「放行」样本中随机抽检，统计实际错误率',
            '若确认消极判定，属于行为问题而非能力问题，不宜用培训解决']
        );
      }
    }

    // 2.3 过度驳回：特异度低
    if (m.specificity !== null && m.counts.TN + m.counts.FP > 0) {
      if (m.specificity < 0.9) {
        push(
          LEVEL.warn,
          '特异度偏低：存在较明显的好数据被误驳回',
          '特异度=' + pct(m.specificity) + '（误判率 FPR=' + pct(m.fpr) + '），实际合格 ' +
          (m.counts.TN + m.counts.FP) + ' 条中被误驳回 ' + m.counts.FP + ' 条。' +
          '注意：这一项要用特异度衡量，不能用精确率代替——精确率的分母是被驳回数，会随 π 波动。',
          ['特异度 = ' + pct(m.specificity), 'FP = ' + m.counts.FP + ' / 实际合格 ' + (m.counts.TN + m.counts.FP)],
          ['抽取 FP 样本，核对其是否触发了标准中定义模糊的条款', '若多名质检员同时偏低 → 属标准精度问题，应补细则而非培训个人']
        );
      }
    }

    // 2.4 连续两次低于观察线 → 纳入观察（提示性质）
    if (ctx.consecutive && ctx.consecutive.breach) {
      const c = ctx.consecutive;
      push(
        LEVEL.warn,
        '连续 ' + c.count + ' 次低于观察线（' + (c.label || c.key) + '），纳入观察',
        '观察线 = ' + pct(c.line) + '，最近 ' + c.count + ' 次均低于该值。单次低于可能是抽样波动，连续低于才提示趋势。' +
        (c.sufficient ? '' : '注意：观察线由不足窗口长度的历史得出，稳健性有限。'),
        ['观察线 = ' + pct(c.line), '连续低于次数 = ' + c.count, '窗口 = 前 ' + (c.window || 'k') + ' 次中位数'],
        ['纳入观察清单，看下一周期是否恢复', '若下一周期仍低于观察线，再启动根因分析', '不要单凭本项直接定性']
      );
    }

    /* ======================= 第 3 层：可靠性层 ======================= */

    // 3.1 Bootstrap 是否收敛（重采样可用比例）
    if (ctx.bootstrap && ctx.bootstrap.result && ctx.bootstrap.result.f1) {
      const used = ctx.bootstrap.result.f1.used;
      const attempted = ctx.bootstrap.B;
      if (attempted > 0 && used / attempted < 0.9) {
        push(
          LEVEL.warn,
          'F 族指标的区间由不足 ' + Math.round((used / attempted) * 100) + '% 的有效重采样得出',
          '共尝试 ' + attempted + ' 次重采样，其中 ' + used + ' 次出现分母为 0 的情形被丢弃。' +
          '丢弃比例偏高说明矩阵中有空格（TP/FP/FN/TN 至少一项为 ' + [m.counts.TP, m.counts.FP, m.counts.FN, m.counts.TN].filter((x) => x === 0).length + ' 项为 0），F 族区间应谨慎解读。',
          ['有效重采样 ' + used + ' / ' + attempted],
          ['补充样本以填补空格', '空格存在时优先看 P、R 两个原始指标，少用 F 族做结论']
        );
      }
    }

    // 3.2 空缺单元提示
    const emptyCells = [];
    if (m.counts.TP === 0) emptyCells.push('TP（无正确驳回）');
    if (m.counts.FP === 0) emptyCells.push('FP（无误驳回）');
    if (m.counts.FN === 0) emptyCells.push('FN（无漏判）');
    if (m.counts.TN === 0) emptyCells.push('TN（无正确通过）');
    if (emptyCells.length) {
      push(
        LEVEL.info,
        '混淆矩阵存在零值单元：' + emptyCells.join('、'),
        '对应指标的分母可能为 0，工具已按「不可计算」处理（不以 0 冒充）。请核对录入数据是否完整。',
        emptyCells,
        ['核对本次抽样的混淆矩阵录入', '若零值属实，相关指标不参与本次判定']
      );
    }

    // 3.3 分层抽样：口径不自洽（最高优先级——权重错了，结论就全错）
    if (ctx.stratified && ctx.stratified.consistent === false) {
      push(
        LEVEL.alert,
        '分层信息与混淆矩阵不一致，加权口径已停用',
        ctx.stratified.inconsistencyReason +
        '。分层的「驳回层」应恰好对应 TP+FP（质检判为驳回的抽样条数），' +
        '「通过层」应恰好对应 FN+TN。对不上说明分层口径或矩阵有一方填错，' +
        '此时用错误权重加权会得到错误结论，故本次仍按样本内口径计算。',
        ['驳回层抽样数应 = TP+FP', '通过层抽样数应 = FN+TN', ctx.stratified.inconsistencyReason],
        ['核对分层抽样数与混淆矩阵的对应关系', '确认分层依据是「质检判定」而非「实际应驳回」']
      );
    }

    // 3.4 分层抽样：非等概率 → 已切换为加权口径，必须说明差异
    if (ctx.useWeighted && ctx.stratified) {
      const st = ctx.stratified;
      const dev = st.maxDeviation || 0;
      const sm = st.sampleMetrics;
      const wm = st.metrics;
      const pctPt = (a, b) => (a === null || b === null ? '—' : ((a - b) * 100).toFixed(1) + 'pp');
      const s1 = st.strata[0];
      const s2 = st.strata[1];
      push(
        dev > 0.02 ? LEVEL.warn : LEVEL.info,
        '非等概率分层：已改用加权口径，样本内口径有偏',
        '各层抽样比不同（' + s1.name + ' ' + (s1.fpc * 100).toFixed(2) + '%、'
        + s2.name + ' ' + (s2.fpc * 100).toFixed(2) + '%），'
        + '此时直接用抽样内计数会系统性偏离总体真值。本次展示的是按入样概率加权后的总体估计。'
        + '样本内口径与加权口径的差距：召回率 ' + pctPt(sm.recall, wm.recall)
        + '、特异度 ' + pctPt(sm.specificity, wm.specificity)
        + '、实际应驳回率 ' + pctPt(sm.piActual, wm.piActual) + '。'
        + '精确率不受影响（它完全落在驳回层内部）。',
        [
          s1.name + '：总体 ' + s1.pop + '，抽样 ' + s1.sample + '，权重 ' + s1.weight.toFixed(2),
          s2.name + '：总体 ' + s2.pop + '，抽样 ' + s2.sample + '，权重 ' + s2.weight.toFixed(2),
          '召回率有效样本量 ≈ ' + (st.nEff.recall === null ? '无抽样误差' : st.nEff.recall.toFixed(0))
            + '（设计效应 ' + (st.designEffect.recall === null ? '—' : st.designEffect.recall.toFixed(2)) + '）',
        ],
        [
          '报告时明确标注为「加权后的总体估计」，不要与样本内口径混用',
          '各评估周期保持抽样比一致，否则历史观察线不可比',
          '过采样虽提高该层精度，但总体层面的有效样本量会被折算，区间会变宽',
        ]
      );
    }

    // 3.6 历史口径混用：加权尺度和样本内尺度不可直接相比
    if (ctx.useWeighted && Array.isArray(ctx.history) && ctx.history.length) {
      const sampleOnes = ctx.history.filter((h) => h.weighting && h.weighting.mode
        && h.weighting.mode !== 'weighted');
      if (sampleOnes.length) {
        push(
          LEVEL.warn,
          '历史记录口径与本期不一致，观察线与趋势不可比',
          '历史中有 ' + sampleOnes.length + ' 期是按「样本内口径」记录的（未加权），'
          + '而本期是非等概率分层，已改用「加权后总体估计」。两种口径的数值不在同一尺度上，'
          + '直接比较会得出错误结论——例如过采样时样本内召回率会偏高、特异度与驳回率会严重偏离。'
          + '观察线取历史中位数，混用两种口径会让它落到无意义的中间值上。',
          [
            '不一致的历史周期：' + sampleOnes.map((h) => h.periodLabel).join('、'),
            '本期口径：加权后总体估计',
            '历史口径：样本内（未加权）',
          ],
          [
            '固定抽样方案后，用新口径重新评估若干周期再启用观察线',
            '或在对比时只看同期同口径的数据，不要跨口径排序',
          ]
        );
      }
    }

    // 3.5 分层抽样：有效样本量参考（无论是否加权都适用）
    if (ctx.effSS && ctx.effSS.nEffClassic && ctx.effSS.nRaw) {
      const de = ctx.effSS.designEffect;
      if (de && de > 1.05) {
        push(
          LEVEL.info,
          '分层抽样存在过采样，有效样本量低于原始样本量',
          '原始样本 ' + ctx.effSS.nRaw + ' 条，加权后的经典有效样本量约 ' + ctx.effSS.nEffClassic.toFixed(0) +
          ' 条（设计效应 ' + de.toFixed(2) + '）。对低频层过采样会提高其精度，但总体层面的有效信息量会被折算。',
          ['原始样本 = ' + ctx.effSS.nRaw, '有效样本（经典口径）≈ ' + ctx.effSS.nEffClassic.toFixed(0),
            '设计效应 = ' + de.toFixed(2)],
          ['报告指标时同时给出有效样本量', '保持抽样口径在各评估周期一致，否则历史观察线失效']
        );
      }
    }

    // 3.4 历史不足
    if (!history.length) {
      push(
        LEVEL.info,
        '首次评估：观察线尚不可用',
        '本周期没有历史记录，观察线（前 k 次中位数）无法计算，因此「连续低于观察线」的判定本次不生效。' +
        '本次数据将作为后续周期的基线。',
        ['历史记录数 = 0'],
        ['先把本次结果保存为基线', '从第二次评估起，观察线自动生效']
      );
    } else if (history.length < (ctx.settings && ctx.settings.obsWindow ? ctx.settings.obsWindow : 3)) {
      push(
        LEVEL.info,
        '历史记录不足 ' + (ctx.settings ? ctx.settings.obsWindow || 3 : 3) + ' 次，观察线由现有 ' + history.length + ' 次得出',
        '观察线取样窗口为 ' + (ctx.settings ? ctx.settings.obsWindow || 3 : 3) + ' 次，当前仅有 ' + history.length +
        ' 次历史。样本较少时中位数不够稳健，观察线仅供参考。',
        ['历史记录数 = ' + history.length],
        ['继续累积周期数据', '暂不据观察线做结论性判断']
      );
    }

    return cards;
  }

  function aKey(k) { return k; }

  global.QCDiag = { run: run, LEVEL: LEVEL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
