// verify-qqagent-coldstart.mjs — 「冷场首接抑制（A 硬闸 + C 第七因子）+ 拍一拍降权」自测
//
// 用法：node tools/verify-qqagent-coldstart.mjs
// 口径：纯逻辑断言 + 源码在位断言；不真发消息、不调 LLM、不碰生产数据。
// 判据：全绿才算通过；末行给出 N/N。
//
// 语义基线（Rushiera 2026-11-12 定）：
//   群里只有一个人在说、还没人接上之前，bot 不当第一个接话的；
//   例外 = 同一人连发 minSolo 条仍无人回应。拍一拍不算发言，不构成回应理由。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.resolve(ROOT, 'app', 'src', 'business');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function read(rel) { return fs.readFileSync(path.join(SRC, rel), 'utf8'); }

// 两个模块零依赖（不读配置、不读盘），可直接 import
const cs = await import(pathToFileURL(path.join(SRC, 'cold-start.js')).href);
const sig = await import(pathToFileURL(path.join(SRC, 'engage-signals.js')).href);

const NOW = Date.now();
const MIN = 60000;
function msg({ ts, senderId, text = 'x', self = false, isPoke = false, atMe = null }) {
  return { ts, senderId, text, self, isPoke, atMe, senderName: senderId };
}

// ── 1. 配置归一 ─────────────────────────────────────────────────────────────
console.log('\n[1] coldStartCfg 归一');
{
  const d = cs.coldStartCfg();
  ok('默认 enabled', d.enabled === true);
  ok('默认 minSolo=4', d.minSolo === 4, String(d.minSolo));
  ok('默认 windowMs=30 分钟', d.windowMs === 1800000, String(d.windowMs));
  ok('默认 gapMs=5 分钟', d.gapMs === 300000, String(d.gapMs));
  ok('默认 soloWeight=0.2', d.soloWeight === 0.2, String(d.soloWeight));
  const off = cs.coldStartCfg({ enabled: false, minSolo: '6', windowMs: 600000, gapMs: 0, soloWeight: 0.3 });
  ok('enabled=false 透传', off.enabled === false);
  ok('minSolo 字符串归一', off.minSolo === 6, String(off.minSolo));
  ok('gapMs=0 合法', off.gapMs === 0, String(off.gapMs));
  ok('soloWeight=0.3 透传', off.soloWeight === 0.3, String(off.soloWeight));
  const bad = cs.coldStartCfg({ minSolo: -1, windowMs: 0, gapMs: -5, soloWeight: 2 });
  ok('非法值回落默认', bad.minSolo === 4 && bad.windowMs === 1800000 && bad.gapMs === 300000 && bad.soloWeight === 0.2,
    JSON.stringify(bad));
}

// ── 2. analyzeTurn：冷场单人独白 → HOLD ─────────────────────────────────────
console.log('\n[2] analyzeTurn — HOLD 分支');
{
  const t1 = cs.analyzeTurn([msg({ ts: NOW - 5 * MIN, senderId: 'A' })], { now: NOW });
  ok('单人 1 条 → hold', t1.hold === true && t1.reason === 'cold-solo', JSON.stringify(t1));
  ok('单人 1 条 solo=1', t1.solo === 1, String(t1.solo));

  const t2 = cs.analyzeTurn([
    msg({ ts: NOW - 8 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 7 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 6 * MIN, senderId: 'A' })
  ], { now: NOW, minSolo: 4 });
  ok('单人 3 条（未达 4）→ hold', t2.hold === true && t2.solo === 3, JSON.stringify(t2));

  const t3 = cs.analyzeTurn([
    msg({ ts: NOW - 20 * MIN, senderId: 'A' })
  ], { now: NOW, windowMs: 10 * MIN });
  ok('窗口外消息 → 不适用（no-head）', t3.hold === false && t3.reason === 'no-head', t3.reason);

  const t4 = cs.analyzeTurn([], { now: NOW });
  ok('空消息 → 不适用', t4.hold === false && t4.reason === 'no-head', t4.reason);

  const t5 = cs.analyzeTurn([msg({ ts: NOW - 2 * MIN, senderId: 'A', isPoke: true })], { now: NOW });
  ok('只有拍一拍 → 不算发言（no-head）', t5.hold === false && t5.reason === 'no-head', t5.reason);

  const t6 = cs.analyzeTurn([
    msg({ ts: NOW - 3 * MIN, senderId: 'A', isPoke: true }),
    msg({ ts: NOW - 2 * MIN, senderId: 'A', text: '在吗' })
  ], { now: NOW });
  ok('拍一拍 + 单人 1 条 → 仍 hold（拍不算发言）', t6.hold === true && t6.solo === 1, JSON.stringify(t6));
}

