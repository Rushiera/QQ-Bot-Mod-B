// verify-data-root.mjs — 数据根钉死验证（R2-L2 · D4「数据根钉 _unpack/data」）
//
// 用法：
//   node tools/verify-data-root.mjs                        # 单体 vs 业务面，跑偏即 exit 1
//   node tools/verify-data-root.mjs --business <config.js> # 指定业务面配置（验收 Step 1 产物）
//   node tools/verify-data-root.mjs --json                 # 机读输出
//
// 判据（FAIL 任一 → 退出码 1；WARN 只出声不挡）：
//   C1 单体入口在「模块求值之前」设置 process.env.QQ_AGENT_DATA_DIR
//      —— electron/main.js 里该赋值必须早于对 ../src/app.js 的**动态** import，
//         且不得存在对 app.js 的静态 import（静态 import 会先求值，env 来不及生效）。
//   C2 单体运行时数据根（事实）：打包态 = exe 所在目录/data；设了 QQ_AGENT_DATA_DIR 时以它为准。
//      该目录须真实存在且带业务数据（config.json + sessions/）。
//   C3 业务面 DATA_DIR 的**两种口径**分别求值：
//      a) 空 env（业务面独立运行）          → 与单体不同 = WARN「依赖 env 注入」
//      b) 注入 QQ_AGENT_DATA_DIR = 单体数据根 → 与单体不同 = FAIL「真跑偏」
//      口径 b 才是运行时实际读取的目录（单体 main.js 注入 env 后动态 import 业务面），
//      故只有 b 不一致才判失败；a 不一致说明钉死靠注入、不靠常量，出声让主干判级别。
//      表达式在 vm 沙箱内求值（给 path / process.env / 三个目录标识符 / profileSuffix 桩），
//      求值失败按 FAIL 报，不猜、不回落。
// 说明：本脚本**不 import 任何被测模块**——单体 config.js 顶层有 mkdirSync(DATA_DIR)，
//       import 会往 _unpack 里落目录（禁改面），故用「静态机制 + 磁盘事实 + 表达式求值」三路取证。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UNPACK = path.join(REPO, '_unpack');

const JSON_OUT = process.argv.includes('--json');
const checks = [];

function rec(name, state, detail) {
  checks.push({ name, state, detail });
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    rec(name, 'FAIL', '缺值');
    return dflt;
  }
  return v;
}

/** 路径归一：绝对化 + 去尾分隔符 + Windows 大小写不敏感比较。 */
function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** 取文件里第一条 `const DATA_DIR = <expr>;` 的右值表达式。 */
function readDataDirExpr(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const idx = lines.findIndex((l) => /(?:export\s+)?const\s+DATA_DIR\s*=/.test(l));
  if (idx < 0) return null;
  const expr = lines[idx]
    .replace(/^[\s\S]*?const\s+DATA_DIR\s*=\s*/, '')
    .replace(/;\s*$/, '')
    .trim();
  return { expr, line: idx + 1 };
}

/** 多实例后缀（与 profile.js 同语义：QQ_AGENT_PROFILE=2 → '-2'）。 */
function suffixOf(env) {
  const n = Number(env.QQ_AGENT_PROFILE || 0);
  return Number.isFinite(n) && n > 0 ? `-${n}` : '';
}

/** 以给定 env 求值 DATA_DIR 表达式（沙箱内，不触盘、不起模块）。 */
function evalDataDir(expr, moduleDir, env) {
  const APP_DIR = path.resolve(moduleDir, '..');
  const PROJECT_DIR = path.resolve(APP_DIR, '..');
  const sandbox = {
    path,
    process: { env },
    moduleDir,
    __dirname: moduleDir,
    APP_DIR,
    PROJECT_DIR,
    ROOT: APP_DIR,
    profileSuffix: () => suffixOf(env),
    dataDirName: () => `data${suffixOf(env)}`,
    portOffset: () => 0
  };
  return vm.runInNewContext(expr, sandbox, { timeout: 1000 });
}

