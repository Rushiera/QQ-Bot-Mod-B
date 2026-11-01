// app/ui/views/memory.js —— 记忆页视图块（R5-L5）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L5**；R7 任务卡 §二 —— 写操作面（L2）· 切换视图与要点区（L3）
// 契约：`app/ui/views/_index.md` §三（运行时只读 `window.__ui`；块内不发裸请求，一律走 `api()`）
// 状态：✅ R5-L5 交付基础版 · R7-L2 补写操作面（六入口）· R8-L2 补「现行 / 归档」切换 + 会话要点区
//
// 面：左栏 = 记忆文件列表（`/api/biz/memory-files` 全量，条数 = `files.length`，不截断）；
//     右栏 = 选中会话的记忆详情：**会话要点（顶部只读）** + 群记（按 `kind` 分组，**现行 / 归档**切换）+
//            群友印象（含回应参数）+「重整」按钮 + 两个按群开关面（💰 余额后缀 / 🔊 语音伴随）。
// 形态：与会话页同构（原版 QQ Agent 两栏）——骨架 `sx-sessions` / `sx-list-pane` / `sx-detail-pane` /
//       `sx-list` / `sx-row*` / `sx-head*` / `sx-body` 复用，右栏内层卡片用 `sxm-card` / `sxm-head` / `sxm-body`。
// 取数：`/api/biz/memory-files` · `/api/biz/memory-files/<group_xxx>` · `/api/biz/memory-files/<group_xxx>/summary`（R8-L2 新增端点）
//       `/api/biz/chats`（群名）· `/api/biz/config`（开关现值；写后**再读一次**核对，不做本地乐观更新）
// 写面：`POST /api/biz/memory-files/consolidate` · `POST /api/biz/config` · `POST /api/biz/balance/sync`
//       R7-L2 写操作面（六入口）：`POST|PUT|DELETE /api/biz/memory-files/<seg>/group[/<id>]`（加 / 改 / 删群记）
//       `PUT|DELETE /api/biz/memory-files/<seg>/members/<uid>`（存 / 删群友印象）· `DELETE /api/biz/memory-files/<seg>`（删本会话记忆）
//       `POST /api/biz/config`（🤖 bot 指定 / 🎚 发言档位——写 `engage.*`）
// 🔴 代理层方法白名单 = GET / POST / PUT / DELETE（`app/src/web/business-proxy.js:17`）→ PUT 经单体可达；
//    群记「改」另有「删旧 + 加新」等价回落（`rewriteGroupEntry`，PUT 被拒时自动走）；成员「存」走 PUT，无回落通道。
// 口径：`design-qqbotb-memory.md` §3.1（两轴三分 / `kind` 枚举）/ §3.5（记忆页：群记 + 群友印象）
// 空态 / 失败态：走 `empty()` / `fail()`，失败文案带 3210。
// 降级：`window.__ui` 缺成员时用本块本地实现兜底——页面不白屏、不抛错。

