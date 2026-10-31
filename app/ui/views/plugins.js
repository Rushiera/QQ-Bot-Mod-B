// app/ui/views/plugins.js —— 插件页视图块（R5-L7）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L7**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不直接发网络请求，一律走 `__ui.api`）
//
// 数据源（全部经 `/api/biz/*` 代理，§3.2）：
//   · `GET /api/biz/skills` → `{skills:[{id,name,version,kind,dir,loaded,enabled,active,active,
//     reason,loadError,description,implementedCapabilities,hooks,toolIds,hasSettings,source,...}],
//     summary, capabilities, uninstalled}`
//     本页只取 `kind === 'plugin'` 的那些——`kind === null` 的条目归技能页（与业务面
//     `skills/manager.js:251` 的语义、原版 `06-settings-render.js:1316` 的归属规则一致）。
//   · `GET /api/biz/tools` → `{tools:[{id,skillId,...}]}`，按 `skillId` 归并成「该模块注册的工具数」。
//
// 写面口径（R5 §1.3）：整卡开关属**指令类面**——形态照搬原版（`POST /api/skills/<id> {enabled}`，
// 业务面 `routes.js:994`），本轮只验「控件在、标签对、不报 JS 错」，请求通不通不作为验收判据；
// 自测期间不实调写类端点（§2.3）。
//
// 渲染口径：① 列表条目数 = 数据源 `kind === 'plugin'` 项数（不截断，pane 头写明对账数字）
//          ② 空态写清真实状态（`app/plugins` 目录不存在 / 为空），不用「暂无插件」掩盖
//          ③ 失败态走 `fail()` 并带 3210；不渲染假数据、不弹窗。

