# QQBot mod B — 兑现明细（M1 通道实测）

> 关联设计：`design-qqbotb.md` · 状态标记：✅ 已兑现 / ⏳ 进行中 / ⬜ 未开始
> 定位：本设计下辖模块的兑现明细——证据的唯一承载处（参数 / 实测口径 / 日期）。

---

## 未闭合项

| 项 | 说明 | 状态 |
|:--|:--|:--|
| 协议端 WebUI 监听面 | 现监听 `::`（全网卡）——建议收窄至 `127.0.0.1`；属协议端自身配置，待 Rushiera 定 | ⏳ 待定 |
| 日志时间戳对齐 | 日志页协议端行的外层时间戳为**转发时刻**（同批历史日志挤同一秒）；原始时间在行内——可按原行时间戳对齐 | ⏳ 待定 |

## 一、运行形态（design §三）

| 项 | 值 | 证据 |
|:--|:--|:--|
| 协议端 | NapCat v4.18.34（Shell.Windows.OneKey） | 落点 `runtime/NapCat/NapCat.52230.Shell/` |
| 自带 QQ | NTQQ 9.9.33-52230 | 进程路径 = Shell 目录内 `QQ.exe` |
| 登录账号 | 2405997337（Shieraru） | `get_login_info` 实测 ✅ |
| 本机日常 QQ | 经典版 9.7.25（`C:\Program Files (x86)\Tencent\QQ\Bin`）——未被使用、未受影响 | 两套进程并存实测 ✅ |
| 启动脚本 | `runtime/NapCat/NapCat.52230.Shell/run-napcat.bat`（加 `-q <QQ号>` 快速登录） | 自写——官方 `launcher.bat` 从注册表取 QQ 路径，本机无该键 |

## 二、接口参数（design §四）

| 项 | 值 |
|:--|:--|
| OneBot HTTP | `http://127.0.0.1:3000` |
| 正向 WS | `ws://127.0.0.1:3001` |
| access_token | `napcatb2405997337` |
| 目标群 | 1097492606（SC2INV合作交流2群） |
| 配置文件 | `runtime/NapCat/NapCat.52230.Shell/config/onebot11_2405997337.json` |
| WebUI | `http://127.0.0.1:6099/webui`（token `b3b63ee02467`） |

## 三、收发实测（M1 判据）

| 面 | 调用 | 结果 |
|:--|:--|:--|
| 发送 | `send_group_msg`（群 1097492606） | `message_id` 272915131 / 1322335309 / 971658433 ✅ |
| 登录态 | `get_login_info` | `user_id 2405997337` ✅ |
| 群列表 | `get_group_list` | 12 群 ✅ |
| 接收 | WS 收集器 `QQBotB.Collector` | `runtime/events/events-20261009.jsonl`——lifecycle / heartbeat / 群消息 / notice 全类型落盘 ✅ |

## 四、落地踩坑

| # | 现象 | 处置 |
|:--:|:--|:--|
| 1 | GitHub release 下载极慢（直连 20KB/s、多数镜像不通） | 走本机 Clash 混合端口 7897 代理——3.4MB/s |
| 2 | 官方 `launcher.bat` 从注册表取 QQ 路径，本机该键不存在 | 自写 `run-napcat.bat` 直指目录内 QQ.exe |
| 3 | 改 `onebot11_*.json` 后服务不生效 | NapCat 不自动重载配置——需重启（杀进程树 + `run-napcat.bat -q <QQ号>`） |
| 4 | 自己发的消息不产生事件 | `reportSelfMessage: false`（默认）——外部消息才上报 |
| 5 | 收集器落盘含**全部群**的消息 | 未做群过滤——M2 接入时按需加 |

## 五、卫星程序（M1 新增资产）

| 文件 | 职责 |
|:--|:--|
| `src/QQBotB.Collector/Program.cs` | 入口 + 参数（wsUrl / token / outputDir） |
| `src/QQBotB.Collector/OneBotWsClient.cs` | WS 连接 / 接收 / 断线重连（3 秒） |
| `src/QQBotB.Collector/EventWriter.cs` | 按天分文件 JSONL 追加落盘 |

启动：`dotnet src/QQBotB.Collector/bin/Debug/net8.0/QQBotB.Collector.dll ws://127.0.0.1:3001 <token> runtime/events`

## 六、卫星程序候选（QQ Agent · 2026-10-09）

> 触发：把 `_unpack/` 的 QQ Agent（qq-agent v0.4.0，拆包自 `QQ-Agent V0.4 Preview Bugfix Setup.exe`）作为**独立窗口卫星**接入——它自带 Electron 窗口 + OneBot 接入 + 无状态会话编排，是 M2 卫星形态的现成候选。

| 项 | 值 | 证据 |
|:--|:--|:--|
| 应用落点 | `_unpack/QQ Agent.exe`（NSIS 解包产物；`resources/app/` 为未打包源码） | `_unpack/data/boot-diag.log`（2026-10-03 首跑） |
| 数据目录 | `_unpack/data/`——`config.json` / `sessions/` / `logs/` | 应用固定「exe 同级 `data/`」 |
| LLM 端点 | **newapi-bak**——`http://47.250.160.225:8443/v1` · 模型 `hy4-preview-f`（密钥按 apiConfigId 从 CH4 密钥面取，不落进本仓库） | `config.json` `api.*` |
| OneBot 端点 | **NapCat**——`ws://127.0.0.1:3001` / `http://127.0.0.1:3000` + token（复用 M1 落地协议端，不启自带 SnowLuma） | `config.json` `snowluma.*` |
| 前文 | rf 会话（`639270055721496090`）注入集全量——15 文件 / 59794 字符 → `persona.roleText`；`botName` = R喵 | `tools/apply-qqagent-config.mjs` |
| 配置脚本 | `tools/apply-qqagent-config.mjs`——读 CCBP 前文面 + 密钥面 → 机械合成 JSON（零转录、可重跑复现） | 一次执行产物 |
| 启动 | `启动QQAgent.vbs`（无窗口）或 `启动QQAgent.bat`——先落「启动会话」再拉起应用；**协议端由应用自启** | 实测：窗口 + 托盘 + 控制台 `127.0.0.1:3210` |
| 协议端宿主 | `runtime/napcat-host/`——shim（`index.mjs` + `node.exe` + `config/runtime.json`）挂到 `snowluma.dir`：应用按「SnowLuma 自动启动」**无窗口**拉起 NapCat（幂等：WebUI 6099 已开则只驻留） | `snowluma.autoLaunch=true` · 实测 3000/3001/6099 就绪 |
| 白名单 | **仅 1097492606**（Rushiera 2026-10-09 定）· 私聊空 · `allowAllWhenEmpty=false` | `config.json` `allow` |
| 响应档位 | **1 档「仅艾特」**（`store.contextTier=1` · `contextSliderPos=5`）——@ / 拍一拍触发，其余只存档不响应 | `config.json` `store` |
| 启动会话 | 启动器调 `tools/open-startup-session.mjs`——落一条 `chatKey=local:启动` 会话（systemPrompt = 当前前文），会话页首条即它 | 下次启动可见 |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 起进程：`Start-Process` 被引擎拦（`PS_START_FORBIDDEN`）；`cmd /c start` 实测**能拉起**（窗口 / 托盘 / 控制台 3210 均在）——语义仍属灰区，宿主侧「起外部程序」正式通道待补 | 半缺口 |
| 2 | `_unpack/` 在 `project.md` 里标注「可弃」——配置随之丢失；重装后跑三个脚本即复现 | 可复现 |
| 3 | 前文 ≈ 60KB（≈20k tokens）随每次会话发送——成本敏感时按需裁剪（如只留 SOUL/USER/核心纪律） | 待定 |
| 4 | 同卡并发 1——模型自测遇 429（与主干猫共卡）；应用自带重试，静默期再试即可 | 已知 |

**消费点验证（2026-10-09）：**

| 面 | 判据 | 结果 |
|:--|:--|:--|
| 配置加载 | 应用内核带 60KB 前文启动无报错 | ✅ `logs/qq-agent-2026-10-09.log` |
| OneBot 接入 | 日志 `[onebot] 连接成功`（NapCat 3001 + token） | ✅ |
| 白名单 / 档位 | `POST /api/config` 回传 `contextTier:1` + 群清单 | ✅ 运行中实例即时生效 |
| 模型端点 | 应用自测 `POST /api/test/api` | ⚠️ HTTP 429（同卡并发）——端点 / 密钥 / 模型名均通 |
| 启动会话 | `data/sessions/<id>.json`（`chatKey=local:启动`） | ✅ 落盘；重启后进会话列表 |

## 七、会话生命周期 + 记忆面（design-qqbotb-session.md · 2026-10-09）

> 触发：qq-agent 原为无状态编排（每次运行只带 80 条已读 + 前文）；Rushiera 2026-10-09 口述规格——对话全量注入 → 上下文超阈值自动收工（要点沉淀进记忆面）→ 归档旧会话 → 自动开新会话，全程 qqbot 自持。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-session.mjs`——幂等补丁（28 补丁点 · 锚点唯一校验 · 换行风格自适应）；重装后重跑即复现 | 二次运行：applied 0 / skipped 28 ✅ |
| 会话状态 | 新增 `src/session-state.js`——`data/session-state.json`（每 chat：startedAt / lastPromptTokens / rollovers） | 自测：轮转后 `rollovers=1` · 基线清零 ✅ |
| 会话窗口 | `store.messagesSince` + `prompt.buildPastState(sinceTs)`——已读 = 会话起点之后的**全部**消息 | 自测：120 条全量进 `userPrompt`（老 80 条窗口会截掉 MSG-001）✅ |
| 收工轮 | `orchestrator` wake 判据（上轮 promptTokens + 本批字符/1.5 > 阈值）→ 特殊运行：发送类工具**移出工具集** | 自测：`triggerSummary=收工轮（上下文轮转）` · `sent=0` ✅ |
| 轮转归档 | `store.archiveAndClear` → `data/messages/archive/<chat>_<ts>.json`（未读保留） + `resetSession` | 自测：归档 122 条 · 当前存档清零 · 下一条起新会话 ✅ |
| 记忆注入 | `data/memory/<chat>/_session.json`（收工要点）→ `prompt.js`【记忆】段首块，群友印象其后 | 自测：下轮提示词含「本轮聊了测试话题」✅ |
| 429 长轮询 | 限流不判失败：恢复触发批 → 60s 起指数退避、**180s 封顶 · 不设次数上限** → 轮询续跑 | 自测：mock 429 下 `status=noreply` · 未读已恢复 · 重排在手；退避 60/120/180s 封顶 ✅ |
| 配置 | `session: { enabled: true, maxContextTokens: 300000 }`——窗口变化只改这一处 | `src/config.js` DEFAULT_CONFIG |

**自测：** `node tools/verify-qqagent-session.mjs`——独立 data 副本（`runtime/.session-selftest`）+ 本地 mock 端点（可切 429），**20 项全过**（判据 1/2/3/4/5）。

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 源码在应用启动时加载——**重启一次**才生效（本实例运行中，未重启、未杀进程） | 待重启 |
| 2 | `store.historyCount` 保持 80 未动——全量走会话窗口；`session.enabled=false` 一键回退旧行为 | 按规格 |
| 3 | 收工轮要点取自助手正文（会话级摘要）；群友长期印象仍走 `memory_append` | 按规格 |
| 4 | 真实链路验收（群内对话跑到 300k 阈值触发收工）需长会话积累，尚未发生 | 待实测 |
| 5 | `_session.json` 与群友印象同址——memory.js 成员扫描会读到它但视为"无印象成员"跳过（不污染提示词） | 已知 |

## 八、群内自主参与（design-qqbotb-engage.md · 2026-10-09）

> 触发：Rushiera 2026-10-09 口述规格——取消本地触发门（不要"命中才进 LLM"的形式），每条群消息都进 LLM、由模型自决接不接话；允许空调用（跑完不发言）；聚批让思考期间的消息并进下一次；发言配额 120s / 5 条；话题词由收工轮自产（方案 1：只作提示词参考，不做触发门）。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-engage.mjs`——幂等补丁（21 补丁点 · 锚点唯一校验 · 换行自适应 · 已手改处用 appliedIf 兼容） | 二次运行：applied 0 / skipped 21 ✅ |
| 新增模块 | `src/topic-words.js`——话题词解析 / 存储 / 渲染（`data/memory/<chat>/_topics.json`） | 自测 6 项 ✅ |
| 触发策略 | `store.contextTier=4`——`resolveContextTier` 恒 `shouldRespond=true`（reason「全部响应」） | 自测：4 档全响应 / 1 档仍拦（可回退）✅ |
| 聚批窗口 | `wakeDelayMs` 2000 → 4000（固定窗口，不重置；思考期间的消息由 drain 并入下一轮） | config.json L117 ✅ |
| 发言配额 | `sender.js #checkRate` 内前置配额闸门（滑动 120s / 每群 5 条）——文字 / 图片 / 媒体 / 表情 / 拍一拍逐条计入；超限抛错回给模型；记账在抛错之后 | 自测：5 条放行 / 第 6 条拒 / 被拒的没发出 / 关配额即回退 ✅ |
| 配额余量注入 | `orchestrator` 组装用户消息时追加末尾段（动态段放末尾——不打断【记忆】/【已读信息】的缓存前缀） | 补丁落盘 ✅ |
| 话题词产出 | 收工轮指令追加第 5 条「话题词：词1、词2、…」→ `#completeRollover` 解析落盘 | 补丁落盘 ✅ |
| 话题词注入 | `prompt.js`【记忆】段第二块（会话要点之后、群友印象之前） | 补丁落盘 ✅ |
| 配置脚本 | `tools/apply-qqagent-engage.mjs`——只动 `store` / `wakeDelayMs` / `engage` 三处，不动白名单 | 一次执行产物 ✅ |
| 发言热度 | 新增 `src/chatter.js`——话密群友（10 分钟条数）+ 人机对刷（尾部交替轮数）；渲染【发言热度】段注入用户消息末尾；**只给参考不做判定** | 自测 7 项 ✅ |
| 卡死看门狗 | `orchestrator` 新增巡检（`stall` 段）——运行中会话 150s 无活动 → abort 在途请求 + 恢复未读 + 3s 重排；`api.timeoutMs` 180s → 90s | 补丁落盘 ✅ |
| 自测 | `node tools/verify-qqagent-engage.mjs`——独立 data 副本（`runtime/.engage-selftest`） | ALL PASS 25/25 ✅ |

**重启与生效（2026-10-10 00:10 / 00:19 / 00:42）：** 每次「停应用 → 写配置 → 启动」。末次启动（00:42:01）后日志：控制台 3210 ✅ · OneBot 连接成功 ✅ · 模型 hy4-preview-f ✅ · 工具集 28 件 ✅ · 配置未被回退（`contextTier=4` / `wakeDelayMs=4000` / `maxPerWindow=5` / `api.timeoutMs=90000` / `stall.timeoutMs=150000`）✅

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收——00:11–00:18 群内实测：每批恰好 5 条后沉默（4 档触发 + 配额拒发均生效） | ✅ 部分兑现（软闸效果待观察） |
| 2 | `session-state.json` 惰性创建——首次运行后才落盘 | 按设计 |
| 3 | 前文 ≈60KB/次 是 4 档下的主要固定成本——先跑一天按体感决定是否裁剪 | 观测中 |
| 4 | `chatActive` / `proactive` 保持关闭（4 档下活跃期无意义；冷场开话题待词表积累后另议） | 按规格 |

## 九、系统提示段关闭（2026-10-10）

