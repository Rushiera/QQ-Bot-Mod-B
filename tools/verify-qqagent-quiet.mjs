// verify-qqagent-quiet.mjs — 「安静模式」自测
//
// 用法：node verify-qqagent-quiet.mjs
// 判据（Rushiera 2026-10-16 口述规格）：
//   A 判定
//     1 默认：群清单为空 → 任何群都不是安静群
//     2 chats 含群号 → 该群是安静群；别的群不是
//     3 私聊恒不是安静群
//     4 enabled=false → 全部不是（清单保留）
//     5 intervalMs 默认 6 小时；可配
//   B 提示段
//     6 安静群：含「安静模式」「点名」「只整理不发言」
//     7 非安静群：不注入
//     8 私聊：不注入
//   C 源码落点
//     9 补丁标记齐全（幂等可重放）
//    10 orchestrator 含安静线 + 整理轮强制收工 + 节拍拉长
//    11 收工指令区分 quiet / rollover
//    12 记忆页开关落点（列表标记 + 详情按钮 + 处理函数）
//   D 链路端到端（假时钟）
//    13 安静群到点 → wake 带 quietOrganize:true
//    14 非安静群到点 → wake 不带 quietOrganize
//    15 安静群不走静默补拍（有静默未读也不补）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.quiet-selftest）。
// LLM：不调用 —— 只覆盖判定 / 提示段 / 节拍巡检链路。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.quiet-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

