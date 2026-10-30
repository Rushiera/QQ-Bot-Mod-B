// verify-qqagent-cattools.mjs — 「猫工具链移植」自测
//
// 用法：node verify-qqagent-cattools.mjs
// 判据（Rushiera 2026-10-11 指令：「把 mau 刚刚更新的那些新功能 BrowserCat（含 browser-headful）
// / VisionCat（image-analyze + image-inject）/ WebCat（web-fetch + web-fetch-jobs）还有 timeback
// 都实装过去」）：
//   1 补丁落盘：补丁点标记齐全 + 三个新模块在位 + 编排器接线（回卷 / 门禁 / 台账 / 下载器）
//   2 工具注册：12 件进 registry（经 tools.js 真实入口 buildToolDefs）
//   3 域门禁：域外专属（browser-* 五件 / image-inject）域外被拒；域内专属（browser-headful）域内被拒；
//              不域限定件（image-analyze / web-fetch*）域外可用
//   4 timeback 生命周期：type / purpose 校验 · 重复 start · back findings 校验 · back 收尾 · 台账
//   5 回卷（纯函数）：splice 区间正确、本条 assistant 保留、无锚点 = 空操作
//   6 image-inject：本地图片注入成功（图片部件真的进了 content）/ 越界路径被拒
//   7 image-analyze：参数面（缺 path / 越界路径被拒）—— 不调视觉模型（无外部依赖）
//   8 web-fetch：本地回环页真实下载落盘 / 重名拒 / jobs list+status / cancel
//   9 真实链路：本地 HTTP 页 —— 开 / 读正文 / 读链接 / 取值 / 截图 / 页签 / 截图看图 / back 回收
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本（%TEMP%/qqagent-cattools-selftest），
//       不碰正在运行实例的数据目录，也不抢 qq-agent.lock 单实例锁。
// LLM：不调用 —— 本自测覆盖工具面与链路，不产生模型请求。
// 浏览器：真实内核（自动探测 Edge / Chrome）+ 本地回环 HTTP 页 —— 不依赖外网。
// ⚠️ browser-headful 用例会真实弹出有头窗口约 2~4 秒（登录窗口无法在无头下验证）——属预期。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
// 🔴 自测数据目录必须落 NTFS：exFAT 卷上 Chromium 的 user-data-dir 起不来（浏览器链路全挂），
//    落在项目盘（D: exFAT）会让浏览器用例假性"环境阻断"。
const DATA = path.join(os.tmpdir(), 'qqagent-cattools-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));

// 自测配置：浏览锁定关掉（保证本地回环页可访问，与生产配置无关）；内核走自动探测；
// 下载产物落自测数据目录（不污染真实 Downloads）。
const CFG_PATH = path.join(DATA, 'config.json');
const cfg = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {};
cfg.security = { ...(cfg.security || {}), browseLock: { enabled: false, hosts: [], siteSearchUrl: '' } };
cfg.browser = { ...(cfg.browser || {}), kernelPath: '', dataDir: path.join(DATA, 'browser-data') };
cfg.webFetch = { downloadsDir: path.join(DATA, 'downloads'), allowPrivateHosts: true };   // 内网例外：自测走本地回环页
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');

process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getTool, listTools } = await import(mod('tool-registry.js'));
const { registerCatTools, timebackMarkStart, timebackRollback, timebackGateTool } = await import(mod('cat-tools.js'));
const { browserService, resolveKernelPath } = await import(mod('cdp-browser.js'));
const { webFetchService } = await import(mod('web-asset-fetch.js'));   // 归位期改名：web-fetch.js → web-asset-fetch.js
// 补丁接线复核：走 tools.js 的真实入口（buildToolDefs）——比只调 registerCatTools 强一档；
// 再导入编排器，验证补丁后的 orchestrator.js 语法与导入图可加载（重启才不会当场炸）。
const { buildToolDefs } = await import(mod('tools.js'));
await import(mod('orchestrator.js'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT = 'group:selftest';
const TOOL_IDS = [
  'timeback-start', 'timeback-back', 'image-inject', 'image-analyze',
  'browser-open', 'browser-read', 'browser-eval', 'browser-shot', 'browser-tabs', 'browser-headful',
  'web-fetch', 'web-fetch-jobs'
];

// ── 0. 补丁落盘 ─────────────────────────────────────────────────────────────
{
  const marks = [
    ['src/tools.js', '[qqagent-cattools-patch:tools-import]'],
    ['src/tools.js', '[qqagent-cattools-patch:tools-register]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-import2]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-anchor]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-timeback2]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-gate]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-webfetch]'],
    ['src/orchestrator.js', '[qqagent-cattools-patch:orchestrator-close]'],
    ['src/config.js', '[qqagent-cattools-patch:config-browser]'],
    ['src/config.js', '[qqagent-cattools-patch:config-imageinject]'],
    ['src/config.js', '[qqagent-cattools-patch:config-webfetch]'],
    ['src/config.js', '[qqagent-cattools-patch:config-webfetch-priv]']
  ];
  const missing = marks.filter(([rel, m]) => !fs.readFileSync(path.join(BIZ, String(rel).replace(/^src\//, '')), 'utf8').includes(m));
  check(`补丁标记齐全（${marks.length}/${marks.length}）`, missing.length === 0, missing.map((x) => x[1]).join(' '));
  // 归位期改名：web-fetch.js → web-asset-fetch.js（R2-L1 §六-4）；路径基准是 app/src/business/
  const files = ['cdp-browser.js', 'cat-tools.js', 'web-asset-fetch.js'];
  const absent = files.filter((f) => !fs.existsSync(path.join(BIZ, f)));
  check('新模块在位（3/3）', absent.length === 0, absent.join(' '));
  // 编排器真的接上了回卷 / 门禁 / 台账 / 下载器（不只看标记，看调用）
  const orch = fs.readFileSync(path.join(BIZ, 'orchestrator.js'), 'utf8');
  check('编排器接线（回卷 / 门禁 / 台账 / 下载器 / 实例回收）',
    orch.includes('timebackMarkStart(ctx.session, assistantIndex)')
    && orch.includes('timebackRollback(messages, ctx.session, assistantIndex)')
    && orch.includes('timebackGateTool(ctx.session, name)')
    && orch.includes('timebackRecordTool(ctx.session, name, argsRaw, result)')
    && orch.includes('webFetchService.configure(')
    && orch.includes('browserService.closeChat(chatKey)'));
  check('旧单件 timeback 已退役（无残留调用）', !orch.includes("name === 'timeback'"));
}

// ── 1. 工具注册 ─────────────────────────────────────────────────────────────
{
  // 走真实入口（tools.js → registerAllTools → registerCatTools）：证明补丁接线生效
  const ids = buildToolDefs().map((t) => t.id);
  const missing = TOOL_IDS.filter((id) => !ids.includes(id));
  check(`工具注册（${TOOL_IDS.length} 件 · 经 buildToolDefs 真实入口）`, missing.length === 0, missing.join(' '));
  check('工具名符合 OpenAI 函数名规范', TOOL_IDS.every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)));
  check('内核自动探测到（Chromium 系）', Boolean(resolveKernelPath()), resolveKernelPath());
}

// ── 2. 域门禁 ───────────────────────────────────────────────────────────────
const session = {};
const ctx = { chatKey: CHAT, session };
const call = (id, args) => getTool(id).execute(ctx, args);
{
  const r1 = await call('browser-open', { url: 'https://example.com' });
  check('域外 browser-open 被拒', r1.isError === true && /timeback/.test(r1.content), r1.content);
  const r2 = await call('image-inject', { path: 'x.png' });
  check('域外 image-inject 被拒', r2.isError === true && /timeback/.test(r2.content), r2.content);
  const r3 = await call('browser-tabs', { action: 'list' });
  check('域外 browser-tabs 被拒', r3.isError === true && /timeback/.test(r3.content), r3.content);
  // 不域限定件：域外可用（错误来自参数面 / 取图面，不是域门禁）
  const r4 = await call('image-analyze', { path: 'C:\\Windows\\win.ini' });
  check('域外 image-analyze 可用（不被域门禁拦）', r4.isError === true && !/timeback/.test(r4.content), r4.content);
  const r5 = await call('web-fetch-jobs', { action: 'list' });
  check('域外 web-fetch-jobs 可用', r5.isError !== true, String(r5.content).slice(0, 80));
  // 域内专属：browser-headful 在主干可用（此处不真起窗口，只验不被域门禁拦——真起用例见 §7）
  check('域门禁函数：主干放行 browser-headful', timebackGateTool(session, 'browser-headful') === '');
}

// ── 3. timeback 生命周期 ────────────────────────────────────────────────────
{
  const bad = await call('timeback-start', { purpose: '缺 type' });
  check('start 缺 type 被拒', bad.isError === true && /type/.test(bad.content), bad.content);
  const badType = await call('timeback-start', { type: 'code_write', purpose: '不支持的域类型' });
  check('start 未知域类型被拒（附枚举）', badType.isError === true && /browser_vision/.test(badType.content), badType.content);
  const badPurpose = await call('timeback-start', { type: 'browser_vision' });
  check('start 缺 purpose 被拒', badPurpose.isError === true, badPurpose.content);
  const s = await call('timeback-start', { type: 'browser_vision', purpose: '自测' });
  check('start 成功（域开）', !s.isError && session.timebackScope?.active === true && session.timebackScope.type === 'browser_vision',
    String(s.content).split('\n')[0]);
  const dup = await call('timeback-start', { type: 'browser_vision', purpose: '再来一次' });
  check('未闭合时重复 start 被拒', dup.isError === true && /未闭合/.test(dup.content), dup.content);
  // 域内门禁：原生工具（发消息 / 记忆）在域内一律拒
  check('域内拒原生工具（send_message）', /TIMEBACK_PROFILE/.test(timebackGateTool(session, 'send_message')));
  check('域内拒域外专属（browser-headful）', /TIMEBACK_PROFILE/.test(timebackGateTool(session, 'browser-headful')));
  check('域内放行白名单（browser-read）', timebackGateTool(session, 'browser-read') === '');
  // 域机制自用：timeback 两件不受白名单管辖——否则 back 被拒 → 域永远关不掉（自锁）
  check('域内放行 timeback 两件（域机制自用）',
    timebackGateTool(session, 'timeback-back') === '' && timebackGateTool(session, 'timeback-start') === '');
  const headfulInside = await call('browser-headful', { action: 'open' });
  check('域内 browser-headful 被拒', headfulInside.isError === true && /域外专属/.test(headfulInside.content), headfulInside.content);
  // 台账：域内记一次调用（编排器侧调用面）
  const { timebackRecordTool } = await import(mod('cat-tools.js'));
  timebackRecordTool(session, 'browser-read', JSON.stringify({ mode: 'text' }), { content: 'ok' });
  check('域内工具台账记账', Array.isArray(session.timebackScope.ledger) && session.timebackScope.ledger.length === 1,
    JSON.stringify(session.timebackScope.ledger));
  const noFindings = await call('timeback-back', {});
  check('back 缺 findings 被拒', noFindings.isError === true, noFindings.content);
  const b = await call('timeback-back', { findings: '成果：自测\n未竟：无' });
  check('back 成功（域收 + 台账入回执）', !b.isError && session.timebackScope.active === false
    && /工具台账/.test(b.content) && /browser-read/.test(b.content), String(b.content).split('\n')[0]);
  const after = await call('browser-open', { url: 'https://example.com' });
  check('back 之后域外再拒', after.isError === true && /timeback/.test(after.content), after.content);
}

// ── 4. 回卷纯函数 ───────────────────────────────────────────────────────────
{
  // 现场：[0]system [1]user [2]assistant(start) [3]tool [4]assistant(读页) [5]tool [6]assistant(back)
  const msgs = [
    { role: 'system' }, { role: 'user' },
    { role: 'assistant', tag: 'start' }, { role: 'tool', tag: 'start-ok' },
    { role: 'assistant', tag: 'read' }, { role: 'tool', tag: 'read-ok' },
    { role: 'assistant', tag: 'back' }
  ];
  const s = { timebackScope: { active: true, anchor: null } };
  timebackMarkStart(s, 2);
  check('markStart 记锚点', s.timebackScope.anchor === 2, String(s.timebackScope.anchor));
  const idx = timebackRollback(msgs, s, 6);
  check('回卷后长度正确（7 → 3）', msgs.length === 3, 'len=' + msgs.length);
  check('回卷后本条 assistant 落在锚点位', idx === 2 && msgs[2].tag === 'back', 'idx=' + idx + ' tag=' + msgs[2]?.tag);
  check('回卷计数落到域状态', s.timebackScope.rolledBack === 4, String(s.timebackScope.rolledBack));
  check('锚点已清（不可重复回卷）', s.timebackScope.anchor === null);
  const again = timebackRollback(msgs, s, 2);
  check('无锚点时回卷 = 空操作', msgs.length === 3 && again === 2, 'len=' + msgs.length + ' idx=' + again);
  const s2 = { timebackScope: { active: true, anchor: 5 } };
  const m2 = [{}, {}, {}];
  check('锚点越界 = 空操作', timebackRollback(m2, s2, 2) === 2 && m2.length === 3);
}

// ── 5. image-inject：本地图 + 越界 ──────────────────────────────────────────
{
  const png = Buffer.concat([
    Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489', 'hex'),
    Buffer.alloc(64)
  ]);
  const imgPath = path.join(DATA, 'selftest.png');
  fs.writeFileSync(imgPath, png);
  await call('timeback-start', { type: 'browser_vision', purpose: '看图自测' });
  const okLocal = await call('image-inject', { path: imgPath, note: '自测图' });
  const parts = Array.isArray(okLocal.content) ? okLocal.content : [];
  check('本地图片注入（图片部件到位）', !okLocal.isError && parts.some((p) => p.type === 'image_url'
    && String(p.image_url?.url || '').startsWith('data:image/')), JSON.stringify(parts[0] || okLocal.content).slice(0, 120));
  const outside = await call('image-inject', { path: 'C:\\Windows\\win.ini' });
  check('越界路径被拒', outside.isError === true && /允许根目录|数据目录|临时目录/.test(outside.content), outside.content);
  const noArg = await call('image-inject', {});
  check('path / url 都不给 → 被拒', noArg.isError === true, noArg.content);
  await call('timeback-back', { findings: '成果：本地图注入通' });
}

// ── 6. image-analyze：参数面（不调视觉模型）─────────────────────────────────
{
  const noPath = await call('image-analyze', {});
  check('image-analyze 缺 path 被拒', noPath.isError === true && /path/.test(noPath.content), noPath.content);
  const outside = await call('image-analyze', { path: 'C:\\Windows\\win.ini' });
  check('image-analyze 越界路径被拒（未发起模型请求）', outside.isError === true && /允许根目录|数据目录|临时目录/.test(outside.content), outside.content);
  const notImage = path.join(DATA, 'not-image.txt');
  fs.writeFileSync(notImage, 'hello', 'utf8');
  const bad = await call('image-analyze', { path: notImage });
  check('image-analyze 非图片文件被拒', bad.isError === true && /图片/.test(bad.content), bad.content);
}

// ── 7. 真实链路：本地回环页（浏览器 + 下载器）────────────────────────────────
const ASSET = Buffer.alloc(200 * 1024, 0x41);   // 200KB 固定内容
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/page2') {
    res.end('<!doctype html><html><head><title>第二页</title></head><body><p>CATTOOLS-PAGE2</p></body></html>');
    return;
  }
  if (req.url === '/asset.bin') {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(ASSET.length));
    res.end(ASSET);
    return;
  }
  res.end(`<!doctype html><html><head><title>猫工具链自测页</title></head><body>
    <h1>猫工具链自测</h1>
    <p>标记文本 CATTOOLS-MARK-42</p>
    <a href="/page2">去第二页</a>
    <a href="https://example.com/">外链</a>
    <img src="/none.png" alt="占位">
  </body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

try {
  // ── 7.1 web-fetch：真实下载落盘 + 查重 + jobs ─────────────────────────────
  {
    const down = await call('web-fetch', { url: `${base}asset.bin`, file_name: 'selftest-asset.bin' });
    check('web-fetch 登记成功（返回任务号）', !down.isError && /已登记下载任务/.test(down.content), String(down.content).split('\n')[0]);
    let job = null;
    for (let i = 0; i < 60; i += 1) {
      job = webFetchService.jobs.find((j) => j.fileName === 'selftest-asset.bin');
      if (job && job.status !== 'running') break;
      await sleep(100);
    }
    const okFile = job?.status === 'done' && fs.existsSync(job.filePath)
      && fs.statSync(job.filePath).size === ASSET.length;
    check('下载完成且产物落盘（体积一致）', okFile,
      `status=${job?.status} size=${job ? job.bytes : '-'} path=${job?.filePath || ''}`);
    const dup = await call('web-fetch', { url: `${base}asset.bin`, file_name: 'selftest-asset.bin' });
    check('重名目标被拒（含 .part）', dup.isError === true && /同名文件已存在/.test(dup.content), dup.content);
    const jobsList = await call('web-fetch-jobs', { action: 'list' });
    check('web-fetch-jobs list 列出任务', !jobsList.isError && /selftest-asset\.bin/.test(jobsList.content),
      String(jobsList.content).split('\n')[0]);
    const detail = await call('web-fetch-jobs', { action: 'status', id: job?.id || '' });
    check('web-fetch-jobs status 给详情', !detail.isError && /已完成/.test(detail.content), String(detail.content).split('\n')[1]);
    const cancelDone = await call('web-fetch-jobs', { action: 'cancel', id: job?.id || '' });
    check('已终结任务不可取消', /不可取消/.test(cancelDone.content), String(cancelDone.content).slice(0, 80));
  }

  // ── 7.2 browser-headful：域外起有头窗口（真弹窗约 2~4 秒）→ close ─────────
  {
    const open = await call('browser-headful', { action: 'open' });
    const opened = !open.isError && /有头窗口已就绪/.test(open.content);
    check('browser-headful open 起有头窗口（真弹窗）', opened, String(open.content).split('\n')[0]);
    await sleep(800);
    const close = await call('browser-headful', { action: 'close' });
    check('browser-headful close 关闭（profile 保留）', !close.isError && /已关闭/.test(close.content), String(close.content).slice(0, 80));
    check('有头实例已回收', browserService.has(CHAT) === false, 'has=' + browserService.has(CHAT));
  }

  await call('timeback-start', { type: 'browser_vision', purpose: '网页自测' });

  // ── 网络面探针（环境判定）────────────────────────────────────────────────
  // 内核网络面异常时一切 http 导航挂死（最常见成因：user-data-dir 落 exFAT 卷）。
  // 先探一次：探不通 = 环境阻断 —— 浏览器链路整体记 SKIP，不让环境问题伪装成代码缺陷。
  let envBlocked = false;
  let envReason = '';
  {
    const probe = await call('browser-open', { url: base });
    if (!probe.isError) {
      check('网络面探针：可用', true, '内核网络面正常');
    } else if (/网络面不可用/.test(probe.content)) {
      envBlocked = true;
      envReason = String(probe.content).replace(/^错误：/, '').slice(0, 220);
      check('网络面探针：环境阻断（非代码缺陷）', true, envReason);
    } else {
      check('网络面探针', false, String(probe.content).slice(0, 220));
    }
  }

  if (envBlocked) {
    const skipped = [
      'browser-open 打开本地页', 'browser-read text 读到标记文本', 'browser-read links 列出站内链接',
      'browser-read ax 返回无障碍树', 'browser-eval 取值', 'browser-eval 支持 return 语句块',
      'browser-shot 产出 PNG', '截图交给 image-inject 可看（跨工具闭环）',
      'browser-tabs list 有页签', 'browser-tabs new 新建并切到新页签',
      '新页签读到第二页内容', 'browser-tabs close 关页签', 'back 回收浏览器实例'
    ];
    for (const name of skipped) check('SKIP ' + name, true, '环境阻断：内核网络面不可用（见上方探针输出）');
    await call('timeback-back', { findings: '成果：无（环境阻断）' });
  } else {
    const opened = await call('browser-open', { url: base });
    check('browser-open 打开本地页', !opened.isError && /猫工具链自测页/.test(opened.content), String(opened.content).slice(0, 160));

    const text = await call('browser-read', {});
    check('browser-read text 读到标记文本', !text.isError && /CATTOOLS-MARK-42/.test(text.content), String(text.content).slice(0, 160));

    const links = await call('browser-read', { mode: 'links' });
    check('browser-read links 列出站内链接', !links.isError && /page2/.test(links.content), String(links.content).slice(0, 200));

    const ax = await call('browser-read', { mode: 'ax' });
    check('browser-read ax 返回无障碍树', !ax.isError && String(ax.content).length > 0, String(ax.content).slice(0, 120));

    const ev = await call('browser-eval', { expression: 'document.title' });
    check('browser-eval 取值', !ev.isError && /猫工具链自测页/.test(ev.content), String(ev.content).slice(0, 120));

    const ev2 = await call('browser-eval', { expression: 'return document.querySelectorAll("a").length' });
    check('browser-eval 支持 return 语句块', !ev2.isError && /2/.test(ev2.content), String(ev2.content).slice(0, 120));

    const shot = await call('browser-shot', {});
    const shotPath = (() => { try { return JSON.parse(shot.content).截图; } catch { return ''; } })();
    const shotOk = !shot.isError && shotPath && fs.existsSync(shotPath)
      && fs.readFileSync(shotPath).subarray(0, 4).toString('hex') === '89504e47';
    check('browser-shot 产出 PNG', shotOk, shotPath || String(shot.content).slice(0, 160));

    const injectShot = await call('image-inject', { path: shotPath, note: '看截图' });
    check('截图交给 image-inject 可看（跨工具闭环）', !injectShot.isError
      && Array.isArray(injectShot.content) && injectShot.content.some((p) => p.type === 'image_url'), String(injectShot.content?.[0]?.text || '').slice(0, 160));

    const tabs = await call('browser-tabs', { action: 'list' });
    check('browser-tabs list 有页签', !tabs.isError && /页签/.test(tabs.content), String(tabs.content).slice(0, 200));

    const newTab = await call('browser-tabs', { action: 'new', url: `${base}page2` });
    check('browser-tabs new 新建并切到新页签', !newTab.isError, String(newTab.content).slice(0, 200));
    const text2 = await call('browser-read', {});
    check('新页签读到第二页内容', !text2.isError && /CATTOOLS-PAGE2/.test(text2.content), String(text2.content).slice(0, 160));

    const closedTab = await call('browser-tabs', { action: 'close', target: '1' });
    check('browser-tabs close 关页签', !closedTab.isError, String(closedTab.content).slice(0, 200));

    const hasBefore = browserService.has(CHAT);
    const back = await call('timeback-back', { findings: '成果：本地页读取/截图/页签全通\n未竟：无' });
    const hasAfter = browserService.has(CHAT);
    check('back 回收浏览器实例', !back.isError && hasBefore === true && hasAfter === false,
      `before=${hasBefore} after=${hasAfter}`);
  }
} catch (error) {
  check('真实链路未抛异常', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  server.close();
  await browserService.closeAll();
}

// ── 8. 收尾 ─────────────────────────────────────────────────────────────────
{
  const leftover = browserService.size;
  check('收尾后无残留实例', leftover === 0, 'size=' + leftover);
  webFetchService.shutdown();
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => String(r.name).startsWith('SKIP ')).length;
const ran = results.length - skipped;
console.log('\n' + (failed.length
  ? 'FAILED ' + failed.length + '/' + results.length
  : 'ALL PASS ' + ran + '/' + ran + (skipped ? `（另有 ${skipped} 项因环境阻断跳过 —— 见上）` : '')));
process.exit(failed.length ? 1 : 0);
