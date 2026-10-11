// navigator/comfy.js —— 图像编辑（ComfyDock「[生成]」工作区）
//
// 职责：把「群里的图 + 提示词」送上 ComfyDock 的 RunningHub 生成工作区，轮询到出图，
//       把结果图直发回群（领航员自己的出站，不经业务面闸门）。
// 边界：不做语义判断（「这条是不是改图请求」归业务面 R喵）；不改 ComfyDock 的配置面
//       （工作区 id 与端点从 app/data/config.json 的 navigator.comfy 读）。
// 设计：design-qqbotb-navigator.md §十八。

import fs from 'node:fs';
import path from 'node:path';

/** 探测 / 单次请求超时（毫秒）——提交要传图，留宽。 */
const REQUEST_TIMEOUT_MS = 120000;

/** 轮询间隔默认值（毫秒）。 */
const DEFAULT_POLL_MS = 5000;

/** 单次任务等待上限默认值（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** 默认工作区 id（ComfyDock 内置生成块）。 */
const DEFAULT_WORKSPACE = 'gen';

/**
 * 创建图像编辑服务。
 *
 * @param {object} options 选项
 * @param {object} options.log 日志器
 * @param {string} options.dataDir 应用数据目录（取图落盘用）
 * @param {object} [options.conf] 配置（endpoint / workspaceId / pollMs / timeoutMs）
 * @param {object} options.onebot OneBot 客户端（取图用——get_image 走协议端缓存）
 * @param {Function} options.sendImage 发图函数 (chat, file, caption) => Promise
 * @param {Function} options.sendText 发文字函数 (chat, text) => Promise
 * @param {Function} options.record 活动流记录 (kind, text) => void
 * @returns {object} 服务接口（edit / online / summary / isBusy）
 */
