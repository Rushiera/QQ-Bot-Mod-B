// patch-qqagent-nosys.mjs — QQ Agent v0.4.0「系统提示段关闭」幂等补丁
//
// 用法：node patch-qqagent-nosys.mjs [--dry]
// 做什么：1) buildSystemPrompt 加总开关 —— persona.systemPromptEnabled=false 时返回空串
//         2) 系统提示为空时不发 system 消息（空 content 的 system 消息会被部分端点拒绝）
// 语义：源码改动的唯一落盘通道 —— 重装应用后按顺序重跑（session → engage → 本补丁）即复现
// 幂等：每个补丁点带唯一标记 [qqagent-nosys-patch:<id>]；已含标记 = 跳过
// 依赖：独立（不依赖 session / engage 补丁的产物）
// 边界：不动安全边界 / Electron 壳 / 存档 / 工具面
// 回退：config.json 里 persona.systemPromptEnabled 改回 true（或删该字段）即恢复系统提示
//
// 设计要点（Rushiera 2026-10-10 口述规格）：
//   每轮运行重发的 4360 字符系统提示（行为准则段）去掉 —— 运行提示词只留用户消息
//   （角色设定 + 存档消息 + 记忆 / 热度 / 配额等动态段）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-nosys-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(SRC, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 70)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：prompt.js —— buildSystemPrompt 总开关
// ─────────────────────────────────────────────────────────────────────────────
patch(
  'disable',
  'prompt.js',
  [
    'export function buildSystemPrompt({ persona, skillContext, extraSections = [] } = {}) {',
    '  const cfg = persona ?? getConfig().persona;'
  ].join('\n'),
  [
    'export function buildSystemPrompt({ persona, skillContext, extraSections = [] } = {}) {',
    '  // [qqagent-nosys-patch:disable] 系统提示段总开关：persona.systemPromptEnabled=false 时',
    '  // 整段不组装（运行提示词只剩用户消息：角色设定 + 存档消息 + 记忆/热度/配额等动态段）。',
    '  // 读全局配置而非传入 persona —— 分会话人设（personaByChat）的合并结果不保证带本字段。',
    '  if (getConfig().persona?.systemPromptEnabled === false) return \'\';',
    '  const cfg = persona ?? getConfig().persona;'
  ].join('\n')
);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：orchestrator.js —— 空系统提示时不发 system 消息
// ─────────────────────────────────────────────────────────────────────────────
patch(
  'skip-empty-system',
  'orchestrator.js',
  [
    '    const messages = [',
    "      { role: 'system', content: systemPrompt },",
    "      { role: 'user', content: (proactive",
    '        ? `${userPrompt}\\n\\n【未读信息】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`',
    '        : userPrompt) + quotaLine + chatterHint }',
    '    ];'
  ].join('\n'),
  [
    '    // [qqagent-nosys-patch:skip-empty-system] 系统提示为空时不发 system 消息',
    '    // （空 content 的 system 消息会被部分端点拒绝；关掉系统提示后只剩用户消息）。',
    '    const messages = [];',
    "    if (String(systemPrompt || '').trim()) messages.push({ role: 'system', content: systemPrompt });",
    '    messages.push({',
    "      role: 'user', content: (proactive",
    '        ? `${userPrompt}\\n\\n【未读信息】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`',
    '        : userPrompt) + quotaLine + chatterHint',
    '    });'
  ].join('\n')
);

console.log(JSON.stringify({ ok: true, dry: DRY, results }, null, 2));
