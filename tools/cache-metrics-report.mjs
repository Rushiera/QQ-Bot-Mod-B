// 缓存采集面读端 —— 从 data/metrics/cache-*.jsonl 直接算 TTL 曲线与分叉落点
//
// 用法：node tools/cache-metrics-report.mjs [--since 2026-10-26] [--days 7]
//
// 为什么需要它：采集行里的 headGapSec 是「同一段共享前缀距上次发送多少秒」——
// 所有群的前缀头部完全相同，于是每一次调用天然就是一次 TTL 探针。跑几天后
// 直接按 headGapSec 分桶看 cachedTokens/promptTokens，就能反推上游缓存的分层
// 衰减曲线，不需要另做控制实验。
//
// 产物：D:/Mau/WorkSpace/tools/CatTemp/qqbotb-cachemetrics-report.out.txt
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/metrics';
const OUT = 'D:/Mau/WorkSpace/tools/CatTemp/qqbotb-cachemetrics-report.out.txt';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SINCE = Date.parse(argOf('--since', '2026-10-26T00:00:00'));
const DAYS = Number(argOf('--days', '0')) || 0;

const L = [];
const seg = (t) => L.push(`\n${'='.repeat(4)} ${t} ${'='.repeat(4)}`);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rate = (rows) => {
  const n = rows.length;
  if (!n) return 'n=0';
  const p = rows.reduce((s, r) => s + r.promptTokens, 0);
  const c = rows.reduce((s, r) => s + r.cachedTokens, 0);
  const z = rows.filter((r) => r.cachedTokens === 0).length;
  return `n=${String(n).padStart(4)} 命中=${(p ? (c / p) * 100 : 0).toFixed(1)}% 零命中=${String(z).padStart(3)}(${((z / n) * 100).toFixed(0)}%)`;
};

// ── 读 ─────────────────────────────────────────────────────────────────────
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^cache-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : [];
if (!files.length) {
  console.log('采集文件尚未生成（data/metrics/cache-YYYY-MM-DD.jsonl）——先让业务面跑起来。');
  process.exit(0);
}
const cutoff = DAYS ? Date.now() - DAYS * 86400000 : SINCE;
const rows = [];
let bad = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { bad++; continue; }
    if (!(r.ts >= cutoff)) continue;
    rows.push(r);
  }
}
rows.sort((a, b) => a.ts - b.ts);

L.push('QQBotB 缓存采集面报告');
L.push(`采集文件 ${files.length} 个（${files[0]} → ${files[files.length - 1]}）· 解析失败 ${bad}`);
L.push(`窗口 since=${new Date(cutoff).toISOString()}｜落盘行 ${rows.length}`);
if (!rows.length) { fs.writeFileSync(OUT, L.join('\n'), 'utf8'); console.log('窗口内无数据'); process.exit(0); }
L.push(`时间范围 ${new Date(rows[0].ts).toISOString()} → ${new Date(rows[rows.length - 1].ts).toISOString()}`);

// ── 一、总量 ───────────────────────────────────────────────────────────────
seg('一、总量');
L.push(`全部：${rate(rows)}`);
const byModel = {};
rows.forEach((r) => (byModel[r.model || '?'] ||= []).push(r));
L.push('按模型：');
for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) L.push(`  ${k}：${rate(v)}`);

// ── 二、TTL 曲线（核心：headGapSec × 命中）────────────────────────────────
seg('二、TTL 曲线（共享前缀距上次发送的间隔 → 命中）');
L.push('判据：headGapSec = 同一段前 4096 字符的指纹，距上次发送同样指纹多少秒');
L.push('（所有群前缀头部相同 → 每次调用都是一次 TTL 探针，不需要控制实验）');
const GAPS = [
  [0, 5, '<5s'], [5, 10, '5-10s'], [10, 20, '10-20s'], [20, 30, '20-30s'], [30, 60, '30-60s'],
  [60, 120, '1-2min'], [120, 300, '2-5min'], [300, 600, '5-10min'], [600, 1800, '10-30min'],
  [1800, 3600, '30-60min'], [3600, 21600, '1-6h'], [21600, Infinity, '>=6h'],
];
const valid = rows.filter((r) => typeof r.headGapSec === 'number' && r.headGapSec >= 0);
L.push(`有前序的调用 ${valid.length}/${rows.length}`);
for (const [lo, hi, name] of GAPS) {
  const v = valid.filter((r) => r.headGapSec >= lo && r.headGapSec < hi);
  if (v.length) L.push(`  ${name.padEnd(9)} ${rate(v)}`);
}

// ── 三、同群间隔（对照：整段前缀的角度）──────────────────────────────────
seg('三、同群间隔 → 命中（整段前缀，与 headGapSec 对照）');
const validChat = rows.filter((r) => typeof r.sameChatGapSec === 'number');
for (const [lo, hi, name] of GAPS) {
  const v = validChat.filter((r) => r.sameChatGapSec >= lo && r.sameChatGapSec < hi);
  if (v.length) L.push(`  ${name.padEnd(9)} ${rate(v)}`);
}

