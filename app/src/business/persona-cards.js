// persona-cards.js —— 人设卡（角色卡）实体面
//
// 定位：人设的**唯一载体是文件**——一张卡一个 `.md`，路径即实体。
//   `personas/rmiao.md`    R喵（默认人设，从旧 persona.roleText 分离出来的人格层）
//   `personas/yoshino.md`  依田芳乃（外部角色卡，整体导入，内容逐字不动）
//   `personas/_shared.md`  机制与索引（工具面 / 路由 / 遇阻处置 / 领航员速查）——**不随人设变**
//
// 为什么要拆成文件：
//   1. 角色卡是有版权的创作物，整份导入、不在程序里被改写；改人格 = 改文件，不动代码。
//   2. 人设切换（每群一份）只需要记一个 id，不再把几万字正文复制进配置——
//      config.json 只留 `profileId`，卡正文永远只有一份。
//   3. 机制层与人格层分开：换人设只换人格段，工具面 / 路由 / 遇阻处置共用同一份。
//      （2026-11-07 换序：人设段移到系统消息最前——人格获得最高权重，代价是跨群共享
//       前缀变短；取舍与判据见 design-qqbotb_log.md §一百零三）
//
// 装配顺序（消费点见 prompt.js / orchestrator.js）：
//   system  = 【角色设定】卡全文（最前） + 标准提示词（与人格无关） + 机制段（_shared.md）
//   user#1  = 表情包 → 引导说明 → 记忆 → 已读 → 未读 → 时间
//   稳定段在前，易变段在后；人格先于规则（权重口径）。
//
// 写入面：**只有一条**——`writeCard()` 供人设页「看 / 改正文」窗口把编辑结果写回
// `personas/<id>.md`（目录内、原子写、保持 BOM 与换行风格）。本模块不写配置：
// 新增卡 / 换卡路径仍走 `personaProfiles`。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 自有根推导（不 import config.js）——config.js 反过来要用本模块的默认 id，
// 互相 import 会成环。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根（`QQBotB/`）——本文件在 `app/src/business`，上三级即项目根。 */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 人设目录（相对项目根）。 */
export const PERSONA_DIR = 'personas';

/** 共用机制段（相对项目根）。 */
export const SHARED_FILE = 'personas/_shared.md';

/** 默认人设 id。 */
export const DEFAULT_PROFILE_ID = 'rmiao';

/**
 * 内置人设库。config 的 `personaProfiles` 可追加或按 id 覆盖（name / path / note / systemPrompt）。
 *
 * `systemPrompt` 三态（2026-11-07 · 每卡一份系统提示词的入口）：
 * - `'inherit'`（默认）标准提示词照常注入：lead + 风格段；人格/语体由卡与提示词共同决定。
 * - `'self'`    卡**自带**全部人格与说话纪律，标准提示词整段不注入——「系统提示词不适用于这张卡」。
 *               安全规则 / 工具协议 / 机制段属机制面，仍恒追加（卡删不掉它们）。
 * - `'<路径>'`  该文件（相对项目根，如 `personas/foo.prompt.md`）替代 lead + 风格段；其余照旧。
 *
 * @type {Array<{id: string, name: string, path: string, note: string, systemPrompt?: string, jp?: {first: string, second: string}}>}
 */
export const DEFAULT_PROFILES = [
  {
    id: 'rmiao', name: 'R喵', path: 'personas/rmiao.md', note: '默认人设 · 短句群友腔（自带系统提示词）',
    // R喵 的说话纪律整段写进卡里（旧系统提示词的原文），标准提示词对这张卡不生效——
    // 换卡不受影响：本卡怎么说话由本卡说了算，见 design-qqbotb_log.md §一百零八。
    systemPrompt: 'self',
    // 日语译文人称口径（Rushiera 2026-10-26 定，2026-11-07 起按卡分派）——
    // 语音朗读时的人称，与卡的中文语体分开：换了卡，念出来的日文也要跟着换。
    jp: { first: 'わたし', second: 'きみ' }
  },
  {
    id: 'yoshino', name: '依田芳乃', path: 'personas/yoshino.md', note: '角色卡 · 原件整体导入（内容勿改）',
    // 外部角色卡走标准提示词（人格在卡、纪律在提示词）。
    systemPrompt: 'inherit',
    jp: { first: 'わたくし', second: 'そなた' }
  }
];

