/* =============================================================================
 * 质检人员质量评估 · 存储层 (store)
 * -----------------------------------------------------------------------------
 * 数据全部保存在浏览器 localStorage（localStorage 不可用时退化为内存存储）。
 * 结构：
 *   qceval:projects  → { [projectId]: { id, name, createdAt, config, records[] } }
 *   qceval:settings  → { apiKey, model, obsWindow, ... }
 *   qceval:current   → 当前项目 id
 * ========================================================================== */
(function (global) {
  'use strict';

  const K_PROJECTS = 'qceval:projects';
  const K_SETTINGS = 'qceval:settings';
  const K_CURRENT = 'qceval:current';
  const SCHEMA_VERSION = 1;

  /* ---------------------------------------------------------------------------
   * 底层读写（带内存兜底）
   * ------------------------------------------------------------------------ */

  let memoryStore = {};
  let lsOk = null;

  function testLocalStorage() {
    if (lsOk !== null) return lsOk;
    try {
      const k = '__qceval_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      lsOk = true;
    } catch (e) {
      lsOk = false;
    }
    return lsOk;
  }

  function rawGet(key) {
    if (testLocalStorage()) {
      try { return global.localStorage.getItem(key); } catch (e) { /* fallthrough */ }
    }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }

  function rawSet(key, value) {
    if (testLocalStorage()) {
      try { global.localStorage.setItem(key, value); return true; } catch (e) { /* quota */ }
    }
    memoryStore[key] = value;
    return false;
  }

  function readJSON(key, fallback) {
    const raw = rawGet(key);
    if (!raw) return fallback;
    try {
      const v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    return rawSet(key, JSON.stringify(value));
  }

  /* ---------------------------------------------------------------------------
   * 设置
   * ------------------------------------------------------------------------ */

  const DEFAULT_SETTINGS = {
    apiKey: '',
    // AI 代理地址：配置后由服务端调用模型，前端不再需要 API Key（推荐）
    aiProxyUrl: '',
    model: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com',
    // deepseek-flash 为推理模型，思维链与正文共用 max_tokens，故预算须留足余量
    maxTokens: 16000,
    obsWindow: 3,          // 观察线窗口 k
    alpha: 0.05,           // 置信水平 → 1−alpha
    bootstrapB: 4000,      // Bootstrap 次数
    acceptAccuracy: 0.95,  // 默认验收准确率
    tolerancePct: 0.0,     // 观察线判定容差（相对）
    aiAutoRun: false,
    // 云端共享（Supabase）
    cloudUrl: '',
    cloudKey: '',
    cloudCode: '',
    cloudMode: 'dual',     // dual 双写 / cloud 仅云端 / local 仅本地
  };

  /* ---------------------------------------------------------------------------
   * 部署默认配置（config.js 提供）
   *   由部署方一次配置，全员打开即用；本地已保存的值优先于默认值。
   * ------------------------------------------------------------------------ */

  function deploymentConfig() {
    const c = (typeof global !== 'undefined' && global.QC_CONFIG) ? global.QC_CONFIG : {};
    return c && typeof c === 'object' ? c : {};
  }

  /** 把部署配置映射成 settings 字段（只取认识的键） */
  function configToSettings(cfg) {
    const map = {
      cloudUrl: 'cloudUrl', cloudKey: 'cloudKey', cloudCode: 'cloudCode', cloudMode: 'cloudMode',
      aiKey: 'apiKey', aiProxyUrl: 'aiProxyUrl', aiModel: 'model', aiBase: 'apiBase', aiMaxTokens: 'maxTokens',
      acceptAccuracy: 'acceptAccuracy', obsWindow: 'obsWindow', alpha: 'alpha', bootstrapB: 'bootstrapB',
    };
    const out = {};
    Object.keys(map).forEach((k) => {
      const v = cfg[k];
      if (v === undefined || v === null) return;
      // 允许用空字符串显式覆盖（用于关闭某功能，例如置空 aiProxyUrl 关闭代理）
      // 其余类型的空值视为未配置，不覆盖内置默认
      if (v === '' && typeof cfg[k] !== 'string') return;
      out[map[k]] = v;
    });
    return out;
  }

  /** 该字段是否由部署方锁定（成员不可改） */
  function isLocked(key) {
    const cfg = deploymentConfig();
    if (!cfg.lockDeployment) return false;
    const locked = {
      cloudUrl: cfg.cloudUrl, cloudKey: cfg.cloudKey, cloudCode: cfg.cloudCode,
      cloudMode: cfg.cloudMode, apiBase: cfg.aiBase, model: cfg.aiModel,
      aiProxyUrl: cfg.aiProxyUrl,
    };
    if (key === 'apiKey') {
      // 已配置代理时，前端不再需要 Key，直接锁定；否则按 allowUserAiKey 决定
      if (cfg.aiProxyUrl) return true;
      return !cfg.allowUserAiKey;
    }
    return !!locked[key];
  }

  function getSettings() {
    const cfg = deploymentConfig();
    const saved = readJSON(K_SETTINGS, {});
    // 优先级：本地已保存 > 部署配置 > 内置默认
    const out = Object.assign({}, DEFAULT_SETTINGS, configToSettings(cfg), saved);
    // 部署方锁定项一律以部署配置为准，防止成员误改导致全员不可用
    if (cfg.lockDeployment) {
      const forced = configToSettings(cfg);
      Object.keys(forced).forEach((k) => {
        if (k === 'apiKey' && cfg.allowUserAiKey) return; // Key 由成员自己填
        out[k] = forced[k];
      });
    }
    return out;
  }

  function saveSettings(patch) {
    const s = Object.assign({}, getSettings(), patch || {});
    writeJSON(K_SETTINGS, s);
    return s;
  }

  /* ---------------------------------------------------------------------------
   * 项目
   * ------------------------------------------------------------------------ */

  function uid(prefix) {
    return (prefix || 'p') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadAll() {
    const data = readJSON(K_PROJECTS, {});
    if (!data || typeof data !== 'object') return {};
    return data;
  }

  function saveAll(projects) {
    const okWrite = writeJSON(K_PROJECTS, projects);
    if (!okWrite) {
      throw new Error('保存失败：浏览器存储空间不足或被禁用。请使用「导出数据」备份。');
    }
    return projects;
  }

  function listProjects() {
    const all = loadAll();
    return Object.keys(all)
      .map((id) => {
        const p = all[id];
        return {
          id: id,
          name: p.name,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          recordCount: (p.records || []).length,
          lastDate: p.records && p.records.length ? p.records[0].periodLabel || p.records[0].savedAt : null,
        };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function getProject(id) {
    const all = loadAll();
    return all[id] || null;
  }

  function createProject(name, config) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('项目名称不能为空。');
    const all = loadAll();
    const dup = Object.keys(all).some((id) => all[id].name === trimmed);
    if (dup) throw new Error('已存在同名项目：「' + trimmed + '」。请换一个名称，或直接打开该项目。');
    const id = uid('prj');
    const now = Date.now();
    all[id] = {
      id: id,
      name: trimmed,
      createdAt: now,
      updatedAt: now,
      config: Object.assign(
        { acceptAccuracy: 0.95, obsWindow: 3, owner: '' },
        config || {}
      ),
      records: [],
    };
    saveAll(all);
    setCurrentProjectId(id);
    return all[id];
  }

  function updateProject(id, patch) {
    const all = loadAll();
    if (!all[id]) throw new Error('项目不存在。');
    if (patch.name) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new Error('项目名称不能为空。');
      const dup = Object.keys(all).some((k) => k !== id && all[k].name === trimmed);
      if (dup) throw new Error('已存在同名项目：「' + trimmed + '」。');
      all[id].name = trimmed;
    }
    if (patch.config) all[id].config = Object.assign({}, all[id].config, patch.config);
    all[id].updatedAt = Date.now();
    saveAll(all);
    return all[id];
  }

  function deleteProject(id) {
    const all = loadAll();
    if (!all[id]) return false;
    const name = all[id].name;
    delete all[id];
    saveAll(all);
    if (getCurrentProjectId() === id) {
      const remain = Object.keys(all);
      setCurrentProjectId(remain.length ? remain[0] : null);
    }
    return name;
  }

  /* ---------------------------------------------------------------------------
   * 记录（历史评估）
   * ------------------------------------------------------------------------ */

  /**
   * 新增一条评估记录。同名周期已存在时覆盖（便于修正录入错误）。
   * @param {string} projectId
   * @param {object} record 完整记录（含 input / metrics / warning / observation / verdicts）
   * @param {boolean} overwriteSamePeriod
   */
  function addRecord(projectId, record, overwriteSamePeriod) {
    const all = loadAll();
    if (!all[projectId]) throw new Error('项目不存在，无法保存记录。');
    const rec = Object.assign({}, record, {
      id: uid('rec'),
      savedAt: Date.now(),
    });

    const list = all[projectId].records || [];
    if (overwriteSamePeriod && rec.periodLabel) {
      const idx = list.findIndex((r) => r.periodLabel === rec.periodLabel);
      if (idx >= 0) {
        rec.id = list[idx].id;
        rec.updatedAt = Date.now();
        rec.revision = (list[idx].revision || 1) + 1;
        list.splice(idx, 1);
      }
    }
    list.unshift(rec); // 最新在前
    all[projectId].records = list;
    all[projectId].updatedAt = Date.now();
    saveAll(all);
    return rec;
  }

  function deleteRecord(projectId, recordId) {
    const all = loadAll();
    if (!all[projectId]) return false;
    const list = all[projectId].records || [];
    const idx = list.findIndex((r) => r.id === recordId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    all[projectId].updatedAt = Date.now();
    saveAll(all);
    return true;
  }

  function clearRecords(projectId) {
    const all = loadAll();
    if (!all[projectId]) return false;
    all[projectId].records = [];
    all[projectId].updatedAt = Date.now();
    saveAll(all);
    return true;
  }

  /** 取历史序列（不含指定记录 id），最新在前 */
  function getHistory(projectId, excludeRecordId) {
    const p = getProject(projectId);
    if (!p || !p.records) return [];
    return p.records.filter((r) => r.id !== excludeRecordId);
  }

  /** 按周期合并一条云端记录：同周期已存在则更新，否则新增 */
  function mergeRecord(projectId, record) {
    const all = loadAll();
    if (!all[projectId]) return null;
    const list = all[projectId].records || [];
    const idx = list.findIndex((r) => r.periodLabel && r.periodLabel === record.periodLabel);
    if (idx >= 0) {
      // 保留本地 id 与本地已有的云标识，仅用云端内容更新
      const merged = Object.assign({}, list[idx], record, {
        id: list[idx].id,
        savedAt: list[idx].savedAt || record.savedAt || Date.now(),
      });
      list[idx] = merged;
      all[projectId].records = list;
      all[projectId].updatedAt = Date.now();
      saveAll(all);
      return merged;
    }
    return addRecord(projectId, record, false);
  }

  /** 批量合并（云端拉取时使用），返回 {added, updated} */
  function mergeRecords(projectId, records) {
    let added = 0, updated = 0;
    const all0 = loadAll();
    if (!all0[projectId]) return { added: 0, updated: 0 };
    const before = (all0[projectId].records || []).map((r) => r.periodLabel);
    for (const rec of records) {
      const existed = before.indexOf(rec.periodLabel) >= 0;
      mergeRecord(projectId, rec);
      if (existed) updated++; else { added++; before.push(rec.periodLabel); }
    }
    return { added: added, updated: updated };
  }

  /**
   * 权威对齐：让本地缓存「完全等于」云端内容。
   *
   * 与 mergeRecords 的区别（这是多用户场景的关键）：
   *   mergeRecords   只增改，从不删除 → 别人删掉的记录会永远残留在本机，
   *                  更严重的是下次保存会把残留记录重新写回云端（复活）。
   *   mergeRecordsAuthoritative  以云端为准：云端有什么就留什么，
   *                  本地有而云端没有的一律移除。
   *
   * 因此凡是以云端为数据源的场景（cloudMode 为 cloud/dual 时的拉取），
   * 都必须用这个函数，而不是 mergeRecords。
   *
   * @returns {{added:number, updated:number, removed:number, total:number}}
   */
  function mergeRecordsAuthoritative(projectId, records) {
    const all = loadAll();
    if (!all[projectId]) return { added: 0, updated: 0, removed: 0, total: 0 };
    const local = all[projectId].records || [];

    // 云端本周期集合
    const remotePeriods = {};
    records.forEach((r) => { if (r.periodLabel) remotePeriods[r.periodLabel] = true; });

    // 1. 移除本地有、云端没有的记录（别人删掉的）
    const kept = local.filter((r) => r.periodLabel && remotePeriods[r.periodLabel]);
    const removed = local.length - kept.length;

    // 2. 以云端内容覆盖/新增，同时保留本地 id 以维持界面引用稳定
    const byPeriod = {};
    kept.forEach((r) => { byPeriod[r.periodLabel] = r; });

    let added = 0, updated = 0;
    const next = records.map((rec) => {
      const exist = byPeriod[rec.periodLabel];
      if (exist) {
        updated++;
        return Object.assign({}, exist, rec, {
          id: exist.id,                                    // 保留本地 id
          savedAt: exist.savedAt || rec.savedAt || Date.now(),
        });
      }
      added++;
      return Object.assign({}, rec, { id: uid('rec'), savedAt: rec.savedAt || Date.now() });
    });

    next.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    all[projectId].records = next;
    all[projectId].updatedAt = Date.now();
    saveAll(all);
    return { added: added, updated: updated, removed: removed, total: next.length };
  }

  /**
   * 移除本地「不在云端」的项目（云端已删的项目不应残留）。
   * 仅当调用方确认本次是完整拉取时才可调用。
   *
   * 注意：这里刻意不做「当前项目豁免」。曾经为了避免界面空转而保留当前项目，
   * 结果导致「别人删掉的、恰好是你当前打开的项目」会永久残留在下拉框里。
   * 当前项目被移除后，getCurrentProjectId() 会自动回退到第一个可用项目，
   * 因此不需要豁免。
   *
   * @param {string[]} remoteNames 云端存在的项目名（本次完整拉取的结果）
   * @returns {string[]} 被移除的项目名
   */
  function pruneProjectsNotIn(remoteNames) {
    const all = loadAll();
    const keep = {};
    (remoteNames || []).forEach((n) => { keep[n] = true; });
    const removed = [];
    Object.keys(all).forEach((id) => {
      if (!keep[all[id].name]) {
        removed.push(all[id].name);
        delete all[id];
      }
    });
    if (removed.length) {
      saveAll(all);
      // 清理已失效的「当前项目」记录
      const cur = rawGet(K_CURRENT);
      if (cur && !all[cur]) rawSet(K_CURRENT, '');
    }
    return removed;
  }

  /** 给指定周期的记录回填云端标识（不改变其它字段） */
  function setCloudMeta(projectId, periodLabel, cloudId, submitter) {
    const all = loadAll();
    if (!all[projectId]) return false;
    const rec = (all[projectId].records || []).find((r) => r.periodLabel === periodLabel);
    if (!rec) return false;
    rec.cloudId = cloudId || null;
    rec.cloudSubmitter = submitter || null;
    all[projectId].updatedAt = Date.now();
    saveAll(all);
    return true;
  }

  /** 按项目名查找，找不到则以指定 id 创建（云端拉取时用） */
  function ensureProject(name, id, config) {
    const all = loadAll();
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const found = Object.keys(all).find((k) => all[k].name === trimmed);
    if (found) {
      if (config) all[found].config = Object.assign({}, all[found].config, config);
      saveAll(all);
      return all[found];
    }
    const pid = id && !all[id] ? id : uid('prj');
    const now = Date.now();
    all[pid] = {
      id: pid,
      name: trimmed,
      createdAt: now,
      updatedAt: now,
      config: Object.assign({ acceptAccuracy: 0.95, obsWindow: 3 }, config || {}),
      records: [],
      cloudId: id || null,
    };
    saveAll(all);
    return all[pid];
  }

  /** 删除本地项目（不触发当前项目切换提示） */
  function removeProject(id) {
    return deleteProject(id);
  }

  /* ---------------------------------------------------------------------------
   * 当前项目
   * ------------------------------------------------------------------------ */

  function getCurrentProjectId() {
    const id = rawGet(K_CURRENT);
    if (id && getProject(id)) return id;
    const list = listProjects();
    return list.length ? list[0].id : null;
  }

  function setCurrentProjectId(id) {
    if (id === null || id === undefined) {
      rawSet(K_CURRENT, '');
      return;
    }
    rawSet(K_CURRENT, id);
  }

  /* ---------------------------------------------------------------------------
   * 导入 / 导出
   * ------------------------------------------------------------------------ */

  function exportAll() {
    return {
      schema: SCHEMA_VERSION,
      app: 'qc-eval',
      exportedAt: new Date().toISOString(),
      settings: getSettings(),
      projects: loadAll(),
    };
  }

  /**
   * @param {object} payload exportAll() 的结果
   * @param {string} mode 'merge' 合并（同名项目追加，按周期去重） | 'replace' 覆盖
   */
  function importAll(payload, mode) {
    if (!payload || typeof payload !== 'object') throw new Error('导入文件格式无法识别。');
    if (payload.app !== 'qc-eval') throw new Error('这不是本工具导出的数据文件（缺少 app 标识）。');
    const incoming = payload.projects || {};
    const result = { projects: 0, records: 0, settings: false };

    if (mode === 'replace') {
      saveAll(incoming);
      result.projects = Object.keys(incoming).length;
      result.records = Object.keys(incoming).reduce(
        (a, k) => a + ((incoming[k].records || []).length), 0);
      if (payload.settings) { saveSettings(payload.settings); result.settings = true; }
      setCurrentProjectId(Object.keys(incoming)[0] || null);
      return result;
    }

    const all = loadAll();
    for (const id of Object.keys(incoming)) {
      const src = incoming[id];
      if (!src || !src.name) continue;
      // 同名项目 → 视为同一项目，按周期去重后合并
      let targetId = Object.keys(all).find((k) => all[k].name === src.name);
      if (!targetId) {
        targetId = id && !all[id] ? id : uid('prj');
        all[targetId] = {
          id: targetId,
          name: src.name,
          createdAt: src.createdAt || Date.now(),
          updatedAt: Date.now(),
          config: src.config || {},
          records: [],
        };
        result.projects++;
      }
      const existingPeriods = new Set((all[targetId].records || []).map((r) => r.periodLabel));
      for (const rec of src.records || []) {
        if (rec.periodLabel && existingPeriods.has(rec.periodLabel)) continue;
        (all[targetId].records = all[targetId].records || []).push(rec);
        existingPeriods.add(rec.periodLabel);
        result.records++;
      }
      all[targetId].records.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
    saveAll(all);
    if (payload.settings) {
      const cur = getSettings();
      // 合并时只在本地未设置 key 的情况下引入对方 key
      const merged = Object.assign({}, payload.settings);
      if (cur.apiKey) merged.apiKey = cur.apiKey;
      saveSettings(merged);
      result.settings = true;
    }
    return result;
  }

  /** 仅导出单个项目 */
  function exportProject(projectId) {
    const p = getProject(projectId);
    if (!p) throw new Error('项目不存在。');
    const wrap = {};
    wrap[projectId] = p;
    return {
      schema: SCHEMA_VERSION,
      app: 'qc-eval',
      exportedAt: new Date().toISOString(),
      projects: wrap,
    };
  }

  /** 存储占用估算（字节） */
  function storageSize() {
    const raw = rawGet(K_PROJECTS) || '';
    return raw.length;
  }

  /* ---------------------------------------------------------------------------
   * 配置串的导出与导入（用于管理员一次配置、分发给成员）
   * ------------------------------------------------------------------------ */

  /** 需要随配置串分发的字段 */
  const CONFIG_KEYS = [
    'apiKey', 'aiProxyUrl', 'model', 'apiBase', 'maxTokens',
    'cloudUrl', 'cloudKey', 'cloudCode', 'cloudMode',
    'acceptAccuracy', 'obsWindow', 'alpha', 'bootstrapB',
  ];

  /**
   * 导出配置串：base64(JSON)，一段文本即可发给成员粘贴。
   * @param {boolean} includeAiKey 是否包含 AI Key（默认包含——这正是本功能的目的）
   */
  function exportConfigString(includeAiKey) {
    const s = getSettings();
    const payload = { app: 'qc-eval-config', v: 1, at: new Date().toISOString(), data: {} };
    CONFIG_KEYS.forEach((k) => {
      if (k === 'apiKey' && includeAiKey === false) return;
      if (s[k] !== undefined && s[k] !== null && s[k] !== '') payload.data[k] = s[k];
    });
    let json = JSON.stringify(payload);
    // 浏览器与非浏览器环境都能用
    if (typeof btoa === 'function') {
      return 'QCEVAL1:' + btoa(unescape(encodeURIComponent(json)));
    }
    return 'QCEVAL1_JSON:' + json;
  }

  /**
   * 导入配置串，写入本机设置
   * @returns {{applied:string[], skipped:string[]}}
   */
  function importConfigString(str) {
    const text = String(str || '').trim();
    if (!text) throw new Error('配置串为空。');
    let json = null;
    if (text.indexOf('QCEVAL1:') === 0) {
      const b64 = text.slice('QCEVAL1:'.length).trim();
      try {
        json = decodeURIComponent(escape(atob(b64)));
      } catch (e) {
        throw new Error('配置串格式不正确（base64 解析失败）。请确认复制完整。');
      }
    } else if (text.indexOf('QCEVAL1_JSON:') === 0) {
      json = text.slice('QCEVAL1_JSON:'.length);
    } else if (text.charAt(0) === '{') {
      json = text; // 直接粘 JSON 也支持
    } else {
      throw new Error('无法识别的配置串格式。应以 QCEVAL1: 开头，或直接粘贴 JSON。');
    }

    let payload = null;
    try { payload = JSON.parse(json); } catch (e) { throw new Error('配置串内容不是合法 JSON。'); }
    if (!payload || payload.app !== 'qc-eval-config') {
      throw new Error('这不是本工具的配置串（缺少 app 标识）。注意：数据备份文件不能用于此处。');
    }
    const data = payload.data || {};
    const applied = [];
    const skipped = [];
    const patch = {};
    CONFIG_KEYS.forEach((k) => {
      if (data[k] === undefined || data[k] === null || data[k] === '') { skipped.push(k); return; }
      patch[k] = data[k];
      applied.push(k);
    });
    saveSettings(patch);
    return { applied: applied, skipped: skipped };
  }

  /* ---------------------------------------------------------------------------
   * 导出
   * ------------------------------------------------------------------------ */

  const Store = {
    K_PROJECTS: K_PROJECTS,
    getSettings: getSettings,
    saveSettings: saveSettings,
    deploymentConfig: deploymentConfig,
    isLocked: isLocked,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    /** 导出可分享的配置串（不含本机业务数据） */
    exportConfigString: exportConfigString,
    /** 从配置串导入 */
    importConfigString: importConfigString,
    listProjects: listProjects,
    getProject: getProject,
    createProject: createProject,
    updateProject: updateProject,
    deleteProject: deleteProject,
    addRecord: addRecord,
    deleteRecord: deleteRecord,
    clearRecords: clearRecords,
    getHistory: getHistory,
    mergeRecord: mergeRecord,
    mergeRecords: mergeRecords,
    mergeRecordsAuthoritative: mergeRecordsAuthoritative,
    pruneProjectsNotIn: pruneProjectsNotIn,
    setCloudMeta: setCloudMeta,
    ensureProject: ensureProject,
    removeProject: removeProject,
    getCurrentProjectId: getCurrentProjectId,
    setCurrentProjectId: setCurrentProjectId,
    exportAll: exportAll,
    exportProject: exportProject,
    importAll: importAll,
    storageSize: storageSize,
    isPersistent: testLocalStorage,
    uid: uid,
  };

  global.QCStore = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
