// verify-qqagent-fold.mjs — 「会话按群折叠」自测
//
// 用法：node verify-qqagent-fold.mjs
// 判据：design-qqbotb-session.md §八 四条
//   1 多群同时有运行时，一级列表每群一行，互不混淆
//   2 展开某群只看到该群的运行记录
//   3 群会话头部显示该群当前的会话起点与前文规模
//   4 新群开跑后三处各自出现该群条目（数据层由 chatKey 保证，本自测验分组逻辑 + API 契约）
//
// 手段：源码标记 / 语法检查 / 补丁幂等 / 从 UI 源码抽出折叠逻辑做纯函数沙箱验证。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const UI = path.join(APP, 'ui', 'app', '02-sse-sessions.js');
const ROUTES = path.join(APP, 'src', 'routes.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

// ── 判据 3 / 4：源码标记 + 语法检查 ────────────────────────────────────────
const uiText = fs.readFileSync(UI, 'utf8');
const routesText = fs.readFileSync(ROUTES, 'utf8');
check('3a UI 源码带折叠标记（可追溯 / 重装可复现）',
  uiText.includes('[qqagent-fold-patch:ui-helpers]') && uiText.includes('[qqagent-fold-patch:ui-list]')
  && uiText.includes('[qqagent-fold-patch:ui-close]') && uiText.includes('[qqagent-fold-patch:ui-click]'));
check('4a API 附群会话一级数据（chats 字段 + 每群会话状态）',
  routesText.includes('[qqagent-fold-patch:routes-sessions-chats]')
  && routesText.includes('lastPromptTokens: st.lastPromptTokens')
  && routesText.includes('rollovers: st.rollovers'));

let syntaxOk = true;
let syntaxDetail = '';
for (const file of [UI, ROUTES]) {
  try {
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  } catch (error) {
    syntaxOk = false;
    syntaxDetail += path.basename(file) + ' 语法错误；';
  }
}
check('3b 两个改动文件语法检查通过', syntaxOk, syntaxDetail || 'node --check 全过');

// ── 补丁幂等 ───────────────────────────────────────────────────────────────
let patchOut = '';
try {
  patchOut = execFileSync(process.execPath, [path.join(HERE, 'patch-qqagent-sessions-fold.mjs')], { encoding: 'utf8' });
} catch (error) {
  patchOut = 'ERR ' + String(error?.message ?? error);
}
check('3c 补丁脚本可重放（幂等：applied 0 / 全部跳过）',
  patchOut.includes('applied 0') && patchOut.includes('skipped 7'), patchOut.split('\n')[0]);

// ── 判据 1 / 2 / 3：折叠逻辑（从 UI 源码抽出，纯函数沙箱）──────────────────
const start = uiText.indexOf('function sessionGroupOrder');
const end = uiText.indexOf('function renderSessionList()');
check('3d 折叠逻辑可从 UI 源码抽出', start > 0 && end > start, 'chars=' + (end - start));
const helpersSrc = uiText.slice(start, end);

const state = {
  currentSessionId: null,
  sessionChats: [
    { chatKey: 'group:1097492606', startedAt: 1791559295000, rollovers: 2, lastPromptTokens: 41710, unread: 3 },
    { chatKey: 'group:689942975', startedAt: 1791569000000, rollovers: 0, lastPromptTokens: 8200, unread: 0 }
  ],
  groupFold: {}
};
const factory = new Function('state', 'esc', 'fmtTime', 'fmtTokens', 'formatChatTitle', 'chatNameOf',
  helpersSrc + '\nreturn { sessionGroupOrder, sessionGroupInfo, sessionGroupOpen, sessionGroupHeadHtml };');
const api = factory(
  state,
  (s) => String(s ?? ''),
  (ts) => 'T' + ts,
  (n) => String(n) + 'tok',
  (key) => '群' + String(key).split(':')[1],
  () => ''
);

const sessions = [
  { id: 's1', chatKey: 'group:1097492606', status: 'done', startedAt: 1791569000000 },
  { id: 's2', chatKey: 'group:1097492606', status: 'done', startedAt: 1791568000000 },
  { id: 's3', chatKey: 'group:689942975', status: 'done', startedAt: 1791567000000 }
];
const order = api.sessionGroupOrder(sessions);
check('1a 一级单位 = 群（两个群两行，互不混淆）',
  order.length === 2 && order[0] === 'group:1097492606' && order[1] === 'group:689942975',
  JSON.stringify(order));
const infoA = api.sessionGroupInfo('group:1097492606', sessions);
const infoB = api.sessionGroupInfo('group:689942975', sessions);
check('1b 归拢正确：A 群 2 条 / B 群 1 条（不串味）',
  infoA.list.length === 2 && infoB.list.length === 1
  && infoA.list.every((s) => s.chatKey === 'group:1097492606'),
  'A=' + infoA.list.length + ' B=' + infoB.list.length);
check('2a 展开态：默认收起（非活跃 / 未选中 / 多群）',
  api.sessionGroupOpen('group:1097492606', infoA, false) === false);
check('2b 自动展开：该群有运行中 / 等待中',
  api.sessionGroupOpen('group:1097492606', api.sessionGroupInfo('group:1097492606', [
    { id: 's9', chatKey: 'group:1097492606', status: 'running', startedAt: 1 }
  ]), false) === true);
check('2c 自动展开：当前选中在该群里',
  (() => {
    state.currentSessionId = 's3';
    const fresh = api.sessionGroupInfo('group:689942975', sessions);
    const r = api.sessionGroupOpen('group:689942975', fresh, false) === true;
    state.currentSessionId = null;
    return r;
  })());
check('2d 单群场景等同旧观感（自动展开）',
  api.sessionGroupOpen('group:689942975', infoB, true) === true);
check('2e 手动折叠优先于自动（记住用户操作）',
  (() => {
    state.groupFold['group:1097492606'] = false;   // 手动收起
    const collapsed = api.sessionGroupOpen('group:1097492606', infoA, true) === false;
    state.groupFold['group:689942975'] = true;     // 手动展开
    const opened = api.sessionGroupOpen('group:689942975', infoB, false) === true;
    delete state.groupFold['group:1097492606'];
    delete state.groupFold['group:689942975'];
    return collapsed && opened;
  })());
check('3e 群头显示会话起点 / 前文规模 / 轮转次数',
  (() => {
    const html = api.sessionGroupHeadHtml('group:1097492606', infoA, false);
    return html.includes('群1097492606') && html.includes('会话起点 T1791559295000')
      && html.includes('前文 41710tok') && html.includes('轮转 2 次') && html.includes('2 条记录')
      && html.includes('data-open="0"');
  })(), api.sessionGroupHeadHtml('group:1097492606', infoA, false).slice(0, 120));
check('3f 展开态群头带 ▾ / 收起带 ▸（可点性可见）',
  api.sessionGroupHeadHtml('group:1097492606', infoA, true).includes('▾ ')
  && api.sessionGroupHeadHtml('group:1097492606', infoA, false).includes('▸ '));

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('\n' + JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name)
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