> 触发：Rushiera 2026-10-10 口述规格——每轮运行重发的系统提示（4360 字符 · 行为准则段）去掉，运行提示词只留用户消息（角色设定 + 存档消息 + 记忆 / 热度 / 配额等动态段）。全文逐段核对：与 `buildSystemPrompt()` 默认分支产物一字不差。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-nosys.mjs`——幂等补丁（2 补丁点 · 锚点唯一命中校验） | 首跑 applied 2 ✅ |
| 系统提示开关 | `src/prompt.js` `buildSystemPrompt` 顶部——`persona.systemPromptEnabled=false` 时整段返回空（读全局配置，不受分会话人设合并影响） | `node --check` 通过 ✅ |
| 空 system 不发送 | `src/orchestrator.js` messages 组装——系统提示为空时不 push system 消息（空 content 的 system 会被端点拒） | `node --check` 通过 ✅ |
| 配置 | `_unpack/data/config.json` `persona.systemPromptEnabled: false` | 落盘实况 ✅ |
| 生效 | 停应用（`Stop-Process`）→ `启动QQAgent.vbs` 拉起 | 01:14:49 控制台 3210 · OneBot 连接成功 · 模型 hy4-preview-f · 工具集 28 ✅ |
| 消费点验证 | `GET http://127.0.0.1:3210/api/prompt-preview` → `systemPrompt` 空、工具清单 28 件 | ✅ 实锤 |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 安全规则 / 工具协议 / 反 AI 味 / 分条发送等准则随系统提示一并消失——模型不再被约束「文本不发 QQ、必须调 send_message」 | 按规格（后果已知） |
| 2 | 用户消息【角色设定】段仍为 `roleText`（rf 注入集 · CCBP 前文 ≈60KB）——本轮未动 | 待定 |
| 3 | 回退路径：`config.json` 里 `persona.systemPromptEnabled` 改回 `true`（或删该字段）→ 重启 | 一行可回退 |

## 十、bot 指定限频（design-qqbotb-engage.md §七 · 2026-10-10）

> 触发：Rushiera 2026-10-10 口述规格——「在软件里的记忆里面加一个 bot 指定，可以让我在软件内开关，一旦打开，对该群友的回复将强制限制为 240 秒只会回 1 条（不影响送 llm 思考，只是要求如果发现回的是目标群友就强制不发送消息）」。用途：抑制群内两个机器人互相刷屏。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-botguard.mjs`——幂等补丁（19 补丁点 · 锚点唯一校验 · 换行自适应 · 无标记点用 appliedIf 兼容） | 首跑 applied 19 ✅ · 复跑 applied 0 / skipped 19 ✅ |
| 配置 | `src/config.js` `engage.botGuard = { enabled, windowMs: 240000, maxPerWindow: 1, members: [] }` | `_unpack/data/config.json` 落盘实况 ✅ |
| 闸门 | `src/sender.js` `#checkRate(chatKey, atUserId)` 最前置调用 `#checkBotGuard`——命中且额度已满抛错（错误回给模型） | 自测 3/4/6 项 ✅ |
| 判定「回的是谁」 | 显式点名（`atUserId` / 拍一拍目标）优先；否则取本轮运行目标（触发批最后一条的发送者） | 自测 2/4/6 项 ✅ |
| 本轮运行目标 | `src/orchestrator.js` 每轮运行前 `setRunBotTarget` / 收尾 `clearRunBotTarget`（`finally`） | 补丁落盘 + 自测标记检查 ✅ |
| 记账 | 发送**成功之后**记一次（`#markSent` → `#markBotReply`）——失败不占额度；一轮运行只记一次 | 自测 8 项 ✅ |
| 记忆页开关 | `ui/app/05-memory-settings.js`——群友印象卡 + 群成员表两处「🤖 bot」按钮；写 `POST /api/config { engage: { botGuard: { members } } }` | HTTP 取回前端文件含 `mem-bot-toggle` / `toggleBotMember` ✅ |
| 自测 | `node tools/verify-qqagent-botguard.mjs`——独立 data 副本（`runtime/.botguard-selftest`） | ALL PASS 17/17 ✅ |
| 生效 | 停应用（`Stop-Process`）→ `apply-qqagent-engage.mjs` 补 botGuard 默认值 → `启动QQAgent.vbs` | 01:42:11 控制台 3210 · OneBot 连接成功 · 模型 hy4-preview-f · 工具集 28 ✅ |
| 消费点验证 | `GET http://127.0.0.1:3210/api/config` 含 `engage.botGuard`；`GET /app/05-memory-settings.js` 含 `mem-bot-toggle` | ✅ 实锤 |
| 记忆页开关实写 | 运行期由记忆页点选 → `POST /api/config` → `_unpack/data/config.json` `engage.botGuard.members` 落盘（重启后 `GET /api/config` 回传同值） | ✅ 实锤（2026-10-10 01:46 实例） |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 名单是全局 QQ 清单（`botGuard.members`），不是按群——同一个机器人在别的群一并受限 | 按设计 |
| 2 | 「本轮运行目标」取触发批**最后一条**的发送者——批内混有真人时不算「回机器人」（不误伤对真人的回复） | 按设计 |
| 3 | 额度记账在发送成功之后；一轮里第一笔放行即占额度，同轮后续发送不再判定（算同一次回复） | 按设计 |
| 4 | 补丁脚本 `String.replace` 已改函数式替换（`() => r`）——字符串式替换会把替换文本里的 `$$` 吃成 `$`（本次在记忆页插入处踩到并当场修回；旧补丁脚本同款写法未动） | 已修 |
| 5 | 真实链路验收（群里另一个机器人触发 → 第一次回复发出、240 秒内第二次被拒）需实际对话发生 | 待实测 |
| 6 | 改动前快照（`runtime/.botguard-backup/`）收工已清——改动经自测 17/17 + 消费点实锤 + 两次重启验证；回退路径 = `botGuard.enabled=false` 一行 | 已清 |

## 十一、记忆分类（design-qqbotb-memory.md · 2026-10-10）

> 触发：Rushiera 2026-10-10 口述规格——「记忆只按人整理也确实不太妥，起码你还得知道大家都在聊什么」；依 `group:1097492606` 全量存档（归档 230 + 当前 69）归纳出两轴三分。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-memory.mjs`——幂等补丁（23 补丁点 · 锚点唯一校验 · 换行自适应 · 函数式替换） | 复跑：applied 0 / skipped 23 ✅ |
| 新增模块 | `src/group-memory.js`——群记读写层（`data/memory/<chat>/_group.json`，条目 `{id,kind,content,createdAt,updatedAt}`） | `node --check` 通过 · 自测 1a–1h ✅ |
| kind 枚举 | `lore` 梗/黑话 · `rule` 群规/约定 · `relation` 关系/角色 · `project` 长期项目 · `topic` 在聊什么 | 渲染分两段：【本群】/【本群在聊】 |
| 工具面 | `memory_append` / `memory_query` / `memory_remove` 增 `category=group`（带 `kind`）；`category=member` 保持原语义 | 自测 3a–3e ✅（非法 kind 报错不静默） |
| 提示词 | 【记忆】段顺序：会话要点 → 群记（本群 / 本群在聊）→ 群友印象；`_topics.json` 话题词块退役 | 自测 1i/1j/2a ✅（实跑 userPrompt 60KB 含【本群】） |
| 收工轮 | 收工轮自产话题词 → `setGroupTopics` 落为 topic 条目（覆盖上一版，不动 lore/rule） | 自测 2c–2f ✅ |
| 整理轮 | `#consolidateGroupMemory`——零条目时建档、超 `maxGroupEntries`（默认 12）时重整；结果无法解析保留原条目 | 自测 1k–1m/3g ✅（5 条 → 3 条） |
| API | `GET /api/memory-files`（列表带 `groupCount`）· `GET /api/memory-files/<chat>`（带 `group`）· `POST/PUT/DELETE .../group[/<id>]` | 实机 `GET /api/memory-files/group_1097492606` 返回 `group` 3 条 ✅ |
| 记忆页 | 每群卡片顶部「群记」区（按 kind 分组展示 + 添加 / 删除） | 源码含 `mem-add-group-btn` / `mem-del-group` |
| 自测 | `node tools/verify-qqagent-memory.mjs`——独立 data 副本（`runtime/.memory-selftest`）+ 本地 mock 端点 | **ALL PASS 32/32** ✅ |

**存量迁移（一次性 · `tools/migrate-qqagent-group-memory.mjs`）：**

| 项 | 结果 |
|:--|:--|
| 群级条目出人档 | `569145850.json` 里 3 条（协作约定 / 前文已撤 / bot指定上线）→ `_group.json` 的 `kind=rule`；人档只剩 1 条真实人物印象 |
| 名字回填 | `569145850.json` 的 `name`：`R喵-壳行为约束` → `Rushiera`（此前把话题当人名写进了 name 字段） |
| 话题词 | 本群无 `_topics.json`（收工轮未产过词表）——无迁移；脚本保留该路径（`.migrated` 留痕） |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收（群里聊到超阈值 → 收工轮 → 群记 topic 落盘）需长会话积累 | 待实测 |
| 2 | `_topics.json` 退役后 `src/topic-words.js` 仅剩解析器（`extractTopicWords`）在用——写面已移入群记 | 按设计 |
| 3 | 群记整理走聊天模型（`#memoryChat`），`memory.maxGroupEntries` 未写进默认配置（取代码兜底 12） | 按设计 |

## 十二、会话按群折叠（design-qqbotb-session.md §八 · 2026-10-10）

> 触发：Rushiera 2026-10-10 口述规格——准备扩群，会话按群折叠、不同群视为不同会话、记忆按群收。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-sessions-fold.mjs`——幂等补丁（7 补丁点） | 复跑：applied 0 / skipped 7 ✅ |
| API | `/api/sessions` 增 `chats`（每 chatKey：`startedAt` / `rollovers` / `lastPromptTokens` / `unread` / `total` / `lastTs`）；键集合 = 存档 ∪ 运行记录 ∪ **白名单** | 实机返回含 `group:689942975`（新开群立刻建行）✅ |
| 会话页 | 两级结构：一级「群会话」每 chatKey 一行（群名 / 会话起点 / 前文规模 / 轮转次数 / 记录数 / 未读）；点开是该群运行记录 | 自测 1a/1b/3e/3f ✅ |
| 折叠态 | 默认收起；有运行中/等待中、当前选中、或只有一个群时自动展开；手动点击后记住（`state.groupFold`） | 自测 2a–2e ✅ |
| 排序 | 有运行中 > 有未读 > 最近活跃 | 渲染逻辑落盘 |
| 自测 | `node tools/verify-qqagent-fold.mjs`——源码标记 + 语法检查 + 补丁幂等 + 折叠逻辑沙箱 | **ALL PASS 14/14** ✅ |
| 第二群开通 | `allow.groups` = `1097492606` + `689942975`（工仔养生水疗中心 · 31 人 · `get_group_list` 实测） | `GET /api/config` 落盘实况 ✅ |
| 生效 | 停应用 → 启动（`启动QQAgent.vbs`）——两次重启（记忆面 / 折叠面各一次） | 日志：OneBot 连接成功 ✅ · 工具集 28 件 ✅ · 无 ERROR ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 新群首跑验收（`689942975` 第一条消息 → 三处落档 + 会话页出现该群记录） | ✅ 已验收（2026-10-10：`messages/group_689942975.json` + `memory/group_689942975/` + `session-state.json` 含 `group:689942975`） |
| 2 | **踩坑：补丁点的幂等标记必须落在替换文本里**——`ui-close` 的锚点（`}).join('');` + 底部提示注释）在替换后仍存在，首跑被应用两次（生成重复的 `box.innerHTML` 赋值）。当场修回 + 补标记；判据：**替换文本里必须能搜到 `[qqagent-fold-patch:<id>]`**（或用 `appliedIf` 指定只存在于替换后的特征串） | 已修 |
| 3 | 会话页记录分页仍按扁平列表切（`SESSION_PAGE`），跨群时某群可能只显示部分记录 | 已知（可接受） |
| 4 | **补丁链全链复核**（六个脚本逐个 `--dry`）：`-engage.mjs` 复跑报错 / 部分点会重复应用——根因是后落的 `-nosys.mjs` / `-memory.mjs` 改写了上游标记所在文本。已给 engage 的 4 处补 `appliedIf`（收窄到跨改写仍存活的特征串 / 改指下游标记）；现六个脚本全部 `applied 0` | 已修（判例：`L2/Worker/Majordomo/history/补丁脚本幂等标记须落在替换文本里.md`） |

## 十三、第三群开通（2026-10-10）

> 触发：Rushiera 2026-10-10 指令——新增群指定 `940257985`。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 群身份 | `940257985` = KKCardMod开发测试群（38 人） | NapCat `get_group_list` 实测 ✅ |
| 白名单 | `allow.groups` = `1097492606` + `689942975` + `940257985` | `_unpack/data/config.json` 落盘实况 ✅ |
| 写入通道 | `POST http://127.0.0.1:3210/api/config`（patch `{allow:{groups:[...]}}`——`updateConfig` deepMerge · 数组整体替换） | 响应 `ok:true` + 活配置回传含三群 ✅ |
| 生效 | 运行中实例即时生效（无需重启——`updateConfig` 同写内存与落盘） | `/api/sessions` 的 `chats` 键含 `group:940257985` ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 新群首跑验收（`940257985` 第一条消息 → 三处落档 + 会话页出现该群记录） | ✅ 已验收（2026-10-10 09:53 群内实发：`messages/group_940257985.json` + `memory/group_940257985/`（3 人档 + `_group.json` + `_session.json`）+ `session-state.json` 含 `group:940257985`） |
| 2 | 白名单收窄无脚本落点——`_unpack` 重装后按 `apply-qqagent-policy.mjs` 复现会写回**全部群**（语义是"全开"），收窄的三群需手工重设 | 已知（白名单属数据配置，非代码） |

## 十四、发言硬限制（design-qqbotb-engage.md §八 · 2026-10-10）

> 触发：Rushiera 2026-10-10 指令——「调一下发言频率，增加一个每 60 秒最多 1 次发言的硬限制」。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-hardlimit.mjs`——幂等补丁（4 补丁点：config 默认段 / ctor 时间戳表 / `#checkRate` 闸门 / `quotaState` 取严） | 首跑 applied 4 ✅ · 复跑 applied 0 / skipped 4 ✅ |
| 自测 | `node tools/verify-qqagent-hardlimit.mjs`——独立 data 副本（`runtime/.hardlimit-selftest`）+ 真实源码模块 | **ALL PASS 11/11** ✅ |
| 闸门顺序 | botGuard → **hardLimit** → quota → 分钟 / 小时；被拒的发送不进入后续记账 | 自测：被拒后 quota 记账仍为 1 条 ✅ |
| 提示词一致 | `quotaState` 取两道闸更严者——硬限 60s/1 压过配额 120s/5 | 自测：返回 `{windowMs:60000, max:1}` ✅ |
| 配置 | `engage.hardLimit = { enabled: true, windowMs: 60000, maxPerWindow: 1 }` → **当日撤销为 `enabled: false`**（Rushiera 2026-10-10 决定：硬闸只把"撞墙"提前，不解决"每句都回"；代码与自测保留，可再开） | `_unpack/data/config.json` 落盘实况 ✅ · `GET /api/config` 回传含该段 ✅ |
| 补丁链复核 | 七个脚本逐个 `--dry`：全部 `applied 0`（本补丁未破坏上游幂等） | session 31 · engage 21 · nosys 2 · memory 23 · sessions-fold 7 · botguard 19 · hardlimit 4——全 skipped ✅ |
| 生效 | 停应用（`Stop-Process`）→ `启动QQAgent.vbs` → 09:59:08 控制台就绪 | 日志：OneBot 连接成功 · 工具集 28 件 · **无 ERROR** ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收（群里连发两条 → 第二条被拒 + 提示词余量显示 60 秒 / 1 条）需真实群消息 | 待实测 |
| 2 | 记账粒度是**按条**不是按轮：一轮内模型分两条发，第二条会被拒（与配额同粒度） | 按设计——提示词余量已告知，模型可自行一次说清 |

## 十五、发言纪律（design-qqbotb-engage.md §九 · 2026-10-10）

