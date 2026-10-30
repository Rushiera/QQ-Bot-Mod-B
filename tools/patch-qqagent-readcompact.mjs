// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-readcompact.mjs — B22「已读信息分段摘要」幂等补丁
//
// 用法：node patch-qqagent-readcompact.mjs [--dry]
// 做什么：把 design-qqbotb-session.md §九 的改动落进 _unpack 源码：
//   · 新增 src/readlog.js（前情摘要段存储 / 注入 / 检索 / 归档）
//   · session-state 增 readFloorTs + 会话要点归档检索
//   · prompt.js 已读窗口下界 + 【前情提要】段
//   · orchestrator.js 超预算时异步压缩 + 收工轮归档
//   · tools.js memory_search 增 category=history
//   · routes.js / UI 增观测面与手动压缩入口
// 语义：源码改动的唯一落盘通道——重装应用后按补丁链重跑即复现（_unpack 可弃）
// 幂等：每个补丁点带唯一标记 [qqagent-readcompact-patch:<id>]；已含标记 = 跳过
// 边界：不改 tier=4 全量口径（readMaxChars=0 即回到会话全量）/ 不改锚点机制 / 不改消息存档格式

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-readcompact-patch:' + id + ']';

function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

function patch(id, rel, anchor, replacement, expect = 1) {
  const file = path.join(SRC, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  // 幂等检测二：替换体自带的任一标记已在文件里 = 该补丁已应用（标记名与 id 可能不同名）。
  const rMarkers = [...r.matchAll(/\[qqagent-readcompact-patch:([^\]]+)\]/g)].map((m) => m[1]);
  if (rMarkers.some((x) => text.includes('[qqagent-readcompact-patch:' + x + ']'))) {
    results.push({ id, file: rel, status: 'skipped' });
    return;
  }
  const hits = text.split(a).length - 1;
  if (hits !== expect) {
    const lines = r.split('\n').map((s) => s.trim()).filter(Boolean);
    const first = lines[0] || '';
    const last = lines[lines.length - 1] || '';
    if (first && last && text.includes(first) && text.includes(last)) { results.push({ id, file: rel, status: 'skipped' }); return; }
    throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
  }
  // 幂等兜底三：锚点仍在但替换体首尾行已在文件里 → 视为已应用（防重复插入）。
  {
    const lines = r.split('\n').map((s) => s.trim()).filter(Boolean);
    const first = lines[0] || '';
    const last = lines[lines.length - 1] || '';
    if (first && last && text.includes(first) && text.includes(last)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  }
  if (!DRY) fs.writeFileSync(file, text.replace(a, r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

function addFile(id, rel, content) {
  const file = path.join(SRC, rel);
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
    throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel);
  }
  if (!DRY) fs.writeFileSync(file, toEol(content, detectEol(path.join(SRC, 'config.js'))), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 新增 src/readlog.js —— 已读信息分段摘要的存储 / 注入 / 检索 / 归档
// ─────────────────────────────────────────────────────────────────────────────
const READLOG_JS = `// 已读信息分段摘要（B22）—— 把「会话全量」的已读窗口切成「近期细读 + 远期摘要」。
// [qqagent-readcompact-patch:readlog]
//
// 背景：会话窗口模式下【已读信息】= 会话起点之后的全部消息，是 prompt 里唯一
// 随天数线性增长的段。记忆整理（consolidate）只处理群友印象/群记，不碰已读；
// 已读只靠收工轮轮转收缩。本模块把「较早的已读」压缩成摘要段，配合
// session-state.readFloorTs 让原文出窗：
//   · readFloorTs 之前的消息不再进【已读信息】（原文仍在 store，get_recent_messages 可翻）；
//   · 摘要段进【前情提要】段（prompt.js），并可被 memory_search category=history 检索；
//   · 收工轮轮转时整批归档（append-only），新会话从零开始。
//
// 载体：
//   data/memory/<chat>/_readlog.json             当前会话的前情摘要段
//   data/memory/<chat>/archive/readlog-*.jsonl   归档（append-only，按天分卷）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const ARCHIVE_DIR = 'archive';
const MAX_SEGMENTS = 200;       // 活跃段软上限；超出转归档（不丢）
const MAX_SUMMARY = 2000;       // 单段摘要上限

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 前情摘要文件路径（与 _session.json 同址）。 */
export function readLogFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_readlog.json');
}

function archiveDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), ARCHIVE_DIR);
}

function archiveFile(chatKey, at) {
  const d = new Date(Number(at) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return path.join(archiveDir(chatKey), 'readlog-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.jsonl');
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

function formatStamp(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function normalizeSegment(raw, index) {
  const summary = String(raw && raw.summary || '').trim().slice(0, MAX_SUMMARY);
  if (!summary) return null;
  return {
    id: String((raw && raw.id) || ('r' + index)),
    fromTs: Math.max(0, Number(raw && raw.fromTs) || 0),
    toTs: Math.max(0, Number(raw && raw.toTs) || 0),
    messageCount: Math.max(0, Number(raw && raw.messageCount) || 0),
    chars: Math.max(0, Number(raw && raw.chars) || 0),
    summary,
    createdAt: Math.max(0, Number(raw && raw.createdAt) || 0)
  };
}

/** 读当前会话的活跃摘要段（时间升序）。 */
export function listReadSegments(chatKey) {
  const raw = readJson(readLogFile(chatKey), null);
  const list = Array.isArray(raw && raw.segments) ? raw.segments : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = normalizeSegment(list[i], i);
    if (s) out.push(s);
  }
  return out;
}

function appendArchiveEntries(chatKey, segments, reason) {
  const list = (Array.isArray(segments) ? segments : []).filter((s) => s && s.summary);
  if (!list.length) return 0;
  try {
    fs.mkdirSync(archiveDir(chatKey), { recursive: true });
    const now = Date.now();
    const lines = list.map((s) => JSON.stringify({
      id: String(s.id || ''),
      fromTs: Number(s.fromTs) || 0,
      toTs: Number(s.toTs) || 0,
      messageCount: Number(s.messageCount) || 0,
      chars: Number(s.chars) || 0,
      summary: String(s.summary).slice(0, MAX_SUMMARY),
      createdAt: Number(s.createdAt) || 0,
      archivedAt: now,
      reason: String(reason || 'manual')
    }));
    fs.appendFileSync(archiveFile(chatKey, now), lines.join('\\n') + '\\n', 'utf8');
    return list.length;
  } catch (error) {
    console.warn('[readlog] 归档失败（摘要仍留在活跃段）:', error && error.message || error);
    return 0;
  }
}

function saveSegments(chatKey, segments) {
  const list = (Array.isArray(segments) ? segments : []).map((s, i) => normalizeSegment(s, i)).filter(Boolean);
  const overflow = list.length > MAX_SEGMENTS ? list.slice(0, list.length - MAX_SEGMENTS) : [];
  if (overflow.length) appendArchiveEntries(chatKey, overflow, 'overflow');
  const keep = list.slice(-MAX_SEGMENTS);
  writeJson(readLogFile(chatKey), { chatKey: String(chatKey), segments: keep, updatedAt: Date.now() });
  return keep;
}

/** 追加一段前情摘要。 */
export function appendReadSegment(chatKey, { fromTs = 0, toTs = 0, messageCount = 0, chars = 0, summary = '' } = {}) {
  const text = String(summary || '').trim().slice(0, MAX_SUMMARY);
  if (!text) return null;
  const now = Date.now();
  const list = listReadSegments(chatKey);
  const seg = {
    id: 'r' + now.toString(36) + '-' + list.length,
    fromTs: Math.max(0, Number(fromTs) || 0),
    toTs: Math.max(0, Number(toTs) || 0),
    messageCount: Math.max(0, Number(messageCount) || 0),
    chars: Math.max(0, Number(chars) || 0),
    summary: text,
    createdAt: now
  };
  saveSegments(chatKey, list.concat([seg]));
  return seg;
}

/** 清空活跃摘要段（归档成功后用）。 */
export function clearReadSegments(chatKey) {
  writeJson(readLogFile(chatKey), { chatKey: String(chatKey), segments: [], updatedAt: Date.now() });
}

/** 把当前活跃摘要段整批归档并清空；返回归档条数（失败 0 = 保留活跃段）。 */
export function archiveReadSegments(chatKey, reason = 'rollover') {
  const segments = listReadSegments(chatKey);
  if (!segments.length) return 0;
  const n = appendArchiveEntries(chatKey, segments, reason);
  if (n > 0) clearReadSegments(chatKey);
  return n;
}

/** 读归档摘要段（keyword 过滤；新的在前）。 */
export function listArchivedReadSegments(chatKey, { since = 0, keyword = '', limit = 200 } = {}) {
  const dir = archiveDir(chatKey);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('readlog-') && f.endsWith('.jsonl')).sort(); } catch { return []; }
  const kw = String(keyword || '').trim().toLowerCase();
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\\n')) {
      const t = line.trim();
      if (!t) continue;
      let e = null;
      try { e = JSON.parse(t); } catch { continue; }
      const summary = String(e && e.summary || '').trim();
      if (!summary) continue;
      if (since && (Number(e.createdAt) || 0) < since) continue;
      if (kw && !summary.toLowerCase().includes(kw)) continue;
      out.push({ ...e, summary });
    }
  }
  out.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 归档统计（索引 / 记忆页 / memory_search 回执用）。 */
export function readLogStats(chatKey) {
  const live = listReadSegments(chatKey);
  let archived = 0;
  let latestAt = 0;
  try {
    const dir = archiveDir(chatKey);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('readlog-') && f.endsWith('.jsonl'));
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\\n')) {
        const t = line.trim();
        if (!t) continue;
        archived += 1;
        try { latestAt = Math.max(latestAt, Number(JSON.parse(t).archivedAt) || 0); } catch { /* 坏行只计数 */ }
      }
    }
  } catch { /* 无归档目录 */ }
  return { count: live.length, archived, latestAt };
}

/** 渲染【前情提要】段：只展开最近若干段，总字符受 maxChars 约束。 */
export function formatReadLogForPrompt(chatKey, { maxChars = 8000 } = {}) {
  const segments = listReadSegments(chatKey);
  if (!segments.length) return '';
  const cap = Math.max(0, Number(maxChars) || 0);
  const picked = [];
  let used = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    const block = '- [' + formatStamp(s.fromTs) + ' → ' + formatStamp(s.toTs) + ' · ' + s.messageCount + ' 条] ' + s.summary;
    if (picked.length && cap > 0 && used + block.length + 1 > cap) break;
    picked.unshift(block);
    used += block.length + 1;
  }
  const withheld = segments.length - picked.length;
  const lines = ['【前情提要】以下是本会话较早前情的压缩摘要（原文已从【已读信息】移出；要查细节用 检索记忆 memory_search，category=history，或 查看历史消息 get_recent_messages）：'];
  lines.push(...picked);
  if (withheld > 0) lines.push('（更早的 ' + withheld + ' 段前情未展开——要看得用 检索记忆 memory_search，category=history）');
  return lines.join('\\n');
}

/** 按关键词搜活跃 + 归档摘要段（memory_search category=history 用）。 */
export function searchReadSegments(chatKey, { keyword = '', limit = 20, includeArchived = true } = {}) {
  const kw = String(keyword || '').trim().toLowerCase();
  const match = (s) => !kw || String(s.summary).toLowerCase().includes(kw);
  const cap = Math.min(100, Math.max(1, Number(limit) || 20));
  const live = listReadSegments(chatKey).filter(match).slice(-cap).reverse();
  const archived = includeArchived
    ? listArchivedReadSegments(chatKey, { keyword, limit: cap }).filter(match).slice(0, cap)
    : [];
  return { live, archived };
}

/** 旧消息 → 摘要模型输入（时间 + 发言人 + 正文；正文单条截 600 字符）。 */
export function formatMessagesForSummary(messages) {
  const p = (n) => String(n).padStart(2, '0');
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const d = new Date(Number(m && m.ts) || 0);
    const who = m && m.self ? '我' : String(m && (m.senderName || m.senderId) || '未知');
    const text = String(m && m.text || '').replace(/\\s+/g, ' ').slice(0, 600);
    return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] ' + who + '：' + text;
  }).join('\\n');
}
`;

addFile('readlog', 'readlog.js', READLOG_JS);

// ─────────────────────────────────────────────────────────────────────────────
// session-state.js —— readFloorTs + 会话要点归档 / 检索
// ─────────────────────────────────────────────────────────────────────────────
patch('session-state-floor', 'session-state.js',
`    // 记忆回溯点（0 = 关闭）——收工轮取材可早于本会话起点（如领航员开启那一刻）
    // [qqagent-session-patch:memory-reach-state]
    memoryFloorTs: Math.max(0, Number(st?.memoryFloorTs) || 0),
    updatedAt: Math.max(0, Number(st?.updatedAt) || 0)`,
`    // 记忆回溯点（0 = 关闭）——收工轮取材可早于本会话起点（如领航员开启那一刻）
    // [qqagent-session-patch:memory-reach-state]
    memoryFloorTs: Math.max(0, Number(st?.memoryFloorTs) || 0),
    // 已读信息窗口下界（B22）：readFloorTs 之前的已读不再进提示词，由【前情提要】承载。
    // [qqagent-readcompact-patch:session-state-floor]
    readFloorTs: Math.max(0, Number(st?.readFloorTs) || 0),
    updatedAt: Math.max(0, Number(st?.updatedAt) || 0)`);

patch('session-state-reset', 'session-state.js',
`export function resetSession(chatKey) {
  const cur = getSessionState(chatKey);
  return setSessionState(chatKey, { startedAt: Date.now(), lastPromptTokens: 0, rollovers: cur.rollovers + 1 });
}`,
`export function resetSession(chatKey) {
  const cur = getSessionState(chatKey);
  // readFloorTs 归零：新会话的已读窗口重新从会话起点开始（B22）
  // [qqagent-readcompact-patch:session-state-reset]
  return setSessionState(chatKey, { startedAt: Date.now(), lastPromptTokens: 0, rollovers: cur.rollovers + 1, readFloorTs: 0 });
}`);

patch('session-state-readfloor', 'session-state.js',
`/** 置记忆回溯点（0 = 关闭）。领航员开启时置位；收工轮沉淀完成后清零。 */
export function setMemoryFloor(chatKey, at = Date.now()) {
  return setSessionState(chatKey, { memoryFloorTs: Math.max(0, Number(at) || 0) });
}`,
`/** 置记忆回溯点（0 = 关闭）。领航员开启时置位；收工轮沉淀完成后清零。 */
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
}`);

patch('session-state-summary-archive', 'session-state.js',
`export function readSessionSummary(chatKey) {
  const raw = readJson(sessionSummaryFile(chatKey), null);
  if (!raw || !String(raw.summary || '').trim()) return null;
  return {
    summary: String(raw.summary),
    createdAt: Number(raw.createdAt) || 0,
    rollovers: Number(raw.rollovers) || 0,
    messages: Number(raw.messages) || 0
  };
}`,
`export function readSessionSummary(chatKey) {
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
    fs.appendFileSync(file, JSON.stringify({ ...raw, archivedAt: Date.now(), reason: String(reason || 'rollover') }) + '\\n', 'utf8');
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
    for (const line of text.split('\\n')) {
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
}`);

// ─────────────────────────────────────────────────────────────────────────────
// config.js —— session.read* 默认值
// ─────────────────────────────────────────────────────────────────────────────
patch('config-readcompact', 'config.js',
`  session: {
    enabled: true,
    maxContextTokens: 300000
  },`,
`  session: {
    enabled: true,
    maxContextTokens: 300000,
    // ── 已读信息分段摘要（B22，2026-10-18）──
    // readMaxChars：详细已读窗口的字符预算；超过就把最旧的一段压成【前情提要】。
    // 0 = 关闭（完全回到"会话全量"）。readKeepChars：压缩后保留的详细字符数。
    // readCompactChunkChars：单次摘要调用最多吃多少字符（分块）。
    // readDigestMaxChars：【前情提要】注入总字符上限。
    // [qqagent-readcompact-patch:config]
    readMaxChars: 60000,
    readKeepChars: 40000,
    readCompactChunkChars: 50000,
    readDigestMaxChars: 8000,
    // 摘要用模型：主模型（如 hy4-preview-f）是推理模型，纯文本压缩请求会被推理链
    // 吃光 max_tokens 导致 content 恒空（2026-10-18 实测：3000 token 全进 reasoning）。
    // 必须选快档；空 = 跟随记忆整理模型（memory.useChatModel）。
    // [qqagent-readcompact-patch:config-summary-model]
    readSummaryModel: 'deepseek-v4.1-flash',
    readSummaryMaxTokens: 4000
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// prompt.js —— 已读窗口下界 + 【前情提要】
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-import', 'prompt.js',
`// 会话级记忆摘要（收工轮产出）——【记忆】段首块（[qqagent-session-patch:prompt-import]）
import { formatSessionSummaryForPrompt } from './session-state.js';`,
`// 会话级记忆摘要（收工轮产出）——【记忆】段首块（[qqagent-session-patch:prompt-import]）
import { formatSessionSummaryForPrompt } from './session-state.js';
// 已读信息分段摘要（B22）——【前情提要】段 + 已读窗口下界
// [qqagent-readcompact-patch:prompt-import]
import { formatReadLogForPrompt } from './readlog.js';
import { getReadFloorTs } from './session-state.js';`);

patch('prompt-past-return', 'prompt.js',
`  const lines = messages.map((m) => formatEntry(m, { withId: (m.media || []).length > 0 }));
  // 一并把选中的消息返回：调用方要用它判定"记忆该带哪些群友"，
  // 避免模型看到历史里根本没出现的群友印象（那样显得莫名其妙）。
  return { text: lines.join('\\n'), count: lines.length, messages };`,
`  const lines = messages.map((m) => formatEntry(m, { withId: (m.media || []).length > 0 }));
  // 一并把选中的消息返回：调用方要用它判定"记忆该带哪些群友"，
  // 避免模型看到历史里根本没出现的群友印象（那样显得莫名其妙）。
  // chars / lineChars：B22 压缩判据与按行切块用（与提示词实际字符同口径）。
  // [qqagent-readcompact-patch:prompt-past-return]
  const text = lines.join('\\n');
  return { text, chars: text.length, lineChars: lines.map((l) => l.length), count: lines.length, messages };`);

patch('prompt-readfloor', 'prompt.js',
`  // 会话窗口起点（orchestrator 传入；null = 关闭窗口）。[qqagent-session-patch:prompt-session-start]
  const sessionStartRaw = ctx.sessionStart === null || ctx.sessionStart === undefined ? null : Number(ctx.sessionStart);
  const sessionWindowed = Number.isFinite(sessionStartRaw);
  const past = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : contextLimit,
    sinceTs: sessionWindowed ? sessionStartRaw : null
  });`,
`  // 会话窗口起点（orchestrator 传入；null = 关闭窗口）。[qqagent-session-patch:prompt-session-start]
  const sessionStartRaw = ctx.sessionStart === null || ctx.sessionStart === undefined ? null : Number(ctx.sessionStart);
  const sessionWindowed = Number.isFinite(sessionStartRaw);
  // 已读窗口下界（B22）：普通轮取 max(会话起点, readFloorTs)；收工轮 orchestrator 传 0
  // = 全量取材（记忆沉淀不能被已读压缩截断）。[qqagent-readcompact-patch:prompt-readfloor]
  const readFloorRaw = ctx.readFloorTs === null || ctx.readFloorTs === undefined ? 0 : Number(ctx.readFloorTs);
  const readFloor = Number.isFinite(readFloorRaw) && readFloorRaw > 0 ? readFloorRaw : 0;
  const windowStart = sessionWindowed ? Math.max(sessionStartRaw, readFloor) : null;
  const past = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : contextLimit,
    sinceTs: windowStart
  });`);

patch('prompt-past-pool', 'prompt.js',
`  const pastPool = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : 500,
    sinceTs: sessionWindowed ? sessionStartRaw : null
  });`,
`  const pastPool = buildPastState(ctx.store, ctx.chatKey, {
    excludeIds,
    limit: sessionWindowed ? 0 : 500,
    sinceTs: windowStart
  });`);

patch('prompt-digest', 'prompt.js',
`  // 记忆段（锚定模式的字节前缀从这段开始跨轮不变）
  if (memText) parts.push(\`【记忆】\\n\${memText}\`);

  // 已读信息（锚定模式 = 锚点条目；标准模式 = 全部条目）`,
`  // 记忆段（锚定模式的字节前缀从这段开始跨轮不变）
  if (memText) parts.push(\`【记忆】\\n\${memText}\`);

  // 前情提要（B22）：较早的已读已压缩成摘要段，放在【已读信息】之前。
  // 同一会话内只在压缩时变化，属于稳定前缀。[qqagent-readcompact-patch:prompt-digest]
  const readDigest = sessionWindowed && readFloor > 0
    ? formatReadLogForPrompt(ctx.chatKey, { maxChars: Math.max(0, Number(cfg.session?.readDigestMaxChars) || 8000) })
    : '';
  if (readDigest) parts.push(readDigest);

  // 已读信息（锚定模式 = 锚点条目；标准模式 = 全部条目）`);

