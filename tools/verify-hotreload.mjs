// verify-hotreload.mjs — 开发期热重载自测（源码断言 + 真行为，不跑应用）
//
// 用法：node tools/verify-hotreload.mjs
// 口径（Rushiera 2026-11-09 定）：改业务面代码自动重载子进程，不再手动重开应用；
// 单体侧改动不自动重启（会断界面与领航观测），只出声 + 标 appPending。
// 断言：
//   1  business.js   reload 方法在位、reloading 不进崩溃重试、status 暴露 reload/lastEventAt
//   2  hotreload.js  导出 createHotReload、三面分类、失败熔断
//   3  app.js        三条 /api/dev/* 端点 + start/stop 接线
//   4  main.js       hooks.relaunch（Electron 自我重启）
//   5  config.js     hotreload 默认段
//   6  真行为         业务面文件触发一次重载 / 单体文件只进 appPending / 熔断与人工恢复
// 说明：不真起 Electron、不真 spawn worker（会与运行中的业务面抢单实例锁）；真链路验收见 todo §〇-F。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const SRC = path.join(APP, 'src');
const TMP = path.resolve(HERE, '..', '.hotreload-selftest');

let pass = 0;
const fails = [];

/**
 * 记录一条断言。
 *
 * @param {string} name 项名
 * @param {boolean} cond 通过条件
 * @param {string} [detail] 失败说明
 * @returns {void}
 */
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}

/**
 * 读源码（缺失返回空串——后续断言自然红）。
 *
 * @param {string} file 绝对路径
 * @returns {string} 源码
 */
// 🔴 源码断言前统一归一到 LF——仓库文件是 CRLF，带 \n 的锚点会假红（实测 1d/1e）
function read(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; }
}

/**
 * 等待若干毫秒（真等待——watcher 事件是异步的）。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 完成
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1 business.js 热重载出口 ────────────────────────────────────────────────
const hubSrc = read(path.join(SRC, 'business.js'));
ok('1a reload 方法在位', /async reload\(\{\s*reason = 'manual'/.test(hubSrc));
ok('1b reloading 时子进程退出不进崩溃重试', hubSrc.includes('if (reloading) {'));
ok('1c 热重载不吃崩溃预算（restarts 清零）', hubSrc.includes('restarts = 0;') && hubSrc.includes('重载是新会话'));
ok('1d status 暴露 reloading / lastEventAt / reload', hubSrc.includes('reloading,\n        lastEventAt,') && hubSrc.includes('reload: { ...reloadState }'));
ok('1e dispatch 记录 lastEventAt（空闲窗口依据）', hubSrc.includes('stats.received += 1;\n    lastEventAt = Date.now();'));

// ── 2 hotreload.js 本体 ────────────────────────────────────────────────────
const hotSrc = read(path.join(SRC, 'hotreload.js'));
ok('2a 导出 createHotReload', hotSrc.includes('export function createHotReload('));
ok('2b 三面分类（business / app / ignore）', hotSrc.includes("return 'business';") && hotSrc.includes("return 'app';"));
ok('2c 失败熔断出声（failLimit）', hotSrc.includes('autoDisabled = true') && hotSrc.includes('已停止自动重载'));
ok('2d 空闲窗口与强制上限', hotSrc.includes('settings.idleMs') && hotSrc.includes('settings.maxWaitMs'));
ok('2e 只自动业务面：单体面只记账', hotSrc.includes('appPending.add(rel)'));

// ── 3 app.js 端点与接线 ────────────────────────────────────────────────────
const appSrc = read(path.join(SRC, 'app.js'));
ok('3a POST /api/dev/reload', appSrc.includes("'POST /api/dev/reload'"));
ok('3b GET /api/dev/reload', appSrc.includes("'GET /api/dev/reload'"));
ok('3c POST /api/dev/restart-app', appSrc.includes("'POST /api/dev/restart-app'"));
ok('3d 装配与起停接线', appSrc.includes('createHotReload({') && appSrc.includes('hotReload.start();') && appSrc.includes('hotReload.stop();'));
ok('3e 对外暴露 hotReload', appSrc.includes('businessHub, hotReload,'));

// ── 4 main.js Electron 自我重启 ────────────────────────────────────────────
const mainSrc = read(path.join(APP, 'main.js'));
ok('4a hooks.relaunch 在位', mainSrc.includes('core.hooks.relaunch = () => {') && mainSrc.includes('app.relaunch();'));

// ── 5 config.js 默认段 ────────────────────────────────────────────────────
const cfgSrc = read(path.join(SRC, 'config.js'));
ok('5a hotreload 默认段', cfgSrc.includes('hotreload: {') && cfgSrc.includes('idleMs: 8000'));

// ── 6 真行为：假 hub + 临时项目结构 ─────────────────────────────────────────
// 🔴 Windows 绝对路径不能直接喂动态 import（ERR_UNSUPPORTED_ESM_URL_SCHEME）——必须转 file:// URL
const { createHotReload } = await import(pathToFileURL(path.join(SRC, 'hotreload.js')).href);

/**
 * 造一份最小项目结构（app/src/business · app/src/navigator · personas · app/main.js）。
 *
 * @returns {void}
 */
