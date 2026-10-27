// napcat/webui.js —— 协议端 WebUI 客户端
//
// 职责：本应用访问协议端自身 WebUI 的唯一出口——取登录凭据、调它的接口（QQ 登录面）。
// 边界：端口与密钥一律读协议端自己的 webui.json；凭据算法与接口形态以协议端实现为准，
//       本文件不另立一份同名参数。

import crypto from 'node:crypto';
import { readWebui } from './shell.js';

/** 凭据缓存时长（毫秒）——过期后重新登录取新凭据。 */
const CREDENTIAL_TTL_MS = 10 * 60 * 1000;

/**
 * 单次请求超时（毫秒）。
 *
 * 协议端卡死（2026-10-27 判例：12:09 起 WebUI 间歇不可达，界面每 15 秒轮询一次）时，
 * 无超时的 fetch 会一直挂着，请求越积越多——失败必须是**有界的失败**，不是挂起。
 */
const FETCH_TIMEOUT_MS = 5000;

/**
 * 创建协议端 WebUI 客户端。
 *
 * @param {object} options 选项
 * @param {object} options.layout 协议端文件布局
 * @param {object} options.log 日志器
 * @returns {object} 客户端接口
 */
export function createWebuiClient({ layout, log }) {
  let credential = '';
  let credentialAt = 0;

  /**
   * 取 WebUI 登录凭据（带缓存）。
   *
   * 凭据算法来自协议端自身实现：hash = sha256(token + ".napcat")，登录成功后返回凭据串。
   * 协议端由本应用拉起时，界面帧会先于 WebUI 就绪——就绪前 fetch 必然失败，
   * 故按轮次重试（每轮落日志，失败可见）；全部轮次用尽才回落空串。
   *
   * @param {object} [options] 选项
   * @param {number} [options.attempts] 最大尝试次数
   * @param {number} [options.delayMs] 每轮间隔毫秒
   * @param {boolean} [options.force] 忽略缓存强制重取
   * @returns {Promise<string>} 凭据（失败返回空串）
   */
  async function login({ attempts = 1, delayMs = 0, force = false } = {}) {
    const webui = readWebui(layout);
    if (!webui.token) {
      log.warn('webui', '协议端未配置 WebUI 访问密钥，无法自动登录');
      return '';
    }
    if (!force && credential && Date.now() - credentialAt < CREDENTIAL_TTL_MS) return credential;

    const hash = crypto.createHash('sha256').update(`${webui.token}.napcat`).digest('hex');
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${webui.port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash, totpCode: '' }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        const data = await response.json();
        const value = data?.data?.Credential ?? '';
        if (value) {
          credential = value;
          credentialAt = Date.now();
          return credential;
        }
        log.warn('webui', `自动登录未取得凭据（第 ${attempt}/${attempts} 次）：${data?.message ?? '未知原因'}`);
      } catch (error) {
        log.warn('webui', `自动登录异常（第 ${attempt}/${attempts} 次）：${error?.message ?? error}`);
      }
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (attempts > 1) log.warn('webui', `自动登录在 ${attempts} 次尝试内未成功`);
    return '';
  }

  /**
   * 调用协议端 WebUI 接口。
   *
   * 凭据失效（HTTP 401）时丢弃缓存重取一次——不无限重试。
   *
   * @param {string} path 接口路径
   * @param {object} [options] 选项
   * @param {string} [options.method] 请求方法
   * @param {object} [options.body] 请求体
   * @param {boolean} [options.auth] 是否携带凭据
   * @returns {Promise<object>} { status, data }
   */
  async function call(path, { method = 'POST', body, auth = true } = {}) {
    const webui = readWebui(layout);
    const url = `http://127.0.0.1:${webui.port}${path}`;

    const send = async (token) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      return { status: response.status, data };
    };

    let token = auth ? await login() : '';
    let result = await send(token);
    if (auth && result.status === 401) {
      credential = '';
      credentialAt = 0;
      token = await login({ force: true });
      if (token) result = await send(token);
    }
    return result;
  }

  /**
   * 读 QQ 账号登录状态。
   *
   * @returns {Promise<object>} { httpStatus, code, message, state }
   */
  async function loginStatus() {
    const { status, data } = await call('/api/QQLogin/CheckLoginStatus');
    return {
      httpStatus: status,
      code: Number(data?.code ?? -1),
      message: String(data?.message ?? ''),
      state: data?.data ?? null
    };
  }

  /**
   * 读已存快速登录账号列表。
   *
   * @returns {Promise<object>} { code, message, uins }
   */
  async function quickLoginList() {
    const { data } = await call('/api/QQLogin/GetQuickLoginList', { method: 'GET' });
    const list = Array.isArray(data?.data) ? data.data : [];
    return { code: Number(data?.code ?? -1), message: String(data?.message ?? ''), uins: list.map((item) => String(item)) };
  }

  /**
   * 对指定账号发起快速登录。
   *
   * @param {string} uin 账号
   * @returns {Promise<object>} { code, message }
   */
  async function quickLogin(uin) {
    const { data } = await call('/api/QQLogin/SetQuickLogin', { body: { uin: String(uin) } });
    return { code: Number(data?.code ?? -1), message: String(data?.message ?? '') };
  }

  return { login, call, loginStatus, quickLoginList, quickLogin };
}
