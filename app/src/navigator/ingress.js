// navigator/ingress.js —— 群消息接入与分流（N6 第二刀：入口扩展 + 判断器接线）
//
// 职责：接管**全部**群消息（不再只认 VIP 群 @），做三件事：
//   ① 维护「本群最近带图消息」环形缓冲——补上业务面 `store.findByMid/recent` 的依赖（R3-L8 #10 唯一真耦合）
//   ② 交意图判断器分类（intent.js）
//   ③ 按 mode 处置：
//        shadow —— 只落采集行（data/metrics/intent-<日期>.jsonl），**零行为**
//        live   —— 由判断结果直调领航员（开关 / 只读 / 生成 / 投递），不再经业务面模型判断
// 边界：不接管猫的会话；不做发言纪律（那是业务面闲聊面的事）；VIP 闸只在 live 的写动作上。
// 设计：design-qqbotb-navigator.md §十二 · reports/R3-L8.md §二 #2/#3/#10。

import fs from 'node:fs';
import path from 'node:path';

/** 每群保留的带图消息条数（环形缓冲上限）。 */
const IMAGE_BUFFER_MAX = 40;

/** 采集行文件保留天数。 */
const METRICS_KEEP_DAYS = 30;

/**
 * 从消息段里取纯文本（@ 段去掉，其余文本拼接）。
 *
 * @param {Array<object>} message 消息段
 * @returns {string} 正文
 */
export function textOf(message) {
  if (!Array.isArray(message)) return '';
  return message
    .filter((seg) => seg?.type === 'text')
    .map((seg) => String(seg?.data?.text ?? ''))
    .join('')
    .trim();
}

/**
 * 从消息段里取图片（image 段——url 或 file）。
 *
 * @param {Array<object>} message 消息段
 * @returns {{url: string, file: string}|null} 图片
 */
export function imageOf(message) {
  if (!Array.isArray(message)) return null;
  for (const seg of message) {
    if (seg?.type !== 'image') continue;
    const url = String(seg?.data?.url ?? '').trim();
    const file = String(seg?.data?.file ?? '').trim();
    if (url || file) return { url, file };
  }
  return null;
}

/**
 * 日期键（本地时区 yyyy-MM-dd）。
 *
 * @param {number} ts 时间戳
 * @returns {string} 日期
 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 创建群消息接入。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.dataDir 数据目录
 * @param {object} options.config 生效配置（读 navigator.ingress）
 * @param {object} options.intent 意图判断服务
 * @param {Function} options.handlers 处置回调集合（live 用）
 *   handlers.switch({chat, action, atMe}) · handlers.readonly({chat, action, key, text, atMe})
 *   · handlers.generate({chat, action, text, image, atMe}) · handlers.send({chat, key, text, atMe})
 *   · handlers.isEnabled() → boolean
 * @returns {object} 接入服务
 */
