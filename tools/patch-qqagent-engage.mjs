// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-engage.mjs — QQ Agent v0.4.0「群内自主参与」幂等补丁
//
// 用法：node patch-qqagent-engage.mjs [--dry]
// 做什么：把「取消本地触发门 + 发言配额 + 收工轮自产话题词」落进 _unpack 源码
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑（session 补丁 → 本补丁）即复现
// 幂等：每个补丁点带唯一标记 [qqagent-engage-patch:<id>]；已含标记 = 跳过
// 依赖：**先跑 patch-qqagent-session.mjs**（本补丁两个锚点落在它的产物上）
// 边界：不动安全边界 / Electron 壳；不改 store.historyCount；话题词只进提示词，不做触发门
//
// 设计要点（Rushiera 2026-10-09 口述规格）：
//   1. 触发权交给模型：contextTier=4（全消息进 LLM），不再靠 @/关键词/概率的本地门
//   2. 允许空调用：跑完不发言 = 合法结果（原生支持，本补丁不动）
//   3. 聚批：运行期间进来的消息不判定，本轮结束后并入下一次思考（原生支持）
//   4. 发言配额：滑动窗口内每群最多 N 条 —— 技术限频（防封号）之外的第二道闸
//   5. 话题词：收工轮顺手产出，注入【记忆】段当参考（方案 1：不做触发门）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-engage-patch:' + id + ']';

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
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 70)));
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
// 补丁 1：新增 src/topic-words.js —— 本群话题词的产出解析 / 存储 / 渲染
// ─────────────────────────────────────────────────────────────────────────────
const TOPIC_WORDS_JS = `// 本群话题词 —— 收工轮产出，提示词参考（不做触发门）。
// [qqagent-engage-patch:topic-words]
//
// 文件：data/memory/<chat>/_topics.json
// 形态：{ chatKey, words: [...], updatedAt, rollovers }
//
// 用途：只进【记忆】段，帮模型判断"这条消息跟本群常聊的事有没有关系"；
// 冷场开话题时也可当选题参考。**不参与任何触发判定** —— 触发权完全在模型手里。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MAX_WORDS = 12;

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 话题词文件路径（与 _session.json 同址，下划线开头避开成员文件语义）。 */
export function topicWordsFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_topics.json');
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

/**
 * 从收工轮正文里解析话题词行。
 * 约定形态：「话题词：词1、词2、词3」（也容忍 逗号 / 空格 / 顿号 混用）。
 * 解析不到就返回空数组 —— 本轮不更新词表，保留上一版（宁可不换，不可清空）。
 */
export function extractTopicWords(text) {
  const lines = String(text ?? '').split(/\\r?\\n/);
  for (const line of lines) {
    const m = /话题词\\s*[:：]\\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const words = m[1]
      .split(/[、,，\\s\\/]+/)
      .map((w) => w.replace(/^[\\-\\*\\d.、)]+/, '').trim())
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

/** 写话题词（收工轮产出）。空数组不写 —— 保留上一版。 */
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

/** 读话题词；没有就返回 null。 */
export function readTopicWords(chatKey) {
  const raw = readJson(topicWordsFile(chatKey), null);
  const words = Array.isArray(raw?.words) ? raw.words.map((w) => String(w)).filter(Boolean) : [];
  if (!words.length) return null;
  return { words, updatedAt: Number(raw?.updatedAt) || 0, rollovers: Number(raw?.rollovers) || 0 };
}

/** 渲染成【记忆】段的一块（会话级要点之后、群友印象之前）。 */
export function formatTopicWordsForPrompt(chatKey) {
  const t = readTopicWords(chatKey);
  if (!t) return '';
  return '【本群常聊的话题词】' + t.words.join('、') + '（参考用：跟这些沾边的消息更值得接，别硬往上靠）';
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新增 src/topic-words.js —— 本群话题词的产出解析 / 存储 / 渲染
// ─────────────────────────────────────────────────────────────────────────────
addFile('topic-words', 'topic-words.js', TOPIC_WORDS_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/config.js —— 新增 engage 配置段（发言配额 + 话题词）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-engage', 'config.js',
`  // 屏蔽名单：{ [群号]: [QQ号, ...] }`,
`  // ── 群内自主参与（2026-10-09）── [qqagent-engage-patch:config-engage]
  // quota：滑动窗口内的发言条数上限 —— 发言节制（区别于 send.maxPerMinute 的防封号限频）。
  //   超限时发送被拒，错误回给模型（模型据此沉默）；提示词里同步告知余量。
  //   enabled=false 完全回到旧行为。
  // topicWords：收工轮自产的本群话题词 —— 只进【记忆】段当参考，不做触发门。
  engage: {
    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true }
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/sender.js —— 发言配额闸门（滑动窗口，所有发送路径共用）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-ctor', 'sender.js',
`    this.recentSent = new Map();  // "chatKey::text" -> ts（发送去重窗口）`,
`    this.recentSent = new Map();  // "chatKey::text" -> ts（发送去重窗口）
    // 发言配额时间戳（[qqagent-engage-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.quotaTimes = new Map();  // chatKey -> [ts]`);

