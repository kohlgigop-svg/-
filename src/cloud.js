/* =============================================================================
 * 质检人员质量评估工具 · 云端同步 (cloud)
 * -----------------------------------------------------------------------------
 * 后端：Supabase（免费层）。全部走 REST + Auth，零外部依赖，不需要构建。
 *
 * 安全模型：
 *   - 访问码在数据库函数内校验（比对 SHA-256 哈希），明文不入库
 *   - 表已开启行级权限且未对 anon 授权，直接访问表会被拒绝；读写一律走 RPC
 *   - 用 Supabase 匿名登录拿到 auth.uid()，据此实现「仅本人可改删」
 *   - 本模块只接触 anon key；service_role key 绝不会被使用
 * ========================================================================== */
(function (global) {
  'use strict';

  const SESSION_KEY = 'qceval:cloud:session';

  function cfgFrom(settings) {
    const s = settings || {};
    return {
      url: String(s.cloudUrl || '').trim().replace(/\/+$/, ''),
      key: String(s.cloudKey || '').trim(),
      code: String(s.cloudCode || ''),
    };
  }

  /** 把控制台地址自动换算成 API 地址（用户很容易填错） */
  function normalizeUrl(input) {
    let u = String(input || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    const m = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (m) return 'https://' + m[1] + '.supabase.co';
    const m2 = u.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
    if (m2) return 'https://' + m2[1] + '.supabase.co';
    if (/^[a-z0-9]{15,}$/i.test(u)) return 'https://' + u + '.supabase.co';
    return u;
  }

  /**
   * 归一化 AI 代理地址。
   * 不能用 normalizeUrl：那个函数会把路径截掉（如 /functions/v1/ai-proxy 会丢失）。
   * 这里只做三件事：去空白、去尾部斜杠、把控制台地址补成完整函数地址。
   */
  function normalizeProxyUrl(input) {
    let u = String(input || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    // 用户误填控制台地址 → 补成默认函数路径
    const dash = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (dash) return 'https://' + dash[1] + '.supabase.co/functions/v1/ai-proxy';
    // 只填了项目 ref → 补全
    if (/^[a-z0-9]{15,}$/i.test(u)) return 'https://' + u + '.supabase.co/functions/v1/ai-proxy';
    // 填了项目域名但没带路径 → 补默认函数路径
    const host = u.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co$/i);
    if (host) return 'https://' + host[1] + '.supabase.co/functions/v1/ai-proxy';
    return u;
  }

  function isConfigured(settings) {
    const c = cfgFrom(settings);
    return !!(c.url && c.key && c.code);
  }

  function isConnected(settings) {
    if (!isConfigured(settings)) return false;
    return !!loadSession();
  }

  /* ---------------------------------------------------------------------------
   * 会话（Supabase 匿名登录）
   * ------------------------------------------------------------------------ */

  function loadSession() {
    try {
      const raw = global.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.access_token) return null;
      return s;
    } catch (e) { return null; }
  }

  function saveSession(s) {
    try {
      if (s) global.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else global.localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 忽略 */ }
  }

  async function readError(resp) {
    let text = '';
    try { text = await resp.text(); } catch (e) { /* 忽略 */ }
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.message || j.msg || j.error_description || j.hint || msg;
      if (j.code) msg = '[' + j.code + '] ' + msg;
    } catch (e) { /* 保持原文 */ }
    const err = new Error(msg || ('HTTP ' + resp.status));
    err.status = resp.status;
    return err;
  }

  /** 把数据库抛出的业务错误翻译成人话 */
  function humanize(msg) {
    const m = String(msg || '');
    if (/ACCESS_DENIED/.test(m)) return '访问码不正确。请核对设置里的访问码，以及数据库里的哈希是否与访问码匹配。';
    if (/NO_SESSION/.test(m)) return '未取得匿名登录会话。请确认 Supabase 已开启 Anonymous sign-ins，然后刷新页面重试。';
    if (/NOT_OWNER/.test(m)) return '该记录由其他成员提交，你只能修改或删除自己提交的记录。';
    if (/PROJECT_HAS_OTHERS_RECORDS/.test(m)) return '该项目下存在其他成员提交的记录，无法整体删除。';
    if (/PROJECT_NAME_EMPTY/.test(m)) return '项目名称不能为空。';
    if (/PERIOD_EMPTY/.test(m)) return '评估周期不能为空。';
    if (/anonymous_provider_disabled/.test(m)) return 'Supabase 未开启匿名登录（Authentication → Sign In / Providers → Anonymous sign-ins）。';
    if (/Could not find the function/.test(m)) return '数据库里没有找到所需函数，schema.sql 可能未执行成功。请到 SQL Editor 重新完整执行一遍。';
    if (/Invalid API key/.test(m)) return 'anon key 无效，请到 Project Settings → API 重新复制 anon public key。';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return '网络请求失败：可能是地址填错或网络不通。请核对 Supabase URL（应为 https://<项目ref>.supabase.co）。';
    return m;
  }

  /** 匿名登录（已有未过期会话则复用） */
  async function signInAnon(settings, force) {
    const c = cfgFrom(settings);
    if (!c.url || !c.key) throw new Error('请先填写 Supabase URL 与 anon key。');

    if (!force) {
      const existing = loadSession();
      if (existing && existing.access_token) {
        // 快过期（5 分钟内）则先刷新
        const exp = existing.expires_at ? existing.expires_at * 1000 : 0;
        if (!exp || exp - Date.now() > 5 * 60 * 1000) return existing;
      }
    }

    const resp = await fetch(c.url + '/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
    });
    if (!resp.ok) throw new Error(humanize(await readError(resp).then((e) => e.message)));

    const j = await resp.json();
    if (!j.access_token) throw new Error('匿名登录未返回会话，请确认已开启 Anonymous sign-ins。');
    const session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
      user_id: j.user ? j.user.id : null,
    };
    saveSession(session);
    return session;
  }

  async function ensureToken(settings) {
    const c = cfgFrom(settings);
    let session = loadSession();

    if (session && session.refresh_token) {
      const exp = session.expires_at ? session.expires_at * 1000 : 0;
      if (exp && exp - Date.now() < 60 * 1000) {
        try {
          const resp = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: c.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          if (resp.ok) {
            const j = await resp.json();
            session = {
              access_token: j.access_token,
              refresh_token: j.refresh_token || session.refresh_token,
              expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
              user_id: j.user ? j.user.id : session.user_id,
            };
            saveSession(session);
          }
        } catch (e) { /* 刷新失败则退回重新登录 */ }
      }
    }

    if (!session) session = await signInAnon(settings, true);
    return session;
  }

  function currentUserId() {
    const s = loadSession();
    return s ? s.user_id : null;
  }

  /** 当前会话令牌（用于调用需要身份的服务端函数，如 AI 代理） */
  function sessionToken() {
    const s = loadSession();
    return s ? s.access_token : null;
  }

  /* ---------------------------------------------------------------------------
   * RPC 调用
   * ------------------------------------------------------------------------ */

  async function rpc(settings, fn, args) {
    const c = cfgFrom(settings);
    if (!isConfigured(settings)) throw new Error('云端未配置：请在「设置」中填写 Supabase URL、anon key 与访问码。');

    const session = await ensureToken(settings);
    const headers = {
      apikey: c.key,
      Authorization: 'Bearer ' + session.access_token,
      'Content-Type': 'application/json',
    };

    let resp;
    try {
      resp = await fetch(c.url + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers: headers, body: JSON.stringify(args || {}),
      });
    } catch (e) {
      throw new Error(humanize(e.message));
    }

    // 令牌过期 → 重新登录后重试一次
    if (resp.status === 401) {
      saveSession(null);
      const fresh = await signInAnon(settings, true);
      try {
        resp = await fetch(c.url + '/rest/v1/rpc/' + fn, {
          method: 'POST',
          headers: { apikey: c.key, Authorization: 'Bearer ' + fresh.access_token, 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
        });
      } catch (e) {
        throw new Error(humanize(e.message));
      }
    }

    if (!resp.ok) {
      const err = await readError(resp);
      throw new Error(humanize(err.message));
    }

    const text = await resp.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  /* ---------------------------------------------------------------------------
   * 对外接口
   * ------------------------------------------------------------------------ */

  /** 测试连接：登录 + 校验访问码 */
  async function connect(settings) {
    const c = cfgFrom(settings);
    if (!c.url || !c.key) throw new Error('请先填写 Supabase URL 与 anon key。');
    if (!c.code) throw new Error('请填写访问码。');
    const session = await signInAnon(settings, true);
    const ok = await rpc(settings, 'qc_check_access', { p_code: c.code });
    if (ok !== true) throw new Error('访问码校验未通过。请核对访问码，或检查数据库里的哈希是否与访问码一致。');
    return { userId: session.user_id };
  }

  function disconnect() {
    saveSession(null);
  }

  /** 拉取云端全部项目与记录 */
  async function fetchAll(settings) {
    const data = await rpc(settings, 'qc_fetch_all', { p_code: cfgFrom(settings).code });
    return Array.isArray(data) ? data : [];
  }

  /** 上传（同项目同周期视为修订，仅本人可改） */
  async function upsertRecord(settings, payload) {
    return rpc(settings, 'qc_upsert_record', {
      p_code: cfgFrom(settings).code,
      p_project_name: payload.projectName,
      p_period: payload.periodLabel,
      p_inspector: payload.inspector || null,
      p_payload: payload.payload,
    });
  }

  async function deleteRecord(settings, recordId) {
    return rpc(settings, 'qc_delete_record', { p_code: cfgFrom(settings).code, p_record_id: recordId });
  }

  async function deleteProject(settings, projectId) {
    return rpc(settings, 'qc_delete_project', { p_code: cfgFrom(settings).code, p_project_id: projectId });
  }

  async function renameProject(settings, projectId, newName) {
    return rpc(settings, 'qc_rename_project', {
      p_code: cfgFrom(settings).code, p_project_id: projectId, p_new_name: newName,
    });
  }

  /* ---------------------------------------------------------------------------
   * 同步编排：云端 → 本地合并（本地为缓存，云端为准）
   * ------------------------------------------------------------------------ */

  /**
   * @param {object} settings
   * @param {object} hooks {
   *   ensureProject(name, cloudId, config),
   *   mergeRecordsAuthoritative(projectId, records),   // 以云端为准（含删除）
   *   pruneProjectsNotIn(names, keepCurrentId),
   *   currentProjectId()
   * }
   * @returns {{projects:number, records:number, added:number, updated:number, removed:number, prunedProjects:string[]}}
   */
  async function syncToLocal(settings, hooks) {
    const remote = await fetchAll(settings);
    const stats = { projects: 0, records: 0, added: 0, updated: 0, removed: 0, prunedProjects: [] };
    const remoteNames = remote.map((rp) => rp.project_name);

    for (const rp of remote) {
      const local = hooks.ensureProject(rp.project_name, rp.project_id, null);
      if (!local) continue;
      stats.projects++;
      const recs = (rp.records || []).map((r) => ({
        periodLabel: r.periodLabel,
        input: r.payload && r.payload.input ? r.payload.input : {},
        counts: r.payload && r.payload.counts ? r.payload.counts : {},
        metrics: r.payload && r.payload.metrics ? r.payload.metrics : {},
        effSS: r.payload ? r.payload.effSS : null,
        warning: r.payload ? r.payload.warning : null,
        observation: r.payload ? r.payload.observation : null,
        verdicts: r.payload ? r.payload.verdicts : null,
        recallVerdict: r.payload ? r.payload.recallVerdict : null,
        diagnostics: r.payload && r.payload.diagnostics ? r.payload.diagnostics : [],
        acceptAccuracy: r.payload ? r.payload.acceptAccuracy : null,
        obsWindow: r.payload ? r.payload.obsWindow : null,
        aiSummary: r.payload ? r.payload.aiSummary : null,
        computedAt: r.payload ? r.payload.computedAt : null,
        savedAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
        cloudId: r.id,
        cloudSubmitter: r.submitter,
        cloudRevision: r.revision,
      }));

      // 以云端为准地全量对齐：本地多出来的记录（他人已删）会被移除。
      // 这一步是防止「已删除记录被复活」的关键。
      const one = hooks.mergeRecordsAuthoritative
        ? hooks.mergeRecordsAuthoritative(local.id, recs)
        : hooks.mergeRecords(local.id, recs);
      stats.records += recs.length;
      stats.added += one.added;
      stats.updated += one.updated;
      stats.removed += one.removed || 0;
    }

    // 云端已不存在的项目也要从本地清掉（否则会永远残留在项目下拉框里）
    if (hooks.pruneProjectsNotIn) {
      stats.prunedProjects = hooks.pruneProjectsNotIn(remoteNames);
    }

    return stats;
  }

  global.QCCloud = {
    normalizeUrl: normalizeUrl,
    normalizeProxyUrl: normalizeProxyUrl,
    isConfigured: isConfigured,
    isConnected: isConnected,
    connect: connect,
    disconnect: disconnect,
    fetchAll: fetchAll,
    upsertRecord: upsertRecord,
    deleteRecord: deleteRecord,
    deleteProject: deleteProject,
    renameProject: renameProject,
    syncToLocal: syncToLocal,
    currentUserId: currentUserId,
    sessionToken: sessionToken,
    humanize: humanize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.QCCloud;
})(typeof globalThis !== 'undefined' ? globalThis : this);
