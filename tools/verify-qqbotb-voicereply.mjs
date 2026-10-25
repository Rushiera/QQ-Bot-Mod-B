// verify-qqbotb-voicereply.mjs — 「群语音伴随」自测（纯函数真跑 + 源码断言，不启动应用）
//
// 用法：node tools/verify-qqbotb-voicereply.mjs
// 断言：
//   1~4   纯函数：voiceRule / voiceChats / isVoiceChat（仅群 · 按群 · 总开关）
//   5~7   config.js：engage.voiceReply 默认段在位 · 默认全关 · 固定档 small + 90 字上限（≈30 秒）
//   7b    clipForSpeech 纯函数：短句不切 / 长句切在句末标点 / 切点太靠前时退逗号 / 极端情况硬切
//   8~10  sender.js：import 在位 · 发送成功后挂 hook · 只对 group 挂
//   11~12 单体侧：media.js ttsSpeak 支持 auto / runMode / queue（排队串行念完）；
//         waitTts auto 不补发文字配文 · index.js /api/nav/tts 透传 auto + runMode + queue
//   13~14 UI：列表徽标 / 详情开关 / 写面函数与绑定
//   15    补丁脚本自身在（重装后可复现）
//
// 说明：语法层（node --check）与真链路（群内发一句 → 收到语音）不在此脚本范围内。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const MONO = path.join(ROOT, 'app', 'src');
const UI_MEM = path.join(APP, 'ui', 'app', '05-memory-settings.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function readOf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

const mod = await import(new URL('file:///' + path.join(SRC, 'voice-reply.js').replace(/\\/g, '/')).href);

// ── 1~4 规则与判定 ──────────────────────────────────────────────────────────
const rule = mod.voiceRule();
ok('1 voiceRule 结构（chats 数组 / runMode 字符串 / maxChars 正数）',
  Array.isArray(rule.chats) && typeof rule.runMode === 'string' && Number(rule.maxChars) > 0);
ok('2 voiceRule 固定档位 small（依田芳乃 · v4.1-Small）', rule.runMode === 'small', rule.runMode);
ok('3 isVoiceChat 私聊恒 false', mod.isVoiceChat('private:123456') === false);
const firstChat = rule.chats[0];
ok('4 isVoiceChat 按群判定（清单内 true · 清单外 false）',
  firstChat
    ? mod.isVoiceChat('group:' + firstChat) === true && mod.isVoiceChat('group:9999999999') === false
    : mod.isVoiceChat('group:9999999999') === false);

// ── 5~7 配置段 ─────────────────────────────────────────────────────────────
const cfgSrc = readOf(path.join(SRC, 'config.js'));
ok('5 config.js 有 voiceReply 默认段', /voiceReply:\s*\{/.test(cfgSrc));
ok('6 默认全关（chats 空数组）', /voiceReply:\s*\{[\s\S]{0,160}?chats:\s*\[\s*\]/.test(cfgSrc));
ok('7 固定档 small · 60 字上限（中文原句 ≈ 23 秒语音）',
  /voiceReply:\s*\{[\s\S]{0,400}?runMode:\s*'small'[\s\S]{0,260}?maxChars:\s*60/.test(cfgSrc));

// ── 7b 截断纯函数（30 秒上限 → 按句末切）───────────────────────────────────
const shortOne = '短句不切。';
const shortRes = mod.clipForSpeech(shortOne, 90);
ok('7b-1 短句原样返回（不切）', shortRes.text === shortOne && shortRes.clipped === false);
const longOne = '第一句话说完了。'.repeat(3) + '这是第四句没有结束标点的一句话还在继续'.repeat(3);
const longRes = mod.clipForSpeech(longOne, 30);
ok('7b-2 长句切在句末标点（不超限且以标点收尾）',
  longRes.clipped === true && longRes.text.length <= 30 && /[。！？!?…；;\n]$/.test(longRes.text), longRes.text);
const commaOnly = '一二三四五六七八九十一二三四五六七八九十，后面还有很长很长的一段没有句号';
const commaRes = mod.clipForSpeech(commaOnly, 25);
ok('7b-3 没有句末标点时退逗号级', commaRes.text.length <= 25 && commaRes.text.endsWith('，'), commaRes.text);
const noPunct = '啊'.repeat(80);
const hardRes = mod.clipForSpeech(noPunct, 20);
ok('7b-4 无任何标点则硬切到上限', hardRes.text.length === 20 && hardRes.clipped === true);

// ── 8~10 发送面挂钩 ────────────────────────────────────────────────────────
const senderSrc = readOf(path.join(SRC, 'sender.js'));
ok('8 sender.js 导入 voiceReply', /import\s*\{\s*voiceReply\s*\}\s*from\s*'\.\/voice-reply\.js'/.test(senderSrc));
ok('9 发送成功后挂伴随即（voiceReply(chatKey, text)）', /voiceReply\(chatKey,\s*text\)/.test(senderSrc));
ok('10 只对群挂（kind === group 判据在位）', /String\(kind\)\s*===\s*'group'/.test(senderSrc));

// ── 11~12 单体侧 ───────────────────────────────────────────────────────────
const mediaSrc = readOf(path.join(MONO, 'navigator', 'media.js'));
ok('11a ttsSpeak 接 auto 参数', /async function ttsSpeak\(\{[^}]*auto = false/.test(mediaSrc));
ok('11b ttsSpeak 接 runMode 并写进 ComfyDock 配置', /cfg\.RunMode = mode/.test(mediaSrc));
ok('11c waitTts auto 时不补发文字配文', /if \(!auto\)\s*\{[\s\S]{0,200}?await sendText\(chat, String\(source/.test(mediaSrc));
ok('11d 排队口径在位（ttsQueue / drainTts / queue 分支）',
  /const ttsQueue = \[\]/.test(mediaSrc) && /async function drainTts\(\)/.test(mediaSrc) && /if \(queue\)/.test(mediaSrc));
ok('11e 手工念走 Large int8（自动/排队走 small）',
  /\(auto \|\| queue\) \? 'small' : 'large-int8'/.test(mediaSrc));
ok('11f 翻译后再按句末切（cfg.text = spoken.text）且上限 100 日语字',
  /const TTS_MAX_CHARS = 100/.test(mediaSrc)
  && /clipForSpeech\(japanese, TTS_MAX_CHARS\)/.test(mediaSrc)
  && /cfg\.text = spoken\.text/.test(mediaSrc));
ok('11g 业务面按中文 60 字切（voice-reply 的 DEFAULT_RULE 与 config 默认同值）',
  /maxChars:\s*60/.test(readOf(path.join(SRC, 'voice-reply.js'))));
const navSrc = readOf(path.join(MONO, 'navigator', 'index.js'));
ok('12a /api/nav/tts 透传 auto + runMode', /auto:\s*body\?\.auto === true[\s\S]{0,80}?runMode:/.test(navSrc));
ok('12b by 认 auto（群开关通道）', /body\?\.by === 'auto'/.test(navSrc));
ok('12c /api/nav/tts 透传 queue（排队口径）', /queue:\s*body\?\.queue === true/.test(navSrc));
ok('12d 业务面 voiceReply 发 queue:true', /queue:\s*true/.test(readOf(path.join(SRC, 'voice-reply.js'))));

// ── 13~14 UI ───────────────────────────────────────────────────────────────
const uiSrc = readOf(UI_MEM);
ok('13 列表徽标（voiceHtml / 🔊 语音）', uiSrc.includes('[qqbotb-voicereply:ui-list-badge]') && uiSrc.includes('🔊 语音'));
ok('14a 详情开关在（id=mem-voice-chk）', uiSrc.includes('id="mem-voice-chk"'));
ok('14b 写面函数与绑定齐备',
  uiSrc.includes('async function toggleVoiceChat')
  && uiSrc.includes('function voiceRuleOf')
  && uiSrc.includes("querySelector('#mem-voice-chk')")
  && uiSrc.includes('voiceReply: { chats: next }'));

// ── 15 补丁脚本可复现 ─────────────────────────────────────────────────────
ok('15 补丁脚本 + 模块模板在（重装后可重放）',
  readOf(path.join(HERE, 'patch-qqbotb-voicereply.mjs')).includes('qqbotb-voicereply')
  && readOf(path.join(HERE, 'templates', 'voice-reply.js')).includes('export async function voiceReply'));
ok('15b 补丁重跑会同步模块（模板是唯一真相源）', /status: DRY \? 'dry-sync' : 'synced'/.test(readOf(path.join(HERE, 'patch-qqbotb-voicereply.mjs'))));

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = pass + fails.length;
if (fails.length) {
  console.log(`FAIL ${pass}/${total}`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`ALL PASS ${pass}/${total}`);
}