> 触发：Rushiera 2026-10-10 指令——「撤销 1 分钟硬限制，侦查怎么优化发言频率」（拍板方案 C = 精简系统提示 + 动态段强化）。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 侦查基线 | `tools/analyze-qqagent-chatter.mjs`（只读体检——被接话率 / bot 占比 / 间隔分位） | 三群被接话率 **97% / 100% / 97%**；两群 bot 发言量 ≥ 群友 ✅ |
| 根因定位 | v0.10 关闭系统提示段（省 4360 字符/轮）连带关掉「该说/不该说」「群聊不是客服队列」「像真人一样」「保持主体性」四段纪律 | 源码实况：`buildSystemPrompt` 直接 `return ''` ✅ |
| 补丁脚本 | `tools/patch-qqagent-talkstyle.mjs`——幂等补丁（8 补丁点：模式开关 / 解析函数 / 分支 / 阈值 / 表 / 记账 / 状态 / 节奏句） | 首跑 applied 8 ✅ · 复跑 applied 0 / skipped 8 ✅ |
| 自测 | `node tools/verify-qqagent-talkstyle.mjs` | **ALL PASS 22/22** ✅ |
| lean 体积 | **1069 字符** vs full 4360 字符（省 75%）；含纪律四段、不含安全 / 工具 / 表情段 | 自测实测 ✅ |
| 节奏感知 | `quotaState.sinceLastMs`（未发言 = null / 刚发 ≈0 / 90 秒前 ≈90000） | 自测 3 项 ✅ |
| 热度阈值 | SOFT_COUNT 8→5 · SOFT_ROUNDS 3→2（5 条即进热度列表 · 2 轮即进对刷列表） | 自测 4 项 ✅ |
| 配置 | `persona.systemPromptMode = 'lean'` · `engage.hardLimit.enabled = false`（撤销） | `_unpack/data/config.json` 落盘实况 ✅ |
| 补丁链复核 | 八个脚本逐个 `--dry`：全部 `applied 0` | session 31 · engage 21 · nosys 2 · memory 23 · sessions-fold 7 · botguard 19 · hardlimit 4 · talkstyle 8 ✅ |
| 生效 | 停应用（`Stop-Process`）→ `启动QQAgent.vbs` → 12:20:23 控制台就绪 | 日志：OneBot 连接成功 · 工具集 28 件 · **无 ERROR** ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 效果复测（被接话率目标 40~60%）——需真实群消息积累后跑 `node tools/analyze-qqagent-chatter.mjs` 对照 | 待实测 |
| 2 | lean 模式不注入安全规则段（「无本地工具 / 群友无管理权限 / 不透露路径」）——安全边界改由工具面与本地拦截承担，提示词层不再复述 | 按取舍（Rushiera 拍板方案 C 时知悉） |
| 3 | 旧字段 `persona.systemPromptEnabled=false` 保留（兼容层：无 `systemPromptMode` 时按 lean 处理）；新配置以 `systemPromptMode` 为准 | 按设计 |

## 十六、猫工具链移植（2026-10-10）

> 触发：Rushiera 2026-10-10 指令——「开工 qqbot，把我们猫里面的工具链里的 timeback，image-inject，web-search，还有整个 browsercat 里的所有工具链都配进去」。落点 = 卫星程序 QQ Agent（`_unpack/resources/app`），不动 CH4 猫窝。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 补丁脚本 | `tools/patch-qqagent-cattools.mjs`——幂等补丁（10 补丁点：2 新模块复制 + tools.js import/注册 + orchestrator 四处 + config 两处） | 首跑 **applied 10** ✅ · 复跑 applied 1（模块内容更新）/ skipped 9 ✅ |
| 新模块 | `src/cdp-browser.js`（CDP 浏览器服务：内核探测 / 懒启动 / 每会话实例 / 空闲回收 / 网络面熔断）· `src/cat-tools.js`（7 件工具注册 + timeback 回卷纯函数）——**源码以 `tools/cattools/` 为准**，重装重跑补丁即复现 | 两模块落位 + 标记齐全（8/8）✅ |
| 工具面 | `timeback`（上下文作用域 start/back）· `image-inject`（本地路径 / http 图片 → 图片部件）· `browser-open` / `browser-read` / `browser-eval` / `browser-shot` / `browser-tabs`（BrowserCat 全组 5 件） | 自测：工具注册 7/7 ✅ · 名字符 OpenAI 函数名规范 ✅ |
| web-search | 不重复实现——qq-agent 原生已有 `web_search` / `web_fetch`（同语义） | 源码实况 ✅ |
| 域门禁 | image-inject 与 browser-* **仅 timeback 作用域内可用**（域外调用被拒，错误里给出开锚路径）——与 CH4 同口径 | 自测：域外三连拒 + back 之后再拒 ✅ |
| 回卷 | back 时把「锚点之后、本条 assistant 之前」的 messages 从上下文删除（findings 随 back 的 tool 结果回主干）；只删 LLM 上下文，会话页保留过程记录 | 自测：7 条 → 3 条 · 本条落锚点位 · rolledBack=4 · 无锚点 = 空操作 · 越界 = 空操作 ✅ |
| 图片面 | 本地图限数据目录 / 临时目录（`tools.imageInject.roots` 可扩展）+ 24MB 上限 + 有 ffmpeg 时压缩；http 图走 safe-fetch 的 SSRF 防护 | 自测：本地注入（图片部件到位）· 越界路径被拒 · 参数缺失被拒 ✅ |
| 内核探测 | Chromium 系（Edge / Chrome / Brave）headless + 裸 CDP（ws，零第三方 CDP 库）；`browser.kernelPath` 可换 | 自测：探测到 `msedge.exe` ✅ |
| 🔴 环境阻断 | **本机 Chromium 网络栈被拦截**：headless 内核（Edge 140 / Chrome 140 均实测）启动后打印 `Network service crashed, restarting service.`，此后一切 http 导航挂死（**本地回环页同样挂死**）；与 qq-agent 源码注释记载的「本机安全软件按进程压制 Chromium 网络栈」一致 | 内核 stderr 日志实测（`--enable-logging=stderr`）· 自测探针：导航超时 20s ✅ |
| 兜底 | 网络面熔断：捕获到内核崩溃或导航超时 → 10 分钟内 browser-* **直接快速失败**并提示改用 `web_fetch` / `web_search`（不挂死、不白等一轮） | 自测：探针触发熔断消息 ✅ |
| 自测 | `node tools/verify-qqagent-cattools.mjs`——独立 data 副本（`runtime/.cattools-selftest`）+ 真实源码模块 + 本地回环页 | **ALL PASS 27/27**（13 项因环境阻断跳过）✅ |
| 生效 | 停应用（`Stop-Process -Name "QQ Agent"`）→ `启动QQAgent.vbs` → 14:02:33 控制台就绪 · 14:02:35 OneBot 连接成功 | 日志：**工具集 35 件**（28 + 7）· 无 ERROR ✅ · `GET /api/tools/availability` 七件 `enabled:true` ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | browser-* 端到端链路（打开 / 读正文 / 读链接 / 取值 / 截图 / 页签 / 截图交 image-inject）在本机被环境阻断，未取得真实链路证据 | **已闭合 → §十七**（自测 13 项转实测 + 生产路径 5/5） |
| 2 | 候选修复路径（未决）：a) 排查本机安全软件对 Chromium 网络服务进程的拦截；b) 改用 Electron 自身 Chromium（`webContents.debugger`，进程内，避开外部内核）；c) 换内核（Brave 等，未验证） | **已闭合 → §十七**（三选项均未采用；正解 = 数据目录落 NTFS） |
| 3 | 域门禁语义与 CH4 一致（域外被拒）——模型须先 `timeback(action="start")` 才能用 image-inject / browser-*；若实测摩擦大，可评估「browser-* 免开锚」变体 | 待实测 |
| 4 | 重启已执行（2026-10-10 14:02）——旧进程 `Stop-Process` 停、`启动QQAgent.vbs` 起；NapCat 协议端未随停（应用启动时探到 3000/3001 已开，直接连上，未重复拉起） | 已生效 ✅ |

## 十七、浏览器链路修复——exFAT 根因（2026-10-10）

> 触发：Rushiera 2026-10-10 指令——「按推荐来走吧 完事后你直接重启」；前因 = §十六 遗留 1/2（browser-* 五件在本机用不了）。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 🔴 **根因纠正** | **不是**「本机拦截 Chromium 网络栈」——是 **D 盘为 exFAT**：Chromium 的 `--user-data-dir` 落在 exFAT 卷上时，内核 CDP 连接耗时 20s+、一切导航挂死 | 对照实测（同内核 / 同参数 / 同本地回环页，只换 profile 位置）：`%TEMP%`(C·NTFS) **697ms 通过** · `QQBotB/runtime`(D·exFAT) 超时 36s · `QQBotB/_unpack/data`(D·exFAT) 超时 33s；`Get-Volume`：D = exFAT · Warning · Full Repair Needed ／ C = NTFS · Healthy |
| 修复 · 数据目录 | `cdp-browser.js` 新增 `resolveBrowserDataDir()`——默认 `%LOCALAPPDATA%/QQAgent/browser`（NTFS），配置 `browser.dataDir` 可改；**不跟应用数据目录走** | 补丁 11（`config-browser-datadir`）落盘 ✅ |
| 修复 · 看图放行 | `cat-tools.js` 的 image-inject roots 加浏览器数据目录（截图 / 落盘正文要能被看图工具读到） | 自测「截图交给 image-inject 可看」实测通过 ✅ |
| 修复 · 错误归因 | 熔断文案去掉「本机拦截」这一错结论（改中性：内核网络服务无响应）——模型读到的错误信息不能带错归因 | 三处文案（navigate 超时 / breakerError / markNetworkDead）✅ |
| 自测数据目录 | `verify-qqagent-cattools.mjs` 的 DATA 从项目盘（D·exFAT）挪到 `%TEMP%`——否则浏览器用例永远走「环境阻断」分支 | 落盘实况 ✅ |
| 补丁链 | `patch-qqagent-cattools.mjs` 新增补丁 11 + 两模块内容更新 | 首跑 applied 3 / skipped 8 ✅ · 复跑 applied 1 / skipped 10 ✅ |
| 自测 | `node tools/verify-qqagent-cattools.mjs` | **ALL PASS 40/40**（原 27/27 + 13 项环境阻断跳过 → 13 项**全部转实测**）✅ |
| 生产路径实锤 | 用生产数据目录（`_unpack/data`）的配置跑链路（只读配置） | browser-open / read text / shot / profile 落点核对 / closeChat **5/5** ✅ · profile 实落 `C:\Users\e-hen\AppData\Local\QQAgent\browser\...` |
| 生效 | 停应用（`Stop-Process -Name "QQ Agent"`）→ `启动QQAgent.vbs` → 20:04:51 控制台就绪 | 日志：**工具集 35 件** · OneBot 连接成功 · 无 ERROR ✅ · `GET /api/tools/availability` 七件 `enabled:true` ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | §十六 遗留 1（browser-* 端到端链路无真实证据） | **已闭合**——自测 13 项转实测 + 生产路径 5/5 ✅ |
| 2 | §十六 遗留 2（候选修复路径三选一） | **已闭合**——三选项（查杀软 / Electron 内建 / 换内核）均未采用；正解是第四条：**数据目录落 NTFS** |
| 3 | 群内真实触发（模型自己调 browser-open） | 待真实群消息——工具面与链路均已就位，无额外动作 |
| 4 | 旧 profile 残留 `_unpack/data/browser/`（D·exFAT） | 已清（孤儿目录——新路径在 C 盘；判例数据已入档） |

## 十七、自研单体 P1（链接层 · 2026-10-10）

> 定位：`app/` 自研单体——协议端生命周期 / OneBot 连接 / 界面。业务面仍在 QQ Agent（并行共存，不淘汰）。

| 面 | 实现 | 实测证据 |
|:--|:--|:--|
| 协议端宿主 | `app/src/napcat/host.js`——启停 / 状态 / 端口探测 / 守护 | `POST /api/napcat/stop` 一次清 5 进程（含子进程）；`start` 90 秒内就绪 ✅ |
| 控制台窗口 | `consoleLog=false`（账号级配置）+ `tools/hide-console`（C#：AttachConsole + ShowWindow(SW_HIDE)） | QQ.exe 窗口标题由 exe 路径 → `N/A` ✅ |
| 日志采集 | `fileLog=true` → `logs/<时间戳>.log` → `app/src/napcat/logtail.js` 跟随转发 | 界面日志页可见协议端行（适配器初始化 / 群消息接收） ✅ |
| OneBot 连接 | `app/src/onebot/client.js`——WS + 断线自愈 | 登录 `Shieraru(2405997337)`；断开后 3 秒重连 ✅ |
| WebUI 免登录 | `sha256(token + ".napcat")` → `/api/auth/login` → 凭据注入 iframe 的 localStorage（键 `token`） | 子页直进管理界面（基础信息 / 网络配置 / 猫猫日志 / 接口调试…） ✅ |
| 界面 | `app/ui/`——概览 / 协议端控制台 / 日志 / 设置（端口 3280） | 截图核验三页签内容 ✅ |
| 开发期工具 | `POST /api/debug/screenshot?tab=<页签>`——截当前界面落 `app/data/screenshot.png` | 本轮三页签核验即用它 ✅ |

**踩坑（三条）**：

1. **运行配置分两层**——账号级 `config/napcat_<uin>.json` 覆盖全局 `config/napcat.json`；改错层等于没改（首轮改全局 `consoleLog` 无效，账号级仍是 true）。
2. **`consoleLog=false` 不消除控制台窗口**——窗口由协议端自建（conout 管道机制），宿主侧 `windowsHide` 挡不住，须 `hide-console` 兜底隐藏。
3. **`stop` 只杀监听端口的子进程不够**——QQ 主进程会重启被杀的 NodeService 子进程；须按命令行归属杀全组（`tools/list-napcat.ps1` 按 ShellDir 过滤，不碰本机日常 QQ）。

**边界（Rushiera 2026-10-10 定）**：QQ Agent 功能面尚多未探索，**现阶段不淘汰**——自研单体只接管链接层；编排 / 记忆 / 工具链等业务面仍归 QQ Agent，两者并行。

**架构三段式（本次）**：

- **保留**：NapCat 协议端本体（二进制不动）· QQ Agent 业务面（编排 / 记忆 / 工具链）· OneBot 11 协议契约 · 账号槽位与多群配置
- **扬弃**：应用内 SnowLuma 通道（`<dir>/node.exe + index.mjs` 的 shim 硬套）· 外部 `runtime/napcat-host/index.mjs` 桥接层 · 靠系统浏览器打开 WebUI
- **新增**：自研链接层（协议端宿主 + OneBot 客户端 + 界面）· 控制台窗口隐藏工具（`tools/hide-console`）· WebUI 凭据自动注入（免人工输入密钥）

## 十八、工作目录钉死（2026-10-10）

