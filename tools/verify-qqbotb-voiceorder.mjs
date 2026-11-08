// verify-qqbotb-voiceorder.mjs — 「语音先行」自测（源码断言，不跑应用）
//
// 用法：node tools/verify-qqbotb-voiceorder.mjs
// 口径（Rushiera 2026-11-08 定）：开了语音伴随的群 → 先等语音真发到群，再发那句文字；
// 没开语音的群不受限；对模型与群内视角不可见（照常发消息，只是晚一点到）。
// 断言：
//   1  sender.js       语音调用在 onebot.sendText 之前，且被 await（旧「发完再挂」形态已不存在）
//   2  sender.js       语音只对群触发，标记唯一
//   3  voice-reply.js  请求体带 wait；未开语音早退（零等待）
//   4  voice-reply.js  等待超时宽于入队超时；sent 回执判定在位
//   5  media.js        ttsSpeak 收 wait、入队项带 settle、drain 兑现 settle、waitTts 回 ok
//   6  navigator       路由把 wait 传给 ttsSpeak
// 说明：语法层校验由 tools/check-syntax.mjs 另跑，本脚本只管「次序与口径到位」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUSINESS = path.resolve(HERE, '..', 'app', 'src', 'business');
const NAVIGATOR = path.resolve(HERE, '..', 'app', 'src', 'navigator');

let pass = 0;
const fails = [];

/**
 * 记录一条断言。
 *
 * @param {string} name 项名
 * @param {boolean} cond 通过条件
 * @param {string} [detail] 失败说明
 * @returns {void}
 */
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}

/**
 * 读源码（缺失返回空串——后续断言自然红）。
 *
 * @param {string} dir 目录
 * @param {string} rel 文件名
 * @returns {string} 源码
 */
function read(dir, rel) {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; }
}

const sender = read(BUSINESS, 'sender.js');
const voice = read(BUSINESS, 'voice-reply.js');
const media = read(NAVIGATOR, 'media.js');
const navIndex = read(NAVIGATOR, 'index.js');

// ── 1 次序：语音在文字之前，且等它 ──────────────────────────────────────────
const voiceCallAt = sender.indexOf('await this.voiceReplyFn(');
const sendTextAt = sender.indexOf('const data = await this.onebot.sendText(');
ok('1a 语音调用在位（await voiceReply）', voiceCallAt > 0);
ok('1b 语音调用在 sendText 之前', voiceCallAt > 0 && sendTextAt > 0 && voiceCallAt < sendTextAt,
  `voice=${voiceCallAt} sendText=${sendTextAt}`);
ok('1c 旧形态（发完再挂、不 await）已不存在', !/voiceReply\(chatKey, text\)\.catch\(/.test(sender));
ok('1d 异常兜底不影响文字（try/catch 包住语音）',
  /try\s*\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*await this\.voiceReplyFn\(chatKey, text, \{ spoken \}\);\s*\n\s*\}\s*catch/.test(sender));

