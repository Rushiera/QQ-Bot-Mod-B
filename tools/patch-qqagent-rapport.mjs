// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-rapport.mjs — 「回应参数（群友回应意愿分）」幂等补丁
//
// 用法：node patch-qqagent-rapport.mjs [--dry]
// 做什么：给每个群友一个 0~100 的回应参数，分数映射成"对这位群友回复的硬限速"，
//         群 bot 自己用工具调低/调高，系统定时自愈回升，记忆页可见。
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑全部补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-rapport-patch:<id>]；已含标记（或已应用形态）= 跳过
// 依赖：**先跑 patch-qqagent-quiet.mjs**（本补丁锚点落在 botGuard / quiet 的产物上）
// 边界：不动安全边界 / 发言配额 / 硬限 / botGuard；只新增一条并列的"对人"闸门
//
// 设计要点（Rushiera 2026-10-18 口述规格）：
//   1 所有群友初始 100；分数越低 = 这个人越不想跟你聊
//   2 分数映射到"对他回复的硬限速"：0 分 → 20 分钟最多回 1 条；100 分 → 不额外限速
//   3 该降：回了话对方完全不理 / 自说自话 / 你的话对下一句毫无影响 / 让你安静或明显不耐烦
//     不降：下一句参考了你说的内容（尤其带上你的结论）· 直接问你 · 敷衍"嗯嗯好好"也算在听
//     要分清"不想跟你聊一直在转移话题"与"相同话题继续"
//   4 **判不判由模型自己定**（教程进前文 + 工具给 delta），系统只做硬限速与自愈
//   5 自愈：纯本地定时器（不调 LLM），每隔 healIntervalMs 给所有不足 100 的群友 +healPerTick
//   6 按**群友个人**记（每会话一份），记忆页能看到每个群友的分数
//
// 落点：
//   src/rapport.js      回应参数模块（存储 / 冷却映射 / 提示段 / 自愈定时器）
//   src/config.js       engage.rapport 默认段
//   src/sender.js       #checkRate 第二道闸门 + 运行上下文 + 记账
//   src/orchestrator.js 每轮设置"在回谁" + 提示段
//   src/tools.js        adjust_rapport 工具（群 bot 自己调）
//   src/prompt.js       【回应参数】教程段（lean + full 都带）
//   src/routes.js       记忆详情带 rapport + GET /api/rapport/<chat>
//   src/app.js          启动自愈定时器
//   ui/app/05-memory-settings.js  记忆页两处显示（群友印象卡 + 群成员表）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UIAPP = path.join(APP, 'ui', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-rapport-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
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
// 补丁 1：新增 src/rapport.js —— 回应参数模块
// ─────────────────────────────────────────────────────────────────────────────
addFile('module', 'rapport.js', `// 回应参数（rapport）—— 每个群友一个 0~100 的"回应意愿分"。
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
  return '\\n\\n' + lines.join('\\n');
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
    dirs = fs.readdirSync(MEMORY_DIR).filter((f) => /^(group|private)_\\d+$/.test(f));
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
  const delta = hit ? rule.watch.hitDelta : -rule.watch.missDelta;
  const why = (hit ? '我发了话，下一批有人接（@/引用/拍）' : '我发了话，下一批没人接')
    + (rec.sent > 1 ? '（我发了 ' + rec.sent + ' 条）' : '');
  const r = delta ? adjustRapport(chatKey, rec.userId, delta, { name: rec.name, reason: why }) : null;
  return { settled: true, hit, userId: rec.userId, delta: r ? r.delta : 0, score: r ? r.after : null };
}

/** 这批消息里有没有人明确指向我（@ / 引用 / 拍一拍）。 */
function pointsAtMe(m, { selfId = '', selfNickname = '', botName = '' } = {}) {
  if (!m || m.self) return false;
  if (m.atMe === true) return true;
  if (m.isPoke && /拍了拍\\s*我/.test(String(m.text ?? ''))) return true;
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
`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/config.js —— engage.rapport 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-rapport', SRC, 'config.js',
`    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    },`,
`    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    },
    // ── 回应参数（2026-10-18）── [qqagent-rapport-patch:config-rapport]
    // 每个群友一个 0~100 的"回应意愿分"，初始 100。分数低 = 这个人现在不太想跟你聊。
    //   映射：0 分 → 对 TA 的回复最快每 maxCooldownMs（默认 20 分钟，即 1200000ms）1 条；
    //         100 分 → 不额外限速。线性：50 分约 10 分钟，90 分约 2 分钟。
    //   判定归模型（工具 adjust_rapport + 系统提示教程）；这里只管硬限速与自愈。
    //   healPerTick / healIntervalMs：自愈——每隔 healIntervalMs 给所有不足 100 的
    //         群友加 healPerTick 分（纯本地定时器，不调 LLM）。
    //   enabled=false 完全关闭（分数保留，下次打开即恢复）。
    rapport: {
      enabled: true,
      maxCooldownMs: 1200000,
      healPerTick: 2,
      healIntervalMs: 300000
    }`,
1,
`[qqagent-rapport-patch:config-rapport]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/sender.js —— 运行上下文两张表
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-ctor', SRC, 'sender.js',
`    this.botReplyTimes = new Map();
    this.botRuns = new Map();
  }`,
`    this.botReplyTimes = new Map();
    this.botRuns = new Map();
    // 回应参数（[qqagent-rapport-patch:sender-ctor]）——
    //   rapportReplyTimes："chatKey::QQ" -> [ts]（已发出的回复时刻，跨轮生效）
    //   rapportRuns：chatKey -> { target, granted, marked, grantedFor }（本轮运行上下文）
    this.rapportReplyTimes = new Map();
    this.rapportRuns = new Map();
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/sender.js —— #checkRate 第二道闸门（bot 指定之后、硬限之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-checkrate', SRC, 'sender.js',
`    this.#checkBotGuard(chatKey, atUserId);
    // ── 发言硬限制`,
