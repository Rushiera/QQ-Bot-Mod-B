// verify-qqagent-boot.mjs — 冒烟：用当前配置起一次业务面内核（无窗口）再退出
//
// 用法：node tools/verify-qqagent-boot.mjs
//        node tools/verify-qqagent-boot.mjs --require-live                  # 禁止 SKIP，锁被占也当失败
//        （等价环境变量 QB_VERIFY_REQUIRE_LIVE=1——给不便传参的批处理场景）
//        node tools/verify-qqagent-boot.mjs --data-dir D:/x/data            # 换数据根（不碰生产实例）
//        （等价环境变量 QQ_AGENT_DATA_DIR——环境变量优先，参数只是命令行入口）
// 做什么：createApp → start（内核 + HTTP，不开窗口）→ 立刻暂停编排器（不处理任何消息）
//         → 查 /api/sessions 与 /api/prompt-preview → 打印摘要 → stop
// 判据：依赖齐备（ws / js-yaml）+ 配置能加载（前文 / 端点 / 白名单）+ 启动会话在会话列表里可见
//
// 失败口径（禁静默）：缺依赖 / 模块加载失败 / start() 抛错 / port 为空 → 具名错误 + exit 1，
// 不把 `ERR_MODULE_NOT_FOUND` 的原始栈丢给读者——栈里看不出"少了哪个包、该在哪装"。
//
// 环境面出口（R6-L5 · 显式 SKIP 而非 FAIL）：业务面在跑时单实例锁拒绝第二次启动——那是
//   「环境占用」不是「代码回归」，判 FAIL 会让守门档长期红一条与改动无关的线。故：
//   · 锁被活进程占着 → 打印 `SKIP: 单实例锁被占用（PID nnn）` + 解锁跑法，退出码 0（不计红）；
//   · 锁是残留（进程已死）或没锁 → 照常真跑，不打折。
//   防掩盖：SKIP 只在「锁解析到的 PID 确实活着」时给出，PID 一并打印；要强制真跑加
//   `QB_VERIFY_REQUIRE_LIVE=1`（此时锁被占按 FAIL 计）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
/**
 * 取命令行参数值（`--name value` 与 `--name=value` 两种形态都认）。
 *
 * @param {string} name 参数名（含前导 --）
 * @returns {string} 值；未给出返回空串
 */
function argValue(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
}
// 数据根：默认 D4 生产根（`_unpack/data`，本档只读不写）；可用 --data-dir / QQ_AGENT_DATA_DIR 覆盖。
// 覆盖的用途是「不碰生产实例也能真跑一次」——起一个带自有 config.json 的临时数据根（无锁、独立端口）
// 即可完成真验，不必停业务面。此前脚本无条件把生产根写进 env，覆盖入口不存在。
const DATA = path.resolve(argValue('--data-dir') || String(process.env.QQ_AGENT_DATA_DIR || '').trim()
  || path.resolve(HERE, '..', '_unpack', 'data'));

/**
 * 打印具名错误并退出（非 0）。
 *
 * @param {string} reason 失败结论（一行）
 * @param {string} [hint] 修法提示
 * @returns {never} 不返回
 */
function fail(reason, hint) {
  console.error(`[verify-boot] FAIL ${reason}`);
  if (hint) console.error(`[verify-boot] 修法：${hint}`);
  process.exit(1);
}

// ── ① 依赖预检 ────────────────────────────────────────────────────────────────
// 业务面在 import 期就会解析这些包（app/src/business/onebot.js → 'ws'，providers.js → 'js-yaml'），
// 缺一个整条 import 链就崩，且崩在静态解析阶段（错误点看不出是依赖问题）。先自证齐备。
const REQUIRED_DEPS = ['ws', 'js-yaml'];
const deps = [
  { name: 'ws', where: 'app/src/business/onebot.js · cdp-browser.js' },
  { name: 'js-yaml', where: 'app/src/business/providers.js' }
];
const fromApp = createRequire(path.join(APP, 'package.json'));
const missing = [];
for (const dep of REQUIRED_DEPS) {
  try {
    fromApp.resolve(dep);
  } catch {
    const meta = deps.find((d) => d.name === dep);
    missing.push(`${dep}（被 ${meta?.where ?? '业务面'} 引用）`);
  }
}
if (missing.length) {
  fail(`缺少依赖：${missing.join(' · ')}`, `在 ${APP} 下执行 npm install；缺的包须先写进 app/package.json 的 dependencies 才能装上（版本对齐 _unpack/resources/app/package.json:11-15）`);
}
if (!fs.existsSync(path.join(BIZ, 'app.js'))) {
  fail(`业务面入口不存在：${path.join(BIZ, 'app.js')}`, '确认 R2 归位（app/src/business/）已完成');
}

