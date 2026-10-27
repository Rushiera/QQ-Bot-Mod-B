// incident/login-watch.js —— 登录异常探针（掉登录现场取证）
//
// 职责：周期采样「QQ 登录态 / OneBot 通道 / 最后收到消息 / 最后发出消息」，异常时落一份现场快照。
// 边界：只读——不重启协议端、不重登、不改业务面状态；采样自身失败一律出声，不静默回落。
//
// 为什么要有它（2026-10-27 判例）：
//   那次掉登录，事后能拿到的只有「12:17:57 最后一条收消息」「12:33:01 起 QQ 内核 API 超时」
//   「13:10 重启后变成 waiting_qrcode」，平台侧一条 kickoff 证据都没留下——
//   「被踢」「网络断」「协议端卡死」三种成因无法区分。要区分，只能掉线前就开始持续留痕。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** 日志尾读上限（字节）——够覆盖最近几十条收发即可，不整文件读。 */
const MAX_TAIL_BYTES = 256 * 1024;

/** 快照与采样文件保留天数。 */
const KEEP_DAYS = 30;

/** 同一原因的快照去重窗口（毫秒）——一次故障只落一份现场。 */
const SNAPSHOT_DEDUPE_MS = 30 * 60 * 1000;

/** 快照里带多少条最近收发。 */
const RECENT_LIMIT = 20;

/**
 * 两位补零。
 *
 * @param {number} value 数值
 * @param {number} [width] 宽度
 * @returns {string} 补零结果
 */
function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/**
 * 日期键（yyyy-MM-dd）。
 *
 * @param {Date} [date] 时间
 * @returns {string} 日期串
 */
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 时间戳（yyyy-MM-dd HH:mm:ss）。
 *
 * @param {Date} [date] 时间
 * @returns {string} 时间串
 */
