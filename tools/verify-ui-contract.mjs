// tools/verify-ui-contract.mjs —— R5 前端分块契约自测（守门档）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L16**
// 契约来源：`app/ui/views/_index.md` §三（3.1 签名 / 3.2 两个必备函数 / 3.3 代理层）
// 口径：**静态文本断言**（读文件 + 正则），不启浏览器、不起进程——R5 §0-4 禁起停进程。
//
// 用法：
//   node tools/verify-ui-contract.mjs          # 人读：逐条 FAIL + PASS n/n
//   node tools/verify-ui-contract.mjs --json   # 机读：{ ok, total, pass, groups, rows }
//
// 判据：全部 PASS → 打印 `PASS n/n` 且退出码 0；任一失败 → 打印失败清单 + 退出码 1。
//
// 断言八组（共 57 条，组见下方 GROUPS 常量）：
//   ① 文件在盘      —— 九件（八块 + 外壳）
//   ② 视图登记生效  —— 七个视图块都登记到 `window.__views.<name>`
//   ③ 必备函数      —— 七个视图块都有 `mount` 与 `refresh`
//   ④ 零裸 fetch    —— 视图块内不直连（`_shell.js` 豁免：它的 fetch 是 `api()` 实现本体）
//   ⑤ `__ui` 签名   —— 11 个成员逐个在册 + `stub === false`
//   ⑥ index.html    —— 13 个页签 · 9 个视图脚本 · 总 10 个 script
//   ⑦ 代理层        —— `app/src/web/business-proxy.js` 在盘且导出 `createBusinessProxy`
//   ⑧ 无 ESM        —— 九件均为普通脚本（无 `import` / `export`，契约 §三-1）
//
// 🔴 登记形态（组 ②）：契约 §三-2 只要求「每块暴露 `window.__views.<name>`」；
//    `registerView(name, view)` 是 `_shell.js` 提供的等价写法（内部即 `views[name] = view`）。
//    故断言按**登记生效**判，两种写法都算过；形态矩阵由 `--json` 的 `forms` 给出。
//    任务卡 §四 L16 写作「每块是否调 `registerView`」——卡与契约的这一处口径差异已报主干。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'app', 'ui');
const VIEWS = path.join(UI, 'views');
const JSON_OUT = process.argv.includes('--json');

/** 八块 + 外壳的文件名（与 `_index.md` §二 表一致；`settings-sections.js` 属 L8 同线，不是独立视图块）。 */
const BLOCKS = [
  '_shell.js',
  'sessions.js',
  'chats.js',
  'memory.js',
  'usage.js',
  'skills.js',
  'plugins.js',
  'settings.js',
  'settings-sections.js'
];

/** 七个视图块（`<script>` 里除外壳与分节库之外的七件）。 */
const VIEW_BLOCKS = ['sessions', 'chats', 'memory', 'usage', 'skills', 'plugins', 'settings'];

/** `window.__ui` 契约成员（`_index.md` §3.1，11 个，一个不能少）。 */
const UI_MEMBERS = ['api', '$', '$$', 'el', 'esc', 'fmtTime', 'fmtNum', 'fmtBytes', 'empty', 'fail', 'registerView'];

/** index.html 期望值（`tasks/R5.md` §3.1 表：13 个页签 / 9 个视图脚本 / 含 app.js 共 10 个 script）。 */
const EXPECT = { tabs: 13, viewScripts: 9, scripts: 10 };

const GROUPS = {
  files: '① 文件在盘',
  register: '② 视图登记生效',
  funcs: '③ 必备函数',
  fetch: '④ 零裸 fetch',
  signature: '⑤ __ui 签名',
  index: '⑥ index.html',
  proxy: '⑦ 代理层',
  esm: '⑧ 无 ESM'
};

const results = [];
/** 登记形态矩阵（信息面，不参与断言）。 */
const forms = [];

/**
 * 记一条断言结果。
 *
 * @param {string} group GROUPS 的键
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 失败详情
 * @returns {void}
 */
function check(group, name, ok, detail) {
  // 详情只在失败时保留——通过的条目带着失败文案会让人以为红过（2026-10-31 实测踩到）。
  results.push({ group, name, ok, detail: ok ? '' : (detail || '') });
}

/**
 * 读文件文本（不存在返空串——存在性由组 ① 单独断言，避免此处静默）。
 *
 * @param {string} file 绝对路径
 * @returns {string} 文本
 */
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ── 组 ①：九件文件在盘 ────────────────────────────────────────────────────
for (const file of BLOCKS) {
  const full = path.join(VIEWS, file);
  check('files', `views/${file} 存在`, fs.existsSync(full), '文件缺失——该块的执行线未交付');
}

// ── 组 ②：七个视图块登记生效（两种等价写法） ──────────────────────────────
for (const name of VIEW_BLOCKS) {
  const text = read(path.join(VIEWS, `${name}.js`));
  const init = /window\.__views\s*=\s*window\.__views\s*\|\|\s*\{\}/.test(text);
  const direct = new RegExp(`views\\.${name}\\s*=`).test(text);
  const viaApi = new RegExp(`registerView\\(\\s*['"]${name}['"]`).test(text);
  forms.push({ block: `${name}.js`, init, direct, viaApi, form: viaApi ? 'registerView' : direct ? 'views.<name>=' : '（无）' });
  check('register', `${name}.js 登记 window.__views.${name}`, init && (direct || viaApi),
    !init ? '缺 window.__views 初始化' : '既无 views.<name>= 也无 registerView(name, …)');
}

