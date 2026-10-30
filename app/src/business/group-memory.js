// 群记 —— 群级记忆（梗 / 群规 / 关系 / 长期项目 / 在聊什么）。
// [qqagent-memory-patch:group-memory]
//
// 载体：data/memory/<chat>/_group.json
// 形态：{ chatKey, entries: [{ id, kind, content, createdAt, updatedAt }], updatedAt }
// kind：lore（梗/黑话）· rule（群规/约定/边界）· relation（关系/角色）
//       · project（长期项目/关注点）· topic（在聊什么/未了事）
//
// 与成员档（<QQ>.json）同址，下划线开头避开成员文件语义 —— memory.js 的成员扫描按
// raw.userId 判定，本文件没有 userId 字段，不会进成员表（与 _session.json 同款）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

export const GROUP_KINDS = ['lore', 'rule', 'relation', 'project', 'topic'];
export const GROUP_KIND_LABEL = {
  lore: '梗',
  rule: '群规',
  relation: '关系',
  project: '项目',
  topic: '在聊'
};
// 渲染顺序：群规 / 关系 / 梗 / 项目（稳定）—— topic 另起一段（易变）
const RENDER_ORDER = ['rule', 'relation', 'lore', 'project'];
// ── 记忆不节流（2026-10-16 Rushiera 定）── [qqagent-memory-patch:no-throttle]
// 写入不设上限、不淘汰：现行池超软上限的条目**转入归档**（archive/，append-only），
// 信息不丢。这里的上限只管"现行池多大"，不管"能记多少"。
const MAX_ENTRIES = 200;          // 现行池软上限（原 40）——超出转归档
const MAX_TOPICS = 24;            // 话题条目上限（原 12）
const MAX_CONTENT = 400;          // 单条上限（原 200）
const ARCHIVE_DIR = 'archive';    // 归档子目录（与活跃档同址）

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 群记文件路径（与 _session.json 同址）。 */
export function groupMemoryFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_group.json');
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

function normalizeEntry(raw, index) {
  const kind = String((raw && raw.kind) || '').trim();
  const content = String((raw && raw.content) || '').trim().slice(0, MAX_CONTENT);
  if (!GROUP_KINDS.includes(kind) || !content) return null;
  return {
    id: String((raw && raw.id) || ('g' + index)),
    kind,
    content,
    createdAt: Math.max(0, Number((raw && raw.createdAt) || 0)),
    updatedAt: Math.max(0, Number((raw && raw.updatedAt) || 0))
  };
}

/** 读群记条目（文件不存在 / 坏档 = 空列表）。 */
export function listGroupEntries(chatKey) {
  const raw = readJson(groupMemoryFile(chatKey), null);
  const list = Array.isArray(raw && raw.entries) ? raw.entries : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = normalizeEntry(list[i], i);
    if (e) out.push(e);
  }
  return out;
}

function saveEntries(chatKey, entries) {
  const now = Date.now();
  const list = [];
  for (let i = 0; i < entries.length; i++) {
    const e = normalizeEntry(entries[i], i);
    if (!e) continue;
    if (!e.createdAt) e.createdAt = now;
    if (!e.updatedAt) e.updatedAt = now;
    list.push(e);
  }
  // 溢出**转归档**（原：超限淘汰最旧 —— 那是丢信息）——[qqagent-memory-patch:no-throttle]
  const topics = list.filter((e) => e.kind === 'topic');
  const rest = list.filter((e) => e.kind !== 'topic');
  const overflow = rest.slice(0, Math.max(0, rest.length - MAX_ENTRIES))
    .concat(topics.slice(0, Math.max(0, topics.length - MAX_TOPICS)));
  if (overflow.length) archiveGroupEntries(chatKey, overflow, 'overflow');
  const finalList = rest.slice(-MAX_ENTRIES).concat(topics.slice(-MAX_TOPICS));
  writeJson(groupMemoryFile(chatKey), {
    chatKey: String(chatKey),
    entries: finalList,
    updatedAt: now
  });
  rebuildGroupIndex(chatKey);
  return finalList;
}

