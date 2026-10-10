// tools/smoke.mjs —— 无界面冒烟测试
//
// 用法：node tools/smoke.mjs
// 做什么：加载全部模块 → 读配置 → 探测协议端 → 起 HTTP 服务 → 连 OneBot → 收尾。
// 边界：只读 + 探测，不停止已在运行的协议端（host.start 在端口已开时自动跳过）。

import path from 'node:path';
import { loadConfig, DATA_DIR } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createShellLayout, readWebui, readOnebot } from '../src/napcat/shell.js';
import { createNapcatHost } from '../src/napcat/host.js';
import { createOnebotClient } from '../src/onebot/client.js';
import { createApp } from '../src/app.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig();
console.log('[1] 配置加载', JSON.stringify(config));

const layout = createShellLayout(config.napcat.shellDir, config.napcat.uin);
const webui = readWebui(layout);
const onebotConfig = readOnebot(layout);
console.log('[2] WebUI 配置', JSON.stringify(webui));
console.log('[3] OneBot 配置', JSON.stringify(onebotConfig));

const log = createLogger({ dir: path.join(DATA_DIR, 'logs') });
const napcat = createNapcatHost({ layout, log });
console.log('[4] 协议端状态', JSON.stringify(await napcat.status()));

const onebot = createOnebotClient({
  wsUrl: `ws://127.0.0.1:${onebotConfig.wsPort}`,
  token: onebotConfig.wsToken,
  log
});
onebot.connect();
await sleep(2500);
console.log('[5] OneBot 状态', JSON.stringify(onebot.status()));
onebot.close();

const app = await createApp();
const port = await app.start();
console.log('[6] 应用已启动，界面端口', port);
await sleep(1500);
const status = await app.status();
console.log('[7] 状态快照', JSON.stringify(status, null, 2));
await app.stop();
console.log('[8] 冒烟完成');
process.exit(0);
