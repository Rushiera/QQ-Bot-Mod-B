// business.js —— 业务面（QQ Agent）配置接口客户端
//
// 职责：读业务面生效配置里的群名单（allow / deny），以及把修改写回业务面。
//       另承载单体 ⇄ 业务面的**事件与进程通道**（createBusinessHub）：一条 WS 收事件、
//       分发给 navigator 与 business 两个消费者，业务面按子进程隔离启动。
// 边界：
//   · 只经业务面自己的 HTTP 接口读写，**绝不直改 `_unpack/data/config.json`**——业务面把
//     配置加载在内存里（`getConfig()` 单例），直改磁盘它不重读：表现为「文件改了、名单没变」，
//     要等下一次重启才生效。
//   · 只承载群名单这一块语义；业务面的其他配置项不在此代理（改它们仍走业务面自己的设置页）。
//   · 业务面不在线时如实报错，不回落本地文件、不假装成功。
//   · 地址不是写死的一个端口：业务面从 3210 起向上找空位，起在 3211 时写死的地址就挑空了。
//     故按配置地址优先 + 端口段探测，并校验响应确实是业务面（含 allow.groups）才算命中。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSG, EXIT_CODE, LIMITS, eventFingerprint } from './business/bridge-protocol.js';

/** 本文件所在目录（app/src）——业务面 worker 与默认数据根都相对它解析。 */
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 端口段探测范围（业务面 `server.port` 起向上 10 个，与它的监听逻辑同口径）。 */
const PORT_SPAN = 10;

/** 业务面子进程入口（归位后的 app/src/business/worker.js）。 */
const DEFAULT_WORKER = path.join(SRC_DIR, 'business', 'worker.js');
/** 业务面默认数据根（D4 裁决：钉在 QQBotB 的 _unpack/data）。 */
const DEFAULT_DATA_DIR = path.resolve(SRC_DIR, '..', '..', '_unpack', 'data');
/** 重启退避基数（3s → 6s → 12s）。 */
const RESTART_BASE_MS = 3000;
/** 子进程连续存活满该时长即视为「健康」，清掉此前累计的重启次数——防长跑进程攒够 3 次就永久降级。 */
const HEALTHY_UPTIME_MS = 5 * 60 * 1000;
/** 同一消费者连续失败到该阈值时把日志升为 error（此前只 warn）。 */
const CONSECUTIVE_FAIL_LIMIT = 5;

/**
 * 创建业务面配置客户端。
 *
 * @param {object} options 选项
 * @param {string} options.apiUrl 业务面接口根地址（如 http://127.0.0.1:3210）
 * @param {object} options.log 日志器
 * @param {string} [options.token] 业务面管理令牌（对应它的 `server.token`；空 = 它未设令牌，免授权）
 * @param {number} [options.timeoutMs] 单次请求超时毫秒
 * @returns {object} 客户端接口
 */
