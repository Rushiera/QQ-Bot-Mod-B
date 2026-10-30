// navigator/persona.js —— 话术 / 教材自持面（N6 清单 #4）
//
// 职责：把领航员的前文教材收进单体，供判断器（intent.js）与后续 live 路径同源使用。
//   三级回落，每一级都可观测（回执带 source，绝不静默换源）：
//     ① business —— 业务面 `_unpack/data/config.json` 的 `persona.roleText`（现行真相源，改动仍在它那边生效）
//     ② files    —— 项目根 `role/*.md`（按需教材三件，与 apply-qqagent-config.mjs 落盘同源）
//     ③ builtin  —— 内置最小集（业务面未装 / 文件丢失时的保底——只保证「知道自己是领航员、投递不裁剪」）
//
// 边界：本模块只**读**教材，不写、不改配置、不发群。
//   为什么要有它：教材现由 `tools/apply-qqagent-config.mjs` 生成，判断器若直接吃那份配置，
//   就会在业务面被摘掉后一起失效——迁到单体后教材必须与判断器同进程、同一次加载。
// 设计：design-qqbotb-navigator.md §十二 · reports/R3-L8.md §二 #4。

import fs from 'node:fs';
import path from 'node:path';

/** 按需教材三件（与 `apply-qqagent-config.mjs` 的 roleFiles 同名）。 */
const ROLE_FILES = Object.freeze(['nav-rules.md', 'media-rules.md', 'blocked-rules.md']);

/** 内置最小集——三级回落的最后一档（业务面未装 / 文件丢失时用）。 */
const BUILTIN_QUICK = [
  '## 领航员（快速版）',
  '- 你是 QQ 群里的领航员——借你指挥 CH4 的猫群干活；指挥权只归 QQ 569145850 本人。',
  '- 判断：点名了猫、或带任务动词（看 / 查 / 改 / 跑 / 写 / 整理 / 检查）= 指令，整段原文投给那只猫；寒暄吐槽 = 闲聊，不投递；拿不准按闲聊走。',
  '- 称呼前缀不是叫你转达：「跟 X 说 / 告诉 X / 让 X 做」里的 X 就是收件猫。',
  '- 投递照抄原文——不改写、不裁剪、不加来源头。',
  '- 要「回执 / 进度 / 截图」是只读请求，绝不为了看状态去投递。'
].join('\n');

/**
 * 按 `## ` 标题切段（保留标题行；一级标题行不入段——它只是文件名）。
 *
 * @param {string} text 全文
 * @returns {Array<{title: string, body: string}>} 段清单
 */
export function splitSections(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const out = [];
  let current = { title: '', lines: [] };
  for (const line of source.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (current.title || current.lines.length) out.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [line] };
      continue;
    }
    // 一级标题是文档名，不是段——直接跳过（role/*.md 首行即此形态）
    if (/^#\s+/.test(line)) continue;
    current.lines.push(line);
  }
  if (current.title || current.lines.length) out.push(current);
  return out
    .filter((sec) => sec.title || sec.lines.some((line) => line.trim()))
    .map((sec) => ({ title: sec.title, body: sec.lines.join('\n').trim() }));
}

/**
 * 判断文本是否像一份可用的教材（长度 + 至少一个段标题）。
 *
 * @param {string} text 候选文本
 * @returns {boolean} 是否可用
 */
export function looksLikeRoleText(text) {
  const source = String(text ?? '');
  return source.length >= 200 && /^##\s+/m.test(source);
}

/**
 * 创建话术服务。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.projectDir 项目根（QQBotB/）
 * @param {object} [options.config] 生效配置（可选——预留 navigator.persona 覆盖）
 * @returns {object} 话术服务
 */