// ── 2 作用面：只对群；标记唯一 ──────────────────────────────────────────────
ok('2a 语音只对群触发', /if \(String\(kind\) === 'group'\) \{\s*\n\s*try \{[\s\S]{0,500}?await this\.voiceReplyFn\(/.test(sender));
ok('2b 标记 [qqbotb-voicereply:sender-hook] 唯一',
  (sender.match(/\[qqbotb-voicereply:sender-hook\]/g) || []).length === 1);

// ── 3 业务面转发：wait 口径 + 未开语音零等待 ────────────────────────────────
ok('3a 请求体带 wait', /\bwait,/.test(voice) || /wait:\s*true/.test(voice));
ok('3b 默认等回执（options.wait !== false）', /const wait = options\.wait !== false;/.test(voice));
const earlyAt = voice.indexOf('if (!isVoiceChat(chatKey))');
const fetchAt = voice.indexOf('await fetch(');
ok('3c 未开语音早退且在 fetch 之前', earlyAt > 0 && fetchAt > earlyAt,
  `early=${earlyAt} fetch=${fetchAt}`);

// ── 4 超时与回执判定 ────────────────────────────────────────────────────────
const waitTimeout = Number((voice.match(/const WAIT_TIMEOUT_MS = (\d+);/) || [])[1] || 0);
const requestTimeout = Number((voice.match(/const REQUEST_TIMEOUT_MS = (\d+);/) || [])[1] || 0);
ok('4a 等待超时宽于入队超时', waitTimeout > requestTimeout && requestTimeout > 0,
  `wait=${waitTimeout} request=${requestTimeout}`);
ok('4b 等待超时用于 wait 口径', /wait \? WAIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS/.test(voice));
ok('4c 未到群要出声（data?.sent !== true 分支）', /if \(data\?\.sent !== true\) \{/.test(voice));
ok('4d 超时不阻断（AbortError 只留痕）', /const timedOut = error\?\.name === 'AbortError';/.test(voice));

// ── 5 单体侧：wait → 入队 → drain 兑现 ─────────────────────────────────────
ok('5a ttsSpeak 收 wait', /queue = false, wait = false, pronouns = null/.test(media));
ok('5b 入队项带 done / settle', /if \(wait\) job\.done = new Promise/.test(media));
ok('5c drain 兑现 settle（sent 判据）', /job\?\.settle\?\.\(\{ sent: result\?\.sent === true/.test(media));
ok('5d 被丢弃的排队项也回执', /dropped\?\.settle\?\.\(\{ sent: false/.test(media));
ok('5e wait 口径返回 waited / sent', /waited: true,\s*\n\s*sent: arrived,/.test(media));
ok('5f waitTts 回 ok（音频真发到群）', /return \{ ok: sent\.ok === true/.test(media));
ok('5g 排队口径把收口结果带出 runTtsJob', /const settled = await waitTts\(\{ chat, source: String\(text \?\? ''\)\.trim\(\), auto \}\);/.test(media));

// ── 6 路由透传 ──────────────────────────────────────────────────────────────
ok('6a 路由把 wait 传给 ttsSpeak', /wait: body\?\.wait === true,/.test(navIndex));
ok('6b 包装层透传 wait', /media\.ttsSpeak\(\{ chat: gate\.chat, text, caption, auto, runMode, queue, wait, pronouns \}\)/.test(navIndex));

// ── 7 语音源（甲案 · 日语先行 · 2026-11-08）────────────────────────────────
// 模型给的日语原句（send_message 的 jp）经 sender → voice-reply → 路由 → 单体，
// 单体见含假名就跳过「中文→日语」翻译。判据 → design-qqbotb_log.md §一百一十九。
ok('7a sender 逐条传日语原句（voiceReplyFn(chatKey, text, { spoken })）',
  /this\.voiceReplyFn\(chatKey, text, \{ spoken \}\)/.test(sender));
ok('7b sender 按位对齐（partVoice 与 parts 同长 · 长消息切分只挂第一段）',
  /const partVoice = \[\]/.test(sender) && /partVoice\.push\(k === 0 \? spoken : ''\)/.test(sender));
ok('7c voice-reply 请求体带 japanese', /japanese: spoken,/.test(voice));
ok('7d 路由透传 japanese', /japanese: body\?\.japanese \?\? '',/.test(navIndex));
ok('7e 单体跳过翻译（resolveTtsSource 的 ja 分支在位）',
  /export function resolveTtsSource/.test(media) && /picked\.source === 'ja'/.test(media));

// ── 8 自测隔离：语音出口必须注入 stub（2026-11-08 事故）────────────────────────
// 事故：`verify-suite` 一跑，群 1097492606 连收十余条语音。根因 = 语音伴随直连单体
// `127.0.0.1:3280`（模块内 fetch），不走注入的 mock OneBot —— 假 OneBot 拦得住文字、拦不住语音；
// 而该群号恰在 `engage.voiceReply.chats` 里。修法 = `SendQueue({ voiceReplyFn })` 可注入，
// 所有自测/干跑构造时传 stub。本组把「有没有漏注入」变成可复跑的判据。
const toolsDir = HERE;
const queueUsers = fs.readdirSync(toolsDir).filter((f) => {
  if (!/\.mjs$/.test(f)) return false;
  try { return /new SendQueue\(/.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')); } catch { return false; }
});
const missingInject = queueUsers.filter((f) => !/voiceReplyFn:/.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')));
ok('8a 语音出口可注入（sender 用 this.voiceReplyFn）', /this\.voiceReplyFn\(/.test(sender));
ok(`8b 所有构造 SendQueue 的脚本都注入 voiceReplyFn（${queueUsers.length} 件）`,
  missingInject.length === 0, `未注入：${missingInject.join(', ') || '无'}`);

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({ ok: fails.length === 0, pass, fail: fails.length, fails }, null, 2));
console.log(`VOICE-ORDER ${pass}/${pass + fails.length} ${fails.length ? 'FAIL' : 'OK'}`);
// 用 exitCode 而不是 process.exit()——后者会截断尚未 flush 的 stdout。
process.exitCode = fails.length === 0 ? 0 : 1;
