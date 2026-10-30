// 安静模式 —— 按群的"能不发言就不发言"档（记忆页「🤫 安静」开关）。
// [qqagent-quiet-patch:quiet-mode]
//
// 语义（Rushiera 2026-10-16 口述规格）：
//   · 处于安静模式的群不参与闲聊 —— 非 @ 消息只入库，不进 LLM；
//   · 被 @ / 拍一拍 点名 → 立即触发，走普通轮（可发言，"被 @ 了要能回"）；
//   · 每 intervalMs（默认 6 小时）跑一次"只整理不发言"的记忆沉淀轮 ——
//     节拍拉长到该间隔，到点强制走收工轮语义（发送类工具移除 + 记忆沉淀 + 归档）；
//   · 存档和记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
//
// 为什么拉长节拍而不是"关掉一切"：整理轮需要"到点看一眼"这个触发源；
// 关掉节拍等于连记忆沉淀都没有了，群就真成了哑巴（与"存档和记忆不受影响"相悖）。
//
// 状态是**配置态**（落 config.engage.quiet.chats），非运行时短期态。
import { getConfig } from './config.js';

const FALLBACK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 小时

function quietCfg() {
  return getConfig().engage?.quiet || {};
}

/** 安静模式总开关（配置缺失 = 开；enabled=false 完全关闭，按群清单保留）。 */
export function quietEnabled() {
  return quietCfg().enabled !== false;
}

/** 处于安静模式的群号清单（字符串）。开关关闭 → 空数组。 */
export function quietChats() {
  if (!quietEnabled()) return [];
  const raw = quietCfg().chats;
  return (Array.isArray(raw) ? raw : []).map((v) => String(v).trim()).filter(Boolean);
}

/** 该会话是否处于安静模式（仅群聊有意义；私聊恒 false）。 */
export function isQuietChat(chatKey) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return false;
  const id = key.split(':')[1] || '';
  if (!id) return false;
  if (quietChats().includes(String(id))) return true;
  // 档位别名（[qqagent-level-patch:quiet-alias]）：levelByChat 指定 1 = 冰封档，
  // 与老 quiet.chats 同义。两处任一命中即视为安静群，老配置无需迁移。
  try {
    const map = getConfig().engage?.levelByChat || {};
    if (map[id] != null && Math.round(Number(map[id])) === 1) return true;
  } catch { /* 配置不可用 → 只认 quiet.chats */ }
  return false;
}

/** 安静模式的整理节拍（毫秒；默认 6 小时）。 */
export function quietIntervalMs() {
  const n = Number(quietCfg().intervalMs);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_INTERVAL_MS;
}

/**
 * 【安静模式】提示词段（群聊且处于安静模式时注入；否则空串）。
 * 与【发言配额】同段：都是本轮动态状态，追加在用户消息末尾（不打断缓存前缀）。
 */
export function quietHint(chatKey) {
  if (!isQuietChat(chatKey)) return '';
  const hours = Math.round(quietIntervalMs() / 3600000 * 10) / 10;
  return '\n\n【安静模式】本群处于安静模式：默认不参与闲聊，只有被 @ / 拍一拍 点名时才回应；'
    + '系统每 ' + hours + ' 小时做一次"只整理不发言"的记忆沉淀（存档与记忆照常）。'
    + '被点名时正常回应即可，其余时候安静看就好。';
}
