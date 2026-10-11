// verify-import-integrity.mjs — 跨模块 import 符号完整性扫描
//
// 用法：node tools/verify-import-integrity.mjs
// 做什么：静态扫描 `_unpack/resources/app/src/**/*.js` 的全部 `import { … } from './x.js'`，
//         逐个核对被导入的符号是否真的由目标模块导出。
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
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
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

if (!fs.existsSync(SRC)) {
  console.log(JSON.stringify({ ok: false, error: `源码目录不存在：${SRC}` }, null, 2));
  process.exit(1);
}

const files = walk(SRC);
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
      problems.push({ file: path.relative(SRC, file), from: m[2], missing: ['<模块不存在>'] });
      continue;
    }
    const have = exportedNames(targetText);
    const missing = specs.filter((s) => !have.has(s) && !have.has('*'));
    checked += specs.length;
    if (missing.length) problems.push({ file: path.relative(SRC, file), from: m[2], missing });
  }
}

const ok = problems.length === 0;
console.log(JSON.stringify({
  ok,
  filesScanned: files.length,
  symbolsChecked: checked,
  problems,
  verdict: ok ? 'ALL PASS —— 跨模块导入符号齐备' : `FAIL —— ${problems.length} 处符号缺失（应用会启动即崩）`
}, null, 2));
process.exit(ok ? 0 : 1);
