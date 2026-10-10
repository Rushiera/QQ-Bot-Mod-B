// cdp-browser.js —— CDP 浏览器服务（QQBot mod B 卫星 · browser-* 工具后端）
//
// 形态：Chromium 系内核 headless（Edge / Chrome / Brave）+ 裸 CDP（ws + node:http，零第三方 CDP 库）。
// 🔴 换内核 = 改配置 browser.kernelPath —— Chromium 系协议同为 CDP，无协议分支
//    （Firefox / WebKit 不支持 CDP，需另写实现）；留空时按常见安装路径自动探测。
// 每会话独立实例：<browserDataDir>/<chatKey>/profile（user-data-dir，持久）+ out（产物）。
// 🔴 browserDataDir 默认 %LOCALAPPDATA%\QQAgent\browser —— 必须落 NTFS：exFAT 卷上
//    Chromium 的 user-data-dir 起不来（CDP 连接 20s+，导航全挂）；配置 browser.dataDir 可改。
// 生命周期域级 —— 首次调用懒启动，timeback back 回收即关（closeChat）；另有空闲兜底（idleCloseMs）。
// 域门禁（仅 timeback 作用域内可用）由工具层判定（见 cat-tools.js），本服务不重复判定。
// 同会话调用串行（promise 链），跨会话互不干扰。
//
// 移植来源：CH4 宿主 CdpBrowserService.cs（同一套语义：懒启动 / 每会话实例 / 域级回收）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { getConfig } from './config.js';
import { checkBrowseLock } from './safe-fetch.js';

/** 启动超时 —— 等 DevToolsActivePort 出现（机器负载重时内核启动可达 20~30 秒） */
const BOOT_TIMEOUT_MS = 60000;
/** 导航超时 —— 等 document.readyState = complete */
const NAV_TIMEOUT_MS = 20000;
/** 单条 CDP 指令超时（防单条指令挂死拖住整轮） */
const CDP_TIMEOUT_MS = 20000;
/** 网络面熔断时长 —— 命中后这段时间内直接快速失败，不再起内核白等 */
const NETWORK_BREAKER_MS = 10 * 60 * 1000;
/** 加载静默期 —— 可读状态后再等一拍，兜住 SPA 挂载与首屏渲染尾巴 */
const SETTLE_MS = 600;
/** 视口 —— Emulation 覆盖用 */
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
/** 读取落盘阈值：超过就写文件只回预览（省 token） */
const MAX_INLINE_CHARS = 12000;
/** 预览字符数 */
const PREVIEW_CHARS = 1200;
/** 链接清单上限 */
const LINK_LIMIT = 60;
/** 无障碍树节点上限 */
const AX_NODE_LIMIT = 300;
/** eval 结果直返上限（超出落盘） */
const INLINE_EVAL_CHARS = 4096;
/** 空闲回收 —— 超过该时长无调用即自动关实例（timeback 忘了 back 也不留孤儿进程） */
const IDLE_CLOSE_MS = 10 * 60 * 1000;
/** 有头窗口的空闲回收 —— 它等的是人的动作（登录 / 过验证），阈值放宽 */
const HEADFUL_IDLE_CLOSE_MS = 30 * 60 * 1000;
/** 实例清理巡检间隔 */
const SWEEP_MS = 60 * 1000;

/** Chromium 系内核候选路径（Windows 常见安装位；首个存在的即用） */
const KERNEL_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
];

/** 目录名净化 —— chatKey 形如 `group:123456`，冒号在 Windows 路径里非法 */
function safeDirName(chatKey) {
  return String(chatKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 探测内核路径（配置优先；配置空则按候选表探测；都没有返回空串） */
export function resolveKernelPath() {
  const configured = String(getConfig()?.browser?.kernelPath || '').trim();
  if (configured) return configured;
  for (const p of KERNEL_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* 单个候选探测失败不影响其余 */ }
  }
  return '';
}

/**
 * 浏览器数据目录（profile + 产物）根。
 * 🔴 默认落系统本地应用数据（NTFS），**不跟应用数据目录走**——exFAT 卷上 Chromium 的
 *    user-data-dir 起不来：内核 CDP 连接耗时 20s+，一切导航挂死（实测 D 盘 exFAT 超时 /
 *    C 盘 NTFS 697ms 通过）。配置 browser.dataDir 可指定别处（同样须 NTFS）。
 */
export function resolveBrowserDataDir() {
  const configured = String(getConfig()?.browser?.dataDir || '').trim();
  if (configured) return configured;
  const base = process.env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'QQAgent', 'browser');
}