// ── ② 加载业务面入口（D4 数据根先注入） ────────────────────────────────────────
process.env.QQ_AGENT_DATA_DIR = DATA;

let createApp;
try {
  ({ createApp } = await import(pathToFileURL(path.join(BIZ, 'app.js')).href));
} catch (error) {
  const code = error?.code ?? 'ERR_IMPORT';
  const msg = String(error?.message ?? error);
  const missingSpec = /Cannot find (?:package|module) '([^']+)'/.exec(msg)?.[1] ?? '';
  if (missingSpec) {
    // 裸包名（ws / js-yaml）= 依赖没装；以 . 开头或含盘符 = 业务面源码缺文件（补搬未完成）
    const isPath = missingSpec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(missingSpec) || missingSpec.includes('/');
    if (isPath) {
      fail(`业务面源码缺文件：${missingSpec}`, '该模块尚未搬进 app/src/business/（补搬未完成）——查 tasks/R3.md §L1');
    }
    fail(`业务面加载时缺依赖：${missingSpec}`, `在 ${APP} 下 npm install；若该包未在 app/package.json 的 dependencies 声明，先补声明（对齐 _unpack/resources/app/package.json:11-15）`);
  }
  fail(`业务面 app.js 加载失败（${code}）`, msg);
}
if (typeof createApp !== 'function') {
  fail('业务面 app.js 未导出 createApp 函数', '核对 app/src/business/app.js 的导出面（应 export function createApp）');
}

// ── ③ 起内核（失败即 exit 1，不静默） ─────────────────────────────────────────
const LOCK_FILE = path.join(DATA, 'qq-agent.lock');
/** 环境面出口总开关：开时锁被占按 FAIL 计（CI / 合龙后强制真验）。 */
const REQUIRE_LIVE = process.env.QB_VERIFY_REQUIRE_LIVE === '1' || process.argv.includes('--require-live');

/**
 * 探活一个 PID（Windows / POSIX 通用：signal 0 只探测不杀）。
 *
 * @param {number} pid 进程号
 * @returns {boolean} 是否活着
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 读单实例锁的占用方 PID（不存在 / 读不出 / 空 → 0）。
 *
 * @returns {number} 锁内 PID；无锁返回 0
 */
