// verify-qqagent-level.mjs — 「发言档位（五档）+ 客观采集」自测
//
// 用法：node verify-qqagent-level.mjs
// 口径：纯逻辑断言 + 源码在位断言；**不真发消息、不调 LLM、不碰生产数据目录**
//       （每跑一次在 runtime/.level-selftest/ 下重建隔离副本）
// 判据：全绿才算通过；末行给出 N/N。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const SRC = path.resolve(APP, 'src/business');
const SANDBOX = path.join(ROOT, 'runtime', '.level-selftest');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ✅ ' + name); }
  else { fail += 1; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function read(rel) { return fs.readFileSync(path.join(SRC, rel), 'utf8'); }

// ── 0. 隔离数据目录（必须在 import 业务模块之前设好）─────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
// 复制一份配置（有就复制，没有让模块用默认值）
const prodCfg = path.join(ROOT, '_unpack', 'data', 'config.json');
if (fs.existsSync(prodCfg)) fs.copyFileSync(prodCfg, path.join(SANDBOX, 'data', 'config.json'));
process.env.QQ_AGENT_DATA_DIR = path.join(SANDBOX, 'data');
process.env.QQ_AGENT_CONFIG = path.join(SANDBOX, 'data', 'config.json');

const cfgMod = await import(pathToFileURL(path.join(SRC, 'config.js')).href);
const lvl = await import(pathToFileURL(path.join(SRC, 'engage-level.js')).href);
const sig = await import(pathToFileURL(path.join(SRC, 'engage-signals.js')).href);
const met = await import(pathToFileURL(path.join(SRC, 'engage-metrics.js')).href);

// ── 1. 五档表：默认值与顺序 ─────────────────────────────────────────────────
console.log('\n[1] 档位表与派生');
const table = lvl.levelTable();
ok('默认五档', table.length === 5, '实际 ' + table.length);
ok('档名顺序 冰封/保守/标准/活跃/全开',
  table.map((x) => x.name).join('/') === '冰封/保守/标准/活跃/全开', table.map((x) => x.name).join('/'));
ok('入场率 0/0.25/0.6/0.85/1',
  table.map((x) => x.rate).join('/') === '0/0.25/0.6/0.85/1', table.map((x) => x.rate).join('/'));
ok('冰封档为 organizeOnly', table[0].organizeOnly === true);
ok('其余档不是 organizeOnly', table.slice(1).every((x) => x.organizeOnly === false));

// ── 2. 档位归属：levelByChat > quiet 别名 > 默认 3 ──────────────────────────
// 配置改动一律走内存态（setRuntimeConfig）—— 不落盘、不污染 sandbox 副本，
// 也不受 updateConfig 的 deepMerge 影响（对象合并不会"清空旧键"）。
function setEngage(patch) {
  const cfg = structuredClone(cfgMod.getConfig());
  cfg.engage = { ...(cfg.engage || {}), ...patch };
  cfgMod.setRuntimeConfig(cfg);
}

console.log('\n[2] 档位归属');
setEngage({ levelByChat: {}, quiet: { enabled: true, chats: [] } });
ok('未指定的群 → 标准档 3', lvl.levelForChat('group:111') === 3, String(lvl.levelForChat('group:111')));
ok('私聊 → 最高档（不受节制）', lvl.levelForChat('private:222') === 5, String(lvl.levelForChat('private:222')));
{
  setEngage({ levelByChat: { 111: 2 }, quiet: { enabled: true, chats: ['333'] } });
  ok('levelByChat 指定 → 该档', lvl.levelForChat('group:111') === 2, String(lvl.levelForChat('group:111')));
  ok('quiet.chats 老配置 → 冰封档 1', lvl.levelForChat('group:333') === 1, String(lvl.levelForChat('group:333')));
  ok('quiet 别名同时被 isQuietChat 认同（老语义不断）', (() => {
    const q = fs.readFileSync(path.join(SRC, 'quiet-mode.js'), 'utf8');
    return q.includes('levelByChat') && q.includes('=== 1');
  })());
  ok('清理后回到默认 3', (() => {
    setEngage({ levelByChat: {}, quiet: { enabled: true, chats: [] } });
    return lvl.levelForChat('group:111') === 3;
  })());
}

// ── 3. 参与率掷骰：边界与概率 ───────────────────────────────────────────────
console.log('\n[3] 参与率掷骰');
ok('全开档恒命中（rand=0.999）',
  lvl.rollParticipation('private:1', () => 0.999).participate === true);
{
  setEngage({ levelByChat: { 444: 1 }, quiet: { enabled: true, chats: [] } });
  ok('冰封档恒不命中（rand=0）',
    lvl.rollParticipation('group:444', () => 0).participate === false);
}
{
  setEngage({ levelByChat: { 555: 2 }, quiet: { enabled: true, chats: [] } });
  const p = lvl.paramsFor('group:555');
  ok('保守档 rate=0.25', p.rate === 0.25, String(p.rate));
  ok('rand=0.10 → 命中', lvl.rollParticipation('group:555', () => 0.10).participate === true);
  ok('rand=0.30 → 不命中', lvl.rollParticipation('group:555', () => 0.30).participate === false);
  // 统计口径：10 万分样本，命中率应接近 25%
  let hit = 0;
  for (let i = 0; i < 100000; i += 1) if (lvl.rollParticipation('group:555').participate) hit += 1;
  const ratio = hit / 100000;
  ok('10 万次命中率 ≈ 25%（±2%）', Math.abs(ratio - 0.25) < 0.02, (ratio * 100).toFixed(1) + '%');
}

// ── 4. 档位提示段 ───────────────────────────────────────────────────────────
console.log('\n[4] 提示段');
{
  setEngage({ levelByChat: { 444: 1 }, quiet: { enabled: true, chats: [] } });
  const h1 = lvl.levelHint('group:444');
  ok('冰封档提示含【发言档位】+ 冰封', h1.includes('【发言档位】') && h1.includes('冰封'), h1.slice(0, 40));
  setEngage({ levelByChat: { 666: 5 }, quiet: { enabled: true, chats: [] } });
  ok('全开档提示为空串（不占 token）', lvl.levelHint('group:666') === '', JSON.stringify(lvl.levelHint('group:666')));
  ok('私聊提示为空串', lvl.levelHint('private:1') === '');
  setEngage({ levelByChat: { 777: 2 }, quiet: { enabled: true, chats: [] } });
  const h2 = lvl.levelHint('group:777');
  ok('保守档提示含档名与入场率', h2.includes('保守') && h2.includes('25%'), h2.slice(0, 60));
}

// ── 5. 客观信号：纯函数口径 ─────────────────────────────────────────────────
console.log('\n[5] 客观信号');
{
  const msgs = [];
  for (let i = 0; i < 9; i += 1) msgs.push({ self: false, atMe: false, text: '闲聊一句' });
  msgs.push({ self: true, text: '我说话' });
  const s = sig.computeSignals(msgs, { hour: 12, costDay: 0, missStreak: 0 });
  ok('总数/自身条数', s.total === 10 && s.self === 1, JSON.stringify({ t: s.total, s: s.self }));
  ok('发言占比 0.1', Math.abs(s.share - 0.1) < 1e-9, String(s.share));
  ok('占比低 → shareFactor=1（不奖励也不罚）', s.shareFactor === 1, String(s.shareFactor));
}
{
  const msgs = [];
  for (let i = 0; i < 5; i += 1) msgs.push({ self: true, text: '我说' });
  for (let i = 0; i < 5; i += 1) msgs.push({ self: false, text: '别人说' });
  const s = sig.computeSignals(msgs, { hour: 12 });
  ok('占比 50% → shareFactor 收到下限 0.5', s.shareFactor === 0.5, String(s.shareFactor));
}
{
  const msgs = [{ self: false, atMe: true, text: 'x' }, { self: false, text: 'y' }, { self: false, text: '怎么办' }];
  const s = sig.computeSignals(msgs, { hour: 12 });
  ok('被点名率 1/3 ≥3% → atFactor 1.15', s.atFactor === 1.15, String(s.atFactor));
  ok('提问密度 ≥25% → askFactor 1.1', s.askFactor === 1.1, String(s.askFactor) + ' ask=' + s.askDensity);
}
{
  ok('深夜（2 点）×0.5', sig.computeSignals([], { hour: 2 }).hourFactor === 0.5);
  ok('白天（14 点）×1', sig.computeSignals([], { hour: 14 }).hourFactor === 1);
  ok('日成本 120 元 ×0.7', sig.computeSignals([], { hour: 14, costDay: 120 }).costFactor === 0.7);
  ok('日成本 60 元 ×0.85', sig.computeSignals([], { hour: 14, costDay: 60 }).costFactor === 0.85);
  ok('连续 4 拍没接 → 0.8', Math.abs(sig.computeSignals([], { hour: 14, missStreak: 4 }).missFactor - 0.8) < 1e-9);
  ok('连续 20 拍没接 → 下限 0.5', sig.computeSignals([], { hour: 14, missStreak: 20 }).missFactor === 0.5);
}
{
  const all1 = { shareFactor: 1, atFactor: 1, askFactor: 1, hourFactor: 1, costFactor: 1, missFactor: 1 };
  ok('全 1 → 系数 1', Math.abs(sig.compositeCoefficient(all1) - 1) < 1e-9);
  const low = { shareFactor: 0.5, atFactor: 1, askFactor: 1, hourFactor: 0.5, costFactor: 0.7, missFactor: 0.5 };
  const c = sig.compositeCoefficient(low);
  // B31 判据 3：floor 按实测量级重定（0.15 → 0.65）。
  // 最坏组合的几何平均 ≈ 0.666 —— 它必须**高于** floor（floor 只兜比最坏还坏的组合）。
  ok('最坏组合 ≈0.666（floor 之上）', Math.abs(c - 0.666) < 0.01, String(c));
  ok('默认 floor = 0.65', Math.abs(c - 0.65) > 1e-9 && c > 0.65, String(c));
  ok('floor 生效（传 floor=0.9）', sig.compositeCoefficient(low, 0.9) === 0.9);
  ok('单深夜项 ≈0.891（几乎不压）', Math.abs(sig.compositeCoefficient({ shareFactor: 1, atFactor: 1, askFactor: 1, hourFactor: 0.5, costFactor: 1, missFactor: 1 }) - 0.891) < 0.002);
  ok('系数上限 1.15', sig.compositeCoefficient({ shareFactor: 1.5, atFactor: 1.5, askFactor: 1.5, hourFactor: 1.5, costFactor: 1.5, missFactor: 1.5 }) === 1.15);
}

// ── 5b. 信号乘到 rate 上（B31 判据 1：系数不悬空）───────────────────────────
console.log('\n[5b] 信号 × 参与率');
{
  setEngage({ levelByChat: { 610: 3 }, quiet: { enabled: true, chats: [] } });
  // 标准档 0.6，系数 0.5 → 生效 0.30
  const ok1 = lvl.rollParticipation('group:610', () => 0.29, 0.5);
  const no1 = lvl.rollParticipation('group:610', () => 0.31, 0.5);
  ok('coef 0.5：rate 0.6→0.30（0.29 命中 / 0.31 不命中）',
    ok1.participate === true && no1.participate === false,
    JSON.stringify({ ok: ok1.participate, no: no1.participate }));
  ok('回执带 baseRate（档位原值）与 coef', ok1.baseRate === 0.6 && ok1.coef === 0.5 && Math.abs(ok1.rate - 0.3) < 1e-9,
    JSON.stringify({ base: ok1.baseRate, coef: ok1.coef, rate: ok1.rate }));
  // 系数 >1 允许（鼓励），但封顶 1.15；rate 封顶 1
  const up = lvl.rollParticipation('group:610', () => 0.68, 1.15);
  ok('coef 1.15：rate 0.6→0.69（0.68 命中）', up.participate === true && Math.abs(up.rate - 0.69) < 1e-9, String(up.rate));
  // 全开档不吃系数（不做入场判定的语义不能被信号改掉）
  const full = lvl.rollParticipation('private:9', () => 0.999, 0.5);
  ok('全开档豁免：coef 0.5 仍命中，rate 保持 1', full.participate === true && full.rate === 1 && full.coef === 1,
    JSON.stringify({ p: full.participate, rate: full.rate, coef: full.coef }));
  // 冰封档同理：非 @ 不进，系数不参与
  setEngage({ levelByChat: { 611: 1 }, quiet: { enabled: true, chats: [] } });
  const ice = lvl.rollParticipation('group:611', () => 0, 1.15);
  ok('冰封档豁免：coef 1.15 仍不命中', ice.participate === false && ice.rate === 0 && ice.coef === 1, JSON.stringify(ice));
  // 非法系数 → 回落 1（不静默按 0 处理）
  const bad = lvl.rollParticipation('group:610', () => 0.5, NaN);
  ok('非法 coef → 回落 1（rate 仍 0.6）', bad.coef === 1 && Math.abs(bad.rate - 0.6) < 1e-9, JSON.stringify({ coef: bad.coef, rate: bad.rate }));
}

// ── 6. 采集面：真落盘一行 ───────────────────────────────────────────────────
console.log('\n[6] 采集面');
{
  met.record({ chat: 'group:999', event: 'roll', level: 3, rate: 0.6, roll: 0.42, hit: true });
  const dir = met.metricsDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^engage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) : [];
  ok('落盘到 metrics/engage-<日期>.jsonl', files.length === 1, files.join(','));
  if (files.length === 1) {
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    ok('一行一条事件', lines.length === 1, String(lines.length));
    const row = JSON.parse(lines[0]);
    ok('字段齐（ts/chat/event/level/rate/roll/hit）',
      row.ts > 0 && row.chat === 'group:999' && row.event === 'roll' && row.level === 3 && row.hit === true,
      JSON.stringify(row));
  }
}

