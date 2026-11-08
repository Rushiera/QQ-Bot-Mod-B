// 芳乃卡三群自发言统计——语气词 / 语尾 / 假名 占比观测位点（常驻工具 · 2026-11-08 立）
//
// 用法：node tools/yoshino-interject-stat.mjs [dump]
//   dump = 追加打印三群末 40 条（时间 + 起头语气词 + 前 26 字），用于人工核对口径
// 口径：self=true 且有 text 的消息；同 ts+text 去重；按 ts 升序。
//   ① 全量表：整段历史（含 R喵 期）——只作背景，不能代表当卡行为
//   ② 窗口表：末 200 / 100 / 50 条——看趋势
//   ③ 芳乃期表：112562956 取「末条 R喵 特征之后」，361820329 取「首条芳乃发言起」，1135074533 全量
//      —— 这一张是判据表：`おや` 起头占比应降、语尾载体（呢——/是也——）占比应升、でして 在中文正文里恒 0
// 判例：design-qqbotb_log.md §一百一十五（改前：芳乃期 82 条里语气词起头 37.8%、うち おや 61%、语尾载体 13.4%）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/messages';
const GROUPS = ['112562956', '1135074533', '361820329'];

// 语气词（日文假名 + 中文音译，按卡 §17.1 对照）
const INTERJ = ['おや', '哦呀', '噢呀', 'あら', '哎呀', '啊啦', 'ふふ', '呵呵', 'ほー', 'ほう', 'ふむ', '唔', '嗯'];
const OPEN_RE = new RegExp('^(' + INTERJ.join('|') + ')');
const END_CARRIER_RE = /(呢|是也)\s*(——|—|」|。|！|！|？|\?|…)?\s*$/;
const BARE_DASH_RE = /ー[」』）)]?\s*$/;
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/;

/** 收一个文件里的 self 消息。 */
function collect(file) {
  if (!fs.existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.messages) ? raw.messages : []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && m.self === true && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ ts: Number(m.ts) || 0, text: m.text.trim() }));
}

