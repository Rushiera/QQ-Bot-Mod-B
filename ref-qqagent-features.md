# ref-qqagent-features — 功能清单与实现落点（QQ Agent v0.4.0）

> 类型：外部参考料（非本项目设计）| 创建：2026-10-09 | 来源：`QQ-Agent V0.4 Preview Bugfix Setup.exe` → `_unpack/resources/app/src/`
> 定位：**按功能编号索引实现方法**——指认某功能后，从本表直达上游源码落点与关键机制，供移植时精读。
> 上游：`Kondius/qq-agent` v0.4.0 · MIT · 由 `Derpyu520/qq-bridge` 改造。
> 关联：`ref-qqagent.md`（模块地图 · 先读它看骨架）· `project.md`（本项目定位）· `design-qqbotb.md`（边界）

---

## 使用说明

| 要找什么 | 怎么找 |
|:--|:--|
| 某功能怎么实现的 | 按编号定位本表 → 取「实现落点」→ 到 `_unpack/resources/app/src/<文件>:<行>` 精读 |
| 某机制的设计理由 | 看 §关键机制六条 + 源码文件头的注释块（作者大量写了"为什么"） |
| 某参数默认值 | 看 §配置速查（摘自 `config.js` `DEFAULT_CONFIG`） |
| 骨架与模块分工 | 回 `ref-qqagent.md` §三 模块职责表 |

**编号规则**：`<组字母><序号>`——A 协议底座 / B 出站 / C 入站 / D 编排 / E 提示词 / F 记忆 / G 工具 / H 媒体 / I 模型成本 / J 安全 / K 控制台 / L 扩展 / M 桌面壳。
**代价列**：低（单模块内可移植）· 中（需新面或跨模块）· 高（整套子系统）。
**CH4 现状列**：标 ✅已有 / 部分 / 无 / **不适用**（架构不同，不做）。

---

## A. 协议与运行底座

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| A1 | OneBot v11 客户端 | WS 只收事件 / HTTP 发 API | 中 | `onebot.js` L1-402——`#connect` 重连退避 3s→30s（L143 注释）；`call()` L269-308 **超时按 action 分档**（发送类 `SLOW_ACTION` 60s / 查询类 15s，L270-276 判据：1.9MB 图稳定超时才改的）；`sendSegments/sendText/sendSticker/sendImage/sendPoke` L319-389；`#replyAtSegments` L336-349 统一 reply/at 校验（消息 id 可负、at 禁 all） | 无 |
| A2 | 协议端托管 | 拉起/停止 SnowLuma、状态与日志、地址可改 | 低 | `routes.js` L242-319（`/api/snowluma/*` 启停/状态/日志）+ `config.js` L165-174（`snowluma.dir/autoLaunch/wsUrl/httpUrl/accessToken/httpAccessToken`） | 无 |
| A3 | 账号槽位 | 账号 + 协议端地址 + 登录态 + 绑定群号解耦 | 低 | `config.js` L165-174（协议端地址即槽位本体）+ L201-203（`allow.groups/private` 白名单） | 无 |
| A4 | 多实例隔离 | profile id → 数据目录 + 端口整体偏移 | 低 | `profile.js`（只认数字）+ `config.js` L24（`data${profileSuffix()}`）· L170-171（WS 3001+offset / HTTP 3000+offset）· L371（server 端口 3210+offset） | ✅已有（猫级隔离） |
| A5 | 便携 QQ 装机 | 免安装包下载/校验/解压、从已装 QQ 复制、版本对齐 | 高 | `README.md`「安装与使用」段——`npm run setup` / `pack:qq` / `--from` / `--no-portable`；版本对齐改 `snowluma/index.mjs` 的 `CLIENT_BUILD` | 无 · **与路线 A 冲突** |

