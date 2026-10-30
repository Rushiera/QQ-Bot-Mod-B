// verify-persona.mjs —— 领航员话术 / 教材自持面（N6 清单 #4）自测
//
// 用法：node tools/verify-persona.mjs
// 边界：只读 projectDir（role/ 与 _unpack/data/config.json），不写、不发群、不触网。
// 覆盖：三段切分 · 三级回落（business → files → builtin）· 换源出声 · 按需文件白名单 ·
//       判断口径摘要（只取判断/开关两段）· 快照不含全文 · 刷新重读。
//
// 口径来源：reports/R3-L8.md §二 #4 · role/nav-rules.md。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersonaService, splitSections, looksLikeRoleText } from '../app/src/navigator/persona.js';

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

/** 记录 warn 的替身日志器。 */
const warns = [];
const log = { info() {}, warn: (scope, msg) => warns.push(`${scope}:${msg}`), error() {} };

// ── 临时项目骨架：三个独立项目根，分别验三级回落 ─────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbotb-persona-'));

/**
 * 造一个项目根。
 *
 * @param {string} name 目录名
 * @param {object} [opts] 选项 { roleText, rules, media }
 * @returns {string} 项目根路径
 */
function makeProject(name, opts = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'role'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_unpack', 'data'), { recursive: true });
  if (opts.roleText !== undefined) {
    fs.writeFileSync(path.join(dir, '_unpack', 'data', 'config.json'), JSON.stringify({ persona: { roleText: opts.roleText } }), 'utf8');
  }
  if (opts.rules) fs.writeFileSync(path.join(dir, 'role', 'nav-rules.md'), opts.rules, 'utf8');
  if (opts.media) fs.writeFileSync(path.join(dir, 'role', 'media-rules.md'), opts.media, 'utf8');
  return dir;
}

console.log('\n一、工具函数');
const sections = splitSections('# 标题\n\n## 甲\n内容甲\n\n## 乙\n内容乙');
check('按 ## 切段（一级标题归首段）', sections.length === 2 && sections[0].title === '甲', JSON.stringify(sections.map((s) => s.title)));
check('段正文含标题行', sections[1].body.startsWith('## 乙'));
check('空文本零段', splitSections('').length === 0);
check('looksLikeRoleText：太短不算', looksLikeRoleText('## 甲\n短') === false);
check('looksLikeRoleText：有 ## 且够长算', looksLikeRoleText(`## 甲\n${'字'.repeat(300)}`) === true);

console.log('\n二、第一级：业务面 roleText');
const busText = `## 开关\n${'业务面开关段'.repeat(20)}\n\n## 判断\n${'业务面判断段'.repeat(20)}`;
const p1 = createPersonaService({ log, projectDir: makeProject('biz', { roleText: busText }) });
const snap1 = p1.snapshot();
check('source=business', snap1.source === 'business', snap1.source);
check('字数与原文一致', snap1.chars === busText.length, `${snap1.chars} vs ${busText.length}`);
check('段清单读到两段', snap1.sections.length === 2, JSON.stringify(snap1.sections));
check('无回落备注', snap1.note === '', snap1.note);

console.log('\n三、第二级：role/*.md 回落 + 出声');
warns.length = 0;
const rulesText = '# 领航员完整教材\n\n## 判断\n文件判断段\n\n## 投递\n文件投递段';
const p2 = createPersonaService({ log, projectDir: makeProject('files', { rules: rulesText, media: '# 生成\n\n## 生成\n媒体段' }) });
const snap2 = p2.snapshot();
check('source=files', snap2.source === 'files', snap2.source);
check('一级标题被剥掉', !p2.roleText().startsWith('# 领航员完整教材'), p2.roleText().slice(0, 20));
check('两件教材拼接', p2.roleText().includes('文件判断段') && p2.roleText().includes('媒体段'));
check('备注写明缺席文件', snap2.note.includes('blocked-rules.md'), snap2.note);
check('回落未出声（不是内置集）', !warns.some((w) => w.includes('内置')), JSON.stringify(warns));

console.log('\n四、第三级：内置最小集 + 必出声');
warns.length = 0;
const p3 = createPersonaService({ log, projectDir: makeProject('empty', {}) });
const snap3 = p3.snapshot();
check('source=builtin', snap3.source === 'builtin', snap3.source);
check('内置集可用（含判断口径）', p3.roleText().includes('判断') && p3.roleText().length > 100);
check('换源出声（warn 含内置）', warns.some((w) => w.includes('内置最小集')), JSON.stringify(warns));

console.log('\n五、按需文件与判断口径');
check('按需文件可读', p2.file('nav-rules.md').includes('文件判断段'));
check('带 role/ 前缀也认', p2.file('role/nav-rules.md').includes('文件判断段'));
check('白名单外的名字拒绝', p2.file('../config.js') === '' && p2.file('secret.md') === '');
check('缺文件返回空串', p2.file('blocked-rules.md') === '');
const hint = p2.classifyHint();
check('判断口径只取判断/开关段', hint.includes('文件判断段') && !hint.includes('文件投递段'), hint.slice(0, 40));
check('无判断段时回落内置集', p3.section('不存在的标题') === null);

console.log('\n六、快照与刷新');
check('快照不含全文', !('roleText' in snap2));
const beforeAt = p2.snapshot().at;
fs.writeFileSync(path.join(root, 'files', 'role', 'nav-rules.md'), '# 改过\n\n## 判断\n新判断段', 'utf8');
const refreshed = p2.refresh();
check('刷新后读到新内容', refreshed.chars > 0 && p2.roleText().includes('新判断段'));
check('刷新时间戳推进', refreshed.at >= beforeAt);
check('快照带 roleDir', typeof snap2.roleDir === 'string' && snap2.roleDir.endsWith('role'));

// 清理
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