export function createComfyService({ log, dataDir, conf = {}, onebot, sendImage, sendText, record }) {
  const endpoint = String(conf.endpoint || '').replace(/\/+$/, '');
  const workspaceId = String(conf.workspaceId || DEFAULT_WORKSPACE);
  const pollMs = Number(conf.pollMs) > 0 ? Number(conf.pollMs) : DEFAULT_POLL_MS;
  const waitMs = Number(conf.timeoutMs) > 0 ? Number(conf.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const inDir = path.join(dataDir, 'comfy-in');

  /** 在途任务——同一时刻只跑一张（ComfyDock 侧也是单任务闸）。 */
  let busy = false;

  /**
   * 调 ComfyDock 的 HTTP 接口。
   *
   * @param {string} pathname 路径（含查询串）
   * @param {object} [options] 选项（method / body）
   * @param {number} [timeoutMs] 超时毫秒
   * @returns {Promise<object>} 响应体
   */
  async function call(pathname, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${endpoint}${pathname}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 探 ComfyDock 是否在线（额度概览）。
   *
   * @returns {Promise<object>} { online, detail }
   */
  async function summary() {
    if (!endpoint) return { online: false, detail: '未配置端点' };
    try {
      const data = await call('/api/summary', {}, 6000);
      const remain = Number(data?.remain ?? 0);
      const minutes = Number(data?.resetInMinutes ?? 0);
      return { online: true, detail: `在线（合计剩余 ${remain} · ${minutes > 0 ? `重置在 ${minutes} 分钟后` : '重置时刻已过'}）` };
    } catch (error) {
      return { online: false, detail: String(error?.message ?? error) };
    }
  }

  /** 是否已有任务在跑。 */
  function isBusy() {
    return busy;
  }

  /**
   * 取本地图片路径——显式路径优先，其次协议端缓存（`get_image`），最后直链下载。
   *
   * 为什么缓存优先：QQ 直链带 rkey、约一小时失效；`get_image` 认消息里的 file 名，
   * 拿的是协议端本地缓存，不受时效影响（判例见 CHANGELOG v0.47 附近与 sticker-manager）。
   *
   * @param {object} options 选项
   * @param {string} [options.image] 本地绝对路径
   * @param {string} [options.file] OneBot 消息段里的 file 名
   * @param {string} [options.url] 图片直链
   * @returns {Promise<string>} 本地图片绝对路径
   */
  async function materialize({ image = '', file = '', url = '' }) {
    const local = String(image || '').trim();
    if (local) {
      if (!fs.existsSync(local)) throw new Error(`本地图片不在：${local}`);
      return local;
    }
    fs.mkdirSync(inDir, { recursive: true });
    const stamp = Date.now();
    if (file) {
      try {
        const ret = await onebot.call('get_image', { file: String(file) });
        const src = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (src) {
          const dest = path.join(inDir, `${stamp}${path.extname(src) || '.png'}`);
          fs.copyFileSync(src, dest);
          return dest;
        }
      } catch (error) {
        record('comfy', `协议端取图失败，改走直链：${error?.message ?? error}`);
      }
    }
    const link = String(url || '').trim();
    if (link) {
      const response = await fetch(link);
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('图片下载为空');
      const dest = path.join(inDir, `${stamp}.png`);
      fs.writeFileSync(dest, buffer);
      return dest;
    }
    throw new Error('没有拿到图片——消息里没有图，也没有给路径');
  }

  /**
   * 取任务视图 + 产物落点目录。
   *
   * @param {string} id 任务标识（`<工作区>|<图片路径>`）
   * @returns {Promise<object|null>} { task, outDir, workspaceId }
   */
  async function taskView(id) {
    const status = await call('/api/rh', {}, 15000);
    const workspaces = Array.isArray(status?.workspaces) ? status.workspaces : [];
    for (const workspace of workspaces) {
      for (const task of workspace.tasks || []) {
        if (String(task?.id) === String(id)) {
          return { task, outDir: String(status?.outDir || ''), workspaceId: String(workspace.id || '') };
        }
      }
    }
    return null;
  }

  /**
   * 产物文件名 → 本地绝对路径（生成块落 `out/<工作区>/`，音频块落 `out/`——两处都认）。
   *
   * @param {string} outDir 产物落点目录
   * @param {string} workspaceId 工作区 id
   * @param {string} name 产物文件名
   * @returns {string} 存在的绝对路径（都不在则为空串）
   */
  function artifactPath(outDir, workspaceId, name) {
    const candidates = [
      path.join(outDir, workspaceId, name),
      path.join(outDir, name)
    ];
    return candidates.find((file) => fs.existsSync(file)) ?? '';
  }

  /**
   * 轮询到收口——出图发群 / 失败发原因 / 超时出声，收尾清 busy。
   *
   * @param {object} options 选项
   * @param {string} options.id 任务标识
   * @param {string|number} options.chat 回报群
   * @param {string} options.prompt 提示词（进回执标题）
   * @returns {Promise<void>} 完成
   */
  async function waitForArtifact({ id, chat, prompt }) {
    const deadline = Date.now() + waitMs;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        try {
          await call('/api/rh/poll', { method: 'POST' }, 60000);
        } catch (error) {
          record('error', `图像编辑轮询失败（继续等）：${error?.message ?? error}`);
        }
        let view = null;
        try {
          view = await taskView(id);
        } catch (error) {
          record('error', `图像编辑取任务状态失败（继续等）：${error?.message ?? error}`);
        }
        if (!view) continue;
        const status = String(view.task?.status ?? '');
        if (status === 'SUCCESS') {
          const names = Array.isArray(view.task?.artifacts) ? view.task.artifacts : [];
          const file = names.map((name) => artifactPath(view.outDir, view.workspaceId, name)).find(Boolean) ?? '';
          if (!file) {
            await sendText(chat, `图像编辑出图了，但产物文件没找到（任务 ${view.task?.taskId ?? '?'}）——去 ComfyDock 面板看落点。`);
            record('error', '图像编辑出图但产物路径未命中');
            return;
          }
          const sent = await sendImage(chat, file, `图像编辑完成 · ${String(prompt).slice(0, 60)}`);
          record(sent.ok ? 'comfy' : 'error', sent.ok
            ? `图像编辑出图已发群（${path.basename(file)}）`
            : `图像编辑发图失败：${sent.error}`);
          return;
        }
        if (status === 'FAILED') {
          const reason = String(view.task?.error || '未知原因');
          await sendText(chat, `图像编辑失败：${reason}`);
          record('error', `图像编辑失败：${reason}`);
          return;
        }
      }
      await sendText(chat, '图像编辑超时未收口——去 ComfyDock 面板看任务状态。');
      record('error', `图像编辑轮询超时（${Math.round(waitMs / 60000)} 分钟）`);
    } finally {
      busy = false;
    }
  }

  /**
   * 受理一次图像编辑——提交即返回，出图/失败由后台轮询发群。
   *
   * @param {object} options 选项
   * @param {string|number} options.chat 回报群（必给——由调用方解析）
   * @param {string} options.prompt 提示词（必给）
   * @param {string} [options.image] 本地图片路径
   * @param {string} [options.file] OneBot 消息段的 file 名
   * @param {string} [options.url] 图片直链
   * @returns {Promise<object>} { ok, taskId?, image?, error? }
   */
  async function edit({ chat, prompt, image = '', file = '', url = '' }) {
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, error: '提示词是空的——改图要一句要求' };
    if (busy) return { ok: false, error: '已有一张图在跑——等它出图再提交下一张' };
    const probe = await summary();
    if (!probe.online) return { ok: false, error: `ComfyDock 离线（${probe.detail}）` };
    let local = '';
    try {
      local = await materialize({ image, file, url });
    } catch (error) {
      return { ok: false, error: `取图失败：${error?.message ?? error}` };
    }
    let submitted = null;
    try {
      submitted = await call('/api/rh/submit', {
        method: 'POST',
        body: { workspaceId, path: local, prompt: text }
      });
    } catch (error) {
      return { ok: false, error: `提交失败：${error?.message ?? error}` };
    }
    if (submitted?.ok !== true) {
      return { ok: false, error: `ComfyDock 未受理：${submitted?.message ?? '未知原因'}` };
    }
    busy = true;
    record('comfy', `图像编辑已提交（任务 ${submitted.taskId}）：${text.slice(0, 40)}`);
    waitForArtifact({ id: submitted.id, chat, prompt: text })
      .catch((error) => record('error', `图像编辑收尾异常：${error?.message ?? error}`));
    return { ok: true, taskId: submitted.taskId, image: local, account: submitted.account, message: submitted.message };
  }

  return { edit, online: summary, summary, isBusy, endpoint, workspaceId };
}
