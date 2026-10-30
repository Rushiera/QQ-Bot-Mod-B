// navigator/intent.js —— 群消息意图判断（N6 迁移第一刀：影子判断器）
//
// 职责：把一条群消息判成 chat / instruct / generate 三类，并解析目标猫与具体动作
//       （send / readonly / generate / switch / none）。
// 边界：**零行为**——本模块只产判断，不投递、不发言、不落盘；
//       `POST /api/nav/intent` 是影子路由（业务面仍走自己的 LLM 判断，两边可双跑比对）。
// 口径来源：role/nav-rules.md §判断（指令 vs 闲聊 / 称呼前缀不是转达 / 同名歧义）。
// 设计：design-qqbotb-navigator.md §十二 · reports/R3-L8.md §四。

/** 默认猫名清单（配置读不到时的回落；顺序即解析优先级）。 */
const DEFAULT_CATS = Object.freeze(['majordomo', 'R喵', 'R喵喵', 'R喵喵喵', 'R喵喵喵喵', 'rb', 'rc', 'rd', 're', 'rf']);

/** 本 bot 自己的称呼——命中后去掉前缀再判（nav-rules「区分口径」）。 */
const SELF_ALIASES = Object.freeze(['R喵', 'Shieraru', 'Shierar', '小喵', '你', '本喵']);

/** 开关词。 */
const SWITCH_ON = /(打开|开启|启动|进入|开一下)[^\n]{0,8}(领航员|领航)/;
const SWITCH_OFF = /(关掉|关闭|退出|结束|停止|关一下)[^\n]{0,8}(领航员|领航)/;

/** 只读类请求（回执 / 运行情况 / 截图 / 分析）。 */
const READONLY = /(回执|运行情况|什么情况|怎么样了?|进度|状态|在干嘛|在干什么|做到哪|最近在|截一下|截图|截个图|发来看看|看一下|看看)/;

/** 截图特化（要图，不是要判读）。 */
const SHOT = /(截一下|截图|截个图|发来看看|会话发来)/;

/** 生成能力（改图 / 生图 / 语音 / 反推）。 */
const GENERATE = /(图像编辑|改图|改一下图|把.{0,12}(变成|做成|换成)|三视图|换个姿势|换姿势|换个画风|换画风|生图|出图|画一?张|画个|画三视图|念一下|念一遍|念给我|读一下|转语音|朗读|反推|打标|提示词)/;

/** 前文整理重启（代读猫代读 → 注入交接报告 → 继续）。 */
const RESET = /(前文整理|整理[\s\S]{0,12}前文|重建[\s\S]{0,20}前文|清理[\s\S]{0,20}前文|交接报告|整理重启)/;

/** 直接开新会话（clear 前文，不留交接）。 */
const NEW_SESSION = /((清掉|清了|清空|清一下|清理).{0,8}(会话|前文|上下文))|开(个|一个)?新会话|新会话/;

/** 任务动词（判「这是不是要猫干活」）。 */
const TASK_VERB = /(上工|收工|看|查|改|跑|写|整理|检查|修复|实现|加个|加上|删掉|删了|测试|部署|重写|重构|落地|排查|定位|优化|补|做一下|帮我|给我|处理)/;

/** 称呼前缀（「跟 X 说」「让 X 做」里 X 是收件猫——不是叫人代转）。 */
const ADDRESS_PREFIX = /(?:跟|和|告诉|让|给|对|问|找)\s*([A-Za-z\u4e00-\u9fa5]{1,12})\s*(?:说|讲|做|派|派个活|干活|聊聊|那边|一声)?/;

/** 判断提示词（LLM 兜底用——只在规则判不准时调）。 */
const CLASSIFY_PROMPT = [
  '你是群消息意图分类器。判断下面这条群消息属于哪一类，只输出一行 JSON，不要解释、不要代码围栏。',
  '{"kind":"chat|instruct|generate","target":"猫名或空","reason":"十字内"}',
  '判定口径：',
  '- instruct：要猫干活——点名了某只猫，或带任务动词（看 / 查 / 改 / 跑 / 写 / 整理 / 检查 / 修复 / 实现 / 上工），或明确在派活。',
  '- generate：要出图 / 改图 / 出语音 / 反推提示词。',
  '- chat：寒暄、吐槽、玩笑、群友之间对话、跟 bot 闲聊的题外话。',
  '- 拿不准就判 chat。',
  '- 称呼前缀不是叫你转达：「跟 X 说 / 告诉 X / 让 X 做」里的 X 就是收件猫，kind=instruct、target=X。',
  '- 「R喵」在本群既是 bot 昵称又是猫名——默认按猫处理。'
].join('\n');

/**
 * 转义正则元字符（猫名进正则用）。
 *
 * @param {string} text 原文
 * @returns {string} 转义结果
 */
function escapeRe(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 去触发标记——消息末尾的「（@我/提到我）」是判断用后缀，不是指令内容（nav-rules）。
 *
 * @param {string} text 原文
 * @returns {string} 去标记后的正文
 */
export function stripTriggerTag(text) {
  return String(text ?? '')
    .replace(/[（(]\s*@我[^）)]*[）)]\s*$/u, '')
    .replace(/[（(]\s*提到我[^）)]*[）)]\s*$/u, '')
    .trim();
}

