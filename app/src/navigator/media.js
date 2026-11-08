// navigator/media.js —— 群内生成能力（MOSS 生图 / IrodoriTTS 语音 / WD Tagger 反推提示词）
//
// 职责：把群里的自然语言请求落到 ComfyDock 的三个本地生成器，产物由领航员自己的出站直发回群。
// 边界：不做语义判断（「这句是画图还是改图」归业务面 R喵）；不改 ComfyDock 的模型与路径配置
//       （只临时覆盖 Prompt / Text / InputPath 这三个任务参数）。
// 设计：design-qqbotb-navigator.md §二十。

import fs from 'node:fs';
import path from 'node:path';

/** 单次 HTTP 请求超时（毫秒）——提交要等环境探针，留宽。 */
const REQUEST_TIMEOUT_MS = 120000;

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_MS = 2500;

/** 生图默认等待上限（毫秒）——MOSS 本地实测约 60 秒，留足模型加载。 */
const MOSS_TIMEOUT_MS = 10 * 60 * 1000;

/** 语音默认等待上限（毫秒）——首次加载模型可能较久。 */
const TTS_TIMEOUT_MS = 10 * 60 * 1000;

/** 打标默认等待上限（毫秒）。 */
const TAGGER_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 单次语音合成的**字数窗口**——由 30 秒硬上限反推。
 *
 * 实测（2026-10-25 · `tools/probe-tts-duration.mjs`，日语 59 字 → 16.88 秒）：
 *   **3.5 字/秒** → 30 秒 ≈ 104 字。取 100 留一点余量（标点、停顿、语速波动）。
 *
 * 上限为什么是 30 秒：IrodoriTTS 的 `SamplingRequest.max_seconds` 默认 30.0
 * （irodori-tts inference_runtime.py），ComfyDock 的 worker 构造时没传该字段；
 * checkpoint 的训练窗口也正是 30 秒（`max_latent_steps = 750` · hop 1920 · 48 kHz）。
 * 两处都不是本项目能改的——所以「长句」只能先切后念。
 */
const TTS_MAX_CHARS = 100;

/**
 * 按句截断到单次合成吃得住的长短（30 秒硬上限 · 约 3.5 字/秒）。
 *
 * 优先切在句末标点，切点太靠前退到逗号级，再不行才硬切——避免音频在句子中间断掉。
 *
 * @param {string} text 原文
 * @param {number} [max] 字数上限（默认 TTS_MAX_CHARS）
 * @returns {{text:string, clipped:boolean}} 结果
 */
function clipForSpeech(text, max = TTS_MAX_CHARS) {
  const body = String(text ?? '').trim();
  const limit = Number(max) > 0 ? Number(max) : TTS_MAX_CHARS;
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
 * 是否含中文（CJK 统一表意文字）。
 *
 * @param {string} text 文本
 * @returns {boolean} 是否含中文
 */
function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text ?? ''));
}

/**
 * 是否含日文假名（平假名 / 片假名）。
 *
 * @param {string} text 文本
 * @returns {boolean} 是否含假名
 */
function hasKana(text) {
  // 只认真正的假名字母：\u3041-\u309F 平假名、\u30A1-\u30FA 片假名。
  // 🔴 不能整段 \u3040-\u30FF —— 末尾 \u30FC 是长音符「ー」、\u30FB 是「・」，中文里也会出现
  // （芳乃语体每句以「ー」收尾）→ 整段判会把「吃是吃得ー。」当成已是日语，跳过翻译直接把中文
  // 送进 IrodoriTTS（2026-11-07 实测：台词是中文原文，被日语声线硬念）。
  return /[\u3041-\u309f\u30a1-\u30fa]/.test(String(text ?? ''));
}

/**
 * 日语人称口径归一（仅语音台词用）——**按当前人设卡分派**。
 *
 * Rushiera 2026-10-26 定下通用口径（わたし / きみ）；2026-11-07 起改按卡取：
 * 芳乃卡要「わたくし / そなた」，R喵 卡要「わたし / きみ」。口径来源 = `persona-cards.js`
 * 的 `jpPronounsOf(profileId)`，由调用方注入，本模块不认识人设库。
 *
 * 提示词层已按同一口径写，这里做兜底——模型偶发不听话时也不串味。
 *
 * @param {string} text 日语译文
 * @param {{first?: string, second?: string}} [pronouns] 人称口径（空 = わたし / きみ）
 * @returns {string} 归一后的文本
 */
export function normalizeJapanesePronouns(text, pronouns) {
  const first = String(pronouns?.first || '').trim() || 'わたし';
  const second = String(pronouns?.second || '').trim() || 'きみ';
  let out = String(text ?? '');
  // 第一人称：先收复数（长词优先，避免「おれたち」被切碎），再收单数
  if (first === 'わたくし') {
    out = out.replace(/俺たち|俺達|おれたち|おれ達|僕たち|僕達|ぼくたち|ぼく達|僕ら|ぼくら|わたしたち|私達/g, 'わたくしたち');
    out = out.replace(/俺|おれ(?!い|ん)|僕|ぼく|わし|あたし|わたし/g, 'わたくし');
  } else {
    out = out.replace(/俺たち|俺達|おれたち|おれ達/g, 'わたしたち');
    out = out.replace(/僕たち|僕達|ぼくたち|ぼく達|僕ら|ぼくら/g, 'わたしたち');
    // 「おれ」要避开同音的 お礼（おれい）/ おれんじ——只挡独立的自称
    out = out.replace(/俺|おれ(?!い|ん)|僕|ぼく|わし|あたし|わたくし/g, 'わたし');
  }
  // 汉字「私」→ 目标人称平假名：IrodoriTTS 可能把「私」读成 わたくし，统一书写形态即锁定读音。
  // 排除表只挡会改义的复合词（私服 / 私立 / 私的 …），不是人称用法。
  out = out.replace(/私(?!服|立|的|有|用|物|鉄|生活|邸|財|案|見|情|製)/g, first);
  // 第二人称：按卡口径收（汉字「君」不动——它读 きみ / くん 两读，替换会毁掉人名后缀）
  if (second === 'そなた') {
    out = out.replace(/お前たち|お前達|おまえたち|おまえ達|あんたたち|きみたち/g, 'そなたたち');
    out = out.replace(/お前|おまえ|貴様|きさま|てめえ|てめぇ|あんた|きみ|あなた/g, 'そなた');
  } else {
    out = out.replace(/お前たち|お前達|おまえたち|おまえ達|あんたたち/g, 'きみたち');
    out = out.replace(/お前|おまえ|貴様|きさま|てめえ|てめぇ|あんた/g, 'きみ');
  }
  return out;
}

