# design-qqbotb-session.md — 会话生命周期与记忆面（QQ Agent 卫星）

> 关联：`design-qqbotb.md`（总纲）· `design-qqbotb_log.md`（兑现明细）· 创建：2026-10-09
> 定位：设计理念与最终目标（不带进度信息）。来源：Rushiera 2026-10-09 口述规格。
> 规格摘要：对话保存 → 每次注入前文 → 上下文超阈值自动收工 + 整理记忆面 → 自动开新会话；全程 qqbot 自持，无人在环；中途 429 类故障自检轮询续跑。

---

## 一、目标

让群里的机器人像 CH4 的猫一样「活着」：**一条持续会话**（不是每次运行的临时上下文），前文每次注入，上下文到顶时自己收工、把要点沉淀进记忆面，然后自己开新会话。

已确认输入：`hy4-preview-f` 上下文窗口 ≥600k tokens → 阈值取 **300k（保守值）**。

## 二、现状 → 目标

| 面 | qq-agent 现状 | 目标 |
|:--|:--|:--|
| 上下文 | 无状态：每次运行只带【已读信息】`historyCount`=80 条 + 前文 | **会话全量**：本轮会话（上次收工之后）全部消息 + 前文 |
| 会话边界 | 无——存档无限累积 | **收工即边界**：旧存档归档 → 当前存档清零 = 新会话 |
| 记忆面 | 群友印象 `data/memory/<chat>/<QQ>.json` + 6h 自动整理 | 增加**会话级记忆**：每轮收工产出要点摘要，跨会话携带 |
| 收工触发 | 无 | 上下文估算 > 300k tokens |
| 失败恢复 | llm 层指数退避（1s→2s ×3）+ 会话级重试 2 次 + WS 端口 2s 轮询 | 沿用；429 长时限流 → 轮询等待续跑，不判失败（B10） |

## 三、实现落点（qq-agent v0.4.0 源码）

| 处 | 文件 | 做什么 |
|:--|:--|:--|
| 会话状态 | 新增 `src/session-state.js` | `data/session-state.json`：每 chat 一条 `{ startedAt, lastPromptTokens, rollovers }` |
| 触发判据 | `src/orchestrator.js` wake 路径（防抖聚批后、`sessions.create` 之前） | 估算上下文 = 上轮 `usage.promptTokens` + 本次触发批字符数/1.5；超阈值 → 走收工轮 |
| 收工轮 | `src/orchestrator.js` | 起一次特殊运行：系统注入指令「本轮为收工轮——把本轮会话要点与待续事项用 `memory_append` 沉淀，然后安静结束」，**不对外发言** |
| 轮转 | `src/store.js` | 收工完成后：存档移 `data/store/archive/<chat>-<ts>.json` → 清空当前存档 → 重置该 chat 的 session-state |
| 记忆注入 | `src/prompt.js` | 【记忆】段先放会话级摘要（`_session.json`），再放群友印象 |
| 配置 | `src/config.js` | `session: { enabled: true, maxContextTokens: 300000 }` |

## 四、验收

| # | 判据 |
|:--:|:--|
| 1 | 会话内消息全量进上下文（不再只 80 条）——运行详情里 `userPrompt` 覆盖本轮会话全部消息 |
| 2 | 估算过阈值 → 自动起收工轮 → 无对外发言 → 存档归档 + 清零 → 下一条消息起为新会话（会话页可见边界） |
| 3 | 收工轮产出的要点出现在下轮提示词的【记忆】段 |
| 4 | 429 连续限流下不判失败：退避轮询直到恢复，恢复后本轮继续 |
| 5 | 改动以 `tools/patch-qqagent-session.mjs` 落盘（可重装复现）；重启应用即生效 |

## 五、边界与铁律

