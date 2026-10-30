// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-botguard.mjs — QQ Agent v0.4.0「bot 指定限频」幂等补丁
//
// 用法：node patch-qqagent-botguard.mjs [--dry]
// 做什么：把「记忆页指定机器人群友 → 对 TA 的回复限频 240 秒 1 条」落进 _unpack 源码 + 外观层
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑（session → engage → nosys → 本补丁）即复现
// 幂等：每个补丁点带唯一标记 [qqagent-botguard-patch:<id>]；已含标记（或已应用形态）= 跳过
// 边界：不动安全边界 / Electron 壳 / 发送队列结构；不改触发策略与配额
//
// 设计要点（Rushiera 2026-10-10 口述规格）：
//   1 记忆页给每个群友一个「🤖 bot」开关 —— 指定为机器人的群友 QQ 进 config.engage.botGuard.members
//   2 一旦打开：对该群友的回复强制限频 —— 240 秒内最多 1 条
//   3 **不影响送 LLM 思考**：模型照常跑完整轮；闸门在**出站口**——
//     "如果发现回的是目标群友就强制不发送消息"（被拦的发送把错误回给模型，模型据此安静结束）
//   4 判定"回的是谁"：显式点名（atUserId / 拍一拍目标）优先，否则取本轮运行目标
//     （orchestrator 每轮告诉 sender：触发批最后一条的发送者）
//   5 记账粒度 = 一次回复（一轮运行）：本轮第一笔发送放行后，同轮后续发送不再重复判定
//
// 落点：
//   src/config.js        engage.botGuard 默认段
//   src/sender.js        #checkRate 前置闸门 + 运行上下文 + 记账
//   src/orchestrator.js  每轮运行前后设置 / 清除"本轮在回谁"
//   ui/app/05-memory-settings.js  记忆页两处开关（群友印象卡 + 群成员表）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UIAPP = path.join(APP, 'ui', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-botguard-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：src/config.js —— engage.botGuard 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-botguard', SRC, 'config.js',
`    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true }
  },`,