/**
 * 日语台词里的**专有名词读音表**（中文 / 汉字形态 → 假名）。
 *
 * 为什么需要：翻译出口只给了人称口径，专名读音全靠模型猜——实测（2026-11-08 探针
 * `workspace:tools/CatTemp/tts-name-probe.mjs`）三条自我介绍里两种病都出现了：
 * ①「依田芳乃，请多指教」→「よしのだよしの」（姓氏丢了、名重复）
 * ②「我是依田家的芳乃」→「依田家の芳乃」（汉字留给 TTS 猜，依田常被念成 いでん / いた）
 * 正确读音取自人设卡 `personas/yoshino.md:76`（依田 よりた · 芳乃 よしの）。
 *
 * 扩展方式：换日系角色卡时按卡内读音表加行；**长词在前**——否则「依田家」会被「依田」先吃掉半截。
 *
 * @type {Array<{from: string, to: string}>}
 */
const PROPER_NOUN_MAP = [
  { from: '依田家', to: 'よりたけ' },
  { from: '依田芳乃', to: 'よりたよしの' },
  { from: '依田', to: 'よりた' },
  { from: '芳乃', to: 'よしの' }
];

/**
 * 译前把中文专名换成假名——让模型直接读到读音，不再自由音译。
 *
 * @param {string} text 中文原文
 * @returns {string} 替换后的文本
 */
export function localizeProperNouns(text) {
  let out = String(text ?? '');
  for (const { from, to } of PROPER_NOUN_MAP) out = out.split(from).join(to);
  return out;
}

/**
 * 译后把残留的汉字形态收回假名——模型仍可能把假名改写回汉字，或把名字叠着重复。
 *
 * 只处理表内专名，不碰其它汉字（同形词不在表内，不误伤）。
 *
 * @param {string} text 日语译文
 * @returns {string} 归一后的文本
 */
export function normalizeProperNouns(text) {
  let out = String(text ?? '');
  // 实测病态：模型把「依田芳乃」读成「よしのだよしの」（名重复、姓丢失）
  out = out.replace(/よしのだよしの|よりたのよしのよしの/g, 'よりたよしの');
  for (const { from, to } of PROPER_NOUN_MAP) out = out.split(from).join(to);
  return out;
}

// ── 语气词节流（TTS 专属 · 2026-11-08）──────────────────────────────
//
// 口径（Rushiera 2026-11-08）：念出来的日语里，语气词大约三成台词带一处就够——おや 可以用，
// 但不能变成「每三四句就一句おや」的口头禅。
//
// 为什么不能只靠提示词：模型无法统计自己产出的频率，单次生成时也看不见前几句用了什么；
// 「不要每句都用」这类软约束只能压一部分。所以分两层：
//   ① 提示词（navigator/index.js 的语尾口径行）只给倾向——多数句子直接起句；
//   ② 硬层放这里——最近 10 条台词最多 3 条带语气词（≈30%），且不连击，超额剥句首。
//
// 改前实测（`app/data/logs` 的 `[tts] 语音已提交` 行）：11-07 53 条里 11 条 おや 起头（20.8%）、
// 11-08 97 条里 23 条（23.7%）——听感偏密，且全部集中在同一句首位置。

/** 计入配额的语气词（会话语气词；「おはよう」这类问候语不算）。 */
const INTERJ_WORDS = ['おや', 'あら', 'ふふ', 'ふむ', 'ほう', 'ほー'];

/** 配额窗口（条数）与窗口内允许带语气词的条数——3/10 ≈ 30%。 */
const INTERJ_QUOTA_WINDOW = 10;
const INTERJ_QUOTA_MAX = 3;

/** 最近若干条台词是否带了语气词（按会话分桶；末尾 = 最近一条，用于「不连击」）。 */
const INTERJ_STATE = new Map();

/**
 * 取某个会话的语气词历史窗口。
 *
 * 按群分桶的理由：3% 的偏差落在单群听感上会被放大——同一时刻几个群都在念，
 * 共享一个窗口会让某个群连续全带、另一个群连续全不带。分桶后每群各自约三成。
 *
 * @param {string} [scope] 会话键（群号 / chatKey；空 = 共用缺省桶）
 * @returns {boolean[]} 历史（可原地 push / shift）
 */
function historyOf(scope) {
  const key = String(scope ?? '').trim() || 'default';
  if (!INTERJ_STATE.has(key)) INTERJ_STATE.set(key, []);
  return INTERJ_STATE.get(key);
}

/**
 * 语气词 token：词本身 + 紧跟的标点（逗号 / 破折号 / 长音 / 省略号 / 空白）。
 *
 * 位置合不合法另判（见 `headInterjections`）——句中的「おや」多为「亲（父母）」的假名写法，
 * 不能见词就删。
 */
const INTERJ_TOKEN_RE = new RegExp(
  '(?:' + INTERJ_WORDS.join('|') + ')(?=[、，,。．.！!？?ー—…\\-\\s　]|$)[、，,。．.！!？?ー—…\\-\\s　]*',
  'gu'
);

/** 语气词可出现的「前一个字符」——行首 / 句读 / 引号开 / 空白。 */
const INTERJ_PREV_RE = /[。．.!！?？…\n「『、，,\s　]/u;

/**
 * 找一行里位于句读起点的语气词（位置 + 长度，按出现顺序）。
 *
 * @param {string} line 单行台词
 * @returns {Array<{at: number, len: number}>} 命中
 */
function headInterjections(line) {
  const hits = [];
  INTERJ_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = INTERJ_TOKEN_RE.exec(line)) !== null) {
    const at = match.index;
    if (at === 0 || INTERJ_PREV_RE.test(line[at - 1])) hits.push({ at, len: match[0].length });
  }
  return hits;
}