/** 单条 CDP 指令超时包装 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 裸 CDP 连接 —— JSON-RPC over WebSocket。
 * 只做三件事：发指令（带 sessionId）、等事件、关连接；不解析任何 DOM 语义。
 */
class CdpConnection {
  constructor(ws, log) {
    this._ws = ws;
    this._log = log;
    this._seq = 0;
    this._pending = new Map();     // id -> { resolve, reject, method }
    this._waiters = [];            // { method, sessionId, resolve, reject, timer }
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', () => this.#failAll(new Error('CDP 连接已关闭')));
    ws.on('error', (error) => this.#failAll(error));
  }

  /** 建立连接（等 open） */
  static connect(wsUrl, log, timeoutMs = BOOT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error(`CDP 连接超时（${timeoutMs}ms）：${wsUrl}`));
      }, timeoutMs);
      ws.once('open', () => { clearTimeout(timer); resolve(new CdpConnection(ws, log)); });
      ws.once('error', (error) => { clearTimeout(timer); reject(new Error(`CDP 连接失败：${error?.message ?? error}`)); });
    });
  }

  #onMessage(raw) {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${p.method} 失败：${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (let i = this._waiters.length - 1; i >= 0; i -= 1) {
      const w = this._waiters[i];
      if (w.method !== msg.method) continue;
      if (w.sessionId && msg.sessionId && w.sessionId !== msg.sessionId) continue;
      this._waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg.params ?? {});
    }
  }

  #failAll(error) {
    for (const [, p] of this._pending) p.reject(error);
    this._pending.clear();
    for (const w of this._waiters) { clearTimeout(w.timer); w.reject(error); }
    this._waiters.length = 0;
  }

  /** 发一条 CDP 指令（sessionId 空 = 浏览器级） */
  send(method, params = {}, sessionId = null, timeoutMs = CDP_TIMEOUT_MS) {
    const id = ++this._seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
    });
    try { this._ws.send(JSON.stringify(payload)); }
    catch (error) { this._pending.delete(id); return Promise.reject(error); }
    return withTimeout(promise, timeoutMs, `CDP ${method}`);
  }

  /** 等一个 CDP 事件（sessionId 空 = 不筛会话） */
  once(method, sessionId = null, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`等事件超时：${method}`));
      }, timeoutMs);
      this._waiters.push({ method, sessionId, resolve, reject, timer });
    });
  }

  close() {
    this.#failAll(new Error('CDP 连接已关闭'));
    try { this._ws.close(); } catch { /* ignore */ }
  }
}

/** 睡眠 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 杀进程树（Windows：内核会 fork 出多个渲染进程，只 kill 主进程会留孤儿） */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) { resolve(); return; }
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('exit', () => resolve());
      k.on('error', () => resolve());
    } catch { resolve(); }
  });
}