`    this.#checkBotGuard(chatKey, atUserId);
    // 回应参数（[qqagent-rapport-patch:sender-checkrate]）—— 第二道：
    // 分数低 = 对这位群友的回复冷却长（0 分 20 分钟 1 条）；被它拦下的发送
    // 不消耗硬限 / 配额（抛错在记账之前）。
    this.#checkRapport(chatKey, atUserId);
    // ── 发言硬限制`,
1,
`    this.#checkRapport(chatKey, atUserId);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/sender.js —— 回应参数方法组（插在去重逻辑之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-methods', SRC, 'sender.js',
`  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。`,
`  // ── 回应参数（[qqagent-rapport-patch:sender-methods]）───────────────────────
  // Rushiera 2026-10-18 规格：每个群友一个 0~100 的回应参数（初始 100），
  // 分数映射成"对这个人回复的硬限速"——0 分时 20 分钟内最多回他 1 条。
  //
  // 为什么放在出站口：降不降分是模型的判断（工具 adjust_rapport），
  // 但"回得太勤"这件事必须由系统兜底 —— 模型自己克制不住（判例：群内被接话率
  // 97~100%）。所以分数在模型手里，闸门在系统手里。
  //
  // 判定"回的是谁"：显式点名（atUserId / 拍一拍目标）优先；否则取本轮运行目标
  // （orchestrator 每轮告诉 sender：触发批最后一条的发送者）。与 botGuard 同款口径，
  // 但**不限名单**——所有人都有回应参数。
  // 记账粒度 = 一次回复（一轮运行）：本轮第一笔发送放行后，同轮后续发送不再重复判定。

  /** 本轮运行"在回谁"（orchestrator 每轮运行前后设置 / 清除）。 */
  setRunRapportTarget(chatKey, memberId) {
    const id = String(memberId ?? '').trim();
    this.rapportRuns.set(String(chatKey), { target: id || null, granted: false, marked: false, grantedFor: null });
  }

  /** 本轮运行结束：清掉运行上下文（窗口时刻表保留，跨轮生效）。 */
  clearRunRapportTarget(chatKey) {
    this.rapportRuns.delete(String(chatKey));
  }

  /** 本轮要"回"的群友 QQ（显式点名优先，否则本轮运行目标）；都没有返回 null。 */
  #rapportMember(chatKey, atUserId) {
    const at = String(atUserId ?? '').trim();
    if (at) return at;
    const run = this.rapportRuns.get(String(chatKey));
    const t = run && run.target ? String(run.target) : '';
    return t || null;
  }

  /**
   * 该群友当前的限速窗口（判定 / 提示共用）。
   * @returns {{score:number, cooldownMs:number, times:number[], blocked:boolean}}
   */
  rapportWindow(chatKey, memberId) {
    const rule = rapportRule();
    const score = getScore(chatKey, memberId);
    const cooldownMs = cooldownForScore(score, rule);
    const now = Date.now();
    const key = String(chatKey) + '::' + String(memberId);
    const times = cooldownMs > 0
      ? (this.rapportReplyTimes.get(key) || []).filter((t) => now - t < cooldownMs)
      : [];
    return { score, cooldownMs, times, blocked: cooldownMs > 0 && times.length > 0 };
  }

  /**
   * 回应参数闸门：分数低且冷却未过 → 抛错（错误回给模型，模型据此安静结束）。
   * 放行则在轮内标记"已放行"（同一次回复内不再重复判定）。
   * @returns {string|null} 命中的群友 QQ；不判定 = null
   */
  #checkRapport(chatKey, atUserId) {
    const rule = rapportRule();
    if (!rule.enabled) return null;
    // 只管群聊（规格是「对群里的群友个体」）——私聊是 1v1，对方在跟你说话，
    // 不该被"他不想聊"限速误伤。
    if (!String(chatKey).startsWith('group:')) return null;
    const memberId = this.#rapportMember(chatKey, atUserId);
    if (!memberId) return null;
    const run = this.rapportRuns.get(String(chatKey));
    if (run && run.granted) return memberId;      // 本轮已放行：同一次回复内的后续发送不再判定
    const w = this.rapportWindow(chatKey, memberId);
    if (!w.blocked) {
      if (run) { run.granted = true; run.grantedFor = memberId; }
      else this.rapportRuns.set(String(chatKey), { target: null, granted: true, marked: false, grantedFor: memberId });
      return memberId;
    }
    const oldest = Math.min(...w.times);
    const wait = Math.max(1, Math.ceil((w.cooldownMs - (Date.now() - oldest)) / 1000));
    const gap = w.cooldownMs < 60000 ? '不到 1 分钟' : Math.round(w.cooldownMs / 60000) + ' 分钟';
    throw new Error('这位群友的回应参数已降到 ' + w.score + '/100（他不太想跟你聊）：系统对 TA 的回复'
      + '最快每 ' + gap + ' 1 条，刚才已经回过一次（约 ' + wait + ' 秒后可再回）。'
      + '这条不会发出 —— 本轮不要再尝试发送，安静结束即可');
  }

  /** 发送成功后记账（本轮一次回复只记一次）。 */
  #markRapportReply(chatKey) {
    const run = this.rapportRuns.get(String(chatKey));
    if (!run || !run.granted || run.marked || !run.grantedFor) return;
    const key = String(chatKey) + '::' + String(run.grantedFor);
    const now = Date.now();
    const times = (this.rapportReplyTimes.get(key) || []).filter((t) => now - t < 3600000);
    times.push(now);
    this.rapportReplyTimes.set(key, times);
    run.marked = true;
  }

  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：src/sender.js —— 发送成功记账
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-mark', SRC, 'sender.js',
`    // [qqagent-botguard-patch:sender-mark]
    this.#markBotReply(chatKey);`,
