// file-tools.js —— 受控根只读文件面（B23「角色设定上工式」的前置执行面）
//
// 为什么需要：roleText 从「静态整段注入」改成「身份 + 路由索引」后，模型必须能按需取件。
// 本模块提供两个只读工具：
//   read_file(path, startLine?, endLine?) —— 读受控根内的文本文件（带行号，可分段）
//   list_dir(path?)                      —— 列目录（侦察用；无参列根清单）
//
// 安全口径（与 CH4 受控根一致）：
//   - 根 = config.tools.fileRead.roots（默认 workspace + ccbp，与 CH4 猫的 enabledRoots 一致）
//   - 寻址：<rootId>:<相对路径>（推荐）/ 整串等于根 id（根目录）/ 受控根内绝对路径
//   - 越界一律拒绝：相对路径不猜根；绝对路径必须落在某个根内；realpath 复核防符号链接
//   - 只读：本模块不提供任何写面
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { registerTool } from './tool-registry.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 60000;

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/** 配置的受控根（id / path 归一化；字符串项按目录名生成 id）。 */
export function fileRoots() {
  const cfg = getConfig()?.tools?.fileRead || {};
  const raw = Array.isArray(cfg.roots) ? cfg.roots : [];
  const roots = [];
  for (const item of raw) {
    if (!item) continue;
    if (typeof item === 'string') {
      const p = path.resolve(item);
      roots.push({ id: path.basename(p).toLowerCase(), path: p });
      continue;
    }
    const p = String(item.path || '').trim();
    if (!p) continue;
    const resolved = path.resolve(p);
    roots.push({ id: String(item.id || path.basename(resolved)).toLowerCase(), path: resolved });
  }
  return roots;
}

/** target 是否落在 root 内（含 root 本身）。 */
function underRoot(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把模型给的路径解析为受控根内绝对路径；越界 / 形态非法一律抛错。 */
export function resolveReadPath(raw) {
  const input = String(raw ?? '').trim();
  if (!input) throw new Error('缺少路径');
  if (input.includes('\0')) throw new Error('路径含非法字符');
  const roots = fileRoots();
  if (!roots.length) throw new Error('没有配置受控根（config.tools.fileRead.roots）');
  const rootById = (id) => roots.find((r) => r.id === String(id).toLowerCase());
  let resolved = null;
  let root = null;
  // 1) <rootId>:<rel>
  const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(input);
  if (m && rootById(m[1])) {
    root = rootById(m[1]);
    const rel = m[2].replace(/^[\\/]+/, '');
    resolved = path.resolve(root.path, rel);
  } else if (!path.isAbsolute(input)) {
    // 2) 裸根名 = 根目录
    root = rootById(input);
    if (root) resolved = path.resolve(root.path);
    else throw new Error(`路径必须是 <rootId>:<相对路径> 或受控根内绝对路径（可用根：${roots.map((r) => r.id).join(' / ')}）`);
  } else {
    // 3) 绝对路径：必须落在某个根内
    resolved = path.resolve(input);
  }
  const checkRoots = root ? [root] : roots;
  if (!checkRoots.some((r) => underRoot(resolved, r.path))) {
    throw new Error(`越界：${input} 不在任何受控根内（可用根：${roots.map((r) => `${r.id}=${r.path}`).join(' / ')}）`);
  }
  // realpath 复核（防符号链接越界；文件不存在时留给读取报错）
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* 不存在 */ }
  if (!roots.some((r) => underRoot(real, r.path))) {
    throw new Error(`越界：${input} 的真实路径不在受控根内`);
  }
  return { path: resolved, realPath: real, root: roots.find((r) => underRoot(real, r.path)) || root };
}

function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8192);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

