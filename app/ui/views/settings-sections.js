// app/ui/views/settings-sections.js —— 业务设置 · 各分节渲染（R5-L8 批 1 / R6-L2 批 2）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L8**（与 `settings.js` 同线，无跨线冲突）；
//       R6 任务卡 §二 表续接同一写面（L2）
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`；块内不写 fetch，一律走 `ctx.api`）
// 状态：批 1 ✅ api / chat / allow 三节；批 2 ✅ 补齐 search / memory / persona / desktop /
//       onebot / tools / prompt 七节 + 三项补强（切节保值在 `settings.js` / 批量价格编辑 /
//       内联勾选群好友 / 分群档位与分群峰谷）
// 回执：`reports/R5-L8.md`（批 1 §一–§八 / 批 2 §九）
//
// 分节清单（原版 `_unpack/resources/app/ui/app/06-settings-render.js` 对位）：
//   api :171 ✅ · search :262 ✅ · memory :369 ✅ · persona :395 ✅ · allow :670 ✅ · chat :816 ✅
//   desktop :959 ✅ · onebot :1000 ✅ · tools :1527 ✅ · prompt-preview :1652 ✅
//
// 渲染函数签名为 `(ctx) → Element`：
//   ctx.config   当前业务面配置（`GET /api/biz/config` 脱敏值；密钥字段已被删、补 hasXxx）
//   ctx.h        DOM 小件（`el / esc / hint / badge / button / field / row / input / selectOf / checkbox / fold`）
//   ctx.save     `(patch) => Promise`——写回后自动读回并重绘（禁本地乐观更新）
//   ctx.api      `(path, opts) => Promise`——打单体端口（走 L9 代理层）
//   ctx.notice   `(text, kind) => void`——页面顶部提示行
//
// 口径（任务卡 §1.3 + §四 L8）：指令类面照搬原版形态——控件在、标签对、分组对、不报 JS 错即过；
//   写链路是否真通本轮不判；但**读回核对**只要业务面可达就做（`ctx.save` 内已含）。

(function () {
  'use strict';

  /** 失败态文案前缀（与 `settings.js` 同源）。 */
  const UNREACHABLE = '业务面不可达（127.0.0.1:3210）';

  /**
   * 提供商目录缓存（`GET /api/biz/providers`；只为在 api 节显示可读的模型名）。
   *
   * @type {{items: Array, loaded: boolean, error: string}}
   */
  const providers = { items: [], loaded: false, error: '' };

  /**
   * 取嵌套值（路径缺任一环即回落到默认值）。
   *
   * @param {object} obj 源对象
   * @param {string[]} path 路径
   * @param {*} fallback 兜底
   * @returns {*} 值
   */
  function get(obj, path, fallback) {
    let cur = obj;
    for (const key of path) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[key];
    }
    return cur === undefined || cur === null ? fallback : cur;
  }

  /**
   * 数值输入项（回车 / 失焦即写回；非法值不写）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} label 标签
   * @param {*} value 现值
   * @param {object} [opts] `{min, max, step, note}`
   * @param {Function} onsave `(n) => void`
   * @returns {Element} `.field`
   */
  function numField(ctx, label, value, opts, onsave) {
    const o = opts || {};
    const node = ctx.h.input({
      type: 'number',
      value: value,
      min: o.min,
      max: o.max,
      step: o.step,
      onchange: (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        onsave(n);
      }
    });
    return ctx.h.field(label, node, o.note || '');
  }

  /**
   * 文本输入项。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} label 标签
   * @param {*} value 现值
   * @param {object} [opts] `{placeholder, note, secret}`
   * @param {Function} onsave `(s) => void`
   * @returns {Element} `.field`
   */
  function textField(ctx, label, value, opts, onsave) {
    const o = opts || {};
    const node = ctx.h.input({
      type: o.secret ? 'password' : 'text',
      value: value,
      placeholder: o.placeholder || '',
      onchange: (raw) => {
        // 密钥框：留空 = 不改（脱敏视图里原值本来就不在场）
        if (o.secret && String(raw || '') === '') return;
        onsave(String(raw === null || raw === undefined ? '' : raw));
      }
    });
    return ctx.h.field(label, node, o.note || '');
  }

  /**
   * 开关项。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} label 标签
   * @param {*} checked 现值（严格 `=== true` 才算开）
   * @param {string} [note] 说明
   * @param {Function} onsave `(b) => void`
   * @returns {Element} `.field`
   */
  function boolField(ctx, label, checked, note, onsave) {
    return ctx.h.checkbox({ checked: checked === true, label: label, note: note || '', onchange: (b) => onsave(b) });
  }

  /**
   * 下拉项。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} label 标签
   * @param {*} value 现值
   * @param {Array} options `[[value, label]]`
   * @param {string} [note] 说明
   * @param {Function} onsave `(v) => void`
   * @returns {Element} `.field`
   */
  function selectField(ctx, label, value, options, note, onsave) {
    const node = ctx.h.selectOf({ value: value, options: options, onchange: (v) => onsave(v) });
    return ctx.h.field(label, node, note || '');
  }

  /**
   * 逗号分隔清单 → 去空去重数组。
   *
   * @param {string} text 输入文本
   * @returns {string[]} 数组
   */
  function splitList(text) {
    const seen = new Set();
    const out = [];
    String(text || '').split(/[,，\s]+/).forEach((raw) => {
      const value = raw.trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    });
    return out;
  }

  /**
   * 保存并提示（`ctx.save` 自带读回与重绘）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} patch 配置补丁
   * @param {string} [okText] 成功提示（默认由 `ctx.save` 给）
   * @returns {void}
   */
  function push(ctx, patch, okText) {
    const p = ctx.save(patch);
    if (p && typeof p.then === 'function' && okText) {
      p.then((r) => { if (r && r.ok) ctx.notice(okText); });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 一、模型 API（原版 06-settings-render.js:171 renderApiSection）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 按模型单价表（`api.modelPrices` = `{ [模型 id]: { in, out, cached } }`）。
   *
   * 原版是模态框；这里做成**内联表**——一行一个模型，行内直接改。写回走
   * `__replace__` 整体替换该映射（`deepMerge` 普通合并不删键，删行必须整体换）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} api `config.api`
   * @returns {Element} 表体
   */
  function priceTableOf(ctx, api) {
    const h = ctx.h;
    const prices = (api && api.modelPrices) || {};
    const ids = Object.keys(prices);
    const box = h.el('div', {});

    box.appendChild(h.el('div', { class: 'hint', text: `已有独立单价的模型 ${ids.length} 个（有记录即不再用官方价格表与全局兜底单价）` }));

    const writeAll = (next) => push(ctx, { api: { modelPrices: { __replace__: next } } });

    ids.forEach((id) => {
      const entry = prices[id] || {};
      const next = Object.assign({}, prices);
      const commit = (key, value) => {
        next[id] = Object.assign({}, next[id] || {}, { [key]: value });
        writeAll(next);
      };
      box.appendChild(h.row([
        h.field(id, [h.input({
          type: 'number', min: 0, step: 0.01, value: entry.in,
          onchange: (raw) => { const n = Number(raw); if (Number.isFinite(n)) commit('in', n); }
        })], '输入单价'),
        h.field('', [h.input({
          type: 'number', min: 0, step: 0.01, value: entry.out,
          onchange: (raw) => { const n = Number(raw); if (Number.isFinite(n)) commit('out', n); }
        })], '输出单价'),
        h.field('', [h.input({
          type: 'number', min: 0, step: 0.01, value: entry.cached,
          onchange: (raw) => { const n = Number(raw); if (Number.isFinite(n)) commit('cached', n); }
        }), h.button('删除', () => {
          const out = Object.assign({}, prices);
          delete out[id];
          writeAll(out);
        })], '缓存命中单价')
      ]));
    });

    const modelInput = h.input({ type: 'text', placeholder: '模型 id，如 deepseek-v4.1-flash' });
    const inInput = h.input({ type: 'number', min: 0, step: 0.01, placeholder: '输入' });
    const outInput = h.input({ type: 'number', min: 0, step: 0.01, placeholder: '输出' });
    box.appendChild(h.el('div', { style: { marginTop: '8px' } },
      h.row([h.field('新增模型单价', modelInput, ''), h.field('', inInput, '输入'),
        h.field('', outInput, '输出')]),
      h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h.button('＋ 添加', () => {
          const id = String(modelInput.value || '').trim();
          if (!id) { ctx.notice('模型 id 不能为空', 'fail'); return; }
          const out = Object.assign({}, prices);
          out[id] = {
            in: Number(inInput.value) || 0,
            out: Number(outInput.value) || 0,
            cached: 0
          };
          writeAll(out);
        }))));

    return box;
  }

  /**
   * 模型 API 分节：模型与渠道 / 备选模型降级 / 成本核算。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderApi(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const api = c.api || {};
    const root = h.el('div', { class: 'folds' });

    // ── 卡 1：模型与渠道 ──
    const providerList = providers.loaded ? providers.items : [];
    const current = providerList.find((p) => String(p.id) === String(api.provider || '')) || null;
    const modelName = (current && (current.modelNames || {})[api.model]) || api.model || '未选模型';

    const providerHint = h.hint(current
      ? `当前：${current.displayName || current.id} · ${modelName} @ ${current.baseURL || '（未填 BaseURL）'}`
        + (current.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key')
      : '尚未选择模型：可直接填模型 id 与 BaseURL（提供商的显示名由 /api/providers 提供，取不到时显示裸 id）');

    const providerOptions = [['', '（不绑定提供商）']].concat(providerList.map((p) => [p.id, p.displayName || p.id]));

    const card1 = h.fold({
      icon: '🔑',
      title: '模型与渠道',
      sub: '提供商 / 模型 / BaseURL / 模态',
      val: modelName,
      open: true,
      body: [
        providerHint,
        providerList.length
          ? selectField(ctx, '提供商', api.provider || '', providerOptions, '', (v) => push(ctx, { api: { provider: v } }))
          : textField(ctx, '提供商 id', api.provider || '', { note: '（未取到目录）' }, (v) => push(ctx, { api: { provider: v } })),
        textField(ctx, '模型 id', api.model || '', { note: '如 deepseek-v4.1-flash' }, (v) => push(ctx, { api: { model: v } })),
        textField(ctx, 'BaseURL', api.baseUrl || '', { note: 'OpenAI 兼容端点' }, (v) => push(ctx, { api: { baseUrl: v } })),
        textField(ctx, 'API Key', '', {
          secret: true,
          placeholder: api.hasKey ? '已保存（不显示；留空 = 不改）' : '未保存（填了就写回）'
        }, (v) => push(ctx, { api: { apiKey: v } })),
        h.row([
          textField(ctx, '图片模型', api.visionModel || '', { note: '留空 = 用主模型' }, (v) => push(ctx, { api: { visionModel: v } })),
          textField(ctx, '视频模型', api.videoModel || '', { note: '留空 = 用主模型' }, (v) => push(ctx, { api: { videoModel: v } }))
        ]),
        selectField(ctx, '视频读取方式', api.videoMode || 'auto', [
          ['auto', 'auto（有 videoModel 走原生，否则抽帧）'],
          ['native', 'native（强制原生视频输入）'],
          ['frames', 'frames（强制抽帧）'],
          ['off', 'off（只给元信息）']
        ], '', (v) => push(ctx, { api: { videoMode: v } })),
        h.row([
          boolField(ctx, '模型支持图片输入', api.vision, '', (b) => push(ctx, { api: { vision: b } })),
          boolField(ctx, '模型支持视频输入', api.video, '关掉则 GIF 按图片发', (b) => push(ctx, { api: { video: b } }))
        ]),
        h.hint('改动即时生效（自动保存）——保存后自动读回核对，读回值即页面显示值。')
      ]
    });
    root.appendChild(card1);

    // ── 卡 2：备选模型（故障自动降级）──
    const fallback = Array.isArray(api.fallbackModels) ? api.fallbackModels.slice() : [];
    const fbBody = h.el('div', {});
    fallback.forEach((entry, index) => {
      const modelInput = h.input({
        type: 'text',
        value: (entry && entry.model) || '',
        placeholder: '模型 id',
        onchange: (v) => {
          fallback[index] = Object.assign({}, fallback[index], { model: String(v || '').trim() });
        }
      });
      const provInput = h.input({
        type: 'text',
        value: (entry && entry.provider) || '',
        placeholder: '提供商 id（留空沿用主模型）',
        onchange: (v) => {
          fallback[index] = Object.assign({}, fallback[index], { provider: String(v || '').trim() });
        }
      });
      const del = h.button('删除', () => {
        fallback.splice(index, 1);
        push(ctx, { api: { fallbackModels: fallback } });
      });
      fbBody.appendChild(h.field(`备选 ${index + 1}`, [modelInput, provInput, del], ''));
    });
    fbBody.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
      h.button('＋ 添加备选模型', () => {
        fallback.push({ model: '', provider: '' });
        push(ctx, { api: { fallbackModels: fallback } });
      }),
      h.hint('主模型重试仍失败时按顺序尝试；模型 id 留空的条目在保存时按原样保留。')));

    root.appendChild(h.fold({
      icon: '🔄',
      title: '备选模型（故障自动降级）',
      sub: '主模型失败后按顺序重试 · 留空不启用',
      val: `${fallback.length} 条`,
      open: false,
      body: fbBody
    }));

    // ── 卡 3：成本核算 ──
    const priceBody = [
      boolField(ctx, '用内置官方价格表估算', api.useOfficialPrice, '按模型 id 自动匹配；走中转站请关掉',
        (b) => push(ctx, { api: { useOfficialPrice: b } })),
      h.row([
        numField(ctx, '输入单价（元/百万）', api.priceInputPerM, { min: 0, step: 0.01, note: '兜底默认值' },
          (n) => push(ctx, { api: { priceInputPerM: n } })),
        numField(ctx, '输出单价（元/百万）', api.priceOutputPerM, { min: 0, step: 0.01 }, (n) => push(ctx, { api: { priceOutputPerM: n } }))
      ]),
      numField(ctx, '缓存命中单价（元/百万）', api.priceCachedPerM, { min: 0, step: 0.01, note: '留 0 时按输入单价计' },
        (n) => push(ctx, { api: { priceCachedPerM: n } })),
      h.hint('按模型单独的单价（`api.modelPrices`）走下方「批量自定义价格编辑」：有记录的模型不再用官方表，也不受本节全局兜底单价影响。'),
      priceTableOf(ctx, api),
      h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
        h.button('拉取官方价格表', () => {
          ctx.notice('正在拉取价格表…');
          ctx.api('/api/biz/model-prices/refresh', { method: 'POST', body: {} }).then((r) => {
            if (r && r.ok) ctx.notice('价格表已更新');
            else ctx.notice(`拉取失败：${(r && r.error) || '未知原因'}`, 'fail');
          });
        }))
    ];
    root.appendChild(h.fold({
      icon: '💰',
      title: '成本核算',
      sub: '官方价表 / 全局兜底单价',
      val: api.useOfficialPrice === false ? '关' : '开',
      open: false,
      body: priceBody
    }));

    // 首次渲染时补拉提供商目录（只影响显示名，不阻塞表单）
    if (!providers.loaded && !providers.error) {
      ctx.api('/api/biz/providers').then((r) => {
        if (r && r.ok) {
          providers.items = Array.isArray(r.providers) ? r.providers : [];
          providers.loaded = true;
        } else {
          providers.error = (r && r.error) || 'unknown';
        }
        if (providers.loaded) ctx.reload();
      }).catch((error) => { providers.error = String((error && error.message) || error); });
    }

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 二、聊天设置（原版 06-settings-render.js:816 renderChatSection）
  // ══════════════════════════════════════════════════════════════════════

  /** 思考强度档位（原版 :833-842 同表：`(mode, effort)` 二维压成一维）。 */
  const THINKING_OPTIONS = [
    ['off', '关（不思考，明确关闭）'],
    ['', '默认（跟随模型/网关）'],
    ['on-noeffort', '开（明确开启，不指定强度）'],
    ['low', '低（快、省 token）'],
    ['medium', '中'],
    ['high', '高（慢、细致）'],
    ['xhigh', '超高（更慢、更深入）'],
    ['max', '拉满（最强推理）']
  ];

  /** 表情包积极程度（原版 :691-696 同表）。 */
  const STICKER_LEVELS = [
    [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
    [1, '1 · 偶尔（合适时配一张）'],
    [2, '2 · 较积极（优先考虑配图）'],
    [3, '3 · 很积极（表情包爱好者）']
  ];

  /** 响应档位（`store.contextTier`，累积生效）。 */
  const TIER_OPTIONS = [
    ['1', '1 · 仅被艾特'],
    ['2', '2 · 关键词'],
    ['3', '3 · 随机'],
    ['4', '4 · 全响应']
  ];

  /**
   * 思考强度：`(thinkingMode, thinkingEffort)` → 一维下拉值。
   *
   * @param {object} api `config.api`
   * @returns {string} 下拉值
   */
  function thinkingValueOf(api) {
    const mode = (api && api.thinkingMode) || 'auto';
    const effort = (api && api.thinkingEffort) || '';
    if (mode === 'off') return 'off';
    if (effort) return effort;
    return mode === 'on' ? 'on-noeffort' : '';
  }

  /**
   * 一维下拉值 → 写回 patch 片段（`off` / `on-noeffort` / 空 / 具体档位四支）。
   *
   * @param {string} value 下拉值
   * @returns {object} `{thinkingMode, thinkingEffort}`
   */
  function thinkingPatchOf(value) {
    if (value === 'off') return { thinkingMode: 'off', thinkingEffort: '' };
    if (value === 'on-noeffort') return { thinkingMode: 'on', thinkingEffort: '' };
    if (value === '') return { thinkingMode: 'auto', thinkingEffort: '' };
    return { thinkingMode: 'on', thinkingEffort: value };
  }

  /**
   * 分群档位编辑器（补强③：`store.groupSliderPos` / `store.groupPeakPos`）。
   *
   * 只对白名单里的群生效，私聊跟随全局（与 `config.js:271-277` 注释同口径）。
   * 峰谷分群只在 `peakSchedule.enabled` 时有意义；时段（start/end）全局共享。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} store `config.store`
   * @returns {Element} 折叠卡
   */
  function tierEditorOf(ctx, store) {
    const h = ctx.h;
    const c = ctx.config || {};
    const groups = ((c.allow || {}).groups || []).map(String);
    const slider = store.groupSliderPos || {};
    const peakPos = store.groupPeakPos || {};
    const peakOn = Boolean((store.peakSchedule || {}).enabled);
    const body = h.el('div', {});

    if (store.unifiedTier !== false) {
      body.appendChild(h.hint('「所有会话共用一套档位」开启中——分群设置不生效。'));
    } else if (!groups.length) {
      body.appendChild(h.hint('（白名单为空——先在「聊天白名单」里添加群）'));
    } else {
      groups.forEach((gid) => {
        const entry = peakPos[gid] || {};
        body.appendChild(h.fold({
          icon: '👥',
          title: `群 ${gid}`,
          sub: '该群的档位与峰谷',
          val: slider[gid] === undefined ? '跟随全局' : `滑条 ${slider[gid]}`,
          open: false,
          body: [
            numField(ctx, '该群档位滑条（0~100，留空跟随全局）',
              slider[gid] === undefined ? (store.peakSchedule && store.peakSchedule.valley || {}).sliderPos
                : slider[gid],
              { min: 0, max: 100, note: '0 = 仅艾特，100 = 全响应' },
              (n) => push(ctx, { store: { groupSliderPos: { [gid]: n } } })),
            peakOn ? h.row([
              numField(ctx, '该群高峰档位（0~100）', entry.peak === undefined ? null : entry.peak,
                { min: 0, max: 100 }, (n) => push(ctx, { store: { groupPeakPos: { [gid]: { peak: n } } } })),
              numField(ctx, '该群低谷档位（0~100）', entry.valley === undefined ? null : entry.valley,
                { min: 0, max: 100 }, (n) => push(ctx, { store: { groupPeakPos: { [gid]: { valley: n } } } }))
            ]) : h.hint('（峰谷切换未启用——先打开上面的「启用峰谷切换」）')
          ]
        }));
      });
    }

    return h.fold({
      icon: '🎚',
      title: '分群档位 / 分群峰谷',
      sub: '按群覆盖全局档位（仅 unifiedTier 关闭时生效）',
      val: Object.keys(slider).length ? `${Object.keys(slider).length} 群已设` : '未设',
      open: false,
      body: body
    });
  }

  /**
   * 聊天设置分节：发送配置 / 活跃设置 / 指令禁言 / 主动开话题 / 表情包。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderChat(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const api = c.api || {};
    const send = c.send || {};
    const store = c.store || {};
    const mute = c.commandMute || {};
    const proactive = c.proactive || {};
    const sticker = c.sticker || {};
    const peak = store.peakSchedule || {};
    const peakHigh = peak.peak || {};
    const peakLow = peak.valley || {};
    const root = h.el('div', { class: 'folds' });

    // ── 卡 1：信息发送配置 ──
    root.appendChild(h.fold({
      icon: '📨',
      title: '信息发送配置',
      sub: '温度 / 思考 / 节奏 / 发送限流',
      val: `温度 ${api.temperature === undefined ? 0.8 : api.temperature}`,
      open: true,
      body: [
        h.row([
          numField(ctx, '温度', api.temperature === undefined ? 0.8 : api.temperature, { min: 0, max: 2, step: 0.1 },
            (n) => push(ctx, { api: { temperature: n } })),
          numField(ctx, '单次运行最大工具轮数', api.maxRounds === undefined ? 12 : api.maxRounds, { min: 1, max: 40 },
            (n) => push(ctx, { api: { maxRounds: n } }))
        ]),
        selectField(ctx, '思考强度', thinkingValueOf(api), THINKING_OPTIONS,
          '内置落成各厂商思考参数；渠道不支持高档时向下就近映射',
          (v) => push(ctx, { api: thinkingPatchOf(v) })),
        h.row([
          numField(ctx, '防抖聚批窗口（毫秒）', c.wakeDelayMs, { min: 0 }, (n) => push(ctx, { wakeDelayMs: n })),
          numField(ctx, '批次间隔（毫秒）', c.drainDelayMs, { min: 0 }, (n) => push(ctx, { drainDelayMs: n }))
        ]),
        h.row([
          numField(ctx, '同时处理几个会话', c.maxConcurrentRuns, { min: 1, max: 8 }, (n) => push(ctx, { maxConcurrentRuns: n })),
          numField(ctx, '失败自动重试次数', c.sessionRetryAttempts === undefined ? 2 : c.sessionRetryAttempts,
            { min: 0, max: 5, note: '0 = 关闭；已发过消息的会话绝不重试' },
            (n) => push(ctx, { sessionRetryAttempts: n }))
        ]),
        h.row([
          numField(ctx, '相邻消息最小间隔（毫秒）', send.minGapMs === undefined ? 1000 : send.minGapMs, { min: 200 },
            (n) => push(ctx, { send: { minGapMs: n } })),
          numField(ctx, '最大间隔（毫秒）', send.maxGapMs === undefined ? 3000 : send.maxGapMs, { min: 500 },
            (n) => push(ctx, { send: { maxGapMs: n } }))
        ]),
        h.row([
          numField(ctx, '每分钟最多发送', send.maxPerMinute === undefined ? 80 : send.maxPerMinute, { min: 1 },
            (n) => push(ctx, { send: { maxPerMinute: n } })),
          numField(ctx, '每小时最多发送', send.maxPerHour === undefined ? 500 : send.maxPerHour, { min: 1 },
            (n) => push(ctx, { send: { maxPerHour: n } }))
        ]),
        h.hint('改动即时生效（自动保存），无需单独点保存。')
      ]
    }));

    // ── 卡 2：活跃设置（响应档位 / 峰谷）──
    root.appendChild(h.fold({
      icon: '⚡',
      title: '活跃设置',
      sub: '响应档位 / 峰谷时段 / 上下文条数',
      val: `档 ${store.contextTier === undefined ? 4 : store.contextTier}`,
      open: true,
      body: [
        selectField(ctx, '响应档位', String(store.contextTier === undefined ? 4 : store.contextTier), TIER_OPTIONS,
          '累积生效：选 4 档时 1/2/3 档也都生效',
          (v) => push(ctx, { store: { contextTier: Number(v) } })),
        h.row([
          numField(ctx, '响应时带多少条历史', store.historyCount === undefined ? 80 : store.historyCount, { min: 1 },
            (n) => push(ctx, { store: { historyCount: n } })),
          numField(ctx, '随机档概率（%）', store.randomPercent === undefined ? 10 : store.randomPercent, { min: 0, max: 100 },
            (n) => push(ctx, { store: { randomPercent: n } }))
        ]),
        h.hint('第 2 档的关键词表在 config.json 的 `store.keywords`——本节只给档位与条数。'),
        boolField(ctx, '所有会话共用一套档位', store.unifiedTier, '关 = 每个群单独设置（下方出现分群编辑器）',
          (b) => push(ctx, { store: { unifiedTier: b } })),
        tierEditorOf(ctx, store),
        boolField(ctx, '启用峰谷切换', peak.enabled, '高峰时段用高峰档，其余时间用低谷档',
          (b) => push(ctx, { store: { peakSchedule: { enabled: b } } })),
        h.row([
          textField(ctx, '高峰开始（HH:MM）', peakHigh.start || '09:00', { note: '跨零点也支持' },
            (v) => push(ctx, { store: { peakSchedule: { peak: { start: v } } } })),
          textField(ctx, '高峰结束（HH:MM）', peakHigh.end || '18:00', {},
            (v) => push(ctx, { store: { peakSchedule: { peak: { end: v } } } }))
        ]),
        h.row([
          numField(ctx, '高峰档位滑条（0~100）', peakHigh.sliderPos === undefined ? 10 : peakHigh.sliderPos, { min: 0, max: 100 },
            (n) => push(ctx, { store: { peakSchedule: { peak: { sliderPos: n } } } })),
          numField(ctx, '低谷档位滑条（0~100）', peakLow.sliderPos === undefined ? 100 : peakLow.sliderPos, { min: 0, max: 100 },
            (n) => push(ctx, { store: { peakSchedule: { valley: { sliderPos: n } } } }))
        ])
      ]
    }));

    // ── 卡 3：指令禁言 ──
    root.appendChild(h.fold({
      icon: '🔇',
      title: '指令禁言',
      sub: '被 @ 附带指令就安静一段时间',
      val: mute.enabled === false ? '关' : '开',
      open: false,
      body: [
        h.row([
          textField(ctx, '禁言指令（需与 @机器人 同条消息）', mute.command || '/安静', { placeholder: '如 /安静' },
            (v) => push(ctx, { commandMute: { command: v } })),
          numField(ctx, '禁言时长（分钟，0 = 手动解除）', mute.durationMin === undefined ? 30 : mute.durationMin, { min: 0 },
            (n) => push(ctx, { commandMute: { durationMin: n } }))
        ]),
        boolField(ctx, '启用指令禁言', mute.enabled === undefined ? true : mute.enabled, '',
          (b) => push(ctx, { commandMute: { enabled: b } }))
      ]
    }));

    // ── 卡 4：主动开话题 ──
    root.appendChild(h.fold({
      icon: '💬',
      title: '主动开话题',
      sub: '冷场时按概率主动开话题',
      val: proactive.enabled ? '开' : '关',
      open: false,
      body: [
        boolField(ctx, '冷场时按概率主动开话题', proactive.enabled, '',
          (b) => push(ctx, { proactive: { enabled: b } })),
        h.row([
          numField(ctx, '检查间隔下限（毫秒）', proactive.checkIntervalMinMs === undefined ? 1800000 : proactive.checkIntervalMinMs,
            { min: 60000 }, (n) => push(ctx, { proactive: { checkIntervalMinMs: n } })),
          numField(ctx, '检查间隔上限（毫秒）', proactive.checkIntervalMaxMs === undefined ? 5400000 : proactive.checkIntervalMaxMs,
            { min: 120000 }, (n) => push(ctx, { proactive: { checkIntervalMaxMs: n } }))
        ]),
        numField(ctx, '触发概率（0~1）', proactive.probability === undefined ? 0.25 : proactive.probability,
          { min: 0, max: 1, step: 0.05 }, (n) => push(ctx, { proactive: { probability: n } }))
      ]
    }));

    // ── 卡 5：表情包 ──
    root.appendChild(h.fold({
      icon: '😄',
      title: '表情包',
      sub: '收藏同步 / 发送积极度 / 提示词列举数',
      val: sticker.enabled === false ? '关' : '开',
      open: false,
      body: [
        boolField(ctx, '启用表情包（收藏同步 + 发送工具）', sticker.enabled,
          '', (b) => push(ctx, { sticker: { enabled: b } })),
        selectField(ctx, '发表情包的积极程度',
          String(sticker.encourage === undefined ? 1 : sticker.encourage), STICKER_LEVELS,
          '是「引导」不是「强制」——模型仍自行判断时机',
          (v) => push(ctx, { sticker: { encourage: Number(v) } })),
        numField(ctx, '提示词里列举的表情包数量（1~50）',
          sticker.promptMaxStickers === undefined ? 10 : sticker.promptMaxStickers, { min: 1, max: 50 },
          (n) => push(ctx, { sticker: { promptMaxStickers: n } }))
      ]
    }));

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 三、搜索服务（原版 06-settings-render.js:262 renderSearchSection）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 多行文本框项。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} label 标签
   * @param {*} value 现值
   * @param {object} [opts] `{placeholder, note, minHeight}`
   * @param {Function} onsave `(s) => void`
   * @returns {Element} `.field`
   */
  function areaField(ctx, label, value, opts, onsave) {
    const o = opts || {};
    const node = ctx.h.el('textarea', {
      class: 'persona-role-text',
      placeholder: o.placeholder || '',
      style: { minHeight: o.minHeight || '120px', width: '100%' }
    });
    node.value = value === null || value === undefined ? '' : String(value);
    node.addEventListener('change', () => onsave(node.value));
    return ctx.h.field(label, node, o.note || '');
  }

  /** 自定义搜索提供商缓存（`GET /api/biz/search-providers`）。 */
  const searchProviders = { items: [], loaded: false, error: '' };

  /**
   * 搜索服务分节：搜索通道 / 结果条数 / 自定义提供商清单。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderSearch(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const ws = get(c, ['webSearch'], {});
    const baidu = get(c, ['webSearch', 'baidu'], {});
    const prov = String(ws.provider || 'baidu');
    const customList = searchProviders.loaded ? searchProviders.items
      : (Array.isArray(ws.providers) ? ws.providers : []);
    const root = h.el('div', { class: 'folds' });

    const options = [['baidu', '百度网页解析（推荐）'], ['bing', 'Bing 网页解析']]
      .concat(customList.map((p) => [`custom:${p.id}`, `${p.name || p.baseUrl}（自定义 · 通道已下线）`]));

    const channelCard = h.fold({
      icon: '🔍',
      title: '搜索通道',
      sub: '网页解析通道 / 结果条数 / 搜索地址',
      val: prov === 'bing' ? 'Bing' : (prov.startsWith('custom:') ? '自定义（已下线）' : '百度'),
      open: true,
      body: [
        boolField(ctx, '启用联网搜索（web_search / web_fetch 工具）', ws.enabled !== false,
          '关掉后模型没有联网能力，工具清单与提示词同步移除', (b) => push(ctx, { webSearch: { enabled: b } })),
        selectField(ctx, '搜索提供方', prov, options,
          '现役通道只有百度 / Bing 两种网页解析（无需 API Key）',
          (v) => push(ctx, { webSearch: { provider: v } })),
        h.row([
          numField(ctx, '每次结果条数', ws.maxResults === undefined ? 6 : ws.maxResults, { min: 1, max: 20 },
            (n) => push(ctx, { webSearch: { maxResults: n } })),
          textField(ctx, 'Bing 搜索地址', ws.searchUrl || 'https://cn.bing.com/search',
            { note: '可替换为兼容 Bing 结果格式的引擎' }, (v) => push(ctx, { webSearch: { searchUrl: v } }))
        ]),
        textField(ctx, '百度搜索地址', baidu.searchUrl || 'https://www.baidu.com/s',
          { note: '高级：仅在使用百度通道时生效' },
          (v) => push(ctx, { webSearch: { baidu: { searchUrl: v } } })),
        prov.startsWith('custom:')
          ? h.hint('当前选中的是自定义通道——该通道已下线，运行时会明确报「未知的搜索提供方」。改回百度 / Bing 即恢复。')
          : null
      ].filter(Boolean)
    });
    root.appendChild(channelCard);

    // ── 卡 2：自定义搜索提供商（通道已下线，清单仍可管理）──
    const listBody = h.el('div', {});
    if (!customList.length) {
      listBody.appendChild(h.hint(searchProviders.error
        ? `提供商清单读取失败：${searchProviders.error}`
        : '（还没有自定义搜索提供商）'));
    }
    customList.forEach((p) => {
      const urlInput = h.input({
        type: 'text',
        value: p.baseUrl || '',
        placeholder: '接口地址 / 搜索页地址',
        onchange: (v) => {
          submitSearchProvider(ctx, {
            id: p.id, name: p.name, type: p.type, baseUrl: String(v || '').trim(),
            model: p.model, count: p.count, timeoutMs: p.timeoutMs
          });
        }
      });
      listBody.appendChild(h.field(
        `${p.name || p.baseUrl}（${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）`,
        [urlInput, h.button('删除', () => deleteSearchProvider(ctx, p.id))],
        p.hasApiKey ? '已保存 Key · id ' + p.id : '未保存 Key · id ' + p.id
      ));
    });

    const nameInput = h.input({ type: 'text', placeholder: '例如：自建 SearXNG' });
    const urlInput = h.input({ type: 'text', placeholder: 'JSON 类型填接口地址；网页类型填搜索页地址' });
    const typeSelect = h.selectOf({ value: 'openai', options: [['openai', 'JSON 搜索接口（POST）'], ['bing', '网页解析（Bing 结果格式）']] });
    listBody.appendChild(h.el('div', { style: { marginTop: '10px' } },
      h.row([h.field('名称（自己辨认用）', nameInput, ''), h.field('类型', typeSelect, '')]),
      h.field('接口地址 / 搜索页地址', urlInput, '多数自建服务留空 Key 即可'),
      h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h.button('＋ 添加', () => {
          const baseUrl = String(urlInput.value || '').trim();
          if (!baseUrl) { ctx.notice('接口地址不能为空', 'fail'); return; }
          submitSearchProvider(ctx, {
            name: String(nameInput.value || '').trim(), type: typeSelect.value, baseUrl
          });
        }))));

    root.appendChild(h.fold({
      icon: '🧩',
      title: '自定义搜索提供商',
      sub: '通道已下线 · 清单可增删改（选中后运行时报错）',
      val: `${customList.length} 条`,
      open: false,
      body: listBody
    }));

    if (!searchProviders.loaded && !searchProviders.error) {
      ctx.api('/api/biz/search-providers').then((r) => {
        if (r && r.ok) {
          searchProviders.items = Array.isArray(r.providers) ? r.providers : [];
          searchProviders.loaded = true;
          ctx.reload();
        } else {
          searchProviders.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => { searchProviders.error = String((error && error.message) || error); });
    }

    return root;
  }

  /**
   * 新增 / 更新一个自定义搜索提供商（`POST /api/biz/search-providers`）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} body 请求体
   * @returns {void}
   */
  function submitSearchProvider(ctx, body) {
    ctx.notice('提交搜索提供商…');
    ctx.api('/api/biz/search-providers', { method: 'POST', body }).then((r) => {
      if (r && r.ok) {
        searchProviders.loaded = false;
        ctx.notice('搜索提供商已保存');
        ctx.reload();
      } else {
        ctx.notice(`保存失败：${(r && r.error) || '未知原因'}`, 'fail');
      }
    });
  }

  /**
   * 删除一个自定义搜索提供商（`DELETE /api/biz/search-providers`）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} id 提供商 id
   * @returns {void}
   */
  function deleteSearchProvider(ctx, id) {
    ctx.api('/api/biz/search-providers', { method: 'DELETE', body: { id } }).then((r) => {
      if (r && r.ok) {
        searchProviders.loaded = false;
        ctx.notice('搜索提供商已删除');
        ctx.reload();
      } else {
        ctx.notice(`删除失败：${(r && r.error) || '未知原因'}`, 'fail');
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 四、记忆（原版 06-settings-render.js:369 renderMemorySettingsSection）
  // ══════════════════════════════════════════════════════════════════════

  /** 记忆文件清单缓存（`GET /api/biz/memory-files`）。 */
  const memoryFiles = { items: [], loaded: false, error: '' };

  /**
   * 记忆分节：整理开关与节奏 / 整理模型 / 记忆文件清单。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderMemory(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const mem = get(c, ['memory'], {});
    const useChat = mem.useChatModel !== false;
    const root = h.el('div', { class: 'folds' });

    root.appendChild(h.fold({
      icon: '🧠',
      title: '记忆整理',
      sub: '自动整理 / 冷却间隔 / 条数上限',
      val: mem.consolidateEnabled === false ? '关' : '开',
      open: true,
      body: [
        boolField(ctx, '启用记忆自动整理', mem.consolidateEnabled !== false,
          '条数超过阈值且距上次整理超过冷却时间后，在运行结束后后台整理',
          (b) => push(ctx, { memory: { consolidateEnabled: b } })),
        numField(ctx, '整理冷却时间（毫秒）', mem.consolidateMinIntervalMs === undefined ? 10800000 : mem.consolidateMinIntervalMs,
          { min: 1800000, step: 600000, note: '默认 3 小时（10800000 毫秒）' },
          (n) => push(ctx, { memory: { consolidateMinIntervalMs: n } })),
        numField(ctx, '记忆沉淀拍间隔（毫秒）', mem.sedimentIntervalMs === undefined ? 43200000 : mem.sedimentIntervalMs,
          { min: 0, step: 3600000, note: '0 = 关闭沉淀拍' },
          (n) => push(ctx, { memory: { sedimentIntervalMs: n } })),
        h.row([
          numField(ctx, '单成员印象上限', mem.maxImpressionsPerMember === undefined ? 40 : mem.maxImpressionsPerMember,
            { min: 1 }, (n) => push(ctx, { memory: { maxImpressionsPerMember: n } })),
          numField(ctx, '群记重整上限', mem.maxGroupEntries === undefined ? 60 : mem.maxGroupEntries,
            { min: 1 }, (n) => push(ctx, { memory: { maxGroupEntries: n } }))
        ]),
        h.row([
          numField(ctx, '发现新人最低发言条数', mem.discoverMinMessages === undefined ? 3 : mem.discoverMinMessages,
            { min: 1 }, (n) => push(ctx, { memory: { discoverMinMessages: n } })),
          numField(ctx, '单次最多发现新人', mem.discoverMaxMembers === undefined ? 10 : mem.discoverMaxMembers,
            { min: 1 }, (n) => push(ctx, { memory: { discoverMaxMembers: n } }))
        ])
      ]
    }));

    root.appendChild(h.fold({
      icon: '🤖',
      title: '整理模型',
      sub: '跟随聊天模型 / 专用模型',
      val: useChat ? '跟随聊天模型' : (mem.model || '未选模型'),
      open: false,
      body: [
        boolField(ctx, '使用与聊天机器人相同的模型', useChat,
          '关掉后使用下方专用模型（仅在有单独配额时才有意义）',
          (b) => push(ctx, { memory: { useChatModel: b } })),
        textField(ctx, '专用提供商 id', mem.provider || '', { note: 'useChatModel 关闭时生效' },
          (v) => push(ctx, { memory: { provider: v } })),
        textField(ctx, '专用模型 id', mem.model || '', { note: 'useChatModel 关闭时生效' },
          (v) => push(ctx, { memory: { model: v } }))
      ]
    }));

    // ── 卡 3：记忆文件清单 ──
    const fileBody = h.el('div', {});
    if (!memoryFiles.loaded) {
      fileBody.appendChild(h.hint(memoryFiles.error ? `读取失败：${memoryFiles.error}` : '正在读取记忆文件…'));
    } else if (!memoryFiles.items.length) {
      fileBody.appendChild(h.hint('（还没有任何会话记忆）'));
    } else {
      memoryFiles.items.forEach((f) => {
        fileBody.appendChild(h.field(f.chatKey,
          [h.badge(f.consolidating ? '整理中' : '空闲', f.consolidating ? 'warn' : 'ok')],
          `印象 ${f.impressionCount} · 成员 ${f.memberCount} · 群记 ${f.groupCount}`
            + (f.groupArchived ? ` · 群记归档 ${f.groupArchived}` : '')
            + (f.memberArchived ? ` · 成员归档 ${f.memberArchived}` : '')));
      });
    }
    fileBody.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
      h.button('刷新清单', () => { memoryFiles.loaded = false; ctx.reload(); }),
      h.button('立即整理全部会话', () => {
        ctx.notice('正在提交整理…');
        ctx.api('/api/biz/memory-files/consolidate', { method: 'POST', body: {} }).then((r) => {
          if (r && r.ok) { ctx.notice('整理已提交'); memoryFiles.loaded = false; ctx.reload(); }
          else ctx.notice(`整理失败：${(r && r.error) || '未知原因'}`, 'fail');
        });
      })));

    root.appendChild(h.fold({
      icon: '📄',
      title: '记忆文件',
      sub: '每个会话一份 · 印象 / 成员 / 群记条数',
      val: `${memoryFiles.items.length} 个会话`,
      open: false,
      body: fileBody
    }));

    if (!memoryFiles.loaded && !memoryFiles.error) {
      ctx.api('/api/biz/memory-files').then((r) => {
        if (r && r.ok) {
          memoryFiles.items = Array.isArray(r.files) ? r.files : [];
          memoryFiles.loaded = true;
          ctx.reload();
        } else {
          memoryFiles.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => { memoryFiles.error = String((error && error.message) || error); });
    }

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 五、人设（原版 06-settings-render.js:395 renderPersonaSection）
  // ══════════════════════════════════════════════════════════════════════

  /** 人设模板缓存（`GET /api/biz/persona-templates`）。 */
  const personaTemplates = { items: [], loaded: false, error: '' };

  /** 参与度档位（原版 :413-417 同表）。 */
  const PARTICIPATION_OPTIONS = [
    ['low', '安静型'],
    ['medium', '普通群友'],
    ['high', '活跃型']
  ];

  /**
   * 人设分节：统一人设编辑器 / 分会话人设 / 人设模板库。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderPersona(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const per = get(c, ['persona'], {});
    const unified = c.personaUnified !== false;
    const perChat = get(c, ['personaByChat'], {});
    const allow = get(c, ['allow'], {});
    const root = h.el('div', { class: 'folds' });

    const allowIds = []
      .concat((allow.groups || []).map((g) => `group:${g}`))
      .concat((allow.private || []).map((p) => `private:${p}`))
      .map(String);
    const configuredIds = Object.keys(perChat).map(String);
    // 会话清单 = 白名单 ∪ 已配置过独立人设的会话（白名单外的历史条目不能静默丢）
    const chatIds = allowIds.concat(configuredIds.filter((id) => allowIds.indexOf(id) < 0));

    const tplSelect = h.selectOf({
      value: '',
      options: [['', '（手动填写角色设定）']].concat(
        personaTemplates.items.map((t) => [t.id, `${t.name}${t.builtin ? '（内置）' : '（自定义）'}`])
      ),
      onchange: (id) => {
        const hit = personaTemplates.items.find((t) => String(t.id) === String(id));
        if (!hit) return;
        // 套用人设：文本 + 附加规则一起写回（与原版「点击选择人设」同口径）
        push(ctx, { persona: { roleText: hit.text, customRules: hit.customRules || per.customRules || '' } });
      }
    });

    root.appendChild(h.fold({
      icon: '🎭',
      title: '统一人设',
      sub: '名字 / 角色设定 / 参与度 / 附加规则 / 提示词覆盖',
      val: per.botName || '未命名',
      open: unified,
      body: [
        boolField(ctx, '为所有的群聊 / 私聊使用同一个人设', unified,
          unified ? '所有会话共用下面这一套人设。' : '关闭后每个会话可用独立人设（见下方「分会话人设」）。',
          (b) => push(ctx, { personaUnified: b })),
        h.row([
          textField(ctx, '机器人名字', per.botName || '', { placeholder: '小鲸鱼' },
            (v) => push(ctx, { persona: { botName: v } })),
          textField(ctx, '群内展示名（可选）', per.selfNickname || '', { note: '留空 = 用 QQ 昵称' },
            (v) => push(ctx, { persona: { selfNickname: v } }))
        ]),
        selectField(ctx, '参与度', per.participation || 'medium', PARTICIPATION_OPTIONS, '',
          (v) => push(ctx, { persona: { participation: v } })),
        personaTemplates.items.length
          ? h.field('套用人设模板', tplSelect, personaTemplates.error ? `（模板读取失败：${personaTemplates.error}）` : '选中即写入角色设定')
          : h.hint(personaTemplates.error ? `人设模板读取失败：${personaTemplates.error}` : '人设模板加载中…'),
        areaField(ctx, '角色设定', per.roleText || '',
          { placeholder: '例如：你是运维群里的老油条……', minHeight: '160px' },
          (v) => push(ctx, { persona: { roleText: v } })),
        areaField(ctx, '管理员附加规则（可选，追加到系统提示）', per.customRules || '',
          { minHeight: '100px' }, (v) => push(ctx, { persona: { customRules: v } })),
        areaField(ctx, '系统提示词覆盖（高级 · 可选）', per.systemPromptOverride || '', {
          minHeight: '120px',
          placeholder: '留空 = 使用内置默认系统提示词',
          note: '⚠️ 填写后整体替换内置系统提示词（安全规则 / 工具协议 / 反 AI 味全部失效）。'
            + '可用占位符 {botName} {roleText} {participation}。'
        }, (v) => push(ctx, { persona: { systemPromptOverride: v } }))
      ]
    }));

    // ── 卡 2：分会话人设（统一人设关闭时出现）──
    const chatBody = h.el('div', {});
    if (unified) {
      chatBody.appendChild(h.hint('「统一人设」开启中——本节不生效。关掉上面的开关后，这里给每个会话单独编辑。'));
    } else if (!chatIds.length) {
      chatBody.appendChild(h.hint('（白名单为空——先在「聊天白名单」里添加群聊 / 私聊）'));
    } else {
      chatIds.forEach((chatKey) => {
        const conf = perChat[chatKey] || {};
        const hasCustom = Boolean(conf.roleText || conf.participation || conf.customRules || conf.systemPromptOverride);
        chatBody.appendChild(h.fold({
          icon: hasCustom ? '●' : '○',
          title: chatKey,
          sub: hasCustom ? '已配置独立人设' : '跟随全局',
          val: conf.participation || '跟随',
          open: false,
          body: [
            selectField(ctx, '参与度（留空跟随全局）', conf.participation || '',
              [['', '跟随全局']].concat(PARTICIPATION_OPTIONS), '',
              (v) => savePerChat(ctx, chatKey, { participation: v })),
            areaField(ctx, '角色设定（留空跟随全局）', conf.roleText || '', { minHeight: '140px' },
              (v) => savePerChat(ctx, chatKey, { roleText: v })),
            areaField(ctx, '管理员附加规则（可选）', conf.customRules || '', { minHeight: '80px' },
              (v) => savePerChat(ctx, chatKey, { customRules: v })),
            areaField(ctx, '系统提示词覆盖（高级 · 可选）', conf.systemPromptOverride || '', { minHeight: '80px' },
              (v) => savePerChat(ctx, chatKey, { systemPromptOverride: v })),
            h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
              h.button('清空独立人设', () => clearPerChat(ctx, chatKey)),
              h.hint('机器人名字 / 群内展示名不按会话变化（账号身份，改了会与 @ 判定对不上）。'))
          ]
        }));
      });
    }
    root.appendChild(h.fold({
      icon: '👥',
      title: '分会话人设',
      sub: '每个白名单会话一套独立人设',
      val: `${Object.keys(perChat).length} 个已配置`,
      open: false,
      body: chatBody
    }));

    if (!personaTemplates.loaded && !personaTemplates.error) {
      ctx.api('/api/biz/persona-templates').then((r) => {
        if (r && r.ok) {
          personaTemplates.items = Array.isArray(r.templates) ? r.templates : [];
          personaTemplates.loaded = true;
          ctx.reload();
        } else {
          personaTemplates.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => { personaTemplates.error = String((error && error.message) || error); });
    }

    return root;
  }

  /**
   * 写一个会话的独立人设字段（`personaByChat` 走 `__replace__` 整体替换该键）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} chatKey 会话键（`group:123` / `private:10001`）
   * @param {object} patch 该会话的字段补丁
   * @returns {void}
   */
  function savePerChat(ctx, chatKey, patch) {
    const cur = (ctx.config && ctx.config.personaByChat) || {};
    const next = Object.assign({}, cur);
    const merged = Object.assign({}, next[chatKey] || {}, patch);
    // 空值字段不留在对象里（空串 = 跟随全局，不是「显式设为空」）
    Object.keys(merged).forEach((k) => {
      if (merged[k] === '' || merged[k] === null || merged[k] === undefined) delete merged[k];
    });
    if (Object.keys(merged).length) next[chatKey] = merged;
    else delete next[chatKey];
    push(ctx, { personaByChat: { __replace__: next } });
  }

  /**
   * 清空一个会话的独立人设。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} chatKey 会话键
   * @returns {void}
   */
  function clearPerChat(ctx, chatKey) {
    const cur = (ctx.config && ctx.config.personaByChat) || {};
    const next = Object.assign({}, cur);
    delete next[chatKey];
    push(ctx, { personaByChat: { __replace__: next } });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 六、聊天白名单（原版 06-settings-render.js:670 renderAllowSection）
  // ══════════════════════════════════════════════════════════════════════

  /** 已知会话缓存（`GET /api/biz/chats`——勾选群 / 好友用）。 */
  const chatDirectory = { items: [], loaded: false, error: '' };

  /**
   * 勾选式名单编辑（补强②：原版是模态框，这里做成内联勾选清单——不新造交互形态）。
   *
   * 数据源是 `/api/chats`（本机已有会话记录）+ 当前名单并集：只会出现"见过的会话"，
   * 不会伪造"全部群列表"（SnowLuma 侧的好友 / 群列表需要协议端在线，不在本页职责内）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} kind `group` / `private`
   * @param {string[]} current 当前名单
   * @param {Function} onsave `(ids[]) => void`
   * @returns {Element} 清单容器
   */
  function pickListOf(ctx, kind, current, onsave) {
    const h = ctx.h;
    const box = h.el('div', { style: { marginTop: '6px' } });
    const prefix = kind === 'group' ? 'group:' : 'private:';
    const seen = new Set(current.map(String));
    const candidates = [];
    chatDirectory.items.forEach((item) => {
      const key = String(item.key || '');
      if (!key.startsWith(prefix)) return;
      const id = key.slice(prefix.length);
      if (seen.has(id)) return;
      seen.add(id);
      candidates.push({ id, label: item.chatName ? `${item.chatName}（${id}）` : id });
    });

    if (!chatDirectory.loaded) {
      box.appendChild(h.hint(chatDirectory.error
        ? `会话目录读取失败：${chatDirectory.error}`
        : '正在读取本机会话目录…'));
      if (!chatDirectory.error) {
        ctx.api('/api/biz/chats').then((r) => {
          if (r && r.ok) {
            chatDirectory.items = Array.isArray(r.chats) ? r.chats : [];
            chatDirectory.loaded = true;
            ctx.reload();
          } else {
            chatDirectory.error = (r && r.error) || 'unknown';
            ctx.reload();
          }
        }).catch((error) => {
          chatDirectory.error = String((error && error.message) || error);
          ctx.reload();
        });
      }
      return box;
    }

    if (!candidates.length) {
      box.appendChild(h.hint(kind === 'group'
        ? '（没有可勾选的新群——本机会话目录里没有未在名单中的群）'
        : '（没有可勾选的新好友——本机会话目录里没有未在名单中的私聊）'));
      return box;
    }

    candidates.forEach((c) => {
      box.appendChild(h.checkbox({
        checked: false,
        label: c.label,
        note: '',
        onchange: (on) => {
          if (!on) return;
          const next = current.concat([c.id]);
          onsave(next);
        }
      }));
    });
    return box;
  }

  /**
   * 聊天白名单分节：允许的群 / 允许的私聊 / 空表语义 / 拒绝名单。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderAllow(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const allow = c.allow || {};
    const deny = c.deny || {};
    const groups = Array.isArray(allow.groups) ? allow.groups : [];
    const privates = Array.isArray(allow.private) ? allow.private : [];
    const root = h.el('div', { class: 'folds' });

    const groupInput = h.input({
      type: 'text',
      value: groups.join(','),
      placeholder: '如 123456789,987654321',
      onchange: (v) => push(ctx, { allow: { groups: splitList(v) } })
    });
    const privateInput = h.input({
      type: 'text',
      value: privates.join(','),
      placeholder: '如 10001,10002',
      onchange: (v) => push(ctx, { allow: { private: splitList(v) } })
    });

    root.appendChild(h.fold({
      icon: '✅',
      title: '接入白名单',
      sub: '允许的群 / 允许的私聊 / 空表语义',
      val: `${groups.length} 群 · ${privates.length} 私聊`,
      open: true,
      body: [
        h.hint('白名单为空时机器人不会在任何群聊 / 私聊内运行（除非开了下方「白名单留空时允许所有会话」）。'),
        h.row([
          h.field('允许的群号（逗号分隔）', groupInput, `${groups.length} 项`),
          h.field('允许的 QQ（逗号分隔）', privateInput, `${privates.length} 项`)
        ]),
        h.fold({
          icon: '📋',
          title: '从本机会话目录勾选（群）',
          sub: '只列见过的群 · 勾一个即加入白名单',
          val: chatDirectory.loaded ? '可勾选' : '未加载',
          open: false,
          body: [pickListOf(ctx, 'group', groups, (next) => push(ctx, { allow: { groups: next } }))]
        }),
        h.fold({
          icon: '📋',
          title: '从本机会话目录勾选（私聊）',
          sub: '只列见过的私聊 · 勾一个即加入白名单',
          val: chatDirectory.loaded ? '可勾选' : '未加载',
          open: false,
          body: [pickListOf(ctx, 'private', privates, (next) => push(ctx, { allow: { private: next } }))]
        }),
        boolField(ctx, '白名单留空时允许所有会话', c.allowAllWhenEmpty,
          '两个列表都为空且本项开启 → 在所有群聊与私聊运行；填了任意一项就只按名单过滤',
          (b) => push(ctx, { allowAllWhenEmpty: b })),
        h.hint('按会话的独立人设在「人设」分节配置（关闭「统一人设」后出现）。')
      ]
    }));

    const denyGroups = Array.isArray(deny.groups) ? deny.groups : [];
    const denyPrivates = Array.isArray(deny.private) ? deny.private : [];
    root.appendChild(h.fold({
      icon: '🚫',
      title: '拒绝名单',
      sub: '即使是白名单内的会话也不再响应',
      val: `${denyGroups.length} 群 · ${denyPrivates.length} 私聊`,
      open: false,
      body: [
        h.row([
          h.field('拒绝的群号（逗号分隔）', h.input({
            type: 'text', value: denyGroups.join(','), placeholder: '如 123456789',
            onchange: (v) => push(ctx, { deny: { groups: splitList(v) } })
          }), `${denyGroups.length} 项`),
          h.field('拒绝的 QQ（逗号分隔）', h.input({
            type: 'text', value: denyPrivates.join(','), placeholder: '如 10001',
            onchange: (v) => push(ctx, { deny: { private: splitList(v) } })
          }), `${denyPrivates.length} 项`)
        ]),
        h.hint('拒绝名单优先级高于白名单；全局屏蔽名单（跨群生效）在会话页「管理屏蔽名单」，本节不重复。')
      ]
    }));

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 七、桌面端（原版 06-settings-render.js:959 renderDesktopSection）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 桌面端分节：桌面端接入 / 界面 / 数据管理 / 版本更新。
   *
   * 本机动作类按钮（打开文件夹 / 重置数据 / 检查更新）**不自造端点**——
   * 点了给提示说明去处（原版由 Electron 主进程承载，单体侧无对应通道）。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderDesktop(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const server = get(c, ['server'], {});
    const uiCfg = get(c, ['ui'], {});
    const root = h.el('div', { class: 'folds' });

    root.appendChild(h.fold({
      icon: '🖥',
      title: '桌面端',
      sub: '开机自启 / 关闭到托盘',
      val: server.autoStart ? '自启' : '手动',
      open: true,
      body: [
        boolField(ctx, '开机自启', server.autoStart === true, '仅 Electron 桌面端生效',
          (b) => push(ctx, { server: { autoStart: b } })),
        boolField(ctx, '点关闭时最小化到托盘', server.closeToTray !== false, '',
          (b) => push(ctx, { server: { closeToTray: b } }))
      ]
    }));

    root.appendChild(h.fold({
      icon: '🎨',
      title: '界面',
      sub: '主题 / 视觉徽标 / 轮询间隔',
      val: uiCfg.theme || 'dark',
      open: true,
      body: [
        selectField(ctx, '主题', uiCfg.theme || 'dark', [
          ['dark', '深色'],
          ['light', '浅色'],
          ['system', '跟随系统']
        ], '前端以 localStorage 为准即时生效，这里管重装后的默认值',
        (v) => push(ctx, { ui: { theme: v } })),
        boolField(ctx, '模型目录显示图片输入能力徽标', uiCfg.showVision !== false, '',
          (b) => push(ctx, { ui: { showVision: b } })),
        numField(ctx, '界面刷新间隔（毫秒）', uiCfg.refreshMs === undefined ? 15000 : uiCfg.refreshMs,
          { min: 1000, step: 1000 }, (n) => push(ctx, { ui: { refreshMs: n } }))
      ]
    }));

    root.appendChild(h.fold({
      icon: '🗂',
      title: '数据管理',
      sub: '用户数据目录 / 重置（本机动作）',
      val: '只读展示',
      open: false,
      body: [
        h.hint('用户数据目录（配置 / 聊天记录 / 记忆 / 表情包）由 Electron 主进程提供，'
          + '业务面不掌握该路径——本节只给形态，点击按钮在桌面端操作。'),
        h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
          h.button('打开数据目录', () => ctx.notice('打开数据目录：属于桌面端本机动作，请在桌面端操作')),
          h.button('重置为初始形态', () => ctx.notice('重置数据属破坏性本机动作，不在本页提供（桌面端二次确认后执行）')))
      ]
    }));

    root.appendChild(h.fold({
      icon: '⬆️',
      title: '版本更新',
      sub: '当前版本 / 检查更新',
      val: '本机动作',
      open: false,
      body: [
        h.hint('版本号由单体自身提供（`GET /api/version`）；更新检查属桌面端流程，本页只给形态。'),
        h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
          h.button('查看当前版本', () => {
            ctx.api('/api/biz/version').then((r) => {
              if (r && r.ok && r.version) ctx.notice(`当前版本：${r.version}`);
              else ctx.notice(`版本读取失败：${(r && r.error) || '未知原因'}`, 'fail');
            });
          }))
      ]
    }));

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 八、OneBot（原版 06-settings-render.js:1000 renderOnebotSection）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * OneBot（SnowLuma）分节：程序目录 / 自动拉起 / WS 与 HTTP 地址与令牌。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderOnebot(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const snow = c.snowluma || {};
    const root = h.el('div', { class: 'folds' });

    root.appendChild(h.fold({
      icon: '🔌',
      title: 'OneBot（SnowLuma）',
      sub: 'WS 收消息 / HTTP 发消息 / 令牌',
      val: snow.wsUrl ? '已配置' : '未配置',
      open: true,
      body: [
        textField(ctx, 'SnowLuma 程序目录', snow.dir || '',
          { note: '留空 = 自动探测项目内 snowluma/', placeholder: '留空自动探测' },
          (v) => push(ctx, { snowluma: { dir: v } })),
        boolField(ctx, '应用启动时自动拉起 SnowLuma（未运行时）', snow.autoLaunch === true, '',
          (b) => push(ctx, { snowluma: { autoLaunch: b } })),
        h.row([
          textField(ctx, 'WebSocket 地址（收消息）', snow.wsUrl || '', { placeholder: 'ws://127.0.0.1:3001' },
            (v) => push(ctx, { snowluma: { wsUrl: v } })),
          textField(ctx, 'HTTP 地址（发消息）', snow.httpUrl || '', { placeholder: 'http://127.0.0.1:3000' },
            (v) => push(ctx, { snowluma: { httpUrl: v } }))
        ]),
        textField(ctx, 'WebSocket 令牌', '', {
          secret: true,
          placeholder: snow.hasAccessToken ? '已保存（不显示；留空 = 不改）' : '未保存（填了就写回）'
        }, (v) => push(ctx, { snowluma: { accessToken: v } })),
        textField(ctx, 'HTTP 令牌（与 WS 不同时填）', '', {
          secret: true,
          placeholder: snow.hasHttpAccessToken ? '已保存（不显示；留空 = 不改）' : '未保存（留空沿用 WS 令牌）'
        }, (v) => push(ctx, { snowluma: { httpAccessToken: v } })),
        h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
          h.button('读取 WS 令牌明文', () => readOnebotToken(ctx, 'ws')),
          h.button('读取 HTTP 令牌明文', () => readOnebotToken(ctx, 'http'))),
        h.hint('改完 OneBot 地址需重启应用生效；模型 / 人设 / 白名单即时生效。')
      ]
    }));

    return root;
  }

  /**
   * 读取 OneBot 令牌明文（`GET /api/biz/onebot-token?which=`）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} which `ws` / `http`
   * @returns {void}
   */
  function readOnebotToken(ctx, which) {
    ctx.api(`/api/biz/onebot-token?which=${which}`).then((r) => {
      if (r && r.ok && typeof r.token === 'string') {
        ctx.notice(`${which === 'ws' ? 'WebSocket' : 'HTTP'} 令牌：${r.token || '（空）'}`);
      } else {
        ctx.notice(`读取失败：${(r && r.error) || '未知原因'}`, 'fail');
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 九、工具与技能（原版 06-settings-render.js:1527 renderToolsSection）
  // ══════════════════════════════════════════════════════════════════════

  /** 工具注册表缓存（`GET /api/biz/tools`）。 */
  const toolRegistry = { items: [], loaded: false, error: '' };

  /** 工具可用性缓存（`GET /api/biz/tools/availability`）。 */
  const toolAvailability = { items: [], loaded: false, error: '' };

  /** 工具分类（与 `tool-registry.js` 的 `CATEGORY_META` 同源八类）。 */
  const TOOL_CATEGORIES = [
    ['messaging', '💬 消息发送'],
    ['sticker', '😀 表情管理'],
    ['query', '🔍 消息查询'],
    ['memory', '🧠 记忆系统'],
    ['web', '🌐 联网搜索'],
    ['knowledge', '📚 知识库'],
    ['media', '🎞️ 媒体理解'],
    ['system', '⚙️ 系统反馈']
  ];

  /**
   * 工具与技能分节：全局开关 / 分类开关 / 单工具开关 / 跨会话发送。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderTools(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const toolsCfg = c.tools || {};
    const cats = toolsCfg.categories || {};
    const overrides = toolsCfg.overrides || {};
    const api = c.api || {};
    const ws = c.webSearch || {};
    const root = h.el('div', { class: 'folds' });

    if (!toolRegistry.loaded && !toolRegistry.error) {
      ctx.api('/api/biz/tools').then((r) => {
        if (r && r.ok) {
          toolRegistry.items = Array.isArray(r.tools) ? r.tools : [];
          toolRegistry.loaded = true;
          ctx.reload();
        } else {
          toolRegistry.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => { toolRegistry.error = String((error && error.message) || error); });
    }
    if (!toolAvailability.loaded && !toolAvailability.error) {
      ctx.api('/api/biz/tools/availability').then((r) => {
        if (r && r.ok) {
          toolAvailability.items = Array.isArray(r.tools) ? r.tools : [];
          toolAvailability.loaded = true;
        } else {
          toolAvailability.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => { toolAvailability.error = String((error && error.message) || error); });
    }

    const availById = new Map(toolAvailability.items.map((a) => [String(a.id), a]));
    const byCategory = {};
    toolRegistry.items.forEach((t) => {
      const cat = t.category || 'system';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(t);
    });

    const listBody = h.el('div', {});
    listBody.appendChild(boolField(ctx, '启用工具系统（关闭后机器人只能看不能做任何操作）',
      toolsCfg.enabled !== false, '', (b) => push(ctx, { tools: { enabled: b } })));
    listBody.appendChild(boolField(ctx, '允许跨会话发送（send_message 可发到白名单内其它会话）',
      toolsCfg.crossChatSend === true, '社交敏感操作：默认只允许发回当前会话',
      (b) => push(ctx, { tools: { crossChatSend: b } })));

    if (!toolRegistry.loaded) {
      listBody.appendChild(h.hint(toolRegistry.error
        ? `工具注册表读取失败：${toolRegistry.error}`
        : '正在读取工具注册表…'));
    } else if (!toolRegistry.items.length) {
      listBody.appendChild(h.hint('（还没有注册任何工具）'));
    } else {
      TOOL_CATEGORIES.forEach(([cat, label]) => {
        const list = byCategory[cat] || [];
        if (!list.length) return;
        const catOn = cats[cat] !== false;
        const rows = list.map((t) => {
          const avail = availById.get(String(t.id)) || null;
          const checked = overrides[t.id] === undefined ? t.defaultEnabled !== false : overrides[t.id] === true;
          const depMissing = (t.requiresVision && api.vision === false)
            || (t.requiresSearch && ws.enabled === false);
          const noteBits = [];
          if (t.skillId) noteBits.push(`skill:${t.skillId}`);
          if (t.requiresVision) noteBits.push('需要视觉模型');
          if (t.requiresSearch) noteBits.push('需要搜索服务');
          if (avail && avail.enabled === false && avail.reason) noteBits.push(`未生效：${avail.reason}`);
          if (depMissing) noteBits.push('依赖未满足');
          return boolField(ctx, String(t.id).split(':').pop(), checked,
            noteBits.join(' · ') || String(t.description || '').split('。')[0],
            (b) => writeToolOverride(ctx, t.id, b));
        });
        listBody.appendChild(h.fold({
          icon: '▸',
          title: label,
          sub: `${list.length} 个工具`,
          val: catOn ? '开' : '关',
          open: cat === 'messaging',
          body: [
            boolField(ctx, `启用「${label}」整类`, catOn, '关闭后该类全部工具不可用',
              (b) => push(ctx, { tools: { categories: { [cat]: b } } })),
            ...rows
          ]
        }));
      });

      listBody.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
        h.button('全部启用', () => bulkTools(ctx, true)),
        h.button('全部禁用', () => bulkTools(ctx, false)),
        h.button('恢复默认', () => push(ctx, { tools: { overrides: { __replace__: {} } } })),
        h.button('刷新注册表', () => {
          toolRegistry.loaded = false; toolAvailability.loaded = false; ctx.reload();
        })));
    }

    root.appendChild(h.fold({
      icon: '🛠',
      title: '工具列表',
      sub: '按分类展开 · 开关即时保存',
      val: `${toolRegistry.items.length} 个 · ${TOOL_CATEGORIES.filter(([c2]) => (byCategory[c2] || []).length).length} 类`,
      open: true,
      body: listBody
    }));

    // ── 卡 2：技能开关（`/api/biz/skills`）──
    root.appendChild(h.fold({
      icon: '🧩',
      title: '技能',
      sub: '单个 Skill 的启停（技能页有完整视图）',
      val: '见「技能」页签',
      open: false,
      body: [h.hint('技能开关与设置在「技能」页签统一维护；本节只提示归属，不复制第二套开关。')]
    }));

    return root;
  }

  /**
   * 写单个工具的启用态（`tools.overrides.<id>`）。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} id 工具 id
   * @param {boolean} enabled 是否启用
   * @returns {void}
   */
  function writeToolOverride(ctx, id, enabled) {
    push(ctx, { tools: { overrides: { [id]: enabled } } });
  }

  /**
   * 批量启用 / 禁用全部工具（`overrides` 走 `__replace__` 整体替换）。
   *
   * @param {object} ctx 渲染上下文
   * @param {boolean} enabled 启用或禁用
   * @returns {void}
   */
  function bulkTools(ctx, enabled) {
    const next = {};
    toolRegistry.items.forEach((t) => { next[t.id] = enabled; });
    push(ctx, { tools: { overrides: { __replace__: next } } });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 十、提示词预览（原版 06-settings-render.js:1652 renderPromptPreview）
  // ══════════════════════════════════════════════════════════════════════

  /** 提示词预览缓存（`GET /api/biz/prompt-preview`）。 */
  const promptPreview = { text: '', tools: [], loaded: false, error: '' };

  /**
   * 提示词预览分节：按当前启用态组装后的系统提示词 + 可用工具清单。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderPrompt(ctx) {
    const h = ctx.h;
    const root = h.el('div', { class: 'folds' });

    const pre = h.el('pre', {
      class: 'prompt-preview-content',
      style: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'Consolas, monospace',
        fontSize: '12px', margin: '0', maxHeight: '460px', overflow: 'auto'
      }
    });
    pre.textContent = promptPreview.loaded ? promptPreview.text : (promptPreview.error
      ? `读取失败：${promptPreview.error}`
      : '正在组装提示词预览…');

    root.appendChild(h.fold({
      icon: '📜',
      title: '系统提示词预览',
      sub: '按当前启停状态实时组装 · 只读',
      val: promptPreview.loaded ? `${promptPreview.text.length} 字符 · ${promptPreview.tools.length} 工具` : '未加载',
      open: true,
      body: [
        h.hint('这份文本由后端用运行时同一套 buildSystemPrompt + getToolAvailability 组装——'
          + '前端不另拼一份，避免与实际发送的提示词漂移。改开关后点「刷新预览」重取。'),
        h.el('div', { style: { display: 'flex', gap: '8px', margin: '8px 0' } },
          h.button('刷新预览', () => { promptPreview.loaded = false; promptPreview.error = ''; ctx.reload(); })),
        pre
      ]
    }));

    if (!promptPreview.loaded && !promptPreview.error) {
      ctx.api('/api/biz/prompt-preview').then((r) => {
        if (r && r.ok && typeof r.systemPrompt === 'string') {
          const tools = Array.isArray(r.tools) ? r.tools : [];
          const lines = tools.length
            ? tools.map((t) => `- ${t.id}：${t.description || ''}`).join('\n')
            : '（当前没有可用工具）';
          promptPreview.text = `${r.systemPrompt}\n\n【本次可用工具清单（function calling）】\n${lines}`;
          promptPreview.tools = tools;
          promptPreview.loaded = true;
          ctx.reload();
        } else {
          promptPreview.error = (r && r.error) || 'unknown';
          ctx.reload();
        }
      }).catch((error) => {
        promptPreview.error = String((error && error.message) || error);
        ctx.reload();
      });
    }

    return root;
  }

  // 注册：分节 id → 渲染函数（`settings.js` 按侧栏点击调度；未在此处的分节 = 未接）
  window.__settingsSections = Object.assign(window.__settingsSections || {}, {
    api: renderApi,
    search: renderSearch,
    memory: renderMemory,
    persona: renderPersona,
    chat: renderChat,
    allow: renderAllow,
    desktop: renderDesktop,
    onebot: renderOnebot,
    tools: renderTools,
    prompt: renderPrompt,
    stub: false,
    unreachable: UNREACHABLE
  });
})();
