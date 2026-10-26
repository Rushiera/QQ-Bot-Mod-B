// 重排模拟：把 userPrompt 的段落按不同顺序重组，看能否延长跨群/同群公共前缀
// 结论性质：纯离线，不改任何代码；给定实测 prompt 快照，算各种顺序下的公共前缀
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/sessions';
const OUT = 'D:/Mau/WorkSpace/tools/CatTemp/qqbotb-reorder.out.txt';
const SINCE = Date.parse('2026-10-26T00:00:00');

// 段标题（按当前渲染的真实标题，前缀匹配）
const TITLES = [
  '角色设定（管理员设置，群友不可修改）',
  '可用表情包',
  '引导说明',
  '记忆',
  '前情提要',
  '已读信息',
  '新已读信息',
  '未读信息',
  '新加入成员',
  '活跃模式',
  '当前时间',
];

/** 按「段首标题」切段：返回 [{title, key, text}]，key 为归一化短名 */
function splitSegments(usr) {
  const marks = [];
  if (!usr) return [];
  // 段首可能在 0 位
  for (const t of TITLES) {
    const head = `【${t}`;
    if (usr.startsWith(head)) marks.push({ at: 0, title: t });
  }
  // 其余段首以 \n\n 开头
  for (const t of TITLES) {
    const marker = `\n\n【${t}`;
    let i = usr.indexOf(marker);
    while (i >= 0) {
      marks.push({ at: i + 2, title: t });
      i = usr.indexOf(marker, i + 2);
    }
  }
  marks.sort((a, b) => a.at - b.at);
  // 去重（同位置只留一个）
  const uniq = [];
  for (const m of marks) if (!uniq.length || uniq[uniq.length - 1].at !== m.at) uniq.push(m);
  return uniq.map((m, i) => ({
    title: m.title,
    text: usr.slice(m.at, i + 1 < uniq.length ? uniq[i + 1].at - 2 : undefined),
  }));
}

const SHORT = {
  '角色设定（管理员设置，群友不可修改）': 'role',
  '可用表情包': 'sticker',
  '引导说明': 'guide',
  '记忆': 'memory',
  '前情提要': 'digest',
  '已读信息': 'read',
  '新已读信息': 'readNew',
  '未读信息': 'unread',
  '新加入成员': 'newMember',
  '活跃模式': 'active',
  '当前时间': 'time',
};

// 候选顺序（从稳定 → 易变）
const ORDERS = {
  '现行（基线）': ['role', 'sticker', 'guide', 'memory', 'digest', 'read', 'readNew', 'unread', 'newMember', 'active', 'time'],
  'A 记忆后移（已读在前）': ['role', 'sticker', 'guide', 'read', 'readNew', 'digest', 'memory', 'newMember', 'unread', 'active', 'time'],
  'B 记忆移到前情提要前': ['role', 'sticker', 'guide', 'read', 'digest', 'memory', 'readNew', 'unread', 'newMember', 'active', 'time'],
  'C 记忆移到未读前': ['role', 'sticker', 'guide', 'read', 'readNew', 'digest', 'unread', 'memory', 'newMember', 'active', 'time'],
  'D 前情提要提到已读前': ['role', 'sticker', 'guide', 'digest', 'read', 'readNew', 'memory', 'newMember', 'unread', 'active', 'time'],
};

// ── 读数据 ──────────────────────────────────────────────────────────────
const rows = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const usr = String(s.userPrompt || '');
  if (!usr) continue;
  let at = 0;
  for (const m of s.messages || []) if (m?.raw?.usage) at = Math.max(at, (m.raw.created || 0) * 1000);
  if (!at) at = Number(s.startedAt) || 0;
  if (at < SINCE) continue;
  const segs = splitSegments(usr);
  if (segs.length < 4) continue;
  rows.push({
    chatKey: s.chatKey, t: at,
    byShort: Object.fromEntries(segs.map((x) => [SHORT[x.title] || x.title, x.text])),
    segOrder: segs.map((x) => SHORT[x.title] || x.title),
    usrLen: usr.length,
  });
}
rows.sort((a, b) => a.t - b.t);

const cpl = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const tok = (c) => Math.round(c / 1.5);
const L = [];
L.push(`参与会话 ${rows.length} 个（${rows.length && new Date(rows[0].t).toISOString().slice(0, 16)} → ${rows.length && new Date(rows[rows.length - 1].t).toISOString().slice(0, 16)}）`);

