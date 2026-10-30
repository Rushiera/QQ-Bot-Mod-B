# ref-navigator-map.md — 领航员功能全景（导读索引）

> 定位：**一页看完「领航员模式现在有什么」**——能力 / 入口 / 工具 / API / 参数 / 状态 / 代码落点 / 未竟 / 文档漂移。
> 真相源分工：设计口径在 `design-qqbotb-navigator.md`（20 节，补丁式追加；**节号已被 `app/src/config.js` 注释与 `design-qqbotb_log.md` 引用 → 不重排**）；兑现明细在 `design-qqbotb_log.md`；行动项在 `todo.md` §五。
> 本文件只是导读与核对结果，不含新口径。
> 更新：2026-10-28（按当前代码核对 `app/src/config.js` · `app/src/navigator/*` · `tools/navigator/nav-tools.js`）｜2026-10-30 复核：工具 14 件（实跑 19/19）/ 单体路由 15 条 / `navigator.*` 17 键 / 会话态 10 字段逐项吻合，补 §十 端到端时序与闸门汇总；会话重建改为固定代读猫（`rescueCat`）｜2026-10-30 二次核对：`verify-navigator` 实跑 62/62、工具 14 件与 navtools 19/19 实跑吻合；修三处口径漂移（§八 抢救模式 → 代读猫 · §十三 交接报告来源 · §五 猫名示例 `rf` → `rb`）

---

## 一、一句话

QQ 群 = CH4 猫群的**外部指挥台**：群内下指令 → 投给某只猫 → 有回复就**截图 + 一句话解读**发回群；没回复就**播报「它现在在干什么」**。领航员不是新人格，是 R喵 的一种工作模式。

---

## 二、能力簇（九块）

| # | 能力 | 群里怎么说 | 工具 | 单体 API | 设计节 |
|:--:|:--|:--|:--|:--|:--|
| 1 | **开关** | 「打开领航员」/「退出领航员」（限 `569145850`）· 也可应用内「领航员」页签 | `nav_open` / `nav_close` | `/api/nav/open` · `/api/nav/close` | §三 §四 |
| 2 | **投递（派活）** | 「让 rf 看一下 X」「@R喵 帮我…」——点名猫则投该猫，未点名默认 majordomo | `nav_send` | `/api/nav/send` | §五 |
| 3 | **观测出站** | 无需开口——猫一有回复自动截图发群 | ——（常驻订阅） | `/api/nav/status` 的 `activity` | §六 |
| 4 | **只读回执** | 「各单位运行情况」「分析一下 rb 在干什么」——**不派活** | `nav_status` / `nav_health` / `nav_analyze` / `nav_detail` | `/api/nav/status` · `/health` · `/analyze` · `/detail` | §六 §十四 §十六 |
| 5 | **会话截图** | 「截一下 X 的会话」（全量 · 超高按段发 `1/N…N/N`） | `nav_shot` | `/api/nav/shot` | §六（v0.66 / v0.72） |
| 6 | **会话重建** | ①「清理一下 X 的前文，然后让工作继续」→ `nav_reset`（固定代读猫 nav_rescue 先清自己的前文 → 代读产出交接报告 → 注入）②「清掉 X 的会话，直接开新的」→ `nav_new` | `nav_reset` / `nav_new` | `/api/nav/reset` · `/api/nav/new-session` | §六b §六c §十三 |
| 7 | **场次沉淀** | 退出时自动：领航记录 `nav-log-*.md` + 一行小结写进本群群记（`kind=project`）+ 开启时置记忆回溯点 | ——（关闭路径） | 经业务面记忆 API | §十五 |
| 8 | **生成能力** | 改图「把这张图做成三视图」→ `comfy_edit`（**需领航员已开启**）· 生图「画一张…」→ `moss_draw` · 语音「念一下…」→ `tts_speak` · 反推「打标」→ `wd_tag` | 4 件 | `/api/nav/comfy` · `/moss` · `/tts` · `/tagger` | §十八 §二十 |
| 9 | **轻通道** | 领航员**没开**时，本人点名猫的指令照样投 + 回复截图（**不做投送后分析**） | `nav_send`（`by:'qq'`） | `/api/nav/send` | §十九 |

**出站决策层 `emitOutbound`（所有发群都过它）**：有新回复 → 只截最后一条回复（`replyBlocksOf`）；无新回复 + 在跑 + 冷却过 → 纯文字播报 + @ 触发者（think 摘要优先，快档模型 ≤50 字）；其余 → 静默。

---

## 三、业务面工具面（14 件 · `tools/navigator/nav-tools.js`）

