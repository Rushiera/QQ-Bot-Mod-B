// cache-diag-recalibrate.mjs — 缓存基线重标定（R2-L2 · D3「合并后重跑 cache-diag」的脚本化）
//
// 用法：
//   node tools/cache-diag-recalibrate.mjs                 # 计算 → 与旧基线比 → 写新基线
//   node tools/cache-diag-recalibrate.mjs --no-write      # 只比不写（CI / 复跑用）
//   node tools/cache-diag-recalibrate.mjs --since 2026-10-15 --data <sessions 目录>
//
// 口径：与 tools/cache-diag.mjs v3 完全一致（同一字段、同一 SINCE 默认值）——
//   每次调用取 m.raw.usage.prompt_tokens / prompt_tokens_details.cached_tokens
//   （回落 prompt_cache_hit_tokens）；会话取 startedAt >= SINCE。
// 产物（路径固定）：tools/cache-baseline.json；旧基线自动备份为 tools/cache-baseline.prev.json。
// 退出码：0 正常 · 2 环境/参数错误（目录缺失、--since 不可解析、基线损坏）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function die(msg) {
  console.error(`ERR|CACHE_RECALIBRATE|${msg}`);
  process.exit(2);
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) die(`${name} 缺值`);
  return v;
}

const NO_WRITE = process.argv.includes('--no-write');
const SINCE_RAW = arg('--since', '2026-10-15');
const SINCE = Date.parse(SINCE_RAW.length === 10 ? `${SINCE_RAW}T00:00:00Z` : SINCE_RAW);
if (!Number.isFinite(SINCE)) die(`--since 无法解析：${SINCE_RAW}`);

const SESSIONS = path.resolve(arg('--data', path.join(REPO, '_unpack', 'data', 'sessions')));
const BASELINE = path.resolve(arg('--baseline', path.join(HERE, 'cache-baseline.json')));
const PREV = BASELINE.replace(/\.json$/i, '') + '.prev.json';

/** 扫描会话目录，产出指标 + 按群明细。 */
function collect() {
  if (!fs.existsSync(SESSIONS)) die(`会话目录不存在：${SESSIONS}`);
  const files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));
  const rows = [];
  let unreadable = 0;
  let tooOld = 0;
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
    } catch {
      unreadable += 1;
      continue;
    }
    if (!s.startedAt || s.startedAt < SINCE) {
      tooOld += 1;
      continue;
    }
    const calls = [];
    for (const m of s.messages || []) {
      const u = m?.raw?.usage;
      if (!u) continue;
      const prompt = Number(u.prompt_tokens) || 0;
      const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0;
      calls.push({ prompt, cached });
    }
    if (!calls.length) continue;
    rows.push({ chatKey: s.chatKey || '(none)', calls });
  }

  const all = rows.flatMap((r) => r.calls);
  const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);
  const prompt = sum(all, 'prompt');
  const cached = sum(all, 'cached');
  const zero = all.filter((c) => c.cached === 0).length;
  const firsts = rows.map((r) => r.calls[0]);
  const firstZero = firsts.filter((c) => c.cached === 0).length;

  const byChat = {};
  for (const r of rows) (byChat[r.chatKey] ||= []).push(...r.calls);
  const chat = {};
  for (const [k, list] of Object.entries(byChat)) {
    const p = sum(list, 'prompt');
    chat[k] = { calls: list.length, hitRate: p ? round(sum(list, 'cached') / p * 100) : 0 };
  }

  return {
    sessions: rows.length,
    sessionFiles: files.length,
    unreadable,
    tooOld,
    calls: all.length,
    promptTokens: prompt,
    cachedTokens: cached,
    hitRate: prompt ? round(cached / prompt * 100) : 0,
    zeroCalls: zero,
    zeroRate: all.length ? round(zero / all.length * 100) : 0,
    firstCalls: firsts.length,
    firstZeroRate: firsts.length ? round(firstZero / firsts.length * 100) : 0,
    byChat: chat
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function readBaseline(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(`基线文件损坏：${p}（${e.message}）`);
    return null;
  }
}

const m = collect();
const prev = readBaseline(BASELINE);

const L = [];
L.push('=== cache-diag recalibrate（口径 = cache-diag.mjs v3）===');
L.push(`数据目录   ${SESSIONS}`);
L.push(`SINCE      ${new Date(SINCE).toISOString()}`);
L.push(`会话        ${m.sessions} 个（读入 ${m.sessionFiles} 文件 / 过旧 ${m.tooOld} / 不可解析 ${m.unreadable}）`);
L.push(`调用        ${m.calls} 次`);
L.push(`命中率      ${m.hitRate}%   （cached ${m.cachedTokens} / prompt ${m.promptTokens}）`);
L.push(`零命中      ${m.zeroCalls} 次（${m.zeroRate}%）`);
L.push(`首次调用零命中 ${m.firstZeroRate}%（${m.firstCalls} 次首次调用）`);
L.push('');

if (!prev) {
  L.push('对比        无旧基线（本次为首次基线）');
} else {
  const pm = prev.metrics || prev;
  const dHR = round(m.hitRate - (Number(pm.hitRate) || 0));
  const dZR = round(m.zeroRate - (Number(pm.zeroRate) || 0));
  const dCalls = m.calls - (Number(pm.calls) || 0);
  L.push(`对比旧基线  ${prev.at || '(未记时间)'} · since ${prev.since || '?'}`);
  L.push(`  命中率     ${pm.hitRate}% → ${m.hitRate}%   delta ${dHR >= 0 ? '+' : ''}${dHR} pp`);
  L.push(`  零命中率   ${pm.zeroRate}% → ${m.zeroRate}%   delta ${dZR >= 0 ? '+' : ''}${dZR} pp`);
  L.push(`  调用数     ${pm.calls} → ${m.calls}   delta ${dCalls >= 0 ? '+' : ''}${dCalls}`);
}

const payload = {
  version: 1,
  tool: 'cache-diag-recalibrate.mjs',
  caliber: 'cache-diag.mjs v3（prompt_tokens / prompt_tokens_details.cached_tokens → prompt_cache_hit_tokens 回落）',
  at: new Date().toISOString(),
  since: new Date(SINCE).toISOString(),
  dataDir: SESSIONS,
  metrics: m,
  prevHitRate: prev ? (prev.metrics || prev).hitRate ?? null : null
};

if (NO_WRITE) {
  L.push('');
  L.push('写入        --no-write：基线未落盘');
} else {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (fs.existsSync(BASELINE)) {
    fs.writeFileSync(PREV, fs.readFileSync(BASELINE));
    L.push('');
    L.push(`写入        旧基线 → ${path.relative(REPO, PREV)}`);
  } else {
    L.push('');
  }
  fs.writeFileSync(BASELINE, body, 'utf8');
  L.push(`写入        新基线 → ${path.relative(REPO, BASELINE)}（${body.length} 字节）`);
}

console.log(L.join('\n'));
