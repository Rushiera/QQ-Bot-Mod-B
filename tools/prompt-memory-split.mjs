#!/usr/bin/env node
// QQBotB · B49 · 【记忆】段构成拆分（只读诊断器）
//
// 目的：把一次真实 prompt 里的【记忆】段按「会话要点 / 群记 / 群友印象」拆开，
//       输出各类字符数与占比 —— 日后动 O6（压缩记忆段）之前的基线数据。
//
// 边界来源（只读，不 import 任何业务模块）：
//   app/src/business/prompt.js:963-966        memText = [sessionMemText, groupMemText, memTextRaw]
//                                             以 \n 连接 → parts.push(`【记忆】\n${memText}`)
//   app/src/business/session-state.js:262     '【上一轮会话要点…收工沉淀】'
//   app/src/business/group-memory.js:304/320  '【本群】' / '【本群在聊】' + 段尾「（N 条同类条目未展开、N 条已归档…）」
//   app/src/business/memory.js:468/476        '【对群友的印象】' + 「（另有 N 条旧印象已归档…）」
//
// 启动时校对上述四处字面量仍在源文件里 —— 源文件改了而本脚本没跟，出声（边界漂移），
// 不静默按旧边界切（失败必须可见）。
//
// 用法：
//   node tools/prompt-memory-split.mjs --self-test
//   node tools/prompt-memory-split.mjs --from-file <prompt.txt|会话.json> [--json]
//     会话 json 会自动取 userPrompt（缺则取 inputMessages 里最后一条 role=user 的 content）。
//
// 口径：各类字符数 = 该段原文全部字符（含段头 `【记忆】` 与其行尾换行）；
//       占比 = 该类 / 各类合计，合计恒为 100%。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.QQBOTB_ROOT || 'D:/Mau/WorkSpace/QQBotB');
const SRC = path.join(ROOT, 'app/src/business');
const MEM_TAG = '【记忆】';

// 子段头：命中即切换归类（顺序敏感：【本群】要先于更宽松的前缀）
const SUBS = [
  { cat: 'session', label: '会话要点', prefix: '【上一轮会话要点', src: 'session-state.js', needle: '【上一轮会话要点' },
  { cat: 'group', label: '群记', prefix: '【本群】', src: 'group-memory.js', needle: '【本群】' },
  { cat: 'group', label: '群记', prefix: '【本群在聊', src: 'group-memory.js', needle: '【本群在聊】' },
  { cat: 'member', label: '群友印象', prefix: '【对群友的印象', src: 'memory.js', needle: '【对群友的印象】' },
];

// 已知顶层段头：【记忆】段到此为止
const TOP_HEADS = [
  '【前情提要', '【已读信息', '【新已读信息', '【未读信息', '【可用表情包',
  '【引导说明', '【角色设定', '【当前时间', '【表情包策略', '【新加入成员', '【配额',
];

const CAT_ORDER = ['head', 'session', 'group', 'member', 'unknown'];
const CAT_LABEL = {
  head: '段头（【记忆】）',
  session: '会话要点',
  group: '群记（【本群】+【本群在聊】+段尾归档提示）',
  member: '群友印象（【对群友的印象】+归档提示）',
  unknown: '未归类',
};

/** 只读校对边界字面量是否仍存在于源文件。 */
function checkBoundaries() {
  const warnings = [];
  const bySrc = new Map();
  for (const s of SUBS) {
    if (!bySrc.has(s.src)) {
      const fp = path.join(SRC, s.src);
      let text = null;
      try { text = fs.readFileSync(fp, 'utf8'); } catch (e) { warnings.push(`读不到 ${s.src}：${e.message}`); }
      bySrc.set(s.src, text);
    }
    const text = bySrc.get(s.src);
    if (text && !text.includes(s.needle)) warnings.push(`边界漂移：${s.src} 里找不到 ${s.needle}`);
    if (text === null) continue;
  }
  const pj = path.join(SRC, 'prompt.js');
  try {
    const p = fs.readFileSync(pj, 'utf8');
    if (!p.includes('${memText}')) warnings.push('边界漂移：prompt.js 里找不到记忆段拼接片段 ${memText}');
    if (!p.includes('formatSessionSummaryForPrompt') || !p.includes('formatGroupForPrompt')) {
      warnings.push('边界漂移：prompt.js 的三段取值点（会话要点 / 群记）有变化');
    }
  } catch (e) { warnings.push(`读不到 prompt.js：${e.message}`); }
  return warnings;
}

