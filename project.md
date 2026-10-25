# QQBot mod B — 项目档案

> 类型：QQ 消息桥接（模式 B）——专用 QQ 号 + OneBot 11 协议端 / 版本：v0.85 / 主人格：Coder / 加载 Job：CSharp（必须）· Git（按需——收工推送）/ 项目依赖：无 / 路径：`workspace:QQBotB/`（WorkSpace 受控根，独立于 CCBP）
> Git：GitHub `Rushiera/QQ-Bot-Mod-B`（单远程 · 收工推送）
> 创建：2026-09-26
> 缘起：模式 A（QQ 官方 Bot 开放平台通道）受「每条用户消息最多 4 次被动回复」约束，无法支撑「猫的会话内容随时推送到 QQ」。模式 B 改为专用 QQ 号 + OneBot 11 协议端，自主收发、无被动预算。
> 🔴 **立项声明（前提 · Rushiera 2026-09-26 定）：** 本项目当前为 **workspace 独立立项**——独立于 CCBP Project 主干推进；验证通过后**绑定并合并至 Majordomo**（并入 CH4 的 QQ 域，连接层按类型分流）。本声明为项目前提，非过渡注记。

---

## 项目目的

给猫一条**不受被动回复限制**的 QQ 出口：

- 以专用 QQ 号（小号槽位）登录协议端，猫产出的内容通过该号**主动**发到指定群
- 反向：群消息进猫（注入 CH4 会话）
- 与模式 A 并存不冲突——A 走官方通道，B 走 OneBot 11，CH4 侧按连接类型分流

## 边界（三条硬约束）

| # | 约束 | 内容 |
|:--:|:--|:--|
| 1 | **路线 B/C**（2026-10-09 修订） | NapCat.Shell 一键版——自带 NTQQ 独立进程 + 专用小号；本机日常 QQ 不受影响。原路线 A（注入本机 QQ 客户端）因本机 QQ 为经典版 9.7.25、不满足 NapCat 的 NTQQ 9.9.26+ 要求而未采用 |
| 2 | **C 槽位保留** | 目标账号槽位化——切号路径不改架构（槽位 = 账号 + 登录态 + 绑定群号） |
| 3 | **非官方授权** | 违反 QQ 用户协议，封号风险自担；取用范围限自有账号、自有群 |

## 架构对接（终态）

```
NapCat.Shell（独立协议端 + 自带 NTQQ）── OneBot 11 HTTP/WS ──┐
                                                          ↓
                                          OneBotClient（本项目新增）
                                                          ↓
                                    QQBotService 连接层（按类型分流）
                                       ├─ 模式 A：官方 API（msg_id + 4 次被动预算）
                                       └─ 模式 B：OneBot（group_id，无被动预算）
```

- **复用面**：接收注入 / 来源队列 / 视图层转发 / 串行发送——沿用 CH4 现有 QQ 域，不重写
- **新增面**：连接层（OneBotClient）+ 配置（协议端地址 / access_token / 目标群号 / 账号槽位）+ 池管理界面的类型选择
- **卫星形态（2026-10-09 定）**：QQBot mod B 作为独立卫星程序运行（协议端 + 收集器），与 CH4 的挂载只加一层转发，不改骨架

## 项目周期

启动 2026-09-26 · 阶段序列：M0 立项与方案调研 → M1 通道实测（装机 + `send_group_msg` 打通）→ M2 CH4 侧连接层接入 → M3 合并归位（绑定至 Majordomo / CH4 QQ 域）

## 文档索引

