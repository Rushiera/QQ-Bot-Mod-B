// navigator/catmeta.js —— 猫的派生状态（末条发言者 · 收工态 · 上工挂载 · 本轮调用数）
//
// 职责：读 CH4 的会话视图文件与 cat.cfg，算出面板要显示、而宿主 /api/v1/cats 不提供的四件事。
// 口径来源：并发协议面板 `Program.cs` 的 DialogOf / OverworkOf / IsOverworkReport / SettleOf
//          与 `SessionViewReader.ScanTail`——本项目**逐条复刻**，不另立判据（两个面板报同一只猫的状态
//          不该互相矛盾；判据漂移的代价是「同一个事实两个说法」）。
// 边界：只读文件，不写 CH4 数据面；读失败一律出声（回落空值并记一次告警），不静默当成「没回复」。
// 设计：design-qqbotb-log §一百三十一。

import fs from 'node:fs';
import path from 'node:path';

/** 尾窗起始字节（与并发协议一致）——不够翻倍到上限。 */
const TAIL_BYTES = 512 * 1024;

/** 尾窗上限——超过就不再往前找（10 万字符级会话的回复/提问必在最后这一段内）。 */
const MAX_TAIL_BYTES = 32 * 1024 * 1024;

/** 收工指令的弱形态短句闸（字符）——指令都是短的，讨论动辄几十字。 */
const OVERWORK_SHORT_MAX = 40;

/** 强形态：开头即收工词，后面跟什么内容都算指令（「收工，然后看眼 X」）。 */
const OVERWORK_STRONG = /^\s*(收工|沉淀)(?![一-龥])/;

/** 弱形态四条——正例/反例见并发协议 Program.cs:2162-2176。 */
const OVERWORK_WEAK = [
  /(收工|沉淀)\s*[。！!，,；;、~～…]*\s*$/,
  /(可以|直接|就|然后|做完|马上|现在|先|再|赶紧|立刻|立即|记得|请|帮我|该)\s*(收工|沉淀)(?![一-龥])/,
  /(收工|沉淀)\s*(吧|了|啦|咯|呀)/,
  /(收工|沉淀)\s*(吗|嘛|不)[？?]?/
];

