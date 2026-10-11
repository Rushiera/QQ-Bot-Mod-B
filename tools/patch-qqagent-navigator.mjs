// patch-qqagent-navigator.mjs — QQ Agent「领航员工具组」幂等补丁
//
// 用法：node patch-qqagent-navigator.mjs [--dry]
// 做什么：把领航员工具组（nav_status / nav_open / nav_close / nav_send / nav_detail）装进 QQ Agent——
//   工具实现调自研单体（app/）的领航员 API（127.0.0.1:3280），本模块不含业务逻辑。
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑即复现。
// 幂等：补丁点带唯一标记 [qqagent-navigator-patch:<id>]；已含标记 = 跳过。
//       新模块（nav-tools.js）按内容比对：一致 = 跳过，有差异 = 覆盖。
// 边界：不动发送面 / 不动安全边界 / 不改既有工具语义。
//
// 🔴 补丁链顺序（后落者改写了上游锚点所在文本，顺序不可颠倒）：
//   session → engage → nosys → memory → sessions-fold → botguard → hardlimit → talkstyle → cattools → **本补丁**
//   本补丁的锚点取自 tools.js 的 import 区与 registerAllTools() 头部 —— 上游 cattools 补丁改过同两处，
//   故必须排在它之后。
//
// 设计（design-qqbotb-navigator.md §二）：领航员 = R喵 的一种工作模式——
//   业务面做「判断与话术」（指令 / 闲聊、怎么回），自研单体做「状态 / 投递 / 观测 / 截图」。
//   本补丁只给业务面装上「手」（工具），语义判断仍在模型手里。
//
// 落点：
//   src/nav-tools.js      工具注册（新模块 · 从 tools/navigator/ 复制）
//   src/tools.js          import + registerAllTools() 调用

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const MODULE_SRC = path.join(HERE, 'navigator');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-navigator-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/**
 * 多形态定点替换：按顺序尝试候选锚点——覆盖「未打过上游补丁 / 已打过」两种源码形态。
 *
 * @param {string} id 补丁点 id
 * @param {string} root 根目录
 * @param {string} rel 相对路径
 * @param {Array<{anchor: string, replacement: string}>} variants 候选
 * @param {number} [expect] 命中次数
 * @returns {void}
 */
function patchVariants(id, root, rel, variants, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  for (const v of variants) {
    const a = toEol(v.anchor, eol);
    const hits = text.split(a).length - 1;
    if (hits !== expect) continue;
    if (!DRY) fs.writeFileSync(file, text.replace(a, () => toEol(v.replacement, eol)), 'utf8');
    results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
    return;
  }
  throw new Error('[' + id + '] 全部候选锚点均未命中（期望 ' + expect + ' 次）');
}

/** 复制新模块：内容一致 = 跳过；有差异 = 覆盖（模块正文以 tools/navigator/ 为准）。 */
function copyModule(id, name) {
  const from = path.join(MODULE_SRC, name);
  const to = path.join(SRC, name);
  const body = fs.readFileSync(from, 'utf8');
  let current = null;
  try { current = fs.readFileSync(to, 'utf8'); } catch { current = null; }
  if (current === body) { results.push({ id, file: 'src/' + name, status: 'skipped' }); return; }
  if (!DRY) fs.writeFileSync(to, body, 'utf8');
  results.push({ id, file: 'src/' + name, status: DRY ? 'dry' : (current === null ? 'applied' : 'updated') });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新模块
// ─────────────────────────────────────────────────────────────────────────────
copyModule('module-nav-tools', 'nav-tools.js');

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/tools.js —— import 领航员工具组
// ─────────────────────────────────────────────────────────────────────────────
patchVariants('tools-import', SRC, 'tools.js', [
  {
    anchor: `import { registerCatTools, imageRoots } from './cat-tools.js';`,
    replacement: `import { registerCatTools, imageRoots } from './cat-tools.js';
// 领航员工具组（QQ 群指挥 CH4 猫群）—— [qqagent-navigator-patch:tools-import]
import { registerNavTools } from './nav-tools.js';`
  },
  {
    anchor: `import { registerCatTools } from './cat-tools.js';`,
    replacement: `import { registerCatTools } from './cat-tools.js';
// 领航员工具组（QQ 群指挥 CH4 猫群）—— [qqagent-navigator-patch:tools-import]
import { registerNavTools } from './nav-tools.js';`
  }
]);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/tools.js —— registerAllTools() 挂载
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-register', SRC, 'tools.js',
`  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();`,
`  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();
  // 领航员工具组 —— [qqagent-navigator-patch:tools-register]
  registerNavTools();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4-6：src/sender.js —— VIP 通道（指定 QQ 的 @ 回复不受发言闸约束）
// ─────────────────────────────────────────────────────────────────────────────
// 过渡态实现：配额 / 硬限对 VIP 的回复跳过；分钟 / 小时技术限频仍在（防封号）。
// 终态由自研单体承载——QQBotB 侧出站（say / sayImage）本就不经业务面闸门。
patch('sender-vip-flag', SRC, 'sender.js',
`    // 与配额同粒度（按条记账）；被拒的发送不占任何配额（抛错在记账之前）。
    const h = getConfig().engage?.hardLimit || {};`,
`    // 与配额同粒度（按条记账）；被拒的发送不占任何配额（抛错在记账之前）。
    // VIP 通道（[qqagent-navigator-patch:sender-vip-flag]）—— 指定 QQ 的 @ 回复不受发言闸约束：
    // 配额 / 硬限跳过（分钟 / 小时技术限频仍在，防封号）。终态由自研单体承载。
    const vipUser = String(getConfig().engage?.vipChannel?.user || '569145850');
    const vipBypass = vipUser !== '' && String(atUserId ?? '') === vipUser;
    const h = getConfig().engage?.hardLimit || {};`);

patch('sender-vip-hard', SRC, 'sender.js',
`    const vipBypass = vipUser !== '' && String(atUserId ?? '') === vipUser;
    const h = getConfig().engage?.hardLimit || {};
    if (h.enabled !== false) {
      const winMs = Math.max(10000, Number(h.windowMs) || 60000);`,
`    const vipBypass = vipUser !== '' && String(atUserId ?? '') === vipUser;
    const h = getConfig().engage?.hardLimit || {};
    if (!vipBypass && h.enabled !== false) { // [qqagent-navigator-patch:sender-vip-hard]
      const winMs = Math.max(10000, Number(h.windowMs) || 60000);`);

patch('sender-vip-quota', SRC, 'sender.js',
`    // 记账在抛错之后 —— 被拒的发送不占配额。
    const q = getConfig().engage?.quota || {};
    if (q.enabled !== false) {
      const winMs = Math.max(10000, Number(q.windowMs) || 120000);`,
`    // 记账在抛错之后 —— 被拒的发送不占配额。
    const q = getConfig().engage?.quota || {};
    if (!vipBypass && q.enabled !== false) { // [qqagent-navigator-patch:sender-vip-quota]
      const winMs = Math.max(10000, Number(q.windowMs) || 120000);`);

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────
const applied = results.filter((r) => r.status === 'applied' || r.status === 'updated').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
console.log(JSON.stringify({ ok: true, dry: DRY, applied, skipped, results }, null, 2));