> 触发：Rushiera 2026-10-10 判例——QQ Agent 启动时 cwd 继承自启动者。它以宿主运行区 `D:\Mau\MauOut` 为 cwd 被拉起后常驻，主进程与 gpu / network / renderer 四进程各持该目录句柄（handle64 实测），宿主自更新部署（SetUp relaunch 的现行目录改名）连续两次失败。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 根因 | `start "" "<exe>"` 与 `WshShell.Run` 都**不设 cwd**——子进程继承启动者 cwd；而宿主侧工具通道的默认 cwd 就是宿主运行区，「从哪儿拉起」= 「锁住哪儿」 | `_unpack/resources/app/启动QQ机器人.bat`（原 start 行无 `/D`）· `启动QQAgent.bat` / `.vbs`（原无任何 cwd 钉死） |
| 应用层修复 | `electron/main.js` 首段 `process.chdir(自己的目录)`——打包态 = exe 所在目录（= 双击启动的自然 cwd）；开发态 = 应用根。位置在 Electron 拉起子进程之前（gpu / network / renderer 继承主进程 cwd） | `[qqagent-cwd-patch:main-chdir]` |
| 启动器层修复 | 应用内 bat `cd /d "%~dp0"`；项目根 bat `cd /d "%~dp0_unpack"`；vbs `sh.CurrentDirectory = "..._unpack"` | 三处标记 `[qqagent-cwd-patch:launcher-bat]` / `launcher-vbs` / `app-bat` |
| 补丁脚本 | `tools/patch-qqagent-cwd.mjs`——幂等（锚点唯一校验 · 换行风格自适应 · 写后 ASCII 断言） | 首跑 **applied 4 / skipped 0**；复跑 **applied 0 / skipped 4** ✅ |
| 自测 | `node tools/verify-qqagent-cwd.mjs`——静态 + 抽段真跑（打包态 / 开发态两分支）+ `start /D` 对照（带 /D 不继承、不带 /D 继承） | **ALL PASS 21/21** ✅ |
| 真链路实锤 | 从敌意 cwd（`CatTemp/qqagent-cwd-probe/hostile`）用**不钉 cwd** 的启动器拉起真实应用（隔离空数据目录 = 默认配置 = 白名单空 + 协议端不自动拉起，全程 inert）→ handle64 查句柄 | 四进程 **各持 `...\_unpack` 目录句柄**（main 31940 · gpu 31588 · network 33996 · renderer 30068）；敌意 cwd **无任何进程持有** ✅ |
| 收尾 | 探针实例 `taskkill /IM "QQ Agent.exe" /T /F` 全清（4/4）+ 探针目录 `file-delete` | 进程与目录均无残留 ✅ |
| 生产链路复核 | 并行会话（浏览节拍）于 00:28:57 经 `启动QQAgent.vbs` 重启生产实例 → handle64 复查 | 四进程（main 6064 · gpu 5892 · network 31044 · renderer 33368）**各持 `...\_unpack`**；`D:\Mau\MauOut` 持有者只剩宿主自身 + `cmd`(35548)/`node`(8808) 持 `html\tests` —— **无 QQ Agent** ✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生产实例已由并行会话（浏览节拍）于 00:28:57 经 `启动QQAgent.vbs` 拉起——handle64 复核四进程各持 `...\_unpack`，宿主运行区无 QQ Agent 持有 | **已闭合** ✅ |
| 2 | 宿主运行区当前另有**非本项目**的持锁者：`cmd`(35548) + `node`(8808) 持 `D:\Mau\MauOut\html\tests`——同属「继承启动者 cwd」一族，改动面在宿主侧 / 工具通道侧，不在本次范围 | 待定 |
| 3 | 自研单体 `app/`（Electron）实测 cwd = `QQBotB\app`（未落宿主运行区）——其启动器无显式钉死，属同类潜在风险 | 待定 |
| 4 | `_unpack` 为可弃拆包产物：重拆包后按顺序重跑补丁链（含本补丁）即复现 | 可复现 |

## 十九、浏览节拍（design-qqbotb-engage.md §二 · 2026-10-11）

> 触发：Rushiera 2026-10-11 指令——「现在有发消息就立刻唤醒 llm 确实不太符合常规用户的群内浏览方式」+ 三条追补（到点一次性把全部内容给 LLM / @ 例外要回应 / 撞发言墙后回节拍）。四个决策点拍板：节拍相位 = **心跳**（全局巡检）· 回落 = 按**参与度**（不用静默）· 运行结束 = **回节拍** · 私聊 = **不走节拍**。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 新模块 | `src/browse-rate.js`——档位状态机（档位 / 有效期 / 续期 / 到期降档）+【群节奏】提示词渲染 | 补丁 `[qqagent-browse-patch:browse-rate]` ✅ |
| 触发改造 | `orchestrator.onIncoming` 走节拍：消息只入库（保持未读），不逐条判定、不立即唤醒；`@ / 拍一拍` 与私聊例外立即触发 | 补丁 `orchestrator-onincoming` ✅ |
| 节拍巡检 | 全局一个 `setInterval`（`sweepMs` 5 秒）扫 `browseNextAt` 表——到点有未读才 `wake`，无未读零动作（**不调 LLM**）；运行中 / 已排唤醒 / 指令禁言的群跳过 | 补丁 `orchestrator-methods` ✅ |
| 档位覆盖 | `storeConfigForChat` 在节拍模式下统一返回 4 档——否则浏览拍走"机械批"会被 1~3 档判成"未触发"整批归档（表现：到点了却不理人）；指令禁言的 early return 优先 | 补丁 `config-tier` ✅ |
| 运行结束回节拍 | wake 收尾的 drain 分支改为 `#noteBrowsePending(chatKey, true)`——本轮结束（含撞配额墙、模型沉默）一律等下一点，不排 1.2s 连跑 | 补丁 `orchestrator-drain` ✅ |
| 恢复积压 | `drainBacklogAfterResume` 同样按节拍排（不立即唤醒） | 补丁 `orchestrator-backlog` ✅ |
| 提示词 | 【群节奏】段（与配额 / 热度同段追加在用户消息末尾）：当前节拍 + 档位 + 升档时"额度没变、越热越要省着说"；@ 批追加"点名找你，要回应" | 补丁 `orchestrator-hint-def` / `hint-append` ✅ |
| 模型工具 | `set_browse_rate(level)`——1/2/3 档；描述里点明"节拍调快不放宽额度"；私聊调用明确拒绝；越界钳到范围内 | 补丁 `tools-register` ✅ |
| 续期链路 | `sender.#checkRate` 放行即 `holdBrowse`——"还在参与"顺延有效期；撞配额墙的发送抛错在记账之前，不算参与 | 补丁 `sender-hold` ✅ |
| 配置 | `engage.browse`（enabled / levels / holdMs / atMeImmediate / privateImmediate / sweepMs） | `_unpack/data/config.json` 落盘实况 ✅ |
| 补丁脚本 | `tools/patch-qqagent-browse.mjs`——17 补丁点（幂等 · 换行自适应 · 模块内容更新检测）；**依赖 `patch-qqagent-engage.mjs` 先跑**（一个锚点落在它的产物上） | 首跑 **applied 17** ✅ · 复跑 **applied 0 / skipped 17** ✅ |
| 补丁链复核 | 全部 11 个脚本逐个 `--dry`：`applied 0` | session 31 · engage 21 · nosys 2 · memory 23 · sessions-fold 7 · botguard 19 · hardlimit 4 · talkstyle 8 · cattools 11 · cwd 4 · **browse 17** ✅ |
| 自测 | `node tools/verify-qqagent-browse.mjs`——档位状态机 / 续期 / 到期降档 / 提示词段 / 指令禁言 / 档位覆盖 / 工具面 / 发送续期 / 源码落点 / **节拍链路端到端（假时钟 2s 巡检真跑一遍 onIncoming → 巡检 → wake）** | **ALL PASS 37/37** ✅ |
| 生效 | 停应用 → `启动QQAgent.vbs` → 00:28:57 控制台就绪 | 日志：**工具集 36 件**（35 + `set_browse_rate`）· OneBot 连接成功 · **无 ERROR** ✅ |
| 🔴 判例（当日修） | **巡检用了没导入的 `decayBrowse`** → `#browseTick` 每 5 秒抛 ReferenceError，被 `setInterval` 的 catch 吞掉（`console.error` 在 GUI 外壳里看不见）→ 表现是「群里有人说话、永远不醒」；模块级自测全绿也照不出来 | 停应用 → 补导入 + 巡检诊断改走 `logger`（落盘可见）+ 自测加**端到端链路块**；复跑 **37/37** ✅ |
| 启动即起 | `orchestrator.startBrowseLoop()`（公开壳）+ `app.js` 启动流程调用；`#ensureBrowseLoop` 顺带把**已有未读的群**纳入节拍 | 补丁 `app-start` ✅ |
| 真链路实锤 | 01:04:43 重启 → **01:08:44 首拍**（boot + 240 秒） | 日志：`group:1097492606 浏览拍：6 条新内容进 LLM（节拍 240 秒）` · `group:689942975 浏览拍：47 条新内容进 LLM（节拍 240 秒）`；第三群无未读 → **未唤醒**（零调用）✅ |
| 群内实测 | 首拍后 20~55 秒内两群都出话，且回复内容**跨多条**（689942975 那条同时处理了登录态 / catKey / 域回收三件事）——正是「一批一起看、自己挑着接」的效果 | 日志 `[发送 -> group:...]` 三群合计 7 条 ✅ |

**设计要点（为什么这样落）：**

1. **回落不用"群里静默"**——热群里消息停不下来，静默信号永不触发，升上去就下不来。改用**参与度**：升档在 `holdMs`（15 分钟）内有效，期间该群有成功发言即顺延，到期自动降一档（60 → 120 → 240，最低档不再降）。模型想保持就继续参与，不参与了自然退。
2. **档位不落盘**（运行时短期态）——重启回基础档 4 分钟；"少看少说"是安全的失败方向，也少一个文件面。
3. **节拍 ≠ 本地判定**——节拍只决定"多久看一次"（时间维度），不参与"这批该不该接"；接不接仍全在模型手里（守 §十 边界）。
4. **一个全局巡检而不是每群一个定时器**——档位变化即时生效、停止时一处清理，群数少时扫描成本可忽略。
5. **巡检必须自己会说话**——它是"后台静默循环"，抛错被 catch 吞掉就等于功能不存在；诊断一律走 `logger`（落盘 + UI 日志页），不用 `console`（GUI 外壳里看不见）。

**架构三段式（本次）：**

- **保留**：OneBot 连接层 · 会话生命周期（全量窗口 / 收工轮 / 429 长轮询）· 记忆两轴三分 · 工具面 · 发言配额与热度软闸 · 补丁链形态（幂等 mjs + 自测）
- **扬弃**：逐条触发判定（`onIncoming` 的档位即时唤醒）作为**群聊默认路径** · `wakeDelayMs` 4 秒聚批作为默认批边界 · "运行结束 drain 连跑"作为默认续跑语义
- **新增**：节拍浏览触发面（`browse-rate.js` + 全局巡检）· @ / 拍一拍 立即例外 · 模型可调的浏览档位工具 `set_browse_rate` · 按参与度的档位回落 · 【群节奏】提示词段 · 巡检诊断走 `logger`（落盘可见）· 启动即起巡检（积压群纳入节拍）

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收——**成批进 LLM 已闭合**（首拍 6 / 47 条成批入批、第三群零调用）；**@ 立即触发**需真实 @ 一条 | 部分闭合 |
| 2 | 热点升档实跑（模型主动调 `set_browse_rate` → 下一拍按 60 秒巡检；到期降档日志出现） | 待实测 |
| 3 | 被接话率复测（目标 40~60%）——节拍浏览 + §九 发言纪律叠加后跑 `node tools/analyze-qqagent-chatter.mjs` 对照 | 待实测 |
| 4 | 设置页仍显示"响应档位"滑条——节拍模式下该滑条不参与触发（`storeConfigForChat` 统一 4 档）；界面标注待补 | 待定 |
| 5 | 重启前发现上一实例已不在（4 进程消失、日志无 ERROR、末行 23:11:56 正常发送）——本次按"应用已停"处理，直接拉起 | 已处置 |
| 6 | 🔴 **观测面缺口（判例的根因面）**：`console.*` 在 GUI 外壳（无控制台窗口）里**不落盘**——orchestrator 里既有的 `console.log/error` 诊断全都看不见。本次已把**节拍巡检**的诊断改走 `logger`（落盘可见）；其余既有 console 行仍不可见 | 部分处置 |

## 二十、记忆沉淀增强（design-qqbotb-memory.md §3.7 · 2026-10-11）

> 触发：Rushiera 2026-10-11 指令——「跑出了一些记忆……记的东西太少了不说，大多数也是一些偶尔群友突发奇想记住的，包括说给群友的印象也写的很少，再优化优化」。拍板：「全上，不过不要 2，还是要 300k 的前文进行整理」——即采纳沉淀通道 + 人档放宽 + 工具口径三块，**群记重整不挂时间冷却，仍以收工轮（300k 上下文轮转）为准**。

**诊断（读实况三群记忆 + 源码定位）：**

| # | 病灶 | 证据 |
|:--:|:--|:--|
| 1 | 收工轮的要点**不进群记** | `#completeRollover` 只从要点文本里抽话题词 → `setGroupTopics`；要点本体落 `_session.json` 且覆盖式。`group:1097492606` 已轮转 7 次，群记非 topic 条目仅 6 条 |
| 2 | 群记重整门槛写死成条数 | `#consolidateGroupMemory`：`!force && existing.length <= maxGroupEntries(12)` 即返回——三群 6/3/4 条，**永不触发** |
| 3 | 人档「只减不增」+ 发现门槛高 | `#consolidateOneMember` 整理模式「条数变多 = 疑似幻觉，放弃」；发现新人需发言 ≥20 条、单次 ≤3 人；每人上限 5 条、注入仅最近 3 条。31 人的群只有 3 人有印象 |

**落点与证据：**

| 面 | 落点 | 证据 |
|:--|:--|:--|
| ① 收工轮指令 | `rolloverInstruction()` 重写：先写群记（按 kind，先 `memory_query` 看现状）→ 再逐人过印象 → 要点文本 → 话题词；顺带修工具名（旧指令写「记录印象」，工具已改名「记录记忆」） | 补丁 `ro-instruction` ✅ |
| ② 群记重整唯一触发点 | 从 `consolidateMemoryForChat` 的自动路径摘出；改为 `if (force)` 保留手动按钮，并在 `#completeRollover` 里 `force` 跑一次（**在归档之前**——存档还在，样本才拿得到）；`#completeRollover` 改 `async` + 调用点补 `await` | 补丁 `group-pass-moved` / `rollover-async` / `rollover-group` / `rollover-call-await` ✅ |
| ③ 人档放宽 | 发现门槛 `20 → 5` 条 · 单次 `3 → 6` 人 · 每人上限 `5 → 8` 条 · 整理模式允许补充新特征（软上限 = 原条数 +2）· 整理提示词补该群友聊天样本（原只有旧印象，无法补新）· 注入面每人最近 `3 → 5` 条、无过滤时 `15 → 20` 人 | 补丁 `discover-thresholds` / `consolidate-grow` / `consolidate-prompt-call` / `consolidate-prompt` / `new-impression-maxkeep` / `prompt-member-limit` / `prompt-member-count` ✅ |
| ④ 工具口径 | `memory_append` description 去掉「临时情绪和一次性寒暄不要记」的强抑制，改为「判断标准只有一条：下次进这个群还用得上吗——宁可多记，去重交给重整」 | 补丁 `append-desc` ✅ |
| ⑤ 配置面 | `memory.*` 增 `maxImpressionsPerMember 8` / `maxGroupEntries 20` / `discoverMinMessages 5` / `discoverMaxMembers 6`（不写进 schema 就只能靠代码兜底，前端看不到、改不了） | 补丁 `memory-defaults` ✅ |
| 补丁脚本 | `tools/patch-qqagent-memory.mjs`——本次新增 **15 补丁点**，总数 **38**（23 + 15） | 首跑 **applied 15 / skipped 23** ✅ · 复跑 **applied 0 / skipped 38** ✅ |
| 语法校验 | `node --check` × 四文件（orchestrator / memory / tools / config） | 全部退出 0 ✅ |
| 自测 | `node tools/verify-qqagent-memory.mjs`——改写 1k/1l/1m/3g（原判据是「整理轮产出群记」，已不成立）、新增 1n（手动 force 仍可重整）；mock 端点加 `replyFn`（按请求内容分流回复） | **ALL PASS 33/33** ✅ |
| 生效 | 应用运行中改源码不生效——**需重启 QQ Agent**（本次未执行，见遗留 1） | —— |

**判例（当日踩到并修）：**

| # | 现象 | 根因 | 处置 |
|:--:|:--|:--|:--|
| 1 | 复跑补丁脚本 `applied 1`（不是 0）——`orchestrator-group-pass` 被**重放**，`let groupNote` 在同作用域声明两次（语法错） | 该补丁点的**标记**随被替换的代码块一起消失，幂等判据失效 | 替换文本保留原标记（`…group-pass][…group-pass-moved]`）；复跑回到 `applied 0 / skipped 38` |
| 2 | 手动重整群记后返回里读不到结果（`groupNote` 为 `undefined`） | 「没有可整理的群友」早返回分支漏了 `groupNote` 字段——重整了群记却报"没有可整理的群友" | 补丁 `early-note-groupnote` 补字段 ✅ |
| 3 | `--dry` 下 `new-impression-maxkeep` 锚点命中 3 次 | 该锚点依赖前序补丁已改写另外两处 `|| 5`（dry 不落盘，依赖不成立） | 锚点扩到函数签名行，改为上下文唯一 ✅ |

**设计要点（为什么这样落）：**

