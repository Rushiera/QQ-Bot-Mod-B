// 冷场首接抑制 —— 群聊冷场时不当第一个接话的人。[qqagent-coldstart]
//
// 语义（Rushiera 2026-11-12 定）：群里半天没人说话，突然有人发一条，bot 立刻
// 冒出来接 —— 这是「听不懂话」的观感来源之一：上下文只有一条孤立消息，也没有
// 别人接，模型天然把每条新消息当成"待回的消息"。
//
// 规则：话头没被第二个人接上之前，bot 不开口；同一人连发 minSolo 条仍无人
// 回应（自说自话 / 求助没人应）才破例。拍一拍不算发言，也不构成回应理由。
//
// 判据（纯本地，零 token）：
//   1. 取窗口内的消息（windowMs，默认 30 分钟）
//   2. 找最近一条 bot 消息；其后的非 bot 消息 = 「当前话头」
//      （bot 在窗口内没说过话 → 取窗口内全部非 bot 消息）
//   3. 话头的不同发言人 ≥ 2 → 已被别人接上 → 放行
//   4. 只有一个发言人：
//      a. 话头第一条紧接 bot 上一条（≤ gapMs，默认 5 分钟）→ 对话延续 → 放行
//      b. 末尾连续条数 ≥ minSolo（默认 4）→ 例外放行
//      c. 否则 → HOLD
//   5. 话头为空 → 不适用（不 hold）
//
// 纯函数：不读盘、不读配置（参数传入），方便自测；配置归一只做字段归一。
export const DEFAULT_WINDOW_MS = 1800000;   // 30 分钟：回看窗口
export const DEFAULT_GAP_MS = 300000;       // 5 分钟：bot 发言后的"对话延续"窗口
export const DEFAULT_MIN_SOLO = 4;          // 同一人连发几条仍无人应 → 破例
export const DEFAULT_SOLO_WEIGHT = 0.2;     // 第七因子的权重（硬闸关闭时的概率压制）

/** 冷场首接配置归一（唯一派生入口 —— 判定处别各读各的配置）。raw = getConfig().engage?.coldStart */
export function coldStartCfg(raw = {}) {
  const c = raw || {};
  const minSolo = Math.round(Number(c.minSolo));
  const windowMs = Number(c.windowMs);
  const gapMs = Number(c.gapMs);
  const soloWeight = Number(c.soloWeight);
  return {
    enabled: c.enabled !== false,
    minSolo: Number.isFinite(minSolo) && minSolo > 0 ? minSolo : DEFAULT_MIN_SOLO,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS,
    gapMs: Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : DEFAULT_GAP_MS,
    soloWeight: Number.isFinite(soloWeight) && soloWeight > 0 && soloWeight <= 1 ? soloWeight : DEFAULT_SOLO_WEIGHT
  };
}

/**
 * 分析当前话头（纯函数，不改状态）。
 * @param {Array} messages store.recent() 的结果（含 self，按时间升序）
 * @param {{now?:number, windowMs?:number, gapMs?:number, minSolo?:number}} opts
 * @returns {{hold:boolean, reason:string, senders:number, solo:number,
 *            lastSenderId:string, headCount:number, cfg:{windowMs:number, gapMs:number, minSolo:number}}}
 *   reason：cold-solo（HOLD）· ok-multi（已被别人接上）· ok-continue（对话延续）
 *           · ok-solo-burst（连发达例外）· no-head（无话头，不适用）
 */
export function analyzeTurn(messages, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const windowMs = Number.isFinite(Number(opts.windowMs)) && Number(opts.windowMs) > 0
    ? Number(opts.windowMs) : DEFAULT_WINDOW_MS;
  const gapMs = Number.isFinite(Number(opts.gapMs)) && Number(opts.gapMs) >= 0
    ? Number(opts.gapMs) : DEFAULT_GAP_MS;
  const minSolo = Number.isFinite(Number(opts.minSolo)) && Number(opts.minSolo) > 0
    ? Math.round(Number(opts.minSolo)) : DEFAULT_MIN_SOLO;
  const cfg = { windowMs, gapMs, minSolo };
  const base = { senders: 0, solo: 0, lastSenderId: '', headCount: 0, cfg };

  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && Number(m.ts) > 0);
  const inWindow = list.filter((m) => now - Number(m.ts) <= windowMs);

  // 最近一条 bot 消息（拍一拍不计入"发言"）
  let botIdx = -1;
  for (let i = inWindow.length - 1; i >= 0; i -= 1) {
    if (inWindow[i].self) { botIdx = i; break; }
  }
  const head = botIdx >= 0 ? inWindow.slice(botIdx + 1) : inWindow;
  const others = head.filter((m) => !m.self && m.isPoke !== true);

  if (!others.length) return { ...base, hold: false, reason: 'no-head' };

  const senders = new Set();
  for (const m of others) {
    const id = String(m.senderId || '');
    if (id) senders.add(id);
  }

  // 不同发言人 ≥ 2 → 话头已被别人接上，不拦
  if (senders.size >= 2) {
    return { ...base, hold: false, reason: 'ok-multi', senders: senders.size, headCount: others.length };
  }

  // 单一发言人：数末尾连发
  const lastSenderId = String(others[others.length - 1].senderId || '');
  let solo = 0;
  for (let i = others.length - 1; i >= 0; i -= 1) {
    if (String(others[i].senderId || '') !== lastSenderId) break;
    solo += 1;
  }

  // 对话延续：话头第一条紧接 bot 上一条 → 不是冷场新话头
  if (botIdx >= 0) {
    const botTs = Number(inWindow[botIdx].ts) || 0;
    const firstTs = Number(others[0].ts) || 0;
    if (botTs > 0 && firstTs > 0 && firstTs - botTs <= gapMs) {
      return { ...base, hold: false, reason: 'ok-continue', senders: senders.size, solo, lastSenderId, headCount: others.length };
    }
  }

  // 例外：同一人连发够多仍无人回应 —— 需要有人应
  if (solo >= minSolo) {
    return { ...base, hold: false, reason: 'ok-solo-burst', senders: senders.size, solo, lastSenderId, headCount: others.length };
  }

  return { ...base, hold: true, reason: 'cold-solo', senders: senders.size, solo, lastSenderId, headCount: others.length };
}

/** 采集用的一行摘要（写进 engage-metrics 的 hold 行）。 */
export function holdSummary(turn) {
  const t = turn || {};
  return {
    reason: String(t.reason || ''),
    senders: Number(t.senders) || 0,
    solo: Number(t.solo) || 0,
    head: Number(t.headCount) || 0,
    hold: t.hold === true
  };
}