`    // [qqagent-botguard-patch:sender-mark]
    this.#markBotReply(chatKey);
    // 回应参数：本轮成功发出过消息 → 记一次对目标群友的回复
    // [qqagent-rapport-patch:sender-mark]
    this.#markRapportReply(chatKey);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：src/sender.js —— import 回应参数模块
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-import', SRC, 'sender.js',
`import { holdBrowse } from './browse-rate.js';`,
`import { holdBrowse } from './browse-rate.js';
// 回应参数（分数 → 对某人的回复冷却）——[qqagent-rapport-patch:sender-import]
import { getScore, cooldownForScore, rapportRule } from './rapport.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：src/orchestrator.js —— import
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', SRC, 'orchestrator.js',
`import { formatChatterHint } from './chatter.js';`,
`import { formatChatterHint } from './chatter.js';
// 回应参数（群友回应意愿分 → 硬限速 + 每轮提示）——[qqagent-rapport-patch:orchestrator-import]
import { formatRapportHint } from './rapport.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：src/orchestrator.js —— 每轮设置"在回谁"
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-run-target', SRC, 'orchestrator.js',
`    if (this.sender && typeof this.sender.setRunBotTarget === 'function') this.sender.setRunBotTarget(chatKey, botRunTarget);`,
`    if (this.sender && typeof this.sender.setRunBotTarget === 'function') this.sender.setRunBotTarget(chatKey, botRunTarget);
    // ── 回应参数：本轮"在回谁"（对所有人都算，不限名单）──
    // [qqagent-rapport-patch:orchestrator-run-target]
    // 触发批最后一条的发送者 = 本轮回复对象；分数低的群友出站会被限速。
    const rapportTarget = botLast ? String(botLast.senderId) : null;
    if (this.sender && typeof this.sender.setRunRapportTarget === 'function') this.sender.setRunRapportTarget(chatKey, rapportTarget);`);

patch('orchestrator-run-target-clear', SRC, 'orchestrator.js',
`      if (this.sender && typeof this.sender.clearRunBotTarget === 'function') this.sender.clearRunBotTarget(chatKey);`,
`      if (this.sender && typeof this.sender.clearRunBotTarget === 'function') this.sender.clearRunBotTarget(chatKey);
      // 本轮回应参数上下文收尾（[qqagent-rapport-patch:orchestrator-run-target-clear]）
      if (this.sender && typeof this.sender.clearRunRapportTarget === 'function') this.sender.clearRunRapportTarget(chatKey);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10：src/orchestrator.js —— 每轮提示段
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-hint', SRC, 'orchestrator.js',
`    const quietLine = (() => {
      try { return quietHint(chatKey); } catch { return ''; }
    })();`,
