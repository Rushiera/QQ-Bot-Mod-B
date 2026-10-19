// verify-qqagent-chatvoice.mjs — 「群聊语域」补丁自测（源码断言，不跑应用）
//
// 用法：node verify-qqagent-chatvoice.mjs
// 断言：
//   1  src/prompt.js 有 chatVoice() 函数定义
//   2  chatVoice 正文含三条约束（后台的事不进群 / 不点评 / 一次说完）
//   3  lean 数组接入 chatVoice()，且排在 memoryRules() 之前
//   4  full 数组接入 chatVoice()，且排在 notModerator() 之前
//   5  三个补丁点标记齐备（prompt-fn / prompt-lean / prompt-full）
//   6  补丁只动 prompt.js —— 其余源码不含 chatvoice 标记
//   7  段名唯一 —— 【别露出机器味】只出现一次
// 说明：语法层校验（node --check）由补丁链调用方另跑，本脚本只管"内容到位"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  try { return fs.readFileSync(path.join(SRC, rel), 'utf8'); } catch { return ''; }
}

const prompt = read('prompt.js');

// 1 函数定义
ok('1 chatVoice() 定义在位', /function\s+chatVoice\s*\(\s*\)\s*\{/.test(prompt));

// 2 三条约束
const fnBody = (() => {
  const i = prompt.indexOf('function chatVoice()');
  if (i < 0) return '';
  const j = prompt.indexOf('function notModerator()', i);
  return j > i ? prompt.slice(i, j) : prompt.slice(i);
})();
ok('2a 约束一（后台的事不进群）', fnBody.includes('后台的事不进群'));
ok('2b 约束二（不点评 / 不做技术判断）', fnBody.includes('不点评、不做技术判断'));
ok('2c 约束三（一条消息一次说完）', fnBody.includes('一条消息一次说完'));

// 3 lean 接入且次序正确
const leanIdx = prompt.indexOf('[qqagent-chatvoice-patch:prompt-lean]');
const leanMemIdx = prompt.indexOf('        memoryRules(),');
ok('3a lean 接入标记在位', leanIdx > 0);
ok('3b lean 次序（chatVoice 在 memoryRules 之前）', leanIdx > 0 && leanMemIdx > leanIdx);

// 4 full 接入且次序正确
const fullIdx = prompt.indexOf('[qqagent-chatvoice-patch:prompt-full]');
const fullNotModIdx = prompt.indexOf('    notModerator(),');
ok('4a full 接入标记在位', fullIdx > 0);
ok('4b full 次序（chatVoice 在 notModerator 之前）', fullIdx > 0 && fullNotModIdx > fullIdx);

// 5 标记齐备
ok('5a prompt-fn 标记', prompt.includes('[qqagent-chatvoice-patch:prompt-fn]'));
ok('5b prompt-lean 标记', prompt.includes('[qqagent-chatvoice-patch:prompt-lean]'));
ok('5c prompt-full 标记', prompt.includes('[qqagent-chatvoice-patch:prompt-full]'));

// 6 只动 prompt.js
for (const rel of ['config.js', 'sender.js', 'orchestrator.js', 'rapport.js', 'tools.js', 'routes.js', 'app.js']) {
  const t = read(rel);
  if (!t) continue;
  ok('6 未污染 ' + rel, !t.includes('qqagent-chatvoice-patch'));
}

// 7 段名唯一
ok('7 段名【别露出机器味】只出现一次', (prompt.match(/【别露出机器味】/g) || []).length === 1);

console.log(JSON.stringify({
  ok: fails.length === 0,
  pass,
  fail: fails.length,
  fails
}, null, 2));
// 用 exitCode 而不是 process.exit()——后者会截断尚未 flush 的 stdout（管道下 JSON 直接丢）。
process.exitCode = fails.length === 0 ? 0 : 1;
