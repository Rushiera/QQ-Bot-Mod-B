// migrate-qqagent-group-memory.mjs — 存量记忆迁移（一次性，可重放）
//
// 做什么（design-qqbotb-memory.md §3.6）：
//   1) 群友档里的「群级条目」→ 群记（_group.json），并从人档移除
//   2) 人档被写错的名字（把话题当人名）回填为真实群名片
//   3) _topics.json 裸词 → 群记的 topic 条目，旧文件改名 .migrated 留痕（不进成员扫描）
// 用法：node migrate-qqagent-group-memory.mjs [--dry]
// 目标：QQ_AGENT_DATA_DIR 或 _unpack/data（运行实例的数据目录）
// 幂等：条目找不到 / 已有 topic 条目 → 跳过；可反复运行
// ⚠️ 应用运行中改数据不生效（MemoryStore 有内存缓存）——迁移后重启一次应用

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DRY = process.argv.includes('--dry');
const DATA = process.env.QQ_AGENT_DATA_DIR || path.resolve(HERE, '..', '_unpack', 'data');
process.env.QQ_AGENT_DATA_DIR = DATA;

const gm = await import(pathToFileURL(path.join(APP, 'src', 'group-memory.js')).href);
const MEMORY_DIR = path.join(DATA, 'memory');

// 群级条目搬迁表（逐条点名——不做模糊匹配，避免误伤真人的印象）
const MOVES = [
  { chatKey: 'group:1097492606', userId: '569145850', match: '协作约定：遇到我能力/工具面做不到的事', kind: 'rule' },
  { chatKey: 'group:1097492606', userId: '569145850', match: '他把 qqagent 壳的前文（CCBP', kind: 'rule' },
  { chatKey: 'group:1097492606', userId: '569145850', match: 'bot指定（主人识别）已上线', kind: 'rule' }
];

// 人档名字回填（曾经把话题当人名写进 name 字段）
const RENAMES = [
  { chatKey: 'group:1097492606', userId: '569145850', name: 'Rushiera' }
];

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

const moved = [];
const renamed = [];
const topics = [];
const skipped = [];

for (const dirName of fs.readdirSync(MEMORY_DIR)) {
  const dir = path.join(MEMORY_DIR, dirName);
  try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
  const m = /^(group|private)_(\d+)$/.exec(dirName);
  if (!m) continue;
  const chatKey = m[1] + ':' + m[2];

  // ── 1) 群级条目：人档 → 群记 ──
  for (const mv of MOVES.filter((x) => x.chatKey === chatKey)) {
    const file = path.join(dir, mv.userId + '.json');
    if (!fs.existsSync(file)) { skipped.push(chatKey + ' 无 ' + mv.userId + '.json'); continue; }
    const raw = readJson(file);
    if (!raw || !Array.isArray(raw.impressions)) continue;
    const hit = raw.impressions.filter((e) => String(e.content || '').includes(mv.match));
    if (!hit.length) { skipped.push(chatKey + ' 已迁移：' + mv.match.slice(0, 12)); continue; }
    raw.impressions = raw.impressions.filter((e) => !String(e.content || '').includes(mv.match));
    if (!DRY) writeJson(file, raw);
    for (const e of hit) {
      if (!DRY) gm.appendGroupEntry(chatKey, mv.kind, String(e.content));
      moved.push(chatKey + ' ' + mv.userId + ' → [' + mv.kind + '] ' + String(e.content).slice(0, 24) + '…');
    }
  }

  // ── 2) 人档名字回填 ──
  for (const rn of RENAMES.filter((x) => x.chatKey === chatKey)) {
    const file = path.join(dir, rn.userId + '.json');
    if (!fs.existsSync(file)) continue;
    const raw = readJson(file);
    if (!raw || raw.name === rn.name) continue;
    const oldName = String(raw.name || '');
    raw.name = rn.name;
    if (!DRY) writeJson(file, raw);
    renamed.push(chatKey + ' ' + rn.userId + '：' + oldName + ' → ' + rn.name);
  }

  // ── 3) 话题词 → topic 条目，旧文件改名留痕 ──
  const tf = path.join(dir, '_topics.json');
  if (fs.existsSync(tf)) {
    const raw = readJson(tf);
    const words = Array.isArray(raw && raw.words) ? raw.words.map((w) => String(w)).filter(Boolean) : [];
    const hasTopic = gm.listGroupEntries(chatKey).some((e) => e.kind === 'topic');
    if (words.length && !hasTopic) {
      if (!DRY) gm.setGroupTopics(chatKey, words);
      topics.push(chatKey + '：' + words.length + ' 词 → topic 条目');
    } else {
      skipped.push(chatKey + ' topic 条目已存在或词表为空');
    }
    if (!DRY) fs.renameSync(tf, tf + '.migrated');
  }
}

console.log(JSON.stringify({
  ok: true,
  dryRun: DRY,
  dataDir: DATA,
  moved, renamed, topics, skipped
}, null, 2));
