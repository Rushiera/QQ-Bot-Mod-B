// patch-qqagent-quiet.mjs — QQ Agent v0.4.0「安静模式」幂等补丁
//
// 用法：node patch-qqagent-quiet.mjs [--dry]
// 做什么：把「按群的安静模式」落进 _unpack 源码 + 外观层（记忆页开关）
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑全部补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-quiet-patch:<id>]；已含标记 = 跳过
// 依赖：**先跑 patch-qqagent-engage.mjs / patch-qqagent-browse.mjs**
//       （本补丁一个锚点落在浏览节拍巡检的产物上）
// 边界：不动安全边界 / Electron 壳 / 发送队列结构；不动配额与硬限
//
// 设计要点（Rushiera 2026-10-16 口述规格）：
//   1. 记忆页给每个群一个「🤫 安静模式」开关 —— 开启的群号进 config.engage.quiet.chats
//   2. 处于安静模式的群「能不发言就不发言」：不参与闲聊，只有被 @ / 拍一拍 才回应
//   3. 被 @ 了要能回 —— @ / 拍一拍 立即触发，走普通轮（可发言）
//   4. 每 6 小时（quiet.intervalMs）跑一次「只整理不发言」的记忆沉淀轮：
//      节拍拉长到 6 小时，到点强制走收工轮语义（发送类工具移除 + 记忆沉淀 + 归档）
//   5. 存档和记忆功能不受影响 —— 消息照常入库、归档与记忆整理照常
//
// 落点：
//   src/quiet-mode.js    安静模式模块（判定 / 节拍 / 提示段）
//   src/config.js        engage.quiet 默认段
//   src/orchestrator.js  import + 节拍拉长 + 到点整理轮 + 提示段
//   ui/app/05-memory-settings.js  记忆页开关（列表标记 + 详情按钮 + 处理函数）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UIAPP = path.join(APP, 'ui', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-quiet-patch:' + id + ']';

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

