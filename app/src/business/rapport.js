// 回应参数（rapport）—— 每个群友一个 0~100 的"回应意愿分"。
// [qqagent-rapport-patch:module]
//
// 语义（Rushiera 2026-10-18 规格）：
//   初始 100。分数低 = 这个人现在不太想跟你聊（你说了话他完全不理 / 自说自话 /
//   让你安静 / 一直在转移话题）。分数映射成**对这位群友回复的硬限速**——
//   0 分时 20 分钟内最多回他 1 条；100 分不额外限速。
//
// 三个"不做"：
//   · 不做判定 —— 降不降由模型自己用 adjust_rapport 决定（教程在系统提示里）
//   · 不做内容分析 —— 本模块只存分数、算冷却、渲染提示
//   · 不调 LLM —— 自愈是纯本地定时器加分
//
// 载体：data/memory/<chat>/_rapport.json（与 _group.json / _session.json 同址，
//   下划线开头避开成员文件语义）。分数回到 100 的条目直接删掉，不占盘。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { logger } from './logger.js';
// 档位对降分设上限（[qqagent-level-patch:rapport-import]）
import { paramsFor } from './engage-level.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const DEFAULT_SCORE = 100;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const FILE_NAME = '_rapport.json';
const LOG_KEEP = 10;          // 每人保留最近多少条变动记录（供提示段与排查）

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 回应参数文件路径。 */
export function rapportFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), FILE_NAME);
}

function clamp(n) {
  const v = Math.round(Number(n) || 0);
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, v));
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

// 内存缓存：chatKey -> Map(userId -> entry)。读写都在缓存上，落盘只在变更后发生。
const cache = new Map();

function emptyEntry(userId) {
  return {
    userId: String(userId || ''),
    name: '',
    score: DEFAULT_SCORE,
    updatedAt: 0,
    lastDeltaAt: 0,
    lastReason: '',
    log: []
  };
}

function loadChat(chatKey) {
  if (cache.has(chatKey)) return cache.get(chatKey);
  const raw = readJson(rapportFile(chatKey), null);
  const map = new Map();
  const members = raw && raw.members && typeof raw.members === 'object' ? raw.members : {};
  for (const [uid, e] of Object.entries(members)) {
    const id = String(uid || '').trim();
    if (!id) continue;
    const score = clamp(e?.score ?? DEFAULT_SCORE);
    if (score >= DEFAULT_SCORE) continue;   // 满分的条目不进缓存（= 默认态）
    map.set(id, {
      userId: id,
      name: String(e?.name ?? ''),
      score,
      updatedAt: Number(e?.updatedAt) || 0,
      lastDeltaAt: Number(e?.lastDeltaAt) || 0,
      lastReason: String(e?.lastReason ?? ''),
      log: Array.isArray(e?.log) ? e.log.slice(-LOG_KEEP) : []
    });
  }
  cache.set(chatKey, map);
  return map;
}

/** 全量落盘（只写 score < 100 的条目；文件空了就删）。 */
function saveChat(chatKey, map) {
  const members = {};
  for (const [uid, e] of map) {
    if (!uid || e.score >= DEFAULT_SCORE) continue;
    members[uid] = e;
  }
  const file = rapportFile(chatKey);
  if (!Object.keys(members).length) {
    try { fs.rmSync(file, { force: true }); } catch { /* 不存在即已干净 */ }
    return;
  }
  writeJson(file, { chatKey: String(chatKey), members, updatedAt: Date.now() });
}

