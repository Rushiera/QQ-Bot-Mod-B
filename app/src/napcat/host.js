// napcat/host.js —— 协议端进程生命周期
//
// 职责：拉起 / 停止 / 观测 NapCat 协议端；启动前把「控制台日志」关掉（黑窗口的根因）。
// 边界：只按命令行归属与端口定位本项目的协议端进程——绝不按进程名乱杀（本机另有日常 QQ）。

import { spawn, exec } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebui, disableConsoleLog, enableFileLog } from './shell.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const LIST_SCRIPT = path.join(moduleDir, '..', '..', 'tools', 'list-napcat.ps1');
const HIDE_TOOL = path.join(moduleDir, '..', '..', 'tools', 'bin', 'hide-console.exe');

/**
 * 创建协议端宿主。
 *
 * @param {object} options 选项
 * @param {object} options.layout 目录布局
 * @param {object} options.log 日志器
 * @param {boolean} [options.quietConsole] 启动前关闭协议端控制台日志
 * @param {boolean} [options.fileLog] 启动前打开协议端文件日志
 * @returns {object} 宿主接口
 */
export function createNapcatHost({ layout, log, quietConsole = true, fileLog = true }) {
  let child = null;
  let starting = false;

  /**
   * 探测端口是否可连。
   *
   * @param {number} port 端口
   * @param {string} [host] 主机
   * @param {number} [timeoutMs] 超时毫秒
   * @returns {Promise<boolean>} 是否可连
   */
  function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (value) => {
        try { socket.destroy(); } catch { /* 已关闭 */ }
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  /**
   * 轮询等待端口就绪。
   *
   * @param {number} port 端口
   * @param {number} timeoutMs 超时毫秒
   * @returns {Promise<boolean>} 是否就绪
   */
  async function waitPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portOpen(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  /**
   * 取监听指定端口的进程 PID（解析 netstat 输出，不依赖管道）。
   *
   * @param {number} port 端口
   * @returns {Promise<number|null>} PID
   */
  function listenPid(port) {
    return new Promise((resolve) => {
      exec('netstat -ano -p TCP', { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) return resolve(null);
        for (const line of String(stdout).split(/\r?\n/)) {
          const matched = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
          if (matched && Number(matched[1]) === port) return resolve(Number(matched[2]));
        }
        resolve(null);
      });
    });
  }

  /**
   * 列出命令行归属本协议端目录的进程（含主进程与全部子进程）。
   *
   * @returns {Promise<number[]>} PID 列表
   */
  function listOwnedPids() {
    return new Promise((resolve) => {
      const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${LIST_SCRIPT}" -ShellDir "${layout.dir}"`;
      exec(command, { windowsHide: true, timeout: 20000 }, (error, stdout) => {
        if (error) return resolve([]);
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]');
          const list = Array.isArray(parsed) ? parsed : [parsed];
          resolve(list.map((item) => Number(item.ProcessId)).filter((pid) => Number.isFinite(pid)));
        } catch {
          resolve([]);
        }
      });
    });
  }

  /**
   * 终止进程树。
   *
   * @param {number} pid 进程号
   * @returns {Promise<boolean>} 是否发出终止
   */
  function killTree(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve(false);
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 10000 }, () => resolve(true));
    });
  }

  /**
   * 隐藏指定进程的控制台窗口（协议端自建的黑窗口）。
   *
   * @param {number[]} pids 进程号列表
   * @returns {Promise<boolean>} 是否执行了隐藏
   */
  function hideConsoles(pids) {
    return new Promise((resolve) => {
      if (!pids.length) return resolve(false);
      const command = `"${HIDE_TOOL}" ${pids.join(' ')}`;
      exec(command, { windowsHide: true, timeout: 15000 }, () => resolve(true));
    });
  }

  /**
   * 取当前状态。
   *
   * @returns {Promise<object>} 状态
   */
  async function status() {
    const webui = readWebui(layout);
    const running = await portOpen(webui.port);
    return {
      running,
      pid: running ? await listenPid(webui.port) : null,
      launcherPid: child?.pid ?? null,
      webui: { host: webui.host, port: webui.port, disabled: webui.disabled }
    };
  }

  /**
   * 启动协议端（已在运行则跳过）。
   *
   * @returns {Promise<object>} 结果
   */
  async function start() {
    const webui = readWebui(layout);
    if (await portOpen(webui.port)) {
      log.info('napcat', `协议端已在运行（WebUI ${webui.port} 已监听），跳过启动`);
      return { ok: true, alreadyRunning: true };
    }
    if (starting) {
      log.warn('napcat', '协议端启动进行中，忽略重复请求');
      return { ok: true, starting: true };
    }

    starting = true;
    try {
      if (quietConsole && disableConsoleLog(layout)) {
        log.info('napcat', '已关闭协议端控制台日志（consoleLog=false）');
      }
      if (fileLog && enableFileLog(layout)) {
        log.info('napcat', '已打开协议端文件日志（fileLog=true）');
      }

      child = spawn(layout.launcher, [layout.qqExe, layout.hookDll, '-q', layout.uin], {
        cwd: layout.dir,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          NAPCAT_PATCH_PACKAGE: layout.patchPackage,
          NAPCAT_LOAD_PATH: layout.loadScript,
          NAPCAT_INJECT_PATH: layout.hookDll,
          NAPCAT_LAUNCHER_PATH: layout.launcher,
          NAPCAT_MAIN_PATH: layout.mainScript
        }
      });
      child.unref();
      log.info('napcat', `已拉起协议端（pid=${child.pid}）`);

      // 等待 WebUI 就绪的同时反复隐藏协议端自建的控制台窗口（黑窗口随进程出现）
      let hidden = 0;
      const deadline = Date.now() + 90000;
      let ready = false;
      while (Date.now() < deadline) {
        if (await portOpen(webui.port)) {
          ready = true;
          break;
        }
        const pids = await listOwnedPids();
        if (pids.length) {
          await hideConsoles(pids);
          hidden = hidden + 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (ready) log.info('napcat', `协议端 WebUI ${webui.port} 就绪（隐藏控制台 ${hidden} 轮）`);
      else log.warn('napcat', `协议端 WebUI ${webui.port} 在 90 秒内未就绪`);
      return { ok: true, pid: child.pid, ready, hidden };
    } catch (error) {
      const message = String(error?.message ?? error);
      log.error('napcat', `协议端启动失败：${message}`);
      return { ok: false, error: message };
    } finally {
      starting = false;
    }
  }

  /**
   * 停止协议端。
   *
   * 顺序：本程序拉起的启动器 → 命令行归属协议端目录的全部进程（主进程 + 子进程）
   *      → 兜底杀监听 WebUI 端口的进程。只杀端口子进程会导致 QQ 主进程重启子进程。
   *
   * @returns {Promise<object>} 结果
   */
  async function stop() {
    const webui = readWebui(layout);
    const killed = [];

    if (child?.pid) {
      await killTree(child.pid);
      killed.push(child.pid);
      child = null;
    }

    const owned = await listOwnedPids();
    for (const pid of owned) {
      if (killed.includes(pid)) continue;
      await killTree(pid);
      killed.push(pid);
    }

    const listener = await listenPid(webui.port);
    if (listener && !killed.includes(listener)) {
      await killTree(listener);
      killed.push(listener);
    }

    const stillRunning = await waitPort(webui.port, 3000);
    if (stillRunning) {
      log.warn('napcat', `停止后 WebUI ${webui.port} 仍在监听`);
      return { ok: false, killed, stillRunning: true };
    }
    log.info('napcat', killed.length ? `协议端已停止（pid=${killed.join(',')}）` : '协议端未在运行');
    return { ok: true, killed, stillRunning: false };
  }

  return { start, stop, status, portOpen, waitPort };
}