export function createBusinessClient({ apiUrl, log, token = '', timeoutMs = 8000 }) {
  /** 已确认可用的根地址（探测一次后复用，省掉每次请求都扫端口段）。 */
  let resolvedBase = '';

  /**
   * 发请求并解析 JSON（超时即中止）。
   *
   * @param {string} base 根地址
   * @param {string} path 接口路径
   * @param {object} [options] fetch 选项
   * @returns {Promise<object>} 响应体
   */
  async function requestAt(base, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          // 业务面若设了 server.token，读写面都按 x-console-token 校验；未设则忽略此头
          ...(token ? { 'x-console-token': token } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`响应不是 JSON（${base}${path}，HTTP ${response.status}）`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${body?.error ? `：${body.error}` : ''}`);
      }
      return body ?? {};
    } catch (error) {
      const message = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(error?.message ?? error);
      throw new Error(`${base}${path} ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 判一段响应是不是业务面的配置（群名单字段的真实形态）。
   *
   * @param {object} body 响应体
   * @returns {boolean} 是否是业务面配置
   */
  function looksLikeBusinessConfig(body) {
    return !!body && typeof body === 'object'
      && !!body.allow && Array.isArray(body.allow.groups)
      && !!body.deny && Array.isArray(body.deny.groups);
  }

  /**
   * 解析业务面根地址：配置地址优先，其后按端口段探测。
   *
   * @returns {Promise<string>} 命中的根地址
   */
  async function resolveBase() {
    if (resolvedBase) return resolvedBase;

    const candidates = [];
    const configured = String(apiUrl || '').replace(/\/+$/, '');
    if (configured) candidates.push(configured);
    // 端口段探测：配置地址若是已知形态（http://host:port），从该端口起扫一段
    let host = '127.0.0.1';
    let port = 3210;
    try {
      const parsed = new URL(configured || 'http://127.0.0.1:3210');
      host = parsed.hostname;
      port = Number(parsed.port) || 80;
    } catch { /* 配置地址非法时用默认段 */ }
    for (let p = port; p < port + PORT_SPAN; p += 1) {
      const candidate = `http://${host}:${p}`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }

    const failures = [];
    for (const candidate of candidates) {
      try {
        const body = await requestAt(candidate, '/api/config');
        if (!looksLikeBusinessConfig(body)) {
          failures.push(`${candidate}：不是业务面配置接口`);
          continue;
        }
        resolvedBase = candidate;
        if (candidate !== configured) {
          log.warn('business', `业务面实际监听 ${candidate}（配置为 ${configured || '空'}）——已自动切换`);
        }
        return resolvedBase;
      } catch (error) {
        failures.push(String(error?.message ?? error));
      }
    }
    throw new Error(`业务面不可达（已试 ${candidates.length} 个地址）：${failures.join('；')}`);
  }

  /**
   * 判一次失败是不是「地址不可达」类（业务面重启 / 让位换端口）。
   *
   * 这类失败重试一次就能恢复；语义类失败（同群冲突 / 不是业务面）重试无用，直接抛。
   *
   * @param {Error} error 失败
   * @returns {boolean} 是否值得重试
   */
  function isUnreachable(error) {
    const text = String(error?.message ?? error);
    return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|超时/.test(text);
  }

  /**
   * 带一次重试地执行请求（只对地址类失败重试）。
   *
   * 重试前清掉已解析地址——业务面重启中可能换了端口。连点重排、业务面短暂卡住
   * 都会走这条：一次「fetch failed」不应该变成界面上一条失败提示。
   *
   * @param {Function} fn 待执行动作
   * @returns {Promise<*>} 动作结果
   */
  async function withRetry(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      resolvedBase = '';
      log.warn('business', `请求失败（${error?.message ?? error}），清掉已解析地址后重试一次`);
      return await fn();
    }
  }

  /**
   * 把群号清单规整成干净数组（去空白、去重、只留数字）。
   *
   * @param {unknown} value 原始值
   * @returns {string[]} 群号数组
   */
  function normalizeIds(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of list) {
      const id = String(item ?? '').trim();
      if (!id) continue;
      if (!/^\d+$/.test(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * 读群名单现状。
   *
   * @returns {Promise<object>} `{ ok, apiUrl, allowGroups, denyGroups, allowAllWhenEmpty }`
   */
  async function readLists() {
    return withRetry(async () => {
      const base = await resolveBase();
      const config = await requestAt(base, '/api/config');
      return {
        ok: true,
        apiUrl: base,
        allowGroups: normalizeIds(config?.allow?.groups),
        denyGroups: normalizeIds(config?.deny?.groups),
        allowAllWhenEmpty: config?.allowAllWhenEmpty === true
      };
    });
  }

  /**
   * 写群名单（只覆盖这三个字段，其余配置原样保留）。
   *
   * @param {object} patch 待写入内容
   * @param {string[]} patch.allowGroups 允许群号
   * @param {string[]} patch.denyGroups 拒绝群号
   * @param {boolean} [patch.allowAllWhenEmpty] 空名单时是否放行全部
   * @returns {Promise<object>} 写后实况（读回）
   */
  async function writeLists({ allowGroups, denyGroups, allowAllWhenEmpty }) {
    const allow = normalizeIds(allowGroups);
    const deny = normalizeIds(denyGroups);
    const overlap = allow.filter((id) => deny.includes(id));
    if (overlap.length) {
      throw new Error(`同一群同时出现在允许与拒绝名单：${overlap.join(', ')}`);
    }
    const base = await resolveBase();
    const patch = { allow: { groups: allow }, deny: { groups: deny } };
    if (typeof allowAllWhenEmpty === 'boolean') patch.allowAllWhenEmpty = allowAllWhenEmpty;
    await withRetry(() => requestAt(base, '/api/config', { method: 'POST', body: JSON.stringify(patch) }));
    const after = await readLists();
    log.info('business', `群名单已写入：允许 ${after.allowGroups.length} 个 / 拒绝 ${after.denyGroups.length} 个`);
    return { ok: true, apiUrl: after.apiUrl, allowGroups: after.allowGroups, denyGroups: after.denyGroups, allowAllWhenEmpty: after.allowAllWhenEmpty };
  }

  /**
   * 拉协议端当前所在群（群号 + 群名）——供界面辨识群号，不参与写入。
   *
   * @returns {Promise<object>} `{ ok, groups }`；业务面离线或协议端未连时 `ok:false`
   */
  async function readOnlineGroups() {
    try {
      return await withRetry(async () => {
        const base = await resolveBase();
        const body = await requestAt(base, '/api/onebot/groups');
        const groups = (Array.isArray(body?.groups) ? body.groups : []).map((g) => ({
          id: String(g?.id ?? '').trim(),
          name: String(g?.name ?? '').trim()
        })).filter((g) => g.id);
        return { ok: true, groups };
      });
    } catch (error) {
      return { ok: false, groups: [], error: String(error?.message ?? error) };
    }
  }

  return { readLists, writeLists, readOnlineGroups };
}

// ─────────────────────────────────────────────────────────────────────────────
// 事件分发与子进程守护：createBusinessHub
//
// 定位：单体 ⇄ 业务面的唯一事件通道。一条 OneBot WS 在单体侧（app/src/onebot/client.js），
//       本函数是该 WS 的**唯一订阅点**（onebot.onEvent），把事件扇出给两个消费者：
//         · navigator —— 默认 kind='self'：它已在 navigator/index.js 自订阅，hub 只登记不投（防双投）；
//                        传 navigatorDeliver 则改由 hub 投递（kind='inline'）
//         · business  —— kind='ipc'（子进程，IPC 转发；本轮）或 'inline'（同进程，验收后切换用）
//
// 不丢不重三判据：
//   ① 去重：入口按事件指纹（bridge-protocol.js · eventFingerprint）去重，命中即丢并计数 duplicates
//      —— 挡「断线重连 / 父侧重启 / 协议端重放」造成的第二条消息
//   ② 防重：父侧给每条事件编单调 seq，子侧对 seq ≤ lastSeq 的丢弃并计数（第二道闸门，见 event-bridge.js）
//   ③ 不丢：子进程 ready 前的事件进缓冲（上限 LIMITS.bufferMax，溢出计入 droppedOverflow 并出声），
//      ready 后按序灌入；每个消费者一条 FIFO 串行队列，保序且不跳过
//   边界（诚实口径）：父侧 IPC 发送失败的条目**不重投**——重投等于重复发消息；只计入 sendFailures 并出声。
//     故“不丢”= 不静默丢，不是“必达一次以上”。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建业务面事件分发中心（含子进程守护）。
 *
 * @param {object} options 选项
 * @param {object} options.onebot 单体侧 OneBot 客户端（唯一 WS 宿主，需有 onEvent/status）
 * @param {object} options.log 日志器（info/warn/error）
 * @param {string} [options.mode] `child`（子进程隔离，默认）| `inline`（同进程）
 * @param {string} [options.dataDir] 业务面数据根（子进程经 QQ_AGENT_DATA_DIR 注入）
 * @param {string} [options.workerPath] 子进程入口（默认 app/src/business/worker.js）
 * @param {Function|null} [options.deliver] mode=inline 时的业务面投递函数
 * @param {Function|null} [options.navigatorDeliver] 传了则由 hub 投递导航消费者
 * @param {number} [options.restartMax] 子进程最大重启次数（默认 3，用尽即降级停投）
 * @param {number} [options.healthIntervalMs] 健康巡检间隔（默认 60000；0=不巡检）
 * @returns {object} 分发中心接口
 */
export function createBusinessHub({
  onebot,
  log,
  mode = 'child',
  dataDir = DEFAULT_DATA_DIR,
  workerPath = DEFAULT_WORKER,
  deliver = null,
  navigatorDeliver = null,
  restartMax = 3,
  healthIntervalMs = 60_000
} = {}) {
  const info = (text) => (typeof log?.info === 'function' ? log.info('business', text) : console.log(text));
  const warn = (text) => (typeof log?.warn === 'function' ? log.warn('business', text) : console.warn(text));
  const error = (text) => (typeof log?.error === 'function' ? log.error('business', text) : console.error(text));

  /** 计数（全部对外暴露在 status()——集合缩水必须可观测）。 */
  const stats = {
    received: 0,
    dispatched: 0,
    duplicates: 0,
    failures: 0,
    droppedOverflow: 0,
    droppedByConsumer: {},
    sendFailures: 0,
    workerExits: 0,
    healthFailures: 0
  };

  /** 事件指纹表（指纹 → 首次见到的时间戳；超 capacity FIFO 淘汰）。 */
  const dedup = new Map();
  /** 子进程 ready 前的事件缓冲（保序）。 */
  const workerBuffer = [];

  let child = null;
  let childReady = false;
  let childPort = 0;
  let childPid = 0;
  /** 本次子进程拉起时刻（判「健康存活」用；0 = 未拉起）。 */
  let childStartedAt = 0;
  let restarts = 0;
  let lastExitCode = null;
  let stopping = false;
  let sendSeq = 0;
  let healthTimer = null;
  let unsubEvent = null;

  /** 消费者表——两个，各自独立队列与失败计数（一个抛错不影响另一个）。 */
  const consumers = [
    {
      name: 'navigator',
      kind: navigatorDeliver ? 'inline' : 'self',
      deliver: navigatorDeliver,
      queue: [],
      busy: false,
      paused: false,
      delivered: 0,
      failed: 0,
      consecutiveFailures: 0
    },
    {
      name: 'business',
      kind: mode === 'inline' ? 'inline' : 'ipc',
      deliver: deliver,
      queue: [],
      busy: false,
      paused: false,
      delivered: 0,
      failed: 0,
      consecutiveFailures: 0
    }
  ];

  /** 按名字取消费者。 */
  const consumerOf = (name) => consumers.find((c) => c.name === name) ?? null;

  /**
   * 记录一次消费者失败——逐条隔离，不重投、不打断该消费者后续事件。
   *
   * @param {object} consumer 消费者
   * @param {Error|*} reason 异常
   * @returns {void}
   */
  function onConsumerFail(consumer, reason) {
    consumer.failed += 1;
    consumer.consecutiveFailures += 1;
    stats.failures += 1;
    const text = String(reason?.message ?? reason);
    if (consumer.consecutiveFailures === CONSECUTIVE_FAIL_LIMIT) {
      error(`[${consumer.name}] 连续失败 ${consumer.consecutiveFailures} 次，最近一次：${text}`);
    } else {
      warn(`[${consumer.name}] 第 ${consumer.failed} 次投递失败（已隔离、不重投）：${text}`);
    }
  }

  /**
   * 驱动某消费者的串行队列（FIFO，同一时刻只跑一条，保证事件顺序）。
   *
   * @param {object} consumer 消费者
   * @returns {void}
   */
  function pump(consumer) {
    if (consumer.busy) return;
    const task = consumer.queue.shift();
    if (!task) return;
    consumer.busy = true;
    let result;
    try {
      result = consumer.deliver ? consumer.deliver(task) : undefined;
    } catch (reason) {
      onConsumerFail(consumer, reason);
      consumer.busy = false;
      pump(consumer);
      return;
    }
    Promise.resolve(result).then(
      () => {
        consumer.delivered += 1;
        consumer.consecutiveFailures = 0;
      },
      (reason) => { onConsumerFail(consumer, reason); }
    ).then(() => {
      consumer.busy = false;
      pump(consumer);
    });
  }

  /**
   * IPC 投递（business 消费者 kind='ipc' 的实现）。
   *
   * @param {object} task `{ event, fp }`
   * @returns {boolean} 已交给 IPC
   */
  function sendToWorker(task) {
    if (!child || !child.connected) throw new Error('业务面子进程未就绪（IPC 通道不可用）');
    sendSeq += 1;
    try {
      child.send({ type: MSG.EVENT, seq: sendSeq, payload: task.event });
      return true;
    } catch (reason) {
      stats.sendFailures += 1;
      throw new Error(`IPC 投递失败（seq=${sendSeq}，不重投）：${reason?.message ?? reason}`);
    }
  }

  if (consumers[1].kind === 'ipc') consumers[1].deliver = sendToWorker;

  /**
   * 事件入口——唯一订阅点收到事件后走这里。
   *
   * @param {object} event OneBot 事件体
   * @returns {boolean} 是否至少投给了一个消费者
   */
  function dispatch(event) {
    stats.received += 1;
    const fp = eventFingerprint(event);
    if (fp) {
      const seenAt = dedup.get(fp);
      if (seenAt !== undefined && Date.now() - seenAt <= LIMITS.dedupTtlMs) {
        stats.duplicates += 1;
        return false;
      }
      if (seenAt === undefined && dedup.size >= LIMITS.dedupWindow) {
        const oldest = dedup.keys().next().value;
        if (oldest !== undefined) dedup.delete(oldest);
      }
      dedup.set(fp, Date.now());
    }

    let queued = 0;
    for (const consumer of consumers) {
      if (consumer.paused) {
        stats.droppedByConsumer[consumer.name] = (stats.droppedByConsumer[consumer.name] ?? 0) + 1;
        continue;
      }
      if (consumer.kind === 'self') continue;   // 自订阅消费者：hub 不投，避免同一消费者收两份
      if (consumer.kind === 'ipc' && !childReady) {
        if (workerBuffer.length >= LIMITS.bufferMax) {
          workerBuffer.shift();
          stats.droppedOverflow += 1;
          error(`子进程未就绪缓冲溢出（上限 ${LIMITS.bufferMax}），丢弃最旧一条（累计 ${stats.droppedOverflow}）`);
        }
        workerBuffer.push({ event, fp });
        continue;
      }
      if (consumer.queue.length >= LIMITS.pendingMax) {
        stats.droppedOverflow += 1;
        error(`[${consumer.name}] 队列溢出（上限 ${LIMITS.pendingMax}），丢弃最新一条（累计 ${stats.droppedOverflow}）`);
        continue;
      }
      consumer.queue.push({ event, fp });
      pump(consumer);
      queued += 1;
    }
    stats.dispatched += queued;
    return queued > 0;
  }

  /** 把该流按行转发进日志（子进程 stdout/stderr → 父侧日志，含 worker 前缀）。 */
  function pipeLines(stream, level) {
    if (!stream) return;
    let rest = '';
    stream.on('data', (chunk) => {
      rest += String(chunk);
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        if (level === 'warn') warn(`[worker] ${text}`);
        else info(`[worker] ${text}`);
      }
    });
  }

  /**
   * 把单体侧连接态推给子进程（业务面多处读 onebot.connected 决定“能不能发”）。
   *
   * @returns {void}
   */
  function pushStatus() {
    if (!child || !child.connected) return;
    const snapshot = typeof onebot?.status === 'function' ? onebot.status() : {};
    const self = snapshot.self
      ? { user_id: snapshot.self.userId, nickname: snapshot.self.nickname }
      : null;
    try {
      child.send({ type: MSG.STATUS, connected: snapshot.connected === true, selfInfo: self });
    } catch (reason) {
      warn(`连接态推送失败：${reason?.message ?? reason}`);
    }
  }

  /**
   * 业务面健康检查：HTTP 探活 + 身份判据（响应必须是业务面配置，含 allow.groups）。
   *
   * @param {number} port 业务面 HTTP 端口
   * @param {number} [attempts] 尝试轮次
   * @param {number} [delayMs] 每轮间隔
   * @returns {Promise<{ok:boolean, base?:string, failures?:string[]}>} 结果
   */
  async function checkHealth(port, attempts = 10, delayMs = 500) {
    const base = `http://127.0.0.1:${port}`;
    const failures = [];
    for (let i = 0; i < attempts; i += 1) {
      try {
        const response = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) {
          failures.push(`HTTP ${response.status}`);
        } else {
          const body = await response.json().catch(() => null);
          if (body && body.allow && Array.isArray(body.allow.groups)) return { ok: true, base };
          failures.push('响应不是业务面配置（缺 allow.groups）');
        }
      } catch (reason) {
        failures.push(String(reason?.message ?? reason));
      }
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { ok: false, failures };
  }

  /** 子进程就绪后按序灌入缓冲事件。 */
  function flushBuffer() {
    const consumer = consumerOf('business');
    if (!consumer) return;
    const pending = workerBuffer.splice(0, workerBuffer.length);
    let moved = 0;
    for (const task of pending) {
      if (consumer.queue.length >= LIMITS.pendingMax) {
        stats.droppedOverflow += 1;
        continue;
      }
      consumer.queue.push(task);
      moved += 1;
    }
    if (pending.length) info(`子进程就绪，灌入缓冲事件 ${moved}/${pending.length} 条`);
    pump(consumer);
  }

  /** 子进程退出后的重启安排（退避 3s/6s/12s；用尽或 CONFIG 错即降级停投）。 */
  function scheduleRestart() {
    if (stopping) return;
    const consumer = consumerOf('business');
    // CONFIG 码（数据根/单实例锁）重试必然同样失败：只给一次机会
    if ((lastExitCode === EXIT_CODE.CONFIG && restarts >= 1) || restarts >= restartMax) {
      if (consumer && !consumer.paused) {
        consumer.paused = true;
        error(`业务面不可用（重启 ${restarts} 次，lastExitCode=${lastExitCode}）——事件投递降级停止，计数见 status()`);
      }
      return;
    }
    restarts += 1;
    const delay = RESTART_BASE_MS * 2 ** (restarts - 1);
    warn(`将在 ${Math.round(delay / 1000)} 秒后重启业务面子进程（第 ${restarts}/${restartMax} 次，上次退出码 ${lastExitCode}）`);
    const timer = setTimeout(() => {
      if (!stopping) spawnWorker();
    }, delay);
    timer.unref?.();
  }

  /**
   * 处理子进程 IPC 消息。
   *
   * @param {object} message 消息体
   * @returns {Promise<void>} 完成
   */
  async function onWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case MSG.READY: {
        const proc = child;
        childPort = Number(message.port) || 0;
        childPid = message.pid ?? childPid;
        info(`业务面子进程已就绪：pid=${childPid} port=${childPort}（启动 ${message.startedInMs ?? '?'}ms）`);
        const health = await checkHealth(childPort);
        // 健康检查是异步的：这期间子进程可能已经退出/被换掉，换了就不再认这份 ready
        if (child !== proc) return;
        if (!health.ok) {
          stats.healthFailures += 1;
          error(`业务面健康检查失败（${childPort}）：${(health.failures ?? []).slice(-2).join('；')}——重启`);
          try { child?.kill(); } catch { /* 已被回收 */ }
          return;
        }
        childReady = true;
        flushBuffer();
        pushStatus();
        break;
      }
      case MSG.PONG: {
        childReady = true;
        if (typeof message.duplicates === 'number' && message.duplicates > 0) {
          warn(`子侧累计丢弃重复事件 ${message.duplicates} 条（seq 回退）`);
        }
        pushStatus();
        break;
      }
      case MSG.ERROR: {
        error(`业务面子进程上报致命错误（code=${message.code}）：${message.message}`);
        break;
      }
      default: {
        warn(`未知 IPC 消息类型（已忽略）：${String(message.type)}`);
      }
    }
  }

  /** 拉起业务面子进程（子进程隔离启动的唯一入口）。 */
  function spawnWorker() {
    if (stopping) return;
    if (!workerPath) {
      error('未配置业务面 worker 入口（workerPath 为空）——事件无人消费，投递将走缓冲');
      return;
    }
    let proc = null;
    try {
      proc = spawn(process.execPath, [workerPath], {
        env: {
          ...process.env,
          // D4：数据根由父进程注入，业务面拒绝回落源码目录（未注入即 CONFIG 退出）
          QQ_AGENT_DATA_DIR: dataDir,
          QQBOTB_TRANSPORT: 'ipc'
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
      });
    } catch (reason) {
      lastExitCode = EXIT_CODE.STARTUP;
      error(`业务面子进程拉起失败：${reason?.message ?? reason}`);
      scheduleRestart();
      return;
    }
    child = proc;
    childPid = proc.pid ?? 0;
    childStartedAt = Date.now();
    childReady = false;
    childPort = 0;
    pipeLines(proc.stdout, 'info');
    pipeLines(proc.stderr, 'warn');
    proc.on('message', (message) => { onWorkerMessage(message).catch((reason) => warn(`IPC 处理异常：${reason?.message ?? reason}`)); });
    proc.on('error', (reason) => {
      lastExitCode = EXIT_CODE.STARTUP;
      error(`业务面子进程错误：${reason?.message ?? reason}`);
      scheduleRestart();
    });
    proc.on('exit', (code, signal) => {
      child = null;
      childReady = false;
      childPort = 0;
      lastExitCode = code;
      stats.workerExits += 1;
      // 健康存活过的子进程退出（长跑后再崩）：清掉重启计数——否则长跑进程「攒够 restartMax 次」就永久停投
      const uptimeMs = childStartedAt ? Date.now() - childStartedAt : 0;
      childStartedAt = 0;
      if (uptimeMs >= HEALTHY_UPTIME_MS && restarts > 0) {
        info(`子进程存活 ${Math.round(uptimeMs / 1000)} 秒（≥健康阈值 ${Math.round(HEALTHY_UPTIME_MS / 1000)} 秒）——重启计数从 ${restarts} 清零`);
        restarts = 0;
      }
      if (stopping) {
        info(`业务面子进程已退出（停机流程，code=${code}）`);
        return;
      }
      error(`业务面子进程退出：code=${code} signal=${signal ?? '-'}`);
      scheduleRestart();
    });
    info(`业务面子进程已拉起：pid=${childPid}（数据根 ${dataDir}）`);
  }

  /** 周期健康巡检：HTTP 失活即杀掉重启；否则顺带刷新连接态。 */
  async function tick() {
    if (!childReady || !childPort) return;
    const health = await checkHealth(childPort, 1, 0);
    if (!health.ok) {
      stats.healthFailures += 1;
      error(`业务面健康检查失败（${childPort}）：${(health.failures ?? []).join('；')}——重启`);
      try { child?.kill(); } catch { /* 已被回收 */ }
      return;
    }
    pushStatus();
  }

  return {
    /**
     * 启动分发：订阅单条 WS + （child 模式）拉起子进程。
     *
     * @returns {object} 状态快照
     */
    start() {
      if (typeof onebot?.onEvent !== 'function') {
        throw new Error('createBusinessHub：onebot 缺少 onEvent（需单体侧 OneBot 客户端实例）');
      }
      if (!unsubEvent) {
        // 🔴 唯一订阅点：整条链路只在这里订阅一次，扇出由 consumers 表负责
        unsubEvent = onebot.onEvent(dispatch);
      }
      if (mode === 'child') spawnWorker();
      if (healthIntervalMs > 0) {
        healthTimer = setInterval(() => { tick().catch(() => {}); }, healthIntervalMs);
        healthTimer.unref?.();
      }
      return this.status();
    },

    /**
     * 停止分发（幂等）：退订 → 通知子进程优雅退出 → 超时强杀。
     *
     * @returns {Promise<void>} 完成
     */
    async stop() {
      stopping = true;
      if (typeof unsubEvent === 'function') {
        unsubEvent();
        unsubEvent = null;
      }
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      const proc = child;
      if (!proc) return;
      const exited = new Promise((resolve) => { proc.once('exit', resolve); });
      try { proc.send({ type: MSG.SHUTDOWN }); } catch { /* 通道已断：走强杀 */ }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child) {
        try { child.kill(); } catch { /* 已退出 */ }
      }
    },

    /**
     * 取状态快照（分发表 + 子进程面）。
     *
     * @returns {object} 快照
     */
    status() {
      return {
        mode,
        dataDir,
        received: stats.received,
        dispatched: stats.dispatched,
        duplicates: stats.duplicates,
        failures: stats.failures,
        droppedOverflow: stats.droppedOverflow,
        droppedByConsumer: { ...stats.droppedByConsumer },
        sendFailures: stats.sendFailures,
        buffered: workerBuffer.length,
        consumers: consumers.map((c) => ({
          name: c.name,
          kind: c.kind,
          paused: c.paused,
          queued: c.queue.length,
          delivered: c.delivered,
          failed: c.failed
        })),
        worker: {
          pid: childPid,
          port: childPort,
          ready: childReady,
          restarts,
          lastExitCode,
          exits: stats.workerExits,
          healthFailures: stats.healthFailures
        }
      };
    },

    /** 子进程就绪后业务面 HTTP 根地址（未就绪返回空串——调用方据此判“业务面不可达”）。 */
    apiBase() {
      return childReady && childPort ? `http://127.0.0.1:${childPort}` : '';
    },

    /** 直接投一条事件（冒烟 / 影子对比可用：不经 WS 也能验分发链）。 */
    dispatch
  };
}
