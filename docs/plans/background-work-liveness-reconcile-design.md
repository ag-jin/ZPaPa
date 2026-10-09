# 设计：同进程悬死 running 的对账机制（background work liveness reconcile，R1）

- 分支：`fix-background-work-status`
- 日期：2026-10-08
- 状态：待评审（architecture-planner 产出，供 task-planner 拆解）
- 问题编号：R1（用户实测症状路径：终端进程已死，后台面板 running 卡片不消失）
- 姊妹篇：`docs/plans/subagent-orphan-reconcile-design.md`（P2-1，跨重启孤儿）；本工作树已落地的
  activation 收敛（`background-task-orphan-reconcile.ts`）覆盖**跨重启**形态，本文覆盖**同进程**形态。
  两者是同一张对账矩阵的两个切片，不是重复机制（边界论证见 §5.6）。

---

## 1. 问题陈述

test-verifier 在 4aab9bb 钉死的事实链：

1. 真重启（进程死透）后 `backgroundWorks` 为空 ⇒ 面板无 running 卡片。**用户可见的「死了的终端仍显示
   运行」只能来自同进程内存态**：会话常驻（未重新激活，activation 挂点 `existing` 早退不收敛）、内存
   event store 悬着 `background_task_started{running}`、而终端进程已死。
2. 强跑 activation 收敛也救不了这条路：其 J4 读 runtime 投影 `backgroundTasks`，该投影由**同一份**
   内存事件归约（§2-C2），与 v4 `backgroundWorks` 同源同判 running。
3. BackgroundTaskTracker 的 1s 轮询已在 9c1e81c 修为「必发布终态」——但它只在 **tracker 自己活着、
   信源不说谎、发布不失败** 时有效。R1 要修的正是这三条前提全部可能失守的场景。

### 目标

1. 同进程内，凡「面板声称 running 而进程内真相说它已终结/已不可达」的 work，在**有界时间内**
  （分钟级，不依赖用户操作）收敛到明确终态，卡片消失。
2. 终态可分辨：真终态快照（completed/failed + exit code）与 lost（「不在运行但无 outcome」）分开，
   与既有 lost 语义（`background_task.tracking.lost`、activation 收敛的 `background_task_outcome`）
   使用同一族词表。
3. 发布走**单一写路径**：与 tracker 同一条终态发布链（registry 更新 + 通知 claim + 事件 append），
   不造第二份「谁有权宣布终态」。
4. 绝不误杀（§5.5 不变量清单）；失败只降级 warn，绝不拖垮 tick / 会话 / 主流程。

### 非目标

- 不修跨重启孤儿（activation 收敛已覆盖；本机制发布的是内存事件，进程死后 backgroundWorks 本来
  就为空，无需持久补洞）。
- 不做跨进程会话租约/presence 协议（ADR0003 单运行台下没有常态消费者）。
- 不恢复「把死终端救活」的执行能力（对账只裁决状态）。
- 不改前台（阻塞式）Bash、不改 subagent/dwf 各自的收敛先例。

---

## 2. 证据基础

以下事实均在本工作树源码核实（文件:行号）。分类：**[C]** 已确认、**[I]** 推断、**[U]** 未决（实现期核定）。

### 2.1 已确认事实

