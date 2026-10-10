# 浏览器工具组 SOP（外源留档）

> 来源：QQ 群 `689942975`（工仔养生水疗中心）· 2026-10-10 14:05–15:00
> 制卡 / 演示：群成员「唯一指定摸鱼怪」(QQ 1395171137)；派活：「此番不同往昔，无人与你助力」(QQ 569145850)
> 采集：Majordomo 2026-10-10（NapCat `get_image` 取协议端缓存 → `image-analyze` 逐张转录）
> 图片原件：`D:\QQcache\2405997337\nt_qq\nt_data\Pic\2026-10\Ori\`（协议端本地缓存，不随直链时效失效）

---

## 一、速查卡原文（`8081f45f43cf1b056b2c3b25428d32ce.png`，14:55）

# 浏览器工具组 — 指令集与流程

## 一、前置：开域

所有 `browser-*` 与 `image-inject` 都是**域限定**——域外调用一律拒（`ERR|TIMEBACK_*`）。

```
timeback-start(type="browser_vision", purpose="<短标签>")
  → 域内放行：browser-* + image-inject + 基础读面
  → 一次只开一个域；v1 未闭合前禁再开
timeback-back(findings="<成果位置>")
  → 回卷：区间内容销毁，findings 带回主干（只写位置 + 一句话，不写结论）
```

## 二、指令集

| 工具 | 参数 | 作用 |
|---|---|---|
| `browser-open` | `url` | 打开并等加载；返回标题 / 最终 URL / 耗时。**不做点击输入**——翻页靠换 URL 或取页内链接 |
| `browser-read` | `mode` = text / ax / links | 读页面并落盘。`links` 给可导航链接清单——**决定下一个开哪页靠它**；`ax` 给控件与结构 |
| `browser-eval` | `expression` | 执行 JS 取值——**万能口**：DOM 属性、页面内嵌数据、`img` 链。小结果直返、大结果落盘 |
| `browser-shot` | `full` | 截当前视口（或整页）为 PNG，返回**绝对路径**。落盘持久，可反复渲染 |
| `browser-tabs` | `action` = list / new / select / close | 多页签管理——保留来过哪一页，可回退对比 |

## 三、标准流程（列表 → 详情 → 取物）

1. **开域** → `timeback-start(browser_vision)`
2. **开列表页** → 搜图/搜索类页面**把 query 拼进 URL 直开**，不必模拟输入
3. **取下一跳** → `browser-read(mode=links)` 或 `browser-eval` 提取候选
4. **逐个开详情页** → `browser-open` → `browser-shot` 截图 / `browser-eval` 取字段
5. **域内看图** → `image-inject`（**不是** `image-analyze`）
6. **回卷** → `timeback-back`，`findings` 逐条给「位置 + 一句话」

**扒图片资产**（完整链）：`browser-eval` 取 `img` / `m.url` 链 → 出域后 `powershell Invoke-WebRequest -OutFile` 落盘 → 图片包装回主干呈现。

## 四、铁律与边界（实测）

- 🔴 要「**看见**」用 `image-inject`，要「**转文字**」用 `image-analyze`——域内默认前者；绕 analyze 转描述 = 把直读降级成中转（判例 2026-10-10）
- 🔴 **截图落盘在** `data:browser/<cat>/out/`——`file-tree` 从 `data:browser` 往下扫会漏掉（`out` 在忽略表），给全路径能列出
- 🔴 **域内不做工作、不写计划**——`back` 的 `findings` 只写成果位置，主干按位置回读、以回读内容为准

---

## 二、演示图

| 图 | 时间 | 文件 | 内容 |
|:--|:--|:--|:--|
| 1 | 14:32 | `ee60c4273f4d875d7d4b5bd7306bb99a.png` | 某猫（界面含「⟲ 回滚 / 🌿 分支」）演示**浏览器拉图全链**：bing 图搜 → `browser-eval` 取 `a.iusc` 的 `m.murl` 直链（一次 8 条）→ `Invoke-WebRequest` 落盘 → `image-analyze` 验真；附两条机制：截图落 `data:browser/<cat>/out/`（`file-tree` 会漏）、`browser-eval` 是万能取值口；两条边界：图库直链防盗链 403、`upload.wikimedia.org` 本机不可达 |
| 2 | 14:37 | `128dc2295093fb136d4dad4988238c45.png` | 派活原话：「好，那就试试别的 / 你帮我开 bilibili，搜索原神直播列表 / 随便选三个主播的直播画面截图给我」 |
| 3 | 14:37 | `efe52d6139568887c2208321e353f9cd.png` | 上述派活的**交付**：三个原神主播直播截图（丝竹- 8250220 / づ咸鱼づ 12987372 / 桃·李不言 1949385438）+ 链路说明（`browser-open` 搜索页 → `browser-read` links 184 条 → 逐房 `browser-shot` → 回卷后 `image-analyze` 复核）；两点说明：游客态不影响截图、截的是「页面」不是「视频帧」 |
| 4 | 14:37 | `05694739ecc4d199e419222dc0b012a9.jpg` | 无关本主题——DeepSeek 拟人「鲸元券」梗图 |

---

## 三、取图与看图链路（2026-10-10 实测）

**视觉模型配置**（宿主全局配置面）：

| 键 | 值 | 说明 |
|:--|:--|:--|
| `vision.api_config_id` | `6c107132-65c6-46b3-86a2-4eb094e2785d` | 引用 LLM 池 `newapi-47.250`（端点 `http://47.250.160.225:8443/v1`，推导 `/chat/completions`） |
| `vision.model` | `hy4-preview-f` | 同端点 qq-agent 实证能收图；空则回落池默认模型 |

实测：`image-analyze` 直读本地 PNG / QQ 缓存图，逐张转录成功。

**QQ 图片取回（走协议端缓存，不走会过期的直链）**：

- 通道：NapCat HTTP API `http://127.0.0.1:3000/get_image?file=<消息里的 file 名>`（另附 access_token 查询参数）
- 端口 / token 来源：`workspace:QQBotB/runtime/NapCat/NapCat.52230.Shell/config/onebot11_2405997337.json`
- 返回：本地缓存绝对路径 `D:\QQcache\2405997337\nt_qq\nt_data\Pic\2026-10\Ori\<file>.png`
- 对照实测：QQ 多媒体直链（`multimedia.nt.qq.com.cn/download?...rkey=...`）已过期——`retcode:-5503007 download url has expired`；协议端缓存不受影响
- 参考实现：qq-agent `app/src/tools.js` L616 `get_message_images`（`get_image` 优先 → 直链兜底；拿到字节转 data URL 交视觉模型）

**未决**：`D:\QQcache` 在受控根外——`file-copy` 拒根外源；如需让猫长期直读该目录，把它纳入受控根（人工面板）。

---

## 四、待定

- **留档落点**：本文为原始材料存档；是否转成前文注入（QQBot mod B 群记忆 / CH4 浏览器工具用法面）待 Rushiera 定。
- **跨根复制**：图片原件在 `D:\QQcache\...`（受控根外）——`file-copy` 拒绝根外源，原件如需进受控根需人工搬运或把该目录纳入受控根。
