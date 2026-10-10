// log.js —— 应用日志
//
// 职责：内存环形缓冲（界面即时可见）+ 按日落盘（事后排查）+ 订阅推送（SSE）。
// 边界：不接管协议端自己的日志——那由 napcat/host.js 采集后经本模块记录。

import fs from 'node:fs';
import path from 'node:path';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 生成时间戳（本地时间，yyyy-MM-dd HH:mm:ss.SSS）。
 *
 * @param {Date} date 时间对象
 * @returns {string} 格式化结果
 */
function stamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 创建日志器。
 *
 * @param {object} options 选项
 * @param {string} options.dir 落盘目录（data/logs）
 * @param {number} [options.maxLines] 内存保留条数
 * @param {string} [options.level] 落盘级别下限（debug / info / warn / error）
 * @returns {object} 日志器
 */
export function createLogger({ dir, maxLines = 1000, level = 'info' } = {}) {
  const buffer = [];
  const listeners = new Set();
  let diskLevel = LEVEL_WEIGHT[level] ? level : 'info';
  let seq = 0;

  /**
   * 当日日志文件路径。
   *
   * @returns {string} 绝对路径
   */
  function currentFile() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return path.join(dir, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`);
  }

  /**
   * 写一条日志。
   *
   * @param {string} levelName 级别（debug / info / warn / error）
   * @param {string} module 模块名
   * @param {string} text 正文
   * @returns {object} 日志条目
   */
  function write(levelName, module, text) {
    const at = Date.now();
    const entry = { seq: ++seq, at, level: levelName, module, text: String(text ?? '') };
    buffer.push(entry);
    if (buffer.length > maxLines) buffer.splice(0, buffer.length - maxLines);

    if (LEVEL_WEIGHT[levelName] >= LEVEL_WEIGHT[diskLevel]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(currentFile(), `[${stamp(new Date(at))}] [${levelName.toUpperCase()}] [${module}] ${entry.text}\n`, 'utf8');
      } catch {
        // 落盘失败不得静默——退化为内存可见的告警，但不递归记录
        buffer.push({ seq: ++seq, at: Date.now(), level: 'error', module: 'log', text: '日志落盘失败' });
      }
    }

    for (const fn of listeners) {
      try { fn(entry); } catch { /* 订阅者异常不影响日志主链 */ }
    }
    return entry;
  }

  return {
    /** 调试级。 */
    debug: (module, text) => write('debug', module, text),
    /** 信息级。 */
    info: (module, text) => write('info', module, text),
    /** 警告级。 */
    warn: (module, text) => write('warn', module, text),
    /** 错误级。 */
    error: (module, text) => write('error', module, text),
    /** 取最近若干条。 */
    recent: (limit = 200) => buffer.slice(Math.max(0, buffer.length - limit)),
    /** 订阅新日志，返回取消函数。 */
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 当前落盘级别。 */
    getLevel: () => diskLevel,
    /** 设置落盘级别。 */
    setLevel: (value) => {
      if (LEVEL_WEIGHT[value]) diskLevel = value;
      return diskLevel;
    }
  };
}