| #   | 事实                                                                                                                              | 证据                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 面板 `backgroundWorks` 只由进程内事件喂出：`BackgroundTaskStarted/Updated/Completed` 经 `onBackgroundTaskLifecycle` 归约；这些事件**不在**持久化名单里（`persistDurableSessionEvent` 只白名单 Checkpoint/Rewind/TurnSteer/UserInputAutoResolution 等少数类型）——这正是「真重启后 backgroundWorks 为空」的机制 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:4234-4332`、`apps/zcode-cli/packages/core/src/runtime/methods/events.ts:263-385`                                       |
| C2  | runtime 投影 `backgroundTasks` 与 v4 `backgroundWorks` **同源**：`rebuildProjection` = `eventStore.getEvents` → `eventReducer`（`applyBackgroundTaskStarted` 等按 taskId 覆盖行）。activation 收敛的 J4（`liveStatusByWorkId`）读的就是它 ⇒ 事件悬 running 时 J4 也判 running | `core/src/runtime/methods/message-persistence.ts:385-388`、`contracts/src/events/event-reducer-helpers.ts:122-158`、`bootstrap/src/zcode-protocol/background-task-session-query.ts:236-247`             |
| C3  | event store 是进程内内存态（`InMemorySessionEventStore`，per-session Map，turn 窗口淘汰）                                            | `contracts/src/events/in-memory-session-event-store.ts:33-45`                                                                                                                                                                    |
| C4  | tracker（1s 轮询 + waitForTerminal 双臂）9c1e81c 后必发布终态：快照缺席 → `lost`；终态快照 → 真实终态。但存在两个「停摆不发布」的洞：① `waitForCompletion` 抛错且 `!hasSnapshotProvider` 时 `stopTracking()` **不发终态**；② `emitTerminalSnapshot` 内 `emitBackgroundTaskEvent` 抛错时 poll 每秒重试、永不收口（registry 已 terminal 而事件未落，投影继续 running） | `core/src/tool/executor/background-tasks.ts:134-160`（lost 分支）、`:337-353`（洞①）、`:219-306` 与 `:309-335`（洞②：poll catch 只 warn）                                                                          |
| C5  | bash 终端进程 = 执行适配器（与 runtime 同进程）直接 spawn 的子进程；适配器的 `backgroundTasks` record（`status/pid/completion` promise/输出字节）是**进程内 ground truth**：`getBackgroundTask`/`readBackgroundBashOutput` 读 record；record 终结由 `run()` promise 结算驱动（`finalizeBackgroundTaskRecord`） | `adapters/src/exec/node-execution-adapter-lifecycle.ts:23-100`、`:300-363`、`node-execution-adapter-base.ts:141-211`                                                                                              |
| C6  | subagent child runtime **共享**父会话 eventStore 与 executionPort（同一适配器实例）⇒ 适配器 record 对全进程的 bash work 可见，父 runtime 的探测能覆盖子代理启动的后台任务，不存在「记录在别的适配器里」的盲区 | `core/src/runtime/methods/subagent.ts:296`、`:320`                                                                                                                                                                               |
| C7  | 面板卡片只渲染 `status === "running"` 的 bash work（running 闸门）；状态一旦离开 running 卡片自然消失，**零 UI 改动**                                            | `packages/ui/src/v4/conversationStatusPanelModel.ts:403-417`                                                                                                                                                                     |
| C8  | 终端详情视图直接轮询 `readBackgroundBashOutput`（record 快照，`status: snapshot.result ? snapshot.status : "running"`）——**用户能亲眼看到「终端已死」而面板说 running** 的那条缝 | `packages/ui/src/hooks/useBackgroundBashOutput.ts:31-68`、`node-execution-adapter-lifecycle.ts:300-337`                                                                                                            |
| C9  | activation 收敛只在接管时刻跑：`activateSessionForResume` 开头 `existing` 早退（`:1437-1440`），两个收敛挂点在 activation 尾部（`:1526-1538`）⇒ 常驻会话永不重跑                                                                  | `bootstrap/src/zcode-protocol/server-operations.ts:1420-1538`                                                                                                                                                                    |
| C10 | ADR0003 已实施：桌面默认**不**fork 独立常驻主机（日志 `[resident-host] standalone fork skipped: window host exposes itself`），独立 fork 需 `ZCODE_RESIDENT_HOST_FORCE_STANDALONE=1`；即默认拓扑下「窗口 host 重启而常驻主机活着」不存在——host 与常驻暴露是同一个进程，终端进程是它的子进程 | `packages/desktop/src/main/index.ts:1994-2014`、`docs/adr/0003-single-runtime-window-host-as-resident.md`、`packages/desktop/src/main/desktopResidentHost.ts:57-79`                                                     |
| C11 | 看门狗 tick 先例 `squadWatchdogTick`：60s repeating + `unref` + 重入护栏 + **三态探测**（`unavailable` = 探测坏了 ⇒ 不猜、跳过本轮）+ 逐条容错（一条坏行不停整轮）+ `stop()` 必须与启动配对 + 懒取端口（每轮现取，防服务重建后打旧实例） | `packages/desktop/src/host/squadWatchdogTick.ts:53-64`（三态）、`:849-939`（tick 形态）                                                                                                                            |
| C12 | 协议 server 已有 **60s 维护节拍**可借（资源采样 `onSample` 内串行做 `rebalanceResidentSessions` / `pruneSessionEventStores` / `pruneDetachedChildPublishers`），不新增定时器                                     | `bootstrap/src/zcode-protocol/resource-sampler.ts:24-39`、`server.ts:289-309`、`zcode-protocol-entrypoint.ts:336`                                                                                                  |
| C13 | stale-branch 事件围栏只挂在两处镜像 emit（mailbox hook runner、subagent 父镜像），**主 tool executor 的 emitEvent 不围栏** ⇒ tracker 自己的发布不会被 rewind 丢弃                                            | `core/src/runtime/methods/runtime-command-generation.ts:32-66`、`runtime/helpers/runtime-tools.ts:131` 与 `:176-178`、`methods/subagent.ts:76`                                                                                    |
| C14 | 三个收敛先例的「写什么」边界：subagent/bash-activation 收敛**不合成父事件**（只落持久补洞事实）；dwf 收敛只写 run 行。三者的共同前提都是「接管/构造时刻本进程零在飞」——R1 恰恰没有这个时刻（会话常驻、tracker 名义上在飞），所以 R1 的收敛者必须**发事件**（内存态的唯一收口方式），这是与先例的有意差异，不是违规 | `subagent-orphan-reconcile-design.md` §4.3、`background-task-orphan-reconcile.ts:27-31`、`dynamic-workflow-run-reconcile.ts:52-58`                                                                                |
| C15 | 终态发布的组成件已在 tracker 内：payload 构造（`backgroundTaskPayload`，含 `taskKind/pid/起止/输出元数据`）、registry 更新（`updateRuntimeBackgroundTask`）、通知 claim（`claimRuntimeBackgroundTaskNotification`）、事件 append；`lifecycleProvider` 按 toolName 分派四种 provider（subagent / dwf / legacy Workflow / Bash+通用） | `core/src/tool/executor/background-tasks.ts:386-438`、`:750-817`、`background-task-registry.ts:118-148`                                                                                                            |
| C16 | runtime 公开面已有 `hasRunningBackgroundTasks` / `stopBackgroundTask` / `readBackgroundBashOutput`；`runtimeTaskRegistry` 与 `executionPort` 是 **private**（`agent-runtime.ts:178/181`）⇒ 同进程对账需要一个窄的新公开方法，而不是让 bootstrap 伸手进私有态 | `core/src/runtime/agent-runtime.ts:337-448`（接口）、`:178-181`（私有）、`methods/index.ts:361-365`                                                                                                                 |

