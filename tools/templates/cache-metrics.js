// 缓存观测采集面 —— 把"每一次 LLM 调用的前缀状态 + 命中结果"落成可算的数据。
// [qqbotb-cachemetrics:module]
//
// 为什么要有它：缓存命中率原先只能事后从 sessions/*.json 重算（要读 60MB+，
// 且拿不到「这次请求的前缀与上一次相比哪一段变了」「同一段前缀距上次发送多久」）。
// 采集面落地后，TTL 曲线、分叉落点、锚点收益都能直接用真实流量算出来，
// 不需要另做控制实验。
//
// 形态：data/metrics/cache-<YYYY-MM-DD>.jsonl —— 一行一次调用，append-only。
//   采集失败绝不影响运行（所有调用点都 try/catch 包着）。
//
// 关键字段（TTL 自然实验的判据）：
//   headHash / headGapSec —— 跨群共享前缀（默认前 4096 字符）的指纹，
//     以及「上一次发送同样指纹」距今多少秒。所有群的前缀头部完全相同，
//     于是每一次调用天然就是一次 TTL 探针：headGapSec 分布 × cachedTokens
//     即可反推缓存的分层衰减曲线。
//   secHashes / secLens —— 逐段指纹与长度；与同群上一次比对即可定位分叉点。
//   sameChatSameSecs —— 与同群上一次调用相比，仍然逐字节相同的前导段列表。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';

const DIR = path.join(DATA_DIR, 'metrics');

/** 共享前缀取样长度（字符）—— 覆盖「系统提示 + 角色设定 + 表情包 + 引导说明」。 */
const HEAD_CHARS = 4096;

/** 段标题表（与 prompt.js 的渲染顺序对应；标题之后的内容整段算该段）。 */
const SECTION_TITLES = [
  ['角色设定', 'role'],
  ['可用表情包', 'sticker'],
  ['引导说明', 'guide'],
  ['记忆', 'memory'],
  ['前情提要', 'digest'],
  ['已读信息', 'read'],
  ['新已读信息', 'readNew'],
  ['未读信息', 'unread'],
  ['新加入成员', 'newMember'],
  ['活跃模式', 'active'],
  ['当前时间', 'time'],
];

const sha1 = (s) => crypto.createHash('sha1').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 12);

/**
 * 按段首标题切分用户提示。返回 [{key, text}]，顺序即渲染顺序。
 * 不用 indexOf 直接找标题 —— 正文里也会出现【已读信息】这类词，会误命中；
 * 只认「段首」（文件头或紧跟 \n\n）出现的标题。
 */
export function splitSections(usr) {
  const text = String(usr ?? '');
  if (!text) return [];
  const marks = [];
  for (const [title, key] of SECTION_TITLES) {
    const head = `【${title}`;
    if (text.startsWith(head)) marks.push({ at: 0, key });
    const marker = `\n\n${head}`;
    let i = text.indexOf(marker);
    while (i >= 0) {
      marks.push({ at: i + 2, key });
      i = text.indexOf(marker, i + 2);
    }
  }
  marks.sort((a, b) => a.at - b.at);
  const uniq = [];
  for (const m of marks) if (!uniq.length || uniq[uniq.length - 1].at !== m.at) uniq.push(m);
  return uniq.map((m, i) => ({
    key: m.key,
    text: text.slice(m.at, i + 1 < uniq.length ? uniq[i + 1].at - 2 : undefined),
  }));
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fileFor(ts) {
  return path.join(DIR, 'cache-' + dayKey(ts) + '.jsonl');
}

/** 清掉超期文件（每天第一次写时顺手做；失败忽略）。 */
function pruneOld(ts, keepDays) {
  const cutoff = ts - Math.max(1, Number(keepDays) || 30) * 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  for (const n of names) {
    const m = /^cache-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.unlinkSync(path.join(DIR, n)); } catch { /* 占用即跳过 */ } }
  }
}

let lastPruneDay = '';

// ── 进程内状态：用于算「距上次发送同样前缀多久」 ──────────────────────────
/** headHash -> 最近一次发送时刻 */
const headSeen = new Map();
/** chatKey -> { ts, secHashes, secLens, headHash } */
const chatLast = new Map();

/** 清理 2 小时前的记录（防止长时间运行下 Map 无限增长）。 */
function gc(now) {
  const cutoff = now - 2 * 3600 * 1000;
  for (const [k, v] of headSeen) if (v < cutoff) headSeen.delete(k);
  for (const [k, v] of chatLast) if ((v?.ts || 0) < cutoff) chatLast.delete(k);
}