## B. 出站发送面（价值密集区）

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| B1 | 发送队列串行化 | 每会话一条链，不出并发错序 | 低 | `sender.js` L43 起 `SendQueue`——`createSendChain`（`util.js`）逐会话排队 | 部分（逐段发送，无会话链） |
| B2 | 真人化间隔 | 随机 1~3s + 按字数 20ms/字 | 低 | `config.js` L214-216（`minGapMs/maxGapMs/byLengthMs`）→ `sender.js` 发前 sleep | 无 |
| B3 | 双限频 | 80/分钟 · 500/小时，超限拒绝并把错误回给模型 | 低 | `config.js` L217-218；`sender.js` L11-13（回退值统一取 `DEFAULT_CONFIG`，杜绝三处打架） | 无 |
| B4 | 去重窗口 | 8s 内同会话完全同文本只发一次 | 低 | `config.js` L220-223（`dedupeWindowMs: 8000`）——防模型重复调用 / OneBot 超时假失败后上层重试 | 无 |
| B5 | 硬切分 + CQ 转义 | 4000 字硬切 + CQ 码转义 | 低 | `config.js` L219（`hardSplitAt`）；`md-to-plain.js` `splitForQQ` + `escapeCqText`（`onebot.js` L353 调用） | ✅已有 `QqTextSplitter`（MD 结构感知 1800 段，更强） |
| B6 | Markdown → QQ 纯文本 | 去围栏/粗体/标题/表格等 | 低 | `md-to-plain.js` L3-25 全函数（`mdToPlain` + `splitForQQ`） | ✅已有（走 MD 通道，不需转纯文本） |
| B7 | 本地路径 → `file:///` | 裸 Windows 路径各协议端支持不一致，统一转规范 URI | 低 | `sender.js` L23-41 `toFileUri`——**刻意零反斜杠写法**（`String.fromCharCode(92)` + split/join），起因是多层转义把 `\/` 吃成 `/` 造成加载即崩；`encodeURI` 不处理 `#?` 需手动转 | 无 · **B 侧发图必需** |
| B8 | 发出即记档 | 每条发出自记 `self=true`，供下轮当"自己的发言" | 低 | `sender.js` L5 注释 + 写回 `store.js` | 部分（视图层留档） |

## C. 入站解析

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| C1 | 消息段 → 文本 | text/at/face/image/record/video/file/reply/forward | 中 | `onebot.js` L422-500 `segmentsToText(segments, {resolveReply, resolveAtName, includeReply, onebot, onAt})`——@ 段收集器 `onAt` 给档位判定用（L418 判据：文本匹配无法区分同名不同人） | 无段体系（模式 A 有附件下载 + face 标记归一化） |
| C2 | 引用原文解析 | `[引用 某人：原文]` 回填 | 中 | `onebot.js` L458-475——`resolveReply(mid)`，引用者名带 `(QQ:xxx)`（与发言人标签同口径，解析不到不编造） | 无 |
| C3 | @ → 群名片 | QQ 号转名字，补 `(QQ:xxx)` 区分同名 | 低 | `onebot.js` L434-441——`resolveAtName` + `normalizeInlineAt`（走 `message.inline-at-normalize` 能力位） | 无 |
| C4 | 语音转文字 | `media.transcribe` 能力位，无插件保 `[语音]` 占位 | 高 | `onebot.js` L448-455 `transcribeVoice`——只在主消息路径转（转发链逐条跑 whisper 会串行阻塞 ingest） | 无 |
| C5 | 转发消息展开 | `forward` 段展开成多条 | 中 | `onebot.js` `forwardIdFromData` L406-410（取 `id/res_id/forward_id/data_id`）+ `tools.js` L501「展开转发消息」 | 无 |