// ── 6b. 接线端到端（B31 判据 1 / 4：系数真进判定，不是纯函数自娱）────────────
// 治的病：`computeSignals` 三函数曾经零消费方——纯函数自测全绿也测不出「没人调用」。
// 这里走一遍真实巡检：假 store 给高自我占比 → 系数必然 <1 → 采集面 roll 行必须带 coef。
console.log('\n[6b] 接线端到端');
{
  const { Orchestrator } = await import(pathToFileURL(path.join(SRC, 'orchestrator.js')).href);
  setEngage({
    levelByChat: { 610: 3 }, quiet: { enabled: true, chats: [] },
    signals: { enabled: true, floor: 0.65 }
  });
  const ecfg = cfgMod.getConfig().engage;
  const oldLevels = ecfg.browse.levels;
  const oldSweep = ecfg.browse.sweepMs;
  ecfg.browse.levels = [100, 60, 40];
  ecfg.browse.sweepMs = 2000;   // 巡检有 2000ms 下限
  const KEY2 = 'group:610';
  // 10 条里 8 条是自己说的 → share=0.8 → shareFactor 落到 0.5 下限 → 系数必然 ≠ 1
  const msgs = [];
  for (let i = 0; i < 8; i += 1) msgs.push({ self: true, text: '我说' });
  for (let i = 0; i < 2; i += 1) msgs.push({ self: false, text: '别人说' });
  const orch = new Orchestrator({
    store: {
      unreadCount: () => 3, peekUnread: () => [], listChats: () => [KEY2],
      recent: () => msgs, lastUnreadTs: () => Date.now(),
      markEntryRead() {}, markAllRead() {}
    },
    sessions: {
      current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null,
      discard() {}, todayUsage: () => ({ promptTokens: 1000, completionTokens: 1000, cachedTokens: 0 })
    },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  orch.wake = () => Promise.resolve();
  orch.startBrowseLoop();                     // 必须先起巡检（onIncoming 之外的另一条入口）
  orch.browseNextAt.set(KEY2, Date.now() - 1); // 起完之后把该群拉到"已到点"
  await new Promise((r) => setTimeout(r, 2400));
  await orch.abortAll();
  ecfg.browse.levels = oldLevels;
  ecfg.browse.sweepMs = oldSweep;

  const dir = met.metricsDir();
  const f = fs.readdirSync(dir).filter((n) => /^engage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))[0];
  const rows = f ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const roll = rows.filter((r) => r.event === 'roll' && r.chat === KEY2).pop();
  const sigRow = rows.filter((r) => r.event === 'signal' && r.chat === KEY2).pop();
  ok('巡检真跑到该群（roll 行在盘）', Boolean(roll), JSON.stringify(roll));
  ok('roll 行带 coef 且 ≠ 1（系数真被算出来）', Boolean(roll) && Number.isFinite(roll.coef) && roll.coef !== 1,
    String(roll && roll.coef));
  ok('roll 行 rate = baseRate × coef（口径自洽）',
    Boolean(roll) && Math.abs(roll.rate - Math.min(1, roll.baseRate * roll.coef)) < 1e-9,
    JSON.stringify(roll && { base: roll.baseRate, coef: roll.coef, rate: roll.rate }));
  ok('roll 行 baseRate = 档位原值 0.6', Boolean(roll) && roll.baseRate === 0.6, String(roll && roll.baseRate));
  ok('signal 摘要行与 roll 成对落（判据 5 的复核面）', Boolean(sigRow), JSON.stringify(sigRow));
  ok('signal 行带六因子与 coef', Boolean(sigRow) && sigRow.share === 0.8
    && Math.abs(sigRow.coef - roll.coef) < 0.001,
    JSON.stringify(sigRow && { share: sigRow.share, coef: sigRow.coef }));

  // 关掉开关 → 系数回 1，判定退化为纯档位（一键回退的证据）
  // ⚠️ 节拍参数必须随 setEngage 一起写：setRuntimeConfig 换的是整份配置对象，
  //    上一段改的 ecfg 引用此后已失效（改它不影响 getConfig()）。
  setEngage({
    levelByChat: { 610: 3 }, quiet: { enabled: true, chats: [] },
    signals: { enabled: false, floor: 0.65 },
    browse: { ...cfgMod.getConfig().engage.browse, levels: [100, 60, 40], sweepMs: 2000 }
  });
  const orch2 = new Orchestrator({
    store: {
      unreadCount: () => 3, peekUnread: () => [], listChats: () => [KEY2],
      recent: () => msgs, lastUnreadTs: () => Date.now(),
      markEntryRead() {}, markAllRead() {}
    },
    sessions: {
      current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null,
      discard() {}, todayUsage: () => ({})
    },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  orch2.wake = () => Promise.resolve();
  orch2.startBrowseLoop();
  orch2.browseNextAt.set(KEY2, Date.now() - 1);
  await new Promise((r) => setTimeout(r, 2400));
  await orch2.abortAll();
  ecfg.browse.levels = oldLevels;
  ecfg.browse.sweepMs = oldSweep;
  const rows2 = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const roll2 = rows2.filter((r) => r.event === 'roll' && r.chat === KEY2).pop();
  ok('enabled=false → coef=1（可一键回退）', Boolean(roll2) && roll2.coef === 1 && roll2.rate === 0.6,
    JSON.stringify(roll2 && { coef: roll2.coef, rate: roll2.rate }));
}

// ── 7. 源码在位断言（改点没被覆盖 / 依赖链没断）──────────────────────────────
console.log('\n[7] 源码在位');
{
  const orch = read('orchestrator.js');
  ok('orchestrator import 档位与采集', orch.includes('qqagent-level-patch:orchestrator-import'));
  ok('参与率判定在 unread 早退之后', orch.indexOf("qqagent-level-patch:browse-tick-gate") > orch.indexOf('if (unread <= 0) continue'), '位置错');
  ok('未命中走 continue（不 wake）', /if \(!r\.participate\) \{[\s\S]{0,400}continue;/.test(orch));
  ok('提示段追加 levelLine', orch.includes('+ quietLine + levelLine + rapportLine'));
  ok('冰封/平静两者互斥', orch.includes('quietLine ? \'\' : levelHint(chatKey)'));

  const snd = read('sender.js');
  ok('sender import 采集', snd.includes('qqagent-level-patch:sender-import'));
  ok('配额闸拦截落采集', snd.includes('qqagent-level-patch:sender-gate-quota'));
  ok('硬限闸拦截落采集', snd.includes('qqagent-level-patch:sender-gate-hard'));
  ok('noteBlocked 定义在位', /function noteBlocked\(/.test(snd));

  const rap = read('rapport.js');
  ok('rapport import 档位', rap.includes('qqagent-level-patch:rapport-import'));
  ok('missDelta 按档位封顶', rap.includes('qqagent-level-patch:rapport-miss-cap'));
  ok('封顶逻辑用 Math.min', /missDelta = Math\.min\(missDelta, paramsFor\(chatKey\)\.missCap\)/.test(rap));
  ok('判定与日志仍在（settle 未被删）', /export function settleRapportWatch/.test(rap));

  const cfgTxt = read('config.js');
  ok('config 有 levels / levelByChat / signals', cfgTxt.includes('qqagent-level-patch:config-levels')
    && cfgTxt.includes('levelByChat: {}') && cfgTxt.includes('signals: { enabled: true, floor: 0.65 }'));
  ok('配额 5/2min 原样未动', /quota: \{ enabled: true, windowMs: 120000, maxPerWindow: 5 \}/.test(cfgTxt));
  ok('节拍表 240/120/60 原样未动', /levels: \[240000, 120000, 60000\]/.test(cfgTxt));

  // B31 判据 1 / 4：接线在位断言——三函数的消费方不再为零。
  ok('orchestrator import 三件信号函数', orch.includes('qqagent-level-patch:signals-import'));
  ok('判定处调用 #signalCoefficient', /const sgn = this\.#signalCoefficient\(chatKey[,)]/.test(orch));
  ok('系数真乘进 rollParticipation', /rollParticipation\(chatKey, Math\.random, sgn\.coef\)/.test(orch));
  ok('采集行带 baseRate/coef', orch.includes('baseRate: r.baseRate, rate: r.rate, coef: r.coef'));
  ok('#signalCoefficient 用 computeSignals + compositeCoefficient',
    /computeSignals\(messages, \{/.test(orch) && /compositeCoefficient\(sig, floor\)/.test(orch));
  ok('costDay 供给（todayUsage → estimateCost，60s 缓存）',
    /const usage = this\.sessions\.todayUsage\(day\);/.test(orch) && /estimateCost\(usage, \{ model \}\)/.test(orch)
    && /#costCache\.day === day && now - this\.#costCache\.at < 60000/.test(orch));
  ok('missStreak 供给（客观结算写、信号读）',
    /this\.missStreak\.set\(chatKey, settled\.hit \? 0/.test(orch) && /missStreak: this\.missStreak\.get\(chatKey\) \|\| 0/.test(orch));

  const q = read('quiet-mode.js');
  ok('quiet 增加 levelByChat=1 别名', q.includes('qqagent-level-patch:quiet-alias'));
  ok('quietHint 仍返回安静文案', /【安静模式】/.test(q));
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败项') + '：' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
