# 评估：把「远程投射」改为「直连设备 App」的可行性

日期：2026-09-27
状态：**评估完成，方案不可行（按用户原始表述）/ 需改成另一种形态**
关联：`finding-dual-host-runtime-split.md`（待修缺陷）

## 用户的原始设想

> "直接连 B 端的 APP 软件，不是连接后端的 CLI，直接映射操控 B 端的软件 UI。"

## 逐条核对

### 1. 「A 连的是后端 CLI」——这个前提不成立（可修正）

A 当前连的**已经是 B 的 App**：`resident-host` 由 B 的 `ZCode.app` main 进程
`fork` 出来（`desktopResidentHost.ts`），随 App 启停。它调用的
`createLocalServices({ serviceAuthorityMode: "desktop-attached-remote" })`
与 B 本机 host 是**同一份服务装配**，只是权威模式不同。

所以问题不是"连错了东西"，而是"B 的 App 内部有两个 host"。

### 2. 「映射操控 B 的软件 UI」——技术上不可行

实测 B 的 UI host（pid 41020）：

```
lsof -p 41020 -a -iTCP -sTCP:LISTEN  →  无任何监听
```

它是 Electron `utilityProcess`，与 renderer 之间走 `MessageChannelMain`
（`desktopHostProcess.ts`），**不暴露任何网络接口**。A 无法通过网络附加到它。

即使绕过（例如给 B 的 renderer 开 CDP 端口），那也只是"看到 B 的界面"，
B 的 UI 背后仍是 `zcode-host-local-1` —— 若 A 同时经常驻主机操作，
**双 host 分裂照旧**。映射 UI 不解决运行态分裂。

### 3. 真正能解决分裂的形态：B 的 UI 挂到常驻主机

```
现状：ZCode.app(main) ─┬─ zcode-host-local-1  ← B 的 UI      ┐ 两份内存运行态
                       └─ resident-host       ← A 远程挂载     ┘ → 进度分叉

目标：ZCode.app(main) ─── resident-host        ← B 的 UI + A 共用
                                                唯一运行态 → 天然一致
```

技术上可行：常驻主机已监听 `127.0.0.1:<port>` 并提供 `/ws/host`
（`desktop-continuous` 角色），B 的 UI 在本机连它即可，不经 SSH。

## 但有一个硬冲突：`serviceAuthorityMode` 是**每 host** 而非每 client

这是评估中最关键的发现。该模式在 host 装配时一次性决定（`createLocalServices`
调用点），控制的是**物理桌面相关能力**：

```ts
// services/src/node.ts
shouldCreateDefaultCuaProductHelper(...)     // 要求 desktop-local
shouldEnableCuaOperationStateReporter(...)   // 要求 desktop-local
// 注释原文：CUA 操作状态属于物理桌面投影；
//          远端 workspace/server 不得把自己的 turn 投影到本机屏幕。
offPeakToolWiring = mode === "desktop-attached-remote" ? {} : {...}
```

于是合一后必然二选一：

| 常驻主机的模式                    | B 的 UI 得到                                                                  | 风险                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `desktop-attached-remote`（现状） | **失去** CUA 电脑控制、内嵌浏览器控制、闲时任务工具面（共 14 项注入依赖缺失） | B 本机功能退化                                                           |
| `desktop-local`                   | 功能完整                                                                      | A 连接后可能把 **B 的桌面状态投影到 A 的屏幕**（代码注释明确禁止的语义） |

实测 B 本机 host 独有 14 项注入依赖，其中 `cuaOperationStateReporter`（4 处引用）、
`browserControlExecutor`（2 处）、`onOffPeakSchedulerWakeRequested`（2 处）、
`onAutomationManualRunRequested`（2 处）是实质能力，不是可选装饰。

## 结论与建议

**用户原始设想（直连/映射 B 的 UI）不可行**：B 的 UI host 无网络面，
且即使映射也不解决运行态分裂。

**可行的形态是「B 的 UI 挂到常驻主机」**，但需要先解决权威模式的每-client 化：
把"这个 client 是不是物理桌面的所有者"从 host 级参数改为**连接级参数**，
让 B 的 UI 连接拿到 `desktop-local` 语义、A 的连接拿到 `desktop-attached-remote` 语义。

这是对 `createLocalServices` 与 `/ws/host` 握手协议的实质改造，不是配置切换。

### 分阶段建议

**阶段 1（低风险，可立即做）**：消除误导
远程端检测到设备侧存在跨 host 的同项目 runtime 时，在 UI 明确提示
"设备本机也在运行该项目，远程操作可能与设备本机执行分叉"，
避免用户误以为远程操作已生效。已具备检测能力（`acceptance-device-topology.ts`）。

**阶段 2（中等风险）**：会话级串行化
即使同 host，A 与 B 同时操作同一会话仍需串行。可在会话级加执行租约，
让"正在执行"的一方持有，另一方只能看。

**阶段 3（高成本）**：host 合一 + 权威模式每-client 化
唯一能根治分裂的方案。需要改造 `createLocalServices` 的权威语义与
`/ws/host` 握手，并处理常驻主机故障时 B 的 UI 降级。

## 未验证 / 需用户确认

- **B 上是否使用 CUA（电脑控制）**：若不用，阶段 3 可直接选
  `desktop-attached-remote`（放弃 CUA），改造面大幅缩小。
- **B 的 App 是否可能长期关闭**：若会关，阶段 3 需额外设计
  "UI 不在时常驻主机是否继续跑"（当前常驻主机随 App 生死）。