// ── 3. analyzeTurn：三个放行分支 ────────────────────────────────────────────
console.log('\n[3] analyzeTurn — 放行分支');
{
  const burst = cs.analyzeTurn([
    msg({ ts: NOW - 5 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 4 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 3 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 2 * MIN, senderId: 'A' })
  ], { now: NOW, minSolo: 4 });
  ok('同一人连发 4 条 → ok-solo-burst 放行', burst.hold === false && burst.reason === 'ok-solo-burst', JSON.stringify(burst));

  const multi = cs.analyzeTurn([
    msg({ ts: NOW - 3 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 2 * MIN, senderId: 'B' })
  ], { now: NOW });
  ok('两个发言人 → ok-multi 放行', multi.hold === false && multi.reason === 'ok-multi' && multi.senders === 2, JSON.stringify(multi));

  const cont = cs.analyzeTurn([
    msg({ ts: NOW - 6 * MIN, senderId: 'bot', self: true }),
    msg({ ts: NOW - 5 * MIN, senderId: 'A' })
  ], { now: NOW, gapMs: 5 * MIN });
  ok('bot 发言后 1 分钟有人回 → ok-continue 放行', cont.hold === false && cont.reason === 'ok-continue', JSON.stringify(cont));

  const coldNew = cs.analyzeTurn([
    msg({ ts: NOW - 60 * MIN, senderId: 'bot', self: true }),
    msg({ ts: NOW - 2 * MIN, senderId: 'A' })
  ], { now: NOW, gapMs: 5 * MIN });
  ok('bot 一小时前说过话 → 新话头仍 hold', coldNew.hold === true && coldNew.reason === 'cold-solo', JSON.stringify(coldNew));

  const botOld = cs.analyzeTurn([
    msg({ ts: NOW - 45 * MIN, senderId: 'bot', self: true }),
    msg({ ts: NOW - 2 * MIN, senderId: 'A' })
  ], { now: NOW });
  ok('bot 在窗口外说过话 → 取窗口内全部非 bot（仍 hold）', botOld.hold === true, JSON.stringify(botOld));
}

// ── 4. 第七因子：soloFactor 进信号组 ────────────────────────────────────────
console.log('\n[4] 第七因子 soloFactor');
{
  const base = { now: NOW, minSolo: 4, windowMs: 1800000, gapMs: 300000, soloWeight: 0.2 };
  const s1 = sig.computeSignals([msg({ ts: NOW - 2 * MIN, senderId: 'A' })], base);
  ok('冷场单人 → soloFactor=0.2', s1.soloFactor === 0.2, String(s1.soloFactor));
  ok('冷场单人 → soloReason=cold-solo', s1.soloReason === 'cold-solo', String(s1.soloReason));

  const s2 = sig.computeSignals([
    msg({ ts: NOW - 4 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 3 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 2 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 1 * MIN, senderId: 'A' })
  ], base);
  ok('连发 4 条 → soloFactor=1', s2.soloFactor === 1, String(s2.soloFactor));

  const s3 = sig.computeSignals([
    msg({ ts: NOW - 3 * MIN, senderId: 'A' }),
    msg({ ts: NOW - 2 * MIN, senderId: 'B' })
  ], base);
  ok('两人对话 → soloFactor=1', s3.soloFactor === 1, String(s3.soloFactor));

  const s4 = sig.computeSignals([], base);
  ok('无消息 → soloFactor=1（不误压）', s4.soloFactor === 1, String(s4.soloFactor));
}