function scaffold() {
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const rel of ['app/src/business', 'app/src/navigator', 'personas', 'app/role']) {
    fs.mkdirSync(path.join(TMP, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(TMP, 'app/main.js'), '// main\n');
  fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz\n');
  fs.writeFileSync(path.join(TMP, 'app/src/navigator/index.js'), '// nav\n');
  fs.writeFileSync(path.join(TMP, 'personas/rmiao.md'), '# card\n');
}

/**
 * 造一个假 hub（记录 reload 次数，可按需成功 / 失败）。
 *
 * @param {{fail?:boolean, lastEventAt?:number}} [options] 选项
 * @returns {object} 假 hub
 */
function fakeHub({ fail = false, lastEventAt = 0 } = {}) {
  const calls = [];
  return {
    calls,
    reload: async (options) => {
      calls.push(options ?? {});
      return fail ? { ok: false, error: '自测构造的失败' } : { ok: true, pid: 1000 + calls.length, port: 3210, ms: 12 };
    },
    status: () => ({ lastEventAt, reload: {}, worker: { pid: 1, port: 3210, ready: true } })
  };
}

scaffold();
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const logs = [];
const capture = { info: (t) => logs.push(t), warn: (t) => logs.push(t), error: (t) => logs.push(t) };

// 6a 业务面文件 → 触发一次重载（防抖把连写合并成一次）
const hubA = fakeHub();
const reloaderA = createHotReload({ rootDir: path.join(TMP, 'app'), projectDir: TMP, log: capture, hub: hubA, config: { debounceMs: 100, idleMs: 0 } });
reloaderA.start();
fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz v2\n');
await wait(60);
fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz v3\n');
await wait(700);
ok('6a 业务面改动触发重载（防抖合并为 1 次）', hubA.calls.length === 1, `calls=${hubA.calls.length}`);
ok('6b 重载原因带文件名', String(hubA.calls[0]?.reason ?? '').includes('business/app.js'), String(hubA.calls[0]?.reason ?? ''));
ok('6c status 记账（ok=1）', reloaderA.status().stats.ok === 1, JSON.stringify(reloaderA.status().stats));

// 6d 单体文件 → 不触发重载，只进 appPending
hubA.calls.length = 0;
fs.writeFileSync(path.join(TMP, 'app/src/navigator/index.js'), '// nav v2\n');
await wait(500);
const statusA = reloaderA.status();
ok('6d 单体改动不重载业务面', hubA.calls.length === 0, `calls=${hubA.calls.length}`);
ok('6e 单体改动进 appPending', statusA.appPending.some((rel) => rel.includes('navigator/index.js')), JSON.stringify(statusA.appPending));

// 6f 人设卡改动 → 算业务面（业务面每轮读盘）
fs.writeFileSync(path.join(TMP, 'personas/rmiao.md'), '# card v2\n');
await wait(500);
ok('6f 人设卡改动触发重载', hubA.calls.length === 1, `calls=${hubA.calls.length}`);
reloaderA.stop();

// 6g 连续失败 → 熔断；人工 auto=1 恢复
const hubB = fakeHub({ fail: true });
const reloaderB = createHotReload({ rootDir: path.join(TMP, 'app'), projectDir: TMP, log: capture, hub: hubB, config: { debounceMs: 100, idleMs: 0, failLimit: 2 } });
reloaderB.start();
fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz fail-1\n');
await wait(500);
fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz fail-2\n');
await wait(500);
const statusB = reloaderB.status();
ok('6g 连续失败即停自动', statusB.autoDisabled === true && statusB.stats.failed === 2, JSON.stringify(statusB.stats));
const beforeCount = hubB.calls.length;
fs.writeFileSync(path.join(TMP, 'app/src/business/app.js'), '// biz after-break\n');
await wait(400);
ok('6h 熔断后改动不再自动重载', hubB.calls.length === beforeCount, `calls=${hubB.calls.length}`);
const manual = await reloaderB.reloadNow({ reason: 'selftest', auto: true });
ok('6i 人工 reloadNow(auto) 解除熔断并执行', manual.ok === false && reloaderB.status().autoDisabled === false, JSON.stringify(manual));
reloaderB.stop();

// 6j 非法配置回落默认（0 是合法值，不能被 `||` 吃掉）
const hubC = fakeHub();
const reloaderC = createHotReload({ rootDir: path.join(TMP, 'app'), projectDir: TMP, log: silent, hub: hubC, config: { debounceMs: 'abc', idleMs: 0 } });
const settingsC = reloaderC.status().settings;
ok('6j 非法 debounceMs 回落默认 / idleMs=0 保留', settingsC.debounceMs === 800 && settingsC.idleMs === 0, JSON.stringify(settingsC));

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + fails.length;
if (fails.length) {
  console.log(`FAIL ${pass}/${total}`);
  for (const line of fails) console.log('  ✗ ' + line);
  process.exit(1);
}
console.log(`PASS ${pass}/${total}`);
