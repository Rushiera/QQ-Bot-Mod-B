// app/ui/views/skills.js —— 技能页视图块（R5-L6）
//
// 归属：R5 任务卡 §二.1 —— 本文件唯一写者 = **L6**
// 契约：`app/ui/views/_index.md` §三（只读 `window.__ui`，块内不写 fetch）
// 状态：🟡 桩（待 L6 实现）——实现完成后删除 STUB 标记
//
// 开工清单：
//   1. mount(el)：技能列表 + 能力清单 + 重载 / 清理按钮
//   2. refresh()：`/api/biz/skills` · `/api/biz/skills/capabilities` · `/api/biz/tools/availability` · `/api/biz/tools`
//   3. 🔴 技能列表为空**不是 bug**——`app/src/business/plugin-loader.js:40-42` 的 SKILLS_DIR = `app/skills`，
//      该目录当前不存在。空列表时必须显式出现「app/skills 不存在」字样，不是「暂无技能」
//   4. 🟢 不建 `app/skills/` 目录（B27 已拍「保持空转」）
//   5. 参照（只读）：`_unpack/resources/app/ui/app/06-settings-render.js:1430`

(function () {
  'use strict';

  const STUB = true;

  /**
   * 建视图骨架（首次切到本页调用一次）。
   *
   * @param {Element} el 容器（`#view-skills`）
   * @returns {void}
   */
  function mount(el) {
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'view-stub';
    p.textContent = '此页未安装（R5-L6 待实现）';
    el.appendChild(p);
  }

  /**
   * 拉数据重渲染（桩：无数据）。
   *
   * @returns {void}
   */
  function refresh() { /* 桩 */ }

  const views = (window.__views = window.__views || {});
  views.skills = { title: '技能', stub: STUB, mount, refresh };
})();
