// navigator/shot.js —— 回复卡渲染 · 截图 · 图片解读
//
// 职责：把猫的一轮视图块渲染成一张对话卡（HTML）→ 交壳层截图 → 交视觉模型解读。
// 边界：不拉数据（块由 index.js 从 SSE 收集）、不发群（出站在 index.js）。
// 设计：design-qqbotb-navigator.md §六。
//
// 样式与 CH4 内置会话页对齐（Rushiera 2026-10-11 定）——三件同源，DOM 结构照搬会话区：
//   · chat-card.css ← CH4 `/css/tokens.css` + `/css/chat.css`（摘取副本，来源见其文件头）
//   · md.js         ← CH4 `/js/chat/lib/md.js`（副本 + ESM 导出）
//   · DOM          ← `.chat-row` / `.chat-bubble` / `.md-block`（同 CH4 会话区结构）
//   CH4 前端改样式或渲染器后，重新同步上面两件即可继续保持一致。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mdToHtml } from './md.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** 内容字体（Sarasa Mono SC——CH4 前端同款；相对路径在离屏窗口里解析不到，落绝对 file URL）。 */
const FONT_HREF = pathToFileURL(path.join(moduleDir, 'fonts', 'SarasaMonoSC-Regular.ttf')).href;

/** 对话卡样式表（CH4 会话页同源——模块加载时读一次；字体路径改写为绝对 URL）。 */
const CARD_CSS = fs
  .readFileSync(path.join(moduleDir, 'chat-card.css'), 'utf8')
  .replace('../fonts/SarasaMonoSC-Regular.ttf', FONT_HREF);

/** 单张卡最多渲染的块数（防超长）。 */
const MAX_BLOCKS = 40;

/** 视觉调用超时（毫秒）。 */
const VISION_TIMEOUT_MS = 90000;

/**
 * HTML 转义（纯文本块用——MD 正文的转义由 md.js 内部完成）。
 *
 * @param {string} text 原文
 * @returns {string} 转义结果
 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 创建截图服务。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.dataDir 应用数据目录
 * @param {object} options.hooks 壳层能力（shot）
 * @param {object} [options.vision] 视觉端点（baseUrl / apiKey / model）
 * @returns {object} 截图服务
 */
export function createShotService({ log, dataDir, hooks, vision = null }) {
  /**
   * 渲染一轮对话卡 HTML（CH4 会话区同款结构与样式）。
   *
   * 块类型映射：`user` → 右侧用户气泡（纯文本）；`roundsum` → 轮末结算朴素件；
   * `reason` → 思考件；其余（`text`）→ 助手气泡 + MD 渲染正文。
   *
   * @param {object} options 选项
   * @param {string} options.catName 猫名
   * @param {Array<object>} options.blocks 本轮视图块
   * @param {string} [options.at] 时间文本
   * @returns {string} HTML 全文
   */
  function renderCard({ catName, blocks = [], at = '' }) {
    const rows = [];
    for (const block of blocks.slice(-MAX_BLOCKS)) {
      const type = String(block?.renderType ?? block?.type ?? '');
      const text = String(block?.text ?? block?.content ?? '').trim();
      if (!text) continue;
      if (type === 'user') {
        rows.push(`<div class="chat-row user"><div class="chat-bubble">${esc(text)}</div></div>`);
      } else if (type === 'reason') {
        rows.push(`<div class="chat-row assistant" data-type="reason"><div class="chat-bubble">${esc(text)}</div></div>`);
      } else if (type === 'roundsum') {
        rows.push(`<div class="chat-row assistant" data-type="roundsum"><div class="chat-bubble roundsum">${esc(text)}</div></div>`);
      } else {
        rows.push(`<div class="chat-row assistant" data-type="text"><div class="chat-bubble"><div class="md-block">${mdToHtml(text)}</div></div></div>`);
      }
    }
    if (rows.length === 0) {
      rows.push('<div class="chat-row assistant" data-type="text"><div class="chat-bubble"><div class="md-block">（本轮无文本内容）</div></div></div>');
    }
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
${CARD_CSS}
</style></head><body>
  <div id="chatbar"><span class="sid">${esc(catName)}</span><span class="meta">${esc(at)}</span></div>
  <div id="chatMsgs">
  ${rows.join('\n  ')}
  </div>
</body></html>`;
  }

  /**
   * 渲染并截图，返回 PNG 路径。
   *
   * @param {object} options 选项（同 renderCard）
   * @returns {Promise<string>} PNG 绝对路径
   */
  async function shoot(options) {
    if (typeof hooks?.shot !== 'function') throw new Error('截图能力未注册（非 Electron 运行环境）');
    const html = renderCard(options);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlFile = path.join(dataDir, `nav-shot-${stamp}.html`);
    const pngFile = path.join(dataDir, `nav-shot-${stamp}.png`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(htmlFile, html, 'utf8');
    const out = await hooks.shot(htmlFile, pngFile);
    try { fs.unlinkSync(htmlFile); } catch { /* 中介文件清理失败不阻断 */ }
    log.info('navigator', `截图完成：${out}`);
    return out;
  }

  /**
   * 用视觉模型解读截图。
   *
   * @param {string} pngPath 图片路径
   * @param {string} [question] 提问
   * @returns {Promise<string>} 解读文本（失败返回空串）
   */
  async function analyze(pngPath, question = '') {
    if (!vision?.baseUrl || !vision?.apiKey || !vision?.model) {
      log.warn('navigator', '视觉端点未配置，跳过图片解读');
      return '';
    }
    const prompt = question
      || '这是 CH4 猫的会话截图。用两三句中文说清楚：猫做到哪一步了、有没有卡点或异常、下一步在干什么。只描述图里能看到的，不要推测。';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
    try {
      const dataUrl = `data:image/png;base64,${fs.readFileSync(pngPath).toString('base64')}`;
      const response = await fetch(`${vision.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vision.apiKey}` },
        body: JSON.stringify({
          model: vision.model,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }]
          }]
        }),
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      const text = data?.choices?.[0]?.message?.content ?? '';
      return String(text).trim();
    } catch (error) {
      log.warn('navigator', `图片解读失败：${error?.message ?? error}`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  return { renderCard, shoot, analyze };
}
