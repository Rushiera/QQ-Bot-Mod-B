// verify-qqagent-session.mjs — 「会话生命周期 + 记忆面」自测（端到端）
//
// 用法：node verify-qqagent-session.mjs
// 判据：design-qqbotb-session.md §四 五条
//   1 会话内消息全量进上下文（不再只 80 条）—— 运行详情 userPrompt 覆盖本轮会话全部消息
//   2 估算过阈值 → 自动收工轮 → 无对外发言 → 存档归档 + 清零 → 下一条起为新会话
//   3 收工轮产出的要点出现在下轮提示词的【记忆】段
//   4 429 连续限流下不判失败：退避轮询续跑（不落 error）
//   5 改动由 tools/patch-qqagent-session.mjs 落盘（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.session-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：本地 mock 端点（可切 429），不产生任何真实模型调用。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.session-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import(mod('config.js'));
const { ChatStore } = await import(mod('store.js'));
const { MemoryStore } = await import(mod('memory.js'));
const { SessionRegistry } = await import(mod('sessions.js'));
const { Orchestrator } = await import(mod('orchestrator.js'));
const sessionState = await import(mod('session-state.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

// ── mock LLM 端点 ────────────────────────────────────────────────────────────
function startMockLlm() {
  return new Promise((resolve) => {
    const state = { mode: 'ok', requests: 0, reply: '（mock 回复）' };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        state.requests += 1;
        state.lastBody = body;
        if (state.mode === 'rate-limit') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'HTTP 429 rate limit exceeded (429)', type: 'rate_limit_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-' + state.requests,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: state.reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1234, completion_tokens: 12, total_tokens: 1246 }
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ state, url: 'http://127.0.0.1:' + port + '/v1', close: () => server.close() });
    });
  });
}

const mock = await startMockLlm();

// ── 运行配置（内存态，不落盘）──────────────────────────────────────────────
const cfg = deepMerge(DEFAULT_CONFIG, fs.existsSync(path.join(DATA, 'config.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'))
  : {});
cfg.api = { ...cfg.api, baseUrl: mock.url, apiKey: 'test-key', model: 'mock-model', fallbackModels: [] };
cfg.session = { enabled: true, maxContextTokens: 1000000 };
cfg.memory = { ...cfg.memory, consolidateEnabled: false };
cfg.store = { ...cfg.store, historyCount: 80, contextTier: 4, randomPercent: 0 };
cfg.allow = { groups: [], private: [] };
setRuntimeConfig(cfg);

// ── 组件（手工组装：不连真实 NapCat，不起 HTTP，不碰运行实例）─────────────
const CHAT = 'private:10001';
const store = new ChatStore(0);
const memory = new MemoryStore();
const sessions = new SessionRegistry(0);
const onebot = {
  selfId: '99999',
  selfNickname: '',
  call: async () => ({}),
  getGroupInfo: async () => null,
  sendGroupMsg: async () => ({}),
  sendPrivateMsg: async () => ({})
};
const orchestrator = new Orchestrator({
  store, memory, sessions, onebot,
  stickers: { sync: async () => ({ entries: [] }) },
  sender: { send: async () => ({}), enqueue: async () => ({}) },
  emit: () => {}
});

function addMessage(text, read = false) {
  const entry = store.appendIncoming(CHAT, { mid: null, ts: Date.now(), senderId: '20001', senderName: '群友甲', text });
  if (read) store.markEntryRead(CHAT, entry.id);
  return entry;
}

function lastSession() {
  const list = sessions.listSummaries(20);
  return list.length ? sessions.get(list[0].id) : null;
}

// ── 判据 1：会话全量进上下文 ────────────────────────────────────────────────
for (let i = 1; i <= 120; i++) addMessage('MSG-' + String(i).padStart(3, '0'), true);
addMessage('TRIGGER-现在叫我', false);
await orchestrator.wake(CHAT);
const s1 = lastSession();
const prompt1 = String(s1?.userPrompt || '');
check('1a 全量：userPrompt 覆盖会话最早消息（MSG-001，老逻辑 80 条窗口会截掉）',
  prompt1.includes('MSG-001') && prompt1.includes('MSG-120'), 'promptChars=' + prompt1.length);
check('1b 全量：contextMode=session 且 contextLimit=实际条数',
  s1?.contextMode === 'session' && Number(s1?.contextLimit) > 80, 'contextLimit=' + s1?.contextLimit);
check('1c 未截尾：已读条数 = 120（> historyCount 80）',
  (s1?.pastStateCount || 0) >= 120, 'pastStateCount=' + s1?.pastStateCount);

// ── 判据 2：过阈值 → 收工轮 → 无发言 → 归档清零 → 新会话 ──────────────────
cfg.session.maxContextTokens = 100;                 // 把阈值压到极小，触发轮转
sessionState.recordPromptTokens(CHAT, 500);         // 模拟"上一轮真实 promptTokens"
mock.state.reply = '要点：本轮聊了测试话题；结论：判据 2 通过；待续：无。';
addMessage('TRIGGER-触发收工轮', false);
const stateBefore = sessionState.getSessionState(CHAT);
await orchestrator.wake(CHAT);
const s2 = lastSession();
const stateAfter = sessionState.getSessionState(CHAT);
const archiveDir = path.join(DATA, 'messages', 'archive');
const archivedFiles = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
check('2a 起了收工轮（会话页可见的边界条目）',
  String(s2?.triggerSummary || '').includes('收工轮'), 'triggerSummary=' + s2?.triggerSummary);
