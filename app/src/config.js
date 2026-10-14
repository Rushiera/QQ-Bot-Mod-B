// config.js —— 配置读写
//
// 职责：解析路径基准 → 加载默认配置 → 叠加 data/config.json 覆盖 → 暴露读写接口。
// 边界：协议端自身的参数（WebUI 端口与 token、OneBot 端口与 token）不在此重复声明——
//       运行时从 NapCat 自己的配置文件读取（单点真相源，避免两处配置漂移）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** 应用根目录（app/）。 */
export const APP_DIR = path.resolve(moduleDir, '..');

/** 项目根目录（QQBotB/）。 */
export const PROJECT_DIR = path.resolve(APP_DIR, '..');

/** 数据根目录（app/data/）。 */
export const DATA_DIR = path.join(APP_DIR, 'data');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 默认配置——用户可用 data/config.json 覆盖单项，未提交字段保持默认。 */
const DEFAULTS = {
  app: {
    port: 3280,
    autostartNapcat: true
  },
  napcat: {
    shellDir: path.join(PROJECT_DIR, 'runtime', 'NapCat', 'NapCat.52230.Shell'),
    uin: '2405997337'
  },
  onebot: {
    autoConnect: true,
    reconnectMs: 3000
  },
  // 业务伴生进程（QQ Agent）——入口换成自研单体后，业务面由本应用按需拉起。
  // exe / cwd 都显式给出：绝不让它继承本应用的 cwd（判例 2026-10-10 工作目录钉死）。
  companion: {
    enabled: true,
    exe: path.join(PROJECT_DIR, '_unpack', 'QQ Agent.exe'),
    cwd: path.join(PROJECT_DIR, '_unpack')
  },
  // 领航员模式（design-qqbotb-navigator.md）——QQ 群指挥 CH4 猫群。
  // mainPort / vipUser / idleCloseMs 是行为参数；services 是开启回执的健康检查清单
  // （url 空 = 未接入，回执显示「未接入」）。
  navigator: {
    enabled: true,
    mainPort: 8080,
    vipUser: '569145850',
    idleCloseMs: 180 * 60 * 1000,
    // 开场巡检最多截几只猫（0 = 不限——开启时把有会话的猫全部发一遍）
    tourLimit: 0,
    // 前文整理重启：注入新会话的原文轨迹条数（0 = 不限）——「少量缩减」口径，保留近期原文
    resetTraceLimit: 100,
    // 投递指令后自动做一次「猫会话分析」的延迟毫秒（0 = 关闭）——静默执行的反馈替代
    analyzeDelayMs: 60 * 1000,
    services: [
      { key: 'ApiSiteAnalyzer', name: 'ApiSiteAnalyzer', kind: 'apisite', url: 'http://127.0.0.1:8766/api/sites' },
      { key: 'ComfyDock', name: 'ComfyDock', kind: 'comfydock', url: 'http://127.0.0.1:8971/api/summary' }
    ],
    // 图像编辑（design-qqbotb-navigator.md §十八）——把群里的图送上 ComfyDock 的
    // 「[生成]」工作区改图，出图自动回群。前置：领航员已开启 + ComfyDock 在线。
    comfy: {
      enabled: true,
      endpoint: 'http://127.0.0.1:8971',
      workspaceId: 'gen',
      pollMs: 5000,
      timeoutMs: 15 * 60 * 1000,
      // 请求者闸——先收成只有 VIP 本人能用（Rushiera 2026-10-11）；白名单以后做
      requireVip: true
    }
  }
};

/**
 * 递归合并：以 defaults 为骨架，用 patch 覆盖同名叶子。
 *
 * @param {object} base 骨架对象
 * @param {object} patch 覆盖对象
 * @returns {object} 合并结果（新对象）
 */
function mergeDeep(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = mergeDeep(base?.[key], patch[key]);
  }
  return out;
}

/**
 * 读取磁盘配置（无文件时返回空对象）。
 *
 * @returns {object} 磁盘配置片段
 */
function readFileConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (error) {
    // 配置损坏时不得静默回落默认值——把问题亮出来，由调用方决定是否继续
    throw new Error(`配置读取失败（${CONFIG_FILE}）：${error?.message ?? error}`);
  }
}

/**
 * 加载生效配置（默认值 + 磁盘覆盖）。
 *
 * @returns {object} 生效配置
 */
export function loadConfig() {
  return mergeDeep(DEFAULTS, readFileConfig());
}

/**
 * 写入配置片段（与现有磁盘内容合并后落盘）。
 *
 * @param {object} patch 待写入片段
 * @returns {object} 落盘后的完整配置
 */
export function saveConfig(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = mergeDeep(loadConfig(), patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 配置文件的绝对路径（供界面展示）。 */
export const CONFIG_PATH = CONFIG_FILE;
