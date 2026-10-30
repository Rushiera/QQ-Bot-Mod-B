// verify-qqagent-boot.mjs — 冒烟：用当前配置起一次应用内核（无窗口）再退出
//
// 用法：node verify-qqagent-boot.mjs
// 做什么：createApp → start（内核 + HTTP，不开窗口）→ 立刻暂停编排器（不处理任何消息）
//         → 查 /api/sessions 与 /api/prompt-preview → 打印摘要 → stop
// 判据：配置能加载（前文 / 端点 / 白名单）+ 启动会话在会话列表里可见

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', '_unpack', 'data');   // D4 数据根（生产只读；冒烟只读不写）
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
process.env.QQ_AGENT_DATA_DIR = DATA;

const { createApp } = await import(pathToFileURL(path.join(BIZ, 'app.js')).href);
const core = createApp({ log: () => {} });
const port = await core.start();
core.orchestrator.setPaused(true);   // 冒烟期间不处理任何消息（不会发言）
const base = `http://127.0.0.1:${port}`;

const cfg = core.getConfig();
const sessionsRaw = await (await fetch(`${base}/api/sessions`)).json();
const sessions = Array.isArray(sessionsRaw) ? sessionsRaw : (sessionsRaw.sessions || []);
const prompt = await (await fetch(`${base}/api/prompt-preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}'
})).json();

console.log(JSON.stringify({
  ok: true,
  port,
  api: { baseUrl: cfg.api?.baseUrl, model: cfg.api?.model, hasKey: !!cfg.api?.apiKey },
  snowluma: { wsUrl: cfg.snowluma?.wsUrl, hasToken: !!cfg.snowluma?.accessToken },
  persona: { botName: cfg.persona?.botName, roleTextChars: String(cfg.persona?.roleText || '').length },
  allow: { groups: (cfg.allow?.groups || []).length, private: (cfg.allow?.private || []).length },
  contextTier: cfg.store?.contextTier,
  systemPromptChars: String(prompt.systemPrompt || '').length,
  sessions: sessions.slice(0, 5).map((s) => ({ id: s.id, chatKey: s.chatKey, status: s.status, trigger: s.trigger, tokens: s.usage?.totalTokens ?? 0 }))
}, null, 2));

await core.stop();
process.exit(0);