export function createIngress({ log, dataDir, config = {}, intent, handlers = {} }) {
  const conf = config?.navigator?.ingress ?? {};
  const vipUser = String(config?.navigator?.vipUser ?? '').trim();
  // 运行时可调（N6 切换面）——不改配置、不重启即能试跑与回退：
  //   mode:  shadow 只落采集行（默认）· live 由判断器直调领航员
  //   allow: live 下逐类放行（切换是渐进的）；null/空 = 全放行
  // 初值取配置，之后由 setMode / setAllow 覆盖（持久化归调用方，本模块不写配置）。
  let mode = conf.mode === 'live' ? 'live' : 'shadow';
  let allowList = Array.isArray(conf.allow) && conf.allow.length > 0
    ? conf.allow.map((item) => String(item).trim()).filter(Boolean)
    : null;

  /**
   * 该类动作是否放行到 live 处置。
   *
   * @param {string} action 动作类（switch / readonly / shot / generate / send / session）
   * @returns {boolean} 是否放行
   */
  function allowed(action) {
    if (mode !== 'live') return false;
    return allowList === null || allowList.includes(action);
  }

  /**
   * 运行时切换模式（shadow ↔ live）——不落配置，重启即回配置值。
   *
   * @param {string} next shadow / live
   * @returns {string} 生效后的模式
   */
  function setMode(next) {
    const value = next === 'live' ? 'live' : 'shadow';
    if (value !== mode) log?.warn?.('navigator', `意图接入模式切换：${mode} → ${value}`);
    mode = value;
    return mode;
  }

  /**
   * 运行时设放行清单（空 = 全放行）。
   *
   * @param {Array<string>} list 动作类清单
   * @returns {Array<string>|null} 生效后的清单
   */
  function setAllow(list) {
    allowList = Array.isArray(list) && list.length > 0
      ? list.map((item) => String(item).trim()).filter(Boolean)
      : null;
    return allowList;
  }
  const metricsDir = path.join(dataDir, 'metrics');

  /** 群号 → 最近的带图消息 [{ mid, at, image }]。 */
  const imageBuffers = new Map();

  /** 统计（status 面用）。 */
  const stats = { seen: 0, shadow: 0, live: 0, dispatched: 0, skipped: 0, lastAt: 0, lastKind: '' };

  /**
   * 落一行采集（失败只留痕，绝不阻断）。
   *
   * @param {object} row 采集行
   * @returns {void}
   */
  function appendMetric(row) {
    try {
      fs.mkdirSync(metricsDir, { recursive: true });
      const file = path.join(metricsDir, `intent-${dayKey()}.jsonl`);
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('navigator', `意图采集落盘失败：${error?.message ?? error}`);
    }
  }

  /**
   * 清理过期采集文件（按 mtime）。
   *
   * @returns {void}
   */
  function sweepMetrics() {
    try {
      const cutoff = Date.now() - METRICS_KEEP_DAYS * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(metricsDir)) {
        if (!name.startsWith('intent-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(metricsDir, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      }
    } catch {
      // 目录不存在 / 无权限——清理是尽力而为，不阻断
    }
  }

  /**
   * 记一条带图消息（环形缓冲）。
   *
   * @param {string} chat 群号
   * @param {object} entry 条目 { mid, at, image }
   * @returns {void}
   */
  function rememberImage(chat, entry) {
    const list = imageBuffers.get(chat) ?? [];
    list.push(entry);
    if (list.length > IMAGE_BUFFER_MAX) list.splice(0, list.length - IMAGE_BUFFER_MAX);
    imageBuffers.set(chat, list);
  }

  /**
   * 取某群最近一条带图消息——`messageId` 给定时优先精确命中。
   *
   * @param {string|number} chat 群号
   * @param {string|number} [messageId] 消息 #号
   * @returns {{mid: string, image: {url: string, file: string}}|null} 图片条目
   */
  function recentImage(chat, messageId) {
    const list = imageBuffers.get(String(chat)) ?? [];
    const mid = String(messageId ?? '').trim();
    if (mid) {
      const hit = [...list].reverse().find((row) => String(row.mid) === mid);
      if (hit) return hit;
    }
    return [...list].reverse()[0] ?? null;
  }

  /**
   * 处理一条群消息（影子 / 实投）。
   *
   * @param {object} payload OneBot 事件体
   * @param {object} ctx 上下文 { self, atMe }
   * @returns {Promise<object|null>} 判断结果（非群消息 / 非文本返回 null）
   */
  async function handleMessage(payload, ctx = {}) {
    if (payload?.post_type !== 'message' || payload?.message_type !== 'group') return null;
    const chat = String(payload?.group_id ?? '');
    const userId = String(payload?.user_id ?? '');
    const text = textOf(payload?.message) || String(payload?.raw_message ?? '').trim();
    const image = imageOf(payload?.message);
    const mid = String(payload?.message_id ?? '');

    if (image) rememberImage(chat, { mid, at: Date.now(), image });
    if (!text && !image) return null;

    stats.seen += 1;
    stats.lastAt = Date.now();

    const enabled = typeof handlers.isEnabled === 'function' ? handlers.isEnabled() === true : false;
    const verdict = await intent.classify({ text, atMe: ctx.atMe === true, enabled });
    stats.lastKind = verdict.kind;

    const row = {
      ts: Date.now(),
      chat,
      user: userId,
      vip: userId === vipUser,
      atMe: ctx.atMe === true,
      enabled,
      mode,
      chars: String(text).length,
      hasImage: Boolean(image),
      kind: verdict.kind,
      action: verdict.action,
      target: verdict.target,
      via: verdict.via,
      reason: verdict.reason,
      head: String(text).slice(0, 80)
    };

    if (mode === 'shadow') {
      stats.shadow += 1;
      appendMetric({ ...row, result: 'shadow' });
      return verdict;
    }

    // ── live：只有本人能在群里指挥（与 nav_open / nav_send 的 VIP 闸同口径）──
    stats.live += 1;
    if (userId !== vipUser) {
      stats.skipped += 1;
      appendMetric({ ...row, result: 'skip:not-vip' });
      return verdict;
    }
    if (verdict.action === 'none') {
      stats.skipped += 1;
      appendMetric({ ...row, result: 'skip:chat' });
      return verdict;
    }
    if (!allowed(verdict.action)) {
      stats.skipped += 1;
      appendMetric({ ...row, result: `skip:not-allowed:${verdict.action}` });
      return verdict;
    }

    try {
      if (verdict.action === 'switch') {
        await handlers.switch?.({ chat, action: verdict.switch || '', atMe: ctx.atMe === true });
      } else if (verdict.action === 'session') {
        await handlers.session?.({
          chat,
          session: verdict.session || 'new',
          key: verdict.target,
          text: verdict.text || '',
          atMe: ctx.atMe === true
        });
      } else if (verdict.action === 'readonly' || verdict.action === 'shot') {
        await handlers.readonly?.({ chat, action: verdict.action, key: verdict.target, text, atMe: ctx.atMe === true });
      } else if (verdict.action === 'generate') {
        const picked = recentImage(chat);
        await handlers.generate?.({
          chat,
          action: verdict.action,
          text: verdict.text || text,
          image: picked?.image ?? null,
          atMe: ctx.atMe === true
        });
      } else if (verdict.action === 'send') {
        await handlers.send?.({ chat, key: verdict.target || 'majordomo', text: verdict.text || text, atMe: ctx.atMe === true });
      }
      stats.dispatched += 1;
      appendMetric({ ...row, result: 'live:dispatched' });
    } catch (error) {
      stats.skipped += 1;
      appendMetric({ ...row, result: `live:error:${error?.message ?? error}` });
      log?.warn?.('navigator', `意图分流失败（${verdict.action}）：${error?.message ?? error}`);
    }
    return verdict;
  }

  /**
   * 启动（清一次过期采集）。
   *
   * @returns {void}
   */
  function start() {
    sweepMetrics();
    log?.info?.('navigator', `意图接入已就绪（mode=${mode}）`);
  }

  /**
   * 状态快照。
   *
   * @returns {object} 快照
   */
  function status() {
    return { mode, allow: allowList, ...stats, bufferedChats: imageBuffers.size };
  }

  return {
    handleMessage, recentImage, status, start, textOf, imageOf, allowed,
    setMode, setAllow,
    get mode() { return mode; },
    get allow() { return allowList; }
  };
}
