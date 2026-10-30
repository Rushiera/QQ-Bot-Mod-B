// verify-intent.mjs —— 领航员意图判断器（N6 第一刀影子）自测
//
// 用法：node tools/verify-intent.mjs
// 边界：纯本地、纯函数——不触网、不投递、不发群、不落盘。
// 覆盖：三类判定 · 称呼前缀不是转达 · 同名歧义 · 拿不准按闲聊 · 开关词 ·
//       只读不派活 · 触发标记剥离 · 猫名长优先 · LLM 兜底可注入替身。
//
// 口径来源：role/nav-rules.md §判断（:14-21）。

import { createIntentService, stripTriggerTag, matchCat, detectSwitch, parseAddressPrefix } from '../app/src/navigator/intent.js';

let pass = 0;
let fail = 0;

/**
 * 断言。
 *
 * @param {string} name 用例名
 * @param {boolean} cond 条件
 * @param {string} [detail] 失败细节
 * @returns {void}
 */
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const noopLog = { info() {}, warn() {}, error() {} };

// LLM 替身：只回固定判定（自测不真调端点）
const fakeSummarize = async (text) => {
  if (String(text).includes('这个东西有点意思')) return '{"kind":"generate","target":"","reason":"改图"}';
  if (String(text).includes('看一下 rb')) return '{"kind":"instruct","target":"rb","reason":"只读"}';
  return '';
};

const svc = createIntentService({ log: noopLog, summarize: fakeSummarize, config: { navigator: { intent: { llm: true } } } });
const svcNoLlm = createIntentService({ log: noopLog, summarize: fakeSummarize, config: {} });

console.log('\n一、工具函数');
check('剥离触发标记（@我/提到我）', stripTriggerTag('看一下 rb（@我/提到我）') === '看一下 rb', stripTriggerTag('看一下 rb（@我/提到我）'));
check('剥离触发标记（提问）', stripTriggerTag('帮我查下（@我/提到我/提问）') === '帮我查下');
check('无标记原样', stripTriggerTag('  随便聊聊  ') === '随便聊聊');
check('猫名长优先（R喵喵喵喵 不被 R喵 抢先）', matchCat('让R喵喵喵喵上工') === 'R喵喵喵喵', matchCat('让R喵喵喵喵上工'));
check('猫名边界（R喵喵 里的 R喵 不算）', matchCat('R喵喵 在吗') === 'R喵喵', matchCat('R喵喵 在吗'));
check('majordomo 命中', matchCat('告诉majordomo去干活') === 'majordomo');
check('无猫名返回空串', matchCat('今天天气不错') === '');
check('开关词：开', detectSwitch('打开领航员') === 'open');
check('开关词：关', detectSwitch('可以退出领航员模式了') === 'close');
check('开关词：无', detectSwitch('看下 rb 在干嘛') === '');
check('称呼前缀：跟 X 说', parseAddressPrefix('跟R喵说，上工qqbotb').cat === 'R喵', JSON.stringify(parseAddressPrefix('跟R喵说，上工qqbotb')));
check('称呼前缀：让 X 做', parseAddressPrefix('让 rb 检查一下配置').cat === 'rb');
check('称呼前缀：非猫名不认', parseAddressPrefix('跟老王说一声').cat === '');

console.log('\n二、规则判定（三分类）');
const cases = [
  ['打开领航员', true, 'switch', '', '开关'],
  ['可以退出领航员模式了', true, 'switch', ''],
  ['跟R喵说，上工qqbotb', true, 'send', 'R喵', '称呼前缀 → 收件猫'],
  ['让 rb 检查一下配置', true, 'send', 'rb'],
  ['R喵喵 帮我看下日志', true, 'send', 'R喵喵'],
  ['把这张图做成三视图', true, 'generate', ''],
  ['念一下上面图片里的内容', true, 'generate', ''],
  ['回执', true, 'readonly', ''],
  ['各单位运行情况', true, 'readonly', ''],
  ['看一下 rb 在干嘛', true, 'readonly', 'rb'],
  ['截一下 majordomo 的会话', true, 'shot', 'majordomo'],
  ['今天天气不错', false, 'none', ''],
  ['哈哈哈哈', false, 'none', ''],
  ['你们在聊什么', false, 'none', ''],
  ['上工qqbotb', true, 'none', ''],
];

for (const [text, atMe, expectAction, expectTarget] of cases) {
  const r = svcNoLlm.classifyByRule({ text, atMe, enabled: false });
  const okAction = r.action === expectAction;
  const okTarget = expectTarget === '' ? true : r.target === expectTarget;
  check(`「${text}」→ ${expectAction}${expectTarget ? `/${expectTarget}` : ''}`, okAction && okTarget,
    `实际 ${r.action}/${r.target || '-'}（${r.reason}）`);
}

console.log('\n三、开启态差异');
const enabledCase = svcNoLlm.classifyByRule({ text: '帮我看下日志', atMe: true, enabled: true });
check('开启态无名派活 → majordomo', enabledCase.action === 'send' && enabledCase.target === 'majordomo',
  `实际 ${enabledCase.action}/${enabledCase.target}`);
const disabledCase = svcNoLlm.classifyByRule({ text: '帮我看下日志', atMe: true, enabled: false });
check('未开启无名派活 → 不当指令', disabledCase.action === 'none', `实际 ${disabledCase.action}`);

console.log('\n四、不投递纪律');
for (const text of ['回执', '各单位运行情况', '看一下 rb 在干嘛', '进度怎么样', '截一下 rb 的会话']) {
  const r = svcNoLlm.classifyByRule({ text, atMe: true, enabled: true });
  check(`「${text}」不产 send`, r.action !== 'send', `实际 ${r.action}`);
}

console.log('\n五、LLM 兜底（替身）');
const llmOff = await svcNoLlm.classify({ text: '随便说点什么', atMe: true, useLlm: true });
check('未开 llm → via=rule', llmOff.via === 'rule', llmOff.via);
const llmOn = await svc.classify({ text: '随便说点什么', atMe: true, useLlm: true });
check('开 llm 但替身无输出 → 回落 rule', llmOn.via === 'rule', llmOn.via);
const llmGen = await svc.classify({ text: '这个东西有点意思', atMe: true, useLlm: true });
check('开 llm 且替身给 generate → via=llm', llmGen.via === 'llm' && llmGen.kind === 'generate', `${llmGen.via}/${llmGen.kind}`);
const llmInstruct = await svc.classify({ text: '看一下 rb', atMe: true, useLlm: true });
check('规则先命中时不调 llm', llmInstruct.via === 'rule', llmInstruct.via);

console.log('\n六、影子零副作用');
const activityBefore = typeof svc.classifyByRule({ text: 'X' }) === 'object';
check('classifyByRule 同步返回纯对象（无 Promise / 无 IO）', activityBefore === true);
check('服务面无发送入口（只有 classify 三件）',
  ['classify', 'classifyByRule', 'classifyByLlm', 'detectSwitch', 'DEFAULT_CATS'].every((k) => k in svc)
  && !('send' in svc) && !('say' in svc));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
