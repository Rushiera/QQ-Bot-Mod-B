// 角色卡语料统计——看「卡自己的原台词」里各特征的真实密度（2026-11-08 立）
//
// 用法：node tools/persona-card-stat.mjs [卡路径]       默认 personas/yoshino.md
// 定位：卡侧观测位点。群里怎么说不等于卡怎么写——本工具只统计卡面语料，供「卡 ↔ 实发」对比定调。
//   判据口径：日文台词行 = 含假名的正文行（排除 ``` 代码围栏标记行本身）；
//   **反例行以 ✗ 开头，一律不计入**（反例里必然出现被禁的写法，算进密度会污染基线）；
//   特征计数 = 该特征在日文行里的出现行数 / 出现次数。
// 判例：design-qqbotb_log.md §一百一十五（首轮：でして 32 次 / 18 句，全部句尾；おや 10 次，全部句首）
import fs from 'node:fs';
import path from 'node:path';

const CARD = process.argv[2] || 'D:/Mau/WorkSpace/QQBotB/personas/yoshino.md';
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;

// 句子语尾（收句形态）——按出现次数计
const TAIL = [
  ['でして', /でして/g],
  ['のでして', /なのでして/g],
  ['ございまして', /ございまして/g],
  ['ませぬ', /ませぬ/g],
  ['でしょう', /でございましょう|でしょう/g],
  ['ましょう', /ましょう/g],
  ['ませんか', /ませんか/g],
  ['のです/ので', /なので|のです/g]
];

// 语气词（多见于句首）——按出现次数计，并单独记「行首」次数
const INTERJ = [
  ['おや', /おや/g],
  ['ほー', /ほー/g],
  ['あら', /あら/g],
  ['ふふ', /ふふ/g],
  ['ふむ', /ふむ|ふーむ/g],
  ['さぁ/ほら', /さぁ|ほらー/g]
];

// 中文侧载体——卡给中文正文用的等价物
const ZH = [
  ['呢——', /呢——/g],
  ['是也——', /是也——/g],
  ['哦呀——', /哦呀——/g],
  ['哎呀——', /哎呀——/g],
  ['呵呵——', /呵呵——/g]
];

/** 取一行的「台词片段」：优先取「」内的引用，没有引用则整行算一个片段。 */
function segments(line) {
  const out = [];
  const re = /「([^」]*)」/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1]);
  if (!out.length) out.push(line.replace(/^[>*\s]+/, '').replace(/\*\*/g, ''));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 片段是否以该词起头。 */
const leadSeg = (w, segs) => segs.filter((s) => s.startsWith(w)).length;
/** 片段是否以该词（或其延续形态）收尾。 */
const tailSeg = (w, segs) => segs.filter((s) => new RegExp(w + '[ー。、！？」』…\\s]*$').test(s)).length;

const text = fs.readFileSync(CARD, 'utf8').replace(/\r\n/g, '\n');
const lines = text.split('\n');

