// verify-qqagent-botguard.mjs — 「bot 指定限频」自测
//
// 用法：node verify-qqagent-botguard.mjs
// 判据（Rushiera 2026-10-10 规格）：
//   1 记忆页把群友指定为机器人（config.engage.botGuard.members）→ 对该群友的回复限频
//   2 额度：windowMs 内最多 maxPerWindow 条（现行 240 秒 1 条）
//   3 额度未满时放行，且**一轮运行算一次回复**（同轮多条不再重复判定）
//   4 额度已满时抛错（错误回给模型）—— 且那条消息**没有真的发出去**
//   5 显式点名（atUserId / 拍一拍目标）走同一条闸门
//   6 记账在发送成功之后：发送失败不占额度
//   7 名单为空 / enabled=false → 闸门不生效（可回退）
//   8 补丁落盘：四个文件的改动标记齐全（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.botguard-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：不调用 —— 本自测只覆盖发送面闸门，不产生模型请求。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.botguard-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

// 自测用配置：发送间隔压到最小（不然每条要等 1~3 秒）；关掉发言配额（那是另一个功能的闸门，
// 混在一起会把"bot 闸门拒绝"和"配额拒绝"搅成同一个错误），只留 bot 闸门。
const CFG_PATH = path.join(DATA, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.send = { ...cfg.send, minGapMs: 1, maxGapMs: 2, byLengthMs: 0, dedupeWindowMs: 0, hardSplitAt: 0 };
cfg.engage = {
  ...(cfg.engage || {}),
  quota: { enabled: false },
  topicWords: { enabled: true },
  botGuard: { enabled: true, windowMs: 240000, maxPerWindow: 1, members: [] }
};
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getConfig } = await import(mod('config.js'));
const { SendQueue } = await import(mod('sender.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const KEY = 'group:1097492606';
const BOT = '10001';          // 被指定为机器人的群友
const HUMAN = '10002';        // 普通群友（对照组）

let sentCount = 0;
let failNext = false;
const fakeOnebot = {
  async sendText(kind, id, text) {
    if (failNext) { failNext = false; throw new Error('模拟 OneBot 发送失败'); }
    sentCount += 1;
    return { message_id: sentCount };
  },
  async sendPoke() { sentCount += 1; return { message_id: sentCount }; }
};
const fakeStore = { appendSelf() {} };
const sender = new SendQueue({ onebot: fakeOnebot, store: fakeStore });

const setGuard = (patchObj) => {
  getConfig().engage = { ...(getConfig().engage || {}), botGuard: { ...(getConfig().engage?.botGuard || {}), ...patchObj } };
};
const resetWindow = () => sender.botReplyTimes.delete(KEY + '::' + BOT);

/** 发一条，返回 { ok, error }。 */
async function trySend(text, options = {}) {
  try { await sender.sendTextBatch(KEY, [text], options); return { ok: true, error: '' }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ── 1. 对照组：名单为空 → 闸门不生效 ─────────────────────────────────────────
setGuard({ enabled: true, windowMs: 240000, maxPerWindow: 1, members: [] });
sender.setRunBotTarget(KEY, BOT);
{
  const r = await trySend('名单空：应当放行');
  check('名单为空 → 闸门不生效', r.ok, r.error);
}
sender.clearRunBotTarget(KEY);

// ── 2. 额度未满 → 放行；一轮运行算一次回复（同轮多条不重复判定）──────────────
setGuard({ members: [BOT] });
resetWindow();
{
  sender.setRunBotTarget(KEY, BOT);
  const r1 = await trySend('回机器人：第 1 条');
  const r2 = await trySend('回机器人：同轮第 2 条');
  check('额度未满 → 放行', r1.ok, r1.error);
  check('一轮运行算一次回复（同轮第 2 条不重复判定）', r2.ok, r2.error);
  sender.clearRunBotTarget(KEY);
}

// ── 3. 窗口内下一轮 → 被拒，且消息没有真的发出去 ────────────────────────────
{
  const before = sentCount;
  sender.setRunBotTarget(KEY, BOT);
  const r = await trySend('回机器人：下一轮应当被拒');
  sender.clearRunBotTarget(KEY);
  check('窗口内下一轮被拒（错误回给模型）', !r.ok && /已被指定为机器人/.test(r.error), r.error);
  check('被拒的消息没有真的发出去', sentCount === before, '发出 ' + (sentCount - before) + ' 条');
}

// ── 4. 显式点名（本轮运行目标是别人）→ 走同一条闸门 ──────────────────────────
{
  const before = sentCount;
  sender.setRunBotTarget(KEY, null);
  const r = await trySend('@机器人（本轮触发者是别人）', { atUserId: BOT });
  check('显式 @ 目标群友 → 走同一条闸门', !r.ok && /已被指定为机器人/.test(r.error), r.error);
  check('显式 @ 被拒时也没发出去', sentCount === before);
}

// ── 5. 对照组：普通群友不受影响 ──────────────────────────────────────────────
{
  sender.setRunBotTarget(KEY, null);
  const r = await trySend('回普通群友', { atUserId: HUMAN });
  check('普通群友不受影响', r.ok, r.error);
}

// ── 6. 拍一拍目标同样是"回该群友" ────────────────────────────────────────────
{
  sender.setRunBotTarget(KEY, null);
  let err = '';
  try { await sender.poke(KEY, Number(BOT)); } catch (e) { err = String(e?.message ?? e); }
  check('拍一拍目标为指定群友 → 同样被拒', /已被指定为机器人/.test(err), err);
}

// ── 7. 窗口过期 → 重新放行 ───────────────────────────────────────────────────
{
  sender.botReplyTimes.set(KEY + '::' + BOT, [Date.now() - 240001]);
  sender.setRunBotTarget(KEY, BOT);
  const r = await trySend('窗口过期后应当放行');
  sender.clearRunBotTarget(KEY);
  check('窗口过期 → 重新放行', r.ok, r.error);
}

// ── 8. 记账在成功之后：发送失败不占额度 ──────────────────────────────────────
{
  resetWindow();
  failNext = true;
  sender.setRunBotTarget(KEY, BOT);
  const r1 = await trySend('这条会失败');
  sender.clearRunBotTarget(KEY);
  check('发送失败时抛错（错误回给模型）', !r1.ok, r1.error);

  sender.setRunBotTarget(KEY, BOT);
  const r2 = await trySend('失败后的下一轮应当放行');
  sender.clearRunBotTarget(KEY);
  check('发送失败不占额度（记账在成功之后）', r2.ok, r2.error);
}

// ── 9. enabled=false → 闸门关闭（可回退）────────────────────────────────────
{
  setGuard({ enabled: false });
  sender.botReplyTimes.set(KEY + '::' + BOT, [Date.now()]);
  sender.setRunBotTarget(KEY, BOT);
  const r = await trySend('闸门关闭后应当放行');
  sender.clearRunBotTarget(KEY);
  check('enabled=false → 闸门关闭（可回退）', r.ok, r.error);
  setGuard({ enabled: true });
}

// ── 10. 补丁落盘检查 ────────────────────────────────────────────────────────
{
  const marks = [
    ['config.js', '[qqagent-botguard-patch:config-botguard]'],
    ['sender.js', '[qqagent-botguard-patch:sender-checkrate]'],
    ['sender.js', '[qqagent-botguard-patch:sender-methods]'],
    ['sender.js', '[qqagent-botguard-patch:sender-mark]'],
    ['orchestrator.js', '[qqagent-botguard-patch:orchestrator-run-target]'],
    ['orchestrator.js', '[qqagent-botguard-patch:orchestrator-run-target-clear]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, rel), 'utf8').includes(m));
  check('补丁标记齐全（src 六处）', missing.length === 0, missing.map((x) => x.join(':')).join(', ') || '全部命中');

  const ui = fs.readFileSync(path.join(BIZ, 'ui', '05-memory-settings.js'), 'utf8');
  const uiMarks = [
    '[qqagent-botguard-patch:ui-mem-bot-list]',
    '[qqagent-botguard-patch:ui-mem-bot-handler]',
    '[qqagent-botguard-patch:ui-members-bot-handler]',
    '[qqagent-botguard-patch:ui-toggle-fn]'
  ].filter((m) => !ui.includes(m));
  check('补丁标记齐全（记忆页 UI 四处）', uiMarks.length === 0, uiMarks.join(', ') || '全部命中');

  check('记忆页两个入口都在（群友印象卡 + 群成员表）',
    ui.includes('mem-bot-toggle') && ui.includes('member-bot-toggle'));
  check('记忆页开关写的是 config.engage.botGuard.members',
    ui.includes('engage: { botGuard: { members: next } }'));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