patch('prompt-readchars', 'prompt.js',
`  } else {
    parts.push('【已读信息】（暂无历史记录，这是你第一次参与这个会话）');
  }

  // ── 此刻状态段已删除（2026-09-25 改版）──`,
`  } else {
    parts.push('【已读信息】（暂无历史记录，这是你第一次参与这个会话）');
  }

  // B22：记录本轮已读段实际字符（含【前情提要】），供观测与验收。
  // [qqagent-readcompact-patch:prompt-readchars]
  if (ctx.session && typeof ctx.session === 'object') {
    ctx.session.readChars = readHeaderText.length + (readDigest ? readDigest.length : 0);
    ctx.session.readFloorTs = readFloor;
  }

  // ── 此刻状态段已删除（2026-09-25 改版）──`);

// ─────────────────────────────────────────────────────────────────────────────
// orchestrator.js —— 异步压缩 + 收工轮归档
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import-prompt', 'orchestrator.js',
`import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';`,
`import { buildSystemPrompt, buildUserPrompt, resolveContextTier, buildPastState } from './prompt.js';   // buildPastState：B22 压缩判据`);

patch('orchestrator-import-session', 'orchestrator.js',
`  // 沉淀拍判据要读会话要点时间——[qqagent-memory-patch:no-throttle-sediment-import]
  readSessionSummary
} from './session-state.js';`,
`  // 沉淀拍判据要读会话要点时间——[qqagent-memory-patch:no-throttle-sediment-import]
  readSessionSummary,
  // 已读信息分段摘要（B22）——[qqagent-readcompact-patch:orchestrator-import]
  getReadFloorTs, setReadFloor, archiveSessionSummary
} from './session-state.js';
// 已读前情摘要段（B22）——[qqagent-readcompact-patch:orchestrator-import-readlog]
import { appendReadSegment, archiveReadSegments, formatMessagesForSummary } from './readlog.js';`);

