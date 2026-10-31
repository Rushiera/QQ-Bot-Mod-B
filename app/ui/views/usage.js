// app/ui/views/usage.js —— 用量页视图块（R5-L4）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L4**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch、无 import / export）
//
// 数据源：`/api/biz/usage/stats?range=N` 一次拿齐四张表（totals / days / chats / models）——
// 与原版 `_unpack/resources/app/ui/app/04-archive-usage.js:531 updateUsagePage` 同口径：
// 四张表全部来自 stats，不逐表请求。逐表请求会让四张表的求和口径分裂，而「合计 = 各行之和」
// 是这页的唯一价值。
//
// 交叉核对：另取一次 `/api/biz/usage/breakdown?range=N&by=chat`，**只数行数**，写在按群表脚注。
// 作用是暴露「stats 快照口径 vs 按天文件口径」的差异——行数一致才算两份视图对得上；
// 金额不并排展示（两个口径的 cost 本来就不完全相等，并排会让人误以为页面算错）。
//
// 不做 spark 柱图（R5 §1.2 · R1-L5 已判退役）。

(function () {
  'use strict';

  /** 时间范围三档：[传给后端的值, 按钮文案]。默认 7。 */
  var RANGES = [['1', '近 1 天'], ['7', '近 7 天'], ['30', '近 30 天']];

  /** 当前选中档位（对应业务面 `resolveRange` 的 days 分支，合法域 1..30）。 */
  var range = '7';

  /** 骨架引用；null = 骨架未建。 */
  var parts = null;

  /** 并发单飞：同一时刻只允许一次取数。 */
  var inflight = null;

  /** 只读外壳契约对象（每次现取，不缓存成员——外壳晚到也仍能取到）。 */
  function ui() { return window.__ui || {}; }

  /** 取 `el`；缺失即抛（mount 入口已拦一次，走到这里说明外壳被拆过）。 */
  function needEl() {
    var E = ui().el;
    if (typeof E !== 'function') throw new Error('window.__ui.el 缺失（R5-L1 外壳未就绪）');
    return E;
  }

  /**
   * 建元素并保证文本落到 textContent。
   *
   * 契约 §3.1 里 `el(tag, attrs, ...children)` 的 `text` 归外壳处理；这里再兜一层——
   * 外壳若只做了属性赋值（`node.text = ...`），页面会整片空白，而空白页比报错更难查。
   *
   * @param {string} tag 标签名
   * @param {object} [attrs] 属性表
   * @param {string} [text] 文本（落 textContent）
   * @returns {Element} 新元素
   */
  function mk(tag, attrs, text) {
    var node = needEl()(tag, attrs || {});
    if (text !== undefined && text !== null) {
      var s = String(text);
      if (node.textContent !== s) node.textContent = s;
    }
    return node;
  }

  /** 千分位；外壳缺 `fmtNum` 时回落原值。 */
  function fmtNum(n) {
    var f = ui().fmtNum;
    if (typeof f === 'function') return f(n);
    return (n === null || n === undefined) ? '-' : String(n);
  }

  /** 比率 → `71.2%`。 */
  function pct(v) { return ((Number(v) || 0) * 100).toFixed(1) + '%'; }

  /** 金额：小于 1 给四位小数（成本常是几分钱，两位会全显成 ¥0.00）。 */
  function yuan(v) {
    var n = Number(v) || 0;
    if (!n) return '¥0';
    return Math.abs(n) < 1 ? '¥' + n.toFixed(4) : '¥' + n.toFixed(2);
  }

  /** 建一个单元格；`raw` 给了就落 `data-raw`（原值可回读，不受展示格式影响）。 */
  function cell(tag, text, cls, raw) {
    var node = mk(tag, { class: cls || '' }, text);
    if (raw !== undefined && raw !== null && typeof node.setAttribute === 'function') {
      node.setAttribute('data-raw', String(raw));
    }
    return node;
  }

  /** 表头列定义——四张表各自的列（`right` = 数字右对齐）。 */
  var COLS_TOTALS = [
    { title: '项目' }, { title: '调用', right: true }, { title: '输入', right: true },
    { title: '输出', right: true }, { title: '缓存命中', right: true },
    { title: '命中率', right: true }, { title: '总 token', right: true }, { title: '成本', right: true }
  ];
  var COLS_CHATS = [
    { title: '群' }, { title: '调用', right: true }, { title: '输入', right: true },
    { title: '输出', right: true }, { title: '命中率', right: true }, { title: '成本', right: true }
  ];
  var COLS_DAYS = [
    { title: '日期' }, { title: '调用', right: true }, { title: '输入', right: true },
    { title: '输出', right: true }, { title: '缓存命中', right: true },
    { title: '命中率', right: true }, { title: '成本', right: true }
  ];
  var COLS_MODELS = [
    { title: '模型（渠道：模型 id）' }, { title: '调用', right: true }, { title: '输入', right: true },
    { title: '输出', right: true }, { title: '命中率', right: true }, { title: '成本', right: true }
  ];

  /** 本页样式——作用域限定在 `.usage-wrap` 内；不动 `style.css`（L1 独占）。 */
  var CSS = [
    '.usage-wrap { display: flex; flex-direction: column; gap: 14px; }',
    '.usage-head { display: flex; align-items: center; gap: 12px; }',
    '.usage-head h2 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }',
    '.usage-range { display: flex; gap: 6px; }',
    '.usage-range .btn.on { border-color: var(--accent); color: var(--text); }',
    '.usage-costline { padding: 10px 14px; background: var(--panel); border: 1px solid var(--line);',
    '  border-left: 3px solid var(--accent); border-radius: 8px; color: var(--muted); font-size: 13px; }',
    '.usage-costline b { color: var(--text); font-size: 15px; font-weight: 600; }',
    '.usage-check { padding: 8px 12px; background: var(--panel-2); border: 1px solid var(--line);',
    '  border-radius: 8px; }',
    '.usage-check .usage-note { margin: 0 0 2px; }',
    '.usage-data { display: flex; flex-direction: column; gap: 16px; }',
    '.usage-block h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }',
    '.usage-block table { width: 100%; border-collapse: collapse; font-size: 12.5px; }',
    '.usage-block th, .usage-block td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; }',
    '.usage-block th { color: var(--muted); font-weight: 500; font-size: 12px; }',
    '.usage-block tr:hover td { background: var(--panel-2); }',
    '.usage-block .r { text-align: right; font-variant-numeric: tabular-nums; }',
    '.usage-block td.usage-empty { color: var(--muted); }',
    '.usage-note { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.6; }',
    '.usage-note.warn { color: var(--warn); }',
    '.usage-foot { color: var(--muted); font-size: 11px; }'
  ].join('\n');

  /** 建一张表：表头 + 待填 tbody + 脚注位。 */
  function makeTable(title, cols) {
    var block = mk('div', { class: 'usage-block' });
    var table = mk('table');
    var thead = mk('thead');
    var htr = mk('tr');
    var i;
    for (i = 0; i < cols.length; i += 1) {
      htr.appendChild(cell('th', cols[i].title, cols[i].right ? 'r' : ''));
    }
    thead.appendChild(htr);
    var tbody = mk('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);
    var note = mk('div', { class: 'usage-note' });
    block.appendChild(mk('h3', {}, title));
    block.appendChild(table);
    block.appendChild(note);
    return { block: block, tbody: tbody, note: note, colCount: cols.length };
  }

  /** 清空 tbody；无数据写一行灰字（不是空表格，也不冒充有数据）。 */
  function fillRows(tbl, rows, buildRow, emptyText) {
    tbl.tbody.textContent = '';
    tbl.tbody.setAttribute('data-count', String(rows.length));
    if (!rows.length) {
      var tr = mk('tr');
      var td = cell('td', emptyText || '本区间无记录', 'usage-empty', 0);
      td.setAttribute('colspan', String(tbl.colCount));
      tr.appendChild(td);
      tbl.tbody.appendChild(tr);
      return;
    }
    var i;
    for (i = 0; i < rows.length; i += 1) tbl.tbody.appendChild(buildRow(rows[i]));
  }

  /** 群 / 会话 key → 可读名（`/api/biz/chats` 的 chatName 优先）。 */
  function nameOfChat(key, nameMap) {
    var k = String(key || '');
    var hit = nameMap.get(k);
    if (hit) return hit;
    if (k.indexOf('group:') === 0) return '群 ' + k.slice(6);
    if (k.indexOf('private:') === 0) return '私聊 ' + k.slice(8);
    return k || '-';
  }

  /** `/api/biz/chats` → Map(key → 群名)。拉不到就是空表，退化显示群号。 */
  function buildNameMap(resp) {
    var map = new Map();
    var list = (resp && Array.isArray(resp.chats)) ? resp.chats : [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var c = list[i];
      if (c && c.key) map.set(String(c.key), c.chatName || c.chatKey || String(c.key));
    }
    return map;
  }

  /** range 按钮组 + 刷新（高亮跟随当前档位）。 */
  function renderRangeBar() {
    parts.range.textContent = '';
    parts.rangeBtns = [];
    var i;
    for (i = 0; i < RANGES.length; i += 1) {
      (function (pair) {
        var btn = mk('button', {
          class: 'btn small' + (pair[0] === range ? ' on' : ''),
          onclick: function () { setRange(pair[0]); }
        }, pair[1]);
        btn.setAttribute('data-range', pair[0]);
        parts.range.appendChild(btn);
        parts.rangeBtns.push({ value: pair[0], node: btn });
      }(RANGES[i]));
    }
    parts.range.appendChild(mk('button', {
      class: 'btn small', onclick: function () { refresh(); }
    }, '刷新'));
  }

  /** 切换时间范围：按钮高亮重画 + 重新取数。 */
  function setRange(v) {
    if (v !== range) {
      range = String(v);
      renderRangeBar();
    }
    refresh();
  }

  /** 状态区（空态 / 失败态 / 载入中）——不碰数据块，成功时由 clearStatus 放开。 */
  function showStatus(kind, msg) {
    var U = ui();
    var node = parts.status;
    node.textContent = '';
    node.setAttribute('data-state', kind);
    parts.data.style.display = 'none';
    if (kind === 'fail' && typeof U.fail === 'function') { U.fail(node, msg); return; }
    if (kind === 'empty' && typeof U.empty === 'function') { U.empty(node, msg); return; }
    node.appendChild(mk('div', { class: 'usage-note' + (kind === 'fail' ? ' warn' : '') },
      (kind === 'fail' ? '不可用：' : '') + String(msg || '')));
  }

  /** 清状态区并放开数据块。 */
  function clearStatus() {
    parts.status.textContent = '';
    parts.status.setAttribute('data-state', 'ok');
    parts.data.style.display = '';
  }

  /** 建整页骨架（只建一次；不在此处发请求——契约 §3.2）。 */
  function buildShell(container) {
    var wrap = mk('div', { class: 'usage-wrap' });
    var head = mk('div', { class: 'usage-head' });
    head.appendChild(mk('h2', {}, '用量与成本'));
    var rangeBar = mk('div', { class: 'usage-range' });
    head.appendChild(rangeBar);

    var status = mk('div', { class: 'usage-status' });
    var data = mk('div', { class: 'usage-data' });
    var cost = mk('div', { class: 'usage-costline' });
    var check = mk('div', { class: 'usage-check' });
    var totals = makeTable('总量', COLS_TOTALS);
    var chats = makeTable('按群', COLS_CHATS);
    var days = makeTable('按天', COLS_DAYS);
    var models = makeTable('按模型', COLS_MODELS);
    var foot = mk('div', { class: 'usage-foot' },
      '本页只读：写类端点（config / compact / consolidate 等）本轮不调用；'
      + '数字口径以「合计 = 各行之和」为准，悬停/回读可取 data-raw 原值。');

    data.appendChild(cost);
    data.appendChild(check);
    data.appendChild(totals.block);
    data.appendChild(chats.block);
    data.appendChild(days.block);
    data.appendChild(models.block);
    data.appendChild(foot);

    wrap.appendChild(mk('style', {}, CSS));
    wrap.appendChild(head);
    wrap.appendChild(status);
    wrap.appendChild(data);
    container.appendChild(wrap);

    parts = {
      status: status, data: data, cost: cost, check: check, range: rangeBar, rangeBtns: [],
      totals: totals, chats: chats, days: days, models: models, foot: foot
    };
    renderRangeBar();
  }

  /** 交叉核对：把「总量」与三张分解表逐项求和比对，差异摆在页面上（不修正、不隐藏）。
   *
   *  实测（2026-10-31 · range=7）：cost 三表求和与总量完全一致；
   *  runs 一致；**token 类三表求和 > 总量**——差在后端聚合口径（chats/models 行按会话×模型展开，
   *  同一批调用在不同维度各记一份），不是页面算错。这行把差异写出来，避免读者按
   *  「合计 = 各行之和」去验算后以为页面有 bug。 */
  function renderCheck(stats) {
    var t = stats.totals || {};
    var sumOf = function (list, k) {
      var acc = 0;
      for (var i = 0; i < list.length; i += 1) acc += Number(list[i][k]) || 0;
      return acc;
    };
    var keys = [
      { k: 'runs', label: '调用次数', fmt: function (v) { return fmtNum(Math.round(v)); } },
      { k: 'totalTokens', label: '总 token', fmt: function (v) { return fmtNum(Math.round(v)); } },
      { k: 'cost', label: '成本', fmt: function (v) { return yuan(v); } }
    ];
    var tol = { runs: 0.5, totalTokens: 0.5, cost: 1e-6 };
    var groups = [
      { label: '按群', list: Array.isArray(stats.chats) ? stats.chats : [] },
      { label: '按天', list: Array.isArray(stats.days) ? stats.days : [] },
      { label: '按模型', list: Array.isArray(stats.models) ? stats.models : [] }
    ];
    parts.check.textContent = '';
    parts.check.appendChild(mk('div', { class: 'usage-note' }, '口径核对（合计 vs 各表求和，只展示不修正）：'));
    keys.forEach(function (key) {
      var total = Number(t[key.k]) || 0;
      var allSame = true;
      var segs = groups.map(function (g) {
        var s = sumOf(g.list, key.k);
        var same = Math.abs(s - total) <= tol[key.k];
        if (!same) allSame = false;
        return g.label + ' ' + (same ? '=' : '≠') + ' ' + key.fmt(s);
      });
      var line = key.label + ' 合计 ' + key.fmt(total) + ' · ' + segs.join(' · ');
      parts.check.appendChild(mk('div', { class: 'usage-note' + (allSame ? '' : ' warn') }, line));
    });
    parts.check.appendChild(mk('div', { class: 'usage-note' },
      '不一致项的成因在后端聚合口径（同一批调用在不同维度各记一份 token），本页原样呈现两端数字。'));
  }

  /** 「成本一行」——本页主指标（成本非 0 是判据，见 §四 L4 ③）。 */
  function renderCost(stats) {
    var t = stats.totals || {};
    parts.cost.textContent = '';
    parts.cost.appendChild(mk('span', {}, '估算成本（' + (stats.rangeLabel || ('range=' + range)) + '）：'));
    parts.cost.appendChild(mk('b', {}, yuan(t.cost)));
    parts.cost.appendChild(mk('span', {}, '　调用 ' + fmtNum(t.runs)
      + ' 次 · 输入 ' + fmtNum(t.promptTokens) + ' · 输出 ' + fmtNum(t.completionTokens)
      + ' · 命中率 ' + pct(t.cacheHitRate)));
    parts.cost.setAttribute('data-cost', String(Number(t.cost) || 0));
  }

  /** 「总量」表：一行合计（原值落 data-raw）。 */
  function renderTotals(stats) {
    var t = stats.totals || {};
    fillRows(parts.totals, [t], function (r) {
      var tr = mk('tr');
      tr.appendChild(cell('td', '合计（' + (stats.rangeLabel || ('range=' + range)) + '）'));
      tr.appendChild(cell('td', fmtNum(r.runs), 'r', r.runs));
      tr.appendChild(cell('td', fmtNum(r.promptTokens), 'r', r.promptTokens));
      tr.appendChild(cell('td', fmtNum(r.completionTokens), 'r', r.completionTokens));
      tr.appendChild(cell('td', fmtNum(r.cachedTokens), 'r', r.cachedTokens));
      tr.appendChild(cell('td', pct(r.cacheHitRate), 'r', r.cacheHitRate));
      tr.appendChild(cell('td', fmtNum(r.totalTokens), 'r', r.totalTokens));
      tr.appendChild(cell('td', yuan(r.cost), 'r', r.cost));
      return tr;
    });
    var peak = (Number(t.peakTokens) || 0) > 0 || (Number(t.offPeakTokens) || 0) > 0;
    parts.totals.note.textContent = '总 token ' + String(t.totalTokens === undefined ? '-' : t.totalTokens)
      + '（原值）· 搜索 ' + String(stats.searchCount || 0) + ' 次（不计入成本）'
      + (peak ? ' · 峰谷：高峰 ' + fmtNum(t.peakTokens) + ' / 空闲 ' + fmtNum(t.offPeakTokens) : '');
  }

  /** 「按群」表：行数 = stats.chats 项数（不截断——截断就毁掉「合计 = 各行之和」）。 */
  function renderChats(stats, nameMap, bdRows) {
    var list = Array.isArray(stats.chats) ? stats.chats : [];
    fillRows(parts.chats, list, function (c) {
      var tr = mk('tr');
      tr.setAttribute('data-key', String(c.key || ''));
      tr.appendChild(cell('td', nameOfChat(c.key, nameMap)));
      tr.appendChild(cell('td', fmtNum(c.runs), 'r', c.runs));
      tr.appendChild(cell('td', fmtNum(c.promptTokens), 'r', c.promptTokens));
      tr.appendChild(cell('td', fmtNum(c.completionTokens), 'r', c.completionTokens));
      tr.appendChild(cell('td', pct(c.cacheHitRate), 'r', c.cacheHitRate));
      tr.appendChild(cell('td', yuan(c.cost), 'r', c.cost));
      return tr;
    }, '本区间没有群产生用量');
    parts.chats.note.textContent = list.length + ' 行（stats.chats）· 交叉核对 breakdown(by=chat) '
      + (bdRows === null ? '取数失败' : bdRows + ' 行')
      + (bdRows === null ? '' : (bdRows === list.length ? ' · 一致' : ' · ⚠ 两口径行数不一致'));
  }

  /** 「按天」表：stats.days 原序（后端已按自然日分桶）。 */
  function renderDays(stats) {
    var list = Array.isArray(stats.days) ? stats.days : [];
    fillRows(parts.days, list, function (d) {
      var tr = mk('tr');
      tr.setAttribute('data-key', String(d.day || d.date || ''));
      tr.appendChild(cell('td', String(d.day || d.date || '-')));
      tr.appendChild(cell('td', fmtNum(d.runs), 'r', d.runs));
      tr.appendChild(cell('td', fmtNum(d.promptTokens), 'r', d.promptTokens));
      tr.appendChild(cell('td', fmtNum(d.completionTokens), 'r', d.completionTokens));
      tr.appendChild(cell('td', fmtNum(d.cachedTokens), 'r', d.cachedTokens));
      tr.appendChild(cell('td', pct(d.cacheHitRate), 'r', d.cacheHitRate));
      tr.appendChild(cell('td', yuan(d.cost), 'r', d.cost));
      return tr;
    }, '本区间没有按天记录');
    parts.days.note.textContent = list.length + ' 个自然日 · mode=' + String(stats.mode || '-');
  }

  /** 「按模型」表：同一个 id 走不同渠道算不同商品（vendor 与 model 分列显示）。 */
  function renderModels(stats) {
    var list = Array.isArray(stats.models) ? stats.models : [];
    fillRows(parts.models, list, function (m) {
      var tr = mk('tr');
      tr.setAttribute('data-key', String(m.key || m.model || ''));
      tr.appendChild(cell('td', m.vendor ? (m.vendor + '：' + m.model) : String(m.key || m.model || '-')));
      tr.appendChild(cell('td', fmtNum(m.runs), 'r', m.runs));
      tr.appendChild(cell('td', fmtNum(m.promptTokens), 'r', m.promptTokens));
      tr.appendChild(cell('td', fmtNum(m.completionTokens), 'r', m.completionTokens));
      tr.appendChild(cell('td', pct(m.cacheHitRate), 'r', m.cacheHitRate));
      tr.appendChild(cell('td', yuan(m.cost), 'r', m.cost));
      return tr;
    }, '本区间没有模型调用');
    parts.models.note.textContent = list.length + ' 个渠道×模型组合';
  }

  /** 单次请求：失败不抛，统一成 `{ok:false, error}`（契约 §3.1 `api` 的语义）。 */
  function ask(path) {
    var api = ui().api;
    if (typeof api !== 'function') return Promise.resolve({ ok: false, error: 'window.__ui.api 缺失' });
    return Promise.resolve(api(path)).then(function (x) {
      return x || { ok: false, error: '空响应' };
    }, function (e) {
      return { ok: false, error: String((e && e.message) || e || '请求失败') };
    });
  }

  /** 一次取数 → 成本行 + 四张表全量重绘。失败 / 空各有出口，不渲染假数据。 */
  function load() {
    var r = encodeURIComponent(range);
    return Promise.all([
      ask('/api/biz/usage/stats?range=' + r),
      ask('/api/biz/chats'),
      ask('/api/biz/usage/breakdown?range=' + r + '&by=chat')
    ]).then(function (res) {
      var stats = res[0] || {};
      if (!stats.ok) {
        // 错误文本原样透传：代理层已把原因写成「业务面不可达（127.0.0.1:3210）」，
        // 这里再拼一层前缀会变成同一句话重复两遍。
        showStatus('fail', String(stats.error || '业务面不可达（127.0.0.1:3210）'));
        return;
      }
      var nameMap = buildNameMap(res[1]);
      var bd = res[2] || {};
      var bdRows = (bd.ok && Array.isArray(bd.rows)) ? bd.rows.length : null;

      var t = stats.totals || {};
      var hasData = (Number(t.runs) || 0) > 0
        || (Array.isArray(stats.days) && stats.days.length > 0)
        || (Array.isArray(stats.chats) && stats.chats.length > 0);
      if (!hasData) { showStatus('empty', '本区间没有用量记录（range=' + range + '）'); return; }

      clearStatus();
      renderCost(stats);
      renderCheck(stats);
      renderTotals(stats);
      renderChats(stats, nameMap, bdRows);
      renderDays(stats);
      renderModels(stats);
    });
  }

  /** 拉数据重渲染（并发单飞）。 */
  function refresh() {
    if (!parts) return Promise.resolve();
    if (inflight) return inflight;
    showStatus('empty', '载入中…');
    inflight = load().catch(function (e) {
      showStatus('fail', '渲染失败：' + String((e && e.message) || e));
    }).then(function () {
      inflight = null;
    });
    return inflight;
  }

  /**
   * 建视图骨架（首次切到本页调用一次）。不发请求。
   *
   * @param {Element} el 容器（`#view-usage`）
   * @returns {void}
   */
  function mount(el) {
    if (!el) return;
    el.textContent = '';
    if (typeof ui().el !== 'function') {
      var p = document.createElement('p');
      p.textContent = '此页未安装（window.__ui 缺失——R5-L1 外壳未就绪）';
      el.appendChild(p);
      return;
    }
    buildShell(el);
  }

  var views = (window.__views = window.__views || {});
  views.usage = { title: '用量', mount: mount, refresh: refresh };
})();
