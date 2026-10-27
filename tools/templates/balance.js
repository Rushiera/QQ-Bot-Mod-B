// 群名片余额后缀（[qqbotb-balance:module] · 2026-10-25）
//
// 要解决的问题：群里要能一眼看到"这个号还剩多少"——把余额挂在本号的**群名片**尾部
// （群名片每群独立），开了后缀的群每 30 分钟自动刷一次。
//
// 为什么在宿主侧：开关与余额值都住在 config.engage.balance（记忆页写的），群名片是
// 群级状态、只能经 OneBot 改——宿主是唯一常驻进程，定时器放这里不必另起轮询面。
//
// 三个边界：
//   1 默认全关（chats 空）——只有记忆页按群打开，才动那个群的名片；
//   2 幂等——目标名片与现状一致就不发请求（避免每 30 分钟一次无意义写）；
//   3 失败出声——读名片 / 写名片失败都落 logger.warn，不静默吞掉。
import { getConfig } from './config.js';
import { logger } from './logger.js';

/** 缺省规则（config 缺字段时兜底；与 config.js 默认段同值）。 */
const DEFAULT_RULE = {
  value: 0,
  chats: [],
  source: 'manual',
  endpoint: '',
  field: 'balance',
  marker: '@余额',
  intervalMs: 1800000
};

/** 当前生效的余额规则（config 缺字段按缺省补；chats 一律字符串化）。 */
export function balanceRule() {
  const engage = getConfig().engage || {};
  const rule = { ...DEFAULT_RULE, ...(engage.balance || {}) };
  rule.chats = (Array.isArray(rule.chats) ? rule.chats : []).map(String);
  rule.marker = String(rule.marker || DEFAULT_RULE.marker);
  const ms = Number(rule.intervalMs);
  rule.intervalMs = Number.isFinite(ms) && ms >= 60000 ? ms : DEFAULT_RULE.intervalMs;
  return rule;
}

/**
 * 取当前余额（数值；NaN = 取不到）。
 * 🔴 映射接口（预留）：将来接自动来源只改这里——
 *   source='http'  → 请求 rule.endpoint，取 rule.field 字段；
 *   source='其它'  → 各自实现。
 * 现在只认 'manual'（记忆页人工输入）。未知来源**明确抛错**，不回落成 0——
 * 静默回落会把"没配置"伪装成"余额 0 元"。
 */
export async function resolveBalance(rule = balanceRule()) {
  const source = String(rule.source || 'manual').trim().toLowerCase();
  if (source === 'manual') return normalizeAmount(rule.value);
  throw new Error(`余额来源 ${source} 尚未实现（当前只支持 manual，映射接口见 resolveBalance()）`);
}

/** 规整成 0 及以上的两位小数（取不到返回 NaN）。 */
export function normalizeAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100) / 100;
}

