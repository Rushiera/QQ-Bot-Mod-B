// shadow-diff.mjs —— 影子对比（归位后业务面 vs 旧业务面，逐条比发言决策）
//
// 方案来源：reports/R2-L4.md §三（采集点 S1–S7 / 层 1 层 2 口径 / 零差异三判据 / 7 天统计）
//
// 用法：
//   node tools/shadow-diff.mjs --self-test           # 构造用例自测，输出 SELFTEST PASS n/n
//   node tools/shadow-diff.mjs                       # 层 1 · 回放数据根里的历史自发言（默认 ≤50 条）
//   node tools/shadow-diff.mjs --candidates a.jsonl  # 层 1 · 显式候选文件（一行一条）
//   node tools/shadow-diff.mjs --limit 200           # 回放条数上限
//   node tools/shadow-diff.mjs --force               # 忽略开关（人工复盘用）
//   node tools/shadow-diff.mjs --layer2              # 层 2 · 显式声明未实现（不静默缺）
//
// 层 1（闸门影子，本文件已实现）：
//   同一条候选文本喂两套 SendQueue，比**裁决**——actual 侧 = 业务面（app/src/business/sender.js），
//   shadow 侧 = 旧业务面对照源（_unpack/resources/app/src/sender.js，只读、D4 不动）。
//   不比 LLM、不真发消息、不落生产数据根。
//
// 层 2（端到端影子，本轮不实现）：
//   同一份 WS 事件流 fan-out 两份，比**发言序列**。见 runLayer2() 的显式 TODO。
//
// 三条隔离硬要求（R2-L4:127，层 1 已全部落实）：
//   ① 数据根 mkdtemp —— 两侧 config.js 都靠 QQ_AGENT_DATA_DIR 求值，指向临时目录，不碰 _unpack/data；
//   ② onebot 换 mock —— 两侧各一个独立 mock，sendText 只记录不发送；
//   ③ setPaused(true) —— 层 1 不订阅事件源（无编排器可暂停），该条落在层 2 骨架里显式声明。
//
// 开关：生产配置 engage.shadowDiff.enabled 为 true 才跑；**读不到即关**（失败收紧不放开）。
//       --self-test / --force 不受开关约束（自测与人工复盘不得被配置面阻断）。
// 产物：runtime/.shadow/<YYYY-MM-DD>.json —— 字段照 R2-L4:163-170。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PROD_DATA = path.join(REPO, '_unpack', 'data');
const OUT_DIR = path.join(REPO, 'runtime', '.shadow');
const BUSINESS_SRC = path.join(REPO, 'app', 'src', 'business');
const LEGACY_SRC = path.join(REPO, '_unpack', 'resources', 'app', 'src');
const SELF_URL = pathToFileURL(fileURLToPath(import.meta.url)).href;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (flag, dflt = null) => {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return !v || v.startsWith('--') ? dflt : v;
};