`    const quietLine = (() => {
      try { return quietHint(chatKey); } catch { return ''; }
    })();
    // 回应参数提示（[qqagent-rapport-patch:orchestrator-hint]）—— 与配额同段：
    // 告知本轮涉及群友的分数（分数低 = 上轮的话没起作用，该收着）。全部 100 分时不占 token。
    const rapportLine = (() => {
      try {
        const ids = [...new Set((triggerEntries || [])
          .filter((m) => m && !m.self && m.senderId)
          .map((m) => String(m.senderId)))];
        return formatRapportHint(chatKey, { userIds: ids });
      } catch { return ''; }
    })();`);

patch('orchestrator-hint-append', SRC, 'orchestrator.js',
`        : userPrompt) + quotaLine + chatterHint + browseLine + quietLine   // [qqagent-quiet-patch:orchestrator-hint-append]`,
`        : userPrompt) + quotaLine + chatterHint + browseLine + quietLine + rapportLine   // [qqagent-rapport-patch:orchestrator-hint-append]`,
1,
`+ quietLine + rapportLine   //`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 11-12：src/tools.js —— import + adjust_rapport 工具
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', SRC, 'tools.js',
`import { setBrowseLevel, browseState } from './browse-rate.js';`,
`import { setBrowseLevel, browseState } from './browse-rate.js';
// 回应参数（群 bot 自己调）——[qqagent-rapport-patch:tools-import]
import { getRapport, adjustRapport, cooldownForScore } from './rapport.js';`);

