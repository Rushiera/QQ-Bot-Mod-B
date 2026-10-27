# QQBot mod B — 兑现明细（M1 通道实测）

> 关联设计：`design-qqbotb.md` · 状态标记：✅ 已兑现 / ⏳ 进行中 / ⬜ 未开始
> 定位：本设计下辖模块的兑现明细——证据的唯一承载处（参数 / 实测口径 / 日期）。

---

## 未闭合项

| 项 | 说明 | 状态 |
|:--|:--|:--|
| 协议端 WebUI 监听面 | 现监听 `::`（全网卡）——建议收窄至 `127.0.0.1`；属协议端自身配置，待 Rushiera 定 | ⏳ 待定 |
| 日志时间戳对齐 | 日志页协议端行的外层时间戳为**转发时刻**（同批历史日志挤同一秒）；原始时间在行内——可按原行时间戳对齐 | ⏳ 待定 |
| 群 361820329 静默不回 | ✅ 已闭合（2026-10-14）——清会话恢复（20:51 实测恢复发言）+ 轮转阈值 300000→160000 + 端点降级守卫（补丁点 `degrade-guard`）；诊断见 §五十二 · 修复见 §五十五 | ✅ 已闭合 |
| 领航员会话截图群内实测 | v0.66「截全」+ `nav_shot`——自测 51/51 · 业务面 10/10 · 单体真实出图已验（含 24691px 超长卡）；**群内真发群**（R喵 调 `nav_shot` 回群）待群内 @ 触发（§五十六） | ⏳ 待实测 |
| 群内生成能力真实群触发 | v0.79 MOSS 生图 / IrodoriTTS 语音 / WD Tagger 反推——守门 8/8 + live 三项各 10/10（mock 出站）；**真实群 @ 触发**（业务面判断 → 工具 → 单体 → ComfyDock → 产物回群）待重启后实测（§六十七） | ⏳ 待实测 |

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
| 2 | ~~ComfyDock 健康检查显示「离线」~~ **已修（v0.51）**——根因不是「服务没跑」，是**探针判据错**：URL 指面板首页（`text/html` 62592 B），`fetchJson` 要求 JSON 响应，`JSON.parse` 必失败 → 恒判离线，与 ComfyDock 是否在跑无关 | 修法：URL 改 `http://127.0.0.1:8971/api/summary`（ComfyDock **v0.24** 新增）+ `kind='comfydock'` 回执文案「在线（合计剩余 700 · 重置时刻已过）」；实测 `/api/nav/health` → `ComfyDock online=true`；群 689942975 已发状态一条（日志 6251 行） |
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

**补（同日）· 图中图渲染**：气泡里的 `[image-open]` 包裹原先按纯文本落进卡片（回复里的图变成一串路径文本）。`renderCard` 现按 L1/Discipline §九 解析包裹（条目行 `图片N-k：路径`，全角冒号、路径取到行尾），渲染为 CH4 同款 `.chat-imgs > figure.chat-img > a > img` + `figcaption`；路径经 `pathToFileURL` 转绝对 `file://` URL（http(s) / file 原样；相对路径与受控根寻址落 `.chat-img.missing` 占位）。样式块同步摘入 `chat-card.css`（§5 图片附件 · 源 chat.css 行 411–421）。真链路实测：`app/data/nav-shot-2026-10-11T05-21-01-238Z.png` ✅


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

---

## 三十七、投递闸门 + 干跑自测（2026-10-11）

> 触发：Rushiera 2026-10-11（群 689942975 场次之后 · 应用内开启领航员时）——「他好像给你发了一个不该发的信息，一并修」。
> 设计：`design-qqbotb-navigator.md` §五（投递语义）。

**现象：** majordomo（主干）会话前文落进一条乱码消息 `??:??????????--??????,???????`——13:08:21 投递、13:09:21 触发「投递后 60 秒」分析、13:09:29 播报进群。

**根因（三层）：**

| 层 | 事实 |
|:--|:--|
| 谁发的 | 工单 #1353（`Data:runs/20261011_090412/oa_all.txt`）：catId `639260183838960935`（R喵喵喵）走 `powershell` 手工 `Invoke-RestMethod -Uri http://127.0.0.1:3280/api/nav/send -Body '{"key":"majordomo","text":"自测：领航员投递不加来源头——回一句「收到，无来源头」即可"}'`——为验证 v0.44「投递去来源头」做自测 |
| 为什么乱码 | 手工拼 HTTP 体绕开了工具面；PowerShell 5.1 的 `Invoke-RestMethod` 在 `-ContentType` 不带 charset 时按 ASCII 编码正文（全角→半角最佳拟合、其余→`?`），整段中文变 `?` |
| 为什么落得进去 | ① `/api/nav/send` 没有自测通道——验「投递口径」只能真投递；② 投递不看场次：**领航员当时是关闭的**（13:00:47 手动退出，13:09:19 才应用内开启），关闭态照样受理并投进真猫的会话前文 |

**改动：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 干跑 | `app/src/navigator/index.js` `send()` | 新增 `dryRun`——只组装与校验，**不投递 / 不记账 / 不排分析**，返回将要投递的正文（自测投递口径用） |
| 投递闸门 | 同上 | 领航员**未开启时不受理**投递（回 `ok:false` + `offMode`，活动流记 error）——不在场就没有「指令」语境；不受理必须出声（AGENTS §一-4） |
| API | 同上 `POST /api/nav/send` | 透传 `dryRun` |

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 语法 | `node --check app/src/navigator/index.js` → 退出 0 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 改动在自研单体内——需**重启 QQBotB 应用**才生效（主理方发起） |
| 2 | 真链路 | 待验——关闭态 `POST /api/nav/send` 应回 `offMode`；`dryRun:true` 应只回正文、不落猫前文 |
| 3 | 教材 | `nav_send` 工具描述与教材未提干跑通道（不影响正确性——教材已写「未开启时按普通参与回」）；要补则重跑 `patch-qqagent-navigator.mjs` + `apply-qqagent-config.mjs --roletext-only` + 业务面开新会话 |

---

## 三十八、教材三修 + 领航员收工报告模板（2026-10-11）

> 触发：Rushiera 2026-10-11（群 689942975 · 13:45–13:50）——「我在群里问他 @Shieraru 看下majordomo在干什么 但是他还是没有给我会话分析也貌似没看你的think」「甚至他给我了这样的误回复」「小，改教材，教会领航员即可 包括领航员退出的时候的领航员收工 那也是领航员功能 跟mau没关系」。
> 设计：`design-qqbotb-navigator.md` §八（教材）。

**现象：** 群内 @「看下majordomo在干什么」→ 既没有会话分析、也没有 think 播报；回复还给了一个错误结论（「最近一条用户消息还停在 12:59」「13:42 那句没到它手上」）。

**根因（三条）：**

| # | 缺陷 | 证据 |
|:--:|:--|:--|
| 1 | **工具选错**——整轮只调了 `nav_detail`，没调 `nav_analyze`，于是没有 think 播报（会话分析是 `nav_analyze` 的出口） | 业务面会话 `_unpack/data/sessions/mv3efjzx-a39c4a50.json`：唯一工具调用 `nav_detail(key=majordomo)`，随后直接 `send_message` 自己组织答案 |
| 2 | **数据源**——`nav_detail` 的「最近用户消息 / 最近回复」取自**归档档**：会话 13:03:18 轮转后回落读 `Data/sessions_old/majordomo_20261011_130318.md`，把归档末条当成「最近」 | 直调 `GET http://127.0.0.1:8080/api/v1/cat-detail?cat=majordomo` → `lastUser {text=收工, source=archive, timeText=10-11 12:59:27}` · `lastReply {source=archive, timeText=10-11 13:02:40}` · `archive.file=majordomo_20261011_130318.md`（区间 12:20:44 ~ 13:02:40） |
| 3 | **场次误判**——它自己在 13:00 关过领航员，13:09 应用内重开后不知道，也没按教材先查 `nav_status` | 同上会话的 reasoning 段 |

**事实纠正：** 13:42 那句**已投递**——`app/data/logs/2026-10-11.log` 记 `已投递主干（端口 8081）：其他几只猫的任务均已完工`（13:42:53），且该条确实进入主干前文（主干本轮的开工输入即它）。

**改动（只改教材，不动代码）：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 看猫在干什么 | `tools/apply-qqagent-config.mjs` `NAV_RULES` | 明确指到 `nav_analyze(key)`（读 think、系统发群播报 + @）；`nav_detail` / `nav_status` 只用来补前文规模 / 运行态这类数字 |
| 归档档红线 | 同上 | `nav_detail` 的最近消息可能来自 `sessions_old/`（回执带 `source=archive`）——不许据此断言「某条消息没到猫手上」 |
| 场次收尾 | 同上（新增段） | 退出领航员时由领航员发「【领航员模式 · 收工报告】」：时间 / 做了什么 / 修掉的问题 / 验证 / 落盘；素材只取真实读到过的；空闲自关那一档由系统「领航记录」兜底 |
| 回话口径 | 同上 | 「猫在忙」一条的素材来源改指 `nav_analyze` 的 think 播报 |

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 语法 | `node --check tools/apply-qqagent-config.mjs` → 退出 0 |
| 教材落盘 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 92862 → **93628** |
| 读回复核 | `_unpack/data/config.json` 命中「场次收尾：领航员收工报告」与「`source=archive`」两条 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 教材已落 `config.json` 的 `roleText`——**业务面开新会话**才读得到（主理方发起） |
| 2 | 真链路 | 待验——群里 @「看下 X 在干什么」应走 `nav_analyze` 出 think 播报；@「退出领航员」应多一份领航员收工报告 |
| 3 | 渲染面 | `nav_detail` 回执仍不显式标 `source`（本轮按「只改教材」执行）——要标则改 `tools/navigator/nav-tools.js` |
| 4 | CH4 侧 | `cat-detail` 归档后回落读 `sessions_old/` 的语义归 `Project/CH4`（本仓不改） |

---

## 三十九、教材补两条 + 口径不渗人格（2026-10-11）

> 触发：Rushiera 2026-10-11（群 689942975 · 14:11–14:2x）——「我在群里@他并发了让majordomo收工 但是他却回了一个[图片] 也不知道是什么」「他好像不知道领航员现在开着」「自己的软件内的信息自己肯定要看」「另外你本次口径的修改我不希望让群里的bot整个性格都变了」。
> 设计：`design-qqbotb-navigator.md` §八（教材）· §十七（整理口径）。

**现象与根因：**

| # | 现象 | 根因 |
|:--:|:--|:--|
| 1 | @「让majordomo收工」被判「不能投」——答「领航员 13:00 就退了，得先 @ 我开」 | 它按**自己记忆里的那次关闭**（13:00 `nav_close`）作答；**软件内 13:09 的开启不给它任何通知**，教材原句「软件内开关的领航员不发群——那种场次你也不用管」反被读成「不用管」——开关状态缺「以实况为准」的硬口径（当时领航员是开着的；同轮 13:37 / 13:41 / 13:42 的指令实际都投出去了） |
| 2 | 回了一条自己也说不清的 `[图片]` | 业务面会话 `_unpack/data/sessions/mv3fgadg-5bccb239.json`：本轮 `send_image` 记**失败**，但 14:12:21 群里确有图（app 日志无 navigator `已发图到群` 行 → 非领航员出站）；教材缺「发之前先确认发的是什么」 |
| 3 | 口径外溢风险 | 新条款若写成长篇制度腔（🔴 不许… + 判例引述），会把「群友 R喵」带成「客服 / 助手」 |

**改动（只改教材 + 设计口径）：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 开关看实况 | `tools/apply-qqagent-config.mjs` `NAV_RULES`「开关」段 | 「🔴 开关状态看实况，不凭印象」——`nav_status` 回执即唯一真相；软件内开的场次不通知你；拿不准先查一次，查不到就说查不到 |
| 发图先确认 | 同上「回话口径」段 | 发图 / 发文件前先确认它是什么，说不清的别发；`send_image` 回失败就是没发出去 |
| 口径不渗人格 | 同上 + `design-qqbotb-navigator.md` §十七 | 两条都收在「领航员模式」段内、去掉判例引述与制度腔；「场次收尾」段加限定「只在退出领航员那一下用——平时闲聊不写报告、不摆汇报体」；§十七 增「**人格不动**」硬约束 |

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 语法 | `node --check tools/apply-qqagent-config.mjs` → 退出 0 |
| 教材落盘 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 93628 → **93785** |
| 读回复核 | `_unpack/data/config.json` 命中「开关状态看实况」 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 教材已落 `config.json` 的 `roleText`——**业务面开新会话**才读得到 |
| 2 | 真链路 | 待验——领航员开着时 @「让majordomo收工」应正常投递 |
| 3 | `[图片]` 未完全坐实 | 会话记 `send_image` 失败、群里却有图——来源待查（候选：重试成功 / 复用了触发消息附图） |
| 4 | 开关通知缺口 | 「软件内开启不给 bot 通知」是结构性缺口；本轮按「小修 = 改教材」处理（要求它查实况），未加通知通道 |

---

## 四十、开关回执口径：哪里开启哪里回应、哪里退出哪里回应（2026-10-11）

> 触发：Rushiera 2026-10-11（14:2x）——「我上次让他退出领航员他没有给我发领航报告」→ 查存档定位根因 → 口径拍板：「开启和退出都遵循哪里开启哪里回应的原则……软件内开、群里关也一样；除非是软件内退出，那就不需要发，直接静默整理」。**口径纠正（同轮）**：超时自关不是发「来源群」，是发**最后一次群内指令的地方**——「哪怕是软件内开，我在群里下过指令，超时退出也发群」。
> 设计：`design-qqbotb-navigator.md` §三（开关面）· §十一（判据 8 / 13）。

**现象与根因（三条叠加）：**

| # | 现象 | 根因 |
|:--:|:--|:--|
| 1 | 14:25:07 群 689942975 @「退出领航员模式」→ 关闭成功（14:25:46），群里没有任何报告 | 那轮业务面 `roleText` 是旧版（会话 `mv3fvdn7-3f55ed93` 的 prompt 无「场次收尾」段）——其 reasoning 原文：「执行退出，然后静默（系统会自动发领航记录）」 |
| 2 | 系统那条「领航记录」也没发群 | 发群判据是 `openedBy === 'qq'`（**开启**来源）；本场次 13:09 为**应用内开启**，按旧规则不发群 |
| 3 | 连「已退出」的确认都没到群 | 该轮 session `status: noreply`——输出了文本但没调 `send_message`（业务面普通文本不发 QQ） |

**改动（判据从「开启来源」改为「关闭动作的发生地」）：**

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 关闭发群 | `app/src/navigator/index.js` `close()` | 新增 `by` / `chat` 参数；目标群按**动作发生地**定：群内退出 → `resolveChat(chat) \|\| activeChat`（与 `nav_send` 同口径：按最近一条 VIP 群消息解析）；**超时自关 → `activeChat`**（最后一次群内指令的群——软件内开启但群内下过指令的场次同样发）；软件内手动退出 / 无群内指令 → 静默 |
| 白名单 | `_unpack/data/config.json` `allow.groups` | 经业务面 `POST /api/config` **热写**加三个群：`512942437` / `819158977` / `785638698`（第三个尚未进群——先进清单，进群即生效） |
| 领航记录 | 同上 `buildVoyageLog()` | 「关闭原因」行改「**关闭来源**」：群内 @ 退出 / 应用内退出 / 空闲暂关（超时）；群记一行版小结同步 |
| API | 同上 `POST /api/nav/close` | 透传 `by` / `chat`（应用面板前端本就传 `by:'app'`，此前被丢弃） |
| 业务面工具 | `tools/navigator/nav-tools.js` `nav_close` | 传 `by:'qq'`（不带 chat——单体按新鲜 VIP 群消息解析）；工具描述写明发群口径 |
| 教材 | `tools/apply-qqagent-config.mjs` `NAV_RULES` | 「开关」段改写为「哪里开启哪里回应、哪里退出哪里回应」（含跨群示例）；「场次收尾」段：报告发到退出的那个群 + 必须调 `send_message`；末条改「软件内退出 / 空闲自关只做静默整理」 |
| 设计 | `design-qqbotb-navigator.md` §三 / §十一 | 开关回执行改写；判据 8 改静默；新增判据 13 |

**验证实锤：**

| 项 | 结果 |
|:--|:--|
| 语法 | `node --check app/src/navigator/index.js` → 退出 0 · `node --check tools/navigator/nav-tools.js` → 退出 0 |
| 补丁 | `node tools/patch-qqagent-navigator.mjs` → `module-nav-tools` updated（其余 5 点 skipped） |
| 自测 | `node tools/verify-navigator.mjs` → **29/29**（新增 4 条：软件内退出静默 / 群内退出发到退出那个群 / 空闲自关发到最后指令群 / 无群内指令的超时静默） |
| 教材落盘 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 93785 → 93922 → **93974**（超时口径纠正后再落一次） |
| 白名单 | `POST http://127.0.0.1:3210/api/config` → 读回 `config.json` 的 `allow.groups` = 6 群（三旧 + 三新），`private` 未动 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效面 | 自研单体改动需**重启 QQBotB 应用**；教材需**业务面开新会话**（均为主理方发起） |
| 2 | 真链路 | 待验——群内 @ 退出 → 领航记录发退出群 + R喵 发收工报告；软件内退出 → 静默 |
| 3 | 空闲自关口径（同轮已纠正） | 定为**发 `activeChat`**（最后一次群内指令的群）——与开启来源无关；从未有群内指令则静默 |
| 4 | 白名单新群 | `819158977` / `785638698` 尚未进群——清单已就位，进群即可收发（`512942437` 待实测首条） |

---

## 四十一、前文整理等待改事件驱动（v0.52 · 2026-10-11）

**问题**：`nav_reset` 的「等收工摘要」用固定窗口轮询（`waitForReply(key, { since, timeoutMs = 240000 })`）——大前文的猫走完「落盘 → 推 git → 报告 → 摘要」远超 4 分钟，窗口一到即判「交接摘要未取到，整理中止」（中止即不清前文）。

**判例（R喵 · 322 条 / 436k tokens 前文）**：

| 时刻 | 事件 |
|:--|:--|
| 17:39:23.888 | `[reset] R喵：前文整理重启开始`——投递「完整收工」指令 |
| 17:43:24.438 | `[error] R喵：交接摘要未取到，整理中止`（投递后 4 分钟） |
| 17:47:17 | R喵 才产出收工报告 + 交接摘要（实测 8 分钟） |

**改法**（`app/src/navigator/index.js`）：等回复不再按固定窗口判死，改挂**持久观测的轮结束信号**——`finishSession` 里 `notifyRoundEnd(session.key)` 唤醒等待器（「群里转发回复」的那一刻就是轮结束），外加 5 秒 `keyinfo` 复查兜底；`waitForReply` 默认 `timeoutMs = 0`（**不设上限**），仅「等确认回复」这类非关键路径仍传上限。

- 新增 `readReply`——取 `since` 之后的回复正文，须同时出现 `roundsum`（中途插话不算一轮结束）
- 新增 `waitRoundSignal` / `notifyRoundEnd`（`roundWaiters: Map<key, Set<resolve>>`）
- `resetSession` ① 步注释更新（不设时限）

**自检**：`node --check app/src/navigator/index.js` 退出 0 · `tools/verify-navigator.mjs` **29/29 通过**

**生效**：改的是自研单体源码（`app/src/`）——需**重启 QQBotB 应用**（`启动QQBotB.bat/.vbs`）。

**同轮手工续跑**：R喵 摘要已产出而流程已中止 → 复制旧会话 jsonl 到 `app/data/nav-reset-639259389468574799.jsonl` → `cat.new-session` 清前文 → 投递「读材料最后一行 + 继续」。17:59 新会话接上（未走领航员通道——**断点续跑入口尚未做**）。

---

## 四十二、领航员收工报告改模板骨架（脱敏 · 2026-10-11）

> 触发：Rushiera 2026-10-11（CH4 对话页）——「领航员的收工报告依然不是我想的那个格式」「要写成模板」「记得要做脱敏处理」。
> 设计：`design-qqbotb-navigator.md` §八（教学面第 5 点）。

**问题**：v0.48 落地的收工报告段只给**五段要点描述**（「时间——场次起止与总时长」），没有可照抄的行格式——标题行 / 时间行 / 版本区间 / 条目符号都不固定，领航员每次自由发挥。

**改法**（`tools/apply-qqagent-config.mjs` `NAV_RULES`「场次收尾」段）：要点描述换成**模板骨架**——标题行 → 时间行 → 四段正文（做了什么 / 本轮修掉的问题 / 验证 / 落盘）逐行给出，条目符号 `·` 与版本区间 `→` 一并写死。

**脱敏**（Rushiera 要求）：骨架里所有项目细节用占位符 `<…>`——日期 / 时刻 / 版本号 / 落点文件名一律不写实（`<日期> <起 HH:MM> → <止 HH:MM>` · `<版本起> → <版本止>` · `<落点：文件名 / 条目名>`）。群友看得到报告，模板不带本仓内部信息，也不诱导照搬。

**保留**：素材纪律（只取本场次真实读到过的，读不到写「未取到」，不许编）与两条收尾说明（软件内退出不用补 / 超时自关由「领航记录」兜底）原样保留。

**自检**：`node --check tools/apply-qqagent-config.mjs` 退出 0 · 读回核对骨架段结构（标题 / 时间 / 四段）。

**落盘**：`node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 93974 → **94124**（+150）；读回复核 `_unpack/data/config.json` 命中「照下面这份骨架写」。

**生效**：教材改动——**业务面开新会话**才读得到（主理方发起）。

---

## 四十三、图像编辑接入（ComfyDock「[生成]」工作区 · 2026-10-11）

> 触发：Rushiera 2026-10-11（CH4 对话页）——「我们的 comfydock 现在已经跑通了 [生成] Qwen-AIO 的线上识别，现在我希望把这个功能做进整合，要想直接用 bot 调用必须先处于领航员模式，并且 comfydock 得在线，然后就可以发指令 @领航员 进行图像编辑了」+「你先拿 `D:\Mau\WorkSpace\ComfyDock\out\gen\41.png` 这张图片试试，提示词用 把这张图片做成三视图」。
> 设计：`design-qqbotb-navigator.md` §十八。

**链路**：群里 @ 它 + 改图要求 → 业务面 `comfy_edit`（从 `ctx.store` 取那条消息的图）→ 单体 `POST /api/nav/comfy` → `app/src/navigator/comfy.js`（取图 → `POST /api/rh/submit` → `POST /api/rh/poll` 轮询 → 出图 `sayImage` 发群）。

**前置三条**：领航员已开启（状态机）+ ComfyDock 在线（`GET /api/summary`）+ **请求者闸**（群内触发时：近期有 `569145850` 在**本群** @ 我）——缺哪条拒哪条并出声。**一次只跑一张**（单体侧 `busy` 闸）。

**请求者闸（Rushiera 2026-10-11：「先收成只有我能用，后面做白名单」）**：只对**群内触发**（`by='qq'`，业务面工具走这条）生效——应用内 / 本地 API 是操作者通道，不受此闸约束；凭据 = 最近一次 VIP 群 @（新鲜窗口 120 秒，同 `nav_open` 机制）+ **必须同群**（防蹭别群的近期 VIP 消息）；配置开关 `navigator.comfy.requireVip`。白名单落地后本闸降级为白名单里的一项。

**落点：**

| 面 | 文件 |
|:--|:--|
| 编排 | `app/src/navigator/comfy.js`（新）· `app/src/navigator/index.js`（`editImage` + `POST /api/nav/comfy` + 导出） |
| 配置 | `app/src/config.js` `navigator.comfy`（endpoint / workspaceId / pollMs / timeoutMs / enabled） |
| 业务面工具 | `tools/navigator/nav-tools.js` `comfy_edit`（补丁重跑 → `_unpack/resources/app/src/nav-tools.js`） |
| 教材 | `tools/apply-qqagent-config.mjs` `NAV_RULES`「图像编辑（改图）」段 |

**自测：**

- 守门 `node tools/verify-comfy.mjs` → **10/10**：接口面 / 未开启不受理（offMode）/ 空提示词报错退出 / 请求者闸三例（群内非 VIP 拒 · 操作者通道放行 · VIP 消息非同群拒 · 同群 VIP @ 后放行）/ ComfyDock 离线不受理 / 在线探测（真机）/ 本地路径不在即报错。
- 业务面 `node tools/verify-qqagent-navtools.mjs` → **8/8**：补丁标记 + 模块在位 + 领航员工具组 **10 件**经真实入口（`buildToolDefs`）注册 + `comfy_edit` 参数面 / 描述 / 执行面（空提示词、本群无带图消息均报错退出，不触网）。
- 真链路（自测 harness）`node tools/verify-comfy.mjs --live --prompt-file <提示词文件>` → **8/8**：群图路径（mock `get_image` → `41.png`）→ 提交 → 轮询 → 出图发群（mock 出站）。任务 `2109258765894377473`，出图 `out/gen/6379.png`，用时 **66.0 秒**。
- **真链路（领航员实调 · 重启后）**：`启动QQBotB.bat` 一键重启 → 应用加载新代码 → `POST /api/nav/comfy`（操作者通道）`41.png` + 「把他变成金毛妹」→ 任务 `2109270410188259330`，出图 `out/gen/7138.png`（金发版，画面稳定），**86.2 秒**，活动流落 `[comfy] 图像编辑出图已发群（7138.png）`（群 `689942975`）。
- 基线（不经本功能，直连 ComfyDock）：`41.png` + 「把这张图片做成三视图」→ 任务 `2109252239880318978`，出图 `out/gen/5996.png`，**82.7 秒**。
- 回归：`node tools/verify-navigator.mjs` **29/29**。

**顺带修（同轮发现）**：`stop()` 撤订不彻底——只清 `watchTimer` + `watcher.stopAll()` + `sessions.clear()`，漏了每猫的 `pollTimer`（`setInterval`）与 `analyzeTimers`；自测里表现为进程退出报 libuv 断言（`src\win\async.c`）→ 退出码失真。改法：`stop()` = 清 `watchTimer` + `disarmAll()`。

**教材落盘**：`node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 94124 → **94447**（+323）。

**生效**：① 改的是自研单体源码（`app/src/`）——需**重启 QQBotB 应用**（`启动QQBotB.bat/.vbs`）；**2026-10-11 21:0x 已重启**（一键全流程：停旧实例 → 清锁 → 开会话 → 起新；重启后领航员状态沿用，`vipRecentChat` 归零、持久观测重建）；② 教材与业务面工具——重启已带起业务面新会话。

**遗留：**

1. **群图取图真链路未验**——自测里 `get_image` 是 mock 的；真群实测时确认协议端缓存路径取得到（取不到会自动走直链兜底）。
2. 输入图不做体积 / 格式预检（GIF / 超大图未处理）——真链路遇到再补。
3. ~~未限制请求者~~ → **已收（请求者闸 · 2026-10-11 同轮追加）**：先收成只有 `569145850` 能用，白名单以后做。

---

## 四十四、领航员收工报告改一句话（撞发言频率墙 · 2026-10-11）

> 触发：Rushiera 2026-10-11（CH4 对话页 · 收工途中追加）——「领航员模式退出的收工报告会分多段发送然后撞发言频率墙，改成一句话」。

**问题**：v0.53 把「场次收尾」段改成**可照抄的多段骨架**（标题 / 时间 / 做了什么 / 本轮修掉的问题 / 验证 / 落盘）——模型照着分段，逐段各调一次 `send_message`；业务面的发言闸（`engage` 配额 120s·5 条）在第 6 条上把后面的挡掉，群里只看到半份报告。

**改法**（`tools/apply-qqagent-config.mjs` `NAV_RULES`「场次收尾」段）：多段骨架换成**一句话模板**——

```
【领航员模式 · 收工报告】<日期> <起 HH:MM>→<止 HH:MM>，做了 <N> 件事（<要点一> / <要点二> / …），<遗留：还有什么没做完 / 无遗留>。
```

并明写「**只发一条消息、只写一句话**——分成多条发会撞发言频率墙，后面几条发不出去」「一句到底：不分行、不分段、不摆条目、不带小标题」。素材纪律（只取本场次真实读到过的，不许编）原样保留。

**为什么不是改代码**：根因在**话术**——模型按教材分段发送；改教材即改行为，业务面发言闸是既有契约，不动它。