/**
 * 按配额收掉句首语气词（TTS 台词专用）。
 *
 * 放行条件：窗口内配额未满 **且** 上一条台词没带语气词（防连击）。放行时一条只留一处，
 * 多出来的照样收掉；不放行时全部收掉。整行是引号台词的（`「…」`）不动——那是复述原文。
 *
 * @param {string} text 日语台词
 * @param {string} [scope] 会话键（群号 / chatKey）——每群独立配额
 * @returns {{text: string, allowed: boolean, changed: boolean, used: number, window: number, max: number}} 结果
 */
export function gateInterjections(text, scope) {
  const raw = String(text ?? '');
  const history = historyOf(scope);
  const meta = { used: history.filter(Boolean).length, window: INTERJ_QUOTA_WINDOW, max: INTERJ_QUOTA_MAX };
  if (!raw.trim()) return { text: raw, allowed: true, changed: false, ...meta };
  const lastUsed = history[history.length - 1] === true;
  const quotaLeft = meta.used < INTERJ_QUOTA_MAX && !lastUsed;
  let kept = 0;
  const out = raw
    .split('\n')
    .map((line) => {
      // 整行是一句引用台词——按原文念，不节流
      if (/^\s*「[\s\S]*」\s*$/.test(line)) return line;
      const hits = headInterjections(line);
      if (!hits.length) return line;
      let outLine = line;
      // 从后往前删——前面命中点的下标不漂移；放行时只留第一处
      for (let i = hits.length - 1; i >= 0; i -= 1) {
        if (quotaLeft && kept === 0 && i === 0) { kept = 1; continue; }
        outLine = outLine.slice(0, hits[i].at) + outLine.slice(hits[i].at + hits[i].len);
      }
      return outLine;
    })
    .join('\n');
  const body = out.trim();
  // 剥空了（整句只有一个语气词）→ 回落原样，按「已用」记账，不让语音变成空台词
  if (!body) {
    history.push(true);
    while (history.length > INTERJ_QUOTA_WINDOW) history.shift();
    return { text: raw, allowed: true, changed: false, ...meta, used: history.filter(Boolean).length };
  }
  history.push(kept > 0);
  while (history.length > INTERJ_QUOTA_WINDOW) history.shift();
  return { text: body, allowed: kept > 0, changed: body !== raw, ...meta, used: history.filter(Boolean).length };
}

/**
 * 清空语气词节流窗口。
 *
 * 只给自测用——生产链路不调用；跑断言前先清零，各用例之间不互相污染。
 *
 * @param {string} [scope] 只清某个会话桶（空 = 全清）
 * @returns {void}
 */
export function resetInterjectionGate(scope) {
  if (scope === undefined) INTERJ_STATE.clear();
  else INTERJ_STATE.delete(String(scope).trim() || 'default');
}

/**
 * 去掉模型包在译文外面的代码围栏与引号。
 *
 * @param {string} text 模型输出
 * @returns {string} 清理后的文本
 */
