// apply-qqagent-engage.mjs — 「群内自主参与」配置写入（可重跑复现）
//
// 用法：node apply-qqagent-engage.mjs
// 做什么：把触发权交给模型 + 聚批窗口 + 发言配额写进 data/config.json
//   · store.contextTier = 4        全消息进 LLM（不再靠 @/关键词/概率的本地门）
//   · store.contextSliderPos = 95  4 档区（UI 滑条显示对齐）
//   · wakeDelayMs = 4000           聚批窗口 2s → 4s（连发消息聚成一次思考）
//   · engage.quota                 发言配额：滑动 120s 内每群最多 5 条
//   · engage.topicWords            收工轮自产话题词（提示词参考）
//   · engage.botGuard              bot 指定限频：对指定群友的回复 240s 内最多 1 条（只补默认值，不覆盖名单）
// 边界：只动这几个字段 —— 不动 allow（白名单）/ chatActive / proactive / session
// ⚠️ 应用运行中改本文件可能被退出回写覆盖 —— **先停应用再跑，跑完启动**
//
// 语义说明（为什么是这几个值）：
//   · 4 档 = 判定恒真：resolveContextTier 直接 shouldRespond=true，每条群消息都进 LLM，
//     "要不要接话"由模型自己判断。想收紧时把 contextTier 改回 2/3 即可回退。
//   · wakeDelayMs 是"第一条消息后等多久聚批"的固定窗口（不重置）。4s 让连发的
//     几句话落进同一批，省一次调用；再长会让响应显得迟钝。
//   · 配额是第二道闸：技术限频（send.maxPerMinute）防封号，配额管"说多少"。

import fs from 'node:fs';

const CFG = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\data\\config.json';
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));

cfg.store = { ...cfg.store, contextTier: 4, contextSliderPos: 95 };
cfg.wakeDelayMs = 4000;
// ⚠️ 必须展开旧值再覆盖 —— engage 是"多个功能的容器"，整体替换会抹掉
//    别的功能段（曾把 botGuard 的成员名单一起清掉）。
cfg.engage = {
  ...(cfg.engage || {}),
  quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
  topicWords: { enabled: true },
  // bot 指定限频（2026-10-10）：记忆页「🤖 bot」开关写的成员名单在这里；
  // 本脚本只补默认值，**不覆盖已有名单**。
  botGuard: {
    enabled: true,
    windowMs: 240000,
    maxPerWindow: 1,
    members: Array.isArray(cfg.engage?.botGuard?.members) ? cfg.engage.botGuard.members : []
  }
};
// 单次请求超时：180s → 90s（上游卡住时更快中止重试）
cfg.api = { ...cfg.api, timeoutMs: 90000 };
// 卡死看门狗：整轮运行超过 150s 无活动 → 中止在途请求 + 恢复未读 + 重排
cfg.stall = { enabled: true, timeoutMs: 150000, checkIntervalMs: 20000 };

const tmp = CFG + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
fs.renameSync(tmp, CFG);

console.log(JSON.stringify({
  ok: true,
  contextTier: cfg.store.contextTier,
  contextSliderPos: cfg.store.contextSliderPos,
  wakeDelayMs: cfg.wakeDelayMs,
  quota: cfg.engage.quota,
  topicWords: cfg.engage.topicWords,
  botGuard: cfg.engage.botGuard,
  apiTimeoutMs: cfg.api.timeoutMs,
  stall: cfg.stall,
  allow: cfg.allow,
  chatActive: cfg.chatActive,
  proactive: cfg.proactive
}, null, 2));
