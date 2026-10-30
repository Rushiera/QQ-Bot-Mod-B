// verify-ingress.mjs —— 群消息接入与分流（N6 第二刀）自测
//
// 用法：node tools/verify-ingress.mjs
// 边界：纯本地——不连 WS、不发群、不碰真实 data（写临时目录）。
// 覆盖：shadow 零行为 · live 只认 VIP · 带图缓冲（mid 命中 / 最近一条）· 采集行落盘 ·
//       各 action 分发到正确回调 · 状态统计。
//
// 口径来源：reports/R3-L8.md §二 #2/#10 · design-qqbotb-navigator.md §十二。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIngress, textOf, imageOf } from '../app/src/navigator/ingress.js';
import { createIntentService } from '../app/src/navigator/intent.js';

let pass = 0;
let fail = 0;

/**
 * 断言。
 *
 * @param {string} name 用例名
 * @param {boolean} cond 条件
 * @param {string} [detail] 失败细节
 * @returns {void}
 */
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const noopLog = { info() {}, warn() {}, error() {} };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbotb-ingress-'));
const VIP = '569145850';

/** 造一条群消息事件。 */
function msg(text, { user = VIP, chat = '123456', mid = '1', image = null } = {}) {
  const message = [];
  if (image) message.push({ type: 'image', data: { url: image, file: '' } });
  if (text) message.push({ type: 'text', data: { text } });
  return { post_type: 'message', message_type: 'group', group_id: chat, user_id: user, message_id: mid, message, raw_message: text };
}

/**
 * 造一个接入实例（收集回调调用）。
 *
 * @param {string} mode shadow / live
 * @param {Array<string>} [allow] live 下放行的动作类（缺省 = 全放行）
 * @returns {object} { ingress, calls, intent }
 */
function makeIngress(mode, allow = []) {
  const calls = [];
  const intent = createIntentService({ log: noopLog, config: {} });
  const ingress = createIngress({
    log: noopLog,
    dataDir: tmpDir,
    config: { navigator: { vipUser: VIP, ingress: { mode, allow } } },
    intent,
    handlers: {
      isEnabled: () => true,
      switch: async (a) => calls.push(['switch', a]),
      readonly: async (a) => calls.push(['readonly', a]),
      generate: async (a) => calls.push(['generate', a]),
      session: async (a) => calls.push(['session', a]),
      send: async (a) => calls.push(['send', a])
    }
  });
  return { ingress, calls, intent };
}

console.log('\n一、消息段解析');
check('textOf 只取 text 段', textOf([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: '你好' } }]) === '你好');
check('textOf 多段拼接', textOf([{ type: 'text', data: { text: 'a' } }, { type: 'text', data: { text: 'b' } }]) === 'ab');
check('imageOf 取 url', imageOf([{ type: 'image', data: { url: 'http://x/1.png', file: '' } }])?.url === 'http://x/1.png');
check('imageOf 取 file', imageOf([{ type: 'image', data: { url: '', file: 'abc.image' } }])?.file === 'abc.image');
check('imageOf 无图返回 null', imageOf([{ type: 'text', data: { text: 'x' } }]) === null);

