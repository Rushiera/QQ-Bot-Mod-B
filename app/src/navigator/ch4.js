// navigator/ch4.js —— CH4 猫面（状态读取 + 指令投递）
//
// 职责：经 CH4 外观层 HTTP 协议读猫群状态、投递指令给指定猫。
// 边界：只用只读端点（snapshot / cat-detail / history）与 command 端点；
//       不直写 CH4 数据面、不模拟前端点击。
// 协议权威：Project/CH4/design-ch4-protocol.md（快照 / 指令 / 猫详情 / 事件流）。

/** CH4 主端口（管理面 + cat.* 指令族）。 */
const DEFAULT_MAIN_PORT = 8080;

/** 单次请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * 创建 CH4 客户端。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {number} [options.mainPort] CH4 主端口
 * @returns {object} 客户端接口
 */
export function createCh4Client({ log, mainPort = DEFAULT_MAIN_PORT }) {
  /** 主干对话端口缓存（snapshot 里读一次即可——端口在宿主生命周期内固定）。 */
  let majorPortCache = 0;

  /**
   * 带超时的 JSON 请求。
   *
   * @param {string} url 完整地址
   * @param {object} [options] 选项（method / body）
   * @returns {Promise<object>} 响应体
   */
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 全量快照（日志段裁空——本模块只取 sessions）。
   *
   * @returns {Promise<object>} 快照
   */
  async function snapshot() {
    return request(`http://127.0.0.1:${mainPort}/api/v1/snapshot?logs=0`);
  }

  /**
   * 猫群清单（快照的 sessions 段）。
   *
   * @returns {Promise<Array<object>>} 每猫状态
   */
  async function cats() {
    const data = await request(`http://127.0.0.1:${mainPort}/api/v1/cats`);
    return Array.isArray(data?.cats) ? data.cats : [];
  }

  /**
   * 单猫详情（状态 + 本会话末条 user / 回复）。
   *
   * @param {string} key 猫寻址键（id / 显示名 / id 前缀）
   * @returns {Promise<object>} 详情
   */
  async function detail(key) {
    return request(`http://127.0.0.1:${mainPort}/api/v1/cat-detail?cat=${encodeURIComponent(key)}`);
  }

  /**
   * 投递一行指令到指定端口。
   *
   * @param {string} text 指令文本
   * @param {number} port 目标端口
   * @returns {Promise<object>} 回执（{ok, cmdId, frame}）
   */
  async function command(text, port = mainPort) {
    return request(`http://127.0.0.1:${port}/api/v1/command`, { method: 'POST', body: { text } });
  }

  /**
   * 主干对话端口（majordomo 的独立端口）——快照里读，读不到回落 8081。
   *
   * @returns {Promise<number>} 端口
   */
  async function majorPort() {
    if (majorPortCache) return majorPortCache;
    try {
      const rows = await cats();
      const major = rows.find((row) => row?.id === 'majordomo');
      majorPortCache = Number(major?.port) || mainPort + 1;
    } catch (error) {
      log.warn('navigator', `主干端口探测失败，回落 ${mainPort + 1}：${error?.message ?? error}`);
      majorPortCache = mainPort + 1;
    }
    return majorPortCache;
  }

  /**
   * 猫寻址解析——接受 id / 显示名 / id 前缀 / majordomo。
   *
   * @param {string} nameOrKey 寻址输入
   * @returns {Promise<string>} 规范化 key（解析不到原样返回）
   */
  async function resolveKey(nameOrKey) {
    const raw = String(nameOrKey || '').trim();
    if (!raw) return '';
    if (raw === 'majordomo') return 'majordomo';
    try {
      const rows = await cats();
      const hit = rows.find((row) => String(row?.id) === raw)
        || rows.find((row) => String(row?.name) === raw)
        || rows.find((row) => String(row?.id).startsWith(raw));
      return hit?.id ? String(hit.id) : raw;
    } catch {
      return raw;
    }
  }

  /**
   * 投递一条消息给指定猫（视为人在 QQ 群里的发言）。
   *
   * 主干（majordomo）走其对话端口 `Chat ` 前缀；其余走主端口 `cat.chat`。
   *
   * @param {string} nameOrKey 猫寻址
   * @param {string} text 内容
   * @returns {Promise<object>} {ok, key, port, reply}
   */
  async function send(nameOrKey, text) {
    const content = String(text || '').trim();
    if (!content) throw new Error('投递内容为空');
    const key = await resolveKey(nameOrKey);
    if (!key) throw new Error('未指定目标猫');
    if (key === 'majordomo') {
      const port = await majorPort();
      const reply = await command(`Chat ${content}`, port);
      log.info('navigator', `已投递主干（端口 ${port}）：${content.slice(0, 60)}`);
      return { ok: reply?.ok === true, key, port, reply };
    }
    const reply = await command(`cat.chat ${key} ${content}`, mainPort);
    log.info('navigator', `已投递 ${key}：${content.slice(0, 60)}`);
    return { ok: reply?.ok === true, key, port: mainPort, reply };
  }

  /**
   * 拉某猫的会话视图块（N2 截图数据源）。
   *
   * @param {string} key 猫寻址
   * @returns {Promise<object>} 视图 JSON
   */
  async function history(key) {
    const resolved = await resolveKey(key);
    const port = resolved === 'majordomo' ? await majorPort() : await catPort(resolved);
    return request(`http://127.0.0.1:${port}/api/v1/history`);
  }

  /**
   * 取某猫的对话端口（快照里读）。
   *
   * @param {string} key 猫寻址
   * @returns {Promise<number>} 端口
   */
  async function catPort(key) {
    const rows = await cats();
    const hit = rows.find((row) => String(row?.id) === String(key));
    return Number(hit?.port) || 0;
  }

  /**
   * 拉某猫的会话关键信息（对话端口专属）——加载报告 / user 消息 / 正式回复 / 轮结算。
   *
   * @param {string} key 猫寻址
   * @param {number} [max] 取末尾条数
   * @returns {Promise<object>} { ok, count, items }
   */
  async function keyinfo(key, max = 12) {
    const resolved = await resolveKey(key);
    const port = resolved === 'majordomo' ? await majorPort() : await catPort(resolved);
    return request(`http://127.0.0.1:${port}/api/v1/keyinfo?max=${Number(max) || 12}`);
  }

  /**
   * 拉某猫的完整前文（对话端口专属）——全条目（system / user / assistant / tool），
   * 抢救模式代读的数据源（design §六b；Rushiera 2026-10-14 定）。
   *
   * @param {string} key 猫寻址
   * @param {number} [max] 取末尾条数（端点侧 1-500 夹取，缺省 200）
   * @returns {Promise<object>} { ok, count, chars, items }
   */
  async function fullctx(key, max = 200) {
    const resolved = await resolveKey(key);
    const port = resolved === 'majordomo' ? await majorPort() : await catPort(resolved);
    return request(`http://127.0.0.1:${port}/api/v1/fullctx?max=${Number(max) || 200}`);
  }

  /**
   * 主干端口（对外暴露——SSE 订阅用）。
   *
   * @returns {Promise<number>} 端口
   */
  async function portOf(key) {
    const resolved = await resolveKey(key);
    return resolved === 'majordomo' ? majorPort() : catPort(resolved);
  }

  return { snapshot, cats, detail, command, send, resolveKey, history, keyinfo, fullctx, portOf, mainPort };
}
