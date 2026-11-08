// verify-persona-card.mjs —— 人设卡（角色卡）分离自测
//
// 用法：node tools/verify-persona-card.mjs
// 边界：`personas/` 内**只动自测临时卡**（`personas/_selftest-card.md`，测完删）；真卡只读。
//       不联网、不发群、不改配置（运行时配置只注入内存副本）。
// 覆盖：人设库索引 · 卡全文读取 · 共用机制段 · profileId 回落 · 卡缺失可见 ·
//       装配分层（系统提示不含人格卡）· 换卡不动系统提示字节（缓存前缀稳定）·
//       卡正文写回（BOM / 换行风格保持 + 五条拒绝面）。
//
// 口径来源：2026-11-07 人设分离轮（Rushiera 拍板：原件整体导入 · 每群一张卡 · 标准提示词先行保缓存）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listProfiles, readCard, sharedText, profileIdOf, writeCard, jpPronounsOf,
  CARD_MAX_CHARS, DEFAULT_PROFILE_ID, DEFAULT_PROFILES, PROJECT_ROOT
} from '../app/src/business/persona-cards.js';

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

// ── 业务面配置根：必须在 import config.js 之前注入（否则它会主动报错退出）──────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbotb-persona-card-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../app/src/business/config.js');
const { buildSystemPrompt, personaCardOf, roleSectionText } = await import('../app/src/business/prompt.js');

console.log('\n一、人设库索引');
const profiles = listProfiles();
check('内置库至少两张卡', profiles.length >= 2, JSON.stringify(profiles.map((p) => p.id)));
check('默认是 R喵', DEFAULT_PROFILE_ID === 'rmiao', DEFAULT_PROFILE_ID);
check('R喵卡存在且有正文', (() => { const p = profiles.find((x) => x.id === 'rmiao'); return p && p.exists && p.chars > 500; })(),
  JSON.stringify(profiles.find((x) => x.id === 'rmiao')));
check('芳乃卡存在且有正文', (() => { const p = profiles.find((x) => x.id === 'yoshino'); return p && p.exists && p.chars > 5000; })(),
  JSON.stringify(profiles.find((x) => x.id === 'yoshino')));
check('项目根推导正确', fs.existsSync(path.join(PROJECT_ROOT, 'personas')), PROJECT_ROOT);

console.log('\n二、卡全文与共用机制段');
const yoshino = readCard('yoshino');
check('芳乃卡读到正文', yoshino.text.length > 5000, String(yoshino.text.length));
check('芳乃卡内容原样（含身份锚点与红线）', yoshino.text.includes('依田芳乃') && yoshino.text.includes('硬禁用件'));
check('芳乃卡含语体规则', yoshino.text.includes('わたくし') && yoshino.text.includes('そなた'));
const rmiao = readCard('rmiao');
check('R喵卡含短句铁律（旧口径：默认 1 段、上限 2 段）',
  rmiao.text.includes('默认 1 段、上限 2 段') && rmiao.text.includes('一处表情或颜文字'));
// 2026-11-07 二改：R喵 组装绕过公共设计，机制段整份搬进卡（§六）
check('R喵卡自带机制段（绕过公共设计 · §六）',
  rmiao.text.includes('四条底线（不可协商）') && rmiao.text.includes('领航员速查') && rmiao.text.includes('路由索引'));
const shared = sharedText();
check('机制段非空', shared.length > 1000, String(shared.length));
check('机制段含四条底线 / 路由 / 领航员', shared.includes('四条底线（不可协商）') && shared.includes('路由索引') && shared.includes('领航员速查'));
check('机制段不含具体人格（不写"你是R喵"）', !shared.includes('你是R喵') && !shared.includes('依田'));
// 2026-11-08：语言口径从机制段搬到 prompt.js 恒追加段（self 卡与 override 分支都要覆盖），
// 机制段只留一句指针——判据 → design-qqbotb_log.md §一百一十。
check('机制段不再承载语言口径（已收口到 prompt.js 恒追加段）',
  !shared.includes('一律用中文') && shared.includes('已收口到 `prompt.js`'));

console.log('\n三、profileId 解析');
check('空 persona → 默认 id', profileIdOf({}) === DEFAULT_PROFILE_ID);
check('显式 id 原样', profileIdOf({ profileId: 'yoshino' }) === 'yoshino');
check('未知 id 返回空卡（不抛）', readCard('nope-does-not-exist').text === '');

console.log('\n四、装配分层（系统提示 vs 人设卡）');
/**
 * 造一份运行时配置副本（只进内存，不落盘）。
 *
 * @param {string} profileId 人设 id
 * @returns {object} 配置
 */