const SELF_TEST = has('--self-test');
const LAYER2 = has('--layer2');
const FORCE = has('--force');
const LIMIT = Number(argOf('--limit', '50')) || 50;
const CAND_FILE = argOf('--candidates', null);

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 文本归一（层 1 附带比对；口径与 R2-L4:147 同向，mdToPlain 已在发送管道内跑过）。 */
function normText(input) {
  let s = String(input ?? '').trim();
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角 → 半角
  s = s.replace(/\u3000/g, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/[*_`~>#]/g, '');
  return s;
}

/**
 * 裁决归类（deny 细分类别，R2-L4:137）。
 * 依据 sender.js 里各闸门的错误串首词——文案互不重叠，故按关键字判定即可。
 * @param {string} message 发送抛出的错误串
 * @returns {string} 类别
 */
function classify(message) {
  const m = String(message ?? '');
  if (m.includes('已被指定为机器人')) return 'botguard';
  if (m.includes('回应参数已降到')) return 'rapport';
  if (m.includes('发言硬限制')) return 'hardLimit';
  if (m.includes('发言配额已满')) return 'quota';
  if (m.includes('每分钟最多')) return 'minute';
  if (m.includes('每小时最多')) return 'hour';
  if (m.includes('消息内容为空')) return 'empty';
  if (m.includes('非法会话 key')) return 'illegal';
  if (m.includes('消息列表为空')) return 'illegal';
  return 'other:' + m.slice(0, 40);
}

/** onebot mock（隔离要求 ②）——只记录，不真发。 */
function mockOnebot(tag) {
  const state = { sent: [] };
  const mock = {
    tag,
    state,
    async sendText(kind, id, text) {
      state.sent.push({ kind, id, text: String(text) });
      return { message_id: `${tag}-${state.sent.length}` };
    },
    async sendSticker(kind, id, ref) {
      state.sent.push({ kind, id, text: '[sticker]' });
      return { message_id: `${tag}-${state.sent.length}` };
    },
    async sendPoke() {
      state.sent.push({ kind: 'poke', id: '', text: '[poke]' });
      return { message_id: null };
    },
    async call() {
      return {};
    }
  };
  return mock;
}

/** store mock —— 层 1 只判裁决，不需要存档（也避免两侧写同一文件互相覆盖）。 */
function mockStore() {
  return { appendSelf() {}, recent() { return []; } };
}

/** 隔离数据根（隔离要求 ①）——临时目录，跑完由调用方决定是否清理。 */
function makeIsoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbotb-shadow-'));
}

/**
 * 装配一侧：import 该侧的 sender/config/rapport，并挂上 mock。
 * @param {string} baseDir 该侧 src 目录
 * @param {string} tag 'actual' | 'shadow'
 * @returns {Promise<object>} 侧对象
 */
async function loadSide(baseDir, tag) {
  const mod = (rel) => pathToFileURL(path.join(baseDir, rel)).href;
  const config = await import(mod('config.js'));
  const { SendQueue } = await import(mod('sender.js'));
  const rapport = await import(mod('rapport.js'));
  const mock = mockOnebot(tag);
  const queue = new SendQueue({ onebot: mock, store: mockStore(), onSent: null, log: null });
  return { tag, baseDir, config, rapport, mock, queue };
}

/** 配置注入（两侧同口径；自测用，不动磁盘）。 */
function applyCfg(side, over = {}) {
  const base = side.config.getConfig();
  side.config.setRuntimeConfig({
    ...base,
    send: {
      ...(base.send || {}),
      minGapMs: 1,
      maxGapMs: 2,
      byLengthMs: 0,
      hardSplitAt: 0,
      maxPerMinute: 80,
      maxPerHour: 1000,
      dedupeWindowMs: 0,
      ...(over.send || {})
    },
    engage: {
      ...(base.engage || {}),
      quota: { enabled: false, windowMs: 120000, maxPerWindow: 5, ...((over.engage || {}).quota || {}) },
      hardLimit: { enabled: false, windowMs: 60000, maxPerWindow: 1, ...((over.engage || {}).hardLimit || {}) },
      botGuard: { enabled: false, windowMs: 240000, maxPerWindow: 1, members: [], ...((over.engage || {}).botGuard || {}) },
      rapport: {
        enabled: true,
        maxCooldownMs: 1200000,
        healPerTick: 2,
        healIntervalMs: 300000,
        ...((over.engage || {}).rapport || {})
      }
    }
  });
}

/** 清空该侧记账窗口（用例之间隔离；只在自测里用）。 */
function resetWindows(side, chatKey) {
  side.queue.hardTimes.delete(chatKey);
  side.queue.quotaTimes.delete(chatKey);
  side.queue.minuteTimes.delete(chatKey);
  side.queue.hourTimes.delete(chatKey);
  side.queue.recentSent.clear();
  side.queue.lastSentAt.delete(chatKey);
  side.queue.botReplyTimes.clear();
  side.queue.rapportReplyTimes.clear();
  side.queue.botRuns.delete(chatKey);
  side.queue.rapportRuns.delete(chatKey);
}

/**
 * 喂一条候选，取该侧裁决。
 * @param {object} side 侧对象
 * @param {{chatKey:string, text:string, atUserId:(string|null)}} cand 候选
 * @returns {Promise<{verdict:string, sentCount:number, texts:string[], detail:string}>} 裁决
 */
async function feed(side, cand) {
  const before = side.mock.state.sent.length;
  let verdict = 'allow';
  let detail = '';
  try {
    const r = await side.queue.sendTextBatch(cand.chatKey, [cand.text], { atUserId: cand.atUserId ?? null });
    const all = Array.isArray(r?.sent) ? r.sent : [];
    if (all.length && all.every((x) => x && x.deduped)) verdict = 'dedupe';
    if (Array.isArray(r?.failed) && r.failed.length) detail = String(r.failed[0]?.error ?? '');
  } catch (e) {
    verdict = classify(e?.message ?? e);
    detail = String(e?.message ?? e);
  }
  const sent = side.mock.state.sent.slice(before).map((x) => normText(x.text));
  return { verdict, sentCount: sent.length, texts: sent, detail };
}

/** 比一对裁决，返回 diff 记录（无差异返回 null）。 */
function compareOne(cand, a, s) {
  const sameVerdict = a.verdict === s.verdict;
  const sameCount = a.sentCount === s.sentCount;
  const sameText = JSON.stringify(a.texts) === JSON.stringify(s.texts);
  if (sameVerdict && sameCount && sameText) return null;
  const kind = !sameVerdict ? 'verdictDiff' : (a.sentCount !== s.sentCount ? 'textDiff' : 'textDiff');
  return {
    chatKey: cand.chatKey,
    kind,
    candidate: String(cand.text).slice(0, 80),
    actual: { verdict: a.verdict, sentCount: a.sentCount, detail: a.detail.slice(0, 120) },
    shadow: { verdict: s.verdict, sentCount: s.sentCount, detail: s.detail.slice(0, 120) }
  };
}

/** 汇总成 R2-L4:163-170 的日表字段。 */
function summarize(rows, extra) {
  const out = {
    candidates: rows.length,
    actual: rows.filter((r) => r.a.verdict === 'allow' || r.a.verdict === 'dedupe').length,
    shadow: rows.filter((r) => r.s.verdict === 'allow' || r.s.verdict === 'dedupe').length,
    matched: rows.filter((r) => !r.diff).length,
    onlyActual: 0,
    onlyShadow: 0,
    verdictDiff: 0,
    textDiff: 0,
    verdictDiffByKind: {},
    zeroDiff: false,
    ...extra
  };
  for (const r of rows) {
    if (!r.diff) continue;
    const allowA = r.a.verdict === 'allow' || r.a.verdict === 'dedupe';
    const allowS = r.s.verdict === 'allow' || r.s.verdict === 'dedupe';
    if (allowA && !allowS) out.onlyActual += 1;
    else if (!allowA && allowS) out.onlyShadow += 1;
    if (r.diff.kind === 'verdictDiff') {
      out.verdictDiff += 1;
      const key = `${r.a.verdict}->${r.s.verdict}`;
      out.verdictDiffByKind[key] = (out.verdictDiffByKind[key] || 0) + 1;
    } else {
      out.textDiff += 1;
    }
  }
  // 单日零差异判据（R2-L4:173）——四条归零且 matched = candidates
  out.zeroDiff = out.onlyActual === 0 && out.onlyShadow === 0
    && out.verdictDiff === 0 && out.textDiff === 0 && out.matched === out.candidates;
  return out;
}

// ── 层 2 骨架（显式 TODO，不静默缺）─────────────────────────────────────────

/**
 * 层 2 · 端到端影子 —— 同一份 WS 事件流 fan-out 两份，比**发言序列**。
 *
 * TODO: 需 WS fan-out 才可跑（本轮只保留骨架，显式声明，不静默缺）。
 * 前置三件（落地时按此接线，缺一不可）：
 *   ① 事件源 fan-out：单条 WS 在单体侧，业务面经 eventSource.subscribe 收事件
 *      （app/src/business/app.js:651）——层 2 需要在同一订阅点再挂一个影子消费端；
 *   ② 影子实例 setPaused(true)：不暂停会进编排器、烧模型（隔离要求 ③）；
 *   ③ 数据根 mkdtemp + onebot mock：同层 1。
 * 比对键：chatKey / ordinal / norm(text) / tsBucket（15s 桶）；mid 不参与（影子无 mid）。
 *
 * @returns {Promise<never>} 恒抛「未实现」——调用方据此知道层 2 没跑，而非空转成功
 */
async function runLayer2() {
  // TODO: 需 WS fan-out 才可跑
  //   const shadowApp = await createApp({ ...iso, pausedByDefault: true });
  //   shadowApp.orchestrator.setPaused(true);   ← 隔离要求 ③：不进编排器、不烧模型
  throw new Error('层 2 未实现：需 WS fan-out 才可跑（见 runLayer2 上方 TODO 与 R2-L4 §三 层 2 表）');
}

// ── 层 1 自测（构造用例）─────────────────────────────────────────────────────

/**
 * 自测：构造用例逐条跑两侧，断言「两侧裁决相等 + 都等于期望」。
 * 只断言"两侧相等"不够——两侧一起错也会相等，所以每条用例带期望裁决。
 * @returns {Promise<number>} 退出码（0 = 全过）
 */
async function selfTest() {
  const iso = makeIsoRoot();
  process.env.QQ_AGENT_DATA_DIR = iso;
  fs.mkdirSync(iso, { recursive: true });
  fs.writeFileSync(path.join(iso, 'config.json'), JSON.stringify({}, null, 2), 'utf8');

  const A = await loadSide(BUSINESS_SRC, 'actual');
  const S = await loadSide(LEGACY_SRC, 'shadow');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail: String(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  };

  // 隔离三件（① 数据根临时目录 ② onebot mock ③ 层 2 骨架含 setPaused）
  check('隔离①：数据根走 mkdtemp', iso.startsWith(os.tmpdir()) && A.config.DATA_DIR === iso,
    `DATA_DIR=${A.config.DATA_DIR}`);
  check('隔离②：onebot 换 mock（不真发）',
    A.mock.tag === 'actual' && S.mock.tag === 'shadow' && typeof A.mock.sendText === 'function',
    `actual=${A.mock.tag} shadow=${S.mock.tag}`);
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  check('隔离③：层 2 骨架显式声明 setPaused(true)', selfSrc.includes('setPaused(true)'),
    'runLayer2 内保留调用点（层 2 落地时打开）');
  check('层 2 显式 TODO（不静默缺）', selfSrc.includes('TODO: 需 WS fan-out 才可跑'));

  const run = async (cases) => {
    for (const c of cases) {
      if (c.setup) c.setup(A, S);
      // 记账默认**不清**——「窗口内第 2 条被拒」这类用例必须让第 1 条的记账留着，
      // 每条都清会退化成「永远 allow」（自测假绿）。组间靠不同 chatKey 天然隔离；
      // 确需同 key 重开窗口的用例显式写 reset: true。
      if (c.reset === true) { resetWindows(A, c.chatKey); resetWindows(S, c.chatKey); }
      const a = await feed(A, c);
      const s = await feed(S, c);
      const same = a.verdict === s.verdict && a.sentCount === s.sentCount
        && JSON.stringify(a.texts) === JSON.stringify(s.texts);
      check(`${c.name} → ${c.expect}`,
        same && a.verdict === c.expect && s.verdict === c.expect,
        `actual=${a.verdict}/${a.sentCount} shadow=${s.verdict}/${s.sentCount}`);
    }
  };

  const K1 = 'group:1001';
  const K2 = 'group:1002';
  const K3 = 'group:1003';
  const K4 = 'group:1004';
  const K5 = 'group:1005';
  const K6 = 'group:1006';

  // 基线 + 硬限（同一 chatKey，窗口内第 2 条被拒）
  await run([
    { name: '基线放行', chatKey: K1, text: '你好', expect: 'allow', setup: (a, s) => { applyCfg(a); applyCfg(s); } },
    { name: '硬限开启后第 1 条', chatKey: K1, text: '第一条', expect: 'allow',
      setup: (a, s) => { applyCfg(a, { engage: { hardLimit: { enabled: true, windowMs: 60000, maxPerWindow: 1 } } }); applyCfg(s, { engage: { hardLimit: { enabled: true, windowMs: 60000, maxPerWindow: 1 } } }); } },
    { name: '硬限窗口内第 2 条', chatKey: K1, text: '第二条', expect: 'hardLimit' }
  ]);

  // 配额
  await run([
    { name: '配额第 1 条', chatKey: K2, text: '第一条', expect: 'allow',
      setup: (a, s) => { applyCfg(a, { engage: { quota: { enabled: true, windowMs: 120000, maxPerWindow: 1 } } }); applyCfg(s, { engage: { quota: { enabled: true, windowMs: 120000, maxPerWindow: 1 } } }); } },
    { name: '配额已满', chatKey: K2, text: '第二条', expect: 'quota' }
  ]);

  // 分钟限频
  await run([
    { name: '分钟限频第 1 条', chatKey: K3, text: '第一条', expect: 'allow',
      setup: (a, s) => { applyCfg(a, { send: { maxPerMinute: 1 } }); applyCfg(s, { send: { maxPerMinute: 1 } }); } },
    { name: '分钟限频第 2 条', chatKey: K3, text: '第二条', expect: 'minute' }
  ]);

  // 参数边界
  await run([
    { name: '空文本', chatKey: K4, text: '   ', expect: 'empty', setup: (a, s) => { applyCfg(a); applyCfg(s); } },
    { name: '非法 chatKey', chatKey: 'bad:1', text: 'x', expect: 'illegal' }
  ]);

  // 去重窗口（同文本第二次被判重复，不真发）
  await run([
    { name: '去重第 1 条', chatKey: K5, text: '同一句话', expect: 'allow',
      setup: (a, s) => { applyCfg(a, { send: { dedupeWindowMs: 8000 } }); applyCfg(s, { send: { dedupeWindowMs: 8000 } }); } },
    { name: '去重第 2 条（同文本）', chatKey: K5, text: '同一句话', expect: 'dedupe' }
  ]);

  // 回应参数（分数降到 0 → 对同一群友 60 秒冷却）
  await run([
    { name: '回应参数：先放行一次', chatKey: K6, text: '第一次回你', atUserId: '10001', expect: 'allow',
      setup: (a, s) => {
        applyCfg(a, { engage: { rapport: { enabled: true, maxCooldownMs: 60000 } } });
        applyCfg(s, { engage: { rapport: { enabled: true, maxCooldownMs: 60000 } } });
        a.rapport.setRapport(K6, '10001', 0);
        s.rapport.setRapport(K6, '10001', 0);
      } },
    { name: '回应参数：冷却内第 2 条', chatKey: K6, text: '第二次回你', atUserId: '10001', expect: 'rapport',
      // 清「轮内已放行」标记 = 模拟下一轮（真实场景每轮新建 run）；retain 是记账，必须留着
      setup: (a, s) => { a.queue.rapportRuns.delete(K6); s.queue.rapportRuns.delete(K6); } }
  ]);

  // 清理：自测数据根（临时目录）跑完即删，不留中介物
  try { fs.rmSync(iso, { recursive: true, force: true }); } catch { /* 占用即留待系统清理 */ }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`SELFTEST FAILED ${failed.length}/${results.length}`);
    return 1;
  }
  console.log(`SELFTEST PASS ${results.length}/${results.length}`);
  return 0;
}

// ── 层 1 实跑（回放候选）───────────────────────────────────────────────────

/** 读开关：读不到即关（失败收紧不放开）。 */
function readSwitch() {
  const file = path.join(PROD_DATA, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = raw?.engage?.shadowDiff?.enabled;
    return { enabled: v === true, detail: `engage.shadowDiff.enabled = ${JSON.stringify(v ?? null)}（${file}）` };
  } catch (e) {
    return { enabled: false, detail: `配置读取失败（${String(e?.message ?? e)}）→ 按关闭处理` };
  }
}

/** 从数据根回放历史自发言作为候选（层 1 离线近似 S1；实时截获要挂 fan-out，属层 2 面）。 */
function loadCandidatesFromData(limit) {
  const dir = path.join(PROD_DATA, 'messages');
  if (!fs.existsSync(dir)) return { items: [], note: `数据根无 messages/：${dir}` };
  const files = fs.readdirSync(dir)
    .filter((f) => /^(group|private)_\d+\.json$/.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { mtime = 0; }
      return { f, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 12);
  const rows = [];
  for (const { f, full } of files) {
    const m = /^(group|private)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const chatKey = `${m[1]}:${m[2]}`;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
      for (const item of msgs) {
        if (item?.self !== true) continue;
        const text = String(item.text ?? '').trim();
        if (!text) continue;
        rows.push({ chatKey, text, atUserId: null, ts: Number(item.ts) || 0 });
      }
    } catch { /* 单个会话文件坏掉不影响其余 */ }
  }
  rows.sort((a, b) => a.ts - b.ts);
  const items = rows.slice(-limit).map(({ chatKey, text, atUserId }) => ({ chatKey, text, atUserId }));
  return { items, note: `回放 ${items.length} 条历史自发言（最近 ${files.length} 个会话文件，按 ts 取尾 ${limit}）` };
}

/** 读显式候选文件（JSONL：{chatKey,text,atUserId?}）。 */
function loadCandidatesFromFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const row = JSON.parse(s);
    if (!row?.chatKey || row?.text === undefined) throw new Error('候选行缺 chatKey/text：' + s.slice(0, 80));
    items.push({ chatKey: String(row.chatKey), text: String(row.text), atUserId: row.atUserId ?? null });
  }
  return { items, note: `显式候选文件 ${path.relative(REPO, file)}（${items.length} 条）` };
}

/** 层 1 主流程：两侧逐条喂，落日表。 */
async function runLayer1(cands, meta) {
  const iso = makeIsoRoot();
  process.env.QQ_AGENT_DATA_DIR = iso;
  fs.mkdirSync(iso, { recursive: true });
  // 生产配置副本进隔离根：两侧读到同一份真实闸门参数（不落回默认值，避免"测了个假配置"）
  const srcCfg = path.join(PROD_DATA, 'config.json');
  if (fs.existsSync(srcCfg)) fs.copyFileSync(srcCfg, path.join(iso, 'config.json'));
  else fs.writeFileSync(path.join(iso, 'config.json'), '{}', 'utf8');

  const A = await loadSide(BUSINESS_SRC, 'actual');
  const S = await loadSide(LEGACY_SRC, 'shadow');
  applyCfg(A); applyCfg(S);

  const rows = [];
  const diffs = [];
  for (const cand of cands) {
    const a = await feed(A, cand);
    const s = await feed(S, cand);
    const diff = compareOne(cand, a, s);
    rows.push({ a, s, diff });
    if (diff) diffs.push(diff);
  }

  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    date: day,
    generatedAt: new Date().toISOString(),
    mode: 'layer1',
    switch: meta.switch,
    candidatesSource: meta.source,
    isolation: {
      dataRoot: iso,
      onebot: 'mock（两侧各一，sendText 只记录）',
      setPaused: 'n/a（层 1 不订阅事件源；层 2 落地时必须 setPaused(true)）'
    },
    ...summarize(rows, { layer2: 'TODO: 需 WS fan-out 才可跑（见 runLayer2）' }),
    diffs
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${day}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  try { fs.rmSync(iso, { recursive: true, force: true }); } catch { /* 占用即留待系统清理 */ }

  console.log('=== 影子对比 · 层 1（闸门影子）===');
  console.log(`  候选 ${payload.candidates} / actual 放行 ${payload.actual} / shadow 放行 ${payload.shadow} / matched ${payload.matched}`);
  console.log(`  onlyActual ${payload.onlyActual} · onlyShadow ${payload.onlyShadow} · verdictDiff ${payload.verdictDiff} · textDiff ${payload.textDiff}`);
  console.log(`  单日零差异 ${payload.zeroDiff ? 'YES' : 'NO'}（判据：四条归零且 matched = candidates）`);
  if (diffs.length) {
    console.log(`  diff 明细（${diffs.length} 条，前 5）：`);
    for (const d of diffs.slice(0, 5)) console.log(`    ${d.kind} · ${d.chatKey} · 「${d.candidate}」 actual=${d.actual.verdict} shadow=${d.shadow.verdict}`);
  }
  console.log(`  产物 ${path.relative(REPO, outFile)}`);
  return payload.zeroDiff ? 0 : 1;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

(async () => {
  if (LAYER2) {
    try {
      await runLayer2();
    } catch (e) {
      console.log(`LAYER2 BLOCKED :: ${e?.message ?? e}`);
      process.exit(2);
    }
  }
  if (SELF_TEST) process.exit(await selfTest());

  const sw = readSwitch();
  if (!sw.enabled && !FORCE) {
    console.log(`SHADOW OFF :: ${sw.detail}`);
    console.log('  开关读不到即关（失败收紧不放开）。人工复盘用 --force，验证脚本本体用 --self-test。');
    process.exit(0);
  }

  let loaded;
  try {
    loaded = CAND_FILE ? loadCandidatesFromFile(path.resolve(REPO, CAND_FILE)) : loadCandidatesFromData(LIMIT);
  } catch (e) {
    console.error(`候选加载失败：${String(e?.message ?? e)}`);
    process.exit(1);
  }
  if (!loaded.items.length) {
    console.log(`NO CANDIDATES :: ${loaded.note}`);
    console.log('  无候选 = 本日不计入 7 天统计（R2-L4:174「无发言的日子不计入」）。');
    process.exit(0);
  }
  process.exit(await runLayer1(loaded.items, { switch: sw, source: loaded.note }));
})().catch((e) => {
  console.error(`[shadow-diff] 未捕获错误：${String(e?.stack ?? e)}`);
  process.exit(1);
});
