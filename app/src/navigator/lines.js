// navigator/lines.js —— 领航员「线」表（A 方案 · 2026-11-09）
//
// 职责：把「一次派活」登记成可判定的线——派给谁 / 什么群 / 什么状态 / 什么时候交的报告。
// 边界：只做线表存取与状态跃迁（机械判据）；不判断该不该派活、不发消息。
//       出站策略在 index.js 的 emitOutbound：线内首报发群，线外静默。
// 依据：并发协议「换相粒度 = 线，不是轮」（WorkSpace:tools/并发协议/README.md §三）。
// 状态机：running（已派活等回复）→ reported（交过报告）→ closed（收线）。
//         blocked 留给人工/异常置位（A 期不自动判）。

import fs from 'node:fs';
import path from 'node:path';

/** 线状态。 */
export const LINE_STATUS = {
  RUNNING: 'running',
  REPORTED: 'reported',
  CLOSED: 'closed',
  BLOCKED: 'blocked'
};

/** 线表保留条数（超过按时间淘汰最旧的 closed 线）。 */
const LINE_LIMIT = 200;

/** 指令原文在表里的截断长度（字符）——只为「这是哪条活」可辨，不存全文。 */
const TEXT_MAX = 200;

/**
 * 创建线表。
 *
 * @param {object} options 选项
 * @param {string} options.file 线表文件绝对路径（app/data/nav-lines.json）
 * @param {object} options.log 日志器
 * @param {number} [options.limit] 保留条数上限
 * @returns {object} 线表接口
 */
