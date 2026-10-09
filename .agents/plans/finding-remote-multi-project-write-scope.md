# 已修：同一设备多个投射项目时，非「当前绑定项目」的会话写操作被拒

日期：2026-10-03
状态：**已修 + 已验收（层 1 穷举矩阵全绿；层 3 真实设备全绿）**
关联：`CONTEXT.md`「Single Device Scope / Projection Scope / Device-scoped Attachment」

## 现象（实机日志）

A 上对**投射出来的会话**点「归档」——没有任何反应，会话留在列表里。

`~/.zcode/v2/logs/2026-10-03.log`：

```
zcode-task.archiveTask FAIL {"message":"列表 mutation 与 remote attachment scope 不匹配",
  "stack":"... at Object.resolveTaskAddress ... at route ... at <archiveTask 代理分支>"}
```

| 调用                                | 成功  | 失败    |
| ----------------------------------- | ----- | ------- |
| `archiveTask`                       | **0** | **2**   |
| `setTaskUnread`（打开会话即标已读） | 10    | **253** |

UI 侧归档链（`TaskList.handleArchiveTask` → `WorkspaceSidebarItem` /
`WorkspaceTimelineTasksSection`）**没有 catch**，拒绝被吞成 unhandled rejection ——
用户看到的就是「点了没反应」。

## 根因

**一台被投射设备的 workspace 绑定是单值，而投射端的 services 是设备级的 —— 两者错位。**

1. `windowRemoteConnectionRegistry.bindWorkspaceContext` 把 session 的
   `workspacePath/workspaceIdentity` **覆盖**为最新绑定的项目；
   `findSessionForWorkspace` 按 `path + identity` 严格相等匹配，于是该 session
   只能解析出当前那一个项目。
2. 投射端为每个设备只保留**一份 services**（ScopedServicePort 负载只有
   `{attachmentId, sessionId, target}`，不含 workspacePath），该设备的每个项目都指向它。
3. `resolveTaskAddress` 又把 attachmentScope 与请求参数做**严格相等**比较：

   ```ts
   if (
     remoteAttachmentScope.workspacePath !== params.workspacePath ||
     remoteAttachmentScope.workspaceIdentity !== params.workspaceIdentity
   )
     throw new Error("列表 mutation 与 remote attachment scope 不匹配");
   ```

   ⇒ 写任何非「设备当前绑定项目」的会话都被 fail-closed 拒绝。

触发器：**同一台设备上有 ≥2 个投射项目**（当天 A 侧：`AI2API` 与 `通通赛马` 挂在同一个
`remoteSessionId` 下）。只连一个项目时不会命中 —— 这也是此前三轮跨机验收全绿的原因：
那些脚本都只操作单项目，attachmentScope 与参数永远同项目。

## 修复（4 处）

| #   | 落点                                             | 改动                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `windowRemoteConnectionRegistry`                 | session 记住**绑定过的全部 workspace**（`boundWorkspaces` 映射），bind 由"覆盖"改为"增加"；`findSessionForWorkspace` 命中任一已绑定项目并返回**被请求的**上下文；`resolveScopedHandle` 接受任一已绑定项目（identity 优先），未绑定仍拒绝 |
| F2  | `windowHostControllerService.resolveTaskAddress` | 远程 attachment 的校验**降到设备粒度**：只要求 `remoteSessionId` 相同；跨设备/未绑定/本地目标仍 fail-closed（由 `resolveSource` 决定，未命中即 null）                                                                                    |
| F3  | `host/index.ts` bind 处理器                      | **不再**在切项目时摘除上一个项目的 Controller source（Projection Scope：切走 ≠ 取消投射），否则它的条目会消失、写操作也失去落点                                                                                                          |
| F4  | `host/index.ts` 收口路径                         | 设备断开（`disconnectSource`）、session 释放（`removeSource`）、重连替换旧 session 时，按 `boundWorkspaces` **逐项收口**；重连匹配也改为"旧 session 绑定过本 workspace 即算被替换"，避免多绑定留下孤儿 source                            |
| F5  | 新增 `windowRemoteControllerSource.ts`           | 把 `resolveSource` 的胶水抽成可测模块（原先这段零覆盖，恰是修复的判决点）                                                                                                                                                                |

`mutationParams`（写路径剥离本端 identity）与读路径（只按对端键查）**未动**，其不变量不回归。

