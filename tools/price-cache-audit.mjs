#!/usr/bin/env node
// QQBotB · B48 · 缓存计价折扣率核对（只读诊断器）
//
// 目的：把「api.priceCachedPerM = 0 且 useOfficialPrice = true → 实际单价由远端价格表决定」
//       这件事从「估算」变成「有证据」——本地配置实值 + 远端表地址 + 字段名 + 折扣率。
//
// 三段（全部只读，不 import 任何业务模块）：
//   ① 本地配置：文本解析 app/src/business/config.js 的 DEFAULT_CONFIG 实值；
//      若给出数据根（--data，默认 <repo>/_unpack/data），再读磁盘 config.json 的 api 段实值。
//   ② 远端表口径：从 community.js / config.js 取固定 URL，从 price-feed.js 取载荷外形与条目字段。
//   ③ 折扣率：**只有带 --fetch 才真去拉**——默认不外联，失败收紧。
//
// 用法：
//   node tools/price-cache-audit.mjs                          # 只读本地 + 打印 UNVERIFIED
//   node tools/price-cache-audit.mjs --fetch                  # 真拉远端表并打印折扣率
//   node tools/price-cache-audit.mjs --fetch --model <id>     # 指定模型（默认取本地配置 api.model）
//   node tools/price-cache-audit.mjs --data <数据根>          # 换数据根（默认 _unpack/data）
//
// 判据：默认运行给本地配置实值 + UNVERIFIED；--fetch 拉不到就明示失败原因、不静默回落。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.QQBOTB_ROOT || 'D:/Mau/WorkSpace/QQBotB');
const SRC = path.join(ROOT, 'app/src/business');
const FETCH_TIMEOUT_MS = 15000;

