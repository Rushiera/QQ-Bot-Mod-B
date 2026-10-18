// QQBotB 前文结构解剖 v3：按注入文件归组 + 记忆/已读细分
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:/Mau/WorkSpace/QQBotB/_unpack/data/sessions';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const SINCE = Date.parse('2026-10-17T00:00:00Z');

let top = null;
for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!s.startedAt || s.startedAt < SINCE) continue;
  const im = Array.isArray(s.inputMessages) ? s.inputMessages : [];
  if (!im.length) continue;
  const sys = im.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
  const usr = im.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');
  const calls = (s.messages || []).filter((m) => m?.raw?.usage).map((m) => m.raw.usage);
  const maxPrompt = calls.reduce((a, u) => Math.max(a, Number(u.prompt_tokens) || 0), 0);
  const len = sys.length + usr.length;
  if (!top || len > top.len) {
    top = { id: s.id, chatKey: s.chatKey, chatName: s.chatName, startedAt: s.startedAt, sys, usr, len, maxPrompt, tier: s.contextTier, reason: s.contextReason, limit: s.contextLimit, anchor: s.promptAnchorMode };
  }
}
const L = [];
const TOK = (n) => Math.round(n / 1.51);
L.push(`群 ${top.chatKey} ${top.chatName} | 会话 ${top.id} | ${new Date(top.startedAt).toISOString()}`);
L.push(`总计 ${top.len} 字符 ≈ ${TOK(top.len)} tokens（实测 prompt_tokens ${top.maxPrompt}）| tier=${top.tier} reason=${top.reason} contextLimit=${top.limit} anchor=${top.anchor}`);

const parts = top.usr.split(/\n\n(?=【)/);
const seg = (pred) => parts.find(pred) || '';
const rolePart = seg((p) => p.startsWith('【角色设定'));
const readPart = seg((p) => p.startsWith('【已读信息'));
const newReadPart = seg((p) => p.startsWith('【新已读信息'));
const unreadPart = seg((p) => p.startsWith('【未读信息'));
const memPart = seg((p) => p.startsWith('【记忆'));

L.push('');
L.push('=== 总量分解 ===');
const table = [
  ['system（lean 系统提示）', top.sys.length],
  ['角色设定（注入前文）', rolePart.length],
  ['已读信息', readPart.length],
  ['记忆', memPart.length],
  ['新已读信息', newReadPart.length],
  ['未读信息', unreadPart.length],
  ['其它（引导/表情包/配额/时间等）', top.len - top.sys.length - rolePart.length - readPart.length - memPart.length - newReadPart.length - unreadPart.length]
];
for (const [k, v] of table.sort((a, b) => b[1] - a[1])) {
  L.push(`${String(v).padStart(7)} 字符 ${(v / top.len * 100).toFixed(1).padStart(5)}% ≈${String(TOK(v)).padStart(6)} tok  ${k}`);
}

// 角色设定 → 按注入文件归组
L.push('\n=== 【角色设定】按注入文件归组 ===');
const lines = rolePart.split('\n');
const blocks = [];
let cur = { name: '(段首：人格 + 标题)', len: 0 };
for (const ln of lines) {
  const m = ln.match(/^## (.+)$/);
  const isFileHead = m && (/\.md$/.test(m[1].trim()) || /^L\d\//.test(m[1].trim()));
  if (isFileHead) {
    blocks.push(cur);
    cur = { name: m[1].trim(), len: ln.length + 1 };
  } else {
    cur.len += ln.length + 1;
  }
}
blocks.push(cur);
for (const b of blocks.filter((x) => x.len > 0).sort((a, b) => b.len - a.len)) {
  L.push(`${String(b.len).padStart(7)} ${(b.len / rolePart.length * 100).toFixed(1).padStart(5)}% ≈${String(TOK(b.len)).padStart(6)} tok  ${b.name}`);
}

// 记忆细分
L.push('\n=== 【记忆】细分 ===');
for (const p of memPart.split(/\n(?=【)/)) {
  const t = (p.match(/^【[^】]*】/) || ['(正文)'])[0];
  L.push(`${String(p.length).padStart(6)} 字符 ≈${String(TOK(p.length)).padStart(5)} tok  ${t}`);
}

// 已读信息：条数、时间跨度
L.push('\n=== 【已读信息】规模 ===');
const msgLines = readPart.split('\n').filter((x) => /^\[\d\d-\d\d /.test(x.trim()));
L.push(`消息行 ${msgLines.length} 条 · 总字符 ${readPart.length} · 均 ${Math.round(readPart.length / (msgLines.length || 1))} 字符/条 ≈ ${(TOK(readPart.length) / (msgLines.length || 1)).toFixed(0)} tok/条`);
if (msgLines.length) {
  L.push(`首条 ${msgLines[0].slice(0, 24)}`);
  L.push(`末条 ${msgLines[msgLines.length - 1].slice(0, 24)}`);
}
// 发言人分布（前 8）
const who = {};
for (const l of msgLines) {
  const m = l.match(/^\[[^\]]+\]\s*(?:#\d+\s*)?([^：:]{1,30})[：:]/);
  if (m) who[m[1].trim()] = (who[m[1].trim()] || 0) + 1;
}
L.push('发言人分布（前 8）: ' + Object.entries(who).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' | '));

fs.writeFileSync('D:/Mau/WorkSpace/CatTemp/qqbotb-prompt-anatomy3.out.txt', L.join('\n'), 'utf8');
console.log('ok ' + L.length);
