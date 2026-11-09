// ui/app.js —— 界面逻辑
//
// 职责：轮询状态、订阅日志事件流、驱动各标签页。
// 边界：只经 HTTP API 与主进程通信，不直接触碰文件系统。

const $ = (selector) => document.querySelector(selector);

const logBuffer = [];
const LOG_MAX = 800;
let currentWebuiPort = 6099;
let webuiLoaded = false;

/**
 * 调用接口。
 *
 * @param {string} path 路径
 * @param {object} [options] 选项
 * @returns {Promise<object>} 响应体
 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return response.json();
}

/**
 * 切换标签页。
 *
 * @param {string} name 视图名
 * @returns {void}
 */
function switchView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.id === `view-${name}`);
  }
  if (name === 'webui') {
    // 懒加载：首次切到该标签才请求；若上次加载失败（frame 没拿到 src）则重试。
    // 控制台不可达时不把整页顶回概览——失败只留在这个标签页里，靠「刷新」按钮重试。
    const frame = $('#webui-frame');
    if (!webuiLoaded || !frame?.getAttribute('src')) loadWebui();
  }
}

/**
 * 加载协议端控制台页面（懒加载：首次切到该标签才请求）。
 *
 * @param {string} [route] 控制台内的路由（如 `qq_login` 登录页）
 * @returns {void}
 */
function loadWebui(route = '') {
  const frame = $('#webui-frame');
  if (!frame) return;
  webuiLoaded = true;
  frame.src = `http://127.0.0.1:${currentWebuiPort}/webui/${route ? `#/${route}` : ''}`;
}

/**
 * 刷新状态面板。
 *
 * @returns {Promise<void>} 完成
 */
async function refreshStatus() {
  let status = null;
  try {
    status = await api('/api/status');
  } catch {
    return;
  }

  const napcatRunning = !!status.napcat?.running;
  const onebotConnected = !!status.onebot?.connected;

  $('#dot-napcat').className = `dot ${napcatRunning ? 'on' : ''}`;
  $('#txt-napcat').textContent = napcatRunning ? '运行中' : '未运行';
  $('#dot-onebot').className = `dot ${onebotConnected ? 'on' : 'warn'}`;
  $('#txt-onebot').textContent = onebotConnected ? '已连接' : (status.onebot?.lastError || '未连接');

  const toggle = $('#btn-napcat-toggle');
  toggle.textContent = napcatRunning ? '停止协议端' : '启动协议端';
  toggle.dataset.running = napcatRunning ? '1' : '0';

  $('#ov-napcat').textContent = napcatRunning ? '运行中' : '未运行';
  $('#ov-napcat-pid').textContent = status.napcat?.pid ?? '-';
  $('#ov-uin').textContent = status.napcat?.uin ?? '-';
  $('#ov-webui').textContent = status.napcat?.webuiUrl ?? '-';
  $('#ov-onebot').textContent = onebotConnected ? '已连接' : '未连接';
  $('#ov-onebot-url').textContent = status.onebot?.wsUrl ?? '-';
  $('#ov-self').textContent = status.onebot?.self
    ? `${status.onebot.self.nickname}(${status.onebot.self.userId})`
    : '-';
  $('#ov-events').textContent = String(status.onebot?.events ?? 0);
  $('#ov-port').textContent = status.app?.port ?? '-';
  $('#ov-version').textContent = status.app?.version ?? '-';
  $('#ov-shelldir').textContent = status.napcat?.shellDir ?? '-';

  if (status.napcat?.webui?.port) {
    currentWebuiPort = status.napcat.webui.port;
  }
  $('#webui-hint').textContent = napcatRunning
    ? '协议端控制台（登录 / 配置 / 状态）'
    : '协议端未运行——启动后此处可用';
}

/** 已存账号下拉的当前选项签名（避免每次刷新重建选项）。 */
let quickOptions = '';

/** 登录面连续取数失败次数——单次失败不改显示，避免状态位在「已登录 / 未登录」间来回闪。 */
let loginFailures = 0;

/**
 * 刷新账号登录面（协议端账号状态 + 已存账号）。
 *
 * 掉登录后的恢复入口：状态与阶段直读协议端；快速登录按钮按已存账号发起。
 *
 * 取数失败（协议端重启 / 端口未就绪 / WebUI 未起来）时**保留上一次已知状态**，只在提示行
 * 标注「连接中」——否则状态位会在「已登录 / 未登录 / 协议端不可达」之间反复闪
 * （判例 2026-10-25：协议端重启期间每 15 秒抖一次，看起来像账号在未登录 / 已登录之间跳）。
 *
 * @returns {Promise<void>} 完成
 */
async function refreshLogin() {
  let data = null;
  try {
    data = await api('/api/qq/login');
  } catch {
    data = null;
  }

  const reachable = data?.ok === true && !!data?.status?.state;
  const state = data?.status?.state ?? null;

  if (!reachable) {
    loginFailures += 1;
    // 单次失败不改任何显示（重试 15 秒一次，偶发一次不该动状态位）；
    // 连续两次仍取不到才在提示行标「连接中」，状态与阶段保持上一次的值。
    if (loginFailures < 2) return;
    const hint = data === null ? '界面接口无响应' : (data?.error || data?.status?.message || '协议端未就绪');
    $('#ov-qq-error').textContent = `连接中…（${hint}）`;
    $('#btn-qq-quick').disabled = true;
    $('#btn-qq-scan').disabled = true;
    return;
  }

  loginFailures = 0;
  $('#ov-qq-state').textContent = state.isLogin ? '已登录' : '未登录';
  $('#ov-qq-phase').textContent = state.loginPhase || '-';
  $('#ov-qq-error').textContent = state.loginError || '-';

  const uins = Array.isArray(data?.quick) ? data.quick : [];
  const signature = uins.join(',');
  if (signature !== quickOptions) {
    quickOptions = signature;
    const select = $('#qq-uin');
    const previous = select.value;
    select.textContent = '';
    for (const uin of uins) {
      const option = document.createElement('option');
      option.value = uin;
      option.textContent = uin;
      select.appendChild(option);
    }
    if (uins.includes(previous)) select.value = previous;
  }

  $('#btn-qq-quick').disabled = !reachable || uins.length === 0;
  $('#btn-qq-scan').disabled = !reachable;
}

