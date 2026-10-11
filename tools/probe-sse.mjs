// probe-sse.mjs —— SSE 事件探针（诊断用）
//
// 用法：node tools/probe-sse.mjs [port] [seconds]
// 做什么：订阅某猫对话端口的 /api/v1/stream，打印前若干帧的「事件名 / renderType / data 键」，
//         并给出事件签名统计——用于核对 CH4 实际推什么、领航员的判据是否对得上。
// 边界：只读；不改任何状态。

const port = Number(process.argv[2]) || 8088;
const seconds = Number(process.argv[3]) || 6;

const response = await fetch(`http://127.0.0.1:${port}/api/v1/stream`);
if (!response.ok) {
  console.log(`HTTP ${response.status}`);
  process.exit(1);
}
const reader = response.body.getReader();
const decoder = new TextDecoder();
const seen = new Map();
const t0 = Date.now();
let buffer = '';
let printed = 0;

while (Date.now() - t0 < seconds * 1000) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let m = /\r?\n\r?\n/.exec(buffer);
  while (m) {
    const raw = buffer.slice(0, m.index);
    buffer = buffer.slice(m.index + m[0].length);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    let keys = '';
    let renderType = '';
    const rawData = dataLines.join('\n');
    if (dataLines.length > 0) {
      try {
        const obj = JSON.parse(rawData);
        keys = Object.keys(obj).join(',');
        renderType = String(obj.renderType ?? '');
      } catch {
        keys = '（非 JSON）';
      }
    }
    const sig = `${event} | renderType=${renderType || '（空）'}`;
    seen.set(sig, (seen.get(sig) || 0) + 1);
    if (printed < 8) {
      console.log(`#${printed} event=${event} renderType=${renderType || '（空）'} keys=${keys.slice(0, 140)}`);
      console.log(`   data=${rawData.replace(/\s+/g, ' ').slice(0, 400)}`);
      printed += 1;
    }
    m = /\r?\n\r?\n/.exec(buffer);
  }
}

console.log('—— 事件签名统计 ——');
for (const [sig, count] of seen) console.log(`${sig} × ${count}`);