/** 缺省日语人称口径（未知 / 空 profileId 时用）——等价于 R喵 那套通用口径。 */
export const DEFAULT_JP_PRONOUNS = { first: 'わたし', second: 'きみ' };

/**
 * 取某个 profileId 的日语译文人称口径。
 *
 * @param {string} [profileId] 人设 id（空 / 未知 → 缺省口径）
 * @param {Array} [configured] `config.personaProfiles`（可覆盖内置条的 jp）
 * @returns {{first: string, second: string}} 人称口径
 */
export function jpPronounsOf(profileId, configured) {
  const id = String(profileId || '').trim() || DEFAULT_PROFILE_ID;
  const all = listProfiles(configured);
  const hit = all.find((p) => p.id === id);
  const jp = hit && hit.jp && typeof hit.jp === 'object' ? hit.jp : null;
  const first = String(jp?.first || '').trim() || DEFAULT_JP_PRONOUNS.first;
  const second = String(jp?.second || '').trim() || DEFAULT_JP_PRONOUNS.second;
  return { first, second };
}

/**
 * 相对路径 → 绝对路径（绝对路径原样返回）。
 *
 * @param {string} rel 路径
 * @returns {string} 绝对路径
 */
function absoluteOf(rel) {
  const value = String(rel || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

/**
 * 读一份文本文件（去掉 BOM）。读不到返回空串——调用方按"卡缺失"出声，不静默顶替。
 *
 * @param {string} rel 相对项目根的路径
 * @returns {string} 正文
 */
export function readText(rel) {
  const file = absoluteOf(rel);
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

/**
 * 人设库全量（内置 + 配置追加 / 覆盖），带 `chars` 与 `exists`。
 *
 * 配置里同 id 的条目按字段覆盖内置（想改显示名或换成自己的卡，不必动代码）。
 *
 * @param {Array} [configured] `config.personaProfiles`
 * @returns {Array<{id: string, name: string, path: string, note: string, chars: number, exists: boolean}>}
 */
export function listProfiles(configured) {
  const byId = new Map();
  for (const item of DEFAULT_PROFILES) byId.set(item.id, { ...item });
  if (Array.isArray(configured)) {
    for (const raw of configured) {
      const id = String(raw?.id || '').trim();
      if (!id) continue;
      const base = byId.get(id) || { id, name: id, path: '', note: '' };
      byId.set(id, {
        ...base,
        name: String(raw?.name ?? base.name).trim() || base.name,
        path: String(raw?.path ?? base.path).trim() || base.path,
        note: String(raw?.note ?? base.note ?? '').trim(),
        // 系统提示词来源三态（'inherit' / 'self' / 相对路径）——配置可覆盖内置条目
        systemPrompt: String(raw?.systemPrompt ?? base.systemPrompt ?? 'inherit').trim() || 'inherit'
      });
    }
  }
  return [...byId.values()].map((item) => {
    const text = readText(item.path);
    return { ...item, chars: text.length, exists: text.length > 0 };
  });
}

/**
 * 按 id 取一张卡的正文。
 *
 * @param {string} id 人设 id
 * @param {Array} [configured] `config.personaProfiles`
 * @returns {{id: string, name: string, path: string, text: string, systemPrompt: string}} 卡（缺失时 text 为空串）
 */
export function readCard(id, configured) {
  const list = listProfiles(configured);
  const wanted = String(id || '').trim() || DEFAULT_PROFILE_ID;
  const hit = list.find((p) => p.id === wanted);
  if (!hit) return { id: wanted, name: wanted, path: '', text: '', systemPrompt: 'inherit' };
  return {
    id: hit.id,
    name: hit.name,
    path: hit.path,
    text: readText(hit.path),
    systemPrompt: String(hit.systemPrompt || 'inherit').trim() || 'inherit'
  };
}

// ── 写回（人设页「看 / 改正文」窗口）────────────────────────────────────
// 卡正文可以在界面里改，但写入面只有一条：落到 `personas/` 内的卡文件。

/** 人设目录的绝对路径——写回的唯一允许范围。 */
const PERSONA_ROOT = path.join(PROJECT_ROOT, PERSONA_DIR);

/** 单张卡正文长度上限（字符）——超出按非法参数拒绝（防误贴巨物）。 */
export const CARD_MAX_CHARS = 200000;

/**
 * 造一个带 `code` 的错误（路由按 code 分派状态码，界面按 message 出声）。
 *
 * @param {string} code 错误码
 * @param {string} message 人话原因
 * @returns {Error} 错误
 */
function cardError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 写回一张卡的正文（人设页「看 / 改正文」窗口的保存动作）。
 *
 * 拒绝面（不静默修正）：id 未登记 / 路径空 / 目标不在 `personas/` 内 / 正文为空 / 超上限。
 * 落盘：临时文件 + rename（原子，不留半截卡）；保持原文件的 BOM 与换行风格
 * （前端 `textarea` 会把值规范成 LF，直接落盘会把 CRLF 卡整体改写）。
 *
 * @param {string} id 人设 id
 * @param {string} text 新正文
 * @param {Array} [configured] `config.personaProfiles`
 * @returns {{id: string, path: string, chars: number, crlf: boolean}} 写回实况
 * @throws {Error} `code` ∈ `CARD_UNKNOWN` / `CARD_PATH_EMPTY` / `CARD_OUT_OF_DIR` / `CARD_EMPTY` / `CARD_TOO_LONG` / `CARD_WRITE_FAILED`
 */
export function writeCard(id, text, configured) {
  const wanted = String(id || '').trim();
  const hit = listProfiles(configured).find((p) => p.id === wanted);
  if (!hit) throw cardError('CARD_UNKNOWN', `人设库里没有这张卡：${wanted || '(空 id)'}`);
  if (!hit.path) throw cardError('CARD_PATH_EMPTY', `人设卡没有配路径：${hit.id}`);
  const file = absoluteOf(hit.path);
  const rel = path.relative(PERSONA_ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw cardError('CARD_OUT_OF_DIR', `只允许写 ${PERSONA_DIR}/ 里的卡：${hit.path}`);
  }
  const body = String(text == null ? '' : text);
  if (!body.trim()) throw cardError('CARD_EMPTY', '人设卡正文不能为空');
  if (body.length > CARD_MAX_CHARS) {
    throw cardError('CARD_TOO_LONG', `人设卡正文超上限：${body.length} > ${CARD_MAX_CHARS} 字`);
  }

  // 原文件的 BOM 与换行风格要保住——「只改内容，不改字节风格」
  let bom = false;
  let crlf = false;
  try {
    const raw = fs.readFileSync(file);
    bom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
    crlf = raw.includes('\r\n');
  } catch {
    // 文件刚被删 / 从没存在：按无 BOM + LF 落盘——不冒充原状
  }
  const out = (bom ? '\uFEFF' : '') + (crlf ? body.replace(/\r?\n/g, '\r\n') : body);

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清不掉不掩盖主错误 */ }
    throw cardError('CARD_WRITE_FAILED', `人设卡写盘失败：${String(error?.message ?? error)}`);
  }
  return { id: hit.id, path: hit.path, chars: body.length, crlf };
}

/**
 * 共用机制段正文（`personas/_shared.md`）。
 *
 * @returns {string} 正文（缺失时为空串——调用方据此在预览面出声）
 */
export function sharedText() {
  return readText(SHARED_FILE).trim();
}

/**
 * 取某个 persona 配置实际生效的人设 id（空 = 默认人设）。
 *
 * @param {object} persona 合并后的 persona（`personaForChatOf` 的产物）
 * @returns {string} 人设 id
 */
export function profileIdOf(persona) {
  const id = String(persona?.profileId ?? '').trim();
  return id || DEFAULT_PROFILE_ID;
}
