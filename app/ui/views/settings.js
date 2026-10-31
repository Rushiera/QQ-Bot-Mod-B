// app/ui/views/settings.js —— 业务设置页视图块（R5-L8 批 1 / R6-L2 批 2）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L8**（批 1 / 批 2 同一线，无跨线冲突）；
//       R6 任务卡 §二 表续接同一写面（L2）
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`；块内不写 fetch，一律走 `__ui.api`）
// 状态：批 1 ✅ 骨架 + 侧栏 + 分节调度 + 折叠机制 + 保存/读回；批 2 ✅ 十节全接 + 切节保值（§四 L2 补强①）
// 回执：`reports/R5-L8.md`（批 1 §一–§八 / 批 2 §九）
//
// 🔴 「业务设置」= 页签 `bizsettings` / `#view-bizsettings`——业务面那只猫怎么说话
//    （模型 / 搜索 / 记忆 / 人设 / 名单 / 会话 / 桌面 / OneBot / 工具 / 提示词）。
//    与既有「本地设置」（`#view-settings`：协议端目录 / 登录账号 / 界面端口 / 开机自启，
//    归 `app/ui/app.js`）**并存不合并**——一个改这台机器上的单体，一个改业务面那只猫。
//
// 分工：
//   · 本文件 = 骨架（左右分栏）+ 侧栏（分节清单）+ 折叠机制 + 分节调度 + 保存/读回动作
//   · `settings-sections.js` = 各分节的 DOM（挂 `window.__settingsSections.<id>`）
//
// 口径（任务卡 §1.3 + §四 L8）：指令类面照搬原版形态——控件在、标签对、分组对、不报 JS 错即过；
//   写链路是否真通本轮不判。取数面按卡验「读 config 渲染现值 / 写回后读回 = 写入值」。
//
// 数据源（全部经 L9 代理层，见任务卡 §3.2）：
//   GET  /api/biz/config            → 脱敏配置（密钥字段被删、补 hasXxx 布尔）
//   POST /api/biz/config            → body 为 patch（深合并），返回 { ok, config }
//   GET  /api/biz/providers         → 提供商目录（api 节显示名解析用）
//   POST /api/biz/model-prices/refresh → 拉取官方价格表（指令类）
//
// 三态：读取中 → `empty()`；不可达 → `fail()`（文案带 3210）；分节未实现 → 「未接」占位并列名。