## 验收

### 逆推（从领域承诺反推必须为真的条件）

| #   | 承诺（出处）                               | 反推出的要求                              | 落点                 |
| --- | ------------------------------------------ | ----------------------------------------- | -------------------- |
| R1  | Projected Device：数据与执行都在被投射设备 | 写操作必须真到达对端、以对端自己的键落库  | F2 + J1–J3           |
| R2  | Single Device Scope：**数据结构按列表存**  | 设备的 workspace 绑定必须是列表，不能单值 | F1                   |
| R3  | Projection Scope：显示哪些项目由用户勾选   | 绑过的项目不因切项目被移除                | F3                   |
| R4  | Index Isolation                            | 写路径仍剥离本端 identity                 | I2/J2 + 矩阵每格     |
| R5  | Device Boundary                            | 不新增对端写入                            | 矩阵（只写目标会话） |
| R6  | Local Continuation Independence            | 本地路径不受影响（identity 原样保留）     | 本地 attachment 三格 |
| R7  | Disconnected Projection                    | 断开时该设备**所有**绑定项目一起收口      | F4                   |

### 穷举（每一格直接是一个用例）

新增 `packages/desktop/test/remoteMultiProjectWriteScope.test.ts`（24 格）：
**目标归属 × 写操作**（远程 attachment）——

| 目标归属 \ 操作              | pin | archive | unarchive | delete | mark-read | 期望                                |
| ---------------------------- | --- | ------- | --------- | ------ | --------- | ----------------------------------- |
| 当前绑定项目                 | ✅  | ✅      | ✅        | ✅     | ✅        | 放行；对端收到自己的键、无 identity |
| 同设备**已绑定但非当前**项目 | ✅  | ✅      | ✅        | ✅     | ✅        | **放行（本缺陷格）**                |
| 同设备**从未绑定**项目       | ✅  | ✅      | ✅        | ✅     | ✅        | fail-closed 拒绝，且零对端写        |
| 另一台设备的项目             | ✅  | ✅      | ✅        | ✅     | ✅        | fail-closed 拒绝，且零对端写        |

外加：本地 attachment × {本地项目 / 远程已绑定 / 远程未绑定}（identity 剥离不得扩大化）、
以及归档删除（走同一个 `resolveTaskAddress`）。

`packages/desktop/test/remoteDeviceWorkspaceBindings.test.ts`（6 格）：绑过不丢 / 切回即用 /
未绑定必拒 / 设备级 services 可解析任一已绑定项目 / 快照带全量绑定 /
**组合用例**（真实 registry + 真实胶水 + Controller：设备绑定 P2 时归档 P1 的会话必须落到对端）。

两组都登记进 `pnpm remote:regression` 层 1。

### 实机验收（层 3，真实设备）

`acceptance-write-path-isolation.ts`：I1–I4（原有隔离项）+ 新增
**I5/I6**（pin 往返真的写进对端库 `pinned=1 → 0`，不再只看返回值）+
**J1–J3**（真实 registry + 真实胶水：设备当前绑定 A 项目时归档 B 项目的会话 →
返回 meta、对端库仅一条且键为 B 的纯路径、已移出对端默认列表）。

跑法：`node scripts/remote/regression.mjs --layer=all`（层 3 会写对端自建会话）。

## 未覆盖 / 待眼验

- **UI 观感**：F3 之后切项目不再向渲染进程发 `workspace.removed`。层 1/2 全绿，
  但"侧栏里先前项目的条目是否仍如预期呈现"需要在运行中的应用里看一眼。
- WSL 的 workspace runtime 仍按"当前绑定 + generation"持有/释放（本次未改这块语义）；
  非当前绑定项目的写操作只依赖 task index（sqlite），不受影响；但**在 WSL 上继续对话**
  非当前绑定项目时若要拉起 runtime，需要先重新绑定 —— 与修复前同语义。
- `remoteWorkspaceServicePortBridge` 的注册负载仍不含 workspacePath（渲染端继续按
  sessionId 存 services）。现在这是**正确**的：attachment 是设备粒度的。

## 数据安全

诊断与验收的写操作全部落在脚本自建的一次性会话上（标题前缀 `zpapa-test-`，护栏
`support/testIsolation.ts`），跑完已归档清理；未触碰任何既有会话。
