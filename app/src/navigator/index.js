// navigator/index.js —— 领航员编排（状态 · 健康检查 · 投递 · 观测 · 空闲守护 · 本地 API）
//
// 职责：把状态机（state.js）、CH4 猫面（ch4.js）、事件订阅（watch.js）、截图解读（shot.js）
//       编成领航员——开启 / 关闭 / 投递 / 观测 / 空闲暂关守护，并对外提供本地 HTTP API
//       （供界面与业务面 R喵 的工具调用）。
// 边界：不做群消息的语义判断（那归业务面 R喵）；不接管猫的会话；发群只发领航员自己的产出。
// 设计：design-qqbotb-navigator.md。

import fs from 'node:fs';
import path from 'node:path';
import { createNavigatorState, IDLE_CLOSE_MS } from './state.js';
import { createCh4Client } from './ch4.js';
import { createCatWatcher } from './watch.js';
import { createShotService } from './shot.js';
import { createComfyService } from './comfy.js';
import { PROJECT_DIR } from '../config.js';

/** 空闲巡检间隔（毫秒）。 */
const WATCH_INTERVAL_MS = 60 * 1000;

/** 外部服务探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 6000;

/** VIP 消息新鲜窗口（毫秒）——触发者校验与回消息群兜底共用。 */
const VIP_FRESH_MS = 120 * 1000;

/** 单次订阅的最长等待（毫秒）——超时放弃，不挂死。 */
const WATCH_TIMEOUT_MS = 10 * 60 * 1000;

/** 兜底轮询间隔（毫秒）——SSE 判据落空时按 keyinfo 的轮结算行收尾。 */
const POLL_INTERVAL_MS = 5000;

/** 交接轨迹默认条数（0 = 不限）——「少量缩减」口径：保留近期原文，不追求一句不丢。 */
const RESET_TRACE_LIMIT = 100;

/** 单条回复在轨迹里的截断长度（字符）——用户原话不截断。 */
const RESET_TRACE_REPLY_MAX = 8000;

/** 新会话就绪等待上限（毫秒）——等 keyinfo 出现加载报告再注入，替代固定等待。 */
const RESET_READY_TIMEOUT_MS = 30000;

/** 投递后自动做一次「猫会话分析」的延迟（毫秒）——替代「已投递」式回话（Rushiera 2026-10-11）。 */
const ANALYZE_DELAY_MS = 60 * 1000;

/** 抢救模式：代读**完整前文**（fullctx 拼正文）的字符上限（超出保留头尾、砍中段）——救援猫也要吃得下。 */
const RESCUE_SOURCE_MAX = 600000;

/** 抢救模式：代读正文保留头部比例（其余留尾部）——任务背景在头、近期进展在尾。 */
const RESCUE_HEAD_RATIO = 0.3;

/** 抢救模式：视为「交接摘要」的最短长度（字符）——更短的按「先回了一句」处理（催办后继续等）。 */
const RESCUE_SUMMARY_MIN = 200;

/** 抢救模式：救援猫回短话后最多催办次数（超过即判失败，不清前文）。 */
const RESCUE_RETRY_MAX = 3;

/**
 * 进度判读提示词——猫还在跑（尚未回复）时用（Rushiera 2026-10-11：要「做到哪 / 什么情况 / 还要多久」）。
 *
 * 判读走**带图模式**（截图只作输入，不发群）：该视觉模型对长中文纯文本提示词只产
 * `reasoning_content`、`content` 恒空（实测 max_tokens 4000 亦然），带图则正常。
 */
const PROGRESS_QUESTION = '这是 CH4 猫的会话截图。用三四句中文说清楚：① 它现在做到哪一步（正在干什么）② 有没有卡点或异常（有就点出来）③ 大概还要多久能做完（给个粗估，如「1-3 分钟」）。只描述图里能看到的，看不清就说看不清，不要编造。';

/** 「还在跑」播报的冷却（毫秒）——同一只猫两次播报的最小间隔（多猫并行时不刷屏）。 */
const PROGRESS_COOLDOWN_MS = 3 * 60 * 1000;

/** 计入卡片的视图块类型。 */
const BLOCK_TYPES = ['user', 'stream', 'text', 'reason', 'toolcard'];

/** think 摘要默认配置（可被 `navigator.summary` 覆盖）——模型必须选快档，见 `shot.summarize` 注释。 */
const SUMMARY_DEFAULTS = {
  enabled: true, model: 'deepseek-v4.1-flash', timeoutMs: 20000, maxTokens: 400, maxChars: 4000
};

/** think 摘要输出上限（字符）——超出再截（提示词已限 120 字，此处为保底）。 */
const THINK_SUMMARY_MAX = 200;

/** think 摘要不可用时贴原文的截断长度（字符）——回落保底，不整段倾倒。 */
const THINK_FALLBACK_MAX = 600;

/** think 摘要缓存条数上限——同一段思考不重复请求。 */
const THINK_SUMMARY_CACHE_MAX = 100;

/** 每猫留存的思考块条数上限（环形）——会话分析「直接读 think」的数据源。 */
const THINK_KEEP = 200;

/** 每猫留存的工具卡条数上限（环形）——会话分析「工具调用」的数据源。 */
const TOOL_KEEP = 50;

/** 每猫留存的旁白（gap_text）条数上限（环形）——会话分析「最近旁白」的数据源。 */
const GAP_KEEP = 20;

/** 直播态（live 临时区）视为新鲜的时间窗（毫秒）——超窗即回落已完成块。 */
const LIVE_FRESH_MS = 150 * 1000;

/** 现场拉取视图（一次性 SSE）的首帧等待上限（毫秒）。 */
const PULL_TIMEOUT_MS = 5000;

/** 轻通道巡检间隔（毫秒）——未开启模式下等回复。 */
const LIGHT_POLL_MS = 5000;

/** 轻通道观测最长等待（毫秒）——超时撤除（留痕）。 */
const LIGHT_WATCH_MAX_MS = 120 * 60 * 1000;

/**
 * 带超时的 JSON 请求（探测外部服务用——失败即视为离线，不抛出）。
 *
 * @param {string} url 地址
 * @returns {Promise<object|null>} 响应体或 null
 */
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 数字千分位（回执可读性）。
 *
 * @param {number} value 数值
 * @returns {string} 文本
 */
