// web/server.js —— 应用本地 HTTP 服务
//
// 职责：托管界面静态文件、暴露控制 API、推送日志与状态（SSE）。
// 边界：只监听回环地址；协议端 WebUI 不在本服务内转发（界面用 iframe 直连其自身端口）。
//       `/api/biz/*` 是唯一的前缀路由——`api[key]` 精确匹配未命中时才交给 `api.__bizProxy`
//       （业务面通配代理，装配见 app/src/web/business-proxy.js）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/**
 * 创建 HTTP 服务。
 *
 * @param {object} options 选项
 * @param {number} options.port 端口
 * @param {string} options.uiDir 界面静态目录
 * @param {object} options.api 接口处理表（方法 + 路径 → 处理函数）
 * @param {object} options.log 日志器
 * @returns {object} 服务接口（start / stop / broadcast / address）
 */
export function createWebServer({ port, uiDir, api, log }) {
  const clients = new Set();
  let server = null;
  let boundPort = 0;

  /**
   * 发送 JSON 响应。
   *
   * @param {object} res 响应对象
   * @param {number} status 状态码
   * @param {object} body 响应体
   * @returns {void}
   */
  function sendJson(res, status, body) {
    const text = JSON.stringify(body ?? {});
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  /**
   * 读取请求体。
   *
   * @param {object} req 请求对象
   * @returns {Promise<object>} 解析结果
   */
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
    });
  }

  /**
   * 托管静态文件。
   *
   * @param {object} res 响应对象
   * @param {string} pathname 请求路径
   * @returns {void}
   */
  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(uiDir, rel);
    if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  /**
   * 处理请求。
   *
   * @param {object} req 请求对象
   * @param {object} res 响应对象
   * @returns {Promise<void>} 完成
   */
  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const key = `${req.method} ${url.pathname}`;

    // 事件流：日志与状态变化实时推送
    if (key === 'GET /api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('event: ready\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    const handler = api[key];
    if (!handler) {
      // 前缀兜底：`/api/biz/*` 交给业务面通配代理（api[key] 是精确匹配，不支持通配——
      // 业务面 73 条路由不可能逐条枚举，见 web/business-proxy.js 头部）。
      const bizProxy = api.__bizProxy;
      if (bizProxy && (url.pathname === '/api/biz' || url.pathname.startsWith('/api/biz/'))) {
        try {
          const body = req.method === 'POST' ? await readBody(req) : {};
          const result = await bizProxy({ method: req.method, pathname: url.pathname, search: url.search, body });
          sendJson(res, result?.status ?? 200, result?.body ?? result ?? { ok: true });
        } catch (error) {
          log.error('web', `业务面代理 ${key} 异常：${error?.message ?? error}`);
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }
      serveStatic(res, url.pathname);
      return;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler({ query: url.searchParams, body });
      sendJson(res, result?.status ?? 200, result?.body ?? result ?? { ok: true });
    } catch (error) {
      log.error('web', `接口 ${key} 异常：${error?.message ?? error}`);
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /**
   * 向所有事件流客户端广播。
   *
   * @param {string} event 事件名
   * @param {object} payload 数据
   * @returns {void}
   */
  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  /**
   * 启动服务。
   *
   * @returns {Promise<number>} 实际监听端口
   */
  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          log.error('web', `请求处理失败：${error?.message ?? error}`);
          try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch { /* 已响应 */ }
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        boundPort = server.address().port;
        log.info('web', `界面服务已启动：http://127.0.0.1:${boundPort}`);
        resolve(boundPort);
      });
    });
  }

  /**
   * 停止服务。
   *
   * @returns {Promise<void>} 完成
   */
  function stop() {
    return new Promise((resolve) => {
      for (const res of clients) {
        try { res.end(); } catch { /* 已关闭 */ }
      }
      clients.clear();
      if (!server) return resolve();
      server.close(() => resolve());
    });
  }

  return { start, stop, broadcast, address: () => boundPort };
}
