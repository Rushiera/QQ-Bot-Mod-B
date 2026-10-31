// verify-import-integrity.mjs — 跨模块 import 符号完整性扫描
//
// 用法：node tools/verify-import-integrity.mjs
//        node tools/verify-import-integrity.mjs --src <dir>    # 负向自测：扫夹具目录（缺省扫 app/src）
// 做什么：静态扫描 `app/src/**` 的全部 `import { … } from './x.js'`，逐个核对被导入的符号
//         是否真的由目标模块导出。
// 扫描面（多根，R6-L5 扩围）：6 个模块目录 `business/`（业务面内核）· `web/`（单体 HTTP 面）·
//         `navigator/` · `napcat/` · `incident/` · `onebot/` + 5 个根级模块
//         `app.js`（装配入口）· `business.js` · `companion.js` · `config.js` · `log.js`。
//         为什么扩到全量：原扫描根只有 `business/`，L9 新增的 `web/business-proxy.js` 与改过的
//         `app.js` 的 import 面无人守——而「加载期即解析」的静态导入链穿过 app.js 的全部 import，
//         装配层新增一次 `import {x} from './navigator/y.js'` 就足以让启动闪退。根集合按目录枚举，
//         新增根往 SRC_ROOTS 追加一行即可；漏登记由 `missingRoots` 字段点名（不静默缩面）。
// 为什么：ESM 静态导入缺失的命名导出 → 加载期抛「does not provide an export named」→
//         应用启动即闪退（logger 都来不及写，日志里什么都看不到）。
//         `node --check` 只查语法，查不出这一类；「模块自身能加载」也不等于「消费方能加载」。
// 判例：2026-10-11 v0.56 —— 删了 web-search.js 的 customSearch 而 routes.js 仍 import 它，
//       业务面启动即闪退（无日志），表现为「软件打不开 / 启动失败」。
//
// 输出：filesScanned / symbolsChecked / problems[]；problems 为空 = PASS（退出码 0）
// 退出码：0 = 全部符号齐备；1 = 存在缺失（problems 逐条列出 file / from / missing）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 取命令行参数值（`--name value` 与 `--name=value` 两种形态都认）。
 *
 * @param {string} name 参数名（含前导 --）
 * @returns {string} 值；未给出返回空串
 */
function argValue(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
}
// 被扫根（默认 `app/src`）。可用 `--src <dir>` / `VERIFY_IMPORT_SRC` 覆盖——**唯一用途是负向自测**：
// 把夹具目录（内含一个刻意坏掉的导入）指进来，验证本脚本真能检出缺失而非「恒绿」。
// 生产守门不带该参数，扫的永远是 app/src；覆盖时整根递归（夹具不按生产根的模块名摆放）。
const OVERRIDE = argValue('--src') || String(process.env.VERIFY_IMPORT_SRC || '').trim();
const APP_SRC = OVERRIDE ? path.resolve(OVERRIDE) : path.resolve(HERE, '..', 'app', 'src');
// 扫描根（多根，R6-L5）：6 个模块目录 + 5 个根级模块（单文件根）。扩围清单见文件头。
const SRC_ROOTS = OVERRIDE
  ? [APP_SRC]
  : [
    path.join(APP_SRC, 'business'),
    path.join(APP_SRC, 'web'),
    path.join(APP_SRC, 'navigator'),
    path.join(APP_SRC, 'napcat'),
    path.join(APP_SRC, 'incident'),
    path.join(APP_SRC, 'onebot'),
    // 单文件根：装配入口与根级模块（同目录还有 css / 字体等非 js，故按文件登记而非根目录）
    path.join(APP_SRC, 'app.js'),
    path.join(APP_SRC, 'business.js'),
    path.join(APP_SRC, 'companion.js'),
    path.join(APP_SRC, 'config.js'),
    path.join(APP_SRC, 'log.js')
  ];

/**
 * 递归收集 .js 文件（根可以是目录，也可以是单个文件——`app.js` 装配入口按文件登记）。
 *
 * @param {string} target 目录或文件绝对路径
 * @param {string[]} [out] 累积结果
 * @returns {string[]} 文件绝对路径列表
 */
function collect(target, out = []) {
  let st;
  try { st = fs.statSync(target); } catch { return out; }
  if (st.isFile()) {
    if (target.endsWith('.js')) out.push(target);
    return out;
  }
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 提取一个模块对外提供的符号名（静态文本匹配，够用即可）。 */
function exportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/);
      const n = (t[1] || t[0] || '').trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+default/.test(text)) names.add('default');
  if (/export\s+\*/.test(text)) names.add('*');
  return names;
}

/** 去掉 import 花括号内的注释行——注释里的文字会被误当符号名。 */
function stripComments(spec) {
  return spec
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const present = SRC_ROOTS.filter((p) => fs.existsSync(p));
const absent = SRC_ROOTS.filter((p) => !fs.existsSync(p));
if (!present.length) {
  console.log(JSON.stringify({ ok: false, error: `源码目录不存在：${SRC_ROOTS.join(' · ')}` }, null, 2));
  process.exit(1);
}

/** 文件相对哪个扫描根（报错面按根相对，读者才看得懂位置）。 */
function relOf(file) {
  for (const root of present) {
    if (file === root) return path.relative(APP_SRC, file);
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..')) return path.join(path.basename(root), rel);
  }
  return path.relative(APP_SRC, file);
}

const files = present.flatMap((root) => collect(root)).sort();
const problems = [];
let checked = 0;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    // 跳过注释行里的「import {…} from …」文本——补丁标记注释会写成这个形状
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (lineText.trim().startsWith('//')) continue;
    const specs = stripComments(m[1])
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const target = path.resolve(path.dirname(file), m[2]);
    let targetText = '';
    try { targetText = fs.readFileSync(target, 'utf8'); } catch {
      problems.push({ file: relOf(file), from: m[2], missing: ['<模块不存在>'] });
      continue;
    }
    const have = exportedNames(targetText);
    const missing = specs.filter((s) => !have.has(s) && !have.has('*'));
    checked += specs.length;
    if (missing.length) problems.push({ file: relOf(file), from: m[2], missing });
  }
}

const ok = problems.length === 0;
console.log(JSON.stringify({
  ok,
  filesScanned: files.length,
  symbolsChecked: checked,
  roots: present.map((p) => path.relative(APP_SRC, p) || '.'),
  missingRoots: absent.map((p) => path.relative(APP_SRC, p)),
  problems,
  verdict: ok ? 'ALL PASS —— 跨模块导入符号齐备' : `FAIL —— ${problems.length} 处符号缺失（应用会启动即崩）`
}, null, 2));
process.exit(ok ? 0 : 1);