## D. 编排与触发（qq-agent 的灵魂 · 与 CH4 冲突最大）

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| D1 | 无状态会话 | 防抖聚批 → 新开会话 → 已读标记 → 用完即弃 → 未读续跑 | 中 | `orchestrator.js` L1-10 头注释即流程；`#runAgent` 主体约 L732 起（约 1800 行文件）；`wakeDelayMs=2000` / `drainDelayMs=1200` / `maxConcurrentRuns=2`（`config.js` L205-207） | **不适用**（CH4 持久会话 + 前文，成本模型不同） |
| D2 | 响应档位滑条 0~100 | 1 档仅@ / 2 档+关键词 / 3 档概率 / 4 档全响应；不命中直接标已读零 token | 中 | `tier-slider.js` **零依赖模块**（L1-7 注释：放 config 或 prompt 任一处都会 config→prompt→config 循环依赖）；分界 `0-10 / 10-20 / 20-90 / 90-100`；3 档概率 `prob=(pos-20)/70*100`；判定 `prompt.js` `resolveContextTier` | 无 · **省 token 核心** |
| D3 | 峰谷分时 + 分群档位 | 按时段/按群给不同滑条位置 | 中 | `config.js` L287-299 `peakSchedule`（`peak.start/end/sliderPos` + `valley.sliderPos`；**只认 sliderPos**，peak 窗口外一律 = 低谷，L295-297 判据）+ `unifiedTier` / `groupSliderPos` / `groupPeakPos` L280-285 | 无 |
| D4 | 活跃模式 chatActive | 被召唤后话题值得继续 → 进活跃期忽略档位必响应，模型自判退出 + TTL 兜底 | 中 | `orchestrator.js` L54-60 状态设计（`activeTopics: chatKey → {topic, until}`）；`config.js` L237-240（`enabled` / `ttlMinutes: 30`）——让"开始活跃"容易、"停下"由模型自判，恰是档位系统的反向补充 | 无 |
| D5 | 主动开话题 | 冷场检测 + 概率触发 | 低 | `config.js` L226-232 `proactive`（`checkIntervalMin/MaxMs` 30~90min · `idleThresholdMs` 30min · `probability: 0.25`） | 部分（`sleep` 唤醒，无冷场检测） |
| D6 | 指令禁言 `/安静` | 群内 @机器人 发指令 → 档位锁 1 档 N 分钟 | 低 | `config.js` L316-322（`enabled/command/durationMin/active` 运行态按群记到期时间戳） | 无 |
| D7 | 消息存档 store | 每会话 JSON，带时间戳与已读标记，未读驱动续跑 | 中 | `store.js` L1-16 条目格式（`id/mid/ts/senderId/senderName/text/self/read/reply/media`）；`config.js` L259（`maxMessagesPerChat: 0`=不限，原 2000 已按用户要求取消） | **不适用**（CH4 视图层即存档） |
| D8 | 并发限流 + 会话重试 | 全局并发上限；零发出才自动重试 | 低 | `config.js` L207（`maxConcurrentRuns: 2`）· L211（`sessionRetryAttempts: 2`；⚠️ **已发出过消息的会话绝不自动重试**，否则群里看到两遍） | 部分（CH4 有会话调度） |
| D9 | 屏蔽名单四层 | 按群 / 全局 / 云端共享 / 本机豁免，入口丢弃不存档不触发 | 低 | `config.js` L301-313（`blocklist` 按群 · `globalBlocklist` 全局含私聊 · `communityExemptions` 本机豁免——云端 5 分钟同步会整体覆盖 globalBlocklist 但不碰这里） | 无 |
| D10 | 活跃成员统计 | 查看活跃成员 | 低 | `tools.js` L535「查看活跃成员」 | 无 |
| D11 | 未读兜底定时器 | 1~3 档未触发的散消息，冷却后标已读（防存档页长期挂假未读） | 低 | `orchestrator.js` L41-44（`unreadFallbackTimers`；有会话触发/有新消息时一律取消） | 无 |
| D12 | 回复抢救 reply-rescue | 把"写在正文却没经工具发出"的成稿抢救成 `send_message` | 中 | `reply-rescue.js` L1-25 头注释——三级递进（①正则否决计划腔 ②正则级抽取不花模型调用 ③模型当裁判判"成品话 vs 内心戏"）；硬约束：只搬原句 / 拿不准一律沉默 / 不自己发送（走统一链路，不另开旁路） | 无 |

