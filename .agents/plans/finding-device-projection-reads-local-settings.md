# 发现：设备级投射读不到 B 的项目清单（settingService 被刻意本地化）

日期：2026-09-26
影响：T4 收尾阻塞。UI 里连接 B 成功后，投射出的「B 的项目」实际是 A 自己的项目；
B 的真实项目一个都拿不到。仪表层（验收脚本）正常，UI 路径不正常。

## 现象与实测证据

UI 连接 B 后，`[remoteDevice] 投射清单已生成` 打印：

```
registeredProjects: 3, tasks: 0
sample: ['/Users/jin1/Workspace/新赛马', '/Users/jin1/Workspace/中转站', '/Users/linguojin/Workspace/ZCode']
```

这 3 个路径是 **A 自己的 `recentProjects`**。而 B 的 `~/.zcode/v2/setting.json` 里是
10 个项目（`/Volumes/数据盘/网站/*`），且上述 3 个路径在 B 上**根本不存在**。

运行时逐层验证（renderer 内 ESM import 读 store 实况）：

| 检查项                                                       | 结果                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `session.target`                                             | `{kind:"ssh", host:"100.66.1.2"}` — 确实连到 B ✅        |
| `session.remoteServices` 存在                                | true ✅                                                  |
| `session.remoteServices.settingService.get().recentProjects` | **A 的 3 个路径** ❌                                     |
| host 注册的 scoped channel 列表                              | 有 `settings-sync`/`plugins`/`hooks`，**没有 `setting`** |
| 验收脚本 `acceptance-device-connect.ts`                      | 读到 B 的 10 个项目 / 33 条会话 ✅                       |

## 根因：这是刻意设计，与设备投射语义冲突

`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:313`：

```ts
// 因此这里为 remote workspace host 补齐本地全局 channel；文件、终端、ZCode Agent 仍来自远端，
// 设置、凭据、OAuth、模型供应商和 settings-sync 继续读写本机配置。
.register(ISettingService, localSettingService)
```

「远端 workspace」语义下 `settingService` **必须**是本机实现（设置是本机事实；否则
远端 shell 枚举结果会写进本机设置、模型配置会读到对端）。这是对的。

但「设备级投射」是**另一种语义**：

|                         | 远端 workspace     | 设备级投射                  |
| ----------------------- | ------------------ | --------------------------- |
| 目的                    | 打开 B 的某个项目  | 读 B **整台设备**有哪些项目 |
| 项目清单来源            | 用户选定的目录     | 必须问 B 自己               |
| settingService 应有语义 | 本机（现状，正确） | **设备侧**                  |

设备投射借用了 workspace 连接的 accessor，于是拿到了本机 settingService。

## 为什么验收脚本能过、UI 不能

- 验收脚本走 `packages/server/src/remote/connect-resident.ts`：Node 端直连 B 的
  resident host，`connection.services.settingService` **就是** B 的 → 读到 10 个项目。
- UI 走 desktop host 的 `remoteWorkspaceServiceCollection`：`settingService` 被
  刻意换成 `localSettingService` → 读到 A 的 3 个。

两条路同名不同物，是本轮误判的主要来源。

## 需求依据（spec-remote-device.md）

- User Story 7：连上后看到 **B 的项目列表**
- User Story 14：勾选候选项就是 **B 已添加的项目**（含新登记无会话的）
- 第 26 行：**在 A 上添加 B 的新项目**，登记到 B 的项目列表 → 说明需要设备侧读写接口，
  不只是读

## 修复方向（未定稿）

不要在 `buildRemoteWorkspaceSessionServices` 里把 `settingService` 改成远端 —— 那会
破坏远端 workspace 的既有语义（模型配置、终端 shell 枚举都会串到对端）。

建议为设备投射单独开一条只读接口，候选方案：

1. **resident host 增加设备端点**（`/api/device-projects` 或 RPC 方法），由 A 的 host
   经既有 SSH 隧道调用。语义清晰，不动 workspace 语义。
2. **设备会话单独持有「对端原始 accessor」**（本轮已加 `session.remoteServices` 字段，
   但实测其 `settingService` 仍被 host 换成本地 —— 因为 host 侧组装时就换了，
   renderer 拿不到未替换的版本）。此路需要 host 侧同时提供未被替换的通道。

方案 1 更干净：投射读的是「设备登记了哪些项目」这一**业务事实**，不该复用 settings 通道。

## 遗留的中间产物（需清理）

本轮排查中改动的文件（部分未定稿）：

- `packages/ui/src/store/tabStore.ts` — 补 `projection` 字段透传（**这个是真 bug，保留**）
- `packages/ui/src/store/remoteWorkspaceSessionStore.ts` — 加 `remoteServices` 字段
- `packages/desktop/src/renderer/src/main.tsx` — 传 `remoteServices`
- `packages/ui/src/root/useRemoteWorkspaceHistory.ts` — 用 `remoteServices ?? services`
- `packages/ui/src/SettingsPage.tsx` — 投射诊断日志

`tabStore.ts` 的修复独立成立：`createWorkspaceTab` / `mergeWorkspaceTabOptions` 都漏了
`projection`，导致投射条目退化成普通 tab，断开时按 deviceSessionId 回收会失效。
