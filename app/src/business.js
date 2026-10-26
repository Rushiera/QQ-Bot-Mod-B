// business.js —— 业务面（QQ Agent）配置接口客户端
//
// 职责：读业务面生效配置里的群名单（allow / deny），以及把修改写回业务面。
// 边界：
//   · 只经业务面自己的 HTTP 接口读写，**绝不直改 `_unpack/data/config.json`**——业务面把
//     配置加载在内存里（`getConfig()` 单例），直改磁盘它不重读：表现为「文件改了、名单没变」，
//     要等下一次重启才生效。
//   · 只承载群名单这一块语义；业务面的其他配置项不在此代理（改它们仍走业务面自己的设置页）。
//   · 业务面不在线时如实报错，不回落本地文件、不假装成功。
//   · 地址不是写死的一个端口：业务面从 3210 起向上找空位，起在 3211 时写死的地址就挑空了。
//     故按配置地址优先 + 端口段探测，并校验响应确实是业务面（含 allow.groups）才算命中。

/** 端口段探测范围（业务面 `server.port` 起向上 10 个，与它的监听逻辑同口径）。 */
const PORT_SPAN = 10;

/**
 * 创建业务面配置客户端。
 *
 * @param {object} options 选项
 * @param {string} options.apiUrl 业务面接口根地址（如 http://127.0.0.1:3210）
 * @param {object} options.log 日志器
 * @param {string} [options.token] 业务面管理令牌（对应它的 `server.token`；空 = 它未设令牌，免授权）
 * @param {number} [options.timeoutMs] 单次请求超时毫秒
 * @returns {object} 客户端接口
 */
