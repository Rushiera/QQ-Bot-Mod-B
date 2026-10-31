// app/ui/views/skills.js —— 技能页视图块（R5-L6）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L6**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 数据源（全部经 L9 代理层，见任务卡 §3.2）：
//   `/api/biz/skills`              → { skills, summary, capabilities, uninstalled }
//   `/api/biz/skills/capabilities` → { capabilities: [{ name, available, reason, providers }] }
//   `/api/biz/tools`               → { tools: [{ id, name, description, category, skillId, ... }] }
//   `/api/biz/tools/availability`  → { categories, tools: [{ id, enabled, code, reason, skillId }] }
//   POST `/api/biz/skills/reload`  → { loaded, failed, pruned, skills, summary }
//   POST `/api/biz/skills/cleanup` → { removed, skipped, config }
//
// 🔴 本页的一条硬口径：技能列表为空**不是 bug**。业务面加载器
//   （`app/src/business/plugin-loader.js:41`）的 SKILLS_DIR = `<APP_ROOT>/skills`，
//   该目录当前不存在，扫描结果必然是 0 项。空列表时页面必须写明
//   「app/skills 不存在」，不得用「暂无技能」把它盖成一句闲话（B27 已拍保持空转，不建目录）。
//
// 本轮口径（任务卡 §1.3）：按钮 / 开关 / 表单属**指令类面**——形态照搬原版即可，
// 请求通不通不作为验收判据；列表渲染属**取数类面**，按条数判据验。

