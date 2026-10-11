// nav-tools.js —— 领航员工具组（QQBotB 卫星 · 2026-10-11）
//
// 领航员 = 本 bot 的一种工作模式：群里的人（限 VIP）借它指挥 CH4 的猫群干活。
// 本模块只做「手」——状态 / 投递 / 详情都经自研单体（app/）的领航员 API：
//   GET  /api/nav/status             领航员状态 + 猫群清单 + 指令流水
//   GET  /api/nav/detail?key=<猫>    单猫详情（在干什么 / 末条 user / 末条回复）
//   GET  /api/nav/health             健康检查
//   POST /api/nav/open               开启（body { by:'qq', requireVip:true }）
//   POST /api/nav/close              关闭
//   POST /api/nav/send               投递（body { key, text }）
//   POST /api/nav/new-session        新会话（body { keys: 'a,b,c' }——发布 /new，不清前文交接）
//
// 「指令 / 闲聊」的语义判断归模型——本模块不做判定，也不替猫编造进度。
// 依赖：QQBot mod B 自研单体（Electron 应用）在 127.0.0.1:3280 在跑。

import { registerTool } from './tool-registry.js';
// 记忆回溯点（收工轮取材回溯到领航员开启那一刻）——[qqagent-navigator-patch:memory-reach-import]
import { setMemoryFloor } from './session-state.js';

/** 自研单体的界面 / API 端口。 */
const ENDPOINT = 'http://127.0.0.1:3280';

/** 单次调用超时（毫秒）——健康检查要探外部服务，留宽一点。 */
const TIMEOUT_MS = 25000;

/** 猫名清单（提示词里给模型认名字用）。 */
const CAT_HINT = 'majordomo（主干）/ R喵 / R喵喵 / R喵喵喵 / R喵喵喵喵 / rb / rc / rd / re / rf';

/**
 * 调自研单体领航员 API。
 *
 * @param {string} pathname 路径（含查询串）
 * @param {object} [options] 选项（method / body）
 * @returns {Promise<object>} 响应体
 */
async function call(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}${pathname}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 成功回执。
 *
 * @param {string} text 正文
 * @returns {object} 工具结果
 */
function ok(text) {
  return { content: String(text), isError: false };
}

/**
 * 失败回执。
 *
 * @param {string} text 正文
 * @returns {object} 工具结果
 */
function err(text) {
  return { content: String(text), isError: true };
}

/**
 * 猫群清单渲染。
 *
 * @param {Array<object>} cats 猫状态
 * @returns {string} 文本
 */
function renderCats(cats) {
  if (!Array.isArray(cats) || cats.length === 0) return '（未读到猫群——CH4 宿主可能没在跑）';
  return cats
    .map((c) => `${c.runState === 'idle' ? '·' : '▶'} ${c.name}（${c.port}）${c.runState}｜前文 ${c.contextCount} 条 / ${c.context} 字符`)
    .join('\n');
}

/**
 * 注册领航员工具组。
 *
 * @returns {void}
 */