/** 配置面参数（带默认值与下限，防手改配置写出 0 间隔）。 */
export function rapportRule() {
  const r = getConfig().engage?.rapport || {};
  return {
    enabled: r.enabled !== false,
    // score=0 时两次回复之间的最小间隔（默认 20 分钟）
    maxCooldownMs: Math.max(60000, Number(r.maxCooldownMs) || 1200000),
    // 自愈：每隔 healIntervalMs 给所有不足 100 的群友 +healPerTick 分
    healPerTick: Math.max(1, Number(r.healPerTick) || 2),
    healIntervalMs: Math.max(60000, Number(r.healIntervalMs) || 300000),
    // 客观结算（[qqagent-rapport-patch:watch-rule]）—— 宿主侧看"我发了话有没有人接"。
    //   missDelta：没人接 → 自动降这么多分（模型手调的补充）；hitDelta：有人接 → 加这么多。
    //   exemptUsers：不做客观结算的 QQ（默认主人 569145850——他 @ 你是点名，他不回
    //   不代表不想聊，可能是忙 / 在测试；与「VIP 通道不受配额与硬限约束」同口径）。
    watch: {
      enabled: r.watch?.enabled !== false,
      missDelta: Math.max(0, Number(r.watch?.missDelta) || 12),
      hitDelta: Math.max(0, Number(r.watch?.hitDelta) || 6),
      exemptUsers: Array.isArray(r.watch?.exemptUsers)
        ? r.watch.exemptUsers.map((v) => String(v ?? '').trim()).filter(Boolean)
        : ['569145850']
    }
  };
}

/**
 * 分数 → 对这位群友两次回复之间的最小间隔（毫秒）。
 * 线性映射：0 分 = maxCooldownMs（默认 20 分钟），100 分 = 0（不额外限速）。
 * 50 分 ≈ 10 分钟；90 分 ≈ 2 分钟（低于全局硬限 60 秒时天然不生效）。
 */
export function cooldownForScore(score, rule = null) {
  const r = rule || rapportRule();
  return Math.round(((DEFAULT_SCORE - clamp(score)) / DEFAULT_SCORE) * r.maxCooldownMs);
}

/** 读某位群友的回应参数（缺省 = 100）。 */
export function getRapport(chatKey, userId) {
  const id = String(userId ?? '').trim();
  if (!id) return emptyEntry('');
  const map = loadChat(chatKey);
  const e = map.get(id);
  return e ? { ...e, log: [...(e.log || [])] } : emptyEntry(id);
}

/** 只要分数。 */
export function getScore(chatKey, userId) {
  return getRapport(chatKey, userId).score;
}

/**
 * 调整回应参数（clamp 到 0~100；回到 100 即删除条目）。
 * @returns {{before:number, after:number, delta:number, entry:object}|null}
 */
export function adjustRapport(chatKey, userId, delta, { reason = '', name = '' } = {}) {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  const map = loadChat(chatKey);
  const cur = map.get(id) || emptyEntry(id);
  const before = cur.score;
  const after = clamp(before + Math.round(Number(delta) || 0));
  const actual = after - before;
  const now = Date.now();
  const next = {
    ...cur,
    name: String(name || cur.name || ''),
    score: after,
    updatedAt: now,
    lastDeltaAt: actual ? now : cur.lastDeltaAt,
    lastReason: String(reason || cur.lastReason || '').slice(0, 120),
    log: actual
      ? [...(cur.log || []), { at: now, delta: actual, score: after, reason: String(reason || '').slice(0, 80) }].slice(-LOG_KEEP)
      : (cur.log || [])
  };
  if (after >= DEFAULT_SCORE) map.delete(id);
  else map.set(id, next);
  saveChat(chatKey, map);
  return { before, after, delta: actual, entry: after >= DEFAULT_SCORE ? emptyEntry(id) : next };
}

/** 直接设为某个分数（管理面 / 自测用）。 */
export function setRapport(chatKey, userId, score, opts = {}) {
  const cur = getScore(chatKey, userId);
  return adjustRapport(chatKey, userId, clamp(score) - cur, opts);
}

/** 本会话所有"不满 100"的群友（记忆页展示用；按分数升序 = 最不想聊的在前）。 */
export function listRapport(chatKey) {
  const map = loadChat(chatKey);
  return [...map.values()]
    .map((e) => ({
      userId: e.userId,
      name: e.name,
      score: e.score,
      cooldownMs: cooldownForScore(e.score),
      updatedAt: e.updatedAt,
      lastDeltaAt: e.lastDeltaAt,
      lastReason: e.lastReason
    }))
    .sort((a, b) => a.score - b.score);
}