/**
 * 从一段 prompt 文本里切出【记忆】段并按子段归类。
 * @param {string} text 完整 prompt（含 user 提示）
 */
export function splitMemory(text) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  let startLine = -1;
  let rest = '';
  for (let i = 0; i < lines.length; i++) {
    const pos = lines[i].indexOf(MEM_TAG);
    if (pos >= 0) {
      startLine = i;
      rest = lines[i].slice(pos + MEM_TAG.length);
      break;
    }
  }
  if (startLine < 0) return { found: false, segText: '', total: 0, cats: {}, lineCount: 0 };

  /** @type {{cat: string, text: string}[]} */
  const picked = [{ cat: 'head', text: MEM_TAG }];
  let cur = null;
  if (rest) { cur = 'unknown'; picked.push({ cat: 'unknown', text: rest }); }

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trimStart();
    if (t.startsWith('【')) {
      const sub = SUBS.find((x) => t.startsWith(x.prefix));
      if (sub) { cur = sub.cat; picked.push({ cat: sub.cat, text: line }); continue; }
      const isTop = TOP_HEADS.some((p) => t.startsWith(p));
      if (isTop || cur !== null) break;   // 【记忆】段到此结束
      cur = 'unknown';                    // 段内自由文本里出现【…】，容忍
      picked.push({ cat: 'unknown', text: line });
      continue;
    }
    picked.push({ cat: cur || 'unknown', text: line });
  }

  const cats = {};
  const lineCount = {};
  let total = 0;
  let segText = '';
  for (let k = 0; k < picked.length; k++) {
    const piece = picked[k].text + (k < picked.length - 1 ? '\n' : '');
    segText += piece;
    total += piece.length;
    cats[picked[k].cat] = (cats[picked[k].cat] || 0) + piece.length;
    lineCount[picked[k].cat] = (lineCount[picked[k].cat] || 0) + 1;
  }
  return { found: true, segText, total, cats, lineCount };
}

/** 把 --from-file 目标读成纯 prompt 文本（json 会话文件自动取 userPrompt）。 */
function loadPromptFrom(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (obj && typeof obj === 'object') {
      if (typeof obj.userPrompt === 'string' && obj.userPrompt) {
        return { text: obj.userPrompt, origin: '会话 json · userPrompt', meta: obj };
      }
      const im = Array.isArray(obj.inputMessages) ? obj.inputMessages : [];
      const users = im.filter((m) => m && m.role === 'user' && typeof m.content === 'string');
      if (users.length) {
        return { text: users[users.length - 1].content, origin: '会话 json · inputMessages 最后一条 user', meta: obj };
      }
      throw new Error('会话 json 里既没有 userPrompt 也没有 inputMessages(role=user)');
    }
  }
  return { text: raw, origin: '纯文本', meta: null };
}