patch('orchestrator-ctor', 'orchestrator.js',
`    this.consolidating = new Set();    // 正在整理记忆的 chatKey`,
`    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    // 已读前情压缩（B22）——[qqagent-readcompact-patch:orchestrator-ctor]
    this.compacting = new Set();       // 正在压缩已读窗口的 chatKey
    this.compactFailAt = new Map();    // chatKey -> 上次失败时刻（10 分钟退避）`);

patch('orchestrator-hook', 'orchestrator.js',
`      if (!lastError) this.rateLimitRetries.delete(chatKey);   // [qqagent-session-patch:orchestrator-post-run]`,
`      // 已读信息分段压缩（B22）：普通轮成功后异步检查，超预算就把最旧一段压成【前情提要】。
      // 不阻塞聊天；失败保留原文，下一轮再试。[qqagent-readcompact-patch:orchestrator-hook]
      if (!lastError && !isRollover) this.#maybeCompactRead(chatKey);
      if (!lastError) this.rateLimitRetries.delete(chatKey);   // [qqagent-session-patch:orchestrator-post-run]`);

patch('orchestrator-runargs', 'orchestrator.js',
`      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      sessionStart,
      session`,
`      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      sessionStart,
      // 普通轮套已读窗口下界；收工轮传 0 = 全量取材（B22）
      // [qqagent-readcompact-patch:orchestrator-runargs]
      readFloorTs: rollover ? 0 : getReadFloorTs(chatKey),
      session`);

