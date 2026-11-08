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
import { normalizeJapanesePronouns, localizeProperNouns, normalizeProperNouns, gateInterjections, resetInterjectionGate } from '../app/src/navigator/media.js';

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

// ── 5b 日语人称口径（わたし / きみ 归一 · Rushiera 2026-10-26）────────────────
const PRONOUN_CASES = [
  ['俺は強いぞ', 'わたしは強いぞ'],
  ['僕たちは行く', 'わたしたちは行く'],
  ['おれたちの話だ', 'わたしたちの話だ'],
  ['お前は誰だ', 'きみは誰だ'],
  ['貴様、てめえ、あんた', 'きみ、きみ、きみ'],
  ['お前たちは待ってろ', 'きみたちは待ってろ'],
  ['私は猫だ', 'わたしは猫だ'],
  ['私服と私立は残す', '私服と私立は残す'],
  ['お礼を言う', 'お礼を言う'],
  ['わたくしが参ります', 'わたしが参ります']
];
let pronounBad = [];
for (const [src, want] of PRONOUN_CASES) {
  const got = normalizeJapanesePronouns(src);
  if (got !== want) pronounBad.push(`${src} → ${got}（期望 ${want}）`);
}
check('人称·わたし / きみ 归一（10 例）', pronounBad.length === 0, pronounBad.join('；'));
const banned = [/俺/, /僕/, /ぼく/, /おれ/, /わし/, /お前/, /おまえ/, /貴様/, /てめ/, /あんた/];
const clean = normalizeJapanesePronouns('俺がお前を助ける。僕たちも行く。あんたは待っていろ');
check('人称·归一后不含男性 / 不礼貌代词',
  clean === 'わたしがきみを助ける。わたしたちも行く。きみは待っていろ' && !banned.some((re) => re.test(clean)), clean);

// ── 5b. 专名读音（2026-11-08 · 依田芳乃 = よりた よしの）──────────────────
// 判据 → design-qqbotb_log.md §一百一十一；读音来源 personas/yoshino.md:76
const named = localizeProperNouns('我是依田家的芳乃，替人听烦恼。');
check('专名·译前把中文名换成假名（依田家 / 芳乃）',
  named === '我是よりたけ的よしの，替人听烦恼。', named);
const nameCases = [
  ['よしのだよしの、よろしくお願いいたします', 'よりたよしの、よろしくお願いいたします'],
  ['わたくしは依田家の芳乃ですわ', 'わたくしはよりたけのよしのですわ'],
  ['わたくしは依田芳乃です', 'わたくしはよりたよしのです'],
  ['依田芳乃、请多指教', 'よりたよしの、请多指教']
];
const nameBad = [];
for (const [src, want] of nameCases) {
  const got = normalizeProperNouns(src);
  if (got !== want) nameBad.push(`${src} → ${got}（期望 ${want}）`);
}
check('专名·译后汉字收回假名（4 例 · 含重复病灶）', nameBad.length === 0, nameBad.join('；'));
check('专名·归一后不再残留「依田」「芳乃」汉字',
  !/依田|芳乃/.test(normalizeProperNouns('わたくしは依田芳乃、依田家のものです')));

// ── 5c 语气词节流（TTS 专属 · ≈30% · 2026-11-08）──────────────────────────
// 口径（Rushiera 2026-11-08）：念出来的日语里语气词约三成台词带一处就够，おや 可用但不连击。
// 判据 → design-qqbotb_log.md（本轮新增节）；改前实测 11-08 97 条里 23 条 おや 起头（23.7%）。
const GATE_LINE = 'おや——、それは……。';
resetInterjectionGate();
const gateKept = [];
for (let i = 0; i < 10; i += 1) {
  const r = gateInterjections(GATE_LINE);
  if (/^おや/u.test(r.text)) gateKept.push(i);
}
check('语气词闸·10 条里放行的 ≤3 条（≈30%）',
  gateKept.length > 0 && gateKept.length <= 3, `放行 ${gateKept.length} 条：${gateKept.join(',')}`);
check('语气词闸·不连击（放行条不相邻）',
  gateKept.every((at, i) => i === 0 || at - gateKept[i - 1] > 1), gateKept.join(','));

resetInterjectionGate();
const gateMulti = gateInterjections('おや、ふむ……これは。\nおや……二つ目。');
check('语气词闸·一条台词至多留一处',
  (gateMulti.text.match(/おや/gu) || []).length <= 1, gateMulti.text);
check('语气词闸·剥掉的句子不留孤立标点',
  !/^[、，,ー—…\s]/u.test(gateMulti.text.split('\n').pop() || ''), gateMulti.text);

resetInterjectionGate();
const gateQuoted = gateInterjections('「おや……わたくしは、参ります」');
check('语气词闸·引号台词原样不动',
  gateQuoted.text === '「おや……わたくしは、参ります」', gateQuoted.text);

resetInterjectionGate();
const gateTiny = gateInterjections('おや。');
check('语气词闸·剥空回落原样（不出空台词）',
  gateTiny.text.trim().length > 0, gateTiny.text);

resetInterjectionGate();
const gateMiss = gateInterjections('これは、雪の上の足跡でしてー。');
check('语气词闸·没有语气词的句子一个字不动',
  gateMiss.text === 'これは、雪の上の足跡でしてー。' && gateMiss.changed === false, gateMiss.text);

// 分桶：两个群各自算配额，不互相挤占
resetInterjectionGate();
const bucketA = [];
const bucketB = [];
for (let i = 0; i < 6; i += 1) {
  if (/^おや/u.test(gateInterjections(GATE_LINE, '112562956').text)) bucketA.push(i);
  if (/^おや/u.test(gateInterjections(GATE_LINE, '361820329').text)) bucketB.push(i);
}
check('语气词闸·按群分桶（两群各 6 条都有放行）',
  bucketA.length > 0 && bucketB.length > 0, `A=${bucketA.join(',')} B=${bucketB.join(',')}`);

// 同形词不误伤：「あらゆる」（所有）/「ほうりつ」（法律）不是语气词
resetInterjectionGate();
const gateLookalike = gateInterjections('あらゆる道を歩む。\nほうりつを守る。');
check('语气词闸·同形词不误伤（あらゆる / ほうりつ）',
  gateLookalike.text === 'あらゆる道を歩む。\nほうりつを守る。' && gateLookalike.changed === false, gateLookalike.text);

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
