// patch-qqbotb-balance.mjs — 「群名片余额后缀」幂等补丁（2026-10-25 · v0.85）
//
// 用法：
//   node tools/patch-qqbotb-balance.mjs            幂等打补丁（已打过的点 skipped）
//   node tools/patch-qqbotb-balance.mjs --dry      只报不写
//   node tools/patch-qqbotb-balance.mjs --audit    校验段库与磁盘逐字一致（防模板漂移）
//   node tools/patch-qqbotb-balance.mjs --strip    逆向还原（把片段换回锚点）——配合 --app 在副本上验可复现
//   node tools/patch-qqbotb-balance.mjs --app=<app 根绝对路径>   （默认 _unpack/resources/app）
//
// 做什么（Rushiera 2026-10-25 定：载体 = 群名片 · 原名片 + 尾部追加 · 启动即刷 + 每 30 分钟）：
//   1 新增 src/balance.js（从 tools/templates/balance.js 复制——模板即源码，不内嵌拼字符串）
//   2 src/config.js      engage.balance 默认段（默认全关 · 映射接口占位）
//   3 src/app.js         import + 启动链 startBalanceLoop(onebot)
//   4 src/routes.js      import + POST /api/balance/sync
//   5 ui/app/05-memory-settings.js  列表徽标 / 详情控件 / 事件绑定 / 三个写面函数
//
// 为什么是补丁：`_unpack/` 不入 git（.gitignore:11），运行副本改动的唯一重放通道就是本脚本。
// 片段库：tools/templates/balance-patches.txt（零转义纯文本，段头 `@@@ <id>|<mode>|<rel>|<sep>`）。
// 幂等：每段带唯一标记 [qqbotb-balance:<id>]；文件已含标记 = skipped。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'templates', 'balance-patches.txt');
const TEMPLATE_MODULE = path.join(HERE, 'templates', 'balance.js');
const DRY = process.argv.includes('--dry');
const AUDIT = process.argv.includes('--audit');
const STRIP = process.argv.includes('--strip');
const appArg = process.argv.find((a) => a.startsWith('--app='));
const APP = appArg ? path.resolve(appArg.slice('--app='.length)) : path.resolve(HERE, '..', '_unpack', 'resources', 'app');

/** 锚点表（id → 打补丁前的原文；唯一命中否则报错）。 */
const ANCHORS = {
  config: '    signals: { enabled: false, floor: 0.15 }\n  },',
  'app-import': "import { startHealLoop as startRapportHeal } from './rapport.js';",
  'app-start': '    startRapportHeal();',
  'routes-import': "import { readLogStats } from './readlog.js';",
  'routes-sync': "    {\n      method: 'GET', pattern: '/api/sessions',",
  'ui-list-badge': '    })();\n    // [qqagent-memory-patch:ui-list-sub]',
  'ui-list-html': '          ${levelHtml}<!-- [qqagent-level-patch:ui-list-html] -->',
  'ui-detail-head': '        + \'</select>\'\n      : \'\';',
  'ui-detail-html': '          ${levelSelectHtml}<!-- [qqagent-level-patch:ui-detail-html] -->',
  'ui-detail-bind': [
    "    const levelSelEl = detail.querySelector('#mem-level-sel');",
    "    if (levelSelEl && kind === 'group') {",
    '      levelSelEl.addEventListener(\'change\', (e) => {',
    '        e.preventDefault();',
    '        e.stopPropagation();',
    '        setEngageLevel(chatId, chatKey, Number(levelSelEl.value));',
    '      });',
    '    }'
  ].join('\n'),
  'ui-fns': '/** 五档档名（与 config.engage.levels 默认表一致；UI 只作显示，判定在 src 侧）。[qqagent-level-patch:ui-helpers] */'
};

const results = [];
const mark = (id) => '[qqbotb-balance:' + id + ']';

/** 探测文件换行风格（应用源码是 CRLF；片段库一律 LF）。 */
function detectEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 解析片段库：@@@ id|mode|rel|sep 之后到下一段头之间的正文。 */
function loadSegments() {
  const raw = fs.readFileSync(LIB, 'utf8');
  const segs = [];
  for (const block of raw.split(/^@@@ /m).slice(1)) {
    const nl = block.indexOf('\n');
    if (nl < 0) continue;
    const head = block.slice(0, nl).trim().split('|');
    const body = block.slice(nl + 1).replace(/\n+$/, '');
    segs.push({ id: head[0], mode: head[1] || 'after', rel: head[2], sep: head[3] || '', body });
  }
  return segs;
}

/** 按 mode 组装最终文本（锚点 + 片段）。 */
function compose(seg, anchor) {
  const gap = seg.sep === 'blank' ? '\n\n' : '\n';
  switch (seg.mode) {
    case 'replace': return seg.body;
    case 'before': return seg.body + gap + anchor;
    case 'after': return anchor + gap + seg.body;
    default: throw new Error('未知 mode：' + seg.mode);
  }
}

const segs = loadSegments();

for (const seg of segs) {
  const anchor = ANCHORS[seg.id];
  if (!anchor) throw new Error('[' + seg.id + '] 缺锚点定义');
  const file = path.join(APP, seg.rel);
  const text = fs.readFileSync(file, 'utf8');
  const eol = detectEol(file);
  const full = toEol(compose(seg, anchor), eol);
  const markText = mark(seg.id);

  if (AUDIT) {
    const hit = text.includes(full);
    results.push({ id: seg.id, file: seg.rel, status: hit ? 'audit-ok' : 'audit-MISMATCH' });
    if (!hit) process.exitCode = 1;
    continue;
  }

  if (STRIP) {
    if (!text.includes(full)) { results.push({ id: seg.id, file: seg.rel, status: 'strip-miss' }); continue; }
    if (!DRY) fs.writeFileSync(file, text.replace(full, () => toEol(anchor, eol)), 'utf8');
    results.push({ id: seg.id, file: seg.rel, status: DRY ? 'strip-dry' : 'stripped' });
    continue;
  }

  if (text.includes(markText)) { results.push({ id: seg.id, file: seg.rel, status: 'skipped' }); continue; }
  const a = toEol(anchor, eol);
  const hits = text.split(a).length - 1;
  if (hits !== 1) throw new Error('[' + seg.id + '] 锚点命中 ' + hits + ' 次（期望 1）');
  if (!DRY) fs.writeFileSync(file, text.replace(a, () => full), 'utf8');
  results.push({ id: seg.id, file: seg.rel, status: DRY ? 'dry' : 'applied' });
}

// ── 新文件：src/balance.js（模板即源码，复制而非内嵌）────────────────────────
const dstModule = path.join(APP, 'src', 'balance.js');
if (fs.existsSync(dstModule)) {
  results.push({ id: 'module', file: 'src/balance.js', status: 'exist' });
} else if (DRY) {
  results.push({ id: 'module', file: 'src/balance.js', status: 'dry' });
} else {
  fs.writeFileSync(dstModule, fs.readFileSync(TEMPLATE_MODULE));
  results.push({ id: 'module', file: 'src/balance.js', status: 'copied' });
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
for (const r of results) console.log('  ' + r.status.padEnd(14) + r.id.padEnd(16) + r.file);
console.log('APP=' + APP);
console.log(Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · '));
