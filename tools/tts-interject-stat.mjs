// TTS 语气词统计——念出去的日语里语气词占比观测位点（常驻工具 · 2026-11-08 立）
//
// 用法：
//   node tools/tts-interject-stat.mjs              # 扫全部 app/data/logs/*.log，按天出表
//   node tools/tts-interject-stat.mjs 2026-11-08   # 只统计某一天
//   node tools/tts-interject-stat.mjs 2026-11-08 dump   # 附逐条明细（译文前 40 字）
//
// 口径：`app/data/logs/*.log` 里的 `[tts] 语音已提交：<译文前 40 字>` 行——那是真正送进
// IrodoriTTS 的日语文案（`navigator/media.js` 的 `record('tts', …)`）。
//
// 判据：`gateInterjections()` 上线后（v1.38 · 2026-11-08）「おや 起头」占比应从 23.7% 降到
// 30% 以内且不连击；分母是当天的 TTS 条数。判例 → design-qqbotb_log.md §一百一十七。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Mau/WorkSpace/QQBotB/app/data/logs';
const MARK = '[tts] 语音已提交：';

/** 计入统计的语气词（与 media.js 的 INTERJ_WORDS 同源；おはよう 这类问候语不算）。 */
const INTERJ = ['おや', 'あら', 'ふふ', 'ふむ', 'ほう', 'ほー'];

/**
 * 取一天日志里的 TTS 文案。
 *
 * @param {string} file 日志文件名
 * @returns {string[]} 译文片段（每条前 40 字）
 */
function texts(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf(MARK);
    if (at < 0) continue;
    const body = line.slice(at + MARK.length).trim();
    if (body) out.push(body);
  }
  return out;
}

/**
 * 一天的统计。
 *
 * @param {string[]} list 译文片段
 * @returns {object} 统计结果
 */
function stat(list) {
  const open = list.filter((t) => INTERJ.some((w) => t.replace(/^[「『]/, '').startsWith(w)));
  const oya = open.filter((t) => t.replace(/^[「『]/, '').startsWith('おや'));
  const anyOya = list.filter((t) => t.includes('おや'));
  // 最长连续「おや 起头」串——连击比绝对频次更刺耳
  let run = 0;
  let best = 0;
  for (const t of list) {
    if (t.replace(/^[「『]/, '').startsWith('おや')) { run += 1; best = Math.max(best, run); } else run = 0;
  }
  return {
    n: list.length,
    open: open.length,
    oya: oya.length,
    anyOya: anyOya.length,
    bestRun: best
  };
}

const only = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '';
const dump = process.argv.includes('dump');
const files = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
  : [];
const picked = only ? files.filter((f) => f.includes(only)) : files;

console.log(`日志根 ${ROOT}`);
console.log('日期         条数   语气词起头   おや起头   任含おや   最长おや连击');
for (const f of picked) {
  const list = texts(f);
  if (!list.length) continue;
  const s = stat(list);
  const pct = (v) => (s.n ? `${((v / s.n) * 100).toFixed(1)}%` : '-');
  const pad = (v, w) => String(v).padStart(w);
  console.log(`${f.replace('qq-agent-', '').replace('.log', '')}  ${pad(s.n, 5)}  ${pad(`${s.open} ${pct(s.open)}`, 10)}  ${pad(`${s.oya} ${pct(s.oya)}`, 8)}  ${pad(s.anyOya, 8)}  ${pad(s.bestRun, 10)}`);
  if (dump) for (const t of list) console.log('    ' + t.slice(0, 40));
}
