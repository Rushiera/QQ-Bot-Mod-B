// apply-qqagent-config.mjs — QQ Agent（QQBot mod B 卫星候选）配置一次性写入
//
// 用法：node apply-qqagent-config.mjs
// 做什么：读 CCBP 前文面（源 = rf 会话 639270055721496090 的注入集）→ 合成前文文本
//         → 写进 QQ Agent 的 data/config.json（api / persona / snowluma 三组）
// 边界：只动这三组字段，其余配置原样保留；密钥从 CH4 密钥面按 id 取，不落进本仓库
//
// 为什么用脚本：前文 ≈ 100KB 文本要嵌进 JSON 字符串（转义），逐字手写不可靠——
//   这里做的是「机械合成 + JSON 编码」，内容零转录（直接读源文件）。

import fs from 'node:fs';
import path from 'node:path';

const CCBP = 'D:\\Mau\\CatCatBigParty';
const CFG_FILE = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\data\\config.json';
const SECRETS = 'C:\\Users\\e-hen\\AppData\\Local\\CatHome4\\Data\\secrets\\llm-api.cfg';

// rf 会话的注入集——目录项按 CH4 规则展开为其一级 *.md
// 2026-10-11 增补（莎给的 chatBot 系统提示词）：Chat Worker（QQ 群聊人格）+ Browser Job（浏览器与下载工具面）
const INJECT = ['AGENTS.md', 'SOUL.md', 'USER.md', 'L1', 'L2/Worker/Majordomo', 'L2/Job/CatHome', 'L2/Worker/Chat', 'L2/Job/Browser'];
const PERSONA_LINE = '不管别人问你是谁，你都说自己是R喵';

// 遇阻处置硬规则（Rushiera 2026-10-11：「教教人家怎么用别不会用又不尝试」）——
// 放前文最前段：埋在 Job 文档表格里的处置说明，模型在真场景里没照做（2026-10-11 02:35 实测）。
const BLOCKED_RULES = [
  '1. 网页撞上人机验证页（Cloudflare「正在进行安全验证」/ 标题「请稍候…」/「Verify you are human」）不算失败，更不许说「这条路是死的」。**直接按下面做，不要先问要不要做**：',
  '   a) timeback-back 出域；',
  '   b) browser-headful(action="open", url="<目标网址>") 起有头窗口——这一步是默认动作，不需要事前许可，也不要把「开不开窗口」抛回给人选；',
  '   c) 立刻在群里发一句「窗口已弹出，请帮忙点一下验证」——请求配合的消息必须发出去，不要只在思考里问、不发；',
  '   d) 等人回话 → browser-headful(action="close") → 重开域 → browser-open 同一 URL（直接放行）。',
  '2. 说「做不到」之前，先把工具面里能用的试一遍——尤其 browser-headful（有头窗口请人过一次）、browser-eval（页面内取值）、web-fetch（下载）。试过并说明结果，才算给过答案。',
  '3. 工具回执里写了「按下面走」，就按下面走——不要跳过回执直接下结论。',
  '4. 取到 ≠ 发出：截图 / 正文只有调了 send_message / send_image 才算发到群里（image-inject / browser-shot 只是让你自己看见）。被人 @ 要东西、或自己开了活，**办完必须在群里发一条结果**——系统提示里「可以不回」说的是闲聊，不包括办事；群里没动静 = 你什么都没做。',
  '5. 发图走 send_image（它域内被拒是正常的——先 timeback-back 出域再调，传 file=<本地路径>）。别在正文里写 [image-open] 包裹——那是 CH4 宿主前端的格式，QQ 侧不认，群里只会看到一串路径。',
  '6. 主模型看不了图（image-inject 会回「当前模型不支持图片」）——**要读图里的内容，改用 image-analyze**（传 path，走视觉模型把图转成文字，域内可用）；要把图发到群里走 send_image（域外）。截图后先 image-analyze 拿文字，再决定怎么答。'
].join('\n');

