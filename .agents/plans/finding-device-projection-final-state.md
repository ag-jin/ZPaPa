# 结论：设备级投射已打通（读设备项目 + 读改设备设置）

日期：2026-09-27（更新）
关联：`finding-device-projection-reads-local-settings.md`、`finding-device-ui-redundancy.md`

## 修复方式：单开设备通道，绕开被本地化的 settingService

`ISettingService` 在远端 workspace 语义下**必须**是本机实现
（`remoteWorkspaceServiceCollection.ts`：设置/凭据/OAuth/模型供应商读写本机），
但设备投射要读的是**设备自己**的项目登记与设置。两者语义冲突，因此新增
`IRemoteDeviceProjectsService`（channel `remote-device-projects`）：

| 方法 | 作用 |
|---|---|
| `listRegisteredProjects()` | 读设备自身的 `recentProjects` |
| `getSettings()` | 读设备完整设置（供白名单挑字段展示） |
| `updateSetting(key, value)` | 写设备的一个设置字段 |

由 A 侧 host 用**对端原始访问面**（`params.connectionServices`，指向 B 的
resident host）代为读写。这样：不动 workspace 语义、不要求 B 升级
（B 跑官方包也能答，因为读的就是 B 的 settingService）。

链路：描述符 → host scoped collection 注册 → client 代理 → renderer merge
（`remoteWorkspaceSessionServices`）→ `DeviceServiceAccess` 优先使用。

## 跨机实测（2026-09-27，A=本机 Intel，B=100.66.1.2 官方包 3.14.3）

| 验收标准 | 结果 | 证据 |
|---|---|---|
| 1. 侧边栏出现 B 的项目（图标/颜色区分）+ 会话可点开 | ✅ | 10 个项目全为 `/Volumes/数据盘/网站/*`；蓝色 `monitor-smartphone` vs 本地灰色 `folder-open`；展开显示 B 的会话标题与时间 |
| 2. 可勾选显示哪些 B 项目 | ✅ | 设置页列出 10 项各带会话数；关掉 agent军团 → 10→9 且落盘 `visibleProjects`；勾回 → 9→10 |
| 3. 断开后投射项消失、重连入口仍在 | ✅ | 断开后投射项 10→0；卡片仍显示 `linguojin@100.66.1.2 · 未连接 · [连接] [移除设备]` |
| 4. 可读改 B 的白名单设置，改后 B 侧生效 | ✅ | 读：UI 三个开关与 B 文件一致。写：UI 改「显示待办」→ B 变 `False`、A 仍 `True`；随后回滚 B 至 `True` |
| 5. A 端无 remote 会话索引残留 | ✅ | `tasks-index.sqlite` 中 `remote:%` 行数 = 0 |

检查：`pnpm typecheck` ✅ / `oxlint`（无新增告警）✅ / `architecture:check` 0 违规 ✅
投影契约测试 11 项全通过（含新增的孤儿判定与设备 session 查找）。

## 本轮顺带修掉的真缺陷

1. **`tabStore` 漏传 `projection`**（`createWorkspaceTab` / `mergeWorkspaceTabOptions`）：
   投射条目退化成普通 tab，断开时按 `deviceSessionId` 回收失效。

2. **重连产生孤儿投射条目**：同一台设备重连会换新的 `deviceSessionId`，旧条目的
   session 已注销 —— 按当前 session 过滤看不见、`dispose` 也够不到，于是每重连一次
   就多留一组（实测连接 2 次 → 20 个投射项，同一批项目两份）。
   修法：连接时清理**指向同一 target 且 session 已失效**的旧代条目，并新增纯函数
   `findOrphanProjectionTabs` + 3 项回归测试。

3. **断开只清 `remoteSessionId`、不清投射条目**：`onRemoteSessionClosed` 在
   `matchedTabs.length === 0` 时提前返回，而设备连接的投射条目正是这种"没有
   workspace tab 匹配"的情况 → 条目永久留在侧边栏。已把投射清理挪到早退之前。

4. **设备卡片状态依赖组件内 state**：连接成功会切走一次设置页，state 随之丢失，
   重开后错误显示「未连接」并藏掉「断开」入口。改为从在册 session 反推
   （新增 `findDeviceSessionId` + 1 项测试），并让项目勾选列表在重挂载后重新拉取。

5. **显示偏好开关不即时生效**：只落盘偏好但不重算投射，用户关掉项目后侧边栏仍显示。
   已改为同时按新偏好关闭/重开投射条目。

## 遗留

- 设备设置区块里「投射的项目」子列表显示「远端共 0 个项目」：该子列表走
  `zcodeTaskService.listTasks()` 无参枚举，而 B 的官方包不支持设备级全量枚举
  （报 `Cannot read properties of undefined`）。项目勾选已由设备通道提供（标准 2 通过），
  这个子列表属冗余展示，可删或改走 `listRegisteredProjects`。
- 规格提到的 22 个可投射字段，实测在 B（官方包）上露出 18 个：其余字段名在
  B 的版本里不存在或类型不同，属版本差异而非缺陷。