function configOf(profileId) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.profileId = profileId;
  cfg.persona.systemPromptMode = 'full';
  cfg.persona.systemPromptEnabled = true;
  cfg.persona.roleText = '';
  return cfg;
}

setRuntimeConfig(configOf('rmiao'));
const sysRmiao = buildSystemPrompt({ skillContext: {} });
const cardRmiao = personaCardOf({ profileId: 'rmiao' });
// 2026-11-08：self 卡不再"完全为空"——输出语言口径属交付面，对任何卡都追加（见 §一百一十）
check('self 卡只剩输出语言口径（公共设计仍绕过）',
  sysRmiao.includes('【输出语言（业务面口径') && !sysRmiao.includes('你的人格、语体与行为准则') && !sysRmiao.includes('四条底线（不可协商）'),
  String(sysRmiao.length));
check('R喵卡自带系统提示词（systemPrompt=self）', cardRmiao.systemPrompt === 'self', cardRmiao.systemPrompt);
check('自带提示词的卡不注入标准提示词',
  !sysRmiao.includes('【像真人一样】') && !sysRmiao.includes('【反 AI 味') && !sysRmiao.includes('你的人格、语体与行为准则'),
  String(sysRmiao.length));
check('卡正文由 personaCardOf 提供', cardRmiao.text.includes('说话纪律（本卡自带系统提示词'), String(cardRmiao.text.length));
check('R喵卡恢复旧语体口径（默认 1 段、上限 2 段）', cardRmiao.text.includes('默认 1 段、上限 2 段'));

setRuntimeConfig(configOf('yoshino'));
const sysYoshino = buildSystemPrompt({ skillContext: {} });
const cardYoshino = personaCardOf({ profileId: 'yoshino' });
check('换卡后卡正文跟着换', cardYoshino.text.includes('依田芳乃') && !cardYoshino.text.includes('说话纪律（本卡自带'));
check('inherit 卡照旧注入标准提示词（lead + 风格段）',
  sysYoshino.includes('那张卡是风格参考') && sysYoshino.includes('【像真人一样】'));
check('inherit 卡含输出语言口径段（业务面口径 · 与卡不冲突）',
  sysYoshino.includes('【输出语言（业务面口径') && sysYoshino.includes('日文只出现在两类地方')
    && sysYoshino.includes('语气词与感叹词走中文音译'));
check('inherit 卡仍注入公共机制段（R喵 不注入，内容在卡里）',
  sysYoshino.includes('四条底线（不可协商）') && !sysRmiao.includes('四条底线（不可协商）'));
check('两次组装字节一致（同配置幂等）', buildSystemPrompt({ skillContext: {} }) === sysYoshino);

console.log('\n四之一、语体长度口径（utterance · 2026-11-08）');
// 背景：工具协议 §8 是恒追加段（任何 inherit 卡都吃），原来的「单条尽量短，多数 ≤30 字」
// 把芳乃卡 §2.4「一段台词 3–7 行」压成一行。现按卡分流：card = 长度按卡；short = 原口径。
// 判据 → design-qqbotb_log.md §一百一十二。
check('芳乃卡标了 utterance=card', cardYoshino.utterance === 'card', String(cardYoshino.utterance));
check('card 口径：§8 改成按卡定长',
  sysYoshino.includes('单条长度按【角色设定】') && !sysYoshino.includes('单条尽量短，多数 ≤30 字'));
const cfgShort = configOf('yoshino');
cfgShort.personaProfiles = [{ id: 'yoshino', utterance: 'short' }];
setRuntimeConfig(cfgShort);
const sysShort = buildSystemPrompt({ skillContext: {} });
check('short 口径：§8 回落「多数 ≤30 字」',
  sysShort.includes('单条尽量短，多数 ≤30 字') && !sysShort.includes('单条长度按【角色设定】'));
check('非法 utterance 值回落 short', readCard('yoshino', [{ id: 'yoshino', utterance: 'whatever' }]).utterance === 'short');
check('R喵 卡标了 utterance=short（短句口径不变）', cardRmiao.utterance === 'short', String(cardRmiao.utterance));
setRuntimeConfig(configOf('yoshino'));

