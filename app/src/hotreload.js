// hotreload.js —— 开发期热重载：源码一变就重启业务面子进程（不停单体、不断界面）
//
// 职责：监视 app/src 与 personas / role → 防抖 → 等业务面空闲 → hub.reload()。
// 边界（三条，越界就是「改了没生效」或「对话被拦腰砍」）：
//   · **只自动重载业务面**（子进程，app/src/business + 人设与教材）。单体自身
//     （main.js / src/*.js / src/navigator/**）不在自动面——重启 Electron 会断界面与领航观测，
//     只标 appPending 出声，由人按一下（POST /api/dev/restart-app）。
//   · **正在跑一轮对话时不换进程**：距最近事件 < idleMs 就等，最多等 maxWaitMs 后强制并出声。
//   · **失败不静默**：连续 failLimit 次失败即停自动并出声——防「改坏了 → 崩溃 / 重启无限循环」。
//
// 参照 apis 的热重载范式（编译到暂存 → 通知宿主 reload → 轮询结果判 ok/error），
// 在 Node 侧等价物是：判受影响面 → hub.reload（先等旧进程退出再拉新）→ 等 READY + 健康检查。

import fs from 'node:fs';
import path from 'node:path';

/** 参与判定的源码扩展名（json 含配置 / 语料；md 含人设卡与教材）。 */
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md']);

/** 路径段黑名单——依赖 / 版本库 / 运行数据 / 界面静态资源 / 协议端运行区，一概不触发重载。 */
const IGNORE_SEGMENTS = ['node_modules', '.git', 'data', 'ui', 'runtime', '_unpack', 'logs'];

/**
 * 创建热重载监视器。
 *
 * @param {object} options 选项
 * @param {string} options.rootDir 应用根（app/）
 * @param {string} options.projectDir 项目根（QQBotB/）
 * @param {object} options.log 日志器（info/warn/error）
 * @param {object} options.hub 业务面分发中心（需有 reload / status）
 * @param {object} [options.config] `config.hotreload` 段
 * @returns {object} 监视器接口（start / stop / reloadNow / status）
 */