## E. 提示词与人设

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| E1 | 系统提示七段 | 安全规则 / 工具协议 / 反 AI 味 / 主体性 / 群聊非队列 / 引用@纪律 / 记忆规则 | 中 | `prompt.js` L24-132 逐段函数：`securityRules` L24 · `toolProtocol` L35 · `antiAiFlavor` L49 · `subjectivity` L60 · `notAQueue` L85 · `quoteAndAt` L115 · `memoryRules` L125（另有 `speakOrNot` L71 · `humanRhythm` L95 · `notModerator` L106 · `stickerRules` L134） | 无 · **群友感来源，移植价值最高** |
| E2 | 用户消息结构 | 时间/角色/已读/记忆/未读/表情/引导，零对话历史 | 中 | `prompt.js` 头注释 L4-8 + `buildUserPrompt` | **不适用** |
| E3 | 前缀缓存锚点 | 复用上轮【记忆+已读】前缀字节不变，吃提示词缓存 | 中 | `orchestrator.js` `promptAnchors` + `config.js` L275-278（`promptAnchor.enabled/maxExtraRead: 5`）；铁律：**动态段必须追加到系统提示末尾**（插中间会把后面规则字节推来推去，缓存前缀归零，见 `prompt.js` 注释） | **不适用** |
| E4 | 人设库 + 分会话人设 | 内置角色卡模板、按群独立覆盖、参与度档位 | 低 | `personas.js` L4 起（`PERSONAS.xiaojingyu.text` 完整角色卡，L7-60+ 可见"去 AI 味"铁律全文）；`config.js` L176-199（`persona.*` + `customPersonas` + `personaByChat` + `personaUnified`） | 部分（Worker persona，无分群维度） |
| E5 | 系统提示覆盖开关 | 高级用户整体替换行为准则（安全规则强制追加最后） | 低 | `config.js` L182-186（`systemPromptOverride`，占位符 `{botName}{roleText}{participation}`） | 无 |

## F. 记忆

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| F1 | 群友印象记忆 | 每群每人一份 JSON（风格/梗/雷点等稳定信息） | 中 | `memory.js` L1-35——目录 `data/memory/<chat>/<QQ>.json`；成员文件 `{userId, name, impressions:[{content,createdAt}], updatedAt, lastConsolidatedAt}`；旧版单文件自动迁移 L6/L17-19 | 无 |
| F2 | 记忆自动整理 | 条数超阈 + 冷却 6h → 后台合并去重删过时（可指定专用模型） | 中 | `config.js` L324-330（`consolidateEnabled` / `consolidateMinIntervalMs: 6h` / `useChatModel` / `provider` / `model`）；`orchestrator.js` L48 `consolidating` 按 chatKey 去重 | 无 |
| F3 | 记忆三工具 | 记录 / 查询 / 删除印象 | 低 | `tools.js` L650「记录印象」· L679「查询印象」· L701「删除印象」 | 无 |

## G. 工具 28 件（按类整类取舍）

> 定义与实现全在 `tools.js`；注册表 `tool-registry.js`（新增只需 `registerTool()`）。
> 🔴 **工具名已去 `qq_` 前缀**（省 token）。工具定义**天然绑定本次运行的会话**——没有 key/token 参数，模型物理上发不到别的群（安全性靠架构而非校验）。