patch('tools-register', SRC, 'tools.js',
`  // 消息发送类
  registerTool({
    id: 'send_message',`,
`  // ── 回应参数调整（[qqagent-rapport-patch:tools-register]）──
  // 为什么给模型一把"打分刀"：谁在敷衍、谁在认真听，只有读得懂语境的模型能判。
  // 系统只管硬限速与自愈 —— 判断归模型，闸门归系统。
  registerTool({
    id: 'adjust_rapport',
    name: '调整回应参数',
    description: '调整某位群友的「回应参数」（0~100，初始 100）——它衡量这个人现在还想不想跟你聊。\\n'
      + '**该降**：你说了话他完全不理、继续自说自话；你的话对他的下一句没有任何影响；'
      + '他说"你不用说话/别吵/太吵了"或明显不耐烦、阴阳你。\\n'
      + '**不降**：他下一句明显参考了你说过的话（尤其带上了你结论里的词）；他直接问你、点名你；'
      + '他回你"嗯嗯""好""草"这类敷衍——敷衍也是在听，不降。\\n'
      + '分清两件事：同一话题继续往下讲、只是没接你那句 → 小降或不降；一句一个话题地跳开、'
      + '每次都绕开你 → 那是转移话题，降。\\n'
      + '分数映射到系统硬限速：0 分时 20 分钟内最多回他 1 条，100 分不额外限速。分数会自己慢慢回升。'
      + '一轮最多调一两次，判不准就不调（不动 = 保持现状）。',
    category: 'memory',
    icon: '📶',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '群友 QQ 号（数字）' },
        delta: { type: 'integer', description: '变化量建议：无视你 / 让你安静 / 明显转移话题 → -20~-10；一般没接但不冒犯 → -5；正常对话 → 0；接住你的话 / 点名问你 → +5~+10' },
        reason: { type: 'string', description: '一句话理由（留在该群友的记录里，下次你能看到）' }
      },
      required: ['userId']
    },
    async execute(ctx, args) {
      const userId = String(args.userId ?? '').trim();
      if (!/^\\d{1,15}$/.test(userId)) {
        return err('userId 必须是数字 QQ 号（收到：' + JSON.stringify(args.userId) + '）。先用 get_active_members 查准确 QQ 号。');
      }
      const delta = Math.round(Number(args.delta) || 0);
      if (!delta) {
        const cur = getRapport(ctx.chatKey, userId);
        return ok({ userId, score: cur.score, note: 'delta 为 0，未改动。' });
      }
      // 名字从最近消息里取（提示段与记忆页展示更好认）
      let name = '';
      try {
        const tail = ctx.store.recent(ctx.chatKey, { limit: 60 }) || [];
        const hit = [...tail].reverse().find((m) => m && !m.self && String(m.senderId) === userId);
        if (hit) name = String(hit.senderName || '');
      } catch { name = ''; }
      const r = adjustRapport(ctx.chatKey, userId, delta, { reason: String(args.reason ?? ''), name });
      if (!r) return err('调整失败：缺少 userId');
      const cd = cooldownForScore(r.after);
      return ok({
        userId,
        before: r.before,
        after: r.after,
        delta: r.delta,
        cooldownMinutes: cd < 60000 ? 0 : Math.round(cd / 60000),
        note: '不要向群里说"我调了你的回应参数"这类话。'
      });
    }
  });
  // 消息发送类
  registerTool({
    id: 'send_message',`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 13-15：src/prompt.js —— 教程段（lean + full 都带）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-fn', SRC, 'prompt.js',
`function notAQueue() {`,
`function rapportRules() {
  // 回应参数教程（Rushiera 2026-10-18 规格）——[qqagent-rapport-patch:prompt-fn]
  // 分数本身由系统记（每人 0~100）；降不降由模型自己判（工具 adjust_rapport）。
  // 这段只教"怎么判"，不写制度腔。
  return [
    '【回应参数：看人下菜碟】',
    '- 每个群友有一个「回应参数」（0~100，初始 100）——它衡量"这个人现在还想不想跟你聊"。'
      + '分数会变成系统对你的硬限速：0 分时 20 分钟内最多回他 1 条，100 分不额外限速。',
    '- 该降：你回了话，他完全不接、继续自说自话；你的话对他的下一句没有任何影响；'
      + '他说"不用你说话""安静点""太吵了"，或者明显不耐烦、阴阳你。这些都算"他觉得你烦"。',
    '- 不降：他下一句明显参考了你说过的话（尤其带上了你结论里的词）；他直接问你、点名你；'
      + '他回你"嗯嗯""好""草"这类敷衍——敷衍也是在听，不降。',
    '- 分清"不想聊"和"还在聊"：同一话题继续往下讲、只是没接你那句 → 小降或不降；'
      + '一句一个话题地跳开、每次都绕开你 → 那是转移话题，降。',
    '- 用工具 adjust_rapport 调（delta 自己给，-20 ~ +10）。一轮最多调一两次，判不准就不调。',
    '- 分数会自己慢慢回升（系统定时加分），不用你手动补；他明确接住你时，你也可以主动 +5。'
  ].join('\\n');
}

function notAQueue() {`);