/** 收工报告头窗——只认行首声明，不认句中散词。 */
const REPORT_HEAD = /^[^\S\n]*(#+[^\n]{0,30}收工|收工)|收工报告如下/m;

/** 收工报告尾窗结构——CCBP 收工三律要求的遗留去向 / 继续会话指令块。 */
const REPORT_TAIL = /(继续会话指令|遗留去向|遗留项去向)/;

/** 整体级核销声明（分支 / 本轮 / 本趟 / 整轮 / 任务 + 已核销）。 */
const CLOSE_SIGNAL = /(分支|本轮|本趟|整轮|任务)[^\n。；]{0,8}已?核销/g;

/** 核销组内部的否定（「本轮无核销」不是核销声明）。 */
const CLOSE_NEG_INSIDE = /(无|没有|零|未)\s*$/;

/** 未尽信号词。 */
const UNFINISHED = /(遗留|未尽|未完成|未决|未竟|未收口|待办|待裁|待拍板|待验|未做|剩余|下一步|留待|待补)/g;

/** 否定贴邻（前 / 后）——「无遗留」「遗留：无」是已交代清楚。 */
const NEG_BEFORE = /(无|没有|零|已核销|已清|已闭环|不涉及)[^，。；、|\n]{0,6}$/;
const NEG_AFTER = /^\s*[:：]?\s*(无|没有|零|0\s*项?|已清|已核销|已闭环|N\/A)/;

/**
 * 末条人的发言是不是收工指令。
 *
 * @param {string} lastUser 末条人的发言
 * @returns {boolean} 是收工指令
 */
export function isOverwork(lastUser) {
  const text = String(lastUser || '').trim();
  if (!text) return false;
  if (OVERWORK_STRONG.test(text)) return true;
  if (text.length > OVERWORK_SHORT_MAX) return false;
  return OVERWORK_WEAK.some((re) => re.test(text));
}

/**
 * 末条猫回复是不是收工报告（不依赖人有没有说「收工」）。
 *
 * @param {string} reply 末条猫回复
 * @returns {boolean} 是收工报告
 */
export function isOverworkReport(reply) {
  const text = String(reply || '').trim();
  if (!text) return false;
  if (REPORT_HEAD.test(text.slice(0, 240))) return true;
  return REPORT_TAIL.test(text.slice(-400));
}

/**
 * 收工报告的核销分档：`clean` = 已核销 · `open` = 有未尽事宜。
 *
 * @param {string} reply 末条猫回复（调用方已确认是收工报告）
 * @returns {{state: string, hits: string}} 档位与命中词
 */
export function settleOf(reply) {
  const text = String(reply || '');
  if (!text) return { state: '', hits: '' };
  CLOSE_SIGNAL.lastIndex = 0;
  let m = CLOSE_SIGNAL.exec(text);
  while (m) {
    const from = Math.max(0, m.index - 16);
    const before = text.slice(from, m.index);
    const cut = m[0].indexOf('核销');
    const inside = cut > 0 ? m[0].slice(Math.max(0, cut - 6), cut) : '';
    if (!NEG_BEFORE.test(before) && !(cut > 0 && CLOSE_NEG_INSIDE.test(inside))) {
      return { state: 'clean', hits: `核销·${m[0]}` };
    }
    m = CLOSE_SIGNAL.exec(text);
  }
  const hits = [];
  UNFINISHED.lastIndex = 0;
  let u = UNFINISHED.exec(text);
  while (u) {
    const from = Math.max(0, u.index - 16);
    const before = text.slice(from, u.index);
    const after = text.slice(u.index + u[0].length, u.index + u[0].length + 16);
    if (!NEG_BEFORE.test(before) && !NEG_AFTER.test(after) && !hits.includes(u[0])) hits.push(u[0]);
    u = UNFINISHED.exec(text);
  }
  return hits.length ? { state: 'open', hits: `未尽·${hits.join(',')}` } : { state: 'clean', hits: '' };
}

/**
 * 收工态四值判定（与并发协议 OverworkOf 同构）。
 *
 * @param {string} speaker 末条发言者（cat / user / 空）
 * @param {string} lastUser 末条人的发言
 * @param {boolean} report 末条猫回复是不是收工报告
 * @param {string} settle 核销分档（clean / open / 空）
 * @param {boolean} running 是否在运行
 * @param {string} runState 宿主七态
 * @returns {string} `doing` / `done` / `doneOpen` / 空
 */
export function overworkOf(speaker, lastUser, report, settle, running, runState) {
  const instructed = isOverwork(lastUser);
  const reported = report && speaker === 'cat';
  if (!instructed && !reported) return '';
  const stopped = !running || String(runState || '').toLowerCase() === 'idle';
  if (instructed) {
    if (!stopped || speaker !== 'cat') return 'doing';
    return settle === 'open' ? 'doneOpen' : 'done';
  }
  if (!stopped) return 'doing';
  return settle === 'open' ? 'doneOpen' : 'done';
}

/**
 * 取会话视图块里的正文（payload 可能是 JSON 字符串，也可能是对象）。
 *
 * @param {object} block 视图块
 * @returns {string} 正文
 */
function payloadText(block) {
  const payload = block?.Payload;
  if (typeof payload === 'string') {
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === 'object') return String(obj.text ?? obj.content ?? '');
    } catch {
      return payload;
    }
    return payload;
  }
  if (payload && typeof payload === 'object') return String(payload.text ?? payload.content ?? '');
  return '';
}

/**
 * 从文件尾部倒扫，取末条猫回复 / 末条人提问 / 自末条回复以来的工具调用数。
 *
 * @param {string} file 视图文件路径
 * @returns {{reply: string, replyTs: number, ask: string, askTs: number, calls: number}} 尾部状态
 */
function scanTailFile(file) {
  const empty = { reply: '', replyTs: 0, ask: '', askTs: 0, calls: 0 };
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return empty;
  }
  if (size <= 0) return empty;

  let take = Math.min(size, TAIL_BYTES);
  for (;;) {
    const buf = Buffer.allocUnsafe(take);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, take, size - take);
    } catch (err) {
      return empty;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 关不掉不影响已读到的内容 */ }
      }
    }
    const lines = buf.toString('utf8').split('\n');
    const first = take < size ? 1 : 0;      // 从中间读起时首行被截断，跳过
    const result = { ...empty };
    let foundReply = false;
    let foundAsk = false;
    for (let i = lines.length - 1; i >= first; i -= 1) {
      const line = lines[i].trim();
      if (!line || !line.includes('"RenderType"')) continue;
      let block;
      try {
        block = JSON.parse(line);
      } catch {
        continue;                            // 单行坏了只跳过（视图块是追加文件，尾部可能正在写）
      }
      const type = String(block?.RenderType || '');
      if (type === 'toolcard') {
        if (!foundReply) result.calls += 1;  // 只数末条回复之后的调用
        continue;
      }
      if (type !== 'text' && type !== 'user') continue;
      const ts = Number(block?.Timestamp) || 0;
      const text = payloadText(block);
      if (!text) continue;
      if (type === 'text') {
        if (foundReply) continue;
        result.reply = text;
        result.replyTs = ts;
        foundReply = true;
      } else {
        if (foundAsk) continue;
        result.ask = text;
        result.askTs = ts;
        foundAsk = true;
      }
      if (foundReply && foundAsk) break;
    }
    if (foundReply || take >= size || take >= MAX_TAIL_BYTES) return result;
    take = Math.min(size, take * 2);
  }
}

