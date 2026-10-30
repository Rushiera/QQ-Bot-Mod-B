// check-syntax.mjs — 批量 node --check（逐文件语法裁决，零写入）
//
// 用法：node tools/check-syntax.mjs [根目录=app/src/business]
// 判据：末行 `SYNTAX n/n OK` = 全绿；`SYNTAX k/n FAIL` = k 个文件语法错（逐条列出 stderr 首行）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(HERE, '..', 'app', 'src', 'business');

/** 递归收集 .js。 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const bad = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (error) {
    const msg = String(error.stderr || error.message || '').split(/\r?\n/).filter(Boolean)[0] || 'unknown';
    bad.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), error: msg });
  }
}

console.log(JSON.stringify({ root: ROOT, total: files.length, failed: bad.length, items: bad }, null, 2));
if (bad.length) {
  console.log(`SYNTAX ${bad.length}/${files.length} FAIL`);
  process.exit(1);
}
console.log(`SYNTAX ${files.length}/${files.length} OK`);
