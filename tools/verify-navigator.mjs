// verify-navigator.mjs —— 领航员自测（状态机 / CH4 猫面 / 健康检查 / 回执渲染）
//
// 用法：node tools/verify-navigator.mjs
// 做什么：以真实模块 + 真实 CH4（8080 在跑）跑一遍——状态机落盘 / 猫群读取 / 单猫详情 / 健康检查 /
//   回执渲染 / 会话分析读全（合成帧 + 现场拉取）/ 轻通道闸门（放行例投到不存在的猫名——不打扰真猫）。
// 边界：不向真猫投递消息——投递的真链路验收走群内实测。

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

// ── 5b 关闭发群判据：哪里开启哪里回应、哪里退出哪里回应（Rushiera 2026-10-11）────
// 判据：群内退出（by=qq）→ 领航记录发到「退出那个群」；软件内退出 / 空闲自关（by=app）→ 静默。
// 群号用非数字串：发群走 mock onebot（只收集）；群记沉淀按「群号不可用」跳过（不污染真实群记）。
const closeChat = 'selftest';
await navIdem.close({ reason: 'manual', by: 'app' });
check('编排·软件内退出静默（不发群）', sent.length === 0, `发群次数 ${sent.length}`);

await navIdem.open({ by: 'app', chat: closeChat, receipt: false });
sent.length = 0;
await navIdem.close({ reason: 'manual', by: 'qq', chat: closeChat });
check('编排·群内退出发到退出那个群', sent.length === 1 && String(sent[0]?.params?.group_id) === closeChat,
  `发群 ${sent.length} 次 → ${sent[0]?.params?.group_id ?? '-'}`);

await navIdem.open({ by: 'qq', chat: closeChat, receipt: false });
sent.length = 0;
await navIdem.close({ reason: 'idle' });
check('编排·空闲自关发到最后指令群', sent.length === 1 && String(sent[0]?.params?.group_id) === closeChat,
  `发群 ${sent.length} 次 → ${sent[0]?.params?.group_id ?? '-'}`);

// 软件内开启、从未有群内指令 → 超时静默（新实例：activeChat 干净）
const sentIdle = [];
const navIdle = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-idle-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: { call: async (action, params) => { sentIdle.push({ action, params }); return {}; } }
});
await navIdle.open({ by: 'app', receipt: false });
sentIdle.length = 0;
await navIdle.close({ reason: 'idle' });
check('编排·无群内指令的超时静默', sentIdle.length === 0, `发群次数 ${sentIdle.length}`);
navIdle.stop();

// ── 6 会话分析：读全（think + 工具调用 + 直播态）（2026-10-11 / 2026-10-14）─────
// 判据：view 事件的 reason / toolcard / gap_text 块（persist.items · payload 形态）被收集；
//       live 临时区（thinksse / toolrun）入直播态；thinkText 直接读回；组装含工具调用行。
//       注：条目正文在生产形态里位于 item.payload（v0.45 首版误读 item.text——本版修正）。
const rfRow = cats.find((row) => row.running === true && Number(row.port) > 0)
  || cats.find((row) => Number(row.port) > 0)
  || cats[0];
const armed = await navIdem.armCat(rfRow);
check('会话分析·观测建立', !!armed && armed.key === String(rfRow.id), String(rfRow.id));
if (armed) {
  navIdem.collectThink(armed, { persist: { mode: 'full', items: [
    { type: 'user', ts: 1, payload: { text: '干活' } },
    { type: 'reason', ts: 2, payload: { text: '__selftest__ 先读索引。' } },
    { type: 'reason', ts: 3, payload: { text: '__selftest__ 落点定了。' } },
    { type: 'reason', ts: 3, payload: { text: '__selftest__ 落点定了。' } },
    { type: 'toolcard', ts: 4, payload: { name: 'text-read', arguments: '{"path":"__selftest__/a.md"}', result: '{"ok":true}', toolIndex: 1, toolTotal: 1 } },
    { type: 'gap_text', ts: 5, payload: { text: '__selftest__ 读完了。' } }
  ] } });
  check('会话分析·think 收集（payload 形态 + 去重）',
    armed.thinks.filter((row) => row.text === '__selftest__ 落点定了。').length === 1,
    `条数 ${armed.thinks.length}`);
  check('会话分析·工具卡收集',
    armed.tools.some((row) => row.name === 'text-read' && row.args.includes('__selftest__')),
    `条数 ${armed.tools.length}`);
  check('会话分析·旁白收集',
    armed.gaps.some((row) => row.text === '__selftest__ 读完了。'),
    `条数 ${armed.gaps.length}`);
  navIdem.collectThink(armed, { live: { type: 'thinksse', context: '__selftest__ 正在想……' } });
  check('会话分析·直播态（thinksse）', String(armed.liveThink?.text ?? '').includes('__selftest__'), '');
  const got = navIdem.thinkText(armed.key);
  check('会话分析·直接读 think',
    got.includes('__selftest__ 先读索引') && got.includes('__selftest__ 落点定了'),
    got.replace(/\n/g, ' ').slice(0, 60));
  check('会话分析·非 reason 不入', !got.includes('干活'));
  const digest = navIdem.digestFromView([
    { type: 'reason', ts: 6, payload: { text: '__selftest__ 组装甲' } },
    { type: 'toolcard', ts: 7, payload: { name: 'powershell', arguments: '{"command":"__selftest__ node x"}', result: 'ERR|__selftest__ 失败', toolIndex: 1, toolTotal: 1 } }
  ], { type: 'toolrun', context: '[{"name":"text-grep","arguments":"{\\"keyword\\":\\"__selftest__\\"}"}]' });
  const composed = navIdem.composeActivity(digest);
  check('会话分析·读全组装（think + 工具 + 进行中）',
    composed.includes('__selftest__ 组装甲') && composed.includes('powershell') && composed.includes('✗') && composed.includes('text-grep'),
    composed.replace(/\n/g, ' | ').slice(0, 90));
  navIdem.disarmAll();
}

