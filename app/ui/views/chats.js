// app/ui/views/chats.js —— 存档页视图块（R5-L3）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L3**
// 契约：`app/ui/views/_index.md` §三（运行时只读 `window.__ui`；块内不写 fetch，一律走 `api()`）
// 状态：✅ 已实现（R5-L3 交付）
//
// 面：左栏 = 群选择器（条目数 = `/api/biz/chats` 的 `chats.length`，全量不截断；过滤框只影响可见行）；
//     右栏 = 选中群的历史存档（按天分组、新在上），右栏头「加载更早」继续往旧翻、「回到最新」重置。
//
// 🔴 翻页口径 —— 卡（§四 L3「`?limit=` 不同两批无交集」）与业务面实况的差异，按实况实现：
//   路由 `^/api/chats/(group|private)_(\d+)/messages$`（`app/src/business/routes.js:1463`）只吃 `limit`，
//   **不吃 `offset`**；`limit` 语义见 `store.recent(chatKey,{limit})`（`app/src/business/store.js:273`）
//   = 取最近 N 条。所以「第 k 批」= 请求 `?limit=k*PAGE`，再切掉窗口里前 k-1 批已经覆盖的（更新的）那一段，
//   只留比已载入更早的 PAGE 条。后一批永远是前一批之前的消息 → 两批 id 集合天然无交集（本页去重判据）。
//   代价：`?limit=` 随翻页单调增长（第 3 批请求 300 条只落 100 条）。`offset` 一旦在路由透出，
//   本函数改两行即可变真分页——现在不自行造端点（§0-6）。
//
// 取数：`/api/biz/chats`（群 + `chatName`/`total`/`unread`/`lastTs`/`lastText`）
//       `/api/biz/chats/<group_xxx>/messages?limit=<k*PAGE>`（消息：id/mid/ts/senderId/senderName/text/self/read/reply/media）
// 空态 / 失败态：走 `empty()` / `fail()`，失败文案带 3210；不发裸请求、不渲染假数据。

