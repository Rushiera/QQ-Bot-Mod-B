# 前文结构基线（2026-10-18 实测）

> 定位：**前文瘦身攻坚的读数基线**——改之前先看这里，别重新跑一遍侦察。
> 性质：快照，会随配置漂移；数字是测量时刻的实况，不是规范。
> 复跑：`tools/prompt-anatomy.mjs`（改 `SINCE` 换时间窗，产物落 `CatTemp/qqbotb-prompt-anatomy3.out.txt`）；缓存侧 `tools/cache-diag.mjs`。
> 攻坚入口：`todo.md` §九（B22 已读信息 / B23 角色设定）。

---

## 一、组装链路（代码位置）

| 段 | 生成位置 | 来源 |
|:--|:--|:--|
| system（1.4k 字符） | `src/prompt.js:253` `buildSystemPrompt`（lean 档） | 静态模板 + Skill 段 |
| 【角色设定】 | `src/prompt.js:889-891` | `persona.roleText`（**纯字符串，整段拼入**） |
| 【可用表情包】 | `src/prompt.js:894-897` | `stickers.js:148` 按 60 分钟种子轮换 |
| 【引导说明】 | `src/prompt.js:900-906` | 静态 |
| 【记忆】 | `src/prompt.js:923-933` | 会话要点 + 群记 + 群友印象（`memory.formatForPrompt`） |
| 【已读信息】 | `src/prompt.js:936-954` | `buildPastState(store, chatKey, {limit:0, sinceTs:sessionStart})` |
| 【未读信息】 | `src/prompt.js:962-963` | 本轮触发批 |
| 【当前时间】/【发言配额】等 | `prompt.js:995` / `orchestrator.js:1070-1123` | 末尾追加，逐轮变 |

会话窗口模式下 `contextLimit` 传 `null` = **会话全量**（`orchestrator.js:743-747`）；锚点池同窗口（`prompt.js:817-821`）。

## 二、实测体量（最大群：group:689942975 工仔养生水疗中心，会话 mvcf2x2e，10-17 13:13）

总计 **262,646 字符 ≈ 174,100 tokens**（字符/token ≈ 1.51）。`tier=4 全部响应` · `anchor=anchored` · `contextLimit=1993`。

| 段 | 字符 | 占比 | ≈tokens |
|:--|--:|--:|--:|
| 【已读信息】 | 156,825 | 59.7% | 103,900 |
| 【角色设定】 | 95,432 | 36.3% | 63,200 |
| 【记忆】 | 6,846 | 2.6% | 4,500 |
| 其它（引导/表情包/配额/群节奏/时间） | 1,505 | 0.6% | 1,000 |
| system（lean） | 1,420 | 0.5% | 940 |
| 【未读信息】 | 353 | 0.1% | 234 |
| 【新已读信息】 | 265 | 0.1% | 175 |

最近两天前文体量 TOP5 全部是该群（26.0 万 ~ 26.3 万字符）。

### 2.1【已读信息】规模

- **1,989 条**消息，均 79 字符/条（≈52 tok/条），跨度 **10-10 15:59 → 10-17 20:56（7 天）**
- 发言人：此番不同往昔 776 · 唯一指定摸鱼怪 640 · **我 421** · 将军 56 · CatHome招待所前台 47 · 中秋 33
- 无任何截尾——`tier=4` 全量拉入，`contextLimit` 与实际条数相等

### 2.2【角色设定】按注入面归组

| 注入面 | 字符 | ≈tokens | 与群聊相关度 |
|:--|--:|--:|:--|
| L1 五件（Discipline/TOOL-REF/Tree/Wisdom/GLOSSARY） | 24,684 | 16,300 | 低 |
| CatHome Job 三件 | 21,631 | 14,300 | 无（宿主管理） |
| Chat Worker 四件 | 15,435 | 10,200 | **高**（本行） |
| Browser Job 三件 | 12,288 | 8,100 | 中（有真 browser-* 工具） |
| Majordomo Worker 四件 | 12,084 | 8,000 | 无（管家身份） |
| L0 三件（SOUL/AGENTS/USER） | 3,479 | 2,300 | 中（人格底座） |
| 段首人格 + 注入标题 | 5,832 | 3,900 | — |

单文件最大：`L2/Job/CatHome/exp.md` 9,618 · `L1/Discipline.md` 7,298 · `L2/Job/CatHome/skill.md` 6,195 · `L2/Job/CatHome/tools.md` 5,818 · `L1/TOOL-REF.md` 5,727。

> 与 `design-qqbotb-navigator.md` §十七 的 93,628 字符口径一致（该处为 10-11 读数），方案已定但**未实施**（B16）。

### 2.3【记忆】细分

会话要点 787 · 【本群】2,364 · 【本群在聊】1,190 · 【对群友的印象】2,497（字符）。

## 三、两条收缩链路——为什么"加了记忆整理"已读还是全量

| 链路 | 作用对象 | 触发 | 代码 | 现状 |
|:--|:--|:--|:--|:--|
| **记忆整理**（consolidate） | 群友印象 / 群记（【记忆】段，仅 4.5k tok） | 印象条数超阈值 + 冷却（默认 3h）；群记只在收工轮或手动 | `orchestrator.js:1990-2017`、`2035-2056` | 开着，**完全不碰【已读信息】** |
| **收工轮轮转**（rollover） | 已读窗口（重置 `startedAt`）+ 产出会话要点 | `shouldRollover`：上轮 `prompt_tokens` + 本批字符/1.5 > `session.maxContextTokens` | `session-state.js:129-144`、`orchestrator.js:618-632` | 阈值**160,000**（`_unpack/data/config.json:163`），单会话可吃到 16 万 tok 才收工 |

其它事实：

- 轮转后已读窗口 = `min(会话起点, memoryFloorTs)` 之后的全部消息（`session-state.js:111-117`）——**本会话内全量，不是跨全部历史**。
- `session-state.json` 现状：689942975 `rollovers=5`、`startedAt`=10-18 09:20、`lastPromptTokens=65,460` → 轮转链路是通的，只是阈值高。
- 会话要点上限 4,000 字符（`session-state.js:152-166`）。
- 业务面**没有文件读取工具**：`tools.js` 全清单（`send_message` / `memory_*` / `web_*` / `nav_*` …）无 `read_file` 类——"按需加载前文"缺少执行面。

## 四、已排除

- **缓存命中率与本结构无关**（2026-10-18 实测）：同 chatKey 相邻会话 userPrompt 公共前缀 9.7 万~10.9 万字符，顶部无动态段；同一字节请求连发 10 次命中 3/10 → 属上游缓存不稳定（`tools/cache-diag.mjs` 可复跑）。

---

## 五、B23 实施后读数（2026-10-18）

- `persona.roleText`：**4,779 字符**（≈3.2k tok）——从 95,432 字符（≈63.2k tok）砍 **95.0%**；占原 262,646 字符总 prompt 的 1.8%。
- 结构：IDENTITY / CCBP_PRIMER / TOOLS_MAP / ROUTE_INDEX / BLOCKED_RULES / NAV_QUICK（六段）。
- 按需文件：`workspace:QQBotB/role/nav-rules.md`（4,779 字符）· `role/blocked-rules.md`（954 字符）。
- 执行面：业务面工具 `read_file` / `list_dir`（受控根 workspace + ccbp，只读）；工具总数 54 → 56。
- 复跑：`tools/verify-qqagent-fileread.mjs`（20/20）；roleText 由 `tools/apply-qqagent-config.mjs --roletext-only` 生成。
- 注：B22（已读信息）未动；本文件 §二 的 95,432 是 B23 前基线，保留作对照。
