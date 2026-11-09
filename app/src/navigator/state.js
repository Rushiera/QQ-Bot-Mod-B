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
 * 发群类型开关（Rushiera 2026-11-09 · v1.62）。
 *
 * 五类各自独立控制「这类消息发不发群」：
 * `reply` 猫回复截图 · `progress` 进度播报 · `shot` 我点的截图 / 分析 ·
 * `media` 生成产物（生图 / 语音 / 反推 / 改图）· `receipt` 系统回执（开场巡检 / 场次小结 / 开关回执）。
 *
 * 🔴 它是**唯一判据**：发不发群由这五个开关定，不再由领航员开不开定（开关只决定
 * 「自动观测跑不跑」）。落点 = `index.js` 四个发群原语（say / sayImage / sayRecord / sayAt），
 * 所有路径都过那道闸——漏不掉。
 */
export const DELIVER_KINDS = ['reply', 'progress', 'shot', 'media', 'receipt'];

/** 开领航员时的回落组——五类全开（原语义：盯着猫群，有回复就发）。 */
const DELIVER_OPEN = { reply: true, progress: true, shot: true, media: true, receipt: true };

/**
 * 关领航员时的回落组（Rushiera 2026-11-09 定）。
 *
 * 只留「我要的东西」：`shot` + `media` 亮（点一下截图、生成产物照样发得出来）；
 * 自动播报 `reply` / `progress` 与系统回执 `receipt` 熄——关掉就是不想被刷屏。
 */
const DELIVER_CLOSE = { reply: false, progress: false, shot: true, media: true, receipt: false };

/**
 * 归一发群开关——补缺键、剔非法键、旧状态文件按 enabled 给默认组。
 *
 * @param {object|null|undefined} raw 落盘里的 deliver（可能缺）
 * @param {boolean} enabled 领航员是否开启（缺字段时决定默认组）
 * @returns {object} 五键齐备的开关对象
 */
function normalizeDeliver(raw, enabled) {
  const base = enabled === true ? DELIVER_OPEN : DELIVER_CLOSE;
  const out = { ...base };
  if (raw && typeof raw === 'object') {
    for (const key of DELIVER_KINDS) {
      if (raw[key] === true || raw[key] === false) out[key] = raw[key];
    }
  }
  return out;
}

/**
 * 状态初值。
 *
 * @returns {object} 初值
 */
function initialState() {
  return {
    enabled: false,
    activeChat: null,
    /**
     * 产物落地档（Rushiera 2026-11-09 · v1.60）——三态：
     * `''` = 不发群消息（只落产物区）· `'follow'` = 消息跟随当前回消息群 · `'<群号>'` = 主动指定的群。
     * 与 `activeChat` 分开存：指定群是「主动指定」，不该被回消息群的其它变化顺手覆盖。
     * 开关领航员时回落一次：开 → `follow`，关 → `''`（之后手工改不受影响）。
     */
    deliverTarget: '',
    /**
     * 发群类型开关（Rushiera 2026-11-09 · v1.62）——五键各自独立（见 `DELIVER_KINDS`）。
     * 初值按「未开启」给（`DELIVER_CLOSE`）：自动播报熄、点截图与生成产物亮。
     * 开关领航员时整组回落一次：开 → 全开，关 → `DELIVER_CLOSE`。
     */
    deliver: normalizeDeliver(null, false),
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
      const parsed = JSON.parse(text);
      state = { ...initialState(), ...parsed };
      // 旧状态文件没有 deliver 字段——按 enabled 给默认组（不当成「全关」，也不静默吞）
      state.deliver = normalizeDeliver(parsed?.deliver, state.enabled === true);
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
    // 开领航员 → 落地档回落一次到「跟随」（Rushiera 2026-11-09）；之后手工改不被覆盖
    state.deliverTarget = 'follow';
    // 发群类型开关同样回落一次——开启 = 五类全开（Rushiera 2026-11-09 · v1.62）
    state.deliver = { ...DELIVER_OPEN };
    save();
    log.info('navigator', `领航员已开启（来源 ${by}，回消息群 ${state.activeChat ?? '未定'}，落地 ${state.deliverTarget}，发群类型 全开）`);
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
    // 关领航员 → 落地档回落一次到「不发群消息」（Rushiera 2026-11-09）；activeChat 保留
    state.deliverTarget = '';
    // 发群类型开关同样回落一次——只留「点截图 + 生成产物」，自动播报与系统回执熄（v1.62）
    state.deliver = { ...DELIVER_CLOSE };
    save();
    log.info('navigator', `领航员已关闭（${reason}，落地档回落不发群，发群类型 只留截图/产物）`);
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
   * 设置产物落地档（Rushiera 2026-11-09 · v1.60）。
   *
   * 三态：`''` = 不发群消息（只落产物区）· `'follow'` = 消息跟随当前回消息群 · `<群号>` = 主动指定的群。
   * 手工设置立即落盘——开关领航员的回落只发生在 open / close 那一刻，之后不再覆盖。
   *
   * @param {string|number|null} target 落地档
   * @returns {object} 状态快照
   */
  function setDeliverTarget(target) {
    const value = target === null || target === undefined ? '' : String(target).trim();
    if (value.length > 64) {
      log.warn('navigator', `落地档超长，已忽略：${value.slice(0, 40)}…`);
      return snapshot();
    }
    if (state.deliverTarget !== value) {
      log.info('navigator', `产物落地档：${state.deliverTarget || '(不发群)'} → ${value || '(不发群)'}`);
      state.deliverTarget = value;
      save();
    }
    return snapshot();
  }

  /**
   * 某一类消息现在发不发群（唯一判据出口）。
   *
   * @param {string} kind 类型键（`DELIVER_KINDS` 之一；空 / 未知键按「放行」——不误伤未分类调用）
   * @returns {boolean} true = 发
   */
  function allows(kind) {
    const key = String(kind ?? '').trim();
    if (!key) return true;
    if (!DELIVER_KINDS.includes(key)) {
      log.warn('navigator', `未知的发群类型「${key}」——按放行处理`);
      return true;
    }
    return state.deliver?.[key] === true;
  }

  /**
   * 设置发群类型开关（Rushiera 2026-11-09 · v1.62）。
   *
   * 两种用法：`mode='all'` 全开 / `mode='none'` 全关（面板「全开 / 全关」按钮），
   * 或传 `patch` 只改其中几键。手工设置立即落盘——开关领航员的整组回落只发生在 open / close 那一次。
   *
   * @param {object} [patch] 单键补丁（`{ reply: false }`）
   * @param {string} [mode] 总控（`all` / `none`；空 = 只按 patch 改）
   * @returns {object} 状态快照
   */
  function setDeliverKinds(patch = {}, mode = '') {
    const next = normalizeDeliver(state.deliver, state.enabled === true);
    if (mode === 'all' || mode === 'none') {
      const value = mode === 'all';
      for (const key of DELIVER_KINDS) next[key] = value;
    }
    const input = patch && typeof patch === 'object' ? patch : {};
    for (const key of DELIVER_KINDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) next[key] = input[key] === true;
    }
    const changed = DELIVER_KINDS.filter((key) => (state.deliver?.[key] === true) !== next[key]);
    if (changed.length > 0) {
      state.deliver = next;
      log.info('navigator', `发群类型开关：${DELIVER_KINDS.map((key) => `${key}=${next[key] ? '开' : '关'}`).join(' ')}`);
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

  return { load, save, open, close, setActiveChat, setDeliverTarget, setDeliverKinds, allows, noteCommand, touch, snapshot, file };
}