// ── 归档（append-only，只增不改）────────────────────────────────────────────
// [qqagent-memory-patch:no-throttle-archive]
// 归档是"留底"不是"垃圾桶"：条目从现行池移出后仍可被 检索记忆（memory_search）搜到。
function archiveDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), ARCHIVE_DIR);
}

/** 归档分卷：按天一个 JSONL 文件（只追加，不改写）。 */
function archiveFile(chatKey, at) {
  const d = new Date(Number(at) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return path.join(archiveDir(chatKey), 'group-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.jsonl');
}

/** 把条目追加进归档（reason 记归档缘由）。返回写入条数。 */
export function archiveGroupEntries(chatKey, entries, reason = 'manual') {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.content);
  if (!list.length) return 0;
  try {
    fs.mkdirSync(archiveDir(chatKey), { recursive: true });
    const now = Date.now();
    const lines = list.map((e) => JSON.stringify({
      id: String(e.id || ''),
      kind: String(e.kind || ''),
      content: String(e.content || '').slice(0, MAX_CONTENT),
      createdAt: Number(e.createdAt) || 0,
      updatedAt: Number(e.updatedAt) || 0,
      archivedAt: now,
      reason: String(reason || 'manual')
    }));
    fs.appendFileSync(archiveFile(chatKey, now), lines.join('\n') + '\n', 'utf8');
    rebuildGroupIndex(chatKey);
    return list.length;
  } catch (error) {
    console.warn('[group-memory] 归档失败（条目仍留在现行池）:', error?.message ?? error);
    return 0;
  }
}

/** 读归档条目（keyword / since 过滤；新的在前）。 */
export function listArchivedGroupEntries(chatKey, { since = 0, keyword = '', limit = 200 } = {}) {
  const dir = archiveDir(chatKey);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('group-') && f.endsWith('.jsonl')).sort(); } catch { return []; }
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
      if (!e || !e.content) continue;
      if (since && (Number(e.createdAt) || 0) < since) continue;
      if (kw && !String(e.content).toLowerCase().includes(kw)) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 归档统计（索引 / 记忆页用；不递归调 groupMemoryStats）。 */
export function groupArchiveStats(chatKey) {
  const dir = archiveDir(chatKey);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('group-') && f.endsWith('.jsonl')).sort(); } catch { return { files: 0, count: 0, latestAt: 0 }; }
  let count = 0;
  let latestAt = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      count += 1;
      try { latestAt = Math.max(latestAt, Number(JSON.parse(t).archivedAt) || 0); } catch { /* 坏行只计数 */ }
    }
  }
  return { files: files.length, count, latestAt };
}

/** 索引：现行池 + 归档的清单与计数（_index.json；每次写入后重建）。 */
export function rebuildGroupIndex(chatKey) {
  try {
    const entries = listGroupEntries(chatKey);
    const archive = groupArchiveStats(chatKey);
    const byKind = {};
    for (const k of GROUP_KINDS) byKind[k] = entries.filter((e) => e.kind === k).length;
    writeJson(path.join(MEMORY_DIR, chatDirName(chatKey), '_index.json'), {
      chatKey: String(chatKey),
      updatedAt: Date.now(),
      group: {
        total: entries.length,
        byKind,
        latestAt: entries.reduce((n, e) => Math.max(n, Number(e.updatedAt) || 0), 0)
      },
      archive: { files: archive.files, count: archive.count },
      kinds: GROUP_KINDS
    });
  } catch (error) {
    console.warn('[group-memory] 索引写入失败:', error?.message ?? error);
  }
}

/** 追加一条群记（同 kind 同内容不重复写）。 */
export function appendGroupEntry(chatKey, kind, content) {
  const k = String(kind || '').trim();
  const c = String(content || '').trim().slice(0, MAX_CONTENT);
  if (!GROUP_KINDS.includes(k) || !c) return null;
  const entries = listGroupEntries(chatKey);
  const hit = entries.find((e) => e.kind === k && e.content === c);
  if (hit) return hit;
  const now = Date.now();
  const entry = {
    id: 'g' + now.toString(36) + '-' + entries.length,
    kind: k,
    content: c,
    createdAt: now,
    updatedAt: now
  };
  saveEntries(chatKey, entries.concat([entry]));
  return entry;
}

