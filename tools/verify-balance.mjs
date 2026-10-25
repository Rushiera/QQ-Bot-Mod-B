// verify-balance.mjs — 「群名片余额后缀」自测（纯函数真跑 + 源码断言，不启动应用）
//
// 用法：node tools/verify-balance.mjs
// 断言：
//   1~16  纯函数 / 取数：normalizeAmount / formatAmount / balanceSuffix / stripBalanceSuffix /
//         composeCard / resolveBalance（含「未知来源抛错，不静默回落 0」）
//   17    balanceRule() 结构（chats 数组 · marker · intervalMs ≥ 60000）
//   18~19  config.js：engage.balance 默认段在位，且默认全关（chats 空）+ 映射接口占位字段
//   20    app.js：import 挂载点 + startBalanceLoop(onebot) 调用在位
//   21    routes.js：POST /api/balance/sync 路由 + syncBalanceCards 导入
//   22~24 UI：列表徽标 / 详情控件 / 事件绑定与三个写面函数
//
// 说明：语法层（node --check）与真链路（set_group_card 实测）不在此脚本范围内。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UI_MEM = path.join(APP, 'ui', 'app', '05-memory-settings.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function readOf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

const mod = await import(new URL('file:///' + path.join(SRC, 'balance.js').replace(/\\/g, '/')).href);
const MARK = { marker: '@余额' };

// ── 1~5 数值规整 ────────────────────────────────────────────────────────────
ok('1 normalizeAmount 四舍五入到两位', mod.normalizeAmount('12.345') === 12.35, String(mod.normalizeAmount('12.345')));
ok('2 normalizeAmount 拒绝负数', Number.isNaN(mod.normalizeAmount(-1)));
ok('3 normalizeAmount 拒绝非数字', Number.isNaN(mod.normalizeAmount('abc')));
ok('4 formatAmount 补足两位', mod.formatAmount(12.3) === '12.30', mod.formatAmount(12.3));
ok('5 formatAmount 非法值给空串', mod.formatAmount(NaN) === '', mod.formatAmount(NaN));

// ── 6~10 剥 / 拼 ────────────────────────────────────────────────────────────
ok('6 balanceSuffix = marker + 两位小数', mod.balanceSuffix(MARK, 12.3) === '@余额12.30', mod.balanceSuffix(MARK, 12.3));
ok('7 strip 剥掉尾部旧后缀', mod.stripBalanceSuffix('R喵@余额12.00', '@余额') === 'R喵', mod.stripBalanceSuffix('R喵@余额12.00', '@余额'));
ok('8 strip 剥掉多重叠加', mod.stripBalanceSuffix('R喵@余额12.00@余额13.00', '@余额') === 'R喵', mod.stripBalanceSuffix('R喵@余额12.00@余额13.00', '@余额'));
ok('9 strip 不碰中间出现的 marker', mod.stripBalanceSuffix('余额宝@R喵', '@余额') === '余额宝@R喵');
ok('10 strip 只剩 marker 也能剥空', mod.stripBalanceSuffix('@余额', '@余额') === '');

// ── 11~14 目标名片 ──────────────────────────────────────────────────────────
ok('11 composeCard 保留原名 + 追加后缀', mod.composeCard('R喵', MARK, 12.3) === 'R喵@余额12.30', mod.composeCard('R喵', MARK, 12.3));
ok('12 composeCard 旧值替换不叠加', mod.composeCard('R喵@余额5.00', MARK, 13) === 'R喵@余额13.00', mod.composeCard('R喵@余额5.00', MARK, 13));
ok('13 composeCard 名片空 → 昵称兜底', mod.composeCard('', MARK, 13, 'R喵') === 'R喵@余额13.00', mod.composeCard('', MARK, 13, 'R喵'));
ok('14 composeCard 名片与昵称皆空 → 只剩后缀', mod.composeCard('', MARK, 13, '') === '@余额13.00');

// ── 15~16 余额取数（映射接口）──────────────────────────────────────────────
const manual = await mod.resolveBalance({ source: 'manual', value: '8.5', marker: '@余额' });
ok('15 resolveBalance manual 取数并规整', manual === 8.5, String(manual));
let threw = false;
try {
  await mod.resolveBalance({ source: 'http', endpoint: 'http://x', field: 'balance' });
} catch {
  threw = true;
}
ok('16 resolveBalance 未知来源抛错（不静默回落 0）', threw);

// ── 17 规则结构 ────────────────────────────────────────────────────────────
const rule = mod.balanceRule();
ok('17a rule.chats 是数组', Array.isArray(rule.chats));
ok('17b rule.marker 非空', typeof rule.marker === 'string' && rule.marker.length > 0);
ok('17c rule.intervalMs ≥ 60000', Number(rule.intervalMs) >= 60000, String(rule.intervalMs));

// ── 18~19 配置段 ───────────────────────────────────────────────────────────
const cfgSrc = readOf(path.join(SRC, 'config.js'));
ok('18a config.js 有 balance 默认段', /balance:\s*\{/.test(cfgSrc));
ok('18b 默认全关（chats 空数组）', /balance:\s*\{[\s\S]{0,120}?chats:\s*\[\s*\]/.test(cfgSrc));
ok('18c 默认值 0 · 来源 manual · 30 分钟', /balance:\s*\{[\s\S]{0,220}?value:\s*0[\s\S]{0,220}?intervalMs:\s*1800000/.test(cfgSrc));
ok('19 映射接口占位字段在位（source / endpoint / field）',
  /balance:\s*\{[\s\S]{0,260}?source:\s*'manual'[\s\S]{0,120}?endpoint:[\s\S]{0,120}?field:/.test(cfgSrc));

// ── 20 启动挂载 ────────────────────────────────────────────────────────────
const appSrc = readOf(path.join(SRC, 'app.js'));
ok('20a app.js 导入 startBalanceLoop', /import\s*\{\s*startBalanceLoop\s*\}\s*from\s*'\.\/balance\.js'/.test(appSrc));
ok('20b app.js 启动链调用 startBalanceLoop(onebot)', /startBalanceLoop\(onebot\)/.test(appSrc));

// ── 21 路由 ────────────────────────────────────────────────────────────────
const routesSrc = readOf(path.join(SRC, 'routes.js'));
ok('21a routes.js 导入 syncBalanceCards', /import\s*\{\s*syncBalanceCards\s*\}\s*from\s*'\.\/balance\.js'/.test(routesSrc));
ok('21b POST /api/balance/sync 路由在位', /pattern:\s*'\/api\/balance\/sync'/.test(routesSrc));

// ── 22~24 UI ───────────────────────────────────────────────────────────────
const uiSrc = readOf(UI_MEM);
ok('22 列表徽标（ui-list-badge）', uiSrc.includes('[qqbotb-balance:ui-list-badge]') && uiSrc.includes('balanceHtml'));
ok('23 详情控件三件（开关 / 输入框 / 刷新按钮）',
  uiSrc.includes('id="mem-balance-chk"') && uiSrc.includes('id="mem-balance-val"') && uiSrc.includes('id="mem-balance-sync"'));
ok('24 写面函数与绑定齐备',
  uiSrc.includes('async function toggleBalanceChat')
  && uiSrc.includes('async function setBalanceValue')
  && uiSrc.includes('async function syncBalanceNow')
  && uiSrc.includes("querySelector('#mem-balance-chk')")
  && uiSrc.includes('/api/balance/sync'));

// ── 汇总 ───────────────────────────────────────────────────────────────────
const total = pass + fails.length;
if (fails.length) {
  console.log(`FAIL ${pass}/${total}`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`ALL PASS ${pass}/${total}`);
}