(function () {
  'use strict';

  /** 技能分类标签与顺序（与 `_unpack/.../06-settings-render.js:1341-1344` 同表）。 */
  const CAT_LABEL = { model: '模型', message: '消息', media: '媒体', knowledge: '知识', utility: '工具' };
  const CAT_ORDER = ['model', 'message', 'media', 'knowledge', 'utility'];

  /** 技能根目录名——前端仅用于**说明空列表原因**，不参与取数。 */
  const SKILLS_DIR = 'app/skills';

  /** 容器根（`#view-skills`）。 */
  let root = null;

  /** 单飞句柄：并发 refresh 复用同一次请求。 */
  let inflight = null;

  /** 最近一次取数的结果快照。 */
  const st = {
    skills: [],
    summary: null,
    capabilities: [],
    capDetail: null,
    tools: [],
    avail: null,
    uninstalled: [],
    loadedAt: 0,
    reloadReceipt: '',
    skillsError: '',
    toolsError: '',
    availError: ''
  };

  // ── 共享契约取用（只读，缺失时自兜底，不改 `window.__ui`） ──────────────

  /**
   * HTML 转义（优先用外壳实现）。
   *
   * @param {*} s 任意值
   * @returns {string} 转义后的字符串
   */
  function esc(s) {
    const fn = window.__ui && window.__ui.esc;
    if (typeof fn === 'function') return fn(s);
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  /**
   * 千分位（优先用外壳实现）。
   *
   * @param {*} n 数字
   * @returns {string} 格式化结果
   */
  function fmtNum(n) {
    const fn = window.__ui && window.__ui.fmtNum;
    if (typeof fn === 'function') return fn(n);
    return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '-';
  }

  /**
   * 在容器内取元素（元素缺失时返 null，不抛）。
   *
   * @param {string} sel CSS 选择器
   * @returns {Element|null} 命中的元素
   */
  function pick(sel) {
    return root ? root.querySelector(sel) : null;
  }

  /**
   * 设置某元素的文本。
   *
   * @param {string} sel 选择器
   * @param {string} text 文本
   * @returns {void}
   */
  function setText(sel, text) {
    const node = pick(sel);
    if (node) node.textContent = text;
  }

  /**
   * 渲染空态（优先用外壳 `empty`）。
   *
   * @param {Element|null} box 容器
   * @param {string} text 提示文本
   * @returns {void}
   */
  function emptyBox(box, text) {
    if (!box) return;
    const fn = window.__ui && window.__ui.empty;
    if (typeof fn === 'function') { fn(box, text); return; }
    box.innerHTML = `<p class="hint">${esc(text)}</p>`;
  }

  /**
   * 渲染失败态（优先用外壳 `fail`；不弹窗、不伪造数据）。
   *
   * @param {Element|null} box 容器
   * @param {string} error 原因
   * @returns {void}
   */
  function failBox(box, error) {
    if (!box) return;
    const fn = window.__ui && window.__ui.fail;
    if (typeof fn === 'function') { fn(box, error); return; }
    box.innerHTML = `<p class="hint" style="color:var(--warn)">${esc(error)}</p>`;
  }

  // ── 骨架 ────────────────────────────────────────────────────────────────

  /**
   * 建视图骨架（首次切到本页调用一次，**不发请求**）。
   *
   * @param {Element} el 容器（`#view-skills`）
   * @returns {void}
   */
  function mount(el) {
    if (!el) return;
    root = el;
    if (el.dataset.mounted === '1') return;
    el.dataset.mounted = '1';
    el.innerHTML = [
      '<div style="display:flex;flex-direction:column;gap:14px;min-height:0">',
      '  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">',
      '    <h2 style="margin:0;font-size:16px;font-weight:600">技能（Skill）</h2>',
      '    <span id="skills-count" class="hint">-</span>',
      '    <span style="flex:1"></span>',
      '    <input id="skills-search" type="search" placeholder="搜索技能名称 / 简介…" autocomplete="off"',
      '      style="width:240px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--text);padding:6px 10px;font-size:13px" />',
      '    <button id="skills-refresh" class="btn small" data-act="refresh">刷新</button>',
      '    <button id="skills-reload" class="btn small" data-act="reload" title="重扫磁盘（POST /api/skills/reload）">重载</button>',
      '  </div>',
      '  <div class="hint" id="skills-hint">',
      '    技能是 <b>LLM 型</b>扩展：它注册工具进模型的 function 列表，<b>用不用由模型自己判断</b>，',
      '    所以不会「条件满足必然生效」。需要「必跑」的功能应做成插件（见「插件」页签）。',
      '  </div>',
      '  <div id="skills-receipt"></div>',
      '  <div id="skills-list"></div>',
      '  <div id="skills-uninstalled"></div>',
      '  <div id="skills-caps"></div>',
      '  <div id="skills-tools"></div>',
      '</div>'
    ].join('\n');
    bind();
  }

  /**
   * 绑定页内事件（事件委托，只绑一次）。
   *
   * @returns {void}
   */
  function bind() {
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (btn && root.contains(btn)) {
        const act = btn.dataset.act || '';
        if (act === 'reload') { onReload(btn); return; }
        if (act === 'refresh') { refresh(); return; }
        if (act === 'settings') {
          // 设置弹窗属原版的市场/表单族，本轮不搬（任务卡 §1.2）；按钮保留以对齐形态。
          receipt(`设置面本轮未接：技能 ${btn.dataset.id} 的 configSchema 表单不在 R5 实现范围（指令类面仅照搬形态）。`);
          return;
        }
        if (act === 'cleanup') { onCleanup(btn); return; }
        return;   // 其它按钮不穿透到卡片开关
      }
      // 卡片本体即开关（对齐原版「整卡即开关」的交互口径）
      const card = ev.target.closest('[data-card]');
      if (card && root.contains(card)) onToggle(card.dataset.card, card);
    });
    const search = pick('#skills-search');
    if (search) search.addEventListener('input', applyFilter);
  }

  // ── 取数 ────────────────────────────────────────────────────────────────

  /**
   * 拉数据重渲染（并发单飞）。
   *
   * @returns {Promise<void>} 无返回值
   */
  function refresh() {
    if (inflight) return inflight;
    inflight = doRefresh().catch((error) => {
      failBox(pick('#skills-list'), `技能页取数异常：${String((error && error.message) || error)}`);
    }).then(() => { inflight = null; });
    return inflight;
  }

  /**
   * 实际取数与渲染。
   *
   * @returns {Promise<void>} 无返回值
   */
  async function doRefresh() {
    const api = window.__ui && window.__ui.api;
    if (typeof api !== 'function') {
      failBox(pick('#skills-list'), '外壳未就绪：window.__ui.api 未安装（L1 收线后可用）');
      return;
    }
    setText('#skills-hint', '加载中…');

    const safe = (p, opts) => Promise.resolve()
      .then(() => api(p, opts))
      .catch((error) => ({ ok: false, error: String((error && error.message) || error) }));

    const [rSkills, rTools, rAvail, rCaps] = await Promise.all([
      safe('/api/biz/skills'),
      safe('/api/biz/tools'),
      safe('/api/biz/tools/availability'),
      safe('/api/biz/skills/capabilities')
    ]);

    // ① 技能主表（本页存在的前提；失败即整页失败态）
    if (rSkills && rSkills.ok) {
      st.skillsError = '';
      st.skills = Array.isArray(rSkills.skills) ? rSkills.skills : [];
      st.summary = rSkills.summary || null;
      st.capabilities = Array.isArray(rSkills.capabilities) ? rSkills.capabilities : [];
      st.uninstalled = Array.isArray(rSkills.uninstalled) ? rSkills.uninstalled : [];
    } else {
      st.skillsError = String((rSkills && (rSkills.error || rSkills.status)) || '业务面不可达（127.0.0.1:3210）');
      st.skills = [];
      st.summary = null;
      st.capabilities = [];
      st.uninstalled = [];
    }

    // ② 工具全集（取数类：条数即判据，不截断、不按可用性过滤）
    if (rTools && rTools.ok) {
      st.toolsError = '';
      st.tools = Array.isArray(rTools.tools) ? rTools.tools : [];
    } else {
      st.toolsError = String((rTools && (rTools.error || rTools.status)) || '工具清单取数失败');
      st.tools = [];
    }

    // ③ 工具可用性（补充原因，失败不拖垮工具清单）
    if (rAvail && rAvail.ok) {
      st.availError = '';
      st.avail = rAvail;
    } else {
      st.availError = String((rAvail && (rAvail.error || rAvail.status)) || '可用性取数失败');
      st.avail = null;
    }

    // ④ 能力详表（失败时回落主表里的能力名清单）
    st.capDetail = (rCaps && rCaps.ok && Array.isArray(rCaps.capabilities)) ? rCaps.capabilities : null;

    st.loadedAt = Date.now();

    renderAll();
  }

  /**
   * 渲染全部区块。
   *
   * @returns {void}
   */
  function renderAll() {
    renderSkills();
    renderUninstalled();
    renderCaps();
    renderTools();
    renderReceipt();
    const hint = pick('#skills-hint');
    if (hint && st.loadedAt) {
      const t = new Date(st.loadedAt);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      hint.textContent = `技能是 LLM 型扩展：注册工具进模型 function 列表，用不用由模型判断。最近取数 ${hh}:${mm}。`;
    }
    applyFilter();
  }

  // ── 渲染：技能列表 ──────────────────────────────────────────────────────

  /**
   * 渲染技能分组卡片。
   *
   * @returns {void}
   */
  function renderSkills() {
    const box = pick('#skills-list');
    if (!box) return;

    if (st.skillsError) {
      setText('#skills-count', '取数失败');
      // 文案去重：代理层已经把「业务面不可达（127.0.0.1:3210）」写进 error，不叠加第二遍。
      const reason = st.skillsError.indexOf('3210') >= 0
        ? st.skillsError
        : `业务面不可达（127.0.0.1:3210）：${st.skillsError}`;
      failBox(box, reason);
      return;
    }

    const total = st.skills.length;
    const sum = st.summary || {};
    setText('#skills-count', total ? `${fmtNum(sum.active || 0)} / ${fmtNum(total)} 生效` : '0 项');

    if (!total) {
      // 🔴 空列表 = 真实状态（技能目录未创建），不是「暂无技能」。
      box.innerHTML = [
        '<div class="card" style="min-width:0">',
        '  <h3>技能目录为空</h3>',
        `  <p><b>${esc(SKILLS_DIR)} 不存在</b>——业务面加载器的技能根目录是 <code class="mono">app/skills</code>，`,
        '     该目录当前未创建，扫描结果必然为 0 项。<b>这是真实状态，不是加载失败</b>。</p>',
        '  <p class="hint">B27 已拍「保持空转」：本轮不创建该目录。放入 <code class="mono">skills/&lt;id&gt;/</code>',
        '     （含 <code class="mono">skill.json</code> + <code class="mono">index.js</code>）后点「重载」即可出现。</p>',
        '</div>'
      ].join('');
      return;
    }

    const byCat = new Map();
    for (const s of st.skills) {
      const c = CAT_ORDER.indexOf(s.category) >= 0 ? s.category : 'utility';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(s);
    }

    const html = CAT_ORDER.filter((c) => byCat.has(c)).map((c) => {
      const list = byCat.get(c);
      return `<section data-skill-section="${esc(c)}">
        <h3 style="margin:16px 0 8px;font-size:14px;font-weight:600">${esc(CAT_LABEL[c])}（${list.length}）</h3>
        <div class="cards">${list.map(cardHtml).join('')}</div>
      </section>`;
    }).join('');
    box.innerHTML = `<div>${html}</div>`;
  }

  /**
   * 单张技能卡片的 HTML。
   *
   * @param {object} s 技能状态（`/api/skills` 的 skills 项）
   * @returns {string} 卡片 HTML
   */
  function cardHtml(s) {
    const loaded = Boolean(s.loaded);
    const enabled = Boolean(s.enabled);
    const active = Boolean(s.active);
    const color = !loaded ? 'var(--warn)' : (!enabled ? 'var(--off)' : (active ? 'var(--ok)' : 'var(--accent)'));
    const badge = !loaded ? '加载失败' : (!enabled ? '已关闭' : (active ? '生效中' : '已启用 · 依赖未就绪'));

    let errLine = '';
    if (!loaded) {
      errLine = String(s.loadError || '加载失败，原因未知').slice(0, 200);
    } else if (enabled && !active) {
      const miss = (s.missingRequires || []).map((r) => `缺少能力：${r}`).join('、');
      errLine = String(s.reason || miss || '依赖未就绪').slice(0, 200);
    }

    const tools = (s.toolIds || []).map((id) => `<code class="mono">${esc(id)}</code>`).join(' ');
    const meta = [
      s.dir ? `目录 ${s.dir}` : '',
      s.kind ? `类型 ${s.kind}` : (s.kind == null ? '类型 未识别' : ''),
      (s.hooks || []).length ? `钩子 ${s.hooks.join('、')}` : '',
      (s.capabilities || []).length ? `声明能力 ${s.capabilities.join('、')}` : ''
    ].filter(Boolean).join(' · ');

    const hay = [s.id, s.name, s.description, s.dir].filter(Boolean).join(' ').toLowerCase();
    const gear = s.hasSettings
      ? `<button class="btn small" data-act="settings" data-id="${esc(s.id)}" title="设置（本轮未接弹窗）">⚙</button>`
      : '';

    return `<div class="card" data-card="${esc(s.id)}" data-search="${esc(hay)}"
      style="min-width:260px;flex:1 1 280px;border-left:3px solid ${color};cursor:pointer"
      title="${esc(loaded ? (enabled ? '点击关闭' : '点击开启') : '加载失败的条目切不动')}">
      <div style="display:flex;align-items:center;gap:8px">
        <b style="color:var(--text)">${esc(s.name || s.id)}</b>
        <span class="hint">v${esc(s.version || '-')}</span>
        <span style="flex:1"></span>
        <span class="hint" style="color:${color}">${esc(badge)}</span>
        ${gear}
      </div>
      ${tools ? `<div style="margin:6px 0 0">${tools}</div>` : ''}
      <div class="hint" style="margin-top:6px">${esc(s.description || '（没有写介绍）')}</div>
      ${errLine ? `<div class="hint" style="margin-top:6px;color:var(--warn)">${esc(errLine)}</div>` : ''}
      ${meta ? `<div class="hint" style="margin-top:6px">${esc(meta)}</div>` : ''}
    </div>`;
  }

  // ── 渲染：残留配置 ──────────────────────────────────────────────────────

  /**
   * 渲染「已配置但未安装」的残留条目。
   *
   * @returns {void}
   */
  function renderUninstalled() {
    const box = pick('#skills-uninstalled');
    if (!box) return;
    if (!st.uninstalled.length) { box.innerHTML = ''; return; }
    const chips = st.uninstalled.map((u) => (
      `<span class="mono" style="border:1px solid var(--line);border-radius:6px;padding:2px 8px;margin-right:6px">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`
    )).join('');
    box.innerHTML = `<div class="card" style="min-width:0">
      <h3>已配置但未安装（${st.uninstalled.length}）</h3>
      <div class="hint" style="margin-bottom:8px">配置里还留着这些条目的开关/设置，但 <code class="mono">skills/</code> 目录里已无对应文件夹。</div>
      <div style="margin-bottom:10px">${chips}</div>
      <button class="btn small" data-act="cleanup">清理这些残留配置</button>
    </div>`;
  }

  // ── 渲染：能力清单 ──────────────────────────────────────────────────────

  /**
   * 渲染能力清单（有详表用详表，否则回落主表能力名）。
   *
   * @returns {void}
   */
  function renderCaps() {
    const box = pick('#skills-caps');
    if (!box) return;
    const detail = st.capDetail;
    const names = st.capabilities;

    if (detail && detail.length) {
      const rows = detail.map((c) => {
        const ok = Boolean(c.available);
        const prov = (c.providers || []).map((p) => (
          `${esc(p.skillId)}${p.active ? '' : '（未生效）'}${p.implemented ? '' : '（声明未实现）'}`
        )).join('、');
        return `<tr>
          <td style="padding:4px 8px;border-bottom:1px solid var(--line)"><code class="mono">${esc(c.name)}</code></td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--line);color:${ok ? 'var(--ok)' : 'var(--warn)'}">${ok ? '可用' : '不可用'}</td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--line)" class="hint">${esc(prov || '-')}</td>
          <td style="padding:4px 8px;border-bottom:1px solid var(--line)" class="hint">${esc(c.reason || '')}</td>
        </tr>`;
      }).join('');
      box.innerHTML = `<div class="card" style="min-width:0">
        <h3>能力清单（${detail.length}）</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
          <thead><tr class="hint">
            <th style="text-align:left;padding:4px 8px">能力名</th>
            <th style="text-align:left;padding:4px 8px">状态</th>
            <th style="text-align:left;padding:4px 8px">提供者</th>
            <th style="text-align:left;padding:4px 8px">原因</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
      return;
    }

    if (names && names.length) {
      box.innerHTML = `<div class="card" style="min-width:0">
        <h3>能力清单（${names.length}）</h3>
        <div class="hint" style="margin:6px 0">能力详表不可用，以下为技能主表声明的能力名。</div>
        <div>${names.map((n) => `<code class="mono" style="margin-right:8px">${esc(n)}</code>`).join('')}</div>
      </div>`;
      return;
    }

    box.innerHTML = `<div class="card" style="min-width:0">
      <h3>能力清单（0）</h3>
      <div class="hint" style="margin-top:6px">当前没有任何技能声明能力——技能目录为空时这是预期结果（见上方「技能目录为空」）。</div>
    </div>`;
  }

  // ── 渲染：工具清单 ──────────────────────────────────────────────────────

  /**
   * 渲染工具清单（全集照 `/api/tools` 逐条出，不按可用性过滤）。
   *
   * @returns {void}
   */
  function renderTools() {
    const box = pick('#skills-tools');
    if (!box) return;

    if (st.toolsError) {
      failBox(box, `工具清单取数失败：${st.toolsError}`);
      return;
    }
    if (!st.tools.length) {
      emptyBox(box, '工具清单为空（业务面 GET /api/tools 返回 0 项）');
      return;
    }

    const availMap = new Map();
    for (const a of ((st.avail && st.avail.tools) || [])) availMap.set(a.id, a);
    const catMeta = (st.avail && st.avail.categories) || {};

    const rows = st.tools.map((t) => {
      const a = availMap.get(t.id);
      const ok = a ? Boolean(a.enabled) : null;
      const stateText = ok === null ? '未知（可用性不可达）' : (ok ? '可用' : '不可用');
      const stateColor = ok === null ? 'var(--muted)' : (ok ? 'var(--ok)' : 'var(--warn)');
      const cat = catMeta[t.category] && catMeta[t.category].name ? catMeta[t.category].name : (t.category || '-');
      const src = t.skillId ? `技能 ${esc(t.skillId)}` : '内置';
      return `<tr data-tool="${esc(t.id)}">
        <td style="padding:4px 8px;border-bottom:1px solid var(--line)"><code class="mono">${esc(t.id)}</code><div class="hint">${esc(t.name || '')}</div></td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--line)" class="hint">${esc(cat)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--line)" class="hint">${src}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--line);color:${stateColor}">${esc(stateText)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--line)" class="hint">${esc((a && (a.reason || a.code)) || '')}</td>
      </tr>`;
    }).join('');

    const availNote = st.availError
      ? `<div class="hint" style="margin:6px 0;color:var(--warn)">可用性取数失败（${esc(st.availError)}）——下表状态列按「未知」显示，条目数不受影响。</div>`
      : '';

    box.innerHTML = `<div class="card" style="min-width:0">
      <h3>工具清单（${fmtNum(st.tools.length)} 项）</h3>
      ${availNote}
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
        <thead><tr class="hint">
          <th style="text-align:left;padding:4px 8px">工具</th>
          <th style="text-align:left;padding:4px 8px">分类</th>
          <th style="text-align:left;padding:4px 8px">来源</th>
          <th style="text-align:left;padding:4px 8px">状态</th>
          <th style="text-align:left;padding:4px 8px">原因</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // ── 渲染：指令回执 ──────────────────────────────────────────────────────

  /**
   * 渲染重载 / 清理的回执文本。
   *
   * @returns {void}
   */
  function renderReceipt() {
    const box = pick('#skills-receipt');
    if (!box) return;
    if (!st.reloadReceipt) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="hint" style="border-left:3px solid var(--accent);padding:6px 10px;background:var(--panel)">${esc(st.reloadReceipt)}</div>`;
  }

  /**
   * 写一行回执到页内（等价于原版的 `alert` 之外的可观测出口）。
   *
   * @param {string} text 回执文本
   * @returns {void}
   */
  function receipt(text) {
    st.reloadReceipt = String(text || '');
    renderReceipt();
  }

  // ── 交互 ────────────────────────────────────────────────────────────────

  /**
   * 本地过滤（不重绘，保留开关状态与滚动位置）。
   *
   * @returns {void}
   */
  function applyFilter() {
    if (!root) return;
    const input = pick('#skills-search');
    const q = String((input && input.value) || '').trim().toLowerCase();
    const cards = root.querySelectorAll('[data-card]');
    for (const card of cards) {
      const hay = card.getAttribute('data-search') || '';
      card.style.display = (!q || hay.indexOf(q) >= 0) ? '' : 'none';
    }
    const secs = root.querySelectorAll('[data-skill-section]');
    for (const sec of secs) {
      const any = Array.from(sec.querySelectorAll('[data-card]')).some((c) => c.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    }
  }

  /**
   * 重载（重扫磁盘）。
   *
   * @param {Element|null} btn 触发按钮
   * @returns {Promise<void>} 无返回值
   */
  async function onReload(btn) {
    const api = window.__ui && window.__ui.api;
    if (typeof api !== 'function') { receipt('外壳未就绪：window.__ui.api 未安装'); return; }
    if (btn) btn.disabled = true;
    receipt('重载中：POST /api/biz/skills/reload …');
    try {
      const r = await api('/api/biz/skills/reload', { method: 'POST' });
      if (!r || !r.ok) {
        receipt(`重载失败：${(r && (r.error || r.status)) || '无响应'}`);
      } else {
        const loaded = Array.isArray(r.loaded) ? r.loaded.length : 0;
        const failed = Array.isArray(r.failed) ? r.failed.length : 0;
        const pruned = Array.isArray(r.pruned) ? r.pruned.length : (r.pruned || 0);
        receipt(`重载完成：加载 ${loaded} · 失败 ${failed} · 清理 ${pruned}`);
        await refresh();
      }
    } catch (error) {
      receipt(`重载异常：${String((error && error.message) || error)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 清理「已配置但未安装」的残留配置。
   *
   * @param {Element|null} btn 触发按钮
   * @returns {Promise<void>} 无返回值
   */
  async function onCleanup(btn) {
    const api = window.__ui && window.__ui.api;
    if (typeof api !== 'function') { receipt('外壳未就绪：window.__ui.api 未安装'); return; }
    const ids = st.uninstalled.map((u) => u.id);
    if (!ids.length) { receipt('没有可清理的条目'); return; }
    // 🔴 删配置是不可逆动作（AGENTS §一-2）：先确认，再发请求。
    if (typeof window.confirm === 'function' && !window.confirm(`清理 ${ids.length} 个未安装条目的配置？\n${ids.join('、')}`)) return;
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/biz/skills/cleanup', { method: 'POST', body: { ids } });
      if (!r || !r.ok) {
        receipt(`清理失败：${(r && (r.error || r.status)) || '无响应'}`);
      } else {
        receipt(`清理完成：移除 ${(r.removed || []).length} 项${(r.skipped || []).length ? ` · 跳过 ${r.skipped.length} 项（仍已安装）` : ''}`);
        await refresh();
      }
    } catch (error) {
      receipt(`清理异常：${String((error && error.message) || error)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 切换某个技能的启停（整卡即开关，对齐原版口径）。
   *
   * @param {string} id 技能 id
   * @param {Element|null} card 被点的卡片
   * @returns {Promise<void>} 无返回值
   */
  async function onToggle(id, card) {
    const api = window.__ui && window.__ui.api;
    const cur = st.skills.find((s) => s.id === id);
    if (!cur || !cur.loaded) return;
    if (typeof api !== 'function') { receipt('外壳未就绪：window.__ui.api 未安装'); return; }
    if (card) card.style.pointerEvents = 'none';
    try {
      const r = await api(`/api/biz/skills/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { enabled: !cur.enabled }
      });
      if (!r || !r.ok) {
        receipt(`切换失败：${(r && (r.error || r.status)) || '无响应'}`);
      } else {
        const next = (r.skill && r.skill.enabled) ? '开启' : '关闭';
        receipt(`已${next}：${id}`);
        await refresh();
        return;
      }
    } catch (error) {
      receipt(`切换异常：${String((error && error.message) || error)}`);
    } finally {
      if (card) card.style.pointerEvents = '';
    }
  }

  // ── 注册 ────────────────────────────────────────────────────────────────

  const view = { title: '技能', mount, refresh };
  const reg = window.__ui && window.__ui.registerView;
  if (typeof reg === 'function') {
    reg('skills', view);
  } else {
    const views = (window.__views = window.__views || {});
    views.skills = view;
  }
})();