/** 删群记条目：按 id 优先，其次 kind+content / content / kind。返回删掉的条数。 */
export function removeGroupEntry(chatKey, { id = '', kind = '', content = '' } = {}) {
  const entries = listGroupEntries(chatKey);
  const keep = entries.filter((e) => {
    if (id) return String(e.id) !== String(id);
    if (content) return !(e.content === String(content) && (!kind || e.kind === kind));
    if (kind) return e.kind !== kind;
    return true;
  });
  if (keep.length === entries.length) return 0;
  saveEntries(chatKey, keep);
  return entries.length - keep.length;
}

/** 整理轮用：整体替换（条目形态 [{kind, content}]）。 */
export function replaceGroupEntries(chatKey, items) {
  const list = (Array.isArray(items) ? items : [])
    .map((x) => ({ kind: String((x && x.kind) || '').trim(), content: String((x && x.content) || '').trim() }))
    .filter((x) => GROUP_KINDS.includes(x.kind) && x.content);
  return saveEntries(chatKey, list);
}

/** 收工轮用：话题词 → topic 条目（覆盖上一版 topic，保留其它 kind）。返回写入条数。 */
export function setGroupTopics(chatKey, words) {
  // 写入不截断（记忆不节流）——超出的由 saveEntries 转归档，不静默丢。
  // [qqagent-memory-patch:no-throttle-topics-write]
  const list = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean);
  if (!list.length) return 0;
  const entries = listGroupEntries(chatKey).filter((e) => e.kind !== 'topic');
  const now = Date.now();
  const topics = list.map((w, i) => ({
    id: 'gt' + now.toString(36) + '-' + i,
    kind: 'topic',
    content: w,
    createdAt: now,
    updatedAt: now
  }));
  saveEntries(chatKey, entries.concat(topics));
  return topics.length;
}

// ── 话题词（R3-5 · engage#1：原 topic-words.js 并入本模块）──────────────────
// [qqagent-engage-patch:topic-words-merged]
// 为什么要并：话题词本来就是「本群在聊什么」的一类知识，与群记 topic 同源；
// 两条写入面（_topics.json 与 _group.json 的 topic 条目）并存会让「本轮话题」有两个真相。
// 现行池仍是 _topics.json（形态稳定、不迁移存量），但解析与渲染实现只此一份。
const MAX_WORDS = 12;

/** 话题词文件路径（与 _session.json 同址，下划线开头避开成员文件语义）。 */
export function topicWordsFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_topics.json');
}

/**
 * 从收工轮正文里解析话题词行。
 *
 * 约定形态：「话题词：词1、词2、词3」（也容忍 逗号 / 空格 / 顿号 混用）。
 * 解析不到就返回空数组 —— 本轮不更新词表，保留上一版（宁可不换，不可清空）。
 *
 * @param {string} text 收工轮正文
 * @returns {string[]} 话题词
 */
export function extractTopicWords(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = /话题词\s*[:：]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const words = m[1]
      .split(/[、,，\s\/]+/)
      .map((w) => w.replace(/^[\-*\d.、)]+/, '').trim())
      .filter((w) => w && w.length <= 12 && !/^话题词/.test(w));
    const seen = new Set();
    const out = [];
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= MAX_WORDS) break;
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * 写话题词（收工轮产出）。空数组不写 —— 保留上一版。
 *
 * @param {string} chatKey 会话键
 * @param {string[]} words 话题词
 * @param {object} [meta] 附加（rollovers）
 * @returns {object|null} 落盘内容（空输入 null）
 */
export function writeTopicWords(chatKey, words, meta = {}) {
  const list = (Array.isArray(words) ? words : []).map((w) => String(w).trim()).filter(Boolean).slice(0, MAX_WORDS);
  if (!list.length) return null;
  const payload = {
    chatKey: String(chatKey),
    words: list,
    updatedAt: Date.now(),
    rollovers: Math.max(0, Number(meta.rollovers) || 0)
  };
  writeJson(topicWordsFile(chatKey), payload);
  return payload;
}

