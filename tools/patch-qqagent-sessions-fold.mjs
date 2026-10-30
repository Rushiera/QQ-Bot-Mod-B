// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-sessions-fold.mjs — QQ Agent v0.4.0「会话按群折叠」幂等补丁
//
// 用法：node patch-qqagent-sessions-fold.mjs [--dry]
// 做什么：把 design-qqbotb-session.md §八 的改动落进 _unpack 源码
//   （/api/sessions 返回群会话一级数据 + 会话页两级渲染：群会话 → 运行记录）
// 语义：**源码改动的唯一落盘通道**——重装应用后重跑本脚本即复现（_unpack 可弃）
// 幂等：每个补丁点带唯一标记 [qqagent-fold-patch:<id>]；已含标记 = 跳过，可反复运行
// 边界：不动会话生命周期 / 发送队列 / 记忆面；只动「会话页怎么呈现」与一个只读 API 字段

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-fold-patch:' + id + ']';

function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

function patch(id, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(APP, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 70)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：src/routes.js —— /api/sessions 附群会话一级数据
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-import', 'src/routes.js',
  `import { listGroupEntries, appendGroupEntry, replaceGroupEntries, removeGroupEntry, groupMemoryStats } from './group-memory.js';`,
  `import { listGroupEntries, appendGroupEntry, replaceGroupEntries, removeGroupEntry, groupMemoryStats } from './group-memory.js';
// 每会话状态（群会话一级列表：会话起点 / 轮转次数 / 前文规模）——[qqagent-fold-patch:routes-import]
import { getSessionState } from './session-state.js';`);

