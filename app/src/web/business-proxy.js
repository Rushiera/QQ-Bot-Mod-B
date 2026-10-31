// app/src/web/business-proxy.js —— 单体 → 业务面的单一代理出口（R5-L9）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L9**
// 契约：`app/ui/views/_index.md` §3.3（通配前缀 / 502 形态 / 只放行 GET·POST·DELETE / 8 秒超时）
// 状态：🟡 桩（待 L9 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. `createBusinessProxy({ business, log })` 返回 `{ __bizProxy: async ({ req, res, url }) => {...} }`
//      🔴 前提：`app/src/web/server.js:112` 是 `api[key]` **精确匹配**，不支持通配——
//      故 server.js 需在「未命中」分支追加前缀兜底（约 6 行）：`pathname.startsWith('/api/biz/') && api.__bizProxy`
//      然后在 app.js 的 api 表里展开它（一行）
//   2. 转发目标 = `business.apiUrl ?? 'http://127.0.0.1:3210'` + 去掉 `/api/biz` 前缀的剩余路径
//   3. 业务面不可达 → `{ status: 502, body: { ok:false, error:'业务面不可达（127.0.0.1:3210）', status:502 } }`
//      🔴 **不吐空数组冒充成功**
//   4. 方法白名单：GET / POST / DELETE；其余 `405`
//   5. 超时 8 秒 → `504` + 原因
//   6. 装配：`app/src/app.js` 的 api 表里**只加一行** `...createBusinessProxy({ business, log }),`
//      外加一行 import——不改既有条目
//   7. 验收：三条端点各返 200 且带业务面原始字段；业务面停摆回 502 且 body 含 3210；
//      `node --check` ×2；`tools/verify-import-integrity.mjs` ALL PASS

/**
 * 创建代理接口表（桩：返回空表——装配上也不会改变任何既有行为）。
 *
 * @param {{business: object, log: object}} options 装配依赖
 * @returns {object} 接口表（`方法 路径` → 处理函数），桩返回空对象
 */
export function createBusinessProxy({ business, log }) {
  void business;
  void log;
  return {};
}
