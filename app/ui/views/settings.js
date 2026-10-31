// app/ui/views/settings.js —— 业务设置页视图块（R5-L8 骨架）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L8**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L8 实现）——实现完成后删除 STUB 标记
//
// 🔴 这是「业务设置」（页签 bizsettings / `#view-bizsettings`），**不是**既有「本地设置」
//    （`#view-settings`，归 `app/ui/app.js` 管：协议端目录 / 登录账号 / 界面端口 / 开机自启）。
//    两者并存，不合并。
//
// 开工清单：
//   1. 本文件：侧栏 + 折叠机制 + 分节调度（估 400–500 行）
//   2. `settings-sections.js`：各分节渲染函数（估 800–1200 行）
//   3. 可分两批交付——批 1：骨架 + 侧栏 + api / chat / allow 三节；批 2：其余分节
//   4. 未实现的分节显式标「未接」并列出名字（不静默隐藏）
//   5. 参照（只读）：`_unpack/resources/app/ui/app/06-settings-render.js:37` / `:88` / `:154`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-bizsettings`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L8 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.settings = { title: '业务设置', stub: STUB, mount, refresh };
})();