**教材落盘**：`node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 94523 → **94367**（-156，骨架比一句话长）。

**生效**：教材改动——**业务面开新会话**才读得到（主理方发起）。

## 四十五、搜索通道精简 + 百度网页解析（v0.56 · 2026-10-11）

> 触发：Rushiera——「你把 provider 分派里的东西都验证一下 如果不可用的话去掉，我们主力用 baidu」→ 追问「那你能不能直接用起浏览器的通道，直接 `https://www.baidu.com/s?ie=UTF-8&wd=百度` 这个样子」。

**逐 provider 实测（真链路——探针直接 import 业务面 `web-search.js` 的导出函数，不另写一份实现）：**

| provider | 结果 | 证据 |
|:--|:--|:--|
| bing | ✅ 可用 | `bingSearch` 6 条 / 313ms |
| deepseek | ❌ 缺凭据 | 裸探端点 401 `Authentication Fails (governor)` |
| zhipu | ❌ 缺凭据 | 401 `code 1001 未收到 Authorization` |
| bocha | ❌ 缺凭据 | 401 `Invalid API KEY` |
| baidu（千帆） | ❌ 缺凭据 | 401 `216003 get authorization error`——端点与路径正确，只差 Key |
| metaso | ❌ 已废 | HTTP 200 但 body `errCode:401`——免费额度路径没了 |
| custom | ❌ 无配置 | `providers=[]` + 单槽位空 |

**百度网页通道可行性（新增能力的判据）：**

| 项 | 证据 |
|:--|:--|
| 裸抓可达 | `https://www.baidu.com/s?ie=UTF-8&wd=…` → 200 / 1.0MB / **无安全验证页**（`安全验证` 0 命中） |
| 结构可解析 | `result c-container` 块 7 个；标题取 `<h3>`；**真实链接取块内 `mu` 属性**（不必解百度跳转链） |
| 摘要 | 块内最长可读文本（滤掉 script/style 与 JS 特征）——7 条中 5 条有摘要、2 条空（聚合卡片本就无摘要） |
| 移动版对比 | `m.baidu.com/s` 无 `result c-container`（结构不同）——**取 PC 版** |

**改动（落成 `tools/patch-qqagent-search.mjs` · 7 补丁点 · 幂等 · 链尾）：**

| # | 文件 | 动作 |
|:--:|:--|:--|
| 1–2 | `src/web-search.js` | 删 DeepSeek 实现（1876 字符）· 删 智谱 / 博查 / 千帆 / 秘塔 / 自定义两件（10598 字符） |
| 3 | `src/web-search.js` | 新增 `parseBaiduResults` + `pickBaiduSnippet` + `baiduHtmlSearch` |
| 4 | `src/web-search.js` | 分派只认 baidu（默认）\| bing；未知提供方**抛错**（不静默回落） |
| 5 | `src/config.js` | `webSearch` 默认段精简（provider 默认 baidu · `baidu.searchUrl` · bing `searchUrl` · providers/custom 容器保留） |
| 6–7 | `ui/app/06-settings-render.js` | 提示文案改「无需 API Key」· 下拉只留两项 |
| — | `_unpack/data/config.json` | `provider` → `baidu` + 段精简（运行区配置，随重启生效） |

**验证实锤：**

| 面 | 证据 |
|:--|:--|
| 语法 | `node --check` × 3 文件（`web-search.js` / `config.js` / `06-settings-render.js`）退出 0 |
| 真链路 | `webSearch('上海天气')`（provider=baidu）→ **809ms / 6 条 / 真实 URL**（`qq.weather.com.cn` · `sh.weather.com.cn` · `weibo.com` …） |
| 导出面 | `Object.keys(mod)` 只剩 `baiduHtmlSearch` · `bingSearch` · 图片组 · 查询处理 · `webFetch`——四家 API 与 custom 函数已消失 |
| 幂等 | `--dry` 首跑 7 点全命中 → 应用 **7/7** → 复跑 **applied 0 / skipped 7** |

**🔴 判例（当日修）——删导出未同步消费方：**

| 项 | 内容 |
|:--|:--|
| 现象 | 22:41:35 自研单体拉起业务面（pid 27536）→ 业务面**无任何启动日志**（最后一条启动记录停在 21:09:11）→ 22:45:32 领航员报「群记沉淀失败：业务面记忆 API 不可达（试过 3210-3219）」；`tasklist` 查无进程 = 启动即闪退 |
| 根因 | `routes.js:17` 仍 `import { customSearch } from './web-search.js'`，而本次把该导出删了 → ESM 静态导入报「does not provide an export named」→ 模块图加载失败，logger 都没起来 |
| 修法 | 删该 import + `/api/search-providers/test` 改明确回执（不再调 `customSearch`）+ 删除自定义服务时回落提供方改 baidu；**同步进补丁脚本**（补丁 8 / 9 / 10） |
| 验证 | ①跨模块 import 符号完整性静态扫描：59 文件 / 310 符号 / 0 真实缺失（固化脚本 `tools/verify-import-integrity.mjs`）②静态依赖链实加载：`config.js` · `web-search.js` · `tools.js` · `routes.js` 四模块全部 import 成功 ③`node --check` 全绿 ④补丁 `--dry` **10/10 skip** |
| 教训 | **删导出 = 改接口**——`node --check` 只查语法，ESM 符号缺失是加载期错误，必须扫消费方（`grep import`）或在真实模块图上加载一次；「模块自身能加载」≠「消费方能加载」 |

**判例与边界：**

1. **metaso 分支的静默误报**（随本次删除消失）：原实现只判 `res.ok`，200 就往下解析字段——上游用 `errCode:401` 表达未授权，被报成「没有返回有效结果」。
2. **不静默回落**：未知 provider 抛错而非回落 bing——回落到别的引擎会让「配置写错了」看起来像「搜到了」。
3. **UI 各 API 表单块保留但永不显示**（下拉已无对应值）——为不打断 `07-settings-events.js` / `08-modals.js` 的绑定链（元素缺失会让整段事件绑定抛错）；彻底清干净属 modB 迁移的活。
4. **裸抓风控**：本次单次请求未触发验证页；若日后高频触发，退路 = 业务面 `browser-*`（CDP 有头）通道。

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | **生效需重启业务面**（改的是 `_unpack/resources/app/` 与 `_unpack/data/`） | 待执行——重启后群里搜一次即验 |
| 2 | 补丁链复核清单未登记本补丁（§十九 / §二十 的「补丁链复核」表） | 下次复核时并入（本补丁排链尾，依赖 cattools 先跑） |
| 3 | 摘要抽取为启发式（块内最长文本） | 有意为之——百度结构多变，精确选择器更脆 |

## 四十六、协议端登录面（自研单体）+ 入口归位（v0.57 · 2026-10-12）

> 触发：Rushiera——「我重启电脑后 qq 好像掉登录了，我没看到登录方式，修一下，放我们自研单体里面」「我看我点 bat 打开还是开 napcat 没看到自己的单体打开，顺便修一下」。

**现象与根因（观测实锤）：**

| 面 | 证据 | 结论 |
|:--|:--|:--|
| 账号掉线 | `runtime/NapCat/NapCat.52230.Shell/logs/2026-10-12_08-22-19.084.log` 末两行：`10-12 10:04:20 [info] 账号状态变更为离线` → `10-12 10:05:20 [warn] [Core] [Login] 账号已离线，正在重启 Worker 以重新创建 QQ 登录服务` | 10:04 掉线；NapCat 重建登录服务后**无人可见**（协议端无窗口 + `consoleLog=false`） |
| 登录方式不可见 | 协议端 WebUI（`:6099`）有完整登录页 `/webui/#/qq_login`（三档：快速登录 / 密码登录 / 扫码登录），但**自研单体没起来**——登录面缺的是「入口」，不是「实现」 | 单体没起 = 登录面整个消失 |
| 单体从未启动 | `app/data/boot.log` 末条 `2026-10-11T14:41:35Z`（本地 10-11 22:41）；`wmic os get lastbootuptime` = **2026-10-12 08:21:25**；`wmic process`：QQ Agent 四进程创建于 `08:22:11–08:22:20`、`NapCatWinBootMain` `08:22:17` | 08:22 开机后**只起了业务面**（业务面先起、再由它经 snowluma 通道拉协议端）——与旧入口路径一致，故表现为「点 bat 只开 NapCat」 |
| 单体本身可用 | `node app/tools/smoke.mjs` → 端口 3280 起、OneBot 连上（`self = Shieraru/2405997337`） | 单体无故障——问题在入口指向 |

**改法（1）自研单体加「账号登录」面：**

新增 `app/src/napcat/webui.js`（协议端 WebUI 客户端——凭据 + 登录接口的唯一出口；`app.js` 原 `webuiCredential` 收编为其 `login()` 的重试档）+ `app/src/app.js` 两条路由 + `app/ui/` 概览卡片。

| 协议端接口（实测原文） | 用途 |
|:--|:--|
| `POST /api/auth/login`（body `{hash: sha256(token + ".napcat"), totpCode:""}`）→ `{data:{Credential}}` | 取 WebUI 凭据（缓存 10 分钟；401 丢弃重取一次） |
| `POST /api/QQLogin/CheckLoginStatus`（头 `Authorization: Bearer <凭据>`）→ `{code:0,data:{isLogin,isOffline,loginPhase,qrLoginAccepted,coreReady,qrcodeurl,loginError},message}` | 账号登录态 |
| `GET /api/QQLogin/GetQuickLoginList` → `{code:0,data:["2405997337","569145850","879531138"],message}` | 已存快速登录账号 |
| `POST /api/QQLogin/SetQuickLogin` `{uin}` → `code:0` | 发起快速登录 |

单体侧新增：`GET /api/qq/login`（登录态 + 已存账号）· `POST /api/qq/login/quick`（快速登录）。界面：概览页新增「账号登录」卡片（状态 / 阶段 / 提示 + 已存账号下拉 + 快速登录 + 扫码登录）；「协议端控制台」页签加「登录页」按钮（iframe 直达 `/webui/#/qq_login`）。

**改法（2）入口归位：** `tools/apply-entry.mjs` 重构——单体启动体收敛为 `tools/entry.cmd`（各入口共用的唯一实现），入口文件改薄壳：

| 文件 | 语义 |
|:--|:--|
| `启动QQBotB.bat` / `.vbs` | 自研单体入口（日常用） |
| `启动QQAgent.bat` / `.vbs` | **旧入口名保留为单体入口的别名**——旧快捷方式指向它，点它必须开单体 |
| `启动QQAgent-仅业务面.bat` / `.vbs` | 回落路径——只起业务面 QQ Agent（单体起不来时用） |
| `tools/entry.cmd` | 单体启动体（单一真相源） |

**验证实锤：**

| 面 | 证据 |
|:--|:--|
| 语法 | `node --check` × 3（`app/src/app.js` · `app/src/napcat/webui.js` · `app/ui/app.js`）退出 0 |
| 模块图 + 真链路 | `node app/tools/smoke.mjs` → 应用起（3280）+ OneBot 连上（`self=Shieraru/2405997337`）+ 协议端 `running` + 业务面「已在运行——跳过拉起」 |
| 登录面真链路 | `node app/tools/verify-login.mjs` → **5/5**（经 HTTP 走界面同一出口：登录面可达 / 状态含 `isLogin` / 已存账号为数组 / 已存账号非空 / 空账号被拒） |
| 入口生成器 | `node tools/apply-entry.mjs --dry` 7 文件 → 实跑落盘 7 文件（脚本内置 ASCII + CRLF 双断言；首跑即拦下 3 处中文注释引用）；`git ls-files --eol` 复核 `启动QQBotB.bat` / `启动QQAgent.bat` = `w/crlf` |
| 账号恢复 | 侦察期经协议端登录面发起一次快速登录（`uin=2405997337`）→ `CheckLoginStatus` 转 `isLogin:true`；`logs/2026-10-12_10-05-24.933.log` 自 `20:27:06` 起 OneBot 服务重启并恢复收群消息 |

**判例与边界：**

1. **掉登录的可见性根因**：协议端无窗口 + `consoleLog=false` → NapCat 印在控制台的登录二维码无处可见；WebUI 里虽有三档登录页，但入口在自研单体里——单体没起 = 登录面整个消失。
2. **二维码不自己渲染**：不引第三方 QR 库（勿增实体）——扫码登录走协议端自己的登录页（iframe 直达 `#/qq_login`）。
3. **入口收敛为单一实现**：单体启动体只留 `tools/entry.cmd` 一份，四个入口薄壳——避免「同一语义两处实现」漂移。
4. **`.bat` / `.cmd` 写入只走生成器**：ASCII + CRLF 双断言，禁 IO 工具直写（判例 2026-10-10）。

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | **生效需重启自研单体**（改的是 `app/`）——重启后概览页可见「账号登录」卡片 | 待执行（Rushiera 主持——点 `启动QQBotB.bat`） |
| 2 | 协议端 `autoLoginAccount` 是否配成机器人号（重启后自动恢复登录，`webui.json` 现为空） | 未做——属产品决定，等 Rushiera 拍板 |
| 3 | 界面像素级核对（卡片渲染） | 未做——需应用内核驻留才能截图；本次只做 ID 交叉核对 + 语法检查 |
| 4 | 新文件未入库（`tools/entry.cmd` · `启动QQAgent-仅业务面.*` · `app/src/napcat/webui.js` · `app/tools/verify-login.mjs`） | 收工随 git 提交 |

---

## 四十七、白名单加群 112562956（v0.58 · 2026-10-13）

> 触发：Rushiera——「白名单群加 112562956」。

**动作：** 经业务面 `POST http://127.0.0.1:3210/api/config` 热写 `allow.groups` → **8 群**（7 旧 + `112562956`「偶像大师摸鱼会二代」）· `private` 未动 · 协议端 / 自研单体未动。

**现象与根因（白名单的唯一真相源是运行实例内存）：**

| 面 | 证据 | 结论 |
|:--|:--|:--|
| 文件曾有此群 | `_unpack/data/config.json` 本场次 20:29 读得 `allow.groups` = 8 群（含 `112562956`）· 文件 mtime 20:21 | 有人**直改文件**加了群 |
| 内存无此群 | `GET /api/config`（20:37）`allow.groups` = 7 群（无 `112562956`） | 直改文件**不生效**——判断读的是内存 |
| 文件被抹回 | 20:38 `config.json` 被重写（mtime 20:38），8 群 → 7 群 | 应用侧一次配置写入按内存重写整个文件，外部写入被抹掉 |

- 判断链：`app.js` `ingestMessage` / `ingestPoke` → `allowed(kind, id, getConfig())`；`config.js` `getConfig()` 返回**内存** `currentConfig`（启动时从盘读一次，之后只由 `updateConfig()` 更新）。
- `updateConfig()` 是唯一的「内存 + 落盘」同步口——应用内部多处调用（`memory.js` `memberNotes` · `community.js` · `providers.js` 等），每次都会按内存重写整个 `config.json`。
- 故：**改白名单 / 配置一律走 `POST /api/config`**；直改 `_unpack/data/config.json` 既不生效、又会被应用内部写入抹掉（`tools/apply-qqagent-policy.mjs` 这类直写脚本同理）。

**验证实锤：**

| 面 | 结果 |
|:--|:--|
| POST 回执 | `allow.groups` = 8 群（含 `112562956`） |
| 内存读回 | `GET http://127.0.0.1:3210/api/config` → 8 群（含 `112562956`） |
| 落盘 | `_unpack/data/config.json` `allow.groups` = 8 群（含 `112562956`） |
| 生效 | **即时**——热写，无需重启 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 消费点——群 `112562956` 首条消息到达 → 自动建 `data/messages/group_112562956.json` | 待验（本场次内该群无新消息） |


---

## 四十八、领航员空闲暂关阈值 30 分钟 → 3 小时（v0.59 · 2026-10-14）

> 触发：Rushiera——「把领航员超时自动关闭的限时从半个小时改到3个小时」。

**改动：**

| 面 | 文件 | 改动 |
|:--|:--|:--|
| 生效源（默认配置） | `app/src/config.js` | `navigator.idleCloseMs`：`30 * 60 * 1000` → `180 * 60 * 1000` |
| 兜底常量 | `app/src/navigator/state.js` | `IDLE_CLOSE_MS`：`30 * 60 * 1000` → `180 * 60 * 1000` |
| 设计文档 | `design-qqbotb-navigator.md` | 摘要 / §四 / §十一 三处「30 分钟」→「3 小时」；§四 判据基准同步为「最近一次活动」（v0.40 修正的文档补齐） |

**判据链（未改）：** `createNavigator` 读 `navConfig.idleCloseMs`（`config.js` DEFAULTS，可被 `app/data/config.json` 覆盖）→ 守护每 60 秒巡检：`now − max(lastActivityAt, lastCommandAt, openedAt) ≥ idleCloseMs` 且全猫 `runState = idle` → 暂关（发 `activeChat` + 场次沉淀）。

**验证实锤：**

| 面 | 证据 |
|:--|:--|
| 语法 | `node --check` × 2（`app/src/config.js` · `app/src/navigator/state.js`）退出 0 |
| 重启 | `启动QQBotB.bat` 一键全流程（停旧实例 → 清锁 → 开启动会话 → 起新）· 2026-10-14 12:50 前后 |
| 消费点 | `GET http://127.0.0.1:3280/api/nav/status` → `idleCloseMs: 10800000`（= 180 分钟）· `enabled: true`（重启后状态恢复）· 持久观测重建（10 只猫订阅就绪） |

**生效：** 已重启生效（改的是 `app/` 源码——启动时读取，重启吃下）。

---

## 四十九、轻通道 + 会话分析读全（v0.60 · 2026-10-14）

> 触发：Rushiera 2026-10-14（群 940257985，经领航员投递到主干）——
> ①「让majordomo上工qqbotb，要求是在即使没有开领航员模式，我直接在群里对bot下指定猫的指令的时候依然能完成会话转发，然后群里下的指令完成后按领航员的方式往群里推送回复，但不带投送后的分析」；
> ②「跟R喵说，上工qqbotb，领航员消息投递后的60秒回复的消息有点问题，疑似没有读会话的think和工具调用等内容，只读了回复和用户输入，让他读全一点」。

**一、轻通道（未开启模式的投递 · 需求 ①）**

| 面 | 文件 | 改动 |
|:--|:--|:--|
| 投递闸门 | `app/src/navigator/index.js` `send()` | 未开启时不再一律拒——`by:'qq'` + `vipFresh()`（本人 120 秒内 @ 过）放行（轻通道）；其余维持 `offMode` 拒绝 |
| 回复观测 | 同上（新 `armLightWatch` / `lightTick` / `cancelLightWatch` / `clearLightWatches`） | 轻通道投递成功 → 每 5 秒轮询 `keyinfo`，检出「投递之后的回复 + 轮结算」→ 截图 → 发回消息群 → 撤除；**不排分析**（不带投送后分析）；超时 120 分钟撤除；领航员开启 / 应用停止时清空 |
| 状态面 | 同上 `status()` | 新增 `lightWatches` 字段 |
| 业务面工具 | `tools/navigator/nav-tools.js` | `nav_send` 传 `by:'qq'`；描述补「未开启时也能投——限本人点名指令」 |
| 教材 | `tools/apply-qqagent-config.mjs` `NAV_RULES` | 「VIP 通道」段改「未开启时点名指令照样投递（投递 + 回复推送，不带分析）」；「指令 / 闲聊」段改「未开启时没点名猫的不要投」 |

**二、会话分析读全（需求 ②）**

| 面 | 文件 | 改动 |
|:--|:--|:--|
| 根因①：think 收集形态错 | `app/src/navigator/index.js` `collectThink` | v0.45 首版读 `item.text`——生产形态条目正文在 `item.payload`（`{type, ts, msgIndex, round, payload}`）；自测喂旧形态故「25/25 过」而生产从未收集到。本版改读 `payload.text`（兼容旧形态） |
| 根因②：只收 think | 同上 | 补收工具卡（`toolcard` → `tools` 环：name / args / result / durMs）+ 旁白（`gap_text`）+ 直播态（`live`：thinksse / toolrun / replysse / empty） |
| 读全主路：现场拉取 | 同上（新 `pullCatView` / `digestFromView` / `digestFromSession` / `composeActivity`） | 分析时**一次性 SSE 取整幅视图**（不依赖常驻订阅健康——订阅断了也读得到）→ 归一化为活动摘要 → 组装：它现在/最近在想 · 最近工具调用（近 6 次 + 进行中）· 最近旁白 · 正在写回复；现场拉取失败回落常驻环；两路全空才走截图 + 视觉判读 |
| 根因③：订阅断线不自愈 | 同上（`armCat` 重连 + 新 `ensureWatching`） | 订阅中断后不再等到下次开启——空闲守护每 60 秒补订；投递成功时对目标猫即时补一次。判例：当日 13:01–13:14 十只猫订阅先后 terminated（此后未再补订）；叠加 payload 形态误读——分析素材两路皆空，播报连续回落截图 + 视觉判读（15:24 / 15:27 两条即此形态） |

**验证实锤：**

