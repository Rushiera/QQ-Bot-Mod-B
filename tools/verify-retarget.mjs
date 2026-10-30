// verify-retarget.mjs — 把 28(+1) 个 verify 脚本的路径基准从「旧业务面」改指「R2 归位后的业务面」
//
// 用法：
//   node tools/verify-retarget.mjs            # dry-run：只打印将改的行（零写入）
//   node tools/verify-retarget.mjs --apply    # 落盘
//   node tools/verify-retarget.mjs --check    # 对全部 verify-*.mjs 跑 node --check（0 error 判据）
//   node tools/verify-retarget.mjs --json     # 机读
//
// 背景：R2 Step 1 把业务面源码 `_unpack/resources/app/src/` → `app/src/business/`，
//   UI 三件 `ui/app/*.js` → `app/src/business/ui/`（reports/R2-L1.md §2.1 / §2.2）。
//   旧脚本里同一段路径写了 29 遍；本脚本按**规则**改，不按文件逐个手改（改规则 = 改一处）。
//
// 规则（顺序敏感，逐条只作用于未被前面规则改过的行）：
//   R1 `_unpack/resources/app` → `app`（宿主根），并就地补一行 `const BIZ = path.join(APP,'src','business')`
//   R2 `path.join(APP, 'src', X)` → `path.join(BIZ, X)`
//   R3 `path.join(APP, 'src/X')`  → `path.join(BIZ, 'X')`
//   R4 `path.join(APP, 'ui', 'app', X)` → `path.join(BIZ, 'ui', X)`
//   R5 `path.join(APP, rel)` → `path.join(BIZ, …)`（rel 形如 'src/x.js'——去掉 src/ 前缀）
//   R6 `const SRC = path.resolve(HERE,'..','_unpack','resources','app','src')` → `…,'app','src','business'`
//   R7 `const SRC = path.join(APP, 'src')` → `path.join(APP, 'src', 'business')`
//   R8 `const APP_SRC = path.join(ROOT,'_unpack','resources','app','src')` → `…,'app','src','business'`
//   R9 `const APP = path.join(ROOT,'_unpack','resources','app')` → 宿主根 + 补 BIZ
//
// 不动的面：`_unpack/data`（D4 数据根，生产只读源）· `app/src/navigator`（单体领航员，未搬）
//   · `tools/apply-*.mjs`（生成源，属补丁脚本面）。`verify-qqagent-cwd.mjs` 判退役，不参与改。
//
// 幂等：已改过的文件跑第二遍输出「已就绪 0 变更」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = HERE;
const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

/** 判退役 / 保留的脚本：不参与路径重定向。 */
const SKIP = new Set(['verify-qqagent-cwd.mjs', 'verify-retarget.mjs', 'verify-env.mjs']);

/** 视为「旧业务面基准」的片段（仅命中这些片段才改）。 */
const OLD_APP = ['_unpack', 'resources', 'app'];

/**
 * 单文件变换。
 *
 * @param {string} text 原文
 * @param {string} file 文件名（仅用于输出）
 * @returns {{text: string, hits: string[]}} 新文本与命中记录
 */