function renderReport(res, sourceLabel, originText, warnings) {
  const L = [];
  const pct = (n) => (res.total ? (n / res.total * 100) : 0);
  L.push(`📊 【记忆】段拆分 · 来源 ${sourceLabel}`);
  if (originText) L.push(`   ${originText}`);
  if (!res.found) {
    L.push('   未找到【记忆】段 —— 本份 prompt 里没有记忆（或该群记忆为空）。');
    if (warnings.length) L.push(...warnings.map((w) => `   ⚠️ ${w}`));
    return L.join('\n');
  }
  L.push(`   段内总字符 ${res.total} · 行数 ${res.lineCount.head + (res.lineCount.session || 0) + (res.lineCount.group || 0) + (res.lineCount.member || 0) + (res.lineCount.unknown || 0)}`);
  L.push('');
  L.push('   | 段落 | 字符数 | 占比 |');
  L.push('   |:--|--:|--:|');
  for (const cat of CAT_ORDER) {
    const n = res.cats[cat] || 0;
    if (!n && cat !== 'unknown') continue;
    if (!n && cat === 'unknown') continue;
    L.push(`   | ${CAT_LABEL[cat]} | ${n} | ${pct(n).toFixed(1)}% |`);
  }
  L.push(`   | **合计** | **${res.total}** | **100.0%** |`);
  const sum = CAT_ORDER.reduce((a, c) => a + (res.cats[c] || 0), 0);
  const sumPct = CAT_ORDER.reduce((a, c) => a + pct(res.cats[c] || 0), 0);
  L.push('');
  L.push(`   校验：字符合计 = ${sum}（应等于 ${res.total}）· 占比合计 = ${sumPct.toFixed(1)}%`);
  if (res.cats.unknown) L.push(`   ⚠️ 未归类 ${res.cats.unknown} 字符（段内出现无法识别的行，见下）`);
  if (warnings.length) L.push(...warnings.map((w) => `   ⚠️ ${w}`));
  return L.join('\n');
}

