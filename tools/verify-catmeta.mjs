// tools/verify-catmeta.mjs —— 猫派生状态判定的守门自测
//
// 判据来源：并发协议 panel（Program.cs IsOverwork / IsOverworkReport / SettleOf / OverworkOf
// 与 SessionViewReader.ScanTail）——本项目逐条复刻，本自测就是「复刻得像不像」的实证。
// 四组：① 收工指令识别　② 收工报告识别　③ 核销分档　④ 收工态四值 + 真实会话尾部读取
// 跑法：node tools/verify-catmeta.mjs（退出码 0 = 全绿）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOverwork, isOverworkReport, settleOf, overworkOf, createCatMeta } from '../app/src/navigator/catmeta.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];

/**
 * 断言。
 *
 * @param {string} label 用例名
 * @param {*} actual 实得
 * @param {*} expect 期望
 * @returns {void}
 */
function eq(label, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) { pass += 1; return; }
  fails.push(`${label}：期望 ${e}，实得 ${a}`);
}

// ── ① 收工指令 ──────────────────────────────────────────────────────────────
eq('收工·强形态「收工」', isOverwork('收工'), true);
eq('收工·强形态带后续「收工，然后看眼 X」', isOverwork('收工，然后帮我看眼 X'), true);
eq('收工·同义「沉淀」', isOverwork('沉淀'), true);
eq('收工·弱形态「做完直接收工」', isOverwork('做完直接收工'), true);
eq('收工·弱形态「那就收工。」', isOverwork('那就收工。'), true);
eq('收工·语气词「收工吧」', isOverwork('收工吧'), true);
eq('收工·疑问「能收工吗」', isOverwork('能收工吗'), true);
eq('收工·反例：讨论长文（>40 字）', isOverwork('比如说可以收工 或者你能够主观判断出这是一句收工指令的那些词 这些讨论就属于反例 需要说明'), false);
eq('收工·反例：名词形态「收工报告」', isOverwork('收工报告'), false);
eq('收工·反例：空串', isOverwork(''), false);

// ── ② 收工报告 ──────────────────────────────────────────────────────────────
eq('报告·行首「## 收工报告」', isOverworkReport('## 收工报告\n\n本轮做完了。'), true);
eq('报告·行首「收工完成。」', isOverworkReport('收工完成。\n\n明细如下。'), true);
eq('报告·尾窗「继续会话指令」', isOverworkReport(`${'x'.repeat(600)}\n[继续会话指令] 下一轮从这里接`), true);
eq('报告·尾窗「遗留项去向」', isOverworkReport(`${'y'.repeat(600)}\n遗留项去向：已登记 todo`), true);
eq('报告·反例：普通回复', isOverworkReport('我看了一下，这个函数应该改返回值。'), false);
eq('报告·反例：句中提「收工报告」', isOverworkReport('面板的收工报告判定应该认遗留段，不能只看开头。'), false);

// ── ③ 核销分档 ──────────────────────────────────────────────────────────────
eq('核销·整体级声明 clean', settleOf('本轮分支已核销，其余原样在盘。').state, 'clean');
eq('核销·组内否定「本轮无核销」不算声明', settleOf('本轮无核销，还有三条待办。').state, 'open');
eq('核销·未尽信号 open', settleOf('遗留 3 条待办，下一步继续。').state, 'open');
eq('核销·否定贴邻「无遗留」clean', settleOf('无遗留，全部已清。').state, 'clean');
eq('核销·后置否定「遗留：无」clean', settleOf('遗留：无\n待办：无').state, 'clean');
eq('核销·空报告', settleOf('').state, '');

// ── ④ 收工态四值 ────────────────────────────────────────────────────────────
eq('收工态·人说收工猫还在跑 → doing', overworkOf('user', '收工', false, '', true, 'run'), 'doing');
eq('收工态·人说了、猫回了、已停 → done', overworkOf('cat', '收工', false, '', true, 'idle'), 'done');
eq('收工态·人说收工、报告有未尽 → doneOpen', overworkOf('cat', '收工', false, 'open', true, 'idle'), 'doneOpen');
eq('收工态·人没说、猫自己出报告 → done', overworkOf('cat', '下一步做什么', true, 'clean', true, 'idle'), 'done');
eq('收工态·猫还在跑但已出报告 → doing', overworkOf('cat', '下一步做什么', true, 'clean', true, 'think'), 'doing');
eq('收工态·无收工信号 → 空', overworkOf('cat', '继续做', false, '', true, 'idle'), '');

// ── ⑤ 真实会话尾部读取（会话根从 CH4 受控根表解析）────────────────────────
const meta = createCatMeta({ log: { warn: (m) => console.log('[warn]', m) }, mainPort: 8080 });
const root = await meta.resolveRoot();
if (!root || !fs.existsSync(root)) {
  console.log('SKIP ⑤ 会话根不可达（CH4 未跑 / 受控根表读不到）——前四组已验');
} else {
  const ids = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, `${name}.view.jsonl`)));
  const sample = ids.slice(0, 6);
  eq('尾部·取到样本猫', sample.length > 0, true);
  const enriched = await meta.enrich(sample.map((id) => ({ id, name: id, running: true, runState: 'idle', lastActiveAt: Date.now() })));
  eq('尾部·每只都有 speaker 字段', enriched.every((row) => typeof row.speaker === 'string'), true);
  eq('尾部·每只都有 calls 字段', enriched.every((row) => Number.isInteger(row.calls)), true);
  eq('尾部·每只都有 mount 字段', enriched.every((row) => typeof row.mount === 'string'), true);
  eq('尾部·overwork 取值合法', enriched.every((row) => ['', 'doing', 'done', 'doneOpen'].includes(row.overwork)), true);
  const withReply = enriched.filter((row) => row.speaker === 'cat').length;
  console.log(`⑤ 样本 ${sample.length} 只 · 末条是猫的 ${withReply} 只 · mount 非空 ${enriched.filter((r) => r.mount).length} 只`);
  // 缓存命中：同一批再跑一次应给出同样结果（双键缓存不改变判定）
  const again = await meta.enrich(sample.map((id) => ({ id, name: id, running: true, runState: 'idle', lastActiveAt: Date.now() })));
  eq('尾部·二次读取与首次同判', again.map((r) => `${r.speaker}|${r.calls}|${r.overwork}`), enriched.map((r) => `${r.speaker}|${r.calls}|${r.overwork}`));
}

console.log(`\n${fails.length ? 'FAIL' : 'PASS'} ${pass}/${pass + fails.length}`);
for (const line of fails) console.log('  ✗', line);
process.exit(fails.length ? 1 : 0);
