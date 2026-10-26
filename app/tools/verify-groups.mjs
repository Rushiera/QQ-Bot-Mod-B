// tools/verify-groups.mjs —— 群名单页签自测（真实链路）
//
// 用法：node tools/verify-groups.mjs
// 做什么：起界面服务（只挂群名单接口，不拉协议端/业务面的其他子系统）→ 经 HTTP 调
//         `GET /api/groups` / `POST /api/groups` / `GET /api/groups/online` →
//         断言回执形态与写入语义 → 结束时把名单还原成开跑前的样子。
// 边界：会真的写业务面的 `allow` / `deny`（这正是要验的链路），故必须还原；
//       只动群名单三个字段，业务面的其余配置一律不碰。

import { createWebServer } from '../src/web/server.js';
import { createGroupsApi } from '../src/web/groups-api.js';
import { createBusinessClient } from '../src/business.js';
import { loadConfig } from '../src/config.js';

const log = {
  info: () => {},
  warn: () => {},
  error: (scope, message) => console.log(`  [log.error] ${scope}：${message}`),
  recent: () => [],
  subscribe: () => {}
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  [OK] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name} ${detail}`);
  }
};

const config = loadConfig();
const business = createBusinessClient({
  apiUrl: config.business.apiUrl,
  token: config.business.token,
  log
});

const web = createWebServer({
  port: 0,
  uiDir: 'unused',
  log,
  api: { ...createGroupsApi({ business, log }) }
});

const port = await web.start();
const base = `http://127.0.0.1:${port}`;

/**
 * 调本地接口。
 *
 * @param {string} path 路径
 * @param {object} [options] 选项（method / body）
 * @returns {Promise<object>} 响应
 */
async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

const PROBE_ID = '135792468';  // 假群号——只在本自测期间存在

let original = null;
try {
  // ── 读面 ──
  const read = await call('/api/groups');
  check('GET /api/groups 回 ok', read.body?.ok === true, JSON.stringify(read.body));
  check('读面带 allowGroups 数组', Array.isArray(read.body?.allowGroups), JSON.stringify(read.body));
  check('读面带 denyGroups 数组', Array.isArray(read.body?.denyGroups), JSON.stringify(read.body));
  check('读面给出业务面地址', typeof read.body?.apiUrl === 'string' && read.body.apiUrl.startsWith('http'), String(read.body?.apiUrl));
  check('群号全是纯数字', (read.body?.allowGroups ?? []).every((id) => /^\d+$/.test(id)), JSON.stringify(read.body?.allowGroups));
  original = {
    allowGroups: read.body?.allowGroups ?? [],
    denyGroups: read.body?.denyGroups ?? [],
    allowAllWhenEmpty: read.body?.allowAllWhenEmpty === true
  };

  // ── 写面：加一个群 ──
  const added = await call('/api/groups', {
    method: 'POST',
    body: { allowGroups: [...original.allowGroups, PROBE_ID], denyGroups: original.denyGroups }
  });
  check('POST 加群回 ok', added.body?.ok === true, JSON.stringify(added.body));
  check('写后读回含新群号', (added.body?.allowGroups ?? []).includes(PROBE_ID), JSON.stringify(added.body?.allowGroups));
  check('写后数量 = 原数量 + 1', (added.body?.allowGroups ?? []).length === original.allowGroups.length + 1);

  // ── 落盘核对：业务面的配置文件里也要有（内存 + 磁盘一体）──
  const persisted = await business.readLists();
  check('再次读取仍是新状态（内存已更新）', persisted.allowGroups.includes(PROBE_ID), JSON.stringify(persisted.allowGroups));

  // ── 去重：同一群号传两次只留一个 ──
  const duplicated = await call('/api/groups', {
    method: 'POST',
    body: { allowGroups: [...original.allowGroups, PROBE_ID, PROBE_ID], denyGroups: [] }
  });
  check('重复群号被去重', (duplicated.body?.allowGroups ?? []).filter((id) => id === PROBE_ID).length === 1, JSON.stringify(duplicated.body?.allowGroups));

  // ── 非法值过滤（界面粘贴整段文本会带非数字）──
  const dirty = await call('/api/groups', {
    method: 'POST',
    body: { allowGroups: [...original.allowGroups, 'abc', '  ', '12a34'], denyGroups: [] }
  });
  check('非数字被过滤', (dirty.body?.allowGroups ?? []).every((id) => /^\d+$/.test(id)), JSON.stringify(dirty.body?.allowGroups));

  // ── 负例：同一群同时在允许与拒绝 ──
  const overlap = await call('/api/groups', {
    method: 'POST',
    body: { allowGroups: [PROBE_ID], denyGroups: [PROBE_ID] }
  });
  check('重叠群号被拒（非 200）', overlap.status !== 200, String(overlap.status));
  check('重叠群号回 ok:false', overlap.body?.ok === false, JSON.stringify(overlap.body));
  check('重叠群号给出可读原因', String(overlap.body?.error ?? '').includes(PROBE_ID), String(overlap.body?.error));

  // ── 拒绝名单可写 ──
  const denied = await call('/api/groups', {
    method: 'POST',
    body: { allowGroups: original.allowGroups, denyGroups: [PROBE_ID] }
  });
  check('拒绝名单写入生效', (denied.body?.denyGroups ?? []).includes(PROBE_ID), JSON.stringify(denied.body?.denyGroups));
  check('写拒绝名单不动允许名单', JSON.stringify(denied.body?.allowGroups) === JSON.stringify(original.allowGroups));

  // ── 协议端群列表（只读）──
  const online = await call('/api/groups/online');
  check('GET /api/groups/online 有回执', typeof online.body?.ok === 'boolean', JSON.stringify(online.body).slice(0, 200));
  if (online.body?.ok) {
    check('协议端群列表是数组', Array.isArray(online.body?.groups), typeof online.body?.groups);
    check('群条目带 id + name', (online.body?.groups ?? []).every((g) => /^\d+$/.test(String(g.id)) && typeof g.name === 'string'));
  } else {
    console.log(`  [skip] 协议端群列表：${online.body?.error ?? '不可用'}`);
  }
} finally {
  // ── 还原（必须做：本自测写的是真配置）──
  if (original) {
    const restored = await call('/api/groups', { method: 'POST', body: original });
    const same = JSON.stringify(restored.body?.allowGroups) === JSON.stringify(original.allowGroups)
      && JSON.stringify(restored.body?.denyGroups) === JSON.stringify(original.denyGroups);
    check('收尾还原成开跑前状态', same, JSON.stringify(restored.body));
  }
  await web.stop();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