patch('orchestrator-methods', 'orchestrator.js',
`  /**
   * 收工轮收尾：要点写会话级记忆 → 归档当前存档 → 重置会话状态（新会话开始）。
   * [qqagent-session-patch:orchestrator-methods]
   */
  async #completeRollover(chatKey, session) {`,
`  // ── 已读信息分段摘要（B22）────────────────────────────────────────────
  // [qqagent-readcompact-patch:orchestrator-methods]

  /** 每轮普通运行结束后检查一次已读窗口；超预算就异步压缩（不阻塞聊天）。 */
  #maybeCompactRead(chatKey) {
    try {
      const cfg = getConfig().session || {};
      const maxChars = Math.max(0, Number(cfg.readMaxChars) || 0);
      if (cfg.enabled === false || !maxChars) return;
      if (this.paused || this.aborted) return;
      if (this.compacting.has(chatKey)) return;
      const lastFail = this.compactFailAt.get(chatKey) || 0;
      if (Date.now() - lastFail < 10 * 60 * 1000) return;
      this.compacting.add(chatKey);
      this.compactReadWindow(chatKey)
        .catch((error) => {
          this.compactFailAt.set(chatKey, Date.now());
          logger.warn('session', chatKey + ' 已读前情压缩失败（保留原文）：' + String(error && error.message || error));
        })
        .finally(() => this.compacting.delete(chatKey));
    } catch { /* 压缩是锦上添花，不影响主流程 */ }
  }

  /**
   * 已读信息分段压缩：把最旧的一段已读消息压成【前情提要】摘要，然后推进
   * readFloorTs，让原文退出【已读信息】。失败一律保留原文（不推进 floor）。
   * @param {string} chatKey
   * @param {{force?:boolean}} [opts] force=true 时即使未超预算也压（验收 / 运维用）
   * @returns {Promise<object>} 统计
   */
  async compactReadWindow(chatKey, { force = false } = {}) {
    const cfg = getConfig().session || {};
    const maxChars = Math.max(0, Number(cfg.readMaxChars) || 0);
    if (!maxChars && !force) return { ok: true, skipped: 'disabled' };
    const sessionStart = sessionWindowStart(chatKey);
    if (sessionStart === null) return { ok: true, skipped: 'session-off' };
    const floor = Math.max(sessionStart, getReadFloorTs(chatKey));
    const past = buildPastState(this.store, chatKey, { limit: 0, sinceTs: floor });
    // 计量口径 = 提示词里的全部已读条目（含未读触发批，它们同在一段里），
    // 但只有**已读**的条目可被摘要（未读是本轮待看的消息，不能先压掉）。
    // [qqagent-readcompact-patch:orchestrator-accounting]
    const items = [];
    let totalChars = 0;
    for (let i = 0; i < past.messages.length; i++) {
      const m = past.messages[i];
      if (!m) continue;
      const chars = (past.lineChars[i] || 0) + 1;
      totalChars += chars;
      items.push({ message: m, chars, eligible: Boolean(m.self || m.read) });
    }
    const limitChars = maxChars || 60000;
    if (!force && totalChars <= limitChars) {
      return { ok: true, skipped: 'under', chars: totalChars, maxChars: limitChars };
    }
    const keepChars = Math.min(Math.max(0, limitChars - 1),
      Math.max(0, Number(cfg.readKeepChars) || Math.round(limitChars * 0.6)));
    let cut = 0;
    let remain = totalChars;
    while (cut < items.length && remain > keepChars && items[cut].eligible) {
      remain -= items[cut].chars;
      cut++;
    }
    if (cut <= 0) return { ok: true, skipped: 'nothing', chars: totalChars, maxChars: limitChars };
    const chunkMax = Math.max(5000, Number(cfg.readCompactChunkChars) || 50000);
    const chunks = [];
    let cur = [];
    let curChars = 0;
    for (let i = 0; i < cut; i++) {
      const it = items[i];
      if (cur.length && curChars + it.chars > chunkMax) {
        chunks.push({ items: cur, chars: curChars });
        cur = [];
        curChars = 0;
      }
      cur.push(it);
      curChars += it.chars;
    }
    if (cur.length) chunks.push({ items: cur, chars: curChars });

    let summarized = 0;
    let lastTs = 0;
    let segments = 0;
    for (const chunk of chunks) {
      const messages = chunk.items.map((x) => x.message);
      const fromTs = Number(messages[0] && messages[0].ts) || 0;
      const toTs = Number(messages[messages.length - 1] && messages[messages.length - 1].ts) || 0;
      const text = formatMessagesForSummary(messages);
      const summary = await this.#summarizeReadChunk(chatKey, text, { fromTs, toTs, count: messages.length });
      if (!summary) break;
      appendReadSegment(chatKey, { fromTs, toTs, messageCount: messages.length, chars: chunk.chars, summary });
      summarized += messages.length;
      lastTs = toTs;
      segments++;
    }
    if (!summarized) {
      return { ok: false, error: '摘要未产出（原文保留）', chars: totalChars, maxChars: limitChars };
    }
    setReadFloor(chatKey, lastTs + 1);
    this.promptAnchors.delete(chatKey);
    const afterPast = buildPastState(this.store, chatKey, { limit: 0, sinceTs: Math.max(sessionStart, getReadFloorTs(chatKey)) });
    logger.info('session', chatKey + ' 已读前情压缩：' + totalChars + ' → ' + afterPast.chars
      + ' 字符（压缩 ' + summarized + ' 条 / ' + segments + ' 段，readFloorTs=' + getReadFloorTs(chatKey) + '）');
    return {
      ok: true,
      beforeChars: totalChars,
      afterChars: afterPast.chars,
      summarized,
      segments,
      readFloorTs: getReadFloorTs(chatKey)
    };
  }

  /** 单块旧消息 → 前情摘要（失败返回空串，不抛）。 */
  async #summarizeReadChunk(chatKey, text, { fromTs = 0, toTs = 0, count = 0 } = {}) {
    const cfg = getConfig();
    const summaryModel = String(cfg.session?.readSummaryModel || '').trim();
    // 摘要用模型必须选快档：主模型（推理模型）会先产数百到数千 token 推理，
    // max_tokens 被吃光时 content 恒空（2026-10-18 实测 hy4-preview-f 3000 token 全进
    // reasoning、content 为空）。默认 deepseek-v4.1-flash（2 秒级出稿）。
    // [qqagent-readcompact-patch:summarize-model]
    const summaryMaxTokens = Math.max(1500, Number(cfg.session?.readSummaryMaxTokens) || 4000);
    const stamp = (ts) => {
      const d = new Date(Number(ts) || 0);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    const messages = [
      {
        role: 'system',
        content: '你是聊天机器人的记忆模块，负责把群聊旧记录压缩成"前情提要"。只保留以后还用得上的事实：人物与关系、发生的事、结论/决定、时间点、未了的事、值得记的梗；去掉寒暄、重复和无关闲聊。不要编造。输出 3~8 条短句，每条不超过 80 字，总长不超过 1200 字。直接输出正文，不要 Markdown 代码块。'
      },
      {
        role: 'user',
        content: '下面是群聊（' + chatKey + '）在 ' + stamp(fromTs) + ' 至 ' + stamp(toTs) + ' 的 ' + count
          + ' 条旧消息（已读，即将从近期上下文移出）。请压缩成前情提要：\\n\\n' + text
      }
    ];
    try {
      const api = cfg.api || {};
      const r = summaryModel
        ? await chatCompletion({
          messages,
          temperature: 0.2,
          maxTokens: summaryMaxTokens,
          overrides: {
            ...api,
            apiKey: resolveApiKey(cfg),
            model: summaryModel,
            timeoutMs: Math.max(60000, Number(api.timeoutMs) || 90000)
          }
        })
        : await this.#memoryChat(messages, { maxTokens: summaryMaxTokens });
      const content = String(r && r.message && r.message.content || '').trim();
      if (!content) {
        logger.warn('session', chatKey + ' 前情摘要为空（' + count + ' 条旧消息 · 模型 ' + (summaryModel || '跟随记忆整理模型')
          + ' · finish=' + String(r && r.finishReason || '?') + '），保留原文');
        return '';
      }
      return content.slice(0, 2000);
    } catch (error) {
      logger.warn('session', chatKey + ' 前情摘要失败（' + count + ' 条旧消息）：' + String(error && error.message || error));
      return '';
    }
  }

  /**
   * 收工轮收尾：要点写会话级记忆 → 归档当前存档 → 重置会话状态（新会话开始）。
   * [qqagent-session-patch:orchestrator-methods]
   */
  async #completeRollover(chatKey, session) {`);

