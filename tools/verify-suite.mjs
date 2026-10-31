// verify-suite.mjs — verify 脚本的批量跑测入口（R2 Step 3 · 单体版验收；全量清单由 tools/verify-*.mjs 目录自证，不写死计数）
//
// 用法：
//   node tools/verify-suite.mjs                # 跑「守门」档（默认——不触网、不生成、不弹窗）
//   node tools/verify-suite.mjs --live         # 加跑 live 档（真外网 / 真生成 / 真模型，花钱花时间）
//   node tools/verify-suite.mjs --only a,b     # 只跑指定（文件名前缀即可，逗号分隔）
//   node tools/verify-suite.mjs --json         # 机读
//   node tools/verify-suite.mjs --timeout 180  # 单脚本超时秒（默认 120）
//
// 判据：全部 exit 0 → 打印 `PASS n/n` 且退出码 0；任一失败 → 打印失败清单 + 退出码 1。
//   超时按 FAIL 计（=TIMEOUT），不静默跳过——跳过会伪装成通过。
//
// 档位说明（为什么分两档）：
//   guard = 源码断言 / 纯函数真跑 / 本地回环——可反复跑，CI 级
//   live  = 真外网（cattools-live）· 真云额度（comfy）· 真本地生成（media）
//           默认不跑：跑一次就产生费用或几十秒等待，属于「按需验收」不属「守门」

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const LIVE = ARGS.includes('--live');
const ONLY = (() => {
  const i = ARGS.indexOf('--only');
  return i < 0 ? [] : String(ARGS[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
})();
const TIMEOUT_S = (() => {
  const i = ARGS.indexOf('--timeout');
  const v = i < 0 ? NaN : Number(ARGS[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : 120;
})();

/** live 档脚本（默认不跑）。 */
const LIVE_SET = new Set([
  'verify-qqagent-cattools-live.mjs',
  'verify-comfy.mjs',
  'verify-media.mjs'
]);

/** 不做批量跑测的脚本（自举 / 基座 / 判退役）。 */
const SKIP = new Set([
  'verify-suite.mjs',
  'verify-retarget.mjs',
  'verify-env.mjs',
  'verify-data-root.mjs',      // 自带 --business 参数语义，单独跑（JSON 契约不同）
  'verify-qqagent-cwd.mjs'     // 已判退役（D1：cwd 2 点失效）
]);

const all = fs.readdirSync(HERE).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();
const OUT_DIR = path.resolve(HERE, '..', 'runtime', '.verify-out');
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = all.filter((f) => {
  if (SKIP.has(f)) return false;
  if (!LIVE && LIVE_SET.has(f)) return false;
  if (ONLY.length && !ONLY.some((p) => f.startsWith(p))) return false;
  return true;
});

const rows = [];
for (const file of targets) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    cwd: path.resolve(HERE, '..'),
    encoding: 'utf8',
    timeout: TIMEOUT_S * 1000,
    env: { ...process.env, QB_VERIFY_BATCH: '1' }
  });
  const ms = Date.now() - started;
  const timedOut = r.error && String(r.error.code || '').includes('ETIMEDOUT');
  const ok = !timedOut && r.status === 0;
  const tail = String(`${r.stdout || ''}${r.stderr || ''}`).trim().split('\n').slice(-3).join(' | ');
  fs.writeFileSync(path.join(OUT_DIR, `${file}.log`), String(`${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}`), 'utf8');
  rows.push({ file, ok, code: timedOut ? 'TIMEOUT' : r.status, ms, tail: tail.slice(0, 200) });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${ms} ms)${ok ? '' : `\n     ${tail}`}`);
}

const pass = rows.filter((r) => r.ok).length;
if (JSON_OUT) {
  console.log(JSON.stringify({ total: rows.length, pass, rows }, null, 2));
} else {
  console.log(`\n${pass === rows.length ? 'PASS' : 'FAILED'} ${pass}/${rows.length}${LIVE ? '（含 live 档）' : '（守门档）'}`);
}
process.exitCode = pass === rows.length ? 0 : 1;
