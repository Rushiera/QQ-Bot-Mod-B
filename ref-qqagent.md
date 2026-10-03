# ref-qqagent — 外部参考拆解（QQ Agent v0.4.0）

> 类型：外部参考料（非本项目设计）| 创建：2026-10-03 | 来源：`QQ-Agent V0.4 Preview Bugfix Setup.exe`（107MB）
> 定位：把外部项目 qq-agent 的结构与机制拆成可检索的地图，供后续「指认功能 → 提取实现 → 移植进本项目」时定位。
> 上游：`Kondius/qq-agent` v0.4.0 · MIT · 由 `Derpyu520/qq-bridge` 改造而来。
> 关联：`project.md`（本项目定位）· `design-qqbotb.md` §四（连接层设计约束）

---

## 一、拆包事实（可复现）

| 项 | 实况 |
|:--|:--|
| 安装包类型 | **NSIS**（内嵌 LZMA2 数据块——`7-Zip` 直接按 7z 解出，非 NSIS 脚本层） |
| 解包工具 | `7zip-bin` 的 `7za.exe`（npm 装到 `tools/`，项目内，未动系统） |
| 命令 | `7za x "<安装包>" -o"<目标>" -y` |
| 产物 | 364 文件 / 386MB → `_unpack/` |
| 关键结论 | **源码完整未混淆**（`resources/app/src/` 44 个根模块 + `skills/` 子目录 6 件 + `ui/` + `node_modules` 已打包）——可直接阅读、可直接跑 |

**目录骨架：**

```
_unpack/
├── QQ Agent.exe              Electron 主程序
├── *.dll / *.pak / locales/  Electron 运行时
└── resources/app/            ← 应用本体
    ├── package.json          名称 qq-agent / v0.4.0 / type=module / main=electron/main.js
    ├── electron/             main.js（托盘壳）· preload.cjs
    ├── src/                  后端 40 模块（纯 ESM，依赖仅 js-yaml / undici / ws）
    ├── ui/                   零框架原生控制台（index.html + app/*.js + 三个市场页）
    ├── snowluma/             协议端（第三方，独立 EULA）——OneBot v11 实现
    ├── node_modules/         依赖已打包
    └── 启动QQ机器人.bat
```

**协议端 SnowLuma：** `@snowluma/runtime` v1.14.19——自带 `node.exe` + `native/*.node` + `native/ffmpeg/`，自包含、无 npm 运行时依赖。**安装包不含 QQ 本体**（README：QQ 以"免安装包"另行下载，或从机器上已装 QQ 复制）。

---

## 二、架构总览

```
QQ 客户端 ── SnowLuma（协议端）── OneBot v11 ──┐
                                             │  WS 收事件 / HTTP 发 API
                                    ┌────────▼────────┐
                                    │    app.js 总装   │
                                    │  store 消息存档  │
                                    │  orchestrator    │← 事件驱动·无状态运行
                                    └────────┬────────┘
                          ┌──────────────────┼──────────────────┐
                    prompt.js            tools.js            sender.js
                  （提示词组装）      （28 工具注册表）      （发送队列·限频）
                          │                  │                  │
                          └──────────► llm.js（OpenAI 兼容）◄───┘
                                             │
                                    sessions.js 运行留档 ──► SSE ──► ui/ 控制台
```

**运行形态三选：** Electron 桌面壳（`electron/main.js`，托盘常驻 / 关窗不退 / 可选自启）· headless（`node src/server.js`，浏览器访问 127.0.0.1:3210）· 单实例锁（`instance-lock.js`）+ 实例 id 隔离（`profile.js`，env `QQ_AGENT_PROFILE`）。

---

## 三、src 模块职责表（44 根模块 + skills/ 6 件）

### 3.1 接入与总装

