// app/ui/views/plugins.js —— 插件页视图块（R5-L7）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L7**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L7 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el)：插件模块列表 + 加载状态
//   2. refresh()：数据源优先 `/api/biz/tools` 与 `/api/biz/config`（插件启用态）
//   3. 🔴 业务面若无插件写端点 → **只读展示**并在页面上标「只读」，不自造端点
//   4. 参照（只读）：`_unpack/resources/app/ui/app/06-settings-render.js:1295` / `:1307` / `:1431`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-plugins`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L7 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.plugins = { title: '插件', stub: STUB, mount, refresh };
})();
