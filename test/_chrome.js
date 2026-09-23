/* =============================================================================
 * 测试公共工具：Chrome 进程树清理
 * -----------------------------------------------------------------------------
 * 缺陷背景（真实教训）：
 *   测试用 child_process.spawn 启动 Chrome，结束时只调用了 child.kill()。
 *   在 Windows 上这只终止「启动器进程」，而 Chrome 的实际子进程
 *   （渲染器、GPU、网络服务等十余个）会变成孤儿进程继续驻留。
 *   连续跑几轮套件后本机累积了 99 个残留 chrome.exe，最终耗尽资源，
 *   表现为后续网络请求 ECONNRESET → 云端测试间歇性失败。
 *
 *   这类问题极难归因：失败信息是「fetch failed」，与 Chrome 毫无表面关联。
 *
 * 正确做法：用 taskkill /F /T /PID 终止整棵进程树；
 *         再兜底按 user-data-dir 批量清理，确保不留残余。
 * ========================================================================== */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');

/**
 * 列出所有 chrome.exe 的 PID 与命令行。
 *
 * 为什么用 PowerShell 的 CIM 而不是 tasklist：
 *   tasklist /V 的「命令行」列实际输出的是**窗口标题**（不是命令行），
 *   tasklist 本身也拿不到命令行。实测确认后改为 CIM 查询。
 * 也不使用 wmic —— 它已从 Windows 11 / 新版 Windows 移除。
 *
 * 重要：只用于「识别并精确按 PID 终止测试进程」，
 * 绝不能对 chrome.exe 做整体清理——那会杀掉用户正在使用的浏览器。
 */
function listChromeProcesses() {
  if (process.platform !== 'win32') return [];
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" -ErrorAction SilentlyContinue',
    '| ForEach-Object {',
    '  $cl = $_.CommandLine; if ($null -eq $cl) { $cl = "" }',
    '  "$($_.ProcessId)|$cl"',
    '}',
  ].join(' ');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return (out.stdout || '').split(/\r?\n/)
    .filter((l) => l.indexOf('|') > 0)
    .map((l) => {
      const i = l.indexOf('|');
      return { pid: l.slice(0, i).trim(), cmd: l.slice(i + 1) };
    })
    .filter((r) => /^\d+$/.test(r.pid));
}

/** 判断某进程是否属于本测试基础设施（headless 或测试专用 profile） */
const TEST_CMD_RE = /--headless|chrome-profile|chrome-render|chrome-diag|chrome-probe|chrome-settings|chrome-strat|chrome-live|chrome-killtest|chrome-autopull|chrome-final/i;

function isTestChrome(cmd) {
  return TEST_CMD_RE.test(String(cmd || ''));
}

/**
 * 终止一棵 Chrome 进程树
 * @param {import('child_process').ChildProcess} child  spawn 返回的子进程
 * @param {string} profileDir 启动时用的 --user-data-dir（用于兜底清理）
 */
function killChromeTree(child, profileDir) {
  // 1. 按启动器 PID 终止进程树
  if (child && child.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (e) { /* 进程可能已退出 */ }
    try { child.kill('SIGKILL'); } catch (e) { /* 同上 */ }
  }

  // 2. 兜底：Chrome 的真实浏览器进程并不总是启动器的子进程，
  //    因此按「命令行特征」找出残留并逐个精确终止。
  //    只杀测试特征的进程，绝不触碰用户自己的浏览器。
  if (process.platform === 'win32') {
    const needle = String(profileDir || '').replace(/\\/g, '/').toLowerCase();
    listChromeProcesses().forEach((row) => {
      const cmd = row.cmd.toLowerCase();
      const byProfile = needle && (cmd.indexOf(needle) >= 0
        || cmd.indexOf(needle.replace(/\//g, '\\')) >= 0);
      if (byProfile || isTestChrome(row.cmd)) {
        spawnSync('taskkill', ['/F', '/T', '/PID', row.pid], { stdio: 'ignore' });
      }
    });
  }

  // 3. 清掉 profile 目录（Chrome 释放文件句柄需要一点时间）
  if (profileDir) {
    for (let i = 0; i < 8; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch (e) {
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)'], { stdio: 'ignore' });
      }
    }
  }
}

/** 统计当前残留的测试用 Chrome 进程数（用于自检） */
function countTestChrome() {
  return listChromeProcesses().filter((r) => isTestChrome(r.cmd)).length;
}

module.exports = { killChromeTree, countTestChrome, listChromeProcesses, isTestChrome };
