// patch-qqagent-session.mjs — QQ Agent v0.4.0「会话生命周期 + 记忆面」幂等补丁
//
// 用法：node patch-qqagent-session.mjs [--dry]
// 做什么：把 design-qqbotb-session.md 的改动落进 _unpack 源码（编排 / 存档 / 提示词 / 配置 + 新增 session-state）
// 语义：**源码改动的唯一落盘通道**——重装应用后重跑本脚本即复现（_unpack 可弃，补丁脚本是唯一真相）
// 幂等：每个补丁点带唯一标记 [qqagent-session-patch:<id>]；已含标记 = 跳过，可反复运行
// 边界：不动安全边界 / 发送队列 / Electron 壳；不改 store.historyCount（会话窗口独立于该字段）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-session-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(SRC, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  // 幂等检测：默认看标记注释；无标记位的补丁点（如签名替换）显式给"已应用特征串"。
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) {
    // 幂等兜底（2026-10-16）：锚点被后续补丁改写、替换体已在文件里 → 视为已应用。
    // 判据 = 替换体首行 + 末行同时命中（单行易撞通用代码行）。
    const lines = r.split('\n').map((s) => s.trim()).filter(Boolean);
    const first = lines[0] || '';
    const last = lines[lines.length - 1] || '';
    if (first && last && text.includes(first) && text.includes(last)) { results.push({ id, file: rel, status: 'skipped' }); return; }
    throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 70)));
  }
  if (!DRY) fs.writeFileSync(file, text.replace(a, r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/** 新增文件：已存在且非本补丁产物时拒绝覆盖（防误伤手写文件）。 */
function addFile(id, rel, content) {
  const file = path.join(SRC, rel);
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
    throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel + '（先人工确认再删）');
  }
  if (!DRY) fs.writeFileSync(file, toEol(content, detectEol(path.join(SRC, 'config.js'))), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新增 src/session-state.js —— 会话状态 + 会话级记忆摘要的读写层
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_STATE_JS = `// 会话状态与记忆面 —— 会话生命周期（收工轮 / 上下文轮转）的持久化层。
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
  return setSessionState(chatKey, { startedAt: Date.now(), lastPromptTokens: 0, rollovers: cur.rollovers + 1 });
}

/** 会话窗口起点；null = 关闭会话窗口（回落 historyCount 老口径）。 */
export function sessionWindowStart(chatKey) {
  const cfg = getConfig().session || {};
  if (cfg.enabled === false) return null;
  return getSessionState(chatKey).startedAt;
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

/** 渲染成【记忆】段的首块（会话级要点先于群友印象）。 */
export function formatSessionSummaryForPrompt(chatKey) {
  const s = readSessionSummary(chatKey);
  if (!s) return '';
  const when = s.createdAt ? formatStamp(s.createdAt) : '';
  const head = '【上一轮会话要点' + (when ? '（' + when + ' 收工沉淀）' : '') + '】';
  return head + '\\n' + s.summary;
}

function formatStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
`;

addFile('session-state', 'session-state.js', SESSION_STATE_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/config.js —— 新增 session 配置段（默认开启，阈值 300k）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-session', 'config.js',
`  // 屏蔽名单：{ [群号]: [QQ号, ...] }`,
`  // ── 会话生命周期（收工轮 / 上下文轮转，2026-10-09）── [qqagent-session-patch:config-session]
  // enabled=false 时完全回到旧行为（无状态：已读窗口只带 store.historyCount 条）。
  // maxContextTokens：上下文估算（上轮 promptTokens + 本批字符/1.5）超过它就起收工轮
  // —— 收工轮沉淀要点 → 归档当前存档 → 开新会话。与模型窗口解耦：窗口变了只改这里。
  session: {
    enabled: true,
    maxContextTokens: 300000
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/store.js —— 会话窗口取数 + 轮转归档
// ─────────────────────────────────────────────────────────────────────────────
patch('store-archive-dir', 'store.js',
`const MESSAGES_DIR = path.join(DATA_DIR, 'messages');`,
`const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
// 会话轮转的归档落点（[qqagent-session-patch:store-archive-dir]）——子目录名不匹配
// listChats 的文件名正则，因此不会被当成活跃会话重新加载。
const ARCHIVE_DIR = path.join(MESSAGES_DIR, 'archive');`);

patch('store-since', 'store.js',
`  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {`,
`  /**
   * 取时间戳之后的全部消息（会话窗口用）。[qqagent-session-patch:store-since]
   * sinceTs = 0 时等价于"全部存档"；limit = 0 表示不限条数（会话全量）。
   */
  messagesSince(chatKey, sinceTs, { limit = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const from = Math.max(0, Number(sinceTs) || 0);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    const hit = all.filter((m) => (Number(m.ts) || 0) >= from);
    const cap = Math.max(0, Number(limit) || 0);
    return cap > 0 ? hit.slice(-cap) : hit;
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {`);

patch('store-rollover', 'store.js',
`  #trim(st) {`,
`  /**
   * 会话轮转：当前存档整份归档到 data/messages/archive/，再清空当前存档。
   * [qqagent-session-patch:store-rollover]
   *
   * 未读消息默认保留 —— 收工轮运行期间新到的消息属于新会话，不能被归档带走。
   * 本地 id 计数器不清零（避免与归档里的 id 重号，UI 的 #id 引用才不会错位）。
   * @returns {{archived:number, kept:number, file:string}}
   */
  archiveAndClear(chatKey, { keepUnread = true, reason = 'rollover' } = {}) {
    const st = this.#state(chatKey);
    const archived = st.messages.slice();
    const kept = keepUnread ? st.messages.filter((m) => !m.read && !m.self) : [];
    let file = '';
    if (archived.length) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      file = path.join(ARCHIVE_DIR, String(chatKey).replace(/[^a-z0-9_]/gi, '_') + '_' + Date.now() + '.json');
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        chatKey,
        archivedAt: Date.now(),
        reason,
        nextLocalId: st.nextLocalId,
        messages: archived
      }, null, 1), 'utf8');
      fs.renameSync(tmp, file);
    }
    st.messages = kept;
    saveChat(st);
    return { archived: archived.length, kept: kept.length, file };
  }

  #trim(st) {`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/prompt.js —— 会话窗口（全量已读）+【记忆】段前置会话级要点
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-import', 'prompt.js',
`import { skillManager } from './skills/manager.js';`,
`import { skillManager } from './skills/manager.js';
// 会话级记忆摘要（收工轮产出）——【记忆】段首块（[qqagent-session-patch:prompt-import]）
import { formatSessionSummaryForPrompt } from './session-state.js';`);

patch('prompt-past', 'prompt.js',
`export function buildPastState(store, chatKey, { excludeIds = [], limit = null } = {}) {
  const cfg = getConfig().store;
  const maxLimit = limit === null ? Math.max(1, Number(cfg.historyCount) || Number(cfg.allCount) || 80) : Math.max(0, Number(limit) || 0);
  const exclude = new Set(excludeIds);
  if (maxLimit <= 0) return { text: '', count: 0, messages: [] };
  let messages = store.recent(chatKey, { limit: maxLimit + exclude.size }).filter((m) => !exclude.has(m.id));`,
`export function buildPastState(store, chatKey, { excludeIds = [], limit = null, sinceTs = null } = {}) {
  // 会话窗口模式（sinceTs 有效）：窗口 = 会话起点之后的全部消息，limit=0 表示不限条数。
  // 这是"会话全量进上下文"的落点；关闭会话窗口时回落 store.historyCount 老口径。
  // [qqagent-session-patch:prompt-past]
  const cfg = getConfig().store;
  const windowed = Number.isFinite(Number(sinceTs));
  const maxLimit = limit === null
    ? (windowed ? 0 : Math.max(1, Number(cfg.historyCount) || Number(cfg.allCount) || 80))
    : Math.max(0, Number(limit) || 0);
  const exclude = new Set(excludeIds);
  if (!windowed && maxLimit <= 0) return { text: '', count: 0, messages: [] };
  let messages = windowed
    ? store.messagesSince(chatKey, Number(sinceTs), { limit: maxLimit })
    : store.recent(chatKey, { limit: maxLimit + exclude.size });
  messages = messages.filter((m) => !exclude.has(m.id));`);

patch('prompt-past-slice', 'prompt.js',
`  messages = messages.slice(-maxLimit);`,
`  if (maxLimit > 0) messages = messages.slice(-maxLimit);   // [qqagent-session-patch:prompt-past-slice]`);

patch('prompt-session-start', 'prompt.js',
`  const past = buildPastState(ctx.store, ctx.chatKey, { excludeIds, limit: contextLimit });`,
`  // 会话窗口起点（orchestrator 传入；null = 关闭窗口）。[qqagent-session-patch:prompt-session-start]
  const sessionStartRaw = ctx.sessionStart === null || ctx.sessionStart === undefined ? null : Number(ctx.sessionStart);
  const sessionWindowed = Number.isFinite(sessionStartRaw);
  const past = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : contextLimit,
    sinceTs: sessionWindowed ? sessionStartRaw : null
  });`);

patch('prompt-past-pool', 'prompt.js',
`  const pastPool = buildPastState(ctx.store, ctx.chatKey, { excludeIds, limit: 500 });`,
`  // 会话窗口模式：全量池（limit=0）—— 锚点+追加规模不受 500 条上限压制。
  // [qqagent-session-patch:prompt-past-pool]
  const pastPool = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : 500,
    sinceTs: sessionWindowed ? sessionStartRaw : null
  });`);

patch('prompt-session-memory', 'prompt.js',
`  const memText = ctx.memory.formatForPrompt(ctx.chatKey, { userIds: [...relevantUserIds] });`,
`  const memTextRaw = ctx.memory.formatForPrompt(ctx.chatKey, { userIds: [...relevantUserIds] });
  // 会话级要点（收工轮沉淀，跨会话携带）排在群友印象之前 —— 同一会话内它稳定不变，
  // 不打断【记忆】段作为缓存前缀的角色。[qqagent-session-patch:prompt-session-memory]
  const sessionMemText = formatSessionSummaryForPrompt(ctx.chatKey);
  const memText = [sessionMemText, memTextRaw].filter(Boolean).join('\\n');`);

patch('prompt-context-mode', 'prompt.js',
`  if (ctx.session && typeof ctx.session === 'object') ctx.session.pastStateCount = readShownCount;`,
`  if (ctx.session && typeof ctx.session === 'object') ctx.session.pastStateCount = readShownCount;
  // 会话窗口模式：把"实际带了多少条"回写为 contextLimit（运行详情显示真实上下文规模）。
  // [qqagent-session-patch:prompt-context-mode]
  if (ctx.session && typeof ctx.session === 'object') {
    ctx.session.contextMode = sessionWindowed ? 'session' : 'window';
    if (sessionWindowed) ctx.session.contextLimit = readShownCount;
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/orchestrator.js —— 收工轮触发 / 轮转归档 / 429 长轮询 / 全量窗口
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', 'orchestrator.js',
`import { rescueUnsentReply } from './reply-rescue.js';`,
`import { rescueUnsentReply } from './reply-rescue.js';
// 会话生命周期与记忆面（[qqagent-session-patch:orchestrator-import]）
import {
  sessionWindowStart, shouldRollover, estimateContextTokens, maxContextTokens,
  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError
} from './session-state.js';`);

patch('orchestrator-consts', 'orchestrator.js',
`export class Orchestrator {`,
`// 收工轮禁用的发送类工具 —— "不对外发言"靠工具集移除实现（架构级），不靠提示词请求配合。
// [qqagent-session-patch:orchestrator-consts]
const ROLLOVER_BLOCKED_TOOLS = new Set(['send_message', 'send_to', 'send_sticker', 'send_poke', 'send_image']);
// 限流长轮询上限（次）：1min 起指数退避、15min 封顶，约 5 小时后才判失败（防永久挂死）。
const MAX_RATE_LIMIT_RETRIES = 20;

/** 收工轮的系统指令（追加在用户消息末尾）。 */
function rolloverInstruction() {
  return [
    '【收工轮（系统指令，最高优先级）】',
    '本轮是收工轮：这段会话的上下文即将到达上限，系统随后会把它归档、开启新会话。',
    '1. 你本轮不对外发言：发送类工具已从工具集移除，任何文本输出都不会发到 QQ。',
    '2. 把这段会话的要点写成简洁条目：聊了什么、结论或决定、对谁的印象有变化、有什么待续的事。中文短句，控制在 300 字内，直接写在回复文本里。',
    '3. 需要长期记住的群友印象，可以调用 记录印象（memory_append）。',
    '4. 写完就结束（调用 finish，reason 填"收工"）。'
  ].join('\\n');
}

export class Orchestrator {`);

patch('orchestrator-ctor', 'orchestrator.js',
`    this.reminderFiring = new Set();   // 防止同一提醒并发触发`,
`    this.reminderFiring = new Set();   // 防止同一提醒并发触发
    // 限流（429）长轮询计数：chatKey -> 已轮询次数。[qqagent-session-patch:orchestrator-ctor]
    this.rateLimitRetries = new Map();`);

patch('orchestrator-rollover', 'orchestrator.js',
`    // ── 档位：响应时带多少条已读历史 ──`,
`    // ── 会话轮转判据（收工轮）── [qqagent-session-patch:orchestrator-rollover]
    // 估算上下文 = 上轮真实 promptTokens + 本次触发批字符数/1.5；超阈值 → 本轮走收工轮。
    // 主动机会与原地重试不轮转（它们不是会话推进）。
    const sessionCfg = getConfig().session || {};
    const sessionStart = sessionWindowStart(chatKey);
    const pendingChars = triggerEntries.reduce((n, m) => n + String(m?.text ?? '').length, 0);
    const isRollover = sessionCfg.enabled !== false && !proactive && !reuseSessionId && shouldRollover(chatKey, pendingChars);
    if (isRollover) {
      console.log('[orchestrator] ' + chatKey + ' 上下文估算 ' + estimateContextTokens(chatKey, pendingChars) + ' > ' + maxContextTokens() + ' → 本轮走收工轮');
    }

    // ── 档位：响应时带多少条已读历史 ──`);

patch('orchestrator-run-args', 'orchestrator.js',
`          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit: effectiveTier.count, tierInfo: effectiveTier, activeTopic: activeState ? activeState.topic : null });`,
`          // 会话窗口模式（session 开启）下不截尾：contextLimit 传 null = 会话全量。
          // [qqagent-session-patch:orchestrator-run-args]
          await this.#runAgent(session, {
            kind, chatId, chatKey, triggerEntries, proactive, seq,
            contextLimit: sessionStart === null ? effectiveTier.count : null,
            tierInfo: effectiveTier,
            activeTopic: activeState ? activeState.topic : null,
            rollover: isRollover,
            sessionStart
          });`);

patch('orchestrator-session-flag', 'orchestrator.js',
`    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });`,
`    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      if (isRollover) {
        // 会话页可见的边界：这条会话就是"收工轮"（[qqagent-session-patch:orchestrator-session-flag]）
        session.rollover = true;
        session.triggerSummary = '收工轮（上下文轮转）';
        this.sessions.update(session.id);
      }`);

patch('orchestrator-post-run', 'orchestrator.js',
`      if (lastError) {
        // 用户手动中止（「中止」按钮）打断在途请求时，错误从 #runAgent 一路上抛`,
`      if (!lastError && isRollover) this.#completeRollover(chatKey, session);
      if (!lastError && !isRollover) recordPromptTokens(chatKey, session.usage?.promptTokens);
      if (!lastError) this.rateLimitRetries.delete(chatKey);   // [qqagent-session-patch:orchestrator-post-run]

      if (lastError) {
        // 用户手动中止（「中止」按钮）打断在途请求时，错误从 #runAgent 一路上抛`);

patch('orchestrator-429', 'orchestrator.js',
`        } else {
          session.error = String(lastError?.message ?? lastError);`,
`        } else if (isRateLimitedError(lastError) && (session.sent || []).length === 0 && this.#scheduleRateLimitRetry(chatKey, session)) {
          // 长时限流（429，分钟级）：不判失败 —— 恢复触发批、延后轮询续跑（B10）。
          // [qqagent-session-patch:orchestrator-429]
        } else {
          session.error = String(lastError?.message ?? lastError);`);

patch('orchestrator-methods', 'orchestrator.js',
`  async #chatName(groupId) {`,
`  /**
   * 限流（429）长轮询：不判失败 —— 恢复触发批为未读、延后重新排唤醒。
   * [qqagent-session-patch:orchestrator-methods]
   *
   * 为什么不在会话内 sleep：占着并发槽等十几分钟会拖住其它会话；
   * 交还给 scheduleWake 让本会话"排队重来"更干净，消息也不会丢（本体一直在存档里）。
   * 超过 MAX_RATE_LIMIT_RETRIES 次才按失败收尾（防永久挂死）。
   * @returns {boolean} 是否已接管本次失败（false = 调用方按 error 收尾）
   */
  #scheduleRateLimitRetry(chatKey, session) {
    const n = (this.rateLimitRetries.get(chatKey) || 0) + 1;
    if (n > MAX_RATE_LIMIT_RETRIES) {
      this.rateLimitRetries.delete(chatKey);
      console.warn('[orchestrator] ' + chatKey + ' 限流轮询已达上限 ' + MAX_RATE_LIMIT_RETRIES + ' 次，按失败收尾');
      return false;
    }
    this.rateLimitRetries.set(chatKey, n);
    let restored = 0;
    try { restored = this.store.markUnreadInWindow(chatKey, session.startedAt, Date.now()); } catch { restored = 0; }
    const delay = Math.min(60000 * Math.pow(2, n - 1), 15 * 60 * 1000);
    session.finishReason = '限流等待（第 ' + n + ' 次轮询，' + Math.round(delay / 1000) + 's 后重试）';
    this.sessions.finish(session.id, 'noreply');
    this.emit('session-end', {
      sessionId: session.id, chatKey, status: 'noreply', sent: 0,
      finishReason: session.finishReason, usage: session.usage
    });
    console.warn('[orchestrator] ' + chatKey + ' 限流（429）不判失败：' + Math.round(delay / 1000) + 's 后轮询续跑（第 ' + n + ' 次，恢复未读 ' + restored + ' 条）');
    this.scheduleWake(chatKey, delay);
    return true;
  }

  /**
   * 收工轮收尾：要点写会话级记忆 → 归档当前存档 → 重置会话状态（新会话开始）。
   * [qqagent-session-patch:orchestrator-methods]
   */
  #completeRollover(chatKey, session) {
    try {
      const state = getSessionState(chatKey);
      const summary = this.#collectRolloverSummary(session);
      writeSessionSummary(chatKey, summary, {
        sessionStartedAt: state.startedAt,
        rollovers: state.rollovers,
        messages: Array.isArray(session.trigger) ? session.trigger.length : 0,
        source: 'rollover'
      });
      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);
      // 存档已清空 → 上一轮的提示词锚点失效（锚点条目已不在存档里）
      this.promptAnchors.delete(chatKey);
      console.log('[orchestrator] ' + chatKey + ' 收工轮完成：要点已沉淀（' + summary.length + ' 字），归档 '
        + res.archived + ' 条（保留未读 ' + res.kept + ' 条）→ ' + (res.file || '（无内容）'));
      this.emit('chat-update', chatKey);
    } catch (error) {
      console.error('[orchestrator] ' + chatKey + ' 收工轮归档失败:', error?.message ?? error);
    }
  }

  /** 收工轮要点文本：取本轮助手输出（正文即要点；本轮不对外发言）。 */
  #collectRolloverSummary(session) {
    const texts = [];
    for (const m of session.messages || []) {
      if (m?.role !== 'assistant') continue;
      const c = typeof m.content === 'string' ? m.content.trim() : '';
      if (c) texts.push(c);
    }
    const joined = texts.join('\\n').trim();
    return joined ? joined.slice(0, 2000) : '（收工轮未产出文字要点）';
  }

  async #chatName(groupId) {`);

patch('orchestrator-run-signature', 'orchestrator.js',
`  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, activeTopic = null, rollover = false, quietOrganize = false, sessionStart = null }) {   // [qqagent-quiet-patch:runagent-signature]`,
`  // [qqagent-session-patch:orchestrator-run-signature]
  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, activeTopic = null, rollover = false, quietOrganize = false, sessionStart = null }) {   // [qqagent-quiet-patch:runagent-signature]`,
1,
`  // [qqagent-session-patch:orchestrator-run-signature]`);

patch('orchestrator-rollover-tools', 'orchestrator.js',
`    const toolDefs = this.toolDefs.filter((d) => {`,
`    const toolDefs = this.toolDefs.filter((d) => {
      // 收工轮不对外发言：发送类工具从工具集移除（模型物理上发不出）。
      // [qqagent-session-patch:orchestrator-rollover-tools]
      if (rollover && ROLLOVER_BLOCKED_TOOLS.has(d.id)) {
        availability.set(d.id, { enabled: false, code: 'rollover', reason: '收工轮不对外发言' });
        return false;
      }`);

patch('orchestrator-prompt-session', 'orchestrator.js',
`      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      session
    });`,
`      // [qqagent-session-patch:orchestrator-prompt-session]
      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      sessionStart,
      session
    });`,
1,
`      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      sessionStart,
      session
    });`);

patch('orchestrator-rollover-instruction', 'orchestrator.js',
`    // 让 Skill 加工即将发给模型的消息（如补充知识库片段）。`,
`    // 收工轮：追加系统指令（写在用户消息末尾）。
    // [qqagent-session-patch:orchestrator-rollover-instruction]
    if (rollover) messages[messages.length - 1].content = String(messages[messages.length - 1].content || '') + '\\n\\n' + rolloverInstruction();

    // 让 Skill 加工即将发给模型的消息（如补充知识库片段）。`);

patch('orchestrator-rollover-rescue', 'orchestrator.js',
`        const rescued = await this.#rescueUnsentReply({
          rawContent, triggerEntries, session, skillContext
        });`,
`        // 收工轮不抢救正文（正文是沉淀要点，不是要说给群里的话）。
        // [qqagent-session-patch:orchestrator-rollover-rescue]
        const rescued = rollover ? [] : await this.#rescueUnsentReply({
          rawContent, triggerEntries, session, skillContext
        });`);

patch('orchestrator-rollover-reason', 'orchestrator.js',
`    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');`,
`    // 收工轮的"未发言"是设计语义（不是失职）：finishReason 标注清楚，会话页可解释。
    // [qqagent-session-patch:orchestrator-rollover-reason]
    if (rollover && !session.finishReason) session.finishReason = '收工轮（上下文轮转）';
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');`);

patch('orchestrator-context-limit', 'orchestrator.js',
`      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';`,
`      session.contextTier = tierInfo.tier;
      // 会话窗口模式下 contextLimit 由 buildUserPrompt 回写为实际条数，这里不覆盖。
      // [qqagent-session-patch:orchestrator-context-limit]
      if (sessionStart === null) session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：429 长轮询改为"不设次数上限 + 180s 封顶退避"（Rushiera 2026-10-09 定）
// ─────────────────────────────────────────────────────────────────────────────
patch('session-state-429-delay', 'session-state.js',
`function formatStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}`,
`function formatStamp(ts) {
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
}`);

patch('orchestrator-429-import', 'orchestrator.js',
`  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError
} from './session-state.js';`,
`  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError,
  rateLimitRetryDelayMs
} from './session-state.js';`,
1,
`  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError,
  rateLimitRetryDelayMs
} from './session-state.js';`);

patch('orchestrator-429-nolimit', 'orchestrator.js',
`// 限流长轮询上限（次）：1min 起指数退避、15min 封顶，约 5 小时后才判失败（防永久挂死）。
const MAX_RATE_LIMIT_RETRIES = 20;`,
`// 限流长轮询不设次数上限：429 是"等一会儿再来"—— 判失败等于把群友的消息丢掉。
// 退避时长由 rateLimitRetryDelayMs 计算（60s 起指数增长、180s 封顶）。
// [qqagent-session-patch:orchestrator-429-nolimit]`);

patch('orchestrator-429-body', 'orchestrator.js',
`  /**
   * 限流（429）长轮询：不判失败 —— 恢复触发批为未读、延后重新排唤醒。
   * [qqagent-session-patch:orchestrator-methods]
   *
   * 为什么不在会话内 sleep：占着并发槽等十几分钟会拖住其它会话；
   * 交还给 scheduleWake 让本会话"排队重来"更干净，消息也不会丢（本体一直在存档里）。
   * 超过 MAX_RATE_LIMIT_RETRIES 次才按失败收尾（防永久挂死）。
   * @returns {boolean} 是否已接管本次失败（false = 调用方按 error 收尾）
   */
  #scheduleRateLimitRetry(chatKey, session) {
    const n = (this.rateLimitRetries.get(chatKey) || 0) + 1;
    if (n > MAX_RATE_LIMIT_RETRIES) {
      this.rateLimitRetries.delete(chatKey);
      console.warn('[orchestrator] ' + chatKey + ' 限流轮询已达上限 ' + MAX_RATE_LIMIT_RETRIES + ' 次，按失败收尾');
      return false;
    }
    this.rateLimitRetries.set(chatKey, n);
    let restored = 0;
    try { restored = this.store.markUnreadInWindow(chatKey, session.startedAt, Date.now()); } catch { restored = 0; }
    const delay = Math.min(60000 * Math.pow(2, n - 1), 15 * 60 * 1000);`,
`  /**
   * 限流（429）长轮询：不判失败 —— 恢复触发批为未读、延后重新排唤醒。
   * [qqagent-session-patch:orchestrator-429-body]
   *
   * 为什么不在会话内 sleep：占着并发槽等几分钟会拖住其它会话；
   * 交还给 scheduleWake 让本会话"排队重来"更干净，消息也不会丢（本体一直在存档里）。
   * **不设次数上限**：429 是"等一会儿再来"，判失败等于把群友的消息丢掉；
   * 退避 60s 起指数增长、180s 封顶（rateLimitRetryDelayMs）。
   * @returns {boolean} 恒为 true（已接管本次失败，调用方不落 error）
   */
  #scheduleRateLimitRetry(chatKey, session) {
    const n = (this.rateLimitRetries.get(chatKey) || 0) + 1;
    this.rateLimitRetries.set(chatKey, n);
    let restored = 0;
    try { restored = this.store.markUnreadInWindow(chatKey, session.startedAt, Date.now()); } catch { restored = 0; }
    const delay = rateLimitRetryDelayMs(n);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁：orchestrator.js —— 上下文基线改记「单次 prompt」（非运行内累积）
// 背景（2026-10-11 实测）：recordPromptTokens 原本吃 session.usage.promptTokens，
//   而 usage 由 addUsage 逐轮累加 —— 一次运行 12 轮工具调用把 12 次 prompt 加起来
//   （实测 66.7 万），被 shouldRollover 当成「上下文大小」→ 每次都超阈值 → 每轮都走
//   收工轮；收工轮自身再失败（catch 里只有 console.error，GUI 外壳无 stdout → 不可见）
//   → 永不 resetSession → 死循环（群 940257985 实证）。
// 修法：单次上下文只认**最后一轮**的 prompt_tokens；收工失败的日志走 logger（落盘）。
// ─────────────────────────────────────────────────────────────────────────────
patch('usage-single-prompt', 'orchestrator.js',
`      addUsage(session.usage, response.usage);
      session.usage.calls += 1;`,
`      // 单次上下文基线（非累积）——收工轮判定用 [qqagent-session-patch:usage-single-prompt]
      if (response.usage?.prompt_tokens) session.lastPromptTokens = Number(response.usage.prompt_tokens) || 0;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;`);

patch('rollover-baseline', 'orchestrator.js',
`      if (!lastError && !isRollover) recordPromptTokens(chatKey, session.usage?.promptTokens);`,
`      // 基线 = 单次上下文（最后一轮的 prompt），不是本次运行所有轮次的累积
      // [qqagent-session-patch:rollover-baseline]
      if (!lastError && !isRollover) recordPromptTokens(chatKey, session.lastPromptTokens || session.usage?.promptTokens);`);

patch('rollover-visible', 'orchestrator.js',
`    } catch (error) {
      console.error('[orchestrator] ' + chatKey + ' 收工轮归档失败:', error?.message ?? error);
    }`,
`    } catch (error) {
      // 收工失败必须可见——console 在 GUI 外壳（无 stdout）里看不到
      // [qqagent-session-patch:rollover-visible]
      logger.error('session', chatKey + ' 收工轮归档失败：' + String(error?.message ?? error));
      console.error('[orchestrator] ' + chatKey + ' 收工轮归档失败:', error?.message ?? error);
    }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁：记忆回溯点（memory reach）——收工轮取材可回溯到指定时点（Rushiera 2026-10-11）
// 背景：收工轮取材只吃「本会话」（窗口起点 = sessionState.startedAt）。会话一旦轮转，
//   跨越轮转的工作段（如领航员场次）只能靠上一份摘要传递，细节就丢了。
// 修法：session-state 增 memoryFloorTs（记忆回溯点）；收工轮窗口起点取
//   min(会话起点, 回溯点)；沉淀完成后归零。回溯点由领航员开启等节点置位
//   （nav_open → nav-tools.js 的 [qqagent-navigator-patch:memory-reach-open]）。
// ─────────────────────────────────────────────────────────────────────────────
patch('memory-reach-state', 'session-state.js',
`    rollovers: Math.max(0, Number(st?.rollovers) || 0),
    updatedAt: Math.max(0, Number(st?.updatedAt) || 0)
  };
}`,
`    rollovers: Math.max(0, Number(st?.rollovers) || 0),
    // 记忆回溯点（0 = 关闭）——收工轮取材可早于本会话起点（如领航员开启那一刻）
    // [qqagent-session-patch:memory-reach-state]
    memoryFloorTs: Math.max(0, Number(st?.memoryFloorTs) || 0),
    updatedAt: Math.max(0, Number(st?.updatedAt) || 0)
  };
}`);

patch('memory-reach', 'session-state.js',
`/** 会话窗口起点；null = 关闭会话窗口（回落 historyCount 老口径）。 */
export function sessionWindowStart(chatKey) {
  const cfg = getConfig().session || {};
  if (cfg.enabled === false) return null;
  return getSessionState(chatKey).startedAt;
}`,
`/**
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
}`);

patch('memory-reach-import', 'orchestrator.js',
`} from './session-state.js';`,
`} from './session-state.js';
// 记忆回溯点（收工轮取材回溯到指定时点）—— [qqagent-session-patch:memory-reach-import]
import { setMemoryFloor } from './session-state.js';`);

patch('memory-reach-window', 'orchestrator.js',
`    const sessionCfg = getConfig().session || {};
    const sessionStart = sessionWindowStart(chatKey);
    const pendingChars = triggerEntries.reduce((n, m) => n + String(m?.text ?? '').length, 0);
    const isRollover = sessionCfg.enabled !== false && !proactive && !reuseSessionId && shouldRollover(chatKey, pendingChars);`,
`    const sessionCfg = getConfig().session || {};
    const pendingChars = triggerEntries.reduce((n, m) => n + String(m?.text ?? '').length, 0);
    const isRollover = sessionCfg.enabled !== false && !proactive && !reuseSessionId && shouldRollover(chatKey, pendingChars);
    // 窗口起点：收工轮带上「记忆回溯点」——取材可早于本会话起点（如领航员开启那一刻）。
    // [qqagent-session-patch:memory-reach-window]
    const sessionStart = sessionWindowStart(chatKey, { reach: isRollover });`);

patch('memory-reach-clear', 'orchestrator.js',
`      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);`,
`      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);
      // 沉淀完成 → 记忆回溯点归零（下一段会话重新按本会话起点取材）
      // [qqagent-session-patch:memory-reach-clear]
      setMemoryFloor(chatKey, 0);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁：端点降级守卫（B19）——2026-10-14 群 361820329 实证
// 背景：端点在单次 prompt 越过其容忍线（实测 ≈194k tokens / ≈306k 字符）后不再正常推理，
//   而是回 200 + usage{prompt_tokens:14, completion_tokens:28}（恒定值，连系统提示都装不下）。
//   客户端照单收下 → recordPromptTokens 把 14 写成轮转基线 → shouldRollover 估算恒小
//   → 永不轮转 → 前文只增不减 → 继续被降级：自锁（该群 rollovers 恒 0 的根因）。
// 修法：回报值与本地组装量严重不成比例时**不采信**（基线保持原值）并出声告警——
//   失败必须可见（AGENTS §一-4），静默失败是自锁的入口。
// 注：守卫只防"新污染"；已污染的基线靠清会话（POST /api/chats/<key>/clear）恢复。
// ─────────────────────────────────────────────────────────────────────────────
patch('degrade-guard', 'orchestrator.js',
`      // 基线 = 单次上下文（最后一轮的 prompt），不是本次运行所有轮次的累积
      // [qqagent-session-patch:rollover-baseline]
      if (!lastError && !isRollover) recordPromptTokens(chatKey, session.lastPromptTokens || session.usage?.promptTokens);`,
`      // 基线 = 单次上下文（最后一轮的 prompt），不是本次运行所有轮次的累积
      // [qqagent-session-patch:rollover-baseline]
      if (!lastError && !isRollover) {
        // 端点降级守卫：回报的 prompt_tokens 与本地组装量严重不成比例 → 该值不是"上下文大小"，
        // 而是端点异常产物；采信它会把轮转基线击穿（→ 永不轮转 → 前文只增不减，自锁）。
        // [qqagent-session-patch:degrade-guard]
        const pt = Number(session.lastPromptTokens || session.usage?.promptTokens) || 0;
        const chars = Number(session.promptChars) || 0;
        const expected = Math.round(chars / 1.5);
        if (pt > 0 && chars >= 20000 && pt < expected / 5) {
          logger.warn('session', chatKey + ' 端点回报 prompt_tokens=' + pt + '，本地组装 ' + chars
            + ' 字符（≈' + expected + ' tokens）严重不成比例 → 疑似端点降级，本轮不采信该值（基线保持 '
            + getSessionState(chatKey).lastPromptTokens + '）');
        } else {
          recordPromptTokens(chatKey, pt);
        }
      }`);

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({
  ok: true,
  dryRun: DRY,
  src: SRC,
  applied: results.filter((r) => r.status === 'applied').map((r) => r.id),
  skipped: results.filter((r) => r.status === 'skipped').map((r) => r.id),
  dry: results.filter((r) => r.status === 'dry').map((r) => r.id),
  files: [...new Set(results.map((r) => r.file))]
}, null, 2));
