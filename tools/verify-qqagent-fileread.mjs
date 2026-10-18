// verify-qqagent-fileread.mjs — B23「角色设定上工式」自测
//
// 覆盖：
//   1) 受控根配置（workspace + ccbp）与寻址 / 越界拒绝
//   2) read_file / list_dir 的实际读取行为
//   3) 工具注册（read_file / list_dir 进 registry）
//   4) roleText 短版（≤12k、身份 + 路由索引、旧整段注入已退出）
//   5) 按需文件（role/nav-rules.md · role/blocked-rules.md）
//   6) 补丁标记（tools.js / config.js）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, '_unpack', 'resources', 'app', 'src');
const CFG_FILE = path.join(ROOT, '_unpack', 'data', 'config.json');
const ROLE_DIR = path.join(ROOT, 'role');
const ROLE_TEXT_MAX = 12000;

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    checks.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const fileTools = await import(pathToFileURL(path.join(SRC, 'file-tools.js')).href);
const registry = await import(pathToFileURL(path.join(SRC, 'tool-registry.js')).href);

await check('受控根：workspace + ccbp', () => {
  const roots = fileTools.fileRoots();
  const ids = roots.map((r) => r.id);
  assert(ids.includes('workspace'), `缺少 workspace（实际：${ids.join(',')}）`);
  assert(ids.includes('ccbp'), `缺少 ccbp（实际：${ids.join(',')}）`);
  for (const r of roots) assert(fs.existsSync(r.path), `根不存在：${r.id}=${r.path}`);
  return roots.map((r) => `${r.id}=${r.path}`).join(' | ');
});

await check('寻址：ccbp:L1/Tree.md', () => {
  const r = fileTools.resolveReadPath('ccbp:L1/Tree.md');
  assert(fs.existsSync(r.path), `文件不存在：${r.path}`);
  return r.path;
});

await check('寻址：workspace:QQBotB/project.md', () => {
  const r = fileTools.resolveReadPath('workspace:QQBotB/project.md');
  assert(fs.existsSync(r.path), `文件不存在：${r.path}`);
  return r.path;
});

await check('越界：ccbp:../QQBotB/project.md 被拒', () => {
  let rejected = false;
  try { fileTools.resolveReadPath('ccbp:../QQBotB/project.md'); } catch { rejected = true; }
  assert(rejected, '越界路径未被拒绝');
  return 'rejected';
});

await check('越界：C:\\Windows\\win.ini 被拒', () => {
  let rejected = false;
  try { fileTools.resolveReadPath('C:\\Windows\\win.ini'); } catch { rejected = true; }
  assert(rejected, '根外绝对路径未被拒绝');
  return 'rejected';
});

await check('相对路径不猜根', () => {
  let rejected = false;
  try { fileTools.resolveReadPath('L1/Tree.md'); } catch { rejected = true; }
  assert(rejected, '裸相对路径未被拒绝');
  return 'rejected';
});

await check('read_file：分段读取带行号', () => {
  const out = fileTools.readTextFile('ccbp:L1/Tree.md', { startLine: 1, endLine: 5 });
  assert(out.totalLines > 5, `总行数异常：${out.totalLines}`);
  assert(out.endLine === 5, `endLine=${out.endLine}`);
  assert(out.text.includes('1: '), '缺少行号');
  return `${out.totalLines} 行 / 本次 ${out.startLine}-${out.endLine}`;
});

await check('read_file：超范围 startLine 报错', () => {
  let rejected = false;
  try { fileTools.readTextFile('ccbp:L1/Tree.md', { startLine: 999999 }); } catch { rejected = true; }
  assert(rejected, '超范围 startLine 未报错');
  return 'rejected';
});

await check('list_dir：ccbp:L1 含 Tree.md', () => {
  const out = fileTools.listDirectory('ccbp:L1');
  assert(out.entries.some((e) => e.name === 'Tree.md'), '目录里没有 Tree.md');
  return `${out.count} 项`;
});