| 面 | 证据 |
|:--|:--|
| 语法 | `node --check` × 3（`app/src/navigator/index.js` · `tools/navigator/nav-tools.js` · `tools/apply-qqagent-config.mjs`）退出 0 |
| 自测 | `node tools/verify-navigator.mjs` → **39/39**（29 → 39：payload 形态收集 / 工具卡 / 旁白 / 直播态 / 读全组装 / 轻通道闸门三例 / 轻观测登记撤除 / 现场拉取） |
| 自测 | `node tools/verify-qqagent-navtools.mjs` → **8/8**（工具组 10 件在位） |
| 落盘 | `node tools/patch-qqagent-navigator.mjs` → `src/nav-tools.js` **updated**（其余 5 点 skipped）；`node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 94367 → **94483** |
| 重启 | `启动QQBotB.bat`（`tools/entry.cmd`）一键全流程 ×2（16:03 / 16:09）——持久观测重建（10 只猫订阅就绪；重启前 `watching` 为空——十只全部失联） |
| 消费点·读全 | 手动 `POST /api/nav/analyze {key:'majordomo', delayMs:0}` → 播报发群 940257985：日志 `播报素材 = 现场拉取（think 121 / 工具 158 / 旁白 10 / 进行中工具）`；消息含「它最近在想：…」+「最近工具调用（近 6 次）：[时] 名 ✓ · 参数 …」+「▶ …（进行中）」 |
| 消费点·轻通道闸门 | `POST /api/nav/send {by:'qq'}` 未开启 + 无 VIP → `offMode` 拒绝（出声）；轻观测登记 / 撤除 / 开启清空在自测与状态面（`lightWatches`）实锤 |

**遗留：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 轻通道群内 E2E（退出领航员 → 群里点名指令 → 回复截图回群） | 待验——主理方发起（本人 @ + 点名猫） |
| 2 | 读全的下一次自然触发（投递后 60 秒） | 待验——同上；手动触发路径已实锤 |
| 3 | 领航员开启时轻观测的「并入」路径（先轻通道投递、随后开启领航员） | 代码就位（`open()` 清空 + 持久观测接管）；自然场景罕见，未单独实测 |

---

## 五十、投递错位侦查与交接（v0.61 立项 · 2026-10-14）

> 触发：Rushiera 2026-10-14（群 940257985）——「重建majordomo的前文，告诉他，历史消息里有两个需求一个是发给你的，另一个是发给R喵的，但是不知道为什么没有正确投递还是投递给你了，你检查一下群bot的领航员前文」→ 后续追加「为了避免出现问题，这个需求你整理一下然后给R喵来做，你把你前文有价值的传递给他然后让他开工」。

**一、侦查结论（三条根因，各自独立）**

| # | 根因 | 证据 |
|:--:|:--|:--|
| 1 | **同名歧义**——群里 bot 显示名「R喵」（`Shieraru/2405997337`）与 CH4 猫「R喵」（`639259389468574799`）同名；「跟R喵说 X」在群里是称呼 bot 转达，在领航员语义里是点名猫派活 | 15:26:42 那条（本意给猫 R喵）→ 实际 `已投递主干（端口 8081）`；投递回执回「已投递 → majordomo（端口 8081）」 |
| 2 | **称呼前缀被当指令正文**——教材「整段照抄」+「没点名猫 → 投主干」叠加：整段含「跟R喵说」前缀，目标仍退回默认主干 | 业务面会话 `mv7sd9cp-56a8594b.json`：reasoning 明写「整段原文投递」「目标是 majordomo」并执行 `nav_send(key=majordomo)` |
| 3 | **`nav_reset` 无 `text` 参数**——前文整理重启只投「收工整理」提示词，不带用户新指令原文；业务面 `nav-tools.js` 的 `nav_reset` 也只收 `key` | 16:39:46「重建 majordomo 的前文，告诉他…」→ 业务面只调 `nav_reset(key=majordomo)`（`mv7uzu1e-bc22837f.json`），用户原话从未进 majordomo 会话；该句直到 17:30 前后才以新指令到达（间隔约 50 分钟） |

**二、处置（Rushiera 定：这个需求交猫 R喵 做）**

| 步 | 动作 | 落点 |
|:--:|:--|:--|
| ① | 给猫 R喵（`639259389468574799`）投递完整开工包——任务全貌 / 三条根因 / 已定改动面 / 验收判据 / 原始要求照抄 / 环境参数 | `majordomo-cmd cat.chat 639259389468574799 …`（本轮执行） |
| ② | 判例全文归档（不走本项目——属 CCBP 知识网络面） | `ccbp:L2/Worker/Majordomo/history/2026-10-14_领航员投递错位_同名歧义与nav_reset丢指令_判例.md` |
| ③ | 待 R喵 完成后回访教材落盘（`apply-qqagent-config.mjs --roletext-only`）+ 补丁链（`patch-qqagent-navigator.mjs`）+ 应用重启 | 由下一会话执行 |

**三、验收判据（交给 R喵）**

- 教材「领航员模式」段须含消歧规则：句中「跟 X 说 / 告诉 X」→ X 为**收件猫**；X 为 bot 自身昵称（R喵 / Shieraru）时才按转达给 majordomo 处理。
- `nav_reset` 增可选 `text`：新会话注入摘要之后把用户原话作为第一条指令投递（替代「nav_new + nav_send」两步）。
- 自测：`verify-navigator.mjs` 全过 + 新增 `nav_reset` 带 `text` 的组装断言；`verify-qqagent-navtools.mjs` 8/8。
- 消费点：教材落 `config.json` 的 `roleText`（业务面开新会话才读到）+ 应用重启。

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 「猫 R喵」与「群 bot R喵」同名是长期噪声源——是否改名由 Rushiera 定（工具侧不擅自改） | 待定 |
| 2 | 15:26 那条（读全）实际由 majordomo 做了并已落地 v0.60；若需猫 R喵 复核，由主理方另派 | 待定 |

## 五十一、投递错位两处改动（v0.62 · 2026-10-14）

> 承接 §五十（侦查 + 交猫 R喵 开工）——本轮由 majordomo 接手落地两处改动面；猫 R喵 在另一会话自行推进的部分不在此列。

**一、教材消歧（`tools/apply-qqagent-config.mjs` · NAV_RULES「判断」段）**

| # | 规则 | 处置的根因 |
|:--:|:--|:--|
| 1 | **称呼前缀不是「叫你转达」**——「跟 X 说 / 告诉 X / 让 X 做 / 给 X 派个活」里的 X 就是**收件猫**；判例直接写进教材（「跟R喵说，上工qqbotb…」→ 投 `nav_send(key="R喵")`） | 根因 ② 称呼前缀被当指令正文 |
| 2 | **区分口径**——X 是猫名（majordomo / R喵 / … / rf）→ 直接投那只猫；X 是本 bot 昵称（R喵 / Shieraru / 你 / 小喵）→ 去掉前缀再判收件猫（剩余正文没点名 → 投 majordomo） | 同上 |
| 3 | **同名歧义**——群里 bot 显示名与 CH4 猫同为「R喵」→ 看到「R喵」**默认按猫处理**；只有整句读成「@你，让你转告别人」时才按转达 | 根因 ① 同名歧义 |

**二、`nav_reset` 增 `text`（根因 ③）**

| 面 | 改动 | 落点 |
|:--:|:--|:--|
| 单体 | `resetSession({ key, chat, text })`——接上（`ack`）之后新增第 ⑥ 步：`ch4.send(resolved, userText)` + 等回复；返回值增 `delivered` | `app/src/navigator/index.js` |
| API | `POST /api/nav/reset` 透传 `text`（回执回显 `text`，证明入口没丢参数） | 同上 |
| 业务面工具 | `nav_reset` 参数面增可选 `text` + 描述改「全自动⑤步」+ 示例（只投「告诉他」之后那句） | `tools/navigator/nav-tools.js` |
| 教材 | 「前文整理重启」段补一条：带新指令时把原话一起传 `nav_reset(key=X, text=Y)` | `tools/apply-qqagent-config.mjs` |

**三、自测与落盘**

| 面 | 结果 |
|:--:|:--|
| `verify-navigator.mjs` | **41/41**（新增 2 条：nav_reset 带 text 回执回显 / 源码投递段在位） |
| `verify-qqagent-navtools.mjs` | **8/8**（工具组 10 件注册） |
| `patch-qqagent-navigator.mjs` | `module-nav-tools` updated（其余 5 点 skipped） |
| 教材落 `roleText` | `roleTextChars` 94483 → **95123**（业务面开新会话才读到） |
| 应用重启 | `tools/entry.cmd` 一键全流程；`/api/nav/status` 实测 `watching` 10 只 · 3280 在听 |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 「猫 R喵」与「群 bot R喵」是否改名——工具侧未擅自改，由 Rushiera 定 | 待定 |
| 2 | 消歧规则与 `nav_reset(text)` 的**群内实测**（真实消息走一遍）——本轮只到自测与重启 | 待你发起 |
| 3 | 猫 R喵 在自己会话里推进的同类改动（若已做）需与本轮改动对账，避免双写冲突 | 待核对 |
③ 判例补充：`ccbp:L2/Worker/Majordomo/history/2026-10-14_工具描述反引号闭合模板字符串_业务面启动崩溃_判例.md`——**工具描述禁反引号**（描述写在模板字符串里，内嵌反引号提前闭合 → 业务面加载 `SyntaxError`）；`node --check` 只验源文件，补丁复制后的业务面产物才是消费点。


## 五十二、群 361820329 静默不回（诊断 · 2026-10-14）

> 触发：Rushiera 报「白毛红瞳一家亲群里完全不发消息了，存档记录怎么都是只读不回」。**本轮只做诊断，未修**。

**一、现象（实锤）**

| 面 | 观测 |
|:--|:--|
| 群聊日志 | `app/data/logs/2026-10-14.log` 17:48:42 最后一条 `发送 -> group:361820329`；此后只有「浏览拍 / 静默补拍：N 条新内容进 LLM」，无任何发送 |
| 会话索引 | `_unpack/data/session-index-cache.json` 该群每条运行记录恒为 `status=noreply`、`promptTokens=14`、`completionTokens=28` |
| 消息存档 | `_unpack/data/messages/group_361820329.json` 全部 `read:true` / `reply:null`（= 用户看到的「只读不回」） |

**二、根因（对比实锤）**

| 群 | 本地组装 `promptChars` | 端点回报 `promptTokens` | 结果 |
|:--|--:|--:|:--|
| 361820329 | **315,403** | **14** | 全 noreply |
| 689942975 | 194,934 | 242,019（两调用合计） | 正常 |
| 1097492606 | 153,507 | 191,364 | 正常 |

`promptTokens=14` 连系统提示都装不下 → 请求实际送达模型的内容近乎为空；模型看不到群消息，每轮恒判「不回」。

本地组装无问题：`_unpack/data/sessions/mv81oscu-b9640b3f.json` 的 `inputMessages` 含完整 system + user 共 31 万字符（`promptChars` 315,403 与之吻合）。**问题出在发出之后**——端点把该请求降级/拒绝，却回 200 + 一个 14 token 的 usage，客户端（`llm.js` → `orchestrator.js:1213`）照单收下并记入会话，不报错。

**三、触发时点与群间差异**

| 项 | 观测 |
|:--|:--|
| 时点 | 18:30 那次 `promptTokens=193,767`（正常）→ 18:45 起恒 14；阈值落在观测区间 `306,121（正常）→ 307,082（异常）` 字符之间 |
| 群间差异 | `_unpack/data/session-state.json` 中该群 `rollovers: 0`（**从未轮转**），其余群 3~7 次 |
| 推断 | 该群前文只增不减堆到 30.7 万字符，越过端点上下文/体积上限；其他群靠轮转把前文截住，故只有它撞线 |

**四、修法（未执行）**

| # | 动作 |
|:--:|:--|
| 1 | 清该群会话（等价 `/new`）——前文归零，下一轮恢复；长期记忆 / 群记是另一套存储（`data/memory/<chat>/`），不受影响 |
| 2 | 查该群 `rollovers` 为何恒 0——轮转（收工轮 / 归档轮转）触发条件对该群失效 |
| 3 | 补告警：`promptTokens` 与本地 `promptChars` 严重不成比例时出声——现行静默吞掉，违反 AGENTS §一-4「失败必须可见」 |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 上述三步修法均未执行——待 Rushiera 点名 | 待发起 |
| 2 | 阈值精确值未定（仅观测到 306,121 正常 / 307,082 异常的区间） | 待确认 |
| 3 | 端点为何以 200 + 空 usage 返回（而非 4xx）——未取证 | 待确认 |

---

## 五十三、会话分析 think 改摘要（2026-10-14）

> 触发：Rushiera「领航员的自动分析功能的 think 数据是直接照搬内容，能不能改成总结内容啊」→ 拍板走**方案 A**（LLM 总结）。

**一、现状（改前）**

播报正文的 think 段由 `app/src/navigator/index.js` 的 `composeActivity()` 组装，两处**直接贴思考原文**（`clipText` 截断）：

| 源 | 原行为 |
|:--|:--|
| 直播态（`liveThink`） | `· 它现在在想：` + 原文截 900 字符 |
| 已完成块（`digest.thinks` 末条） | `· 它最近在想：` + 原文截 1200 字符 |

实况（2026-10-14 16:05 群 940257985）：推理流原文（英文为主）整段贴群。

**二、卡点实测（探针 `tools/probe-text-summary.mjs`）**

| 模型 | max_tokens | 耗时 | content | 结论 |
|:--|--:|--:|:--|:--|
| `hy4-preview-f`（业务面主模型） | 500 | — | **空**（`finish_reason=length`，reasoning 1876 字） | 推理吃光预算 |
| `hy4-preview-f` | 4000 | **64.7 秒** | 有（质量尚可） | 太慢，播报不可用 |
| `deepseek-v4.1-flash` | 4000 | **2.0 秒** | 有（无推理，52 token） | ✅ 选它 |

→ `design-qqbotb-navigator.md` §十四 旧结论「该模型对长中文纯文本只产 `reasoning_content`、`content` 恒空」的**根因 = max_tokens 被推理吃光**，不是模型不产 content。`thinking:{type:'disabled'}` 被端点忽略（reasoning_tokens 仍 3511）。

**三、落地**

| 项 | 内容 |
|:--|:--|
| 摘要封装 | `app/src/navigator/shot.js` 新增 `summarize(text, options)`——端点与 `vision` 同源（业务面 api 池），提示词限「两三句中文 / 120 字以内 / 不复述原文」 |
| 播报接线 | `index.js` `composeActivity` 改 **async**；think 段走 `summarizeThink()`（缓存 → 摘要 → 失败回落原文截 600 字符）；调用点 `emitOutbound` 加 `await` |
| 缓存 | `thinkSummaryCache`（原文 → 摘要，上限 100 条）——同一段思考不重复请求 |
| 摘要出口可注入 | `createNavigator({ summarize })`——自测传替身，不真调 LLM |
| 配置 | `navigator.summary`：`enabled` / `model`（默认 `deepseek-v4.1-flash`）/ `timeoutMs`（20000）/ `maxTokens`（400）/ `maxChars`（4000） |

**四、验证**

| 面 | 结果 |
|:--|:--|
| 自测 | `tools/verify-navigator.mjs` **43/43**（新增「think 不倾倒原文」「摘要不可用回落原文截断」两断言） |
| 消费点实锤 | `node tools/probe-text-summary.mjs --via=shot --model=deepseek-v4.1-flash` → **3.4 秒**出 97 字摘要（走 `shot.summarize` 真实封装） |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真链路播报验收——等一次自然触发的「还在跑」播报（投递后 60 秒 / 手动 `POST /api/nav/analyze`） | 待触发 |
| 2 | 生效需**重启应用**（改的是单体源码 `app/src/`，非业务面补丁） | 待 Rushiera 主持 |
| 3 | 工具调用行（最近 6 次）与旁白（120 字）未动——本就是结构化短行，非原文倾倒 | 按需再议 |

---

## 五十四、前文整理抢救模式（2026-10-14 · v0.64）

> 触发：Rushiera「我领航员模式中的重建前文指令增加一个抢救模式，正常的重建前文是让该会话自己整理，额外使用抢救模式时，找一个空闲且没有参与内容的猫，去读那只猫的会话并且帮助他完成重建前文工作（majordomo优先）」。

**一、语义**

正常 `nav_reset` = 让**目标猫自己**做完整收工（落盘 + 推 git + 报告 + 交接摘要）→ 清前文 → 注入 → 继续。目标猫自己已经跑不动时（前文太长 / 无响应 / 产不出摘要）这条路走不通——抢救模式改由**另一只空闲猫代读**它的会话，产出交接摘要；之后的清前文 / 注入 / 继续与正常流程同一段实现。

**二、落地（`app/src/navigator/index.js`）**

| 项 | 内容 |
|:--|:--|
| 入口 | `nav_reset(key, text?, rescue?)`——业务面工具参数 + `POST /api/nav/reset` body `rescue`（另加 `dryRun`：只回显参数、不启动后台执行，自测用） |
| 选猫 | `pickRescueCat()`——`runState=idle` + 无待处理 + 非目标猫；**majordomo 优先**，其余按 `contextCount` 升序（越干净越优先） |
| 抓原文 | `grabCatSource()`——`keyinfo` 全量 → `traceText(items, 0)`；超 `navigator.rescueMaxChars`（默认 **600000**）时保留**头 30% + 尾 70%**、中段标省略；另附 `traceIndex()` **会话关键信息索引**（位置〔= 原文条号〕/ 角色 / 时间 / 首 120 字） |
| 代读 | 一条消息投给救援猫（含摘要六项要求 + 原文全文），要求不调工具、只输出摘要正文 |
| 等摘要 | `waitSummary()`——挂轮结束信号（不设时限）；回短话（< 200 字符）判「先回了一句」→ 催办一次继续等，最多 3 次 |
| 合流 | 摘要取到后与正常流程同路：材料存盘（标来源「抢救猫 X 代读」）→ `cat.new-session` → 注入「摘要 + 原文轨迹」→ 自动继续 → 投用户原话 |
| 不做 | 目标猫的落盘 / 推 git（它已跑不动；救援猫不在该项目上下文里）——摘要里标注遗留 |
| 失败保护 | 无可用猫 / 原文为空 / 摘要取不到 → 中止，**不清前文**（同正常流程） |
| 救援猫善后 | **不自动清**其前文（清前文不可逆，需人确认）——活动流留痕，需要时 `nav_new` |

**三、配置**

`navigator.rescueMaxChars`（默认 600000 字符）——代读原文上限，超出砍中段；另附**会话关键信息索引**（位置 = 原文条号，中段被砍的关键条仍留位置与首段）。

**四、验证**

| 面 | 结果 |
|:--|:--|
| 自测 | `tools/verify-navigator.mjs` **49/49**（新增 5 断言：干跑回执回显 rescue / 选中猫为空闲猫 / majordomo 空闲优先·忙时让位 / 原文抓取只读 / 源码代读段在位）；顺带修 rfRow 选猫——原选「在跑的第一只」（= 主干，真实 think 串扰导致「直接读 think」断言偶发失败），改选**空闲猫** |
| 业务面 | `tools/verify-qqagent-navtools.mjs` **9/9**（新增 nav_reset 参数面断言） |
| 补丁 | `patch-qqagent-navigator.mjs` → `src/nav-tools.js` **updated**；教材 `apply-qqagent-config.mjs --roletext-only` → `roleTextChars` 95123 → **95302** |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 生效需**重启应用**（改的是单体源码 `app/src/` + 业务面 nav-tools.js；教材另需业务面开新会话） | 待 Rushiera 主持 |
| 2 | 真链路验收——群里说「用抢救模式重建 X 的前文」跑一次全链（选猫 → 代读 → 摘要 → 重建） | 待触发 |
| 3 | 救援猫前文被代读原文占用（不自动清）——是否需要「用完即清」的开关 | 按需再议 |

---

## 五十五、群 361820329 静默不回——修复（2026-10-14 · v0.65）

> 触发：Rushiera「1和2都要做」（= §五十二 修法三步全执行）。承接 §五十二 的诊断，本节是修复实录。

**一、根因补全（B18）——阈值与端点容忍线错位 + 降级值污染基线 → 自锁**

| # | 环节 | 实锤 |
|:--:|:--|:--|
| 1 | 端点容忍线 | 单次 prompt 越过 ≈194k tokens（≈306k 字符）后端点不再推理——该群 17:50:02 `promptTokens=193,767 / promptChars=306,121` 仍正常，18:05:36 起 `promptTokens` 恒 14 |
| 2 | 轮转阈值 | `session.maxContextTokens=300000` **高于**端点容忍线 → `shouldRollover` 的估算值（`lastPromptTokens + pendingChars/1.5`）永远到不了阈值 → 轮转判据形同虚设 |
| 3 | 污染 | 端点降级仍回 200 + `usage.prompt_tokens=14` → `orchestrator` 的 `recordPromptTokens` 把 **14** 写成轮转基线（`session-state.json`：该群 `lastPromptTokens=14`） |
| 4 | 自锁 | 基线塌到 14 → `estimateContextTokens` 恒小 → `shouldRollover` 恒 false → `rollovers` 恒 0 → 前文只增不减 → 继续被降级 |

→ §五十二「其余群靠轮转截住」的推断**修正**：不是轮转救了别的群，而是别的群单轮 prompt（95k~120k）**还没撞线**；在 300k 阈值下轮转对**任何群**都触发不了。

**二、修法落地（B17 / B18 / B19）**

| # | 动作 | 落点与参数 |
|:--:|:--|:--|
| B17 | 清该群会话恢复 | `POST /api/chats/group_361820329/clear`（清 3168 条存档；清前整份备份到 `_unpack/data/messages/archive/group_361820329_manual-20261014.json`）——长期记忆 / 群记在 `data/memory/<chat>/`，不受影响 |
| B18 | 轮转阈值下调 **300000 → 160000** | `POST /api/config` 热写 `session.maxContextTokens`（≈82% 端点容忍线，对应 ≈253k 字符，留 ≈17% 余量） |
| B19 | 端点降级守卫 | `tools/patch-qqagent-session.mjs` 新增补丁点 `degrade-guard`（落 `orchestrator.js`）：回报 `prompt_tokens` 与本地组装量严重不成比例（`pt < chars/1.5/5` 且 `chars ≥ 20000`）时**不采信**（基线保持原值）并 `logger.warn` 出声 |

**三、验证**

| 面 | 结果 |
|:--|:--|
| 补丁 | `node tools/patch-qqagent-session.mjs --dry` → `degrade-guard` 命中 1 处；应用后 `node --check orchestrator.js` 0 错 |
| 恢复实锤（消费点） | 日志 20:51:21 / 20:53:14 两条 `[发送 -> group:361820329]`；`session-index` 该群最新 `status=done · promptTokens=121,611 · completionTokens=405` |
| 基线实锤 | `session-state.json` 该群 `lastPromptTokens` 14 → **60,857**（真实值） |
| 生效 | `启动QQBotB.bat` 一键全流程重启 → 业务面 20:52:43 起、OneBot 连接成功、`/api/chats` 正常；配置落盘 `maxContextTokens=160000` |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 端点为何以 200 + `usage{prompt_tokens:14, completion_tokens:28}`（恒定值）返回而非 4xx——未取证 | 待确认 |
| 2 | 端点容忍线精确值（仅观测 193,767 正常 / 14 异常的区间）——160000 是留余量的工程取值 | 待确认 |
| 3 | 守卫的**行为路径**（真降级发生时）未实机触发——本轮只验证到「boot 干净 + 逻辑命中 + 语法 0 错」 | 待触发 |

## 五十六、领航员「截全」+ 群内截图单猫会话（2026-10-14 · v0.66）

> 触发：Rushiera「开工qqbotB，打开领航员模式时的同步工作状态如果会话内容太多目前看来好像没有截全的样子 还是要截全，另外让群bot截图具体的某只猫的会话，我希望的不是浏览器截图而是这种内容，不影响其他的截图指令」。
> 指令：「对的 开工把，先用cdp，不行我之后改成分段拼接」——即 CDP 全页为首选，分段拼接为备选。

**一、诉求一 · 开场「同步工作状态」截不全——三处叠加**

| # | 位置 | 原值 | 后果 |
|:--:|:--|:--|:--|
| 1 | `app/main.js` `hooks.shot` | 截图高 `min(max(h,200), 4000)` | 内容超 4000px 底部直接裁掉 |
| 2 | `app/src/navigator/shot.js` `MAX_BLOCKS` | 40 | 单卡最多渲 40 块 |
| 3 | `app/src/navigator/index.js` 开场巡检 | `keyinfo(id, 20)` | 只取最后 20 条 |

**二、CDP 路线实测——不可用（改走原生整页截图）**

按指令先验 CDP `Page.captureScreenshot{captureBeyondViewport:true}`：

- 独立 electron 复现（`CatTemp/cdptest`）：`Page.getLayoutMetrics` 正常返回内容尺寸（如 7435px），但 `Page.captureScreenshot`（带/不带 `captureBeyondViewport`、带/不带 `Emulation.setDeviceMetricsOverride`）**卡死并拖垮渲染进程**——Promise 永不 resolve，进程随后退出。
- 线上后果：`/api/nav/shot` 请求挂起（实测 45 秒超时 abort），无日志。

→ CDP 方案**否决**（本机 Electron 44 实测不可用）；按指令的备选「分段拼接」亦未启用（见下——原生整页已够）。

**三、原生整页截图——可行（含 GPU 纹理上限的处置）**

- 原生 `win.setContentSize(800, H)` + `win.webContents.capturePage()`：H 取 `document.body` 实际高度。
- **GPU 纹理上限 16384px**：开硬件加速时 `capturePage` 在 H > 16384 报 `UnknownVizError`（实测 16384 OK / 17000 FAIL）。
- **处置**：`app.disableHardwareAcceleration()`（软件合成）——实测 `capturePage` 到 **40000px** 仍 OK。
- 安全上限 `SHOT_MAX_HEIGHT = 30000`（防超大 PNG 拖垮发群）。

**四、落地（v0.66 改动清单）**

| 文件 | 改动 |
|:--|:--|
| `app/main.js` | `app.disableHardwareAcceleration()` + `SHOT_MAX_HEIGHT`；`hooks.shot` 改原生 `setContentSize` + `capturePage`（去 4000 上限；日志记「内容高 → 取高」） |
| `app/src/navigator/shot.js` | `MAX_BLOCKS` 40 → **300** |
| `app/src/navigator/index.js` | 开场巡检改 `keyinfo(row.id, tourKeyinfoMax)`；新增 `shotSession()`；`POST /api/nav/shot` 接 `shotSession`（`send` / `chat` / `blocks` 透传） |
| `app/src/config.js` | `navigator.tourKeyinfoMax = 80` · `navigator.shotKeyinfoMax = 80` |
| `tools/navigator/nav-tools.js` | 新增业务面工具 `nav_shot`（把某猫会话画成卡发群；只读） |
| `tools/apply-qqagent-config.mjs` | 领航员教材加 `nav_shot` 一行（`roleTextChars` 95302 → **95412**） |
| `tools/verify-navigator.mjs` | +2 断言（会话截图·显式块出图 / 源码段在位）→ **51/51** |
| `tools/verify-qqagent-navtools.mjs` | 工具组 10 → **11 件** + `nav_shot` 定义面断言 → **10/10** |

**五、诉求二 · 群内截图单猫会话（`nav_shot`）**

- 形态：与开场巡检**同款会话卡**（复用 `shot.js` 的 `renderCard`；CH4 会话页对话气泡卡），**不是**浏览器开网页截的图。
- 链路：群内 @ → 业务面 R喵 调 `nav_shot(key)` → 单体 `POST /api/nav/shot`（`send:true`）→ `shotSession` 拉该猫会话（`keyinfo`，条数上限 `shotKeyinfoMax`）→ 渲染 → 截图 → 解读 → 发群。
- 只读：不给猫发消息、不改前文（要「它现在在干什么」用 `nav_analyze`）。
- 回消息群：`resolveChat`（显式 chat 优先，否则取新鲜 VIP 群消息所在群）。
- 边界：`browser-*` 等既有截图指令一律未动。

**六、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 六文件 0 错 |
| CDP 复现 | `CatTemp/cdptest` 独立 electron：CDP captureScreenshot 卡死（带/不带 clip、带/不带 Emulation 均复现） |
| 原生上限 | hw accel 关：16384 / 17000 / 20000 / 25935 / 40000 全 OK；开：16384 OK / 17000 FAIL |
| 真实出图（小） | `POST /api/nav/shot {key:R喵喵}` → 2.2 秒出图 |
| 真实出图（大） | `POST /api/nav/shot {key:majordomo}` → 800×**6314**px（超旧 4000 上限）；裁底 OCR 到底部末行「…然后直接动手推进未完成的事项。」——完整无截断 |
| 超长卡 | 合成 200 块 → 800×**24691**px；裁底 OCR 到底部为 **BLOCK-200**（末块在位）——远超 16384 上限仍截全 |
| 业务面 | `verify-qqagent-navtools.mjs` 10/10（工具组 11 件）· `verify-navigator.mjs` 51/51 |
| 生效 | 应用已重启（`启动QQBotB.bat`）；`_unpack` 侧 nav-tools.js 已同步（补丁 `patch-qqagent-navigator.mjs`） |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 群内真发群（R喵 调 `nav_shot` 出图回群）——需群内 @ 触发（自测不打扰真群） | 待群内实测 |
| 2 | 内容 > `SHOT_MAX_HEIGHT`（30000px）时仍会截尾——正常会话远未触及；再高需分段拼接 | 待触发 |
| 3 | 关硬件加速对界面渲染性能的影响（软件合成）——本应用界面轻，未观察到问题 | 观察 |

---

## 五十七、抢救模式·完整前文改造（2026-10-14 · v0.67）

> 触发：Rushiera 复核两次 majordomo 抢救——「我感觉R喵和R喵喵在重建前文抢救模式的时候没有携带majordomo的会话，我记得我要求是带600k的信息」；核实后指令：「改一下设计 我说的是600k，其中前部30% 尾部70%， 并且再额外加上关键信息（附带在正文中的位置）」。

**一、问题实锤（旧口径）**

| 项 | 实况 |
|:--|:--|
| 旧数据源 | `grabCatSource()` = `keyinfo` 全量 → `traceText`——只含「加载报告 / user / reply / roundsum」四类（CH4 `BuildKeyInfo` 口径），工具调用 / 思考 / 工具结果全不进 |
| 两次 majordomo 抢救（21:46 / 21:55） | 只抓到 **6 条 / 1,375 字符**、**2 条 / 4,182 字符** |
| 会话真体量（`data:sessions_ctx` 留档） | `majordomo_20261014_214616.txt` = **81,697 tokens**（≈23.5 万字符）· `_215522.txt` = **258,843 tokens**——旧口径只带过去千分之几 |
| 600k 上限 | `RESCUE_SOURCE_MAX` / `navigator.rescueMaxChars` 只是上限——旧链永远够不着 |

**二、改造（Rushiera 定）**

| 项 | 内容 |
|:--|:--|
| 数据源 | `keyinfo` → **`fullctx`**（`GET /api/v1/fullctx`，CH4 全条目：system / user / assistant / tool）——`ch4.js` 新增 `fullctx(key, max)` |
| 正文 | 全条目拼正文（每条带 `【#i 角色 时间】` 头）；**`system` 注入块不入正文**（接手方自带同类知识文件，且会吃掉头 30% 额度） |
| 截断 | 正文超 `rescueMaxChars`（默认 600000 字符）→ 保留**头 30% + 尾 70%**、中段标省略（原口径不变） |
| 关键信息索引 | `keyinfo` 四类保留——**位置改指正文**：`正文 #<条号>（第 <起始字符> 字符起）`；落在被省略段的关键条标「⚠中段已省略」（`keyIndex()`；时间匹配 fullctx 条目，匹配不到标「正文位置未定位」） |
| 落地文件 | `app/src/navigator/ch4.js`（+`fullctx`）· `app/src/navigator/index.js`（`grabCatSource` 重写 · 新增 `fullContextText` / `roleTag` / `keyIndex` · `traceIndex` 退役）· `app/src/config.js`（注释）· `design-qqbotb-navigator.md` §六b（代读 / 留痕行）· `tools/verify-navigator.mjs`（断言同步） |

**三、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 三文件 0 错（`navigator/index.js` / `navigator/ch4.js` / `config.js`） |
| 自测 | `tools/verify-navigator.mjs` **51/51**——其中「抢救·完整前文抓取」实测：majordomo 当前会话 **138 条 / 384,948 字符** + 索引 1,044 字符（旧口径同场只出 1,375 字符级） |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真链路验收——群内「用抢救模式重建 X 的前文」跑一次全链，核对正文规模与索引位置 | 待触发 |
| 2 | 600k 正文 ≈ 25 万 tokens 级——救援猫上下文压力（选猫已按「最干净」优先）；是否再设更低的软上限 | 按需再议 |
| 3 | 生效需**重启应用**（改的是单体源码 `app/src/`） | 待 Rushiera 主持 |

---

## 五十八、播报整条 LLM 精简（2026-10-14 · v0.68）

> 触发：Rushiera「群bot的领航员模式下还是会读完会话直接输出一大堆没有整理的内容，我需要他用llm思考精简成几十个字这种，而且这个需求已经做过一次，不知道为什么没有解决」。

**一、根因（v0.63 为什么没解决）**

| 项 | 实况 |
|:--|:--|
| v0.63（§五十三）作用域 | 只有 **think 段**——把思考原文压成两三句中文；播报其余段（`接的活` / `最近产出` / `最近工具调用（近 6 次）` / 旁白 / `正在写回复`）**原样保留** |
| 用户口径 | 「一大堆没有整理的内容」= **整条播报**，不只是 think——范围太窄即根因 |
| 群内误传纠正 | R喵 在群里答「改提示词/配置要新会话才吃到」**不成立**——播报摘要属自研单体 `app/src/` 代码面，生效条件是**重启应用**（新会话是业务面 R喵 自己的机制） |

**二、改造（方案 B——整条播报交一次 LLM）**

| 项 | 内容 |
|:--|:--|
| 出口 | `emitOutbound` ② 分支：先 `composeBrief(digest, rows)` 出「几十个字」正文——非空则 `body = head + brief`（就一句）；为空才回落分项素材（`progressFacts` + `composeActivity`）→ 再空走截图 + 视觉判读 |
| `head` | 保留：`⏳ <猫名> 还在跑·<label>，尚未回复` |
| 新增 `composeBrief(digest, items)` | 素材 = `progressFacts(items)` + `composeActivity(digest, {raw:true})`（思考段贴**原文**截断，供精简取材、不调 LLM）；整段素材交**一次** `shot.summarize`，提示词 `BRIEF_PROMPT`（一句话 / ≤50 字 / 说清在干什么·做到哪·有没有卡点） |
| 新增 `briefMaterial` | 素材拼装（事实行 + 分项活动） |
| `composeActivity` 签名 | 加第二参 `{ raw = false }`——`raw=true` 思考段走 `clipText(thinkSource, THINK_FALLBACK_MAX)`（不调 LLM）；缺省仍走 `summarizeThink` |
| `shot.summarize` | 支持 `options.prompt` 覆盖提示词（缺省 `SUMMARY_PROMPT` = think 摘要）——播报整条精简传入自己的提示词 |
| 新增常量 / 缓存 | `BRIEF_MAX = 120`（保底截断，提示词已限 50 字）· `BRIEF_PROMPT` · `briefCache`（素材 → 一句话；上限复用 `THINK_SUMMARY_CACHE_MAX`） |
| 不可用回落 | `summaryConf.enabled === false` / 素材空 / 调用异常 / 输出空 → 返回空串 + `record('watch','播报精简为空——回落分项素材')` |
| 配置 | **未新增配置项**——复用 `navigator.summary`（enabled / model / timeoutMs / maxTokens / maxChars），模型沿用快档 `deepseek-v4.1-flash` |
| 落地文件 | `app/src/navigator/index.js`（`BRIEF_MAX` / `BRIEF_PROMPT` / `briefCache` / `briefMaterial` / `composeBrief` / `composeActivity{raw}` / `emitOutbound` ② 分支 / 导出）· `app/src/navigator/shot.js`（`summarize` 支持 `options.prompt`）· `tools/verify-navigator.mjs`（+2 断言） |

