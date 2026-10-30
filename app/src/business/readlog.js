// 已读信息分段摘要（B22）—— 把「会话全量」的已读窗口切成「近期细读 + 远期摘要」。
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
    fs.appendFileSync(archiveFile(chatKey, now), lines.join('\n') + '\n', 'utf8');
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
    for (const line of text.split('\n')) {
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
      for (const line of text.split('\n')) {
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
  return lines.join('\n');
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
    const text = String(m && m.text || '').replace(/\s+/g, ' ').slice(0, 600);
    return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] ' + who + '：' + text;
  }).join('\n');
}
