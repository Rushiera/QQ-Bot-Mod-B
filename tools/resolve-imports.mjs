// resolve-imports.mjs — 静态 import 闭合检查（ESM 静态解析不测 import 目标是否存在）
//
// 用法：node tools/resolve-imports.mjs [根目录=app/src/business]
// 做什么：扫每个 .js 的 `from './x.js'` / `from '../x.js'` / `import('./x.js')`，
//         逐个 resolve 到磁盘；不存在即列出（含 importer 行号）。
// 判据：末行 `MISSING 0/n` = 闭合；`MISSING k/n` = k 处缺口（n = 相对 import 总数）。
// 边界：只查相对路径；裸模块名（node: / ws / electron）不查——那是 node_modules 的事。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(HERE, '..', 'app', 'src', 'business');

/** 递归收集 .js 文件。 */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SPEC = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]*)['"]/g;
let total = 0;
const missing = [];

for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SPEC)) {
      total += 1;
      const target = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(target)) {
        missing.push({
          importer: path.relative(ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          spec: m[1]
        });
      }
    }
  });
}

const report = {
  ok: missing.length === 0,
  root: ROOT,
  files: walk(ROOT).length,
  relativeImports: total,
  missing: missing.length,
  items: missing
};
console.log(JSON.stringify(report, null, 2));
console.log(missing.length === 0 ? `MISSING 0/${total}` : `MISSING ${missing.length}/${total}`);
process.exit(missing.length === 0 ? 0 : 1);
