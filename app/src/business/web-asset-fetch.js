// web-fetch.js —— 网页资产下载器（QQBotB 卫星 · WebCat 组 web-fetch / web-fetch-jobs 后端）
//
// 移植来源：CH4 宿主 IWebFetchService / WebFetchService.cs（design-ch4-webfetch，同语义）。
//   · 全局单一下载器——任务表全猫共用，任务携带来源会话（chatKey）供完成回调定位收件人
//   · Fetch：登记即返回任务号（非阻塞），下载在后台进行；完成 / 失败时回调注入（onDone）
//   · Jobs：list（全部任务）/ status（单任务详情）/ cancel（取消进行中；已终结不可取消）
//   · 不设大小上限、不设下载超时；同名文件（含 .part）或同 URL 在途 → 直接报错
//   · 任务表落盘（DATA_DIR/downloads.json）——进程重启后未完成任务标 interrupted（不自动续）
// 不域限定（对照 browser-* 五件的域内限定）：产物落盘、不占前文，无开域理由。
// SSRF / 浏览锁定沿用 safe-fetch（validateFetchUrl 逐跳 DNS 校验 + 重定向逐跳白名单校验）；
// 内网地址默认拒——本地测试 / 自建服务需开 `webFetch.allowPrivateHosts`。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getConfig, DATA_DIR } from './config.js';
import { validateFetchUrl, checkBrowseLock } from './safe-fetch.js';

/** 重定向上限（与 safe-fetch 同口径） */
const MAX_REDIRECTS = 5;
/** 任务表落盘路径 */
function storePath() {
  return path.join(DATA_DIR, 'downloads.json');
}

/** 受控根内候选（本机 WorkSpace）——探测不到再回落用户下载目录 */
const DIR_CANDIDATES = ['D:\\Mau\\WorkSpace\\Downloads'];

/**
 * 产物目录——配置 webFetch.downloadsDir 优先；留空按候选探测（父目录存在即用），
 * 都不中则回落 `~/Downloads/QQAgent`（换机不至于写不进去）。
 */
export function resolveDownloadsDir() {
  const configured = String(getConfig()?.webFetch?.downloadsDir || '').trim();
  if (configured) return path.resolve(configured);
  for (const dir of DIR_CANDIDATES) {
    try { if (fs.existsSync(path.dirname(dir))) return dir; } catch { /* 探测失败换下一个 */ }
  }
  return path.join(os.homedir(), 'Downloads', 'QQAgent');
}

/** 文件名净化 —— 去路径分隔符与 Windows 非法字符，压长度 */
function safeFileName(raw, fallback) {
  let name = String(raw ?? '').trim();
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = fallback;
  if (Array.from(name).length > 120) name = Array.from(name).slice(0, 120).join('');
  return name;
}

/** 从 URL 尾段派生文件名（派生不出用 download） */
function deriveFileName(url) {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return safeFileName(seg, 'download');
  } catch {
    return 'download';
  }
}

/** 人类可读体积 */
function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 状态中文（工具回执用） */
const STATUS_TEXT = {
  running: '下载中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断（进程重启，未自动续传）'
};

/**
 * 下载服务 —— 全局单例（任务表全猫共用）。
 */
export class WebFetchService {
  constructor() {
    this.jobs = [];
    this.onDone = null;
    this._controllers = new Map();   // jobId -> AbortController
    this.#load();
  }

  /** 接线——完成 / 失败回调（orchestrator 启动期注入：把提示送回来源会话） */
  configure({ onDone = null } = {}) {
    if (typeof onDone === 'function') this.onDone = onDone;
  }

