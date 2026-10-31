// app/ui/views/sessions.js —— 会话页视图块（R5-L2）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L2**
// 契约：`app/ui/views/_index.md` §三（运行时只读 `window.__ui`；块内不发裸请求，一律走 `api()`）
// 状态：✅ 已实现（R5-L2 交付）
//
// 面：左栏 = 群会话全量列表（按最近消息倒序，**不截断**，条数 = `/api/biz/sessions` 的 `chats.length`）；
//     右栏 = 选中群的消息存档（条数 = `messages.length`）+ 该群会话运行记录。
// 取数：`/api/biz/sessions`（chats + sessions 一次取）· `/api/biz/chats`（群名，与 L3 存档页同源）
//       `/api/biz/chats/<group_xxx>/messages`（群消息，可选 `?limit=`）
// 空态 / 失败态：走 `empty()` / `fail()`，失败文案带 3210。
// 降级：`window.__ui` 缺成员时用本块的本地实现兜底——页面不白屏、不抛错。

(function () {
  'use strict';

  /** 会话状态 → 中文。未列出的原样显示。 */
  const STATUS_LABEL = {
    running: '运行中',
    waiting: '等待中',
    done: '完成',
    noreply: '未回',
    error: '失败',
    aborted: '已中止',
    deleted: '已删除'
  };

  /** 消息条数档位：0 = 全部（不带 `limit` 参数，交给业务面默认）。 */
  const MSG_LIMITS = [
    { value: 0, label: '全部' },
    { value: 100, label: '最近 100' },
    { value: 300, label: '最近 300' }
  ];

  /** 失败态统一文案前缀（契约要求含 3210）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /** DOM 容器引用（mount 建一次，refresh 只清内容）。 */
  let refs = null;

  /** 单飞句柄。 */
  let inflight = null;

  /** 请求序号：迟到响应按序号丢弃。 */
  let seq = 0;

  /** 界面态（业务真相每次从接口读，不在这里缓存结论）。 */
  const state = {
    chats: [],
    sessions: [],
    names: {},
    currentKey: null,
    messages: [],
    msgLimit: 0,
    filter: '',
    error: '',
    detailError: '',
    compactNote: '',
    loadingMessages: false,
    updatedAt: 0
  };

  /**
   * 取共享契约对象。
   *
   * @returns {object} `window.__ui`（不存在时给空对象）
   */
  function ui() {
    return window.__ui || {};
  }

  /**
   * 本地建元素（`__ui.el` 缺失时的兜底，语义一致）。
   *
   * @param {string} tag 标签名
   * @param {object} [attrs] 属性（`class` / `text` / `onclick` 等按名赋）
   * @param {...any} kids 子节点
   * @returns {Element} 元素
   */
  function h(tag, attrs) {
    const node = document.createElement(tag);
    const a = attrs || {};
    for (const key of Object.keys(a)) {
      const value = a[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.className = String(value);
      else if (key === 'html') node.innerHTML = String(value);
      else if (key.slice(0, 2) === 'on') node[key] = value;
      else node.setAttribute(key, String(value));
    }
    for (let i = 2; i < arguments.length; i += 1) {
      const kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return node;
  }

  /**
   * 建元素（优先用契约里的 `__ui.el`，缺失回退本地实现）。
   *
   * @param {string} tag 标签名
   * @param {object} [attrs] 属性
   * @param {...any} kids 子节点
   * @returns {Element} 元素
   */
  function el(tag, attrs) {
    const kids = Array.prototype.slice.call(arguments, 2)
      .filter((k) => k !== null && k !== undefined && k !== false);
    const shared = ui().el;
    if (typeof shared === 'function') {
      const node = shared.apply(null, [tag, attrs || {}].concat(kids));
      if (node) return node;
    }
    return h.apply(null, [tag, attrs || {}].concat(kids));
  }

  /**
   * 空态渲染（契约 `empty()`，缺失回退一行灰字）。
   *
   * @param {Element} node 容器
   * @param {string} text 文案
   * @returns {void}
   */
  function empty(node, text) {
    if (!node) return;
    const shared = ui().empty;
    if (typeof shared === 'function') { shared(node, text); return; }
    node.textContent = '';
    node.appendChild(h('p', { class: 'hint r5-empty', text: text }));
  }

  /**
   * 失败态渲染（契约 `fail()`，缺失回退红色一行）。
   *
   * @param {Element} node 容器
   * @param {string} error 原因
   * @returns {void}
   */
  function fail(node, error) {
    if (!node) return;
    const shared = ui().fail;
    if (typeof shared === 'function') { shared(node, error); return; }
    node.textContent = '';
    node.appendChild(h('p', { class: 'r5-fail', text: error }));
  }

  /**
   * 时间格式化（契约 `fmtTime()`，缺失回退本地格式）。
   *
   * @param {number} ms 毫秒时间戳
   * @returns {string} `MM-DD HH:mm` 或 '-'
   */
  function fmtTime(ms) {
    const shared = ui().fmtTime;
    if (typeof shared === 'function') return shared(ms);
    const n = Number(ms);
    if (!n) return '-';
    const d = new Date(n);
    const p2 = (v) => String(v).padStart(2, '0');
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /**
   * 数字千分位（契约 `fmtNum()`，缺失回退 `toLocaleString`）。
   *
   * @param {number} n 数字
   * @returns {string} 文本
   */
  function fmtNum(n) {
    const shared = ui().fmtNum;
    if (typeof shared === 'function') return shared(n);
    const value = Number(n);
    if (!Number.isFinite(value)) return '-';
    return value.toLocaleString('en-US');
  }

  /**
   * `chatKey` → 消息端点路径段（`group:123` → `group_123`）。
   *
   * @param {string} key 群键
   * @returns {string} 路径段
   */
  function pathKeyOf(key) {
    return String(key || '').replace(':', '_');
  }

  /**
   * 群显示名（无名时退化为群键）。
   *
   * @param {object} chat 群条目
   * @returns {string} 显示名
   */
  function titleOf(chat) {
    const key = String((chat && (chat.key || chat.chatKey)) || '');
    const name = state.names[key] || (chat && chat.chatName) || '';
    return name || key || '-';
  }

  /**
   * 按群键取群条目。
   *
   * @param {string} key 群键
   * @returns {object|null} 群条目
   */
  function chatOf(key) {
    for (const c of state.chats) {
      if (String(c.key || c.chatKey || '') === String(key || '')) return c;
    }
    return null;
  }

  /**
   * 某群全部会话记录（按开始时间倒序）。
   *
   * @param {string} key 群键
   * @returns {object[]} 会话摘要列表
   */
  function sessionsOf(key) {
    return state.sessions
      .filter((s) => String(s.chatKey || '') === String(key || ''))
      .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  }

  /**
   * 某群最近一条会话记录。
   *
   * @param {string} key 群键
   * @returns {object|null} 会话摘要
   */
  function latestSessionOf(key) {
    const list = sessionsOf(key);
    return list.length ? list[0] : null;
  }

  /**
   * 消息请求查询串。
   *
   * @returns {string} `?limit=N` 或空串
   */
  function limitQuery() {
    return state.msgLimit > 0 ? '?limit=' + state.msgLimit : '';
  }

  /**
   * 过滤判据：群键 / 群名包含关键字（大小写不敏感）。
   *
   * @param {object} chat 群条目
   * @returns {boolean} 是否保留
   */
  function matchFilter(chat) {
    const needle = String(state.filter || '').trim().toLowerCase();
    if (!needle) return true;
    const key = String((chat && (chat.key || chat.chatKey)) || '').toLowerCase();
    const name = String(state.names[key] || '').toLowerCase();
    return key.indexOf(needle) >= 0 || name.indexOf(needle) >= 0;
  }

  /**
   * 群条目 → 左栏行。
   *
   * @param {object} chat 群条目
   * @param {string} key 群键
   * @returns {Element} 行元素
   */
  function chatRow(chat, key) {
    const total = Number(chat.total) || 0;
    const unread = Number(chat.unread) || 0;
    const latest = latestSessionOf(key);
    const badge = latest ? (STATUS_LABEL[latest.status] || String(latest.status || '')) : '';
    const meta = el('div', { class: 'r5-chat-meta' },
      el('span', { class: 'groups-item-id mono', text: key }),
      el('span', { class: 'hint', text: total + ' 条' }),
      unread > 0 ? el('span', { class: 'hint', text: '未读 ' + unread }) : null,
      Number(chat.readSegments) > 0 ? el('span', { class: 'hint', text: '前情 ' + chat.readSegments + ' 段' }) : null,
      badge ? el('span', { class: 'hint', text: badge }) : null);

    const row = el('div', { class: 'groups-item r5-chat' + (key === state.currentKey ? ' on' : '') },
      el('div', { class: 'groups-item-main' },
        el('div', { class: 'groups-item-name', text: titleOf(chat) }),
        meta),
      el('span', { class: 'groups-item-id hint', text: chat.lastTs ? fmtTime(chat.lastTs) : '-' }));
    row.onclick = () => selectChat(key);
    return row;
  }

  /**
   * 左栏渲染（全量，不截断）。
   *
   * @returns {void}
   */
  function renderList() {
    if (!refs) return;
    const list = refs.listEl;
    list.textContent = '';

    const all = state.chats.slice().sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
    const shown = all.filter(matchFilter);
    refs.countEl.textContent = state.error ? '不可用' : shown.length + ' / ' + all.length + ' 个群';

    if (state.error) {
      fail(list, UNREACHABLE + '：' + state.error);
      refs.footEl.textContent = '';
      return;
    }
    if (!all.length) {
      empty(list, '还没有群会话');
      refs.footEl.textContent = '';
      return;
    }
    if (!shown.length) {
      empty(list, '没有匹配「' + state.filter + '」的群');
    } else {
      for (const chat of shown) {
        list.appendChild(chatRow(chat, String(chat.key || chat.chatKey || '')));
      }
    }
    refs.footEl.textContent = '共 ' + all.length + ' 个群 · ' + state.sessions.length + ' 条会话记录'
      + (state.updatedAt ? ' · ' + fmtTime(state.updatedAt) + ' 更新' : '');
  }

  /**
   * 单条群消息 → 行。
   *
   * @param {object} msg 消息
   * @returns {Element} 行元素
   */
  function messageRow(msg) {
    const media = Array.isArray(msg.media) ? msg.media : [];
    const top = el('div', { class: 'r5-msg-top' },
      el('span', { class: 'r5-msg-from', text: msg.senderName || msg.senderId || '未知' }),
      msg.self ? el('span', { class: 'hint', text: '我' }) : null,
      el('span', { class: 'r5-msg-time hint mono', text: msg.ts ? fmtTime(msg.ts) : '-' }),
      media.length ? el('span', { class: 'hint', text: '[' + media.length + ' 个媒体]' }) : null,
      msg.read === false ? el('span', { class: 'hint', text: '未读' }) : null);
    return el('div', { class: 'r5-msg' },
      top,
      el('div', { class: 'r5-msg-text', text: msg.text || '（空消息）' }));
  }

  /**
   * 单条会话记录 → 行。
   *
   * @param {object} s 会话摘要
   * @returns {Element} 行元素
   */
  function sessionRow(s) {
    const usage = s.usage || {};
    return el('div', { class: 'r5-sess' },
      el('div', { class: 'r5-sess-top' },
        el('span', { class: 'r5-sess-id mono', text: String(s.id || '-') }),
        el('span', { class: 'hint', text: STATUS_LABEL[s.status] || String(s.status || '-') }),
        el('span', { class: 'hint', text: (Number(s.rounds) || 0) + ' 轮' }),
        el('span', { class: 'hint', text: 'in ' + fmtNum(Number(usage.promptTokens) || 0)
          + ' · out ' + fmtNum(Number(usage.completionTokens) || 0) }),
        el('span', { class: 'hint', text: String(s.model || '-') }),
        el('span', { class: 'hint mono', text: s.startedAt ? fmtTime(s.startedAt) : '-' })),
      el('div', { class: 'r5-sess-trigger hint', text: String(s.trigger || '') }));
  }

  /**
   * 右栏头部（换群时整体重建）。
   *
   * @param {object} chat 当前群
   * @param {string} key 群键
   * @returns {Element} 头部元素
   */
  function detailHead(chat, key) {
    const total = Number(chat && chat.total) || 0;
    const unread = Number(chat && chat.unread) || 0;

    const reloadBtn = el('button', { class: 'btn small', text: '刷新消息' });
    reloadBtn.onclick = () => loadMessages(key);

    const compactBtn = el('button', { class: 'btn small', text: '压缩前情' });
    compactBtn.onclick = () => compactChat(key);

    const limitSel = el('select', { class: 'btn small' });
    for (const item of MSG_LIMITS) {
      limitSel.appendChild(el('option', { value: String(item.value), text: item.label }));
    }
    limitSel.value = String(state.msgLimit);
    limitSel.onchange = (event) => {
      state.msgLimit = Number(event.target.value) || 0;
      loadMessages(key);
    };

    return el('div', { class: 'card r5-detail-head' },
      el('div', { class: 'r5-detail-title' },
        el('h3', { text: titleOf(chat) }),
        el('span', { class: 'hint', text: chat && chat.lastTs ? '最近 ' + fmtTime(chat.lastTs) : '' })),
      el('div', { class: 'r5-detail-actions' },
        el('span', { class: 'mono hint', text: key }),
        el('span', { class: 'hint', text: '存档 ' + total + ' 条' }),
        unread > 0 ? el('span', { class: 'hint', text: '未读 ' + unread }) : null,
        el('span', { class: 'hint', text: '会话 ' + sessionsOf(key).length + ' 条' }),
        el('span', { class: 'hint', text: '已载入 ' + state.messages.length + ' 条消息' }),
        state.compactNote ? el('span', { class: 'hint', text: '压缩：' + state.compactNote }) : null,
        el('span', { class: 'groups-spacer' }),
        limitSel, reloadBtn, compactBtn));
  }

  /**
   * 右栏渲染：头部 + 消息流 + 会话记录。
   *
   * @returns {void}
   */
  function renderDetail() {
    if (!refs) return;
    refs.headEl.textContent = '';
    refs.bodyEl.textContent = '';

    const key = state.currentKey;
    const chat = chatOf(key);
    if (!key) {
      empty(refs.bodyEl, '← 选择左侧的群查看消息存档');
      return;
    }
    refs.headEl.appendChild(detailHead(chat, key));

    if (state.detailError) {
      fail(refs.bodyEl, UNREACHABLE + '：' + state.detailError);
      return;
    }
    if (state.loadingMessages) {
      empty(refs.bodyEl, '正在载入消息…');
      return;
    }
    if (!state.messages.length) {
      empty(refs.bodyEl, '这个群还没有存档消息');
    } else {
      const flow = el('div', { class: 'r5-msg-flow' });
      for (const msg of state.messages) flow.appendChild(messageRow(msg));
      refs.bodyEl.appendChild(flow);
    }

    const list = sessionsOf(key);
    if (list.length) {
      const wrap = el('div', { class: 'r5-sess-wrap' },
        el('div', { class: 'r5-sess-head hint', text: '会话记录（' + list.length + ' 条，按开始时间倒序）' }));
      for (const s of list) wrap.appendChild(sessionRow(s));
      refs.bodyEl.appendChild(wrap);
    }
  }

  /**
   * 发一次消息请求并渲染。
   *
   * @param {string} key 群键
   * @returns {Promise<void>} 完成
   */
  async function loadMessages(key) {
    if (!refs || !key) return;
    const api = ui().api;
    if (typeof api !== 'function') {
      state.detailError = '契约未就绪（window.__ui.api 缺失）';
      renderDetail();
      return;
    }
    const token = ++seq;
    state.loadingMessages = true;
    state.detailError = '';
    renderDetail();

    const res = await api('/api/biz/chats/' + pathKeyOf(key) + '/messages' + limitQuery());
    if (token !== seq) return;                          // 迟到响应：已切群，丢弃
    state.loadingMessages = false;

    if (!res || res.ok === false) {
      state.detailError = String((res && res.error) || ('HTTP ' + (res && res.status)));
      state.messages = [];
    } else {
      state.messages = Array.isArray(res.messages) ? res.messages : [];
    }
    renderList();
    renderDetail();
  }

  /**
   * 手动压一次已读前情（写类端点，只在用户点击时调用）。
   *
   * @param {string} key 群键
   * @returns {Promise<void>} 完成
   */
  async function compactChat(key) {
    const api = ui().api;
    if (typeof api !== 'function' || !key) return;
    const res = await api('/api/biz/session/compact', { method: 'POST', body: { chatKey: key, force: true } });
    if (!res || res.ok === false) {
      state.compactNote = '失败 · ' + String((res && (res.error || res.status)) || '-');
    } else {
      state.compactNote = res.skipped ? ('跳过 · ' + String(res.reason || 'unchanged')) : '完成';
    }
    renderDetail();
  }

  /**
   * 选中一个群：重置消息面并立刻取数。
   *
   * @param {string} key 群键
   * @returns {Promise<void>} 取数链
   */
  function selectChat(key) {
    if (!key) return Promise.resolve();
    const same = String(state.currentKey || '') === String(key);
    state.currentKey = key;
    state.compactNote = '';
    if (!same) {
      state.messages = [];
      state.detailError = '';
    }
    renderList();
    return loadMessages(key);
  }

  /**
   * 清空全部已结束的会话记录（写类端点，用户点击才调用）。
   *
   * @returns {Promise<void>} 完成
   */
  async function clearFinished() {
    const api = ui().api;
    if (typeof api !== 'function') return;
    const res = await api('/api/biz/sessions/clear-finished', { method: 'POST', body: {} });
    if (!res || res.ok === false) {
      state.error = String((res && (res.error || res.status)) || '-');
      renderList();
      return;
    }
    await refresh();
  }

  /**
   * 一次完整取数（sessions + chats 并行）。
   *
   * @returns {Promise<void>} 完成
   */
  async function runRefresh() {
    if (!refs) return;
    const api = ui().api;
    if (typeof api !== 'function') {
      state.error = '契约未就绪（window.__ui.api 缺失）';
      renderList();
      renderDetail();
      return;
    }

    const pair = await Promise.all([api('/api/biz/sessions'), api('/api/biz/chats')]);
    const main = pair[0] || {};
    const names = pair[1] || {};

    if (main.ok === false) {
      state.error = String(main.error || ('HTTP ' + main.status));
      state.chats = [];
      state.sessions = [];
      state.messages = [];
      state.detailError = '';
      state.updatedAt = Date.now();
      renderList();
      renderDetail();
      return;
    }

    state.error = '';
    state.chats = Array.isArray(main.chats) ? main.chats : [];
    state.sessions = Array.isArray(main.sessions) ? main.sessions : [];
    state.names = {};
    if (names.ok !== false && Array.isArray(names.chats)) {
      for (const c of names.chats) {
        const key = String((c && (c.key || c.chatKey)) || '');
        if (key && c.chatName) state.names[key] = String(c.chatName);
      }
    }

    // 选中的群若已消失（记录被清），回落到第一个群
    const exists = state.currentKey && !!chatOf(state.currentKey);
    if (!exists) {
      state.currentKey = state.chats.length ? String(state.chats[0].key || state.chats[0].chatKey || '') : null;
      state.messages = [];
      state.detailError = '';
    }
    state.updatedAt = Date.now();
    renderList();

    if (state.currentKey) await loadMessages(state.currentKey);
    else renderDetail();
  }

  /**
   * 刷新（单飞：并发调用复用同一 Promise）。
   *
   * @returns {Promise<void>} 完成
   */
  function refresh() {
    if (inflight) return inflight;
    inflight = runRefresh()
      .catch((err) => {
        state.error = String((err && err.message) || err || '未知错误');
        renderList();
      })
      .then(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * 建页骨架（首次切到本页调用一次，不发请求）。
   *
   * @param {Element} container `#view-sessions`
   * @returns {void}
   */
  function mount(container) {
    if (!container) return;
    container.textContent = '';

    const countEl = el('span', { class: 'r5-count hint', text: '-' });
    const filterInput = el('input', { class: 'r5-filter', type: 'text', placeholder: '过滤：群号 / 群名' });
    const reloadBtn = el('button', { class: 'btn small', text: '刷新' });
    const clearBtn = el('button', { class: 'btn small', text: '清空已结束' });
    const listEl = el('div', { class: 'groups-drop r5-list' });
    const footEl = el('div', { class: 'r5-foot hint' });
    const headEl = el('div', { class: 'r5-detail-heads' });
    const bodyEl = el('div', { class: 'groups-drop r5-detail-body' });

    filterInput.oninput = (event) => {
      state.filter = String(event.target.value || '');
      renderList();
    };
    reloadBtn.onclick = () => refresh();
    clearBtn.onclick = () => clearFinished();

    const rootEl = el('div', { class: 'groups-board r5-sessions' },
      el('aside', { class: 'groups-col r5-list-pane' },
        el('div', { class: 'groups-bar r5-list-bar' }, countEl, filterInput, reloadBtn, clearBtn),
        listEl,
        footEl),
      el('section', { class: 'groups-col r5-detail-pane' }, headEl, bodyEl));

    container.appendChild(rootEl);
    refs = { countEl, listEl, footEl, headEl, bodyEl, filterInput };

    // mount 只建骨架，不发请求——取数归 refresh()
    renderList();
    empty(bodyEl, '← 选择左侧的群查看消息存档');
  }

  const views = (window.__views = window.__views || {});
  const view = { title: '会话', mount, refresh };
  views.sessions = view;
  if (typeof ui().registerView === 'function') ui().registerView('sessions', view);
})();
