// patch-qqbotb-voicereply.mjs — 「群语音伴随」幂等补丁（2026-10-25 · v0.86）
//
// 用法：
//   node tools/patch-qqbotb-voicereply.mjs           幂等打补丁（已打过的点 skipped）
//   node tools/patch-qqbotb-voicereply.mjs --dry     只报不写
//   node tools/patch-qqbotb-voicereply.mjs --app=<app 根绝对路径>   （默认 _unpack/resources/app）
//
// 做什么（Rushiera 2026-10-25 定：记忆页按群开 · 本号每句发言都再用 TTS 念一遍日语发群）：
//   1 新增 src/voice-reply.js（从 tools/templates/voice-reply.js 复制——模板即源码）
//   2 src/config.js      engage.voiceReply 默认段（默认全关 · 固定档 small · 500 字上限）
//   3 src/sender.js       import + 文本发送成功后挂语音伴随（只对开了语音的群）
//   4 ui/app/05-memory-settings.js  列表徽标 / 详情开关 / 两个写面函数
//
// 为什么业务面这侧只做转发：翻译 / 合成 / 发音频全在自研单体（它持有 ComfyDock 客户端与
// OneBot 连接）。业务面只需要在「这句已经成功发出去」之后把文本递过去。
//
// 为什么是补丁：`_unpack/` 不入 git（.gitignore:11），运行副本改动的唯一重放通道就是本脚本。
// 幂等：每个补丁点带唯一标记 [qqbotb-voicereply:<id>]；文件已含标记 = skipped。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_MODULE = path.join(HERE, 'templates', 'voice-reply.js');
const DRY = process.argv.includes('--dry');
const appArg = process.argv.find((a) => a.startsWith('--app='));
const APP = appArg ? path.resolve(appArg.slice('--app='.length)) : path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UI = path.join(APP, 'ui', 'app');

const results = [];
const mark = (id) => '[qqbotb-voicereply:' + id + ']';

/** 探测文件换行风格（应用源码是 CRLF；片段常量一律 LF）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** LF 片段 → 目标换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/**
 * 定点替换：锚点必须唯一命中；已应用过则跳过。
 *
 * @param {string} id 补丁点号
 * @param {string} root 根目录
 * @param {string} rel 相对路径
 * @param {string} anchor 锚点原文
 * @param {string} replacement 替换后文本
 * @returns {void}
 */
function patch(id, root, rel, anchor, replacement) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== 1) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 1）：' + JSON.stringify(a.slice(0, 80)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) src/config.js：engage.voiceReply 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config', SRC, 'config.js',
`      marker: '@余额',
      intervalMs: 1800000
    }
  },`,
