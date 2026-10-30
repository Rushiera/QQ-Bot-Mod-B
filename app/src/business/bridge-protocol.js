// bridge-protocol.js —— 单体 ⇄ 业务面子进程 的事件桥协议（纯常量 + 纯函数）
//
// 职责：定义 IPC 消息类型、进程退出码、队列/去重上限、事件指纹算法。
// 边界：不持有任何连接、不 import 宿主模块——单体侧（app/src/business.js）与
//       子进程侧（event-bridge.js / worker.js）双方共用一份，避免两处各写一套口径。
//
// 为什么需要指纹：单条 WS 在单体侧收事件，转发给子进程。断线重连、父侧重启、
// 协议端重放都会让同一条消息再进来一次；业务面对同一条消息消费两次 = 群里回两遍。

/** 协议版本：两侧不一致时父侧拒绝投递并在日志出声（不静默降级）。 */
export const BRIDGE_VERSION = 1;

/** IPC 消息类型（父 → 子 / 子 → 父 共用一个枚举，方向由 type 决定）。 */
export const MSG = Object.freeze({
  READY: 'bridge-ready',        // 子 → 父：业务面 HTTP 已监听（带 pid / port）
  STATUS: 'bridge-status',      // 父 → 子：协议端连接态快照（connected / selfInfo）
  EVENT: 'bridge-event',        // 父 → 子：一条 OneBot 事件（带单调 seq）
  PING: 'bridge-ping',          // 父 → 子：健康探针
  PONG: 'bridge-pong',          // 子 → 父：探针应答（带 seq / stats）
  ERROR: 'bridge-error',        // 子 → 父：启动期或运行期致命错误（带 code）
  SHUTDOWN: 'bridge-shutdown'   // 父 → 子：优雅停止
});

/**
 * 子进程退出码（父侧按码判定重试策略）。
 *
 * · OK(0)      —— 正常退出（收到 SHUTDOWN / 父侧断开）
 * · FATAL(1)   —— 运行期未捕获异常（重启有意义的概率低，但仍按退避重试）
 * · STARTUP(70) —— 启动失败（端口耗尽 / HTTP 监听失败）
 * · CONFIG(78) —— 配置或数据根错（未注入 QQ_AGENT_DATA_DIR / 单实例锁被占）——
 *                 这一类重试必然同样失败，父侧只重启一次即降级。
 */
export const EXIT_CODE = Object.freeze({
  OK: 0,
  FATAL: 1,
  STARTUP: 70,
  CONFIG: 78
});

/** 队列与去重的容量上限——超限必须计数暴露（集合缩水不出声属静默失败）。 */
export const LIMITS = Object.freeze({
  /** 单消费者等待队列上限（条）。溢出计入 status.dropped，绝不静默丢弃。 */
  pendingMax: 2000,
  /** 事件指纹表容量（条）——FIFO 淘汰最早一条。 */
  dedupWindow: 4096,
  /** 指纹有效期（毫秒）——过期后同一指纹视为新事件（防长跑进程表无限膨胀）。 */
  dedupTtlMs: 10 * 60 * 1000,
  /** 子进程 ready 前的缓冲上限（条）。 */
  bufferMax: 2000
});

/**
 * 32 位 FNV-1a 哈希（十六进制 8 位）——只用于兜底指纹，不用于安全场景。
 *
 * @param {string} text 输入
 * @returns {string} 十六进制哈希
 */
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 稳定序列化（对象键按码点排序）——同一内容必得同一串，供兜底指纹用。
 *
 * @param {*} value 任意 JSON 值
 * @returns {string} 规范化字符串
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 计算一条 OneBot 事件的去重指纹。
 *
 * 返回空串 = 该事件不参与去重（心跳类周期性事件，内容相同属正常）。
 *
 * 判据分层：
 *   1. meta_event（heartbeat / lifecycle）—— 心跳内容周期性重复，去重会误杀 → 不指纹
 *   2. 带 message_id 的消息（message / message_sent）→ `msg:<post_type>:<id>`
 *      （message_id 由协议端分配，同一条消息重放必同 id，这是最可靠的判据）
 *   3. notice / request —— 无 id，用「类型 + 时间 + 参与方」组合键
 *   4. 其余 —— type + time + 整串哈希兜底
 *
 * @param {object} event OneBot 事件体
 * @returns {string} 指纹（空串 = 不去重）
 */
export function eventFingerprint(event) {
  if (!event || typeof event !== 'object') return '';
  const postType = String(event.post_type || '');

  // 1. 元事件：心跳本来就是"同样内容反复来"，去重会把正常心跳吃掉
  if (postType === 'meta_event') return '';

  // 2. 消息类：message_id 是协议端分配的稳定标识
  const msgId = event.message_id ?? event.message?.message_id ?? null;
  if (msgId !== null && String(msgId).trim() !== '') {
    return `msg:${postType || 'message'}:${String(msgId).trim()}`;
  }

  // 3. 通知 / 请求：无 id，用参与方组合键（时间戳到秒，OneBot time 字段即如此）
  if (postType === 'notice' || postType === 'request') {
    return [
      postType,
      event.notice_type ?? event.request_type ?? '',
      event.sub_type ?? '',
      event.time ?? '',
      event.self_id ?? '',
      event.group_id ?? '',
      event.user_id ?? '',
      event.operator_id ?? '',
      event.target_id ?? ''
    ].join('|');
  }

  // 4. 兜底：类型 + 时间 + 整串哈希
  return `raw:${postType}:${event.time ?? ''}:${hash32(stableStringify(event))}`;
}