**三、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | 改后经 `tools/verify-navigator.mjs` 加载（ESM 全链解析）无错 |
| 自测 | `tools/verify-navigator.mjs` **53/53**——新增「播报精简为空时不发正文（回落分项）」「播报整条精简（LLM 一句话）」两断言；既有「读全组装 / think 不倾倒原文 / 摘要不可用回落 / 抢救模式 / 轻通道 / 会话截图」全过 |
| 真链路 | **已验收**（2026-10-14 23:40，应用重启后 `POST /api/nav/analyze` 触发 rb 播报）——群 689942975 实际输出 = `⏳ rb 还在跑·v0.68 verify，尚未回复` + `它正用 curl 重发分析请求验证 v0.68，重启部署中，暂无卡点。`（head + 一句话，约 30 字） |

**四、真链路暴露的二次根因——max_tokens 被推理吃光 🔴**

首次真链路（23:36）**回落了分项素材**（日志 `播报精简为空——回落分项素材`）。排查：

| 步 | 证据 |
|:--|:--|
| 1 | `summarize` 返回空串且**无** `think 摘要失败` / `端点未配置` 告警 → 端点 200 但 `content` 为空 |
| 2 | 探针复验（`probe-text-summary.mjs --via=shot`）think 样本 2.5 秒出稿 → 链路本身可用 |
| 3 | 探针喂**真实量级素材**（~1500 字符）→ `usage` 显示 `reasoning_tokens=351` / `completion_tokens=375`（上限 400）——**推理链吃掉绝大部分 `max_tokens`**，素材再长一点即 `content` 恒空 |
| 4 | 定性 | 快档 `deepseek-v4.1-flash` 也是**推理模型**——`maxTokens=400` 对整段播报素材不够；旧 think 摘要（单块思考）勉强够，故 v0.63「看着能跑」 |

修法：`navigator.summary.maxTokens` **400 → 1500**（`config.js` DEFAULTS + `index.js` `SUMMARY_DEFAULTS` 同步）；`shot.summarize` 增**空内容告警**（记 `finish_reason` + `reasoning` 字符数，落 `[WARN]`）——把此类静默失败转成可见。探针 `tools/probe-text-summary.mjs` 增 `--prompt=` / `--sample-file=`（喂自定义提示词与真实素材复验）。

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 「播报精简」与「think 摘要」共用 `navigator.summary`（含 `maxTokens`）——若需独立控制，另加配置项 | 按需再议 |
| 2 | 素材再长（think 上万字符）时推理链仍可能触顶——`maxChars=4000` 已限素材长度；必要时再抬 `maxTokens` 或压素材 | 观察 |
| 3 | 生效需**重启应用**（已执行 ×2：首版 + maxTokens 修） | ✅ |

---

## 五十九、前文整理·报告分次收集（2026-10-15 · Rushiera 定）

> 触发：Rushiera 复核重建后的材料体量——「将近 1m 字符的会话被压缩到 10k 实在不可思议……我希望尽可能保留信息，以需要继续会话的信息为主」；方案选定：**只改输出报告**（正常 / 抢救两个模式一起改），不动前文注入面、不读文件。

**一、问题实锤**

| 项 | 实况 |
|:--|:--|
| 材料构成 | `摘要（猫自述 / 抢救猫代读） + 原文轨迹（keyinfo 四类）` |
| R喵 案例材料 | 22,333 字节 ≈ 13.55k 字符（用户反馈的「13.55k」） |
| **报告本体被截断** | 翻 CH4 完整前文留档 `data:sessions_ctx/639259389468574799_20261014_195206.txt`——R喵 收工输出标 `[[content 5786]]`，**断在第五节**（「（受 ASCII + CRLF」），第六节（不确定点）、第七节（用户原始要求）**整段丢失** |
| 截断根因 | CH4 请求体（`Mau.Providers/DeepSeekLlmRuntime.Serialize.cs` → `BuildChatRequestBody`）**不带 `max_tokens`** → 单条 assistant 输出上限由端点默认值定；同会话 assistant 输出无一超 5786 字符（tool 回执可到 74 万字符） |

**二、改造（只改输出报告）**

| 项 | 内容 |
|:--|:--|
| 口径 | 报告**以「接手方能无疑问地继续」为准**——继续工作所需的一切（结论 / 数据 / 路径 / 参数 / 原话）都写进去；旧的、不再需要的信息可以略过；篇幅不设上限 |
| 输出方式 | prompt 要求**分多次消息输出**（每次几个小节），**全部写完时最后一条以 `【整理完毕】` 结尾** |
| 收集 | 新增 `collectReport()`（替代 `waitSummary` 与正常模式的单次 `waitForReply`）——**逐轮收集拼接**：①先回一句短话 → 催正文；②正文未完（无完成标记）→ 催续写；首轮不设时限、续写轮 300 秒上限；轮数上限 12、总长上限 200k 字符（安全阀） |
| 两模式合流 | 正常模式（猫自述）与抢救模式（救援猫代读）**都走 `collectReport`** |
| 落地文件 | `app/src/navigator/index.js`（`RESET_REPORT_DONE` / `RESET_REPORT_MAX_ROUNDS` / `RESET_REPORT_MAX_CHARS` / `RESET_REPORT_WAIT_MS` · `collectReport` · 两处 prompt · 两处调用）· `tools/verify-navigator.mjs`（+1 断言） |

**三、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check app/src/navigator/index.js` 退出 0 |
| 自测 | `tools/verify-navigator.mjs` **54/54**（新增「报告分次收集段在位」） |

**四、注入面收尾（同日 · Rushiera 定）**

| 项 | 内容 |
|:--|:--|
| 标题统一 | 材料与注入标题「交接摘要」→「**交接报告**」（正文口径上轮已改，本轮统一称谓）；注入头改「【上一段会话的交接报告】」，尾注改「以上是你上一段工作的交接报告（前文已按此重置，你的记忆就靠这份材料）」 |
| 轨迹**不注入** | `resetSession` 注入面只留报告——「【上一段会话原文轨迹】」段整体移除；轨迹仍抓取（清前文前）但**只落盘**（材料文件标「仅落盘备查，不注入前文」）。依据：用户口径「原文轨迹属『不再提及就不需要』的信息——归档即可，前文只装接手方继续干活所需」 |
| 轮数放宽 | `RESET_REPORT_MAX_ROUNDS` 12 → **30**——实测单条约 5.8k 字符，12 轮封顶约 69k，够不到「宁多勿漏」；字符安全阀 200k 不变（对应用户「后文 240k 可接受」的射程） |
| 死常量清理 | 删除 `RESCUE_RETRY_MAX`（上一轮改 `collectReport` 后已无引用） |
| 落地文件 | `app/src/navigator/index.js`（注入段 / 材料块 / 常量与注释口径）· `tools/verify-navigator.mjs`（断言同步 + 新增「原文轨迹只落盘不注入」） |

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真链路验收——重启应用后跑一次 `nav_reset`，核对报告条数与体量（是否 >5786 且含完成标记） | 待触发 |
| 2 | 生效需**重启应用**（改的是单体源码 `app/src/`） | 待 Rushiera 主持 |

---

## 六十、安静模式（2026-10-16 · Rushiera 定 · v0.71）

> 触发：Rushiera 2026-10-16 13:03 经领航员轻通道投递——「开工qqbotB，给群加一个安静模式，这个按钮开关放在记忆区，处于这个模式的群聊能不发言就不发言，被@了要能回，存档和记忆功能不受影响，可以改为6个小时一次，不发言只整理」。

**一、语义与口径**

| 项 | 内容 |
|:--|:--|
| 开关位置 | 记忆页（群记卡片）——列表徽标 + 详情「🤫 安静模式」按钮，写 `config.engage.quiet.chats`（群号字符串数组） |
| 安静群行为 | **不参与闲聊**（非 @ 消息只入库、不进 LLM）；**被 @ / 拍一拍 立即触发**走普通轮（可发言）；每 `intervalMs`（默认 6 小时）跑一次「**只整理不发言**」的记忆沉淀轮 |
| 存档与记忆 | 不受影响——消息照常入库、归档与记忆整理照常 |
| 默认值 | `config.engage.quiet = { enabled: true, chats: [], intervalMs: 21600000, organizeOnly: true }`——未显式加群前对现网**零影响** |

**二、实现（复用收工轮）**

| 面 | 落点 |
|:--|:--|
| 模块 | 新增 `src/quiet-mode.js`——导出 `quietEnabled` / `quietChats` / `isQuietChat` / `quietIntervalMs` / `quietHint`（零依赖，只读配置） |
| 节拍拉长 | `orchestrator.js` `#noteBrowsePending` 与 `#browseTick` 两处按安静间隔重排——安静群下一拍 = now + `quietIntervalMs()` |
| 到点整理轮 | 到点且有未读 → `wake(chatKey, { quietOrganize: true })`；无未读零动作 |
| 强制收工语义 | `isRollover` 并入 `quietOrganize \|\| shouldRollover(...)`——复用既有收工轮全套（发送类工具移除 + 写群记 / 印象 / 要点 / 话题词 + 归档轮转 + `resetSession`） |
| 指令分叉 / 收尾标记 | `rolloverInstruction('quiet')`；`finishReason` 记「安静整理轮（定时沉淀）」 |
| 提示段 | 每轮追加【安静模式】段（不闲聊 / 点名才回应 / 6 小时只整理一次） |
| 静默补拍 | 安静群**不走**静默补拍（`!due && !quiet && idleFireDue`） |

**为什么复用收工轮：** 收工轮已具备「不发言 + 写群记 / 印象 + 归档」全套；安静整理轮只需 `quietOrganize: true` 强制 `isRollover=true`，避免另造一套。

**三、交付物与规模**

| 文件 | 规模 |
|:--|:--|
| `tools/patch-qqagent-quiet.mjs` | 427 行 / **23 补丁点**（新增文件 1 + `config.js` 1 + `orchestrator.js` 8 + `ui/app/05-memory-settings.js` 7 + 说明段） |
| `tools/verify-qqagent-quiet.mjs` | 199 行 / **24 项断言**（判定 5 + 提示段 3 + 源码落点 4 + 链路端到端 3 + 其余） |
| `_unpack/resources/app/src/quiet-mode.js` | 新增（61 行） |

**四、踩坑（务必延续的惯例）**

| # | 现象 | 根因 / 修法 |
|:--:|:--|:--|
| 1 | 补丁首跑后自测 FAIL 2 项 | 4 个补丁点（`orchestrator-hint-append` / `runagent-call` / `ui-list-quiet-html` / `ui-detail-quiet-html`）用 `appliedIf` 做幂等检测，但替换文本里**没有内嵌标记**——检测不到 |
| 2 | 修法 | 替换文本内嵌 `[qqagent-quiet-patch:<id>]` + 4 处源文件回滚 + 重跑（applied 4 / skipped 19）→ 幂等确认（applied 0 / skipped 23）→ 自测 24/24。**新补丁点一律「标记内嵌 + 默认标记检测」**，勿用 `appliedIf` 替代 |

**五、自测与落地**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check`（4 文件）全过 |
| 补丁 | 首跑 applied 23 / skipped 0；重跑 applied 0 / skipped 23（幂等） |
| 自测 | `node tools/verify-qqagent-quiet.mjs` **24/24**（隔离目录 `runtime/.quiet-selftest`） |
| 补丁链位置 | **链尾**（依赖 `patch-qqagent-engage.mjs` / `patch-qqagent-browse.mjs` 产物——锚点落在浏览节拍巡检上） |
| 应用重启 | `启动QQBotB.bat` 一键全流程（停旧实例 → 清锁 → 开会话 `mvaj0chg-f14f7c3f` → 起新单体）；启动输出正常（`roleTextChars` 95412） |
| 重启后核验 | 进程（electron ×4 · QQ Agent ×4 · PID 45988/45540 起于 13:27:33-35）· 业务面 `_unpack/data/config.json` 含 `engage.quiet` 段（205–210 行）· 源码 23 处标记 + `quiet-mode.js` 在位 |
| 真链路验收 | **待触发**——需 Rushiera 指定测试群（临时把 `intervalMs` 调小观察整理轮），验四点：①普通消息不触发发言 ②@ 能回 ③到点出「安静整理轮」（不发言 + 写群记 / 印象 + 归档）④存档与记忆照常 |

**六、边界（不做）**

- 不在安静群直接禁用触发（那样连 6 小时整理轮都没了，与「存档和记忆不受影响」相悖）
- 不在发送面硬拦（「@ 能回」靠触发面控制——发送面拦会一并拦掉点名回应）
- 不新建独立巡检器（复用浏览节拍巡检，少一个定时器）
- 默认 `chats: []`——未显式加群前对现网零影响

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 真链路验收（选一个非在用的群，`intervalMs` 临时调小如 60000） | 待 Rushiera 指定测试群 |
| 2 | 群侧：Rushiera 群里曾说「一会R喵喵做完了就给你开安静模式」——需她指认目标群 | 待确认 |

---

## 六十一、会话截图「截全」适配长会话（2026-10-16 · Rushiera 定 · v0.72）

> 触发：Rushiera 2026-10-16 23:18 开工指令——「我让群bot截图的时候感觉还是截不全，你看一下majordomo的会话现在很长了，我希望能适配」。
> 前情：v0.66（§五十六）已做过一轮「截全」（块数 40→300 · 条数 20→80 · 去 4000px 硬墙改原生整页 + 关硬件加速）；本轮是**会话规模又上一个量级**之后的第二次。

**一、诊断（两处硬截 · 实测数据）**

| # | 卡点 | 实况 |
|:--:|:--|:--|
| 1 | **条数**：`shotKeyinfoMax = 80` | majordomo 当前 keyinfo **236 条**（`GET /api/v1/keyinfo?max=1` → `count=236`）——只取末尾 80 条，**头部 156 条被丢**（截图首条 = 第 157 条「继续把，另外我希望有些内容能记下来…」） |
| 2 | **高度**：`SHOT_MAX_HEIGHT = 30000` | 80 条 = 19,635–20,198px；**全量 236 条 = 63,496px**（实测）——就算放开条数，单图也必被截尾 |
| 3 | 体积 | 80 条单张 PNG = **3.5MB**；全量单张 ≈ 10MB 级——超长单图 QQ 会压、手机上不可读 |

> 触发那一下的实况：23:02 群里 @「截一下majordomo的会话」→ 23:04 出图 3.5MB，她回「怎么没截全」「这已经是打完之后的会话了」。

**二、口径（截全）**

| 项 | 内容 |
|:--|:--|
| 条数 | **全量**——`navigator.shotKeyinfoMax` 80 → **0**（0 = 不限；端点 `?max=0` 即全量回传） |
| 高度 | 超过 `navigator.shotSegmentHeight`（默认 **12000px**）→ **按段截、按序发多张**（`1/N`…`N/N`）——长会话不再撞单图上限 |
| 段数安全阀 | `navigator.shotSegmentMax`（默认 **12**）——超出只发**尾部** N 段，首张标注「更早 N 段未发」（不静默丢，活动流留痕） |
| 解读 | 只对**最后一段**做视觉解读（最新内容）——长会话整幅解读没有意义 |
| 短会话 | 不变——内容不超段高仍**一张**（`segments=1`）；轮结束截图 / 开场巡检 / 轻通道一律走单张口径 |
| 块数上限 | `MAX_BLOCKS` 300 → **1000**（高度已由分段兜底，块数只作最后一道网） |

**三、实现**

| 文件 | 改动 |
|:--|:--|
| `app/main.js` | `core.hooks.shot(htmlFile, outFile, { segmentHeight })` 两态：①单张（缺省 / 内容不超段高）——v0.66 口径不变 ②分段——窗口逐段取高 + `window.scrollTo` 滚动截取，逐段写 `-01.png` / `-02.png`…；回执改对象 `{ files, total, height, count }`（原为裸路径串）；`webPreferences.backgroundThrottling: false`（隐藏窗口默认节流渲染——滚动后必须重绘） |
| `app/src/navigator/shot.js` | 新增 `capture(options, segmentHeight)`（渲染 → 交壳层 → 归一结果，兼容裸串回执）+ `shootSegments()`；`shoot()` 改为 `capture(…, 0).files[0]`（调用面不变）；`MAX_BLOCKS` 300 → 1000 |
| `app/src/navigator/index.js` | `shotSession`：keyinfo 取全量 · 走 `shootSegments` · 段数安全阀取尾部 · 按序发多张（`（k/N）`，解读挂最后一段）· 回执增 `files` / `segments` |
| `app/src/navigator/ch4.js` | `keyinfo(key, max)`：`max ≤ 0` → `?max=0`（全量）——原实现 `Number(max) \|\| 12` 会把 0 当 12 |
| `app/src/config.js` | `shotKeyinfoMax` 80 → **0** · 新增 `shotSegmentHeight = 12000` · `shotSegmentMax = 12` |
| `tools/navigator/nav-tools.js` | `nav_shot` 工具描述改「会话卡截图（**长会话自动分段、按序发多张**，标注 `1/N…N/N`）」——与实况对齐 |
| `tools/apply-qqagent-config.mjs` | 领航员教材 `nav_shot` 行同步（「画成一张卡」→「画成卡截图…长会话自动分成多张按序发」）；`--roletext-only` 重跑，`roleTextChars` 95412 → **96236**（差额含源码侧先前未落盘的增量） |
| `tools/verify-navigator.mjs` | 替身回执改对象；新增「分段（多张按序带出 + 段数安全阀取尾部）」「分段口径源码在位」两条断言；源文件在位断言随发群分支改写 → **57/57** |

**四、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 五文件 0 错（`main.js` / `navigator/shot.js` / `navigator/index.js` / `navigator/ch4.js` / `config.js`） |
| 自测 | `node tools/verify-navigator.mjs` **57/57**（+2 断言） |
| 真链路（全量·分段） | `POST /api/nav/shot {key:majordomo}`（send:false）→ **内容高 63,496px → 6 段 × 12000px**，产物 `nav-shot-…-01.png` ~ `-06.png` 六张在位（旧口径同场只出 1 张 19,635px） |
| 真链路（分段切的是对应切片） | 合成 552 块长卡（每块带 `FILLER-n` 标号）→ 2 段；第 2 段 OCR 到底部 = `FILLER-491…FILLER-550` + `TAIL-MARK-END`——**证明逐段截取取到的是对应切片**（无重复首段 / 无陈旧帧） |
| 真链路（短会话不回归） | 2 块小卡 → `segments=1`，单张 200px（与 v0.66 行为一致） |
| 生效 | 应用已重启（`启动QQBotB.bat` 一键全流程 · 16:52）；`boot.log` 分段日志在位 |

**五、边界（不做）**

- 不动**轮结束截图 / 开场巡检 / 轻通道**的口径——那三处是「单轮回复」「每猫概览」，仍走单张；本轮只改群内显式「截一下 X 的会话」
- 不启用 CDP 分段拼接（`Page.captureScreenshot` 在本机 Electron 44 卡死，v0.66 已否决）——分段用原生 `setContentSize` + `scrollTo` + `capturePage`
- 不引入图片压缩 / 缩放（分段后每段体积已在 1MB 级，无需再压）

**遗留 / 待确认：**

| # | 项 | 状态 |
|:--:|:--|:--|
| 1 | 群内真发群（`nav_shot` send:true → 六张按序回群 + 解读）——需群内 @ 触发（自测与本地取证都不打扰真群） | 待群内实测 |
| 2 | 段高 12000px / 上限 12 段是初值——若手机上看着太长或太糊，调 `navigator.shotSegmentHeight` 即可（0 = 退回单张） | 待体感反馈 |
| 3 | 开场巡检（`tourKeyinfoMax=80`）仍是「概览口径」——按群逐猫一张，未跟进全量分段（防刷屏） | 设计如此，可按需改 |
| 4 | 工具描述与教材已落盘（`patch-qqagent-navigator.mjs` 已同步 `_unpack` 侧 `nav-tools.js`；`apply-qqagent-config.mjs --roletext-only` 已写配置）——**生效需业务面重启 / 新会话**（本轮未再重启：避免打断群内正在进行的对话） | 待下次重启 |

## 六十二、记忆不节流：写入放开 + 归档 + 索引 + 检索（2026-10-16 · Rushiera 定 · v0.73）

> 触发：Rushiera 2026-10-16 开工指令——「我感觉现在记忆区的这种记忆方式有点跟不上群友，记忆的内容太少了，你正好读一下现在已经运行一段时间了，有很多存档，你看各个群的记忆应该怎么设置更好」；同日补口径——「记忆不需要节流，写的多不是坏事，但要能归档能索引」。
> 设计 → `design-qqbotb-memory.md` §3.10。

**一、诊断（全量读档 8 群 · 硬数据）**

| # | 病灶 | 实况 |
|:--:|:--|:--|
| 1 | 沉淀口只有收工轮一条窄路 | 印象密度只跟轮转次数相关：1097492606 轮转 7 次 → 31 条印象；512942437 / 112562956 / 785638698 各 200~300 KB 聊天记录、`rollovers=0`、`startedAt=0` → 群记与印象**从未被收工轮写过**。模型主动写那条路不可靠（代码注释自记「实测模型日常几乎不主动调 memory_append」），而 `memoryRules()` 引导只存在于 full 模式，现行 `systemPromptMode=lean` → 模型读不到任何记忆引导 |
| 2 | 群记被领航场次灌满 | `sedimentVoyage` 每次关闭都写一条 `kind=project`，0 秒 0 指令空场照写。689942975 的 40 条上限里 28 条场次（其中 18 条 0 分 0 秒），淘汰策略「保留最后 N 条」→ 真实 lore / rule / relation 被顺序挤出 |
| 3 | 三个上限三个数 | 代码 `MAX_ENTRIES=40`（话题另限 12）· 配置 `maxGroupEntries=20` · 重整提示词写死「最多 20 条」 |
| 4 | 写了也注入不到 | 人档无过滤时最多 20 位群友 × 每人 5 条 → 30+ 人的群一半人进不了提示词；重整面口径「宁少勿错」与写入面「宁可多记」互相抵消 |

**二、口径（写入不节流 · 归档 · 索引 · 检索）**

| 面 | 内容 |
|:--|:--|
| 写入 | **不设上限、不淘汰**——群记软上限 200 条（话题 24）、单条 400 字；超软上限**转归档**（原「淘汰最旧」= 丢信息） |
| 归档 | `data/memory/<chat>/archive/group-<yyyyMMdd>.jsonl` · `archive/member-<yyyyMMdd>.jsonl`——append-only、按天分卷；三类入档：溢出、重整改掉的旧条目、无实绩场次 |
| 索引 | `data/memory/<chat>/_index.json`——现行池分类计数（byKind）+ 归档计数，每次写入后重建 |
| 检索 | 新工具 **`memory_search`**——跨现行池 + 归档按关键词搜（`category` = all / member / group；回执带 `archive` 计数） |
| 注入 | 仍有预算（提示词是硬预算）：群记每类最近 12 条 + 话题 12 条、人档每人最近 8 条 / 最多 30 人；**被截下的条数与归档量在段尾明示** |
| 沉淀拍 | 新增冷群兜底：节拍到点 && **无未读** && 距上次沉淀 ≥ `memory.sedimentIntervalMs`（12h，0=关）→ 走一次「只整理不发言」的整理轮 |
| 场次 | `sedimentVoyage` 加实绩判据（≥60 秒 / 有指令 / 有截图 / 有播报 / 有巡检任一），空场只留活动流 trace |

**三、实现（补丁点 24 + 3 个新脚本）**

| 文件 | 改动 |
|:--|:--|
| `src/group-memory.js` | 常量放宽 + `saveEntries` 溢出转归档 + 新增 `archiveGroupEntries` / `listArchivedGroupEntries` / `groupArchiveStats` / `rebuildGroupIndex`；`setGroupTopics` 不再静默截断；`formatGroupForPrompt` 注入预算 + 段尾指针 |
| `src/memory.js` | 注入常量（每人 8 / 30 人）+ 段尾归档指针；新增 `memberArchiveStats` / `searchMemberArchive`；`replaceConsolidated` 去掉总量上限 + 重整前把被改掉的旧条目写进归档 |
| `src/tools.js` | 新增 `memory_search`（跨现行 + 归档检索） |
| `src/prompt.js` | `memoryRules()` 改口径（「用得上就记，不怕多」）；**lean 模式补记忆引导**（原漏在 lean 之外） |
| `src/config.js` | `memory.*` 默认值：`maxImpressionsPerMember` 8→40 · `maxGroupEntries` 20→60 · `consolidateMinIntervalMs` 6h→3h · `discoverMinMessages` 5→3 · `discoverMaxMembers` 6→10 · 新增 `sedimentIntervalMs=12h` |
| `src/orchestrator.js` | 群记重整上限跟随配置 + 提示词去掉「宁少勿错」；人档 cap 去掉「最多 +2」；新增 `#sedimentDue` 与沉淀拍分支（无未读才走）；整理轮标签 |
| `src/routes.js` | 记忆列表 / 详情带归档计数与归档条目 |
| `ui/app/05-memory-settings.js` | 列表项与群记标题行显示「归档 N 条」 |
| `tools/patch-qqagent-memory.mjs` | 新增 24 个补丁点（`no-throttle-*`）+ 幂等兜底（锚点被后续补丁搬走时按替换体首尾行判定已应用） |
| `tools/patch-qqagent-session.mjs` / `patch-qqagent-navigator.mjs` | 同步幂等兜底；`orchestrator-run-signature` 锚点跟随 quiet 补丁后的真实签名 |
| `app/src/navigator/index.js` | `sedimentVoyage` 加实绩判据；`buildVoyageLog` 回执带 `stats`，`close()` 透传 |
| `tools/migrate-qqagent-memory-archive.mjs`（新） | 存量迁移：空场次下沉归档 + 重建索引（可重放） |
| `tools/apply-qqagent-memory-limits.mjs`（新） | 参数热写：走业务面 `POST /api/config` + 写后复核（判例 v0.58——直改 `_unpack/data/config.json` 不生效） |

**四、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 七文件 0 错 |
| 自测 | `verify-qqagent-memory.mjs` **43/43**（新增 7a–7g 不节流/归档/索引/检索、8a–8c 沉淀拍与默认值）· `verify-qqagent-session.mjs` **20/20** · `verify-qqagent-memory-reach.mjs` **13/13** · `verify-navigator.mjs` **57/57** · `verify-qqagent-navtools.mjs` **10/10** · `verify-import-integrity.mjs` ALL PASS（60 文件 / 317 符号） |
| 存量迁移 | 真实数据目录：689942975 移出 18 条 0 秒空场进归档，现行群记 64 → 46（lore 5 / rule 4 / relation 1 / project 24 / topic 12）· 其余 6 群建索引 |
| 参数热写 | `maxImpressionsPerMember=40` / `maxGroupEntries=60` / `consolidateMinIntervalMs=10800000` / `discoverMinMessages=3` / `discoverMaxMembers=10` / `sedimentIntervalMs=43200000`——写后读回逐项一致 |
| 真链路 | 记忆页 API：`/api/memory-files` 回执含 `groupArchived` / `memberArchived`；`/api/memory-files/group_689942975` 回执含 `groupArchived`（18 条）与 `archiveStats`；`/api/tools` 里 `memory_search` 已注册 |
| 生效 | 应用已重启（`启动QQBotB.bat` 一键全流程）；启动会话 `roleTextChars=95412` |

**五、边界（不做）**

- 不做向量化 / 语义检索——本轮只做「关键词 + 归档」，向量库等真出现「关键词搜不到」的判例再上（`勿增实体`）
- 不改注入段的段落顺序（前缀缓存）——预算只减条数，不动结构
- 不动群隔离铁律：归档与索引同样以 chatKey 为键，禁止跨群读取

---

## 六十三、回应参数（每个群友 0~100 分 · v0.74 · 2026-10-18）

**一、规格（Rushiera 2026-10-18 口述）**

> 群 bot 回消息有点读不懂空气。设计一个回应参数：所有群友初始 100，如果群友自顾自说完全没有理你，这个数字要降低；映射到对这位群友回复的硬限制速率上——回应参数为 0 的群友，每 20 分钟最多回他 1 次。识别出危险信号（有人觉得你烦 / 让你安静 / 其他侵略性表述）也要降。忽视也要降（群友在说一个话题、你给了回应，但他完全不参考你的发言，你的内容对下一个沟通构不成影响）。但他在问你、哪怕就是敷衍话术（嗯嗯好好），或者他下一句明显参考了你说过的内容（尤其是带上了你的结论），这种就不降——需要分清"不想跟你聊一直在转移话题"与"相同话题继续"。先简单写一些提示词加进前文并完成回应参数适配，可以让群 bot 自己调；对群里的群友个体进行，加到记忆里，要能看到一个群友的回应参数。自愈机制始终开着，软件自动加分、不带 LLM，每隔一段时间给所有不足 100 的加分。

