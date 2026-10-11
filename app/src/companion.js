// companion.js —— 业务伴生进程（QQ Agent）
//
// 职责：协议端就绪后确保业务面在跑——入口换成自研单体，功能不丢。
// 边界：只做「存活探测 + 按需拉起」；不接管它的生命周期（本应用退出不杀它），
//       也不改它的配置——它自己经 snowluma 通道连协议端（协议端已在跑时该通道只驻留）。

import { exec, spawn } from 'node:child_process';

/** 业务面进程映像名（QQ Agent 单实例——同名进程只有它自己）。 */
const IMAGE = 'QQ Agent.exe';

/**
 * 创建业务伴生进程管理器。
 *
 * @param {object} options 选项
 * @param {string} options.exe 业务面可执行文件全路径
 * @param {string} options.cwd 业务面工作目录（必须显式钉死——不继承启动者 cwd）
 * @param {object} options.log 日志器
 * @param {boolean} [options.enabled] 是否启用
 * @returns {object} 伴生进程接口
 */
export function createCompanion({ exe, cwd, log, enabled = true }) {
  const state = { enabled, exe, cwd, running: false, pid: null, lastAction: '未动作' };

  /**
   * 探测业务面是否已在运行。
   *
   * @returns {Promise<boolean>} 是否在运行
   */
  function probe() {
    return new Promise((resolve) => {
      exec(`tasklist /FI "IMAGENAME eq ${IMAGE}" /NH`, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) {
          log.warn('companion', `业务面存活探测失败：${error?.message ?? error}`);
          return resolve(false);
        }
        resolve(String(stdout).includes(IMAGE));
      });
    });
  }

  /**
   * 确保业务面在跑（已在运行则跳过）。
   *
   * @returns {Promise<object>} 结果
   */
  async function ensure() {
    if (!enabled) {
      state.lastAction = '未启用';
      log.info('companion', '业务伴生进程未启用，跳过');
      return { ok: true, skipped: true };
    }
    if (await probe()) {
      state.running = true;
      state.lastAction = '已在运行——跳过拉起';
      log.info('companion', '业务面已在运行，跳过拉起');
      return { ok: true, alreadyRunning: true };
    }
    try {
      const child = spawn(exe, [], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      state.pid = child.pid ?? null;
      state.running = true;
      state.lastAction = `已拉起（pid=${state.pid}）`;
      log.info('companion', `已拉起业务面（pid=${state.pid}）`);
      return { ok: true, pid: state.pid };
    } catch (error) {
      const message = String(error?.message ?? error);
      state.running = false;
      state.lastAction = `拉起失败：${message}`;
      log.error('companion', `业务面拉起失败：${message}`);
      return { ok: false, error: message };
    }
  }

  return { ensure, probe, state };
}
