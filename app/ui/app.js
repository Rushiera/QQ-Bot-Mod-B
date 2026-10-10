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
  if (name === 'webui' && !webuiLoaded) {
    webuiLoaded = true;
    loadWebui();
  }
}

/**
 * 加载协议端控制台页面（懒加载：首次切到该标签才请求）。
 *
 * @returns {void}
 */
function loadWebui() {
  const frame = $('#webui-frame');
  if (!frame) return;
  frame.src = `http://127.0.0.1:${currentWebuiPort}/webui/`;
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
 * 载入配置到表单。
 *
 * @returns {Promise<void>} 完成
 */
async function loadConfig() {
  try {
    const data = await api('/api/config');
    $('#cfg-shell-dir').value = data.config?.napcat?.shellDir ?? '';
    $('#cfg-uin').value = data.config?.napcat?.uin ?? '';
    $('#cfg-port').value = data.config?.app?.port ?? '';
    $('#cfg-autostart').checked = !!data.config?.app?.autostartNapcat;
  } catch { /* 配置拉取失败不阻塞界面 */ }
}

/**
 * 绑定界面事件。
 *
 * @returns {void}
 */
function bindEvents() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

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
  $('#btn-webui-open').addEventListener('click', () => {
    window.open(`http://127.0.0.1:${currentWebuiPort}/webui/`, '_blank');
  });

  $('#btn-log-clear').addEventListener('click', () => {
    logBuffer.length = 0;
    $('#log-view').textContent = '';
  });

  $('#btn-config-save').addEventListener('click', async () => {
    const hint = $('#cfg-hint');
    hint.textContent = '保存中…';
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          napcat: { shellDir: $('#cfg-shell-dir').value.trim(), uin: $('#cfg-uin').value.trim() },
          app: { port: Number($('#cfg-port').value) || 3280, autostartNapcat: $('#cfg-autostart').checked }
        }
      });
      hint.textContent = '已保存（目录与账号改动需重启程序生效）';
    } catch (error) {
      hint.textContent = `保存失败：${error.message}`;
    }
  });
}

bindEvents();
refreshStatus();
loadLogs();
loadConfig();
webuiLoaded = true;
loadWebui();
subscribeEvents();
setInterval(refreshStatus, 3000);
