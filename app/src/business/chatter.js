// 发言热度 —— 检测"话密的群友"与"人机对刷"，渲染成提示词参考。
// [qqagent-engage-patch:chatter]
//
// 设计（Rushiera 2026-10-09 规格）：
//   某个群友发言频率过高 → 对这个人的接话频率**依次降级**，避免吵起来。
//   尤其"机器人每发一条、他回一条"的对刷场合，要让模型更多地判断"不回复"，
//   而不是撞上发言配额才被迫停。
//
// 本模块**不做任何判定**：只统计事实 + 渲染成提示 —— 接不接话仍由模型决定。
// 分级（依次降级）：
//   L1 提示：对方话很密（窗口内条数超阈）→ 只在他直接问或有新信息时接
//   L2 收紧：与对方来回已达阈值轮 → 除非有实质新内容，倾向不接
//   L3 停：轮数/条数再上一个台阶 → 本轮不回复（除非他直接 @ 问具体的事）
const WINDOW_MS = 600000;
const RECENT_LIMIT = 40;
// 阈值（2026-10-10 下调 · [qqagent-talkstyle-patch:chatter-thresholds]）——
// 原 8 条 / 3 轮偏高：实测群内被接话率 97~100%，软闸根本没够到。
// 硬阈值（STRONG_*）保持高门槛 —— L3"本轮建议不回复"是强建议，只在话极密时给。
const SOFT_COUNT = 5;
const STRONG_COUNT = 15;
const SOFT_ROUNDS = 2;
const STRONG_ROUNDS = 5;

/** 从尾部扫描"机器人 ↔ 同一人"的交替往返；换人即断。 */
function detectLoops(messages) {
  const loops = new Map();
  let partner = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.self) {
      if (partner) loops.set(partner, (loops.get(partner) || 0) + 1);
    } else if (m && m.senderId) {
      if (partner === null) partner = String(m.senderId);
      else if (String(m.senderId) !== partner) break;
    } else {
      break;
    }
  }
  return loops;
}

/**
 * 分析某会话的发言热度。
 * @returns {{ level:'none'|'soft'|'strong', hot:Array, loops:Array }}
 */
export function analyzeChatter(store, chatKey, { windowMs = WINDOW_MS, recentLimit = RECENT_LIMIT } = {}) {
  const since = Date.now() - Math.max(60000, Number(windowMs) || WINDOW_MS);
  let recent = [];
  try { recent = store.messagesSince(chatKey, since, { limit: 0 }) || []; } catch { recent = []; }
  const count = new Map();
  const names = new Map();
  for (const m of recent) {
    if (!m || m.self || !m.senderId) continue;
    const id = String(m.senderId);
    count.set(id, (count.get(id) || 0) + 1);
    if (m.senderName) names.set(id, String(m.senderName));
  }
  const hot = [...count.entries()]
    .map(([id, n]) => ({ id, name: names.get(id) || id, count: n }))
    .filter((x) => x.count >= SOFT_COUNT)
    .sort((a, b) => b.count - a.count);

  let tail = [];
  try { tail = store.recent(chatKey, { limit: Math.max(10, Number(recentLimit) || RECENT_LIMIT) }) || []; } catch { tail = []; }
  const loops = [...detectLoops(tail).entries()]
    .map(([id, rounds]) => ({ id, name: names.get(id) || id, rounds }))
    .filter((x) => x.rounds >= SOFT_ROUNDS)
    .sort((a, b) => b.rounds - a.rounds);

  const strong = hot.some((x) => x.count >= STRONG_COUNT) || loops.some((x) => x.rounds >= STRONG_ROUNDS);
  const level = strong ? 'strong' : (hot.length || loops.length) ? 'soft' : 'none';
  return { level, hot, loops };
}

/** 渲染成提示段（追加在用户消息末尾）。无可说时返回空串。 */
export function formatChatterHint(store, chatKey, opts = {}) {
  const a = analyzeChatter(store, chatKey, opts);
  if (a.level === 'none') return '';
  const lines = ['【发言热度（本轮参考，不强制）】'];
  if (a.loops.length) {
    const top = a.loops[0];
    lines.push('- 你和 ' + top.name + ' 最近已经来回 ' + top.rounds + ' 轮。真人聊天不会句句都接 —— '
      + (a.level === 'strong'
        ? '本轮建议不回复，除非他直接 @ 你问具体的事。'
        : '除非他这条有实质新内容，否则倾向不接。'));
  }
  for (const h of a.hot.slice(0, 3)) {
    lines.push('- ' + h.name + ' 最近 10 分钟说了 ' + h.count + ' 条，话比较密 —— '
      + (h.count >= STRONG_COUNT ? '不必每条都跟。' : '只在他直接问你或有新信息时接。'));
  }
  if (a.level === 'strong') {
    lines.push('- 像群友一样有来有回、不是有问必答：这一轮安静也是正常参与。');
  }
  return '\n\n' + lines.join('\n');
}
