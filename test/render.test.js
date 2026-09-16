/* =============================================================================
 * 渲染验证：布局、溢出、画布像素、颜色对比
 * 不依赖人眼——用 DOM 几何、计算样式与画布像素做程序化断言
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8793;
const CDP_PORT = 9335;
const USER_DATA = path.join(ROOT, 'test', '.chrome-render');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()', returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function waitDevtools(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (e) { /* 等待 */ }
    await sleep(300);
  }
  throw new Error('DevTools 未就绪');
}

/* 相对亮度 → 对比度（WCAG） */
function luminance(rgb) {
  const c = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  const server = await startServer();
  if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + USER_DATA,
    '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitDevtools(30000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page') || (await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank')).json());
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
    await sleep(2200);

    console.log('=== 1. 宽屏布局（1500px）===');
    const layout = await cdp.eval(`
      const grid = document.querySelector('.grid');
      const cs = getComputedStyle(grid);
      const inputCol = document.querySelector('.col-input').getBoundingClientRect();
      const resultCol = document.querySelector('.col-result').getBoundingClientRect();
      return {
        display: cs.display,
        cols: cs.gridTemplateColumns,
        inputW: Math.round(inputCol.width),
        resultW: Math.round(resultCol.width),
        inputLeft: Math.round(inputCol.left),
        resultLeft: Math.round(resultCol.left),
        docScrollW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      };
    `);
    ok(layout.display === 'grid', '结果区使用 grid 布局', layout.display);
    ok(layout.resultLeft > layout.inputLeft, '结果列在输入列右侧', layout.resultLeft + ' vs ' + layout.inputLeft);
    ok(layout.inputW >= 380 && layout.inputW <= 420, '输入列宽约 400px', String(layout.inputW));
    ok(layout.resultW > 700, '结果列宽充足', String(layout.resultW));
    ok(layout.docScrollW <= layout.winW + 1, '无横向溢出', layout.docScrollW + ' vs ' + layout.winW);

    console.log('\n=== 2. 窄屏布局（820px）应变为单列 ===');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrow = await cdp.eval(`
      const cs = getComputedStyle(document.querySelector('.grid'));
      const i = document.querySelector('.col-input').getBoundingClientRect();
      const r = document.querySelector('.col-result').getBoundingClientRect();
      return { cols: cs.gridTemplateColumns, sameRow: Math.abs(i.top - r.top) < 5,
               docScrollW: document.documentElement.scrollWidth, winW: window.innerWidth };
    `);
    ok(narrow.sameRow === false, '窄屏下两列改为纵向堆叠', 'top 差=' + (narrow.sameRow ? '同行' : '分列'));
    ok(narrow.docScrollW <= narrow.winW + 1, '窄屏无横向溢出', narrow.docScrollW + ' vs ' + narrow.winW);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(300);

    console.log('\n=== 3. 计算后内容渲染 ===');
    await cdp.eval(`window.prompt = () => '渲染验证'; document.getElementById('btnNewProject').click(); return 1;`);
    await sleep(250);
    await cdp.eval(`document.getElementById('btnSample').click(); document.getElementById('btnCalc').click(); return 1;`);
    await sleep(800);

    const content = await cdp.eval(`
      const zone = document.getElementById('resultZone');
      const stats = Array.from(zone.querySelectorAll('.stat')).map(s => ({
        label: s.querySelector('.stat-label').textContent.trim(),
        value: s.querySelector('.stat-value').textContent.trim(),
        w: Math.round(s.getBoundingClientRect().width),
      }));
      const rows = Array.from(zone.querySelectorAll('.tbl tbody tr'));
      const overflowCells = [];
      zone.querySelectorAll('.tbl td').forEach(td => {
        if (td.scrollWidth > td.clientWidth + 2) overflowCells.push(td.textContent.trim().slice(0, 24));
      });
      const diagItems = zone.querySelectorAll('.diag').length;
      const chainSteps = zone.querySelectorAll('.chain-step').length;
      const aiBlock = !!document.getElementById('btnRunAI');
      const badges = Array.from(zone.querySelectorAll('.badge')).map(b => b.textContent.trim());
      return { stats, rowCount: rows.length, overflowCells, diagItems, chainSteps, aiBlock, badges };
    `);
    ok(content.stats.length >= 6, '统计条至少 6 项', String(content.stats.length));
    ok(content.stats.every((s) => s.w >= 100), '统计卡宽度无挤压', JSON.stringify(content.stats.map((s) => s.w)));
    ok(content.stats.every((s) => s.value && s.value !== 'null' && s.value !== 'undefined' && s.value !== 'NaN'),
      '统计值无 null/undefined/NaN', JSON.stringify(content.stats.map((s) => s.value)));
    ok(content.rowCount === 10, '指标矩阵 10 行', String(content.rowCount));
    ok(content.overflowCells.length === 0, '表格单元格无文字溢出', content.overflowCells.join(' | '));
    ok(content.diagItems > 0, '诊断卡已渲染', String(content.diagItems));
    ok(content.chainSteps === 4, '警戒线推导链 4 步', String(content.chainSteps));
    ok(content.aiBlock === true, 'AI 按钮已渲染');
    ok(content.badges.every((b) => b && b !== 'undefined'), '判定徽章文字正常', content.badges.slice(0, 5).join(','));

    const statLabels = content.stats.map((s) => s.label).join(' | ');
    console.log('  统计条：' + statLabels);

    console.log('\n=== 4. 表格数值与内核交叉核对 ===');
    const cross = await cdp.eval(`
      const m = window.QCCore.computeMetrics({TP:72,FP:26,FN:8,TN:894});
      const rows = {};
      document.querySelectorAll('#resultZone .tbl tbody tr').forEach(tr => {
        const c = Array.from(tr.children).map(td => td.textContent.trim());
        rows[c[0]] = { point: c[2], lo: c[3], hi: c[4], width: c[5], obs: c[6], warn: c[7], verdict: c[8] };
      });
      return { rows, core: { p: m.precision, r: m.recall, spec: m.specificity, acc: m.accuracy, pi: m.piActual } };
    `);
    const fmt = (v) => (v * 100).toFixed(2) + '%';
    ok(cross.rows['召回率 R'].point === fmt(cross.core.r), '召回率渲染 = 内核计算', cross.rows['召回率 R'].point);
    ok(cross.rows['精确率 P'].point === fmt(cross.core.p), '精确率渲染 = 内核计算', cross.rows['精确率 P'].point);
    ok(cross.rows['特异度 Spec'].point === fmt(cross.core.spec), '特异度渲染 = 内核计算');
    ok(cross.rows['准确率 Acc'].point === fmt(cross.core.acc), '准确率渲染 = 内核计算');
    ok(cross.rows['误判率 FPR'].point === fmt(1 - cross.core.spec), 'FPR 渲染 = 1 − 特异度');
    ok(cross.rows['漏判率 FNR'].point === fmt(1 - cross.core.r), 'FNR 渲染 = 1 − 召回率');
    // 区间必须包含点估计
    ['召回率 R', '精确率 P', '特异度 Spec'].forEach((k) => {
      const lo = parseFloat(cross.rows[k].lo), hi = parseFloat(cross.rows[k].hi), p = parseFloat(cross.rows[k].point);
      ok(lo <= p + 0.001 && p <= hi + 0.001, k + ' 的区间包含点估计', cross.rows[k].lo + '~' + cross.rows[k].hi + ' vs ' + cross.rows[k].point);
    });

    console.log('\n=== 5. 趋势图画布像素验证 ===');
    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click(); return 1;`);
    await sleep(300);
    // 造 3 条历史以便图表有多点
    await cdp.eval(`
      const S = window.QCStore, C = window.QCCore;
      const pid = S.getCurrentProjectId();
      const sets = [[70,30,10,890,'W05'],[66,28,14,892,'W06']];
      sets.forEach(([tp,fp,fn,tn,label]) => {
        const m = C.computeMetrics({TP:tp,FP:fp,FN:fn,TN:tn});
        S.addRecord(pid, {
          periodLabel: label,
          input: { periodLabel: label, cm: {TP:tp,FP:fp,FN:fn,TN:tn} },
          counts: m.counts,
          metrics: { accuracy:m.accuracy, precision:m.precision, recall:m.recall, specificity:m.specificity,
                     f1:m.f1, f2:m.f2, f05:m.f05, fpr:m.fpr, fnr:m.fnr, npv:m.npv,
                     piActual:m.piActual, tauQc:m.tauQc, delta:m.delta,
                     ci: { recall: m.ci.recall, precision: m.ci.precision, accuracy: m.ci.accuracy, specificity: m.ci.specificity } },
          warning: { rMin: 0.375, baselineB: 0.08, toleranceT: 0.05, tolerableMissCount: 50 },
          acceptAccuracy: 0.95, obsWindow: 3, diagnostics: [],
        }, true);
      });
      return 1;
    `);
    await sleep(200);
    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click(); return 1;`);
    await sleep(600);

    const canvasInfo = await cdp.eval(`
      const cv = document.querySelector('#historyZone canvas');
      if (!cv) return { exists: false };
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let nonWhite = 0, colored = 0;
      const colors = {};
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i+1], b = d[i+2], a = d[i+3];
        if (a > 0 && !(r > 250 && gg > 250 && b > 250)) {
          nonWhite++;
          if (Math.abs(r - gg) > 18 || Math.abs(gg - b) > 18 || Math.abs(r - b) > 18) {
            colored++;
            const key = r + ',' + gg + ',' + b;
            colors[key] = (colors[key] || 0) + 1;
          }
        }
      }
      const top = Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0, 6).map(([k,v])=>k+'×'+v);
      return {
        exists: true, w: cv.width, h: cv.height,
        cssW: Math.round(cv.getBoundingClientRect().width),
        cssH: Math.round(cv.getBoundingClientRect().height),
        nonWhite, colored, topColors: top,
        rows: document.querySelectorAll('#historyZone .tbl tbody tr').length,
        legend: Array.from(document.querySelectorAll('#historyZone .legend span')).map(s=>s.textContent.trim()),
      };
    `);
    ok(canvasInfo.exists === true, '趋势画布存在');
    ok(canvasInfo.w > 0 && canvasInfo.h > 0, '画布有实际尺寸', canvasInfo.w + '×' + canvasInfo.h);
    ok(canvasInfo.nonWhite > 2000, '画布已绘制内容（非空白）', '非白像素 ' + canvasInfo.nonWhite);
    ok(canvasInfo.colored > 500, '画布含彩色数据线', '彩色像素 ' + canvasInfo.colored);
    ok(canvasInfo.topColors.length > 0, '画布颜色分布可读', canvasInfo.topColors.join(' | '));
    ok(canvasInfo.legend.length >= 5, '图例包含 4 条线 + 警戒线', String(canvasInfo.legend.length));
    console.log('  画布主色：' + canvasInfo.topColors.join(' | '));
    console.log('  图例：' + canvasInfo.legend.join(' / '));
    console.log('  历史表行数：' + canvasInfo.rows);

    console.log('\n=== 6. 文字对比度（WCAG）===');
    const colors = await cdp.eval(`
      function parse(c) {
        const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        return m ? [ +m[1], +m[2], +m[3] ] : null;
      }
      function effBg(node) {
        let n = node;
        while (n && n !== document.documentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          const p = parse(bg);
          if (p && !/rgba\\(0,\\s*0,\\s*0,\\s*0\\)/.test(bg)) return p;
          n = n.parentElement;
        }
        return [255,255,255];
      }
      const samples = [
        ['正文', document.querySelector('.placeholder p') || document.querySelector('.diag-detail')],
        ['表头', document.querySelector('#resultZone .tbl th')],
        ['表格数值', document.querySelector('#resultZone .tbl td.num')],
        ['诊断说明', document.querySelector('.diag-detail')],
        ['提示文字', document.querySelector('.hint')],
        ['统计标签', document.querySelector('.stat-label')],
        ['页签', document.querySelector('.tab.is-active')],
        ['徽章', document.querySelector('#resultZone .badge')],
      ];
      const out = [];
      samples.forEach(([name, el]) => {
        if (!el) { out.push({ name, missing: true }); return; }
        const cs = getComputedStyle(el);
        out.push({
          name, fg: parse(cs.color), bg: effBg(el),
          size: parseFloat(cs.fontSize), weight: cs.fontWeight,
        });
      });
      return out;
    `);
    const lowContrast = [];
    colors.forEach((c) => {
      if (c.missing || !c.fg || !c.bg) return;
      const ratio = contrast(c.fg, c.bg);
      const large = c.size >= 18.66 || (c.size >= 14 && (c.weight === '700' || c.weight === 'bold'));
      const need = large ? 3.0 : 4.5;
      const mark = ratio >= need ? '✓' : '✗';
      console.log(`  ${mark} ${c.name}：对比度 ${ratio.toFixed(2)}:1（${c.size}px，需 ≥${need}）`);
      if (ratio < need) lowContrast.push(c.name + ' ' + ratio.toFixed(2) + ':1');
    });
    ok(lowContrast.length === 0, '所有文字采样点对比度达标', lowContrast.join(' | '));

    console.log('\n=== 7. 无异常占位符 ===');
    const junk = await cdp.eval(`
      // 历史页内容少，回到评估页测量（结果区已渲染）
      document.querySelector('.tab[data-tab="evaluate"]').click();
      const t = document.getElementById('resultZone').innerText;
      const bad = [];
      ['undefined','NaN','[object Object]','null%','%undefined'].forEach(k => {
        if (t.indexOf(k) >= 0) bad.push(k);
      });
      return { bad, len: t.length };
    `);
    ok(junk.bad.length === 0, '界面无 undefined/NaN/[object Object]', junk.bad.join(','));
    ok(junk.len > 2000, '结果区有实质内容', String(junk.len));

  } finally {
    try { chrome.kill(); } catch (e) { /* 忽略 */ }
    server.close();
    await sleep(400);
    try { if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
  else console.log('全部通过 ✓');
}

main().catch((e) => { console.error('运行失败：', e.message); process.exitCode = 1; });
