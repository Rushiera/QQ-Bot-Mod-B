// 群语音伴随 —— 记忆页「🔊 语音」开关（[qqbotb-voicereply:module] · 2026-10-25 · 语音先行 2026-11-08）
//
// 语义（Rushiera 2026-10-25 定 · 2026-11-08 改序）：某个群开了语音后，本 bot 每发出一句**文字**发言，
// 都再让自研单体用 IrodoriTTS（依田芳乃 · v4.1-Small）把这句话翻成日语口语念一遍，音频发回同一个群。
//
// 🔴 次序（Rushiera 2026-11-08 定）：**先语音，后文字**——开了语音的群，那句文字要等它的语音
// 真发出去（单体回执 `sent:true`）再发；没开语音的群不受任何影响。对模型与群内视角不可见：
// 模型照常调用发消息、群 bot 照常发消息，区别只是「开了语音的群，文字晚一点才出去」。
//
// 为什么业务面这侧只做转发：翻译 / 合成 / 发音频全在自研单体（它持有 ComfyDock 客户端与
// OneBot 连接）；业务面在发文字**之前**把文本递过去，并等它的回执。
//
// 四个边界：
//   1 只对**群**生效（私聊没有群号），开关按群，清单空 = 全关（默认全关）；
//   2 失败可见但不阻断发言（logger.warn）——语音是伴随产物，等不到（离线 / 超时 / 发群失败）
//     就照常把那句文字发出去，不让一条消息因为语音丢掉；
//   3 走 auto 模式：那条文字我们自己随后会发，单体不再补发文字配文（否则重复刷屏）；
//   4 等待有上限（WAIT_TIMEOUT_MS）——合成十几秒到一分钟，拖太久就该让文字先走，
//     语音在单体侧仍会继续，晚到就晚到。
import { getConfig, personaForChat } from './config.js';
import { jpPronounsOf } from './persona-cards.js';
import { logger } from './logger.js';

/**
 * 该群当前生效人设卡的日语人称口径（随转发体一起交给单体——单体不必自己读业务面配置）。
 *
 * @param {string} chat 群号
 * @returns {{first: string, second: string}} 人称口径
 */
function jpPronounsForChat(chat) {
  try {
    return jpPronounsOf(personaForChat(`group:${String(chat ?? '').trim()}`).profileId);
  } catch {
    return jpPronounsOf('');
  }
}

/** 自研单体（Electron 应用）的本地 API 端点——语音合成入口在它那侧。 */
const ENDPOINT = 'http://127.0.0.1:3280';

/** 单次转发的**入队**超时（毫秒）——只覆盖「把文本递过去」这一步。 */
const REQUEST_TIMEOUT_MS = 15000;

/** 等语音真发出去的超时（毫秒）——合成十几秒到一分钟；超过就让那句文字先走（语音仍会晚到）。 */
const WAIT_TIMEOUT_MS = 180000;

/** 缺省规则（config 缺字段时兜底；与 config.js 默认段同值）。
 *
 * maxChars 60 的来历：合成器单次上限 30 秒，日语实测 **3.5 字/秒**
 * （59 日语字 → 16.88 秒）→ 30 秒 ≈ 100 个日语字符。这里按**中文原句**算字数：
 * 中文译成日语口语后字符数会略增，取 60 个中文字 ≈ 80 上下日语字 ≈ 23 秒，留足余量。
 */
const DEFAULT_RULE = {
  enabled: true,
  chats: [],
  runMode: 'small',
  maxChars: 60,
  caption: ''
};

/**
 * 按句截断到合成器吃得住的长短（**单次合成 30 秒上限**，改不了）。
 *
 * 上限有两处来源，都不在咱们手里：
 *   1 运行时默认 `SamplingRequest.max_seconds = 30.0`（irodori-tts inference_runtime.py），
 *     worker 构造请求时没传该字段（ComfyDock 的 tts_worker.py / TtsWorkerScript.cs）→ 恒走 30；
 *   2 checkpoint 自己的训练窗口就是 30 秒——`max_latent_steps = fixed_target_latent_steps = 750`
 *     （irodori_tts config.py），配 hop_length 1920 + 48 kHz：750 × 1920 / 48000 = **30.000 秒**。
 *     越过它运行时自己会警告「Long-tail stability may degrade」——不是不能出声，是音质会垮。
 *
 * 所以「长句」不靠抬上限，靠**先切后念**：优先切在句末标点，切不出退到逗号级，
 * 再不行才硬切——避免音频在句子中间断掉。
 *
 * @param {string} text 原文
 * @param {number} max 字数上限
 * @returns {{text:string, clipped:boolean}} 结果
 */
export function clipForSpeech(text, max) {
  const body = String(text ?? '').trim();
  const limit = Number(max) > 0 ? Number(max) : DEFAULT_RULE.maxChars;
  if (!body || body.length <= limit) return { text: body, clipped: false };
  const head = body.slice(0, limit);
  const HARD = ['。', '！', '？', '!', '?', '…', '；', ';', '\n'];
  const SOFT = ['，', '、', ',', ' '];
  /**
   * 在保留段里找最后一处给定标点。
   *
   * @param {string[]} set 标点集
   * @returns {number} 下标（-1 = 没找到）
   */
  const lastOf = (set) => {
    let idx = -1;
    for (const ch of set) {
      const at = head.lastIndexOf(ch);
      if (at > idx) idx = at;
    }
    return idx;
  };
  const floor = Math.floor(limit * 0.4);   // 切太短不如硬切——半句话的语音没意义
  let cut = lastOf(HARD);
  if (cut < floor) {
    const soft = lastOf(SOFT);
    if (soft >= floor) cut = soft;
  }
  const use = cut >= floor ? cut + 1 : limit;
  return { text: body.slice(0, use).trim(), clipped: true };
}