- 不动 qq-agent 的安全边界、发送队列与 Electron 壳——只动编排 / 存档 / 提示词三处
- **应用运行中改源码不生效**（启动时加载）——实施后需重启一次应用。**界面块除外**：`app/ui/views/*.js` 是静态文件，由单体按请求热读，改完刷新页面即见；只有新增 `<script>` 标签与脚本执行序的改动需重启单体（R5 · 2026-10-31）
- `_unpack/` 在 `project.md` 里标「可弃」——**补丁脚本是唯一真相**，重装后重跑即复现
- `historyCount` 保持 80，直到收工轮落地——先放开全量会让上下文无界增长（窗口 ~600k 也不是无限的）
- 阈值 300k 与模型窗口解耦：窗口变化只改 `session.maxContextTokens`

## 六、卡死看门狗（2026-10-10 追加）

**问题：** 上游端点卡住时（请求挂起 / 流式中途不动），一轮运行可能长时间既不中止也不发言——面板上表现为"思考好久没动静"，群里的消息也迟迟得不到回应。

**目标：** 运行超时**自动中止 + 恢复未读 + 重排**——消息不丢，等上游恢复后重新思考。

| 面 | 设计 |
|:--|:--|
| 判据 | 运行中的会话，`max(startedAt, updatedAt)` 距今超过 `stall.timeoutMs`（现行 150s）——只要还在推进就不算卡死 |
| 巡检 | 每 `stall.checkIntervalMs`（20s）扫一次运行中的会话（`activeRuns`） |
| 动作 | 打中止标记 + abort 在途请求（reason 含"中止"→ 判不可重试，不会再打下一发）→ 把本会话起点之后的未读恢复为未读 → 3 秒后重排 |
| 重排 | 复用并发重排同款延迟；若会话尚未让出并发槽，消息留在未读、由下次触发一并处理——**不会丢** |
| 与请求超时互补 | `api.timeoutMs`（现行 90s）管**单次请求**；看门狗管**整轮运行**（工具循环卡住 / 某步 await 挂死） |
| 回退 | `stall.enabled=false` 完全回到旧行为 |

## 七、系统提示段（2026-10-10 关闭）

**规格（Rushiera 2026-10-10）：** 每轮运行重发的系统提示段（`buildSystemPrompt()` 产物 · 4360 字符 · 安全规则 / 工具协议 / 反 AI 味 / 分条发送等行为准则）不再发送——运行提示词只留用户消息（角色设定 + 存档消息 + 记忆 / 话题词 / 发言热度 / 配额等动态段）。

| 面 | 设计 |
|:--|:--|
| 开关 | `persona.systemPromptEnabled`（全局配置 · 默认 true）——false 时 `buildSystemPrompt` 整段返回空 |
| 发送面 | 系统提示为空时不发 system 消息（空 content 的 system 会被部分端点拒绝） |
| 落点 | 补丁 `tools/patch-qqagent-nosys.mjs`（幂等 · 锚点唯一校验 · 重装后重跑即复现） |
| 后果 | 安全规则 / 工具协议等约束随段消失——模型行为约束只剩工具定义与用户消息 |
| 回退 | `persona.systemPromptEnabled` 改回 true（或删该字段）→ 重启应用 |

## 八、按群折叠（多群扩展 · 2026-10-10）

**规格（Rushiera 2026-10-10）：** 现在只开一个群；准备扩到多群——会话按群折叠、不同群视为不同会话、记忆按群收，形态对齐 CH4 的「每猫一套会话」。

**目标群清单（Rushiera 逐条登记）：**

| # | 群号 | 群名 | 状态 |
|:--:|:--|:--|:--|
| 1 | 1097492606 | SC2INV合作交流2群 | 现行（白名单 `allow.groups`） |
| 2 | 689942975 | 工仔养生水疗中心（31 人 · `get_group_list` 实测） | 已登记，白名单已开 |
| 3 | 940257985 | KKCardMod开发测试群（38 人 · `get_group_list` 实测） | 已登记，白名单已开（2026-10-10） |

**数据层现状（已满足）：** 消息存档 `data/messages/<chat>.json`、会话状态 `data/session-state.json`（每 chat 一条）、记忆 `data/memory/<chat>/`、运行记录 `data/sessions/*.json`（带 chatKey）——全部以 chatKey 为键，天然隔离。会话窗口（`startedAt`）、收工轮、归档轮转、发言配额、botGuard 也都在 chatKey 粒度上。