// ── 5. compositeCoefficient：solo 压在外层，不被几何平均稀释 ────────────────
console.log('\n[5] 复合系数');
{
  const allOne = {
    shareFactor: 1, atFactor: 1, askFactor: 1, hourFactor: 1, costFactor: 1, missFactor: 1,
    soloFactor: 1
  };
  ok('六因子全 1 + solo 1 → coef=1', Math.abs(sig.compositeCoefficient(allOne, 0.65) - 1) < 1e-9);
  const cold = { ...allOne, soloFactor: 0.2 };
  ok('solo 0.2 → coef=0.2（不被 floor 兜回）', Math.abs(sig.compositeCoefficient(cold, 0.65) - 0.2) < 1e-9,
    String(sig.compositeCoefficient(cold, 0.65)));
  const worst = { shareFactor: 0.5, atFactor: 1, askFactor: 1, hourFactor: 0.5, costFactor: 0.7, missFactor: 0.5, soloFactor: 1 };
  const w = sig.compositeCoefficient(worst, 0.65);
  ok('无冷场时 floor 语义不变（≥0.65）', w >= 0.65 - 1e-9, String(w));
}

// ── 6. 源码在位断言（配置 / 接线 / 文案 / 拍一拍口径）───────────────────────
console.log('\n[6] 源码在位');
{
  const cfg = read('config.js');
  ok('config 有 engage.coldStart', cfg.includes('coldStart: {') && cfg.includes('minSolo: 4'));
  ok('config 有 pokeImmediate: false', cfg.includes('pokeImmediate: false'));
  ok('config 默认 idleMs 仍在', cfg.includes('idleMs: 60000'));

  const orch = read('orchestrator.js');
  ok('orchestrator 导入冷场模块', orch.includes("from './cold-start.js'"));
  ok('browseTick 接了 hold 闸', orch.includes('冷场首接抑制') && orch.includes('analyzeTurn(recentForTurn, cold)'));
  ok('hold 落 metrics（event: hold）', orch.includes("event: 'hold'"));
  ok('信号系数收到 cold 参数', orch.includes('#signalCoefficient(chatKey, cold)'));

  const br = read('browse-rate.js');
  ok('browseHint 有接话顺位纪律', br.includes('冷场不抢第一个接'));
  ok('browseHint 不再说拍一拍点名', !br.includes('拍了拍你的消息'));

  const pr = read('prompt.js');
  ok('resolveContextTier 拍一拍不响应', pr.includes('只有拍一拍（不含信息）'));
  ok('prompt 不再按 1 档响应拍一拍', !pr.includes("reason: '拍了拍我'"));

  const st = read('store.js');
  const unreadFiltered = (st.match(/!m\.read && !m\.self && !m\.isPoke/g) || []).length;
  ok('store 未读口径全部排除拍一拍（≥3 处）', unreadFiltered >= 3, '实际 ' + unreadFiltered);

  const rp = read('rapport.js');
  ok('rapport 不再把拍一拍算作接话', !rp.includes('m.isPoke && /拍了拍'));

  const lv = read('engage-level.js');
  ok('冰封档文案去掉拍一拍', !lv.includes('@ / 拍一拍 点名时才回应'));

  const es = read('engage-signals.js');
  ok('engage-signals 有 soloFactor', es.includes('soloFactor') && es.includes('analyzeTurn'));
}

console.log('\n' + (fail === 0 ? 'PASS ' : 'FAIL ') + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