1. **写入面宽、重整面守**——「宁少勿错」写在重整提示词里是对的，写在写入工具的 description 里就变成了抑制信号：模型日常几乎不主动调 `memory_append`，实测有群友聊了 200+ 条却零印象。写入放开、去重交给重整，两个面各司其职。
2. **收工轮是唯一的结构化沉淀点**——它本来就有一轮完整的 LLM 调用 + 全量会话上下文，只是原先只用来产一段文本。改成"按 kind 写群记 + 逐人过印象"是**零额外调用**的密度提升。
3. **重整紧跟在写入之后**——收工轮里模型刚按 kind 写完，紧接着用同一批样本合并/改写最合适；挂在后台定时上会与收工轮写入互相打架（Rushiera 拍板：不要时间冷却）。
4. **人档"只减不增"是防幻觉，但代价是印象永远长不出来**——改成软上限（+2 条）+ 给整理提示词喂该群友的聊天样本，既保留防幻觉的边界，又让新特征有入口。
5. **参数进 schema**——`memory.*` 的四个新键写进 `DEFAULT_CONFIG`，前端可见可调；否则只能靠代码兜底值，下次调参又得改源码。

**架构三段式（本次）：**

- **保留**：两轴三分分类 · 群记 `kind` 枚举与渲染 · 工具面三件（append / query / remove）· 人档文件布局 · 补丁脚本形态（幂等 mjs + 自测）
- **扬弃**：收工轮"要点只写文本 + 话题词" · 群记重整按条数门槛挂在后台整理轮 · 人档整理"条数变多即放弃" · 工具描述里的「临时不要记」抑制口径
- **新增**：收工轮的结构化沉淀动作（群记 + 逐人印象）· 群记重整的收工轮触发点 · 人档发现门槛下调与补充新特征 · 注入面放宽 · `memory.*` 四个可调参数

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收——**需重启 QQ Agent** 后：群内对话 → 收工轮（300k 轮转）→ `_group.json` 出现非 topic 条目 + 人档印象增长 | 待实测 |
| 2 | 成本观察——人档发现门槛放宽后，每次后台整理轮的 LLM 调用数上升（群记 1 次 + 每人 1 次 × 最多 6 人）；跑一两天看账单 | 待观察 |
| 3 | `_unpack/data/config.json` 现有 `memory` 段没有四个新键——重启后由 `DEFAULT_CONFIG` 补齐（前端保存配置时才会落盘） | 按设计 |
| 4 | `maxGroupEntries` 默认 20，`group-memory.js` 内部硬顶 `MAX_ENTRIES 40` / `MAX_TOPICS 12`——两者不冲突（20 < 40），但群记条数真正受限的是后者 | 按设计 |
| 5 | 收工轮现在多一次 LLM 调用（群记重整），轮转收尾耗时增加；失败已隔离（try/catch，不影响归档） | 按设计 |

## 二十、静默补拍（design-qqbotb-engage.md §二 · 2026-10-11）

> 触发：Rushiera 2026-10-11 指令——「给响应节拍再加一个：如果最后一条未读超过 60 秒没人接话，也触发一次；不过同样的，不要求一定要有回复」。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 判定 | `src/browse-rate.js` 增 `idleTriggerMs` / `idleFireDue` / `markIdleFired`——有未读 + 最后一条未读静默 ≥ `idleMs` → 补一拍；同一批（ts 未变）只补一拍 | 补丁 `[qqagent-browse-patch:browse-rate-idle]` ✅ |
| 巡检分支 | `#browseTick` 由「到点才看」改为「到点 or 静默补拍」：`due = now >= nextAt`；未到点时取 `store.lastUnreadTs` 判定；触发后相位重算（回节拍） | 补丁 `orchestrator-idle-tick` ✅ |
| 数据面 | `store.lastUnreadTs(chatKey)`——最后一条未读的时间戳（无未读 → 0） | 补丁 `store-lastunread` ✅ |
| 配置 | `engage.browse.idleMs`（默认 60000；0 / false = 关闭） | `_unpack/data/config.json` 落盘实况 ✅ |
| 补丁脚本 | `tools/patch-qqagent-browse.mjs` 扩至 **22 补丁点**（新增 4 点 + `browse-rate.js` 模块内容重写） | 首跑 **applied 5 / skipped 16** ✅ |
| 自测 | `tools/verify-qqagent-browse.mjs` 扩至 **49 项**——新增 A2 判定块（8 项）+ I2 静默补拍链路端到端（2 项）+ 源码落点断言（2 项） | **ALL PASS 49/49** ✅ |

**设计要点（为什么这样落）：**

1. **两条触发路径，一条语义**——到点浏览拍与静默补拍都只是"给模型看一次"，回不回全在模型（§十 边界不变：节拍只决定"多久看一次"，不参与"该不该接"）。
2. **"没人接话" = 没有新消息进来**——有新消息则 `lastUnreadTs` 前移、计时重来；群里一直在聊时不会每 60 秒补一拍，只有真停下来才到点。
3. **同一批只补一拍**——按 `lastUnreadTs` 记账，防"模型没回 → 未读还在 → 每 5 秒补一拍"的烧 token 循环。
4. **记账放在闸门之后**——被 running / pendingWake / 禁言 / 无未读拦下的那一次不记账（机会留给下一拍），与 §十九 的相位重算口径一致。
5. **成本可见**——日志区分「浏览拍」与「静默补拍」，跑一天即可按 `[browse]` 段统计两条路径的实际触发次数，据此调 `idleMs`。

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真实链路验收——群里说一句后静默 60 秒，日志出现「静默补拍」行 | 待实测（需重启生效） |
| 2 | 静默补拍触发后模型选择不回复 → 该批未读沉入历史、不再补拍（下一批才重新计时） | 待实测 |
| 3 | 成本对照——两条触发路径的实际调用次数（`[browse]` 段统计），跑一天后按体感调 `idleMs` | 待实测 |

## 二十、猫工具链升级——域类型 / 有头登录 / 识图 / 下载器（2026-10-11）

> 触发：Rushiera 2026-10-11 指令——「把 mau 刚刚更新的那些新功能 BrowserCat（含 browser-headful）/ VisionCat（image-analyze + image-inject）/ WebCat（web-fetch + web-fetch-jobs）还有 timeback 都实装过去」；同日追加——「莎给的 Chat.zip / Browser.zip 是 chatBot 的系统提示词，前文要加上，给 qqbotB 时也别忘记」。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 工具面 | 12 件移植工具（原 7 件 + browser-headful / image-analyze / web-fetch / web-fetch-jobs；timeback 拆两件） | `GET /api/tools/availability` 12 件 `enabled:true` ✅ |
| 域类型化 | `timeback-start`（type + purpose）/ `timeback-back`（findings + 工具台账）——域白名单 fail-closed（名单外一律拒，含原生发送 / 记忆工具） | 自测：type 校验 / 域内拒原生工具 / 域内拒 headful / 台账入回执 ✅ |
| 有头登录 | `cdp-browser.js` 新增 `headfulOpen()`（同 profile 单例、不连 CDP、窗口可见）+ service 层 `headful` | 自测：真起窗口 → close → 实例回收 ✅（闭合 B16） |
| 识图 | `image-analyze`——本地 / http 图 → 视觉模型 → 文字（走 `chatCompletion`，自动切 `api.visionModel`） | 自测：参数面 / 越界拒 / 非图拒 ✅ |
| 下载器 | 新模块 `web-fetch.js`——全局单一下载器：任务表落盘 + 后台下载 + 完成注入（未读 + 唤醒）+ list/status/cancel | 自测：本地回环真实下载 200KB 落盘 + 重名拒 + status ✅（闭合 B17） |
| 补丁 | `patch-qqagent-cattools.mjs` 扩至 17 点（新增 5 点 + 模块 3 个）· 补丁 7 退役（由 13 取代）· 新增 `patchVariants`（形态兼容） | 首跑 applied 8 / skipped 9；复跑 applied 1 / skipped 16 ✅ |
| 自测 | `node tools/verify-qqagent-cattools.mjs` | **ALL PASS 63/63** ✅ |
| 生效 | 停应用（`Stop-Process -Name "QQ Agent"`）→ `启动QQAgent.vbs` | 日志：**工具集 41 件**（36→41）· OneBot 连接成功 · 无 ERROR ✅ |
| 前文增补 | `apply-qqagent-config.mjs` 的 INJECT 加 `L2/Worker/Chat` + `L2/Job/Browser`（并加 `--roletext-only` 开关——只刷前文，不覆盖 api / snowluma） | roleText 15 → 22 件 / 89,037 字符 ✅ |
| CCBP 侧身份 | Chat Worker 四件更新（莎版：QQ 场域 + 网页操作 + Browser Job 挂载）· 新增 `L2/Job/Browser` 三件 · Chat/history 三判例入档 · `L1/Tree.md` 两处同步 | 落盘 + Tree 更新 ✅ |
| 活链路验证 | 新增 `tools/verify-qqagent-cattools-live.mjs`——生产配置 + 真外网（baidu.com）+ 真视觉模型 + 截图交识图闭环 | **ALL PASS 12/12**（image-analyze 读出图中 588 字）✅ |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 域类型只保留 `browser_vision`——本卫星工具面没有 cs-* / 文本读面，其余三类无从落地 | 有意为之（表结构保留，加工具即可扩展） |
| 2 | web-search 未新增——qq-agent 原生 `web_search` 同语义（§十六 口径延续） | 记录在案 |
| 3 | browser-read 长正文落盘后，本卫星无文本读面可回读 | 待定（后续可移植 text-read） |
| 4 | roleText 89KB/轮——每轮进用户消息，成本高 | 待定（可评估换为 Chat 前文 / 精简注入集） |
| 5 | 群内真实触发（模型自己调 browser-headful / web-fetch） | 待真实群消息——工具面与链路均已就位 |
| 6 | 下载器「续传」未做——进程重启后 running 任务标 interrupted（不自动续） | 有意简化（与 CH4 的 Range 续传有差异，如实标注） |

## 二十一、启动器改全流程重启（project.md 目录结构 · 2026-10-11）

> 触发：Rushiera 2026-10-11 指令——「改一下 bat，后续我点这个 bat 完成所有的动作并且清理掉以前的所有内容，这样你更新也能不打扰我」。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 启动器 | `启动QQAgent.bat` 重写为 4 步：停实例（`taskkill /IM "QQ Agent.exe" /T /F`）→ 清实例锁 → 落启动会话 → 起应用（cwd 钉 `_unpack`） | 真链路实测：新 PID + `01:52:28` OneBot 连接成功 ✅ |
| 保留面 | 单实例锁语义（清锁只是加速——PID 探测本就会清残留锁）· cwd 钉死标记 `[qqagent-cwd-patch:launcher-bat]` + `cd /d "%~dp0_unpack"` + `start "" "%~dp0_unpack\QQ Agent.exe"` | `verify-qqagent-cwd.mjs` **ALL PASS 21/21** ✅ |
| 补丁链 | **不进启动器**——首版把补丁重放放进 bat，实测卡在 `patch-qqagent-engage.mjs`（锚点 0 命中）并**阻断启动**；已移出（补丁是维护者的活，失败不得阻断普通启动） | 首跑实测：`[ERROR] patch chain failed at: engage` · App NOT started |
| 🔴 判例（当日修） | **engage 补丁点被 memory 补丁接管后标记消失** → 重放时锚点（旧文案 `'4. 写完就结束…'`）0 命中 → 整链中断。修：该点 `appliedIf` 改判 memory 的标记（`[qqagent-memory-patch:orchestrator-rollover-topics]`），锚点只对"从原始版本首跑"有意义 | 修后复跑：**applied 0 / skipped 21** ✅ |

**边界（不清什么，为什么）：**

| 项 | 处置 | 理由 |
|:--|:--|:--|
| `data\messages\` | 不清 | 群聊存档——清了猫失忆 |
| `data\memory\` | 不清 | 群记 + 群友印象（两轴三分的落点） |
| `data\sessions\` | 不清 | 会话页运行记录 |
| NapCat（`runtime\NapCat\...\QQ.exe`） | 不清 | 协议端——杀它要重新扫码登录；应用启动时自己重连它 |
| 日志 | **不清**（2026-10-11 决定） | 先跑一段时间看看再定；应用自身 `logger.prune()` 也在管 |
| 实例锁 | 清 | 残留锁只会拖慢启动 |

**范围确认（Rushiera 2026-10-11）：** 只清运行残留（实例锁），**不动**存档面（`messages` / `memory` / `sessions`）、不动 NapCat、**不清日志**——日志先跑一段时间看看要不要清，届时再定。

## 二十二、真群实测三修（2026-10-11 · Rushiera「试试能不能用」）

> 触发：Rushiera 指令「你试试那些 qqbotB 新增的那些东西能用吗」→ 注入测试消息 + 真群实测（SC2INV 群 / KKCardMod 群）。三条都是**只有真链路能暴露**的缺陷（自测 63/63 全绿时它们都还在）。

| # | 现象 | 根因 | 修法 |
|:--:|:--|:--|:--|
| 1 | 猫开域后**卡死**：网页打开了、却不发言不下载 | `timebackGateTool` 的白名单 fail-closed 漏了 CH4 那条例外——**timeback 两件自身不受管辖**；`timeback-back` 被自己的门禁拒（`ERR\|TIMEBACK_PROFILE`）→ 域永远关不掉 → 域内一切（send_message / web-fetch / report_feedback）全被拦 | 放行 timeback 两件；自测补「域内放行 timeback 两件」用例 → **64/64** |
| 2 | **每轮都撞收工轮**，且收工轮"收不成" | `recordPromptTokens` 吃的是 `session.usage.promptTokens`，而 usage 由 `addUsage` **逐轮累加**（一次运行 12 轮 × 5.5 万 = 66.7 万）→ 被 `shouldRollover` 当成"上下文大小" → 每轮都超阈值；收工轮失败只 `console.error`，GUI 外壳无 stdout → **失败不可见**，`resetSession` 永不执行 → 死循环 | ①单次上下文只认**最后一轮**的 prompt ②收工失败改走 `logger.error` 落盘（补丁 `usage-single-prompt` / `rollover-baseline` / `rollover-visible`） |
| 3 | 截图**发不出群**，只在群里发了一串路径文本 | ①`send_image` 硬性只认 http(s) 直链（本地路径被入口拒："那会暴露宿主文件系统"）②前文里的 `L1/Discipline §九` 教模型用 `[image-open]…[image-end]` 包裹——那是 CH4 **宿主前端**的渲染判据，QQ 不认 | ①`send_image` 支持**白名单根内**本地路径（复用 `imageRoots()`，传 `file` 让协议端读盘）②发送层 `sendTextBatch` 加**包裹兼容层**：按规范判据解析 → `sendImage(file)`，正文照发 |

**验证实锤：**

| 面 | 证据 |
|:--|:--|
| 域机制 | KKCardMod 群：猫自主 `timeback-start` → `browser-open`（标题「百度一下，你就知道」，1122ms）→ **主动 back** → 主干 `web-fetch` → 下载完成自动注入回群（`D:\Mau\WorkSpace\Downloads\baidu_home.html`，227 B）✅ |
| 自测 | `verify-qqagent-cattools.mjs` **ALL PASS 64/64**（新增域自锁用例） |
| 活链路 | `verify-qqagent-cattools-live.mjs` **ALL PASS 12/12**（真外网 + 真视觉模型，image-analyze 读出图中 588 字） |

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | **直接改 `_unpack` 源码、补丁脚本未同步**（Rushiera 2026-10-11 定：「直接重构，后面本来就要做 modB」）——现有 4 处：§二十二 三修 + §二十三 图片包裹兼容层放宽（`sender.js`） | 待定（重拆包会丢；modB 迁移时一并带过去） |
| 2 | 图片包裹兼容层只覆盖 `sendTextBatch` 出口（模型不调 `send_message` 的纯文本输出本就不发） | 有意为之 |
| 3 | `send_image` 本地路径分支尚未跑通"发到群"的端到端实锤（等一次真群截图） | 待验 |

## 二十三、Cloudflare 人机验证处置——UA 对齐 + 有头过一次（2026-10-11）

> 触发：Rushiera——「SC2INV合作交流2群……触发：@Shieraru 你打开星际合作维基截个图看看」→ 猫 `browser-open` + `browser-shot` 拿到 Cloudflare「正在进行安全验证」页，自己判「浏览器抓 wiki 这条路是死的」。Rushiera 追问：「我记得现在工具不是有什么登录态吗」。

**根因（实测，非推断）：**

| # | 事实 | 证据 |
|:--:|:--|:--|
| 1 | 无头实例 UA 串 = `…HeadlessChrome/134.0.0.0…`——风控据此判自动化 | 域内 `browser-eval` 取 `navigator.userAgent`；CF 挑战页脚本里就有 `indexOf("HeadlessChrome")` |
| 2 | `cf_clearance` **按 UA 签发**——有头窗口人工过验证拿到的凭据，无头 UA 不一致即复用失效 | 有头过一次后 profile 命中 `Default\Network\Cookies:…cf_clearance…`；同一 profile 无头复访仍回挑战页（Ray ID 更换） |
| 3 | 风控覆盖**整域**，含 API | `…/api.php?action=query&meta=siteinfo` 同样回挑战页——「换 API」是死路 |
| 4 | 站点域名本身也是错的 | `sc2.huijiwiki.com` / `sc2coop.huijiwiki.com` 均跳灰机 404；**正确入口 = `https://starcraft.huijiwiki.com/`**（星际争霸中文维基） |

