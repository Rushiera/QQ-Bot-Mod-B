// patch-qqagent-search.mjs — QQ Agent「搜索通道精简」幂等补丁
//
// 用法：node patch-qqagent-search.mjs [--dry]
// 做什么（Rushiera 2026-10-11 指令：不可用的去掉，主力用百度网页通道）：
//   1 web-search.js —— 新增百度结果页解析通道（baiduHtmlSearch / parseBaiduResults，无需 API Key）
//   2 web-search.js —— 删除需要 API Key 的四家实现（deepseek / zhipu / bocha / 千帆 baidu）
//      与 metaso（免费额度已废）+ 自定义搜索两件（customSearch / resolveCustomConfig / bingSearchWithUrl）
//   3 web-search.js —— 分派只认 baidu（默认）| bing；其余抛「未知的搜索提供方」（失败可见，不静默回落）
//   4 config.js —— webSearch 默认段精简（provider 默认 baidu）
//   5 ui/app/06-settings-render.js —— 提供方下拉只留两项 + 提示文案改「无需 Key」
// 不改：routes.js（/api/search-key 接口与 UI 各表单块保留但永不显示）· 07/08 UI 事件与提交逻辑
//
// 🔴 补丁链顺序：session → engage → nosys → memory → sessions-fold → botguard → hardlimit
//   → talkstyle → cattools → **本补丁**（链尾——本补丁改 config.js 的 webSearch 段，
//   而 cattools 的 config-webfetch 锚点是该段上方那行注释；cattools 已打过标记，
//   重跑会 skip，故本补丁必须排在其后）
// 幂等：每个补丁点带唯一标记 [qqagent-search-patch:<id>]；已含标记 = 跳过。
// 边界：不动安全边界（safe-fetch / 浏览锁定）/ 不动发送面 / 不动图片搜索组。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const UIAPP = path.join(APP, 'ui', 'app');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqagent-search-patch:' + id + ']';

function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换（锚点须唯一命中；已应用过则跳过）。 */
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

/** 区间切除：删掉 [startAnchor, endAnchor)，原地留一行标记注释。 */
function cutBetween(id, root, rel, startAnchor, endAnchor, note) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(startAnchor, eol);
  const b = toEol(endAnchor, eol);
  const i = text.indexOf(a);
  if (i < 0) throw new Error('[' + id + '] 起点锚未命中：' + JSON.stringify(a.slice(0, 80)));
  const j = text.indexOf(b, i + a.length);
  if (j < 0) throw new Error('[' + id + '] 终点锚未命中：' + JSON.stringify(b.slice(0, 80)));
  if (text.indexOf(a, i + a.length) >= 0) throw new Error('[' + id + '] 起点锚不唯一');
  const stamped = '// ' + mark(id) + ' 已删除：' + note + eol;
  if (!DRY) fs.writeFileSync(file, text.slice(0, i) + stamped + text.slice(j), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied', removed: j - i });
}

