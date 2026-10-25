// patch-qqagent-level.mjs — QQ Agent v0.4.0「发言档位（五档）+ 客观采集」幂等补丁
//
// 用法：node patch-qqagent-level.mjs [--dry]
// 做什么：把「按群五档发言节制」+「客观信号采集」落进 _unpack 源码
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑全部补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-level-patch:<id>]；已含标记 = 跳过
// 依赖：**先跑 patch-qqagent-engage / browse / quiet / rapport / session**
//       （本补丁的锚点全部落在这些补丁的产物上）
// 边界：**不动发言配额 5/2min**、**不动 browse.levels 节拍表**、不动发送队列结构
//
// 设计要点（Rushiera 2026-10-25 定）：
//   1. 五档 = 冰封 / 保守 / 标准 / 活跃 / 全开；档位只调"这一拍要不要开口"（参与率），
//      配额与节拍表原样不动 —— 配额是"这一窗口最多几条"，档位是"要不要入场"。
//   2. 冰封档 = 现有安静模式（非 @ 不进 LLM + 定时只整理不发言）；engage.quiet.chats
//      保留为冰封档的别名，老配置启动即生效，不清空。
//   3. 回应参数（rapport）客观结算降级：判定照跑、日志照记，但"没人接话"的降分被
//      档位 missCap 压到 0 —— 分不再自己往下掉，硬闸退化成采集面 + 模型手调。
//   4. 客观信号（发言占比 / 被点名率 / 提问密度 / 时段 / 日成本 / 连续未接）先采集、
//      默认不参与判定（engage.signals.enabled=false）；跑几天看分布再决定是否启用。
//
// 落点：
//   src/engage-level.js     五档表 + paramsFor + rollParticipation + levelHint（新增）
//   src/engage-signals.js   客观信号纯函数 + 乘性合成（新增）
//   src/engage-metrics.js   每拍一行 JSONL 落盘（新增）
//   src/config.js           engage.levels / levelByChat / signals 默认段
//   src/orchestrator.js     import + 参与率判定 + 档位提示段
//   src/rapport.js          missDelta 按档位封顶
//   src/sender.js           出站闸拦截落 metics（补上观测盲区）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-level-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 90)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/** 新增文件：已存在且非本补丁产物时拒绝覆盖；内容有更新则重写（保持幂等可复现）。 */
function addFile(id, rel, content) {
  const file = path.join(SRC, rel);
  const want = toEol(content, detectEol(path.join(SRC, 'config.js')));
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes(mark(id))) {
      throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel + '（先人工确认再删）');
    }
    if (cur === want) { results.push({ id, file: rel, status: 'skipped' }); return; }
    if (!DRY) fs.writeFileSync(file, want, 'utf8');
    results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
    return;
  }
  if (!DRY) fs.writeFileSync(file, want, 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新增 src/engage-level.js —— 五档表 + 派生入口
// ─────────────────────────────────────────────────────────────────────────────
const LEVEL_JS = `// 发言档位 —— 按群的"爱说多少"五档。[qqagent-level-patch:level]
//
// 语义（Rushiera 2026-10-25 定）：
//   档位只回答一个问题：**这一拍到点有未读，要不要进 LLM**（参与率）。
//   · 发言配额（5 条 / 2 分钟）与浏览节拍表（240/120/60 秒）**不由档位改动** ——
//     配额管"一个窗口最多几条"，档位管"要不要入场"；两件事分开，互不覆盖。
//   · 冰封档 = 原「安静模式」：非 @ 不进 LLM，到点只做"只整理不发言"的沉淀轮。
//     config.engage.quiet.chats 保留为冰封档的别名（老配置启动即生效，不清空）。
//   · 参与率是概率入场：未命中时**未读不推进**（消息留存到下一拍），不丢内容。
//
// 为什么用概率入场而不是继续加闸：出站闸只能"拦住已经想说的话"，压不住"想说"本身；
// 10-22 的实测（进 LLM 267 批 / 只发出 76 条）说明问题在入场面不在出站面。
//
// 状态：档位是**配置态**（config.engage.levelByChat），跨重启有效。
import { getConfig } from './config.js';

const FALLBACK_LEVELS = [
  { name: '冰封', rate: 0, missCap: 0, organizeOnly: true },
  { name: '保守', rate: 0.25, missCap: 0, organizeOnly: false },
  { name: '标准', rate: 0.6, missCap: 0, organizeOnly: false },
  { name: '活跃', rate: 0.85, missCap: 0, organizeOnly: false },
  { name: '全开', rate: 1, missCap: 0, organizeOnly: false }
];

function engageCfg() {
  return getConfig().engage || {};
}

/** 档位表（配置缺失 / 非法 → 内置五档）。 */
export function levelTable() {
  const raw = engageCfg().levels;
  if (!Array.isArray(raw) || raw.length < 2) return FALLBACK_LEVELS;
  return raw.map((e, i) => {
    const d = FALLBACK_LEVELS[Math.min(i, FALLBACK_LEVELS.length - 1)];
    const rate = Number(e && e.rate);
    return {
      name: String((e && e.name) || d.name),
      rate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : d.rate,
      missCap: Math.max(0, Number(e && e.missCap) || 0),
      organizeOnly: Boolean(e && e.organizeOnly === true)
    };
  });
}

/**
 * 该会话的档位（1 起）。
 * 优先级：levelByChat 显式指定 → quiet.chats 别名(1) → 默认 3（标准）。
 * 私聊不受档位节制（1v1 是对方在跟你说话）→ 取最高档（全入场）。
 */
export function levelForChat(chatKey) {
  const key = String(chatKey || '');
  const table = levelTable();
  const max = table.length;
  const id = key.split(':')[1] || '';
  const map = engageCfg().levelByChat || {};
  if (id && map[id] != null) {
    const n = Math.round(Number(map[id]));
    if (Number.isFinite(n)) return Math.min(max, Math.max(1, n));
  }
  if (!key.startsWith('group:')) return max;
  const q = engageCfg().quiet || {};
  if (q.enabled !== false) {
    const chats = (Array.isArray(q.chats) ? q.chats : []).map((v) => String(v).trim()).filter(Boolean);
    if (id && chats.includes(id)) return 1;
  }
  return Math.min(max, 3);
}

/** 该会话的档位参数（唯一派生入口 —— 到处都从这里取，别各读各的配置）。 */
export function paramsFor(chatKey) {
  const table = levelTable();
  const level = levelForChat(chatKey);
  const p = table[Math.min(table.length - 1, Math.max(0, level - 1))];
  return { ...p, level, levelCount: table.length };
}

/**
 * 参与率掷骰（纯判定，不改状态）。
 * @returns {{participate:boolean, rate:number, roll:number, level:number}}
 */
export function rollParticipation(chatKey, rand = Math.random) {
  const p = paramsFor(chatKey);
  if (p.rate >= 1) return { participate: true, rate: p.rate, roll: 0, level: p.level };
  if (p.rate <= 0) return { participate: false, rate: p.rate, roll: 1, level: p.level };
  const roll = Number(rand()) || 0;
  return { participate: roll < p.rate, rate: p.rate, roll, level: p.level };
}

/**
 * 【发言档位】提示词段（群聊专用；私聊 / 全开档返回空串不占 token）。
 * 与【发言配额】同段：都是本轮动态状态，追加在用户消息末尾（不打断缓存前缀）。
 */
export function levelHint(chatKey) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return '';
  const p = paramsFor(chatKey);
  if (p.organizeOnly) {
    return '\\n\\n【发言档位】本群是冰封档（' + p.level + '/' + p.levelCount + '）：默认不参与闲聊，'
      + '只有被 @ / 拍一拍 点名时才回应；系统会定时做一次"只整理不发言"的记忆沉淀（存档与记忆照常）。'
      + '被点名时正常回应即可，其余时候安静看就好。';
  }
  if (p.rate >= 1) return '';
  return '\\n\\n【发言档位】本群是' + p.name + '档（' + p.level + '/' + p.levelCount + '，入场率 '
    + Math.round(p.rate * 100) + '%）：你可能连着几拍都没收到新消息 —— 那是系统在省着看，不是群里没人说话。'
    + '收到消息的每一拍都是攒下来的整段内容，看完自己决定接不接，不用每条都接。';
}
`;

addFile('level', 'engage-level.js', LEVEL_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：新增 src/engage-signals.js —— 客观信号纯函数 + 乘性合成
// ─────────────────────────────────────────────────────────────────────────────
const SIGNALS_JS = `// 客观信号 —— 从存档与用量里算出来的"该不该说话"的客观依据。[qqagent-level-patch:signals]
//
// 语义（Rushiera 2026-10-25 定）：回应参数只有"有没有人接"一个信号，太单一；
// 这里把存档里本来就有的事实算成 6 个系数，合起来给参与率乘一个修正。
//
// 🔴 默认只采集不参与判定（config.engage.signals.enabled=false）——
//    先跑几天看分布，确认系数不会把发言压成零，再决定启用。
//    启用后也只做**乘法修正**（几何平均，下限 floor），不是硬闸：
//    单个信号偏低不会一票否决，多个同时偏低才平滑收敛。
//
// 六个信号的取值口径（全部只用存档里已有字段，不新增采集面）：
//   share    我发言占比 = self / 总数。太高（存在感过强）→ 压；太低不奖励（避免抢话）。
//   atRate   被点名率 = atMe / 总数。≥3% 说明群里在找我 → 略放；低是常态，不罚。
//   askDensity 提问密度 = 带问号/问法的比例。≥25% 说明有话题可接 → 略放。
//   hourFactor 深夜（23-07 点）×0.5，其余 1。
//   costFactor 当日成本越高越省（>100 元 ×0.7，>50 元 ×0.85）。
//   missFactor 连续没被接话的拍数（每拍 -0.05，下限 0.5）。

/** 单条消息是否"像在提问"（不区分谁发的）。 */
function looksLikeAsk(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  return /(怎么|为什么|为啥|咋|如何|能不能|是不是|有没有|要不要|哪个|啥)/.test(t);
}

/**
 * 计算客观信号（纯函数 —— 不读盘、不读配置，方便自测）。
 * @param {Array} messages 最近一批消息（条目结构见 store，字段 self / atMe / text）
 * @param {{hour?:number, costDay?:number, missStreak?:number}} env
 */
export function computeSignals(messages, env = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  let self = 0;
  let at = 0;
  let ask = 0;
  for (const m of list) {
    if (!m) continue;
    if (m.self) { self += 1; continue; }
    if (m.atMe === true) at += 1;
    if (looksLikeAsk(m.text)) ask += 1;
  }
  const other = Math.max(1, total - self);
  const share = total > 0 ? self / total : 0;
  const atRate = total > 0 ? at / total : 0;
  const askDensity = total > 0 ? ask / other : 0;

  // 发言占比：>15% 开始收，>35% 收到下限（存在感过强）
  const shareFactor = share <= 0.15 ? 1 : Math.max(0.5, 1 - (share - 0.15) * 2.5);
  // 被点名率：≥3% 视为"群里在找我"→ 略放；否则不动（低是常态，不罚）
  const atFactor = atRate >= 0.03 ? 1.15 : 1;
  // 提问密度：≥25% 略放；否则不动
  const askFactor = askDensity >= 0.25 ? 1.1 : 1;

  const hour = Number(env.hour);
  const h = Number.isFinite(hour) ? hour : new Date().getHours();
  const hourFactor = (h >= 23 || h < 7) ? 0.5 : 1;

  const cost = Number(env.costDay) || 0;
  const costFactor = cost > 100 ? 0.7 : (cost > 50 ? 0.85 : 1);

  const miss = Math.max(0, Number(env.missStreak) || 0);
  const missFactor = Math.max(0.5, 1 - miss * 0.05);

  return {
    total, self, at, ask, share, atRate, askDensity,
    shareFactor, atFactor, askFactor, hourFactor, costFactor, missFactor
  };
}

/**
 * 乘性合成：几何平均（六项等权），下限 floor。
 * @returns {number} 0 ~ 1.15 的系数（>1 表示这一拍鼓励开口）
 */
export function compositeCoefficient(sig, floor = 0.15) {
  const f = [
    sig && sig.shareFactor,
    sig && sig.atFactor,
    sig && sig.askFactor,
    sig && sig.hourFactor,
    sig && sig.costFactor,
    sig && sig.missFactor
  ].map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1));
  const prod = f.reduce((a, b) => a * b, 1);
  const geo = Math.pow(prod, 1 / f.length);
  const lo = Number.isFinite(Number(floor)) ? Number(floor) : 0.15;
  return Math.min(1.15, Math.max(lo, geo));
}

/** 采集用的一行摘要（写进 engage-metrics，字段短便于 grep）。 */
export function signalSummary(sig, coef) {
  return {
    total: sig.total,
    self: sig.self,
    share: Math.round(sig.share * 1000) / 1000,
    atRate: Math.round(sig.atRate * 1000) / 1000,
    askDensity: Math.round(sig.askDensity * 1000) / 1000,
    hourFactor: sig.hourFactor,
    costFactor: sig.costFactor,
    missFactor: sig.missFactor,
    coef: Math.round(Number(coef) * 1000) / 1000
  };
}
`;

addFile('signals', 'engage-signals.js', SIGNALS_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：新增 src/engage-metrics.js —— 每拍一行 JSONL
// ─────────────────────────────────────────────────────────────────────────────
const METRICS_JS = `// 发言节制采集面 —— 把"这一拍为什么开口 / 为什么没开口"落成可算的数据。
// [qqagent-level-patch:metrics]
//
// 为什么要有它：出站闸拦下的发送原先不写日志，只把错误回给模型 ——
//   于是"话变少了"在日志里查不出原因，只能靠"发送量骤降 + 结算行数暴增"反推。
//   采集面落地后，每个群的入场判定 / 闸拦截 / 实发条数都能按天算。
//
// 形态：data/metrics/engage-<YYYY-MM-DD>.jsonl —— 一行一个事件，append-only。
//   采集失败绝不影响发言（所有调用点都 try/catch 包着）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'metrics');
const KEEP_DAYS = 30;

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fileFor(ts) {
  return path.join(DIR, 'engage-' + dayKey(ts) + '.jsonl');
}

/** 清掉超期文件（每天第一次写时顺手做；失败忽略）。 */
function pruneOld(ts) {
  const cutoff = ts - KEEP_DAYS * 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  for (const n of names) {
    const m = /^engage-(\\d{4})-(\\d{2})-(\\d{2})\\.jsonl$/.exec(n);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.unlinkSync(path.join(DIR, n)); } catch { /* 占用即跳过 */ } }
  }
}

let lastPruneDay = '';

/**
 * 记一条事件。
 * @param {object} entry { chat, event:'roll'|'blocked'|'sent', ... }
 */
export function record(entry) {
  const ts = Date.now();
  const row = { ts, ...entry };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const day = dayKey(ts);
    if (lastPruneDay !== day) { lastPruneDay = day; pruneOld(ts); }
    fs.appendFileSync(fileFor(ts), JSON.stringify(row) + '\\n', 'utf8');
  } catch { /* 采集是旁路：失败绝不影响发言 */ }
}

/** 采集目录（自测 / 排查用）。 */
export function metricsDir() {
  return DIR;
}
`;

addFile('metrics', 'engage-metrics.js', METRICS_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：config.js —— engage.levels / levelByChat / signals 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-levels', SRC, 'config.js',
`      organizeOnly: true
    }
  },`,
`      organizeOnly: true
    },
    // ── 发言档位（2026-10-25）── [qqagent-level-patch:config-levels]
    // 按群的"爱说多少"五档。档位只调**参与率**（这一拍要不要进 LLM）与"没人接话"的
    // 降分上限；**发言配额 5/2min 与浏览节拍表 240/120/60 秒不由档位改动**。
    //   rate：到点有未读时的入场概率（0 = 非 @ 不进，1 = 全入场）
    //   missCap：回应参数"没人接话"单次最多降多少分（0 = 只采集不降分）
    //   organizeOnly：到点走"只整理不发言"的沉淀轮（安静模式语义）
    // levelByChat：{ [群号]: 1~5 }；未指定的群默认 3（标准档）。
    //   冰封档也可以用老的 engage.quiet.chats 指定（启动即映射，不清空）。
    levels: [
      { name: '冰封', rate: 0, missCap: 0, organizeOnly: true },
      { name: '保守', rate: 0.25, missCap: 0, organizeOnly: false },
      { name: '标准', rate: 0.6, missCap: 0, organizeOnly: false },
      { name: '活跃', rate: 0.85, missCap: 0, organizeOnly: false },
      { name: '全开', rate: 1, missCap: 0, organizeOnly: false }
    ],
    levelByChat: {},
    // 客观信号（发言占比 / 被点名率 / 提问密度 / 时段 / 日成本 / 连续未接）
    // enabled=false → 只采集不参与判定（默认）。启用后做乘法修正，下限 floor。
    signals: { enabled: false, floor: 0.15 }
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：orchestrator.js —— import 档位与采集模块
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', SRC, 'orchestrator.js',
`import { isQuietChat, quietIntervalMs, quietHint } from './quiet-mode.js';`,
`import { isQuietChat, quietIntervalMs, quietHint } from './quiet-mode.js';
// 发言档位 + 客观采集（[qqagent-level-patch:orchestrator-import]）
import { paramsFor, rollParticipation, levelHint } from './engage-level.js';
import { record as recordEngage } from './engage-metrics.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：orchestrator.js —— 浏览拍前插参与率判定
// ─────────────────────────────────────────────────────────────────────────────
patch('browse-tick-gate', SRC, 'orchestrator.js',
`      if (unread <= 0) continue;   // 没人发言 → 不调 LLM
      // 记在 wake 之前：闸门过了才算这一拍已经给过它，同一批不再重复补拍。`,
`      if (unread <= 0) continue;   // 没人发言 → 不调 LLM
      // ── 发言档位：参与率判定（[qqagent-level-patch:browse-tick-gate]）──
      // 有未读、到点，还要过一道"这一拍要不要入场"。未命中时**不 wake、不推进已读、
      // 不记静默补拍** —— 这批消息留在未读里等下一拍，内容一条不丢。
      // 位置必须在 markIdleFired / logger.info 之前：那两行都宣告"这批已经给过它了"。
      if (!quiet) {
        const p = paramsFor(chatKey);
        const r = rollParticipation(chatKey);
        try {
          recordEngage({ chat: chatKey, event: 'roll', level: p.level, rate: p.rate, roll: r.roll, hit: r.participate, unread, idle });
        } catch { /* 采集是旁路 */ }
        if (!r.participate) {
          logger.info('engage', chatKey + ' 参与判定未命中（档 ' + p.level + '/' + p.levelCount
            + ' · 入场率 ' + Math.round(p.rate * 100) + '%）—— ' + unread + ' 条留存，等下一拍');
          continue;
        }
      }
      // 记在 wake 之前：闸门过了才算这一拍已经给过它，同一批不再重复补拍。`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：orchestrator.js —— 档位提示段（替换安静模式段：冰封档文案内置）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-hint-def', SRC, 'orchestrator.js',
`    const quietLine = (() => {
      try { return quietHint(chatKey); } catch { return ''; }
    })();`,
`    const quietLine = (() => {
      try { return quietHint(chatKey); } catch { return ''; }
    })();
    // 发言档位提示（[qqagent-level-patch:orchestrator-hint-def]）—— 与配额同段：
    // 冰封档文案由 levelHint 给（与 quietHint 同义，保留其一即可，取并集无害）。
    const levelLine = (() => {
      try { return quietHint(chatKey) ? '' : levelHint(chatKey); } catch { return ''; }
    })();`);

patch('orchestrator-hint-append', SRC, 'orchestrator.js',
`        : userPrompt) + quotaLine + chatterHint + browseLine + quietLine   // [qqagent-quiet-patch:orchestrator-hint-append]`,
`        : userPrompt) + quotaLine + chatterHint + browseLine + quietLine + levelLine   // [qqagent-quiet-patch:orchestrator-hint-append] [qqagent-level-patch:orchestrator-hint-append]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：rapport.js —— "没人接话"降分按档位封顶
// ─────────────────────────────────────────────────────────────────────────────
patch('rapport-import', SRC, 'rapport.js',
`import { logger } from './logger.js';`,
`import { logger } from './logger.js';
// 档位对降分设上限（[qqagent-level-patch:rapport-import]）
import { paramsFor } from './engage-level.js';`);

patch('rapport-miss-cap', SRC, 'rapport.js',
`  const delta = hit ? rule.watch.hitDelta : -rule.watch.missDelta;`,
`  // 档位封顶（[qqagent-level-patch:rapport-miss-cap]）：客观结算降级为**只采集**——
  // "没人接话"在闲聊群里是常态（实测一个周期 1557 条里 @ 我的只 13 条），
  // 拿它扣分等于系统性误判。现在判定与日志照跑，扣分量由 missCap 决定（默认 0 = 不扣）。
  // 模型手调 adjust_rapport 与自愈照常，maxCooldownMs 保留为兜底。
  let missDelta = rule.watch.missDelta;
  try { missDelta = Math.min(missDelta, paramsFor(chatKey).missCap); } catch { /* 档位不可用 → 用配置值 */ }
  const delta = hit ? rule.watch.hitDelta : -missDelta;`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：sender.js —— 出站闸拦截落采集（补观测盲区）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-import', SRC, 'sender.js',
`import { getScore, cooldownForScore, rapportRule } from './rapport.js';`,
`import { getScore, cooldownForScore, rapportRule } from './rapport.js';
// 出站闸拦截落采集（[qqagent-level-patch:sender-import]）——补"被拦了但不留痕"的盲区
import { record as recordEngage } from './engage-metrics.js';
import { paramsFor } from './engage-level.js';

/** 记一条拦截事件（采集是旁路，失败不影响发送判定）。 */
function noteBlocked(chatKey, gate, message) {
  try {
    recordEngage({ chat: String(chatKey), event: 'blocked', gate: String(gate), why: String(message || '').slice(0, 120), level: paramsFor(chatKey).level });
  } catch { /* 采集是旁路 */ }
}`);

patch('sender-gate-quota', SRC, 'sender.js',
`      if (times.length >= maxN) {
        throw new Error('发言配额已满（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN + ' 条），本轮不要再发消息');
      }`,
`      if (times.length >= maxN) {
        // [qqagent-level-patch:sender-gate-quota]
        noteBlocked(chatKey, 'quota', '最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN + ' 条');
        throw new Error('发言配额已满（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN + ' 条），本轮不要再发消息');
      }`);

patch('sender-gate-hard', SRC, 'sender.js',
`      if (times.length >= maxN) {
        const wait = Math.max(1, Math.ceil((winMs - (now - Math.min(...times))) / 1000));
        throw new Error('发言硬限制（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN`,
`      if (times.length >= maxN) {
        const wait = Math.max(1, Math.ceil((winMs - (now - Math.min(...times))) / 1000));
        noteBlocked(chatKey, 'hardLimit', '最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN);   // [qqagent-level-patch:sender-gate-hard]
        throw new Error('发言硬限制（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  points: results
}, null, 2));
