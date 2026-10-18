// verify-qqagent-readcompact.mjs — B22「已读信息分段摘要」自测（端到端）
//
// 用法：node verify-qqagent-readcompact.mjs
// 判据：design-qqbotb-session.md §九.3
//   1 超预算 → 压缩最旧前缀 → readFloorTs 推进 → 已读段字符下降
//   2 旧消息出【已读信息】、进【前情提要】；get_recent_messages 仍能翻到原文
//   3 memory_search category=history 能搜到摘要段 + 会话要点
//   4 收工轮仍按全量窗口取材，且轮转时摘要段整批归档
//   5 readMaxChars=0 时行为与今日一致（会话全量）
//   6 摘要调用失败 → 原文保留、floor 不变
//   7 补丁脚本幂等可重放
//
// 隔离：QQ_AGENT_DATA_DIR 指向 runtime/.readcompact-selftest，不碰运行实例。
// LLM：本地 mock 端点，不产生真实模型调用。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DATA = path.resolve(HERE, '..', 'runtime', '.readcompact-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(APP, 'src', rel)).href;
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import(mod('config.js'));
const { ChatStore } = await import(mod('store.js'));
const { MemoryStore } = await import(mod('memory.js'));
const { SessionRegistry } = await import(mod('sessions.js'));
const { Orchestrator } = await import(mod('orchestrator.js'));
const sessionState = await import(mod('session-state.js'));
const readlog = await import(mod('readlog.js'));
const { buildPastState, buildUserPrompt } = await import(mod('prompt.js'));
const { buildToolDefs, executeTool } = await import(mod('tools.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

// ── mock LLM 端点 ────────────────────────────────────────────────────────────
function startMockLlm() {
  return new Promise((resolve) => {
    const state = {
      mode: 'ok',
      requests: 0,
      reply: '（mock 回复）',
      summaryReply: '前情摘要：早期消息已压缩，包含测试事实。',
      summaryRequests: 0
    };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        state.requests += 1;
        state.lastBody = body;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const isSummary = !!(parsed && (parsed.messages || []).some((m) => String(m && m.content || '').includes('前情提要')));
        if (isSummary) state.summaryRequests += 1;
        if (state.mode === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock 500' } }));
          return;
        }
        if (state.mode === 'empty' && isSummary) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock-' + state.requests,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1234, completion_tokens: 0, total_tokens: 1234 }
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-' + state.requests,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: isSummary ? state.summaryReply : state.reply }, finish_reason: 'stop' }],
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
cfg.session = {
  enabled: true,
  maxContextTokens: 1000000,
  readMaxChars: 5000,
  readKeepChars: 2500,
  readCompactChunkChars: 3000,
  readDigestMaxChars: 1500
};
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

function addMessage(text, read = true) {
  const entry = store.appendIncoming(CHAT, { mid: null, ts: Date.now(), senderId: '20001', senderName: '群友甲', text });
  if (read) store.markEntryRead(CHAT, entry.id);
  return entry;
}

function seedSession() {
  const start = Date.now() - 10 * 60 * 1000;
  sessionState.setSessionState(CHAT, { startedAt: start, lastPromptTokens: 1000, rollovers: 0, readFloorTs: 0 });
  for (let i = 1; i <= 100; i++) addMessage('MSG-' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(70), true);
}

function promptOf() {
  return buildUserPrompt({
    chatKey: CHAT,
    kind: 'private',
    chatId: '10001',
    chatName: '',
    triggerEntries: [],
    stickerEntries: [],
    selfNickname: 'bot',
    contextLimit: null,
    tierInfo: { tier: 4, count: 80, reason: '测试' },
    activeTopic: null,
    memory,
    store,
    session: {},
    sessionStart: sessionState.sessionWindowStart(CHAT),
    readFloorTs: sessionState.getReadFloorTs(CHAT),
    promptAnchor: { prev: null }
  });
}

// ── 判据 1/2：压缩 → 已读段下降；旧消息出窗、摘要进【前情提要】 ─────────────
seedSession();
const beforePast = buildPastState(store, CHAT, { limit: 0, sinceTs: sessionState.sessionWindowStart(CHAT) });
const beforePrompt = promptOf();
check('1a 压缩前：详细已读 > readMaxChars', beforePast.chars > 5000, 'chars=' + beforePast.chars);
check('1b 压缩前：旧消息在【已读信息】里', beforePrompt.includes('MSG-001') && beforePrompt.includes('MSG-100'));

const compact1 = await orchestrator.compactReadWindow(CHAT, { force: true });
const afterPast = buildPastState(store, CHAT, {
  limit: 0,
  sinceTs: Math.max(sessionState.sessionWindowStart(CHAT), sessionState.getReadFloorTs(CHAT))
});
const afterPrompt = promptOf();
check('1c 压缩成功：返回 ok 且字符下降', compact1.ok === true && compact1.beforeChars > compact1.afterChars,
  JSON.stringify(compact1));
check('1d readFloorTs 已推进 + 摘要段落盘', sessionState.getReadFloorTs(CHAT) > 0 && readlog.listReadSegments(CHAT).length >= 1,
  'floor=' + sessionState.getReadFloorTs(CHAT) + ' segments=' + readlog.listReadSegments(CHAT).length);
check('1e 压缩后：详细已读 <= readKeepChars 附近', afterPast.chars <= 3000, 'chars=' + afterPast.chars);
check('2a 旧消息不再出现在【已读信息】', !afterPrompt.includes('MSG-001'), 'promptChars=' + afterPrompt.length);
check('2b 【前情提要】出现且带摘要', afterPrompt.includes('【前情提要】') && afterPrompt.includes('前情摘要'));
check('2c 最新消息仍在【已读信息】', afterPrompt.includes('MSG-100'));
check('2d 原文仍可翻：store 里 MSG-001 仍在', !!store.recent(CHAT, { limit: 500 }).find((m) => String(m.text).startsWith('MSG-001')));
check('2e 压缩后锚点已清（窗口变化后重新锚定）', orchestrator.promptAnchors.has(CHAT) === false);

// ── 判据 3：memory_search category=history ────────────────────────────────
const defs = buildToolDefs();
const toolCtx = { chatKey: CHAT, memory, store, session: {}, emit: () => {} };
const searchRes = await executeTool(defs, toolCtx, 'memory_search', { category: 'history', keyword: '前情摘要' });
let searchPayload = {};
try { searchPayload = JSON.parse(searchRes.content); } catch { searchPayload = {}; }
check('3a memory_search category=history 可搜到活跃摘要段',
  Array.isArray(searchPayload.history) && searchPayload.history.length >= 1,
  JSON.stringify(searchPayload).slice(0, 300));
check('3b 回执带 history 归档计数', !!(searchPayload.archive && typeof searchPayload.archive.history === 'number'),
  JSON.stringify(searchPayload.archive || {}));

// ── 判据 6：摘要失败 → 原文保留、floor 不变 ───────────────────────────────
for (let i = 101; i <= 160; i++) addMessage('MSG-' + String(i).padStart(3, '0') + ' ' + 'y'.repeat(70), true);
const floorBeforeFail = sessionState.getReadFloorTs(CHAT);
mock.state.mode = 'empty';
const failRes = await orchestrator.compactReadWindow(CHAT, { force: true });
mock.state.mode = 'ok';
check('6a 摘要失败：返回 ok=false 且 floor 不变',
  failRes.ok === false && sessionState.getReadFloorTs(CHAT) === floorBeforeFail,
  JSON.stringify(failRes) + ' floor=' + sessionState.getReadFloorTs(CHAT));
check('6b 摘要失败：原文仍在（MSG-101 可查到）',
  !!store.recent(CHAT, { limit: 500 }).find((m) => String(m.text).startsWith('MSG-101')));

// ── 判据 5：readMaxChars=0 关闭压缩（回到会话全量） ────────────────────────
cfg.session.readMaxChars = 0;
const disabledRes = await orchestrator.compactReadWindow(CHAT, { force: false });
const disabledPrompt = promptOf();
check('5a readMaxChars=0：compactReadWindow 直接跳过', disabledRes.ok === true && disabledRes.skipped === 'disabled',
  JSON.stringify(disabledRes));
check('5b readMaxChars=0：已读窗口回到会话全量（MSG-001 仍在提示词里）',
  disabledPrompt.includes('MSG-001'), 'promptChars=' + disabledPrompt.length);
cfg.session.readMaxChars = 5000;

// ── 判据 4：收工轮仍按全量取材，且轮转归档摘要段 ──────────────────────────
// 先把 readFloor 恢复成一个有效压缩段（上一步失败没推进，这里再压一次成功）
mock.state.summaryReply = '前情摘要：收工前测试事实。';
const compact2 = await orchestrator.compactReadWindow(CHAT, { force: true });
check('4a 收工前准备：再次压缩成功', compact2.ok === true, JSON.stringify(compact2));
const floorBeforeRollover = sessionState.getReadFloorTs(CHAT);
mock.state.reply = '本轮要点：测试收工沉淀。';
cfg.session.maxContextTokens = 100;
sessionState.recordPromptTokens(CHAT, 500);
addMessage('TRIGGER-触发收工轮', false);
await orchestrator.wake(CHAT);
const last = sessions.listSummaries(20)[0];
const lastSession = last ? sessions.get(last.id) : null;
check('4b 起了收工轮', String(lastSession && lastSession.triggerSummary || '').includes('收工轮'),
  lastSession && lastSession.triggerSummary);
check('4c 收工轮不套 readFloor：prompt 仍含最早消息（全量取材）',
  String(lastSession && lastSession.userPrompt || '').includes('MSG-001'),
  'promptChars=' + String(lastSession && lastSession.userPrompt || '').length);
check('4d 轮转后 readFloorTs 归零', sessionState.getReadFloorTs(CHAT) === 0,
  'before=' + floorBeforeRollover + ' after=' + sessionState.getReadFloorTs(CHAT));
check('4e 活跃摘要段已清空', readlog.listReadSegments(CHAT).length === 0);
const archiveDir = path.join(DATA, 'memory', 'private_10001', 'archive');
const archivedReadlog = fs.existsSync(archiveDir)
  ? fs.readdirSync(archiveDir).filter((f) => f.startsWith('readlog-') && f.endsWith('.jsonl'))
  : [];
check('4f 轮转归档了摘要段（append-only 文件）', archivedReadlog.length >= 1, archivedReadlog.join(','));
// 会话要点归档：第一次轮转时没有上一份要点，第二次轮转才会产生 session-*.jsonl
cfg.session.maxContextTokens = 100;
sessionState.recordPromptTokens(CHAT, 500);
mock.state.reply = '本轮要点：第二次收工沉淀。';
addMessage('TRIGGER-触发第二次收工轮', false);
await orchestrator.wake(CHAT);
check('4g 会话要点已归档（session-*.jsonl）',
  fs.existsSync(archiveDir) && fs.readdirSync(archiveDir).some((f) => f.startsWith('session-') && f.endsWith('.jsonl')),
  fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).join(',') : '(no archive dir)');

// ── 判据 7：补丁脚本幂等可重放 ─────────────────────────────────────────────
let patchReport = null;
try {
  const out = execFileSync(process.execPath, [path.join(HERE, 'patch-qqagent-readcompact.mjs')], { encoding: 'utf8' });
  patchReport = JSON.parse(out);
} catch (error) {
  patchReport = { ok: false, error: String(error && error.message || error) };
}
check('7a 补丁脚本可重放（幂等：本轮 0 应用 / 全跳过）',
  patchReport && patchReport.ok === true && (patchReport.applied || []).length === 0 && (patchReport.skipped || []).length >= 30,
  'applied=' + JSON.stringify(patchReport && patchReport.applied) + ' skipped=' + ((patchReport && patchReport.skipped) || []).length);
const srcText = fs.readFileSync(path.join(APP, 'src', 'orchestrator.js'), 'utf8');
check('7b 源码改动带补丁标记（可追溯 / 可重装复现）',
  srcText.includes('[qqagent-readcompact-patch:orchestrator-methods]')
  && srcText.includes('[qqagent-readcompact-patch:orchestrator-hook]'));

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('\n' + JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name),
  dataDir: DATA,
  summaryRequests: mock.state.summaryRequests,
  readlogFile: readlog.readLogFile(CHAT)
}, null, 2));

mock.close();
process.exit(failed.length === 0 ? 0 : 1);