| 文件 | 类型 | 说明 |
|:--|:--|:--|
| `project.md` | 项目档案 | 本文件——定位 / 边界 / 路由 |
| `todo.md` | 🔴 上工强制依赖 | 行动面 |
| `CHANGELOG.md` | 🔴 上工强制依赖 | 历史唯一真相 |
| `glossary.md` | 🔴 上工强制依赖 | 术语唯一权威 |
| `design-qqbotb.md` | 设计总纲 | 方案调研结论 + 选型理由 + 运行路线 + 槽位设计 |
| `design-status.md` | 兑现摘要 | 全局兑现摘要 + 设计文档路由——每文档一行 |
| `design-qqbotb_log.md` | 兑现明细 | 落地实录——装机参数 / 接口参数 / 实测口径 / 踩坑（含 §七 会话生命周期 · §八 群内自主参与 · §十 bot 指定限频 · **§七十一 发言档位五档 + 客观采集** · **§七十三 群名片余额后缀**） |
| `design-qqbotb-session.md` | 设计（模块） | 会话生命周期 + 记忆面——全量窗口 / 收工轮 / 归档轮转 / 429 长轮询（判据见其 §四） |
| `design-qqbotb-engage.md` | 设计（模块） | 群内自主参与——取消本地门 / 聚批 / 发言配额 / 发言热度自适应 / 收工轮自产话题词 / bot 指定限频 / 发言硬限制 / 发言纪律 / **回应参数**（判据见其 §十三）· **发言档位五档 + 客观采集**（判据见其 §十五） · **余额后缀（群名片 · 按群开）**（判据见其 §十六） |
| `design-qqbotb-memory.md` | 设计（模块） | 记忆分类——两轴三分（人 / 群 / 轮）+ 群记 `kind` 枚举 / 注入顺序 / 工具面 / 迁移 / **§3.10 记忆不节流（写入放开 + 归档 + 索引 + 检索 + 沉淀拍）**（判据见其 §四） |
| `design-qqbotb-navigator.md` | 设计（模块） | 领航员模式——QQ 群指挥 CH4 猫群：开关面 / 会话态 / 指令面（`cat.chat` · `Chat ` 双通道）/ 观测面（SSE → 截图 → 解读 → 发群）/ 共存面（指令 vs 闲聊）/ 教学面 / 健康检查 / 迁移路径（判据见其 §十一）· **前文装配与整理入口见其 §十七** · **图像编辑（ComfyDock [生成] 工作区）见其 §十八** · **轻通道（未开启时的投递 + 分析读全）见其 §十九** · **群内生成（MOSS 生图 / IrodoriTTS 语音 / WD Tagger 反推提示词）见其 §二十** |
| `ref-qqagent.md` | 外部参考 | qq-agent v0.4.0 拆解——模块地图 + 关键机制 + 对接点 |
| `ref-browser-sop.md` | 外部参考 | 浏览器工具组速查卡（群 689942975 · 2026-10-10 莎制卡）——指令集 / 流程 / 铁律 + 四张演示图内容 + 取图与看图链路 |
| `ref-qqagent-features.md` | 外部参考 | qq-agent **功能清单与实现落点**（编号索引 → 源码文件:行号；配取舍建议） |
| `ref-prompt-baseline.md` | 实测基线 | 前文结构读数基线（分段占比 / 注入文件归组 / 两条收缩链路 / 组装链路代码位置）——B22·B23 攻坚入口 |
| `git-profile.md` | Git 档案 | 本项目 Git 实例——仓库 / 上传模式 / 同步范围 / 上次同步（收工更新） |

## 目录结构

```
QQBotB/
├── .gitignore                 仓库忽略规则（运行区 / 拆包产物 / 依赖 / 安装包不入库）
├── 启动QQBotB.bat / .vbs      🔴 入口（一键全流程重启——起自研单体）· 由 `tools/apply-entry.mjs` 生成
├── 启动QQAgent.bat / .vbs     旧入口名——单体入口的别名（旧快捷方式指向它）· 同上生成
├── 启动QQAgent-仅业务面.bat / .vbs  回落路径（只起业务面——单体起不来时用）· 同上生成
├── project.md / todo.md / CHANGELOG.md / glossary.md
├── design-qqbotb*.md          设计（总纲 + 模块：session / engage / memory）· design-status.md
├── role/                      角色设定按需文件（nav-rules.md / blocked-rules.md）——B23 上工式
├── design-qqbotb_log.md       兑现明细（唯一证据承载处）
├── ref-qqagent.md             外部参考拆解（qq-agent v0.4.0）
├── ref-qqagent-features.md    功能清单与实现落点（编号 → 源码行号）
├── app/                       自研单体（Electron）——协议端宿主 / 协议端登录面 / OneBot 连接 / 界面
├── src/QQBotB.Collector/      卫星程序——OneBot WS 事件收集器（M1 落地）
├── runtime/                   运行区
│   ├── NapCat/NapCat.52230.Shell/  协议端（自带 NTQQ 9.9.33）
│   └── events/                事件落盘（JSONL · 按天分文件）
├── _unpack/                   拆包产物（386MB · 可弃）
└── tools/                     拆包工具（7zip-bin）+ 入口生成器（`entry.cmd` = 单体启动体）+ QQ Agent 配置 / 补丁 / 自测 / 迁移脚本
```