**修法（QQBot mod B 侧）：**

| 面 | 落点 |
|:--|:--|
| UA 对齐 | `cdp-browser.js` `#attach` 后调 `#applyUserAgent`——`Browser.getVersion` 取内核真实 UA → `HeadlessChrome`→`Chrome` → `Emulation.setUserAgentOverride`（同内核同版本，只去 headless 特征）；失败走 `log`（不静默） |
| 工具描述 | `cat-tools.js` 的 `browser-headful` 描述补「遇 Cloudflare 验证页走这里」的处置路径 |
| 领域认知 | `L2/Job/Browser` exp §六 排错表 + skill §四 排错溯源各加一条（判「浏览器这条路是死的」为误判） |
| 装补丁 | `patch-qqagent-cattools.mjs` → applied 2（`src/cdp-browser.js` / `src/cat-tools.js`）/ skipped 15 · 前文重合成 `--roletext-only`（22 件 / 89,348 字符） |

**验证实锤（本地，借 CH4 主干 profile——内含刚才人工过验证拿到的 clearance）：**

| 步 | 结果 |
|:--|:--|
| 无头（UA 对齐后）访问 `starcraft.huijiwiki.com` | **放行**——标题「星际争霸中文维基 \| Star Craft \| 星际争霸2 - 灰机wiki」，正文为星际争霸系列介绍（1290ms） |
| 同实例访问 `sc2coop.huijiwiki.com` | 灰机 404 页（域名不存在，非挑战页） |
| 同实例访问 `www.huijiwiki.com/wiki/星际争霸2` | 正常页（放行） |

**结论：** UA 对齐是充分条件（clearance 有效期内）——有头过一次 + 无头 UA 与有头一致 = 复用成立。

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | QQAgent 侧真链路验收（重启应用 → 群里 @ 它取 wiki → 走 headful 请人过一次） | 待实测 |
| 2 | `cf_clearance` 到期后需再过一次——人工介入是固有成本 | 已知 |
| 3 | 每群 profile 独立 → 多群访问同站需各过一次 | 已知 |
| 4 | CH4 宿主侧（C# `CdpBrowserService`）无 UA 对齐——主干浏览器遇 CF 同样被拦 | 待定（可移植同一修法） |

### 二十三·补记——有头关闭链路三修（2026-10-11）

> 触发：Rushiera 实测反馈——「这次能弹窗口过验证了，但是过完验证之后 edge 就退出了，然后我试着 @ 了几次每次都要我新验证」。

**根因（两处叠加，都在关闭链路）：**

| # | 事实 | 后果 |
|:--:|:--|:--|
| 1 | `close()` 对有头窗口是**强杀**（`proc.kill()` + `killTree`）——有头实例不连 CDP，关闭只能杀进程树 | Chromium 来不及 flush profile → 刚过的验证凭据（`cf_clearance`）没落盘 → 下次还要重新验证 |
| 2 | 运行收尾回收（`orchestrator` 补丁 `orchestrator-close`）无条件 `closeChat(chatKey)` | 猫开窗 → 群里喊人 → 结束回合等人回话，这一结束就把人工窗口回收了（同样走强杀） |

**修法（`cdp-browser.js`）：**

| # | 改动 |
|:--:|:--|
| 1 | `close()` —— 有头走 CDP `Browser.close` 优雅关闭（读 profile 的 `DevToolsActivePort` 连 CDP → 等进程自退 → 兜底才强杀）；新增 `#gracefulClose()` |
| 2 | `closeChat()` —— **跳有头窗口**（域回收 / 运行收尾都不关它）；`browser-headful(action="close")` 改为直连关闭 |
| 3 | `#instance()` —— 有头实例被无头调用顶掉时改**优雅关闭**（原 `killNow()` 强杀） |
| 4 | 有头窗口空闲回收 10 → **30 分钟**（`HEADFUL_IDLE_CLOSE_MS`——等人点，别急着关） |

**验证：** 待真群实测（重启后 @ 一次 → 过验证 → 猫 close → 重开域取内容；再 @ 一次应**无需再验证**）。

## 二十四、入口切换到自研单体（2026-10-11）

> 触发：Rushiera——「我发现有些内容是不是还是没有实装啊……重启电脑后打开这个软件之前约定好的 bat 还是会开 napcat」→ 拍板「按 b 目前只换入口 不要丢功能」。

**实测根因（两条，都可验证）：**

| # | 事实 | 证据 |
|:--:|:--|:--|
| 1 | 黑窗口消除只实装在自研单体，没进 QQ Agent 链路 | `app/src/napcat/host.js` 有 `hide-console` 轮询隐藏；`runtime/napcat-host/index.mjs`（QQ Agent 的 snowluma shim）只有 `windowsHide:true`——对 NapCat 自建 conout 控制台无效（§十七 踩坑 2）。实测：NapCat 的 `QQ.exe` 窗口标题为命令行原文（`选择 D:\…\NapCat.52230.Shell\QQ.exe`） |
| 2 | 自研单体（链接层）不是入口 | 唯一入口是 `启动QQAgent.bat/.vbs`；`app/` 无启动器、无自启——「协议端宿主 / WebUI 免登录 / 无窗口」三项收益在真实启动路径上一次都没被消费（实测 3280 未监听） |

**改动：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 新入口 | `启动QQBotB.bat` / `.vbs`（项目根） | 一键全流程重启四步：停旧实例 → 清业务面实例锁 → 落启动会话 → 起自研单体 |
| 入口生成器 | `tools/apply-entry.mjs` | 入口文件受 ASCII + CRLF 硬约束（cmd 按 GBK / WSH 按 ANSI 解析）——只由脚本生成，写后断言纯 ASCII + CRLF |
| 业务伴生进程 | `app/src/companion.js` + `config.js` `companion.*` + `app.js` 接线 | 协议端就绪后按需拉起 QQ Agent（`tasklist` 存活探测 → 已在跑则跳过）；不接管其生命周期，退出不杀它 |
| cwd 钉死 | `app/main.js` 首段 `process.chdir(模块目录)` | 补 §十八 遗留 3——自研单体启动器原先无显式 cwd 钉死 |
| WebUI 免登录 | `app.js` `webuiCredential` 改轮询重试（40 × 1s） | 应用自起协议端后界面帧先于 WebUI 就绪——原一次性 fetch 必然失败（首次实测即「凭据为空」） |

**顺序（硬要求）：** 协议端就绪 → 才拉业务面。业务面自己也经 snowluma 通道拉协议端（协议端已在跑时该 shim 只驻留）——顺序颠倒会出双实例。

**验证实锤（三次真链路：09:29 / 09:31 / 09:32）：**

| 面 | 证据 |
|:--|:--|
| 冷启动（协议端未运行） | `09:32:07.483` 已拉起协议端（pid=22492）→ `09:32:09.406` WebUI 6099 就绪（隐藏控制台 1 轮）→ 新 `QQ.exe` 窗口标题 **N/A**（无黑窗口） |
| 业务面自动拉起 | `09:32:09.577` companion 已拉起业务面（pid=25308）→ `09:32:13.507` OneBot 已连接 / 登录账号 `Shieraru(2405997337)` |
| WebUI 免登录（冷路径） | `09:32:07.662` / `08.673` 第 1、2 次 `fetch failed` → `09:32:09.694` **已注入协议端控制台凭据（自动登录）**（第 3 次成功） |
| 热启动（协议端已在跑） | `09:31:09.555` 协议端已在运行，跳过启动——不重复拉起 |
| 本机日常 QQ 不受影响 | 其会话窗（`工仔养生水疗中心等107个会话`）照常；协议端进程只按 Shell 目录归属处理 |

**架构三段式（本次）：**

- **保留**：业务面 QQ Agent（编排 / 记忆 / 工具链）· OneBot 11 协议契约 · NapCat 协议端本体（二进制不动）· 账号槽位与多群配置 · 「启动软件 = 新会话」语义
- **扬弃**：QQ Agent 作为唯一入口（降为伴生进程）· snowluma shim 作为协议端的唯一拉起者（降为驻留者）· `启动QQAgent.bat/.vbs` 作为日常入口（降为回落路径）
- **新增**：自研单体入口（`启动QQBotB.bat/.vbs` + `tools/apply-entry.mjs` 生成器）· 业务伴生进程（`app/src/companion.js`）· 入口链 cwd 钉死 + WebUI 免登录重试

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 旧入口 `启动QQAgent.bat/.vbs` 保留为「只起业务面」的回落路径——协议端已在跑时其 shim 只驻留 | 保留 |
| 2 | 入口四步的 `taskkill /IM "QQ Agent.exe" /T /F` 会连带杀掉它拉起的 shim（及其拉起的协议端）——首次切换时协议端因此重启一次（`-q` 快速登录，无需扫码）；协议端改由应用接管后，应用侧以 `detached` 启动，后续重启不再牵连它 | 已观察，符合预期 |
| 3 | §二十一「不动 NapCat」的边界随本次入口切换失效——协议端生命周期归应用 | 取代 |
| 4 | 自研单体仍以 Electron 开发态运行（`app/node_modules/electron`）——打包 / 发布面未做 | 未做 |

## 二十五、领航员模式（2026-10-11）

> 触发：Rushiera 2026-10-11 口述规格——「给软件加一个领航员模式」+ 三问拍板（LLM 用 R喵 现役端点 / 截图走 history 自渲染 / 领航员就是 R喵）+ 补充约束（共存期可写 QQ Agent，但终态要进自研单体）。

| 面 | 落点 | 证据 |
|:--|:--|:--|
| 设计 | `design-qqbotb-navigator.md`（12 节——含 §十二 迁移路径） | 新建 ✅ |
| 自研单体·状态机 | `app/src/navigator/state.js`——开关 / 回消息群 / 指令流水 / 空闲阈值（30 分钟） | 自测「落盘可复读」「跨群跟随」✅ |
| 自研单体·CH4 猫面 | `app/src/navigator/ch4.js`——`/api/v1/cats` 读猫群 · `/api/v1/cat-detail` 单猫详情 · `cat.chat`（非主干）/ `Chat `（主干 8081）双通道投递 | 自测 10 只猫 + 主干端口 8081 ✅ |
| 自研单体·观测 | `app/src/navigator/watch.js`——每猫端口 SSE 订阅 + 帧解析 | 代码就位（真链路待 N5） |
| 自研单体·截图与解读 | `app/src/navigator/shot.js`——视图块 → 对话卡 HTML → 离屏窗口 `capturePage` → 视觉模型解读（复用业务面端点） | 实测：`POST /api/nav/shot` 出图 + 解读文本 ✅ |
| 自研单体·编排 | `app/src/navigator/index.js`——健康检查 / 回执模板 / 投递 + 观测登记 / 空闲暂关守护 / VIP 消息监听 / 本地 API | 实测 `/api/nav/status` 200 · `/api/nav/health` 全绿 ✅ |
| 壳层截图 | `app/main.js` `core.hooks.shot`——离屏 BrowserWindow 按内容高度整页截图 | 实测出图 ✅ |
| 界面 | `app/ui/index.html` + `app/ui/app.js` + `style.css`——「领航员」页签（开关 / 会话 / 猫群 / 健康检查 / 指令流水） | 截图核验：页签高亮 + 三卡片渲染 ✅ |
| 业务面·工具组 | `tools/navigator/nav-tools.js`（5 件）+ `tools/patch-qqagent-navigator.mjs`（6 补丁点） | `/api/tools/availability` 五件 enabled ✅（工具集 41→46） |
| 业务面·教材 | `tools/apply-qqagent-config.mjs` `NAV_RULES` 段（开关 / 判断 / 怎么做 / 回话口径 / VIP 通道） | roleText 91277→91388 字符 ✅ |
| 业务面·VIP 通道 | `sender.js` 三点——`atUserId === 569145850` 时跳过发言配额与硬限（技术限频仍在） | 补丁 applied · `node --check` 通过 ✅ |
| 自测 | `tools/verify-navigator.mjs` | **17/17 通过** ✅ |

**关键设计（三条）：**

1. **单向依赖**——业务面 → 自研单体（工具调本地 API）；自研单体的出站（回执 / 截图）直经自己的 OneBot 连接发出，不经业务面闸门（这正是「不设发言墙」的落点）
2. **触发者硬校验**——自研单体监听 OneBot 群消息，只认 VIP（569145850）在群里 @ 本 bot 的消息；`nav_open` 带 `requireVip` 时无新鲜 VIP 消息即拒
3. **双通道投递**——非主干走 `cat.chat <key> <内容>`（8080）；主干走 `Chat <内容>`（其对话端口；`cat.chat` 拒主干自锁）

**边界与遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真链路验收（群内 @ 开启 → 下指令 → 截图回群） | **已验收 2026-10-11**——群内 @ 开启成功（`openedBy: qq` · `activeChat: 1097492606`）· 指令投递成功（`commandLog` 记「链路通了」→ majordomo）· 观测已登记（`watching: [majordomo]`） |
| 2 | ComfyDock 健康检查显示「离线」——面板端口 8971 当前无监听 | 观察项（服务没跑，非缺陷） |
| 3 | 业务面 VIP 通道是过渡态——终态由自研单体出站承载（本就无闸） | 已记入 design §十二 |
| 4 | 领航员出站图片为 `file:///` 绝对路径（OneBot image 段） | 真链路待验 |

### 二十五·补记——SSE 判据纠偏 + 开场巡检 + 可观测（2026-10-11）

> 触发：Rushiera 反馈「等了半天没看到群里回的消息」+「10 只猫都在待命，希望区分有会话和确实待命的场合，有会话的也该把最后回复截图发出来」。

**根因（实测）：** 每猫端口的 `GET /api/v1/stream` **不推渲染块**——`event: view` 的 data 是视图状态 `{v, state, persist, live}`（无 renderType）；渲染块只能从 `GET /api/v1/keyinfo?max=N` 取（四部分：加载报告 / user 消息 / 正式回复 / 轮结算）。原实现按「view + renderType=roundsum」判轮结束 → 永不触发。

**同时实测：** `GET /api/v1/history` 在每猫端口 **404**（该端点不在每猫 host 注册）。

| 面 | 修正 | 证据 |
|:--|:--|:--|
| 轮结束判据 | 主判据改 `event: sessionstate` 的 `runState` run→idle；加 5 秒兜底轮询（`keyinfo` 末尾出现「投递之后」的 roundsum 行即收尾） | `tools/probe-sse.mjs` 事件签名实测（`view \| renderType=（空） keys=v,state,persist,live`） |
| 渲染块来源 | `finishSession` 改拉 `keyinfo`（`itemsToBlocks` 把 role→renderType：user / reply→text / roundsum）；SSE 攒的块作回落 | 实测截图「3 块」= user + reply + roundsum ✅ |
| 分帧 | SSE 帧分隔兼容 CRLF（`/\r?\n\r?\n/`）——Kestrel 用 CRLF，原按 `'\n\n'` 切一帧都切不出来 | 代码 |
| 工作 / 待命判据 | `hasSession(row)` = `runState !== 'idle'` **或** `contextCount > 1`——有会话正文内容的猫不算待命 | 回执实测：「当前 majordomo 正在跑；rb，rc 有会话在手，其他 7 只猫待命中」 |
| 开场巡检 | 开启后自动对有会话的猫（按最近活跃排序，`navigator.tourLimit` 默认 3）截图最后一段会话发群 | activity 实测：majordomo / rc / rb 三张图均已发 ✅ |
| 可观测 | 活动流（环形 40 条）——订阅 / 事件 / 截图 / 发群 / 错误全留痕：日志 `[navigator] [kind] …` + `GET /api/nav/status` 的 `activity` + 界面「领航员活动」卡片 | 界面 + status 实测 ✅ |
| 诊断工具 | `tools/probe-sse.mjs`——打印前 8 帧的「事件名 / renderType / data 键 + data 原文」与事件签名统计 | 保留为常备诊断入口 |

