// app/ui/views/chats.js —— 存档页视图块（R5-L3）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L3**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L3 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el)：群选择器 + 消息区 + 翻页控件
//   2. refresh()：`/api/biz/chats` 取群与消息；翻页两页消息 id 集合无交集（去重断言）
//   3. 空态 empty() · 失败态 fail()
//   4. 参照（只读）：`_unpack/resources/app/ui/app/04-archive-usage.js:18` / `:97`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-chats`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L3 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.chats = { title: '存档', stub: STUB, mount, refresh };
})();
