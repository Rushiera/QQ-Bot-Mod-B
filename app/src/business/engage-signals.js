// 客观信号 —— 从存档与用量里算出来的"该不该说话"的客观依据。[qqagent-level-patch:signals]
//
// 语义（Rushiera 2026-10-25 定）：回应参数只有"有没有人接"一个信号，太单一；
// 这里把存档里本来就有的事实算成 6 个系数，合起来给参与率乘一个修正。
//
// 开关：config.engage.signals.enabled（2026-11-01 起默认 true，B31 甲案「先接线再启用」）。
//    它只做**乘法修正**（几何平均，下限 floor），不是硬闸：
//    单个信号偏低不会一票否决，多个同时偏低才平滑收敛。
//    enabled=false 时调用方给 coef=1，整条链路退化为按档位 rate 掷骰（B31 前的原行为）。
//
// 接线点：orchestrator.js 的浏览拍参与判定（[qqagent-level-patch:signals-wiring]）。
//    数据供给：messages = store.recent()（判定处现取）· hour = 当前时刻 ·
//    costDay = 今日用量 × estimateCost（与 /api/status 同口径）· missStreak = 客观结算累计的连续未接拍。
//
// 六个信号的取值口径（全部只用存档里已有字段，不新增采集面）：
//   share    我发言占比 = self / 总数。太高（存在感过强）→ 压；太低不奖励（避免抢话）。
//   atRate   被点名率 = atMe / 总数。≥3% 说明群里在找我 → 略放；低是常态，不罚。
//   askDensity 提问密度 = 带问号/问法的比例。≥25% 说明有话题可接 → 略放。
//   hourFactor 深夜（23-07 点）×0.5，其余 1。
//   costFactor 当日成本越高越省（>100 元 ×0.7，>50 元 ×0.85）。
//   missFactor 连续没被接话的拍数（每拍 -0.05，下限 0.5）。
//   soloFactor 冷场首接（2026-11-12）：群里只有一个人在说、还没人接上 → ×soloWeight
//              （默认 0.2）；同一人连发够多或已有第二人接上 → 1。与硬闸 analyzeTurn 同源。

import { analyzeTurn } from './cold-start.js';

/** 单条消息是否"像在提问"（不区分谁发的）。 */
function looksLikeAsk(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  return /(怎么|为什么|为啥|咋|如何|能不能|是不是|有没有|要不要|哪个|啥)/.test(t);
}

/**
 * 计算客观信号（纯函数 —— 不读盘、不读配置，方便自测）。
 * @param {Array} messages 最近一批消息（条目结构见 store，字段 self / atMe / text）
 * @param {{hour?:number, costDay?:number, missStreak?:number}} env
 */
export function computeSignals(messages, env = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  let self = 0;
  let at = 0;
  let ask = 0;
  for (const m of list) {
    if (!m) continue;
    if (m.self) { self += 1; continue; }
    if (m.atMe === true) at += 1;
    if (looksLikeAsk(m.text)) ask += 1;
  }
  const other = Math.max(1, total - self);
  const share = total > 0 ? self / total : 0;
  const atRate = total > 0 ? at / total : 0;
  const askDensity = total > 0 ? ask / other : 0;

  // 发言占比：>15% 开始收，>35% 收到下限（存在感过强）
  const shareFactor = share <= 0.15 ? 1 : Math.max(0.5, 1 - (share - 0.15) * 2.5);
  // 被点名率：≥3% 视为"群里在找我"→ 略放；否则不动（低是常态，不罚）
  const atFactor = atRate >= 0.03 ? 1.15 : 1;
  // 提问密度：≥25% 略放；否则不动
  const askFactor = askDensity >= 0.25 ? 1.1 : 1;

  const hour = Number(env.hour);
  const h = Number.isFinite(hour) ? hour : new Date().getHours();
  const hourFactor = (h >= 23 || h < 7) ? 0.5 : 1;

  const cost = Number(env.costDay) || 0;
  const costFactor = cost > 100 ? 0.7 : (cost > 50 ? 0.85 : 1);

  const miss = Math.max(0, Number(env.missStreak) || 0);
  const missFactor = Math.max(0.5, 1 - miss * 0.05);

  // 第七因子 · 冷场首接（2026-11-12）：与硬闸同源（cold-start.analyzeTurn）。
  // 硬闸开着时 hold 的拍根本走不到这里；硬闸关闭（coldStart.enabled=false）时它是概率兜底。
  const turn = analyzeTurn(list, {
    now: Number.isFinite(Number(env.now)) ? Number(env.now) : Date.now(),
    windowMs: env.windowMs,
    gapMs: env.gapMs,
    minSolo: env.minSolo
  });
  const soloWeight = Number(env.soloWeight);
  const soloFactor = turn.hold
    ? Math.min(1, Math.max(0.05, Number.isFinite(soloWeight) && soloWeight > 0 ? soloWeight : 0.2))
    : 1;

  return {
    total, self, at, ask, share, atRate, askDensity,
    shareFactor, atFactor, askFactor, hourFactor, costFactor, missFactor,
    soloFactor, soloCount: turn.solo, soloReason: turn.reason
  };
}

/**
 * 乘性合成：几何平均（六项等权），下限 floor；第七因子（冷场首接）在外层单独乘。
 *
 * floor 取值按**实测量级**定（B31 判据 3）：六因子几何平均的最坏组合
 * （share 0.5 · hour 0.5 · cost 0.7 · miss 0.5，at / ask 取 1）= 0.666；
 * 单是深夜一项 = 0.891。旧的 0.15 永远够不着 —— 那不是下限，是死参数。
 * 现取 0.65，落在最坏组合（0.666）正下方：它能兜住的只有「比最坏还坏」的组合
 * （例如 miss 拍到 0.5 下限再叠深夜），不是为了继续压低。
 *
 * @returns {number} floor ~ 1.15 的系数（>1 表示这一拍鼓励开口）
 */
export function compositeCoefficient(sig, floor = 0.65) {
  const f = [
    sig && sig.shareFactor,
    sig && sig.atFactor,
    sig && sig.askFactor,
    sig && sig.hourFactor,
    sig && sig.costFactor,
    sig && sig.missFactor
  ].map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1));
  const prod = f.reduce((a, b) => a * b, 1);
  const geo = Math.pow(prod, 1 / f.length);
  const lo = Number.isFinite(Number(floor)) ? Number(floor) : 0.15;
  const base = Math.min(1.15, Math.max(lo, geo));
  // 第七因子（冷场首接）单独乘在结果上：不参与几何平均 —— 等权会被其余六项稀释，
  // 压完再被 floor 兜回去，等于没压。冷场是「这一拍基本不该开口」，不是微调。
  const solo = Number(sig && sig.soloFactor);
  const s = Number.isFinite(solo) && solo > 0 ? Math.min(1, solo) : 1;
  return Math.min(1.15, Math.max(0.05, base * s));
}

/** 采集用的一行摘要（写进 engage-metrics，字段短便于 grep）。 */
export function signalSummary(sig, coef) {
  return {
    total: sig.total,
    self: sig.self,
    share: Math.round(sig.share * 1000) / 1000,
    atRate: Math.round(sig.atRate * 1000) / 1000,
    askDensity: Math.round(sig.askDensity * 1000) / 1000,
    hourFactor: sig.hourFactor,
    costFactor: sig.costFactor,
    missFactor: sig.missFactor,
    soloFactor: sig.soloFactor,
    solo: sig.soloCount,
    coef: Math.round(Number(coef) * 1000) / 1000
  };
}