(function () {
  'use strict';

  /** 失败态统一文案前缀（契约要求含 3210）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /** 群记分类（`design-qqbotb-memory.md` §3.1 `kind` 枚举）。 */
  const KIND_LABEL = {
    lore: '梗/黑话',
    rule: '群规约定',
    relation: '关系角色',
    project: '长期项目',
    topic: '在聊什么'
  };

  /** 群记分组显示顺序：稳定 → 易变（与提示词注入顺序一致）。 */
  const KIND_ORDER = ['lore', 'rule', 'relation', 'project', 'topic'];

  /**
   * 发言档位五档档名（与 `app/src/business/config.js` 的 `engage.levels` 默认表同序）。
   * UI 只作显示与选择，判定在业务面 `engage-level.js`。
   */
  const LEVEL_NAMES = ['冰封', '保守', '标准', '活跃', '全开'];

  /** 群记内容长度上限（业务面 `group-memory.js` 的 `MAX_CONTENT` 同口径）。 */
  const GROUP_CONTENT_MAX = 200;

  /** 单个群友印象条数上限（业务面 `memory.js editMemberImpression` 的 `.slice(0, 20)` 同口径）。 */
  const IMPRESSION_MAX = 20;

  /** DOM 容器引用（mount 建一次，refresh 只清内容）。 */
  let refs = null;

  /** 单飞句柄。 */
  let inflight = null;

  /** 详情请求序号：迟到响应按序号丢弃。 */
  let detailSeq = 0;

  /** 界面态（业务真相每次从接口读，不在这里缓存结论）。 */
  const state = {
    files: [],
    names: {},
    running: [],
    cfg: null,
    currentKey: null,
    detail: null,
    detailError: '',
    error: '',
    note: '',
    editor: null,
    loadingDetail: false,
    updatedAt: 0,
    // ── R8-L2 新增 ────────────────────────────────────────────────────────
    /** 会话要点（`GET /api/biz/memory-files/<seg>/summary` 的 `summary` 字段；null = 本会话还没产出）。 */
    summary: null,
    /** 会话要点取数失败原因（与「还没产出」区分开）。 */
    summaryError: '',
    /** 群记区视图：`current`（现行池）/ `archived`（归档只读）。 */
    view: 'current',
    // ── 群成员表（按需拉取，原版「拉取群成员列表」同义）──────────────
    /** 群成员缓存（`GET /api/biz/groups/<id>/members`）；缺省空 = 未拉取。 */
    groupMembers: [],
    /** 群成员拉取失败原因（与「未拉取」区分）。 */
    groupMembersError: '',
    /** 群成员表是否已展开（false 时只显示按钮）。 */
    groupMembersOpen: false,
    /** 备注行内编辑器（`{qq, value, error}`；null = 未编辑）——不用 `window.prompt`（会阻塞渲染线程）。 */
    noteEditor: null
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
   * @param {object} [attrs] 属性（`class` / `text` / `html` / `onclick` 等按名赋）
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
   * 转纯文本（本块全走 `el()` 的 `text` 赋值 = textContent，不做 HTML 转义——
   * 转义会显示成字面量实体文本）。
   *
   * @param {any} s 原值
   * @returns {string} 文本
   */
  function plain(s) {
    return String(s == null ? '' : s);
  }

  /**
   * `chatKey` → 端点路径段（`group:123` → `group_123`）。
   *
   * @param {string} key 会话键
   * @returns {string} 路径段
   */
  function pathKeyOf(key) {
    return String(key || '').replace(':', '_');
  }

  /**
   * `chatKey` → 群号 / QQ 号（`group:123` → `123`）。
   *
   * @param {string} key 会话键
   * @returns {string} 数字 id（非法时为空串）
   */
  function idOf(key) {
    const m = /^(?:group|private):(\d{1,15})$/.exec(String(key || ''));
    return m ? m[1] : '';
  }

  /**
   * 是否群会话（只有群能开余额后缀 / 语音伴随）。
   *
   * @param {string} key 会话键
   * @returns {boolean} 是否群
   */
  function isGroup(key) {
    return String(key || '').indexOf('group:') === 0;
  }

  /**
   * 会话显示名（群名 → 键）。
   *
   * @param {string} key 会话键
   * @returns {string} 显示名
   */
  function nameOf(key) {
    const name = state.names[String(key || '')];
    return String(name || '').trim() || String(key || '-');
  }

  /**
   * 从 `GET /api/biz/config` 的返回值里取出配置本体。
   *
   * 业务面该端点成功时直接返回配置对象（无 `ok` 字段）；代理层 / 壳若把响应包成
   * `{ok:true, data:{...}}` 则取里层。取不到（失败 / 空）一律返 null——
   * 「没配」与「全默认」在界面上必须能区分（缺省值渲染会让用户以为开关都是关的）。
   *
   * @param {any} res 端点原始返回
   * @returns {object|null} 配置本体
   */
  function pickConfig(res) {
    if (!res || res.ok === false) return null;
    if (res.error) return null;
    const keys = Object.keys(res).filter((k) => k !== 'ok' && k !== 'status');
    if (!keys.length) return null;
    if (keys.length === 1 && keys[0] === 'data' && res.data && typeof res.data === 'object') return res.data;
    return res;
  }

  /**
   * 取某群的余额后缀状态（原版 `balanceRuleOf` 同口径）。
   *
   * @param {object} cfg 业务面配置
   * @param {string} id 群号
   * @returns {object|null} `{on, amount, marker, minutes}`；群号非法返 null
   */
  function balanceStateOf(cfg, id) {
    if (!/^\d{1,15}$/.test(String(id || ''))) return null;
    const bal = (cfg && cfg.engage && cfg.engage.balance) || {};
    const chats = (Array.isArray(bal.chats) ? bal.chats : []).map(String);
    const n = Number(bal.value);
    const ms = Number(bal.intervalMs);
    return {
      on: chats.indexOf(String(id)) >= 0,
      amount: Number.isFinite(n) && n >= 0 ? n.toFixed(2) : '0.00',
      marker: String(bal.marker || '@余额'),
      minutes: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 30
    };
  }

  /**
   * 取某群的语音伴随状态（原版 `voiceRuleOf` 同口径）。
   *
   * @param {object} cfg 业务面配置
   * @param {string} id 群号
   * @returns {object|null} `{on, enabled, chats, runMode, maxChars}`；群号非法返 null
   */
  function voiceStateOf(cfg, id) {
    if (!/^\d{1,15}$/.test(String(id || ''))) return null;
    const v = (cfg && cfg.engage && cfg.engage.voiceReply) || {};
    const chats = (Array.isArray(v.chats) ? v.chats : []).map(String);
    const max = Number(v.maxChars);
    return {
      on: v.enabled !== false && chats.indexOf(String(id)) >= 0,
      enabled: v.enabled !== false,
      chats,
      runMode: String(v.runMode || 'small'),
      maxChars: Number.isFinite(max) && max > 0 ? max : 60
    };
  }

  /**
   * 某会话的整理状态：优先取后端 `consolidating`（唯一可信源）。
   *
   * @param {object} file 文件条目
   * @returns {boolean} 是否整理中
   */
  function isBusy(file) {
    const key = String((file && file.chatKey) || '');
    if (!key) return false;
    if (file && file.consolidating) return true;
    return state.running.indexOf(key) >= 0;
  }

  /**
   * 记忆文件条目 → 左栏行。
   *
   * @param {object} file 文件条目
   * @returns {Element} 行元素
   */
  function fileRow(file) {
    const key = String(file.chatKey || '');
    const id = idOf(key);
    const busy = isBusy(file);
    const groupCount = Number(file.groupCount) || 0;
    const archived = (Number(file.groupArchived) || 0) + (Number(file.memberArchived) || 0);

    // ── 行内三个状态徽标（原版 05-memory-settings.js:75-96 同口径：档位 / 余额 / 语音）──
    // 只在配置取到时算——`state.cfg` 为 null 表示「没配」，不能用缺省值把开关渲染成「已关」。
    const cfg = state.cfg;
    const lv = cfg ? engageLevelOf(cfg, id) : null;
    const bal = cfg ? balanceStateOf(cfg, id) : null;
    const vc = cfg ? voiceStateOf(cfg, id) : null;

    const levelBadge = lv
      ? el('span', {
        class: 'sx-badge sx-level' + (lv.level === 1 ? ' quiet' : (lv.level >= 4 ? ' loud' : '')),
        title: '发言档位 ' + lv.level + '/5：' + lv.name,
        text: (lv.level === 1 ? '🤫 ' : '') + lv.name
      })
      : null;
    const balanceBadge = bal && bal.on
      ? el('span', {
        class: 'sx-badge sx-balance',
        title: '群名片后缀已开：每 ' + bal.minutes + ' 分钟刷「' + bal.marker + bal.amount + '」到本号群名片',
        text: '💰 ' + bal.amount
      })
      : null;
    const voiceBadge = vc && vc.on
      ? el('span', {
        class: 'sx-badge sx-voice',
        title: '语音伴随已开：本号每次发言都会再念一遍日语发回本群（依田芳乃 · v4.1-Small）',
        text: '🔊 语音'
      })
      : null;

    // 删除本会话记忆（原版在行内；只有真有记忆才出现）——stopPropagation 不触发选中
    const hasMemory = (Number(file.memberCount) || 0) || (Number(file.impressionCount) || 0) || groupCount;
    const delBtn = hasMemory
      ? el('button', { class: 'btn small sx-row-del', title: '删除本会话的全部记忆（所有群友的印象）', text: '删除' })
      : null;
    if (delBtn) delBtn.onclick = (ev) => { ev.stopPropagation(); deleteChatMemory(key); };

    // 行形态与会话页 `.sx-row` 同构：标题行（名称 + 三徽标）+ 元信息行 + 时间行
    // 时间放第二行——长群名（如「偶像大师灰姑娘女孩mod交流分享群」）在标题行会被挤断行。
    const meta = el('div', { class: 'sx-row-metas' },
      el('span', { text: (Number(file.memberCount) || 0) + ' 位群友' }),
      el('span', { text: (Number(file.impressionCount) || 0) + ' 条印象' }),
      el('span', { text: '群记 ' + groupCount + ' 条' }),
      archived ? el('span', { text: '归档 ' + archived + ' 条' }) : null,
      el('span', { class: 'sx-row-time', text: '更新于 ' + fmtTime(file.updatedAt) }));

    const row = el('div', {
      class: 'sx-row' + (key === state.currentKey ? ' on' : ''),
      title: key
    },
    el('div', { class: 'sx-row-title' },
      busy
        ? el('span', { class: 'sx-badge sx-waiting', text: '整理中' })
        : el('span', { class: 'sx-row-id', text: nameOf(key) }),
      levelBadge,
      balanceBadge,
      voiceBadge,
      delBtn),
    meta);
    row.onclick = () => select(key);
    return row;
  }

  /**
   * 左栏渲染（全量，不截断）。
   *
   * @returns {void}
   */
  function renderList() {
    if (!refs) return;
    const box = refs.listEl;
    box.textContent = '';
    refs.countEl.textContent = state.error ? '不可用' : state.files.length + ' 个会话';

    if (state.error) {
      fail(box, UNREACHABLE + '：' + state.error);
      refs.footEl.textContent = '';
      return;
    }
    if (!state.files.length) {
      empty(box, '还没有任何记忆（等机器人使用记忆工具后才会出现）');
      refs.footEl.textContent = '';
      return;
    }
    for (const file of state.files) box.appendChild(fileRow(file));
    refs.footEl.textContent = '接口返回 ' + state.files.length + ' 项'
      + (state.updatedAt ? ' · ' + fmtTime(state.updatedAt) + ' 更新' : '')
      + (state.note ? ' · ' + state.note : '');
  }

  /**
   * 群记条目 → 行（行内带「改 / 删」两个写操作）。
   *
   * @param {object} entry 群记条目（`{id, kind, content, createdAt, updatedAt}`）
   * @returns {Element} 行元素
   */
  function groupRow(entry) {
    // kind 标签由 groupSection 的分组标题统一给出——行内不再重复渲染（否则每组第一行上方双份标签）
    const id = String((entry && entry.id) || '');
    const editBtn = el('button', { class: 'btn small', text: '改' });
    editBtn.onclick = () => openEditor({
      mode: 'group',
      entryId: id,
      kind: String((entry && entry.kind) || ''),
      content: String((entry && entry.content) || ''),
      error: ''
    });
    const delBtn = el('button', { class: 'btn small', text: '删' });
    delBtn.onclick = () => deleteGroupEntry(id);
    return el('div', { class: 'field' },
      el('div', { class: 'control' },
        el('span', { text: plain(entry && entry.content) }),
        el('span', { class: 'note', text: (entry && entry.updatedAt) ? fmtTime(entry.updatedAt) : '' }),
        id ? editBtn : null,
        id ? delBtn : null));
  }

  /**
   * 归档条目 → 行（只读：归档池是 JSONL 追加文件，`group-memory.js:153` 只给读面，无写路由）。
   *
   * @param {object} entry 归档条目（`{id, kind, content, createdAt, updatedAt, archivedAt, reason}`）
   * @returns {Element} 行元素
   */
  function archivedGroupRow(entry) {
    const when = Number((entry && entry.archivedAt) || 0) || Number((entry && entry.updatedAt) || 0);
    return el('div', { class: 'field' },
      el('div', { class: 'control' },
        el('span', { text: plain(entry && entry.content) }),
        el('span', { class: 'note', text: when ? '归档于 ' + fmtTime(when) : '' })));
  }

  /**
   * 「现行 / 归档」切换控件（分段控件：两个 `btn small`，选中态用 `primary`）。
   *
   * 归档数据源 = 详情端点的 `groupArchived`（`routes.js:1335` 只给 500 条上限）；
   * 计数取 `archiveStats.group`（不受 limit 影响），故两者可能不等 —— 显示时以条数为准并注明。
   *
   * @param {number} curCount 现行条数
   * @param {number} archCount 归档计数
   * @returns {Element[]} 两个按钮
   */
  function viewTabs(curCount, archCount) {
    const mk = (mode, text, count) => {
      const on = state.view === mode;
      const btn = el('button', { class: 'btn small' + (on ? ' primary' : ''), text: text + ' ' + count });
      btn.title = mode === 'current' ? '看现行群记（可增删改）' : '看已归档群记（只读；归档池按天追加）';
      btn.onclick = () => {
        if (state.view === mode) return;
        state.view = mode;
        state.editor = null;
        state.note = '';
        renderDetail();
      };
      return btn;
    };
    return [mk('current', '现行', curCount), mk('archived', '归档', archCount)];
  }

  /**
   * 群记区（按 `kind` 分组，顺序 `KIND_ORDER`；未知 kind 归到末尾）。
   *
   * 两态共用一个区块：`state.view = 'current'` 走现行池（可增删改），
   * `'archived'` 走归档池（只读，无编辑按钮、无「＋ 添加」）。
   *
   * @param {object[]} entries 现行群记条目列表（详情端点的 `group`）
   * @param {object} detail 详情（取归档条目 `groupArchived` 与计数 `archiveStats`）
   * @returns {Element} 区块元素
   */
  function groupSection(entries, detail) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const archivedList = Array.isArray(detail && detail.groupArchived) ? detail.groupArchived : [];
    const archivedCount = Number((detail && detail.archiveStats && detail.archiveStats.group) || archivedList.length || 0);
    const showingArchived = state.view === 'archived';
    const shown = showingArchived ? archivedList : list;

    const addBtn = el('button', { class: 'btn small', text: '＋ 添加群记' });
    addBtn.onclick = () => openEditor({ mode: 'group-new', entryId: '', kind: KIND_ORDER[0], content: '', error: '' });
    const tabs = viewTabs(list.length, archivedCount);
    const head = el('div', { class: 'sxm-head' },
      el('span', { class: 'title', text: '群记' }),
      tabs[0],
      tabs[1],
      el('span', { class: 'spacer' }),
      showingArchived ? null : addBtn);

    const body = el('div', { class: 'sxm-body' });
    if (showingArchived) {
      body.appendChild(el('p', { class: 'hint', text: '归档池只读（按天追加的 JSONL）——要改请从现行池操作；归档 = 现行池之外的历史条目。' }));
      if (!shown.length) {
        empty(body, '本会话还没有归档群记');
        return el('div', { class: 'sxm-card' }, head, body);
      }
    } else if (state.editor && state.editor.mode === 'group-new') {
      body.appendChild(groupEditor(state.editor));
    }
    if (!shown.length && !showingArchived) {
      empty(body, '还没有群记（梗 / 群规 / 关系 / 项目 / 在聊什么）——点「重整」让模型从聊天记录里提炼');
      return el('div', { class: 'sxm-card' }, head, body);
    }
    if (!shown.length) return el('div', { class: 'sxm-card' }, head, body);

    const groups = new Map();
    for (const entry of shown) {
      const kind = String((entry && entry.kind) || '');
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(entry);
    }
    const keys = KIND_ORDER.filter((k) => groups.has(k))
      .concat([...groups.keys()].filter((k) => KIND_ORDER.indexOf(k) < 0));
    for (const kind of keys) {
      const rows = groups.get(kind) || [];
      body.appendChild(el('div', { class: 'hint', text: (KIND_LABEL[kind] || kind || '未分类') + '（' + rows.length + '）' }));
      for (const entry of rows) {
        if (showingArchived) { body.appendChild(archivedGroupRow(entry)); continue; }
        const editing = state.editor && state.editor.mode === 'group' && String(state.editor.entryId) === String(entry && entry.id);
        body.appendChild(editing ? groupEditor(state.editor) : groupRow(entry));
      }
    }
    return el('div', { class: 'sxm-card' }, head, body);
  }

  /**
   * 会话要点区（顶部只读；`design-qqbotb-memory.md` §3.5「顶部只读显示会话要点」）。
   *
   * 三态必须可区分：有要点（正文）/ 还没产出（空态文案）/ 端点取不到（失败态，带原因）。
   *
   * @returns {Element} 区块元素
   */
  function summarySection() {
    const box = el('div', { class: 'sxm-body' });
    const sum = state.summary;
    if (state.summaryError) {
      fail(box, UNREACHABLE + '：' + state.summaryError);
    } else if (!sum || !String(sum.summary || '').trim()) {
      empty(box, '本会话还没有会话要点（收工轮产出后出现在这里）');
    } else {
      for (const line of String(sum.summary).split(/\r?\n/)) {
        const t = line.trim();
        if (t) box.appendChild(el('p', { text: t }));
      }
      box.appendChild(el('p', { class: 'hint', text: '产出 ' + fmtTime(sum.createdAt)
        + ' · 轮转 ' + (Number(sum.rollovers) || 0) + ' 次 · ' + (Number(sum.messages) || 0) + ' 条消息' }));
    }
    return el('div', { class: 'sxm-card' },
      el('div', { class: 'sxm-head' },
        el('span', { class: 'title', text: '会话要点' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', text: '只读' })),
      box);
  }

  /**
   * 群记内联编辑器（添加 / 编辑共用；分类下拉 + 内容输入 + 保存 / 取消）。
   *
   * @param {object} box 编辑器描述 `{mode, entryId, kind, content, error}`
   * @returns {Element} 编辑块
   */
  function groupEditor(box) {
    const isNew = box.mode === 'group-new';
    const sel = el('select', {});
    for (const k of KIND_ORDER) {
      const opt = el('option', { value: k, text: KIND_LABEL[k] + '（' + k + '）' });
      if (String(box.kind || '') === k) opt.selected = true;
      sel.appendChild(opt);
    }
    const input = el('input', { type: 'text', placeholder: '内容（≤' + GROUP_CONTENT_MAX + ' 字）', maxlength: String(GROUP_CONTENT_MAX) });
    input.value = String(box.content || '');
    const errEl = el('span', { class: 'view-fail', text: String(box.error || '') });
    const countEl = el('span', { class: 'note', text: String(input.value.length) + '/' + GROUP_CONTENT_MAX });
    input.oninput = () => { countEl.textContent = String(input.value.length) + '/' + GROUP_CONTENT_MAX; };

    const saveBtn = el('button', { class: 'btn small', text: '保存' });
    saveBtn.onclick = async () => {
      const content = String(input.value || '').trim();
      // 失败时编辑器要留住用户已敲的字——先把当前输入写回描述对象（renderDetail 会据此重建）
      box.kind = String(sel.value || '');
      box.content = content;
      box.error = '';
      if (!content) { box.error = '内容不能为空'; state.editor = box; renderDetail(); return; }
      saveBtn.disabled = true;
      const ok = isNew
        ? await addGroupEntry(String(sel.value || ''), content)
        : await updateGroupEntry(String(box.entryId || ''), content);
      if (!ok) { box.error = state.note || '保存失败'; state.editor = box; }
      renderDetail();
    };
    const cancelBtn = el('button', { class: 'btn small', text: '取消' });
    cancelBtn.onclick = () => closeEditor();

    return el('div', { class: 'field memory-editor' },
      el('div', { class: 'control' },
        el('span', { class: 'note', text: isNew ? '新增群记' : '编辑群记' }),
        sel,
        input,
        countEl,
        saveBtn,
        cancelBtn,
        errEl));
  }

  /**
   * 单个群友的印象块（`<details>` 才能开合）。
   *
   * @param {object} member 成员（`{userId, name, impressions:[{content,createdAt}]}`）
   * @param {object} rapport 回应参数条目（`{score, lastReason}` 或 undefined）
   * @returns {Element} 块元素
   */
  function memberBlock(member, rapport) {
    const imps = Array.isArray(member && member.impressions) ? member.impressions : [];
    const who = String((member && member.name) || (member && member.userId) || '某人');
    const qq = String((member && member.userId) || '');
    const score = rapport && Number.isFinite(Number(rapport.score)) ? Number(rapport.score) : null;
    const isBot = botMembersOf(state.cfg).indexOf(qq) >= 0;

    // 三个写操作：🤖 bot 指定（写 engage.botGuard.members）· 编辑（PUT 成员）· 删除（DELETE 成员）
    const botBtn = el('button', { class: 'btn small' + (isBot ? ' primary' : ''), text: isBot ? '🤖 bot ✓' : '🤖 bot' });
    botBtn.title = '指定为机器人：对 TA 的回复限制为 240 秒 1 条（点一下切换）';
    botBtn.onclick = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); ev.stopPropagation(); }
      toggleBotMember(qq);
    };
    // 「更新记忆」：让模型重分析这个人（有印象则整理合并，没印象则从聊天记录提炼）
    // 走 `POST /api/biz/memory-files/consolidate` 的 `userIds` 单人口径（routes.js:1452-1457）
    const refreshBtn = el('button', { class: 'btn small', text: '更新记忆' });
    refreshBtn.title = '让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼';
    refreshBtn.onclick = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); ev.stopPropagation(); }
      refreshMemberMemory(qq, who, refreshBtn);
    };
    const editBtn = el('button', { class: 'btn small', text: '编辑' });
    editBtn.onclick = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); ev.stopPropagation(); }
      openEditor({
        mode: 'member',
        userId: qq,
        name: who,
        impressions: imps.map((i) => String((i && i.content) || '')).join('\n'),
        error: ''
      });
    };
    const delBtn = el('button', { class: 'btn small', text: '删除' });
    delBtn.title = '删除这个人的全部印象';
    delBtn.onclick = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); ev.stopPropagation(); }
      deleteMember(qq, who);
    };

    const summary = el('summary', {},
      el('span', { text: who + (qq ? '（QQ ' + qq + '）' : '') + ' · ' + imps.length + ' 条' }),
      score === null
        ? el('span', { class: 'hint', text: ' 回应 100' })
        : el('span', { class: score < 80 ? 'view-fail' : 'hint', text: ' 回应 ' + score + (rapport.lastReason ? ' · ' + rapport.lastReason : '') }),
      el('span', { class: 'spacer' }),
      botBtn,
      refreshBtn,
      editBtn,
      delBtn);

    const body = el('div', { class: 'fold-body' },
      el('div', { class: 'kv' },
        el('span', { class: 'k', text: '更新于' }),
        el('span', { class: 'v', text: fmtTime(member && member.updatedAt) }),
        el('span', { class: 'k', text: '整理于' }),
        el('span', { class: 'v', text: fmtTime(member && member.lastConsolidatedAt) })));

    if (state.editor && state.editor.mode === 'member' && String(state.editor.userId) === qq) {
      body.appendChild(memberEditor(state.editor));
    }
    if (!imps.length) {
      body.appendChild(el('p', { class: 'view-empty', text: '这位群友还没有印象' }));
    } else {
      for (const imp of imps) {
        body.appendChild(el('div', { class: 'field' },
          el('div', { class: 'control' },
            el('span', { text: plain(imp && imp.content) }),
            el('span', { class: 'note', text: fmtTime(imp && imp.createdAt) }))));
      }
    }
    // 两件事都要：`class="fold open"` 让 `.fold-body` 显示；`open` 属性让 `<details>` 默认展开
    return el('details', { class: 'fold open', open: 'open' }, summary, body);
  }

  /**
   * 群友印象内联编辑器（编辑 / 新增共用；一行一条，留空 = 清空该成员全部印象）。
   *
   * @param {object} box 编辑器描述 `{userId, name, impressions, error}`
   * @returns {Element} 编辑块
   */
  function memberEditor(box) {
    const isNew = !String(box.userId || '');
    const qqInput = el('input', { type: 'text', placeholder: 'QQ 号（1–15 位数字）' });
    qqInput.value = String(box.userId || '');
    qqInput.disabled = !isNew;
    const nameInput = el('input', { type: 'text', placeholder: '名字（备注名 / 群名片 / 昵称）' });
    nameInput.value = String(box.name || '');
    const area = el('textarea', { placeholder: '印象内容（一行一条；最多 ' + IMPRESSION_MAX + ' 条）' });
    area.value = String(box.impressions || '');
    const errEl = el('span', { class: 'view-fail', text: String(box.error || '') });

    const saveBtn = el('button', { class: 'btn small', text: '保存' });
    saveBtn.onclick = async () => {
      // 失败时保留用户已输入的内容（renderDetail 会按描述对象重建编辑器）
      box.userId = String(qqInput.value || '').trim();
      box.name = String(nameInput.value || '').trim();
      box.impressions = String(area.value || '');
      box.error = '';
      saveBtn.disabled = true;
      const ok = await saveMember(box.userId, box.name, box.impressions);
      if (!ok) { box.error = state.note || '保存失败'; state.editor = box; }
      renderDetail();
    };
    const cancelBtn = el('button', { class: 'btn small', text: '取消' });
    cancelBtn.onclick = () => closeEditor();

    return el('div', { class: 'field memory-editor vertical' },
      el('div', { class: 'control' },
        el('span', { class: 'note', text: isNew ? '新增群友印象' : '编辑群友印象' }),
        qqInput,
        nameInput),
      area,
      el('div', { class: 'control' }, saveBtn, cancelBtn, errEl));
  }

  /**
   * 两个按群开关面（余额后缀 / 语音伴随）——仅群会话显示。
   *
   * @param {string} key 会话键
   * @returns {Element|null} 开关区块；非群会话返 null
   */
  function switchSection(key) {
    if (!isGroup(key)) return null;
    const id = idOf(key);
    const body = el('div', { class: 'sxm-body' });
    const card = () => el('div', { class: 'sxm-card' },
      el('div', { class: 'sxm-head' }, el('span', { class: 'title', text: '按群开关' })), body);
    if (!state.cfg) {
      // 配置端点没取到就不渲染控件——用缺省值渲染会让「未配置」伪装成「已关闭」
      empty(body, '业务面配置不可用（/api/biz/config 未取到），按群开关暂不可用');
      return card();
    }
    const bal = balanceStateOf(state.cfg, id);
    const voice = voiceStateOf(state.cfg, id);

    if (!bal) {
      body.appendChild(el('p', { class: 'view-empty', text: '该会话缺少群号，按群开关不可用' }));
      return card();
    }

    // 🎚 发言档位（五档；写 engage.levelByChat，档位 1 同步并入 engage.quiet.chats）
    const lv = engageLevelOf(state.cfg, id);
    const lvSel = el('select', {});
    LEVEL_NAMES.forEach((name, i) => {
      const opt = el('option', { value: String(i + 1), text: (i + 1) + '· ' + name });
      if (lv && lv.level === i + 1) opt.selected = true;
      lvSel.appendChild(opt);
    });
    lvSel.onchange = () => setEngageLevel(id, Number(lvSel.value));
    body.appendChild(el('div', { class: 'field' },
      el('label', { text: '🎚 发言档位' }),
      el('div', { class: 'control' },
        lvSel,
        el('span', { class: 'note', text: '只调这一拍要不要开口（入场率）；发言配额 5 条/2 分钟与浏览节拍不受影响' }))));

    // 💰 余额后缀：开关 + 余额值 + 立即刷新（写后按读回值重渲染，见 writeConfig）
    const balChk = el('input', { type: 'checkbox' });
    balChk.checked = bal.on;
    balChk.onchange = () => toggleBalance(id, key, balChk.checked);
    const balVal = el('input', { type: 'text' });
    balVal.value = bal.amount;
    balVal.onchange = () => setBalanceValue(id, key, balVal.value);
    const balSyncBtn = el('button', { class: 'btn small', text: '立即刷新' });
    balSyncBtn.onclick = () => syncBalanceNow(id);

    body.appendChild(el('div', { class: 'field' },
      el('label', { text: '💰 余额后缀' }),
      el('div', { class: 'control' },
        el('label', { class: 'hint' }, balChk, ' 开'),
        balVal,
        balSyncBtn,
        el('span', { class: 'note', text: '每 ' + bal.minutes + ' 分钟把「' + bal.marker + 'xx.xx」刷到本号群名片尾部（只动这个群）' }))));

    // 🔊 语音伴随：开关（总开关关掉时开关显示为关，并注明总开关）
    const voiceChk = el('input', { type: 'checkbox' });
    voiceChk.checked = voice.on;
    voiceChk.disabled = !voice.enabled;
    voiceChk.onchange = () => toggleVoice(id, key, voiceChk.checked);
    body.appendChild(el('div', { class: 'field' },
      el('label', { text: '🔊 语音伴随' }),
      el('div', { class: 'control' },
        el('label', { class: 'hint' }, voiceChk, voice.enabled ? ' 开' : ' 总开关已关（engage.voiceReply.enabled=false）'),
        el('span', { class: 'note', text: voice.runMode + ' · 每句 ≤' + voice.maxChars + ' 字' }))));

    body.appendChild(el('p', { class: 'hint', text: '开关写业务面配置（engage.balance.chats / engage.voiceReply.chats），保存后按 /api/biz/config 读回值重渲染。' }));

    return el('div', { class: 'sxm-card' },
      el('div', { class: 'sxm-head' },
        el('span', { class: 'title', text: '按群开关' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', text: state.cfg ? '' : '配置未载入' })), body);
  }

  /**
   * 右栏头部（会话名 + 计数 + 「重整」按钮 + 编辑态开关）。
   *
   * @param {string} key 会话键
   * @param {object} file 左栏对应条目（计数来源）
   * @returns {Element} 头部元素
   */
  function detailHead(key, file) {
    const busy = isBusy(file || { chatKey: key });
    const reloadBtn = el('button', { class: 'btn small', text: '刷新' });
    reloadBtn.onclick = () => loadDetail(key);
    const consolidateBtn = el('button', { class: 'btn small', text: busy ? '整理中…' : '重整本群记忆' });
    consolidateBtn.disabled = busy;
    consolidateBtn.onclick = () => consolidate(key);
    // 删除本会话记忆（`DELETE /api/biz/memory-files/<seg>`）——不可逆，二次确认在 deleteChatMemory
    const delBtn = el('button', { class: 'btn small', text: '删除本会话记忆' });
    delBtn.onclick = () => deleteChatMemory(key);

    return el('div', { class: 'sx-head' },
      el('div', { class: 'sx-head-title' },
        el('h3', { text: nameOf(key) + ' 的记忆' }),
        busy
          ? el('span', { class: 'sx-badge sx-waiting', text: '整理中' })
          : el('span', { class: 'sx-badge sx-done', text: '记忆' }),
        el('span', { class: 'spacer' }),
        reloadBtn,
        consolidateBtn,
        delBtn),
      el('div', { class: 'sx-head-metas' },
        el('span', { class: 'mono', text: key }),
        file ? el('span', { text: (Number(file.memberCount) || 0) + ' 位群友 · ' + (Number(file.impressionCount) || 0) + ' 条印象 · '
          + (Number(file.groupCount) || 0) + ' 群记' }) : null,
        file ? el('span', { text: '更新于 ' + fmtTime(file.updatedAt) }) : null,
        state.note ? el('span', { text: state.note }) : null));
  }

  /**
   * 右栏渲染：头部 + 群记 + 群友印象 + 按群开关。
   *
   * @returns {void}
   */
  function renderDetail() {
    if (!refs) return;
    refs.headEl.textContent = '';
    refs.bodyEl.textContent = '';

    const key = state.currentKey;
    if (!key) {
      empty(refs.bodyEl, '← 选择左侧的会话查看记忆');
      return;
    }
    const file = state.files.filter((f) => String(f.chatKey || '') === String(key))[0] || null;
    refs.headEl.appendChild(detailHead(key, file));

    if (state.detailError) {
      fail(refs.bodyEl, UNREACHABLE + '：' + state.detailError);
      return;
    }
    if (state.loadingDetail && !state.detail) {
      empty(refs.bodyEl, '正在载入记忆…');
      return;
    }

    const detail = state.detail || {};
    const members = Array.isArray(detail.members) ? detail.members : [];
    const rapportMap = {};
    for (const r of (Array.isArray(detail.rapport) ? detail.rapport : [])) {
      if (r && r.userId != null) rapportMap[String(r.userId)] = r;
    }

    // 会话要点区（顶部只读，`design-qqbotb-memory.md` §3.5）
    refs.bodyEl.appendChild(summarySection());

    // 群记区（群轴；现行 / 归档切换在区块头部）
    refs.bodyEl.appendChild(groupSection(detail.group, detail));

    // 群友印象区（人轴）
    const addImpBtn = el('button', { class: 'btn small', text: '＋ 添加印象' });
    addImpBtn.onclick = () => openEditor({ mode: 'member', userId: '', name: '', impressions: '', error: '' });
    const impHead = el('div', { class: 'sxm-head' },
      el('span', { class: 'title', text: '群友印象' }),
      el('span', { class: 'hint', text: members.length + ' 位' }),
      el('span', { class: 'spacer' }),
      addImpBtn);
    const impBody = el('div', { class: 'sxm-body' });
    // 新增成员编辑器（无 userId 时挂在这里，不进任何成员的折叠块）
    if (state.editor && state.editor.mode === 'member' && !String(state.editor.userId || '')) {
      impBody.appendChild(memberEditor(state.editor));
    }
    if (!members.length) {
      empty(impBody, '还没有任何群友印象（可点「重整本群记忆」让模型从聊天记录里提炼）');
    } else {
      for (const member of members) {
        impBody.appendChild(memberBlock(member, rapportMap[String(member && member.userId)]));
      }
    }
    refs.bodyEl.appendChild(el('div', { class: 'sxm-card' }, impHead, impBody));

    // 群成员卡（按需拉取——改备注 / 指定 bot；非群会话不渲染）
    const ms = membersSection(key);
    if (ms) refs.bodyEl.appendChild(ms);

    // 按群开关区（余额后缀 / 语音伴随）
    const sw = switchSection(key);
    if (sw) refs.bodyEl.appendChild(sw);
  }

  /**
   * 取一次详情。
   *
   * @param {string} key 会话键
   * @returns {Promise<void>} 完成
   */
  async function loadDetail(key) {
    if (!refs || !key) return;
    const api = ui().api;
    if (typeof api !== 'function') {
      state.detailError = '契约未就绪（window.__ui.api 缺失）';
      state.loadingDetail = false;
      renderDetail();
      return;
    }
    const token = ++detailSeq;
    state.loadingDetail = true;
    state.detailError = '';
    renderDetail();

    // 详情 + 会话要点并行取：两个端点互不依赖，串行会把首屏拖成两跳
    const [res, sumRes] = await Promise.all([
      api('/api/biz/memory-files/' + pathKeyOf(key)),
      api('/api/biz/memory-files/' + pathKeyOf(key) + '/summary')
    ]);
    if (token !== detailSeq) return;                 // 迟到响应：已切会话，丢弃
    state.loadingDetail = false;
    if (!res || res.ok === false) {
      state.detailError = String((res && (res.error || ('HTTP ' + res.status))) || '未知错误');
      state.detail = null;
    } else {
      state.detail = res;
    }
    // 要点端点自成三态：取不到只让要点区报错，不牵连整个详情面
    if (!sumRes || sumRes.ok === false) {
      state.summary = null;
      state.summaryError = String((sumRes && (sumRes.error || ('HTTP ' + sumRes.status))) || '未知错误');
    } else {
      state.summaryError = '';
      state.summary = sumRes.summary || null;
    }
    renderDetail();
  }

  /**
   * 选中一个会话：重置详情面并立刻取数。
   *
   * @param {string} key 会话键
   * @returns {Promise<void>} 取数链
   */
  function select(key) {
    if (!key) return Promise.resolve();
    const same = String(state.currentKey || '') === String(key);
    state.currentKey = key;
    state.note = '';
    state.editor = null;
    state.view = 'current';          // 切会话回到「现行」——归档视图属单会话语境，跟人不跟页
    if (!same) {
      state.detail = null;
      state.detailError = '';
      state.summary = null;
      state.summaryError = '';
      // 群成员表跟会话走——换会话即收起，避免把上一下群的成员挂到新群下
      state.groupMembers = [];
      state.groupMembersError = '';
      state.groupMembersOpen = false;
    }
    renderList();
    return loadDetail(key);
  }

  /**
   * 让模型重分析某个群友（有印象则整理合并，没印象则从聊天记录提炼）。
   *
   * 走 `POST /api/biz/memory-files/consolidate` 的 `userIds` 单人口径
   * （`routes.js:1452-1457`：`userIds` 非空时只整理这些人）。
   *
   * @param {string} userId QQ 号
   * @param {string} who 显示名（提示用）
   * @param {Element} btn 触发按钮（做「更新中… / 已提交 ✓」在位反馈）
   * @returns {Promise<void>} 完成
   */
  async function refreshMemberMemory(userId, who, btn) {
    const api = ui().api;
    const uid = String(userId || '').trim();
    if (typeof api !== 'function') return;
    if (!/^\d{1,15}$/.test(uid)) {
      state.note = '该群友缺少 QQ 号，无法定位聊天记录';
      renderDetail();
      return;
    }
    const key = state.currentKey;
    if (!key) return;
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
    const res = await api('/api/biz/memory-files/consolidate',
      { method: 'POST', body: { chatKey: key, userIds: [uid], force: true } });
    if (!res || res.ok === false) {
      state.note = '更新「' + who + '」的记忆失败 · ' + String((res && (res.error || res.status)) || '-');
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
      renderDetail();
      return;
    }
    state.note = '已提交：重分析「' + who + '」的记忆';
    if (state.running.indexOf(key) < 0) state.running.push(key);
    if (btn) { btn.textContent = '已提交 ✓'; }
    renderList();
    renderDetail();
    // 后端结束时会把 consolidating 撤掉；1.2s 后重取一次让界面跟上（与 consolidate 同节奏）
    setTimeout(() => { refresh().catch(() => {}); }, 1200);
  }

  /**
   * 群成员表卡（原版「拉取群成员列表（编辑备注）」同义）。
   *
   * 只在群会话出现；按钮按需拉 `GET /api/biz/groups/<id>/members`，
   * 表内每行可改备注（写 `memberNotes`）与切 🤖 bot（写 `engage.botGuard.members`）。
   *
   * @param {string} key 会话键（`group:<id>`）
   * @returns {Element|null} 卡片元素；非群返 null
   */
  function membersSection(key) {
    if (!isGroup(key)) return null;
    const id = idOf(key);
    if (!id) return null;

    const loadBtn = el('button', { class: 'btn small', text: state.groupMembersOpen ? '重新拉取' : '拉取群成员列表' });
    loadBtn.title = '从协议端取本群成员（编辑备注 / 指定 bot 用）';
    loadBtn.onclick = () => loadGroupMembers(id);

    const head = el('div', { class: 'sxm-head' },
      el('span', { class: 'title', text: '群成员' }),
      el('span', { class: 'hint', text: state.groupMembersError
        ? '拉取失败：' + state.groupMembersError
        : (state.groupMembers.length ? state.groupMembers.length + ' 人' : '未拉取') }),
      el('span', { class: 'spacer' }),
      loadBtn);

    const body = el('div', { class: 'sxm-body' });
    if (!state.groupMembersOpen) {
      body.appendChild(el('p', { class: 'hint', text: '点「拉取群成员列表」从协议端取本群成员，可改备注（聊天记录 / 记忆 / 成员表都优先显示备注）与指定 🤖 bot。' }));
      return el('div', { class: 'sxm-card' }, head, body);
    }

    const notes = (((state.cfg || {}).memberNotes) || {});
    const bots = botMembersOf(state.cfg);
    const table = el('table', { class: 'member-table' },
      el('tr', {},
        el('th', { text: '群名片 / 备注' }),
        el('th', { text: 'QQ 昵称' }),
        el('th', { text: 'QQ 号' }),
        el('th', { text: '操作' })));
    for (const m of state.groupMembers) {
      const qq = String((m && m.userId) || '');
      const note = String(notes[qq] || '');
      const isBot = bots.indexOf(qq) >= 0;
      const editing = state.noteEditor && String(state.noteEditor.qq) === qq;

      // 备注编辑态：行内输入框 + 保存 / 取消（不用 window.prompt——会阻塞渲染线程）
      if (editing) {
        const input = el('input', {
          type: 'text',
          class: 'btn small',
          style: 'width:12em',
          placeholder: '备注名（留空 = 删除）',
          value: state.noteEditor.value
        });
        input.addEventListener('input', () => { state.noteEditor.value = input.value; });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); saveMemberNote(qq, id); }
          if (ev.key === 'Escape') { state.noteEditor = null; renderDetail(); }
        });
        const saveBtn = el('button', { class: 'btn small primary', text: '保存' });
        saveBtn.onclick = () => saveMemberNote(qq, id);
        const cancelBtn = el('button', { class: 'btn small', text: '取消' });
        cancelBtn.onclick = () => { state.noteEditor = null; renderDetail(); };
        table.appendChild(el('tr', {},
          el('td', {}, input),
          el('td', { class: 'hint', text: String((m && m.nickname) || '—') }),
          el('td', { class: 'mono hint', text: qq }),
          el('td', {}, saveBtn, cancelBtn)));
        continue;
      }

      const noteBtn = el('button', { class: 'btn small', text: note ? '改备注' : '加备注' });
      noteBtn.onclick = () => openNoteEditor(qq);
      const botBtn = el('button', { class: 'btn small' + (isBot ? ' primary' : ''), text: isBot ? '🤖 bot ✓' : '🤖 bot' });
      botBtn.title = '指定为机器人：对 TA 的回复限制为 240 秒 1 条';
      botBtn.onclick = () => toggleBotMember(qq);
      table.appendChild(el('tr', {},
        el('td', { text: note || String((m && m.card) || '—') }),
        el('td', { class: 'hint', text: String((m && m.nickname) || '—') }),
        el('td', { class: 'mono hint', text: qq }),
        el('td', {}, noteBtn, botBtn)));
    }
    body.appendChild(table);
    return el('div', { class: 'sxm-card' }, head, body);
  }

  /**
   * 拉群成员列表（`GET /api/biz/groups/<id>/members`）。
   *
   * @param {string} id 群号
   * @returns {Promise<void>} 完成
   */
  async function loadGroupMembers(id) {
    const api = ui().api;
    if (typeof api !== 'function' || !id) return;
    state.groupMembersError = '';
    state.groupMembersOpen = true;
    renderDetail();
    const res = await api('/api/biz/groups/' + String(id) + '/members');
    if (!res || res.ok === false || res.error) {
      state.groupMembers = [];
      state.groupMembersError = String((res && (res.error || res.status)) || '协议端未响应');
      renderDetail();
      return;
    }
    state.groupMembers = Array.isArray(res.members) ? res.members : [];
    renderDetail();
  }

  /**
   * 打开备注行内编辑器（**不用 `window.prompt`**——Electron renderer 里它会阻塞渲染线程，
   * 弹一次页面就死锁，browser-* 全部超时）。
   *
   * @param {string} qq QQ 号
   * @returns {void}
   */
  function openNoteEditor(qq) {
    const cur = String((((state.cfg || {}).memberNotes) || {})[String(qq)] || '');
    state.noteEditor = { qq: String(qq), value: cur, error: '' };
    renderDetail();
  }

  /**
   * 保存备注（写配置 `memberNotes`，读回核对；留空 = 删除备注）。
   *
   * @param {string} qq QQ 号
   * @param {string} groupId 群号（保存成功后重拉成员表）
   * @returns {Promise<void>} 完成
   */
  async function saveMemberNote(qq, groupId) {
    const ed = state.noteEditor;
    if (!ed || String(ed.qq) !== String(qq)) return;
    const name = String(ed.value || '').trim();
    const notes = Object.assign({}, ((state.cfg || {}).memberNotes) || {});
    if (name) notes[String(qq)] = name; else delete notes[String(qq)];
    // 🔴 `memberNotes` 是映射型字段：深合并传 {} 删不掉已有键（config.js:614-616），
    //    必须用 `{ __replace__: X }` 整体替换，否则「删备注」读回必然不一致。
    const ok = await writeConfig({ memberNotes: { __replace__: notes } }, '备注「' + (name || '已删除') + '」',
      (cfg) => String((((cfg || {}).memberNotes) || {})[String(qq)] || '') === name);
    if (!ok) {
      state.noteEditor = { qq: String(qq), value: ed.value, error: state.note };
      renderDetail();
      return;
    }
    state.noteEditor = null;
    await loadGroupMembers(groupId);
  }

  /**
   * 触发一次记忆重整（`POST /api/biz/memory-files/consolidate`）。
   *
   * 后端返回 202 `{ok:true, started:true}`；结果通过 `memory-update` 事件与
   * `GET /api/biz/memory-files` 的 `consolidating` 反映——本块只渲染「已提交」并重取列表。
   *
   * @param {string} key 会话键
   * @returns {Promise<void>} 完成
   */
  async function consolidate(key) {
    const api = ui().api;
    if (typeof api !== 'function' || !key) return;
    const res = await api('/api/biz/memory-files/consolidate', { method: 'POST', body: { chatKey: key, force: true } });
    if (!res || res.ok === false) {
      state.note = '重整失败 · ' + String((res && (res.error || res.status)) || '-');
      renderDetail();
      return;
    }
    state.note = res.started ? '已提交重整' : '重整已受理';
    if (state.running.indexOf(key) < 0) state.running.push(key);
    renderList();
    renderDetail();
    // 稍后重取一次，让后端 consolidating 状态覆盖本地乐观标记
    setTimeout(() => { refresh().catch(() => {}); }, 1200);
  }

  /**
   * 写业务面配置并**读回核对**（禁本地乐观更新后不核对）。
   *
   * @param {object} patch 配置补丁（如 `{engage:{balance:{chats:[...]}}}`）
   * @param {string} expect 期望的读回判据描述（写进不一致提示）
   * @param {Function} verify 读回校验函数 `(cfg) => boolean`
   * @returns {Promise<boolean>} 读回是否与写入一致
   */
  async function writeConfig(patch, expect, verify) {
    const api = ui().api;
    if (typeof api !== 'function') return false;
    const wrote = await api('/api/biz/config', { method: 'POST', body: patch });
    if (!wrote || wrote.ok === false) {
      state.note = '保存失败 · ' + String((wrote && (wrote.error || wrote.status)) || '-');
      return false;
    }
    // 🔴 读回核对：ok=true 只证明请求被接受，不证明落盘正确
    const readBack = await api('/api/biz/config');
    const cfg = pickConfig(readBack);
    if (!cfg) {
      state.note = '保存后读回失败 · ' + String((readBack && (readBack.error || readBack.status)) || '-');
      return false;
    }
    state.cfg = cfg;
    const same = typeof verify === 'function' ? !!verify(cfg) : true;
    state.note = same ? ('已保存 · ' + expect + '（读回一致）') : ('读回与写入不一致 · ' + expect);
    return same;
  }

  /**
   * 开 / 关某群的余额后缀（写 `engage.balance.chats`）。
   *
   * @param {string} id 群号
   * @param {string} key 会话键
   * @param {boolean} on 是否开启
   * @returns {Promise<void>} 完成
   */
  async function toggleBalance(id, key, on) {
    const cur = ((((state.cfg || {}).engage || {}).balance || {}).chats || []).map(String);
    const next = on
      ? (cur.indexOf(String(id)) >= 0 ? cur : cur.concat([String(id)]))
      : cur.filter((x) => x !== String(id));
    const ok = await writeConfig(
      { engage: { balance: { chats: next } } },
      '余额后缀 ' + (on ? '开' : '关'),
      (cfg) => {
        const st = balanceStateOf(cfg, id);
        return !!st && st.on === !!on;
      });
    if (ok && on) await syncBalanceNow(id);
    renderList();
    if (state.currentKey === key) renderDetail();
  }

  /**
   * 写余额值（所有开启的群共用一个数；2 位小数，非负）。
   *
   * @param {string} id 群号
   * @param {string} key 会话键
   * @param {string} raw 输入原文
   * @returns {Promise<void>} 完成
   */
  async function setBalanceValue(id, key, raw) {
    const n = Number(String(raw == null ? '' : raw).trim());
    if (!Number.isFinite(n) || n < 0) {
      state.note = '余额要填 0 或正数（如 12.34）';
      renderDetail();
      return;
    }
    const value = Math.round(n * 100) / 100;
    const ok = await writeConfig(
      { engage: { balance: { value } } },
      '余额 = ' + value.toFixed(2),
      (cfg) => {
        const st = balanceStateOf(cfg, id);
        return !!st && st.amount === value.toFixed(2);
      });
    if (ok) await syncBalanceNow(id);
    renderList();
    if (state.currentKey === key) renderDetail();
  }

  /**
   * 立即刷一次群名片余额后缀（`POST /api/biz/balance/sync`）。
   *
   * @param {string} id 群号
   * @returns {Promise<void>} 完成
   */
  async function syncBalanceNow(id) {
    const api = ui().api;
    if (typeof api !== 'function') return;
    const res = await api('/api/biz/balance/sync', { method: 'POST', body: { chat: String(id || '') } });
    const one = ((res && res.results) || [])[0] || {};
    if (!res || res.ok === false) {
      state.note = '名片刷新失败 · ' + String(one.reason || (res && (res.error || res.status)) || '-');
    } else if (one.skipped) {
      state.note = '名片已是最新';
    } else if (one.card) {
      state.note = '名片已刷成 ' + String(one.card);
    } else {
      state.note = '名片已刷新';
    }
    renderDetail();
  }

  /**
   * 开 / 关某群的语音伴随（写 `engage.voiceReply.chats`）。
   *
   * @param {string} id 群号
   * @param {string} key 会话键
   * @param {boolean} on 是否开启
   * @returns {Promise<void>} 完成
   */
  async function toggleVoice(id, key, on) {
    const cur = ((((state.cfg || {}).engage || {}).voiceReply || {}).chats || []).map(String);
    const next = on
      ? (cur.indexOf(String(id)) >= 0 ? cur : cur.concat([String(id)]))
      : cur.filter((x) => x !== String(id));
    await writeConfig(
      { engage: { voiceReply: { chats: next } } },
      '语音伴随 ' + (on ? '开' : '关'),
      (cfg) => {
        const st = voiceStateOf(cfg, id);
        return !!st && (st.chats.indexOf(String(id)) >= 0) === !!on;
      });
    renderList();
    if (state.currentKey === key) renderDetail();
  }

  // ── 写操作面（R7-L2）─────────────────────────────────────────────────────
  // 端点全部沿用业务面既有路由（`app/src/business/routes.js`），本块只做调用与读回：
  //   群记 POST/PUT/DELETE `/api/memory-files/<group|private>_<id>/group[/<entryId>]`
  //   成员 PUT/DELETE `/api/memory-files/<group|private>_<id>/members/<uid>`
  //   整个会话 DELETE `/api/memory-files/<group|private>_<id>`
  // 所有写后一律**重取详情**，界面值以接口读回为准（禁本地乐观更新）。

  /**
   * 取某会的发言档位（业务面 `engage-level.js` 同口径：`levelByChat` → `quiet.chats` → 默认 3）。
   *
   * @param {object} cfg 业务面配置
   * @param {string} id 群号
   * @returns {{level:number, name:string}|null} 档位；非群返 null
   */
  function engageLevelOf(cfg, id) {
    if (!/^\d{1,15}$/.test(String(id || ''))) return null;
    const engage = (cfg && cfg.engage) || {};
    const map = engage.levelByChat || {};
    let level = 3;
    if (map[id] != null) {
      const n = Math.round(Number(map[id]));
      if (Number.isFinite(n)) level = Math.min(5, Math.max(1, n));
    } else if ((((engage.quiet || {}).chats) || []).map(String).indexOf(String(id)) >= 0) {
      level = 1;
    }
    return { level, name: LEVEL_NAMES[level - 1] };
  }

  /**
   * 取被指定为机器人的群友 QQ 清单（`engage.botGuard.members`）。
   *
   * @param {object} cfg 业务面配置
   * @returns {string[]} QQ 号数组
   */
  function botMembersOf(cfg) {
    const m = (((cfg || {}).engage || {}).botGuard || {}).members;
    return (Array.isArray(m) ? m : []).map(String);
  }

  /**
   * 详情端点路径段（`group:123` → `group_123`）。
   *
   * @param {string} key 会话键
   * @returns {string} 路径段
   */
  function basePathOf(key) {
    return '/api/biz/memory-files/' + pathKeyOf(key);
  }

  /**
   * 失败原因文本（带 HTTP 语义提示；405 单独点名——代理层方法白名单不收该方法）。
   *
   * @param {object} res 端点返回
   * @returns {string} 原因
   */
  function errOf(res) {
    const raw = String((res && (res.error || res.status)) || '-');
    if (res && res.status === 405) return raw + '（单体代理层方法白名单不含该方法）';
    return raw;
  }

  /**
   * 开一个内联编辑器（群记 / 印象共用；挂在 `state.editor`，渲染时读到就画）。
   *
   * @param {object} box 编辑器描述 `{mode, entryId, userId, name, kind, content, impressions, error}`
   * @returns {void}
   */
  function openEditor(box) {
    state.editor = box || null;
    renderDetail();
  }

  /** 关闭内联编辑器。 */
  function closeEditor() {
    state.editor = null;
    state.note = '';
    renderDetail();
  }

  /**
   * 重取详情（写操作后统一入口；不重取整页）。
   *
   * @returns {Promise<void>} 完成
   */
  async function reload() {
    if (!state.currentKey) return;
    await loadDetail(state.currentKey);
  }

  /**
   * 加一条群记（`POST /api/biz/memory-files/<seg>/group`）。
   *
   * @param {string} kind 分类（`KIND_ORDER` 之一）
   * @param {string} content 内容
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function addGroupEntry(kind, content) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey) return false;
    const k = String(kind || '').trim();
    const c = String(content || '').trim();
    if (KIND_ORDER.indexOf(k) < 0) { state.note = '分类必须是：' + KIND_ORDER.join(' / '); return false; }
    if (!c) { state.note = '群记内容不能为空'; return false; }
    const res = await api(basePathOf(state.currentKey) + '/group', {
      method: 'POST',
      body: { kind: k, content: c.slice(0, GROUP_CONTENT_MAX) }
    });
    if (!res || res.ok === false) {
      state.note = '加群记失败 · ' + String((res && (res.error || res.status)) || '-');
      return false;
    }
    state.note = '已加群记 · ' + (KIND_LABEL[k] || k);
    state.editor = null;
    await reload();
    return true;
  }

  /**
   * 改一条群记（`PUT /api/biz/memory-files/<seg>/group`，整体替换：把 id 对应条目换掉）。
   *
   * 业务面的 PUT 是"整体替换"语义（`replaceGroupEntries` 会给所有条目重建 id），
   * 所以改一条 = 取当前全量 → 替换目标条目 → 整体回写 → 重取核对。
   *
   * @param {string} entryId 目标条目 id
   * @param {string} content 新内容
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function updateGroupEntry(entryId, content) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey) return false;
    const c = String(content || '').trim();
    if (!c) { state.note = '群记内容不能为空'; return false; }
    const cur = (state.detail && Array.isArray(state.detail.group)) ? state.detail.group : [];
    const target = cur.filter((e) => String(e && e.id) === String(entryId))[0];
    if (!target) { state.note = '找不到要改的群记（列表可能已过期，先刷新）'; return false; }
    const entries = cur.map((e) => ({
      kind: String((e && e.kind) || ''),
      content: String(e && e.id) === String(entryId) ? c : String((e && e.content) || '')
    }));
    const res = await api(basePathOf(state.currentKey) + '/group', { method: 'PUT', body: { entries } });
    if (!res || res.ok === false) {
      // 代理层方法白名单 = GET / POST / PUT / DELETE（`business-proxy.js:17`）→ PUT 已可经单体送达；
      // 此处 405 回退保留为防御路径（旧进程 / 白名单回退时仍可用）：删旧 + 加新两步（语义等价：内容换新，id 会重建）。
      if (res && res.status === 405) return await rewriteGroupEntry(entryId, target, c);
      state.note = '改群记失败 · ' + errOf(res);
      return false;
    }
    state.note = '群记已改（整体替换回写）';
    state.editor = null;
    await reload();
    const after = (state.detail && Array.isArray(state.detail.group)) ? state.detail.group : [];
    if (!after.some((e) => String(e && e.content) === c)) {
      state.note = '改群记后读回未命中新内容 · 请刷新确认';
      renderDetail();
      return false;
    }
    return true;
  }

  /**
   * 改群记的 405 回退路径：删旧条目 + 加新条目（两步都是代理层放行的方法）。
   *
   * @param {string} entryId 旧条目 id
   * @param {object} target 旧条目
   * @param {string} content 新内容
   * @returns {Promise<boolean>} 是否改成功（读回命中新内容才算）
   */
  async function rewriteGroupEntry(entryId, target, content) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey) return false;
    const kind = String((target && target.kind) || '');
    const del = await api(basePathOf(state.currentKey) + '/group/' + encodeURIComponent(String(entryId)), { method: 'DELETE' });
    if (!del || del.ok === false) {
      state.note = '改群记失败（删旧条目被拒）· ' + errOf(del);
      return false;
    }
    const add = await api(basePathOf(state.currentKey) + '/group', { method: 'POST', body: { kind, content } });
    if (!add || add.ok === false) {
      state.note = '改群记失败（加新条目被拒，旧条目已删）· ' + errOf(add);
      await reload();
      return false;
    }
    state.note = '群记已改（PUT 被代理层拒 405 → 删旧 + 加新，id 已重建）';
    state.editor = null;
    await reload();
    const after = (state.detail && Array.isArray(state.detail.group)) ? state.detail.group : [];
    if (!after.some((e) => String(e && e.content) === content)) {
      state.note = '改群记后读回未命中新内容 · 请刷新确认';
      renderDetail();
      return false;
    }
    return true;
  }

  /**
   * 删一条群记（`DELETE /api/biz/memory-files/<seg>/group/<entryId>`）。
   *
   * @param {string} entryId 条目 id
   * @returns {Promise<boolean>} 是否删除成功
   */
  async function deleteGroupEntry(entryId) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey || !entryId) return false;
    const res = await api(basePathOf(state.currentKey) + '/group/' + encodeURIComponent(String(entryId)), { method: 'DELETE' });
    if (!res || res.ok === false) {
      state.note = '删群记失败 · ' + String((res && (res.error || res.status)) || '-');
      return false;
    }
    state.note = '已删群记（removed=' + String(res.removed == null ? '?' : res.removed) + '）';
    state.editor = null;
    await reload();
    return true;
  }

  /**
   * 保存某群友的印象（`PUT /api/biz/memory-files/<seg>/members/<uid>`，一行一条）。
   *
   * @param {string} userId QQ 号
   * @param {string} name 名字（备注名 / 群名片 / 昵称）
   * @param {string} raw 印象原文（换行分隔）
   * @returns {Promise<boolean>} 是否保存成功
   */
  async function saveMember(userId, name, raw) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey) return false;
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) { state.note = 'QQ 号必须是 1–15 位数字'; return false; }
    const impressions = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, IMPRESSION_MAX);
    const res = await api(basePathOf(state.currentKey) + '/members/' + encodeURIComponent(uid), {
      method: 'PUT',
      body: { name: String(name || '').trim(), note: '', impressions }
    });
    if (!res || res.ok === false) {
      state.note = '保存印象失败 · ' + errOf(res);
      return false;
    }
    state.note = '已保存 ' + (String(name || '').trim() || uid) + ' 的 ' + impressions.length + ' 条印象';
    state.editor = null;
    await reload();
    const after = (state.detail && Array.isArray(state.detail.members)) ? state.detail.members : [];
    const hit = after.filter((m) => String(m && m.userId) === uid)[0];
    const got = hit && Array.isArray(hit.impressions) ? hit.impressions.length : -1;
    if (got !== impressions.length) {
      state.note = '保存后读回条数不符（写入 ' + impressions.length + ' / 读回 ' + got + '）';
      renderDetail();
      return false;
    }
    return true;
  }

  /**
   * 删某群友的全部印象（`DELETE /api/biz/memory-files/<seg>/members/<uid>`）。
   *
   * @param {string} userId QQ 号
   * @param {string} name 显示名（确认文案用）
   * @returns {Promise<boolean>} 是否删除成功
   */
  async function deleteMember(userId, name) {
    const api = ui().api;
    if (typeof api !== 'function' || !state.currentKey) return false;
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) { state.note = 'QQ 号必须是 1–15 位数字'; return false; }
    if (!window.confirm('确定删除「' + String(name || uid) + '」的全部印象？此操作不可撤销。')) return false;
    const res = await api(basePathOf(state.currentKey) + '/members/' + encodeURIComponent(uid), { method: 'DELETE' });
    if (!res || res.ok === false) {
      state.note = '删除失败 · ' + String((res && (res.error || res.status)) || '-');
      return false;
    }
    state.note = '已删「' + String(name || uid) + '」的全部印象';
    state.editor = null;
    await reload();
    return true;
  }

  /**
   * 删整个会话的记忆（`DELETE /api/biz/memory-files/<seg>`）。
   *
   * @param {string} key 会话键
   * @returns {Promise<boolean>} 是否删除成功
   */
  async function deleteChatMemory(key) {
    const api = ui().api;
    if (typeof api !== 'function' || !key) return false;
    if (!window.confirm('确定删除「' + nameOf(key) + '」的整个记忆？群记与群友印象全部清空，不可撤销。')) return false;
    const res = await api('/api/biz/memory-files/' + pathKeyOf(key), { method: 'DELETE' });
    if (!res || res.ok === false) {
      state.note = '删除本会话记忆失败 · ' + String((res && (res.error || res.status)) || '-');
      renderDetail();
      return false;
    }
    state.note = '已删除「' + nameOf(key) + '」的整个记忆';
    state.detail = null;
    state.editor = null;
    await refresh();
    return true;
  }

  /**
   * 指定 / 取消指定某群友为机器人（写 `engage.botGuard.members`）。
   *
   * @param {string} userId QQ 号
   * @returns {Promise<boolean>} 读回是否与写入一致
   */
  async function toggleBotMember(userId) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) { state.note = '该群友缺少 QQ 号，无法指定'; renderDetail(); return false; }
    const cur = botMembersOf(state.cfg);
    const on = cur.indexOf(uid) < 0;
    const next = on ? cur.concat([uid]) : cur.filter((x) => x !== uid);
    const ok = await writeConfig(
      { engage: { botGuard: { members: next } } },
      'bot 指定 ' + (on ? '开' : '关') + '（' + uid + '）',
      (cfg) => (botMembersOf(cfg).indexOf(uid) >= 0) === on);
    renderDetail();
    return ok;
  }

  /**
   * 设置某群发言档位（写 `engage.levelByChat`；档位 1 同步并入 `engage.quiet.chats`）。
   *
   * @param {string} id 群号
   * @param {number} level 1–5
   * @returns {Promise<boolean>} 读回是否与写入一致
   */
  async function setEngageLevel(id, level) {
    if (!/^\d{1,15}$/.test(String(id || ''))) { state.note = '该会话缺少群号，无法设置发言档位'; renderDetail(); return false; }
    const n = Math.min(5, Math.max(1, Math.round(Number(level) || 3)));
    const cfg = state.cfg || {};
    const map = Object.assign({}, ((cfg.engage || {}).levelByChat || {}));
    map[id] = n;
    const quietCur = (((cfg.engage || {}).quiet || {}).chats || []).map(String);
    const quietNext = n === 1
      ? (quietCur.indexOf(String(id)) >= 0 ? quietCur : quietCur.concat([String(id)]))
      : quietCur.filter((x) => x !== String(id));
    const ok = await writeConfig(
      { engage: { levelByChat: map, quiet: { chats: quietNext } } },
      '发言档位 = ' + n + '·' + LEVEL_NAMES[n - 1],
      (next) => {
        const st = engageLevelOf(next, id);
        const q = (((next.engage || {}).quiet || {}).chats || []).map(String);
        return !!st && st.level === n && ((q.indexOf(String(id)) >= 0) === (n === 1));
      });
    renderList();
    if (state.currentKey) renderDetail();
    return ok;
  }

  /**
   * 一次完整取数（memory-files + chats + config 并行）。
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

    const trio = await Promise.all([
      api('/api/biz/memory-files'),
      api('/api/biz/chats'),
      api('/api/biz/config')
    ]);
    const filesRes = trio[0] || {};
    const chatsRes = trio[1] || {};
    const cfgRes = trio[2] || {};

    if (filesRes.ok === false) {
      state.error = String(filesRes.error || ('HTTP ' + filesRes.status));
      state.files = [];
      state.running = [];
      state.detail = null;
      state.detailError = '';
      state.updatedAt = Date.now();
      renderList();
      renderDetail();
      return;
    }

    state.error = '';
    state.files = Array.isArray(filesRes.files) ? filesRes.files : [];
    state.running = Array.isArray(filesRes.consolidating) ? filesRes.consolidating.map(String) : [];
    state.names = {};
    if (chatsRes.ok !== false && Array.isArray(chatsRes.chats)) {
      for (const c of chatsRes.chats) {
        const key = String((c && c.key) || '');
        if (key && c.chatName) state.names[key] = String(c.chatName);
      }
    }
    // 配置端点成功时直接返回配置本体（无 ok 字段）；失败才是 {ok:false,error}
    // 兜底：`api()` 若把响应体包一层（`{ok:true, data:{...}}`），取里层——本块不猜别处的实现
    state.cfg = pickConfig(cfgRes);
    state.updatedAt = Date.now();

    // 选中的会话若已消失（记忆被删），回落到第一项
    const keys = state.files.map((f) => String(f.chatKey || ''));
    if (!state.currentKey || keys.indexOf(String(state.currentKey)) < 0) {
      state.currentKey = keys.length ? keys[0] : null;
      state.detail = null;
      state.detailError = '';
      state.summary = null;
      state.summaryError = '';
      state.view = 'current';
    }
    renderList();
    if (state.currentKey) await loadDetail(state.currentKey);
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
   * @param {Element} container `#view-memory`
   * @returns {void}
   */
  function mount(container) {
    if (!container) return;
    container.textContent = '';

    const countEl = el('span', { class: 'hint', text: '-' });
    const reloadBtn = el('button', { class: 'btn small', text: '刷新' });
    reloadBtn.onclick = () => refresh();

    const listEl = el('div', { class: 'sx-list' });
    const footEl = el('div', { class: 'r5-foot hint' });
    const headEl = el('div', { class: 'sx-heads' });
    const bodyEl = el('div', { class: 'sx-body' });

    const rootEl = el('div', { class: 'sx-sessions' },
      el('aside', { class: 'sx-list-pane' },
        el('div', { class: 'groups-bar r5-list-bar' },
          el('span', { class: 'title', text: '记忆' }),
          countEl,
          el('span', { class: 'groups-spacer' }),
          reloadBtn),
        listEl,
        footEl),
      el('section', { class: 'sx-detail-pane' }, headEl, bodyEl));

    container.appendChild(rootEl);
    refs = { countEl, listEl, footEl, headEl, bodyEl };
    renderList();
    renderDetail();
  }

  const views = (window.__views = window.__views || {});
  views.memory = { title: '记忆', mount, refresh };
})();
