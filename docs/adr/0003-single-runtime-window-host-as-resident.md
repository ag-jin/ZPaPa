# ADR 0003：设备侧单一运行时 —— 窗口 host 兼作常驻主机

日期：2026-09-28
状态：已实施（代码见 host/residentExposure.ts；待设备侧升级后生效）
关联：`finding-dual-host-runtime-split.md`、`finding-direct-app-connection-feasibility.md`

## 背景

被投射设备（B）上并存**两个 host**，各自拉起独立 agent runtime：

```
ZCode.app (main)
├── zcode-host-local-1   ← B 的桌面 UI（14 项窗口 host 职责：DB 启动门禁、
│                          广播总线、任务实时总线、CUA 投影、agent 预热…）
└── resident-host        ← 供 A 远程挂载（只注入 2 个参数：
                           serviceAuthorityMode + builtinProviderConfigFilePath）
```

由于 agent runtime 的会话状态是**进程内内存态**（`context.sessions` 是每进程 Map，
`resumeSession` 命中内存即早退、不重读库），两个 host 的进度互不可见：

- A 经常驻主机跑出的轮次写进了共享 sqlite，但 B 本机 host 的 runtime 内存里没有
- B 从自己的旧进度继续，且**永不回读库** → 两端进度永久分叉

用户诉求：**A 和 B 看到同一个会话状态**，且 **B 必须常驻**（B 关闭则远程断开）。

## 决定

让**窗口 host 同时承担常驻主机职责**：同一个进程既服务 B 的桌面 UI（MessagePort），
也对外提供网络挂载（HTTP/WS 回环端口 + `resident-host.json` 发现文件）。

```
改后：
ZCode.app (main)
└── zcode-host-local-1   ← B 的 UI（MessagePort）
                          ← A 的远程挂载（127.0.0.1:<port> 经 SSH 隧道）
                            同一份 services、同一份 runtime → 无分叉
```

### 为什么不是「让 B 的 UI 去连常驻主机」

两条路的**用户可见结果相同**（B 只有一个运行时），但代价差一个数量级：

| | 窗口 host 兼常驻 | UI 改连常驻主机 |
|---|---|---|
| 需迁移的职责 | **无**（窗口 host 本就是完整 host） | 14 项：DB 启动门禁、广播总线、任务实时总线、CUA 投影、agent 预热、feedback、deviceMid… |
| CUA（电脑控制） | **不受影响**（仍是 desktop-local） | 会失效（常驻主机是 desktop-attached-remote） |
| 常驻主机入口代码 | 保留 `residentHost/index.ts` 作为独立模式（可选） | 需扩展其注入面 |

选择前者：**把常驻能力加到已经完整的 host 上，而不是把 UI 的依赖搬到不完整的 host 上**。

### 权威模式的处理

窗口 host 保持 `serviceAuthorityMode: "desktop-local"`（B 的 UI 需要 CUA 等物理桌面能力）。
远程连接在该 host 内通过**连接级** `clientMode` 区分：

- B 的 UI 连接 → `desktop-continuous`（现在就是这样）
- A 的远程挂载 → `web-remote-replayable`（`/ws` 端点的既有语义）

`clientMode` 已是连接级参数（`createZCodeAgentConnectionScope`），无需改造 ——
这保证了「同一份 services 服务不同角色」不是新发明，而是代码既有模式。

### 发现文件与端口

窗口 host 启动后：
1. 用 `createHttpServer(services, 0, { host: "127.0.0.1" })` 监听**临时端口**
2. 把 `{host, port, pid, version, protocolVersion, startedAt}` 写入 `resident-host.json`
   —— 与现有 `RESIDENT_HOST_STATUS_REMOTE_PATH`（`~/.zcode/v2/resident-host.json`）同格式，
   A 侧的 `connectResidentRemote` 无需改动即可发现
3. App 退出时清理该文件

**只监听回环**：跨机访问只能经 SSH 隧道，与现状一致，对外暴露面为零。

## 影响

- **A 侧零改动**：`connectResidentRemote` 读的还是 `resident-host.json`，挂的还是同构服务面。
- **B 的 CUA 不受影响**：host 仍是 `desktop-local`，物理桌面能力完整。
- **B 关闭即断开**：host 随 App 生死，符合用户明确要求。
- `residentHost/index.ts` 保留：它作为「纯常驻模式」（无窗口场景）仍可用，
  但桌面 App 默认不再 fork 它，避免两份运行时。

## 被否决的方案

- **让 B 的 UI 连常驻主机**（原路径 1 表述）：需迁移 14 项职责且破坏 CUA。见上表。
- **把权威模式从 host 级改成连接级**：改动面大（触及 CUA 状态投影核心路径），
  且在「窗口 host 兼常驻」方案下**不需要** —— 两个角色的能力差异已由 `clientMode` 覆盖。
- **保留双 host 但补跨进程刷新通知**：只治列表不重画，不治运行态分叉。

## 后续：CUA 隔离已核实无需改动

实施前担心：A 经远程挂载后，B 的 CUA（电脑控制）状态会投影到 A 的屏幕
（`desktop-attached-remote` 原本要挡的语义），因此需把隔离从 host 级改为连接级。

**实测核实后该担心不成立**，隔离由三道彼此独立的机制保证，与本 ADR 无关：

1. **CUA 状态走 `parentPort` 私线，不过 RPC 面**
   `channels.ts:610` 注释原文「host → main：Windows desktop-local CUA turn 的
   操作提示状态」；发送方式是 `parentPort.postMessage`。A 经 `/ws/host` 挂载
   拿到的是 `services`（RPC 面），`parentPort` 不在其中 —— A 挂不到。
2. **CUA 状态不进 V4 协议**：`shared/zcode-protocol-v4/` 下无任何相关字段。
3. **平台限制**：该 reporter 仅在 Windows 启用
   （`process.platform === "win32" ? cuaOperationStateReporter : undefined`）。

因此**不需要**把 `serviceAuthorityMode` 改为连接级判定。B 的窗口 host 保持
`desktop-local`，CUA 功能完整保留 —— 这正是选择本方向而非"UI 去连常驻主机"的
关键理由之一。

> 若将来把 CUA 状态改成经 RPC 推送（例如让远程端显示对端的电脑操作进度），
> 则**必须**同时引入连接级隔离，否则会违反上述语义。届时应更新本 ADR。
