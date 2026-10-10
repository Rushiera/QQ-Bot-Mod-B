// app.js —— 应用装配
//
// 职责：把配置、日志、协议端宿主、OneBot 客户端、HTTP 服务组装成一个应用。
// 边界：本文件只做装配与对外接口，具体能力在各子模块。

import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, APP_DIR, DATA_DIR, CONFIG_PATH } from './config.js';
import { createLogger } from './log.js';
import { createShellLayout, readWebui, readOnebot } from './napcat/shell.js';
import { createNapcatHost } from './napcat/host.js';
import { createLogTail } from './napcat/logtail.js';
import { createOnebotClient } from './onebot/client.js';
import { createWebServer } from './web/server.js';

/**
 * 创建应用实例。
 *
 * @returns {Promise<object>} 应用接口
 */
export async function createApp() {
  const config = loadConfig();
  const log = createLogger({ dir: path.join(DATA_DIR, 'logs'), level: 'info' });

  const layout = createShellLayout(config.napcat.shellDir, config.napcat.uin);
  const napcat = createNapcatHost({ layout, log });
  const logTail = createLogTail({ dir: layout.logsDir, log });

  const onebotConfig = readOnebot(layout);
  const onebot = createOnebotClient({
    wsUrl: `ws://127.0.0.1:${onebotConfig.wsPort}`,
    token: onebotConfig.wsToken,
    log,
    reconnectMs: config.onebot.reconnectMs
  });

  // 壳层能力注入点（截图等）——核心不依赖 Electron，由 main.js 按需挂上
  const hooks = { capture: null };

  const web = createWebServer({
    port: config.app.port,
    uiDir: path.join(APP_DIR, 'ui'),
    log,
    api: {
      'GET /api/status': async () => ({ body: await status() }),
      'GET /api/logs': async ({ query }) => ({ body: { logs: log.recent(Number(query.get('limit')) || 200) } }),
      'GET /api/config': async () => ({
        body: {
          config,
          paths: { app: APP_DIR, data: DATA_DIR, configFile: CONFIG_PATH, shellDir: layout.dir },
          configFile: layout.napcatFile
        }
      }),
      'POST /api/config': async ({ body }) => ({ body: { ok: true, config: saveConfig(body ?? {}) } }),
      'POST /api/napcat/start': async () => ({ body: await napcat.start() }),
      'POST /api/napcat/stop': async () => ({ body: await napcat.stop() }),
      'POST /api/onebot/connect': async () => {
        onebot.connect();
        return { body: { ok: true } };
      },
      'POST /api/onebot/disconnect': async () => {
        onebot.close();
        return { body: { ok: true } };
      },
      'POST /api/debug/screenshot': async ({ query }) => {
        if (!hooks.capture) return { body: { ok: false, error: '截图能力未注册（非 Electron 运行环境）' } };
        const file = await hooks.capture(query.get('tab') || '');
        return { body: { ok: true, file } };
      }
    }
  });

  log.subscribe((entry) => web.broadcast('log', entry));

  /**
   * 汇总当前状态。
   *
   * @returns {Promise<object>} 状态
   */
  async function status() {
    const webui = readWebui(layout);
    const napcatState = await napcat.status();
    return {
      app: { port: web.address(), version: '0.1.0' },
      napcat: {
        ...napcatState,
        shellDir: layout.dir,
        uin: layout.uin,
        webuiUrl: `http://127.0.0.1:${webui.port}/webui/`
      },
      onebot: onebot.status()
    };
  }

  /**
   * 取协议端 WebUI 的登录凭据（界面自动登录用）。
   *
   * 凭据算法来自协议端自身实现：hash = sha256(token + ".napcat")，
   * 登录成功后返回 base64 编码的凭据，前端把它写进 localStorage 的 token 键即视为已登录。
   *
   * @returns {Promise<string>} 凭据（失败返回空串）
   */
  async function webuiCredential() {
    const webui = readWebui(layout);
    if (!webui.token) {
      log.warn('webui', '协议端未配置 WebUI 访问密钥，无法自动登录');
      return '';
    }
    try {
      const hash = crypto.createHash('sha256').update(`${webui.token}.napcat`).digest('hex');
      const response = await fetch(`http://127.0.0.1:${webui.port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, totpCode: '' })
      });
      const data = await response.json();
      const credential = data?.data?.Credential ?? '';
      if (!credential) log.warn('webui', `自动登录失败：${data?.message ?? '未知原因'}`);
      return credential;
    } catch (error) {
      log.warn('webui', `自动登录异常：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 启动应用。
   *
   * @returns {Promise<number>} 界面端口
   */
  async function start() {
    const port = await web.start();
    logTail.start();
    log.info('app', `QQBot mod B 启动（界面端口 ${port}）`);

    if (config.app.autostartNapcat) {
      napcat.start().catch((error) => log.error('app', `协议端自启失败：${error?.message ?? error}`));
    }
    if (config.onebot.autoConnect) {
      onebot.connect();
    }
    return port;
  }

  /**
   * 停止应用。
   *
   * @returns {Promise<void>} 完成
   */
  async function stop() {
    onebot.close();
    logTail.stop();
    await web.stop();
    log.info('app', 'QQBot mod B 已停止');
  }

  return { start, stop, status, log, config, layout, hooks, webuiCredential, stopNapcat: () => napcat.stop() };
}
