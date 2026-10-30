// verify-qqagent-navtools.mjs — 「领航员工具组」自测（含图像编辑 comfy_edit）
//
// 用法：node verify-qqagent-navtools.mjs
// 判据：
//   1 补丁落盘：标记齐全 + nav-tools.js 在位
//   2 工具注册：领航员工具组 14 件经 tools.js 真实入口（buildToolDefs）进 registry
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
const APP = path.resolve(HERE, '..', 'app');
const BIZ = path.resolve(APP, 'src/business');   // 业务面（R2 归位）
const DATA = path.join(os.tmpdir(), 'qqagent-navtools-selftest');
const SRC_CFG = path.resolve(HERE, '..', '_unpack', 'data', 'config.json');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SRC_CFG)) fs.copyFileSync(SRC_CFG, path.join(DATA, 'config.json'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const mod = (rel) => pathToFileURL(path.join(BIZ, rel)).href;
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
  'nav_health', 'nav_analyze', 'nav_shot', 'nav_new', 'nav_reset', 'comfy_edit',
  'moss_draw', 'tts_speak', 'wd_tag'
];

// ── 0 补丁落盘 ──────────────────────────────────────────────────────────────
const toolsSrc = fs.readFileSync(path.join(BIZ, 'tools.js'), 'utf8');
check('补丁标记·import', toolsSrc.includes('[qqagent-navigator-patch:tools-import]'));
check('补丁标记·register', toolsSrc.includes('[qqagent-navigator-patch:tools-register]'));
check('模块在位·nav-tools.js', fs.existsSync(path.join(BIZ, 'nav-tools.js')));

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

// ── 2a 生成能力三件定义面（v0.79）──────────────────────────────────────────
const mossDef = getTool('moss_draw');
check('moss_draw·参数面（prompt 必填 / size+seed 可选）',
  !!mossDef && Array.isArray(mossDef.parameters?.required) && mossDef.parameters.required.includes('prompt')
  && !!mossDef.parameters?.properties?.size && !!mossDef.parameters?.properties?.seed,
  mossDef ? JSON.stringify(mossDef.parameters.required) : '未注册');
check('moss_draw·描述含触发词与分界',
  !!mossDef && mossDef.description.includes('画一张') && mossDef.description.includes('comfy_edit'));

const ttsDef = getTool('tts_speak');
check('tts_speak·参数面（text 必填 / caption 可选）',
  !!ttsDef && Array.isArray(ttsDef.parameters?.required) && ttsDef.parameters.required.includes('text')
  && !!ttsDef.parameters?.properties?.caption,
  ttsDef ? JSON.stringify(ttsDef.parameters.required) : '未注册');
check('tts_speak·描述含自动翻日语',
  !!ttsDef && ttsDef.description.includes('自动翻译成日语'));

const wdDef = getTool('wd_tag');
check('wd_tag·参数面（messageId 可选）',
  !!wdDef && Array.isArray(wdDef.parameters?.required) && wdDef.parameters.required.length === 0
  && !!wdDef.parameters?.properties?.messageId,
  wdDef ? JSON.stringify(wdDef.parameters.required) : '未注册');
check('wd_tag·描述含反推提示词',
  !!wdDef && wdDef.description.includes('反推提示词'));

// ── 2b nav_reset 定义面：固定代读猫 + rescue 已退役（Rushiera 2026-10-30）──────
const resetDef = getTool('nav_reset');
check('nav_reset·定义面（固定代读猫 / rescue 保留但不需传）',
  !!resetDef && !!resetDef.parameters?.properties?.rescue
  && !(resetDef.parameters.required || []).includes('rescue')
  && resetDef.description.includes('固定代读猫') && resetDef.description.includes('已退役'),
  resetDef ? JSON.stringify(resetDef.parameters.required) : '未注册');

// ── 2c nav_shot 定义面：截图会话（key 必填 + 描述含「会话卡」）──────────────
const shotDef = getTool('nav_shot');
check('nav_shot·定义面（key 必填 / 描述含会话卡）',
  !!shotDef && Array.isArray(shotDef.parameters?.required) && shotDef.parameters.required.includes('key')
  && shotDef.description.includes('会话卡'),
  shotDef ? JSON.stringify(shotDef.parameters.required) : '未注册');

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

// ── 4 生成能力三件执行面（不触网）──────────────────────────────────────────
const mossNoPrompt = await mossDef.execute(ctx, {});
check('moss_draw·空提示词报错退出',
  mossNoPrompt.isError === true && String(mossNoPrompt.content).includes('prompt'), String(mossNoPrompt.content));
const ttsNoText = await ttsDef.execute(ctx, {});
check('tts_speak·空台词报错退出',
  ttsNoText.isError === true && String(ttsNoText.content).includes('text'), String(ttsNoText.content));
const wdNoImage = await wdDef.execute(ctx, {});
check('wd_tag·本群无带图消息即出声',
  wdNoImage.isError === true && String(wdNoImage.content).includes('带图的消息'), String(wdNoImage.content));

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