patch('orchestrator-rollover-session-archive', 'orchestrator.js',
`      const state = getSessionState(chatKey);
      const summary = this.#collectRolloverSummary(session);
      writeSessionSummary(chatKey, summary, {`,
`      const state = getSessionState(chatKey);
      const summary = this.#collectRolloverSummary(session);
      // B22：上一份会话要点先入归档（memory_search category=history 可搜），再写新的。
      // [qqagent-readcompact-patch:rollover-session-archive]
      archiveSessionSummary(chatKey, 'rollover');
      writeSessionSummary(chatKey, summary, {`);

patch('orchestrator-rollover-readlog', 'orchestrator.js',
`      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);`,
`      // B22：当前会话的前情摘要段整批归档（append-only），新会话从零开始。
      // 归档失败只留痕，不阻断轮转。[qqagent-readcompact-patch:rollover-readlog-archive]
      const readArchived = archiveReadSegments(chatKey, 'rollover');
      if (readArchived) console.log('[orchestrator] ' + chatKey + ' 前情摘要归档 ' + readArchived + ' 段');
      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);`);

patch('orchestrator-memorychat', 'orchestrator.js',
`  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }`,
`  async #memoryChat(messages, { maxTokens = 0 } = {}) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2, maxTokens });
    }`);

patch('orchestrator-memorychat-provider', 'orchestrator.js',
`    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });`,
`    return chatCompletion({
      messages,
      temperature: 0.2,
      maxTokens,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });`);

