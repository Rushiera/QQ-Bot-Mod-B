// QQBotB 缓存命中报告 —— 一次跑完所有口径，产物落 CatTemp
//
// 用法：node tools/cache-hit-report.mjs [--since 2026-10-26] [--model deepseek-v4.1-flash]
//
// 口径（与 ref-cache-hit.md §三 一致）：
//   命中 = messages[*].raw.usage.prompt_tokens_details.cached_tokens
//          回落 prompt_cache_hit_tokens / cached_tokens
//   命中率 = Σcached / Σprompt_tokens（token 加权）
//   间隔 = 同群上一次调用的时间差；夹带数 = 中间夹了几个别的群的调用
//   公共前缀 = 相邻两轮 systemPrompt+userPrompt 逐字符比对 ÷ 1.5
//
// 输出：D:/Mau/WorkSpace/tools/CatTemp/qqbotb-cache-report.out.txt
import fs from 'node:fs';
import path from 'node:path';

const SESSIONS = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/sessions';
const OUT = 'D:/Mau/WorkSpace/tools/CatTemp/qqbotb-cache-report.out.txt';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SINCE = Date.parse(argOf('--since', '2026-10-26T00:00:00'));
const ONLY_MODEL = argOf('--model', '');

const tok = (chars) => Math.round(chars / 1.5);
const L = [];
const seg = (t) => L.push(`\n${'='.repeat(4)} ${t} ${'='.repeat(4)}`);
const rate = (list) => {
  const n = list.length;
  if (!n) return 'n=0';
  const p = list.reduce((a, c) => a + c.prompt, 0);
  const k = list.reduce((a, c) => a + c.cached, 0);
  const z = list.filter((c) => c.cached === 0).length;
  const half = list.filter((c) => c.prompt && c.cached / c.prompt >= 0.5).length;
  return `n=${String(n).padStart(4)} 命中=${(p ? (k / p) * 100 : 0).toFixed(1)}% 零命中=${String(z).padStart(3)}(${((z / n) * 100).toFixed(0)}%) 过半=${String(half).padStart(3)}(${((half / n) * 100).toFixed(0)}%)`;
};
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const cpl = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };

// ── 读数据 ──────────────────────────────────────────────────────────────
const files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));
const runs = [];       // 每个会话一条（用量 = 该会话最后一次调用）
const calls = [];      // 每次 LLM 调用
let bad = 0;
for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { bad++; continue; }
  const rows = [];
  for (const m of s.messages || []) {
    const u = m?.raw?.usage;
    if (!u) continue;
    const model = m.raw.model || s.model || '?';
    const rec = {
      t: (m.raw.created || 0) * 1000 || Number(s.startedAt) || 0,
      chatKey: s.chatKey,
      sid: s.id,
      model,
      prompt: Number(u.prompt_tokens) || 0,
      cached: Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0) || 0,
    };
    if (rec.t < SINCE) continue;
    if (ONLY_MODEL && rec.model !== ONLY_MODEL) continue;
    rows.push(rec);
    calls.push(rec);
  }
  if (!rows.length) continue;
  const sys = String(s.systemPrompt || ''), usr = String(s.userPrompt || '');
  runs.push({
    f, chatKey: s.chatKey, sid: s.id, model: s.model || '?',
    t: rows[rows.length - 1].t, firstT: rows[0].t,
    mode: s.promptAnchorMode || '?',
    sys, usr, prompt: rows[rows.length - 1].prompt, cached: rows[rows.length - 1].cached,
  });
}
calls.sort((a, b) => a.t - b.t);
runs.sort((a, b) => a.t - b.t);

L.push(`QQBotB 缓存命中报告`);
L.push(`生成时刻 ${new Date().toISOString()}｜窗口 since=${new Date(SINCE).toISOString()}${ONLY_MODEL ? `｜模型=${ONLY_MODEL}` : ''}`);
L.push(`sessions 文件 ${files.length}（坏 ${bad}）｜窗口内有调用的会话 ${runs.length}｜调用 ${calls.length}`);

if (!calls.length) {
  L.push('\n窗口内无数据——检查 --since 与用量是否已重置。');
  fs.writeFileSync(OUT, L.join('\n'), 'utf8');
  console.log('empty');
  process.exit(0);
}

// ── 1. 总量 ─────────────────────────────────────────────────────────────
seg('一、总量');
L.push(`全部: ${rate(calls)}`);
L.push(`时间范围 ${new Date(calls[0].t).toISOString()} → ${new Date(calls[calls.length - 1].t).toISOString()}`);
const byModel = {};
calls.forEach((c) => (byModel[c.model] ||= []).push(c));
L.push('按模型：');
for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) L.push(`  ${k}: ${rate(v)}`);

