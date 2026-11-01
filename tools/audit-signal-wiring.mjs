// B31 判据辅助 —— 查 engage-signals 的消费方（谁 import 了 computeSignals / compositeCoefficient）
import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
const pats = [/computeSignals/, /compositeCoefficient/, /signalSummary/, /engage-signals/];
const out = [];
for (const root of roots) {
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'bin', 'obj', '.git'].includes(n.name)) continue;
      const f = path.join(d, n.name);
      if (n.isDirectory()) { walk(f); continue; }
      if (!/\.(js|mjs|cjs)$/.test(n.name)) continue;
      let t = '';
      try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = t.split('\n');
      lines.forEach((l, i) => {
        if (pats.some((r) => r.test(l))) out.push(f + ':' + (i + 1) + ': ' + l.trim().slice(0, 120));
      });
    }
  };
  try { walk(root); } catch (e) { out.push('ERR ' + root + ' ' + e.message); }
}
console.log(out.join('\n') || '(no hits)');