**缺口只有一个：会话页把运行记录平铺** —— 多群并行时看不出「每个群各自的会话进行到哪」。

**设计：会话页两级结构**

| 级 | 内容 | 来源 |
|:--|:--|:--|
| 一级 · 群会话 | 每 chatKey 一行：群名 / 当前会话起点 / 前文规模 / 轮转次数 / 未读 / 最近活跃 | `session-state.json` + `store.getChatMeta` + 群名缓存 |
| 二级 · 运行记录 | 该群的 run 列表（现状列表按 chatKey 过滤），点击展开 | `sessions` 索引 |

- 默认折叠；展开态记住（刷新不丢）
- 运行中 / 等待中的会话自动展开其所属群
- 排序：有运行中 > 有未读 > 最近活跃

**载体（R5 · 2026-10-31）：** 本节的两级结构由单体「会话」页签承载——视图块 `app/ui/views/sessions.js`（左栏一级群会话、右栏二级消息详情），取数走代理层 `/api/biz/sessions` 与 `/api/biz/chats/*`（转发业务面 `127.0.0.1:3210/api/*`）。会话页不接 SSE：刷新由进入页面与手动刷新按钮触发，代理层只做请求-响应。

**扩群动作（按群自动成档，无需额外开发）：** 白名单 `allow.groups` 增群号 → 该群第一条消息到达即自动建消息存档、会话状态、记忆目录；群名走 `get_group_info` 缓存。

**判据：**

| # | 判据 |
|:--:|:--|
| 1 | 多群同时有运行时，一级列表每群一行，互不混淆 |
| 2 | 展开某群只看到该群的运行记录 |
| 3 | 群会话头部显示该群当前的会话起点与前文规模（= 该群独立会话的实锤） |
| 4 | 新群开跑后 `data/messages/`、`data/memory/`、`session-state.json` 三处各自出现该群条目，互不串味 |

---

## 九、已读信息分段摘要（B22 · 2026-10-18）

**问题（`ref-prompt-baseline.md` 实测）：** 会话窗口模式下【已读信息】= 会话起点之后的**全部消息**，是 prompt 里唯一随天数线性增长的段。最大群 10-17 13:13 实测 **156,825 字符 ≈ 10.4 万 tok，占整个 prompt 59.7%**；记忆整理（consolidate）只处理群友印象 / 群记，**不碰已读**；已读只靠收工轮轮转收缩（`session.maxContextTokens` 160,000 tok），单会话能吃到 16 万 tok 才收工。

**目标：** 同群稳态下【已读信息】≤ `session.readMaxChars`（默认 60,000 字符）；较早的已读压缩成【前情提要】摘要段，原文退出提示词但保留在存档（`get_recent_messages` 可翻），摘要可被 `memory_search`（`category=history`）检索——跨天事实不丢。

### 9.1 结构