(function () {
  'use strict';

  /** 每批条数（同时是 `?limit=` 的步长）。 */
  const PAGE = 100;

  /** 最多翻多少批（防御：超长存档不无限制加窗口；30 批 × 100 = 3000 条，与原版单次 `limit=3000` 同量级）。 */
  const MAX_BATCH = 30;

  /** 失败态统一文案前缀（契约要求含 3210）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /** 外壳未就绪文案（L1 未落地时 `window.__ui.api` 不存在——不是业务面的错，别混成 3210 不可达）。 */
  const NO_SHELL = '外壳未就绪：window.__ui.api 缺失（等 L1 `_shell.js` 落地）';

  /**
   * 失败文案组装：外壳缺失原样透出，业务面失败统一挂 3210 前缀。
   *
   * @param {string} err 原因
   * @returns {string} 展示文案
   */
  function errText(err) {
    const s = String(err || '-');
    return s.indexOf('外壳未就绪') === 0 ? s : (UNREACHABLE + '：' + s);
  }

  /** DOM 容器引用（mount 建一次，refresh 只换内容）。 */
  let refs = null;

  /** 单飞句柄。 */
  let inflight = null;

  /** 请求序号：迟到响应按序号丢弃（群列表 / 消息各一路）。 */
  let chatsSeq = 0;
  let msgsSeq = 0;

  /** 界面态（业务真相每次从接口读，不在这里缓存结论）。 */
  const state = {
    chats: [],
    filter: '',
    currentKey: null,
    messages: [],        // 倒序：新 → 旧
    batch: 0,            // 已载入批数
    exhausted: false,    // 已翻到最早
    total: 0,            // 该群存档总条数（群 meta 的 total）
    error: '',
    detailError: '',
    busy: false,
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
   * @param {object} [attrs] 属性（`class` / `text` / `style` / `onclick` 等按名赋）
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
    node.appendChild(h('p', { class: 'view-empty', text: text }));
  }

  /**
   * 失败态渲染（契约 `fail()`，缺失回退红字一行——不是弹窗）。
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
    node.appendChild(h('p', { class: 'view-fail', text: error }));
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
   * 毫秒时间戳 → 日期标题（本地时区 `YYYY-MM-DD`）。
   *
   * @param {number} ms 时间戳
   * @returns {string} 日期串（非法值给 '-'）
   */
  function dayOf(ms) {
    const n = Number(ms);
    if (!n) return '-';
    const d = new Date(n);
    const p2 = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
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
   * 群条目 → 显示名（无名时退化为群键）。
   *
   * @param {object} chat 群条目
   * @returns {string} 显示名
   */
  function titleOf(chat) {
    const key = String((chat && (chat.key || chat.chatKey)) || '');
    const name = String((chat && chat.chatName) || '');
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
   * 过滤判据：群键 / 群名包含关键字（大小写不敏感）。
   *
   * @param {object} chat 群条目
   * @returns {boolean} 是否保留
   */
  function matchFilter(chat) {
    const needle = String(state.filter || '').trim().toLowerCase();
    if (!needle) return true;
    const key = String((chat && (chat.key || chat.chatKey)) || '').toLowerCase();
    const name = String((chat && chat.chatName) || '').toLowerCase();
    return key.indexOf(needle) >= 0 || name.indexOf(needle) >= 0;
  }

  /**
   * 群条目 → 左栏一行。
   *
   * @param {object} chat 群条目
   * @returns {Element} 行元素
   */
  function chatRow(chat) {
    const key = String(chat.key || chat.chatKey || '');
    const total = Number(chat.total) || 0;
    const unread = Number(chat.unread) || 0;
    const sub = el('div', { class: 'list-item-sub', text: unread > 0 ? ('未读 ' + unread + ' · ' + total + ' 条') : (total + ' 条') });
    const row = el('div', { class: 'list-item' + (key === state.currentKey ? ' active' : '') },
      el('div', { class: 'list-item-main' },
        el('div', { class: 'list-item-title', text: titleOf(chat) }),
        sub,
        el('div', { class: 'list-item-sub mono', text: key })),
      el('span', { class: 'list-item-meta', text: chat.lastTs ? fmtTime(chat.lastTs) : '-' }));
    row.onclick = () => selectChat(key);
    return row;
  }

  /**
   * 左栏渲染：群选择器（全量渲染，过滤只影响可见行）。
   *
   * @returns {void}
   */
  function renderList() {
    if (!refs) return;
    const list = refs.listEl;
    list.textContent = '';

    const all = state.chats.slice().sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
    refs.countEl.textContent = state.error ? '不可用' : (shownCount(all) + ' / ' + all.length + ' 个群');

    if (state.error) {
      fail(list, errText(state.error));
      return;
    }
    if (!all.length) {
      empty(list, '还没有消息存档（等白名单里的群 / 好友来消息）');
      return;
    }
    const shown = all.filter(matchFilter);
    if (!shown.length) {
      empty(list, '没有匹配「' + state.filter + '」的群');
      return;
    }
    for (const chat of shown) list.appendChild(chatRow(chat));
  }

  /**
   * 过滤后的可见行数。
   *
   * @param {object[]} list 群列表
   * @returns {number} 条数
   */
  function shownCount(list) {
    return list.filter(matchFilter).length;
  }

  /**
   * 单条消息 → 行。
   *
   * @param {object} m 消息
   * @returns {Element} 行元素
   */
  function msgRow(m) {
    const media = Array.isArray(m.media) ? m.media : [];
    const head = el('div', { class: 'msg-head' },
      el('span', { class: 'who', text: m.self ? '我' : (m.senderName || m.senderId || '未知') }),
      m.self ? el('span', { class: 'badge', text: '自己' }) : null,
      el('span', { class: 'mono', text: fmtTime(m.ts) }),
      media.length ? el('span', { class: 'badge', text: media.length + ' 个媒体' }) : null,
      m.read === false ? el('span', { class: 'badge warn', text: '未读' }) : null);
    return el('div', { class: 'msg' + (m.self ? ' self' : '') },
      head,
      el('div', { class: 'msg-text', text: m.text || '（空消息）' }));
  }

  /**
   * 右栏消息区渲染：按天分组、新在上。
   *
   * @returns {void}
   */
  function renderMessages() {
    if (!refs) return;
    const body = refs.msgEl;
    body.textContent = '';

    if (state.detailError) {
      fail(body, errText(state.detailError));
      return;
    }
    if (!state.currentKey) {
      empty(body, '← 选择左侧的群查看历史存档');
      return;
    }
    if (!state.messages.length) {
      empty(body, state.busy ? '正在载入消息…' : '这个群还没有存档消息');
      return;
    }

    const wrap = el('div', { class: 'msg-list' });
    let day = '';
    for (const m of state.messages) {
      const d = dayOf(m.ts);
      if (d !== day) {
        day = d;
        wrap.appendChild(el('div', { class: 'toolbar' },
          el('span', { class: 'badge', text: d })));
      }
      wrap.appendChild(msgRow(m));
    }
    body.appendChild(wrap);
  }

  /**
   * 右栏头渲染：标题 / 群键 / 计数 / 翻页按钮可用态。
   *
   * @returns {void}
   */
  function renderHead() {
    if (!refs) return;
    const key = state.currentKey;
    const chat = chatOf(key);

    refs.titleEl.textContent = chat ? titleOf(chat) : '存档';
    refs.keyEl.textContent = key || '-';

    const parts = [];
    if (state.total) parts.push('存档 ' + fmtNum(state.total) + ' 条');
    if (state.messages.length) parts.push('已载入 ' + fmtNum(state.messages.length) + ' 条');
    if (state.batch) parts.push('第 ' + state.batch + ' 批');
    if (state.busy) parts.push('载入中…');
    else if (state.exhausted && state.messages.length) parts.push('已到最早');
    else if (state.messages.length) parts.push('还有更早');
    if (state.updatedAt) parts.push(fmtTime(state.updatedAt) + ' 更新');
    refs.metaEl.textContent = parts.join(' · ');

    refs.olderBtn.disabled = !key || state.busy || state.exhausted || state.batch >= MAX_BATCH;
    refs.latestBtn.disabled = !key || state.busy || state.batch === 0;
  }

  /**
   * 三处一起重画。
   *
   * @returns {void}
   */
  function renderAll() {
    renderList();
    renderHead();
    renderMessages();
  }

  /**
   * 拉一批消息。
   *
   * @param {boolean} grow true = 往更早翻一批（累加）；false = 重置为最新一批
   * @returns {Promise<void>} 完成
   */
  async function loadBatch(grow) {
    const key = state.currentKey;
    if (!key) return Promise.resolve();
    if (grow && (state.exhausted || state.busy || state.batch >= MAX_BATCH)) return Promise.resolve();

    const api = ui().api;
    if (typeof api !== 'function') {
      state.detailError = NO_SHELL;
      state.busy = false;
      renderAll();
      return Promise.resolve();
    }

    const next = grow ? state.batch + 1 : 1;
    const token = ++msgsSeq;
    state.busy = true;
    state.detailError = '';
    renderHead();

    const path = '/api/biz/chats/' + pathKeyOf(key) + '/messages?limit=' + (next * PAGE);
    const res = await api(path);
    if (token !== msgsSeq) return undefined;        // 迟到响应：已切群 / 已重置，丢弃

    state.busy = false;
    if (!res || res.ok === false) {
      state.detailError = String((res && (res.error || ('HTTP ' + (res && res.status)))) || '未知错误');
      if (!grow) {
        state.messages = [];
        state.batch = 0;
        state.exhausted = false;
      }
      renderAll();
      return undefined;
    }

    const all = Array.isArray(res.messages) ? res.messages : [];   // 升序：旧 → 新
    const covered = grow ? (next - 1) * PAGE : 0;                  // 窗口里已载入过的（更新的）条数
    const upto = Math.max(0, all.length - covered);
    // 截断锚：窗口「旧 → 新」升序，前 upto 条就是比已载入更早的那一段——与已载入批次无交集。
    const chunk = all.slice(0, upto);
    // 本批内部按「新 → 旧」排列；整体段比已载入更旧，所以追加到**尾部**（列表是「新在上」）
    const fresh = chunk.slice().reverse();
    state.messages = grow ? state.messages.concat(fresh) : fresh;
    state.batch = next;
    // 窗口没被填满，或本批切出 0 条 = 已翻到最早
    state.exhausted = all.length < next * PAGE || chunk.length === 0;
    const chat = chatOf(key);
    state.total = Number(chat && chat.total) || 0;
    state.updatedAt = Date.now();
    renderAll();
    return undefined;
  }

  /**
   * 选中一个群：重置消息面并取第一批。
   *
   * @param {string} key 群键
   * @returns {Promise<void>} 取数链
   */
  function selectChat(key) {
    if (!key) return Promise.resolve();
    if (String(state.currentKey || '') === String(key)) return Promise.resolve();
    state.currentKey = key;
    state.messages = [];
    state.batch = 0;
    state.exhausted = false;
    state.detailError = '';
    const chat = chatOf(key);
    state.total = Number(chat && chat.total) || 0;
    renderList();
    renderHead();
    if (refs && refs.msgEl) refs.msgEl.textContent = '';
    return loadBatch(false);
  }

  /**
   * 一次完整取数：群列表（+ 选中群的第一批消息）。
   *
   * @returns {Promise<void>} 完成
   */
  async function runRefresh() {
    if (!refs) return;
    const api = ui().api;
    if (typeof api !== 'function') {
      state.error = NO_SHELL;
      state.chats = [];
      renderAll();
      return;
    }

    const token = ++chatsSeq;
    const res = await api('/api/biz/chats');
    if (token !== chatsSeq) return;

    if (!res || res.ok === false) {
      state.error = String((res && (res.error || ('HTTP ' + (res && res.status)))) || '未知错误');
      state.chats = [];
      state.messages = [];
      state.detailError = '';
      state.batch = 0;
      state.exhausted = false;
      state.updatedAt = Date.now();
      renderAll();
      return;
    }

    state.error = '';
    state.chats = Array.isArray(res.chats) ? res.chats : [];
    state.updatedAt = Date.now();

    // 选中的群若已消失（存档被清），回落到最近活跃的第一个群
    const keep = state.currentKey && !!chatOf(state.currentKey);
    if (!keep) {
      const byRecent = state.chats.slice().sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
      const first = byRecent.length ? byRecent[0] : null;
      state.currentKey = first ? String(first.key || first.chatKey || '') : null;
      state.messages = [];
      state.batch = 0;
      state.exhausted = false;
      state.detailError = '';
      if (state.currentKey) state.total = Number((chatOf(state.currentKey) || {}).total) || 0;
    }

    renderList();
    await loadBatch(false);
    renderAll();
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
        renderAll();
      })
      .then(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * 建页骨架（首次切到本页调用一次，不发请求）。
   *
   * @param {Element} container `#view-chats`
   * @returns {void}
   */
  function mount(container) {
    if (!container) return;
    container.textContent = '';

    // ── 左栏：群选择器 ──────────────────────────────────────────────
    const countEl = el('span', { class: 'hint', text: '-' });
    const filterInput = el('input', { type: 'text', placeholder: '过滤：群号 / 群名' });
    const reloadBtn = el('button', { class: 'btn small', text: '刷新' });
    const listEl = el('div', {});
    const listBody = el('div', { class: 'pane-body' }, listEl);

    filterInput.oninput = (event) => {
      state.filter = String(event.target.value || '');
      renderList();
    };
    reloadBtn.onclick = () => refresh();

    const listPane = el('aside', { class: 'pane narrow' },
      el('div', { class: 'pane-head' },
        el('span', { class: 'title', text: '存档' }),
        el('span', { class: 'spacer' }),
        countEl),
      el('div', { class: 'toolbar' }, filterInput, reloadBtn),
      listBody);

    // ── 右栏：消息区 ────────────────────────────────────────────────
    const titleEl = el('span', { class: 'title', text: '存档' });
    const keyEl = el('span', { class: 'hint mono', text: '-' });
    const metaEl = el('span', { class: 'hint', text: '' });
    const olderBtn = el('button', { class: 'btn small', text: '加载更早' });
    const latestBtn = el('button', { class: 'btn small', text: '回到最新' });
    const msgEl = el('div', { class: 'pane-body' });

    olderBtn.onclick = () => loadBatch(true);
    latestBtn.onclick = () => loadBatch(false);

    const detailPane = el('section', { class: 'pane wide' },
      el('div', { class: 'pane-head' },
        titleEl, keyEl, el('span', { class: 'spacer' }), metaEl, olderBtn, latestBtn),
      msgEl);

    container.appendChild(el('div', { class: 'split' }, listPane, detailPane));

    refs = { countEl, listEl, filterInput, reloadBtn, titleEl, keyEl, metaEl, olderBtn, latestBtn, msgEl };

    // mount 只建骨架，不发请求——取数归 refresh()
    renderAll();
  }

  const views = (window.__views = window.__views || {});
  const view = { title: '存档', mount, refresh };
  views.chats = view;
  if (typeof ui().registerView === 'function') ui().registerView('chats', view);
})();
