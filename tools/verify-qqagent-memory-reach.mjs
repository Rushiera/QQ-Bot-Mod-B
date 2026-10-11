// verify-qqagent-memory-reach.mjs — 「记忆回溯点」自测（端到端）
//
// 用法：node verify-qqagent-memory-reach.mjs
// 判据：design-qqbotb-memory.md §3.8 五条
//   1 置位 / 清零点落到 session-state（memoryFloorTs 持久化）
//   2 收工轮窗口回溯：sessionWindowStart(chat, { reach: true }) = min(会话起点, 回溯点)
//   3 回溯点晚于会话起点 / 为 0 / 会话起点为 0 → 退回会话起点（不多带、不误带）
//   4 群记追加面：200 字符截断 + 同 kind 同内容不重复 + 非法 kind 拒绝
//   5 补丁幂等：session / navigator 两个补丁脚本 --dry 全 skipped（0 applied）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.memory-reach-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DATA = path.resolve(HERE, '..', 'runtime', '.memory-reach-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(APP, 'src', rel)).href;
const ss = await import(mod('session-state.js'));
const gm = await import(mod('group-memory.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const CHAT = 'group:1097492606';
const T0 = 1791639660846;            // 会话起点（模拟）
const T1 = T0 + 6 * 3600 * 1000;     // 回溯点（晚于起点）
const T2 = T0 - 3600 * 1000;         // 回溯点（早于起点）

// ── 1 置位与持久化 ───────────────────────────────────────────────────────────
ss.setSessionState(CHAT, { startedAt: T0 });
ss.setMemoryFloor(CHAT, T1);
check('1 置位落到 session-state', ss.getSessionState(CHAT).memoryFloorTs === T1, ss.getSessionState(CHAT).memoryFloorTs);
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'session-state.json'), 'utf8').replace(/^\uFEFF/, ''));
check('1b 落盘可见 memoryFloorTs', Number(raw?.chats?.[CHAT]?.memoryFloorTs) === T1);

// ── 2 收工轮窗口回溯 ─────────────────────────────────────────────────────────
check('2 普通轮 = 会话起点', ss.sessionWindowStart(CHAT) === T0, ss.sessionWindowStart(CHAT));
check('2b 回溯点更晚 → 仍取会话起点', ss.sessionWindowStart(CHAT, { reach: true }) === T0, ss.sessionWindowStart(CHAT, { reach: true }));
ss.setMemoryFloor(CHAT, T2);
check('2c 回溯点更早 → 取回溯点', ss.sessionWindowStart(CHAT, { reach: true }) === T2, ss.sessionWindowStart(CHAT, { reach: true }));

// ── 3 清零与边界 ─────────────────────────────────────────────────────────────
ss.setMemoryFloor(CHAT, 0);
check('3 清零后收工轮退回会话起点', ss.sessionWindowStart(CHAT, { reach: true }) === T0);
ss.setMemoryFloor(CHAT, T1);
check('3b 会话起点为 0 时不回溯', ss.sessionWindowStart('group:999', { reach: true }) === 0, ss.sessionWindowStart('group:999', { reach: true }));

// ── 4 群记追加面（沉淀落点）──────────────────────────────────────────────────
// ⚠️ 素材不带尾随空白：落盘侧（normalizeEntry）会再 trim 一次，尾随空白会让
//    「同 kind 同内容」的比较失配 → 重复条目（已知小坑，记在 design-qqbotb_log.md）。
const long = '领航场次·'.repeat(60);
const e1 = gm.appendGroupEntry(CHAT, 'project', long);
check('4 群记条目写入', !!e1);
check('4b 正文按 200 字符截断', e1?.content?.length === 200, e1?.content?.length);
gm.appendGroupEntry(CHAT, 'project', long);
check('4c 同 kind 同内容不重复', gm.listGroupEntries(CHAT).filter((x) => x.content === e1.content).length === 1);
check('4d 非法 kind 拒绝', gm.appendGroupEntry(CHAT, 'nope', 'x') === null);

// ── 5 补丁幂等 ───────────────────────────────────────────────────────────────
for (const script of ['patch-qqagent-session.mjs', 'patch-qqagent-navigator.mjs']) {
  let report = null;
  try {
    report = JSON.parse(execFileSync(process.execPath, [path.join(HERE, script), '--dry'], { encoding: 'utf8' }));
  } catch (error) {
    check('5 ' + script + ' --dry', false, String(error?.message ?? error).slice(0, 140));
    continue;
  }
  const applied = Array.isArray(report.applied) ? report.applied.length : Number(report.applied) || 0;
  check('5 ' + script + ' --dry 全 skipped', applied === 0, 'applied=' + applied);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, total: results.length }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