// ─────────────────────────────────────────────────────────────────────────────
// tools.js —— memory_search category=history
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', 'tools.js',
`// 群记（群级记忆：梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-import]`,
`// 已读前情摘要检索（B22）——[qqagent-readcompact-patch:tools-import]
import { searchReadSegments, readLogStats } from './readlog.js';
import { searchSessionSummaries } from './session-state.js';
// 群记（群级记忆：梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-import]`);

patch('tools-memory-search-desc', 'tools.js',
`    description: '按关键词检索本会话的长期记忆——现行池与归档一起搜。想确认"以前是不是聊过/记过某件事"、或【记忆】段里写了"另有 N 条已归档"时用它。',`,
`    description: '按关键词检索本会话的长期记忆——现行池与归档一起搜；category=history 还能搜【前情提要】的旧聊天摘要与历次会话要点。想确认"以前是不是聊过/记过某件事"、或【记忆】段里写了"另有 N 条已归档"时用它。',`);

patch('tools-memory-search-enum', 'tools.js',
`        category: { type: 'string', enum: ['all', 'member', 'group'], description: '搜哪一轴（默认 all）' },`,
`        category: { type: 'string', enum: ['all', 'member', 'group', 'history'], description: '搜哪一轴（默认 all；history=前情提要/旧会话要点）' },`);

