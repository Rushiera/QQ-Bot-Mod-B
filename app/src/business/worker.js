// worker.js —— 业务面子进程入口（子进程隔离启动）
//
// 职责：以独立进程跑业务面（app/src/business/app.js），事件由父进程经 IPC 注入。
// 边界：
//   · 不自己连 OneBot WS（一条 WS 在单体侧，见 app.js 的 externalTransport 分支）；
//     HTTP 发送面仍由业务面自己持有（onebot.js 的 call() 走 httpUrl）。
//   · 不接管协议端生命周期（不自动拉起 SnowLuma——那会与单体侧抢同一个协议端）。
//   · 数据根必须由父进程注入 QQ_AGENT_DATA_DIR；未注入即按 CONFIG 码退出，不回落源码目录。
//
// 退出码口径见 bridge-protocol.js 的 EXIT_CODE——父侧按码决定是否重启（CONFIG 只重启一次）。

import process from 'node:process';
import { createApp } from './app.js';
import { createEventBridge } from './event-bridge.js';
import { EXIT_CODE } from './bridge-protocol.js';

const startedAt = Date.now();
const bridge = createEventBridge({ label: 'ipc-business' });

/** 已创建的 app 实例（停机时可空）。 */
let app = null;
/** 停机幂等标记。 */
let stopping = false;

/**
 * 致命错误出口：落日志 → 上报父进程 → 按码退出。
 *
 * @param {number} code 退出码（EXIT_CODE）
 * @param {string} message 人话原因
 * @param {Error|*} [error] 原始异常
 * @returns {void}
 */
function fatal(code, message, error) {
  const detail = error ? `：${error?.message ?? error}` : '';
  console.error(`[worker] ${message}${detail}`);
  try {
    bridge.reportError({ code, message: `${message}${detail}` });
  } catch { /* 通道已断：日志已出声，退出码仍按这里给 */ }
  // 给父进程 100ms 收走 IPC 消息再退出（立即退出可能丢最后一条错误上报）
  setTimeout(() => process.exit(code), 100);
}

/**
 * 优雅停机（幂等）。
 *
 * @param {string} reason 触发原因（日志）
 * @returns {Promise<void>} 完成
 */
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] 收到停机指令（${reason}），开始收尾`);
  const force = setTimeout(() => {
    console.error('[worker] 停机超时（10 秒），强制退出');
    process.exit(EXIT_CODE.FATAL);
  }, 10_000);
  force.unref?.();
  try {
    await app?.stop?.();
  } catch (error) {
    console.error(`[worker] 停机失败：${error?.message ?? error}`);
  }
  bridge.close();
  clearTimeout(force);
  process.exit(EXIT_CODE.OK);
}

/**
 * 启动业务面并上报就绪。
 *
 * @returns {Promise<void>} 完成
 */
async function main() {
  if (!String(process.env.QQ_AGENT_DATA_DIR || '').trim()) {
    fatal(EXIT_CODE.CONFIG, '数据根未注入（QQ_AGENT_DATA_DIR 为空）——业务面拒绝回落到源码目录');
    return;
  }
  if (!bridge.hasChannel) {
    console.warn('[worker] 未检测到 IPC 通道（独立运行模式）：不会收到任何事件，仅验证启动链');
  }

  bridge.onShutdown(() => { shutdown('父进程 SHUTDOWN'); });
  bridge.onStatus(({ connected, selfInfo }) => {
    try {
      app?.onebot && (app.onebot.connected = !!connected);
      if (connected && app?.onebot) app.onebot.everConnected = true;
      if (selfInfo && app?.onebot) app.onebot.selfInfo = selfInfo;
    } catch (error) {
      console.warn(`[worker] 连接态同步失败（不影响事件消费）：${error?.message ?? error}`);
    }
  });

  try {
    app = createApp({ log: console.log, eventSource: bridge });
  } catch (error) {
    // 单实例锁被占 / 数据根不可写 / 配置损坏——重试必然同样失败，按 CONFIG 码上报
    fatal(EXIT_CODE.CONFIG, '业务面创建失败（数据根 / 单实例锁 / 配置）', error);
    return;
  }

  try {
    const port = await app.start();
    const info = {
      pid: process.pid,
      port,
      dataDir: String(process.env.QQ_AGENT_DATA_DIR || ''),
      startedInMs: Date.now() - startedAt,
      node: process.version
    };
    bridge.ready(info);
    console.log(`[worker] 业务面已就绪：pid=${info.pid} port=${port} 用时 ${info.startedInMs}ms`);
  } catch (error) {
    fatal(EXIT_CODE.STARTUP, '业务面启动失败（HTTP 监听 / 技能加载）', error);
    try { await app?.stop?.(); } catch { /* 停机失败不掩盖原始错误 */ }
  }
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
// 父进程消失（IPC 断开）→ 自己退出，避免留下孤儿进程占端口/数据根
process.on('disconnect', () => { shutdown('父进程已退出'); });
// 运行期未捕获异常：如实上报 + 非零退出（失败可见），由父侧决定重启
process.on('uncaughtException', (error) => { fatal(EXIT_CODE.FATAL, 'uncaughtException', error); });
process.on('unhandledRejection', (error) => { fatal(EXIT_CODE.FATAL, 'unhandledRejection', error); });

await main();