  /** 载入任务表——上一进程遗留的 running 标 interrupted（不自动续传，如实标注） */
  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (parsed && Array.isArray(parsed.jobs)) this.jobs = parsed.jobs;
    } catch { /* 新表 */ }
    let changed = false;
    for (const job of this.jobs) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.error = job.error || '进程重启，未自动续传';
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  #save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${storePath()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 1), 'utf8');
      fs.renameSync(tmp, storePath());
    } catch { /* 落盘失败不阻断下载本身 */ }
  }

  #notify(catKey, text) {
    if (!catKey || typeof this.onDone !== 'function') return;
    try { this.onDone(String(catKey), text); } catch { /* 注入失败不阻断任务表 */ }
  }

  /** 任务号 —— d_<base36 时间><随机> */
  #newId() {
    return `d_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  }

  /** 进行中任务数（观测用） */
  get running() {
    return this.jobs.filter((j) => j.status === 'running').length;
  }

  /**
   * 推入下载任务——登记并起后台下载，立即返回回执文本（失败 ERR| 前缀）。
   * @param {string} catKey 来源会话（完成回调收件人）
   * @param {string} url 目标地址
   * @param {string} fileName 目标文件名（空 = 按 URL 派生）
   */
  fetch(catKey, url, fileName) {
    const rawUrl = String(url ?? '').trim();
    if (!rawUrl) return 'ERR|BAD_ARGS|缺少 url';
    let target = null;
    try { target = new URL(rawUrl); } catch { return 'ERR|BAD_ARGS|URL 无效'; }
    if (!['http:', 'https:'].includes(target.protocol)) return 'ERR|BAD_ARGS|仅支持 http(s) 地址';
    const dir = resolveDownloadsDir();
    const name = safeFileName(fileName, '') || deriveFileName(target.toString());
    const filePath = path.join(dir, name);
    const partPath = `${filePath}.part`;
    // 查重：同名产物（含未完成的 .part）直接拒 —— 避免静默覆盖用户已下好的文件
    if (fs.existsSync(filePath) || fs.existsSync(partPath)) {
      return `ERR|FILE_EXISTS|目标同名文件已存在：${filePath}（改名或清理后重试）`;
    }
    // 查重：同 URL 任务在途
    const dup = this.jobs.find((j) => j.status === 'running' && j.url === target.toString());
    if (dup) {
      return `ERR|JOB_EXISTS|同一地址已有在途任务（${dup.id}）——先 web-fetch-jobs status 查看，或 cancel 后重试`;
    }
    const job = {
      id: this.#newId(),
      url: target.toString(),
      fileName: name,
      filePath,
      partPath,
      catKey: String(catKey ?? ''),
      status: 'running',
      bytes: 0,
      total: 0,
      error: '',
      createdAt: Date.now(),
      finishedAt: 0
    };
    this.jobs.push(job);
    this.#save();
    this.#run(job).catch(() => { /* #run 内部已置终态 */ });
    return `已登记下载任务：${job.id}\n文件名：${name}\n产物落点：${filePath}\n（下载在后台进行——完成或失败时会自动告知；用 web-fetch-jobs 查看进度）`;
  }

  /** 后台下载体 —— 逐跳校验 + 流式落盘 .part → rename */
  async #run(job) {
    const controller = new AbortController();
    this._controllers.set(job.id, controller);
    try {
      let current = job.url;
      let res = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const lock = checkBrowseLock(current);
        if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
        // DNS 级 SSRF 校验（内网地址默认拒）——内网例外开关：webFetch.allowPrivateHosts（仅本地测试 / 自建服务）
        const allowPrivate = getConfig()?.webFetch?.allowPrivateHosts === true;
        await validateFetchUrl(current, { allowPrivate });
        res = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQAgent/1.0',
            accept: '*/*'
          }
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error(`重定向缺少 Location：HTTP ${res.status}`);
          current = new URL(loc, current).toString();
          continue;
        }
        break;
      }
      if (!res) throw new Error('重定向次数过多，已停止');
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
      job.total = Number(res.headers.get('content-length') || 0) || 0;
      job.url = current;
      fs.mkdirSync(path.dirname(job.filePath), { recursive: true });
      const out = fs.createWriteStream(job.partPath);
      try {
        for await (const chunk of res.body) {
          if (controller.signal.aborted) throw new Error('已取消');
          job.bytes += chunk.length;
          if (!out.write(chunk)) {
            await new Promise((resolve) => out.once('drain', resolve));
          }
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if (controller.signal.aborted) throw new Error('已取消');
      fs.renameSync(job.partPath, job.filePath);
      job.status = 'done';
      job.finishedAt = Date.now();
      this.#save();
      this.#notify(job.catKey, `[下载完成] ${job.fileName}（${sizeText(job.bytes)}）已落盘：${job.filePath}（任务号 ${job.id}）`);
    } catch (error) {
      const aborted = controller.signal.aborted;
      try { fs.rmSync(job.partPath, { force: true }); } catch { /* 清理失败不阻断 */ }
      job.status = aborted ? 'cancelled' : 'failed';
      job.error = aborted ? '已取消' : String(error?.message ?? error);
      job.finishedAt = Date.now();
      this.#save();
      if (!aborted) {
        this.#notify(job.catKey, `[下载失败] ${job.fileName}：${job.error}（任务号 ${job.id}）`);
      }
    } finally {
      this._controllers.delete(job.id);
    }
  }

  /** 任务清单 / 详情 / 取消 —— 返回回执文本 */
  jobsText(action, id) {
    const act = String(action ?? 'list').trim() || 'list';
    if (act === 'list') {
      if (!this.jobs.length) return '暂无下载任务。';
      const rows = this.jobs.slice(-30).map((j) => {
        const progress = j.status === 'running'
          ? `（${sizeText(j.bytes)}${j.total ? ' / ' + sizeText(j.total) : ''}）`
          : j.status === 'done' ? `（${sizeText(j.bytes)}）` : '';
        const err = j.error ? ` —— ${j.error}` : '';
        return `${j.id} | ${STATUS_TEXT[j.status] || j.status}${progress} | ${j.fileName}${err}`;
      });
      return `下载任务（${this.jobs.length} 条，最近 ${rows.length} 条）：\n` + rows.join('\n');
    }
    const job = this.jobs.find((j) => j.id === String(id ?? '').trim());
    if (!job) return `找不到任务号：${id || '(空)'}（先用 action=list 取）`;
    if (act === 'status') {
      return [
        `任务号：${job.id}`,
        `状态：${STATUS_TEXT[job.status] || job.status}`,
        `文件名：${job.fileName}`,
        `地址：${job.url}`,
        `产物：${job.filePath}`,
        job.status === 'running' ? `进度：${sizeText(job.bytes)}${job.total ? ' / ' + sizeText(job.total) : ''}` : `体积：${sizeText(job.bytes)}`,
        job.error ? `错误：${job.error}` : '',
        `登记：${new Date(job.createdAt).toLocaleString('zh-CN')}`
      ].filter(Boolean).join('\n');
    }
    if (act === 'cancel') {
      if (job.status !== 'running') return `任务 ${job.id} 已终结（${STATUS_TEXT[job.status] || job.status}），不可取消。`;
      const controller = this._controllers.get(job.id);
      if (!controller) return `任务 ${job.id} 未在下载中（可能刚结束）——先 status 查看。`;
      controller.abort();
      return `已请求取消任务 ${job.id}（${job.fileName}）。`;
    }
    return `未知动作：${act}（支持 list / status / cancel）`;
  }

  /** 停机 —— 中止全部在途任务（不置终态，任务表留在盘上） */
  shutdown() {
    for (const [, c] of this._controllers) {
      try { c.abort(); } catch { /* ignore */ }
    }
    this._controllers.clear();
  }
}

/** 进程级单例 —— 工具层（cat-tools.js）取用 */
export const webFetchService = new WebFetchService();