| 面 | 设计 |
|:--|:--|
| 窗口起点 | `session-state.json` 每 chat 增 `readFloorTs`（0 = 未压缩）。普通轮【已读信息】取 `max(会话起点, readFloorTs)` 之后的全部消息；**收工轮不套 readFloor**（仍按会话起点 / 记忆回溯点取全量，保证记忆沉淀能吃到原文）。 |
| 摘要载体 | `data/memory/<chat>/_readlog.json`：`{ chatKey, segments: [{ id, fromTs, toTs, messageCount, chars, summary, createdAt }], updatedAt }`。单段摘要 ≤2,000 字符；活跃段软上限 200，超出转归档。 |
| 归档 | `data/memory/<chat>/archive/readlog-<yyyyMMdd>.jsonl`（append-only，按天分卷）；收工轮把活跃段整批归档并清空，`readFloorTs` 随 `resetSession` 归零。 |
| 压缩触发 | 每轮**普通运行成功结束后**异步检查（不阻塞聊天）：详细已读字符 > `readMaxChars` → 取最旧前缀，直到剩余 ≤ `readKeepChars`（默认 40,000）；按 `readCompactChunkChars`（默认 50,000）分块交**摘要模型**（`readSummaryModel`，必须快档）压成 3~8 条短句；逐块 `appendReadSegment`，全部成功后 `readFloorTs = 最后一条摘要消息 ts + 1`。任一块失败 → 不推进 floor（原文保留），下一轮再试（失败后 10 分钟退避）。 |
| 前缀缓存 | 压缩成功后清掉该 chat 的 `promptAnchors`（窗口起点变了，旧锚点必然失效）；下一轮按新窗口重新锚定。未压缩时锚点机制原样不动。 |
| 提示段落 | 【前情提要】插在【记忆】之后、【已读信息】之前（同一会话内稳定，不打断缓存前缀）：只展开最近若干段（总字符 ≤ `readDigestMaxChars`，默认 8,000），段尾明示更早段数 + `memory_search category=history` / `get_recent_messages` 取法。 |
| 检索 | `memory_search` 增 `category=history`：搜活跃摘要段 + 归档摘要段 + 历次会话要点（`_session.json` 现行 + `archive/session-*.jsonl` 归档）。`all` 也带 history。 |
| 轮转 | `#completeRollover`：先把上一份 `_session.json` 归档，再写新要点；再把 `_readlog.json` 活跃段整批归档；最后 `archiveAndClear` + `resetSession`（`readFloorTs=0`）。归档失败只留痕，不阻断轮转。 |

### 9.2 配置

```js
session: {
  enabled: true,
  maxContextTokens: 160000,      // 收工轮阈值（现行运行值；代码默认仍 300000）
  readMaxChars: 60000,           // 详细已读字符预算；0 = 关闭本功能（回到会话全量）
  readKeepChars: 40000,          // 压缩后保留的详细字符数
  readCompactChunkChars: 50000,  // 单次摘要调用最多吃多少字符
  readDigestMaxChars: 8000,      // 【前情提要】注入总字符上限
  readSummaryModel: 'deepseek-v4.1-flash',   // 摘要模型（必须快档）
  readSummaryMaxTokens: 4000
}
```

**🔴 摘要模型必须选快档。** 主模型 `hy4-preview-f` 是推理模型：纯文本压缩请求会先产数百到数千 token 推理，`max_tokens` 被推理链吃光后 `content` 恒空（2026-10-18 实测：3,729 字素材 + `max_tokens=3000` → `finish=length`、reasoning 10,118 字符、content **0** 字符、耗时 42.9 秒）。快档 `deepseek-v4.1-flash` 同样素材 **10.6 秒**出稿、content 156 字符。空模型时回落记忆整理模型（`memory.useChatModel`）。

### 9.3 判据（验收）

| # | 判据 |
|:--:|:--|
| 1 | 同群稳态下【已读信息】字符数 ≤ `readMaxChars`（压缩后含【前情提要】仍 ≤ `readMaxChars + readDigestMaxChars`） |
| 2 | 压缩后旧消息不再出现在【已读信息】，但【前情提要】能看到其摘要；`get_recent_messages` 仍能翻到原文 |
| 3 | `memory_search category=history` 能按关键词搜到活跃摘要段与归档摘要段；轮转后旧摘要仍可搜 |
| 4 | 收工轮仍按全量窗口取材（不因 readFloor 截断记忆沉淀） |
| 5 | `readMaxChars=0` 时行为与今日完全一致（会话全量 + 原锚点机制） |
| 6 | 摘要调用失败时原文保留、`readFloorTs` 不变、下一轮可重试 |

### 9.4 边界（不做）

- 不做向量化 / 语义检索——仍走关键词（与 v0.73 记忆检索同口径）。
- 不改 `tier=4` 的「全量」语义：全量的是**当前详细窗口**；窗口外的旧段由摘要段承载。`readMaxChars=0` 即回到今日的「会话全量」。
- 不改 `session.maxContextTokens` 的收工轮判据、不改消息存档格式、不改发送链。
- 摘要段只增不改；原文永不删除（只在轮转时随存档归档）。