/** 新增文件：已存在且非本补丁产物时拒绝覆盖；内容有更新则重写（保持幂等可复现）。 */
function addFile(id, rel, content) {
  const file = path.join(SRC, rel);
  const want = toEol(content, detectEol(path.join(SRC, 'config.js')));
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes(mark(id))) {
      throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel + '（先人工确认再删）');
    }
    if (cur === want) { results.push({ id, file: rel, status: 'skipped' }); return; }
    if (!DRY) fs.writeFileSync(file, want, 'utf8');
    results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
    return;
  }
  if (!DRY) fs.writeFileSync(file, want, 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：新增 src/quiet-mode.js —— 安静模式（按群的"能不发言就不发言"档）
// ─────────────────────────────────────────────────────────────────────────────
const QUIET_MODE_JS = `// 安静模式 —— 按群的"能不发言就不发言"档（记忆页「🤫 安静」开关）。
// [qqagent-quiet-patch:quiet-mode]
//
// 语义（Rushiera 2026-10-16 口述规格）：
//   · 处于安静模式的群不参与闲聊 —— 非 @ 消息只入库，不进 LLM；
//   · 被 @ / 拍一拍 点名 → 立即触发，走普通轮（可发言，"被 @ 了要能回"）；
//   · 每 intervalMs（默认 6 小时）跑一次"只整理不发言"的记忆沉淀轮 ——
//     节拍拉长到该间隔，到点强制走收工轮语义（发送类工具移除 + 记忆沉淀 + 归档）；
//   · 存档和记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
//
// 为什么拉长节拍而不是"关掉一切"：整理轮需要"到点看一眼"这个触发源；
// 关掉节拍等于连记忆沉淀都没有了，群就真成了哑巴（与"存档和记忆不受影响"相悖）。
//
// 状态是**配置态**（落 config.engage.quiet.chats），非运行时短期态。
import { getConfig } from './config.js';

const FALLBACK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 小时

function quietCfg() {
  return getConfig().engage?.quiet || {};
}

/** 安静模式总开关（配置缺失 = 开；enabled=false 完全关闭，按群清单保留）。 */
export function quietEnabled() {
  return quietCfg().enabled !== false;
}

/** 处于安静模式的群号清单（字符串）。开关关闭 → 空数组。 */
export function quietChats() {
  if (!quietEnabled()) return [];
  const raw = quietCfg().chats;
  return (Array.isArray(raw) ? raw : []).map((v) => String(v).trim()).filter(Boolean);
}

/** 该会话是否处于安静模式（仅群聊有意义；私聊恒 false）。 */
export function isQuietChat(chatKey) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return false;
  const id = key.split(':')[1] || '';
  if (!id) return false;
  return quietChats().includes(String(id));
}

/** 安静模式的整理节拍（毫秒；默认 6 小时）。 */
export function quietIntervalMs() {
  const n = Number(quietCfg().intervalMs);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_INTERVAL_MS;
}

/**
 * 【安静模式】提示词段（群聊且处于安静模式时注入；否则空串）。
 * 与【发言配额】同段：都是本轮动态状态，追加在用户消息末尾（不打断缓存前缀）。
 */
export function quietHint(chatKey) {
  if (!isQuietChat(chatKey)) return '';
  const hours = Math.round(quietIntervalMs() / 3600000 * 10) / 10;
  return '\\n\\n【安静模式】本群处于安静模式：默认不参与闲聊，只有被 @ / 拍一拍 点名时才回应；'
    + '系统每 ' + hours + ' 小时做一次"只整理不发言"的记忆沉淀（存档与记忆照常）。'
    + '被点名时正常回应即可，其余时候安静看就好。';
}
`;

addFile('quiet-mode', 'quiet-mode.js', QUIET_MODE_JS);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：config.js —— engage.quiet 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-quiet', SRC, 'config.js',
`    hardLimit: {
      enabled: true,
      windowMs: 60000,
      maxPerWindow: 1
    }
  },`,
`    hardLimit: {
      enabled: true,
      windowMs: 60000,
      maxPerWindow: 1
    },
    // ── 安静模式（2026-10-16）── [qqagent-quiet-patch:config-quiet]
    // chats：处于安静模式的群号清单（记忆页「🤫 安静」开关写这里）。
    //   安静群"能不发言就不发言"：不参与闲聊，只有被 @ / 拍一拍 才回应；
    //   每 intervalMs（默认 6 小时）跑一次"只整理不发言"的记忆沉淀轮。
    //   存档与记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
    //   enabled=false 完全关闭（群清单保留，下次打开即恢复）。
    quiet: {
      enabled: true,
      chats: [],
      intervalMs: 21600000,
      organizeOnly: true
    }
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：orchestrator.js —— import 安静模式模块
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', SRC, 'orchestrator.js',
`} from './browse-rate.js';`,
`} from './browse-rate.js';
// 安静模式（按群：能不发言就不发言 + 到点只整理）——[qqagent-quiet-patch:orchestrator-import]
import { isQuietChat, quietIntervalMs, quietHint } from './quiet-mode.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：orchestrator.js —— 节拍排程：安静群用安静间隔
// ─────────────────────────────────────────────────────────────────────────────
patch('note-browse-pending', SRC, 'orchestrator.js',
`  #noteBrowsePending(chatKey, force = false) {
    if (!browseEnabled()) return;
    if (force || !this.browseNextAt.has(chatKey)) {
      this.browseNextAt.set(chatKey, Date.now() + browseIntervalMs(chatKey));
    }
  }`,
`  #noteBrowsePending(chatKey, force = false) {
    if (!browseEnabled()) return;
    if (force || !this.browseNextAt.has(chatKey)) {
      // 安静群：节拍拉长到安静间隔（默认 6 小时）——[qqagent-quiet-patch:note-browse-pending]
      const ms = isQuietChat(chatKey) ? quietIntervalMs() : browseIntervalMs(chatKey);
      this.browseNextAt.set(chatKey, Date.now() + ms);
    }
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5a：orchestrator.js —— 巡检：安静群不走静默补拍 + 节拍 = 安静间隔
// ─────────────────────────────────────────────────────────────────────────────
patch('browse-tick', SRC, 'orchestrator.js',
`      const due = now >= (Number(this.browseNextAt.get(chatKey)) || 0);
      let lastUnreadTs = 0;
      if (!due) {
        try { lastUnreadTs = this.store.lastUnreadTs(chatKey); } catch { lastUnreadTs = 0; }
      }
      const idle = !due && idleFireDue(chatKey, lastUnreadTs, now);
      if (!due && !idle) continue;
      this.browseNextAt.set(chatKey, now + browseIntervalMs(chatKey));`,
`      // 安静模式：不走静默补拍（能不发言就不发言），节拍 = 安静间隔（默认 6 小时）
      // [qqagent-quiet-patch:browse-tick]
      const quiet = isQuietChat(chatKey);
      const due = now >= (Number(this.browseNextAt.get(chatKey)) || 0);
      let lastUnreadTs = 0;
      if (!due && !quiet) {
        try { lastUnreadTs = this.store.lastUnreadTs(chatKey); } catch { lastUnreadTs = 0; }
      }
      const idle = !due && !quiet && idleFireDue(chatKey, lastUnreadTs, now);
      if (!due && !idle) continue;
      this.browseNextAt.set(chatKey, now + (quiet ? quietIntervalMs() : browseIntervalMs(chatKey)));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5b：orchestrator.js —— 巡检：安静群到点走"只整理不发言"轮
// ─────────────────────────────────────────────────────────────────────────────
patch('browse-tick-wake', SRC, 'orchestrator.js',
`      if (idle) markIdleFired(chatKey, lastUnreadTs);
      logger.info('browse', chatKey + (idle ? ' 静默补拍：' : ' 浏览拍：') + unread + ' 条新内容进 LLM（节拍 '
        + Math.round(browseIntervalMs(chatKey) / 1000) + ' 秒）');
      this.wake(chatKey, {})
        .catch((error) => console.error('[orchestrator] 浏览拍 wake 出错:', error));`,
`      if (idle) markIdleFired(chatKey, lastUnreadTs);
      logger.info('browse', chatKey + (quiet ? ' 安静整理拍：' : (idle ? ' 静默补拍：' : ' 浏览拍：')) + unread + ' 条新内容进 LLM（节拍 '
        + Math.round((quiet ? quietIntervalMs() : browseIntervalMs(chatKey)) / 1000) + ' 秒）');
      // 安静群：到点走"只整理不发言"的整理轮（[qqagent-quiet-patch:browse-tick-wake]）
      this.wake(chatKey, quiet ? { quietOrganize: true } : {})
        .catch((error) => console.error('[orchestrator] 浏览拍 wake 出错:', error));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：orchestrator.js —— wake 收 quietOrganize 选项
// ─────────────────────────────────────────────────────────────────────────────
patch('wake-signature', SRC, 'orchestrator.js',
`  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null } = {}) {`,
`  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null, quietOrganize = false } = {}) {   // [qqagent-quiet-patch:wake-signature]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：orchestrator.js —— 安静整理轮强制走收工轮语义
// ─────────────────────────────────────────────────────────────────────────────
patch('rollover', SRC, 'orchestrator.js',
`    const isRollover = sessionCfg.enabled !== false && !proactive && !reuseSessionId && shouldRollover(chatKey, pendingChars);`,
`    // 安静整理轮（[qqagent-quiet-patch:rollover]）：到点强制走收工轮语义
    // （发送类工具移除 + 记忆沉淀 + 归档 + 新会话）——"不发言只整理"。
    const isRollover = sessionCfg.enabled !== false && !proactive && !reuseSessionId
      && (quietOrganize || shouldRollover(chatKey, pendingChars));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：orchestrator.js —— 会话页区分"安静整理轮"与"上下文收工轮"
// ─────────────────────────────────────────────────────────────────────────────
patch('session-flag', SRC, 'orchestrator.js',
`      if (isRollover) {
        // 会话页可见的边界：这条会话就是"收工轮"（[qqagent-session-patch:orchestrator-session-flag]）
        session.rollover = true;
        session.triggerSummary = '收工轮（上下文轮转）';
        this.sessions.update(session.id);
      }`,
`      if (isRollover) {
        // 会话页可见的边界：这条会话就是"收工轮"（[qqagent-session-patch:orchestrator-session-flag]）
        session.rollover = true;
        // 安静整理轮与上下文收工轮在会话页区分（[qqagent-quiet-patch:session-flag]）
        session.triggerSummary = quietOrganize ? '安静整理轮（定时沉淀）' : '收工轮（上下文轮转）';
        this.sessions.update(session.id);
      }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：orchestrator.js —— 【安静模式】提示词段定义
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-hint-def', SRC, 'orchestrator.js',
`      } catch { return ''; }
    })();
    // 发言热度提示（[qqagent-engage-patch:orchestrator-chatter-def]）—— 与配额同段：`,
`      } catch { return ''; }
    })();
    // 安静模式提示（[qqagent-quiet-patch:orchestrator-hint-def]）—— 与配额同段：
    // 安静群只在被点名时回应，平时安静看就好。
    const quietLine = (() => {
      try { return quietHint(chatKey); } catch { return ''; }
    })();
    // 发言热度提示（[qqagent-engage-patch:orchestrator-chatter-def]）—— 与配额同段：`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10：orchestrator.js —— 提示词拼接 quietLine
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-hint-append', SRC, 'orchestrator.js',
`        : userPrompt) + quotaLine + chatterHint + browseLine`,
`        : userPrompt) + quotaLine + chatterHint + browseLine + quietLine   // [qqagent-quiet-patch:orchestrator-hint-append]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10b：orchestrator.js —— 收工指令区分"安静整理轮"
// ─────────────────────────────────────────────────────────────────────────────
patch('rollover-instruction', SRC, 'orchestrator.js',
`/** 收工轮的系统指令（追加在用户消息末尾）。 */
function rolloverInstruction() {
  return [
    '【收工轮（系统指令，最高优先级）】',
    '本轮是收工轮：这段会话的上下文即将到达上限，系统随后会把它归档、开启新会话。',`,
`/** 收工轮 / 安静整理轮的系统指令（追加在用户消息末尾）。 */
// kind='quiet' = 安静模式的定时整理轮（[qqagent-quiet-patch:rollover-instruction]）：
// 同一套"不发言只整理"的沉淀动作，但触发缘由不是上下文到上限，而是安静模式的 6 小时节拍。
function rolloverInstruction(kind = 'rollover') {
  const quiet = kind === 'quiet';
  return [
    quiet ? '【安静整理轮（系统指令，最高优先级）】' : '【收工轮（系统指令，最高优先级）】',
    quiet
      ? '本轮是安静模式的定时整理轮：本群处于安静模式，到点做一次"只整理不发言"的记忆沉淀，系统随后会把它归档、开启新会话。'
      : '本轮是收工轮：这段会话的上下文即将到达上限，系统随后会把它归档、开启新会话。',`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10c：orchestrator.js —— #runAgent 收 quietOrganize 并传给收工指令
// ─────────────────────────────────────────────────────────────────────────────
patch('runagent-signature', SRC, 'orchestrator.js',
`  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, activeTopic = null, rollover = false, sessionStart = null }) {`,
`  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, activeTopic = null, rollover = false, quietOrganize = false, sessionStart = null }) {   // [qqagent-quiet-patch:runagent-signature]`);

patch('runagent-call', SRC, 'orchestrator.js',
`            activeTopic: activeState ? activeState.topic : null,
            rollover: isRollover,
            sessionStart
          });`,
`            activeTopic: activeState ? activeState.topic : null,
            rollover: isRollover,
            quietOrganize,   // [qqagent-quiet-patch:runagent-call]
            sessionStart
          });`);

patch('rollover-append', SRC, 'orchestrator.js',
`    if (rollover) messages[messages.length - 1].content = String(messages[messages.length - 1].content || '') + '\\n\\n' + rolloverInstruction();`,
`    if (rollover) messages[messages.length - 1].content = String(messages[messages.length - 1].content || '') + '\\n\\n' + rolloverInstruction(quietOrganize ? 'quiet' : 'rollover');   // [qqagent-quiet-patch:rollover-append]`);

patch('rollover-finish-reason', SRC, 'orchestrator.js',
`    if (rollover && !session.finishReason) session.finishReason = '收工轮（上下文轮转）';`,
`    if (rollover && !session.finishReason) session.finishReason = quietOrganize ? '安静整理轮（定时沉淀）' : '收工轮（上下文轮转）';   // [qqagent-quiet-patch:rollover-finish-reason]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 11：ui/app/05-memory-settings.js —— 记忆页列表：安静标记
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-list-quiet-def', UIAPP, '05-memory-settings.js',
`    const busyHtml = busy
      ? \`<span class="unread-pill" style="background:var(--orange)">整理中…</span>\`
      : '';`,
`    const busyHtml = busy
      ? \`<span class="unread-pill" style="background:var(--orange)">整理中…</span>\`
      : '';
    // 安静模式标记（[qqagent-quiet-patch:ui-list-quiet-def]）——本群是否处于安静模式
    const quietIds = ((((state.config || {}).engage || {}).quiet || {}).chats || []).map(String);
    const quietHtml = quietIds.includes(String(key).split(':')[1] || '')
      ? \`<span class="unread-pill" style="background:var(--blue,#3b82f6)">🤫 安静</span>\`
      : '';`);

patch('ui-list-quiet-html', UIAPP, '05-memory-settings.js',
`          <span class="session-chat">\${esc(names[key] || key)}</span>
          \${busyHtml}`,
`          <span class="session-chat">\${esc(names[key] || key)}</span>
          \${quietHtml}<!-- [qqagent-quiet-patch:ui-list-quiet-html] -->
          \${busyHtml}`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 12：ui/app/05-memory-settings.js —— 详情页读安静清单
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-detail-quiet-list', UIAPP, '05-memory-settings.js',
`    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';`,
`    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    // 安静模式群清单（[qqagent-quiet-patch:ui-detail-quiet-list]）——「🤫 安静模式」开关的状态源
    const quietIds = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const quietOn = kind === 'group' && quietIds.includes(String(chatId));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 13：ui/app/05-memory-settings.js —— 详情页安静开关按钮
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-detail-quiet-btn', UIAPP, '05-memory-settings.js',
`    } else {
      consolidateStatusHtml = \`<span id="mem-consolidate-status" class="muted"></span>\`;
    }
    detail.innerHTML = \``,
`    } else {
      consolidateStatusHtml = \`<span id="mem-consolidate-status" class="muted"></span>\`;
    }
    // 安静模式开关（[qqagent-quiet-patch:ui-detail-quiet-btn]）——仅群聊显示
    const quietBtnHtml = kind === 'group'
      ? '<button class="btn btn-small ' + (quietOn ? 'btn-primary' : '') + '" id="mem-quiet-btn" title="安静模式：能不发言就不发言，只有被 @ / 拍一拍 才回应；每 6 小时做一次只整理不发言的记忆沉淀（存档与记忆照常）">🤫 安静模式</button>'
      : '';
    detail.innerHTML = \``);

patch('ui-detail-quiet-html', UIAPP, '05-memory-settings.js',
`          <button class="btn btn-small" id="mem-consolidate-btn" \${busy ? 'disabled' : ''}>\${busy ? '整理中…' : '整理本群记忆'}</button>
          \${consolidateStatusHtml}`,
`          <button class="btn btn-small" id="mem-consolidate-btn" \${busy ? 'disabled' : ''}>\${busy ? '整理中…' : '整理本群记忆'}</button>
          \${quietBtnHtml}<!-- [qqagent-quiet-patch:ui-detail-quiet-html] -->
          \${consolidateStatusHtml}`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 14：ui/app/05-memory-settings.js —— 安静开关处理
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-detail-quiet-handler', UIAPP, '05-memory-settings.js',
`        toggleBotMember(qq, chatKey);
      });
    });
    $$('.mem-edit-imp', detail).forEach((el) => {`,
`        toggleBotMember(qq, chatKey);
      });
    });
    // 🤫 安静模式开关（[qqagent-quiet-patch:ui-detail-quiet-handler]）
    const quietBtnEl = detail.querySelector('#mem-quiet-btn');
    if (quietBtnEl && kind === 'group') {
      quietBtnEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleQuietChat(chatId, chatKey);
      });
    }
    $$('.mem-edit-imp', detail).forEach((el) => {`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 15：ui/app/05-memory-settings.js —— toggleQuietChat 函数
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-toggle-fn', UIAPP, '05-memory-settings.js',
`async function toggleBotMember(qq, chatKey) {`,
`/**
 * 开 / 关某群的「安静模式」（记忆页「🤫 安静模式」开关）。
 * [qqagent-quiet-patch:ui-toggle-fn]
 *
 * 写进 config.engage.quiet.chats —— 该群"能不发言就不发言"：不参与闲聊，
 * 只有被 @ / 拍一拍 才回应；每 6 小时跑一次"只整理不发言"的记忆沉淀轮。
 * 存档与记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
 */
async function toggleQuietChat(groupId, chatKey) {
  const id = String(groupId || '').trim();
  if (!/^\\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法开启安静模式'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { quiet: { chats: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(\`保存失败：\${e.message}\`);
  }
}

async function toggleBotMember(qq, chatKey) {`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  points: results
}, null, 2));