| 类别 | 工具 | 性质 |
|:--|:--|:--|
| 开关 | `nav_open(by, chat)` · `nav_close(by, chat)` | 派活（置位） |
| 派活 | `nav_send(key, text, by)` · `nav_reset(key, dryRun?, text?)`（`rescue` 已退役，保留接收不报错） · `nav_new(keys)` | 派活 |
| 只读 | `nav_status()` · `nav_health(key?)` · `nav_analyze(key?, delayMs?)` · `nav_detail(key)` | **只读——不许为了看状态去 nav_send** |
| 截图 | `nav_shot(key)` | 只读 |
| 生成 | `comfy_edit(chat, prompt, file?, url?)` · `moss_draw(prompt, size?, seed?)` · `tts_speak(text, caption?)` · `wd_tag(messageId?)` | 派活（产物直发群） |

前置闸（缺一不受理且**必须出声**）：生成类 = 能力已启用 + ComfyDock 在线 + **VIP 本群 @（120 秒窗口）** + 单任务闸；改图另加**领航员已开启**。轻通道与图像编辑共用 `by:'qq'` + `vipFresh()` 同一机制。

---

## 四、自研单体 API（`app/src/navigator/index.js` · 15 条）

`GET /api/nav/status` · `/health` · `/detail` ｜ `POST /api/nav/open` · `/close` · `/send` · `/say` · `/analyze` · `/shot` · `/reset` · `/new-session` · `/comfy` · `/moss` · `/tts` · `/tagger`

依赖方向**单向**：业务面 → 单体（工具调本地 HTTP）；单体出站（截图 / 图 / 语音 / 文字）经自己的 OneBot 直发群，**不经业务面发言闸**（这正是 VIP 免墙的实现方式）。

---

## 五、配置全表（`app/src/config.js` 的 `navigator.*`，磁盘覆盖走 `app/data/config.json`）

| 键 | 默认 | 含义 |
|:--|:--|:--|
| `enabled` | `true` | 领航员功能总开关（≠ 会话态 `enabled`） |
| `mainPort` | `8080` | CH4 管理端口（主干走 `8081` 的 `Chat`） |
| `vipUser` | `569145850` | 唯一触发者 |
| `idleCloseMs` | `10800000`（3h） | 全猫 idle + 无活动超此 → 自动暂关 |
| `tourLimit` | `0`（不限） | 开场巡检最多截几只 |
| `tourKeyinfoMax` | `80` | 开场巡检 / 手动截图取会话条数上限 |
| `shotKeyinfoMax` | `0`（全量） | 群内「截一下 X 的会话」条数上限 |
| `shotSegmentHeight` | `12000` | 超过则分段截、按序发多张 |
| `shotSegmentMax` | `12` | 段数安全阀（超出只发尾部 N 段） |
| `resetTraceLimit` | `100` | 原文轨迹落盘条数（**只落盘不注入**） |
| `rescueMaxChars` | `600000` | 代读原文上限（超 → 头 30% + 尾 70%） |
| `rescueCat` | `nav_rescue` | **固定代读猫**（2026-10-30）——会话重建一律由它代读；空串 = 回落旧口径（空闲且最干净） |
| `analyzeDelayMs` | `60000` | 投递后自动会话分析延迟（0 = 关） |
| `summary.*` | `deepseek-v4.1-flash` · 20s · 1500 tok | think / 播报摘要（**必须快档**，推理模型吃光 max_tokens 会 content 恒空） |
| `services[]` | ApiSiteAnalyzer `/api/sites` · ComfyDock `/api/summary` | 开启回执健康检查清单（apisite 用量只调 `site=__all` 合并口径） |
| `comfy.*` | `gen` · 5s · 15min · `requireVip` | 改图（v0.51 纠偏：ComfyDock 探 `/api/summary`，非面板首页） |
| `media.*` | MOSS/TTS 2.5s·10min · Tagger 1.5s·3min · `translate` 快档 | 生图 / 语音 / 反推 + 自动翻译（日语人称 わたし / きみ，代码兜底 `normalizeJapanesePronouns`） |

---

## 六、会话态（`app/src/navigator/state.js` → `app/data/navigator.json`）

`enabled` · `activeChat`（**回消息群 = 最后下指令的群**，闲聊不改） · `lastCommandAt` · `lastActivityAt` · `lastTarget` · `openedAt` / `openedBy` · `closedAt` / `closedReason` · `commandLog`（保留 50 条，跨群「刚刚让你干什么了」的载体）。

---

## 七、代码落点

| 面 | 文件 |
|:--|:--|
| 状态机 | `app/src/navigator/state.js` |
| 主流程（投递 / 观测 / 出站决策 / 截图调度 / 重建 / 轻通道） | `navigator/index.js` |
| CH4 猫面（command / snapshot / keyinfo / stream / cat-detail） | `navigator/ch4.js` |
| 观测订阅与轮结束判据 | `navigator/watch.js` |
| 截图渲染（CH4 会话卡同源样式） | `navigator/shot.js` · `md.js` · `chat-card.css` · `fonts/` |
| 改图 | `navigator/comfy.js` |
| 生图 / 语音 / 反推 / 翻译 / 人称归一 | `navigator/media.js` |
| 业务面工具 | `tools/navigator/nav-tools.js` |
| 业务面补丁（VIP 免闸 / 教材） | `tools/patch-qqagent-navigator.mjs` · `apply-qqagent-config.mjs`（`NAV_QUICK`） |
| 领航员完整教材（按需文件） | `role/nav-rules.md`（B23 后 roleText 只留路由索引，模型用 `read_file` 取件） |
| 界面 | `app/ui/`（「领航员」页签 + 活动流 40 条） |
| 自测 | `tools/verify-navigator.mjs`（62/62）· `verify-qqagent-navtools.mjs`（19/19）· `verify-comfy.mjs` · `verify-media.mjs` |

