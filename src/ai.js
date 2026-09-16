/* =============================================================================
 * 质检人员质量评估 · AI 分析模块 (ai)
 * -----------------------------------------------------------------------------
 * 职责：把「工具算好的一切」整理成结构化事实 → 交给模型 → 只让模型做
 *       「解读 + 根因假设 + 动作建议」，不允许它重算数字或给人打分。
 * ========================================================================== */
(function (global) {
  'use strict';

  const C = global.QCCore;

  /* ---------------------------------------------------------------------------
   * 系统提示词 —— 全文纪律固化处，修改需谨慎
   * ------------------------------------------------------------------------ */

  const SYSTEM_PROMPT = [
    '你是数据标注行业的数据质量分析师，精通混淆矩阵族指标（准确率、精确率、召回率、F1、Fβ、特异度）与统计不确定性表达，专长是把质控指标翻译成可执行的追溯与整改动作。',
    '',
    '【硬性纪律，违反即为错误输出】',
    '1. 所有数字由工具计算并已在输入中给出。你禁止重新计算、禁止推断未给出的数字、禁止编造具体数值。',
    '2. 禁止对质检人员作出能力评价、优劣评定或排名；禁止给出「合格/不合格」结论；禁止建议把指标用于个人奖惩。',
    '3. 禁止设定通用及格线。除非输入中已给出警戒线，否则不得自行编造阈值。',
    '4. 分析必须落在「暴露问题 → 追溯根因 → 修订标准 / 补充培训 / 调整抽样」，不落在「评价人」。',
    '5. 不确定就说不确定。当置信区间跨越警戒线或样本量不足时，必须明确写「本次不作结论」，而不是给一个模糊判断。',
    '6. 区分「标准问题」与「人的问题」：只有掌握多人对比数据时才能下判断；数据不足时必须写「需进一步核对」。',
    '7. 全部输出使用中文。不得输出 JSON 以外的任何内容，不得使用 Markdown 代码围栏。',
    '',
    '【必须遵守的分析框架】',
    'A. 指标方向约定：正例 = 驳回（坏数据）；负例 = 通过（好数据）。',
    '   召回率 R = 坏数据中被拦下的比例（管「漏没漏」，关联不可逆风险）。',
    '   精确率 P = 驳回中被判对的比例（管「冤没冤」，分母是被驳回数）。',
    '   特异度 Spec = 好数据中被正确放行的比例（衡量误判只能用这个，不能用 P 代替，因 P 会被实际驳回率 π 稀释）。',
    '   准确率 Acc = (TP+TN)/N，在 π 偏离均衡时会被占优类别稀释，不能作主指标。',
    '   Fβ 的权重比是 β²：β=2 表示召回权重是精确率的 4 倍，不是 2 倍。',
    'B. 分析顺序固定为：结构层（π 是否正常、样本量是否支撑）→ 行为层（驳回倾向、错误结构）→ 可靠性层（区间宽度、空缺单元）。',
    '   不得越过结构层直接解读单指标数值。',
    'C. 信号与噪声：判断达标用置信区间而非点估计。区间下限已高于警戒线 = 达标；区间跨越警戒线 = 不确定，不作结论；区间上限已低于警戒线 = 确证问题。',
    'D. 警戒线的含义：由「基线 B（前三次实际驳回率的最高值）」与「容忍率 T = 1 − 需求方要求的验收准确率」推导 R_min = 1 − T/B；' +
    '   若 R_min ≤ 0 则退化为历史最差召回率。它只对召回率设置，因为漏判通常不可逆；精确率属返修成本，只在效率维度作相对比较。',
    'E. 观察线：各指标取前 k 次统计的中位数。连续两次低于观察线才提示纳入观察，单次低于不作为结论。',
    'F. 「误判」与「漏判」的改进方向不同：漏判偏多指向识别能力 / 标准理解 / 判定阈值偏松；误判偏多指向标准精度 / 判定尺度 / 个人过严。',
    '   两者绝不能混在一条建议里处理。',
    'G. 实际驳回率 π 是项目结构量，不是质检成绩。解读精确率之前必须先看 π；π 偏低时精确率天然偏低，不得读成个人能力问题。',
    '',
    '【输出格式】仅输出一个 JSON 对象，键名固定如下，全部值为中文字符串（数组元素也是字符串）：',
    '{',
    '  "summary": "一句话结论。若存在任何计算局限或样本不足，第一句必须先说明「本次数据的局限」再给结论。",',
    '  "reliability": "数据可信度评估：逐项说明哪些指标可信、哪些因样本量或区间过宽而不可信，并说明理由。",',
    '  "rootCause": {',
    '    "structure": "结构层判断：实际驳回率 π、样本量、抽样口径带来的影响。无问题则写「未发现结构性问题」并说明依据。",',
    '    "behavior": "行为层判断：驳回倾向（激进/保守）、错误结构（偏漏判还是偏误判），并给出你最可能的根因假设。",',
    '    "capability": "能力层判断：识别能力、标准理解、判定尺度上的可能不足。数据不足时必须写「需进一步核对」，不得猜测。"',
    '  },',
    '  "actions": [ { "priority": "P0|P1|P2", "action": "具体动作，必须可执行", "target": "责任角色，如质检组长 / 质量负责人 / 标注培训负责人", "due": "时限，如 24 小时内 / 本周内 / 下个评估周期", "basis": "依据是哪一条指标或哪一张诊断卡（写指标名 + 具体数值）" } ],',
    '  "standardSuggestion": "对判定标准本身的具体修订建议。若判断问题源于标准而非人，必须给出可写入标准的条文级建议；否则写「本次数据不足以支持标准修订建议」。",',
    '  "trainingSuggestion": "具体培训内容建议。若判断为个体识别能力问题，必须指出应针对哪一类错误做培训；否则写「本次数据不支持培训建议」。",',
    '  "followUp": ["后续应重点追踪的指标或现象，以及追踪时要注意的口径问题"],',
    '  "needsHuman": ["必须由人工确认或补充的信息，用于消除本次分析的不确定性"]',
    '}',
    '',
    '【质量要求】',
    '- summary 不超过 120 字；其余字段各自独立、不得互相重复。',
    '- actions 给出 3~6 条，按 P0 → P1 → P2 排序，每条都要有依据，禁止出现「加强管理」「提高认识」这类空话。',
    '- standardSuggestion 与 trainingSuggestion 至少有一条是实质性建议（除非数据确实不足）。',
    '- followUp 2~4 条，needsHuman 1~4 条。',
    '- 优先引用输入中「工具预判诊断」已给出的结论，并在此基础上补充解读；若你认为某条预判不成立，必须说明理由。',
    '- 总字数控制在 900 字以内。',
  ].join('\n');

  /* ---------------------------------------------------------------------------
   * 构造用户消息（事实清单，不含判断）
   * ------------------------------------------------------------------------ */

  function pct(v, d) { return C.fmtPct(v, d === undefined ? 2 : d); }
  function num(v, d) { return C.fmtNum(v, d === undefined ? 4 : d); }

  function buildUserPayload(ctx) {
    const m = ctx.metrics, w = ctx.warning, obs = ctx.observation, input = ctx.input;
    const L = [];

    L.push('===== 一、项目与本次评估 =====');
    L.push('项目名称：' + (ctx.projectName || '未命名'));
    L.push('评估周期：' + (input.periodLabel || '未填写'));
    if (input.inspector) L.push('质检人员：' + input.inspector + '（仅作记录，禁止据此评价其能力）');
    L.push('需求方要求的验收准确率：' + pct(w.acceptAccuracy, 0) + '（容忍率 T = ' + pct(w.toleranceT, 0) + '）');
    L.push('总体样本量：' + (input.populationTotal || '未填写'));
    L.push('本次抽样量：' + (input.sampleTotal || m.counts.N) + ' 条');

    L.push('');
    L.push('===== 二、混淆矩阵（正例 = 驳回，负例 = 通过）=====');
    L.push('TP 正确驳回 = ' + m.counts.TP);
    L.push('FP 误驳回 = ' + m.counts.FP);
    L.push('FN 错误通过（漏判）= ' + m.counts.FN);
    L.push('TN 正确通过 = ' + m.counts.TN);
    L.push('合计 N = ' + m.counts.N);

    if (ctx.effSS) {
      L.push('');
      L.push('===== 三、抽样设计 =====');
      L.push('抽样方式：分层抽样');
      ctx.effSS.strata.forEach((s) => {
        L.push('  层「' + s.name + '」：总体 ' + s.pop + ' 条，抽样 ' + s.sample + ' 条，抽样比 ' + pct(s.fpc, 1) + '，权重 ' + num(s.weight, 3));
      });
      L.push('原始样本量 = ' + ctx.effSS.nRaw + '；有效样本量（经典口径）≈ ' + Math.round(ctx.effSS.nEffClassic) +
        '；设计效应 = ' + num(ctx.effSS.designEffect, 3));
      if (ctx.effSS.anyOversampled) L.push('提示：存在抽样比超过 50% 的层（过采样），总体层面有效信息量会被折算。');
    } else {
      L.push('');
      L.push('===== 三、抽样设计 =====');
      L.push('抽样方式：简单随机抽样（未提供分层信息）');
    }

    L.push('');
    L.push('===== 四、指标与置信区间（全部已由工具计算，禁止重算）=====');
    L.push('指标\t点估计\t95%区间下限\t95%区间上限\t区间宽度\t区间下限判定');
    const rows = [
      ['准确率 Acc', m.accuracy, m.ci.accuracy],
      ['精确率 P', m.precision, m.ci.precision],
      ['召回率 R', m.recall, m.ci.recall],
      ['特异度 Spec', m.specificity, m.ci.specificity],
      ['负例预测值 NPV', m.npv, m.ci.npv],
      ['误判率 FPR = 1−Spec', m.fpr, null],
      ['漏判率 FNR = 1−R', m.fnr, null],
      ['F0.5', m.f05, ctx.bootstrap && ctx.bootstrap.result.f05],
      ['F1', m.f1, ctx.bootstrap && ctx.bootstrap.result.f1],
      ['F2', m.f2, ctx.bootstrap && ctx.bootstrap.result.f2],
    ];
    rows.forEach((r) => {
      const [name, point, ci] = r;
      if (ci && ci.lo !== null && ci.hi !== undefined) {
        L.push(name + '\t' + (point === null ? '不可计算' : pct(point)) + '\t' + pct(ci.lo) + '\t' + pct(ci.hi) + '\t' + pct(ci.hi - ci.lo) + '\t—');
      } else {
        L.push(name + '\t' + (point === null ? '不可计算' : pct(point)) + '\t—\t—\t—\t—');
      }
    });
    L.push('说明：比例型指标的置信区间为 Wilson 区间；F 族指标为参数 Bootstrap（B=' +
      (ctx.bootstrap ? ctx.bootstrap.B : '—') + '，分组为 P 与 R 的联合分布，不能套用比例公式）。');

    L.push('');
    L.push('===== 五、结构量（判断解读是否成立的前置条件）=====');
    L.push('实际应驳回率 π = (TP+FN)/N = ' + pct(m.piActual) + '　—— 项目结构量，非质检成绩');
    L.push('质检驳回率 τ = (TP+FP)/N = ' + pct(m.tauQc) + '　—— 行为倾向');
    L.push('净偏离 Δ = τ − π = ' + (m.delta === null ? '—' : (m.delta >= 0 ? '+' : '') + pct(m.delta)) +
      '（' + (m.delta === null ? '—' : m.delta > 0 ? '偏激进，多驳回' : m.delta < 0 ? '偏保守，少驳回' : '与标准一致') + '）');
    L.push('实际应驳回数 = ' + (m.counts.TP + m.counts.FN) + ' 条；质检驳回数 = ' + (m.counts.TP + m.counts.FP) + ' 条');

    L.push('');
    L.push('===== 六、警戒线推导（召回率下限）=====');
    L.push('基线 B = ' + pct(w.baselineB) + '（来源：' + w.baselineBasis + '）');
    L.push('容忍率 T = ' + pct(w.toleranceT) + '（= 1 − 验收准确率）');
    L.push('理论下限 1 − T/B = ' + (w.rMinRaw === null ? '—' : pct(w.rMinRaw)));
    if (w.fallbackToWorstRecall) L.push('触发退化分支：理论下限 ≤ 0，改用历史最差召回率 = ' + pct(w.worstRecallUsed));
    L.push('最终召回率下限 R_min = ' + (w.rMin === null ? '本次不设下限' : pct(w.rMin)));
    if (w.tolerableMissCount !== null) {
      L.push('可容忍漏判条数 = max(1, ' + w.tolerableMissBasis + ') = ' + w.tolerableMissCount + ' 条；本次实际漏判 ' + m.counts.FN + ' 条');
    }
    if (w.note) L.push('说明：' + w.note);
    L.push('注意：整份文档中只有召回率设置了绝对警戒线，因为漏判通常不可逆；精确率属返修成本，不设绝对线。');

    L.push('');
    L.push('===== 七、观察线与连续判定 =====');
    const observedKeys = [
      ['recall', '召回率 R'], ['precision', '精确率 P'], ['f1', 'F1'],
      ['accuracy', '准确率 Acc'], ['specificity', '特异度 Spec'],
    ];
    observedKeys.forEach(([k, label]) => {
      const o = obs[k];
      if (!o || o.value === null) { L.push(label + '：观察线不可用（历史不足）'); return; }
      const cur = m[k];
      const cmp = cur === null ? '不可计算' : cur >= o.value ? '高于观察线' : '低于观察线';
      L.push(label + '：观察线（前 ' + o.used + ' 次中位数）= ' + pct(o.value) + '，本次 = ' +
        (cur === null ? '—' : pct(cur)) + '，' + cmp + (o.sufficient ? '' : '【窗口不足，稳健性有限】'));
    });
    if (ctx.consecutive && ctx.consecutive.info) L.push('连续判定：' + ctx.consecutive.info);

    L.push('');
    L.push('===== 八、工具预判诊断（确定性结论，必须纳入你的分析）=====');
    if (ctx.diagnostics && ctx.diagnostics.length) {
      ctx.diagnostics.forEach((d, i) => {
        L.push('【' + (i + 1) + '】[' + d.level.toUpperCase() + '] ' + d.title);
        L.push('    说明：' + d.detail);
        if (d.evidence && d.evidence.length) L.push('    依据：' + d.evidence.join('；'));
      });
    } else {
      L.push('（本次未触发任何预判诊断）');
    }

    L.push('');
    L.push('===== 九、历史记录（最新在前，最多 5 次）=====');
    if (ctx.history && ctx.history.length) {
      L.push('周期\tπ\tτ\tP\tR\tF1\t漏判 FN\t误驳 FP');
      ctx.history.slice(0, 5).forEach((r) => {
        const mm = r.metrics || {};
        L.push([
          r.periodLabel || '—',
          mm.piActual === null || mm.piActual === undefined ? '—' : pct(mm.piActual, 1),
          mm.tauQc === null || mm.tauQc === undefined ? '—' : pct(mm.tauQc, 1),
          mm.precision === null || mm.precision === undefined ? '—' : pct(mm.precision, 1),
          mm.recall === null || mm.recall === undefined ? '—' : pct(mm.recall, 1),
          mm.f1 === null || mm.f1 === undefined ? '—' : pct(mm.f1, 1),
          r.counts ? r.counts.FN : '—',
          r.counts ? r.counts.FP : '—',
        ].join('\t'));
      });
    } else {
      L.push('（无历史记录，本次为首次评估）');
    }

    L.push('');
    L.push('===== 十、本次任务 =====');
    L.push('请按前述框架与 JSON 格式输出分析。重点回答：');
    L.push('1) 本次数据有哪些局限，哪些指标不可信、为什么；');
    L.push('2) 问题出在结构、行为还是能力，依据是什么；');
    L.push('3) 应当修订标准还是补充培训，给出条文级或题目级的具体建议；');
    L.push('4) 下一步该做什么、谁做、何时做；');
    L.push('5) 还需要人工补充哪些信息才能下定论。');
    L.push('再次强调：不得评价个人能力，不得给及格线，不得编造数字。');

    return L.join('\n');
  }

  /* ---------------------------------------------------------------------------
   * 调用 DeepSeek（浏览器直连，OpenAI 兼容格式）
   * ------------------------------------------------------------------------ */

  function extractJSON(text) {
    if (!text) throw new Error('模型返回内容为空。');
    let t = String(text).trim();
    // 容错：剥离可能的代码围栏
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 继续尝试截取 */ }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = t.slice(start, end + 1);
      try { return JSON.parse(slice); } catch (e2) {
        throw new Error('模型返回的 JSON 无法解析：' + e2.message);
      }
    }
    throw new Error('模型未返回可解析的 JSON。原始返回前 200 字：' + t.slice(0, 200));
  }

  /**
   * @param {object} ctx 与 buildUserPayload 相同的上下文
   * @param {object} opts { apiKey, model, apiBase, signal, temperature, onDelta }
   */
  async function analyze(ctx, opts) {
    opts = opts || {};
    const apiKey = (opts.apiKey || '').trim();
    if (!apiKey) throw new Error('未配置 API Key。请点击右上角「设置」填入后再试。');
    const base = (opts.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = opts.model || 'deepseek-flash';

    const body = {
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPayload(ctx) },
      ],
      temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
      max_tokens: 2600,
      response_format: { type: 'json_object' },
      stream: false,
    };

    const started = Date.now();
    let resp;
    try {
      resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      throw new Error('请求模型失败（网络或跨域问题）：' + e.message);
    }

    const elapsed = Date.now() - started;
    const text = await resp.text();
    if (!resp.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j.error && j.error.message) msg = j.error.message;
      } catch (e) { /* 保持原文 */ }
      throw new Error('模型接口返回 ' + resp.status + '：' + msg);
    }

    let payload;
    try { payload = JSON.parse(text); } catch (e) { throw new Error('接口返回不是合法 JSON。'); }
    const choice = payload.choices && payload.choices[0];
    if (!choice || !choice.message) throw new Error('接口返回缺少 choices[0].message。');
    const content = choice.message.content || '';

    return {
      raw: content,
      parsed: extractJSON(content),
      model: model,
      elapsedMs: elapsed,
      usage: payload.usage || null,
      promptPreview: buildUserPayload(ctx).length,
    };
  }

  /** 用最小请求验证 key 与模型是否可用 */
  async function testKey(apiKey, model, apiBase) {
    const base = (apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(apiKey).trim() },
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        max_tokens: 10,
        stream: false,
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j.error && j.error.message) msg = j.error.message; } catch (e) { /* noop */ }
      throw new Error('HTTP ' + resp.status + '：' + msg);
    }
    const j = JSON.parse(text);
    return {
      ok: true,
      model: j.model,
      reply: j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '',
    };
  }

  global.QCAI = {
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildUserPayload: buildUserPayload,
    analyze: analyze,
    testKey: testKey,
    extractJSON: extractJSON,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
