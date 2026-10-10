// open-startup-session.mjs — 「启动软件 = 打开新会话」
//
// 用法：node open-startup-session.mjs   （由 启动QQAgent.bat 在拉起应用前调用）
// 做什么：用应用自己的 SessionRegistry 落一条「启动会话」记录（systemPrompt = 当前前文），
//         写进 data/sessions/ + 刷新索引缓存 → 应用启动后「会话」页第一条就是它
// 边界：只新增一条会话记录，不动配置

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\data';
const APP_SRC = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\resources\\app\\src';
process.env.QQ_AGENT_DATA_DIR = DATA;   // 必须在 import 应用模块之前设好

const { SessionRegistry } = await import(pathToFileURL(path.join(APP_SRC, 'sessions.js')).href);

const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
const roleText = String(cfg.persona?.roleText ?? '');

const reg = new SessionRegistry(0);
const s = reg.create({
  chatKey: 'local:启动',
  trigger: [],
  triggerSummary: '启动软件——打开新会话',
  status: 'done'
});
s.endedAt = Date.now();
s.systemPrompt = `【前文（启动时载入 · ${roleText.length} 字符）】\n\n${roleText}`;
s.userPrompt = '（软件启动——本次为新会话；群消息经 OneBot 进入，按 1 档「仅艾特」触发处理）';
s.promptChars = s.systemPrompt.length + s.userPrompt.length;
s.model = String(cfg.api?.model ?? '');
s.finishReason = 'startup';
reg.update(s.id);
reg.flushIndexCache();

console.log(JSON.stringify({
  ok: true,
  id: s.id,
  chatKey: s.chatKey,
  file: path.join(DATA, 'sessions', `${s.id}.json`),
  roleTextChars: roleText.length,
  promptChars: s.promptChars,
  model: s.model
}, null, 2));
