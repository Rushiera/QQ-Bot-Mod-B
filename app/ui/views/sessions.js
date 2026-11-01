// app/ui/views/sessions.js —— 会话页视图块（原版 QQ Agent 样式重做）
//
// 契约：`app/ui/views/_index.md` §三（运行时只读 `window.__ui`；块内不发裸请求，一律走 `api()`）
//
// 面（照原版 `_unpack/resources/app/ui/app/02-sse-sessions.js` 的两栏结构）：
//   左栏 = **会话记录列表**——按群折叠，组内每条会话一行（状态 / 轮数 / 时间 / 触发摘要），
//          条数 = `/api/biz/sessions` 的 `sessions.length`，全量不截断；
//   右栏 = 选中会话的**完整过程**——系统提示 / 本次输入 / 思考卡 / 工具卡 / 已发送 / 错误 / finish。
//
// 过程卡的渲染口径参照 CH4 会话页（`mau:CatHome4/html/js/chat/blocks/`）：
//   · 思考卡 = 头行（Think + 统计）+ 两档正文（peek 首末行 / full 全文），点击头行切档；
//   · 工具卡 = `<details>` 折叠，summary 显 图标 + 工具名 + 成败，展开见 参数 / 结果；
//   · 失败态在行级标色（`isErrResult` 同口径：ERR 前缀 或 结构化头的 ok:false）。
//
// 取数：`/api/biz/sessions`（列表 + 群一级）· `/api/biz/chats`（群名）
//       `/api/biz/sessions/<id>`（详情：messages / sent / usage / systemPrompt / userPrompt）
//       `DELETE /api/biz/sessions/<id>` · `POST /api/biz/sessions/clear-finished`
//       `POST /api/biz/sessions/<id>/retry`
//
// 🔴 批量请求一律**不复用**「群消息」端点——群消息归「存档」页，会话过程归本页，两个面不混。

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

  /** 运行中状态的集合——只有这些状态的会话才需要定时刷新详情。 */
  const LIVE = { running: true, waiting: true };

  /** 运行中会话的详情刷新间隔（毫秒）。 */
  const LIVE_MS = 4000;

  /** 失败态统一文案前缀（契约要求含 3210）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /** DOM 容器引用（mount 建一次，refresh 只换内容）。 */
  let refs = null;

  /** 单飞句柄（列表 / 详情各一路）。 */
  let listInflight = null;
  let detailInflight = null;

  /** 请求序号：迟到响应按序号丢弃。 */
  let listSeq = 0;
  let detailSeq = 0;

  /** 运行中详情轮询定时器。 */
  let liveTimer = null;

  /** 界面态（业务真相每次从接口读，不在这里缓存结论）。 */
  const state = {
    sessions: [],
    chats: [],
    names: {},
    currentId: null,
    detail: null,
    filter: '',
    collapsed: {},      // chatKey → true（折叠）
    error: '',
    detailError: '',
    jsonMode: false,
    updatedAt: 0
  };

  // ── 契约取用（只读，缺失时本地兜底） ────────────────────────────────────

  /**
   * 取共享契约对象。
   *
   * @returns {object} `window.__ui`（不存在时给空对象）
   */
  function ui() {
    return window.__ui || {};
  }

  /**
   * 建元素（优先 `__ui.el`，缺失时本地兜底，语义一致）。
   *
   * @param {string} tag 标签名
   * @param {object} [attrs] 属性（`class` / `text` / `style` / `on<事件>` 等按名赋）
   * @param {...*} kids 子节点
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
    const node = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach((key) => {
      const value = a[key];
      if (value === null || value === undefined) return;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = String(value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    });
    const append = (list) => list.forEach((k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) { append(k); return; }
      node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
    append(kids);
    return node;
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
    node.appendChild(el('p', { class: 'hint r5-empty', text: text }));
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
    node.appendChild(el('p', { class: 'r5-fail', text: error }));
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
   * 数字千分位。
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
   * 任意错误值 → 一句人话。
   *
   * @param {*} error 错误值
   * @returns {string} 文案
   */
  function textOf(error) {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (error.error) return String(error.error);
    if (error.message) return String(error.message);
    return String(error);
  }

  /**
   * 群显示名（无名时退化为群键）。
   *
   * @param {string} key 群键
   * @returns {string} 显示名
   */
  function nameOf(key) {
    const k = String(key || '');
    return state.names[k] || k || '-';
  }

  /**
   * 过滤判据：会话 id / 群键 / 群名 / 触发摘要包含关键字（大小写不敏感）。
   *
   * @param {object} s 会话摘要
   * @returns {boolean} 是否保留
   */
  function matchFilter(s) {
    const needle = String(state.filter || '').trim().toLowerCase();
    if (!needle) return true;
    const key = String(s.chatKey || '');
    const hay = [s.id, key, state.names[key] || '', s.triggerSummary || s.trigger || '', s.model || '']
      .join(' ').toLowerCase();
    return hay.indexOf(needle) >= 0;
  }

  /**
   * 会话按群分组（组内按开始时间倒序，组间按最新一条倒序）。
   *
   * @param {object[]} list 会话摘要列表
   * @returns {Array<{key: string, items: object[]}>} 分组
   */
  function groupByChat(list) {
    const map = new Map();
    for (const s of list) {
      const key = String(s.chatKey || '(未知会话)');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    const out = [];
    for (const [key, items] of map) {
      items.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
      out.push({ key, items });
    }
    out.sort((a, b) => Number(b.items[0].startedAt || 0) - Number(a.items[0].startedAt || 0));
    return out;
  }

  // ── 左栏：会话记录列表 ──────────────────────────────────────────────────

  /**
   * 会话状态徽标。
   *
   * @param {string} status 状态值
   * @returns {Element} 徽标元素
   */
  function statusBadge(status) {
    const s = String(status || '');
    return el('span', { class: 'sx-badge sx-' + (s || 'unknown'), text: STATUS_LABEL[s] || s || '-' });
  }

  /**
   * 单条会话记录 → 左栏行。
   *
   * @param {object} s 会话摘要
   * @returns {Element} 行元素
   */
  function sessionRow(s) {
    const usage = s.usage || {};
    const meta = el('div', { class: 'sx-row-metas' },
      el('span', { class: 'mono', text: fmtTime(s.startedAt) }),
      el('span', { text: (Number(s.rounds) || 0) + ' 轮' }),
      el('span', { text: (Number(s.promptChars) || 0) + ' 字符' }),
      usage.totalTokens ? el('span', { text: fmtNum(Number(usage.totalTokens)) + ' tok' }) : null);

    const row = el('div', {
      class: 'sx-row' + (String(s.id) === String(state.currentId) ? ' on' : ''),
      title: String(s.triggerSummary || s.trigger || '')
    },
    el('div', { class: 'sx-row-main' },
      el('div', { class: 'sx-row-title' }, statusBadge(s.status), el('span', { class: 'sx-row-id mono', text: String(s.id || '-') })),
      meta,
      el('div', { class: 'sx-row-trigger hint', text: String(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : (s.trigger || '-'))) })));
    row.addEventListener('click', () => selectSession(String(s.id || '')));
    return row;
  }

  /**
   * 左栏渲染：按群折叠的会话记录（全量，不截断）。
   *
   * @returns {void}
   */
  function renderList() {
    if (!refs) return;
    const list = refs.listEl;
    list.textContent = '';

    const all = state.sessions.slice().sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
    const shown = all.filter(matchFilter);
    refs.countEl.textContent = state.error ? '不可用' : (shown.length + ' / ' + all.length + ' 条');

    if (state.error) {
      fail(list, UNREACHABLE + '：' + state.error);
      refs.footEl.textContent = '';
      return;
    }
    if (!all.length) {
      empty(list, '还没有会话记录（群里来消息后这里会出现）');
      refs.footEl.textContent = '';
      return;
    }
    if (!shown.length) {
      empty(list, '没有匹配「' + state.filter + '」的会话');
      refs.footEl.textContent = '';
      return;
    }

    for (const group of groupByChat(shown)) {
      const open = state.collapsed[group.key] !== true;
      const head = el('div', { class: 'sx-group' + (open ? ' open' : '') },
        el('span', { class: 'sx-group-arrow', text: open ? '▾' : '▸' }),
        el('span', { class: 'sx-group-name', text: nameOf(group.key) }),
        el('span', { class: 'sx-group-count hint', text: group.items.length + ' 条' }));
      head.addEventListener('click', () => {
        state.collapsed[group.key] = open;
        renderList();
      });
      list.appendChild(head);
      if (open) {
        const box = el('div', { class: 'sx-group-body' });
        for (const s of group.items) box.appendChild(sessionRow(s));
        list.appendChild(box);
      }
    }
    refs.footEl.textContent = '共 ' + all.length + ' 条会话 · ' + groupByChat(all).length + ' 个群'
      + (state.updatedAt ? ' · ' + fmtTime(state.updatedAt) + ' 更新' : '');
  }

  // ── 右栏：过程详情 ──────────────────────────────────────────────────────

  /**
   * 结果文本是否代表失败（与 CH4 `lib/tool-format.isErrResult` 同口径）。
   *
   * @param {*} result 工具结果文本
   * @returns {boolean} 是否失败
   */
  function isErrResult(result) {
    const text = typeof result === 'string' ? result.trim() : '';
    if (!text) return false;
    if (text.indexOf('ERR|') === 0) return true;
    if (text.charAt(0) === '{') {
      try {
        const o = JSON.parse(text);
        if (o && o.ok === false) return true;
      } catch { /* 非 JSON——无失败标记 */ }
    }
    return false;
  }

  /**
   * 思考统计文本（字符 / 行数；用时未记录时不显示时间位）。
   *
   * @param {string} text 思考正文
   * @returns {string} 统计串（带前导 ` · `）
   */
  function thinkStats(text) {
    const t = typeof text === 'string' ? text : '';
    const parts = [t.length + ' 字符', t.split('\n').length + ' 行'];
    return ' · ' + parts.join(' · ');
  }

  /**
   * 思考压缩档：≥3 行取首行 + 折叠提示 + 末行，否则原文。
   *
   * @param {string} text 正文
   * @returns {string} 压缩档文本
   */
  function thinkPeek(text) {
    const t = typeof text === 'string' ? text : '';
    if (!t) return '';
    const lines = t.split('\n');
    if (lines.length < 3) return t;
    const hiddenLines = lines.length - 2;
    let hiddenChars = t.length - lines[0].length - lines[lines.length - 1].length - 2;
    if (hiddenChars < 0) hiddenChars = 0;
    return lines[0] + '\n…已折叠 ' + hiddenLines + ' 行 ' + hiddenChars + ' 字符…\n' + lines[lines.length - 1];
  }

  /**
   * 思考卡（参照 CH4 `blocks/reason.js`：头行 + 两档正文，点头行切档）。
   *
   * @param {string} text 思考正文
   * @returns {Element} 卡片元素
   */
  function thinkCard(text) {
    const body = typeof text === 'string' ? text : '';
    const box = el('div', { class: 'sx-think' },
      el('div', { class: 'sx-think-head' },
        el('span', { class: 'sx-think-label', text: 'Think' }),
        el('span', { class: 'sx-think-stat', text: thinkStats(body) })),
      el('div', { class: 'sx-think-body' },
        el('div', { class: 'sx-think-peek', text: thinkPeek(body) || '（无文本输出，仅调用工具）' }),
        el('div', { class: 'sx-think-full', text: body })));

    const head = box.firstChild;
    head.addEventListener('click', () => box.classList.toggle('full'));
    return el('div', { class: 'sx-item sx-item-think' }, box);
  }

  /**
   * 工具卡（参照 CH4 `blocks/toolcard.js`：折叠行 + 参数 / 结果段）。
   *
   * @param {object} call 工具调用 `{name, args, result, isError}`
   * @returns {Element} 卡片元素
   */
  function toolCard(call) {
    const t = call || {};
    const err = t.isError === true || isErrResult(t.result);
    const argsText = (() => {
      if (t.args === undefined || t.args === null) return '';
      if (typeof t.args === 'string') return t.args;
      try { return JSON.stringify(t.args, null, 1); } catch { return String(t.args); }
    })();
    const resultText = t.result === undefined || t.result === null ? '' : String(t.result);

    const det = el('details', { class: 'sx-tool' + (err ? ' err' : '') },
      el('summary', { class: 'sx-tool-sum' },
        el('span', { class: 'sx-tool-ico', text: err ? '⚠' : '⚒' }),
        el('span', { class: 'sx-tool-name', text: String(t.name || '未知工具') }),
        el('span', { class: 'sx-tool-state' + (err ? ' err' : ' ok'), text: err ? '失败' : '成功' })),
      argsText ? el('div', { class: 'sx-tool-args', text: argsText }) : null,
      resultText ? el('div', { class: 'sx-tool-result' + (err ? ' err' : ''), text: resultText }) : null);

    return el('div', { class: 'sx-item' }, det);
  }

  /**
   * 图片注入卡（工具结果里的图像输入）。
   *
   * @param {object} info `{tool, count}`
   * @returns {Element} 卡片元素
   */
  function imageCard(info) {
    const i = info || {};
    return el('div', { class: 'sx-item' },
      el('details', { class: 'sx-tool' },
        el('summary', { class: 'sx-tool-sum' },
          el('span', { class: 'sx-tool-ico', text: '🖼' }),
          el('span', { class: 'sx-tool-name', text: String(i.tool || '图片') }),
          el('span', { class: 'sx-tool-state ok', text: (Number(i.count) || 0) + ' 张' })),
        el('div', { class: 'sx-tool-args', text: '已作为图像输入注入模型' })));
  }

  /**
   * 一张默认展开的信息卡（已发送 / 错误 / finish 共用一个形态）。
   *
   * @param {object} opts `{icon, label, badge, badgeKind, body, open}`
   * @returns {Element} 卡片元素
   */
  function plainCard(opts) {
    const o = opts || {};
    const det = el('details', { class: 'sx-tool sx-plain' + (o.kind ? ' ' + o.kind : '') },
      el('summary', { class: 'sx-tool-sum' },
        el('span', { class: 'sx-tool-ico', text: o.icon || '·' }),
        el('span', { class: 'sx-tool-name', text: String(o.label || '') }),
        o.badge ? el('span', { class: 'sx-tool-state ' + (o.badgeKind || 'ok'), text: String(o.badge) }) : null),
      el('div', { class: 'sx-tool-result' + (o.kind === 'err' ? ' err' : ''), text: String(o.body || '') }));
    det.open = o.open === true;
    return el('div', { class: 'sx-item' }, det);
  }

  /**
   * 过程流：把会话的 messages / sent / error / finishReason 铺成卡片序列。
   *
   * @param {object} s 会话详情
   * @returns {Element} 流容器
   */
  function buildFlow(s) {
    const flow = el('div', { class: 'sx-flow' });

    for (const item of s.messages || []) {
      if (item.toolCall) {
        flow.appendChild(toolCard(item.toolCall));
      } else if (item.toolImages) {
        flow.appendChild(imageCard(item.toolImages));
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        // 纯工具调用轮：卡片已展示，不再多一张空思考卡
        if (Array.isArray(item.tool_calls) && item.tool_calls.length && !text.trim()) continue;
        flow.appendChild(thinkCard(text));
      }
    }

    const sent = Array.isArray(s.sent) ? s.sent : [];
    if (sent.length) {
      const lines = sent.map((one) => {
        const at = one && one.at ? ' · ' + String(one.at) : '';
        return '已发送到 QQ' + at + '\n' + String((one && one.text) || '');
      }).join('\n\n');
      flow.appendChild(plainCard({
        icon: '💬', label: '已发送到 QQ', badge: sent.length + ' 条', badgeKind: 'ok', body: lines, open: true
      }));
    }

    if (s.error) {
      flow.appendChild(plainCard({
        icon: '⚠', label: '错误', badge: '异常', badgeKind: 'err', body: String(s.error), open: true, kind: 'err'
      }));
    }

    if (s.finishReason) {
      flow.appendChild(plainCard({
        icon: '🏁', label: 'finish', badge: '结束', badgeKind: 'ok', body: String(s.finishReason), open: true
      }));
    }

    return flow;
  }

  /**
   * JSON 模式：模型输入 / 输出的原始内容（原版口径，原模原样）。
   *
   * @param {object} s 会话详情
   * @returns {Element} JSON 面板
   */
  function buildJson(s) {
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role, content: m.content, tool_calls: m.tool_calls ?? null, raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({ toolCall: m.toolCall })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    let text = '';
    try { text = JSON.stringify(raw, null, 2); } catch { text = String(raw); }
    return el('pre', { class: 'sx-json', text });
  }

  /**
   * 详情头部（会话元信息 + 动作按钮）。
   *
   * @param {object} s 会话详情
   * @returns {Element} 头部元素
   */
  function buildHead(s) {
    const usage = s.usage || {};
    const deleteBtn = el('button', { class: 'btn small', text: '删除', title: '删除这条会话记录' });
    deleteBtn.addEventListener('click', () => removeSession(s));

    const jsonBtn = el('button', {
      class: 'btn small', text: state.jsonMode ? '普通模式' : 'JSON 模式', title: '查看模型输入/输出的原始内容'
    });
    jsonBtn.addEventListener('click', () => {
      state.jsonMode = !state.jsonMode;
      renderDetail();
    });

    const retryBtn = el('button', { class: 'btn small', text: '重试', title: '把触发批翻回未读并立即唤醒' });
    retryBtn.addEventListener('click', () => retrySession(s));

    return el('div', { class: 'sx-head' },
      el('div', { class: 'sx-head-title' },
        el('h3', { text: nameOf(s.chatKey) }),
        statusBadge(s.status),
        el('span', { class: 'spacer' }),
        jsonBtn,
        s.status === 'error' ? retryBtn : null,
        s.status === 'running' ? null : deleteBtn),
      el('div', { class: 'sx-head-metas' },
        el('span', { text: '触发：' + String(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-')) }),
        el('span', { text: '开始 ' + fmtTime(s.startedAt) + (s.endedAt ? ' · 结束 ' + fmtTime(s.endedAt) : ' · 进行中') }),
        el('span', { text: '模型 ' + String(s.model || '-') }),
        el('span', { text: (usage.calls || 0) + ' 次调用 · ' + fmtNum(Number(usage.promptTokens) || 0) + ' 入 / '
          + fmtNum(Number(usage.completionTokens) || 0) + ' 出' }),
        el('span', { text: (s.rounds || 0) + ' 轮工具' }),
        el('span', { text: '联网搜索 ' + (Number(s.webSearchCount) || 0) + ' 次' })));
  }

  /**
   * 右栏渲染（头部 + 系统提示 / 本次输入折叠 + 过程流）。
   *
   * @returns {void}
   */
  function renderDetail() {
    if (!refs) return;
    refs.headEl.textContent = '';
    refs.bodyEl.textContent = '';

    const s = state.detail;
    const id = state.currentId;
    if (!id) {
      empty(refs.bodyEl, '← 选择左侧的会话记录查看完整过程');
      return;
    }
    if (state.detailError) {
      fail(refs.bodyEl, UNREACHABLE + '：' + state.detailError);
      return;
    }
    if (!s) {
      empty(refs.bodyEl, '正在载入会话详情…');
      return;
    }

    refs.headEl.appendChild(buildHead(s));

    if (state.jsonMode) {
      refs.bodyEl.appendChild(buildJson(s));
    } else {
      if (s.systemPrompt) {
        refs.bodyEl.appendChild(el('details', { class: 'sx-source' },
          el('summary', { text: '系统提示（' + s.systemPrompt.length + ' 字符，每次运行重发）' }),
          el('div', { class: 'sx-source-body', text: String(s.systemPrompt) })));
      }
      if (s.userPrompt) {
        refs.bodyEl.appendChild(el('details', { class: 'sx-source' },
          el('summary', { text: '本次输入（' + s.userPrompt.length + ' 字符）' }),
          el('div', { class: 'sx-source-body', text: String(s.userPrompt) })));
      }
      refs.bodyEl.appendChild(buildFlow(s));
    }

    scheduleLive();
  }

  // ── 动作与取数 ──────────────────────────────────────────────────────────

  /**
   * 丢弃当前详情缓存（切会话时用，避免上一会话的内容闪一下）。
   *
   * @returns {void}
   */
  function resetDetail() {
    state.detail = null;
    state.detailError = '';
    state.jsonMode = false;
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  }

  /**
   * 运行中会话的详情轮询（单次登记，回调里再登记——不叠加）。
   *
   * @returns {void}
   */
  function scheduleLive() {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    const s = state.detail;
    if (!s || !LIVE[s.status]) return;
    liveTimer = setTimeout(async () => {
      liveTimer = null;
      const id = state.currentId;
      if (!id) return;
      await loadDetail(id, { quiet: true });
      await runRefreshList({ quiet: true });
    }, LIVE_MS);
  }

  /**
   * 选中一条会话：重置过程面并立刻取详情。
   *
   * @param {string} id 会话 id
   * @returns {Promise<void>} 取数链
   */
  async function selectSession(id) {
    if (!id) return;
    if (String(state.currentId || '') === String(id)) return;
    state.currentId = id;
    resetDetail();
    renderList();
    renderDetail();
    await loadDetail(id);
  }

  /**
   * 拉一条会话详情。
   *
   * @param {string} id 会话 id
   * @param {object} [opts] `{quiet}`——quiet 不显示「载入中」占位
   * @returns {Promise<void>} 完成
   */
  async function loadDetail(id, opts) {
    const quiet = !!(opts && opts.quiet);
    const api = ui().api;
    if (typeof api !== 'function') {
      state.detailError = '契约未就绪（window.__ui.api 缺失）';
      renderDetail();
      return;
    }
    if (detailInflight) return detailInflight;
    const token = ++detailSeq;
    if (!quiet) renderDetail();

    detailInflight = (async () => {
      const res = await api('/api/biz/sessions/' + encodeURIComponent(id));
      if (token !== detailSeq || String(state.currentId || '') !== String(id)) return;
      if (!res || res.ok === false) {
        state.detailError = textOf(res);
        state.detail = null;
      } else {
        state.detail = res;
        state.detailError = '';
      }
      renderDetail();
    })().then(() => {
      detailInflight = null;
    });
    return detailInflight;
  }

  /**
   * 删除一条会话记录（写类端点，用户点击才调用）。
   *
   * @param {object} s 会话详情
   * @returns {Promise<void>} 完成
   */
  async function removeSession(s) {
    const api = ui().api;
    if (typeof api !== 'function' || !s) return;
    const ok = window.confirm('确定删除这条会话记录？\n\n触发：' + String(s.triggerSummary || '-')
      + '\n时间：' + fmtTime(s.startedAt) + '\n\n删除后不可恢复（不影响用量统计的历史数据）。');
    if (!ok) return;
    const res = await api('/api/biz/sessions/' + encodeURIComponent(String(s.id)), { method: 'DELETE' });
    if (!res || res.ok === false) {
      state.detailError = textOf(res);
      renderDetail();
      return;
    }
    state.sessions = state.sessions.filter((x) => String(x.id) !== String(s.id));
    state.currentId = null;
    resetDetail();
    renderList();
    renderDetail();
    await refresh();
  }

  /**
   * 重试一条失败会话（把触发批翻回未读并立即唤醒）。
   *
   * @param {object} s 会话详情
   * @returns {Promise<void>} 完成
   */
  async function retrySession(s) {
    const api = ui().api;
    if (typeof api !== 'function' || !s) return;
    const res = await api('/api/biz/sessions/' + encodeURIComponent(String(s.id)) + '/retry', {
      method: 'POST', body: {}
    });
    if (!res || res.ok === false) {
      state.detailError = textOf(res);
      renderDetail();
      return;
    }
    state.detailError = '';
    await loadDetail(String(s.id));
    await refresh();
  }

  /**
   * 清空全部已结束的会话记录（运行中 / 等待中的保留）。
   *
   * @returns {Promise<void>} 完成
   */
  async function clearFinished() {
    const api = ui().api;
    if (typeof api !== 'function') return;
    const res = await api('/api/biz/sessions/clear-finished', { method: 'POST', body: {} });
    if (!res || res.ok === false) {
      state.error = textOf(res);
      renderList();
      return;
    }
    const stillThere = state.sessions.some((x) => String(x.id) === String(state.currentId) && !LIVE[x.status]);
    if (stillThere) {
      state.currentId = null;
      resetDetail();
      renderDetail();
    }
    await refresh();
  }

  /**
   * 拉列表（sessions + chats 并行）。
   *
   * @param {object} [opts] `{quiet}`
   * @returns {Promise<void>} 完成
   */
  async function runRefreshList(opts) {
    const quiet = !!(opts && opts.quiet);
    const api = ui().api;
    if (typeof api !== 'function') {
      state.error = '契约未就绪（window.__ui.api 缺失）';
      renderList();
      return;
    }
    const token = ++listSeq;
    const pair = await Promise.all([
      api('/api/biz/sessions').catch((error) => ({ ok: false, error: textOf(error) })),
      api('/api/biz/chats').catch(() => ({ ok: false }))
    ]);
    if (token !== listSeq) return;

    const main = pair[0] || {};
    const names = pair[1] || {};

    if (main.ok === false) {
      state.error = textOf(main);
      state.sessions = [];
      if (!quiet) { renderList(); renderDetail(); }
      return;
    }

    state.error = '';
    state.sessions = Array.isArray(main.sessions) ? main.sessions : [];
    state.names = {};
    if (names.ok !== false && Array.isArray(names.chats)) {
      for (const c of names.chats) {
        const key = String((c && (c.key || c.chatKey)) || '');
        if (key && c.chatName) state.names[key] = String(c.chatName);
      }
    }
    // 群一级数据（chatKey / total / lastTs）补进名字表，列表里没有会话的群不必显示
    state.updatedAt = Date.now();
    renderList();

    // 选中的会话若已被清走，右栏回落空态
    const exists = state.currentId && state.sessions.some((x) => String(x.id) === String(state.currentId));
    if (!exists && state.currentId) {
      state.currentId = null;
      resetDetail();
      renderDetail();
    }
  }

  /**
   * 刷新（单飞：并发调用复用同一 Promise）。
   *
   * @returns {Promise<void>} 完成
   */
  function refresh() {
    if (listInflight) return listInflight;
    listInflight = runRefreshList()
      .catch((error) => {
        state.error = textOf(error);
        renderList();
      })
      .then(() => { listInflight = null; });
    return listInflight;
  }

  // ── 骨架 ────────────────────────────────────────────────────────────────

  /**
   * 建页骨架（首次切到本页调用一次，**不发请求**）。
   *
   * @param {Element} container `#view-sessions`
   * @returns {void}
   */
  function mount(container) {
    if (!container) return;
    container.textContent = '';

    const countEl = el('span', { class: 'r5-count hint', text: '-' });
    const filterInput = el('input', { class: 'r5-filter', type: 'text', placeholder: '过滤：会话 / 群名 / 触发' });
    const reloadBtn = el('button', { class: 'btn small', text: '刷新' });
    const clearBtn = el('button', { class: 'btn small', text: '清空已结束' });
    const listEl = el('div', { class: 'sx-list' });
    const footEl = el('div', { class: 'r5-foot hint' });
    const headEl = el('div', { class: 'sx-heads' });
    const bodyEl = el('div', { class: 'sx-body' });

    filterInput.addEventListener('input', (event) => {
      state.filter = String(event.target.value || '');
      renderList();
    });
    reloadBtn.addEventListener('click', () => refresh());
    clearBtn.addEventListener('click', () => clearFinished());

    const rootEl = el('div', { class: 'sx-sessions' },
      el('aside', { class: 'sx-list-pane' },
        el('div', { class: 'groups-bar r5-list-bar' }, countEl, filterInput, reloadBtn, clearBtn),
        listEl,
        footEl),
      el('section', { class: 'sx-detail-pane' }, headEl, bodyEl));

    container.appendChild(rootEl);
    refs = { countEl, listEl, footEl, headEl, bodyEl, filterInput };

    renderList();
    empty(bodyEl, '← 选择左侧的会话记录查看完整过程');
  }

  const views = (window.__views = window.__views || {});
  const view = { title: '会话', mount, refresh };
  views.sessions = view;
  if (typeof ui().registerView === 'function') ui().registerView('sessions', view);
})();