---

## 八、未竟（`todo.md` §五 / §二十）

| # | 项 |
|:--:|:--|
| N6 | 指令判断器与话术收进自研单体（终态，§十二 迁移原则）——待排期 |
| N7 | `nav_resume` 断点续跑（摘要已产出而流程中止时跳过收工）——**当前不做**，留记 |
| N8 | 重启自研单体使 apisite 口径终版生效（现跑中间版，带「· 当前在用」后缀） |

---

## 九、文档口径漂移（2026-10-28 核对 · 已回灌设计文档）

> 回灌只改文字，**不动节号**（§号被 `app/src/config.js` 注释与 `design-qqbotb_log.md` 引用）。

| # | 原漂移 | 处置 |
|:--:|:--|:--|
| 1 | **§九 开场巡检写「取前 `navigator.tourLimit` 只，默认 3」**——与 §六「`tourLimit=0` 不限」及 `config.js`（`0`）矛盾 | ✔ 已改为「默认 **0 = 不限**，与 §六 同一口径」并标注 2026-10-16 起全量 |
| 2 | **§六 写「开场各发 `keyinfo?max=20`」** | ✔ 已改为 `navigator.tourKeyinfoMax`（默认 80）；§九 该处同步 |
| 3 | **§八 教学面仍以 `persona.roleText` 的 `NAV_RULES` 为教材来源** | ✔ 已补：B23（v0.76）后 roleText 只留路由索引 + `NAV_QUICK`，完整教材在按需文件 `role/nav-rules.md`（`read_file` 取件） |
| 4 | **§十一 验收判据 14 条停在 v0.64 口径** | ✔ 已补 15–18 四条：分段截全 / 轻通道 / 生成能力 / 日语人称口径 |
| 5 | §六b「交接摘要」措辞 | ✔ 核对：§六b 已无残留（v0.70 统一为「**交接报告**」）；「交接摘要」只剩 `design-qqbotb_log.md` / `CHANGELOG.md` 的历史记录与 §六c 判例里对当时群内原话的引用——**属历史事实，不动** |

---

## 十、一次派活的端到端时序（2026-10-30 核对，代码逐项吻合）

```
群消息 @bot
  └→ ① 业务面 R喵 判断（LLM，非正则）：指令 / 闲聊 / 生成类请求
       ├ 闲聊 → 走 engage 原路径，与领航员无关
       ├ 生成类 → comfy_edit / moss_draw / tts_speak / wd_tag（§二-8）
       └ 指令   → ② nav_send(key, text, by='qq')
                    └→ 单体 POST /api/nav/send
                         ├ 目标猫：点名者 / 未点名默认 majordomo
                         ├ 通道：majordomo → 8081 `Chat `；其余 → 8080 `cat.chat`
                         ├ 原文照抄，不加来源头（`sourceTag` 默认 false）
                         └ 登记持久观测（SSE `sessionstate` 为主判据 + 5s `keyinfo` 兜底）
                              └→ ③ 猫跑完（run→idle）→ `keyinfo?max=12` 取回复
                                   → 渲染截图（CH4 会话卡同源）
                                   → 视觉解读一段 → 图片 + 文本两条发 `activeChat`
       └ 无新回复但在跑 → `emitOutbound` 冷却过后纯文字播报 + @ 触发者（think 摘要 ≤50 字）
④ 投递后 `analyzeDelayMs`（60s）自动跑一次猫会话分析 —— 静默反馈替代
⑤ 关闭时场次沉淀：`nav-log-*.md` + 一行小结进本群群记（`kind=project`）
```

**闸门汇总（缺一出声拒绝，不静默）：**

| 动作 | 前置 |
|:--|:--|
| 开 / 关 | 仅 `569145850`（群内）或应用内「领航员」页签 |
| 投递（常规） | 领航员已开启 |
| 投递（轻通道） | 未开启时：`by='qq'` + `vipFresh()`（VIP 群 @ 120 秒窗口）+ 点名了猫——否则回 `offMode` |
| 改图 | 能力启用 + ComfyDock 在线 + VIP 窗口 + 单任务闸 + **领航员已开启** |
| 生图 / 语音 / 反推 | 能力启用 + ComfyDock 在线 + VIP 窗口 + 单任务闸（**不要求领航员开启**） |
| 出站（截图 / 图 / 语音 / 播报） | 无闸——单体 OneBot 直发，不经业务面发言配额 / 硬限 / 节拍 |
