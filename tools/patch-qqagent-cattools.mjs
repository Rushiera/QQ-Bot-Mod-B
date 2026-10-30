// ── 退役守卫（R2 · 2026-10-30）──────────────────────────────────────────────
// 本补丁已由 R2 Step 1 吸收进 app/src/business/，默认不再对 _unpack 打任何补丁。
// 默认：打印 RETIRED 并 exit 0（零副作用）；确需复现旧行为时加 --force。
if (!process.argv.includes('--force')) {
  console.log('RETIRED: 已被 R2 吸收，见 app/src/business/');
  process.exit(0);
}

// patch-qqagent-cattools.mjs — QQ Agent v0.4.0「猫工具链移植」幂等补丁
//
// 用法：node patch-qqagent-cattools.mjs [--dry]
// 做什么：把 CH4 猫工具链的四组工具装进 QQ Agent ——
//   timeback（上下文作用域）· image-inject（看图）· browser-*（网页浏览 BrowserCat 组 5 件）
//   · web-search 侧 qq-agent 原生已有（web_search / web_fetch），不重复实现。
// 语义：源码改动的唯一落盘通道——重装应用后按顺序重跑即复现。
// 幂等：每个补丁点带唯一标记 [qqagent-cattools-patch:<id>]；已含标记 = 跳过。
//       两个新模块（cdp-browser.js / cat-tools.js）按内容比对：一致 = 跳过，有差异 = 覆盖。
// 边界：不动安全边界（浏览锁定 / 内网拦截沿用 safe-fetch.js）/ 不动发送面 / 不改既有工具语义。
//
// 🔴 补丁链顺序（后落者改写了上游锚点所在文本，顺序不可颠倒）：
//   session → engage → nosys → memory → sessions-fold → botguard → hardlimit → talkstyle → **本补丁**
//   本补丁的锚点取自 orchestrator 的「工具执行循环」与「运行收尾」两处 —— 上游补丁未触及，
//   故排在链尾即可（上游复跑仍全部 skip）。
//
// 设计要点（Rushiera 2026-10-10 指令：「把我们猫里面的工具链里的 timeback，image-inject，
// web-search，还有整个 browsercat 里的所有工具链都配进去」）：
//   1 **域门禁同口径**：image-inject 与 browser-* 仅 timeback 作用域内可用（域外调用被拒，
//     错误回给模型，模型据此自行开锚）——图片与网页属非主干信息，开锚进来、back 回收。
//   2 **回卷在编排器侧**：back 时把锚点之后、本条之前的 messages 从上下文删除，findings 随
//     back 的 tool 结果回主干。只删 LLM 上下文，会话页（session.messages）保留完整过程记录。
//   3 **实例回收**：浏览器进程随 timeback back 关闭（域级回收），运行收尾再兜一次；另有空闲兜底。
//   4 **内核自动探测**：Chromium 系（Edge / Chrome / Brave）headless + 裸 CDP；配置 browser.kernelPath 可换。
//   5 **数据目录不跟应用走**：浏览器 profile / 产物默认落 %LOCALAPPDATA%/QQAgent/browser（NTFS）——
//     exFAT 卷上 Chromium 的 user-data-dir 起不来（2026-10-10 实测：D 盘 exFAT 导航超时 /
//     C 盘 NTFS 697ms 通过）；配置 browser.dataDir 可改，同样须 NTFS。
//
// 落点：
//   src/cdp-browser.js    CDP 浏览器服务（新模块 · 从 tools/cattools/ 复制）
//   src/cat-tools.js      工具注册（新模块 · 从 tools/cattools/ 复制）
//   src/tools.js          import + registerAllTools() 调用
//   src/orchestrator.js   import + 锚点捕获 + timeback 回卷 + 运行收尾回收
//   src/config.js         browser.kernelPath / browser.dataDir / tools.imageInject.roots 默认段

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const MODULE_SRC = path.join(HERE, 'cattools');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-cattools-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中（防"改错地方"）；已应用过则跳过。 */
function patch(id, root, rel, anchor, replacement, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(anchor, eol);
  const r = toEol(replacement, eol);
  const hits = text.split(a).length - 1;
  if (hits !== expect) throw new Error('[' + id + '] 锚点命中 ' + hits + ' 次（期望 ' + expect + '）：' + JSON.stringify(a.slice(0, 80)));
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => r), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
}

