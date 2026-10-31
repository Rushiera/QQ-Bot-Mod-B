// web/business-proxy.js —— 业务面接口通配代理（界面 ↔ 单体 ↔ 业务面）
//
// 职责：把单体端口上的 `/api/biz/*` 前缀转发到业务面 `127.0.0.1:3210/api/*`，
//       并把「业务面不可达 / 超时 / 方法不支持」三类失败收敛在本文件一处。
// 边界：
//   · 纯前缀替换——`/api/biz/chats/group_123/messages` → `/api/chats/group_123/messages`；
//     路径参数原样进路径，本文件**不解析、不拆参**（业务面自己有正则路由表）。
//   · 不逐条枚举业务面路由（73 条，枚举必漏）——一条通配覆盖全族。
//   · 只放行 GET / POST / DELETE，其余 405。
//   · 失败一律出声：业务面不可达回 502 + 原因（含 3210），**不吐空数组冒充成功**；
//     超时回 504。业务面自己回的 4xx / 5xx 原样透传，不翻译、不改写。
//   · 地址解析归 business 客户端（business.js 唯一一处：端口段探测 + 身份校验 + 一次重试），
//     本文件只缓存它解出来的根地址，转发失败即清缓存由它重解——不在此复制一套探测。
//   · 不转发 cookie、不改路径大小写、不改方法、不带自己的 query 重排（原样透传 `url.search`）。

/** 允许透传的方法——其余一律 405。 */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);

/** 单次转发超时毫秒（业务面 `session/compact` 这类会慢，8 秒外一律 504）。 */
const TIMEOUT_MS = 8000;

/** 业务面默认地址——只用于失败文案（真实地址由 business 客户端解析）。 */
const BUSINESS_HINT = '127.0.0.1:3210';

/**
 * 创建业务面通配代理。
 *
 * 返回对象只有一个键 `__bizProxy`——装配侧在 api 表里一行展开，
 * `server.js` 在 `api[key]` 未命中时按前缀交给它。
 *
 * @param {object} options 选项
 * @param {object} options.business 业务面客户端（business.js——只借用它的地址解析与身份校验）
 * @param {object} options.log 日志器
 * @param {string} [options.token] 业务面管理令牌（对应它的 `server.token`；空 = 未设令牌）
 * @param {number} [options.timeoutMs] 单次转发超时毫秒
 * @returns {{__bizProxy: Function}} 只含 `__bizProxy` 的接口表
 */