/** 单群全量（现档 + 存档）。 */
function groupMsgs(id) {
  const files = [path.join(ROOT, `group_${id}.json`)];
  const ad = path.join(ROOT, 'archive');
  if (fs.existsSync(ad)) {
    for (const f of fs.readdirSync(ad)) {
      if (f.startsWith(`group_${id}_`) && f.endsWith('.json')) files.push(path.join(ad, f));
    }
  }
  const all = files.flatMap(collect);
  const seen = new Set();
  const uniq = [];
  for (const m of all.sort((a, b) => a.ts - b.ts)) {
    const k = `${m.ts}|${m.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(m);
  }
  return uniq;
}

/** 一组的统计。 */
function stat(msgs) {
  const n = msgs.length;
  const c = (f) => msgs.filter(f).length;
  const interj = {};
  for (const m of msgs) {
    const hit = m.text.match(OPEN_RE);
    if (hit) interj[hit[1]] = (interj[hit[1]] || 0) + 1;
  }
  // 最长连续同款开场
  let run = 0, best = 0, bestWord = '';
  let prev = null;
  for (const m of msgs) {
    const hit = m.text.match(OPEN_RE);
    const w = hit ? hit[1] : null;
    if (w && w === prev) { run += 1; } else { run = w ? 1 : 0; }
    if (run > best) { best = run; bestWord = w || ''; }
    prev = w;
  }
  return {
    n,
    openInterj: c((m) => OPEN_RE.test(m.text)),
    anyInterj: c((m) => INTERJ.some((w) => m.text.includes(w))),
    deshite: c((m) => m.text.includes('でして')),
    carrier: c((m) => END_CARRIER_RE.test(m.text)),
    bareDash: c((m) => BARE_DASH_RE.test(m.text)),
    jpLine: c((m) => KANA_RE.test(m.text)),
    rmiao: c((m) => /ᓚᘏᗢ|本喵|喵娘/.test(m.text)),
    maxRun: best,
    maxRunWord: bestWord,
    interj
  };
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
const rows = [];
let all = [];
for (const id of GROUPS) {
  const msgs = groupMsgs(id);
  all = all.concat(msgs);
  rows.push([id, stat(msgs)]);
}
rows.push(['合计', stat(all)]);

const out = [];
out.push('| 群 | 自发言 | 语气词起头 | 含语气词 | でして | 语尾载体(呢/是也) | 裸ー收尾 | 含假名行 | 最长连发同款 |');
out.push('|:--|--:|--:|--:|--:|--:|--:|--:|:--|');
for (const [id, s] of rows) {
  out.push(`| ${id} | ${s.n} | ${s.openInterj} (${pct(s.openInterj, s.n)}) | ${s.anyInterj} (${pct(s.anyInterj, s.n)}) | ${s.deshite} | ${s.carrier} (${pct(s.carrier, s.n)}) | ${s.bareDash} (${pct(s.bareDash, s.n)}) | ${s.jpLine} (${pct(s.jpLine, s.n)}) | ${s.maxRun} ×「${s.maxRunWord}」 |`);
}
out.push('');
out.push('起头语气词分布：');
for (const [id, s] of rows) {
  const e = Object.entries(s.interj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · ');
  out.push(`- ${id}：${e || '（无）'}`);
}
console.log(out.join('\n'));

// ── 窗口口径：当前行为看最近 N 条，不受历史 R喵 期稀释 ──
const win = [200, 100, 50];
const out2 = [];
out2.push('\n| 群 · 窗口 | 自发言 | 语气词起头 | 含语气词 | でして | 语尾载体 | 裸ー收尾 | 含假名行 |');
out2.push('|:--|--:|--:|--:|--:|--:|--:|--:|');
for (const id of GROUPS) {
  const msgs = groupMsgs(id);
  for (const w of win) {
    const seg = msgs.slice(-w);
    const s = stat(seg);
    out2.push(`| ${id} · 末${w} | ${s.n} | ${s.openInterj} (${pct(s.openInterj, s.n)}) | ${s.anyInterj} (${pct(s.anyInterj, s.n)}) | ${s.deshite} | ${s.carrier} (${pct(s.carrier, s.n)}) | ${s.bareDash} (${pct(s.bareDash, s.n)}) | ${s.jpLine} (${pct(s.jpLine, s.n)}) |`);
  }
}
console.log(out2.join('\n'));

// ── 芳乃期（尾段法）：从末尾往回走，连续的「芳乃味」消息算作当期 ──
const flavored = (t) => !/喵|ᓚᘏᗢ/.test(t) && /ー|吶|在下|おや|哦呀|あら|ふふ|ふむ|呢|そなた|わたくし/.test(t);
const out4 = [];
out4.push('\n| 群 | 芳乃期起点（尾段法） | 当期自发言 | 语气词起头 | 含语气词 | でして | 语尾载体 | 裸ー收尾 | 含假名行 |');
out4.push('|:--|:--|--:|--:|--:|--:|--:|--:|--:|');
for (const id of GROUPS) {
  const msgs = groupMsgs(id);
  let start = 0;
  if (id === '112562956') {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (/喵|ᓚᘏᗢ/.test(msgs[i].text)) { start = i + 1; break; }
    }
  } else if (id === '361820329') {
    const k = msgs.findIndex((m) => m.text.startsWith('おや，这是叫我看什么呢'));
    start = k >= 0 ? k : msgs.length;
  }
  const era = msgs.slice(start);
  const s = stat(era);
  out4.push(`| ${id} | ${era.length ? new Date(era[0].ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ') : '—'} | ${s.n} | ${s.openInterj} (${pct(s.openInterj, s.n)}) | ${s.anyInterj} (${pct(s.anyInterj, s.n)}) | ${s.deshite} | ${s.carrier} (${pct(s.carrier, s.n)}) | ${s.bareDash} (${pct(s.bareDash, s.n)}) | ${s.jpLine} (${pct(s.jpLine, s.n)}) |`);
}
console.log(out4.join('\n'));

const fmtTs = (ts) => {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(5, 16).replace('T', ' ');
};

if (process.argv.includes('dump')) {
  const fmt = (ts) => {
    const d = new Date(ts + 8 * 3600 * 1000);
    return d.toISOString().slice(5, 16).replace('T', ' ');
  };
  for (const id of GROUPS) {
    const msgs = groupMsgs(id).slice(-40);
    console.log(`\n### ${id} 末 40 条`);
    for (const m of msgs) {
      const op = (m.text.match(OPEN_RE) || [, '·'])[1];
      console.log(`${fmt(m.ts)} | ${op} | ${m.text.replace(/\n/g, ' / ').slice(0, 26)}`);
    }
  }
}