`    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true },
    // ── bot 指定限频（2026-10-10）── [qqagent-botguard-patch:config-botguard]
    // members：被指定为机器人的群友 QQ 号（记忆页「🤖 bot」开关写这里）。
    //   对这些群友的回复强制限频：windowMs 内最多 maxPerWindow 条 —— 抑制
    //   "两个机器人互相刷屏"。判定在**出站口**：本轮回复对象（或显式 @ / 拍的目标）
    //   落在名单里、且额度已满 → 发送被拒（错误回给模型）。
    //   **不影响送 LLM 思考**：模型照常跑完整轮，只是发不出去。
    //   enabled=false 完全关闭（成员名单保留，下次打开即恢复）。
    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    }
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/sender.js —— 运行上下文两张表
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-ctor', SRC, 'sender.js',
`    // 发言配额时间戳（[qqagent-engage-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.quotaTimes = new Map();  // chatKey -> [ts]`,
`    // 发言配额时间戳（[qqagent-engage-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.quotaTimes = new Map();  // chatKey -> [ts]
    // bot 指定限频（[qqagent-botguard-patch:sender-ctor]）——
    //   botReplyTimes："chatKey::QQ" -> [ts]（已发出的回复时刻，跨轮生效）
    //   botRuns：chatKey -> { target, granted, marked, grantedFor }（本轮运行上下文）
    this.botReplyTimes = new Map();
    this.botRuns = new Map();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/sender.js —— #checkRate 加 atUserId 参数 + 最前置 bot 闸门
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-checkrate', SRC, 'sender.js',
`  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;`,
`  #checkRate(chatKey, atUserId = null) {
    const now = Date.now();
    // bot 指定限频（[qqagent-botguard-patch:sender-checkrate]）—— 最前置：
    // 被它拦下的发送不消耗任何配额（分钟 / 小时限频与发言配额都不动）。
    this.#checkBotGuard(chatKey, atUserId);
    const cfg = getConfig().send;`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/sender.js —— bot 指定闸门方法组（插在去重逻辑之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-methods', SRC, 'sender.js',
`  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。`,
`  // ── bot 指定限频（[qqagent-botguard-patch:sender-methods]）───────────────────
  // Rushiera 2026-10-10 规格：记忆页把某个群友指定为机器人（🤖 bot 开关）后，
  // 对该群友的回复强制限频 —— 240 秒内最多 1 条。**不影响送 LLM 思考**：模型照常
  // 跑完整轮，只是"回目标群友"的发送被拒绝（错误回给模型，模型据此安静结束）。
  //
  // 为什么放在出站口而不是触发面：规格原话就是"如果发现回的是目标群友就强制不
  // 发送消息"——闸门在发送面，思考面不动。
  //
  // 判定"回的是谁"：显式点名（atUserId / 拍一拍目标）优先；否则取本轮运行目标
  // （orchestrator 每轮告诉 sender：触发批最后一条的发送者）。两者都在指定名单里
  // 才算命中。
  // 记账粒度 = 一次回复（一轮运行）：本轮第一笔发送放行后，同轮后续发送不再重复
  // 判定（一句话分两条发 / 文字+表情，都算同一次回复）。

  /** 本轮运行"在回谁"（orchestrator 每轮运行前后设置 / 清除）。 */
  setRunBotTarget(chatKey, memberId) {
    const id = String(memberId ?? '').trim();
    this.botRuns.set(String(chatKey), { target: id || null, granted: false, marked: false, grantedFor: null });
  }

  /** 本轮运行结束：清掉运行上下文（窗口时刻表保留，跨轮生效）。 */
  clearRunBotTarget(chatKey) {
    this.botRuns.delete(String(chatKey));
  }

  /** bot 指定名单（配置面；开关关闭或名单为空 → 空数组 = 闸门不生效）。 */
  #botMemberIds() {
    const g = getConfig().engage?.botGuard || {};
    if (g.enabled === false) return [];
    return (Array.isArray(g.members) ? g.members : []).map((v) => String(v).trim()).filter(Boolean);
  }

  /** 本轮要"回"的指定群友 QQ；不在名单里返回 null。 */
  #botGuardMember(chatKey, atUserId) {
    const ids = this.#botMemberIds();
    if (!ids.length) return null;
    const at = String(atUserId ?? '').trim();
    if (at && ids.includes(at)) return at;
    const run = this.botRuns.get(String(chatKey));
    const t = run && run.target ? String(run.target) : '';
    return t && ids.includes(t) ? t : null;
  }

  /** 窗口内已用额度（判定 / 记账 / 提示共用）。 */
  #botWindow(chatKey, memberId) {
    const g = getConfig().engage?.botGuard || {};
    const winMs = Math.max(10000, Number(g.windowMs) || 240000);
    const maxN = Math.max(1, Number(g.maxPerWindow) || 1);
    const now = Date.now();
    const times = (this.botReplyTimes.get(String(chatKey) + '::' + String(memberId)) || [])
      .filter((t) => now - t < winMs);
    return { winMs, maxN, times, hot: times.length >= maxN };
  }

  /**
   * bot 指定闸门：命中且额度已满 → 抛错（错误回给模型，模型据此安静结束）。
   * 命中但额度未满 → 放行，并在本轮标记"已放行"（同一次回复内不再重复判定）。
   * @returns {string|null} 命中的群友 QQ；未命中 = null
   */
  #checkBotGuard(chatKey, atUserId) {
    const memberId = this.#botGuardMember(chatKey, atUserId);
    if (!memberId) return null;
    const run = this.botRuns.get(String(chatKey));
    if (run && run.granted) return memberId;      // 本轮已放行：同一次回复内的后续发送不再判定
    const w = this.#botWindow(chatKey, memberId);
    if (w.hot) {
      const oldest = Math.min(...w.times);
      const wait = Math.max(1, Math.ceil((w.winMs - (Date.now() - oldest)) / 1000));
      throw new Error('该群友已被指定为机器人（记忆页「🤖 bot」开关）：对 TA 的回复限制为 '
        + Math.round(w.winMs / 1000) + ' 秒最多 ' + w.maxN + ' 条，本轮额度已用完（约 ' + wait
        + ' 秒后可再回）。这条不会发出 —— 本轮不要再尝试发送，安静结束即可');
    }
    if (run) { run.granted = true; run.grantedFor = memberId; }
    else this.botRuns.set(String(chatKey), { target: null, granted: true, marked: false, grantedFor: memberId });
    return memberId;
  }

  /** 发送成功后记账（本轮一次回复只记一次）。 */
  #markBotReply(chatKey) {
    const run = this.botRuns.get(String(chatKey));
    if (!run || !run.granted || run.marked || !run.grantedFor) return;
    const w = this.#botWindow(chatKey, run.grantedFor);
    w.times.push(Date.now());
    this.botReplyTimes.set(String(chatKey) + '::' + String(run.grantedFor), w.times);
    run.marked = true;
  }

  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/sender.js —— 五个发送路径把"点名对象"透传给闸门
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-call-textbatch', SRC, 'sender.js',
`        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);`,
`        this.#checkRate(chatKey, options.atUserId);
        if (gap > 0) await sleep(gap);`,