`      marker: '@余额',
      intervalMs: 1800000
    },
    // ── 群语音伴随（2026-10-25）── [qqbotb-voicereply:config]
    // 按群把本号的**文字发言**再用 TTS 念一遍发回群（日語口语表达 · IrodoriTTS）。
    //   enabled：总开关（false = 清单保留但全不念）
    //   chats：开了语音的群号清单（记忆页「🔊 语音伴随」开关写这里）；空 = 全关（默认）
    //   runMode：固定档位——small = 依田芳乃 · v4.1-Small（写在 ComfyDock 的 RunMode 字段）
    //   maxChars：单句上限（**中文原句**字数）——合成器单次上限 30 秒，日语实测 3.5 字/秒
    //            （59 日语字 = 16.88 秒），30 秒 ≈ 100 个日语字符。中文译成日语后字符数略增，
    //            取 60 个中文字 ≈ 80 上下日语字 ≈ 23 秒，留足停顿与语速波动余量。
    //   caption：风格描述（空 = 不用；中文会一并翻日语）
    // 语义：本号每发出一条群文字，就把它交给自研单体 → ComfyDock → 音频自动回群；
    //      那条文字我们自己已经发过，所以走 auto（单体不再补发文字配文）。
    voiceReply: {
      enabled: true,
      chats: [],
      runMode: 'small',
      maxChars: 60,
      caption: ''
    }
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 2) src/sender.js：import + 文本发送成功后挂语音伴随
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-import', SRC, 'sender.js',
`import { paramsFor } from './engage-level.js';`,
`import { paramsFor } from './engage-level.js';
// 群语音伴随（本号每句发言再用 TTS 念一遍）——[qqbotb-voicereply:sender-import]
import { voiceReply } from './voice-reply.js';`);

patch('sender-hook', SRC, 'sender.js',
`        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };`,
`        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        // 群语音伴随（[qqbotb-voicereply:sender-hook]）——本群开了语音就把这句念一遍。
        // 放在「已经发出去」之后：语音是伴随产物，不是发言的前置；失败由模块自己落 logger.warn，
        // 不抛出、不 await（合成十几秒到一分钟，等它会拖住整条发送链）。
        if (String(kind) === 'group') {
          voiceReply(chatKey, text).catch(() => { /* 模块内部已落痕 */ });
        }
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };`);

// ─────────────────────────────────────────────────────────────────────────────
// 3) ui/app/05-memory-settings.js：列表徽标 / 详情开关 / 函数
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-list-badge', UI, '05-memory-settings.js',
`    // [qqagent-memory-patch:ui-list-sub]`,
`    // 语音伴随标记（[qqbotb-voicereply:ui-list-badge]）——本群开着就显示 🔊
    const voiceHtml = (() => {
      const id = String(key).split(':')[1] || '';
      const vc = voiceRuleOf(state.config || {}, id);
      if (!vc || !vc.on) return '';
      return \`<span class="unread-pill" style="background:var(--purple,#8b5cf6)" title="语音伴随已开：本号每次发言都会再念一遍日语发回本群（依田芳乃 · v4.1-Small）">🔊 语音</span>\`;
    })();
    // [qqagent-memory-patch:ui-list-sub]`);

patch('ui-list-html', UI, '05-memory-settings.js',
`          \${balanceHtml}<!-- [qqbotb-balance:ui-list-html] -->`,
`          \${balanceHtml}<!-- [qqbotb-balance:ui-list-html] -->
          \${voiceHtml}<!-- [qqbotb-voicereply:ui-list-html] -->`);

patch('ui-detail-html', UI, '05-memory-settings.js',
`          \${balanceCtlHtml}<!-- [qqbotb-balance:ui-detail-html] -->`,
`          \${balanceCtlHtml}<!-- [qqbotb-balance:ui-detail-html] -->
          \${voiceCtlHtml}<!-- [qqbotb-voicereply:ui-detail-html] -->`);

patch('ui-detail-head', UI, '05-memory-settings.js',
`        + ' <span id="mem-balance-status" class="muted"></span>'
      : '';
    detail.innerHTML = \``,
`        + ' <span id="mem-balance-status" class="muted"></span>'
      : '';
    // 语音伴随开关（[qqbotb-voicereply:ui-detail-head]）——仅群聊；默认关，按群开
    const vcState = kind === 'group' ? voiceRuleOf(cfg, chatId) : null;
    const voiceCtlHtml = vcState
      ? '<label class="muted" title="打开后本号在本群每发一句话，都会再用 IrodoriTTS 念一遍日语发回本群">'
        + '<input type="checkbox" id="mem-voice-chk"' + (vcState.on ? ' checked' : '') + '> 🔊 语音伴随</label>'
        + ' <span class="muted" style="font-size:12px">依田芳乃 · v4.1-Small · 每句 ≤' + vcState.maxChars + ' 字</span>'
      : '';
    detail.innerHTML = \``);

patch('ui-detail-bind', UI, '05-memory-settings.js',
`    $$('.mem-edit-imp', detail).forEach((el) => {`,
`    // 语音伴随（[qqbotb-voicereply:ui-detail-bind]）——开关写 engage.voiceReply.chats；
    // 下一句发言起生效（发送面每次发文字都现读配置，不用重启）。
    const voiceChkEl = detail.querySelector('#mem-voice-chk');
    if (voiceChkEl && kind === 'group') {
      voiceChkEl.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleVoiceChat(chatId, chatKey, voiceChkEl.checked);
      });
    }
    $$('.mem-edit-imp', detail).forEach((el) => {`);

