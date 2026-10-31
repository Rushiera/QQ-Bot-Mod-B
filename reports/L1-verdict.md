# R8-L1 判定卡 · 代理层 `PUT` 双闸修复

> 队列编号：Q-001 · 轮次：R8 · 线号：**L1** · 核销角色：单线验证猫（只核本线，不核 L2 / L3）
> 核销时刻：2026-11-01 07:20 · 对象：`workspace:QQBotB/reports/R8-L1.md`
> 报告在盘实锤：**9,911 B · mtime 2026-11-01 07:05**
> 哨兵三项（`tasks/.concurrency.json` 实读）：轮次 **R8** / N=**2** / 卡路径 **`tasks/R8.md`**；`status=在跑` `nextIndex=3` `closed=0`
> 写面交集确认：本卡写 `reports/L1-verdict.md` + `CHANGELOG.md` + `todo.md`；在途 L2 写 `app/ui/views/memory.js` + `app/src/business/routes.js` → **交集为空**

---

## ① 结论

**PASS** —— 卡 §三 L1 五条判据全部通过，其中判据 1/2/3/4/5 均由验证猫**独立复跑**（未采信报告数字）：进程内直调 14 条断言全 `true`，两文件 `git diff --numstat` 与报告自述逐字一致（12/6 · 18/2）。

---

## ② 判据逐条复核

| # | 卡面判据 | 复核手段 | 回执 |
|:--:|:--|:--|:--|
| 1 | `ALLOWED_METHODS` 回读含 `PUT`；405 文案与白名单**逐字一致** | `text-read` 全文 + 进程内实跑 `PATCH` | `business-proxy.js:17` = `new Set(['GET','POST','PUT','DELETE'])`；`:20` `BODY_METHODS = new Set(['POST','PUT'])`；`:23` `ALLOWED_HINT = [...ALLOWED_METHODS].join(' / ')`；`:176-177` 文案走 `ALLOWED_HINT`。实跑 405 体：`不支持的方法：PATCH（只允许 GET / POST / PUT / DELETE）` → **PASS** |
| 2 | `readBody` 调用点让 `PUT` 取到体（进程内直调，允许临时 node 进程、禁起停单体） | 自建独立脚本 `tools/CatTemp/r8l1-VerifyCat.mjs`：起假业务面 + 真 `createWebServer({port:0})` + 真 `createBusinessProxy`，跑完 `stop`+`close` | **14/14 断言 true**（`allPass:true`）：代理直调 `PUT` 200 且 `echoedBody.a===1` · `echoedMethod==='PUT'`；单体链路 `PUT /api/biz/echo` 200 `a===1`；自研分支 `PUT /api/self-echo` 200 `seen.b===7`；`PATCH` 405；`DELETE`/`GET` 200 且 `echoedBody===null`（不读体回归） → **PASS** |
| 3 | `node --check` 两文件各退出 0 | 实跑两次 | `business-proxy.js` **exit 0** · `server.js` **exit 0** → **PASS** |
| 4 | `verify-ui-contract` 仍 PASS 58/58（组⑦ 代理层 2/2 不退化） | `node tools/verify-ui-contract.mjs` 实跑 | 八组 `9/9 · 7/7 · 7/7 · 8/8 · 13/13 · 3/3 · **2/2** · 9/9` · 总行 **`PASS 58/58`** → **PASS** |
| 5 | `verify-import-integrity` 的 `problems` 仍 0 | 实跑 | `filesScanned 98` · `symbolsChecked **417**` · `problems: []` · `verdict: "ALL PASS —— 跨模块导入符号齐备"` → **PASS**（符号数与报告的 416 差 1，见 §⑤-3） |

**独立对账（附加，不进判据）**：`git diff --numstat` → `app/src/web/business-proxy.js 12 6` · `app/src/web/server.js 18 2`，与报告 §读数一逐字一致；`git diff` 逐行读过，改动面只有「白名单纳 `PUT` · 新增 `BODY_METHODS`/`ALLOWED_HINT` · 带体条件改集合 · 两处 `readBody` 调用条件 · 新增 `methodHasBody`」五项，头部七条设计口径除「只放行…」那条外逐字未动。

---

## ③ FAIL 明细

无。

---

## ④ 未取证

| # | 项 | 为什么没取 | 下一条可复现命令 |
|:--:|:--|:--|:--|
| 1 | 3280 上 `PUT /api/biz/...` 返回非 405 | 前置 = 单体重启（卡 §0-4）；**本轮实测 `GET 127.0.0.1:3280/api/biz/config` → `404 {"ok":false,"error":"not found"}`**，即 3280 上跑的仍是旧码 | 重启后 `curl -X PUT -H "Content-Type: application/json" -d "{\"goal\":\"R8-L1 验\"}" http://127.0.0.1:3280/api/biz/memory-files/group_361820329/members/1286860918` |
| 2 | 业务面 3210 收到 `PUT` 后真写入 | 同上；且本线禁碰 `app/src/business/**`（本轮 3210 `GET /api/memory-files` → **200**，`groupCount 165` / `groupArchived 71`，业务面本身活着） | `curl -X PUT … http://127.0.0.1:3210/api/memory-files/group_361820329/members/1286860918` + 随后 `GET` 同路径读回 |
| 3 | 页面「成员 存」按钮真生效 | 需单体 + 业务面双双就绪 | 打开 3280 → 记忆页 → 群友印象「编辑 / 存」，看提示行 + 读回值 |

