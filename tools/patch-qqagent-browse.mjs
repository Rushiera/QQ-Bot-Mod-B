// patch-qqagent-browse.mjs — QQ Agent v0.4.0「浏览节拍」幂等补丁
//
// 用法：node patch-qqagent-browse.mjs [--dry]
// 做什么：把「不再每条消息立刻唤醒 LLM」的浏览节拍落进 _unpack 源码
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑全部补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-browse-patch:<id>]；已含标记 = 跳过
// 依赖：**先跑 patch-qqagent-engage.mjs**（本补丁一个锚点落在它的产物上）
// 边界：不动安全边界 / Electron 壳 / 发送队列结构；不动配额与硬限（发言限制不变）
//
// 设计要点（Rushiera 2026-10-10 口述规格）：
//   1. 节拍浏览：默认每 4 分钟看一次该群未读 → 有新增才调 LLM，一次把这段时间的
//      全部内容（含图片/媒体，工具该读的读）交给模型 → 模型自己决定接不接。
//      无新增 → 什么都不做（不调 LLM）。
//   2. @ / 拍一拍例外：立即读，不等节拍（提示词标明"点名找你，要回应"）。
//   3. 热点升级：模型可用 set_browse_rate 把节拍升到 120 / 60 秒。
//   4. 回落：升档只在 holdMs（15 分钟）内有效，期间该群有成功发言即顺延，
//      到期自动降一档。不用"群里静默"做信号——热群里消息停不下来，静默永不触发。
//   5. 运行结束一律回节拍（含撞配额墙）——不排 drain 连跑，否则又变回"每条都回"。
//   6. 发言配额 / 硬限 / 热度 / bot 限频 全部不动；提示词加"节拍快更要省额度"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-browse-patch:' + id + ']';

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
// 补丁 1：新增 src/browse-rate.js —— 浏览节拍档位的运行时状态
// ─────────────────────────────────────────────────────────────────────────────
const BROWSE_RATE_JS = `// 浏览节拍 —— 群内自主参与的"多久看一次"档位。
// [qqagent-browse-patch:browse-rate]
//
// 语义（Rushiera 2026-10-10 口述规格）：机器人不再"每条消息立刻进 LLM"，而是按
// 节拍浏览群内容 —— 到点看一次该群未读，有新增才调 LLM，一次把这段时间的全部
// 内容交给模型，由模型自己决定接不接、接哪条。
//
// 档位：1 = 每 4 分钟（基础）· 2 = 每 2 分钟 · 3 = 每 1 分钟。
// 模型可自行升档（工具 set_browse_rate）；@ / 拍一拍走立即触发，不受节拍约束。
//
// 回落：升档只在 holdMs 内有效，期间该群有任何一次成功发言即顺延
// （"还在参与" = 这波热度对它有价值）；到期自动降一档。
// 为什么不用"群里静默"做回落信号 —— 热群里消息停不下来，静默永不触发，
// 升上去就下不来；参与度才是可靠信号。
//
// 状态是**运行时短期态**（不落盘）：重启回基础档 —— 少看少说是安全的失败方向。
import { getConfig, commandMuteTier } from './config.js';

const FALLBACK_LEVELS = [240000, 120000, 60000];
const FALLBACK_HOLD_MS = 900000;
const state = new Map();   // chatKey -> { level: 0-based, expiresAt }

function browseCfg() {
  return getConfig().engage?.browse || {};
}

/** 节拍是否开启（配置缺失 = 开启；enabled=false 回旧行为）。 */
export function browseEnabled() {
  return browseCfg().enabled !== false;
}

function levels() {
  const raw = browseCfg().levels;
  const arr = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  return arr.length >= 2 ? arr : FALLBACK_LEVELS;
}

function holdMs() {
  const n = Number(browseCfg().holdMs);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_HOLD_MS;
}

/** 指令禁言期内不走节拍（回 1 档语义：只有 @ 才进 LLM）。 */
export function browseMuted(chatKey) {
  try { return commandMuteTier(chatKey) !== null; } catch { return false; }
}

/** 该群当前的浏览间隔（毫秒）。未升档 = 基础档。 */
export function browseIntervalMs(chatKey) {
  const arr = levels();
  const lv = state.get(String(chatKey))?.level ?? 0;
  return arr[Math.min(arr.length - 1, Math.max(0, lv))];
}

/** 当前档位状态（供提示词与工具回执渲染）。level 对外为 1-based。 */
export function browseState(chatKey) {
  const arr = levels();
  const st = state.get(String(chatKey));
  const level = st ? Math.min(arr.length - 1, Math.max(0, st.level)) : 0;
  return {
    level: level + 1,
    levelCount: arr.length,
    intervalMs: arr[level],
    baseIntervalMs: arr[0],
    raised: level > 0,
    expiresAt: st?.expiresAt ?? null,
    holdMs: holdMs()
  };
}

/** 设定档位（1-based；越界钳到范围内）并重新起算有效期。 */
export function setBrowseLevel(chatKey, level) {
  const arr = levels();
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round(Number(level) || 1) - 1));
  // 基础档不设有效期 —— "有效期"只对升过的档有意义，留着会让人误读成"还会降"。
  state.set(String(chatKey), { level: idx, expiresAt: idx > 0 ? Date.now() + holdMs() : 0 });
  return browseState(chatKey);
}

/** 发言续期：该群有成功发言 → 已升的档顺延有效期（基础档不动）。 */
export function holdBrowse(chatKey) {
  const st = state.get(String(chatKey));
  if (!st || st.level <= 0) return;
  st.expiresAt = Date.now() + holdMs();
}

/** 到期降一档（每拍调用一次）。返回 { changed, state }。 */
export function decayBrowse(chatKey, now = Date.now()) {
  const st = state.get(String(chatKey));
  if (!st || st.level <= 0) return { changed: false, state: browseState(chatKey) };
  if (Number(st.expiresAt) > now) return { changed: false, state: browseState(chatKey) };
  st.level -= 1;
  st.expiresAt = st.level > 0 ? now + holdMs() : 0;
  return { changed: true, state: browseState(chatKey) };
}

// ── 静默补拍（[qqagent-browse-patch:browse-rate-idle]）────────────────────────
// 语义（Rushiera 2026-10-11 追加）：有未读、且**最后一条未读已静默 idleMs**
// （默认 60 秒）没人接话 —— 也看一次。话头停下来了正是能接的时候，不必等满一拍。
// 同样不要求模型必须回复：看完不回是正常结束（与到点浏览拍同语义）。
//
// 同一批只补一拍：记下已补过的"最后一条未读 ts"，新消息到来（ts 变化）才可再补。
// 状态同档位一样是运行时短期态（不落盘）——重启后由节拍巡检自然接管。
const FALLBACK_IDLE_MS = 60000;
const idleFired = new Map();   // chatKey -> 已静默补拍过的最后一条未读 ts

/** 静默补拍阈值（毫秒；0 / false = 关闭）。 */
export function idleTriggerMs() {
  const raw = browseCfg().idleMs;
  if (raw === false || raw === 0) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_IDLE_MS;
}

/**
 * 静默补拍判定（纯判定，不改状态）：该批是否该补一拍。
 * @param {string} chatKey
 * @param {number} lastUnreadTs 最后一条未读消息的时间戳（0 = 无未读）
 * @param {number} now
 */
export function idleFireDue(chatKey, lastUnreadTs, now = Date.now()) {
  const ms = idleTriggerMs();
  if (!ms) return false;
  const ts = Number(lastUnreadTs) || 0;
  if (ts <= 0) return false;
  if (now - ts < ms) return false;
  return idleFired.get(String(chatKey)) !== ts;
}

/** 记下静默补拍已对该批生效（同一批不重复补拍）。 */
export function markIdleFired(chatKey, lastUnreadTs) {
  idleFired.set(String(chatKey), Number(lastUnreadTs) || 0);
}

/**
 * 【群节奏】提示词段（群聊专用；节拍关闭 / 私聊返回空串）。
 * 与【发言配额】同段：都是本轮动态状态，追加在用户消息末尾，不打断缓存前缀。
 * 升档时点明"额度没变、越热越要省" —— 节拍快 ≠ 能多说。
 */
export function browseHint(chatKey, { atMe = false } = {}) {
  if (!browseEnabled() || !String(chatKey).startsWith('group:')) return '';
  const s = browseState(chatKey);
  const sec = Math.round(s.intervalMs / 1000);
  const lines = [];
  if (!s.raised) {
    lines.push('【群节奏】本群每 ' + sec + ' 秒看一次（档位 ' + s.level + '/' + s.levelCount
      + '，基础节拍）。这一拍攒下的消息都在上面 —— 看完自己决定说不说，不用每条都接。');
  } else {
    const leftMin = Math.max(0, Math.round((Number(s.expiresAt) - Date.now()) / 60000));
    lines.push('【群节奏】本群每 ' + sec + ' 秒看一次（档位 ' + s.level + '/' + s.levelCount
      + '，你自己调快的，约 ' + leftMin + ' 分钟后自动降回来）。节拍快 = 群里正热，'
      + '但你的发言额度没变 —— 越热越要省着说：一次把话说完就会撞上配额墙，宁可少说、留着后面接。');
  }
  if (atMe) lines.push('这一拍里有 @ 你 / 拍了拍你的消息 —— 那是点名找你，要回应。');
  return '\\n\\n' + lines.join('\\n');
}
`;

