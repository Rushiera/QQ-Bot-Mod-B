# R8-L2 判定卡 · 记忆页「现行 / 归档」切换 + 会话要点端点

> 队列编号：Q-001 · 轮次：R8 · 线号：**L2** · 核销角色：单线验证猫（只核本线，不核 L1 / L3）
> 核销时刻：2026-11-01 07:35 · 对象：`workspace:QQBotB/reports/R8-L2.md`
> 报告在盘实锤：**14,783 B · mtime 2026-11-01 07:12**（`Get-Item`）
> 哨兵三项（`tasks/.concurrency.json` 实读）：轮次 **R8** / N=**2** / 卡路径 **`tasks/R8.md`**；`status=在跑` `nextIndex=3` `closed=0`
> 写面交集确认：本卡写 `reports/L2-verdict.md` + `CHANGELOG.md` + `todo.md`；L1 已完成核销并提交（`git log` 顶三条 = L1 判定卡补），`git status` 只余本线 `routes.js` / `memory.js` → **交集为空**

---

## ① 结论

**PASS（附一条半程）** —— 卡 §三 L2 六条判据中 1 / 2 / 4 / 5 / 6 全绿且由验证猫独立复跑取证；判据 3「页面级真渲染」按卡面口径为 **NOT RUN**（前置两件都不在执行猫手里，如实标注，非缺陷）。报告自述的改动量（`routes.js` 13/1 · `memory.js` 133/16）`git diff --numstat` 逐字对得上。

---

## ② 判据逐条复核

| # | 卡面判据 | 复核手段 | 回执 |
|:--:|:--|:--|:--|
| 1 | 切换视图给「点前 / 点后」道具数，N/M 取详情端点实测值 | ① 直连在跑的 3210 详情端点取基线 ② 复跑执行猫的 DOM 桩探针 `tools/CatTemp/r8l2-dom-probe.mjs`（真跑 `memory.js` 渲染链） | 基线实测 `group=165` · `groupArchived=71` · `archiveStats.group=71`（三者自洽）。探针三态：点前 `GROUP_ROWS=165` + 按钮 `["现行 165","归档 71","＋ 添加群记","改","删",…]` → 点「归档 71」后 `GROUP_ROWS=71` 且按钮集只剩 `["现行 165","归档 71"]`（无「＋ 添加」、无「改 / 删」）→ 点回 `GROUP_ROWS=165` 且三键恢复。`PANE_TITLES` 四块钱不变 → **PASS** |
| 2 | 新增端点实测「curl 回执 + JSON 键清单」 | 复跑 `tools/CatTemp/r8l2-route-probe.mjs`（同一份 `createRoutes` 进程内直调）+ 直连 3210 反向核对 | `ROUTE_STATUS=200` · `BODY_KEYS=["chatKey","summary"]` · `SUMMARY_KEYS=["summary","createdAt","rollovers","messages"]` · `SUMMARY_LEN=668`；反例 `group_000000999` → `200 + summary:null`；同路径 `POST` → **404**（方法闸生效）；`routes.length=97`。**直连 3210 该路径实测 404** —— 与报告 §二判据 2 的标注一致（旧进程无新路由）→ **PASS（形态按实测标注）** |
| 3 | 会话要点在页面上真渲染一次（DOM 断言或截图）；依赖 L3 合龙 | ① 复跑 `tools/CatTemp/r8l2-summary-probe.mjs` 取三态渲染 ② 实测 3280 页面条件是否成立 | 渲染链三态分明：有要点 → `A_PARAGRAPHS=4` 正文 + 元信息行「产出 11-01 01:00 · 轮转 21 次 · 0 条消息」；无要点 → 空态一行「本会话还没有会话要点（收工轮产出后出现在这里）」；端点失败 → 红字带原因。**3280 页面真点一次 = NOT RUN**：实测 `GET 3280/api/biz/config` → **404**（旧码在跑，`/api/biz/*` 未挂）→ **NOT RUN（卡面允许项，非缺陷）** |
| 4 | `node --check` 涉及文件全 0 错 | 三文件各实跑一次 | `memory.js` **exit 0** · `routes.js` **exit 0** · `session-state.js` **exit 0** → **PASS** |
| 5 | 既有路由抽 3 条冒烟，行为不变、贴状态码 | 直连在跑的 3210 独立打 | `GET /api/memory-files` → **200**（`files.length=13`）· `GET /api/memory-files/group_361820329` → **200**（键 6 个：`memberImpression,members,group,groupArchived,archiveStats,rapport`；`group=165` / `groupArchived=71`）· `POST /api/memory-files/consolidate`（空体）→ **400** `chatKey 格式错误` —— 与报告逐条一致 → **PASS** |
| 6 | `node tools/verify-ui-contract.mjs` 仍 PASS 58/58 | 实跑 | 八组 `9/9 · 7/7 · 7/7 · 8/8 · 13/13 · 3/3 · 2/2 · 9/9` · 总行 **`PASS 58/58`** → **PASS** |

