// app.js —— 应用装配
//
// 职责：把配置、日志、协议端宿主、协议端 WebUI 客户端、OneBot 客户端、HTTP 服务组装成一个应用。
// 边界：本文件只做装配与对外接口，具体能力在各子模块。

import path from 'node:path';
import { loadConfig, saveConfig, APP_DIR, DATA_DIR, CONFIG_PATH } from './config.js';
import { createLogger } from './log.js';
import { createShellLayout, readWebui, readOnebot } from './napcat/shell.js';
import { createNapcatHost } from './napcat/host.js';
import { createWebuiClient } from './napcat/webui.js';
import { createLogTail } from './napcat/logtail.js';
import { createOnebotClient } from './onebot/client.js';
import { createWebServer } from './web/server.js';
import { createCompanion } from './companion.js';
import { createNavigator } from './navigator/index.js';

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
  // 协议端 WebUI 客户端——本应用访问协议端控制台的唯一出口（凭据 + QQ 登录面接口）
  const webuiApi = createWebuiClient({ layout, log });

  const onebotConfig = readOnebot(layout);
  const onebot = createOnebotClient({
    wsUrl: `ws://127.0.0.1:${onebotConfig.wsPort}`,
    token: onebotConfig.wsToken,
    log,
    reconnectMs: config.onebot.reconnectMs
  });

  const companion = createCompanion({
    exe: config.companion.exe,
    cwd: config.companion.cwd,
    log,
    enabled: config.companion.enabled
  });

  // 壳层能力注入点（截图等）——核心不依赖 Electron，由 main.js 按需挂上
  const hooks = { capture: null, shot: null };

  // 领航员（design-qqbotb-navigator.md）——状态机 + CH4 猫面 + 观测 + 空闲守护 + 本地 API
  const navigator = createNavigator({ log, dataDir: DATA_DIR, config, onebot, hooks });

  const web = createWebServer({
    port: config.app.port,
    uiDir: path.join(APP_DIR, 'ui'),
    log,
    api: {
      ...navigator.api,
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
      // QQ 登录面——账号掉登录后的恢复入口（状态 / 已存账号 / 快速登录）
      'GET /api/qq/login': async () => {
        const state = await webuiApi.loginStatus();
        const quick = state.code === 0 ? await webuiApi.quickLoginList() : { uins: [] };
        return { body: { ok: state.code === 0, status: state, quick: quick.uins } };
      },
      'POST /api/qq/login/quick': async ({ body }) => {
        const uin = String(body?.uin ?? config.napcat.uin ?? '').trim();
        if (!uin) return { body: { ok: false, error: '缺少账号' } };
        const result = await webuiApi.quickLogin(uin);
        log.info('webui', `快速登录请求（${uin}）：${result.code === 0 ? '已受理' : (result.message || '失败')}`);
        return { body: { ok: result.code === 0, result } };
      },
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
      onebot: onebot.status(),
      companion: companion.state
    };
  }

  /**
   * 取协议端 WebUI 的登录凭据（界面自动登录用）。
   *
   * 凭据算法与接口形态归 WebUI 客户端（src/napcat/webui.js）——本函数只保留
   * 「启动期按轮次重试」这一档：协议端由本应用拉起时界面帧会先于 WebUI 就绪，
   * 就绪前 fetch 必然失败，故重试（每轮落日志，失败可见）；轮次用尽才回落空串。
   *
   * @param {number} [retries] 最大尝试次数
   * @param {number} [delayMs] 每轮间隔毫秒
   * @returns {Promise<string>} 凭据（失败返回空串）
   */
  async function webuiCredential(retries = 40, delayMs = 1000) {
    return webuiApi.login({ attempts: retries, delayMs });
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

    // 顺序是硬要求：协议端就绪后才拉业务面——业务面自己也会经 snowluma 通道拉协议端，
    // 协议端没起来就先拉它会出双实例（且那一路没有控制台隐藏）。
    const napcatReady = config.app.autostartNapcat
      ? napcat.start().catch((error) => {
        log.error('app', `协议端自启失败：${error?.message ?? error}`);
        return { ok: false };
      })
      : Promise.resolve({ ok: true, skipped: true });
    napcatReady
      .then(() => companion.ensure())
      .catch((error) => log.error('app', `业务面拉起失败：${error?.message ?? error}`));

    if (config.onebot.autoConnect) {
      onebot.connect();
    }
    navigator.start();
    return port;
  }

  /**
   * 停止应用。
   *
   * @returns {Promise<void>} 完成
   */
  async function stop() {
    navigator.stop();
    onebot.close();
    logTail.stop();
    await web.stop();
    log.info('app', 'QQBot mod B 已停止');
  }

  return { start, stop, status, log, config, layout, hooks, navigator, webuiCredential, stopNapcat: () => napcat.stop() };
}