**语义拆解：**

| 面 | 落点 |
|:--|:--|
| 分数 | 每人 0~100，初始 100；按**群友个人**记（每会话一份） |
| 映射 | 线性：`cooldown = (100 − score)/100 × maxCooldownMs`（默认 1200000ms = 20 分钟） |
| 判定 | 交模型（工具 `adjust_rapport` + 系统提示教程）——不写本地内容规则 |
| 闸门 | 出站口（系统硬限速）——模型克制不住"回太勤"，必须系统兜底 |
| 自愈 | 纯本地定时器加分（不带 LLM） |
| 可见性 | 记忆页 + `GET /api/rapport/<chat>` + `_rapport.json` |

**二、设计要点**

| 面 | 设计 |
|:--|:--|
| 载体 | `data/memory/<chat>/_rapport.json`——`{ chatKey, members: { <QQ>: { score, name, updatedAt, lastDeltaAt, lastReason, log[] } }, updatedAt }`；**只存 `score<100` 的条目，回满即删**（默认态不占盘） |
| 状态机 | 内存缓存 `Map(chatKey → Map(QQ → entry))`；变更即整份落盘（原子写：`tmp` + `rename`） |
| 闸门顺序 | bot 指定限频（§七）→ **回应参数（本节）** → 发言硬限（§八）→ 发言配额（§四）→ 分钟 / 小时技术限频。被本节拦下的发送抛错在记账之前，不消耗后面任何额度 |
| 判定"回谁" | 显式点名（`atUserId` / 拍一拍目标）优先；否则本轮运行目标（触发批最后一条的发送者）；**不限名单**（所有人都有回应参数，与 botGuard 的名单制不同） |
| 记账粒度 | 一次回复 = 一轮运行（`setRunRapportTarget` / `clearRunRapportTarget` 划界）；本轮第一笔发送放行后不再重复判定；记账在 `#markSent`（发送成功之后） |
| 提示面 | ①系统提示【回应参数：看人下菜碟】教程段（lean + full 都带，约 700 字符）；②每轮用户消息末尾【回应参数】段（与配额同段，只列本轮相关且 <100 的群友：分数 + 系统硬限 + 上次理由） |
| 自愈 | `startHealLoop()` 在宿主启动时起一次（`app.js` 启动流程，紧跟 `startBrowseLoop`）；每 `healIntervalMs`（默认 300000ms）`healAll()`：扫 `memory/` 下全部 `group_*/private_*` 目录（冷群也回升），给不足 100 的 +`healPerTick`（默认 2），回满删条目；**只打一行 `logger.info`，不调 LLM** |
| 回退 | `engage.rapport.enabled=false` → 闸门与自愈都关（分数保留） |
| 提示段纪律 | 工具回执明写「不要向群里说"我调了你的回应参数"」——与 bot 的群友身份一致 |

**三、降 / 不降判据（教程原文骨架，落 `prompt.js`）**

| 该降 | 不降 |
|:--|:--|
| 你回了话，他完全不接、继续自说自话 | 他下一句明显参考了你说过的话（尤其带上了你结论里的词） |
| 你的话对他的下一句没有任何影响 | 他直接问你、点名你 |
| 他说"不用你说话""安静点""太吵了"、明显不耐烦或阴阳你 | 他回你"嗯嗯""好""草"这类敷衍——**敷衍也是在听** |

**分清两件事：** 同一话题继续往下讲、只是没接你那句 → 小降或不降；**一句一个话题地跳开、每次都绕开你 → 那是转移话题，降**。

**四、实现（补丁 28 点 + 1 个新模块）**

| 文件 | 改动 |
|:--|:--|
| `src/rapport.js`（新） | 存储（`_rapport.json` + 内存缓存 + 原子写）/ `cooldownForScore` / `getRapport` / `adjustRapport` / `setRapport` / `listRapport` / `formatRapportHint` / `healAll` / `startHealLoop` / `stopHealLoop` |
| `src/config.js` | `engage.rapport` 默认段（enabled / maxCooldownMs / healPerTick / healIntervalMs） |
| `src/sender.js` | import + 两张表（`rapportReplyTimes` / `rapportRuns`）+ `#checkRapport` 第二道闸门 + `setRunRapportTarget` / `clearRunRapportTarget` / `rapportWindow` / `#markRapportReply` + `#markSent` 记账 |
| `src/orchestrator.js` | import + 每轮设置"在回谁"（含 finally 清理）+ 每轮【回应参数】提示段 |
| `src/tools.js` | import + 新工具 `adjust_rapport`（userId / delta / reason；回执 before / after / cooldownMinutes） |
| `src/prompt.js` | `rapportRules()` 教程段 + lean 与 full 两处挂载 |
| `src/routes.js` | import + 记忆详情回执带 `rapport` + 新路由 `GET /api/rapport/<chat>` |
| `src/app.js` | import + 启动流程起自愈定时器 |
| `ui/app/05-memory-settings.js` | 群友印象卡徽标（「回应 68」）+ 群成员表「回应」列（<80 标红）+ 详情页取 `mem.rapport` + 成员表取 `/api/rapport/…` |
| `tools/patch-qqagent-rapport.mjs`（新） | 28 补丁点 · 链尾 · 幂等可重放 |
| `tools/verify-qqagent-rapport.mjs`（新） | 40 项自测 |

**五、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 八文件 0 错（rapport / sender / orchestrator / tools / prompt / routes / app / 05-memory-settings） |
| 自测 | `verify-qqagent-rapport.mjs` **41/41**——含映射（0/50/90 分）、闸门（放行 / 同轮不重复 / 下一轮被拒且没发出去 / 显式 @ 与拍一拍走同一闸 / 冷却过期重放 / **私聊不被拦**）、记账（失败不占冷却）、自愈（+2 / 回满删条目 / 文件消失）、持久化、提示段（低分才出现 / 全满分不占 token）、clamp、工具面（注册 / 60→45 / 非法 userId 报错退出）、教程段（lean + full 都带 / 三判据 / 点名工具）、回退、补丁标记 |
| 回归 | botguard 17/17 · talkstyle 22/22 · hardlimit 11/11 · quiet 24/24 · browse 49/49 · session 20/20 · memory 43/43 · **engage 27/27**（本轮修好长期假红：自测配置只重写了 `engage` 三键，硬限默认开启后把"配额拒绝"搅成"硬限拒绝"——改为只覆盖 quota、显式关掉 hardLimit / botGuard / rapport；两处标记断言改指产物特征，防下游补丁改写标记后永久假红）· import-integrity ALL PASS（61 文件 / 329 符号） |
| 补丁重放 | 二次执行全跳过（28/28 skipped · 幂等实锤） |
| 生效 | **需重启业务面**（`src/*` 改动；`startHealLoop` 在启动流程里挂） |

**六、边界（不做）**

- 不做内容判定（"这句算不算敷衍"不写本地规则）——判定权归模型，系统只做限速与自愈
- 不做永久黑名单——自愈保证一定回升（分数只影响回复间隔，不切断关系）
- 不改安全边界 / 发言配额 / 硬限 / bot 指定限频：本节是并列的第四道闸，串联在其间
- 不自动改写历史分数：存量群友一律从 100 起，没有回填

**七、遗留**

| # | 项 | 说明 |
|:--:|:--|:--|
| 1 | **重启业务面** | `src/*` 改动需要重启 `QQ Agent.exe` 才生效（`startHealLoop` 挂在启动流程；新工具 `adjust_rapport` 也随重启进工具池）。重启后核验：①`/api/rapport/group_<群号>` 可达 ②工具面出现 `adjust_rapport` ③日志出现 `[rapport]` 自愈行（5 分钟后） |
| 2 | 真链路验收 | 在真实群让 bot 对某个无视它的人调一次 `adjust_rapport`，确认 `_rapport.json` 落盘 + 记忆页徽标变化 + 下一轮发送被限速（拦在出站口，不是发出去才后悔） |

---

## 六十四、前文瘦身 B23：角色设定上工式（v0.76 · 2026-10-18）

**一、规格（Rushiera 2026-10-18 点名）**

> B23 角色设定块：从「静态整段注入」改成上工式（侦察 → 按需取件）。

**取舍（开工时定）：** B16（静态压缩到 25–30k）**不先行**，直接做 B23——B23 是结构改成按需加载，B16 的压缩目标被 B23 覆盖；先补执行面（文件读取工具），再改 roleText 结构。

**二、现状 → 目标**

| 项 | 改前 | 改后 |
|:--|--:|--:|
| `persona.roleText` | 95,432 字符（≈6.3 万 tok · 占 prompt 36.3%） | **4,779 字符（-95.0%）** |
| 注入方式 | CCBP 注入集整段拼接（L0/L1/L2 全量） | 身份 + CCBP 速览 + 工具面总览 + 路由索引 + 遇阻处置 + 领航员速查 |
| 文件读取工具 | 无 | `read_file` / `list_dir`（受控根只读） |

**三、设计要点**

| 面 | 设计 |
|:--|:--|
| 身份段（IDENTITY） | 我是谁 / 四条底线 / 群聊口径（人格要点保留，完整 SOUL/AGENTS/USER 按需读） |
| CCBP 速览（CCBP_PRIMER） | 知识网络 L0–L3 / Worker+Job / 猫 / 受控根 / Project——只讲是什么，不抄用法 |
| 工具面总览（TOOLS_MAP） | 自己的工具（send / memory / web / browser / image / nav / read_file / adjust_rapport…）+ CH4 侧工具归 majordomo（text-* / cs-* / mau-* / file-* / config-* / majordomo-* / pack / Note） |
| 路由索引（ROUTE_INDEX） | 按文件给「什么时候读」：SOUL / Discipline / GLOSSARY / Tree / TOOL-REF / Chat 四件 / Majordomo 四件 / CatHome 三件 / Browser 三件 / role/nav-rules.md / role/blocked-rules.md / 项目文档 |
| 按需文件 | `role/nav-rules.md`（领航员完整教材）· `role/blocked-rules.md`（遇阻处置完整版）——落 workspace 根，由 `apply-qqagent-config.mjs` 生成 |
| 人格不动 | systemPrompt（lean 1069 字符）原样；Chat 四件完整可读；身份段保留其要点，不改写人格内容 |

**四、实现**

| 文件 | 改动 |
|:--|:--|
| `src/file-tools.js`（新） | `fileRoots` / `resolveReadPath` / `readTextFile` / `listDirectory` / `registerFileTools`——受控根只读面 |
| `src/config.js` | `tools.fileRead` 默认段（roots = workspace + ccbp · maxBytes 2MB · maxCharsPerRead 60k） |
| `src/tools.js` | import + `registerFileTools()`（工具 54 → 56 件） |
| `tools/apply-qqagent-config.mjs` | 六段短 roleText 生成 + role/ 按需文件落盘；`--roletext-only` 保留 |
| `tools/patch-qqagent-fileread.mjs`（新） | 4 补丁点（模块 / import / register / config）· 链尾 · 幂等 |
| `tools/verify-qqagent-fileread.mjs`（新） | 20 项自测 |
| `role/nav-rules.md` / `role/blocked-rules.md`（新） | 按需文件（4,779 / 954 字符） |

**五、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 四文件 0 错（file-tools / patch / apply / verify） |
| 自测 | `verify-qqagent-fileread.mjs` **20/20**——受控根 / 寻址 / 越界拒绝（相对路径 / `..` / 根外绝对路径）/ 分段读取 / 目录 / 工具注册 / 补丁标记 / roleText ≤12k + 关键词 / 旧注入退出 / 按需文件可读 |
| 工具全链 | `tools.js` 真实入口 `buildToolDefs()` → 56 件，含 `read_file` / `list_dir` |
| 回归 | cattools **64/64** · import-integrity **ALL PASS（62 文件 / 332 符号）** |
| 补丁重放 | 二次执行 4/4 skipped（幂等实锤） |
| 生效 | **应用已重启（2026-10-18 18:33）**——启动会话 roleTextChars=4,779；`/api/tools` 已含 read_file / list_dir；新会话即读短前文 |

**架构变更三段式（保留·扬弃·新增）**

- **保留**：人格底座与群聊口径（systemPrompt 原样；身份段保留 Chat 要点）；遇阻处置 6 条；领航员操作速查；CCBP 知识网络全部原文件（按需可达）。
- **扬弃**：roleText 的「CCBP 注入集整段拼接」装配方式——L0/L1/L2 全量不再每轮重发。
- **新增**：受控根只读文件面（`read_file` / `list_dir`，workspace + ccbp）；`ROUTE_INDEX` 路由索引；`role/nav-rules.md` / `role/blocked-rules.md` 按需文件；B23 自测与补丁。

**六、边界（不做）**

- 不删 CCBP 原文件：按需文件就是原文件，路由索引指过去
- 不放开 `data` 根（密钥面）/ `mau` / `mauout`——默认只给 workspace + ccbp（与 CH4 猫 enabledRoots 一致）
- 不做写面：read_file / list_dir 只读，不提供写 / 删 / 移动
- 不改 systemPrompt / 人格：只改 roleText 装配结构

**七、遗留**

| # | 项 | 说明 |
|:--:|:--|:--|
| 1 | ~~重启业务面~~ **已完成（2026-10-18 18:33）** | 启动器一键重启；启动会话 roleTextChars=4,779；工具面 `/api/tools` 已含 `read_file` / `list_dir` |
| 2 | 真链路验收 | 新会话零读取答「我是谁 / 能干什么 / 边界在哪」；群里问 CCBP / 领航员细节时，模型主动 `read_file` 取件（看日志工具调用） |

---

## 六十五、领航员回执 apisite 取数纠偏（v0.77 · 2026-10-18）

**一、判例（Rushiera 2026-10-18 19:17 群 361820329）**

> 「领航员模式启动的应用指令层似乎没有正确的读取到 apis 的数据」→ 紧接一句「看来 apis 挂了」。

19:17:07 群内 @ 开启领航员，19:17:08 开工回执发群；回执里 `ApiSiteAnalyzer` 那行没给出可信用量，用户据此判断「apis 挂了」。而 ApiSiteAnalyzer 本体全程在线（`/api/sites` 200，采集周期 59 秒，各站 `lastFetchAt` 一直在推进）。

**二、根因（`app/src/navigator/index.js` `probeService` 的 apisite 分支）**

| 项 | 原实现 | 问题 |
|:--|:--|:--|
| 选站 | 取 `/api/sites` 的 `sites[]`，按 **`lastFetchAt`（最近采集时刻）** 倒序取第一条，当作「当前在用」 | 采集时刻与**用量**无关：空站点（`rows=0`，如「知序空间2」）同样每轮被采集。谁刚采完谁就赢 → 回执有一半几率落到空站点 |
| 结果 | 用该站的 `overview.last24h` 报「过去 24 小时 `<n>` 次请求 / `<m>` token」 | 挑中空站点即报 **0 次请求 / 0 token** → 看着像服务挂了（本次现场：`buddy2` rows=0 且 `lastFetchAt` 每轮刷新） |
| 失败面 | 取不到时回落 `在线` / `在线（24 小时统计未读到）` | 不说明是谁的数、也不说明为什么没有——无从判断是「没量」还是「没读到」 |

**三、修法（Rushiera 定：直接吃内置参数接口，多站点合并）**

| 面 | 改法 |
|:--|:--|
| 取数 | `GET /api/analysis?site=__all`——ApiSiteAnalyzer **内置的总览口径**（跨站已合并），一次请求：成不成 = 在不在线，数 = 合并后的 24 小时用量 |
| 判定 | 该请求失败即判 `离线`（不再先探 `/api/sites` 再探单站——两跳变一跳） |
| 格式化 | 抽成纯函数 `apisiteDetail(payload)`：`count` / `promptTokens+completionTokens`；统计缺失时给明确文案「总览统计未读到」 |
| 不做 | 不挑站点、不自己合并、不标「当前在用」——口径与数据全部归 ApiSiteAnalyzer 自己 |

**四、验证**

| 面 | 结果 |
|:--|:--|
| 端点实测 | `/api/sites` 67ms · `/api/analysis?site=__all` **837ms** · 单站 51ms——`PROBE_TIMEOUT_MS`（6 秒）够用 |
| 取数实证 | 内置合并口径 8,661 次 / 1,833,200,461 token（4 站合计：xyjun 3,831 + newapi47 51,481 + buddy 3,205 + buddy2 0） |
| 自测 | `tools/verify-navigator.mjs` 57 → **60/60**（+3：`读到合并用量`（真链路）/ `合并口径格式化`（假 payload 断言 8,182 次 / 1,500 token）/ `统计缺失给明确文案`） |
| 回执样例 | `ApiSiteAnalyzer   在线（过去 24 小时 8,661 次请求 / 1,833,200,461 token）` |

**五、边界（不做）**

- 不改 ApiSiteAnalyzer 本体：只用它的既有端点 `/api/analysis?site=__all`
- 不做站点白名单 / 手工指定「当前在用」：合并口径不认单站
- 不改回执其余行（`应用指令层 --OK` 仍是进程内恒真；`Mau链接状态` 仍探 `/api/v1/snapshot`）

**六、遗留**

| # | 项 | 说明 |
|:--:|:--|:--|
| 1 | **重启应用** | `app/src/*` 改动需重启自研单体才生效；重启后群内 @ 开一次领航员核验回执那行带用量数字 |
| 2 | 多站口径 | 现报跨站合并（内置总览）。若日后要「只看某一站」，加配置项 `services[].site` 指定即可（本轮不做） |

---

## 六十六、已读信息分段摘要（B22 · v0.78 · 2026-10-18）

**一、规格（Rushiera 2026-10-18 点名 B22）**

> 已读信息块：从「会话全量」改成可裁剪 / 分段 / 摘要化。

读数基线（`ref-prompt-baseline.md`）：最大群 10-17 13:13 实测【已读信息】**156,825 字符 ≈ 10.4 万 tok / 占整个 prompt 59.7%**，是唯一随天数线性增长的段；记忆整理（consolidate）只处理群友印象与群记、**不碰已读**；已读只靠收工轮轮转收缩（`session.maxContextTokens` = 160,000 tok）。

**二、方案（三候选 → 合并采用 ①+②）**

| 候选 | 取舍 | 理由 |
|:--|:--|:--|
| ① 降收工轮阈值 | **不采用** | 阈值降到几万 tok 会让群聊每几小时就「失忆」一次；收工代价 = 一次全量沉淀 LLM 调用 + 存档归档，频率过高不划算 |
| ② 分档窗口（近 N 条细读 + 更早只留摘要） | **采用** | 直接作用于唯一线性增长的段；原文不出存档，只出提示词 |
| ③ 旧段交给记忆沉淀后出窗 | **部分采用** | 摘要段在轮转时整批归档、可 `memory_search category=history` 检索——事实不丢，但不等「到点」才收缩 |

**设计落点（详规 → `design-qqbotb-session.md` §九）**

| 面 | 实现 |
|:--|:--|
| 窗口下界 | `session-state.json` 每 chat 新增 `readFloorTs`；普通轮【已读信息】取 `max(会话起点, readFloorTs)` 之后的消息；**收工轮不套 floor**（记忆沉淀仍吃全量原文）；`readMaxChars=0` 时完全忽略 floor（回到今日的会话全量） |
| 摘要载体 | `data/memory/<chat>/_readlog.json`（活跃段）+ `archive/readlog-<yyyyMMdd>.jsonl`（append-only） |
| 压缩时机 | 每轮**普通运行成功结束后**异步检查（不阻塞聊天、失败保原文、10 分钟退避） |
| 分块 | 按 `readCompactChunkChars`（50k 字符）切块，逐块压成 3~8 条短句；逐块 `appendReadSegment`，全部成功才推进 floor |
| 提示段 | 【前情提要】插在【记忆】之后、【已读信息】之前（稳定前缀）；只展开最近若干段（≤ `readDigestMaxChars`），段尾明示更早段数 + 取法 |
| 检索 | `memory_search` 新增 `category=history`——跨活跃摘要段 + 归档摘要段 + 历次会话要点；`archive` 回执增 `history` 计数 |
| 轮转 | `#completeRollover` 先归档上一份 `_session.json` → 写新要点 → 归档 `_readlog.json` 活跃段 → `archiveAndClear` + `resetSession`（floor 归零） |
| 观测 | `/api/sessions` 的 `chats[]` 增 `readFloorTs` / `readSegments` / `readArchived`；会话页群行显示「前情 N 段 / 归档 M」；`POST /api/session/compact` 手动压缩（`force=false` 只在超预算时动） |

**🔴 三、根因（本轮最大收获）：摘要模型必须选快档**

首版直接用记忆整理模型（`memory.useChatModel=true` → 主模型 `hy4-preview-f`），真链路两轮全部「前情摘要为空」：

| 模型 | max_tokens | 耗时 | finish | reasoning | content |
|:--|--:|--:|:--|--:|--:|
| `hy4-preview-f` | 3000 | 42.9 s | `length` | 10,118 字符 | **0 字符** |
| `deepseek-v4.1-flash` | 4000 | **10.6 s** | `stop` | 953 字符 | 156 字符 |

主模型是推理模型：纯文本压缩请求会先产数百到数千 token 推理，`max_tokens` 被推理链吃光后 `content` 恒空。**修法**：新增 `session.readSummaryModel`（默认 `deepseek-v4.1-flash`）+ `readSummaryMaxTokens`（4000），摘要走独立 `chatCompletion` + `overrides`（复用主端点 baseUrl / key，只换模型）；空模型时回落记忆整理模型。空内容时日志输出 `finish` 与模型名（原为静默返回空串）。

**四、实现（补丁 30 点 + 1 个新模块）**

| 文件 | 改动 |
|:--|:--|
| `src/readlog.js`（新） | 摘要段存储 / 注入渲染 / 检索 / 归档 / 统计：`listReadSegments` · `appendReadSegment` · `archiveReadSegments` · `listArchivedReadSegments` · `readLogStats` · `formatReadLogForPrompt` · `searchReadSegments` · `formatMessagesForSummary` |
| `src/session-state.js` | `readFloorTs` 字段 + `getReadFloorTs` / `setReadFloor`；`resetSession` 归零 floor；`archiveSessionSummary` / `listArchivedSessionSummaries` / `searchSessionSummaries`（会话要点也进归档可检索） |
| `src/config.js` | `session.*` 六个新键（readMaxChars / readKeepChars / readCompactChunkChars / readDigestMaxChars / readSummaryModel / readSummaryMaxTokens） |
| `src/prompt.js` | 已读窗口下界（含 `readMaxChars=0` 忽略 floor）；【前情提要】段；`buildPastState` 返回值增 `chars` / `lineChars`；session 回写 `readChars` / `readFloorTs` |
| `src/orchestrator.js` | `#maybeCompactRead`（异步钩子）· `compactReadWindow`（分块压缩 + floor 推进 + 锚点清理）· `#summarizeReadChunk`（快档摘要）+ `#memoryChat` 增 `maxTokens` · `#runAgent` 传 `readFloorTs` · `#completeRollover` 双归档 |
| `src/tools.js` | `memory_search` 增 `category=history`（摘要段 + 会话要点）+ `archive.history` 计数 |
| `src/routes.js` | `POST /api/session/compact`；`/api/sessions` 的 `chats[]` 增三个观测字段 |
| `ui/app/02-sse-sessions.js` | 会话页群行显示「前情 N 段 / 归档 M」 |
| `tools/patch-qqagent-readcompact.mjs`（新） | 30 补丁点 · 幂等（标记检测 + 替换体首尾行兜底 + 替换体内标记检测） |
| `tools/verify-qqagent-readcompact.mjs`（新） | 25 项端到端自测 |

**五、验证**

| 面 | 结果 |
|:--|:--|
| 语法 | `node --check` 八文件 0 错（readlog / session-state / config / prompt / orchestrator / tools / routes / 02-sse-sessions） |
| 自测 | `verify-qqagent-readcompact.mjs` **25/25**（压缩 / 窗口下界 / 前情提要 / 检索 / 失败保原文 / 关闭开关 / 收工轮全量 + 双归档 / 补丁幂等） |
| 回归 | session **20/20** · memory **43/43** · memory-reach **13/13** · engage **27/27** · import-integrity **ALL PASS**（63 文件 / 346 符号）· readcompact 补丁二次执行 **30/30 skipped** |
| 真链路 | 群 **361820329**：`POST /api/session/compact` → 已读 61,692 → **40,194 字符**（压缩 321 条 / 1 段）；其后真实运行（20:11:46）prompt 里【已读信息】61,706 → **40,047**、总 prompt 80,438 → **60,867**，【前情提要】段 **3,393 字符**确实进了提示词。群 **785638698**：61,496 → **56,027** 字符（压缩 370 条 / 1 段）——已低于预算，无需再压 |
| 观测面 | `/api/sessions` 回执 `chats[]` 实测带 `readFloorTs` / `readSegments` / `readArchived` |
| 生效 | 应用已重启 ×3（`启动QQBotB.bat` 一键全流程）；`/api/session/compact` 可达、工具面 56 件含 `memory_search category=history` |

**六、边界（不做）**

- 不做向量化 / 语义检索——仍关键词（与 v0.73 记忆检索同口径）
- 不改 `session.maxContextTokens` 的收工轮判据；不改消息存档格式；不改发送链
- 拆块只按字符数（不按话题边界）——真出现「摘要切断话题」判例再引入语义切分
- 摘要段只增不改；原文永不删除（轮转时随存档归档，`get_recent_messages` 可翻）

**七、遗留**

| # | 项 | 说明 |
|:--:|:--|:--|
| 1 | 稳态观测 | 目标「同群稳态下【已读信息】≤ `readMaxChars`」已由真链路证明可达成；待一两天的自然运行观察压缩频率是否合适（现每轮结束检查一次，失败 10 分钟退避） |
| 2 | B23（角色设定块）未动 | 角色设定仍 95,432 字符整段注入（占 36.3%），属另一块攻坚 |

---

## 六十七、群内生成能力：MOSS 生图 / IrodoriTTS 语音 / WD Tagger 反推提示词（v0.79 · 2026-10-19）

> 来源：Rushiera 2026-10-19——「开工qqbot，增加一下群bot的指令：1.（画一张 / 使用生图功能）调用 comfydock 中的 moss，提示词需要能自动翻译，目前先给一个示例提示词……2. 生成语音 / 说话，调用 inodoritts，把用户给的中文自动翻译成日语版本再注入模型 3. 反推提示词，把图片递给 wd 打标。让 llm 找对应，你写好教材」。
> 设计：`design-qqbotb-navigator.md` §二十。

### A · 落地内容

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 单体服务 | `app/src/navigator/media.js`（新模块） | `mossDraw` / `ttsSpeak` / `wdTag` 三条链路——翻译 → 读 ComfyDock 当前配置 → 只覆盖任务参数 → 提交 → 后台轮询 → 产物发群；三个生成器各自单任务闸 |
| 单体编排 | `app/src/navigator/index.js` | 引入 `createMediaService`；新增 `sayRecord`（OneBot `record` 段）；`mediaGate`（启用 / 回消息群 / VIP 请求者闸，**不要求领航员已开启**）；`mossDraw` / `ttsSpeak` / `wdTag` 包装 + 三个 API 路由；返回面暴露 `media` |
| 配置 | `app/src/config.js` | `navigator.media`：`enabled` / `endpoint` / `requireVip` / `translate`（`model` 默认 `deepseek-v4.1-flash` · `timeoutMs` 30000 · `maxTokens` 3000 · `maxChars` 12000）/ `moss` / `tts` / `tagger` 各自 `pollMs` + `timeoutMs` |
| 业务面工具 | `tools/navigator/nav-tools.js` | 工具组 11 → **14 件**：`moss_draw(prompt, size?, seed?)` · `tts_speak(text, caption?)` · `wd_tag(messageId?)`；描述里写清触发语与 `comfy_edit` 分界（无图从零画 = moss_draw；带图改图 = comfy_edit） |
| 教材 | `tools/apply-qqagent-config.mjs` → `role/media-rules.md`（新）· `role/nav-rules.md`（补生成能力段）· `roleText` 内联速查 | 三能力对照表 + 通用口径 + MOSS 结构化示例（碧蓝档案 Professor Niyaniya 角色参考表：三视图 / 九宫格表情 / 全身姿势九连拍）+ IrodoriTTS 日语口径 + WD Tagger 结果口径；`roleTextChars` 4779 → **5130** |
| 自测 | `tools/verify-media.mjs`（新） | 守门 8 项（接口面 / 启用开关 / 空入参 / VIP 闸 / 操作者通道）+ live 三项（MOSS / TTS / Tagger） |
| 自测 | `tools/verify-qqagent-navtools.mjs` | 工具组 11 → 14 件；新增三件定义面 + 空入参执行面；**19/19** |