| # | 类 | 工具 | 代价 | 实现落点（行号 = `tools.js`） | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| G1 | 发言 | 发送消息 · 发送到指定会话 · 发送表情 · 拍一拍 · 结束会话 | 低 | L161 · L195 · L258 · L438 · L804 | 部分（发送 + 文件标记已有；拍一拍无） |
| G2 | 表情库 | 查看表情库 · 查看表情图片 · 备注表情 · 收藏表情 | 中 | L315 · L338 · L367 · L394 | 无 |
| G3 | 读档 | 查看历史消息 · 展开转发消息 · 查看活跃成员 · 查看可用会话 · 查看消息详情 · 查看消息图片 | 中 | L470 · L501 · L535 · L558 · L585 · L610 | 无 |
| G4 | 记忆 | 同 F3 | 低 | L650 · L679 · L701 | 无 |
| G5 | 联网 | 联网搜索 · 抓取网页 | 低 | L749 · L774（`web-search.js` L1-16：Bing 中文解析免 Key；L4-7 判据——搜索 URL 是管理端配置的可信地址属"管理员自伤面"，维持普通 fetch；真正的远程输入 `sanitizeQuery` 清洗） | 部分（`web-search` 有但 API 未配置；抓取网页无） |
| G6 | 提醒 | 设置提醒 · 查看提醒 · 取消提醒 · 查询节日 | 低 | L829 · L865 · L885 · L906（`reminders.js` L1-16：`data/reminders.json`，重启不丢；`holidays.js` L1-16：公历固定 + 农历近似表，不联网） | 部分（`sleep` 无持久化；无节假日） |
| G7 | 网图 | 发送网图 · 搜索网图 | 中 | L946 · L1069 | 无 |
| G8 | 媒体 | 读取视频 | 高 | L1118（`video-reader.js` 元信息探测 + 抽帧） | 无 |
| G9 | 反馈 | 反馈问题（上报作者） | 低 | L727 | 无 · **与本项目无关** |

## H. 媒体处理

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| H1 | 表情包体系 | QQ 收藏为源 + 本地库为 AI 认知层 + 自动采集(10/h) + 提示词摘要 | 高 | `stickers.js` L1-40（本地库条目结构：id/resId/emojiId/qqFile/localFile/persistFailed/url/md5/desc/tags/usage/source/useCount/lastUsedAt）+ `sticker-manager.js`；`config.js` L242-251（`enabled/promptMaxStickers/collectEnabled/maxCollectPerHour/encourage 0~3`） | 无 |
| H2 | 图片压缩 / 类型嗅探 | 降到模型可接受尺寸省 token | 中 | `image-compress.js` · `image-type.js`（**唯一实现**，无第三方依赖） | 无 |
| H3 | 视频读取 | 元信息探测 + ffmpeg 抽帧喂模型 | 高 | `video-reader.js`；`config.js` L47-62（`videoMode: auto/native/frames/off`；默认 `video:false`——猜错"模型支持视频"的代价是 400，比不启用更糟） | 无 |
| H4 | GIF → mp4 | 动图转模型可读（≤480px / ≤24 帧） | 中 | `gif-to-video.js` | 无 |
| H5 | 链接媒体转发 | 消息里的链接确定性转媒体 | 中 | `media-links.js` L1-16——核心只做调度不认识平台：①粗提取候选链接 ②喂给 `media.download` 能力的所有提供者 ③谁认领谁处理；新增平台 = 新插件提供能力，核心零改动；`MAX_MEDIA_LINKS_PER_MESSAGE=3` 防刷屏 | 无 |
| H6 | 视觉能力实测扫描 | 逐模型发 1×1 测试图探测网关接不接受 `image_url` | 中 | `vision-scan.js` + 内置资料表 `model-vision-docs.js` | 无 |

