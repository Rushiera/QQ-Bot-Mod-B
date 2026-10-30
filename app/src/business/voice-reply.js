// 群语音伴随 —— 记忆页「🔊 语音」开关（[qqbotb-voicereply:module] · 2026-10-25）
//
// 语义（Rushiera 2026-10-25 定）：某个群开了语音后，本 bot 每发出一句**文字**发言，
// 都再让自研单体用 IrodoriTTS（依田芳乃 · v4.1-Small）把这句话翻成日语口语念一遍，
// 音频发回同一个群——群里既能看字也能听声。
//
// 为什么业务面这侧只做「转发」：翻译 / 合成 / 发音频全在自研单体（它持有 ComfyDock
// 客户端与 OneBot 连接）；业务面只需要在「这句已经成功发出去」之后把文本递过去。
//
// 三个边界：
//   1 只对**群**生效（私聊没有群号），开关按群，清单空 = 全关（默认全关）；
//   2 失败出声（logger.warn）但不阻断发言——语音是伴随产物，不是发言的前置；
//   3 走 auto 模式：那条文字我们自己刚发过，单体不再补发文字配文（否则重复刷屏）。
import { getConfig } from './config.js';
import { logger } from './logger.js';

/** 自研单体（Electron 应用）的本地 API 端点——语音合成入口在它那侧。 */
const ENDPOINT = 'http://127.0.0.1:3280';

/** 单次转发超时（毫秒）——合成是异步受理的，这里只等「入队」这一步。 */
const REQUEST_TIMEOUT_MS = 15000;

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
 * 只做转发：能不能念、怎么念、念完发不发得出去，全由单体负责并在它的活动流里留痕。
 * 本函数不 await 合成结果（合成要十几秒到一分钟），也不抛出——调用点在发送成功之后，
 * 语音失败不该让已经发出去的那条消息变成"报错"。
 *
 * 排队（queue:true）：单体侧把这几句按序合成、依次发回群——发言常常连发两三条，
 * 手动口径那种「上一句还在跑就回绝」会让后面的句子丢掉声音。
 *
 * @param {string} chatKey 会话键（group:123456）
 * @param {string} text 刚发出去的那句文字
 * @returns {Promise<object>} { ok, queued?, skipped?, error? }
 */
export async function voiceReply(chatKey, text) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, skipped: true, error: '空文本' };
  if (!isVoiceChat(chatKey)) return { ok: false, skipped: true, error: '该群未开语音' };
  const rule = voiceRule();
  const chat = String(chatKey).split(':')[1] || '';
  // 超长发言不念整段（单次合成 30 秒硬上限，见 clipForSpeech）——按句末切到能念完的长度
  const clipped = clipForSpeech(body, rule.maxChars).text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}/api/nav/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        by: 'auto',
        auto: true,
        queue: true,
        chat,
        text: clipped,
        caption: rule.caption,
        runMode: rule.runMode
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { ok: false, error: raw.slice(0, 160) }; }
    if (data?.ok !== true) {
      logger.warn('voice', `群 ${chat} 语音未受理：${data?.error ?? raw.slice(0, 160)}`);
      return { ok: false, error: String(data?.error ?? '未受理') };
    }
    logger.info('voice', `群 ${chat} 已提交语音伴随（${clipped.slice(0, 30)}）`);
    return { ok: true, queued: data?.queued ?? null };
  } catch (error) {
    logger.warn('voice', `群 ${chat} 语音转发失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}
