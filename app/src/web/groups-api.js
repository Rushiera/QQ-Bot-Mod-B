// web/groups-api.js —— 群名单接口（界面 ↔ 应用 ↔ 业务面）
//
// 职责：把业务面的群名单读写包装成三条本地接口，供界面「群名单」页签使用。
// 边界：
//   · 不落本地配置（名单的真相源是业务面 `allow` / `deny`）——本应用只做转发与规整。
//   · 键名即契约：`GET /api/groups` / `GET /api/groups/online` / `POST /api/groups`，
//     界面按这三条取数，改名须同步 `app/ui/app.js`。
//   · 业务面失败一律回 502 + 原文，不吐空名单假装成功。

/**
 * 创建群名单接口处理表。
 *
 * @param {object} options 选项
 * @param {object} options.business 业务面客户端（business.js）
 * @param {object} options.log 日志器
 * @returns {object} 接口处理表（`方法 路径` → 处理函数）
 */
export function createGroupsApi({ business, log }) {
  return {
    // 读群名单现状
    'GET /api/groups': async () => {
      try {
        return { body: await business.readLists() };
      } catch (error) {
        log.error('business', `群名单读取失败：${error?.message ?? error}`);
        return { status: 502, body: { ok: false, error: String(error?.message ?? error) } };
      }
    },

    // 拉协议端当前所在群（只读——供界面辨识群号）
    'GET /api/groups/online': async () => ({ body: await business.readOnlineGroups() }),

    // 写群名单——写后立即读回，回执即实况
    'POST /api/groups': async ({ body }) => {
      try {
        return {
          body: await business.writeLists({
            allowGroups: body?.allowGroups,
            denyGroups: body?.denyGroups,
            allowAllWhenEmpty: body?.allowAllWhenEmpty
          })
        };
      } catch (error) {
        log.error('business', `群名单写入失败：${error?.message ?? error}`);
        return { status: 502, body: { ok: false, error: String(error?.message ?? error) } };
      }
    }
  };
}
