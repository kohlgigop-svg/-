/* 一次跑完全部测试，汇总结果 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  ['内核单元测试', 'core.test.js'],
  ['集成测试', 'integration.test.js'],
  ['浏览器端到端', 'browser.e2e.js'],
  ['渲染验证', 'render.test.js'],
  ['云端端到端（需 Supabase）', 'cloud.test.js'],
  ['线上部署验收', 'live.test.js'],
];

let failed = 0;
const summary = [];

for (const [name, file] of suites) {
  process.stdout.write('\n' + '='.repeat(58) + '\n' + name + '  (' + file + ')\n' + '='.repeat(58) + '\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
  const okRun = r.status === 0;
  if (!okRun) failed++;
  summary.push({ name, ok: okRun, code: r.status });
}

console.log('\n' + '='.repeat(58));
console.log('测试汇总');
console.log('='.repeat(58));
summary.forEach((s) => console.log((s.ok ? '  ✓ ' : '  ✗ ') + s.name + (s.ok ? '' : '（退出码 ' + s.code + '）')));
console.log('');
console.log(failed === 0 ? '全部测试套件通过 ✓' : failed + ' 个测试套件失败');
process.exitCode = failed === 0 ? 0 : 1;