patch('tools-memory-search-history', 'tools.js',
`      if (category === 'all' || category === 'group') {
        const live = listGroupEntries(ctx.chatKey)
          .filter((e) => !kw || String(e.content).toLowerCase().includes(kw));
        out.group = live.slice(-limit);
        if (includeArchived) {
          const arch = listArchivedGroupEntries(ctx.chatKey, { keyword, limit });
          if (arch.length) out.groupArchived = arch;
        }
      }
      const gArch = groupArchiveStats(ctx.chatKey);
      out.archive = { group: gArch.count, member: ctx.memory.memberArchiveStats(ctx.chatKey).count };
      return ok(out);`,
`      if (category === 'all' || category === 'group') {
        const live = listGroupEntries(ctx.chatKey)
          .filter((e) => !kw || String(e.content).toLowerCase().includes(kw));
        out.group = live.slice(-limit);
        if (includeArchived) {
          const arch = listArchivedGroupEntries(ctx.chatKey, { keyword, limit });
          if (arch.length) out.groupArchived = arch;
        }
      }
      // 已读前情摘要 + 历次会话要点（B22）——[qqagent-readcompact-patch:tools-memory-search-history]
      if (category === 'all' || category === 'history') {
        const hist = searchReadSegments(ctx.chatKey, { keyword, limit, includeArchived });
        if (hist.live.length) out.history = hist.live;
        if (hist.archived.length) out.historyArchived = hist.archived;
        const sess = searchSessionSummaries(ctx.chatKey, { keyword, limit });
        if (sess.length) out.sessionSummaries = sess;
      }
      const gArch = groupArchiveStats(ctx.chatKey);
      out.archive = {
        group: gArch.count,
        member: ctx.memory.memberArchiveStats(ctx.chatKey).count,
        history: readLogStats(ctx.chatKey).archived
      };
      return ok(out);`);