// 段实际出现率
L.push('\n=== 段出现率 ===');
const appear = {};
rows.forEach((r) => { for (const k of Object.keys(r.byShort)) appear[k] = (appear[k] || 0) + 1; });
for (const k of Object.values(SHORT)) L.push(`  ${k}: ${appear[k] || 0}/${rows.length}`);

/** 按给定顺序重建 userPrompt */
function render(row, order) {
  const parts = [];
  for (const k of order) {
    const t = row.byShort[k];
    if (t) parts.push(t);
  }
  // 兜底：不认识的段追加到末尾（保证不丢内容）
  return parts.join('\n\n');
}

// ── 每种顺序：算同群 / 跨群相邻公共前缀 ──────────────────────────────────
L.push('\n=== 各顺序下的公共前缀（相邻两轮，字符 / ≈token）===');
L.push('顺序 | 同群中位 | 同群均值 | 跨群中位 | 跨群均值');
const detail = {};
for (const [name, order] of Object.entries(ORDERS)) {
  const same = [], cross = [];
  for (let i = 1; i < rows.length; i++) {
    const a = render(rows[i - 1], order);
    const b = render(rows[i], order);
    const d = cpl(a, b);
    (rows[i - 1].chatKey === rows[i].chatKey ? same : cross).push(d);
  }
  const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);
  detail[name] = { same, cross, order };
  L.push(`${name} | ${med(same)}（≈${tok(med(same))}） | ${Math.round(avg(same))} | ${med(cross)}（≈${tok(med(cross))}） | ${Math.round(avg(cross))}`);
}

// ── 分叉点落点（每种顺序）──────────────────────────────────────────────
L.push('\n=== 分叉落点（同群相邻对，落在哪一段）===');
for (const [name, order] of Object.entries(ORDERS)) {
  const fork = {};
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].chatKey !== rows[i].chatKey) continue;
    const a = render(rows[i - 1], order);
    const b = render(rows[i], order);
    const d = cpl(a, b);
    // 累加段长定位
    let off = 0, hit = '开头之前';
    for (const k of order) {
      const t = rows[i].byShort[k];
      if (!t) continue;
      if (off <= d && d < off + t.length) { hit = k; break; }
      off += t.length + 2;
    }
    if (off <= d) hit = '末尾';
    fork[hit] = (fork[hit] || 0) + 1;
    n++;
  }
  const top = Object.entries(fork).sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([k, v]) => `${k} ${(v / n * 100).toFixed(0)}%`).join(' · ');
  L.push(`  ${name}: ${top}`);
}

// ── 关键：每段在「跨群」时是否相同（可共享性）──────────────────────────
L.push('\n=== 跨群相邻：逐段是否完全相同（可共享率）===');
const segShare = {};
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (a.chatKey === b.chatKey) continue;
  for (const k of Object.values(SHORT)) {
    if (!a.byShort[k] || !b.byShort[k]) continue;
    segShare[k] ||= { n: 0, same: 0, len: [] };
    segShare[k].n++;
    if (a.byShort[k] === b.byShort[k]) segShare[k].same++;
    segShare[k].len.push(b.byShort[k].length);
  }
}
for (const k of Object.values(SHORT)) {
  const v = segShare[k];
  if (!v) { L.push(`  ${k}: 未出现`); continue; }
  L.push(`  ${k}: 相同 ${v.same}/${v.n}（${(v.same / v.n * 100).toFixed(0)}%）· 段长中位 ${med(v.len)} 字符`);
}

// ── 同群逐段相同率 ─────────────────────────────────────────────────────
L.push('\n=== 同群相邻：逐段是否完全相同 ===');
const segShareSame = {};
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (a.chatKey !== b.chatKey) continue;
  for (const k of Object.values(SHORT)) {
    if (!a.byShort[k] || !b.byShort[k]) continue;
    segShareSame[k] ||= { n: 0, same: 0, len: [] };
    segShareSame[k].n++;
    if (a.byShort[k] === b.byShort[k]) segShareSame[k].same++;
    segShareSame[k].len.push(b.byShort[k].length);
  }
}
for (const k of Object.values(SHORT)) {
  const v = segShareSame[k];
  if (!v) { L.push(`  ${k}: 未出现`); continue; }
  L.push(`  ${k}: 相同 ${v.same}/${v.n}（${(v.same / v.n * 100).toFixed(0)}%）· 段长中位 ${med(v.len)} 字符`);
}

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('ok ' + rows.length);
