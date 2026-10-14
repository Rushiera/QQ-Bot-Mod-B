// navigator/state.js —— 领航员会话状态
//
// 职责：领航员开关与会话态的读写 + 落盘（app/data/navigator.json）。
// 边界：只做状态存取与派生判据；不碰网络、不发消息——那些归 ch4.js / index.js。

import fs from 'node:fs';
import path from 'node:path';

/** 空闲暂关阈值——全猫停工且无活动满此时长（毫秒）。 */
export const IDLE_CLOSE_MS = 180 * 60 * 1000;

/** 指令流水保留条数（跨群记忆的载体——"刚刚让你干什么了"）。 */
const COMMAND_LOG_LIMIT = 50;

/**
 * 状态初值。
 *
 * @returns {object} 初值
 */
function initialState() {
  return {
    enabled: false,
    activeChat: null,
    lastCommandAt: 0,
    lastActivityAt: 0,
    lastTarget: null,
    openedAt: 0,
    openedBy: '',
    closedAt: 0,
    closedReason: '',
    commandLog: []
  };
}

/**
 * 创建领航员状态机。
 *
 * @param {object} options 选项
 * @param {string} options.file 状态文件绝对路径
 * @param {object} options.log 日志器
 * @returns {object} 状态接口
 */
export function createNavigatorState({ file, log }) {
  let state = initialState();

  /**
   * 从磁盘加载（缺失 → 初值；损坏 → 告警 + 初值，不静默吞错）。
   *
   * @returns {object} 加载后的状态
   */
  function load() {
    try {
      if (!fs.existsSync(file)) return state;
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      state = { ...initialState(), ...JSON.parse(text) };
    } catch (error) {
      log.warn('navigator', `状态文件读取失败，回落初值：${error?.message ?? error}`);
    }
    return state;
  }

  /** 落盘（原子写：临时文件 → 替换）。 */
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      log.error('navigator', `状态落盘失败：${error?.message ?? error}`);
    }
  }

  /**
   * 开启领航员。
   *
   * @param {object} options 选项
   * @param {string} options.by 来源（app=应用内 / qq=群内 @）
   * @param {string|number|null} [options.chat] 下指令的群（开启即成为回消息群）
   * @returns {object} 状态快照
   */
  function open({ by = 'app', chat = null } = {}) {
    state.enabled = true;
    state.openedAt = Date.now();
    state.lastActivityAt = state.openedAt;
    state.openedBy = by;
    state.closedAt = 0;
    state.closedReason = '';
    if (chat !== null && chat !== undefined && chat !== '') state.activeChat = String(chat);
    save();
    log.info('navigator', `领航员已开启（来源 ${by}，回消息群 ${state.activeChat ?? '未定'}）`);
    return snapshot();
  }

  /**
   * 关闭领航员（暂关）。
   *
   * @param {string} [reason] 关闭原因（manual=手动 / idle=空闲暂关）
   * @returns {object} 状态快照
   */
  function close(reason = 'manual') {
    state.enabled = false;
    state.closedAt = Date.now();
    state.closedReason = reason;
    save();
    log.info('navigator', `领航员已关闭（${reason}）`);
    return snapshot();
  }

  /**
   * 切换回消息群（最后下指令的群）。
   *
   * @param {string|number} chat 群号
   * @returns {object} 状态快照
   */
  function setActiveChat(chat) {
    if (chat === null || chat === undefined || chat === '') return snapshot();
    const next = String(chat);
    if (state.activeChat !== next) {
      log.info('navigator', `回消息群切换：${state.activeChat ?? '未定'} → ${next}`);
      state.activeChat = next;
      save();
    }
    return snapshot();
  }

  /**
   * 记一条指令（同时刷新回消息群与最后指令时刻）。
   *
   * @param {object} entry 指令条目
   * @param {string|number} entry.chat 来源群
   * @param {string} [entry.target] 目标猫
   * @param {string} entry.text 指令原文
   * @param {string} [entry.result] 投递结果摘要
   * @returns {object} 记录后的条目
   */
  function noteCommand({ chat, target = '', text = '', result = '' }) {
    const entry = {
      at: Date.now(),
      chat: chat === null || chat === undefined ? '' : String(chat),
      target: String(target || ''),
      text: String(text || ''),
      result: String(result || '')
    };
    state.commandLog.push(entry);
    if (state.commandLog.length > COMMAND_LOG_LIMIT) {
      state.commandLog.splice(0, state.commandLog.length - COMMAND_LOG_LIMIT);
    }
    state.lastCommandAt = entry.at;
    state.lastActivityAt = entry.at;
    if (entry.target) state.lastTarget = entry.target;
    if (entry.chat) state.activeChat = entry.chat;
    save();
    return entry;
  }

  /**
   * 状态快照（只读副本——调用方不得改内部状态）。
   *
   * @returns {object} 快照
   */
  function snapshot() {
    return { ...state, commandLog: state.commandLog.map((item) => ({ ...item })) };
  }

  /**
   * 刷新活动时刻——猫有动静（轮结束 / 收到回复）时调用。
   *
   * 空闲暂关的计时基准是**最近一次活动**，不是「最后一条指令」（Rushiera 2026-10-11：
   * 「有回复的话这个时间应该自动归 0，除非是完全没有回复的空闲」）。
   *
   * @param {number} [at] 时刻（默认当前）
   * @returns {void}
   */
  function touch(at = Date.now()) {
    state.lastActivityAt = Number(at) || Date.now();
    save();
  }

  return { load, save, open, close, setActiveChat, noteCommand, touch, snapshot, file };
}
