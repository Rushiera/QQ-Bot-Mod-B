// 会话状态与记忆面 —— 会话生命周期（收工轮 / 上下文轮转）的持久化层。
// [qqagent-session-patch:session-state]
//
// 两个文件：
//   data/session-state.json                  每 chat 一条会话状态
//   data/memory/<chat>/_session.json         会话级记忆摘要（收工轮产出，跨会话携带）
//
// 会话状态的语义：
//   startedAt        当前会话的起点（收工轮轮转后重置为当时时刻）；
//                    已读窗口 = 存档里 ts >= startedAt 的全部消息 —— "会话全量进上下文"的界；
//                    0 = 当前会话 = 现有全部存档（首次启用时不清空既有历史，避免机器人"失忆"）。
//   lastPromptTokens 上一轮真实运行回报的 prompt_tokens（上下文规模的估算锚点）；
//                    下一轮估算 = lastPromptTokens + 本次触发批字符数 / CHARS_PER_TOKEN。
//   rollovers        已轮转次数（观测用）。
//
// ⚠️ _session.json 与群友印象同址（data/memory/<chat>/），以下划线开头避开成员文件语义；
//    memory.js 的成员扫描会读到它，但视为"无印象成员"跳过（不进提示词）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

export const SESSION_STATE_FILE = path.join(DATA_DIR, 'session-state.json');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const STATE_VERSION = 1;
// 中文语境下 1 token 约 1.5 字符（保守：宁可早收工，不可超窗口）。
const CHARS_PER_TOKEN = 1.5;
export const DEFAULT_MAX_CONTEXT_TOKENS = 300000;

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 会话级记忆摘要文件（收工轮产出）。 */
export function sessionSummaryFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_session.json');
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

let stateCache = null;

function loadState() {
  if (stateCache) return stateCache;
  const raw = readJson(SESSION_STATE_FILE, null);
  const chats = raw && typeof raw.chats === 'object' && raw.chats ? raw.chats : {};
  stateCache = { version: STATE_VERSION, chats: { ...chats } };
  return stateCache;
}

function saveState() {
  writeJson(SESSION_STATE_FILE, loadState());
}

/** 取某会话状态；不存在时返回缺省（startedAt=0 = 窗口覆盖现有全部存档）。 */
export function getSessionState(chatKey) {
  const st = loadState().chats[String(chatKey)] || null;
  return {
    startedAt: Math.max(0, Number(st?.startedAt) || 0),
    lastPromptTokens: Math.max(0, Number(st?.lastPromptTokens) || 0),
    rollovers: Math.max(0, Number(st?.rollovers) || 0),
    // 记忆回溯点（0 = 关闭）——收工轮取材可早于本会话起点（如领航员开启那一刻）
    // [qqagent-session-patch:memory-reach-state]
    memoryFloorTs: Math.max(0, Number(st?.memoryFloorTs) || 0),
    // 已读信息窗口下界（B22）：readFloorTs 之前的已读不再进提示词，由【前情提要】承载。
    // [qqagent-readcompact-patch:session-state-floor]
    readFloorTs: Math.max(0, Number(st?.readFloorTs) || 0),
    updatedAt: Math.max(0, Number(st?.updatedAt) || 0)
  };
}

export function setSessionState(chatKey, patchValue = {}) {
  const key = String(chatKey);
  const next = { ...getSessionState(key), ...patchValue, updatedAt: Date.now() };
  loadState().chats[key] = next;
  saveState();
  return next;
}

/** 记录上一轮真实 prompt_tokens（上下文估算基线）。 */
export function recordPromptTokens(chatKey, tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (!n) return getSessionState(chatKey);
  return setSessionState(chatKey, { lastPromptTokens: n });
}

/** 轮转后重置：新会话从此刻起算，估算基线清零，rollovers + 1。 */
export function resetSession(chatKey) {
  const cur = getSessionState(chatKey);
  // readFloorTs 归零：新会话的已读窗口重新从会话起点开始（B22）
  // [qqagent-readcompact-patch:session-state-reset]
  return setSessionState(chatKey, { startedAt: Date.now(), lastPromptTokens: 0, rollovers: cur.rollovers + 1, readFloorTs: 0 });
}

/**
 * 会话窗口起点；null = 关闭会话窗口（回落 historyCount 老口径）。
 * reach=true 时取「会话起点」与「记忆回溯点」中更早的那个 —— 收工轮取材用
 * （回溯点由领航员开启等节点置位：取材要能拉到那个时点，不只吃本会话）。
 * [qqagent-session-patch:memory-reach]
 */
export function sessionWindowStart(chatKey, { reach = false } = {}) {
  const cfg = getConfig().session || {};
  if (cfg.enabled === false) return null;
  const st = getSessionState(chatKey);
  if (!reach || !(st.memoryFloorTs > 0) || !(st.startedAt > 0)) return st.startedAt;
  return Math.min(st.startedAt, st.memoryFloorTs);
}

/** 置记忆回溯点（0 = 关闭）。领航员开启时置位；收工轮沉淀完成后清零。 */
export function setMemoryFloor(chatKey, at = Date.now()) {
  return setSessionState(chatKey, { memoryFloorTs: Math.max(0, Number(at) || 0) });
}

/** 取已读窗口下界（B22；0 = 未压缩）。 */
// [qqagent-readcompact-patch:session-state-readfloor]
export function getReadFloorTs(chatKey) {
  return getSessionState(chatKey).readFloorTs;
}

