# QQBot mod B — Git 档案

> 版本：v1.0 | 创建：2026-10-11
> 定位：本项目 Git 操作的项目实例——上工加载、收工更新。通用用法见 `L2/Job/Git/`。
> 模板来源：`L2/Job/Git/templates/project-git.md`

---

## 一、仓库信息

| 字段 | 值 |
|:--|:--|
| 远程地址 | `https://github.com/Rushiera/QQ-Bot-Mod-B.git`（单远程） |
| 本地路径 | `D:\Mau\WorkSpace\QQBotB` |
| 默认分支 | `main` |
| 仓库内规范 | `project.md` 文件头（Git 声明）+ 本文件 |

## 二、上传模式

**收工推送** —— 每次收工统一 `git add -A` → commit → push → `status -sb` 验证；commit message 含版本号 + 摘要。

## 三、同步范围

### 纳入（Git 管理）

| 路径 | 内容 | 理由 |
|:--|:--|:--|
| `app/`（除 `app/data/`） | 自研单体（Electron）源码 / 界面 / 工具 | 代码真相源 |
| `src/QQBotB.Collector/` | 卫星收集器（C#） | 代码真相源 |
| `tools/` | 补丁链 / 生成器 / 自测脚本 | 可复现面 |
| `启动QQBotB.bat` / `.vbs` · `启动QQAgent.bat` / `.vbs` · `启动QQAgent-仅业务面.bat` / `.vbs` · `tools/entry.cmd` | 入口启动器（含生成器产物与单体启动体） | 入口可复现 |
| `project.md` / `todo.md` / `CHANGELOG.md` / `glossary.md` / `design-*.md` / `design-*_log.md` / `ref-*.md` / `git-profile.md` | 项目档案面 | workspace 独立立项——档案随仓库走 |

### 排除（`.gitignore`）

| 路径 | 理由 |
|:--|:--|
| `runtime/` | 协议端自带 NTQQ（体积 + 可重装）——仅 `runtime/napcat-host/` 脚本与配置入库 |
| `_unpack/` | 第三方拆包产物（386 MB · 可弃） |
| `app/data/` | 应用运行数据（日志 / 配置 / 截图） |
| `node_modules/` · `bin/` · `obj/` | 依赖与编译产物 |
| `QQ-Agent V0.4 Preview Bugfix Setup.exe` | 来源安装包（107 MB） |
| `CatTemp/` | 会话中介文件（自测草稿 / 探针 dump）——按收工纪律应当清空；忽略以防漏清入库 |

### 不在此仓库（知识网络侧）

| 路径 | 管理机制 |
|:--|:--|
| `ccbp:Project/_index.md`（本项目行） | Discipline §八 规则管理，不走本仓库 push |

## 四、同步状态（收工更新）

| 字段 | 值 |
|:--|:--|
| 上次同步时间 | 2026-10-26 22:58 |
| 上次同步 commit | `9154d75` v0.88 收工：todo 去重（人称口径 B43-B45） |
| 远程状态 | 与 origin 同步（`2d1ae17..9154d75`） |

## 五、项目特有规则

- commit message 格式：`vX.Y: 变更摘要`——版本号取 `project.md` 文件头 / `CHANGELOG.md` 最新行
- `runtime/` 与 `_unpack/` 不入库——重装后按 `tools/apply-*.mjs` 补丁链复现
- 入口启动器是 `tools/apply-entry.mjs` 的产物——**改入口改生成器**，不手改产物（.bat / .vbs 受 ASCII + CRLF 硬约束）
- 本档案在仓库内（workspace 独立立项）——随本仓库 push

---

_版本：v1.0 | 2026-10-11 | 模板定稿_