export function registerNavTools() {
  // ── nav_status ──────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_status',
    name: '领航员·状态',
    description: `看领航员模式的状态与 CH4 猫群现状——是否开启、回消息群、当前目标猫、每只猫的运行态、最近指令流水。
用途：「领航员开着吗」「猫在干什么」「刚刚让你做什么了」这类问题先调本工具，别凭空猜。`,
    category: 'system',
    icon: '🧭',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const data = await call('/api/nav/status');
        const lines = [];
        lines.push(`领航员：${data.enabled ? '已开启' : '未开启'}${data.openedBy ? `（来源 ${data.openedBy === 'qq' ? '群内 @' : '应用内'}）` : ''}`);
        lines.push(`回消息群：${data.activeChat ?? '未定'}｜目标猫：${data.lastTarget || '未定'}`);
        lines.push(`最后指令：${data.lastCommandAt ? new Date(data.lastCommandAt).toLocaleString('zh-CN', { hour12: false }) : '无'}`);
        lines.push(`猫群（${(data.cats || []).length} 只）：`);
        lines.push(renderCats(data.cats));
        const flow = (data.commandLog || []).slice(-5).reverse();
        if (flow.length) {
          lines.push('最近指令：');
          for (const e of flow) {
            lines.push(`  [${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}] → ${e.target || '-'}：${e.text}（${e.result}）`);
          }
        }
        return ok(lines.join('\n'));
      } catch (error) {
        return err(`领航员服务不可达（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_open ────────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_open',
    name: '领航员·开启',
    description: `开启领航员模式（QQ 群指挥 CH4 猫群）。
🔴 只有 QQ 569145850 本人在群里 @ 我 说「打开 / 开启 / 启动…领航员」时才可调用——其他任何人（含管理员）的请求一律不要调用本工具。
🔴 领航员**已经开着**时就不要再调本工具（不确定状态先调 nav_status）——重复开启不会重发任何东西，但那是无意义动作；重复的「开工报告 + 开场巡检」已经在系统侧做了幂等保护。
调用后我（自研单体）会自动在下指令的群发一条健康检查回执；你不需要再复述回执内容，也不要重复发送。`,
    category: 'system',
    icon: '🚀',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const data = await call('/api/nav/open', { method: 'POST', body: { by: 'qq', requireVip: true } });
        if (data.ok === false) return err(`领航员未开启：${data.error ?? '未知原因'}`);
        // 记忆回溯点：本次领航开启时刻置位 —— 收工轮取材据此回溯到这一刻起（不只吃本会话）。
        // [qqagent-navigator-patch:memory-reach-open]
        let reachNote = '';
        try {
          const st = await call('/api/nav/status');
          const chatId = String(st?.activeChat ?? '').replace(/^group:/, '').trim();
          if (/^\d+$/.test(chatId)) {
            setMemoryFloor(`group:${chatId}`, Date.now());
            reachNote = `\n记忆回溯点已置位（group:${chatId}）——本轮收工取材会回溯到此刻起。`;
          } else {
            reachNote = `\n⚠️ 记忆回溯点未置位：未读到回消息群（activeChat=${st?.activeChat ?? '空'}）。`;
          }
        } catch (error) {
          reachNote = `\n⚠️ 记忆回溯点未置位：${error?.message ?? error}`;
        }
        return ok(`领航员已开启（回执已自动发到下指令的群）。猫群：\n${renderCats(data.health?.cats)}${reachNote}`);
      } catch (error) {
        return err(`领航员服务不可达（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_close ───────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_close',
    name: '领航员·关闭',
    description: `关闭领航员模式。
🔴 同样只接受 QQ 569145850 本人的请求。关闭后群里回到普通参与模式。`,
    category: 'system',
    icon: '🛑',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const data = await call('/api/nav/close', { method: 'POST', body: { reason: 'manual', notify: false } });
        return ok(data.enabled === false ? '领航员已关闭。' : '关闭请求已发出，但状态仍为开启——请再查一次状态。');
      } catch (error) {
        return err(`领航员服务不可达（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_send ────────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_send',
    name: '领航员·投递指令',
    description: `把一条指令投递给 CH4 的某只猫执行（猫那边看到的就是这条原文——系统不再加 [来自QQ]… 来源头，渠道由投递通道自身承载）。
- key：猫名或 id——${CAT_HINT}；拿不准目标时传 majordomo。
- text：给猫的**完整指令原文**——照抄用户的指令内容，不要改写、不要加解释、不要加礼貌语、不要带触发标记（如「（@我/提到我）」这类是给判断用的，不是指令内容）。
🔴 只投递**指令**（要猫干活的）；群里的闲聊不要调本工具。
投递成功后猫会在 CH4 里干活；猫的回复到达时系统会自动截图发群，你不需要再复述。`,
    category: 'system',
    icon: '📮',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: `目标猫（${CAT_HINT}）` },
        text: { type: 'string', description: '给猫的完整指令原文' }
      },
      required: ['key', 'text']
    },
    async execute(ctx, args) {
      const key = String(args?.key || 'majordomo').trim();
      const text = String(args?.text || '').trim();
      if (!text) return err('text 不能为空——把用户的指令原文填进来。');
      try {
        const data = await call('/api/nav/send', {
          method: 'POST',
          // 不带 chat——回消息群由自研单体按「最近一条 VIP 群消息」解析（比 chatKey 更准）
          body: { key, text }
        });
        if (data?.ok !== true) return err(`投递未受理：${JSON.stringify(data?.reply ?? data)}`);
        return ok(`已投递 → ${key}（端口 ${data.port}）：${text.slice(0, 80)}\n猫的回复到达时会自动截图发群。`);
      } catch (error) {
        return err(`投递失败（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_detail ──────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_detail',
    name: '领航员·单猫详情',
    description: `看某只猫当前在干什么——运行态、前文规模、最近一条用户消息与最近一条回复。
用途：回答「X 猫做到哪了」「卡在哪」——有回复就报回复，还在跑就报在跑。**读不到就说读不到，不要替猫编进度。**`,
    category: 'system',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: `猫名或 id（${CAT_HINT}）` } },
      required: ['key']
    },
    async execute(ctx, args) {
      const key = String(args?.key || 'majordomo').trim();
      try {
        const data = await call(`/api/nav/detail?key=${encodeURIComponent(key)}`);
        if (data?.ok !== true) return err(`未读到 ${key} 的详情：${JSON.stringify(data).slice(0, 200)}`);
        const lines = [
          `${data.name}（${data.cat}）｜运行态 ${data.runState}｜相位 ${data.phase}`,
          `前文 ${data.contextCount} 条 / ${data.context} 字符｜本轮请求 ${data.requests} 次｜待处理 ${data.pending}`
        ];
        if (data.lastUser?.text) lines.push(`最近用户消息（${data.lastUser.timeText ?? data.lastUser.source}）：${String(data.lastUser.text).slice(0, 300)}`);
        if (data.lastReply?.text) lines.push(`最近回复（${data.lastReply.timeText ?? data.lastReply.source}）：${String(data.lastReply.text).slice(0, 600)}`);
        return ok(lines.join('\n'));
      } catch (error) {
        return err(`查询失败（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_health ──────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_health',
    name: '领航员·运行情况',
    description: `看「各单位」现在的运行情况——应用指令层 / CH4 宿主 / 猫群（在跑 / 有会话）/ 外部服务（ApiSiteAnalyzer、ComfyDock 等）。
用途：群里问「各单位运行情况」「现在都怎么样」「状态如何」时调本工具。
🔴 **只读**——看状态就读状态，**不要给猫发消息去问**（那会让它们真的干活、回话，还往各自前文堆一条）。`,
    category: 'system',
    icon: '🩺',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const data = await call('/api/nav/health');
        const lines = [];
        lines.push(`应用指令层 ${data?.app?.ok ? '--OK' : '--异常'}`);
        lines.push(`CH4 宿主 ${data?.ch4?.ok ? '--OK' : `--异常（${data?.ch4?.error || '未连接'}）`}`);
        for (const svc of data?.services || []) lines.push(`${svc.name}   ${svc.detail}`);
        const cats = data?.cats || [];
        const running = (data?.working || []).map((row) => row.name || row.id);
        const busy = (data?.busy || []).map((row) => row.name || row.id);
        lines.push(`猫群（${cats.length} 只）：${running.length ? `${running.join('，')} 正在跑` : '无猫在跑'}${busy.length ? `；有会话：${busy.join('，')}` : ''}`);
        lines.push(renderCats(cats));
        return ok(lines.join('\n'));
      } catch (error) {
        return err(`领航员服务不可达（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_analyze ─────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_analyze',
    name: '领航员·会话分析',
    description: `对某只猫做一次「会话分析」——**直接读它的思考（think）**，报出它现在在干什么 / 做到哪 / 卡不卡。
用途：群里要「回执」「看一下 X 现在干嘛」「进度怎么样」时调本工具；不传 key 就对所有在跑的猫各做一次。
🔴 **只读**——分析是读会话与思考，**不是给猫发消息**；不要用 nav_send 去「问状态」（那会让猫真的回话、往它前文各堆一条）。
分析结果由领航员自己发群（有回复 → 回复截图；还在跑 → 直接读 think 播报 + @ 你），你不用复述。`,
    category: 'system',
    icon: '🔬',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: `目标猫（${CAT_HINT}）；留空 = 全部在跑的猫` } },
      required: []
    },
    async execute(ctx, args) {
      const raw = String(args?.key || '').trim();
      try {
        let keys = raw ? raw.split(/[,，、\s]+/).filter(Boolean) : [];
        if (keys.length === 0) {
          const st = await call('/api/nav/status');
          keys = (st?.cats || [])
            .filter((row) => row?.runState && row.runState !== 'idle')
            .map((row) => row.id);
          if (keys.length === 0) return ok('当前没有在跑的猫——不需要会话分析。要看整体状态用 nav_health。');
        }
        const done = [];
        for (const key of keys) {
          const data = await call('/api/nav/analyze', {
            method: 'POST',
            body: { key, delayMs: 0, reason: '群内回执' }
          });
          done.push(`${key}${data?.ok === true ? '' : '（未受理）'}`);
        }
        return ok(`会话分析已触发（只读，不发消息给猫）：${done.join('，')}\n结果由领航员自己发群。`);
      } catch (error) {
        return err(`会话分析失败（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_new ─────────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_new',
    name: '领航员·新会话',
    description: `给一只或多只猫**直接开新会话**（等价于在该猫对话页发布 /new）——清掉前文 + 重新注入知识文件，**不保留旧前文的交接摘要**。
用途：群里说「清掉 X 的会话」「把 X 的前文清了，直接开新会话即可」时调本工具。
- key：猫名或 id——${CAT_HINT}；**多只用逗号分隔**（如 "R喵喵,rb,rc,rd,rf"）。
🔴 与 nav_reset 的区别：nav_reset 是「前文整理重启」（先收工出交接摘要 → 再开新会话 → 注入摘要 → 让它接着干），用于**前文太长且工作要继续**；本工具只开新会话，不清点工作、也不让它继续。
🔴 只接受 QQ 569145850 本人的请求。执行静默——投递后不要回话。`,
    category: 'system',
    icon: '🆕',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: `目标猫，多只用逗号分隔（${CAT_HINT}）` }
      },
      required: ['key']
    },
    async execute(ctx, args) {
      const key = String(args?.key || '').trim();
      if (!key) return err('key 不能为空——要给哪只猫开新会话？');
      try {
        const data = await call('/api/nav/new-session', { method: 'POST', body: { keys: key } });
        if (data?.ok !== true) return err(`新会话未受理：${JSON.stringify(data).slice(0, 200)}`);
        const done = (data.results || []).filter((row) => row.ok).map((row) => row.key).join('，');
        return ok(`已请求新会话（/new）：${done || key}（${data.count}/${data.total}）。执行静默——不用回话。`);
      } catch (error) {
        return err(`新会话失败（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });

  // ── nav_reset ───────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_reset',
    name: '领航员·前文整理重启',
    description: `把某只猫的前文整理重启——全自动四步：① 让它先做一次收工整理（产出交接摘要）② 清前文开新会话（重新注入知识文件）③ 把交接摘要注入新会话 ④ 让它据此继续工作。
用途：某只猫前文太长、快撑不住上下文时，用户说一句「清理一下 X 的前文，然后让工作继续」就调本工具。
- key：要整理的猫（${CAT_HINT}）。
🔴 只要「清掉会话 / 直接开新会话」用 nav_new——本工具会先让它收工出交接摘要，耗时几分钟；别拿它当清会话使。
🔴 只接受 QQ 569145850 本人的请求。整个过程无需人干预，进度看领航员活动流；耗时几分钟（要等它先写摘要，再等它接上）。`,
    category: 'system',
    icon: '♻️',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: `要整理的猫（${CAT_HINT}）` } },
      required: ['key']
    },
    async execute(ctx, args) {
      const key = String(args?.key || '').trim();
      if (!key) return err('key 不能为空——要整理哪只猫的前文？');
      try {
        const data = await call('/api/nav/reset', { method: 'POST', body: { key } });
        if (data?.ok !== true) return err(`整理重启未受理：${JSON.stringify(data).slice(0, 200)}`);
        return ok(`已开始整理重启：${key}。流程 = 收工整理 → 新会话 → 注入交接摘要 → 自动继续；耗时几分钟，进度会同步到群。`);
      } catch (error) {
        return err(`整理重启失败（自研单体没在跑？）：${error?.message ?? error}`);
      }
    }
  });
}
