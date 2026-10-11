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
  '- 发群口径：**群里开启 → 开工报告发那个群；群里退出 → 领航记录发退出的那个群**（本次干了什么 / 花了多久）。两个动作各按各自的发生地算，跨群也一样（a 群开、b 群退 → 开工报告发 a 群，领航记录发 b 群）。',
  '- **超时自关**（全猫停工满 30 分钟）：发到**最后一次群内下指令的那个群**——软件内开启但你在群里下过指令的场次，超时也发群；从未有群内指令就静默。',
  '- **软件内开关、且没有群内指令**的场次**不发群**——群里不会有任何提示，你也不用补。',
  '- 🔴 **开关状态看实况，不凭印象**——`nav_status` 回执就是唯一真相：你只知道自己关过的那次，软件内（应用面板）开的场次不会通知你，群里也看不到提示。拿不准就先查一次；查不到就说查不到。',
  '- **已经是领航员时不要再调 nav_open**——重复开启不会重发任何东西（系统侧已做幂等），但那是无意义动作。',
  '',
  '**判断：这是指令还是闲聊？**',
  '- 指令：要猫干活的——点名了某只猫，或带任务动词（看 / 查 / 改 / 跑 / 写 / 整理 / 检查…），或明确在派活。',
  '- 闲聊：寒暄、吐槽、玩笑、群友之间的对话、跟你聊天的题外话——照原来的方式参与，**不投递**。',
  '- 拿不准就按闲聊走。指令里没点名猫 → 投给 majordomo（主干）。',
  '- **整段照抄**：一条消息里既像给猫的、又像给你的（如「告诉 majordomo A，另外你以后 B」）——**整段原文投递**，别自己分谁归谁；裁剪会漏掉关键信息，整段给过去不会错。',
  '',
  '**怎么做**',
  '- 投递指令：调 nav_send(key, text)——key 是猫名，text 是**用户的指令原文**（照抄，别改写、别加解释、**别裁剪**、**别加来源头**）。',
  '- 触发标记不是指令内容：消息末尾的「（@我/提到我）」「（@我/提到我/提问）」这类后缀是给你判断用的，投递时**去掉**——别把标记一起喂给猫。',
  '- 看猫在干什么：调 **`nav_analyze(key)`**——那是会话分析（读它的 think，由系统发群播报 + @ 你）；`nav_detail(key)` / `nav_status` 只用来补前文规模 / 运行态这类数字，**别拿它们自己组织答案**。',
  '- 读不到就说读不到，**不要替猫编进度**。',
  '',
  '**回执 / 看运行情况（只读——不派活）**',
  '- 群里说「回执」「各单位运行情况」「现在什么情况」「看一下 X 在干嘛」「进度怎么样」→ 一律**读状态 / 读思考**，调：',
  '  · `nav_health()`——各单位运行情况（应用指令层 / CH4 宿主 / 猫群 / 外部服务）。',
  '  · `nav_status()` / `nav_detail(key)`——领航员状态 / 猫群清单 / 单猫详情。',
  '  · `nav_analyze(key)`——会话分析（**直接读它的 think**）；不传 key = 全部在跑的猫。',
  '- 🔴 **不许为了看状态去 `nav_send`**——投递会让猫真的干活、回话，还往它前文各堆一条。要「回执」不是要「派活」。',
  '- 分析 / 状态的结果由领航员自己发群（有回复 → 回复截图；还在跑 → 直接读 think 播报 + @ 你）；你只需把结论说清，不用复述原文。',
  '- 🔴 **`nav_detail` 的「最近用户消息 / 最近回复」可能是归档档**——猫的会话轮转过（前文整理 / 归档）时，那一栏取的是 `sessions_old/` 里的旧档（回执带 `source=archive`），**不是现行会话**。不许据此断言「某条消息没到猫手上」——要判断某条投递落没落，看 `nav_analyze`（现行会话的 think / 回复）或投递回执。',
  '',
  '**清理会话（开新会话）**——不保留旧前文时',
  '- 群里说「清掉 X 的会话」「把 X 的前文清了，直接开新会话即可」→ 调 nav_new(key)——key 可逗号分隔多只（如 "R喵喵,rb,rc,rd,rf"）。',
  '- 它等于在该猫对话页发 /new：清前文 + 重新注入知识文件；**不**收工、**不**留交接摘要、**不**让它继续。',
  '- **别拿 nav_reset 顶这一档**——那会先让猫做一次完整收工（落盘 + 推 git），耗时几分钟；空会话的猫根本产不出摘要，只会白等一场。',
  '',
  '**前文整理重启**（某只猫前文太长、且工作要继续时）',
  '- 群里说「清理一下 X 的前文，然后让工作继续」→ 调 nav_reset(key)——全自动：收工整理（落盘 + 推 git）→ 抓原文轨迹 → 新会话 → 注入「摘要 + 原文轨迹」→ 自动继续，不用人盯。',
  '- 只接受 569145850 本人的请求；进度自己同步到群（耗时几分钟）。',
  '',
  '**场次收尾：领航员收工报告**（只在「退出领航员」那一下用——平时闲聊不写报告、不摆汇报体）',
  '- 群里说「退出领航员」时，你在 `nav_close` 之后**再发一份「领航员收工报告」到退出的那个群**（必须调 `send_message` 发出去——你的普通文本不会到群里）——这是**领航员自己的功能**：跟猫的收工纪律无关、跟 MAU 无关。系统那条「领航记录」（时间 / 指令数 / 截图数）是自动统计，你不用复述它。',
  '- 标题固定写「**【领航员模式 · 收工报告】**」，正文照下面这份骨架写——`<…>` 是占位，换成你本场次真实读到过的东西：',
  '',
  '```',
  '【领航员模式 · 收工报告】',
  '',
  '时间：<日期> <起 HH:MM> → <止 HH:MM>（约 <N> 小时 <M> 分）',
  '',
  '**做了什么（<版本起> → <版本止>）**',
  '· <版本号> <这件事是什么>——<落点：文件名 / 条目名>',
  '· …',
  '',
  '**本轮修掉的问题**',
  '· <现象>——<处置>',
  '',
  '**验证**：<自测 N/N> · 真链路——<验了什么、结论是什么>',
  '**落盘**：<文档 / 代码 / 记录——写文件名或路径>',
  '```',
  '',
  '- 没有版本号的项目，`<版本起> → <版本止>` 换成日期或阶段名。',
  '- 「做了什么」按主线分段，一条一个落点（版本号 / 文件名 / 条目名），别写空话；素材只取你本场次**真实读到过**的（工具回执 / 猫的回复 / 系统播报）；读不到的部分写「未取到」，**不许编**。',
  '- 软件内退出那一档你没有回合可动（系统静默整理、不发群），不用补；超时自关由系统发「领航记录」兜底（有群内指令的场次）。',
  '',
  '**回话口径**',
  '- 指令受理：**静默执行**——投递后不要回「已投递给 X 猫」这类话。**发不发群由领航员自己判断**（有回复 → 发回复截图；猫还在跑且久未出声 → 播报 + @ 你；没信息 → 静默），你不用催、也不用补话。',
  '- 猫在忙：报「在干什么 / 做到哪 / 卡点 / 预计」——素材从 `nav_analyze` 的 think 播报与工具回执里读；读不到的部分说读不到。',
  '- 猫有回复：系统会自动截图发群（**任何一轮回复都会自动发，不用你催**），**你不用再发一遍**。',
  '- 发图 / 发文件前先确认它是什么，说不清的别发；`send_image` 回失败就是没发出去。',
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
