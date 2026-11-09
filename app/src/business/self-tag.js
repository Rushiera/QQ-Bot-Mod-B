// 入站自报（来源归因）——与 CH4 侧 Mau.Runtime.LlmSelfTag 同构。
//
// 唯一用途：让本机中转站（壳，127.0.0.1:18100）在来源台账里分得清
// 「哪路客户端 · 哪个 QQ 会话 · 哪条通道」，不必靠 system 头猜。
// 🔴 只对回环端点附加：透到上游就是可指认的客户端指纹（出网形态不带特征）。
// 🔴 缓存纪律同 Mau 侧：只加新头，不动 x-opencode-session / body / 模型参数——
//    换掉其中任何一个都会换掉上游缓存槽。
import { AsyncLocalStorage } from 'node:async_hooks';

/** 客户端标识——产品 / 版本。改版本号只改这一处（与 CHANGELOG 最新版本行同步）。 */
export const CLIENT_ID = 'qqbotb/1.49';

/** 实例标识——apis 侧 x-cat-id（会话 UUID 的命名空间）与来源卡「猫名」列都读它。 */
const CAT_ID = 'qqbotb';
const CAT_NAME = 'QQBotB';
const PROJECT_MOUNT = 'QQBotB';
const PROJECT_MOUNT_MODE = 'expert';

const VALUE_MAX = 120;
const VALUE_MAX_ENCODED = 360;

const store = new AsyncLocalStorage();

/** 端点是否本机回环（127.0.0.1 / localhost / [::1]）——只有这类才自报身份。 */
export function isLoopbackBase(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(String(baseUrl || ''));
}

/**
 * 包一层请求语境（chatKey / 会话起点）——下游 chatCompletion 自动读到。
 * 多群并发靠 AsyncLocalStorage 隔离，不用模块级变量（会串会话）。
 *
 * @param {object} context { chatKey, sessionStartedAt }
 * @param {Function} fn 同步或异步函数
 */
export function withSelfContext(context, fn) {
  return store.run({ ...(context || {}) }, fn);
}

/** 会话键 = QQ 会话 + 会话世代（收工轮轮转后换代，apis 侧据此派生会话 UUID）。 */
function sessionKeyOf(context) {
  const chatKey = String(context?.chatKey || '').trim();
  if (!chatKey) return '';
  const startedAt = Number(context?.sessionStartedAt) || 0;
  return `${chatKey}@${startedAt}`;
}

/** 来源展示标签——群会话给「群消息 · 群名」，其余不发（由壳侧 CatSourceLabel 原样使用）。 */
function sourceScopeOf(context) {
  if (context?.chatKind !== 'group') return '';
  const name = String(context?.chatName || '').trim() || String(context?.chatKey || '').trim();
  return name ? `群消息 · ${name}` : '';
}

/** 头值净化——去控制字符、截断到上限、非 ASCII 走百分号编码（apis 侧解码还原）。 */
function headerValue(raw) {
  const kept = [];
  for (const ch of String(raw ?? '')) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 13 || code === 10) { kept.push(' '); continue; }
    if (code < 32 || code === 127) continue;
    kept.push(ch);
  }
  let text = kept.join('').trim();
  if (!text) return '';
  if (text.length > VALUE_MAX) text = text.slice(0, VALUE_MAX);
  if (/[^\x20-\x7e]/.test(text)) {
    const encoded = encodeURIComponent(text);
    text = encoded.length > VALUE_MAX_ENCODED ? encoded.slice(0, VALUE_MAX_ENCODED) : encoded;
  }
  return text;
}

/**
 * 自报头——非回环端点返回空对象（一个字节不加）。
 *
 * @param {string} baseUrl 目标端点
 * @param {string} channel 通道（chat / vision / summary / memory / models / probe）
 * @returns {object} 头字典
 */
export function selfTagHeaders(baseUrl, channel = 'chat') {
  if (!isLoopbackBase(baseUrl)) return {};
  const context = store.getStore() || {};
  const headers = {};
  const put = (name, value) => {
    const clean = headerValue(value);
    if (clean) headers[name] = clean;
  };
  put('x-cat-channel', channel);
  put('x-client-id', CLIENT_ID);
  put('x-cat-id', CAT_ID);
  put('x-cat-name', CAT_NAME);
  put('x-cat-session', sessionKeyOf(context));
  put('x-cat-scope', sourceScopeOf(context));
  put('x-project-mount', PROJECT_MOUNT);
  put('x-project-mount-mode', PROJECT_MOUNT_MODE);
  return headers;
}