(function () {
  'use strict';

  /**
   * 插件目录（`app/src/business/plugin-loader.js:40-42`：`APP_ROOT = <本文件目录>/..` = `app/src`，
   * `PLUGINS_DIR = APP_ROOT/plugins` → `app/src/plugins`）——该目录当前不存在，空态里写清这个真实落点。
   */
  const DIR = 'app/src/plugins';

  /** 页标题（原版 `MODULE_KINDS.plugin.title`）。 */
  const TITLE = '插件（Plugin）';

  /** 原版 lead 文案（`_unpack/resources/app/ui/app/06-settings-render.js:1272-1274`，插件段）。 */
  const LEAD = '插件是确定性型扩展：提供能力（providers）或钩子（hooks），由核心代码按能力名确定性调用'
    + ' —— 条件满足就一定会执行，不经过模型，模型想忽略也忽略不掉。'
    + '代价是它不能「看情况发挥」：什么时候触发必须在代码里写死。需要模型理解意图的功能，做成技能（见「技能」页签）。';

  /**
   * 写面判定（侦察结论，写进页面，避免把「本轮没验链路」误读成「这按钮没用」）。
   *
   * 业务面**有**对应写端点：`app/src/business/routes.js:994` 的 `POST /api/skills/<id>`（体 `{enabled}`），
   * 所以本页不是只读页——整卡开关照原版接这条端点，不自造新端点。
   */
  const WRITE_NOTE = '写面：已开 —— 整卡开关走 `POST /api/biz/skills/<id>`（业务面 `routes.js:994`，体 `{enabled}`），'
    + '原版同源。R5 本轮只验形态与取数，写链路是否真的生效另行排查（任务卡 §1.3）。';

  // ── 状态 ────────────────────────────────────────────────────────────────

  /** 列表挂载点（`.pane-body`）。 */
  let listBox = null;
  /** pane 头右侧的统计位。 */
  let headStat = null;
  /** 操作提示行（切换结果 / 失败原因）。 */
  let notice = null;
  /** 搜索框（跨重绘保留输入值）。 */
  let searchInput = null;

  /** 当前页该管的条目（`kind === 'plugin'`）。 */
  let items = [];
  /** 业务面返回的全部扩展条目数（技能 + 插件；用于空态对账）。 */
  let allTotal = 0;
  /** 模块 id → 该模块注册的工具数。 */
  let toolCount = new Map();

  /** 并发单飞（契约 §3.2：refresh 可被反复调用）。 */
  let inflight = null;

  // ── 小工具 ──────────────────────────────────────────────────────────────

  /**
   * 数组兜底（接口字段缺失时退化为空数组，不抛）。
   *
   * @param {*} value 任意值
   * @returns {Array} 数组
   */
  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  /**
   * 该条目当前是否真正生效（业务面判定为准，前端不自己推断能力）。
   *
   * @param {object} item `/api/skills` 的单条状态
   * @returns {boolean} 是否生效中
   */
  function isActive(item) {
    return !!item && item.loaded !== false && item.enabled === true && item.active === true;
  }

  /**
   * 建一个徽标。
   *
   * @param {string} text 文案
   * @param {string} [tone] 修饰（`ok` / `warn` / `off`；空 = 中性）
   * @returns {Element} 徽标元素
   */
  function badge(text, tone) {
    return window.__ui.el('span', { class: tone ? `badge ${tone}` : 'badge', text: text });
  }

  /**
   * 写操作提示行。
   *
   * @param {string} text 文案（空 = 清空）
   * @returns {void}
   */
  function setNotice(text) {
    if (notice) notice.textContent = text || '';
  }

  /**
   * 失败文案补齐「谁不可达」——代理层的 502 已带 3210，其它路径补上。
   *
   * @param {*} raw 错误值
   * @returns {string} 可读文案
   */
  function failText(raw) {
    const text = raw === null || raw === undefined || raw === '' ? '业务面不可达' : String(raw);
    return text.indexOf('3210') >= 0 ? text : `${text}（业务面 127.0.0.1:3210）`;
  }

  /**
   * 空态文案——必须写清真实状态（目录不存在 / 为空 / 全是技能）。
   *
   * @returns {string} 文案
   */
  function emptyText() {
    if (allTotal > 0) {
      return `${DIR} 目录当前没有可加载的插件模块——目录不存在或为空。`
        + `业务面共返回 ${allTotal} 条扩展，全部不是插件（kind=plugin 0 条）。`
        + '业务面启动日志里的 [plugin] 行会写明是「目录不存在，已跳过」还是「plugins/ 为空」。';
    }
    return `${DIR} 目录当前没有可加载的插件模块——目录不存在或为空。`
      + '业务面当前没有任何扩展条目（技能与插件两个目录都为空或不存在）。'
      + '业务面启动日志里的 [plugin] 行会写明是哪一种。';
  }

  /**
   * 更新 pane 头统计（生效数 / 总数 / 过滤后条数 / 业务面全量扩展数）。
   *
   * @param {number} [shown] 当前显示条数（省略 = 不过滤）
   * @returns {void}
   */
  function updateStat(shown) {
    if (!headStat) return;
    const total = items.length;
    const active = items.filter(isActive).length;
    const parts = [`${active} / ${total} 生效`, `共 ${total} 条插件`];
    if (typeof shown === 'number' && shown !== total) parts.push(`当前显示 ${shown} 条`);
    if (allTotal > total) parts.push(`业务面扩展 ${allTotal} 条（插件 ${total}）`);
    headStat.textContent = parts.join(' · ');
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  /**
   * 单张插件卡片。
   *
   * 状态一律取业务面判定（`loaded` / `enabled` / `active` / `reason` / `loadError`），
   * 前端不推断「能不能用」——否则会出现「界面说能用、实际不生效」的两套口径。
   *
   * @param {object} item `/api/skills` 的单条状态
   * @returns {Element} 卡片元素
   */
  function card(item) {
    const U = window.__ui;
    const loaded = item.loaded !== false;
    const enabled = item.enabled === true;
    const active = isActive(item);
    const toolN = toolCount.get(item.id) || 0;

    const stateBadge = !loaded
      ? badge('加载失败', 'warn')
      : (!enabled ? badge('已关闭', 'off') : (active ? badge('生效中', 'ok') : badge('依赖未就绪', 'warn')));

    const titleRow = U.el('div', { class: 'list-item-title' },
      U.el('span', { text: item.name || item.id }),
      ' ',
      U.el('span', { class: 'muted', text: `v${item.version || '?'}` }),
      ' ',
      stateBadge,
      item.hasSettings ? [' ', badge('可设置', '')] : null,
      item.source === 'plugin' ? [' ', badge('plugin.json', '')] : null
    );

    const meta = [];
    meta.push(item.dir || DIR);
    meta.push(item.source === 'plugin' ? '清单：plugin.json' : '清单：skill.json');
    if (toolN) meta.push(`注册工具 ${toolN} 个`);
    const caps = arr(item.implementedCapabilities);
    if (caps.length) meta.push(`能力：${caps.join('、')}`);
    const hooks = arr(item.hooks);
    if (hooks.length) meta.push(`钩子：${hooks.join('、')}`);

    // 无法真正生效时把原因写在卡片上（不藏在 title 提示里）
    let errLine = '';
    if (!loaded) errLine = String(item.loadError || item.lastError || '加载失败，原因未知');
    else if (enabled && !active) errLine = String(item.reason || '依赖未就绪');

    const haystack = [item.id, item.name, item.description, item.dir]
      .concat(caps, hooks)
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    const main = U.el('div', { class: 'list-item-main' },
      titleRow,
      U.el('div', { class: 'list-item-sub', text: item.description || '（没有写介绍）' }),
      U.el('div', { class: 'list-item-sub', text: meta.join(' · ') }),
      errLine ? U.el('div', { class: 'list-item-sub', style: { color: '#f85149' }, text: errLine }) : null
    );

    const action = U.el('button', {
      class: 'btn small',
      text: enabled ? '关闭' : '开启',
      title: enabled ? '关闭后它提供的能力与钩子同时失效' : '开启后它提供的能力与钩子立即参与核心流程',
      onclick: (event) => {
        event.stopPropagation();
        toggle(item);
      }
    });

    const node = U.el('div', {
      class: 'list-item',
      role: 'button',
      tabindex: 0,
      dataset: { id: String(item.id || ''), search: haystack }
    }, main, U.el('div', { class: 'list-item-meta' }, action));

    // 整卡即开关（照原版 `bindModulePageEvents` 的交互口径）；加载失败的条目切不动
    const flip = () => {
      if (!loaded) return;
      toggle(item);
    };
    node.addEventListener('click', flip);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        flip();
      }
    });
    return node;
  }

  /**
   * 按搜索框本地过滤（不整页重绘，保留滚动位置）。
   *
   * @returns {void}
   */
  function applyFilter() {
    if (!listBox) return;
    const keyword = String((searchInput && searchInput.value) || '').trim().toLowerCase();
    const nodes = listBox.querySelectorAll('.list-item');
    let shown = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const hay = node.dataset.search || '';
      const hit = !keyword || hay.indexOf(keyword) >= 0;
      node.style.display = hit ? '' : 'none';
      if (hit) shown += 1;
    }
    updateStat(shown);
  }

  /**
   * 渲染成功态（列表 / 空态）。
   *
   * @returns {void}
   */
  function render() {
    if (!listBox) return;
    const U = window.__ui;
    listBox.textContent = '';
    setNotice('');

    if (!items.length) {
      U.empty(listBox, emptyText());
      updateStat(0);
      return;
    }

    for (const item of items) listBox.appendChild(card(item));
    applyFilter();
  }

  /**
   * 渲染失败态（业务面不可达 / 接口报错）。
   *
   * @param {*} error 错误值
   * @returns {void}
   */
  function renderFail(error) {
    if (!listBox) return;
    const U = window.__ui;
    listBox.textContent = '';
    items = [];
    allTotal = 0;
    U.fail(listBox, failText(error));
    if (headStat) headStat.textContent = '不可用';
    setNotice('');
  }

  // ── 交互 ────────────────────────────────────────────────────────────────

  /**
   * 切换插件启用态（写回后按接口读回值重绘，不做本地乐观更新）。
   *
   * @param {object} item 目标条目
   * @returns {Promise<void>}
   */
  async function toggle(item) {
    const U = window.__ui;
    if (!U || !item || !item.id || item.loaded === false) return;
    const next = item.enabled !== true;
    setNotice(`正在${next ? '开启' : '关闭'} ${item.id} …`);
    const r = await U.api(`/api/biz/skills/${encodeURIComponent(item.id)}`, {
      method: 'POST',
      body: { enabled: next }
    });
    if (!r || r.ok === false) {
      setNotice(`切换失败：${failText(r && r.error)}`);
      return;
    }
    await refresh();
    setNotice(`${next ? '已开启' : '已关闭'} ${item.id}（列表显示的是接口读回值）`);
  }

  // ── 契约两个必备函数 ────────────────────────────────────────────────────

  /**
   * 建视图骨架（首次切到本页调用一次；**不发请求**）。
   *
   * @param {Element} el 容器（`#view-plugins`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const U = window.__ui;
    if (!U) {
      el.appendChild(document.createTextNode('界面外壳未就绪（window.__ui 缺失）'));
      return;
    }

    searchInput = U.el('input', {
      type: 'search',
      placeholder: '搜索插件名称 / 简介 / 目录…',
      autocomplete: 'off',
      oninput: applyFilter
    });

    const bar = U.el('div', { class: 'toolbar' },
      U.el('h3', { text: TITLE, style: { margin: 0, fontSize: '14px', fontWeight: '600' } }),
      U.el('span', { class: 'spacer' }),
      searchInput,
      U.el('button', { class: 'btn small', text: '刷新', title: '重新读取业务面扩展状态', onclick: () => refresh() })
    );

    notice = U.el('p', { class: 'hint', text: '' });
    headStat = U.el('span', { class: 'muted', text: '加载中…' });
    listBox = U.el('div', { class: 'pane-body' });

    const pane = U.el('div', { class: 'pane', style: { flex: '1', minHeight: 0 } },
      U.el('div', { class: 'pane-head' },
        U.el('span', { class: 'title', text: '插件模块' }),
        U.el('span', { class: 'spacer' }),
        headStat
      ),
      listBox
    );

    el.appendChild(bar);
    el.appendChild(U.el('p', { class: 'hint', text: LEAD }));
    el.appendChild(U.el('p', { class: 'hint', text: WRITE_NOTE }));
    el.appendChild(notice);
    el.appendChild(pane);
  }

  /**
   * 拉数据重渲染（可反复调用；并发调用单飞）。
   *
   * @returns {Promise<void>} 完成信号
   */
  function refresh() {
    const U = window.__ui;
    if (!U || !listBox) return Promise.resolve();
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        setNotice('');
        const r = await U.api('/api/biz/skills');
        if (!r || r.ok === false) {
          renderFail(r && r.error);
          return;
        }
        const all = arr(r.skills);
        allTotal = all.length;
        items = all.filter((s) => s && s.kind === 'plugin');

        // 工具归属：只用于显示「该模块注册了几个工具」，取不到不影响列表
        toolCount = new Map();
        const t = await U.api('/api/biz/tools');
        if (t && t.ok !== false) {
          for (const tool of arr(t.tools)) {
            const owner = tool && tool.skillId;
            if (!owner) continue;
            toolCount.set(owner, (toolCount.get(owner) || 0) + 1);
          }
        }

        render();
      } catch (error) {
        renderFail(error && error.message ? error.message : error);
      }
    })().finally(() => { inflight = null; });

    return inflight;
  }

  // ── 自注册（契约 §三-2） ────────────────────────────────────────────────

  const views = (window.__views = window.__views || {});
  views.plugins = {
    title: '插件',
    /** 桩标记：本块已实现（L16 契约自测按此判「不是桩」）。 */
    stub: false,
    mount: mount,
    refresh: refresh
  };

})();
