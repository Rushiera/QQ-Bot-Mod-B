// navigator/watch.js —— 猫回复订阅（SSE）
//
// 职责：连某猫对话端口的 /api/v1/stream，把事件按帧解析后交给上层；
//       断开时回调通知（由上层决定是否重连）。
// 边界：只做连接与解析，不做判据（「本轮结束」的判定归 index.js）。
// 协议权威：Project/CH4/design-ch4-protocol.md §四（事件流）。

/** SSE 帧分隔（兼容 LF / CRLF——Kestrel 用 CRLF，只按 '\n\n' 找会一帧都切不出来）。 */
const FRAME_SEP = /\r?\n\r?\n/;

/**
 * 解析一段 SSE 帧（`event: x\ndata: {...}`）。
 *
 * @param {string} raw 帧文本
 * @returns {object|null} { event, data } 或 null
 */
function parseFrame(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of String(raw).split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * 创建猫回复订阅器。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @returns {object} 订阅器接口
 */
export function createCatWatcher({ log }) {
  /** key → AbortController（同一猫只保留一个订阅）。 */
  const active = new Map();

  /**
   * 取消某猫的订阅。
   *
   * @param {string} key 猫 key
   * @returns {void}
   */
  function unwatch(key) {
    const controller = active.get(key);
    if (!controller) return;
    active.delete(key);
    try { controller.abort(); } catch { /* 已关闭 */ }
  }

  /**
   * 订阅某猫的事件流。
   *
   * @param {object} options 选项
   * @param {string} options.key 猫 key（寻址用）
   * @param {number} options.port 对话端口
   * @param {Function} options.onEvent 事件回调（{event, data}）
   * @param {Function} [options.onClose] 断开回调（非主动取消时）
   * @returns {Promise<void>} 订阅建立即返回（读取在后台）
   */
  async function subscribe({ key, port, onEvent, onClose }) {
    unwatch(key);
    const controller = new AbortController();
    active.set(key, controller);

    (async () => {
      let buffer = '';
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        log.info('navigator', `已订阅 ${key} 的事件流（端口 ${port}）`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let match = FRAME_SEP.exec(buffer);
          while (match) {
            const raw = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const frame = parseFrame(raw);
            if (frame) {
              try { onEvent?.(frame); } catch (error) { log.warn('navigator', `事件处理异常：${error?.message ?? error}`); }
            }
            match = FRAME_SEP.exec(buffer);
          }
        }
        if (!controller.signal.aborted) onClose?.('closed');
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn('navigator', `订阅中断（${key}）：${error?.message ?? error}`);
          onClose?.(String(error?.message ?? error));
        }
      } finally {
        if (active.get(key) === controller) active.delete(key);
      }
    })();
  }

  /**
   * 当前订阅的猫 key 清单。
   *
   * @returns {Array<string>} key 列表
   */
  function list() {
    return [...active.keys()];
  }

  /** 取消全部订阅。 */
  function stopAll() {
    for (const key of [...active.keys()]) unwatch(key);
  }

  return { subscribe, unwatch, list, stopAll };
}
