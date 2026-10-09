// analyze-qqagent-chatter.mjs — 发言频率体检（只读）
//
// 用法：node tools/analyze-qqagent-chatter.mjs
// 读什么：_unpack/data/messages/group_*.json（存档——群友消息 + bot 消息 + 时间戳）
// 输出什么：每群——消息总数 / bot 占比 / **群友块被接话率** / bot 单块条数 / 发言间隔分位 / 时段分布
//
// 用途：调发言频率时的量化基线——「每句都回」看"被接话率"，闹不闹腾看"bot 占比 + 间隔分位"。
// 判据参考：被接话率 ≈ 100% = 每句都回；bot 条数 ≥ 群友条数 = 话比人还多。
// 边界：只读，不写任何文件；不调用 LLM。

import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\data\\messages';
const files = fs.readdirSync(DIR).filter((f) => f.startsWith('group_') && f.endsWith('.json')).sort();
const mmss = (ms) => Math.round(ms / 1000) + 's';

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const msgs = (d.messages || []).filter((m) => m && m.ts);
  if (!msgs.length) { console.log('=== ' + f + ' === (空)'); continue; }
  const self = msgs.filter((m) => m.self);
  const others = msgs.filter((m) => !m.self);
  const t0 = msgs[0].ts;
  const t1 = msgs[msgs.length - 1].ts;

  const segs = [];
  for (const m of msgs) {
    const side = m.self ? 'bot' : 'other';
    const last = segs[segs.length - 1];
    if (last && last.side === side) { last.n += 1; } else { segs.push({ side, n: 1 }); }
  }
  const otherSegs = segs.filter((s) => s.side === 'other').length;
  let replied = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].side === 'other' && segs[i + 1] && segs[i + 1].side === 'bot') replied += 1;
  }
  const botSegs = segs.filter((s) => s.side === 'bot').map((s) => s.n);
  const gaps = [];
  for (let i = 1; i < self.length; i++) gaps.push(self[i].ts - self[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const p = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : 0);
  const byHour = {};
  for (const m of self) { const h = new Date(m.ts).getHours(); byHour[h] = (byHour[h] || 0) + 1; }

  console.log('=== ' + f + ' ===');
  console.log('  首 ' + new Date(t0).toISOString().slice(5, 16).replace('T', ' ') + ' → 末 ' + new Date(t1).toISOString().slice(5, 16).replace('T', ' ') + ' · 跨度 ' + ((t1 - t0) / 3600000).toFixed(1) + 'h');
  console.log('  消息 ' + msgs.length + '（群友 ' + others.length + ' / bot ' + self.length + '）');
  console.log('  群友块 ' + otherSegs + ' → 被接话 ' + replied + '（' + Math.round((replied / Math.max(1, otherSegs)) * 100) + '%）');
  console.log('  bot 块 ' + botSegs.length + ' · 单块条数 max ' + (botSegs.length ? Math.max.apply(null, botSegs) : 0) + ' / avg ' + (botSegs.reduce((a, b) => a + b, 0) / Math.max(1, botSegs.length)).toFixed(2));
  console.log('  bot 发言间隔 p25 ' + mmss(p(0.25)) + ' / p50 ' + mmss(p(0.5)) + ' / p75 ' + mmss(p(0.75)) + ' / max ' + mmss(gaps.length ? gaps[gaps.length - 1] : 0));
  console.log('  bot 发言时段 ' + Object.keys(byHour).sort((a, b) => a - b).map((h) => h + '时×' + byHour[h]).join(' '));
  console.log('');
}