const CFG_PATH = path.join(DATA, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.send = { ...cfg.send, minGapMs: 1, maxGapMs: 2, byLengthMs: 0, dedupeWindowMs: 0, hardSplitAt: 0 };
cfg.engage = {
  ...(cfg.engage || {}),
  quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
  hardLimit: { enabled: false, windowMs: 60000, maxPerWindow: 1 },
  browse: {
    enabled: true,
    levels: [240000, 120000, 60000],
    holdMs: 900000,
    atMeImmediate: true,
    privateImmediate: true,
    sweepMs: 5000,
    idleMs: 60000
  },
  quiet: { enabled: true, chats: [], intervalMs: 21600000, organizeOnly: true },
  // 五档全放行（2026-10-25）：本自测验安静链路，不验参与率掷骰 ——
  // 否则非安静群会被 60% 概率拦下，把"wake 带不带 quietOrganize"断言抖成假红。
  levels: [
    { name: '冰封', rate: 1, missCap: 0, organizeOnly: false },
    { name: '保守', rate: 1, missCap: 0, organizeOnly: false },
    { name: '标准', rate: 1, missCap: 0, organizeOnly: false },
    { name: '活跃', rate: 1, missCap: 0, organizeOnly: false },
    { name: '全开', rate: 1, missCap: 0, organizeOnly: false }
  ],
  levelByChat: {}
};
cfg.store = { ...(cfg.store || {}), contextTier: 4, contextSliderPos: 0, unifiedTier: true };
cfg.commandMute = { enabled: true, command: '/安静', durationMin: 30, active: {} };
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getConfig } = await import(mod('config.js'));
const {
  quietEnabled, quietChats, isQuietChat, quietIntervalMs, quietHint
} = await import(mod('quiet-mode.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const KEY = 'group:1097492606';
const GROUP_ID = '1097492606';
const OTHER = 'group:689942975';
const PRIVATE = 'private:10001';

// ── A. 判定 ────────────────────────────────────────────────────────────────
{
  check('默认清单为空 → 非安静群', isQuietChat(KEY) === false && quietChats().length === 0);
  getConfig().engage.quiet.chats = [GROUP_ID];
  check('清单含群号 → 该群是安静群', isQuietChat(KEY) === true);
  check('别的群不受影响', isQuietChat(OTHER) === false);
  check('私聊恒不是安静群', isQuietChat(PRIVATE) === false);
  getConfig().engage.quiet.enabled = false;
  check('enabled=false → 全部不是（清单保留）', isQuietChat(KEY) === false && (getConfig().engage.quiet.chats || []).length === 1);
  getConfig().engage.quiet.enabled = true;
  check('intervalMs 默认 6 小时', quietIntervalMs() === 21600000, String(quietIntervalMs()));
  getConfig().engage.quiet.intervalMs = 3600000;
  check('intervalMs 可配（1 小时）', quietIntervalMs() === 3600000, String(quietIntervalMs()));
  delete getConfig().engage.quiet.intervalMs;
  check('intervalMs 缺失 → 回落 6 小时', quietIntervalMs() === 21600000, String(quietIntervalMs()));
}

// ── B. 提示段 ──────────────────────────────────────────────────────────────
{
  const h = quietHint(KEY);
  check('安静群：含「安静模式」', h.includes('安静模式'), h.slice(0, 60));
  check('安静群：含「点名」与「只整理不发言」', h.includes('点名') && h.includes('只整理不发言'));
  check('非安静群：不注入', quietHint(OTHER) === '', JSON.stringify(quietHint(OTHER)));
  check('私聊：不注入', quietHint(PRIVATE) === '', JSON.stringify(quietHint(PRIVATE)));
  getConfig().engage.quiet.enabled = false;
  check('总开关关闭：不注入', quietHint(KEY) === '');
  getConfig().engage.quiet.enabled = true;
}

// ── C. 源码落点 ────────────────────────────────────────────────────────────
{
  const marks = [
    'quiet-mode', 'config-quiet', 'orchestrator-import', 'note-browse-pending',
    'browse-tick', 'browse-tick-wake', 'wake-signature', 'rollover',
    'session-flag', 'orchestrator-hint-def', 'orchestrator-hint-append',
    'rollover-instruction', 'runagent-signature', 'runagent-call',
    'rollover-append', 'rollover-finish-reason'
  ];
  const srcFiles = ['quiet-mode.js', 'config.js', 'orchestrator.js'];
  const all = srcFiles.map((f) => fs.readFileSync(path.join(BIZ, f), 'utf8')).join('\n');
  const missing = marks.filter((m) => !all.includes('[qqagent-quiet-patch:' + m + ']'));
  check('补丁标记齐全（16 个源码点）', missing.length === 0, missing.join(',') || '16/16');

  const ui = fs.readFileSync(path.join(BIZ, 'ui', '05-memory-settings.js'), 'utf8');
  // 2026-10-25 五档改造：UI 的「安静模式」单按钮被五档选择器取代
  // （patch-qqagent-level-ui.mjs）。老的 6 个 quiet UI 标记将随改造退场，
  // 这里只核 quiet 语义仍在的落点 + 五档 UI 的 8 个新落点。
  const quietUiStill = ['ui-toggle-fn'];
  const quietUiMissing = quietUiStill.filter((m) => !ui.includes('[qqagent-quiet-patch:' + m + ']'));
  check('安静模式写配置函数仍在（ui-toggle-fn）', quietUiMissing.length === 0, quietUiMissing.join(',') || '1/1');

  const levelUi = ['list-badge', 'list-html', 'detail-state', 'detail-btn',
    'detail-html', 'detail-bind', 'set-fn', 'helpers'];
  const levelUiMissing = levelUi.filter((m) => !ui.includes('[qqagent-level-patch:ui-' + m + ']'));
  check('记忆页五档选择器落点齐全（8 个 UI 点）', levelUiMissing.length === 0, levelUiMissing.join(',') || '8/8');

  const orch = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
  check('提示词拼接含 quietLine', orch.includes('+ browseLine + quietLine'));
  check('安静整理轮强制收工语义', orch.includes('quietOrganize || shouldRollover(chatKey, pendingChars)'));
  check('收工指令区分 quiet / rollover', orch.includes("rolloverInstruction(quietOrganize ? 'quiet' : 'rollover')"));
  check('节拍巡检安静群走整理轮', orch.includes('quiet ? { quietOrganize: true } : {}'));
  check('安静群节拍拉长', orch.includes('now + (quiet ? quietIntervalMs() : browseIntervalMs(chatKey))'));
  check('安静群不走静默补拍', orch.includes('!due && !quiet && idleFireDue'));
}

// ── D. 链路端到端（假时钟：巡检 2000ms 下限）─────────────────────────────
{
  const { Orchestrator } = await import(mod('orchestrator.js'));
  const bcfg = getConfig().engage.browse;
  const oldSweep = bcfg.sweepMs;
  bcfg.sweepMs = 2000;
  getConfig().engage.quiet.chats = [GROUP_ID];

  const stubStore = {
    unreadCount: () => 3,
    lastUnreadTs: () => Date.now() - 90000,
    peekUnread: () => [], listChats: () => [],
    markEntryRead() {}, markAllRead() {}
  };
  const orch = new Orchestrator({
    store: stubStore,
    sessions: { current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null, discard() {} },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  const calls = [];
  orch.wake = (ck, opts) => { calls.push({ ck, opts: opts || {} }); return Promise.resolve(); };

  orch.browseNextAt.set(KEY, Date.now() - 1);        // 安静群：到点
  orch.browseNextAt.set(OTHER, Date.now() - 1);      // 非安静群：到点
  orch.startBrowseLoop();
  await new Promise((r) => setTimeout(r, 2600));
  const quietCall = calls.find((c) => c.ck === KEY);
  const otherCall = calls.find((c) => c.ck === OTHER);
  check('安静群到点 → wake 带 quietOrganize', !!quietCall && quietCall.opts.quietOrganize === true, JSON.stringify(calls));
  check('非安静群到点 → 不带 quietOrganize', !!otherCall && otherCall.opts.quietOrganize !== true, JSON.stringify(otherCall || {}));
  await orch.abortAll();

  // 安静群不走静默补拍：节拍点远未到，但有静默未读 —— 不应补拍
  const orch2 = new Orchestrator({
    store: stubStore,
    sessions: { current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null, discard() {} },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  const calls2 = [];
  orch2.wake = (ck, opts) => { calls2.push({ ck, opts: opts || {} }); return Promise.resolve(); };
  orch2.browseNextAt.set(KEY, Date.now() + 600000);   // 远未到点
  orch2.startBrowseLoop();
  await new Promise((r) => setTimeout(r, 2600));
  check('安静群不走静默补拍', !calls2.some((c) => c.ck === KEY), JSON.stringify(calls2));
  await orch2.abortAll();

  bcfg.sweepMs = oldSweep;
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length === 0) {
  console.log('ALL PASS ' + results.length + '/' + results.length);
} else {
  console.log('FAILED ' + failed.length + '/' + results.length);
  for (const f of failed) console.log('  FAIL ' + f.name + ' :: ' + f.detail);
  process.exit(1);
}