/**
 * 多形态定点替换：按顺序尝试候选锚点——覆盖「未打过旧补丁 / 已打过旧补丁」两种源码形态。
 * 用途：升级既有补丁点时，源码里可能是原始文本，也可能是旧补丁产物（含旧标记）。
 * 每个候选给 { anchor, replacement }；命中第一个即用。已含本次标记 = 跳过。
 */
function patchVariants(id, root, rel, variants, expect = 1) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  for (const v of variants) {
    const a = toEol(v.anchor, eol);
    const hits = text.split(a).length - 1;
    if (hits !== expect) continue;
    if (!DRY) fs.writeFileSync(file, text.replace(a, () => toEol(v.replacement, eol)), 'utf8');
    results.push({ id, file: rel, status: DRY ? 'dry' : 'applied' });
    return;
  }
  throw new Error('[' + id + '] 全部候选锚点均未命中（期望 ' + expect + ' 次）');
}

/** 复制新模块：内容一致 = 跳过；有差异 = 覆盖（模块正文以 tools/cattools/ 为准）。 */
function copyModule(id, name) {
  const from = path.join(MODULE_SRC, name);
  const to = path.join(SRC, name);
  const body = fs.readFileSync(from, 'utf8');
  let current = null;
  try { current = fs.readFileSync(to, 'utf8'); } catch { current = null; }
  if (current === body) { results.push({ id, file: 'src/' + name, status: 'skipped' }); return; }
  if (!DRY) fs.writeFileSync(to, body, 'utf8');
  results.push({ id, file: 'src/' + name, status: DRY ? 'dry' : (current === null ? 'applied' : 'updated') });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1-2：新模块（CDP 浏览器服务 + 工具注册）
// ─────────────────────────────────────────────────────────────────────────────
copyModule('module-cdp-browser', 'cdp-browser.js');
copyModule('module-cat-tools', 'cat-tools.js');
copyModule('module-web-fetch', 'web-fetch.js');

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：src/tools.js —— import 猫工具链
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-import', SRC, 'tools.js',
`import { registerTool, listTools } from './tool-registry.js';`,
`import { registerTool, listTools } from './tool-registry.js';
// 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-import]
import { registerCatTools } from './cat-tools.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：src/tools.js —— 注册入口挂载
// ─────────────────────────────────────────────────────────────────────────────
patch('tools-register', SRC, 'tools.js',
`/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 消息发送类`,
`/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();
  // 消息发送类`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：src/orchestrator.js —— import 浏览器服务（运行收尾回收用）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-import', SRC, 'orchestrator.js',
`import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';`,
`import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
// 猫工具链：浏览器实例回收 + timeback 回卷 —— [qqagent-cattools-patch:orchestrator-import]
import { browserService } from './cdp-browser.js';
import { timebackMarkStart, timebackRollback } from './cat-tools.js';`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：src/orchestrator.js —— 记本条 assistant 消息的下标（timeback 锚点）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-anchor', SRC, 'orchestrator.js',
`      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));`,
`      messages.push(assistantEntry);
      // 本条 assistant 消息在上下文里的下标 —— timeback start 记锚点用
      // [qqagent-cattools-patch:orchestrator-anchor]
      let assistantIndex = messages.length - 1;
      session.messages.push(structuredClone(assistantEntry));`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7（已退役）：src/orchestrator.js —— timeback 开锚 / 回卷（单件形态）
// 2026-10-11 退役：timeback 升级为两件（timeback-start / timeback-back）后，本点由
// 补丁 13（orchestrator-timeback2）取代——补丁 13 自带「全新拆包」形态候选，无需本点。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：src/orchestrator.js —— 运行收尾回收浏览器实例（兜底）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-close', SRC, 'orchestrator.js',
`    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessionAbortControllers.delete(session.id);`,
`    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    // 运行收尾：浏览器实例随运行结束回收 —— [qqagent-cattools-patch:orchestrator-close]
    // timeback back 是回收主路径，这里是兜底（模型忘了 back 也不留孤儿进程）。
    try { await browserService.closeChat(chatKey); } catch { /* 回收失败不阻断收尾 */ }
    this.sessionAbortControllers.delete(session.id);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：src/config.js —— browser 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-browser', SRC, 'config.js',
`  // Skill 统一开关：唯一的"能力启停"来源。`,
`  // ── 浏览器（browser-* 工具）—— [qqagent-cattools-patch:config-browser] ──
  // 内核：Chromium 系（Edge / Chrome / Brave）headless + 裸 CDP；留空 = 按常见安装路径自动探测。
  // 换内核只改这里（Chromium 系协议同为 CDP，无协议分支）。
  browser: {
    kernelPath: ''
  },
  // Skill 统一开关：唯一的"能力启停"来源。`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10：src/config.js —— tools.imageInject 默认段
// ─────────────────────────────────────────────────────────────────────────────
patch('config-imageinject', SRC, 'config.js',
`    crossChatSend: false,`,
`    crossChatSend: false,
    // 看图（image-inject）本地取图根 —— [qqagent-cattools-patch:config-imageinject]
    // 默认只允许数据目录与系统临时目录（写死的两条基线）；要放开别的目录就往 roots 里加绝对路径。
    imageInject: {
      roots: []
    },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 11：src/config.js —— browser.dataDir（浏览器数据目录，必须 NTFS）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-browser-datadir', SRC, 'config.js',
`  browser: {
    kernelPath: ''
  },`,
`  browser: {
    kernelPath: '',
    // 浏览器数据目录（profile / 截图 / 落盘正文）—— [qqagent-cattools-patch:config-browser-datadir]
    // 🔴 必须落 NTFS：exFAT 卷上 Chromium 的 user-data-dir 起不来（CDP 连接 20s+，导航全挂）。
    //    留空 = 默认 %LOCALAPPDATA%/QQAgent/browser。
    dataDir: ''
  },`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 12：src/orchestrator.js —— 猫工具链 import 升级（门禁 / 台账 / 下载器）
// ─────────────────────────────────────────────────────────────────────────────
patchVariants('orchestrator-import2', SRC, 'orchestrator.js', [
  {
    // 已打过旧补丁（补丁 5 产物）——升级 cat-tools 导入 + 追加 web-fetch
    anchor: `import { browserService } from './cdp-browser.js';
import { timebackMarkStart, timebackRollback } from './cat-tools.js';`,
    replacement: `import { browserService } from './cdp-browser.js';
import { timebackMarkStart, timebackRollback, timebackGateTool, timebackRecordTool } from './cat-tools.js';
import { webFetchService } from './web-fetch.js';   // [qqagent-cattools-patch:orchestrator-import2]`
  },
  {
    // 全新拆包（未打过补丁 5）——从原始 import 行整块插入
    anchor: `import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';`,
    replacement: `import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
// 猫工具链：浏览器实例回收 + timeback 回卷 / 门禁 / 台账 + 下载器 —— [qqagent-cattools-patch:orchestrator-import2]
import { browserService } from './cdp-browser.js';
import { timebackMarkStart, timebackRollback, timebackGateTool, timebackRecordTool } from './cat-tools.js';
import { webFetchService } from './web-fetch.js';`
  }
]);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 13：src/orchestrator.js —— timeback 两件化（timeback-start / timeback-back）
// ─────────────────────────────────────────────────────────────────────────────
patchVariants('orchestrator-timeback2', SRC, 'orchestrator.js', [
  {
    // 已打过旧补丁（单件 timeback）——整块替换为两件
    anchor: `        // ── timeback 上下文作用域 —— [qqagent-cattools-patch:orchestrator-timeback] ──
        // start：记锚点（本条 assistant 消息下标）；back：把锚点之后、本条 assistant 之前的
        // 全部消息从**上下文**里删除（域内膨胀过程回收），findings 随 back 的 tool 结果回到主干。
        // 只删 LLM 上下文，会话页（session.messages）保留完整过程记录。
        // 回卷逻辑在 cat-tools.js（与域状态同址，可被自测直接驱动）。
        if (name === 'timeback') {
          const tbArgs = safeParse(argsRaw) || {};
          if (tbArgs.action === 'start') {
            timebackMarkStart(ctx.session, assistantIndex);
          } else if (tbArgs.action === 'back') {
            assistantIndex = timebackRollback(messages, ctx.session, assistantIndex);
          }
        }`,
    replacement: `        // ── timeback 上下文作用域 —— [qqagent-cattools-patch:orchestrator-timeback2] ──
        // start：记锚点（本条 assistant 消息下标）；back：把锚点之后、本条 assistant 之前的
        // 全部消息从**上下文**里删除（域内膨胀过程回收），findings 随 back 的 tool 结果回到主干。
        // 只删 LLM 上下文，会话页（session.messages）保留完整过程记录。
        // 回卷逻辑在 cat-tools.js（与域状态同址，可被自测直接驱动）。
        if (name === 'timeback-start') {
          timebackMarkStart(ctx.session, assistantIndex);
        } else if (name === 'timeback-back') {
          assistantIndex = timebackRollback(messages, ctx.session, assistantIndex);
        }`
  },
  {
    // 全新拆包——直接在原始两行之后插入
    anchor: `        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;`,
    replacement: `        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        // ── timeback 上下文作用域 —— [qqagent-cattools-patch:orchestrator-timeback2] ──
        // start：记锚点；back：把锚点之后、本条 assistant 之前的全部消息从上下文删除
        // （findings 随 back 的 tool 结果回到主干）；回卷逻辑在 cat-tools.js。
        if (name === 'timeback-start') {
          timebackMarkStart(ctx.session, assistantIndex);
        } else if (name === 'timeback-back') {
          assistantIndex = timebackRollback(messages, ctx.session, assistantIndex);
        }
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;`
  }
]);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 14：src/orchestrator.js —— 域白名单门禁 + 域内工具台账
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-gate', SRC, 'orchestrator.js',
`        const result = blocked
          ? { content: \`错误：\${blocked.reason || '该工具调用被 Skill 拒绝'}\`, isError: true }
          : await executeTool(toolDefs, ctx, name, argsRaw);`,
