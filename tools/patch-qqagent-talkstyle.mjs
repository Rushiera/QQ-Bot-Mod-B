// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-talkstyle.mjs — QQ Agent v0.4.0「发言纪律」幂等补丁
//
// 用法：node patch-qqagent-talkstyle.mjs [--dry]
// 做什么：① 系统提示从「整段关闭」改为「精简模式」——只恢复决定"开不开口"的纪律段
//        ② 动态段强化——【发言配额】带节奏感知（你上次开口在多久前）+ 发言热度阈值下调
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑即复现
// 幂等：每个补丁点带唯一标记 [qqagent-talkstyle-patch:<id>]；已含标记 = 跳过
// 边界：不动安全边界 / Electron 壳 / 触发策略；不加任何本地门（接不接话仍由模型决定）
//
// 🔴 补丁链顺序（后落者改写了上游锚点所在文本，顺序不可颠倒）：
//   session → engage → nosys → memory → sessions-fold → botguard → hardlimit → **本补丁**
//   本补丁改写的 buildSystemPrompt 首行是 nosys 补丁的产物 —— 替换文本保留其标记
//   [qqagent-nosys-patch:disable] 所在注释行（只替换其下的 if 语句），故 nosys 复跑仍 skip。
//
// 设计要点（Rushiera 2026-10-10 拍板 · 方案 C）：
//   问题：v0.10 关闭系统提示段省了 4360 字符/轮，但把「可以不回」「不是每条都接」
//         「群聊不是客服队列」这套纪律一起关掉了 —— 模型失去"沉默是正常节奏"的授权。
//         存档实测：三群群友块被接话率 97~100%，两个群 bot 说得比人还多。
//   ① 精简模式（lean）：只留 lead + subjectivity + speakOrNot + notAQueue + humanRhythm
//      （≈1.2KB/轮），安全 / 工具协议 / 记忆 / 表情 / 场景 / 举报等段省略。
//      模式三态：full（全量）/ lean（精简）/ off（完全不发）。
//   ② 节奏感知：模型对时间流逝无感知 —— 不告诉它"你刚说过话"，它就把每条新消息
//      都当待回的消息。故 quotaState 带 sinceLastMs，渲染成【发言配额】里的节奏句。
//   ③ 热度阈值：SOFT_COUNT 8→5、SOFT_ROUNDS 3→2（原阈值偏高，软闸够不到）。
//
// 落点：
//   src/prompt.js        resolvePromptMode + buildSystemPrompt 模式分支
//   src/chatter.js       发言热度软阈值下调
//   src/sender.js        lastSentAt 表 + 记账 + quotaState.sinceLastMs
//   src/orchestrator.js  【发言配额】段节奏句

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-talkstyle-patch:' + id + ']';

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
// 补丁 1：src/prompt.js —— 系统提示模式（full / lean / off）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-mode', SRC, 'prompt.js',
`  if (getConfig().persona?.systemPromptEnabled === false) return '';`,
`  // [qqagent-talkstyle-patch:prompt-mode] 系统提示模式（2026-10-10）——
  //   full = 全量；lean = 只保留「说不说」纪律段；off = 完全不发。
  //   历史：v0.10 曾整段关闭（省 4360 字符/轮）；实测副作用 = 连"可以不回"的授权
  //   一起关掉 → 群内被接话率 97~100%（每句都回）。lean 是那次取舍的修正。
  const promptMode = resolvePromptMode(getConfig().persona);
  if (promptMode === 'off') return '';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/prompt.js —— resolvePromptMode（插在 buildSystemPrompt 之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-mode-fn', SRC, 'prompt.js',
`/** 组装系统提示。 */
export function buildSystemPrompt(`,
`/**
 * 解析系统提示模式（[qqagent-talkstyle-patch:prompt-mode-fn]）。
 * 三态：full（全量）/ lean（只留说话纪律段）/ off（完全不发）。
 * 兼容旧字段：persona.systemPromptEnabled === false 曾表示"整段关闭" ——
 * 现按本次修正映射为 lean（那次关闭的副作用正是本补丁要修的）。
 * @returns {'full'|'lean'|'off'}
 */
function resolvePromptMode(persona) {
  const m = String(persona?.systemPromptMode ?? '').trim().toLowerCase();
  if (m === 'full' || m === 'lean' || m === 'off') return m;
  if (persona?.systemPromptEnabled === false) return 'lean';
  return 'full';
}

/** 组装系统提示。 */
export function buildSystemPrompt(`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/prompt.js —— parts 组装按模式分支
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-lean', SRC, 'prompt.js',
`  const parts = [
    \`你是「\${cfg.botName}」，一个混在 QQ 群里的普通群友（不是助手、不是客服）。你的所有行为都通过工具完成，发言必须像真人。\`,
    '',
    securityRules(),`,
`  const lead = \`你是「\${cfg.botName}」，一个混在 QQ 群里的普通群友（不是助手、不是客服）。你的所有行为都通过工具完成，发言必须像真人。\`;
  // lean 模式（[qqagent-talkstyle-patch:prompt-lean]）：只留决定"开不开口"的四段 ——
  // 安全 / 工具协议 / 反 AI 味 / 群管家 / 引用 / 记忆 / 表情 / 场景 / 举报等段全省（≈1.2KB/轮）。
  const parts = promptMode === 'lean'
    ? [
        lead,
        '',
        subjectivity(),
        '',
        speakOrNot(cfg.participation),
        '',
        notAQueue(),
        '',
        humanRhythm()
      ]
    : [
        lead,
        '',
        securityRules(),`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/chatter.js —— 发言热度软阈值下调
// ─────────────────────────────────────────────────────────────────────────────
patch('chatter-thresholds', SRC, 'chatter.js',
`const SOFT_COUNT = 8;
const STRONG_COUNT = 15;
const SOFT_ROUNDS = 3;
const STRONG_ROUNDS = 5;`,
`// 阈值（2026-10-10 下调 · [qqagent-talkstyle-patch:chatter-thresholds]）——
// 原 8 条 / 3 轮偏高：实测群内被接话率 97~100%，软闸根本没够到。
// 硬阈值（STRONG_*）保持高门槛 —— L3"本轮建议不回复"是强建议，只在话极密时给。
const SOFT_COUNT = 5;
const STRONG_COUNT = 15;
const SOFT_ROUNDS = 2;
const STRONG_ROUNDS = 5;`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/sender.js —— 最近一次放行发送的时刻表
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-ctor', SRC, 'sender.js',
`    // 发言硬限制时间戳（[qqagent-hardlimit-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.hardTimes = new Map();   // chatKey -> [ts]`,
`    // 发言硬限制时间戳（[qqagent-hardlimit-patch:sender-ctor]）—— 滑动窗口内的发送时刻
    this.hardTimes = new Map();   // chatKey -> [ts]
    // 最近一次放行发送的时刻（[qqagent-talkstyle-patch:sender-ctor]）——
    // 供【发言配额】段渲染"你上次开口在多久前"；不受任何窗口过滤影响。
    this.lastSentAt = new Map();  // chatKey -> ts`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：src/sender.js —— 放行即记"最近开口时刻"
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-lastsent', SRC, 'sender.js',
`    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);`,
`    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
    // [qqagent-talkstyle-patch:sender-lastsent] 放行即记（抛错路径不经过这里）
    this.lastSentAt.set(chatKey, now);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：src/sender.js —— quotaState 带 sinceLastMs
// ─────────────────────────────────────────────────────────────────────────────
patch('sender-quotastate', SRC, 'sender.js',
`    if (!cands.length) return null;
    // 取更严者：剩余少者优先；并列取窗口更短者（约束更紧）
    cands.sort((a, b) => (a.remaining - b.remaining) || (a.windowMs - b.windowMs));
    return cands[0];`,
`    if (!cands.length) return null;
    // 取更严者：剩余少者优先；并列取窗口更短者（约束更紧）
    cands.sort((a, b) => (a.remaining - b.remaining) || (a.windowMs - b.windowMs));
    // 距上次开口的毫秒数（[qqagent-talkstyle-patch:sender-quotastate]）——null = 本群还没说过话
    const last = this.lastSentAt.get(chatKey);
    return { ...cands[0], sinceLastMs: last ? Math.max(0, now - last) : null };`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：src/orchestrator.js —— 【发言配额】段加节奏句
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-quota-rhythm', SRC, 'orchestrator.js',
`      return '\\n\\n【发言配额】本群最近 ' + Math.round(q.windowMs / 1000) + ' 秒已发 ' + q.used + ' 条 / 上限 ' + q.max + ' 条（还能发 ' + q.remaining + ' 条）。超限的发送会被系统拒绝 —— 按这个余量自行决定要不要开口；不值得说就安静结束。';`,
`      // 节奏句（[qqagent-talkstyle-patch:orchestrator-quota-rhythm]）——
      // 模型对时间流逝无感知：不告诉它"你刚说过话"，它就把每条新消息都当待回的消息。
      const rhythm = (q.sinceLastMs === null || q.sinceLastMs === undefined)
        ? '你还没在本群开过口。'
        : (q.sinceLastMs < 60000
          ? '你 ' + Math.max(1, Math.round(q.sinceLastMs / 1000)) + ' 秒前刚说过话 —— 没人接你、也没新东西，就先别说。'
          : '你上次开口在 ' + Math.round(q.sinceLastMs / 60000) + ' 分钟前。');
      return '\\n\\n【发言配额】本群最近 ' + Math.round(q.windowMs / 1000) + ' 秒已发 ' + q.used + ' 条 / 上限 ' + q.max + ' 条（还能发 ' + q.remaining + ' 条）· ' + rhythm + '超限的发送会被系统拒绝 —— 不值得说就安静结束。';`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
