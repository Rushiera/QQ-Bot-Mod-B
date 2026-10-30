// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
// ── 多实例 PROFILE ─────────────────────────────────────────────────────
// QQ_AGENT_PROFILE=2 时数据目录变成 data-2/、端口整体 +100，
// 这样同一台机器可以跑两个机器人实例（两个 QQ 号）而不互相踩。
// 优先级：QQ_AGENT_DATA_DIR（显式覆盖）> PROFILE 推导 > 默认 data/
//
// ⚠️ 必须在这里就生效（而不是在 UI 或 app.js 里改）：
//   DATA_DIR 是整个进程的根路径，配置、会话、记忆、表情库全挂在它下面。
//   晚一步设置就会有一部分文件写到主实例的目录里，造成两个实例数据互相污染。
import { profileSuffix, portOffset } from './profile.js';

// 2026-09-19 起 https：http 版 301 跳转且明文传输可被 MITM 篡改成本展示。
// 证书与内容已实测可达（同一路径，nginx 直接 200）。
export const FIXED_PRICE_REMOTE_URL = 'https://kondius.cn/qq-agent/model-prices.json';
// ── 数据根（D4 钉死·归位后必须显式注入）────────────────────────────────────
// 归位后 __dirname = app/src/business，ROOT 解析出的是**单体源码目录**，不是业务面数据根。
// config.json / sessions / memory / downloads 全挂在数据根下，由接线层用
// QQ_AGENT_DATA_DIR 注入（本支实际值 = QQBotB 的 _unpack/data，见 reports/R2-L1.md §三-6）。
// 未注入即报错退出：回落源码目录会让「读不到历史」伪装成「没有历史」（静默失败，不采用）。
// 本地调试确需默认值时显式置 QQ_AGENT_DATA_DIR_ALLOW_DEFAULT=1。
export const DATA_DIR = (() => {
  const injected = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (injected) return path.resolve(injected);
  if (process.env.QQ_AGENT_DATA_DIR_ALLOW_DEFAULT === '1') return path.join(ROOT, `data${profileSuffix()}`);
  throw new Error('业务面数据根未注入：必须设置 QQ_AGENT_DATA_DIR（见 app/src/business/config.js 数据根注释）');
})();
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    // 备选模型列表：主模型在重试后仍失败时，逐个用备选模型重试直至成功。
    // 每项 { model, provider? }：provider 留空则沿用主模型的 provider/baseUrl/apiKey；
    // 填了 provider 则切到该提供商（用它的 baseUrl + Key）。按顺序尝试。
    fallbackModels: [],
    // 按输入类型分开选择模型（可选）：留空则都用上方主模型 api.model。
    // 图片/视频输入需要模型支持对应模态；文字输入用纯文本模型即可（可省成本）。
    // ⚠️ 这两个字段现在是**真的会被使用**的：llm.js 检测到请求里带图片/视频部分时，
    //    会用对应字段的模型替换主模型（仅主调用路径；记忆整理/备选模型降级不受影响）。
    //    此前它们只是存下来给 UI 看，没有任何代码读取 —— 填了不起作用。
    visionModel: '',            // 图片输入专用模型（留空 = 用主模型）
    videoModel: '',             // 视频输入专用模型（留空 = 用主模型）
    // 视频走哪条路。两条路**互斥**，不会同时喂 ——
    // 同时喂等于同一内容重复计费，而且多数网关会因格式冲突直接 400。
    //   auto   配了 videoModel 就认为你有全模态模型 → 原生读视频；否则抽帧；
    //          抽帧 Skill 不可用（没装 ffmpeg）就只给元信息
    //   native 强制原生视频输入（把视频地址作为 video 部分发给模型）
    //   frames 强制抽帧（把视频变成若干张图片，任何视觉模型都能用）
    //   off    不喂画面，只给时长/分辨率等元信息（纯文本模型 / 省 token）
    videoMode: 'auto',
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 视频输入（模型能不能吃 video 部分）。与 vision 相互独立：
    //   勾了 vision + video → 有人发 GIF 动图时，用 ffmpeg 转成 ≤480px / ≤24 帧的
    //                        mp4，按 video 部件发给模型（llm.js 自动切 videoModel）
    //   勾了 vision 没勾 video → GIF 按图片原样发（部分视觉模型能直接读动图）
    //   没勾 vision → 看图工具整个不存在，GIF 自然也看不到
    // 默认关闭：猜错"模型支持视频"的代价是请求 400，比不启用更糟（同 videoModel 的口径）。
    video: false,
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 思考强度（实际落成各厂商参数由 src/thinking.js 内置方言表负责）：
    //   thinkingEffort off/low/medium/high/xhigh/max —— off=能思考的模型也明确关闭，
    //     其余档位=开启且强度递增（渠道不支持高档时向下就近映射）
    //   thinkingMode  off/auto/on（旧三态，effort 为空时的兼容口径）
    //   thinkingBudget token 数 —— 思考预算，仅 Claude 兼容 / 部分网关生效，0=不指定
    // 目的：防"雷霆大思考"（几千 token 的 reasoning 拖慢且烧钱）或该思考的完全不思考。
    thinkingMode: 'auto',
    thinkingEffort: '',
    // thinkingBudget（思考预算 token 数）有真实读点：src/thinking.js
    // 在 Claude 兼容/部分网关方言下把它落成预算参数。没有 UI 入口（有意为之：
    // 绝大多数渠道不认这个参数），需要时手改 config.json 即可生效。
    thinkingBudget: 0,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表地址由 src/community.js 固定为官网公开表（FIXED_PRICE_FEED_URL），
    // 任何代码都不得再读/写 api.priceRemoteUrl —— 它是已废弃的历史字段，
    // loadConfig 时统一剔除（见 stripObsoleteFields），避免磁盘旧值继续冒充"生效地址"。
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  // providersImported（导入来源标记）与 budget 容器是历史残留死字段（零读点），
  // loadConfig 时由 stripObsoleteFields 一并剔除。
  // 网页资产下载（web-fetch / web-fetch-jobs）—— [qqagent-cattools-patch:config-webfetch]
  // downloadsDir：产物落点（绝对路径；留空 = 自动探测受控根 Downloads，再回落用户下载目录）。
  webFetch: {
    downloadsDir: '',
    // allowPrivateHosts：内网地址例外（仅本地测试 / 自建服务）—— [qqagent-cattools-patch:config-webfetch-priv]
    allowPrivateHosts: false
  },
  // 联网搜索（网页解析通道，无需 API Key）：'baidu'（默认）| 'bing' —— [qqagent-search-patch:config-websearch]
  webSearch: {
    enabled: true,
    provider: 'baidu',
    maxResults: 6,
    // baidu：百度结果页解析（https://www.baidu.com/s?wd=…）
    baidu: { searchUrl: 'https://www.baidu.com/s' },
    // bing：Bing 结果页解析（b_algo 块）
    searchUrl: 'https://cn.bing.com/search',
    // 自定义搜索提供商列表（保留配置容器；搜索实现层已精简，选中会明确报「未知的搜索提供方」）
    providers: [],
    custom: {
      name: '',
      type: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    // ── 浏览锁定 ──
    // ── 浏览锁定 ──
    // 把"机器人能访问哪些域名"收成白名单。开启后 fetch 与发图**逐跳**校验
    // （含重定向目标），不在清单内一律拒绝。
    browseLock: {
      enabled: false,
      hosts: [],                  // 允许的域名，如 ['zh.wikipedia.org', 'example.com']（支持子域）
      siteSearchUrl: ''           // 站内搜索模板，如 'https://example.com/search?q={query}'
    }
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    // 第二实例默认连自己的 OneBot 端口（3001/3000 + 偏移），
    // 否则两个实例会同时连到主实例的 SnowLuma，消息被处理两遍。
    wsUrl: `ws://127.0.0.1:${3001 + portOffset()}`,
    httpUrl: `http://127.0.0.1:${3000 + portOffset()}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 系统提示词覆盖（可选）：非空时**整体替换** buildSystemPrompt 的默认行为准则。
    // ⚠️ 高级功能：默认提示词包含安全规则/工具协议/反AI味等关键约束，
    //    覆盖后这些全部失效，需自行在覆盖文本里写明。留空 = 用内置默认提示词。
    // 可用占位符：{botName} {roleText} {participation}
    systemPromptOverride: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 按会话独立人设：{ [群号/QQ号]: { roleText, participation, customRules, systemPromptOverride } }
  // key 是白名单会话的 id（群号或私聊 QQ 号），值是该会话覆盖全局 persona 的字段；
  // 只覆盖写在这里的字段，其余（botName/selfNickname 等账号身份）永远用全局值 ——
  // 名字换了会和 @ 判定、存档里"我"的称呼对不上。
  personaByChat: {},
  // 统一人设（人设页开关）：true = 所有用一套全局人设；false = 人设页展示分会话
  // 独立编辑入口（personaByChat 生效）。运行语义与 UI 一致（personaForChat 在
  // 统一模式下不读 personaByChat）—— 否则统一开关形同虚设：旧分会话条目会
  // 继续静默覆盖全局人设，而 UI 已把编辑入口藏起来了。
  personaUnified: true,
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 会话级自动重试：整轮运行失败且一条消息都没发出时，自动从头再来几次。
  // 0 = 关闭自动重试（失败会话仍可在会话页手动点「重试」）。
  // ⚠️ 已发出过消息的会话绝不自动重试 —— 重试会导致群里看到两遍同样的话。
  sessionRetryAttempts: 2,
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    // 发送去重窗口（毫秒）：同一会话在该窗口内完全相同的文本只发一次。
    // 防"模型重复调用 send_message / OneBot 超时看似失败但实际已发出、上层重试再发"导致的重复发言。
    // 0 = 关闭去重。默认 8000（8 秒）。
    dedupeWindowMs: 8000
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 活跃模式（chatActive）：1/2/3 档被召唤触发响应后，模型若认为话题值得持续参与，
  // 会在 finish 时带回话题总结 → 该群进入"活跃期"：忽略档位判定必响应，
  // 提示词注入话题锚点，模型每次自判"是否仍在话题上"，偏离则 finish("话题结束") 退出。
  // 让"开始活跃"容易、"停下"由模型自主判断 —— 恰好是档位系统的反向补充。
  chatActive: {
    enabled: false,
    ttlMinutes: 30   // 活跃期最长持续时间（分钟）：到期自动退出，兜住"模型忘了结束"
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定哪些消息会触发响应）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定是否响应。
    // 2026-09-25 改版：档位不再决定读取条数 —— 各档统一读 historyCount 条，
    // 档位退化为纯粹的"触发方式开关"（被艾特/关键词/随机/全部）。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全响应
    historyCount: 80,           // 各档统一：响应时随【已读信息】带多少条历史
    keywords: [],               // 2 档的关键词表
    randomPercent: 10,          // 3 档：y% 概率
    // ── 提示词锚点（前缀缓存深化，2026-09-25）──
    // 连续触发时，把上一轮发给模型的【记忆】+【已读信息】前缀**原样复用**：
    // 本轮只在其后追加新沉淀的已读条目（"新已读信息"），新增群友的印象放到
    // 未读信息之后的【新加入成员】段 —— 除追加部分外前缀字节不变，命中缓存。
    // 追加条数超过 maxExtraRead 就整体重置（回到标准窗口，重新开始锚定）：
    // 已读信息是按条计费的，无限追加会"为了省钱花更多钱"。
    promptAnchor: {
      enabled: true,
      maxExtraRead: 5           // 相对锚定时的已读条数，最多额外追加几条
    },
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    // 分群峰谷（2026-09-18 四象限改版）：unifiedTier=false 且 peakSchedule.enabled 时，
    // 每个群可以有自己的峰谷档位 { [群号]: { peak: 0~100, valley: 0~100 } }。
    // 时段（start/end）全局共享 —— 每群分开拖两个点的档位值即可。
    groupPeakPos: {},           // { [群号]: { peak: 0~100, valley: 0~100 } }，未设置的群跟随全局峰谷双点
    keepSessionFiles: 0,        // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
    // ── 峰谷切换（按时段自动调整响应档位）──
    // 允许用户设定"高峰/低谷"两个时段及各自生效的响应档位（滑条位置 0~100）。
    // 例如：白天上班时间（高峰）设为 1 档仅艾特省 token，晚上（低谷）设为 4 档全响应。
    // 命中某时段时用该时段的档位覆盖全局滑条；都不命中用全局滑条。
    peakSchedule: {
      enabled: false,           // 总开关
      // 高峰时段：start~end（"HH:MM"，跨零点也支持，如 22:00~06:00）
      peak: { start: '09:00', end: '18:00', sliderPos: 10 },   // 高峰档位（默认 1 档仅艾特）
      // 低谷档位（默认 4 档全响应）。**只认 sliderPos**：时段语义是
      // "高峰窗口外一律 = 低谷"（peakWindowActive 只读 peak.start/end），
      // valley.start/end 是旧版死字段，loadConfig 时剔除。
      valley: { sliderPos: 100 }
    }
  },
  // ── 会话生命周期（收工轮 / 上下文轮转，2026-10-09）── [qqagent-session-patch:config-session]
  // enabled=false 时完全回到旧行为（无状态：已读窗口只带 store.historyCount 条）。
  // maxContextTokens：上下文估算（上轮 promptTokens + 本批字符/1.5）超过它就起收工轮
  // —— 收工轮沉淀要点 → 归档当前存档 → 开新会话。与模型窗口解耦：窗口变了只改这里。
  session: {
    enabled: true,
    maxContextTokens: 300000,
    // ── 已读信息分段摘要（B22，2026-10-18）──
    // readMaxChars：详细已读窗口的字符预算；超过就把最旧的一段压成【前情提要】。
    // 0 = 关闭（完全回到"会话全量"）。readKeepChars：压缩后保留的详细字符数。
    // readCompactChunkChars：单次摘要调用最多吃多少字符（分块）。
    // readDigestMaxChars：【前情提要】注入总字符上限。
    // [qqagent-readcompact-patch:config]
    readMaxChars: 60000,
    readKeepChars: 40000,
    readCompactChunkChars: 50000,
    readDigestMaxChars: 8000,
    // 摘要用模型：主模型（如 hy4-preview-f）是推理模型，纯文本压缩请求会被推理链
    // 吃光 max_tokens 导致 content 恒空（2026-10-18 实测：3000 token 全进 reasoning）。
    // 必须选快档；空 = 跟随记忆整理模型（memory.useChatModel）。
    // [qqagent-readcompact-patch:config-summary-model]
    readSummaryModel: 'deepseek-v4.1-flash',
    readSummaryMaxTokens: 4000
  },
  // ── 缓存观测采集（2026-10-26）── [qqbotb-cachemetrics:config]
  // 每次 LLM 调用落一行到 data/metrics/cache-<YYYY-MM-DD>.jsonl：
  //   共享前缀指纹 + 距上次发送同样前缀多少秒（TTL 自然实验的主判据）、
  //   逐段指纹（定位分叉点）、命中 token / prompt token。
  // 纯旁路：写失败静默，绝不影响运行。enabled=false 立即停采。
  cacheMetrics: {
    enabled: true,
    keepDays: 30
  },
  // ── 卡死看门狗（2026-10-10）── [qqagent-engage-patch:config-stall]
  // 上游端点卡住时（请求挂起 / 流式中途不动），一轮运行可能长时间既不中止也不发言。
  // 看门狗定期扫运行中的会话：超过 timeoutMs 没有活动 → 中止在途请求 + 把本轮未读
  // 恢复为未读 + 3 秒后重排（消息不丢，等上游恢复后重新思考）。
  // 判据用 max(startedAt, updatedAt) —— 只要会话还在推进就不算卡死。
  // 与 api.timeoutMs（单次请求超时）互补：那个管一次请求，这个管整轮运行。
  stall: {
    enabled: true,
    timeoutMs: 150000,
    checkIntervalMs: 20000
  },
  // ── 群内自主参与（2026-10-09）── [qqagent-engage-patch:config-engage]
  // quota：滑动窗口内的发言条数上限 —— 发言节制（区别于 send.maxPerMinute 的防封号限频）。
  //   超限时发送被拒，错误回给模型（模型据此沉默）；提示词里同步告知余量。
  //   enabled=false 完全回到旧行为。
  // topicWords：收工轮自产的本群话题词 —— 只进【记忆】段当参考，不做触发门。
  engage: {
    quota: { enabled: true, windowMs: 120000, maxPerWindow: 5 },
    topicWords: { enabled: true },
    // ── 浏览节拍（2026-10-10）── [qqagent-browse-patch:config-browse]
    // 语义：不再"每条消息立刻进 LLM"，而是按节拍浏览群内容 —— 到点看一次该群未读，
    //   有新增才调 LLM，一次把这段时间的全部内容交给模型（含图片/媒体，工具该读的读），
    //   由模型自己决定接不接。从根本上避开"有人说话就要接"的尬聊。
    //   @ / 拍一拍 立即触发（atMeImmediate）；私聊不走节拍（privateImmediate）。
    //   levels：档位表（毫秒），索引 0 = 基础档；模型可用 set_browse_rate 升档。
    //   holdMs：升档有效期 —— 期间该群有成功发言即顺延，到期自动降一档。
    //     （不用"群里静默"做回落信号：热群里消息停不下来，静默永不触发。）
    //   sweepMs：巡检粒度（一个定时器扫全部群，档位变化即时生效）。
    //   enabled=false → 完全回到旧行为（逐条判定 + 立即触发）。
    browse: {
      enabled: true,
      levels: [240000, 120000, 60000],
      holdMs: 900000,
      atMeImmediate: true,
      privateImmediate: true,
      sweepMs: 5000,
      // ── 静默补拍（2026-10-11）── [qqagent-browse-patch:config-browse-idle]
      // 语义：有未读、且最后一条未读已静默 idleMs（默认 60 秒）没人接话 → 也看一次。
      //   话头停下来了正是能接的时候，不必等满一拍；同一批只补一拍（有新消息才重置）。
      //   同样不要求模型必须回复 —— 看完不回是正常结束。
      //   0 / false = 关闭（只按节拍到点看）。
      idleMs: 60000
    },
    // ── bot 指定限频（2026-10-10）── [qqagent-botguard-patch:config-botguard]
    // members：被指定为机器人的群友 QQ 号（记忆页「🤖 bot」开关写这里）。
    //   对这些群友的回复强制限频：windowMs 内最多 maxPerWindow 条 —— 抑制
    //   "两个机器人互相刷屏"。判定在**出站口**：本轮回复对象（或显式 @ / 拍的目标）
    //   落在名单里、且额度已满 → 发送被拒（错误回给模型）。
    //   **不影响送 LLM 思考**：模型照常跑完整轮，只是发不出去。
    //   enabled=false 完全关闭（成员名单保留，下次打开即恢复）。
    botGuard: {
      enabled: true,
      windowMs: 240000,
      maxPerWindow: 1,
      members: []
    },
    // ── 回应参数（2026-10-18）── [qqagent-rapport-patch:config-rapport]
    // 每个群友一个 0~100 的"回应意愿分"，初始 100。分数低 = 这个人现在不太想跟你聊。
    //   映射：0 分 → 对 TA 的回复最快每 maxCooldownMs（默认 20 分钟，即 1200000ms）1 条；
    //         100 分 → 不额外限速。线性：50 分约 10 分钟，90 分约 2 分钟。
    //   判定归模型（工具 adjust_rapport + 系统提示教程）；这里只管硬限速与自愈。
    //   healPerTick / healIntervalMs：自愈——每隔 healIntervalMs 给所有不足 100 的
    //         群友加 healPerTick 分（纯本地定时器，不调 LLM）。
    //   enabled=false 完全关闭（分数保留，下次打开即恢复）。
    rapport: {
      enabled: true,
      maxCooldownMs: 1200000,
      healPerTick: 2,
      healIntervalMs: 300000,
      // 客观结算（[qqagent-rapport-patch:config-watch] · 2026-10-19）——
      // 宿主侧看"我发了话，下一批有没有人 @ / 引用 / 拍我"：没人接就自动降 missDelta 分，
      // 有人接就加 hitDelta 分。模型手调（adjust_rapport）与自愈照常。
      //   exemptUsers：不做客观结算的 QQ（默认主人 569145850——他 @ 是点名，
      //   不回不代表不想聊，可能是忙 / 在测试；与「VIP 不受配额与硬限约束」同口径）。
      //   enabled=false 只关客观结算。
      watch: {
        enabled: true,
        missDelta: 12,
        hitDelta: 6,
        exemptUsers: ['569145850']
      }
    },
    // ── 发言硬限制（2026-10-10）── [qqagent-hardlimit-patch:config-hardlimit]
    // 出站口的兜底闸：每 windowMs 最多 maxPerWindow 条（默认 60 秒 1 条）。
    //   与 quota 分开 —— quota 是"说多少"的可调业务闸，这里是"多久能开口"的硬下限，
    //   调 quota 不会放宽它。超限的发送被拒（错误回给模型，模型据此安静结束）。
    //   提示词【发言配额】段的余量取两道闸的更严者。
    //   enabled=false 完全关闭。
    hardLimit: {
      enabled: true,
      windowMs: 60000,
      maxPerWindow: 1
    },
    // ── 安静模式（2026-10-16）── [qqagent-quiet-patch:config-quiet]
    // chats：处于安静模式的群号清单（记忆页「🤫 安静」开关写这里）。
    //   安静群"能不发言就不发言"：不参与闲聊，只有被 @ / 拍一拍 才回应；
    //   每 intervalMs（默认 6 小时）跑一次"只整理不发言"的记忆沉淀轮。
    //   存档与记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
    //   enabled=false 完全关闭（群清单保留，下次打开即恢复）。
    quiet: {
      enabled: true,
      chats: [],
      intervalMs: 21600000,
      organizeOnly: true
    },
    // ── 发言档位（2026-10-25）── [qqagent-level-patch:config-levels]
    // 按群的"爱说多少"五档。档位只调**参与率**（这一拍到点有未读时要不要进 LLM）
    // 与"没人接话"的降分上限；**发言配额 5/2min 与浏览节拍表 240/120/60 秒不由档位改动**。
    //   rate：入场概率（0 = 非 @ 不进，1 = 全入场）
    //   missCap：回应参数"没人接话"单次最多降多少分（0 = 只采集不降分）
    //   organizeOnly：到点走"只整理不发言"的沉淀轮（安静模式语义）
    // levelByChat：{ [群号]: 1~5 }；未指定的群默认 3（标准档）。
    //   冰封档也可以用老的 engage.quiet.chats 指定（启动即映射，不清空）。
    levels: [
      { name: '冰封', rate: 0, missCap: 0, organizeOnly: true },
      { name: '保守', rate: 0.25, missCap: 0, organizeOnly: false },
      { name: '标准', rate: 0.6, missCap: 0, organizeOnly: false },
      { name: '活跃', rate: 0.85, missCap: 0, organizeOnly: false },
      { name: '全开', rate: 1, missCap: 0, organizeOnly: false }
    ],
    levelByChat: {},
    // 客观信号（发言占比 / 被点名率 / 提问密度 / 时段 / 日成本 / 连续未接）
    // enabled=false → 只采集不参与判定（默认）。启用后做乘法修正，下限 floor。
    signals: { enabled: false, floor: 0.15 },
    // ── 余额后缀（2026-10-25）── [qqbotb-balance:config]
    // 按群把本号的**群名片**尾部刷成「@余额xx.xx」，每 intervalMs 刷一次（默认 30 分钟）。
    //   chats：开了后缀的群号清单（记忆页「💰 余额」开关写这里）；空 = 全关（默认不开）。
    //   value：当前余额——先由人工输入（记忆页输入框；两位小数，只接受 0 及以上）。
    //   source / endpoint / field：**映射接口占位**——现在只认 'manual'（用 value）；
    //     将来接自动余额来源时，在 src/balance.js 的 resolveBalance() 里加分派即可，
    //     配置形状不用再改（endpoint / field 就是给它预留的）。
    //   marker：后缀前缀（拼成 marker + 两位小数）；同时是**剥旧值**的锚——
    //     刷新前先剥掉尾部已存在的 marker+数字，保证重复刷不会叠成
    //     「@余额12.00@余额13.00」。
    //   intervalMs：刷新间隔；宿主启动即刷一次，之后按此周期（改值后可手动立即刷新）。
    balance: {
      value: 0,
      chats: [],
      source: 'manual',
      endpoint: '',
      field: 'balance',
      marker: '@余额',
      intervalMs: 1800000
    },
    // ── 群语音伴随（2026-10-25）── [qqbotb-voicereply:config]
    // 按群把本号的**文字发言**再用 TTS 念一遍发回群（日語口语表达 · IrodoriTTS）。
    //   enabled：总开关（false = 清单保留但全不念）
    //   chats：开了语音的群号清单（记忆页「🔊 语音伴随」开关写这里）；空 = 全关（默认）
    //   runMode：固定档位——small = 依田芳乃 · v4.1-Small（写在 ComfyDock 的 RunMode 字段）
    //   maxChars：单句上限（**中文原句**字数）——合成器单次上限 30 秒，日语实测 3.5 字/秒
    //            （59 日语字 = 16.88 秒），故 30 秒 ≈ 100 个日语字符。中文译成日语后
    //            字符数略增（口语化会加假名 / 助词），取 60 个中文字 ≈ 80 上下日语字 ≈ 23 秒，
    //            留足停顿与语速波动余量。超出按句末标点切，不硬切。
    //   caption：风格描述（空 = 不用；中文会一并翻日语）
    // 语义：本号每发出一条群文字，就把它交给自研单体 → ComfyDock → 音频自动回群；
    //      那条文字我们自己已经发过，所以走 auto（单体不再补发文字配文）。
    voiceReply: {
      enabled: true,
      chats: [],
      runMode: 'small',
      maxChars: 60,
      caption: ''
    }
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 全局屏蔽名单（"上云"）：[QQ号, ...]
  // 与 blocklist 的区别：blocklist 是按群单独屏蔽；globalBlocklist 对**所有群**生效——
  // 一旦某人被加进来，他在任何群里的消息都会被丢弃（含私聊）。
  // 用于"这个人在所有群里都不该再被机器人看到"的场景（如骚扰者、广告号）。
  globalBlocklist: [],
  // 本机豁免名单：无管理密钥时"本机解除全局屏蔽"的持久化记录。
  // 云端名单仍含这些 id（移除需要密钥），但本机用 getGlobalBlocklist() 时扣除它们。
  // 独立字段 —— 5 分钟一次的云端同步会整体覆盖 globalBlocklist，但不会碰这里。
  communityExemptions: [],
  // 指令禁言：群内任何人 @机器人 并发送指定指令后，机器人暂时把响应档位固定为 1 档（仅艾特）。
  // 用于群里太吵时让机器人"闭嘴"，只回应被直接点名。
  commandMute: {
    enabled: true,              // 总开关
    command: '/安静',            // 触发指令（需与 @机器人 同条消息）
    durationMin: 30,            // 禁言时长（分钟），0 = 直到手动解除
    // 运行态（不在 UI 编辑）：{ [群号]: 禁言到期时间戳 }
    active: {}
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    // 记忆不节流（2026-10-16 Rushiera 定）：「写的多不是坏事，但要能归档能索引」
    // ——条数放开、超出的转归档；冷却缩短；发现面放宽。
    // [qqagent-memory-patch:no-throttle-defaults]
    consolidateMinIntervalMs: 10800000,  // 整理冷却 3 小时（原 6 小时）
    sedimentIntervalMs: 43200000,         // 记忆沉淀拍间隔（12 小时；0 = 关闭）
    maxImpressionsPerMember: 40,          // 重整提示词的条数上限（原 8）
    maxGroupEntries: 60,                  // 群记重整上限（原 20；现行池软上限在 group-memory.js）
    discoverMinMessages: 3,               // 整理轮"发现新人"的最低发言条数（原 5）
    discoverMaxMembers: 10,               // 单次整理最多发现几位新人（原 6）
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: ''                             // 专用模型 id（useChatModel=false 时生效）
  },
  // 工具与技能（skill 化开关）
  //
  // ⚠️ 边界（避免"两个开关打架"）：
  //   tools.*  = **工具**层的开关：全局 / 分类 / 单个工具
  //   skills.* = **能力**层的开关：每个 Skill 一个命名空间
  // 最终"能不能用"由 tool-registry.getToolAvailability() 统一计算，
  // 顺序是：tools.enabled → skill 生效 → requires 能力 → 分类 → 单工具 → 运行期依赖。
  // 模块不允许再写自己的 isXxxEnabled 影子开关。
  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    // 受控根只读文件面（read_file / list_dir）—— [qqagent-fileread-patch:config-file-read]
    // 根 id / 寻址 / 越界拒绝与 CH4 受控根同口径；默认给 workspace + ccbp
    // （与 CH4 猫的 enabledRoots 一致）。要放开更多根，往 roots 里加 { id, path }。
    fileRead: {
      roots: [
        { id: 'workspace', path: path.resolve(ROOT, '..', '..', '..', '..') },
        { id: 'ccbp', path: path.resolve(ROOT, '..', '..', '..', '..', '..', 'CatCatBigParty') }
      ],
      maxBytes: 2097152,
      maxCharsPerRead: 60000
    },
    overrides: {},              // { [toolId]: boolean } 单个工具的启用状态
    // 跨会话发送（默认关）：开启后 send_message 支持 targetChatKey，
    // 允许模型按用户指示把消息发到白名单内的其它群/私聊。
    // 这是社交敏感操作（可能被诱导去骚扰别的会话），所以默认只允许当前会话。
    crossChatSend: false,
    // 看图（image-inject）本地取图根 —— [qqagent-cattools-patch:config-imageinject]
    // 默认只允许数据目录与系统临时目录（写死的两条基线）；要放开别的目录就往 roots 里加绝对路径。
    imageInject: {
      roots: []
    },
    categories: {
      messaging: true,          // 消息发送
      sticker: true,            // 表情管理
      query: true,              // 消息查询
      memory: true,             // 记忆系统
      web: true,                // 联网搜索
      knowledge: true,          // 知识库
      media: true,              // 媒体理解
      system: true              // 系统反馈
    }
  },
  // ── 浏览器（browser-* 工具）—— [qqagent-cattools-patch:config-browser] ──
  // 内核：Chromium 系（Edge / Chrome / Brave）headless + 裸 CDP；留空 = 按常见安装路径自动探测。
  // 换内核只改这里（Chromium 系协议同为 CDP，无协议分支）。
  browser: {
    kernelPath: '',
    // 浏览器数据目录（profile / 截图 / 落盘正文）—— [qqagent-cattools-patch:config-browser-datadir]
    // 🔴 必须落 NTFS：exFAT 卷上 Chromium 的 user-data-dir 起不来（CDP 连接 20s+，导航全挂）。
    //    留空 = 默认 %LOCALAPPDATA%/QQAgent/browser。
    dataDir: ''
  },
  // Skill 统一开关：唯一的"能力启停"来源。
  // 形状：{ [skillId]: { enabled: boolean, ...该 Skill 自己的设置 } }
  // 这里只存用户改过的值；默认值来自各 Skill 的 skill.json → settings。
  skills: {},
  // 扩展热重载：把自定义的插件/skill 目录放进 plugins/ 或 skills/ 后**自动生效**，无需重启。
  // 默认开 —— 这正是"放进去就能用"的体验来源。
  // ⚠️ 安全含义：等价于"任意落地的 JS 会被执行"。共享机器 / 只跑固定版本时建议关掉。
  extensions: {
    hotReload: true
  },
  // 桌面端/控制台
  server: {
    // 端口：QQ_AGENT_PORT 显式覆盖 > 默认 3210 + PROFILE 偏移
    // （第二实例整体 +100，避免和主实例撞端口）
    port: Number(process.env.QQ_AGENT_PORT) || (3210 + portOffset()),
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

/** 深合并（含 __replace__ 整体替换约定）。导出供 routes.js 的预览端点做"不落盘的临时合并"。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return deepMerge(DEFAULT_CONFIG, stripObsoleteFields(migrateLegacySkills(parsed)));
  } catch (error) {
    // ⚠️ 配置文件坏了（手改错/磁盘故障）不能静默回落默认值：
    //   曾经直接返回 DEFAULT，随后任何 updateConfig（比如 5 分钟一次的
    //   云端屏蔽名单同步）都会以默认配置为底整体写回 config.json ——
    //   用户的 Key/白名单/人设被静默抹成出厂值。
    //   现在先把坏文件改名备份（原始数据可手工抢救），再回落默认，
    //   并打 error 日志提醒用户。
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${stamp}`);
        console.error(`[config] 配置文件解析失败（${String(error?.message ?? error)}），` +
          `已备份为 config.json.corrupt-${stamp}，本次以默认配置启动。` +
          `请尽快从备份抢救配置，否则下次保存会覆盖全量配置！`);
      }
    } catch (backupError) {
      console.error('[config] 配置文件解析失败且备份失败：', backupError);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * 旧配置迁移：把历史上散落在各处的"能力开关"收拢进 config.skills。
 *
 * 为什么必须做：社区版/旧版把同一件事的开关放在 api.thinking、tools.knowledgeEnabled
 * 之类的字段里，而新架构只认 config.skills[id].enabled。若不迁移，
 * 用户升级后会出现"UI 显示已开启、实际 Skill 判定为关闭"——正是要消灭的冲突。
 *
 * 规则（表驱动，新增迁移只需加一行）：
 *   旧字段路径 → Skill id，可选值映射函数
 * 迁移是幂等的：只有在 skills[id] 尚未存在时才写入，不会覆盖用户新配置。
 */
const LEGACY_SKILL_MIGRATIONS = [
  // ⚠️ skill 名字必须与 skills/ 或 plugins/ 下的**目录名**完全一致，
  //    目标不存在时迁移会跳过并记日志（migrateLegacySkills 内有校验）。
  // 社区版的思考开关已收编进核心（src/thinking.js），不再迁往任何 Skill：
  // api.thinking: true → thinkingMode 'on'，false → 'off'，由下方专段处理。
  // 旧知识库开关（知识库技能尚未移植，先留位；目标不存在时迁移会跳过并记日志）
  { from: ['tools', 'knowledgeEnabled'], skill: 'knowledge-base', map: (v) => ({ enabled: v !== false }) },
  // 旧视频理解开关
  { from: ['tools', 'videoEnabled'], skill: 'video-frames', map: (v) => ({ enabled: v !== false }) },
  // 旧表情标注开关
  { from: ['tools', 'stickerAnnotate'], skill: 'sticker-annotate', map: (v) => ({ enabled: v !== false }) }
];

export function migrateLegacySkills(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  out.skills = (out.skills && typeof out.skills === 'object' && !Array.isArray(out.skills)) ? { ...out.skills } : {};

  // 社区版的思考开关（api.thinking: boolean）：思考已收编进核心（src/thinking.js），
  // 旧值映射成 thinkingMode（true=on / false=off），不再迁往任何 Skill 命名空间。
  if (out.api && typeof out.api === 'object' && !Array.isArray(out.api) && 'thinking' in out.api) {
    const legacyThinking = out.api.thinking;
    if (out.api.thinkingMode === undefined) {
      out.api = { ...out.api, thinkingMode: legacyThinking === false ? 'off' : 'on' };
    }
    const nextApi = { ...out.api };
    delete nextApi.thinking;
    out.api = nextApi;
  }

  for (const rule of LEGACY_SKILL_MIGRATIONS) {
    const [parent, key] = rule.from;
    const container = out[parent];
    if (!container || typeof container !== 'object') continue;
    if (!(key in container)) continue;
    const legacyValue = container[key];
    // 已有新配置就不动（用户可能已经在新 UI 里改过）
    if (!(rule.skill in out.skills)) {
      out.skills[rule.skill] = { ...rule.map(legacyValue) };
    }
    // 清掉旧字段，避免下次启动重复迁移、也避免模块继续读到旧值
    const nextContainer = { ...container };
    delete nextContainer[key];
    out[parent] = nextContainer;
  }
  return out;
}

/**
 * 剔除**废弃字段**（磁盘/回传 patch 都可能带着的历史残留）。
 * 这些字段已无任何读点，留着只会冒充"生效配置"继续漂移：
 *   · api.stream          —— llm.js 请求体硬编码 stream:false（无 UI、无读点）
 *   · api.priceRemoteUrl  —— 远程价格表地址固定为 src/community.js 的常量
 *   · budget（容器整体）  —— 预算保险丝功能已移除，容器本身也无读点
 *   · store.peakSchedule.valley.start/end —— "高峰外=低谷"语义下无人读
 *     （peakSchedule.valley.sliderPos 保留，peakSchedule.custom.valley 同口径只留 sliderPos）
 *   · providersImported   —— 导入来源标记，零读点
 * 与 stripDerivedFlags 一样在 loadConfig / updateConfig 时调用，删旧键不碰活键。
 */
const OBSOLETE_PATHS = [
  ['api', 'stream'],
  ['api', 'priceRemoteUrl'],
  ['budget'],
  ['providersImported'],
  // 2026-09-25 档位改版：四个分档条数字段废弃，统一为 store.historyCount。
  // 老配置里的存量值会在 loadConfig 时被剔除（读条数走 historyCount / allCount 迁移兜底）。
  ['store', 'atCount'],
  ['store', 'keywordCount'],
  ['store', 'randomCount'],
  ['store', 'allCount'],
  ['store', 'peakSchedule', 'valley', 'start'],
  ['store', 'peakSchedule', 'valley', 'end'],
  ['store', 'peakSchedule', 'custom', 'valley', 'start'],
  ['store', 'peakSchedule', 'custom', 'valley', 'end']
];

export function stripObsoleteFields(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  for (const path of OBSOLETE_PATHS) {
    let cur = node;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cur?.[path[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { ok = false; break; }
      cur = next;
    }
    if (ok && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete cur[path[path.length - 1]];
    }
  }
  return node;
}

let currentConfig = null;

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 剔除**派生标记**：GET /api/config 的脱敏层会生成 hasXxx / dshProviderKeyPresence
 * 这类"只表示存在性"的字段。前端把它们当成配置的一部分回传时，
 * deepMerge 会把它们真的写进 config.json —— 于是配置文件里混进了派生数据，
 * 且会随密钥增删变得与实际不一致（清了 Key 但 hasKey 仍是 true）。
 */
function stripDerivedFlags(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripDerivedFlags(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    // hasApiKey / hasKey / hasAccessToken / hasHttpAccessToken …
    // 只匹配 camelCase 的 has+大写开头，避免误删用户自定义的普通字段。
    if (/^has[A-Z][A-Za-z0-9]*$/.test(key)) { delete node[key]; continue; }
    if (key === 'dshProviderKeyPresence') { delete node[key]; continue; }
    stripDerivedFlags(node[key]);
  }
  return node;
}

/**
 * 数组型密钥容器的脱敏回传保留：patch 里按 id 匹配的条目若**缺少**密钥字段，
 * 从现配置同 id 条目回填 —— 前端脱敏视图回传时密钥天然不在场，不回填就会
 * 在"数组整体替换"的合并语义下静默清空。显式传空串（''）= 真清除，不回填。
 * 目前只有 webSearch.providers 一处数组密钥容器；新增容器时往数组里加路径即可。
 */
function preserveSanitizedSecrets(current, patch) {
  try {
    const cur = current?.webSearch?.providers;
    const next = patch?.webSearch?.providers;
    if (!Array.isArray(cur) || !Array.isArray(next)) return;
    for (const entry of next) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      // 显式带了 apiKey（含空串 = 真清除）→ 尊重调用方，不回填；
      // 完全没带（脱敏回传的常态）→ 从现配置同 id 条目回填现值。
      if (entry.apiKey !== undefined) continue;
      const stored = cur.find((p) => String(p?.id) === String(entry.id));
      if (stored && String(stored.apiKey || '').trim()) {
        entry.apiKey = stored.apiKey;         // 回填现值，等价于"该条目未动"
      }
    }
  } catch { /* 保留失败不阻塞保存；最坏结果是回到旧行为 */ }
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  const cleanPatch = stripDerivedFlags(structuredClone(patch ?? {}));
  const cleanObsolete = stripObsoleteFields(cleanPatch);
  // ── 脱敏回传的密钥保留（2026-09-19 修"搜索 Key 离开页签就消失"）──
  // 前端拿到的配置是脱敏的（apiKey 被删、hasApiKey 被加）；它把整个配置/区块
  // 回传保存时，密钥字段天然缺失。对**对象型**密钥容器 deepMerge 会保留基底值
  // （webSearch.deepseek.apiKey 没出现在 patch → 沿用现值），但**数组型**容器
  // （webSearch.providers[].apiKey）整体替换 —— 前端回传的数组里没有 apiKey，
  // 一次普通的设置保存就把所有自定义搜索服务的 Key 静默清空（表现为掩码消失、
  // 测试报 invalid API key）。这里在合并前把"patch 条目缺密钥字段"的数组按 id
  // 回填现值；想真清除必须显式传 apiKey: ''（专用清除按钮就是显式空串路径）。
  preserveSanitizedSecrets(getConfig(), cleanObsolete);
  currentConfig = deepMerge(getConfig(), cleanObsolete);
  // 磁盘上可能已经存过历史遗留的派生标记，一并清掉
  stripDerivedFlags(currentConfig);
  stripObsoleteFields(currentConfig);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的人设：全局 persona 被 personaByChat[id] 的同名字段覆盖。
 *
 * 只允许覆盖 roleText / participation / customRules / systemPromptOverride 四个
 * "说话风格"字段；botName / selfNickname 是账号身份，任何会话都不得单独改 ——
 * 换了会与 @ 判定（isAtMe 用昵称/名字匹配）、存档里"我"的称呼全部对不上。
 * 覆盖值一律做字符串 trim（空串视为"未设置"，回落全局值）。
 *
 * ⚠️ personaUnified = true（"为所有的群聊/私聊使用同一个人设"）时，
 *    personaByChat 的条目**不再生效**（统一人设是用户明确表态，遗留的
 *    分会话条目继续覆盖会让"所有会话共用这一套人设"的 UI 承诺落空，
 *    且统一模式下 UI 隐藏了分会话编辑入口，用户无从发现也无处改）。
 *    开关关掉后条目恢复生效 —— 数据不删，只是不再参与合并。
 */
export function personaForChat(chatKey) {
  const base = getConfig().persona || {};
  const [kind, id] = String(chatKey || '').split(':');
  if (!id) return base;
  // 统一人设模式：一律用全局，不看 personaByChat
  if (getConfig().personaUnified !== false) return base;
  const perChat = getConfig().personaByChat || {};
  // 兼容两种键格式：UI 的隐藏 JSON 以 chatKey（group:123）为键保存，
  // 而这里按 id 段（123）查 —— 只认一种格式时保存成功但永不生效
  // （2026-09-17 用户实测踩中：独立人设存了却一直跟随全局）。
  const raw = perChat[String(id)] ?? perChat[String(chatKey)];
  if (!raw || typeof raw !== 'object') return base;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out = { ...base };
  if (kind === 'group' || kind === 'private') {
    const roleText = pick(raw.roleText);
    const customRules = pick(raw.customRules);
    const systemPromptOverride = pick(raw.systemPromptOverride);
    if (roleText !== undefined) out.roleText = roleText;
    if (customRules !== undefined) out.customRules = customRules;
    if (systemPromptOverride !== undefined) out.systemPromptOverride = systemPromptOverride;
    if (['low', 'medium', 'high'].includes(raw.participation)) out.participation = raw.participation;
  }
  return out;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 *
 * 峰谷切换：peakSchedule.enabled 时，先按当前时间判定落在高峰/低谷时段，
 * 用该时段的 sliderPos 换算出档位**覆盖**全局滑条（在 unifiedTier / 分群设置之前生效）。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  // ── 指令禁言：该群被禁言且未到期 → 强制 1 档（仅艾特）──
  const mutedTier = commandMuteTier(chatKey);
  if (mutedTier !== null) {
    return { ...store, contextTier: 1, randomPercent: 0 };
  }
  // ── 浏览节拍（[qqagent-browse-patch:config-tier]）──
  // 节拍模式下触发权在节拍本身，档位不再参与触发判定 → 统一按 4 档（全响应）呈现，
  // 避免浏览拍被档位判成"未触发"而整批归档。指令禁言已在上面 early return，优先。
  if (getConfig().engage?.browse?.enabled !== false) {
    return { ...store, contextTier: 4, randomPercent: 100 };
  }
  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;
  const inPeakNow = peakOn && peakWindowActive(store.peakSchedule);

  // ── 四象限（2026-09-18 改版）──
  //   统一 + 峰谷关：全局滑条（contextSliderPos）
  //   统一 + 峰谷开：全局峰谷双点按时段取高峰/低谷
  //   分群 + 峰谷关：群无单独设置 → 全局滑条；有 → groupSliderPos[群]
  //   分群 + 峰谷开：群无单独峰谷 → 全局双点按时段取；有 → groupPeakPos[群] 按时段取
  // 私聊永远跟随"全局"口径（峰谷开时同样受时段影响）。
  let pos = clampSliderPos(store.contextSliderPos);
  if (peakOn) {
    if (isGroup && store.unifiedTier === false) {
      const gp = store.groupPeakPos?.[id];
      pos = gp
        ? clampSliderPos(inPeakNow ? gp.peak : gp.valley)
        : (inPeakNow ? clampSliderPos(store.peakSchedule.peak?.sliderPos) : clampSliderPos(store.peakSchedule.valley?.sliderPos));
    } else {
      pos = inPeakNow
        ? clampSliderPos(store.peakSchedule.peak?.sliderPos)
        : clampSliderPos(store.peakSchedule.valley?.sliderPos);
    }
  } else if (isGroup && store.unifiedTier === false) {
    const gp = store.groupSliderPos?.[id];
    if (gp !== undefined && gp !== null) pos = clampSliderPos(gp);
  }
  const { tier, randomPercent } = sliderToTier(pos);
  return { ...store, contextSliderPos: pos, contextTier: tier, randomPercent };
}

/**
 * 当前时间是否落在高峰时段内（峰谷判定的第一步，供 storeConfigForChat 复用）。
 */
function peakWindowActive(ps, at = new Date()) {
  const minutes = at.getHours() * 60 + at.getMinutes();
  const s = parseHHMM(ps?.peak?.start);
  const e = parseHHMM(ps?.peak?.end);
  if (s === null || e === null || s === e) return false;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
}

/**
 * 指令禁言：该群是否处于禁言期（响应档位被强制为 1 档）。
 * @returns {number|null} 强制档位（1）；未禁言/已到期返回 null
 */
export function commandMuteTier(chatKey, at = Date.now()) {
  const cm = getConfig().commandMute;
  if (!cm || cm.enabled !== true) return null;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return null;
  const until = Number(cm.active?.[id]);
  if (!Number.isFinite(until)) return null;
  if (until === 0) return 1;              // 0 = 直到手动解除
  if (at < until) return 1;               // 未到解除时间
  return null;                            // 已到期
}

/**
 * 峰谷切换的核心判定：当前时间落在哪个时段。
 * 2026-09-18 四象限改版后的语义：高峰窗口内 = peak.sliderPos，
 * 窗口外一律 = valley.sliderPos（低谷时段不再单独编辑）。
 * 注意：storeConfigForChat 内联了同一判定（分群峰谷 groupPeakPos 也在那里处理）；
 * 修改时段判定口径时两处必须同步改。
 */
export function resolvePeakSliderPos(store, at = new Date()) {
  const ps = store?.peakSchedule;
  if (!ps || ps.enabled !== true) return null;
  if (peakWindowActive(ps, at)) return clampSliderPos(ps.peak?.sliderPos);
  return clampSliderPos(ps.valley?.sliderPos);
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clampSliderPos(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}