patch('sender-quota', 'sender.js',
`  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;`,
`  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    // ── 发言配额（[qqagent-engage-patch:sender-quota]）──
    // 与技术限频分开：maxPerMinute / maxPerHour 防封号，这里管"说多少"。
    // 超限直接抛错 —— 工具把错误回给模型，模型据此沉默。不做延迟排队：
    // 延后几十秒再发，对话早已翻篇，发出去比不发更怪。
    // 记账在抛错之后 —— 被拒的发送不占配额。
    const q = getConfig().engage?.quota || {};
    if (q.enabled !== false) {
      const winMs = Math.max(10000, Number(q.windowMs) || 120000);
      const maxN = Math.max(1, Number(q.maxPerWindow) || 5);
      const times = (this.quotaTimes.get(chatKey) || []).filter((t) => now - t < winMs);
      if (times.length >= maxN) {
        throw new Error('发言配额已满（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN + ' 条），本轮不要再发消息');
      }
      times.push(now);
      this.quotaTimes.set(chatKey, times);
    }`);

patch('sender-quota-state', 'sender.js',
`    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }`,
`    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 配额余量（供提示词注入 —— 让模型自己看着办，而不是发到一半被拦）。
   * [qqagent-engage-patch:sender-quota-state]
   * @returns {{used:number, max:number, windowMs:number, remaining:number}|null} null = 配额关闭
   */
  quotaState(chatKey) {
    const q = getConfig().engage?.quota || {};
    if (q.enabled === false) return null;
    const winMs = Math.max(10000, Number(q.windowMs) || 120000);
    const maxN = Math.max(1, Number(q.maxPerWindow) || 5);
    const now = Date.now();
    const used = (this.quotaTimes.get(chatKey) || []).filter((t) => now - t < winMs).length;
    return { used, max: maxN, windowMs: winMs, remaining: Math.max(0, maxN - used) };
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/orchestrator.js —— 配额余量注入 + 收工轮自产话题词
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', 'orchestrator.js',
`} from './session-state.js';`,
`} from './session-state.js';
// 本群话题词（收工轮自产，提示词参考）——[qqagent-engage-patch:orchestrator-import]
import { extractTopicWords, writeTopicWords } from './topic-words.js';`);

patch('orchestrator-quota-def', 'orchestrator.js',
`    const messages = [
      { role: 'system', content: systemPrompt },`,
`    // 发言配额余量（[qqagent-engage-patch:orchestrator-quota-def]）—— 动态段必须追加在
    // 用户消息末尾：插进【记忆】/【已读信息】前缀里会把锚点缓存的字节打散。
    const quotaLine = (() => {
      if (!String(chatKey).startsWith('group:')) return '';
      const q = this.sender && typeof this.sender.quotaState === 'function' ? this.sender.quotaState(chatKey) : null;
      if (!q) return '';
      return '\\n\\n【发言配额】本群最近 ' + Math.round(q.windowMs / 1000) + ' 秒已发 ' + q.used + ' 条 / 上限 ' + q.max + ' 条（还能发 ' + q.remaining + ' 条）。超限的发送会被系统拒绝 —— 按这个余量自行决定要不要开口；不值得说就安静结束。';
    })();
    const messages = [
      { role: 'system', content: systemPrompt },`);

patch('orchestrator-quota-open', 'orchestrator.js',
`      { role: 'user', content: proactive`,
`      { role: 'user', content: (proactive`,
1,
`content: (proactive`);

patch('orchestrator-quota-append', 'orchestrator.js',
`        : userPrompt }
    ];`,
`        : userPrompt) + quotaLine }
    ];`,
1,
`        : userPrompt) + quotaLine`);

patch('orchestrator-rollover-topics', 'orchestrator.js',
`    '4. 写完就结束（调用 finish，reason 填"收工"）。'
  ].join('\\n');`,
`    '4. 写完就结束（调用 finish，reason 填"收工"）。',
    '5. 【话题词】最后补一行「话题词：词1、词2、…」—— 8~12 个短词，代表本群最近常聊的主题（人名 / 游戏 / 术语 / 梗 / 事件）。只列词，不解释。'
  ].join('\\n');`,
1,
// ⚠️ 2026-10-11：该落点已由 memory 补丁接管（收工轮指令被重写：加了"先写群记 / 再写印象"，
// 话题词行编号 4→6，本补丁的旧标记随旧文案一起消失）——重放时以 memory 的标记为准跳过本点，
// 上面的锚点只对"从原始版本首跑"有意义。
`[qqagent-memory-patch:orchestrator-rollover-topics]`);

patch('orchestrator-rollover-write', 'orchestrator.js',
`      writeSessionSummary(chatKey, summary, {
        sessionStartedAt: state.startedAt,
        rollovers: state.rollovers,
        messages: Array.isArray(session.trigger) ? session.trigger.length : 0,
        source: 'rollover'
      });`,
`      writeSessionSummary(chatKey, summary, {
        sessionStartedAt: state.startedAt,
        rollovers: state.rollovers,
        messages: Array.isArray(session.trigger) ? session.trigger.length : 0,
        source: 'rollover'
      });
      // 话题词（收工轮自产）—— 提示词参考，不做触发门。[qqagent-engage-patch:orchestrator-rollover-write]
      const topicWords = extractTopicWords(summary);
      if (topicWords.length) writeTopicWords(chatKey, topicWords, { rollovers: state.rollovers });`,
1,
`[qqagent-memory-patch:orchestrator-rollover-topics]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/prompt.js ——【记忆】段注入本群话题词
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-import', 'prompt.js',
`import { formatSessionSummaryForPrompt } from './session-state.js';`,
`import { formatSessionSummaryForPrompt } from './session-state.js';
// 本群话题词（收工轮自产）——【记忆】段第二块（[qqagent-engage-patch:prompt-import]）
import { formatTopicWordsForPrompt } from './topic-words.js';`,
1,
`[qqagent-memory-patch:prompt-import]`);