**独立对账（附加，不进判据）**

| 项 | 报告自述 | 验证猫实测 | 一致 |
|:--|:--|:--|:--:|
| `routes.js` numstat | 13 增 / 1 删 | **13 / 1** | ✅ |
| `memory.js` numstat | 133 增 / 16 删 | **133 / 16**（小改前实测；小改后 139 / 22，差 6/6 即本卡附注三处注释加一处文案） | ✅ |
| `memory.js` 体量 | 65,183 B / 1,558 行 | **65,183 B / 1,558 行**（小改前；小改后 65,224 B / 1,558 行） | ✅ |
| `session-state.js` | 零改动 | `git status` 无此文件 | ✅ |
| `app/ui/style.css` | 零改动 | `git status` 无此文件 | ✅ |
| `verify-import-integrity` | `problems []` · 98 / 417 | **`problems: []`** · `filesScanned 98` · `symbolsChecked **417**` · `verdict ALL PASS` | ✅ |
| 写面越界 | L1 写 `app/src/web/**` | `git status` 中已无 `app/src/web/**`（L1 已提交）；本线两件属 L2 写面 | ✅ |

---

## ③ FAIL 明细

无。

---

## ④ 未取证

| # | 项 | 为什么没取 | 下一条可复现命令 |
|:--:|:--|:--|:--|
| 1 | 3280 页面「现行 / 归档」真点一次 + 要点区真渲染 | `/api/biz/*` 现全部 `404`（合龙未做）+ 业务面 3210 进程未重启（新路由不在其中）——两件前置都不在本线手里（卡 §0-4 禁起停） | 重启后：开 `http://127.0.0.1:3280/` → 「记忆」页签 → 选 `group:361820329`。断言：四 pane；点「归档 71」后群记 `field` 行 = 71 且无「改 / 删」按钮；要点区出现 4 段正文 |
| 2 | 新端点经 3280 的实锤 | 同上 | `node -e "fetch('http://127.0.0.1:3280/api/biz/memory-files/group_361820329/summary').then(async r=>console.log(r.status,(await r.text()).slice(0,200)))"` 期望 **200** 且体含 `"summary"` |
| 3 | 归档 >500 条的截断表现 | 本群归档只有 71 条，造数据要写归档池（越界） | 造 >500 条归档后打开切换视图，断言计数按 `archiveStats.group` 显示总数、列表截 500（`memory.js:441-443` 注释口径） |
| 4 | `private:*` 会话的归档 / 要点表现 | 13 个会话里只有群会话有归档数据（`memberArchiveStats` 全 0） | 选一个 `private` 会话打开记忆页，断言要点区三态与群会话同形 |

---

## ⑤ 附注

### A. 小改清单（自己改、自己核；零行为变更）

> 触发：`todo.md` **R8-1**（L1 核销时的清单外发现，处置口径写明「属 `app/ui/**`（R8 卡 §二 L2 写面），随 L2 面同轮改」）。本卡现持有该写面（执行猫已交报告 idle），按 §三「注释 / 文档 / 错别字 → ✅ 零行为变更」处置。四处全部为注释与提示文案，无一行动逻辑。

| # | 文件:行（改后） | 改了什么 | 为什么 |
|:--:|:--|:--|:--|
| 1 | `app/ui/views/memory.js:16` | 头注释「方法白名单只有 GET / POST / DELETE → PUT 恒 405」→「= GET / POST / PUT / DELETE → PUT 经单体可达」 | R8-L1 已放行 `PUT`（`business-proxy.js:17` 实读确认），旧注释误导后来人以为 PUT 仍不通 |
| 2 | `app/ui/views/memory.js:17` | 「已在 `updateGroupEntry` 内实现删旧+加新」→ 指明等价回落由 `rewriteGroupEntry` 承担 | 回落实现真身是 `rewriteGroupEntry:1255`（`updateGroupEntry:1227` 只做 405 转派），旧注释指向错误函数 |
| 3 | `app/ui/views/memory.js:1138` | `errOf` 的 JSDoc「405 单独点名——代理层方法白名单不含 PUT」→「不收该方法」 | 白名单已含 PUT，原句与实况矛盾 |
| 4 | `app/ui/views/memory.js:1145` | 405 提示文案「（单体代理层方法白名单只有 GET / POST / DELETE）」→「（单体代理层方法白名单不含该方法）」 | 用户可见文案写死了过时白名单；改成不带名单的中性表述，从此不再随白名单漂移（属「一行内常量」类，判据见下） |
| 5 | `app/ui/views/memory.js:1229-1230` | `updateGroupEntry` 内 405 分支注释：白名单改述 + 明示该回落现为防御路径 | 同 1、2；注明保留理由（旧进程 / 白名单回退时仍可用），防后来人当死代码删掉 |

