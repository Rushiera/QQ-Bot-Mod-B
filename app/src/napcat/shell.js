// napcat/shell.js —— 协议端目录布局与配置面
//
// 职责：定位 NapCat 的文件与配置，读写它自己的配置（WebUI / 运行 / OneBot）。
// 边界：端口与 token 一律以协议端配置文件为准——本程序不另立一份同名参数。
// 注意：运行配置分两层——全局 napcat.json 与账号级 napcat_<uin>.json；
//       账号级存在时以账号级为准（协议端按账号覆盖全局），改错层等于没改。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析协议端文件布局。
 *
 * @param {string} shellDir 协议端根目录
 * @param {string} uin 登录账号
 * @returns {object} 各文件绝对路径
 */
export function createShellLayout(shellDir, uin) {
  const configDir = path.join(shellDir, 'config');
  return {
    dir: shellDir,
    uin,
    launcher: path.join(shellDir, 'NapCatWinBootMain.exe'),
    qqExe: path.join(shellDir, 'QQ.exe'),
    hookDll: path.join(shellDir, 'NapCatWinBootHook.dll'),
    mainScript: path.join(shellDir, 'napcat.mjs'),
    loadScript: path.join(shellDir, 'loadNapCat.js'),
    patchPackage: path.join(shellDir, 'qqnt.json'),
    configDir,
    logsDir: path.join(shellDir, 'logs'),
    webuiFile: path.join(configDir, 'webui.json'),
    napcatFile: path.join(configDir, 'napcat.json'),
    accountFile: path.join(configDir, `napcat_${uin}.json`),
    onebotFile: path.join(configDir, `onebot11_${uin}.json`)
  };
}

/**
 * 读取 JSON 文件（带 BOM 清理）。
 *
 * @param {string} file 文件路径
 * @returns {object} 解析结果
 */
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

/**
 * 写入 JSON 文件（原子替换：先写临时文件再改名）。
 *
 * @param {string} file 文件路径
 * @param {object} value 内容
 * @returns {void}
 */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 运行配置的生效落点：账号级文件存在时以它为准。
 *
 * @param {object} layout 布局
 * @returns {string} 配置文件路径
 */
export function runtimeConfigTarget(layout) {
  if (fs.existsSync(layout.accountFile)) return layout.accountFile;
  return layout.napcatFile;
}

/**
 * 读 WebUI 配置。
 *
 * @param {object} layout 布局
 * @returns {{host: string, port: number, token: string, disabled: boolean}}
 */
export function readWebui(layout) {
  const raw = readJson(layout.webuiFile);
  return {
    host: String(raw.host || '127.0.0.1'),
    port: Number(raw.port) || 6099,
    token: String(raw.token || ''),
    disabled: !!raw.disableWebUI
  };
}

/**
 * 读运行配置（生效层）。
 *
 * @param {object} layout 布局
 * @returns {object} 原始配置
 */
export function readRuntimeConfig(layout) {
  return readJson(runtimeConfigTarget(layout));
}

/**
 * 写运行配置（生效层）。
 *
 * @param {object} layout 布局
 * @param {object} value 新配置
 * @returns {void}
 */
export function writeRuntimeConfig(layout, value) {
  writeJson(runtimeConfigTarget(layout), value);
}

/**
 * 读 OneBot 网络配置，提取 WebSocket 服务与 HTTP 服务参数。
 *
 * @param {object} layout 布局
 * @returns {{wsPort: number, wsToken: string, httpPort: number, httpToken: string, enabled: boolean}}
 */
export function readOnebot(layout) {
  const raw = readJson(layout.onebotFile);
  const ws = (raw?.network?.websocketServers || []).find((item) => item?.enable) || {};
  const http = (raw?.network?.httpServers || []).find((item) => item?.enable) || {};
  return {
    wsPort: Number(ws.port) || 3001,
    wsToken: String(ws.token || ''),
    httpPort: Number(http.port) || 3000,
    httpToken: String(http.token || ''),
    enabled: !!(ws.port || http.port)
  };
}

/**
 * 关闭协议端自带的控制台日志输出。
 *
 * 幂等：已是目标值时不写盘。返回是否发生了修改。
 *
 * @param {object} layout 布局
 * @returns {boolean} 是否修改
 */
export function disableConsoleLog(layout) {
  const raw = readRuntimeConfig(layout);
  if (raw.consoleLog === false) return false;
  raw.consoleLog = false;
  writeRuntimeConfig(layout, raw);
  return true;
}

/**
 * 打开文件日志（供本程序采集协议端日志）。
 *
 * @param {object} layout 布局
 * @param {string} level 日志级别
 * @returns {boolean} 是否修改
 */
export function enableFileLog(layout, level = 'info') {
  const raw = readRuntimeConfig(layout);
  if (raw.fileLog === true && raw.fileLogLevel === level) return false;
  raw.fileLog = true;
  raw.fileLogLevel = level;
  writeRuntimeConfig(layout, raw);
  return true;
}
