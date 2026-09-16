/* =============================================================================
 * 质检人员质量评估工具 · 部署默认配置
 * -----------------------------------------------------------------------------
 * 这是「管理员一次配置、全员打开即用」的入口。改完这个文件重新发布，
 * 其他成员打开页面时这些值会自动填好，不需要任何人再输入。
 *
 * ⚠️ 本仓库是公开的，请严格遵守下面每个字段的安全性说明：
 *
 *   cloudUrl / cloudKey（Supabase URL 与 anon key）
 *     ✅ 可以安全写死。Supabase 的 anon key 设计上就是给前端用的公开密钥，
 *        真正的保护来自数据库行级权限——实测拿它直连数据表会被拒绝（HTTP 403）。
 *
 *   aiKey（DeepSeek API Key）
 *     ❌ 绝对不要写死在这个文件里。写进去等于把你的充值卡贴在公网上：
 *        任何人查看页面源码即可抄走并消耗你的额度，且有专门的机器人扫描
 *        GitHub 上的密钥。留空即可，用户首次使用时在「设置」里填一次，
 *        之后存在他自己的浏览器里，不用重复输入。
 *
 *        如果你确实希望全员零输入，有两个正规做法（见 README「AI Key 部署」一节）：
 *          方案 A：改成在 Supabase Edge Function 里代理调用（密钥只存服务端）
 *          方案 B：在本机「设置」中配置好后导出配置串，发到内部群里，
 *                  成员用「设置 → 导入配置」粘贴一次即可
 *
 *   cloudCode（访问码）
 *     ⚠️ 会写进公开仓库，因此不要用真正保密的访问码；
 *        或者按 supabase/README.md 的办法换成自己的访问码并改用配置串分发。
 * ========================================================================== */
(function (global) {
  'use strict';

  global.QC_CONFIG = {
    /* ---------- 云端共享（可安全公开） ---------- */
    // 填控制台地址也可以，工具会自动换算成接口地址
    cloudUrl: 'https://ofdtgchdkhgvksuohzoq.supabase.co',
    cloudKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZHRnY2hka2hndmtzdW9oem9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1MTkwOTcsImV4cCI6MjEwNTA5NTA5N30.7tZhOUgN-VOLjUUzZveHrnEKECTZhEI7-DFXoUq3xRw',
    cloudCode: 'qc-eval-2026',
    cloudMode: 'dual',

    /* ---------- AI 模型（⚠️ 不要在此填 Key，见上方说明） ---------- */
    aiKey: '',
    aiModel: 'deepseek-flash',
    aiBase: 'https://api.deepseek.com',
    aiMaxTokens: 16000,

    /* ---------- 计算默认值 ---------- */
    acceptAccuracy: 0.95,   // 需求方要求的验收准确率
    obsWindow: 3,           // 观察线窗口 k
    alpha: 0.05,            // 置信水平 95%
    bootstrapB: 4000,       // Bootstrap 次数

    /* ---------- 部署选项 ---------- */
    // true：锁定上述由部署方指定的项，界面隐藏对应输入框，防止成员误改。
    // 成员仍可自由使用「项目 / 记录」等业务数据。
    lockDeployment: true,
    // true：允许成员在「设置」里自行填写 AI Key（推荐开启，除非已用服务端代理）
    allowUserAiKey: true,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