function group(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * 读业务面（QQ Agent）的 LLM 端点——领航员的图片解读复用同一池（Rushiera 2026-10-11 定）。
 *
 * @returns {object|null} { baseUrl, apiKey, model }
 */
function loadVision() {
  try {
    const file = path.join(PROJECT_DIR, '_unpack', 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const api = cfg?.api ?? {};
    if (!api.baseUrl || !api.apiKey || !api.model) return null;
    return { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model };
  } catch {
    return null;
  }
}

/**
 * 读业务面（QQ Agent）的 HTTP 端口——群记沉淀用的记忆 API 端口。
 *
 * 与 loadVision 同源同法：直接读它的 data/config.json（server.port）。
 * 应用启动时端口从 basePort 起向上找空位（3210..3219），故返回的只是**起点**，
 * 调用方仍逐个端口探测。读不到就给默认起点——探测会兜住。
 *
 * @returns {number} 端口起点
 */
function loadBizPort() {
  try {
    const file = path.join(PROJECT_DIR, '_unpack', 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const port = Number(cfg?.server?.port);
    return Number.isFinite(port) && port > 0 ? port : 3210;
  } catch {
    return 3210;
  }
}

/**
 * 创建领航员。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.dataDir 应用数据目录
 * @param {object} options.config 生效配置
 * @param {object} options.onebot OneBot 客户端（发群用）
 * @param {object} [options.hooks] 壳层能力（shot——Electron 截图）
 * @returns {object} 领航员接口
 */
export function createNavigator({ log, dataDir, config, onebot, hooks = {}, summarize: summarizeOverride }) {
  const navConfig = config?.navigator ?? {};
  const state = createNavigatorState({ file: path.join(dataDir, 'navigator.json'), log });
  const ch4 = createCh4Client({ log, mainPort: Number(navConfig.mainPort) || 8080 });
  const watcher = createCatWatcher({ log });
  // think 摘要配置（会话分析「读全」的 think 段——方案 A：交 LLM 总结，不整段倾倒）
  const summaryConf = { ...SUMMARY_DEFAULTS, ...(navConfig.summary ?? {}) };
  const shot = createShotService({ log, dataDir, hooks, vision: loadVision(), summary: summaryConf });
  /** 摘要出口——默认走 `shot.summarize`；自测可注入替身（不真调 LLM）。 */
  const summarize = typeof summarizeOverride === 'function' ? summarizeOverride : shot.summarize;
  const idleCloseMs = Number(navConfig.idleCloseMs) || IDLE_CLOSE_MS;
  const traceLimitRaw = Number(navConfig.resetTraceLimit);
  const traceLimit = Number.isFinite(traceLimitRaw) && traceLimitRaw >= 0 ? traceLimitRaw : RESET_TRACE_LIMIT;
  const analyzeDelayMs = navConfig.analyzeDelayMs === undefined
    ? ANALYZE_DELAY_MS
    : Number(navConfig.analyzeDelayMs) || 0;
  // 抢救模式代读上限（design §六b 抢救模式）——超出保留头尾、砍中段
  const rescueMaxRaw = Number(navConfig.rescueMaxChars);
  const rescueMaxChars = Number.isFinite(rescueMaxRaw) && rescueMaxRaw > 0 ? rescueMaxRaw : RESCUE_SOURCE_MAX;
  const services = Array.isArray(navConfig.services) ? navConfig.services : [];
  const vipUser = String(navConfig.vipUser || '');
  // 图像编辑（design-qqbotb-navigator.md §十八）——ComfyDock「[生成]」工作区
  const comfyConf = navConfig.comfy ?? {};
  const comfyEnabled = comfyConf.enabled !== false;
  // 请求者闸（Rushiera 2026-10-11：先收成只有 569145850 能用，白名单以后做）
  const comfyRequireVip = comfyConf.requireVip !== false;
  const comfy = createComfyService({
    log,
    dataDir,
    conf: comfyConf,
    onebot,
    sendImage: (chat, file, caption) => sayImage(chat, file, caption),
    sendText: (chat, text) => say(chat, text),
    record
  });
  let watchTimer = null;
  let ticking = false;

  /** 在途订阅：猫 key → 会话 { key, chat, port, blocks, startedAt, done }。 */
  const sessions = new Map();

  /** 活动流（最近 40 条）——观测窗口：订阅 / 事件 / 截图 / 发群都留痕。 */
  const activity = [];

  /** 投递后「猫会话分析」定时器（猫 key → 定时器）——每猫同一时刻只留一个。 */
  const analyzeTimers = new Map();

  /** 轻通道观测（猫 key → { key, chat, since, timer, done }）——未开启模式的「等回复」一次性观测。 */
  const lightWatches = new Map();

  /** 出站记录（猫 key → { at, kind, replyAt }）——出站决策去重与限流用。 */
  const sentLog = new Map();

  /** think 摘要缓存（思考原文 → 摘要）——同一段思考不重复请求。 */
  const thinkSummaryCache = new Map();

  /** 等「本轮回复」的等待器（猫 key → Set<resolve>）——前文整理重启用：挂持久观测的轮结束信号，不设时限。 */
  const roundWaiters = new Map();

  /** 本次领航统计（开启时归零）——关闭时进领航记录。 */
  const voyageStats = { replies: 0, progress: 0, tours: 0 };

  /**
   * 记一条活动（界面显示与事后排查共用）。
   *
   * @param {string} kind 类型（watch / event / shot / send / error）
   * @param {string} text 内容
   * @returns {void}
   */
  function record(kind, text) {
    const line = String(text ?? '');
    activity.push({ at: Date.now(), kind, text: line });
    if (activity.length > 40) activity.splice(0, activity.length - 40);
    log.info('navigator', `[${kind}] ${line}`);
  }

  /**
   * 把本次领航的场次小结沉淀进本群群记（Rushiera 2026-10-11：退出领航员是体面退出，
   * 这段经历要留在 R喵 的记忆里）。
   *
   * 为什么走业务面的记忆 API 而不是直写它的文件：记忆面的唯一所有者是业务面
   * （群记 = data/memory/<chat>/_group.json），跨进程直写会绕过它的规范化与更新事件。
   * 方向是反的（自研单体 → 业务面），但用的仍是它的公开 API —— 过渡态；
   * 终态记忆面随业务面并入自研单体后，本函数改为本地写入。
   *
   * 失败必须可见：写不进去只留痕，不阻断关闭。
   *
   * @param {string|number} chat 群号（可带 group: 前缀）
   * @param {string} text 条目正文（业务面按 200 字符截断）
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function sedimentVoyage(chat, text) {
    const id = String(chat ?? '').replace(/^group:/, '').trim();
    if (!/^\d+$/.test(id)) {
      record('error', `群记沉淀跳过：群号不可用（${chat ?? '空'}）`);
      return false;
    }
    const base = loadBizPort();
    for (let p = base; p < base + 10; p++) {
      try {
        const response = await fetch(`http://127.0.0.1:${p}/api/memory-files/group_${id}/group`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'project', content: String(text ?? '').slice(0, 200) })
        });
        if (!response.ok) {
          record('error', `群记沉淀失败（HTTP ${response.status}）：${(await response.text()).slice(0, 120)}`);
          return false;
        }
        record('memory', `领航场次已沉淀进群记（group:${id}）`);
        return true;
      } catch { /* 端口不对——试下一个 */ }
    }
    record('error', `群记沉淀失败：业务面记忆 API 不可达（试过 ${base}-${base + 9}）`);
    return false;
  }

  state.load();

  // ── VIP 消息监听（触发者硬校验 + 回消息群来源）───────────────────────────
  const vip = { chat: null, at: 0, text: '' };

  /**
   * 本 bot 的 QQ 号（@ 判定用）。
   *
   * @returns {number} QQ 号（未知为 0）
   */
  function selfId() {
    return Number(onebot?.status?.()?.self?.userId) || 0;
  }

  /**
   * 消息段里是否 @ 了本 bot。
   *
   * @param {Array<object>} message 消息段
   * @param {number} self 本 bot QQ 号
   * @returns {boolean} 是否 @ 了本 bot
   */
  function atSelf(message, self) {
    if (!Array.isArray(message)) return false;
    return message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(self));
  }

  /**
   * OneBot 事件入口——只认 VIP 在群里 @ 本 bot 的消息。
   *
   * @param {object} payload 事件体
   * @returns {void}
   */
  function onOnebotEvent(payload) {
    if (payload?.post_type !== 'message' || payload?.message_type !== 'group') return;
    if (String(payload?.user_id) !== vipUser) return;
    const self = selfId();
    if (self && !atSelf(payload?.message, self)) return;
    vip.chat = String(payload?.group_id ?? '');
    vip.at = Date.now();
    vip.text = String(payload?.raw_message ?? '');
    log.info('navigator', `VIP 消息（群 ${vip.chat}）：${vip.text.slice(0, 40)}`);
  }

  if (typeof onebot?.onEvent === 'function') onebot.onEvent(onOnebotEvent);

  /**
   * VIP 消息是否新鲜。
   *
   * @param {number} [ms] 窗口毫秒
   * @returns {boolean} 是否新鲜
   */
  function vipFresh(ms = VIP_FRESH_MS) {
    return vip.at > 0 && Date.now() - vip.at <= ms;
  }

  /**
   * 回消息群解析——显式给定优先，否则取新鲜的 VIP 消息所在群。
   *
   * @param {string|number|null} chat 显式群号
   * @returns {string|null} 群号
   */
  function resolveChat(chat) {
    if (chat !== null && chat !== undefined && chat !== '') return String(chat);
    return vipFresh() ? vip.chat : null;
  }

  // ── 发群（领航员自己的出站——不经业务面闸门）──────────────────────────────

  /**
   * 发一条群消息。
   *
   * @param {string|number} chat 群号
   * @param {string} text 正文
   * @returns {Promise<object>} 结果
   */
  async function say(chat, text) {
    if (chat === null || chat === undefined || chat === '') return { ok: false, error: '未指定群' };
    const content = String(text ?? '');
    if (!content.trim()) return { ok: false, error: '内容为空' };
    try {
      await onebot.call('send_group_msg', { group_id: Number(chat) || chat, message: content });
      log.info('navigator', `已发群 ${chat}：${content.split('\n')[0].slice(0, 60)}`);
      return { ok: true };
    } catch (error) {
      log.error('navigator', `发群失败（${chat}）：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 发一张图 + 说明到群。
   *
   * @param {string|number} chat 群号
   * @param {string} file PNG 绝对路径
   * @param {string} [caption] 说明文字
   * @param {string|number|null} [atQq] 需要 @ 的人（QQ 号；空 = 不 @）
   * @returns {Promise<object>} 结果
   */
  async function sayImage(chat, file, caption = '', atQq = null) {
    if (chat === null || chat === undefined || chat === '') return { ok: false, error: '未指定群' };
    const message = [];
    if (caption && String(caption).trim()) message.push({ type: 'text', data: { text: String(caption) } });
    message.push({ type: 'image', data: { file: `file:///${String(file).replace(/\\/g, '/')}` } });
    if (atQq) message.push({ type: 'at', data: { qq: String(atQq) } });
    try {
      await onebot.call('send_group_msg', { group_id: Number(chat) || chat, message });
      log.info('navigator', `已发图到群 ${chat}：${path.basename(file)}`);
      return { ok: true };
    } catch (error) {
      log.error('navigator', `发图失败（${chat}）：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 发一条带 @ 的群消息（纯文字——进度播报用，不带图）。
   *
   * @param {string|number} chat 群号
   * @param {string} text 正文
   * @param {string|number} [qq] 需要 @ 的人（空 = 不 @）
   * @returns {Promise<object>} 结果
   */
  async function sayAt(chat, text, qq = null) {
    if (chat === null || chat === undefined || chat === '') return { ok: false, error: '未指定群' };
    const content = String(text ?? '');
    if (!content.trim()) return { ok: false, error: '内容为空' };
    const message = [{ type: 'text', data: { text: content } }];
    if (qq) message.push({ type: 'at', data: { qq: String(qq) } });
    try {
      await onebot.call('send_group_msg', { group_id: Number(chat) || chat, message });
      log.info('navigator', `已发群 ${chat}（@${qq || '无'}）：${content.replace(/\n/g, ' | ').slice(0, 300)}`);
      return { ok: true };
    } catch (error) {
      log.error('navigator', `发群失败（${chat}）：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── 健康检查 ──────────────────────────────────────────────────────────────

  /**
   * 探一个外部服务。
   *
   * @param {object} svc 服务定义（key / name / url / kind）
   * @returns {Promise<object>} { key, name, online, detail }
   */
  async function probeService(svc) {
    if (!svc?.url) return { key: svc?.key, name: svc?.name ?? svc?.key, online: false, detail: '未接入' };
    const data = await fetchJson(svc.url);
    if (!data) return { key: svc.key, name: svc.name ?? svc.key, online: false, detail: '离线' };
    let detail = '在线';
    if (svc.kind === 'comfydock') {
      // 额度概览——合计推测剩余 + 最早重置（ComfyDock GET /api/summary）
      const remain = Number(data.remain ?? 0);
      const minutes = Number(data.resetInMinutes ?? 0);
      const when = minutes > 0 ? `重置在 ${minutes} 分钟后` : '重置时刻已过';
      detail = `在线（合计剩余 ${group(remain)} · ${when}）`;
    }
    if (svc.kind === 'apisite') {
      // 取最近采集的站点（lastFetchAt 最新）——多站时"当前在用"的那一个
      const list = Array.isArray(data.sites) ? [...data.sites] : [];
      list.sort((a, b) => String(b?.lastFetchAt ?? '').localeCompare(String(a?.lastFetchAt ?? '')));
      const site = list[0] ?? null;
      const siteId = site?.id ?? '';
      if (siteId) {
        const analysis = await fetchJson(`${svc.url.replace(/\/api\/sites.*$/, '')}/api/analysis?site=${encodeURIComponent(siteId)}`);
        const day = analysis?.overview?.last24h;
        if (day) {
          const tokens = Number(day.promptTokens || 0) + Number(day.completionTokens || 0);
          detail = `在线（过去 24 小时 ${group(day.count)} 次请求 / ${group(tokens)} token）`;
        } else {
          detail = '在线（24 小时统计未读到）';
        }
      }
    }
    return { key: svc.key, name: svc.name ?? svc.key, online: true, detail };
  }

  /**
   * 判一只猫是否有会话（≠ 待命）——正在跑，或已有会话正文内容。
   *
   * @param {object} row 猫状态
   * @returns {boolean} 是否有会话
   */
  function hasSession(row) {
    if (row?.runState && row.runState !== 'idle') return true;
    return Number(row?.contextCount ?? 0) > 1 || Number(row?.msgCount ?? 0) > 1;
  }

  /**
   * 全量健康检查（开启回执与状态页共用）。
   *
   * @returns {Promise<object>} { app, ch4, cats, working, busy, services, ok }
   */
  async function health() {
    const result = { app: { ok: true }, ch4: { ok: false, error: '' }, cats: [], working: [], busy: [], services: [], ok: false };

    try {
      result.cats = await ch4.cats();
      result.ch4.ok = true;
      result.working = result.cats.filter((row) => row?.runState && row.runState !== 'idle');
      result.busy = result.cats.filter((row) => hasSession(row));
    } catch (error) {
      result.ch4.error = String(error?.message ?? error);
      log.warn('navigator', `CH4 宿主探测失败：${result.ch4.error}`);
    }

    for (const svc of services) {
      try {
        result.services.push(await probeService(svc));
      } catch (error) {
        result.services.push({ key: svc?.key, name: svc?.name ?? svc?.key, online: false, detail: String(error?.message ?? error) });
      }
    }

    result.ok = result.app.ok && result.ch4.ok;
    return result;
  }

  /**
   * 渲染开启回执（模板见 design §九）。
   *
   * @param {object} report health() 的结果
   * @returns {string} 回执文本
   */
  function renderReceipt(report) {
    const lines = ['命令已收到，'];
    lines.push('应用指令层 --OK');
    for (const svc of report.services) {
      lines.push(`${svc.name}   ${svc.detail}`);
    }
    lines.push(report.ch4.ok ? 'Mau链接状态 --OK' : `Mau链接状态 --异常（${report.ch4.error || '未连接'}）`);
    const total = report.cats.length;
    const busy = report.busy ?? [];
    const running = report.working ?? [];
    const runningIds = new Set(running.map((row) => String(row.id)));
    const idleOnly = busy.filter((row) => !runningIds.has(String(row.id)));
    if (busy.length === 0) {
      lines.push(`当前全体猫待命（${total} 只），暂无猫在工作`);
    } else {
      const parts = [];
      if (running.length > 0) parts.push(`${running.map((row) => row.name || row.id).join('，')} 正在跑`);
      if (idleOnly.length > 0) parts.push(`${idleOnly.map((row) => row.name || row.id).join('，')} 有会话在手`);
      const rest = Math.max(total - busy.length, 0);
      lines.push(`当前 ${parts.join('；')}，其他 ${rest} 只猫待命中`);
    }
    lines.push('正在工作的猫稍后会同步状态，领航模式已开启，请下达指示，提前祝您生活愉快，工作顺利，开心每 1 天，R~');
    return lines.join('\n');
  }

  // ── 观测：猫回复 → 截图 → 解读 → 发群 ────────────────────────────────────

  /**
   * 猫名解析（id → 显示名）。
   *
   * @param {string} key 猫 key
   * @returns {Promise<string>} 显示名
   */
  async function catNameOf(key) {
    try {
      const rows = await ch4.cats();
      const hit = rows.find((row) => String(row?.id) === String(key));
      return hit?.name ? String(hit.name) : String(key);
    } catch {
      return String(key);
    }
  }

  /**
   * 排一次「猫会话分析」——到点抓该猫会话 → 截图 → 判读 → 发群。
   *
   * **独立功能，不是投递的附属**（Rushiera 2026-10-11）：入口可多个——当前是
   * 「投递后 N 秒」与「整理重启后」，后续可加别的触发点；核心只有本函数 + `runAnalysis`。
   *
   * @param {string} key 猫 key
   * @param {string|null} chat 回报群
   * @param {object} [options] 选项
   * @param {number} [options.delayMs] 延迟毫秒（默认取配置）
   * @param {string} [options.reason] 触发来源标签（进播报标题与日志）
   * @returns {void}
   */
  function scheduleAnalysis(key, chat, { delayMs = analyzeDelayMs, reason = '' } = {}) {
    if (!(delayMs > 0)) return;
    const old = analyzeTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      analyzeTimers.delete(key);
      runAnalysis(key, chat, reason).catch((error) => record('error', `会话分析（${key}）失败：${error?.message ?? error}`));
    }, delayMs);
    analyzeTimers.set(key, timer);
    record('watch', `${key}：已排 ${Math.round(delayMs / 1000)} 秒后的猫会话分析${reason ? `（${reason}）` : ''}`);
  }

  /**
   * 出站决策——**所有发群都先过这里**（Rushiera 2026-10-11：回复事件先给领航员，由它决定发什么）。
   *
   * 规则（每猫）：
   *   ① **有新回复**（自上次出站以来）→ 截图（只截回复内容）
   *   ② **没有新回复** + 检查点触发 + 该猫还在跑 + 冷却已过 → 文字播报 + @ 触发者
   *   ③ 其余 → **静默**（没拿到信息就不发——避免刷屏）
   *
   * @param {object} options 选项
   * @param {string} options.key 猫 key
   * @param {string|number|null} [options.chat] 回报群
   * @param {string} options.trigger 触发来源（`roundEnd` 轮结束 / `checkpoint` 检查点）
   * @param {Array<object>} [options.items] 会话条目
   * @param {string} [options.reason] 标签（进标题与日志）
   * @returns {Promise<object>} { ok, sent }——sent = reply / progress / none
   */
  async function emitOutbound({ key, chat = null, trigger, items = [], reason = '' }) {
    const target = resolveChat(chat) ?? state.snapshot().activeChat;
    if (!target) {
      record('error', `出站（${key}）：没有回消息群，跳过`);
      return { ok: false, sent: 'none', error: 'no-chat' };
    }
    const rows = Array.isArray(items) ? items : [];
    const catName = await catNameOf(key);
    const prev = sentLog.get(key) ?? { at: 0, kind: '', replyAt: 0 };
    const lastReply = [...rows].reverse().find((row) => String(row?.role ?? '') === 'reply');
    const replyAt = Number(lastReply?.time ?? 0) || 0;
    const label = reason ? `·${reason}` : '';

    // ① 有新回复 → 截图（只截回复内容）
    if (replyAt > prev.replyAt) {
      let png = '';
      try {
        png = await shot.shoot({ catName, blocks: replyBlocksOf(rows), at: new Date().toLocaleString('zh-CN', { hour12: false }) });
      } catch (error) {
        record('error', `出站（${key}）：截图失败（${error?.message ?? error}）`);
        return { ok: false, sent: 'none', error: 'shot' };
      }
      if (!png) {
        record('error', `出站（${key}）：截图为空，跳过`);
        return { ok: false, sent: 'none', error: 'empty' };
      }
      const sent = await sayImage(target, png, `${catName} 的回复${label}`);
      if (sent.ok) {
        sentLog.set(key, { at: Date.now(), kind: 'reply', replyAt });
        voyageStats.replies += 1;
      }
      record(sent.ok ? 'send' : 'error', sent.ok
        ? `回复截图已发群 ${target}（${catName}）`
        : `回复截图发送失败：${sent.error}`);
      return { ok: sent.ok, sent: 'reply' };
    }

    // ② 检查点：没新回复，但该猫还在跑 → 播报（冷却内静默）
    if (trigger !== 'checkpoint') {
      record('watch', `${catName}：无新回复，静默`);
      return { ok: true, sent: 'none' };
    }
    let resolvedKey = String(key);
    let running = false;
    try {
      resolvedKey = await ch4.resolveKey(key);
      const cats = await ch4.cats();
      const row = cats.find((item) => String(item?.id) === String(resolvedKey));
      const runState = String(row?.runState ?? 'idle');
      running = runState.toLowerCase() !== 'idle';
    } catch (error) {
      record('error', `出站（${key}）：取状态失败（${error?.message ?? error}）——按已停处理`);
    }
    if (!running) {
      record('watch', `${catName}：已停且无新回复，静默`);
      return { ok: true, sent: 'none' };
    }
    const gap = Date.now() - prev.at;
    if (gap < PROGRESS_COOLDOWN_MS) {
      record('watch', `${catName}：播报静默（距上次发群 ${Math.round(gap / 1000)} 秒，冷却 ${Math.round(PROGRESS_COOLDOWN_MS / 1000)} 秒）`);
      return { ok: true, sent: 'none', reason: 'cooldown' };
    }
    // 🔴 读全（Rushiera 2026-10-14）：先**现场拉取**该猫的整幅视图（think + 工具调用 + 旁白 + 直播态）——
    //    不依赖常驻订阅健康（订阅断了也读得到）；拉取失败回落常驻环；两路全空才走截图 + 视觉判读。
    let digest = null;
    let source = '';
    try {
      const pulled = await pullCatView(resolvedKey);
      if (pulled) {
        digest = digestFromView(pulled.items, pulled.live);
        source = 'pull';
      }
    } catch (error) {
      record('error', `播报（${key}）：现场拉取异常（${error?.message ?? error}）`);
    }
    const emptyDigest = (d) => !d || (d.thinks.length === 0 && d.tools.length === 0 && d.gaps.length === 0
      && !d.liveThink && !d.liveTool && !d.liveReply);
    if (emptyDigest(digest)) {
      const ring = digestFromSession(resolvedKey);
      if (!emptyDigest(ring)) {
        digest = ring;
        source = 'ring';
      }
    }
    const activity = await composeActivity(digest);
    if (activity) {
      record('watch', `${catName}：播报素材 = ${source === 'pull' ? '现场拉取' : '常驻环'}（think ${digest?.thinks?.length ?? 0} / 工具 ${digest?.tools?.length ?? 0} / 旁白 ${digest?.gaps?.length ?? 0}${digest?.liveThink ? ' / 直播思考' : ''}${digest?.liveTool ? ' / 进行中工具' : ''}）`);
    }
    let insight = '';
    if (!activity) {
      // 兜底：截图 + 视觉判读（读不到 think / 工具时才走——慢、贵、二手）
      try {
        const png = await shot.shoot({ catName, blocks: replyBlocksOf(rows), at: new Date().toLocaleString('zh-CN', { hour12: false }) });
        if (png) insight = await shot.analyze(png, PROGRESS_QUESTION);
      } catch (error) {
        record('error', `播报（${key}）：判读失败（${error?.message ?? error}）——仅发事实`);
      }
    }
    const head = `⏳ ${catName} 还在跑${label}，尚未回复`;
    const body = [head, progressFacts(rows), activity || insight]
      .filter((line) => String(line ?? '').trim()).join('\n');
    const sent = await sayAt(target, body, vipUser);
    if (sent.ok) {
      sentLog.set(key, { at: Date.now(), kind: 'progress', replyAt: prev.replyAt });
      voyageStats.progress += 1;
    }
    record(sent.ok ? 'send' : 'error', sent.ok
      ? `进度播报已发群 ${target}（${catName}·@触发者）`
      : `进度播报发送失败：${sent.error}`);
    return { ok: sent.ok, sent: 'progress' };
  }

  /**
   * 检查点——抓该猫会话交给出站决策（投递后 / 整理后 / 手动触发共用）。
   *
   * @param {string} key 猫 key
   * @param {string|null} chat 回报群
   * @param {string} [reason] 标签
   * @returns {Promise<object>} 决策结果
   */
  async function runAnalysis(key, chat, reason = '') {
    let items = [];
    try {
      const info = await ch4.keyinfo(key, 20);
      items = Array.isArray(info?.items) ? info.items : [];
    } catch (error) {
      record('error', `出站（${key}）：拉会话失败（${error?.message ?? error}）`);
      return { ok: false, sent: 'none', error: 'keyinfo' };
    }
    if (items.length === 0) {
      record('watch', `出站（${key}）：会话为空，跳过`);
      return { ok: true, sent: 'none' };
    }
    return emitOutbound({ key, chat, trigger: 'checkpoint', items, reason });
  }

  /**
   * 触发一次猫会话分析——`delayMs > 0` 排队，否则立即执行。
   *
   * 独立入口（API / 其他功能都走这里），核心逻辑仍归 `scheduleAnalysis` + `runAnalysis`。
   *
   * @param {object} options 选项
   * @param {string} options.key 猫 key
   * @param {string|number|null} [options.chat] 回报群
   * @param {number} [options.delayMs] 延迟毫秒（0 = 立即）
   * @param {string} [options.reason] 触发来源标签
   * @returns {Promise<object>} 受理结果
   */
  async function analyzeOnce({ key, chat = null, delayMs = 0, reason = '' }) {
    if (delayMs > 0) {
      scheduleAnalysis(key, chat, { delayMs, reason });
      return { ok: true, scheduled: true, key, delayMs, reason };
    }
    runAnalysis(key, chat, reason).catch((error) => record('error', `会话分析（${key}）失败：${error?.message ?? error}`));
    return { ok: true, accepted: true, key, reason };
  }

  /**
   * 截取某只猫的当前会话卡（可选发群）——与开场巡检同款渲染。
   *
   * 用途：群里 @ 说「截一下 X 的会话」时，产出**会话卡截图**（CH4 会话页同款对话气泡卡），
   * 不是浏览器开网页截的图。只读——只画会话，**不给猫发消息、不改它的前文**。
   *
   * @param {object} options 选项
   * @param {string} [options.key] 猫 key
   * @param {string|number|null} [options.chat] 回报群（空 = 按新鲜 VIP 群消息解析）
   * @param {Array<object>|null} [options.blocks] 显式块（测试用；空 = 拉该猫会话）
   * @param {boolean} [options.send] 是否发群（false = 只出图，返回路径）
   * @returns {Promise<object>} { ok, file?, blockCount?, insight?, sent?, error? }
   */
  async function shotSession({ key = 'majordomo', chat = null, blocks = null, send = false } = {}) {
    let resolved = String(key || 'majordomo').trim() || 'majordomo';
    try {
      resolved = (await ch4.resolveKey(resolved)) || resolved;
    } catch { /* 解析失败按原值 */ }
    const catName = await catNameOf(resolved);
    let useBlocks = Array.isArray(blocks) && blocks.length ? blocks : null;
    if (!useBlocks) {
      try {
        const info = await ch4.keyinfo(resolved, Math.max(20, Number(navConfig.shotKeyinfoMax) || 80));
        useBlocks = itemsToBlocks(Array.isArray(info?.items) ? info.items : [], 0);
      } catch (error) {
        record('error', `会话截图（${resolved}）：拉会话失败（${error?.message ?? error}）`);
        return { ok: false, error: `拉 ${catName} 的会话失败：${error?.message ?? error}` };
      }
    }
    if (!useBlocks || useBlocks.length === 0) {
      return { ok: false, error: `${catName} 的会话是空的——没有可截的内容` };
    }
    let png;
    try {
      png = await shot.shoot({ catName, blocks: useBlocks, at: new Date().toLocaleString('zh-CN', { hour12: false }) });
    } catch (error) {
      record('error', `会话截图（${resolved}）：渲染失败（${error?.message ?? error}）`);
      return { ok: false, error: `渲染截图失败：${error?.message ?? error}` };
    }
    const result = { ok: true, file: png, blockCount: useBlocks.length };
    if (send) {
      const target = resolveChat(chat);
      if (!target) return { ok: false, error: '没有回消息群——先在群里说一句', file: png };
      const insight = await shot.analyze(png);
      result.insight = insight;
      const caption = insight ? `${catName} 的会话：\n${insight}` : `${catName} 的会话`;
      const sent = await sayImage(target, png, caption);
      result.sent = sent.ok;
      record(sent.ok ? 'send' : 'error', sent.ok
        ? `会话截图已发群 ${target}（${catName}）`
        : `会话截图发送失败（${sent.error}）`);
      if (!sent.ok) result.error = sent.error;
    }
    return result;
  }

  /**
   * 为一只猫建立（或修复）持久观测——领航员开启期间常驻（任何一轮回复都截图发群，无例外）。
   *
   * 断线自愈（2026-10-14）：已有会话但订阅已断（watcher 无该 key）→ 就地重连——
   * 不重建会话对象（think / 工具环保留，重连后的全量帧经去重补齐）。
   *
   * @param {object} row 猫状态（cat 清单条目）
   * @returns {Promise<object|null>} 观测会话
   */
  async function armCat(row) {
    const key = String(row?.id ?? '');
    if (!key) return null;
    const existing = sessions.get(key);
    if (existing && watcher.list().includes(key)) return existing;
    const port = Number(row?.port) || await ch4.portOf(key);
    if (!port) {
      record('error', `未取到 ${key} 的对话端口，跳过观测`);
      return null;
    }
    if (existing) {
      // 断线重连——保留已收集的环，只换连接与轮询
      if (existing.pollTimer) clearInterval(existing.pollTimer);
      existing.port = port;
      existing.done = false;
      existing.startedAt = Date.now();
      existing.sawRun = false;
      existing.blocks = [];
      await watcher.subscribe({
        key,
        port,
        onEvent: (frame) => onCatEvent(existing, frame),
        onClose: () => { /* 持久观测：断线不自动重连（ensureWatching 巡检会补） */ }
      });
      existing.pollTimer = setInterval(() => {
        pollRoundEnd(existing).catch(() => { /* 内部已留痕 */ });
      }, POLL_INTERVAL_MS);
      record('watch', `重连 ${existing.name}（端口 ${port}）`);
      return existing;
    }
    const session = {
      key, name: String(row?.name || key), port, chat: null,
      blocks: [], thinks: [], thinkSeen: new Set(),
      tools: [], toolSeen: new Set(), gaps: [], gapSeen: new Set(),
      liveThink: null, liveTool: null, liveReply: null,
      startedAt: Date.now(), sawRun: false, pollTimer: null, done: false
    };
    sessions.set(key, session);
    await watcher.subscribe({
      key,
      port,
      onEvent: (frame) => onCatEvent(session, frame),
      onClose: () => { /* 持久观测：断线不自动重连（ensureWatching 巡检会补） */ }
    });
    session.pollTimer = setInterval(() => {
      pollRoundEnd(session).catch(() => { /* 内部已留痕 */ });
    }, POLL_INTERVAL_MS);
    // 出站基线：以当前最后一条回复为起点——重启后不把历史回复当「新回复」再发一遍
    try {
      const info = await ch4.keyinfo(key, 12);
      const rows = Array.isArray(info?.items) ? info.items : [];
      const last = [...rows].reverse().find((row) => String(row?.role ?? '') === 'reply');
      sentLog.set(key, { at: 0, kind: '', replyAt: Number(last?.time ?? 0) || 0 });
    } catch (error) {
      record('error', `${session.name}：出站基线取不到（${error?.message ?? error}）——首轮可能多一次截图`);
    }
    record('watch', `订阅 ${session.name}（端口 ${port}）`);
    return session;
  }

  /**
   * 对全部运行中的猫建立持久观测。
   *
   * @returns {Promise<number>} 订阅数
   */
  async function armAll() {
    const cats = await ch4.cats();
    for (const row of cats) {
      if (!row?.running) continue;
      try {
        await armCat(row);
      } catch (error) {
        record('error', `订阅 ${row?.name ?? row?.id} 失败：${error?.message ?? error}`);
      }
    }
    record('watch', `持久观测就绪（${sessions.size} 只猫）——任何一轮回复都会截图发群`);
    return sessions.size;
  }

  /**
   * 补订阅巡检——对所有运行中的猫确保观测在线（断线重连 / 漏订补建）。
   *
   * 触发：空闲守护每 60 秒一次；投递成功时对目标猫即时补一次。
   * 判据：`watcher.list()` 是订阅存活唯一真相——不在列表里的（含断线后被清出）即补。
   *
   * @returns {Promise<number>} 观测会话数
   */
  async function ensureWatching() {
    let cats = [];
    try {
      cats = await ch4.cats();
    } catch (error) {
      record('error', `补订阅巡检失败：CH4 不可达（${error?.message ?? error}）`);
      return sessions.size;
    }
    for (const row of cats) {
      if (!row?.running) continue;
      const key = String(row?.id ?? '');
      if (!key || watcher.list().includes(key)) continue;
      try {
        await armCat(row);
      } catch (error) {
        record('error', `补订阅 ${key} 失败：${error?.message ?? error}`);
      }
    }
    return sessions.size;
  }

  /** 撤除全部观测（含未到点的会话分析定时器）。 */
  function disarmAll() {
    for (const session of sessions.values()) {
      session.done = true;
      if (session.pollTimer) clearInterval(session.pollTimer);
      watcher.unwatch(session.key);
    }
    sessions.clear();
    for (const timer of analyzeTimers.values()) clearTimeout(timer);
    analyzeTimers.clear();
  }

  /**
   * 兜底轮询：看该猫会话末尾是否已出现「本次投递之后」的轮结算行。
   *
   * @param {object} session 观测会话
   * @returns {Promise<void>} 完成
   */
  async function pollRoundEnd(session) {
    if (session.done) return;
    const info = await ch4.keyinfo(session.key, 3);
    const items = Array.isArray(info?.items) ? info.items : [];
    const last = items[items.length - 1];
    if (last?.role === 'roundsum' && Number(last.time) >= session.startedAt - 2000) {
      await finishSession(session);
    }
  }

  /**
   * 关键信息条目 → 对话卡块（role → renderType）。
   *
   * @param {Array<object>} items keyinfo 条目
   * @param {number} since 起点时刻（取此后的条目；找不到起点则取末尾若干条）
   * @returns {Array<object>} 块
   */
  function itemsToBlocks(items, since) {
    const rows = Array.isArray(items) ? items : [];
    let start = rows.findIndex((row) => row?.role === 'user' && Number(row.time) >= since - 2000);
    if (start < 0) start = Math.max(0, rows.length - 6);
    return rows.slice(start)
      .map((row) => {
        const role = String(row?.role ?? '');
        const type = role === 'user' || role === 'roundsum' ? role : 'text';
        return { renderType: type, text: String(row?.content ?? row?.preview ?? '') };
      })
      .filter((row) => row.text.trim().length > 0);
  }

  /**
   * 会话条目 → 原文轨迹文本（前文整理重启用——留存用户原话与猫的回复原文）。
   *
   * 交接摘要由猫自己写、必然有取舍；原文轨迹是客观留存。两者一起注入才能保住延续性
   * （Rushiera 2026-10-11：「重启结果应优先确保当前会话内容的延续性」）。
   *
   * @param {Array<object>} items keyinfo 条目
   * @param {number} limit 取末尾条数上限
   * @returns {string} 轨迹文本（无内容时为空串）
   */
  function traceText(items, limit) {
    const rows = Array.isArray(items) ? items : [];
    const keep = ['user', 'reply', 'roundsum'];
    return rows
      .filter((row) => keep.includes(String(row?.role ?? '')))
      .slice(Number(limit) > 0 ? -Number(limit) : 0)
      .map((row) => {
        const role = String(row?.role ?? '');
        const tag = role === 'user' ? '用户' : role === 'reply' ? '我' : '轮结算';
        const text = String(row?.content ?? row?.preview ?? '').trim();
        if (!text) return '';
        const body = role === 'reply' && text.length > RESET_TRACE_REPLY_MAX
          ? `${text.slice(0, RESET_TRACE_REPLY_MAX)}…（后略）`
          : text;
        return `[${tag}] ${body}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * 完整前文条目 → 正文文本 + 时间→位置表（抢救模式代读用；Rushiera 2026-10-14 定）。
   *
   * 条目顺序拼接（每条带 `【#i 角色 时间】` 头，位置可回查）；`system` 注入块不入正文——
   * 接手方自带同类知识文件，且它会吃掉头 30% 额度（头要留给任务背景）。
   *
   * @param {Array<object>} items fullctx 条目
   * @returns {{ text: string, marks: Map<string, {i: number, offset: number}> }} 正文 + 时间→位置表
   */
  function fullContextText(items) {
    const rows = Array.isArray(items) ? items : [];
    const parts = [];
    const marks = new Map();
    let offset = 0;
    for (const row of rows) {
      const role = String(row?.role ?? '');
      if (role === 'system') continue;
      const body = String(row?.content ?? row?.preview ?? '').trim();
      if (!body) continue;
      const i = Number(row?.i) || 0;
      const when = Number(row?.time)
        ? new Date(Number(row.time)).toLocaleString('zh-CN', { hour12: false })
        : '';
      const block = `【#${i} ${roleTag(role)}${when ? ` ${when}` : ''}】\n${body}`;
      const key = String(row?.time ?? '');
      if (key && !marks.has(key)) marks.set(key, { i, offset });
      parts.push(block);
      offset += block.length + 2;
    }
    return { text: parts.join('\n\n'), marks };
  }

  /**
   * 条目角色标签——正文头与索引行共用。
   *
   * @param {string} role 角色（user / assistant / tool / system / report / reply / roundsum）
   * @returns {string} 中文标签
   */
  function roleTag(role) {
    if (role === 'user') return '用户';
    if (role === 'assistant' || role === 'reply') return '猫';
    if (role === 'tool') return '工具';
    if (role === 'roundsum') return '轮结算';
    if (role === 'report') return '加载报告';
    if (role === 'system') return '注入';
    return role || '条目';
  }

  /**
   * 会话关键信息索引——正文的目录（每条一行：正文位置 / 角色 / 时间 / 首段）。
   *
   * 位置 = 该条在**正文**中的条号与起始字符（按未截断的正文计）；正文超限砍中段时，
   * 落在被省略段的关键条标「⚠中段已省略」——救援猫据此知道「哪一条在哪、讲了什么」，
   * 需要细节按位置回查（Rushiera 2026-10-14 定）。
   *
   * @param {Array<object>} items keyinfo 条目
   * @param {Map<string, {i: number, offset: number}>} marks 时间→正文位置表（fullContextText 产出）
   * @param {{ truncated: boolean, headLen: number, tailStart: number }} cut 正文截断信息
   * @param {number} [maxChars] 每条首段截断长度
   * @returns {string} 索引文本（无内容时为空串）
   */
  function keyIndex(items, marks, cut, maxChars = 120) {
    const rows = Array.isArray(items) ? items : [];
    const keep = ['report', 'user', 'reply', 'roundsum'];
    const lines = [];
    let pos = 0;
    for (const row of rows) {
      const role = String(row?.role ?? '');
      if (!keep.includes(role)) continue;
      pos += 1;
      const text = String(row?.content ?? row?.preview ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const when = Number(row?.time)
        ? new Date(Number(row.time)).toLocaleString('zh-CN', { hour12: false })
        : '';
      const brief = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
      const hit = marks.get(String(row?.time ?? ''));
      let where = '正文位置未定位';
      if (hit) {
        const omitted = cut.truncated && hit.offset >= cut.headLen && hit.offset < cut.tailStart;
        where = `正文 #${hit.i}（第 ${group(hit.offset)} 字符起）${omitted ? '·⚠中段已省略' : ''}`;
      }
      lines.push(`[${pos}] ${roleTag(role)}${when ? ` ${when}` : ''} —— ${where} —— ${brief}`);
    }
    return lines.join('\n');
  }

  /**
   * 播报事实行——未回复时给「接的什么活 / 有没有产出」（判读之外的确定性信息）。
   *
   * @param {Array<object>} items keyinfo 条目
   * @returns {string} 文本（每行一条，无内容返回空串）
   */
  function progressFacts(items) {
    const rows = Array.isArray(items) ? items : [];
    const lastUser = [...rows].reverse().find((row) => String(row?.role ?? '') === 'user');
    const lastReply = [...rows].reverse().find((row) => String(row?.role ?? '') === 'reply');
    const clip = (text, n) => {
      const s = String(text ?? '').replace(/\s+/g, ' ').trim();
      return s.length > n ? `${s.slice(0, n)}…` : s;
    };
    const lines = [];
    if (lastUser) lines.push(`· 接的活：${clip(lastUser.content ?? lastUser.preview, 80)}`);
    lines.push(lastReply ? `· 最近产出：${clip(lastReply.content ?? lastReply.preview, 80)}` : '· 还没有产出');
    return lines.join('\n');
  }

  /**
   * 会话条目 → 回复截图块（只留最后一条回复及其后的轮结算——截图截的是回复内容）。
   *
   * @param {Array<object>} items keyinfo 条目
   * @returns {Array<object>} 块
   */
  function replyBlocksOf(items) {
    const rows = Array.isArray(items) ? items : [];
    const idx = rows.map((row) => String(row?.role ?? '')).lastIndexOf('reply');
    if (idx < 0) return itemsToBlocks(rows, 0);
    return rows.slice(idx)
      .filter((row) => ['reply', 'roundsum'].includes(String(row?.role ?? '')))
      .map((row) => ({
        renderType: String(row?.role ?? '') === 'roundsum' ? 'roundsum' : 'text',
        text: String(row?.content ?? row?.preview ?? '')
      }))
      .filter((row) => row.text.trim().length > 0);
  }

  /**
   * 从 view 事件载荷里收集活动素材——思考（reason）/ 工具卡（toolcard）/ 旁白（gap_text）/
   * 直播态（live）——会话分析的数据源（常驻环）。
   *
   * 载荷两态都认：`persist.items[]`（视图状态 · full / append 两种 mode）/ 顶层 `renderType`（单块推送）。
   * 🔴 条目正文在生产形态里位于 `item.payload`（`{type, ts, msgIndex, round, payload:{text | name,arguments,result}}`）——
   *    v0.45 首版误读 `item.text`，生产从未收集到（自测喂的是旧形态）；本版修正（2026-10-14）。
   * 只做留存与去重，**不做判读**——取用归 `thinkText` / `digestFromSession` / `composeActivity`。
   *
   * @param {object} session 观测会话
   * @param {object} data view 事件载荷
   * @returns {void}
   */
  function collectThink(session, data) {
    if (!session) return;
    const items = Array.isArray(data?.persist?.items) ? data.persist.items : [data];
    for (const item of items) {
      const type = String(item?.type ?? item?.renderType ?? '');
      const payload = item?.payload ?? {};
      const ts = Number(item?.ts ?? 0) || Date.now();
      if (type === 'reason') {
        const text = String(payload.text ?? item?.text ?? '').trim(); // payload 生产形态；item.text 兼容旧自测
        if (!text || session.thinkSeen.has(text)) continue;
        session.thinkSeen.add(text);
        session.thinks.push({ ts, text });
        while (session.thinks.length > THINK_KEEP) {
          const dropped = session.thinks.shift();
          if (dropped) session.thinkSeen.delete(dropped.text);
        }
      } else if (type === 'toolcard') {
        const name = String(payload.name ?? '').trim();
        if (!name) continue;
        const dedupe = `${ts}:${name}:${payload.toolIndex ?? 0}`;
        if (session.toolSeen.has(dedupe)) continue;
        session.toolSeen.add(dedupe);
        session.tools.push({
          ts, name,
          args: String(payload.arguments ?? ''),
          result: String(payload.result ?? ''),
          durMs: Number(payload.durMs ?? -1),
          dedupe
        });
        while (session.tools.length > TOOL_KEEP) {
          const dropped = session.tools.shift();
          if (dropped) session.toolSeen.delete(dropped.dedupe);
        }
      } else if (type === 'gap_text') {
        const text = String(payload.text ?? '').trim();
        if (!text || session.gapSeen.has(text)) continue;
        session.gapSeen.add(text);
        session.gaps.push({ ts, text });
        while (session.gaps.length > GAP_KEEP) {
          const dropped = session.gaps.shift();
          if (dropped) session.gapSeen.delete(dropped.text);
        }
      }
    }
    // 直播态（临时区 · 整段覆盖）——thinksse / toolrun / replysse / empty（A196 白名单）
    const live = data?.live;
    if (live && typeof live === 'object' && typeof live.type === 'string') {
      const context = String(live.context ?? '');
      if (live.type === 'thinksse') session.liveThink = { at: Date.now(), text: context };
      else if (live.type === 'toolrun') session.liveTool = { at: Date.now(), raw: context };
      else if (live.type === 'replysse') session.liveReply = { at: Date.now(), text: context };
      else if (live.type === 'empty') {
        session.liveThink = null;
        session.liveTool = null;
        session.liveReply = null;
      }
    }
  }

  /**
   * 取某猫最近的思考文本（think 块）——会话分析的「直接读 think」出口。
   *
   * @param {string} key 猫 key
   * @param {object} [options] 选项
   * @param {number} [options.max] 取末尾条数
   * @param {number} [options.maxChars] 正文上限（字符）
   * @returns {string} 思考正文（无则空串）
   */
  function thinkText(key, { max = 3, maxChars = 1200 } = {}) {
    const session = sessions.get(String(key));
    const list = Array.isArray(session?.thinks) ? session.thinks : [];
    const picked = list.slice(-Math.max(1, max)).map((row) => String(row?.text ?? '').trim()).filter(Boolean);
    if (picked.length === 0) return '';
    const text = picked.join('\n…\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /**
   * 文本截断（超出加省略号）。
   *
   * @param {string} text 原文
   * @param {number} n 上限字符数
   * @returns {string} 截断结果
   */
  function clipText(text, n) {
    const s = String(text ?? '').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  /**
   * 工具参数摘要——从 arguments JSON 里挑一个最能说明「在干什么」的字段。
   *
   * @param {string} argsJson 参数 JSON 原文
   * @returns {string} 摘要（≤80 字符）
   */
  function toolArgBrief(argsJson) {
    const raw = String(argsJson ?? '').trim();
    if (!raw) return '';
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        const order = ['command', 'path', 'file', 'pattern', 'keyword', 'key', 'proj', 'class', 'member', 'text', 'url', 'query', 'expression', 'name'];
        for (const k of order) {
          const v = obj[k];
          if (v !== undefined && v !== null && String(v).trim()) return clipText(String(v).replace(/\s+/g, ' '), 80);
        }
        for (const v of Object.values(obj)) {
          if (typeof v === 'string' && v.trim()) return clipText(v.replace(/\s+/g, ' '), 80);
        }
      }
    } catch { /* 非 JSON——原样截断 */ }
    return clipText(raw.replace(/\s+/g, ' '), 80);
  }

  /**
   * 解析直播态 toolrun 的 context（未完成工具卡数组 JSON）。
   *
   * @param {string} raw context 原文
   * @returns {Array<{name: string, brief: string}>} 进行中的工具
   */
  function parseToolRun(raw) {
    try {
      const arr = JSON.parse(String(raw ?? ''));
      if (!Array.isArray(arr)) return [];
      return arr.map((row) => ({
        name: String(row?.name ?? '?'),
        brief: toolArgBrief(String(row?.arguments ?? ''))
      }));
    } catch {
      return [];
    }
  }

  /**
   * 现场拉取某猫的视图截面——一次性连它的 SSE，取首帧（全量：persist.items + live）即断。
   *
   * 为什么不用常驻环独担（Rushiera 2026-10-14「让他读全一点」）：常驻订阅会断线（CH4 重启 /
   * 端口变更），断线期间环停更——会话分析就只剩「回复 + 用户输入」。现场拉取不依赖订阅健康：
   * 任何时候都拿到「此刻的整幅视图」（think / 工具卡 / 旁白 / 直播态）。
   *
   * @param {string} key 猫 key
   * @param {object} [options] 选项
   * @param {number} [options.timeoutMs] 首帧等待上限（毫秒）
   * @returns {Promise<object|null>} { items, live }（取不到为 null）
   */
  async function pullCatView(key, { timeoutMs = PULL_TIMEOUT_MS } = {}) {
    let port = 0;
    try {
      port = await ch4.portOf(key);
    } catch (error) {
      record('error', `现场拉取（${key}）：端口解析失败（${error?.message ?? error}）`);
      return null;
    }
    if (!port) {
      record('error', `现场拉取（${key}）：端口为空，跳过`);
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) continue;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (event !== 'view' || dataLines.length === 0) continue; // 首帧可能是 snapshot——继续等 view
        let data = null;
        try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (!data || !data.persist) continue; // 要的是带 persist 的全量帧
        try { await reader.cancel(); } catch { /* 流已关 */ }
        return { items: Array.isArray(data.persist.items) ? data.persist.items : [], live: data.live ?? null };
      }
      return null;
    } catch (error) {
      record('error', `现场拉取（${key}）失败：${error?.message ?? error}`);
      return null;
    } finally {
      clearTimeout(timer);
      try { controller.abort(); } catch { /* 已关 */ }
    }
  }

  /**
   * 视图条目 → 活动摘要（会话分析的数据源归一化——现场拉取与常驻环共用同一形状）。
   *
   * @param {Array<object>} items 视图条目（{type, ts, payload}）
   * @param {object|null} [live] 临时区（{type, context}）
   * @returns {object} { thinks, tools, gaps, liveThink, liveTool, liveReply }
   */
  function digestFromView(items, live = null) {
    const rows = Array.isArray(items) ? items : [];
    const thinks = [];
    const tools = [];
    const gaps = [];
    const seenThink = new Set();
    const seenTool = new Set();
    const seenGap = new Set();
    for (const item of rows) {
      const type = String(item?.type ?? item?.renderType ?? '');
      const payload = item?.payload ?? {};
      const ts = Number(item?.ts ?? 0) || 0;
      if (type === 'reason') {
        const text = String(payload.text ?? item?.text ?? '').trim();
        if (text && !seenThink.has(text)) {
          seenThink.add(text);
          thinks.push({ ts, text });
        }
      } else if (type === 'toolcard') {
        const name = String(payload.name ?? '').trim();
        if (!name) continue;
        const dedupe = `${ts}:${name}:${payload.toolIndex ?? 0}`;
        if (seenTool.has(dedupe)) continue;
        seenTool.add(dedupe);
        tools.push({
          ts, name,
          args: String(payload.arguments ?? ''),
          result: String(payload.result ?? ''),
          durMs: Number(payload.durMs ?? -1)
        });
      } else if (type === 'gap_text') {
        const text = String(payload.text ?? '').trim();
        if (text && !seenGap.has(text)) {
          seenGap.add(text);
          gaps.push({ ts, text });
        }
      }
    }
    const digest = { thinks, tools, gaps, liveThink: null, liveTool: null, liveReply: null };
    if (live && typeof live === 'object') {
      const at = Date.now();
      const context = String(live.context ?? '');
      if (live.type === 'thinksse' && context.trim()) digest.liveThink = { at, text: context };
      else if (live.type === 'toolrun' && context.trim()) digest.liveTool = { at, raw: context };
      else if (live.type === 'replysse' && context.trim()) digest.liveReply = { at, text: context };
    }
    return digest;
  }

  /**
   * 常驻环 → 活动摘要（现场拉取失败时的回落数据源）。
   *
   * @param {string} key 猫 key（已解析 id）
   * @returns {object|null} 活动摘要（无会话时 null）
   */
  function digestFromSession(key) {
    const session = sessions.get(String(key));
    if (!session) return null;
    return {
      thinks: session.thinks.slice(-12),
      tools: session.tools.slice(-12),
      gaps: session.gaps.slice(-4),
      liveThink: session.liveThink,
      liveTool: session.liveTool,
      liveReply: session.liveReply
    };
  }

  /**
   * 思考原文 → 播报用的中文摘要（同一段思考走缓存；摘要不可用时回落原文截断）。
   *
   * @param {string} text 思考原文
   * @returns {Promise<string>} 摘要文本
   */
  async function summarizeThink(text) {
    const source = String(text ?? '').trim();
    if (!source) return '';
    if (summaryConf.enabled === false) return clipText(source, THINK_FALLBACK_MAX);
    const cached = thinkSummaryCache.get(source);
    if (cached) return cached;
    let brief = '';
    try {
      brief = await summarize(source, {
        model: summaryConf.model,
        timeoutMs: Number(summaryConf.timeoutMs) || undefined,
        maxTokens: Number(summaryConf.maxTokens) || undefined,
        maxChars: Number(summaryConf.maxChars) || undefined
      });
    } catch (error) {
      record('error', `think 摘要异常：${error?.message ?? error}——回落原文截断`);
    }
    if (!brief) {
      record('watch', 'think 摘要为空——回落原文截断');
      return clipText(source, THINK_FALLBACK_MAX);
    }
    const clipped = clipText(String(brief).replace(/\s+/g, ' ').trim(), THINK_SUMMARY_MAX);
    thinkSummaryCache.set(source, clipped);
    if (thinkSummaryCache.size > THINK_SUMMARY_CACHE_MAX) {
      const oldest = thinkSummaryCache.keys().next().value;
      if (oldest !== undefined) thinkSummaryCache.delete(oldest);
    }
    return clipped;
  }

  /**
   * 活动摘要 → 播报文本（会话分析正文）。
   *
   * 组成（Rushiera 2026-10-14「让他读全一点」）：它现在在想（直播态 → 最近思考）·
   * 最近工具调用（含进行中）· 最近旁白 · 正在写回复。全空返回空串（调用方走截图兜底）。
   *
   * 🔴 think 段走**摘要**（Rushiera 2026-10-14 定）：思考原文是模型的推理流（常夹英文、
   *    多转折、上千字），整段贴群不可读——交 LLM 压成两三句中文；摘要不可用时回落原文截断。
   *
   * @param {object} digest 活动摘要
   * @returns {Promise<string>} 文本（无内容时为空串）
   */
  async function composeActivity(digest) {
    if (!digest) return '';
    const lines = [];
    const fresh = (at) => at && Date.now() - at <= LIVE_FRESH_MS;
    // ① 思考——直播态新鲜优先；否则最近一条完成的思考块（取最新一条：块很长，取多条会把最新那条挤出视野）
    const liveThink = digest.liveThink && fresh(digest.liveThink.at) ? String(digest.liveThink.text ?? '').trim() : '';
    const lastThink = digest.thinks.length > 0 ? String(digest.thinks[digest.thinks.length - 1].text ?? '').trim() : '';
    const thinkSource = liveThink || lastThink;
    if (thinkSource) {
      lines.push(`· ${liveThink ? '它现在在想' : '它最近在想'}：\n${await summarizeThink(thinkSource)}`);
    }
    // ② 工具调用——最近 6 次 + 进行中（直播态 toolrun）
    const recent = digest.tools.slice(-6);
    const running = digest.liveTool && fresh(digest.liveTool.at) ? parseToolRun(digest.liveTool.raw) : [];
    if (recent.length > 0 || running.length > 0) {
      const toolLines = recent.map((row) => {
        const time = row.ts ? new Date(row.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
        const result = String(row.result ?? '').trim();
        const failed = result.startsWith('ERR|');
        const brief = toolArgBrief(row.args);
        const err = failed ? ` · ${clipText(result.replace(/\s+/g, ' '), 60)}` : '';
        return `  [${time}] ${row.name} ${failed ? '✗' : '✓'}${brief ? ` · ${brief}` : ''}${err}`;
      });
      for (const row of running) {
        toolLines.push(`  ▶ ${row.name}（进行中）${row.brief ? ` · ${row.brief}` : ''}`);
      }
      lines.push(`· 最近工具调用${recent.length > 0 ? `（近 ${recent.length} 次）` : '（进行中）'}：\n${toolLines.join('\n')}`);
    }
    // ③ 旁白——最近一条（近 10 分钟内）
    const gap = digest.gaps[digest.gaps.length - 1];
    if (gap && (!gap.ts || Date.now() - gap.ts <= 10 * 60 * 1000)) {
      lines.push(`· 最近旁白：${clipText(String(gap.text).replace(/\s+/g, ' '), 120)}`);
    }
    // ④ 正在写回复（直播态 replysse）
    if (digest.liveReply && fresh(digest.liveReply.at)) {
      lines.push(`· 正在写回复（约 ${String(digest.liveReply.text).length} 字，尚未发出）`);
    }
    return lines.join('\n');
  }

  /**
   * 猫事件处理——累积视图块，遇轮结束触发收尾。
   *
   * @param {object} session 观测会话
   * @param {object} frame SSE 帧
   * @returns {void}
   */
  function onCatEvent(session, frame) {
    if (session.done) return;
    // ① 运行态事件：run → idle 即本轮结束（每猫端口的主判据）
    if (frame?.event === 'sessionstate' && frame.data) {
      const state = String(frame.data.runState ?? '');
      if (state === 'idle') {
        if (session.sawRun) {
          finishSession(session).catch((error) => log.error('navigator', `收尾失败：${error?.message ?? error}`));
        }
      } else {
        session.sawRun = true;
      }
      return;
    }
    if (frame?.event !== 'view' || !frame.data) {
      // 非 view 事件只记少见类型（snapshot 每 250ms 一帧 / log 高频，全记会把活动流刷没）
      if (frame?.event && frame.event !== 'snapshot' && frame.event !== 'log') {
        record('event', `${session.key} ← ${frame.event}`);
      }
      return;
    }
    // ② view 事件：载荷两态——a) 视图状态 {v, state, persist:{items[]}, live}（每猫端口实测形态，
    //    渲染块在 persist.items：inject_report / user / reason / toolcard…）b) 单块推送 {renderType, text}。
    //    reason 块 = 猫的思考正文——**直接读 think**（会话分析数据源；不再靠截图 + 视觉判读）。
    collectThink(session, frame.data);
    if (!Object.prototype.hasOwnProperty.call(frame.data, 'renderType')) return;
    const type = String(frame.data.renderType ?? '');
    if (type !== 'stream' && type !== 'reason') {
      const brief = String(frame.data.text ?? '').replace(/\s+/g, ' ').slice(0, 40);
      record('event', `${session.key} ← view/${type || '?'}${type === 'roundsum' ? '' : `（${brief}）`}`);
    }
    if (type === 'roundsum') {
      finishSession(session).catch((error) => log.error('navigator', `收尾失败：${error?.message ?? error}`));
      return;
    }
    if (BLOCK_TYPES.includes(type)) session.blocks.push(frame.data);
  }

  /**
   * 轮结束收尾——拉会话条目交给出站决策（有回复才截图发群，没信息就静默）。
   *
   * @param {object} session 观测会话
   * @returns {Promise<void>} 完成
   */
  async function finishSession(session) {
    if (session.done) return;
    // 立刻推进观测点——本轮内容归本次，下一轮从此刻起算（持久观测不撤订）
    session.startedAt = Date.now();
    session.sawRun = false;
    session.blocks = [];
    // 唤醒等「本轮回复」的等待器（前文整理重启）——「群里转发回复」的那一刻就是轮结束
    notifyRoundEnd(session.key);
    let items = [];
    try {
      const info = await ch4.keyinfo(session.key, 12);
      items = Array.isArray(info?.items) ? info.items : [];
    } catch (error) {
      record('error', `拉 ${session.name} 会话关键信息失败：${error?.message ?? error}`);
    }
    const chat = resolveChat(session.chat) ?? state.snapshot().activeChat;
    // 猫有动静即算活动——空闲暂关的计时归零（有回复就不算空闲）
    state.touch();
    await emitOutbound({ key: session.key, chat, trigger: 'roundEnd', items });
  }

  // ── 动作 ──────────────────────────────────────────────────────────────────

  /**
   * 开启领航员（可选：立即回执到指定群）。
   *
   * @param {object} options 选项
   * @param {string} [options.by] 来源（app / qq）
   * @param {string|number} [options.chat] 下指令的群
   * @param {boolean} [options.receipt] 是否发回执（默认 true）
   * @param {boolean} [options.requireVip] 是否要求近期有 VIP 群消息
   * @returns {Promise<object>} { ok, alreadyOpen?, state, health?, receipt? }——已开启时幂等返回，不重发
   */
  async function open({ by = 'app', chat = null, receipt = true, requireVip = false } = {}) {
    if (requireVip && !vipFresh()) {
      return { ok: false, error: `${vipUser || '指定 QQ'} 近期没有在本群 @ 我——领航员只接受该 QQ 触发` };
    }
    // 🔴 幂等（Rushiera 2026-10-11）：已经是领航员就不再开一次工——重复 @ 一次「开启」
    // 不该把全部会话再推一遍。判例：12:27 下达清理指令后 R喵 又调了一次 nav_open，
    // 开工报告 + 开场巡检整套重发（6 只猫的会话又发了一遍）。只刷新回消息群，其余不动。
    if (state.snapshot().enabled) {
      state.setActiveChat(resolveChat(chat));
      state.touch();
      record('open', '已是领航员——不重发开工报告与开场巡检');
      return { ok: true, alreadyOpen: true, state: state.snapshot(), receipt: '' };
    }
    state.open({ by, chat: resolveChat(chat) });
    // 轻通道观测并入持久观测（Rushiera 2026-10-14）——开启后所有回复由持久观测接管，撤除一次性观测防重发
    clearLightWatches('领航员开启——并入持久观测');
    voyageStats.replies = 0;
    voyageStats.progress = 0;
    voyageStats.tours = 0;
    const report = await health();
    const text = renderReceipt(report);
    // 开工报告只发给「群内 @ 开启」的场次——软件内开启不打扰群（Rushiera 2026-10-11）
    const announce = receipt && by === 'qq';
    if (announce && state.snapshot().activeChat) {
      await say(state.snapshot().activeChat, text);
    }
    // 开场巡检：对「有会话」的猫把最后一段会话截成卡片发群（Rushiera 2026-10-11 要求——
    // 有会话正文内容的猫不算待命，也要能看到它最后说了什么）——同样只随群内开启
    if (announce) {
      runOpeningTour(report).catch((error) => log.error('navigator', `开场巡检失败：${error?.message ?? error}`));
    }
    // 持久观测：对全部运行中的猫建立订阅——任何一轮回复都截图发群（无例外）
    armAll().catch((error) => record('error', `持久观测建立失败：${error?.message ?? error}`));
    return { ok: true, state: state.snapshot(), health: report, receipt: text };
  }

  /**
   * 开场巡检：对有会话的猫逐个截图最后一段会话，发回消息群（数量上限见配置 tourLimit）。
   *
   * @param {object} report health() 的结果
   * @returns {Promise<void>} 完成
   */
  async function runOpeningTour(report) {
    const chat = state.snapshot().activeChat;
    if (!chat) return;
    const busy = (report.busy ?? []).slice()
      .sort((a, b) => Number(b.lastActiveAt ?? 0) - Number(a.lastActiveAt ?? 0));
    if (busy.length === 0) return;
    const limit = Math.max(0, Number(navConfig.tourLimit) || 0);
    const picked = limit > 0 ? busy.slice(0, limit) : busy;
    record('tour', `开场巡检：${picked.map((row) => row.name || row.id).join('，')}（共 ${busy.length} 只有会话${limit > 0 ? `，取前 ${limit} 只` : '，全部'}）`);
    for (const row of picked) {
      try {
        // 开场一次性给全：取该猫较完整的会话（含开场问候）；后续只发新增（持久观测按 startedAt 增量取）
        const info = await ch4.keyinfo(row.id, Math.max(20, Number(navConfig.tourKeyinfoMax) || 80));
        const blocks = itemsToBlocks(info?.items, 0);
        if (blocks.length === 0) continue;
        const png = await shot.shoot({
          catName: String(row.name || row.id),
          blocks,
          at: new Date().toLocaleString('zh-CN', { hour12: false })
        });
        const insight = await shot.analyze(png);
        const caption = insight ? `${row.name} 手头这段会话：\n${insight}` : `${row.name} 手头这段会话：`;
        const sent = await sayImage(chat, png, caption);
        if (sent.ok) voyageStats.tours += 1;
        record(sent.ok ? 'send' : 'error', sent.ok ? `开场巡检已发图（${row.name}）` : `开场巡检发图失败：${sent.error}`);
      } catch (error) {
        record('error', `开场巡检（${row.name}）失败：${error?.message ?? error}`);
      }
    }
  }

  /**
   * 取某猫 `since` 之后的回复正文（须同时出现轮结算行——中途插话不算一轮结束）。
   *
   * @param {string} key 猫 key
   * @param {number} since 起点时刻
   * @returns {Promise<string>} 回复正文（未结算则空串）
   */
  async function readReply(key, since) {
    try {
      const info = await ch4.keyinfo(key, 8);
      const rows = (Array.isArray(info?.items) ? info.items : []).filter((row) => Number(row.time) >= since);
      const reply = rows.filter((row) => row.role === 'reply')
        .map((row) => String(row.content ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
      return reply && rows.some((row) => row.role === 'roundsum') ? reply : '';
    } catch {
      return '';
    }
  }

  /**
   * 等下一次「轮结束」信号——持久观测收尾（`finishSession`）时唤醒；到点未见信号则返回（供调用方复查）。
   *
   * @param {string} key 猫 key
   * @param {number} timeoutMs 本次最长等待（毫秒）
   * @returns {Promise<void>} 完成
   */
  function waitRoundSignal(key, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const set = roundWaiters.get(key);
        if (set) {
          set.delete(done);
          if (set.size === 0) roundWaiters.delete(key);
        }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      let set = roundWaiters.get(key);
      if (!set) {
        set = new Set();
        roundWaiters.set(key, set);
      }
      set.add(done);
    });
  }

  /**
   * 唤醒某猫的轮结束等待器（`finishSession` 调用）——「群里转发回复」的那一刻就是轮结束。
   *
   * @param {string} key 猫 key
   * @returns {void}
   */
  function notifyRoundEnd(key) {
    const set = roundWaiters.get(String(key));
    if (!set) return;
    for (const done of [...set]) {
      try { done(); } catch { /* 单个等待器失败不影响其余 */ }
    }
  }

  /**
   * 等某猫出「本轮回复」——挂持久观测的轮结束信号唤醒，**默认不设时限**。
   *
   * 为什么不再用固定超时轮询（Rushiera 2026-10-11 定）：完整收工 + 落盘 + 推 git + 交接摘要，
   * 大前文的猫实测 8 分钟——固定窗口（原 240s）必判失败。判例：R喵 434k 前文，
   * 17:39:23 投递、17:43:24 判「交接摘要未取到」中止，而它 17:47:17 才产出摘要。
   * 正常情形下收工报告必然产出，等待就挂到「转发回复」那一刻（持久观测 `finishSession`）。
   *
   * @param {string} key 猫 key
   * @param {object} options 选项
   * @param {number} options.since 起点时刻
   * @param {number} [options.timeoutMs] 上限毫秒（0 = 不设上限；仅「等确认回复」这类非关键路径用）
   * @returns {Promise<string>} 回复正文（空串 = 未取到）
   */
  async function waitForReply(key, { since, timeoutMs = 0 } = {}) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const reply = await readReply(key, since);
      if (reply) return reply;
      if (Date.now() >= deadline) return '';
      const slice = Number.isFinite(deadline)
        ? Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))
        : POLL_INTERVAL_MS;
      await waitRoundSignal(key, slice);
    }
  }

  /**
   * 等新会话就绪——轮询 keyinfo 直到出现加载报告（替代固定等待；猫多 / 前文大时更稳）。
   *
   * @param {string} key 猫 key
   * @param {object} options 选项
   * @param {number} options.beforeCount 清前文前的条目总数（新会话应显著低于它）
   * @param {number} [options.timeoutMs] 超时毫秒
   * @returns {Promise<boolean>} 是否就绪
   */
  async function waitSessionReady(key, { beforeCount = 0, timeoutMs = RESET_READY_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const info = await ch4.keyinfo(key, 5);
        const items = Array.isArray(info?.items) ? info.items : [];
        const count = Number(info?.count ?? items.length);
        const hasReport = items.some((row) => String(row?.role) === 'report');
        if (hasReport && (beforeCount === 0 || count < beforeCount)) return true;
      } catch { /* 单次失败继续轮询 */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    record('error', `${key}：新会话就绪等待超时（${timeoutMs}ms）——仍按当前状态注入`);
    return false;
  }

  /**
   * 挑一只「抢救猫」——空闲且没有参与内容的猫（majordomo 优先）。
   *
   * 判据（design §六b 抢救模式）：runState 为 idle（不在跑）、无待处理、非目标猫本身；
   * majordomo 优先，其余按前文条数升序（越干净越优先——它要腾出上下文装目标猫的原文）。
   *
   * @param {object} options 选项
   * @param {string} [options.excludeKey] 排除的猫（目标猫自身）
   * @returns {Promise<object|null>} { key, name, contextCount, reason }；无可用时 null
   */
  async function pickRescueCat({ excludeKey = '' } = {}) {
    const rows = await ch4.cats();
    const exclude = new Set([String(excludeKey || '')]);
    const candidates = rows.filter((row) => {
      const id = String(row?.id ?? '');
      if (!id || exclude.has(id)) return false;
      if (row?.runState && String(row.runState) !== 'idle') return false;
      if (Number(row?.pending ?? 0) > 0) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    const clean = (row) => Number(row?.contextCount ?? 0);
    const major = candidates.find((row) => String(row.id) === 'majordomo');
    if (major) {
      return { key: 'majordomo', name: String(major.name || 'majordomo'), contextCount: clean(major), reason: 'majordomo 优先' };
    }
    const best = candidates.slice().sort((a, b) => clean(a) - clean(b))[0];
    return {
      key: String(best.id),
      name: String(best.name || best.id),
      contextCount: clean(best),
      reason: `空闲且前文最干净（${clean(best)} 条）`
    };
  }

  /**
   * 抓目标猫的**完整前文**（抢救模式——交救援猫代读）。
   *
   * 数据源（Rushiera 2026-10-14 定）：`fullctx` 全条目拼正文——含工具调用 / 思考 / 工具结果，
   * 不再只取 `keyinfo` 的四类关键信息（旧版工具密集的会话只带过去千分之几）。system 注入块
   * 不入正文（接手方自带；且会吃掉头 30% 额度）。另附**关键信息索引**——每条标出它在正文
   * 中的位置（条号 + 起始字符），正文被砍中段时仍可按位置回查。
   *
   * @param {string} key 目标猫
   * @returns {Promise<{ text: string, index: string, count: number, chars: number, truncated: boolean }>} 结果
   */
  async function grabCatSource(key) {
    const ctx = await ch4.fullctx(key, 100000);
    if (ctx?.ok === false) throw new Error(String(ctx?.error ?? '完整前文读取失败'));
    const items = Array.isArray(ctx?.items) ? ctx.items : [];
    const built = fullContextText(items);
    const count = Number(ctx?.count ?? items.length);
    const total = built.text.length;
    const truncated = total > rescueMaxChars;
    const headLen = truncated ? Math.floor(rescueMaxChars * RESCUE_HEAD_RATIO) : total;
    const tailLen = rescueMaxChars - headLen;
    const tailStart = truncated ? total - tailLen : total;
    let index = '';
    try {
      const info = await ch4.keyinfo(key, 100000);
      index = keyIndex(info?.items, built.marks, { truncated, headLen, tailStart });
    } catch (error) {
      record('error', `${key}：关键信息索引抓取失败（${error?.message ?? error}）`);
    }
    if (!truncated) return { text: built.text, index, count, chars: total, truncated: false };
    const omitted = total - rescueMaxChars;
    return {
      text: `${built.text.slice(0, headLen)}\n\n…（中段省略 ${group(omitted)} 字符）…\n\n${built.text.slice(-tailLen)}`,
      index,
      count,
      chars: total,
      truncated: true
    };
  }

  /**
   * 等救援猫产出交接摘要——太短（先回了一句）时催办后继续等，最多 RESCUE_RETRY_MAX 次。
   *
   * @param {string} key 救援猫
   * @param {object} options 选项
   * @param {number} options.since 起点时刻
   * @param {string} [options.name] 救援猫显示名（留痕用）
   * @returns {Promise<string>} 摘要正文（空串 = 未取到）
   */
  async function waitSummary(key, { since, name: catName = key } = {}) {
    let cursor = since;
    for (let attempt = 0; attempt <= RESCUE_RETRY_MAX; attempt += 1) {
      const reply = await waitForReply(key, { since: cursor });
      if (!reply) return '';
      if (reply.length >= RESCUE_SUMMARY_MIN) return reply;
      record('reset', `${catName}：先回了一句短话（${reply.length} 字符），催办摘要（${attempt + 1}/${RESCUE_RETRY_MAX}）`);
      cursor = Date.now();
      try {
        await ch4.send(key, '请直接输出**交接摘要正文**（纯文本，小标题 + 列表）——不要确认、不要复述原文、不要调工具；上一句不是摘要。');
      } catch (error) {
        record('error', `${catName}：催办投递失败（${error?.message ?? error}）`);
        return '';
      }
    }
    return '';
  }

  /**
   * 抢救模式——目标猫自己跑不动时，由另一只空闲猫代读它的完整前文，产出交接摘要。
   *
   * @param {object} options 选项
   * @param {string} options.resolved 目标猫 key
   * @param {string} options.name 目标猫显示名
   * @returns {Promise<object>} { ok, summary, rescuer, source } 或 { ok:false, error }
   */
  async function rescueSummary({ resolved, name }) {
    const rescuer = await pickRescueCat({ excludeKey: resolved });
    if (!rescuer) {
      record('error', `${name}：抢救失败——没有空闲且未参与内容的猫可用`);
      return { ok: false, error: '没有空闲且未参与内容的猫可用作抢救' };
    }
    record('reset', `${name}：抢救猫 = ${rescuer.name}（${rescuer.reason}，前文 ${rescuer.contextCount} 条）`);
    let source;
    try {
      source = await grabCatSource(resolved);
    } catch (error) {
      record('error', `${name}：完整前文抓取失败（${error?.message ?? error}）`);
      return { ok: false, error: '完整前文抓取失败' };
    }
    if (!source.text) {
      record('error', `${name}：完整前文为空——无可代读内容`);
      return { ok: false, error: '完整前文为空' };
    }
    record('reset', `${name}：完整前文已抓取（${source.count} 条 / ${group(source.chars)} 字符${source.truncated ? '·超限截断' : ''}）→ 投给 ${rescuer.name} 代读`);
    const askAt = Date.now();
    await ch4.send(rescuer.key, [
      `【领航员·前文抢救】目标：${name}。它自己的会话已经跑不动了（前文太长 / 无响应），没法自己收工整理——现在由你代读它的**完整前文**，产出一份**交接摘要**，交给它的下一个会话。`,
      '',
      '摘要要求（足量、详尽，宁多勿漏——接手方只有这份摘要，猜不到你没写的）：',
      '· 任务全貌与背景（在做什么、为什么做）',
      '· 已完成的步骤与做法（关键路径 / 命令 / 文件 / 接口）',
      '· 未完成事项与下一步',
      '· 关键结论、踩过的坑、被否决的方案与原因',
      '· 继续工作所必需的上下文（路径 / 参数 / 约定 / 凭证位置）',
      '· 不确定或待确认的点（明确标注，别让接手方当成事实）',
      '· 用户提过的原始要求（照抄关键句，别改写）',
      '',
      '【会话关键信息索引】（位置 = 该条在正文中的条号与起始字符；中段被省略时，索引里仍保留该条首段与位置——需要细节按位置回查）',
      source.index || '（未取到条目）',
      '',
      `完整前文在下面（${source.count} 条 / ${group(source.chars)} 字符${source.truncated ? '，超长已砍中段' : ''}）。本次**不要调工具**，只读前文；只输出摘要正文（纯文本，小标题 + 列表），不要复述原文、不要输出别的话；篇幅不设上限。`,
      '',
      '—— 会话完整前文 ——',
      source.text
    ].join('\n'));
    const summary = await waitSummary(rescuer.key, { since: askAt - 2000, name: rescuer.name });
    if (!summary) {
      record('error', `${name}：抢救摘要未取到（救援猫 ${rescuer.name}），整理中止`);
      return { ok: false, error: '抢救摘要未取到', rescuer };
    }
    record('reset', `${name}：抢救摘要已取到（${rescuer.name} 代读，${summary.length} 字符）`);
    return { ok: true, summary, rescuer, source };
  }

  /**
   * 前文整理重启——收工整理 → 抓原文轨迹 → 新会话 → 注入「摘要 + 轨迹」→ 自动继续。
   *
   * 延续性优先（Rushiera 2026-10-11）：交接材料 = 猫自述摘要 + 领航员客观抓取的原文轨迹，
   * 两者一起注入——单靠摘要会丢细节，单靠轨迹会太长。
   *
   * @param {object} options 选项
   * @param {string} options.key 目标猫
   * @param {string|number} [options.chat] 回报群
   * @param {string} [options.text] 用户原话——新会话就绪后作为第一条指令投递（可选）
   * @param {boolean} [options.rescue] 抢救模式——目标猫自己跑不动时由空闲猫代读（可选）
   * @returns {Promise<object>} 结果
   */
  async function resetSession({ key, chat = null, text = '', rescue = false }) {
    const userText = String(text || '').trim();
    const resolved = await ch4.resolveKey(key);
    const name = await catNameOf(resolved);
    const target = resolveChat(chat);
    record('reset', rescue
      ? `${name}：前文整理重启（抢救模式）开始——由空闲猫代读`
      : `${name}：前文整理重启开始`);

    let summary = '';
    let summaryFrom = '猫自述';
    if (rescue) {
      // 抢救模式：跳过目标猫自述，由另一只空闲猫代读它的会话（design §六b 抢救模式）
      const salvaged = await rescueSummary({ resolved, name });
      if (!salvaged.ok) return { ok: false, error: salvaged.error };
      summary = salvaged.summary;
      summaryFrom = `抢救猫 ${salvaged.rescuer.name} 代读`;
    } else {
    // ① 收工整理——让它把工作状态写成交接摘要（不调工具）
    const askAt = Date.now();
    await ch4.send(resolved, [
      '【领航员·前文整理】你现在做一次**完整收工**，按顺序：',
      '① 落盘——把该写的写进文件（进度 / 变更 / 设计文档 / todo / CHANGELOG，按你所在项目的收工清单）。',
      '② **推 git**——把当前工作提交并推送（能推的都推掉，别留着）。',
      '③ **收工报告**——按你的收工纪律输出终态断言：完成项 / 落盘位置 / 遗留项去向，零疑问句。',
      '④ 然后输出一份**交接摘要**——要足量、详尽，宁多勿漏；接手方是你的下一个会话，它只有这份摘要，猜不到你没写的：',
      '   · 任务全貌与背景（在做什么、为什么做）',
      '   · 已完成的步骤与做法（关键路径 / 命令 / 文件 / 接口）',
      '   · 未完成事项与下一步',
      '   · 关键结论、踩过的坑、被否决的方案与原因',
      '   · 继续工作所必需的上下文（路径 / 参数 / 约定 / 凭证位置）',
      '   · 不确定或待确认的点（明确标注，别让接手方当成事实）',
      '   · 用户提过的原始要求（照抄关键句，别改写）',
      '',
      '①②③做完再输出摘要；报告与摘要都只输出正文（纯文本，小标题 + 列表），篇幅不设上限。'
    ].join('\n'));
    // 不设时限——收工 + 落盘 + 推 git + 摘要，大前文的猫实测 8 分钟（等「转发回复」那一刻）
    summary = await waitForReply(resolved, { since: askAt - 2000 });
    if (!summary) {
      record('error', `${name}：交接摘要未取到，整理中止`);
      return { ok: false, error: '交接摘要未取到' };
    }
    record('reset', `${name}：交接摘要已取到（${summary.length} 字符）`);
    }

    // ①b 抓原文轨迹（必须在清前文之前——清掉就没了）：摘要之外的客观留存
    let trace = '';
    let beforeCount = 0;
    try {
      const info = await ch4.keyinfo(resolved, 10000);
      beforeCount = Number(info?.count ?? 0);
      trace = traceText(info?.items, traceLimit);
    } catch (error) {
      record('error', `${name}：原文轨迹抓取失败（${error?.message ?? error}）——本次仅注入摘要`);
    }
    record('reset', `${name}：原文轨迹已抓取（${trace.length} 字符 / 清前文前 ${beforeCount} 条）`);

    // ①c 交接材料存盘（可事后核对——失败必须可见）
    const material = [
      `# 交接材料 · ${name}（${new Date().toLocaleString('zh-CN', { hour12: false })}）`,
      '',
      `## 交接摘要（${summaryFrom}）`,
      '',
      summary,
      '',
      '## 原文轨迹（领航员抓取）',
      '',
      trace || '（未抓到）',
      ''
    ].join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const materialFile = path.join(dataDir, `nav-reset-${resolved}-${stamp}.md`);
    try {
      fs.writeFileSync(materialFile, material, 'utf8');
      record('reset', `${name}：交接材料已存盘 ${path.basename(materialFile)}`);
    } catch (error) {
      record('error', `${name}：交接材料存盘失败（${error?.message ?? error}）`);
    }

    // ② 新会话——清前文 + 重新注入
    const newSession = await ch4.command(`cat.new-session ${resolved}`, ch4.mainPort);
    record('reset', `${name}：新会话已请求（${JSON.stringify(newSession).slice(0, 80)}）`);
    await waitSessionReady(resolved, { beforeCount });

    const injectAt = Date.now();
    const parts = [
      '【上一段会话的收工报告与交接摘要】',
      summary
    ];
    if (trace) {
      parts.push(
        '',
        '【上一段会话原文轨迹】（末尾若干条，原文照录——供你核对细节，别只信摘要）',
        trace
      );
    }
    parts.push(
      '',
      '以上是你上一段工作的交接摘要与前文轨迹（前文已按此重置，你的记忆就靠这两份材料）。',
      '据此继续工作——别重新调研已经做过的事：先回一句你在接着做什么，然后直接动手推进未完成的事项。'
    );
    await ch4.send(resolved, parts.join('\n'));
    record('reset', `${name}：交接摘要已注入，等待确认`);

    // ⑤ 等它接上（回复由持久观测自动截图发群，不额外截图）
    const ack = await waitForReply(resolved, { since: injectAt - 2000, timeoutMs: 180000 });
    record('reset', `${name}：整理重启完成${ack ? '' : '（未见确认回复，可能仍在跑）'}`);

    // ⑥ 用户原话（nav_reset 带 text 时）——接上之后作为第一条指令投递，不再靠两步 nav_new + nav_send
    let delivered = null;
    if (userText) {
      const deliverAt = Date.now();
      await ch4.send(resolved, userText);
      delivered = await waitForReply(resolved, { since: deliverAt - 2000, timeoutMs: 180000 });
      record('reset', `${name}：用户原话已投递（${userText.length} 字符）${delivered ? '' : '（未见确认回复）'}`);
    }
    if (target) {
      // 不另发「整理完成」通知——猫的回复由出站决策发（有回复 → 截图；还没回复 → 检查点播报）
      scheduleAnalysis(resolved, target, { reason: '整理重启后' });
    }
    return { ok: true, key: resolved, name, summary, summaryFrom, rescue, trace, ack, material: materialFile, delivered };
  }

  /**
   * 新会话（/new）——给一只或多只猫**直接开新会话**：清前文 + 重新注入知识文件。
   *
   * 与 `resetSession`（前文整理重启）的区别（Rushiera 2026-10-11）：那是「保住工作地重启」——
   * 先收工出交接摘要、再开新会话、再把摘要注入让它接着干；本函数只开新会话，
   * **不**收工、**不**抓轨迹、**不**注入、**不**让它继续。
   *
   * 群内语义：「清掉 X 的会话」「直接开新会话即可」走本路径；「清理一下 X 的前文，然后让工作继续」才走 reset。
   *
   * 通道：`cat.new-session <key>`（CH4 管理指令族）——设计文档口径为「会话状态卡弹层预设 `/new` 的
   * 投递通道（等价该猫前端 `session.new`）」，与 QQ 侧 `/new` 同一执行体（`ChatBridge.HandleSessionNew`）。
   *
   * @param {object} options 选项
   * @param {string|Array<string>} options.keys 目标猫（数组，或逗号 / 顿号 / 空格分隔的字符串）
   * @param {string|number} [options.chat] 来源群（记账用）
   * @returns {Promise<object>} { ok, count, total, results }
   */
  async function newSession({ keys = [], chat = null } = {}) {
    const list = (Array.isArray(keys) ? keys : String(keys ?? '').split(/[,，、\s]+/))
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
    if (list.length === 0) return { ok: false, error: '未指定目标猫', count: 0, total: 0, results: [] };
    const chatResolved = resolveChat(chat);
    const results = [];
    for (const raw of list) {
      const key = await ch4.resolveKey(raw);
      try {
        const reply = await ch4.command(`cat.new-session ${key}`, ch4.mainPort);
        const accepted = reply?.ok === true;
        results.push({ key, ok: accepted, reply });
        record(accepted ? 'new' : 'error', accepted
          ? `${raw}：新会话已请求（/new）`
          : `${raw}：新会话请求未受理（${JSON.stringify(reply).slice(0, 80)}）`);
        if (accepted) {
          state.noteCommand({ chat: chatResolved, target: key, text: '（新会话 /new）', result: '已请求新会话' });
        }
      } catch (error) {
        results.push({ key, ok: false, error: String(error?.message ?? error) });
        record('error', `${raw}：新会话请求失败（${error?.message ?? error}）`);
      }
    }
    const count = results.filter((row) => row.ok).length;
    return { ok: count > 0, count, total: results.length, results };
  }

  /**
   * 领航记录——本次领航（开启 → 关闭）的终态小结。
   *
   * 超时自关与主动退出都要有（Rushiera 2026-10-11）；落盘归档总是做，发群随「关闭动作的发生地」。
   *
   * @param {object} snap 关闭前的状态快照
   * @param {string} reason 关闭原因
   * @param {string} [by] 关闭来源（qq=群内退出 / app=软件内退出或空闲自关）
   * @returns {object} { text, file, brief }
   */
  function buildVoyageLog(snap, reason, by = 'app') {
    const openedAt = Number(snap.openedAt) || 0;
    const closedAt = Date.now();
    const ms = openedAt > 0 ? closedAt - openedAt : 0;
    const dur = ms > 0 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : '未知';
    const fmt = (at) => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未知');
    const cmds = (snap.commandLog ?? []).filter((item) => Number(item.at) >= openedAt);
    const lines = [
      `【领航记录】${fmt(openedAt)} → ${fmt(closedAt)}（共 ${dur}）`,
      `· 开启来源：${snap.openedBy === 'qq' ? '群内 @' : '应用内'}`,
      `· 关闭来源：${reason === 'idle' ? '空闲暂关（超时）' : (by === 'qq' ? '群内 @ 退出' : '应用内退出')}`,
      `· 指令：${cmds.length} 条`,
      `· 回复截图：${voyageStats.replies} 张`,
      `· 进度播报：${voyageStats.progress} 条`,
      `· 开场巡检：${voyageStats.tours} 张`
    ];
    const last = cmds[cmds.length - 1];
    if (last?.text) lines.push(`· 最近指令：${String(last.text).replace(/\s+/g, ' ').slice(0, 60)}`);
    const text = lines.join('\n');
    // 群记条目（一行版小结）——进记忆面用；业务面按 200 字符截断
    const brief = `领航场次 ${fmt(openedAt)} → ${fmt(closedAt)}（${dur}）：开启来源 ${snap.openedBy === 'qq' ? '群内 @' : '应用内'}，关闭来源 ${reason === 'idle' ? '空闲超时自关' : (by === 'qq' ? '群内 @ 退出' : '应用内退出')}；指令 ${cmds.length} 条 / 回复截图 ${voyageStats.replies} 张 / 进度播报 ${voyageStats.progress} 条 / 开场巡检 ${voyageStats.tours} 张${last?.text ? `；最近指令：${String(last.text).replace(/\s+/g, ' ').slice(0, 30)}` : ''}。`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dataDir, `nav-log-${stamp}.md`);
    try {
      fs.writeFileSync(file, `${text}\n`, 'utf8');
      record('log', `领航记录已归档 ${path.basename(file)}`);
    } catch (error) {
      record('error', `领航记录归档失败（${error?.message ?? error}）`);
    }
    return { text, file, brief };
  }

  /**
   * 关闭领航员。
   *
   * @param {object} options 选项
   * @param {string} [options.reason] 原因（manual / idle）
   * @param {string} [options.by] 关闭来源（qq=群内退出 / app=软件内退出或空闲自关）
   * @param {string|number|null} [options.chat] 退出动作发生的群（空=按新鲜 VIP 群消息解析）
   * @param {boolean} [options.notify] 保留参数（现行语义：发不发群由关闭来源决定，不看它）
   * @returns {Promise<object>} 状态快照
   */
  async function close({ reason = 'manual', by = 'app', chat = null, notify = false } = {}) {
    const before = state.snapshot();
    const next = state.close(reason);
    disarmAll();
    // 领航记录：超时自关与主动退出都要有（Rushiera 2026-10-11）
    // 落盘归档总是做；发群目标群按「动作的发生地」定（Rushiera 2026-10-11 定口径）：
    //   群内退出 → 退出那个群；超时自关 → 最后一次群内指令的群（activeChat，
    //   软件内开启但群内下过指令的场次同样发）；软件内手动退出 / 无群内指令 → 静默整理。
    const voyage = buildVoyageLog(before, reason, by);
    const target = by === 'qq'
      ? (resolveChat(chat) || before.activeChat)
      : (reason === 'idle' ? before.activeChat : null);
    if (target) await say(target, voyage.text);
    // 场次小结进群记——「退出领航员是体面退出」：R喵 要知道自己在这段时间做过什么。
    // 手动退出与空闲自关都走这里（两条关闭路径共用一处沉淀）。
    if (before.activeChat) await sedimentVoyage(before.activeChat, voyage.brief);
    return next;
  }

  /**
   * 投递一条指令给猫（同时记账：回消息群跟随、指令流水；并登记观测）。
   *
   * 两种模式（Rushiera 2026-10-14）：
   *   · 领航员开启——原语义：记账 + 持久观测挂群 + 排「投递后 N 秒」会话分析；
   *   · 领航员未开启——**轻通道**：本人（VIP）在群里直接下的指定猫指令照样投递；
   *     只做「投递 + 回复截图」（一次性观测），**不记账、不排分析**（不带投送后分析）。
   *
   * @param {object} options 选项
   * @param {string} options.key 目标猫（id / 显示名 / majordomo）
   * @param {string} options.text 指令内容
   * @param {string|number} [options.chat] 来源群
   * @param {boolean} [options.sourceTag] 是否加 QQ 来源头（默认 false——Rushiera 2026-10-11：转发不加 `[来自QQ]…` 头，渠道由投递通道自身承载，不污染会话前文）
   * @param {boolean} [options.watch] 是否登记观测（默认 true）
   * @param {boolean} [options.dryRun] 干跑——只返回组装结果，不投递（默认 false；自测投递口径用）
   * @param {string} [options.by] 触发通道（qq=业务面群内调用 / app=应用内与本地操作者通道）
   * @returns {Promise<object>} { ok, key, text, reply, watch }
   */
  async function send({ key, text, chat = null, sourceTag = false, watch = true, dryRun = false, by = 'app' }) {
    const content = sourceTag
      ? `[来自QQ][群@|Rushiera·本人] ${String(text ?? '').trim()}`
      : String(text ?? '').trim();
    const chatResolved = resolveChat(chat);
    // 干跑：只做组装与校验，不投递 / 不记账 / 不排分析——自测「投递口径」（加不加来源头、
    // 触发标记有没有被带上）走这条路，不必真投到猫的会话里。
    // 判例：2026-10-11 13:08 R喵喵喵 自测「去来源头」直接 POST 真投递，一条自测消息落进
    // majordomo 的会话前文（还是乱码——手拼 HTTP 体没走工具面）。
    if (dryRun) {
      record('send', `干跑（不投递）→ ${key}：${content.slice(0, 60)}`);
      return { ok: true, dryRun: true, delivered: false, key: String(key || ''), text: content, chat: chatResolved };
    }
    const enabled = state.snapshot().enabled === true;
    // 未开启：轻通道（Rushiera 2026-10-14）——本人（VIP）在群里直接下的指令照样投递，
    // 投递 + 回复截图照常，不做投送后分析；其余（非本人 / 非 QQ 通道）一律不受理——
    // 不在场就没有「指令」语境，投递只会污染猫的前文。不受理必须出声（AGENTS §一-4）。
    if (!enabled && !(by === 'qq' && vipFresh())) {
      record('error', `领航员未开启——投递不受理（${key}）：${content.slice(0, 40)}`);
      return {
        ok: false,
        error: `领航员未开启——未开启时只受理本人（${vipUser || 'VIP'}）近期的指定猫指令`,
        offMode: true,
        key: String(key || ''),
        text: content
      };
    }
    const result = await ch4.send(key, content);
    if (!enabled) {
      // 轻通道：不记账（不动领航员状态）、不排分析；登记一次性回复观测（轮结束 → 回复截图发群）
      if (result.ok) {
        result.light = true;
        armLightWatch(result.key, chatResolved);
        record('send', `轻通道投递 → ${result.key}（未开启模式）：${content.slice(0, 60)}`);
      } else {
        record('error', `轻通道投递未受理（${key}）：${JSON.stringify(result.reply ?? {}).slice(0, 80)}`);
      }
      return result;
    }
    state.noteCommand({
      chat: chatResolved,
      target: result.key,
      text: String(text ?? '').trim(),
      result: result.ok ? '已投递' : '投递失败'
    });
    // 观测是持久订阅（开启时对全部猫建立）——投递只负责把回消息群挂到该猫的观测会话上
    if (result.ok) {
      const session = sessions.get(result.key);
      if (session) session.chat = chatResolved;
      result.watch = session ? { ok: true, persistent: true } : { ok: false, error: '该猫未在观测中' };
      // 订阅不在线（断线 / 漏订）→ 即时补一次（2026-10-14：不等下一轮巡检）
      if (!watcher.list().includes(result.key)) {
        ensureWatching().catch((error) => record('error', `投递后补订阅失败：${error?.message ?? error}`));
      }
      // 静默执行的反馈替代：过一会儿主动给一次「猫会话分析」（不再回「已投递」）
      scheduleAnalysis(result.key, chatResolved, { reason: `投递后 ${Math.round(analyzeDelayMs / 1000)} 秒` });
    }
    return result;
  }

  // ── 轻通道（未开启模式的投递观测）──────────────────────────────────────────

  /**
   * 登记一次性回复观测——轻通道投递成功后调用（未开启模式）。
   *
   * 语义（Rushiera 2026-10-14）：群里下的指令完成后，按领航员的方式把回复截图发群；
   * **不带投送后分析**。轮询 keyinfo（不建持久订阅——与领航员的观测互不干扰），
   * 检出「投递之后的回复 + 轮结算」即截图发群并撤除；超时放弃（留痕）。
   *
   * @param {string} key 猫 key
   * @param {string|number|null} chat 回报群
   * @returns {void}
   */
  function armLightWatch(key, chat) {
    const target = resolveChat(chat);
    if (!target) {
      record('error', `轻通道（${key}）：没有回消息群，跳过回复观测`);
      return;
    }
    cancelLightWatch(key);
    const watch = { key: String(key), chat: String(target), since: Date.now() - 2000, timer: null, done: false };
    watch.timer = setInterval(() => {
      lightTick(watch).catch((error) => record('error', `轻通道（${watch.key}）巡检失败：${error?.message ?? error}`));
    }, LIGHT_POLL_MS);
    lightWatches.set(watch.key, watch);
    record('watch', `轻通道：等 ${watch.key} 的回复（群 ${watch.chat}）`);
  }

  /**
   * 撤除一只猫的轻通道观测（含定时器）。
   *
   * @param {string} key 猫 key
   * @returns {void}
   */
  function cancelLightWatch(key) {
    const watch = lightWatches.get(String(key));
    if (!watch) return;
    watch.done = true;
    if (watch.timer) clearInterval(watch.timer);
    lightWatches.delete(String(key));
  }

  /**
   * 撤除全部轻通道观测（领航员开启并入持久观测 / 应用停止）。
   *
   * @param {string} [reason] 撤除原因（进活动流）
   * @returns {void}
   */
  function clearLightWatches(reason = '') {
    if (lightWatches.size === 0) return;
    const keys = [...lightWatches.keys()];
    for (const key of keys) cancelLightWatch(key);
    if (reason) record('watch', `轻通道观测撤除（${keys.join('，')}）：${reason}`);
  }

  /**
   * 轻通道巡检——检出「投递之后的回复」即截图发群（只截回复内容，不带分析）。
   *
   * @param {object} watch 观测条目
   * @returns {Promise<void>} 完成
   */
  async function lightTick(watch) {
    if (watch.done) return;
    if (Date.now() - watch.since > LIGHT_WATCH_MAX_MS) {
      cancelLightWatch(watch.key);
      record('error', `轻通道（${watch.key}）：等回复超时（${Math.round(LIGHT_WATCH_MAX_MS / 60000)} 分钟），撤除`);
      return;
    }
    const reply = await readReply(watch.key, watch.since);
    if (!reply) return;
    cancelLightWatch(watch.key);
    const catName = await catNameOf(watch.key);
    try {
      const info = await ch4.keyinfo(watch.key, 12);
      const rows = Array.isArray(info?.items) ? info.items : [];
      const png = await shot.shoot({ catName, blocks: replyBlocksOf(rows), at: new Date().toLocaleString('zh-CN', { hour12: false }) });
      if (!png) {
        record('error', `轻通道（${watch.key}）：截图为空，跳过`);
        return;
      }
      const sent = await sayImage(watch.chat, png, `${catName} 的回复`);
      record(sent.ok ? 'send' : 'error', sent.ok
        ? `轻通道：回复截图已发群 ${watch.chat}（${catName}）`
        : `轻通道：回复截图发送失败（${sent.error}）`);
    } catch (error) {
      record('error', `轻通道（${watch.key}）：推送失败（${error?.message ?? error}）`);
    }
  }

  /**
   * 受理一次图像编辑——群里的图 → ComfyDock「[生成]」工作区 → 出图发回本群。
   *
   * 前置两条（Rushiera 2026-10-11 定）：**领航员已开启** + **ComfyDock 在线**——
   * 缺哪条拒哪条；不受理必须出声，不静默吞（AGENTS §一-4）。
   *
   * 提交即返回（后台轮询到收口才发群）——云端出图实测 1~3 分钟，工具侧不能阻塞。
   *
   * @param {object} options 选项
   * @param {string} [options.by] 触发来源（app=应用内 / 操作者通道；qq=群内 @——受请求者闸约束）
   * @param {string|number} [options.chat] 来源群（空=按新鲜 VIP 群消息解析）
   * @param {string} options.prompt 提示词
   * @param {string} [options.image] 本地图片路径（图已在本机时用）
   * @param {string} [options.file] OneBot 消息段的 file 名（群图走这条）
   * @param {string} [options.url] 图片直链（协议端缓存取不到时的兜底）
   * @returns {Promise<object>} { ok, taskId?, image?, error?, offMode?, vipOnly? }
   */
  async function editImage({ by = 'app', chat = null, prompt = '', image = '', file = '', url = '' } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, error: '提示词是空的——改图要一句要求' };
    const target = resolveChat(chat);
    if (!target) return { ok: false, error: '没有回消息群——先在下指令的那个群里说一句' };
    if (state.snapshot().enabled !== true) {
      record('error', `图像编辑不受理（领航员未开启）：${text.slice(0, 40)}`);
      return { ok: false, error: '领航员未开启——图像编辑只在领航员模式下受理', offMode: true };
    }
    if (!comfyEnabled) {
      return { ok: false, error: '图像编辑未启用（配置 navigator.comfy.enabled=false）' };
    }
    // 请求者闸（Rushiera 2026-10-11：先收成只有 569145850 能用，白名单以后做）——
    // 只对**群内触发**生效（与开关面同口径：应用内 / 操作者通道本就只有本人够得着）；
    // 凭据 = 「最近一次 VIP 群 @ 我」（新鲜窗口 VIP_FRESH_MS），**且必须与目标群同一个群**
    // （否则 B 群的人能蹭 A 群的近期 VIP 消息）。
    if (by === 'qq' && comfyRequireVip && !(vipFresh() && String(vip.chat) === String(target))) {
      record('error', `图像编辑不受理（非 ${vipUser || 'VIP'} 触发 / 非同群）：${text.slice(0, 40)}`);
      return {
        ok: false,
        error: `图像编辑目前只对 ${vipUser || '指定 QQ'} 开放——需要本人近期在**本群** @ 我`,
        vipOnly: true
      };
    }
    const result = await comfy.edit({ chat: target, prompt: text, image, file, url });
    if (result.ok) {
      state.noteCommand({ chat: target, target: '', text: `（图像编辑）${text.slice(0, 60)}`, result: '已提交' });
    }
    return result;
  }

  /**
   * 状态汇总（界面与业务面工具共用）。
   *
   * @returns {Promise<object>} 状态
   */
  async function status() {
    const snap = state.snapshot();
    let cats = [];
    let error = '';
    try {
      cats = await ch4.cats();
    } catch (err) {
      error = String(err?.message ?? err);
    }
    return {
      ...snap,
      idleCloseMs,
      vipUser,
      vipRecentChat: vipFresh() ? vip.chat : null,
      watching: watcher.list(),
      lightWatches: [...lightWatches.keys()],
      activity: activity.map((item) => ({ ...item })),
      busy: cats.filter((row) => hasSession(row)).map((row) => row.id),
      cats,
      ch4Error: error,
      idleMs: snap.lastCommandAt ? Date.now() - snap.lastCommandAt : 0
    };
  }

  // ── 空闲暂关守护 ──────────────────────────────────────────────────────────

  /** 巡检一次：全猫停工 + 无指令超时 → 暂关。 */
  async function tick() {
    if (ticking) return;
    const snap = state.snapshot();
    if (!snap.enabled) return;
    // 补订阅（断线自愈）——订阅中断不再等到下次开启才恢复（2026-10-14）
    await ensureWatching();
    // 计时基准 = 最近一次活动（指令 / 猫的回复）——不是「最后一条指令」（否则刚开工就被判空闲）
    const since = Math.max(
      Number(snap.lastActivityAt) || 0,
      Number(snap.lastCommandAt) || 0,
      Number(snap.openedAt) || 0
    );
    if (!since || Date.now() - since < idleCloseMs) return;
    ticking = true;
    try {
      const cats = await ch4.cats();
      const working = cats.filter((row) => row?.runState && row.runState !== 'idle');
      if (working.length > 0) return;
      log.info('navigator', '全猫停工且无指令超时——自动暂关（静默整理，不发群）');
      await close({ reason: 'idle', notify: true });
    } catch (error) {
      log.warn('navigator', `空闲巡检失败：${error?.message ?? error}`);
    } finally {
      ticking = false;
    }
  }

  /** 启动守护（含重启后重建持久观测）。 */
  function start() {
    if (watchTimer) return;
    watchTimer = setInterval(() => { tick().catch(() => { /* 已在内部记录 */ }); }, WATCH_INTERVAL_MS);
    if (state.snapshot().enabled) {
      armAll().catch((error) => record('error', `重启后重建持久观测失败：${error?.message ?? error}`));
    }
  }

  /** 停止守护（含订阅与在途定时器）。 */
  function stop() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    // 撤订要撤干净——漏掉 pollTimer / analyzeTimers 会让进程退出时留着在途句柄
    // （自测里表现为退出码失真：libuv 断言）。armAll 装上的，stop 全摘。
    disarmAll();
    clearLightWatches('应用停止');
  }

  // ── 本地 HTTP API（界面 + 业务面工具）────────────────────────────────────

  const api = {
    'GET /api/nav/status': async () => ({ body: await status() }),
    'GET /api/nav/health': async () => ({ body: await health() }),
    'POST /api/nav/open': async ({ body }) => ({
      body: await open({
        by: body?.by || 'app',
        chat: body?.chat ?? null,
        receipt: body?.receipt !== false,
        requireVip: body?.requireVip === true
      })
    }),
    'POST /api/nav/close': async ({ body }) => ({
      body: await close({
        reason: body?.reason || 'manual',
        by: body?.by || 'app',
        chat: body?.chat ?? null,
        notify: body?.notify === true
      })
    }),
    'POST /api/nav/send': async ({ body }) => ({
      body: await send({
        key: body?.key || 'majordomo',
        text: body?.text || '',
        chat: body?.chat ?? null,
        sourceTag: body?.sourceTag === true,
        watch: body?.watch !== false,
        dryRun: body?.dryRun === true,
        by: body?.by === 'qq' ? 'qq' : 'app'
      })
    }),
    'POST /api/nav/say': async ({ body }) => ({ body: await say(body?.chat, body?.text) }),
    'POST /api/nav/comfy': async ({ body }) => ({
      body: await editImage({
        // by 只认 'qq'（业务面群内触发）——其余一律按操作者通道走（应用内 / 本地 API）
        by: body?.by === 'qq' ? 'qq' : 'app',
        chat: body?.chat ?? null,
        prompt: body?.prompt ?? '',
        image: body?.image ?? '',
        file: body?.file ?? '',
        url: body?.url ?? ''
      })
    }),
    'POST /api/nav/analyze': async ({ body }) => ({
      body: await analyzeOnce({
        key: body?.key || 'majordomo',
        chat: body?.chat ?? null,
        delayMs: Number(body?.delayMs ?? 0) || 0,
        reason: body?.reason || '手动触发'
      })
    }),
    'POST /api/nav/shot': async ({ body }) => ({
      body: await shotSession({
        key: body?.key || 'majordomo',
        chat: body?.chat ?? null,
        blocks: Array.isArray(body?.blocks) ? body.blocks : null,
        send: body?.send === true
      })
    }),
    'GET /api/nav/detail': async ({ query }) => ({ body: await ch4.detail(query.get('key') || 'majordomo') }),
    'POST /api/nav/new-session': async ({ body }) => ({
      body: await newSession({ keys: body?.keys ?? body?.key ?? [], chat: body?.chat ?? null })
    }),
    'POST /api/nav/reset': async ({ body }) => {
      const key = body?.key || 'majordomo';
      const text = String(body?.text || '').trim();
      const rescue = body?.rescue === true;
      // 干跑（自测用）——只回显参数，不启动后台执行（避免自测真去投递 / 打扰真猫）
      if (body?.dryRun === true) return { body: { ok: true, dryRun: true, key, text, rescue } };
      resetSession({ key, chat: body?.chat ?? null, text, rescue })
        .catch((error) => record('error', `整理重启失败（${key}）：${error?.message ?? error}`));
      return { body: { ok: true, accepted: true, key, text, rescue, hint: rescue ? '抢救模式整理已在后台执行——进度看活动流' : '整理重启已在后台执行——进度看活动流' } };
    }
  };

  return {
    state, ch4, watcher, shot,
    health, renderReceipt, open, close, send, status, say, sayAt, sayImage,
    armCat, armAll, disarmAll, ensureWatching, resetSession, newSession, waitForReply,
    pickRescueCat, grabCatSource,
    scheduleAnalysis, runAnalysis, analyzeOnce, collectThink, thinkText,
    pullCatView, digestFromView, digestFromSession, composeActivity,
    armLightWatch, cancelLightWatch, clearLightWatches, lightWatches,
    editImage, comfy,
    start, stop, api, idleCloseMs
  };
}