// ── 组 ③：七个视图块都有 mount 与 refresh ────────────────────────────────
for (const name of VIEW_BLOCKS) {
  const text = read(path.join(VIEWS, `${name}.js`));
  // 允许 `function mount(` 与 `const mount = (` / `mount: (` 三种写法
  const hasMount = /function\s+mount\s*\(|const\s+mount\s*=|mount\s*:\s*(function|\()/.test(text);
  const hasRefresh = /function\s+refresh\s*\(|const\s+refresh\s*=|refresh\s*:\s*(function|\()/.test(text);
  check('funcs', `${name}.js 有 mount + refresh`, hasMount && hasRefresh,
    `mount=${hasMount} refresh=${hasRefresh}`);
}

// ── 组 ④：视图块内零裸 fetch（_shell.js 豁免——其 fetch 是 api() 实现本体） ──
for (const file of BLOCKS.filter((f) => f !== '_shell.js')) {
  const text = read(path.join(VIEWS, file));
  const bare = /(^|[^.\w])fetch\s*\(/m.test(text);
  check('fetch', `${file} 无裸 fetch`, !bare, bare ? '发现裸 fetch( 调用——契约 §三-4 要求一律走 window.__ui.api' : '');
}

// ── 组 ⑤：_shell.js 导出 11 个 __ui 成员 + stub=false ────────────────────
const shellText = read(path.join(VIEWS, '_shell.js'));
const uiBodyMatch = /window\.__ui\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(shellText);
const uiBody = uiBodyMatch ? uiBodyMatch[1] : '';
const uiNames = new Set(
  uiBody
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => line.replace(/[,:].*$/, '').trim())
    .filter(Boolean)
);
check('signature', 'window.__ui 对象字面量可解析', Boolean(uiBodyMatch), '未找到 `window.__ui = { … };`');
for (const member of UI_MEMBERS) {
  check('signature', `__ui.${member}`, uiNames.has(member), `未在 window.__ui 字面量中声明（实测成员：${[...uiNames].join(' / ') || '空'}）`);
}
check('signature', '__ui.stub === false（桩标记已摘）',
  /const\s+STUB\s*=\s*false/.test(shellText) && /window\.__ui\.stub\s*=\s*STUB/.test(shellText),
  'STUB 非 false 或未挂 __ui.stub');

// ── 组 ⑥：index.html 的页签与脚本计数 ────────────────────────────────────
const html = read(path.join(UI, 'index.html'));
if (!html) {
  check('index', 'index.html 存在', false, `缺文件：${path.join(UI, 'index.html')}`);
} else {
  const tabs = (html.match(/class="tab[^"]*"\s+data-view=/g) || []).length;
  const viewScripts = (html.match(/<script[^>]+src="views\//g) || []).length;
  const scripts = (html.match(/<script[^>]+src=/g) || []).length;
  check('index', `页签数 = ${EXPECT.tabs}`, tabs === EXPECT.tabs, `实测 ${tabs}`);
  check('index', `视图脚本数 = ${EXPECT.viewScripts}`, viewScripts === EXPECT.viewScripts, `实测 ${viewScripts}`);
  check('index', `script 总数 = ${EXPECT.scripts}（9 视图 + app.js）`, scripts === EXPECT.scripts, `实测 ${scripts}`);
}

// ── 组 ⑦：代理层在盘且导出 createBusinessProxy ───────────────────────────
const proxyPath = path.join(ROOT, 'app', 'src', 'web', 'business-proxy.js');
const proxyText = read(proxyPath);
check('proxy', 'web/business-proxy.js 存在', fs.existsSync(proxyPath), '文件缺失——L9 未交付');
check('proxy', '导出 createBusinessProxy', /export\s+function\s+createBusinessProxy/.test(proxyText), '未找到 `export function createBusinessProxy`');

// ── 组 ⑧：九件均为普通脚本（无 ESM import / export） ─────────────────────
for (const file of BLOCKS) {
  const text = read(path.join(VIEWS, file));
  // 只认行首语句形态——注释里出现「无 import / export」不误伤
  const esm = /^[ \t]*(import|export)\s/m.test(text);
  check('esm', `${file} 是普通脚本`, !esm, '出现行首 import / export——契约 §三-1 要求普通脚本');
}

// ── 输出 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const byGroup = {};
for (const group of Object.keys(GROUPS)) {
  const rows = results.filter((r) => r.group === group);
  byGroup[group] = { title: GROUPS[group], total: rows.length, pass: rows.filter((r) => r.ok).length };
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    total: results.length,
    pass: results.length - failed.length,
    groups: byGroup,
    forms,
    rows: results
  }, null, 2));
} else {
  for (const r of failed) {
    console.log(`FAIL  [${GROUPS[r.group]}] ${r.name}${r.detail ? ' —— ' + r.detail : ''}`);
  }
  for (const [key, g] of Object.entries(byGroup)) {
    console.log(`${g.pass === g.total ? 'ok  ' : 'FAIL'} ${g.title} · ${g.pass}/${g.total}`);
  }
  console.log('登记形态：' + forms.map((f) => `${f.block}=${f.form}`).join(' · '));
  if (failed.length === 0) {
    console.log(`PASS ${results.length}/${results.length}`);
  } else {
    console.log(`FAIL ${failed.length}/${results.length}`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