patch('prompt-lean', SRC, 'prompt.js',
`        notAQueue(),
        '',
        memoryRules(),`,
`        rapportRules(),
        '',
        notAQueue(),
        '',
        memoryRules(),`,
1,
`        rapportRules(),
        '',
        notAQueue(),`);

patch('prompt-full', SRC, 'prompt.js',
`    notAQueue(),
    '',
    humanRhythm(),`,
`    rapportRules(),
    '',
    notAQueue(),
    '',
    humanRhythm(),`,
1,
`    rapportRules(),
    '',
    notAQueue(),`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 16-18：src/routes.js —— import + 详情带 rapport + GET /api/rapport/<chat>
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-import', SRC, 'routes.js',
`import { getSessionState } from './session-state.js';`,
`import { getSessionState } from './session-state.js';
// 回应参数（记忆页展示 / 手动查看）——[qqagent-rapport-patch:routes-import]
import { listRapport } from './rapport.js';`);

patch('routes-detail', SRC, 'routes.js',
`          archiveStats: {
            group: groupMemoryStats(chatKey).archived || 0,
            member: memory.memberArchiveStats(chatKey)?.count || 0
          }`,
`          archiveStats: {
            group: groupMemoryStats(chatKey).archived || 0,
            member: memory.memberArchiveStats(chatKey)?.count || 0
          },
          // 回应参数（只列不满 100 的；记忆页给每个群友显示分数 + 理由）——
          // [qqagent-rapport-patch:routes-detail]
          rapport: listRapport(chatKey)`);