export function createHotReload({ rootDir, projectDir, log, hub, config = {} } = {}) {
  const info = (text) => (typeof log?.info === 'function' ? log.info('hotreload', text) : console.log(text));
  const warn = (text) => (typeof log?.warn === 'function' ? log.warn('hotreload', text) : console.warn(text));
  const error = (text) => (typeof log?.error === 'function' ? log.error('hotreload', text) : console.error(text));

  /**
   * 取数值配置（非法 / 越界回落默认——0 是合法值，不能用 `||`）。
   *
   * @param {*} value 原值
   * @param {number} fallback 默认值
   * @param {number} [min] 下限
   * @returns {number} 取值
   */
  const num = (value, fallback, min = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };

  const settings = {
    enabled: config.enabled !== false,
    debounceMs: num(config.debounceMs, 800, 100),
    // 空闲窗口：距最近一条事件这么久才换进程（0 = 不等，改完立刻重载）
    idleMs: num(config.idleMs, 8000),
    // 业务面一直有事件时的强制上限——不能让「群里一直在聊」把改动永远卡住
    maxWaitMs: num(config.maxWaitMs, 180_000, 1000),
    failLimit: num(config.failLimit, 2, 1)
  };

  const stats = { triggers: 0, reloads: 0, ok: 0, failed: 0, forced: 0, waited: 0 };

  /** 已 watch 的目录句柄（stop 时逐个关）。 */
  const watchers = [];
  /** 待重载的业务面文件（相对项目根的路径）。 */
  const pending = new Set();
  /** 待重启应用的单体面文件。 */
  const appPending = new Set();
  let debounceTimer = null;
  let retryTimer = null;
  let busy = false;
  let autoDisabled = false;
  let waitingSince = 0;
  let consecutiveFailures = 0;
  let startedAt = 0;

  /**
   * 判定一次改动落在哪一面。
   *
   * @param {string} file 绝对路径
   * @returns {'business'|'app'|'ignore'} 面（business = 重载子进程 / app = 需重启应用 / ignore = 不管）
   */
  function classify(file) {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    if (!rel || rel === '' || rel.startsWith('..')) return 'ignore';
    const segments = rel.split('/');
    if (segments.some((segment) => IGNORE_SEGMENTS.includes(segment))) return 'ignore';
    if (!EXT.has(path.extname(rel).toLowerCase())) return 'ignore';
    // 业务面：子进程内全部代码 + 人设卡与教材（业务面每轮读盘）
    if (rel.startsWith('app/src/business/')) return 'business';
    if (rel.startsWith('personas/') || rel.startsWith('role/')) return 'business';
    // 单体：入口 + src 下其余一切（navigator / web / incident / onebot / napcat / 顶层模块）
    if (rel === 'app/main.js' || rel.startsWith('app/src/')) return 'app';
    return 'ignore';
  }

  /** 把一批文件压成日志里能读的一句话（最多 3 个，其余计数——截断必须自证）。 */
  function summarize(files) {
    const list = [...files];
    const head = list.slice(0, 3).join('、');
    return list.length > 3 ? `${head} 等 ${list.length} 个文件` : head;
  }

  /** 安排一次防抖重载。 */
  function schedule() {
    if (!settings.enabled) return;
    if (autoDisabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush().catch((reason) => error(`重载调度异常：${reason?.message ?? reason}`));
    }, settings.debounceMs);
    debounceTimer.unref?.();
  }

  /** 业务面在忙时的退避重试（2 秒后重新判空闲）。 */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush().catch((reason) => error(`重载重试异常：${reason?.message ?? reason}`));
    }, 2000);
    retryTimer.unref?.();
  }

  /** 执行一次自动重载（含空闲窗口与失败熔断）。 */
  async function flush() {
    if (busy) { scheduleRetry(); return; }
    const files = [...pending];
    if (!files.length) return;
    if (!settings.enabled || autoDisabled) return;

    const snapshot = typeof hub?.status === 'function' ? hub.status() : {};
    const quietMs = Date.now() - (Number(snapshot.lastEventAt) || 0);
    if (quietMs < settings.idleMs) {
      if (!waitingSince) {
        waitingSince = Date.now();
        stats.waited += 1;
        info(`业务面刚有事件（${Math.round(quietMs / 1000)} 秒前），等空闲窗口 ${Math.round(settings.idleMs / 1000)} 秒后再重载`);
      }
      if (Date.now() - waitingSince < settings.maxWaitMs) { scheduleRetry(); return; }
      stats.forced += 1;
      warn(`业务面持续有事件 ${Math.round((Date.now() - waitingSince) / 1000)} 秒，超过上限——强制重载（改动的代码一直没生效比打断一轮更贵）`);
    }

    pending.clear();
    busy = true;
    stats.reloads += 1;
    const reason = `自动：${summarize(files)}`;
    try {
      const result = await hub.reload({ reason });
      if (result?.ok) {
        stats.ok += 1;
        consecutiveFailures = 0;
        info(`已重载（${reason}）：pid=${result.pid} port=${result.port} 用时 ${result.ms}ms`);
      } else {
        stats.failed += 1;
        consecutiveFailures += 1;
        error(`重载失败（${reason}）：${result?.error ?? '未知原因'}`);
        if (consecutiveFailures >= settings.failLimit && !autoDisabled) {
          autoDisabled = true;
          error(`连续 ${consecutiveFailures} 次重载失败——已停止自动重载（改坏的代码在循环重启）。修好后用 POST /api/dev/reload?auto=1 恢复`);
        }
      }
    } catch (reason2) {
      stats.failed += 1;
      consecutiveFailures += 1;
      error(`重载异常（${reason}）：${reason2?.message ?? reason2}`);
    } finally {
      busy = false;
      waitingSince = 0;
    }
  }

  /**
   * 收到一条文件变更。
   *
   * @param {string} file 绝对路径
   * @returns {void}
   */
  function onChange(file) {
    const face = classify(file);
    if (face === 'ignore') return;
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    stats.triggers += 1;
    if (face === 'app') {
      // 单体面：自动重启会断界面与观测——只记账出声，等人工按一下
      if (!appPending.has(rel)) {
        info(`单体侧改动（${rel}）——不进自动面，需 POST /api/dev/restart-app 或重开应用才生效`);
      }
      appPending.add(rel);
      return;
    }
    if (!pending.has(rel)) pending.add(rel);
    schedule();
  }

  /**
   * 挂一个递归目录监视。
   *
   * @param {string} dir 目录
   * @returns {boolean} 是否挂上（目录不存在或系统拒绝 → false，出声不崩）
   */
  function watchDir(dir) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        onChange(path.resolve(dir, String(filename)));
      });
      watcher.on('error', (reason) => error(`目录监视失败（${dir}）：${reason?.message ?? reason}`));
      watchers.push(watcher);
      return true;
    } catch (reason) {
      error(`目录监视挂载失败（${dir}）：${reason?.message ?? reason}`);
      return false;
    }
  }

  /**
   * 挂单文件监视（单体入口 main.js——它在 app/src 之外）。
   *
   * @param {string} file 文件
   * @returns {boolean} 是否挂上
   */
  function watchFile(file) {
    try {
      const watcher = fs.watch(file, () => onChange(file));
      watcher.on('error', (reason) => error(`文件监视失败（${file}）：${reason?.message ?? reason}`));
      watchers.push(watcher);
      return true;
    } catch (reason) {
      error(`文件监视挂载失败（${file}）：${reason?.message ?? reason}`);
      return false;
    }
  }

  return {
    /**
     * 开始监视。
     *
     * @returns {object} 状态快照
     */
    start() {
      if (startedAt) return this.status();
      startedAt = Date.now();
      if (!settings.enabled) {
        info('热重载已关闭（config.hotreload.enabled=false）——改代码后仍需重开应用');
        return this.status();
      }
      const dirs = [path.join(rootDir, 'src'), path.join(projectDir, 'personas'), path.join(projectDir, 'role')]
        .filter((dir) => fs.existsSync(dir));
      const attached = dirs.filter((dir) => watchDir(dir));
      const mainFile = path.join(rootDir, 'main.js');
      const mainAttached = fs.existsSync(mainFile) ? watchFile(mainFile) : false;
      info(`已启动：监视 ${attached.length} 个目录 + ${mainAttached ? '1 个入口文件' : '0 个入口文件'}`
        + `（防抖 ${settings.debounceMs}ms · 空闲窗口 ${Math.round(settings.idleMs / 1000)}s）`
        + '——改业务面代码自动重载，改单体代码只出声');
      return this.status();
    },

    /** 停止监视（幂等）。 */
    stop() {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* 已关闭 */ }
      }
      watchers.length = 0;
      pending.clear();
      busy = false;
      startedAt = 0;
    },

    /**
     * 立即重载一次（人工入口：不等空闲、不受自动熔断限制）。
     *
     * @param {{reason?:string, auto?:boolean}} [options] 选项（auto=true 顺带解除自动熔断）
     * @returns {Promise<object>} 结果
     */
    async reloadNow({ reason = '手动', auto = false } = {}) {
      if (auto && autoDisabled) {
        autoDisabled = false;
        consecutiveFailures = 0;
        info('自动重载已恢复（人工指定 auto=1）');
      }
      if (busy) return { ok: false, error: '已有一次重载在进行中' };
      busy = true;
      pending.clear();
      try {
        const result = await hub.reload({ reason });
        if (result?.ok) stats.ok += 1;
        else { stats.failed += 1; }
        return result;
      } finally {
        busy = false;
        waitingSince = 0;
      }
    },

    /**
     * 取状态快照（面板 / 端点读面）。
     *
     * @returns {object} 快照
     */
    status() {
      const snapshot = typeof hub?.status === 'function' ? hub.status() : {};
      return {
        enabled: settings.enabled,
        started: startedAt > 0,
        autoDisabled,
        busy,
        settings: { ...settings },
        stats: { ...stats },
        pending: [...pending],
        appPending: [...appPending],
        waitingSince,
        lastEventAt: Number(snapshot.lastEventAt) || 0,
        reload: snapshot.reload ?? null,
        worker: snapshot.worker ?? null
      };
    }
  };
}
