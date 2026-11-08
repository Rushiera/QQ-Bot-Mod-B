// verify-qqbotb-sticker-image.mjs — 表情包取图三处修复的离线验证（零网络、零写入）
//
// 用法：node tools/verify-qqbotb-sticker-image.mjs
// 覆盖（对应 2026-11-08「群表情包看不到图」判例）：
//   1) onebot.js segmentsToText：image 段带 summary → [表情包:名字] / [表情包] / [图片]
//   2) tools.js get_sticker_image：file:/// 收藏表情走本地字节，不再被 validateImageUrl 拒
//   3) tools.js get_message_images：取图全失败时回执带表情名（模型可据此接话）
// 判据：末行 `VERIFY n/n OK` = 全绿；`VERIFY k/n FAIL` = 逐个列出失败项。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'app', 'src', 'business');
const DATA = path.resolve(HERE, '..', '_unpack', 'data');
const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

// 业务面 config.js 要求显式数据根（单体起子进程时注入）——这里补齐，方能离线加载模块。
if (!process.env.QQ_AGENT_DATA_DIR) process.env.QQ_AGENT_DATA_DIR = DATA;

const { segmentsToText } = await load('onebot.js');
const { buildToolDefs } = await load('tools.js');
buildToolDefs();                                              // 工具注册是调用式，不是 import 副作用
const { getTool } = await load('tool-registry.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
};

// ── 1) 入站渲染：summary 带进文本 ───────────────────────────────────────────
const render = async (data) => String(await segmentsToText([{ type: 'image', data }])).trim();

check('summary=[对的对的] → [表情包:对的对的]', (await render({ summary: '[对的对的]' })) === '[表情包:对的对的]', await render({ summary: '[对的对的]' }));
check('summary=[动画表情] → [表情包]', (await render({ summary: '[动画表情]' })) === '[表情包]', await render({ summary: '[动画表情]' }));
check('summary 缺省 → [图片]', (await render({})) === '[图片]', await render({}));
check('summary 空串 → [图片]', (await render({ summary: '' })) === '[图片]', await render({ summary: '' }));

// ── 2) get_sticker_image：file:/// 收藏表情走本地字节 ──────────────────────
const stickerFile = path.join(DATA, 'stickers.json');
let library = [];
try { library = JSON.parse(fs.readFileSync(stickerFile, 'utf8')); } catch { library = []; }
// 优先挑非 GIF（GIF 会走 ffmpeg 转视频，离线环境不该让它决定验证结果）
const localEntry = library.find((e) => String(e.url || '').startsWith('file:///') && !/\.gif$/i.test(String(e.url)))
  ?? library.find((e) => String(e.url || '').startsWith('file:///'));

if (!localEntry) {
  check('get_sticker_image：库里有 file:/// 条目', false, 'stickers.json 无本地转存条目，跳过该项');
} else {
  const tool = getTool('get_sticker_image');
  const ctx = { stickers: { find: async (ref) => (String(ref) === String(localEntry.id) || String(ref) === String(localEntry.resId) ? localEntry : null) } };
  const r = await tool.execute(ctx, { stickerId: localEntry.id });
  const parts = Array.isArray(r?.content) ? r.content : [];
  const img = parts.find((p) => p?.type === 'image_url');
  const url = String(img?.image_url?.url ?? '');
  check('get_sticker_image：本地 file:/// 能出图片部件', !r?.isError && url.startsWith('data:image/'),
    `${localEntry.id} → ${r?.isError ? r.content : url.slice(0, 32)}`);
}

// ── 3) get_message_images：全失败时回执带表情名 ────────────────────────────
const msgTool = getTool('get_message_images');
const ctxMsg = {
  chatKey: 'group:verify',
  store: {
    findByMid: () => ({
      media: [{ kind: 'image', file: 'x-verify.gif', url: '', summary: '[对的对的]' }]
    })
  },
  onebot: { call: async () => { throw new Error('OneBot get_image 超时（5 秒未完成）'); } }
};
const rm = await msgTool.execute(ctxMsg, { messageId: '1' });
const text = String(rm?.content ?? '');
check('get_message_images：失败回执带表情名', rm?.isError === true && text.includes('这条里的表情：对的对的'), text);
check('get_message_images：失败回执提示别重复调用', text.includes('不要重复调用本工具'), text);

// ── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
console.log(failed.length ? `VERIFY ${failed.length}/${results.length} FAIL` : `VERIFY ${results.length}/${results.length} OK`);
process.exit(failed.length ? 1 : 0);