// ── 四、同群逐段相同情况（分叉落点）──────────────────────────────────────
seg('四、分叉落点：与同群上一轮相比，前导连续相同的段');
const withPrev = rows.filter((r) => Array.isArray(r.sameChatSameSecs) && r.sameChatGapFrom !== 'round');
const ORDER = ['role', 'sticker', 'guide', 'memory', 'digest', 'read', 'readNew', 'unread', 'newMember', 'active', 'time'];
const forkAgg = {};
for (const r of withPrev) {
  const same = r.sameChatSameSecs;
  // 分叉点 = 第一个不在 same 里的段
  const next = ORDER.find((k) => !same.includes(k) && r.secHashes && r.secHashes[k] !== undefined);
  const key = next || '全同（无分叉）';
  forkAgg[key] = (forkAgg[key] || 0) + 1;
}
const forkTotal = Object.values(forkAgg).reduce((a, b) => a + b, 0);
L.push(`有同群前序的调用 ${withPrev.length}`);
for (const [k, v] of Object.entries(forkAgg).sort((a, b) => b[1] - a[1])) {
  L.push(`  分叉在【${k}】：${v}（${((v / forkTotal) * 100).toFixed(0)}%）`);
}

// ── 五、逐段「本轮是否变化」（不依赖前序，全量可算）─────────────────────
seg('五、逐段变化率（与同群上一轮相比，该段是否变）');
const segChange = {};
for (const r of withPrev) {
  for (const k of ORDER) {
    if (!r.secHashes || r.secHashes[k] === undefined) continue;
    segChange[k] ||= { n: 0, changed: 0, lens: [] };
    segChange[k].n++;
    if (!r.sameChatSameSecs.includes(k)) segChange[k].changed++;
    if (r.secLens && r.secLens[k]) segChange[k].lens.push(r.secLens[k]);
  }
}
for (const k of ORDER) {
  const v = segChange[k];
  if (!v) { L.push(`  ${k}：未出现`); continue; }
  L.push(`  ${k.padEnd(10)} 变 ${String(v.changed).padStart(4)}/${String(v.n).padStart(4)}（${((v.changed / v.n) * 100).toFixed(0)}%）· 段长中位 ${med(v.lens)} 字符`);
}

// ── 六、锚点模式 ───────────────────────────────────────────────────────────
seg('六、锚点模式 × 命中');
const byMode = {};
rows.forEach((r) => (byMode[r.anchorMode || '?'] ||= []).push(r));
for (const [k, v] of Object.entries(byMode)) L.push(`${k}：${rate(v)}`);

// ── 七、prompt 体量与命中 ─────────────────────────────────────────────────
seg('七、prompt 体量分桶 × 命中（分母视角）');
const SIZES = [[0, 10000, '<10k 字符'], [10000, 20000, '10-20k'], [20000, 40000, '20-40k'], [40000, 80000, '40-80k'], [80000, Infinity, '>=80k']];
const totalChars = rows.map((r) => (r.sysChars || 0) + (r.usrChars || 0));
L.push(`prompt 总字符（sys+usr）：中位 ${med(totalChars)} · p95 ${pct(totalChars, 0.95)} · max ${Math.max(...totalChars)}`);
for (const [lo, hi, name] of SIZES) {
  const v = rows.filter((r) => { const c = (r.sysChars || 0) + (r.usrChars || 0); return c >= lo && c < hi; });
  if (v.length) L.push(`  ${name.padEnd(12)} ${rate(v)}`);
}

// ── 八、按群 ───────────────────────────────────────────────────────────────
seg('八、按群');
const byChat = {};
rows.forEach((r) => (byChat[r.chat] ||= []).push(r));
for (const [k, v] of Object.entries(byChat).sort((a, b) => b[1].length - a[1].length)) L.push(`${k}：${rate(v)}`);

// ── 九、按天趋势 ───────────────────────────────────────────────────────────
seg('九、按天趋势');
const byDay = {};
rows.forEach((r) => {
  const d = new Date(r.ts);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  (byDay[key] ||= []).push(r);
});
for (const [k, v] of Object.entries(byDay).sort()) L.push(`${k}：${rate(v)}`);

// ── 十、TTL 拐点定位（哪一段开始掉）──────────────────────────────────────
seg('十、TTL 拐点（按 10 秒粒度找命中率下降最陡的位置）');
const FINE = [];
for (let s = 0; s < 120; s += 10) FINE.push([s, s + 10, `${s}-${s + 10}s`]);
for (let s = 120; s < 600; s += 60) FINE.push([s, s + 60, `${s / 60}-${(s + 60) / 60}min`]);
const fineRows = [];
for (const [lo, hi, name] of FINE) {
  const v = valid.filter((r) => r.headGapSec >= lo && r.headGapSec < hi);
  if (v.length < 5) { fineRows.push({ name, n: v.length, r: null }); continue; }
  const p = v.reduce((s, x) => s + x.promptTokens, 0);
  const c = v.reduce((s, x) => s + x.cachedTokens, 0);
  fineRows.push({ name, n: v.length, r: p ? c / p : 0 });
}
let prev = null;
for (const x of fineRows) {
  const mark2 = x.r !== null && prev !== null && prev - x.r > 0.25 ? '  ← 陡降' : '';
  L.push(`  ${x.name.padEnd(10)} n=${String(x.n).padStart(4)} ${x.r === null ? '（样本不足）' : (x.r * 100).toFixed(1) + '%'}${mark2}`);
  if (x.r !== null) prev = x.r;
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('ok ' + rows.length + ' rows');
