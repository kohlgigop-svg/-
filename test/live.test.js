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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 90000);
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

    // 自动确认原生对话框（confirm/prompt/alert）。
    // 否则对话框会阻塞渲染线程，导致后续 Runtime.evaluate 永久挂起。
    cdp.onEvent((m) => {
      if (m.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

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

    // 刷新后是否保留（线上连着真实 Supabase，启动时会自动拉取，故多等一会）
    await cdp.send('Page.reload');
    await sleep(12000);
    // 记录刷新前的当前项目 id，刷新后比对（不依赖列表排序，避免云端其他项目干扰）
    const beforeReloadId = await cdp.eval(`
      return window.QCStore.getCurrentProjectId();
    `);
    await cdp.send('Page.reload');
    await sleep(12000);
    const afterReload = await cdp.eval(`
      const list = window.QCStore.listProjects();
      const p = window.QCStore.getProject(window.QCStore.getCurrentProjectId());
      return {
        count: list.length,
        currentId: window.QCStore.getCurrentProjectId(),
        recs: p ? (p.records || []).length : 0,
        hasSaved: !!localStorage.getItem('qceval:current'),
      };
    `);
    ok(afterReload.count >= 1, '刷新后项目仍在', String(afterReload.count));
    ok(afterReload.currentId === beforeReloadId, '刷新后当前项目未变', afterReload.currentId + ' vs ' + beforeReloadId);
    ok(afterReload.hasSaved === true, '当前项目选择已持久化');
    ok(afterReload.recs >= 1, '刷新后本项目记录仍在（记忆功能验证通过）', String(afterReload.recs));

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

    console.log('\n=== 6. 线上云端链路（真实浏览器 → 真实 Supabase）===');
    const SUPABASE_DASH = 'https://supabase.com/dashboard/project/ofdtgchdkhgvksuohzoq';
    const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZHRnY2hka2hndmtzdW9oem9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MTkwOTcsImV4cCI6MjEwNTA5NTA5N30.7tZhOUgN-VOLjUUzZveHrnEKECTZhEI7-DFXoUq3xRw';
    const TEST_PROJECT = '__E2E_LIVE_PROJECT__' + Date.now().toString(36);
    const TEST_PERIOD = 'LIVE-' + Date.now().toString(36);

    // 6.1 URL 自动换算：故意填控制台地址
    const norm = await cdp.eval(`
      return window.QCCloud.normalizeUrl('${SUPABASE_DASH}');
    `);
    ok(norm === 'https://ofdtgchdkhgvksuohzoq.supabase.co',
      '控制台地址被自动换算为接口地址', norm);

    // 6.2 通过界面连接（凭据来自 config.js，界面已无输入框）
    const connectRes = await cdp.eval(`
      return (async () => {
        document.getElementById('btnSettings').click();
        await new Promise(r => setTimeout(r, 300));
        const modal = document.getElementById('settingsMask');
        const credentialInputs = ['setApiKey', 'setCloudUrl', 'setCloudKey', 'setCloudCode', 'setAiProxyUrl']
          .filter((id) => document.getElementById(id) !== null);
        const infoText = (document.getElementById('deployInfo') || {}).textContent || '';
        document.getElementById('btnCloudConnect').click();
        await new Promise(r => setTimeout(r, 10000));
        return {
          testResult: document.getElementById('cloudTestResult').textContent,
          connected: window.QCCloud.isConnected(window.QCStore.getSettings()),
          credentialInputs: credentialInputs,
          infoText: infoText,
          leaksInDom: modal.innerHTML.indexOf('sk-') >= 0,
        };
      })();
    `);
    ok(/✓/.test(connectRes.testResult), '界面上「连接云端」成功', connectRes.testResult);
    ok(connectRes.connected === true, '前端判定为已连接');
    ok(connectRes.credentialInputs.length === 0,
      '线上设置界面不含任何凭据输入框', connectRes.credentialInputs.join(', '));
    ok(connectRes.leaksInDom === false, '线上设置界面 DOM 中不含 sk- 形式密钥');
    ok(/ref[：:]/.test(connectRes.infoText), '部署信息显示项目 ref（公开信息）', connectRes.infoText.slice(0, 120));

    await cdp.eval(`document.getElementById('btnCloseSettings').click(); return 1;`);
    await sleep(400);

    // 6.3 新建测试项目并保存记录（应写入云端）
    await cdp.eval(`
      window.prompt = () => '${TEST_PROJECT}';
      document.getElementById('btnNewProject').click();
      return 1;
    `);
    await sleep(500);
    const savedCloud = await cdp.eval(`
      return (async () => {
        document.getElementById('periodLabel').value = '${TEST_PERIOD}';
        document.getElementById('cmTP').value = 72;
        document.getElementById('cmFP').value = 26;
        document.getElementById('cmFN').value = 8;
        document.getElementById('cmTN').value = 894;
        document.getElementById('sampleTotal').value = 1000;
        document.getElementById('btnCalc').click();
        await new Promise(r => setTimeout(r, 600));
        document.getElementById('btnSave').click();
        await new Promise(r => setTimeout(r, 6000));
        return {
          cloudMode: window.QCStore.getSettings().cloudMode,
          records: (window.QCStore.getProject(window.QCStore.getCurrentProjectId()).records || []).length,
        };
      })();
    `);
    ok(savedCloud.cloudMode === 'dual', '同步方式为双写', savedCloud.cloudMode);
    ok(savedCloud.records === 1, '记录已存到本机', String(savedCloud.records));

    // 6.4 独立性验证：脱离本机缓存，直接查云端确认真的写进去了
    const cloudVerify = await cdp.eval(`
      return (async () => {
        const s = window.QCStore.getSettings();
        const list = await window.QCCloud.fetchAll(s);
        const p = list.find(x => x.project_name === '${TEST_PROJECT}');
        return {
          found: !!p,
          records: p ? p.records.length : 0,
          period: p && p.records[0] ? p.records[0].periodLabel : null,
          recall: p && p.records[0] && p.records[0].payload
            ? p.records[0].payload.metrics.recall : null,
          submitterIsMe: p && p.records[0]
            ? p.records[0].submitter === window.QCCloud.currentUserId() : null,
        };
      })();
    `);
    ok(cloudVerify.found === true, '云端独立查询能查到该项目（证明真的写入了数据库）');
    ok(cloudVerify.records === 1, '云端有 1 条记录', String(cloudVerify.records));
    ok(cloudVerify.period === TEST_PERIOD, '云端周期正确', cloudVerify.period);
    ok(Math.abs(cloudVerify.recall - 0.9) < 1e-9, '云端指标数值正确（召回率 90%）', String(cloudVerify.recall));
    ok(cloudVerify.submitterIsMe === true, '云端记录的提交者标识是本机会话（可正确判定归属）');

    // 6.5 刷新页面后：云端数据应自动恢复（模拟换设备/清缓存）
    await cdp.eval(`localStorage.removeItem('qceval:projects'); return 1;`);
    await cdp.send('Page.reload');
    await sleep(9000);
    const afterWipe = await cdp.eval(`
      const list = window.QCStore.listProjects();
      const p = list.find(x => x.name === '${TEST_PROJECT}');
      return {
        projectCount: list.length,
        found: !!p,
        records: p ? p.recordCount : 0,
        cloudStatus: (document.getElementById('cloudStatus') || {}).textContent || '',
      };
    `);
    ok(afterWipe.found === true, '清空本机缓存后刷新，云端项目被自动拉回（数据不丢的关键验证）',
      '项目数 ' + afterWipe.projectCount);
    ok(afterWipe.records === 1, '拉回的项目含 1 条记录', String(afterWipe.records));
    ok(/云端已连接（/.test(afterWipe.cloudStatus), '顶部状态条显示云端已连接（含模式说明）',
      afterWipe.cloudStatus.slice(0, 90));

    // 6.6 清理云端测试数据
    const cleaned = await cdp.eval(`
      return (async () => {
        const s = window.QCStore.getSettings();
        const list = await window.QCCloud.fetchAll(s);
        const p = list.find(x => x.project_name === '${TEST_PROJECT}');
        if (!p) return { deleted: false, reason: 'not found' };
        for (const rec of p.records) {
          await window.QCCloud.deleteRecord(s, rec.id);
        }
        await window.QCCloud.deleteProject(s, p.project_id);
        const after = await window.QCCloud.fetchAll(s);
        return { deleted: true, remaining: after.filter(x => x.project_name === '${TEST_PROJECT}').length };
      })();
    `);
    ok(cleaned.deleted === true, '云端测试数据已清理');
    ok(cleaned.remaining === 0, '云端无残留测试项目', String(cleaned.remaining));

    console.log('\n=== 7. 线上错误检查 ===');
    const hardErrors = consoleErrors.filter((e) => !/favicon|401|Failed to load resource.*401/i.test(e));
    ok(hardErrors.length === 0, '线上无控制台 error', hardErrors.slice(0, 3).join(' | '));
    ok(pageErrors.length === 0, '线上无未捕获异常', pageErrors.slice(0, 3).join(' | '));

    // 图标必须真实可取（否则浏览器产生 404 噪声，部署后也不专业）
    const icon = await fetch(SITE + 'favicon.svg', { signal: AbortSignal.timeout(5000) });
    ok(icon.status === 200, 'favicon.svg 可访问', 'HTTP ' + icon.status);

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