function retarget(text, file) {
  const hits = [];
  let out = text;

  // R11：修正首轮误伤（BIZ 插入行本身被 R2 命中）——幂等修复，先跑
  out = out.replace(/const BIZ = path\.join\(BIZ, 'business'\);/g, () => { hits.push('R11'); return "const BIZ = path.resolve(APP, 'src/business');"; });
  out = out.replace(/const SRC = path\.join\(BIZ, 'business'\);/g, () => { hits.push('R11b'); return "const SRC = path.resolve(APP, 'src/business');"; });
  out = out.replace(/const APP_SRC = path\.join\(BIZ, 'business'\);/g, () => { hits.push('R11c'); return "const APP_SRC = path.resolve(APP, 'src/business');"; });

  // R10：绝对路径字面量（历史遗留写死机路径）→ 相对解析
  out = out.replace(
    /^(\s*)const APP = '([A-Za-z]:\\\\[^']*?)_unpack\\\\resources\\\\app';$/m,
    (m, indent) => {
      hits.push('R10 APP');
      return `${indent}const APP = path.resolve(HERE, '..', 'app');\n${indent}const BIZ = path.resolve(APP, 'src', 'business');   // 业务面（R2 归位）`;
    }
  );

  // R1 / R9：APP 常量 → 宿主根 + BIZ
  out = out.replace(
    /^(\s*)const APP = path\.(resolve|join)\(([^;]*?)(?:, )?'_unpack', 'resources', 'app'\);$/m,
    (m, indent, kind, head) => {
      hits.push('R1 APP');
      return `${indent}const APP = path.${kind}(${head ? head + ', ' : ''}'app');\n${indent}const BIZ = path.resolve(APP, 'src', 'business');   // 业务面（R2 归位）`;
    }
  );

  const before = out;
  out = out.replace(/path\.join\(APP, 'src', /g, () => { hits.push('R2'); return "path.join(BIZ, "; });
  out = out.replace(/path\.join\(APP, 'src\//g, () => { hits.push('R3'); return "path.join(BIZ, '"; });
  out = out.replace(/path\.join\(APP, 'ui', 'app', /g, () => { hits.push('R4'); return "path.join(BIZ, 'ui', "; });
  out = out.replace(/path\.join\(APP, rel\)/g, () => { hits.push('R5'); return "path.join(BIZ, String(rel).replace(/^src\\//, ''))"; });
  out = out.replace(/const SRC = path\.join\(APP, 'src'\);/g, () => { hits.push('R7'); return "const SRC = path.resolve(APP, 'src', 'business');"; });
  if (out !== before && hits.length === 0) hits.push('?');
  void OLD_APP;

  // R6 / R8：直接 resolve 到旧 src / 旧 ui 的常量
  out = out.replace(
    /path\.(resolve|join)\(HERE, '\.\.', '_unpack', 'resources', 'app', 'src'\)/g,
    (m, kind) => { hits.push('R6'); return `path.${kind}(HERE, '..', 'app', 'src', 'business')`; }
  );
  out = out.replace(
    /path\.(resolve|join)\(ROOT, '_unpack', 'resources', 'app', 'src'\)/g,
    (m, kind) => { hits.push('R8'); return `path.${kind}(ROOT, 'app', 'src', 'business')`; }
  );

  return { text: out, hits: hits.filter((x) => x !== '?').map((x) => `${x}:${file}`) };
}

const ALL = fs.readdirSync(TOOLS).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();
const files = ALL.filter((f) => !SKIP.has(f));
const report = [];

// --check：逐个 node --check（判据「0 error」的机读入口——省得在 shell 里拼 ForEach）
if (process.argv.includes('--check')) {
  const { spawnSync } = await import('node:child_process');
  const bad = [];
  for (const name of ALL) {
    const r = spawnSync(process.execPath, ['--check', path.join(TOOLS, name)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push({ file: name, err: String(r.stderr || '').trim().split('\n').slice(0, 3).join(' ') });
  }
  const okCount = ALL.length - bad.length;
  if (JSON_OUT) console.log(JSON.stringify({ checked: ALL.length, ok: okCount, bad }, null, 2));
  else {
    console.log(`node --check · ${okCount}/${ALL.length} exit 0${bad.length ? ' · 失败：' : ''}`);
    for (const b of bad) console.log(`  FAIL ${b.file} :: ${b.err}`);
  }
  process.exitCode = bad.length ? 1 : 0;
} else {
  for (const name of files) {
    const p = path.join(TOOLS, name);
    const src = fs.readFileSync(p, 'utf8');
    const { text, hits } = retarget(src, name);
    const changed = text !== src;
    report.push({ file: name, changed, hits: hits.length });
    if (changed && APPLY) fs.writeFileSync(p, text, 'utf8');
  }

  const changedFiles = report.filter((r) => r.changed);
  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', scanned: report.length, changed: changedFiles }, null, 2));
  } else {
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} · 扫描 ${report.length} 个 · 需改 ${changedFiles.length} 个`);
    for (const r of changedFiles) console.log(`  ${APPLY ? '改了' : '待改'} ${r.file}（${r.hits} 处）`);
    const clean = report.filter((r) => !r.changed).map((r) => r.file);
    if (clean.length) console.log(`  已就绪：${clean.join(', ')}`);
  }
}
