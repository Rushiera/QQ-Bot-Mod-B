// verify-qqagent-memory.mjs — 「记忆分类（群记）」自测（端到端）
//
// 用法：node verify-qqagent-memory.mjs
// 判据：design-qqbotb-memory.md §四 六条
//   1 模型可写群记 → 落 _group.json，下轮【记忆】段【本群】出现该条
//   2 收工轮产出的要点与话题进入对应轴（session / topic）
//   3 群友印象只出现在【对群友的印象】，群级事实不再塞进人档
//   4 两个群的记忆互不可见（同一 QQ 号在两群各自成档）
//   5 记忆页可看 / 可编辑群记，改动经 API 落盘（API 层由 routes 承载，本自测验读写层）
//   6 改动由 tools/patch-qqagent-memory.mjs 落盘（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.memory-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：本地 mock 端点，不产生任何真实模型调用。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.memory-selftest');
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
const groupMemory = await import(mod('group-memory.js'));
const { buildToolDefs, executeTool } = await import(mod('tools.js'));
const sessionState = await import(mod('session-state.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

// ── mock LLM 端点 ────────────────────────────────────────────────────────────
function startMockLlm() {
  return new Promise((resolve) => {
    const state = { requests: 0, reply: '（mock 回复）', replyFn: null, lastUser: '', users: [] };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        state.requests += 1;
        try { state.lastUser = JSON.stringify(JSON.parse(body).messages || []); } catch { state.lastUser = ''; }
        state.users.push(state.lastUser);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-' + state.requests,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: (typeof state.replyFn === 'function' ? state.replyFn(state.lastUser) : state.reply) }, finish_reason: 'stop' }],
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
const CHAT = 'group:1097492606';
const CHAT2 = 'group:689942975';
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

// ── 判据 1 / 4：群记读写层（含群隔离）──────────────────────────────────────
const e1 = groupMemory.appendGroupEntry(CHAT, 'lore', '端盆/白饭/记账/利息是本群招牌梗');
const e2 = groupMemory.appendGroupEntry(CHAT, 'rule', 'bot 之间互刷受限：指定群友 240s 内最多 1 条');
check('1a 群记可写（_group.json 落盘）',
  !!e1 && !!e2 && fs.existsSync(groupMemory.groupMemoryFile(CHAT)),
  groupMemory.groupMemoryFile(CHAT));
check('1b 落盘内容可读回（2 条）',
  groupMemory.listGroupEntries(CHAT).length === 2,
  JSON.stringify(groupMemory.listGroupEntries(CHAT).map((x) => x.kind)));
check('1c 同 kind 同内容不重复写',
  groupMemory.appendGroupEntry(CHAT, 'lore', '端盆/白饭/记账/利息是本群招牌梗')?.id === e1.id
  && groupMemory.listGroupEntries(CHAT).length === 2);
check('1d 非法 kind 拒绝写入',
  groupMemory.appendGroupEntry(CHAT, 'bogus', 'x') === null);

groupMemory.appendGroupEntry(CHAT, 'relation', '小肥鱼inv 是群里的另一只 bot');
groupMemory.appendGroupEntry(CHAT, 'project', 'SC2 突变表（灰机 wiki 合作任务页）');
groupMemory.setGroupTopics(CHAT, ['突变表', '灰机wiki', 'Cloudflare']);
const fmt1 = groupMemory.formatGroupForPrompt(CHAT);
check('1e 渲染含【本群】+【本群在聊】+ 分类前缀',
  fmt1.includes('【本群】') && fmt1.includes('【本群在聊】') && fmt1.includes('群规：') && fmt1.includes('梗：'),
  fmt1.split('\n').length + ' 行');
check('1f 话题词落为 topic 条目',
  groupMemory.listGroupEntries(CHAT).filter((x) => x.kind === 'topic').length === 3);

// 判据 4：群与群不串味
groupMemory.appendGroupEntry(CHAT2, 'lore', '另一个群的专属梗');
const fmt2 = groupMemory.formatGroupForPrompt(CHAT2);
check('4a 两个群的群记互不可见',
  !fmt1.includes('另一个群的专属梗') && !fmt2.includes('端盆'),
  'chat2 条目数=' + groupMemory.listGroupEntries(CHAT2).length);
check('4b 同一 QQ 号在两群各自成档',
  (() => {
    memory.replaceMember(CHAT, '20001', '群友甲', ['A 群印象']);
    memory.replaceMember(CHAT2, '20001', '群友甲', ['B 群印象']);
    const a = memory.members(CHAT)[0]?.impressions?.[0]?.content;
    const b = memory.members(CHAT2)[0]?.impressions?.[0]?.content;
    return a === 'A 群印象' && b === 'B 群印象';
  })());

check('1g topic 超限转归档（不丢弃）',
  (() => {
    // 记忆不节流（2026-10-16）：现行池话题上限 24，超出的**转归档**而非丢弃
    // [qqagent-memory-patch:no-throttle-1g]
    groupMemory.setGroupTopics(CHAT, Array.from({ length: 30 }, (_, i) => '词' + i));
    const n = groupMemory.listGroupEntries(CHAT).filter((x) => x.kind === 'topic').length;
    const arch = groupMemory.listArchivedGroupEntries(CHAT, { keyword: '词', limit: 100 })
      .filter((x) => x.kind === 'topic').length;
    groupMemory.setGroupTopics(CHAT, ['突变表', '灰机wiki', 'Cloudflare']);
    return n === 24 && arch >= 6;
  })());

check('1h 按 id 删条目',
  groupMemory.removeGroupEntry(CHAT, { id: e2.id }) === 1
  && groupMemory.listGroupEntries(CHAT).length === 6,
  '剩余=' + groupMemory.listGroupEntries(CHAT).length);

// ── 判据 3：工具面（群记 / 人档分流）──────────────────────────────────────
const defs = buildToolDefs();
const toolCtx = { chatKey: CHAT, memory, session: { feedbacks: [] }, emit: () => {} };
const r1 = await executeTool(defs, toolCtx, 'memory_append', JSON.stringify({ category: 'group', kind: 'project', content: 'SC2 突变表扒取中' }));
check('3a memory_append(category=group) 落群记',
  !r1.isError && /"category":\s*"group"/.test(String(r1.content)) && groupMemory.listGroupEntries(CHAT).some((x) => x.content === 'SC2 突变表扒取中'),
  String(r1.content).slice(0, 80));
const r2 = await executeTool(defs, toolCtx, 'memory_append', JSON.stringify({ category: 'group', kind: 'nope', content: 'x' }));
check('3b 群记 kind 非法 → 工具报错（不静默）',
  !!r2.isError, String(r2.content).slice(0, 60));
const r3 = await executeTool(defs, toolCtx, 'memory_append', JSON.stringify({ category: 'member', userId: '20002', target: '群友乙', content: '说话短、直给判断' }));
check('3c memory_append(category=member) 仍走人档',
  !r3.isError && memory.members(CHAT).some((m) => String(m.userId) === '20002'),
  String(r3.content).slice(0, 80));
const r4 = await executeTool(defs, toolCtx, 'memory_query', JSON.stringify({ category: 'group' }));
check('3d memory_query(category=group) 返回群记',
  !r4.isError && String(r4.content).includes('SC2 突变表扒取中'), String(r4.content).slice(0, 60));
const r5 = await executeTool(defs, toolCtx, 'memory_remove', JSON.stringify({ category: 'group', content: 'SC2 突变表扒取中' }));
check('3e memory_remove(category=group) 按内容删',
  !r5.isError && /"removed":\s*1/.test(String(r5.content)), String(r5.content).slice(0, 60));
check('3f 群级事实不落人档（人档只剩真人的印象）',
  memory.members(CHAT).every((m) => m.impressions.every((e) => !/群规|互刷|壳|前文/.test(e.content))),
  memory.members(CHAT).map((m) => m.userId + ':' + m.impressions.length).join(' '));

// ── 判据 1 / 2：提示词端到端（【记忆】段接入群记）──────────────────────────
mock.state.reply = '（mock：看了一眼，没接话）';
addMessage('TRIGGER-进来看一眼', false);
await orchestrator.wake(CHAT);
const s1 = lastSession();
const prompt1 = String(s1?.userPrompt || '');
check('1i 【记忆】段出现【本群】（群记进提示词）', prompt1.includes('【本群】'), 'promptChars=' + prompt1.length);
check('1j 【记忆】段出现【本群在聊】', prompt1.includes('【本群在聊】'));
check('2a 话题词块已退役（不再出现【本群常聊的话题词】）',
  !prompt1.includes('【本群常聊的话题词】'));
check('2b 群友印象段仍在（人轴不受影响）', prompt1.includes('【对群友的印象】'));

// ── 判据 2：收工轮 → 要点进 session 轴 + 话题进 topic 轴 ───────────────────
cfg.session.maxContextTokens = 100;
sessionState.recordPromptTokens(CHAT, 500);
mock.state.reply = '要点：本轮聊了突变任务与 wiki 抓取。\n话题词：恐惧神庙、往日神庙';
addMessage('TRIGGER-触发收工轮', false);
await orchestrator.wake(CHAT);
const s2 = lastSession();
const summary2 = sessionState.readSessionSummary(CHAT);
const topics2 = groupMemory.listGroupEntries(CHAT).filter((x) => x.kind === 'topic').map((x) => x.content);
check('2c 起了收工轮', String(s2?.triggerSummary || '').includes('收工轮'), 'triggerSummary=' + s2?.triggerSummary);
check('2d 会话要点落 session 轴（_session.json）',
  !!summary2 && summary2.summary.includes('突变任务'), summary2 ? summary2.summary.slice(0, 40) : '');
check('2e 收工轮话题进 topic 轴（替换上一版）',
  topics2.length === 2 && topics2.includes('恐惧神庙') && !topics2.includes('突变表'),
  JSON.stringify(topics2));
check('2f 收工轮不动 lore / rule（只换 topic）',
  groupMemory.listGroupEntries(CHAT).some((x) => x.kind === 'lore'));

// ── 判据 1 / 3：群记整理只在 收工轮 + 手动按钮 两个点跑（2026-10-11 修订）──────
// 规格：Rushiera 2026-10-11——「不要按时间冷却整理群记，还是走 300k 收工轮」。
cfg.session.maxContextTokens = 1000000;
mock.state.reply = JSON.stringify({
  entries: [{ kind: 'lore', content: '手动重整写入的梗' }]
});
const gBefore = groupMemory.listGroupEntries(CHAT).map((x) => x.kind + ':' + x.content);
const consAuto = await orchestrator.consolidateMemoryForChat(CHAT, {});
const gAfterAuto = groupMemory.listGroupEntries(CHAT).map((x) => x.kind + ':' + x.content);
check('1k 后台自动整理不碰群记（群记整理已移出自动整理轮）',
  !consAuto?.groupNote && gAfterAuto.join('|') === gBefore.join('|'),
  'groupNote=' + JSON.stringify(consAuto?.groupNote || ''));
const consManual = await orchestrator.consolidateMemoryForChat(CHAT, { force: true });
check('1n 手动「整理本群记忆」仍可重整群记（force）',
  !!consManual?.groupNote
  && groupMemory.listGroupEntries(CHAT).some((x) => x.content === '手动重整写入的梗'),
  String(consManual?.groupNote || ''));

// ── 判据 7：记忆不节流（写入放开 + 归档 + 索引 + 检索）─────────────────────
// 规格（Rushiera 2026-10-16）：「记忆不需要节流，写的多不是坏事，但要能归档能索引」。
const NO_THROTTLE_CHAT = 'group:361820329';
const nBefore = groupMemory.listGroupEntries(NO_THROTTLE_CHAT).length;
for (let i = 0; i < 260; i++) {
  groupMemory.appendGroupEntry(NO_THROTTLE_CHAT, 'lore', '压测梗 ' + i);
}
const nAfter = groupMemory.listGroupEntries(NO_THROTTLE_CHAT).length;
const nArch = groupMemory.groupArchiveStats(NO_THROTTLE_CHAT).count;
check('7a 写入超软上限 → 转归档而非淘汰（信息不丢）',
  nAfter === 200 && nArch >= 60 && nBefore + 260 === nAfter + nArch,
  '现行=' + nAfter + ' 归档=' + nArch);

const idxFile = path.join(DATA, 'memory', 'group_361820329', '_index.json');
let idx = null;
try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { idx = null; }
check('7b 索引落盘（_index.json：现行池 + 归档计数 + 分类明细）',
  !!idx && idx.group?.total === nAfter && idx.archive?.count === nArch && idx.group?.byKind?.lore >= 1,
  idx ? JSON.stringify({ total: idx.group.total, archive: idx.archive.count }) : '缺失');

const archHit = groupMemory.listArchivedGroupEntries(NO_THROTTLE_CHAT, { keyword: '压测梗 3', limit: 50 });
check('7c 归档可检索（按关键词）', archHit.length > 0, '命中=' + archHit.length);

const rSearch = await executeTool(buildToolDefs(), { chatKey: NO_THROTTLE_CHAT, memory, session: { feedbacks: [] }, emit: () => {} },
  'memory_search', JSON.stringify({ keyword: '压测梗 25', limit: 5 }));
check('7d 工具面 memory_search 跨现行 + 归档检索',
  !rSearch.isError && /groupArchived/.test(String(rSearch.content)),
  String(rSearch.content).slice(0, 90).replace(/\n/g, ' '));

const fmtTrunc = groupMemory.formatGroupForPrompt(NO_THROTTLE_CHAT);
check('7e 注入有预算且明示「已归档」指针',
  fmtTrunc.includes('未展开') && fmtTrunc.includes('已归档'),
  fmtTrunc.split('\n').slice(-1)[0]);

const leanPrompt = (() => {
  // 系统提示 lean 模式必须带上记忆引导（原漏在 lean 之外，模型看不到记忆工具）
  const src = fs.readFileSync(path.join(BIZ, 'prompt.js'), 'utf8');
  return src.includes('[qqagent-memory-patch:no-throttle-lean-memory]');
})();
check('7f lean 模式带记忆引导（不再只有 full 模式有）', leanPrompt);

// 人档：整理时被改掉的旧条目留底进归档
memory.replaceMember(CHAT, '20005', '群友乙', ['旧印象 A', '旧印象 B']);
memory.replaceConsolidated(CHAT, { memberImpression: [{ userId: '20005', target: '群友乙', content: '新印象 A' }] });
const mArch = memory.memberArchiveStats(CHAT);
const mHit = memory.searchMemberArchive(CHAT, { keyword: '旧印象', limit: 10 });
check('7g 人档整理改掉的旧条目留底归档（可检索）',
  mArch.count >= 2 && mHit.length >= 2,
  '归档=' + mArch.count + ' 命中=' + mHit.length);

// ── 判据 1 / 2：收工轮 = 群记重整的唯一触发点 ────────────────────────────────
cfg.session.maxContextTokens = 100;
sessionState.recordPromptTokens(CHAT, 500);
mock.state.replyFn = (userPrompt) => {
  // 群记重整请求（提示词里带「现有群记」）→ 回结构化条目；收工轮本体 → 回要点 + 话题词
  if (String(userPrompt).includes('现有群记')) {
    return JSON.stringify({
      entries: [
        { kind: 'lore', content: '端盆 / 白饭 / 记账 / 利息是本群招牌梗' },
        { kind: 'rule', content: 'bot 之间互刷受限：对指定群友 240 秒内最多 1 条' },
        { kind: 'topic', content: '灰机 wiki 被 Cloudflare 人机验证挡着' }
      ]
    });
  }
  return '要点：本轮聊了突变任务与 wiki 抓取。\n话题词：恐惧神庙、往日神庙';
};
const usersBefore = mock.state.users.length;
addMessage('TRIGGER-触发收工轮（群记重整）', false);
await orchestrator.wake(CHAT);
const afterRoll = groupMemory.listGroupEntries(CHAT);
check('1l 收工轮重整群记（整体替换为整理结果）',
  afterRoll.filter((x) => x.kind !== 'topic').length === 2
  && afterRoll.some((x) => x.kind === 'lore' && x.content.includes('端盆')),
  JSON.stringify(afterRoll.map((x) => x.kind)));
check('1m 重整结果渲染进【本群】（含 rule + lore）',
  groupMemory.formatGroupForPrompt(CHAT).includes('240 秒'), '');
check('3g 收工轮把「现有群记」喂给了模型（提示词含旧条目）',
  mock.state.users.slice(usersBefore).some((u) => u.includes('现有群记')),
  '本轮请求数=' + (mock.state.users.length - usersBefore));

// ── 判据 6：补丁脚本幂等可重放 + 标记可追溯 ────────────────────────────────
let patchOut = '';
try {
  patchOut = execFileSync(process.execPath, [path.join(HERE, 'patch-qqagent-memory.mjs')], { encoding: 'utf8' });
} catch (error) {
  patchOut = 'ERR ' + String(error?.message ?? error);
}
check('6a 补丁脚本可重放（幂等：applied 0 / 全部跳过）',
  // 幂等判据只看「本轮没有新落盘」——跳过条数随补丁点增长，不能写死。
  // [qqagent-memory-patch:no-throttle-6a]
  patchOut.includes('applied 0') && /skipped \d+/.test(patchOut),
  patchOut.split('\n')[0]);
const orchText = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
const promptText = fs.readFileSync(path.join(BIZ, 'prompt.js'), 'utf8');
const toolsText = fs.readFileSync(path.join(BIZ, 'tools.js'), 'utf8');
const routesText = fs.readFileSync(path.join(BIZ, 'routes.js'), 'utf8');
check('6b 源码改动带补丁标记（可追溯 / 重装可复现）',
  orchText.includes('[qqagent-memory-patch:orchestrator-group-consolidate]')
  && promptText.includes('[qqagent-memory-patch:prompt-group]')
  && toolsText.includes('[qqagent-memory-patch:tools-append-group]')
  && routesText.includes('[qqagent-memory-patch:routes-group]'));
check('6c prompt.js 不再引用话题词模块（_topics.json 退役）',
  !promptText.includes("from './topic-words.js'"));
check('6d routes 暴露群记 API（POST / PUT / DELETE）',
  routesText.includes('memory-files\\/(group|private)_(\\d+)\\/group$')
  && routesText.includes('\\/group\\/([\\w-]+)$'));

// ── 判据 8：沉淀拍（冷群兜底）+ 参数面 ────────────────────────────────────
const orchSrc = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
check('8a 沉淀拍判据在位（#sedimentDue + 到点走整理轮）',
  orchSrc.includes('[qqagent-memory-patch:no-throttle-sediment-method]')
  && orchSrc.includes('[qqagent-memory-patch:no-throttle-sediment-tick]')
  && orchSrc.includes('sedimentOnly'),
  '三处标记');
check('8b 沉淀间隔有默认值（memory.sedimentIntervalMs = 12h，0=关）',
  Number(DEFAULT_CONFIG.memory?.sedimentIntervalMs) === 43200000,
  DEFAULT_CONFIG.memory?.sedimentIntervalMs);
check('8c 记忆不节流默认值（条数放开 / 冷却 3h / 发现放宽）',
  Number(DEFAULT_CONFIG.memory?.maxImpressionsPerMember) === 40
  && Number(DEFAULT_CONFIG.memory?.maxGroupEntries) === 60
  && Number(DEFAULT_CONFIG.memory?.consolidateMinIntervalMs) === 10800000
  && Number(DEFAULT_CONFIG.memory?.discoverMinMessages) === 3
  && Number(DEFAULT_CONFIG.memory?.discoverMaxMembers) === 10,
  JSON.stringify(DEFAULT_CONFIG.memory));

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('\n' + JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name),
  dataDir: DATA,
  groupFile: groupMemory.groupMemoryFile(CHAT)
}, null, 2));

mock.close();
process.exit(failed.length === 0 ? 0 : 1);