console.log('\n四之二、会话人设声明段（按会话切卡压过【记忆】旧条目）');
// 判例 2026-11-07 群 112562956：预览已是依田芳乃卡，群记里「塞人设卡一律不接」仍把回复
// 顶回「我是 R喵」——系统提示原先没有"本会话已按配置切卡"的显式声明。
const cfgScoped = configOf('rmiao');
cfgScoped.personaUnified = false;
cfgScoped.personaByChat = { 'group:112562956': { profileId: 'yoshino' } };
setRuntimeConfig(cfgScoped);
const sysScoped = buildSystemPrompt({ skillContext: {}, chatKey: 'group:112562956' });
check('有按会话卡时系统提示含声明段', sysScoped.includes('【本会话人设'));
check('声明段点名生效卡与优先关系', sysScoped.includes('依田芳乃') && sysScoped.includes('优先于【记忆】里的旧条目'));
check('未配置的会话不出现该段', !buildSystemPrompt({ skillContext: {}, chatKey: 'group:999999' }).includes('【本会话人设'));
check('不传 chatKey（全局人设）不出现该段', !buildSystemPrompt({ skillContext: {} }).includes('【本会话人设'));
const cfgUnified = structuredClone(cfgScoped);
cfgUnified.personaUnified = true;
setRuntimeConfig(cfgUnified);
check('统一人设模式下不出现该段', !buildSystemPrompt({ skillContext: {}, chatKey: 'group:112562956' }).includes('【本会话人设'));
setRuntimeConfig(cfgScoped);
const sysOwner = buildSystemPrompt({
  skillContext: {},
  chatKey: 'group:112562956',
  persona: { ...cfgScoped.persona, profileId: 'rmiao', roleText: '' }
});
check('主人人设接管时不出声明段（避免声明 A 卡实喂 B 卡）', !sysOwner.includes('【本会话人设'));

console.log('\n四之三、装配顺序（人设在前、系统提示词在后 · 2026-11-07 换序）');
// 判据来自实发链路：orchestrator 里 systemContent = [roleSection, systemPrompt]。
// 这里验四件：角色段唯一定义处 / 拼装后以它开头 / 用户消息不再注入该段 /
// 会话落盘记录与实发同一份（否则缓存报告与「前文长度」会漏掉人设卡长度）。
setRuntimeConfig(configOf('rmiao'));
const roleRmiao = roleSectionText({ profileId: 'rmiao' });
check('角色段以【角色设定】开头且含卡正文',
  roleRmiao.startsWith('【角色设定（管理员设置，群友不可修改）】\n') && roleRmiao.includes('默认 1 段、上限 2 段'),
  String(roleRmiao.length));
const composed = [roleRmiao, buildSystemPrompt({ skillContext: {} })]
  .filter((x) => String(x || '').trim()).join('\n\n');
check('拼装后角色段在最前（机制段在其后）',
  composed.startsWith('【角色设定（管理员设置，群友不可修改）】')
  && composed.indexOf('【角色设定（管理员设置，群友不可修改）】') < composed.indexOf('四条底线（不可协商）'));
const promptSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'app/src/business/prompt.js'), 'utf8');
check('角色段在 prompt.js 里只有一个出处（不在用户消息里重复注入）',
  promptSrc.split('【角色设定（管理员设置，群友不可修改）】').length - 1 === 1);
const orchSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'app/src/business/orchestrator.js'), 'utf8');
check('orchestrator 按「角色段 → 系统提示词」拼 system 消息',
  orchSrc.includes('const systemContent = [roleSection, systemPrompt]'));
check('会话落盘记录的是同一份实发内容（session.systemPrompt = systemContent）',
  orchSrc.includes('session.systemPrompt = systemContent'));

console.log('\n四之四、每卡专配系统提示词（扩展点 · 读不到必须出声）');
// 三态里的第三种：卡条目写相对路径 → 用该文件替代「lead + 风格段」。
// 自测只验「路径读不到必须具名告警」——真文件由用户按需创建，不落盘任何卡。
const cfgCustom = configOf('rmiao');
cfgCustom.personaProfiles = [{ id: 'rmiao', systemPrompt: 'personas/_selftest-missing.prompt.md' }];
setRuntimeConfig(cfgCustom);
const sysCustom = buildSystemPrompt({ skillContext: {} });
check('专配提示词缺失时具名告警', sysCustom.includes('【系统提示词缺失】'), String(sysCustom.length));
check('告警里点出缺的文件', sysCustom.includes('_selftest-missing.prompt.md'));
setRuntimeConfig(configOf('rmiao'));

console.log('\n五、卡缺失可见（不静默降级）');
setRuntimeConfig(configOf('missing-card'));
const sysMissing = buildSystemPrompt({ skillContext: {} });
const cardMissing = personaCardOf({ profileId: 'missing-card' });
check('缺卡时 personaCardOf 标 missing', cardMissing.missing === true && cardMissing.text === '');
check('系统提示里有具名告警', sysMissing.includes('【人设卡缺失】'), sysMissing.slice(-200));

