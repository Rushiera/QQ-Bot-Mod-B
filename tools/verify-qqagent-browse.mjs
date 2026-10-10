// verify-qqagent-browse.mjs — 「浏览节拍」自测
//
// 用法：node verify-qqagent-browse.mjs
// 判据（Rushiera 2026-10-10 口述规格）：
//   A 档位与回落
//     1 默认 = 基础档（每 240 秒），未升档
//     2 setBrowseLevel(3) → 每 60 秒、raised
//     3 有效期未到 → 不降档
//     4 有效期到 → 降一档（60 → 120 → 240）
//     5 最低档不再降（changed=false）
//   B 发言续期
//     6 升档后发言 → 有效期顺延
//     7 基础档发言 → 不产生有效期（不凭空"升档"）
//   C 提示词【群节奏】段
//     8 基础档：含「每 240 秒」「基础节拍」
//     9 升档：含「省着说」「自动降回来」「额度没变」
//    10 @ 批：含「点名找你」
//    11 私聊：不注入
//    12 节拍关闭：不注入
//   D 指令禁言
//    13 禁言期内 → browseMuted true（回 1 档语义，不走节拍）
//   E 档位覆盖（storeConfigForChat）
//    14 节拍开启 → 档位统一 4 档（避免浏览拍被判"未触发"整批归档）
//    15 节拍关闭 → 回到滑条档位
//    16 指令禁言优先 → 强制 1 档
//   F 工具面
//    17 set_browse_rate 已注册，参数 level 必填
//    18 群聊调用 → 返回节拍秒数；私聊调用 → 明确拒绝
//   G 发送续期链路（sender 放行即续期）
//    19 升档后发一条 → 有效期顺延
//   H 源码落点
//    20 补丁 16 个标记齐全（幂等可重放）
//    21 orchestrator 含节拍巡检与"回节拍"分支
//   A2 静默补拍（最后一条未读静默 60 秒没人接话 → 也看一次；同一批只补一拍）
//    22 阈值默认 60 秒；未满不补、满了补、无未读不补、同一批不重复补拍
//    23 idleMs=0 → 关闭；配置缺失 → 回落默认
//   I2 静默补拍链路端到端
//    24 未到节拍点但有静默未读 → 巡检也 wake；同一批不重复补拍
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.browse-selftest）。
// LLM：不调用 —— 只覆盖节拍状态机 / 提示词段 / 工具面 / 发送续期。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DATA = path.resolve(HERE, '..', 'runtime', '.browse-selftest');
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
  }
};
cfg.store = { ...(cfg.store || {}), contextTier: 4, contextSliderPos: 0, unifiedTier: true };
cfg.commandMute = { enabled: true, command: '/安静', durationMin: 30, active: {} };
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(APP, 'src', rel)).href;
const { getConfig, storeConfigForChat } = await import(mod('config.js'));
const {
  browseEnabled, browseMuted, browseIntervalMs, browseState,
  setBrowseLevel, holdBrowse, decayBrowse, browseHint,
  idleTriggerMs, idleFireDue, markIdleFired
} = await import(mod('browse-rate.js'));
const { buildToolDefs } = await import(mod('tools.js'));
const { SendQueue } = await import(mod('sender.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const KEY = 'group:1097492606';
const GROUP_ID = '1097492606';
const PRIVATE = 'private:10001';

// ── A. 档位与回落 ──────────────────────────────────────────────────────────
{
  const s0 = browseState(KEY);
  check('默认 = 基础档（240 秒）', s0.intervalMs === 240000 && s0.level === 1 && !s0.raised, JSON.stringify(s0));
  const s3 = setBrowseLevel(KEY, 3);
  check('升档 3 → 每 60 秒', s3.intervalMs === 60000 && s3.level === 3 && s3.raised, JSON.stringify(s3));
  const d0 = decayBrowse(KEY, Date.now());
  check('有效期未到 → 不降档', d0.changed === false && browseState(KEY).level === 3);
  const far = Date.now() + 16 * 60000;
  const d1 = decayBrowse(KEY, far);
  check('有效期到 → 降一档（3→2，每 120 秒）', d1.changed === true && d1.state.intervalMs === 120000, JSON.stringify(d1.state));
  const d2 = decayBrowse(KEY, Date.now() + 32 * 60000);
  check('再降一档（2→1，每 240 秒）', d2.changed === true && d2.state.intervalMs === 240000, JSON.stringify(d2.state));
  const d3 = decayBrowse(KEY, Date.now() + 48 * 60000);
  check('最低档不再降（changed=false）', d3.changed === false && d3.state.level === 1, JSON.stringify(d3.state));
}

// ── A2. 静默补拍（最后一条未读静默 N 秒没人接话 → 也看一次）────────────────
{
  const now = Date.now();
  check('静默补拍：阈值默认 60 秒', idleTriggerMs() === 60000, String(idleTriggerMs()));
  check('静默补拍：未满 60 秒 → 不补拍', idleFireDue(KEY, now - 30000, now) === false);
  const ts = now - 61000;
  check('静默补拍：满 60 秒 → 补拍', idleFireDue(KEY, ts, now) === true);
  check('静默补拍：无未读（ts=0）→ 不补拍', idleFireDue(KEY, 0, now) === false);
  markIdleFired(KEY, ts);
  check('静默补拍：同一批只补一拍', idleFireDue(KEY, ts, now) === false);
  check('静默补拍：新一批（ts 变了）→ 可再补', idleFireDue(KEY, ts - 1000, now) === true);
  getConfig().engage.browse.idleMs = 0;
  check('静默补拍：idleMs=0 → 关闭', idleFireDue(KEY, ts - 1000, now) === false && idleTriggerMs() === 0);
  delete getConfig().engage.browse.idleMs;
  check('静默补拍：配置缺失 → 回落默认 60 秒', idleTriggerMs() === 60000);
}

// ── B. 发言续期 ────────────────────────────────────────────────────────────
{
  setBrowseLevel(KEY, 2);
  const before = browseState(KEY).expiresAt;
  await new Promise((r) => setTimeout(r, 25));
  holdBrowse(KEY);
  const after = browseState(KEY).expiresAt;
  check('升档后发言 → 有效期顺延', after > before, before + ' → ' + after);
  setBrowseLevel(KEY, 1);
  holdBrowse(KEY);
  check('基础档发言 → 不凭空产生有效期', browseState(KEY).expiresAt === 0, String(browseState(KEY).expiresAt));
}

// ── C. 提示词【群节奏】段 ──────────────────────────────────────────────────
{
  setBrowseLevel(KEY, 1);
  const base = browseHint(KEY);
  check('基础档：含「每 240 秒」', base.includes('每 240 秒看一次'), base.slice(0, 70));
  check('基础档：含「基础节拍」与「不用每条都接」', base.includes('基础节拍') && base.includes('不用每条都接'));
  setBrowseLevel(KEY, 3);
  const fast = browseHint(KEY);
  check('升档：含「省着说」', fast.includes('省着说'), fast.slice(0, 90));
  check('升档：含「自动降回来」', fast.includes('自动降回来'));
  check('升档：含「额度没变」', fast.includes('额度没变'));
  check('@ 批：含「点名找你」', browseHint(KEY, { atMe: true }).includes('点名找你'));
  check('私聊：不注入', browseHint(PRIVATE) === '', JSON.stringify(browseHint(PRIVATE)));
  getConfig().engage.browse.enabled = false;
  check('节拍关闭：不注入', browseHint(KEY) === '' && browseEnabled() === false);
  getConfig().engage.browse.enabled = true;
}

// ── D. 指令禁言 ────────────────────────────────────────────────────────────
{
  check('未禁言 → browseMuted false', browseMuted(KEY) === false);
  getConfig().commandMute.active[GROUP_ID] = 0;
  check('禁言期内 → browseMuted true（不走节拍）', browseMuted(KEY) === true);
  delete getConfig().commandMute.active[GROUP_ID];
}

// ── E. 档位覆盖 ────────────────────────────────────────────────────────────
{
  getConfig().engage.browse.enabled = false;
  check('滑条基线 = 1 档（contextSliderPos 0）', storeConfigForChat(KEY).contextTier === 1);
  getConfig().engage.browse.enabled = true;
  check('节拍开启 → 档位统一 4 档', storeConfigForChat(KEY).contextTier === 4, String(storeConfigForChat(KEY).contextTier));
  getConfig().engage.browse.enabled = false;
  check('节拍关闭 → 回到滑条档位', storeConfigForChat(KEY).contextTier === 1);
  getConfig().engage.browse.enabled = true;
  getConfig().commandMute.active[GROUP_ID] = 0;
  check('指令禁言优先 → 强制 1 档', storeConfigForChat(KEY).contextTier === 1);
  delete getConfig().commandMute.active[GROUP_ID];
}

// ── F. 工具面 ──────────────────────────────────────────────────────────────
{
  const defs = buildToolDefs();
  const tool = defs.find((d) => d.id === 'set_browse_rate');
  check('set_browse_rate 已注册', !!tool, tool ? tool.name : '未找到');
  check('参数 level 必填', !!tool && Array.isArray(tool.parameters?.required)
    && tool.parameters.required.includes('level'), JSON.stringify(tool?.parameters?.required));
  const ctx = { chatKey: KEY };
  const r1 = await tool.execute(ctx, { level: 2 });
  const body1 = JSON.parse(r1.content);
  check('群聊调用 → 节拍 120 秒', r1.isError !== true && body1.intervalSeconds === 120, r1.content.slice(0, 80));
  const r2 = await tool.execute({ chatKey: PRIVATE }, { level: 2 });
  check('私聊调用 → 明确拒绝', r2.isError === true, r2.content.slice(0, 60));
  const r3 = await tool.execute(ctx, { level: 9 });
  check('越界档位 → 钳到最快档', JSON.parse(r3.content).level === 3, r3.content.slice(0, 60));
}

// ── G. 发送续期链路 ────────────────────────────────────────────────────────
{
  let n = 0;
  const fakeOnebot = { async sendText() { n += 1; return { message_id: n }; } };
  const sender = new SendQueue({ onebot: fakeOnebot, store: { appendSelf() {} } });
  setBrowseLevel(KEY, 3);
  const before = browseState(KEY).expiresAt;
  await new Promise((r) => setTimeout(r, 25));
  await sender.sendTextBatch(KEY, ['测试一句']);
  const after = browseState(KEY).expiresAt;
  check('sender 放行 → 节拍有效期顺延', after > before, before + ' → ' + after);
}

// ── H. 源码落点 ────────────────────────────────────────────────────────────
{
  const marks = [
    'browse-rate', 'config-browse', 'config-tier',
    'orchestrator-import', 'orchestrator-logger-import', 'orchestrator-ctor',
    'orchestrator-onincoming', 'orchestrator-methods',
    'orchestrator-drain', 'orchestrator-backlog', 'orchestrator-abortall', 'orchestrator-hint-def',
    'tools-import', 'tools-register', 'sender-import', 'sender-hold', 'app-start',
    // 静默补拍（2026-10-11）
    'browse-rate-idle', 'config-browse-idle', 'store-lastunread',
    'orchestrator-import-idle', 'orchestrator-idle-tick'
  ];
  const files = ['browse-rate.js', 'config.js', 'store.js', 'orchestrator.js', 'tools.js', 'sender.js', 'app.js'];
  const all = files.map((f) => fs.readFileSync(path.join(APP, 'src', f), 'utf8')).join('\n');
  const missing = marks.filter((m) => !all.includes('[qqagent-browse-patch:' + m + ']'));
  check('补丁标记齐全（22 个带标记点）', missing.length === 0, missing.join(',') || '22/22');

  const orch = fs.readFileSync(path.join(APP, 'src', 'orchestrator.js'), 'utf8');
  check('提示词拼接含 browseLine', orch.includes('+ chatterHint + browseLine'));
  check('含节拍巡检入口', orch.includes('#ensureBrowseLoop()') && orch.includes('#browseTick()'));
  check('运行结束回节拍', orch.includes('this.#noteBrowsePending(chatKey, true);'));
  check('@ / 私聊例外分支在位', orch.includes('const immediate = (isPrivate && browseCfg.privateImmediate !== false)'));
  check('无新增内容不调 LLM', orch.includes('if (unread <= 0) continue;   // 没人发言 → 不调 LLM'));
  check('含静默补拍分支（判定 + 记账）', orch.includes('idleFireDue(chatKey, lastUnreadTs, now)')
    && orch.includes('markIdleFired(chatKey, lastUnreadTs)'));
  check('store 提供 lastUnreadTs', fs.readFileSync(path.join(APP, 'src', 'store.js'), 'utf8').includes('lastUnreadTs(chatKey)'));
}

// ── I. 节拍链路端到端（假时钟：档位 80ms / 巡检 20ms）─────────────────────
// 这一块专治"自测只测模块、不测链路"——判例：`#browseTick` 里用了没导入的
// `decayBrowse`，巡检每 5 秒抛一次 ReferenceError 被 catch 吞掉，表现是
// "群里有人说话但永远不醒"；模块级自测全绿也发现不了。
{
  const { Orchestrator } = await import(mod('orchestrator.js'));
  const bcfg = getConfig().engage.browse;
  const oldLevels = bcfg.levels;
  const oldSweep = bcfg.sweepMs;
  const BACKLOG = 'group:999999';
  // ⚠️ 巡检间隔有 2000ms 下限（`Math.max(2000, sweepMs)`）——测试按真实下限设，
  // 别指望把 sweepMs 压到 20ms 就能瞬间出结果。
  bcfg.levels = [100, 60, 40];
  bcfg.sweepMs = 2000;
  const orch = new Orchestrator({
    store: {
      unreadCount: () => 3, peekUnread: () => [], listChats: () => [BACKLOG],
      markEntryRead() {}, markAllRead() {}
    },
    sessions: { current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null, discard() {} },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  const woken = [];
  orch.wake = (ck) => { woken.push(ck); return Promise.resolve(); };
  orch.onIncoming(KEY, { id: 1, atMe: false, isPoke: false });
  await new Promise((r) => setTimeout(r, 2600));
  check('节拍链路：onIncoming → 巡检 → wake', woken.includes(KEY), JSON.stringify(woken));
  check('节拍链路：已有未读的群随循环启动纳入节拍', woken.includes(BACKLOG), JSON.stringify(woken));

  woken.length = 0;
  orch.store = { ...orch.store, unreadCount: () => 0 };
  orch.browseNextAt.set(KEY, Date.now() - 1);
  await new Promise((r) => setTimeout(r, 2400));
  check('节拍链路：无新内容 → 不调 LLM', woken.length === 0, JSON.stringify(woken));

  await orch.abortAll();
  bcfg.levels = oldLevels;
  bcfg.sweepMs = oldSweep;
}

// ── I2. 静默补拍端到端（不到节拍点，靠静默触发）─────────────────────────────
// 判据：有未读 + 最后一条未读已静默 > idleMs → 巡检也起一次会话（不必等满一拍）；
//       同一批只补一拍；阈值关闭时完全不走这条路。
{
  const { Orchestrator } = await import(mod('orchestrator.js'));
  const bcfg = getConfig().engage.browse;
  const oldLevels = bcfg.levels;
  const oldSweep2 = bcfg.sweepMs;
  const IDLE_KEY = 'group:777777';
  const idleTs = Date.now() - 90000;        // 固定值：模拟"最后一条未读已静默 90 秒"
  bcfg.levels = [600000, 300000, 120000];   // 基础档 10 分钟 —— 明确"远未到点"
  bcfg.sweepMs = 2000;                      // 巡检下限（Math.max(2000, sweepMs)）
  const orch = new Orchestrator({
    store: {
      unreadCount: () => 2,
      lastUnreadTs: () => idleTs,
      peekUnread: () => [], listChats: () => [],
      markEntryRead() {}, markAllRead() {}
    },
    sessions: { current: new Map(), create: () => ({ id: 'stub' }), update() {}, get: () => null, discard() {} },
    sender: {}, onebot: { selfId: '1', selfNickname: '' }, memory: {}, stickers: {}, emit: () => {}
  });
  const woken = [];
  orch.wake = (ck) => { woken.push(ck); return Promise.resolve(); };
  orch.browseNextAt.set(IDLE_KEY, Date.now() + 600000);
  orch.startBrowseLoop();
  await new Promise((r) => setTimeout(r, 2600));
  check('静默补拍链路：未到点但有静默未读 → wake', woken.includes(IDLE_KEY), JSON.stringify(woken));
  const first = woken.length;
  await new Promise((r) => setTimeout(r, 2600));
  check('静默补拍链路：同一批不重复补拍', woken.length === first, JSON.stringify(woken));
  await orch.abortAll();
  bcfg.levels = oldLevels;
  bcfg.sweepMs = oldSweep2;
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
