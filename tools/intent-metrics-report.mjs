// A7 取数 —— intent 影子采集两日实况（行数 + kind / action / via / result 分布）
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.log('ERR need dir'); process.exit(2); }
const files = fs.readdirSync(dir).filter((n) => /^intent-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
const out = {};
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim());
  const kind = {}, action = {}, via = {}, result = {};
  for (const l of lines) {
    let r = null;
    try { r = JSON.parse(l); } catch { continue; }
    const k = String(r.kind ?? '(none)');
    kind[k] = (kind[k] || 0) + 1;
    const a = String(r.action ?? '(none)');
    action[a] = (action[a] || 0) + 1;
    const v = String(r.via ?? '(none)');
    via[v] = (via[v] || 0) + 1;
    const s = String(r.result ?? '(none)');
    result[s] = (result[s] || 0) + 1;
  }
  out[f] = { rows: lines.length, kind, action, via, result };
}
console.log(JSON.stringify(out, null, 2));
