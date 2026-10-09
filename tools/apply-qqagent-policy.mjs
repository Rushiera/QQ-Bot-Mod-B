// apply-qqagent-policy.mjs — QQ Agent 接入策略一次性写入
//
// 用法：node apply-qqagent-policy.mjs
// 做什么：从 NapCat 取群列表 → 全部写进 allow.groups（白名单）→ 响应档位压到 1 档（仅艾特）
// 语义：@ 才响应（+ 拍一拍）；其它消息只存档不触发，零 token
// 边界：只动 allow / store 两组字段

import fs from 'node:fs';

const CFG = 'D:\\Mau\\WorkSpace\\QQBotB\\_unpack\\data\\config.json';
const NAPCAT = 'http://127.0.0.1:3000';
const TOKEN = 'napcatb2405997337';

const res = await fetch(`${NAPCAT}/get_group_list?access_token=${TOKEN}`, { method: 'POST' });
if (!res.ok) throw new Error(`NapCat get_group_list HTTP ${res.status}`);
const body = await res.json();
const list = Array.isArray(body?.data) ? body.data : [];
const groups = list.map((g) => String(g.group_id)).filter(Boolean);
if (!groups.length) throw new Error('群列表为空——NapCat 没在跑？');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
cfg.allow = { ...cfg.allow, groups };
cfg.store = { ...cfg.store, contextTier: 1, randomPercent: 0 };

const tmp = `${CFG}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
fs.renameSync(tmp, CFG);

console.log(JSON.stringify({
  ok: true,
  groups: groups.length,
  names: list.map((g) => `${g.group_id} ${g.group_name}`),
  contextTier: cfg.store.contextTier,
  allowPrivate: cfg.allow.private
}, null, 2));
