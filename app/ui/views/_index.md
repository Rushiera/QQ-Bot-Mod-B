# app/ui/views — 前端分块写面声明

> 建立：2026-10-31（R5 阀门动作 · 主干）
> 定位：**写面所有权表的前端半边**——本目录下每个文件在 R5 轮次内只有一条线可写。
> 边界：本文件归主干（majordomo）独占写；各执行线只读，不改本文件、不改别人的文件。

---

## 一、为什么要有这个目录

单体界面现状（R5-L1 前置实测）：`app/ui/index.html` 175 行 / `app/ui/app.js` 25,512 字节 / `app/ui/style.css` 6,818 字节——**单文件承载全部 6 个页签**。

要补原版 6 个页面（会话 / 存档 / 记忆 / 用量 / 技能 / 插件），单文件会变成 8 万字符以上的互改战场：六条线同时改同一个 `app.js`，任何一条的落盘都会覆盖别人的中间态。

**解耦方式**：每个页面一个文件、各自一个全局挂载函数；`app.js` 退化为「导航 + 轮询 + 调各页 render」，只在 L1 落地一次。

---

## 二、写面归属（R5 轮次内）

| 文件 | 归属线 | 状态 |
|:--|:--|:--|
| `_index.md`（本文件） | **主干独占** | 已建 |
| `_shell.js` | L1 | 🟡 桩（39 行 · `__ui` 仅 2 成员） |
| `sessions.js` | L2 | 🟡 桩（43 行） |
| `chats.js` | L3 | 🟡 桩（42 行） |
| `usage.js` | L4 | 🟡 桩（43 行） |
| `memory.js` | L5 | 🟡 桩（43 行） |
| `skills.js` | L6 | 🟡 桩（44 行） |
| `plugins.js` | L7 | 🟡 桩（42 行） |
| `settings.js` · `settings-sections.js` | L8 | 🟡 桩（47 + 21 行） |

> 🔴 **`settings.js` 是「业务设置」（页签 `bizsettings` / `#view-bizsettings`）**，不是既有「本地设置」（`#view-settings`，归 `app/ui/app.js` 管，改单体自己的端口 / 协议端目录 / 账号）。两者并存不合并。

**禁**：任何线不得新增本表之外的文件；需要新文件先报主干登记（未登记 = 无写权）。

---

## 三、分块契约（🔴 签名级冻结——L2–L8 照此写，不 import，运行时只读 `window.__ui`）

1. 每块是**普通脚本**（无 `import` / `export`），按 `index.html` 里 `<script defer>` 顺序执行——与原版 `_unpack/resources/app/ui/app/` 的 13 段拆分同构（那份的拆分原则见 `00-core.js:1-5` 头顶注释）。
2. 每块只暴露**一个**全局挂载对象：`window.__views.<name> = { mount(el), refresh() }`。块内部函数不进全局。
3. 跨块共享的东西由 `_shell.js` 挂到 `window.__ui`；其它块只读不写。
4. 端点调用一律走 `window.__ui.api(path, options)`，**块内不直接 `fetch`**——代理层的失败出口只有一处，散在八处就无法统一观测。
5. 每块自带空态与失败态：拿不到数据渲染「不可用 + 原因」，不渲染空表格冒充正常。

### 3.1 `window.__ui` 冻结签名（L1 必须实现，L2–L8 只能消费）

| 成员 | 签名 | 语义 |
|:--|:--|:--|
| `api` | `async api(path, {method='GET', body}={}) → {ok, ...}` | 打单体端口。非 2xx 时**不抛**，返 `{ok:false, error, status}`——各块统一按 `ok` 判，不写 try/catch 分支 |
| `$` | `$(sel) → Element\|null` | `document.querySelector` |
| `$$` | `$$(sel) → Element[]` | `querySelectorAll` → 真数组 |
| `el` | `el(tag, attrs={}, ...children) → Element` | 建元素；`attrs` 里 `class` / `text` / `html` / `onclick` 等按名直接赋 |
| `esc` | `esc(s) → string` | HTML 转义（四字符） |
| `fmtTime` | `fmtTime(ms) → 'MM-DD HH:mm'` | 本地时区；非法值返 `'-'` |
| `fmtNum` | `fmtNum(n) → '1,234'` | 千分位；非数字返 `'-'` |
| `fmtBytes` | `fmtBytes(n) → '1.2 MB'` | 1024 进制 |
| `empty` | `empty(el, text) → void` | 渲染空态（灰字一行） |
| `fail` | `fail(el, error) → void` | 渲染失败态（红字 + 原因），**不是**弹窗 |
| `registerView` | `registerView(name, {title, mount, refresh}) → void` | 块自注册；`mount` 惰性（首次切页才调） |

### 3.2 块内必须自带的两个函数

| 函数 | 契约 |
|:--|:--|
| `mount(el)` | 一次性建 DOM 骨架（灌 `el` 的容器元素）。**禁止**在此处发请求 |
| `refresh()` | 拉数据重渲染。可被反复调用；并发调用须自行去重（`let inflight` 单飞） |

### 3.3 代理层契约（L9 提供，L1 里 `api()` 打的就是它）

单体端口上新增 `GET /api/biz/*` → 转发业务面 `127.0.0.1:3210/api/*`，实现文件 `app/src/web/business-proxy.js`。
- 通配前缀转发，**不逐条枚举**（业务面 73 条路由，枚举必漏）。
- **纯前缀替换**：`/api/biz/chats/group_123/messages` → `http://127.0.0.1:3210/api/chats/group_123/messages`。带路径参数的端点（`/api/sessions/<id>`、`/api/chats/group_<gid>/messages`）直接拼进路径即可——业务面自己有正则路由表，代理层**不解析、不拆参**。
- 业务面不可达 → `502` + `{ok:false, error:'业务面不可达（127.0.0.1:3210）', status:502}`，**不吐空数据冒充成功**。
- 只允许 `GET` / `POST` / `DELETE` 透传；请求体与响应体原样转发（`Content-Type: application/json`）。
- 超时 8 秒（业务面 `session/compact` 这类会慢，8 秒外一律 504 + 原因）。
- 🔴 **前提**：单体 `app/src/web/server.js:109` 的路由查找是 `api[key]` **精确匹配**，不支持通配。故 `server.js` 需在「未命中」那一支追加前缀兜底（约 6 行）：`pathname.startsWith('/api/biz/') && api.__bizProxy` → 交给它。`createBusinessProxy` 返回的键就是 `__bizProxy`。


---

## 四、依赖关系

```
_shell.js（L1：导航 / api() / 共享工具 / 代理失败出口）
   ├── sessions.js（L2）
   ├── chats.js（L3）
   ├── usage.js（L4）
   ├── memory.js（L5）
   ├── skills.js（L6）
   ├── plugins.js（L7）
   └── settings.js + settings-sections.js（L8）
```

**契约已冻结（见 §三），故 L1–L8 全可并发**：L2–L8 按 §三 写，不 import `_shell.js`，运行时只读 `window.__ui`。L1 的责任是收线时保证 `_shell.js` 真提供那套签名——任一块发现签名不够用，报主干改契约，不自行扩展。
L2–L8 之间**无相互依赖**，可全并发。