// ── 2. 间隔 + 夹带 ──────────────────────────────────────────────────────
seg('二、同群回访间隔 × 夹带数（决定性表）');
const lastIdx = new Map(), lastObj = new Map();
const tagged = [];
calls.forEach((c, i) => {
  const prev = lastObj.get(c.chatKey);
  const prevIdx = lastIdx.get(c.chatKey);
  tagged.push({
    ...c,
    gapSec: prev ? (c.t - prev.t) / 1000 : null,
    between: prevIdx === undefined ? null : i - prevIdx - 1,
    sameSession: prev ? prev.sid === c.sid : false,
  });
  lastIdx.set(c.chatKey, i); lastObj.set(c.chatKey, c);
});
const FINE = [[0, 20, '<20s'], [20, 40, '20-40s'], [40, 60, '40-60s'], [60, 120, '1-2min'], [120, 300, '2-5min'], [300, 600, '5-10min'], [600, 1800, '10-30min'], [1800, 3600, '30-60min'], [3600, Infinity, '>=60min']];
L.push('间隔分桶（全部有前序的调用）：');
for (const [lo, hi, name] of FINE) {
  const v = tagged.filter((c) => c.gapSec !== null && c.gapSec >= lo && c.gapSec < hi);
  if (v.length) L.push(`  ${name.padEnd(9)} ${rate(v)}`);
}
L.push('\n同间隔下按夹带数（排除同会话续轮）：');
const nonCont = tagged.filter((c) => c.gapSec !== null && !c.sameSession);
for (const [lo, hi, name] of [[0, 120, '<2min'], [120, 600, '2-10min'], [600, Infinity, '>=10min']]) {
  const g = nonCont.filter((c) => c.gapSec >= lo && c.gapSec < hi);
  if (!g.length) continue;
  L.push(`  ${name}: 夹0=${rate(g.filter((c) => c.between === 0))}`);
  L.push(`  ${' '.repeat(name.length)}  夹1-2=${rate(g.filter((c) => c.between >= 1 && c.between <= 2))}`);
  L.push(`  ${' '.repeat(name.length)}  夹>=3=${rate(g.filter((c) => c.between >= 3))}`);
}

// ── 3. 公共前缀 ─────────────────────────────────────────────────────────
seg('三、相邻两轮公共前缀（字符 / ≈token）');
const samePairs = [], crossPairs = [];
for (let i = 1; i < runs.length; i++) {
  const a = runs[i - 1], b = runs[i];
  const rec = { dSys: cpl(a.sys, b.sys), dUsr: cpl(a.usr, b.usr) };
  (a.chatKey === b.chatKey ? samePairs : crossPairs).push(rec);
}
const sumOf = (list) => list.map((p) => p.dSys + p.dUsr);
L.push(`同群相邻 n=${samePairs.length}｜公共前缀 中位 ${med(sumOf(samePairs))} 字符（≈${tok(med(sumOf(samePairs)))} tok）`);
L.push(`跨群相邻 n=${crossPairs.length}｜公共前缀 中位 ${med(sumOf(crossPairs))} 字符（≈${tok(med(sumOf(crossPairs)))} tok）`);

// 段落位置：按 "\n\n" 切段，取「段首就是该标题」的段起点字符偏移
// （不能直接 indexOf —— 引导说明正文里也提到【已读信息】【未读信息】，会误命中）
const sectionStarts = (usr) => {
  const out = {};
  let off = 0;
  for (const p of usr.split('\n\n')) {
    const t = p.trimStart();
    const m = /^【([^】]+)】/.exec(t);
    if (m && out[m[1]] === undefined) out[m[1]] = off;
    off += p.length + 2;
  }
  return out;
};
const SEC = ['角色设定（管理员设置，群友不可修改）', '可用表情包', '引导说明', '记忆', '前情提要', '已读信息', '新已读信息', '未读信息', '新加入成员', '当前时间'];
const secPos = {};
for (const r of runs) {
  const s = sectionStarts(r.usr);
  for (const k of SEC) if (s[k] !== undefined) (secPos[k] ||= []).push(s[k]);
}
L.push('分段位置（中位字符 / 出现次数）：');
for (const k of SEC) {
  const pos = secPos[k];
  L.push(`  【${k}】: ${pos ? `${med(pos)}（${pos.length}/${runs.length}）` : '未出现'}`);
}
const digestCount = (secPos['前情提要'] || []).length;
L.push(`【前情提要】出现 ${digestCount}/${runs.length}（= 已读压缩发生过的会话）`);
L.push(`用户提示长度：中位 ${med(runs.map((r) => r.usr.length))} 字符（≈${tok(med(runs.map((r) => r.usr.length)))} tok）`);
L.push(`系统提示长度：中位 ${med(runs.map((r) => r.sys.length))} 字符`);