1,
`        this.#checkRate(chatKey, options.atUserId);
        if (gap > 0)`);

patch('sender-call-sticker', SRC, 'sender.js',
`      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿`,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿`,
1,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(600, 1500));`);

patch('sender-call-image', SRC, 'sender.js',
`      this.#checkRate(chatKey);
      await sleep(randInt(500, 1300));   // 发图前真人式的短暂停顿`,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(500, 1300));   // 发图前真人式的短暂停顿`,
1,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(500, 1300));`);

patch('sender-call-media', SRC, 'sender.js',
`      this.#checkRate(chatKey);
      await sleep(randInt(800, 1800));   // 视频/多图体积大，停顿比文字长一点`,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(800, 1800));   // 视频/多图体积大，停顿比文字长一点`,
1,
`      this.#checkRate(chatKey, options.atUserId);
      await sleep(randInt(800, 1800));`);

patch('sender-call-poke', SRC, 'sender.js',
`      // 拍一拍同样占发送配额 —— 曾经不调 #checkRate，模型连发 poke
      // 可以绕过 maxPerMinute/maxPerHour 刷屏
      this.#checkRate(chatKey);`,
`      // 拍一拍同样占发送配额 —— 曾经不调 #checkRate，模型连发 poke
      // 可以绕过 maxPerMinute/maxPerHour 刷屏
      this.#checkRate(chatKey, targetUserId);`,
1,
`      this.#checkRate(chatKey, targetUserId);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：src/sender.js —— 发送成功记账
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-mark', SRC, 'sender.js',
`  #markSent(chatKey, text) {
    const win = this.#dedupeWindow();`,
`  #markSent(chatKey, text) {
    // bot 指定：本轮成功发出过消息 → 记一次对目标群友的回复额度
    // [qqagent-botguard-patch:sender-mark]
    this.#markBotReply(chatKey);
    const win = this.#dedupeWindow();`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：src/orchestrator.js —— 每轮运行前后设置 / 清除"本轮在回谁"
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-run-target', SRC, 'orchestrator.js',
`    const MAX_SESSION_ATTEMPTS = Math.max(1, 1 + (Math.min(5, Math.max(0, Number(getConfig().sessionRetryAttempts) ?? 0) || 0)));
    let lastError = null;`,
`    // ── bot 指定（记忆页 🤖 bot 开关）：本轮"在回谁" ──
    // [qqagent-botguard-patch:orchestrator-run-target]
    // 触发批最后一条的发送者即本轮回复对象；它落在指定名单里才交给 sender 判定限频。
    // 名单为空 / 开关关闭 → 传 null（sender 侧照常清掉上一轮上下文）。
    const botGuardCfg = getConfig().engage?.botGuard || {};
    const botMembers = botGuardCfg.enabled === false
      ? []
      : (Array.isArray(botGuardCfg.members) ? botGuardCfg.members : []).map((v) => String(v).trim()).filter(Boolean);
    const botLast = [...(triggerEntries || [])].reverse().find((m) => m && !m.self && m.senderId);
    const botRunTarget = botLast && botMembers.includes(String(botLast.senderId)) ? String(botLast.senderId) : null;
    // sender 是注入依赖：能力探测式调用（与 quotaState 同款），缺方法时不静默装死——
    // 生产路径的 sender 恒有该方法，自测桩子允许不带。
    if (this.sender && typeof this.sender.setRunBotTarget === 'function') this.sender.setRunBotTarget(chatKey, botRunTarget);
    const MAX_SESSION_ATTEMPTS = Math.max(1, 1 + (Math.min(5, Math.max(0, Number(getConfig().sessionRetryAttempts) ?? 0) || 0)));
    let lastError = null;`);