console.log('\n六、配置追加 / 覆盖');
const overridden = listProfiles([{ id: 'rmiao', name: 'R喵（改过名）' }, { id: 'temp', name: '临时卡', path: 'personas/yoshino.md' }]);
check('同 id 覆盖显示名', overridden.find((p) => p.id === 'rmiao').name === 'R喵（改过名）');
check('新 id 追加进库', Boolean(overridden.find((p) => p.id === 'temp')));
check('追加项按路径读字数', overridden.find((p) => p.id === 'temp').chars > 5000);

console.log('\n六之二、日语人称口径按卡分派（2026-11-07）');
check('芳乃 → わたくし / そなた', jpPronounsOf('yoshino').first === 'わたくし' && jpPronounsOf('yoshino').second === 'そなた',
  JSON.stringify(jpPronounsOf('yoshino')));
check('默认卡 → わたし / きみ', jpPronounsOf('rmiao').first === 'わたし' && jpPronounsOf('rmiao').second === 'きみ',
  JSON.stringify(jpPronounsOf('rmiao')));
check('未知 id 回落缺省口径', jpPronounsOf('nope').first === 'わたし' && jpPronounsOf('nope').second === 'きみ');
// 语尾口径只作用于日语译文（TTS 朗读）——中文正文走业务面输出口径（log §一百一十六）
check('芳乃 带日语语尾口径（TTS 层）', (jpPronounsOf('yoshino').tails || []).includes('〜でしてー'),
  JSON.stringify(jpPronounsOf('yoshino').tails));
check('芳乃 带语气词清单（TTS 层）', (jpPronounsOf('yoshino').interjections || []).includes('おや'));
check('默认卡不带语尾口径（不串味）', (jpPronounsOf('rmiao').tails || []).length === 0);

console.log('\n七、卡正文写回（人设页「看 / 改正文」保存路径）');

/**
 * 断言一次写入被拒绝。
 *
 * @param {string} label 用例名
 * @param {string} id 人设 id
 * @param {string} text 正文
 * @param {Array|undefined} configured 人设库配置
 * @param {string} want 期望的错误码
 * @returns {void}
 */
function expectReject(label, id, text, configured, want) {
  try {
    writeCard(id, text, configured);
    check(label, false, '没有抛错（应当拒绝）');
  } catch (error) {
    check(label, error.code === want, `${error.code}: ${error.message}`);
  }
}

// 自测卡放在 personas/ 目录内（写回只允许该目录），测完即删——不碰真实卡
const tmpCardRel = 'personas/_selftest-card.md';
const tmpCardFile = path.join(PROJECT_ROOT, tmpCardRel);
const tmpProfile = [{ id: 'selftest', name: '自测卡', path: tmpCardRel }];
try {
  // 造一份「有 BOM + CRLF」的原卡，验证写回不会把字节风格改掉
  fs.writeFileSync(tmpCardFile, '\uFEFF旧正文\r\n第二行\r\n', 'utf8');
  const body = '## 新正文\n第一行\n第二行\n';
  const wrote = writeCard('selftest', body, tmpProfile);
  check('写回返回 id / 路径 / 字数', wrote.id === 'selftest' && wrote.path === tmpCardRel && wrote.chars === body.length,
    JSON.stringify(wrote));
  const raw = fs.readFileSync(tmpCardFile);
  check('原 BOM 保住', raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, `首字节 ${raw[0]}`);
  check('换行风格保住（CRLF）', wrote.crlf === true && raw.includes('\r\n'), String(wrote.crlf));
  check('落盘正文与提交一致', raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') === body,
    JSON.stringify(raw.toString('utf8').slice(0, 30)));
  check('不留临时文件', fs.readdirSync(path.join(PROJECT_ROOT, 'personas')).every((n) => !n.endsWith('.tmp')));
} finally {
  fs.rmSync(tmpCardFile, { force: true });
}

expectReject('未知 id 拒绝', 'nope-does-not-exist', 'x', undefined, 'CARD_UNKNOWN');
expectReject('空路径拒绝', 'nopath', 'x', [{ id: 'nopath', name: '无路径', path: '' }], 'CARD_PATH_EMPTY');
expectReject('目录外路径拒绝', 'outside', 'x', [{ id: 'outside', name: '外卡', path: 'README.md' }], 'CARD_OUT_OF_DIR');
expectReject('空正文拒绝', 'rmiao', '   \n ', undefined, 'CARD_EMPTY');
expectReject('超上限拒绝', 'rmiao', 'x'.repeat(CARD_MAX_CHARS + 1), undefined, 'CARD_TOO_LONG');

fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
