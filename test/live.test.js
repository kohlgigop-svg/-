/* =============================================================================
 * 线上部署验证：对 GitHub Pages 站点做真实浏览器验收
 * 验证：页面可访问、资源加载、计算链路、AI 直连 CORS、与本地版本一致
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SITE = 'https://kohlgigop-svg.github.io/-/';
const LOCAL = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9337;
const USER_DATA = path.join(__dirname, '.chrome-live');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) this.handlers.forEach((h) => h(m));
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 40000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()', returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  onEvent(fn) { this.handlers.push(fn); }
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

async function main() {
  console.log('=== 1. 前台可访问性检查 ===');
  const page = await fetch(SITE, { signal: AbortSignal.timeout(30000) });
  const html = await page.text();
  ok(page.status === 200, '首页 HTTP 200', 'HTTP ' + page.status);
  ok(page.headers.get('content-type') && page.headers.get('content-type').indexOf('text/html') >= 0,
    '返回 HTML 类型', page.headers.get('content-type'));
  ok(html.indexOf('质检人员质量评估') >= 0, '页面内容正确（含标题）');

  for (const asset of ['styles.css', 'src/core.js', 'src/store.js', 'src/diagnostics.js', 'src/ai.js', 'src/app.js', 'favicon.svg']) {
    const r = await fetch(SITE + asset, { signal: AbortSignal.timeout(30000) });
    ok(r.status === 200, '资源可访问：' + asset, 'HTTP ' + r.status);
  }

  // 与本地版本逐字节一致性核对
  const pairs = [['index.html', 'index.html'], ['styles.css', 'styles.css'],
    ['src/core.js', 'src/core.js'], ['src/app.js', 'src/app.js'], ['src/ai.js', 'src/ai.js']];
  for (const [remote, local] of pairs) {
    const r = await fetch(SITE + remote, { signal: AbortSignal.timeout(30000) });
    const remoteText = (await r.text()).replace(/\r\n/g, '\n');
    const localText = fs.readFileSync(path.join(LOCAL, local), 'utf8').replace(/\r\n/g, '\n');
    ok(remoteText === localText, '线上与本地内容一致：' + remote,
      '线上 ' + remoteText.length + ' 字节 vs 本地 ' + localText.length + ' 字节');
  }

  console.log('\n=== 2. 真实浏览器打开线上站点 ===');
  if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + USER_DATA,
    '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitDevtools(30000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const target = list.find((t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    cdp.onEvent((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
      if (m.method === 'Network.loadingFailed') failedRequests.push(m.params.errorText);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    // 等待 load 事件，避免页面未就绪就取值
    const loadPromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 45000);
      cdp.onEvent((m) => {
        if (m.method === 'Page.loadEventFired') { clearTimeout(t); resolve('loaded'); }
      });
    });
    await cdp.send('Page.navigate', { url: SITE });
    const loadState = await loadPromise;
    console.log('  页面加载事件：' + loadState);
    await sleep(2500);

    const probe = await cdp.eval(`
      return {
        url: location.href,
        protocol: location.protocol,
        readyState: document.readyState,
        hasQCStore: typeof window.QCStore,
        hasQCCore: typeof window.QCCore,
        title: document.title,
        bodyLen: document.body ? document.body.innerText.length : -1,
      };
    `);
    console.log('  探测：' + JSON.stringify(probe));
    ok(probe.readyState === 'complete' || probe.readyState === 'interactive', '页面已完成加载', probe.readyState);
    ok(probe.hasQCStore === 'object', '线上 QCStore 可用', probe.hasQCStore);
    ok(probe.hasQCCore === 'object', '线上 QCCore 可用', probe.hasQCCore);
    ok(probe.bodyLen > 500, '页面有实质内容', String(probe.bodyLen));

    const loaded = await cdp.eval(`
      return {
        url: location.href,
        protocol: location.protocol,
        core: typeof window.QCCore,
        store: typeof window.QCStore,
        diag: typeof window.QCDiag,
        ai: typeof window.QCAI,
        persistent: window.QCStore ? window.QCStore.isPersistent() : null,
        title: document.title,
      };
    `);
    ok(loaded.protocol === 'https:', '线上为 HTTPS', loaded.protocol);
    ok(loaded.core === 'object' && loaded.store === 'object' && loaded.diag === 'object' && loaded.ai === 'object',
      '四个脚本在线上均加载成功', JSON.stringify(loaded));
    ok(loaded.persistent === true, '线上环境 localStorage 可用（记忆功能生效）');
    ok(pageErrors.length === 0, '线上页面无未捕获异常', pageErrors.slice(0, 2).join(' | '));
    ok(failedRequests.length === 0, '无资源加载失败', failedRequests.slice(0, 3).join(' | '));

    console.log('\n=== 3. 线上计算链路 ===');
    await cdp.eval(`window.prompt = () => '线上验收'; document.getElementById('btnNewProject').click(); return 1;`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btnSample').click(); document.getElementById('btnCalc').click(); return 1;`);
    await sleep(900);

    const calc = await cdp.eval(`
      const m = window.QCCore.computeMetrics({TP:72,FP:26,FN:8,TN:894});
      const rows = {};
      document.querySelectorAll('#resultZone .tbl tbody tr').forEach(tr => {
        const c = Array.from(tr.children).map(td => td.textContent.trim());
        rows[c[0]] = c;
      });
      return {
        coreR: m.recall, coreP: m.precision,
        uiR: rows['召回率 R'] ? rows['召回率 R'][2] : null,
        uiP: rows['精确率 P'] ? rows['精确率 P'][2] : null,
        uiRlo: rows['召回率 R'] ? rows['召回率 R'][3] : null,
        diagCount: document.querySelectorAll('#resultZone .diag').length,
        chainSteps: document.querySelectorAll('#resultZone .chain-step').length,
        statCount: document.querySelectorAll('#resultZone .stat').length,
      };
    `);
    ok(calc.uiR === '90.00%', '线上召回率显示 90.00%', calc.uiR);
    ok(calc.uiP === (calc.coreP * 100).toFixed(2) + '%', '线上精确率与内核一致', calc.uiP);
    ok(calc.uiRlo !== '—' && calc.uiRlo !== null, '线上置信区间已计算', String(calc.uiRlo));
    ok(calc.diagCount > 0, '线上诊断卡已渲染', String(calc.diagCount));
    ok(calc.chainSteps === 4, '线上警戒线推导链 4 步', String(calc.chainSteps));
    ok(calc.statCount >= 6, '线上统计条完整', String(calc.statCount));

    console.log('\n=== 4. 线上历史持久化 ===');
    await cdp.eval(`document.getElementById('btnSave').click(); return 1;`);
    await sleep(700);
    const hist = await cdp.eval(`
      const p = window.QCStore.getProject(window.QCStore.getCurrentProjectId());
      return { records: p.records.length, label: p.records[0] && p.records[0].periodLabel,
               rawLs: !!localStorage.getItem('qceval:projects') };
    `);
    ok(hist.records === 1, '线上保存记录成功', String(hist.records));
    ok(hist.rawLs === true, '数据已写入 localStorage（刷新不丢）');

    // 刷新后是否保留
    await cdp.send('Page.reload');
    await sleep(3500);
    const afterReload = await cdp.eval(`
      const list = window.QCStore.listProjects();
      return { count: list.length, name: list[0] && list[0].name, recs: list[0] && list[0].recordCount };
    `);
    ok(afterReload.count === 1, '刷新后项目仍在', String(afterReload.count));
    ok(afterReload.recs === 1, '刷新后记录仍在（记忆功能验证通过）', String(afterReload.recs));

    console.log('\n=== 5. AI 接口跨域直连验证（线上真实请求）===');
    const cors = await cdp.eval(`
      return (async () => {
        // 不消耗额度的探测：用无效 key 观察是否被 CORS 拦截
        try {
          const r = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-invalid-probe' },
            body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], max_tokens: 1 }),
          });
          const t = await r.text();
          return { reached: true, status: r.status, body: t.slice(0, 160) };
        } catch (e) {
          return { reached: false, error: String(e && e.message) };
        }
      })();
    `);
    ok(cors.reached === true, '浏览器可从线上站点直连 DeepSeek（CORS 通过）',
      cors.reached ? '' : '被拦截：' + cors.error);
    ok(cors.status === 401 || cors.status === 400,
      '无效 Key 返回鉴权错误（证明请求真正到达接口）', 'HTTP ' + cors.status + ' ' + String(cors.body).slice(0, 80));

    console.log('\n=== 6. 线上错误检查 ===');
    const hardErrors = consoleErrors.filter((e) => !/favicon|401|Failed to load resource.*401/i.test(e));
    ok(hardErrors.length === 0, '线上无控制台 error', hardErrors.slice(0, 3).join(' | '));
    ok(pageErrors.length === 0, '线上无未捕获异常', pageErrors.slice(0, 3).join(' | '));

  } finally {
    try { chrome.kill(); } catch (e) { /* 忽略 */ }
    await sleep(400);
    try { if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('\n失败明细：'); failures.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
  else console.log('线上验收全部通过 ✓');
}

main().catch((e) => { console.error('验收失败：', e.message); process.exitCode = 1; });