console.log('\n二、shadow 模式零行为');
{
  const { ingress, calls } = makeIngress('shadow');
  await ingress.handleMessage(msg('跟R喵说，上工qqbotb'), { atMe: true });
  await ingress.handleMessage(msg('把这张图做成三视图', { image: 'http://x/a.png' }), { atMe: true });
  await ingress.handleMessage(msg('回执'), { atMe: true });
  check('shadow 不触发任何回调', calls.length === 0, `实际 ${calls.length}`);
  const st = ingress.status();
  check('shadow 记 seen=3', st.seen === 3, `实际 ${st.seen}`);
  check('shadow 计数 shadow=3 / live=0', st.shadow === 3 && st.live === 0, `${st.shadow}/${st.live}`);
  check('shadow 落采集行', (() => {
    // 日期键必须按**本地**时区算：ingress 落盘用本地 dayKey，
    // 而 `toISOString().slice(0,10)` 是 UTC 日期——跨零点（本地 00:04 = UTC 前一日）会找错文件。
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const file = path.join(tmpDir, 'metrics', `intent-${key}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().split('\n').length >= 3;
  })());
}

console.log('\n三、live 模式分发');
{
  const { ingress, calls } = makeIngress('live');
  await ingress.handleMessage(msg('跟R喵说，上工qqbotb'), { atMe: true });
  check('投递 → send 回调', calls.at(-1)?.[0] === 'send', String(calls.at(-1)?.[0]));
  check('投递目标 = R喵', calls.at(-1)?.[1]?.key === 'R喵', calls.at(-1)?.[1]?.key);

  await ingress.handleMessage(msg('打开领航员'), { atMe: true });
  check('开关 → switch 回调', calls.at(-1)?.[0] === 'switch' && calls.at(-1)?.[1]?.action === 'open',
    JSON.stringify(calls.at(-1)?.[1]));

  await ingress.handleMessage(msg('截一下 rb 的会话'), { atMe: true });
  check('截图 → readonly/shot', calls.at(-1)?.[0] === 'readonly' && calls.at(-1)?.[1]?.action === 'shot',
    JSON.stringify(calls.at(-1)?.[1]));

  await ingress.handleMessage(msg('念一下上面图片里的内容', { mid: '9', image: 'http://x/9.png' }), { atMe: true });
  check('生成 → generate 回调', calls.at(-1)?.[0] === 'generate', String(calls.at(-1)?.[0]));

  const before = calls.length;
  await ingress.handleMessage(msg('今天天气不错'), { atMe: false });
  check('闲聊不触发回调', calls.length === before, `新增 ${calls.length - before}`);

  const before2 = calls.length;
  await ingress.handleMessage(msg('跟R喵说，上工qqbotb', { user: '999' }), { atMe: true });
  check('非 VIP 的派活不执行', calls.length === before2, `新增 ${calls.length - before2}`);
}

console.log('\n四、带图缓冲（pickImageOf 依赖）');
{
  const { ingress } = makeIngress('shadow');
  await ingress.handleMessage(msg('图一', { chat: '777', mid: '11', image: 'http://x/11.png' }), {});
  await ingress.handleMessage(msg('图二', { chat: '777', mid: '12', image: 'http://x/12.png' }), {});
  await ingress.handleMessage(msg('无图', { chat: '777', mid: '13' }), {});
  check('最近带图 = 最后一条带图', ingress.recentImage('777')?.image?.url === 'http://x/12.png',
    ingress.recentImage('777')?.image?.url);
  check('按 mid 精确命中', ingress.recentImage('777', '11')?.image?.url === 'http://x/11.png',
    ingress.recentImage('777', '11')?.image?.url);
  check('mid 未命中回落最近一条', ingress.recentImage('777', '999')?.image?.url === 'http://x/12.png');
  check('无图群返回 null', ingress.recentImage('888') === null);
  check('群隔离（777 与 888 不串）', ingress.recentImage('888', '11') === null);
}

console.log('\n五、接入口径');
{
  const { ingress } = makeIngress('shadow');
  const r = await ingress.handleMessage({ post_type: 'notice', message_type: 'group', group_id: '1' }, {});
  check('非 message 事件返回 null', r === null);
  const r2 = await ingress.handleMessage({ post_type: 'message', message_type: 'private', user_id: VIP, message: [] }, {});
  check('私聊不进群接入', r2 === null);
  check('模式字段可读', ingress.mode === 'shadow', ingress.mode);
}

console.log('\n六、会话操作（清会话 / 前文整理重启）');
{
  const { ingress, calls } = makeIngress('live');
  await ingress.handleMessage(msg('清掉 R喵的会话'), { atMe: true });
  check('清会话 → session/new', calls.at(-1)?.[0] === 'session' && calls.at(-1)?.[1]?.session === 'new',
    JSON.stringify(calls.at(-1)?.[1]));
  check('清会话目标 = R喵', calls.at(-1)?.[1]?.key === 'R喵', calls.at(-1)?.[1]?.key);

  await ingress.handleMessage(msg('清理一下 rb 的前文，然后让工作继续'), { atMe: true });
  check('前文整理 → session/reset', calls.at(-1)?.[0] === 'session' && calls.at(-1)?.[1]?.session === 'reset',
    JSON.stringify(calls.at(-1)?.[1]));

  await ingress.handleMessage(msg('重建 majordomo 的前文，告诉他 继续查群bot领航员前文'), { atMe: true });
  check('带原话：只取「告诉他」之后', calls.at(-1)?.[1]?.text === '继续查群bot领航员前文',
    JSON.stringify(calls.at(-1)?.[1]?.text));
}

console.log('\n七、渐进切换（allow 白名单）');
{
  const only = makeIngress('live', ['readonly', 'shot']);
  await only.ingress.handleMessage(msg('回执'), { atMe: true });
  check('清单内 readonly 放行', only.calls.at(-1)?.[0] === 'readonly', JSON.stringify(only.calls.at(-1)));
  const before = only.calls.length;
  await only.ingress.handleMessage(msg('跟R喵说，上工qqbotb'), { atMe: true });
  check('清单外 send 被拦', only.calls.length === before, `新增 ${only.calls.length - before}`);
  check('被拦计入 skipped', only.ingress.status().skipped > 0, String(only.ingress.status().skipped));
  check('allow 在状态里可读', JSON.stringify(only.ingress.status().allow) === '["readonly","shot"]',
    JSON.stringify(only.ingress.status().allow));

  const all = makeIngress('live');
  await all.ingress.handleMessage(msg('跟R喵说，上工qqbotb'), { atMe: true });
  check('空清单 = 全放行', all.calls.at(-1)?.[0] === 'send', String(all.calls.at(-1)?.[0]));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
process.exit(fail === 0 ? 0 : 1);