/** 从 usage 取缓存命中 token（三家返回路径不同，逐个兼容——与 llm.js addUsage 同口径）。 */
export function cachedOf(usage) {
  if (!usage) return 0;
  const v = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0;
  return Number(v) || 0;
}

/**
 * 记一次 LLM 调用的缓存观测。
 *
 * @param {object} o
 * @param {string} o.chatKey       会话键（group:xxx / private:xxx）
 * @param {string} o.sessionId     本次运行 id
 * @param {string} o.model         实际模型
 * @param {number} o.round         本次运行内的第几轮
 * @param {object} o.usage         LLM 返回的原始 usage
 * @param {string} o.systemPrompt  系统提示原文
 * @param {string} o.userPrompt    用户提示原文（构建产物，不含运行时追加的配额/热度尾巴）
 * @param {number} o.sentUsrChars  实际发送的用户消息字符数（含追加尾巴）
 * @param {string} o.anchorMode    anchored / reset / none
 * @param {number} o.readChars     本轮【已读信息】段字符数
 * @param {number} o.digestChars   本轮【前情提要】段字符数
 * @param {number} o.gapSinceSessionStartMs  本次运行内距上轮调用的毫秒数（首轮为 null）
 */
export function recordCacheCall(o) {
  try {
    // 缺会话键 = 无可分析价值（不该落脏行）——旁路静默跳过
    if (!o || !o.chatKey) return;
    const now = Date.now();
    const cfg = (() => { try { return getConfig().cacheMetrics || {}; } catch { return {}; } })();
    if (cfg.enabled === false) return;

    gc(now);
    const day = dayKey(now);
    if (lastPruneDay !== day) { lastPruneDay = day; pruneOld(now, cfg.keepDays); }

    const sys = String(o.systemPrompt ?? '');
    const usr = String(o.userPrompt ?? '');
    const full = sys + '\n' + usr;
    const head = full.slice(0, HEAD_CHARS);

    const secs = splitSections(usr);
    const secHashes = {};
    const secLens = {};
    for (const s of secs) {
      secHashes[s.key] = sha1(s.text);
      secLens[s.key] = s.text.length;
    }
    // 已读两段合计 / 前情提要段长：调用方没传就从分段表推（同一真相源，不重复统计）
    const readChars = Number(o.readChars) || ((secLens.read || 0) + (secLens.readNew || 0));
    const digestChars = Number(o.digestChars) || (secLens.digest || 0);

    const headHash = sha1(head);
    const prevHeadTs = headSeen.get(headHash);
    headSeen.set(headHash, now);

    const prevChat = chatLast.get(o.chatKey);
    // 与同群上一次相比，前导连续相同的段（遇到第一个不同的段即停）
    let sameSecs = [];
    if (prevChat?.secHashes) {
      for (const s of secs) {
        if (prevChat.secHashes[s.key] !== secHashes[s.key]) break;
        sameSecs.push(s.key);
      }
    }

    const baselineTs = prevChat?.ts ?? (o.gapSinceSessionStartMs != null ? now - Number(o.gapSinceSessionStartMs) : null);

    const row = {
      ts: now,
      chat: o.chatKey,
      sid: o.sessionId,
      model: o.model || '',
      round: Number(o.round) || 0,
      promptTokens: Number(o.usage?.prompt_tokens) || 0,
      cachedTokens: cachedOf(o.usage),
      completionTokens: Number(o.usage?.completion_tokens) || 0,
      sysChars: sys.length,
      usrChars: usr.length,
      sentUsrChars: Number(o.sentUsrChars) || 0,
      sysHash: sha1(sys),
      headHash,
      headChars: head.length,
      // TTL 自然实验主判据：同样的共享前缀，距上次发送多少秒
      headGapSec: prevHeadTs ? Math.round((now - prevHeadTs) / 100) / 10 : null,
      // 同群距上一次调用的间隔（含轮内续轮）
      sameChatGapSec: prevChat ? Math.round((now - prevChat.ts) / 100) / 10 : null,
      secHashes,
      secLens,
      sameChatSameSecs: sameSecs,
      anchorMode: o.anchorMode || '',
      readChars,
      digestChars,
    };
    // 无同群前序时，退化为「距本次运行上一轮」（同会话续轮也能给出间隔）
    if (row.sameChatGapSec === null && baselineTs) {
      row.sameChatGapSec = Math.round((now - baselineTs) / 100) / 10;
      row.sameChatGapFrom = 'round';
    }

    chatLast.set(o.chatKey, { ts: now, secHashes, secLens, headHash });

    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(now), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 采集是旁路：失败绝不影响运行 */ }
}

/** 采集目录（自测 / 排查用）。 */
export function cacheMetricsDir() {
  return DIR;
}