navIdem.stop();

// ── 7 轻通道：未开启模式的投递闸门（Rushiera 2026-10-14）────────────────────
// 判据：未开启 + 无新鲜 VIP → 不受理（offMode）；未开启 + 本人新鲜 VIP @ → 放行（闸门过，
//       交付面失败不算闸门失败）；非 qq 通道一律不受理。
let vipHandler = null;
const navLight = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-light-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: {
    call: async () => ({}),
    onEvent: (fn) => { vipHandler = fn; },
    status: () => ({ self: { userId: 2405997337 } })
  }
});
const rej1 = await navLight.send({ key: 'majordomo', text: '自测', by: 'qq' });
check('轻通道·未开启且无 VIP → 不受理', rej1.ok === false && rej1.offMode === true, String(rej1.error ?? ''));
if (typeof vipHandler === 'function') {
  vipHandler({
    post_type: 'message', message_type: 'group', user_id: '569145850', group_id: '940257985',
    message: [{ type: 'at', data: { qq: '2405997337' } }], raw_message: '@Shieraru 自测'
  });
}
const pass = await navLight.send({ key: 'no-such-cat-selftest', text: '自测', by: 'qq' });
check('轻通道·未开启 + 新鲜 VIP → 放行（非 offMode）', pass.offMode !== true, JSON.stringify(pass).slice(0, 90));
const rej2 = await navLight.send({ key: 'majordomo', text: '自测' });
check('轻通道·非 qq 通道不受理', rej2.ok === false && rej2.offMode === true, String(rej2.error ?? ''));
navLight.stop();

// ── 8 轻通道：回复观测的登记与撤除（Rushiera 2026-10-14）────────────────────
const navWatch = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-watch-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: { call: async () => ({}), status: () => ({ self: { userId: 2405997337 } }) }
});
navWatch.armLightWatch('majordomo', 'selftest');
check('轻通道·回复观测登记', navWatch.lightWatches.has('majordomo'), '');
navWatch.cancelLightWatch('majordomo');
check('轻通道·回复观测撤除', !navWatch.lightWatches.has('majordomo'), '');
navWatch.stop();

// ── 9 现场拉取：一次 SSE 取整幅视图（Rushiera 2026-10-14）──────────────────
const navPull = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-pull-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: { call: async () => ({}), status: () => ({ self: { userId: 2405997337 } }) }
});
const pull = await navPull.pullCatView('majordomo');
check('现场拉取·取到整幅视图', !!pull && Array.isArray(pull.items), pull ? `items=${pull.items.length} live=${pull.live?.type ?? 'null'}` : 'null');
navPull.stop();

// ── 10 nav_reset 带 text：参数不吞 + 源码投递段在位（Rushiera 2026-10-14）────
// 判据：API 面回执回显 text（证明入口没丢参数）；源码面存在「接上之后投递用户原话」这一段
//       （真投递涉真猫与几分钟等待——不进自测，验收走群内实测）。
const navReset = createNavigator({
  log,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-reset-')),
  config: { navigator: { mainPort: 8080, vipUser: '569145850', services: [] } },
  onebot: { call: async () => ({}), status: () => ({ self: { userId: 2405997337 } }) }
});
const resetBody = await navReset.api['POST /api/nav/reset']({ body: { key: 'no-such-cat-selftest', text: '__selftest__ 告诉他 Y' } });
check('nav_reset·带 text 回执回显', resetBody?.body?.text === '__selftest__ 告诉他 Y', JSON.stringify(resetBody?.body ?? {}).slice(0, 90));
const resetSrc = fs.readFileSync(path.join(HERE, '..', 'app', 'src', 'navigator', 'index.js'), 'utf8');
check('nav_reset·源码投递段在位', resetSrc.includes('ch4.send(resolved, userText)') && resetSrc.includes('用户原话已投递'));
navReset.stop();

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