export function createLineStore({ file, log, limit = LINE_LIMIT }) {
  let seq = 0;
  let lines = [];

  /** 从磁盘加载（缺失 → 空表；损坏 → 告警 + 空表，不静默吞错）。 */
  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(text);
      lines = Array.isArray(data?.lines) ? data.lines : [];
      seq = Number(data?.seq) || 0;
    } catch (error) {
      log.warn('navigator', `线表读取失败，回落空表：${error?.message ?? error}`);
      lines = [];
      seq = 0;
    }
  }

  /** 落盘（原子写：临时文件 → 替换）。 */
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq, lines }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      log.error('navigator', `线表落盘失败：${error?.message ?? error}`);
    }
  }

  /** 淘汰：只裁 closed，先按时间裁到上限。 */
  function prune() {
    if (lines.length <= limit) return;
    const closed = lines.filter((item) => item.status === LINE_STATUS.CLOSED);
    const keep = lines.filter((item) => item.status !== LINE_STATUS.CLOSED);
    const room = Math.max(0, limit - keep.length);
    const kept = closed.slice(-room);
    lines = [...keep, ...kept].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  }

  /**
   * 开一条线。
   *
   * 同一只猫再派活时，它此前仍在 running 的线自动收线（`note='superseded'`）——
   * 一个人同时只有一双手，旧线挂在那里只会让「线内/线外」判据失效。
   *
   * @param {object} entry 线内容
   * @param {string|number|null} entry.chat 回消息群
   * @param {string} entry.key 目标猫
   * @param {string} [entry.name] 猫显示名
   * @param {string} entry.text 指令原文
   * @param {string} [entry.by] 触发通道（qq / app）
   * @returns {object} 新线
   */
  function add({ chat = null, key = '', name = '', text = '', by = 'app' } = {}) {
    const at = Date.now();
    const target = String(key || '');
    for (const item of lines) {
      if (item.status === LINE_STATUS.RUNNING && String(item.key) === target) {
        item.status = LINE_STATUS.CLOSED;
        item.closedAt = at;
        item.note = 'superseded';
      }
    }
    seq += 1;
    const line = {
      id: `L${seq}`,
      chat: chat === null || chat === undefined ? '' : String(chat),
      key: target,
      name: String(name || target),
      text: String(text || '').slice(0, TEXT_MAX),
      by: String(by || 'app'),
      status: LINE_STATUS.RUNNING,
      at,
      reportedAt: 0,
      closedAt: 0,
      rounds: 0,
      note: ''
    };
    lines.push(line);
    prune();
    save();
    log.info('navigator', `线 ${line.id} 开出 → ${line.name}（群 ${line.chat || '未定'}）`);
    return line;
  }

  /**
   * 取某只猫当前在跑的线（同猫只会有一条——派新活即收旧线）。
   *
   * @param {string} key 猫 key（id / 显示名均可比）
   * @returns {object|null} 线；没有则 null
   */
  function activeFor(key) {
    const target = String(key || '');
    if (!target) return null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const item = lines[i];
      if (item.status === LINE_STATUS.RUNNING && (String(item.key) === target || String(item.name) === target)) {
        return item;
      }
    }
    return null;
  }

  /**
   * 标「交报告」——线内第一次拿到回复时调用（幂等：重复调用只累加 rounds）。
   *
   * @param {string} id 线号
   * @param {object} [options] 选项
   * @param {number} [options.rounds] 本次新增轮数
   * @returns {object|null} 线；未命中 null
   */
  function markReported(id, { rounds = 0 } = {}) {
    const line = lines.find((item) => item.id === String(id));
    if (!line) return null;
    if (line.status === LINE_STATUS.RUNNING) {
      line.status = LINE_STATUS.REPORTED;
      line.reportedAt = Date.now();
    }
    line.rounds = Math.max(0, Number(line.rounds) || 0) + Math.max(0, Number(rounds) || 0);
    save();
    return line;
  }

  /**
   * 收一条线。
   *
   * @param {string} id 线号
   * @param {string} [note] 收线原因
   * @returns {object|null} 线；未命中 null
   */
  function close(id, note = '') {
    const line = lines.find((item) => item.id === String(id));
    if (!line) return null;
    line.status = LINE_STATUS.CLOSED;
    line.closedAt = Date.now();
    if (note) line.note = String(note);
    save();
    return line;
  }

  /**
   * 标阻塞（人工或异常路径用；A 期不自动判）。
   *
   * @param {string} id 线号
   * @param {string} [note] 原因
   * @returns {object|null} 线；未命中 null
   */
  function block(id, note = '') {
    const line = lines.find((item) => item.id === String(id));
    if (!line) return null;
    line.status = LINE_STATUS.BLOCKED;
    if (note) line.note = String(note);
    save();
    return line;
  }

  /**
   * 收掉全部未收的线（领航员关闭时用——场次结束，线跟着结束）。
   *
   * @param {string} [note] 原因
   * @returns {number} 收线条数
   */
  function closeAll(note = 'voyage-close') {
    let count = 0;
    for (const item of lines) {
      if (item.status === LINE_STATUS.RUNNING || item.status === LINE_STATUS.REPORTED) {
        item.status = LINE_STATUS.CLOSED;
        item.closedAt = Date.now();
        item.note = note;
        count += 1;
      }
    }
    if (count) save();
    return count;
  }

  /**
   * 巡检收线：reported 超过 closeAfterMs 无新动静 → 自动收线。
   *
   * @param {object} options 选项
   * @param {number} options.closeAfterMs 交报告后多久自动收线（毫秒；0 = 不自动收）
   * @returns {number} 本次收线条数
   */
  function sweep({ closeAfterMs = 0 } = {}) {
    const gap = Number(closeAfterMs) || 0;
    if (gap <= 0) return 0;
    const now = Date.now();
    let count = 0;
    for (const item of lines) {
      if (item.status !== LINE_STATUS.REPORTED) continue;
      if (now - Number(item.reportedAt || 0) < gap) continue;
      item.status = LINE_STATUS.CLOSED;
      item.closedAt = now;
      item.note = 'auto';
      count += 1;
    }
    if (count) save();
    return count;
  }

  /**
   * 快照（只读副本）——给 `/api/nav/status` 与面板。
   *
   * @param {object} [options] 选项
   * @param {number} [options.recent] 最近已收线保留条数
   * @returns {object} 快照
   */
  function snapshot({ recent = 10 } = {}) {
    const copy = (item) => ({ ...item });
    const active = lines
      .filter((item) => item.status === LINE_STATUS.RUNNING || item.status === LINE_STATUS.REPORTED || item.status === LINE_STATUS.BLOCKED)
      .map(copy);
    const done = lines
      .filter((item) => item.status === LINE_STATUS.CLOSED)
      .slice(-Math.max(0, Number(recent) || 0))
      .map(copy);
    return {
      seq,
      counts: {
        running: active.filter((item) => item.status === LINE_STATUS.RUNNING).length,
        reported: active.filter((item) => item.status === LINE_STATUS.REPORTED).length,
        blocked: active.filter((item) => item.status === LINE_STATUS.BLOCKED).length
      },
      active,
      recent: done
    };
  }

  load();

  return { add, activeFor, markReported, close, block, closeAll, sweep, snapshot, file };
}
