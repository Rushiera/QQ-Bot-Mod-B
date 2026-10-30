// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
//
// 重构说明：所有工具通过 registerTool() 注册到 tool-registry.js，
// 支持在设置页按卡片勾选启用/禁用。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { skillManager } from './skills/manager.js';
import { validateImageUrl, safeFetchBinary, browseLockState, checkBrowseLock } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { expandForwardNodes } from './onebot.js';
import { registerTool, listTools } from './tool-registry.js';
// 浏览节拍（模型自行调整"多久看一次"）——[qqagent-browse-patch:tools-import]
import { setBrowseLevel, browseState } from './browse-rate.js';
// 回应参数（群 bot 自己调）——[qqagent-rapport-patch:tools-import]
import { getRapport, adjustRapport, cooldownForScore } from './rapport.js';
// 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-import]
import { registerCatTools, imageRoots } from './cat-tools.js';
// 受控根只读文件面（read_file / list_dir）—— [qqagent-fileread-patch:tools-import]
import { registerFileTools } from './file-tools.js';
// 领航员工具组（QQ 群指挥 CH4 猫群）—— [qqagent-navigator-patch:tools-import]
import { registerNavTools } from './nav-tools.js';
import { holidayOn, upcomingHoliday } from './holidays.js';
import { compressImage } from './image-compress.js';
import { localStickerPath } from './sticker-manager.js';
import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';
// 已读前情摘要检索（B22）——[qqagent-readcompact-patch:tools-import]
import { searchReadSegments, readLogStats } from './readlog.js';
import { searchSessionSummaries } from './session-state.js';
// 群记（群级记忆：梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-import]
import {
  GROUP_KINDS, GROUP_KIND_LABEL, appendGroupEntry, listGroupEntries, removeGroupEntry,
  // 归档 + 检索（记忆不节流）——[qqagent-memory-patch:no-throttle-tools-import]
  listArchivedGroupEntries, groupArchiveStats
} from './group-memory.js';

/** 当前配置的 GIF 选路（vision/video 开关组合，规则矩阵见 resolveGifRoute 注释）。 */
function currentGifRoute() {
  const cfg = getConfig();
  return resolveGifRoute({ vision: cfg.api?.vision !== false, video: cfg.api?.video === true });
}

/**
 * 图片字节 → 视觉部件（GIF 分叉 + 压缩），直链与协议端缓存共用。
 * 与 downloadImageAsDataUrl 的区别：入口是字节而不是 URL。 [qqbotb-fixgroup-patch:image-payload]
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
    dataUrl: `data:${mime};base64,${compressed.buffer.toString('base64')}`,
    isGif: mime === 'image/gif',
    gifBuffer: isGifBuffer(buffer) ? buffer : null
  };
}

async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  // GIF 在这里分岔（规则矩阵见 resolveGifRoute）：
  //   vision+video 都开 → 转 mp4 按 video 部件发（llm.js 自动切视频专用模型）；
  //   只开 vision      → GIF 按图片原样发（读不了的模型由 llm.js 的"图片被拒"
  //                      降级路径换首帧重试 —— 见 image-compat 的 llm.retry-advisor）；
  //   vision 没开      → 看图工具整体不可用，不会被调到。
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
    // 转换失败（没 ffmpeg / 文件异常）→ 落到下面的普通图片路径，按原样发
  }
  // 大图片自动压缩（有 ffmpeg 时）：缩到模型可接受的尺寸/体积，降低 token 成本
  const compressed = await compressImage(buffer);
  const mime = compressed.compressed ? compressed.mime : (detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0]);
  return {
    dataUrl: `data:${mime};base64,${compressed.buffer.toString('base64')}`,
    isGif: mime === 'image/gif',
    // 原始 GIF 字节留着：模型拒收 GIF 时降级重试要取首帧（gifFirstFrameDataUrl）。
    // 非 GIF 返回 null，不占内存。
    gifBuffer: isGifBuffer(buffer) ? buffer : null
  };
}

/**
 * 把 downloadImageAsDataUrl 的结果组装成工具返回的 content parts。
 * GIF 转出的视频用 video_url 部件（llm.js 检测到会自动切视频专用模型），
 * 其余仍是 image_url。GIF 按原图（gif-image 路线）发送时：能读 GIF 的模型
 * 看得到动图，读不了的会在网关报错后由 image-compat 的降级路径换首帧重试。
 */
function getImagePartsOrVideo(text, results) {
  const parts = [{ type: 'text', text }];
  const gifAsImage = [];
  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      if (r?.isGif) gifAsImage.push(r);
    }
  }
  if (gifAsImage.length) {
    parts[0].text += `\n（其中 ${gifAsImage.length} 张是 GIF 动图，按原图发送：部分模型只能看到第一帧，读不了时会自动换成首帧重试）`;
  }
  return { content: parts, videoCount: parts.filter((p) => p.type === 'video_url').length };
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 *
 * 重构后：工具定义注册到 tool-registry，这里从 registry 读取并过滤。
 */
export function buildToolDefs() {
  // 确保所有工具已注册（幂等）
  registerAllTools();
  // 加载插件工具（如果还没加载）
  loadPluginTools();
  return listTools();
}

/** 加载插件工具（幂等） */
let pluginToolsLoaded = false;
function loadPluginTools() {
  if (pluginToolsLoaded) return;
  pluginToolsLoaded = true;
  // 插件工具已在 app.js 启动时通过 loadPlugins() 注册到 registry
  // 这里只需要确保 registry 里有它们
}

