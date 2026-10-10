// verify-qqagent-hardlimit.mjs — 「发言硬限制」自测
//
// 用法：node verify-qqagent-hardlimit.mjs
// 判据（Rushiera 2026-10-10 规格：「增加一个每 60 秒最多 1 次发言的硬限制」）：
//   1 硬限开（60 秒 1 条）：窗口内第 1 条放行、第 2 条被拒
//   2 被拒的消息**没有真的发出去**（闸门在出站口）
//   3 被拒的发送不占任何配额（quota 表不增长 —— 抛错在记账之前）
//   4 窗口过期 → 重新放行
//   5 enabled=false → 闸门不生效（可回退）
//   6 提示词余量取两道闸的更严者（quotaState）
//   7 与 quota 并存且错误可区分（硬限制 vs 发言配额）
//   8 补丁落盘：四个补丁点标记齐全（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.hardlimit-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：不调用 —— 本自测只覆盖发送面闸门，不产生模型请求。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DATA = path.resolve(HERE, '..', 'runtime', '.hardlimit-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

// 自测用配置：发送间隔压到最小（不然每条要等 1~3 秒）；两道闸都开 ——
// 硬限 60s/1、配额 120s/5（与生产默认同形），便于验证"取更严者"与"被拒不占配额"。
const CFG_PATH = path.join(DATA, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.send = { ...cfg.send, minGapMs: 1, maxGapMs: 2, byLengthMs: 0, dedupeWindowMs: 0, hardSplitAt: 0 };
cfg.engage = {
  ...(cfg.engage || {}),
  quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
  hardLimit: { enabled: true, windowMs: 60000, maxPerWindow: 1 }
};
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(APP, 'src', rel)).href;
const { getConfig } = await import(mod('config.js'));
const { SendQueue } = await import(mod('sender.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const KEY = 'group:1097492606';
let sentCount = 0;
const fakeOnebot = {
  async sendText(kind, id, text) { sentCount += 1; return { message_id: sentCount }; },
  async sendPoke() { sentCount += 1; return { message_id: sentCount }; }
};
const fakeStore = { appendSelf() {} };
const sender = new SendQueue({ onebot: fakeOnebot, store: fakeStore });

const setHard = (o) => { getConfig().engage = { ...(getConfig().engage || {}), hardLimit: { ...(getConfig().engage?.hardLimit || {}), ...o } }; };
const setQuota = (o) => { getConfig().engage = { ...(getConfig().engage || {}), quota: { ...(getConfig().engage?.quota || {}), ...o } }; };
const resetWindows = () => { sender.hardTimes.delete(KEY); sender.quotaTimes.delete(KEY); };

/** 发一条，返回 { ok, error }。 */
async function trySend(text) {
  try { await sender.sendTextBatch(KEY, [text]); return { ok: true, error: '' }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ── 1. 硬限生效：窗口内第 1 条放行、第 2 条被拒 ─────────────────────────────
resetWindows();
{
  const r1 = await trySend('第 1 条：应当放行');
  check('窗口内第 1 条放行', r1.ok, r1.error);
  const before = sentCount;
  const r2 = await trySend('第 2 条：应当被硬限制拦下');
  check('窗口内第 2 条被拒（错误回给模型）', !r2.ok && /发言硬限制/.test(r2.error), r2.error);
  check('被拒的消息没有真的发出去', sentCount === before, '发出 ' + (sentCount - before) + ' 条');
  check('被拒的发送不占配额（抛错在记账之前）', (sender.quotaTimes.get(KEY) || []).length === 1,
    'quota 记账 ' + (sender.quotaTimes.get(KEY) || []).length + ' 条');
}

// ── 2. 窗口过期 → 重新放行 ──────────────────────────────────────────────────
{
  sender.hardTimes.set(KEY, [Date.now() - 60001]);
  const r = await trySend('窗口过期后应当放行');
  check('窗口过期 → 重新放行', r.ok, r.error);
}

// ── 3. enabled=false → 闸门不生效（可回退）──────────────────────────────────
{
  setHard({ enabled: false });
  resetWindows();
  const r1 = await trySend('硬限关闭：第 1 条');
  const r2 = await trySend('硬限关闭：第 2 条');
  check('enabled=false → 连续两条都放行', r1.ok && r2.ok, r1.error || r2.error);
  setHard({ enabled: true });
}

// ── 4. 提示词余量取两道闸的更严者 ───────────────────────────────────────────
{
  resetWindows();
  const s = sender.quotaState(KEY);
  check('quotaState 取更严者（硬限 60s/1 压过配额 120s/5）',
    s && s.windowMs === 60000 && s.max === 1, JSON.stringify(s));
  setHard({ enabled: false });
  const s2 = sender.quotaState(KEY);
  check('硬限关闭 → 回落配额（120s/5）', s2 && s2.windowMs === 120000 && s2.max === 5, JSON.stringify(s2));
  setQuota({ enabled: false });
  const s3 = sender.quotaState(KEY);
  check('两道闸都关 → null（不注入提示段）', s3 === null, String(s3));
  setQuota({ enabled: true });
  setHard({ enabled: true });
}

// ── 5. 与 quota 并存且错误可区分 ────────────────────────────────────────────
{
  setHard({ enabled: false });
  setQuota({ enabled: true, windowMs: 120000, maxPerWindow: 1 });
  resetWindows();
  const r1 = await trySend('配额 1 条：第 1 条');
  const r2 = await trySend('配额 1 条：第 2 条应当被配额拦');
  check('配额闸门独立生效（错误信息为"发言配额"，不含"硬限制"）',
    r1.ok && !r2.ok && /发言配额/.test(r2.error) && !/硬限制/.test(r2.error), r2.error);
  setQuota({ enabled: true, windowMs: 120000, maxPerWindow: 5 });
  setHard({ enabled: true });
}

// ── 6. 补丁落盘：四个补丁点标记齐全 ─────────────────────────────────────────
{
  const marks = [
    ['src/config.js', '[qqagent-hardlimit-patch:config-hardlimit]'],
    ['src/sender.js', '[qqagent-hardlimit-patch:sender-ctor]'],
    ['src/sender.js', '[qqagent-hardlimit-patch:sender-checkrate]'],
    ['src/sender.js', '[qqagent-hardlimit-patch:sender-quotastate]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(APP, rel), 'utf8').includes(m));
  check('补丁标记齐全（4/4）', missing.length === 0, missing.map((x) => x[1]).join(' '));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
