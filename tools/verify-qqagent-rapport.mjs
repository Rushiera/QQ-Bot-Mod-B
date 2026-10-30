// verify-qqagent-rapport.mjs — 「回应参数（群友回应意愿分）」自测
//
// 用法：node verify-qqagent-rapport.mjs
// 判据（Rushiera 2026-10-18 规格）：
//   1 所有群友初始 100；分数映射到"对这位群友回复的硬限速"——0 分 20 分钟最多 1 条
//   2 分数低 → 冷却长：线性映射（0 → 1200000ms · 50 → 600000ms · 100 → 0）
//   3 额度未满 / 冷却已过 → 放行；**一轮运行算一次回复**（同轮多条不再重复判定）
//   4 冷却未过 → 抛错（错误回给模型）—— 且那条消息**没有真的发出去**
//   5 显式点名（atUserId / 拍一拍目标）走同一条闸门
//   6 记账在发送成功之后：发送失败不占冷却
//   7 自愈：healAll 给不足 100 的群友加分，回到 100 即条目消失（纯本地、不调 LLM）
//   8 分数按群友个人持久化（重载缓存后仍在）
//   9 提示段：分数低才出现【回应参数】，全部 100 分时不占 token
//  10 教程段进系统提示（lean + full 都带）· 工具 adjust_rapport 已注册
//  11 enabled=false → 闸门关闭（可回退）
//  12 补丁落盘：八个文件的改动标记齐全（幂等可重放）
//  13 客观结算（2026-10-19 · 2026-10-25 降级）：我发了话，下一批没人 @ / 引用 / 拍我
//     → 判定与日志照跑，但降分量由档位 missCap 封顶（默认 0 = 只采集不降分）；
//     有人接 → 加分（+6）· 主人豁免（exemptUsers）· 同一批只结算一次 · watch.enabled=false
//     可回退 · 降下来的分在出站口真的会被拦（不是只写进文件）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.rapport-selftest），
//       不碰正在运行实例的数据目录，也不抢单实例锁。
// LLM：不调用 —— 本自测只覆盖存储 / 闸门 / 自愈 / 提示面。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.rapport-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