/** 导航地址白名单 —— 只放行 http(s)（与 CH4 同口径：浏览器只上网页） */
function assertNavigableUrl(raw) {
  let url = null;
  try { url = new URL(String(raw ?? '').trim()); }
  catch { throw new Error('URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http(s) 地址');
  return url.toString();
}

/** 截断到 n 字符（按码点，避免切碎代理对） */
function cut(text, n) {
  const s = String(text ?? '');
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

/** 风控 / 人机验证页特征 —— 命中即「被挡」：不是站点取不到，是自动化特征被识别，换通道即可 */
const CHALLENGE_MARKS = [
  '正在进行安全验证', '请稍候', 'Just a moment', 'Attention Required',
  'Verify you are human', '验证您是真人', 'Enable JavaScript and cookies to continue',
  'cf-browser-verification', 'Checking your browser'
];

/** 判断当前页是否风控挑战页（标题 + 正文前 400 字） */
function isChallengePage(title, body) {
  const t = `${title}\n${body}`;
  return CHALLENGE_MARKS.some((m) => t.includes(m));
}

/**
 * 单会话浏览器实例 —— 一次 headless 内核进程 + 一个 CDP 连接 + 若干页签。
 * 指令串行（run()），保证同一会话的 browser-* 调用不互相踩。
 */
class CatBrowser {
  constructor({ chatKey, kernelPath, baseDir, log }) {
    this.chatKey = chatKey;
    this.kernelPath = kernelPath;
    this.baseDir = baseDir;
    this.profileDir = path.join(baseDir, 'profile');
    this.outDir = path.join(baseDir, 'out');
    this.log = log;
    this.proc = null;
    this.conn = null;
    this.pageSession = null;    // 当前页签的 CDP sessionId
    this.pageTarget = null;     // 当前页签的 targetId
    this.lastUsedAt = Date.now();
    this._chain = Promise.resolve();
    this._shotSeq = 0;
    // 有头模式标记 —— browser-headful 起的窗口（人工登录用）；不连 CDP，close 即杀进程树
    this.headful = false;
    // 对齐后的 UA 串（去 headless 标记）—— 懒取一次，本实例全部页签共用
    this.realUserAgent = '';
    // 网络面健康标记 —— 本机若拦截 Chromium 网络栈，内核会打印
    // "Network service crashed"，此后一切 http 导航都会挂死。捕获到就熔断（见 service 层）。
    this.networkDead = false;
    this.onNetworkDead = null;
    this.stderrTail = [];
  }

  /** 同会话串行队列 —— 上一条失败不阻断下一条 */
  run(fn) {
    const next = this._chain.then(() => fn());
    this._chain = next.then(() => {}, () => {});
    return next;
  }

  get alive() {
    // 有头实例不连 CDP —— 存活判据只看进程
    if (this.headful) return Boolean(this.proc) && this.proc.exitCode === null;
    return Boolean(this.conn) && Boolean(this.proc) && this.proc.exitCode === null;
  }

  /**
   * 起有头窗口（人工登录用）——同 profile 单例：先 close 旧实例（无头 / 有头都关）。
   * 不连 CDP（登录是人工动作，无自动化需求）；窗口可见；登录态由 profile 落盘保留，
   * 之后无头实例复用同一 profile 即带上登录态（免登录）。
   */
  async headfulOpen(rawUrl) {
    await this.close();
    if (!this.kernelPath) throw new Error('未找到 Chromium 系内核（设置 browser.kernelPath，或安装 Edge / Chrome）');
    if (!fs.existsSync(this.kernelPath)) throw new Error(`浏览器内核不存在：${this.kernelPath}`);
    const url = rawUrl ? assertNavigableUrl(rawUrl) : '';
    if (url) {
      const lock = checkBrowseLock(url);
      if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.headful = true;
    this.lastUsedAt = Date.now();
    this.proc = spawn(this.kernelPath, [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      url || 'about:blank'
    ], { stdio: 'ignore', windowsHide: false });
    this.proc.on('exit', () => { this.conn = null; this.pageSession = null; this.pageTarget = null; });
    // 有头实例不连 CDP —— 等一拍确认进程没当场退出即视为窗口已弹出
    await sleep(2000);
    if (this.proc.exitCode !== null) {
      this.headful = false;
      throw new Error(`有头窗口启动即退出（exit=${this.proc.exitCode}）——内核：${this.kernelPath}`);
    }
    return { url };
  }

  /** 懒启动：内核进程 → 等 DevToolsActivePort → 连 CDP → 开首个页签 */
  async ensureStarted() {
    this.lastUsedAt = Date.now();
    if (this.alive && this.pageSession) return;
    if (!this.kernelPath) throw new Error('未找到 Chromium 系内核（设置 browser.kernelPath，或安装 Edge / Chrome）');
    if (!fs.existsSync(this.kernelPath)) throw new Error(`浏览器内核不存在：${this.kernelPath}`);
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.outDir, { recursive: true });
    // 残留的 DevToolsActivePort 会让下面的等待读到旧端口 —— 先清掉
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }

    this.proc = spawn(this.kernelPath, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    // 内核 stderr 收口：既避免管道写满卡住子进程，也用来识别"网络服务崩溃"这一环境级故障。
    // 触发条件与 profile 卷无关——经验上最常见的是 user-data-dir 落 exFAT 卷（见 resolveBrowserDataDir）。
    try {
      this.proc.stderr.on('data', (chunk) => {
        const text = String(chunk);
        this.stderrTail.push(text);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        if (!this.networkDead && /Network service crashed/i.test(text)) {
          this.networkDead = true;
          if (typeof this.onNetworkDead === 'function') this.onNetworkDead();
        }
      });
    } catch { /* stderr 收口失败不阻断 */ }
    this.proc.on('exit', () => { this.conn = null; this.pageSession = null; this.pageTarget = null; });

    // 等 DevToolsActivePort（首行 = 端口；次行 = 浏览器级 ws 路径）
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let port = 0;
    let wsPath = '';
    while (Date.now() < deadline) {
      try {
        const text = fs.readFileSync(portFile, 'utf8');
        const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length >= 2) { port = Number(lines[0]); wsPath = lines[1]; break; }
      } catch { /* 还没写出来 —— 继续等 */ }
      if (this.proc.exitCode !== null) throw new Error(`浏览器内核启动即退出（exit=${this.proc.exitCode}）`);
      await sleep(200);
    }
    if (!port || !wsPath) {
      await this.close();
      throw new Error(`浏览器内核启动超时（${BOOT_TIMEOUT_MS}ms）——内核：${this.kernelPath}`);
    }
    this.conn = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`, this.log);
    // 首个页签：复用启动参数里的 about:blank（内核已开一个），找不到就新建
    const targets = await this.conn.send('Target.getTargets', {});
    const page = (targets.targetInfos || []).find((t) => t.type === 'page');
    const targetId = page ? page.targetId : (await this.conn.send('Target.createTarget', { url: 'about:blank' })).targetId;
    await this.#attach(targetId);
  }

  /** 挂载页签 —— 取 sessionId + 开 Page 域 + 固定视口 */
  async #attach(targetId) {
    const r = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = r.sessionId;
    if (!sessionId) throw new Error('CDP 挂载页签失败（无 sessionId）');
    await this.conn.send('Page.enable', {}, sessionId);
    try {
      await this.conn.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false
      }, sessionId);
    } catch { /* 视口覆盖失败不阻断（部分内核版本不支持） */ }
    // UA 对齐 —— headless 内核的 UA 串带 "HeadlessChrome" 标记，风控（Cloudflare 等）据此判自动化；
    // 且 cf_clearance 一类凭据按 UA 签发：有头窗口人工过验证后，无头 UA 不一致即复用失效。
    try {
      await this.#applyUserAgent(sessionId);
    } catch (error) {
      this.log(`[browser] UA 对齐失败（不阻断）：${error?.message ?? error}`);
    }
    this.pageTarget = targetId;
    this.pageSession = sessionId;
    return sessionId;
  }

  /**
   * UA 对齐 —— 取内核真实 UA 串，去掉 "HeadlessChrome" 标记后覆盖本页签。
   * 只去 headless 特征（同内核、同版本、同平台），不改品牌与版本号：
   * 这样无头实例与有头窗口的 UA 完全一致，人工过验证留下的 cf_clearance 才能被复用。
   */
  async #applyUserAgent(sessionId) {
    if (!this.realUserAgent) {
      const v = await this.conn.send('Browser.getVersion', {});
      const raw = String(v?.userAgent || '');
      if (!raw) return;
      this.realUserAgent = raw.replace(/HeadlessChrome/g, 'Chrome');
    }
    await this.conn.send('Emulation.setUserAgentOverride', {
      userAgent: this.realUserAgent,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'Win32'
    }, sessionId);
  }

  /** 打开网页并等加载完成 */
  async navigate(rawUrl) {
    const url = assertNavigableUrl(rawUrl);
    const lock = checkBrowseLock(url);
    if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
    await this.ensureStarted();
    const s = this.pageSession;
    const t0 = Date.now();
    const loaded = this.conn.once('Page.loadEventFired', s, NAV_TIMEOUT_MS).catch(() => null);
    let r = null;
    try {
      r = await this.conn.send('Page.navigate', { url }, s, NAV_TIMEOUT_MS);
    } catch (error) {
      // 导航超时 = 网络面不工作（内核网络服务无响应，一切 http 请求挂死）。
      // 标记熔断，避免后续每次调用都白等一个超时。
      if (/超时/.test(String(error?.message || ''))) {
        this.networkDead = true;
        if (typeof this.onNetworkDead === 'function') this.onNetworkDead();
        throw new Error('浏览器网络面不可用（导航超时 —— 内核网络服务无响应）。'
          + '改用 web_fetch / web_search 取网页内容；本次不再重试浏览器。');
      }
      throw error;
    }
    if (r.errorText) throw new Error(`导航失败：${r.errorText}`);
    await loaded;
    await sleep(SETTLE_MS);
    const info = await this.#evaluate(`({ title: document.title || '', url: location.href, status: document.readyState, body: (document.body ? document.body.innerText : '').slice(0, 400) })`);
    const title = String(info?.title || '');
    const body = String(info?.body || '');
    return {
      title,
      url: String(info?.url || url),
      readyState: String(info?.status || ''),
      challenge: isChallengePage(title, body),
      ms: Date.now() - t0
    };
  }

  /** 取当前页正文文本 */
  async readText() {
    await this.ensureStarted();
    const text = await this.#evaluate('(document.body ? document.body.innerText : document.documentElement.innerText) || ""');
    const body = String(text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) return { text: '（页面没有可读正文 —— 可能是空页 / 纯脚本页 / 需要交互后才渲染）', chars: 0, path: '' };
    if (body.length > MAX_INLINE_CHARS) {
      const file = this.#outPath('text', 'txt');
      fs.writeFileSync(file, body, 'utf8');
      return { text: cut(body, PREVIEW_CHARS), chars: body.length, path: file, truncated: true };
    }
    return { text: body, chars: body.length, path: '' };
  }

  /** 取可导航链接清单 */
  async readLinks() {
    await this.ensureStarted();
    const list = await this.#evaluate(`Array.from(document.querySelectorAll('a[href]')).map(function (a) {
      return { t: (a.innerText || a.title || '').trim().slice(0, 80), h: a.href };
    })`);
    const rows = Array.isArray(list) ? list : [];
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const h = String(r?.h || '');
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push({ text: String(r?.t || ''), url: h });
      if (out.length >= LINK_LIMIT) break;
    }
    return out;
  }

  /** 取无障碍树精简（控件与结构） */
  async readAx() {
    await this.ensureStarted();
    const s = this.pageSession;
    await this.conn.send('Accessibility.enable', {}, s);
    const tree = await this.conn.send('Accessibility.getFullAXTree', {}, s);
    const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    const byId = new Map();
    for (const n of nodes) byId.set(n.nodeId, n);
    const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'StaticText'.toLowerCase()]);
    const lines = [];
    const walk = (node, depth) => {
      if (!node || lines.length >= AX_NODE_LIMIT) return;
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '').trim();
      const ignored = node.ignored === true;
      const keep = !ignored && name && !SKIP_ROLES.has(role) && role !== 'none';
      if (keep) lines.push(`${'  '.repeat(Math.min(depth, 8))}${role}${name ? `：${cut(name, 100)}` : ''}`);
      const next = keep ? depth + 1 : depth;
      for (const cid of node.childIds || []) walk(byId.get(cid), next);
    };
    walk(nodes[0], 0);
    return lines.length ? lines.join('\n') : '（无障碍树为空）';
  }

  /** 执行 JS 表达式并取回结果 */
  async evaluate(expression) {
    await this.ensureStarted();
    const value = await this.#evaluate(String(expression ?? ''));
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 1);
    if (text.length > INLINE_EVAL_CHARS) {
      const file = this.#outPath('eval', 'txt');
      fs.writeFileSync(file, text, 'utf8');
      return { text: cut(text, INLINE_EVAL_CHARS), chars: text.length, path: file, truncated: true };
    }
    return { text, chars: text.length, path: '' };
  }

  /** 截图当前页（full = 整页） */
  async screenshot(full) {
    await this.ensureStarted();
    const r = await this.conn.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: full === true
    }, this.pageSession, 60000);
    const data = String(r.data || '');
    if (!data) throw new Error('截图失败（内核未返回图像数据）');
    const file = this.#outPath(full === true ? 'full' : 'shot', 'png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /** 页签管理 */
  async tabs(action, target, url) {
    const act = String(action || 'list').trim() || 'list';
    await this.ensureStarted();
    const listPages = async () => {
      const r = await this.conn.send('Target.getTargets', {});
      return (r.targetInfos || []).filter((t) => t.type === 'page');
    };
    if (act === 'list') {
      const pages = await listPages();
      const rows = pages.map((p, i) => `${p.targetId === this.pageTarget ? '*' : ' '}${i + 1}. ${p.targetId} | ${cut(p.title || '', 40)} | ${cut(p.url || '', 80)}`);
      return { action: 'list', current: this.pageTarget, tabs: rows, raw: pages.map((p) => ({ id: p.targetId, title: p.title, url: p.url })) };
    }
    if (act === 'new') {
      const targetUrl = url ? assertNavigableUrl(url) : 'about:blank';
      const r = await this.conn.send('Target.createTarget', { url: targetUrl });
      await this.#attach(r.targetId);
      if (targetUrl !== 'about:blank') await this.navigate(targetUrl);
      return { action: 'new', current: this.pageTarget, url: targetUrl };
    }
    if (act === 'select') {
      const pages = await listPages();
      const hit = pages.find((p) => p.targetId === String(target || '').trim())
        || pages[Number(target) - 1];
      if (!hit) throw new Error(`找不到页签：${target}（先用 action=list 取 id）`);
      await this.#attach(hit.targetId);
      return { action: 'select', current: this.pageTarget, title: hit.title, url: hit.url };
    }
    if (act === 'close') {
      const pages = await listPages();
      const hit = pages.find((p) => p.targetId === String(target || '').trim())
        || pages[Number(target) - 1];
      if (!hit) throw new Error(`找不到页签：${target}（先用 action=list 取 id）`);
      await this.conn.send('Target.closeTarget', { targetId: hit.targetId });
      if (hit.targetId === this.pageTarget) {
        const rest = (await listPages()).filter((p) => p.targetId !== hit.targetId);
        if (rest.length) await this.#attach(rest[0].targetId);
        else {
          const r = await this.conn.send('Target.createTarget', { url: 'about:blank' });
          await this.#attach(r.targetId);
        }
      }
      return { action: 'close', closed: hit.targetId, current: this.pageTarget };
    }
    throw new Error(`未知页签动作：${act}（支持 list / new / select / close）`);
  }

  /**
   * 关闭实例 —— 有头窗口先走 CDP `Browser.close` 优雅退出，再兜底杀进程树。
   * 🔴 有头必须优雅：强杀（killTree）时 Chromium 来不及 flush profile，
   *    人工刚过的验证凭据（cf_clearance 一类 cookie）就丢了——表现为「每次都要重新验证」。
   */
  async close() {
    const proc = this.proc;
    const wasHeadful = this.headful;
    this.headful = false;
    this.proc = null;
    if (this.conn) { this.conn.close(); this.conn = null; }
    this.pageSession = null;
    this.pageTarget = null;
    if (!proc || proc.exitCode !== null) return;
    if (wasHeadful) await this.#gracefulClose(proc);
    if (proc.exitCode === null) {
      try { proc.kill(); } catch { /* ignore */ }
      await killTree(proc.pid);
    }
  }

  /** 有头窗口的优雅关闭 —— 借 profile 的 DevToolsActivePort 连 CDP 发 Browser.close，等进程自己退 */
  async #gracefulClose(proc) {
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    let port = 0;
    let wsPath = '';
    for (let i = 0; i < 20; i = i + 1) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines.length >= 2) { port = Number(lines[0]); wsPath = lines[1]; break; }
      } catch { /* 端口还没写出来 —— 继续等 */ }
      if (proc.exitCode !== null) return;
      await sleep(150);
    }
    if (!port || !wsPath) return;
    let conn = null;
    try {
      conn = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`, this.log);
      await conn.send('Browser.close', {});
    } catch { /* 关闭指令失败 —— 落回强杀 */ } finally {
      if (conn) { try { conn.close(); } catch { /* ignore */ } }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && proc.exitCode === null) await sleep(100);
  }

  /** 退出钩子用（同步尽力而为） */
  killNow() {
    try { if (this.proc && this.proc.exitCode === null) this.proc.kill(); } catch { /* ignore */ }
    try { if (this.conn) this.conn.close(); } catch { /* ignore */ }
  }

  /** Runtime.evaluate 内核（含"表达式 → 函数体"降级） */
  async #evaluate(expression) {
    const s = this.pageSession;
    const attempt = async (expr) => {
      const r = await this.conn.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      }, s, CDP_TIMEOUT_MS);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const text = d.exception?.description || d.text || '执行异常';
        const err = new Error(text);
        err.cdpSyntax = /SyntaxError|Illegal return/i.test(String(text));
        throw err;
      }
      return r.result ? r.result.value : undefined;
    };
    try {
      return await attempt(expression);
    } catch (error) {
      // 模型常写 `return ...` 形态的语句块 —— 自动包一层函数再试一次
      if (!error?.cdpSyntax) throw error;
      return attempt(`(function(){ ${expression} })()`);
    }
  }

  /** 产物路径 */
  #outPath(kind, ext) {
    this._shotSeq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return path.join(this.outDir, `${kind}-${stamp}-${this._shotSeq}.${ext}`);
  }
}