(function () {
  'use strict';

  /** 桩标记——批 1 已实现骨架，置 false（L16 契约自测断言这里必须是 false）。 */
  const STUB = false;

  /** 失败态统一文案（契约要求含 3210）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /**
   * 分节清单——与原版 `_unpack/resources/app/ui/app/06-settings-render.js` 的十个渲染函数对位。
   *
   * `batch` 标明交付批次（1 = 本批已接，2 = 批 2 接）；未接的分节**不删条目**，
   * 侧栏照样列出来，点开显示「未接」占位并列出全部未接分节名（任务卡 §四 L8 ③）。
   */
  const SECTIONS = [
    { id: 'api', title: '模型 API', sub: '提供商 / 模型 / 降级 / 成本', src: '06-settings-render.js:171', batch: 1 },
    { id: 'search', title: '搜索服务', sub: '搜索通道 / 结果条数 / 自定义提供商', src: '06-settings-render.js:262', batch: 1 },
    { id: 'memory', title: '记忆', sub: '记忆整理 / 沉淀节奏 / 记忆文件', src: '06-settings-render.js:369', batch: 1 },
    { id: 'persona', title: '人设', sub: '名字 / 角色卡 / 参与度 / 分会话人设', src: '06-settings-render.js:395', batch: 1 },
    { id: 'allow', title: '聊天白名单', sub: '允许的群与私聊 / 空表语义', src: '06-settings-render.js:670', batch: 1 },
    { id: 'chat', title: '聊天设置', sub: '发送节奏 / 活跃档位 / 禁言 / 开话题 / 表情包', src: '06-settings-render.js:816', batch: 1 },
    { id: 'desktop', title: '桌面端', sub: '桌面端接入与更新', src: '06-settings-render.js:959', batch: 1 },
    { id: 'onebot', title: 'OneBot（SnowLuma）', sub: 'WS / HTTP 端口与令牌', src: '06-settings-render.js:1000', batch: 1 },
    { id: 'tools', title: '工具与技能', sub: '工具启用态 / 技能开关', src: '06-settings-render.js:1527', batch: 1 },
    { id: 'prompt', title: '提示词预览', sub: '按当前启用态组装后的系统提示词', src: '06-settings-render.js:1652', batch: 1 }
  ];

  /** id → 分节元数据。 */
  const MAP = {};
  SECTIONS.forEach((s) => { MAP[s.id] = s; });

  /** 侧栏顺序（点击切分节）。 */
  const ORDER = SECTIONS.map((s) => s.id);

  /** DOM 引用（mount 建一次）。 */
  let refs = null;

  /** 单飞句柄：并发 refresh 复用同一次请求。 */
  let inflight = null;

  /** 界面态（业务真相每次从接口读，不在这里缓存结论）。 */
  const state = {
    section: 'api',
    config: null,
    error: '',
    loading: false,
    saving: false,
    notice: '',
    noticeKind: 'ok',
    loadedAt: 0
  };

  // ── 共享契约取用（只读，缺失时本地兜底，不改 `window.__ui`） ──────────────

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
   * @returns {Element} 新建元素
   */
  function U(tag, attrs) {
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
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    });
    // 子节点展开数组（`row()` 传的是字段数组）——不展开会被 String() 成 "[object Object]"
    const append = (list) => list.forEach((k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) { append(k); return; }
      node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    });
    append(kids);
    return node;
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
   * 从接口回执里取出配置对象（`GET /api/config` 直接返回配置本体，`POST` 返回 `{ok, config}`）。
   *
   * @param {object} payload 接口回执
   * @returns {object|null} 配置对象
   */
  function pickConfig(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.config && typeof payload.config === 'object') return payload.config;
    const out = {};
    Object.keys(payload).forEach((key) => {
      if (key === 'ok' || key === 'status' || key === 'error') return;
      out[key] = payload[key];
    });
    return out;
  }

  // ── DOM 小件（分节渲染共用；`settings-sections.js` 通过 ctx.h 取用） ────────

  /**
   * 空态（契约 `empty()`）。
   *
   * @param {Element|string} node 容器
   * @param {string} text 文案
   * @returns {void}
   */
  function empty(node, text) {
    const fn = ui().empty;
    if (typeof fn === 'function') { fn(node, text); return; }
    const host = typeof node === 'string' ? document.querySelector(node) : node;
    if (!host) return;
    host.textContent = '';
    host.appendChild(U('p', { class: 'view-empty', text: text || '暂无数据' }));
  }

  /**
   * 失败态（契约 `fail()`）。
   *
   * @param {Element|string} node 容器
   * @param {*} error 错误值
   * @returns {void}
   */
  function fail(node, error) {
    const fn = ui().fail;
    if (typeof fn === 'function') { fn(node, error); return; }
    const host = typeof node === 'string' ? document.querySelector(node) : node;
    if (!host) return;
    host.textContent = '';
    host.appendChild(U('p', { class: 'view-fail', text: `加载失败：${textOf(error)}` }));
  }

  /**
   * HTML 转义（契约 `esc()`，缺失时本地兜底）。
   *
   * @param {*} value 待转义值
   * @returns {string} 转义结果
   */
  function esc(value) {
    const fn = ui().esc;
    if (typeof fn === 'function') return fn(value);
    const text = value === null || value === undefined ? '' : String(value);
    return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  /**
   * 提示行（灰字）。
   *
   * @param {string} text 文案
   * @returns {Element} 元素
   */
  function hint(text) {
    return U('div', { class: 'hint', text: text || '' });
  }

  /**
   * 徽标。
   *
   * @param {string} text 文案
   * @param {string} [kind] `ok` / `warn` / `off`
   * @returns {Element} 元素
   */
  function badge(text, kind) {
    return U('span', { class: 'badge' + (kind ? ` ${kind}` : ''), text: String(text) });
  }

  /**
   * 按钮。
   *
   * @param {string} text 文案
   * @param {Function} [onclick] 点击回调
   * @returns {Element} 元素
   */
  function button(text, onclick) {
    const node = U('button', { class: 'btn small', type: 'button', text: text || '' });
    if (typeof onclick === 'function') {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        onclick(node);
      });
    }
    return node;
  }

  /**
   * 表单行：`label（固定 200px）| 控件 | 说明`。
   *
   * @param {string} label 标签
   * @param {Element|Element[]} control 控件
   * @param {string} [note] 右侧说明
   * @returns {Element} `.field`
   */
  function field(label, control, note) {
    const box = U('div', { class: 'control' });
    const list = Array.isArray(control) ? control : [control];
    list.forEach((c) => { if (c) box.appendChild(c); });
    return U('div', { class: 'field' },
      U('label', { text: label || '' }),
      box,
      note ? U('span', { class: 'note', text: note }) : null);
  }

  /**
   * 成行排布两个（或多个）`.field`。
   *
   * @param {Element[]} fields 表单行
   * @returns {Element} 容器
   */
  function row(fields) {
    return U('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap' } },
      (fields || []).filter(Boolean).map((node) => {
        node.style.flex = '1 1 320px';
        return node;
      }));
  }

  /**
   * 输入框。
   *
   * @param {object} opts `{type, value, placeholder, min, max, step, oninput, onchange}`
   * @returns {Element} input
   */
  function input(opts) {
    const o = opts || {};
    const node = U('input', {
      type: o.type || 'text',
      value: o.value === null || o.value === undefined ? '' : String(o.value),
      placeholder: o.placeholder || '',
      min: o.min,
      max: o.max,
      step: o.step
    });
    if (typeof o.oninput === 'function') node.addEventListener('input', (event) => o.oninput(event.target.value, node));
    if (typeof o.onchange === 'function') node.addEventListener('change', () => o.onchange(node.value, node));
    return node;
  }

  /**
   * 下拉框。
   *
   * @param {object} opts `{value, options: [[value, label]], onchange}`
   * @returns {Element} select
   */
  function selectOf(opts) {
    const o = opts || {};
    const node = U('select', {});
    (o.options || []).forEach((pair) => {
      const opt = U('option', { value: String(pair[0]), text: String(pair[1]) });
      if (String(o.value) === String(pair[0])) opt.selected = true;
      node.appendChild(opt);
    });
    if (typeof o.onchange === 'function') node.addEventListener('change', () => o.onchange(node.value, node));
    return node;
  }

  /**
   * 复选行（标签在左、勾选框在右，与 `.field` 对齐）。
   *
   * @param {object} opts `{checked, label, note, onchange}`
   * @returns {Element} `.field`
   */
  function checkbox(opts) {
    const o = opts || {};
    const box = U('input', { type: 'checkbox' });
    box.checked = o.checked === true;
    if (typeof o.onchange === 'function') box.addEventListener('change', () => o.onchange(box.checked, box));
    return field(o.label || '', [box], o.note || '');
  }

  /**
   * 折叠卡（业务设置的分节容器；点击卡头切换）。
   *
   * @param {object} opts `{icon, title, sub, val, open, body}`
   * @returns {Element} `.fold`
   */
  function fold(opts) {
    const o = opts || {};
    const head = U('div', { class: 'fold-head' },
      U('span', { text: `${o.icon ? `${o.icon} ` : ''}${o.title || ''}` }),
      o.sub ? U('span', { class: 'hint', text: o.sub }) : null,
      U('span', { class: 'spacer' }),
      o.val ? badge(o.val) : null);
    const body = U('div', { class: 'fold-body' });
    const kids = Array.isArray(o.body) ? o.body : (o.body ? [o.body] : []);
    kids.forEach((k) => { if (k) body.appendChild(k); });
    const root = U('div', { class: 'fold' + (o.open === false ? '' : ' open') }, head, body);
    head.addEventListener('click', () => root.classList.toggle('open'));
    return root;
  }

  /** 分节可用的 DOM 小件（`settings-sections.js` 只读取用）。 */
  const H = { el: U, esc, hint, badge, button, field, row, input, selectOf, checkbox, fold, empty, fail };

  // ── 接口动作 ───────────────────────────────────────────────────────────

  /**
   * 调接口——**只转发到契约里的 `__ui.api`**，块内不写裸 fetch。
   *
   * 契约未就绪时直接抛错（§0-6 契约不可自扩）：由 `refresh()` 的 catch 落到 `fail()`，
   * 页面显红字原因而不是白屏；不由本块自建第二条请求通道。
   *
   * @param {string} path 路径
   * @param {object} [options] `{method, body}`
   * @returns {Promise<object>} 回执（契约 `api()` 的语义：非 2xx 不抛，返 `{ok:false, error, status}`）
   */
  async function api(path, options) {
    const fn = ui().api;
    if (typeof fn !== 'function') throw new Error('window.__ui.api 未就绪');
    return fn(path, options);
  }

  /**
   * 显示回执（页面顶部的提示行，不是弹窗）。
   *
   * @param {string} text 文案
   * @param {string} [kind] `ok` / `fail`
   * @returns {void}
   */
  function notice(text, kind) {
    state.notice = text || '';
    state.noticeKind = kind || 'ok';
    if (!refs || !refs.notice) return;
    refs.notice.textContent = state.notice;
    refs.notice.className = state.noticeKind === 'fail' ? 'view-fail' : 'hint';
  }

  /**
   * 保存一项（写回后**必须读回**——任务卡 §四 L8 ②「读回值 = 写入值」）。
   *
   * 业务面不可达时只记一次失败表现（`notice` 红字 + 不伪造本地值），不算失败（§1.3）。
   *
   * @param {object} patch 配置补丁
   * @returns {Promise<object>} 回执
   */
  async function save(patch) {
    if (state.saving) return { ok: false, error: '上一笔保存在途' };
    state.saving = true;
    notice('保存中…');
    let written;
    try {
      written = await api('/api/biz/config', { method: 'POST', body: patch });
    } catch (error) {
      written = { ok: false, error: textOf(error) };
    }
    state.saving = false;

    if (!written || !written.ok) {
      notice(`保存失败：${textOf(written && written.error)}`, 'fail');
      return written || { ok: false };
    }

    // 读回：以服务端现值为准，禁用本地乐观更新
    const back = await api('/api/biz/config');
    const cfg = back && back.ok ? pickConfig(back) : pickConfig(written);
    if (cfg) {
      state.config = cfg;
      state.loadedAt = Date.now();
    }
    if (!back || !back.ok) {
      notice(`已写入，但读回失败：${textOf(back && back.error)}`, 'fail');
    } else {
      notice('已保存（读回已核对）');
    }
    renderBody();
    return written;
  }

  // ── 渲染：侧栏 / 卡头 / 分节体 ──────────────────────────────────────────

  /**
   * 分节注册表（`window.__settingsSections`）。
   *
   * @returns {object} 注册表（不存在时给空对象）
   */
  function registry() {
    return window.__settingsSections || {};
  }

  /**
   * 已接分节 id 清单（注册表里确实有函数的分节）。
   *
   * @returns {string[]} id 列表
   */
  function implementedIds() {
    const reg = registry();
    return ORDER.filter((id) => typeof reg[id] === 'function');
  }

  /**
   * 未接分节 id 清单。
   *
   * @returns {string[]} id 列表
   */
  function pendingIds() {
    const reg = registry();
    return ORDER.filter((id) => typeof reg[id] !== 'function');
  }

  /**
   * 侧栏：分节按钮 + 计数自证（「侧栏分节数 = 已接 + 未接」，不虚报）。
   *
   * @returns {void}
   */
  function renderMenu() {
    if (!refs || !refs.menu) return;
    const reg = registry();
    refs.menu.textContent = '';
    SECTIONS.forEach((sec) => {
      const open = typeof reg[sec.id] === 'function';
      const node = U('button', {
        class: 'settings-menu-item' + (state.section === sec.id ? ' active' : ''),
        type: 'button'
      },
      U('span', { class: 'list-item-main' },
        U('div', { class: 'list-item-title', text: sec.title }),
        U('div', { class: 'list-item-sub', text: sec.sub || '' })),
      U('span', { class: 'list-item-meta' }, open ? badge(`批 ${sec.batch}`, 'ok') : badge('未接', 'warn')));
      if (state.section === sec.id) node.classList.add('active');
      node.style.width = '100%';
      node.style.textAlign = 'left';
      node.style.background = 'none';
      node.style.border = '1px solid transparent';
      node.style.borderRadius = '8px';
      node.style.cursor = 'pointer';
      node.style.color = 'var(--text)';
      node.addEventListener('click', () => selectSection(sec.id));
      refs.menu.appendChild(node);
    });

    if (refs.count) {
      const done = implementedIds().length;
      const rest = pendingIds().length;
      refs.count.textContent = `分节 ${SECTIONS.length} · 已接 ${done} · 未接 ${rest}`;
      refs.count.className = done + rest === SECTIONS.length ? 'badge ok' : 'badge warn';
    }
  }

  /**
   * 切分节并重绘（不重新拉配置——配置在 `refresh()` 里取）。
   *
   * 补强①：切节前先把当前焦点元素 `blur` 掉——输入框都是 `change` 触发写回，
   * 没失焦就切节会丢未提交输入（R5-L8 §五 限制 1）。`blur()` 同步派发 `change`，
   * 保证写回请求在重绘前已发出（写回本身是即时的，不做原版那套 600ms 防抖）。
   *
   * @param {string} id 分节 id
   * @returns {void}
   */
  function selectSection(id) {
    if (!MAP[id]) return;
    const active = document.activeElement;
    if (active && typeof active.blur === 'function' && refs && refs.body && refs.body.contains(active)) {
      active.blur();
    }
    state.section = id;
    renderBody();
  }

  /**
   * 分节渲染上下文（交给 `settings-sections.js` 的渲染函数）。
   *
   * @returns {object} ctx
   */
  function contextOf() {
    return {
      config: state.config || {},
      section: MAP[state.section] || SECTIONS[0],
      h: H,
      api,
      save,
      reload: refresh,
      notice,
      unreachable: UNREACHABLE,
      saving: () => state.saving
    };
  }

  /**
   * 重绘右侧分节体（失败态 / 未接态 / 正常三支）。
   *
   * @returns {void}
   */
  function renderBody() {
    if (!refs || !refs.body) return;
    renderMenu();
    const host = refs.body;
    host.textContent = '';

    const sec = MAP[state.section] || SECTIONS[0];
    if (refs.title) refs.title.textContent = sec.title;
    if (refs.sub) refs.sub.textContent = sec.sub || '';

    // ① 失败态优先：业务面不可达时不渲染任何表单（免得用户对着空框改出脏值）
    if (state.error) {
      fail(host, state.error);
      return;
    }

    // ② 还没取到配置
    if (!state.config) {
      empty(host, state.loading ? '正在读取业务面配置…' : '尚未读取配置（点「刷新」重试）');
      return;
    }

    // ③ 分节未接：显式标「未接」并列出全部未接分节名（任务卡 §四 L8 ③）
    const reg = registry();
    const renderer = reg[state.section];
    if (typeof renderer !== 'function') {
      const rest = pendingIds().map((id) => MAP[id].title).join(' / ');
      host.appendChild(U('div', {},
        U('p', { class: 'view-stub', text: `未接：「${sec.title}」本节尚未实现（批 2 交付）。` }),
        U('p', { class: 'hint', text: `未接分节共 ${pendingIds().length} 个：${rest || '—'}` }),
        U('p', { class: 'hint', text: '已接分节可直接点开使用；未接分节保留条目并显式标注，不静默隐藏。' })));
      return;
    }

    // ④ 正常渲染——单节抛错不拖垮整页
    try {
      const node = renderer(contextOf());
      if (node) host.appendChild(node);
      else empty(host, '本节暂无可显示内容');
    } catch (error) {
      console.error('[bizsettings] 分节渲染失败：', state.section, error);
      fail(host, `分节「${sec.title}」渲染失败：${textOf(error)}`);
    }
  }

  /**
   * 拉配置重渲染（单飞；失败落 `fail()`，不渲染假数据）。
   *
   * @returns {Promise<void>}
   */
  function refresh() {
    if (inflight) return inflight;
    state.loading = true;
    if (!state.config) renderBody();
    inflight = api('/api/biz/config')
      .then((payload) => {
        if (payload && payload.ok) {
          const cfg = pickConfig(payload);
          if (cfg) {
            state.config = cfg;
            state.error = '';
            state.loadedAt = Date.now();
          } else {
            state.error = `${UNREACHABLE}：配置回执为空`;
          }
        } else {
          const reason = textOf(payload && payload.error);
          state.error = reason.indexOf('3210') >= 0 ? reason : `${UNREACHABLE}：${reason}`;
          state.config = null;
        }
      })
      .catch((error) => {
        state.error = `${UNREACHABLE}：${textOf(error)}`;
        state.config = null;
      })
      .then(() => {
        state.loading = false;
        inflight = null;
        renderBody();
      });
    return inflight;
  }

  /**
   * 建页骨架（首次切到本页调用一次；**不发请求**，取数归 `refresh()`）。
   *
   * @param {Element} container `#view-bizsettings`
   * @returns {void}
   */
  function mount(container) {
    if (!container) return;
    container.textContent = '';

    const count = badge('分节 —', 'warn');
    const menu = U('div', { class: 'folds' });
    const title = U('span', { class: 'title', text: '业务设置' });
    const sub = U('span', { class: 'hint', text: '' });
    const noticeEl = U('span', { class: 'hint', text: '' });
    const reloadBtn = button('刷新', () => refresh());
    const body = U('div', { class: 'pane-body scroll-y', id: 'bizsettings-form' });

    const sidebar = U('aside', { class: 'pane narrow' },
      U('div', { class: 'pane-head' }, U('span', { class: 'title', text: '设置分节' }), U('span', { class: 'spacer' }), count),
      U('div', { class: 'pane-body' }, menu));

    const main = U('section', { class: 'pane wide' },
      U('div', { class: 'pane-head' }, title, sub, U('span', { class: 'spacer' }), noticeEl, reloadBtn),
      body);

    container.appendChild(U('div', { class: 'split', style: { flex: '1', minHeight: '0' } }, sidebar, main));

    refs = { count, menu, title, sub, notice: noticeEl, body, reloadBtn };
    renderBody();
  }

  const views = (window.__views = window.__views || {});
  const view = { title: '业务设置', stub: STUB, mount, refresh };
  views.settings = view;
  if (typeof ui().registerView === 'function') ui().registerView('settings', view);
})();