### 2.2 推断

| #   | 推断                                                                                                                                                                                       | 依据      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| I1  | 子进程被外部杀死（kill -9 / OOM）时 `run()` promise 正常结算（Node 子进程 exit 事件必然触发），record 变终态 ⇒ **只要 tracker 活着且发布成功，1s 内收口**。因此 R1 的可达路径必然落在「tracker 停摆 / 发布失败 / record 谎报」三族（§3 P1-P3），而不是「正常死亡没人看见」 | C4、C5    |
| I2  | `ZCODE_RESIDENT_HOST_FORCE_STANDALONE=1` 的双运行时形态下，跨 host 的 running 事件互不可见（内存态 per 进程），用户疑点场景（「软件重启」= 窗口重启而常驻主机活着）在该形态才可达；默认拓扑（C10）排除。用户是否开了该 env 可由 main 日志一行判定 | C3、C10   |
| I3  | 同进程对账把终态**事件**发进 event store 后：runtime 投影、v4 `backgroundWorks`、面板三面经既有归约自然收口（9c1e81c 的 tracker 发布走的就是这条链，已被生产验证）；模型通知经 claim 幂等不会双发 | C1、C2、C15 |

### 2.3 未决（实现期核定，不阻塞方案形态）

| #   | 未决项                                                                                                                                                                                       | 核对方法                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| U1  | `run()` promise 的结算条件：是否在子进程 exit 后还等 stdout/stderr 流关闭（detached grandchild 持管道 ⇒ root 已死但 record 停 running，即 P3 的确切机理）                                                | 读 `node-execution-adapter-run.ts` 的结算链 + 实验：后台跑 `sh -c 'sleep 300 &'`，kill 外层 shell，观察 record.status |
| U2  | rewind 后 v4 ProductProjection 是否保留 pre-rewind 的 `background_task_started`（P5 的可达性）                                                                                                     | 手工 rewind 带后台任务的会话，观察卡片；或读 rewind 对事件/投影的裁剪逻辑       |

---

## 3. 根因定位：同进程悬死 running 的可达路径穷举

公共前提（事实链钉死）：会话常驻（C9 早退）∧ event store 悬 `started{running}`（C1/C3 不持久）∧
终端进程已死 ∧ tracker 的终态发布从未落进 event store。按「tracker 为什么没发布」分族：

| 路径 | 机理                                                                 | 可达性（默认桌面拓扑）                            | 日志/现场判据（只读取证）                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | tracker 停摆不发终态：`waitForCompletion` 抛错且 `!hasSnapshotProvider` → `stopTracking()` 静默退场（C4 洞①） | 低（desktop 的 Bash 装配带 `getBackgroundTask`，provider 恒在；仅 stub 宿主可达） | 该 taskId 有 `background_task.tracking.started`，**无** `tracking.terminal`/`tracking.lost`，且无每秒 `Background task polling failed`；详情页（C8）显示已结束 ⇒ record 已终态而无人发布                   |
| P2   | tracker 发布失败循环：`emitBackgroundTaskEvent` 持续抛错（append/sink 异常），poll 每秒重试永不收口；registry 已 terminal、投影仍 running（C4 洞②） | 中（appendEvent 抛错即可触发；通常瞬时，持续抛错需 sink/store 级故障） | 每秒一条 `Background task polling failed`（warn，含 taskId）从终端死亡时刻开始持续；`tracking.terminal` 缺席                                                                                              |
| P3   | 信源谎报 running：子进程已死但 `run()` promise 未结算（exit 后仍等流关闭 / grandchild 持管道，U1），record.status 停 `running`，tracker 忠实地每秒发布 running 更新 | 中-高（长驻 shell 会话 + 组合命令的后台任务是常见用法）           | 详情页也显示 running（C8 同源 record），但 `ps -p <pid>` 查无此进程；`tracking.terminal` 缺席、无 polling failed；`BackgroundTaskUpdated` 事件持续但 `stdoutBytes` 不再增长                                  |
| P4   | 同进程 runtime 替换后 gateway 残留旧投影（去激活/再激活竞态，旧 publisher 未重建）                                                    | 低（`waitForDeactivation` 闸门 + 再订阅重建；未见复现）    | 事故时刻附近有 `zcode_protocol.session.resume_completed`（重激活）而卡片在重激活**之后**仍 running；重订正后是否消失待 U2 一并核对                                                                             |
| P5   | rewind/分支代际残留：started 落在旧分支、终态发布被 stale-branch 围栏丢弃或投影未裁剪                                                    | 低（C13：主 emit 不围栏；仅两条镜像路径可丢）              | 事故前有 rewind/branch 事件（sqlite `SessionResumed`/rewind entry）；started 事件时刻早于 rewind                                                                                                          |
| P6   | 跨 host：`ZCODE_RESIDENT_HOST_FORCE_STANDALONE=1` 双运行时（用户疑点场景的真实形态）                                                    | 默认排除（C10：需显式 env）                            | main 日志含 `[resident-host] forked pid=`（开）或 `standalone fork skipped: window host exposes itself`（关）；开了即用户疑点成立：会话与事件活在对端 host，终端进程随本端死亡，tracker 在对端探不到本端 record |

