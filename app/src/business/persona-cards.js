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
//   3. 机制层与人格层分开：换人设只换人格，工具面 / 路由 / 遇阻处置共用同一份，
//      系统提示词的前缀字节保持不变（缓存命中不被换人设打断）。
//
// 装配顺序（消费点见 prompt.js）：
//   system  = 标准提示词（与人格无关） + 机制段（_shared.md）
//   user#1  = 【角色设定】卡全文 → 表情包 → 引导说明 → 记忆 → 已读 → 未读 → 时间
//   稳定段在前，易变段在后；换人设只动 user 开头那一段。
//
// 本模块只读文件，不写配置、不改卡内容。

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
 * 内置人设库。config 的 `personaProfiles` 可追加或按 id 覆盖（name / path / note）。
 *
 * @type {Array<{id: string, name: string, path: string, note: string}>}
 */
export const DEFAULT_PROFILES = [
  { id: 'rmiao', name: 'R喵', path: 'personas/rmiao.md', note: '默认人设 · 短句群友腔' },
  { id: 'yoshino', name: '依田芳乃', path: 'personas/yoshino.md', note: '角色卡 · 原件整体导入（内容勿改）' }
];

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
        note: String(raw?.note ?? base.note ?? '').trim()
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
 * @returns {{id: string, name: string, path: string, text: string}} 卡（缺失时 text 为空串）
 */
export function readCard(id, configured) {
  const list = listProfiles(configured);
  const wanted = String(id || '').trim() || DEFAULT_PROFILE_ID;
  const hit = list.find((p) => p.id === wanted);
  if (!hit) return { id: wanted, name: wanted, path: '', text: '' };
  return { id: hit.id, name: hit.name, path: hit.path, text: readText(hit.path) };
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
