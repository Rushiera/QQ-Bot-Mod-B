// app/ui/views/memory.js —— 记忆页视图块（R5-L5）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L5**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L5 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el)：记忆文件列表 + 「重整」按钮 + 余额后缀 / 语音伴随开关面
//   2. refresh()：`/api/biz/memory-files` · 开关读写 `/api/biz/config`（写后按读回值重渲染）
//   3. 空态 empty() · 失败态 fail()
//   4. 参照（只读）：`_unpack/resources/app/ui/app/05-memory-settings.js:59` / `:1167` / `:1184`
//      · 口径：`design-qqbotb-memory.md` §四（两轴三分 / kind 枚举）

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-memory`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L5 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.memory = { title: '记忆', stub: STUB, mount, refresh };
})();
