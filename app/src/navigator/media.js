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
 * 实测（2026-10-25 · `tools/probe-tts-length.mjs`，日语 59 字 → 16.88 秒）：
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
  return /[\u3040-\u30ff]/.test(String(text ?? ''));
}

/**
 * 日语人称口径归一（仅语音台词用）。
 *
 * Rushiera 2026-10-26 定：日语译文里第一人称一律「わたし」（禁 俺 / 僕 等男性自称），
 * 第二人称优先「きみ」（禁 お前 / 貴様 / あんた 等不礼貌说法；需要敬语时用 あなた）。
 * 提示词已写明，这里做兜底——模型偶发不听话时仍念不出男性腔、也念不出骂人的称呼。
 *
 * @param {string} text 日语译文
 * @returns {string} 归一后的文本
 */
export function normalizeJapanesePronouns(text) {
  let out = String(text ?? '');
  // 第一人称：男性 / 老人 / 女性口语自称 → わたし（长词优先，避免「おれたち」被切碎）
  out = out.replace(/俺たち|俺達|おれたち|おれ達/g, 'わたしたち');
  out = out.replace(/僕たち|僕達|ぼくたち|ぼく達|僕ら|ぼくら/g, 'わたしたち');
  // 「おれ」要避开同音的 お礼（おれい）/ おれんじ——只挡独立的自称
  out = out.replace(/俺|おれ(?!い|ん)|僕|ぼく|わし|あたし|わたくし/g, 'わたし');
  // 第二人称：不礼貌 / 生硬说法 → きみ（汉字「君」不动——它读 きみ / くん 两读，替换会毁掉人名后缀）
  out = out.replace(/お前たち|お前達|おまえたち|おまえ達|あんたたち/g, 'きみたち');
  out = out.replace(/お前|おまえ|貴様|きさま|てめえ|てめぇ|あんた/g, 'きみ');
  // 汉字「私」→ 平假名：IrodoriTTS 可能把「私」读成 わたくし，统一书写形态即锁定读音。
  // 排除表只挡会改义的复合词（私服 / 私立 / 私的 …），不是人称用法。
  out = out.replace(/私(?!服|立|的|有|用|物|鉄|生活|邸|財|案|見|情|製)/g, 'わたし');
  return out;
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
  translate
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
   * 人称口径（わたし / きみ）与源语言无关——中文译来的、本来就是日语的都要归一。
   *
   * @param {string} text 文本
   * @returns {Promise<string>} 日语文本
   */
  async function translateJapanese(text) {
    const source = String(text ?? '').trim();
    if (!source) throw new Error('文本是空的');
    if (hasKana(source)) return normalizeJapanesePronouns(source);
    if (!hasChinese(source)) return normalizeJapanesePronouns(source);
    const out = await translate(source, 'ja');
    if (!out) throw new Error('中文转日语失败（翻译端点未配置或超时）');
    return normalizeJapanesePronouns(cleanText(out));
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
   * @returns {Promise<object>} { ok, text?, message?, error?, queued? }
   */
  async function ttsSpeak({ chat, text, caption = '', auto = false, runMode = '', queue = false }) {
    if (!String(text ?? '').trim()) return { ok: false, error: '文本是空的——语音要一句台词' };
    // 档位默认（Rushiera 2026-10-25）：**手工念**（群里点名 / 界面按钮）用 Large int8——音质优先；
    // **群语音伴随**（每句发言都念一遍）用 small——省时省显存。显式 runMode 优先于本默认。
    const mode = String(runMode ?? '').trim().toLowerCase() || ((auto || queue) ? 'small' : 'large-int8');
    // 排队口径（群语音伴随）：不参与「忙就拒」——几句话连着发时必须都能念到，
    // 由单条 drain 循环按序合成；返回时只代表「已入队」。
    if (queue) {
      ttsQueue.push({ chat, text, caption, auto, runMode: mode });
      // 积压上限：留最近 12 句（旧的丢，出声）——语音是伴随产物，宁可漏念也不越念越旧
      while (ttsQueue.length > TTS_QUEUE_MAX) {
        const dropped = ttsQueue.shift();
        record('error', `语音排队超上限（${TTS_QUEUE_MAX}）——丢弃最旧一句：${String(dropped?.text ?? '').slice(0, 30)}`);
      }
      const ahead = ttsPending();
      record('tts', `语音入队（第 ${ahead} 句待念）：${String(text).trim().slice(0, 40)}`);
      drainTts().catch((error) => record('error', `语音队列异常：${error?.message ?? error}`));
      return { ok: true, queued: ahead, message: `已入队（第 ${ahead} 句）` };
    }
    if (ttsBusy) return { ok: false, error: '上一句还在跑——先等它出来，或等它自然结束' };
    return runTtsJob({ chat, text, caption, auto, runMode: mode, awaitDone: false });
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
  async function runTtsJob({ chat, text, caption = '', auto = false, runMode = '', awaitDone = false }) {
    ttsBusy = true;
    let accepted = false;
    try {
      const probe = await online();
      if (!probe.online) return { ok: false, error: `ComfyDock 离线（${probe.detail}）` };
      let japanese;
      try {
        japanese = await translateJapanese(text);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      let style = String(caption ?? '').trim();
      if (style && hasChinese(style) && !hasKana(style)) {
        try {
          style = await translateJapanese(style);
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
      if (awaitDone) {
        await waitTts({ chat, source: String(text ?? '').trim(), auto });
      } else {
        waitTts({ chat, source: String(text ?? '').trim(), auto }).catch((error) => record('error', `语音收尾异常：${error?.message ?? error}`));
      }
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
   * @returns {Promise<void>} 完成
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
            return;
          }
          const file = path.join(outDir, `tts-${Date.now()}.wav`);
          try {
            await download(`/api/tts/audio?name=${encodeURIComponent(name)}`, file);
          } catch (error) {
            await sendText(chat, `语音产物下载失败：${error?.message ?? error}`);
            record('error', `语音产物下载失败：${error?.message ?? error}`);
            return;
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
          return;
        }
        if (job.state === 'error') {
          const reason = String(job.message || '未知原因');
          await sendText(chat, `语音合成失败：${reason}`);
          record('error', `语音合成失败：${reason}`);
          return;
        }
        if (job.state === 'idle') {
          await sendText(chat, '语音合成被中断（ComfyDock 侧已停）——要重来就再发一次。');
          record('error', '语音合成被中断（ComfyDock 侧已停）');
          return;
        }
      }
      await sendText(chat, '语音合成超时未收口——去 ComfyDock 面板看任务状态。');
      record('error', `语音轮询超时（${Math.round(ttsWaitMs / 60000)} 分钟）`);
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
