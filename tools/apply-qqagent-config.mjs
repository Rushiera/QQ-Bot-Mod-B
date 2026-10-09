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
const parts = ['# 前文（CCBP · 源：rf 会话 639270055721496090 的注入集）', '', '## 人格', PERSONA_LINE, '', '## 遇阻处置（硬规则——优先于下文任何方法）', BLOCKED_RULES, ''];
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
