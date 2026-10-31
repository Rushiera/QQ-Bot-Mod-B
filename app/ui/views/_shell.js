// app/ui/views/_shell.js —— 界面外壳与共享契约（R5-L1）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L1**
// 契约：`app/ui/views/_index.md` §三（3.1 冻结签名 / 3.2 两个必备函数 / 3.3 代理层契约）
// 状态：🟡 桩（待 L1 实现）——实现完成后删除本行与 STUB 标记
//
// 开工清单：
//   1. 读 `_index.md` §3.1 签名表——11 个成员逐个实现，一个不能少
//   2. `api()` 打单体端口；非 2xx **不抛**，返 `{ok:false, error, status}`
//   3. `registerView(name, {title, mount, refresh})` 登记视图；导航由 L1 的 index.html 驱动
//   4. 验收：11 个成员 `typeof` 非 undefined · `node --check` 退出 0 · 既有 6 页签零报错

(function () {
  'use strict';

  /** 桩标记——L1 实现后置 false；L16 的契约自测断言这里必须是 false。 */
  const STUB = true;

  /** 视图登记表：name → { title, stub, mount, refresh }。 */
  const views = (window.__views = window.__views || {});

  /**
   * 登记一个视图块。
   *
   * @param {string} name 视图名（对应 `<section id="view-<name>">` 与 `.tab[data-view]`）
   * @param {object} view 视图对象（title / mount / refresh）
   * @returns {void}
   */
  function registerView(name, view) {
    views[name] = view;
  }

  /** 共享契约对象——其余块**只读**，不得改写任何成员。 */
  window.__ui = {
    stub: STUB,
    registerView
  };
})();
