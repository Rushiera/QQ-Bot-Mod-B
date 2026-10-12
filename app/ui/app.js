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
  if (name === 'nav') {
    refreshNav();
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

/**
 * 刷新账号登录面（协议端账号状态 + 已存账号）。
 *
 * 掉登录后的恢复入口：状态与阶段直读协议端；快速登录按钮按已存账号发起。
 *
 * @returns {Promise<void>} 完成
 */
async function refreshLogin() {
  let data = null;
  try {
    data = await api('/api/qq/login');
  } catch {
    return;
  }

  const reachable = data?.ok === true;
  const state = data?.status?.state ?? null;
  $('#ov-qq-state').textContent = reachable
    ? (state?.isLogin ? '已登录' : '未登录')
    : '协议端不可达';
  $('#ov-qq-phase').textContent = state?.loginPhase || '-';
  $('#ov-qq-error').textContent = state?.loginError || data?.status?.message || '-';

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
 * 刷新领航员面板（会话态 + 猫群 + 健康检查 + 指令流水）。
 *
 * @returns {Promise<void>} 完成
 */
async function refreshNav() {
  const status = await api('/api/nav/status').catch(() => null);
  if (status) {
    const toggle = $('#btn-nav-toggle');
    const on = status.enabled === true;
    toggle.textContent = on ? '关闭领航员' : '开启领航员';
    toggle.dataset.on = on ? '1' : '0';
    $('#nav-hint').textContent = on
      ? `已开启（${status.openedBy === 'qq' ? '群内 @' : '应用内'}）`
      : (status.closedReason === 'idle' ? '已暂关（空闲）' : '未开启');
    $('#nav-chat').textContent = status.activeChat ?? '-';
    $('#nav-target').textContent = status.lastTarget || '-';
    $('#nav-last').textContent = status.lastCommandAt
      ? new Date(status.lastCommandAt).toLocaleString('zh-CN', { hour12: false })
      : '-';
    $('#nav-idle').textContent = status.idleMs
      ? `${Math.round(status.idleMs / 60000)} 分钟 / 阈值 ${Math.round((status.idleCloseMs || 0) / 60000)} 分钟`
      : '-';
    $('#nav-by').textContent = status.openedBy || '-';
    const rows = (status.cats || []).map((c) => `${c.runState === 'idle' ? '·' : '▶'} ${c.name}（${c.port}）${c.runState}`);
    $('#nav-cats').textContent = rows.length
      ? rows.join('\n')
      : (status.ch4Error ? `CH4 未连接：${status.ch4Error}` : '（无猫）');
    const flow = (status.commandLog || []).slice().reverse().map((e) => {
      const time = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${time}] [群 ${e.chat || '-'}] → ${e.target || '-'}：${e.text}（${e.result}）`;
    });
    $('#nav-log').textContent = flow.length ? flow.join('\n') : '（暂无指令）';
    const acts = (status.activity || []).slice().reverse().map((a) => {
      const time = new Date(a.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${time}] ${a.kind}｜${a.text}`;
    });
    $('#nav-activity').textContent = acts.length ? acts.join('\n') : '（暂无活动）';
  }
  const health = await api('/api/nav/health').catch(() => null);
  if (health) {
    const lines = [`应用指令层 ${health.app?.ok ? '--OK' : '--异常'}`];
    for (const svc of health.services || []) lines.push(`${svc.name}   ${svc.detail}`);
    lines.push(health.ch4?.ok ? 'Mau链接状态 --OK' : `Mau链接状态 --异常（${health.ch4?.error || '未连接'}）`);
    $('#nav-health').textContent = lines.join('\n');
  }
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

  $('#btn-nav-toggle').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const on = button.dataset.on === '1';
    button.disabled = true;
    button.textContent = on ? '关闭中…' : '开启中…';
    try {
      await api(on ? '/api/nav/close' : '/api/nav/open', { method: 'POST', body: { by: 'app' } });
    } catch { /* 结果由刷新反映 */ }
    button.disabled = false;
    await refreshNav();
  });

  $('#btn-nav-refresh').addEventListener('click', () => refreshNav());

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
refreshNav();
loadLogs();
loadConfig();
refreshLogin();
loadWebui();
subscribeEvents();
setInterval(refreshStatus, 3000);
setInterval(refreshLogin, 15000);
setInterval(() => {
  const view = document.getElementById('view-nav');
  if (view && view.classList.contains('active')) refreshNav();
}, 30000);
