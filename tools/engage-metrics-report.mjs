// B31 判据统计 —— 读 engage metrics 两日样本，出 roll / blocked 分布（一次性分析脚本）
//
// 2026-11-01 起 roll 行多了两个字段（B31 甲案接线后）：
//   baseRate 档位原值（配置口径，与 configuredRate 对齐）
//   coef     本拍信号系数（1 = 未修正）
// 老的 roll 行没有这两项 → 全部回落：baseRate 取 rate、coef 视为 1，历史样本仍可比。
// 另新增 event:'signal' 行（与 roll 成对落，字段见 engage-signals.signalSummary）——单列统计。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.log('ERR need dir'); process.exit(2); }
const files = fs.readdirSync(dir).filter((n) => /^engage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
const out = { files: [], rows: 0, byEvent: {}, roll: {}, blocked: {}, sent: {}, signal: {}, other: {} };

const rollByLevel = new Map();
const rollByChat = new Map();
const blockedByGate = new Map();
const blockByLevel = new Map();
const coefBuckets = new Map();   // coef 两位小数 -> { n, hit }
const sigFactorSum = { shareFactor: 0, atFactor: 0, askFactor: 0, hourFactor: 0, costFactor: 0, missFactor: 0 };
let sigN = 0;
let coefAdjusted = 0;            // coef !== 1 的 roll 拍数
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
      const baseRate = Number.isFinite(Number(r.baseRate)) ? Number(r.baseRate) : rate;
      if (!rollByLevel.has(lv)) rollByLevel.set(lv, { n: 0, hit: 0, rate, rates: new Set(), base: new Set() });
      const b = rollByLevel.get(lv);
      b.n += 1; b.rates.add(rate); b.base.add(baseRate);
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
      // 信号系数（老样本无此字段 → coef=1 落进「未修正」桶，历史可比）
      const coef = Number.isFinite(Number(r.coef)) ? Number(r.coef) : 1;
      if (coef !== 1) coefAdjusted += 1;
      const k = coef.toFixed(2);
      if (!coefBuckets.has(k)) coefBuckets.set(k, { n: 0, hit: 0 });
      const cb = coefBuckets.get(k);
      cb.n += 1; if (r.hit === true) cb.hit += 1;
    } else if (ev === 'blocked') {
      const g = String(r.gate || '(none)');
      blockedByGate.set(g, (blockedByGate.get(g) || 0) + 1);
      const lv = Number(r.level) || 0;
      blockByLevel.set(lv, (blockByLevel.get(lv) || 0) + 1);
    } else if (ev === 'sent') {
      const lv = Number(r.level) || 0;
      out.sent.n = (out.sent.n || 0) + 1;
      out.sent['lv' + lv] = (out.sent['lv' + lv] || 0) + 1;
    } else if (ev === 'signal') {
      // 信号摘要行（B31 接线后）：累积六因子均值，看哪个因子在压
      sigN += 1;
      for (const k of Object.keys(sigFactorSum)) {
        if (Number.isFinite(Number(r[k]))) sigFactorSum[k] += Number(r[k]);
      }
      const cf = Number(r.costFactor);
      if (Number.isFinite(cf)) out.signal.costFactorSeen = out.signal.costFactorSeen || {};
      if (Number.isFinite(cf) && cf !== 1) out.signal.costFactorSeen[String(cf)] = (out.signal.costFactorSeen[String(cf)] || 0) + 1;
      if (Number(r.missFactor) < 1) out.signal.missAdj = (out.signal.missAdj || 0) + 1;
      if (Number(r.hourFactor) < 1) out.signal.nightAdj = (out.signal.nightAdj || 0) + 1;
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
  coefAdjusted,   // coef !== 1 的拍数（信号真在起作用）
  byCoef: [...coefBuckets.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([coef, v]) => ({
    coef: Number(coef), n: v.n, hit: v.hit, hitRate: +(v.hit / v.n).toFixed(4)
  })),
  byLevel: [...rollByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lv, v]) => ({
    level: lv, n: v.n, hit: v.hit,
    hitRate: +(v.hit / v.n).toFixed(4),
    configuredRate: [...v.rates].join(','),
    baseRate: [...v.base].join(',')
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
out.signal = {
  ...out.signal,
  rows: sigN,
  // 六因子均值（只在 signal 行存在时有意义）——哪一项在持续压低，一眼看出
  avg: sigN ? Object.fromEntries(Object.entries(sigFactorSum).map(([k, v]) => [k, +(v / sigN).toFixed(3)])) : null
};
out.window = {
  from: tsMin === Infinity ? null : new Date(tsMin).toISOString(),
  to: tsMax ? new Date(tsMax).toISOString() : null
};

console.log(JSON.stringify(out, null, 2));
