// verify-qqagent-talkstyle.mjs — 「发言纪律（方案 C）」自测
//
// 用法：node verify-qqagent-talkstyle.mjs
// 判据（Rushiera 2026-10-10 拍板 · 方案 C = A + B）：
//   A 系统提示精简模式
//     1 lean 模式：组装非空，含「该说/不该说」「群聊不是客服队列」「像真人一样」「保持主体性」
//     2 lean 模式：**不含**安全规则 / 工具协议 / 表情 / 记忆等段（省字符）
//     3 lean 输出显著短于 full（≈1.2KB vs ≈4.4KB）
//     4 off 模式：返回空串
//     5 兼容：systemPromptEnabled=false 且无 mode → 按 lean 处理
//   B 动态段强化
//     6 发言热度软阈值下调：单人 5 条即触发、往返 2 轮即触发
//     7 quotaState 带 sinceLastMs：未发言 = null；发言后 ≈0
//     8 【发言配额】段含节奏句（源码落点检查）
//   9 补丁落盘：八个补丁点标记齐全（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.talkstyle-selftest）。
// LLM：不调用 —— 只覆盖提示词组装与本地统计，不产生模型请求。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.talkstyle-selftest');
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
  hardLimit: { enabled: false, windowMs: 60000, maxPerWindow: 1 }
};
cfg.persona = { ...(cfg.persona || {}), systemPromptMode: 'lean', systemPromptEnabled: undefined };
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getConfig } = await import(mod('config.js'));
const { buildSystemPrompt } = await import(mod('prompt.js'));
const { analyzeChatter, formatChatterHint } = await import(mod('chatter.js'));
const { SendQueue } = await import(mod('sender.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const setPersona = (patchObj) => { getConfig().persona = { ...(getConfig().persona || {}), ...patchObj }; };
const KEY = 'group:1097492606';

// ── A1–A3. lean 模式：含纪律段、不含其余段 ─────────────────────────────────
setPersona({ systemPromptMode: 'lean' });
const lean = buildSystemPrompt({ persona: getConfig().persona });
check('lean：组装非空', lean.length > 0, lean.length + ' 字符');
check('lean：含「该说/不该说」段', lean.includes('【该说/不该说】'));
check('lean：含「群聊不是客服队列」段', lean.includes('【群聊不是客服队列】'));
check('lean：含「像真人一样」段', lean.includes('【像真人一样】'));
check('lean：含「保持主体性」段', lean.includes('【保持主体性】'));
check('lean：不含安全规则段', !lean.includes('【安全规则'));
check('lean：不含工具协议段', !lean.includes('【工作方式'));
check('lean：不含表情包段', !lean.includes('【表情包'));

// ── A3. full 模式对照 ──────────────────────────────────────────────────────
setPersona({ systemPromptMode: 'full' });
const full = buildSystemPrompt({ persona: getConfig().persona });
check('full：含安全规则段', full.includes('【安全规则'));
check('lean 显著短于 full（< 40%）', lean.length < full.length * 0.4, lean.length + ' vs ' + full.length);
check('lean 体积在 1~3KB', lean.length > 1000 && lean.length < 3000, lean.length + ' 字符');

// ── A4. off 模式 ───────────────────────────────────────────────────────────
setPersona({ systemPromptMode: 'off' });
check('off：返回空串', buildSystemPrompt({ persona: getConfig().persona }) === '');

// ── A5. 兼容旧字段 ─────────────────────────────────────────────────────────
setPersona({ systemPromptMode: undefined, systemPromptEnabled: false });
const compat = buildSystemPrompt({ persona: getConfig().persona });
check('兼容：systemPromptEnabled=false → 按 lean 处理', compat.length > 0 && compat.includes('【该说/不该说】'), compat.length + ' 字符');

// ── B6. 发言热度软阈值 ─────────────────────────────────────────────────────
{
  const A = '10001';
  const hotMsgs = [];
  for (let i = 0; i < 5; i++) hotMsgs.push({ senderId: A, senderName: '话密的人', self: false });
  const tail = [
    { senderId: A, self: false }, { senderId: 'self', self: true },
    { senderId: A, self: false }, { senderId: 'self', self: true },
    { senderId: A, self: false }
  ];
  const store = { messagesSince: () => hotMsgs, recent: () => tail };
  const a = analyzeChatter(store, KEY);
  check('阈值下调：单人 5 条即进热度列表', a.hot.some((x) => x.id === A), JSON.stringify(a.hot));
  check('阈值下调：往返 2 轮即进对刷列表', a.loops.some((x) => x.rounds >= 2), JSON.stringify(a.loops));
  check('分级：达到软阈值 → level=soft', a.level === 'soft', a.level);
  const hint = formatChatterHint(store, KEY);
  check('热度提示渲染非空', hint.includes('【发言热度'), hint.slice(0, 60));
}

// ── B7. sinceLastMs（节奏感知）─────────────────────────────────────────────
{
  let sentCount = 0;
  const fakeOnebot = { async sendText() { sentCount += 1; return { message_id: sentCount }; } };
  const sender = new SendQueue({ onebot: fakeOnebot, store: { appendSelf() {} } });
  const s0 = sender.quotaState(KEY);
  check('未发言 → sinceLastMs = null', s0 && s0.sinceLastMs === null, JSON.stringify(s0));
  await sender.sendTextBatch(KEY, ['第一句']);
  const s1 = sender.quotaState(KEY);
  check('发言后 → sinceLastMs ≈ 0', s1 && s1.sinceLastMs !== null && s1.sinceLastMs < 5000, JSON.stringify(s1));
  sender.lastSentAt.set(KEY, Date.now() - 90000);
  const s2 = sender.quotaState(KEY);
  check('90 秒前发过 → sinceLastMs ≈ 90000', s2 && s2.sinceLastMs >= 89000, JSON.stringify(s2));
}

// ── B8. 节奏句落点 ─────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
  check('【发言配额】段含节奏句', src.includes('秒前刚说过话') && src.includes('你上次开口在'));
}

// ── 9. 补丁标记齐全 ────────────────────────────────────────────────────────
{
  const marks = [
    ['src/prompt.js', '[qqagent-talkstyle-patch:prompt-mode]'],
    ['src/prompt.js', '[qqagent-talkstyle-patch:prompt-mode-fn]'],
    ['src/prompt.js', '[qqagent-talkstyle-patch:prompt-lean]'],
    ['src/chatter.js', '[qqagent-talkstyle-patch:chatter-thresholds]'],
    ['src/sender.js', '[qqagent-talkstyle-patch:sender-ctor]'],
    ['src/sender.js', '[qqagent-talkstyle-patch:sender-lastsent]'],
    ['src/sender.js', '[qqagent-talkstyle-patch:sender-quotastate]'],
    ['src/orchestrator.js', '[qqagent-talkstyle-patch:orchestrator-quota-rhythm]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, String(rel).replace(/^src\//, '')), 'utf8').includes(m));
  check('补丁标记齐全（8/8）', missing.length === 0, missing.map((x) => x[1]).join(' '));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
