// apply-qqagent-memory-limits.mjs — 记忆「不节流」参数热写（2026-10-16 Rushiera 定）
//
// 为什么用脚本：业务面的配置只在**运行实例内存**里生效（判例 v0.58），
// 直改 _unpack/data/config.json 不生效且会被应用内部写回抹掉 —— 必须走
// `POST /api/config`（浅合并 / 深合并，只提交 memory 一节）。
//
// 参数口径（设计 → design-qqbotb-memory.md §3.10）：
//   maxImpressionsPerMember 8 → 40   重整提示词的条数上限（现行池不淘汰）
//   maxGroupEntries        20 → 60   群记重整上限
//   consolidateMinIntervalMs 6h → 3h 整理冷却
//   discoverMinMessages     5 → 3    发现新人门槛
//   discoverMaxMembers      6 → 10   单次发现人数
//   sedimentIntervalMs      （新增）12h 冷群沉淀拍间隔（0=关）
//
// 用法：node apply-qqagent-memory-limits.mjs [--dry]
// 幂等：目标值已到位 → 只报「已是目标值」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.QQ_AGENT_DATA_DIR || path.resolve(HERE, '..', '_unpack', 'data');
const DRY = process.argv.includes('--dry');

const TARGET = {
  maxImpressionsPerMember: 40,
  maxGroupEntries: 60,
  consolidateMinIntervalMs: 3 * 60 * 60 * 1000,
  discoverMinMessages: 3,
  discoverMaxMembers: 10,
  sedimentIntervalMs: 12 * 60 * 60 * 1000
};

/** 业务面端口：优先读 config.server.port（自研单体按 3200+ 段拉起）。 */
function candidatePorts() {
  const ports = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    const p = Number(cfg?.server?.port);
    if (p > 0) ports.push(p);
  } catch { /* 读不到就走扫描 */ }
  for (let p = 3200; p < 3220; p++) if (!ports.includes(p)) ports.push(p);
  return ports;
}

async function api(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${String(text).slice(0, 160)}`);
  return parsed;
}

let base = null;
for (const p of candidatePorts()) {
  try {
    const v = await api(`http://127.0.0.1:${p}`, 'GET', '/api/version');
    if (v && v.version) { base = `http://127.0.0.1:${p}`; break; }
  } catch { /* 换下一个端口 */ }
}
if (!base) {
  console.error('ERR 业务面不可达（试过 ' + candidatePorts().join(', ') + '）——先确认应用在跑');
  process.exitCode = 1;
} else {
  await run();
}

async function run() {
const cur = await api(base, 'GET', '/api/config');
const curMem = cur?.memory || {};
const patch = {};
for (const [k, v] of Object.entries(TARGET)) {
  if (Number(curMem[k]) !== Number(v)) patch[k] = v;
}

console.log('业务面 = ' + base);
console.log('现值   = ' + JSON.stringify(curMem));
if (!Object.keys(patch).length) {
  console.log('已是目标值，无需写。');
  return;
}
console.log('将写   = ' + JSON.stringify(patch));
if (DRY) { console.log('[dry] 未落盘'); return; }

await api(base, 'POST', '/api/config', { memory: { ...curMem, ...patch } });
const after = await api(base, 'GET', '/api/config');
const afterMem = after?.memory || {};
const bad = Object.entries(TARGET).filter(([k, v]) => Number(afterMem[k]) !== Number(v));
console.log('写后   = ' + JSON.stringify(afterMem));
if (bad.length) {
  console.error('ERR 写后复核不一致：' + bad.map(([k, v]) => `${k} 期望 ${v} 实得 ${afterMem[k]}`).join('；'));
  process.exitCode = 1;
  return;
}
console.log('OK 记忆参数已热写并复核通过（生效：下一次记忆整理 / 沉淀拍）');
}
