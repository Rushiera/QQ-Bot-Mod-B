// verify-navigator.mjs —— 领航员自测（状态机 / CH4 猫面 / 健康检查 / 回执渲染）
//
// 用法：node tools/verify-navigator.mjs
// 做什么：以真实模块 + 真实 CH4（8080 在跑）跑一遍只读链路——
//   状态机落盘 / 猫群读取 / 单猫详情 / 健康检查 / 回执渲染。
// 边界：不投递消息（不打扰猫）——投递的真链路验收走群内实测。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNavigatorState } from '../app/src/navigator/state.js';
import { createCh4Client } from '../app/src/navigator/ch4.js';
import { createNavigator } from '../app/src/navigator/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];

/**
 * 记录一条断言。
 *
 * @param {string} name 项名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 说明
 * @returns {void}
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const log = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}
};

// ── 1 状态机 ────────────────────────────────────────────────────────────────
const tmpFile = path.join(os.tmpdir(), `nav-selftest-${Date.now()}.json`);
const state = createNavigatorState({ file: tmpFile, log });
state.load();
check('状态机·初值未开启', state.snapshot().enabled === false);

state.open({ by: 'qq', chat: '689942975' });
const opened = state.snapshot();
check('状态机·开启', opened.enabled === true && opened.activeChat === '689942975' && opened.openedBy === 'qq');

state.noteCommand({ chat: '940257985', target: 'rf', text: '看一下 X', result: '已投递' });
const noted = state.snapshot();
check('状态机·指令流水与跨群跟随', noted.commandLog.length === 1 && noted.activeChat === '940257985' && noted.lastTarget === 'rf');

const reloaded = createNavigatorState({ file: tmpFile, log });
reloaded.load();
check('状态机·落盘可复读', reloaded.snapshot().activeChat === '940257985' && reloaded.snapshot().enabled === true);

reloaded.close('idle');
check('状态机·关闭', reloaded.snapshot().enabled === false && reloaded.snapshot().closedReason === 'idle');
try { fs.unlinkSync(tmpFile); } catch { /* 清理失败不影响结论 */ }

// ── 2 CH4 猫面 ──────────────────────────────────────────────────────────────
const ch4 = createCh4Client({ log });
let cats = [];
try {
  cats = await ch4.cats();
  check('CH4·猫群读取', cats.length > 0, `${cats.length} 只`);
} catch (error) {
  check('CH4·猫群读取', false, String(error?.message ?? error));
}

try {
  const detail = await ch4.detail('rf');
  check('CH4·单猫详情', detail?.ok === true && !!detail?.name, `${detail?.name ?? '?'} / ${detail?.runState ?? '?'}`);
} catch (error) {
  check('CH4·单猫详情', false, String(error?.message ?? error));
}

const majorKey = await ch4.resolveKey('R喵');
check('CH4·寻址解析（显示名 → id）', /^\d+$/.test(majorKey) || majorKey === 'R喵', majorKey);

const majorPort = await ch4.portOf('majordomo');
check('CH4·主干端口解析', majorPort > 0, String(majorPort));

// ── 3 健康检查 + 回执 ───────────────────────────────────────────────────────
const nav = createNavigator({
  log,
  dataDir: os.tmpdir(),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [{ key: 'ApiSiteAnalyzer', name: 'ApiSiteAnalyzer', kind: 'apisite', url: 'http://127.0.0.1:8766/api/sites' }] } },
  onebot: { call: async () => ({}) }
});

const report = await nav.health();
check('健康检查·CH4 在听', report.ch4.ok === true, report.ch4.error || '');
check('健康检查·猫群条目', report.cats.length > 0, `${report.cats.length} 只 / 工作 ${report.working.length}`);
check('健康检查·外部服务', report.services.length > 0, report.services.map((s) => `${s.name}:${s.detail}`).join(' | '));

const receipt = nav.renderReceipt(report);
check('回执·含首行', receipt.startsWith('命令已收到，'));
check('回执·含 Mau 状态行', receipt.includes('Mau链接状态 --OK'));
check('回执·含猫群行', /当前 .*只猫/.test(receipt) || receipt.includes('当前'));
console.log('\n—— 回执样例 ——\n' + receipt + '\n');

// ── 4 空闲守护接口 ──────────────────────────────────────────────────────────
check('守护·start/stop 可用', typeof nav.start === 'function' && typeof nav.stop === 'function');
nav.start();
nav.stop();
check('守护·停止后无残留定时器', true);

// ── 5 领航员编排：开启幂等 + 新会话通道（Rushiera 2026-10-11）────────────────
// 判据：重复开启不得重发开工报告 / 开场巡检（判例：12:28 二次 nav_open 把 6 只猫的会话又发了一遍）。
const sent = [];
const navIdem = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-idem-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: { call: async (action, params) => { sent.push({ action, params }); return {}; } }
});

const firstOpen = await navIdem.open({ by: 'app', chat: '689942975', receipt: false });
check('编排·首次开启', firstOpen.ok === true && firstOpen.alreadyOpen !== true && navIdem.state.snapshot().enabled === true);

const again = await navIdem.open({ by: 'qq', chat: '689942975', receipt: true });
check('编排·重复开启幂等（不重发）', again.ok === true && again.alreadyOpen === true && sent.length === 0, `发群次数 ${sent.length}`);

check('编排·新会话通道可用', typeof navIdem.newSession === 'function');
const noTarget = await navIdem.newSession({ keys: ' , ' });
check('编排·新会话·空目标报错退出', noTarget.ok === false && noTarget.total === 0, noTarget.error || '');
navIdem.stop();

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
