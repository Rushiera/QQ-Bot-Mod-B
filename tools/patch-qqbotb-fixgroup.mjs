// patch-qqbotb-fixgroup.mjs — QQ 群 bot 四项体验修复（幂等补丁）
//
// 用法：node patch-qqbotb-fixgroup.mjs [--dry]
// 来源：2026-10-19 群 785638698 实测判例（design-qqbotb_log.md §六十八）
//
// 做什么（全部在业务面拆包产物 src/ 内）：
//   1) tools.js：新增 buildImagePayload（图片字节 → 视觉部件；协议端缓存与直链共用）
//   2) tools.js：get_message_images 取图改「协议端缓存优先（get_image 认 file 名）→ 直链兜底」
//      —— 判例：18:41「猫想你」gif 直链 404（远程资源失效），协议端本地有缓存却没用上
//   3) tools.js：get_recent_messages 不再叠加 pastStateCount（原会把窗口跳到一周前）
//   4) tools.js：finish 描述补硬规则——正文不发群，要对群里说的话必须走 send_message
//   5) nav-tools.js：tts_speak 描述补「念一下（含念图内文字）= 本工具」触发词
//   6) nav-tools.js：comfy_edit 描述补「重来 → 沿用上一次成功的生成路径」规则
//
// 语义：源码改动的唯一落盘通道——重装应用后按链尾顺序重跑即复现。
// 幂等：每个补丁点带唯一标记 [qqbotb-fixgroup-patch:<id>]；已含标记 = 跳过。
// 边界：不改发送面 / 记忆面 / 领航员状态机；语音配文在单体侧（app/src/navigator/media.js）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const SRC = path.join(APP, 'src');
const DRY = process.argv.includes('--dry');
const results = [];
const mark = (id) => '[qqbotb-fixgroup-patch:' + id + ']';

/** 探测文件换行风格（应用源码可能是 CRLF；片段常量一律按 LF 书写）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 把 LF 片段转换成目标文件的换行风格。 */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 定点替换：锚点必须唯一命中；已应用过则跳过。 */
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

// ─────────────────────────────────────────────────────────────────────────────
// 1) tools.js：新增 buildImagePayload（图片字节 → 视觉部件）
// ─────────────────────────────────────────────────────────────────────────────
patch('image-payload', SRC, 'tools.js',
`async function downloadImageAsDataUrl(url, timeoutMs = 30000) {`,
`/**
 * 图片字节 → 视觉部件（GIF 分叉 + 压缩），直链与协议端缓存共用。
 * 与 downloadImageAsDataUrl 的区别：入口是字节而不是 URL。 ${mark('image-payload')}
 */
async function buildImagePayload(buffer, contentType) {
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  if (isGifBuffer(buffer) && currentGifRoute() === 'video') {
    const video = await gifToVideoDataUrl(buffer);
    if (video) {
      return {
        dataUrl: '',
        gifVideo: {
          dataUrl: video.dataUrl,
          frames: video.frames,
          width: video.width,
          height: video.height
        }
      };
    }
  }
  const compressed = await compressImage(buffer);
  const mime = compressed.compressed ? compressed.mime : (detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0]);
  return {
    dataUrl: \`data:\${mime};base64,\${compressed.buffer.toString('base64')}\`,
    isGif: mime === 'image/gif',
    gifBuffer: isGifBuffer(buffer) ? buffer : null
  };
}

async function downloadImageAsDataUrl(url, timeoutMs = 30000) {`);

