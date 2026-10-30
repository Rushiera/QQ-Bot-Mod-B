// 发言节制采集面 —— 把"这一拍为什么开口 / 为什么没开口"落成可算的数据。
// [qqagent-level-patch:metrics]
//
// 为什么要有它：出站闸拦下的发送原先不写日志，只把错误回给模型 ——
//   于是"话变少了"在日志里查不出原因，只能靠"发送量骤降 + 结算行数暴增"反推。
//   采集面落地后，每个群的入场判定 / 闸拦截 / 实发条数都能按天算。
//
// 形态：data/metrics/engage-<YYYY-MM-DD>.jsonl —— 一行一个事件，append-only。
//   采集失败绝不影响发言（所有调用点都 try/catch 包着）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'metrics');
const KEEP_DAYS = 30;

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fileFor(ts) {
  return path.join(DIR, 'engage-' + dayKey(ts) + '.jsonl');
}

/** 清掉超期文件（每天第一次写时顺手做；失败忽略）。 */
function pruneOld(ts) {
  const cutoff = ts - KEEP_DAYS * 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  for (const n of names) {
    const m = /^engage-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(n);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.unlinkSync(path.join(DIR, n)); } catch { /* 占用即跳过 */ } }
  }
}

let lastPruneDay = '';

/**
 * 记一条事件。
 * @param {object} entry { chat, event:'roll'|'blocked'|'sent', ... }
 */
export function record(entry) {
  const ts = Date.now();
  const row = { ts, ...entry };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const day = dayKey(ts);
    if (lastPruneDay !== day) { lastPruneDay = day; pruneOld(ts); }
    fs.appendFileSync(fileFor(ts), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 采集是旁路：失败绝不影响发言 */ }
}

/** 采集目录（自测 / 排查用）。 */
export function metricsDir() {
  return DIR;
}