## I. 模型与成本

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| I1 | 多提供商模型目录 | 填 Base URL+Key → 拉列表 → 点选切换 + 一键测试延迟 | 中 | `providers.js`（`currentProviders/upsertProvider/testOneProvider/fetchModelsFrom` 等）+ `routes.js` L384-596（`/api/providers/*` 与 `/api/providers/{id}/models` 增删） | 部分（端点池在人工面板，非工具面） |
| I2 | 备选模型重试链 | 主模型失败逐个回落 | 低 | `config.js` L36-39（`fallbackModels: [{model, provider?}]`；provider 留空沿用主模型凭据，填了切到该提供商） | 无 |
| I3 | 视觉/视频模型分离 | 按输入类型选模型省成本 | 低 | `config.js` L45-46（`visionModel/videoModel`；⚠️ L42-44 注释：这两个字段曾只是存下来给 UI 看、无代码读取，现已真生效——`llm.js` 检测到图片/视频部分时替换主模型） | 无 |
| I4 | 思考参数方言适配 | effort 六档映射到各厂商参数 | 低 | `thinking.js`（原 thinking-adapters 插件收编进核心）；`config.js` L66-77（`thinkingMode/thinkingEffort/thinkingBudget`） | 无 |
| I5 | 成本核算 | 内置 140 模型官方价 + 远程 feed + 自定义 + 缓存单价 | 高 | `model-prices.js`（约 140 模型）· `price-feed.js`（`FIXED_PRICE_REMOTE_URL` 见 `config.js` L23）· `config.js` L78-89（`priceInputPerM/priceOutputPerM/priceCachedPerM/useOfficialPrice/modelPrices` 按 id 覆盖） | 无 |
| I6 | 用量统计三维度 | 按天 / 按会话 / 按模型 + 缓存命中率 + 工具调用次数 | 高 | `routes.js` L192-220（`/api/usage/*` 日/会话/模型）+ `llm.js` `addUsage/estimateCost/cacheHitRate`；`sessions.js` L1-20 留档（索引缓存 `session-index-cache.json`：2277 文件 25s → 3ms） | 无 |
| I7 | 遥测上报 | 匿名周期上报调用次数与 token | 低 | `telemetry.js` | 无 · **建议不做** |

## J. 安全边界

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| J1 | 工具绑定会话 | 工具定义无群号参数，模型物理上发不到别的群 | 低 | `tools.js` 全局设计（见 `ref-qqagent.md` §四注）——架构级安全，非校验级 | **不适用**（CH4 工具面本就每猫） |
| J2 | SSRF 防护 | DNS 校验 / IP 固定 / 手动跟重定向 / 图片禁内网 | 中 | `safe-fetch.js` L1-30 头注释即完整清单——仅 http(s)、禁内嵌凭据、禁 localhost/私有 IP/环回/链路本地/CGNAT、域名先 DNS 解析查**全部**结果、解析后**固定到已校验 IP**（防 DNS rebinding）、重定向每跳重校验、响应体限量、大文件边收边写盘；例外 `security.allowPrivateImageHosts`（`config.js` L153） | 部分（有概念无实现） |
| J3 | 浏览锁定白名单 | 域名白名单逐跳校验（含重定向目标） | 低 | `config.js` L156-163（`security.browseLock.enabled/hosts/siteSearchUrl`） | 无 |
| J4 | 安全规则不可被覆盖 | 扩展提示词强制压在核心规则之下 | 低 | `prompt.js` L24-33 `securityRules` 独立于 `systemPromptOverride`；`README.md` 扩展段「不可能覆盖安全规则」 | 无 |
| J5 | 配置文件损坏保护 | 解析失败先备份 `.corrupt-<时间戳>` 再回落默认 | 低 | `config.js` L413-432——🩸 **血泪判例**：曾经直接回落 DEFAULT，随后任何 `updateConfig`（如 5 分钟一次的云端屏蔽名单同步）都会以默认配置为底整体写回，用户的 Key/白名单/人设被静默抹成出厂值 | 无 |

