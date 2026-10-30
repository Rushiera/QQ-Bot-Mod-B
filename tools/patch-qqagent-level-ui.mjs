// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-level-ui.mjs — 记忆页「发言档位」五档选择器（UI 补丁）
//
// 用法：node patch-qqagent-level-ui.mjs [--dry]
// 前置：**先跑 patch-qqagent-level.mjs**（本补丁的锚点落在它产出的 UI 现状上）
// 幂等：每个补丁点带唯一标记 [qqagent-level-patch:ui-<id>]；已含标记 = 跳过
//
// 做什么：把记忆页群详情的单个「🤫 安静模式」按钮换成五档选择器（1~5 下拉）：
//   冰封 / 保守 / 标准 / 活跃 / 全开 —— 写 config.engage.levelByChat[群号]。
//   选 1 时**同时**把该群加进 engage.quiet.chats（老字段双写）：老版本的
//   quiet-mode.isQuietChat 与本版档位判定都能认同"冰封"；选 2~5 则从 quiet.chats 摘掉。
//
// 为什么下拉而不是五个按钮：记忆页列表每行已经有 3 个徽标位（安静/整理中/删除），
// 五档再排五个按钮会挤爆；下拉在详情头一并排干净，且能直接看到当前档。
//
// 边界：只改 UI（app/ui/app/05-memory-settings.js），不动业务逻辑与配置结构。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const UI = path.join(APP, 'ui', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-level-patch:ui-' + id + ']';

/** 探测文件换行风格（片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中；已应用过则跳过。 */
function patch(id, rel, anchor, replacement, expect = 1) {
  const file = path.join(UI, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(mark(id))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) {
    throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 90)));
  }
  if (DRY) { results.push({ id, file: rel, status: 'dry' }); return; }
  fs.writeFileSync(file, text.split(a).join(r), 'utf8');
  results.push({ id, file: rel, status: 'applied' });
}

// ── 1. 列表徽标：显示档名（不再只显示「🤫 安静」）────────────────────────────
patch('list-badge',
  '05-memory-settings.js',
  `    // 安静模式标记（[qqagent-quiet-patch:ui-list-quiet-def]）——本群是否处于安静模式
    const quietIds = ((((state.config || {}).engage || {}).quiet || {}).chats || []).map(String);
    const quietHtml = quietIds.includes(String(key).split(':')[1] || '')
      ? \`<span class="unread-pill" style="background:var(--blue,#3b82f6)">🤫 安静</span>\`
      : '';`,
  `    // 发言档位标记（${mark('list-badge')}）——本群当前几档（五档；未设置 = 标准档 3）
    const levelHtml = (() => {
      const id = String(key).split(':')[1] || '';
      const lv = engageLevelOf(state.config || {}, id);
      if (!lv) return '';
      const color = lv.level === 1 ? 'var(--blue,#3b82f6)' : (lv.level >= 4 ? 'var(--orange)' : 'var(--muted,#8a8f98)');
      return \`<span class="unread-pill" style="background:\${color}" title="发言档位 \${lv.level}/\${lv.count}：\${esc(lv.name)}">\${lv.level === 1 ? '🤫 ' : ''}\${esc(lv.name)}</span>\`;
    })();`);

// ── 2. 列表徽标插槽：quietHtml → levelHtml ──────────────────────────────────
patch('list-html',
  '05-memory-settings.js',
  '          ${quietHtml}<!-- [qqagent-quiet-patch:ui-list-quiet-html] -->',
  `          \${levelHtml}<!-- ${mark('list-html')} -->`);

// ── 3. 详情页状态：quietOn → 当前档 ────────────────────────────────────────
patch('detail-state',
  '05-memory-settings.js',
  `    // 安静模式群清单（[qqagent-quiet-patch:ui-detail-quiet-list]）——「🤫 安静模式」开关的状态源
    const quietIds = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const quietOn = kind === 'group' && quietIds.includes(String(chatId));`,
  `    // 发言档位（${mark('detail-state')}）——五档选择器的状态源（未设置 = 标准档 3）
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const curLevel = engageLevelOf(cfg, chatId);`);

