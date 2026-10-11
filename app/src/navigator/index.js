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

/** 计入卡片的视图块类型。 */
const BLOCK_TYPES = ['user', 'stream', 'text', 'reason', 'toolcard'];

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
export function createNavigator({ log, dataDir, config, onebot, hooks = {} }) {
  const navConfig = config?.navigator ?? {};
  const state = createNavigatorState({ file: path.join(dataDir, 'navigator.json'), log });
  const ch4 = createCh4Client({ log, mainPort: Number(navConfig.mainPort) || 8080 });
  const watcher = createCatWatcher({ log });
  const shot = createShotService({ log, dataDir, hooks, vision: loadVision() });
  const idleCloseMs = Number(navConfig.idleCloseMs) || IDLE_CLOSE_MS;
  const services = Array.isArray(navConfig.services) ? navConfig.services : [];
  const vipUser = String(navConfig.vipUser || '');
  let watchTimer = null;
  let ticking = false;

  /** 在途订阅：猫 key → 会话 { key, chat, port, blocks, startedAt, done }。 */
  const sessions = new Map();

  /** 活动流（最近 40 条）——观测窗口：订阅 / 事件 / 截图 / 发群都留痕。 */
  const activity = [];

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
   * @returns {Promise<object>} 结果
   */
  async function sayImage(chat, file, caption = '') {
    if (chat === null || chat === undefined || chat === '') return { ok: false, error: '未指定群' };
    const message = [];
    if (caption && String(caption).trim()) message.push({ type: 'text', data: { text: String(caption) } });
    message.push({ type: 'image', data: { file: `file:///${String(file).replace(/\\/g, '/')}` } });
    try {
      await onebot.call('send_group_msg', { group_id: Number(chat) || chat, message });
      log.info('navigator', `已发图到群 ${chat}：${path.basename(file)}`);
      return { ok: true };
    } catch (error) {
      log.error('navigator', `发图失败（${chat}）：${error?.message ?? error}`);
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
   * 为一只猫建立持久观测（领航员开启期间常驻——任何一轮回复都截图发群，无例外）。
   *
   * @param {object} row 猫状态（cat 清单条目）
   * @returns {Promise<object|null>} 观测会话
   */
  async function armCat(row) {
    const key = String(row?.id ?? '');
    if (!key || sessions.has(key)) return sessions.get(key) ?? null;
    const port = Number(row?.port) || await ch4.portOf(key);
    if (!port) {
      record('error', `未取到 ${key} 的对话端口，跳过观测`);
      return null;
    }
    const session = {
      key, name: String(row?.name || key), port, chat: null,
      blocks: [], startedAt: Date.now(), sawRun: false, pollTimer: null, done: false
    };
    sessions.set(key, session);
    await watcher.subscribe({
      key,
      port,
      onEvent: (frame) => onCatEvent(session, frame),
      onClose: () => { /* 持久观测：断线不自动重连（下一轮 armAll 会补） */ }
    });
    session.pollTimer = setInterval(() => {
      pollRoundEnd(session).catch(() => { /* 内部已留痕 */ });
    }, POLL_INTERVAL_MS);
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

  /** 撤除全部观测。 */
  function disarmAll() {
    for (const session of sessions.values()) {
      session.done = true;
      if (session.pollTimer) clearInterval(session.pollTimer);
      watcher.unwatch(session.key);
    }
    sessions.clear();
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
    // ② view 事件：每猫端口推的是「视图状态」（v/state/persist/live），不是渲染块——
    //    渲染块在收尾时拉 /api/v1/keyinfo 取（2026-10-11 实测）。带 renderType 的形态仍兼容。
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
   * 轮结束收尾——渲染截图 → 图片解读 → 发群。
   *
   * @param {object} session 观测会话
   * @param {object} roundsum 轮结算块
   * @returns {Promise<void>} 完成
   */
  async function finishSession(session) {
    if (session.done) return;
    // 立刻推进观测点——本轮内容归本次，下一轮从此刻起算（持久观测不撤订）
    const since = session.startedAt;
    const pendingBlocks = session.blocks.slice();
    session.startedAt = Date.now();
    session.sawRun = false;
    session.blocks = [];

    // 渲染块来源：优先 keyinfo（每猫端口唯一可用的会话正文端点）；拉不到再回落 SSE 攒的块
    let blocks = pendingBlocks;
    try {
      const info = await ch4.keyinfo(session.key, 12);
      const fromKeyinfo = itemsToBlocks(info?.items, since);
      if (fromKeyinfo.length > 0) blocks = fromKeyinfo;
    } catch (error) {
      record('error', `拉 ${session.name} 会话关键信息失败：${error?.message ?? error}`);
    }
    const at = new Date().toLocaleString('zh-CN', { hour12: false });
    const catName = session.name || await catNameOf(session.key);
    let png = '';
    try {
      png = await shot.shoot({ catName, blocks, at });
    } catch (error) {
      log.error('navigator', `截图失败（${session.key}）：${error?.message ?? error}`);
    }
    if (!png) {
      record('error', `${session.key} 截图失败——本轮无图可发`);
      return;
    }
    record('shot', `${catName} 截图完成：${path.basename(png)}（${blocks.length} 块）`);
    const insight = await shot.analyze(png);
    const chat = resolveChat(session.chat) ?? state.snapshot().activeChat;
    if (!chat) {
      log.warn('navigator', '没有回消息群，截图未发出');
      return;
    }
    const caption = insight ? `${catName} 的回复到了：\n${insight}` : `${catName} 的回复到了。`;
    const sent = await sayImage(chat, png, caption);
    record(sent.ok ? 'send' : 'error', sent.ok ? `已发图到群 ${chat}` : `发图失败：${sent.error}`);
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
   * @returns {Promise<object>} { ok, state, health, receipt }
   */
  async function open({ by = 'app', chat = null, receipt = true, requireVip = false } = {}) {
    if (requireVip && !vipFresh()) {
      return { ok: false, error: `${vipUser || '指定 QQ'} 近期没有在本群 @ 我——领航员只接受该 QQ 触发` };
    }
    state.open({ by, chat: resolveChat(chat) });
    const report = await health();
    const text = renderReceipt(report);
    if (receipt && state.snapshot().activeChat) {
      await say(state.snapshot().activeChat, text);
    }
    // 开场巡检：对「有会话」的猫把最后一段会话截成卡片发群（Rushiera 2026-10-11 要求——
    // 有会话正文内容的猫不算待命，也要能看到它最后说了什么）
    if (receipt) {
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
        const info = await ch4.keyinfo(row.id, 20);
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
        record(sent.ok ? 'send' : 'error', sent.ok ? `开场巡检已发图（${row.name}）` : `开场巡检发图失败：${sent.error}`);
      } catch (error) {
        record('error', `开场巡检（${row.name}）失败：${error?.message ?? error}`);
      }
    }
  }

  /**
   * 等某猫出「本轮回复」——按 keyinfo 轮询，返回回复正文（超时返回已拿到的部分）。
   *
   * @param {string} key 猫 key
   * @param {object} options 选项
   * @param {number} options.since 起点时刻
   * @param {number} [options.timeoutMs] 超时毫秒
   * @returns {Promise<string>} 回复正文
   */
  async function waitForReply(key, { since, timeoutMs = 240000 }) {
    const deadline = Date.now() + timeoutMs;
    let best = '';
    while (Date.now() < deadline) {
      try {
        const info = await ch4.keyinfo(key, 8);
        const rows = (Array.isArray(info?.items) ? info.items : []).filter((row) => Number(row.time) >= since);
        const reply = rows.filter((row) => row.role === 'reply')
          .map((row) => String(row.content ?? '').trim())
          .filter(Boolean)
          .join('\n\n');
        if (reply) best = reply;
        if (reply && rows.some((row) => row.role === 'roundsum')) return reply;
      } catch { /* 单次失败继续轮询 */ }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return best;
  }

  /**
   * 前文整理重启——收工整理 → 新会话 → 注入交接摘要 → 自动继续（全自动，无人干预）。
   *
   * @param {object} options 选项
   * @param {string} options.key 目标猫
   * @param {string|number} [options.chat] 回报群
   * @returns {Promise<object>} 结果
   */
  async function resetSession({ key, chat = null }) {
    const resolved = await ch4.resolveKey(key);
    const name = await catNameOf(resolved);
    const target = resolveChat(chat);
    record('reset', `${name}：前文整理重启开始`);

    // ① 收工整理——让它把工作状态写成交接摘要（不调工具）
    const askAt = Date.now();
    await ch4.send(resolved, [
      '【领航员·前文整理】你现在做一次**完整收工**，按顺序：',
      '① 落盘——把该写的写进文件（进度 / 变更 / 设计文档 / todo / CHANGELOG，按你所在项目的收工清单）。',
      '② **推 git**——把当前工作提交并推送（能推的都推掉，别留着）。',
      '③ 然后输出一份**交接摘要**——要足量、详尽，宁多勿漏；接手方是你的下一个会话，它只有这份摘要，猜不到你没写的：',
      '   · 任务全貌与背景（在做什么、为什么做）',
      '   · 已完成的步骤与做法（关键路径 / 命令 / 文件 / 接口）',
      '   · 未完成事项与下一步',
      '   · 关键结论、踩过的坑、被否决的方案与原因',
      '   · 继续工作所必需的上下文（路径 / 参数 / 约定 / 凭证位置）',
      '   · 不确定或待确认的点（明确标注，别让接手方当成事实）',
      '',
      '①②做完再输出摘要；摘要只输出正文（纯文本，小标题 + 列表），篇幅不设上限。'
    ].join('\n'));
    const summary = await waitForReply(resolved, { since: askAt - 2000 });
    if (!summary) {
      record('error', `${name}：交接摘要未取到，整理中止`);
      return { ok: false, error: '交接摘要未取到' };
    }
    record('reset', `${name}：交接摘要已取到（${summary.length} 字符）`);

    // ② 新会话——清前文 + 重新注入
    const newSession = await ch4.command(`cat.new-session ${resolved}`, ch4.mainPort);
    record('reset', `${name}：新会话已请求（${JSON.stringify(newSession).slice(0, 80)}）`);
    await new Promise((resolve) => setTimeout(resolve, 8000));

    // ③ 注入交接摘要 + ④ 自动继续（同一条消息即"继续"）
    const injectAt = Date.now();
    await ch4.send(resolved, [
      '【交接摘要·来自上一段会话】',
      summary,
      '',
      '以上是你上一段工作的交接摘要（前文已按此重置）。请据此继续工作——先确认你已接上，再推进未完成的事项。'
    ].join('\n'));
    record('reset', `${name}：交接摘要已注入，等待确认`);

    // ⑤ 等它接上（回复由持久观测自动截图发群，不额外截图）
    const ack = await waitForReply(resolved, { since: injectAt - 2000, timeoutMs: 180000 });
    record('reset', `${name}：整理重启完成${ack ? '' : '（未见确认回复，可能仍在跑）'}`);
    if (target) {
      await say(target, `前文整理重启完成：${name}${ack ? ' 已接上并继续' : ' 已注入交接摘要，正在接上'}。`);
    }
    return { ok: true, key: resolved, name, summary, ack };
  }

  /**
   * 关闭领航员。
   *
   * @param {object} options 选项
   * @param {string} [options.reason] 原因（manual / idle）
   * @param {boolean} [options.notify] 是否在回消息群告知
   * @returns {Promise<object>} 状态快照
   */
  async function close({ reason = 'manual', notify = false } = {}) {
    const before = state.snapshot();
    const next = state.close(reason);
    disarmAll();
    if (notify && before.activeChat) {
      const text = reason === 'idle'
        ? '领航员已暂关——全体猫停工且 30 分钟没有新指令。需要时在应用内打开，或 @我 说「打开领航员」。'
        : '领航员已关闭。需要时在应用内打开，或 @我 说「打开领航员」。';
      await say(before.activeChat, text);
    }
    return next;
  }

  /**
   * 投递一条指令给猫（同时记账：回消息群跟随、指令流水；并登记观测）。
   *
   * @param {object} options 选项
   * @param {string} options.key 目标猫（id / 显示名 / majordomo）
   * @param {string} options.text 指令内容
   * @param {string|number} [options.chat] 来源群
   * @param {boolean} [options.sourceTag] 是否加 QQ 来源头（默认 true）
   * @param {boolean} [options.watch] 是否登记观测（默认 true）
   * @returns {Promise<object>} { ok, key, text, reply, watch }
   */
  async function send({ key, text, chat = null, sourceTag = true, watch = true }) {
    const content = sourceTag
      ? `[来自QQ][群@|Rushiera(群主)·本人] ${String(text ?? '').trim()}`
      : String(text ?? '').trim();
    const chatResolved = resolveChat(chat);
    const result = await ch4.send(key, content);
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
    const since = snap.lastCommandAt || snap.openedAt;
    if (!since || Date.now() - since < idleCloseMs) return;
    ticking = true;
    try {
      const cats = await ch4.cats();
      const working = cats.filter((row) => row?.runState && row.runState !== 'idle');
      if (working.length > 0) return;
      log.info('navigator', '全猫停工且无指令超时——自动暂关');
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

  /** 停止守护（含订阅）。 */
  function stop() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    watcher.stopAll();
    sessions.clear();
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
      body: await close({ reason: body?.reason || 'manual', notify: body?.notify === true })
    }),
    'POST /api/nav/send': async ({ body }) => ({
      body: await send({
        key: body?.key || 'majordomo',
        text: body?.text || '',
        chat: body?.chat ?? null,
        sourceTag: body?.sourceTag !== false,
        watch: body?.watch !== false
      })
    }),
    'POST /api/nav/say': async ({ body }) => ({ body: await say(body?.chat, body?.text) }),
    'POST /api/nav/shot': async ({ body }) => ({
      body: await (async () => {
        const catName = await catNameOf(body?.key || 'majordomo');
        const blocks = Array.isArray(body?.blocks) && body.blocks.length
          ? body.blocks
          : [{ renderType: 'user', text: '（手动截图测试）' }];
        const png = await shot.shoot({ catName, blocks, at: new Date().toLocaleString('zh-CN', { hour12: false }) });
        return { ok: true, file: png, insight: await shot.analyze(png) };
      })()
    }),
    'GET /api/nav/detail': async ({ query }) => ({ body: await ch4.detail(query.get('key') || 'majordomo') }),
    'POST /api/nav/reset': async ({ body }) => {
      const key = body?.key || 'majordomo';
      resetSession({ key, chat: body?.chat ?? null })
        .catch((error) => record('error', `整理重启失败（${key}）：${error?.message ?? error}`));
      return { body: { ok: true, accepted: true, key, hint: '整理重启已在后台执行——进度看活动流' } };
    }
  };

  return {
    state, ch4, watcher, shot,
    health, renderReceipt, open, close, send, status, say, sayImage,
    armCat, armAll, disarmAll, resetSession, waitForReply,
    start, stop, api, idleCloseMs
  };
}