/**
 * 创建派生状态读取器。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {number} [options.mainPort] CH4 主端口（用它查数据根）
 * @param {string} [options.sessionsRoot] 会话根（空 = 自动解析）
 * @returns {object} 读取器
 */
export function createCatMeta({ log, mainPort = 8080, sessionsRoot = '' }) {
  const tailCache = new Map();     // catId → { len, lastActiveAt, value }
  const mountCache = new Map();    // catId → { mtimeMs, mount }
  let rootCache = sessionsRoot ? { root: sessionsRoot, at: Date.now() } : null;
  let rootWarnAt = 0;

  /**
   * 解析 CH4 会话根（`<data>/sessions`）——查一次受控根表即可，缓存 10 分钟。
   *
   * @returns {Promise<string>} 会话根（解析不到给空串）
   */
  async function resolveRoot() {
    if (rootCache && Date.now() - rootCache.at < 10 * 60 * 1000) return rootCache.root;
    const configured = String(sessionsRoot || '').trim();
    if (configured) {
      rootCache = { root: configured, at: Date.now() };
      return configured;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${mainPort}/api/v1/workspace`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      const dataRoot = (Array.isArray(data?.roots) ? data.roots : []).find((row) => row?.id === 'data');
      const root = dataRoot?.path ? path.join(String(dataRoot.path), 'sessions') : '';
      rootCache = { root, at: Date.now() };
      if (!root && Date.now() - rootWarnAt > 60 * 1000) {
        rootWarnAt = Date.now();
        log?.warn?.('[catmeta] 受控根表里没有 data 根，猫状态退回宿主字段');
      }
      return root;
    } catch (err) {
      if (Date.now() - rootWarnAt > 60 * 1000) {
        rootWarnAt = Date.now();
        log?.warn?.(`[catmeta] 会话根解析失败：${String(err?.message ?? err)}`);
      }
      return '';
    }
  }

  /**
   * 会话尾部状态（双键缓存：视图文件长度 + 宿主活动时刻）。
   *
   * @param {string} root 会话根
   * @param {string} catId 会话 id
   * @param {number} lastActiveAt 宿主报的最近活动时刻
   * @returns {object} 尾部状态
   */
  function tailOf(root, catId, lastActiveAt) {
    const file = path.join(root, catId, `${catId}.view.jsonl`);
    let len = 0;
    try {
      len = fs.statSync(file).size;
    } catch {
      return { reply: '', replyTs: 0, ask: '', askTs: 0, calls: 0 };
    }
    const hit = tailCache.get(catId);
    if (hit && hit.len === len && hit.lastActiveAt === lastActiveAt) return hit.value;
    const value = scanTailFile(file);
    tailCache.set(catId, { len, lastActiveAt, value });
    return value;
  }

  /**
   * 该猫当前上工的项目（cat.cfg 的 projectMount，按 mtime 缓存）。
   *
   * @param {string} root 会话根
   * @param {string} catId 会话 id
   * @returns {string} 项目名（未挂给空串）
   */
  function mountOf(root, catId) {
    const file = path.join(root, catId, 'cat.cfg');
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return '';
    }
    const hit = mountCache.get(catId);
    if (hit && hit.mtimeMs === mtimeMs) return hit.mount;
    let mount = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      mount = String(cfg?.projectMount ?? '').trim();
    } catch (err) {
      log?.warn?.(`[catmeta] cat.cfg 解析失败 ${file}：${String(err?.message ?? err)}`);
    }
    mountCache.set(catId, { mtimeMs, mount });
    return mount;
  }

  /**
   * 给宿主 cats 补派生字段（speaker / calls / mount / overwork）。
   *
   * @param {Array<object>} cats 宿主 /api/v1/cats 的条目
   * @returns {Promise<Array<object>>} 新数组（不修改入参）
   */
  async function enrich(cats) {
    const list = Array.isArray(cats) ? cats : [];
    if (!list.length) return [];
    const root = await resolveRoot();
    if (!root) return list.map((row) => ({ ...row }));
    return list.map((row) => {
      const catId = String(row?.id || '');
      if (!catId) return { ...row };
      const tail = tailOf(root, catId, Number(row?.lastActiveAt) || 0);
      const speaker = tail.replyTs && tail.replyTs >= tail.askTs ? 'cat' : (tail.askTs ? 'user' : '');
      const report = speaker === 'cat' && isOverworkReport(tail.reply);
      const settle = report ? settleOf(tail.reply) : { state: '', hits: '' };
      const overwork = overworkOf(
        speaker, tail.ask, report, settle.state, row?.running !== false, String(row?.runState || row?.phase || '')
      );
      return {
        ...row,
        speaker,
        lastUser: tail.ask,
        replyTs: tail.replyTs,
        askTs: tail.askTs,
        calls: tail.calls,
        mount: mountOf(root, catId),
        overwork,
        overworkHits: settle.hits
      };
    });
  }

  return { enrich, resolveRoot };
}
