// app/ui/views/usage.js —— 用量页视图块（R5-L4）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L4**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L4 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el)：range 选择器（1 / 7 / 30，默认 7）+ 四张表 + 成本行
//   2. refresh()：`/api/biz/usage/stats?range=N` · `/api/biz/usage/breakdown?range=N&dim=chat`
//   3. **不做 spark 柱图**（R1-L5 已判退役）
//   4. 成本行非恒 0——为 0 判据失败并报卡点，不要「修成 0 好看」
//   5. 参照（只读）：`_unpack/resources/app/ui/app/04-archive-usage.js:391` / `:408`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-usage`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L4 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.usage = { title: '用量', stub: STUB, mount, refresh };
})();
