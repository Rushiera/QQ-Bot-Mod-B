// patch-qqagent-memory.mjs — QQ Agent v0.4.0「记忆分类（群记）」幂等补丁
//
// 用法：node patch-qqagent-memory.mjs [--dry]
// 做什么：把 design-qqbotb-memory.md 的改动落进 _unpack 源码
//   （新增 src/group-memory.js + 工具面 / 提示词 / 收工轮 / 整理轮 / API / 记忆页）
// 语义：**源码改动的唯一落盘通道**——重装应用后重跑本脚本即复现（_unpack 可弃）
// 幂等：每个补丁点带唯一标记 [qqagent-memory-patch:<id>]；已含标记 = 跳过，可反复运行
// 边界：不动安全边界 / 发送队列 / Electron 壳；不碰成员档（<QQ>.json）的读写语义
//       _topics.json 退役为「群记的 topic 条目」——解析器（topic-words.js）保留复用

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-memory-patch:' + id + ']';

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
  const file = path.join(APP, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
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
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/** 新增文件：已存在且非本补丁产物时拒绝覆盖（防误伤手写文件）。 */
function addFile(id, rel, content) {
  const file = path.join(APP, rel);
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
    throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel + '（先人工确认再删）');
  }
  if (!DRY) fs.writeFileSync(file, toEol(content, detectEol(path.join(APP, 'src', 'config.js'))), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新增 src/group-memory.js —— 群级记忆（群记）读写层
// ─────────────────────────────────────────────────────────────────────────────
const GROUP_MEMORY_JS = `// 群记 —— 群级记忆（梗 / 群规 / 关系 / 长期项目 / 在聊什么）。
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
const MAX_ENTRIES = 40;
const MAX_TOPICS = 12;
const MAX_CONTENT = 200;

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
  // 上限：topic 单独限流（最易变的一类），其余按总数封顶；超限淘汰最旧的
  const topics = list.filter((e) => e.kind === 'topic').slice(-MAX_TOPICS);
  const rest = list.filter((e) => e.kind !== 'topic').slice(-(MAX_ENTRIES - topics.length));
  const finalList = rest.concat(topics);
  writeJson(groupMemoryFile(chatKey), {
    chatKey: String(chatKey),
    entries: finalList,
    updatedAt: now
  });
  return finalList;
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
  const list = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean)
    .slice(0, MAX_TOPICS);
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

/** 渲染成【记忆】段的一块（会话要点之后、群友印象之前）。 */
export function formatGroupForPrompt(chatKey) {
  const entries = listGroupEntries(chatKey);
  if (!entries.length) return '';
  const out = [];
  const main = entries.filter((e) => e.kind !== 'topic');
  if (main.length) {
    out.push('【本群】');
    for (const kind of RENDER_ORDER) {
      for (const e of main) {
        if (e.kind !== kind) continue;
        out.push('- ' + (GROUP_KIND_LABEL[kind] || kind) + '：' + e.content);
      }
    }
    // 未知 kind（未来扩展）兜底：不静默丢
    for (const e of main) {
      if (RENDER_ORDER.includes(e.kind)) continue;
      out.push('- ' + e.kind + '：' + e.content);
    }
  }
  const topics = entries.filter((e) => e.kind === 'topic');
  if (topics.length) {
    out.push('【本群在聊】' + topics.map((e) => e.content).join('；'));
  }
  return out.join('\\n');
}

/** 统计（记忆页 / 整理门槛用）。 */
export function groupMemoryStats(chatKey) {
  const entries = listGroupEntries(chatKey);
  return {
    count: entries.length,
    topics: entries.filter((e) => e.kind === 'topic').length,
    updatedAt: entries.reduce((n, e) => Math.max(n, Number(e.updatedAt) || 0), 0)
  };
}
`;

addFile('group-memory', 'src/group-memory.js', GROUP_MEMORY_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/tools.js —— 记忆工具面（append / query / remove）
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', 'src/tools.js',
  `import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';`,
  `import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';
// 群记（群级记忆：梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-import]
import {
  GROUP_KINDS, GROUP_KIND_LABEL, appendGroupEntry, listGroupEntries, removeGroupEntry
} from './group-memory.js';`);

patch('tools-append', 'src/tools.js',
  `  registerTool({
    id: 'memory_append',
    name: '记录印象',
    description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '记忆分类（目前只支持 memberImpression = 群友印象）' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
        content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
      },
      required: ['category', 'userId', 'content']
    },
    async execute(ctx, args) {
      const userId = String(args.userId ?? '').trim();
      if (!/^\\d{1,15}$/.test(userId)) {
        return err(\`userId 必须是数字 QQ 号（收到：\${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。\`);
      }
      const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
        userId,
        target: String(args.target ?? '').trim()
      });
      return ok({ saved: true, entry });
    }
  });`,
  `  // [qqagent-memory-patch:tools-append]
  registerTool({
    id: 'memory_append',
    name: '记录记忆',
    description: '记一条长期记忆（下次运行会自动看到）。category=member：对某位群友的印象（必须给 userId）——他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题。category=group：本群的事（必须给 kind）——lore 群内梗/黑话；rule 群规/约定/边界；relation 群内关系/角色；project 长期项目/关注点；topic 最近在聊什么/没聊完的事。只记"下次还用得上"的稳定信息，临时情绪和一次性寒暄不要记。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=对某位群友的印象（需 userId）；group=本群的事（需 kind）' },
        kind: { type: 'string', enum: ['lore', 'rule', 'relation', 'project', 'topic'], description: 'category=group 时必填：lore 梗/黑话 · rule 群规/约定 · relation 关系/角色 · project 长期项目 · topic 在聊什么' },
        userId: { type: ['integer', 'string'], description: 'category=member 时必填：对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字（备注名/群名片/昵称），仅 category=member 用' },
        content: { type: 'string', description: '内容（≤120字，稳定、可跨多次聊天使用）' }
      },
      required: ['category', 'content']
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      const content = String(args.content ?? '').trim();
      // group：本群的事（梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-append-group]
      if (category === 'group') {
        const kind = String(args.kind ?? '').trim();
        if (!GROUP_KINDS.includes(kind)) {
          return err('category=group 时 kind 必填，取值：' + GROUP_KINDS.join(' / ') + '（' + GROUP_KINDS.map((k) => k + '=' + GROUP_KIND_LABEL[k]).join('，') + '）');
        }
        if (!content) return err('content 不能为空');
        const entry = appendGroupEntry(ctx.chatKey, kind, content);
        if (!entry) return err('群记写入失败：内容为空或分类非法');
        return ok({ saved: true, category: 'group', entry });
      }
      // member：对某位群友的印象（默认；兼容旧枚举值 memberImpression）
      const userId = String(args.userId ?? '').trim();
      if (!/^\\d{1,15}$/.test(userId)) {
        return err('userId 必须是数字 QQ 号（收到：' + JSON.stringify(args.userId) + '）。先用 get_active_members 查准确 QQ 号再记。');
      }
      if (!content) return err('content 不能为空');
      const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', content, {
        userId,
        target: String(args.target ?? '').trim()
      });
      return ok({ saved: true, entry });
    }
  });`);

patch('tools-query', 'src/tools.js',
  `  registerTool({
    id: 'memory_query',
    name: '查询印象',
    description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
      }
    },
    async execute(ctx, args) {
      const mem = ctx.memory.query(ctx.chatKey);
      const userId = String(args.userId ?? '').trim();
      const list = userId
        ? mem.memberImpression.filter((e) => String(e.userId) === userId)
        : mem.memberImpression;
      return ok({ memberImpression: list });
    }
  });`,
  `  // [qqagent-memory-patch:tools-query]
  registerTool({
    id: 'memory_query',
    name: '查询记忆',
    description: '查看当前会话里的长期记忆。category=member 看群友印象（不传 userId 返回全部）；category=group 看群记（本群的梗/群规/关系/项目/在聊什么）。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=群友印象；group=群记' },
        userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象（category=member）' }
      }
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      if (category === 'group') {
        // [qqagent-memory-patch:tools-query-group]
        return ok({ group: listGroupEntries(ctx.chatKey) });
      }
      const mem = ctx.memory.query(ctx.chatKey);
      const userId = String(args.userId ?? '').trim();
      const list = userId
        ? mem.memberImpression.filter((e) => String(e.userId) === userId)
        : mem.memberImpression;
      return ok({ memberImpression: list });
    }
  });`);

patch('tools-remove', 'src/tools.js',
  `  registerTool({
    id: 'memory_remove',
    name: '删除印象',
    description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '记忆分类（目前只支持 memberImpression = 群友印象）' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
        target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
        content: { type: 'string', description: '可选：只删这条内容' }
      },
      required: ['category']
    },
    async execute(ctx, args) {
      const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
        userId: String(args.userId ?? '').trim(),
        target: String(args.target ?? '').trim(),
        content: String(args.content ?? '').trim()
      });
      return ok({ removed });
    }
  });`,
  `  // [qqagent-memory-patch:tools-remove]
  registerTool({
    id: 'memory_remove',
    name: '删除记忆',
    description: '删除一条过时/不再准确的记忆。category=member：按 userId（QQ 号，优先）或 target（名字）删，两者都不传则删该群友全部印象。category=group：按 id 或 kind+content 删群记条目。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=群友印象；group=群记' },
        id: { type: 'string', description: 'category=group 时可选：群记条目 id（memory_query 里能看到）' },
        kind: { type: 'string', enum: ['lore', 'rule', 'relation', 'project', 'topic'], description: 'category=group 时可选：按分类删' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
        target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
        content: { type: 'string', description: '可选：只删这条内容' }
      },
      required: ['category']
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      if (category === 'group') {
        // [qqagent-memory-patch:tools-remove-group]
        const removed = removeGroupEntry(ctx.chatKey, {
          id: String(args.id ?? '').trim(),
          kind: String(args.kind ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
      const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
        userId: String(args.userId ?? '').trim(),
        target: String(args.target ?? '').trim(),
        content: String(args.content ?? '').trim()
      });
      return ok({ removed });
    }
  });`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/prompt.js —— 【记忆】段接入群记（替代话题词块）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-import', 'src/prompt.js',
  `// 本群话题词（收工轮自产）——【记忆】段第二块（[qqagent-engage-patch:prompt-import]）
import { formatTopicWordsForPrompt } from './topic-words.js';`,
  `// 群记（【本群】+【本群在聊】）——【记忆】段第二块（[qqagent-memory-patch:prompt-import]）
import { formatGroupForPrompt } from './group-memory.js';`);

patch('prompt-group', 'src/prompt.js',
  `  // 话题词排在会话要点之后、群友印象之前 —— 会话内稳定，不打断【记忆】段的缓存前缀角色。
  // [qqagent-engage-patch:prompt-topic-words]
  const topicWordsText = formatTopicWordsForPrompt(ctx.chatKey);
  const memText = [sessionMemText, topicWordsText, memTextRaw].filter(Boolean).join('\\n');`,
  `  // 群记（【本群】+【本群在聊】）排在会话要点之后、群友印象之前 —— 会话内稳定，
  // 不打断【记忆】段的缓存前缀角色。[qqagent-memory-patch:prompt-group]
  const groupMemText = formatGroupForPrompt(ctx.chatKey);
  const memText = [sessionMemText, groupMemText, memTextRaw].filter(Boolean).join('\\n');`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/orchestrator.js —— 收工轮话题入群记 + 整理轮产出群记
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', 'src/orchestrator.js',
  `// 本群话题词（收工轮自产，提示词参考）——[qqagent-engage-patch:orchestrator-import]
import { extractTopicWords, writeTopicWords } from './topic-words.js';`,
  `// 本群话题词解析器（收工轮自产）——[qqagent-engage-patch:orchestrator-import]
import { extractTopicWords } from './topic-words.js';
// 群记（群级记忆：梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:orchestrator-import]
import {
  GROUP_KINDS, listGroupEntries, replaceGroupEntries, setGroupTopics
} from './group-memory.js';`);

patch('orchestrator-rollover-topics', 'src/orchestrator.js',
  `      // 话题词（收工轮自产）—— 提示词参考，不做触发门。[qqagent-engage-patch:orchestrator-rollover-write]
      const topicWords = extractTopicWords(summary);
      if (topicWords.length) writeTopicWords(chatKey, topicWords, { rollovers: state.rollovers });`,
  `      // 话题词（收工轮自产）—— 落进群记的 topic 条目；提示词参考、不做触发门。
      // [qqagent-memory-patch:orchestrator-rollover-topics]
      const topicWords = extractTopicWords(summary);
      if (topicWords.length) setGroupTopics(chatKey, topicWords);`);

patch('orchestrator-group-pass', 'src/orchestrator.js',
  `    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);`,
  `    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // 群记（群级记忆）先跑：人档回答"这个人是谁"，群记回答"这个群是什么群、最近在聊什么"。
    // 门槛 / 冷却在 #consolidateGroupMemory 内部；失败不影响人档结果。
    // [qqagent-memory-patch:orchestrator-group-pass]
    let groupNote = '';
    try {
      groupNote = await this.#consolidateGroupMemory(chatKey, { force, stats });
    } catch (error) {
      console.warn('[memory] 群记整理失败:', error?.message ?? error);
    }`);

patch('orchestrator-early-note', 'src/orchestrator.js',
  "      return {\n        ok: true,\n        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,",
  "      return {\n        // [qqagent-memory-patch:orchestrator-early-note]\n        ok: true,\n        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}${groupNote ? '；' + groupNote : ''}`,");

patch('orchestrator-return', 'src/orchestrator.js',
  `    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };`,
  `    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return {
      // [qqagent-memory-patch:orchestrator-return]
      ok: true,
      note: groupNote ? note + '；' + groupNote : note,
      changed, results, skipped, failed, groupNote
    };`);

patch('orchestrator-group-methods', 'src/orchestrator.js',
  `  /** 整理模式：合并/删减已有印象。 */`,
  `  /**
   * 整理群记 —— 群级记忆（梗 / 群规 / 关系 / 项目 / 在聊什么）。
   * [qqagent-memory-patch:orchestrator-group-methods]
   * [qqagent-memory-patch:orchestrator-group-consolidate]
   *
   * 与人档分开：人档回答"这个人是谁"，群记回答"这个群是什么群、最近在聊什么"。
   * 门槛：条目没超 maxGroupEntries 且已有内容时不折腾（群记变化慢，不值得每轮重写）；
   * 零条目时跑一次（首次建档）。force=true 无视门槛（手动按钮）。
   * 结果无法解析 → 保留原条目（宁可不换，不可清空）。
   * @returns {Promise<string>} 人话小结（无变化时返回空串）
   */
  async #consolidateGroupMemory(chatKey, { force = false } = {}) {
    const cfg = getConfig();
    const existing = listGroupEntries(chatKey);
    const maxKeep = Math.max(4, Number(cfg.memory?.maxGroupEntries) || 12);
    if (!force && existing.length && existing.length <= maxKeep) return '';
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.isPoke)
      .slice(-300)
      .map((m) => (m.self ? '我' : (m.senderName || m.senderId || '某人')) + '：' + String(m.text || '').slice(0, 120))
      .filter((line) => line.length > 2);
    if (!sample.length && !existing.length) return '';
    const { system, user } = this.#buildGroupMemoryPrompt({ existing, sample, maxKeep });
    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed || !Array.isArray(parsed.entries)) {
      console.warn('[memory] 群记整理 ' + chatKey + ' 结果无法解析，保留原条目');
      return '';
    }
    const items = parsed.entries
      .map((e) => ({ kind: String((e && e.kind) || '').trim(), content: String((e && e.content) || '').trim() }))
      .filter((e) => GROUP_KINDS.includes(e.kind) && e.content)
      .slice(0, maxKeep);
    const before = existing.map((e) => e.kind + ':' + e.content);
    const after = items.map((e) => e.kind + ':' + e.content);
    const changed = before.length !== after.length || after.some((c, i) => c !== before[i]);
    if (!changed) return '';
    replaceGroupEntries(chatKey, items);
    return '群记 ' + existing.length + ' 条 → ' + items.length + ' 条';
  }

  /** 群记整理提示词（合并 / 改写 / 删减 + 从聊天记录提炼，绝不发明事实）。 */
  #buildGroupMemoryPrompt({ existing, sample, maxKeep }) {
    const lines = [];
    if (existing.length) {
      lines.push('现有群记：');
      for (const e of existing) lines.push('- [' + e.kind + '] ' + e.content);
      lines.push('');
    }
    lines.push('最近的群聊记录：');
    for (const line of (sample.length ? sample : ['（没有抓到聊天记录）'])) lines.push(line);
    return {
      system: '你是聊天机器人的群记忆模块，负责整理"这个群"的长期事实与近期话题。只做合并、改写与删减，并从聊天记录里提炼稳定信息，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"entries":[{"kind":"…","content":"…"}]}',
      user: [
        '请整理这个群的群记。kind 只能取以下五种：',
        '- lore：群内梗 / 黑话 / 惯用语',
        '- rule：群规 / 约定 / 边界',
        '- relation：群内关系 / 角色（谁是主理人、谁是另一只 bot 等）',
        '- project：长期项目 / 长期关注点',
        '- topic：最近在聊什么 / 没聊完的事（会过期，只留真正还在进行中的）',
        '要求：',
        '1. 最多 ' + maxKeep + ' 条，每条不超过 120 字；同类合并，宁少勿错。',
        '2. 只写"下次进这个群还用得上"的信息；一次性寒暄、临时情绪不要写。',
        '3. 过时、矛盾、已经翻篇的条目删掉；信息不足就少写。',
        '4. 保留原有正确条目（可以改写得更准），不要因为换了措辞就丢信息。',
        '',
        ...lines
      ].join('\\n')
    };
  }

  /** 整理模式：合并/删减已有印象。 */`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/routes.js —— 记忆 API（列表摘要 / 详情 / 群记增删改）
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-import', 'src/routes.js',
  `import { detectDialect as detectThinkingDialect } from './thinking.js';`,
  `import { detectDialect as detectThinkingDialect } from './thinking.js';
// 群记（群级记忆）——[qqagent-memory-patch:routes-import]
import { listGroupEntries, appendGroupEntry, replaceGroupEntries, removeGroupEntry, groupMemoryStats } from './group-memory.js';`);

patch('routes-list', 'src/routes.js',
  `        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });`,
  `        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          // 群记条数进列表摘要（[qqagent-memory-patch:routes-list]）
          const groupStats = groupMemoryStats(chatKey);
          return {
            chatKey, impressionCount, memberCount: members.length,
            groupCount: groupStats.count,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0), groupStats.updatedAt)
          };
        });`);

patch('routes-allow-group', 'src/routes.js',
  `        for (const gid of (getConfig().allow?.groups || [])) {
          const key = \`group:\${String(gid)}\`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }`,
  `        for (const gid of (getConfig().allow?.groups || [])) {
          const key = \`group:\${String(gid)}\`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, groupCount: 0, updatedAt: 0, consolidating: false });   // [qqagent-memory-patch:routes-allow-group]
        }`);

patch('routes-allow-private', 'src/routes.js',
  `        for (const uid of (getConfig().allow?.private || [])) {
          const key = \`private:\${String(uid)}\`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }`,
  `        for (const uid of (getConfig().allow?.private || [])) {
          const key = \`private:\${String(uid)}\`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, groupCount: 0, updatedAt: 0, consolidating: false });   // [qqagent-memory-patch:routes-allow-private]
        }`);

patch('routes-detail', 'src/routes.js',
  `        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });`,
  `        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey), group: listGroupEntries(chatKey) });   // [qqagent-memory-patch:routes-detail]`);

patch('routes-group', 'src/routes.js',
  `    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）`,
  `    {
      // ── 群记（群级记忆）——[qqagent-memory-patch:routes-group] ────────────
      // POST：追加一条（记忆页「＋ 添加群记」）
      method: 'POST', pattern: /^\\/api\\/memory-files\\/(group|private)_(\\d+)\\/group$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = \`\${match[1]}:\${match[2]}\`;
        try {
          const body = await bodyOf(req);
          const entry = appendGroupEntry(chatKey, String(body.kind ?? ''), String(body.content ?? ''));
          if (!entry) return json(res, 400, { ok: false, error: 'kind 非法或 content 为空' });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, entry });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // PUT：整体替换（批量编辑用）
      method: 'PUT', pattern: /^\\/api\\/memory-files\\/(group|private)_(\\d+)\\/group$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = \`\${match[1]}:\${match[2]}\`;
        try {
          const body = await bodyOf(req);
          const entries = replaceGroupEntries(chatKey, Array.isArray(body.entries) ? body.entries : []);
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, entries });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // DELETE：删一条（按 id）
      method: 'DELETE', pattern: /^\\/api\\/memory-files\\/(group|private)_(\\d+)\\/group\\/([\\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = \`\${match[1]}:\${match[2]}\`;
        const removed = removeGroupEntry(chatKey, { id: match[3] });
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：ui/app/05-memory-settings.js —— 记忆页群记卡片
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-list-sub', 'ui/app/05-memory-settings.js',
  `    // [qqagent-memory-patch:ui-list-sub]
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? \`\${f.memberCount} 位群友 · \${f.impressionCount} 条印象\`
        : '暂无群友印象');
    const delBtn = (f.memberCount || f.impressionCount)`,
  `    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount || f.groupCount
        ? \`\${f.memberCount} 位群友 · \${f.impressionCount} 条印象 · 群记 \${f.groupCount || 0} 条\`
        : '暂无群友印象');
    const delBtn = (f.memberCount || f.impressionCount || f.groupCount)`);

patch('ui-group-data', 'ui/app/05-memory-settings.js',
  `    const members = Array.isArray(mem.members) ? mem.members : [];`,
  `    const members = Array.isArray(mem.members) ? mem.members : [];
    // 群记（群级记忆）——[qqagent-memory-patch:ui-group-data]
    const groupEntries = Array.isArray(mem.group) ? mem.group : [];
    const GROUP_KIND_LABEL = { lore: '梗/黑话', rule: '群规约定', relation: '关系角色', project: '长期项目', topic: '在聊什么' };
    const groupRows = groupEntries.map(function (e) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0">'
        + '<span class="muted" style="min-width:64px">' + esc(GROUP_KIND_LABEL[e.kind] || e.kind) + '</span>'
        + '<span style="flex:1">' + esc(e.content) + '</span>'
        + '<button class="btn btn-small btn-danger mem-del-group" data-id="' + esc(e.id) + '">删</button>'
        + '</div>';
    }).join('');
    const groupHtml = '<div style="margin:10px 0">'
      + '<div class="list-head muted"><span>群记（本群长期事实 · ' + groupEntries.length + ' 条）</span>'
      + '<button class="btn btn-small" id="mem-add-group-btn">＋ 添加群记</button></div>'
      + '<div id="mem-group-list">' + (groupRows || '<div class="muted" style="padding:6px 0">还没有群记（梗 / 群规 / 关系 / 项目 / 在聊什么）——点「整理本群记忆」让模型从聊天记录里提炼。</div>') + '</div>'
      + '</div>';`);

patch('ui-group-html', 'ui/app/05-memory-settings.js',
  `      \${membersHtml}
      \${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}`,
  `      \${groupHtml}
      \${membersHtml}
      \${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}`, 1, '      ${groupHtml}');

patch('ui-group-handlers', 'ui/app/05-memory-settings.js',
  `    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));`,
  `    // 群记：添加 / 删除（[qqagent-memory-patch:ui-group-handlers]）
    $$('.mem-del-group', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await api('/api/memory-files/' + encodeURIComponent(chatKey.replace(':', '_')) + '/group/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' });
          await loadMemoryDetail(chatKey);
        } catch (err) { alert('删除失败：' + err.message); }
      });
    });
    $('#mem-add-group-btn')?.addEventListener('click', async () => {
      const kind = await uiPrompt('分类：lore 梗/黑话 · rule 群规约定 · relation 关系角色 · project 长期项目 · topic 在聊什么', 'lore');
      if (!kind) return;
      const content = await uiPrompt('内容（≤200 字）', '');
      if (!content) return;
      try {
        await api('/api/memory-files/' + encodeURIComponent(chatKey.replace(':', '_')) + '/group', {
          method: 'POST',
          body: JSON.stringify({ kind: String(kind).trim(), content: String(content).trim() })
        });
        await loadMemoryDetail(chatKey);
        await loadMemoryView();
      } catch (err) { alert('添加失败：' + err.message); }
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：记忆沉淀增强（2026-10-11 · Rushiera 规格：「全上，但群记整理仍走 300k 收工轮」）
//   ① 收工轮指令：要点按 kind 写进群记 + 逐人更新印象（顺带修工具名——旧指令写「记录印象」，
//      工具已改名「记录记忆」）
//   ② 群记整理移出整理轮 → 只在收工轮（force）跑
//   ③ 人档放宽：发现门槛 20→5 条 · 每轮 3→6 人 · 每人上限 5→8 条 · 注入 3→5 条 ·
//      整理模式允许补充新特征（原「条数变多即放弃」）
//   ④ 工具描述去掉「临时不要记」的强抑制（宁可多记，整理轮负责去重）
// ─────────────────────────────────────────────────────────────────────────────

// ① 收工轮指令 —— 从「要点写文本」改成「要点写群记 + 逐人更新印象」
patch('ro-instruction', 'src/orchestrator.js',
`    '2. 把这段会话的要点写成简洁条目：聊了什么、结论或决定、对谁的印象有变化、有什么待续的事。中文短句，控制在 300 字内，直接写在回复文本里。',
    '3. 需要长期记住的群友印象，可以调用 记录印象（memory_append）。',
    '4. 写完就结束（调用 finish，reason 填"收工"）。',
    '5. 【话题词】最后补一行「话题词：词1、词2、…」—— 8~12 个短词，代表本群最近常聊的主题（人名 / 游戏 / 术语 / 梗 / 事件）。只列词，不解释。'`,
`    '2. 【先写群记】先调 查询记忆（memory_query，category=group）看本群已有群记，再把这段会话里值得长期保留的内容逐条写进群记（记录记忆 memory_append，category=group）：',
    '   · lore 本群新出现的梗 / 黑话 / 惯用语；rule 群规 / 约定 / 边界；relation 群内关系与角色（谁是谁、谁是另一只 bot）；project 长期项目 / 长期关注点；topic 最近在聊什么 / 没聊完的事。',
    '   · 本会话里出现过、群记里还没有的一律补上；已有但过时或说错的，先 删除记忆（memory_remove，category=group）删掉再重写。',
    '3. 【再写印象】逐个过一遍本会话里发过言的群友：身份 / 关系、说话风格、爱玩的梗、常聊话题、雷点有变化或有新增的，调 记录记忆（memory_append，category=member）写一条；没有变化的跳过。',
    '4. 把这段会话的要点写成简洁条目：聊了什么、结论或决定、有什么待续的事。中文短句，控制在 300 字内，直接写在回复文本里。',
    '5. 写完就结束（调用 finish，reason 填"收工"）。',
    '6. 【话题词】最后补一行「话题词：词1、词2、…」—— 8~12 个短词，代表本群最近常聊的主题（人名 / 游戏 / 术语 / 梗 / 事件）。只列词，不解释。'`,
1, '【先写群记】');

// ②a 群记整理移出整理轮（唯一触发点改为收工轮）
patch('group-pass-moved', 'src/orchestrator.js',
`    // 群记（群级记忆）先跑：人档回答"这个人是谁"，群记回答"这个群是什么群、最近在聊什么"。
    // 门槛 / 冷却在 #consolidateGroupMemory 内部；失败不影响人档结果。
    // [qqagent-memory-patch:orchestrator-group-pass]
    let groupNote = '';
    try {
      groupNote = await this.#consolidateGroupMemory(chatKey, { force, stats });
    } catch (error) {
      console.warn('[memory] 群记整理失败:', error?.message ?? error);
    }`,
`    // 群记整理只在两个点跑：① 收工轮（上下文 300k 轮转，见 #completeRollover）
    // ② 手动按钮（force=true）。后台自动整理不再碰群记——那会与收工轮的写入互相打架。
    // [qqagent-memory-patch:orchestrator-group-pass][qqagent-memory-patch:group-pass-moved]
    let groupNote = '';
    if (force) {
      try {
        groupNote = await this.#consolidateGroupMemory(chatKey, { force: true });
      } catch (error) {
        console.warn('[memory] 群记整理（手动）失败:', error?.message ?? error);
      }
    }`);

// ②b 收工轮收尾改 async（要 await 群记重整）
patch('rollover-async', 'src/orchestrator.js',
`  #completeRollover(chatKey, session) {`,
`  async #completeRollover(chatKey, session) {`,
1, 'async #completeRollover(chatKey, session) {');

// ②c 收工轮里跑群记重整（在归档之前——存档还在，样本才拿得到）
patch('rollover-group', 'src/orchestrator.js',
`      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);`,
`      // 群记重整（唯一触发点 = 收工轮）——模型本轮刚按 kind 写完群记，趁存档还在，
      // 用本会话全量样本合并 / 改写一遍。失败不影响归档（宁可不换，不可清空）。
      // [qqagent-memory-patch:rollover-group]
      try {
        const groupNote = await this.#consolidateGroupMemory(chatKey, { force: true });
        if (groupNote) console.log('[orchestrator] ' + chatKey + ' 收工轮群记重整：' + groupNote);
      } catch (error) {
        console.warn('[memory] 收工轮群记重整失败（保留原条目）:', error?.message ?? error);
      }
      const res = this.store.archiveAndClear(chatKey, { keepUnread: true, reason: 'rollover' });
      resetSession(chatKey);`);

// ②d 调用点补 await
patch('rollover-call-await', 'src/orchestrator.js',
`      if (!lastError && isRollover) this.#completeRollover(chatKey, session);`,
`      if (!lastError && isRollover) await this.#completeRollover(chatKey, session);`,
1, 'await this.#completeRollover(chatKey, session);');

// ②e 整理入口的「没有可整理的群友」早返回也要带 groupNote（原返回值漏了这个字段——
//     手动按钮重整了群记却报"没有可整理的群友"，看不到群记结果）
patch('early-note-groupnote', 'src/orchestrator.js',
`        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }`,
`        changed: 0,
        results: [],
        skipped,
        failed: [],
        // [qqagent-memory-patch:early-note-groupnote]
        groupNote
      };
    }`);

// ③a 「发现新人」门槛下调
patch('discover-thresholds', 'src/orchestrator.js',
`  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）`,
`  // [qqagent-memory-patch:discover-thresholds]
  // 2026-10-11：原 20 条 / 3 人 —— 实测 31 人的群只有 3 人有印象，门槛高到几乎不补人。
  static DISCOVER_MIN_MESSAGES = 5;       // 至少发过这么多条才值得分析（原 20）
  static DISCOVER_MAX_MEMBERS = 6;        // 单次最多发现几个人（原 3）`);

// ③b 整理模式允许补充新特征（原「条数变多即放弃」→ 印象只减不增）
patch('consolidate-grow', 'src/orchestrator.js',
`    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(\`[memory] 整理 \${chatKey}/\${mem.userId} 结果条数变多（\${existing.length}→\${raw.length}），疑似幻觉，放弃\`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));`,
`    // 整理模式允许补充新特征（原为"条数变多即放弃"——印象只减不增，永远长不出来）。
    // 防幻觉改成软上限：最多比原条数多 2 条，多出来的丢弃。[qqagent-memory-patch:consolidate-grow]
    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 8;
    const cap = isNew ? maxKeep : Math.min(maxKeep, existing.length + 2);

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, cap)
      .map((content) => content.slice(0, 120));`);

// ③c 整理提示词调用点：把 chatKey 传下去（要取该群友的聊天样本）
patch('consolidate-prompt-call', 'src/orchestrator.js',
`      : this.#buildConsolidatePrompt(mem);`,
`      : this.#buildConsolidatePrompt(chatKey, mem);`,
1, 'this.#buildConsolidatePrompt(chatKey, mem);');

// ③d 整理提示词：补聊天样本 + 允许补充稳定特征
patch('consolidate-prompt', 'src/orchestrator.js',
`  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [\`群友 QQ：\${mem.userId}\`, \`当前名字：\${mem.name}\`];
    for (const e of mem.impressions) lines.push(\`- \${e.content} (\${fmtTs(e.createdAt)})\`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        \`3. 最多保留 \${maxKeep} 条，每条不超过 120 字。\`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\\n')
    };
  }`,
`  /** 整理模式：合并/删减已有印象 + 从聊天记录补充稳定新特征。 */
  // [qqagent-memory-patch:consolidate-prompt]
  #buildConsolidatePrompt(chatKey, mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [\`群友 QQ：\${mem.userId}\`, \`当前名字：\${mem.name}\`];
    for (const e of mem.impressions) lines.push(\`- \${e.content} (\${fmtTs(e.createdAt)})\`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 8;
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === String(mem.userId || ''))
      .slice(-30)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你可以合并、改写、删除已有印象，也可以从给定的聊天记录里补充新的稳定特征；但绝不发明给定材料里没有的事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，以及他最近的发言，请整理并补全：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        '3. 从聊天记录里补上"以后跟这个人打交道用得上"的稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。一次性事件、临时话题、流水账不要写。',
        \`4. 最多保留 \${maxKeep} 条，每条不超过 120 字。\`,
        '原则：所有信息只能来自给定的印象与聊天记录，语义不变，宁全勿漏但不许脑补；实在没有可保留的才输出空数组。',
        '',
        ...lines,
        '',
        '他最近的发言：',
        ...(sample.length ? sample : ['（没有抓到该群友的发言）'])
      ].join('\\n')
    };
  }`);

// ③e 新建印象模式的条数上限同步（此时全文仅剩这一处 || 5）
patch('new-impression-maxkeep', 'src/orchestrator.js',
`  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;`,
`  #buildNewImpressionPrompt(chatKey, mem, stats) {
    // [qqagent-memory-patch:new-impression-maxkeep]
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 8;`);

// ③f 注入面放宽：每位群友最近 3 → 5 条
patch('prompt-member-limit', 'src/memory.js',
`      for (const e of m.impressions.slice(-3)) lines.push(\`- \${who}：\${e.content}\`);`,
`      // 注入最近 5 条（原 3 条——每人上限提到 8 后，3 条会让模型看不到全貌）
      // [qqagent-memory-patch:prompt-member-limit]
      for (const e of m.impressions.slice(-5)) lines.push(\`- \${who}：\${e.content}\`);`,
  1, '[qqagent-memory-patch:no-throttle-member-inject]');

// ③g 注入面放宽：无过滤时最多带 15 → 20 位群友
patch('prompt-member-count', 'src/memory.js',
`      : all.slice(0, 15);`,
`      : all.slice(0, 20);`,
1, 'INJECT_MAX_MEMBERS');

// ④ 工具描述：去掉「临时不要记」的强抑制
patch('append-desc', 'src/tools.js',
`只记"下次还用得上"的稳定信息，临时情绪和一次性寒暄不要记。',`,
`判断标准只有一条："下次进这个群还用得上吗"——用得上就记，宁可多记（重复和过时的条目由整理轮合并），别因为怕记错把该记的漏掉。',`,
1, '宁可多记');

// ⑤ 配置默认值：把新参数写进 schema 面（不写就只能靠代码兜底，前端看不到、改不了）
patch('memory-defaults', 'src/config.js',
`  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型`,
`  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    // 记忆沉淀增强（2026-10-11）——[qqagent-memory-patch:memory-defaults]
    maxImpressionsPerMember: 8,           // 每位群友最多保留的印象条数（原 5）
    maxGroupEntries: 20,                  // 群记条数上限（收工轮重整时用；原为代码兜底 12）
    discoverMinMessages: 5,               // 整理轮"发现新人"的最低发言条数（原 20）
    discoverMaxMembers: 6,                // 单次整理最多发现几位新人（原 3）
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型`,
1, '[qqagent-memory-patch:no-throttle-defaults]');
// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：记忆不节流 + 归档 + 索引 + 检索（2026-10-16 Rushiera 定）
//   规格原话：「记忆不需要节流，写的多不是坏事；但要能归档能索引」。
//   ① 写入不设上限、不淘汰 —— 现行池溢出的最旧条目转归档（archive/，append-only）
//   ② 索引 _index.json —— 现行池 + 归档的清单与计数
//   ③ 检索面 —— memory_search 跨现行 + 归档按关键词搜
//   ④ 注入面仍有预算（提示词是硬预算），被截下的条数在段尾明示
//   ⑤ 整理轮不再「只减不增」地砍条数；被改掉的旧条目留底进归档
//   ⑥ lean 模式补记忆引导（原引导只在 full 模式，模型看不到）
// ─────────────────────────────────────────────────────────────────────────────

// ⑥a group-memory.js 常量：上限改为「现行池软上限」，超出的转归档
patch('no-throttle-consts', 'src/group-memory.js',
`const RENDER_ORDER = ['rule', 'relation', 'lore', 'project'];
const MAX_ENTRIES = 40;
const MAX_TOPICS = 12;
const MAX_CONTENT = 200;`,
`const RENDER_ORDER = ['rule', 'relation', 'lore', 'project'];
// ── 记忆不节流（2026-10-16 Rushiera 定）── [qqagent-memory-patch:no-throttle]
// 写入不设上限、不淘汰：现行池超软上限的条目**转入归档**（archive/，append-only），
// 信息不丢。这里的上限只管"现行池多大"，不管"能记多少"。
const MAX_ENTRIES = 200;          // 现行池软上限（原 40）——超出转归档
const MAX_TOPICS = 24;            // 话题条目上限（原 12）
const MAX_CONTENT = 400;          // 单条上限（原 200）
const ARCHIVE_DIR = 'archive';    // 归档子目录（与活跃档同址）`);

// ⑥b saveEntries：溢出转归档（不再淘汰最旧）
patch('no-throttle-save', 'src/group-memory.js',
`  // 上限：topic 单独限流（最易变的一类），其余按总数封顶；超限淘汰最旧的
  const topics = list.filter((e) => e.kind === 'topic').slice(-MAX_TOPICS);
  const rest = list.filter((e) => e.kind !== 'topic').slice(-(MAX_ENTRIES - topics.length));
  const finalList = rest.concat(topics);
  writeJson(groupMemoryFile(chatKey), {
    chatKey: String(chatKey),
    entries: finalList,
    updatedAt: now
  });
  return finalList;
}`,
`  // 溢出**转归档**（原：超限淘汰最旧 —— 那是丢信息）——[qqagent-memory-patch:no-throttle]
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
}`);

// ⑥c 归档 / 索引 / 检索（插在 appendGroupEntry 之前）
patch('no-throttle-archive', 'src/group-memory.js',
`/** 追加一条群记（同 kind 同内容不重复写）。 */`,
`// ── 归档（append-only，只增不改）────────────────────────────────────────────
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
    fs.appendFileSync(archiveFile(chatKey, now), lines.join('\\n') + '\\n', 'utf8');
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
    for (const line of text.split('\\n')) {
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
    for (const line of text.split('\\n')) {
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

/** 追加一条群记（同 kind 同内容不重复写）。 */`);

// ⑥d groupMemoryStats：加归档计数
patch('no-throttle-stats', 'src/group-memory.js',
`/** 统计（记忆页 / 整理门槛用）。 */
export function groupMemoryStats(chatKey) {
  const entries = listGroupEntries(chatKey);
  return {
    count: entries.length,
    topics: entries.filter((e) => e.kind === 'topic').length,
    updatedAt: entries.reduce((n, e) => Math.max(n, Number(e.updatedAt) || 0), 0)
  };
}`,
`/** 统计（记忆页 / 整理门槛 / 索引 用）。 */
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
}`);

// ⑥e 注入预算：每类取最近 N 条，被截下的条数与归档量在段尾明示
patch('no-throttle-inject', 'src/group-memory.js',
`/** 渲染成【记忆】段的一块（会话要点之后、群友印象之前）。 */
export function formatGroupForPrompt(chatKey) {
  const entries = listGroupEntries(chatKey);
  if (!entries.length) return '';
  const out = [];
  const main = entries.filter((e) => e.kind !== 'topic');
  if (main.length) {`,
`/** 渲染成【记忆】段的一块（会话要点之后、群友印象之前）。 */
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
  if (main.length) {`);

patch('no-throttle-inject-tail', 'src/group-memory.js',
`  const topics = entries.filter((e) => e.kind === 'topic');
  if (topics.length) {
    out.push('【本群在聊】' + topics.map((e) => e.content).join('；'));
  }
  return out.join('\\n');
}`,
`  const topics = entries.filter((e) => e.kind === 'topic');
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
  return out.join('\\n');
}`);

// ⑥f 旧 kind 渲染兜底循环去重（main 已含未知 kind，原循环保持即可——此处只补注释标记）
patch('no-throttle-render-note', 'src/group-memory.js',
`    // 未知 kind（未来扩展）兜底：不静默丢
    for (const e of main) {
      if (RENDER_ORDER.includes(e.kind)) continue;
      out.push('- ' + e.kind + '：' + e.content);
    }`,
`    // 未知 kind（未来扩展）兜底：不静默丢 —— [qqagent-memory-patch:no-throttle-render-note]
    for (const e of main) {
      if (RENDER_ORDER.includes(e.kind)) continue;
      out.push('- ' + e.kind + '：' + e.content);
    }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6（续）：人档 / 工具面 / 提示词 / 配置 / 整理轮
// ─────────────────────────────────────────────────────────────────────────────

// ⑥g memory.js 注入预算常量
patch('no-throttle-inject-consts', 'src/memory.js',
`const MEMORY_DIR = path.join(DATA_DIR, 'memory');`,
`const MEMORY_DIR = path.join(DATA_DIR, 'memory');
// 注入预算（写入不节流，注入有预算）——[qqagent-memory-patch:no-throttle-inject-consts]
const INJECT_MAX_IMPRESSIONS = 8;    // 每位群友注入最近 N 条（原 5）
const INJECT_MAX_MEMBERS = 30;       // 无过滤时最多注入几位群友（原 20）
const MEMBER_ARCHIVE_DIR = 'archive';`);

// ⑥h memory.js formatForPrompt：注入面放宽 + 归档指针
patch('no-throttle-member-inject', 'src/memory.js',
`    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, 20);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      // 注入最近 5 条（原 3 条——每人上限提到 8 后，3 条会让模型看不到全貌）
      // [qqagent-memory-patch:prompt-member-limit]
      for (const e of m.impressions.slice(-5)) lines.push(\`- \${who}：\${e.content}\`);
    }
    return lines.join('\\n');
  }`,
`    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, INJECT_MAX_MEMBERS);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      // 注入最近 N 条（写入不节流，注入有预算）——[qqagent-memory-patch:no-throttle-member-inject]
      for (const e of m.impressions.slice(-INJECT_MAX_IMPRESSIONS)) lines.push(\`- \${who}：\${e.content}\`);
    }
    const arch = this.memberArchiveStats(chatKey);
    if (arch.count) {
      lines.push('（另有 ' + arch.count + ' 条旧印象已归档——要翻用 检索记忆 memory_search）');
    }
    return lines.join('\\n');
  }

  /** 人档归档统计（索引 / 记忆页用）。 */
  memberArchiveStats(chatKey) {
    try {
      const dir = path.join(MEMORY_DIR, chatDirName(chatKey), MEMBER_ARCHIVE_DIR);
      let count = 0;
      let latestAt = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('member-') || !f.endsWith('.jsonl')) continue;
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const line of text.split('\\n')) {
          const t = line.trim();
          if (!t) continue;
          count += 1;
          try { latestAt = Math.max(latestAt, Number(JSON.parse(t).archivedAt) || 0); } catch { /* 坏行只计数 */ }
        }
      }
      return { count, latestAt };
    } catch { return { count: 0, latestAt: 0 }; }
  }

  /** 人档归档检索（memory_search 用；keyword 空 = 最近若干条）。 */
  searchMemberArchive(chatKey, { keyword = '', limit = 20 } = {}) {
    const dir = path.join(MEMORY_DIR, chatDirName(chatKey), MEMBER_ARCHIVE_DIR);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith('member-') && f.endsWith('.jsonl')).sort(); } catch { return []; }
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
        if (!e || !e.content) continue;
        if (kw && !String(e.content).toLowerCase().includes(kw)) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => (Number(b.archivedAt) || 0) - (Number(a.archivedAt) || 0));
    return out.slice(0, Math.max(1, limit));
  }`);

// ⑥i memory.js 重整：不再砍到 15 条
patch('no-throttle-replace-cap', 'src/memory.js',
`    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {`,
`    // 不设总量上限（记忆不节流）——[qqagent-memory-patch:no-throttle-replace-cap]
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression : []) {`);

// ⑥j memory.js 重整：被改掉的旧条目留底进归档（append-only）
patch('no-throttle-consolidate-archive', 'src/memory.js',
`    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {`,
`    // 归档「被重整丢掉/改写的旧条目」（append-only，只增不改）——重整可以改写，
    // 旧版本要留得住、查得到。[qqagent-memory-patch:no-throttle-consolidate-archive]
    try {
      const kept = new Map();
      for (const g of groups.values()) {
        const k = String(g.userId || ('_n_' + g.name));
        if (!kept.has(k)) kept.set(k, new Set());
        for (const c of g.contents) kept.get(k).add(String(c));
      }
      const lines = [];
      const at = Date.now();
      for (const m of map.values()) {
        const k = String(m.userId || ('_n_' + m.name));
        const keepSet = kept.get(k) || new Set();
        for (const e of m.impressions || []) {
          const c = String(e.content || '');
          if (!c || keepSet.has(c)) continue;
          lines.push(JSON.stringify({
            userId: String(m.userId || ''),
            name: String(m.name || ''),
            content: c,
            createdAt: Number(e.createdAt) || 0,
            archivedAt: at,
            reason: 'consolidate'
          }));
        }
      }
      if (lines.length) {
        const adir = path.join(MEMORY_DIR, chatDirName(chatKey), MEMBER_ARCHIVE_DIR);
        fs.mkdirSync(adir, { recursive: true });
        const d = new Date(at);
        const p = (n) => String(n).padStart(2, '0');
        const file = path.join(adir, 'member-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.jsonl');
        fs.appendFileSync(file, lines.join('\\n') + '\\n', 'utf8');
      }
    } catch (error) {
      console.warn('[memory] 整理归档失败（不影响整理）:', error?.message ?? error);
    }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {`);

// ⑥k tools.js 导入：归档检索
patch('no-throttle-tools-import', 'src/tools.js',
`import {
  GROUP_KINDS, GROUP_KIND_LABEL, appendGroupEntry, listGroupEntries, removeGroupEntry
} from './group-memory.js';`,
`import {
  GROUP_KINDS, GROUP_KIND_LABEL, appendGroupEntry, listGroupEntries, removeGroupEntry,
  // 归档 + 检索（记忆不节流）——[qqagent-memory-patch:no-throttle-tools-import]
  listArchivedGroupEntries, groupArchiveStats
} from './group-memory.js';`);

// ⑥l tools.js 新增 memory_search（跨现行 + 归档检索）
patch('no-throttle-tools-search', 'src/tools.js',
`  // [qqagent-memory-patch:tools-remove]`,
`  // [qqagent-memory-patch:no-throttle-tools-search] 记忆检索（跨现行池 + 归档）
  registerTool({
    id: 'memory_search',
    name: '检索记忆',
    description: '按关键词检索本会话的长期记忆——现行池与归档一起搜。想确认"以前是不是聊过/记过某件事"、或【记忆】段里写了"另有 N 条已归档"时用它。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（大小写不敏感；留空 = 只列最近若干条）' },
        category: { type: 'string', enum: ['all', 'member', 'group'], description: '搜哪一轴（默认 all）' },
        includeArchived: { type: 'boolean', description: '是否连归档一起搜（默认 true）' },
        limit: { type: ['integer', 'string'], description: '每轴最多返回几条（默认 20）' }
      }
    },
    async execute(ctx, args) {
      const keyword = String(args.keyword ?? '').trim();
      const category = String(args.category ?? 'all').trim();
      const includeArchived = args.includeArchived !== false;
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const kw = keyword.toLowerCase();
      const out = {};
      if (category === 'all' || category === 'member') {
        const live = ctx.memory.query(ctx.chatKey).memberImpression
          .filter((e) => !kw || String(e.content).toLowerCase().includes(kw));
        out.memberImpression = live.slice(-limit).reverse();
        if (includeArchived) {
          const arch = ctx.memory.searchMemberArchive(ctx.chatKey, { keyword, limit });
          if (arch.length) out.memberImpressionArchived = arch;
        }
      }
      if (category === 'all' || category === 'group') {
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
      return ok(out);
    }
  });

  // [qqagent-memory-patch:tools-remove]`);

// ⑥m prompt.js 记忆引导改口径（写入不节流 + 归档检索）
patch('no-throttle-memory-rules', 'src/prompt.js',
`function memoryRules() {
  return [
    '【轻量记忆：偶尔用，别当笔记本】',
    '- memory_append 只用来记录"对某位群友的长期印象"（他的说话风格、爱玩的梗、雷点、身份关系等稳定信息）；这些内容下次运行会自动出现在【记忆】里。',
    '- 不要记临时话题、临时想法；只记以后跟这个人打交道还用得上的。印象过时/不再准确时用 memory_remove 删掉。',
    '- 每次扫一眼【记忆】，只有自然相关才主动提起；不要为了用记忆而硬聊旧话题。'
  ].join('\\n');
}`,
`function memoryRules() {
  // 口径（2026-10-16 Rushiera 定）：记忆不节流 —— 用得上就记，不怕多；
  // 超量的自动归档、可检索。原口径「偶尔用，别当笔记本」已退役。
  // [qqagent-memory-patch:no-throttle-memory-rules]
  return [
    '【记忆：用得上就记，不怕多】',
    '- 记录记忆（memory_append）：对某位群友的印象（category=member，需 userId）；或本群的事（category=group）——lore 梗/黑话 · rule 群规约定 · relation 关系角色 · project 长期项目 · topic 在聊什么。',
    '- 判断标准只有一条："下次进这个群还用得上吗"。用得上就记；重复和过时的条目由整理轮合并，写满的旧条目自动归档、不会丢。',
    '- 想翻旧事 / 想确认某人某事：调 查询记忆（memory_query）；【记忆】段里写了"另有 N 条已归档"时，用 检索记忆（memory_search）按关键词搜。',
    '- 每次扫一眼【记忆】，只有自然相关才主动提起；不要为了用记忆而硬聊旧话题。'
  ].join('\\n');
}`);

// ⑥n prompt.js lean 模式补记忆引导（原引导只在 full 模式，模型读不到）
patch('no-throttle-lean-memory', 'src/prompt.js',
`  const parts = promptMode === 'lean'
    ? [
        lead,
        '',
        subjectivity(),
        '',
        speakOrNot(cfg.participation),
        '',
        notAQueue(),
        '',
        humanRhythm()
      ]`,
`  // lean 模式（[qqagent-talkstyle-patch:prompt-lean]）+ 记忆引导（原 lean 段漏掉记忆，
  // 模型看不到"有记忆工具"这件事）——[qqagent-memory-patch:no-throttle-lean-memory]
  const parts = promptMode === 'lean'
    ? [
        lead,
        '',
        subjectivity(),
        '',
        speakOrNot(cfg.participation),
        '',
        notAQueue(),
        '',
        memoryRules(),
        '',
        humanRhythm()
      ]`);

// ⑥o config.js memory 默认值：条数放开 + 冷却缩短 + 发现放宽
patch('no-throttle-defaults', 'src/config.js',
`  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    // 记忆沉淀增强（2026-10-11）——[qqagent-memory-patch:memory-defaults]
    maxImpressionsPerMember: 8,           // 每位群友最多保留的印象条数（原 5）
    maxGroupEntries: 20,                  // 群记条数上限（收工轮重整时用；原为代码兜底 12）
    discoverMinMessages: 5,               // 整理轮"发现新人"的最低发言条数（原 20）
    discoverMaxMembers: 6,                // 单次整理最多发现几位新人（原 3）`,
`  memory: {
    consolidateEnabled: true,
    // 记忆不节流（2026-10-16 Rushiera 定）：「写的多不是坏事，但要能归档能索引」
    // ——条数放开、超出的转归档；冷却缩短；发现面放宽。
    // [qqagent-memory-patch:no-throttle-defaults]
    consolidateMinIntervalMs: 10800000,  // 整理冷却 3 小时（原 6 小时）
    maxImpressionsPerMember: 40,          // 重整提示词的条数上限（原 8）
    maxGroupEntries: 60,                  // 群记重整上限（原 20；现行池软上限在 group-memory.js）
    discoverMinMessages: 3,               // 整理轮"发现新人"的最低发言条数（原 5）
    discoverMaxMembers: 10,               // 单次整理最多发现几位新人（原 6）`);

// ⑥p orchestrator.js 群记重整：上限放宽 + 提示词去掉"宁少勿错"
patch('no-throttle-group-maxkeep', 'src/orchestrator.js',
`    const maxKeep = Math.max(4, Number(cfg.memory?.maxGroupEntries) || 12);`,
`    // 记忆不节流：上限只作提示词预算（超出的转归档，不丢）——[qqagent-memory-patch:no-throttle-group-maxkeep]
    const maxKeep = Math.max(8, Number(cfg.memory?.maxGroupEntries) || 60);`);

patch('no-throttle-group-prompt', 'src/orchestrator.js',
`        '1. 最多 ' + maxKeep + ' 条，每条不超过 120 字；同类合并，宁少勿错。',`,
`        '1. 条数上限 ' + maxKeep + '（超出的自动归档、不会丢），同类合并成一条、每条不超过 120 字；宁可多留，别把有用信息并没了。',`);

// ⑥q orchestrator.js 人档整理：cap 放开（不再"只减不增"）
patch('no-throttle-consolidate-cap', 'src/orchestrator.js',
`    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 8;
    const cap = isNew ? maxKeep : Math.min(maxKeep, existing.length + 2);`,
`    // 记忆不节流：条数只作提示词预算，不再"最多比原条数多 2 条"地砍
    // [qqagent-memory-patch:no-throttle-consolidate-cap]
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 40;
    const cap = isNew ? maxKeep : Math.max(maxKeep, existing.length + 10);`);

patch('no-throttle-consolidate-prompt', 'src/orchestrator.js',
`        \`4. 最多保留 \${maxKeep} 条，每条不超过 120 字。\`,`,
`        \`4. 条数上限 \${maxKeep}（超出的自动归档、不会丢），同类合并成一条、每条不超过 120 字。\`,`);

patch('no-throttle-new-prompt', 'src/orchestrator.js',
`        \`3. 最多 \${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。\`,`,
`        \`3. 条数上限 \${maxKeep}（超出的自动归档、不会丢），每条不超过 120 字，用第一人称视角（"他/她…"）。\`,`);

// ⑥r orchestrator.js 新建印象模式的默认值同步（|| 8 → || 40）
patch('no-throttle-new-maxkeep', 'src/orchestrator.js',
`    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 8;
    const uid = String(mem.userId || '');`,
`    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 40;
    const uid = String(mem.userId || '');`);

// ⑥s orchestrator.js 自动整理阈值：人数上限跟随新默认
patch('no-throttle-auto-threshold', 'src/orchestrator.js',
`      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);`,
`      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 40);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：记忆沉淀拍（冷群兜底）——2026-10-16
//   问题：唯一的结构化沉淀点是收工轮（上下文到阈值），冷群 rollovers=0 → 永远不沉淀。
//   解法：到点且「没有待处理消息」时走一次「只整理不发言」的整理轮（复用安静模式语义）。
// ─────────────────────────────────────────────────────────────────────────────

patch('no-throttle-sediment-config', 'src/config.js',
`    consolidateMinIntervalMs: 10800000,  // 整理冷却 3 小时（原 6 小时）
    maxImpressionsPerMember: 40,          // 重整提示词的条数上限（原 8）`,
`    consolidateMinIntervalMs: 10800000,  // 整理冷却 3 小时（原 6 小时）
    sedimentIntervalMs: 43200000,         // 记忆沉淀拍间隔（12 小时；0 = 关闭）
    maxImpressionsPerMember: 40,          // 重整提示词的条数上限（原 8）`);

patch('no-throttle-sediment-import', 'src/orchestrator.js',
`  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError,
  rateLimitRetryDelayMs
} from './session-state.js';`,
`  recordPromptTokens, resetSession, writeSessionSummary, getSessionState, isRateLimitedError,
  rateLimitRetryDelayMs,
  // 沉淀拍判据要读会话要点时间——[qqagent-memory-patch:no-throttle-sediment-import]
  readSessionSummary
} from './session-state.js';`);

patch('no-throttle-sediment-method', 'src/orchestrator.js',
`  /** 记下该群下一拍的时间点（force=true 重设相位 —— 运行结束回节拍用）。 */`,
`  /**
   * 记忆沉淀拍是否到点（2026-10-16）——冷群兜底：上下文永远到不了收工轮阈值的群
   * 也要能沉淀记忆。判据三条：
   *   ① 该群跑过至少一轮（lastPromptTokens>0）——新群第一条消息不该被整理轮吞掉；
   *   ② 距上次沉淀（_session.json 的 createdAt）≥ memory.sedimentIntervalMs（0=关）；
   *   ③ 调用方保证此刻没有待处理消息（沉淀轮不发言，不能吞群友的话）。
   * [qqagent-memory-patch:no-throttle-sediment-method]
   */
  #sedimentDue(chatKey, now) {
    const ms = Number(getConfig().memory?.sedimentIntervalMs);
    if (!Number.isFinite(ms) || ms <= 0) return false;
    let st;
    try { st = getSessionState(chatKey); } catch { return false; }
    if (!(Number(st?.lastPromptTokens) > 0)) return false;
    let last = 0;
    try { last = Number(readSessionSummary(chatKey)?.createdAt) || 0; } catch { last = 0; }
    return (Number(now) || Date.now()) - last >= ms;
  }

  /** 记下该群下一拍的时间点（force=true 重设相位 —— 运行结束回节拍用）。 */`);

patch('no-throttle-sediment-tick', 'src/orchestrator.js',
`      let unread = 0;
      try { unread = this.store.unreadCount(chatKey); } catch { unread = 0; }
      if (unread <= 0) continue;   // 没人发言 → 不调 LLM`,
`      let unread = 0;
      try { unread = this.store.unreadCount(chatKey); } catch { unread = 0; }
      // ── 记忆沉淀拍（2026-10-16）：冷群兜底 ──
      // 只在「没有待处理消息」时走 —— 沉淀轮不发言，有未读时先让正常轮把话接完。
      // [qqagent-memory-patch:no-throttle-sediment-tick]
      if (!quiet && unread <= 0 && this.#sedimentDue(chatKey, now)) {
        logger.info('browse', chatKey + ' 记忆沉淀拍：距上次沉淀已到点，走「只整理不发言」的整理轮');
        this.wake(chatKey, { quietOrganize: true })
          .catch((error) => console.error('[orchestrator] 沉淀拍 wake 出错:', error));
        continue;
      }
      if (unread <= 0) continue;   // 没人发言 → 不调 LLM`);

patch('no-throttle-sediment-empty', 'src/orchestrator.js',
`    const cfgForJudge = getConfig();
    let triggerEntries = [];
    if (!proactive) {
      const probe = this.store.peekUnread(chatKey, 500) || [];
      if (probe.length === 0 && waitingSessionId) {
        this.#finishWaiting(waitingSessionId, 'aborted');
        return;
      }`,
`    const cfgForJudge = getConfig();
    let triggerEntries = [];
    // 沉淀拍（quietOrganize 且无未读）：不取批、不吞消息 —— 取材面是本会话的已读窗口。
    // [qqagent-memory-patch:no-throttle-sediment-empty]
    const sedimentOnly = !!quietOrganize && (this.store.peekUnread(chatKey, 1) || []).length === 0;
    if (!proactive && !sedimentOnly) {
      const probe = this.store.peekUnread(chatKey, 500) || [];
      if (probe.length === 0 && waitingSessionId) {
        this.#finishWaiting(waitingSessionId, 'aborted');
        return;
      }`);

// 沉淀轮的会话页标签（原只有「安静整理轮」一档）
patch('no-throttle-sediment-label', 'src/orchestrator.js',
`        session.triggerSummary = quietOrganize ? '安静整理轮（定时沉淀）' : '收工轮（上下文轮转）';`,
`        session.triggerSummary = quietOrganize ? '整理轮（定时沉淀 / 安静模式）' : '收工轮（上下文轮转）';`);

// ⑥u setGroupTopics：写入不截断（超出的由 saveEntries 转归档，不静默丢）
patch('no-throttle-topics-write', 'src/group-memory.js',
`  const list = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean)
    .slice(0, MAX_TOPICS);
  if (!list.length) return 0;`,
`  // 写入不截断（记忆不节流）——超出的由 saveEntries 转归档，不静默丢。
  // [qqagent-memory-patch:no-throttle-topics-write]
  const list = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean);
  if (!list.length) return 0;`);

// ⑥v routes.js：记忆列表 / 详情带上归档计数（记忆页要看得到「归档」这一维）
patch('no-throttle-routes-import', 'src/routes.js',
`import { listGroupEntries, appendGroupEntry, replaceGroupEntries, removeGroupEntry, groupMemoryStats } from './group-memory.js';`,
`import { listGroupEntries, appendGroupEntry, replaceGroupEntries, removeGroupEntry, groupMemoryStats, listArchivedGroupEntries } from './group-memory.js';`);

patch('no-throttle-routes-list', 'src/routes.js',
`            groupCount: groupStats.count,`,
`            groupCount: groupStats.count,
            // 归档计数（记忆不节流：现行池之外还有多少）——[qqagent-memory-patch:no-throttle-routes-list]
            groupArchived: groupStats.archived || 0,
            memberArchived: memory.memberArchiveStats(chatKey)?.count || 0,`);

patch('no-throttle-routes-detail', 'src/routes.js',
`        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey), group: listGroupEntries(chatKey) });   // [qqagent-memory-patch:routes-detail]`,
`        // 详情带上归档（记忆页可切「现行 / 归档」查看）——[qqagent-memory-patch:no-throttle-routes-detail]
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey),
          group: listGroupEntries(chatKey),
          groupArchived: listArchivedGroupEntries(chatKey, { limit: 500 }),
          archiveStats: {
            group: groupMemoryStats(chatKey).archived || 0,
            member: memory.memberArchiveStats(chatKey)?.count || 0
          }
        });   // [qqagent-memory-patch:routes-detail]`);

// ⑥w 记忆页：列表项显示归档数
patch('no-throttle-ui-list', 'ui/app/05-memory-settings.js',
`      : (f.memberCount || f.groupCount
        ? \`\${f.memberCount} 位群友 · \${f.impressionCount} 条印象 · 群记 \${f.groupCount || 0} 条\`
        : '暂无群友印象');`,
`      : (f.memberCount || f.groupCount || f.groupArchived
        // 归档计数也进摘要（记忆不节流：现行池之外还有多少）——[qqagent-memory-patch:no-throttle-ui-list]
        ? \`\${f.memberCount} 位群友 · \${f.impressionCount} 条印象 · 群记 \${f.groupCount || 0} 条\`
          + ((f.groupArchived || f.memberArchived) ? \` · 归档 \${(f.groupArchived || 0) + (f.memberArchived || 0)} 条\` : '')
        : '暂无群友印象');`);

// ⑥x 记忆页：群记标题行显示归档数
patch('no-throttle-ui-group-head', 'ui/app/05-memory-settings.js',
`      + '<div class="list-head muted"><span>群记（本群长期事实 · ' + groupEntries.length + ' 条）</span>'`,
`      + '<div class="list-head muted"><span>群记（本群长期事实 · ' + groupEntries.length + ' 条'
      + ((mem.archiveStats && mem.archiveStats.group) ? ' · 归档 ' + mem.archiveStats.group + ' 条' : '') + '）</span>'`);

// ─────────────────────────────────────────────────────────────────────────────
// 结果
// ─────────────────────────────────────────────────────────────────────────────
const applied = results.filter((r) => r.status === 'applied').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
console.log('patch-qqagent-memory：applied ' + applied + ' / skipped ' + skipped + (DRY ? '（dry-run，未落盘）' : ''));
for (const r of results) console.log('  [' + r.status + '] ' + r.id + '  ' + r.file);
