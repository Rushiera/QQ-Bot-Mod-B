// tools/webui-login.mjs —— 协议端 WebUI 登录探针
//
// 用法：node tools/webui-login.mjs <token> [port]
// 做什么：按 NapCat 的算法算出登录 hash（sha256(token + ".napcat")）→ 调登录接口 → 打印返回。
// 边界：只读探针，用于确认凭据链路；结果不落盘。

import crypto from 'node:crypto';

const token = process.argv[2] || '';
const port = Number(process.argv[3]) || 6099;

if (!token) {
  console.error('用法：node tools/webui-login.mjs <token> [port]');
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
console.log('hash =', hash);

const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hash, totpCode: '' })
});

const text = await response.text();
console.log('status =', response.status);
console.log('body =', text);