const UNVERIFIED = 'UNVERIFIED（本次未外联取证——远端价格表未拉取，成本看板的折扣率仍属估算）';

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/** 从文本里取 `key: <literal>` 的行（取该行 = 之后到行尾，剥注释）。 */
function pickLiteral(text, key, { numeric = false } = {}) {
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^,\\n]+)', 'm');
  const m = text.match(re);
  if (!m) return { ok: false, raw: null, value: null };
  const raw = m[1].trim().replace(/\/\/.*$/, '').trim();
  if (numeric) {
    const n = Number(raw);
    return { ok: Number.isFinite(n), raw, value: Number.isFinite(n) ? n : null };
  }
  const q = raw.match(/^['"`]([\s\S]*)['"`]$/);
  return { ok: true, raw, value: q ? q[1] : raw };
}

/** ① 代码默认值（config.js DEFAULT_CONFIG.api）。 */
function readCodeDefaults() {
  const text = readSrc('config.js');
  const out = {};
  for (const k of ['priceInputPerM', 'priceOutputPerM', 'priceCachedPerM']) {
    out[k] = pickLiteral(text, k, { numeric: true });
  }
  out.useOfficialPrice = pickLiteral(text, 'useOfficialPrice');
  out.model = pickLiteral(text, 'model');
  return out;
}

/** ① 磁盘实值（数据根 config.json 的 api 段）。 */
function readDiskConfig(dataDir) {
  const fp = path.join(dataDir, 'config.json');
  const res = { path: fp, ok: false, api: null, error: '' };
  try {
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.api = (obj && obj.api) || {};
    res.ok = true;
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

/** ② 远端表口径（URL + 载荷外形 + 条目字段）。 */
function readRemoteSpec() {
  const out = { url: null, urlSource: '', shapes: [], fields: [], notes: [], warnings: [] };
  try {
    const cfg = readSrc('config.js');
    const m = cfg.match(/FIXED_PRICE_REMOTE_URL\s*=\s*['"`]([^'"`]+)['"`]/);
    if (m) { out.url = m[1]; out.urlSource = 'config.js FIXED_PRICE_REMOTE_URL'; }
  } catch (e) { out.warnings.push(`读不到 config.js：${e.message}`); }
  try {
    const com = readSrc('community.js');
    const m = com.match(/FIXED_PRICE_FEED_URL\s*=\s*FIXED_PRICE_REMOTE_URL|FIXED_PRICE_FEED_URL\s*=\s*['"`]([^'"`]+)['"`]/);
    if (m) out.notes.push('community.js:7 FIXED_PRICE_FEED_URL = config.FIXED_PRICE_REMOTE_URL（同源别名）');
  } catch (e) { out.warnings.push(`读不到 community.js：${e.message}`); }
  try {
    const pf = readSrc('price-feed.js');
    // 载荷四种外形（注释块里的示例）
    const shapes = pf.match(/^\s*\/\/\s*(\{[^\n]*\}|\[[^\n]*\])\s*$/gm) || [];
    out.shapes = shapes.map((s) => s.replace(/^\s*\/\/\s*/, '').trim()).slice(0, 6);
    const fm = pf.match(/条目字段：([^\n]+)/);
    if (fm) out.fields = fm[1].split(/[，,、]/).map((s) => s.trim()).filter(Boolean);
    if (!/in\/out\s*必填/i.test(pf)) out.warnings.push('price-feed.js 里找不到「in/out 必填」的字段说明——字段面可能已变');
  } catch (e) { out.warnings.push(`读不到 price-feed.js：${e.message}`); }
  return out;
}

/** 本地磁盘价格表缓存（只读——证明「上次拉到过什么」，不当作本次取证）。 */
function readDiskCache(dataDir, url) {
  const fp = path.join(dataDir, 'price-feed-cache.json');
  try {
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const sameUrl = !url || obj.url === url;
    const prices = (obj.prices && typeof obj.prices === 'object') ? obj.prices : {};
    return {
      path: fp, ok: true, sameUrl, url: obj.url || '', fetchedAt: obj.fetchedAt || 0,
      count: Object.keys(prices).length, prices,
    };
  } catch (e) {
    return { path: fp, ok: false, error: e.message };
  }
}

/** 远端载荷 → { id: {in,out,cached} }（与 price-feed.js normalizePriceFeed 同口径，独立实现）。 */
function normalizePayload(data) {
  if (!data || typeof data !== 'object') return { prices: {}, dropped: 0, error: '响应不是对象' };
  let pairs = [];
  if (Array.isArray(data)) pairs = data.map((x) => [x?.id, x]);
  else if (Array.isArray(data.prices)) pairs = data.prices.map((x) => [x?.id, x]);
  else if (data.prices && typeof data.prices === 'object') pairs = Object.entries(data.prices);
  else pairs = Object.entries(data).filter(([k]) => !/^(updated|version|meta|comment)$/i.test(k));
  const prices = {};
  let dropped = 0;
  for (const [id, v] of pairs) {
    const key = String(id ?? '').trim().toLowerCase();
    const i = Number(v?.in), o = Number(v?.out);
    if (!key || !v || typeof v !== 'object' || (!Number.isFinite(i) && !Number.isFinite(o))) { dropped++; continue; }
    prices[key] = {
      in: Number.isFinite(i) ? i : 0,
      out: Number.isFinite(o) ? o : 0,
      cached: v.cached == null ? null : (Number.isFinite(Number(v.cached)) ? Number(v.cached) : null),
    };
  }
  return { prices, dropped, error: '' };
}

/** 模型 id → 价格条目：精确 → 去 provider 前缀 → 前缀匹配（model-prices.js:301-321 同口径）。 */
function matchModel(prices, modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return null;
  if (prices[raw]) return { key: raw, entry: prices[raw], how: '精确' };
  const bare = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (bare !== raw && prices[bare]) return { key: bare, entry: prices[bare], how: '去 provider 前缀' };
  let best = null;
  for (const key of Object.keys(prices)) {
    if (bare === key || bare.startsWith(key + '/') || bare.startsWith(key + '-') || bare.startsWith(key + '@') || bare.startsWith(key + ':')) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? { key: best, entry: prices[best], how: '前缀匹配' } : null;
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function discount(entry) {
  if (!entry || !entry.in) return null;
  const c = entry.cached == null ? entry.in : entry.cached;
  return c / entry.in;
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  const dataDir = path.resolve(valOf('--data') || path.join(ROOT, '_unpack/data'));
  const doFetch = has('--fetch');
  const code = readCodeDefaults();
  const disk = readDiskConfig(dataDir);
  const spec = readRemoteSpec();
  const cache = readDiskCache(dataDir, spec.url);

  const api = disk.ok ? disk.api : {};
  const diskVal = (k) => (api[k] === undefined ? null : api[k]);
  const configuredModel = valOf('--model') || diskVal('model') || (code.model.value || '');

  const L = [];
  L.push('🔍 缓存计价折扣率核对 · B48');
  L.push('');
  L.push('① 本地配置（只读文本解析 / 磁盘 json 直读）');
  L.push('   | 键 | 代码默认（config.js DEFAULT_CONFIG） | 磁盘实值（数据根 config.json） |');
  L.push('   |:--|--:|--:|');
  const rows = [
    ['api.priceInputPerM', code.priceInputPerM, diskVal('priceInputPerM')],
    ['api.priceOutputPerM', code.priceOutputPerM, diskVal('priceOutputPerM')],
    ['api.priceCachedPerM', code.priceCachedPerM, diskVal('priceCachedPerM')],
    ['api.useOfficialPrice', code.useOfficialPrice, diskVal('useOfficialPrice')],
    ['api.model', code.model, diskVal('model')],
  ];
  for (const [k, c, d] of rows) {
    const cs = c && c.ok ? (c.raw === null ? '—' : String(c.value)) : '（未取到）';
    const ds = disk.ok ? (d === null ? '（缺键）' : String(d)) : '（读不到）';
    L.push(`   | ${k} | ${cs} | ${ds} |`);
  }
  L.push(`   数据根：${dataDir}${disk.ok ? '' : `  ⚠️ 读不到 config.json：${disk.error}`}`);
  L.push('');
  const cachedPerM = diskVal('priceCachedPerM');
  const useOfficial = diskVal('useOfficialPrice');
  const manualIn = diskVal('priceInputPerM');
  const affect = [];
  if (useOfficial === true) affect.push('useOfficialPrice=true → 单价走官方/远端价格表（手动单价被忽略）');
  if (cachedPerM === 0) affect.push('priceCachedPerM=0 → manual 分支里也会回落成 priceInputPerM（无缓存折扣）');
  if (useOfficial === true && cachedPerM === 0) affect.push('结论：真实单价 = 远端价格表条目（in/out/cached），本地这两个值都不参与计价');
  L.push('   ' + (affect.length ? affect.join('\n   ') : '本地配置未落入「远端表决定单价」的组合'));
  L.push('');
  L.push('② 远端价格表口径（只读代码文本）');
  L.push(`   URL：${spec.url || '（未取到）'}${spec.urlSource ? `　来源 ${spec.urlSource}` : ''}`);
  if (spec.notes.length) for (const n of spec.notes) L.push(`   · ${n}`);
  if (spec.fields.length) L.push(`   条目字段：${spec.fields.join(' / ')}`);
  if (spec.shapes.length) {
    L.push('   载荷外形（price-feed.js 声明，四种兼容）：');
    for (const s of spec.shapes) L.push(`     ${s}`);
  }
  L.push('   计价式（llm.js estimateCost）：fresh×in + cached×cached + out×out（元/百万 token）');
  L.push(`   当前模型：${configuredModel || '（未取到）'}`);
  if (spec.warnings.length) for (const w of spec.warnings) L.push(`   ⚠️ ${w}`);
  L.push('');

  L.push('③ 磁盘价格表缓存（只读参考——证明上次拉到过什么，不是本次取证）');
  if (!cache.ok) {
    L.push(`   ⚠️ 读不到 ${cache.path}：${cache.error}`);
  } else {
    const when = cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : '（无时间）';
    L.push(`   ${cache.path}`);
    L.push(`   url ${cache.url || '（空）'}${cache.sameUrl ? '' : '  ⚠️ 与代码固定 URL 不一致（缓存不会被采用）'} · 条目 ${cache.count} · fetchedAt ${when}`);
    const hit = matchModel(cache.prices, configuredModel);
    if (hit) {
      const d = discount(hit.entry);
      L.push(`   当前模型命中缓存表：${hit.key}（${hit.how}）in ${fmt(hit.entry.in)} / cached ${hit.entry.cached == null ? '（null→按 in 计）' : fmt(hit.entry.cached)} / out ${fmt(hit.entry.out)} → 折扣率 ${d == null ? '—' : (d * 100).toFixed(2) + '%'}`);
    } else {
      L.push(`   当前模型未在缓存表命中（表里 ${Object.keys(cache.prices).length} 条）`);
    }
  }
  L.push('');

  if (!doFetch) {
    L.push('④ 结论');
    L.push(`   ${UNVERIFIED}`);
    L.push('   要取证：加 --fetch（默认不外联，失败即报错不回落）。');
    console.log(L.join('\n'));
    return 0;
  }

  if (!spec.url) {
    console.error('❌ --fetch 失败：代码里未取到固定价格表 URL，不发请求（不猜地址）');
    return 1;
  }
  return fetchAndReport(spec, configuredModel, L);
}

async function fetchAndReport(spec, configuredModel, head) {
  const L = head.slice();
  L.push('④ 远端取证（--fetch）');
  let res = null;
  let raw = null;
  const t0 = Date.now();
  try {
    res = await fetch(spec.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(L.join('\n'));
      console.error(`❌ --fetch 失败：HTTP ${res.status} ${res.statusText}（${spec.url}，${Date.now() - t0} ms）——未取证，不回落本地估算`);
      return 1;
    }
    raw = await res.text();
  } catch (e) {
    console.error(L.join('\n'));
    const reason = e?.cause?.message || e?.message || String(e);
    console.error(`❌ --fetch 失败：${reason}（${spec.url}，${Date.now() - t0} ms）——网络/证书/超时，未取证，不回落本地估算`);
    return 1;
  }

  let data = null;
  try { data = JSON.parse(raw); } catch (e) {
    console.error(L.join('\n'));
    console.error(`❌ --fetch 失败：返回的不是合法 JSON（${e.message}，${raw.length} 字符）——未取证`);
    return 1;
  }
  const norm = normalizePayload(data);
  const ids = Object.keys(norm.prices);
  if (!ids.length) {
    console.error(L.join('\n'));
    console.error(`❌ --fetch 失败：JSON 里没有可用价格条目（dropped ${norm.dropped}${norm.error ? '，' + norm.error : ''}）——未取证`);
    return 1;
  }
  const ms = Date.now() - t0;
  L.push(`   HTTP ${res.status} · ${spec.url} · ${raw.length} 字符 · ${ids.length} 条（丢弃 ${norm.dropped}）· ${ms} ms`);
  if (spec.url.startsWith('https:')) L.push('   注意：https 下的内容由 kondius.cn 决定，与本机代码版本无关');
  L.push('');
  L.push('   | 模型 | 输入价 in | 缓存价 cached | 输出价 out | 折扣率 cached/in |');
  L.push('   |:--|--:|--:|--:|--:|');
  const show = ids.sort();
  for (const id of show) {
    const e = norm.prices[id];
    const d = discount(e);
    const c = e.cached == null ? 'null（按 in 计）' : fmt(e.cached);
    L.push(`   | ${id} | ${fmt(e.in)} | ${c} | ${fmt(e.out)} | ${d == null ? '—' : (d * 100).toFixed(2) + '%'} |`);
  }
  if (!show.includes(String(configuredModel || '').toLowerCase())) {
    const hit = matchModel(norm.prices, configuredModel);
    L.push('');
    if (hit) {
      const d = discount(hit.entry);
      L.push(`   当前模型 ${configuredModel} → ${hit.key}（${hit.how}）：in ${fmt(hit.entry.in)} / cached ${hit.entry.cached == null ? 'null（按 in 计）' : fmt(hit.entry.cached)} / out ${fmt(hit.entry.out)} → 折扣率 ${d == null ? '—' : (d * 100).toFixed(2) + '%'}`);
    } else {
      L.push(`   ⚠️ 当前模型 ${configuredModel} 在这张远端表里**查不到**。`);
      L.push('      兜底口径（R3-7 已修）：内置表 OFFICIAL_PRICES 里有显式条目 → setRemotePrices 合并时内置条目保留 →');
      L.push('      resolveModelPrice 仍能命中（source=official），成本看板不再是 0。真·远端命中与否只影响是否走中转站实价。');
    }
  }
  L.push('');
  L.push('   取证完成：以上为远端表实值。UNVERIFIED 解除——但请注意这是**表价**，中转站实收价可能不同（model-prices.js 头注释 ⚠️）。');
  console.log(L.join('\n'));
  return 0;
}

process.exitCode = await main();
