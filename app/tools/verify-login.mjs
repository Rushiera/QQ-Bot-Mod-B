// tools/verify-login.mjs —— 登录面真链路自测
//
// 用法：node tools/verify-login.mjs
// 做什么：起应用内核 → 经 HTTP 调登录面接口（界面用的同一出口）→ 断言回执形态 → 收尾。
// 边界：只读 + 探测——不停止已在运行的协议端，不发起真实登录（只读状态与已存账号）。

import { createApp } from '../src/app.js';

const app = await createApp();
const port = await app.start();
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  [OK] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name} ${detail}`);
  }
};

try {
  const status = await (await fetch(`${base}/api/qq/login`)).json();
  check('登录面可达', status?.ok === true, JSON.stringify(status?.status ?? null));
  check('状态含 isLogin', typeof status?.status?.state?.isLogin === 'boolean', JSON.stringify(status?.status ?? null));
  check('已存账号为数组', Array.isArray(status?.quick), JSON.stringify(status?.quick ?? null));
  check('已存账号非空', (status?.quick ?? []).length > 0, (status?.quick ?? []).join(','));

  // 空账号必须被拒——走守卫分支，不触发真实登录（无副作用）
  const rejected = await (await fetch(`${base}/api/qq/login/quick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uin: '' })
  })).json();
  check('空账号被拒', rejected?.ok === false && !!rejected?.error, JSON.stringify(rejected));
} finally {
  await app.stop();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
// 不调 process.exit：让它自然收尾——强制退出撞上 keep-alive 连接的句柄关闭会触发 libuv 断言
process.exitCode = fail === 0 ? 0 : 1;
