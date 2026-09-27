# Spec：定时自动化只在目标会话空闲时执行

> 状态：implemented（typecheck / lint / architecture:check 全绿；84 项测试通过）
> 决策来源：用户报告（2026-09-27）+ 两条补充要求
> 相关：`packages/desktop/src/scheduler/`、`packages/desktop/src/host/`、`packages/services/src/session/automationRepo.ts`

## Problem Statement

用户绑定了会话的定时提醒（`automations.target_task_id` 指向某个会话）在到点时**无条件投递**：即使目标会话正在执行一轮 turn，prompt 依然被发进去。

实测证据（2026-09-27，`~/.zcode/v2/tasks-index.sqlite`）：

- `automation-37954168`（每20分钟推进剩余工单提醒）绑定 `sess_21f3dc19`，`automation_runs` 中多条记录 `dispatch_status=dispatched`，日志显示同一 session 内 `turnNumber: 183` 被反复追加。
- 目标会话正在跑长任务时，提醒仍被投递 → 会话内出现"时间一到就插一条消息"，与用户意图不符。

用户要求：

1. **不排队、不插队**：目标会话在执行时不要投递，也不要把提醒塞进 V4 队列等待 drain。
2. **检测到会话停下才执行**：待投递的提醒保留下来，等目标会话空闲后再执行。
3. 会话右侧 Todo 看板显示当前已绑定的自动化信息，并支持快捷暂停/继续。

## 根因

`dispatchCronRun()`（`packages/desktop/src/host/index.ts`）在 `targetTaskId` 分支上直接 `resumeTask` → 写会话配置 → `sendPrompt`，**没有任何"目标会话是否正在执行"的判断**。

对照：闲时任务（off-peak）的绑定首跑分支已有同类门控（`assertBoundSessionDispatchable`，见 `offPeakDispatchPlan.ts`），并留下了明确教训——"必须在写入会话 mode 之前抛出，否则会悄悄把用户会话切成任务的权限模式"。cron 路径缺的正是这个检查。

同时，调度状态机没有"等待型重试"语义：`markDispatchFailed` 的 transient 重试最多 5 次、退避上限 15 分钟，达上限后循环任务**放弃本轮跳下一个 next_run_at**。把"会话忙"简单归入 transient 会让提醒在长任务（>5 次重试）中被丢弃，与"等会话停下再执行"矛盾。

## Solution

### 1. 权威判定：会话是否正在执行

复用既有判据，不新造第二套状态：

- `packages/shared/src/zcode-session-task-status.ts` 的 `hasBlockingActiveSnapshotRuntime(snapshot)`（本次改为导出）是仓库既有的"存在真实阻塞运行态"定义：`runtime.activeTurnId` / `activeTurnKind`、pending permissions、pending/running 的 activeToolCalls。
- 读取方式：`IZCodeAgentService.readSession({ ..., runtimePolicy: "existing-only" })` —— 只读现有 runtime，**绝不为观察者拉起新进程**（该策略注释明确此语义）。

### 2. Host 侧空闲门控（唯一新增判定点）

新建 `packages/desktop/src/host/boundSessionBusyGate.ts`，只负责一件事：回答"这个绑定会话现在能不能派发"。

- `probeSessionExecuting({ agentService, target, sessionId })`：读快照 + 上述判据 → `boolean`。
- `assertBoundSessionNotBusy({ sessionId, running, scope })`：忙则抛 `BoundSessionBusyError`。
- **失败即放行（fail-open）**：runtime 不存在（`ZCODE_AGENT_RUNTIME_UNAVAILABLE`）或读取报错时返回 `false`（不忙）。理由：无法证明忙碌时保持既有派发行为，避免因探测故障永久卡住提醒。

在 `dispatchCronRun` 中，门控位置必须在 `resumeTask` / `applyCronRunConfigToExistingTask` **之前**（同 off-peak 的教训）。仅作用于 `request.targetTaskId` 分支——无绑定会话时走 `createTask` 新建会话，不存在忙。

探测发生在模型选择固定（`fixRunModelSelection`，纯 DB 写）之后、任何会话副作用之前。

### 3. 失败分类：新增 `deferred`（等待型，不消耗重试预算）

`failureKind` 增加第三个取值 `deferred`，语义与 `transient` 明确区分：

| kind | 含义 | 对 `automations` 的影响 |
| --- | --- | --- |
| `transient` | 派发通道暂时失败（无 host、DB 未就绪等） | `dispatch_attempts+1`，`retry_at` 指数退避；达上限放弃本轮 |
| `permanent` | 确定性配置错误 | 转 failed 终态并停用 |
| `deferred` | 目标会话正在执行，等待空闲 | **不改 `dispatch_attempts`**，`retry_at = now + 30s`，`next_run_at` 不变 |

`AutomationRepo.deferDispatch()`：`running=0`、`claimed_at=NULL`、`dispatch_status='idle'`、`retry_at=now+DEFERRED_RETRY_MS`；**保留** `next_run_at`（runId 因此稳定复用）、**保留** `dispatch_attempts`、**不写** `last_error`（避免设置页误显示失败徽标）。