// ── 4. 锚点模式 ─────────────────────────────────────────────────────────
seg('四、锚点模式对比');
const byMode = {};
calls.forEach((c) => {
  const r = runs.find((x) => x.sid === c.sid);
  (byMode[r?.mode || '?'] ||= []).push(c);
});
for (const [k, v] of Object.entries(byMode)) L.push(`${k}: ${rate(v)}`);

// ── 5. 压缩事件 ─────────────────────────────────────────────────────────
seg('五、已读压缩（含【前情提要】段的会话）');
const withDigest = runs.filter((r) => r.usr.includes('\n\n【前情提要'));
L.push(`会话 ${runs.length} 个，含压缩产物 ${withDigest.length}（${((withDigest.length / runs.length) * 100).toFixed(1)}%）`);
const digChat = {};
withDigest.forEach((r) => (digChat[r.chatKey] = (digChat[r.chatKey] || 0) + 1));
for (const [k, v] of Object.entries(digChat).sort((a, b) => b[1] - a[1])) L.push(`  ${k}: ${v}`);

// ── 6. 按群 ─────────────────────────────────────────────────────────────
seg('六、按群');
const byChat = {};
calls.forEach((c) => (byChat[c.chatKey] ||= []).push(c));
for (const [k, v] of Object.entries(byChat).sort((a, b) => b[1].length - a[1].length)) L.push(`${k}: ${rate(v)}`);

// ── 7. 命中率分布 ───────────────────────────────────────────────────────
seg('七、每次调用命中率分布');
const bk = { '0': 0, '(0,10%]': 0, '(10%,50%]': 0, '(50%,90%]': 0, '(90%,100%]': 0 };
calls.forEach((c) => {
  const r2 = c.prompt ? c.cached / c.prompt : 0;
  if (c.cached === 0) bk['0']++;
  else if (r2 <= 0.1) bk['(0,10%]']++;
  else if (r2 <= 0.5) bk['(10%,50%]']++;
  else if (r2 <= 0.9) bk['(50%,90%]']++;
  else bk['(90%,100%]']++;
});
for (const [k, v] of Object.entries(bk)) L.push(`${k}: ${v}（${((v / calls.length) * 100).toFixed(0)}%）`);

// ── 8. 会话首次调用 ─────────────────────────────────────────────────────
seg('八、会话首次调用（无前序可复用）');
const firsts = runs.map((r) => ({ prompt: r.prompt, cached: r.cached }));
L.push(`会话首次调用 ${rate(firsts)}`);

// ── 9. 每日趋势（按本地日聚合，供后续对比）──────────────────────────────
seg('九、每日趋势（按本地日）');
const dayAgg = {};
calls.forEach((c) => {
  const d = new Date(c.t);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  (dayAgg[key] ||= []).push(c);
});
for (const [k, v] of Object.entries(dayAgg).sort()) L.push(`${k}: ${rate(v)}`);

// ── 10. 分叉点落点（相邻同群两轮在第几段分叉）────────────────────────────
seg('十、相邻同群两轮：分叉落在哪一段');
const SEG_ORDER = ['角色设定（管理员设置，群友不可修改）', '可用表情包', '引导说明', '记忆', '已读信息', '前情提要', '新已读信息', '未读信息', '新加入成员', '当前时间'];
const forkAgg = {};
for (let i = 1; i < runs.length; i++) {
  const a = runs[i - 1], b = runs[i];
  if (a.chatKey !== b.chatKey) continue;
  const k = cpl(a.usr, b.usr);
  const pos = sectionStarts(b.usr);
  let at = '文件头之前';
  for (const name of SEG_ORDER) {
    const p = pos[name];
    if (p !== undefined && p <= k) at = `【${name}】内`;
  }
  forkAgg[at] = (forkAgg[at] || 0) + 1;
}
const forkTotal = Object.values(forkAgg).reduce((x, y) => x + y, 0);
for (const [k, v] of Object.entries(forkAgg).sort((a, b) => b[1] - a[1])) {
  L.push(`${k}: ${v}（${((v / forkTotal) * 100).toFixed(0)}%）`);
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('ok ' + calls.length + ' calls / ' + runs.length + ' sessions');
