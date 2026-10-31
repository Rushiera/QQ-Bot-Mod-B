// tools/verify-ui-contract.mjs —— R5 前端分块契约自测（守门档）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L16**
// 契约来源：`app/ui/views/_index.md` §三（3.1 签名 / 3.2 两个必备函数 / 3.3 代理层）
// 口径：**静态文本断言**（读文件 + 正则），不启浏览器、不起进程——R5 §0-4 禁起停进程。
//
// 用法：node tools/verify-ui-contract.mjs
// 判据：全部 PASS → 打印 `PASS n/n` 且退出码 0；任一失败 → 打印失败清单 + 退出码 1。
//
// 🟡 桩状态：断言目前只覆盖「文件存在 + 桩标记」，等 L1..L8 交付后逐步收紧
//    （L16 的验收面见 `tasks/R5.md` L16 节，共 6 条）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'app', 'ui');
const VIEWS = path.join(UI, 'views');

/** 八块 + 外壳的文件名（与 `_index.md` §二 表一致）。 */
const BLOCKS = ['_shell.js', 'sessions.js', 'chats.js', 'memory.js', 'usage.js', 'skills.js', 'plugins.js', 'settings.js', 'settings-sections.js'];

const results = [];

/**
 * 记一条断言结果。
 *
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败详情
 * @returns {void}
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
}

// ① 九件文件在盘
for (const file of BLOCKS) {
  const full = path.join(VIEWS, file);
  check(`文件存在：views/${file}`, fs.existsSync(full));
}

// ② 每块都登记视图（_shell 除外——它是外壳）
for (const file of BLOCKS.filter((f) => f !== '_shell.js' && f !== 'settings-sections.js')) {
  const full = path.join(VIEWS, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  check(`自注册：${file}`, /window\.__views\s*=\s*window\.__views\s*\|\|\s*\{\}/.test(text) && /views\.\w+\s*=/.test(text));
}

// ③ 每块都有 mount 与 refresh
for (const file of BLOCKS.filter((f) => f !== '_shell.js' && f !== 'settings-sections.js')) {
  const full = path.join(VIEWS, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  check(`必备函数：${file}`, /function\s+mount\s*\(/.test(text) && /function\s+refresh\s*\(/.test(text));
}

// ④ 块内不得裸写 fetch（契约 §三-4：一律走 window.__ui.api）
for (const file of BLOCKS.filter((f) => f !== '_shell.js')) {
  const full = path.join(VIEWS, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  const bare = /(^|[^.\w])fetch\s*\(/m.test(text);
  check(`无裸 fetch：${file}`, !bare, bare ? '发现裸 fetch 调用，应改走 window.__ui.api' : '');
}

// ⑤ index.html 的页签与脚本标签计数
const indexHtml = path.join(UI, 'index.html');
if (fs.existsSync(indexHtml)) {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const tabs = (html.match(/class="tab[^"]*"\s+data-view=/g) || []).length;
  const scripts = (html.match(/<script[^>]+src="views\//g) || []).length;
  check('index.html 页签数 = 13', tabs === 13, `实测 ${tabs}`);
  check('index.html 视图脚本数 = 9', scripts === 9, `实测 ${scripts}`);
} else {
  check('index.html 存在', false);
}

// ⑥ 代理层文件在盘
const proxy = path.join(ROOT, 'app', 'src', 'web', 'business-proxy.js');
check('代理层文件存在', fs.existsSync(proxy));
if (fs.existsSync(proxy)) {
  const text = fs.readFileSync(proxy, 'utf8');
  check('代理层导出 createBusinessProxy', /export\s+function\s+createBusinessProxy/.test(text));
}

// 打印
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`FAIL  ${r.name}${r.detail ? ' —— ' + r.detail : ''}`);
}
if (failed.length === 0) {
  console.log(`PASS ${results.length}/${results.length}`);
  process.exit(0);
}
console.log(`FAIL ${failed.length}/${results.length}`);
process.exit(1);