| 模块 | 职责 |
|:--|:--|
| `app.js` | 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI |
| `server.js` | headless 入口（`createApp()` 后起 HTTP，不开窗口） |
| `routes.js` | 声明式 API 路由表（替代巨型 if-else 链） |
| `onebot.js` | **OneBot v11 客户端**：WS 只收事件 / HTTP API 负责发送与查询；重连退避 3s→30s；`get_login_info` 失败补拉 15s |
| `instance-lock.js` | 进程单实例锁（同一数据目录只允许一个核心） |
| `profile.js` | 实例 id——只认数字，用于多实例数据目录隔离 |

### 3.2 编排核心（本项目的价值密集区）

| 模块 | 职责 |
|:--|:--|
| `orchestrator.js` | **编排器**：防抖聚批 → 新开会话 → 未读驱动续跑 → 并发限流；含活跃模式、记忆整理、提醒触发、自我禁言检测 |
| `prompt.js` | 提示词组装：静态系统提示 + 动态用户消息（零对话历史）；含档位判定、上下文分层、前缀锚点 |
| `tier-slider.js` | 响应档位换算——**刻意零依赖**（避免 `config ↔ prompt` 循环依赖） |
| `store.js` | 每会话一个 JSON 消息存档（`id/mid/ts/senderId/text/self/read/reply/media`） |
| `sessions.js` | 每次运行一份留档 + 内存索引 + 索引缓存（2277 文件 25s → 3ms）+ 僵尸会话回收 |
| `memory.js` | 群友印象记忆：`data/memory/<chat>/<QQ>.json`，含旧版单文件自动迁移 |
| `reply-rescue.js` | 回复安全网：把"写在正文却没经工具发出"的成稿抢救成 `send_message` |
| `reminders.js` | 提醒（闹钟/计时）持久化 |
| `holidays.js` | 法定节假日 + 常见节日识别（供主动问候） |

### 3.3 模型与成本

| 模块 | 职责 |
|:--|:--|
| `llm.js` | OpenAI 兼容 Chat Completions 客户端（非流式）；工具调用 + usage 统计 |
| `providers.js` | 多提供商模型目录（从 DSH settings.yaml 导入，统一成 OpenAI 兼容） |
| `thinking.js` | 思考/推理参数内置适配（原 thinking-adapters 插件收编进核心） |
| `model-prices.js` | 内置主流模型官方价格表（成本核算，约 140 模型） |
| `price-feed.js` | 远程价格表——按 id 覆盖内置表 |
| `model-vision-docs.js` | 内置「模型图片输入能力」官方资料表 |
| `vision-scan.js` | 视觉能力**实测探测**：逐模型发 1×1 测试图，看网关接不接受 `image_url` |
| `telemetry.js` | 匿名用量遥测（周期上报调用次数 + token 快照） |

### 3.4 媒体

| 模块 | 职责 |
|:--|:--|
| `stickers.js` | 表情包体系：本地知识库 + 搜索 + 提示词摘要（QQ 收藏表情为源，本地库为 AI 认知层） |
| `sticker-manager.js` | 表情管理（本地文件落点） |
| `image-type.js` | 图片类型嗅探（**唯一实现**） |
| `image-compress.js` | 图片压缩（降到模型可接受尺寸/体积，省 token） |
| `video-reader.js` | 视频元信息探测 + 抽帧喂模型 |
| `gif-to-video.js` | GIF → mp4（动态表情转成模型可读） |
| `media-links.js` | 消息里的链接 → 媒体转发（确定性调度部分） |
| `md-to-plain.js` | Markdown → QQ 纯文本 |

### 3.5 发送与安全

| 模块 | 职责 |
|:--|:--|
| `sender.js` | **发送队列**：每会话串行（sendChain）+ 真人化随机间隔 + 分钟/小时限频 + QQ 硬长度切分 + CQ 转义 + Markdown 转纯文本；发出即记档（`self=true`） |
| `safe-fetch.js` | SSRF 防护：DNS 校验 / IP 固定 / 手动跟重定向 |
| `web-search.js` | 联网搜索（Bing 中文解析，免 Key；可扩任意兼容服务） |
| `logger.js` | 分级日志 + 落盘 + 内存环形缓冲（供 UI 查看） |
| `util.js` | 通用小工具（无业务逻辑） |

