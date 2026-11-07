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
  listProfiles, readCard, sharedText, profileIdOf, writeCard,
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
const { buildSystemPrompt, personaCardOf } = await import('../app/src/business/prompt.js');

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
check('R喵卡含短句铁律', rmiao.text.includes('能用一个字') && rmiao.text.includes('不用一段话'));
check('R喵卡不再含机制段（已分离到 _shared.md）', !rmiao.text.includes('四条底线（不可协商）') && !rmiao.text.includes('领航员速查'));
const shared = sharedText();
check('机制段非空', shared.length > 1000, String(shared.length));
check('机制段含四条底线 / 路由 / 领航员', shared.includes('四条底线（不可协商）') && shared.includes('路由索引') && shared.includes('领航员速查'));
check('机制段不含具体人格（不写"你是R喵"）', !shared.includes('你是R喵') && !shared.includes('依田'));

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
check('系统提示含共用机制段', sysRmiao.includes('四条底线（不可协商）') && sysRmiao.includes('领航员速查'));
check('系统提示不含 R喵卡正文', !sysRmiao.includes('能用一个字、一个表情'));
check('卡正文由 personaCardOf 提供', cardRmiao.text.includes('能用一个字、一个表情'), String(cardRmiao.text.length));
check('系统提示声明"角色卡优先"', sysRmiao.includes('角色设定') && sysRmiao.includes('优先于本提示词'));

setRuntimeConfig(configOf('yoshino'));
const sysYoshino = buildSystemPrompt({ skillContext: {} });
const cardYoshino = personaCardOf({ profileId: 'yoshino' });
check('换卡后卡正文跟着换', cardYoshino.text.includes('依田芳乃') && !cardYoshino.text.includes('能用一个字'));
check('换卡不动系统提示（缓存前缀稳定）', sysRmiao === sysYoshino,
  `rmiao=${sysRmiao.length} / yoshino=${sysYoshino.length}`);
check('两次组装字节一致（同配置幂等）', buildSystemPrompt({ skillContext: {} }) === sysYoshino);

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