`        // timeback 域白名单门禁（fail-closed：域开着时名单外一律拒）—— [qqagent-cattools-patch:orchestrator-gate]
        const tbDeny = timebackGateTool(ctx.session, name);
        const result = blocked
          ? { content: \`错误：\${blocked.reason || '该工具调用被 Skill 拒绝'}\`, isError: true }
          : (tbDeny
            ? { content: \`错误：\${tbDeny}\`, isError: true }
            : await executeTool(toolDefs, ctx, name, argsRaw));
        // 域内工具台账（工具名 · 目标 · 成败）—— [qqagent-cattools-patch:orchestrator-gate]
        timebackRecordTool(ctx.session, name, argsRaw, result);`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 15：src/orchestrator.js —— 下载器完成注入接线（web-fetch）
// ─────────────────────────────────────────────────────────────────────────────
patch('orchestrator-webfetch', SRC, 'orchestrator.js',
`    this.browseNextAt = new Map();   // chatKey -> 下一拍时间戳
  }`,
`    this.browseNextAt = new Map();   // chatKey -> 下一拍时间戳
    // ── 下载器完成注入（web-fetch）—— [qqagent-cattools-patch:orchestrator-webfetch] ──
    // 下载在后台进行：完成 / 失败时把提示作为一条系统消息投回来源会话（未读），并排一次唤醒——
    // 模型下一轮就能看到「下载好了 / 失败了」。
    webFetchService.configure({
      onDone: (chatKey, text) => {
        try { this.store.appendIncoming(chatKey, { senderName: '系统', text }); } catch { /* 落盘失败不阻断 */ }
        try { this.scheduleWake(chatKey, 0); } catch { /* 排程失败不阻断 */ }
      }
    });
  }`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 16：src/config.js —— webFetch 默认段（下载产物落点）
// ─────────────────────────────────────────────────────────────────────────────
patch('config-webfetch', SRC, 'config.js',
`  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）`,
`  // 网页资产下载（web-fetch / web-fetch-jobs）—— [qqagent-cattools-patch:config-webfetch]
  // downloadsDir：产物落点（绝对路径；留空 = 自动探测受控根 Downloads，再回落用户下载目录）。
  // allowPrivateHosts：内网地址例外（仅本地测试 / 自建服务）—— [qqagent-cattools-patch:config-webfetch-priv]
  webFetch: {
    downloadsDir: '',
    allowPrivateHosts: false
  },
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 17：src/config.js —— webFetch.allowPrivateHosts（内网例外开关）
// 形态兼容：config-webfetch 已应用（旧版无本开关）时补上；全新拆包时上一补丁已含（本点跳过）。
// ─────────────────────────────────────────────────────────────────────────────
patchVariants('config-webfetch-priv', SRC, 'config.js', [
  {
    anchor: `  webFetch: {
    downloadsDir: ''
  },`,
    replacement: `  webFetch: {
    downloadsDir: '',
    // allowPrivateHosts：内网地址例外（仅本地测试 / 自建服务）—— [qqagent-cattools-patch:config-webfetch-priv]
    allowPrivateHosts: false
  },`
  }
]);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied' || r.status === 'updated').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