### 3.6 扩展与工具系统

| 模块 | 职责 |
|:--|:--|
| `tool-registry.js` | 工具注册表——新增工具只需 `registerTool()` |
| `tools.js` | 原生工具集 **28 件**（见 §四） |
| `plugin-loader.js` | 扫描 `plugins/` 与 `skills/` 两目录，按 kind 分类加载 |
| `skills/manager.js` | Skill 管理器：核心与扩展的唯一交互口（唯一开关来源 / 能力优先于名字 / 三层状态可解释） |
| `skills/registry.js` · `capabilities.js` · `manifest.js` · `config.js` · `errors.js` | Skill 系统的注册 / 能力 / 清单规范化 / 配置 / 错误五件 |
| `market.js` | 社区市场客户端（凭据 / 发布代理 / 口令安装） |
| `community.js` | 社区能力：固定远程价格表 + 云端共享屏蔽名单（失败回退本地） |
| `zip-install.js` | 市场包安全解压安装到 `skills/` 或 `plugins/` |

---

## 四、工具清单（28 件）

| 类别 | 工具 |
|:--|:--|
| 发言 | 发送消息 · 发送到指定会话 · 发送表情 · 拍一拍 · 结束会话 |
| 表情库 | 查看表情库 · 查看表情图片 · 备注表情 · 收藏表情 |
| 读档 | 查看历史消息 · 展开转发消息 · 查看活跃成员 · 查看可用会话 · 查看消息详情 · 查看消息图片 |
| 记忆 | 记录印象 · 查询印象 · 删除印象 |
| 联网 | 联网搜索 · 抓取网页 |
| 提醒 | 设置提醒 · 查看提醒 · 取消提醒 · 查询节日 |
| 网图 | 发送网图 · 搜索网图 |
| 媒体 | 读取视频 |
| 反馈 | 反馈问题 |

> 🔴 **工具名已去 `qq_` 前缀**（省 token）。工具定义**天然绑定本次运行的会话**——没有 key/token 参数，模型物理上无法把消息发到别的群（安全性靠架构而非校验）。

---

## 五、关键机制（值得单独看的六条）

### 5.1 无状态会话——成本恒定

`orchestrator.js` 头部即写死流程：

```
机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立 agent 处理）
→ 开始时把所有消息标记为已读（触发批作为【未读信息】）→ agent 用工具发言/决定不发言
→ 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话
→ …直到没有未读 → 回到空闲
```

- 每次处理 = 一个独立会话，**提示词只带**：静态系统提示 + 【已读信息】+【记忆】+【未读信息】
- 模型在本会话产生的工具调用与思考文本**用完即弃**
- 同会话同时最多一个运行；不同会话并行，受 `maxConcurrentRuns` 全局限流
- 长期信息靠记忆工具持久化

### 5.2 响应档位滑条（省 token 核心）

`tier-slider.js` —— 0~100 无级调节：

```
0 ──── 10 ──── 20 ──────────────── 90 ──── 100
│ 1 档 │ 2 档 │   3 档（概率线性）  │ 4 档 │
仅艾特  +关键词   prob=(pos-20)/70*100   全响应
```

**没命中的消息直接标已读，零 token 消耗。** 触发原因决定上下文条数（被 @ 时永远带最多上下文）。

### 5.3 提示词前缀缓存锚点

`orchestrator.js` 的 `promptAnchors`：记录上一轮发给模型的【记忆】+【已读信息】前缀状态，下一轮 `buildUserPrompt` 据此判断**能否原样复用前缀**（连续触发时吃缓存命中）。重启丢失 = 回到标准结构，无害。

配套铁律（`prompt.js` 注释）：**动态段必须追加到系统提示末尾**——插在中间会把后面核心规则的字节位置推来推去，缓存前缀归零。Skill 段同 priority 时按数组原序稳定排序（sort 不稳定 = 字节布局抖动 = 命中率波动）。

### 5.4 发送队列（`sender.js`）