await check('list_dir：无参列根清单', () => {
  const out = fileTools.listDirectory('');
  assert(Array.isArray(out.roots) && out.roots.length >= 2, '根清单为空');
  return out.roots.map((r) => r.id).join(',');
});

await check('工具注册：read_file / list_dir', () => {
  fileTools.registerFileTools();
  const read = registry.getTool('read_file');
  const list = registry.getTool('list_dir');
  assert(read && typeof read.execute === 'function', 'read_file 未注册');
  assert(list && typeof list.execute === 'function', 'list_dir 未注册');
  return 'registered';
});

await check('read_file.execute 回执', async () => {
  const def = registry.getTool('read_file');
  const out = await def.execute({}, { path: 'ccbp:L1/Tree.md', startLine: 1, endLine: 3 });
  assert(!out.isError, `执行失败：${out.content}`);
  assert(String(out.content).includes('文件：'), '回执缺少文件头');
  return 'ok';
});

await check('补丁标记：tools.js', () => {
  const text = fs.readFileSync(path.join(SRC, 'tools.js'), 'utf8');
  assert(text.includes('[qqagent-fileread-patch:tools-import]'), '缺少 tools-import 标记');
  assert(text.includes('[qqagent-fileread-patch:tools-register]'), '缺少 tools-register 标记');
  assert(text.includes('registerFileTools();'), '缺少 registerFileTools() 调用');
  return 'ok';
});

await check('补丁标记：config.js', () => {
  const text = fs.readFileSync(path.join(SRC, 'config.js'), 'utf8');
  assert(text.includes('[qqagent-fileread-patch:config-file-read]'), '缺少 config-file-read 标记');
  assert(text.includes('fileRead: {'), '缺少 fileRead 默认段');
  return 'ok';
});

await check(`roleText ≤ ${ROLE_TEXT_MAX} 字符`, () => {
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  const roleText = String(cfg?.persona?.roleText || '');
  assert(roleText.length > 0, 'roleText 为空');
  assert(roleText.length <= ROLE_TEXT_MAX, `roleText=${roleText.length} 超过 ${ROLE_TEXT_MAX}`);
  return `${roleText.length} 字符`;
});

await check('roleText：身份 / 能力 / 边界 / 路由索引齐备', () => {
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  const roleText = String(cfg?.persona?.roleText || '');
  for (const key of ['我是谁', '四条底线', '能干什么', '路由索引', 'read_file', 'nav-rules.md', 'ccbp:L1/Tree.md']) {
    assert(roleText.includes(key), `缺少关键段：${key}`);
  }
  return 'ok';
});

await check('roleText：旧整段注入已退出', () => {
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  const roleText = String(cfg?.persona?.roleText || '');
  for (const old of ['## L1/Discipline.md', '## L2/Worker/Chat/heart.md', '## L2/Job/CatHome/exp.md']) {
    assert(!roleText.includes(old), `旧注入标题仍在：${old}`);
  }
  return 'ok';
});

await check('按需文件：role/nav-rules.md', () => {
  const file = path.join(ROLE_DIR, 'nav-rules.md');
  assert(fs.existsSync(file), `不存在：${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert(text.includes('领航员') && text.includes('nav_send'), '内容不完整');
  return `${text.length} 字符`;
});

await check('按需文件：role/blocked-rules.md', () => {
  const file = path.join(ROLE_DIR, 'blocked-rules.md');
  assert(fs.existsSync(file), `不存在：${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert(text.includes('人机验证页') && text.includes('browser-headful'), '内容不完整');
  return `${text.length} 字符`;
});

await check('按需文件可被 read_file 读取', () => {
  const out = fileTools.readTextFile('workspace:QQBotB/role/nav-rules.md', { startLine: 1, endLine: 3 });
  assert(out.text.includes('领航员'), '读取内容异常');
  return `${out.totalLines} 行`;
});

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  passed: checks.length - failed.length,
  failed: failed.length,
  total: checks.length,
  checks
}, null, 2));
if (failed.length) process.exitCode = 1;