patch('prompt-topic-words', 'prompt.js',
`  const memText = [sessionMemText, memTextRaw].filter(Boolean).join('\\n');`,
`  // 话题词排在会话要点之后、群友印象之前 —— 会话内稳定，不打断【记忆】段的缓存前缀角色。
  // [qqagent-engage-patch:prompt-topic-words]
  const topicWordsText = formatTopicWordsForPrompt(ctx.chatKey);
  const memText = [sessionMemText, topicWordsText, memTextRaw].filter(Boolean).join('\\n');`,
1,
`[qqagent-memory-patch:prompt-group]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：新增 src/chatter.js + orchestrator 注入「发言热度」提示
// ─────────────────────────────────────────────────────────────────────────────
const CHATTER_JS = `// 发言热度 —— 检测"话密的群友"与"人机对刷"，渲染成提示词参考。
// [qqagent-engage-patch:chatter]
//
// 设计（Rushiera 2026-10-09 规格）：
//   某个群友发言频率过高 → 对这个人的接话频率**依次降级**，避免吵起来。
//   尤其"机器人每发一条、他回一条"的对刷场合，要让模型更多地判断"不回复"，
//   而不是撞上发言配额才被迫停。
//
// 本模块**不做任何判定**：只统计事实 + 渲染成提示 —— 接不接话仍由模型决定。
// 分级（依次降级）：
//   L1 提示：对方话很密（窗口内条数超阈）→ 只在他直接问或有新信息时接
//   L2 收紧：与对方来回已达阈值轮 → 除非有实质新内容，倾向不接
//   L3 停：轮数/条数再上一个台阶 → 本轮不回复（除非他直接 @ 问具体的事）
const WINDOW_MS = 600000;
const RECENT_LIMIT = 40;
const SOFT_COUNT = 8;
const STRONG_COUNT = 15;
const SOFT_ROUNDS = 3;
const STRONG_ROUNDS = 5;

/** 从尾部扫描"机器人 ↔ 同一人"的交替往返；换人即断。 */
function detectLoops(messages) {
  const loops = new Map();
  let partner = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.self) {
      if (partner) loops.set(partner, (loops.get(partner) || 0) + 1);
    } else if (m && m.senderId) {
      if (partner === null) partner = String(m.senderId);
      else if (String(m.senderId) !== partner) break;
    } else {
      break;
    }
  }
  return loops;
}

/**
 * 分析某会话的发言热度。
 * @returns {{ level:'none'|'soft'|'strong', hot:Array, loops:Array }}
 */