// ─────────────────────────────────────────────────────────────────────────────
// 2) tools.js：get_message_images 取图——协议端缓存优先，直链兜底
// ─────────────────────────────────────────────────────────────────────────────
patch('image-cache-first', SRC, 'tools.js',
`        const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
        if (!urls.length) return ok(\`消息 \${args.messageId} 没有可查看的图片\`);
        const results = [];
        const failed = [];
        for (const url of urls) {
          try { results.push(await downloadImageAsDataUrl(url)); } catch (e) { failed.push(String(e?.message ?? e)); }
        }`,
`        const items = (entry.media || []).filter((m) => m.kind === 'image' && (m.url || m.file));
        if (!items.length) return ok(\`消息 \${args.messageId} 没有可查看的图片\`);
        const results = [];
        const failed = [];
        for (const item of items) {
          let payload = null;
          // 协议端缓存优先（get_image 认消息里的 file 名）——QQ 直链带 rkey、约一小时失效；
          // 远程表情资源还可能直接 404（判例：2026-10-19 18:41「猫想你」gif）。 ${mark('image-cache-first')}
          if (item.file) {
            try {
              const ret = await ctx.onebot.call('get_image', { file: String(item.file) });
              const localPath = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
              if (localPath) payload = await buildImagePayload(fs.readFileSync(localPath), '');
            } catch (e) {
              failed.push('协议端缓存：' + String(e?.message ?? e));
            }
          }
          // 直链兜底
          if (!payload && item.url) {
            try { payload = await downloadImageAsDataUrl(item.url); } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (payload) results.push(payload);
        }`);

// ─────────────────────────────────────────────────────────────────────────────
// 3) tools.js：get_recent_messages 的 offset 不再叠加 pastStateCount
// ─────────────────────────────────────────────────────────────────────────────
patch('recent-offset', SRC, 'tools.js',
`      const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });`,
`      // offset 只认自己的值：叠加 pastStateCount 会把窗口直接跳到一周前（判例 2026-10-19 18:41）。 ${mark('recent-offset')}
      const messages = ctx.store.recent(ctx.chatKey, { limit, offset });`);

// ─────────────────────────────────────────────────────────────────────────────
// 4) tools.js：finish 描述——正文不发群
// ─────────────────────────────────────────────────────────────────────────────
patch('finish-desc', SRC, 'tools.js',
`    description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。处于活跃期时，若判断话题已结束/偏离，也用它结束（reason 填"话题结束"）。',`,
`    description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。处于活跃期时，若判断话题已结束/偏离，也用它结束（reason 填"话题结束"）。\\n🔴 你写在正文里的内容不会发到 QQ——要对群里说的话，必须先调 send_message / tts_speak 这类发送工具；正文只当内心思考。 ${mark('finish-desc')}',`);

// ─────────────────────────────────────────────────────────────────────────────
// 5) nav-tools.js：tts_speak 描述补触发词
// ─────────────────────────────────────────────────────────────────────────────
patch('tts-desc', SRC, 'nav-tools.js',
`用途：群里 @ 我 说「生成语音…」「说一句…」「用语音说…」「念一下…」这类**要听声音**的请求时调本工具。`,
`用途：群里 @ 我 说「生成语音…」「说一句…」「用语音说…」「念一下…」「念出来」「读一下」这类**要听声音**的请求时调本工具。
- 「念一下上面图片里的内容 / 念一下这张图」：先用 get_message_images 读图，把**读到的文字**填进 text——读图是手段，念出来才是任务，别只把内容写在正文里就结束。 ${mark('tts-desc')}`);

// ─────────────────────────────────────────────────────────────────────────────
// 6) nav-tools.js：comfy_edit 描述补「重来」规则
// ─────────────────────────────────────────────────────────────────────────────
patch('comfy-retry', SRC, 'nav-tools.js',
`🔴 前置两条：**领航员已开启** + **ComfyDock 在线**——缺哪条回执就说明缺哪条，别硬试、别自己想办法绕。`,
`🔴 前置两条：**领航员已开启** + **ComfyDock 在线**——缺哪条回执就说明缺哪条，别硬试、别自己想办法绕。
🔴 重来 / 再来一次 / 重画：先看上一轮走的哪条路——上一次是 moss_draw 出的图就继续用 moss_draw 重画（带图改图才用本工具）；本工具被前置挡住时回退到上一次可行的路径，别把「要开领航员」当结论抛给用户。 ${mark('comfy-retry')}`);

console.log(JSON.stringify({
  ok: true,
  dry: DRY,
  app: APP,
  results,
  counts: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {})
}, null, 2));
