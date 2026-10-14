// probe-text-summary.mjs —— 探针：业务面端点对「纯文本摘要」请求能否产出 content
//
// 用途：方案 A（think 交 LLM 总结）的前置卡点实测。design-qqbotb-navigator.md §十四 记录
//       过该模型「对长中文纯文本只产 reasoning_content、content 恒空」——本探针复验该结论
//       在当前模型 / 当前端点下是否仍成立。
// 用法：node tools/probe-text-summary.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = path.resolve(moduleDir, '..', '_unpack', 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
const api = cfg?.api ?? {};

if (!api.baseUrl || !api.apiKey || !api.model) {
  console.log('端点未配置（baseUrl / apiKey / model 缺一）——探针退出');
  process.exit(1);
}

/** 样本：一段真实形态的猫 think（含英文推理流、多转折、中英夹杂）。 */
const sample = [
  'Ah — I see: the log is now full of NapCat log TAILER re-reading OLD napcat log content.',
  'Let me check logtail.js. If it reads the file from the beginning every tick instead of tracking an offset,',
  'every round replays the whole history — that would explain the flood.',
  '我先确认一下这是不是新问题。grep 一下 readFileSync 的用法，再看有没有 offset 记录。',
  '如果确实是从头读，那这是个 bug，得改成记录偏移量。'
].join('\n');

const question = [
  '下面是一段 AI 猫的思考过程。用两三句中文总结它现在在想什么、进展到哪、有没有卡点。',
  '只输出总结本身，不要复述原文。',
  '',
  sample
].join('\n');

const body = {
  model: api.model,
  max_tokens: Number(process.argv[2]) || 500,
  messages: [{ role: 'user', content: question }]
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60000);
try {
  const res = await fetch(`${String(api.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const msg = choice?.message ?? {};
  console.log('HTTP           =', res.status);
  console.log('model          =', data?.model);
  console.log('finish_reason  =', choice?.finish_reason);
  console.log('content        =', JSON.stringify(String(msg.content ?? '')));
  console.log('reasoning_len  =', String(msg.reasoning_content ?? '').length);
  console.log('reasoning_head =', JSON.stringify(String(msg.reasoning_content ?? '').slice(0, 200)));
} catch (error) {
  console.log('探针异常：', error?.message ?? error);
} finally {
  clearTimeout(timer);
}
