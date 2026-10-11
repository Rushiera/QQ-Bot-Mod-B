// verify-comfy.mjs —— 图像编辑（ComfyDock「[生成]」工作区）自测
//
// 用法：
//   node tools/verify-comfy.mjs                                  守门自测（不提交、不花额度）
//   node tools/verify-comfy.mjs --live [--image <路径>] [--prompt-file <UTF-8 文本>]
//                                                                真链路（提交一张图，出图走 mock 出站）
//
// 边界：`--live` 会真花一次云端额度——默认不跑。提示词走 `--prompt-file` 读文件，
//       不经命令行传中文（PS 5.1 会把非 ASCII 参数按 ANSI 转码成乱码，判例 CHANGELOG v0.47）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNavigator } from '../app/src/navigator/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes('--live');
const ENDPOINT = 'http://127.0.0.1:8971';
const VIP = '569145850';
const SELF = 2405997337;

/**
 * 取命令行参数值。
 *
 * @param {string} name 参数名
 * @returns {string} 参数值（缺省空串）
 */
function argOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '') : '';
}

const IMAGE = argOf('--image') || 'D:\\Mau\\WorkSpace\\ComfyDock\\out\\gen\\41.png';
const PROMPT_FILE = argOf('--prompt-file');
const PROMPT = PROMPT_FILE
  ? fs.readFileSync(PROMPT_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  : '把这张图片做成三视图';
const LIVE_LOG = path.join(HERE, '..', 'CatTemp', 'comfy-live.log');

const results = [];
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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

/**
 * 造一个领航员实例（mock OneBot：只收集调用，不真发；可灌 VIP 事件）。
 *
 * @param {object} conf comfy 配置
 * @param {string} [cacheFile] `get_image` 返回的协议端缓存路径（空=不返回）
 * @returns {object} { nav, sent, fire }
 */
function makeNav(conf, cacheFile = '') {
  const sent = [];
  const listeners = new Set();
  const onebot = {
    call: async (action, params) => {
      sent.push({ action, params });
      if (action === 'get_image') return cacheFile ? { file: cacheFile } : {};
      return {};
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: () => ({ self: { userId: SELF, nickname: 'R喵' } })
  };
  const nav = createNavigator({
    log,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nav-comfy-')),
    config: { navigator: { mainPort: 8080, vipUser: VIP, services: [], comfy: conf } },
    onebot
  });
  /** 灌一条 VIP 群消息（模拟真人在群里 @ 本 bot）。 */
  const fire = (chat) => {
    const payload = {
      post_type: 'message',
      message_type: 'group',
      user_id: VIP,
      group_id: String(chat),
      raw_message: '@R喵 帮我改图',
      message: [{ type: 'at', data: { qq: String(SELF) } }]
    };
    for (const fn of listeners) fn(payload);
  };
  return { nav, sent, fire };
}

// ── 1 接口面 ────────────────────────────────────────────────────────────────
const guard = makeNav({ endpoint: ENDPOINT, workspaceId: 'gen' });
check('接口面·editImage / comfy.online 可用',
  typeof guard.nav.editImage === 'function' && typeof guard.nav.comfy?.online === 'function');

// ── 2 前置·领航员未开启 → 不受理 ────────────────────────────────────────────
const offMode = await guard.nav.editImage({ chat: 'selftest', prompt: '改个图', image: IMAGE });
check('前置·未开启不受理（offMode）', offMode.ok === false && offMode.offMode === true, offMode.error || '');

await guard.nav.open({ by: 'app', chat: 'selftest', receipt: false });

// ── 3 空提示词 → 报错退出 ───────────────────────────────────────────────────
const noPrompt = await guard.nav.editImage({ chat: 'selftest', prompt: '  ', image: IMAGE });
check('入参·空提示词报错退出', noPrompt.ok === false && noPrompt.error.includes('提示词'), noPrompt.error || '');

// ── 4 请求者闸：群内触发 + 无新鲜 VIP 群消息 → 不受理 ───────────────────────
const vipGate = await guard.nav.editImage({ by: 'qq', chat: 'selftest', prompt: '改个图', image: IMAGE });
check('请求者闸·群内非 VIP 触发不受理', vipGate.ok === false && vipGate.vipOnly === true, vipGate.error || '');

// ── 4b 操作者通道（应用内 / 本地 API）不受请求者闸约束 ──────────────────────
const operator = await guard.nav.editImage({ chat: 'selftest', prompt: '改个图', image: 'Z:\\__not_exist__.png' });
check('请求者闸·操作者通道不受限（转取图失败）',
  operator.ok === false && String(operator.error).includes('取图失败'), operator.error || '');

// ── 5 请求者闸：VIP 在别的群 @ 过 → 本群不受理（防蹭）────────────────────────
guard.fire('other-group');
const crossGroup = await guard.nav.editImage({ by: 'qq', chat: 'selftest', prompt: '改个图', image: IMAGE });
check('请求者闸·VIP 消息非同群不受理', crossGroup.ok === false && crossGroup.vipOnly === true, crossGroup.error || '');

// ── 6 请求者闸：本群 VIP @ 后放行（走到取图 / 提交那一步）────────────────────
guard.fire('selftest');
const passed = await guard.nav.editImage({ by: 'qq', chat: 'selftest', prompt: '改个图', image: 'Z:\\__not_exist__.png' });
check('请求者闸·本群 VIP @ 后放行（转取图失败）',
  passed.ok === false && String(passed.error).includes('取图失败'), passed.error || '');

// ── 7 前置·ComfyDock 离线 → 不受理 ─────────────────────────────────────────
const offline = makeNav({ endpoint: 'http://127.0.0.1:9', workspaceId: 'gen' });
await offline.nav.open({ by: 'app', chat: 'selftest', receipt: false });
offline.fire('selftest');
const offResult = await offline.nav.editImage({ by: 'qq', chat: 'selftest', prompt: '改个图', image: IMAGE });
check('前置·ComfyDock 离线不受理', offResult.ok === false && offResult.error.includes('离线'), offResult.error || '');

// ── 8 前置·ComfyDock 在线（真机探测，要求它在跑）────────────────────────────
const online = await guard.nav.comfy.online();
check('前置·ComfyDock 在线（真机探测）', online.online === true, online.detail);
if (online.online) {
  const noImage = await guard.nav.editImage({ chat: 'selftest', prompt: '改个图', image: 'Z:\\__not_exist__.png' });
  check('取图·本地路径不在即报错', noImage.ok === false && noImage.error.includes('取图失败'), noImage.error || '');
}

// ── 9 真链路（--live）：群图路径 → 提交 → 轮询 → 出图（mock 出站）────────────
if (LIVE) {
  console.log(`\n—— 真链路：${IMAGE}\n   提示词：${PROMPT}\n   落盘日志：${LIVE_LOG} ——\n`);
  const { nav, sent, fire } = makeNav({ endpoint: ENDPOINT, workspaceId: 'gen', pollMs: 5000, timeoutMs: 10 * 60 * 1000 }, IMAGE);
  await nav.open({ by: 'app', chat: 'selftest', receipt: false });
  fire('selftest');
  const started = Date.now();
  // 群图路径：只给 file（协议端缓存名），由 mock 的 get_image 指到真图片——走 materialize 的缓存分支
  const submitted = await nav.editImage({ by: 'qq', chat: 'selftest', prompt: PROMPT, file: 'selftest-cache.png' });
  check('真链路·提交受理', submitted.ok === true, submitted.error || `任务 ${submitted.taskId}`);
  fs.mkdirSync(path.dirname(LIVE_LOG), { recursive: true });
  let imageMsg = null;
  const seen = new Set();
  while (submitted.ok && Date.now() - started < 11 * 60 * 1000 && !imageMsg) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const snap = await nav.status();
    for (const item of snap.activity ?? []) {
      const line = `[${item.kind}] ${item.text}`;
      if (seen.has(line)) continue;
      seen.add(line);
      fs.appendFileSync(LIVE_LOG, `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}\n`, 'utf8');
      console.log(`   ${line}`);
    }
    imageMsg = sent.find((row) => row.action === 'send_group_msg'
      && Array.isArray(row.params?.message)
      && row.params.message.some((seg) => seg?.type === 'image')) ?? null;
  }
  if (imageMsg) {
    const file = String(imageMsg.params.message.find((seg) => seg.type === 'image')?.data?.file ?? '');
    const local = file.replace(/^file:\/\/\//, '');
    check('真链路·出图发群（mock 出站）', fs.existsSync(local), local);
    console.log(`   用时：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  } else {
    check('真链路·出图发群（mock 出站）', false, submitted.ok ? '等待超时，未收到出站' : '提交未受理');
  }
  nav.stop();
}

// 收工前撤订——留着在途订阅 / 定时器会让进程退出时报 libuv 断言（自测退出码失真）；
// 撤订后留一拍让 undici 的连接收尾落定，再退出。
guard.nav.stop();
offline.nav.stop();
await new Promise((resolve) => setTimeout(resolve, 500));

const passCount = results.filter((r) => r.ok).length;
console.log(`\n结果：${passCount}/${results.length} 通过`);
process.exit(passCount === results.length ? 0 : 1);
