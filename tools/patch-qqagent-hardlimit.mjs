// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-hardlimit.mjs — QQ Agent v0.4.0「发言硬限制」幂等补丁
//
// 用法：node patch-qqagent-hardlimit.mjs [--dry]
// 做什么：在出站口加一道独立硬闸 —— 每 60 秒最多 1 条发言（可配）
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑即复现
// 幂等：每个补丁点带唯一标记 [qqagent-hardlimit-patch:<id>]；已含标记 = 跳过
// 边界：不动安全边界 / Electron 壳 / 触发策略；不改 quota 与 botGuard 的既有语义
//
// 🔴 补丁链顺序（后落者改写了上游锚点所在文本，顺序不可颠倒）：
//   session → engage → nosys → memory → sessions-fold → botguard → **本补丁**
//   本补丁改写的 quotaState 方法体是 engage 补丁的产物 —— 替换文本保留其标记
//   [qqagent-engage-patch:sender-quota-state]，故 engage 复跑仍 skip。
//
// 设计要点（Rushiera 2026-10-10 规格：「调一下发言频率，增加一个每 60 秒最多 1 次发言的硬限制」）：
//   1 **独立层**：与 engage.quota（可调业务闸，"说多少"）分开 —— 本闸是"多久能开口"的
//     硬下限，调 quota 不会放宽它（quota 的 windowMs 下限 10s 也放宽不到它）
//   2 **出站口**：判定在 sender.#checkRate 内、quota 之前；超限直接抛错
//      （错误回给模型，模型据此安静结束），不做延迟排队
//   3 **同粒度**：按条记账（与 quota 一致）；被拒的发送不占任何配额（抛错在记账之前）
//   4 **提示词一致**：quotaState 取两道闸的更严者 —— 否则模型会按虚高的余量反复撞墙
//
// 落点：
//   src/config.js   engage.hardLimit 默认段
//   src/sender.js   hardTimes 表 + #checkRate 闸门 + quotaState 取严

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-hardlimit-patch:' + id + ']';

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
// 补丁 1：src/config.js —— engage.hardLimit 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-hardlimit', SRC, 'config.js',
`    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    }
  },`,
`    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    },
    // ── 发言硬限制（2026-10-10）── [qqagent-hardlimit-patch:config-hardlimit]
    // 出站口的兜底闸：每 windowMs 最多 maxPerWindow 条（默认 60 秒 1 条）。
    //   与 quota 分开 —— quota 是"说多少"的可调业务闸，这里是"多久能开口"的硬下限，
    //   调 quota 不会放宽它。超限的发送被拒（错误回给模型，模型据此安静结束）。
    //   提示词【发言配额】段的余量取两道闸的更严者。
    //   enabled=false 完全关闭。
    hardLimit: {
      enabled: true,
      windowMs: 60000,
      maxPerWindow: 1
    }
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/sender.js —— 硬限时间戳表
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-ctor', SRC, 'sender.js',
`    this.quotaTimes = new Map();  // chatKey -> [ts]`,
`    this.quotaTimes = new Map();  // chatKey -> [ts]
    // 发言硬限制时间戳（[qqagent-hardlimit-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.hardTimes = new Map();   // chatKey -> [ts]`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/sender.js —— #checkRate 加硬限闸门（quota 之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-checkrate', SRC, 'sender.js',
`    this.#checkBotGuard(chatKey, atUserId);
    const cfg = getConfig().send;`,
`    this.#checkBotGuard(chatKey, atUserId);
    // ── 发言硬限制（[qqagent-hardlimit-patch:sender-checkrate]）──
    // 每 windowMs 最多 maxPerWindow 条 —— 独立于可调的 engage.quota：
    // 这是出站口的兜底闸（不随配额放宽），管"多久能开口一次"。
    // 与配额同粒度（按条记账）；被拒的发送不占任何配额（抛错在记账之前）。
    const h = getConfig().engage?.hardLimit || {};
    if (h.enabled !== false) {
      const winMs = Math.max(10000, Number(h.windowMs) || 60000);
      const maxN = Math.max(1, Number(h.maxPerWindow) || 1);
      const times = (this.hardTimes.get(chatKey) || []).filter((t) => now - t < winMs);
      if (times.length >= maxN) {
        const wait = Math.max(1, Math.ceil((winMs - (now - Math.min(...times))) / 1000));
        throw new Error('发言硬限制（最近 ' + Math.round(winMs / 1000) + ' 秒最多 ' + maxN
          + ' 条）：约 ' + wait + ' 秒后可再发 —— 本轮不要再尝试发送，安静结束即可');
      }
      times.push(now);
      this.hardTimes.set(chatKey, times);
    }
    const cfg = getConfig().send;`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/sender.js —— quotaState 取两道闸的更严者
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-quotastate', SRC, 'sender.js',
`  /**
   * 配额余量（供提示词注入 —— 让模型自己看着办，而不是发到一半被拦）。
   * [qqagent-engage-patch:sender-quota-state]
   * @returns {{used:number, max:number, windowMs:number, remaining:number}|null} null = 配额关闭
   */
  quotaState(chatKey) {
    const q = getConfig().engage?.quota || {};
    if (q.enabled === false) return null;
    const winMs = Math.max(10000, Number(q.windowMs) || 120000);
    const maxN = Math.max(1, Number(q.maxPerWindow) || 5);
    const now = Date.now();
    const used = (this.quotaTimes.get(chatKey) || []).filter((t) => now - t < winMs).length;
    return { used, max: maxN, windowMs: winMs, remaining: Math.max(0, maxN - used) };
  }`,
`  /**
   * 配额余量（供提示词注入 —— 让模型自己看着办，而不是发到一半被拦）。
   * [qqagent-engage-patch:sender-quota-state]
   * 发言硬限制并入（[qqagent-hardlimit-patch:sender-quotastate]）：两道闸取更严者 ——
   * 提示词里的余量必须与实际出站闸一致，否则模型按虚高的余量反复撞墙。
   * @returns {{used:number, max:number, windowMs:number, remaining:number}|null} null = 两道闸都关
   */
  quotaState(chatKey) {
    const now = Date.now();
    const cands = [];
    const q = getConfig().engage?.quota || {};
    if (q.enabled !== false) {
      const winMs = Math.max(10000, Number(q.windowMs) || 120000);
      const maxN = Math.max(1, Number(q.maxPerWindow) || 5);
      const used = (this.quotaTimes.get(chatKey) || []).filter((t) => now - t < winMs).length;
      cands.push({ used, max: maxN, windowMs: winMs, remaining: Math.max(0, maxN - used) });
    }
    const h = getConfig().engage?.hardLimit || {};
    if (h.enabled !== false) {
      const winMs = Math.max(10000, Number(h.windowMs) || 60000);
      const maxN = Math.max(1, Number(h.maxPerWindow) || 1);
      const used = (this.hardTimes.get(chatKey) || []).filter((t) => now - t < winMs).length;
      cands.push({ used, max: maxN, windowMs: winMs, remaining: Math.max(0, maxN - used) });
    }
    if (!cands.length) return null;
    // 取更严者：剩余少者优先；并列取窗口更短者（约束更紧）
    cands.sort((a, b) => (a.remaining - b.remaining) || (a.windowMs - b.windowMs));
    return cands[0];
  }`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
