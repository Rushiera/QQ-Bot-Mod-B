// onebot/client.js —— OneBot 11 WebSocket 客户端
//
// 职责：连协议端的 OneBot WebSocket 服务，收事件、发 API 调用、断线自动重连。
// 边界：只做连接与协议编解码，不承载业务语义（发言策略、记忆等由上层决定）。

/**
 * 创建 OneBot 客户端。
 *
 * @param {object} options 选项
 * @param {string} options.wsUrl WebSocket 地址（ws://127.0.0.1:3001）
 * @param {string} [options.token] 访问令牌
 * @param {object} options.log 日志器
 * @param {number} [options.reconnectMs] 重连间隔毫秒
 * @returns {object} 客户端接口
 */
export function createOnebotClient({ wsUrl, token = '', log, reconnectMs = 3000 }) {
  const state = { connected: false, self: null, lastError: '', lastEventAt: 0, events: 0 };
  const pending = new Map();
  const listeners = new Set();
  let socket = null;
  let retryTimer = null;
  let manualClose = false;
  let echoSeq = 0;

  /**
   * 组装带令牌的连接地址。
   *
   * @returns {string} 完整地址
   */
  function buildUrl() {
    const url = new URL(wsUrl);
    if (token) url.searchParams.set('access_token', token);
    return url.toString();
  }

  /**
   * 安排重连。
   *
   * @returns {void}
   */
  function scheduleReconnect() {
    if (manualClose || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, reconnectMs);
  }

  /**
   * 广播事件。
   *
   * @param {object} payload 事件体
   * @returns {void}
   */
  function emit(payload) {
    state.lastEventAt = Date.now();
    state.events += 1;
    for (const fn of listeners) {
      try { fn(payload); } catch (error) {
        log.warn('onebot', `事件处理异常：${error?.message ?? error}`);
      }
    }
  }

  /**
   * 处理收到的原始帧。
   *
   * @param {string} raw 帧文本
   * @returns {void}
   */
  function handleFrame(raw) {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      log.warn('onebot', '收到非 JSON 帧，已忽略');
      return;
    }

    if (payload?.echo !== undefined && pending.has(payload.echo)) {
      const entry = pending.get(payload.echo);
      pending.delete(payload.echo);
      clearTimeout(entry.timer);
      if (payload.status === 'failed' || payload.retcode) {
        entry.reject(new Error(`接口 ${entry.action} 返回失败（retcode=${payload.retcode ?? '?'}）`));
      } else {
        entry.resolve(payload.data ?? null);
      }
      return;
    }

    emit(payload);
  }

  /**
   * 建立连接。
   *
   * @returns {void}
   */
  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    manualClose = false;

    try {
      socket = new WebSocket(buildUrl());
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      log.error('onebot', `建立连接失败：${state.lastError}`);
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      state.connected = true;
      state.lastError = '';
      log.info('onebot', `已连接协议端（${wsUrl}）`);
      call('get_login_info').then((info) => {
        state.self = info ? { userId: info.user_id, nickname: info.nickname } : null;
        log.info('onebot', `登录账号：${state.self ? `${state.self.nickname}(${state.self.userId})` : '未知'}`);
      }).catch(() => { /* 取不到登录信息不影响连接 */ });
    };

    socket.onmessage = (event) => handleFrame(String(event.data));

    socket.onclose = () => {
      state.connected = false;
      if (!manualClose) {
        log.warn('onebot', `连接已断开，${Math.round(reconnectMs / 1000)} 秒后重连`);
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      state.lastError = '连接异常';
    };
  }

  /**
   * 关闭连接（不再重连）。
   *
   * @returns {void}
   */
  function close() {
    manualClose = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try { socket?.close(); } catch { /* 已关闭 */ }
    socket = null;
    state.connected = false;
  }

  /**
   * 调用 OneBot 接口。
   *
   * @param {string} action 接口名（如 send_group_msg）
   * @param {object} [params] 参数
   * @param {number} [timeoutMs] 超时毫秒
   * @returns {Promise<object|null>} 返回数据
   */
  function call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(new Error(`连接未就绪，无法调用 ${action}`));
        return;
      }
      const echo = `c${++echoSeq}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`接口 ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(echo, { resolve, reject, timer, action });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(error);
      }
    });
  }

  /**
   * 订阅事件。
   *
   * @param {Function} fn 处理函数
   * @returns {Function} 取消订阅
   */
  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 取当前状态快照。 */
  function status() {
    return { ...state, wsUrl };
  }

  return { connect, close, call, onEvent, status };
}