export function createBusinessClient({ apiUrl, log, token = '', timeoutMs = 8000 }) {
  /** 已确认可用的根地址（探测一次后复用，省掉每次请求都扫端口段）。 */
  let resolvedBase = '';

  /**
   * 发请求并解析 JSON（超时即中止）。
   *
   * @param {string} base 根地址
   * @param {string} path 接口路径
   * @param {object} [options] fetch 选项
   * @returns {Promise<object>} 响应体
   */
  async function requestAt(base, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // 业务面若设了 server.token，读写面都按 x-console-token 校验；未设则忽略此头
          ...(token ? { 'x-console-token': token } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`响应不是 JSON（${base}${path}，HTTP ${response.status}）`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${body?.error ? `：${body.error}` : ''}`);
      }
      return body ?? {};
    } catch (error) {
      const message = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(error?.message ?? error);
      throw new Error(`${base}${path} ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 判一段响应是不是业务面的配置（群名单字段的真实形态）。
   *
   * @param {object} body 响应体
   * @returns {boolean} 是否是业务面配置
   */
  function looksLikeBusinessConfig(body) {
    return !!body && typeof body === 'object'
      && !!body.allow && Array.isArray(body.allow.groups)
      && !!body.deny && Array.isArray(body.deny.groups);
  }

  /**
   * 解析业务面根地址：配置地址优先，其后按端口段探测。
   *
   * @returns {Promise<string>} 命中的根地址
   */
  async function resolveBase() {
    if (resolvedBase) return resolvedBase;

    const candidates = [];
    const configured = String(apiUrl || '').replace(/\/+$/, '');
    if (configured) candidates.push(configured);
    // 端口段探测：配置地址若是已知形态（http://host:port），从该端口起扫一段
    let host = '127.0.0.1';
    let port = 3210;
    try {
      const parsed = new URL(configured || 'http://127.0.0.1:3210');
      host = parsed.hostname;
      port = Number(parsed.port) || 80;
    } catch { /* 配置地址非法时用默认段 */ }
    for (let p = port; p < port + PORT_SPAN; p += 1) {
      const candidate = `http://${host}:${p}`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }

    const failures = [];
    for (const candidate of candidates) {
      try {
        const body = await requestAt(candidate, '/api/config');
        if (!looksLikeBusinessConfig(body)) {
          failures.push(`${candidate}：不是业务面配置接口`);
          continue;
        }
        resolvedBase = candidate;
        if (candidate !== configured) {
          log.warn('business', `业务面实际监听 ${candidate}（配置为 ${configured || '空'}）——已自动切换`);
        }
        return resolvedBase;
      } catch (error) {
        failures.push(String(error?.message ?? error));
      }
    }
    throw new Error(`业务面不可达（已试 ${candidates.length} 个地址）：${failures.join('；')}`);
  }

  /**
   * 判一次失败是不是「地址不可达」类（业务面重启 / 让位换端口）。
   *
   * 这类失败重试一次就能恢复；语义类失败（同群冲突 / 不是业务面）重试无用，直接抛。
   *
   * @param {Error} error 失败
   * @returns {boolean} 是否值得重试
   */
  function isUnreachable(error) {
    const text = String(error?.message ?? error);
    return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|超时/.test(text);
  }

  /**
   * 带一次重试地执行请求（只对地址类失败重试）。
   *
   * 重试前清掉已解析地址——业务面重启中可能换了端口。连点重排、业务面短暂卡住
   * 都会走这条：一次「fetch failed」不应该变成界面上一条失败提示。
   *
   * @param {Function} fn 待执行动作
   * @returns {Promise<*>} 动作结果
   */
  async function withRetry(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      resolvedBase = '';
      log.warn('business', `请求失败（${error?.message ?? error}），清掉已解析地址后重试一次`);
      return await fn();
    }
  }

  /**
   * 把群号清单规整成干净数组（去空白、去重、只留数字）。
   *
   * @param {unknown} value 原始值
   * @returns {string[]} 群号数组
   */
  function normalizeIds(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of list) {
      const id = String(item ?? '').trim();
      if (!id) continue;
      if (!/^\d+$/.test(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * 读群名单现状。
   *
   * @returns {Promise<object>} `{ ok, apiUrl, allowGroups, denyGroups, allowAllWhenEmpty }`
   */
  async function readLists() {
    return withRetry(async () => {
      const base = await resolveBase();
      const config = await requestAt(base, '/api/config');
      return {
        ok: true,
        apiUrl: base,
        allowGroups: normalizeIds(config?.allow?.groups),
        denyGroups: normalizeIds(config?.deny?.groups),
        allowAllWhenEmpty: config?.allowAllWhenEmpty === true
      };
    });
  }

  /**
   * 写群名单（只覆盖这三个字段，其余配置原样保留）。
   *
   * @param {object} patch 待写入内容
   * @param {string[]} patch.allowGroups 允许群号
   * @param {string[]} patch.denyGroups 拒绝群号
   * @param {boolean} [patch.allowAllWhenEmpty] 空名单时是否放行全部
   * @returns {Promise<object>} 写后实况（读回）
   */
  async function writeLists({ allowGroups, denyGroups, allowAllWhenEmpty }) {
    const allow = normalizeIds(allowGroups);
    const deny = normalizeIds(denyGroups);
    const overlap = allow.filter((id) => deny.includes(id));
    if (overlap.length) {
      throw new Error(`同一群同时出现在允许与拒绝名单：${overlap.join(', ')}`);
    }
    const base = await resolveBase();
    const patch = { allow: { groups: allow }, deny: { groups: deny } };
    if (typeof allowAllWhenEmpty === 'boolean') patch.allowAllWhenEmpty = allowAllWhenEmpty;
    await withRetry(() => requestAt(base, '/api/config', { method: 'POST', body: JSON.stringify(patch) }));
    const after = await readLists();
    log.info('business', `群名单已写入：允许 ${after.allowGroups.length} 个 / 拒绝 ${after.denyGroups.length} 个`);
    return { ok: true, apiUrl: after.apiUrl, allowGroups: after.allowGroups, denyGroups: after.denyGroups, allowAllWhenEmpty: after.allowAllWhenEmpty };
  }

  /**
   * 拉协议端当前所在群（群号 + 群名）——供界面辨识群号，不参与写入。
   *
   * @returns {Promise<object>} `{ ok, groups }`；业务面离线或协议端未连时 `ok:false`
   */
  async function readOnlineGroups() {
    try {
      return await withRetry(async () => {
        const base = await resolveBase();
        const body = await requestAt(base, '/api/onebot/groups');
        const groups = (Array.isArray(body?.groups) ? body.groups : []).map((g) => ({
          id: String(g?.id ?? '').trim(),
          name: String(g?.name ?? '').trim()
        })).filter((g) => g.id);
        return { ok: true, groups };
      });
    } catch (error) {
      return { ok: false, groups: [], error: String(error?.message ?? error) };
    }
  }

  return { readLists, writeLists, readOnlineGroups };
}