export function createPersonaService({ log, projectDir, config = {} }) {
  const conf = config?.navigator?.persona ?? {};
  const roleDir = path.join(projectDir, String(conf.roleDir || 'role'));
  const bizConfig = path.join(projectDir, '_unpack', 'data', 'config.json');

  /** 当前生效的教材缓存。 */
  let cache = { roleText: '', source: 'empty', chars: 0, at: 0, sections: [], note: '' };

  /** 按需教材文件缓存（name → { body, at, source }）。 */
  const fileCache = new Map();

  /**
   * 第一级：读业务面配置里的 roleText。
   *
   * @returns {{roleText: string, note: string}} 结果
   */
  function readBusiness() {
    try {
      const raw = fs.readFileSync(bizConfig, 'utf8').replace(/^\uFEFF/, '');
      const roleText = String(JSON.parse(raw)?.persona?.roleText ?? '');
      if (looksLikeRoleText(roleText)) return { roleText, note: '' };
      return { roleText: '', note: '业务面 roleText 缺失或不完整' };
    } catch (error) {
      return { roleText: '', note: `业务面配置不可读：${error?.message ?? error}` };
    }
  }

  /**
   * 第二级：按需教材三件拼一份（去掉各自的一级标题，用 `##` 段）。
   *
   * @returns {{roleText: string, note: string}} 结果
   */
  function readFiles() {
    const parts = [];
    const missing = [];
    for (const name of ROLE_FILES) {
      const file = path.join(roleDir, name);
      try {
        const body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
        if (!body) {
          missing.push(name);
          continue;
        }
        parts.push(body.replace(/^#\s+.*\r?\n/, ''));
      } catch {
        missing.push(name);
      }
    }
    if (!parts.length) return { roleText: '', note: `role/ 下无可用教材（缺 ${missing.join(' / ')}）` };
    const roleText = parts.join('\n\n');
    return { roleText, note: missing.length ? `缺 ${missing.join(' / ')}` : '' };
  }

  /**
   * 加载教材（三级回落）——每次调用都重读，不做时间窗（教材变动低频、刷新成本是几次读文件）。
   *
   * @returns {object} 快照
   */
  function load() {
    const business = readBusiness();
    if (business.roleText) {
      cache = {
        roleText: business.roleText,
        source: 'business',
        chars: business.roleText.length,
        at: Date.now(),
        sections: splitSections(business.roleText).map((sec) => sec.title),
        note: business.note
      };
      return cache;
    }

    const files = readFiles();
    if (files.roleText) {
      cache = {
        roleText: files.roleText,
        source: 'files',
        chars: files.roleText.length,
        at: Date.now(),
        sections: splitSections(files.roleText).map((sec) => sec.title),
        note: [business.note, files.note].filter(Boolean).join(' · ')
      };
      return cache;
    }

    cache = {
      roleText: BUILTIN_QUICK,
      source: 'builtin',
      chars: BUILTIN_QUICK.length,
      at: Date.now(),
      sections: splitSections(BUILTIN_QUICK).map((sec) => sec.title),
      note: [business.note, files.note].filter(Boolean).join(' · ')
    };
    // 静默换源是坑：掉到内置集必须出声（教材是判断口径的来源，缺了要看得见）
    log?.warn?.('navigator', `教材回落内置最小集：${cache.note || '原因未知'}`);
    return cache;
  }

  /**
   * 取当前教材全文（首次调用自动加载）。
   *
   * @returns {string} 全文
   */
  function roleText() {
    if (!cache.at) load();
    return cache.roleText;
  }

  /**
   * 取一段教材（按标题关键字模糊匹配）。
   *
   * @param {string} keyword 标题关键字（如「判断」「投递」）
   * @returns {string|null} 段正文（含标题行）
   */
  function section(keyword) {
    const key = String(keyword ?? '').trim();
    if (!key) return null;
    const hit = splitSections(roleText()).find((sec) => sec.title.includes(key));
    return hit ? hit.body : null;
  }

  /**
   * 取按需教材文件全文（role/nav-rules.md 等）——读不到返回空串。
   *
   * @param {string} name 文件名（可省 `role/` 前缀）
   * @returns {string} 正文
   */
  function file(name) {
    const base = String(name ?? '').replace(/^role[\\/]/, '').trim();
    if (!ROLE_FILES.includes(base)) return '';
    const hit = fileCache.get(base);
    if (hit) return hit.body;
    try {
      const body = fs.readFileSync(path.join(roleDir, base), 'utf8').replace(/^\uFEFF/, '').trim();
      fileCache.set(base, { body, at: Date.now(), source: 'file' });
      return body;
    } catch (error) {
      log?.warn?.('navigator', `按需教材不可读（${base}）：${error?.message ?? error}`);
      fileCache.set(base, { body: '', at: Date.now(), source: 'missing' });
      return '';
    }
  }

  /**
   * 判断器同源提示：给 LLM 分类用的教材摘要（只取「判断」段 + 开关段，避免整份灌进提示词）。
   *
   * @returns {string} 摘要
   */
  function classifyHint() {
    const parts = [section('判断'), section('开关')].filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    return BUILTIN_QUICK;
  }

  /**
   * 清缓存（下次调用重读）。
   *
   * @returns {object} 重读后的快照
   */
  function refresh() {
    fileCache.clear();
    cache = { ...cache, at: 0 };
    return load();
  }

  /**
   * 快照（不含全文——status 面用）。
   *
   * @returns {object} 快照
   */
  function snapshot() {
    if (!cache.at) load();
    return {
      source: cache.source,
      chars: cache.chars,
      sections: cache.sections,
      at: cache.at,
      note: cache.note,
      roleDir
    };
  }

  return { roleText, section, file, classifyHint, refresh, snapshot, load, splitSections, ROLE_FILES };
}
