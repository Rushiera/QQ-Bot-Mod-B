// verify-env.mjs — verify-* 的统一路径解析（R2 Step 3 · 单体版验收基座）
//
// 用法：
//   node tools/verify-env.mjs              # 打印解析结果 + 存在性自检（缺项 exit 1）
//   node tools/verify-env.mjs --json       # 机读
//
// 为什么需要它：R2 Step 1 把业务面源码从 `_unpack/resources/app/src/` 搬到
//   `app/src/business/`（见 reports/R2-L1.md §2.1），28 个 verify 脚本里各自硬写了
//   `path.resolve(HERE, '..', '_unpack', 'resources', 'app')`。改造要一处改、全体跟随；
//   每脚本各改一遍 = 下次搬家再改 28 遍（违反「勿增实体」的反面：重复实体）。
//
// 口径：
//   APP_ROOT  默认 `app/`（单体宿主根；env `QB_VERIFY_APP` 可覆盖，用于对照旧业务面）
//   SRC       默认 `app/src/business/`（业务面源码新家）
//   UI        默认 `app/src/business/ui/`（三个 UI 页从 `ui/app/` 搬来，R2-L1 §2.2）
//   DATA_PROD 默认 `_unpack/data/`（D4 数据根，只读；自测一律另启临时目录）
//
// 判据：缺目录即抛错并 exit 1 —— 静默回落会让「路径失配」伪装成「用例全过」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（tools/ 的上一级）。 */
export const REPO = path.resolve(HERE, '..');

/** 单体宿主根（默认 `app/`）。 */
export const APP_ROOT = process.env.QB_VERIFY_APP
  ? path.resolve(process.env.QB_VERIFY_APP)
  : path.join(REPO, 'app');

/** 业务面源码根（默认 `app/src/business/`）。 */
export const SRC = process.env.QB_VERIFY_SRC
  ? path.resolve(process.env.QB_VERIFY_SRC)
  : path.join(APP_ROOT, 'src', 'business');

/** 业务面 UI 根（默认 `app/src/business/ui/`）。 */
export const UI = path.join(SRC, 'ui');

/** 生产数据根（只读，D4 钉死 `_unpack/data`）。 */
export const DATA_PROD = path.join(REPO, '_unpack', 'data');

/** 临时自测数据根（每脚本各自一个子目录，避免互相踩）。 */
export function tempData(name) {
  return path.join(REPO, 'runtime', `.${name}-selftest`);
}

/**
 * 断言目录存在，缺失即抛（不静默回落）。
 *
 * @param {string} dir 目录绝对路径
 * @param {string} label 报错前缀（用例名）
 * @returns {string} 原样返回 dir
 */
export function needDir(dir, label) {
  if (!fs.existsSync(dir)) {
    throw new Error(`${label}: 目录不存在 → ${dir}（改造后路径失配，勿静默跳过）`);
  }
  return dir;
}

/**
 * 解析某业务面源文件的绝对路径（缺文件即抛）。
 *
 * @param {string} rel 相对 `app/src/business/` 的路径，如 `sender.js`
 * @returns {string} 绝对路径
 */
export function srcFile(rel) {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) throw new Error(`业务面源文件缺失 → ${p}`);
  return p;
}

/** 解析某 UI 源文件的绝对路径（缺文件即抛）。 */
export function uiFile(rel) {
  const p = path.join(UI, rel);
  if (!fs.existsSync(p)) throw new Error(`业务面 UI 文件缺失 → ${p}`);
  return p;
}

const ROWS = [
  ['REPO', REPO],
  ['APP_ROOT', APP_ROOT],
  ['SRC', SRC],
  ['UI', UI],
  ['DATA_PROD', DATA_PROD]
];

const missing = ROWS.filter(([, p]) => !fs.existsSync(p)).map(([k]) => k);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows: Object.fromEntries(ROWS), missing }, null, 2));
  } else {
    for (const [k, p] of ROWS) console.log(`${k.padEnd(10)} ${fs.existsSync(p) ? 'OK ' : 'MISS'} ${p}`);
    console.log(`\n${ROWS.length - missing.length}/${ROWS.length} 目录在位${missing.length ? ` · 缺：${missing.join(', ')}` : ''}`);
  }
  if (missing.length) process.exitCode = 1;
}