**判定决策树**（给 debugger/取证用，全部只读）：

```
1. main 日志查 resident-host 行           → forked ⇒ P6（用户实际路径成立）；skipped ⇒ 排除 P6
2. service 日志按 taskId 查 tracking 族：
   有 tracking.terminal / tracking.lost   → 该任务本已收口，症状另有其因（回到 test-verifier 复核）
   每秒 Background task polling failed    → P2
   无 terminal/lost ∧ 详情页显示已结束      → P1（或 P2 的 registry-已-terminal 变体）
   无 terminal/lost ∧ 详情页显示 running    → P3：ps -p <pid> 复核进程；死 ⇒ P3 钉死
3. sqlite 查 rewind/resume entry 落在 started 之后 → P4/P5 候选，按 U2 核对
```

**结论**：默认桌面拓扑下，用户实际路径最可能是 **P2/P3 族**（tracker 活着，但发布链坏了或信源说谎），
其次 P1；P6 需要显式 env，可用一行 main 日志证实/证伪。**设计不押注单条路径**——机制对 P1-P3 全族
自愈（P4/P5 属投影层缺陷另行修，见 §9-R6），这正是选「看门狗周期对账」而非「tracker 补洞」的理由。

---

## 4. 方案选型（design-it-twice 摘要）

| 维度 | A. 看门狗周期对账（推荐）                                              | B. 读边界对账（惰性收敛）                                            | C. tracker 兜底强化                                                     |
| ---- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 形态 | 借 60s 维护节拍（C12），对常驻会话投影里 running 的 work 重新探测真相（适配器 record 三态 + pid 二次核验），死则按 tracker 同一条发布链收口 | 在读 `backgroundWorks`/inventory 时按需探测并收口                                  | 继续加厚 tracker：无 provider 的 running 也收 lost、发布失败重试有界、快照 running 但进程死也收 |
| 覆盖 | P1/P2/P3 全族（**不依赖 tracker 活着**——这是它对 C 的决定性优势）                   | 同左，但只在「有人读」时生效                                                      | 只覆盖 tracker 活着的场景：P1 可修（洞①补终态），P2 半修（重试有界），**P3 无法修**（tracker 无法证明自己的信源说谎——除非把 pid 核验也塞进 tracker，那它就变成了方案 A 的轮询版） |
| 误杀风险 | 低：record 优先 + 三态探测（unavailable 不猜）+ pid 死需连续多拍 ∧ 宽容期 ∧ 输出无增长 | 同 A 但判据散到读路径，易漂移                                                       | tracker 内塞 pid 判据与 1s 轮询同频，误杀窗口更密                                                          |
| 常驻/双端 | 单进程内自洽；ADR0003 单运行台下所有端共享同一 host ⇒ 一份对账覆盖全部端          | 双端一致（同源收口）                                                                | 同左                                                                                               |
| 与三先例一致性 | squadWatchdogTick 形态对齐（C11：三态、容错、unref、stop 配对）；「发事件」与先例「不合成事件」的差异由 C14 论证（先例有持久权威行可写，R1 只有内存事件一条收口路） | 无先例；且 backgroundWorks 是订阅推送，**没有自然读边界**，强行在 `getProjection`/hydration 塞副作用违反「投影是纯归约」的仓内纪律 | 9c1e81c 的延续；但先例的教训（121 个后台 Agent 零 terminal）恰恰是「单点发布口不可靠」——再加厚单点不如加独立观测者 |
| 回滚边界 | 一个 core 模块 + 一个 runtime 方法 + tick 一行调用，单提交 revert                  | 读路径散改多处，回滚面大                                                            | 改在 tracker 内，回滚小但**修不完**                                                                        |

**推荐：A 为主，附带 C 的一个窄修**（P1 洞①是客观缺陷，顺手独立提交修掉——`waitForCompletion`
失败退场前必须发布终态或转入轮询臂，不允许静默 stopTracking；它与 A 无耦合，先落地先止血）。
B 否决：没有读边界、投影不能带副作用、不自愈（不打开面板就永远悬着）。

---

## 5. 推荐方案详细设计

### 5.1 模块与 seam

新模块一个：**BackgroundWorkLivenessReconciler**（`apps/zcode-cli/packages/core/src/runtime/methods/background-liveness.ts`，
与 `background.ts` 同目录同风格）。外部 seam 是 `AgentRuntime` 上**一个**新方法；内部复用两件既有实现
（provider 分派、终态发布），通过提取共享而不是复制（单一写路径纪律）。

