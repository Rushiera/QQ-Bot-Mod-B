// 浏览节拍 —— 群内自主参与的"多久看一次"档位。
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
  return '\n\n' + lines.join('\n');
}