/**
 * 浏览器服务 —— 每会话一个实例（懒启动），对外是 browser-* 工具的唯一后端。
 * 不做域门禁（那是工具层的事），只负责"起、用、关"。
 */
export class CdpBrowserService {
  constructor({ dataDir = null, log = () => {} } = {}) {
    this.dataDir = dataDir;
    this.log = typeof log === 'function' ? log : () => {};
    this._cats = new Map();     // chatKey -> CatBrowser
    this._networkDeadUntil = 0; // 网络面熔断截止（0 = 健康）
    this._sweeper = setInterval(() => { this.#sweep(); }, SWEEP_MS);
    if (this._sweeper.unref) this._sweeper.unref();
    // 进程退出兜底：内核是子进程，不杀会留孤儿（Electron 退出后仍在后台跑）
    process.once('exit', () => { for (const c of this._cats.values()) c.killNow(); });
  }

  /** 该会话是否已有活实例 */
  has(chatKey) {
    const c = this._cats.get(String(chatKey));
    return Boolean(c && c.alive);
  }

  /** 网络面是否处于熔断中（诊断/自测用） */
  get networkBlocked() {
    return Date.now() < this._networkDeadUntil;
  }

  /** 熔断 —— 内核网络服务异常（崩溃 / 导航持续超时）时调用：一段时间内快速失败 */
  #markNetworkDead() {
    if (Date.now() < this._networkDeadUntil) return;
    this._networkDeadUntil = Date.now() + NETWORK_BREAKER_MS;
    this.log(`[browser] 内核网络服务异常（崩溃或导航超时）——browser-* 熔断 ${Math.round(NETWORK_BREAKER_MS / 60000)} 分钟`);
  }

  /** 熔断中时的统一错误（把"挂死"变成"立刻失败 + 替代路径"） */
  #breakerError() {
    return new Error('浏览器网络面不可用（内核网络服务无响应）。'
      + '改用 web_fetch / web_search 取网页内容；本次不再重试浏览器。');
  }