export function analyzeChatter(store, chatKey, { windowMs = WINDOW_MS, recentLimit = RECENT_LIMIT } = {}) {
  const since = Date.now() - Math.max(60000, Number(windowMs) || WINDOW_MS);
  let recent = [];
  try { recent = store.messagesSince(chatKey, since, { limit: 0 }) || []; } catch { recent = []; }
  const count = new Map();
  const names = new Map();
  for (const m of recent) {
    if (!m || m.self || !m.senderId) continue;
    const id = String(m.senderId);
    count.set(id, (count.get(id) || 0) + 1);
    if (m.senderName) names.set(id, String(m.senderName));
  }
  const hot = [...count.entries()]
    .map(([id, n]) => ({ id, name: names.get(id) || id, count: n }))
    .filter((x) => x.count >= SOFT_COUNT)
    .sort((a, b) => b.count - a.count);

  let tail = [];
  try { tail = store.recent(chatKey, { limit: Math.max(10, Number(recentLimit) || RECENT_LIMIT) }) || []; } catch { tail = []; }
  const loops = [...detectLoops(tail).entries()]
    .map(([id, rounds]) => ({ id, name: names.get(id) || id, rounds }))
    .filter((x) => x.rounds >= SOFT_ROUNDS)
    .sort((a, b) => b.rounds - a.rounds);

  const strong = hot.some((x) => x.count >= STRONG_COUNT) || loops.some((x) => x.rounds >= STRONG_ROUNDS);
  const level = strong ? 'strong' : (hot.length || loops.length) ? 'soft' : 'none';
  return { level, hot, loops };
}

/** 渲染成提示段（追加在用户消息末尾）。无可说时返回空串。 */
export function formatChatterHint(store, chatKey, opts = {}) {
  const a = analyzeChatter(store, chatKey, opts);
  if (a.level === 'none') return '';
  const lines = ['【发言热度（本轮参考，不强制）】'];
  if (a.loops.length) {
    const top = a.loops[0];
    lines.push('- 你和 ' + top.name + ' 最近已经来回 ' + top.rounds + ' 轮。真人聊天不会句句都接 —— '
      + (a.level === 'strong'
        ? '本轮建议不回复，除非他直接 @ 你问具体的事。'
        : '除非他这条有实质新内容，否则倾向不接。'));
  }
  for (const h of a.hot.slice(0, 3)) {
    lines.push('- ' + h.name + ' 最近 10 分钟说了 ' + h.count + ' 条，话比较密 —— '
      + (h.count >= STRONG_COUNT ? '不必每条都跟。' : '只在他直接问你或有新信息时接。'));
  }
  if (a.level === 'strong') {
    lines.push('- 像群友一样有来有回、不是有问必答：这一轮安静也是正常参与。');
  }
  return '\\n\\n' + lines.join('\\n');
}
`;

addFile('chatter', 'chatter.js', CHATTER_JS);

patch('orchestrator-chatter-import', 'orchestrator.js',
`import { extractTopicWords, writeTopicWords } from './topic-words.js';`,
`import { extractTopicWords, writeTopicWords } from './topic-words.js';
// 发言热度（话密的群友 / 人机对刷）——提示词参考（[qqagent-engage-patch:orchestrator-chatter-import]）
import { formatChatterHint } from './chatter.js';`);

patch('orchestrator-chatter-def', 'orchestrator.js',
`    const messages = [
      { role: 'system', content: systemPrompt },`,
`    // 发言热度提示（[qqagent-engage-patch:orchestrator-chatter-def]）—— 与配额同段：
    // 都是"本轮动态状态"，都追加在用户消息末尾（不打断缓存前缀）。
    // 只给参考，是否接话仍由模型决定 —— 不设任何本地门。
    const chatterHint = (() => {
      if (!String(chatKey).startsWith('group:')) return '';
      try { return formatChatterHint(this.store, chatKey); } catch { return ''; }
    })();
    const messages = [
      { role: 'system', content: systemPrompt },`);

patch('orchestrator-chatter-append', 'orchestrator.js',
`        : userPrompt) + quotaLine }
    ];`,
`        : userPrompt) + quotaLine + chatterHint }
    ];`,
1,
`        : userPrompt) + quotaLine + chatterHint`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：卡死看门狗 —— 运行超时自动中止 + 恢复未读 + 重排
// ─────────────────────────────────────────────────────────────────────────────
patch('config-stall', 'config.js',
`  // ── 群内自主参与（2026-10-09）── [qqagent-engage-patch:config-engage]`,
`  // ── 卡死看门狗（2026-10-10）── [qqagent-engage-patch:config-stall]
  // 上游端点卡住时（请求挂起 / 流式中途不动），一轮运行可能长时间既不中止也不发言。
  // 看门狗定期扫运行中的会话：超过 timeoutMs 没有活动 → 中止在途请求 + 把本轮未读
  // 恢复为未读 + 3 秒后重排（消息不丢，等上游恢复后重新思考）。
  // 判据用 max(startedAt, updatedAt) —— 只要会话还在推进就不算卡死。
  // 与 api.timeoutMs（单次请求超时）互补：那个管一次请求，这个管整轮运行。
  stall: {
    enabled: true,
    timeoutMs: 150000,
    checkIntervalMs: 20000
  },
  // ── 群内自主参与（2026-10-09）── [qqagent-engage-patch:config-engage]`);