/** 区间替换：替换 [startAnchor, endAnchor)（endAnchor 保留）。 */
function replaceBetween(id, root, rel, startAnchor, endAnchor, replacement) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  if (text.includes(toEol(mark(id), eol))) { results.push({ id, file: rel, status: 'skipped' }); return; }
  const a = toEol(startAnchor, eol);
  const b = toEol(endAnchor, eol);
  const i = text.indexOf(a);
  if (i < 0) throw new Error('[' + id + '] 起点锚未命中：' + JSON.stringify(a.slice(0, 80)));
  const j = text.indexOf(b, i + a.length);
  if (j < 0) throw new Error('[' + id + '] 终点锚未命中：' + JSON.stringify(b.slice(0, 80)));
  if (text.indexOf(a, i + a.length) >= 0) throw new Error('[' + id + '] 起点锚不唯一');
  if (!DRY) fs.writeFileSync(file, text.slice(0, i) + toEol(replacement, eol) + text.slice(j), 'utf8');
  results.push({ id, file: rel, status: DRY ? 'dry' : 'applied', replaced: j - i });
}

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 1：web-search.js —— 删 DeepSeek 实现（需 API Key）
// ─────────────────────────────────────────────────────────────────────────────
cutBetween('cut-deepseek', SRC, 'web-search.js',
`/**
 * DeepSeek 服务端原生搜索（Responses API，web_search 工具）。`,
`/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。`,
'DeepSeek 原生搜索（需 API Key）');

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 2：web-search.js —— 删 智谱 / 博查 / 千帆百度 / 秘塔 / 自定义搜索（全部不可用）
// ─────────────────────────────────────────────────────────────────────────────
cutBetween('cut-api-others', SRC, 'web-search.js',
`/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */`,
`// 图片搜索与站内搜索（供 send_image / search_images 工具使用）`,
'智谱 / 博查 / 千帆百度 / 秘塔 / 自定义搜索（需 API Key 或接口已废）');

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 3：web-search.js —— 新增百度结果页解析通道（无 Key）
// ─────────────────────────────────────────────────────────────────────────────
patch('insert-baidu', SRC, 'web-search.js',
`/** 给工具用的统一入口：搜索 + 紧凑序列化。 */`,
`// ` + mark('insert-baidu') + `
/** 百度结果页摘要：块内最长的一段可读文本（百度结构多变，不做精确选择器）。 */
function pickBaiduSnippet(block, title) {
  const clean = String(block ?? '')
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ');
  const cands = [];
  for (const m of clean.matchAll(/<(?:span|div|p|font|em)[^>]*>([\\s\\S]{20,500}?)<\\/(?:span|div|p|font|em)>/gi)) {
    const t = decodeHtml(m[1]);
    if (t.length < 20) continue;
    if (/^https?:/i.test(t)) continue;
    if (t === title) continue;
    if (/function\\s*\\(|var\\s+\\w+\\s*=|window\\./.test(t)) continue;   // 页面脚本残留
    cands.push(t);
  }
  cands.sort((a, b) => b.length - a.length);
  return (cands[0] || '').slice(0, 220);
}

/** 从百度结果页 HTML 里解析 result c-container 块（纯函数，测试可直接驱动）。
 *  真实链接取 mu 属性（百度新版把目标 URL 放这里），缺省回落 h3 内的跳转链接。 */
export function parseBaiduResults(html, maxResults = 6) {
  const out = [];
  const seen = new Set();
  for (const block of String(html ?? '').split(/<div[^>]+class="[^"]*result c-container/).slice(1)) {
    const h3 = (block.match(/<h3[^>]*>([\\s\\S]*?)<\\/h3>/i) || [])[1] || '';
    const title = decodeHtml(h3);
    if (!title) continue;
    const mu = (block.match(/\\bmu="([^"]+)"/) || [])[1] || '';
    const href = (h3.match(/href="([^"]+)"/i) || [])[1] || '';
    const url = decodeHtml(mu || href);
    if (!/^https?:\\/\\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: pickBaiduSnippet(block, title) });
    if (out.length >= maxResults) break;
  }
  return out;
}

/** 百度搜索（结果页解析，无需 API Key）。searchUrl 可在配置中替换（测试/换入口）。 */
export async function baiduHtmlSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.baidu?.searchUrl || 'https://www.baidu.com/s');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('ie', 'UTF-8');
  url.searchParams.set('wd', sanitizeQuery(query));
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(\`百度搜索 HTTP \${res.status}\`);
  const html = await res.text();
  const results = parseBaiduResults(html, maxResults);
  if (!results.length) throw new Error('百度搜索没有解析到结果（可能触发了验证页或页面已改版）');
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 4：web-search.js —— 分派只认 baidu | bing
// ─────────────────────────────────────────────────────────────────────────────
patch('dispatch', SRC, 'web-search.js',
`export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}`,
`export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'baidu').toLowerCase();
  if (provider === 'baidu') return baiduHtmlSearch(clean);
  if (provider === 'bing') return bingSearch(clean);
  // 未知提供方不静默回落——回落到别的引擎会让"配置写错了"看起来像"搜到了"
  throw new Error(\`未知的搜索提供方：\${provider}（可用：baidu / bing）\`);
}   // ` + mark('dispatch'));

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 5：config.js —— webSearch 默认段精简（provider 默认 baidu）
// ─────────────────────────────────────────────────────────────────────────────
replaceBetween('config-websearch', SRC, 'config.js',
`  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）`,
`  // 安全例外（默认全部关闭）`,
`  // 联网搜索（网页解析通道，无需 API Key）：'baidu'（默认）| 'bing' —— [qqagent-search-patch:config-websearch]
  webSearch: {
    enabled: true,
    provider: 'baidu',
    maxResults: 6,
    // baidu：百度结果页解析（https://www.baidu.com/s?wd=…）
    baidu: { searchUrl: 'https://www.baidu.com/s' },
    // bing：Bing 结果页解析（b_algo 块）
    searchUrl: 'https://cn.bing.com/search',
    // 自定义搜索提供商列表（保留配置容器；搜索实现层已精简，选中会明确报「未知的搜索提供方」）
    providers: [],
    custom: {
      name: '',
      type: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      count: 6,
      timeoutMs: 20000
    }
  },
`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 6：UI —— 提示文案（只留两种通道 + 明示无需 Key）
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-hint', UIAPP, '06-settings-render.js',
`      当前提供方：\${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      \${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key';
      })()}`,
`      当前提供方：\${prov === 'bing' ? 'Bing 网页解析' : '百度网页解析'} · 无需 API Key   <!-- [qqagent-search-patch:ui-hint] -->`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 7：UI —— 下拉只留 baidu / bing
// ─────────────────────────────────────────────────────────────────────────────
patch('ui-options', UIAPP, '06-settings-render.js',
`        <option value="bing" \${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" \${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" \${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" \${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" \${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" \${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>`,
`        <!-- [qqagent-search-patch:ui-options] 只保留两种网页解析通道 -->
        <option value="baidu" \${prov === 'baidu' ? 'selected' : ''}>百度网页解析（推荐）</option>
        <option value="bing" \${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 8：routes.js —— 删 customSearch 导入
//   🔴 消费方必须同步：删了 web-search.js 的导出而 routes.js 仍 import 它 →
//      ESM 静态导入报「does not provide an export named」→ 业务面启动即闪退（日志都没来得及写）
//   判例：v0.56 首版漏改 → 22:41 拉起业务面后无启动日志、领航员报「业务面记忆 API 不可达」
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-import', SRC, 'routes.js',
`import { customSearch } from './web-search.js';
`,
`// ` + mark('routes-import') + ` 已删除：customSearch 导入（自定义搜索下线）
`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 9：routes.js —— 自定义搜索测试接口改明确回执（不再调 customSearch）
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-test', SRC, 'routes.js',
`          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });`,
`          // 自定义搜索已下线（v0.56：搜索通道精简为 baidu / bing 两种网页解析）
          // ` + mark('routes-test') + `
          return json(res, 200, { ok: true, result: { ok: false, note: '自定义搜索已下线（搜索提供方现为 baidu / bing 两种网页解析）', latencyMs: Date.now() - startedAt } });`);

// ─────────────────────────────────────────────────────────────────────────────
// 补丁 10：routes.js —— 删除自定义服务时的回落提供方改 baidu
// ─────────────────────────────────────────────────────────────────────────────
patch('routes-fallback', SRC, 'routes.js',
'          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: \'bing\' } });',
'          // 自定义搜索已下线——回落默认提供方 baidu   ' + mark('routes-fallback') + `
          if (cur === \`custom:\${id}\`) updateConfig({ webSearch: { provider: 'baidu' } });`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  applied: results.filter((r) => r.status === 'applied').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  results
}, null, 2));