**端到端实锤（2026-10-11 10:34）：** 投递 rf → `订阅 639270055721496090（端口 8092）` → `rf 截图完成（3 块）` → `已发图到群 1097492606`（全程 11 秒）✅

### 二十五·再补——持久观测 + 前文整理重启（2026-10-11）

> 触发：Rushiera 要求「有实际回复就截图发，没有例外」+「让领航员清理 majordomo 前文，收工整理含推 git，先拿 R喵喵 实验」。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 持久观测 | `armCat` / `armAll` / `disarmAll`——开启时对全部运行中的猫建立常驻订阅；`finishSession` 发完即推进观测点（增量取）；**宿主重启后由 `start()` 自动重建**（`enabled=true` 即 armAll） | 实测 `watching` 10 只 · 任何一轮回复都发群 · 重启后自动重建 ✅ |
| 开场全量 | `tourLimit=0`（不限）· `keyinfo?max=20`（较完整，含开场问候） | 实测「开场巡检：majordomo，rf，rc，rb（共 4 只有会话，全部）」+ 4 张图 ✅ |
| 前文整理重启 | `resetSession` + `POST /api/nav/reset` + 业务面工具 `nav_reset`——① 完整收工（落盘 + **推 git**）② 新会话 ③ 注入交接摘要 ④ 自动继续 | R喵喵 实测全链通过 ✅ |
| 教材 | `NAV_RULES` 补「前文整理重启」段 + 持久观测口径 | roleText 91388→91559 字符 ✅ |

**R喵喵 实测实锤（2026-10-11 10:47–10:51）：**

```
R喵喵：前文整理重启开始
R喵喵 截图完成（3 块）→ 已发图到群 1097492606     ← 摘要回复被持久观测捕获
R喵喵：交接摘要已取到（1140 字符）
R喵喵：新会话已请求（cmd-5 · frame 98557）
R喵喵：交接摘要已注入，等待确认
→ R喵喵 回复「接上了。前文面已注入…」（891 字符 · 172.9 秒 · 工具 13 次）
```

**顺带发现（非本功能缺陷）：** R喵喵 的 `enabledRoots` 仅 `[workspace]`、工具面无宿主管理组——它自报「CCBP 知识根不可达 + 管理工具面不在本会话」。属该猫配置面问题，待面板勾选。

### 二十六、领航员三改——延续性 / 会话分析 / 教材纠偏（2026-10-11）

> 触发：Rushiera 三条反馈——①「前文整理与预期结果并不完全相符，前文整理的重启结果应优先确保当前会话内容的延续性」②「不用每次都说已投给xxxx回复到了发群，而是静默执行，但是在60秒后进行一次领航员的 猫会话分析功能」③「少量缩减前文的效果就足够了，不需要那么彻底」。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 前文整理延续性 | `resetSession` 在清前文**之前**抓 `keyinfo`（`user` / `reply` / `roundsum`）成「原文轨迹」，与猫自述摘要一起注入新会话；材料落盘 `app/data/nav-reset-<key>-<时间戳>.md` | 代码 `app/src/navigator/index.js`（`traceText` / `resetSession`） |
| 条数口径 | `navigator.resetTraceLimit` 默认 100（0 = 不限）；单条回复截断 8000 字符 | `app/src/config.js` |
| 新会话就绪 | 固定等 8 秒 → 轮询 `keyinfo` 出现加载报告且条目数低于清前文前（`waitSessionReady`，上限 30 秒） | 同上 |
| 投递后会话分析 | `scheduleAnalysis` / `runAnalysis`——投递成功即排 `analyzeDelayMs`（默认 60 秒）；到点抓会话 → 截图 → 解读 → 发群 | 实测：11:12:38 投 rd → 日志「已排 60 秒后的猫会话分析」→ 11:13:43 群收「rd 当前会话分析」（三行闭环） |
| 教材纠偏 | `NAV_RULES`：①投递不许裁剪——一条消息混着给猫的和给 R喵 的，**整段原文照抄**（根因：R喵 把「告诉majordomo A，另外你以后 B」拆成 A 投递、B 自留）②投递类静默执行——不再回「已投给 X 了」③整理重启描述同步 | `tools/apply-qqagent-config.mjs`；刷新后 `roleTextChars` 91741 |

**实测事实（新）：** 猫的 `keyinfo` 条目**远少于**前文条数——majordomo 会话 `count=15`（加载报告 / 用户消息 / 回复 / 轮结算），前文大头是工具调用的过程记录。故「摘要 + 轨迹」是**压噪声、保语义**，非「全量搬运」。

**顺带发现（系统性）：** 10 只猫的 `injectList` 全部引用 `ccbp:` 路径，但除主干外 `enabledRoots` 都只有 `workspace`（rc / rd / re 为空）——同一缺陷。R喵喵 已补 `ccbp`（N7a），其余 8 只待定夺。

**待办（交接）：** ① `resetSession` 的提示词可改——建议把「收工报告」列为独立一步（先出报告再出摘要），Rushiera 2026-10-11 已授权 ② 该改动需重启生效 ③ 其余 8 只猫 `enabledRoots` 对齐待定 ④ N7 第二半（工具面无宿主管理组）处置待定 ⑤ N6 迁移待排期。

### 二十七、前文整理提示词改 + 全猫根对齐（2026-10-11）

> 触发：Rushiera 2026-10-11 授权「必要的话这个前文整理的提示词可以改」（N8）+ §二十六 待办 ③。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 提示词改（N8） | `resetSession` 首段把「收工报告」列为独立第 ③ 步（终态断言：完成项 / 落盘位置 / 遗留项去向，零疑问句），原摘要顺延为 ④；收尾行同步「①②③做完再输出摘要」 | `app/src/navigator/index.js` |
| 注入头同步 | 「【交接摘要·来自上一段会话】」→「【上一段会话的收工报告与交接摘要】」 | 同上 |
| 全猫根对齐 | 9 只猫 `enabledRoots`：空 / 仅 `workspace` → `workspace,ccbp`（与各自 `injectList` 的 `ccbp:` 引用一致）；主干不受影响 | `config-cat-set` 写后逐字段复核：rc / rd / re / rb / rf / R喵 / R喵喵 / R喵喵喵 / R喵喵喵喵 |
| nav_reset 真链路 | ✅ 通过——majordomo 整理（11:19:42）：材料落盘 `app/data/nav-reset-majordomo-2026-10-11T03-19-42-027Z.md`（摘要段含**收工报告** + 原文轨迹段），新会话据此接上并继续 | 材料三段齐备 + 前文实况 |

**N7 遗留处置（定案）：** 工具面「宿主管理组」保持不可配——`majordomo-*` / `config-*` 为特权组，非主干会话恒剔除（`design-ch4-tools` §三·十）；猫读前文面的 CatHome Job 产生期待属正常，功能无缺。不摘 `ccbp:L2/Job/CatHome`。

**自测：** `tools/verify-navigator.mjs` 17/17（提示词改动不影响断言）。

### 二十八、猫会话分析升为独立功能 + 播报分流（2026-10-11）

> 触发：Rushiera ①「刚刚发布清理指令的时候 会话分析功能没有在群里给我反馈……我希望领航员是能得出现在做到哪里了，什么情况，发现，预计做完还要多久，有回复了回复截图发群，没回复应该能自己大概猜一下还要多久然后帮我跟（@我）」②「不仅仅是清理指令 会话分析是领航员的另一个功能 仅仅是因为当下只有发布指令后 60 秒这一个入口而已 不排除以后会加」③「不是实际的回复的话并不需要截图 截图也应该截的是回复内容」。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 清理指令无反馈（根因） | `scheduleAnalysis` 原先只在领航员 `send()` 里调用——`resetSession` 走的是 `ch4.send`，绕过了排程 | 代码对照 |
| 独立功能化 | 核心 = `scheduleAnalysis`（排队，带 `delayMs` / `reason`）+ `runAnalysis`（执行）+ `analyzeOnce`（对外入口）；入口三处：投递后 60 秒 / 整理重启后 / `POST /api/nav/analyze` | `app/src/navigator/index.js` |
| 播报分流 | 未回复 → 纯文字（事实行 + 判读）+ **@ 触发者**（`sayAt` 新增 at 段）；已回复 → 只截**最后一条回复**及其后轮结算（`replyBlocksOf`） | 同上 |
| 判读走带图模式 | 该模型（`hy4-preview-f`）对长中文纯文本提示词只产 `reasoning_content`、`content` 恒空——`max_tokens` 2000 / 4000 实测皆空；带图则正常。故判读统一走 `shot.analyze`（图只作输入，不发群） | 探针实测 `CatTemp/probe-progress-prompt.mjs` |
| 可观测性 | `sayAt` 发群日志记完整内容（换行转分隔符、截 300 字符）——原先只记首行，多行播报看不见 | 同上 |

**真链路：** 11:37 手动触发 → 日志「截图完成」+「已发群 1097492606（@569145850）」+ napcat 发送回执（群里可见 @Rushiera）✅

**收尾：** 探针脚本归 `CatTemp/`，收工清理。

### 二十九、出站决策层（2026-10-11）

> 触发：Rushiera「回复响应事件不要直接想都不想推领航员发群，而是先给领航员 让领航员决定发什么内容，相当于中间加一层，领航员如果没有拿到信息静默即可，拿到了也可以选择直接发或者看看要不要整理 因为后续还需要兼容多猫运行这种多会话模式 信息要恰好属于人能看而且不会感到烦的程度」+「整理重启后不需要新补一层，如果 60 秒内已经做完收工报告了那么直接发回复就可以了不需要再另外回这样消息太多」。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 决策层 | 新增 `emitOutbound({ key, chat, trigger, items, reason })`——**所有发群都先过它** | `app/src/navigator/index.js` |
| 决策规则 | ① 有新回复（自上次出站以来）→ 截图（只截回复）② 无新回复 + 检查点 + 还在跑 + 冷却已过 → 文字播报 + @ ③ 其余 → **静默** | 同上 |
| 轮结束并入 | `finishSession` 从「渲染截图 → 解读 → 发群」改为「拉条目 → 交决策层」——不再无条件发 | 同上 |
| 整理不再另发 | 去掉 `resetSession` 的「整理重启完成」通知——猫的回复即反馈 | 同上 |
| 出站基线 | `armCat` 时记「当前最后一条回复」为基线——重启后不把历史回复当新回复重发 | 同上 |
| 冷却 | `PROGRESS_COOLDOWN_MS` 默认 3 分钟（同一只猫两次播报的最小间隔） | 同上 |

**真链路：** 空闲猫（R喵喵喵）→ 日志「已停且无新回复，静默」（不发群）；在跑猫（majordomo）→ 「进度播报已发群（@触发者）」✅

**设计意图：** 为多猫 / 多会话并行做准备——信息量控制在「人能看且不烦」的档位（同一猫不重复、未回复才播报、有回复只发回复）。

### 三十、空闲计时 / 开工分流 / 退出与领航记录（2026-10-11）

> 触发：Rushiera「刚刚他自己把领航员关了，这个你也检查下，你这不刚收工怎么可能有 30 分钟」+「如果是软件内开启的领航员模式，不是群里开启的，不用往群里发，只有 @ 群开启的领航员需要发开工报告」+「有回复的话这个时间应该自动归 0 除非是完全没有回复的空闲，而不是从开工开始」+「@bot 可以退出领航员模式了 那就回到闲聊状态」+「无论是超时自己关 还是我触发退出领航员 都要有这样的领航记录」。

| 面 | 实现 | 证据 |
|:--|:--|:--|
| 空闲计时（bug） | 原基准 = `lastCommandAt`（最后一条指令）→ 11:25 投递后 30 分钟即判空闲；重开后 55 秒又被判（基准没变）。改为 `lastActivityAt`——指令 / 轮结束（`finishSession` 里 `state.touch()`）/ 开启都刷新 | 日志 2776 / 2830 两次「全猫停工且无指令超时」 |
| 开工分流 | `open()` 的开工报告与开场巡检只在 `by === 'qq'` 时发群；软件内开启静默 | `app/src/navigator/index.js` |
| 退出领航员 | 教材（`NAV_RULES`）加「退出」语义：@ 说「可以退出领航员模式了」→ `nav_close` → 回到闲聊状态 | `tools/apply-qqagent-config.mjs`（roleTextChars 91896） |
| 领航记录 | `buildVoyageLog`——开启 → 关闭时长 / 来源 / 指令数 / 回复截图 / 进度播报 / 开场巡检；落盘 `app/data/nav-log-*.md`；**群内开启的场次发群**（超时自关与主动退出都发） | 同上 |

**设计口径：** 领航员的对外可见度由**开启来源**决定——群内 @ 开启 = 全程可见（开工报告 / 回复截图 / 播报 / 领航记录）；软件内开启 = 只在应用内可见，不打扰群。

**本轮领航实录（2026-10-11）：** 群内 @ 开启 → 指挥猫群；全程 v0.33 → v0.40 八轮迭代；真链路验收点：R喵喵 整理重启全链、rd 投递后 60 秒分析、在跑猫播报 + @、空闲猫静默。收工报告已发群。

### 三十一、领航员开启幂等 + 新会话轻通道（2026-10-11）

> 触发：Rushiera——「我只开了一次领航员，然后发布了『清掉 R喵喵，rb，rc，rd，rf 的会话，直接开新会话即可』的指令，然后他就又开启了一次领航员给我把所有会话又发了一遍——后续如果已经是领航员就不要再发了；另外清理会话就不是清理前文并重建了，直接发布 /new 即可」。

**存档取证（`app/data/logs/2026-10-11.log` + `_unpack/data/sessions/`）：**

| 时刻 | 事实 |
|:--|:--|
| 12:25:47 | VIP 群 @「开启领航员模式」→ 12:26:00 开启（来源 qq）→ 开工报告 + 开场巡检（6 张会话卡） |
| 12:27:46 | VIP 群 @「清掉R喵喵，rb，rc，rd，rf的会话，直接开新会话即可」 |
| 12:28:10 | **领航员已开启（来源 qq）again** → 开工报告 + 开场巡检又发一遍（同 6 张） ← 报的问题 |
| 12:28:23 | 5 只猫各被投一条「领航员·前文整理」完整收工提示 |
| 12:32:24 | 5 条「交接摘要未取到，整理中止」（各自白等 240 秒） |

**根因（两条，业务面推理原文可查）：**

| # | 根因 | 证据 |
|:--:|:--|:--|
| 1 | **`open()` 无幂等**——不管是否已开启，一律重跑健康检查 → 发开工报告 → 开场巡检；教材也只教了「@ + 开启关键词 → nav_open」，没教「已经是领航员就别再开」 | `mv3bqwru-bc32b3e4.json`：R喵 推理「先 nav_open，然后并行 nav_reset 五只」→ 12:28:10 二次开启 |
| 2 | **没有「新会话」轻通道**——工具面只有 `nav_reset`（重流程），「清掉会话」无处可落 | `mv3bo7pq-150cdc5f.json`：「There's no nav_new. nav_reset is the only one.」/「工具里没有 nav_new_session 之类」→ 拿重流程顶，5 只空会话的猫全部超时 |