/** 置已读窗口下界（B22）：readFloorTs 之前的已读由【前情提要】承载。 */
export function setReadFloor(chatKey, at = 0) {
  return setSessionState(chatKey, { readFloorTs: Math.max(0, Number(at) || 0) });
}

export function maxContextTokens() {
  const n = Number(getConfig().session?.maxContextTokens);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONTEXT_TOKENS;
}

export function estimateContextTokens(chatKey, pendingChars = 0) {
  const st = getSessionState(chatKey);
  const chars = Math.max(0, Number(pendingChars) || 0);
  return Math.round(st.lastPromptTokens + chars / CHARS_PER_TOKEN);
}

/**
 * 是否该走收工轮。
 * 从未跑过（基线为 0）时不轮转 —— 没有可沉淀的上下文，先让会话跑起来。
 */
export function shouldRollover(chatKey, pendingChars = 0) {
  const cfg = getConfig().session || {};
  if (cfg.enabled === false) return false;
  if (!(getSessionState(chatKey).lastPromptTokens > 0)) return false;
  return estimateContextTokens(chatKey, pendingChars) > maxContextTokens();
}

/** 限流（429）判定：长时限流走轮询续跑，不判失败。 */
export function isRateLimitedError(error) {
  const msg = String(error?.message ?? error ?? '');
  return /429|rate.?limit|限流|too many requests|quota/i.test(msg);
}

/** 写会话级摘要（收工轮产出）。 */
export function writeSessionSummary(chatKey, text, meta = {}) {
  const summary = String(text ?? '').trim();
  const payload = {
    chatKey: String(chatKey),
    summary: summary.slice(0, 4000),
    createdAt: Date.now(),
    sessionStartedAt: Math.max(0, Number(meta.sessionStartedAt) || 0),
    rollovers: Math.max(0, Number(meta.rollovers) || 0),
    messages: Math.max(0, Number(meta.messages) || 0),
    source: String(meta.source || 'rollover')
  };
  writeJson(sessionSummaryFile(chatKey), payload);
  return payload;
}

export function readSessionSummary(chatKey) {
  const raw = readJson(sessionSummaryFile(chatKey), null);
  if (!raw || !String(raw.summary || '').trim()) return null;
  return {
    summary: String(raw.summary),
    createdAt: Number(raw.createdAt) || 0,
    rollovers: Number(raw.rollovers) || 0,
    messages: Number(raw.messages) || 0
  };
}

/**
 * 把当前 _session.json 追加进归档（轮转写新要点之前调用）。
 * [qqagent-readcompact-patch:session-state-summary-archive]
 */
export function archiveSessionSummary(chatKey, reason = 'rollover') {
  const raw = readJson(sessionSummaryFile(chatKey), null);
  if (!raw || !String(raw.summary || '').trim()) return 0;
  try {
    const dir = path.join(MEMORY_DIR, chatDirName(chatKey), 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const file = path.join(dir, 'session-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ...raw, archivedAt: Date.now(), reason: String(reason || 'rollover') }) + '\n', 'utf8');
    return 1;
  } catch (error) {
    console.warn('[session-state] 会话要点归档失败:', error && error.message || error);
    return 0;
  }
}

/** 读归档会话要点（keyword 过滤；新的在前）。 */
export function listArchivedSessionSummaries(chatKey, { keyword = '', limit = 50 } = {}) {
  const dir = path.join(MEMORY_DIR, chatDirName(chatKey), 'archive');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl')).sort(); } catch { return []; }
  const kw = String(keyword || '').trim().toLowerCase();
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e = null;
      try { e = JSON.parse(t); } catch { continue; }
      const summary = String(e && e.summary || '').trim();
      if (!summary) continue;
      if (kw && !summary.toLowerCase().includes(kw)) continue;
      out.push({
        summary,
        createdAt: Number(e.createdAt) || 0,
        rollovers: Number(e.rollovers) || 0,
        messages: Number(e.messages) || 0,
        source: 'archive'
      });
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 搜会话要点：现行 _session.json + 归档（memory_search category=history 用）。 */
export function searchSessionSummaries(chatKey, { keyword = '', limit = 20 } = {}) {
  const kw = String(keyword || '').trim().toLowerCase();
  const out = [];
  const cur = readSessionSummary(chatKey);
  if (cur && (!kw || cur.summary.toLowerCase().includes(kw))) out.push({ ...cur, source: 'current' });
  out.push(...listArchivedSessionSummaries(chatKey, { keyword, limit }));
  return out.slice(0, Math.max(1, Number(limit) || 20));
}

/** 渲染成【记忆】段的首块（会话级要点先于群友印象）。 */
export function formatSessionSummaryForPrompt(chatKey) {
  const s = readSessionSummary(chatKey);
  if (!s) return '';
  const when = s.createdAt ? formatStamp(s.createdAt) : '';
  const head = '【上一轮会话要点' + (when ? '（' + when + ' 收工沉淀）' : '') + '】';
  return head + '\n' + s.summary;
}

function formatStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 限流重试的退避时长（毫秒）：60s 起指数增长，180s 封顶，**不设次数上限**。
 * [qqagent-session-patch:session-state-429-delay]
 *
 * 语义：429 是"等一会儿再来"—— 长时限流等多久都得等，判失败等于把群友的消息丢掉。
 * 封顶 180s 是为了让恢复后尽快接上（退避再长也不会更省额度）。
 */
export function rateLimitRetryDelayMs(n) {
  const k = Math.max(1, Number(n) || 1);
  return Math.min(60000 * Math.pow(2, k - 1), 180000);
}
