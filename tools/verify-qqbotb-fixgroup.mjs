// verify-qqbotb-fixgroup.mjs — 四项体验修复的守门自测（2026-10-19）
//
// 用法：node verify-qqbotb-fixgroup.mjs
// 断言面：补丁标记在位 + 关键行为片段在位（业务面 tools.js / nav-tools.js、单体 media.js、生成源 apply-qqagent-config.mjs）
// 说明：本脚本只做静态断言（不真跑业务面）；真链路验收走群内实测。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_SRC = path.join(ROOT, '_unpack', 'resources', 'app', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
}

const tools = read(path.join(APP_SRC, 'tools.js'));
const navtools = read(path.join(APP_SRC, 'nav-tools.js'));
const media = read(path.join(ROOT, 'app', 'src', 'navigator', 'media.js'));
const cfgGen = read(path.join(HERE, 'apply-qqagent-config.mjs'));

// ── ① 取图：协议端缓存优先 ────────────────────────────────────────────────
check('工具·buildImagePayload 在 tools.js', tools.includes('async function buildImagePayload('));
check('工具·get_message_images 走协议端缓存', tools.includes("ctx.onebot.call('get_image', { file: String(item.file) })"));
check('补丁标记·image-cache-first', tools.includes('[qqbotb-fixgroup-patch:image-cache-first]'));
check('工具·get_recent_messages 不再叠加 pastStateCount', tools.includes('offset: offset + (ctx.session.pastStateCount || 0)') === false);

// ── ② TTS：念的语义 + 语音配文 ────────────────────────────────────────────
check('描述·tts_speak 含「念一下」触发词', navtools.includes('「念一下…」「念出来」「读一下」'));
check('描述·tts_speak 含念图先读图', navtools.includes('先用 get_message_images 读图'));
check('描述·finish 正文不发群硬规则', tools.includes('你写在正文里的内容不会发到 QQ'));
check('单体·语音配文（先发文字再发语音）', media.includes('语音配文') && media.includes('await sendText(chat, String(source'));
check('生成源·media-rules 含语音配文口径', cfgGen.includes('语音发回时系统会自动补一条文字'));

// ── ③ 重来：沿用上一次成功的路径 ─────────────────────────────────────────
check('描述·comfy_edit 含重来规则', navtools.includes('重来 / 再来一次 / 重画'));
check('生成源·media-rules 含续接指令段', cfgGen.includes('**续接指令（重来 / 再来一次 / 重画 / 改成）**'));
check('生成源·NAV_QUICK 含重来口径', cfgGen.includes('「重来 / 重画」沿用上一次成功的工具与参数'));

// ── ④ 补丁点齐备 ─────────────────────────────────────────────────────────
for (const id of ['image-payload', 'image-cache-first', 'recent-offset', 'finish-desc', 'tts-desc', 'comfy-retry']) {
  check(`补丁标记·${id}`, tools.includes(`[qqbotb-fixgroup-patch:${id}]`) || navtools.includes(`[qqbotb-fixgroup-patch:${id}]`));
}

const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.detail}`);
}
console.log(`\n结果：${passed}/${results.length} 通过`);
if (passed !== results.length) process.exit(1);
