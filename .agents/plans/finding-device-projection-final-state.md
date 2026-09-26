# 结论：设备级投射的最后一段未打通（读设备项目清单仍走本地）

日期：2026-09-27
关联：`.agents/plans/finding-device-projection-reads-local-settings.md`、`finding-device-ui-redundancy.md`

## 运行时实测（决定性证据）

连接 B 成功后，从运行中的 dev renderer 直接读 `TabStoreProvider` 的 store 实例：

```js
store.getState().tabs   → 8 个 tab
[
  { path: "/Users/linguojin/Workspace/ZCode",  projection: {deviceSessionId: "f204699d-…"}, remoteSessionId: "f204699d-…" },
  { path: "/Users/jin1/Workspace/中转站",      projection: {deviceSessionId: "f204699d-…"}, remoteSessionId: "f204699d-…" },
  { path: "/Users/jin1/Workspace/新赛马",      projection: {deviceSessionId: "f204699d-…"}, remoteSessionId: "f204699d-…" },
  { path: "/Users/linguojin/Workspace/ZCode",  projection: null, remoteSessionId: null },   // 本地原有
  { path: "/Users/jin1/Workspace/中转站",      projection: null, remoteSessionId: null },
  { path: "/Users/jin1/Workspace/新赛马",      projection: null, remoteSessionId: null },
  { path: "/Users/linguojin/.zcode/workspace/default", projection: null, remoteSessionId: null },
  { path: undefined, projection: null, remoteSessionId: null },
]
```

关键结论：

1. **投射机制本身是通的** —— 投射 tab 已创建，`projection.deviceSessionId` 正确写入。
   这验证了 `tabStore.ts` 的修复有效（`createWorkspaceTab` / `mergeWorkspaceTabOptions`
   此前都漏传 `projection`，投射条目会退化成普通 tab，断开时按 deviceSessionId 回收失效）。

2. **投射出的三个路径是 A 自己的 `recentProjects`**，不是 B 的。
   B 的真实项目是 `/Volumes/数据盘/网站/*`（10 个），一个都没拿到。
   且 A 的那三个路径（`/Users/jin1/…`）在 B 上**不存在**（已 SSH 核实）。
   因此侧边栏看到的是：3 个本地项目 + 3 个同名重复 tab（投射的那份），后者因路径重复
   在 UI 上无法区分，观感上"投射没生效"。

3. **根因未修**：`remoteDeviceAccess.listRegisteredProjects()` 调
   `services.settingService.get()`，而设备会话的 `settingService` 被
   `remoteWorkspaceServiceCollection.ts:318` 刻意注册为本机实现
   （理由：设置是本机事实，模型配置/终端 shell 枚举不能串到对端）。

## 为什么验收脚本能过、UI 不能

| 路径 | settingService 来源 | 结果 |
|---|---|---|
| `acceptance-device-connect.ts` | `connectResidentRemote` 直连 B（`RemoteServiceAccess`） | 读到 B 的 10 个 ✅ |
| UI（renderer → host） | `remoteWorkspaceServiceCollection` 的 `localSettingService` | 读到 A 的 3 个 ❌ |

两条路同名不同物。这也解释了本轮多次误判。

## 需要的修法（未实施）

设备投射要读的是「设备登记了哪些项目」这一**业务事实**，不该复用 settings 通道。
建议在 resident host 上加只读设备端点（如 `/api/device-projects` 或 RPC 方法），
由 A 的 host 经既有 SSH 隧道调用，返回 `recentProjects` + 各项目会话数。

- 不动 workspace 语义（模型配置等仍读本机）
- 顺带为 spec 第 26 行「在 A 添加 B 的新项目」留写入口

## 本轮已完成的改动

| 文件 | 内容 | 状态 |
|---|---|---|
| `packages/ui/src/store/tabStore.ts` | `projection` 字段透传（真 bug） | ✅ 已验证生效 |
| `packages/ui/src/Root.tsx` + `root/types.ts` + `root/WorkspaceSettingsLayer.tsx` + `root/RootWorkspaceContent.tsx` | `remoteDeviceConnect` / `onOpenRemoteConnection` prop 链路 | ✅ 连接按钮已可用 |
| `packages/ui/src/SettingsPage.tsx` | 设备配置服务改取 `localHostServices`（设备配置是本机事实）；移除死代码 | ✅ 设备卡片正常渲染 |
| `packages/ui/src/settings/RemoteDeviceManagementSection.tsx` | **删除重复的连接表单**，改为指向「远程连接」弹窗；保留设备状态/项目勾选/移除 | ✅ lint/typecheck 干净 |
| `packages/ui/src/SSHDialog.tsx` + `RemoteConnectionDialogContent.tsx` | 目录步新增「作为设备连接（不选目录）」入口 | ✅ 已接线，待联调 |
| `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | `connectRemoteDevice` 支持复用已有 session | ✅ |

检查状态：`pnpm typecheck` ✅ / `npx oxlint` ✅ / `pnpm architecture:check` ✅（violations: 0）

## 教训

1. **先查产品既有实现**：`RemoteDeviceSettingsSection` 早就用 `useWorkspaceServices`
   正确地拿到了对端服务；我却另造了一套连接表单，字段还更少（缺 password/port）。
2. **UI 验证用 CDP，不要盲点**：dev 版 `--remote-debugging-port=9229`，`Runtime.evaluate`
   可直接读 store/DOM。本轮后半段改用此法后效率大增。脚本：`.scratch/cdp/cdp.mjs`。
3. **同名不同物的陷阱**：`connectResidentRemote` 与 `remoteWorkspaceServiceCollection`
   都产出"远端服务"，但 settingService 语义相反。跨层排查时必须确认拿到的是哪一个。