// ─────────────────────────────────────────────────────────────────────────────
// routes.js —— 观测面 + 手动压缩入口
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-import', 'routes.js',
`// 回应参数（记忆页展示 / 手动查看）——[qqagent-rapport-patch:routes-import]
import { listRapport } from './rapport.js';`,
`// 回应参数（记忆页展示 / 手动查看）——[qqagent-rapport-patch:routes-import]
import { listRapport } from './rapport.js';
// 已读前情摘要统计（B22）——[qqagent-readcompact-patch:routes-import]
import { readLogStats } from './readlog.js';`);

patch('routes-sessions-row', 'routes.js',
`          const st = getSessionState(key);
          return {
            chatKey: key,
            startedAt: st.startedAt,
            rollovers: st.rollovers,
            lastPromptTokens: st.lastPromptTokens,
            total: meta.total,
            unread: meta.unread,
            lastTs: meta.lastTs
          };`,
`          const st = getSessionState(key);
          const rl = readLogStats(key);
          return {
            chatKey: key,
            startedAt: st.startedAt,
            rollovers: st.rollovers,
            lastPromptTokens: st.lastPromptTokens,
            // B22 已读分段摘要观测面——[qqagent-readcompact-patch:routes-sessions-row]
            readFloorTs: st.readFloorTs,
            readSegments: rl.count,
            readArchived: rl.archived,
            total: meta.total,
            unread: meta.unread,
            lastTs: meta.lastTs
          };`);

patch('routes-compact', 'routes.js',
`    {
      method: 'GET', pattern: '/api/sessions',`,
`    {
      // 手动触发一次已读前情压缩（B22 运维 / 验收用；force=false 时只在超预算才压）
      // [qqagent-readcompact-patch:routes-compact]
      method: 'POST', pattern: '/api/session/compact',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const chatKey = String(body?.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: 'chatKey 必填' });
        if (typeof orchestrator.compactReadWindow !== 'function') {
          return json(res, 501, { ok: false, error: '当前版本不支持已读压缩' });
        }
        try {
          const result = await orchestrator.compactReadWindow(chatKey, { force: body?.force !== false });
          return json(res, 200, result);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',`);

// ─────────────────────────────────────────────────────────────────────────────
// UI —— 会话页群行显示前情摘要段数 / 归档段数
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-session-row', '../ui/app/02-sse-sessions.js',
`  if (m.lastPromptTokens) bits.push('前文 ' + fmtTokens(m.lastPromptTokens));
  if (m.rollovers) bits.push('轮转 ' + m.rollovers + ' 次');`,
`  if (m.lastPromptTokens) bits.push('前文 ' + fmtTokens(m.lastPromptTokens));
  if (m.rollovers) bits.push('轮转 ' + m.rollovers + ' 次');
  // B22：已读分段摘要段数 / 归档段数（观测面）——[qqagent-readcompact-patch:ui-session-row]
  if (m.readSegments || m.readArchived) bits.push('前情 ' + (m.readSegments || 0) + ' 段' + (m.readArchived ? ' / 归档 ' + m.readArchived : ''));`);

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────
const applied = results.filter((r) => r.status === 'applied');
const skipped = results.filter((r) => r.status === 'skipped');
const dry = results.filter((r) => r.status === 'dry');
console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: applied.map((r) => r.id),
  skipped: skipped.map((r) => r.id),
  dryRun: dry.map((r) => r.id),
  total: results.length
}, null, 2));
