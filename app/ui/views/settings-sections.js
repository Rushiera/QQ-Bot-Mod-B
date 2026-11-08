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

  /** 思考强度档位（四档，与服务端档位表对齐：not = 显式不思考，其余强度递增）。 */
  const THINKING_OPTIONS = [
    ['', '默认（跟随服务端）'],
    ['not', '不思考（服务端硬关）'],
    ['low', '低（快、省 token）'],
    ['high', '高（慢、细致）'],
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
   * 表情包实况面板缓存（`GET /api/biz/stickers`）。
   *
   * 与 config 不同源：这里读的是**表情库本体**（`data/stickers.json` 合并 QQ 收藏
   * 后的结果），含每条印象与使用统计——用户在界面里改印象 / 删条目都落在这里。
   *
   * @type {{data: object|null, loaded: boolean, loading: boolean, error: string, query: string, openId: string}}
   */
  const stickerPanel = { data: null, loaded: false, loading: false, error: '', query: '', openId: '' };

  /**
   * 拉一次表情库（单飞；失败落错误文案，不渲染空表冒充「没有表情」）。
   *
   * @param {object} ctx 渲染上下文
   * @param {boolean} [force] 是否强制向协议端重拉收藏
   * @returns {void}
   */
  function refreshStickers(ctx, force) {
    if (stickerPanel.loading) return;
    stickerPanel.loading = true;
    const path = `/api/biz/stickers${force ? '?force=1' : ''}`;
    ctx.api(path).then((r) => {
      if (r && r.ok !== false) {
        stickerPanel.data = r;
        stickerPanel.error = '';
        stickerPanel.loaded = true;
      } else {
        stickerPanel.error = String((r && r.error) || 'unknown');
      }
    }).catch((error) => {
      stickerPanel.error = String((error && error.message) || error);
    }).then(() => {
      stickerPanel.loading = false;
      ctx.reload();
    });
  }

  /**
   * 写一条表情的印象（备注 / 标签 / 用途）后重取面板。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} id 表情 id
   * @param {object} patch `{note, tags, usage}`
   * @returns {void}
   */
  function saveStickerNote(ctx, id, patch) {
    ctx.api('/api/biz/stickers', { method: 'POST', body: Object.assign({ id }, patch) })
      .then((r) => {
        if (!r || r.ok === false) ctx.notice(`保存表情印象失败：${String((r && r.error) || '无响应')}`, 'fail');
        else ctx.notice('表情印象已保存');
        stickerPanel.loaded = false;
        refreshStickers(ctx);
      })
      .catch((error) => ctx.notice(`保存表情印象失败：${String((error && error.message) || error)}`, 'fail'));
  }

  /**
   * 删一条表情（只从 AI 认知层删除；QQ 收藏本体不动）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} item 表情条目
   * @returns {void}
   */
  function removeSticker(ctx, item) {
    const label = item.label || item.id;
    const yes = typeof window.confirm === 'function'
      ? window.confirm(`删除表情「${label}」？\n\n只从 AI 的记忆里删（模型看不到、也不会再发）；QQ 收藏本体不动。`)
      : true;
    if (!yes) return;
    ctx.api(`/api/biz/stickers/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      .then((r) => {
        if (!r || r.ok === false) ctx.notice(`删除失败：${String((r && r.error) || '无响应')}`, 'fail');
        else ctx.notice(`已删除「${label}」`);
        stickerPanel.loaded = false;
        refreshStickers(ctx);
      })
      .catch((error) => ctx.notice(`删除失败：${String((error && error.message) || error)}`, 'fail'));
  }

  /**
   * 表情包实况面板：印象可改 + 何时会发 + 单条删除。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 面板根
   */
  function stickerPanelOf(ctx) {
    const h = ctx.h;
    const box = h.el('div', { class: 'sticker-panel', style: { marginTop: '10px' } });

    if (!stickerPanel.loaded && !stickerPanel.loading && !stickerPanel.error) refreshStickers(ctx);

    if (stickerPanel.error) {
      box.appendChild(h.hint(`表情库读取失败：${stickerPanel.error}`));
      box.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h.button('重试', () => { stickerPanel.error = ''; stickerPanel.loaded = false; refreshStickers(ctx); })));
      return box;
    }
    if (!stickerPanel.loaded || !stickerPanel.data) {
      box.appendChild(h.hint('正在读取表情库…'));
      return box;
    }

    const data = stickerPanel.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total) || items.length;

    // ── 头部：计数 + 何时会发（策略文案原文）+ 操作 ──
    box.appendChild(h.el('div', {
      class: 'hint',
      style: { whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: '12px', lineHeight: '1.6' },
      text: `当前已收集 ${total} 个表情（表情包${data.enabled === false ? '已关闭' : '已开启'} · 积极度 ${data.encourage} 档 · 提示词列举 ${data.promptMax} 个）\n\n`
        + String(data.hint || '')
    }));
    box.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', margin: '8px 0', alignItems: 'center' } },
      h.button('刷新收藏', () => { stickerPanel.loaded = false; refreshStickers(ctx, true); }),
      h.input({
        type: 'text',
        value: stickerPanel.query,
        placeholder: '按印象 / 标签过滤',
        onchange: (v) => { stickerPanel.query = String(v || ''); ctx.reload(); }
      })));

    const q = String(stickerPanel.query || '').trim().toLowerCase();
    const shown = q
      ? items.filter((x) => [x.label, x.desc, x.localNote, x.usage, x.id, ...(x.tags || [])]
        .join(' ').toLowerCase().includes(q))
      : items;

    if (!shown.length) {
      box.appendChild(h.hint(q ? `（没有匹配「${stickerPanel.query}」的表情）`
        : '（还没有收集到表情——群里有人发表情、或模型收藏后会出现在这里）'));
      return box;
    }

    shown.forEach((item) => {
      const row = h.el('div', { class: 'groups-item' + (item.zombie ? ' missing' : '') });
      row.appendChild(h.el('div', { class: 'groups-item-main' },
        h.el('div', { class: 'groups-item-name', text: item.label || '（无备注）' }),
        h.el('div', {
          class: 'groups-item-id mono',
          text: [
            `用 ${item.useCount || 0} 次`,
            item.lastUsedAt ? `末次 ${new Date(item.lastUsedAt).toLocaleString('zh-CN', { hour12: false })}` : '还没用过',
            item.tags && item.tags.length ? `标签 ${item.tags.join('/')}` : '',
            item.zombie ? '⚠ 只有过期直链，可能发不出去' : ''
          ].filter(Boolean).join(' · ')
        })));
      const openBtn = h.el('button', {
        class: 'btn small groups-item-btn', type: 'button',
        text: stickerPanel.openId === item.id ? '收起' : '改印象'
      });
      openBtn.addEventListener('click', () => {
        stickerPanel.openId = stickerPanel.openId === item.id ? '' : item.id;
        ctx.reload();
      });
      const delBtn = h.el('button', { class: 'btn small groups-item-btn', type: 'button', text: '删除' });
      delBtn.addEventListener('click', () => removeSticker(ctx, item));
      row.appendChild(h.el('div', { style: { display: 'flex', gap: '6px' } }, openBtn, delBtn));
      box.appendChild(row);

      if (stickerPanel.openId === item.id) {
        const panel = h.el('div', {
          class: 'persona-chat-editor',
          style: { borderLeft: '2px solid var(--border)', paddingLeft: '10px', margin: '4px 0 10px 0' }
        });
        panel.appendChild(h.hint('备注写「这张图是什么 + 什么场合用」——模型下次挑表情就看这段。'
          + `（末次使用场景：${item.lastContext || '无'}）`));
        panel.appendChild(textField(ctx, '印象 / 备注', item.localNote || item.desc || '',
          { placeholder: '如：猫猫捂脸——被夸到不好意思时用' },
          (v) => saveStickerNote(ctx, item.id, { note: v, tags: item.tags || [], usage: item.usage })));
        panel.appendChild(textField(ctx, '标签（逗号分隔）', (item.tags || []).join(','),
          { placeholder: '可爱,认输,猫娘' },
          (v) => saveStickerNote(ctx, item.id, { note: item.localNote || item.desc || '', tags: splitList(v), usage: item.usage })));
        panel.appendChild(textField(ctx, '用途（可选）', item.usage || '',
          { placeholder: '被夸 / 认输 / 打招呼' },
          (v) => saveStickerNote(ctx, item.id, { note: item.localNote || item.desc || '', tags: item.tags || [], usage: v })));
        panel.appendChild(h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
          h.button('看图', () => {
            ctx.api(`/api/biz/stickers/image?id=${encodeURIComponent(item.id)}`).then((r) => {
              if (!r || !r.ok || !r.dataUrl) {
                ctx.notice(`看图失败：${String((r && r.error) || '无图片')}`, 'fail');
                return;
              }
              const win = window.open('', '_blank');
              if (win) win.document.write(`<title>${item.label || item.id}</title><img src="${r.dataUrl}" style="max-width:96vw;max-height:96vh">`);
              else ctx.notice('看图窗口被浏览器拦截', 'fail');
            }).catch((error) => ctx.notice(`看图失败：${String((error && error.message) || error)}`, 'fail'));
          }),
          h.button('删除这条', () => removeSticker(ctx, item)),
          h.hint(`id ${item.id}${item.source === 'manual' ? ' · 人工标注' : ''}`)));
        box.appendChild(panel);
      }
    });

    return box;
  }

  /**
   * 思考强度：`(thinkingMode, thinkingEffort)` → 一维下拉值。
   *
   * @param {object} api `config.api`
   * @returns {string} 下拉值
   */
  function thinkingValueOf(api) {
    const mode = (api && api.thinkingMode) || 'auto';
    const effort = (api && api.thinkingEffort) || '';
    if (mode === 'off') return 'not';
    return effort;
  }

  /**
   * 一维下拉值 → 写回 patch 片段（`not` / 空 / 具体档位三支）。
   *
   * @param {string} value 下拉值
   * @returns {object} `{thinkingMode, thinkingEffort}`
   */
  function thinkingPatchOf(value) {
    if (value === 'not') return { thinkingMode: 'on', thinkingEffort: 'not' };
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
          '四档 not / low / high / max（与服务端档位表对齐）；not = 让服务端关掉思考',
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

    // ── 卡 2：表情包 ──
    // 上半是开关与档位（写 config）；下半是「AI 现在认得哪些表情」的实况面板：
    // 每条印象 + 使用统计 + 何时会发（策略文案与提示词同一份）+ 可改 + 可删。
    root.appendChild(h.fold({
      icon: '😄',
      title: '表情包',
      sub: '收藏同步 / 发送积极度 / 已有表情与印象',
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
          (n) => push(ctx, { sticker: { promptMaxStickers: n } })),
        stickerPanelOf(ctx)
      ]
    }));

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 三、搜索服务（原版 06-settings-render.js:262 renderSearchSection）
  // ══════════════════════════════════════════════════════════════════════

  // （原 `areaField` 多行文本框构建器已删：2026-11-07 人设页改「选卡」模式后零引用——
  //   角色设定不再在界面里编辑，卡正文只改文件。要恢复编辑面时按当时需求重写。）

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
   * 记忆分节：只留「记忆文件」一张卡（清单 + 刷新 + 立即整理全部会话）。
   *
   * 原「记忆整理」「整理模型」两卡已按 Rushiera 口径删除（2026-11-01）——
   * `memory.consolidateEnabled` 等参数仍在业务面配置里照读照跑，只是无界面写面。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderMemory(ctx) {
    const h = ctx.h;
    const root = h.el('div', { class: 'folds' });

    // ── 卡 1：记忆文件清单（本分节只留这一卡）──
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

  /**
   * 人设库缓存（`GET /api/biz/persona-profiles`）——卡正文在文件里，这里只取索引
   * `{ id, name, path, note, chars, exists }` 与全局 `activeId`。
   *
   * 🔴 `loading` 标志不可省：`ctx.reload()` 会重进本节，没有在途标志时每次重绘都再发一次请求（自旋）。
   */
  const personaProfiles = { items: [], activeId: '', loaded: false, loading: false, error: '' };

  /**
   * 群名映射缓存（`GET /api/groups/online` → `{ [群号]: 群名 }`）。
   *
   * 只用于人设页显示「群名 + 群号」——取不到不影响切换（行内生落群号）。同群名单页同源端点。
   * `loading` 同理防自旋。
   */
  const personaChatNames = { map: {}, loaded: false, loading: false, error: '' };

  // （原 `PARTICIPATION_OPTIONS` 已删：2026-11-07 人设页不再暴露按会话参与度覆盖——
  //   参与度统一走全局 `persona.participation`，per-chat 只留「用哪张卡」。）

  /**
   * 人设页的界面态。
   *
   * `chatKey`：提示词预览按哪个会话组装（空串 = 默认人设）。点某行的任一选卡按钮
   * 即把它设成预览对象——「点了哪张卡」，预览就跟着变成那个会话要发的那份。
   *
   * 选卡是点击切换（无保存按钮）；卡正文走弹窗（`openCardWindow`），不在本页展开。
   *
   * @type {{chatKey: string}}
   */
  const personaState = { chatKey: '' };

  /**
   * 人设选择按钮组（**点击切换**，不用下拉框）。
   *
   * 一个会话/全局只可能选中一张卡：选中项高亮成实心，点另一个即切过去。
   * `includeDefault` = 是否给「跟随默认」按钮（会话行用；默认卡自己要它没意义）。
   *
   * @param {object} ctx 渲染上下文
   * @param {Array} cards 人设库 `[{id, name}]`
   * @param {string} activeId 当前选中 id（空串 = 跟随默认）
   * @param {Function} onPick `(id) => void`
   * @param {boolean} includeDefault 是否含「跟随默认」
   * @returns {Element} 按钮组
   */
  function pickChips(ctx, cards, activeId, onPick, includeDefault) {
    const h = ctx.h;
    const box = h.el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    const make = (id, label) => {
      const active = String(activeId || '') === id;
      const btn = h.el('button', {
        class: 'btn small groups-item-btn',
        type: 'button',
        text: label,
        style: active
          ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d11' }
          : {}
      });
      btn.addEventListener('click', () => onPick(id));
      return btn;
    };
    if (includeDefault) box.appendChild(make('', '跟随默认'));
    cards.forEach((p) => box.appendChild(make(p.id, p.name)));
    return box;
  }

  /**
   * 文本编辑窗口（人设卡 / 系统提示词共用）。
   *
   * 为什么开新窗口而不是内联编辑：正文动辄几千到几万字，内联展开会把设置页整页顶开。
   * 用 `about:blank` + DOM 写入（`textContent` / `value`，不拼 HTML）——正文里的任何
   * 尖括号都按文本处理，不会被当标记执行。
   *
   * 窗口策略见 `app/main.js` 的 `setWindowOpenHandler`：放同源与 about:blank，
   * 其余外链仍交系统浏览器。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} opts 窗口参数
   * @param {string} opts.title 窗口标题
   * @param {Function} opts.load 取正文 `() => Promise<string | {text, note}>`
   * @param {Function} opts.save 保存 `(text) => Promise<{ok, error}>`（回 `{note}` 可改顶栏说明）
   * @param {Array} [opts.actions] 额外按钮 `[{label, run(area, setMeta)}]`
   * @param {string} [opts.note] 顶栏右侧附加说明（生效态之类）
   * @returns {void}
   */
  function openEditWindow(ctx, opts) {
    const o = opts || {};
    const win = window.open('', '_blank', 'width=980,height=780');
    if (!win) {
      ctx.notice('弹窗未打开：窗口被拦截（见 app/main.js 的 setWindowOpenHandler）', 'fail');
      return;
    }
    const doc = win.document;
    doc.title = String(o.title || '编辑');
    doc.body.textContent = '';
    const style = doc.createElement('style');
    style.textContent = 'html,body{margin:0;height:100%;background:#0f1115;color:#d8dee9;'
      + 'font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif}'
      + 'body{display:flex;flex-direction:column}'
      + '.bar{display:flex;align-items:center;gap:10px;padding:10px 14px;'
      + 'border-bottom:1px solid #232833;flex:0 0 auto}'
      + '.bar .title{font-weight:600}'
      + '.bar .meta{color:#7d8698;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.bar .grow{flex:1 1 auto}'
      + 'button{font:12px/1 inherit;padding:7px 14px;border-radius:6px;border:1px solid #2b3240;'
      + 'background:#1b2130;color:#d8dee9;cursor:pointer}'
      + 'button[disabled]{opacity:.55;cursor:default}'
      + 'button.primary{background:#4f8cff;border-color:#4f8cff;color:#0b0d11;font-weight:600}'
      + 'textarea{flex:1 1 auto;width:100%;box-sizing:border-box;border:0;outline:0;resize:none;'
      + 'padding:16px 18px;background:#0f1115;color:#d8dee9;'
      + 'font:13px/1.75 Consolas,"Microsoft YaHei",monospace}';
    doc.head.appendChild(style);

    const bar = doc.createElement('div');
    bar.className = 'bar';
    const title = doc.createElement('span');
    title.className = 'title';
    title.textContent = String(o.title || '编辑');
    const meta = doc.createElement('span');
    meta.className = 'meta';
    meta.textContent = '正在读取…';
    const grow = doc.createElement('span');
    grow.className = 'grow';
    bar.appendChild(title);
    bar.appendChild(meta);
    bar.appendChild(grow);

    const area = doc.createElement('textarea');
    area.spellcheck = false;
    area.disabled = true;

    /** 载入时的正文（按 LF 比较——textarea 会把 CRLF 规范成 LF，不能据此误报「已修改」）。 */
    let loaded = '';
    /** 顶栏右侧附加说明（文件路径 / 覆盖生效态）。 */
    let note = String(o.note || '');
    let saving = false;

    /**
     * 直接改顶栏说明（额外按钮自己写状态时用）。
     *
     * @param {string} text 文案
     * @returns {void}
     */
    const setMeta = (text) => { meta.textContent = String(text); };

    /**
     * 顶栏元信息：字数 + 是否未保存 + 附加说明。
     *
     * @returns {void}
     */
    const showMeta = () => {
      const dirty = loaded && area.value !== loaded;
      setMeta(`${area.value.length} 字${dirty ? ' · 已修改未保存' : ''}${note ? ` · ${note}` : ''}`);
    };

    const saveBtn = doc.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.disabled = true;

    /**
     * 保存（按钮与 Ctrl+S 共用）。
     *
     * @returns {void}
     */
    const save = () => {
      if (saving || typeof o.save !== 'function') return;
      const text = area.value;
      saving = true;
      saveBtn.disabled = true;
      setMeta('保存中…');
      Promise.resolve().then(() => o.save(text)).then((r) => {
        if (r && r.ok) {
          loaded = text;
          if (r.note) note = String(r.note);
          setMeta(`已保存：${text.length} 字${note ? ` · ${note}` : ''}`);
        } else {
          setMeta(`保存失败：${(r && r.error) || 'unknown'}`);
        }
      }).catch((error) => {
        setMeta(`保存失败：${String((error && error.message) || error)}`);
      }).then(() => {
        saving = false;
        saveBtn.disabled = false;
      });
    };

    // 额外按钮（「载入当前标准提示词」「清空」这类）——自带 setMeta 文案，点了不覆盖它
    (Array.isArray(o.actions) ? o.actions : []).forEach((action) => {
      if (!action || typeof action.run !== 'function') return;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = String(action.label || '');
      btn.addEventListener('click', () => {
        if (saving) return;
        action.run(area, setMeta);
      });
      bar.appendChild(btn);
    });

    saveBtn.addEventListener('click', save);
    bar.appendChild(saveBtn);
    doc.body.appendChild(bar);
    doc.body.appendChild(area);
    area.addEventListener('input', showMeta);
    doc.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    });

    Promise.resolve()
      .then(() => (typeof o.load === 'function' ? o.load() : String(o.initial || '')))
      .then((result) => {
        const isObject = result && typeof result === 'object';
        const text = isObject ? result.text : result;
        if (isObject && result.note) note = String(result.note);
        loaded = String(text == null ? '' : text).replace(/\r\n/g, '\n');
        area.value = loaded;
        area.disabled = false;
        saveBtn.disabled = false;
        showMeta();
      })
      .catch((error) => {
        setMeta(`读取失败：${String((error && error.message) || error)}`);
      });
  }

  /**
   * 人设相关缓存置无效并重绘（保存卡正文 / 系统提示词后调用）。
   *
   * 不重取就是旧正文冒充新正文——人设库字数与提示词预览都来自这两个缓存。
   *
   * @param {object} ctx 渲染上下文
   * @returns {void}
   */
  function invalidatePersonaCaches(ctx) {
    personaProfiles.loaded = false;
    promptPreview.chatKey = null;
    promptPreview.loaded = false;
    promptPreview.error = '';
    ctx.reload();
  }

  /**
   * 「看 / 改正文」窗口：人设卡全文，可直接编辑并保存回文件。
   *
   * 保存走 `POST /api/biz/persona-card`：后端只写 `personas/` 内的卡、原子写、
   * 保持原文件 BOM 与换行风格。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} id 人设 id
   * @param {string} name 人设显示名
   * @returns {void}
   */
  function openCardWindow(ctx, id, name) {
    openEditWindow(ctx, {
      title: `人设卡 · ${name}`,
      load: () => ctx.api(`/api/biz/persona-card?id=${encodeURIComponent(id)}`).then((r) => {
        if (!r || !r.ok) throw new Error((r && r.error) || 'unknown');
        return { text: String(r.text || ''), note: String(r.path || '') };
      }),
      save: (text) => {
        if (!text.trim()) return { ok: false, error: '正文为空（要清空请直接删文件）' };
        return ctx.api('/api/biz/persona-card', { method: 'POST', body: { id, text } }).then((r) => {
          if (r && r.ok) {
            invalidatePersonaCaches(ctx);
            return { ok: true, note: String(r.path || '') };
          }
          return r;
        });
      }
    });
  }

  /**
   * 「改系统提示词」窗口：编辑 `persona.systemPromptOverride`。
   *
   * 语义与运行时 override 分支一致（`prompt.js`）：留空 = 用内置标准提示词；
   * 填了 = **整体替换**标准提示词里的人格 / 风格类准则；安全规则 / 工具协议 /
   * 共用机制段恒追加，覆盖不到。
   *
   * 所以给「载入当前标准提示词」——把现在跑的那段抄进编辑框当基底改，不用从零写
   * （初值取后端 `standardPromptText`，与运行时同一份，且已剔除恒追加的三段）。
   *
   * @param {object} ctx 渲染上下文
   * @returns {void}
   */
  function openSystemPromptWindow(ctx) {
    const state = () => (promptPreview.override ? '当前：覆盖生效中' : '当前：内置标准提示词');
    openEditWindow(ctx, {
      title: '系统提示词（覆盖）',
      note: state(),
      load: () => ({ text: promptPreview.override || '', note: state() }),
      actions: [
        {
          label: '载入当前标准提示词',
          run: (area, setMeta) => {
            const base = String(promptPreview.standardText || '');
            if (!base) {
              setMeta('拿不到当前标准提示词——先关掉本窗口点「刷新预览」再进');
              return;
            }
            area.value = base;
            setMeta(`已填入当前标准提示词（${base.length} 字）——改完点保存`);
          }
        },
        {
          label: '清空（恢复内置）',
          run: (area, setMeta) => {
            area.value = '';
            setMeta('已清空——点保存后回到内置标准提示词');
          }
        }
      ],
      save: (text) => ctx.api('/api/biz/persona/system-prompt', { method: 'POST', body: { text } })
        .then((r) => {
          if (!r || !r.ok) return r;
          invalidatePersonaCaches(ctx);
          return { ok: true, note: r.active ? '覆盖生效中' : '内置标准提示词' };
        })
    });
  }

  /**
   * 人设分节（2026-11-07 重做：形态 = 群名单式竖列，**一个会话只能指定一张卡**）。
   *
   * 四张卡：① 人设（默认卡 + 统一开关）② 人设库（看 / 改正文，保存写回文件）③ 每个会话用哪张卡
   * ④ 提示词预览（按所选会话 1:1 组装）。
   *
   * 口径：人格的唯一载体是文件 `personas/<id>.md`；配置只记 id（默认 + 每会话）。
   * 卡正文在「看 / 改正文」窗口里直接改并保存（写回文件，原子写）；芳乃卡是外部原件，
   * 改动前建议自己留一份副本。
   * 机制与工具面在 `personas/_shared.md`，所有卡共用——换卡只换人格，不动机制。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderPersona(ctx) {
    const h = ctx.h;
    const c = ctx.config || {};
    const unified = c.personaUnified !== false;
    const perChat = get(c, ['personaByChat'], {});
    const allow = get(c, ['allow'], {});
    const root = h.el('div', { class: 'folds' });

    // 人设库（卡正文在文件里，这里只有索引）
    const cards = personaProfiles.loaded ? personaProfiles.items : [];
    const globalId = String(get(c, ['persona', 'profileId'], '') || personaProfiles.activeId || '').trim();
    const nameOf = (id) => {
      const hit = cards.find((p) => p.id === id);
      return hit ? hit.name : (id || '未指定');
    };
    const globalName = `${nameOf(globalId)}（默认）`;

    // 人设库还没取到 → 取一次（在途标志防自旋）
    if (!personaProfiles.loaded && !personaProfiles.error && !personaProfiles.loading) {
      personaProfiles.loading = true;
      ctx.api('/api/biz/persona-profiles').then((r) => {
        if (r && r.ok && Array.isArray(r.profiles)) {
          personaProfiles.items = r.profiles;
          personaProfiles.activeId = String(r.activeId || '');
          personaProfiles.loaded = true;
        } else {
          personaProfiles.error = (r && r.error) || '人设库读取失败';
        }
      }).catch((error) => {
        personaProfiles.error = String((error && error.message) || error);
      }).then(() => {
        personaProfiles.loading = false;
        ctx.reload();
      });
    }

    // 群名映射（协议端群列表）：只用于显示「群名 + 群号」，取不到不挡切换
    if (!personaChatNames.loaded && !personaChatNames.loading && !personaChatNames.error) {
      personaChatNames.loading = true;
      ctx.api('/api/groups/online').then((r) => {
        if (r && r.ok && Array.isArray(r.groups)) {
          const map = {};
          r.groups.forEach((g) => { map[String(g.id)] = String(g.name || ''); });
          personaChatNames.map = map;
          personaChatNames.loaded = true;
        } else {
          personaChatNames.error = (r && r.error) || '协议端群列表未取到';
        }
      }).catch((error) => {
        personaChatNames.error = String((error && error.message) || error);
      }).then(() => {
        personaChatNames.loading = false;
        ctx.reload();
      });
    }

    const allowIds = []
      .concat((allow.groups || []).map((g) => `group:${g}`))
      .concat((allow.private || []).map((p) => `private:${p}`))
      .map(String);
    const configuredIds = Object.keys(perChat).map(String);
    // 会话清单 = 白名单 ∪ 已配置过独立人设的会话（白名单外的历史条目不能静默丢）
    const chatIds = allowIds.concat(configuredIds.filter((id) => allowIds.indexOf(id) < 0));

    // 预览的会话键（点某行任一选卡按钮即切过去；空 = 默认人设）
    if (personaState.chatKey && chatIds.indexOf(personaState.chatKey) < 0) personaState.chatKey = '';
    const current = personaState.chatKey;

    // ── 卡 1：人设（默认卡 + 人设库合成一张；点击切换）──
    const head = h.el('div', {});
    head.appendChild(h.hint('人格的唯一载体是文件：`personas/<id>.md`（卡正文）+ `personas/_shared.md`（机制与工具，所有卡共用）。'
      + '换人格 = 换一个 id；点「看 / 改正文」可在窗口里直接编辑，保存即写回该文件并立刻反映到下面的预览。'));
    head.appendChild(boolField(ctx, '所有会话统用默认人设', unified,
      unified ? '开启中：下面按会话指定的人设会保存但不生效——关掉即生效。' : '已关闭：每个会话可以指定自己的一张卡（未指定的跟随默认）。',
      (b) => push(ctx, { personaUnified: b })));
    if (personaProfiles.error) head.appendChild(h.hint(`⚠ 人设库读取失败：${personaProfiles.error}`));
    if (!cards.length) head.appendChild(h.hint(personaProfiles.error ? '人设库不可用（见上方原因）。' : '正在读取人设库…'));

    cards.forEach((p) => {
      const isDefault = p.id === globalId;
      const row = h.el('div', { class: 'groups-item' + (isDefault ? ' on' : '') });
      row.appendChild(h.el('div', { class: 'groups-item-main' },
        h.el('div', { class: 'groups-item-name', text: p.name + (p.exists ? '' : '（读不到）') }),
        h.el('div', {
          class: 'groups-item-id mono',
          text: `${p.path} · ${p.chars} 字${p.note ? ` · ${p.note}` : ''}`
        })));
      // 点击切换：点「设为默认」即把这张卡设为全局默认（当前默认那张显示实心、不可再点）
      const defaultBtn = h.el('button', {
        class: 'btn small groups-item-btn',
        type: 'button',
        text: isDefault ? '默认中' : '设为默认',
        style: isDefault ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d11' } : {}
      });
      defaultBtn.disabled = isDefault;
      defaultBtn.addEventListener('click', () => push(ctx, { persona: { profileId: p.id } }));
      const viewBtn = h.el('button', {
        class: 'btn small groups-item-btn', type: 'button', text: '看 / 改正文'
      });
      // 弹新窗口看全文并可编辑保存（两万多字的卡不内联展开，免得把整页顶开）
      viewBtn.addEventListener('click', () => openCardWindow(ctx, p.id, p.name));
      row.appendChild(defaultBtn);
      row.appendChild(viewBtn);
      head.appendChild(row);
    });
    root.appendChild(h.fold({
      icon: '🎭',
      title: '人设',
      sub: '默认卡 + 人设库（点「设为默认」切换；正文可编辑保存）',
      val: globalName,
      open: true,
      body: head
    }));

    // ── 卡 2：每个会话用哪张卡（竖列，一行一个群）──
    const chatBody = h.el('div', {});
    if (!chatIds.length) {
      chatBody.appendChild(h.hint('（群名单为空——先在「群名单」里添加群聊 / 私聊）'));
    } else {
      chatBody.appendChild(h.hint('点一下即切换（没有保存按钮）：一个会话只能指定一张卡，「跟随默认」= 用上面那张默认卡。运行下一轮即生效，下面的预览同步换成这个会话。'));
      chatIds.forEach((chatKey) => {
        const conf = perChat[chatKey] || {};
        const own = String(conf.profileId || '').trim();
        const effective = own ? nameOf(own) : globalName;
        const row = h.el('div', {
          class: 'groups-item' + (own ? ' on' : '') + (current === chatKey ? ' selected' : '')
        });
        // 主行显示群名（取不到回落会话键），次行给「会话键 · 当前人设」——群名与群号都在
        const chatId = String(chatKey).split(':')[1] || '';
        const groupName = personaChatNames.map[chatId] || '';
        row.appendChild(h.el('div', { class: 'groups-item-main' },
          h.el('div', { class: 'groups-item-name', text: groupName || chatKey }),
          h.el('div', { class: 'groups-item-id mono', text: `${chatKey} · 当前：${effective}` })));
        // 点击切换：点哪个就用哪个，并把提示词预览切到这个会话（一眼看到实发内容）
        row.appendChild(pickChips(ctx, cards, own, (id) => {
          personaState.chatKey = chatKey;
          savePerChat(ctx, chatKey, { profileId: id });
        }, true));
        chatBody.appendChild(row);
      });
    }
    root.appendChild(h.fold({
      icon: '👥',
      title: '每个会话用哪张卡',
      sub: '一个群只能指定一张（不指定跟随默认）',
      val: `${Object.keys(perChat).length} 个已指定`,
      open: false,
      body: chatBody
    }));

    // ── 卡 3：提示词预览（按当前预览的会话 1:1 组装）──
    root.appendChild(promptCard(ctx, current));

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

  // （原 `clearPerChat` 已删：2026-11-07 人设页取消「清空」按钮——点「跟随默认」
  //   即写 `profileId: ''`，`savePerChat` 会把空值字段摘掉，效果等同清空。）

  // ══════════════════════════════════════════════════════════════════════
  // 六、群名单（取代原「聊天白名单」分节 + 独立「群名单」页签）
  //     两栏看板：未启用 / 已启用，拖动或按钮即写；写后按读回值重渲染。
  //     端点：GET /api/groups · GET /api/groups/online · POST /api/groups
  //     （前两个是单体自己的路由，不走 /api/biz 代理——见 app/src/app.js:104-106）
  // ══════════════════════════════════════════════════════════════════════

  /** 群名单缓存（一次刷新取两份：业务面名单 + 协议端实际所在群）。 */
  const groupBoard = {
    allow: [],
    deny: [],
    allowAllWhenEmpty: false,
    online: [],
    onlineError: '',
    busy: false,
    loaded: false,
    status: ''
  };

  /**
   * 按 id 去重并只留纯数字。
   *
   * @param {string[]} list 原始清单
   * @returns {string[]} 干净清单
   */
  function cleanGroupIds(list) {
    const out = [];
    for (const item of list || []) {
      const id = String(item === null || item === undefined ? '' : item).trim();
      if (!/^\d+$/.test(id)) continue;
      if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  /**
   * 写群名单并读回（唯一写入口——拖动 / 按钮 / 手输 / 拒绝名单全走这里）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} override 局部覆盖
   * @param {string} action 动作说明（拼进状态行）
   * @returns {Promise<boolean>} 是否成功
   */
  async function commitGroups(ctx, override, action) {
    const h = ctx.h;
    if (groupBoard.busy) return false;
    groupBoard.busy = true;
    groupBoard.status = (action || '写入') + '…';
    ctx.reload();

    const body = {
      allowGroups: override && override.allowGroups !== undefined ? override.allowGroups : groupBoard.allow,
      denyGroups: override && override.denyGroups !== undefined ? override.denyGroups : groupBoard.deny,
      allowAllWhenEmpty: override && override.allowAllWhenEmpty !== undefined
        ? override.allowAllWhenEmpty : groupBoard.allowAllWhenEmpty
    };
    const r = await ctx.api('/api/groups', { method: 'POST', body });
    groupBoard.busy = false;

    if (!r || r.ok === false) {
      groupBoard.status = (action || '写入') + '失败：' + String((r && (r.error || r.status)) || '无响应');
      ctx.reload();
      return false;
    }
    groupBoard.allow = cleanGroupIds(r.allowGroups);
    groupBoard.deny = cleanGroupIds(r.denyGroups);
    groupBoard.allowAllWhenEmpty = r.allowAllWhenEmpty === true;
    groupBoard.status = (action || '写入') + '：已生效（已启用 ' + groupBoard.allow.length + ' 个）';
    ctx.reload();
    return true;
  }

  /**
   * 建一条群条目（拖动 + 按钮双通道——触摸板 / 远程桌面下按钮永远可用）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} entry `{id, name, enabled, missing, denied}`
   * @returns {Element} 条目节点
   */
  function groupItemOf(ctx, entry) {
    const h = ctx.h;
    const item = h.el('div', {
      class: 'groups-item' + (entry.enabled ? ' on' : '') + (entry.missing ? ' missing' : ''),
      draggable: 'true'
    });
    item.dataset.id = entry.id;
    if (entry.denied) item.title = '在拒绝名单里——启用前先从这里移出拒绝名单';

    const main = h.el('div', { class: 'groups-item-main' },
      h.el('div', { class: 'groups-item-name', text: entry.name || ('群 ' + entry.id) }),
      h.el('div', {
        class: 'groups-item-id mono',
        text: entry.missing ? entry.id + '（协议端未返回该群）' : entry.id
      }));

    const btn = h.el('button', {
      class: 'btn small groups-item-btn', type: 'button', text: entry.enabled ? '移除' : '启用'
    });
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      if (entry.enabled) {
        await commitGroups(ctx, {
          allowGroups: groupBoard.allow.filter((x) => x !== entry.id)
        }, '移除 ' + entry.id);
      } else {
        await commitGroups(ctx, {
          allowGroups: groupBoard.allow.concat([entry.id]),
          // 在拒绝名单里的群要启用，先把它从拒绝名单摘掉——否则业务面按「同群冲突」拒写
          denyGroups: groupBoard.deny.filter((x) => x !== entry.id)
        }, '启用 ' + entry.id);
      }
      btn.disabled = false;
    });

    item.appendChild(main);
    item.appendChild(btn);

    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', entry.id);
      event.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    return item;
  }

  /**
   * 群名单分节：两栏看板（未启用 / 已启用）+ 手输加入 + 折叠高级项。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderGroups(ctx) {
    const h = ctx.h;
    const root = h.el('div', { class: 'folds' });

    // ── 首次取数（名单 + 协议端群列表并行，谁失败都不挡另一个）──
    if (!groupBoard.loaded && !groupBoard.status) {
      groupBoard.status = '载入中…';
      ctx.api('/api/groups').then((lists) => {
        if (!lists || lists.ok === false) {
          groupBoard.status = '载入名单失败：' + String((lists && (lists.error || lists.status)) || '业务面未响应');
          ctx.reload();
          return null;
        }
        groupBoard.allow = cleanGroupIds(lists.allowGroups);
        groupBoard.deny = cleanGroupIds(lists.denyGroups);
        groupBoard.allowAllWhenEmpty = lists.allowAllWhenEmpty === true;
        return ctx.api('/api/groups/online').then((online) => {
          groupBoard.online = online && online.ok ? (online.groups || []) : [];
          groupBoard.onlineError = online && online.ok ? '' : String((online && online.error) || '协议端不可达');
          groupBoard.loaded = true;
          groupBoard.status = groupBoard.onlineError
            ? '名单已载入（' + String(lists.apiUrl || '') + '）；协议端群列表没拿到：' + groupBoard.onlineError
            : '名单已载入（' + String(lists.apiUrl || '') + '）· 协议端 ' + groupBoard.online.length + ' 个群';
          ctx.reload();
        });
      }).catch((error) => {
        groupBoard.status = '载入失败：' + String((error && error.message) || error);
        ctx.reload();
      });
    }

    const names = new Map((groupBoard.online || []).map((g) => [String(g.id), g.name]));
    const allowSet = new Set(groupBoard.allow);
    const denySet = new Set(groupBoard.deny);

    const onEntries = groupBoard.allow.map((id) => ({
      id, name: names.get(id) || '', enabled: true, missing: !names.has(id)
    }));
    const offIds = [];
    for (const g of groupBoard.online || []) if (!allowSet.has(String(g.id))) offIds.push(String(g.id));
    for (const id of groupBoard.deny) if (!allowSet.has(id) && offIds.indexOf(id) < 0) offIds.push(id);
    const offEntries = offIds.map((id) => ({
      id, name: names.get(id) || '', enabled: false, missing: !names.has(id), denied: denySet.has(id)
    }));

    const offBox = h.el('div', { class: 'groups-drop', dataset: { list: 'off' } });
    const onBox = h.el('div', { class: 'groups-drop', dataset: { list: 'on' } });

    /**
     * 一次拖放（拖到右栏 = 启用；拖回左栏 = 移除）。
     *
     * @param {DragEvent} event 事件
     * @param {string} target `on` / `off`
     * @returns {Promise<void>} 完成
     */
    async function onDrop(event, target) {
      event.preventDefault();
      event.currentTarget.classList.remove('drop-hot');
      const id = String(event.dataTransfer.getData('text/plain') || '').trim();
      if (!/^\d+$/.test(id)) return;
      if (target === 'on') {
        if (groupBoard.allow.indexOf(id) >= 0) return;
        await commitGroups(ctx, {
          allowGroups: groupBoard.allow.concat([id]),
          denyGroups: groupBoard.deny.filter((x) => x !== id)
        }, '启用 ' + id);
      } else {
        if (groupBoard.allow.indexOf(id) < 0) return;
        await commitGroups(ctx, { allowGroups: groupBoard.allow.filter((x) => x !== id) }, '移除 ' + id);
      }
    }

    [[offBox, 'off'], [onBox, 'on']].forEach(([zone, target]) => {
      zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        zone.classList.add('drop-hot');
      });
      zone.addEventListener('dragleave', (event) => {
        if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-hot');
      });
      zone.addEventListener('drop', (event) => onDrop(event, target));
    });

    for (const entry of offEntries) offBox.appendChild(groupItemOf(ctx, entry));
    for (const entry of onEntries) onBox.appendChild(groupItemOf(ctx, entry));
    if (!offEntries.length) offBox.appendChild(h.el('p', { class: 'hint groups-empty', text: '（没有未启用的群）' }));
    if (!onEntries.length) onBox.appendChild(h.el('p', { class: 'hint groups-empty', text: '（先把左边的群拖过来）' }));

    // 手输群号加入
    const addInput = h.input({ type: 'text', placeholder: '输群号回车加入' });
    const addBtn = h.button('加入', async () => {
      const raw = String(addInput.value || '');
      const ids = cleanGroupIds((raw.match(/\d+/g) || [])).filter((id) => groupBoard.allow.indexOf(id) < 0);
      if (!ids.length) {
        groupBoard.status = raw.trim() ? '这个群号已经在已启用里了' : '先输个群号';
        ctx.reload();
        return;
      }
      const okDone = await commitGroups(ctx, {
        allowGroups: groupBoard.allow.concat(ids),
        denyGroups: groupBoard.deny.filter((x) => ids.indexOf(x) < 0)
      }, '启用 ' + ids.join('、'));
      if (okDone) addInput.value = '';
    });
    addInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addBtn.click();
    });

    const reloadBtn = h.button('刷新', () => {
      groupBoard.loaded = false;
      groupBoard.status = '';
      ctx.reload();
    });

    const denyArea = h.el('textarea', { class: 'groups-text small', spellcheck: 'false' });
    denyArea.value = groupBoard.deny.join('\n');
    const denyApply = h.button('应用', () => {
      const ids = cleanGroupIds((denyArea.value || '').match(/\d+/g) || []);
      commitGroups(ctx, { denyGroups: ids }, '应用拒绝名单');
    });

    const board = h.el('div', { class: 'groups-board' },
      h.el('div', { class: 'groups-col' },
        h.el('h3', {}, '未启用 ', h.el('span', { class: 'hint', text: offEntries.length + ' 个' })),
        h.el('p', { class: 'hint groups-col-tip', text: '协议端在的全部群——拖到右边即启用' }),
        offBox),
      h.el('div', { class: 'groups-col' },
        h.el('h3', {}, '已启用 ', h.el('span', { class: 'hint', text: onEntries.length + ' 个' })),
        h.el('p', { class: 'hint groups-col-tip', text: '这些群的消息会进猫——拖回左边即移除' }),
        onBox));

    root.appendChild(h.fold({
      icon: '✅',
      title: '群名单',
      sub: '启用 / 未启用 / 拒绝名单 · 拖动即生效',
      val: onEntries.length + ' 启用 · ' + offEntries.length + ' 未启用',
      open: true,
      body: [
        h.el('div', { class: 'groups-bar' }, addInput, addBtn, h.el('span', { class: 'groups-spacer' }), reloadBtn,
          h.el('span', { class: 'hint', text: groupBoard.status || '' })),
        board,
        h.fold({
          icon: '🚫',
          title: '高级：拒绝名单 · 空名单放行',
          sub: '拒绝优先级高于允许',
          val: groupBoard.deny.length ? groupBoard.deny.length + ' 项' : '空',
          open: false,
          body: [
            boolField(ctx, '允许名单为空时放行全部群', groupBoard.allowAllWhenEmpty, '谨慎开启',
              (b) => commitGroups(ctx, { allowAllWhenEmpty: b }, b ? '开启空名单放行' : '关闭空名单放行')),
            h.field('拒绝名单（一行一个群号）', denyArea, '拒绝名单优先级高于白名单；同群不能同时在两边'),
            h.el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, denyApply)
          ]
        })
      ]
    }));

    return root;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 七、桌面端与 OneBot —— 按Rushiera口径整节删除（2026-11-01）
  //     开机自启 / 点关闭最小化托盘 → 搬去「本地设置」（单体自己的 config，不走业务面）
  // ══════════════════════════════════════════════════════════════════════

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
  //     —— 不再单独成节：作为一张卡挂在「人设」分节内（口径：提示词就是人设的产物）。
  // ══════════════════════════════════════════════════════════════════════

  /** 提示词预览缓存（`GET /api/biz/prompt-preview`；按 chatKey 分区缓存）。 */
  const promptPreview = {
    chatKey: null, text: '', tools: [], loaded: false, loading: false, error: '',
    profileId: '', profileName: '', cardMissing: false,
    // 「改系统提示词」窗口要的两份：当前 override 原文 · 可替换段的当前标准提示词
    override: '', standardText: ''
  };

  /**
   * 提示词预览卡：按当前启用态组装后的系统提示词 + 可用工具清单（只读）。
   *
   * `chatKey` 非空时按该会话实际生效的人设组装（后端走运行时同一条
   * `personaForChatOf`）——会话里填了独立人设，这里看到的就是那份；
   * 留空看全局。切换会话即重取，不拿旧结果充数。
   *
   * @param {object} ctx 渲染上下文
   * @param {string} [chatKey] 会话键（空 = 全局人设）
   * @returns {Element} 折叠卡
   */
  function promptCard(ctx, chatKey) {
    const h = ctx.h;
    const key = String(chatKey || '');
    if (promptPreview.chatKey !== key) {
      promptPreview.chatKey = key;
      promptPreview.loaded = false;
      promptPreview.error = '';
      promptPreview.text = '';
      promptPreview.tools = [];
      promptPreview.profileId = '';
      promptPreview.profileName = '';
      promptPreview.cardMissing = false;
      promptPreview.override = '';
      promptPreview.standardText = '';
    }

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

    const card = h.fold({
      icon: '📜',
      title: '提示词预览',
      sub: key ? `按会话 ${key} 的实际人设卡组装 · 预览只读` : '按默认人设卡组装 · 预览只读',
      val: promptPreview.loaded
        ? `${promptPreview.profileName || promptPreview.profileId || '人设卡'} · ${promptPreview.text.length} 字符 · ${promptPreview.tools.length} 工具`
        : '未加载',
      open: false,
      body: [
        h.hint('这份文本由后端用运行时同一套 buildSystemPrompt + personaForChatOf + roleSectionText 组装'
          + '——【角色设定】已由后端拼在系统消息最前（人格在前、公共段在后；自带提示词的卡其后不再有公共段），前端不另拼规则，'
          + '避免与实际发送的提示词漂移。换卡只动最前那一段。'
          + '「改系统提示词」改的是标准提示词（写 `persona.systemPromptOverride`）——安全规则、工具协议、'
          + '共用机制段恒追加，覆盖不到；角色卡正文在人设那张卡的「看 / 改正文」里改。'
          + (promptPreview.systemPromptMode === 'self'
            ? ' 本卡自带系统提示词——人格 + 说话纪律 + 机制与工具纪律全在卡里，标准提示词 / 机制段 / 全局覆盖对这张卡都不生效。'
            : (promptPreview.override ? ' 当前由覆盖接管中。' : ''))),
        promptPreview.cardMissing
          ? h.hint('⚠ 人设卡读不到：本次运行没有角色设定（见系统提示末尾的告警行）。检查 personas/ 目录或 personaProfiles 配置。')
          : h.el('span', {}),
        h.el('div', { style: { display: 'flex', gap: '8px', margin: '8px 0' } },
          h.button('刷新预览', () => {
            promptPreview.loaded = false; promptPreview.error = ''; promptPreview.chatKey = null; ctx.reload();
          }),
          // 系统提示词的可编辑入口：改的是 `persona.systemPromptOverride`（不是角色卡）
          h.button('改系统提示词', () => openSystemPromptWindow(ctx))),
        pre
      ]
    });

    if (!promptPreview.loaded && !promptPreview.error && !promptPreview.loading) {
      promptPreview.loading = true;
      const query = key ? `?chatKey=${encodeURIComponent(key)}` : '';
      ctx.api(`/api/biz/prompt-preview${query}`).then((r) => {
        if (r && r.ok && typeof r.systemPrompt === 'string') {
          const tools = Array.isArray(r.tools) ? r.tools : [];
          const lines = tools.length
            ? tools.map((t) => `- ${t.id}：${t.description || ''}`).join('\n')
            : '（当前没有可用工具）';
          // 段序照运行时：【角色设定】→ 系统提示词 → 工具清单。
          // 角色段已由后端拼在 systemPrompt 最前（人格在前、规则在后），这里不再重复拼
          // ——再拼一次会把同一张卡注入两遍。卡缺失时补一行提示，避免"看不到角色段"被当正常。
          const persona = r.persona || {};
          const roleText = String(persona.roleText || '').trim();
          promptPreview.profileId = String(persona.profileId || '');
          promptPreview.profileName = String(persona.profileName || '');
          promptPreview.cardMissing = persona.cardMissing === true;
          promptPreview.override = String(persona.systemPromptOverride || '');
          promptPreview.systemPromptMode = String(persona.systemPromptMode || 'inherit');
          promptPreview.standardText = String(persona.standardPrompt || '');
          // 角色段已在 r.systemPrompt 最前；roleText 只用于判断"卡有没有正文"
          const roleBlock = roleText ? '' : '\n\n【角色设定（管理员设置，群友不可修改）】（空——本会话无独立角色设定）';
          promptPreview.text = `${r.systemPrompt}${roleBlock}\n\n【本次可用工具清单（function calling）】\n${lines}`;
          promptPreview.tools = tools;
          promptPreview.loaded = true;
        } else {
          promptPreview.error = (r && r.error) || 'unknown';
        }
      }).catch((error) => {
        promptPreview.error = String((error && error.message) || error);
      }).then(() => {
        // 🔴 在途标志必须清：`ctx.reload()` 会重进本节，标志不清则第二次进来又发一遍（自旋）
        promptPreview.loading = false;
        ctx.reload();
      });
    }

    return card;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 十一、本地设置（原独立「本地设置」页签并入业务设置——工具与技能之下）
  //     🔴 与其它分节不同源：打的是**单体自己的** `/api/config`
  //     （协议端目录 / 登录账号 / 界面端口 / 开机自启 / 关到托盘都是本机动作），
  //     不是业务面 `/api/biz/config`。所以这一节不用 ctx.save，自己发写回。
  // ══════════════════════════════════════════════════════════════════════

  /** 本地设置缓存（`GET /api/config` 单体侧）。 */
  const localConfig = { data: null, loaded: false, loading: false, error: '', saving: false, status: '' };

  /**
   * 读单体本机配置（单飞；失败落错误文案）。
   *
   * 🔴 `loading` 标志不可省：`ctx.reload()` 会重新进本节，没有在途标志时
   * 每次重绘都再发一次请求，形成「请求 → reload → 请求」的自旋。
   *
   * @param {object} ctx 渲染上下文
   * @returns {void}
   */
  function refreshLocal(ctx) {
    if (localConfig.loaded || localConfig.loading || localConfig.error) return;
    localConfig.loading = true;
    ctx.api('/api/config').then((r) => {
      // 单体这个端点回裸对象 `{config, paths, ...}`（无 ok 字段）——壳层补 ok:true
      const cfg = r && (r.config || (r.data && r.data.config));
      if (cfg) {
        localConfig.data = cfg;
        localConfig.loaded = true;
      } else {
        localConfig.error = String((r && r.error) || '回执为空');
      }
    }).catch((error) => {
      localConfig.error = String((error && error.message) || error);
    }).then(() => {
      localConfig.loading = false;
      ctx.reload();
    });
  }

  /**
   * 写单体本机配置（写后读回核对）。
   *
   * @param {object} ctx 渲染上下文
   * @param {object} patch 补丁（`{napcat:{}, app:{}}`）
   * @returns {void}
   */
  function saveLocal(ctx, patch) {
    if (localConfig.saving) { ctx.notice('上一笔本机配置保存在途', 'fail'); return; }
    localConfig.saving = true;
    localConfig.status = '保存中…';
    ctx.reload();
    ctx.api('/api/config', { method: 'POST', body: patch }).then((r) => {
      localConfig.saving = false;
      if (!r || r.ok === false) {
        localConfig.status = `保存失败：${String((r && (r.error || r.status)) || '无响应')}`;
        ctx.reload();
        return;
      }
      localConfig.loaded = false;
      localConfig.status = '已保存（目录与账号改动需重启程序生效）';
      refreshLocal(ctx);
    }).catch((error) => {
      localConfig.saving = false;
      localConfig.status = `保存失败：${String((error && error.message) || error)}`;
      ctx.reload();
    });
  }

  /**
   * 本地设置分节：协议端目录 / 登录账号 / 界面端口 / 三个开关。
   *
   * @param {object} ctx 渲染上下文
   * @returns {Element} 分节根
   */
  function renderLocal(ctx) {
    const h = ctx.h;
    const root = h.el('div', { class: 'folds' });
    if (!localConfig.loaded && !localConfig.error) refreshLocal(ctx);
    if (localConfig.error) {
      root.appendChild(h.fold({
        icon: '🖥',
        title: '本地设置',
        sub: '这台机器上的单体（协议端 / 端口 / 自启）',
        val: '读取失败',
        open: true,
        body: [
          h.hint(`本机配置读取失败：${localConfig.error}`),
          h.el('div', { style: { marginTop: '6px' } },
            h.button('重试', () => { localConfig.error = ''; localConfig.loaded = false; ctx.reload(); }))
        ]
      }));
      return root;
    }
    if (!localConfig.loaded) {
      root.appendChild(h.hint('正在读取本机配置…'));
      return root;
    }

    const cfg = localConfig.data || {};
    const nap = cfg.napcat || {};
    const app = cfg.app || {};
    // 草稿：每次改动先落到草稿，再把**整份**草稿写回（场记式局部补丁容易漏字段，
    // 漏一个字段就等于把别处的现值回落成默认值）。
    const draft = {
      napcat: { shellDir: nap.shellDir || '', uin: nap.uin || '' },
      app: {
        port: Number(app.port) || 3280,
        autostartNapcat: app.autostartNapcat === true,
        autoStart: app.autoStart === true,
        closeToTray: app.closeToTray !== false
      }
    };
    const commit = () => saveLocal(ctx, {
      napcat: { shellDir: draft.napcat.shellDir, uin: draft.napcat.uin },
      app: {
        port: draft.app.port,
        autostartNapcat: draft.app.autostartNapcat,
        autoStart: draft.app.autoStart,
        closeToTray: draft.app.closeToTray
      }
    });

    root.appendChild(h.fold({
      icon: '🖥',
      title: '本机配置',
      sub: '改这台机器上的单体（不是业务面那只猫）',
      val: app.port ? `端口 ${app.port}` : '未设置',
      open: true,
      body: [
        textField(ctx, '协议端目录', nap.shellDir || '',
          { placeholder: 'NapCat 程序目录（留空 = 自动探测项目内 runtime/NapCat）' },
          (v) => { draft.napcat.shellDir = String(v || '').trim(); commit(); }),
        textField(ctx, '登录账号', nap.uin || '',
          { placeholder: '要登录的 QQ 号' },
          (v) => { draft.napcat.uin = String(v || '').trim(); commit(); }),
        numField(ctx, '界面端口（改后需重启程序）', Number(app.port) || 3280, { min: 1, max: 65535 },
          (n) => { draft.app.port = n; commit(); }),
        boolField(ctx, '启动时自动拉起协议端', app.autostartNapcat,
          '', (b) => { draft.app.autostartNapcat = b; commit(); }),
        boolField(ctx, '开机自启（随系统启动本应用）', app.autoStart,
          '写 HKCU 的 Run 项', (b) => { draft.app.autoStart = b; commit(); }),
        boolField(ctx, '点关闭时最小化到托盘', app.closeToTray !== false,
          '', (b) => { draft.app.closeToTray = b; commit(); }),
        localConfig.status ? h.hint(localConfig.status) : h.hint('改动即时保存——输入框失焦 / 开关一点即写，无需单独点保存。')
      ]
    }));
    return root;
  }

  // 注册：分节 id → 渲染函数（`settings.js` 按侧栏点击调度；未在此处的分节 = 未接）
  //
  // 🔴 侧栏只列本表的键。2026-11-02 现行集（按Rushiera口径）：
  //    api（模型 API）· memory（记忆）· persona（人设，含提示词预览卡）·
  //    groups（群名单）· chat（聊天设置，含表情包实况面板）· tools（工具与技能）·
  //    local（本地设置——原独立页签并入，排在工具与技能之下）
  //    已删：search（搜索服务，能力以技能形式存在）· allow（聊天白名单，并入群名单）·
  //          desktop（桌面端，拆进本地设置与业务设置）· onebot（OneBot 不显示）· prompt（并入人设）
  //    renderSearch / renderAllow 已随分节删除而移除；promptCard 由 renderPersona 内部调用。
  window.__settingsSections = Object.assign(window.__settingsSections || {}, {
    api: renderApi,
    memory: renderMemory,
    persona: renderPersona,
    groups: renderGroups,
    chat: renderChat,
    tools: renderTools,
    local: renderLocal,
    stub: false,
    unreachable: UNREACHABLE
  });
})();
