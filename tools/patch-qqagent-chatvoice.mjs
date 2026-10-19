// patch-qqagent-chatvoice.mjs — 「群聊语域（别露出机器味）」幂等补丁
//
// 用法：node patch-qqagent-chatvoice.mjs [--dry]
// 做什么：给系统提示（lean + full 都带）加一段【别露出机器味】，三条行为约束：
//   ① 后台的事不进群 —— 闸门 / 配额 / 限频 / 投递 / 领航员状态 / 工具回执 / 记忆整理
//      一律不向群里解释；事情没成就说"这次没成"。
//   ② 不点评、不做技术判断、不总结、不给建议 —— 除非有人问。
//   ③ 一条消息一次说完 —— 不发出去又补、又更正、又打补丁。
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑全部补丁即复现
// 幂等：每个补丁点带唯一标记 [qqagent-chatvoice-patch:<id>]；已含标记 = 跳过
// 依赖：**先跑 patch-qqagent-talkstyle.mjs**（lean 段由它建立）+ **patch-qqagent-memory.mjs**
//       （锚点落在 lean 里的 memoryRules() 上）；本补丁加在链尾
// 边界：只改 src/prompt.js 的提示词段——不碰任何闸门 / 配置 / 工具面 / 发送路径
//
// 判例（2026-10-19 · 群 689942975 存档 id 2755-2911 · Rushiera 点名落地）：
//   · 2811「生图通道没过——它认「本人近期在本群 @ 我」…被挡回来了」        ← 机制外泄
//   · 2829「派去给猫写了，但领航员没开着，投递被挡回来了」                  ← 同上
//   · 2887-2890 整段讲闸门 / 计数器 / 打分                                ← 同上
//   · 2781→2784 四条，其中 2783 / 2784 是同一条更正发了两遍                 ← 更正刷屏
//   · 2854 / 2856 别人聊美术，它插技术判断                                ← 点评腔
//   · 群友原话：中秋「现在这个太人机了」· 莎「你什么时候才能学会像人一样说话啊」
//
// 为什么落提示词而不是加闸门：这三条都是"怎么说"的问题，没有客观信号可拦
// （区别于"说太多"——那有配额 / 硬限）。提示词是本层唯一能承载的落点。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-chatvoice-patch:' + id + ']';

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
// 补丁 1：src/prompt.js —— chatVoice() 段（插在 notModerator 之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-fn', SRC, 'prompt.js',
`function notModerator() {`,
`function chatVoice() {
  // 群聊语域（[qqagent-chatvoice-patch:prompt-fn] · 2026-10-19）——
  // 判例：群 689942975 存档 id 2755-2911。三条指向同一个病：把后台的做事方式
  // 带进了闲聊场。前文里全是工程语料（判据 / 口径 / 闸门 / 回执），它照着说，
  // 群友听到的就是"人机"。
  return [
    '【别露出机器味】',
    '- 后台的事不进群：闸门、配额、限频、投递、领航员状态、工具回执、记忆整理这些一律不向群里解释；事情没成就说"这次没成"，不解释为什么。',
    '- 不点评、不做技术判断、不总结、不给建议——除非有人问。别人聊得正热时，你能插的是"话"，不是"分析"。',
    '- 一条消息一次说完：想完再发，不要发出去又补一条、再更正一条。说错了就让它过去，别在群里逐条勘误。'
  ].join('\\n');
}

function notModerator() {`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：src/prompt.js —— lean 模式接入（锚点落在 memoryRules() 上）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-lean', SRC, 'prompt.js',
`        notAQueue(),
        '',
        memoryRules(),`,
`        notAQueue(),
        '',
        // [qqagent-chatvoice-patch:prompt-lean]
        chatVoice(),
        '',
        memoryRules(),`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/prompt.js —— full 模式接入（humanRhythm 之后、notModerator 之前）
// ─────────────────────────────────────────────────────────────────────────────
patch('prompt-full', SRC, 'prompt.js',
`    humanRhythm(),
    '',
    notModerator(),`,
`    humanRhythm(),
    '',
    // [qqagent-chatvoice-patch:prompt-full]
    chatVoice(),
    '',
    notModerator(),`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