/**
 * 当前生效的语音规则（config 缺字段按缺省补；chats 一律字符串化）。
 *
 * @returns {{enabled:boolean, chats:string[], runMode:string, maxChars:number, caption:string}} 规则
 */
export function voiceRule() {
  const engage = getConfig().engage || {};
  const rule = { ...DEFAULT_RULE, ...(engage.voiceReply || {}) };
  rule.chats = (Array.isArray(rule.chats) ? rule.chats : []).map((v) => String(v).trim()).filter(Boolean);
  rule.runMode = String(rule.runMode || DEFAULT_RULE.runMode).trim().toLowerCase();
  const max = Number(rule.maxChars);
  rule.maxChars = Number.isFinite(max) && max > 0 ? max : DEFAULT_RULE.maxChars;
  rule.caption = String(rule.caption || '');
  return rule;
}

/** 开了语音的群号清单（总开关关闭 → 空数组）。 */
export function voiceChats() {
  const rule = voiceRule();
  if (rule.enabled === false) return [];
  return rule.chats;
}

/**
 * 该会话是否要伴随语音（仅群聊；开关按群）。
 *
 * @param {string} chatKey 会话键（group:123456）
 * @returns {boolean} 是否开启
 */
export function isVoiceChat(chatKey) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return false;
  const id = key.split(':')[1] || '';
  if (!id) return false;
  return voiceChats().includes(String(id));
}

/**
 * 把一句话交给自研单体去念（群开关触发）。
 *
 * 只做转发 + 等回执：能不能念、怎么念、念完发不发得出去，全由单体负责并在它的活动流里留痕。
 * 🔴 本函数**会等**（语音先行 2026-11-08）：`wait:true` 让单体把「音频真发到群」的结果带回来，
 * 调用点（sender）据此决定那句文字什么时候发。等待失败 / 超时也**不抛出**——语音是伴随产物，
 * 等不到就让文字先走（失败留 logger.warn，不把一条消息变成报错）。
 *
 * 排队（queue:true）：单体侧把这几句按序合成、依次发回群——发言常常连发两三条，
 * 手动口径那种「上一句还在跑就回绝」会让后面的句子丢掉声音。
 *
 * @param {string} chatKey 会话键（group:123456）
 * @param {string} text 即将发出的那句文字
 * @param {object} [options] 选项
 * @param {boolean} [options.wait] 等音频到群（默认 true；false = 旧口径，入队即走）
 * @returns {Promise<object>} { ok, sent?, queued?, skipped?, timedOut?, error? }（ok=true 才代表音频已到群）
 */
export async function voiceReply(chatKey, text, options = {}) {
  const wait = options.wait !== false;
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, skipped: true, error: '空文本' };
  if (!isVoiceChat(chatKey)) return { ok: false, skipped: true, error: '该群未开语音' };
  const rule = voiceRule();
  const chat = String(chatKey).split(':')[1] || '';
  // 超长发言不念整段（单次合成 30 秒硬上限，见 clipForSpeech）——按句末切到能念完的长度
  const clipped = clipForSpeech(body, rule.maxChars).text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), wait ? WAIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  // 口径留痕（业务面侧）：排查「人称没变」时先看这行——它证明算没算对、带没带上
  const pronouns = jpPronounsForChat(chat);
  logger.info('voice', `人称口径 ${pronouns.first}/${pronouns.second} · 语尾 ${(pronouns.tails || []).join('/') || '无'}（群 ${chat}）`);
  try {
    const response = await fetch(`${ENDPOINT}/api/nav/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        by: 'auto',
        auto: true,
        queue: true,
        // 语音先行：让单体把「这一句真发到群」的回执带回来（wait=false 时退回入队即回执）
        wait,
        chat,
        text: clipped,
        caption: rule.caption,
        runMode: rule.runMode,
        // 日语人称口径在业务面算好随请求带走——单体侧只跑媒体能力，不必读业务面配置
        pronouns
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { ok: false, error: raw.slice(0, 160) }; }
    if (data?.ok !== true) {
      logger.warn('voice', `群 ${chat} 语音未受理：${data?.error ?? raw.slice(0, 160)}`);
      return { ok: false, sent: false, error: String(data?.error ?? '未受理') };
    }
    if (!wait) {
      logger.info('voice', `群 ${chat} 已提交语音伴随（${clipped.slice(0, 30)}）`);
      return { ok: true, queued: data?.queued ?? null };
    }
    if (data?.sent !== true) {
      // 受理了但没送到群（合成失败 / 发群失败 / 排队丢弃）——文字照发，这里只留痕
      logger.warn('voice', `群 ${chat} 语音未到群：${data?.error ?? '未知原因'}——文字照发`);
      return { ok: false, sent: false, queued: data?.queued ?? null, error: String(data?.error ?? '未知原因') };
    }
    logger.info('voice', `群 ${chat} 语音已发群（${clipped.slice(0, 30)}）——文字随后发出`);
    return { ok: true, sent: true, queued: data?.queued ?? null };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    logger.warn('voice', `群 ${chat} ${timedOut ? `等语音超时（${Math.round(WAIT_TIMEOUT_MS / 1000)} 秒）` : '语音转发失败'}：${error?.message ?? error}——文字照发`);
    return { ok: false, sent: false, timedOut, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
