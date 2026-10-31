// app/ui/views/settings-sections.js —— 业务设置 · 各分节渲染（R5-L8）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L8**（与 `settings.js` 同线，无跨线冲突）
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L8 实现）——实现完成后删除 STUB 标记
//
// 分节清单（原版 06-settings-render.js 的函数 → 行号，只读参照）：
//   api :171 · search :262 · memory :369 · persona :395 · allow :670 · chat :816
//   desktop :959 · onebot :1000 · tools :1527 · prompt-preview :1652
//
// 交付口径：每个分节导出一个渲染函数，挂到 `window.__settingsSections.<name>`；
//           `settings.js` 按侧栏点击调度。未实现的分节不要删条目——显式标「未接」。

(function () {
  'use strict';

  const STUB = true;

  window.__settingsSections = window.__settingsSections || { stub: STUB };
})();
