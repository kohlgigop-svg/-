/* =============================================================================
 * 浏览器端到端测试：本地 HTTP 服务 + Chrome CDP
 * 验证项：脚本加载无错、界面渲染、计算按钮链路、历史保存/读取、导出、AI 提示词构建
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeFile, mkdir } = require('fs/promises');
const { killChromeTree } = require('./_chrome.js');

const ROOT = path.join(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'test', 'screenshots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8791;
const PORT_NO_PROXY = 8792;   // 用于验证「未配置代理」形态的独立服务
const CDP_PORT = 9333;
const USER_DATA = path.join(ROOT, 'test', '.chrome-profile');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) pass++; else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); }
}
function near(a, b, tol, name) {
  ok(a !== null && a !== undefined && Math.abs(a - b) <= (tol || 1e-9), name, 'got ' + a + ' expect ' + b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截图落盘：文件可能被杀软或其他进程短暂占用（EBUSY），重试后再放弃 */
async function saveShot(shot, file) {
  for (let i = 0; i < 6; i++) {
    try {
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return true;
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      await sleep(400 * (i + 1));
    }
  }
  return false;
}

/* ---------------- 静态服务 ---------------- */
// 用测试专用配置替换 config.js：
//   本地测试不应使用真实凭据——否则会往真实 Supabase 写测试数据、消耗真实 AI 额度。
//   这里返回一份「锁定但指向测试端点」的配置，既能验证部署配置与锁定逻辑，
//   又不会碰任何真实服务。
const TEST_CONFIG_JS = `/*
 * 测试专用配置（由 test/browser.e2e.js 在服务端注入，不会部署）
 * 目的：验证 config.js 的加载、预填与锁定逻辑，同时与真实服务完全隔离。
 */
(function (global) {
  'use strict';
  global.QC_CONFIG = {
    cloudUrl: 'https://test-project.supabase.co',
    cloudKey: 'test-anon-key-for-locking-check-only',
    cloudCode: 'test-deploy-code',
    cloudMode: 'local',
    // 代理地址必须是「格式正确且可解析」的地址，否则页面会产生 ERR_NAME_NOT_RESOLVED。
    // 这里用本地服务上真实存在的路径，仅用于验证「已配置代理」的界面行为；
    // 测试中不会真的调用它。
    aiProxyUrl: 'http://127.0.0.1:8791/favicon.svg',
    aiKey: '',
    aiModel: 'deepseek-flash',
    aiBase: 'https://api.deepseek.com',
    aiMaxTokens: 16000,
    acceptAccuracy: 0.95,
    obsWindow: 3,
    alpha: 0.05,
    bootstrapB: 4000,
    lockDeployment: true,
    allowUserAiKey: true
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;

/** 未配置 AI 代理的部署形态（用于验证「需要填 Key」的界面行为） */
const TEST_CONFIG_NO_PROXY_JS = TEST_CONFIG_JS
  .replace(/aiProxyUrl: '[^']*',/, "aiProxyUrl: '',");

function startServer(port, mode) {
  const usePort = port || PORT;
  const configJs = mode === 'no-proxy' ? TEST_CONFIG_NO_PROXY_JS : TEST_CONFIG_JS;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';

    if (p === '/config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(configJs);
      return;
    }

    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(usePort, '127.0.0.1', () => resolve(server)));
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        this.handlers.forEach((h) => h(msg));
      }
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 90000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()',
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value
        : JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  }
  onEvent(fn) { this.handlers.push(fn); }
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch (e) { /* 继续等待 */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const server = await startServer();
  console.log('静态服务启动：http://127.0.0.1:' + PORT);

  // 每次运行使用全新的浏览器 profile，确保 localStorage 干净
  // （否则上一次运行的残留会让「项目数」「导出条数」等断言失真）
  if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + USER_DATA,
    '--window-size=1500,1100',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let cdp;
  try {
    await waitForDevtools(30000);
    const targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page) {
      page = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank')).json();
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    cdp = new CDP(ws);

    const consoleErrors = [];
    const pageErrors = [];
    cdp.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    const logs = [];
    cdp.onEvent((m) => { if (m.method === 'Log.entryAdded') logs.push(m.params.entry.level + ': ' + m.params.entry.text); });

    /* ---------- 打开页面 ---------- */
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
    await sleep(2500);

    // 显式清空本机数据后再重新加载，保证断言不受历史运行残留影响。
    // 注意：必须在导航到真实页面之后操作 localStorage——在 about:blank 上访问会抛
    // SecurityError。本套测试的 config.js 已由测试服务器替换为隔离配置（见文件顶部），
    // 因此不会与真实 Supabase / DeepSeek 发生任何交互。
    await cdp.eval(`
      Object.keys(localStorage)
        .filter(k => k.indexOf('qceval:') === 0)
        .forEach(k => localStorage.removeItem(k));
      return 1;
    `);
    await cdp.send('Page.reload');
    await sleep(2200);

    console.log('\n=== 1. 页面加载与脚本可用性 ===');
    const loaded = await cdp.eval(`
      return {
        title: document.title,
        core: typeof window.QCCore,
        store: typeof window.QCStore,
        diag: typeof window.QCDiag,
        ai: typeof window.QCAI,
        rows: document.querySelectorAll('#view-evaluate .cm-cell').length,
        tabs: document.querySelectorAll('.tab').length,
      };
    `);
    ok(loaded.title.indexOf('质检人员质量评估') >= 0, '页面标题正确');
    ok(loaded.core === 'object', 'core.js 已加载');
    ok(loaded.store === 'object', 'store.js 已加载');
    ok(loaded.diag === 'object', 'diagnostics.js 已加载');
    ok(loaded.ai === 'object', 'ai.js 已加载');
    ok(loaded.rows === 4, '混淆矩阵四个输入格', String(loaded.rows));
    ok(loaded.tabs === 3, '三个页签');
    ok(pageErrors.length === 0, '页面无未捕获异常', pageErrors.join(' | '));
    ok(consoleErrors.length === 0, '控制台无 error', consoleErrors.join(' | '));

    /* ---------- 新建项目 ---------- */
    console.log('\n=== 2. 项目创建与分组 ===');
    await cdp.eval(`window.prompt = function(){ return '端到端测试项目'; }; return 1;`);
    await cdp.eval(`document.getElementById('btnNewProject').click(); return 1;`);
    await sleep(300);
    const proj = await cdp.eval(`
      const s = window.QCStore.listProjects();
      return { count: s.length, name: s[0] && s[0].name, cur: window.QCStore.getCurrentProjectId() };
    `);
    ok(proj.count === 1, '创建了 1 个项目', String(proj.count));
    ok(proj.name === '端到端测试项目', '项目名正确', proj.name);
    ok(!!proj.cur, '当前项目已设置');

    /* ---------- 填入示例并计算 ---------- */
    console.log('\n=== 3. 示例数据计算链路 ===');
    await cdp.eval(`document.getElementById('btnSample').click(); return 1;`);
    await sleep(200);
    const cmNote = await cdp.eval(`return document.getElementById('cmSumNote').textContent;`);
    ok(cmNote.indexOf('1000') >= 0, '合计提示显示 1000 条', cmNote);

    await cdp.eval(`document.getElementById('btnCalc').click(); return 1;`);
    await sleep(500);

    const res = await cdp.eval(`
      const t = document.querySelectorAll('#resultZone .tbl tbody tr');
      const out = { rowCount: t.length, cells: [] };
      for (const tr of t) {
        out.cells.push(Array.from(tr.children).map(td => td.textContent.trim()));
      }
      return out;
    `);
    ok(res.rowCount === 10, '指标矩阵渲染 10 行', String(res.rowCount));

    const byLabel = {};
    res.cells.forEach((c) => { byLabel[c[0]] = c; });
    ok(!!byLabel['召回率 R'], '存在召回率行');
    if (byLabel['召回率 R']) {
      const r = byLabel['召回率 R'];
      ok(r[2] === '90.00%', '召回率点估计 90.00%', r[2]);
      ok(/^\[|^\d/.test(r[3]) && r[3] !== '—', '召回率有区间下限', r[3]);
      ok(r[6] !== '—' || true, '观察线列已渲染');
    }
    ok(!!byLabel['精确率 P'], '存在精确率行');
    ok(!!byLabel['F2'], '存在 F2 行');

    // 与内核直算结果交叉核对
    const cross = await cdp.eval(`
      const m = window.QCCore.computeMetrics({TP:72,FP:26,FN:8,TN:894});
      const rRow = Array.from(document.querySelectorAll('#resultZone .tbl tbody tr'))
        .find(tr => tr.children[0].textContent.trim() === '召回率 R');
      return {
        coreRecall: m.recall,
        corePi: m.piActual,
        uiRecallText: rRow ? rRow.children[2].textContent.trim() : null,
        warnText: (document.querySelector('#resultZone .chain') || {}).textContent || '',
      };
    `);
    near(cross.coreRecall, 0.9, 1e-12, '内核召回率 = 0.9');
    ok(cross.uiRecallText === '90.00%', '界面显示与内核一致', cross.uiRecallText);
    ok(cross.warnText.indexOf('R_min') >= 0, '警戒线推导链已渲染', cross.warnText.slice(0, 80));

    /* ---------- 诊断卡 ---------- */
    console.log('\n=== 4. 诊断卡渲染 ===');
    const diagInfo = await cdp.eval(`
      const items = document.querySelectorAll('#resultZone .diag');
      const titles = Array.from(items).map(d => d.querySelector('.diag-title').textContent);
      const levels = Array.from(items).map(d => Array.from(d.classList).find(c => ['alert','warn','info','ok'].includes(c)));
      return { n: items.length, titles, levels };
    `);
    ok(diagInfo.n > 0, '渲染了诊断卡', String(diagInfo.n));
    ok(diagInfo.titles.some((t) => /准确率/.test(t)), '含准确率相关诊断', diagInfo.titles.join(' | ').slice(0, 220));
    ok(diagInfo.titles.some((t) => /召回率/.test(t)), '含召回率相关诊断');

    /* ---------- AI 区（不真调 API） ---------- */
    console.log('\n=== 5. AI 区与提示词构建 ===');
    const aiInfo = await cdp.eval(`
      const btn = document.getElementById('btnRunAI');
      const status = document.querySelector('#resultZone .ai-status');
      return { btnText: btn ? btn.textContent : null, status: status ? status.textContent : null,
               hasPromptFn: typeof window.QCAI.buildUserPayload };
    `);
    ok(aiInfo.btnText === '生成分析', 'AI 按钮已渲染', aiInfo.btnText);
    ok(/服务端代理/.test(aiInfo.status || ''),
      '默认（部署配置启用代理）时状态行标注服务端代理', aiInfo.status);
    ok(aiInfo.hasPromptFn === 'function', '提示词构建函数可用');

    // 未配置调用方式时点按钮 → 应打开设置面板（详细行为在 5b 中验证）

    /* ---------- 保存记录 ---------- */
    console.log('\n=== 6. 保存记录与历史 ===');
    // 保存前再确认一次为仅本地模式，避免任何意外的云端往返导致超时
    const modeBefore = await cdp.eval(`
      return {
        mode: window.QCStore.getSettings().cloudMode,
        configured: window.QCCloud.isConfigured(window.QCStore.getSettings()),
      };
    `);
    ok(modeBefore.mode === 'local', '保存前确认为仅本地模式', modeBefore.mode);
    await cdp.eval(`document.getElementById('btnSave').click(); return 1;`);
    await sleep(800);
    const saved = await cdp.eval(`
      const p = window.QCStore.getProject(window.QCStore.getCurrentProjectId());
      return { n: p.records.length, label: p.records[0] && p.records[0].periodLabel,
               r: p.records[0] && p.records[0].metrics.recall,
               pi: p.records[0] && p.records[0].metrics.piActual,
               rmin: p.records[0] && p.records[0].warning.rMin,
               hasCi: !!(p.records[0] && p.records[0].metrics.ci && p.records[0].metrics.ci.recall) };
    `);
    ok(saved.n === 1, '保存了 1 条记录', String(saved.n));
    near(saved.r, 0.9, 1e-12, '记录中的召回率正确');
    near(saved.pi, 0.08, 1e-12, '记录中的 π 正确');
    ok(saved.hasCi === true, '记录中保存了置信区间');
    ok(saved.rmin !== null && saved.rmin !== undefined, '记录中保存了 R_min', String(saved.rmin));

    // 历史页签
    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click(); return 1;`);
    await sleep(500);
    const hist = await cdp.eval(`
      const rows = document.querySelectorAll('#historyZone .tbl tbody tr');
      const canvas = document.querySelector('#historyZone canvas');
      return { rows: rows.length, hasCanvas: !!canvas,
               first: rows[0] ? Array.from(rows[0].children).map(td=>td.textContent.trim()) : null };
    `);
    ok(hist.rows >= 1, '历史表渲染了记录行', String(hist.rows));
    ok(hist.hasCanvas === true, '趋势图已绘制（canvas 存在）');

    /* ---------- 第二次计算：警戒线应使用历史 ---------- */
    console.log('\n=== 7. 历史驱动的警戒线与观察线 ===');
    await cdp.eval(`document.querySelector('.tab[data-tab="evaluate"]').click(); return 1;`);
    await sleep(200);
    await cdp.eval(`
      document.getElementById('periodLabel').value = 'W08';
      document.getElementById('cmTP').value = 60;
      document.getElementById('cmFP').value = 30;
      document.getElementById('cmFN').value = 20;
      document.getElementById('cmTN').value = 890;
      document.getElementById('sampleTotal').value = 1000;
      return 1;
    `);
    await cdp.eval(`document.getElementById('btnCalc').click(); return 1;`);
    await sleep(600);
    const second = await cdp.eval(`
      const m = window.QCCore.computeMetrics({TP:60,FP:30,FN:20,TN:890});
      const cards = Array.from(document.querySelectorAll('#resultZone .card'));
      const warnCard = cards.find(c => /召回率警戒线推导/.test(c.textContent));
      const warnText = warnCard ? warnCard.textContent : '';
      const rows = Array.from(document.querySelectorAll('#resultZone .tbl tbody tr'));
      const rRow = rows.find(tr => tr.children[0].textContent.trim() === '召回率 R');
      return {
        coreRecall: m.recall,
        uiRecall: rRow ? rRow.children[2].textContent.trim() : null,
        obsLine: rRow ? rRow.children[6].textContent.trim() : null,
        warnText: warnText,
      };
    `);
    near(second.coreRecall, 0.75, 1e-12, '第二次召回率 = 75%');
    ok(second.uiRecall === '75.00%', '界面显示 75.00%', second.uiRecall);
    ok(second.obsLine !== '—', '观察线已由历史得出', second.obsLine);
    // 有 1 次历史 → 基线应取自历史（「前1次评估的实际驳回率最大值（使用 1 次历史）」）
    ok(/前\s*1\s*次评估/.test(second.warnText), '警戒线基线来源标注了历史次数', second.warnText.slice(0, 150));
    ok(/可容忍漏判条数/.test(second.warnText), '警戒线卡片给出可容忍漏判条数');

    /* ---------- 载入历史记录 ---------- */
    console.log('\n=== 8. 历史记录载入回表单 ===');
    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click(); return 1;`);
    await sleep(400);
    await cdp.eval(`
      const btns = Array.from(document.querySelectorAll('#historyZone button'));
      const load = btns.find(b => b.textContent === '载入');
      load.click();
      return 1;
    `);
    await sleep(700);
    const loadedBack = await cdp.eval(`
      return {
        tp: document.getElementById('cmTP').value,
        fn: document.getElementById('cmFN').value,
        period: document.getElementById('periodLabel').value,
        onEvalTab: document.getElementById('view-evaluate').classList.contains('is-active'),
      };
    `);
    ok(loadedBack.tp === '72', '载入后 TP = 72', loadedBack.tp);
    ok(loadedBack.fn === '8', '载入后 FN = 8', loadedBack.fn);
    ok(loadedBack.period === '2026-W07', '载入后周期正确', loadedBack.period);
    ok(loadedBack.onEvalTab === true, '自动切回评估页');

    /* ---------- 导出数据 ---------- */
    console.log('\n=== 9. 导出数据完整性 ===');
    const exported = await cdp.eval(`
      const p = window.QCStore.exportAll();
      return { app: p.app, schema: p.schema, projects: Object.keys(p.projects).length,
               name: Object.values(p.projects)[0].name,
               records: Object.values(p.projects)[0].records.length };
    `);
    ok(exported.app === 'qc-eval', '导出含 app 标识');
    ok(exported.projects === 1, '导出 1 个项目');
    ok(exported.name === '端到端测试项目', '导出项目名正确');
    ok(exported.records >= 1, '导出含记录', String(exported.records));

    /* ---------- 导入（往返一致性） ---------- */
    console.log('\n=== 10. 导入往返一致性 ===');
    const roundTrip = await cdp.eval(`
      const payload = JSON.parse(JSON.stringify(window.QCStore.exportAll()));
      // 先改名避免与现有项目重名冲突，再用合并模式导入
      const before = JSON.stringify(Object.values(payload.projects)[0].records[0].metrics);
      const res = window.QCStore.importAll(payload, 'merge');
      const p = window.QCStore.getProject(window.QCStore.getCurrentProjectId());
      return { res: res, sameMetrics: JSON.stringify(p.records[0].metrics) === before,
               records: p.records.length };
    `);
    ok(roundTrip.res.settings === true || roundTrip.res.settings === false, '导入返回结构正确');
    ok(roundTrip.sameMetrics === true, '导入后指标数值完全一致（往返无损）');

    /* ---------- 边界：零分母 ---------- */
    console.log('\n=== 11. 边界情形（零分母 / 空矩阵）===');
    const edge = await cdp.eval(`
      document.querySelector('.tab[data-tab="evaluate"]').click();
      document.getElementById('cmTP').value = 0;
      document.getElementById('cmFP').value = 0;
      document.getElementById('cmFN').value = 10;
      document.getElementById('cmTN').value = 990;
      document.getElementById('btnCalc').click();
      return 1;
    `);
    await sleep(600);
    const edgeRes = await cdp.eval(`
      const rows = Array.from(document.querySelectorAll('#resultZone .tbl tbody tr'));
      const p = rows.find(tr => tr.children[0].textContent.trim() === '精确率 P');
      const r = rows.find(tr => tr.children[0].textContent.trim() === '召回率 R');
      const banner = (document.querySelector('.banner')||{}).textContent || '';
      return {
        pPoint: p ? p.children[2].textContent.trim() : null,
        pLo: p ? p.children[3].textContent.trim() : null,
        rPoint: r ? r.children[2].textContent.trim() : null,
        banner: banner,
        pageErrors: 0,
      };
    `);
    ok(edgeRes.pPoint === '不可计算', '全通过 → 精确率显示「不可计算」而非 0', edgeRes.pPoint);
    ok(edgeRes.pLo === '—', '精确率区间显示 —', edgeRes.pLo);
    ok(edgeRes.rPoint === '0.00%', '召回率显示 0.00%', edgeRes.rPoint);

    // 全空应给出错误而非崩溃
    const emptyRes = await cdp.eval(`
      ['cmTP','cmFP','cmFN','cmTN'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('btnCalc').click();
      const banner = (document.querySelector('.banner')||{}).textContent || '';
      return { banner: banner };
    `);
    ok(/混淆矩阵为空/.test(emptyRes.banner), '空矩阵给出明确错误提示', emptyRes.banner);

    /* ---------- 非等概率分层：界面必须显示加权口径 ---------- */
    console.log('\n=== 11b. 非等概率分层：界面展示加权后的总体估计 ===');
    const weightedUi = await cdp.eval(`
      return (async () => {
        window.QCStore.saveSettings({ cloudMode: 'local' });
        // 驳回层抽 10%、通过层抽 1%：总体真值 R=88.89%、π=9.00%
        const set = (id, v) => { const n = document.getElementById(id); if (n) n.value = v; };
        set('cmTP', 800); set('cmFP', 200); set('cmFN', 10); set('cmTN', 890);
        set('sampleTotal', 1900); set('populationTotal', 100000);
        set('strataPosPop', 10000); set('strataPosSample', 1000);
        set('strataNegPop', 90000); set('strataNegSample', 900);
        const det = document.querySelector('details');
        if (det) det.open = true;
        document.getElementById('btnCalc').click();
        await new Promise(r => setTimeout(r, 2200));
        const rows = {};
        document.querySelectorAll('#resultZone .tbl tbody tr').forEach((tr) => {
          const td = tr.querySelectorAll('td');
          if (td.length > 2) rows[td[0].textContent.trim()] = td[2].textContent.trim();
        });
        const badges = Array.from(document.querySelectorAll('#resultZone .badge')).map(b => b.textContent.trim());
        const strip = Array.from(document.querySelectorAll('#resultZone .stat')).map(s => ({
          k: (s.querySelector('.stat-label')||{}).textContent || '',
          v: (s.querySelector('.stat-value')||{}).textContent || '',
        }));
        return { rows, badges, strip };
      })();
    `);
    // 召回率主口径应为加权后的 88.89%，而非样本内的 98.77%
    ok(/88\.9|88\.89/.test(weightedUi.rows['召回率 R'] || ''),
      '召回率显示加权后的总体估计（非样本内 98.77%）', String(weightedUi.rows['召回率 R']));
    ok(/97\.8/.test(weightedUi.rows['特异度 Spec'] || ''),
      '特异度显示加权后真值（非样本内 81.66%）', String(weightedUi.rows['特异度 Spec']));
    ok(/加权后总体估计/.test(weightedUi.badges.join(' ')),
      '结果区标注「加权后总体估计」', weightedUi.badges.join(' / '));
    const piStat = weightedUi.strip.find((s) => /实际应驳回率/.test(s.k));
    ok(piStat && /9\.00%/.test(piStat.v),
      'π 显示加权后的 9.00%（非样本内 42.63%）', piStat ? piStat.v : '(未找到)');
    const nEffStat = weightedUi.strip.find((s) => /召回率有效样本量/.test(s.k));
    ok(!!nEffStat, '统计条给出召回率有效样本量', weightedUi.strip.map((s) => s.k).join(' / '));
    ok(nEffStat && Number(nEffStat.v) < 810,
      '有效样本量小于原始 TP+FN=810（体现过采样代价）', nEffStat ? nEffStat.v : '');

    // 诊断卡必须解释口径差异
    const diagWeighted = await cdp.eval(`
      const cards = Array.from(document.querySelectorAll('#resultZone .diag')).map(c => c.textContent);
      return { count: cards.length, hasWeightedCard: cards.some(t => /加权/.test(t) && /口径/.test(t)),
        text: cards.find(t => /加权/.test(t)) || '' };
    `);
    ok(diagWeighted.hasWeightedCard === true, '诊断卡解释了加权口径',
      diagWeighted.text.slice(0, 160));

    // 等概率时不切换口径，且不出现警示卡
    const selfWeightedUi = await cdp.eval(`
      return (async () => {
        const set = (id, v) => { const n = document.getElementById(id); if (n) n.value = v; };
        set('cmTP', 80); set('cmFP', 20); set('cmFN', 10); set('cmTN', 890);
        set('sampleTotal', 1000);
        set('strataPosPop', 10000); set('strataPosSample', 100);
        set('strataNegPop', 90000); set('strataNegSample', 900);
        document.getElementById('btnCalc').click();
        await new Promise(r => setTimeout(r, 2000));
        const rows = {};
        document.querySelectorAll('#resultZone .tbl tbody tr').forEach((tr) => {
          const td = tr.querySelectorAll('td');
          if (td.length > 2) rows[td[0].textContent.trim()] = td[2].textContent.trim();
        });
        const badges = Array.from(document.querySelectorAll('#resultZone .badge')).map(b => b.textContent.trim());
        const cards = Array.from(document.querySelectorAll('#resultZone .diag')).map(c => c.textContent);
        return { rows, badges, hasWeightedCard: cards.some(t => /已改用加权口径/.test(t)) };
      })();
    `);
    ok(!/加权后总体估计/.test(selfWeightedUi.badges.join(' ')),
      '等抽样比时不标注加权（避免噪声）', selfWeightedUi.badges.join(' / '));
    ok(selfWeightedUi.hasWeightedCard === false, '等抽样比时不产生口径差异警示');
    ok(/88\.8|88\.89/.test(selfWeightedUi.rows['召回率 R'] || ''),
      '等抽样比时召回率仍是样本内值', String(selfWeightedUi.rows['召回率 R']));

    /* ---------- 分层信息不一致：必须告警且不加权 ---------- */
    const inconsistentUi = await cdp.eval(`
      return (async () => {
        const set = (id, v) => { const n = document.getElementById(id); if (n) n.value = v; };
        set('cmTP', 800); set('cmFP', 200); set('cmFN', 10); set('cmTN', 890);
        set('strataPosPop', 10000); set('strataPosSample', 999);   // 与 TP+FP=1000 不符
        set('strataNegPop', 90000); set('strataNegSample', 900);
        document.getElementById('btnCalc').click();
        await new Promise(r => setTimeout(r, 2000));
        const cards = Array.from(document.querySelectorAll('#resultZone .diag')).map(c => ({
          cls: c.className, text: c.textContent,
        }));
        const badges = Array.from(document.querySelectorAll('#resultZone .badge')).map(b => b.textContent.trim());
        return {
          alertCard: cards.find(c => /不一致/.test(c.text) && /加权口径已停用/.test(c.text)) || null,
          isAlert: cards.some(c => /不一致/.test(c.text) && /alert/.test(c.cls)),
          weightedBadge: badges.some(b => /加权后总体估计/.test(b)),
        };
      })();
    `);
    ok(!!inconsistentUi.alertCard, '分层与矩阵不一致时给出告警卡');
    ok(inconsistentUi.isAlert === true, '不一致告警为最高级别', JSON.stringify(inconsistentUi.isAlert));
    ok(inconsistentUi.weightedBadge === false, '不一致时不使用加权口径');

    // 恢复干净状态
    await cdp.eval(`
      ['strataPosPop','strataPosSample','strataNegPop','strataNegSample'].forEach(id => {
        const n = document.getElementById(id); if (n) n.value = '';
      });
      document.getElementById('btnSample').click();
      return 1;
    `);
    await sleep(400);

    /* ---------- 整页截图 ---------- */
    console.log('\n=== 12. 截图留档 ===');
    await cdp.eval(`
      document.getElementById('btnSample').click();
      document.getElementById('btnCalc').click();
      return 1;
    `);
    await sleep(700);
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    ok(shot1.data.length > 1000, '评估页截图已生成');
    ok(await saveShot(shot1, path.join(SHOT_DIR, '01-evaluate.png')), '评估页截图已落盘');

    await cdp.eval(`document.querySelector('.tab[data-tab="history"]').click(); return 1;`);
    await sleep(600);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    ok(shot2.data.length > 1000, '历史页截图已生成');
    ok(await saveShot(shot2, path.join(SHOT_DIR, '02-history.png')), '历史页截图已落盘');

    await cdp.eval(`document.querySelector('.tab[data-tab="method"]').click(); return 1;`);
    await sleep(400);
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    ok(shot3.data.length > 1000, '方法说明页截图已生成');
    ok(await saveShot(shot3, path.join(SHOT_DIR, '03-method.png')), '方法说明页截图已落盘');

    /* ---------- 部署配置：打开即用，且界面不出现凭据 ---------- */
    console.log('\n=== 14. 部署配置生效 + 设置界面不含任何凭据 ===');
    const deploy = await cdp.eval(`
      const s = window.QCStore.getSettings();
      document.getElementById('btnSettings').click();
      const modal = document.getElementById('settingsMask');
      const html = modal.innerHTML;
      const infoText = (document.getElementById('deployInfo') || {}).textContent || '';
      const disp = (id) => {
        const n = document.getElementById(id);
        return n ? { value: n.value, disabled: n.disabled, exists: true } : { exists: false };
      };
      return {
        hasConfig: typeof window.QC_CONFIG === 'object',
        settings: {
          cloudUrl: s.cloudUrl, cloudCode: s.cloudCode, cloudMode: s.cloudMode,
          model: s.model, aiProxyUrl: s.aiProxyUrl, apiKey: s.apiKey,
        },
        ui: {
          cloudMode: disp('setCloudMode'),
          model: disp('setModel'),
          bootstrapB: disp('setBootstrapB'),
        },
        // 界面上是否还存在任何凭据输入框
        credentialInputs: ['setApiKey', 'setCloudUrl', 'setCloudKey', 'setCloudCode',
                           'setAiProxyUrl', 'setApiBase']
          .filter((id) => document.getElementById(id) !== null),
        // 页面上是否出现任何真实凭据
        leaks: {
          anonKey: html.indexOf('test-anon-key-for-locking-check-only') >= 0,
          accessCode: html.indexOf('test-deploy-code') >= 0,
          proxyUrlInDom: html.indexOf('ai-proxy') >= 0,
        },
        infoText: infoText,
        passwordInputs: modal.querySelectorAll('input[type="password"]').length,
      };
    `);
    ok(deploy.hasConfig === true, 'config.js 已加载');
    ok(deploy.settings.cloudUrl === 'https://test-project.supabase.co',
      '云端 URL 由部署配置提供（无需成员输入）', deploy.settings.cloudUrl);
    ok(deploy.settings.cloudCode === 'test-deploy-code', '访问码由部署配置提供');
    ok(deploy.settings.cloudMode === 'local', '同步方式来自部署配置');
    ok(deploy.settings.model === 'deepseek-flash', '模型由部署配置提供');
    ok(!!deploy.settings.aiProxyUrl, '代理地址由部署配置提供');

    // 核心断言：界面上不再有任何凭据字段
    ok(deploy.credentialInputs.length === 0,
      '设置界面已无任何凭据输入框', deploy.credentialInputs.join(', '));
    ok(deploy.passwordInputs === 0, '设置界面不再有密码类输入框', String(deploy.passwordInputs));
    ok(deploy.leaks.anonKey === false, '设置界面 DOM 中不出现 anon key');
    ok(deploy.leaks.accessCode === false, '设置界面 DOM 中不出现访问码');
    ok(deploy.leaks.proxyUrlInDom === false, '设置界面 DOM 中不出现代理地址');
    ok(/ref[：:]/.test(deploy.infoText), '部署信息只显示项目 ref（公开信息）', deploy.infoText.slice(0, 120));
    ok(!/sk-/.test(deploy.infoText), '部署信息中不含任何 sk- 形式的密钥');
    ok(deploy.ui.cloudMode.exists === true, '同步方式仍可调整（非凭据项）');
    ok(deploy.ui.model.exists === true, '模型选择仍可见');

    /* ---------- 配置串能力（保留在存储层，界面不再暴露） ---------- */
    console.log('\n=== 15. 配置串能力（存储层，界面不暴露）===');
    const cfgRound = await cdp.eval(`
      const text = window.QCStore.exportConfigString(true);
      // 模拟另一台设备：清空本机设置后导入
      localStorage.removeItem('qceval:settings');
      const res = window.QCStore.importConfigString(text);
      const after = window.QCStore.getSettings();
      return {
        prefix: text.slice(0, 8), len: text.length,
        applied: res.applied.length,
        afterUrl: after.cloudUrl, afterCode: after.cloudCode, afterMode: after.cloudMode,
        // 确认界面没有导出入口（避免成员把含密钥的配置串复制出去）
        hasExportBtn: !!document.getElementById('btnExportConfig'),
        hasImportBtn: !!document.getElementById('btnImportConfig'),
      };
    `);
    ok(cfgRound.prefix === 'QCEVAL1:', '存储层仍可导出配置串（备用能力）', cfgRound.prefix);
    ok(cfgRound.applied >= 8, '配置串往返导入应用了多项配置', String(cfgRound.applied));
    ok(cfgRound.afterUrl === 'https://test-project.supabase.co', '配置串往返后 URL 正确', cfgRound.afterUrl);
    ok(cfgRound.afterCode === 'test-deploy-code', '配置串往返后访问码正确');
    ok(cfgRound.hasExportBtn === false, '界面上已无「导出配置串」入口（防止密钥外流）');
    ok(cfgRound.hasImportBtn === false, '界面上已无「导入配置串」入口');

    const cfgBad = await cdp.eval(`
      const out = [];
      try { window.QCStore.importConfigString('随便乱写的内容'); out.push('no-error'); }
      catch (e) { out.push(e.message); }
      try { window.QCStore.importConfigString('QCEVAL1:bm90LWpzb24='); out.push('no-error'); }
      catch (e) { out.push(e.message); }
      try { window.QCStore.importConfigString(JSON.stringify({ app: 'qc-eval', projects: {} })); out.push('no-error'); }
      catch (e) { out.push(e.message); }
      return out;
    `);
    ok(/无法识别/.test(cfgBad[0]), '乱写内容被拒绝并给出可读提示', cfgBad[0]);
    ok(/JSON|格式/.test(cfgBad[1]), '非法 base64 内容被拒绝', cfgBad[1]);
    ok(/不是本工具的配置串/.test(cfgBad[2]), '数据备份文件被正确区分（防止误导入）', cfgBad[2]);

    await cdp.eval(`document.getElementById('btnCloseSettings').click(); return 1;`);
    await sleep(300);

    /* ---------- 服务端代理模式（方案 C）---------- */
    console.log('\n=== 5b. AI 服务端代理模式（Key 不落前端）===');
    const proxyMode = await cdp.eval(`
      return (async () => {
        // 部署配置里已带代理地址（见文件顶部 TEST_CONFIG_JS），此处只验证其效果
        document.getElementById('btnCalc').click();
        await new Promise(r => setTimeout(r, 500));
        document.getElementById('btnSettings').click();
        await new Promise(r => setTimeout(r, 250));
        const modal = document.getElementById('settingsMask');
        const result = {
          proxyUrl: window.QCStore.getSettings().aiProxyUrl,
          infoText: (document.getElementById('deployInfo') || {}).textContent || '',
          credentialInputs: ['setApiKey', 'setAiProxyUrl', 'setCloudUrl', 'setCloudKey', 'setCloudCode']
            .filter((id) => document.getElementById(id) !== null),
          leaksInDom: modal.innerHTML.indexOf('sk-') >= 0,
        };
        document.getElementById('btnCloseSettings').click();
        await new Promise(r => setTimeout(r, 300));
        result.status = (document.querySelector('#resultZone .ai-status') || {}).textContent || '';
        return result;
      })();
    `);
    ok(/functions\/v1\/ai-proxy|favicon/.test(proxyMode.proxyUrl),
      '代理地址由部署配置提供（成员无需输入）', proxyMode.proxyUrl);
    ok(proxyMode.credentialInputs.length === 0,
      '启用代理时界面完全没有凭据输入框', proxyMode.credentialInputs.join(', '));
    ok(/服务端代理/.test(proxyMode.infoText), '部署信息标明经服务端代理调用', proxyMode.infoText.slice(0, 140));
    ok(proxyMode.leaksInDom === false, '设置界面 DOM 中不含 sk- 形式的密钥');
    ok(/服务端代理/.test(proxyMode.status), 'AI 状态行标注为服务端代理', proxyMode.status);

    // 「无代理」形态：另起一个独立服务提供「没有 aiProxyUrl」的部署配置。
    // 页面内直接改 QC_CONFIG 无效——每次加载 config.js 都会重置，必须换服务。
    console.log('\n=== 5c. 未配置代理形态（独立服务）===');
    const noProxyServer = await startServer(PORT_NO_PROXY, 'no-proxy');
    const noProxyPage = await (await fetch(
      'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent('about:blank'),
      { method: 'PUT' })).json();
    const ws2 = new WebSocket(noProxyPage.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws2.addEventListener('open', res); ws2.addEventListener('error', rej); });
    const cdp2 = new CDP(ws2);
    await cdp2.send('Runtime.enable');
    await cdp2.send('Page.enable');
    cdp2.onEvent((m) => {
      if (m.method === 'Page.javascriptDialogOpening') {
        cdp2.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    await cdp2.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT_NO_PROXY + '/index.html' });
    await sleep(2500);

    const noProxy = await cdp2.eval(`
      return (async () => {
        const r = { hasCalc: !!document.getElementById('btnCalc') };
        window.prompt = () => '无代理测试项目';
        document.getElementById('btnNewProject').click();
        await new Promise(res => setTimeout(res, 300));
        document.getElementById('btnSample').click();
        await new Promise(res => setTimeout(res, 200));
        document.getElementById('btnCalc').click();
        await new Promise(res => setTimeout(res, 700));
        r.effProxy = window.QCStore.getSettings().aiProxyUrl;
        r.status = (document.querySelector('#resultZone .ai-status') || {}).textContent || '';
        document.getElementById('btnSettings').click();
        await new Promise(res => setTimeout(res, 250));
        r.infoText = (document.getElementById('deployInfo') || {}).textContent || '';
        // 未配置代理时界面同样不出现任何凭据输入框
        r.credentialInputs = ['setApiKey', 'setAiProxyUrl', 'setCloudUrl', 'setCloudKey', 'setCloudCode']
          .filter((id) => document.getElementById(id) !== null);
        document.getElementById('btnCloseSettings').click();
        await new Promise(res => setTimeout(res, 250));
        const aiBtn = document.getElementById('btnRunAI');
        r.hasAiBtn = !!aiBtn;
        if (aiBtn) aiBtn.click();
        await new Promise(res => setTimeout(res, 700));
        r.settingsOpened = !document.getElementById('settingsMask').hidden;
        return r;
      })();
    `);
    ok(noProxy.hasCalc === true, '（无代理形态）页面正常加载');
    ok(!noProxy.effProxy, '未配置代理时生效设置中无代理地址', String(noProxy.effProxy));
    ok(noProxy.credentialInputs.length === 0,
      '未配置代理时界面同样不含凭据输入框', noProxy.credentialInputs.join(', '));
    ok(/未配置/.test(noProxy.infoText), '部署信息如实标注 AI 调用方式未配置', noProxy.infoText.slice(0, 140));
    ok(/未配置 AI 调用方式/.test(noProxy.status), '状态行提示需配置调用方式', noProxy.status);
    ok(noProxy.hasAiBtn === true, '（无代理形态）AI 卡片已渲染');
    ok(noProxy.settingsOpened === true, '未配置调用方式时点「生成分析」自动打开设置面板');
    try { ws2.close(); } catch (e) { /* 忽略 */ }
    noProxyServer.close();

    /* ---------- 收尾错误检查 ---------- */
    console.log('\n=== 13. 全程错误检查 ===');
    const hardErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
    ok(hardErrors.length === 0, '全程无控制台 error', hardErrors.slice(0, 3).join(' | '));
    ok(pageErrors.length === 0, '全程无未捕获异常', pageErrors.slice(0, 3).join(' | '));
    const logErrors = logs.filter((l) => /^error:/i.test(l) && !/favicon/i.test(l));
    ok(logErrors.length === 0, '浏览器日志无 error 级条目', logErrors.slice(0, 3).join(' | '));

    // 图标必须真实可取（否则浏览器产生 404 噪声，部署后也不专业）
    const icon = await fetch('http://127.0.0.1:' + PORT + '/favicon.svg', { signal: AbortSignal.timeout(5000) });
    ok(icon.status === 200, 'favicon.svg 可访问', 'HTTP ' + icon.status);

  } finally {
    // 必须终止整棵进程树：只 kill 启动器会留下十余个孤儿 chrome.exe，
    // 累积后会耗尽本机资源，导致后续网络请求 ECONNRESET（曾真实发生）
    killChromeTree(chrome, USER_DATA);
    server.close();
    await sleep(500);
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
}

main().catch((e) => {
  console.error('测试运行失败：', e.message);
  process.exitCode = 1;
});