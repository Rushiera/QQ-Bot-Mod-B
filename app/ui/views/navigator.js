// app/ui/views/navigator.js —— 领航员页（面板操作台 · v2 排版 2026-11-09）
//
// 定位：把「群里 @ 领航员能做的事」在面板上做一份等价的显式操作面，并把领航员状态**看全**——
//       状态带（开关 / 回消息群 / 空闲 / 订阅 / 生成在跑 / VIP / 接入模式）+ 主从两栏 + 通栏。
//
// 布局（Rushiera 2026-11-11 修订：单栏纵排 + 主区两栏）：
//   · 状态带 = hero（开关 + 来源 + 一句状态）+ 6 个指标块（可点可读）· 猫群条紧随其后一整行
//   · 主区两栏 = 猫会话（内嵌 mau 猫对话页，`?embed=1` 只读映射：宿主输入区不显示，保留状态区，左 · 约 85%）
//                + 右栏上下两块（上 领航员输入 / 下 对猫说话，约 15%）
//   · 其下依次 = 生成能力 → 高级
//   · 通栏 = 线 / 活动流 / 产物 / 指令流水 / 会话截图 / 原「单猫详情 JSON」卡（沉在最末）
//   · 两个「详情」区分：内嵌猫页卡 = 「猫会话」；最末原始 JSON 卡 = 「单猫详情」
//   · 回消息群框 = 一个下拉（不发群消息 / 消息跟随（当前群名）/ 各群）+ 标签行右侧「→ 群名」
//   · 投递卡已撤（2026-11-10）——「给某只猫下一条指令」走猫条右键菜单 / 群内 @ 通道
//
// 口径：**面板默认不走群**——生成类产物 `deliver=false` 只落产物区；下拉选「消息跟随（当前群名）」
//       或具体群才发群（选具体群同时切回消息群）。群内 @ 路径一字未动。
//
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`；块内不发裸请求）
// 取数：GET /api/nav/status · /api/nav/health · /api/nav/detail?key= · /api/nav/hub
//       GET /api/nav/persona · /api/nav/ingress · /api/groups/online
// 动作：POST /api/nav/open|close|chat|send|shot|new-session|reset|comfy|moss|tts|tagger
//       POST /api/nav/intent · /api/nav/ingress · /api/nav/artifacts/clear
//       POST /api/biz/nav/lead（领航员输入框——业务面注入一条「本人在群里 @ 它」的消息）
// 资产：GET /api/nav/asset?path=<绝对路径>（截图 / 产物图 / 音频；白名单在单体侧）

(function () {
  'use strict';

  // 视图登记表（`_shell.js` 已初始化；本行按契约 §3.1 作存在性锚——幂等赋值，不覆盖已登记块）
  window.__views = window.__views || {};

  /** 状态轮询间隔（毫秒）——页面可见时。 */
  const TICK_MS = 5000;

  /** 宿主 runState → 「在跑什么」——chip 里跟着状态药丸显示，避免「跑动」这个词什么也没说。 */
  const ACTION_TEXT = { link: '连接', think: '思考', tool: '工具', run: '在跑', reply: '回复', wait: '等待' };

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
    acting: new Set(),
    /** 生成产物落地档（'' = 不发群消息 · 'follow' = 跟随当前回消息群 · '<群id>' = 指定群）。 */
    deliverTarget: ''
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

    // 回消息群框（Rushiera 2026-11-09 定稿）：**一个下拉框**搞定——
    // 头两项当「特殊的群」看：不发群消息 / 消息跟随（当前群名），后面是群列表；
    // 目标提示「→ 群名」放在标签这一行（上面），不占下拉下面的位置。
    const genTarget = el('span', { class: 'navx-target', text: '→ 未定' });
    const chatSelect = el('select', { class: 'navx-stat-select', title: '回消息群 / 产物落地：不发群消息 · 消息跟随（当前群名） · 具体群' });
    // 发群类型六个按钮（Rushiera 2026-11-09 · v1.62）——五类各自开关 + 一个「全开 / 全关」总控。
    // 发不发群由这里定，不再由领航员开关定；开关领航员时整组回落一次
    // （开 → 五类全开；关 → 只留「我的截图 + 生成产物」）。
    const kindBar = el('div', { class: 'navx-dkinds' });
    const kindNote = el('span', { class: 'navx-dkind-note' });
    const statChat = el('div', { class: 'navx-stat wide' },
      el('div', { class: 'navx-stat-line' },
        el('span', { class: 'navx-stat-k', text: '回消息群' }), genTarget),
      chatSelect,
      kindBar,
      kindNote
    );
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

    // ── 领航员输入框（Rushiera 2026-11-10）──
    // 与「投递」分开：投递是**指定猫**下一条指令；这里不选猫，一句话交给领航员自己判断。
    // 落地通道 = 业务面真实入站链（等同本人在群里 @ 它说这句）——白名单 / 存档 / 档位 / 出站五闸照常。
    const leadText = el('textarea', { class: 'navx-textarea', rows: 2, placeholder: '跟领航员说一句——不指定猫，由它自己判断（等同群里 @ 它说这句）' });
    const leadBtn = el('button', { class: 'btn', text: '交给领航员' });
    const leadResult = el('pre', { class: 'navx-pre' });
    const leadCard = el('section', { class: 'navx-card navx-lead' },
      cardHead(el, '领航员输入', el('span', { class: 'navx-count', text: '不选猫' })),
      el('div', { class: 'navx-card-body' },
        el('label', { class: 'navx-field' },
          el('span', { text: '交给群里的领航员' }),
          el('span', { class: 'navx-tip', text: '落到「回消息群」' })),
        leadText,
        el('div', { class: 'navx-row' },
          el('span', { class: 'navx-grow' }),
          leadBtn
        ),
        leadResult
      )
    );

    // ── 对猫说话（Rushiera 2026-11-11 · 右栏下半）──
    // 猫会话改成只读映射（`?embed=1` 隐藏宿主输入区）之后，「给某只猫说一句」的入口落在这里：
    // 目标猫 = 猫条 / 右键选中的那只（state.cat），走单体 `POST /api/nav/send`（与群内 @ 同一条投递链）。
    const talkWho = el('span', { class: 'navx-count', text: '未选猫' });
    const talkInput = el('input', { class: 'navx-input', placeholder: '对选中的猫说一句…（Enter 发送）' });
    const talkPause = el('button', { class: 'navx-mini', text: '停止', title: '中止这只猫当前回合（cat.pause——已生成内容保留，前文格式修复）' });
    const talkContinue = el('button', { class: 'navx-mini', text: '继续', title: '不追加消息，用当前前文再发一次（cat.continue——仅空闲受理，忙时排队）' });
    const talkBtn = el('button', { class: 'btn', text: '发送' });
    const talkResult = el('pre', { class: 'navx-pre' });
    const talkCard = el('section', { class: 'navx-card navx-talk' },
      el('div', { class: 'navx-card-head' }, el('h3', { text: '对猫说话' }), talkWho),
      el('div', { class: 'navx-card-body' },
        talkInput,
        el('div', { class: 'navx-row' },
          talkPause, talkContinue,
          el('span', { class: 'navx-grow' }),
          talkBtn
        ),
        talkResult
      )
    );
    const leadCol = el('div', { class: 'navx-leadcol' }, leadCard, talkCard);

    // 一次性动作回执（整理重启等短回执）——投递卡撤掉后（Rushiera 2026-11-10）由这行承接；
    // 平时为空（`:empty` 不占版面），写完 6 秒自动清。
    const noticeBox = el('div', { class: 'navx-notice' });

    // ── 生成能力卡 ──
    const seg = el('div', { class: 'navx-seg' });
    const segButtons = new Map();
    for (const item of KINDS) {
      const button = el('button', { type: 'button', text: item.label, onclick: () => { state.kind = item.id; renderFields(); renderSeg(); } });
      segButtons.set(item.id, button);
      seg.appendChild(button);
    }
    const genFields = el('div', { class: 'navx-card-body', style: { padding: '10px 0 0' } });
    const genBtn = el('button', { class: 'btn', text: '提交' });
    const genResult = el('pre', { class: 'navx-pre' });
    const genCard = el('section', { class: 'navx-card' },
      cardHead(el, '生成能力', el('span', { class: 'navx-count', text: '按回消息群落地' })),
      el('div', { class: 'navx-card-body' },
        seg,
        genFields,
        el('div', { class: 'navx-row' },
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

    // ── 猫实体条（一整行 · 对齐并发协议 .catbar）——点 = 选中（投递目标 + 详情），不是发消息
    const catCount = el('span', { class: 'navx-count', text: '0' });
    const catsBox = el('div', { class: 'navx-catbar-items' });
    const catBar = el('div', { class: 'navx-catbar' },
      el('span', { class: 'navx-catbar-label', text: '猫' }),
      catCount,
      catsBox
    );

    // ── 猫会话卡（Rushiera 2026-11-10 定稿 · 11-11 改名「猫会话」并让出右侧约 15% 给领航员输入）──
    // 直接把 mau 的猫对话页**拍在这里**（跨源 iframe，只显示不注入）——与并发协议实体猫同源，
    // 只是不做弹层、不写标题行：点猫条选中的猫跟着换，页面自己跑。
    // 标题用「猫会话」——与本页最末的「单猫详情」（原始 JSON）区分开。
    const catFrame = el('iframe', { class: 'navx-catframe', src: 'about:blank', title: '猫对话页' });
    const catFrameNote = el('span', { class: 'navx-count', text: '' });
    const catLinkCard = el('section', { class: 'navx-card' },
      el('div', { class: 'navx-card-head' }, el('h3', { text: '猫会话' }), catFrameNote),
      el('div', { class: 'navx-card-body' }, catFrame)
    );

    // ── 单猫详情原始数据（原卡 · Rushiera 2026-11-10 沉到页面最下面）──
    const detailTitle = el('h3', { text: '单猫详情' });
    const detailBox = el('pre', { class: 'navx-pre navx-tall', text: '右键猫条上的任意一只猫 → 详情 / 截图 / 新会话 / 整理。' });
    const detailCard = el('section', { class: 'navx-card navx-span3' },
      el('div', { class: 'navx-card-head' }, detailTitle,
        el('span', { class: 'navx-tip', text: '原始数据 · 右键猫条「详情」拉取' })),
      el('div', { class: 'navx-card-body' }, detailBox)
    );

    // ── 截图卡 ──
    const shotCount = el('span', { class: 'navx-count', text: '未截' });
    const shotsBox = el('div', { class: 'navx-shots' },
      el('p', { class: 'navx-empty', text: '点猫条里某只猫的「截图」出一张会话卡（只读，不给猫发消息）。长会话按段分张。' })
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
    // 主区两栏（Rushiera 2026-11-11）：左 = 猫会话（内嵌猫页，降宽让出右侧），右 = 领航员输入（约 15%）；
    // 生成能力 / 高级依次往下放；原 JSON 详情卡（「单猫详情」）沉在通栏最末。
    const main = el('div', { class: 'navx-split' }, catLinkCard, leadCol);
    const stack = el('div', { class: 'navx-stack' }, main, genCard, advCard);
    const foot = el('div', { class: 'navx-foot' }, lineCard, activityCard, artCard, logCard, shotCard, detailCard);

    host.appendChild(el('div', { class: 'navx' },
      hero,
      catBar,
      noticeBox,
      stack,
      foot
    ));

    refs = {
      dot, heroMain, heroTitle, heroSub, toggle, refreshBtn, chatSelect, kindBar, kindNote,
      statIdle, statWatch, statBusy, statVip, statMode,
      leadText, leadBtn, leadResult, notice: noticeBox, sendResult: noticeBox,
      talkWho, talkInput, talkBtn, talkResult,
      talkPause, talkContinue,
      seg, segButtons, genFields, genTarget, genBtn, genResult,
      advIntentInput, advIntentBtn, advIntentOut, advModeOut, advShadowBtn, advLiveBtn, advPersonaOut, advHubOut, advDetails,
      catCount, catsBox, catBar, catFrame, catFrameNote,
      detailTitle, detailBox, shotCount, shotsBox,
      artCount, artClear, artBox, actCount, activityBox, lineCount, lineBox, logCount, logBox
    };

    bindEvents();
    renderSeg();
    renderFields();

    if (!state.menuBound) {
      state.menuBound = true;
      document.addEventListener('click', closeCatMenu);
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCatMenu(); });
      window.addEventListener('blur', closeCatMenu);
      window.addEventListener('resize', closeCatMenu);
    }
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
      const value = String(r.chatSelect.value || '');
      // 一个下拉三态：'' = 不发群消息 · 'follow' = 消息跟随当前群 · '<群号>' = 指定群（服务端同切回消息群）
      r.chatSelect.disabled = true;
      const result = await act('/api/nav/target', { target: value });
      r.chatSelect.disabled = false;
      if (result.ok !== true) {
        r.genResult.textContent = `回消息群设置失败：${result.error || '未知原因'}`;
      }
      await refresh(false);
    });

    // 发群类型六个按钮（v1.62）——点一下改一个类型；「全开 / 全关」走 mode 总控。
    // 服务端落盘后重渲染：按钮状态只认接口回执，不在前端猜。
    r.kindBar.addEventListener('click', async (event) => {
      const target = event.target;
      const btn = target && target.closest ? target.closest('.navx-dkind') : null;
      if (!btn || btn.disabled) return;
      const all = btn.dataset.all === '1';
      const kind = String(btn.dataset.kind || '');
      if (!all && !kind) return;
      btn.disabled = true;
      r.kindNote.textContent = '';
      const payload = all
        ? { mode: String(btn.dataset.mode || 'all') }
        : { kinds: { [kind]: btn.dataset.next === '1' } };
      const result = await act('/api/nav/deliver', payload);
      btn.disabled = false;
      if (result.ok !== true) {
        r.kindNote.textContent = `设置失败：${result.error || '未知原因'}`;
        return;
      }
      await refresh(false);
    });

    // 领航员输入框（2026-11-10）——不选猫，走业务面真实入站链（等同群里本人 @ 它说这句）：
    // 白名单 → 存档 → 档位 / @ 触发 → 出站五闸，一条链都不跳。
    // 落群 = 单体的「回消息群」（activeChat）；为空时业务面取允许名单里的第一个群。
    r.leadBtn.addEventListener('click', async () => {
      const text = String(r.leadText.value || '').trim();
      if (!text) { r.leadResult.textContent = '先写一句话。'; return; }
      const chat = String((state.status && state.status.activeChat) || '');
      r.leadBtn.disabled = true;
      r.leadResult.textContent = '交给领航员…（等它跑完一轮，回复看群里 / 活动流）';
      const result = await act('/api/biz/nav/lead', { text, chat });
      r.leadBtn.disabled = false;
      r.leadResult.textContent = formatLead(result);
      await refresh(false);
    });

    // 对猫说话（2026-11-11）——目标 = 当前选中的猫（state.cat）；未选猫 / 空话直接回执，不静默。
    async function talkSubmit() {
      const key = String(state.cat || '');
      const text = String(r.talkInput.value || '').trim();
      if (!key) { r.talkResult.textContent = '先点猫条选一只猫。'; return; }
      if (!text) { r.talkResult.textContent = '先写一句话。'; return; }
      const name = catNameOf(key);
      r.talkBtn.disabled = true;
      r.talkResult.textContent = `投递中 → ${name}…`;
      const result = await act('/api/nav/send', { key, text });
      r.talkBtn.disabled = false;
      if (result.ok !== true) {
        r.talkResult.textContent = `失败：${result.error || '未知原因'}`;
      } else {
        r.talkResult.textContent = `已投给 ${name}（回复按发群类型开关落地）`;
        r.talkInput.value = '';
      }
      await refresh(false);
    }
    r.talkBtn.addEventListener('click', talkSubmit);
    r.talkInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      talkSubmit();
    });

    // 停止 / 继续（2026-11-11）——猫页输入区被 embed 隐藏后，这两个动作搬到面板；
    // 语义与宿主 `#chatPause` / `#chatContinue` 一致，落点 `POST /api/nav/ctl` → `cat.pause` / `cat.continue`。
    async function catCtl(action) {
      const key = String(state.cat || '');
      if (!key) { r.talkResult.textContent = '先点猫条选一只猫。'; return; }
      const name = catNameOf(key);
      const label = action === 'pause' ? '停止' : '继续';
      r.talkResult.textContent = `${label}中 → ${name}…`;
      const result = await act('/api/nav/ctl', { action, key });
      const reason = result.error || (result.reply && (result.reply.error || result.reply.message)) || '';
      r.talkResult.textContent = result.ok === true
        ? `${label}已受理 → ${name}`
        : `${label}未受理 → ${name}${reason ? `：${String(reason).slice(0, 160)}` : ''}`;
      await refresh(false);
    }
    r.talkPause.addEventListener('click', () => catCtl('pause'));
    r.talkContinue.addEventListener('click', () => catCtl('continue'));

    // 投递卡已撤（Rushiera 2026-11-10）——「给某只猫下一条指令」走猫条右键菜单 / 群内 @，
    // 面板上不再有「目标猫 + 指令 + 投递」这套控件。
    r.genBtn.addEventListener('click', async () => {
      const payload = collectGen();
      if (payload.error) { r.genResult.textContent = payload.error; return; }
      const target = state.deliverTarget;
      const toGroup = target !== '';
      const chat = target === 'follow'
        ? String((state.status && state.status.activeChat) || '')
        : String(target || '');
      if (toGroup && !chat) {
        r.genResult.textContent = '选了「消息跟随」但还没有回消息群——在下拉里挑一个具体的群，或改回「不发群消息」。';
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

    r.artClear.addEventListener('click', async () => {
      r.artClear.disabled = true;
      await act('/api/nav/artifacts/clear', {});
      r.artClear.disabled = false;
      await refresh(false);
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
   * 领航员输入回执 → 一段人话。
   *
   * @param {object} result `/api/biz/nav/lead` 回执
   * @returns {string} 文本
   */
  function formatLead(result) {
    if (!result) return '无回执。';
    if (result.ok !== true) return `未受理：${result.error || '未知原因'}`;
    return `已交给领航员（群 ${result.chat || '-'}）：${result.text || ''}\n这条按群消息算——回复在群里，进度看活动流。`;
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
    renderCatFrame();
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

    // 回消息群 / 产物落地——一个下拉框（头两项当「特殊的群」：不发群消息 / 消息跟随）
    const current = String(s.activeChat || '');
    const ids = state.groups.map((row) => row.id);
    if (current && !ids.includes(current)) state.groups.unshift({ id: current, name: '（当前回消息群）' });
    // 落地档从服务端读——手工设置立即落盘，开关领航员的回落也只发生在 open / close 那一次；
    // 前端不自行改写（否则「手工指定」会被轮询顺手改掉）。
    state.deliverTarget = String(s.deliverTarget || '');
    const picked = state.deliverTarget && state.deliverTarget !== 'follow' ? state.deliverTarget : current;
    if (picked && !state.groups.some((row) => row.id === picked)) {
      state.groups.push({ id: picked, name: '（已指定群）' });
    }
    const pickedRow = state.groups.find((row) => row.id === picked);
    const pickedName = picked ? (pickedRow ? (pickedRow.name || pickedRow.id) : picked) : '未定';
    refs.chatSelect.textContent = '';
    refs.chatSelect.appendChild(el('option', { value: '', text: '不发群消息' }));
    refs.chatSelect.appendChild(el('option', { value: 'follow', text: `消息跟随（${pickedName}）` }));
    for (const row of state.groups) {
      refs.chatSelect.appendChild(el('option', {
        value: row.id,
        text: row.name ? `${row.name}（${row.id}）` : row.id
      }));
    }
    refs.chatSelect.value = state.deliverTarget || '';
    refs.chatSelect.title = state.deliverTarget
      ? `产物落地：发到 ${pickedName}`
      : '产物落地：不发群消息（只落产物区）';
    // 目标提示放在标签这一行（上面）
    refs.genTarget.textContent = state.deliverTarget ? `→ ${pickedName}` : '→ 不发群';

    // 发群类型六个按钮（v1.62）——五类各自开关 + 「全开 / 全关」总控。
    // 状态只从服务端读（手工设置立即落盘；开关领航员的整组回落只发生在 open / close 那一次）。
    const kinds = (s.deliver && typeof s.deliver === 'object') ? s.deliver : {};
    const KINDS = [
      ['reply', '猫回复'],
      ['progress', '进度播报'],
      ['shot', '我的截图'],
      ['media', '生成产物'],
      ['receipt', '系统回执']
    ];
    const onCount = KINDS.filter(([key]) => kinds[key] === true).length;
    const allOn = onCount === KINDS.length;
    refs.kindBar.textContent = '';
    const allBtn = el('button', {
      class: `navx-dkind all${allOn ? ' on' : ''}`,
      title: allOn ? '五类都不发群（全关）' : '五类都发群（全开）',
      text: allOn ? '全关' : '全开'
    });
    allBtn.dataset.all = '1';
    allBtn.dataset.mode = allOn ? 'none' : 'all';
    refs.kindBar.appendChild(allBtn);
    for (const [key, label] of KINDS) {
      const on = kinds[key] === true;
      const btn = el('button', {
        class: `navx-dkind${on ? ' on' : ''}`,
        title: on ? `${label}：现在发群（点一下关掉）` : `${label}：现在不发群（点一下打开）`,
        text: label
      });
      btn.dataset.kind = key;
      btn.dataset.next = on ? '0' : '1';
      refs.kindBar.appendChild(btn);
    }
    if (refs.kindNote) refs.kindNote.textContent = '';

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

    // 选中猫兜底（投递卡撤掉后没有「目标猫」下拉了，选猫只靠猫条 / 右键菜单）——
    // 清单里没有就取第一只，否则单猫详情那格会指着已经不存在的猫。
    const cats = sortCats(Array.isArray(s.cats) ? s.cats : []);
    const names = cats.map((row) => String(row.id || row.name || '')).filter(Boolean);
    if (!names.includes(state.cat)) state.cat = names[0] || 'majordomo';
  }

  /**
   * 猫群列表（状态点 + 名 + 端口/状态 + 四个动作）。
   *
   * @returns {void}
   */
  /** 当前打开的猫条右键菜单（同一时刻只允许一个）。 */
  let catMenu = null;

  /**
   * 关掉右键菜单（点任意处 / Esc / 选中菜单项都走这里）。
   *
   * @returns {void}
   */
  function closeCatMenu() {
    if (catMenu && catMenu.parentNode) catMenu.parentNode.removeChild(catMenu);
    catMenu = null;
  }

  /**
   * 打开猫条右键菜单——对猫的四条指令都在这里（详情 / 截图 / 新会话 / 整理）。
   *
   * @param {MouseEvent} event 右键事件（取其坐标）
   * @param {string} key 猫的寻址键
   * @param {string} label 菜单头显示的名字
   * @param {boolean} resetting 该猫是否正在整理（整理项置灰）
   * @returns {void}
   */
  function openCatMenu(event, key, label, resetting) {
    event.preventDefault();
    event.stopPropagation();
    closeCatMenu();
    const el = ui().el;
    if (!el) return;
    state.cat = key;
    renderCats();

    /**
     * 建一个菜单项。
     *
     * @param {string} text 文案
     * @param {Function} run 点击动作
     * @param {boolean} [disabled] 是否置灰
     * @returns {Element} 菜单项
     */
    const item = (text, run, disabled) => el('button', {
      class: 'navx-menu-item',
      text,
      disabled: !!disabled,
      onclick: () => { closeCatMenu(); run(); }
    });

    catMenu = el('div', { class: 'navx-menu', style: { left: `${event.clientX}px`, top: `${event.clientY}px` } },
      el('div', { class: 'navx-menu-head', text: label }),
      item('详情', () => showDetail(key)),
      item('截图', () => shoot(key)),
      item('新会话', () => newSession(key)),
      item((state.acting.has(`reset:${key}`) || resetting) ? '整理中…' : '整理', () => resetSession(key),
        state.acting.has(`reset:${key}`) || resetting)
    );
    document.body.appendChild(catMenu);
    // 贴边收口——右下角右键时菜单不冲出视口
    const box = catMenu.getBoundingClientRect();
    if (box.right > window.innerWidth - 8) catMenu.style.left = `${Math.max(8, window.innerWidth - box.width - 8)}px`;
    if (box.bottom > window.innerHeight - 8) catMenu.style.top = `${Math.max(8, window.innerHeight - box.height - 8)}px`;
  }

  function renderCats() {
    const el = ui().el;
    if (!el || !refs) return;
    const s = state.status || {};
    const cats = sortCats(Array.isArray(s.cats) ? s.cats : []);
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
      refs.talkWho.textContent = '未选猫';
      return;
    }

    const now = Date.now();
    for (const row of cats) {
      const key = String(row.id || row.name || '');
      const runState = String(row.runState || row.phase || '');
      const resetting = resettingKeys.has(key) || resettingKeys.has(String(row.name || ''));
      const off = row.running === false;
      const calls = Number(row.calls) || 0;
      const nctx = Number(row.contextCount) || 0;
      // 与并发协议 catChipHtml 同判据：有回复 = 空闲且末条是猫；异常 = 有前文、空闲、末条不是猫
      const news = !off && runState === 'idle' && row.speaker === 'cat';
      const stalled = !off && runState === 'idle' && row.speaker !== 'cat' && nctx > 1;
      // 档位优先级：整理中（本项目本地态）→ 未运行 → 收工三档 → 有回复 → 异常 → 空闲 → 跑动
      let st;
      if (resetting) st = { cls: 'ct-reset', text: '整理中' };
      else if (off) st = { cls: 'ct-off', text: '未运行' };
      else if (row.overwork === 'doing') st = { cls: 'ct-overdoing', text: '正在收工' };
      else if (row.overwork === 'done') st = { cls: 'ct-overdone', text: '已收工核销', ok: true };
      else if (row.overwork === 'doneOpen') st = { cls: 'ct-overdone', text: '有未尽事宜' };
      else if (news) st = { cls: 'ct-news', text: '有回复' };
      else if (stalled) st = { cls: 'ct-stalled', text: '异常' };
      else if (runState === 'idle') st = { cls: 'ct-idle', text: '空闲' };
      else st = { cls: 'ct-busy', text: '跑动' };
      const act = ACTION_TEXT[runState] || '';
      const tokK = Math.round((Number(row.context) || 0) / 1000);
      const agoMs = row.lastActiveAt ? now - Number(row.lastActiveAt) : 0;
      const tip = [
        `${row.name || key}${row.special ? '（主干）' : ''} · 端口 ${row.port || '—'}`,
        `状态 ${st.text}${runState ? `（${runState}）` : ''}`,
        row.mount ? `上工 ${row.mount}` : '',
        row.overwork === 'doing' ? '正在收工：人已说收工 / 报告还没出' : '',
        row.overwork === 'done' ? `已收工核销${row.overworkHits ? `：${row.overworkHits}` : ''}` : '',
        row.overwork === 'doneOpen' ? `有未尽事宜：${row.overworkHits || '—'}` : '',
        news ? '里面有回复：末条是猫说的（人还没接话）' : '',
        stalled ? `异常：前文 ${nctx} 条，但当前空闲且末条不是猫的回复` : '',
        tokK ? `前文 ${tokK}k tok · ${nctx} 条` : `前文 ${nctx} 条`,
        `本轮调用 ${calls} 次 · 累计 ${Number(row.requests) || 0} 次${row.round ? ` · 第 ${row.round} 轮` : ''}`,
        agoMs > 0 ? `最近活动 ${span(agoMs)}前` : '',
        row.pending ? `排队 ${row.pending} 条` : ''
      ].filter(Boolean).join('\n');
      refs.catsBox.appendChild(el('div', {
        class: `navx-cat ${st.cls}${key === state.cat ? ' active' : ''}`,
        title: tip,
        onclick: () => { state.cat = key; renderCats(); },
        oncontextmenu: (event) => openCatMenu(event, key, String(row.name || key), resetting)
      },
        el('span', { class: 'navx-cat-dot' }),
        el('span', { class: 'navx-cat-name', text: String(row.name || key) }),
        row.mount && !String(row.name || '').includes(row.mount)
          ? el('span', { class: 'navx-cat-tag', text: row.mount }) : null,
        el('span', { class: `navx-pill${st.ok ? ' ok' : ''}`, text: st.text }),
        act ? el('span', { class: 'navx-cat-act', text: act }) : null,
        tokK ? el('span', { class: 'navx-cat-ctx', text: `${tokK}k` }) : null,
        calls ? el('span', { class: 'navx-cat-calls', text: `${calls} 次` }) : null
      ));
    }
    refs.talkWho.textContent = state.cat ? catNameOf(state.cat) : '未选猫';
    renderCatFrame();
  }

  /**
   * 端口 → 该猫在 mau 里的对话页地址（与并发协议 `catUrlOf` 同口径 + `?embed=1` 只读映射）。
   *
   * `?embed=1` 由宿主 chat 页识别：隐藏输入区（输入框 / 输入·流式切换 / 停止·继续·发送动作列），
   * 对话区 / 状态区 / 桌宠照常渲染——面板里只「看」，说话走右栏「对猫说话」。
   *
   * @param {number} port 猫的端口
   * @returns {string} URL（无端口返回空串）
   */
  function catUrlOf(port) {
    const n = Number(port);
    if (!n) return '';
    return `http://${location.hostname || '127.0.0.1'}:${n}/?embed=1`;
  }

  /**
   * 猫 key → 显示名（找不到就回 key 本身）。
   *
   * @param {string} key 猫 key
   * @returns {string} 显示名
   */
  function catNameOf(key) {
    const cats = Array.isArray(state.status && state.status.cats) ? state.status.cats : [];
    const row = cats.find((item) => String(item.id || '') === String(key) || String(item.name || '') === String(key));
    return row ? String(row.name || key) : String(key);
  }

  /**
   * 猫会话卡——把选中的猫的 mau 对话页直接内嵌（同并发协议实体猫的 `chatframe`）。
   *
   * @returns {void}
   */
  function renderCatFrame() {
    if (!refs) return;
    const key = String(state.cat || '');
    const cats = sortCats(Array.isArray(state.status && state.status.cats) ? state.status.cats : []);
    const row = cats.find((item) => String(item.id || '') === key || String(item.name || '') === key);
    const port = row ? Number(row.port) || 0 : 0;
    const live = Boolean(row && row.running !== false && port);
    const url = live ? catUrlOf(port) : 'about:blank';
    // 🔴 只在地址变化时赋值——每 5 秒轮询重设 src 会把猫页面整个刷掉（滚动 / 输入全丢）。
    if (refs.catFrame.dataset.url !== url) {
      refs.catFrame.dataset.url = url;
      refs.catFrame.src = url;
    }
    refs.catFrame.title = row ? `${row.name || key} 对话页` : '猫对话页';
    // 失败必须可见：没在跑的猫给一片空白会让人以为页面坏了——卡头右侧挂一句短的。
    refs.catFrameNote.textContent = live ? '' : (row ? '未运行' : '没有这只猫');
  }

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

  /** 一次性回执计时器（同一条消息重写时续期）。 */
  let noticeTimer = null;

  /**
   * 一次性回执——写进页面顶部那行（6 秒后自动清，空时 `:empty` 不占版面）。
   *
   * @param {string} text 文案
   * @returns {void}
   */
  function notify(text) {
    if (!refs || !refs.notice) return;
    refs.notice.textContent = String(text ?? '');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (refs && refs.notice) refs.notice.textContent = '';
    }, 6000);
  }

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
    notify(result.ok === true
      ? `${key}：新会话已请求（只清前文，不交接）`
      : `${key}：新会话失败——${result.error || '未知原因'}`);
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
