// napcat/logtail.js —— 协议端日志跟随
//
// 职责：跟随协议端 logs 目录里最新的 .log 文件，把新增行转发进应用日志。
// 边界：只读；文件轮转或截断时从头重读，不做历史归档。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 创建日志跟随器。
 *
 * @param {object} options 选项
 * @param {string} options.dir 协议端日志目录
 * @param {object} options.log 应用日志器
 * @param {number} [options.intervalMs] 轮询间隔毫秒
 * @returns {object} 跟随器（start / stop）
 */
export function createLogTail({ dir, log, intervalMs = 2000 }) {
  let timer = null;
  let file = '';
  let offset = 0;

  /**
   * 取目录里最新的 .log 文件。
   *
   * @returns {string} 文件路径（无则空串）
   */
  function latestFile() {
    if (!fs.existsSync(dir)) return '';
    let newest = '';
    let newestTime = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newestTime) {
          newestTime = stat.mtimeMs;
          newest = full;
        }
      } catch { /* 文件刚好被删，跳过 */ }
    }
    return newest;
  }

  /**
   * 读一次增量并转发。
   *
   * @returns {void}
   */
  function tick() {
    const latest = latestFile();
    if (!latest) return;

    if (latest !== file) {
      file = latest;
      offset = 0;
    }

    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;

    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, length, offset);
      fs.closeSync(fd);
      offset = stat.size;

      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) log.info('napcat', line);
      }
    } catch {
      // 读取失败（文件被占用/轮转）不阻塞——下一轮重试
    }
  }

  return {
    /** 开始跟随。 */
    start: () => {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      tick();
    },
    /** 停止跟随。 */
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }
  };
}
