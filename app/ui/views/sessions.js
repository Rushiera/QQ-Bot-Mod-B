// app/ui/views/sessions.js —— 会话页视图块（R5-L2）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L2**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L2 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el) 只建 DOM 骨架（左列表 + 右详情），不发请求
//   2. refresh() 取数：`/api/biz/sessions` → 群会话列表；点选后 `/api/biz/chats?chat=<群号>`
//   3. 空态 empty() · 失败态 fail()（文案含 3210）
//   4. 验收：会话条数 = 接口数组长度；消息条数 = messages.length；node --check 退出 0
//   5. 参照（只读）：`_unpack/resources/app/ui/app/02-sse-sessions.js:392` / `:587`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-sessions`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L2 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.sessions = { title: '会话', stub: STUB, mount, refresh };
})();
