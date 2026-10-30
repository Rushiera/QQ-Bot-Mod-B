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
//      求值失败按 FAIL 报，不猜、不回落；例外一条：空 env 下**具名抛错拒绝启动**
//      （错误串含「未注入」/ QQ_AGENT_DATA_DIR）属更强的钉死形态，记 OK 并说明。
//      表达式按**括号配平**从 `const DATA_DIR =` 起取完整右值（支持 IIFE 多行块）——只取一行
//      会把 `(() => {` 当完整表达式（R2-L4 卡点 3）。
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

/**
 * 取文件里第一条 `const DATA_DIR = <expr>;` 的**完整**右值表达式（括号配平）。
 *
 * 为什么不能只取一行：归位后业务面的 DATA_DIR 是 IIFE 多行块
 * （`app/src/business/config.js:30-35` 的 `(() => { … })()`），只取一行拿到 `(() => {`，
 * 求值必然 `Unexpected end of input`（R2-L4 卡点 3）。
 *
 * 做法：从 `const DATA_DIR =` 之后逐字符累积，直到**括号配平后遇到顶层分号**为止。
 * 纯读取——不求值整文件、不改文件、不 import 被测模块。
 *
 * @param {string} file 配置文件（绝对路径）
 * @returns {{expr:string, line:number}|{error:string}|null} null = 文件里没有该声明
 */
function readDataDirExpr(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /(?:export\s+)?const\s+DATA_DIR\s*=\s*/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const line = text.slice(0, m.index).split(/\r?\n/).length;   // 声明所在行（1 起）
  const expr = scanBalancedExpr(text, start);
  if (expr === null) return { error: `第 ${line} 行起的表达式括号未配平（(){}[] 四种都计）` };
  return { expr, line };
}

/** 括号配平的表达式扫描：返回完整右值；未配平返回 null。 */
function scanBalancedExpr(text, start) {
  const stack = [];
  let prev = '';                                             // 上一个有效字符——区分正则字面量与除号
  let i = start;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {                         // 行注释
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {                         // 块注释
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {               // 字符串 / 模板字面量（整段跳过）
      i = skipLiteral(text, i);
      prev = 'x';
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]$/.test(prev)) { // 正则字面量（运算符位才是正则）
      i = skipRegexLiteral(text, i);
      prev = 'x';
      continue;
    }
    if (!/\s/.test(c)) {
      if (c === '(' || c === '[' || c === '{') {
        stack.push(c);
      } else if (c === ')' || c === ']' || c === '}') {
        const open = stack.pop();
        const paired = (open === '(' && c === ')') || (open === '[' && c === ']') || (open === '{' && c === '}');
        if (!paired) return null;                            // 错配：具名失败，不猜
      } else if (c === ';' && stack.length === 0) {
        return text.slice(start, i).trim();                  // 顶层分号 = 表达式结束
      }
      prev = c;
    }
    i += 1;
  }
  return stack.length === 0 ? text.slice(start).trim() : null;
}

/** 跳过一个字符串 / 模板字面量（模板里的 `${…}` 内部自成配平，整段跳过）。 */
function skipLiteral(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === quote) return j + 1;
    if (quote === '`' && ch === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < text.length && depth > 0) {
        const inner = text[j];
        if (inner === '\\') { j += 2; continue; }
        if (inner === '"' || inner === "'" || inner === '`') { j = skipLiteral(text, j); continue; }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        j += 1;
      }
      continue;
    }
    j += 1;
  }
  return text.length;
}

/** 跳过一个正则字面量（含 flags）；遇换行即判「不是正则」并中止。 */
function skipRegexLiteral(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return j;
    if (c === '[') { inClass = true; j += 1; continue; }
    if (c === ']') { inClass = false; j += 1; continue; }
    if (c === '/' && !inClass) {
      j += 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return j;
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
  } else if (got.error) {
    rec('C3 业务面', 'FAIL', `${rel}：${got.error}`);
  } else {
    const moduleDir = path.dirname(businessFile);
    const oneLine = got.expr.replace(/\s+/g, ' ');
    rec('C3 业务面', 'OK', `${rel}:${got.line} · ${oneLine.length > 160 ? oneLine.slice(0, 160) + '…' : oneLine}`);
    // 口径 a · 空 env：业务面可以是「抛错拒绝启动」（比 WARN 更强的钉死形式：不回落源码目录）。
    // 抛错必须具名——认不出是"未注入"就按 FAIL 报，不把任何异常当预期。
    try {
      bareRoot = evalDataDir(got.expr, moduleDir, {});
      rec('C3a 空 env', 'OK', `→ ${bareRoot}`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/未注入|QQ_AGENT_DATA_DIR/.test(msg)) {
        rec('C3a 空 env', 'OK', `空 env 即抛错拒绝启动（硬钉死、不回落源码目录）：${msg}`);
      } else {
        rec('C3a 空 env', 'FAIL', `空 env 求值抛出非预期错误：${msg}`);
      }
    }
    // 口径 b · 注入 env：这才是运行时实际读取的目录，失败即 FAIL（不猜、不回落）。
    if (!monoRoot) {
      rec('C3b 注入 env', 'WARN', '(单体根未知，跳过)');
    } else {
      try {
        injectedRoot = evalDataDir(got.expr, moduleDir, { QQ_AGENT_DATA_DIR: monoRoot });
        rec('C3b 注入 env', 'OK', `→ ${injectedRoot}`);
      } catch (e) {
        rec('C3b 注入 env', 'FAIL', `注入 env 后仍求值失败：${String(e?.message ?? e)}`);
      }
    }
  }
}

// ── 比对（口径 b 定成败，口径 a 出声） ────────────────────────────────────
// 判据面不能因为口径 a 「抛错拒绝启动」就静默跳过——跳过 = 把未比对伪装成已比对。
if (monoRoot && injectedRoot) {
  if (norm(injectedRoot) === norm(monoRoot)) {
    rec('比对 b', 'OK', `运行时口径一致：${monoRoot}`);
  } else {
    rec('比对 b', 'FAIL', `运行时跑偏 —— 单体 ${monoRoot} ≠ 业务面 ${injectedRoot}（D4 要求钉 ${monoRoot}）`);
  }
  if (!bareRoot) {
    rec('比对 a', 'OK', '空 env 拒绝启动 —— 比常量钉死更硬（不产生任何回落路径）');
  } else if (norm(bareRoot) === norm(monoRoot)) {
    rec('比对 a', 'OK', '独立运行（无 env）也落在同一目录 —— 硬钉死');
  } else if (norm(injectedRoot) === norm(monoRoot)) {
    rec('比对 a', 'WARN', `独立运行落 ${bareRoot}，靠 main.js 注入 env 才对上（钉死靠注入、不靠常量）`);
  } else {
    rec('比对 a', 'WARN', `独立运行落 ${bareRoot}，注入 env 后仍是 ${injectedRoot}（不认 env，路径写死）`);
  }
} else if (!monoRoot) {
  rec('比对 b', 'WARN', '单体根未知 —— 运行时口径无法比对（不猜）');
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
