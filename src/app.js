/* =============================================================================
 * 质检人员质量评估工具 · 应用主逻辑
 * ========================================================================== */
(function () {
  'use strict';

  const C = window.QCCore;
  const S = window.QCStore;
  const D = window.QCDiag;
  const AI = window.QCAI;
  const CL = window.QCCloud;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const pct = (v, d) => C.fmtPct(v, d === undefined ? 1 : d);
  const num = (v, d) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(d === undefined ? 3 : d);

  /* ---------------- 指标行定义 ---------------- */
  // dir: 'up' 越大越好 / 'down' 越小越好 / 'neutral' 不做方向判定
  const ROWS = [
    { key: 'accuracy', label: '准确率 Acc', expr: '(TP+TN)/N', dir: 'up', ci: 'wilson', note: 'π 偏离均衡时被稀释' },
    { key: 'precision', label: '精确率 P', expr: 'TP/(TP+FP)', dir: 'up', ci: 'wilson', note: '分母 = 质检驳回数' },
    { key: 'recall', label: '召回率 R', expr: 'TP/(TP+FN)', dir: 'up', ci: 'wilson', note: '分母 = 实际应驳回数', key_: true },
    { key: 'specificity', label: '特异度 Spec', expr: 'TN/(TN+FP)', dir: 'up', ci: 'wilson', note: '衡量误判用这个' },
    { key: 'npv', label: '负例预测值 NPV', expr: 'TN/(TN+FN)', dir: 'up', ci: 'wilson', note: '放行里有多少真该放行' },
    { key: 'f05', label: 'F0.5', expr: '(1+0.25)PR/(0.25P+R)', dir: 'up', ci: 'boot', note: '偏向精确率' },
    { key: 'f1', label: 'F1', expr: '2PR/(P+R)', dir: 'up', ci: 'boot', note: '等权' },
    { key: 'f2', label: 'F2', expr: '(1+4)PR/(4P+R)', dir: 'up', ci: 'boot', note: '偏向召回率（权重 4 倍）' },
    { key: 'fpr', label: '误判率 FPR', expr: 'FP/(TN+FP)', dir: 'down', ci: 'derived', from: 'specificity', note: '= 1 − 特异度' },
    { key: 'fnr', label: '漏判率 FNR', expr: 'FN/(TP+FN)', dir: 'down', ci: 'derived', from: 'recall', note: '= 1 − 召回率' },
  ];

  const OBS_LABEL = {
    accuracy: '准确率', precision: '精确率', recall: '召回率',
    specificity: '特异度', npv: 'NPV', f05: 'F0.5', f1: 'F1', f2: 'F2', tauQc: '质检驳回率', piActual: '实际应驳回率',
  };

  const state = {
    tab: 'evaluate',
    result: null,
    aiResult: null,
    aiLoading: false,
    aiError: null,
    debugOpen: false,
    historyOpen: {},
  };

  /* ==========================================================================
   * 云端同步
   * ======================================================================== */
  function cloudSettings() { return S.getSettings(); }

  function cloudHooks() {
    return {
      ensureProject: (name, cloudId) => S.ensureProject(name, cloudId, null),
      mergeRecords: (projectId, records) => S.mergeRecords(projectId, records),
    };
  }

  /** 从云端拉取并合并到本地，然后刷新界面 */
  async function cloudPull(opts) {
    const settings = cloudSettings();
    if (!CL.isConfigured(settings)) return null;
    const quiet = opts && opts.quiet;
    try {
      if (!quiet) toast('正在拉取云端数据…');
      const stats = await CL.syncToLocal(settings, cloudHooks());
      renderProjectSelect();
      renderProjectAdmin();
      renderHistory();
      updateCloudStatus();
      if (!quiet) {
        toast('云端同步完成：' + stats.projects + ' 个项目、' + stats.records + ' 条记录'
          + (stats.added ? '（新增 ' + stats.added + '）' : ''), 'ok');
      }
      return stats;
    } catch (e) {
      if (!quiet) toast('云端拉取失败：' + e.message, 'err');
      updateCloudStatus(e.message);
      return null;
    }
  }

  function updateCloudStatus(errMsg) {
    const settings = cloudSettings();
    const el2 = $('cloudStatus');
    if (!el2) return;
    const mode = settings.cloudMode || 'dual';
    if (mode === 'local' || !CL.isConfigured(settings)) {
      el2.className = 'banner banner-info';
      el2.textContent = '当前为纯本地模式：数据只存在本机浏览器，不会同步到云端。如需多人共享，请在「设置」中配置云端。';
      el2.hidden = false;
      return;
    }
    if (errMsg) {
      el2.className = 'banner banner-alert';
      el2.textContent = '云端同步异常：' + errMsg;
      el2.hidden = false;
      return;
    }
    if (CL.isConnected(settings)) {
      const uid = CL.currentUserId();
      const modeText = mode === 'cloud' ? '仅云端' : '本地 + 云端双写';
      el2.className = 'banner banner-ok';
      el2.textContent = '云端已连接（' + modeText + '）　成员标识 ' + (uid ? uid.slice(0, 8) : '—')
        + '　提交者本人可修订与删除自己的记录。';
      el2.hidden = false;
      return;
    }
    el2.className = 'banner banner-warn';
    el2.textContent = '云端已配置但尚未连接，请到「设置」点「测试并连接」。';
    el2.hidden = false;
  }

  /** 保存时同步到云端 */
  async function cloudPushRecord(project, record) {
    const settings = cloudSettings();
    const mode = settings.cloudMode || 'dual';
    if (mode === 'local' || !CL.isConfigured(settings)) return null;
    try {
      const res = await CL.upsertRecord(settings, {
        projectName: project.name,
        periodLabel: record.periodLabel,
        inspector: record.input ? record.input.inspector : null,
        payload: {
          input: record.input,
          counts: record.counts,
          metrics: record.metrics,
          effSS: record.effSS,
          warning: record.warning,
          observation: record.observation,
          verdicts: record.verdicts,
          recallVerdict: record.recallVerdict,
          diagnostics: record.diagnostics,
          acceptAccuracy: record.acceptAccuracy,
          obsWindow: record.obsWindow,
          aiSummary: record.aiSummary,
          computedAt: record.computedAt,
        },
      });
      updateCloudStatus();
      return res;
    } catch (e) {
      updateCloudStatus(e.message);
      throw e;
    }
  }

  /* ==========================================================================
   * 提示
   * ======================================================================== */
  function toast(msg, kind) {
    const z = $('toastZone');
    const t = el('div', 'toast' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : ''), msg);
    z.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, kind === 'err' ? 6000 : 3200);
  }

  function banner(html, kind) {
    const z = $('bannerZone');
    z.innerHTML = '';
    if (!html) return;
    const b = el('div', 'banner banner-' + (kind || 'info'));
    b.innerHTML = html;
    z.appendChild(b);
  }

  /* ==========================================================================
   * 读取表单
   * ======================================================================== */
  function readNum(id) {
    const raw = $(id).value.trim();
    if (raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }
  function readInt(id) {
    const v = readNum(id);
    return v === null ? null : Math.round(v);
  }

  function readForm() {
    const cm = {
      TP: readInt('cmTP') || 0,
      FP: readInt('cmFP') || 0,
      FN: readInt('cmFN') || 0,
      TN: readInt('cmTN') || 0,
    };
    const strataPop = [readInt('strataPosPop'), readInt('strataNegPop')];
    const strataSample = [readInt('strataPosSample'), readInt('strataNegSample')];
    const strata = [];
    if (strataPop[0] && strataSample[0]) strata.push({ name: '驳回层', pop: strataPop[0], sample: strataSample[0] });
    if (strataPop[1] && strataSample[1]) strata.push({ name: '通过层', pop: strataPop[1], sample: strataSample[1] });

    return {
      periodLabel: $('periodLabel').value.trim(),
      inspector: $('inspector').value.trim(),
      populationTotal: readInt('populationTotal'),
      sampleTotal: readInt('sampleTotal'),
      cm: cm,
      strata: strata,
      acceptAccuracy: readNum('acceptAccuracy'),
      obsWindow: readInt('obsWindow'),
    };
  }

  function validate(input) {
    const errs = [];
    const warns = [];
    const cm = input.cm;
    const N = cm.TP + cm.FP + cm.FN + cm.TN;

    if (N <= 0) errs.push('混淆矩阵为空：请至少填入一个非零数值。');
    if (input.sampleTotal !== null && N > 0 && input.sampleTotal !== N) {
      warns.push('混淆矩阵合计 ' + N + ' 条，与填写的抽样量 ' + input.sampleTotal + ' 条不一致。将以混淆矩阵合计 ' + N + ' 条为准。');
    }
    if (input.populationTotal !== null && N > 0 && input.populationTotal < N) {
      warns.push('总体样本量 ' + input.populationTotal + ' 小于抽样量 ' + N + '，请核对。');
    }
    if (input.acceptAccuracy !== null && (input.acceptAccuracy <= 0.5 || input.acceptAccuracy >= 1)) {
      errs.push('验收准确率应在 0.5 ~ 1 之间（不含端点）。');
    }
    if (input.strata.length) {
      const sumSample = input.strata.reduce((a, s) => a + s.sample, 0);
      if (sumSample !== N) {
        warns.push('分层抽样数合计 ' + sumSample + ' 条，与混淆矩阵合计 ' + N + ' 条不一致；有效样本量仅供参考。');
      }
      input.strata.forEach((s) => {
        if (s.sample > s.pop) errs.push('「' + s.name + '」的抽样数大于总体数，请核对。');
      });
    }
    if (cm.TP + cm.FN === 0) warns.push('实际应驳回数为 0：召回率不可计算，且预警线不适用。');
    if (cm.TP + cm.FP === 0) warns.push('质检驳回数为 0：精确率与 F 族不可计算（0/0 不报数值）。');
    return { errs: errs, warns: warns, N: N };
  }

  /* ==========================================================================
   * 计算
   * ======================================================================== */
  function compute(input) {
    const settings = S.getSettings();
    const project = S.getProject(S.getCurrentProjectId());

    const cm = input.cm;
    const metrics = C.computeMetrics(cm);
    const effSS = input.strata.length ? C.effectiveSampleSize(input.strata) : null;

    const bootstrap = C.bootstrapF(cm, {
      B: settings.bootstrapB || 4000,
      alpha: settings.alpha || 0.05,
      seed: 20240617,
    });

    const history = project ? S.getHistory(project.id) : [];
    const historyPi = history.map((r) => r.metrics && r.metrics.piActual).filter((v) => Number.isFinite(v));
    const historyRecall = history.map((r) => r.metrics && r.metrics.recall).filter((v) => Number.isFinite(v));

    const acceptAcc = input.acceptAccuracy !== null ? input.acceptAccuracy
      : (project && project.config && project.config.acceptAccuracy) || settings.acceptAccuracy || 0.95;

    const warning = C.computeWarningLine({
      historyPi: historyPi,
      historyRecall: historyRecall,
      acceptAccuracy: acceptAcc,
      piCurrent: metrics.piActual,
      actualPositiveCount: cm.TP + cm.FN,
    });

    const obsWindow = input.obsWindow !== null ? input.obsWindow
      : (project && project.config && project.config.obsWindow) || settings.obsWindow || 3;
    const observation = C.computeObservationLines(history, obsWindow);

    /* ---- 判定：警戒线（仅召回率） ---- */
    const recallVerdict = C.verdict(metrics.recall, metrics.ci.recall, warning.rMin, 'up');

    /* ---- 判定：观察线（三态） ---- */
    const verdicts = {};
    for (const row of ROWS) {
      const line = observation[row.key] ? observation[row.key].value : null;
      verdicts[row.key] = {
        obsLine: line,
        obsUsed: observation[row.key] ? observation[row.key].used : 0,
        obsSufficient: observation[row.key] ? observation[row.key].sufficient : false,
        obsBreach: null,
        warnLine: row.key === 'recall' ? warning.rMin : null,
        warnState: null,
      };
      if (line !== null && row.dir !== 'neutral') {
        const series = [{ metrics: metrics }].concat(history);
        verdicts[row.key].obsBreach = C.consecutiveBreach(series, row.key, line, row.dir, settings.tolerancePct || 0);
      }
    }

    /* ---- 连续低于观察线的汇总（取优先级最高的一个用于诊断卡） ---- */
    let consecutive = null;
    const priority = ['recall', 'precision', 'f1', 'specificity', 'accuracy'];
    for (const k of priority) {
      const v = verdicts[k];
      if (v && v.obsBreach && v.obsBreach.breach) {
        consecutive = {
          key: k,
          label: OBS_LABEL[k] || k,
          breach: true,
          count: v.obsBreach.count,
          line: v.obsBreach.line,
          window: v.obsUsed,
          sufficient: v.obsSufficient,
        };
        break;
      }
    }
    const breachSummary = priority
      .filter((k) => verdicts[k] && verdicts[k].obsBreach && verdicts[k].obsBreach.breach)
      .map((k) => (OBS_LABEL[k] || k) + ' ' + verdicts[k].obsBreach.count + ' 次');

    const ctx = {
      metrics: metrics,
      warning: warning,
      observation: observation,
      input: input,
      projectName: project ? project.name : '',
      history: history,
      settings: settings,
      bootstrap: bootstrap,
      effSS: effSS,
      consecutive: consecutive,
    };
    const diagnostics = D.run(ctx);
    ctx.diagnostics = diagnostics;
    if (breachSummary.length) {
      consecutive = consecutive || {};
      consecutive.info = '连续低于观察线的指标：' + breachSummary.join('；');
    }

    return {
      input: input,
      counts: metrics.counts,
      metrics: metrics,
      bootstrap: bootstrap,
      effSS: effSS,
      warning: warning,
      observation: observation,
      verdicts: verdicts,
      recallVerdict: recallVerdict,
      diagnostics: diagnostics,
      consecutive: consecutive,
      acceptAccuracy: acceptAcc,
      obsWindow: obsWindow,
      ctx: ctx,
      computedAt: Date.now(),
    };
  }

  /* ==========================================================================
   * 渲染：结果区
   * ======================================================================== */
  function renderResult() {
    const zone = $('resultZone');
    zone.innerHTML = '';
    const r = state.result;

    if (!r) {
      const ph = el('div', 'card placeholder');
      ph.appendChild(el('h2', null, '还没有结果'));
      ph.appendChild(el('p', null, '左侧填入抽样量与混淆矩阵后点击「计算」。工具会自动完成：'));
      const ul = el('ul', 'plain');
      ['指标点估计 + 95% 置信区间（比例型用 Wilson，F 族用参数 Bootstrap）',
        '召回率警戒线推导（基线 B → 容忍率 T → R_min → 可容忍漏判条数）',
        '各指标观察线（前 k 次中位数）与连续偏离提示',
        '结构层 / 行为层 / 可靠性层三层预判诊断',
        'AI 辅助的根因分析与动作建议（需先在「设置」中配置 API Key）',
      ].forEach((t) => ul.appendChild(el('li', null, t)));
      ph.appendChild(ul);
      zone.appendChild(ph);
      return;
    }

    const m = r.metrics;

    /* --- 统计条 --- */
    const strip = el('div', 'stat-strip');
    const stats = [
      { k: '实际应驳回率 π', v: pct(m.piActual, 2), s: '结构量，非成绩', key: true },
      { k: '质检驳回率 τ', v: pct(m.tauQc, 2), s: '行为倾向' },
      { k: '净偏离 Δ', v: (m.delta === null ? '—' : (m.delta >= 0 ? '+' : '') + pct(m.delta, 2)), s: 'τ − π' },
      { k: '样本量 N', v: String(m.counts.N), s: '混淆矩阵合计' },
      { k: '实际应驳回数', v: String(m.counts.TP + m.counts.FN), s: 'R 的分母' },
      { k: '质检驳回数', v: String(m.counts.TP + m.counts.FP), s: 'P 的分母' },
    ];
    if (r.effSS) {
      stats.push({ k: '有效样本量', v: String(Math.round(r.effSS.nEffClassic)), s: '原始 ' + r.effSS.nRaw + ' 条' });
    }
    stats.forEach((s) => {
      const d = el('div', 'stat' + (s.key ? ' is-key' : ''));
      d.appendChild(el('span', 'stat-label', s.k));
      d.appendChild(el('div', 'stat-value', s.v));
      if (s.s) d.appendChild(el('span', 'stat-sub', s.s));
      strip.appendChild(d);
    });
    zone.appendChild(strip);

    /* --- 指标矩阵 --- */
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.appendChild(el('h2', null, '指标与置信区间矩阵'));
    const headRight = el('div', 'head-actions');
    headRight.appendChild(el('span', 'hint tiny',
      '区间 ' + Math.round((1 - (r.bootstrap.alpha || 0.05)) * 100) + '%　Bootstrap B=' + r.bootstrap.B));
    head.appendChild(headRight);
    card.appendChild(head);

    const wrap = el('div', 'tbl-wrap');
    const tbl = el('table', 'tbl');
    const thead = el('thead');
    const htr = el('tr');
    [['指标', ''], ['公式', ''], ['点估计', 'num'], ['区间下限', 'num'], ['区间上限', 'num'],
      ['区间宽度', 'num'], ['观察线', 'num'], ['警戒线', 'num'], ['判定', '']]
      .forEach(([t, cls]) => htr.appendChild(el('th', cls || null, t)));
    thead.appendChild(htr);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    for (const row of ROWS) {
      const point = m[row.key];
      const tr = el('tr');

      // 区间
      let lo = null, hi = null;
      if (row.ci === 'wilson') {
        const ci = m.ci[row.key];
        if (ci) { lo = ci.lo; hi = ci.hi; }
      } else if (row.ci === 'boot') {
        const b = r.bootstrap.result[row.key];
        if (b) { lo = b.lo; hi = b.hi; }
      } else if (row.ci === 'derived' && row.from) {
        const src = row.from === 'specificity' ? m.ci.specificity : m.ci.recall;
        if (src && src.lo !== null) { lo = 1 - src.hi; hi = 1 - src.lo; }
      }

      const v = r.verdicts[row.key];

      // 行底色：警戒线（仅召回率）优先，其次观察线连续偏离
      let rowCls = '';
      if (row.key === 'recall' && r.recallVerdict.state === 'fail') rowCls = 'row-alert';
      else if (row.key === 'recall' && r.recallVerdict.state === 'unclear') rowCls = 'row-warn';
      else if (v.obsBreach && v.obsBreach.breach) rowCls = 'row-warn';
      if (rowCls) tr.className = rowCls;

      tr.appendChild(el('td', null, row.label));
      tr.appendChild(el('td', 'muted', row.expr));
      tr.appendChild(el('td', 'num', point === null ? '不可计算' : pct(point, 2)));
      tr.appendChild(el('td', 'num', lo === null ? '—' : pct(lo, 2)));
      tr.appendChild(el('td', 'num', hi === null ? '—' : pct(hi, 2)));
      tr.appendChild(el('td', 'num', lo === null ? '—' : pct(hi - lo, 2)));
      tr.appendChild(el('td', 'num', v.obsLine === null ? '—' : pct(v.obsLine, 2)));
      tr.appendChild(el('td', 'num', v.warnLine === null ? '—' : pct(v.warnLine, 2)));

      const tdV = el('td');
      let badge = null, label = '';
      if (row.key === 'recall' && r.recallVerdict.state !== 'no-line') {
        const s = r.recallVerdict;
        if (s.state === 'pass') { badge = 'ok'; label = '达标'; }
        else if (s.state === 'fail') { badge = 'alert'; label = '确证不足'; }
        else if (s.state === 'unclear') { badge = 'warn'; label = '不确定'; }
        else { badge = 'na'; label = '不可计算'; }
      } else if (v.obsBreach && v.obsBreach.line !== undefined && v.obsLine !== null) {
        if (v.obsBreach.breach) { badge = 'warn'; label = '连续 ' + v.obsBreach.count + ' 次低于'; }
        else if (point !== null) { badge = 'ok'; label = '在观察线内'; }
      } else if (point !== null) {
        badge = 'na'; label = '无判定线';
      } else {
        badge = 'na'; label = '不可计算';
      }
      tdV.appendChild(el('span', 'badge badge-' + badge, label));
      tr.appendChild(tdV);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    card.appendChild(wrap);

    const notes = el('p', 'hint');
    notes.textContent = '说明：误判率 FPR 与漏判率 FNR 由特异度、召回率的区间换算得出。'
      + '准确率的区间在分层抽样改变类别构成时不代表总体；精确率与召回率为比值，加权前后取值相同。';
    card.appendChild(notes);
    zone.appendChild(card);

    /* --- 警戒线推导 --- */
    zone.appendChild(renderWarningCard(r));

    /* --- 诊断卡 --- */
    zone.appendChild(renderDiagCard(r));

    /* --- AI --- */
    zone.appendChild(renderAICard(r));
  }

  function renderWarningCard(r) {
    const w = r.warning;
    const card = el('div', 'card');
    card.appendChild(el('h2', null, '召回率警戒线推导'));

    const chain = el('div', 'chain');
    const step = (label, value, final) => {
      const s = el('div', 'chain-step' + (final ? ' is-final' : ''));
      s.appendChild(el('span', null, label + ' '));
      s.appendChild(el('b', null, value));
      return s;
    };
    const arrow = () => chain.appendChild(el('span', 'chain-arrow', '→'));

    chain.appendChild(step('基线 B', w.baselineB === null ? '—' : pct(w.baselineB, 2)));
    arrow();
    chain.appendChild(step('容忍率 T', pct(w.toleranceT, 2)));
    arrow();
    chain.appendChild(step('1 − T/B', w.rMinRaw === null ? '—' : pct(w.rMinRaw, 2)));
    arrow();
    chain.appendChild(step('R_min', w.rMin === null ? '不设下限' : pct(w.rMin, 2), true));
    card.appendChild(chain);

    const list = el('ul', 'plain');
    list.appendChild(el('li', null, '基线来源：' + w.baselineBasis + (w.historyUsed ? '（使用 ' + w.historyUsed + ' 次历史）' : '')));
    if (w.fallbackToWorstRecall) {
      list.appendChild(el('li', null, '触发退化分支：理论下限 ≤ 0，改用历史最差召回率 ' + pct(w.worstRecallUsed, 2)));
    }
    if (w.tolerableMissCount !== null) {
      list.appendChild(el('li', null, '可容忍漏判条数 = max(1, ' + w.tolerableMissBasis + ') = '
        + w.tolerableMissCount + ' 条；本次实际漏判 ' + r.counts.FN + ' 条'));
    }
    card.appendChild(list);

    if (w.note) {
      const p = el('p', 'hint', w.note);
      card.appendChild(p);
    }

    const v = r.recallVerdict;
    const verdict = el('p');
    verdict.appendChild(el('span', 'badge badge-' + (v.state === 'pass' ? 'ok' : v.state === 'fail' ? 'alert' : v.state === 'unclear' ? 'warn' : 'na'),
      v.state === 'pass' ? '达标' : v.state === 'fail' ? '确证不足' : v.state === 'unclear' ? '不确定' : '未设线'));
    verdict.appendChild(document.createTextNode('  ' + v.label
      + '　本次 R = ' + pct(r.metrics.recall, 2)
      + '，区间 [' + pct(r.metrics.ci.recall.lo, 2) + ', ' + pct(r.metrics.ci.recall.hi, 2) + ']'));
    card.appendChild(verdict);

    card.appendChild(el('p', 'hint',
      '只对召回率设绝对警戒线：漏判通常不可逆（坏数据流向训练或下游决策）；'
      + '精确率属返修成本，只在效率维度作相对比较，不设绝对线。'));
    return card;
  }

  function renderDiagCard(r) {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.appendChild(el('h2', null, '预判诊断（结构层 → 行为层 → 可靠性层）'));
    const counts = { alert: 0, warn: 0, info: 0, ok: 0 };
    r.diagnostics.forEach((d) => { counts[d.level] = (counts[d.level] || 0) + 1; });
    head.appendChild(el('span', 'hint tiny',
      '严重 ' + counts.alert + '　提示 ' + counts.warn + '　说明 ' + counts.info + (counts.ok ? '　正常 ' + counts.ok : '')));
    card.appendChild(head);

    if (!r.diagnostics.length) {
      card.appendChild(el('p', 'hint', '本次未触发任何预判诊断。'));
      return card;
    }

    const list = el('div', 'diag-list');
    r.diagnostics.forEach((d) => {
      const item = el('div', 'diag ' + d.level);
      item.appendChild(el('div', 'diag-title', d.title));
      item.appendChild(el('div', 'diag-detail', d.detail));
      if (d.evidence && d.evidence.length) {
        const ul = el('ul', 'diag-evidence');
        d.evidence.forEach((e) => ul.appendChild(el('li', null, e)));
        item.appendChild(ul);
      }
      if (d.actions && d.actions.length) {
        const ul = el('ul', 'diag-actions');
        d.actions.forEach((a) => ul.appendChild(el('li', null, a)));
        item.appendChild(ul);
      }
      list.appendChild(item);
    });
    card.appendChild(list);
    return card;
  }

  /* ==========================================================================
   * AI 区渲染
   * ======================================================================== */
  function renderAICard(r) {
    const card = el('div', 'card');
    const head = el('div', 'ai-head');
    head.appendChild(el('h2', null, 'AI 辅助分析'));
    const settings = S.getSettings();
    const btn = el('button', 'btn btn-primary btn-mini', state.aiLoading ? '分析中…' : (state.aiResult ? '重新分析' : '生成分析'));
    btn.id = 'btnRunAI';
    btn.disabled = state.aiLoading;
    btn.type = 'button';
    head.appendChild(btn);

    const st = el('span', 'ai-status');
    const proxyUi = !!(settings.aiProxyUrl && settings.aiProxyUrl.trim());
    if (state.aiLoading) {
      const sp = el('span', 'spinner');
      st.appendChild(sp);
      st.appendChild(document.createTextNode(' 正在请求 ' + (settings.model || 'deepseek-flash')
        + (proxyUi ? '（经服务端代理）' : '') + ' …'));
    } else if (!proxyUi && !settings.apiKey) {
      st.textContent = '未配置 AI 调用方式：请联系管理员配置代理地址，或在「设置」中填入 API Key。';
    } else if (state.aiResult) {
      const r = state.aiResult;
      const bits = ['模型 ' + r.model,
        r.viaProxy ? '服务端代理' : '本机 Key 直连',
        '耗时 ' + (r.elapsedMs / 1000).toFixed(1) + ' s',
        '预算 ' + r.maxTokens];
      if (r.reasoningTokens !== null && r.reasoningTokens !== undefined) bits.push('思维链 ' + r.reasoningTokens + ' token');
      if (r.usage && r.usage.total_tokens) bits.push('总 token ' + r.usage.total_tokens);
      if (r.retried) bits.push('已因截断重试一次');
      st.textContent = bits.join('　');
      if (r.truncated) {
        st.appendChild(document.createTextNode('　'));
        st.appendChild(el('span', 'badge badge-alert', '输出被截断，内容可能不完整'));
      } else if (r.repaired) {
        st.appendChild(document.createTextNode('　'));
        st.appendChild(el('span', 'badge badge-warn', 'JSON 已修复'));
      }
    } else if (state.aiError) {
      st.textContent = '上次调用失败：' + state.aiError;
    } else if (proxyUi) {
      // 已启用代理但本次还没分析：必须明确标注「服务端代理」，否则用户以为没配置
      st.textContent = '模型 ' + (settings.model || 'deepseek-flash')
        + '　经服务端代理调用（API Key 不在浏览器里）　将依据上方指标与诊断卡生成根因分析与动作建议。';
    } else {
      st.textContent = '模型 ' + (settings.model || 'deepseek-flash') + '　将依据上方指标与诊断卡生成根因分析与动作建议。';
    }
    head.appendChild(st);
    card.appendChild(head);

    if (state.aiResult && state.aiResult.parsed) {
      card.appendChild(renderAIOutput(state.aiResult.parsed, state.aiResult));
    } else if (!state.aiResult) {
      const ul = el('ul', 'plain');
      ['分析顺序固定为：可信度判断 → 结构/行为/能力三层根因 → 动作建议 → 需人工确认项',
        '模型被禁止重算数字、禁止给出及格线、禁止评价个人能力或给出排名结论',
        '每条动作建议都必须标注优先级、责任角色、时限与依据指标',
      ].forEach((t) => ul.appendChild(el('li', null, t)));
      card.appendChild(ul);
    }
    return card;
  }

  function renderAIOutput(d, full) {
    const out = el('div', 'ai-out');

    const block = (title, content) => {
      if (!content) return null;
      const b = el('div', 'ai-block');
      b.appendChild(el('h4', null, title));
      b.appendChild(el('div', null, content));
      return b;
    };

    const b1 = block('结论（先看数据局限）', d.summary);
    if (b1) out.appendChild(b1);
    const b2 = block('可信度评估', d.reliability);
    if (b2) out.appendChild(b2);

    if (d.rootCause) {
      const rc = el('div', 'ai-block');
      rc.appendChild(el('h4', null, '三层根因'));
      [['结构层', d.rootCause.structure], ['行为层', d.rootCause.behavior], ['能力层', d.rootCause.capability]]
        .forEach(([t, c]) => {
          if (!c) return;
          const p = el('p');
          const strong = el('strong', null, t + '：');
          p.appendChild(strong);
          p.appendChild(document.createTextNode(' ' + c));
          rc.appendChild(p);
        });
      out.appendChild(rc);
    }

    if (Array.isArray(d.actions) && d.actions.length) {
      const ac = el('div', 'ai-block');
      ac.appendChild(el('h4', null, '动作建议'));
      const list = el('div', 'ai-actions');
      d.actions.forEach((a) => {
        const item = el('div', 'ai-action');
        const h = el('div', 'ai-action-head');
        const pr = String(a.priority || '').toUpperCase();
        h.appendChild(el('span', 'badge badge-' + (pr === 'P0' ? 'alert' : pr === 'P1' ? 'warn' : 'info'), pr || '—'));
        h.appendChild(el('span', null, a.action || ''));
        item.appendChild(h);
        const meta = el('div', 'ai-meta');
        meta.textContent = [a.target ? '责任：' + a.target : '', a.due ? '时限：' + a.due : ''].filter(Boolean).join('　');
        if (meta.textContent) item.appendChild(meta);
        if (a.basis) item.appendChild(el('div', 'ai-basis', '依据：' + a.basis));
        list.appendChild(item);
      });
      ac.appendChild(list);
      out.appendChild(ac);
    }

    const b3 = block('标准修订建议', d.standardSuggestion);
    if (b3) out.appendChild(b3);
    const b4 = block('培训建议', d.trainingSuggestion);
    if (b4) out.appendChild(b4);

    if (Array.isArray(d.followUp) && d.followUp.length) {
      const f = el('div', 'ai-block');
      f.appendChild(el('h4', null, '后续追踪'));
      const ul = el('ul', 'plain');
      d.followUp.forEach((x) => ul.appendChild(el('li', null, x)));
      f.appendChild(ul);
      out.appendChild(f);
    }
    if (Array.isArray(d.needsHuman) && d.needsHuman.length) {
      const f = el('div', 'ai-block');
      f.appendChild(el('h4', null, '需人工确认'));
      const ul = el('ul', 'plain');
      d.needsHuman.forEach((x) => ul.appendChild(el('li', null, x)));
      f.appendChild(ul);
      out.appendChild(f);
    }

    // 原始 JSON 折叠区（便于复核）
    const det = el('details');
    det.appendChild(el('summary', 'hint', '查看模型原始返回 JSON'));
    const raw = el('div', 'ai-raw');
    raw.textContent = JSON.stringify(d, null, 2);
    det.appendChild(raw);
    out.appendChild(det);

    if (full && full.promptPreview) {
      const det2 = el('details');
      det2.appendChild(el('summary', 'hint', '查看发给模型的完整提示词（可用于复核是否存在误导性输入）'));
      const pre = el('div', 'ai-raw');
      pre.textContent = '=== 系统提示词 ===\n' + AI.SYSTEM_PROMPT + '\n\n=== 用户消息 ===\n' + state.lastPrompt;
      det2.appendChild(pre);
      out.appendChild(det2);
    }
    return out;
  }

  /* ==========================================================================
   * 历史视图
   * ======================================================================== */
  function renderHistory() {
    const project = S.getProject(S.getCurrentProjectId());
    $('historyProjectName').textContent = project ? project.name : '（未选择项目）';
    const zone = $('historyZone');
    zone.innerHTML = '';

    if (!project) {
      zone.appendChild(el('p', 'hint', '请先新建一个项目。'));
      return;
    }
    const records = project.records || [];
    if (!records.length) {
      zone.appendChild(el('p', 'hint', '本项目还没有历史记录。在「评估」页计算后点击「保存为记录」即可。'));
      return;
    }

    zone.appendChild(renderChart(records));

    const wrap = el('div', 'tbl-wrap');
    const tbl = el('table', 'tbl tbl-sm');
    const thead = el('thead');
    const htr = el('tr');
    [['', ''], ['周期', ''], ['质检人员', ''], ['π', 'num'], ['τ', 'num'], ['P', 'num'], ['R', 'num'],
      ['特异度', 'num'], ['F1', 'num'], ['FN', 'num'], ['FP', 'num'], ['R 的 95% 区间', 'num'], ['操作', '']]
      .forEach(([t, cls]) => htr.appendChild(el('th', cls || null, t)));
    thead.appendChild(htr);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    records.forEach((rec) => {
      const mm = rec.metrics || {};
      const ciR = mm.ci && mm.ci.recall;
      const tr = el('tr');

      const tdExp = el('td', 'expandable');
      const open = !!state.historyOpen[rec.id];
      tdExp.appendChild(el('span', 'chev', open ? '▼' : '▶'));
      tdExp.addEventListener('click', () => {
        state.historyOpen[rec.id] = !state.historyOpen[rec.id];
        renderHistory();
      });
      tr.appendChild(tdExp);

      tr.appendChild(el('td', null, rec.periodLabel || '—'));
      const inspCell = el('td');
      inspCell.appendChild(document.createTextNode((rec.input && rec.input.inspector) || '—'));
      if (rec.cloudId) {
        const mine = rec.cloudSubmitter && rec.cloudSubmitter === CL.currentUserId();
        const tag = el('span', 'badge ' + (mine ? 'badge-info' : 'badge-na'), mine ? '本人' : '他人');
        tag.style.marginLeft = '6px';
        tag.title = mine ? '你提交的记录，可修订与删除' : '其他成员提交，你只能查看';
        inspCell.appendChild(tag);
      }
      tr.appendChild(inspCell);
      tr.appendChild(el('td', 'num', pct(mm.piActual, 2)));
      tr.appendChild(el('td', 'num', pct(mm.tauQc, 2)));
      tr.appendChild(el('td', 'num', pct(mm.precision, 2)));
      tr.appendChild(el('td', 'num', pct(mm.recall, 2)));
      tr.appendChild(el('td', 'num', pct(mm.specificity, 2)));
      tr.appendChild(el('td', 'num', pct(mm.f1, 2)));
      tr.appendChild(el('td', 'num', rec.counts ? rec.counts.FN : '—'));
      tr.appendChild(el('td', 'num', rec.counts ? rec.counts.FP : '—'));
      tr.appendChild(el('td', 'num', ciR && ciR.lo !== null ? '[' + pct(ciR.lo, 1) + ', ' + pct(ciR.hi, 1) + ']' : '—'));

      const tdOp = el('td');
      const btnLoad = el('button', 'btn btn-mini btn-ghost', '载入');
      btnLoad.type = 'button';
      btnLoad.addEventListener('click', () => loadRecord(rec));
      tdOp.appendChild(btnLoad);
      const btnDel = el('button', 'btn btn-mini btn-ghost btn-danger', '删除');
      btnDel.type = 'button';
      btnDel.addEventListener('click', async () => {
        const settings = S.getSettings();
        const onCloud = (settings.cloudMode || 'dual') !== 'local' && CL.isConfigured(settings);
        const mine = rec.cloudSubmitter && rec.cloudSubmitter === CL.currentUserId();
        if (onCloud && rec.cloudId && !mine) {
          toast('该记录由其他成员提交，你只能删除自己提交的记录。', 'err');
          return;
        }
        if (!window.confirm('删除周期「' + (rec.periodLabel || '未命名') + '」的记录？'
          + (onCloud && rec.cloudId ? '（云端与本机同时删除）' : ''))) return;
        S.deleteRecord(project.id, rec.id);
        renderHistory();
        renderProjectSelect();
        toast('已从本机删除', 'ok');
        if (onCloud && rec.cloudId) {
          try {
            await CL.deleteRecord(settings, rec.cloudId);
            toast('已从云端删除', 'ok');
          } catch (e) {
            toast('云端删除失败：' + e.message, 'err');
            updateCloudStatus(e.message);
          }
        }
      });
      tdOp.appendChild(btnDel);
      tr.appendChild(tdOp);
      tbody.appendChild(tr);

      if (open) {
        const tr2 = el('tr');
        const td2 = el('td');
        td2.colSpan = 13;
        const box = el('div');
        box.style.padding = '8px 4px';
        const cm = rec.counts || {};
        box.appendChild(el('div', 'hint tiny',
          '混淆矩阵：TP=' + cm.TP + '　FP=' + cm.FP + '　FN=' + cm.FN + '　TN=' + cm.TN
          + '　|　验收准确率要求=' + pct(rec.acceptAccuracy, 0)
          + '　|　R_min=' + (rec.warning && rec.warning.rMin !== null ? pct(rec.warning.rMin, 1) : '未设')
          + '　|　可容忍漏判=' + (rec.warning && rec.warning.tolerableMissCount !== null ? rec.warning.tolerableMissCount + ' 条' : '—')
          + '　|　保存于 ' + new Date(rec.savedAt).toLocaleString('zh-CN')));
        if (rec.diagnostics && rec.diagnostics.length) {
          const ul = el('ul', 'diag-actions');
          rec.diagnostics.slice(0, 4).forEach((d) => ul.appendChild(el('li', null, '[' + d.level + '] ' + d.title)));
          box.appendChild(ul);
        }
        td2.appendChild(box);
        tr2.appendChild(td2);
        tbody.appendChild(tr2);
      }
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    zone.appendChild(wrap);
  }

  function renderChart(records) {
    const box = el('div', 'chart-wrap');
    const asc = records.slice().reverse(); // 时间正序
    const labels = asc.map((r) => r.periodLabel || '');
    const series = [
      { key: 'recall', name: '召回率 R', color: '#2f6f6b' },
      { key: 'precision', name: '精确率 P', color: '#3a6ea5' },
      { key: 'f1', name: 'F1', color: '#a8700f' },
      { key: 'accuracy', name: '准确率 Acc', color: '#8b939c' },
    ];

    const W = Math.min(1100, box.clientWidth || 900);
    const H = 240;
    const padL = 44, padR = 14, padT = 14, padB = 30;
    const cw = W - padL - padR, ch = H - padT - padB;

    const canvas = el('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);

    // 值域：只画 0~1，但若所有值都在高位则放大到 [min-0.1, 1]
    let vals = [];
    series.forEach((s) => asc.forEach((r) => {
      const v = r.metrics ? r.metrics[s.key] : null;
      if (Number.isFinite(v)) vals.push(v);
    }));
    if (!vals.length) {
      box.appendChild(el('p', 'hint', '暂无可绘制的指标数据。'));
      box.appendChild(canvas);
      return box;
    }
    let lo = Math.min.apply(null, vals);
    let hi = Math.max.apply(null, vals);
    lo = Math.max(0, Math.floor((lo - 0.05) * 10) / 10);
    hi = Math.min(1, Math.ceil((hi + 0.05) * 10) / 10);
    if (hi - lo < 0.1) { lo = Math.max(0, lo - 0.05); hi = Math.min(1, hi + 0.05); }

    const X = (i) => padL + (asc.length === 1 ? cw / 2 : (cw * i) / (asc.length - 1));
    const Y = (v) => padT + ch - ((v - lo) / (hi - lo)) * ch;

    // 网格
    g.strokeStyle = '#e3e6ea';
    g.fillStyle = '#8b939c';
    g.font = '10px ui-monospace, monospace';
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const y = Y(v);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.fillText((v * 100).toFixed(0) + '%', 6, y + 3);
    }

    // x 轴标签
    g.textAlign = 'center';
    asc.forEach((r, i) => {
      if (asc.length > 8 && i % 2 === 1) return;
      g.fillText(String(labels[i]).slice(0, 8), X(i), H - 10);
    });
    g.textAlign = 'left';

    // 线
    series.forEach((s) => {
      g.strokeStyle = s.color;
      g.lineWidth = 1.8;
      g.beginPath();
      let started = false;
      asc.forEach((r, i) => {
        const v = r.metrics ? r.metrics[s.key] : null;
        if (!Number.isFinite(v)) { started = false; return; }
        if (!started) { g.moveTo(X(i), Y(v)); started = true; }
        else g.lineTo(X(i), Y(v));
      });
      g.stroke();
      // 点
      g.fillStyle = s.color;
      asc.forEach((r, i) => {
        const v = r.metrics ? r.metrics[s.key] : null;
        if (!Number.isFinite(v)) return;
        g.beginPath(); g.arc(X(i), Y(v), 2.6, 0, Math.PI * 2); g.fill();
      });
    });

    // 召回率警戒线（虚线）
    const rmin = asc.length && asc[asc.length - 1].warning ? asc[asc.length - 1].warning.rMin : null;
    if (rmin !== null && rmin !== undefined && rmin >= lo && rmin <= hi) {
      g.strokeStyle = '#b03a37';
      g.setLineDash([5, 4]);
      g.lineWidth = 1.4;
      const y = Y(rmin);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#b03a37';
      g.fillText('R_min ' + (rmin * 100).toFixed(1) + '%', padL + 4, y - 4);
    }

    box.appendChild(canvas);
    const lg = el('div', 'legend');
    series.forEach((s) => {
      const item = el('span');
      const i = el('i');
      i.style.background = s.color;
      item.appendChild(i);
      item.appendChild(document.createTextNode(s.name));
      lg.appendChild(item);
    });
    const rl = el('span');
    const ri = el('i');
    ri.style.background = '#b03a37';
    ri.style.height = '0';
    ri.style.borderTop = '2px dashed #b03a37';
    rl.appendChild(ri);
    rl.appendChild(document.createTextNode('召回率警戒线'));
    lg.appendChild(rl);
    box.appendChild(lg);
    return box;
  }

  /* ==========================================================================
   * 保存 / 载入
   * ======================================================================== */
  function saveRecord() {
    const r = state.result;
    if (!r) return;
    const project = S.getProject(S.getCurrentProjectId());
    if (!project) { toast('请先选择或新建项目。', 'err'); return; }

    let period = r.input.periodLabel;
    const samePeriod = project.records.some((x) => x.periodLabel && x.periodLabel === period);
    if (samePeriod && period) {
      const ok = window.confirm('周期「' + period + '」已存在记录。是否覆盖该周期的记录？');
      if (!ok) return;
    }
    if (!period) {
      period = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      r.input.periodLabel = period;
      $('periodLabel').value = period;
    }

    const rec = {
      periodLabel: period,
      input: r.input,
      counts: r.counts,
      metrics: {
        accuracy: r.metrics.accuracy, precision: r.metrics.precision, recall: r.metrics.recall,
        specificity: r.metrics.specificity, npv: r.metrics.npv, fpr: r.metrics.fpr, fnr: r.metrics.fnr,
        f05: r.metrics.f05, f1: r.metrics.f1, f2: r.metrics.f2,
        piActual: r.metrics.piActual, tauQc: r.metrics.tauQc, delta: r.metrics.delta,
        ci: {
          recall: r.metrics.ci.recall, precision: r.metrics.ci.precision,
          accuracy: r.metrics.ci.accuracy, specificity: r.metrics.ci.specificity,
        },
        boot: { f1: r.bootstrap.result.f1, f2: r.bootstrap.result.f2, f05: r.bootstrap.result.f05 },
      },
      effSS: r.effSS ? {
        nRaw: r.effSS.nRaw, nEffClassic: r.effSS.nEffClassic, designEffect: r.effSS.designEffect,
      } : null,
      warning: {
        baselineB: r.warning.baselineB, toleranceT: r.warning.toleranceT, rMin: r.warning.rMin,
        rMinRaw: r.warning.rMinRaw, fallbackToWorstRecall: r.warning.fallbackToWorstRecall,
        tolerableMissCount: r.warning.tolerableMissCount, baselineBasis: r.warning.baselineBasis,
      },
      observation: (function () {
        const o = {};
        Object.keys(r.observation).forEach((k) => {
          o[k] = { value: r.observation[k].value, used: r.observation[k].used, window: r.observation[k].window };
        });
        return o;
      })(),
      verdicts: (function () {
        const v = {};
        Object.keys(r.verdicts).forEach((k) => {
          v[k] = { obsLine: r.verdicts[k].obsLine, warnLine: r.verdicts[k].warnLine };
        });
        return v;
      })(),
      recallVerdict: r.recallVerdict,
      diagnostics: r.diagnostics.map((d) => ({ level: d.level, title: d.title, detail: d.detail })),
      acceptAccuracy: r.acceptAccuracy,
      obsWindow: r.obsWindow,
      aiSummary: state.aiResult && state.aiResult.parsed ? state.aiResult.parsed.summary : null,
      computedAt: r.computedAt,
    };

    try {
      S.addRecord(project.id, rec, true);
      renderProjectSelect();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }

    // 云端写入（失败不回滚本地，只提示，避免网络问题导致数据丢失）
    const mode = cloudSettings().cloudMode || 'dual';
    if (mode !== 'local' && CL.isConfigured(cloudSettings())) {
      toast('已保存到本机，正在同步云端…');
      cloudPushRecord(project, rec).then((res) => {
        if (res) {
          toast('已同步到云端：周期「' + period + '」' + (res.revision > 1 ? '（第 ' + res.revision + ' 版）' : ''), 'ok');
          // 回填云端标识，便于后续判定改删权限
          if (res.id) S.setCloudMeta(project.id, period, res.id, CL.currentUserId());
        }
      }).catch((e) => {
        toast('云端同步失败（本机已保存）：' + e.message, 'err');
      });
    } else {
      toast('已保存记录：周期「' + period + '」（本机）', 'ok');
    }
  }

  function loadRecord(rec) {
    const inp = rec.input || {};
    $('periodLabel').value = inp.periodLabel || '';
    $('inspector').value = inp.inspector || '';
    $('populationTotal').value = inp.populationTotal === null || inp.populationTotal === undefined ? '' : inp.populationTotal;
    $('sampleTotal').value = inp.sampleTotal === null || inp.sampleTotal === undefined ? '' : inp.sampleTotal;
    const cm = rec.counts || {};
    $('cmTP').value = cm.TP === undefined ? '' : cm.TP;
    $('cmFP').value = cm.FP === undefined ? '' : cm.FP;
    $('cmFN').value = cm.FN === undefined ? '' : cm.FN;
    $('cmTN').value = cm.TN === undefined ? '' : cm.TN;
    if (inp.strata && inp.strata.length) {
      const pos = inp.strata.find((s) => s.name === '驳回层');
      const neg = inp.strata.find((s) => s.name === '通过层');
      if (pos) { $('strataPosPop').value = pos.pop; $('strataPosSample').value = pos.sample; }
      if (neg) { $('strataNegPop').value = neg.pop; $('strataNegSample').value = neg.sample; }
    }
    if (rec.acceptAccuracy !== null && rec.acceptAccuracy !== undefined) $('acceptAccuracy').value = rec.acceptAccuracy;
    if (rec.obsWindow) $('obsWindow').value = rec.obsWindow;
    updateCmSum();
    switchTab('evaluate');
    runCalc();
    toast('已载入周期「' + (rec.periodLabel || '—') + '」的数据（可修改后重新计算）', 'ok');
  }

  /* ==========================================================================
   * 项目选择与数据管理
   * ======================================================================== */
  function renderProjectSelect() {
    const sel = $('projectSelect');
    const list = S.listProjects();
    const cur = S.getCurrentProjectId();
    sel.innerHTML = '';
    if (!list.length) {
      const o = el('option', null, '（暂无项目）');
      o.value = '';
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      list.forEach((p) => {
        const o = el('option', null, p.name + '（' + p.recordCount + ' 次）');
        o.value = p.id;
        if (p.id === cur) o.selected = true;
        sel.appendChild(o);
      });
      // 主动持久化「当前项目」，避免仅依赖用户手动切换：
      // 否则刷新后当前项目会退化为列表首项（顺序由更新时间决定），用户会莫名被切换项目。
      if (cur && localStorage.getItem('qceval:current') !== cur) {
        S.setCurrentProjectId(cur);
      }
    }
    $('storageNote').textContent = S.isPersistent()
      ? '存储 ' + (S.storageSize() / 1024).toFixed(1) + ' KB · 本机'
      : '⚠ 存储不可用（仅内存）';
  }

  function renderProjectAdmin() {
    const zone = $('projectAdminZone');
    zone.innerHTML = '';
    const list = S.listProjects();
    if (!list.length) { zone.appendChild(el('p', 'hint', '暂无项目。')); return; }
    list.forEach((p) => {
      const row = el('div', 'admin-row');
      const left = el('div');
      left.appendChild(el('div', null, p.name));
      left.appendChild(el('div', 'admin-meta', p.recordCount + ' 次记录'
        + (p.lastDate ? '　最近：' + p.lastDate : '')
        + '　创建于 ' + new Date(p.createdAt).toLocaleDateString('zh-CN')));
      row.appendChild(left);
      const right = el('div', 'row-inline');
      const bRename = el('button', 'btn btn-mini btn-ghost', '重命名');
      bRename.type = 'button';
      bRename.addEventListener('click', () => {
        const name = window.prompt('新的项目名称：', p.name);
        if (name === null) return;
        try { S.updateProject(p.id, { name: name }); toast('已重命名', 'ok'); renderProjectAdmin(); renderProjectSelect(); }
        catch (e) { toast(e.message, 'err'); }
      });
      const bDel = el('button', 'btn btn-mini btn-ghost btn-danger', '删除');
      bDel.type = 'button';
      bDel.addEventListener('click', async () => {
        if (!window.confirm('删除项目「' + p.name + '」及其 ' + p.recordCount + ' 次记录？此操作不可恢复。')) return;
        // 先取出云端标识，再删除本地项目
        const beforeDel = S.getProject(p.id);
        const cloudId = (beforeDel && beforeDel.cloudId) || null;
        S.deleteProject(p.id);
        renderProjectAdmin();
        renderProjectSelect();
        renderHistory();
        toast('已从本机删除项目', 'ok');
        // 云端：仅当该项目下没有他人记录时才允许删除
        const settings = S.getSettings();
        if ((settings.cloudMode || 'dual') !== 'local' && CL.isConfigured(settings) && cloudId) {
          try {
            await CL.deleteProject(settings, cloudId);
            toast('已从云端删除项目', 'ok');
          } catch (e) {
            toast('云端删除失败：' + e.message, 'err');
            updateCloudStatus(e.message);
          }
        }
      });
      right.appendChild(bRename);
      right.appendChild(bDel);
      row.appendChild(right);
      zone.appendChild(row);
    });
    $('sizeNote').textContent = '当前占用 ' + (S.storageSize() / 1024).toFixed(1) + ' KB。';
  }

  /* ==========================================================================
   * 计算与保存
   * ======================================================================== */
  function updateCmSum() {
    const cm = {
      TP: readInt('cmTP') || 0, FP: readInt('cmFP') || 0,
      FN: readInt('cmFN') || 0, TN: readInt('cmTN') || 0,
    };
    const N = cm.TP + cm.FP + cm.FN + cm.TN;
    const sample = readInt('sampleTotal');
    const note = $('cmSumNote');
    note.className = 'cm-sum';
    if (N === 0) { note.textContent = '合计 0 条'; return; }
    let txt = '合计 ' + N + ' 条';
    if (sample !== null) {
      if (sample === N) { txt += '　✓ 与填写的抽样量一致'; note.classList.add('is-ok'); }
      else { txt += '　⚠ 与填写的抽样量 ' + sample + ' 条不一致'; note.classList.add('is-bad'); }
    } else {
      txt += '　（未填写抽样量，将以本合计为准）';
    }
    note.textContent = txt;
  }

  function runCalc() {
    const input = readForm();
    const v = validate(input);
    $('calcHint').textContent = '';

    if (v.errs.length) {
      banner(v.errs.map((e) => '· ' + e).join('<br>'), 'alert');
      toast(v.errs[0], 'err');
      return;
    }
    if (v.warns.length) banner(v.warns.map((e) => '· ' + e).join('<br>'), 'warn');
    else banner('');

    let r;
    try {
      r = compute(input);
    } catch (e) {
      toast('计算失败：' + e.message, 'err');
      return;
    }
    state.result = r;
    state.aiResult = null;
    state.aiError = null;
    state.lastPrompt = r.ctx ? AI.buildUserPayload(r.ctx) : '';
    $('btnSave').disabled = false;
    renderResult();
    const proj = S.getProject(S.getCurrentProjectId());
    if (proj) {
      const patch = { config: { acceptAccuracy: input.acceptAccuracy === null ? proj.config.acceptAccuracy : input.acceptAccuracy, obsWindow: input.obsWindow === null ? proj.config.obsWindow : input.obsWindow } };
      try { S.updateProject(proj.id, patch); } catch (e) { /* 忽略 */ }
    }
  }

  async function runAI() {
    if (!state.result) { toast('请先计算。', 'err'); return; }
    const settings = S.getSettings();
    const useProxy = !!(settings.aiProxyUrl && settings.aiProxyUrl.trim());
    if (!useProxy && !settings.apiKey) {
      toast('未配置 AI 调用方式：请让管理员配置代理地址，或在「设置」中填入 API Key。', 'err');
      openSettings();
      return;
    }
    state.aiLoading = true;
    state.aiError = null;
    renderResult();
    try {
      const ctx = state.result.ctx;
      state.lastPrompt = AI.buildUserPayload(ctx);
      const res = await AI.analyze(ctx, {
        proxyUrl: settings.aiProxyUrl,
        accessCode: settings.cloudCode,
        sessionToken: CL.sessionToken ? CL.sessionToken() : null,
        apiKey: settings.apiKey,
        model: settings.model,
        apiBase: settings.apiBase,
        maxTokens: settings.maxTokens || 16000,
      });
      state.aiResult = res;
      if (res.truncated) {
        toast('注意：模型输出达到长度上限，已尽力修复 JSON，内容可能不完整。可在「设置」中调高 max_tokens。', 'err');
      } else if (res.repaired) {
        toast('模型返回的 JSON 存在残缺，已自动修复后展示。', 'err');
      } else {
        toast('分析已生成' + (res.viaProxy ? '（经服务端代理）' : ''), 'ok');
      }
    } catch (e) {
      state.aiError = e.message;
      toast('AI 分析失败：' + e.message, 'err');
    } finally {
      state.aiLoading = false;
      renderResult();
    }
  }

  /* ==========================================================================
   * 页签
   * ======================================================================== */
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.panel-view').forEach((v) => {
      v.classList.toggle('is-active', v.id === 'view-' + tab);
    });
    if (tab === 'history') renderHistory();
  }

  /* ==========================================================================
   * 设置与数据弹窗
   * ======================================================================== */
  /* ==========================================================================
   * 设置面板
   *   设计原则：界面上不出现、也不允许修改任何凭据（云端 URL / anon key /
   *   访问码 / AI Key）。这些一律由部署配置（config.js）提供，程序内部读取。
   *   这样既避免成员误改导致全员不可用，也避免凭据出现在页面 DOM 里。
   * ======================================================================== */

  /** 只显示「能安全公开」的部署信息：项目 ref 与各项是否已配置 */
  function renderDeployInfo() {
    const box = $('deployInfo');
    if (!box) return;
    const s = S.getSettings();
    box.innerHTML = '';

    const row = (label, value, okFlag) => {
      const d = el('div', 'admin-row');
      const left = el('div');
      left.appendChild(el('div', null, label));
      if (value) left.appendChild(el('div', 'admin-meta', value));
      d.appendChild(left);
      d.appendChild(el('span', 'badge ' + (okFlag ? 'badge-ok' : 'badge-na'), okFlag ? '已配置' : '未配置'));
      box.appendChild(d);
    };

    // 从 URL 里只取项目 ref（公开信息），不显示完整地址与密钥。
    // Supabase 的项目 ref 是 20 位小写字母数字，不含连字符；
    // 但也兼容带连字符的自定义域名（此时仅显示域名前缀，仍不含密钥）。
    const url = String(s.cloudUrl || '');
    const strictRef = url.match(/^https?:\/\/([a-z0-9]{15,})\.supabase\.co/i);
    const hostMatch = url.match(/^https?:\/\/([a-z0-9.\-]+)/i);
    const refLabel = strictRef ? strictRef[1]
      : (hostMatch ? hostMatch[1].split('.')[0] + '（自定义域名）' : '');
    row('云端项目', refLabel ? 'ref：' + refLabel : '未配置云端地址', !!url && !!refLabel);
    row('访问码', '已由部署方配置，不在界面显示', !!s.cloudCode);
    row('anon key', '已由部署方配置，不在界面显示', !!s.cloudKey);
    row('AI 调用方式',
      s.aiProxyUrl ? '经服务端代理（密钥不在浏览器中）'
        : (s.apiKey ? '本机 API Key 直连' : '未配置'),
      !!(s.aiProxyUrl || s.apiKey));
    row('模型', s.model || '—', !!s.model);
  }

  function openSettings() {
    const s = S.getSettings();
    if ($('setModel')) $('setModel').value = s.model || 'deepseek-flash';
    if ($('setBootstrapB')) $('setBootstrapB').value = s.bootstrapB || 4000;
    if ($('setAlpha')) $('setAlpha').value = String(s.alpha || 0.05);
    if ($('setMaxTokens')) $('setMaxTokens').value = s.maxTokens || 16000;
    if ($('setCloudMode')) $('setCloudMode').value = s.cloudMode || 'dual';
    if ($('cloudTestResult')) $('cloudTestResult').textContent = '';
    renderDeployInfo();
    applyDeploymentLock();
    $('settingsMask').hidden = false;
  }
  function closeSettings() { $('settingsMask').hidden = true; }

  /** 由部署方指定的项：禁用并标注来源，防止成员误改 */
  function applyDeploymentLock() {
    const lock = (id, key) => {
      const n = $(id);
      if (!n) return;
      const locked = S.isLocked(key);
      n.disabled = locked;
      const span = n.parentElement ? n.parentElement.querySelector('span') : null;
      if (!span) return;
      if (locked && !span.querySelector('.lock-tag')) {
        span.appendChild(el('em', 'lock-tag', '（由部署方统一配置）'));
      } else if (!locked) {
        const t = span.querySelector('.lock-tag');
        if (t) t.remove();
      }
    };
    lock('setCloudMode', 'cloudMode');
    lock('setModel', 'model');
  }

  /** 保存设置（界面上只剩非凭据项） */
  function saveSettingsFromForm(opts) {
    const quiet = opts && opts.quiet;
    const patch = {};
    if ($('setModel')) patch.model = $('setModel').value;
    if ($('setBootstrapB')) patch.bootstrapB = Number($('setBootstrapB').value) || 4000;
    if ($('setAlpha')) patch.alpha = Number($('setAlpha').value) || 0.05;
    if ($('setMaxTokens')) patch.maxTokens = Number($('setMaxTokens').value) || 16000;
    if ($('setCloudMode')) patch.cloudMode = $('setCloudMode').value;
    S.saveSettings(patch);
    if (!quiet) toast('设置已保存', 'ok');
    if (!quiet) closeSettings();
    if (state.result) renderResult();
    updateCloudStatus();
  }
  function closeSettings() { $('settingsMask').hidden = true; }

  function openData() { renderProjectAdmin(); $('dataMask').hidden = false; }
  function closeData() { $('dataMask').hidden = true; }

  function doExportAll() {
    const payload = S.exportAll();
    download(JSON.stringify(payload, null, 2),
      'qc-eval-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    toast('已导出全部数据（含设置，请注意其中包含 API Key）', 'ok');
  }

  function doExportProject() {
    const id = S.getCurrentProjectId();
    if (!id) { toast('没有可导出的项目。', 'err'); return; }
    const p = S.getProject(id);
    download(JSON.stringify(S.exportProject(id), null, 2), 'qc-eval-' + safeName(p.name) + '.json');
    toast('已导出项目「' + p.name + '」', 'ok');
  }

  function safeName(n) { return String(n).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ==========================================================================
   * 示例数据
   * ======================================================================== */
  function fillSample() {
    $('periodLabel').value = '2026-W07';
    $('inspector').value = '示例（请替换）';
    $('populationTotal').value = 100000;
    $('sampleTotal').value = 1000;
    $('cmTP').value = 72;
    $('cmFP').value = 26;
    $('cmFN').value = 8;
    $('cmTN').value = 894;
    $('strataPosPop').value = '';
    $('strataPosSample').value = '';
    $('strataNegPop').value = '';
    $('strataNegSample').value = '';
    $('acceptAccuracy').value = '0.95';
    $('obsWindow').value = '3';
    updateCmSum();
    toast('已填入示例数据（实际驳回率约 8%，可直接点「计算」）', 'ok');
  }

  /* ==========================================================================
   * 事件绑定
   * ======================================================================== */
  function bind() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    $('projectSelect').addEventListener('change', (e) => {
      S.setCurrentProjectId(e.target.value);
      state.result = null;
      state.aiResult = null;
      renderResult();
      const p = S.getProject(e.target.value);
      if (p && p.config) {
        if (p.config.acceptAccuracy) $('acceptAccuracy').value = p.config.acceptAccuracy;
        if (p.config.obsWindow) $('obsWindow').value = p.config.obsWindow;
      }
      banner('');
      toast('已切换到项目「' + (p ? p.name : '') + '」', 'ok');
      // 切换项目时静默拉取一次，保证看到的是云端最新数据
      const st = S.getSettings();
      if ((st.cloudMode || 'dual') !== 'local' && CL.isConfigured(st)) cloudPull({ quiet: true });
    });

    $('btnNewProject').addEventListener('click', () => {
      const name = window.prompt('新项目名称（用于分组保存历史数据）：');
      if (name === null) return;
      try {
        const p = S.createProject(name, {
          acceptAccuracy: readNum('acceptAccuracy') || 0.95,
          obsWindow: readInt('obsWindow') || 3,
        });
        renderProjectSelect();
        state.result = null;
        state.aiResult = null;
        renderResult();
        toast('已创建项目「' + p.name + '」', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    ['cmTP', 'cmFP', 'cmFN', 'cmTN', 'sampleTotal'].forEach((id) => {
      $(id).addEventListener('input', updateCmSum);
    });

    $('btnCalc').addEventListener('click', runCalc);
    $('btnSave').addEventListener('click', saveRecord);
    $('btnSample').addEventListener('click', fillSample);

    $('btnReset').addEventListener('click', () => {
      ['periodLabel', 'inspector', 'populationTotal', 'sampleTotal', 'cmTP', 'cmFP', 'cmFN', 'cmTN',
        'strataPosPop', 'strataPosSample', 'strataNegPop', 'strataNegSample'].forEach((id) => { $(id).value = ''; });
      updateCmSum();
      state.result = null;
      state.aiResult = null;
      $('btnSave').disabled = true;
      banner('');
      renderResult();
    });

    $('btnSettings').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', closeSettings);
    $('btnSettingsCancel').addEventListener('click', closeSettings);
    $('btnSettingsSave').addEventListener('click', saveSettingsFromForm);

    /* ---------- 云端 ----------
     * 凭据全部来自部署配置（config.js），界面上没有输入框，
     * 因此这里只负责「连接」这个动作本身。 */
    $('btnCloudConnect').addEventListener('click', async () => {
      const out = $('cloudTestResult');
      const st = S.getSettings();
      if (!CL.isConfigured(st)) {
        out.textContent = '✗ 云端未配置：请联系管理员在 config.js 中填写云端地址、密钥与访问码。';
        return;
      }
      out.textContent = '连接中…';
      try {
        const r = await CL.connect(st);
        out.textContent = '✓ 已连接（成员标识 ' + (r.userId ? r.userId.slice(0, 8) : '—') + '）';
        updateCloudStatus();
        await cloudPull({ quiet: true });
        toast('云端已连接，数据已拉取', 'ok');
      } catch (e) {
        out.textContent = '✗ ' + e.message;
        updateCloudStatus(e.message);
      }
    });

    $('btnCloudPull').addEventListener('click', () => { cloudPull(); });

    $('btnCloudDisconnect').addEventListener('click', () => {
      if (!window.confirm('断开云端？本机已保存的数据不受影响，之后不再同步到云端。')) return;
      CL.disconnect();
      S.saveSettings({ cloudMode: 'local' });
      if ($('setCloudMode')) $('setCloudMode').value = 'local';
      $('cloudTestResult').textContent = '已断开。若要再次启用，请把同步方式改回「双写」并重新连接。';
      updateCloudStatus();
      toast('已断开云端，当前为纯本地模式', 'ok');
    });

    $('btnData').addEventListener('click', openData);
    $('btnCloseData').addEventListener('click', closeData);
    $('btnDataClose').addEventListener('click', closeData);
    $('btnExportAll').addEventListener('click', doExportAll);
    $('btnExportProject').addEventListener('click', doExportProject);

    $('btnImport').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const payload = JSON.parse(text);
        const mode = window.confirm(
          '导入方式：\n\n【确定】= 合并（同名项目按周期去重后追加，推荐）\n【取消】= 覆盖（清空本机现有数据后导入）'
        ) ? 'merge' : 'replace';
        const res = S.importAll(payload, mode);
        toast('导入完成：' + res.projects + ' 个新项目，' + res.records + ' 条记录', 'ok');
        renderProjectSelect();
        renderProjectAdmin();
        renderHistory();
      } catch (err) {
        toast('导入失败：' + err.message, 'err');
      } finally {
        e.target.value = '';
      }
    });

    $('btnClearHistory').addEventListener('click', () => {
      const id = S.getCurrentProjectId();
      if (!id) return;
      const p = S.getProject(id);
      if (!window.confirm('清空项目「' + p.name + '」的全部 ' + p.records.length + ' 条记录？此操作不可恢复。')) return;
      S.clearRecords(id);
      toast('已清空记录', 'ok');
      renderHistory();
      renderProjectSelect();
    });

    // 弹窗遮罩点击关闭
    $('settingsMask').addEventListener('click', (e) => { if (e.target === $('settingsMask')) closeSettings(); });
    $('dataMask').addEventListener('click', (e) => { if (e.target === $('dataMask')) closeData(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSettings(); closeData(); }
    });

    // AI 按钮用事件委托（结果区每次重绘）
    $('resultZone').addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.id === 'btnRunAI') runAI();
    });
  }

  /* ==========================================================================
   * 启动
   * ======================================================================== */
  function init() {
    bind();
    renderProjectSelect();

    const proj = S.getProject(S.getCurrentProjectId());
    if (!proj) {
      banner('还没有项目。点击顶部「新建项目」创建一个（项目名用于分组保存历史数据与计算观察线），或先点左侧「填入示例」体验。', 'info');
    } else if (proj.config) {
      if (proj.config.acceptAccuracy) $('acceptAccuracy').value = proj.config.acceptAccuracy;
      $('obsWindow').value = proj.config.obsWindow || 3;
    }
    if (!S.isPersistent()) {
      banner('⚠ 当前浏览器禁用了本地存储，数据只保存在内存中，刷新页面会丢失。请改用「数据 → 导出」备份。', 'alert');
    }
    updateCmSum();
    renderResult();
    renderHistory();
    updateCloudStatus();

    // 已配置云端则启动时自动拉取一次（静默，失败只提示不打断）
    const settings = S.getSettings();
    if ((settings.cloudMode || 'dual') !== 'local' && CL.isConfigured(settings)) {
      cloudPull({ quiet: true }).then(() => renderProjectSelect());
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