export function createBusinessProxy({ business, log, token = '', timeoutMs = TIMEOUT_MS } = {}) {
  /** 已确认可用的业务面根地址（缓存；失败即清）。 */
  let base = '';
  /** 并发解析单飞——多页同时刷新时不重复探测端口段。 */
  let resolving = null;

  /**
   * 报错日志（日志器缺方法时退回 console，不静默）。
   *
   * @param {string} text 内容
   * @returns {void}
   */
  function error(text) {
    if (typeof log?.error === 'function') log.error('biz-proxy', text);
    else console.error(`[biz-proxy] ${text}`);
  }

  /**
   * 警告日志。
   *
   * @param {string} text 内容
   * @returns {void}
   */
  function warn(text) {
    if (typeof log?.warn === 'function') log.warn('biz-proxy', text);
    else console.warn(`[biz-proxy] ${text}`);
  }

  /**
   * 构造失败响应（统一形态：`{ok:false, error, status}`）。
   *
   * @param {number} status HTTP 状态码
   * @param {string} text 原因（要能独立读懂：谁、哪个请求、为什么）
   * @returns {{status: number, body: object}} 响应
   */
  function fail(status, text) {
    return { status, body: { ok: false, error: text, status } };
  }

  /**
   * 解析业务面根地址——委托 business 客户端，结果缓存。
   *
   * @returns {Promise<string>} 根地址（无尾斜杠）
   */
  async function resolveBase() {
    if (base) return base;
    if (!resolving) {
      resolving = (async () => {
        try {
          // readLists 是 business 客户端唯一带「响应必须是业务面配置」身份校验的出口：
          // 它自己扫端口段（3210 起 10 个）+ 一次重试，命中即返回实际地址。
          const lists = await business.readLists();
          const next = String(lists?.apiUrl ?? '').replace(/\/+$/, '');
          if (!next) throw new Error('业务面客户端未返回可用地址');
          base = next;
          return base;
        } finally {
          resolving = null;
        }
      })();
    }
    return resolving;
  }

  /**
   * 拼转发目标（纯前缀替换 + 原样 query）。
   *
   * @param {string} root 业务面根地址
   * @param {string} pathname 单体侧路径（`/api/biz/...`）
   * @param {string} search 原始 query 串（含前导 `?`；空 = 无）
   * @returns {string} 目标 URL
   */
  function targetUrl(root, pathname, search) {
    const raw = pathname.startsWith('/api/biz') ? pathname.slice('/api/biz'.length) : pathname;
    const suffix = raw && !raw.startsWith('/') ? `/${raw}` : raw;
    return `${root}/api${suffix}${search || ''}`;
  }

  /**
   * 转发一次（不含重试）。
   *
   * @param {object} request 请求面
   * @param {string} verb 方法
   * @param {string} pathname 路径
   * @param {string} search query 串
   * @param {object|undefined} body 请求体
   * @returns {Promise<{status: number, body: object}>} 响应
   */
  async function send({ verb, pathname, search, body }) {
    const root = await resolveBase();
    const target = targetUrl(root, pathname, search);
    const payload = verb === 'POST' && body && typeof body === 'object' ? JSON.stringify(body) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        method: verb,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // 业务面若设了 server.token，读写面都按 x-console-token 校验；未设则忽略此头
          ...(token ? { 'x-console-token': token } : {})
        },
        ...(payload ? { body: payload } : {})
      });
      const text = await response.text();
      if (!text) return { status: response.status, body: {} };
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        const hint = text.length > 160 ? `${text.slice(0, 160)}…` : text;
        error(`业务面响应不是 JSON：${verb} ${target}（HTTP ${response.status}）：${hint}`);
        return fail(502, `业务面响应不是 JSON（${verb} ${pathname}，HTTP ${response.status}）：${hint}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 代理入口——由 `server.js` 在 `api[key]` 未命中且路径命中 `/api/biz/` 前缀时调用。
   *
   * @param {object} request 请求面
   * @param {string} request.method 方法
   * @param {string} request.pathname 路径
   * @param {string} [request.search] 原始 query 串（含 `?`）
   * @param {object} [request.body] 已解析的请求体
   * @returns {Promise<{status: number, body: object}>} 响应（交给既有 sendJson 出帧）
   */
  async function __bizProxy({ method, pathname, search = '', body } = {}) {
    const verb = String(method ?? '').toUpperCase();
    if (!ALLOWED_METHODS.has(verb)) {
      warn(`拒绝方法 ${verb || '未知'}：${pathname}（只允许 GET / POST / DELETE）`);
      return fail(405, `不支持的方法：${verb || '未知'}（只允许 GET / POST / DELETE）`);
    }

    try {
      return await send({ verb, pathname, search, body });
    } catch (first) {
      if (first?.name === 'AbortError') {
        error(`转发超时：${verb} ${pathname}（${timeoutMs}ms）`);
        return fail(504, `业务面响应超时（${timeoutMs}ms）：${verb} ${pathname}`);
      }
      // 地址可能变了（业务面重启换了端口）——清缓存，由 business 客户端重解后重试一次
      warn(`转发失败（${verb} ${pathname}）：${first?.message ?? first}——清掉已解析地址后重试一次`);
      base = '';
      try {
        return await send({ verb, pathname, search, body });
      } catch (second) {
        if (second?.name === 'AbortError') {
          error(`转发超时：${verb} ${pathname}（${timeoutMs}ms，已重试）`);
          return fail(504, `业务面响应超时（${timeoutMs}ms）：${verb} ${pathname}`);
        }
        const reason = String(second?.message ?? second);
        error(`转发失败两次：${verb} ${pathname}：${reason}`);
        // 判据要「失败文案含业务面默认端口」——统一带一次地址前缀，并剥掉客户端同义前缀防重复
        const detail = reason.replace(/^业务面不可达（已试 \d+ 个地址）：/, '');
        return fail(502, `业务面不可达（${BUSINESS_HINT}）：${detail}`);
      }
    }
  }

  return { __bizProxy };
}