patch('orchestrator-run-target-clear', SRC, 'orchestrator.js',
`    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }`,
`    } finally {
      // 本轮 bot 指定上下文收尾（[qqagent-botguard-patch:orchestrator-run-target-clear]）
      if (this.sender && typeof this.sender.clearRunBotTarget === 'function') this.sender.clearRunBotTarget(chatKey);
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：ui/app/05-memory-settings.js —— 记忆页「🤖 bot」开关
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-mem-bot-list', UIAPP, '05-memory-settings.js',
`    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';`,
`    const notes = cfg.memberNotes || {};
    // 指定为机器人的群友 QQ（[qqagent-botguard-patch:ui-mem-bot-list]）——🤖 bot 开关的状态源
    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    const kind = chatKey.startsWith('group') ? 'group' : 'private';`);

patch('ui-mem-bot-btn', UIAPP, '05-memory-settings.js',
`            <button class="btn btn-small mem-edit-imp" data-qq="\${esc(m.userId)}" data-name="\${esc(m.name)}">编辑</button>`,
`            <button class="btn btn-small mem-bot-toggle" data-qq="\${esc(m.userId)}" title="指定为机器人：对 TA 的回复限制为 240 秒 1 条（点一下切换）">🤖 bot</button>
            <button class="btn btn-small mem-edit-imp" data-qq="\${esc(m.userId)}" data-name="\${esc(m.name)}">编辑</button>`,
1,
`            <button class="btn btn-small mem-bot-toggle" data-qq="\${esc(m.userId)}"`);

patch('ui-mem-bot-handler', UIAPP, '05-memory-settings.js',
`    $$('.mem-edit-imp', detail).forEach((el) => {`,
`    // 🤖 bot 开关（[qqagent-botguard-patch:ui-mem-bot-handler]）—— 指定为机器人的群友
    // 会被发送面限频（240 秒 1 条）；只影响发送，不影响模型思考。
    $$('.mem-bot-toggle', detail).forEach((el) => {
      const qq = String(el.dataset.qq || '');
      if (!/^\\d{1,15}$/.test(qq)) { el.style.display = 'none'; return; }
      const on = botMembers.includes(qq);
      el.classList.toggle('btn-primary', on);
      el.textContent = on ? '🤖 bot ✓' : '🤖 bot';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBotMember(qq, chatKey);
      });
    });
    $$('.mem-edit-imp', detail).forEach((el) => {`);

patch('ui-members-bot-list', UIAPP, '05-memory-settings.js',
`    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');`,
`    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    // 指定为机器人的群友 QQ（[qqagent-botguard-patch:ui-members-bot-list]）
    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    const box = $('#mem-members');`);

patch('ui-members-bot-cell', UIAPP, '05-memory-settings.js',
`            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="\${esc(m.userId)}">编辑备注</button></td>`,
`            <td style="text-align:right"><button class="btn btn-small member-bot-toggle" data-qq="\${esc(m.userId)}" title="指定为机器人：对 TA 的回复限制为 240 秒 1 条">🤖 bot</button> <button class="btn btn-small member-note-edit" data-qq="\${esc(m.userId)}">编辑备注</button></td>`,
1,
`class="btn btn-small member-bot-toggle"`);

patch('ui-members-bot-handler', UIAPP, '05-memory-settings.js',
`      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });`,
`      // 🤖 bot 开关（[qqagent-botguard-patch:ui-members-bot-handler]）—— 群成员表里的快捷入口
      box.querySelectorAll('.member-bot-toggle').forEach((el) => {
        const on = botMembers.includes(String(el.dataset.qq));
        el.classList.toggle('btn-primary', on);
        el.textContent = on ? '🤖 bot ✓' : '🤖 bot';
        el.addEventListener('click', () => toggleBotMember(el.dataset.qq, chatKey));
      });
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });`);

patch('ui-toggle-fn', UIAPP, '05-memory-settings.js',
`async function loadGroupMembers(chatId, chatKey) {`,
`/**
 * 指定 / 取消指定某个群友为机器人（记忆页「🤖 bot」开关）。
 * [qqagent-botguard-patch:ui-toggle-fn]
 *
 * 写进 config.engage.botGuard.members —— 发送面对 TA 的回复限频 240 秒 1 条；
 * **不影响送 LLM 思考**（模型照常跑，只是发不出去）。名单是全局 QQ 清单：
 * 同一个机器人在别的群也一并受限。
 */
async function toggleBotMember(qq, chatKey) {
  const id = String(qq || '').trim();
  if (!/^\\d{1,15}$/.test(id)) { alert('该群友缺少 QQ 号，无法指定'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { botGuard: { members: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    if (state.groupMembersLoaded) await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
  } catch (e) {
    alert(\`保存失败：\${e.message}\`);
  }
}

async function loadGroupMembers(chatId, chatKey) {`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
