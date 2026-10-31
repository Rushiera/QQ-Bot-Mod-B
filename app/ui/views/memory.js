// app/ui/views/memory.js —— 记忆页视图块（R5-L5）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L5**
// 契约：`app/ui/views/_index.md` §三（运行时只读 `window.__ui`；块内不发裸请求，一律走 `api()`）
// 状态：✅ 已实现（R5-L5 交付）
//
// 面：左栏 = 记忆文件列表（`/api/biz/memory-files` 全量，条数 = `files.length`，不截断）；
//     右栏 = 选中会话的记忆详情：群记（按 `kind` 分组）+ 群友印象（含回应参数）+
//            「重整」按钮 + 两个按群开关面（💰 余额后缀 / 🔊 语音伴随）。
// 取数：`/api/biz/memory-files` · `/api/biz/memory-files/<group_xxx>` · `/api/biz/chats`（群名）
//       `/api/biz/config`（开关现值；写后**再读一次**核对，不做本地乐观更新）
// 写面：`POST /api/biz/memory-files/consolidate` · `POST /api/biz/config` · `POST /api/biz/balance/sync`
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
    loadingDetail: false,
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
    const busy = isBusy(file);
    const groupCount = Number(file.groupCount) || 0;
    const archived = (Number(file.groupArchived) || 0) + (Number(file.memberArchived) || 0);
    const parts = [
      (Number(file.memberCount) || 0) + ' 位群友',
      (Number(file.impressionCount) || 0) + ' 条印象',
      '群记 ' + groupCount + ' 条'
    ];
    if (archived) parts.push('归档 ' + archived + ' 条');

    const row = el('div', { class: 'list-item' + (key === state.currentKey ? ' active' : '') },
      el('div', { class: 'list-item-main' },
        el('div', { class: 'list-item-title', text: nameOf(key) }),
        el('div', { class: 'list-item-sub', text: busy ? '正在整理本群记忆' : parts.join(' · ') })),
      busy
        ? el('span', { class: 'badge warn', text: '整理中' })
        : el('span', { class: 'list-item-meta', text: fmtTime(file.updatedAt) }));
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
   * 群记条目 → 行。
   *
   * @param {object} entry 群记条目（`{id, kind, content, createdAt, updatedAt}`）
   * @returns {Element} 行元素
   */
  function groupRow(entry) {
    // kind 标签由 groupSection 的分组标题统一给出——行内不再重复渲染（否则每组第一行上方双份标签）
    return el('div', { class: 'field' },
      el('div', { class: 'control' },
        el('span', { text: plain(entry && entry.content) }),
        el('span', { class: 'note', text: (entry && entry.updatedAt) ? fmtTime(entry.updatedAt) : '' })));
  }

  /**
   * 群记区（按 `kind` 分组，顺序 `KIND_ORDER`；未知 kind 归到末尾）。
   *
   * @param {object[]} entries 群记条目列表
   * @param {object} detail 详情（取归档计数）
   * @returns {Element} 区块元素
   */
  function groupSection(entries, detail) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const archived = Number((detail && detail.archiveStats && detail.archiveStats.group) || 0);
    const head = el('div', { class: 'pane-head' },
      el('span', { class: 'title', text: '群记' }),
      el('span', { text: list.length + ' 条' + (archived ? ' · 归档 ' + archived + ' 条' : '') }));

    const body = el('div', { class: 'pane-body' });
    if (!list.length) {
      empty(body, '还没有群记（梗 / 群规 / 关系 / 项目 / 在聊什么）——点「重整」让模型从聊天记录里提炼');
      return el('div', { class: 'pane' }, head, body);
    }

    const groups = new Map();
    for (const entry of list) {
      const kind = String((entry && entry.kind) || '');
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(entry);
    }
    const keys = KIND_ORDER.filter((k) => groups.has(k))
      .concat([...groups.keys()].filter((k) => KIND_ORDER.indexOf(k) < 0));
    for (const kind of keys) {
      const rows = groups.get(kind) || [];
      body.appendChild(el('div', { class: 'hint', text: (KIND_LABEL[kind] || kind || '未分类') + '（' + rows.length + '）' }));
      for (const entry of rows) body.appendChild(groupRow(entry));
    }
    return el('div', { class: 'pane' }, head, body);
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
    const summary = el('summary', {},
      el('span', { text: who + (qq ? '（QQ ' + qq + '）' : '') + ' · ' + imps.length + ' 条' }),
      score === null
        ? el('span', { class: 'hint', text: ' 回应 100' })
        : el('span', { class: score < 80 ? 'view-fail' : 'hint', text: ' 回应 ' + score + (rapport.lastReason ? ' · ' + rapport.lastReason : '') }));

    const body = el('div', { class: 'fold-body' },
      el('div', { class: 'kv' },
        el('span', { class: 'k', text: '更新于' }),
        el('span', { class: 'v', text: fmtTime(member && member.updatedAt) }),
        el('span', { class: 'k', text: '整理于' }),
        el('span', { class: 'v', text: fmtTime(member && member.lastConsolidatedAt) })));

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
   * 两个按群开关面（余额后缀 / 语音伴随）——仅群会话显示。
   *
   * @param {string} key 会话键
   * @returns {Element|null} 开关区块；非群会话返 null
   */
  function switchSection(key) {
    if (!isGroup(key)) return null;
    const id = idOf(key);
    const body = el('div', { class: 'pane-body' });
    if (!state.cfg) {
      // 配置端点没取到就不渲染控件——用缺省值渲染会让「未配置」伪装成「已关闭」
      empty(body, '业务面配置不可用（/api/biz/config 未取到），按群开关暂不可用');
      return el('div', { class: 'pane' },
        el('div', { class: 'pane-head' }, el('span', { class: 'title', text: '按群开关' })), body);
    }
    const bal = balanceStateOf(state.cfg, id);
    const voice = voiceStateOf(state.cfg, id);

    if (!bal) {
      body.appendChild(el('p', { class: 'view-empty', text: '该会话缺少群号，按群开关不可用' }));
      return el('div', { class: 'pane' },
        el('div', { class: 'pane-head' }, el('span', { class: 'title', text: '按群开关' })), body);
    }

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

    return el('div', { class: 'pane' },
      el('div', { class: 'pane-head' },
        el('span', { class: 'title', text: '按群开关' }),
        el('span', { class: 'spacer' }),
        el('span', { text: state.cfg ? '' : '配置未载入' })), body);
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

    return el('div', { class: 'pane-head' },
      el('span', { class: 'title', text: nameOf(key) + ' 的记忆' }),
      el('span', { class: 'mono hint', text: key }),
      file ? el('span', { text: (Number(file.memberCount) || 0) + ' 群友 · ' + (Number(file.groupCount) || 0) + ' 群记' }) : null,
      el('span', { class: 'spacer' }),
      state.note ? el('span', { class: 'hint', text: state.note }) : null,
      reloadBtn,
      consolidateBtn);
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

    // 群记区（群轴）
    refs.bodyEl.appendChild(groupSection(detail.group, detail));

    // 群友印象区（人轴）
    const impHead = el('div', { class: 'pane-head' },
      el('span', { class: 'title', text: '群友印象' }),
      el('span', { text: members.length + ' 位' }));
    const impBody = el('div', { class: 'pane-body' });
    if (!members.length) {
      empty(impBody, '还没有任何群友印象（可点「重整本群记忆」让模型从聊天记录里提炼）');
    } else {
      for (const member of members) {
        impBody.appendChild(memberBlock(member, rapportMap[String(member && member.userId)]));
      }
    }
    refs.bodyEl.appendChild(el('div', { class: 'pane' }, impHead, impBody));

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

    const res = await api('/api/biz/memory-files/' + pathKeyOf(key));
    if (token !== detailSeq) return;                 // 迟到响应：已切会话，丢弃
    state.loadingDetail = false;
    if (!res || res.ok === false) {
      state.detailError = String((res && (res.error || ('HTTP ' + res.status))) || '未知错误');
      state.detail = null;
    } else {
      state.detail = res;
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
    if (!same) {
      state.detail = null;
      state.detailError = '';
    }
    renderList();
    return loadDetail(key);
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

    const listEl = el('div', { class: 'pane-body' });
    const footEl = el('div', { class: 'hint' });
    const headEl = el('div', { class: 'pane-head' });
    const bodyEl = el('div', { class: 'pane-body' });

    const rootEl = el('div', { class: 'split' },
      el('aside', { class: 'pane narrow' },
        el('div', { class: 'pane-head' },
          el('span', { class: 'title', text: '记忆文件' }),
          countEl,
          el('span', { class: 'spacer' }),
          reloadBtn),
        listEl,
        el('div', { class: 'pane-body flush' }, footEl)),
      el('section', { class: 'pane wide' }, headEl, bodyEl));

    container.appendChild(rootEl);
    refs = { countEl, listEl, footEl, headEl, bodyEl };
    renderList();
    renderDetail();
  }

  const views = (window.__views = window.__views || {});
  views.memory = { title: '记忆', mount, refresh };
})();
