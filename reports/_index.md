# QQBotB · 报告索引

> 定位：轮次报告目录的指针表。每轮一份，本表登记轮次 / 线 / 执行猫 / 状态。
> 维护：主干（majordomo）在每轮收线时更新；执行方只写自己的报告文件。

## R1 — B+C 迁移 Step 0（2026-10-30 · 已收线）

| 线 | 路线 | 报告 | 状态 |
|:--|:--|:--|:--|
| R1-L1 | 底座与收发面（ref §A/§B/§C） | `reports/R1-L1.md` | ✅ 已交 · 18/18 条 · 29 注入点 |
| R1-L2 | 编排 / 提示词 / 记忆 / 会话（ref §D/§E/§F） | `reports/R1-L2.md` | ✅ 已交 · 20/20 条 · 153 注入点 · 9 处字节布局变点 |
| R1-L3 | 工具面（ref §G） | `reports/R1-L3.md` | ✅ 已交 · 注册点实测 59 · 55 注入点 |
| R1-L4 | 发言策略 / 媒体 / 成本（ref §H/§I） | `reports/R1-L4.md` | ✅ 已交 · 13/13 条 · 109 注入点 |
| R1-L5 | UI / 砍清单 / 装配取证（ref §J/§K/§L/§M） | `reports/R1-L5.md` | ✅ 已交 · 4/4 组 · C 路线引用数全 0 |

## R2 — Step 1 补丁吸收 + Step 2 装配 + Step 3 验收方案（2026-10-30 · 已收线）

| 线 | 内容 | 执行猫 | 报告 | 状态 |
|:--|:--|:--|:--|:--|
| R2-L0 | 补丁吸收总表（20 脚本 × 346 点） | 已销毁 | `reports/R2-L0.md` | ✅ 已交 · 20/20 脚本 · 346/346 点 |
| R2-L1 | 源码归位 `app/src/business/` | 已销毁 | `reports/R2-L1.md` | ✅ 已交 · 51 文件 · 346 = 292 吸收 / 7 退役 / 47 待裁 |
| R2-L2 | 退役守卫 + 验收脚本 | 已销毁 | `reports/R2-L2.md` | ✅ 已交 · 20/20 守卫 · cache 基线重标定 · 数据根验证 |
| R2-L3 | Step 2 装配（一条 WS 分发 + 子进程隔离） | `R2L3b` | `reports/R2-L3.md` | ✅ 已交 · 分发点 247 行报告 · 卡点：单体无调用点 |
| R2-L4 | Step 3 验收方案（28 verify + 影子对比） | `R2L4` | `reports/R2-L4.md` | ✅ 已交 · 28/28 裁决 · 实跑基线 9/24 |

任务卡：`tasks/R1.md` · `tasks/R2.md`

## R3 — 落地 R2 遗留（todo 代码面全量 · 2026-10-30 · 进行中）

| 线 | 内容 | 执行猫 | 报告 | 状态 |
|:--|:--|:--|:--|:--|
| R3-L1 | 模块补搬（13 顶层 + `skills/` 六件） | 主干 | `reports/R3-主干对账.md` §一 | ✅ 已交 · `MISSING 0/203` |
| R3-L2 | telemetry 退役 + B33 reply 字段 | R喵4 | `reports/R3-L2.md` | ✅ 已交 · 4 删 2 改 · 键形态 `{senderId,messageId}` |
| R3-L3 | hub 接线 + ws（M1/M4） | R喵5 | `reports/R3-L3.md` | ✅ 已交 · 5 处插入 · ws 8.22.0 |
| R3-L4 | fixgroup 两点 + shadow-diff + data-root | 主干 + R喵6 | `reports/R3-L4.md` | ✅ 已交 · M3 主干落盘（18/18）· data-root 配平 PASS · shadow-diff 主干接手 |
| R3-L5 | M6 47 点待裁整理 | R喵7 | `reports/R3-L5.md` | ✅ 已交 · 47 点四列 · 先报差额（两套 47 成员不同，交集 14 点） |
| R3-L7 | 诊断工具（B48/B49） | R喵8 | `reports/R3-L7.md` | ✅ 已交 · 两脚本 self-test 通过 |
| R3-L8 | N6 迁移方案 | R喵喵喵 | `reports/R3-L8.md` | ✅ 已交 · 15 项清单 + 23 条点名 · 第一刀=影子判断器 |

## N6 — 判断器与话术收进自研单体（2026-10-30 · 代码面全落 · v0.98）

| 线 | 内容 | 报告 | 状态 |
|:--|:--|:--|:--|
| N6-① | 影子判断器 `navigator/intent.js` + `POST /api/nav/intent` | `design-qqbotb_log.md` §八十四 | ✅ `verify-intent` 41/41 |
| N6-② | 群消息接入 `navigator/ingress.js` + 带图缓冲 | 同上 | ✅ `verify-ingress` 33/33 |
| N6-③ | 话术自持 `navigator/persona.js`（三级回落） | 同上 | ✅ `verify-persona` 27/27 |
| N6-④ | 渐变切换面（单体 allow + 业务面逐类自锁） | 同上 | ✅ `verify-qqagent-navtools` 19/19 |
| N6-⑤ | R3-4 hub 单点扇出 / R3-5 topic-words 并入 / R3-7 成本折算 / R3-6 不改 | 同上 | ✅ `verify-navigator` 63/63 |
| 验收 | 人工验收清单（重启 / 影子观察 / 逐类切换 / 拍板） | `reports/N6-验收清单.md` | ⏳ 等 Rushiera |
| R3-L6 | 收线与验收 | 主干 | `reports/R3-主干对账.md` | ✅ 已交 · `verify-suite 23/24` · 五处真缺口修正 |

**主干自跑基线（非执行方自述）**：`verify-suite` **23/24**（R2-L4 基线 9/24）· `resolve-imports MISSING 0/203` · `check-syntax 73/73` · `verify-import-integrity ALL PASS` · `verify-boot` 真起得来（port 3210 / 5 条真实会话）。

**验收清单**（需人工过）→ `reports/R3-验收清单.md`
