// navigator/shot.js —— 回复卡渲染 · 截图 · 图片解读
//
// 职责：把猫的一轮视图块渲染成一张对话卡（HTML）→ 交壳层截图 → 交视觉模型解读。
// 边界：不拉数据（块由 index.js 从 SSE 收集）、不发群（出站在 index.js）。
// 设计：design-qqbotb-navigator.md §六（截图走自渲染，不依赖 CH4 前端滚动与懒加载）。

import fs from 'node:fs';
import path from 'node:path';

/** 单张卡最多渲染的块数（防超长）。 */
const MAX_BLOCKS = 40;

/** 视觉调用超时（毫秒）。 */
const VISION_TIMEOUT_MS = 90000;

/**
 * HTML 转义。
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
   * 渲染一轮对话卡 HTML。
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
        rows.push(`<div class="row user"><div class="bubble">${esc(text)}</div><div class="tag">用户</div></div>`);
      } else if (type === 'reason') {
        rows.push(`<div class="row"><div class="bubble reason">${esc(text)}</div><div class="tag">思考</div></div>`);
      } else if (type === 'roundsum') {
        rows.push(`<div class="row"><div class="bubble sum">${esc(text)}</div></div>`);
      } else {
        rows.push(`<div class="row"><div class="bubble">${esc(text)}</div><div class="tag">${esc(catName)}</div></div>`);
      }
    }
    if (rows.length === 0) rows.push('<div class="row"><div class="bubble">（本轮无文本内容）</div></div>');
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px; width: 760px; background: #0f1115; color: #e6e6e6;
         font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 15px; line-height: 1.6; }
  .head { display: flex; align-items: baseline; gap: 10px; padding-bottom: 10px; margin-bottom: 14px;
          border-bottom: 1px solid #262b33; }
  .head b { font-size: 17px; color: #7fd1ff; }
  .head span { color: #6b7480; font-size: 13px; }
  .row { display: flex; flex-direction: column; margin-bottom: 14px; }
  .row.user { align-items: flex-end; }
  .bubble { max-width: 88%; padding: 10px 14px; border-radius: 12px; background: #1a1f27;
            border: 1px solid #262b33; white-space: pre-wrap; word-break: break-word; }
  .row.user .bubble { background: #1d3346; border-color: #2b4d68; }
  .bubble.reason { color: #9aa4b0; font-size: 13px; font-style: italic; }
  .bubble.sum { color: #7a8492; font-size: 12px; border-style: dashed; }
  .tag { margin-top: 4px; font-size: 12px; color: #6b7480; }
</style></head><body>
  <div class="head"><b>${esc(catName)}</b><span>${esc(at)}</span></div>
  ${rows.join('\n  ')}
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
