#!/usr/bin/env node
// tools/watch-login.mjs —— 登录探针的旁路入口
//
// 用途：单体还没重启（探针未挂上）或想单独取证时，独立跑同一套采样逻辑。
// 与 app/src/incident/login-watch.js 是**同一份实现**，差异只有日志出口（这里写 stdout）。
//
// 用法：
//   node tools/watch-login.mjs                 常驻，默认每 30 秒采样一次
//   node tools/watch-login.mjs --once          采样一次，打印结果后退出（验证用）
//   node tools/watch-login.mjs --interval=60   自定义采样间隔（秒）
//   node tools/watch-login.mjs --silent=10     自定义静默阈值（分钟）
//
// 产物：app/data/incidents/watch-<日期>.jsonl（每采样一行）+ 异常时 <时间>_<原因>.json（现场快照）
// 边界：只读——不重启协议端、不重登、不动业务面。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR, PROJECT_DIR } from '../app/src/config.js';
import { createShellLayout, readOnebot } from '../app/src/napcat/shell.js';
import { createWebuiClient } from '../app/src/napcat/webui.js';
import { createLoginWatch } from '../app/src/incident/login-watch.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数列表
 * @returns {object} { once, intervalSec, silentMin }
 */
function parseArgs(argv) {
  const out = { once: false, intervalSec: 0, silentMin: 0 };
  for (const item of argv) {
    if (item === '--once') out.once = true;
    else if (item.startsWith('--interval=')) out.intervalSec = Number(item.slice(11)) || 0;
    else if (item.startsWith('--silent=')) out.silentMin = Number(item.slice(9)) || 0;
  }
  return out;
}

/**
 * 轻量日志器（写 stdout，不落 app/data/logs —— 避免与单体日志混在一起）。
 *
 * @returns {object} 日志器
 */
function consoleLogger() {
  const emit = (level, module, text) => {
    const at = new Date().toTimeString().slice(0, 8);
    // eslint-disable-next-line no-console
    console.log(`${at} [${level}] [${module}] ${text}`);
  };
  return {
    debug: () => {},
    info: (module, text) => emit('INFO', module, text),
    warn: (module, text) => emit('WARN', module, text),
    error: (module, text) => emit('ERROR', module, text)
  };
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const log = consoleLogger();
const layout = createShellLayout(config.napcat.shellDir, config.napcat.uin);
const webuiApi = createWebuiClient({ layout, log });
const onebot = readOnebot(layout);

const tuning = {
  enabled: true,
  intervalMs: args.intervalSec ? args.intervalSec * 1000 : (config.incident?.intervalMs ?? 30000),
  silentMs: args.silentMin ? args.silentMin * 60 * 1000 : (config.incident?.silentMs ?? 30 * 60 * 1000)
};

const watch = createLoginWatch({
  layout,
  webuiApi,
  businessLogDir: path.join(PROJECT_DIR, '_unpack', 'data', 'logs'),
  dataDir: DATA_DIR,
  log,
  ports: { ws: onebot.wsPort, http: onebot.httpPort },
  tuning
});

log.info('watch', `壳目录 ${layout.dir}`);
log.info('watch', `通道 ws=${onebot.wsPort} http=${onebot.httpPort} · 业务面日志 ${path.join(PROJECT_DIR, '_unpack', 'data', 'logs')}`);
log.info('watch', `产物目录 ${watch.incidentDir}`);
log.info('watch', `脚本位置 ${moduleDir}（与单体共用 app/src/incident/login-watch.js）`);

if (args.once) {
  const sample = await watch.tick();
  log.info('watch', '一次性采样完成：');
  console.log(JSON.stringify(sample, null, 2));
  process.exit(0);
}

watch.start();
log.info('watch', '常驻采样开始（Ctrl+C 结束）');
process.on('SIGINT', () => {
  watch.stop();
  log.info('watch', '已停止');
  process.exit(0);
});