patch('routes-route', SRC, 'routes.js',
`    {
      method: 'PUT', pattern: /^\\/api\\/memory-files\\/(group|private)_(\\d+)\\/members\\/(\\d+)$/,`,
`    {
      // 回应参数（每群友 0~100）——记忆页群成员表用；[qqagent-rapport-patch:routes-route]
      method: 'GET', pattern: /^\\/api\\/rapport\\/(group|private)_(\\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = match[1] + ':' + match[2];
        return json(res, 200, { chatKey, members: listRapport(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\\/api\\/memory-files\\/(group|private)_(\\d+)\\/members\\/(\\d+)$/,`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 19-20：src/app.js —— import + 启动自愈定时器
// ─────────────────────────────────────────────────────────────────────────────
patch('app-import', SRC, 'app.js',
`import { startTelemetryLoop } from './telemetry.js';`,
`import { startTelemetryLoop } from './telemetry.js';
// 回应参数自愈（纯本地定时加分，不调 LLM）——[qqagent-rapport-patch:app-import]
import { startHealLoop as startRapportHeal } from './rapport.js';`);

patch('app-start', SRC, 'app.js',
`    orchestrator.startBrowseLoop();`,
`    orchestrator.startBrowseLoop();
    // 回应参数自愈：每隔 engage.rapport.healIntervalMs 给不足 100 的群友加分
    // [qqagent-rapport-patch:app-start]
    startRapportHeal();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 21-23：记忆页（详情）显示回应参数
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-detail-map', UIAPP, '05-memory-settings.js',
`    const members = Array.isArray(mem.members) ? mem.members : [];`,
`    // 回应参数（每群友 0~100，缺省 100）——[qqagent-rapport-patch:ui-detail-map]
    const rapportMap = (() => {
      const out = {};
      for (const r of (Array.isArray(mem.rapport) ? mem.rapport : [])) out[String(r.userId)] = r;
      return out;
    })();
    const rapportBadge = (qq) => {
      const r = rapportMap[String(qq)];
      if (!r) return ' <span class="muted" title="回应参数（初始 100；越低 = 他越不想跟你聊）">回应 100</span>';
      const why = r.lastReason ? ' · ' + r.lastReason : '';
      const title = '回应参数 ' + r.score + '/100' + why;
      return r.score < 80
        ? ' <span style="color:#c0392b" title="' + esc(title) + '">回应 ' + Number(r.score) + '</span>'
        : ' <span class="muted" title="' + esc(title) + '">回应 ' + Number(r.score) + '</span>';
    };
    const members = Array.isArray(mem.members) ? mem.members : [];`);

patch('ui-detail-badge', UIAPP, '05-memory-settings.js',
`          <span class="mem-who">\${esc(who)}\${qq}（\${m.impressions.length} 条）</span>`,
`          <span class="mem-who">\${esc(who)}\${qq}（\${m.impressions.length} 条）\${rapportBadge(String(m.userId))}</span>`,
1,
`\${rapportBadge(String(m.userId))}</span>`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 24-26：群成员表显示回应参数
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-members-map', UIAPP, '05-memory-settings.js',
`    const box = $('#mem-members');`,
`    // 回应参数（群成员表逐人显示）——[qqagent-rapport-patch:ui-members-map]
    let rapportMap = {};
    try {
      const rp = await api(\`/api/rapport/\${chatKey.replace(':', '_')}\`);
      for (const r of (Array.isArray(rp.members) ? rp.members : [])) rapportMap[String(r.userId)] = r;
    } catch { rapportMap = {}; }
    const box = $('#mem-members');`);

patch('ui-members-head', UIAPP, '05-memory-settings.js',
`        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>`,
`        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:56px;text-align:right">回应</th><th style="width:90px;text-align:right">备注</th></tr>`,
1,
`<th style="width:56px;text-align:right">回应</th>`);

patch('ui-members-cell', UIAPP, '05-memory-settings.js',
`          const note = notes[String(m.userId)];
          return \`<tr>`,
`          const note = notes[String(m.userId)];
          // 回应参数：0~100，缺省 100（[qqagent-rapport-patch:ui-members-cell]）
          const rp = rapportMap[String(m.userId)];
          const rpScore = rp ? Number(rp.score) : 100;
          const rpTitle = rp ? ('回应参数 ' + rpScore + '/100' + (rp.lastReason ? ' · ' + rp.lastReason : '')) : '回应参数 100/100（初始值）';
          return \`<tr>`);

patch('ui-members-score-cell', UIAPP, '05-memory-settings.js',
`            <td class="muted" style="font-size:11px">\${esc(m.userId)}</td>`,
`            <td class="muted" style="font-size:11px">\${esc(m.userId)}</td>
            <td style="text-align:right\${rpScore < 80 ? ';color:#c0392b' : ''}" title="\${esc(rpTitle)}">\${rpScore}</td>`,
1,
`\${rpScore}</td>`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 29-32：客观结算（2026-10-19 · Rushiera 点名"降级应对几乎没生效"）
//   为什么单列：分数由模型自己调（adjust_rapport），但实测累计 4 次调用 / 2440 次发言——
//   模型在"我想说"那一刻没有反向信号，每次都觉得自己该说，分数永远降不下去，
//   闸门形同装饰。这里补的是**宿主侧客观信号**：我发了话，下一批有没有人接。
// ─────────────────────────────────────────────────────────────────────────────
patch('config-watch', SRC, 'config.js',
`      healIntervalMs: 300000`,
`      healIntervalMs: 300000,
      // 客观结算（[qqagent-rapport-patch:config-watch] · 2026-10-19）——
      // 宿主侧看"我发了话，下一批有没有人 @ / 引用 / 拍我"：没人接就自动降 missDelta 分，
      // 有人接就加 hitDelta 分。模型手调（adjust_rapport）与自愈照常。
      //   exemptUsers：不做客观结算的 QQ（默认主人 569145850——他 @ 是点名，
      //   不回不代表不想聊，可能是忙 / 在测试；与「VIP 不受配额与硬限约束」同口径）。
      //   enabled=false 只关客观结算。
      watch: {
        enabled: true,
        missDelta: 12,
        hitDelta: 6,
        exemptUsers: ['569145850']
      }`,
1,
`[qqagent-rapport-patch:config-watch]`);

patch('orchestrator-import-watch', SRC, 'orchestrator.js',
`import { formatRapportHint } from './rapport.js';`,
`// 客观结算（我发了话有没有人接）——[qqagent-rapport-patch:orchestrator-import-watch]
import { formatRapportHint, noteRapportOutbound, settleRapportWatch } from './rapport.js';`,
1,
`[qqagent-rapport-patch:orchestrator-import-watch]`);

patch('orchestrator-watch', SRC, 'orchestrator.js',
`    const botRunTarget = botLast && botMembers.includes(String(botLast.senderId)) ? String(botLast.senderId) : null;`,
`    const botRunTarget = botLast && botMembers.includes(String(botLast.senderId)) ? String(botLast.senderId) : null;
    // ── 回应参数 · 客观结算（[qqagent-rapport-patch:watch-orchestrator] · 2026-10-19）──
    // ① 结算上一次发言：这批消息里有没有人 @ 我 / 引用我 / 拍我 —— 有就是话落地了，
    //    没有就自动给上次的回复对象降分（宿主侧客观信号，不看内容、幅度小、可自愈）。
    // ② 记下本轮"回了谁"，留给下一批结算；被点名的那一轮不记（那是人家要的回复）。
    const rapportSelfId = this.onebot && this.onebot.selfId ? String(this.onebot.selfId) : '';
    const rapportPersona = getConfig().persona || {};
    const rapportWatchCtx = {
      selfId: rapportSelfId,
      selfNickname: String(rapportPersona.selfNickname || rapportPersona.botName || ''),
      botName: String(rapportPersona.botName || '')
    };
    const atMeThisRound = (triggerEntries || []).some((m) => m
      && (m.atMe === true || (m.isPoke && /拍了拍\\s*我/.test(String(m.text ?? '')))));
    const rapportTargetName = botLast ? String(botLast.senderName || '') : '';
    try {
      const settled = settleRapportWatch(chatKey, triggerEntries, rapportWatchCtx);
      if (settled && settled.settled && settled.delta) {
        logger.info('rapport', '客观结算：' + (settled.hit ? '有人接话 → +' : '没人接话 → ')
          + Math.abs(settled.delta) + '（' + (settled.userId || '') + ' · 现 ' + settled.score + '）');
      }
    } catch (e) {
      logger.warn('rapport', '客观结算出错：' + (e && e.message ? e.message : e));
    }`,
1,
`[qqagent-rapport-patch:watch-orchestrator]`);

patch('orchestrator-watch-note', SRC, 'orchestrator.js',
`      if (!lastError && isRollover) await this.#completeRollover(chatKey, session);`,
`      if (!lastError && isRollover) await this.#completeRollover(chatKey, session);
      // 客观结算 · 记账（[qqagent-rapport-patch:watch-note]）——
      // 本轮真发了话才记；被点名的那一轮不记（那是人家要的回复）；收工轮 / 整理轮不记（不发言）。
      if (!lastError && !isRollover && !quietOrganize && rapportTarget
          && (session.sent || []).length > 0 && !atMeThisRound) {
        noteRapportOutbound(chatKey, rapportTarget, { name: rapportTargetName, sent: (session.sent || []).length });
      }`,
1,
`[qqagent-rapport-patch:watch-note]`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