function selfTest() {
  const SESSION = '【上一轮会话要点（2026-10-25 13:55 收工沉淀）】\nI\'ll start by reviewing the existing group memory, then add what\'s new.';
  const GROUP_MAIN = '【本群】\n- 群规：约定：群友蹭 Rushiera 本地 4060 跑 moss 走代跑制\n- 梗：梗（10-22）：「大肥鱼」= DeepSeek';
  const GROUP_TOPIC = '【本群在聊】TurboLoRA；光辉模型；Illustrious；anima';
  const GROUP_TAIL = '（157 条同类条目未展开、43 条已归档——要看得用 查询记忆 memory_query / 检索记忆 memory_search）';
  const MEMBER = '【对群友的印象】\n- 小凡：他自称是实习生\n- 星期五（野生🐟）：以「🐟/鱼」为自称人设';
  const MEMBER_TAIL = '（另有 12 条旧印象已归档——要翻用 检索记忆 memory_search）';

  const cases = [];
  const add = (name, prompt, expect, extra) => cases.push({ name, prompt, expect, extra });

  // C1 三段齐全，记忆段在文末
  add('C1 三段齐全（记忆段在文末）',
    '【角色设定】head\n【可用表情包】abc\n\n【记忆】\n' + [SESSION, GROUP_MAIN, GROUP_TOPIC, GROUP_TAIL, MEMBER, MEMBER_TAIL].join('\n'),
    {
      head: MEM_TAG.length + 1,
      session: SESSION.length + 1,
      group: GROUP_MAIN.length + 1 + GROUP_TOPIC.length + 1 + GROUP_TAIL.length + 1,
      member: MEMBER.length + 1 + MEMBER_TAIL.length,
    });

  // C2 只有会话要点
  add('C2 仅会话要点', '【记忆】\n' + SESSION, { head: MEM_TAG.length + 1, session: SESSION.length });

  // C3 只有群记（含段尾归档提示行）
  add('C3 仅群记（含归档提示行）', '【记忆】\n' + [GROUP_MAIN, GROUP_TOPIC, GROUP_TAIL].join('\n'),
    {
      head: MEM_TAG.length + 1,
      group: GROUP_MAIN.length + 1 + GROUP_TOPIC.length + 1 + GROUP_TAIL.length,
    });

  // C4 只有群友印象（含归档提示行）
  add('C4 仅群友印象（含归档提示行）', '【记忆】\n' + [MEMBER, MEMBER_TAIL].join('\n'),
    { head: MEM_TAG.length + 1, member: MEMBER.length + 1 + MEMBER_TAIL.length });

  // C5 无【记忆】段
  add('C5 无【记忆】段', '【角色设定】x\n\n【已读信息】y', null);

  // C6 记忆段后接其它顶层段 + 段内条目含【】字样（不得误判新段）
  const SWALLOW = '【本群】\n- 群规：被说【安静】就收声，别辩解';
  add('C6 段内【】不误判 + 段后有其它段',
    '【记忆】\n' + SWALLOW + '\n\n【已读信息】z',
    {
      head: MEM_TAG.length + 1,
      group: ('【本群】'.length + 1) + (SWALLOW.split('\n')[1].length + 1),
    },
    { segText: '【记忆】\n【本群】\n- 群规：被说【安静】就收声，别辩解\n' });

  let pass = 0;
  const fails = [];
  for (const c of cases) {
    const r = splitMemory(c.prompt);
    const errs = [];
    if (!c.expect) {
      if (r.found) errs.push('期望找不到【记忆】段，实际找到了');
    } else {
      if (!r.found) errs.push('期望找到【记忆】段，实际没找到');
      else {
        for (const [cat, n] of Object.entries(c.expect)) {
          if ((r.cats[cat] || 0) !== n) errs.push(`${cat} 期望 ${n} 实际 ${r.cats[cat] || 0}`);
        }
        const sum = Object.values(r.cats).reduce((a, b) => a + b, 0);
        if (sum !== r.total) errs.push(`字符合计不等于段长（${sum} vs ${r.total}）`);
        const pctSum = sum / (r.total || 1) * 100;
        if (Math.abs(pctSum - 100) > 0.5) errs.push(`占比合计 ${pctSum.toFixed(2)}% 偏离 100%`);
        if (c.extra?.segText && r.segText !== c.extra.segText) {
          errs.push(`段文本不符：${JSON.stringify(r.segText)}`);
        }
      }
    }
    if (errs.length) fails.push(`${c.name}：${errs.join(' / ')}`);
    else pass++;
  }
  console.log(`SELFTEST ${fails.length ? 'FAIL' : 'PASS'} ${pass}/${cases.length}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  return fails.length === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  if (has('--self-test')) { process.exit(selfTest() ? 0 : 1); }

  const warnings = checkBoundaries();
  const file = valOf('--from-file');
  if (!file) {
    console.log('用法：');
    console.log('  node tools/prompt-memory-split.mjs --self-test');
    console.log('  node tools/prompt-memory-split.mjs --from-file <prompt.txt|会话.json> [--json]');
    console.log('说明：业务面没有 user 提示的预览入口（routes.js /api/prompt-preview 只出 systemPrompt + tools），');
    console.log('      故真实数据走 --from-file；会话 json 里会自动取 userPrompt。');
    if (warnings.length) console.log(warnings.map((w) => `⚠️ ${w}`).join('\n'));
    process.exit(2);
  }

  let loaded;
  try { loaded = loadPromptFrom(file); }
  catch (e) { console.error(`[失败] 读取 ${file}：${e.message}`); process.exit(1); }

  const res = splitMemory(loaded.text);
  const meta = loaded.meta;
  const origin = meta
    ? `会话 ${meta.id || '?'} · 群 ${meta.chatName || meta.chatKey || '?'} · 提示词 ${loaded.text.length} 字符`
    : `提示词 ${loaded.text.length} 字符`;
  if (has('--json')) {
    console.log(JSON.stringify({ file, origin: loaded.origin, found: res.found, total: res.total, cats: res.cats, lineCount: res.lineCount, warnings }, null, 2));
  } else {
    console.log(renderReport(res, path.basename(file), `${loaded.origin} · ${origin}`, warnings));
  }
}

main();