```
调用方（唯一）                     模块（深模块：小接口，大实现）                       适配器/既有件
──────────────                   ──────────────────────────────────────               ───────────
60s 维护节拍                      AgentRuntime.reconcileRunningBackgroundWorkLiveness()
（resource-sampler onSample，        │ 候选：rebuildProjection().backgroundTasks
 server.reconcileBackgroundWork      │       中 status === "running" 的行
 Liveness() 一行，仿 rebalance）      │ 探测：lifecycleProvider(toolName).getSnapshot  ← 提取共享（T1）
                                    │   三态：running / terminal / unavailable
                                    │ pid 二次核验（仅 snapshot=running 时）
                                    │   process.kill(pid, 0) + 输出增量 + 宽容期
                                    │ 发布：终态事件 + registry + 通知 claim      ← 提取共享（T2）
                                    ▼
                          event store（appendEvent）→ runtime 投影 / v4 backgroundWorks
                                                / 面板卡片（既有归约，零改动收口）
```

- **Interface**：`reconcileRunningBackgroundWorkLiveness(input?: { now?: number }): Promise<BackgroundWorkLivenessReconcileSummary>`。
  输出 `{ settled: number; skipped: Array<{ workId: string; reason: string }>; failed: number }`——供结构化
  日志与单测断言（对齐 squadWatchdog 的 summary 形态）。
- **Seam**：外部 seam = runtime 方法（bootstrap 的 60s tick 是唯一调用方）；测试 seam = 方法本身——
  fake provider（三态）+ 注入 pid 探测函数 + 注入时钟即可测全部判据分支，不需要真子进程。
- **Depth / leverage**：调用方一行；候选枚举、provider 分派、三态判定、pid 核验、宽容期、发布、容错
  全部藏在模块内；投影/面板/详情页三个消费方零改动拿到收口。
- **Deletion test**：删掉该模块，「从进程内真相重新裁决 running」的逻辑要么塞回 tracker（P1/P2 下它
  已经死了，救不了）要么散到三个读面——模块在挣钱。

### 5.2 状态所有者与事件顺序（规范要求的状态/时序图）

```
状态所有者：
  执行适配器 backgroundTasks record        ← 进程内 liveness 唯一 ground truth（status/pid/completion/字节）
  runtime task registry（per-runtime 内存） ← 结算面（notified/exitCode…），tracker 与 reconciler 共用更新入口
  event store（per-session 内存）           ← running/终态的投影权威；reconciler 只经 appendEvent 写
  持久层（transcript ACK / 唤醒轮 / outcome entry） ← 跨重启权威（activation 收敛的领地，本机制不写）
  ProductProjection / 面板                  ← 纯投影，无独立状态

事件顺序（同进程悬死的收敛时序）：

  T0  turn 内 Bash 后台启动：适配器 record{running, pid} → tracker 发 started{running}
      → event store / 投影 / 面板卡片出现
  T1  异常：终端进程死亡，但 tracker 的终态发布未落库（§3 P1/P2/P3 任一）
      ⇒ event store 悬 started{running}，卡片常驻「执行中」
  T2  60s tick → server.reconcileBackgroundWorkLiveness()
      → 对每个常驻 record：runtime.reconcileRunningBackgroundWorkLiveness()
        ├─ 候选 = 投影 running 行
        ├─ 探测 provider.getSnapshot(workId)
        │    terminal   ⇒ 立即发布真实终态（completed/failed + exit code）        ← P1/P2 的收口
        │    unavailable ⇒ 发布 lost（与 tracker 的 snapshot_missing 同语义）      ← record 已消失的收口
        │    running    ⇒ pid 二次核验：连续 N 拍 ESRCH ∧ 超 grace ∧ 输出零增长
        │                 ⇒ 发布 lost（reason: process_exit_unobserved）           ← P3 的收口
        │                 否则不动（安静但活着的任务）
        └─ 发布 = 终态事件 append + registry 更新 + 通知 claim（与 tracker 同一实现）
  T3  event store 收到终态事件 → 投影/面板卡片消失（既有归约，I3）
  T4  之后 tracker 若复活并再发布同 taskId 终态：registry 已 terminal（update 早退）+
      通知已 claim（不双发）+ 投影幂等 ⇒ 无害
```

### 5.3 判据（全部成立才收敛；任何一项不满足就跳过并留痕）