/**
 * 在文本里找猫名——长名优先（`R喵喵喵喵` 不被 `R喵` 抢先命中）。
 *
 * @param {string} text 正文
 * @param {Array<string>} cats 猫名清单
 * @returns {string} 命中的猫名（无则空串）
 */
export function matchCat(text, cats = DEFAULT_CATS) {
  const source = String(text ?? '');
  const names = [...new Set([...(cats || []), ...DEFAULT_CATS])]
    .filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length);
  for (const name of names) {
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`, 'i').test(source)) return name;
  }
  return '';
}

/**
 * 解析称呼前缀里的收件猫（「跟 R喵 说 …」→ R喵）。
 *
 * @param {string} text 正文
 * @param {Array<string>} cats 猫名清单
 * @returns {{cat: string, body: string}} 收件猫与去掉前缀后的正文
 */
export function parseAddressPrefix(text, cats = DEFAULT_CATS) {
  const source = String(text ?? '').trim();
  const names = [...new Set([...(cats || []), ...DEFAULT_CATS])].filter(Boolean);
  for (const name of names) {
    const re = new RegExp(`^(?:@?[\\s\\S]{0,10}?)?(?:跟|和|告诉|让|给|对|问|找)\\s*${escapeRe(name)}\\s*(?:说|讲|做|派|派个活|干活|聊聊|那边|一声)?[，,：:]?\\s*`, 'u');
    if (re.test(source)) return { cat: name, body: source.replace(re, '').trim() };
  }
  // 通用前缀形态：「跟某某说」——但某某不在猫名表里则不算（可能是叫人代转）
  const generic = ADDRESS_PREFIX.exec(source);
  if (generic) {
    const candidate = String(generic[1] ?? '').trim();
    if (SELF_ALIASES.includes(candidate)) {
      // 前缀是本 bot 的称呼 → 去掉这个前缀，再按剩余正文判收件猫（nav-rules:20）
      return { cat: '', body: source.slice(generic.index + generic[0].length).trim() };
    }
  }
  return { cat: '', body: source };
}

/**
 * 开关词识别。
 *
 * @param {string} text 正文
 * @returns {'open'|'close'|''} 开关动作
 */
export function detectSwitch(text) {
  const source = String(text ?? '');
  if (SWITCH_OFF.test(source)) return 'close';
  if (SWITCH_ON.test(source)) return 'open';
  return '';
}

/**
 * 创建意图判断服务。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {Function} options.summarize LLM 文本出口（shot.summarize 同款：{text, prompt, maxTokens, label}）
 * @param {object} [options.persona] 话术服务（persona.js）—— 提供教材同源口径
 * @param {object} [options.config] 生效配置（读 navigator.intent 段）
 * @returns {object} 判断服务
 */
export function createIntentService({ log, summarize, persona = null, config = {} }) {
  const conf = config?.navigator?.intent ?? {};
  const llmEnabled = conf.llm !== false;
  const llmTimeoutMs = Number(conf.timeoutMs) > 0 ? Number(conf.timeoutMs) : 15000;
  const llmMaxTokens = Number(conf.maxTokens) > 0 ? Number(conf.maxTokens) : 800;

  /**
   * 规则判断（快路径，零网络）。
   *
   * @param {object} input 输入
   * @param {string} input.text 正文
   * @param {boolean} [input.atMe] 是否 @ 本 bot
   * @param {boolean} [input.enabled] 领航员是否已开启
   * @param {Array<string>} [input.catNames] 猫名清单（缺省用默认表）
   * @returns {object} {kind, action, target, via, reason, text}
   */
  function classifyByRule({ text, atMe = false, enabled = false, catNames = null }) {
    const body = stripTriggerTag(text);
    const cats = Array.isArray(catNames) && catNames.length > 0 ? catNames : DEFAULT_CATS;
    if (!body) return { kind: 'chat', action: 'none', target: '', via: 'rule', reason: '空正文', text: '' };

    // ① 开关词——只有开关，不夹带其它任务
    const sw = detectSwitch(body);
    if (sw) return { kind: 'instruct', action: 'switch', target: '', via: 'rule', reason: `开关：${sw}`, text: body, switch: sw };

    // ② 称呼前缀优先（「跟 X 说 …」里的 X 就是收件猫）
    const addressed = parseAddressPrefix(body, cats);
    const addressedCat = addressed.cat;

    // ③ 会话操作（清会话 / 前文整理重启）——必须排在只读与投递之前：
    //    「清了 X 的前文再让它继续」既含任务动词又像只读，判错就把「清前文」投给猫当指令。
    if ((enabled || atMe) && (RESET.test(body) || NEW_SESSION.test(body))) {
      const target = addressedCat || matchCat(body, cats) || '';
      const reset = RESET.test(body);
      // 「告诉他 Y / 让它做 Y」里的 Y 是重置后要投的原创指令——只取后半句，别把「重建前文」塞进去
      const tail = /(?:告诉他|告诉她|让它做|让他做|告诉他做|告诉她做)[，,：:]?\s*([\s\S]+)$/u.exec(body);
      return {
        kind: 'instruct',
        action: 'session',
        session: reset ? 'reset' : 'new',
        target,
        via: 'rule',
        reason: reset ? '前文整理重启' : '开新会话',
        text: reset && tail ? tail[1].trim() : ''
      };
    }

    // ④ 生成能力
    if (GENERATE.test(body)) {
      return {
        kind: 'generate',
        action: 'generate',
        target: addressedCat || matchCat(body, cats) || '',
        via: 'rule',
        reason: '命中生成能力词',
        text: addressed.body || body
      };
    }

    // ④ 只读请求（回执 / 状态 / 截图 / 分析）——要系统干活，但绝不投递
    if (READONLY.test(body) && (atMe || addressedCat || enabled)) {
      return {
        kind: 'instruct',
        action: SHOT.test(body) ? 'shot' : 'readonly',
        target: addressedCat || matchCat(body, cats) || '',
        via: 'rule',
        reason: SHOT.test(body) ? '要会话截图' : '只读请求（不派活）',
        text: addressed.body || body
      };
    }

    // ⑤ 明确点名 + 任务动词 → 投递
    const named = addressedCat || matchCat(body, cats);
    if (named && TASK_VERB.test(body)) {
      return { kind: 'instruct', action: 'send', target: named, via: 'rule', reason: '点名 + 任务动词', text: addressed.body || body };
    }

    // ⑥ 开启态下的无名派活 → 投 majordomo（nav-rules:17）
    if (enabled && atMe && TASK_VERB.test(body)) {
      return { kind: 'instruct', action: 'send', target: 'majordomo', via: 'rule', reason: '开启态无名派活 → 主干', text: body };
    }

    // ⑦ 剩下的一律按闲聊（「拿不准就按闲聊走」）
    return { kind: 'chat', action: 'none', target: '', via: 'rule', reason: '无派活特征', text: body };
  }

  /**
   * LLM 兜底判断——只给「规则判不准」的输入用（省 token；默认关可直接不调）。
   *
   * @param {string} text 正文
   * @param {Array<string>} cats 猫名清单
   * @returns {Promise<object|null>} {kind, target, reason}（失败 null）
   */
  async function classifyByLlm(text, cats = DEFAULT_CATS) {
    if (!llmEnabled || typeof summarize !== 'function') return null;
    // 教材同源（N6 清单 #4）：判断口径取 persona 的「判断 / 开关」段——
    // 教材改了判断跟着改，不再有两份口径（缺 persona 时只用内置提示词，行为不变）。
    let hint = '';
    try {
      hint = typeof persona?.classifyHint === 'function' ? String(persona.classifyHint() || '') : '';
    } catch (error) {
      log?.warn?.('intent', `教材口径不可用：${error?.message ?? error}`);
    }
    const prompt = hint ? `${CLASSIFY_PROMPT}\n\n--- 教材口径（与业务面同源）---\n${hint}` : CLASSIFY_PROMPT;
    try {
      const raw = await summarize(`${text}\n\n可选猫名：${cats.join(' / ')}`, {
        prompt,
        timeoutMs: llmTimeoutMs,
        maxTokens: llmMaxTokens,
        maxChars: 2000,
        label: '意图判断'
      });
      const hit = /\{[\s\S]*\}/.exec(String(raw ?? ''));
      if (!hit) return null;
      const parsed = JSON.parse(hit[0]);
      const kind = ['chat', 'instruct', 'generate'].includes(parsed?.kind) ? parsed.kind : 'chat';
      return { kind, target: String(parsed?.target ?? '').trim(), reason: String(parsed?.reason ?? '').trim() };
    } catch (error) {
      log?.warn?.('intent', `LLM 判断失败：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 判断一条群消息——影子口径：规则先给结论，拿不准时可交 LLM 复核（`useLlm`）。
   *
   * @param {object} input 输入
   * @param {string} input.text 正文
   * @param {boolean} [input.atMe] 是否 @ 本 bot
   * @param {boolean} [input.enabled] 领航员是否已开启
   * @param {Array<string>} [input.catNames] 猫名清单
   * @param {boolean} [input.useLlm] 是否允许 LLM 兜底（默认 false——影子期零外部调用）
   * @returns {Promise<object>} 判断结果
   */
  async function classify(input = {}) {
    const rule = classifyByRule(input);
    if (rule.action !== 'none' || input.useLlm !== true) return rule;
    const llm = await classifyByLlm(rule.text, input.catNames || DEFAULT_CATS);
    if (!llm) return rule;
    const action = llm.kind === 'generate' ? 'generate' : (llm.kind === 'instruct' ? 'send' : 'none');
    return {
      ...rule,
      kind: llm.kind,
      action,
      target: llm.target || rule.target,
      via: 'llm',
      reason: llm.reason || rule.reason
    };
  }

  return { classify, classifyByRule, classifyByLlm, detectSwitch, DEFAULT_CATS };
}