// 自测用配置：发送间隔压到最小（不然每条要等 1~3 秒）；关掉发言配额 / 硬限 / bot 限频
// （那是别的功能的闸门，混在一起会把"回应参数拒绝"和"配额拒绝"搅成同一个错误）。
const CFG_PATH = path.join(DATA, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.send = { ...cfg.send, minGapMs: 1, maxGapMs: 2, byLengthMs: 0, dedupeWindowMs: 0, hardSplitAt: 0 };
cfg.engage = {
  ...(cfg.engage || {}),
  quota: { enabled: false },
  hardLimit: { enabled: false },
  botGuard: { enabled: false, windowMs: 240000, maxPerWindow: 1, members: [] },
  rapport: { enabled: true, maxCooldownMs: 1200000, healPerTick: 2, healIntervalMs: 300000 }
};
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getConfig } = await import(mod('config.js'));
const { SendQueue } = await import(mod('sender.js'));
const {
  DEFAULT_SCORE, getScore, getRapport, adjustRapport, setRapport, listRapport,
  cooldownForScore, rapportRule, formatRapportHint, healAll, clearRapportCache, rapportFile
} = await import(mod('rapport.js'));
const { buildSystemPrompt } = await import(mod('prompt.js'));
const { getTool } = await import(mod('tool-registry.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const KEY = 'group:1097492606';
const LOW = '20001';      // 回应参数被压低的群友
const HUMAN = '20002';    // 普通群友（对照组，100 分）

// 关掉自愈定时器（自测手动调 healAll，不要后台跳分干扰断言）
// startHealLoop 只在 app.js 启动时调用，本自测不 import app.js，天然不启。

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

const setRapportCfg = (patchObj) => {
  getConfig().engage = {
    ...(getConfig().engage || {}),
    rapport: { ...(getConfig().engage?.rapport || {}), ...patchObj }
  };
};
const resetWindow = () => sender.rapportReplyTimes.delete(KEY + '::' + LOW);

/** 发一条，返回 { ok, error }。 */
async function trySend(text, options = {}) {
  try { await sender.sendTextBatch(KEY, [text], options); return { ok: true, error: '' }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

// ── 1. 初始 100：不额外限速 ────────────────────────────────────────────────
{
  clearRapportCache();
  check('初始分 = 100', getScore(KEY, HUMAN) === DEFAULT_SCORE, String(getScore(KEY, HUMAN)));
  check('100 分 → 冷却 0', cooldownForScore(100) === 0, String(cooldownForScore(100)));
  sender.setRunRapportTarget(KEY, HUMAN);
  const r1 = await trySend('满分群友：第 1 条');
  const r2 = await trySend('满分群友：第 2 条');
  sender.clearRunRapportTarget(KEY);
  check('100 分 → 连续两条都放行', r1.ok && r2.ok, r1.error || r2.error);
}

// ── 2. 线性映射 ────────────────────────────────────────────────────────────
{
  const rule = rapportRule();
  const c0 = cooldownForScore(0, rule);
  const c50 = cooldownForScore(50, rule);
  check('0 分 → maxCooldownMs（默认 20 分钟）', c0 === 1200000, String(c0));
  check('50 分 → 约 10 分钟', c50 === 600000, String(c50));
  check('90 分 → 约 2 分钟', cooldownForScore(90, rule) === 120000, String(cooldownForScore(90, rule)));
}

// ── 3. 压到 0 分：一轮放行、下一轮被拒且没发出去 ──────────────────────────
{
  setRapport(KEY, LOW, 0, { reason: '自测：完全不接话' });
  resetWindow();
  check('压低后分数 = 0', getScore(KEY, LOW) === 0, String(getScore(KEY, LOW)));

  sender.setRunRapportTarget(KEY, LOW);
  const r1 = await trySend('回应参数 0：本轮第 1 条');
  const r2 = await trySend('回应参数 0：同轮第 2 条');
  sender.clearRunRapportTarget(KEY);
  check('冷却未过但本轮还没回过 → 放行', r1.ok, r1.error);
  check('一轮运行算一次回复（同轮第 2 条不重复判定）', r2.ok, r2.error);

  const before = sentCount;
  sender.setRunRapportTarget(KEY, LOW);
  const r3 = await trySend('回应参数 0：下一轮应当被拒');
  sender.clearRunRapportTarget(KEY);
  check('下一轮被拒（错误含「回应参数」）', !r3.ok && /回应参数/.test(r3.error), r3.error);
  check('被拒的消息没有真的发出去', sentCount === before, '发出 ' + (sentCount - before) + ' 条');
}

// ── 4. 显式点名（本轮目标是别人）→ 走同一条闸门 ────────────────────────────
{
  const before = sentCount;
  sender.setRunRapportTarget(KEY, HUMAN);
  const r = await trySend('@低分群友（本轮触发者是别人）', { atUserId: LOW });
  sender.clearRunRapportTarget(KEY);
  check('显式 @ 低分群友 → 走同一条闸门', !r.ok && /回应参数/.test(r.error), r.error);
  check('显式 @ 被拒时也没发出去', sentCount === before);
}

// ── 5. 对照组：普通群友不受影响 ────────────────────────────────────────────
{
  sender.setRunRapportTarget(KEY, HUMAN);
  const r = await trySend('回普通群友', { atUserId: HUMAN });
  sender.clearRunRapportTarget(KEY);
  check('普通群友（100 分）不受影响', r.ok, r.error);
}

// ── 6. 拍一拍目标同样是"回该群友" ──────────────────────────────────────────
{
  sender.setRunRapportTarget(KEY, HUMAN);
  let err = '';
  try { await sender.poke(KEY, Number(LOW)); } catch (e) { err = String(e?.message ?? e); }
  sender.clearRunRapportTarget(KEY);
  check('拍一拍目标为低分群友 → 同样被拒', /回应参数/.test(err), err);
}

// ── 7. 冷却过期 → 重新放行 ─────────────────────────────────────────────────
{
  sender.rapportReplyTimes.set(KEY + '::' + LOW, [Date.now() - 1200001]);
  sender.setRunRapportTarget(KEY, LOW);
  const r = await trySend('冷却过期后应当放行');
  sender.clearRunRapportTarget(KEY);
  check('冷却过期 → 重新放行', r.ok, r.error);
}

// ── 8. 记账在成功之后：发送失败不占冷却 ───────────────────────────────────
{
  resetWindow();
  failNext = true;
  sender.setRunRapportTarget(KEY, LOW);
  const r1 = await trySend('这条会失败');
  sender.clearRunRapportTarget(KEY);
  check('发送失败时抛错（错误回给模型）', !r1.ok, r1.error);

  sender.setRunRapportTarget(KEY, LOW);
  const r2 = await trySend('失败后的下一轮应当放行');
  sender.clearRunRapportTarget(KEY);
  check('发送失败不占冷却（记账在成功之后）', r2.ok, r2.error);
}

// ── 9. 自愈：加分 + 到 100 消失 ────────────────────────────────────────────
{
  clearRapportCache();
  setRapport(KEY, LOW, 40, { reason: '自测：自愈前' });
  check('自愈前 = 40', getScore(KEY, LOW) === 40, String(getScore(KEY, LOW)));
  const r1 = healAll();
  check('自愈 +2（healPerTick）', getScore(KEY, LOW) === 42, String(getScore(KEY, LOW)) + ' · ' + JSON.stringify(r1));
  setRapport(KEY, LOW, 99, { reason: '自测：接近回满' });
  healAll();
  check('回满 100 → 条目消失（不占盘）', getScore(KEY, LOW) === 100 && !listRapport(KEY).some((x) => x.userId === LOW));
  check('全部回满后 _rapport.json 不存在', !fs.existsSync(rapportFile(KEY)));
}

// ── 10. 持久化：落盘后重载仍在 ─────────────────────────────────────────────
{
  setRapport(KEY, LOW, 30, { reason: '自测：持久化', name: '低分群友' });
  clearRapportCache();
  const e = getRapport(KEY, LOW);
  check('落盘后重载仍在（30 分 + 名字 + 理由）', e.score === 30 && e.name === '低分群友' && /持久化/.test(e.lastReason),
    JSON.stringify({ score: e.score, name: e.name, reason: e.lastReason }));
}

// ── 11. 提示段：分数低才出现 ───────────────────────────────────────────────
{
  setRapport(KEY, LOW, 20);
  const hintLow = formatRapportHint(KEY, { userIds: [LOW, HUMAN] });
  check('提示段含低分群友与硬限速', /【回应参数/.test(hintLow) && /20\/100/.test(hintLow) && /分钟回 1 条/.test(hintLow), hintLow.slice(0, 120));
  check('提示段不含 100 分群友', !hintLow.includes(HUMAN));
  check('全员 100 分 → 提示段为空', formatRapportHint(KEY, { userIds: [HUMAN] }) === '');
}

// ── 12. clamp：越界收敛 ────────────────────────────────────────────────────
{
  setRapport(KEY, LOW, 50);
  const r = adjustRapport(KEY, LOW, -999, { reason: '自测：越界' });
  check('delta 越界 → clamp 到 0', r.after === 0, String(r.after));
  const r2 = adjustRapport(KEY, LOW, 999, { reason: '自测：越界回满' });
  check('加满 → 回到 100 且条目删除', r2.after === 100 && getScore(KEY, LOW) === 100, String(r2.after));
}

// ── 13. 工具面：adjust_rapport 已注册 ──────────────────────────────────────
{
  const { buildToolDefs } = await import(mod('tools.js'));
  buildToolDefs();   // 幂等：确保全部内置工具已注册
  const t = getTool('adjust_rapport');
  check('工具 adjust_rapport 已注册', Boolean(t));
  check('工具参数含 userId / delta / reason', Boolean(t && t.parameters?.properties?.userId && t.parameters?.properties?.delta && t.parameters?.properties?.reason));
  const ctx = { chatKey: KEY, store: { recent: () => [] } };
  setRapport(KEY, LOW, 60);
  let out = null;
  try { out = await t.execute(ctx, { userId: LOW, delta: -15, reason: '自测：工具调用' }); } catch (e) { out = { content: 'ERR ' + e.message, isError: true }; }
  const text = String(out?.content ?? '');
  check('工具执行：60 → 45（delta -15）', getScore(KEY, LOW) === 45, String(getScore(KEY, LOW)) + ' · ' + text.slice(0, 80));
  const bad = await t.execute(ctx, { userId: 'abc', delta: -5 });
  check('非法 userId → 报错退出（不静默）', bad?.isError === true, String(bad?.content ?? '').slice(0, 80));
}

// ── 14. 教程段：lean 与 full 都带 ──────────────────────────────────────────
{
  const cfgNow = getConfig();
  const old = { ...(cfgNow.persona || {}) };
  cfgNow.persona = { ...old, systemPromptMode: 'lean' };
  const lean = buildSystemPrompt({ persona: cfgNow.persona, skillContext: {} });
  cfgNow.persona = { ...old, systemPromptMode: 'full' };
  const full = buildSystemPrompt({ persona: cfgNow.persona, skillContext: {} });
  cfgNow.persona = old;
  check('lean 模式含【回应参数】教程', /【回应参数：看人下菜碟】/.test(lean));
  check('full 模式含【回应参数】教程', /【回应参数：看人下菜碟】/.test(full));
  check('教程含"该降 / 不降 / 转移话题"三判据',
    /该降/.test(lean) && /不降/.test(lean) && /转移话题/.test(lean));
  check('教程点明 adjust_rapport 工具', /adjust_rapport/.test(lean));
}

// ── 15. enabled=false → 闸门关闭（可回退）──────────────────────────────────
{
  setRapportCfg({ enabled: false });
  setRapport(KEY, LOW, 0);
  sender.rapportReplyTimes.set(KEY + '::' + LOW, [Date.now()]);
  sender.setRunRapportTarget(KEY, LOW);
  const r = await trySend('闸门关闭后应当放行');
  sender.clearRunRapportTarget(KEY);
  check('enabled=false → 闸门关闭（可回退）', r.ok, r.error);
  setRapportCfg({ enabled: true });
}

// ── 16. 只管群聊：私聊不被回应参数拦（规格是「群里的群友个体」）──────────────
{
  setRapport(KEY, LOW, 0);
  setRapport('private:' + LOW, LOW, 0);
  const privKey = 'private:' + LOW;
  sender.rapportReplyTimes.set(privKey + '::' + LOW, [Date.now()]);
  sender.setRunRapportTarget(privKey, LOW);
  let ok = false;
  try { await sender.sendTextBatch(privKey, ['私聊应当放行']); ok = true; } catch (e) { ok = false; }
  sender.clearRunRapportTarget(privKey);
  check('私聊不被回应参数拦（只对群友个体）', ok);
}

// ── 17. 补丁落盘检查 ────────────────────────────────────────────────────────
{
  const marks = [
    ['rapport.js', '[qqagent-rapport-patch:module]'],
    ['config.js', '[qqagent-rapport-patch:config-rapport]'],
    ['sender.js', '[qqagent-rapport-patch:sender-import]'],
    ['sender.js', '[qqagent-rapport-patch:sender-ctor]'],
    ['sender.js', '[qqagent-rapport-patch:sender-checkrate]'],
    ['sender.js', '[qqagent-rapport-patch:sender-methods]'],
    ['sender.js', '[qqagent-rapport-patch:sender-mark]'],
    ['orchestrator.js', '[qqagent-rapport-patch:orchestrator-run-target]'],
    ['orchestrator.js', '[qqagent-rapport-patch:orchestrator-hint]'],
    ['tools.js', '[qqagent-rapport-patch:tools-register]'],
    ['prompt.js', '[qqagent-rapport-patch:prompt-fn]'],
    ['routes.js', '[qqagent-rapport-patch:routes-route]'],
    ['app.js', '[qqagent-rapport-patch:app-start]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, rel), 'utf8').includes(m));
  check('补丁标记齐全（src 十三个点位）', missing.length === 0, missing.map((x) => x.join(':')).join(', ') || '全部命中');

  const ui = fs.readFileSync(path.join(BIZ, 'ui', '05-memory-settings.js'), 'utf8');
  const uiMarks = [
    '[qqagent-rapport-patch:ui-detail-map]',
    '[qqagent-rapport-patch:ui-members-map]',
    '[qqagent-rapport-patch:ui-members-cell]'
  ].filter((m) => !ui.includes(m));
  check('补丁标记齐全（记忆页 UI 三处）', uiMarks.length === 0, uiMarks.join(', ') || '全部命中');
  // 两处渲染点没有独立标记（落在模板串里），按产物片段核验
  check('记忆页两处渲染点都在（印象卡 + 群成员表）',
    ui.includes('${rapportBadge(String(m.userId))}') && ui.includes('${rpScore}</td>'));
}

// ── 18. 客观结算（2026-10-19 · Rushiera 点名"降级应对几乎没生效"）────────────
// 为什么单测：分数由模型自己调，但实测累计 4 次调用 / 2440 次发言 —— 模型在"我想说"
// 那一刻没有反向信号，分数永远降不下去。这一段补的是宿主侧客观信号：
// 我发了话，下一批有没有人 @ / 引用 / 拍我。
{
  const { noteRapportOutbound, settleRapportWatch, clearRapportWatch } = await import(mod('rapport.js'));
  const T = '20003';
  const VIP = '569145850';
  const ctx = { selfId: '10000', selfNickname: 'R喵', botName: 'R喵' };

  // 18a 没人接 → 只采集、不降分（档位 missCap=0 封顶；2026-10-25 五档改造）
  // 根因：闲聊群里"没人 @ 我"是常态（实测群 361820329 一个周期 1557 条里 @ 我 13 条），
  // 拿它扣分等于系统性误判 —— 客观结算降级为采集面，判定与日志照跑，分数不动。
  clearRapportWatch();
  setRapport(KEY, T, 100);
  noteRapportOutbound(KEY, T, { name: '甲', sent: 1 });
  const miss = settleRapportWatch(KEY, [{ self: false, senderId: '20002', text: '在聊别的' }], ctx);
  check('18a 没人接 → 判定照跑但不降分（missCap=0）',
    miss && miss.settled === true && miss.hit === false && miss.delta === 0,
    miss ? JSON.stringify(miss) : 'null');
  check('18a 降分后分数仍 = 100', getScore(KEY, T) === 100, String(getScore(KEY, T)));

  // 18b 有人 @ 我 → 加分（先把分数压到 80，验证 +6 真生效）
  clearRapportWatch();
  setRapport(KEY, T, 80);
  noteRapportOutbound(KEY, T, { name: '甲', sent: 1 });
  const hit = settleRapportWatch(KEY, [{ self: false, senderId: '20002', text: '@R喵 在吗', atMe: true }], ctx);
  check('18b 有人 @ 我 → 加分（+6）', hit && hit.hit === true && hit.delta === 6, hit ? JSON.stringify(hit) : 'null');
  check('18b 加分后分数 = 86', getScore(KEY, T) === 86, String(getScore(KEY, T)));
  setRapport(KEY, T, 100);

  // 18c 引用我 / 拍我 也算接话
  clearRapportWatch();
  noteRapportOutbound(KEY, T, {});
  const quoted = settleRapportWatch(KEY, [{ self: false, senderId: '20002', text: '[引用 R喵：[图片]] 哈哈' }], ctx);
  check('18c 引用我 → 算接话', quoted && quoted.hit === true, JSON.stringify(quoted));
  clearRapportWatch();
  noteRapportOutbound(KEY, T, {});
  const poked = settleRapportWatch(KEY, [{ self: false, senderId: '20002', text: '[拍一拍] 甲 拍了拍 我', isPoke: true }], ctx);
  check('18c 拍我 → 算接话', poked && poked.hit === true, JSON.stringify(poked));

  // 18d 主人豁免（watch.exemptUsers）：记不进去、也不结算
  clearRapportWatch();
  const vipRec = noteRapportOutbound(KEY, VIP, { name: '莎' });
  const vipSettle = settleRapportWatch(KEY, [], ctx);
  check('18d 主人豁免（不记 pending、不结算）', vipRec === null && vipSettle === null, String(vipRec));

  // 18e 同一批只结算一次（不重复扣）
  clearRapportWatch();
  noteRapportOutbound(KEY, T, {});
  const first = settleRapportWatch(KEY, [], ctx);
  const again = settleRapportWatch(KEY, [], ctx);
  check('18e 同一批只结算一次', !!first && again === null, String(again));

  // 18f watch.enabled=false → 客观结算关（模型手调与自愈照常）
  setRapportCfg({ watch: { enabled: false } });
  clearRapportWatch();
  const offRec = noteRapportOutbound(KEY, T, {});
  const offSettle = settleRapportWatch(KEY, [], ctx);
  check('18f watch.enabled=false → 不记不结算（可回退）', offRec === null && offSettle === null);
  setRapportCfg({ watch: { enabled: true, missDelta: 12, hitDelta: 6, exemptUsers: [VIP] } });

  // 18g 客观结算降下来的分，出站闸门真的会拦（不是只写进文件）
  clearRapportWatch();
  setRapport(KEY, T, 0);
  sender.rapportReplyTimes.set(KEY + '::' + T, [Date.now()]);
  sender.setRunRapportTarget(KEY, T);
  const blocked = await trySend('客观结算降分后应当被限速');
  sender.clearRunRapportTarget(KEY);
  check('18g 客观结算降分 → 出站真的被拦', !blocked.ok, blocked.error || '（竟然放行了）');

  // 18h 补丁标记（本轮新增四点）
  const newMarks = [
    ['rapport.js', '[qqagent-rapport-patch:watch]'],
    ['config.js', '[qqagent-rapport-patch:config-watch]'],
    ['orchestrator.js', '[qqagent-rapport-patch:orchestrator-import-watch]'],
    ['orchestrator.js', '[qqagent-rapport-patch:watch-orchestrator]'],
    ['orchestrator.js', '[qqagent-rapport-patch:watch-note]']
  ];
  const missMarks = newMarks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, rel), 'utf8').includes(m));
  check('18h 客观结算补丁标记齐全（五点）', missMarks.length === 0, missMarks.map((x) => x.join(':')).join(', ') || '全部命中');
}

// 收尾：清掉自测数据目录（不留在 runtime 里）
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 占用时留着也无妨 */ }

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