function stamp(date = new Date()) {
  return `${dayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 文件紧凑时间戳（yyyyMMdd-HHmmss）——用于快照文件名。
 *
 * @param {Date} [date] 时间
 * @returns {string} 紧凑时间串
 */
function compact(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 读文件尾部文本（文件不存在/读失败返回空串）。
 *
 * @param {string} file 文件路径
 * @param {number} [bytes] 尾读字节数
 * @returns {string} 尾部文本
 */
function readTail(file, bytes = MAX_TAIL_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return '';
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 取目录内按文件名排序最新的一个文件。
 *
 * @param {string} dir 目录
 * @param {string} [suffix] 扩展名过滤
 * @returns {string} 文件绝对路径（无匹配返回空串）
 */
function latestFile(dir, suffix = '') {
  try {
    const names = fs.readdirSync(dir).filter((name) => !suffix || name.endsWith(suffix)).sort();
    if (!names.length) return '';
    return path.join(dir, names[names.length - 1]);
  } catch {
    return '';
  }
}

/**
 * 解析业务面日志里的「发送」行。
 *
 * 形如：`12:04:37 [INFO ] [app] [发送 -> group:361820329] 正文…`
 *
 * @param {string} text 日志尾部文本
 * @returns {Array<{at: string, chat: string, text: string}>} 发送记录（按出现顺序）
 */
function parseSends(text) {
  const out = [];
  const re = /^(\d{2}:\d{2}:\d{2}).*?\[发送 -> (\w+):(\d+)\]\s*(.*)$/gm;
  let matched = re.exec(text);
  while (matched) {
    out.push({ at: matched[1], kind: matched[2], chat: matched[3], text: matched[4].trim() });
    matched = re.exec(text);
  }
  return out;
}

/**
 * 解析协议端日志里的「接收群聊」行。
 *
 * 形如：`10-27 12:17:57 [info] Shieraru | 接收 <- 群聊 [大耳的音趴交流-主群(312080198)] [哦鲸鲸(1808736969)] 正文`
 *
 * @param {string} text 日志尾部文本
 * @returns {Array<{at: string, group: string, groupId: string, user: string, userId: string, text: string}>} 接收记录
 */
function parseRecvs(text) {
  const out = [];
  const re = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}) .*?接收 <- 群聊 \[(.+?)\((\d+)\)\] \[(.+?)\((\d+)\)\]\s*(.*)$/gm;
  let matched = re.exec(text);
  while (matched) {
    out.push({
      at: matched[1],
      group: matched[2],
      groupId: matched[3],
      user: matched[4],
      userId: matched[5],
      text: matched[6].trim()
    });
    matched = re.exec(text);
  }
  return out;
}

/**
 * 把日志里的「MM-DD HH:mm:ss」补成完整时间再转毫秒（失败返回 0）。
 *
 * @param {string} text 时间片段
 * @returns {number} 毫秒时间戳（0 = 解析失败）
 */
function parseLogTime(text) {
  const matched = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!matched) return 0;
  const now = new Date();
  const date = new Date(now.getFullYear(), Number(matched[1]) - 1, Number(matched[2]),
    Number(matched[3]), Number(matched[4]), Number(matched[5]));
  return date.getTime();
}

/**
 * 端口连通探测。
 *
 * @param {number} port 端口
 * @param {number} [timeoutMs] 超时毫秒
 * @returns {Promise<boolean>} 是否可连
 */
async function portOpen(port, timeoutMs = 1500) {
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
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * 创建登录异常探针。
 *
 * @param {object} options 选项
 * @param {object} options.layout 协议端布局（取 logsDir 找它的日志）
 * @param {object} options.webuiApi 协议端 WebUI 客户端（loginStatus）
 * @param {string} options.businessLogDir 业务面日志目录（读「发送」行）
 * @param {string} options.dataDir 数据根（快照落 dataDir/incidents）
 * @param {object} options.log 日志器
 * @param {object} [options.ports] 通道端口 { ws, http }
 * @param {object} [options.tuning] 行为参数（intervalMs / silentMs / enabled）
 * @returns {object} 探针接口
 */
export function createLoginWatch({
  layout,
  webuiApi,
  businessLogDir,
  dataDir,
  log,
  ports = { ws: 3001, http: 3000 },
  tuning = {}
}) {
  const enabled = tuning.enabled !== false;
  const intervalMs = Math.max(10000, Number(tuning.intervalMs) || 30000);
  const silentMs = Math.max(60000, Number(tuning.silentMs) || 30 * 60 * 1000);
  const incidentDir = path.join(dataDir, 'incidents');

  let timer = null;
  let busy = false;
  const strikes = { loginDown: 0, coreDown: 0, webuiDown: 0, onebotDown: 0 };
  const lastSnapshotAt = new Map();

  /**
   * 一次采样（只读）。
   *
   * @returns {Promise<object>} 采样结果
   */
  async function sample() {
    const at = Date.now();
    const napcatLog = latestFile(layout.logsDir, '.log');
    const napcatText = napcatLog ? readTail(napcatLog) : '';
    const businessLog = latestFile(businessLogDir, '.log');
    const businessText = businessLog ? readTail(businessLog) : '';

    const recvs = parseRecvs(napcatText).slice(-RECENT_LIMIT);
    const sends = parseSends(businessText).slice(-RECENT_LIMIT);
    const lastRecv = recvs.length ? recvs[recvs.length - 1] : null;
    const lastSend = sends.length ? sends[sends.length - 1] : null;

    const lastRecvMs = lastRecv ? parseLogTime(lastRecv.at) : 0;
    const silentSec = lastRecvMs ? Math.round((at - lastRecvMs) / 1000) : null;

    let state = null;
    let webuiOk = true;
    try {
      const status = await webuiApi.loginStatus();
      webuiOk = status.code === 0;
      state = status.state ?? null;
    } catch {
      webuiOk = false;
    }

    const onebotWs = await portOpen(ports.ws);
    const onebotHttp = await portOpen(ports.http);

    return {
      at,
      atText: stamp(new Date(at)),
      webuiOk,
      isLogin: state?.isLogin ?? null,
      loginPhase: state?.loginPhase ?? '',
      coreReady: state?.coreReady ?? null,
      loginError: state?.loginError ?? '',
      onebotWs,
      onebotHttp,
      lastRecv,
      lastSend,
      silentSec,
      recentRecvs: recvs,
      recentSends: sends
    };
  }

  /**
   * 判定采样是否异常，更新连续计数并返回命中的原因列表。
   *
   * @param {object} data 采样结果
   * @returns {string[]} 原因列表（空 = 正常）
   */
  function judge(data) {
    const reasons = [];
    if (data.isLogin === null || data.webuiOk === false) {
      strikes.webuiDown += 1;
    } else {
      strikes.webuiDown = 0;
    }
    if (data.isLogin === false) strikes.loginDown += 1;
    else strikes.loginDown = 0;

    if (data.isLogin === true && data.coreReady === false) strikes.coreDown += 1;
    else strikes.coreDown = 0;

    if (!data.onebotWs) strikes.onebotDown += 1;
    else strikes.onebotDown = 0;

    // 阈值：协议端状态类问题连击 2 次才算（一次抖动不落现场）
    if (strikes.loginDown >= 2) reasons.push('login_down');
    if (strikes.coreDown >= 2) reasons.push('core_not_ready');
    if (strikes.webuiDown >= 3) reasons.push('webui_unreachable');
    if (strikes.onebotDown >= 3) reasons.push('onebot_down');
    if (data.silentSec !== null && data.silentSec * 1000 >= silentMs) reasons.push('silent_no_message');
    return reasons;
  }

  /**
   * 追加一行采样到当日 jsonl。
   *
   * @param {object} data 采样结果
   * @returns {void}
   */
  function appendWatchLine(data) {
    try {
      fs.mkdirSync(incidentDir, { recursive: true });
      const file = path.join(incidentDir, `watch-${dayKey()}.jsonl`);
      const line = JSON.stringify({
        at: data.atText,
        webuiOk: data.webuiOk,
        isLogin: data.isLogin,
        loginPhase: data.loginPhase,
        coreReady: data.coreReady,
        onebotWs: data.onebotWs,
        onebotHttp: data.onebotHttp,
        silentSec: data.silentSec,
        lastRecvAt: data.lastRecv?.at ?? '',
        lastRecvGroup: data.lastRecv ? `${data.lastRecv.group}(${data.lastRecv.groupId})` : '',
        lastSendAt: data.lastSend?.at ?? '',
        lastSendChat: data.lastSend ? `${data.lastSend.kind}:${data.lastSend.chat}` : ''
      });
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch (error) {
      log.warn('incident', `采样落盘失败：${error?.message ?? error}`);
    }
  }

  /**
   * 落一份现场快照（同原因 30 分钟内只落一次）。
   *
   * @param {object} data 采样结果
   * @param {string[]} reasons 命中的原因
   * @returns {void}
   */
  function writeSnapshot(data, reasons) {
    const now = Date.now();
    const fresh = reasons.filter((reason) => {
      const last = lastSnapshotAt.get(reason) ?? 0;
      return now - last >= SNAPSHOT_DEDUPE_MS;
    });
    if (!fresh.length) return;

    try {
      fs.mkdirSync(incidentDir, { recursive: true });
      const file = path.join(incidentDir, `${compact()}_${fresh.join('+')}.json`);
      const payload = {
        reasons: fresh,
        sampledAt: data.atText,
        uin: layout.uin,
        login: {
          webuiOk: data.webuiOk,
          isLogin: data.isLogin,
          loginPhase: data.loginPhase,
          coreReady: data.coreReady,
          loginError: data.loginError
        },
        channels: { onebotWs: data.onebotWs, onebotHttp: data.onebotHttp, wsPort: ports.ws, httpPort: ports.http },
        silence: { silentSec: data.silentSec, thresholdSec: Math.round(silentMs / 1000) },
        lastRecv: data.lastRecv,
        lastSend: data.lastSend,
        recentRecvs: data.recentRecvs,
        recentSends: data.recentSends
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      for (const reason of fresh) lastSnapshotAt.set(reason, now);
      log.warn('incident', `登录异常现场已落盘（${fresh.join(' / ')}）：${file}`);
    } catch (error) {
      log.error('incident', `现场快照写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * 清理过期产物。
   *
   * @returns {void}
   */
  function prune() {
    try {
      if (!fs.existsSync(incidentDir)) return;
      const deadline = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(incidentDir)) {
        const file = path.join(incidentDir, name);
        try {
          if (fs.statSync(file).mtimeMs < deadline) fs.unlinkSync(file);
        } catch { /* 单文件失败不影响其余清理 */ }
      }
    } catch (error) {
      log.warn('incident', `过期清理失败：${error?.message ?? error}`);
    }
  }

  /**
   * 跑一次采样并处理判定（供定时器与旁路脚本共用）。
   *
   * @returns {Promise<object|null>} 采样结果（跳过时返回 null）
   */
  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const data = await sample();
      appendWatchLine(data);
      const reasons = judge(data);
      if (reasons.length) writeSnapshot(data, reasons);
      return data;
    } catch (error) {
      log.warn('incident', `采样异常：${error?.message ?? error}`);
      return null;
    } finally {
      busy = false;
    }
  }

  /**
   * 启动周期采样。
   *
   * @returns {void}
   */
  function start() {
    if (!enabled) {
      log.info('incident', '登录探针未启用（incident.enabled=false）');
      return;
    }
    if (timer) return;
    prune();
    log.info('incident', `登录探针就绪：每 ${Math.round(intervalMs / 1000)} 秒采样，`
      + `静默阈值 ${Math.round(silentMs / 60000)} 分钟，产物 ${incidentDir}`);
    timer = setInterval(() => { tick(); }, intervalMs);
    setTimeout(() => { tick(); }, 5000);
  }

  /**
   * 停止周期采样。
   *
   * @returns {void}
   */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, sample, incidentDir };
}
