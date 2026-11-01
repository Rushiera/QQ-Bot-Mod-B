// B31 判据统计 —— 读 engage metrics 两日样本，出 roll / blocked 分布（一次性分析脚本）
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.log('ERR need dir'); process.exit(2); }
const files = fs.readdirSync(dir).filter((n) => /^engage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
const out = { files: [], rows: 0, byEvent: {}, roll: {}, blocked: {}, sent: {}, other: {} };

const rollByLevel = new Map();
const rollByChat = new Map();
const blockedByGate = new Map();
const blockByLevel = new Map();
let hit = 0, miss = 0, idleHit = 0, idleTotal = 0, dueHit = 0, dueTotal = 0;
let rateMismatch = 0;
let unreadHitSum = 0, unreadMissSum = 0, unreadHitN = 0, unreadMissN = 0;
let tsMin = Infinity, tsMax = 0;

for (const f of files) {
  const p = path.join(dir, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    n += 1;
    out.rows += 1;
    const ev = String(r.event || '(none)');
    out.byEvent[ev] = (out.byEvent[ev] || 0) + 1;
    if (r.ts) { tsMin = Math.min(tsMin, r.ts); tsMax = Math.max(tsMax, r.ts); }
    if (ev === 'roll') {
      const lv = Number(r.level) || 0;
      const rate = Number(r.rate);
      if (!rollByLevel.has(lv)) rollByLevel.set(lv, { n: 0, hit: 0, rate, rates: new Set() });
      const b = rollByLevel.get(lv);
      b.n += 1; b.rates.add(rate);
      if (r.hit === true) b.hit += 1;
      const chat = String(r.chat || '');
      if (!rollByChat.has(chat)) rollByChat.set(chat, { n: 0, hit: 0, level: lv });
      const c = rollByChat.get(chat);
      c.n += 1; if (r.hit === true) c.hit += 1; c.level = lv;
      if (r.hit === true) { hit += 1; } else { miss += 1; }
      if (Number(r.roll) >= 1 && Number(r.rate) < 1 && Number(r.rate) > 0) rateMismatch += 1;
      if (r.idle === true) { idleTotal += 1; if (r.hit === true) idleHit += 1; } else { dueTotal += 1; if (r.hit === true) dueHit += 1; }
      const u = Number(r.unread) || 0;
      if (r.hit === true) { unreadHitSum += u; unreadHitN += 1; } else { unreadMissSum += u; unreadMissN += 1; }
    } else if (ev === 'blocked') {
      const g = String(r.gate || '(none)');
      blockedByGate.set(g, (blockedByGate.get(g) || 0) + 1);
      const lv = Number(r.level) || 0;
      blockByLevel.set(lv, (blockByLevel.get(lv) || 0) + 1);
    } else if (ev === 'sent') {
      const lv = Number(r.level) || 0;
      out.sent.n = (out.sent.n || 0) + 1;
      out.sent['lv' + lv] = (out.sent['lv' + lv] || 0) + 1;
    } else {
      out.other[ev] = (out.other[ev] || 0) + 1;
    }
  }
  out.files.push({ file: f, lines: n });
}

out.roll = {
  total: hit + miss, hit, miss,
  hitRate: (hit + miss) ? +(hit / (hit + miss)).toFixed(4) : null,
  idle: { total: idleTotal, hit: idleHit, hitRate: idleTotal ? +(idleHit / idleTotal).toFixed(4) : null },
  due: { total: dueTotal, hit: dueHit, hitRate: dueTotal ? +(dueHit / dueTotal).toFixed(4) : null },
  unread: {
    hitAvg: unreadHitN ? +(unreadHitSum / unreadHitN).toFixed(2) : null,
    missAvg: unreadMissN ? +(unreadMissSum / unreadMissN).toFixed(2) : null
  },
  rateMismatch,   // roll 值 >= 1 但 rate 非 0/1（理论上不该出现）
  byLevel: [...rollByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lv, v]) => ({
    level: lv, n: v.n, hit: v.hit,
    hitRate: +(v.hit / v.n).toFixed(4),
    configuredRate: [...v.rates].join(',')
  })),
  byChat: [...rollByChat.entries()].map(([chat, v]) => ({
    chat, level: v.level, n: v.n, hit: v.hit, hitRate: +(v.hit / v.n).toFixed(4)
  })).sort((a, b) => b.n - a.n)
};
out.blocked = {
  total: [...blockedByGate.values()].reduce((a, b) => a + b, 0),
  byGate: [...blockedByGate.entries()].sort((a, b) => b[1] - a[1]),
  byLevel: [...blockByLevel.entries()].sort((a, b) => a[0] - b[0])
};
out.window = {
  from: tsMin === Infinity ? null : new Date(tsMin).toISOString(),
  to: tsMax ? new Date(tsMax).toISOString() : null
};

console.log(JSON.stringify(out, null, 2));
