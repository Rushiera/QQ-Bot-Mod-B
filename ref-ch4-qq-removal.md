# ref-ch4-qq-removal — 宿主 QQ 域移除（A299）与重新适配接口

> 类型：外部参考（上游变更拆解）| 创建：2026-11-02
> 触发：mau 仓库合并 upstream `origin/master` `79562465`（v1.8.204）——A299 把 CH4 宿主内置 QQ Bot 整仓归档
> 定位：宿主删掉哪些 QQ 契约、还剩哪些可用面、本支曾在其上改过什么、QQBotB 怎么接回来。适配前先读本文件，不重读归档源码。
> 关联：`project.md`（本项目定位与边界）· `design-qqbotb-navigator.md`（领航员模式——`cat.chat` / `Chat ` 双通道现役用法）· `ref-navigator-map.md`（单体 API 全景）
> 证据基线（2026-11-02 实测）：`AdminRoutes.cs` 30 端点表全量实读 · `CatEntry` / `CatCfgData` 字段实读 · 关键词 grep 计数（`qqbot` / `QqBot` / `CH_QqBotConfigStore` / `SetCollector` / `api/v1/command` / `api/v1/cats`）· `_archive/CatHome4.QQ/` 21 件清单

---

## 一、A299 是什么

| 项 | 实况 |
|:--|:--|
| 上游提交 | `79562465`——「A299 QQBot 整体移除：整仓归档 `_archive/CatHome4.QQ/`，接线/管理面/内核/前端 18 处清零」（v1.8.204） |
| 归档面 | `CatHome4.QQ/` 9 件（`QQBotService` / `QQBotConnection` / `IQqTargetCollector` / `QqFileMarker` / `QqInfoFormatter` / `QqLastReplyPlanner` / `QqReplyScan` / `QqTextSplitter` + csproj）· `CatHome4.QQ.Tests/` 10 件 |
| 归档位置 | `mau:_archive/CatHome4.QQ/`——sln 未引用，**不进编译** |
| 删的是哪条链 | CH4 宿主内置的**模式 A**（QQ 官方 Bot 开放平台 WebSocket 直连）——不是模式 B（OneBot） |
| 合并后宿主残留 | `CatHome4/**` 的 `qqbot` 关键词 5 命中，全部非接线：`Program.BootSteps.cs:653` 一条注释 + 前端测试 fixture 4 处（`panel-cats.test.mjs:26`、`panel-tpl-apply.test.mjs:188/191`） |

---

## 二、宿主侧删掉的契约（缺口清单——适配时不能假设它们还在）

| # | 契约 | 现状（Observed） |
|:--:|:--|:--|
| 1 | `cat.cfg` 两字段 `qqbotId`（Guid）/ `qqbotEnable`（bool） | `CatEntry` 与 `CatCfgData` 类定义实读均无此二字段——读写 / 模板 / 前端全链移除 |
| 2 | 宿主对 `CH_QqBotConfigStore` 的绑定 | 代码仍在 `mau:Mau/Mau.Runtime/`（`CH_QqBotConfig.cs` + `CH_QqBotConfigStore.cs`，随 Mau.sln 编译），但宿主侧 `CH_QqBotConfigStore` 引用 **0** 命中——无 `DataBox.Bind`、无消费方 |
| 3 | 管理端点四条 `GET/POST /api/v1/qqbot-apis`、`/edit`、`/delete` | 30 端点表实读无此四条 |
| 4 | `cat-config` GET 回执字段 `qqbotOptions` / `qqbotId` / `qqbotEnable` | 回执面已无（字段随 #1 消失） |
| 5 | `cat-config` POST 的 qqbotId 1:1 查重（A58：1 Bot : 1 猫） | 随字段消失，校验一并消失（Inferred——代码面无校验可读） |
| 6 | `ChatBridge.DefaultQqBotId` / `DefaultQqBotEnable` | 宿主 `QqBot` 关键词 0 命中非注释 |
| 7 | 启动路径 `QQBotService.SetCollector(new QqTargetCollector())` + `SetFileCacheRoot(Data/qqbot-files)` + `Start()`（原 S7 段） | 宿主 `SetCollector` / `QQBotService` 0 命中 |
| 8 | `CatHome4.Contracts.QqSource` 类型 | 定义在 `_archive/CatHome4.QQ/QQBotService.cs:2127`——已随归档离开宿主编译面 |

---

## 三、宿主保留的相邻面（可以直接复用）

