// probe-tts-duration.mjs — 语音产物时长探针（只读 WAV 头，不解码音频）
//
// 用法：
//   node tools/probe-tts-duration.mjs                      探 app/data/media-out 下全部 wav
//   node tools/probe-tts-duration.mjs <wav 路径> [...更多]  只探指定文件
//   node tools/probe-tts-duration.mjs --json              机读输出
//
// 为什么要有它：IrodoriTTS 的 SamplingRequest.max_seconds 默认 30.0（irodori-tts
// inference_runtime.py:218），worker 侧构造时**没传**该字段 → 每句被夹在 30 秒。
// 判断「到底是采样率 48k 的 30 秒，还是 24k 的 60 秒」必须先读产物头，不靠猜。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'app', 'data', 'media-out');
const AS_JSON = process.argv.includes('--json');

/**
 * 读 WAV 头（RIFF/fmt/data）——只取采样率 / 位深 / 声道 / 数据字节。
 *
 * @param {string} file 绝对路径
 * @returns {object|null} 信息（非 WAV 返回 null）
 */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14)
      };
    }
    if (id === 'data') {
      // 流式写盘时 size 可能为 0 / 0xFFFFFFFF——按剩余字节兜底
      dataBytes = size > 0 && size !== 0xFFFFFFFF && body + size <= buf.length ? size : buf.length - body;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) return null;
  const frames = dataBytes / Math.max(1, (fmt.bitsPerSample / 8) * Math.max(1, fmt.channels));
  return {
    file: path.basename(file),
    bytes: buf.length,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataBytes,
    frames: Math.round(frames),
    seconds: Number((frames / Math.max(1, fmt.sampleRate)).toFixed(3))
  };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let files = args;
if (!files.length) {
  files = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter((n) => n.toLowerCase().endsWith('.wav')).map((n) => path.join(OUT_DIR, n))
    : [];
}
if (!files.length) {
  console.log(JSON.stringify({ ok: false, error: '没找到 wav——先跑一句语音，或用参数指定文件' }));
  process.exitCode = 1;
} else {
  const rows = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
    let info = null;
    try { info = readWav(abs); } catch (error) { info = { file: path.basename(abs), error: String(error?.message ?? error) }; }
    rows.push(info ?? { file: path.basename(abs), error: '不是 WAV（RIFF/WAVE 头缺失）' });
  }
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: true, dir: OUT_DIR, rows }, null, 2));
  } else {
    for (const r of rows) {
      if (r.error) { console.log(`  ✗ ${r.file} — ${r.error}`); continue; }
      console.log(`  ${r.file}  ${r.seconds}s · ${r.sampleRate}Hz · ${r.channels}ch · ${r.bitsPerSample}bit · ${r.bytes} 字节 · ${r.frames} 帧`);
    }
    const rates = [...new Set(rows.filter((r) => r.sampleRate).map((r) => r.sampleRate))];
    const secs = rows.filter((r) => r.seconds).map((r) => r.seconds);
    console.log(`共 ${rows.length} 条 · 采样率 ${rates.join(' / ') || '?'}Hz · 时长 ${secs.length ? Math.min(...secs) + '~' + Math.max(...secs) : '?'}s`);
  }
}
