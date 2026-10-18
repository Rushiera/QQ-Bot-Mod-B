// QQBotB 缓存诊断 v3：时间聚集性 / 会话内相邻轮 / 按群统计
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/sessions';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const SINCE = Date.parse('2026-10-15T00:00:00Z');

const rows = [];
for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!s.startedAt || s.startedAt < SINCE) continue;
  const calls = [];
  (s.messages || []).forEach((m) => {
    const u = m?.raw?.usage;
    if (!u) return;
    calls.push({
      t: (m.raw.created || 0) * 1000,
      model: m.raw.model || s.model,
      prompt: Number(u.prompt_tokens) || 0,
      cached: Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0
    });
  });
  rows.push({ id: s.id, chatKey: s.chatKey, startedAt: s.startedAt, model: s.model, calls });
}
rows.sort((a, b) => a.startedAt - b.startedAt);

const L = [];
const all = rows.flatMap((r) => r.calls);
L.push(`总调用 ${all.length}，命中率 ${(all.reduce((a, c) => a + c.cached, 0) / all.reduce((a, c) => a + c.prompt, 0) * 100).toFixed(1)}%`);

// 1) 按 10 分钟窗口
L.push('\n=== 按 10 分钟窗口 ===');
const win = {};
all.forEach((c) => {
  const k = new Date(c.t).toISOString().slice(5, 15) + '0';
  (win[k] ||= []).push(c);
});
for (const k of Object.keys(win).sort()) {
  const list = win[k];
  const p = list.reduce((a, c) => a + c.prompt, 0), kk = list.reduce((a, c) => a + c.cached, 0);
  const z = list.filter((c) => c.cached === 0).length;
  L.push(`${k} calls=${String(list.length).padStart(3)} zero=${String(z).padStart(3)} rate=${(p ? kk / p * 100 : 0).toFixed(1)}%`);
}

// 2) 会话内相邻轮
L.push('\n=== 会话内相邻轮：前缀增量小(<600tok)时后轮是否命中 ===');
let small = 0, smallZero = 0, smallHit = 0;
for (const r of rows) {
  for (let i = 1; i < r.calls.length; i++) {
    const a = r.calls[i - 1], b = r.calls[i];
    const d = b.prompt - a.prompt;
    if (d >= 0 && d < 600) {
      small++;
      if (b.cached === 0) smallZero++; else smallHit++;
    }
  }
}
L.push(`增量<600 的相邻轮: ${small} 次，其中后轮零命中 ${smallZero}，有命中 ${smallHit}（零命中率 ${(smallZero / small * 100).toFixed(1)}%）`);

// 3) 会话首次调用命中（= 与历史会话前缀一致却仍可能 miss）
const firsts = rows.filter((r) => r.calls.length).map((r) => r.calls[0]);
const fz = firsts.filter((c) => c.cached === 0).length;
L.push(`\n会话首次调用: ${firsts.length} 次，零命中 ${fz}（${(fz / firsts.length * 100).toFixed(1)}%）`);

// 4) 按群
L.push('\n=== 按 chatKey ===');
const byChat = {};
all.forEach((c) => {});
const chatOf = new Map();
rows.forEach((r) => r.calls.forEach((c) => chatOf.set(c, r.chatKey)));
for (const c of all) (byChat[chatOf.get(c)] ||= []).push(c);
for (const [ck, list] of Object.entries(byChat)) {
  const p = list.reduce((a, c) => a + c.prompt, 0), kk = list.reduce((a, c) => a + c.cached, 0);
  L.push(`${ck} calls=${String(list.length).padStart(4)} rate=${(p ? kk / p * 100 : 0).toFixed(1)}%`);
}

// 5) 命中 token 数分布（看命中是否是"全有或全无"）
L.push('\n=== 命中率分布（每次调用）===');
const buckets = { '0': 0, '(0,10%]': 0, '(10%,50%]': 0, '(50%,90%]': 0, '(90%,100%]': 0 };
all.forEach((c) => {
  const r = c.prompt ? c.cached / c.prompt : 0;
  if (c.cached === 0) buckets['0']++;
  else if (r <= 0.1) buckets['(0,10%]']++;
  else if (r <= 0.5) buckets['(10%,50%]']++;
  else if (r <= 0.9) buckets['(50%,90%]']++;
  else buckets['(90%,100%]']++;
});
for (const [k, v] of Object.entries(buckets)) L.push(`${k}: ${v}`);

fs.writeFileSync('D:/Mau/WorkSpace/CatTemp/qqbotb-cache-diag3.out.txt', L.join('\n'), 'utf8');
console.log('ok ' + L.length);