/**
 * 追加日志行。
 *
 * @param {object} entry 日志条目
 * @returns {void}
 */
function appendLog(entry) {
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  logBuffer.push(`[${time}] [${String(entry.level).toUpperCase()}] [${entry.module}] ${entry.text}`);
  if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);

  const view = $('#log-view');
  if (!view) return;
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
  view.textContent = logBuffer.join('\n');
  if (atBottom) view.scrollTop = view.scrollHeight;
}

/**
 * 拉取历史日志。
 *
 * @returns {Promise<void>} 完成
 */
async function loadLogs() {
  try {
    const data = await api('/api/logs?limit=300');
    logBuffer.length = 0;
    for (const entry of data.logs || []) {
      const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
      logBuffer.push(`[${time}] [${String(entry.level).toUpperCase()}] [${entry.module}] ${entry.text}`);
    }
    const view = $('#log-view');
    if (view) {
      view.textContent = logBuffer.join('\n');
      view.scrollTop = view.scrollHeight;
    }
  } catch { /* 日志拉取失败不阻塞界面 */ }
}

/**
 * 订阅日志事件流。
 *
 * @returns {void}
 */
function subscribeEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('log', (event) => {
    try { appendLog(JSON.parse(event.data)); } catch { /* 忽略坏帧 */ }
  });
}

/**
 * 载入本机配置到表单。
 *
 * 🔴 本地设置已并入「业务设置 → 本地设置」分节（单体这一侧的表单元素不再存在），
 * 本函数保留为空安全的兜底：元素不在就直接返回，不再拉 /api/config 并写 DOM。
 *
 * @returns {Promise<void>} 完成
 */
async function loadConfig() {
  const host = $('#cfg-shell-dir');
  if (!host) return;
  try {
    const data = await api('/api/config');
    $('#cfg-shell-dir').value = data.config?.napcat?.shellDir ?? '';
    $('#cfg-uin').value = data.config?.napcat?.uin ?? '';
    $('#cfg-port').value = data.config?.app?.port ?? '';
    $('#cfg-autostart').checked = !!data.config?.app?.autostartNapcat;
    // 开机自启 / 关闭到托盘（原「桌面端」分节搬来——属本机动作，落单体自己的 config.json）
    $('#cfg-autostart-app').checked = !!data.config?.app?.autoStart;
    $('#cfg-close-to-tray').checked = data.config?.app?.closeToTray !== false;
  } catch { /* 配置拉取失败不阻塞界面 */ }
}

// 领航员页（`#view-nav`）2026-11-09 起由 `views/navigator.js` 整页接管——
// 本文件不再持有该页的 DOM 引用与刷新逻辑（见 `_shell.js` 的 MANAGED）。

/**
 * 绑定界面事件。
 *
 * @returns {void}
 */
function bindEvents() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  // 领航员页的开关与刷新按钮已随页面归 `views/navigator.js`——本文件不再绑定。

  $('#btn-napcat-toggle').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const running = button.dataset.running === '1';
    button.disabled = true;
    button.textContent = running ? '停止中…' : '启动中…';
    try {
      await api(running ? '/api/napcat/stop' : '/api/napcat/start', { method: 'POST', body: {} });
    } catch { /* 结果由状态轮询反映 */ }
    button.disabled = false;
    await refreshStatus();
  });

  $('#btn-webui-reload').addEventListener('click', () => loadWebui());
  $('#btn-webui-login').addEventListener('click', () => loadWebui('qq_login'));
  $('#btn-webui-open').addEventListener('click', () => {
    window.open(`http://127.0.0.1:${currentWebuiPort}/webui/`, '_blank');
  });

  $('#btn-qq-quick').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const uin = $('#qq-uin').value;
    if (!uin) return;
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      await api('/api/qq/login/quick', { method: 'POST', body: { uin } });
    } catch { /* 结果由刷新反映 */ }
    button.textContent = '快速登录';
    setTimeout(refreshLogin, 2000);
  });

  // 扫码登录：切到控制台页并直达协议端登录页（二维码由协议端自己渲染）
  $('#btn-qq-scan').addEventListener('click', () => {
    switchView('webui');
    loadWebui('qq_login');
  });

  const clearBtn = $('#btn-log-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      logBuffer.length = 0;
      const view = $('#log-view');
      if (view) view.textContent = '';
    });
  }

  const saveBtn = $('#btn-config-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const hint = $('#cfg-hint');
    if (hint) hint.textContent = '保存中…';
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          napcat: { shellDir: $('#cfg-shell-dir').value.trim(), uin: $('#cfg-uin').value.trim() },
          app: {
            port: Number($('#cfg-port').value) || 3280,
            autostartNapcat: $('#cfg-autostart').checked,
            autoStart: $('#cfg-autostart-app').checked,
            closeToTray: $('#cfg-close-to-tray').checked
          }
        }
      });
      if (hint) hint.textContent = '已保存（目录与账号改动需重启程序生效）';
    } catch (error) {
      if (hint) hint.textContent = `保存失败：${error.message}`;
    }
  });
}

bindEvents();
refreshStatus();
loadLogs();
loadConfig();
refreshLogin();
subscribeEvents();
setInterval(refreshStatus, 3000);
setInterval(refreshLogin, 15000);