```
L1 候选      本会话投影 backgroundTasks 中 status === "running" 的行（workId ≡ taskId）
             ——投影是「怀疑清单」，不是真相；真相只来自 L2/L3
L2 provider 探测（按 toolName 复用 lifecycleProvider 分派：subagent→subagentPort.getTask、
             dwf→dynamicWorkflowRunPort.getTask、legacy Workflow→workflowPort.getTask、
             Bash/其余→executionPort.getBackgroundTask；C6 保证 subagent 启动的 bash 也在本适配器）
L3 三态裁决（squad 先例的形状，unavailable ≠ 结论）：
   a. snapshot.status ∈ 终态   ⇒ 立即发布真实终态（复用 tracker 的 terminalStatus 归一）
   b. snapshot === undefined   ⇒ 发布 lost（tracker 的 snapshot_missing 同语义；同进程内
      started 由本进程发出（C1）∧ record 不在共享适配器（C6）⇒ 本进程已无法观测它）
   c. snapshot.status === "running" ⇒ 进入 L4 二次核验
L4 pid 二次核验（仅 c 支；防「record 谎报 running」的 P3，也防 pid 复用误杀）：
   全部成立才判 lost(reason=process_exit_unobserved)：
   - record.pid 存在且 process.kill(pid, 0) 抛 ESRCH（EPERM/其他 ⇒ 视为活着，不猜）
   - 连续 BACKGROUND_WORK_LIVENESS_CONFIRM_TICKS 拍（默认 2 拍 = ~2 分钟）结论一致（进程内记忆）
   - startedAt 距今 > BACKGROUND_WORK_LIVENESS_GRACE_MS（默认 10 分钟，对齐两先例宽容期）
   - 两次探测间 stdoutBytes/stderrBytes 零增长（输出仍在涨 = 还有活着的写者，不杀）
L5 发布：经共享终态发布件（T2 提取）——事件 status 用真实终态或 lost；payload 复用
   backgroundTaskPayload 形状（投影行的 toolCallId/toolName/command/description + snapshot 事实）
L6 逐条容错：一条 work 的探测/发布失败只 warn + failed++，不停整轮（squad 先例）
```

**信源清单（liveness 的全部依据，穷举）**：① 适配器 record 状态（首判）；② `record.completion`
（发布件不直接用，但 record 终结的驱动源）；③ record.pid 的 OS 存在性（仅 c 支二次核验）；
④ 输出字节增量（c 支的反证信号）。**明确不作为信源**：event store 投影（同源即同谎）、
UI 状态、transcript ACK（启动即 completed，分不出死活）。

### 5.4 与既有机制的关系（不重复、不冲突）

| 既有机制                                    | 分工                                                                                        | 交界                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| tracker 1s 轮询（9c1e81c）                  | 一线观测者：正常路径的及时终态（1s 级）                                                        | reconciler 是二线观测者（60s 级）：只在 tracker 失守时兜底；共用发布件 ⇒ 幂等互不干扰（§5.2 T4）             |
| activation 收敛（本工作树已落地）            | 跨重启孤儿：接管时刻零在飞 ⇒ 写持久 `background_task_outcome` entry                            | R1 不写持久 entry（进程死后内存态自清，C1）；若 R1 的 lost 通知唤醒轮成功落库，activation 侧读到 notification 终局自然跳过 |
| subagent orphan 收敛 / dwf 构造收敛          | 各自持久层的跨重启补洞                                                                       | 形态对齐（宽容期、三态、逐条容错、失败降级）；「发事件 vs 落 entry」的差异由 C14 论证                   |
| `stopBackgroundTask`（用户停止）             | 用户的主动取消（写 cancelled）                                                                | reconciler 不取消任何进程，只发布观测；两者经投影 running 闸门 + registry 终态天然互斥                  |
| resident pool 的 `hasRunningBackgroundTasks` | 会话回收护栏（registry 口径）                                                                 | reconciler 收口后 registry 离开 running ⇒ 护栏同步受益（悬死 running 也在错误地钉住会话常驻）       |

### 5.5 不误杀不变量清单

| #   | 绝不能收敛的场合                                                 | 判据如何排除                                                                                                                                                                              |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | 真在跑的终端（安静 >10 分钟但进程活着）                          | L3c：record=running ∧ pid 活（kill(pid,0) 成功或 EPERM）⇒ 永不进入收敛分支；输出零增长也不杀（安静合法）                                                                                     |
| N2  | record=running 但 pid 未记录（老宿主/形状缺失）                   | L4 第一项不成立 ⇒ 不判死，保持 running（「读不到证据就不动手」）                                                                                                                             |
| N3  | root 进程刚死、grandchild 仍在写输出（管道持有，U1 场景）         | L4 输出增量反证：字节在涨 ⇒ 不杀。代价是该形态收敛延迟到输出真停——宁可慢勿误杀（grandchild 的产出对用户可能是有效工作）                                                                      |
| N4  | subagent 启动的后台 bash（record 在共享适配器，但属于 child 会话） | C6：适配器进程级共享 ⇒ 探测结论就是真相；且 reconciler 只读 workId 不改属主；child runtime 若还活着它的 tracker 是一线，reconciler 是二线，发布件幂等                                          |
| N5  | 双端（手机/web）同 host 观看同一会话                             | ADR0003 单运行时：对账发生在唯一 host 内，所有端经同一投影收口，无第二结论源                                                                                                                  |
| N6  | 双进程违例（CLI + 桌面同会话 / FORCE_STANDALONE 双 host，契约外） | started 事件在本进程 event store（C1）是「本进程观测过它」的必要条件；若任务真在另一进程跑，本进程 record 不在 ⇒ L3b 会收 lost——**残差接受**：与两先例对契约外双进程的处理一致（宽容期缓解、单属主契约根治），见 §9-R1 |
| N7  | work 有任何真实终态（tracker 恰好在同一拍发布）                   | 候选取自投影 running 行：tracker 先发布 ⇒ 行已离场；同拍竞态由发布件幂等吸收（§5.2 T4）                                                                                                       |
| N8  | 探测本身失败（provider 抛错 / 注入缺失）                          | 三态 `unavailable` ≠ 结论：跳过 + 留痕（squad 先例「不猜」）；连续失败不升级为 lost                                                                                                            |
| N9  | reconciler 自己的发布失败                                        | L6：warn + failed++，下一拍重试；绝不拖垮 tick / 会话（tick 本身在 sampler 的异常兜底内，C12）                                                                                                 |

