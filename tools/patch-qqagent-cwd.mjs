// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-cwd.mjs — QQ Agent「工作目录钉死」幂等补丁
//
// 用法：node patch-qqagent-cwd.mjs [--dry]
// 做什么：让 QQ Agent 启动时把工作目录钉在自己的目录，不再继承启动者——
//   ① 应用层：electron/main.js 首段 process.chdir(自己的目录)
//      打包态 = exe 所在目录（双击启动时的自然 cwd）；开发态 = 应用根
//   ② 启动器层：应用内 bat + 项目根 bat/vbs 显式钉死 cwd
//      （cd /d ／ start /D ／ WshShell.CurrentDirectory）
// 语义：源码改动的唯一落盘通道——重拆包 / 重装后重跑本补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-cwd-patch:<id>]；已含标记 = 跳过
// 边界：不动宿主与 SetUp；不改应用的数据目录解析（那是 electron/main.js
//       resolveDataDir 与 src/profile.js 的既有职责）
//
// 判例（2026-10-10）：应用以「启动者的工作目录」为 cwd 常驻——被从宿主运行区
// D:\Mau\MauOut 拉起后，主进程与 gpu / network / renderer 四个进程一起持锁该
// 目录，宿主自更新部署（SetUp relaunch 的现行目录改名）连续两次失败。
// 机理：`start "" "<exe>"` 与 WshShell.Run 都不设 cwd，子进程继承启动者 cwd；
// 宿主侧工具通道的默认 cwd 就是宿主运行区，于是「从哪儿拉起」= 「锁住哪儿」。
//
// 🔴 .bat / .vbs 写入铁律：两文件是 ASCII + CRLF，禁用会改编码 / 换行的通道
// 写（cmd 按 GBK 解析、WSH 按 ANSI 解析；BOM 或 LF 会让它们解析崩）。
// 本脚本按行保真：只替换锚点区段，换行风格随原文件，并在写后断言仍为纯 ASCII。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, '_unpack', 'resources', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-cwd-patch:' + id + ']';

/** 探测文件换行风格（片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 纯 ASCII 断言（.bat / .vbs 专用——非 ASCII 字节会破坏 cmd / WSH 解析）。 */
function assertAscii(file) {
  const text = fs.readFileSync(file, 'utf8');
  const bad = [...text].findIndex((ch) => ch.charCodeAt(0) > 127);
  if (bad >= 0) throw new Error('非 ASCII 字节 @ ' + bad + '：' + file);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = toEol(mark(id), eol);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  if (!DRY && /\.(bat|vbs)$/i.test(rel)) assertAscii(file);
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied', eol: eol === '\r\n' ? 'CRLF' : 'LF' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：应用层——electron/main.js 首段钉死工作目录
//  位置约束：必须在 Electron 拉起子进程之前（gpu / network / renderer 继承主进程 cwd），
//  故插在 app.disableHardwareAcceleration() 之前（模块体最前段）。
//  >>> / <<< 包裹供 verify-qqagent-cwd.mjs 抽段实跑（测的是本文件的真实代码文本）。
// ─────────────────────────────────────────────────────────────────────────────
patch('main-chdir', APP, 'electron/main.js',
`// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();`,
`// ── 工作目录钉死（[qqagent-cwd-patch:main-chdir]）──────────────────────────
// 2026-10-10 判例：应用以「启动者的工作目录」为 cwd 常驻——被从宿主运行区
// （D:\\Mau\\MauOut）拉起后，主进程与 gpu / network / renderer 四个进程一起
// 持锁该目录，宿主自更新部署（现行目录改名）连续两次失败。
// 约定：应用只认自己的目录——打包态 = exe 所在目录（= 双击启动的自然 cwd）；
// 开发态 = 应用根（resources/app）。子进程继承主进程 cwd，故本段必须在
// Electron 拉起子进程之前执行；启动器侧另有 cd /d ／ start /D 兜底。
// >>> qqagent-cwd-patch:main-chdir
try {
  const ownDir = app.isPackaged
    ? path.dirname(process.execPath)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(ownDir);
} catch (error) {
  console.error('[cwd] 工作目录钉死失败（不阻塞启动）:', error?.message ?? error);
}
// <<< qqagent-cwd-patch:main-chdir
// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：应用内启动器（_unpack/resources/app/启动QQ机器人.bat）——cd /d 钉死
// ─────────────────────────────────────────────────────────────────────────────
patch('app-bat', APP, '启动QQ机器人.bat',
`start "" "%~dp0node_modules\\electron\\dist\\electron.exe" "%~dp0."`,
`rem 2026-10-10: pin the working directory to this folder -- do not inherit the
rem caller's cwd. A launcher started from the host run dir made the app inherit
rem and hold that dir, which blocked the host self-update deploy (running dir
rem rename). [qqagent-cwd-patch:app-bat]
cd /d "%~dp0" || exit /b 1
start "" "%~dp0node_modules\\electron\\dist\\electron.exe" "%~dp0."`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：项目根启动器（启动QQAgent.bat）——start /D 钉死到 _unpack
// ─────────────────────────────────────────────────────────────────────────────
patch('launcher-bat', ROOT, '启动QQAgent.bat',
`node "%~dp0tools\\open-startup-session.mjs"
start "" "%~dp0_unpack\\QQ Agent.exe"`,
`node "%~dp0tools\\open-startup-session.mjs"
rem 2026-10-10: pin the app cwd to _unpack -- never inherit the caller's cwd.
rem See tools/patch-qqagent-cwd.mjs for the case (host deploy rename blocked).
rem [qqagent-cwd-patch:launcher-bat]
cd /d "%~dp0_unpack" || exit /b 1
start "" "%~dp0_unpack\\QQ Agent.exe"`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：项目根启动器（启动QQAgent.vbs）——WshShell.CurrentDirectory 钉死
// ─────────────────────────────────────────────────────────────────────────────
patch('launcher-vbs', ROOT, '启动QQAgent.vbs',
`sh.Run "node ""D:\\Mau\\WorkSpace\\QQBotB\\tools\\open-startup-session.mjs""", 0, True
sh.Run """D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\QQ Agent.exe""", 1, False`,
`sh.Run "node ""D:\\Mau\\WorkSpace\\QQBotB\\tools\\open-startup-session.mjs""", 0, True
' 2026-10-10: pin the app cwd to _unpack -- never inherit the caller's cwd.
' [qqagent-cwd-patch:launcher-vbs]
sh.CurrentDirectory = "D:\\Mau\\WorkSpace\\QQBotB\\_unpack"
sh.Run """D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\QQ Agent.exe""", 1, False`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