**改动：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 开启幂等 | `app/src/navigator/index.js` `open()` | 已开启 → 只刷新回消息群 + `touch()` + 活动流留痕，返回 `{ ok, alreadyOpen: true }`；**不**跑 health / 回执 / 开场巡检 / armAll |
| 新会话 | `app/src/navigator/index.js` `newSession({ keys })` + `POST /api/nav/new-session` | 逐猫发布 `/new`（`cat.new-session <key>`）；key 支持数组或逗号 / 顿号 / 空格分隔；静默（只记指令流水 + 活动流） |
| 业务面工具 | `tools/navigator/nav-tools.js` | 新增 `nav_new`（工具组 6→7 件）；`nav_open` / `nav_reset` 描述各补一句（幂等 / 界线） |
| 教材 | `tools/apply-qqagent-config.mjs` `NAV_RULES` | 新增「清理会话（开新会话）」段（`nav_new` + 「别拿 nav_reset 顶这一档」）；「开关」段加「已经是领航员时不要再调 nav_open」 |
| 自测 | `tools/verify-navigator.mjs` | 新增 4 条断言（首次开启 / 重复开启幂等且零发群 / 新会话通道可用 / 空目标报错退出） |

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 自测 | `node tools/verify-navigator.mjs` → **21/21 通过**（含「编排·重复开启幂等（不重发）— 发群次数 0」） |
| 业务面落盘 | `node tools/patch-qqagent-navigator.mjs` → `src/nav-tools.js` **updated**（其余 5 点 skipped）；`nav_new` 已进 `_unpack/resources/app/src/nav-tools.js` |
| 教材落盘 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 91896 → **92243**（apiKeyLen 0 = 密钥面未动）；`_unpack/data/config.json` 已含 `nav_new` 段 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 自研单体（`app/`）改动需**重启 QQBotB 应用**；教材（`config.json` 的 roleText）需**业务面开新会话**才进提示词——两者均由主理方发起，本轮不代起进程 |
| 2 | `nav_new` 真链路 | 待验——需群里 @ 一次「清掉 X 的会话」；通道 `cat.new-session` 本身已在 §二十五 / §二十七 真链路验证过 |
| 3 | `resetSession` 空会话白等 | 观察项——猫 `contextCount ≤ 1` 时仍会跑满 240 秒等待；本轮未改（新通道已让这一档不再走重流程），若再现则加「空会话直接拒绝」前置判据 |

---

## 三十二、记忆回溯点 + 领航场次沉淀（2026-10-11）

> 来源：Rushiera 2026-10-11——「这个群里存档的记录，多拉一点直接拉到开启领航员开始，因为退出领航员是体面退出，R喵还是要知道自己在那段时间做过的事情了」→「ab 都要」。
> 设计：`design-qqbotb-memory.md` §3.8 / §3.9 · `design-qqbotb-navigator.md` §十五。

### A · 存量整理（群 1097492606）

群记 `_group.json` 补 5 条领航员段落 + 修正 1 条过时条目（备份 `WorkSpace:CatTemp/QQBotB-群记备份-20261011/`）：

| # | kind | 内容要点 |
|:--:|:--|:--|
| 1 | project | 领航员模式 2026-10-11 首次实跑（10:20 开启 → 12:12 退出，投递 5 条给 majordomo） |
| 2 | rule | 投递类指令静默执行（旧口径「已投给 X 了」作废） |
| 3 | project | 前文整理重启（nav_reset）已跑通 |
| 4 | rule | 领航员出站由自研单体直发，我这边没有撤回通道 |
| 5 | lore | 「领航员」= 我的工作模式（不是新人格）；退出是体面退出，经历要留记忆 |

修正：原条目「2026-10-10 他把 qqagent 壳的前文去掉了」——复核后前文（CCBP L0/L1/L2）**已回到壳里**，工具面仍无 CCBP 通道；改写为现状描述。

### B · 机制（回溯点 + 自动沉淀）

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 回溯点载体 | `_unpack/resources/app/src/session-state.js` | `getSessionState` 增 `memoryFloorTs`；新增 `setMemoryFloor(chatKey, at)`；`sessionWindowStart(chatKey, { reach })` 取 `min(会话起点, 回溯点)` |
| 收工轮取材 | `orchestrator.js` | `isRollover` 先算 → `sessionWindowStart(chatKey, { reach: isRollover })`；`#completeRollover` 末尾 `setMemoryFloor(chatKey, 0)` |
| 回溯点置位 | `nav-tools.js`（业务面 `nav_open`） | 开启成功后读 `/api/nav/status` 取 `activeChat` → `setMemoryFloor('group:<群号>', Date.now())`；读不到回消息群时回执明示「未置位」 |
| 场次沉淀 | `app/src/navigator/index.js` | 新增 `loadBizPort()`（读业务面 `data/config.json` 的 `server.port`，从该值起探测 10 个端口）与 `sedimentVoyage(chat, text)`；`buildVoyageLog()` 增 `brief` 字段；`close()` 内两条关闭路径共用一次沉淀 |
| 沉淀落点 | 业务面记忆 API | `POST http://127.0.0.1:<port>/api/memory-files/group_<群号>/group` `{kind:'project', content}` |

**补丁点（幂等可重放）**：`patch-qqagent-session.mjs` 新增 5 点——`memory-reach-state` / `memory-reach` / `memory-reach-import` / `memory-reach-window` / `memory-reach-clear`；`nav-tools.js` 正文以 `tools/navigator/nav-tools.js` 为准（copyModule 按内容比对）。

**实测口径（2026-10-11）**：

| 项 | 结果 |
|:--|:--|
| `node --check` 四文件（session-state / orchestrator / nav-tools / navigator-index） | 全过（exit 0） |
| `node tools/verify-qqagent-memory-reach.mjs` | **13/13 PASS**（置位 / 落盘 / 回溯三种边界 / 清零 / 群记截断与去重 / 两补丁 --dry 全 skipped） |
| `patch-qqagent-session.mjs --dry` | 40 点全 skipped（0 applied）——含新增 5 点 |
| `patch-qqagent-navigator.mjs --dry` | 6 点全 skipped（0 applied） |

**遗留（当期未清）**：

1. **群记去重对尾随空白失配**——`group-memory.js` 的 `appendGroupEntry` 用未 trim 的 `c` 做比较，而落盘侧 `normalizeEntry` 会再 trim 一次 → 内容带尾随空白时同一条会重复写。影响面小（写入面极少带尾随空白），记档待清。
2. **真链路未验**——两条改动都要重启业务面（QQ Agent）才生效：`nav_open` 置位、关闭沉淀、收工轮回溯三处需在真群各跑一次。
3. **空闲自关的场次沉淀**依赖业务面记忆 API 可达；业务面没在跑时只留痕（活动流 `[error]`），不阻断关闭。

---

## 三十三、未回复诊断（2026-10-11 · 未修，待 Rushiera 定夺）

**现象**：群 1097492606 · 12:17:56 一轮（run `mv3bbk8b-2d1b6e75`）状态 `noreply`——模型**产出了回复正文**（「R喵。鲸鱼娘那挂正主。退领航员 ≠ 丢记忆…」56 tokens），但 `sent: []`，群里什么都没收到；Rushiera 因此连问两条（12:16 那两条）。

**根因链**（两条独立）：

1. **正文按设计不发**——该壳的普通文本输出**不发 QQ**，只有 `send_message` 工具调用才发（引导说明明写）。这一轮模型把要说的话写在了正文里、没调 `send_message`。
2. **安全网没有实现方**——`src/reply-rescue.js` 正是为「写在正文里、没发出去」的成稿准备的，但它的四级判定全部走能力缝 `cap('reply.loose-send')` / `reply.salvage-lines` / `reply.salvage` / `reply.grounded-select`；全仓搜索只有**消费方**（`reply-rescue.js` 自身），**没有实现方**（插件 / skill 注册）→ `cap()` 恒返回空 → 函数在第二步直接 `return []`。这轮什么都没救回来。

**建议修法（未实施）**：把 `reply.loose-send` 的正则级实现落到壳内（判据：正文非计划腔 + 含成句中文 + 与触发消息有语义关联 → 抽成一条 `send_message`），并让 `cap()` 缺失时**出声**（`logger.error`）而不是静默返回空——现在「能力缝没人装」在运行详情里完全看不出来。

**为什么本轮未修**：改动落在发送链路（壳里**最可能造成事故**的一环——判错就是把内心戏发进群），且本轮 Rushiera 只点了 A / B 两件；按「两个以上合理方案列选项等拍板」处理，先诊断落档。

---

## 三十四、回复卡对齐 CH4 会话页（2026-10-11 · v0.33）

**缘起**：Rushiera 群内定——领航员发群的截图，猫娘回复的样式要与 CH4 内置会话页（chat.html）一致（群里先有「你这 md 渲染都没有也太丑了」的反馈）。

**做法：三件同源**（不做近似，直接取 CH4 前端原件）：

| 件 | 落点 | 来源 |
|:--|:--|:--|
| 样式表 | `app/src/navigator/chat-card.css` | CH4 `/css/tokens.css`（全文）+ `/css/chat.css`（L2 令牌 · 滚动条 · 行与气泡 · roundsum · md-block 摘取） |
| MD 渲染器 | `app/src/navigator/md.js` | CH4 `/js/chat/lib/md.js`（副本 + 末尾 `export { mdToHtml }`） |
| 内容字体 | `app/src/navigator/fonts/SarasaMonoSC-Regular.ttf` | CH4 `/fonts/SarasaMonoSC-Regular.ttf`（24.4 MB · 随仓库入库） |

**渲染改动**（`app/src/navigator/shot.js`）：

- `renderCard` 输出 CH4 会话区 DOM：`#chatbar`（猫名 + 时间）· `.chat-row.user > .chat-bubble` · `.chat-row.assistant[data-type=text] > .chat-bubble > .md-block` · `.chat-row.assistant[data-type=roundsum] > .chat-bubble.roundsum`
- 回复正文走 `mdToHtml`——表格 / 代码块 / 列表 / 引用 / 标题 / 行内码全渲染
- 样式内联进 HTML（离屏窗口 `loadFile` 零外链）；`@font-face` 的相对路径在卡片侧解析不到 → 载入时改写为绝对 `file://` URL
- `main.js` 截图高度改取 `body.getBoundingClientRect().height`（原 `scrollHeight` 在内容不足时取视口高 → 底部大片空白）

**实测口径**（真链路，重启后）：`POST /api/nav/shot`（blocks = user + 含表格/代码块/引用的回复 + roundsum）→ 产物 `app/data/nav-shot-2026-10-11T05-08-22-748Z.png`：卡高贴合内容 · 气泡底 `#1a1a1a` / 用户泡 `#0e639c` · 描边米白 20% · radius 8px · 正文 14px · 等宽字体生效 ✅；与 CH4 页（8081）计算样式逐项比对一致 ✅。

**已知差异（数据不足，非样式差异）**：CH4 页的轮末结算是 `rs-*` 四段分片（📊 Round / 🎯 命中率 / Tool·Api·All / 四态用时）；卡片侧只有 `keyinfo` 的单行摘要原文，按 `.chat-bubble.roundsum` 单行渲染。

**同步约定**：CH4 前端改样式或渲染器后，重新摘取上面三件覆盖（`chat-card.css` 整块替换 · `md.js` 除末尾导出行外原样覆盖）。


---

## 三十五、投递去来源头（2026-10-11 · v0.44）

**缘起**：Rushiera 群内定——「转发的消息自己知道渠道就可以了，不用特地加个 `[来自QQ][群@|Rushiera(群主)·本人]` 污染会话前文，而且我也不是所有群都是群主，这会影响领航员的判断（@我/提到我）」。

**两条理由**：① 该前缀进猫的会话前文——每条指令都多一段噪声；② 角色写死「群主」是错的——Rushiera 并非所有群都是群主，错标角色会误导领航员与猫的判断。

**改动**：

| 落点 | 改动 |
|:--|:--|
| `app/src/navigator/index.js` | `send()` 的 `sourceTag` 默认 `true` → **false**；`POST /api/nav/send` 的判定 `!== false` → `=== true`；保留标签形态但去掉角色（`(群主)` 删掉——只留 `[来自QQ][群@|Rushiera·本人]`，且仅显式要求时才加） |
| `tools/navigator/nav-tools.js` | `nav_send` 描述改「猫那边看到的就是这条原文——系统不再加 [来自QQ]… 来源头，渠道由投递通道自身承载」；`text` 口径追加「不要带触发标记（如「（@我/提到我）」这类是给判断用的，不是指令内容）」 |
| `tools/apply-qqagent-config.mjs` | 领航员教材「怎么做」段同步——投递不加来源头；新增一条：消息末尾的「（@我/提到我）」类触发标记投递时去掉 |
| `design-qqbotb-navigator.md` §五 | 投递语义改写（原「按 CH4 现行 QQ 转发口径加来源头」→ 现「原文照抄，不加来源头」）+ 两条理由 |

**生效链**：自研单体改码 → 重启单体（`启动QQBotB.bat`）→ 补丁 `patch-qqagent-navigator.mjs` 重跑（业务面工具描述同步）→ `apply-qqagent-config.mjs --roletext-only`（前文教材同步）。

**真链路实锤**：`POST /api/nav/send` 投主干（自测句）→ `GET 8081/api/v1/keyinfo?max=1` 取末条 user：`len=29 · hasQQtag=false · hasRole=false`（无来源头、无角色标注）。

**遗留**：业务面 R喵 仍会把「（@我/提到我）」触发标记当指令内容整段投递——教材已加禁令，需下一轮会话（新前文生效后）观察是否收敛。

---

## 三十六、回执只读 + 会话分析直接读 think（2026-10-11）

> 触发：Rushiera 2026-10-11（群 689942975 · 12:56）——「让R喵喵喵喵开工qqbotB，我想要回执的意思就是想要那个会话分析，包括我想看一下各单位运行情况，这些都是领航员功能，而不应该给他们发消息让他们有实际回复，另外会话分析我的要求是直接读think的」。
> 设计：`design-qqbotb-navigator.md` §十六。

**背景（前一轮做反了）：** 12:53 前后「回报当前回执：你在做什么、做到哪、有没有卡点」被当指令投递到 3 只猫（majordomo / R喵喵 / R喵喵喵）——既拿不到分析，还往各自前文各堆一条（majordomo 当时 325k）。

| 面 | 落点 | 说明 |
|:--|:--|:--|
| think 采集 | `app/src/navigator/index.js` | 新增 `collectThink`——view 事件两态都认（`persist.items[]` / 顶层 `renderType`）；`reason` 正文去重入环形（`THINK_KEEP` 200 条/猫） |
| think 出口 | 同上 | 新增 `thinkText(key)`——取最近 3 条、上限 1200 字符 |
| 会话分析 | 同上 `emitOutbound` ② | 有 think → 直接贴「它现在在想：…」；无 think → 回落截图 + 判读 |
| 只读工具 | `tools/navigator/nav-tools.js` | 新增 `nav_health` / `nav_analyze`（工具组 7→9 件） |
| 教材 | `tools/apply-qqagent-config.mjs` | `NAV_RULES` 新增「回执 / 看运行情况（只读——不派活）」段 |
| 自测 | `tools/verify-navigator.mjs` | 新增 4 条（观测建立 / think 收集去重 / 直接读 / 非 reason 不入） |

**根因（为什么读不到 think）：** `onCatEvent` 原判据「无顶层 renderType 即早退」——而每猫端口推的是视图状态 `{v, state, persist:{items[]}, live}`，渲染块一直在 `persist.items[]` 里（实测 6 秒样本：reason 34 条 / toolcard 55 条 / user 3 条 / inject_report 1 条）。

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 自测 | `node tools/verify-navigator.mjs` → **25/25 通过**（21 → 25，含 think 收集去重 / 直接读回 / 非 reason 不入） |
| 业务面落盘 | `node tools/patch-qqagent-navigator.mjs` → `src/nav-tools.js` **updated**（其余 5 点 skipped） |
| 教材落盘 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 92243 → **92862** |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 自研单体（`app/`）改动需**重启 QQBotB 应用**；教材（`config.json` 的 roleText）需**业务面开新会话**——两者均由主理方发起，本轮不代起进程 |
| 2 | 真链路 | 待验——群里 @ 一次「回执」/「各单位运行情况」，确认走只读且群内收到 think 播报（不再有投递） |
