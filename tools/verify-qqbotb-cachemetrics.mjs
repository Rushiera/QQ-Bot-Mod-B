// verify-qqbotb-cachemetrics.mjs —— 缓存观测采集面自测
//
// 用法：node tools/verify-qqbotb-cachemetrics.mjs
//
// 覆盖：
//   1 分段切分：段首识别正确、正文里出现同名标题不误判
//   2 指纹稳定性：同段同哈希、改一个字符即变
//   3 记录落盘：字段齐备、headGapSec / sameChatGapSec 正确
//   4 逐段比对：sameChatSameSecs 只保留前导连续相同的段
//   5 旁路语义：usage 缺字段不抛、目录不可写不抛
// 产物写到临时目录，跑完自清。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '_unpack', 'resources', 'app', 'src');

// 用临时 DATA_DIR 引导模块（config.js 在 import 期读环境变量）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbotb-cachemetrics-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e?.message ?? String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const mod = await import(pathToFileURL(path.join(SRC, 'cache-metrics.js')).href);
const { splitSections, recordCacheCall, cachedOf, cacheMetricsDir } = mod;

// ── 1. 分段切分 ────────────────────────────────────────────────────────────
check('分段：识别全部段首', () => {
  const usr = [
    '【角色设定（管理员设置，群友不可修改）】\n你是猫',
    '【可用表情包】\n- 笑脸',
    '【引导说明】\n- 扫一眼【已读信息】和【未读信息】',   // ← 正文里出现同名标题，不得误判
    '【记忆】\n- 印象',
    '【已读信息】\n- msg1',
    '【新已读信息】\n- msg2',
    '【未读信息】\n- msg3',
    '【当前时间】2026-10-26 23:00:00',
  ].join('\n\n');
  const segs = splitSections(usr);
  const keys = segs.map((s) => s.key);
  assert(keys.length === 8, '段数应为 8，实际 ' + keys.length + '：' + keys.join(','));
  assert(keys[2] === 'guide', '第 3 段应为 guide，实际 ' + keys[2]);
  // 【引导说明】段必须完整包含正文里的【已读信息】字样（没被切开）
  assert(segs[2].text.includes('【已读信息】'), '引导说明段被误切：' + JSON.stringify(segs[2].text.slice(0, 60)));
  return keys.join(',');
});

check('分段：空串返回空数组', () => {
  assert(splitSections('').length === 0, '空串应返回空数组');
  assert(splitSections(null).length === 0, 'null 应返回空数组');
});

check('分段：无标题的纯文本不产生段', () => {
  const segs = splitSections('就是一段普通文字，没有任何标题');
  assert(segs.length === 0, '不应产生段，实际 ' + segs.length);
});

// ── 2. 指纹（通过落盘行的 secHashes 观察）──────────────────────────────────
const usage = (p, c) => ({ prompt_tokens: p, completion_tokens: 10, total_tokens: p + 10, prompt_tokens_details: { cached_tokens: c } });
// 长前缀：head 取样 4096 字符必须整段落在稳定前缀里（真实 prompt 前缀 6k+ 字符）
const ROLE = '【角色设定（管理员设置，群友不可修改）】\n' + '你是猫娘。'.repeat(900);
const usr1 = ROLE + '\n\n【记忆】\nM1\n\n【已读信息】\nR1\n\n【当前时间】T1';
const usr2 = ROLE + '\n\n【记忆】\nM1\n\n【已读信息】\nR2\n\n【当前时间】T2';

recordCacheCall({ chatKey: 'group:1', sessionId: 's1', model: 'm', round: 0, usage: usage(1000, 800), systemPrompt: 'SYS', userPrompt: usr1, anchorMode: 'reset' });
const file1 = path.join(cacheMetricsDir(), fs.readdirSync(cacheMetricsDir()).find((f) => f.startsWith('cache-')));
const row1 = JSON.parse(fs.readFileSync(file1, 'utf8').trim().split('\n').pop());

check('落盘：字段齐备', () => {
  const need = ['ts', 'chat', 'sid', 'model', 'round', 'promptTokens', 'cachedTokens', 'sysChars', 'usrChars', 'sysHash', 'headHash', 'headGapSec', 'sameChatGapSec', 'secHashes', 'secLens', 'sameChatSameSecs', 'anchorMode', 'readChars', 'digestChars'];
  const missing = need.filter((k) => !(k in row1));
  assert(!missing.length, '缺字段：' + missing.join(','));
  assert(row1.promptTokens === 1000, 'promptTokens 应为 1000');
  assert(row1.cachedTokens === 800, 'cachedTokens 应为 800');
  assert(row1.anchorMode === 'reset', 'anchorMode 应为 reset');
  return need.length + ' 字段齐备';
});