等待是**无上限**的：会话忙多久就等多久，因为 `dispatch_attempts` 不增长，永不触发放弃本轮。

一次等待周期结束后：`markDispatched` 用 `computeAutomationNextRunAt(automation, now)` 重算未来触发点，所以长任务期间错过的多个周期**收敛为一次执行**（等于"不排队"）。

### 4. misfire 豁免（关键边界）

`handleClaimed` 的 misfire 判定（`next_run_at` 早于 now 超过 5 分钟 ⇒ 视为关机错过、记 skipped 不补跑）会把长时间等待的 deferred run 误判成错过窗口并**丢弃提醒**。

修正：`isRetry` 的判据从 `dispatchAttempts > 0` 扩为 `dispatchAttempts > 0 || retryAt != null`。语义更准确——`retry_at` 非空表示"这一轮已被接受、正在等待重投"，本就不是错过的窗口。既有 transient 路径必有 `attempts>0`，行为不变。

**等待不设上限，晚到不丢弃**：deferred 等待期间 app 若关闭，重启后仍会补投（不判 misfire）。这是刻意的，与同为"等待型"的闲时任务保持一致——scheduler 头注释明确记载闲时任务的约定是「无 misfire-skip 语义（顺延不丢弃）」。提醒内容本身是前瞻性的（"检查进度并继续推进"），晚到优于丢失。

### 5. 手动"立即运行"

用户显式点击的 manual run **不进入等待队列**（用户要求不排队）：会话忙时立即失败，错误文案明确说明目标会话正在执行、请在空闲后重试。关键是失败发生在写会话配置之前，不再污染用户会话的 mode。

### 6. 会话右侧面板展示绑定自动化 + 快捷暂停/继续

在 `ConversationStatusPanel`（会话右侧 Todo 看板所在面板）新增「定时任务」区块：

- 数据：复用唯一所有者 `automationManagementStore`（不新建第二份自动化列表）；面板按 `targetTaskId === 当前 sessionId` 过滤出本会话绑定的自动化。
- 未初始化时由面板触发一次 `initialize`（幂等，切 workspace 有缓存保护）。
- 每行展示：标题、调度摘要（复用 `automationFormat` 的既有格式化）、下次触发时间、当前状态（启用/暂停）。
- 快捷操作：暂停/继续 → `store.setEnabled`（含 operationId 去重与乐观状态回写）。

## Ownership / 事件顺序

```text
scheduler(20s tick)
  └─ claimDue → running 0→1
       └─ handleClaimed: misfire? → skipped（deferred 等待中因 retry_at 豁免）
            └─ cron-dispatch-request → main → host
                 └─ dispatchCronRun
                      ├─ targetTaskId? → probeSessionExecuting
                      │     ├─ 忙 → BoundSessionBusyError → CronRunResult{ok:false, deferred}
                      │     └─ 闲 → resumeTask + config + sendPrompt（既有路径）
                      └─ 无绑定 → createTask + sendPrompt（既有路径）
  └─ settleDispatchResult
        ├─ ok → markDispatched（推进 next_run_at，run_count+1）
        ├─ deferred → deferDispatch（retry_at=+30s，预算不变，**先于** markRunDispatch）
        └─ 其他失败 → markRunDispatch(failed) + markDispatchFailed（既有退避/终态语义）
```

`deferred` 分支必须排在 `markRunDispatch` **之前**：后者会把 run 记成 `failed_to_dispatch`，
而运行历史把该状态渲染为「失败」——等待不是失败，台账应保持 `claimed`（进行中）。

- 状态所有者：`automations` 表的调度状态仍只由 scheduler 结算（唯一写入者），host 只回报事实。
- 幂等键：`runId = automationId:scheduledAt`，deferred 期间 `scheduledAt` 不变 ⇒ 重试幂等复用同一条 run 台账。
- 崩溃恢复：既有 `CLAIM_STALE_MS` 僵尸回收覆盖；deferred 期间 `running=0`，scheduler 重启后按 `retry_at` 自然继续等待。

## 边界与不变量

1. 门控只在 `targetTaskId` 分支生效；新建会话路径行为不变。
2. 门控失败（探测异常/无 runtime）放行，不改变既有派发行为。
3. 等待不消耗 `dispatch_attempts`、不写 `last_error`、不推进 `next_run_at`。
4. `retry_at` 非空时不再走 misfire 跳过。
5. manual run 不进入等待；失败发生在写会话配置之前。
6. 无新增 DB 列 ⇒ 无新 migration。

## 验收场景

1. 绑定会话正在执行 → 到点不投递，`automation_runs` 保持 claimed，`retry_at` 每 30s 前推，`dispatch_attempts` 保持 0。
2. 会话转为空闲 → 下一轮 tick 成功投递，`run_count+1`，`next_run_at` 推进到未来触发点，期间错过的周期不补跑多条。
3. 会话长时间（>5 分钟）忙碌 → 提醒不被 misfire 丢弃。
4. 无绑定会话的定时任务 → 行为与改动前一致。
5. 用户"立即运行"且会话忙 → 立即得到明确失败原因，且目标会话的 mode/模型配置未被改动。
6. 右侧面板：列出该会话绑定的自动化，点暂停/继续即时生效并反映状态。
