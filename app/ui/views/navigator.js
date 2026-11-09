// app/ui/views/navigator.js —— 领航员页（面板操作台 · v2 排版 2026-11-09）
//
// 定位：把「群里 @ 领航员能做的事」在面板上做一份等价的显式操作面，并把领航员状态**看全**——
//       状态带（开关 / 回消息群 / 空闲 / 订阅 / 生成在跑 / VIP / 接入模式）+ 主从两栏 + 通栏。
//
// 布局（v2 换版，Rushiera 2026-11-09「界面难看 / 排版重调 / 展示全一点」）：
//   · 状态带 = hero（开关 + 来源 + 一句状态）+ 6 个指标块（可点可读）
//   · 主栏 = 投递 · 生成能力 · 高级（意图自测 / 接入模式 / hub / 教材）
//   · 侧栏 = 猫群 · 单猫详情 · 会话截图
//   · 通栏 = 产物（网格）· 活动流（时间线）· 指令流水（表格）
//
// 口径：**面板默认不走群**——生成类产物 `deliver=false` 只落产物区；勾「发到群」才按
//       状态带选中的回消息群发送。群内 @ 路径一字未动。
//
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`；块内不发裸请求）
// 取数：GET /api/nav/status · /api/nav/health · /api/nav/detail?key= · /api/nav/hub
//       GET /api/nav/persona · /api/nav/ingress · /api/groups/online
// 动作：POST /api/nav/open|close|chat|send|shot|new-session|reset|comfy|moss|tts|tagger
//       POST /api/nav/intent · /api/nav/ingress · /api/nav/artifacts/clear
// 资产：GET /api/nav/asset?path=<绝对路径>（截图 / 产物图 / 音频；白名单在单体侧）

(function () {
  'use strict';

  // 视图登记表（`_shell.js` 已初始化；本行按契约 §3.1 作存在性锚——幂等赋值，不覆盖已登记块）
  window.__views = window.__views || {};

  /** 状态轮询间隔（毫秒）——页面可见时。 */
  const TICK_MS = 5000;

  /** 生成能力（分段选择一项 = 一张表单）。 */
  const KINDS = [
    { id: 'moss', label: '生图' },
    { id: 'comfy', label: '改图' },
    { id: 'tts', label: '语音' },
    { id: 'tagger', label: '反推' }
  ];

  /** 活动流 kind → 时间线着色类。 */
  const KIND_CLASS = { send: 'send', error: 'error', shot: 'shot', tts: 'tts', event: 'event', moss: 'shot', comfy: 'shot', tagger: 'shot', watch: 'event', reset: 'event' };

  /** DOM 引用（mount 建一次，refresh 只换内容）。 */
  let refs = null;

  /** 轮询定时器。 */
  let timer = null;

  /** 请求序号：迟到响应按序号丢弃。 */
  let seq = 0;

  /** 界面态（业务真相每次从接口读）。 */
  const state = {
    status: null,
    health: null,
    groups: [],
    groupsLoaded: false,
    kind: 'moss',
    cat: 'majordomo',
    detail: null,
    shots: [],
    intent: null,
    hub: null,
    persona: null,
    advancedLoaded: false,
    /** 在途动作（`reset:<key>` 等）——按钮置灰用，防同一次点击发两次请求。 */
    acting: new Set()
  };

  /**
   * 契约对象（`_shell.js` 注入；未就绪时给空对象）。
   *
   * @returns {object} `window.__ui`
   */
  function ui() {
    return window.__ui || {};
  }

  /**
   * 产物文件 → 可取 URL（走单体资产白名单，不直连 file://）。
   *
   * @param {string} file 绝对路径
   * @returns {string} URL（空路径返回空串）
   */
  function assetUrl(file) {
    const p = String(file || '').trim();
    return p ? `/api/nav/asset?path=${encodeURIComponent(p)}` : '';
  }

  /**
   * 时间戳 → 本地时间文本。
   *
   * @param {number} ts Unix 毫秒
   * @returns {string} 文本（空值返回 `-`）
   */
  function when(ts) {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return '-';
    }
  }

  /**
   * 时间戳 → 时分秒（时间线 / 表格用）。
   *
   * @param {number} ts Unix 毫秒
   * @returns {string} 文本
   */
  function clock(ts) {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return '-';
    }
  }

  /**
   * 毫秒 → 「N 分钟 / N 小时」。
   *
   * @param {number} ms 毫秒
   * @returns {string} 文本
   */
  function span(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '-';
    if (n < 60000) return '<1 分钟';
    if (n < 3600000) return `${Math.round(n / 60000)} 分钟`;
    return `${(n / 3600000).toFixed(1)} 小时`;
  }

  /** 通用小件：卡片头。 */
  function cardHead(el, title, extra) {
    return el('div', { class: 'navx-card-head' },
      el('h3', { text: title }),
      extra || null
    );
  }

  /**
   * 猫列表排序——主干 → 常驻（端口升序 = 建猫序）→ 名字；与并发协议面板同口径。
   *
   * @param {Array<object>} list 原始 cats
   * @returns {Array<object>} 新数组（不改入参）
   */
  function sortCats(list) {
    const rank = (row) => (row.special ? 0 : 1);
    const port = (row) => Number(row.port) || 99999;
    return (Array.isArray(list) ? list.slice() : []).sort((a, b) => rank(a) - rank(b) || port(a) - port(b)
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true }));
  }

  // ── 1. 骨架（mount：只建 DOM，不发请求） ────────────────────────────────

  /**
   * 建页骨架并绑定事件。
   *
   * @param {Element} host 容器（`#view-nav`）
   * @returns {void}
   */
  function mount(host) {
    const el = ui().el;
    host.textContent = '';

    // ── 状态带 ──
    const dot = el('span', { class: 'navx-dot' });
    const heroTitle = el('div', { class: 'navx-hero-title', text: '领航员未开启' });
    const heroSub = el('div', { class: 'navx-hero-sub', text: '开启后才能投递与截图；生成能力可独立使用' });
    const toggle = el('button', { class: 'btn', text: '开启领航员' });
    const refreshBtn = el('button', { class: 'navx-mini', text: '刷新' });
    const heroMain = el('div', { class: 'navx-hero-main' },
      dot,
      el('div', { class: 'navx-hero-txt' },
        el('div', { class: 'navx-hero-line' },
          heroTitle,
          el('span', { class: 'navx-grow' }),
          refreshBtn,
          toggle
        ),
        heroSub
      )
    );

    const chatSelect = el('select', { class: 'navx-stat-select', title: '回消息群——「发到群」的动作落到这里' });
    const statChat = el('div', { class: 'navx-stat wide' },
      el('span', { class: 'navx-stat-k', text: '回消息群' }), chatSelect);
    const statIdle = el('div', { class: 'navx-stat' },
      el('span', { class: 'navx-stat-k', text: '空闲 / 阈值' }),
      el('span', { class: 'navx-stat-v', text: '-' }));
    const statWatch = el('div', { class: 'navx-stat' },
      el('span', { class: 'navx-stat-k', text: '观测中' }),
      el('span', { class: 'navx-stat-v', text: '-' }));
    const statBusy = el('div', { class: 'navx-stat' },
      el('span', { class: 'navx-stat-k', text: '生成在跑' }),
      el('span', { class: 'navx-stat-v', text: '-' }));
    const statVip = el('div', { class: 'navx-stat' },
      el('span', { class: 'navx-stat-k', text: 'VIP 最近群' }),
      el('span', { class: 'navx-stat-v', text: '-' }));
    const statMode = el('div', { class: 'navx-stat' },
      el('span', { class: 'navx-stat-k', text: '接入模式' }),
      el('span', { class: 'navx-stat-v', text: '-' }));

    const hero = el('div', { class: 'navx-hero' },
      heroMain,
      el('div', { class: 'navx-stats' }, statChat, statIdle, statWatch, statBusy, statVip, statMode)
    );

    // ── 投递卡 ──
    const catSelect = el('select', { class: 'navx-select' });
    const sendText = el('textarea', { class: 'navx-textarea', rows: 2, placeholder: '给猫下一条指令——投递到它的会话（面板操作，不走群）' });
    // 「干跑」「带来源头」两个勾选项已撤（Rushiera 2026-11-09）——投递就是真投递，
    // 组装口径不再以界面开关承载（后端 `dryRun` / `sourceTag` 参数保留，供自测与群内通道用）。
    const sendBtn = el('button', { class: 'btn', text: '投递' });
    const sendResult = el('pre', { class: 'navx-pre' });
    const sendCard = el('section', { class: 'navx-card' },
      cardHead(el, '投递', el('span', { class: 'navx-count', text: '指令' })),
      el('div', { class: 'navx-card-body' },
        el('label', { class: 'navx-field' }, el('span', { text: '目标猫' }), catSelect),
        sendText,
        el('div', { class: 'navx-row' },
          el('span', { class: 'navx-grow' }),
          sendBtn
        ),
        sendResult
      )
    );

    // ── 生成能力卡 ──
    const seg = el('div', { class: 'navx-seg' });
    const segButtons = new Map();
    for (const item of KINDS) {
      const button = el('button', { type: 'button', text: item.label, onclick: () => { state.kind = item.id; renderFields(); renderSeg(); } });
      segButtons.set(item.id, button);
      seg.appendChild(button);
    }
    const genFields = el('div', { class: 'navx-card-body', style: { padding: '10px 0 0' } });
    const genDeliver = el('input', { type: 'checkbox' });
    const genTarget = el('span', { class: 'navx-target', text: '只回面板' });
    const genBtn = el('button', { class: 'btn', text: '提交' });
    const genResult = el('pre', { class: 'navx-pre' });
    const genCard = el('section', { class: 'navx-card' },
      cardHead(el, '生成能力', el('span', { class: 'navx-count', text: '默认只回面板' })),
      el('div', { class: 'navx-card-body' },
        seg,
        genFields,
        el('div', { class: 'navx-row' },
          el('label', { class: 'navx-check' }, genDeliver, el('span', { text: '发到群' })),
          genTarget,
          el('span', { class: 'navx-grow' }),
          genBtn
        ),
        genResult
      )
    );

    // ── 高级（折叠）──
    const advIntentInput = el('input', { class: 'navx-input', placeholder: '试判一句群消息（影子判断器，不投递）' });
    const advIntentBtn = el('button', { class: 'navx-mini', text: '试判' });
    const advIntentOut = el('pre', { class: 'navx-pre' });
    const advModeOut = el('span', { class: 'navx-tip', text: '（未取）' });
    const advShadowBtn = el('button', { class: 'navx-mini', text: '影子' });
    const advLiveBtn = el('button', { class: 'navx-mini', text: '接管 live' });
    const advPersonaOut = el('pre', { class: 'navx-pre' });
    const advHubOut = el('pre', { class: 'navx-pre' });
    const advBody = el('div', { class: 'navx-card-body' },
      el('label', { class: 'navx-field' }, el('span', { text: '意图判断器（N6 影子面）' }),
        el('div', { class: 'navx-row' }, advIntentInput, advIntentBtn)),
      advIntentOut,
      el('label', { class: 'navx-field' }, el('span', { text: '接入模式（运行态，重启回配置值）' }),
        el('div', { class: 'navx-row' }, advModeOut, el('span', { class: 'navx-grow' }), advShadowBtn, advLiveBtn)),
      el('label', { class: 'navx-field' }, el('span', { text: '教材 / 话术快照' }), advPersonaOut),
      el('label', { class: 'navx-field' }, el('span', { text: '分发中心（hub）' }), advHubOut)
    );
    const advDetails = el('details', { class: 'navx-details' },
      el('summary', { text: '高级：意图判断 · 接入模式 · 教材 · 分发中心' }),
      advBody
    );
    const advCard = el('section', { class: 'navx-card' }, advDetails);

    // ── 猫群卡 ──
    const catCount = el('span', { class: 'navx-count', text: '0' });
    const catsBox = el('div', { class: 'navx-catlist' });
    const catsCard = el('section', { class: 'navx-card' },
      cardHead(el, '猫群', catCount),
      el('div', { class: 'navx-card-body' }, catsBox)
    );

    // ── 详情卡 ──
    const detailTitle = el('h3', { text: '单猫详情' });
    const detailShotBtn = el('button', { class: 'navx-mini', text: '截图' });
    const detailBox = el('pre', { class: 'navx-pre navx-tall', text: '点猫群里某只猫的「详情」。' });
    const detailCard = el('section', { class: 'navx-card' },
      el('div', { class: 'navx-card-head' }, detailTitle, el('div', { class: 'navx-card-actions' }, detailShotBtn)),
      el('div', { class: 'navx-card-body' }, detailBox)
    );

    // ── 截图卡 ──
    const shotCount = el('span', { class: 'navx-count', text: '未截' });
    const shotsBox = el('div', { class: 'navx-shots' },
      el('p', { class: 'navx-empty', text: '点猫群里某只猫的「截图」出一张会话卡（只读，不给猫发消息）。长会话按段分张。' })
    );
    const shotCard = el('section', { class: 'navx-card navx-span3' },
      cardHead(el, '会话截图', shotCount),
      el('div', { class: 'navx-card-body' }, shotsBox)
    );

    // ── 产物卡 ──
    const artCount = el('span', { class: 'navx-count', text: '0' });
    const artClear = el('button', { class: 'navx-mini', text: '清空' });
    const artBox = el('div', { class: 'navx-media' });
    const artCard = el('section', { class: 'navx-card navx-span2' },
      el('div', { class: 'navx-card-head' }, el('h3', { text: '产物' }), artCount,
        el('div', { class: 'navx-card-actions' }, artClear)),
      el('div', { class: 'navx-card-body' }, artBox)
    );

    // ── 活动流卡 ──
    const actCount = el('span', { class: 'navx-count', text: '0' });
    const activityBox = el('div', { class: 'navx-tl' });
    const activityCard = el('section', { class: 'navx-card navx-span2' },
      cardHead(el, '活动流', actCount),
      el('div', { class: 'navx-card-body' }, activityBox)
    );

    // ── 线卡（A 方案 · 2026-11-09）──
    const lineCount = el('span', { class: 'navx-count', text: '0' });
    const lineBox = el('div', { class: 'navx-tablewrap' });
    const lineCard = el('section', { class: 'navx-card navx-span2' },
      cardHead(el, '线', lineCount),
      el('div', { class: 'navx-card-body' }, lineBox)
    );

    // ── 指令流水卡 ──
    const logCount = el('span', { class: 'navx-count', text: '0' });
    const logBox = el('div', { class: 'navx-tablewrap' });
    const logCard = el('section', { class: 'navx-card navx-span3' },
      cardHead(el, '指令流水', logCount),
      el('div', { class: 'navx-card-body' }, logBox)
    );

    // ── 组装 ──
    const mainCol = el('div', { class: 'navx-main' }, sendCard, genCard, advCard);
    const sideCol = el('div', { class: 'navx-side' }, catsCard, detailCard);
    const foot = el('div', { class: 'navx-foot' }, lineCard, activityCard, artCard, logCard, shotCard);

    host.appendChild(el('div', { class: 'navx' },
      hero,
      el('div', { class: 'navx-body' }, mainCol, sideCol),
      foot
    ));

    refs = {
      dot, heroMain, heroTitle, heroSub, toggle, refreshBtn, chatSelect,
      statIdle, statWatch, statBusy, statVip, statMode,
      catSelect, sendText, sendBtn, sendResult,
      seg, segButtons, genFields, genDeliver, genTarget, genBtn, genResult,
      advIntentInput, advIntentBtn, advIntentOut, advModeOut, advShadowBtn, advLiveBtn, advPersonaOut, advHubOut, advDetails,
      catCount, catsBox, detailTitle, detailShotBtn, detailBox, shotCount, shotsBox,
      artCount, artClear, artBox, actCount, activityBox, lineCount, lineBox, logCount, logBox
    };

    bindEvents();
    renderSeg();
    renderFields();
  }

  /**
   * 绑定所有事件（mount 内一次）。
   *
   * @returns {void}
   */
  function bindEvents() {
    const r = refs;

    r.toggle.addEventListener('click', async () => {
      const on = r.toggle.dataset.on === '1';
      r.toggle.disabled = true;
      r.toggle.textContent = on ? '关闭中…' : '开启中…';
      await act(on ? '/api/nav/close' : '/api/nav/open', { by: 'app' });
      r.toggle.disabled = false;
      await refresh(true);
    });

    r.refreshBtn.addEventListener('click', () => refresh(true));

    r.chatSelect.addEventListener('change', async () => {
      await act('/api/nav/chat', { chat: r.chatSelect.value || '' });
      await refresh(false);
    });

    r.catSelect.addEventListener('change', () => { state.cat = r.catSelect.value || 'majordomo'; });

    r.sendBtn.addEventListener('click', async () => {
      const text = String(r.sendText.value || '').trim();
      if (!text) { r.sendResult.textContent = '先写一句话。'; return; }
      r.sendBtn.disabled = true;
      r.sendResult.textContent = '投递中…';
      const result = await act('/api/nav/send', {
        key: state.cat,
        text,
        watch: true
      });
      r.sendBtn.disabled = false;
      r.sendResult.textContent = formatSend(result);
      await refresh(false);
    });

    r.genBtn.addEventListener('click', async () => {
      const payload = collectGen();
      if (payload.error) { r.genResult.textContent = payload.error; return; }
      const toGroup = r.genDeliver.checked === true;
      const chat = String((state.status && state.status.activeChat) || '');
      if (toGroup && !chat) {
        r.genResult.textContent = '勾了「发到群」但上面没选回消息群——先选一个群，或取消勾选（只回面板）。';
        return;
      }
      r.genBtn.disabled = true;
      r.genResult.textContent = '已提交——产物出来会出现在「产物」卡。';
      const label = (KINDS.find((k) => k.id === state.kind) || {}).label || '生成';
      const result = await act(`/api/nav/${state.kind}`, { ...payload.body, deliver: toGroup, chat: toGroup ? chat : null });
      r.genBtn.disabled = false;
      r.genResult.textContent = result.ok
        ? `已受理（${label}）${result.message ? `：${result.message}` : ''}`
        : `失败：${result.error || '未知原因'}`;
      await refresh(false);
    });

    r.genDeliver.addEventListener('change', () => renderGenTarget());

    r.artClear.addEventListener('click', async () => {
      r.artClear.disabled = true;
      await act('/api/nav/artifacts/clear', {});
      r.artClear.disabled = false;
      await refresh(false);
    });

    r.detailShotBtn.addEventListener('click', () => {
      if (state.cat) shoot(state.cat);
    });

    r.advDetails.addEventListener('toggle', () => {
      if (r.advDetails.open && !state.advancedLoaded) loadAdvanced();
    });

    r.advIntentBtn.addEventListener('click', async () => {
      const text = String(r.advIntentInput.value || '').trim();
      if (!text) { r.advIntentOut.textContent = '先写一句。'; return; }
      r.advIntentOut.textContent = '判断中…';
      const result = await act('/api/nav/intent', { text, atMe: false, enabled: true, useLlm: false });
      state.intent = result;
      r.advIntentOut.textContent = JSON.stringify(result, null, 2);
    });

    r.advShadowBtn.addEventListener('click', async () => {
      const result = await act('/api/nav/ingress', { mode: 'shadow' });
      r.advModeOut.textContent = result.ok ? `mode=${result.mode} · allow=${JSON.stringify(result.allow)}` : `切换失败：${result.error}`;
      await refresh(false);
    });

    r.advLiveBtn.addEventListener('click', async () => {
      const result = await act('/api/nav/ingress', { mode: 'live' });
      r.advModeOut.textContent = result.ok ? `mode=${result.mode} · allow=${JSON.stringify(result.allow)}` : `切换失败：${result.error}`;
      await refresh(false);
    });
  }

  /**
   * 生成能力分段选择态。
   *
   * @returns {void}
   */
  function renderSeg() {
    if (!refs) return;
    for (const [id, button] of refs.segButtons) {
      button.classList.toggle('on', id === state.kind);
    }
  }

  /**
   * 按当前生成能力渲染表单字段。
   *
   * @returns {void}
   */
  function renderFields() {
    const el = ui().el;
    const box = refs && refs.genFields;
    if (!el || !box) return;
    box.textContent = '';
    const kind = state.kind;

    if (kind === 'moss') {
      box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '画面描述（中文即可——提交时自动翻英文）' }),
        el('textarea', { class: 'navx-textarea', rows: 2, id: 'navx-prompt', placeholder: '例：樱花树下的白猫，水彩风' })));
      box.appendChild(el('div', { class: 'navx-grid2' },
        el('label', { class: 'navx-field' }, el('span', { text: '尺寸（可空）' }),
          el('input', { class: 'navx-input', id: 'navx-size', placeholder: '1024x1024 / 竖图 / 横图' })),
        el('label', { class: 'navx-field' }, el('span', { text: '种子（可空）' }),
          el('input', { class: 'navx-input', id: 'navx-seed', placeholder: '-1 = 随机' }))
      ));
      return;
    }

    if (kind === 'comfy') {
      box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '改图要求（一句）' }),
        el('textarea', { class: 'navx-textarea', rows: 2, id: 'navx-prompt', placeholder: '例：把这张图改成三视图' })));
      box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '图片路径（本机绝对路径）' }),
        el('input', { class: 'navx-input', id: 'navx-image', placeholder: '三选一：路径 / 群图 file / 直链' })));
      box.appendChild(el('div', { class: 'navx-grid2' },
        el('label', { class: 'navx-field' }, el('span', { text: '群图 file（可空）' }),
          el('input', { class: 'navx-input', id: 'navx-file', placeholder: 'OneBot 消息段 file 名' })),
        el('label', { class: 'navx-field' }, el('span', { text: '直链（可空）' }),
          el('input', { class: 'navx-input', id: 'navx-url', placeholder: 'http(s)://…' }))
      ));
      return;
    }

    if (kind === 'tts') {
      box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '台词（中文自动翻日语；写假名原形按日语读）' }),
        el('textarea', { class: 'navx-textarea', rows: 3, id: 'navx-text', placeholder: '例：おや——，今宵も雪が降っておりますね。' })));
      box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '风格描述（可空）' }),
        el('input', { class: 'navx-input', id: 'navx-caption', placeholder: '例：温柔、慢一点' })));
      return;
    }

    box.appendChild(el('label', { class: 'navx-field' }, el('span', { text: '图片路径（本机绝对路径）' }),
      el('input', { class: 'navx-input', id: 'navx-image', placeholder: '三选一：路径 / 群图 file / 直链' })));
    box.appendChild(el('div', { class: 'navx-grid2' },
      el('label', { class: 'navx-field' }, el('span', { text: '群图 file（可空）' }),
        el('input', { class: 'navx-input', id: 'navx-file', placeholder: '可空' })),
      el('label', { class: 'navx-field' }, el('span', { text: '直链（可空）' }),
        el('input', { class: 'navx-input', id: 'navx-url', placeholder: '可空' }))
    ));
  }

  /**
   * 收当前生成表单为请求体。
   *
   * @returns {{body?: object, error?: string}} 结果
   */
  function collectGen() {
    const val = (id) => String((document.getElementById(id) || {}).value || '').trim();
    const kind = state.kind;

    if (kind === 'moss') {
      const prompt = val('navx-prompt');
      if (!prompt) return { error: '先写一句画面描述。' };
      return { body: { prompt, size: val('navx-size'), seed: val('navx-seed') || null } };
    }
    if (kind === 'comfy') {
      const prompt = val('navx-prompt');
      if (!prompt) return { error: '先写一句改图要求。' };
      if (!val('navx-image') && !val('navx-file') && !val('navx-url')) return { error: '要给一张图：路径 / file / 直链三选一。' };
      return { body: { prompt, image: val('navx-image'), file: val('navx-file'), url: val('navx-url') } };
    }
    if (kind === 'tts') {
      const text = val('navx-text');
      if (!text) return { error: '先写台词。' };
      return { body: { text, caption: val('navx-caption') } };
    }
    if (!val('navx-image') && !val('navx-file') && !val('navx-url')) return { error: '要给一张图：路径 / file / 直链三选一。' };
    return { body: { image: val('navx-image'), file: val('navx-file'), url: val('navx-url') } };
  }

  /**
   * 投递回执 → 一段人话。
   *
   * @param {object} result `/api/nav/send` 回执
   * @returns {string} 文本
   */
  function formatSend(result) {
    if (!result) return '无回执。';
    if (result.ok !== true) return `未受理：${result.error || '未知原因'}`;
    if (result.dryRun) return `干跑通过 → ${result.key}：${result.text || ''}`;
    const reply = result.reply && typeof result.reply === 'object'
      ? (result.reply.content || result.reply.message || JSON.stringify(result.reply))
      : '';
    return `已投递 → ${result.key || '-'}${reply ? `\n回复：${String(reply).slice(0, 400)}` : ''}\n（回复截图与进度看「活动流」）`;
  }

  // ── 2. 取数 ──────────────────────────────────────────────────────────────

  /**
   * 拉一次状态并重渲染（健康检查只在首次或手动刷新时拉——它要探外部服务）。
   *
   * @param {boolean} includeHealth 是否重拉健康检查
   * @returns {Promise<void>} 完成
   */
  async function refresh(includeHealth) {
    const api = ui().api;
    if (typeof api !== 'function') return;
    const mine = ++seq;

    const status = await api('/api/nav/status');
    if (mine !== seq) return;
    if (status && status.ok !== false) state.status = status;

    if (!state.groupsLoaded) await loadGroups();
    if (mine !== seq) return;

    renderHero();
    renderCats();
    renderArtifacts();
    renderActivity();
    renderLines();
    renderLog();
    if (state.detail) renderDetail();

    if (includeHealth === true || !state.health) await loadHealth();
    if (mine !== seq) return;
    if (state.advancedLoaded) await loadAdvanced();
  }

  /**
   * 拉回消息群候选（协议端当前所在群）。
   *
   * @returns {Promise<void>} 完成
   */
  async function loadGroups() {
    const api = ui().api;
    if (typeof api !== 'function') return;
    state.groupsLoaded = true;
    const result = await api('/api/groups/online');
    if (result && result.ok === true && Array.isArray(result.groups)) {
      state.groups = result.groups
        .map((row) => ({ id: String(row.id || ''), name: String(row.name || '') }))
        .filter((row) => row.id);
    } else {
      state.groups = [];
      console.warn('[nav] 群列表取不到：', result && result.error);
    }
  }

  /**
   * 拉健康检查（探外部服务，只在手动刷新 / 首次拉）。
   *
   * @returns {Promise<void>} 完成
   */
  async function loadHealth() {
    const api = ui().api;
    if (typeof api !== 'function') return;
    const result = await api('/api/nav/health');
    state.health = result && result.ok !== false ? result : { ok: false, error: result && result.error };
  }

  /**
   * 拉高级面（hub / 教材 / 接入模式）——只在折叠区首次展开与之后每次刷新时拉。
   *
   * @returns {Promise<void>} 完成
   */
  async function loadAdvanced() {
    const api = ui().api;
    if (typeof api !== 'function' || !refs) return;
    state.advancedLoaded = true;
    const [hub, persona, ingress] = await Promise.all([
      api('/api/nav/hub'),
      api('/api/nav/persona'),
      api('/api/nav/ingress')
    ]);
    state.hub = hub && hub.hub ? hub.hub : null;
    state.persona = persona && persona.snapshot ? persona : null;
    refs.advHubOut.textContent = state.hub ? JSON.stringify(state.hub, null, 2) : '（分发中心未接入）';
    const snap = state.persona && state.persona.snapshot;
    refs.advPersonaOut.textContent = snap
      ? [`来源：${snap.source || '-'}`, `字符：${snap.chars ?? '-'}`, `分段：${snap.sections ?? '-'}`].join('\n')
      : '（教材快照未取到）';
    refs.advModeOut.textContent = ingress && ingress.ok !== false
      ? `mode=${ingress.mode} · allow=${JSON.stringify(ingress.allow)}`
      : '（接入态未取到）';
  }

  // ── 3. 渲染 ──────────────────────────────────────────────────────────────

  /**
   * 状态带（开关 / 来源 / 六个指标块）。
   *
   * @returns {void}
   */
  function renderHero() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const on = s.enabled === true;

    refs.dot.className = `navx-dot${on ? ' on' : ''}`;
    if (refs.heroMain) refs.heroMain.classList.toggle('on', on);
    refs.toggle.textContent = on ? '关闭领航员' : '开启领航员';
    refs.toggle.dataset.on = on ? '1' : '0';

    if (on) {
      refs.heroTitle.textContent = '领航员已开启';
      refs.heroSub.textContent = `来源 ${s.openedBy === 'qq' ? '群内 @' : '应用内'} · 开启于 ${when(s.openedAt)}`;
    } else if (s.closedReason === 'idle') {
      refs.heroTitle.textContent = '已暂关（空闲）';
      refs.heroSub.textContent = `最后指令 ${when(s.lastCommandAt)} · 关闭于 ${when(s.closedAt)}`;
    } else {
      refs.heroTitle.textContent = '领航员未开启';
      refs.heroSub.textContent = '开启后可投递与截图；生成能力不依赖开关';
    }

    // 回消息群
    const current = String(s.activeChat || '');
    const ids = state.groups.map((row) => row.id);
    if (current && !ids.includes(current)) state.groups.unshift({ id: current, name: '（当前回消息群）' });
    refs.chatSelect.textContent = '';
    refs.chatSelect.appendChild(el('option', { value: '', text: '（未定）' }));
    for (const row of state.groups) {
      refs.chatSelect.appendChild(el('option', {
        value: row.id,
        text: row.name ? `${row.name}（${row.id}）` : row.id
      }));
    }
    refs.chatSelect.value = current;
    const pickedChat = state.groups.find((row) => row.id === current);
    refs.chatSelect.title = pickedChat ? `${pickedChat.name || ''}（${pickedChat.id}）` : '（未定）';

    const setStat = (node, text, note) => {
      node.textContent = '';
      node.appendChild(document.createTextNode(text));
      if (note) node.appendChild(el('small', { text: note }));
    };

    setStat(refs.statIdle, s.lastCommandAt ? span(s.idleMs) : '-', s.idleCloseMs ? `阈值 ${span(s.idleCloseMs)}` : '');

    const watching = Array.isArray(s.watching) ? s.watching : [];
    setStat(refs.statWatch, `${watching.length} 只`, watching.length ? watching.slice(0, 3).join(' / ') : '未订阅');

    const mb = s.mediaBusy || {};
    const running = [mb.moss ? '生图' : '', mb.tts ? '语音' : '', mb.tagger ? '反推' : ''].filter(Boolean);
    setStat(refs.statBusy, running.length ? running.join(' · ') : '空闲', mb.ttsQueued ? `队列 ${mb.ttsQueued}` : '');

    setStat(refs.statVip, s.vipRecentChat ? String(s.vipRecentChat) : '-', s.vipUser ? `VIP ${s.vipUser}` : '');

    const mode = (s.ingress && s.ingress.mode) || '-';
    const allow = s.ingress && Array.isArray(s.ingress.allow) ? s.ingress.allow.length : 0;
    setStat(refs.statMode, mode === 'live' ? 'live 接管' : 'shadow 影子', mode === 'live' ? `已放行 ${allow} 类` : '只采集不动作');

    // 目标猫下拉（猫清单变了才重建）——排序与猫群卡同口径：主干 → 常驻按端口
    const cats = sortCats(Array.isArray(s.cats) ? s.cats : []);
    const names = cats.map((row) => String(row.id || row.name || '')).filter(Boolean);
    if (!names.includes(state.cat)) state.cat = names[0] || 'majordomo';
    const signature = names.join('|');
    if (refs.catSelect.dataset.signature !== signature) {
      refs.catSelect.dataset.signature = signature;
      refs.catSelect.textContent = '';
      for (const row of cats) {
        const id = String(row.id || row.name || '');
        if (!id) continue;
        refs.catSelect.appendChild(el('option', { value: id, text: row.name ? `${row.name}（${row.port || '-'}）` : id }));
      }
      if (!cats.length) refs.catSelect.appendChild(el('option', { value: 'majordomo', text: 'majordomo' }));
    }
    refs.catSelect.value = state.cat;
    renderGenTarget();
  }

  /**
   * 「发到群」旁的目标提示——勾了显示具体群名，没勾显示「只回面板」。
   *
   * @returns {void}
   */
  function renderGenTarget() {
    if (!refs || !refs.genTarget) return;
    if (refs.genDeliver.checked !== true) {
      refs.genTarget.textContent = '只回面板';
      return;
    }
    const chat = String((state.status && state.status.activeChat) || '');
    if (!chat) {
      refs.genTarget.textContent = '未选回消息群';
      return;
    }
    const row = state.groups.find((item) => item.id === chat);
    refs.genTarget.textContent = `→ ${row && row.name ? row.name : chat}`;
  }

  /**
   * 猫群列表（状态点 + 名 + 端口/状态 + 四个动作）。
   *
   * @returns {void}
   */
  function renderCats() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const cats = sortCats(Array.isArray(s.cats) ? s.cats : []);
    const busy = new Set(Array.isArray(s.busy) ? s.busy : []);
    // 整理在途（服务端在途表）——后台整理几分钟，按钮要在这整段时间里保持置灰
    const resettingKeys = new Set(
      (Array.isArray(s.resetting) ? s.resetting : []).map((item) => String(item?.key || ''))
    );
    refs.catCount.textContent = String(cats.length);
    refs.catsBox.textContent = '';

    if (!cats.length) {
      refs.catsBox.appendChild(el('p', {
        class: 'navx-empty',
        text: s.ch4Error ? `CH4 未连接：${s.ch4Error}` : '（没有猫——先确认 CH4 在跑）'
      }));
      return;
    }

    const now = Date.now();
    for (const row of cats) {
      const key = String(row.id || row.name || '');
      const runState = String(row.runState || row.phase || '');
      const working = busy.has(key) || runState === 'run' || runState === 'running' || runState === 'waiting';
      const resetting = resettingKeys.has(key) || resettingKeys.has(String(row.name || ''));
      const off = row.running === false;
      const tone = off ? 'off' : resetting ? 'reset' : working ? 'busy' : 'idle';
      const label = off ? '未运行' : resetting ? '整理中' : working ? '跑动' : '空闲';
      // 前文体量按字符算（token 在空会话里恒 0，字符数恒有值）；tip 里给 token 与条数
      const ctxK = Math.round((Number(row.contextChars) || 0) / 1000)
        || Math.round((Number(row.context) || 0) / 1000);
      const calls = Number(row.requests) || 0;
      const agoMs = row.lastActiveAt ? now - Number(row.lastActiveAt) : 0;
      const tip = [
        `${row.name || key}${row.special ? '（主干）' : ''} · 端口 ${row.port || '—'}`,
        `状态 ${label}${runState ? `（${runState}）` : ''}`,
        ctxK ? `前文 ${ctxK}k 字符 · 约 ${Math.round((Number(row.context) || 0) / 1000)}k tok · ${row.contextCount || 0} 条` : '',
        `累计 ${calls} 次调用${row.round ? ` · 第 ${row.round} 轮` : ''}`,
        agoMs > 0 ? `最近活动 ${span(agoMs)}前` : '',
        row.pending ? `排队 ${row.pending} 条` : ''
      ].filter(Boolean).join('\n');
      const line = el('div', {
        class: `navx-cat ${tone}${key === state.cat ? ' active' : ''}`,
        title: tip,
        onclick: () => { state.cat = key; refs.catSelect.value = key; renderCats(); }
      },
        el('span', { class: 'navx-cat-dot' }),
        el('span', { class: 'navx-cat-name', text: String(row.name || key) }),
        el('span', { class: `navx-pill ${tone}`, text: label }),
        ctxK ? el('span', { class: 'navx-cat-ctx', text: `${ctxK}k` }) : null,
        el('span', { class: 'navx-cat-calls', text: `${calls} 次` }),
        agoMs > 0 ? el('span', { class: 'navx-cat-ago', text: `${span(agoMs)}前` }) : null,
        el('span', { class: 'navx-cat-tools' },
          el('button', { class: 'navx-mini', text: '详情', onclick: (event) => { event.stopPropagation(); showDetail(key); } }),
          el('button', { class: 'navx-mini', text: '截图', onclick: (event) => { event.stopPropagation(); shoot(key); } }),
          el('button', { class: 'navx-mini', text: '新会话', onclick: (event) => { event.stopPropagation(); newSession(key); } }),
          el('button', {
            class: 'navx-mini',
            text: (state.acting.has(`reset:${key}`) || resetting) ? '整理中…' : '整理',
            title: '前文整理重启（后台执行——同猫串行，不同猫并发）',
            disabled: state.acting.has(`reset:${key}`) || resetting,
            onclick: (event) => { event.stopPropagation(); resetSession(key); }
          })
        )
      );
      refs.catsBox.appendChild(line);
    }
  }

  /**
   * 单猫详情（JSON 只读块，超长截断）。
   *
   * @returns {void}
   */
  function renderDetail() {
    if (!refs || !state.detail) return;
    const key = state.detailKey || state.cat;
    refs.detailTitle.textContent = `单猫详情 · ${key}`;
    const result = state.detail;
    const text = result && result.ok === false
      ? `读取失败：${result.error || '未知原因'}`
      : JSON.stringify(result, null, 2);
    refs.detailBox.textContent = text.length > 8000 ? `${text.slice(0, 8000)}\n…（已截断，共 ${text.length} 字符）` : text;
  }

  /**
   * 产物网格（图 / 音频 / 标签文本）。
   *
   * @returns {void}
   */
  function renderArtifacts() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const items = Array.isArray(s.artifacts) ? s.artifacts.slice().reverse() : [];
    refs.artCount.textContent = String(items.length);
    refs.artBox.textContent = '';

    if (!items.length) {
      refs.artBox.appendChild(el('p', { class: 'navx-empty', text: '本会话还没有产物——生成能力出图 / 念完语音会出现在这里。' }));
      return;
    }

    for (const item of items) {
      const kind = String(item.source || item.kind || '');
      const head = el('div', { class: 'navx-media-meta' },
        el('span', { class: `navx-kind ${kind}`, text: kind || item.kind }),
        el('span', { class: 'navx-media-cap', text: item.caption || '' }),
        el('span', { class: 'navx-media-at', text: clock(item.at) })
      );
      let body;
      if (item.kind === 'image' && item.file) {
        body = el('a', { href: assetUrl(item.file), target: '_blank' },
          el('img', { src: assetUrl(item.file), alt: item.caption || '产物' }));
      } else if (item.kind === 'audio' && item.file) {
        body = el('div', { class: 'navx-media-audio' }, el('audio', { controls: true, preload: 'none', src: assetUrl(item.file) }));
      } else {
        body = el('div', { class: 'navx-media-text', text: String(item.text || '') });
      }
      refs.artBox.appendChild(el('div', { class: 'navx-media-item' }, body, head));
    }
  }

  /**
   * 活动流（时间线，新的在上）。
   *
   * @returns {void}
   */
  function renderActivity() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const list = Array.isArray(s.activity) ? s.activity.slice().reverse() : [];
    refs.actCount.textContent = String(list.length);
    refs.activityBox.textContent = '';
    if (!list.length) {
      refs.activityBox.appendChild(el('p', { class: 'navx-empty', text: '暂无活动。' }));
      return;
    }
    for (const a of list) {
      const cls = KIND_CLASS[a.kind] || 'event';
      refs.activityBox.appendChild(el('div', { class: `navx-tl-item ${cls}` },
        el('span', { class: 'navx-tl-time', text: clock(a.at) }),
        el('span', { class: 'navx-tl-kind', text: a.kind }),
        el('span', { class: 'navx-tl-text', text: a.text })
      ));
    }
  }

  /**
   * 指令流水（表格，新的在上）。
   *
   * @returns {void}
   */
  function renderLog() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const list = Array.isArray(s.commandLog) ? s.commandLog.slice().reverse() : [];
    refs.logCount.textContent = String(list.length);
    refs.logBox.textContent = '';
    if (!list.length) {
      refs.logBox.appendChild(el('p', { class: 'navx-empty', text: '暂无指令。' }));
      return;
    }
    const head = el('tr', {},
      el('th', { text: '时间' }), el('th', { text: '群' }), el('th', { text: '目标' }),
      el('th', { text: '内容' }), el('th', { text: '结果' })
    );
    const rows = list.map((e) => el('tr', {},
      el('td', { class: 'num', text: clock(e.at) }),
      el('td', { class: 'num', text: e.chat || '-' }),
      el('td', { class: 'num', text: e.target || '-' }),
      el('td', {}, el('div', { class: 'ell', title: e.text || '', text: e.text || '' })),
      el('td', { class: `res ${String(e.result || '').includes('失败') ? 'navx-bad' : 'navx-ok'}`, title: e.result || '', text: e.result || '-' })
    ));
    refs.logBox.appendChild(el('table', { class: 'navx-table' },
      el('thead', {}, head), el('tbody', {}, rows)));
  }

  /**
   * 线表（一次派活一条线，新的在上）——A 方案：线内首报才发群，线外静默。
   *
   * @returns {void}
   */
  function renderLines() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const data = s.lines || {};
    const active = Array.isArray(data.active) ? data.active.slice().reverse() : [];
    const recent = Array.isArray(data.recent) ? data.recent.slice().reverse() : [];
    const counts = data.counts || {};
    const running = Number(counts.running) || 0;
    const reported = Number(counts.reported) || 0;
    const blocked = Number(counts.blocked) || 0;
    refs.lineCount.textContent = `${active.length} 活跃`;
    refs.lineBox.textContent = '';

    if (!active.length && !recent.length) {
      refs.lineBox.appendChild(el('p', {
        class: 'navx-empty',
        text: '还没有线——投递一次就开一条（线内首报发群，线外回复静默）。'
      }));
      return;
    }

    const head = el('tr', {},
      el('th', { text: '线' }), el('th', { text: '猫' }), el('th', { text: '状态' }),
      el('th', { text: '开于' }), el('th', { text: '群' }), el('th', { text: '指令' })
    );
    const rows = active.map((item) => el('tr', {},
      el('td', { class: 'num', text: String(item.id || '') }),
      el('td', { class: 'num', text: String(item.name || item.key || '') }),
      el('td', { class: String(item.status) === 'running' ? 'navx-ok' : 'num', text: String(item.status || '') }),
      el('td', { class: 'num', text: clock(item.at) }),
      el('td', { class: 'num', text: String(item.chat || '-') }),
      el('td', {}, el('div', { class: 'ell', title: item.text || '', text: item.text || '' }))
    ));
    const box = el('div', {});
    box.appendChild(el('table', { class: 'navx-table' },
      el('thead', {}, head), el('tbody', {}, rows)));
    if (recent.length) {
      box.appendChild(el('div', {
        class: 'navx-tip',
        style: { marginTop: '6px' },
        text: `最近收线：${recent.slice(0, 6).map((item) => `${item.id}（${item.note || '已收'}）`).join(' · ')}`
      }));
    }
    box.appendChild(el('div', {
      class: 'navx-tip',
      style: { marginTop: '4px' },
      text: `在跑 ${running} / 待收 ${reported} / 阻塞 ${blocked}——交报告后超时自动收线`
    }));
    refs.lineBox.appendChild(box);
  }

  // ── 4. 动作 ──────────────────────────────────────────────────────────────

  /**
   * 调一个动作接口；失败出声（不静默吞）。
   *
   * @param {string} path 接口路径
   * @param {object} body 请求体
   * @returns {Promise<object>} 回执
   */
  async function act(path, body) {
    const api = ui().api;
    if (typeof api !== 'function') return { ok: false, error: '契约未就绪（window.__ui.api 缺失）' };
    const result = await api(path, { method: 'POST', body: body || {} });
    if (!result || result.ok !== true) {
      console.warn(`[nav] ${path} 失败：`, (result && result.error) || '未知原因');
    }
    return result || { ok: false, error: '空回执' };
  }

  /**
   * 看单猫详情（在干什么 / 末条 user / 末条回复）。
   *
   * @param {string} key 猫 key
   * @returns {Promise<void>} 完成
   */
  async function showDetail(key) {
    const api = ui().api;
    if (typeof api !== 'function' || !refs) return;
    state.detailKey = key;
    state.cat = key;
    refs.catSelect.value = key;
    refs.detailTitle.textContent = `单猫详情 · ${key}`;
    refs.detailBox.textContent = '读取中…';
    const result = await api(`/api/nav/detail?key=${encodeURIComponent(key)}`);
    state.detail = result;
    renderDetail();
    renderCats();
  }

  /**
   * 截某只猫的会话卡（面板口径——只出图不发群）。
   *
   * @param {string} key 猫 key
   * @returns {Promise<void>} 完成
   */
  async function shoot(key) {
    const el = ui().el;
    if (!el || !refs) return;
    refs.shotCount.textContent = '出图中…';
    refs.shotsBox.textContent = '';
    refs.shotsBox.appendChild(el('p', { class: 'navx-tip', text: `正在给 ${key} 的会话出图（长会话按段分张，可能要十几秒）…` }));
    const result = await act('/api/nav/shot', { key, send: false });
    refs.shotsBox.textContent = '';
    if (result.ok !== true) {
      refs.shotCount.textContent = '失败';
      refs.shotsBox.appendChild(el('p', { class: 'navx-empty', text: `截图失败：${result.error || '未知原因'}` }));
      return;
    }
    const files = Array.isArray(result.files) ? result.files : (result.file ? [result.file] : []);
    state.shots = files;
    refs.shotCount.textContent = `${files.length} 段`;
    if (!files.length) {
      refs.shotsBox.appendChild(el('p', { class: 'navx-empty', text: '没有截到内容。' }));
      return;
    }
    refs.shotsBox.appendChild(el('p', {
      class: 'navx-tip',
      text: `${key} · ${files.length} 段 · ${result.blockCount || 0} 块（只读，不给猫发消息）`
    }));
    files.forEach((file, index) => {
      refs.shotsBox.appendChild(el('div', {},
        el('div', { class: 'navx-shot-head', text: files.length > 1 ? `第 ${index + 1}/${files.length} 段` : '完整会话' }),
        el('a', { href: assetUrl(file), target: '_blank' }, el('img', { class: 'navx-shot-img', src: assetUrl(file), alt: '会话截图' }))
      ));
    });
  }

  /**
   * 新会话（发布 `/new`——只清前文，不做交接）。
   *
   * @param {string} key 猫 key
   * @returns {Promise<void>} 完成
   */
  async function newSession(key) {
    const result = await act('/api/nav/new-session', { keys: key });
    if (!refs) return;
    refs.sendResult.textContent = result.ok === true
      ? `${key}：新会话已请求（只清前文，不交接）`
      : `${key}：新会话失败——${result.error || '未知原因'}`;
  }

  /**
   * 前文整理重启（后台执行——收工报告 + 摘要 + 重建）。
   *
   * @param {string} key 猫 key
   * @returns {Promise<void>} 完成
   */
  async function resetSession(key) {
    const tag = `reset:${key}`;
    // 防抖（Rushiera 2026-11-09）：一次点击只发一次——在途期间按钮置灰，重复点击直接忽略。
    if (state.acting.has(tag)) return;
    // 服务端在途表已含这只猫 → 直接提示，不再发请求（按钮置灰是主闸，这里是键盘 / 旧渲染的兜底）
    const inFlight = (Array.isArray(state.status?.resetting) ? state.status.resetting : [])
      .map((item) => String(item?.key || ''));
    if (inFlight.includes(key)) {
      if (refs) refs.sendResult.textContent = `${key}：已在整理中——本次未重复执行`;
      return;
    }
    state.acting.add(tag);
    renderCats();
    const chat = (state.status && state.status.activeChat) || null;
    try {
      const result = await act('/api/nav/reset', { key, chat, source: 'panel:nav-view' });
      if (!refs) return;
      refs.sendResult.textContent = result.ok !== true
        ? `${key}：整理重启失败——${result.error || '未知原因'}`
        : (result.busy === true
          ? `${key}：已在整理中——本次未重复执行`
          : `${key}：整理重启已在后台执行——进度看「活动流」`);
    } finally {
      state.acting.delete(tag);
      if (refs) renderCats();
    }
  }

  // ── 5. 登记 ──────────────────────────────────────────────────────────────

  /** 页面可见时的状态轮询（切走不请求）。 */
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      const host = document.getElementById('view-nav');
      if (!host || !host.classList.contains('active')) return;
      refresh(false).catch((error) => console.warn('[nav] 轮询失败', error));
    }, TICK_MS);
  }

  const view = {
    title: '领航员',
    mount,
    refresh() {
      startTimer();
      return refresh(true);
    }
  };

  if (ui().registerView) ui().registerView('navigator', view);
})();