## K. 控制台 UI

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| K1 | 八页签控制台 | 会话 / 存档 / 记忆 / 用量 / 技能 / 插件 / 协议端 / 设置 | 高 | `ui/index.html` L73-80（`data-tab` 八页签）+ `ui/app/00-core.js`…`12-concept2-ui.js` 十二个零框架原生模块；另有 `persona-plaza/` `plugin-market/` `skill-market/` 三个市场页 | ✅已有（CH4 前端面板是对等物） |
| K2 | 就绪度体检卡 | 顶部告诉用户还缺什么（Key / 模型 / 白名单） | 低 | `ui/app/11-init.js` + `README.md`「配置」段 | 无 |
| K3 | 白名单从 QQ 勾选 | 拉群列表/好友列表直接勾，不用查群号 | 中 | `routes.js` L320-347（`/api/onebot/*` 取群/好友列表） | 无 |
| K4 | SSE 实时 + 日志 + 主题 | 会话运行实时刷新、内存环形日志、明暗主题 | 中 | `logger.js`（分级 + 落盘 + 内存环形缓冲）；`config.js` L376-382（`ui.theme` dark/light/system · `showVision` · `refreshMs: 15000`）；`ui/style.css` 设计 token | ✅已有（SSE + 主题） |

## L. 扩展系统

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| L1 | 插件型（确定性） | `plugins/<id>/`——hooks + capabilities，核心代码条件必执行，不经 LLM | 高 | `plugin-loader.js` 扫描 `plugins/` 与 `skills/`；`README.md` 扩展段（判据：**规则能写死 → 插件；要理解人话 → Skill**；选错类型的后果是**功能静默失效**——不报错不崩就是没反应） | 无（CH4 是 C# 积木/语料体系） |
| L2 | Skill 型（LLM） | `skills/<id>/`——`registerTool` + 提示词片段，模型自判 | 高 | `skills/` 六件：`manager.js`（核心与扩展唯一交互口）· `registry.js` · `capabilities.js` · `manifest.js` · `config.js` · `errors.js` | ✅已有等价物（Job / 工具组热重载） |
| L3 | 统一开关 + 三层状态 | loaded / enabled / available，UI 直接说为什么没生效 | 中 | `config.js` L357-360（`skills[id].enabled` 唯一开关来源；关掉则工具/能力/提示词片段/请求改写**同时**失效）+ L331-356（`tools.enabled/overrides/categories`，判定顺序：全局 → skill → requires 能力 → 分类 → 单工具 → 运行期依赖） | 无 |
| L4 | 社区市场 | 发布 / 口令安装 / 云端共享屏蔽名单 / 金句上传 | 高 | `market.js` · `community.js` · `zip-install.js`；`routes.js` L794-902（`/api/market/*`） | 无 · **建议不做** |
| L5 | 热重载 | 目录放进去即生效，无需重启 | 低 | `config.js` L361-366（`extensions.hotReload` 默认开；⚠️ 等价"任意落地的 JS 会被执行"，共享机器建议关） | ✅已有（host-reload） |
| L6 | 按能力依赖不按名字 | 核心问"谁提供 `llm.request-params`"，不 import 具体扩展 | 中 | `skills/capabilities.js`；例：`normalizeInlineAt` 走 `message.inline-at-normalize`、`transcribeVoice` 走 `media.transcribe`、`media-links` 走 `media.download`——新增实现核心零改动 | 部分（CH4 有接口注入） |

## M. 桌面壳与分发

| # | 功能 | 一句话 | 代价 | 实现落点 | CH4 |
|:--:|:--|:--|:--:|:--|:--|
| M1 | Electron 托盘常驻 + 自启 + 关窗不退 | — | — | `electron/main.js` + `config.js` L367-375（`server.autoStart` / `closeToTray`） | ✅已有（CH4 A118 WinExe 托盘外壳） |
| M2 | 单实例锁 | — | — | `instance-lock.js` | ✅已有 |
| M3 | 版本更新检查 | — | 低 | `routes.js` L1105-1131（`/api/version` + `/api/update`，`UPDATE_INFO_URL` + semver 比较） | ✅已有（`majordomo-restart` 自更新链） |
| M4 | 脱敏脚本 | 分享前清空 Key / 白名单 / 存档 / 登录态 | 低 | `README.md`「分发前脱敏」段（`node scripts/sanitize-release.mjs --dry-run`） | 无 |
| M5 | 多运行形态 | Electron / headless(`node src/server.js`) / CLI | — | `server.js`（headless 起 HTTP 3210，不开窗口） | ✅已有（三面同源） |

