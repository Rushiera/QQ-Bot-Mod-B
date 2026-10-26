// patch-qqbotb-cachemetrics.mjs — 「缓存观测采集面」幂等补丁（2026-10-26）
//
// 用法：
//   node tools/patch-qqbotb-cachemetrics.mjs             幂等打补丁（已打过的点 skipped）
//   node tools/patch-qqbotb-cachemetrics.mjs --dry       只报不写
//   node tools/patch-qqbotb-cachemetrics.mjs --app=<app> 指定 app 根（默认 _unpack/resources/app）
//
// 做什么（Rushiera 2026-10-26 定：「先开数据收集通道，然后第三件的数据可以跑几天直接取」）：
//   1 新增 src/cache-metrics.js（从 tools/templates/cache-metrics.js 复制——模板即源码）
//   2 src/config.js   cacheMetrics 默认段（开关 + 保留天数）
//   3 src/orchestrator.js  每次 LLM 调用后落一行观测（8 处 import + 1 处调用）
//
// 为什么是补丁：`_unpack/` 不入 git，运行副本改动的唯一重放通道就是本脚本。
// 幂等：每个补丁点带唯一标记 [qqbotb-cachemetrics:<id>]；文件已含标记 = skipped。
// 边界：只读不改行为——采集失败一律静默（try/catch 全包），不阻断发言。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'templates', 'cache-metrics.js');
const DRY = process.argv.includes('--dry');
const appArg = process.argv.find((a) => a.startsWith('--app='));
const APP = appArg ? path.resolve(appArg.slice('--app='.length)) : path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');

const results = [];
const mark = (id) => '[qqbotb-cachemetrics:' + id + ']';

function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点唯一命中；已应用则跳过。 */
function patch(id, rel, anchor, replacement, expect = 1, appliedIf = null) {
  const file = path.join(SRC, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const appliedMark = appliedIf ? toEol(appliedIf, eol) : mark(id);
  if (text.includes(appliedMark)) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 90)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/** 新增文件：模板即源码（不内嵌拼字符串，便于逐字校验）。 */
function addFile(id, rel, templatePath) {
  const file = path.join(SRC, rel);
  const body = fs.readFileSync(templatePath, 'utf8');
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (!DRY && cur === toEol(body, detectEol(file))) { results.push({ id, file: rel, status: 'skipped' }); return; }
    if (!DRY && !cur.includes(mark(id))) {
      throw new Error('[' + id + '] 目标已存在且不是本补丁产物：' + rel + '（先人工确认）');
    }
  }
  if (!DRY) fs.writeFileSync(file, toEol(body, detectEol(path.join(SRC, 'config.js'))), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

// ── 1. 新增 src/cache-metrics.js ───────────────────────────────────────────
addFile('module', 'cache-metrics.js', TEMPLATE);

// ── 2. config.js：cacheMetrics 默认段 ─────────────────────────────────────
patch('config', 'config.js',
`  // ── 卡死看门狗（2026-10-10）── [qqagent-engage-patch:config-stall]`,
`  // ── 缓存观测采集（2026-10-26）── ${''}[qqbotb-cachemetrics:config]
  // 每次 LLM 调用落一行到 data/metrics/cache-<YYYY-MM-DD>.jsonl：
  //   共享前缀指纹 + 距上次发送同样前缀多少秒（TTL 自然实验的主判据）、
  //   逐段指纹（定位分叉点）、命中 token / prompt token。
  // 纯旁路：写失败静默，绝不影响运行。enabled=false 立即停采。
  cacheMetrics: {
    enabled: true,
    keepDays: 30
  },
  // ── 卡死看门狗（2026-10-10）── [qqagent-engage-patch:config-stall]`);

// ── 3. orchestrator.js：import + 每次调用后落一行 ─────────────────────────
patch('import', 'orchestrator.js',
`// 发言热度（话密的群友 / 人机对刷）——提示词参考（[qqagent-engage-patch:orchestrator-chatter-import]）
import { formatChatterHint } from './chatter.js';`,
`// 发言热度（话密的群友 / 人机对刷）——提示词参考（[qqagent-engage-patch:orchestrator-chatter-import]）
import { formatChatterHint } from './chatter.js';
// 缓存观测采集（每次调用落一行）——[qqbotb-cachemetrics:import]
import { recordCacheCall } from './cache-metrics.js';`);

patch('call', 'orchestrator.js',
`      addUsage(session.usage, response.usage);
      session.usage.calls += 1;`,
`      addUsage(session.usage, response.usage);
      // 缓存观测（[qqbotb-cachemetrics:call]）—— 纯旁路，recordCacheCall 内部全 try/catch，
      // 采集失败不影响运行。传入的 userPrompt 是构建产物（不含运行时追加的配额/热度尾巴），
      // 逐段指纹必须基于它——尾巴每轮都变，算进去会让【未读信息】之后永远"分叉"。
      try {
        const sentUser = String(messages[messages.length - 1]?.content ?? '');
        recordCacheCall({
          chatKey,
          sessionId: session.id,
          model: response.model || session.model,
          round,
          usage: response.usage,
          systemPrompt,
          userPrompt,
          sentUsrChars: sentUser.length,
          anchorMode: session.promptAnchorMode || '',
          gapSinceSessionStartMs: round > 0 ? Date.now() - (session.lastCacheCallAt || Date.now()) : null
        });
        session.lastCacheCallAt = Date.now();
      } catch { /* 采集失败不影响运行 */ }
      session.usage.calls += 1;`);

// ── 输出 ─────────────────────────────────────────────────────────────────
const applied = results.filter((r) => r.status === 'applied');
const skipped = results.filter((r) => r.status === 'skipped');
const dry = results.filter((r) => r.status === 'dry');
console.log('applied ' + applied.length + ' · skipped ' + skipped.length + ' · dry ' + dry.length + (DRY ? '（DRY RUN，未写盘）' : ''));
for (const r of results) console.log('  ' + r.status.padEnd(8) + r.id.padEnd(10) + r.file);
