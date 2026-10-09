// napcat-host/index.mjs —— NapCat 宿主 shim
//
// 作用：QQ Agent 的「SnowLuma 自动启动」通道只认 `<snowluma.dir>/node.exe + index.mjs`。
// 把 snowluma.dir 指到本目录，应用就会用**无窗口**方式拉起本脚本 → 本脚本再去拉起 NapCat。
// 于是：协议端随应用自启、没有 cmd 窗口、日志进应用内置控制台。
//
// 幂等：WebUI 端口已开 = NapCat 已在运行 → 只驻留，不重复拉起（防双实例抢登录）。
// 驻留：本进程必须活着（应用据此判定「协议端运行中」）；NapCat 用 detached 起，独立存活。

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const SHELL_DIR = 'D:\\Mau\\WorkSpace\\QQBotB\\runtime\\NapCat\\NapCat.52230.Shell';
const QQ_ID = '2405997337';
const WEBUI_PORT = 6099;

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (await portOpen(WEBUI_PORT)) {
  console.log(`[napcat-host] NapCat 已在运行（WebUI ${WEBUI_PORT}）——本宿主仅驻留`);
} else {
  const launcher = path.join(SHELL_DIR, 'NapCatWinBootMain.exe');
  const qqExe = path.join(SHELL_DIR, 'QQ.exe');
  const dll = path.join(SHELL_DIR, 'NapCatWinBootHook.dll');
  const child = spawn(launcher, [qqExe, dll, '-q', QQ_ID], {
    cwd: SHELL_DIR,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: path.join(SHELL_DIR, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(SHELL_DIR, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: dll,
      NAPCAT_LAUNCHER_PATH: launcher,
      NAPCAT_MAIN_PATH: path.join(SHELL_DIR, 'napcat.mjs')
    }
  });
  child.unref();
  console.log(`[napcat-host] 已拉起 NapCat（pid=${child.pid}，无窗口）`);
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (await portOpen(WEBUI_PORT)) { ready = true; break; }
    await sleep(1000);
  }
  console.log(`[napcat-host] NapCat WebUI ${WEBUI_PORT} ${ready ? '就绪' : '超时未就绪'}`);
}

// 驻留：让应用认为「协议端进程活着」；NapCat 本体已 detached，不受本进程存亡影响。
setInterval(() => {}, 60000);