---

## 配置速查（`config.js` `DEFAULT_CONFIG` 摘）

| 组 | 关键默认值 | 行号 |
|:--:|:--|:--|
| 协议端 | `wsUrl ws://127.0.0.1:3001` · `httpUrl http://127.0.0.1:3000` · `accessToken` / `httpAccessToken` | L165-174 |
| 运行节奏 | `wakeDelayMs 2000` · `drainDelayMs 1200` · `maxConcurrentRuns 2` · `sessionRetryAttempts 2` | L205-211 |
| 发送保护 | `minGapMs 1000` · `maxGapMs 3000` · `byLengthMs 20` · `maxPerMinute 80` · `maxPerHour 500` · `hardSplitAt 4000` · `dedupeWindowMs 8000` | L213-224 |
| 档位 | `contextTier 4` · `historyCount 80` · `randomPercent 10` · `promptAnchor{maxExtraRead 5}` · `unifiedTier true` · `peakSchedule.enabled false` | L265-299 |
| 屏蔽 | `blocklist{}` · `globalBlocklist[]` · `communityExemptions[]` · `commandMute{/安静, 30min}` | L301-322 |
| 记忆 | `consolidateEnabled true` · `consolidateMinIntervalMs 6h` · `useChatModel true` | L324-330 |
| 模型 | `temperature 0.8` · `maxRounds 12` · `timeoutMs 180000` · `vision true` · `video false` · `videoMode auto` | L63-77 |
| 表情 | `enabled true` · `promptMaxStickers 10` · `collectEnabled true` · `maxCollectPerHour 10` · `encourage 1` | L242-251 |

---

## 取舍建议（2026-10-09 呈报版 · 等 Rushiera 勾）

**天生不做（CH4 已有对等物，做了是双写面）：** D1 · D7 · E2 · E3 · J1 · K1 · K4 · L2 · M1 · M2 · M5

**模式 B 通道必做（缺了跑不通群聊）：** A1 · A2 · A3 · B7 · C1

**低成本高收益（群友感与省 token 的来源）：** B1 · B2 · B3 · B4 · D2 · D6 · D9 · E1 · F1 · F3 · G1 · G5

**中成本按需：** C2 · C3 · D4 · D5 · E4 · F2 · G2 · G3 · G6 · H2 · I2 · I3 · J2 · J5

**高成本、需明确点头才动：** D3 · H1 · H3 · H5 · I5 · I6 · K3 · L1 · L3

**建议直接否掉：** A5（与注入路线冲突）· C4 · G7 · G8 · G9 · I7 · L4

---

## 后续入口

| 指认方向 | 深入落点 |
|:--:|:--|
| OneBot 接入细节 | `src/onebot.js`（连接 / 事件解析 / 发送动作全集） |
| 发送纪律 | `src/sender.js`（限频 / 切分 / 转义 / `toFileUri`） |
| 提示词工程 | `src/prompt.js`（系统提示全段 / 用户消息结构 / 档位判定） |
| 无状态编排 | `src/orchestrator.js`（约 1800 行，主流程在 `#runAgent` L732 起） |
| 工具设计 | `src/tools.js`（28 工具定义格式与实现，行号见 §G） |
| 扩展系统 | `src/plugin-loader.js` + `src/skills/*`（六件） |
| 安全抓取 | `src/safe-fetch.js`（SSRF 完整实现） |
| 配置全景 | `src/config.js`（`DEFAULT_CONFIG` L27-383，每项带设计理由注释） |

> 解包产物 `_unpack/`（386MB）与工具 `tools/` 均为可弃物——本文件已把实现落点抽干，后续可直接清理。