check('落盘：首条无前序 → headGapSec / sameChatGapSec 为 null', () => {
  assert(row1.headGapSec === null, 'headGapSec 应为 null，实际 ' + row1.headGapSec);
});

// 第二条：同群、读段变了
recordCacheCall({ chatKey: 'group:1', sessionId: 's1', model: 'm', round: 1, usage: usage(1100, 900), systemPrompt: 'SYS', userPrompt: usr2, anchorMode: 'anchored' });
const row2 = JSON.parse(fs.readFileSync(file1, 'utf8').trim().split('\n').pop());

check('落盘：同群第二条有 sameChatGapSec', () => {
  assert(typeof row2.sameChatGapSec === 'number' && row2.sameChatGapSec >= 0, 'sameChatGapSec 应为数字');
  assert(typeof row2.headGapSec === 'number', 'headGapSec 应为数字（系统提示+开头相同）');
});

check('比对：sameChatSameSecs 前导连续相同', () => {
  // 角色设定 + 记忆相同，已读不同 → 应为 [role, memory]
  assert(Array.isArray(row2.sameChatSameSecs), 'sameChatSameSecs 应为数组');
  assert(row2.sameChatSameSecs[0] === 'role', '首项应为 role，实际 ' + row2.sameChatSameSecs[0]);
  assert(row2.sameChatSameSecs.includes('memory'), '应含 memory');
  assert(!row2.sameChatSameSecs.includes('read'), '不应含 read（已读已变）');
  return row2.sameChatSameSecs.join(',');
});

check('指纹：同段同哈希、改字符即变', () => {
  recordCacheCall({ chatKey: 'group:1', sessionId: 's1', model: 'm', round: 2, usage: usage(1200, 1000), systemPrompt: 'SYS', userPrompt: usr2, anchorMode: 'anchored' });
  const rows = fs.readFileSync(file1, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = rows[1], b = rows[2];
  assert(a.secHashes.read === b.secHashes.read, '同样内容应同哈希');
  assert(a.secHashes.read !== row1.secHashes.read, '不同内容应不同哈希');
});

// ── 3. 缓存命中取值兼容 ────────────────────────────────────────────────────
check('cachedOf：三条返回路径', () => {
  assert(cachedOf({ prompt_tokens_details: { cached_tokens: 7 } }) === 7, 'details 路径');
  assert(cachedOf({ prompt_cache_hit_tokens: 8 }) === 8, 'hit 路径');
  assert(cachedOf({ cached_tokens: 9 }) === 9, 'cached 路径');
  assert(cachedOf({}) === 0, '空对象应为 0');
  assert(cachedOf(null) === 0, 'null 应为 0');
});

// ── 4. 旁路语义 ────────────────────────────────────────────────────────────
check('旁路：usage 为 null 不抛', () => {
  recordCacheCall({ chatKey: 'group:2', sessionId: 's2', model: 'm', round: 0, usage: null, systemPrompt: 'S', userPrompt: 'U' });
  return '未抛';
});

check('旁路：参数全空不抛', () => {
  recordCacheCall({});
  return '未抛';
});

check('旁路：目录被占用不抛', () => {
  // 把 metrics 目录替换成同名文件 → mkdir 失败应被吞
  const dir = cacheMetricsDir();
  const bak = dir + '.bak';
  fs.renameSync(dir, bak);
  fs.writeFileSync(dir, 'blocked', 'utf8');
  try {
    recordCacheCall({ chatKey: 'group:3', sessionId: 's3', model: 'm', round: 0, usage: usage(10, 0), systemPrompt: 'S', userPrompt: '【记忆】x' });
  } finally {
    fs.rmSync(dir, { force: true });
    fs.renameSync(bak, dir);
  }
  return '未抛';
});

// ── 5. 行数自证 ────────────────────────────────────────────────────────────
check('行数：group:1 落盘行数 = 调用次数', () => {
  const rows = fs.readFileSync(file1, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.chat === 'group:1');
  assert(rows.length === 3, 'group:1 应有 3 行，实际 ' + rows.length);
  return rows.length + ' 行';
});

// ── 清理 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

// ── 报告 ───────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
const report = results.map((r) => (r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '  —— ' + r.detail : ''))
  .concat(['', pass + '/' + results.length + (fail.length ? '  FAILED' : '  ALL PASS')])
  .join('\n');
process.stdout.write(report + '\n');
// 不用 process.exit —— Windows 上会截断未 flush 的 stdout（实测只剩首行）
process.exitCode = fail.length ? 1 : 0;
