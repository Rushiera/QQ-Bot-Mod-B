// verify-qqagent-cwd.mjs — 「工作目录钉死」自测
//
// 用法：node verify-qqagent-cwd.mjs
// 判据（Rushiera 2026-10-10 判例）：
//   1 应用层落盘：electron/main.js 首段含 process.chdir，且位于 Electron 拉起
//     子进程之前（子进程 gpu / network / renderer 继承主进程 cwd）
//   2 应用层行为（真跑抽段）：打包态 → cwd 钉到 exe 所在目录；开发态 → 应用根
//   3 启动器层落盘：三处启动器各带 cwd 钉死指令（cd /d ／ start /D ／ CurrentDirectory）
//   4 启动器层行为（真跑对照）：start /D <dir> → 子进程 cwd = <dir>；
//     不带 /D → 子进程继承启动者 cwd（对照组，防"测试恒真"）
//   5 编码保真：三处 .bat / .vbs 仍是纯 ASCII，且换行风格未混用
//
// 隔离：只读应用源码；在应用 electron/ 目录写一个临时探针（跑完即删）；
//       不启动应用、不碰运行中的实例、不触碰宿主运行区。
// 说明：判据 2 抽的是 main.js 里的**真实代码文本**（>>> / <<< 标记之间），
//       不是复制的副本——改坏了这里就会红。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, '_unpack', 'resources', 'app');
const UNPACK = path.join(ROOT, '_unpack');
const MAIN = path.join(APP, 'electron', 'main.js');
const START = '// >>> qqagent-cwd-patch:main-chdir';
const END = '// <<< qqagent-cwd-patch:main-chdir';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

const read = (file) => fs.readFileSync(file, 'utf8');
const mainText = read(MAIN);

/** 同步睡（不引异步——本脚本其余部分是同步流程）。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 抽取 main.js 里被 >>> / <<< 包裹的钉死代码段（真实文本）。 */
function extractBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  return text.slice(text.indexOf('\n', a) + 1, text.lastIndexOf('\n', b));
}

// ── 1. 应用层落盘 + 位置（须在 Electron 拉起子进程之前）──────────────────────
const block = extractBlock(mainText);
{
  check('main.js 含钉死标记', mainText.includes('[qqagent-cwd-patch:main-chdir]'));
  check('main.js 抽段可提取（>>> / <<< 成对）', block !== null);
  check('抽段含 process.chdir + app.isPackaged + process.execPath',
    !!block && block.includes('process.chdir(') && block.includes('app.isPackaged') && block.includes('process.execPath'));

  const at = mainText.indexOf(START);
  const firstSpawn = mainText.indexOf('spawn(');
  check('钉死段位于 app.whenReady 之前', at >= 0 && at < mainText.indexOf('app.whenReady('));
  check('钉死段位于单实例锁之前', at >= 0 && at < mainText.indexOf('requestSingleInstanceLock('));
  check('钉死段位于首个 spawn( 之前', at >= 0 && (firstSpawn < 0 || at < firstSpawn),
    '首个 spawn( @ ' + firstSpawn);
}

// ── 2. 应用层行为（真跑抽段）─────────────────────────────────────────────────
const HOSTILE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-cwd-hostile-'));
const PROBE = path.join(APP, 'electron', '.cwd-probe.mjs');
function runBlockProbe(packaged) {
  const src = [
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const app = { isPackaged: ' + (packaged ? 'true' : 'false') + ' };',
    block,
    'process.stdout.write(process.cwd());'
  ].join('\n');
  fs.writeFileSync(PROBE, src, 'utf8');
  const r = spawnSync(process.execPath, [PROBE], { cwd: HOSTILE, encoding: 'utf8' });
  return { cwd: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}
try {
  const packed = runBlockProbe(true);
  check('打包态：cwd 钉到 exe 所在目录', packed.cwd === path.dirname(process.execPath),
    packed.cwd + (packed.stderr ? ' / ' + packed.stderr : ''));
  const dev = runBlockProbe(false);
  check('开发态：cwd 钉到应用根', dev.cwd === APP, dev.cwd + (dev.stderr ? ' / ' + dev.stderr : ''));
  check('两种分支都不再是启动者的敌意 cwd', packed.cwd !== HOSTILE && dev.cwd !== HOSTILE);
} finally {
  fs.rmSync(PROBE, { force: true });
}

// ── 3. 启动器层落盘 ─────────────────────────────────────────────────────────
const LAUNCH_BAT = path.join(ROOT, '启动QQAgent.bat');
const LAUNCH_VBS = path.join(ROOT, '启动QQAgent.vbs');
const APP_BAT = path.join(APP, '启动QQ机器人.bat');
{
  const bat = read(LAUNCH_BAT);
  check('启动QQAgent.bat：cd /d 钉到 _unpack', bat.includes('cd /d "%~dp0_unpack"') && bat.includes('[qqagent-cwd-patch:launcher-bat]'));
  check('启动QQAgent.bat：start 行仍在', bat.includes('start "" "%~dp0_unpack\\QQ Agent.exe"'));
  const vbs = read(LAUNCH_VBS);
  check('启动QQAgent.vbs：CurrentDirectory 钉到 _unpack',
    vbs.includes('sh.CurrentDirectory = "D:\\Mau\\WorkSpace\\QQBotB\\_unpack"') && vbs.includes('[qqagent-cwd-patch:launcher-vbs]'));
  const ab = read(APP_BAT);
  check('启动QQ机器人.bat：cd /d 钉到应用目录', ab.includes('cd /d "%~dp0"') && ab.includes('[qqagent-cwd-patch:app-bat]'));
}

// ── 4. 启动器层行为（真跑对照：start /D）────────────────────────────────────
{
  const PROBE2 = path.join(HOSTILE, 'probe.mjs');
  const OUT_A = path.join(HOSTILE, 'cwd-without-d.txt');
  const OUT_B = path.join(HOSTILE, 'cwd-with-d.txt');
  fs.writeFileSync(PROBE2,
    "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], process.cwd(), 'utf8');\n", 'utf8');

  const run = (extra, out) => {
    spawnSync('cmd', ['/c', 'start', '', '/B', ...extra, process.execPath, PROBE2, out], { cwd: HOSTILE, windowsHide: true });
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(out)) return fs.readFileSync(out, 'utf8').trim();
      sleep(50);
    }
    return '';
  };

  const inherited = run([], OUT_A);
  check('对照组：不带 /D 时子进程继承启动者 cwd（测试非恒真）', inherited === HOSTILE, inherited || '(无输出)');

  const pinned = run(['/D', UNPACK], OUT_B);
  check('治疗组：start /D <dir> 时子进程 cwd = <dir>', pinned === UNPACK, pinned || '(无输出)');
}

// ── 5. 编码保真（.bat / .vbs：ASCII + 换行风格不混用）───────────────────────
for (const [label, file] of [['启动QQAgent.bat', LAUNCH_BAT], ['启动QQAgent.vbs', LAUNCH_VBS], ['启动QQ机器人.bat', APP_BAT]]) {
  const text = read(file);
  const bad = [...text].findIndex((ch) => ch.charCodeAt(0) > 127);
  const lf = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  const pureLf = !text.includes('\r');
  const pureCrlf = lf === crlf;
  check(label + '：纯 ASCII', bad < 0, bad < 0 ? '' : '非 ASCII @ ' + bad);
  check(label + '：换行风格未混用', pureLf || pureCrlf, pureLf ? 'LF' : (pureCrlf ? 'CRLF' : 'MIXED'));
}

fs.rmSync(HOSTILE, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