addFile('browse-rate', 'browse-rate.js', BROWSE_RATE_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：config.js —— engage.browse 配置块（节拍开关 / 档位表 / 有效期）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-browse', 'config.js', `    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true },`, `    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true },
    // ── 浏览节拍（2026-10-10）── [qqagent-browse-patch:config-browse]
    // 语义：不再"每条消息立刻进 LLM"，而是按节拍浏览群内容 —— 到点看一次该群未读，
    //   有新增才调 LLM，一次把这段时间的全部内容交给模型（含图片/媒体，工具该读的读），
    //   由模型自己决定接不接。从根本上避开"有人说话就要接"的尬聊。
    //   @ / 拍一拍 立即触发（atMeImmediate）；私聊不走节拍（privateImmediate）。
    //   levels：档位表（毫秒），索引 0 = 基础档；模型可用 set_browse_rate 升档。
    //   holdMs：升档有效期 —— 期间该群有成功发言即顺延，到期自动降一档。
    //     （不用"群里静默"做回落信号：热群里消息停不下来，静默永不触发。）
    //   sweepMs：巡检粒度（一个定时器扫全部群，档位变化即时生效）。
    //   enabled=false → 完全回到旧行为（逐条判定 + 立即触发）。
    browse: {
      enabled: true,
      levels: [240000, 120000, 60000],
      holdMs: 900000,
      atMeImmediate: true,
      privateImmediate: true,
      sweepMs: 5000
    },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：config.js —— 节拍模式下档位统一按 4 档（全响应）
// ─────────────────────────────────────────────────────────────────────────────
// 触发权在节拍本身（到点看一次，有新增就进 LLM），档位不再参与触发判定。
// 不做这个覆盖的话：浏览拍走"机械批"路径会被 1~3 档判成"未触发"整批归档，
// 表现就是"节拍到点了却不理人"。指令禁言（上面的 early return）优先，不受影响。
patch('config-tier', 'config.js', `  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;`, `  // ── 浏览节拍（[qqagent-browse-patch:config-tier]）──
  // 节拍模式下触发权在节拍本身，档位不再参与触发判定 → 统一按 4 档（全响应）呈现，
  // 避免浏览拍被档位判成"未触发"而整批归档。指令禁言已在上面 early return，优先。
  if (getConfig().engage?.browse?.enabled !== false) {
    return { ...store, contextTier: 4, randomPercent: 100 };
  }
  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：orchestrator.js —— import 节拍模块
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', 'orchestrator.js', `import { formatChatterHint } from './chatter.js';`, `import { formatChatterHint } from './chatter.js';
// 浏览节拍（到点看一次，有新增才进 LLM）——[qqagent-browse-patch:orchestrator-import]
import {
  browseEnabled, browseMuted, browseIntervalMs, browseHint, decayBrowse
} from './browse-rate.js';
// 节拍巡检的诊断必须能进日志文件 —— console 在 GUI 外壳（无控制台窗口）里看不见，
// 巡检抛错会被 setInterval 的 catch 吞成"静默不工作"（判例：缺 decayBrowse 导入）。
// [qqagent-browse-patch:orchestrator-logger-import]
import { logger } from './logger.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：orchestrator.js —— 构造函数加节拍巡检字段
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-ctor', 'orchestrator.js', `    // 限流（429）长轮询计数：chatKey -> 已轮询次数。[qqagent-session-patch:orchestrator-ctor]
    this.rateLimitRetries = new Map();`, `    // 限流（429）长轮询计数：chatKey -> 已轮询次数。[qqagent-session-patch:orchestrator-ctor]
    this.rateLimitRetries = new Map();
    // ── 浏览节拍（[qqagent-browse-patch:orchestrator-ctor]）──
    // 消息不再逐条唤醒：由全局巡检到点扫一遍，有新增才进 LLM。
    this.browseSweepTimer = null;    // 全局巡检句柄（一个定时器扫全部群）
    this.browseNextAt = new Map();   // chatKey -> 下一拍时间戳`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：orchestrator.js —— onIncoming 走节拍（@ / 私聊例外立即触发）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-onincoming', 'orchestrator.js', `    const cfg = getConfig();
    // 前置条件（与 wake 的闸门同口径，在这里提前拦截可以少建一次定时器）：`, `    // ── 浏览节拍（[qqagent-browse-patch:orchestrator-onincoming]）──
    // 节拍模式下不再"逐条判定 + 立即唤醒"：消息只入库（保持未读），等节拍到点
    // 一次性交给模型。例外（立即触发，不等节拍）：私聊（1v1 本来就是发给它的）、
    // 被 @ / 拍了拍（点名找你）。指令禁言期内不走节拍 —— 回 1 档语义。
    if (browseEnabled() && !browseMuted(chatKey)) {
      this.#ensureBrowseLoop();
      const isPrivate = String(chatKey).startsWith('private:');
      const browseCfg = getConfig().engage?.browse || {};
      const atMe = entry ? entry.atMe === true : false;
      const pokeMe = entry ? entry.isPoke === true : false;
      const immediate = (isPrivate && browseCfg.privateImmediate !== false)
        || (!isPrivate && browseCfg.atMeImmediate !== false && (atMe || pokeMe));
      if (!immediate) {
        this.#noteBrowsePending(chatKey);
        return;
      }
    }

    const cfg = getConfig();
    // 前置条件（与 wake 的闸门同口径，在这里提前拦截可以少建一次定时器）：`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：orchestrator.js —— 节拍巡检方法（插在禁言缓存字段之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-methods', 'orchestrator.js', `  #muteCache = new Map();   // chatKey -> { muted: boolean, checkedAt: number }`, `  // ── 浏览节拍调度（[qqagent-browse-patch:orchestrator-methods]）──────────────────
  // 节拍模式：消息只入库，由这里到点唤醒 —— 有新增才调 LLM，没新增什么都不做。
  // 用**全局巡检**（一个定时器扫全部群）而不是每群一个定时器：档位变化即时生效、
  // 停止时一处清理，群数少时扫描成本可忽略。
  #ensureBrowseLoop() {
    if (this.browseSweepTimer) return;
    if (!browseEnabled()) return;
    // 启动 / 恢复时把已有未读的群纳入节拍 —— 否则积压要等下一条消息才被看见。
    try {
      for (const chatKey of this.store.listChats()) {
        if (this.store.unreadCount(chatKey) > 0) this.#noteBrowsePending(chatKey);
      }
    } catch { /* store 不支持这两个查询时跳过（自测桩子） */ }
    const every = Math.max(2000, Number(getConfig().engage?.browse?.sweepMs) || 5000);
    this.browseSweepTimer = setInterval(() => {
      try { this.#browseTick(); } catch (e) { logger.error('browse', '节拍巡检出错：' + (e?.message ?? e)); }
    }, every);
    this.browseSweepTimer.unref?.();
  }

  /** 启动浏览节拍巡检（启动流程调用；幂等 —— 已有句柄时直接返回）。 */
  startBrowseLoop() {
    this.#ensureBrowseLoop();
  }

  /** 记下该群下一拍的时间点（force=true 重设相位 —— 运行结束回节拍用）。 */
  #noteBrowsePending(chatKey, force = false) {
    if (!browseEnabled()) return;
    if (force || !this.browseNextAt.has(chatKey)) {
      this.browseNextAt.set(chatKey, Date.now() + browseIntervalMs(chatKey));
    }
  }

  /** 到点扫一遍：该看的群看，没新增就什么都不做（零 token）。 */
  #browseTick() {
    if (!browseEnabled() || this.paused || this.aborted) return;
    const now = Date.now();
    for (const chatKey of [...this.browseNextAt.keys()]) {
      // 升档有效期到期 → 降一档，并按新节拍重排（本拍不顺延处理）。
      const decay = decayBrowse(chatKey, now);
      if (decay.changed) {
        const ms = browseIntervalMs(chatKey);
        this.browseNextAt.set(chatKey, now + ms);
        logger.info('browse', chatKey + ' 节拍到期降档 → 每 ' + Math.round(ms / 1000) + ' 秒');
        continue;
      }
      if (now < (Number(this.browseNextAt.get(chatKey)) || 0)) continue;
      this.browseNextAt.set(chatKey, now + browseIntervalMs(chatKey));
      if (this.runningChats.has(chatKey) || this.pendingWake.has(chatKey)) continue;
      if (browseMuted(chatKey)) continue;
      let unread = 0;
      try { unread = this.store.unreadCount(chatKey); } catch { unread = 0; }
      if (unread <= 0) continue;   // 没人发言 → 不调 LLM
      logger.info('browse', chatKey + ' 浏览拍：' + unread + ' 条新内容进 LLM（节拍 '
        + Math.round(browseIntervalMs(chatKey) / 1000) + ' 秒）');
      this.wake(chatKey, {})
        .catch((error) => console.error('[orchestrator] 浏览拍 wake 出错:', error));
    }
  }

  #muteCache = new Map();   // chatKey -> { muted: boolean, checkedAt: number }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：orchestrator.js —— 运行结束回节拍（不排 drain 连跑）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-drain', 'orchestrator.js', `    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }`, `    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    // 节拍模式下改为"回节拍"：本轮结束（含撞配额墙、模型选择沉默）一律等下
    // 一拍再统一看 —— 排 drain 连跑会让连续对话又变回"每条都回"。
    // [qqagent-browse-patch:orchestrator-drain]
    if (!this.aborted && !this.paused) {
      if (browseEnabled()) {
        this.#ensureBrowseLoop();
        this.#noteBrowsePending(chatKey, true);
      } else {
        const unread = this.store.unreadCount(chatKey);
        if (unread > 0) {
          const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
          this.scheduleWake(chatKey, drainDelay);
        }
      }
    }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：orchestrator.js —— 恢复积压也按节拍处理
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-backlog', 'orchestrator.js', `  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }`, `  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) {
        // 节拍模式：积压也按节拍处理（到点统一看），不立即唤醒。
        // [qqagent-browse-patch:orchestrator-backlog]
        if (browseEnabled()) {
          this.#ensureBrowseLoop();
          this.#noteBrowsePending(chatKey, true);
        } else {
          this.scheduleWake(chatKey, 0);
        }
      }
    }
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10：orchestrator.js —— abortAll 停掉节拍巡检
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-abortall', 'orchestrator.js', `    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();`, `    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    // 浏览节拍巡检停掉（[qqagent-browse-patch:orchestrator-abortall]）
    if (this.browseSweepTimer) { clearInterval(this.browseSweepTimer); this.browseSweepTimer = null; }
    this.browseNextAt.clear();
    this.stopProactiveLoop();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 11：orchestrator.js —— 【群节奏】提示词段
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-hint-def', 'orchestrator.js', `    // 发言热度提示（[qqagent-engage-patch:orchestrator-chatter-def]）—— 与配额同段：`, `    // 浏览节拍提示（[qqagent-browse-patch:orchestrator-hint-def]）—— 与配额同段：
    // 都是"本轮动态状态"，追加在用户消息末尾（不打断缓存前缀）。
    // 升档时强调"额度没变、越热越要省着说" —— 节拍快 ≠ 能多说。
    const browseLine = (() => {
      try {
        return browseHint(chatKey, {
          atMe: (triggerEntries || []).some((m) => m
            && (m.atMe === true || (m.isPoke && /拍了拍\\s*我/.test(String(m.text ?? '')))))
        });
      } catch { return ''; }
    })();
    // 发言热度提示（[qqagent-engage-patch:orchestrator-chatter-def]）—— 与配额同段：`);

