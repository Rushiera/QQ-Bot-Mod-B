// patch-qqagent-fileread.mjs — QQ Agent「受控根只读文件面」幂等补丁（B23 前置）
//
// 用法：node patch-qqagent-fileread.mjs [--dry]
// 做什么：把 file-tools.js（read_file / list_dir）装进 QQ Agent ——
//   1) 复制新模块 src/file-tools.js
//   2) src/tools.js：import + registerAllTools() 调用
//   3) src/config.js：tools.fileRead 默认段（受控根 workspace + ccbp，与 CH4 猫的 enabledRoots 一致）
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑即复现。
// 幂等：每个补丁点带唯一标记 [qqagent-fileread-patch:<id>]；已含标记 = 跳过。
// 边界：只读文件面（不提供写 / 删 / 移动）；不改发送面、记忆面、领航员面。
//
// 🔴 补丁链顺序：接在 rapport 之后（链尾）——锚点取自 tools.js 的 import 区与 registerAllTools，
//    上游补丁未触及这两处；重放时上游全部 skip。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const MODULE_SRC = path.join(HERE, 'filetools');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-fileread-patch:' + id + ']';

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

/** 复制新模块：内容一致 = 跳过；有差异 = 覆盖（模块正文以 tools/filetools/ 为准）。 */
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
copyModule('module-file-tools', 'file-tools.js');

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/tools.js —— import + registerAllTools()
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', SRC, 'tools.js',
`import { registerCatTools, imageRoots } from './cat-tools.js';`,
`import { registerCatTools, imageRoots } from './cat-tools.js';
// 受控根只读文件面（read_file / list_dir）—— ${mark('tools-import')}
import { registerFileTools } from './file-tools.js';`);

patch('tools-register', SRC, 'tools.js',
`  registerCatTools();`,
`  registerCatTools();
  // 受控根只读文件面（read_file / list_dir）—— ${mark('tools-register')}
  registerFileTools();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/config.js —— tools.fileRead 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-file-read', SRC, 'config.js',
`  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用`,
`  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    // 受控根只读文件面（read_file / list_dir）—— ${mark('config-file-read')}
    // 根 id / 寻址 / 越界拒绝与 CH4 受控根同口径；默认给 workspace + ccbp
    // （与 CH4 猫的 enabledRoots 一致）。要放开更多根，往 roots 里加 { id, path }。
    fileRead: {
      roots: [
        { id: 'workspace', path: path.resolve(ROOT, '..', '..', '..', '..') },
        { id: 'ccbp', path: path.resolve(ROOT, '..', '..', '..', '..', '..', 'CatCatBigParty') }
      ],
      maxBytes: 2097152,
      maxCharsPerRead: 60000
    },`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  app: APP,
  results,
  counts: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {})
}, null, 2));
