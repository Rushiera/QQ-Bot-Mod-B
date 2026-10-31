// app/ui/views/_shell.js —— 界面外壳与共享契约（R5-L1）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L1**
// 契约：`app/ui/views/_index.md` §三（3.1 冻结签名 / 3.2 两个必备函数 / 3.3 代理层契约）
//
// 职责：
//   ① 实现 `window.__ui` 的 11 个成员——L2–L8 只读消费，不得改写。
//   ② 驱动新页签的视图块导航：首次切到某页调 `mount(el)`，之后每次切页调 `refresh()`。
//
// 边界：
//   · 不做业务渲染（各块自管自己的 DOM）；不碰既有 `app.js` 的 6 页逻辑——
//     它自己的 `switchView()` 照旧按 `#view-${name}` 切 class，本文件只补「调块」这一半。
//   · 本文件是普通脚本（无 import / export），靠 index.html 的 `<script defer>` 顺序执行；
//     `defer` 保证本文件先于各视图块、先于 `app.js` 执行。

(function () {
  'use strict';

  // ── 0. 常量 ────────────────────────────────────────────────────────────

  /** 桩标记：实现完成后恒为 false（L16 契约自测按此断言）。 */
  const STUB = false;

  /** 视图块缺失时的占位文案——「未安装」与「暂无数据」是两件事，不混用。 */
  const NOT_INSTALLED = '此页未安装（视图块缺失）';

  /** 外壳接管导航的页签名——与 index.html 的 `.tab[data-view]` 一一对应；其余既有页签归 app.js。 */
  const MANAGED = ['sessions', 'chats', 'memory', 'usage', 'skills', 'plugins', 'bizsettings'];

  /** 页签名 → 视图块全局名（`bizsettings` 页签挂的块叫 `settings`，见 `_index.md` §3.1）。 */
  const VIEW_KEY = { bizsettings: 'settings' };

  /** 视图登记表：name → { title, mount, refresh }。块自注册，外壳只读。 */
  const views = (window.__views = window.__views || {});

  /** 已 mount 过的页签名——惰性建 DOM，同一页只建一次。 */
  const mounted = Object.create(null);

  // ── 1. 基础工具（$ / $$ / esc / el） ───────────────────────────────────

  /**
   * 单元素查询。
   *
   * @param {string} selector CSS 选择器
   * @param {Element|Document} [root] 查询根（默认 document）
   * @returns {Element|null} 命中元素或 null
   */
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  /**
   * 多元素查询——返回**真数组**（不是 NodeList），便于 `map` / `filter`。
   *
   * @param {string} selector CSS 选择器
   * @param {Element|Document} [root] 查询根（默认 document）
   * @returns {Element[]} 命中元素数组
   */
  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /** HTML 四字符转义表。 */
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

  /**
   * HTML 转义（& < > " 四字符）。
   *
   * @param {*} value 待转义值（null / undefined 视作空串）
   * @returns {string} 转义后的字符串
   */
  function esc(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return text.replace(/[&<>"]/g, (ch) => ESC_MAP[ch]);
  }

  /**
   * 把一组子节点追加到父节点（递归展开数组；null / undefined / false 跳过）。
   *
   * @param {Node} node 父节点
   * @param {Array} children 子节点（Node / 字符串 / 嵌套数组）
   * @returns {void}
   */
  function appendChildren(node, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        appendChildren(node, child);
        continue;
      }
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  /**
   * 建元素。
   *
   * `attrs` 里的键按名直接赋：`class` → className、`text` → textContent、`html` → innerHTML、
   * `style` / `dataset` → 对象展开、`on<事件>` → addEventListener、其余走属性赋值（赋值失败回落 setAttribute）。
   *
   * @param {string} tag 标签名
   * @param {object} [attrs] 属性表
   * @param {...*} children 子节点（Node / 字符串 / 嵌套数组）
   * @returns {Element} 新建元素
   */
  function el(tag, attrs) {
    const node = document.createElement(tag);
    const options = attrs || {};
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') {
        node.className = String(value);
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'html') {
        node.innerHTML = String(value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value);
      } else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (key in node) {
        try {
          node[key] = value;
        } catch (error) {
          node.setAttribute(key, String(value));
        }
      } else {
        node.setAttribute(key, String(value));
      }
    }
    appendChildren(node, Array.prototype.slice.call(arguments, 2));
    return node;
  }

  // ── 2. 接口调用（api） ─────────────────────────────────────────────────

  /**
   * 调用单体端口接口（`/api/...` 与 `/api/biz/...`）。
   *
   * 契约（`_index.md` §3.1）：非 2xx **不抛**，返 `{ok:false, error, status}`；
   * 成功时保证 `ok === true`——各块只按 `ok` 判，不写 try/catch 分支。
   *
   * @param {string} path 路径
   * @param {object} [options] `{method, body}`（body 为对象时自动 JSON 序列化）
   * @returns {Promise<object>} 响应体（失败时至少含 ok / error / status）
   */
  async function api(path, options) {
    const opts = options || {};
    const init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      const reason = error && error.message ? error.message : '网络错误';
      return { ok: false, error: `单体端口不可达（${reason}）`, status: 0 };
    }

    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : { data: body };

    if (!response.ok) {
      const reason = payload.error || payload.message || `HTTP ${response.status}`;
      payload.ok = false;
      payload.error = String(reason);
      payload.status = response.status;
      return payload;
    }

    if (payload.ok === undefined) payload.ok = true;
    if (payload.status === undefined) payload.status = response.status;
    return payload;
  }

  // ── 3. 格式化（fmtTime / fmtNum / fmtBytes） ───────────────────────────

  /**
   * 两位补零。
   *
   * @param {number} n 数字
   * @returns {string} 两位字符串
   */
  function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
  }

  /**
   * 毫秒时间戳 → `MM-DD HH:mm`（本地时区）。
   *
   * @param {number} ms 毫秒时间戳
   * @returns {string} 格式化结果；非法值返 `'-'`
   */
  function fmtTime(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  /**
   * 数字 → 千分位字符串（非整数保留两位小数）。
   *
   * @param {number} n 数字
   * @returns {string} 如 `1,234`；非数字返 `'-'`
   */
  function fmtNum(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '-';
    const negative = value < 0;
    const abs = Math.abs(value);
    const parts = (Number.isInteger(abs) ? String(abs) : abs.toFixed(2)).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}${parts.join('.')}`;
  }

  /**
   * 字节数 → 人类可读（1024 进制）。
   *
   * @param {number} n 字节数
   * @returns {string} 如 `1.2 MB`；非法 / 负数返 `'-'`
   */
  function fmtBytes(n) {
    const value = Number(n);
    if (!Number.isFinite(value) || value < 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const text = index === 0 ? String(Math.round(size)) : size.toFixed(1);
    return `${text} ${units[index]}`;
  }

  // ── 4. 空态 / 失败态（empty / fail） ───────────────────────────────────

  /**
   * 把挂载点解析成元素（接受 Element 或选择器字符串）。
   *
   * @param {Element|string} target 元素或选择器
   * @returns {Element|null} 元素或 null
   */
  function resolveEl(target) {
    if (!target) return null;
    if (target instanceof Element) return target;
    if (typeof target === 'string') return $(target);
    return null;
  }

  /**
   * 把任意错误值压成一句人话。
   *
   * @param {*} error 错误值（字符串 / Error / `{error}` / `{message}`）
   * @returns {string} 可读文案
   */
  function errorText(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error.error) return String(error.error);
    if (error.message) return String(error.message);
    return String(error);
  }

  /**
   * 渲染空态（灰字一行）——不是空表格冒充正常。
   *
   * @param {Element|string} target 容器（元素或选择器）
   * @param {string} text 空态文案
   * @returns {void}
   */
  function empty(target, text) {
    const host = resolveEl(target);
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('p', { class: 'view-empty', text: text || '暂无数据' }));
  }

  /**
   * 渲染失败态（红字 + 原因）——不是弹窗、不渲染假数据。
   *
   * @param {Element|string} target 容器（元素或选择器）
   * @param {*} error 错误值
   * @returns {void}
   */
  function fail(target, error) {
    const host = resolveEl(target);
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('p', { class: 'view-fail', text: `加载失败：${errorText(error)}` }));
  }

  // ── 5. 视图登记（registerView）与导航驱动 ──────────────────────────────

  /**
   * 登记一个视图块。
   *
   * @param {string} name 视图名（对应 `<section id="view-<name>">`）
   * @param {object} view 视图对象 `{title, mount, refresh}`
   * @returns {void}
   */
  function registerView(name, view) {
    if (!name || !view) return;
    views[name] = view;
  }

  /**
   * 取某页签对应的视图块（`bizsettings` → `settings`）。
   *
   * @param {string} name 页签名
   * @returns {object|null} 视图块或 null
   */
  function viewOf(name) {
    return views[VIEW_KEY[name] || name] || null;
  }

  /**
   * 确保视图块已 mount（惰性，一页一次）；块缺失时渲染「未安装」占位。
   *
   * @param {string} name 页签名
   * @returns {object|null} 可用的视图块或 null
   */
  function ensureMounted(name) {
    const host = document.getElementById(`view-${name}`);
    if (!host) return null;
    const view = viewOf(name);

    if (!view || typeof view.mount !== 'function') {
      if (host.dataset.notInstalled !== '1') {
        host.textContent = '';
        host.appendChild(el('p', { class: 'view-stub', text: NOT_INSTALLED }));
        host.dataset.notInstalled = '1';
      }
      return null;
    }

    // 块在上一次判定「未安装」之后才到位——清掉占位，允许重建
    if (host.dataset.notInstalled === '1') {
      host.textContent = '';
      delete host.dataset.notInstalled;
      mounted[name] = false;
    }

    if (!mounted[name]) {
      mounted[name] = true;
      try {
        view.mount(host);
      } catch (error) {
        mounted[name] = false;
        console.error(`[__ui] ${name}.mount 失败`, error);
        fail(host, error);
        return null;
      }
    }
    return view;
  }

  /**
   * 激活某个被外壳接管的页签：确保已 mount，然后 refresh。
   *
   * @param {string} name 页签名
   * @returns {void}
   */
  function activate(name) {
    if (!name || MANAGED.indexOf(name) < 0) return;
    const view = ensureMounted(name);
    if (!view || typeof view.refresh !== 'function') return;
    try {
      const result = view.refresh();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error(`[__ui] ${name}.refresh 失败`, error));
      }
    } catch (error) {
      console.error(`[__ui] ${name}.refresh 失败`, error);
    }
  }

  /**
   * 点击任意 `.tab` 后驱动对应视图块（与 app.js 的 switchView 并行，互不依赖）。
   *
   * @param {MouseEvent} event 点击事件
   * @returns {void}
   */
  function onTabClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const tab = target.closest('.tab');
    if (!tab || !tab.dataset || !tab.dataset.view) return;
    activate(tab.dataset.view);
  }

  /**
   * 首次加载：当前 active 页签若是被接管的页，直接激活一次。
   *
   * @returns {void}
   */
  function activateCurrent() {
    const tab = document.querySelector('.tab.active');
    if (tab && tab.dataset && tab.dataset.view) activate(tab.dataset.view);
  }

  /** 启动：绑点击（捕获阶段，先于 app.js 的冒泡监听）+ 首屏激活。 */
  function boot() {
    document.addEventListener('click', onTabClick, true);
    activateCurrent();
  }

  // ── 6. 导出（契约 §3.1 的 11 个成员，一个不少） ────────────────────────

  /** 共享契约对象——其余块**只读**，不得改写任何成员。 */
  window.__ui = {
    api,
    $,
    $$,
    el,
    esc,
    fmtTime,
    fmtNum,
    fmtBytes,
    empty,
    fail,
    registerView
  };

  /** 供 L16 契约自测断言（`__ui.stub === false` 才算实现完成）。 */
  window.__ui.stub = STUB;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
