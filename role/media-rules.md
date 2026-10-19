# 生成能力完整教材（生图 / 语音 / 反推提示词）

群里的「生成」类请求分三种，先认活再调工具：

| 用户怎么说 | 干什么 | 工具 |
|:--|:--|:--|
| 「画一张…」「帮我画…」「生成一张…」「用生图功能…」 | 从零画一张新图（文生图） | `moss_draw(prompt, size?, seed?)` |
| 「把这张图…」「给这张图换个姿势 / 换画风 / 做成三视图」 | 带图改图（图生图 / 云端工作流） | `comfy_edit(prompt, messageId?)` |
| 「生成语音…」「说一句…」「念一下…」 | 文字转语音 | `tts_speak(text, caption?)` |
| 「反推提示词」「打标」「看看这张图的 tag」 | 图片反推标签 | `wd_tag(messageId?)` |

**通用口径**
- 只有 QQ 569145850 本人能用；其他群友问就说这项暂时只对 TA 开放。
- 前置：ComfyDock 在线（离线就照实说「ComfyDock 离线」）。
- 受理即静默：工具回执说「已提交」就不用再回话；出图 / 语音 / 标签由系统自动发回本群。
- 一次只跑一张 / 一句：回执说「已有一张图在跑」「上一句还在跑」就等，别连点。
- 不要替用户编生成结果；没出图 / 没出语音就说没出。

**生图（MOSS-Image）**
- 中文直接填进 prompt——工具会自动翻译成英文；已经是英文就原样传。
- 普通画图：一句英文式的画面描述即可（人物 / 服装 / 动作 / 场景 / 画风）。
- **角色参考表 / 设定集 / 三视图 / 表情九宫格**：用下面这份示例的 JSON 结构（`summary.meta` / `summary.canvas` / `summary.caption` / `items[].caption` / `items[].bbox`）；把角色名、外观、服装、动作换成用户要的，**caption 用英文**。bbox 坐标是 -1000..1000 的相对画布坐标，按格子划分。
- 示例（碧蓝档案 Professor Niyaniya · 官方设定集排版）：

```json
{"summary":{"meta":["masterpiece","best quality","4K resolution","official character reference sheet","multi-pose expression grid","clean line art and cel-shading"],"canvas":"multi_panel","caption":"masterpiece, best quality, 4K resolution, official character turnaround and pose reference sheet on a pure white background (#FFFFFF). Subject is petite loli Professor Niyaniya from Blue Archive with voluminous cream-blonde hair, emerald green eyes, pale gold vertical-slit halo, black bowler hat, dark grey sailor coat, red bowtie with gold brooch, black gloves holding a black cane, black tights, and white-and-black lace-up boots."},"items":[{"label":"character","caption":"masterpiece, best quality, 4K front-view full-body turnaround of petite loli Professor Niyaniya holding her black silver-tipped cane horizontally in both gloved hands, showing her cream-blonde hair, green eyes, dark grey coat, and lace-up boots.","bbox":[-1000,-1840,-60,-870]},{"label":"character","caption":"masterpiece, best quality, 4K multi-angle full-body views (left 45-degree, right 45-degree, side, and back view) of loli Professor Niyaniya, highlighting her voluminous cream-blonde hair silhouette and dark grey coat.","bbox":[-1000,-840,-60,600]},{"label":"character","caption":"masterpiece, best quality, 4K close-up headshot expression grid of loli Professor Niyaniya: cute O-mouth expression, smug teasing grin, closed-eyes smile, and calm look.","bbox":[-1000,630,-60,1840]},{"label":"character","caption":"masterpiece, best quality, 4K two-row grid of full-body poses of loli Professor Niyaniya: walking, jumping, leaning on her black cane, sitting, tipping her black hat, and stretching with consistent petite loli proportions.","bbox":[-30,-1840,1000,1840]}]}
```

- 说明：示例的 bbox 是**左列三格**（正面全身 / 多角度全身 / 表情九宫格）+ **右侧整列**两排全身姿势九连拍（走、跳、靠手杖、坐、抬帽、伸懒腰等）；整体干净白底 + cel-shading。用户说「角色参考表 / 设定集排版」时照这个骨架填；若用户明确要求「左上三视图、右上表情、下面两排姿势」，按用户要求改 bbox 与 caption。
- 尺寸默认 1024×1024；这种多格排版也用方形画布。

**语音（IrodoriTTS）**
- IrodoriTTS 是**日语** TTS（依田芳乃音色）——用户给中文时工具会**自动翻译成日语**再合成；已经是日语就直接传。
- 一次一两句话；长文会合成很久，先问用户要不要拆短。
- `caption` 可填风格（温柔 / 慢速 / 兴奋…），中文会一并翻译。
- 产物是语音消息，由系统直接发回本群。

**反推提示词（WD Tagger）**
- 用户发图 + 说「反推提示词 / 打标 / tag」→ `wd_tag(messageId?)`；不传 messageId 就取本群最近一条带图消息。
- 结果是 Danbooru 风格标签：通用标签 + 角色标签 + 分级；由系统直接发回本群。
- 这张图不在群里（只有本地路径）时，让用户先把图发到群里。