/**
 * 渲染【回应参数】提示段（追加在用户消息末尾，与配额同段）。
 * 只列本轮相关的群友；全部 100 分时返回空串（不占 token）。
 */
export function formatRapportHint(chatKey, { userIds = [] } = {}) {
  const rule = rapportRule();
  if (!rule.enabled) return '';
  const ids = [...new Set((userIds || []).map((v) => String(v ?? '').trim()).filter(Boolean))];
  if (!ids.length) return '';
  const rows = ids.map((id) => getRapport(chatKey, id)).filter((e) => e.score < DEFAULT_SCORE);
  if (!rows.length) return '';
  rows.sort((a, b) => a.score - b.score);
  const lines = ['【回应参数（本轮参考 · 分数低 = 他觉得你烦）】'];
  for (const e of rows) {
    const cd = cooldownForScore(e.score, rule);
    const gap = cd < 60000 ? '不额外限速' : '最快每 ' + Math.round(cd / 60000) + ' 分钟回 1 条';
    const who = e.name || e.userId;
    const why = e.lastReason ? '（上次：' + e.lastReason + '）' : '';
    lines.push('- ' + who + '：' + e.score + '/100 · 系统对 TA 硬限 ' + gap + why);
  }
  lines.push('- 0 分时系统限死「20 分钟最多回 1 条」—— 他不想聊就别硬凑。分数会自己慢慢回升，不用你手动加回去。');
  return '\n\n' + lines.join('\n');
}

/**
 * 自愈：给所有不足 100 的群友加分（纯本地，不调 LLM）。
 * 扫 memory 下所有会话目录（不是只扫内存里有的会话）——冷群也要回升。
 */
export function healAll(now = Date.now()) {
  const rule = rapportRule();
  const out = { chats: 0, members: 0, changed: 0, full: 0 };
  if (!rule.enabled) return out;
  let dirs = [];
  try {
    dirs = fs.readdirSync(MEMORY_DIR).filter((f) => /^(group|private)_\d+$/.test(f));
  } catch {
    return out;   // 还没有任何记忆目录
  }
  for (const dir of dirs) {
    const chatKey = dir.replace(/^group_/, 'group:').replace(/^private_/, 'private:');
    const map = loadChat(chatKey);
    if (!map.size) continue;
    out.chats += 1;
    let dirty = false;
    for (const [uid, e] of [...map.entries()]) {
      out.members += 1;
      const next = clamp(e.score + rule.healPerTick);
      if (next === e.score) continue;
      out.changed += 1;
      dirty = true;
      if (next >= DEFAULT_SCORE) { map.delete(uid); out.full += 1; }
      else map.set(uid, { ...e, score: next, updatedAt: now });
    }
    if (dirty) saveChat(chatKey, map);
  }
  return out;
}

let healTimer = null;

/** 启动自愈定时器（幂等；宿主启动时调一次）。 */
export function startHealLoop() {
  const rule = rapportRule();
  if (!rule.enabled || healTimer) return;
  healTimer = setInterval(() => {
    try {
      const r = healAll();
      if (r.changed) {
        logger.info('rapport', '自愈：' + r.changed + ' 位群友回应参数回升 +' + rule.healPerTick
          + '（涉及 ' + r.chats + ' 个会话 · ' + r.full + ' 位已回满 100）');
      }
    } catch (e) {
      logger.warn('rapport', '自愈巡检出错：' + (e?.message ?? e));
    }
  }, rule.healIntervalMs);
  healTimer.unref?.();
}

/** 停自愈定时器（自测 / 退出用）。 */
export function stopHealLoop() {
  if (!healTimer) return;
  clearInterval(healTimer);
  healTimer = null;
}

