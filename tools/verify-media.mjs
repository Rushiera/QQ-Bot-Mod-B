// verify-media.mjs —— 群内生成能力（MOSS 生图 / IrodoriTTS 语音 / WD Tagger 反推提示词）自测
//
// 用法：
//   node tools/verify-media.mjs                    守门自测（不触网、不生成）
//   node tools/verify-media.mjs --live-moss [--prompt-file <UTF-8 文本>]
//   node tools/verify-media.mjs --live-tts  [--text-file <UTF-8 文本>]
//   node tools/verify-media.mjs --live-tagger [--image <路径>]
//
// 边界：live 会真跑一次本地生成（MOSS 约 1 分钟 / TTS 十几秒到一分钟 / Tagger 几秒），
//       产物只发到 mock OneBot（群号 selftest），不会打扰真实群。
// 提示词 / 台词走文件读取，不经命令行传中文（PS 5.1 会把非 ASCII 参数按 ANSI 转码成乱码）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNavigator } from '../app/src/navigator/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_MOSS = process.argv.includes('--live-moss');
const LIVE_TTS = process.argv.includes('--live-tts');
const LIVE_TAGGER = process.argv.includes('--live-tagger');
const ENDPOINT = 'http://127.0.0.1:8971';
const VIP = '569145850';
const SELF = 2405997337;

/**
 * 取命令行参数值。
 *
 * @param {string} name 参数名
 * @returns {string} 参数值（缺省空串）
 */
function argOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '') : '';
}