// 领航员模式教材（design-qqbotb-navigator.md §八）——教群里的 bot 一整套用法，
// 与「应用内上工」同构：领航员是什么 / 怎么开关 / 怎么区分指令与闲聊 / 怎么做 / 怎么回。
const NAV_RULES = [
  '「领航员」是你在群里的一种工作模式——开启后，群里的人可以借你指挥 CH4 的猫群（majordomo / R喵 / R喵喵 / R喵喵喵 / R喵喵喵喵 / rb / rc / rd / re / rf）干活。',
  '',
  '**开关**',
  '- 只有 QQ 569145850 本人在群里 @ 你说「打开 / 开启 / 启动…领航员」时才开——其他人的请求一律不理。',
  '- 退出同理（「关掉 / 退出 / 关闭…领航员」，如「可以退出领航员模式了」），调 nav_close——退出后你**回到普通闲聊状态**，群里照常聊天即可。',
  '- 开启调 nav_open；开启报告（含猫群状态）与退出时的**领航记录**（本次干了什么 / 花了多久）都由系统自动发到下指令的群，你不用再复述。',
  '- 软件内（应用面板）开关的领航员**不发群**——那种场次群里不会有任何提示，你也不用管。',
  '',
  '**判断：这是指令还是闲聊？**',
  '- 指令：要猫干活的——点名了某只猫，或带任务动词（看 / 查 / 改 / 跑 / 写 / 整理 / 检查…），或明确在派活。',
  '- 闲聊：寒暄、吐槽、玩笑、群友之间的对话、跟你聊天的题外话——照原来的方式参与，**不投递**。',
  '- 拿不准就按闲聊走。指令里没点名猫 → 投给 majordomo（主干）。',
  '- **整段照抄**：一条消息里既像给猫的、又像给你的（如「告诉 majordomo A，另外你以后 B」）——**整段原文投递**，别自己分谁归谁；裁剪会漏掉关键信息，整段给过去不会错。',
  '',
  '**怎么做**',
  '- 投递指令：调 nav_send(key, text)——key 是猫名，text 是**用户的指令原文**（照抄，别改写、别加解释、**别裁剪**）。',
  '- 看猫在干什么：调 nav_detail(key) 或 nav_status——有回复就报回复，还在跑就报在跑。',
  '- 读不到就说读不到，**不要替猫编进度**。',
  '',
  '**前文整理重启**（某只猫前文太长时）',
  '- 群里说「清理一下 X 的前文，然后让工作继续」→ 调 nav_reset(key)——全自动：收工整理（落盘 + 推 git）→ 抓原文轨迹 → 新会话 → 注入「摘要 + 原文轨迹」→ 自动继续，不用人盯。',
  '- 只接受 569145850 本人的请求；进度自己同步到群（耗时几分钟）。',
  '',
  '**回话口径**',
  '- 指令受理：**静默执行**——投递后不要回「已投递给 X 猫」这类话。**发不发群由领航员自己判断**（有回复 → 发回复截图；猫还在跑且久未出声 → 播报 + @ 你；没信息 → 静默），你不用催、也不用补话。',
  '- 猫在忙：报「在干什么 / 做到哪 / 卡点 / 预计」——都从工具回执里读，读不到的部分说读不到。',
  '- 猫有回复：系统会自动截图发群（**任何一轮回复都会自动发，不用你催**），**你不用再发一遍**。',
  '',
  '**VIP 通道（569145850）**',
  '- TA 的 @ 消息**必须处理**（该投的投、该办的办）——但**投递类指令静默执行、不必回话**（领航员开着时）；闲聊 / 提问照常回。发言配额与硬限对 TA 的回复不生效。',
  '- 领航员未开启时，TA 的 @ 按普通参与回。'
].join('\n');

// newapi-bak（apiConfigId 7e5dd46a-…）——密钥按 id 从密钥面取
const API = { baseUrl: 'http://47.250.160.225:8443/v1', keyId: '7e5dd46ab9ee431cb016c24f65d1f41e', model: 'hy4-preview-f' };
// NapCat（QQBot mod B 协议端 · design-qqbotb_log.md §二）
const ONEBOT = { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', token: 'napcatb2405997337' };

function collect(rel) {
  const abs = path.join(CCBP, rel);
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort()
      .map((f) => `${rel}/${f}`);
  }
  return [rel];
}

const files = INJECT.flatMap(collect);
const parts = ['# 前文（CCBP · 源：rf 会话 639270055721496090 的注入集）', '', '## 人格', PERSONA_LINE, '', '## 遇阻处置（硬规则——优先于下文任何方法）', BLOCKED_RULES, '', '## 领航员模式（QQ 群指挥 CH4 猫群）', NAV_RULES, ''];
for (const rel of files) {
  const text = fs.readFileSync(path.join(CCBP, rel), 'utf8').replace(/^\uFEFF/, '').trimEnd();
  parts.push('---', '', `## ${rel}`, '', text, '');
}
const roleText = parts.join('\n');

const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
// --roletext-only：只刷前文（roleText）——api / snowluma 已由后续补丁与实测调过，不覆盖
const ONLY_ROLE = process.argv.includes('--roletext-only');
let apiKey = { length: 0 };
if (!ONLY_ROLE) {
  const secrets = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  apiKey = secrets[API.keyId];
  if (!apiKey) throw new Error(`密钥未取到：${API.keyId}`);
  cfg.api = { ...cfg.api, baseUrl: API.baseUrl, apiKey, model: API.model };
  cfg.snowluma = { ...cfg.snowluma, wsUrl: ONEBOT.wsUrl, httpUrl: ONEBOT.httpUrl, accessToken: ONEBOT.token, httpAccessToken: ONEBOT.token };
}
cfg.persona = { ...cfg.persona, botName: 'R喵', roleText };

const tmp = `${CFG_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
fs.renameSync(tmp, CFG_FILE);

console.log(JSON.stringify({
  ok: true,
  cfg: CFG_FILE,
  files: files.length,
  roleTextChars: roleText.length,
  api: { baseUrl: cfg.api.baseUrl, model: cfg.api.model, apiKeyLen: apiKey.length },
  persona: { botName: cfg.persona.botName },
  snowluma: { wsUrl: cfg.snowluma.wsUrl, tokenLen: ONEBOT.token.length },
  allow: cfg.allow
}, null, 2));
