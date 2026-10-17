// migrate-qqagent-memory-archive.mjs — 存量记忆归档 / 建索引（一次性，可重放）
//
// 背景（2026-10-16 Rushiera 定）：「记忆不需要节流，写的多不是坏事，但要能归档能索引」。
// 现行池从「超限淘汰最旧」改成「超限转归档」之后，存量数据要做两件事：
//
//   1) **场次噪声下沉**——领航员每次关闭都写一条 kind=project 群记，历史上 0 分 0 秒 /
//      0 指令 / 0 截图的空场次照写。它们把真实群知识（lore / rule / relation）顺序挤出。
//      本脚本把这类条目**移进归档**（archive/，可检索、不丢），现行池只留真知识。
//   2) **建索引**——给每个会话写 `_index.json`（现行池分类计数 + 归档计数）。
//
// 用法：node migrate-qqagent-memory-archive.mjs [--dry]
// 目标：QQ_AGENT_DATA_DIR 或 _unpack/data（运行实例的数据目录）
// 幂等：已被移走的条目不在现行池里 → 重跑无操作；索引每次重建。
// ⚠️ 应用运行中改数据不生效（MemoryStore 有内存缓存）——迁移后重启一次业务面。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DRY = process.argv.includes('--dry');
const DATA = process.env.QQ_AGENT_DATA_DIR || path.resolve(HERE, '..', '_unpack', 'data');
process.env.QQ_AGENT_DATA_DIR = DATA;

const gm = await import(pathToFileURL(path.join(APP, 'src', 'group-memory.js')).href);
const { MemoryStore } = await import(pathToFileURL(path.join(APP, 'src', 'memory.js')).href);
const memory = new MemoryStore();
const MEMORY_DIR = path.join(DATA, 'memory');

/**
 * 「空场次」判据（与 navigator/index.js sedimentVoyage 的实绩判据同构）：
 * 领航场次记录里 —— 时长为 0 分 0 秒 / 0 分 1 秒，且 指令 / 截图 / 播报 / 巡检 全 0。
 */
function isEmptyVoyage(entry) {
  if (!entry || entry.kind !== 'project') return false;
  const text = String(entry.content || '');
  if (!/^领航场次\s/.test(text)) return false;
  const dur = /（(\d+)\s*分\s*(\d+)\s*秒）/.exec(text);
  const mins = dur ? Number(dur[1]) : 0;
  const secs = dur ? Number(dur[2]) : 0;
  if (mins > 0 || secs > 1) return false;
  const nums = [...text.matchAll(/(指令|回复截图|进度播报|开场巡检)\s*(\d+)/g)].map((m) => Number(m[2]));
  return nums.length > 0 && nums.every((n) => n === 0);
}

function chatDirs() {
  try {
    return fs.readdirSync(MEMORY_DIR)
      .filter((f) => /^(group|private)_\d+$/.test(f))
      .filter((f) => fs.statSync(path.join(MEMORY_DIR, f)).isDirectory());
  } catch { return []; }
}

const report = [];
for (const dir of chatDirs()) {
  const chatKey = dir.replace('_', ':');
  const entries = gm.listGroupEntries(chatKey);
  const noise = entries.filter(isEmptyVoyage);
  const keep = entries.filter((e) => !isEmptyVoyage(e));
  let moved = 0;
  if (noise.length) {
    if (DRY) {
      moved = noise.length;
    } else {
      moved = gm.archiveGroupEntries(chatKey, noise, 'voyage-empty');
      // 归档成功才从现行池移除（失败则保留，不丢）
      if (moved > 0) {
        const file = gm.groupMemoryFile(chatKey);
        fs.writeFileSync(file + '.tmp', JSON.stringify({ chatKey, entries: keep, updatedAt: Date.now() }, null, 1), 'utf8');
        fs.renameSync(file + '.tmp', file);
      }
    }
  }
  if (!DRY) gm.rebuildGroupIndex(chatKey);
  const stats = gm.groupMemoryStats(chatKey);
  const mArch = memory.memberArchiveStats(chatKey);
  report.push({ chatKey, 场次噪声: moved, 现行: stats.count, 群记归档: stats.archived, 人档归档: mArch.count });
}

console.log((DRY ? '[dry] ' : '') + 'migrate-qqagent-memory-archive 完成（数据目录 ' + DATA + '）');
for (const r of report) {
  console.log('  ' + r.chatKey + '：场次噪声移出 ' + r.场次噪声 + ' · 现行群记 ' + r.现行
    + ' · 群记归档 ' + r.群记归档 + ' · 人档归档 ' + r.人档归档);
}