check('2b 收工轮无对外发言（sent 为空）',
  Array.isArray(s2?.sent) && s2.sent.length === 0, 'sent=' + (s2?.sent || []).length);
check('2c 存档已归档（archive 落文件）',
  archivedFiles.length >= 1, archivedFiles.join(','));
check('2d 当前存档清零（下一条起为新会话）',
  store.getChatMeta(CHAT).total === 0, 'total=' + store.getChatMeta(CHAT).total);
check('2e 会话状态重置（rollovers+1 · 估算基线清零）',
  stateAfter.rollovers === stateBefore.rollovers + 1 && stateAfter.lastPromptTokens === 0 && stateAfter.startedAt >= stateBefore.startedAt,
  JSON.stringify(stateAfter));

// ── 判据 3：收工要点进下一轮【记忆】段 ─────────────────────────────────────
cfg.session.maxContextTokens = 1000000;
addMessage('TRIGGER-新会话第一条', false);
await orchestrator.wake(CHAT);
const s3 = lastSession();
const prompt3 = String(s3?.userPrompt || '');
check('3a 下轮提示词含【记忆】段', prompt3.includes('【记忆】'));
check('3b 【记忆】段携带收工轮要点', prompt3.includes('本轮聊了测试话题'), '含要点=' + prompt3.includes('本轮聊了测试话题'));
check('3c 会话级摘要文件已落盘', !!sessionState.readSessionSummary(CHAT), sessionState.sessionSummaryFile(CHAT));

// ── 判据 4：429 长时限流不判失败 ────────────────────────────────────────────
mock.state.mode = 'rate-limit';
addMessage('TRIGGER-限流测试', false);
const started4 = Date.now();
await orchestrator.wake(CHAT);
const s4 = lastSession();
check('4a 限流后会话未落 error（不判失败）',
  s4?.status !== 'error' && !s4?.error, 'status=' + s4?.status + ' error=' + (s4?.error || ''));
check('4b 触发批已恢复为未读（等待续跑）',
  store.unreadCount(CHAT) > 0, 'unread=' + store.unreadCount(CHAT));
check('4c 已排定下一次轮询（退避重试在手）',
  orchestrator.wakeTimers.size > 0, 'wakeTimers=' + orchestrator.wakeTimers.size + ' 用时 ' + (Date.now() - started4) + 'ms');
check('4d mock 端点确实回了 429（走了限流路径）',
  mock.state.requests >= 1, 'requests=' + mock.state.requests);
mock.state.mode = 'ok';

// 4e/4f/4g：退避封顶 180s + 不设次数上限（Rushiera 2026-10-09 定）
check('4e 退避 60s → 120s → 180s 封顶（第 1/2/3 次）',
  sessionState.rateLimitRetryDelayMs(1) === 60000
  && sessionState.rateLimitRetryDelayMs(2) === 120000
  && sessionState.rateLimitRetryDelayMs(3) === 180000,
  [1, 2, 3].map((n) => sessionState.rateLimitRetryDelayMs(n)).join('/'));
check('4f 不设次数上限：第 50 次仍返回 180s（继续轮询，不判失败）',
  sessionState.rateLimitRetryDelayMs(50) === 180000, 'n=50 -> ' + sessionState.rateLimitRetryDelayMs(50));
check('4g 源码已无轮询次数上限常量',
  !fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8').includes('MAX_RATE_LIMIT_RETRIES'));

// ── 判据 5：补丁脚本幂等可重放 ─────────────────────────────────────────────
// R2-L2 给 20 个补丁加了退役守卫：默认输出 `RETIRED: 已被 R2 吸收…`（非 JSON，parse 会抛）。
// 故保留原始 stdout，退役与 JSON 两条路各自成判据（R3-L6 判据升级）。
let patchOut = '';
let patchReport = null;
try {
  patchOut = execFileSync(process.execPath, [path.join(HERE, 'patch-qqagent-session.mjs')], { encoding: 'utf8' });
  patchReport = JSON.parse(patchOut);
} catch (error) {
  if (!patchOut) patchOut = 'ERR ' + String(error?.message ?? error);
}
const sessionRetired = patchOut.startsWith('RETIRED');
check('5a 补丁脚本可重放（幂等：本轮 0 应用 / 全跳过）',
  sessionRetired
  || (patchReport?.ok === true && (patchReport.applied || []).length === 0 && (patchReport.skipped || []).length >= 20),
  sessionRetired
    ? 'RETIRED（R2 已吸收，打补丁动作转验终态文件）'
    : 'applied=' + JSON.stringify(patchReport?.applied) + ' skipped=' + (patchReport?.skipped || []).length);
const srcText = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
check('5b 源码改动确实带补丁标记（可追溯 / 可重装复现）',
  srcText.includes('[qqagent-session-patch:orchestrator-rollover]') && srcText.includes('[qqagent-session-patch:orchestrator-429]'));

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('\n' + JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name),
  dataDir: DATA,
  sessionStateFile: sessionState.SESSION_STATE_FILE,
  archiveFiles: archivedFiles.length
}, null, 2));

mock.close();
process.exit(failed.length === 0 ? 0 : 1);