### B · 关键口径

- **自动翻译**：翻译走业务面同一 LLM 端点（`_unpack/data/config.json` 的 `api`），模型取 `navigator.media.translate.model`（默认快档 `deepseek-v4.1-flash`）——主模型纯文本请求推理链长、易吃光 `max_tokens`。MOSS 中文 → 英文；结构化 JSON 检测到中文时整体交翻译并要求保持 JSON 结构 / 键名 / bbox；IrodoriTTS 中文 → 日语（含假名视为已是日语）；`caption` 同样翻译。翻译失败不静默降级，回执明确「自动翻译失败」。
- **ComfyDock 配置只覆盖任务参数**：先 `GET /api/moss|tts|tagger` 取当前快照，合并后只改 `prompt` / `text` / `inputPath`（MOSS 另把 `batch` 压到 1），再 `POST /api/*/config` —— 不改模型 / 路径 / 采样配置。判例：`MossConfig` 的 C# 默认值会把缺省字段重置（Steps 50 / Accel false），所以必须整份快照回传。
- **产物出站**：MOSS `job.images[]` → `/api/moss/image?name=` 下载 → `sayImage`；TTS `job.file` → `/api/tts/audio?name=` 下载 → `sayRecord`；Tagger `job.items[0].generalText` / `characters` → `say`。全部走领航员 OneBot 直发，不经业务面发言闸。
- **闸门**：`navigator.media.enabled` + ComfyDock 在线 + 群内触发时 VIP 本人近期在本群 @ 过（120 秒窗，与图像编辑同口径）+ 三个单任务闸。**不要求领航员已开启**——生图 / 语音 / 反推是独立能力。
- **示例提示词**：`role/media-rules.md` 内嵌完整 JSON——左上 1/3 三视图、右上 1/3 九宫格表情、下面两排全身姿势九连拍；白底 + cel-shading；业务面 LLM 按骨架替换角色与英文 caption。

### C · 实测

- `node tools/verify-media.mjs`：**8/8**（守门）。
- `node tools/verify-media.mjs --live-tagger --image D:\Mau\WorkSpace\ComfyDock\out\moss\1263317781.png`：**10/10**——WD EVA02-Large Tagger v3，6.6 秒，通用标签 42 个，结果发群（mock）。
- `node tools/verify-media.mjs --live-tts`：**10/10**——中文「你好，我是测试语音。」→ 日语「こんにちは、テスト音声です。」→ IrodoriTTS 合成 → `record` 段发群（mock）。
- `node tools/verify-media.mjs --live-moss --prompt-file CatTemp\media-moss-prompt.txt`：**10/10**——中文「画一只橘猫坐在窗台上，清晨柔光，动漫风格」→ 英文「A orange tabby cat sitting on a windowsill, soft morning light, anime style」→ MOSS 出图 → `image` 段发群（mock）。
- `node tools/verify-qqagent-navtools.mjs`：**19/19**（工具组 14 件注册 + 三件定义面 / 执行面）。
- 真实应用 API 走通一次：`POST http://127.0.0.1:3280/api/nav/moss`（chat=selftest，中文「画一只橘猫坐在窗台上，清晨柔光，动漫风格」）→ 14:00:34 提交 → 14:05:11 出图（约 4.5 分钟；当时 GPU 97% / 7.3GB 被其它进程占用，属环境竞争，非链路问题）→ `app/data/media-out/moss-1792389634222-1.png`（图像识别：橘色虎斑猫坐在窗台、绿眼、窗外城市，画面正常）；发群失败仅因 selftest 不是真实群（retcode=1200），符合预期。
- ComfyDock 当前 MOSS 配置已恢复为 `role/media-rules.md` 的示例提示词（1,753 字符），供群内直接说「用生图功能画角色参考表」使用。
- 应用与业务面已重启（2026-10-19 14:27）：`/api/nav/status` 回执含 `mediaBusy`（moss/tts/tagger 均 false）；业务面日志 `工具集已刷新：59 个工具`（原 56 + 3）。
- ComfyDock 当前环境：`moss.env.canGenerate=true` · `tts.env.canGenerate=true` · `tagger.env.canGenerate=true`（2026-10-19 13:22 探测）。

### D · 遗留

1. **真实群触发待验**：live 自测走 mock OneBot（群号 `selftest`），尚未在真实群 @ 触发一次完整「群消息 → 业务面判断 → 工具 → 单体 → ComfyDock → 产物回群」链路；应用与业务面已重启（14:27），待 Rushiera 在群里各发一次「画一张… / 生成语音… / 反推提示词」验收。
2. **示例提示词是固定角色**：`role/media-rules.md` 的 JSON 以 Professor Niyaniya 为样例；换角色时业务面 LLM 需要自己替换 caption。若后续发现模型照抄角色名，可再补「只把它当骨架」的强调。
3. **MOSS 结构化 JSON 翻译**：当前走整份 JSON 交 LLM 翻译 + JSON.parse 校验；模型若返回非 JSON 会明确报错（不静默塞中文）。后续可加逐字段翻译兜底。
4. **TTS 长文**：未做自动分段；工具描述与教材已写「一次一两句话」，超长文本仍会一次合成（耗时可能很久）。

## 六十八、读空气两件：群聊语域 + 回应参数客观结算（v0.80 · 2026-10-19）

> 来源：Rushiera 2026-10-19——「开工qqbotB，你看一下工仔养生水疗中心群里的存档沟通记录，我感觉群友还是觉得群bot有点不读空气了有好办法吗」→ 拍板：**项 1（一轮一条）不改 · 项 2（群聊轮收工具面）不改 · 项 5 / 项 6 不做**，只落 **项 3（群聊语域）** + **项 4（客观结算）**。
> 设计：`design-qqbotb-engage.md` §十三（客观结算追加）· §十四（群聊语域）。

### A · 存档取证（群 689942975 · 10-19 · id 2755-2911）

| # | 现象 | 证据 |
|:--:|:--|:--|
| 1 | 一轮拆多条发 | `2781→2784`（4 条，其中 2783 / 2784 是同一条更正发了两遍）· `2811→2815`（5 条）· `2825→2831`（7 条）· `2887→2890`（4 条） |
| 2 | 内部机制外泄 | `2811`「生图通道没过——它认「本人近期在本群 @ 我」…被挡回来了」· `2829`「领航员没开着，投递被挡回来了」· `2887-2890` 整段讲闸门 / 计数器 / 打分 |
| 3 | 点评腔插话 | `2854` / `2856` 别人聊美术，它插技术判断 |
| 4 | 群友原话 | 中秋「现在这个太人机了」· 莎「你看起来好像是ai再跟你聊」「你发一句他回一两句」「每次都是用户先发消息」· 摸鱼怪「@Shieraru 不许接我的话茬」· 莎「你什么时候才能学会像人一样说话啊」「我感觉降级应对几乎没生效」 |

**回应参数空转实锤**（Rushiera「几乎没生效」的取证）：`data/memory/` 全目录**无任何 `_rapport.json`**；`telemetry-totals.json` 累计 `adjust_rapport` **4 次** vs `send_message` **2440 次**；10-19 日志 `[rapport] 自愈：1 位群友回升 +2（涉及 1 个会话）` 从 18:47 滚到 19:22 —— 全程只有 1 人 1 群掉过分、35 分钟自愈回 100。根因：**打分权在模型手里、闸门在宿主手里**——模型在「我想说」那一刻没有反向信号，每次都觉得自己该说（它自己在 `2889` 也是这么说的）。

### B · 落地内容

| 面 | 落点 | 说明 |
|:--|:--|:--|
| 项 3 群聊语域 | `src/prompt.js` —— `chatVoice()` 段 | 三条：后台的事不进群（闸门 / 配额 / 限频 / 投递 / 领航员状态 / 工具回执 / 记忆整理；事情没成就说「这次没成」）· 不点评 / 不做技术判断 / 不总结 / 不给建议（除非有人问）· 一条消息一次说完（不发出去又补、又更正、又打补丁）。**lean + full 都带** |
| 项 3 补丁 | `tools/patch-qqagent-chatvoice.mjs`（新 · 3 点 · 链尾 · 幂等） | 依赖 `patch-qqagent-talkstyle.mjs`（lean 段由它建立）+ `patch-qqagent-memory.mjs`（锚点落在 lean 里的 `memoryRules()` 上） |
| 项 4 客观结算 | `src/rapport.js` —— `noteRapportOutbound` / `settleRapportWatch` / `pointsAtMe` / `clearRapportWatch` | 宿主侧客观信号：**我发了话，下一批消息里有没有人 @ 我 / 引用我 / 拍我** —— 有 → `+hitDelta`（6）；没有 → `-missDelta`（12）。判定只看客观事实、不看内容；结算完即清，同一批只判一次 |
| 项 4 编排 | `src/orchestrator.js` | 每轮**开轮时结算上一轮**（`settleRapportWatch`）+ **轮末记账**（`noteRapportOutbound`）；被点名的那一轮不记（那是人家要的回复）· 收工轮 / 整理轮不记（不发言） |
| 项 4 配置 | `src/config.js` —— `engage.rapport.watch` | `enabled: true` · `missDelta: 12` · `hitDelta: 6` · `exemptUsers: ['569145850']`（主人豁免——他 @ 是点名，不回不代表不想聊，与「VIP 不受配额与硬限约束」同口径） |
| 项 4 补丁 | `tools/patch-qqagent-rapport.mjs`（补 4 点 → 32 点 · 幂等） | `module`（rapport.js 重写，含 watch 模块）· `config-watch` · `orchestrator-import-watch` · `orchestrator-watch` · `orchestrator-watch-note` |
| 自测 | `tools/verify-qqagent-chatvoice.mjs`（新）· `tools/verify-qqagent-rapport.mjs`（扩） | chatvoice **19/19**；rapport **41 → 52/52**（新增 18a-18h：降分 / 加分 / 引用 / 拍我 / 主人豁免 / 只结算一次 / 可回退 / 降分后出站真被拦 / 标记齐备） |

### C · 实测

- `node tools/patch-qqagent-chatvoice.mjs` → applied 3 / skipped 0；`node --check prompt.js` 0 错。
- `node tools/patch-qqagent-rapport.mjs` → applied 5 / skipped 27；`node --check` rapport.js / orchestrator.js / config.js 三文件 0 错。
- `node tools/verify-qqagent-chatvoice.mjs`：**19/19**。
- `node tools/verify-qqagent-rapport.mjs`：**52/52**（含 18g —— 客观结算降下来的分在出站口真的被拦，错误含「回应参数」）。
- 回归：`verify-import-integrity` ALL PASS（63 文件 / **349 符号** = 原 346 + 新 3 导出）· talkstyle 22/22（lean 体积 2048 字符，1~3KB 断言仍过）· memory 43/43 · session 20/20 · engage 27/27 · quiet 24/24 · browse 49/49 · readcompact 25/25。
- 回读：`prompt.js:133` chatVoice 定义 / `:332` lean 接入 / `:358` full 接入；`rapport.js:344` 正则 `/拍了拍\s*我/` 形态正确；`orchestrator.js:50` 导入 · `:738-760` 结算块 · `:808-813` 记账块。

### D · 遗留

1. **业务面需重启才生效**——`Start-Process` 被引擎拦（`PS_START_FORBIDDEN`），本会话无通道起进程；待 Rushiera 双击 `启动QQBotB.vbs`（或 `启动QQBotB.bat`）后生效。
2. **真链路验收待触发**：重启后在群里发一条话（非 @ 触发的那一轮），等下一批消息到来，看日志 `[rapport] 客观结算：没人接话 → -12（…）` 行 + `data/memory/<chat>/_rapport.json` 落盘；再在群里 @ 它一次，看 `有人接话 → +6`。
3. **lean 提示词体积**：chatVoice 让 lean 从约 1769 → **2048 字符**（talkstyle 自测的 1~3KB 断言仍过）。后续再加段需重新审视这条断言。
4. **未采纳项**（Rushiera 2026-10-19 拍板不改，留档防重新引入）：①一轮一条（合并 / 拒发第 2 条起）②群聊轮收工具面（非点名轮只留 send / 记忆 / 表情）⑤口语正反例文件 ⑥单条长度软闸。

## 六十九、四条群内实测修复：念没念 / 图没图 / 重来去哪 / 语音没字（v0.81 · 2026-10-19）

> 来源：Rushiera 2026-10-19——「你看一下偶像大师灰姑娘女孩mod交流分享群的沟通记录，我有尝试调用 tts 的指令……」（群 785638698 安静模式首日实测）→ 拍板：四条全改，按 ④→①→②→③ 顺序落地。
> 判例载体：`_unpack/data/sessions/` 四份运行记录 + 群消息存档（`messages/group_785638698.json`）。

### A · 四条判例（事实链）

| # | 现象 | 运行记录 | 根因 |
|:--:|:--|:--|:--|
| ① | 20:08「@Shieraru 念一下上面图片里的内容」（图：老实写代码，很枯燥吧）——读图成功、内容也生成了，但群里没动静、也没 TTS | `mvf7nb2a-d8271497` | ①「念」没落到 `tts_speak`（前文内联速查没有触发词）；②答案写在 assistant 正文里 + 同轮调 `finish` → `sent: []`，正文按设计不发群；`reply-rescue.js` 只在「本轮零工具调用」时触发，救不到；且 `skills/` 里没有任何 `reply.*` 能力实现，兜底恒为空转 |
| ② | 18:41「@Shieraru 念一下上面图片里的内容」（图：[猫想你] gif）——回「图片我没取到，接口连着几次都 404」 | `mvf5ijkq-c47f46e0` | `get_message_images` 只走远程 URL 直连；该 gif 的 `gxh.vip.qq.com/.../raw300.gif` 已实测 **HEAD 404**（资源失效）；协议端本地缓存（消息 `file=d0-…gif`）本可读，但工具没接 `get_image` 回退。旁证：同轮 `get_recent_messages` 返回 10-17 的旧消息——`tools.js:607` 把 `pastStateCount` 叠进了 offset |
| ③ | 17:58「给上面这个图的角色画一个三视图」→ 出图 → 18:05「不太像」「@Shieraru 重来」→ 回「图像编辑要走领航员模式，现在没开，投不出去」 | `mvf30oh9-ec3bfc5c`（首轮）/ `mvf393v3-666d4c45`（重来） | 首轮走 `moss_draw`（不依赖领航员）成功；「重来」改走 `comfy_edit`（依赖领航员）被挡，且把「开领航员」当结论抛给用户——「重来的是什么」没有任何一处教材 / 工具描述承载 |
| ④ | 17:52「@Shieraru 念一下你是谁」——只发了语音，文字一条没有 | `mvf2sfsh-798de279` | 只调 `tts_speak`（`sent: []`）；`media.js` 的 `waitTts` 只发音频 + 附件说明。**与安静模式无关**——安静模式只砍非 @ 的闲聊，17:52 是被 @ 的普通轮，照常发言（同群 14:54 / 17:52 两次 TTS，文字有无不一致，说明不能靠模型自觉） |

### B · 落地内容

| 面 | 落点 | 说明 |
|:--|:--|:--|
| ② 取图 | `src/tools.js` · `buildImagePayload`（新） + `get_message_images` | 取图链改**协议端缓存优先**（`ctx.onebot.call('get_image', { file })` → 读本地缓存字节 → buildImagePayload）→ 直链兜底；GIF 分叉 / 压缩逻辑与直链共用 |
| ② 窗口 | `src/tools.js` · `get_recent_messages` | offset 不再叠加 `pastStateCount`（原会一跳跳回一周前） |
| ① 语义 | `src/nav-tools.js` · `tts_speak` 描述 | 触发语补「念出来 / 读一下」；新增「念一下上面图片里的内容 = 先 get_message_images 读图，再把读到的文字填进 text——读图是手段，念出来才是任务」 |
| ① 硬规则 | `src/tools.js` · `finish` 描述 | 明写「正文里的内容不会发到 QQ——要对群里说的话必须先调发送工具」 |
| ④ 配文 | `app/src/navigator/media.js` · `waitTts` | 语音发回前先 `sendText(chat, source)` 发原文——两条一起到，不依赖模型自觉 |
| ③ 重来 | `src/nav-tools.js` · `comfy_edit` 描述 + `roleText` / `role/media-rules.md` | 「重来 / 再来一次 / 重画」先看上一轮走的哪条路，沿用上一次**成功**的工具与参数；被前置挡住时回退上一次可行路径，别把「要开 X」当结论抛给用户；教材新增「**续接指令**」段 |
| 补丁 | `tools/patch-qqbotb-fixgroup.mjs`（新 · 6 点 · 幂等） | `image-payload` / `image-cache-first` / `recent-offset` / `finish-desc` / `tts-desc` / `comfy-retry` |
| 教材源 | `tools/apply-qqagent-config.mjs` | MEDIA_RULES 三处（表格触发语 / 语音段配文与念图口径 / 续接指令段）+ NAV_QUICK 生成能力行；`roleTextChars` 5130 → **5241** |
| 自测 | `tools/verify-qqbotb-fixgroup.mjs`（新） | **18/18** |

### C · 实测

- `node tools/patch-qqbotb-fixgroup.mjs --dry` → 6 点全命中；正式跑 applied 6 / skipped 0；复跑 skipped 6（幂等）。
- `node --check`：`tools.js` / `nav-tools.js` / `media.js` / `apply-qqagent-config.mjs` 四文件 0 错。
  - 🔴 过程中踩到一次：`finish-desc` 的 replacement 写成模板字面量 `\n` → 落进单引号字符串变真实换行 → `SyntaxError`；改为落 `\n` 转义（补丁脚本内写 `\\n`）后修复，脚本已同步修正（重装重跑不会再坏）。
- `node tools/verify-qqbotb-fixgroup.mjs`：**18/18**。
- `node tools/verify-qqagent-navtools.mjs`：**19/19**（工具组 14 件）。
- `node tools/verify-import-integrity.mjs`：ALL PASS（63 文件 / 349 符号）。
- `node tools/apply-qqagent-config.mjs --roletext-only`：role 三件已刷，`roleTextChars` 5241。

### D · 遗留

1. **业务面 + 单体需重启才生效**——`Start-Process` 被引擎拦（`PS_START_FORBIDDEN`），本会话无通道起进程；待 Rushiera 双击 `启动QQBotB.vbs`（或 `启动QQBotB.bat`）。业务面改动另需**新会话**才会进前文（roleText）。
2. **真链路验收待触发**（群 785638698）：①发图 +「念一下上面图片里的内容」——期望先文字后语音两条；②发一张图 + 「画三视图」→「重来」——期望沿用 `moss_draw` 重画；③发一张旧表情图 + 「念一下」——期望走协议端缓存读图成功（不再 404）。
3. **正文兜底（`reply-rescue`）仍是死代码**：`skills/` 无任何 `reply.*` 能力实现，`orchestrator.js` 也只在「零工具调用」时触发。本轮只补了 `finish` 描述硬规则，没动兜底——是否补最小实现（把「正文成稿」抢救成 `send_message`）列为拍板项（风险：判错就是把内心戏发进群）。
4. **`get_image` 回退依赖 NapCat 缓存**：`D:\QQcache` 在受控根外（业务面读文件不受受控根约束，可读）；若 NapCat 侧未缓存（旧消息 / 清理过），仍会退回直链并可能 404——回执已按「协议端缓存：…」具名报错，不静默。

---

## 七十、LLM 端点换域适配（v0.82 · 2026-10-25）

> 触发：Rushiera「现用的 newapi-47.250 api 站好像换了新的端点前缀，适配一下 `https://time.api.freeshare.tech/v1`」。

### A · 取证（旧端已下线，模型也换了）

| 探测 | 结果 |
|:--|:--|
| `GET http://47.250.160.225:8443/v1/models` | **410 Gone** |
| `POST http://47.250.160.225:8443/v1/chat/completions` | **410 Gone** |
| `GET https://time.api.freeshare.tech/v1/models`（同密钥） | 200 · 只列 `deepseek-v4.1-flash` |
| `POST .../chat/completions` · `model=deepseek-v4.1-flash` | 200 · 正常回执（带 `reasoning_content`） |
| 同上 · `model=hy4-preview-f` | `model_not_found: Model "hy4-preview-f" is not available for this group` |
| 并发压测（并行数超限） | 429 `CONCURRENCY_LIMIT_EXCEEDED · limit:3` |
| 视觉通道（真截图 36 614 B，`deepseek-v4.1-flash`） | 200 · `content` 有实际描述（`reasoning_tokens` 935）→ 收图能力在 |

结论：旧站入口撤销、`hy4-preview-f` 不在新站本组，主模型必须改 `deepseek-v4.1-flash`。

### B · 落点（四处）

| 件 | 改动 | 生效 |
|:--|:--|:--|
| `_unpack/data/config.json` | `api.baseUrl` → 新端 · `api.model` → `deepseek-v4.1-flash`（`fallbackModels` 原就同款） | 经 `POST /api/config` 热写并落盘，**运行实例即时生效**（回读一致） |
| `tools/apply-qqagent-config.mjs` | `API` 常量（baseUrl / model）同步 | 下次重跑生成器不会写回旧端 |
| `runtime/.<名>-selftest/config.json` | 无需手改 | 各 verify 脚本每次从 `_unpack/data/config.json` `copyFileSync` 重建 |
| `app/src/**` | 无需改 | 领航员 `loadVision()` 本来就读 `_unpack/data/config.json`（同源） |

### C · 实测

- `POST http://127.0.0.1:3210/api/test/api`（业务面真实 `chatCompletion`）→ `{"ok":true,"model":"deepseek-v4.1-flash","reply":"pong"}`，两次分别 3 256 ms / 5 995 ms。
- `node` 侧无改动 → 未跑 `verify-import-integrity` 等（不动代码面）。

### D · 遗留（跨项目 / 跨面）

1. **CH4 宿主全局 `vision.model` 仍是 `hy4-preview-f`** → 在新端 404，`image-analyze` 直接失败（本轮实测撞上）。`vision.api_config_id`（`6c107132` → 池 `newapi-47.250`）已指新端，只差模型名。归 CH4 配置面（本会话无 `config-*` 工具），已报 Rushiera。
2. **`Data:config/llm-api.json` 的 `newapi-bak`（`7e5dd46a`）仍指旧端**且 `apiType` / `defaultModel` 都是 `hy4-preview-f`——LLM 池是人工面板专属面，工具面写不进。
3. **同密钥共享 3 并发**：协商知识库批量轮与本业务面同密钥，同时跑会撞 429（重试池会退让，风险低——业务面单会话串行）。

---

## 七十一、发言档位五档 + 客观采集（v0.83 · 2026-10-25）

> 来源：Rushiera 2026-10-25「回应参数是之前不知道怎么调控群 bot 发言的临时方式，现在你收集到了数据，可以给这个硬闸降级……但是还是要确保保守不要太热闹」+「我不希望修改 5/2min 的限制，这个限制应当保持，节拍也不要改，想别的方法」+「你可以再增加更多的客观参数调整项」+「直接做完，开始把」。
> 判例输入：`usage-days/2026-10-19.json`（1138 次调用 / 459 条发言）+ 群 361820329 归档 `group_361820329_1792686251913.json`（1557 条里 `self:true` 34 条 = 2.2%、`atMe:true` 13 条 = 0.84%）。

### A · 诊断（为什么"话变少却查不出原因"）

| # | 事实 | 证据 |
|:--:|:--|:--|
| ① | 出站闸拦下的发送**不写日志** | `sender.#checkRate` 五道闸只在抛错时把错误回给模型 → 群里话少了，日志里只有"发送量骤降 + 结算行数暴增"可反推 |
| ② | 客观结算把"没人 @ 我"当成"不想听我说话" | `missDelta=12`，10-20 一天触发 44 次，分数 88→80→70；而闲聊群里 @ 率实测 **0.84%**，这条信号必然是高频误判 |
| ③ | 发言量由最严的那道闸单独决定 | `quotaState` 取两道闸更严者；且 5 道闸互不知情，任一触发就静默 |
| ④ | `store.contextTier` 已被 browse 强制覆写 | `storeConfigForChat`：browse 开启时强制 `contextTier=4` → **老的响应档位滑条已失效**，分档绝不能复用它 |

### B · 设计（三旋钮，全在配额与节拍表之外）

| 档 | 名 | 入场率 | organizeOnly（只整理不发言） |
|:--:|:--|--:|:--:|
| 1 | 冰封 | 0（非 @ 不进 LLM） | ✅ |
| 2 | 保守 | 25% | — |
| 3 | 标准 | 60% | — |
| 4 | 活跃 | 85% | — |
| 5 | 全开 | 100% | — |

**硬边界（Rushiera 定，实测核验已写成断言）**：`engage.quota` 恒为 `120000ms / 5 条`；`engage.browse.levels` 恒为 `[240000, 120000, 60000]`。两条由 `verify-qqagent-level.mjs` §7 以正则核验"原样未动"。

**为什么用入场率而不是继续加出站闸**：出站闸只能拦住"已经想说的话"，压不住"想说"本身。10-22 实测进 LLM 267 批 / 只发出 76 条（0.28），说明瓶颈在入场面。

**未命中时不推进已读**：判定插在 `unread<=0` 早退之后、`markIdleFired` / `logger.info` 之前；未命中 `continue`，那批消息留在未读里等下一拍，一条不丢。

**冰封档兼容老字段**：`engage.quiet.chats` 保留为冰封档别名（`levelForChat` 与 `isQuietChat` 双向认同），老配置启动即生效、不清空。UI 选 1 时双写 `quiet.chats`。

### C · 回应参数降级（硬闸 → 采集面）

| 项 | 改前 | 改后 |
|:--|:--|:--|
| `settleRapportWatch` 的降分量 | `missDelta=12` 直接扣 | `Math.min(missDelta, paramsFor(chatKey).missCap)`，而五档默认 `missCap=0` → **判定与日志照跑，分数不动** |
| 分数来源 | 客观结算 + 模型手调 | 仅模型手调 `adjust_rapport` + 自愈加分 |
| `maxCooldownMs` | 1200000 | **不变**（模型真要降分时，20 分钟兜底还在） |

### D · 客观信号（先采集，默认不参与判定）

`engage-signals.js` 六信号纯函数（只用存档已有字段）：

| 信号 | 口径 | 系数 |
|:--|:--|:--|
| `share` | `self / 总数` | ≤15% 不罚；>15% 线性收到下限 0.5 |
| `atRate` | `atMe / 总数` | ≥3% → ×1.15，否则不动（低是常态，不罚） |
| `askDensity` | 像提问的比例 | ≥25% → ×1.1 |
| `hourFactor` | 当前小时 | 23–7 点 ×0.5 |
| `costFactor` | 当日成本 | >100 元 ×0.7 · >50 元 ×0.85 |
| `missFactor` | 连续未接拍数 | 每拍 −0.05，下限 0.5 |

合成走**几何平均**（六项等权，下限 `floor=0.15`，上限 1.15）——单信号偏低不会一票否决，多个同时偏低才平滑收敛。`engage.signals.enabled` 默认 **false**（只采集），跑几天看分布再决定启用。

### E · 采集面

`engage-metrics.js` → `data/metrics/engage-<YYYY-MM-DD>.jsonl`（append-only，保留 30 天）：

| event | 触发点 | 字段 |
|:--|:--|:--|
| `roll` | 每拍到点有未读 | `chat / level / rate / roll / hit / unread / idle` |
| `blocked` | 出站闸拦下（新增观测点） | `chat / gate / why / level` |

`sender.js` 的 `noteBlocked(chatKey, gate, message)` 挂在 `hardLimit` 与 `quota` 两道闸抛错前——**这就是"哪道闸在拦"的实锤**，原先完全缺失。

### F · UI（记忆页）

「🤫 安静模式」单按钮 → **五档下拉**（`1·冰封 / 2·保守 / 3·标准 / 4·活跃 / 5·全开`），写 `engage.levelByChat[群号]`；选 1 时双写 `quiet.chats`，选 2~5 时从 `quiet.chats` 摘掉。列表徽标从「🤫 安静」改为显示当前档名（冰封蓝 / 活跃·全开橙 / 其余灰）。