**改后复跑该线自己的判据（§三要求）**：`node --check memory.js` **exit 0** · `verify-ui-contract` **PASS 58/58** · DOM 桩探针三态不变（165 / 71 / 165，归档态按钮集仍只剩两个切换键）· `grep "GET / POST / DELETE" app/ui/views/memory.js` 命中 **0**（R8-1 判据成立，见 §D）。

### B. 卡面错在哪（以实况为准，卡不改——主干独占）

| # | 卡面原文 | 实况 | 处置建议 |
|:--:|:--|:--|:--|
| 1 | §三 L2 判据 2：「**直连业务面 3210 打**（单体未重启则经单体不可用，报告标注）」 | 括注只考虑了单体未重启，漏了**业务面 3210 进程自己也需重启**才加载 `routes.js` 新路由——实测直连 3210 该路径恒 **404**，与「curl 回执」不可兼得 | 下轮卡改为「新端点用 `createRoutes` 进程内直调取回执；3210/3280 的实锤归重启后的验收线」——与执行猫 CR 1 结论一致 |
| 2 | §三 L2 判据 3：「会话要点在页面上真渲染一次；**依赖 L3 合龙**」 | 还多一层依赖：**新端点需业务面重启**才存在，仅合龙不够 | 补注「依赖 合龙 **+ 重启**」——与执行猫 CR 2 结论一致 |
| 3 | §三 L2 判据 1：N/M 取「本轮基线 `groupCount 165` / `groupArchived 71`」 | 逐字相符（本次实测 165 / 71 / 71）——**无偏移**，仅登记 | 无 |

> 两条 CR 均为执行猫按 §0-6「报主干、不改卡」提出，验证猫复跑后**逐条确认为真**。卡 `tasks/R8.md` 属主干独占写面，本卡不代改。

### C. 报告数字口径两处（不影响结论）

| # | 项 | 说明 |
|:--:|:--|:--|
| 1 | `ROUTE_TOTAL` 97 与 `grep` 计数 98 | 报告 97 = `routes` 数组长度（正确）；按 `method:` 行 grep 得 98，多出的 1 条是 `routes.js:4` 的**格式注释行**（`//   - method: 'GET' \| 'POST' …`）。报告数字正确，无需订正 |
| 2 | `symbolsChecked` 417 | 与 L1 判定卡记的 417 一致（L1 报告记 416 是因为它的跑测时刻早于 L2 落盘）。本线报告记 417 **正确** |

### D. 清单外发现与处置

| # | 发现 | 处置 |
|:--:|:--|:--|
| 1 | `todo.md` **R8-1**（7 处按旧白名单描述代理层）判据为「重启后 grep 命中 **0**」——本卡按注释类小改后该短语命中已 **0**，无需等重启（判据本身不依赖进程） | 本轮已核销，`todo.md` R8-1 行就地改注「已核销」+ 依据 |
| 2 | 执行猫报告 §三-② 称 `groupArchived` 由 `limit: 500` 截断、计数走 `archiveStats.group` —— 代码实读 `routes.js:1335` 与 `memory.js:449-451` 均属实 | 无需处置，登记为口径正确 |

---

## ⑥ 遗留

**无新一代卡。** 余项全部落在**同一张卡的 L3 线**（`tasks/R8.md` §三 L3 = 三批线，判据 1–6 正是本卡 §④ 未取证 1 / 2 的受理方），不另起卡：

- 3280 页面级真点一次 / 新端点经 3280 的实锤 → `tasks/R8.md` §三 L3 判据 1–3、6
- 归档 >500 条截断 / `private:*` 会话表现 → 非本轮必验项，随 L3 页面验收顺带看

**下一步不归本卡**：L1、L2 两线均已交并核销完毕，按卡 §五-2「三批由主干把 N 改 1 再起」——L3 的派活归主干，本卡不自推。

---

## 本线已核销

Q-001 线 L2 核销完成：**PASS**（判据 3 按卡面口径 NOT RUN，非缺陷）· 缺口 4（全部转 L3 或非必验）· 下一代卡 **无**。
