// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
// ⚠️ L15 备注（2026-09-19）：主搜索的裸 fetch 属"管理员自伤面"而非远程可利用面
//    （URL 来自本机配置，不经模型/群友控制）。这里维持普通 fetch 的原因：
//    safe-fetch 会拒绝解析到内网的地址，而"搜索接口部署在自家内网/反代后"是
//    合法配置。真正的远程输入（模型传进来的 query）已由 sanitizeQuery 清洗。
import { getConfig } from './config.js';
import { safeFetch } from './safe-fetch.js';

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 简化查询：去掉搜索口语与时间词，留下真正要搜的内容。
 * 例："帮我搜一下 今日 AI 新闻" → "AI 新闻"
 */
export function simplifyQuery(query) {
  return String(query ?? '')
    .replace(/(帮我|麻烦|请)?\s*(搜一下|搜索一下|搜索|搜搜|查一下|查询一下|查询|找一下|找找|搜|查)/g, ' ')
    .replace(/(今日|今天|昨日|昨天|明天|明日|最新|最近|近期)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 提取关键词：拉丁词按词取；中文按相邻二元词（bigram）滑窗取。
 * 用于搜索引擎结果的相关性打分/重排。
 */
export function queryKeywords(query) {
  const s = String(query ?? '');
  const latin = s.match(/[A-Za-z][A-Za-z0-9_.-]*/g) || [];
  const bigrams = [];
  for (const run of s.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));
  }
  return { latin, bigrams };
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bing 结果页解析（b_algo 结果块）。
 * bingSearch（主搜索）与自定义 bing 类型共用这一份 —— 之前两处各写一遍，
 * 单边改解析规则另一边悄悄漂移（原 bingSearchWithUrl 的注释甚至已与实现脱节）。
 * 返回 [{ title, url, snippet }]，失败抛错（页面改版/非 200）。
 */
async function fetchBingoResults(searchUrl, query, maxResults) {
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  return parseBingResults(html, maxResults);
}

/** 从 Bing HTML 里解析 b_algo 块（纯函数，测试可直接驱动）。 */
export function parseBingResults(html, maxResults = 6) {
  const results = [];
  for (const block of String(html ?? '').split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const results = await fetchBingoResults(searchUrl, sanitizeQuery(query), maxResults);
  if (!results.length) throw new Error('搜索没有解析到结果（引擎页面结构可能已改版）');
  return { query, results };
}

// [qqagent-search-patch:insert-baidu]
/** 百度结果页摘要：块内最长的一段可读文本（百度结构多变，不做精确选择器）。 */
function pickBaiduSnippet(block, title) {
  const clean = String(block ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const cands = [];
  for (const m of clean.matchAll(/<(?:span|div|p|font|em)[^>]*>([\s\S]{20,500}?)<\/(?:span|div|p|font|em)>/gi)) {
    const t = decodeHtml(m[1]);
    if (t.length < 20) continue;
    if (/^https?:/i.test(t)) continue;
    if (t === title) continue;
    if (/function\s*\(|var\s+\w+\s*=|window\./.test(t)) continue;   // 页面脚本残留
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
    const h3 = (block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    const title = decodeHtml(h3);
    if (!title) continue;
    const mu = (block.match(/\bmu="([^"]+)"/) || [])[1] || '';
    const href = (h3.match(/href="([^"]+)"/i) || [])[1] || '';
    const url = decodeHtml(mu || href);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
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
  if (!res.ok) throw new Error(`百度搜索 HTTP ${res.status}`);
  const html = await res.text();
  const results = parseBaiduResults(html, maxResults);
  if (!results.length) throw new Error('百度搜索没有解析到结果（可能触发了验证页或页面已改版）');
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'baidu').toLowerCase();
  if (provider === 'baidu') return baiduHtmlSearch(clean);
  if (provider === 'bing') return bingSearch(clean);
  // 未知提供方不静默回落——回落到别的引擎会让"配置写错了"看起来像"搜到了"
  throw new Error(`未知的搜索提供方：${provider}（可用：baidu / bing）`);
}   // [qqagent-search-patch:dispatch]

// [qqagent-search-patch:cut-deepseek] 已删除：DeepSeek 原生搜索（需 API Key）
/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。
 * browseLocked：浏览锁定开启时必须传 true —— safeFetch 会逐跳校验
 * （含重定向目标）是否在白名单内。web_fetch 工具曾经漏传这个参数，
 * 锁定开启时模型照样能抓任意站点，白名单形同虚设。 */
export async function webFetch(url, { browseLocked = false } = {}) {
  const result = await safeFetch(url, { browseLocked });
  return result;
}

// [qqagent-search-patch:cut-api-others] 已删除：智谱 / 博查 / 千帆百度 / 秘塔 / 自定义搜索（需 API Key 或接口已废）
// 图片搜索与站内搜索（供 send_image / search_images 工具使用）
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么单独一组函数，而不是复用 webSearch：
//   webSearch 返回的是**网页链接**，模型拿到后往往"再抓一次页面、再从中挑图"，
//   多两轮工具调用。发图场景需要的是**图片直链**，直接给它，省一轮。
//
// 注意：这两个解析器依赖搜索引擎的 HTML 结构，**页面改版就会失效**。
// 所以失败时抛错而不是返回空数组 —— 让调用方知道"是解析坏了"而不是"没结果"。

/**
 * 站内搜索：把 `{query}` 模板替换成 URL 编码的关键词。
 *
 * 配合 browseLock 使用：锁定站点 + 站内搜索模板 = "机器人只能在这几个站里搜"。
 * 模板里没有 `{query}` 时按 Bing 的 `?q=` 约定兜底（而不是静默拼错 URL）。
 *
 * @param {string} template 形如 'https://example.com/search?q={query}'
 * @param {string} query 关键词
 * @returns {string} 完整 URL
 */
export function buildSiteSearchUrl(template, query) {
  const tpl = String(template ?? '').trim();
  if (!tpl) throw new Error('站内搜索模板为空');
  const q = String(query ?? '').trim();
  if (tpl.includes('{query}')) return tpl.replaceAll('{query}', encodeURIComponent(q));
  // 兼容 %s 写法（部分搜索站用这个占位）
  if (tpl.includes('%s')) return tpl.replaceAll('%s', encodeURIComponent(q));
  // 没有占位符：按是否已有 query string 决定拼 ?q= 还是 &q=
  return tpl + (tpl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q);
}

/** 从 HTML 里提取图片直链。相对路径补成绝对、去重、按出现顺序。 */
export function extractImageUrls(html, baseUrl = '', max = 10) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return;
    // 接受：绝对 http(s)、协议相对 //、根相对 /、普通相对（a.jpg / images/a.png）、data:
    // 普通相对路径必须有 baseUrl 才能补全，否则没有意义
    const isBareRelative = !/^https?:\/\//i.test(s) && !s.startsWith('//') && !s.startsWith('/') && !s.startsWith('data:');
    if (isBareRelative && !baseUrl) return;
    let abs = s;
    try {
      abs = s.startsWith('//') ? new URL(`https:${s}`).toString() : new URL(s, baseUrl || undefined).toString();
    } catch { return; }
    if (!/^https?:/i.test(abs)) return;          // 丢掉 data: 之类
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  // ① 各种懒加载属性优先（它们的优先级通常高于 src 里的占位图）
  for (const m of String(html ?? '').matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'srcset', 'src']) {
      const mm = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
      if (!mm) continue;
      // srcset 是 "url 1x, url2 2x" 形式，只取第一个 URL
      push(String(mm[1]).split(',')[0].trim().split(/\s+/)[0]);
      if (out.length >= max) return out;
    }
    if (out.length >= max) break;
  }
  if (out.length < max) {
    for (const m of String(html ?? '').matchAll(/["'](https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"'\s]*)?)["']/gi)) {
      push(m[1]);
      if (out.length >= max) break;
    }
  }
  return out.slice(0, Math.max(1, Number(max) || 10));
}

/** 从 HTML 里提炼可读正文（去标签、压空白），供 attachPageContents 之类的场景用。 */
export function extractPageDigest(html, _baseUrl = '', { maxChars = 6000, maxLinks = 24 } = {}) {
  const raw = String(html ?? '');
  // 先干掉 script/style/nav 这些纯噪音，否则正文里会混进一堆 JS
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeHtml(cleaned.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const links = [];
  for (const m of cleaned.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= maxLinks) break;
    const href = String(m[1]).trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const label = decodeHtml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (label) links.push({ title: label.slice(0, 80), url: href });
  }
  const cap = Math.max(200, Number(maxChars) || 6000);
  return { text: text.length > cap ? `${text.slice(0, cap)}…（已截断）` : text, links, images: extractImageUrls(cleaned, _baseUrl, 10) };
}

// ── 图片搜索 ──────────────────────────────────────────────────────────────

/**
 * Bing 图片搜索。
 *
 * 做法：请求图片搜索页，从结果块里捞 `murl`（媒体直链）与 `turl`（缩略图）。
 * Bing 把这两者塞在 `m="{\"murl\":\"...\",\"turl\":\"...\"}"` 这样的 JSON 属性里。
 * 解析失败就抛错（页面改版了），由调用方决定降级。
 */
export async function bingImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`;
  // 图搜是"搜索阶段"，也必须受浏览锁定约束，否则锁定只挡下载不挡搜索，链条断一环
  const { body } = await safeFetch(url, { browseLocked });
  const html = String(body ?? '');
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/m="([^"]+)"/g)) {
    const raw = decodeHtml(m[1]).replace(/&quot;/g, '"');
    let url2 = '';
    try {
      const j = JSON.parse(raw);
      url2 = String(j.murl || j.mediaurl || '').trim();
    } catch {
      // 属性里偶尔不是合法 JSON（被截断），用正则兜一次
      const mm = raw.match(/"murl"\s*:\s*"([^"]+)"/);
      url2 = mm ? mm[1] : '';
    }
    if (!/^https?:\/\//i.test(url2) || seen.has(url2)) continue;
    seen.add(url2);
    out.push({ title: q, url: url2 });
    if (out.length >= Math.max(1, Number(limit) || 8)) break;
  }
  if (!out.length) throw new Error('Bing 图片搜索没解析到结果（页面结构可能已改版）');
  return out;
}

/** 百度图片搜索。百度把直链放在 `objURL`（近年版改成 `thumbURL`/`middleURL`，都能兜）。 */
export async function baiduImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const url = `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(q)}`;
  const { body } = await safeFetch(url, { browseLocked });
  const html = String(body ?? '');
  const out = [];
  const seen = new Set();
  for (const key of ['objURL', 'middleURL', 'thumbURL', 'hoverURL']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g');
    for (const m of html.matchAll(re)) {
      const u = decodeHtml(m[1]).replace(/\\\//g, '/');
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push({ title: q, url: u });
      if (out.length >= Math.max(1, Number(limit) || 8)) break;
    }
    if (out.length >= Math.max(1, Number(limit) || 8)) break;
  }
  if (!out.length) throw new Error('百度图片搜索没解析到结果（页面结构可能已改版）');
  return out;
}

/**
 * 图片搜索入口：按配置的搜索 provider 选源，失败自动换另一个。
 *
 * 为什么"自动换源"很重要：这两家的 HTML 结构都随时可能改版，
 * 只押一个源的话，改版当天功能就整个不可用。
 */
export async function searchImages(query, { limit = 8, browseLocked = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const errors = [];
  // 顺序：百度在前（中文关键词命中率更好），Bing 兜底
  for (const fn of [baiduImageSearch, bingImageSearch]) {
    try {
      const list = await fn(q, { limit: n, browseLocked });
      if (list.length) return list;
    } catch (error) {
      errors.push(`${fn.name}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`图片搜索全部失败 —— ${errors.join('；')}`);
}