### G · 落点

| 件 | 改动 | 类型 |
|:--|:--|:--|
| `src/engage-level.js` | 五档表 / `levelForChat` / `paramsFor` / `rollParticipation` / `levelHint` | 新增 107 行 |
| `src/engage-signals.js` | 六信号纯函数 + `compositeCoefficient` + `signalSummary` | 新增 105 行 |
| `src/engage-metrics.js` | JSONL 落盘 + 30 天清理 | 新增 61 行 |
| `src/config.js` | `engage.levels` / `levelByChat` / `signals` 默认段 | 补丁 `config-levels` |
| `src/orchestrator.js` | import 三模块 + `browse-tick-gate` 参与率判定 + `levelLine` 提示段 | 补丁 4 点 |
| `src/rapport.js` | `missDelta` 按档位封顶 | 补丁 2 点 |
| `src/sender.js` | `noteBlocked` + 两道闸拦截落采集 | 补丁 3 点 |
| `src/quiet-mode.js` | `isQuietChat` 认同 `levelByChat=1` | 补丁 1 点 |
| `ui/app/05-memory-settings.js` | 五档下拉 + 列表档名徽标 + `setEngageLevel` / `engageLevelOf` | 补丁 8 点 |
| `tools/patch-qqagent-level.mjs` | 幂等补丁（13 点，含三份新文件全文） | 新增 |
| `tools/patch-qqagent-level-ui.mjs` | 幂等补丁（8 点，UI 面独立成因改 UI 单独重放） | 新增 |
| `tools/verify-qqagent-level.mjs` | 58 条判据 | 新增 |

### H · 实测

| 命令 | 结果 |
|:--|:--|
| `node tools/patch-qqagent-level.mjs --dry` | 13 点在位（首跑 applied 13，复跑 skipped 13） |
| `node tools/patch-qqagent-level-ui.mjs --dry` | 8 点在位（首跑 applied 8，复跑 skipped 8） |
| `node tools/verify-qqagent-level.mjs` | **58/58** |
| `node tools/verify-qqagent-quiet.mjs` | **25/25**（UI 断言由"7 个 quiet 点"改为"1 个 quiet 写配置点 + 8 个五档点"） |
| `node tools/verify-qqagent-rapport.mjs` | **52/52**（18a/18b 断言随降级改写：没人接 → `delta=0` 且分数仍 100；有人接 → 80+6=86） |
| `node tools/verify-qqagent-browse.mjs` | **49/49**（自测配置五档全 `rate=1`，避免 60% 概率把节拍断言抖成假红） |
| `node tools/verify-qqagent-session.mjs` | 20/20 · `verify-qqagent-memory.mjs` 43/43 · `verify-qqagent-engage.mjs` 27/27 · `verify-qqagent-hardlimit.mjs` 11/11 · `verify-qqagent-talkstyle.mjs` 22/22 · `verify-qqagent-botguard.mjs` 17/17 · `verify-qqagent-readcompact.mjs` 25/25 · `verify-qqagent-chatvoice.mjs` 19/19 |
| `node tools/verify-import-integrity.mjs` | ALL PASS（66 文件 / 358 符号） |
| `node --check` × 8 | `engage-level` / `engage-signals` / `engage-metrics` / `orchestrator` / `sender` / `rapport` / `config` / `quiet-mode` / `05-memory-settings.js` 全 0 错 |

🔴 **过程中修掉的两个真问题**：

1. **补丁脚本内嵌模板与磁盘漂移**：`patch-qqagent-level.mjs` 的三份 `addFile` 内嵌全文是手写的，与磁盘实际落盘内容有 3 处不一致（首行差异 `engage-level.js:11`）。补丁脚本是重装时的**唯一重放通道**，漂移会导致重装后产出不同代码。已写一次性同步脚本从磁盘回灌模板，复核结果 `LEVEL_JS/SIGNALS_JS/METRICS_JS → SAME`。
2. **`verify-qqagent-level.mjs` 初版用了不存在的 `saveConfig`**：`config.js` 只导出 `updateConfig` / `setRuntimeConfig`。改为 `setEngage` 走 `setRuntimeConfig`（内存态，不落盘、不污染 sandbox 副本），且不受 `deepMerge` "对象合并不会清空旧键"的影响。

另修一处实现：`computeSignals` 的 `askDensity` 分母从 `total` 改为 `other`（`total-self`）——提问密度是"别人在问"的度量，把我自己的发言算进分母会稀释信号。

### I · 遗留

1. **生效需重启业务面**（`启动QQBotB.vbs`）——`Start-Process` 被引擎拦，本会话无通道起进程。UI 改动另需刷新页面（记忆页）。
2. **真链路验收待账号恢复**：账号 2405997337 自 10-23 00:02 离线，OneBot 断连至今；恢复后在群里设一次档位，看 `data/metrics/engage-<日期>.jsonl` 的 `roll` 行是否与配置档位一致、`blocked` 行是否只在真撞闸时出现。
3. **客观信号未启用**（`engage.signals.enabled=false`）：跑 3 天后按 `data/metrics` 里的分布决定是否开，以及 `floor` 取多少。
4. **单档目标日发言未实测**：五档的 `rate` 是按 10-19（459 条）/ 10-22（76 条）两个锚点插值出来的，真实日发言要跑过才校准。
5. **`reply` 字段恒 null**：归档里 `"reply": null` 全命中，`rapport.pointsAtMe` 的"引用我"分支实际只靠文本前缀匹配（`selfNickname` 空 → 退到 `botName`）。`atRate` 信号想算准需先补这个字段。

---

## 七十二、自研单体界面「登录位闪 / 控制台被顶回概览」修复（v0.84 · 2026-10-25）

> 来源：Rushiera 2026-10-25「我感觉我们那个自研单体好像一直在未登录和已登录那里闪」+「然后点其他的比如说协议端控制台也会被一直拉到概览页面」。

### A · 现象与取证

| # | 现象 | 取证 |
|:--:|:--|:--|
| ① | 点「协议端控制台」秒回「概览」 | `app/main.js` 的 `did-fail-load` 回调**不看 `isMainFrame`**：任何 frame 加载失败都 `loadURL` 整个主窗 → 界面重载回初始标签页 |
| ② | 概览「账号登录」卡在「已登录 / 未登录 / 协议端不可达」之间抖 | `app/ui/app.js` 的 `refreshLogin` 每 15 秒一次；接口抛错直接 `return`（保留旧值），但只要拿到 `ok:false` 就写「协议端不可达」——协议端重启期（`fetch failed` 与 `code:0` 交替）就一帧真一帧假 |
| ③ | 抖动源有两条独立成因 | ①界面重载本身会重跑 `refreshLogin()`；②协议端 Worker 重启（`账号状态变更为离线` → `[Login] 账号已离线，正在重启 Worker`）期间 `/api/QQLogin/CheckLoginStatus` 数次 `fetch failed` |
| ④ | 启动日志里「凭据注入」反复出现 | `boot.log` 2026-10-25 05:32 / 05:35 两次 `协议端控制台凭据注入失败：Render frame was disposed` —— 注入后会 `location.reload()`，frame 被销毁与事件叠加 |

### B · 根因（两处）

**根因一 · 免登录注入的判据与写入形态不匹配。** 协议端 WebUI 前端读 token 走 `useLocalStorage`（`JSON.parse`），写入形态是 **JSON 字符串字面量**（带引号）；它启动时还会做一次「裸串 → 带引号」迁移（`Vo&&!Vo.startsWith('"')&&localStorage.setItem(lt.token,JSON.stringify(Vo))`）。而 `main.js` 原实现 `localStorage.setItem('token', "<裸串>"); location.reload();`：

- 写入裸串 → 前端迁移把它改成 `"<裸串>"`（带引号）
- 下一轮 `did-frame-finish-load` 时旧实现的 `injectedFrames` 集合按 **frame.url** 去重——同一 URL 只注入一次，一旦主窗重载集合仍在内存里，**新 frame 会被当"已注入"跳过**；而 `injectedFrames` 记的是旧 frame 的记录，与实际状态脱节
- 与根因二叠加：frame 失败 → 主窗重载 → frame 重建 → 注入 → reload → …… 自激

**根因二 · `did-fail-load` 不分主 frame。** 子 frame（控制台 iframe）任何加载失败都触发主窗 `loadURL`，把界面打回「概览」。并且 `ERR_ABORTED(-3)`（加载被后续导航顶替，注入后主动 reload 必然产生）也被当失败处理 → 重载。

### C · 修法（`app/main.js` + `app/ui/app.js` 两文件）

| 点 | 文件 | 内容 |
|:--:|:--|:--|
| 1 | `main.js` | `did-fail-load` 增 `isMainFrame` 判据：**子 frame 失败只落 `boot.log`，绝不重载主窗**；`errorCode === -3`（ERR_ABORTED）直接忽略；主 frame 失败才重载并记原因 |
| 2 | `main.js` | 免登录注入判据改为**按值比对**：`JSON.parse(localStorage.token) === 凭据` 才视为已就绪；不等才写入（写入形态 = `JSON.stringify(凭据)`，与协议端同形态）并 `location.reload()`。删掉 `injectedFrames` 集合——主窗重载后 frame 重建，集合会记住旧记录而跳过新 frame |
| 3 | `main.js` | 注入期取凭据从「40 轮 × 1 秒」（启动期专用）改为「3 轮 × 300 毫秒」——frame 走到 `finish-load` 时协议端已就绪，长重试只会拖住事件循环 |
| 4 | `ui/app.js` | 去掉启动即 `loadWebui()`——协议端控制台改**纯懒加载**（首次切到该页签才请求）；`switchView('webui')` 在 frame 无 `src` 时补加载（上次失败可重试） |
| 5 | `ui/app.js` | `refreshLogin` 抗闪：`ok:false` / `fetch failed` 时**不改状态位与阶段**（保留上一次已知值），只在提示行标「连接中…（原因）」并禁用两个按钮；且**连续两次失败**才标注（15 秒一次轮询，偶发一次不动显示）；恢复即清计数 |

### D · 验证

| 判据 | 结果 |
|:--|:--|
| `node --check app/main.js` | 0 错 |
| `node --check app/ui/app.js` | 0 错 |
| 注入判据行为自测（同构脚本，CatTemp 用完即删） | 首次 `false`（需刷新）→ 落盘形态 `"sc-test-credential-abc"`（带引号）→ 第二次 / 第三次 `true`（不刷新）→ 裸串旧值 `false` 并改写为带引号形态 → 再判 `true` |
| 界面服务回读（`GET /app.js`） | 已含新代码（`连接中…（` 与 `frame?.getAttribute('src')` 两处命中） |

### E · 遗留

1. **生效需重启自研单体**（`启动QQBotB.vbs`）——`main.js` 是 Electron 主进程，热改不生效；`ui/app.js` 是静态文件，重启后刷新页面即加载。
2. **真链路复验待人工**：重启后点「协议端控制台」应稳定停留（不再被顶回概览）、概览「账号登录」状态位在协议端 Worker 重启期不再抖。判据：`app/data/boot.log` 里不再连续出现「已注入协议端控制台凭据」，只出现一次（首个 frame）。

## 七十三、群名片余额后缀（v0.85 · 2026-10-25）

**需求（Rushiera 口述）：** 记忆里可以指定某个群「打开展示余额」；余额先人工输入、后续留映射接口；默认不开，需要时按群开；开了之后每 30 分钟把本号的**后缀**刷成「@余额xx.xx」。

**拍板三件（Rushiera 2026-10-25，三项均取方案 1）：** ①载体 = **群名片**（不是昵称）②**原名片 + 尾部追加**，旧余额段先剥再拼 ③**启动即同步一次**，之后每 30 分钟一次。

### A · 落点

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 配置 | `src/config.js`（engage 尾） | `engage.balance` 默认段：`value:0` · `chats:[]`（默认全关）· `source:'manual'` · `endpoint:''` · `field:'balance'`（映射接口占位）· `marker:'@余额'` · `intervalMs:1800000` |
| 模块 | `src/balance.js`（新增） | `balanceRule()` / `resolveBalance()`（映射接口单点：现在只认 manual，未知来源**抛错**不回落 0）/ `normalizeAmount()` / `formatAmount()` / `balanceSuffix()` / `stripBalanceSuffix()`（循环剥尾部旧值）/ `composeCard()` / `syncChatCard()` / `syncBalanceCards()` / `startBalanceLoop()`（启动 5 秒首刷 + 定时）/ `stopBalanceLoop()` |
| 启动链 | `src/app.js` | import + `startBalanceLoop(onebot)`（挂在 `startRapportHeal()` 之后） |
| 路由 | `src/routes.js` | `POST /api/balance/sync`（body `{chat?}`：给群号只刷该群，空则刷全部开启群）——记忆页开关 / 改值后立即生效，也是验收通道 |
| UI | `ui/app/05-memory-settings.js` | 记忆页详情头：`💰 余额后缀`开关 + 余额输入框 + `刷新`按钮（仅群聊）；列表徽标 `💰 12.34`；三个写面函数 `toggleBalanceChat` / `setBalanceValue` / `syncBalanceNow` |
| 自测 | `tools/verify-balance.mjs`（新增） | 30 条判据（纯函数真跑 + 源码断言） |
| 补丁 | `tools/patch-qqbotb-balance.mjs`（新增）+ `tools/templates/balance-patches.txt`（11 段）+ `tools/templates/balance.js`（模块模板） | 重装重放通道（`_unpack/` 不入 git）；`--audit` 校验段库与磁盘逐字一致 · `--strip` 逆向还原（在副本上验可复现） |

### B · 拼接与幂等规则

| 规则 | 判据 |
|:--|:--|
| 剥旧值 | 只认**尾部** `marker + [0-9.]+`；循环剥多层（`R喵@余额12.00@余额13.00` → `R喵`）；名片中间的 `@余额` 不动 |
| 拼新值 | `基础名 + marker + toFixed(2)`；基础名取「当前名片剥后」，空则退昵称（`selfNickname`），再空则只剩后缀 |
| 幂等 | 目标 == 现状 → 不发请求（`skipped:true`） |
| 兜底 | 余额取不到（NaN / 未知来源）→ 本轮不刷 + `balance` 日志告警，**不写 0.00** |

### C · 实测

| 判据 | 结果 |
|:--|:--|
| `node --check` × 5 | `balance.js` / `config.js` / `app.js` / `routes.js` / `05-memory-settings.js` 全 0 错 |
| `node tools/verify-balance.mjs` | **30/30** ALL PASS |
| 真链路·只读 | `get_login_info` → `user_id=2405997337` / `nickname=Shieraru`；`get_group_member_info(689942975)` → `card=""` · `card_changeable=true` |
| 真链路·写面 | `set_group_card` 写 `Shieraru@余额88.88` → 读回 **`card:"Shieraru@余额88.88"`**（生效）→ 写回 `""` → 读回 `card:""`（**已恢复原状**） |
| 真链路·形态 | bot 在群 689942975 没设过名片 → 开后缀后的目标名片 = `Shieraru@余额xx.xx`（昵称兜底） |
| 补丁可复现 | `--audit` **11 段全 audit-ok**；副本 strip → apply 后 5 个文件 SHA256 与磁盘**逐一相等**（`config.js` / `app.js` / `routes.js` / `05-memory-settings.js` / `balance.js`）· `node --check` 补丁脚本 0 错 |

### D · 遗留

1. **生效需重启业务面**（`启动QQBotB.vbs`）——`Start-Process` 被引擎拦，本会话无通道起进程；UI 改动另需刷新页面（记忆页）。
2. **功能面真链路待重启后验**：重启 → 记忆页给某群勾上「💰 余额后缀」→ 填值 → 点「刷新」→ 群里看本号名片尾部是否出现「@余额xx.xx」；再等 30 分钟看 `data/logs/qq-agent-*.log` 的 `balance` 行是否按周期出现（值没变应为 `skipped`，不产生写请求）。
3. **映射接口未接数据源**：`source` 目前只认 `manual`；接自动余额时改 `resolveBalance()` 并填 `endpoint` / `field`。

## 七十四、群语音伴随（v0.86 · 2026-10-25）

**需求（Rushiera 口述）：** 记忆里可以给某个群开 TTS；用 Irodori 的「依田芳乃 · v4.1-Small」；开了之后**所有决定发到群里的发言**都再过一次 TTS——转成日语口语表达，发到群里。

**口径澄清（Rushiera 2026-10-25 追加）：** 合成能力由 **ComfyDock** 提供，群 bot 本来就有「念一句」的工具（`tts_speak`）——本次要做的是**接口**：业务面在每句发言发出去之后，把这句话交给单体念一遍，不必新造合成链。

### A · 落点

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 配置 | `_unpack/resources/app/src/config.js`（engage 尾） | `engage.voiceReply` 默认段：`enabled:true` · `chats:[]`（默认全关）· `runMode:'small'`（依田芳乃 · v4.1-Small）· `maxChars:500` · `caption:''` |
| 模块 | `_unpack/resources/app/src/voice-reply.js`（新增） | `voiceRule()` / `voiceChats()` / `isVoiceChat(chatKey)` / `voiceReply(chatKey, text)`——只做转发，POST `127.0.0.1:3280/api/nav/tts`（`by:'auto'` · `auto:true` · `queue:true` · `runMode`） |
| 发送面 | `_unpack/resources/app/src/sender.js` | import + `sendTextBatch` 里**发送成功之后**挂 `voiceReply(chatKey, text)`（只在 `kind === 'group'`）；不 await、不抛出 |
| 单体·执行体 | `app/src/navigator/media.js` | `ttsSpeak` 增 `auto` / `runMode` / `queue`；抽出 `runTtsJob`（档位强制写 `cfg.RunMode`）；`waitTts` 增 `auto`（不补发文字配文）；排队三件 `ttsQueue` / `ttsDraining` / `drainTts()` + 上限 12 句 |
| 单体·路由 | `app/src/navigator/index.js` | `ttsSpeak` 透传 `auto` / `runMode` / `queue`（闸门 feature 名按 auto 分「群自动语音」）；`POST /api/nav/tts` 认 `by:'auto'` + `queue` |
| UI | `_unpack/.../ui/app/05-memory-settings.js` | 记忆页详情头「🔊 语音伴随」开关 + 「依田芳乃 · v4.1-Small · 每句 ≤N 字」说明（仅群聊）；列表徽标 `🔊 语音`；两个写面函数 `voiceRuleOf` / `toggleVoiceChat` |
| 补丁 | `tools/patch-qqbotb-voicereply.mjs`（新增）+ `tools/templates/voice-reply.js` | `_unpack/` 不入 git，运行副本改动的唯一重放通道；10 个补丁点全带 `[qqbotb-voicereply:*]` 标记，重跑全 skipped；模块「内容不同即同步」 |
| 自测 | `tools/verify-qqbotb-voicereply.mjs`（新增） | 30 条判据（纯函数真跑 + 源码断言） |
| 探测 | `tools/probe-tts-duration.mjs`（新增） | 读 `app/data/media-out/*.wav` 的 RIFF 头算真实时长（不解码音频） |

### A2 · 30 秒上限取证（Rushiera 追问「语音好像最大只能发 30 秒」）

| 判据 | 证据 |
|:--|:--|
| 运行时默认夹取 | `irodori-tts/inference_runtime.py:218` `max_seconds: float = 30.0`；:1257 `min(max_seconds, max(min_seconds, manual_seconds))`；:1324 `max_frames = floor(max_seconds * sample_rate / hop)` |
| ComfyDock 未传该字段 | `ComfyDock/Tts/TtsWorkerScript.cs:175-186` 与工作副本 `data/tts/tts_worker.py:164-175`——`SamplingRequest(...)` 参数表里**没有** `max_seconds` |
| checkpoint 训练窗口就是 30 秒 | `irodori_tts/config.py:190-194` `max_latent_steps = 750` · `fixed_target_latent_steps = 750`；`configs/train_v4_small.yaml:72-88` 同；750 × 1920 / 48000 = **30.000s** |
| 越过时的后果 | `inference_runtime.py:1347-1355` 运行时自己警告「Long-tail stability may degrade」——不是不出声，是音质垮 |
| 产物实锤 | 17 条 `app/data/media-out/*.wav` 里 9 条恰好 **30.000s / 2,880,044 字节 / 48 kHz**（有内容可念却停在 30s = 被夹，不是句末） |
| 语速实测 | `tools/probe-tts-length.mjs`：日语 59 字 → 16.88 秒 → **3.495 字/秒**；30 秒 ≈ **104 字**、20 秒 ≈ 69 字 |

**结论：** 上限抬不动（运行时默认 + 训练窗口两处都在 IrodoriTTS 侧，改 checkpoint 才算越界）。处置改为**先切后念**：`maxChars` 默认 **90 字**（约 26 秒，留停顿余量）；单体 `clipForSpeech(japanese, TTS_MAX_CHARS=100)` 再兜一道，切点优先句末标点（。！？…；）、其次逗号级、最后才硬切。

### A3 · 档位分层（Rushiera 2026-10-25）

| 口径 | 档位 | 理由 |
|:--|:--|:--|
| **手工念**（群里 @「念一下」/ 界面点按钮） | `large-int8` | 音质优先；用户明确要听这一次 |
| **语音伴随**（每句发言都念，`auto` / `queue`） | `small`（依田芳乃 · v4.1-Small） | 省时省显存；群里一直念，量大 |

实现：`ttsSpeak` 取 `runMode || ((auto || queue) ? 'small' : 'large-int8')`——显式传优先于默认。

### B · 关键判据

| 规则 | 判据 |
|:--|:--|
| 触发点 | **发送成功之后**（`#markSent` 之后、return 之前）——语音不是发言的前置，OneBot 失败的句子不该被念 |
| 只对群 | `String(kind) === 'group'`——私聊没有群号，也没有「群里听声」的需求 |
| 档位分层 | 手念 `large-int8` / 伴随（auto、queue）`small`——见 A3 |
| 字数窗口 | 业务面按**中文 60 字**切；单体翻译后按 `clipForSpeech(japanese, 100)` 再兜一道（≈28.6 秒），切点优先句末标点——见 A2 |
| 续接指令 | 语音**不参与**「重来 / 再来一次」——伴随语音自动触发，重来时再调 `tts_speak` 会让群里出现两条一样的语音；教材已写死（`role/media-rules.md` + `NAV_QUICK`） |
| 不补文字 | `waitTts` 的 `if (!auto)` 分支——文字已由发言方发过；连 `sayRecord` 的 caption 也置空，避免「语音 · 前 40 字」再露一遍 |
| 排队而非回绝 | `queue=true` 入队，`drainTts` 串行「提交 → 等收口 → 下一句」；手动路径仍「忙就回绝」 |
| 队列上限 | 12 句，超出丢最旧并 `record('error', ...)` 出声——不静默截断 |
| 失败面 | 转发失败 `logger.warn`；合成失败 / 超时由单体 `say` 回群告知（沿用既有 `waitTts` 语义） |

### C · 自测

| 判据 | 结果 |
|:--|:--|
| `node --check` × 5 | `voice-reply.js` / `sender.js` / `config.js` / `media.js` / `05-memory-settings.js` 全 0 错 |
| `node tools/verify-qqbotb-voicereply.mjs` | **30/30** ALL PASS（含 `clipForSpeech` 四条纯函数断言 + 档位分层断言） |
| 补丁复跑 | `skipped 9 · synced 1`（幂等实锤：模块内容变更时同步、其余跳过） |
| 消费点只读 | `GET /api/tts` → `plan.label = 依田芳乃 · v4.1-Small · 全 GPU` · `runMode=small` · `env.canGenerate=true`；ComfyDock 在线 |
| 时长探针 | `node tools/probe-tts-duration.mjs` → 17 条 wav · 48 kHz · 2.08~30s · 其中 9 条恰好停在 30.000s（夹取实锤） |
| 语速实测 | `node tools/probe-tts-length.mjs`（临时脚本，跑在 `tools/CatTemp`）→ 59 字 / 16.88s = **3.495 字/秒** |

### D · 遗留

1. **生效需重启业务面**（双击 `启动QQBotB.vbs`）——`Start-Process` 被引擎拦，本会话无通道起进程；改的是 `_unpack` 运行副本 + `app/src` 单体源码，两者都要重启才吃下。UI 另需刷新页面（记忆页）。
2. **真链路待验**：重启 → 记忆页给某群勾「🔊 语音伴随」→ 群里让 bot 说一句话 → 期望「文字一条 + 语音一条」，且语音条不带「语音 · …」caption；连说两句应依次念完（第 2 句入队不丢失）。
3. **补丁点 `ui-helpers` 的坑（已修）**：初版该点名 `ui-fns`、标记串取 `[qqbotb-voicereply:ui-helpers]`，与插入内容自带的标记不一致 → 重跑会再插一份函数（实测出现两份 `voiceRuleOf`）。已改点名对齐标记串；本机副本里多出的一份已用正则合并。
4. **30 秒上限不抬（判定已定）**：运行时默认 + checkpoint 训练窗口两处都在 IrodoriTTS 侧，抬它要改 checkpoint（越界且音质会垮）；处置 = 字数窗口（中文 60 字 / 日语兜底 100 字）+ 先切后念。若日后要「整段念完」只有两条路：拆多条语音（现状即如此，最稳）或改运行时 `max_seconds` 并接受尾部稳定性下降（未做）。
5. **运行态 maxChars 已热写**：`POST /api/config` 把 `engage.voiceReply.maxChars` 500 → **60**（读回复核：chats / runMode / enabled 三项原样），无需等重启即对**下一句**生效。

## 七十五、单体内群名单编辑（v0.87 · 2026-10-26）

**需求（Rushiera 口述）：** 「开工 qqbotb，添加删除群名单让我在自研单体里可以直接输群号修改」——不再进业务面的记忆页 / 白名单弹窗翻群，在自研单体里**手输群号**即可增删。

**前提核验（动手前实测）：** 业务面的接入白名单真相源 = `_unpack/data/config.json` 的 `allow.groups`（8 个群）+ `deny` + `allowAllWhenEmpty`；`GET /api/config` 脱敏读、`POST /api/config` 走 `updateConfig()`（内存活配置 + tmp→rename 原子落盘）。**业务面把配置持在内存单例**（`getConfig()`）——直改磁盘文件它不重读，表现为「文件改了、名单没变」，故写面必须经它的 HTTP 接口。

### A · 落点（全部在自研单体 `app/`）

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 配置 | `app/src/config.js` | 新增 `business` 段：`apiUrl:'http://127.0.0.1:3210'` + `token:''`（对应业务面的 `server.token`；空 = 它未设令牌免授权） |
| 模块 | `app/src/business.js`（新增） | `createBusinessClient()`——`readLists()` / `writeLists()` / `readOnlineGroups()`；根地址解析 = 配置地址优先 + **端口段探测**（业务面从 3210 起向上找空位，起在 3211 时写死地址会挑空）+ 用 `allow.groups` / `deny.groups` 形态校验「是不是业务面」；`normalizeIds()` 只留纯数字、去重；写后立即读回 |
| 接口 | `app/src/web/groups-api.js`（新增） | 三条：`GET /api/groups`（读）· `GET /api/groups/online`（协议端所在群，只读辨识用）· `POST /api/groups`（写）；业务面失败一律 502 + 原文，**不吐空名单假装成功** |
| 装配 | `app/src/app.js` | `createBusinessClient(...)` 与 `...createGroupsApi({ business, log })` 挂进 web api 表 |
| UI | `app/ui/index.html` / `app.js` / `style.css` | 新页签「群名单」——**两栏看板**（左「未启用」= 协议端所在但不在白名单的群；右「已启用」= 白名单里的群），**拖动即发请求**（无保存按钮）；顶部「输群号回车加入」；折叠「高级：拒绝名单 · 空名单放行」 |
| 自测 | `app/tools/verify-groups.mjs`（新增） | 20 条判据，真链路（会真写业务面配置，**收尾必须还原**） |

### A2 · 第二轮改版（Rushiera 2026-10-26 当天追加）

**反馈：** 「这个群名单我没看懂，协议端所在群感觉是所有的；当前已白名单的群和还有哪些群不在白名单能展示，或者说通过拖动来快速确定嘛；post 信息你让软件代填就行，拖动立刻发请求，删掉也是」。

