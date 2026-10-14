// probe-text-summary.mjs —— 探针：think 摘要链路的模型档位与真实封装实测
//
// 用途：方案 A（think 交 LLM 总结）的前置卡点实测与回归。design-qqbotb-navigator.md §十四
//       记录过「主模型对长中文纯文本只产 reasoning_content、content 恒空」——本探针复验
//       该结论，并对比快档模型；`--via=shot` 走 `shot.summarize` 真实封装（消费点实锤）。
// 用法：
//   node tools/probe-text-summary.mjs                                  # raw · 默认模型 · 500 token
//   node tools/probe-text-summary.mjs --model=deepseek-v4.1-flash --max-tokens=400
//   node tools/probe-text-summary.mjs --via=shot                       # 走 shot.summarize

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShotService } from '../app/src/navigator/shot.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = path.resolve(moduleDir, '..', '_unpack', 'data', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
const api = cfg?.api ?? {};

if (!api.baseUrl || !api.apiKey || !api.model) {
  console.log('端点未配置（baseUrl / apiKey / model 缺一）——探针退出');
  process.exit(1);
}

/** 命令行参数（`--key=value`）。 */
const args = {};
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)=?(.*)$/.exec(raw);
  if (m) args[m[1]] = m[2];
}
const model = String(args.model ?? '').trim() || api.model;
const maxTokens = Number(args['max-tokens']) || 500;
const via = String(args.via ?? 'raw').trim();

/** 样本：一段真实形态的猫 think（含英文推理流、多转折、中英夹杂）。 */
const sample = [
  'Ah — I see: the log is now full of NapCat log TAILER re-reading OLD napcat log content.',
  'Let me check logtail.js. If it reads the file from the beginning every tick instead of tracking an offset,',
  'every round replays the whole history — that would explain the flood.',
  '我先确认一下这是不是新问题。grep 一下 readFileSync 的用法，再看有没有 offset 记录。',
  '如果确实是从头读，那这是个 bug，得改成记录偏移量。'
].join('\n');

const t0 = Date.now();

if (via === 'shot') {
  // 消费点实锤：走领航员真实调用的那一层封装
  const shot = createShotService({
    log: { debug: () => {}, info: () => {}, warn: (tag, msg) => console.log('warn:', msg), error: () => {} },
    dataDir: path.resolve(moduleDir, '..', 'app', 'data'),
    hooks: {},
    vision: { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model },
    summary: { model, timeoutMs: 20000, maxTokens, maxChars: 4000 }
  });
  const out = await shot.summarize(sample);
  console.log('via            = shot.summarize');
  console.log('model          =', model);
  console.log('elapsed_ms     =', Date.now() - t0);
  console.log('summary        =', JSON.stringify(out));
} else {
  const question = [
    '下面是一段 AI 猫的思考过程。用两三句中文总结它现在在想什么、进展到哪、有没有卡点。',
    '只输出总结本身，不要复述原文。',
    '',
    sample
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${String(api.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: question }] }),
      signal: controller.signal
    });
    const data = await res.json();
    const choice = data?.choices?.[0] ?? {};
    const msg = choice?.message ?? {};
    console.log('via            = raw');
    console.log('model          =', data?.model);
    console.log('elapsed_ms     =', Date.now() - t0);
    console.log('finish_reason  =', choice?.finish_reason);
    console.log('content        =', JSON.stringify(String(msg.content ?? '')));
    console.log('reasoning_len  =', String(msg.reasoning_content ?? '').length);
    console.log('usage          =', JSON.stringify(data?.usage ?? {}));
  } finally {
    clearTimeout(timer);
  }
}
