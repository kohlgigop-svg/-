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
    model: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com',
    obsWindow: 3,          // 观察线窗口 k
    alpha: 0.05,           // 置信水平 → 1−alpha
    bootstrapB: 4000,      // Bootstrap 次数
    acceptAccuracy: 0.95,  // 默认验收准确率
    tolerancePct: 0.0,     // 观察线判定容差（相对）
    aiAutoRun: false,
  };

  function getSettings() {
    const s = readJSON(K_SETTINGS, {});
    const out = Object.assign({}, DEFAULT_SETTINGS, s);
    // 旧版内置 key 迁移：若曾把 key 写进代码，允许旧值延续，但不写入默认值
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
   * 导出
   * ------------------------------------------------------------------------ */

  const Store = {
    K_PROJECTS: K_PROJECTS,
    getSettings: getSettings,
    saveSettings: saveSettings,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    listProjects: listProjects,
    getProject: getProject,
    createProject: createProject,
    updateProject: updateProject,
    deleteProject: deleteProject,
    addRecord: addRecord,
    deleteRecord: deleteRecord,
    clearRecords: clearRecords,
    getHistory: getHistory,
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