### 5.6 UI 呈现

| 面                       | 收敛后显示                                                                                              | 改动量 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------ |
| 面板卡片                 | 卡片消失（`status` 离开 running，C7 的 running 闸门）                                                     | 零     |
| 终端详情页               | 已在显示真实终态（C8 同源 record）；R1 收口后不再出现「详情已结束/面板运行中」的裂缝                        | 零     |
| 会话行 / 后台结果通知     | 真实终态走既有 completed/failed 文案（含 exit code）；lost 走既有 `buildBackgroundTaskSummary` 的 lost 分支（"failed because its in-process state was lost"） | 零     |
| 与「已丢失」族的关系      | bash work 的 lost 在 v4 summary 层归一为 `failed`（`onBackgroundTaskLifecycle` 的 rawStatus 映射既有行为）；与 subagent 侧栏的「已丢失」是同一语义族、不同投影视口，**不新造终态词、不新增 i18n** | 零     |

---

## 6. 测试计划

**单测（core，node:test + fake，对齐仓内惯例）** `background-liveness.test.ts`：

1. 投影 running + provider 终态快照 ⇒ 发布真实终态事件（status/exitCode 透传），registry 同步 terminal；
2. provider 回 undefined ⇒ 发布 lost；投影行离场；
3. provider 回 running ∧ pid 探测 alive ⇒ 不发布（N1）；
4. provider running ∧ pid ESRCH ∧ 未过宽容期 / 未满确认拍数 ⇒ 不发布；满两拍且过宽容期 ⇒ 发布
   lost(reason=process_exit_unobserved)；
5. pid EPERM ⇒ 视为活着不发布（N2/L4）；
6. 两拍间 stdoutBytes 增长 ⇒ 不发布（N3）；
7. provider 抛错 ⇒ unavailable 跳过 + failed 不计 settled（N8）；
8. 发布件抛错 ⇒ warn 不扩散，summary.failed=1（N9）；
9. 幂等：同 workId 第二次 tick（投影已 terminal）⇒ 不再进候选；
10. 多 work 混合：一个真终态、一个 lost、一个活着 ⇒ 各得其所，互不影响（L6）。

**共享件回归（T1/T2 的提取是行为不变重构）**：`backgroundSubagentTerminalEvent.test.ts` 及既有
tracker 相关测试逐例保持绿。

**bootstrap wiring 测试**：fake app 记录 `reconcileRunningBackgroundWorkLiveness` 调用；
60s tick（注入 timer）触发一次；app 缺方法（stub 宿主）⇒ 静默跳过不抛。

**真机 E2E（implementer/test-verifier 手工）**：

1. 后台跑 `sleep 600` ⇒ 卡片在；`kill -9` 该进程 ⇒ 卡片在 ~2 个 tick 内消失、通知到达（P1/P2 形态收口）；
2. 后台跑 `sh -c 'sleep 300 & wait'` ⇒ kill 外层 shell、留 grandchild 持管道（U1 复现）⇒ 输出停后按
   L4 时限收敛，输出未停不收敛（N3）；
3. 安静但活着（`sleep 600`，10 分钟无输出）⇒ 永不收敛（N1 主验收）；
4. subagent 里启动后台 bash ⇒ 子代理结束后 work 仍被正确裁决（N4）；
5. 双端打开同会话 ⇒ 两端同时看到收口（N5）。

---

## 7. 实施拆分（T 级，供 implementer 执行）

依赖序：T0 → T1 → T2 → T3 → T4 → T6；T5 独立可先行；T7 收尾。
**协调提示**：本工作树另有 implementer 正在改 background-task 相关文件（`background-task-registry.ts` /
`background-task-session-query.ts` / `background-task-orphan-reconcile.ts` 族）；T1/T2 触及
`background-tasks.ts`（tracker），拆解时必须与在途改动排他（先 rebase 再动，提交说明注明）。