patch('orchestrator-hint-append', 'orchestrator.js', `        : userPrompt) + quotaLine + chatterHint`, `        : userPrompt) + quotaLine + chatterHint + browseLine`, 1, `        : userPrompt) + quotaLine + chatterHint + browseLine`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 12：tools.js —— 新增工具 set_browse_rate（模型自行升/降节拍）
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', 'tools.js', `import { registerTool, listTools } from './tool-registry.js';`, `import { registerTool, listTools } from './tool-registry.js';
// 浏览节拍（模型自行调整"多久看一次"）——[qqagent-browse-patch:tools-import]
import { setBrowseLevel, browseState } from './browse-rate.js';`);

patch('tools-register', 'tools.js', `  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();`, `  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();

  // ── 浏览节拍调整（[qqagent-browse-patch:tools-register]）──
  // 节拍 = "你多久收到一次新消息"。群里正聊得热、你判断要跟紧一点就升档；
  // 升档只在有效期内有效（期间你在本群说过话就自动续期），不说话自己降回来。
  // ⚠️ 描述里点明"节拍快不等于能多说" —— 发言额度是固定的，越热越要省着说。
  registerTool({
    id: 'set_browse_rate',
    name: '调整浏览节拍',
    description: '调整本群"多久看一次新消息"的节拍。1=每4分钟（默认，慢）2=每2分钟 3=每1分钟（快）。'
      + '群里正聊得热、你判断需要跟紧一点就升档；冷下来不用管，约 15 分钟不参与就自动降回来。'
      + '⚠️ 节拍调快**不会**放宽你的发言额度 —— 反而更要省着说：额度是固定的，一次把话说完就会撞上配额墙，宁可少说、留着后面接。',
    category: 'system',
    icon: '⏱️',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'integer', description: '节拍档位：1=每4分钟 2=每2分钟 3=每1分钟' }
      },
      required: ['level']
    },
    async execute(ctx, args) {
      try {
        if (!String(ctx.chatKey || '').startsWith('group:')) {
          return err('私聊不受浏览节拍影响（消息随时处理），本工具只对群聊有意义。');
        }
        const level = Number(args.level);
        if (!Number.isFinite(level) || level < 1) return err('level 必须是 1 / 2 / 3');
        const st = setBrowseLevel(ctx.chatKey, level);
        return ok({
          level: st.level,
          levelCount: st.levelCount,
          intervalSeconds: Math.round(st.intervalMs / 1000),
          holdMinutes: Math.round(st.holdMs / 60000),
          note: '节拍已更新。不要向群里说"我调了节拍"这类话，正常聊天即可。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 13：sender.js —— 放行即续期（"还在参与" = 这波热度对它有价值）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-import', 'sender.js', `import { mdToPlain, splitForQQ } from './md-to-plain.js';`, `import { mdToPlain, splitForQQ } from './md-to-plain.js';
// 浏览节拍续期（发言即视为还在参与）——[qqagent-browse-patch:sender-import]
import { holdBrowse } from './browse-rate.js';`);

patch('sender-hold', 'sender.js', `    // [qqagent-talkstyle-patch:sender-lastsent] 放行即记（抛错路径不经过这里）
    this.lastSentAt.set(chatKey, now);`, `    // [qqagent-talkstyle-patch:sender-lastsent] 放行即记（抛错路径不经过这里）
    this.lastSentAt.set(chatKey, now);
    // [qqagent-browse-patch:sender-hold] 升过的节拍顺延有效期：在这个群还在说话
    // = 这波热度对它有价值；不说话了就让它自己降回去。撞配额墙的发送抛错在
    // 本行之前，不算"参与"（说太多不该维持高频看）。
    holdBrowse(chatKey);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 14：app.js —— 启动即起节拍巡检（把已有未读的群纳入节拍）
// ─────────────────────────────────────────────────────────────────────────────
// 不挂这一步的话，巡检只由"来新消息"拉起 —— 停机期间攒下的未读要等
// 该群再有人说话才被看见（判例：重启后 49 条未读挂着一动不动）。
patch('app-start', 'app.js', `    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒`, `    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒
    // 浏览节拍巡检：启动即起（把已有未读的群纳入节拍）——[qqagent-browse-patch:app-start]
    orchestrator.startBrowseLoop();`);

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 补丁 15：config.js —— 静默补拍阈值（有未读且静默 idleMs 没人接话 → 也看一次）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-browse-idle', 'config.js', `      atMeImmediate: true,
      privateImmediate: true,
      sweepMs: 5000
    },`, `      atMeImmediate: true,
      privateImmediate: true,
      sweepMs: 5000,
      // ── 静默补拍（2026-10-11）── [qqagent-browse-patch:config-browse-idle]
      // 语义：有未读、且最后一条未读已静默 idleMs（默认 60 秒）没人接话 → 也看一次。
      //   话头停下来了正是能接的时候，不必等满一拍；同一批只补一拍（有新消息才重置）。
      //   同样不要求模型必须回复 —— 看完不回是正常结束。
      //   0 / false = 关闭（只按节拍到点看）。
      idleMs: 60000
    },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 16：store.js —— lastUnreadTs（静默补拍要知道"最后一条未读多久了"）
// ─────────────────────────────────────────────────────────────────────────────
patch('store-lastunread', 'store.js', `  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }`, `  /**
   * 最后一条未读消息的时间戳（无未读 → 0）。[qqagent-browse-patch:store-lastunread]
   * 静默补拍用：最后一条未读已静默 N 秒（没人接话）→ 提前看一次。
   */
  lastUnreadTs(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const last = unread[unread.length - 1];
    return last ? (Number(last.ts) || 0) : 0;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 17：orchestrator.js —— import 静默补拍（判定 + 记账）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import-idle', 'orchestrator.js', `import {
  browseEnabled, browseMuted, browseIntervalMs, browseHint, decayBrowse
} from './browse-rate.js';`, `import {
  browseEnabled, browseMuted, browseIntervalMs, browseHint, decayBrowse,
  // 静默补拍：最后一条未读静默 N 秒没人接话 → 也看一次
  // [qqagent-browse-patch:orchestrator-import-idle]
  idleFireDue, markIdleFired
} from './browse-rate.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 18：orchestrator.js —— 巡检加静默补拍分支
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-idle-tick', 'orchestrator.js', `      if (now < (Number(this.browseNextAt.get(chatKey)) || 0)) continue;
      this.browseNextAt.set(chatKey, now + browseIntervalMs(chatKey));
      if (this.runningChats.has(chatKey) || this.pendingWake.has(chatKey)) continue;
      if (browseMuted(chatKey)) continue;
      let unread = 0;
      try { unread = this.store.unreadCount(chatKey); } catch { unread = 0; }
      if (unread <= 0) continue;   // 没人发言 → 不调 LLM
      logger.info('browse', chatKey + ' 浏览拍：' + unread + ' 条新内容进 LLM（节拍 '
        + Math.round(browseIntervalMs(chatKey) / 1000) + ' 秒）');`, `      // ── 到点 or 静默补拍（[qqagent-browse-patch:orchestrator-idle-tick]）──
      // 静默补拍：有未读、且最后一条未读已静默 idleMs（默认 60 秒）没人接话 → 也看一次。
      // 话头停下来了正是能接的时候，不必等满一拍；同一批只补一拍（有新消息才重置）。
      // 同样不要求模型必须回复 —— 看完不回是正常结束（与到点浏览拍同语义）。
      const due = now >= (Number(this.browseNextAt.get(chatKey)) || 0);
      let lastUnreadTs = 0;
      if (!due) {
        try { lastUnreadTs = this.store.lastUnreadTs(chatKey); } catch { lastUnreadTs = 0; }
      }
      const idle = !due && idleFireDue(chatKey, lastUnreadTs, now);
      if (!due && !idle) continue;
      this.browseNextAt.set(chatKey, now + browseIntervalMs(chatKey));
      if (this.runningChats.has(chatKey) || this.pendingWake.has(chatKey)) continue;
      if (browseMuted(chatKey)) continue;
      let unread = 0;
      try { unread = this.store.unreadCount(chatKey); } catch { unread = 0; }
      if (unread <= 0) continue;   // 没人发言 → 不调 LLM
      // 记在 wake 之前：闸门过了才算这一拍已经给过它，同一批不再重复补拍。
      if (idle) markIdleFired(chatKey, lastUnreadTs);
      logger.info('browse', chatKey + (idle ? ' 静默补拍：' : ' 浏览拍：') + unread + ' 条新内容进 LLM（节拍 '
        + Math.round(browseIntervalMs(chatKey) / 1000) + ' 秒）');`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  points: results
}, null, 2));