function cleanText(text) {
  let out = String(text ?? '').trim();
  out = out.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * 睡一会儿。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 完成
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建群内生成服务。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.dataDir 应用数据目录（取图 / 产物落盘用）
 * @param {object} [options.conf] 配置（endpoint / requireVip / moss / tts / tagger / translate）
 * @param {object} options.onebot OneBot 客户端（取图用——get_image 走协议端缓存）
 * @param {Function} options.sendImage 发图函数 (chat, file, caption) => Promise
 * @param {Function} options.sendText 发文字函数 (chat, text) => Promise
 * @param {Function} options.sendRecord 发语音函数 (chat, file, caption) => Promise
 * @param {Function} options.record 活动流记录 (kind, text) => void
 * @param {Function} options.translate 翻译函数 (text, target, options) => Promise<string>
 * @returns {object} 服务接口（mossDraw / ttsSpeak / wdTag / online / isBusy）
 */
export function createMediaService({
  log,
  dataDir,
  conf = {},
  onebot,
  sendImage,
  sendText,
  sendRecord,
  record,
  translate,
  jpPronounsOf
}) {
  const endpoint = String(conf.endpoint || '').replace(/\/+$/, '');
  const mossConf = conf.moss ?? {};
  const ttsConf = conf.tts ?? {};
  const taggerConf = conf.tagger ?? {};
  const mossPollMs = Number(mossConf.pollMs) > 0 ? Number(mossConf.pollMs) : DEFAULT_POLL_MS;
  const ttsPollMs = Number(ttsConf.pollMs) > 0 ? Number(ttsConf.pollMs) : DEFAULT_POLL_MS;
  const taggerPollMs = Number(taggerConf.pollMs) > 0 ? Number(taggerConf.pollMs) : DEFAULT_POLL_MS;
  const mossWaitMs = Number(mossConf.timeoutMs) > 0 ? Number(mossConf.timeoutMs) : MOSS_TIMEOUT_MS;
  const ttsWaitMs = Number(ttsConf.timeoutMs) > 0 ? Number(ttsConf.timeoutMs) : TTS_TIMEOUT_MS;
  const taggerWaitMs = Number(taggerConf.timeoutMs) > 0 ? Number(taggerConf.timeoutMs) : TAGGER_TIMEOUT_MS;
  const inDir = path.join(dataDir, 'media-in');
  const outDir = path.join(dataDir, 'media-out');

  /** 三个生成器各自单任务闸（ComfyDock 侧也是单任务，但先在这里挡住并发）。 */
  let mossBusy = false;
  let ttsBusy = false;
  let taggerBusy = false;

  /**
   * 语音排队（2026-10-25）——群语音伴随是一次发言排一句，几句话连着发时必须能依次念完。
   *
   * 语义：`queue` 口径进来的任务先入队，由单条 drain 循环串行执行（提交 → 等收口 → 下一句）；
   * ComfyDock 侧本来就单任务，排队只是把「并发拒绝」换成「依次念」。手动路径（群内点名 /
   * 界面点按钮）不入队，保持「上一句还在跑就明确回绝」的即时反馈。
   */
  const ttsQueue = [];
  let ttsDraining = false;

  /** 排队上限——超出丢最旧并出声（积压太久等于「念完这句时话题早过了」）。 */
  const TTS_QUEUE_MAX = 12;

  /**
   * 队列里还有几句话（含正在念的那一句）。
   *
   * @returns {number} 待办条数
   */
  function ttsPending() {
    return ttsQueue.length + (ttsBusy ? 1 : 0);
  }

  /**
   * 单条 drain 循环——把队列按序念完；新的入队会重新唤起它。
   *
   * @returns {Promise<void>} 队列清空
   */
  async function drainTts() {
    if (ttsDraining) return;
    ttsDraining = true;
    try {
      while (ttsQueue.length) {
        const job = ttsQueue.shift();
        let result;
        try {
          result = await runTtsJob({ ...job, awaitDone: true });
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) };
        }
        // 等回执的那一句（wait=true）在这里兑现：sent = 音频真发到了群
        // （先兑现再记日志——日志抛异常也不能让等回执的调用方挂着）
        job?.settle?.({ sent: result?.sent === true, text: result?.text, error: result?.error });
        if (!result?.ok) record('error', `排队语音未成：${result?.error ?? '未知原因'}`);
      }
    } finally {
      ttsDraining = false;
      // 竞态收口：入队恰好落在「while 判空之后、finally 之前」时，那一句会被漏掉——
      // 交给此刻再判一次（drainTts 同步重入安全：ttsDraining 已复位）。
      if (ttsQueue.length) drainTts().catch((error) => record('error', `语音队列异常：${error?.message ?? error}`));
    }
  }

  /**
   * 调 ComfyDock 的 HTTP 接口。
   *
   * @param {string} pathname 路径（含查询串）
   * @param {object} [options] 选项（method / body）
   * @param {number} [timeoutMs] 超时毫秒
   * @returns {Promise<object>} 响应体
   */
  async function call(pathname, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${endpoint}${pathname}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 探 ComfyDock 是否在线（额度概览）。
   *
   * @returns {Promise<object>} { online, detail }
   */
  async function online() {
    if (!endpoint) return { online: false, detail: '未配置端点' };
    try {
      await call('/api/summary', {}, 6000);
      return { online: true, detail: '在线' };
    } catch (error) {
      return { online: false, detail: String(error?.message ?? error) };
    }
  }

  /**
   * 下载 ComfyDock 的产物到本地。
   *
   * @param {string} pathname 下载路径（含查询串）
   * @param {string} file 本地目标路径
   * @returns {Promise<void>} 完成
   */
  async function download(pathname, file) {
    const response = await fetch(`${endpoint}${pathname}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('产物为空');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  }

  /**
   * 取本地图片路径——显式路径优先，其次协议端缓存（`get_image`），最后直链下载。
   *
   * 与 comfy.js 的取图口径一致：QQ 直链带 rkey、约一小时失效；`get_image` 认消息里的
   * file 名，拿的是协议端本地缓存，不受时效影响。
   *
   * @param {object} options 选项
   * @param {string} [options.image] 本地绝对路径
   * @param {string} [options.file] OneBot 消息段里的 file 名
   * @param {string} [options.url] 图片直链
   * @returns {Promise<string>} 本地图片绝对路径
   */
  async function materialize({ image = '', file = '', url = '' }) {
    const local = String(image || '').trim();
    if (local) {
      if (!fs.existsSync(local)) throw new Error(`本地图片不在：${local}`);
      return local;
    }
    fs.mkdirSync(inDir, { recursive: true });
    const stamp = Date.now();
    if (file) {
      try {
        const ret = await onebot.call('get_image', { file: String(file) });
        const src = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (src) {
          const dest = path.join(inDir, `${stamp}${path.extname(src) || '.png'}`);
          fs.copyFileSync(src, dest);
          return dest;
        }
      } catch (error) {
        record('media', `协议端取图失败，改走直链：${error?.message ?? error}`);
      }
    }
    const link = String(url || '').trim();
    if (link) {
      const response = await fetch(link);
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('图片下载为空');
      const dest = path.join(inDir, `${stamp}.png`);
      fs.writeFileSync(dest, buffer);
      return dest;
    }
    throw new Error('没有拿到图片——消息里没有图，也没有给路径');
  }

  /**
   * 把中文提示词翻成英文；JSON 结构化提示词保持结构、只翻中文字段。
   *
   * @param {string} prompt 用户提示词
   * @returns {Promise<string>} 英文提示词
   */
  async function translatePrompt(prompt) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('提示词是空的');
    if (text.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('提示词像 JSON 但解析失败——请检查括号 / 引号');
      }
      if (!hasChinese(JSON.stringify(parsed))) return text;
      const out = await translate(text, 'en', { json: true });
      if (!out) throw new Error('结构化提示词自动翻译失败——请改用英文 caption 再试');
      try {
        const translated = JSON.parse(cleanText(out));
        if (hasChinese(JSON.stringify(translated))) {
          throw new Error('结构化提示词翻译后仍含中文——请改用英文 caption 再试');
        }
        return JSON.stringify(translated);
      } catch (error) {
        if (String(error?.message || '').includes('仍含中文')) throw error;
        throw new Error('结构化提示词自动翻译失败（返回的不是 JSON）——请改用英文 caption 再试');
      }
    }
    if (!hasChinese(text)) return text;
    const out = await translate(text, 'en');
    if (!out) throw new Error('提示词自动翻译失败（翻译端点未配置或超时）');
    const translated = cleanText(out);
    if (hasChinese(translated)) throw new Error('提示词翻译后仍含中文——请再试一次或改用英文提示词');
    return translated;
  }

  /**
   * 把中文翻成日语；已是日语（含假名）就原样返回。
   *
   * 三条出口都过 `normalizeJapanesePronouns`：台词是给 IrodoriTTS 念的，
   * 人称口径与源语言无关——中文译来的、本来就是日语的都要归一。
   *
   * @param {string} text 文本
   * @param {{first?: string, second?: string}} [pronouns] 当前人设卡的日语人称口径
   * @returns {Promise<string>} 日语文本
   */
  async function translateJapanese(text, pronouns) {
    // 译前先落读音：中文专名换成假名，模型就不会自由音译（判据 → log §一百一十一）
    const source = localizeProperNouns(String(text ?? '').trim());
    if (!source) throw new Error('文本是空的');
    // 🔴 混排句也要整句翻：只看「有没有假名」会漏掉「おや——，你又递来一张符纸了ー。」这类半日半中
    // ——假名在、中文也在，跳过翻译就变成日语声线硬念中文（2026-11-07 实测）。
    // 判据：有假名且没有中文高频字 = 纯日语，只做人称归一；其余一律整句翻。
    // 不能直接用 hasChinese 判——它按 CJK 表意文字算，日语汉字（依田家 / 悩み）也会命中。
    const ZH_HINT = /[的了吗呢吧啊你我他她它们是很就都这个那说么怎没还给把被让，！？]/;
    if (hasKana(source) && !ZH_HINT.test(source)) return normalizeProperNouns(normalizeJapanesePronouns(source, pronouns));
    if (!hasChinese(source) && !ZH_HINT.test(source)) return normalizeProperNouns(normalizeJapanesePronouns(source, pronouns));
    const out = await translate(source, 'ja', { pronouns });
    if (!out) throw new Error('中文转日语失败（翻译端点未配置或超时）');
    return normalizeProperNouns(normalizeJapanesePronouns(cleanText(out), pronouns));
  }

  /**
   * 解析尺寸参数。
   *
   * @param {string} size 尺寸（如 1024x1024 / 竖图 / 横图）
   * @returns {{width:number,height:number}|null} 尺寸；无法识别返回 null
   */
  function parseSize(size) {
    const text = String(size ?? '').trim();
    if (!text) return null;
    const match = text.match(/^\s*(\d{2,4})\s*[x×*]\s*(\d{2,4})\s*$/i);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    if (/竖|portrait|vertical/i.test(text)) return { width: 832, height: 1216 };
    if (/横|landscape|horizontal/i.test(text)) return { width: 1216, height: 832 };
    return null;
  }

  /**
   * 生图——MOSS 文生图，出图后逐张发回群。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.prompt 提示词（中文自动翻英文）
   * @param {string} [options.size] 尺寸（如 1024x1024）
   * @param {string|number} [options.seed] 种子
   * @returns {Promise<object>} { ok, prompt?, message?, error? }
   */
  async function mossDraw({ chat, prompt, size = '', seed = null }) {
    if (mossBusy) return { ok: false, error: '已有一张图在跑——等它出图再提交下一张' };
    if (!String(prompt ?? '').trim()) return { ok: false, error: '提示词是空的——生图要一句画面描述' };
    mossBusy = true;
    let accepted = false;
    try {
      const probe = await online();
      if (!probe.online) return { ok: false, error: `ComfyDock 离线（${probe.detail}）` };
      let english;
      try {
        english = await translatePrompt(prompt);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      const dims = parseSize(size);
      let snapshot;
      try {
        snapshot = await call('/api/moss');
      } catch (error) {
        return { ok: false, error: `读 ComfyDock MOSS 配置失败：${error?.message ?? error}` };
      }
      const cfg = { ...(snapshot?.config || {}), prompt: english, batch: 1, inputImage: '' };
      if (dims) {
        cfg.width = dims.width;
        cfg.height = dims.height;
      }
      const seedText = String(seed ?? '').trim();
      let seedValue = -1;
      if (seedText && seedText !== 'null') {
        const value = Number(seedText);
        if (Number.isFinite(value)) seedValue = value;
      }
      cfg.seed = seedValue;
      let gen;
      try {
        const saved = await call('/api/moss/config', { method: 'POST', body: cfg });
        if (saved?.ok !== true) return { ok: false, error: `MOSS 配置未保存：${saved?.error ?? '未知原因'}` };
        gen = await call('/api/moss/generate', { method: 'POST' });
      } catch (error) {
        return { ok: false, error: `MOSS 提交失败：${error?.message ?? error}` };
      }
      if (gen?.ok !== true) return { ok: false, error: `MOSS 未受理：${gen?.message ?? '未知原因'}` };
      accepted = true;
      record('moss', `生图已提交：${english.slice(0, 60)}`);
      waitMoss({ chat, prompt: english }).catch((error) => record('error', `生图收尾异常：${error?.message ?? error}`));
      return { ok: true, prompt: english, message: gen.message };
    } finally {
      // 提交失败时立刻释放；成功时由 waitMoss 释放
      if (!accepted) mossBusy = false;
    }
  }

  /**
   * 轮询 MOSS 任务到收口——出图发群 / 失败发原因 / 超时出声。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.prompt 英文提示词（进回执标题）
   * @returns {Promise<void>} 完成
   */
  async function waitMoss({ chat, prompt }) {
    const deadline = Date.now() + mossWaitMs;
    const stamp = Date.now();
    try {
      while (Date.now() < deadline) {
        await sleep(mossPollMs);
        let live;
        try {
          live = await call('/api/moss/live', {}, 15000);
        } catch (error) {
          record('error', `生图轮询失败（继续等）：${error?.message ?? error}`);
          continue;
        }
        const job = live?.job ?? {};
        if (job.state === 'done') {
          const names = Array.isArray(job.images) ? job.images : [];
          if (!names.length) {
            await sendText(chat, '生图完成了，但产物清单为空——去 ComfyDock 面板看落点。');
            record('error', '生图完成但产物清单为空');
            return;
          }
          fs.mkdirSync(outDir, { recursive: true });
          for (let i = 0; i < names.length; i += 1) {
            const file = path.join(outDir, `moss-${stamp}-${i + 1}.png`);
            try {
              await download(`/api/moss/image?name=${encodeURIComponent(names[i])}`, file);
            } catch (error) {
              record('error', `生图产物下载失败（${names[i]}）：${error?.message ?? error}`);
              continue;
            }
            const caption = names.length > 1
              ? `画好了 · ${i + 1}/${names.length} · ${prompt.slice(0, 50)}`
              : `画好了 · ${prompt.slice(0, 80)}`;
            const sent = await sendImage(chat, file, caption);
            record(sent.ok ? 'moss' : 'error', sent.ok
              ? `生图已发群（${path.basename(file)}）`
              : `生图发群失败：${sent.error}`);
          }
          return;
        }
        if (job.state === 'error') {
          const reason = String(job.message || '未知原因');
          await sendText(chat, `生图失败：${reason}`);
          record('error', `生图失败：${reason}`);
          return;
        }
        if (job.state === 'idle') {
          await sendText(chat, '生图被中断（ComfyDock 侧已停）——要重画就再发一次。');
          record('error', '生图被中断（ComfyDock 侧已停）');
          return;
        }
      }
      await sendText(chat, '生图超时未收口——去 ComfyDock 面板看任务状态。');
      record('error', `生图轮询超时（${Math.round(mossWaitMs / 60000)} 分钟）`);
    } finally {
      mossBusy = false;
    }
  }

  /**
   * 语音——IrodoriTTS 日语合成，音频发回群。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.text 要说的内容（中文自动翻日语）
   * @param {string} [options.caption] 风格描述（中文会一并翻日语）
   * @param {boolean} [options.auto] 伴随模式（群开关开的自动语音）——
   *   文字已由发言方发过，成果只发音频、不再补发文字配文
   * @param {string} [options.runMode] 强制档位（small / large / large-int8 / large-gpu）——
   *   空 = 按口径取默认：**手工念 → large-int8**（音质优先）· **伴随 / 排队 → small**（省时省显存）
   * @param {boolean} [options.queue] 排队口径（群语音伴随）——忙时不回绝，入队串行念完
   * @param {boolean} [options.wait] 结果回传口径（2026-11-08 · 语音先行）——等这一句**真发到群**才返回，
   *   回执带 `sent`（音频到群=true）；业务面靠它把「先语音后文字」的次序做实。仅与 queue 同用
   * @returns {Promise<object>} { ok, text?, message?, error?, queued?, waited?, sent? }
   */
  async function ttsSpeak({ chat, text, caption = '', auto = false, runMode = '', queue = false, wait = false, pronouns = null }) {
    if (!String(text ?? '').trim()) return { ok: false, error: '文本是空的——语音要一句台词' };
    // 档位默认（Rushiera 2026-10-25）：**手工念**（群里点名 / 界面按钮）用 Large int8——音质优先；
    // **群语音伴随**（每句发言都念一遍）用 small——省时省显存。显式 runMode 优先于本默认。
    const mode = String(runMode ?? '').trim().toLowerCase() || ((auto || queue) ? 'small' : 'large-int8');
    // 排队口径（群语音伴随）：不参与「忙就拒」——几句话连着发时必须都能念到，
    // 由单条 drain 循环按序合成；返回时只代表「已入队」。
    if (queue) {
      // 结果回传（2026-11-08 · 语音先行）：`wait=true` 的入队项带一个 done 承诺——drain 把它念完
      // （音频真发到群 / 或失败）时兑现；业务面靠它决定那句文字什么时候发。不带 wait 的调用
      // 行为一字不变（入队即回执）。
      const job = { chat, text, caption, auto, runMode: mode, pronouns };
      if (wait) job.done = new Promise((resolve) => { job.settle = resolve; });
      ttsQueue.push(job);
      // 积压上限：留最近 12 句（旧的丢，出声）——语音是伴随产物，宁可漏念也不越念越旧
      while (ttsQueue.length > TTS_QUEUE_MAX) {
        const dropped = ttsQueue.shift();
        // 被丢的那句也要回执——否则等它的调用方永远挂着（静默挂起比丢一句更糟）
        dropped?.settle?.({ sent: false, error: `排队超上限（${TTS_QUEUE_MAX}）被丢弃` });
        record('error', `语音排队超上限（${TTS_QUEUE_MAX}）——丢弃最旧一句：${String(dropped?.text ?? '').slice(0, 30)}`);
      }
      const ahead = ttsPending();
      record('tts', `语音入队（第 ${ahead} 句待念）：${String(text).trim().slice(0, 40)}`);
      drainTts().catch((error) => record('error', `语音队列异常：${error?.message ?? error}`));
      if (!wait) return { ok: true, queued: ahead, message: `已入队（第 ${ahead} 句）` };
      const settled = await job.done;
      const arrived = settled?.sent === true;
      return {
        ok: true,
        queued: ahead,
        waited: true,
        sent: arrived,
        text: settled?.text,
        error: arrived ? undefined : String(settled?.error ?? '未知原因')
      };
    }
    if (ttsBusy) return { ok: false, error: '上一句还在跑——先等它出来，或等它自然结束' };
    return runTtsJob({ chat, text, caption, auto, runMode: mode, awaitDone: false, pronouns });
  }

  /**
   * 真正跑一句语音：探测 → 翻日语 → 写配置（含档位）→ 提交 → 收口。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.text 要说的内容（中文自动翻日语）
   * @param {string} [options.caption] 风格描述
   * @param {boolean} [options.auto] 伴随模式——只发音频、不补文字配文
   * @param {string} [options.runMode] 强制档位（空 = 沿用面板当前档）
   * @param {boolean} [options.awaitDone] 等收口（排队口径用——念完才轮到下一句）
   * @returns {Promise<object>} { ok, text?, message?, error? }
   */
  async function runTtsJob({ chat, text, caption = '', auto = false, runMode = '', awaitDone = false, pronouns = null }) {
    ttsBusy = true;
    let accepted = false;
    try {
      const probe = await online();
      if (!probe.online) return { ok: false, error: `ComfyDock 离线（${probe.detail}）` };
      // 日语人称口径：优先用调用方带来的（业务面按群解析好，随请求体一起到——单体不必自己读配置）；
      // 没有则按群号自解析（注入方可能返回 Promise，业务面 config 只能在调用时动态 import）。
      const jpPronouns = (pronouns && typeof pronouns === 'object')
        ? pronouns
        : (typeof jpPronounsOf === 'function' ? await jpPronounsOf(chat) : undefined);
      // 口径来源留痕：区分「请求体带来的」与「单体自解析」，排查人称没变时先看这条
      record('tts', `人称口径 ${jpPronouns ? `${jpPronouns.first} / ${jpPronouns.second}` : '缺省'} · 语尾 ${(jpPronouns?.tails || []).join('/') || '无'}（来源：${pronouns ? '请求体' : '自解析'}）`);
      let japanese;
      try {
        japanese = await translateJapanese(text, jpPronouns);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      // 语气词节流（2026-11-08）：念出来的日语里语气词约三成台词带一处、不连击。
      // 只收 TTS 台词，中文正文一个字不动（中文侧口径在 prompt.js / sender.js）。
      const gated = gateInterjections(japanese, chat);
      if (gated.changed) {
        record('tts', `语气词闸：${gated.allowed ? '放行一处' : '收掉句首'}（近 ${gated.window} 条已用 ${gated.used}/${gated.max}）`);
      }
      japanese = gated.text;
      let style = String(caption ?? '').trim();
      if (style && hasChinese(style) && !hasKana(style)) {
        try {
          style = await translateJapanese(style, jpPronouns);
        } catch (error) {
          return { ok: false, error: `风格描述翻译失败：${error?.message ?? error}` };
        }
      }
      let snapshot;
      try {
        snapshot = await call('/api/tts');
      } catch (error) {
        return { ok: false, error: `读 ComfyDock TTS 配置失败：${error?.message ?? error}` };
      }
      const cfg = { ...(snapshot?.config || {}), text: japanese, caption: style };
      // 档位强制（手念 large-int8 / 伴随 small）——写进 ComfyDock 的 RunMode 字段
      const mode = String(runMode ?? '').trim().toLowerCase();
      if (mode) cfg.RunMode = mode;
      // 30 秒硬上限的兜底（2026-10-25）：日语文案超出单次合成窗口时先按句末切——
      // 运行时会把超出部分**硬夹**在 30s（inference_runtime.py 的 max_seconds 夹取），
      // 结果是音频在半句话上戛然而止。这里做「先切后念」，宁可少念一句，不留断句。
      const spoken = clipForSpeech(japanese, TTS_MAX_CHARS);
      cfg.text = spoken.text;
      if (spoken.clipped) record('tts', `语音文案超 30 秒窗口——按句末切到 ${spoken.text.length} 字：${spoken.text.slice(0, 30)}`);
      let gen;
      try {
        const saved = await call('/api/tts/config', { method: 'POST', body: cfg });
        if (saved?.ok !== true) return { ok: false, error: `TTS 配置未保存：${saved?.error ?? '未知原因'}` };
        gen = await call('/api/tts/generate', { method: 'POST' });
      } catch (error) {
        return { ok: false, error: `TTS 提交失败：${error?.message ?? error}` };
      }
      if (gen?.ok !== true) return { ok: false, error: `TTS 未受理：${gen?.message ?? '未知原因'}` };
      accepted = true;
      record('tts', `语音已提交：${japanese.slice(0, 40)}`);
      // 排队口径要把这一句念完才轮到下一句（waitTts 收口时释放 ttsBusy）；
      // 手动口径不等——立即回执，收尾在后台轮询。
      // 结果回传（2026-11-08）：排队口径把 waitTts 的收口结果带出来——`sent` 才是
      // 「音频真发到群」的判据，`ok` 只代表合成受理。
      if (awaitDone) {
        const settled = await waitTts({ chat, source: String(text ?? '').trim(), auto });
        return {
          ok: true,
          text: japanese,
          message: gen.message,
          sent: settled?.ok === true,
          error: settled?.ok === true ? undefined : String(settled?.error ?? '未知原因')
        };
      }
      waitTts({ chat, source: String(text ?? '').trim(), auto }).catch((error) => record('error', `语音收尾异常：${error?.message ?? error}`));
      return { ok: true, text: japanese, message: gen.message };
    } finally {
      if (!accepted) ttsBusy = false;
    }
  }

  /**
   * 轮询 TTS 任务到收口——音频发群 / 失败发原因 / 超时出声。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.source 用户原话（进回执标题）
   * @param {boolean} [options.auto] 伴随模式——文字已发过，只发音频
   * @returns {Promise<{ok:boolean, error?:string, file?:string}>} 收口结果（ok=true 才代表音频真发到了群）
   */
  async function waitTts({ chat, source, auto = false }) {
    const deadline = Date.now() + ttsWaitMs;
    try {
      while (Date.now() < deadline) {
        await sleep(ttsPollMs);
        let live;
        try {
          live = await call('/api/tts/live', {}, 15000);
        } catch (error) {
          record('error', `语音轮询失败（继续等）：${error?.message ?? error}`);
          continue;
        }
        const job = live?.job ?? {};
        if (job.state === 'done') {
          const name = String(job.file || '');
          if (!name) {
            await sendText(chat, '语音合成完成了，但产物文件名为空——去 ComfyDock 面板看落点。');
            record('error', '语音完成但产物文件名为空');
            return { ok: false, error: '产物文件名为空' };
          }
          const file = path.join(outDir, `tts-${Date.now()}.wav`);
          try {
            await download(`/api/tts/audio?name=${encodeURIComponent(name)}`, file);
          } catch (error) {
            await sendText(chat, `语音产物下载失败：${error?.message ?? error}`);
            record('error', `语音产物下载失败：${error?.message ?? error}`);
            return { ok: false, error: `产物下载失败：${error?.message ?? error}` };
          }
          // 语音配文（Rushiera 2026-10-19 定）：语音发回前先把「说话内容」原文发一条文字——两条一起到。
          // 判例：17:52「念一下你是谁」只发了语音、文字一条没有（session mvf2sfsh · sent=[]）。
          // 伴随模式（auto）除外：那条文字由发言方自己发过了，这里再补一条就是重复刷屏。
          if (!auto) {
            try { await sendText(chat, String(source || '').trim().slice(0, 500)); } catch (error) { record('error', `语音配文发送失败：${error?.message ?? error}`); }
          }
          // 伴随模式（auto）带「语音 · 前 40 字」会把刚发过的文字再露一遍——只用一条纯音频。
          const caption = auto ? '' : `语音 · ${source.slice(0, 40)}`;
          const sent = await sendRecord(chat, file, caption);
          record(sent.ok ? 'tts' : 'error', sent.ok
            ? `语音已发群（${path.basename(file)}）`
            : `语音发群失败：${sent.error}`);
          return { ok: sent.ok === true, error: sent.ok ? undefined : String(sent.error ?? '发群失败'), file: path.basename(file) };
        }
        if (job.state === 'error') {
          const reason = String(job.message || '未知原因');
          await sendText(chat, `语音合成失败：${reason}`);
          record('error', `语音合成失败：${reason}`);
          return { ok: false, error: reason };
        }
        if (job.state === 'idle') {
          await sendText(chat, '语音合成被中断（ComfyDock 侧已停）——要重来就再发一次。');
          record('error', '语音合成被中断（ComfyDock 侧已停）');
          return { ok: false, error: '合成被中断（ComfyDock 侧已停）' };
        }
      }
      await sendText(chat, '语音合成超时未收口——去 ComfyDock 面板看任务状态。');
      record('error', `语音轮询超时（${Math.round(ttsWaitMs / 60000)} 分钟）`);
      return { ok: false, error: `轮询超时（${Math.round(ttsWaitMs / 60000)} 分钟）` };
    } finally {
      ttsBusy = false;
    }
  }

  /**
   * 反推提示词——WD Tagger 打标，标签文本发回群。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} [options.image] 本地图片路径
   * @param {string} [options.file] OneBot 消息段的 file 名
   * @param {string} [options.url] 图片直链
   * @returns {Promise<object>} { ok, image?, message?, error? }
   */
  async function wdTag({ chat, image = '', file = '', url = '' }) {
    if (taggerBusy) return { ok: false, error: '上一张还在打标——先等它出来' };
    if (!String(image || file || url || '').trim()) return { ok: false, error: '没有拿到图片——消息里没有图，也没有给路径' };
    taggerBusy = true;
    let accepted = false;
    try {
      const probe = await online();
      if (!probe.online) return { ok: false, error: `ComfyDock 离线（${probe.detail}）` };
      let local;
      try {
        local = await materialize({ image, file, url });
      } catch (error) {
        return { ok: false, error: `取图失败：${error?.message ?? error}` };
      }
      let snapshot;
      try {
        snapshot = await call('/api/tagger');
      } catch (error) {
        return { ok: false, error: `读 ComfyDock Tagger 配置失败：${error?.message ?? error}` };
      }
      const cfg = { ...(snapshot?.config || {}), inputPath: local, writeText: true };
      let gen;
      try {
        const saved = await call('/api/tagger/config', { method: 'POST', body: cfg });
        if (saved?.ok !== true) return { ok: false, error: `Tagger 配置未保存：${saved?.error ?? '未知原因'}` };
        gen = await call('/api/tagger/generate', { method: 'POST' });
      } catch (error) {
        return { ok: false, error: `Tagger 提交失败：${error?.message ?? error}` };
      }
      if (gen?.ok !== true) return { ok: false, error: `Tagger 未受理：${gen?.message ?? '未知原因'}` };
      accepted = true;
      record('tagger', `反推已提交：${path.basename(local)}`);
      waitTagger({ chat, file: local }).catch((error) => record('error', `反推收尾异常：${error?.message ?? error}`));
      return { ok: true, image: local, message: gen.message };
    } finally {
      if (!accepted) taggerBusy = false;
    }
  }

  /**
   * 轮询 Tagger 任务到收口——标签文本发群 / 失败发原因 / 超时出声。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群
   * @param {string} options.file 图片路径（进回执标题）
   * @returns {Promise<void>} 完成
   */
  async function waitTagger({ chat, file }) {
    const deadline = Date.now() + taggerWaitMs;
    try {
      while (Date.now() < deadline) {
        await sleep(taggerPollMs);
        let live;
        try {
          live = await call('/api/tagger/live', {}, 15000);
        } catch (error) {
          record('error', `反推轮询失败（继续等）：${error?.message ?? error}`);
          continue;
        }
        const job = live?.job ?? {};
        if (job.state === 'done') {
          const item = (Array.isArray(job.items) ? job.items : [])[0] ?? null;
          if (!item) {
            await sendText(chat, '反推完成了，但结果清单为空——去 ComfyDock 面板看落点。');
            record('error', '反推完成但结果清单为空');
            return;
          }
          const lines = [`反推完成 · ${job.model || 'WD Tagger'} · ${path.basename(file)}`];
          if (item.rating) lines.push(`分级：${item.rating}`);
          lines.push(`通用标签：${item.generalText || '（无）'}`);
          const chars = (Array.isArray(item.characters) ? item.characters : [])
            .map((row) => row?.name)
            .filter(Boolean);
          if (chars.length) lines.push(`角色标签：${chars.join(', ')}`);
          let text = lines.join('\n');
          if (text.length > 3500) text = `${text.slice(0, 3500)}…`;
          await sendText(chat, text);
          record('tagger', `反推结果已发群（${path.basename(file)}）`);
          return;
        }
        if (job.state === 'error') {
          const reason = String(job.message || '未知原因');
          await sendText(chat, `反推失败：${reason}`);
          record('error', `反推失败：${reason}`);
          return;
        }
        if (job.state === 'idle') {
          await sendText(chat, '反推被中断（ComfyDock 侧已停）——要重来就再发一次。');
          record('error', '反推被中断（ComfyDock 侧已停）');
          return;
        }
      }
      await sendText(chat, '反推超时未收口——去 ComfyDock 面板看任务状态。');
      record('error', `反推轮询超时（${Math.round(taggerWaitMs / 60000)} 分钟）`);
    } finally {
      taggerBusy = false;
    }
  }

  /** 是否有生成任务在跑（语音另附队列长度——排队口径下「在跑」不等于「已有几句待念」）。 */
  function isBusy() {
    return { moss: mossBusy, tts: ttsBusy, ttsQueued: ttsQueue.length, tagger: taggerBusy };
  }

  return { mossDraw, ttsSpeak, wdTag, online, isBusy, endpoint };
}
