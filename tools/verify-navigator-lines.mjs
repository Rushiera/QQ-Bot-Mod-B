// verify-navigator-lines.mjs —— 领航员「线」表自测（A 方案 · 2026-11-09）
//
// 覆盖：线表纯行为（开线 / 同猫收旧线 / 交报告 / 超时收线 / 关闭全收 / 落盘重启）
//       + 源码在位断言（出站判据 / 端点 / 工具 / 面板 / 配置）。
// 边界：不真起单体、不真调 CH4——行为面靠线表纯函数，链路面靠源码断言。
// 用法：node tools/verify-navigator-lines.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineStore, LINE_STATUS } from '../app/src/navigator/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..', 'app');

let pass = 0;
let fail = 0;
const fails = [];

/**
 * 断言。
 *
 * @param {boolean} ok 是否通过
 * @param {string} name 用例名
 * @param {string} [detail] 失败细节
 * @returns {void}
 */
function check(ok, name, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 造一个临时线表文件（每个用例组独立，互不影响）。 */
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navlines-'));
  const file = path.join(dir, 'nav-lines.json');
  const log = { info() {}, warn() {}, error() {} };
  return { file, dir, store: createLineStore({ file, log }), log };
}

/** 读源码文本（源码在位断言用）。 */
function read(rel) {
  return fs.readFileSync(path.join(APP, rel), 'utf8');
}

console.log('— 线表行为 —');
{
  const { store, file } = tmpStore();
  const a = store.add({ chat: '111', key: 'majordomo', name: 'majordomo', text: '看一下 CH4 状态', by: 'qq' });
  check(a.id === 'L1', '开线分配 L1');
  check(a.status === LINE_STATUS.RUNNING, '新线状态 running');
  check(store.activeFor('majordomo')?.id === 'L1', 'activeFor 命中在跑线');
  check(store.activeFor('不存在') === null, 'activeFor 未命中返回 null');

  const b = store.add({ chat: '111', key: 'majordomo', text: '第二条', by: 'qq' });
  const old = store.snapshot({ recent: 20 }).recent.find((item) => item.id === 'L1');
  check(old?.status === LINE_STATUS.CLOSED && old?.note === 'superseded', '同猫再派活 → 旧线 superseded');
  check(b.id === 'L2', '新线 L2');
  check(store.activeFor('majordomo')?.id === 'L2', 'activeFor 取最新在跑线');

  store.markReported('L2', { rounds: 1 });
  const r1 = store.snapshot().active.find((item) => item.id === 'L2');
  check(r1?.status === LINE_STATUS.REPORTED && r1?.rounds === 1, '交报告 → reported / rounds=1');
  store.markReported('L2', { rounds: 1 });
  const r2 = store.snapshot().active.find((item) => item.id === 'L2');
  check(r2?.rounds === 2 && r2?.status === LINE_STATUS.REPORTED, '重复交报告只累加 rounds');
  check(store.activeFor('majordomo') === null, 'reported 后 activeFor 不再命中（线外静默生效）');

  check(store.sweep({ closeAfterMs: 0 }) === 0, 'closeAfterMs=0 不自动收线');
  check(store.sweep({ closeAfterMs: 1 }) === 1, '超时自动收线 1 条');
  const swept = store.snapshot({ recent: 20 }).recent.find((item) => item.id === 'L2');
  check(swept?.note === 'auto', '自动收线 note=auto');

  store.add({ chat: '222', key: 'rb', text: '还在跑', by: 'app' });
  check(store.closeAll('voyage-close') === 1, 'closeAll 收掉在跑线');
  check(store.snapshot().active.length === 0, 'closeAll 后无活跃线');

  check(fs.existsSync(file), '线表已落盘');
  const restored = createLineStore({ file, log: { info() {}, warn() {}, error() {} } });
  const snaps = restored.snapshot({ recent: 20 });
  check(snaps.seq === 3, '重启后 seq 续上', `seq=${snaps.seq}`);
  check(snaps.recent.length >= 2, '重启后历史线可读', `recent=${snaps.recent.length}`);
}

console.log('— 计数与截断 —');
{
  const { store } = tmpStore();
  store.add({ chat: '1', key: 'a', text: 'x'.repeat(500) });
  const line = store.snapshot().active[0];
  check(line.text.length === 200, '指令原文截断到 200 字符', `len=${line.text.length}`);
  store.add({ chat: '1', key: 'b', text: 'b1' });
  store.add({ chat: '1', key: 'c', text: 'c1' });
  store.markReported('L2', { rounds: 1 });
  const snap = store.snapshot();
  check(snap.counts.running === 2 && snap.counts.reported === 1, 'counts 分档正确',
    JSON.stringify(snap.counts));
  store.block('L3', '演示阻塞');
  check(store.snapshot().counts.blocked === 1, 'block 计入 counts.blocked');
}

console.log('— 源码在位（判据不落空） —');
{
  const idx = read('src/navigator/index.js');
  check(idx.includes("from './lines.js'"), 'index.js 引入线表');
  check(idx.includes('lineStore.activeFor(key)'), 'emitOutbound 有出站线判据');
  check(idx.includes("reason: 'off-line'"), '线外静默有具名出口');
  check(idx.includes('lineStore.markReported(line.id'), '线内首报记交报告');
  check(idx.includes('lineStore.sweep({ closeAfterMs: lineCloseAfterMs })'), 'tick 巡检自动收线');
  check(idx.includes("'GET /api/nav/lines'"), '端点 /api/nav/lines 已挂');
  check(idx.includes('lines: lineStore.snapshot()'), 'status 带 lines 段');
  check(idx.includes('lineStore.closeAll('), '关闭领航员收线');
  check(idx.includes('前文整理同样是一次派活'), '前文整理开线（整理结果也走线判据）');
  check(idx.includes('force = false'), '出站支持 force（用户主动回执不被吞）');
  check(idx.includes('{ force: true }'), '主动分析走 force（nav_analyze / 面板分析照常回执）');

  const conf = read('src/config.js');
  check(conf.includes("offLineOutbound: 'quiet'"), '配置默认 quiet（降噪）');
  check(conf.includes('closeAfterMs: 30 * 60 * 1000'), '配置默认收线 30 分钟');

  const tools = read('src/business/nav-tools.js');
  check(tools.includes("id: 'nav_lines'"), '业务面工具 nav_lines 已注册');
  check(tools.includes("call('/api/nav/lines')"), 'nav_lines 走线表端点');

  const view = read('ui/views/navigator.js');
  check(view.includes('function renderLines()'), '面板有 renderLines');
  check(view.includes('lineCard'), '面板有线卡');
  check(view.includes('renderLines();'), 'refresh 调用 renderLines');
}

console.log('');
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const item of fails) console.log(`  - ${item}`);
  process.exitCode = 1;
}