patch('orchestrator-stall-ctor', 'orchestrator.js',
`    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey`,
`    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.stallTimer = null;            // 卡死看门狗句柄（[qqagent-engage-patch:orchestrator-stall-ctor]）`);

patch('orchestrator-stall-hook', 'orchestrator.js',
`  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null } = {}) {
    if (this.aborted) {`,
`  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null } = {}) {
    this.#ensureStallWatchdog();   // [qqagent-engage-patch:orchestrator-stall-hook]
    if (this.aborted) {`);

patch('orchestrator-stall-methods', 'orchestrator.js',
`  #muteCache = new Map();   // chatKey -> { muted: boolean, checkedAt: number }`,
`  // ── 卡死看门狗（[qqagent-engage-patch:orchestrator-stall-methods]）──────────────
  // 上游端点卡住时，一轮运行可能既不中止也不发言（面板上就是"思考好久没动静"）。
  // 看门狗定期扫运行中的会话，超时即中止 + 恢复未读 + 重排 —— 消息不丢，
  // 等上游恢复后重新思考。判据取 max(startedAt, updatedAt)：还在推进就不算卡死。
  #ensureStallWatchdog() {
    if (this.stallTimer) return;
    const cfg = getConfig().stall || {};
    if (cfg.enabled === false) return;
    const interval = Math.max(5000, Number(cfg.checkIntervalMs) || 20000);
    this.stallTimer = setInterval(() => {
      try { this.#checkStalls(); } catch (e) { console.error('[orchestrator] 看门狗巡检出错:', e?.message ?? e); }
    }, interval);
    this.stallTimer.unref?.();
  }

  #checkStalls() {
    const cfg = getConfig().stall || {};
    if (cfg.enabled === false) return;
    const timeoutMs = Math.max(30000, Number(cfg.timeoutMs) || 150000);
    const now = Date.now();
    for (const [chatKey, sessionId] of [...this.activeRuns.entries()]) {
      const s = this.sessions.get(sessionId);
      if (!s || s.status !== 'running') continue;
      const last = Math.max(Number(s.startedAt) || 0, Number(s.updatedAt) || 0);
      if (!last || now - last < timeoutMs) continue;
      this.#handleStall(chatKey, sessionId, s, now - last);
    }
  }

  #handleStall(chatKey, sessionId, session, idleMs) {
    // 打中止标记 + 立刻中断在途请求（reason 含"中止"→ isRetryableError 判不可重试，
    // 不会再打下一发；#runAgent 随即走标准收尾路径）。
    this.sessionAbortMarks.add(sessionId);
    const ctrl = this.sessionAbortControllers.get(sessionId);
    if (ctrl) { try { ctrl.abort(new Error('会话运行超时（看门狗中止）')); } catch { /* 已中止过 */ } }
    // 本轮消息恢复为未读 —— 不丢，重排后重新进入思考。
    let restored = 0;
    try { restored = this.store.markUnreadInWindow(chatKey, session.startedAt, Date.now()); } catch { restored = 0; }
    // 等会话收尾让出并发槽后再重排（3 秒与并发重排同款间隔）。
    const timer = setTimeout(() => {
      this.wakeTimers.delete(chatKey);
      if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) this.scheduleWake(chatKey, 0);
    }, 3000);
    timer.unref?.();
    this.wakeTimers.set(chatKey, timer);
    console.warn('[orchestrator] ' + chatKey + ' 看门狗：' + Math.round(idleMs / 1000) + 's 无活动，已中止在途请求并恢复 ' + restored + ' 条未读（3s 后重排）');
  }

  #muteCache = new Map();   // chatKey -> { muted: boolean, checkedAt: number }`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  points: results
}, null, 2));