/**
 * 读话题词；没有就返回 null。
 *
 * @param {string} chatKey 会话键
 * @returns {object|null} `{ words, updatedAt, rollovers }`
 */
export function readTopicWords(chatKey) {
  const raw = readJson(topicWordsFile(chatKey), null);
  const words = Array.isArray(raw?.words) ? raw.words.map((w) => String(w)).filter(Boolean) : [];
  if (!words.length) return null;
  return { words, updatedAt: Number(raw?.updatedAt) || 0, rollovers: Number(raw?.rollovers) || 0 };
}

/**
 * 渲染成【记忆】段的一块（会话级要点之后、群友印象之前）。
 *
 * @param {string} chatKey 会话键
 * @returns {string} 提示词片段（无话题词时空串）
 */
export function formatTopicWordsForPrompt(chatKey) {
  const t = readTopicWords(chatKey);
  if (!t) return '';
  return '【本群常聊的话题词】' + t.words.join('、') + '（参考用：跟这些沾边的消息更值得接，别硬往上靠）';
}

/** 渲染成【记忆】段的一块（会话要点之后、群友印象之前）。 */
export function formatGroupForPrompt(chatKey) {
  const entries = listGroupEntries(chatKey);
  if (!entries.length) return '';
  // 注入预算（写入不节流，注入有预算）：每类取最近 N 条；被截下的条数在段尾明示，
  // 要看全的走 memory_query / memory_search。[qqagent-memory-patch:no-throttle-inject]
  const INJECT_MAX_PER_KIND = 12;
  const INJECT_MAX_TOPICS = 12;
  const out = [];
  const main = [];
  let withheld = 0;
  for (const kind of RENDER_ORDER) {
    const bucket = entries.filter((e) => e.kind === kind);
    if (bucket.length > INJECT_MAX_PER_KIND) withheld += bucket.length - INJECT_MAX_PER_KIND;
    main.push(...bucket.slice(-INJECT_MAX_PER_KIND));
  }
  for (const e of entries) {
    if (RENDER_ORDER.includes(e.kind) || e.kind === 'topic') continue;
    main.push(e);   // 未知 kind（未来扩展）兜底：不静默丢
  }
  if (main.length) {
    out.push('【本群】');
    for (const kind of RENDER_ORDER) {
      for (const e of main) {
        if (e.kind !== kind) continue;
        out.push('- ' + (GROUP_KIND_LABEL[kind] || kind) + '：' + e.content);
      }
    }
    // 未知 kind（未来扩展）兜底：不静默丢 —— [qqagent-memory-patch:no-throttle-render-note]
    for (const e of main) {
      if (RENDER_ORDER.includes(e.kind)) continue;
      out.push('- ' + e.kind + '：' + e.content);
    }
  }
  const topics = entries.filter((e) => e.kind === 'topic');
  const topicKeep = topics.slice(-INJECT_MAX_TOPICS);
  if (topicKeep.length) {
    out.push('【本群在聊】' + topicKeep.map((e) => e.content).join('；'));
  }
  // 段尾明示「还有多少没带进来」——记忆不节流，但注入有预算，得让模型知道怎么取。
  const archive = groupArchiveStats(chatKey);
  const tail = [];
  if (withheld) tail.push(withheld + ' 条同类条目未展开');
  if (archive.count) tail.push(archive.count + ' 条已归档');
  if (tail.length) out.push('（' + tail.join('、') + '——要看得用 查询记忆 memory_query / 检索记忆 memory_search）');
  return out.join('\n');
}

/** 统计（记忆页 / 整理门槛 / 索引 用）。 */
export function groupMemoryStats(chatKey) {
  const entries = listGroupEntries(chatKey);
  const archive = groupArchiveStats(chatKey);
  const byKind = {};
  for (const k of GROUP_KINDS) byKind[k] = entries.filter((e) => e.kind === k).length;
  return {
    count: entries.length,
    topics: entries.filter((e) => e.kind === 'topic').length,
    byKind,
    archived: archive.count,
    archiveFiles: archive.files,
    updatedAt: entries.reduce((n, e) => Math.max(n, Number(e.updatedAt) || 0), 0)
  };
}