/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 猫工具链移植（timeback / image-inject / browser-*）—— [qqagent-cattools-patch:tools-register]
  registerCatTools();
  // 受控根只读文件面（read_file / list_dir）—— [qqagent-fileread-patch:tools-register]
  registerFileTools();
  // 领航员工具组 —— [qqagent-navigator-patch:tools-register]
  registerNavTools();

  // ── 浏览节拍调整（[qqagent-browse-patch:tools-register]）──
  // 节拍 = "你多久收到一次新消息"。群里正聊得热、你判断要跟紧一点就升档；
  // 升档只在有效期内有效（期间你在本群说过话就自动续期），不说话自己降回来。
  // ⚠️ 描述里点明"节拍快不等于能多说" —— 发言额度是固定的，越热越要省着说。
  registerTool({
    id: 'set_browse_rate',
    name: '调整浏览节拍',
    description: '调整本群"多久看一次新消息"的节拍。1=每4分钟（默认，慢）2=每2分钟 3=每1分钟（快）。'
      + '群里正聊得热、你判断需要跟紧一点就升档；冷下来不用管，约 15 分钟不参与就自动降回来。'
      + '⚠️ 节拍调快**不会**放宽你的发言额度 —— 反而更要省着说：额度是固定的，一次把话说完就会撞上配额墙，宁可少说、留着后面接。',
    category: 'system',
    icon: '⏱️',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'integer', description: '节拍档位：1=每4分钟 2=每2分钟 3=每1分钟' }
      },
      required: ['level']
    },
    async execute(ctx, args) {
      try {
        if (!String(ctx.chatKey || '').startsWith('group:')) {
          return err('私聊不受浏览节拍影响（消息随时处理），本工具只对群聊有意义。');
        }
        const level = Number(args.level);
        if (!Number.isFinite(level) || level < 1) return err('level 必须是 1 / 2 / 3');
        const st = setBrowseLevel(ctx.chatKey, level);
        return ok({
          level: st.level,
          levelCount: st.levelCount,
          intervalSeconds: Math.round(st.intervalMs / 1000),
          holdMinutes: Math.round(st.holdMs / 60000),
          note: '节拍已更新。不要向群里说"我调了节拍"这类话，正常聊天即可。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
  // ── 回应参数调整（[qqagent-rapport-patch:tools-register]）──
  // 为什么给模型一把"打分刀"：谁在敷衍、谁在认真听，只有读得懂语境的模型能判。
  // 系统只管硬限速与自愈 —— 判断归模型，闸门归系统。
  registerTool({
    id: 'adjust_rapport',
    name: '调整回应参数',
    description: '调整某位群友的「回应参数」（0~100，初始 100）——它衡量这个人现在还想不想跟你聊。\n'
      + '**该降**：你说了话他完全不理、继续自说自话；你的话对他的下一句没有任何影响；'
      + '他说"你不用说话/别吵/太吵了"或明显不耐烦、阴阳你。\n'
      + '**不降**：他下一句明显参考了你说过的话（尤其带上了你结论里的词）；他直接问你、点名你；'
      + '他回你"嗯嗯""好""草"这类敷衍——敷衍也是在听，不降。\n'
      + '分清两件事：同一话题继续往下讲、只是没接你那句 → 小降或不降；一句一个话题地跳开、'
      + '每次都绕开你 → 那是转移话题，降。\n'
      + '分数映射到系统硬限速：0 分时 20 分钟内最多回他 1 条，100 分不额外限速。分数会自己慢慢回升。'
      + '一轮最多调一两次，判不准就不调（不动 = 保持现状）。',
    category: 'memory',
    icon: '📶',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '群友 QQ 号（数字）' },
        delta: { type: 'integer', description: '变化量建议：无视你 / 让你安静 / 明显转移话题 → -20~-10；一般没接但不冒犯 → -5；正常对话 → 0；接住你的话 / 点名问你 → +5~+10' },
        reason: { type: 'string', description: '一句话理由（留在该群友的记录里，下次你能看到）' }
      },
      required: ['userId']
    },
    async execute(ctx, args) {
      const userId = String(args.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(userId)) {
        return err('userId 必须是数字 QQ 号（收到：' + JSON.stringify(args.userId) + '）。先用 get_active_members 查准确 QQ 号。');
      }
      const delta = Math.round(Number(args.delta) || 0);
      if (!delta) {
        const cur = getRapport(ctx.chatKey, userId);
        return ok({ userId, score: cur.score, note: 'delta 为 0，未改动。' });
      }
      // 名字从最近消息里取（提示段与记忆页展示更好认）
      let name = '';
      try {
        const tail = ctx.store.recent(ctx.chatKey, { limit: 60 }) || [];
        const hit = [...tail].reverse().find((m) => m && !m.self && String(m.senderId) === userId);
        if (hit) name = String(hit.senderName || '');
      } catch { name = ''; }
      const r = adjustRapport(ctx.chatKey, userId, delta, { reason: String(args.reason ?? ''), name });
      if (!r) return err('调整失败：缺少 userId');
      const cd = cooldownForScore(r.after);
      return ok({
        userId,
        before: r.before,
        after: r.after,
        delta: r.delta,
        cooldownMinutes: cd < 60000 ? 0 : Math.round(cd / 60000),
        note: '不要向群里说"我调了你的回应参数"这类话。'
      });
    }
  });
  // 消息发送类
  registerTool({
    id: 'send_message',
    name: '发送消息',
    description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊；要发到别处用 send_to）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
    category: 'messaging',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
        atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
      },
      required: ['messages']
    },
    async execute(ctx, args) {
      try {
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
        ctx.emit('session-update', ctx.session.id);
        const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
        return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_to',
    name: '发送到指定会话',
    // 描述动态化：开关关闭时明确说"没权限"，避免模型白试一次；
    // 开启时引导先用 get_chats 查目标。默认关闭（社交敏感操作）。
    description: (() => {
      const cross = getConfig().tools?.crossChatSend === true;
      const base = '把消息发送到另一个群/私聊（不在当前会话里说，而是去别处说）。适用于：有人明确让你转告某人/某群、你主动去私聊某人。';
      return cross
        ? `${base}先用 get_chats 查可用的 chatKey，再传 targetChatKey（形如 group:123 / private:456）。只在有明确理由时使用，不要骚扰别人。`
        : `${base}（当前未开启：管理员可在 设置 → 工具与技能 打开「允许跨会话发送」。）`;
    })(),
    category: 'messaging',
    icon: '📨',
    // 工具级可用性：开关关闭时整组工具不可见（getToolAvailability 的第 5 层），
    // 比描述提示更硬 —— 模型连试的机会都没有。
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        targetChatKey: { type: 'string', description: '目标会话：group:群号 / private:QQ号（用 get_chats 查，不要自己编）' },
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
      },
      required: ['targetChatKey', 'messages']
    },
    async execute(ctx, args) {
      try {
        // 硬校验三连：开关 → 格式 → 白名单。描述里的引导不是安全边界。
        if (getConfig().tools?.crossChatSend !== true) {
          return err('跨会话发送未开启（管理员可在 设置 → 工具与技能 里打开）。');
        }
        const wantTarget = String(args.targetChatKey ?? '').trim();
        if (!/^(group|private):\d+$/.test(wantTarget)) {
          return err('targetChatKey 格式应为 group:群号 或 private:QQ号');
        }
        if (wantTarget === ctx.chatKey) {
          return err(`目标 ${wantTarget} 就是当前会话，直接用 send_message 即可。`);
        }
        const [tKind, tId] = wantTarget.split(':');
        const allow = getConfig().allow || {};
        const allowList = (tKind === 'group' ? allow.groups : allow.private) || [];
        // 白名单空名单口径必须与消息入口 app.allowed() 一致（群/私聊统一：
        // 空名单 + allowAllWhenEmpty 才放行）。曾经私聊在这里无条件放行，
        // 入口拒收私聊、send_to 却能替模型把消息发给任意私聊 QQ —— 同一
        // 白名单概念两处判定相反。
        const allowedAll = allowList.length === 0 && getConfig().allowAllWhenEmpty === true;
        if (!(allowList.map(String).includes(tId) || allowedAll)) {
          return err(`目标 ${wantTarget} 不在白名单内，不能发送。`);
        }
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        const result = await ctx.sender.sendTextBatch(wantTarget, messages, {});
        ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, to: wantTarget })));
        ctx.emit('session-update', ctx.session.id);
        const note = [`已发送到 ${wantTarget}。不要输出汇报。`];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}）`);
        return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_sticker',
    name: '发送表情',
    description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
    category: 'messaging',
    icon: '😀',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
        atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        let sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
        if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
        if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
        // 发送前预检：http 直链（QQ 图床 rkey ~1 小时过期）尽量升级成本地转存，
        // 失败则交给 sender 的三级回退链。本地转存过的条目直通。
        if (typeof ctx.stickers.ensureSendable === 'function') {
          sticker = await ctx.stickers.ensureSendable(sticker);
        }
        // 本地收藏图片（file:/// 路径，收藏时已转存）不走公网 URL 校验，
        // 但必须落在受控的 data/sticker-images/ 目录内 —— 本地库条目若被污染
        // 指向任意本地文件（配置、密钥），不设闸就会被 OneBot 发出去。
        const isLocalFile = String(sticker.url).startsWith('file:///');
        if (isLocalFile) {
          const healed = localStickerPath(sticker.url);
          if (!healed) {
            return err(`表情 ${sticker.id} 的本地图片已丢失（受控收藏目录里找不到它），已拒绝发送`);
          }
          // 搬家自愈：发送用重定位后的受控路径（部署换目录后旧绝对路径已失效）
          sticker.url = `file:///${healed.replace(/\\/g, '/')}`;
        } else {
          try {
            await validateImageUrl(sticker.url);
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
        }
        const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
        ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'list_stickers',
    name: '查看表情库',
    description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
    category: 'sticker',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
        limit: { type: 'integer', description: '最多返回条数，默认 24' }
      }
    },
    async execute(ctx, args) {
      try {
        const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
        return ok(result);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_sticker_image',
    name: '查看表情图片',
    description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
    category: 'sticker',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string', description: '表情 id' } },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const sticker = await ctx.stickers.find(args.stickerId);
        if (!sticker) return err(`找不到表情 ${args.stickerId}`);
        if (!sticker.url) return err('该表情没有图片地址');
        const r = await downloadImageAsDataUrl(sticker.url);
        const built = getImagePartsOrVideo(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [r]);
        if (r.gifVideo) {
          built.content[0].text += `\n（这是 GIF 动图，已转成 ${r.gifVideo.frames} 帧、最长边 ${Math.max(r.gifVideo.width, r.gifVideo.height) || '≤480'}px 的视频输入，画面按视频发给模型）`;
        }
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'sticker_note',
    name: '备注表情',
    description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
    category: 'sticker',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id（list_stickers 返回的那个，照抄不要改）' },
        note: { type: 'string', description: '你的理解/含义' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        usage: { type: 'string', description: '适用场景（可选）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
        if (!entry) return err(`找不到表情 ${args.stickerId}`);
        return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'collect_sticker',
    name: '收藏表情',
    description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
    category: 'sticker',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
        note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && (m.url || m.file));
        if (!imageMedia) return err('该消息没有可收藏的图片');
        // collect 会把图片转存到本地（双保险）并**必定入 QQ 收藏**（add_custom_face，
        // 即 QQ"把图片变成表情"的同款能力）；QQ 入库失败会在 warning 里如实标注
        const saved = await ctx.stickers.collect(args.messageId, {
          url: imageMedia.url || '',
          file: imageMedia.file || '',
          note: String(args.note ?? '')
        });
        return ok({
          collected: true,
          id: saved.id,
          note: saved.localNote,
          emojiId: saved.emojiId || '',
          qqSaved: !!saved.emojiId,
          localSaved: !!saved.localFile,
          ...(saved.qqCollectError
            ? { warning: `已${saved.localFile ? '本地收藏' : '记录'}，但入 QQ 收藏失败：${saved.qqCollectError}` }
            : {})
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_poke',
    name: '拍一拍',
    description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
    category: 'messaging',
    icon: '👋',
    parameters: {
      type: 'object',
      properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
    },
    async execute(ctx, args) {
      try {
        if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
          return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
        }
        let target = args.targetUserId;
        if (target !== undefined && target !== null && String(target).trim() !== '') {
          target = Number(target);
          if (!Number.isInteger(target) || target <= 0) {
            return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
          }
          await ctx.sender.poke(ctx.chatKey, target);
        } else {
          await ctx.sender.poke(ctx.chatKey, null);
        }
        return ok({ poked: true });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_recent_messages',
    name: '查看历史消息',
    description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
    category: 'query',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
        offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
      }
    },
    async execute(ctx, args) {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);
      // offset 只认自己的值：叠加 pastStateCount 会把窗口直接跳到一周前（判例 2026-10-19 18:41）。 [qqbotb-fixgroup-patch:recent-offset]
      const messages = ctx.store.recent(ctx.chatKey, { limit, offset });
      return ok({
        count: messages.length,
        messages: messages.map((m) => ({
          messageId: m.mid ?? undefined,
          time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          // sender 带 QQ 号（与提示词历史同口径）：模型按 id 对齐人，@/拍一拍/记印象才不会指错
          sender: m.self ? '我' : `${m.senderName}${m.senderId ? `(QQ:${m.senderId})` : ''}`,
          senderId: m.self ? undefined : (m.senderId || undefined),
          text: m.text
        }))
      });
    }
  });

  registerTool({
    id: 'read_forward',
    name: '展开转发消息',
    description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id，会过期报错）。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
    category: 'query',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
        if (String(entry.text || '').startsWith('[合并转发 共')) {
          return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
        }
        const r = await ctx.onebot.call('get_forward_msg', { message_id: Number(entry.mid) });
        const nodes = Array.isArray(r?.messages) ? r.messages : [];
        const ex = await expandForwardNodes(nodes);
        if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
        // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
        ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
        return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
      } catch (error) {
        return err(`展开失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'get_active_members',
    name: '查看活跃成员',
    description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
    category: 'query',
    icon: '👥',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
    },
    async execute(ctx, args) {
      const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
      return ok({
        members: members.map((m) => ({
          userId: m.userId,
          name: m.name,
          lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          recentCount: m.count
        }))
      });
    }
  });

  registerTool({
    id: 'get_chats',
    name: '查看可用会话',
    description: '列出机器人参与的会话（chatKey、名字、最近消息时间）。跨会话发送（send_message 的 targetChatKey）前用它查目标。',
    category: 'query',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 20，最大 50' } }
    },
    async execute(ctx, args) {
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
      const chats = ctx.store.listChats()
        .map((key) => ({ key, ...(ctx.store.getChatMeta(key) || {}) }))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
        .slice(0, limit);
      return ok({
        count: chats.length,
        chats: chats.map((c) => ({
          chatKey: c.key,
          lastActive: c.lastTs ? new Date(c.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
          recentText: String(c.lastText || '').slice(0, 30)
        }))
      });
    }
  });

  registerTool({
    id: 'get_message_detail',
    name: '查看消息详情',
    description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
    category: 'query',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
      if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
      return ok({
        messageId: entry.mid,
        time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
        sender: entry.self ? '我' : entry.senderName,
        senderId: entry.senderId,
        text: entry.text,
        reply: entry.reply
      });
    }
  });

  registerTool({
    id: 'get_message_images',
    name: '查看消息图片',
    description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
    category: 'query',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const items = (entry.media || []).filter((m) => m.kind === 'image' && (m.url || m.file));
        if (!items.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
        const results = [];
        const failed = [];
        for (const item of items) {
          let payload = null;
          // 协议端缓存优先（get_image 认消息里的 file 名）——QQ 直链带 rkey、约一小时失效；
          // 远程表情资源还可能直接 404（判例：2026-10-19 18:41「猫想你」gif）。 [qqbotb-fixgroup-patch:image-cache-first]
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
        }
        if (!results.length) return err(`图片获取失败：${failed.join('；')}`);
        const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
        // GIF 动图可能被转成了视频部件（见 downloadImageAsDataUrl），文案里区分张数
        const videoCount = results.filter((r) => r?.gifVideo).length;
        const imageCount = results.length - videoCount;
        const what = [
          imageCount ? `${imageCount} 张图片` : '',
          videoCount ? `${videoCount} 段视频（由 GIF 动图转换，≤480px/≤24帧）` : ''
        ].filter(Boolean).join(' + ');
        const built = getImagePartsOrVideo(`消息 ${args.messageId} 的内容${note}：${what}。`, results);
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // [qqagent-memory-patch:tools-append]
  registerTool({
    id: 'memory_append',
    name: '记录记忆',
    description: '记一条长期记忆（下次运行会自动看到）。category=member：对某位群友的印象（必须给 userId）——他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题。category=group：本群的事（必须给 kind）——lore 群内梗/黑话；rule 群规/约定/边界；relation 群内关系/角色；project 长期项目/关注点；topic 最近在聊什么/没聊完的事。判断标准只有一条："下次进这个群还用得上吗"——用得上就记，宁可多记（重复和过时的条目由整理轮合并），别因为怕记错把该记的漏掉。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=对某位群友的印象（需 userId）；group=本群的事（需 kind）' },
        kind: { type: 'string', enum: ['lore', 'rule', 'relation', 'project', 'topic'], description: 'category=group 时必填：lore 梗/黑话 · rule 群规/约定 · relation 关系/角色 · project 长期项目 · topic 在聊什么' },
        userId: { type: ['integer', 'string'], description: 'category=member 时必填：对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字（备注名/群名片/昵称），仅 category=member 用' },
        content: { type: 'string', description: '内容（≤120字，稳定、可跨多次聊天使用）' }
      },
      required: ['category', 'content']
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      const content = String(args.content ?? '').trim();
      // group：本群的事（梗 / 群规 / 关系 / 项目 / 在聊什么）——[qqagent-memory-patch:tools-append-group]
      if (category === 'group') {
        const kind = String(args.kind ?? '').trim();
        if (!GROUP_KINDS.includes(kind)) {
          return err('category=group 时 kind 必填，取值：' + GROUP_KINDS.join(' / ') + '（' + GROUP_KINDS.map((k) => k + '=' + GROUP_KIND_LABEL[k]).join('，') + '）');
        }
        if (!content) return err('content 不能为空');
        const entry = appendGroupEntry(ctx.chatKey, kind, content);
        if (!entry) return err('群记写入失败：内容为空或分类非法');
        return ok({ saved: true, category: 'group', entry });
      }
      // member：对某位群友的印象（默认；兼容旧枚举值 memberImpression）
      const userId = String(args.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(userId)) {
        return err('userId 必须是数字 QQ 号（收到：' + JSON.stringify(args.userId) + '）。先用 get_active_members 查准确 QQ 号再记。');
      }
      if (!content) return err('content 不能为空');
      const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', content, {
        userId,
        target: String(args.target ?? '').trim()
      });
      return ok({ saved: true, entry });
    }
  });

  // [qqagent-memory-patch:tools-query]
  registerTool({
    id: 'memory_query',
    name: '查询记忆',
    description: '查看当前会话里的长期记忆。category=member 看群友印象（不传 userId 返回全部）；category=group 看群记（本群的梗/群规/关系/项目/在聊什么）。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=群友印象；group=群记' },
        userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象（category=member）' }
      }
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      if (category === 'group') {
        // [qqagent-memory-patch:tools-query-group]
        return ok({ group: listGroupEntries(ctx.chatKey) });
      }
      const mem = ctx.memory.query(ctx.chatKey);
      const userId = String(args.userId ?? '').trim();
      const list = userId
        ? mem.memberImpression.filter((e) => String(e.userId) === userId)
        : mem.memberImpression;
      return ok({ memberImpression: list });
    }
  });

  // [qqagent-memory-patch:no-throttle-tools-search] 记忆检索（跨现行池 + 归档）
  registerTool({
    id: 'memory_search',
    name: '检索记忆',
    description: '按关键词检索本会话的长期记忆——现行池与归档一起搜；category=history 还能搜【前情提要】的旧聊天摘要与历次会话要点。想确认"以前是不是聊过/记过某件事"、或【记忆】段里写了"另有 N 条已归档"时用它。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（大小写不敏感；留空 = 只列最近若干条）' },
        category: { type: 'string', enum: ['all', 'member', 'group', 'history'], description: '搜哪一轴（默认 all；history=前情提要/旧会话要点）' },
        includeArchived: { type: 'boolean', description: '是否连归档一起搜（默认 true）' },
        limit: { type: ['integer', 'string'], description: '每轴最多返回几条（默认 20）' }
      }
    },
    async execute(ctx, args) {
      const keyword = String(args.keyword ?? '').trim();
      const category = String(args.category ?? 'all').trim();
      const includeArchived = args.includeArchived !== false;
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const kw = keyword.toLowerCase();
      const out = {};
      if (category === 'all' || category === 'member') {
        const live = ctx.memory.query(ctx.chatKey).memberImpression
          .filter((e) => !kw || String(e.content).toLowerCase().includes(kw));
        out.memberImpression = live.slice(-limit).reverse();
        if (includeArchived) {
          const arch = ctx.memory.searchMemberArchive(ctx.chatKey, { keyword, limit });
          if (arch.length) out.memberImpressionArchived = arch;
        }
      }
      if (category === 'all' || category === 'group') {
        const live = listGroupEntries(ctx.chatKey)
          .filter((e) => !kw || String(e.content).toLowerCase().includes(kw));
        out.group = live.slice(-limit);
        if (includeArchived) {
          const arch = listArchivedGroupEntries(ctx.chatKey, { keyword, limit });
          if (arch.length) out.groupArchived = arch;
        }
      }
      // 已读前情摘要 + 历次会话要点（B22）——[qqagent-readcompact-patch:tools-memory-search-history]
      if (category === 'all' || category === 'history') {
        const hist = searchReadSegments(ctx.chatKey, { keyword, limit, includeArchived });
        if (hist.live.length) out.history = hist.live;
        if (hist.archived.length) out.historyArchived = hist.archived;
        const sess = searchSessionSummaries(ctx.chatKey, { keyword, limit });
        if (sess.length) out.sessionSummaries = sess;
      }
      const gArch = groupArchiveStats(ctx.chatKey);
      out.archive = {
        group: gArch.count,
        member: ctx.memory.memberArchiveStats(ctx.chatKey).count,
        history: readLogStats(ctx.chatKey).archived
      };
      return ok(out);
    }
  });

  // [qqagent-memory-patch:tools-remove]
  registerTool({
    id: 'memory_remove',
    name: '删除记忆',
    description: '删除一条过时/不再准确的记忆。category=member：按 userId（QQ 号，优先）或 target（名字）删，两者都不传则删该群友全部印象。category=group：按 id 或 kind+content 删群记条目。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['member', 'group'], description: '记忆分类：member=群友印象；group=群记' },
        id: { type: 'string', description: 'category=group 时可选：群记条目 id（memory_query 里能看到）' },
        kind: { type: 'string', enum: ['lore', 'rule', 'relation', 'project', 'topic'], description: 'category=group 时可选：按分类删' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
        target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
        content: { type: 'string', description: '可选：只删这条内容' }
      },
      required: ['category']
    },
    async execute(ctx, args) {
      const category = String(args.category ?? 'member').trim();
      if (category === 'group') {
        // [qqagent-memory-patch:tools-remove-group]
        const removed = removeGroupEntry(ctx.chatKey, {
          id: String(args.id ?? '').trim(),
          kind: String(args.kind ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
      const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
        userId: String(args.userId ?? '').trim(),
        target: String(args.target ?? '').trim(),
        content: String(args.content ?? '').trim()
      });
      return ok({ removed });
    }
  });

  registerTool({
    id: 'report_feedback',
    name: '反馈问题',
    description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
    category: 'system',
    icon: '📢',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warning', 'error'], description: '反馈等级：info=提示 / warning=警告 / error=出错' },
        message: { type: 'string', description: '反馈内容（一句话说清哪里有问题）' }
      },
      required: ['message']
    },
    async execute(ctx, args) {
      const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
      ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
      ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
      return ok({ reported: true });
    }
  });

  registerTool({
    id: 'web_search',
    name: '联网搜索',
    description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
    category: 'web',
    icon: '🔍',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const result = await webSearch(String(args.query ?? ''));
        if (!result.results.length) {
          return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
        }
        return ok(result);
      } catch (error) {
        return err(`搜索失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'web_fetch',
    name: '抓取网页',
    description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
    category: 'web',
    icon: '📄',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        // 浏览锁定开启时逐跳校验白名单（与 send_image/search_images 同一口径；
        // 曾经漏传导致锁定形同虚设）
        const result = await webFetch(String(args.url ?? ''), { browseLocked: browseLockState().enabled });
        const body = String(result.body || '');
        return ok({
          url: result.url,
          statusCode: result.statusCode,
          truncated: result.truncated || body.length > 20000,
          content: body.slice(0, 20000)
        });
      } catch (error) {
        return err(`抓取失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'finish',
    name: '结束会话',
    description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。处于活跃期时，若判断话题已结束/偏离，也用它结束（reason 填"话题结束"）。\\n🔴 你写在正文里的内容不会发到 QQ——要对群里说的话，必须先调 send_message / tts_speak 这类发送工具；正文只当内心思考。 [qqbotb-fixgroup-patch:finish-desc]',
    category: 'system',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）。活跃期判断话题结束时填"话题结束"' },
        activeTopic: { type: 'string', description: '开启活跃期时才填：用一句话概括当前聊天的话题大方向（15字内，如"周末去哪玩"）。仅在【活跃模式】未激活、而这次对话确实值得你持续参与时填写；平时不要填。' }
      },
      required: ['summary']
    },
    async execute(ctx, args) {
      ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
      // 活跃模式（chatActive）：模型在 finish 时带回话题总结。
      // orchestrator 读取 session.activeTopic 决定是否开启/维持活跃期。
      const topic = String(args.activeTopic ?? '').trim();
      if (topic) ctx.session.activeTopic = topic.slice(0, 60);
      return ok({ finished: true });
    }
  });

  // ── 提醒（闹钟/计时）──
  registerTool({
    id: 'set_reminder',
    name: '设置提醒',
    description: '设置一个定时提醒（闹钟）。到点后机器人会在当前群里主动发一条提醒消息。适用：群友说"X分钟后提醒我"、"明天早上叫我"、"X点提醒我吃饭"。delayMinutes（多少分钟后）和 atTime（具体时间，如"18:30"或"2026-09-12 08:00"）二选一。',
    category: 'system',
    icon: '⏰',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容（到点要发的话，如"该吃饭了"、"你让提醒你的：开会"）' },
        delayMinutes: { type: 'number', description: '多少分钟后提醒（与 atTime 二选一）' },
        atTime: { type: 'string', description: '具体时间提醒，格式 "HH:MM"（今天/明天）或 "YYYY-MM-DD HH:MM"（与 delayMinutes 二选一）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) return err('提醒内容为空');
      let dueAt = null;
      if (args.delayMinutes != null && Number(args.delayMinutes) > 0) {
        dueAt = Date.now() + Number(args.delayMinutes) * 60000;
      } else if (args.atTime) {
        dueAt = parseAtTime(String(args.atTime));
        if (!dueAt) return err('时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"');
        if (dueAt <= Date.now()) return err('这个时间已经过了，请给个未来的时间');
      } else {
        return err('请提供 delayMinutes（多少分钟后）或 atTime（具体时间）之一');
      }
      if (!ctx.reminders) return err('提醒服务未启用');
      const entry = ctx.reminders.add({ chatKey: ctx.chatKey, text, dueAt, createdBy: String(ctx.selfId || '') });
      const when = new Date(dueAt);
      const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      return ok({ set: true, id: entry.id, dueAt, note: `已设置提醒：${whenStr} 到点我会在本群说「${text}」。` });
    }
  });

  registerTool({
    id: 'list_reminders',
    name: '查看提醒',
    description: '查看当前会话里还没触发的所有提醒（闹钟）。适用：群友问"我设了什么提醒"、"还有哪些闹钟"。',
    category: 'system',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const list = ctx.reminders.pending(ctx.chatKey);
      if (!list.length) return ok({ count: 0, note: '当前没有待触发的提醒。' });
      const lines = list.map((r) => {
        const d = new Date(r.dueAt);
        const whenStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `- [${r.id}] ${whenStr}：${r.text}`;
      });
      return ok({ count: list.length, reminders: lines.join('\n') });
    }
  });

  registerTool({
    id: 'cancel_reminder',
    name: '取消提醒',
    description: '取消一个还没触发的提醒（闹钟）。id 从 list_reminders 获取。适用：群友说"取消那个提醒"、"别提醒我了"。',
    category: 'system',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要取消的提醒 id（list_reminders 里 [r_xxx] 那个）' } },
      required: ['id']
    },
    async execute(ctx, args) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const id = String(args.id ?? '').trim();
      if (!id) return err('请提供提醒 id');
      const ok_ = ctx.reminders.cancel(id);
      return ok_ ? ok({ cancelled: true, id }) : err(`没找到提醒 ${id}（可能已触发或 id 不对，用 list_reminders 查一下）`);
    }
  });

  // ── 节假日问候 ──
  registerTool({
    id: 'check_holiday',
    name: '查询节日',
    description: '查询今天或最近有什么节日（春节/中秋/端午/元旦/国庆等中国法定与常见节日）。用于在节日时主动向群友送上问候。适用：想知道"今天是什么节日"、"最近有什么节日可以蹭个祝福"。返回节日名称与一句参考祝福语，你可以据此自然发挥（别照抄）。',
    category: 'system',
    icon: '🎉',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往后查几天内的最近节日（默认 7 天；0 表示只查今天）' }
      }
    },
    async execute(ctx, args) {
      const today = holidayOn(new Date());
      const days = args.days != null ? Math.max(0, Number(args.days) || 0) : 7;
      const upcoming = upcomingHoliday(days);
      const out = {
        today: today ? { name: today.name, greeting: today.greeting, type: today.type } : null,
        upcoming: upcoming ? { name: upcoming.name, date: upcoming.date, daysAway: upcoming.daysAway, greeting: upcoming.greeting } : null
      };
      let note;
      if (today) {
        note = `今天是${today.name}！可以自然地送上祝福（参考：${today.greeting}）。`;
      } else if (upcoming) {
        note = upcoming.daysAway === 0
          ? `今天是${upcoming.name}。`
          : `今天不是节日。最近的是 ${upcoming.daysAway} 天后的${upcoming.name}（${upcoming.date}）。`;
      } else {
        note = `今天不是节日，未来 ${days} 天内也没有常见节日。`;
      }
      return ok({ ...out, note });
    }
  });

  // ── 发网图（send_image / search_images）────────────────────────────────
  //
  // 补的是一个明显缺口：此前机器人只能发 QQ 收藏的表情（send_sticker），
  // **无法主动发一张网上找的图**。
  //
  // 安全校验：预览确认、字节魔数校验、safe-fetch（SSRF 防护 + 限量 + 浏览锁定）。
  registerTool({
    id: 'send_image',
    name: '发送网图',
    description: '把一张图片发到当前聊天——url 给 http(s) 图片直链（网图），或**本地图片绝对路径**（如 browser-shot 刚截的 PNG，限浏览器产物目录 / 数据目录 / 临时目录内）。默认需要先预览确认（send_image(url, preview=true) 看一眼，再 send_image(url) 发出）。只支持 png/jpg/gif/webp；网页地址不是图片。',
    category: 'media',
    icon: '🖼️',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链（要整条照抄，不要改动路径字符）' },
        preview: { type: 'boolean', description: 'true = 先只给自己看一眼、不发送' },
        note: { type: 'string', description: '可选：配一句话一起发' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填 QQ 号）' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const opt = cfg.security?.imageSend || {};

        const url = String(args.url ?? '').trim();
        if (!url) return err('url 不能为空');
        // ── 本地图（受控根内）也可发 ── [qqagent-cattools-patch:send-image-local] ──
        // browser-shot 的截图落在浏览器产物目录（本地 PNG）；入口只认 http(s) 会让
        // 「截图发群」整条链断掉（判例 2026-10-11：猫截了图只能改发文字描述）。
        // 本地路径限白名单根内（与 image-inject 同口径，单一真相源 imageRoots()），越界一律拒。
        const isLocal = !/^https?:\/\//i.test(url);
        let localPath = '';
        if (isLocal) {
          localPath = path.resolve(url);
          const roots = imageRoots();
          const inside = roots.some((r) => localPath === r
            || localPath.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
          if (!inside) {
            return err(`本地图片只能取允许根目录下的文件（当前根：${roots.join(' / ')}）——网图请给 http(s) 直链`);
          }
          if (!fs.existsSync(localPath)) return err(`图片文件不存在：${localPath}`);
        }
        // 每次运行的状态挂在 ctx 上（ctx 每次运行新建，天然隔离、不用持久化）
        ctx.sendImageState = ctx.sendImageState || { previewed: [], previews: 0, sent: 0 };
        const st = ctx.sendImageState;

        const isPreview = args.preview === true;
        const lock = cfg.security?.browseLock || {};
        // 浏览锁定站点内的图可跳过预览：站内图源可信，省一轮
        const lockCheck = checkBrowseLock(url, browseLockState());
        const trusted = lockCheck.enabled && lockCheck.allowed && opt.skipPreviewForLockedHosts !== false;

        if (!isPreview) {
          if (opt.requirePreview !== false && !trusted && !st.previewed.includes(url)) {
            return err('发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。');
          }
          if (st.sent >= Math.max(1, Number(opt.maxPerRun) || 3)) {
            return err(`本次运行已经发了 ${st.sent} 张图，达到上限（设置里可调）。`);
          }
        } else if (st.previews >= Math.max(1, Number(opt.maxPreviewsPerRun) || 5)) {
          return err(`本次运行预览次数已达上限（${st.previews} 次）。挑最有把握的一张直接发。`);
        }

        // 下载：safe-fetch 全套防护（DNS 固定、逐跳校验、限量、浏览锁定）
        const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
        let buffer;
        let contentType;
        if (isLocal) {
          try {
            const stat = fs.statSync(localPath);
            if (stat.size > maxBytes) {
              return err(`本地图片过大（${Math.round(stat.size / 1048576)}MB，上限 ${Math.round(maxBytes / 1048576)}MB）`);
            }
            buffer = fs.readFileSync(localPath);
            contentType = '';
          } catch (error) {
            return err(`本地图片读取失败：${error?.message ?? error}`);
          }
        } else {
          try {
            ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: !!lock.enabled }));
          } catch (error) {
            const msg = String(error?.message ?? error);
            // 404 多半是模型抄 URL 时手抖（实测把 /2026/04/xx.jpg 抄成 /2026-04-xx.jpg），
            // 提醒它原样复制，别自己"修复"路径
            const hint = /HTTP 404/.test(msg)
              ? '（地址可能抄错了：请从 web_fetch / search_images 返回的 images 里原样复制，不要改动路径字符；也可能是图已删除）'
              : '';
            return err(`图片下载失败：${msg}${hint}`);
          }
        }
        if (!buffer || !buffer.length) return err('图片内容为空');

        // 魔数校验：只认真图。很多"图片链接"其实返回 HTML（防盗链页/错误页）
        const mime = detectMime(buffer);
        if (!mime) {
          const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
            return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
          }
          return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
        }

        const b64 = buffer.toString('base64');
        if (isPreview) {
          st.previews += 1;
          if (!st.previewed.includes(url)) st.previewed.push(url);
          // 问图片格式兼容 Skill：这种格式能不能喂给当前模型。
          // webp/avif 在部分本地视觉接口会直接 400，那会把整轮打挂 ——
          // 比"这轮看不到图"严重得多，所以改成字节校验后让模型自己决定发不发。
          let supported = true;
          try {
            for (const p of skillManager.getCapabilityProviders('image.mime-support', {})) {
              const r = p.fn({ mime });
              if (r && r.supported === false) supported = false;
              break;
            }
          } catch { /* 能力坏了不影响预览 */ }

          if (!supported) {
            return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。当前视觉接口不支持 ${mime}，看不到画面内容，但字节已校验过是真图、QQ 里能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
          }
          return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——觉得合适就立刻调 send_image(url) 发出去：`, [`data:${mime};base64,${b64}`]) };
        }

        // 传 url 而不是只传 base64：OneBot 的 image 段原生支持 http 直链，让**协议端
        // 自己去下载**，body 从 MB 级降到几十字节。而 base64 内联走 HTTP body 时，
        // 5MB 的图（本工具 maxBytesMB 默认值）base64 后 6.7MB，很容易撞上发送超时 ——
        // 这正是"图画出来了但发不出去"的同一个根因。
        // `url` 是刚经 safe-fetch 校验并成功下载过的地址，交给协议端取是安全的。
        // 保留 dataUrl 作为回退：协议端取不到时（防盗链 / 协议端在别的机器）自动改用 base64。
        // 本地图：传 file 路径让协议端自己读磁盘（body 从 MB 级降到百字节），dataUrl 作回退
        const result = await ctx.sender.sendImage(ctx.chatKey,
          isLocal ? { file: localPath, dataUrl: `base64://${b64}` } : { url, dataUrl: `base64://${b64}` }, {
          note: args.note,
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        st.sent += 1;
        ctx.session.sent.push({
          type: 'image',
          text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'search_images',
    name: '搜索网图',
    description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑一条用 send_image(url) 发出去。被要求"发张图/来点表情/找张照片"时用它。',
    category: 'web',
    icon: '🔎',
    requiresVision: false,
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（越具体越准）' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const query = String(args.query ?? '').trim();
        if (!query) return err('query 不能为空');
        const limit = Math.min(12, Math.max(1, Number(args.limit) || 8));

        // 动态取图搜能力：特性检测，避免 web-search 缺这个函数时整个注册就崩
        let searchImages = null;
        try {
          const mod = await import('./web-search.js');
          searchImages = typeof mod.searchImages === 'function' ? mod.searchImages : null;
        } catch { /* 下面统一报错 */ }
        if (!searchImages) {
          return err('图搜能力不可用（web-search 里没有 searchImages）。请用 web_search 找图片页面，再用 web_fetch 拿 images。');
        }

        const list = await searchImages(query, { limit, browseLocked: browseLockState().enabled });
        if (!Array.isArray(list) || !list.length) {
          return ok({ query, results: [], note: '没搜到图。换个更具体的关键词再试一次（最多搜 3 次）。' });
        }
        return ok({
          query,
          results: list.slice(0, limit).map((r) => ({ title: String(r?.title ?? '').slice(0, 60), url: String(r?.url ?? '') })),
          note: '挑一条用 send_image(url) 发出去；url 要整条照抄，不要改。都不贴切就换个更具体的词再搜一次（最多搜 3 次）。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 视频读取 ──
  registerTool({
    id: 'read_video',
    name: '读取视频',
    description: '读取消息里的视频。会返回时长/分辨率等元信息，并根据设置页的「视频模式」把画面交给模型：原生视频输入（全模态模型）或抽帧截图（普通视觉模型）。适用：群友发了一个视频，你想"看看"里面是什么。需要消息 id（聊天记录里的 #数字）。',
    category: 'query',
    icon: '🎬',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条带视频的消息的 QQ 消息 id（聊天记录里的 #数字）' },
        frames: { type: ['integer', 'string'], description: '可选：本次要抽几帧（1~12）。不传用设置页的默认值。' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const videoMedia = (entry.media || []).find((m) => m.kind === 'video');
        if (!videoMedia) return err('该消息没有视频（媒体里没有 video 段）');
        if (!ctx.videoReader) return err('视频读取服务未启用');
        const info = await ctx.videoReader.probe(videoMedia, { count: Number(args.frames) || 0 });

        // 元信息（不含画面）单独作为文本返回。
        // ⚠️ 必须把画面字段剥掉再序列化：
        //    以前是把 frameDataUrl（base64 图片）直接塞进这个 JSON 字符串，
        //    结果整张图被当成**文本**送进上下文 —— 模型既看不到图，
        //    又要为几十万 token 的 base64 付钱。画面一律走下面的 parts。
        const metaOut = {
          messageId: entry.mid,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          sizeBytes: info.sizeBytes,
          format: info.format,
          route: info.route,
          routeReason: info.routeReason,
          frameCount: Array.isArray(info.frames) ? info.frames.length : 0,
          frameTimes: info.frameTimes,
          note: info.note || '已读取视频信息。'
        };
        const metaText = JSON.stringify(metaOut, null, 1);

        // 原生视频输入：把视频地址作为 video 部分交给模型（由 llm.js 换成 videoModel）
        if (info.route === 'native' && info.nativeUrl) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（画面已作为视频输入发送）` },
              { type: 'video_url', video_url: { url: info.nativeUrl } }
            ]
          };
        }

        // 抽帧：每一帧作为一个 image 部分交给模型
        if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（以下 ${info.frames.length} 张是抽帧截图，不是连续视频）` },
              ...info.frames.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          };
        }

        // 只给元信息（off / 抽帧不可用 / 全模态模型没配）
        return ok(metaOut);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
}

/** 解析 "HH:MM" 或 "YYYY-MM-DD HH:MM" 为时间戳；解析不了返回 null。 */
function parseAtTime(raw) {
  const s = String(raw || '').trim();
  // YYYY-MM-DD HH:MM；严格校验边界，避免 Date 把 2 月 31 日归一化成 3 月 3 日
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59
      || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) return null;
    return d.getTime();
  }
  // HH:MM（今天；若已过则明天）
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 今天已过 → 明天
    return d.getTime();
  }
  return null;
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.id || d.name,   // 优先用 id（英文标识），兼容旧版 name 字段
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  // 兼容：name 可能是 id（英文）或 name（中文显示名）
  const def = defs.find((d) => d.id === name || d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