patch('routes-sessions-chats', 'src/routes.js',
  `      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }`,
  `      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const list = sessions.listSummaries(limit);
        // 群会话一级数据（[qqagent-fold-patch:routes-sessions-chats]）——
        // 会话页按群折叠的头部：每 chatKey 的会话起点 / 轮转次数 / 前文规模 / 未读。
        // 键集合 = 存档里有消息的会话 ∪ 运行记录里出现过的会话（保证两级都不漏）。
        const keys = store.listChats();
        const seen = new Set(keys.map(String));
        for (const s of list) if (s.chatKey) seen.add(String(s.chatKey));
        // 白名单里的会话也建行：新开的群在会话页立刻可见（第一条消息到达才落档）
        const allow = getConfig().allow || {};
        for (const gid of (allow.groups || [])) seen.add('group:' + String(gid));
        for (const uid of (allow.private || [])) seen.add('private:' + String(uid));
        const chats = [...seen].map((key) => {
          const meta = store.getChatMeta(key);
          const st = getSessionState(key);
          return {
            chatKey: key,
            startedAt: st.startedAt,
            rollovers: st.rollovers,
            lastPromptTokens: st.lastPromptTokens,
            total: meta.total,
            unread: meta.unread,
            lastTs: meta.lastTs
          };
        });
        return json(res, 200, { sessions: list, chats });
      }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：ui/app/02-sse-sessions.js —— 会话页两级结构（群会话 → 运行记录）
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-load', 'ui/app/02-sse-sessions.js',
  `    state.sessions = data.sessions || [];`,
  `    state.sessions = data.sessions || [];
    // 群会话一级数据（[qqagent-fold-patch:ui-load]）——会话按群折叠的头部信息
    state.sessionChats = data.chats || [];`);

patch('ui-helpers', 'ui/app/02-sse-sessions.js',
  `function renderSessionList() {`,
  `// ── 会话按群折叠（[qqagent-fold-patch:ui-helpers]）────────────────────────
// 一级 = 群会话（每 chatKey 一行），二级 = 该群的运行记录。
// 折叠态：state.groupFold[chatKey] = true/false（用户手动点过）；undefined = 自动
// （有运行中 / 等待中，或当前选中在该群里 → 展开；只有一个群时也展开，等同旧观感）。
function sessionGroupOrder(list) {
  const keys = [];
  for (const s of list) {
    const k = String(s.chatKey || 'unknown');
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

function sessionGroupInfo(key, list) {
  const chats = state.sessionChats || [];
  const meta = chats.find((c) => String(c.chatKey) === String(key)) || {};
  const sub = list.filter((s) => String(s.chatKey || 'unknown') === String(key));
  const active = sub.some((s) => s.status === 'running' || s.status === 'waiting');
  const selected = sub.some((s) => s.id === state.currentSessionId);
  const latest = sub.reduce((n, s) => Math.max(n, Number(s.startedAt) || 0), 0);
  return { key, meta, list: sub, active, selected, latest };
}

function sessionGroupOpen(key, info, singleGroup) {
  const manual = state.groupFold ? state.groupFold[key] : undefined;
  if (manual === true || manual === false) return manual;
  return info.active || info.selected || !!singleGroup;
}

function sessionGroupHeadHtml(key, info, open) {
  const name = formatChatTitle(key, chatNameOf(key));
  const m = info.meta || {};
  const bits = [];
  if (m.startedAt) bits.push('会话起点 ' + fmtTime(m.startedAt));
  if (m.lastPromptTokens) bits.push('前文 ' + fmtTokens(m.lastPromptTokens));
  if (m.rollovers) bits.push('轮转 ' + m.rollovers + ' 次');
  bits.push(info.list.length + ' 条记录');
  if (m.unread) bits.push('未读 ' + m.unread);
  const badge = info.active ? '<span class="status-badge status-running">进行中</span>' : '';
  return '<div class="session-item session-group" data-group="' + esc(key) + '" data-open="' + (open ? '1' : '0') + '">'
    + '<div class="session-title"><span class="session-chat">' + (open ? '▾ ' : '▸ ') + esc(name) + '</span>'
    + '<span class="session-time">' + esc(fmtTime(info.latest)) + '</span></div>'
    + '<div class="session-meta">' + badge
    + bits.map((b) => '<span>' + esc(b) + '</span>').join('')
    + '</div></div>';
}

function renderSessionList() {`);

patch('ui-list', 'ui/app/02-sse-sessions.js',
  `  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  box.innerHTML = shown.map((s) => {`,
  `  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  // ── 会话按群折叠（[qqagent-fold-patch:ui-list]）──
  // 先把本页记录按 chatKey 归拢，再按「有运行中 > 有未读 > 最近活跃」排群序。
  const foldInfos = sessionGroupOrder(shown).map((key) => sessionGroupInfo(key, shown));
  foldInfos.sort((a, b) => (Number(b.active) - Number(a.active))
    || (Number(b.meta.unread || 0) - Number(a.meta.unread || 0))
    || (b.latest - a.latest));
  const singleGroup = foldInfos.length <= 1;
  const renderRow = (s) => {`);

patch('ui-close', 'ui/app/02-sse-sessions.js',
  `  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示`,
  `  };
  // [qqagent-fold-patch:ui-close]
  box.innerHTML = foldInfos.map((info) => {
    const open = sessionGroupOpen(info.key, info, singleGroup);
    const head = sessionGroupHeadHtml(info.key, info, open);
    return open ? head + info.list.map(renderRow).join('') : head;
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示`);

patch('ui-click', 'ui/app/02-sse-sessions.js',
  `  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });`,
  `  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  // 群会话头：点一下折叠 / 展开（[qqagent-fold-patch:ui-click]）
  $$('.session-group[data-group]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.group;
      state.groupFold = state.groupFold || {};
      state.groupFold[key] = el.dataset.open !== '1';   // 当前是展开 → 收起，反之展开
      renderSessionList();
    });
  });
  // 运行记录行：只认带 data-id 的（群头不参与选中）
  $$('.session-item[data-id]', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });`);

const applied = results.filter((r) => r.status === 'applied').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
console.log('patch-qqagent-sessions-fold：applied ' + applied + ' / skipped ' + skipped + (DRY ? '（dry-run，未落盘）' : ''));
for (const r of results) console.log('  [' + r.status + '] ' + r.id + '  ' + r.file);