function lockPid() {
  try {
    return Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * 环境面出口：锁被活进程占着时打印 `SKIP` 并以 0 退出（不冒充通过，也不判红）。
 *
 * @param {string} stage 检测点（`pre-start` / `start-throw`），供日志定位
 * @param {number} pid 占用方 PID
 * @returns {never} 不返回
 */
function skipLocked(stage, pid) {
  // 同步写 fd 1 再退出：Windows 下 stdout 是管道时 process.exit 会截断未刷出的缓冲
  // （实测首版即因此退 0 但零输出）。fs.writeSync 落盘即已写出，exit 不再丢内容。
  const text = `${JSON.stringify({
    ok: true,
    skipped: true,
    reason: `SKIP: 单实例锁被占用（PID ${pid}）`,
    stage,
    lockFile: LOCK_FILE,
    howToReallyRun: `换数据根真跑：node tools/verify-qqagent-boot.mjs --data-dir <dir>；或停掉 PID ${pid} 后重跑；或加 --require-live 让锁被占按 FAIL 计`,
    note: '环境占用非代码回归——锁解析出的 PID 已探活确认；本档不计红'
  }, null, 2)}\n`;
  try { fs.writeSync(1, text); } catch { process.stdout.write(text); }
  process.exit(0);
}

const heldPid = lockPid();
if (heldPid && heldPid !== process.pid && pidAlive(heldPid)) {
  if (REQUIRE_LIVE) {
    fail(`单实例锁被占用（PID ${heldPid}）——--require-live / QB_VERIFY_REQUIRE_LIVE=1 下不允许 SKIP`,
      `停掉 PID ${heldPid} 后重跑；或换数据根真跑：node tools/verify-qqagent-boot.mjs --data-dir <dir>`);
  }
  skipLocked('pre-start', heldPid);
}

let core = null;
let port = 0;
let exitCode = 0;
try {
  core = createApp({ log: () => {} });
  if (!core || typeof core.start !== 'function') {
    fail('createApp() 返回值缺少 start()', '核对业务面 app.js 返回面');
  }
  port = await core.start();
} catch (error) {
  const msg = String(error?.message ?? error);
  // 双保险：预检与 start 之间锁可能被别的实例抢走（竞态）——同口径按 SKIP 处理
  const racePid = /单实例[^\n]*PID\s*(\d+)/.exec(msg)?.[1];
  if (racePid && !REQUIRE_LIVE) skipLocked('start-throw', Number(racePid));
  fail(`应用启动失败：${msg}`, '看上一行错误；配置面问题查 _unpack/data/config.json');
}
if (!port) {
  fail('start() 未返回端口（port 为空）', '业务面 HTTP 未监听——查 start() 内的 server.listen 与端口占用');
}
if (typeof core.orchestrator?.setPaused !== 'function') {
  fail('core.orchestrator.setPaused 不可用', '冒烟期间无法保证不发言，终止（核对 app/src/business/app.js 返回面的 orchestrator）');
}

try {
  core.orchestrator.setPaused(true);   // 冒烟期间不处理任何消息（不会发言）
  const base = `http://127.0.0.1:${port}`;

  /**
   * 取一个 JSON 接口（非 200 / 非 JSON 都给具名错误）。
   *
   * @param {string} url 完整地址
   * @param {object} [init] fetch 选项
   * @returns {Promise<object>} 解析后的 JSON
   */
  async function getJson(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (error) {
      fail(`接口不可达：${url}（${error?.message ?? error}）`, '内核已起但 HTTP 不可达——查端口与监听地址');
    }
    if (!res.ok) fail(`接口返回 ${res.status}：${url}`, '看业务面日志（_unpack/data/logs）');
    try {
      return await res.json();
    } catch (error) {
      fail(`接口返回非 JSON：${url}（${error?.message ?? error}）`, '核对接口是否被中间件改写');
    }
  }

  const cfg = core.getConfig();
  const sessionsRaw = await getJson(`${base}/api/sessions`);
  const sessions = Array.isArray(sessionsRaw) ? sessionsRaw : (sessionsRaw.sessions || []);
  const prompt = await getJson(`${base}/api/prompt-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  console.log(JSON.stringify({
    ok: true,
    port,
    api: { baseUrl: cfg.api?.baseUrl, model: cfg.api?.model, hasKey: !!cfg.api?.apiKey },
    snowluma: { wsUrl: cfg.snowluma?.wsUrl, hasToken: !!cfg.snowluma?.accessToken },
    persona: { botName: cfg.persona?.botName, roleTextChars: String(cfg.persona?.roleText || '').length },
    allow: { groups: (cfg.allow?.groups || []).length, private: (cfg.allow?.private || []).length },
    contextTier: cfg.store?.contextTier,
    systemPromptChars: String(prompt.systemPrompt || '').length,
    sessions: sessions.slice(0, 5).map((s) => ({ id: s.id, chatKey: s.chatKey, status: s.status, trigger: s.trigger, tokens: s.usage?.totalTokens ?? 0 }))
  }, null, 2));
} catch (error) {
  console.error(`[verify-boot] FAIL 冒烟过程异常：${error?.message ?? error}`);
  exitCode = 1;
} finally {
  try {
    await core.stop();
  } catch (error) {
    console.error(`[verify-boot] WARN stop() 未干净退出：${error?.message ?? error}`);
  }
}
process.exit(exitCode);
