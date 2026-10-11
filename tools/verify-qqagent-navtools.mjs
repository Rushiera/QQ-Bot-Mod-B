// verify-qqagent-navtools.mjs — 「领航员工具组」自测（含图像编辑 comfy_edit）
//
// 用法：node verify-qqagent-navtools.mjs
// 判据：
//   1 补丁落盘：标记齐全 + nav-tools.js 在位
//   2 工具注册：领航员工具组 10 件经 tools.js 真实入口（buildToolDefs）进 registry
//   3 comfy_edit 定义面：参数面（prompt 必填 / messageId 可选）+ 描述含前置两条
//   4 comfy_edit 执行面：空提示词 / 本群没有带图消息 → 报错退出（不触网）
//
// 隔离：QQ_AGENT_DATA_DIR 指向独立副本——不碰正在运行实例的数据目录，也不抢单实例锁。
// LLM：不调用。外部依赖：无（不提交任何生成任务）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '_unpack', 'resources', 'app');
const DATA = path.join(os.tmpdir(), 'qqagent-navtools-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(APP, 'src', rel)).href;
const { getTool, listTools } = await import(mod('tool-registry.js'));
const { buildToolDefs } = await import(mod('tools.js'));

const results = [];
/**
 * 记录一条断言。
 *
 * @param {string} name 项名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 说明
 * @returns {void}
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const NAV_TOOL_IDS = [
  'nav_status', 'nav_open', 'nav_close', 'nav_send', 'nav_detail',
  'nav_health', 'nav_analyze', 'nav_new', 'nav_reset', 'comfy_edit'
];

// ── 0 补丁落盘 ──────────────────────────────────────────────────────────────
const toolsSrc = fs.readFileSync(path.join(APP, 'src', 'tools.js'), 'utf8');
check('补丁标记·import', toolsSrc.includes('[qqagent-navigator-patch:tools-import]'));
check('补丁标记·register', toolsSrc.includes('[qqagent-navigator-patch:tools-register]'));
check('模块在位·nav-tools.js', fs.existsSync(path.join(APP, 'src', 'nav-tools.js')));

// ── 1 工具注册（走真实入口）─────────────────────────────────────────────────
buildToolDefs();
const ids = new Set(listTools().map((t) => t.id));
const missing = NAV_TOOL_IDS.filter((id) => !ids.has(id));
check(`工具组注册（${NAV_TOOL_IDS.length} 件）`, missing.length === 0, missing.join(' '));

// ── 2 comfy_edit 定义面 ────────────────────────────────────────────────────
const def = getTool('comfy_edit');
check('comfy_edit·参数面（prompt 必填 / messageId 可选）',
  !!def && Array.isArray(def.parameters?.required) && def.parameters.required.includes('prompt')
  && !!def.parameters?.properties?.messageId,
  def ? JSON.stringify(def.parameters.required) : '未注册');
check('comfy_edit·描述含前置两条',
  !!def && def.description.includes('领航员已开启') && def.description.includes('ComfyDock 在线'));

// ── 3 comfy_edit 执行面（不触网）────────────────────────────────────────────
const ctx = {
  chatKey: 'group:selftest',
  store: { findByMid: () => null, recent: () => [] }
};
const noPrompt = await def.execute(ctx, {});
check('comfy_edit·空提示词报错退出', noPrompt.isError === true && String(noPrompt.content).includes('prompt'), String(noPrompt.content));
const noImage = await def.execute(ctx, { prompt: '把这张图做成三视图' });
check('comfy_edit·本群无带图消息即出声',
  noImage.isError === true && String(noImage.content).includes('带图的消息'), String(noImage.content));

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
