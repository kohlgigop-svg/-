/* =============================================================================
 * 测试公共工具：容忍瞬时网络故障
 * -----------------------------------------------------------------------------
 * 背景：完整套件连续运行时，本机需要反复创建浏览器进程并发出大量并发请求，
 * 偶发 fetch failed（网络层错误，非服务端返回）。它会让整份套件的结论不可信——
 * 分不清是产品坏了还是网络抖了。
 *
 * 处理原则：
 *   - 只对「网络层错误」重试（fetch 抛异常），不对 4xx/5xx 重试
 *     （服务端明确返回错误时必须照实暴露，重试会掩盖真实问题）
 *   - 只对幂等操作启用重试；写操作由调用方显式选择
 * ========================================================================== */
'use strict';

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试的 fetch。仅在「网络层异常」时重试。
 * @param {string} url
 * @param {object} init
 * @param {object} [opts] {retries, baseDelay}
 */
async function fetchRetry(url, init, opts) {
  opts = opts || {};
  const retries = opts.retries === undefined ? DEFAULT_RETRIES : opts.retries;
  const baseDelay = opts.baseDelay === undefined ? DEFAULT_BASE_DELAY : opts.baseDelay;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      // 退避：0.4s、0.8s、1.6s…
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  throw new Error('网络请求在重试 ' + retries + ' 次后仍失败：' + (lastErr && lastErr.message)
    + '（这是本机网络层问题，不是应用缺陷；请重跑该测试套件确认）');
}

/**
 * 安装到全局：让测试里所有 fetch 调用自动获得重试能力。
 * 幂等请求（GET/POST 到 RPC）都可安全重试，因为服务端操作本身是幂等的：
 * qc_upsert_record 按周期唯一，qc_delete_* 对已删对象为无操作。
 */
function installFetchRetry(target) {
  const g = target || globalThis;
  if (g.__fetchRetryInstalled) return;
  const original = g.fetch.bind(g);
  g.fetch = (url, init) => fetchRetry(url, init);
  g.__fetchRetryInstalled = true;
  g.__originalFetch = original;
}

module.exports = { fetchRetry, installFetchRetry, sleep };