/** 清内存缓存（自测用；生产不需要）。 */
// ── 客观结算（[qqagent-rapport-patch:watch] · 2026-10-19）────────────────────
// 为什么要有它：分数由模型自己调（adjust_rapport），但实测 4 次调用 / 2440 次发言——
// 模型在"我想说"那一刻没有反向信号，每次都觉得自己该说，分数永远降不下去，
// 闸门就成了装饰。这里补的是**宿主侧的客观信号**：我发了话，下一批消息里有没有人
// @ 我 / 引用我 / 拍我 —— 有就是话落地了，没有就是没人要听。
// 判定只看客观事实（不看内容），幅度小、可自愈，是模型手调的补充而不是替代。
const watch = new Map();   // chatKey -> { userId, name, sent, at }

/** 记录"我刚回了谁"（一轮结束、确有发言时调；被点名的那一轮不记）。 */
export function noteRapportOutbound(chatKey, userId, { name = '', sent = 0 } = {}) {
  const id = String(userId ?? '').trim();
  if (!id) return null;
  const rule = rapportRule();
  if (!rule.enabled || !rule.watch.enabled) return null;
  if (rule.watch.exemptUsers.includes(id)) return null;
  const rec = { userId: id, name: String(name || ''), sent: Number(sent) || 0, at: Date.now() };
  watch.set(chatKey, rec);
  return rec;
}

/**
 * 结算上一次发言：这一批消息里有没有人理我？
 * 有（@ / 引用 / 拍我）→ +hitDelta；没有 → -missDelta。结算完即清，同一批只判一次。
 * @returns {{settled:boolean, hit:boolean, userId:string, delta:number, score:number|null}|null}
 */
export function settleRapportWatch(chatKey, entries, ctx = {}) {
  const rec = watch.get(chatKey);
  if (!rec) return null;
  watch.delete(chatKey);
  const rule = rapportRule();
  if (!rule.enabled || !rule.watch.enabled) return null;
  const hit = (entries || []).some((m) => pointsAtMe(m, ctx));
  // 档位封顶（[qqagent-level-patch:rapport-miss-cap]）：客观结算降级为**只采集**——
  // "没人接话"在闲聊群里是常态（实测群 361820329 一个周期 1557 条里 @ 我的只 13 条），
  // 拿它扣分等于系统性误判。现在判定与日志照跑，扣分量由档位 missCap 决定（默认 0 = 不扣）。
  // 模型手调 adjust_rapport 与自愈照常，maxCooldownMs 保留为兜底。
  let missDelta = rule.watch.missDelta;
  try { missDelta = Math.min(missDelta, paramsFor(chatKey).missCap); } catch { /* 档位不可用 → 用配置值 */ }
  const delta = hit ? rule.watch.hitDelta : -missDelta;
  const why = (hit ? '我发了话，下一批有人接（@/引用/拍）' : '我发了话，下一批没人接')
    + (rec.sent > 1 ? '（我发了 ' + rec.sent + ' 条）' : '');
  const r = delta ? adjustRapport(chatKey, rec.userId, delta, { name: rec.name, reason: why }) : null;
  return { settled: true, hit, userId: rec.userId, delta: r ? r.delta : 0, score: r ? r.after : null };
}

/** 这批消息里有没有人明确指向我（@ / 引用 / 拍一拍）。 */
function pointsAtMe(m, { selfId = '', selfNickname = '', botName = '' } = {}) {
  if (!m || m.self) return false;
  if (m.atMe === true) return true;
  if (m.isPoke && /拍了拍\s*我/.test(String(m.text ?? ''))) return true;
  const r = m.reply;
  if (r && selfId && String(r.sender ?? '') === String(selfId)) return true;
  const t = String(m.text ?? '');
  if (selfId && t.includes('(QQ:' + selfId + ')')) return true;
  if (selfNickname && t.includes('[引用 ' + selfNickname)) return true;
  if (botName && t.includes('[引用 ' + botName)) return true;
  return false;
}

/** 清客观结算内存（自测用）。 */
export function clearRapportWatch() {
  watch.clear();
}

export function clearRapportCache() {
  cache.clear();
}
