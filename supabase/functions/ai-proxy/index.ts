// =============================================================================
// Supabase Edge Function: ai-proxy
// -----------------------------------------------------------------------------
// 作用：代理 DeepSeek 调用，使 API Key 只存在于服务端，前端与仓库中都不出现。
//
// 部署步骤（Supabase 控制台，无需本地 CLI）：
//   1. 左侧菜单 Edge Functions → Deploy a new function → Via Editor
//   2. 函数名填：ai-proxy
//   3. 把本文件全文粘贴进编辑器 → Deploy
//   4. 同页面 → Secrets 添加四个变量（注意名称必须完全一致）：
//        DEEPSEEK_API_KEY       = sk-你的真实key
//        ACCESS_CODE_HASH       = 访问码的 SHA-256（十六进制小写）
//        APP_SUPABASE_URL       = https://ofdtgchdkhgvksuohzoq.supabase.co
//        APP_SUPABASE_ANON_KEY  = 你的 anon public key
//
//      ⚠️ 不能用 SUPABASE_ 开头命名自定义 Secret——Supabase 保留该前缀，会报
//         "Name must not start with the SUPABASE_ prefix"。故本项目用 APP_ 前缀。
//         （Supabase 自动注入的 SUPABASE_URL / SUPABASE_ANON_KEY 也会被自动兼容使用）
//   5. 部署完成后把函数 URL 填进工具：设置 → 云端共享 → AI 代理地址
//        https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy
//
// 安全说明：
//   - Key 只从 Deno.env 读取，任何情况下都不会出现在响应里
//   - 访问码在服务端比对 SHA-256，明文既不入库也不入代码
//   - 校验调用方带有 Supabase 会话（匿名登录即可），提高滥用门槛
//   - 模型白名单 + max_tokens 上限 + 请求体大小上限，限制被滥用的损失
// =============================================================================

import { handleRequest } from './handler.js';

Deno.serve(async (req) => {
  return await handleRequest(req, {
    DEEPSEEK_API_KEY: Deno.env.get('DEEPSEEK_API_KEY'),
    ACCESS_CODE_HASH: Deno.env.get('ACCESS_CODE_HASH'),
    // 优先取 APP_ 前缀（自定义 Secret 不能用 SUPABASE_ 前缀），
    // 同时兼容平台自动注入的 SUPABASE_* 变量
    APP_SUPABASE_URL: Deno.env.get('APP_SUPABASE_URL'),
    APP_SUPABASE_ANON_KEY: Deno.env.get('APP_SUPABASE_ANON_KEY'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    DEEPSEEK_BASE: Deno.env.get('DEEPSEEK_BASE') || 'https://api.deepseek.com',
  });
});