- 每会话**串行**（`sendChain`）——不出并发错序
- 真人化间隔：随机区间 + 按字数附加
- 分钟/小时**双限频**——超限直接拒绝，错误回给模型（让它知道发不出）
- Markdown → 纯文本 · QQ 硬长度切分 · CQ 转义
- 发出的每条记进存档（`self=true`，供下一轮当"自己的发言"）
- 本地路径 → `file:///` URI（裸 Windows 路径在各 OneBot 实现支持不一致）

### 5.5 扩展两型（`plugin-loader.js`）

| 型 | 落点 | 生效方式 | 谁决定何时执行 |
|:--|:--|:--|:--|
| **插件**（确定性） | `plugins/<id>/` | 能力 `providers` / 钩子 `hooks` | **核心代码**——条件命中必执行，不经 LLM |
| **Skill**（LLM 型） | `skills/<id>/` | `registerTool` + 提示词片段 | **模型**——看工具说明自判 |

判据一句话：**规则能写死 → 插件；要理解人话 → Skill。**
其余约定：开关只有一处（`config.skills[id].enabled`，关掉则工具/能力/提示词片段/请求改写**同时**失效）· 按能力名依赖不按名字 import · 扩展提示词优先级强制压在核心规则之下（**不可能覆盖安全规则**）· 三层状态可解释（loaded / enabled / available，UI 直接给"为什么没生效"）· 热重载默认开启。

### 5.6 安全边界（架构级）

- **工具天然绑定会话**——模型发不到别的群（无群号参数）
- **发送白名单 + 限频**
- **SSRF 防护**：DNS 校验 / IP 固定 / 手动跟重定向 / 图片地址禁内网
- **系统提示分层**：安全规则与工具协议**不可被配置覆盖**（无论 `systemPromptOverride` 怎么写都追加在最后）

---

## 六、与本项目的对接点

| QQBot mod B 待办 | qq-agent 对应物 | 可借鉴度 |
|:--|:--|:--|
| **B5** `OneBotClient` 连接层设计 | `src/onebot.js`（WS 收事件 + HTTP 发 API 的完整实现，含重连退避与自信息补拉） | **高**——同协议同形态，可直接对照 |
| **B6** 发送面按连接类型分流 | `src/sender.js`（串行 + 限频 + 切分 + 转义，与连接类型无关的通用层） | **高** |
| **B7** 账号槽位配置面 | `profile.js` + `config.js`（实例 id 隔离 / 单实例锁） | 中——本项目槽位语义更宽（A/C 切换） |
| 接收面（群消息 → 注入） | `onebot.js` 事件解析 + `store.js` 存档结构 | 中——本项目复用 CH4 来源队列，不必照搬存档 |
| 项目边界（§五 明确不做） | —— | 参照其「不做多账号并发 / 不自研协议端」的取舍口径 |

**结构性差异（不可照搬）：** qq-agent 是**独立进程的完整机器人**；QQBot mod B 是**CH4 宿主的一条连接层**——它的编排器 / 控制台 / 存档体系在 CH4 里已有对应物（会话、视图层、来源队列）。可移植的是**协议对接与发送纪律**，不是整套运行时。

---

## 七、后续入口

拆解停在"地图"层。下一步按指认深入：

| 指认方向 | 深入落点 |
|:--|:--|
| OneBot 接入细节 | `src/onebot.js`（连接 / 事件解析 / 发送动作全集） |
| 发送纪律 | `src/sender.js`（限频参数 / 切分算法 / 转义规则） |
| 提示词工程 | `src/prompt.js`（系统提示全段 / 用户消息结构 / 档位判定） |
| 无状态编排 | `src/orchestrator.js`（约 1800 行，主流程在 `#runAgent` 732 起） |
| 工具设计 | `src/tools.js`（28 工具的定义格式与实现） |
| 扩展系统 | `src/plugin-loader.js` + `src/skills/*` |

> 解包产物保留在 `_unpack/`（386MB）；解包工具在 `tools/`（npm 装的 `7zip-bin`）。两者均为本项目工作区内的可弃物——后续不再需要时清理。