// 标记用 ui-helpers（插入内容自身带的串）——同一点重跑必须 skip，否则每跑一次就多插一份函数。
patch('ui-helpers', UI, '05-memory-settings.js',
`/** 五档档名（与 config.engage.levels 默认表一致；UI 只作显示，判定在 src 侧）。[qqagent-level-patch:ui-helpers] */`,
`/**
 * 取某群的语音伴随状态（[qqbotb-voicereply:ui-helpers]）——{on, runMode, maxChars}；无群号返回 null。
 *
 * @param {object} cfg 配置
 * @param {string|number} groupId 群号
 * @returns {object|null} 状态
 */
function voiceRuleOf(cfg, groupId) {
  const id = String(groupId || '').trim();
  if (!/^\\d{1,15}$/.test(id)) return null;
  const v = ((cfg && cfg.engage && cfg.engage.voiceReply) || {});
  const chats = (Array.isArray(v.chats) ? v.chats : []).map(String);
  const max = Number(v.maxChars);
  return {
    on: v.enabled !== false && chats.includes(id),
    runMode: String(v.runMode || 'small'),
    maxChars: Number.isFinite(max) && max > 0 ? max : 500
  };
}

/**
 * 开 / 关某群的语音伴随（[qqbotb-voicereply:ui-toggle-fn]）。
 *
 * 写 config.engage.voiceReply.chats——开着时本号在本群每发一句文字，都会被
 * 念成日语语音（依田芳乃 · v4.1-Small）发回本群；关掉后下一句起不再念。
 * 不用重启：发送面每次发文字都现读配置。
 *
 * @param {string|number} groupId 群号
 * @param {string} chatKey 会话键
 * @param {boolean} on 是否开启
 * @returns {Promise<void>} 完成
 */
async function toggleVoiceChat(groupId, chatKey, on) {
  const id = String(groupId || '').trim();
  if (!/^\\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法设置语音伴随'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((((cfg.engage || {}).voiceReply || {}).chats) || []).map(String);
  const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { voiceReply: { chats: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(\`保存失败：\${e.message}\`);
  }
}

/** 五档档名（与 config.engage.levels 默认表一致；UI 只作显示，判定在 src 侧）。[qqagent-level-patch:ui-helpers] */`);

// ── 新文件：src/voice-reply.js（模板即源码，复制而非内嵌）────────────────────
// 已存在且内容不同 → 覆盖（模板是唯一真相源：改了排队等行为后重跑即同步），
// 但只认带本项目文件头的副本（"群语音伴随"首行）——别的同名文件不动，出声报冲突。
const dstModule = path.join(SRC, 'voice-reply.js');
const tplText = fs.readFileSync(TEMPLATE_MODULE, 'utf8');
if (!fs.existsSync(dstModule)) {
  if (DRY) {
    results.push({ id: 'module', file: 'src/voice-reply.js', status: 'dry' });
  } else {
    fs.writeFileSync(dstModule, tplText);
    results.push({ id: 'module', file: 'src/voice-reply.js', status: 'copied' });
  }
} else {
  const cur = fs.readFileSync(dstModule, 'utf8');
  if (cur === tplText) {
    results.push({ id: 'module', file: 'src/voice-reply.js', status: 'exist' });
  } else if (cur.startsWith('// 群语音伴随')) {
    if (!DRY) fs.writeFileSync(dstModule, tplText);
    results.push({ id: 'module', file: 'src/voice-reply.js', status: DRY ? 'dry-sync' : 'synced' });
  } else {
    throw new Error('[module] src/voice-reply.js 已存在且不是本项目的副本——先确认再处理');
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
for (const r of results) console.log('  ' + r.status.padEnd(14) + r.id.padEnd(16) + r.file);
console.log('APP=' + APP);
console.log(Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · '));