/** 按 ## 二级标题切段。 */
const sections = [];
let cur = { name: '（文件头）', lines: [] };
for (const ln of lines) {
  const m = ln.match(/^##\s+(.*)$/);
  if (m) { sections.push(cur); cur = { name: m[1].trim(), lines: [] }; } else cur.lines.push(ln);
}
sections.push(cur);

const count = (s, re) => (s.match(re) || []).length;

const rows = [];
const total = {
  jp: 0,
  tail: Object.fromEntries(TAIL.map(([k]) => [k, 0])),
  interj: Object.fromEntries(INTERJ.map(([k]) => [k, 0])),
  lead: Object.fromEntries(INTERJ.map(([k]) => [k, 0])),
  zh: Object.fromEntries(ZH.map(([k]) => [k, 0]))
};

for (const sec of sections) {
  const isTable = (l) => /^\s*\|/.test(l);
  // 说明行（含 ✗ 反例标 / 含反引号的元描述）不计入统计——它们引用特征，不是台词本体
  const body = sec.lines.filter((l) => !l.includes('✗') && !isTable(l)).join('\n');
  const jpLines = sec.lines.filter((l) => KANA.test(l) && !/^\s*```/.test(l)
    && !l.includes('✗') && !l.includes('`') && !isTable(l));
  if (!jpLines.length) continue;
  const jpText = jpLines.join('\n');
  const row = { name: sec.name, jp: jpLines.length, tail: {}, interj: {}, lead: {}, zh: {} };
  for (const [k, re] of TAIL) { row.tail[k] = count(jpText, re); total.tail[k] += row.tail[k]; }
  for (const [k, re] of INTERJ) {
    row.interj[k] = count(jpText, re);
    row.lead[k] = jpLines.reduce((n, l) => n + leadSeg(k.split('/')[0], segments(l)), 0);
    total.interj[k] += row.interj[k];
    total.lead[k] += row.lead[k];
  }
  for (const [k, re] of ZH) { row.zh[k] = count(body, re); total.zh[k] += row.zh[k]; }
  total.jp += row.jp;
  rows.push(row);
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
const out = [];
out.push(`# ${path.basename(CARD)} · 语料特征统计`);
out.push(`\n日文台词行合计 **${total.jp}** 行（含假名的正文行，一个 ## 段内计一次）\n`);

out.push('## 一、语尾形态（收句 · 出现次数 / 占日文行比）');
out.push('| 形态 | 次数 | 每百日文行 | 说明 |');
out.push('|:--|--:|--:|:--|');
for (const [k] of TAIL) {
  out.push(`| ${k} | ${total.tail[k]} | ${total.jp ? ((total.tail[k] / total.jp) * 100).toFixed(1) : '—'} | ${k.includes('でして') ? '签名语尾' : ''} |`);
}

out.push('\n## 二、语气词（出现次数 / 行首次数）');
out.push('| 词 | 次数 | 其中行首 | 行首占比 |');
out.push('|:--|--:|--:|--:|');
for (const [k] of INTERJ) {
  out.push(`| ${k} | ${total.interj[k]} | ${total.lead[k]} | ${pct(total.lead[k], total.interj[k])} |`);
}

out.push('\n## 三、中文侧载体（卡给中文正文的等价物）');
out.push('| 载体 | 次数 |');
out.push('|:--|--:|');
for (const [k] of ZH) out.push(`| ${k} | ${total.zh[k]} |`);

out.push('\n## 四、分段明细（只列含日文行的段）');
out.push('| 段 | 日文行 | でして | おや | ほー | あら | ふふ | ふむ | 呢—— |');
out.push('|:--|--:|--:|--:|--:|--:|--:|--:|--:|');
for (const r of rows) {
  out.push(`| ${r.name} | ${r.jp} | ${r.tail['でして']} | ${r.interj['おや']} | ${r.interj['ほー']} | ${r.interj['あら']} | ${r.interj['ふふ']} | ${r.interj['ふむ']} | ${r.zh['呢——']} |`);
}

// 位置判据：でして 是否都在句尾；おや 是否都在句首
const allSegs = sections.flatMap((s) => s.lines.filter((l) => KANA.test(l) && !/^\s*```/.test(l)
  && !l.includes('✗') && !l.includes('`') && !/^\s*\|/.test(l)).flatMap(segments));
const deshiteSegs = allSegs.filter((s) => /でして/.test(s));
const deshiteTail = tailSeg('でして', deshiteSegs);
const oyaSegs = allSegs.filter((s) => /おや/.test(s));
const oyaLead = leadSeg('おや', oyaSegs);
out.push('\n## 五、位置判据（按台词片段计，非按行）');
out.push(`- \`でして\` 出现在 **${deshiteSegs.length}** 个台词片段，其中**收句** **${deshiteTail}** 个（${pct(deshiteTail, deshiteSegs.length)}）`);
out.push(`- \`おや\` 出现在 **${oyaSegs.length}** 个台词片段，其中**起头** **${oyaLead}** 个（${pct(oyaLead, oyaSegs.length)}）`);

// 用法一览：でして 的每个片段（去重）+ 位置标记
const uniq = [...new Set(deshiteSegs)];
out.push('\n## 六、`でして` 用法一览（去重 · 位置按「是否收在片段末尾」分）');
out.push('| # | 位置 | 片段 |');
out.push('|--:|:--|:--|');
uniq.forEach((s, i) => {
  const isTail = /でして[ー。、！？」』…\s]*$/.test(s.trim());
  out.push(`| ${i + 1} | ${isTail ? '段末' : '段内句末'} | ${s.replace(/\|/g, '\\|')} |`);
});

console.log(out.join('\n'));