三条与报告 §未取证一致，**归 `tasks/R8.md` §三 L3（判据 3 / 6）**，不记本线缺口。

---

## ⑤ 附注

### 5.1 卡面错在哪（以实况为准，记 4 条）

| # | 卡面 / 报告面写的 | 实况 | 影响 |
|:--:|:--|:--|:--|
| 1 | 卡 §三 L1 判据 2：「**三处** `readBody` 调用点（`:118` / `:132`，及改动后新增/合并处）」 | 改前就是**两处**（`:118` / `:132`），改后仍是**两处**（`:134` / `:148`）；新增的是一个 helper `methodHasBody`（`:63-65`）。「三处」把 helper 与调用点混成一种东西 | 判定按「两处调用点 + 一 helper 全部经同一判定」通过；不改变结论，但卡面表述会误导下一轮以为有三处独立读写点 |
| 2 | 卡 §三 L1 必读：`server.js:50-70`（`readBody` 实现）· `:110-140`（两处调用点） | `readBody` 定义实为 `:73`；两处调用改后落 `:134` / `:148` | 判据 3 / 5 的定位仍成立（文件级），行号需按改后坐标读 |
| 3 | 报告 §三：「跑测命令：`node …\r8l1-put-test.mjs`」 | 该脚本**在盘不存在**（`Test-Path` → `False`），报告自称「收工前删」——即**报告的复跑命令在核销时已失效** | 判据 2 不因此落空：验证猫另写 `tools/CatTemp/r8l1-VerifyCat.mjs`（14 断言，覆盖代理直调 + 单体装配链两分支），结论独立成立。**该脚本核销后保留在盘**（未按收工纪律清理——它就是判据 2 的复现路径，删了等于重犯本行这条错误）。**教训：报告里给的可复跑命令，脚本必须留到核销之后** |
| 4 | 报告 §读数一 括注「删的 6 + 2 行全部是被替换的旧行（…两处 `readBody` 1 行…）」 | `numstat` 的 12/6 与 18/2 本身对得上，但括注列的删行明细不足 8 行 | 表述瑕疵，不影响判定 |

### 5.2 小改清单（本线自改自核）

**无** —— 本线未改任何代码与文档代码面。

### 5.3 清单外发现（不改判定）

1. **报告回执④ 的变更请求仍在盘**：`app/ui/views/memory.js` 里按旧白名单描述代理层的位置共 **7 处**——`:16`（头部注释）· `:1145`（405 提示文案）· `:1229`（注释）· `:1138` / `:1231` / `:1248` / `:1270`（405 回退路径段）。报告记「5 处」又在末句写「6 处」，计数偏软。该面属 L2 写面（`app/ui/**`），本线不改，已记 `todo.md`。
2. **工作树里另外两处改动属 L2，不是 L1 越界**：`git status --porcelain` 显示 `app/ui/views/memory.js`（133 增 16 删）与 `app/src/business/routes.js`（13 增 1 删，新增 `/api/memory-files/(group|private)_<id>/summary` 路由 + `readSessionSummary` 导入），与 R8 卡 §二 L2 行一致。L1 声明的两处改动与 `git diff` 逐字对应，**零越界**。
3. **判据 5 的 `symbolsChecked` 报告 416 / 实测 417**：同期 L1 新增 `methodHasBody`（`server.js`）与 L2 新增 `readSessionSummary` 导入（`routes.js`）叠加所致；`problems` 仍 `[]`，判据不受影响。报告跑该脚本的时刻早于 L2 落盘。
4. **`reports/_index.md` 未写**：卡 §二 声明该件为「主干独占」，本线按卡执行、不越界。`reports/_index.md` 的 R8 节登记归主干（逐线模式下由主干或最后一条线收线时统一登记，避免两条验证猫互覆盖同一节）。

---

## ⑥ 遗留

**无新卡。**

- 真链路三条（3280 `PUT` 非 405 · 3210 真写入 · 页面「成员 存」）已由 `tasks/R8.md` §三 **L3** 承载（卡在盘，前置 = Rushiera 双击 `启动QQBotB.vbs`），不另开卡。
- `memory.js` 七处旧口径文案记入 `todo.md` 的 R8-1 行，随 L2 面处置（属文档级修正，不是新功能）。

---

## 本线状态

**Q-001 线 L1 已核销（PASS）** —— 判定卡在盘，本会话结束回合。未发 `cat.delete`（删猫归调度器）；未改队列行状态列（归调度器）。
