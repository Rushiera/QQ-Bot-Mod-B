// main.js —— Electron 主进程入口
//
// 职责：拉起应用内核（HTTP 服务 + 协议端宿主 + OneBot 连接）、开主窗口、托盘常驻。
// 边界：业务能力全在 src/ 下——本文件只管进程与窗口生命周期。

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const BOOT_LOG = path.join(moduleDir, 'data', 'boot.log');

// 工作目录钉死（判例 2026-10-10）：绝不继承启动者的 cwd——被从别处拉起就会把那个目录
// 锁住（宿主自更新部署会因此失败）。主进程与它拉起的全部子进程都钉在 app/ 下。
try {
  process.chdir(moduleDir);
} catch (error) {
  bootLog(`工作目录钉死失败：${String(error?.message ?? error)}`);
}

/**
 * 启动诊断：GUI 进程的 stdout 不落控制台，启动期问题只能靠文件取证。
 *
 * @param {string} message 诊断内容
 * @returns {void}
 */
function bootLog(message) {
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch { /* 诊断失败不阻塞启动 */ }
}

bootLog(`main.js 已加载（electron ${process.versions.electron} / node ${process.versions.node}）`);

let mainWindow = null;
let tray = null;
let core = null;
let quitting = false;

/**
 * 显示主窗口（最小化时还原）。
 *
 * @returns {void}
 */
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 创建主窗口。
 *
 * @param {number} port 界面端口
 * @returns {void}
 */
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'QQBot mod B',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch(() => { /* 失败由 did-fail-load 兜底 */ });

  // 协议端控制台免登录：iframe 加载完成后把凭据写进它的 localStorage（token 键），
  // 再让该 frame 自刷新——用户打开子页就是已登录状态，不用去翻启动日志找密钥。
  const injectedFrames = new Set();
  mainWindow.webContents.on('did-frame-finish-load', async () => {
    if (!core || !mainWindow) return;
    for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/webui/.test(frame.url)) continue;
      if (injectedFrames.has(frame.url)) continue;
      injectedFrames.add(frame.url);
      try {
        const credential = await core.webuiCredential();
        if (!credential) {
          bootLog('协议端控制台凭据为空，跳过自动登录');
          continue;
        }
        await frame.executeJavaScript(
          `localStorage.setItem('token', ${JSON.stringify(credential)}); location.reload();`
        );
        bootLog('已注入协议端控制台凭据（自动登录）');
      } catch (error) {
        bootLog(`协议端控制台凭据注入失败：${String(error?.message ?? error)}`);
      }
    }
  });
  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 1500);
  });

  // 外链一律交给系统浏览器；主窗口只停留本机界面
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(String(url || ''))) {
      event.preventDefault();
    }
  });

  // 关窗只收进托盘——协议端与机器人继续跑，真正退出走托盘菜单
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * 创建托盘。
 *
 * @returns {void}
 */
function createTray() {
  let image = nativeImage.createEmpty();
  try {
    image = nativeImage.createFromPath(path.join(core.layout.dir, 'static', 'favicon.ico'));
  } catch { /* 图标缺失时用空图 */ }
  tray = new Tray(image);
  tray.setToolTip('QQBot mod B');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { type: 'separator' },
    { label: '退出（协议端保持运行）', click: () => { quitting = true; app.quit(); } },
    {
      label: '退出并停止协议端',
      click: async () => {
        quitting = true;
        try { await core.stopNapcat(); } catch { /* 停止失败不阻塞退出 */ }
        app.quit();
      }
    }
  ]));
  tray.on('click', () => showWindow());
}

app.whenReady().then(async () => {
  bootLog('whenReady 已触发');
  try {
    core = await createApp();
    bootLog('应用内核已创建');
    const port = await core.start();
    bootLog(`界面服务已启动，端口 ${port}`);
    createWindow(port);
    bootLog('主窗口已创建');

    // 壳层能力：截图——开发期验证界面渲染，经 /api/debug/screenshot 触发
    core.hooks.capture = async (tab) => {
      if (!mainWindow) throw new Error('主窗口未就绪');
      if (tab) {
        await mainWindow.webContents.executeJavaScript(`switchView(${JSON.stringify(tab)})`);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const image = await mainWindow.webContents.capturePage();
      const file = path.join(moduleDir, 'data', 'screenshot.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, image.toPNG());
      return file;
    };
    // 壳层能力：领航员截图——离屏窗口加载渲染好的对话卡 HTML，按内容高度整页截图
    core.hooks.shot = async (htmlFile, outFile) => {
      const win = new BrowserWindow({
        width: 800,
        height: 900,
        show: false,
        backgroundColor: '#0f1115',
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      });
      try {
        await win.loadFile(htmlFile);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const height = await win.webContents.executeJavaScript(
          'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
        );
        const target = Math.min(Math.max(Number(height) || 600, 300), 4000);
        win.setContentSize(800, target);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, image.toPNG());
        return outFile;
      } finally {
        try { win.destroy(); } catch { /* 已销毁 */ }
      }
    };
    createTray();
    bootLog('托盘已创建');
  } catch (error) {
    bootLog(`启动失败：${String(error?.stack ?? error)}`);
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻：窗口全关不等于退出（退出走托盘菜单）
});

app.on('before-quit', () => { quitting = true; });