| 改动 | 内容 |
|:--|:--|
| 视图 | 双文本域 → **两栏看板**：左「未启用」（协议端 18 群减去白名单）、右「已启用」（白名单 8 群）；每栏带计数；条目显示群名 + 群号（协议端没返回的群标「（协议端未返回该群）」） |
| 交互 | **拖动跨栏即生效**：拖到右栏 = 加入白名单、拖回左栏 = 移除——`drop` 里直接 `POST /api/groups`，无保存按钮；另给每条的「启用 / 移除」按钮（触摸板 / 远程桌面下拖动不好使时的等价通道） |
| 手输 | 顶部输入框：输群号按回车（或点「加入」）即加入白名单——不用再翻弹窗找群 |
| 拒绝名单 | 收进折叠区「高级」，仍保留文本框 + 应用按钮（低频，不该占主视野） |
| 请求体代填 | `collectGroupPatch()` —— 前端只表达「这次改了哪一栏」，其余两栏由内存态原样带上；`allowAllWhenEmpty` 复选改动也立刻提交 |
| 冲突自动收敛 | 把在拒绝名单里的群拖到右栏 / 手输它 → 提交时**同时把它从拒绝名单摘掉**（否则业务面按同群冲突拒写），不需要人工先去高级区清 |
| 失败重试 | `business.js` 加 `withRetry()`——只对「地址不可达」类（`fetch failed` / `ECONNREFUSED` / `ETIMEDOUT` / 超时）重试一次并清掉已解析地址；连点重排导致的一次 fetch failed 不再变成界面失败提示（实测抓到一次：`移除 123456789失败：… fetch failed`，重试即恢复） |
| 写后一致 | 回执里的 `allowGroups` / `denyGroups` 直接用于重渲染——界面永远显示业务面读回值 |

### C · 自测

| 判据 | 结果 |
|:--|:--|
| `node --check` | `business.js` / `groups-api.js` / `app.js` / `config.js` / `ui/app.js` 全 0 错 |
| `node app/tools/verify-groups.mjs` | **20/20** ALL PASS（连跑两轮同结果；读面 5 条 · 写面 3 条 · 内存生效 1 条 · 去重 / 非法过滤 2 条 · 重叠负例 3 条 · 拒绝名单 2 条 · 协议端群列表 3 条 · 还原 1 条） |
| 真链路·读 | `GET /api/groups` → `apiUrl=http://127.0.0.1:3210` · allow 8 个群 · deny 空 · `allowAllWhenEmpty=false` |
| 真链路·写 | 加假群 `135792468` → 读回含该号 → 删除 → 读回不含；**最终态与开跑前逐字一致** |
| 真链路·协议端 | `GET /api/groups/online` → 18 个群（含 `785638698 偶像大师灰姑娘女孩mod交流分享群`） |
| 界面渲染·真单体（PID 18272，已重启） | 截图实锤两栏：左「未启用 11 个」右「已启用 8 个」，状态行「名单已载入（http://127.0.0.1:3210）· 协议端 18 个群」；`819158977` 正确标「（协议端未返回该群）」 |
| 交互实测·真单体 | ① 拖 731504817 到右栏 → 「启用 731504817：已生效（已启用 9 个）」，拖回 → 「移除 731504817：已生效（已启用 8 个）」② 按钮通道：884239594 启用 → 移除 ③ 输群号回车：123456789 启用成功且输入框清空 ④ 拒绝名单写入后条目在左栏并带提示；把该群拖到右栏 → 高级区 `#groups-deny` 自动清空 ⑤ 一次 `fetch failed` 重试后恢复 |
| 最终态回读 | `GET /api/groups` → `{"allowGroups":[8 个原群],"denyGroups":[],"allowAllWhenEmpty":false}`——**与改动前完全一致**（自测与实测用的都是假群号） |

### D · 遗留

1. **真链路待人工点一次**（单体已在跑，路由已生效）：群名单页签 → 左栏应列 11 个未启用群 → 拖一个真群进去 → 群里发一句话确认能进猫。
2. **业务面若日后设了管理令牌**：`business.token` 要同步填同一个值，否则读写会被拦下（现业务面 `server.token` 为空，免授权）。

## 七十六、日语译文人称口径（v0.88 · 2026-10-26）

**需求（Rushiera 口述）：** 「语言伴随转 tts 日语时，对于【我】的翻译一律改为 watashi，禁用 ore 和 boku 等男性用语；喊他人时也尽量用 kimi，减少使用 omae 等不礼貌的词汇；仅针对 tts 日语翻译有效」。

**范围边界：** 只动**语音台词的日语译文**——群里的中文正文、发给 MOSS 的英文提示词、反推标签一律不受影响。

### A · 落点（两道：提示词 + 代码兜底）

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 提示词 | `app/src/navigator/index.js`（`translateForMedia` 的 `target === 'ja'` 分支） | 加「人称口径」段：第一人称一律 **わたし**（禁 俺 / 僕 / おれ / ぼく / わし / わたくし）；第二人称优先 **きみ**（需要敬语时 あなた），禁 お前 / 貴様 / てめえ / あんた；人称写**平假名**（不写汉字「私」——TTS 可能读成 わたくし） |
| 兜底 | `app/src/navigator/media.js` 新增导出 `normalizeJapanesePronouns(text)` | 提示词不听话时按词表归一：自称 `俺/おれ/僕/ぼく/わし/あたし/わたくし` → `わたし`；`おれ` 用 `(?!い|ん)` 避开同音的 **お礼 / おれんじ**；复数形态（俺たち / 僕ら …）→ `わたしたち`；对称 `お前/おまえ/貴様/きさま/てめえ/てめぇ/あんた` → `きみ`，`お前たち/あんたたち` → `きみたち` |
| 出口 | `app/src/navigator/media.js`（`translateJapanese`） | **三条出口全过归一**：已是日语（含假名）· 无中文 · 翻译回来——口径与源语言无关；手工念与伴随语音共用同一执行体，两条通道都吃 |
| 教材 | `role/media-rules.md` · `tools/apply-qqagent-config.mjs` 的 `MEDIA_RULES` | 语音段补一行人称口径（业务面 R喵 知道这条口径，不用自己换词）；生成器与落盘文件同源 |
| 自测 | `tools/verify-media.mjs` | 新增 2 条断言（人称归一 10 例 + 归一后不含男性 / 不礼貌代词），含 `私服 / 私立` 与 `お礼` 两条**负例**守住不误改 |

### B · 关键判据

| 规则 | 判据 |
|:--|:--|
| 长词优先 | `俺たち / 僕たち / おれたち` 先于单字替换——否则「おれたち」被切成「わたしたち」再被后续规则二次污染 |
| 汉字「君」不动 | 君读 きみ / くん 两读，硬替换会毁掉人名后缀（「佐藤君」⇒「佐藤きみ」）；只归一假名与不礼貌说法 |
| 汉字「私」→ わたし 带排除表 | `私服 / 私立 / 私的 / 私有 / 私用 / 私物 / 私鉄 / 私生活 / 私邸 / 私財 / 私案 / 私見 / 私情 / 私製` 不替换——它们不是人称用法，改了会改义 |
| 同音避让 | `おれ(?!い|ん)` 挡 `お礼`（おれい）/ `おれんじ`——不挡就会把「お礼を言う」改成「わたしを言う」 |
| 只做纯字符串替换 | 不触网、不异步——可在 `node tools/verify-media.mjs` 里直接真跑断言 |
| 只对 Ja 生效 | `translateForMedia` 的英文 / JSON 分支原样未动；`normalizeJapanesePronouns` 只被 `translateJapanese` 调用 |

### C · 自测

| 判据 | 结果 |
|:--|:--|
| `node --check app/src/navigator/media.js` / `index.js` | 全 0 错 |
| `node tools/verify-media.mjs` | **10/10 通过**（原 8 条守门断言 + 新增人称两条；人称用例 8 → **10 例**） |
| `node tools/verify-import-integrity.mjs` | ALL PASS（**68 文件 / 365 符号**——新导出符号 `normalizeJapanesePronouns` 全链可达） |
| 归一实跑 | `俺がお前を助ける。僕たちも行く。あんたは待っていろ` → `わたしがきみを助ける。わたしたちも行く。きみは待っていろ` |
| 生成器重跑 | `node tools/apply-qqagent-config.mjs --roletext-only` → `roleTextChars` **5271**（与改前一致）· `role/*.md` 三件已重写 · `allow.groups` 10 群原样 |

### D · 遗留

1. **生效需重启自研单体**（双击 `启动QQBotB.vbs`；`Start-Process` 被引擎拦，本会话无通道起进程）——改的是 `app/src/navigator/{index,media}.js`（单体侧，启动时加载）。教材已落盘 `role/media-rules.md` + `_unpack/data/config.json`，业务面**开新会话**后吃到。
2. **真链路待听**：重启后群里让 bot 说一句带「我 / 你」的话（触发伴随语音或手工「念一下」）→ 期望日语语音里是 わたし / きみ，听不到 おれ / ぼく / おまえ。
3. **「尽量」的边界**：第二人称硬归一只覆盖 お前 / 貴様 / てめえ / あんた；`あなた` 与 `君` 保留原样（敬语场景与名词后缀都合法）——若群里仍听到过于生硬的称呼，扩词表即可，口径不动。

---

## 七十七、缓存命中归因 / 用量重置 / 采集面（v0.89 + v0.90 · 2026-10-26）

**需求（Rushiera 三段口述）：**

1. 「先把用量数据置空(只留10.26开始的用量数据)，hy4-preview-f这边已经永久停用了，按现数据留一个推荐使用方式的文档，然后我们来探讨一下优化命中率的可行性，就算没有那么有效果也能做好数据收集通道，后续在进一步优化」
2. 三选拍板：「第一件 可以 / 第二件 不砍总量 只讨论是否可以通过优化顺序的方式来共享缓存 / 第三件 我希望先开数据收集通道，然后第三件的数据可以跑几天直接取」

### A · 归因结论（重置后全量实测）

| 结论 | 判据 | 数字 |
|:--|:--|:--|
| 决定性变量是**同群回访间隔**，不是群数 | 同间隔内按「中间夹了几个别的群的调用」分桶，命中率无差别 | <2min：夹 0 = 39.0% / 夹 1-2 = 36.0% / 夹 ≥3 = 36.6%；2-10min：32.4 / 36.7 / 33.6 |
| 丢的是上游 TTL（约 20 秒），代码改不动 | 间隔 → 命中：<20s **95.8%** → 20-40s 61.4% → 40-60s 47.1% → 1-2min 38.2% → 2-5min 32.8% → ≥10min 回升 36-58% | 918 次调用 / 432 会话 / 全 deepseek-v4.1-flash |
| 命中主体是**跨群共享的固定前缀**，不是上一轮字节复用 | 会话首次调用命中 **78.2%** > 全部调用 68.9% | 同上 |
| 跨群可共享前缀 = 系统提示 2,048 + 前三段 5,951 = **8,031 字符 ≈ 5,354 tok** | 逐段跨群相同率：角色设定 / 表情包 / 引导 = 100%，记忆 / 已读 = 0% | 分叉点在第 5,957 字符（【记忆】段起点） |
| 锚点机制（promptAnchor）收益 1.9 个百分点，但保住同群 73% 的分叉后内容 | anchored 70.0% vs reset 68.1%；同群分叉落点：新已读 38% + 已读 35% + 记忆 20% | 结论 = **不退役** |

### B · 顺序优化模拟（第二件 · 已证伪）

**方法：** `tools/sim-prompt-reorder.mjs`——取 445 个真实 prompt 快照，按 5 种候选顺序重建后逐对算公共前缀（纯离线，不改代码）。

| 顺序 | 同群中位 | 跨群中位 |
|:--|--:|--:|
| **现行（基线）** | **20,942 字符（≈13,961 tok）** | 5,983 字符（≈3,989 tok） |
| A 记忆后移（已读在前） | 15,774（**−23%**） | 6,039（+0.9%） |
| B 记忆移到前情提要前 | 20,157（−4%） | 6,039（+0.9%） |
| C 记忆移到未读前 | 15,774（**−23%**） | 6,039（+0.9%） |
| D 前情提要提到已读前 | 15,774（**−23%**） | 6,039（+0.9%） |

**根因（逐段可共享率）：**

| 段 | 跨群相同 | 同群相同 | 段长中位（字符） |
|:--|--:|--:|--:|
| 角色设定 | 100% | 100% | 5,292 |
| 可用表情包 | 100% | 100% | 405 |
| 引导说明 | 100% | 100% | 254 |
| 记忆 | **0%** | **80%** | 8,877 |
| 前情提要 | 0% | 100% | 741 |
| 已读信息 | 0% | 42% | 10,459 |
| 新已读信息 | 0% | 9% | 342 |
| 未读信息 | 1% | 0% | 212 |
| 当前时间 | 0% | 0% | 29 |

**判定：现有「稳定→易变」顺序已接近该结构下最优。** 跨群前缀的物理上限 = 前三段合计 5,951 字符（+系统提示），再优化最多 +56 字符（+0.7%）；同群侧任何后移都是丢掉 80% × 8,877 的稳定量。

### C · 采集面落地（第一件 + 第三件）

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 模块 | `src/cache-metrics.js`（模板 `tools/templates/cache-metrics.js`） | 每次 LLM 调用落一行到 `data/metrics/cache-<YYYY-MM-DD>.jsonl`；22 字段；仿 `engage-metrics.js` 旁路（全 try/catch · 采集失败不影响运行 · 30 天自动清理 · 缺 `chatKey` 直接跳过不落脏行） |
| 配置 | `config.js` 新增 `cacheMetrics: { enabled:true, keepDays:30 }` | 打补丁点 `config` |
| 调用点 | `orchestrator.js` 在 `addUsage` 之后 | 传入 `userPrompt`（构建产物，不含运行时追加的配额 / 热度尾巴——尾巴每轮变，算进去会让【未读信息】之后永远「分叉」）；`sentUsrChars` 另记 |
| 补丁 | `tools/patch-qqbotb-cachemetrics.mjs`（4 点幂等） | `--dry` 预演 · `--app=` 指定根 · 已含标记即 skipped（复跑实测 `applied 0 · skipped 4`） |
| 读端 | `tools/cache-metrics-report.mjs` | 十段：总量 / **TTL 曲线**（12 档分桶）/ 同群间隔对照 / 分叉落点 / 逐段变化率 / 锚点模式 / 体量分桶 / 按群 / 按天 / **TTL 拐点定位**（10 秒粒度找陡降） |
| 离线报告 | `tools/cache-hit-report.mjs` | sessions 口径十段（间隔×夹带 / 公共前缀 / 分段位置 / 首次调用 / 分叉落点 / 每日趋势） |
| 自测 | `tools/verify-qqbotb-cachemetrics.mjs` | **13/13 ALL PASS** |

**关键设计 —— TTL 变成自然实验：** 所有群的前缀头部（前 4,096 字符 = 系统提示 + 角色设定 + 表情包 + 引导）100% 相同 → 每次调用天然就是一次 TTL 探针。`headGapSec` 记「同一前缀指纹距上次发送多少秒」，跑几天后按它分桶看命中即得衰减曲线。**原计划的 600 次控制实验（第三件原提议）作废。**

### D · 用量重置（v0.89）

| 项 | 实况 |
|:--|:--|
| 切分口径 | `sessions/<id>.json` 的 `startedAt` < **2026-10-26 00:00（本地）** |
| 移走（**非删除**） | **9,575 文件 / 2,201.0 MB** → `WorkSpace:tools/CatTemp/qqbotb-usage-archive-20261026/`（可原样还原） |
| 保留 | 435 文件 / 62.3 MB（10-26 00:07 起） |
| `usage-days/` | 16 个日文件全部移走（现存 0，按需从 sessions 回算固化） |
| `telemetry-totals.json` | 备份后归零（原 calls=11,721 / prompt=816,330,441——旧累计 60% 是被停用的 hy4-preview-f，留着污染均值） |
| `session-index-cache.json` | 一并移走让宿主重建（否则索引残留已移走条目） |
| `usage-today.json` | 保留（dayKey=2026-10-26） |
| 脚本 | `WorkSpace:tools/CatTemp/qqbotb-usage-purge.mjs`（带 `--dry` 预演；实测 0 坏文件） |

### E · 顺带修掉的两处真问题

| # | 问题 | 后果 | 处置 |
|:--:|:--|:--|:--|
| 1 | `tools/cache-diag.mjs:92` 输出路径写死 `WorkSpace/CatTemp/`（实际是 `WorkSpace/tools/CatTemp/`） | 该脚本此前**完全跑不了**（ENOENT）——现成诊断形同不存在 | 改指正确路径并复跑通过 |
| 2 | `cache-hit-report.mjs` 用 `indexOf` 找段标题 | 【引导说明】正文里也提到「【已读信息】/【未读信息】」→ 误命中，把分叉点误判在已读段 | 改为按 `\n\n` 切段取段首（`splitSections`） |

### F · 自测汇总

| 判据 | 结果 |
|:--|:--|
| `node --check` × 3（cache-metrics / orchestrator / config） | 全 0 错 |
| `node tools/verify-import-integrity.mjs` | ALL PASS（**69 文件 / 368 符号**——新导出 `recordCacheCall` / `splitSections` / `cachedOf` / `cacheMetricsDir` 全链可达） |
| `node tools/verify-qqbotb-cachemetrics.mjs` | **13/13 ALL PASS**（分段含正文同名标题负例 · 指纹稳定 · 19 字段齐备 · 前导连续比对 · cached 三条返回路径 · 三种旁路失败场景 · 行数自证） |
| 真环境冒烟 | 真实 `DATA_DIR` 落行 22 字段 · 段识别 `role,sticker,guide,memory,read,unread,time` · 探针行已清理 |
| 补丁幂等 | 复跑 `applied 0 · skipped 4` |

### G · 遗留

1. **生效需重启业务面 QQ Agent**（`_unpack` 源码在启动时加载）——重启后开始落 `data/metrics/cache-2026-10-26.jsonl`。验证：跑几次群聊后 `node tools\cache-metrics-report.mjs`。
2. **TTL 曲线待数据积累**——今日窗口样本不足（<5 条的分桶显示「样本不足」），跑一天再看「二、TTL 曲线」与「十、TTL 拐点」。
3. **缓存计价折扣率未取数**——`api.priceCachedPerM = 0` 且 `useOfficialPrice = true`，实际单价由远端价格表决定，未核对。
4. **【记忆】段构成未拆**——约 7,500 字符里会话要点 / 群记 / 群友印象各占多少未分离。
5. **O5（砍 prompt 总量）按用户裁定不做**——`ref-cache-hit.md` §八 已记。

---

## 七十八、掉登录现场取证 + 登录探针（v0.91 · 2026-10-27）

**触发（Rushiera）：** 群里 bot 不回话 → 查得协议端 `waiting_qrcode`、OneBot 3000/3001 未监听 → 「先对灾难现场做探针，后续掉登录我希望知道是什么原因，比如掉登录前最后几条消息是什么，哪个群」→ 追加「不是接到的消息，是最后发的消息」→ 「看看修一下，有发现跟我说，实在没发现也留一下后续侦察的位点」。

### A · 现场时间线（三源互证）

| 时刻 | 证据 | 含义 |
|:--|:--|:--|
| 12:04:37 | 业务面日志 `[发送 -> group:361820329]` 「懂了，嘉豪＝不着调…」 | **bot 最后一次发言**（群 361820329 白毛红瞳一家亲） |
| 12:09:52 | 单体日志 `接口 GET /api/qq/login 异常：fetch failed` | 6099 WebUI 首次不可达（此后零星复发） |
| 12:12:55 | `[browse] group:361820329 静默补拍：1 条新内容进 LLM` | 业务面最后一次成功处理消息 |
| 12:17:57 | 协议端日志 `接收 <- 群聊 [大耳的音趴交流-主群(312080198)] [哦鲸鲸(1808736969)] 还有，道什么歉啦，我可没惹他。` | **协议端收到的最后一条消息**（此后该文件再无收发行） |
| 12:33:01 / 13:03:01 / 13:06:37 | `NTEvent ... fetchUserDetailInfo Timeout` | QQ 内核与服务器通路持续失效（NapCat 进程仍在、`get_login_info` 仍回 Shieraru） |
| 13:10:29–35 | `连接已断开` → `协议端已停止（pid=35020,26948,8100,37692,54008）` → `已拉起协议端（pid=51788）` | 单体退出钩子 `napcat.stop()` 对整个 NapCat 进程树 `taskkill /T /F`；新实例 `-q 2405997337` 快速登录失败 |
| 13:13 起 | `/api/qq/login` → `isLogin:false / loginPhase:waiting_qrcode / coreReady:false`；`POST /api/qq/login/quick` → `登录态已失效，请重新登录` | 只能扫码（实际 21:4x 由人工扫码恢复） |

### B · 判定与修掉的真问题

| # | 判定 | 处置 |
|:--:|:--|:--|
| 1 | **不是 13:10 重启导致掉登录**——12:17:57 消息断流、12:33 起内核超时都在重启之前 | 无（记录） |
| 2 | **13:10 重启是二次伤害**——退出钩子强杀协议端进程树，把「半死」变成「必须扫码」；`tools/entry.cmd` 里特意写过「绝不杀 NapCat，杀它就要重新登录」，钩子没守住同一策略 | 记录待改：托盘已有「退出（协议端保持运行）」通道，钩子杀进程只在「退出并停止协议端」时发生；本次现场触发源无 web 请求记录，按「托盘退出并停止协议端」处理，未改代码 |
| 3 | **`webui.call` 的 fetch 无超时**——协议端卡死时挂起的请求会堆积（界面每 15 秒轮询一次），失败退化为「悬挂」 | 🔴 已修：`src/napcat/webui.js` 两处 fetch 加 `AbortSignal.timeout(5000)`（`FETCH_TIMEOUT_MS`） |
| 4 | 「单体探针/扫描直接触发掉登录」**未被证据支持**——12:12:55 之后业务面零请求（日志空白），12:09 的 6099 不可达早于消息断流 | 无法证伪，也无法证实：平台侧零 kickoff 证据 → 补探针（下） |

### C · 落点（登录探针）

| 面 | 文件 | 内容 |
|:--|:--|:--|
| 模块 | `app/src/incident/login-watch.js`（新增） | 周期采样（默认 30 秒）：`loginStatus`（isLogin / loginPhase / coreReady / loginError）· 3000/3001 端口 · 协议端日志尾（最新 `接收 <- 群聊` 行）· 业务面日志尾（最新 `[发送 -> …]` 行）；每采样一行落 `data/incidents/watch-<日期>.jsonl` |
| 快照 | 同上 | 命中异常 → `data/incidents/<yyyyMMdd-HHmmss>_<原因>.json`：登录态 · 通道 · **最后 20 条收 + 最后 20 条发**（群号 / 发送人 / 正文）· 静默秒数；同原因 30 分钟去重，产物保留 30 天 |
| 判据 | 同上 | `login_down`（连击 2）· `core_not_ready`（连击 2）· `webui_unreachable`（连击 3）· `onebot_down`（连击 3）· **`silent_no_message`（默认 30 分钟无任何群消息——12:17 那种静默失联不报错，只能靠它抓）** |
| 装配 | `app/src/app.js` | `createLoginWatch(...)` → `start()` / `stop()`；新增 `POST /api/incident/sample` 手动采一次；`return` 暴露 `loginWatch` |
| 配置 | `app/src/config.js` | 新增默认段 `incident: { enabled:true, intervalMs:30000, silentMs:1800000 }` |
| 旁路 | `tools/watch-login.mjs`（新增） | 与单体同一份实现、日志出口换 stdout：`node tools/watch-login.mjs`（常驻）/ `--once`（采一次）/ `--interval=60` / `--silent=10`——单体还没重启时先用它取样 |
| 边界 | —— | 全程只读：不重启协议端、不重登、不改业务面状态；采样自身失败一律 `log.warn` 出声 |

### D · 自测

| 判据 | 结果 |
|:--|:--|
| `node --check` × 4（login-watch / app.js / napcat/webui.js / tools/watch-login.mjs） | 全 0 错 |
| `node tools/watch-login.mjs --once`（真环境） | 通：`isLogin=true / loginPhase=ready / coreReady=true / ws=3001 通 / http=3000 通`；`lastRecv=10-27 21:53:40 大耳的音趴交流-主群(312080198) 十里廊`；`lastSend=21:51:50 group:312080198「50块一周有点贵，能分期吗」` |
| 收发解析口径 | 首版发送正则漏了 `[app]` 这一层前缀块 → 只解析到 0 条；改 `.*?\[发送 -> …` 后取到 20 条（含现场那 4 条 12:0x 记录） |

### E · 遗留

1. **生效需重启自研单体**（`app/src` 启动时加载）——重启后探针自动起，每 30 秒落一行。**注意：重启 = 一次协议端强杀风险，挑掉线不痛的时候做。**
2. 现在就能用：`node tools/watch-login.mjs`（旁路常驻，与单体同一实现，互不干扰）。
3. **未取到的证据面**：QQ 客户端自身日志（`nt_qq`）未定位，`kickoff` / `offline` 类事件仍读不到——探针只能看 NapCat 与业务面两侧；下一步若再掉，先看快照里「最后发送」与静默起点是否吻合。
4. 余额后缀 `set_group_card`（每 30 分钟一次写操作）仍在跑——写操作触风控的概率高于读，若再掉登录可先把它临时关掉做对照实验（记忆页「💰 余额后缀」）。

---

## 七十九、退出链不碰协议端 + 余额后缀「值未变不改写」（v0.92 · 2026-10-27）

**触发（Rushiera）：** 对 v0.91 提出的两个待定项拍板——「1，可以不用留」/「余额后缀先不管，但是定时写操作可以改成不变化不改写，暂时我们还没接余额变化接口」。

### A · 落点

| # | 面 | 文件 | 内容 |
|:--:|:--|:--|:--|
| 1 | 托盘 | `app/main.js` | 删「退出并停止协议端」菜单项；退出链只留「退出（协议端保持运行）」。理由写进注释：强杀 NapCat 进程树 = QQ 掉登录、要人工扫码（v0.91 判例）。停协议端改走显式通道（界面卡片 / `POST /api/napcat/stop`） |
| 2 | 余额 | `_unpack/resources/app/src/balance.js` | 新增 `applied: Map<gid, {key, card}>`；`syncChatCard(onebot, gid, options)`——`force` 之外命中缓存直接返回 `skipped:'unchanged'`，**不发任何 QQ 请求**（原逻辑每轮必发一次 `get_group_member_info`）；`cacheKey = 余额值 + '|' + marker` |
| 3 | 余额 | 同上 | 回填缓存两条路径：写成功之后、以及「读回与目标一致」分支 |
| 4 | 路由 | `_unpack/resources/app/src/routes.js` | `POST /api/balance/sync` 传 `force: true`——手动刷新 / 改值 / 验收不吃缓存 |
| 5 | 模板 | `tools/templates/balance.js` | 与磁盘同步（模板即源码，重装可复现） |
| 6 | 段库 | `tools/templates/balance-patches.txt` | `routes-sync` 段回灌 force 行，`--audit` 该段转 `audit-ok` |

### B · 判据

- **省掉的请求量**：定时器从「每 30 分钟 × 每群 1 次读」降为 **0**（余额值不变时）；只有「值变了 / 首轮 / 手动刷新」才发请求。这直接对应 v0.91 里「唯一持续对 QQ 的定时动作」这条嫌疑——现在它基本不再对服务器说话。
- **不动余额功能本身**：开关、marker、剥旧后缀、失败不写 0.00 等口径全部保持不变。

### C · 自测

| 判据 | 结果 |
|:--|:--|
| `node --check` ×3（balance.js / routes.js / main.js） | 全 0 错 |
| `node tools/verify-balance.mjs` | **30/30 ALL PASS** |
| `node tools/patch-qqbotb-balance.mjs --dry` | `skipped 10 · dry 1 · exist 1`（无重复写入、module 已存在） |
| `--audit` | `routes-sync` 转 `audit-ok`；仍 3 处既有漂移（见遗留 2） |

### D · 遗留

1. **生效面**：托盘菜单要重启自研单体；`balance.js` / `routes.js` 要重启业务面 QQ Agent。两者都不碰 NapCat，掉登录风险低于单体重启——但仍建议挑群里安静时做。
2. **段库 3 处既有漂移**：`config` / `ui-list-badge` / `ui-fns` 段 `--audit` 报 MISMATCH（本轮未动它们的内容，属历史状态）。后果 = 重装 `_unpack` 后这三处与当前磁盘不完全一致；修法 = 按磁盘现状回灌段库（专轮做，需逐段比对）。
3. **自动余额来源**：`source` 仍只认 `manual`；接入后 `resolveBalance()` 返回值变化即自动触发重写，缓存无需改（key 含余额值）。
