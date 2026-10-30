// 发言档位 —— 按群的"爱说多少"五档。[qqagent-level-patch:level]
//
// 语义（Rushiera 2026-10-25 定）：
//   档位只回答一个问题：**这一拍到点有未读，要不要进 LLM**（参与率）。
//   · 发言配额（5 条 / 2 分钟）与浏览节拍表（240/120/60 秒）**不由档位改动** ——
//     配额管"一个窗口最多几条"，档位管"要不要入场"；两件事分开，互不覆盖。
//   · 冰封档 = 原「安静模式」：非 @ 不进 LLM，到点只做"只整理不发言"的沉淀轮。
//     config.engage.quiet.chats 保留为冰封档的别名（老配置启动即生效，不清空）。
//   · 参与率是概率入场：未命中时**未读不推进**（消息留存到下一拍），不丢内容。
//
// 为什么用概率入场而不是继续加闸：出站闸只能"拦住已经想说的话"，压不住"想说"本身；
// 10-22 的实测（进 LLM 267 批 / 只发出 76 条）说明问题在入场面不在出站面。
//
// 状态：档位是**配置态**（config.engage.levelByChat），跨重启有效。
import { getConfig } from './config.js';

const FALLBACK_LEVELS = [
  { name: '冰封', rate: 0, missCap: 0, organizeOnly: true },
  { name: '保守', rate: 0.25, missCap: 0, organizeOnly: false },
  { name: '标准', rate: 0.6, missCap: 0, organizeOnly: false },
  { name: '活跃', rate: 0.85, missCap: 0, organizeOnly: false },
  { name: '全开', rate: 1, missCap: 0, organizeOnly: false }
];

function engageCfg() {
  return getConfig().engage || {};
}

/** 档位表（配置缺失 / 非法 → 内置五档）。 */
export function levelTable() {
  const raw = engageCfg().levels;
  if (!Array.isArray(raw) || raw.length < 2) return FALLBACK_LEVELS;
  return raw.map((e, i) => {
    const d = FALLBACK_LEVELS[Math.min(i, FALLBACK_LEVELS.length - 1)];
    const rate = Number(e && e.rate);
    return {
      name: String((e && e.name) || d.name),
      rate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : d.rate,
      missCap: Math.max(0, Number(e && e.missCap) || 0),
      organizeOnly: Boolean(e && e.organizeOnly === true)
    };
  });
}

/**
 * 该会话的档位（1 起）。
 * 优先级：levelByChat 显式指定 → quiet.chats 别名(1) → 默认 3（标准）。
 * 私聊不受档位节制（1v1 是对方在跟你说话）→ 取最高档（全入场）。
 */
export function levelForChat(chatKey) {
  const key = String(chatKey || '');
  const table = levelTable();
  const max = table.length;
  const id = key.split(':')[1] || '';
  const map = engageCfg().levelByChat || {};
  if (id && map[id] != null) {
    const n = Math.round(Number(map[id]));
    if (Number.isFinite(n)) return Math.min(max, Math.max(1, n));
  }
  if (!key.startsWith('group:')) return max;
  const q = engageCfg().quiet || {};
  if (q.enabled !== false) {
    const chats = (Array.isArray(q.chats) ? q.chats : []).map((v) => String(v).trim()).filter(Boolean);
    if (id && chats.includes(id)) return 1;
  }
  return Math.min(max, 3);
}

/** 该会话的档位参数（唯一派生入口 —— 到处都从这里取，别各读各的配置）。 */
export function paramsFor(chatKey) {
  const table = levelTable();
  const level = levelForChat(chatKey);
  const p = table[Math.min(table.length - 1, Math.max(0, level - 1))];
  return { ...p, level, levelCount: table.length };
}

/**
 * 参与率掷骰（纯判定，不改状态）。
 * @returns {{participate:boolean, rate:number, roll:number, level:number}}
 */
export function rollParticipation(chatKey, rand = Math.random) {
  const p = paramsFor(chatKey);
  if (p.rate >= 1) return { participate: true, rate: p.rate, roll: 0, level: p.level };
  if (p.rate <= 0) return { participate: false, rate: p.rate, roll: 1, level: p.level };
  const roll = Number(rand()) || 0;
  return { participate: roll < p.rate, rate: p.rate, roll, level: p.level };
}

/**
 * 【发言档位】提示词段（群聊专用；私聊 / 全开档返回空串不占 token）。
 * 与【发言配额】同段：都是本轮动态状态，追加在用户消息末尾（不打断缓存前缀）。
 */
export function levelHint(chatKey) {
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return '';
  const p = paramsFor(chatKey);
  if (p.organizeOnly) {
    return '\n\n【发言档位】本群是冰封档（' + p.level + '/' + p.levelCount + '）：默认不参与闲聊，'
      + '只有被 @ / 拍一拍 点名时才回应；系统会定时做一次"只整理不发言"的记忆沉淀（存档与记忆照常）。'
      + '被点名时正常回应即可，其余时候安静看就好。';
  }
  if (p.rate >= 1) return '';
  return '\n\n【发言档位】本群是' + p.name + '档（' + p.level + '/' + p.levelCount + '，入场率 '
    + Math.round(p.rate * 100) + '%）：你可能连着几拍都没收到新消息 —— 那是系统在省着看，不是群里没人说话。'
    + '收到消息的每一拍都是攒下来的整段内容，看完自己决定接不接，不用每条都接。';
}