// ── 4. 详情页按钮：单按钮 → 五档下拉 ───────────────────────────────────────
patch('detail-btn',
  '05-memory-settings.js',
  `    // 安静模式开关（[qqagent-quiet-patch:ui-detail-quiet-btn]）——仅群聊显示
    const quietBtnHtml = kind === 'group'
      ? '<button class="btn btn-small ' + (quietOn ? 'btn-primary' : '') + '" id="mem-quiet-btn" title="安静模式：能不发言就不发言，只有被 @ / 拍一拍 才回应；每 6 小时做一次只整理不发言的记忆沉淀（存档与记忆照常）">🤫 安静模式</button>'
      : '';`,
  `    // 发言档位选择器（${mark('detail-btn')}）——仅群聊显示；五档写进 engage.levelByChat
    const levelSelectHtml = kind === 'group' && curLevel
      ? '<label class="muted" for="mem-level-sel" title="发言档位：只调这一拍要不要开口（入场率）；发言配额 5 条/2 分钟与浏览节拍不受影响">发言档位</label>'
        + ' <select id="mem-level-sel" class="btn btn-small" style="min-width:8em">'
        + LEVEL_NAMES.map((n, i) => \`<option value="\${i + 1}"\${curLevel.level === i + 1 ? ' selected' : ''}>\${i + 1}· \${esc(n)}</option>\`).join('')
        + '</select>'
      : '';`);

// ── 5. 详情页插槽：quietBtnHtml → levelSelectHtml ──────────────────────────
patch('detail-html',
  '05-memory-settings.js',
  '          ${quietBtnHtml}<!-- [qqagent-quiet-patch:ui-detail-quiet-html] -->',
  `          \${levelSelectHtml}<!-- ${mark('detail-html')} -->`);

// ── 6. 事件绑定：quiet 按钮 handler → 下拉 change handler ──────────────────
patch('detail-bind',
  '05-memory-settings.js',
  `    // 🤫 安静模式开关（[qqagent-quiet-patch:ui-detail-quiet-handler]）
    const quietBtnEl = detail.querySelector('#mem-quiet-btn');
    if (quietBtnEl && kind === 'group') {
      quietBtnEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleQuietChat(chatId, chatKey);
      });
    }`,
  `    // 发言档位选择器（${mark('detail-bind')}）——变更即写 engage.levelByChat
    const levelSelEl = detail.querySelector('#mem-level-sel');
    if (levelSelEl && kind === 'group') {
      levelSelEl.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEngageLevel(chatId, chatKey, Number(levelSelEl.value));
      });
    }`);

// ── 7. 写配置函数：新增 setEngageLevel（保留 toggleQuietChat 供老入口用）────
patch('set-fn',
  '05-memory-settings.js',
  `async function toggleQuietChat(groupId, chatKey) {`,
  `/**
 * 设置某群的发言档位（${mark('set-fn')}）。
 *
 * 写 config.engage.levelByChat[群号] = 1~5；
 * 选 1（冰封）时同时把该群并入 engage.quiet.chats —— 老版本/老路径（quiet-mode.js 的
 * isQuietChat）也认得出"冰封"，两个字段语义一致，不产生分歧。
 * 选 2~5 时从 quiet.chats 摘掉该群（否则 isQuietChat 恒真，冰封语义会盖住档位）。
 */
async function setEngageLevel(groupId, chatKey, level) {
  const id = String(groupId || '').trim();
  if (!/^\\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法设置发言档位'); return; }
  const n = Math.min(5, Math.max(1, Math.round(Number(level) || 3)));
  const cfg = state.config || await api('/api/config');
  const map = { ...(((cfg.engage || {}).levelByChat) || {}) };
  map[id] = n;
  const quietCur = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
  const quietNext = n === 1
    ? (quietCur.includes(id) ? quietCur : [...quietCur, id])
    : quietCur.filter((x) => x !== id);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { levelByChat: map, quiet: { chats: quietNext } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(\`保存失败：\${e.message}\`);
  }
}

async function toggleQuietChat(groupId, chatKey) {`);

// ── 8. 档位工具函数（插在 toggleQuietChat 之前）────────────────────────────
patch('helpers',
  '05-memory-settings.js',
  `async function toggleQuietChat(groupId, chatKey) {`,
  `/** 五档档名（与 config.engage.levels 默认表一致；UI 只作显示，判定在 src 侧）。${mark('helpers')} */
const LEVEL_NAMES = ['冰封', '保守', '标准', '活跃', '全开'];

/** 取某群的档位（未设置 = 3 标准档；返回 null = 该群无法分档）。 */
function engageLevelOf(cfg, groupId) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  const engage = (cfg && cfg.engage) || {};
  const map = engage.levelByChat || {};
  let level = 3;
  if (map[id] != null) {
    const n = Math.round(Number(map[id]));
    if (Number.isFinite(n)) level = Math.min(5, Math.max(1, n));
  } else if ((((engage.quiet || {}).chats) || []).map(String).includes(id)) {
    level = 1;
  }
  return { level, count: LEVEL_NAMES.length, name: LEVEL_NAMES[level - 1] };
}

async function toggleQuietChat(groupId, chatKey) {`);

// ── 输出 ───────────────────────────────────────────────────────────────────
const applied = results.filter((r) => r.status === 'applied').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
const dry = results.filter((r) => r.status === 'dry').length;
console.log(JSON.stringify({ ok: true, dry: DRY, applied, skipped, dryCount: dry, points: results }, null, 2));