const PROMPT_FILE = argOf('--prompt-file');
const TEXT_FILE = argOf('--text-file');
const IMAGE = argOf('--image') || 'D:\\Mau\\WorkSpace\\ComfyDock\\out\\gen\\41.png';
const PROMPT = PROMPT_FILE
  ? fs.readFileSync(PROMPT_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  : 'a cute orange tabby cat sitting on a windowsill, soft morning light, anime style';
const TTS_TEXT = TEXT_FILE
  ? fs.readFileSync(TEXT_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  : '你好，我是测试语音。';

const results = [];
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * 记录一条断言。
 *
 * @param {string} name 项名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 说明
 * @returns {void}
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 造一个领航员实例（mock OneBot：只收集调用，不真发；可灌 VIP 事件）。
 *
 * @param {object} mediaConf media 配置
 * @returns {object} { nav, sent, fire }
 */
function makeNav(mediaConf) {
  const sent = [];
  const listeners = new Set();
  const onebot = {
    call: async (action, params) => {
      sent.push({ action, params });
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: () => ({ self: { userId: SELF, nickname: 'R喵' } })
  };
  const nav = createNavigator({
    log,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-media-')),
    config: { navigator: { mainPort: 8080, vipUser: VIP, services: [], media: mediaConf } },
    onebot
  });
  /** 灌一条 VIP 群消息（模拟真人在群里 @ 本 bot）。 */
  const fire = (chat) => {
    const payload = {
      post_type: 'message',
      message_type: 'group',
      user_id: VIP,
      group_id: String(chat),
      raw_message: '@R喵 画一张图',
      message: [{ type: 'at', data: { qq: String(SELF) } }]
    };
    for (const fn of listeners) fn(payload);
  };
  return { nav, sent, fire };
}

/**
 * 等某个生成器收口。
 *
 * @param {object} nav 领航员实例
 * @param {string} key moss / tts / tagger
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否收口
 */
async function waitIdle(nav, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!nav.media.isBusy()[key]) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

// ── 1 接口面 ────────────────────────────────────────────────────────────────
const guard = makeNav({ enabled: false });
check('接口面·mossDraw / ttsSpeak / wdTag 可用',
  typeof guard.nav.mossDraw === 'function'
  && typeof guard.nav.ttsSpeak === 'function'
  && typeof guard.nav.wdTag === 'function');
check('接口面·sayRecord 可用', typeof guard.nav.sayRecord === 'function');

// ── 2 启用开关 ──────────────────────────────────────────────────────────────
const disabled = await guard.nav.mossDraw({ chat: 'selftest', prompt: 'a cat' });
check('开关·media.enabled=false 不受理',
  disabled.ok === false && String(disabled.error).includes('未启用'), disabled.error || '');

// ── 3 入参校验（不触网）────────────────────────────────────────────────────
const on = makeNav({ enabled: true, requireVip: true, endpoint: ENDPOINT });
const noPrompt = await on.nav.mossDraw({ chat: 'selftest', prompt: '  ' });
check('入参·空提示词报错退出',
  noPrompt.ok === false && String(noPrompt.error).includes('提示词'), noPrompt.error || '');
const noText = await on.nav.ttsSpeak({ chat: 'selftest', text: '  ' });
check('入参·空台词报错退出',
  noText.ok === false && String(noText.error).includes('文本'), noText.error || '');
const noImage = await on.nav.wdTag({ chat: 'selftest' });
check('入参·没图报错退出',
  noImage.ok === false && String(noImage.error).includes('没有拿到图片'), noImage.error || '');

// ── 4 请求者闸：群内触发 + 无新鲜 VIP 群消息 → 不受理 ───────────────────────
const vipGate = await on.nav.mossDraw({ by: 'qq', chat: 'selftest', prompt: 'a cat' });
check('请求者闸·群内非 VIP 触发不受理',
  vipGate.ok === false && vipGate.vipOnly === true, vipGate.error || '');

// ── 5 操作者通道（应用内 / 本地 API）不受请求者闸约束 ──────────────────────
const operator = await on.nav.mossDraw({ chat: 'selftest', prompt: '  ' });
check('操作者通道·不受请求者闸（仍会走参数校验）',
  operator.ok === false && String(operator.error).includes('提示词') && !operator.vipOnly, operator.error || '');

// ── 6 live：MOSS 生图 ──────────────────────────────────────────────────────
if (LIVE_MOSS) {
  const live = makeNav({
    enabled: true,
    requireVip: true,
    endpoint: ENDPOINT,
    moss: { pollMs: 2000, timeoutMs: 8 * 60 * 1000 }
  });
  live.fire('selftest');
  const res = await live.nav.mossDraw({ by: 'qq', chat: 'selftest', prompt: PROMPT });
  check('live·MOSS 受理', res.ok === true, res.error || `prompt=${String(res.prompt).slice(0, 60)}`);
  if (res.ok) {
    const done = await waitIdle(live.nav, 'moss', 8 * 60 * 1000);
    const imageSent = live.sent.some((row) => row.action === 'send_group_msg'
      && Array.isArray(row.params?.message)
      && row.params.message.some((seg) => seg?.type === 'image'));
    check('live·MOSS 出图并发群', done && imageSent, `done=${done} sent=${live.sent.length}`);
  }
}

// ── 7 live：IrodoriTTS 语音 ────────────────────────────────────────────────
if (LIVE_TTS) {
  const live = makeNav({
    enabled: true,
    requireVip: true,
    endpoint: ENDPOINT,
    tts: { pollMs: 2000, timeoutMs: 8 * 60 * 1000 }
  });
  live.fire('selftest');
  const res = await live.nav.ttsSpeak({ by: 'qq', chat: 'selftest', text: TTS_TEXT });
  check('live·TTS 受理', res.ok === true, res.error || `ja=${String(res.text).slice(0, 60)}`);
  if (res.ok) {
    const done = await waitIdle(live.nav, 'tts', 8 * 60 * 1000);
    const recordSent = live.sent.some((row) => row.action === 'send_group_msg'
      && Array.isArray(row.params?.message)
      && row.params.message.some((seg) => seg?.type === 'record'));
    check('live·TTS 语音发群', done && recordSent, `done=${done} sent=${live.sent.length}`);
  }
}

// ── 8 live：WD Tagger 反推 ─────────────────────────────────────────────────
if (LIVE_TAGGER) {
  const live = makeNav({
    enabled: true,
    requireVip: true,
    endpoint: ENDPOINT,
    tagger: { pollMs: 1000, timeoutMs: 3 * 60 * 1000 }
  });
  live.fire('selftest');
  const res = await live.nav.wdTag({ by: 'qq', chat: 'selftest', image: IMAGE });
  check('live·Tagger 受理', res.ok === true, res.error || '');
  if (res.ok) {
    const done = await waitIdle(live.nav, 'tagger', 3 * 60 * 1000);
    const textSent = live.sent.some((row) => row.action === 'send_group_msg'
      && (typeof row.params?.message === 'string'
        ? row.params.message.includes('通用标签')
        : Array.isArray(row.params?.message)
          && row.params.message.some((seg) => seg?.type === 'text' && String(seg?.data?.text).includes('通用标签'))));
    check('live·Tagger 标签发群', done && textSent, `done=${done} sent=${live.sent.length}`);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