/** 数值 → 'xx.xx'（非法值返回空串）。 */
export function formatAmount(n) {
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

/** 后缀本体：marker + 'xx.xx'。 */
export function balanceSuffix(rule, amount) {
  const txt = formatAmount(amount);
  return txt ? String(rule.marker || DEFAULT_RULE.marker) + txt : '';
}

/**
 * 剥掉名片尾部已有的「marker + 数字」（含数字后的残留空格）。
 * 只认**尾部**：名片中间出现「@余额」是名字本身的一部分，不动它。
 */
export function stripBalanceSuffix(card, marker) {
  const mk = String(marker || DEFAULT_RULE.marker);
  let text = String(card || '');
  for (;;) {
    const at = text.lastIndexOf(mk);
    if (at < 0) return text;
    const tail = text.slice(at + mk.length).trim();
    if (tail && !/^[0-9.]+$/.test(tail)) return text;     // 尾巴不是余额 → 原样返回
    const next = text.slice(0, at).replace(/\s+$/, '');
    if (next === text) return text;                       // 兜底：不再变化就收手（防死循环）
    text = next;
  }
}

/**
 * 算目标名片：剥旧后缀 → 拼新后缀。
 * 名片为空（本号在这个群没设过名片）时以昵称作底；昵称也空就只剩后缀。
 */
export function composeCard(currentCard, rule, amount, nickname = '') {
  const suffix = balanceSuffix(rule, amount);
  if (!suffix) return String(currentCard || '');
  const base = stripBalanceSuffix(currentCard, rule.marker)
    || stripBalanceSuffix(nickname, rule.marker)
    || '';
  return base ? base + suffix : suffix;
}

/** 上一轮已确认的名片（gid → { key, card }）——key 含余额值与标记，变了才重算。 */
const applied = new Map();

/** 读本号在某群的当前名片：'' = 没设名片 · null = 读失败。 */
async function readOwnCard(onebot, groupId, userId) {
  try {
    const data = await onebot.call('get_group_member_info', { group_id: groupId, user_id: userId });
    return data && data.card != null ? String(data.card) : '';
  } catch (e) {
    logger.warn('balance', `读群 ${groupId} 名片失败：${e?.message ?? e}`);
    return null;
  }
}

/**
 * 刷一个群的群名片（set_group_card 改本号自己）。
 * 返回 { ok, chat, card, amount, skipped?, reason?, error? }。
 */
export async function syncChatCard(onebot, groupId, options = {}) {
  const rule = balanceRule();
  const gid = String(groupId || '').trim();
  if (!gid) return { ok: false, reason: 'no-chat' };
  if (!onebot || !onebot.connected) return { ok: false, chat: gid, reason: 'offline' };
  const userId = onebot.selfId;
  if (!userId) return { ok: false, chat: gid, reason: 'no-self' };
  let amount;
  try {
    amount = await resolveBalance(rule);
  } catch (e) {
    logger.warn('balance', '余额取数失败：' + (e?.message ?? e));
    return { ok: false, chat: gid, reason: 'no-value' };
  }
  if (!Number.isFinite(amount)) return { ok: false, chat: gid, reason: 'no-value' };
  // 「值未变不改写」（Rushiera 2026-10-27）：手动来源下余额是常量——上一轮写上去的串没变，
  // 本轮整轮跳过，连 get_group_member_info 都不发。定时器的对外请求降为「真有变化时」。
  const cacheKey = amount + '|' + String(rule.marker || '');
  const cached = applied.get(gid);
  if (!options.force && cached && cached.key === cacheKey) {
    return { ok: true, chat: gid, skipped: true, reason: 'unchanged', card: cached.card, amount };
  }
  const current = await readOwnCard(onebot, gid, userId);
  if (current === null) return { ok: false, chat: gid, reason: 'read-failed' };
  const next = composeCard(current, rule, amount, onebot.selfNickname);
  if (next === current) {
    applied.set(gid, { key: cacheKey, card: next });
    return { ok: true, chat: gid, skipped: true, card: next, amount };
  }
  try {
    await onebot.call('set_group_card', { group_id: gid, user_id: userId, card: next });
  } catch (e) {
    logger.warn('balance', `写群 ${gid} 名片失败：${e?.message ?? e}`);
    return { ok: false, chat: gid, reason: 'write-failed', error: String(e?.message ?? e) };
  }
  applied.set(gid, { key: cacheKey, card: next });
  logger.info('balance', `群 ${gid} 名片后缀已更新：${next}`);
  return { ok: true, chat: gid, card: next, amount, previous: current };
}

/** 刷全部开启的群（传 chat 则只刷那一个）。 */
export async function syncBalanceCards(onebot, options = {}) {
  const rule = balanceRule();
  const chat = String(options.chat || '').trim();
  const targets = chat ? [chat] : rule.chats;
  const out = { chats: targets.length, synced: 0, skipped: 0, failed: 0, results: [] };
  for (const gid of targets) {
    const r = await syncChatCard(onebot, gid, { force: options.force === true });
    out.results.push(r);
    if (!r.ok) out.failed += 1;
    else if (r.skipped) out.skipped += 1;
    else out.synced += 1;
  }
  return out;
}

let balanceTimer = null;
let firstTimer = null;

/**
 * 启动定时刷新（幂等；宿主启动时调一次）。
 * 启动 5 秒后先刷一次（等 OneBot 连上），之后每 intervalMs 一次；清单空则什么都不做。
 */
export function startBalanceLoop(onebot) {
  if (!onebot || balanceTimer) return;
  const rule = balanceRule();
  const run = () => {
    if (!balanceRule().chats.length) return;      // 全关：不打日志、不发请求
    syncBalanceCards(onebot).catch((e) => logger.warn('balance', '定时刷新出错：' + (e?.message ?? e)));
  };
  firstTimer = setTimeout(run, 5000);
  firstTimer.unref?.();
  balanceTimer = setInterval(run, rule.intervalMs);
  balanceTimer.unref?.();
  logger.info('balance', `余额后缀定时器就绪：${rule.chats.length} 个群 · 每 ${Math.round(rule.intervalMs / 60000)} 分钟`);
}

/** 停定时器（自测 / 退出用）。 */
export function stopBalanceLoop() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }
}
