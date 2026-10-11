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
//
// 「指令 / 闲聊」的语义判断归模型——本模块不做判定，也不替猫编造进度。
// 依赖：QQBot mod B 自研单体（Electron 应用）在 127.0.0.1:3280 在跑。

import { registerTool } from './tool-registry.js';

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
调用后我（自研单体）会自动在下指令的群发一条健康检查回执；你不需要再复述回执内容，也不要重复发送。`,
    category: 'system',
    icon: '🚀',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const data = await call('/api/nav/open', { method: 'POST', body: { by: 'qq', requireVip: true } });
        if (data.ok === false) return err(`领航员未开启：${data.error ?? '未知原因'}`);
        return ok(`领航员已开启（回执已自动发到下指令的群）。猫群：\n${renderCats(data.health?.cats)}`);
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
    description: `把一条指令投递给 CH4 的某只猫执行（在猫那边显示为「人在 QQ 群里说的话」，与现有 QQ 转发同源）。
- key：猫名或 id——${CAT_HINT}；拿不准目标时传 majordomo。
- text：给猫的**完整指令原文**——照抄用户的话，不要改写、不要加解释、不要加礼貌语。
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

  // ── nav_reset ───────────────────────────────────────────────────────────
  registerTool({
    id: 'nav_reset',
    name: '领航员·前文整理重启',
    description: `把某只猫的前文整理重启——全自动四步：① 让它先做一次收工整理（产出交接摘要）② 清前文开新会话（重新注入知识文件）③ 把交接摘要注入新会话 ④ 让它据此继续工作。
用途：某只猫前文太长、快撑不住上下文时，用户说一句「清理一下 X 的前文，然后让工作继续」就调本工具。
- key：要整理的猫（${CAT_HINT}）。
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
