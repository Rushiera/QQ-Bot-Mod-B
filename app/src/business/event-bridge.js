// event-bridge.js —— 业务面子进程侧的事件桥（IPC → 本进程订阅）
//
// 职责：把父进程经 IPC 推来的 OneBot 事件转成本进程的事件源，并回传健康应答 / 致命错误。
// 边界：
//   · 只做「收 → 分发」，不解析业务语义（消息入库、编排在 app.js 及其下各模块）。
//   · 不重连、不缓存事件内容——重连归单体侧（一条 WS），本侧只是消费者。
//
// 与另一个消费者的关系（不丢不重的第二道闸门）：
//   父侧按事件指纹去重后给每条事件编单调递增 seq；本侧对 `seq <= lastSeq` 的一律丢弃并计数。
//   防的是「父侧进程重启后重投」「IPC 层重放」这类父侧去重表已丢失之后才出现的重复。

import { MSG, LIMITS, BRIDGE_VERSION } from './bridge-protocol.js';

/**
 * 创建子进程侧事件桥。
 *
 * @param {object} [options] 选项
 * @param {Function|null} [options.send] IPC 发送函数（默认取 process.send；无 IPC 时为 null）
 * @param {string} [options.label] 通道标识（日志用）
 * @param {object} [options.limits] 容量上限（默认取 LIMITS）
 * @param {Function|null} [options.log] 日志函数（缺省 console.log）
 * @returns {object} 桥接口
 */
export function createEventBridge({
  send = typeof process.send === 'function' ? process.send.bind(process) : null,
  label = 'ipc',
  limits = LIMITS,
  log = null
} = {}) {
  const write = typeof log === 'function' ? log : console.log;
  const eventListeners = new Set();
  const statusListeners = new Set();
  const shutdownListeners = new Set();

  const state = {
    label,
    version: BRIDGE_VERSION,
    hasChannel: !!send,
    received: 0,        // 收到的有效事件条数
    duplicates: 0,      // seq 回退被丢弃的条数
    failures: 0,        // 消费者抛错次（逐条隔离，不中断后续）
    lastSeq: 0,
    connected: false,   // 协议端连接态（由父侧 STATUS 驱动）
    selfInfo: null,
    lastEventAt: 0
  };

  let closed = false;

  /**
   * 安全发送一条 IPC 消息（无通道 / 通道已断时返回 false，不抛）。
   *
   * @param {object} message 消息体
   * @returns {boolean} 是否发出
   */
  function sendSafe(message) {
    if (!send || closed) return false;
    try {
      send(message);
      return true;
    } catch (error) {
      write(`[bridge] IPC 发送失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 记录一次消费者失败（逐条隔离：一条抛错不打断该消费者后续事件）。
   *
   * @param {Error|*} error 异常
   * @returns {void}
   */
  function onFail(error) {
    state.failures += 1;
    write(`[bridge] 事件处理异常（已隔离，第 ${state.failures} 次）：${error?.message ?? error}`);
  }

  /**
   * 把一条事件投给全部订阅者——同步异常与异步 rejection 都各自吞掉并计数。
   *
   * @param {object} event OneBot 事件体
   * @returns {void}
   */
  function deliver(event) {
    state.received += 1;
    state.lastEventAt = Date.now();
    for (const fn of eventListeners) {
      try {
        const result = fn(event);
        if (result && typeof result.then === 'function') result.catch(onFail);
      } catch (error) {
        onFail(error);
      }
    }
  }

  /**
   * 处理父进程消息。
   *
   * @param {object} message 消息体
   * @returns {void}
   */
  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case MSG.EVENT: {
        if (typeof message.seq === 'number') {
          if (message.seq <= state.lastSeq) {
            state.duplicates += 1;
            write(`[bridge] 丢弃重复事件（seq ${message.seq} ≤ ${state.lastSeq}，累计 ${state.duplicates} 条）`);
            return;
          }
          state.lastSeq = message.seq;
        }
        deliver(message.payload);
        break;
      }
      case MSG.STATUS: {
        state.connected = message.connected === true;
        if (message.selfInfo !== undefined) state.selfInfo = message.selfInfo ?? null;
        for (const fn of statusListeners) {
          try {
            fn({ connected: state.connected, selfInfo: state.selfInfo });
          } catch (error) {
            write(`[bridge] 状态订阅者异常（已隔离）：${error?.message ?? error}`);
          }
        }
        break;
      }
      case MSG.PING: {
        sendSafe({
          type: MSG.PONG,
          seq: message.seq ?? 0,
          connected: state.connected,
          received: state.received,
          duplicates: state.duplicates,
          failures: state.failures,
          lastSeq: state.lastSeq
        });
        break;
      }
      case MSG.SHUTDOWN: {
        for (const fn of shutdownListeners) {
          try {
            fn();
          } catch (error) {
            write(`[bridge] 停机回调异常（已隔离）：${error?.message ?? error}`);
          }
        }
        break;
      }
      default: {
        write(`[bridge] 未知消息类型（已忽略）：${String(message.type)}`);
      }
    }
  }

  if (send) process.on('message', onMessage);

  return {
    /** 通道标识。 */
    get label() { return state.label; },

    /** 是否有 IPC 通道（独立运行模式下为 false——不会收到任何事件）。 */
    get hasChannel() { return state.hasChannel; },

    /**
     * 订阅事件。
     *
     * @param {Function} fn 处理函数（可返回 Promise）
     * @returns {Function} 取消订阅
     */
    subscribe(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },

    /**
     * 订阅协议端连接态（父侧 STATUS 驱动）。
     *
     * @param {Function} fn 处理函数
     * @returns {Function} 取消订阅
     */
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },

    /**
     * 订阅优雅停机指令。
     *
     * @param {Function} fn 回调
     * @returns {Function} 取消订阅
     */
    onShutdown(fn) {
      shutdownListeners.add(fn);
      return () => shutdownListeners.delete(fn);
    },

    /**
     * 上报业务面已就绪（父侧据此做健康检查并开始投递）。
     *
     * @param {object} info `{ pid, port, dataDir, startedInMs }`
     * @returns {boolean} 是否发出
     */
    ready(info = {}) {
      return sendSafe({ type: MSG.READY, version: state.version, ...info });
    },

    /**
     * 上报致命错误（父侧据此判定是否重启）。
     *
     * @param {object} info `{ code, message }`
     * @returns {boolean} 是否发出
     */
    reportError(info = {}) {
      return sendSafe({ type: MSG.ERROR, version: state.version, ...info });
    },

    /**
     * 取桥统计快照（父侧 PONG 与本地日志共用）。
     *
     * @returns {object} 统计
     */
    stats() {
      return {
        label: state.label,
        hasChannel: state.hasChannel,
        received: state.received,
        duplicates: state.duplicates,
        failures: state.failures,
        lastSeq: state.lastSeq,
        connected: state.connected,
        lastEventAt: state.lastEventAt,
        bufferMax: limits.bufferMax
      };
    },

    /** 关闭桥（摘掉 IPC 监听，不再分发）。 */
    close() {
      closed = true;
      try { process.off('message', onMessage); } catch { /* 无监听时忽略 */ }
      eventListeners.clear();
      statusListeners.clear();
      shutdownListeners.clear();
    }
  };
}