// ── C1 单体入口：env 赋值必须早于动态 import，且无静态 import ──────────────
const mainJs = path.join(UNPACK, 'resources', 'app', 'electron', 'main.js');
if (!fs.existsSync(mainJs)) {
  rec('C1 单体入口', 'FAIL', `找不到 ${path.relative(REPO, mainJs)}`);
} else {
  const lines = fs.readFileSync(mainJs, 'utf8').split(/\r?\n/);
  const iEnv = lines.findIndex((l) => /process\.env\.QQ_AGENT_DATA_DIR\s*=/.test(l));
  const iDyn = lines.findIndex((l) => /await\s+import\(\s*['"]\.\.\/src\/app\.js/.test(l));
  const iStatic = lines.findIndex((l) => /from\s+['"]\.\.\/src\/app\.js['"]/.test(l));
  if (iEnv < 0) {
    rec('C1 单体入口', 'FAIL', 'main.js 未设置 process.env.QQ_AGENT_DATA_DIR');
  } else if (iStatic >= 0) {
    rec('C1 单体入口', 'FAIL', `main.js:${iStatic + 1} 静态 import ../src/app.js —— env 来不及生效`);
  } else if (iDyn >= 0 && iEnv > iDyn) {
    rec('C1 单体入口', 'FAIL', `env 赋值 :${iEnv + 1} 晚于动态 import :${iDyn + 1}`);
  } else {
    rec('C1 单体入口', 'OK', `main.js:${iEnv + 1} 赋值，早于 :${iDyn + 1} 动态 import（无静态 import）`);
  }
}

// ── C2 单体运行时数据根（事实） ───────────────────────────────────────────
const envRoot = process.env.QQ_AGENT_DATA_DIR;
const exePath = path.join(UNPACK, 'QQ Agent.exe');
let monoRoot = null;
if (envRoot) {
  monoRoot = path.resolve(envRoot);
  rec('C2 单体数据根', 'OK', `${monoRoot}（来源：环境变量 QQ_AGENT_DATA_DIR）`);
} else if (fs.existsSync(exePath)) {
  monoRoot = path.join(path.dirname(exePath), 'data');
  rec('C2 单体数据根', 'OK', `${monoRoot}（来源：打包态规则 = exe 所在目录/data，main.js:98 portable）`);
} else {
  rec('C2 单体数据根', 'FAIL', `既无 QQ_AGENT_DATA_DIR，也找不到打包 exe：${exePath}`);
}

if (monoRoot) {
  const cfg = path.join(monoRoot, 'config.json');
  const sess = path.join(monoRoot, 'sessions');
  if (fs.existsSync(cfg) && fs.existsSync(sess)) {
    rec('C2 数据面实况', 'OK', `config.json + sessions/ 均存在（${fs.readdirSync(sess).length} 个会话文件）`);
  } else {
    rec('C2 数据面实况', 'WARN', `config.json=${fs.existsSync(cfg)} sessions=${fs.existsSync(sess)}`);
  }
  const siblings = fs.existsSync(path.dirname(monoRoot))
    ? fs.readdirSync(path.dirname(monoRoot)).filter((d) => /^data-\d+$/.test(d))
    : [];
  if (siblings.length) rec('C2 兄弟实例', 'WARN', `另有 ${siblings.join(', ')}（PROFILE 多实例，本脚本只校验主实例）`);
}

// ── C3 业务面 DATA_DIR（两口径） ──────────────────────────────────────────
const CANDIDATES = [
  arg('--business', null),
  path.join(REPO, 'app', 'src', 'business', 'config.js'),
  path.join(REPO, 'app', 'src', 'config.js')
].filter(Boolean);

const businessFile = CANDIDATES.find((p) => fs.existsSync(p));
let bareRoot = null;
let injectedRoot = null;

if (!businessFile) {
  rec('C3 业务面', 'FAIL', `候选都不存在：${CANDIDATES.map((p) => path.relative(REPO, p)).join(' / ')}`);
} else {
  const got = readDataDirExpr(businessFile);
  const rel = path.relative(REPO, businessFile);
  if (!got) {
    rec('C3 业务面', 'FAIL', `${rel} 内找不到 const DATA_DIR = …`);
  } else {
    const moduleDir = path.dirname(businessFile);
    try {
      bareRoot = evalDataDir(got.expr, moduleDir, {});
      injectedRoot = monoRoot ? evalDataDir(got.expr, moduleDir, { QQ_AGENT_DATA_DIR: monoRoot }) : null;
      rec('C3 业务面', 'OK', `${rel}:${got.line} · ${got.expr}`);
      rec('C3a 空 env', 'OK', `→ ${bareRoot}`);
      rec('C3b 注入 env', 'OK', `→ ${injectedRoot ?? '(单体根未知，跳过)'}`);
    } catch (e) {
      rec('C3 业务面', 'FAIL', `表达式无法求值（${got.expr}）：${e.message}`);
    }
  }
}

// ── 比对（口径 b 定成败，口径 a 出声） ────────────────────────────────────
if (monoRoot && bareRoot && injectedRoot) {
  if (norm(injectedRoot) === norm(monoRoot)) {
    rec('比对 b', 'OK', `运行时口径一致：${monoRoot}`);
  } else {
    rec('比对 b', 'FAIL', `运行时跑偏 —— 单体 ${monoRoot} ≠ 业务面 ${injectedRoot}（D4 要求钉 ${monoRoot}）`);
  }
  if (norm(bareRoot) === norm(monoRoot)) {
    rec('比对 a', 'OK', '独立运行（无 env）也落在同一目录 —— 硬钉死');
  } else if (norm(injectedRoot) === norm(monoRoot)) {
    rec('比对 a', 'WARN', `独立运行落 ${bareRoot}，靠 main.js 注入 env 才对上（钉死靠注入、不靠常量）`);
  } else {
    rec('比对 a', 'WARN', `独立运行落 ${bareRoot}，注入 env 后仍是 ${injectedRoot}（不认 env，路径写死）`);
  }
}

const failed = checks.filter((c) => c.state === 'FAIL');
const warned = checks.filter((c) => c.state === 'WARN');

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, monoRoot, bareRoot, injectedRoot, checks }, null, 2));
} else {
  console.log('=== 数据根钉死验证（D4 · 目标 _unpack/data）===');
  for (const c of checks) console.log(`  ${c.state.padEnd(4)} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`结论  ${failed.length === 0 ? 'PASS' : 'FAIL'}（FAIL ${failed.length} / WARN ${warned.length}）`);
}

process.exit(failed.length === 0 ? 0 : 1);