| 面 | 落点 | 说明 |
|:--|:--|:--|
| **用户态 + QQ 非用户指令开关** | `CatHome4.Contracts/UserStateKeys.cs`（`Current` / `QqIds` / `QqAcceptNonUser`）· `AdminService.UserState.cs` · `GET|POST /api/v1/user-state` | 与 QQ 无关的通用面，A299 未动——**身份标记所需的三键仍由宿主提供**（见 §四） |
| 图片通道 | `POST /api/v1/chat-images`（原始字节入库）· `GET /api/v1/cache-image/{file}` | 本支保留，图片可用 |
| 指令总线 | `POST /api/v1/command`（`HttpHost.cs:299`） | 面板 / CLI / 工具桥三面同源单内核 |
| 猫列表 / 详情 | `GET /api/v1/cats`（`HttpHost.cs:323`）· `GET /api/v1/cat-detail?cat=<key>`（含 `isIdle`） | 多猫观测面 |
| 每猫配置 | `GET|POST /api/v1/cat-config` | 写面语义 = 整对象替换（未提交字段回落默认值）；**字段级合并写走工具面 `config-cat-set`** |
| `cat.new-session <key>` | 管理指令族 | 本支独有指令，2026-11-02 合并中改接 A281 统一输入分发（`DispatchInput(目标, "session.new")`，忙则延后由路由表承担）——回执「已请求新会话: <name>」 |

---

## 四、本支（RushieraChange）在 QQ 面上的独有改动

**重新适配时必须带上，否则合并回宿主时丢功能：**

| # | 改动 | 机制 / 依赖 |
|:--:|:--|:--|
| 1 | **消息头身份标记** | `[私聊\|<当前用户>]` · `[群@\|昵称(角色)·本人]` · `[群@\|昵称(角色)·非用户]`（加 `·视为指令` 当开关开启）——依赖 `UserStateKeys.Current` / `QqIds` / `QqAcceptNonUser` 三键；测试全量在 `_archive/CatHome4.QQ/CatHome4.QQ.Tests/QqHeaderTests.cs` |
| 2 | **图片包裹 → 富媒体单发** | 上游 A215–A217 合入，本支继承；判据与格式 → `design-ch4-chat-images.md`（宿主侧实现仍在 `AdminService.ChatImages.cs`） |
| 3 | **文件通道群聊放行 + 发送标记** | `[QQBot发送文件:"<绝对路径>"]`（`QqFileMarker`，≤10MB · 私聊 / 群聊） |
| 4 | **最后回复扫描 / 分片** | `QqReplyScan` / `QqTextSplitter` / `QqLastReplyPlanner`——长回复分段与「只发最后一条」语义 |

---

## 五、两条链的边界（避免下一轮误接）

| 链 | 形态 | 与 CH4 的关系 |
|:--|:--|:--|
| **A（已归档）** | 宿主内置 `CatHome4.QQ`——官方 Bot WebSocket 直连，被动回复 4 次预算 | A299 删的就是它 |
| **B（本项目）** | NapCat.Shell 协议端 + Electron **QQ Agent 独立进程**（`runtime/NapCat/`），OneBot 11 | 卫星程序，只经 HTTP 面与宿主交互 |

两条链不是同一条，不共享连接层；A 归档不影响 B 运行。

---

## 六、接回来的实现方式

**推荐路径（宿主侧只留通用面，QQ 全在 QQBotB）：**

1. QQBotB 自己的进程收 QQ 消息 → 组装内容
2. `POST /api/v1/command` body `{text: "cat.chat <key> <内容>"}` 投递目标猫（**不要**用 `Chat ` 前缀投主干默认会话，除非确实要投默认猫）
3. 需要读回执 / 状态：`GET /api/v1/cats`、`GET /api/v1/cat-detail?cat=<key>`
4. 图片：`POST /api/v1/chat-images`（原始字节）→ 由宿主回 `cache-image` 路径
5. 身份标记（§四-1）在 **QQBotB 侧组装**——三键读 `/api/v1/user-state`，不要再指望宿主拼 `[私聊|…]` 头
6. 开新会话：`cat.new-session <key>`

**不推荐：** 把 `_archive/CatHome4.QQ` 反搬回宿主——A299 的 18 处接线全要反做，且每次合并上游都要重解一遍冲突；连接层能力在 QQBotB 已具备。

**判据：** 宿主仓库里除本文件与合并提交说明外，不出现 QQ 接线；QQ 语义只活在 QQBotB。

---

## 七、回滚坐标与判据

| 用途 | 坐标 |
|:--|:--|
| 源码全集 | `mau:_archive/CatHome4.QQ/`（21 件，含测试） |
| 上游提交 | `79562465`（git log 可查 `A299 QQBot 整体移除`） |
| 本支合并前基线 | 分支 `backup/pre-merge-1.8.150` → `db5a5a96`（v1.8.150） |
| 本支合并提交 | `5b034cb7`（合并 1.8.141-v1.8.204 + A299 移除 + `cat.new-session` 重做） |
| 核验判据 | `mau:CatHome4/**` 的 `qqbot` 关键词只应命中注释与前端 fixture；`AdminRoutes.cs` 无 `qqbot-apis`；宿主 `CH_QqBotConfigStore` 引用 0 |