| 任务 | 内容                                                                                                                                         | 依赖 | 风险标注                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| T0   | spec 先行（仓规范）：把 §5 判据/不变量落为行为 spec；同时核定 U1（run 结算条件）与 U2（rewind 残留），结论写进提交说明                             | —    | 低；U1 结论只影响 L4 参数微调，不改变方案形态                                                    |
| T1   | 提取 `lifecycleProvider` 分派为共享件（tracker 与 reconciler 共用；纯移动，行为不变）                                                             | T0   | 低；与在途 implementer 改动排他                                                                 |
| T2   | 提取终态发布件（payload 构造 + registry 更新 + 通知 claim + 事件 append；tracker 改为调用它）——单一写路径的落点                                    | T1   | 中；必须保持 tracker 既有测试逐字节绿（发布时序/字段不得漂移）                                    |
| T3   | core 新模块 `background-liveness.ts`：判据 L1-L6 + 常量（`BACKGROUND_WORK_LIVENESS_GRACE_MS` / `_CONFIRM_TICKS`）+ 结构化日志（`background_task.liveness.*` 族，对齐既有命名）+ AgentRuntime 接口方法 | T2   | 中；接口只有一个方法（C16 的私有边界不破）                                                        |
| T4   | bootstrap 挂点：`server.reconcileBackgroundWorkLiveness()`（遍历 `context.sessions`，逐 record 调用，逐会话容错）+ resource-sampler 60s onSample 一行 + wiring 测试 | T3   | 低；借既有节拍（C12），不新增 timer、不动 squad tick                                              |
| T5   | tracker 洞①修复（独立止血提交）：`waitForCompletion` 失败退场前必须发布终态或保持轮询臂，禁止静默 `stopTracking`；补单测                          | —    | 低；与 T1/T2 排他协调；即便 A 方案延期也先修                                                       |
| T6   | 测试补齐：§6 单测 1-10 + wiring + 回归护栏                                                                        | T3/T4 | 低                                                                                              |
| T7   | `pnpm typecheck` / `pnpm lint` / `pnpm --dir apps/zcode-cli typecheck` / lint + `pnpm architecture:check --changed`；如实记录结果                   | 全部 | 流程项                                                                                          |

---

## 8. 风险与回滚

| #   | 风险                                                                                                 | 概率/影响 | 缓解                                                                                                       | 回滚                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | 契约外双进程（N6）下误收敛另一进程仍在跑的 work                                                          | 低/中     | started-in-this-store 前提 + 宽容期 10 分钟；ADR0003 已消除常态双 host；FORCE_STANDALONE 用户可关 env       | 摘掉 tick 一行调用即整体退场；误收的 work 在下一进程重启后由既有 activation 收敛兜底         |
| R2  | pid 复用：record 谎报 running、pid 已被无关进程复用 ⇒ kill(pid,0) 成功 ⇒ 不杀（无害方向）；但 ESRCH 误报不存在（极小） | 极低/低   | 连续两拍 + 宽容期 + 输出零增长三重条件；ESRCH 是内核事实，比任何推断都硬                                     | 同 R1                                                                                       |
| R3  | 与 tracker 竞态双发布                                                                                    | 低/低     | 发布件幂等（registry 终态早退、通知 claim、投影内容比对，C15）；§5.2 T4 已列                                                               | 无需回滚                                                                                   |
| R4  | T1/T2 提取共享件时行为漂移（tracker 是生产关键路径）                                                      | 中/中     | 提取提交零行为变更 + 既有测试逐例绿 + 单独提交便于二分                                                      | revert 提取提交，reconciler 退回复制版（次优但可用）                                          |
| R5  | 60s tick 对常驻会话的投影重建开销                                                                         | 低/低     | 候选先按投影 running 过滤（绝大多数会话为空集即返回）；投影已有 60s 级重建先例（rebalance/prune 同拍）       | 摘 tick 一行                                                                                |
| R6  | P4/P5（投影层残留）不在本机制覆盖内，修完后仍有残留病态                                                    | 低/中     | §3 判定树可把它单独钉出来；届时按投影层缺陷另行立 item，不往 reconciler 加兜底分支（AGENTS.md：不不断增加兜底） | —                                                                                           |

**回滚边界**：整个机制 = 1 个 core 新文件 + AgentRuntime 一个方法 + server 一个方法 + tick 一行 +
两笔行为不变的提取提交；可按提交粒度分别 revert，不触碰 tracker 判定语义（除 T5 的洞修复，其本身是
独立正确性修复）。

---

## 9. 交接说明（给 task-planner）

- 设计已达「可拆解」：模块单一、对外接口一个方法、内部共享件两笔提取、挂点一行；无并行图（按 T0→T7 串行即可，T5 可独立先行）。
- 硬线（给 code-reviewer）：①任何情形下「record=running ∧ pid 活着」的 work 被收敛即为 P0 缺陷；②tracker 既有测试逐例保持绿；③发布链在 tracker 与 reconciler 间不得出现第二实现。
- 与在途 implementer 的排他：T1/T2/T5 均触及 `core/src/tool/executor/background-tasks.ts`，拆解时先确认该文件在途分支已合入或协调顺序。

## 10. 未决问题（不阻塞拆解）

1. U1（run 结算条件）若证实「exit 即结算」，P3 收窄为纯 U1-grandchild 形态，L4 的输出增量信号保留（便宜且防 N3）；若「等流关闭」，L4 是主战场，参数按 E2E-2 观察微调。
2. `BACKGROUND_WORK_LIVENESS_GRACE_MS` 终值（推荐 10 分钟，与两先例对齐）与确认拍数（推荐 2）——实现期按真机观测定稿并记录依据。
3. dwf / legacy Workflow / subagent-kind 的 running 是否与 bash 同批纳入首期扫描：机制上无差别（L2 同一分派），建议首期全纳入但验收标准只钉 bash（R1 症状路径），其余作为同机制的免费覆盖写进测试即可。