  /** 当前活实例数（观测用） */
  get size() {
    return [...this._cats.values()].filter((c) => c.alive).length;
  }

  async #instance(chatKey) {
    if (this.networkBlocked) throw this.#breakerError();
    const key = String(chatKey);
    let c = this._cats.get(key);
    // 有头实例（人工登录窗口）不与自动化共用 —— 域内 browser-* 调用按「优雅关闭 + 重建」处理
    // 🔴 必须优雅：强杀会丢 profile flush，人工刚过的验证凭据就白过了
    if (c && c.alive && !c.headful) return c;
    if (c) { try { await c.close(); } catch { /* ignore */ } }
    c = new CatBrowser({
      chatKey: key,
      kernelPath: resolveKernelPath(),
      baseDir: path.join(this.dataDir || resolveBrowserDataDir(), safeDirName(key)),
      log: this.log
    });
    c.onNetworkDead = () => this.#markNetworkDead();
    this._cats.set(key, c);
    return c;
  }

  /** 打开网页并等加载完成 */
  async open(chatKey, url) {
    if (this.networkBlocked) throw this.#breakerError();
    const c = await this.#instance(chatKey);
    return c.run(async () => {
      const info = await c.navigate(url);
      return info;
    });
  }

  /** 读取当前页（mode: text / ax / links） */
  async read(chatKey, mode) {
    const c = await this.#instance(chatKey);
    return c.run(async () => {
      const m = String(mode || 'text').trim() || 'text';
      if (m === 'links') {
        const links = await c.readLinks();
        return { mode: 'links', count: links.length, links };
      }
      if (m === 'ax') {
        const ax = await c.readAx();
        return { mode: 'ax', text: ax };
      }
      if (m !== 'text') throw new Error(`未知观察面：${m}（支持 text / ax / links）`);
      const r = await c.readText();
      return { mode: 'text', ...r };
    });
  }

  /** 执行 JS 表达式 */
  async eval(chatKey, expression) {
    const c = await this.#instance(chatKey);
    return c.run(() => c.evaluate(expression));
  }

  /** 截图 */
  async shot(chatKey, full) {
    const c = await this.#instance(chatKey);
    return c.run(() => c.screenshot(full));
  }

  /** 页签管理 */
  async tabs(chatKey, action, target, url) {
    const c = await this.#instance(chatKey);
    return c.run(() => c.tabs(action, target, url));
  }

  /**
   * 有头登录开关（browser-headful 后端）——open 起有头窗口 / close 关掉（profile 落盘保留登录态）。
   * 不走 #instance：有头实例与网络面熔断无关（人工登录不该被自动化链路健康度挡住）。
   */
  async headful(chatKey, action, url) {
    const key = String(chatKey);
    const act = String(action || 'open').trim() || 'open';
    if (act === 'close') {
      // 直接关（不走 closeChat —— 后者会跳有头实例，而这里要关的正是它）
      const c = this._cats.get(key);
      if (!c) return { action: 'close', closed: false };
      this._cats.delete(key);
      await c.close();
      return { action: 'close', closed: true };
    }
    if (act !== 'open') throw new Error(`未知动作：${act}（支持 open / close）`);
    const old = this._cats.get(key);
    if (old) {
      this._cats.delete(key);
      try { await old.close(); } catch { /* 关旧实例失败不阻断起新 */ }
    }
    const c = new CatBrowser({
      chatKey: key,
      kernelPath: resolveKernelPath(),
      baseDir: path.join(this.dataDir || resolveBrowserDataDir(), safeDirName(key)),
      log: this.log
    });
    this._cats.set(key, c);
    const r = await c.headfulOpen(url);
    return { action: 'open', url: r.url, profile: c.profileDir };
  }

  /** 关掉某会话的实例（timeback back / 域回收） */
  async closeChat(chatKey) {
    const key = String(chatKey);
    const c = this._cats.get(key);
    if (!c) return false;
    // 🔴 有头窗口（人工登录 / 过验证）不随域回收与运行收尾关闭——它等的是人的动作，
    //    提前关掉就白过了；由 browser-headful(action="close") 或空闲回收处理。
    if (c.headful) return false;
    this._cats.delete(key);
    await c.close();
    return true;
  }

  /** 关掉全部实例（停机 / 测试收尾） */
  async closeAll() {
    const all = [...this._cats.values()];
    this._cats.clear();
    for (const c of all) {
      try { await c.close(); } catch (e) { this.log(`[browser] 关实例失败：${e?.message ?? e}`); }
    }
  }

  /** 空闲回收巡检 */
  #sweep() {
    const now = Date.now();
    for (const [key, c] of [...this._cats.entries()]) {
      if (!c.alive) { this._cats.delete(key); continue; }
      const idleLimit = c.headful ? HEADFUL_IDLE_CLOSE_MS : IDLE_CLOSE_MS;
      if (now - c.lastUsedAt > idleLimit) {
        this._cats.delete(key);
        this.log(`[browser] ${key} 空闲 ${Math.round(idleLimit / 60000)} 分钟，已回收实例`);
        c.close().catch(() => {});
      }
    }
  }
}

/** 进程级单例 —— 工具层（cat-tools.js）取用 */
export const browserService = new CdpBrowserService({});