/** 读文本文件（带行号；可分段；超 maxChars 自动截断并提示下一段）。 */
export function readTextFile(raw, options = {}) {
  const target = resolveReadPath(raw);
  const cfg = getConfig()?.tools?.fileRead || {};
  const maxBytes = Math.max(1024, Number(cfg.maxBytes) || DEFAULT_MAX_BYTES);
  const maxChars = Math.max(1000, Number(cfg.maxCharsPerRead) || DEFAULT_MAX_CHARS);
  let stat;
  try { stat = fs.statSync(target.path); } catch { throw new Error(`文件不存在：${target.path}`); }
  if (!stat.isFile()) throw new Error(`不是文件：${target.path}（目录用 list_dir）`);
  if (stat.size > maxBytes) {
    throw new Error(`文件过大（${Math.round(stat.size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）——用 startLine / endLine 分段读`);
  }
  const buffer = fs.readFileSync(target.path);
  if (looksBinary(buffer)) throw new Error('这是二进制文件，不能按文本读');
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Math.max(1, Number(options.startLine) || 1);
  const requestedEnd = Number(options.endLine) || totalLines;
  const end = Math.min(totalLines, requestedEnd);
  if (start > totalLines) throw new Error(`startLine=${start} 超出总行数 ${totalLines}`);
  if (end < start) throw new Error(`endLine=${end} 小于 startLine=${start}`);
  const picked = [];
  let chars = 0;
  let actualEnd = start - 1;
  let truncated = false;
  for (let i = start; i <= end; i++) {
    const line = `${i}: ${lines[i - 1]}`;
    if (chars + line.length + 1 > maxChars) { truncated = true; break; }
    picked.push(line);
    chars += line.length + 1;
    actualEnd = i;
  }
  const head = `文件：${target.path}（共 ${totalLines} 行，本次 ${start}-${actualEnd}${truncated ? `，已截断——下一段从第 ${actualEnd + 1} 行开始` : ''}）`;
  return { path: target.path, totalLines, startLine: start, endLine: actualEnd, truncated, text: `${head}\n${picked.join('\n')}` };
}

/** 列目录（单层；无参列根清单）。 */
export function listDirectory(raw) {
  const input = String(raw ?? '').trim();
  if (!input) {
    const roots = fileRoots();
    return { roots: roots.map((r) => ({ id: r.id, path: r.path, exists: fs.existsSync(r.path) })) };
  }
  const target = resolveReadPath(input);
  let stat;
  try { stat = fs.statSync(target.path); } catch { throw new Error(`目录不存在：${target.path}`); }
  if (!stat.isDirectory()) throw new Error(`不是目录：${target.path}（文件用 read_file）`);
  const entries = fs.readdirSync(target.path, { withFileTypes: true })
    .map((d) => {
      const p = path.join(target.path, d.name);
      let size = null;
      let mtime = null;
      try {
        const s = fs.statSync(p);
        size = s.isFile() ? s.size : null;
        mtime = s.mtime.toISOString();
      } catch { /* 忽略不可读条目 */ }
      return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, mtime };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    .slice(0, 200);
  return { path: target.path, count: entries.length, entries };
}

export function registerFileTools() {
  registerTool({
    id: 'read_file',
    name: '读取文件',
    description: '读取受控根内的文本文件（只读，带行号，可分段）。用于按需取件：CCBP 知识文件（ccbp:L0/... / ccbp:L1/... / ccbp:L2/...）与项目文档（workspace:QQBotB/...）。'
      + '路径写法 <rootId>:<相对路径>；大文件用 startLine / endLine 分段，不要一次读太多。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '受控根内路径：<rootId>:<相对路径>（如 ccbp:L1/Tree.md、workspace:QQBotB/project.md）或受控根内绝对路径' },
        startLine: { type: ['integer', 'string'], description: '可选：起始行（1-based）' },
        endLine: { type: ['integer', 'string'], description: '可选：结束行（含）' }
      },
      required: ['path']
    },
    async execute(ctx, args) {
      try { return ok(readTextFile(args.path, args)); } catch (error) { return err(error?.message ?? error); }
    }
  });
  registerTool({
    id: 'list_dir',
    name: '列出目录',
    description: '列出受控根内某个目录的条目（单层；只读）。不传 path 时列出全部受控根。用于侦察文件位置——先看目录再 read_file。',
    category: 'knowledge',
    icon: '📁',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选：目录路径（<rootId>:<相对路径>）；不传 = 列出全部受控根' }
      }
    },
    async execute(ctx, args) {
      try { return ok(listDirectory(args.path)); } catch (error) { return err(error?.message ?? error); }
    }
  });
}
