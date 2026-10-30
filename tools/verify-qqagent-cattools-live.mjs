// verify-qqagent-cattools-live.mjs — 猫工具链「活链路」验证（生产配置 + 真外网）
//
// 用法：node verify-qqagent-cattools-live.mjs
// 与 verify-qqagent-cattools.mjs 的分工：
//   自测版 = 离线（本地回环页 + 假图）——验代码面，可反复跑；
//   本版   = 活链路（真外网 + 生产视觉模型配置 + 截图交识图闭环）——验「消费点实锤」。
// 隔离：数据目录仍用 %TEMP%（不碰生产存档 / 任务表）；配置从生产 config.json 复制（含 api key）。
// 站点：用国内直连可达站（本机到 example.com 需代理，直连被拒——生产设计是「国内直连」）。
// 浏览器：真实内核 + 真外网；有头件真弹窗约 2~4 秒。
// LLM：image-analyze 会真调一次视觉模型（生产端点）——这是本验证的核心项。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const PROD = path.resolve(HERE, '..', '_unpack', 'data');
const DATA = path.join(os.tmpdir(), 'qqagent-cattools-live');
const SITE = 'https://www.baidu.com';
const FILE_NAME = 'live-probe-baidu.html';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(PROD, 'config.json'), 'utf8'));
cfg.security = { ...(cfg.security || {}), browseLock: { enabled: false, hosts: [], siteSearchUrl: '' } };
cfg.browser = { ...(cfg.browser || {}), dataDir: path.join(DATA, 'browser-data') };
cfg.webFetch = { ...(cfg.webFetch || {}), downloadsDir: path.join(DATA, 'downloads') };
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
const { getTool } = await import(mod('tool-registry.js'));
const { browserService } = await import(mod('cdp-browser.js'));
const { webFetchService } = await import(mod('web-fetch.js'));
const { buildToolDefs } = await import(mod('tools.js'));
buildToolDefs();   // 触发 registerAllTools（工具注册面）

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + String(detail).slice(0, 240)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT = 'group:live-probe';
const session = {};
const ctx = { chatKey: CHAT, session };
const call = (id, args) => getTool(id).execute(ctx, args);

console.log(`模型：${cfg.api?.model} @ ${cfg.api?.baseUrl} · 视觉专用模型：${cfg.api?.visionModel || '(未设，用主模型)'}`);

try {
  // ── 1. 域门禁（快检）────────────────────────────────────────────────────
  const outside = await call('browser-open', { url: SITE });
  check('域外 browser-open 被拒', outside.isError === true && /timeback/.test(outside.content));
  const opened = await call('timeback-start', { type: 'browser_vision', purpose: '活链路探针' });
  check('timeback-start 开域', !opened.isError, String(opened.content).split('\n')[0]);

  // ── 2. 浏览器真外网 ─────────────────────────────────────────────────────
  let shotPath = '';
  const nav = await call('browser-open', { url: SITE });
  const navOk = !nav.isError && /百度|baidu/i.test(nav.content);
  check(`browser-open 打开真外网（${SITE}）`, navOk, navOk ? '' : String(nav.content).slice(0, 200));

  if (navOk) {
    const text = await call('browser-read', {});
    check('browser-read 读到正文', !text.isError && /百度/.test(text.content), String(text.content).slice(0, 120));
    const shot = await call('browser-shot', {});
    shotPath = (() => { try { return JSON.parse(shot.content).截图; } catch { return ''; } })();
    check('browser-shot 产出 PNG', !!shotPath && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000,
      shotPath || String(shot.content).slice(0, 160));
  } else {
    check('browser-read 读到正文', false, 'SKIP（浏览器链路未通）');
    check('browser-shot 产出 PNG', false, 'SKIP（浏览器链路未通）');
  }

  // ── 3. image-analyze：真调视觉模型（截图交识图闭环）──────────────────────
  if (shotPath && fs.existsSync(shotPath)) {
    const analyzed = await call('image-analyze', { path: shotPath, question: '逐字读出图里能看到的中文文字（任意几处即可）。' });
    const okAnalyze = !analyzed.isError && /百度/.test(String(analyzed.content));
    check('image-analyze 调视觉模型并读对图', okAnalyze, String(analyzed.content).replace(/\n/g, ' ').slice(0, 220));
  } else {
    check('image-analyze 调视觉模型并读对图', false, 'SKIP（无截图）');
  }

  // ── 4. web-fetch：真外网下载 ────────────────────────────────────────────
  const dl = await call('web-fetch', { url: `${SITE}/`, file_name: FILE_NAME });
  check('web-fetch 登记任务', !dl.isError && /已登记下载任务/.test(dl.content), String(dl.content).split('\n')[0]);
  let job = null;
  for (let i = 0; i < 100; i += 1) {
    job = webFetchService.jobs.find((j) => j.fileName === FILE_NAME);
    if (job && job.status !== 'running') break;
    await sleep(150);
  }
  const dlOk = job?.status === 'done' && fs.existsSync(job.filePath) && fs.statSync(job.filePath).size > 0;
  check('web-fetch 真外网下载落盘', dlOk, `status=${job?.status} bytes=${job?.bytes} err=${job?.error || ''}`);
  const jobsList = await call('web-fetch-jobs', { action: 'list' });
  check('web-fetch-jobs list 可查', !jobsList.isError && new RegExp(FILE_NAME.replace('.', '\\.')).test(jobsList.content));

  // ── 5. 回卷 ─────────────────────────────────────────────────────────────
  const back = await call('timeback-back', { findings: '成果：活链路探针\n未竟：无' });
  check('timeback-back 回收（含工具台账）', !back.isError && /工具台账/.test(back.content));

  // ── 6. browser-headful（真弹窗）─────────────────────────────────────────
  const head = await call('browser-headful', { action: 'open' });
  check('browser-headful open 起有头窗口', !head.isError && /有头窗口已就绪/.test(head.content), String(head.content).split('\n')[0]);
  await sleep(1000);
  const headClose = await call('browser-headful', { action: 'close' });
  check('browser-headful close 关闭', !headClose.isError && /已关闭/.test(headClose.content));
} catch (error) {
  check('活链路未抛异常', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  await browserService.closeAll();
  webFetchService.shutdown();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASS ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
