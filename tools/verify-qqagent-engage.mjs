// verify-qqagent-engage.mjs — 「群内自主参与」自测
//
// 用法：node verify-qqagent-engage.mjs
// 判据（Rushiera 2026-10-09 规格）：
//   1 触发权交给模型：contextTier=4 时任意群消息都进 LLM（本地门不再拦）
//   2 发言配额：滑动窗口内每群最多 N 条，超限抛错（错误回给模型）
//   3 配额关闭时不拦（enabled=false 回到旧行为）
//   4 quotaState 余量计算正确（提示词注入用）
//   5 话题词：解析 → 落盘 → 读回 → 渲染 全链通
//   6 话题词解析对异常形态健壮（解析不到返回空数组，不误伤词表）
//   7 补丁落盘：五个文件的改动标记齐全（幂等可重放）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（runtime/.engage-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：不调用 —— 本自测只覆盖本地判定 / 配额 / 话题词，不产生模型请求。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.resolve(HERE, '..', 'runtime', '.engage-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

// 自测用配置：把发送间隔压到最小（不然 5 条要等 15 秒），配额按生产值 120s/5 条。
// 硬限 / bot 指定 / 回应参数一律关掉——它们是并列的其他闸门，混在一起会把
// "配额拒绝"和"硬限拒绝"搅成同一个错误（判例：hardLimit 默认开启后本自测长期假红）。
const CFG_PATH = path.join(DATA, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
cfg.send = { ...cfg.send, minGapMs: 1, maxGapMs: 2, byLengthMs: 0, dedupeWindowMs: 0, hardSplitAt: 0 };
cfg.engage = {
  quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
  topicWords: { enabled: true },
  hardLimit: { enabled: false },
  botGuard: { enabled: false, members: [] },
  rapport: { enabled: false }
};
cfg.store = { ...cfg.store, contextTier: 4 };
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getConfig } = await import(mod('config.js'));
const { SendQueue } = await import(mod('sender.js'));
const { resolveContextTier } = await import(mod('prompt.js'));
const topicWords = await import(mod('topic-words.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

// ── 1. 触发权交给模型（4 档 = 本地门恒开）────────────────────────────────────
{
  const r = resolveContextTier({
    triggerEntries: [{ text: '这局谁背锅' }],
    selfNickname: 'R喵', botName: 'R喵', selfId: '2405997337',
    cfg: { contextTier: 4, historyCount: 80 },
    isPrivate: false
  });
  check('4 档：任意群消息都进 LLM（本地门不再拦）',
    r.shouldRespond === true && r.reason === '全部响应', r.reason);

  const r1 = resolveContextTier({
    triggerEntries: [{ text: '这局谁背锅' }],
    selfNickname: 'R喵', botName: 'R喵', selfId: '2405997337',
    cfg: { contextTier: 1, historyCount: 80 },
    isPrivate: false
  });
  check('对照：1 档仍会拦（可回退性保留）',
    r1.shouldRespond === false && r1.reason === '未触发', r1.reason);
}

// ── 2~4. 发言配额闸门 ────────────────────────────────────────────────────────
{
  let sentCount = 0;
  const fakeOnebot = {
    async sendText(kind, id, text) { sentCount += 1; return { message_id: sentCount }; }
  };
  const fakeStore = { appendSelf() {} };
  const sender = new SendQueue({ onebot: fakeOnebot, store: fakeStore });

  const key = 'group:1097492606';
  const before = sender.quotaState(key);
  check('quotaState 初始余量 = 上限',
    before && before.used === 0 && before.max === 5 && before.remaining === 5, JSON.stringify(before));

  let ok5 = 0;
  for (let i = 1; i <= 5; i++) {
    try { await sender.sendTextBatch(key, ['测试消息 ' + i]); ok5 += 1; } catch { /* 计数 */ }
  }
  check('配额内 5 条全部发出', ok5 === 5, '实际 ' + ok5 + ' 条');

  const after = sender.quotaState(key);
  check('quotaState 用满后余量 = 0',
    after && after.used === 5 && after.remaining === 0, JSON.stringify(after));

  let rejected = '';
  try { await sender.sendTextBatch(key, ['第六条']); } catch (e) { rejected = String(e?.message ?? e); }
  check('第 6 条被拒（错误回给模型）', /发言配额已满/.test(rejected), rejected);
  check('被拒的消息没有真的发出去', sentCount === 5, '实际发出 ' + sentCount + ' 条');

  // 关闭配额 → 回到旧行为
  const cfgLive = getConfig();
  cfgLive.engage = { ...(cfgLive.engage || {}), quota: { enabled: false } };
  let okAfterOff = 0;
  try { await sender.sendTextBatch(key, ['关配额后第 6 条']); okAfterOff = 1; } catch { /* 计数 */ }
  check('配额关闭时不拦（可回退）', okAfterOff === 1, '发出 ' + okAfterOff + ' 条');
  cfgLive.engage = { ...(cfgLive.engage || {}), quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 } };
}

// ── 5~6. 话题词全链 ──────────────────────────────────────────────────────────
{
  const key = 'group:1097492606';
  const sample = '这轮聊了不少。\n结论：明天继续。\n话题词：雷诺、合作模式、指挥官、背锅、天梯、突变因子';
  const words = topicWords.extractTopicWords(sample);
  check('话题词解析（顿号分隔）',
    words.length === 6 && words[0] === '雷诺' && words[5] === '突变因子', JSON.stringify(words));

  const words2 = topicWords.extractTopicWords('话题词：A、B, C D/E');
  check('话题词解析（逗号 / 空格 / 斜杠混用）',
    words2.length === 5 && words2.join('|') === 'A|B|C|D|E', JSON.stringify(words2));

  check('解析不到时返回空数组（不清空旧词表）',
    topicWords.extractTopicWords('这轮没什么好说的').length === 0);

  check('超过 12 个词时截断',
    topicWords.extractTopicWords('话题词：' + Array.from({ length: 20 }, (_, i) => 'w' + i).join('、')).length === 12);

  const written = topicWords.writeTopicWords(key, words, { rollovers: 3 });
  check('话题词落盘', written && written.words.length === 6, JSON.stringify(written?.words ?? null));

  const read = topicWords.readTopicWords(key);
  check('话题词读回', read && read.words.join('|') === words.join('|'), JSON.stringify(read?.words ?? null));

  const rendered = topicWords.formatTopicWordsForPrompt(key);
  check('话题词渲染进【记忆】段', /^【本群常聊的话题词】/.test(rendered) && rendered.includes('雷诺'), rendered);

  check('空词表不写盘（保留上一版）',
    topicWords.writeTopicWords(key, [], {}) === null && topicWords.readTopicWords(key).words.length === 6);
}

// ── 7. 发言热度（话密的群友 / 人机对刷）─────────────────────────────────────
{
  const chatter = await import(mod('chatter.js'));
  const fake = (messages) => ({
    messagesSince: () => messages,
    recent: (k, { limit }) => messages.slice(-limit)
  });
  const mk = (self, senderId, senderName, i) => ({
    id: 'm' + i, self, senderId, senderName, text: 't' + i, ts: Date.now() - (1000 * (60 - i))
  });

  check('无消息 → 无提示（level none）',
    chatter.formatChatterHint(fake([]), 'group:1') === '');

  const loop4 = [];
  for (let i = 0; i < 4; i++) {
    loop4.push(mk(true, '2405997337', 'R喵', i * 2));
    loop4.push(mk(false, '10001', '阿甲', i * 2 + 1));
  }
  const a4 = chatter.analyzeChatter(fake(loop4), 'group:1');
  check('检测到对刷（4 轮）', a4.loops.length === 1 && a4.loops[0].rounds === 4, JSON.stringify(a4.loops));
  check('4 轮 → soft 级（倾向不接）', a4.level === 'soft', a4.level);

  const loop6 = [];
  for (let i = 0; i < 6; i++) {
    loop6.push(mk(true, '2405997337', 'R喵', i * 2));
    loop6.push(mk(false, '10001', '阿甲', i * 2 + 1));
  }
  const a6 = chatter.analyzeChatter(fake(loop6), 'group:1');
  check('6 轮 → strong 级（本轮建议不回复）', a6.level === 'strong', a6.level);

  const hotMsgs = [];
  for (let i = 0; i < 16; i++) hotMsgs.push(mk(false, '10002', '阿乙', i));
  const ah = chatter.analyzeChatter(fake(hotMsgs), 'group:1');
  check('某人 10 分钟 16 条 → hot 命中 + strong',
    ah.hot.length === 1 && ah.hot[0].count === 16 && ah.level === 'strong', JSON.stringify(ah.hot));

  const mixed = [
    mk(true, '2405997337', 'R喵', 0),
    mk(false, '10001', '阿甲', 1),
    mk(false, '10002', '阿乙', 2),
    mk(true, '2405997337', 'R喵', 3)
  ];
  check('中间换人 → 不误判对刷',
    chatter.analyzeChatter(fake(mixed), 'group:1').loops.length === 0);

  const hint = chatter.formatChatterHint(fake(loop6), 'group:1');
  check('提示段渲染（含对刷说明）',
    hint.includes('【发言热度') && hint.includes('来回 6 轮'), hint.replace(/\n/g, ' / ').slice(0, 120));
}

// ── 8. 补丁落盘检查 ──────────────────────────────────────────────────────────
{
  // 这两处标记已被下游补丁（memory）接管改写——断言改指产物特征，不追标记文本
  // （判例：标记断言与下游补丁抢同一行 → 断言永久假红）
  const marks = [
    ['config.js', '[qqagent-engage-patch:config-engage]'],
    ['sender.js', '[qqagent-engage-patch:sender-quota]'],
    ['sender.js', '[qqagent-engage-patch:sender-quota-state]'],
    ['orchestrator.js', '[qqagent-engage-patch:orchestrator-quota-def]'],
    ['chatter.js', '[qqagent-engage-patch:chatter]'],
    ['orchestrator.js', '[qqagent-engage-patch:orchestrator-chatter-def]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, rel), 'utf8').includes(m));
  check('补丁标记齐全（6 处）', missing.length === 0, missing.map((x) => x.join(':')).join(', ') || '全部命中');
  const orch = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(BIZ, 'prompt.js'), 'utf8');
  check('话题词落进群记（产物特征：setGroupTopics）', orch.includes('setGroupTopics(chatKey, topicWords)'));
  check('【记忆】段接入群记（产物特征：formatGroupForPrompt）', prompt.includes('formatGroupForPrompt(ctx.chatKey)'));
  check('话题词模块已落盘（R3-5 起为转发壳）', fs.readFileSync(path.join(BIZ, 'topic-words.js'), 'utf8')
    .includes('from \'./group-memory.js\''));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
