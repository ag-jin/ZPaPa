# 多智能体小队 · P2b 接线 + 最小入口 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0–P2a 已经齐全、但**在应用里是孤岛**的零件装上一次：跑通**可演示的最小闭环** —— **建小队 → 建工作项并指派给小队 → 队长被唤醒派单 → 队员各开工作树 → 审查 → 合并 → 抛弃。**

**Architecture:** 本阶段**不写新机制**，只做**装配 + 面**。三块：
①**脊**（Wave 0，串行）：把 `taskIndexRepo` 的**同一条** `DatabaseSync` 连接交给 `workItemRepo`/`wakeRuleRepo`/新增的 `squadRunRepo`，在 `node.ts` 组合根里装配 repo+service+worktree 工具，并把三者**冻结成契约**（含 spec §3.3 三段简报与 §5.7.1 `computeEventKey`）；
②**三面**（Wave 1，并行）：**唤醒调度与派发桥**（desktop，复用 cron 的强忙探测）、**工作树编排**（services 新模块，含回收器命名空间限域修正）、**最小入口 UI + 后端门禁**（ui）；
③**收口**（Wave 2，串行）：host 侧启动回收调用点 + 关闭实验门禁 + 剩余热点改动集中落地。

**Tech Stack:** TypeScript · Node 24（`node:test` + `node:assert/strict`，`pnpm exec tsx --test`）· `node:sqlite`（`DatabaseSync`）· Electron utility process（scheduler）· zod · React（设置页）

**Spec:** `docs/superpowers/specs/2026-10-01-multi-agent-squad-design.md`（§3.3 队长简报三段、§5.7/§5.7.1 幂等与 `eventKey`、§6 隔离与执行、§13 C10、§17 表）

**接线面侦察（本计划的事实来源）**：`.superpowers/sdd/2026-10-01-multi-agent-squad-p2b/recon.md`（含全部 `file:line`；末尾「接线缺口总表」11 项，本计划是它的落地）

**前置**：P0、P1、P2a 已交付（分支 `feat/multi-agent-squad-p2a`，PR #3 未合）。**P2b 分支堆叠在 P2a 之上**：`feat/multi-agent-squad-p2b`。P2a 整支终审给 P2b 的三条硬约束**逐字**落在下面 Global Constraints 的 1–3 条。

---

## 范围（已定，不扩大也不缩小）

**P2b = 接线 + 最小入口。** 交付物是**一条能走完的闭环**，不是完整功能：

1. `experimentalAgentSquadsEnabled` 在**后端**真正生效（现状：只有 UI 读写，后端零消费者 —— recon.md B4）；
2. 组合根装配（现状：`createWorkItemService`/`createWakeRuleRepo`/`createSquadService`/`createTeamAgentService`/`createWorktreeManager` 等**全部无生产调用方** —— recon.md C6）；
3. `WakeRuleRepo.listReady` 接进调度器 tick（现状：无调用方 —— recon.md F4）；
4. 派发桥：把派发事件翻译成一次 run（复用 `dispatchCronRun` 最小路径 `createTask`/`resumeTask` + `sendPrompt`，`host/index.ts:873`），以「队长 agent + **三段简报**」启动；
5. 工作树编排：run 生命周期接到 `planBranches`/`createBranchAllocator`/`createWorktreeManager`/`createIntegrationMerger`/`createOrphanReaper`；
6. 最小入口 UI（设置 ▸ 实验功能 分区内的小队 / 工作项最小视图）+ 后端门禁。

### 明确**不在**本计划（留给 P2c）

| 不属于 P2b | 归属 |
|---|---|
| 工作项级**交付物**（Deliverable） | P2c |
| **成本 / 用量按 run 记账** | P2c |
| **GitHub PR 集成**（自动关联 / 快照 / merge 驱动状态） | P2c |
| **完整父子树 UI**（递归树、拖拽排序、分阶段） | P2c |
| **评论 / 活动时间线**（评论即触发） | P2c |
| **Inbox 完整语义**（已读 / 归档 / 严重级 / 订阅者） | P2c |
| **渠道**（只读通知推送） | P2c |
| **AI 建 agent 向导**（§2.1 第 17 项） | P2c |
| **多设备联动 / host 绑定**（决策 E） | 不做（单机） |
| **§14 的后两个协作工具**（汇报 / 请求审查） | P2c —— 前两个（建子工作项 / 派给队员）**在本期**，见 Task 6（D） |
| **多 workspace 支持**（本期单 workspace；误用**响亮**） | P2c —— 见下面「已知代价」 |

### 已知代价（必须写在计划里，不得只留在任务报告的 concern 里）

- **队长派单由本期新增的 Wave 1 D 提供工具 ⇒ 队长自主派单可演示。** 队长 run 会被自动唤醒并带上三段简报（含 `protocol` 段里「派单只产出子项与派发事件」的机制说明）；D 交付 spec §14 里的**「建子工作项」与「派给队员」**两个工具（最小形态），队长据此自己拆解与派单，队员随之被唤醒、各开工作树。**§14 的另两个工具（汇报 / 请求审查）仍留 P2c**——它们的代价是：本阶段「汇报」走工作项正文、「请求审查」由最小视图的按钮触发；这两条**不影响闭环能否走完**。
- **审查是人工的**：`reviewMemberRun({ verdict })` 由最小视图的一个按钮触发，不是审查 agent（§2.1 第 9 项属 P2c）。这让「审查被拒不提前删」这条语义**可被演示与测试**（spec §16 S5）。
- **单 workspace，但按目标现构**（确认 3）：runtime **不是长期单例、不缓存** —— 每个使用点带着自己的**目标 workspace** 进来，服务层为该目标现构一个 runtime、用完即弃。**为什么选不缓存**：缓存要回答「什么时候失效」（workspace 切换、会话迁移、设置变更都会让它陈旧），而陈旧的表现是**在错的 workspace 上读写**；不缓存 ⇒ **无陈旧、无失效逻辑**。调用方给不出唯一目标时**拒绝并报告候选清单**（不静默取首个）。代价：每次操作多一次构造（含一次 `git symbolic-ref` 子进程）——**若实测成为热路径**，改按 `workspaceKey` 缓存**并显式登记失效面**（在报告里说明），但**任何时候都不得**退化成「取首个 workspace」。本期只支持单 workspace，完整语义留 P2c；**误用是响亮的**。

---

## 开发工作树与分支命名（约定，不是本轮实现内容）

- **开发工作树一律放仓库根的 `.worktrees/`（复数）**，与**产品运行时产物 `.worktree/`（单数）分开**：

| 工作树 | 分支（**扁平后缀**） | 用途 |
|---|---|---|
| `.worktrees/p2b-spine` | `feat/p2b-spine` | Wave 0 脊 |
| `.worktrees/p2b-scheduler` | `feat/p2b-scheduler` | Wave 1 A |
| `.worktrees/p2b-orchestrator` | `feat/p2b-orchestrator` | Wave 1 B |
| `.worktrees/p2b-entry` | `feat/p2b-entry` | Wave 1 C |
| `.worktrees/p2b-tools` | `feat/p2b-tools` | Wave 1 D |
| `.worktrees/p2b-collect` | `feat/p2b-collect` | Wave 2 收口 |

- **分支名必须是扁平后缀**（`feat/p2b-spine`），**不得**写成 `feat/p2b/spine`：`refs/heads/feat/p2b` 与 `refs/heads/feat/p2b/spine` **在 git 里不可共存**（D/F 冲突），这是 P2a 用七条实测钉下的事实（spec §6.3 ⚠️）。
- **两个目录分开是约定**（开发产物 vs 产品运行时的运行产物，各自不混进对方的视野）。**但它不是**下面那条不变量被修正的理由——理由与目录布局**无关**，见 Global Constraints 第 4 条：
  - 回收器的归属判据现在是**路径代理**（「在不在我们的目录里」）。把它当成「属于我们」是错的：任何**非小队命名空间**的工作树（用户自己 `git worktree add`、将来别的功能复用该目录、或开发工作树被误放进去）都会被第一遍**连树带枝回收**，因为判据「分支不在 `activeBranches`」对它**恒为真**，且**不报错**；
  - 所以本计划把不变量改成**分支命名空间**（`squad/member/**`），**与目录怎么放无关**：即使把开发工作树放到 `.worktrees/` 之外或不放工作树，这条修正也照样需要——因为用户的工作树可能就在 `.worktree/` 里。

---

## Wave 划分与文件所有权（本轮最重要的一节）

瓶颈是**组合根与 host 的共享热点**：多个任务都要改 `packages/services/src/node.ts` 与 `packages/desktop/src/host/index.ts`。故按「谁先落、谁独占」切开：

- **Wave 0 —— 串行脊**（**必须最先，且单独一个执行者**）
  执行者：`.worktrees/p2b-spine` / `feat/p2b-spine`。
  内容：tasks-index 的 `DatabaseSync` 提供者 + 组合根装配（实例化 workitem / wakeRule / teamAgent / squad / **新增 squadRun** / worktree 相关 repo+service，并登记进 `sqliteReposToClose` / `sharedSqliteRepos`）+ **冻结并发所需的一切接口**（各模块的导出与工厂签名先定死，实现可后填）。
  **拥有**：`packages/services/src/node.ts`、`packages/services/src/session/taskIndexRepo.ts`、`packages/services/src/index.ts`，以及它新建的脊文件（见 Task 1 / Task 2 的 Owns）。
- **Wave 1 —— 并行（四路）**（**执行者之间文件集必须不相交**；在 `feat/p2b-spine` 顶端各起一支）
  - **A｜唤醒调度 + 派发桥**（**热点拥有者**）：拥有 `packages/desktop/src/scheduler/**`、`packages/desktop/src/main/desktopCronScheduler.ts`、`packages/desktop/src/main/desktopHostProcess.ts` 的派发结果分支、`packages/shared/src/channels.ts` 与 `packages/shared/src/validation.ts` 的**新增消息类型**，以及 `packages/desktop/src/host/index.ts` 的**唤醒 / 派发分支**。
  - **B｜工作树编排与产物卫生**：拥有 `packages/services/src/workitem/squadOrchestrator.ts`（新）及其测试，**`packages/services/src/worktree/orphanReaper.ts` 与 `packages/services/src/worktree/orphanReaper.test.ts`（回收器命名空间限域修正，P2a 遗留语义）**，以及 `packages/services/src/file/workspaceFileIgnore.ts`（硬约束 3：C10 清单并入 `BUILTIN_IGNORE_LINES`）与对应测试。**不得改 `node.ts` / `host`**。
  - **C｜最小入口 UI**：拥有 `packages/ui/src/**`（设置「实验功能」分区内的小队 / 工作项最小视图、i18n 两语）与 UI 测试。**不得改 `node.ts` / `host` / `services/**`**。**交付物只有 UI**（开关关闭 ⇒ 入口隐藏 / 不可用）；**后端门禁不属 C**——它整条属 A（A 拥有派发路径，判在那里最不需要跨人交接）。**C 不产出任何后端 patch 文本。**
  - **D｜队长派单工具集**：拥有 `packages/contracts/src/**`（两个工具的 input/output schema + `SquadPort` 类型）、`packages/shared/src/zcode-protocol/**`（新 method 常量与结果 schema）、`apps/zcode-cli/**`（工具定义、可见性门控、executor 透传、bootstrap 侧 port 实现与注入点）与 D 自己的测试。**不得改** `node.ts` / `host` / `services/src/**` / `ui/**` / `scheduler/**`（**Host 侧若确实需要新增一个 protocol handler，见 D 的 Step 0：那是「新增独立文件 + Wave 2 追加一行注册」，D 本人不得改 A 的文件**）。
- **Wave 2 —— 串行（热点收口）**
  执行者：`.worktrees/p2b-collect` / `feat/p2b-collect`（从 A / B / C / D 合并后的顶端起）。
  内容：`host/index.ts` 的**最终接线**——启动回收调用点、**门禁实现位于服务层单点（确认 2）这一点由本任务用静态守卫复核**、D 的 protocol handler 注册行（若 D 的 Step 0 判定需要）、以及 A 未能独立完成的剩余热点改动，**集中在此由单一执行者做**。
- **Wave 3 —— 集成与端到端验收**（由 controller 做，**不在任务编号内**）：合并**四条**并行分支 → 全量测试 → 按闭环逐步手工 / 自动验证。

### 文件所有权矩阵（证明同一 Wave 内无交集）

| 文件 / glob | Wave 0 | Wave 1 A | Wave 1 B | Wave 1 C | Wave 1 D | Wave 2 |
|---|---|---|---|---|---|---|
| `packages/services/src/node.ts` | **改** | — | — | — | — | — |
| `packages/services/src/index.ts` | **改** | — | — | — | — | — |
| `packages/services/src/session/taskIndexRepo.ts` | **改** | — | — | — | — | — |
| `packages/services/src/session/tasksDatabase/{schema-v1,migrations}.ts` | **改** | — | — | — | — | — |
| `packages/services/src/workitem/squadRunRepo.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/squadRuntime.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/squadRuntimeService.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/squadRunLifecycle.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/squadContracts.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/slug.ts`（新） | **建** | — | — | — | — | — |
| `packages/services/src/workitem/leaderDispatch.ts` | **改**（三段简报） | — | — | — | — | — |
| `packages/services/src/workitem/workItemRepo.ts` | **改**（`listByAssignee`） | — | — | — | — | — |
| `packages/services/src/teams/squadService.ts` | **改**（归档转交，#9） | — | — | — | — | — |
| `packages/services/src/file/workspaceFileIgnore.ts` | — | — | **改**（B‑1，硬约束 3） | — | — | — |
| `packages/shared/src/wake-rule.ts`（`computeEventKey`） | **改** | — | — | — | — | — |
| `packages/services/test/{squadRunRepo,migration,taskIndexSharedDatabase,squadRuntime,squadBriefing,eventKey,squadArchiveTransfer}.test.ts` | **建/改** | — | — | — | — | — |
| `packages/desktop/src/scheduler/**` | — | **改** | — | — | — | — |
| `packages/desktop/src/main/desktopCronScheduler.ts` | — | **改** | — | — | — | — |
| `packages/desktop/src/main/desktopHostProcess.ts`（结果分支） | — | **改** | — | — | — | — |
| `packages/shared/src/channels.ts` / `validation.ts`（新增消息） | — | **改** | — | — | — | — |
| `packages/desktop/src/host/index.ts`（唤醒 / 派发分支 + **后端门禁**） | — | **改** | — | — | — | **改**（启动回收 + 最终收口） |
| `packages/desktop/test/{schedulerWakeTick,schedulerWiring,hostSquadDispatch}.test.ts` | — | **建** | — | — | — | — |
| `packages/services/src/workitem/squadOrchestrator.ts`（新） | — | — | **建** | — | — | — |
| `packages/services/src/worktree/orphanReaper.ts` + `orphanReaper.test.ts` | — | — | **改** | — | — | — |
| `packages/services/test/{squadOrchestrator.batch,workspaceFileIgnoreProductDirs}.test.ts` | — | — | **建** | — | — | — |
| `packages/ui/src/**`（含 i18n locales） | — | — | — | **改** | — | — |
| `packages/ui/test/experimentsSquadEntry.test.ts` | — | — | — | **建** | — | — |
| `packages/contracts/src/**`（工具 schema + `SquadPort`） | — | — | — | — | **改** | — |
| `packages/shared/src/zcode-protocol/**`（新 method + 结果 schema） | — | — | — | — | **改** | — |
| `apps/zcode-cli/packages/core/src/{tool/**,runtime/**,runtime.ts}` | — | — | — | — | **改** | — |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{squad-port.ts,server-operations.ts}` | — | — | — | — | **建/改** | — |
| `apps/zcode-cli/**/test/**`（D 的测试） | — | — | — | — | **建** | — |
| `packages/desktop/src/host/squadProtocolMethods.ts`（**仅当 D 的 Step 0 判定需要**） | — | — | — | — | **建** | **改**（注册一行） |
| `packages/desktop/test/squadWiring.test.ts` | — | — | — | — | — | **建** |

**同 Wave 内两两不相交**：Wave 1 **四列**的文件集**零重叠**（A = `desktop/{scheduler,main,host}` + `shared/{channels,validation}.ts`；B = `services/src/{workitem/squadOrchestrator,worktree/orphanReaper*,file/workspaceFileIgnore}` + 其测试；C = `ui/**`；D = `packages/contracts/**` + `shared/zcode-protocol/**` + `apps/zcode-cli/**` + 自己的测试）。两处**跨 Wave 的同文件**已显式标注：`host/index.ts`（A 与 Wave 2，**不同 Wave，串行**）、`node.ts`（仅 Wave 0）。
**跨执行者的交接只有一处，且是「注册一行」而不是「抄一段逻辑」**：若 D 的 Step 0 判定 Host 侧必须新增 protocol handler，则 D **新增独立文件** `packages/desktop/src/host/squadProtocolMethods.ts`，**由 Wave 2 在该 host 的方法表里追加一行注册**（文本见 Task 7）；D **不碰** A 的 `host/index.ts`。除这一行外，**本计划没有任何「A 的文件由 B/C/D 代写」的安排**。

### Wave 0 冻结接口（供 Wave 1 并行开发对表）

> 冻结 = 签名先定死，Wave 1 三方**按此写代码**；真实类型与现有代码逐字一致（下方每条都标了来源 `file:line`）。

| # | 冻结项 | 归属任务 | 消费者 |
|---|---|---|---|
| F1 | `createSquadRuntime(deps): Promise<SquadRuntime>` + `SquadRuntime` | T2 | A（取工具）、B、Wave 2 |
| F2 | `ISquadRuntimeService` 描述符与接口（**门禁唯一判据** `assertDispatchEnabled` + `getSnapshot`/`createTeamAgent`/`createSquad`/`createWorkItem`/`openMemberRun`/`completeMemberRun`/`reviewMemberRun`/`reapStartupOrphans`/`archiveSquadAndTransfer`，**每个方法第一个参数都是 `SquadWorkspaceTarget`**） | T2 | C（UI 唯一入口）、A（host 调门禁 + 取 runtime）、D（工具经 Host 落到本服务） |
| F3 | `createSquadRunRepo(db): SquadRunRepo` + `SquadRunRecord` / `SquadRunStatus` | T1 | A（活跃口径）、B |
| F4 | `slugForId(id): string`（单路径段、确定性） | T2 | B（`planBranches` 的两个 slug 都由它派生） |
| F5 | `SquadBriefing` **三段** `roster` / `protocol` / `instructions` | T2 | A（渲染成 prompt） |
| F6 | `computeEventKey(rule, fact): string`（shared 唯一构造器） | T2 | A（tick 去重）、T2（指派落规则） |
| F7 | **值**：`createRunLifecycle`（T2 落**机械半**：`openMemberRun`/`completeMemberRun`/`computeActiveBranches`/`reapStartupOrphans`/`reviewMemberRun`/`discardMemberRun`）。**类型**：`SquadBatchOrchestrator`（T2 在 `squadContracts.ts` **只声明类型**；`createSquadOrchestrator` 的**值**由 **B 在 T4 落**） | T2 + T4 | A（队员 run 开树）、Wave 2（装配） |
| F8 | P0/P1/P2a 既有签名**不改**：`createWorkItemRepo(db)`（`workItemRepo.ts:54`）、`createWakeRuleRepo(db)`（`wakeRuleRepo.ts:117`）、`createWorkItemService({repo, emit})`（`workItemService.ts:37`）、`createSquadService({root, teamAgentRoot})`（`squadService.ts:71`）、`createTeamAgentService({root})`（`teamAgentService.ts:64`）、`createWorktreeManager({git, repoRoot})`（`worktreeManager.ts:146`）、`createBranchAllocator({manager})`（`branchNaming.ts:141`）、`createIntegrationMerger({git, repoRoot, base})`（`integrationMerge.ts:65`）、`createOrphanReaper({manager, repoRoot, deleteBranch, listBranches})`（`orphanReaper.ts:133`）、`planBranches/assertSafeSlug/memberDirName`、`planDispatch({workItem, squad, trigger, ruleId?})`（`leaderDispatch.ts:35`）、`decideWake(...)`（`wakeGuard.ts:45`）、`deleteBranch(git, repoRoot, branch)`（`integrationMerge.ts:48`）、`resolveWorktreeRoot(repoRoot)`（`worktreeManager.ts:34`） | — | A/B/C **只消费，不改签名** |
| F9 | host 侧新增消息常量与 schema：`HostMessageTypes.SquadWake = "squad-wake"`、`HostResponseTypes.SquadWakeResult = "squad-wake-result"`、`hostSquadWakeMessageSchema`（**薄消息**：只带 `ruleId` / `workItemId` / `revision` / `eventKey`；规划留在 host 侧一处做） | **A** 定义（T3），W2 消费 | Wave 2 |

---

## Global Constraints

### 三条硬约束（P2a 整支终审移交，**逐字**）

1. **忙检查一律复用 cron 的强探测** `createBoundSessionExecutingProbe`（`packages/desktop/src/host/index.ts:912-925`，实现 `packages/desktop/src/host/boundSessionBusyGate.ts:58`），**不得**照抄 off-peak 的弱投影判据（`status === "running"`，`packages/desktop/src/host/offPeakDispatchPlan.ts:41`）。**理由与证据**：off-peak 读的是 tasks-index 投影表，而该表**崩溃 / 强杀会留下长期残留的 running 行**（`boundSessionBusyGate.ts:8-13` 自证注释：「实测有记录停留数月」），据此判断会**永久卡住派发**；cron 路径已改为读 agent runtime 快照（`hasBlockingActiveSnapshotRuntime`）。两者仍不对称属已知缺口（recon.md A3）。
2. **`activeBranches` 必须包含所有「已产出但未合并」的队员分支**（含被打回待修复的）；回收只针对已合并 / 已放弃的。**否则下次启动会静默回收待修的工作树**。依据：`orphanReaper.ts` 的 `ReapInput.activeBranches` 契约注释 + spec §6.2 / §17 表（`spec:376`、`spec:677`）。**实现落点**：`SquadRunRepo.listActive()`（status ∈ `open | produced | rejected`）是**唯一**口径来源；**禁止**用「当前有没有在跑的 run」当口径。
3. **用户 workspace 侧的产物目录排除只有一半生效**（P2a 改的是 ZCode 自身仓库的 `.gitignore`）⇒ 本计划**显式承接这个决策**：是否把 C10 清单并入 `BUILTIN_IGNORE_LINES`（`packages/services/src/file/workspaceFileIgnore.ts:47`），或另设不依赖 `.gitignore` 的程序化排除。**必须是一个有编号的任务，不能只在文档里提一句。** 依据：spec §17 表（`spec:675`）。
   → 落点：**Task 4（Wave 1 B）的具名前置修正 B‑1**（有编号、有测试、有变异验证），决策为**把 C10 清单并入 `BUILTIN_IGNORE_LINES`** 并**从 `WORKSPACE_PRODUCT_DIRS` 派生**（不新增第三份清单）——因为它是**唯一不依赖 workspace 状态**的那半边。

### 第四条（本轮新增，由本轮目录布局决策暴露）

4. **回收器的「是不是我们的」判据必须是分支命名空间，不是路径。** `orphanReaper` 现在的归属判据是**路径代理**（`dirname(entry.path) === resolveWorktreeRoot(repoRoot)`，外加集成分支特判）；但「**放在我们的目录里**」不等于「**属于我们**」——任何**非小队命名空间**的工作树只要落到 `.worktree/` 下（用户自己 `git worktree add`、或将来别的功能复用该目录），第一遍就会**连树带枝回收掉**：判据「分支不在 `activeBranches`」对它**恒为真**，且**不报错**。
   **正确判据 = 分支是否属于小队命名空间**（`MEMBER_NAMESPACE` = `squad/member/`，`branchNaming.ts:19`）；集成分支（`INTEGRATION_NAMESPACE` = `squad/integration/`，`:17`）仍保护不删；**命名空间外的一律不得碰，且必须可报告**（进 `kept` 或 `foreign`，**不得静默**）。
   **这条推翻 / 收紧了 P2a 的既有语义**：P2a 只给第一遍补了 `INTEGRATION_NAMESPACE` 保护，**把「在我们的目录里」当成了「属于我们」**（`orphanReaper.ts:154-170` 的注释与对应测试只覆盖这一个前缀）⇒ **允许并且要求改动 `packages/services/src/worktree/orphanReaper.ts` 及其测试**，并在注释里写清这条不变式。
   落点：**Task 4（Wave 1 B）的前置修正 B‑0**（附测试与变异验证）。
   **本轮的触发场景**：开发工作树（`feat/p2b-*`）与产品运行时的运行分支（`squad/member/**`）在**同一个仓库**里共存；即便两者目录分开（`.worktrees/` vs `.worktree/`），只要有任何非小队工作树落进 `.worktree/`，第一遍就会吃掉它。

### 其余约束

- **唯一写者不变**（P0/P1 裁定）：只有 `workItemService.transition` 能写工作项 `status`；调度器 / 队长 / UI **只能发派发事件**。
- **不写新机制**：本阶段新增的每一个行为都必须**复用**已有部件（`planDispatch` / `decideWake` / `computeEventKey` / P2a 的 worktree 五件套）。若某处要新造一份判据，先问「是否已有唯一来源」。
- **状态键 / kind / mode / condition / 阈值**与 P1 完全一致，不新增枚举。
- **迁移只追加**：新增迁移 ⇒ 进 `packages/services/src/session/tasksDatabase/migrations.ts` 的 `definitions`（`:48-77`）**并且**显式加 `else if` 分支（runner 末尾 `else` 会跑 GLM SQL，P0 的教训）；**同时**在 `packages/services/test/workItemMigration.test.ts` 的 `LATEST_MIGRATION_ARTIFACTS`（`:55-57`）补新行，并把**旧的「最新」移入 `PINNED_MIGRATION_CHECKSUMS`**（`:45-50`）——含 `0005_wake_rules` 的 checksum 字面量。
- **测试位置与命令**：
  - services / shared / desktop：`pnpm exec tsx --test packages/<pkg>/test/<file>.test.ts`
  - **ui 例外（必须带包内 tsconfig，否则 `@/` 别名解析失败）**：`pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/<file>.test.ts`
  - `node:test` + `node:assert/strict`；**测试输出必须干净**（零 `console.log`、零 stray warning、无 `.only` / `skip`）。
- **注释用中文说明**为什么**（不是说明做了什么）。
- 每个任务结束必须通过 `pnpm typecheck` 与 `pnpm lint`（`pnpm run verify:pre-push` = `lint` + `architecture:check --changed`）。
- **不得改动**：`docs/superpowers/specs/**`、`docs/superpowers/plans/2026-10-01-multi-agent-squad-p{0,1,2a}.md`、`.superpowers/sdd/2026-10-01-multi-agent-squad-p2a/**`。

---

## Review Focus

spec 隐含、但各任务测试**最容易漏掉**的输入 / 失败模式。每条都在**拥有该代码的任务**里加了对应测试：

1. **弱忙检查漏进来**：绑定会话路径若误用投影判据 ⇒ 长任务期间派发被永久卡死。**必须有一条测试证明「投影是 running 但 runtime 未在执行」时派发放行**（Task 3 A）。
2. **启动回收吃掉待修 / 外来工作树**：`activeBranches` 漏掉「已产出未合并」⇒ 待修工作树被静默回收（S5 失效）；**非小队命名空间**的工作树落进 `.worktree/` ⇒ 被当孤儿收掉（Task 4 B‑0、Task 2）。
3. **`eventKey` 就地拼串**：重复投递的事件**静默重复触发**。必须证明「同一事实重投两次只 fire 一次」且「`filters` 改动不改变 key」（Task 2 落构造器、Task 3 A 用）。
4. **只写在 dev 生效**：新调度逻辑若挂在非 fork 入口上 ⇒ 生产**静默不跑**（`schedulerModulePath` 基于 `import.meta.dirname`，recon.md F4）。**必须有一条静态可检的测试**（Task 3 A）。
5. **开关只是 UI 装饰**：后端不读 `experimentalAgentSquadsEnabled` ⇒ 关掉实验照旧派发（recon.md B4）。**门禁在服务层单点**（`ISquadRuntimeService.assertDispatchEnabled`，**唯一的开关读取点**），三个入口（规则 tick / 界面手动触发 / 队长工具）**共用同一判据**。必须有的测试：**开关关闭时三个入口都被拦**（至少覆盖「界面触发」与「规则 tick」两条）+ **在途 run 不被中断**（spec §5.7.6 / §16 S14）；另加一条**静态守卫**：`experimentalAgentSquadsEnabled` **不得出现在 `packages/desktop/src/**`**（出现即说明有人把判据复制到了 host）。落点：T2（判据本体 + 四条测试）、T3（host 只按结论行事）、T7（静态守卫复核）。
6. **另开一条 tasks-index 连接**：`createWorkItemRepo`/`createWakeRuleRepo` 要注入 `DatabaseSync`，若自己 `new DatabaseSync(path)` 就绕过了 `isTasksStorageMigrated`/prepared，**静默读写到不同库状态**（recon.md F3）。必须断言与 `taskIndexRepo` **同一实例**（Task 1）。

---

## 审查两法（本计划每个任务的 Step 5 都按这两段做）

**① 逆推**：对着 spec 的**具体小节**（写明第几节）逐条反查遗漏。
**② 穷举**：先**列出本任务的枚举空间全集**，再**逐格**给结论；对「不适用」的项写明理由。
**只有逆推、没有穷举清单的审查报告视为未完成。** 逐格结论只能是三种之一：**有测试** / **由代码或类型保证**（写明在哪一行）/ **不适用 + 理由**。任一格空缺，**先补测试或补理由再提交**。

---

### Task 1: tasks-index DB 提供者 + `squad_runs` 台账（Wave 0a）

**Owns:** `packages/services/src/session/taskIndexRepo.ts`、`packages/services/src/session/tasksDatabase/schema-v1.ts`、`packages/services/src/session/tasksDatabase/migrations.ts`、`packages/services/src/workitem/squadRunRepo.ts`（新）、`packages/services/test/squadRunRepo.test.ts`（新）、`packages/services/test/taskIndexSharedDatabase.test.ts`（新）、`packages/services/test/workItemMigration.test.ts`（改）
**Must not touch:** `packages/desktop/**`、`packages/ui/**`、`packages/services/src/node.ts`（Task 2 的文件）

**Files:**

- Modify: `packages/services/src/session/taskIndexRepo.ts`（加公开 accessor，复用既有 private `getDatabase()` at `:646`）
- Modify: `packages/services/src/session/tasksDatabase/schema-v1.ts`（追加 `SQUAD_RUN_SCHEMA`）
- Modify: `packages/services/src/session/tasksDatabase/migrations.ts`（追加 `0006_squad_runs` + **`else if`** 分支）
- Create: `packages/services/src/workitem/squadRunRepo.ts`
- Modify: `packages/services/test/workItemMigration.test.ts`（`PINNED_MIGRATION_CHECKSUMS` 移入 `0005_wake_rules`；`LATEST_MIGRATION_ARTIFACTS` 加 `0006_squad_runs`）
- Test: `packages/services/test/squadRunRepo.test.ts`、`packages/services/test/taskIndexSharedDatabase.test.ts`

**Interfaces:**

- Consumes: 现有的 `runTasksDatabaseMigrations(db, options)`（`migrations.ts:79`）、`TaskIndexRepo`（`:481`）、`getTasksIndexDatabasePath()`（`packages/services/src/paths.ts:186`）
- Produces:
  - `type TasksIndexDatabase = DatabaseSyncInstance`（**导出**，让同进程其它域能声明「我要的就是这条连接」而不必依赖 `node:sqlite` 的类型细节）
  - `TaskIndexRepo.openSharedDatabase(): TasksIndexDatabase` —— 交出**同一条**连接；未初始化则照 `getDatabase()` 抛
  - `export const SQUAD_RUN_SCHEMA: string`（`schema-v1.ts`）
  - `export const SQUAD_RUN_STATUSES = ["open", "produced", "rejected", "merged", "discarded"] as const`
  - `export const SQUAD_RUN_ACTIVE_STATUSES = ["open", "produced", "rejected"] as const`
  - `export type SquadRunStatus = (typeof SQUAD_RUN_STATUSES)[number]`
  - `export type SquadRunRecord = { runId: string; workspaceKey: string; workspacePath: string; workItemId: string; parentWorkItemId: string; agentId: string; isLeaderTask: boolean; branch: string | null; dirName: string | null; status: SquadRunStatus; sessionId: string | null; createdAt: number; updatedAt: number }`
  - `export interface SquadRunRepo`：`insert(record)`、`get(runId)`、`listByWorkItem(workItemId)`、`listByParent(parentWorkItemId)`、`listActive(workspaceKey): SquadRunRecord[]`、`setStatus(runId, status, patch?)`
  - `export function createSquadRunRepo(db: DatabaseSync): SquadRunRepo`

- [ ] **Step 1: 写失败测试**

```ts
// packages/services/test/squadRunRepo.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRunRepo, type SquadRunRecord } from "../src/workitem/squadRunRepo.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createSquadRunRepo(db) };
}
const row = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-child",
  parentWorkItemId: "wi-parent",
  agentId: "ta-a",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb",
  status: "open",
  sessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("迁移建出 squad_runs 表与索引", () => {
  const { db } = setup();
  const t = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='squad_runs'")
    .all();
  assert.equal(t.length, 1);
  const i = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_squad_runs%'")
    .all();
  assert.equal(i.length, 2);
});

// 硬约束 2 的落点：活跃集合必须**跨重启存活**，所以它是持久行而不是内存状态。
// 三个未合并状态里有任何一个漏掉，都会让「已产出未合并」（含被打回待修的）队员工作树
// 在下次启动被静默回收——S5「审查被拒不提前删」当场落空。
test("listActive 只取未合并的三个状态，且按 workspace 隔离", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r-open", status: "open" }));
  repo.insert(row({ runId: "r-produced", status: "produced" }));
  repo.insert(row({ runId: "r-rejected", status: "rejected" }));
  repo.insert(row({ runId: "r-merged", status: "merged" }));
  repo.insert(row({ runId: "r-discarded", status: "discarded" }));
  repo.insert(row({ runId: "r-other-ws", status: "open", workspaceKey: "ws2" }));
  assert.deepEqual(
    repo.listActive("ws").map((r) => r.runId).sort(),
    ["r-open", "r-produced", "r-rejected"],
  );
});

test("setStatus 推进状态并保留 dirName / sessionId", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  repo.setStatus("r1", "merged", { sessionId: "sess-1" });
  const after = repo.get("r1")!;
  assert.equal(after.status, "merged");
  assert.equal(after.sessionId, "sess-1");
  assert.equal(after.dirName, "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb");
});

test("listByParent 取整批（含已收尾的）", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  repo.insert(row({ runId: "r2", status: "merged" }));
  repo.insert(row({ runId: "r3", parentWorkItemId: "wi-other", workItemId: "wi-x" }));
  assert.deepEqual(repo.listByParent("wi-parent").map((r) => r.runId).sort(), ["r1", "r2"]);
});

// 读回枚举列必须响亮失败：P1 的 wakeRuleRepo 已就此定过调（读回非法值抛，不静默按默认值处理）。
// 手改过库的行会把状态键换个名字，静默按默认值处理等于「工作项状态已经不对了但没人知道」。
test("读回枚举外状态抛错", () => {
  const { db, repo } = setup();
  repo.insert(row({ runId: "r1" }));
  db.prepare("UPDATE squad_runs SET status='bogus' WHERE run_id='r1'").run();
  assert.throws(() => repo.get("r1"), /status/);
});

test("写入未知状态抛错（不落盘）", () => {
  const { repo } = setup();
  repo.insert(row({ runId: "r1" }));
  assert.throws(() => repo.setStatus("r1", "bogus" as never), /status/);
});
```

```ts
// packages/services/test/taskIndexSharedDatabase.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// 「同一条连接」不靠注释保证：TEMP 表是**连接级**的——换一条连接就一定看不到它。
// 若这里返回的是另开的一条连接（recon.md F3 的失败形态），下面第二条断言读不到 probe。
test("openSharedDatabase 交出的连接与 repo 自己用的是同一条", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  await repo.ensureReady();
  const db = repo.openSharedDatabase();
  db.exec("CREATE TEMP TABLE probe(x INTEGER)");
  db.exec("INSERT INTO probe VALUES (7)");
  assert.equal(repo.openSharedDatabase().prepare("SELECT x FROM probe").get()?.x, 7);
});

test("未初始化时 openSharedDatabase 响亮失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-index-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  assert.throws(() => repo.openSharedDatabase(), /尚未初始化/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/squadRunRepo.test.ts`
Run: `pnpm exec tsx --test packages/services/test/taskIndexSharedDatabase.test.ts`
Expected: FAIL（`squad_runs` 表不存在 / `openSharedDatabase` 不存在）

- [ ] **Step 3: 最小实现**

`taskIndexRepo.ts`：在 `getDatabase()`（`:646`）**旁边**加导出类型与公开 accessor，**不复制**任何逻辑：

```ts
/** tasks-index 的 sqlite 句柄类型。导出是为了让同进程其它域能声明「我要的就是这条连接」。 */
export type TasksIndexDatabase = DatabaseSyncInstance;

  /**
   * 把本 repo 持有的 tasks-index 连接**原样**交给同进程的其它域（work_items / wake_rules / squad_runs）。
   *
   * 为什么必须是**同一条**连接、而不是让调用方自己 `new DatabaseSync(getTasksIndexDatabasePath())`：
   * 本连接在 `initialize()` 里经历过 `isTasksStorageMigrated` / `isTasksStoragePrepared` 判定、
   * 四条 PRAGMA 设定与三项存量回填。另开一条连接会**跳过全部这些**，于是两个域读写到
   * **不同的库状态**（迁移没跑到、回填没做），而且**不报错**（recon.md F3）。
   *
   * 未初始化就抛（`getDatabase()` 在 `db == null` 时即抛）：静默返回 null 或懒建一条新连接，
   * 都会把上面那个失败变成「看起来正常」。
   */
  openSharedDatabase(): TasksIndexDatabase {
    return this.getDatabase();
  }
```

`schema-v1.ts`：追加 `SQUAD_RUN_SCHEMA`：

```ts
// 0006 追加：小队运行台账。只新增，不改既有表/列。
// 这张表是硬约束 2 的落点：启动回收的「活跃集合」必须**跨重启存活**——
// 内存里的「当前有没有在跑的 run」既活不过重启，也会把「已产出但未合并」漏在外面。
// branch / dir_name 可空：队长 run 不建工作树（spec §6.1「是否开工作树是本次运行的属性」）。
export const SQUAD_RUN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS squad_runs (
    run_id               TEXT PRIMARY KEY,
    workspace_key        TEXT NOT NULL,
    workspace_path       TEXT NOT NULL,
    work_item_id         TEXT NOT NULL,
    parent_work_item_id  TEXT NOT NULL,
    agent_id             TEXT NOT NULL,
    is_leader_task       INTEGER NOT NULL,
    branch               TEXT,
    dir_name             TEXT,
    status               TEXT NOT NULL,
    session_id           TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_squad_runs_active
    ON squad_runs(workspace_key, status);
  CREATE INDEX IF NOT EXISTS idx_squad_runs_work_item
    ON squad_runs(work_item_id);
`;
```

`migrations.ts`：`definitions` 末尾追加 `{ id: "0006_squad_runs", checksumInput: [SQUAD_RUN_SCHEMA] }`（**import 也要加 `SQUAD_RUN_SCHEMA`**），并在 runner 里加**显式** `else if (migration.id === "0006_squad_runs") { db.exec(SQUAD_RUN_SCHEMA); }`（runner 末尾 `else` 会跑 GLM SQL —— 缺这条分支会让新迁移**静默执行错误的 SQL**，P0 的教训）。

`squadRunRepo.ts`：读写 `squad_runs`。**枚举列读回校验**照 `wakeRuleRepo.rowToWakeRule` 的口径（非法值抛，不静默）：

```ts
function readStatus(value: string): SquadRunStatus {
  if (!(SQUAD_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(
      `squad_runs.status 读回非法值「${value}」：列被写坏或枚举被改小。静默按默认值处理会让` +
        "「这条 run 到底合没合」变成没人知道的事，故一律抛。",
    );
  }
  return value as SquadRunStatus;
}
```

`listActive(workspaceKey)` 用一条 SQL（`status IN ('open','produced','rejected')`，由 `SQUAD_RUN_ACTIVE_STATUSES` 拼占位符，**不写字面量**）。

- [ ] **Step 3b: 迁移登记（E10 的义务，必须做全）**

1. `workItemMigration.test.ts` 里把 `"0005_wake_rules"` 从「最新」移入 `PINNED_MIGRATION_CHECKSUMS`，值取**真实 checksum 字面量**。取法（在 `packages/services` 目录下跑，让 `#src/*` 的包内映射生效）：

```bash
cd packages/services && pnpm exec tsx -e 'const {DatabaseSync}=await import("node:sqlite");const {runTasksDatabaseMigrations}=await import("./src/session/tasksDatabase/migrations.ts");const db=new DatabaseSync(":memory:");runTasksDatabaseMigrations(db);console.log(JSON.stringify(db.prepare("SELECT id,checksum FROM tasks_schema_migration ORDER BY id").all(),null,2))'
```

若该命令因 `#src` 映射解析失败，改用等价的确定性手段：把 `"0005_wake_rules"` 的冻结值先写成 `"0"`（**临时**），跑 `pnpm exec tsx --test packages/services/test/workItemMigration.test.ts`，`assert.equal(row.checksum, pinned, …)` 的失败信息里会带出真实值，抄进去后删除该临时手段并复跑转绿。

2. `LATEST_MIGRATION_ARTIFACTS` 加一行 `"0006_squad_runs": ["DROP TABLE squad_runs"]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/squadRunRepo.test.ts`
Run: `pnpm exec tsx --test packages/services/test/taskIndexSharedDatabase.test.ts`
Run: `pnpm exec tsx --test packages/services/test/workItemMigration.test.ts`
Expected: 全 PASS（迁移登记改完后 `workItemMigration` 仍绿）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.6 Run 归属 / §3.8 迁移只追加 / §6.4 §6.6 启动回收 / §5.7 幂等；recon.md E10）：

- §3.8「迁移**只追加**（新增表 / 列），不重命名或删除既有列」——本次 diff 是否**零删除**？
- recon.md E10 的三项义务是否**全做**：`definitions` 加项 **+** `else if` 分支 **+** `LATEST_MIGRATION_ARTIFACTS` 加行 **+** 旧「最新」移入 `PINNED_MIGRATION_CHECKSUMS`？
- 硬约束 2 的落点是否真的是**持久**行（重启后 `listActive` 仍给出未合并集合），而不是内存集合？
- `openSharedDatabase()` 交出的确实是 `taskIndexRepo` 的同一条连接（不是新 `new DatabaseSync`）？
- `squad_runs` 是否**没有**外键指向 `work_items`（归档对象只归档不硬删，外键会让写入失败——与 `WORK_ITEM_SCHEMA` 同一条理由）？

**② 穷举**（先列全集，再逐格给结论）：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| `SquadRunStatus` | open / produced / rejected / merged / discarded | |
| `listActive` 过滤 | 5 状态 × {本 workspace, 别的 workspace} | |
| `listActive` 的 `branch` | 非 null / **null（队长 run 无工作树）** | |
| `setStatus` | 合法状态 / 非法状态 / 未知 runId / 带 patch / 不带 patch | |
| `get` | 存在 / 不存在 / 枚举列被写坏 | |
| 迁移 | 新库 / 老库升级（只补跑 0006）/ 同库重跑 / checksum 冻结 | |
| `openSharedDatabase` | 已初始化 / 未初始化 | |
| 表列 | 与 `SquadRunRecord` **逐字段**对齐（少一列不会报错，只在落盘/读回时静默丢字段） | |

逐格写「有测试 / 由类型或 SQL 保证 / 不适用 + 理由」。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/session/taskIndexRepo.ts \
        packages/services/src/session/tasksDatabase/schema-v1.ts \
        packages/services/src/session/tasksDatabase/migrations.ts \
        packages/services/src/workitem/squadRunRepo.ts \
        packages/services/test/squadRunRepo.test.ts \
        packages/services/test/taskIndexSharedDatabase.test.ts \
        packages/services/test/workItemMigration.test.ts
git commit -m "feat(squad): tasks-index 共享连接 accessor + squad_runs 运行台账（迁移 0006）"
```

---

### Task 2: 组合根装配 + 冻结契约（三段简报 / `eventKey` / 运行生命周期机械半）（Wave 0b）

**Owns:** `packages/services/src/node.ts`、`packages/services/src/index.ts`、`packages/services/src/workitem/squadRuntime.ts`（新）、`packages/services/src/workitem/squadRuntimeService.ts`（新）、`packages/services/src/workitem/squadRunLifecycle.ts`（新）、`packages/services/src/workitem/squadContracts.ts`（新）、`packages/services/src/workitem/slug.ts`（新）、`packages/services/src/workitem/leaderDispatch.ts`（改）、`packages/services/src/workitem/workItemRepo.ts`（改）、`packages/services/src/teams/squadService.ts`（改）、`packages/shared/src/wake-rule.ts`（改）、`packages/services/test/{squadRuntime,squadBriefing,eventKey,squadArchiveTransfer}.test.ts`（新）、`packages/services/test/leaderDispatch.test.ts`（改）
**Must not touch:** `packages/desktop/**`、`packages/ui/**`、`packages/services/src/worktree/**`（P2a 交付物；`orphanReaper` 的修正归 Wave 1 B）

**Files:**

- Modify: `packages/services/src/node.ts`（装配 + 登记 + 导出）
- Modify: `packages/services/src/index.ts`（导出浏览器安全的服务描述符与类型）
- Create: `packages/services/src/workitem/squadRuntime.ts`、`squadRuntimeService.ts`、`squadRunLifecycle.ts`、`squadContracts.ts`、`slug.ts`
- Modify: `packages/services/src/workitem/leaderDispatch.ts`（`SquadBriefing` 加 `protocol` 段）
- Modify: `packages/services/src/workitem/workItemRepo.ts`（加 `listByAssignee`）
- Modify: `packages/services/src/teams/squadService.ts`（归档转交，#9）
- Modify: `packages/shared/src/wake-rule.ts`（`computeEventKey`）
- Test: `packages/services/test/squadRuntime.test.ts`、`squadBriefing.test.ts`、`eventKey.test.ts`、`squadArchiveTransfer.test.ts`；Modify: `packages/services/test/leaderDispatch.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `SquadRunRepo` / `createSquadRunRepo` / `TasksIndexDatabase`；P0/P1/P2a 的全部既有工厂（F8 表，签名不改）
- Produces（**这一节就是 Wave 0 的「冻结接口」，Wave 1 三方按此对表**）：
  - `createSquadRuntime(deps: SquadRuntimeDeps): Promise<SquadRuntime>`
    ```ts
    export type SquadRuntimeDeps = {
      /** taskIndexRepo.openSharedDatabase() 交出的**同一条**连接。自行另开一条会跳过迁移/回填（recon.md F3）。 */
      db: TasksIndexDatabase;
      workspacePath: string;
      workspaceIdentity: string;
      /** 显式覆盖 base 分支；省略时由本层 `git symbolic-ref --short HEAD` 解析——失败**抛**，不猜 "main"。 */
      baseBranch?: string;
      /**
       * 实验开关的**唯一读取口**（spec §5.7.6 门禁）。由组合根注入（读 `appSettings`），
       * runtime 只在这里读一次并把结论交给 `assertDispatchEnabled` —— **分支/工具/UI 都不读**。
       */
      readExperimentEnabled: () => boolean;
    };
    export type SquadRuntime = {
      workItemRepo: WorkItemRepo; wakeRuleRepo: WakeRuleRepo; squadRunRepo: SquadRunRepo;
      workItemService: WorkItemService; teamAgentService: TeamAgentService; squadService: SquadService;
      git: GitRunner; worktreeManager: WorktreeManager;
      /** base 分支（由 HEAD 解析或 deps 显式给出，**不猜 "main"**）。整批 finalize 的目标就是它。 */
      baseBranch: string;
      branchAllocator: ReturnType<typeof createBranchAllocator>;
      integrationMerger: ReturnType<typeof createIntegrationMerger>;
      orphanReaper: ReturnType<typeof createOrphanReaper>;
      /** 绑定的 workspace 身份（裁定 4 + 确认 3）：runtime **为某一个目标 workspace 而构造**，
       *  内部所有访问都只用它；任何来自外部的异己 workspaceKey 一律抛。 */
      boundWorkspace: { path: string; identity: string };
      /** 门禁的唯一实现（spec §5.7.6）：关闭即抛 SquadDispatchDisabledError；**不中断在途 run**。 */
      assertDispatchEnabled(): Promise<void>;
      lifecycle: SquadRunLifecycle;
      /** 工作项事件的**唯一**出口。新增订阅者只准挂在这里，不得去读 repo 轮询。 */
      subscribeWorkItemEvents(handler: (event: WorkItemEvent) => void): () => void;
      /** 供组合根在 dispose 时关闭本域自持的东西（repo 句柄由 node.ts 统一登记，不在此重复）。 */
      dispose(): void;
    };
    ```
  - `ISquadRuntimeService`（**浏览器安全的描述符**，与同名 interface 同处一个文件；UI 只经它取数）
    ```ts
    export type SquadWorkspaceTarget = { path: string; identity: string };
    export type SquadSnapshot = {
      /** **只读呈现用**（UI 据此隐藏 / 禁用入口）——**它不是门禁**；门禁是下面的 assertDispatchEnabled。 */
      enabled: boolean; teamAgents: TeamAgent[]; squads: Squad[];
      workItems: WorkItem[]; runs: SquadRunRecord[];
    };
    export type CreateWorkItemRequest = {
      title: string; body?: string; parentId?: string; assignee: WorkItem["assignee"];
    };
    /** 稳定错误码：跨 RPC 传到上层后按码分流（照 AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE 的做法）。 */
    export const SQUAD_DISPATCH_DISABLED_CODE = "squad_dispatch_disabled";
    export class SquadDispatchDisabledError extends Error {
      readonly code = SQUAD_DISPATCH_DISABLED_CODE;
      constructor() {
        super(`[${SQUAD_DISPATCH_DISABLED_CODE}] 实验功能已关闭：停止新派发（进行中的 run 不受影响）`);
        this.name = "SquadDispatchDisabledError";
      }
    }

    export interface ISquadRuntimeService {
      /**
       * **门禁的唯一判据**（spec §5.7.6 / §12 / §16 S8 S14）。
       *
       * 为什么判据必须落在**服务层单点**、而不是 host 的派发路径或 UI：门禁有**三个入口** ——
       * ① 规则 tick 自动派发、② 用户在最小界面手动触发、③ 队长的派单工具（Wave 1 D）。
       * 放 host 只盖住①；② 与 ③ 不走 host 的那条分支，各自再判就是**三份判据**，
       * 改一处漏一处 —— 那正是「关掉实验照旧派发」的形态（recon.md B4 的现状）。
       * 故判据只有这一处实现，三个入口都调它（① 由 host 在 dispatch 前调；②③ 因为要起新 run，
       * 在下面 createWorkItem / openMemberRun 的**入口**内部调**同一个** assertDispatchEnabled）。
       *
       * 语义（spec §5.7.6）：关闭 ⇒ **拒绝这一次新派发**（抛 SquadDispatchDisabledError）；
       * **不中断在途 run** —— 本方法只读设置、只抛错：不取消、不关会话、不改任何 `squad_runs` 行。
       */
      assertDispatchEnabled(target: SquadWorkspaceTarget): Promise<void>;
      /** UI 的唯一取数口（含只读的 `enabled` 供呈现用）。 */
      getSnapshot(target: SquadWorkspaceTarget): Promise<SquadSnapshot>;
      createTeamAgent(target: SquadWorkspaceTarget, input: CreateTeamAgentInput): Promise<TeamAgent>;
      createSquad(target: SquadWorkspaceTarget, input: CreateSquadInput): Promise<Squad>;
      /** 指派即入队 ⇒ **入口过门禁**（入口② 走这条）。 */
      createWorkItem(target: SquadWorkspaceTarget, input: CreateWorkItemRequest): Promise<WorkItem>;
      /** 起新 run ⇒ **入口过门禁**（入口① 的队员段与入口③ 都汇到这里）。 */
      openMemberRun(target: SquadWorkspaceTarget, input: MemberRunRequest): Promise<OpenMemberRunResult>;
      /** run 终态（host 派发桥调用）。**不过门禁**：收尾在途 run 不属「新派发」。 */
      completeMemberRun(target: SquadWorkspaceTarget, input: { runId: string }): Promise<void>;
      /** 审查裁决（最小视图按钮调用）。**不过门禁**：审查既有产出的动作不产生新派发。 */
      reviewMemberRun(
        target: SquadWorkspaceTarget,
        input: { runId: string; verdict: "approved" | "rejected" },
      ): Promise<ReviewOutcome>;
      /** 启动回收（host 启动路径调用，spec §6.4/§6.6）。**不过门禁**：清理是恢复步骤，不是新派发。 */
      reapStartupOrphans(target: SquadWorkspaceTarget): Promise<ReapOutcome>;
      /** 归档小队 + 指派转交队长（#9，spec §3.10/S10）。**先转交后归档**。 */
      archiveSquadAndTransfer(target: SquadWorkspaceTarget, id: string): Promise<void>;
    }
    export const ISquadRuntimeService = createServiceDescriptor<ISquadRuntimeService>("squad-runtime");
    ```
    > **门禁的判据在哪一行**（供 A/C/D 三方对表，三方都**不得**自己读 `experimentalAgentSquadsEnabled`）：
    > 判据是 `createSquadRuntimeService` 里的一个私有 `isEnabled()`；`assertDispatchEnabled` 是它的唯一对外形态，
    > `createWorkItem` / `openMemberRun` 在入口调**同一个** `assertDispatchEnabled`。**全仓 grep
    > `experimentalAgentSquadsEnabled` 的合法落点只有两处**：服务层判据（本处）+ UI 的**呈现**判断
    > （Task 5 的 `squadEntryVisible`，只影响显隐，不构成门禁）。`packages/desktop/src/**` 里**一处都不许有**。
  - `SquadRunLifecycle`（`squadRunLifecycle.ts`，**机械半**，Wave 0 完整实现）
    ```ts
    export type MemberRunRequest = {
      runId: string; workItemId: string; parentWorkItemId: string; agentId: string; isLeaderTask: boolean;
    };
    export type OpenMemberRunResult = { branch: string; worktreePath: string };
    export type ReviewOutcome =
      | { ok: true; merged: true } | { ok: true; merged: false; kept: true }
      | { ok: false; reason: "conflict" | "branch_missing"; detail: string };
    export interface SquadRunLifecycle {
      openMemberRun(request: MemberRunRequest): Promise<OpenMemberRunResult>;
      completeMemberRun(input: { runId: string }): Promise<void>;
      /** 硬约束 2 的**唯一**口径来源：未合并的队员分支（含被打回待修的）。 */
      computeActiveBranches(workspaceKey: string): Promise<string[]>;
      reapStartupOrphans(input: { workspaceKey: string }): Promise<ReapOutcome>;
      reviewMemberRun(input: { runId: string; verdict: "approved" | "rejected" }): Promise<ReviewOutcome>;
      discardMemberRun(input: { runId: string }): Promise<void>;
    }
    /**
     * 工厂**只收它自己要用的零件**（不收 `SquadRuntime`）：`SquadRuntime` 里含 `lifecycle`，
     * 反过来收它就成了自引用。装配顺序由 `createSquadRuntime` 负责（先建零件、再建 lifecycle、
     * 最后拼成 runtime）。
     */
    export function createRunLifecycle(deps: {
      squadRunRepo: SquadRunRepo; workItemService: WorkItemService; baseBranch: string;
      branchAllocator: ReturnType<typeof createBranchAllocator>;
      integrationMerger: ReturnType<typeof createIntegrationMerger>;
      orphanReaper: ReturnType<typeof createOrphanReaper>;
    }): SquadRunLifecycle;
    ```
  - `SquadBatchOrchestrator`（`squadContracts.ts` **只声明类型**；**实现由 Wave 1 B 落**）
    ```ts
    export interface SquadBatchOrchestrator {
      /** 子项全部终态（category ∈ {done, closed}）后：整批 finalize → 逐个抛弃 → 收尾。 */
      advanceAfterChildrenDone(input: { workspaceKey: string; parentWorkItemId: string }): Promise<void>;
      discardBatch(input: { workspaceKey: string; parentWorkItemId: string }): Promise<void>;
    }
    ```
  - `slugForId(id: string): string`（`slug.ts`）——**单路径段、确定性、对 id 唯一**：
    ```ts
    /**
     * 工作项 / 智能体 → 分支与目录用的 slug。
     *
     * 不拿 id 本身当 slug：`assertSafeSlug` 只接受 `^[a-z0-9][a-z0-9-]*$`，而任意 id（含将来可能出现的
     * 中文、下划线、大写）要过闸就得**归一化**；归一化会把两个不同的 id 映到同一个 slug
     * （`A-B` 与 `a_b` 都变成 `a-b`）——两个工作项于是**共用分支**，互相覆盖成果且不报错。
     * 故直接取 sha256 前 16 个 hex：合法、确定、唯一，且**重启后仍能算出同一个**（启动回收要靠它认活跃分支）。
     * 代价：分支名不可读（`squad/member/<16hex>/<16hex>`），换取「不可能撞车」。
     */
    export function slugForId(id: string): string {
      return createHash("sha256").update(id).digest("hex").slice(0, 16);
    }
    ```
  - `computeEventKey(rule, fact): string`（`packages/shared/src/wake-rule.ts`，**唯一构造器**，spec §5.7.1）
  - `SquadBriefing` 变为**三段**（`leaderDispatch.ts`）
  - `WorkItemRepo.listByAssignee(type: WorkItem["assignee"]["type"], id: string): WorkItem[]`（归档转交用）
  - `SquadService.archive` 落 #9（归档 → 工作项指派与排程**转交队长**）
  - `index.ts` / `node.ts` 导出：`ISquadRuntimeService`、`createSquadRuntime`、`computeEventKey`、`slugForId`、`createSquadRunRepo`，以及 **类型** `SquadRuntime` / `SquadRunLifecycle` / `SquadBatchOrchestrator` / `SquadSnapshot` / `SquadRunRecord`

- [ ] **Step 1: 写失败测试**

```ts
// packages/services/test/squadBriefing.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch, LEADER_PROTOCOL_TEXT } from "../src/workitem/leaderDispatch.js";

const squad = {
  id: "sq_1", name: "网关组", leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { stopCondition: "子项全 done 即收工", maxRounds: "5" }, enabled: true,
} as never;
const wi = {
  id: "wi_1", workspaceIdentity: "ws", workspacePath: "/tmp/ws", title: "t", body: "",
  status: "todo", assignee: { type: "squad", id: "sq_1" }, labels: [], properties: {}, position: 0,
} as never;

// spec §3.3：简报是**三段**。P1 只落了两段（roster + instructions），protocol 缺失——
// 缺的那一段恰是「机制」：没写进简报，队长就不知道三道闸、串行合并、整批才合回、审查未过前工作树存活，
// 而它**不会报错**，只会照着自己猜的规矩跑。
test("队长简报是三段：roster / protocol / instructions", () => {
  const run = planDispatch({ workItem: wi, squad, trigger: "user" }).find(
    (e) => e.kind === "run.enqueued",
  );
  assert.ok(run && run.kind === "run.enqueued" && run.briefing);
  const b = run.briefing!;
  assert.equal(b.roster.length, 2);
  assert.equal(b.instructions.stopCondition, "子项全 done 即收工");
  assert.ok(b.protocol.length > 0);
});

// protocol 是**系统生成的机制段**，不得取自用户可写的 instructions：
// 并进 instructions 等于把机制交还给用户去写，用户没写就等于「队长不知道规则却照跑」。
test("protocol 段不随用户指令改变，且必含四类机制要点", () => {
  const other = { ...squad, instructions: { stopCondition: "x", maxRounds: "1" } };
  const run = planDispatch({ workItem: wi, squad: other as never, trigger: "user" }).find(
    (e) => e.kind === "run.enqueued",
  );
  assert.ok(run && run.kind === "run.enqueued" && run.briefing);
  assert.equal(run.briefing!.protocol, LEADER_PROTOCOL_TEXT);
  for (const must of ["max_fires", "串行", "集成分支", "blocked", "存活"]) {
    assert.ok(LEADER_PROTOCOL_TEXT.includes(must), `protocol 段缺机制要点：${must}`);
  }
});
```

```ts
// packages/services/test/eventKey.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { computeEventKey } from "@zcode/shared";

// spec §5.7.1：事件族优先用事件自带的**稳定 id**；同一事实重投两次必须算出同一个 key，
// 否则「同一事实只处理一次」这条去重（§5.5 merged）根本不存在。
test("事件族：有稳定 id 时用 id，且重投同 id 得同 key", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event", eventTypes: ["issue.assigned"] } as never;
  const fact = { source: "github", externalId: "delivery-1", eventType: "issue.assigned", payload: { a: 1 } };
  assert.equal(computeEventKey(rule, fact), computeEventKey(rule, fact));
  assert.match(computeEventKey(rule, fact), /^e:id:github:delivery-1$/);
});

// §5.7.1 最关键的一句：`filters` / `eventTypes` **不参与** key。
// 拼进去会让规则作者改一下过滤器就换掉一把去重键 ⇒ 历史去重记录全部失效（同一事实被重新处理一次）。
test("改 filters / eventTypes 不改变 key", () => {
  const fact = { source: "gh", externalId: "d-9", eventType: "issue.assigned", payload: {} };
  const a = computeEventKey({ id: "w1", workItemId: "wi", kind: "event", eventTypes: ["x"] } as never, fact);
  const b = computeEventKey(
    { id: "w1", workItemId: "wi2", kind: "event", eventTypes: ["y"], filters: { a: 2 } } as never,
    fact,
  );
  assert.equal(a, b);
});

// 无可稳定 id 时退用**完整 payload 的规范化指纹**——正因如此，仅时间戳不同的两次事件算出不同 key。
test("事件族：无稳定 id 时用完整 payload 指纹（易变字段不影响）", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const base = { source: "gh", eventType: "e", payload: { a: 1, b: { c: 2, d: 3 } } };
  const reordered = { source: "gh", eventType: "e", payload: { b: { d: 3, c: 2 }, a: 1 } };
  assert.match(computeEventKey(rule, base), /^e:fp:gh:e:/);
  assert.equal(computeEventKey(rule, base), computeEventKey(rule, reordered));
  assert.notEqual(
    computeEventKey(rule, base),
    computeEventKey(rule, { ...base, payload: { a: 1, b: { c: 2, d: 4 } } }),
  );
  // 易变字段在**同处声明的常量**里被排除，不得在调用点就地过滤。
  assert.equal(
    computeEventKey(rule, { ...base, payload: { ...base.payload, deliveryAttempt: 1 } }),
    computeEventKey(rule, { ...base, payload: { ...base.payload, deliveryAttempt: 9 } }),
  );
});

// 既无稳定 id、payload 又不可规范化 ⇒ **抛**（不 fire）：不可去重的事件每次重投都会重复触发且不报错。
test("不可去重的事件抛错", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => computeEventKey(rule, { source: "gh", eventType: "e", payload: cyclic }), /eventKey/);
});

// 排期族：名义时刻（**不是**发现它的墙钟时刻）进 key，故重启重算 / misfire 补发 / tick 反复捞到
// 三种情形都算出同一个 key。两族前缀不同 ⇒ 事件的第 N 次与排期的第 N 次永不撞键。
test("排期族用名义时刻，前缀与事件族不同", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "every", intervalSeconds: 60 } as never;
  assert.equal(computeEventKey(rule, { scheduledFor: 1000 }), "t:1000");
  assert.notEqual(computeEventKey(rule, { scheduledFor: 1000 }), computeEventKey(rule, { scheduledFor: 1060 }));
});
```

```ts
// packages/services/test/squadRuntime.test.ts —— 用真实临时 git 仓库与临时 workspace
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime, renderLeaderBriefingPrompt } from "../src/workitem/squadRuntime.js";
import { makeRepo } from "./helpers/gitFixture.js";

async function setup() {
  const repoRoot = await makeRepo(); // P2a 的共享夹具（test/helpers/gitFixture.ts）
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
  });
  return { repoRoot, db, runtime };
}

// 组合根装配的机器化证明：recon.md C6 说这一切出厂即「零生产调用方」，本用例是第一个调用方。
test("装配后 repo / service / 工具都在，且 base 分支来自真实 HEAD", async () => {
  const { runtime } = await setup();
  assert.equal(typeof runtime.workItemRepo.insert, "function");
  assert.equal(typeof runtime.wakeRuleRepo.listReady, "function");
  assert.equal(typeof runtime.workItemService.transition, "function");
  assert.equal(typeof runtime.squadService.create, "function");
  assert.equal(typeof runtime.teamAgentService.create, "function");
  assert.equal(typeof runtime.lifecycle.openMemberRun, "function");
});

// 开树必须**先落台账后建树**：反过来（树建成了而台账没写）在两者之间崩溃，
// 队员的未提交成果会被启动回收当孤儿收掉——「审查被拒必须存活到合并」就落空了。
test("openMemberRun 先落台账再建树", async () => {
  const { repoRoot, runtime } = await setup();
  const out = await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-c", parentWorkItemId: "wi-p",
    agentId: "ta-a", isLeaderTask: false,
  });
  const row = runtime.squadRunRepo.get("run-1")!;
  assert.equal(row.status, "open");
  assert.equal(row.dirName, out.worktreePath.split("/").at(-1));
  assert.equal(row.branch, out.branch);
  assert.ok(out.branch.startsWith("squad/member/"));
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === out.worktreePath));
});

// 硬约束 2：`open`（在跑）/`produced`（已产出未合并）/`rejected`（被打回待修）**都算活跃**。
// 少了 `rejected`，被打回待修的队员工作树会在下次启动被静默回收（spec §16 S5 失效）。
test("computeActiveBranches 覆盖 open / produced / rejected，且不含已合并", async () => {
  const { runtime } = await setup();
  const a = await runtime.lifecycle.openMemberRun({
    runId: "r-a", workItemId: "wi-a", parentWorkItemId: "wi-p", agentId: "ta-a", isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-b", workItemId: "wi-b", parentWorkItemId: "wi-p", agentId: "ta-b", isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-c", workItemId: "wi-c", parentWorkItemId: "wi-p", agentId: "ta-c", isLeaderTask: false,
  });
  await runtime.lifecycle.completeMemberRun({ runId: "r-b" }); // → produced
  await runtime.lifecycle.reviewMemberRun({ runId: "r-c", verdict: "rejected" }); // → rejected
  runtime.squadRunRepo.setStatus("r-a", "merged");
  const active = (await runtime.lifecycle.computeActiveBranches("ws")).sort();
  assert.deepEqual(active, [
    runtime.squadRunRepo.get("r-b")!.branch,
    runtime.squadRunRepo.get("r-c")!.branch,
  ].sort());
  assert.equal(active.includes(a.branch), false);
});

// 台账是**持久**的：换一个 runtime 实例（模拟重启）仍能算出同一批活跃分支。
test("重启后 computeActiveBranches 仍然正确（台账持久）", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const mk = () => createSquadRuntime({ db, workspacePath: repoRoot, workspaceIdentity: "ws" });
  const first = await mk();
  await first.lifecycle.openMemberRun({
    runId: "r-p", workItemId: "wi-p2", parentWorkItemId: "wi-p", agentId: "ta-p", isLeaderTask: false,
  });
  const restart = await mk();
  assert.equal((await restart.lifecycle.computeActiveBranches("ws")).length, 1);
});

// 启动回收**必须**用同一个口径来源：造一个不在活跃集合里的孤儿树 + 一个待修树，
// 回收后只有孤儿被收。
test("reapStartupOrphans 只收活跃集合外的树", async () => {
  const { runtime } = await setup();
  const kept = await runtime.lifecycle.openMemberRun({
    runId: "r-keep", workItemId: "wi-k", parentWorkItemId: "wi-p", agentId: "ta-k", isLeaderTask: false,
  });
  await runtime.lifecycle.openMemberRun({
    runId: "r-drop", workItemId: "wi-d", parentWorkItemId: "wi-p", agentId: "ta-d", isLeaderTask: false,
  });
  const dropDir = runtime.squadRunRepo.get("r-drop")!.dirName!;
  runtime.squadRunRepo.setStatus("r-drop", "merged"); // 已合并 ⇒ 不再活跃
  const out = await runtime.lifecycle.reapStartupOrphans({ workspaceKey: "ws" });
  assert.ok(out.reclaimed.includes(dropDir));
  assert.ok(out.kept.includes(kept.worktreePath.split("/").at(-1)!));
});

// 三段简报的渲染：host 派发桥把 briefing 变成 prompt，三段都必须到场且各带标题。
test("渲染出的队长 prompt 含三段标题", async () => {
  const prompt = renderLeaderBriefingPrompt({
    squadId: "sq_1", leaderAgentId: "ta_lead",
    roster: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
    protocol: "PROTOCOL-BODY",
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.ok(prompt.includes("## 花名册"));
  assert.ok(prompt.includes("## 操作协议"));
  assert.ok(prompt.includes("PROTOCOL-BODY"));
  assert.ok(prompt.includes("## 队长指令"));
  assert.ok(prompt.includes("stopCondition"));
});
```

```ts
// packages/services/test/squadArchiveTransfer.test.ts（#9 归档转交）
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";

// spec §3.10 / §16 S10：归档小队 ⇒ 其工作项指派与排班**转交队长**。
// 不转交的话，归档后留下的指派会指向一个不再接派发的小队（静默挂着，没有 run，也没有告警）。
test("archive 把该小队的指派转交队长", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({ db, workspacePath: ws, workspaceIdentity: "ws" });
  const leader = runtime.teamAgentService.create({
    name: "L", systemPrompt: "s", memoryScope: "project",
  });
  const member = runtime.teamAgentService.create({
    name: "M", systemPrompt: "s", memoryScope: "project",
  });
  const squad = runtime.squadService.create({
    name: "sq", leaderAgentId: leader.id, members: [member.id],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws", workspacePath: ws, title: "t",
    assignee: { type: "squad", id: squad.id },
  });
  runtime.squadService.archive(squad.id);
  assert.deepEqual(runtime.workItemRepo.get(item.id)!.assignee, { type: "agent", id: leader.id });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/squadBriefing.test.ts`
Run: `pnpm exec tsx --test packages/services/test/eventKey.test.ts`
Run: `pnpm exec tsx --test packages/services/test/squadRuntime.test.ts`
Expected: FAIL（`LEADER_PROTOCOL_TEXT` / `computeEventKey` / `createSquadRuntime` 不存在）

- [ ] **Step 3: 最小实现**

1. **`packages/shared/src/wake-rule.ts`** 加 `computeEventKey`（**唯一构造器**，spec §5.7.1）+ 同处声明的 `EVENT_KEY_VOLATILE_FIELDS` 常量 + `stableStringify`（对象键按码点升序、数组保序、数字最简形式、字符串 JSON 转义；**排除易变字段**）。语义逐条照 §5.7.1：`e:id:<source>:<externalId>` → `e:fp:<source>:<eventType>:<sha256(stableStringify(payload))>` → **抛**；排期族 `t:<scheduledFor>`。
   > 排期族的「钉死的 epoch 锚点」在本阶段只被 `every` 的 `nextFireAt` 消费（`scheduledFor` 由调用方按网格算出并传入），本函数**只做格式化**，不自行锚定 —— 锚点归调度器（Task 3 A）。
2. **`slug.ts`**：按上面给的形式实现 `slugForId`。
3. **`leaderDispatch.ts`**：`SquadBriefing` 加 `protocol: string`；新增 `export const LEADER_PROTOCOL_TEXT`（**系统生成的机制段**，spec §3.3 表逐项：三道闸 `max_fires`/`rate`/`loop` 与判定次序、`stopCondition` 与 `maxRounds` 语义、派单只产出子项与派发事件**不改父项状态**、**串行**合并到集成分支、**整批通过才合回主分支**、冲突解不了 → `blocked` + 进 Inbox、审查未通过前工作树**存活**、合并后才抛弃）；`buildBriefing` 带上它。`SquadBriefing.roster` / `instructions` 的既有快照语义逐字保留。
4. **`workItemRepo.ts`**：加 `listByAssignee(type, id)`（`WHERE assignee_type=? AND assignee_id=? AND archived_at IS NULL`）。
5. **`squadService.ts`**：`archive(id)` 删掉 `TODO(P2)`，改为「写 `archivedAt` 之**后**，把 `workItemRepo.listByAssignee("squad", id)` 的每一项 `assignee` 改成 `{ type: "agent", id: leaderAgentId }`」。为不改动 `SquadService` 的既有无依赖签名（F8），本步骤在 `squadRuntime.ts` 里做**组合**：`archiveSquadAndTransfer(id)` 由 runtime 暴露，内部调 `squadService.archive` + `workItemRepo`/`wakeRuleRepo` 改动；`SquadService.archive` 自身只做归档（**保持 F8 签名不变**）。
   > 排程转交用 `wakeRuleRepo.listByWorkItem(...)` 把指向旧小队的规则改挂到队长那份工作项上；本阶段最小实现为：**把工作项指派转交**，并把该工作项的 `mode: "once"` 事件规则保留（它本来就挂在工作项上、不指名小队）。**理由**：规则的触发条件里没有 squad 字段，转交的对象是「派发给谁」，即 `assignee`。
6. **`squadRuntime.ts`**：按 Produces 装配（`createGitRunner()` → `resolveWorktreeRoot`/`manager`/`allocator`/`merger`/`reaper`；`createSquadRunRepo(db)`；`createWorkItemService({ repo, emit })`，`emit` 派发给内部订阅表）。base 分支取 `deps.baseBranch ?? (await git(["symbolic-ref","--short","HEAD"]))`，`code !== 0` **抛**。再加一个**导出的纯函数** `renderLeaderBriefingPrompt(briefing): string`（三段各带 `##` 标题：`## 花名册` / `## 操作协议` / `## 队长指令`；**纯函数**——它要被 host 与测试直接调，做成 runtime 的方法会让 host 为了拼一段文本先建整个 runtime）。
   （`ISquadRuntimeService` 的 `archiveSquadAndTransfer` 与 `reapStartupOrphans` 都实现在这里，薄薄一层委托给 `lifecycle` / `squadService` + `workItemRepo`。）
   **装配顺序**（`lifecycle` 自引用问题）：① `git` + `repoRoot`；② 五个 worktree 工具；③ `squadRunRepo`；④ `workItemService`（带内部 `emit`）；⑤ `createRunLifecycle({ squadRunRepo, workItemService, baseBranch, branchAllocator, integrationMerger, orphanReaper })`；⑥ 拼成 `SquadRuntime`。**`lifecycle` 不得在 step ③ 之前建**（它要用 ②⑤ 的产物）。
7. **`squadRunLifecycle.ts`**：机械半。
   - `openMemberRun`：`assertSafeSlug` 由 `planBranches` 内部负责；步骤 = ① `slugForId(workItemId)` / `slugForId(agentId)` → `planBranches`；② **先** `squadRunRepo.insert({status:"open", branch, dirName: memberDirName(plan)})`；③ **后** `branchAllocator.allocate(plan, baseBranch)`。
   - `completeMemberRun`：`setStatus(runId,"produced")` + `workItemService.transition(workItemId, "in_review", "in_progress")`（**唯一写者仍是服务**；CAS 未命中不影响产物，故不抛）。
   - `computeActiveBranches`：`squadRunRepo.listActive(workspaceKey).map(r => r.branch).filter(Boolean)`。**注释写明这是硬约束 2 的唯一口径来源、禁止旁路。**
   - `reapStartupOrphans`：`orphanReaper.reap({ activeBranches: await computeActiveBranches(...) })`；`deleteBranch`/`listBranches` 两个 dep 按 P2a 契约绑定（`(b) => deleteBranch(git, repoRoot, b)`、`(p) => git(["for-each-ref","--format=%(refname:short)",`refs/heads/${p}`])` 解析）。
   - `reviewMemberRun`：`approved` → `integrationMerger.ensureIntegration(planBranches(...).integration)` 再 `mergeMember`；`ok:true` → `setStatus("merged")`；`reason:"conflict"` → `setStatus` 保持 `produced` + 返回 `{ok:false,...}`（**由 Wave 2 的批次层置 `blocked` + Inbox**，本层不写工作项状态）。`rejected` → `setStatus("rejected")`、**工作树一个字节不动**（spec §6.2），返回 `{ ok:true, merged:false, kept:true }`。
   - `discardMemberRun`：`integrationMerger.discardMember({ branch, dirName })` 后 `setStatus("discarded")`。
8. **`squadRuntimeService.ts`**：`ISquadRuntimeService` 描述符 + 接口（**浏览器安全**：只 import `@zcode/shared` 的类型与 `@zcode/services` 的 `createServiceDescriptor`/`CreateSquadInput` 类型，**不得** import `node:*`）；`createSquadRuntimeService(deps): ISquadRuntimeService` 放**同文件但只被 node.ts 引用**的导出里也可以——**采用后者**，理由：描述符必须浏览器可达，实现只需 node 侧可达，两者同一文件但实现函数的依赖由调用方注入，故不引入 `node:*` 静态依赖。
9. **`node.ts`**：在 `createServiceCollection(...)` 内（`services` 集合构造之后、`sqliteReposToClose.push(taskIndexRepo)`（`:2704`）之前）注册服务。**确认 3：runtime 按目标 workspace 现构、用完即弃（不缓存）**：
   ```ts
   // 小队 runtime **不做长期单例、不缓存**：每个使用点带着自己的**目标 workspace** 进来，
   // 这里为它现构一个 runtime，方法返回后不再保留它。
   // 为什么选「不缓存」：缓存要回答「什么时候失效」——workspace 切换、会话迁移、设置变更都会让它变陈旧，
   // 而陈旧的表现是**在错的 workspace 上读写**（用户看到「我明明没建过」）。不缓存 ⇒ 无陈旧、无失效逻辑。
   // 代价：每次操作多一次构造（含一次 `git symbolic-ref` 子进程）。若这一步实测成为热路径，
   // 再改成按 `workspaceKey` 缓存**并显式登记失效面**（并在任务报告里写明依据）——
   // 但**任何时候都不得**退化成「取首个 workspace」。
   const createSquadRuntimeFor = async (target: SquadWorkspaceTarget): Promise<SquadRuntime> => {
     await taskIndexRepo.ensureReady();
     return createSquadRuntime({
       db: taskIndexRepo.openSharedDatabase(), // 与 taskIndexRepo 是**同一条**连接（recon.md F3）
       workspacePath: target.path,
       workspaceIdentity: target.identity,
       // 门禁的**唯一读取口**：整个 desktop 侧没有第二处读这个字段（spec §5.7.6）。
       readExperimentEnabled: () => settingService.getSync?.().experimentalAgentSquadsEnabled === true,
     });
   };
   services.register(
     ISquadRuntimeService,
     createSquadRuntimeService({
       createRuntime: createSquadRuntimeFor,
       // 只读呈现用（UI 据此隐藏 / 禁用入口）；门禁本体在 runtime.assertDispatchEnabled。
       readExperimentEnabled: async () =>
         (await settingService.get()).experimentalAgentSquadsEnabled === true,
     }),
   );
   ```
   > `readExperimentEnabled` 在 runtime 侧是**同步**的（`assertDispatchEnabled` 不该变成异步 IO 链）；若 `ISettingService` 只提供异步 `get()`，则在**组合根**里维护一份由 `settingService` 变更事件刷新的同步快照（`let squadsEnabled = false; settingService.onDidChange(() => …)`），**快照的刷新点只有这一处**。若实现时发现该同步快照不可得，**停下来报 `NEEDS_CONTEXT` 并说明**，不要改成「每个入口各自 `await settingService.get()`」——那会退回成三份判据。

   workspace 的来路：本阶段用 `resolveStorageRoots`（`packages/services/src/storage/adapters/rootsResolver.ts:11`，`node.ts:205` 已导出）不可行——它给的是**存储根**不是会话 workspace。故改为从 `options` 新增可选入参 `squadWorkspace?: { path: string; identity: string }`，由 desktop host 在 `createServiceCollection` 调用点传入。
   **裁定 4 + 确认 3（不许静默取第一个；runtime 按目标现构）——按此实现，不得自行放宽：**
   - **目标必须显式**：`ISquadRuntimeService` 的**每个方法第一个参数都是 `SquadWorkspaceTarget`**（`{ path, identity }`）——调用方**带着自己的目标**进来。没有环境绑定、没有隐式默认，**因此结构上不存在「取首个」这一格**。
   - **runtime 与目标一一对应**：`createRuntime(target)` 为它现构一个 runtime，`runtime.boundWorkspace = target`；runtime 内部所有访问都只用它，**任何来自外部的异己 workspaceKey 一律抛**（错误带两侧值）。
   - **候选多于一个时不得静默挑一个**：调用方给不出唯一目标时（host 侧从会话集解析目标），**拒绝并报告候选清单**（`resolveSquadWorkspaceBinding`：0 个 ⇒ 抛「未绑定」；> 1 个 ⇒ 抛并列出候选）。
   - **不缓存**：见上面 step 9 的注释（无陈旧、无失效逻辑）；**若实测构造是重活，改按 `workspaceKey` 缓存并显式登记失效面，并在报告里说明**——**不得**静默退化成「取首个 workspace」。
   - 该解析函数的接线属 **Task 7（Wave 2 收口）**，本任务只落出**形状**、**绑定字段**与抛错路径（各配一条测试）。

- [ ] **Step 3b-2: workspace 目标与门禁的失败路径测试（裁定 4 + 确认 2/3）**

```ts
// 追加到 packages/services/test/squadRuntime.test.ts
const target = (identity: string) => ({ path: `/tmp/${identity}`, identity });

// 确认 3：runtime 为**目标**而构造，内部遇到异己 workspaceKey ⇒ 响亮抛错。
// 静默按传入值操作 = 在另一个 workspace 上读写（用户看到的是「我明明没建过」）。
test("runtime 拒绝异己 workspaceKey（带两侧的值）", async () => {
  const { runtime } = await setup(); // setup 绑定的是 "ws"
  await assert.rejects(
    () => runtime.lifecycle.computeActiveBranches("another-ws"),
    /ws/,
  );
});

// 确认 2：**门禁的唯一判据**。关闭 ⇒ 抛**稳定 code**（供上层按码分流，不靠文案）。
test("开关关闭 ⇒ assertDispatchEnabled 抛 SquadDispatchDisabledError", async () => {
  const { runtime } = await disabledSetup(); // readExperimentEnabled: () => false
  const error = await runtime.assertDispatchEnabled().catch((e: unknown) => e);
  assert.ok(error instanceof SquadDispatchDisabledError);
  assert.equal((error as SquadDispatchDisabledError).code, "squad_dispatch_disabled");
});

// 确认 2：**三个入口共用同一判据**。至少覆盖「界面触发」与「规则 tick」两条：
// ① 规则 tick 走 assertDispatchEnabled；② 界面触发走 createWorkItem（指派即入队）。
test("开关关闭 ⇒ 界面触发（createWorkItem）与规则 tick 都被拦", async () => {
  const svc = await disabledService();
  await assert.rejects(() => svc.assertDispatchEnabled(target("ws")), /squad_dispatch_disabled/);
  await assert.rejects(
    () => svc.createWorkItem(target("ws"), { title: "t", assignee: { type: "agent", id: "ta-a" } }),
    /squad_dispatch_disabled/,
  );
});

// 确认 2：**在途 run 不中断** —— 这是 spec §5.7.6 与 §16 S14 明文要求的那一半。
// 关掉开关后：已有的 open run 台账与工作树**一个字节不动**，且不发出任何取消。
test("开关关闭 ⇒ 在途 run 不被中断", async () => {
  const { runtime, svc, setEnabled } = await controllableSetup();
  const opened = await runtime.lifecycle.openMemberRun({
    runId: "r-live", workItemId: "wi-l", parentWorkItemId: "wi-p", agentId: "ta-l", isLeaderTask: false,
  });
  setEnabled(false);
  await assert.rejects(() => svc.assertDispatchEnabled(target("ws")), /squad_dispatch_disabled/);
  assert.equal(runtime.squadRunRepo.get("r-live")!.status, "open"); // 台账不变
  assert.equal(runtime.squadRunRepo.get("r-live")!.branch, opened.branch); // 分支字段不变
  assert.ok((await runtime.worktreeManager.list()).some((e) => e.path === opened.worktreePath)); // 树还在
});
```

```ts
// packages/desktop/test/squadWorkspaceBinding.test.ts（Wave 2 落地，本任务只出形状）
// 候选 > 1 时**拒绝并报告候选清单**，不得隐式取首个。
test("多个候选 workspace ⇒ 抛且列出候选", async () => {
  assert.throws(
    () => resolveSquadWorkspaceBinding([{ path: "/a", identity: "a" }, { path: "/b", identity: "b" }]),
    /a[\s\S]*b/,
  );
});
test("唯一候选 ⇒ 用它", () => {
  assert.deepEqual(resolveSquadWorkspaceBinding([{ path: "/a", identity: "a" }]), {
    path: "/a", identity: "a",
  });
});
test("无候选 ⇒ 抛（未绑定）", () => {
  assert.throws(() => resolveSquadWorkspaceBinding([]), /未绑定/);
});
```
10. **`index.ts`**：追加 `export { ISquadRuntimeService } from "./workitem/squadRuntimeService.js"; export type { ISquadRuntimeService as ISquadRuntimeServiceShape, SquadSnapshot, CreateWorkItemRequest } from "./workitem/squadRuntimeService.js";` 与 `export { computeEventKey } from "@zcode/shared";`（若 shared 已在 index.ts 里透传则跳过）以及 `slugForId`、`createSquadRunRepo` 及 `SquadRunRecord`/`SquadRunStatus`/`SquadRunRepo` 类型。
11. **`node.ts`** 追加导出（desktop 只能经 `@zcode/services/node` 与 `.` 两个入口取东西，见 `packages/services/package.json#exports`）：

```ts
export { createSquadRuntime, renderLeaderBriefingPrompt } from "./workitem/squadRuntime.js";
// Wave 1 A 的调度器进程要**自己**建这条连接（与 AutomationRepo / OffPeakTaskRepo 同法：scheduler 侧
// 直接 new/ create）并跑判定，故这三个也必须从本入口可达——它们是 workitem/ 域**第一次**被桌面侧消费。
export { createWakeRuleRepo } from "./workitem/wakeRuleRepo.js";
export { decideWake } from "./workitem/wakeGuard.js";
export { planDispatch } from "./workitem/leaderDispatch.js";
export type { WakeRuleRepo } from "./workitem/wakeRuleRepo.js";
export type { WorkItemEvent, WorkItemService } from "./workitem/workItemService.js";
export type { WorkItemRepo } from "./workitem/workItemRepo.js";
export type { SquadRuntime, SquadBatchOrchestrator, SquadRunLifecycle } from "./workitem/squadContracts.js";
```

（`squadContracts.ts` 只含**类型**，`SquadRuntime` 的**值**由第一条给出。）
**注意：本任务不 re-export B 的 `createSquadOrchestrator`**（它的文件在 Wave 1 才存在）；那一行由 **Task 7（Wave 2）** 追加，文本见该任务。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/squadBriefing.test.ts`
Run: `pnpm exec tsx --test packages/services/test/eventKey.test.ts`
Run: `pnpm exec tsx --test packages/services/test/squadRuntime.test.ts`
Run: `pnpm exec tsx --test packages/services/test/squadArchiveTransfer.test.ts`
Run: `pnpm exec tsx --test packages/services/test/leaderDispatch.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.3 / §5.7.1 / §6.1 §6.2 / §13 C10 / §17；recon.md C6、B4、B5、F3、F6）：

- §3.3 的简报是否**确为三段**，且 `protocol` 是**系统生成、不取自 `instructions`**？
- §5.7.1 每条是否落地：唯一构造器 / 两族前缀 / 稳定 id 优先 / 完整 payload 指纹 / 无法去重则抛 / `stableStringify` 钉死 / 易变字段是**同处常量** / **`filters` 不参与 key** / `revision` 不在 key 内？
- 硬约束 2：`computeActiveBranches` 是否**唯一**口径来源，且 `reapStartupOrphans` **内部**调它（没有第二处口径）？
- recon.md F3：装配拿到的确实是 `taskIndexRepo.openSharedDatabase()`（不是新连接）？
- recon.md F6：本任务新引入的 sqlite 句柄是否**都**登记进关闭链？（`squadRunRepo` 与 `taskIndexRepo` 共用连接 ⇒ **不得**重复登记，重复 `close()` 会在 dispose 时二次关同一连接）
- #9：归档转交后，**还有没有**指向已归档小队的 `assignee`？
- `slugForId` 的确定性：同一个 id 在**重启后**算出同一个 slug（启动回收要靠它认清活跃分支）？

**② 穷举**（先列全集，再逐格给结论）：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| 简报段 | roster / protocol / instructions | |
| `instructions` 槽位 | 8 个全给 / 只给 2 个必填 / 空 | |
| `computeEventKey` 族 | event（有 id / 无 id 可用指纹 / 两者皆无）/ at / every / cron | |
| payload 形态 | 嵌套对象 / 数组 / 数字 / 字符串 / `null` / 循环引用 / 只差时间戳 / 只差易变字段 | |
| 规则字段变动 | 改 `filters` / 改 `eventTypes` / 改 `workItemId` / 改 `revision` | |
| `openMemberRun` | 首次 / 同 runId 重复 / 分支已存在（残枝）/ base 不存在 / 目录已存在 | |
| `completeMemberRun` | runId 存在 / 不存在 / 已是终态 | |
| `reviewMemberRun` | approved 成功 / approved 冲突 / rejected / 未知 runId | |
| `reapStartupOrphans` | 活跃集合空 / 含全部 / 含部分 / 含不存在的分支 | |
| 装配 | workspace 已绑定 / 未绑定（必须抛）/ 实验开关 on / off | |
| `archive` 转交 | 该小队有工作项 / 没有 / 多个 | |

逐格写「有测试 / 由代码或类型保证（哪一行）/ 不适用 + 理由」。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/node.ts packages/services/src/index.ts \
        packages/services/src/workitem/squadRuntime.ts \
        packages/services/src/workitem/squadRuntimeService.ts \
        packages/services/src/workitem/squadRunLifecycle.ts \
        packages/services/src/workitem/squadContracts.ts \
        packages/services/src/workitem/slug.ts \
        packages/services/src/workitem/leaderDispatch.ts \
        packages/services/src/workitem/workItemRepo.ts \
        packages/services/src/teams/squadService.ts \
        packages/shared/src/wake-rule.ts \
        packages/services/test/squadRuntime.test.ts \
        packages/services/test/squadBriefing.test.ts \
        packages/services/test/eventKey.test.ts \
        packages/services/test/squadArchiveTransfer.test.ts \
        packages/services/test/leaderDispatch.test.ts
git commit -m "feat(squad): 组合根装配 + 契约冻结（三段简报 / computeEventKey / slug / 运行生命周期机械半）"
```

---

### Task 3（A｜唤醒调度 + 派发桥）（Wave 1，与 B / C / D 并行）

> 工作树：`.worktrees/p2b-scheduler`，分支 `feat/p2b-scheduler`（**扁平后缀**）。从 `feat/p2b-spine` 顶端起。

**Owns:** `packages/desktop/src/scheduler/**`、`packages/desktop/src/main/desktopCronScheduler.ts`、`packages/desktop/src/main/desktopHostProcess.ts`（仅新增结果分支）、`packages/shared/src/channels.ts`（仅**新增**两个常量）、`packages/shared/src/validation.ts`（仅新增 schema 与并集项）、`packages/desktop/src/host/index.ts`（**唤醒 / 派发分支**）、`packages/desktop/src/host/squadDispatch.ts`（新）、`packages/desktop/test/{schedulerWakeTick,schedulerWiring,hostSquadDispatch}.test.ts`（新）

**Must not touch:** `packages/services/**`（**尤其 `node.ts`**）、`packages/ui/**`、`packages/desktop/src/host/index.ts` 的 `dispatchCronRun` / `dispatchOffPeakRun` 既有分支（只**新增**分支，不改既有）、**任何地方都不得读 `experimentalAgentSquadsEnabled`**（门禁判据在服务层单点，确认 2）

**Files:**

- Create: `packages/desktop/src/scheduler/wakeTick.ts`
- Create: `packages/desktop/src/host/squadDispatch.ts`
- Modify: `packages/desktop/src/scheduler/index.ts`（tick 内加一路；`main()` 里加一个 tick 定时器）
- Modify: `packages/desktop/src/scheduler/schedulerProtocol.ts`（新增 `squad-wake-dispatch-request` / `squad-wake-dispatch-result`）
- Modify: `packages/desktop/src/main/desktopCronScheduler.ts`（转发到 host；收回结果）
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`（`SquadWakeResult` 分支，照 `:514-515` 的 `CronRunResult` 形状）
- Modify: `packages/shared/src/channels.ts`（`HostMessageTypes.SquadWake` / `HostResponseTypes.SquadWakeResult`）
- Modify: `packages/shared/src/validation.ts`（`hostSquadWakeMessageSchema` / `hostSquadWakeResultSchema`，并加入两处并集）
- Modify: `packages/desktop/src/host/index.ts`（新增 `HostMessageTypes.SquadWake` 分支；**门禁不在此实现**）
- Test: `packages/desktop/test/schedulerWakeTick.test.ts`、`packages/desktop/test/schedulerWiring.test.ts`、`packages/desktop/test/hostSquadDispatch.test.ts`

**Interfaces:**

- Consumes（**全部来自 Wave 0 冻结面；若缺，先回报而不是自行拼一份**）：
  - 自 `@zcode/services/node`：`createWakeRuleRepo(db)`、`decideWake`、`planDispatch`、`renderLeaderBriefingPrompt`、`ISquadRuntimeService`、`createSquadRuntime`、类型 `WakeRule` / `WorkItem` / `Squad` / `SquadRunRecord`
  - 自 `@zcode/shared`：`computeEventKey`、`HostMessageTypes`、`HostResponseTypes`、`resolveWorkspaceKey`
  - 既有可照抄的同款：`createBoundSessionExecutingProbe`（`packages/desktop/src/host/boundSessionBusyGate.ts:84`）、`dispatchCronRun`（`packages/desktop/src/host/index.ts:873`）、`zcodeTaskService.createTask`（`packages/services/src/session/zcodeTaskService.ts:215`）/`resumeTask`（`:364`）/`sendPrompt`（`:243`）
- Produces（**Wave 2 与 C 依赖这两条**）：
  - `HostMessageTypes.SquadWake = "squad-wake"`、`HostResponseTypes.SquadWakeResult = "squad-wake-result"`
  - `hostSquadWakeMessageSchema`——**薄消息**（只带「哪条规则到点了」，**不带** agentId / briefing / prompt）：
    ```ts
    // main → host：一条唤醒规则到点。**故意做薄**：规划（解析工作项与小队、决定派给谁、
    // 渲染简报）留在 host 侧一处完成，调度器保持「认领 + 转发」的薄角色——与 cron 路径同形。
    // 若把 agentId / isLeaderTask / prompt 放进消息，调度器就得自己读小队定义（那是**文件**、
    // 由服务层拥有），于是同一份规划逻辑会有两个实现，且漂移时不报错。
    export const hostSquadWakeMessageSchema = z.object({
      type: z.literal("squad-wake"),
      ruleId: nonEmptyStringSchema,
      workItemId: nonEmptyStringSchema,
      /** spec §5.7.1：四元组里的 revision（fencing：过期 revision 的派发自动作废）。 */
      revision: z.number().int().nonnegative(),
      /** spec §5.7.1：由唯一构造器 computeEventKey 产出，**不得**就地拼串。 */
      eventKey: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: z.string().optional(),
    });
    ```
  - `createWakeTick(deps): { run(now: number): Promise<void> }`（**纯逻辑、可注入、不依赖 Electron**）
  - `decideSquadDispatch(input): SquadDispatchDecision`（**纯函数**，把硬约束 1 与门禁判成可断言的值）
  - `SQUAD_DISPATCH_DISABLED_CODE` 的判定助手 `isSquadDispatchDisabledError(error)`（按**稳定 code**判，不按文案）

- [ ] **Step 1: 写失败测试**

```ts
// packages/desktop/test/schedulerWakeTick.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createWakeTick } from "../src/scheduler/wakeTick.js";

const rule = (over = {}) => ({
  id: "w1", workItemId: "wi_1", kind: "event", mode: "once",
  fireCount: 0, revision: 3, enabled: true, nextFireAt: 1000, ...over,
} as never);

test("到点且决定 fire ⇒ 发出派发请求，eventKey 带四元组里的两维", async () => {
  const posts: unknown[] = [];
  const advanced: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    advance: (r) => advanced.push(r),
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 1);
  const req = posts[0] as Record<string, unknown>;
  assert.equal(req.ruleId, "w1");
  assert.equal(req.workItemId, "wi_1");
  assert.equal(req.revision, 3);
  // 幂等键 `(workItemId, ruleId, revision, eventKey)`（spec §3.9）：eventKey 由**唯一构造器**给出，
  // 不得在此就地拼串——就地拼串会让重复投递的同一事实算出两个 key，去重静默失效。
  assert.match(String(req.eventKey), /^e:/);
  assert.equal(advanced.length, 1);
});

// §5.5：闸先于去重。触发被暂停时**不得**发派发请求，且必须把 pausedReason 落到规则上
// （不落盘，用户界面上就看不出「它停下来了」）。
test("被闸拦下 ⇒ 不发请求，但把 pausedReason 落到规则上", async () => {
  const posts: unknown[] = [];
  const advanced: Array<{ pausedReason?: string }> = [];
  const tick = createWakeTick({
    listReady: () => [rule({ fireCount: 9999, maxFires: 3 })],
    advance: (r: never) => advanced.push(r as never),
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 0);
  assert.equal(advanced[0]?.pausedReason, "max_fires");
});

// 同一事实重投两次只 fire 一次：第二次的 `(ruleId, revision, eventKey)` 已在去重集合里 ⇒ merged。
test("同一 eventKey 重投第二次被 merged 掉", async () => {
  const posts: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  await tick.run(2000);
  assert.equal(posts.length, 1);
});
```

```ts
// packages/desktop/test/schedulerWiring.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// recon.md F4：`schedulerModulePath` 基于 `import.meta.dirname`（desktopRuntimeEnv.ts:83），
// dev 与打包布局不同。scheduler 是 electronUtilityProcess.fork 出来的**独立入口**，
// 新逻辑若挂在 main/ 或 host/ 里（那些模块只在 dev 的相对布局下被 dev 入口加载），
// 生产包里**根本不会执行**——而且不报错。故把「唤醒 tick 必须挂在被 fork 的那个入口上」钉成断言。
test("唤醒 tick 挂在被 fork 的 scheduler 入口上", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  assert.match(entry, /createWakeTick/, "scheduler 入口必须引用并启动 createWakeTick，否则生产静默不跑");
  assert.match(entry, /wakeTick\.run\(/, "scheduler 入口必须真的调用 wakeTick.run(...)");
});

test("fork 的模块路径指向 scheduler 入口（不是别的目录）", () => {
  const env = readFileSync(join(desktopSrc, "main/desktopRuntimeEnv.ts"), "utf8");
  assert.match(env, /schedulerModulePath = join\(import\.meta\.dirname, "\.\.\/scheduler\/index\.js"\)/);
});
```

```ts
// packages/desktop/test/hostSquadDispatch.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideSquadDispatch } from "../src/host/squadDispatch.js";

const base = {
  // 门禁结论**由服务层给出**（本函数不读开关）：dispatchEnabled 是「服务层说可以派发」这一事实，
  // 名称刻意不叫 enabled —— 免得下一个人以为可以在这里自己读 appSettings。
  dispatchEnabled: true, databaseReady: true, busy: false, kind: "leader" as const,
  briefingPrompt: "P", memberPrompt: "P", worktree: undefined,
};

test("服务层说门禁关 ⇒ skip，不派发", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, dispatchEnabled: false }), {
    action: "skip", reason: "disabled_by_service",
  });
});

test("数据库未就绪 ⇒ skip", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, databaseReady: false }), {
    action: "skip", reason: "not_ready",
  });
});

// 硬约束 1：绑定会话忙 ⇒ **deferred**（等待型重投），不是失败、也不排队堆积。
test("绑定会话忙 ⇒ defer", () => {
  assert.deepEqual(decideSquadDispatch({ ...base, busy: true }), { action: "defer", reason: "bound_session_busy" });
});

test("开关开、库就绪、不忙 ⇒ dispatch 并带上 prompt", () => {
  const out = decideSquadDispatch(base);
  assert.equal(out.action, "dispatch");
  assert.ok(out.action === "dispatch" && out.prompt === "P");
});

// 队员 run 必须先开树：没有 worktree 就派发 = 队员直接改主工作区（spec §6.1 的隔离承诺落空）。
test("队员 run 缺 worktree ⇒ 响亮失败，不派发", () => {
  const out = decideSquadDispatch({ ...base, kind: "member" });
  assert.equal(out.action, "fail");
});

// 硬约束 1 的机器化守卫：小队派发这一支必须用**强探测**，
// 不得照抄 off-peak 的投影判据（残留 running 行会让派发被永久卡死）。
test("小队派发分支用的是强探测，不是 off-peak 的投影判据", () => {
  const src = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "host/index.ts"), "utf8");
  const start = src.indexOf("HostMessageTypes.SquadWake");
  assert.ok(start >= 0, "host 里没有 SquadWake 分支");
  const branch = src.slice(start, start + 6000);
  assert.match(branch, /createBoundSessionExecutingProbe/);
  assert.doesNotMatch(branch, /assertBoundSessionDispatchable/);
});

// 确认 2 的机器化守卫：**门禁的唯一读取点在服务层**。
// desktop 侧任何一处读这个字段，都意味着判据被复制成了第二份 —— 而三份判据正是
// 「改一处漏一处 ⇒ 关掉实验照旧派发」的形态。
test("desktop 侧任何文件都不读 experimentalAgentSquadsEnabled", () => {
  const desktopSrc = join(resolve(dirname(fileURLToPath(import.meta.url)), "../src"), "..", "..", "..",
    "packages", "desktop", "src");
  // 递归遍历 desktop/src，任何一个文件出现该字段即红。
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("experimentalAgentSquadsEnabled")) {
        hits.push(full);
      }
    }
  };
  walk(desktopSrc);
  assert.deepEqual(hits, [], `门禁判据只能有一处（服务层）；desktop 侧不应读取该字段：${hits.join(", ")}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/desktop/test/schedulerWakeTick.test.ts`
Run: `pnpm exec tsx --test packages/desktop/test/schedulerWiring.test.ts`
Run: `pnpm exec tsx --test packages/desktop/test/hostSquadDispatch.test.ts`
Expected: FAIL（模块 / 分支不存在）

- [ ] **Step 3: 最小实现**

1. **`scheduler/wakeTick.ts`**：`createWakeTick({ listReady, advance, postRequest, decide? })`。
   - `run(now)`：`listReady(now, WAKE_TICK_LIMIT)` → 逐条 `decideWake({ rule, manual: false, recentFireCount, chainRepeatCount: 1, hasPendingSameEvent: dedupe.has(key), allInputsFromSelf: false })`（`recentFireCount` 用本轮内存计数：本阶段不新增一小时窗口表，**注释写明这是最小实现**，P2c 换真实窗口）。
   - `decideWake` 返回 `fire` → `advance(rule, { fireCount: rule.fireCount + 1, nextFireAt: null })`（`once`：`nextFireAt=null` 即不再到点）+ `dedupe.add(key)` + `postRequest({ ruleId, workItemId, revision, eventKey: computeEventKey(rule, { source: "squad", externalId: `${rule.workItemId}:${rule.revision}:${rule.fireCount}`, eventType: rule.kind, payload: {} }) , workspacePath, workspaceIdentity })`。
     > **谁算 eventKey**：事件的**事实**（fact）在调度器侧由 `(workItemId, revision, fireCount)` 构成——它是「同一条规则的第 N 次」这一事实的规范表示；**构造本身必须调 `computeEventKey`**，不得拼串（§5.7.1）。
   - `pause` → `advance(rule, { pausedReason: decision.reason, nextFireAt: null })`，**不发请求**。
   - `skip` → 不发请求、不 advance（下一轮同一事实仍会被算成 skip，符合 §5.5 的「瞬时结论」语义）。
2. **`scheduler/index.ts`**：在既有 tick 的 `try` 块里（`:96-107` 那三条之后）追加第四条：
   ```ts
   const wakeRules = wakeRuleRepo.listReady(now, WAKE_TICK_LIMIT);
   if (wakeRules.length > 0) await wakeTick.run(now);
   ```
   `main()` 里 `requestTick()` + `pollTimer`（`:452-453`）之后加同样的一次 `requestTick` 覆盖（**不新增定时器**：唤醒规则复用同一个 20 s tick，只是多一路；新增定时器会让两路 tick 相对漂移、并让 misfire 语义出现第二套）。
   `dispose()` 里 `wakeRuleRepo.close()`（与 `repo.close()`/`offPeakRepo.close()` 并列；**注意**：它是**同一个库**的另一条连接，必须各自 close）。
3. **`schedulerProtocol.ts`**：加 `SquadWakeDispatchRequest`（scheduler → main）与 `SquadWakeDispatchResult`（main → scheduler）。**字段与 `hostSquadWakeMessageSchema` 同形**（薄消息：`ruleId` / `workItemId` / `revision` / `eventKey` / `workspacePath` / `workspaceIdentity`），**不得**在这层夹带 `agentId` / `prompt`（那等于把规划搬到调度器，见 Task 3 Step 3 第 8 条的注释）。
4. **`main/desktopCronScheduler.ts`**：照 `cron-dispatch-request` 分支（`:107-171`）再写一支，`host.postMessage({ type: HostMessageTypes.SquadWake, ... })`；`resolveDispatchHost()` 为空时回 `failureKind: "transient"`（同款退避）。
5. **`main/desktopHostProcess.ts`**：照 `:514-515` 再加 `HostResponseTypes.SquadWakeResult` 分支 → `dependencies.onSquadWakeResult?.(...)`；`desktopCronScheduler` 的 handle 加 `handleSquadWakeResult`。
6. **`shared/channels.ts` + `shared/validation.ts`**：加两个常量与两个 schema，并**把两个 schema 加进既有并集**（只加常量不加并集 ⇒ 消息在入口被 schema 丢弃，**静默**）。
7. **`host/squadDispatch.ts`**：`decideSquadDispatch` 纯函数（判定次序：`!databaseReady` → skip；`!dispatchEnabled` → skip（reason `disabled_by_service`）；`kind === "member" && !worktree` → fail；`busy` → defer；否则 dispatch）。**它不读任何设置**——`dispatchEnabled` 只是「服务层说可以」这一事实的搬运。
8. **`host/index.ts`**：新增 `HostMessageTypes.SquadWake` 分支，形状照 `CronRun` 分支（`:2452-2499`）但**多三步规划**（规划一律在 host 侧做，调度器不读小队定义）：
   - `databaseStartup?.coordinator.snapshot.phase !== "ready"` → 回 `{ ok:false, failureKind:"transient" }`（照抄既有）。
   - **门禁不在这里实现（确认 2）**：判据是**服务层单点**（`ISquadRuntimeService.assertDispatchEnabled`，Task 2）。本分支只**调它**并把结论翻成回执：
     ```ts
     // 门禁：判据在服务层单点（spec §5.7.6 的三个入口共用一处判据）。
     // 这里**不读 appSettings** —— 读一次就多一份判据，改一处漏一处，正是「关掉实验照旧派发」的形态。
     try {
       await squadRuntime.assertDispatchEnabled({ path: msg.workspacePath, identity: msg.workspaceIdentity ?? "" });
     } catch (error) {
       if (isSquadDispatchDisabledError(error)) {
         parentPort.postMessage({
           type: HostResponseTypes.SquadWakeResult,
           runId: msg.eventKey,
           ok: false,
           error: error.message,
           failureKind: "permanent", // 关闭实验是确定性状态，重试不会自愈
         });
         return;
       }
       throw error;
     }
     ```
     （`isSquadDispatchDisabledError` 按**稳定 code** `SQUAD_DISPATCH_DISABLED_CODE` 判，不按文案。`failureKind` 用 `"permanent"`：开关关着时重试不会自愈，让调度器别按 transient 退避空转。）
   - 取小队运行时：`const squadRuntime = targetServices.getOptional(ISquadRuntimeService);`，**没有就响亮失败**（`ok:false, failureKind:"permanent", error:"squad runtime service is not registered"`）——静默跳过会让用户看到「到点了但什么都没发生」。
   - **规划**（唯一一处）：按 `msg.workItemId` 查工作项（`squadRuntime` 暴露的读方法 / `getSnapshot`），解析 `assignee`；`assignee.type === "squad"` 时读小队定义，调 `planDispatch({ workItem, squad, trigger: "rule", ruleId: msg.ruleId })`。事件里 `run.enqueued` 才有 run；`inbox.notified` → 记日志 + 回 `ok:true`（**skip 不是失败**，spec §3.9 `dispatch_skipped` 不进失败率）。
   - **队员 run 先开树**：`run.isLeaderTask === false` 时先 `await squadRuntime.openMemberRun({ runId, workItemId, parentWorkItemId, agentId: run.agentId, isLeaderTask: false })`，用返回的 `worktreePath` 作为**会话的 workspacePath**（**隔离承诺的落点**：队员在独立工作树里干活，`spec §6.1`）。开树失败 → `failureKind: "permanent"`（不是 transient：重试会撞「分支已存在」，属确定性失败）。
   - **决策**：`decideSquadDispatch({ dispatchEnabled, databaseReady: true, busy, kind, briefingPrompt, memberPrompt, worktree })`（`dispatchEnabled` 来自上面那次**服务层门禁调用**的结论；`databaseReady` 已在上面判过，此处传 `true` 只是让纯函数自洽可测）。
   - 忙检查**强探测**（硬约束 1）：有 `targetTaskId` 时：
     ```ts
     const agentService = targetServices.getOptional(IZCodeAgentService);
     if (agentService) {
       const executing = await createBoundSessionExecutingProbe({
         agentService,
         logWarn: (message, error) => logger.warn(message, error),
       })({ sessionId: request.targetTaskId, workspacePath: request.workspacePath, ... });
       if (executing) throw new BoundSessionBusyError(request.targetTaskId);
     }
     ```
     抛错在分支里被翻译成 `failureKind: "deferred"`（照 `:2483` 的既有写法）。
   - `createTask` / `resumeTask` / `sendPrompt`：`prompt` = 队长 run 用 `renderLeaderBriefingPrompt(run.briefing)`，队员 run 用工作项标题 + 正文（+ 一句「你的工作树是独立的，完成后请把结论汇报到工作项」）。
   - 落台账：队长 run 也写一条 `squad_runs`（`is_leader_task=1`、`branch=null`、`dir_name=null`、`status="open"`）——`getSnapshot().runs` 靠它显示「谁在被唤醒」；`runId` 用 `msg.eventKey`（幂等键的稳定一半，重投不会生成第二条 run）。
   - 完成通知（gap #11，best-effort）：照 `watchCronRunBotDelivery`（`host/index.ts:963`）的形状，失败只 `warn`，**不得**阻断派发。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/desktop/test/schedulerWakeTick.test.ts`
Run: `pnpm exec tsx --test packages/desktop/test/schedulerWiring.test.ts`
Run: `pnpm exec tsx --test packages/desktop/test/hostSquadDispatch.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §5.5 / §5.7 / §5.7.1 / §5.7.6 / §6.1 / §12；recon.md A1 A2 A3、B4 B5、F4、缺口 #6 #7 #11）：

- recon.md 缺口 #6「把 `WakeRuleRepo.listReady` 接进调度器 tick」是否真接上，且**复用同一个 20 s tick**（没有新增第二套定时器）？
- recon.md 缺口 #7 的派发桥是否复用 `createTask`/`resumeTask` + `sendPrompt` 最小路径（不另造一套会话创建）？
- 硬约束 1：忙检查**是否**用的是 `createBoundSessionExecutingProbe`？有没有第二条弱路径混进来？
- §5.7.6 / 确认 2：本分支是否**只调服务层门禁、不自己读开关**？是否没有任何一处去 `closeTask`/`cancel`（在途 run 不中断）？`failureKind` 是否用了 `"permanent"`（关闭是确定性状态，不该按 transient 空转退避）？
- §5.5 的判定次序是否**由 `decideWake` 唯一决定**（本层没有自己再判一遍闸）？
- §5.7.1：`eventKey` 是否**只**由 `computeEventKey` 产出（全文 grep 无第二处拼串）？
- recon.md F4 的 dev/prod 检查是否**由测试承重**（不是注释承诺）？
- gap #11 的通知是否 best-effort（失败不阻断派发）？

**② 穷举**（先列全集，再逐格给结论）：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| tick 决策 | fire / skip(merged) / skip(acknowledged) / pause(max_fires) / pause(rate) / pause(loop) | |
| 规则 kind | event / at / every / cron | |
| 规则 mode | once（fire 后 `nextFireAt=null`）/ continuous（推进 `nextFireAt`） | |
| `listReady` 结果 | 空 / 1 条 / 超过 limit | |
| 派发入口 | 库未就绪 / 无可用 host / host 转发失败 / 门禁关闭 / 运行时未注册 | |
| 会话路径 | 无 `targetTaskId`（新建）/ 有（resume）/ resume 失败 | |
| 忙检查 | 不忙 / 忙（强探测）/ 探测抛错（`runtimePolicy:"existing-only"` ⇒ 判不忙） | |
| run 类型 | 队长（无工作树）/ 队员（必须先开树）/ 队员开树失败 | |
| 消息面 | schema 进了并集 / 常量加了但没进并集（**必须能咬红**） | |
| 模块挂点 | 挂在 `scheduler/index.ts`（对）/ 挂在 `main/`（错，测试须咬红） | |

逐格写「有测试 / 由类型或代码保证（哪一行）/ 不适用 + 理由」。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/scheduler packages/desktop/src/main/desktopCronScheduler.ts \
        packages/desktop/src/main/desktopHostProcess.ts packages/desktop/src/host/squadDispatch.ts \
        packages/desktop/src/host/index.ts packages/shared/src/channels.ts packages/shared/src/validation.ts \
        packages/desktop/test/schedulerWakeTick.test.ts packages/desktop/test/schedulerWiring.test.ts \
        packages/desktop/test/hostSquadDispatch.test.ts
git commit -m "feat(squad): 唤醒调度 tick + 派发桥（强忙探测 + 三段简报 + 服务层门禁调用）"
```

---

### Task 4（B｜工作树编排与产物卫生）（Wave 1，与 A / C / D 并行）

> 工作树：`.worktrees/p2b-orchestrator`，分支 `feat/p2b-orchestrator`。从 `feat/p2b-spine` 顶端起。
> 本任务含**两个前置修正**（B‑0、B‑1）与**主体**（B‑2）。**B‑0 必须先做**：它修正 P2a 遗留的回收器语义，Wave 2 的启动回收会直接吃它的行为。

**Owns:** `packages/services/src/workitem/squadOrchestrator.ts`（新）、`packages/services/src/worktree/orphanReaper.ts`（**改**）、`packages/services/src/worktree/orphanReaper.test.ts`（**改**）、`packages/services/src/file/workspaceFileIgnore.ts`（改）、`packages/services/test/squadOrchestrator.batch.test.ts`（新）、`packages/services/test/workspaceFileIgnoreProductDirs.test.ts`（新）

**Must not touch:** `packages/services/src/node.ts`（**Wave 0 拥有**；本任务的装配由 Wave 2 收口）、`packages/desktop/**`、`packages/ui/**`、`packages/services/src/workitem/{squadRuntime,squadRunLifecycle,leaderDispatch}.ts` 的**签名**（只消费）、`packages/services/src/workspaceProductDirs.ts` 之外的 C10 相关常量（**不新增第三份清单**）

**Files:**

- Create: `packages/services/src/workitem/squadOrchestrator.ts`
- Modify: `packages/services/src/worktree/orphanReaper.ts`、`packages/services/src/worktree/orphanReaper.test.ts`
- Modify: `packages/services/src/file/workspaceFileIgnore.ts`
- Test: `packages/services/test/squadOrchestrator.batch.test.ts`、`packages/services/test/workspaceFileIgnoreProductDirs.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `SquadRuntime` / `SquadBatchOrchestrator`（类型）/ `SquadRunLifecycle`；P2a 的 `createIntegrationMerger`（含 `finalize` / `discardIntegration` / `discardMember`）、`MEMBER_NAMESPACE` / `INTEGRATION_NAMESPACE`（`branchNaming.ts:17,19`）、`ReapOutcome`（`orphanReaper.ts:23`）；`WORKSPACE_PRODUCT_DIRS`（`workspaceProductDirs.ts`）
- Produces:
  - `createSquadOrchestrator(deps: { runtime: SquadRuntime }): SquadBatchOrchestrator`
  - `ReapOutcome` 的 `kept`（**语义扩展，见 B‑0**）：除「活跃」与「集成分支」外，**再加一类**「在 `.worktree/` 下、但分支不属于小队命名空间」的项——不碰、不静默。
  - `SQUAD_PRODUCT_DIR_EXCLUSIONS` 并入 `BUILTIN_IGNORE_LINES`（`workspaceFileIgnore.ts:47`）后的可断言事实

#### B‑0｜回收器两遍都按小队命名空间限域（**前置修正，必须先做**）

**为什么**（本轮新增的第四条硬约束，理由与目录布局无关）：

`orphanReaper` 现在的归属判据是**路径代理** —— `dirname(entry.path) === resolveWorktreeRoot(repoRoot)`（`orphanReaper.ts:154-170`），外加集成分支特判。但「**放在我们的目录里**」不等于「**属于我们**」：任何**非小队命名空间**的工作树只要落到 `.worktree/` 下（用户自己 `git worktree add`、将来别的功能复用该目录、或开发工作树被误放进去），第一遍就会把它**连树带枝回收掉**，因为判据「分支不在 `activeBranches`」对它**恒为真**（`activeBranches` 是产品运行台账，外围分支永远不在里面），而且**回收过程不报错**。

**正确判据 = 分支是否属于小队命名空间**：第一遍只回收 `squad/member/**`（`MEMBER_NAMESPACE`，`branchNaming.ts:19`）的工作树；集成分支（`INTEGRATION_NAMESPACE`，`:17`）仍保护不删；**命名空间外的一律不得碰，且必须可报告**（归入 `kept`，`ReapOutcome.kept` 的既有语义就是「本流程看见了、但决定原样不动」——**这不是静默**：它在返回结构里可见）。

**这条修正了 P2a 的既有语义**：P2a 只给第一遍补了 `INTEGRATION_NAMESPACE` 保护（把「在我们的目录里」当成了「属于我们」），注释与测试只覆盖这一个前缀。**允许并且要求改动 `orphanReaper.ts` 及其测试**，并在 `reap` 的 doc 注释里写清这条不变式：**两遍都按命名空间限域**，而不是「第二遍限域、第一遍只保护一个前缀」。

- [ ] **Step B‑0.1: 写失败测试**（追加到 `packages/services/test/...`；因 `orphanReaper.test.ts` 是它的既有测试文件，**就地追加**）

```ts
// 【必须补】非小队命名空间的工作树落在 .worktree/ 下：树在、分支在，且不进 reclaimed / reclaimedBranches。
// 真实成因：用户自己 `git worktree add .worktree/x feat/dev-sandbox`，或开发工作树被误放进去。
// 第一遍若按路径判归属，它的分支永远不在 activeBranches 里 ⇒ 判据恒为真 ⇒ 被静默吃掉。
test("命名空间外的工作树不被回收，但可见（进 kept）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  const m = createWorktreeManager({ git, repoRoot: root });
  // 用户自己的分支（非 squad/ 命名空间）挂在我们的目录下
  await git(["branch", "feat/dev-sandbox", "main"]);
  await m.add({ branch: "feat/dev-sandbox", base: "main", dirName: "dev-sandbox" });
  const out = await createOrphanReaper({
    manager: m,
    repoRoot: root,
    deleteBranch: (b) => deleteBranch(git, root, b),
    listBranches: (p) => listBranches(git, p),
  }).reap({ activeBranches: [] });

  assert.deepEqual(out.reclaimed, []);
  assert.deepEqual(out.reclaimedBranches, []);
  assert.ok(out.kept.includes("dev-sandbox"));
  // 实体状态：树与分支都还在（断言返回值不够——实现可能嘴上说 kept 手上却删了）
  assert.ok((await m.list()).some((e) => e.branch === "feat/dev-sandbox"));
  assert.equal((await git(["branch", "--list", "feat/dev-sandbox"])).stdout.trim(), "feat/dev-sandbox");
});
```

- [ ] **Step B‑0.2: 跑红**

Run: `pnpm exec tsx --test packages/services/test/orphanReaper.test.ts`
Expected: FAIL（当前第一遍会把它当孤儿收掉：`reclaimed` 非空、`kept` 不含它、分支消失）

- [ ] **Step B‑0.3: 最小实现**

在 `reap` 的第一遍里，把「归属」之外**再加一道命名空间闸**（顺序：先判不属于本根 → `foreign`；再判分支非小队命名空间 → `kept`；再判集成分支 → `kept`；剩下才是候选孤儿）：

```ts
      // 第二道闸：**分支不属于小队命名空间**的一律不动，计入 `kept`。
      // 为什么不能只看「在不在我们的目录里」：那是**路径代理**，而 activeBranches 是产品运行台账，
      // 任何非小队工作树的分支都不在里面 ⇒ 那条判据对它们恒为真、把它们全部当孤儿。
      // 用户自己 `git worktree add`、将来别的功能复用 .worktree/，都会撞上这一格。
      // `entry.branch === null`（detached）同样**不碰**：没有分支就无法证明它属于我们。
      if (entry.branch === null || !entry.branch.startsWith(MEMBER_NAMESPACE)) {
        kept.push(dirName);
        continue;
      }
```

并把 `ReapOutcome.kept` 的 doc 注释扩一类（第三类来源：**命名空间外的分支**），说明这是**可见的跳过**而不是静默。

**并且必须把这条不变式本身写进源码注释**（只改行为不够——行为会被下一个作者照自己的理解改回去，不变式写在注释里才拦得住）：在 `reap` 的 doc 注释里逐字声明：

```ts
/**
 * ——回收器的归属不变式（2026-10-01 修正，P2a 遗留语义）——
 *
 * **归属判据 = 分支命名空间，不是路径。**
 * `dirname(path) === <repoRoot>/.worktree` 只说明「**放在我们的目录里**」，
 * **不说明**「**属于我们**」：用户在同一个目录里放过自己的工作树（`git worktree add`）、
 * 或将来别的功能复用该目录，都会落进这个判据里，而它们的判据「分支不在 `activeBranches`」
 * **恒为真**（`activeBranches` 是产品运行台账，外围分支永远不在里面）⇒ 会被当成孤儿收掉。
 * 故本模块**两遍都按 `MEMBER_NAMESPACE` 限域**，集成分支仍保护不删，**命名空间外的一律不碰**，
 * 且必须落进 `kept` / `foreign` 可报告通道（**不得静默**）。
 * 任何把「在不在我们的目录里」当成「属不属于我们」的改写都是回归。
 */
```

- [ ] **Step B‑0.4: 跑绿**

Run: `pnpm exec tsx --test packages/services/test/orphanReaper.test.ts`
Expected: PASS（既有 23 条 + 新 1 条）

- [ ] **Step B‑0.5: 变异验证（必须做，并把结果写进提交信息）**

删掉那道命名空间闸（改回只判「在不在本根 + 集成分支」）⇒ **上面那条用例必须变红**，其余用例仍绿。验证后 `git checkout --` 还原，并 `sha256sum` 确认与基线逐字节一致。

- [ ] **Step B‑0.6: 审查（逆推 + 穷举）**

**① 逆推**（spec §6.2 / §6.4 / §6.6 / §17 表）：

- 「已合并 / 已放弃」是否仍是**唯一**的回收对象（活跃集合外的**小队**分支）？
- 集成分支的保护是否**仍在**、且与命名空间闸**不互相遮蔽**（集成分支不在 `MEMBER_NAMESPACE` 里，必须先被命名空间闸挡住 ⇒ 两者都要有测试）？
- 是否**两遍都**限域（第二遍的 `listBranches(MEMBER_NAMESPACE)` 未变）？
- 是否有任何一格会**静默**（不碰但也不报告）？

**② 穷举**：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| 工作树位置 | 本根下 / 本根外 | |
| 分支前缀 | `squad/member/` / `squad/integration/` / 别的（`feat/*`、`main`）/ `null`（detached） | |
| 活跃集合 | 含它 / 不含它 | |
| 组合 | 位置 × 前缀 × 活跃 = 全排列 | |
| 报告通道 | `reclaimed` / `kept` / `foreign` / `reclaimedBranches` —— **每一项都必须落进恰好一个桶** | |

逐格写结论。**空缺先补。**

#### B‑1｜C10 清单并入 `BUILTIN_IGNORE_LINES`（**硬约束 3 的落点**）

**决策（本计划显式承接，不再留给报告）**：**把 C10 清单并入 `BUILTIN_IGNORE_LINES`**（`packages/services/src/file/workspaceFileIgnore.ts:47`）。

**为什么选它，而不是另设程序化排除**：recon.md 与 P2a 复审已证：workspace 侧排除的**另一半**（`.zcodeignore` 模板）依赖「workspace 首次搜索时按 `.gitignore` 拷贝生成」，于是**无 `.gitignore` 的 workspace** 与**已有旧 `.zcodeignore` 的 workspace** 都拿不到 C10 那几条——而这两类恰恰是最常见的。`BUILTIN_IGNORE_LINES` 是**唯一不依赖 workspace 状态**的那半边（它只在「从零创建」时被写入），把清单放进去，这两类 workspace 才第一次真正被排除。P0 曾裁定「不动它」，但那是在**不知道它是不依赖 workspace 状态的唯一可靠半边**时做的；spec §17 已写明该裁定**需重判**（`spec:675`）。

**范围纪律**：**唯一来源仍是 `WORKSPACE_PRODUCT_DIRS`**（`workspaceProductDirs.ts`）。`BUILTIN_IGNORE_LINES` **从它派生**（不新增第三份硬编码清单）——C10 的「集中一处维护」在代码侧有唯一出处，`.gitignore` 与 `.zcodeignore` 两半各自**派生**或由测试逐条锁定。

- [ ] **Step B‑1.1: 写失败测试**

```ts
// packages/services/test/workspaceFileIgnoreProductDirs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_PRODUCT_DIRS } from "../src/workspaceProductDirs.js";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/file/workspaceFileIgnore.ts"),
  "utf8",
);

// 硬约束 3 的落点：C10 清单必须进「不依赖 workspace 状态」的那半边。
// 只改 .gitignore 的那半对**任意用户 workspace** 无效（无 .gitignore / 已有旧 .zcodeignore
// 的两类 workspace 都拿不到），于是 .worktree/ 里的 N 份仓库副本被索引吃进、manifestHash 漂移，**不报错**。
test("BUILTIN_IGNORE_LINES 从 WORKSPACE_PRODUCT_DIRS 派生（不新增第三份清单）", () => {
  assert.match(src, /WORKSPACE_PRODUCT_DIRS/, "BUILTIN_IGNORE_LINES 必须从唯一来源派生");
  // 逐条断言：清单里每一条的顶层名都必须出现在内置模板里
  for (const dir of WORKSPACE_PRODUCT_DIRS) {
    const top = dir.split("/")[0]!;
    assert.ok(src.includes(top), `BUILTIN_IGNORE_LINES 缺少清单项：${dir}`);
  }
});

// 反向：模板里不得再出现一份手写的 C10 清单（否则「新增一条要改 2–3 处」的老问题回来了）
test("内置模板里没有手写的 .worktree/.zcode 字面量", () => {
  assert.doesNotMatch(src, /"\.worktree\/"/);
  assert.doesNotMatch(src, /"\.zcode\//);
});
```

- [ ] **Step B‑1.2: 跑红 / B‑1.3: 最小实现 / B‑1.4: 跑绿**

实现：`workspaceFileIgnore.ts` 里 `import { WORKSPACE_PRODUCT_TOP_LEVEL_NAMES } from "../workspaceProductDirs.js";`，`BUILTIN_IGNORE_LINES` 改为「既有数组 + 由 `WORKSPACE_PRODUCT_TOP_LEVEL_NAMES` 派生的条目（每个顶层名写成 `<name>/`）」，并加注释写明「这一半是**不依赖 workspace 状态**的可靠半边，故 C10 清单必须在这里也出现；来源仍是 `WORKSPACE_PRODUCT_DIRS`」。

Run: `pnpm exec tsx --test packages/services/test/workspaceFileIgnoreProductDirs.test.ts`
Run: `pnpm exec tsx --test packages/services/test/workspaceProductDirExclusions.test.ts`（P2a 既有的一致性测试必须仍绿）

#### B‑2｜批次编排（主体）

**为什么需要这一层**（而不是把逻辑塞进 Wave 0 的机械半）：spec 的语义几乎**全在批次层**——§5.7.3「子项**全部** category ∈ {done, closed} 才触发」、§5.7.4「**串行**合并 / 整批通过才合回主分支 / 冲突解不了 → `blocked` + 进 Inbox」、§6.2「审查未通过前工作树**存活**」、§6.3「合并后分支删（队员与集成**都**删）」。它们要同时读工作项状态与 run 台账，属**策略**而不属机械。

- [ ] **Step B‑2.1: 写失败测试**（真实临时 git 仓库）

```ts
// packages/services/test/squadOrchestrator.batch.test.ts
test("子项未全部终态 ⇒ 不 finalize（不做半批合并）", async () => { /* … */ });

// §5.7.3 的判据是 **category**，不是键名：`cancelled` 是 closed 类，与 done 一样算终态。
test("cancelled 子项也算终态（用 category 判定）", async () => { /* … */ });

// §5.7.4 / §16 S17：集成分支冲突 ⇒ 不得提前合回主分支，且父项置 blocked + 进 Inbox。
test("冲突 ⇒ 父项 blocked、集成分支保留、主分支不动", async () => { /* … */ });

// §6.3：整批通过后，**队员分支与集成分支都删**，成果留在 base 上。
test("整批通过 ⇒ finalize 后两条分支都不存在，成果在 base", async () => { /* … */ });

// spec §16 S5：被打回待修的工作树在 batch 收尾时**也不得**被删（它还没合）。
test("被打回待修的队员不进 finalize 的抛弃集合", async () => { /* … */ });

// §6.2：串行合并 —— 两个队员**先后**合，第二个能看见第一个的成果（不是各自从 base 重放）。
test("串行合并：第二个队员的合并基于第一个的成果", async () => { /* … */ });
```

- [ ] **Step B‑2.2 / B‑2.3 / B‑2.4**

实现 `createSquadOrchestrator({ runtime })`：

- `advanceAfterChildrenDone({ workspaceKey, parentWorkItemId })`：
  1. `runtime.workItemRepo.areAllChildrenTerminal(parentWorkItemId)` 为假 → **直接返回**（不做半批）；
  2. 取该父项下 `squadRunRepo.listByParent(parentWorkItemId)`，按 `createdAt` **排序**后**串行** `reviewMemberRun` 式的合并（已 `merged` 的跳过）；
  3. 任一次返回 `{ok:false, reason:"conflict"}` → `workItemService.transition(parent, "blocked", expect)`（CAS）+ 发 Inbox 通知事件 + **立即停手**（后面的成员不再合，主分支一个字节不动）；
  4. 全通过 → `integrationMerger.finalize({ integration, target: baseBranch })`；`ok` → 逐个 `discardMemberRun`（**只抛弃已 merged 的**）→ `discardIntegration` → `transition(parent, "done", "in_review")`。
- `discardBatch({ workspaceKey, parentWorkItemId })`：整批放弃（用户取消）→ 逐个 `discardMemberRun`（含 `rejected`/`produced`）→ `discardIntegration` → `transition(parent, "cancelled", expect)`。

> **串行是调用方约束**（`integrationMerge.ts` 的 doc 注释已写明本模块不做锁）：`advanceAfterChildrenDone` **不得**被并发调用；用 `runtime` 里的一个内存串行队列（`Map<parentWorkItemId, Promise>`）兜住，并把「本层不做跨进程锁」写进注释。

- [ ] **Step B‑2.5: 审查（逆推 + 穷举）**

**① 逆推**（spec §5.7.3 / §5.7.4 / §6.2 / §6.3 / §16 S4 S5 S17）：

- 终态判定是否用 **category**（`areAllChildrenTerminal`），不是键名比较？
- 冲突路径是否**三件事都做**：父项 `blocked`（CAS 写）、进 Inbox、**主分支不动**？
- 整批通过后**两条分支都删**（`discardMemberRun` + `discardIntegration`）且成果留在 base？
- 被打回待修的队员是否**不在**抛弃集合里（S5）？
- 并行/串行：同一父项的两次 `advanceAfterChildrenDone` 会不会互相踩？本层的兜底是什么、注释是否写明「跨进程不做锁」？
- 父项 `transition` 的**期望前置状态**（CAS）是否正确（未命中时丢弃但不报错，spec §5.7.5）？

**② 穷举**：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| 子项状态组合 | 全 done / 全 cancelled / mixed done+cancelled / 含 in_review / 含 blocked / 无子项 | |
| 队员 run 状态 | 全 merged / 部分 merged / 含 rejected（被打回）/ 含 produced（没审） | |
| 合并结果 | 全成功 / 第 1 个就冲突 / 第 2 个冲突（第 1 个的成果是否**已保留**在集成分支） | |
| finalize | 成功 / 冲突 / base 分支不存在 | |
| 抛弃 | 已 merged（可抛）/ rejected（**batch 放弃时才抛**）/ 树已不存在 | |
| 并发 | 同父项两次调用 / 不同父项并行 | |

逐格写结论。**空缺先补。**

- [ ] **Step B‑0/B‑1/B‑2 提交**

```bash
git add packages/services/src/worktree/orphanReaper.ts \
        packages/services/src/worktree/orphanReaper.test.ts \
        packages/services/src/file/workspaceFileIgnore.ts \
        packages/services/src/workitem/squadOrchestrator.ts \
        packages/services/test/squadOrchestrator.batch.test.ts \
        packages/services/test/workspaceFileIgnoreProductDirs.test.ts
git commit -m "feat(squad): 回收器两遍按命名空间限域 + C10 清单并入内置模板 + 批次编排（串行/冲突→blocked/整批抛弃）"
```

---

### Task 5（C｜最小入口 UI）（Wave 1，与 A / B / D 并行）

> 工作树：`.worktrees/p2b-entry`，分支 `feat/p2b-entry`。从 `feat/p2b-spine` 顶端起。

**Owns:** `packages/ui/src/settings/ExperimentsSection.tsx`、`packages/ui/src/settings/squadEntry/**`（新目录）、`packages/ui/src/i18n/locales/zh-CN.ts`、`packages/ui/src/i18n/locales/en-US.ts`、`packages/ui/test/experimentsSquadEntry.test.ts`（新）

**Must not touch:** `packages/services/**`、`packages/desktop/**`、`packages/ui/src/SettingsPage.tsx` 的分区**注册机制**（`settingsNavigation.ts` / `settingsPageConfig.ts` 的 `experiments` 条目已存在，**不需要**新增分区）

**Files:**

- Create: `packages/ui/src/settings/squadEntry/SquadMinimalView.tsx`、`packages/ui/src/settings/squadEntry/squadEntryVisibility.ts`
- Modify: `packages/ui/src/settings/ExperimentsSection.tsx`（开关下方挂最小视图）
- Modify: `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`（新增文案，两语齐全）
- Test: `packages/ui/test/experimentsSquadEntry.test.ts`

**Interfaces:**

- Consumes: Wave 0 的 `ISquadRuntimeService`（descriptor 类型 + `SquadSnapshot` + `SquadWorkspaceTarget`），经 `useServices().get(ISquadRuntimeService)` 取（既有 `IServiceAccessor` 机制：`packages/services/src/accessor.ts:46`、`packages/ui/src/hooks/useServices.tsx`；服务由 `ServiceCollection.register` 自动经 `ProxyChannel` 暴露，`packages/services/src/collection.ts:37-43`）。**每个调用都要带上当前 workspace 的 `SquadWorkspaceTarget`**（确认 3：runtime 按目标现构）；目标取自 UI 已有的 active workspace（不得在这里自己挑一个）
- Produces: 无后端产出（**确认 2**：门禁在服务层单点，UI 只做呈现）。UI 侧只产出 `squadEntryVisible` 与文案

- [ ] **Step 1: 写失败测试**

```ts
// packages/ui/test/experimentsSquadEntry.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { squadEntryVisible } from "../src/settings/squadEntry/squadEntryVisibility.js";

// spec §5.7.6 / §16 S8：关闭实验 ⇒ 入口**整体消失**（不是灰掉、不是报错页）。
test("开关关闭时入口不可见", () => {
  assert.equal(squadEntryVisible({ experimentalAgentSquadsEnabled: false }), false);
  assert.equal(squadEntryVisible({}), false);
  assert.equal(squadEntryVisible(null), false);
});

test("开关打开时入口可见", () => {
  assert.equal(squadEntryVisible({ experimentalAgentSquadsEnabled: true }), true);
});

// spec §11.4：所有新文案必须两语齐全，只写一种语言时另一种语言直接显示裸 key。
test("最小视图文案两语齐全", () => {
  for (const key of [
    "settings.experiments.squad.viewTitle",
    "settings.experiments.squad.teamAgents",
    "settings.experiments.squad.squads",
    "settings.experiments.squad.workItems",
    "settings.experiments.squad.createTeamAgent",
    "settings.experiments.squad.createSquad",
    "settings.experiments.squad.createWorkItem",
    "settings.experiments.squad.review.approve",
    "settings.experiments.squad.review.reject",
    "settings.experiments.squad.loopHint",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/experimentsSquadEntry.test.ts`
Expected: FAIL（模块 / 文案不存在）

- [ ] **Step 3: 最小实现**

1. `squadEntryVisibility.ts`：纯函数 `squadEntryVisible(settings: Pick<AppSettings, "experimentalAgentSquadsEnabled"> | null | undefined): boolean`。
2. `SquadMinimalView.tsx`：一个 `SettingsGroupCard` + 三个 `SettingsRow`/列表（协作智能体 / 小队 / 工作项），数据来自 `useServices().get(ISquadRuntimeService).getSnapshot()`；三个「新建」入口用 `Dialog` 范式（照 `packages/ui/src/BotsDialog.tsx`）；每个 `run` 行给「通过 / 打回」两个按钮 → `reviewMemberRun`。
   - **设计系统约束**（spec §11.3）：字号只用 `text-ui-*`；圆角按容器层级（首个圆角容器 `rounded-xl`，对话框 `rounded-2xl`）；语义色 token，不写原生色值；复用 `packages/ui/src/components/ui/` 现有原语。
   - **尺寸**：`getSnapshot()` 结果全量渲染即可（P2c 才做虚拟化），但**必须**在注释里写「本阶段不分页」的取舍。
3. `ExperimentsSection.tsx`：`<SettingsGroupCard>` 之后加 `{squadEntryVisible(settings) ? <SquadMinimalView /> : null}`。
4. **闭环提示**：`loopHint` 文案要**如实**说明本阶段的操作路径（建队长 agent + 队员 agent → 建小队 → 建父项指派小队 → 队长被唤醒并**用工具自己**建子项 / 派给队员（Wave 1 D）→ 每个队员开自己的工作树 → 通过 / 打回 → 整批合并后抛弃），并注明**「汇报 / 请求审查」两个工具与审查 agent 在 P2c**（与「已知代价」一节一致，**不得**让 UI 许诺本阶段做不到的事）。
5. **本任务不做后端门禁**（确认 2：判据是**服务层单点** `ISquadRuntimeService.assertDispatchEnabled`，Task 2）。**C 只做呈现**：开关关闭时**隐藏 / 不可用入口**（`squadEntryVisible`），**不产出任何后端 patch 文本**。UI 的隐藏**不是**门禁——服务层会独立拦下界面触发（`createWorkItem` 入口过门禁）与规则 tick，两者是两件事、**不要互相依赖**。
   > **C 读 `experimentalAgentSquadsEnabled` 是合法的**（它只用于显隐）；不合法的只有「读了它去决定**要不要派发**」。这一条与 Task 3 的静态守卫（`packages/desktop/src/**` 不得出现该字段）不冲突：`packages/ui/**` 不在那个守卫的扫描范围内。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/experimentsSquadEntry.test.ts`
Run: `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsExperimentsSection.test.ts`（P0 既有测试必须仍绿）
Expected: 全 PASS

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §11.1 / §11.3 / §11.4 / §12 / §16 S8 S9 / §5.7.6）：

- §12 / §16 S8：关闭实验时入口是否**整体消失**（不是置灰、不是报错），且**不影响**现有 subagent / automation 的任何界面？
- §16 S9 / 决策 C8：本视图是否**不参与远程投射**（**不得**把 squad 设置加进 `isProjectableSetting`，`packages/ui/src/lib/remoteDeviceSettings.ts:41` 的 `/^experimental/i` 拦截**必须保持**）？
- §11.3：字号 / 圆角 / 语义色三条是否守住（不得出现 `text-sm`、原生 `#hex`）？
- §11.4：文案是否**两语齐全**、布局**不依赖截断**？
- **本任务不做后端门禁**（裁定 2：门禁整条属 Task 3 A）。确认本任务**没有**触碰 `packages/desktop/**` 或 `packages/services/**`；确认 UI 的隐藏**不被**当成安全边界（spec §5.7.6 要求的是停止新派发，由 A 在 host 落）。

**② 穷举**：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| 开关 | 未设置 / false / true | |
| `settings` 快照 | `null`（加载中）/ `{}` / 完整 | |
| 数据面 | 无小队 / 无工作项 / 都有 / 只有 run | |
| 审查动作 | approve（成功）/ approve（冲突）/ reject / 网络失败 | |
| 关闭实验 | 视图消失 / 后端拒绝新派发 / **进行中的 run 不中断** | |
| 投射 | 远程设备投射开启时本视图不出现 | |
| i18n | zh-CN / en-US 两语齐全 / 长文案不截断 | |

逐格写结论。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src/settings/ExperimentsSection.tsx packages/ui/src/settings/squadEntry \
        packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts \
        packages/ui/test/experimentsSquadEntry.test.ts
git commit -m "feat(squad): 实验分区最小入口视图（三段闭环 + 审查按钮 + 两语文案）"
```

---

### Task 6（D｜队长派单工具集）（Wave 1，与 A / B / C 并行）

> 工作树：`.worktrees/p2b-tools`，分支 `feat/p2b-tools`。从 `feat/p2b-spine` 顶端起。
> **为什么必须有这一路**：闭环里「队长被唤醒**派单**」不能是操作员代劳——队长被唤醒后若不能自己建子项 / 派给队员，后面「队员各开工作树 → 审查 → 合并 → 抛弃」**根本不会发生**，闭环演示就断了。本任务交付 spec §14 的**「建子工作项」**与**「派给队员」**两个工具（最小形态）。

**Owns:** `packages/contracts/src/**`（两个工具 input/output schema + `SquadPort` 类型）、`packages/shared/src/zcode-protocol/**`（新 method 常量与结果 schema）、`apps/zcode-cli/packages/core/src/{tool/**,runtime/**,runtime.ts}`（handler、`ToolExecutionContext.squadPort`、工具可见性门控、executor 透传）、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{squad-port.ts, server-operations.ts}`、`apps/zcode-cli/packages/core/test/squadTools.test.ts`（**新建测试目录**）、`packages/desktop/src/host/squadProtocolMethods.ts`（**仅当** Step 0 判定需要，独立新文件）

**Must not touch:** `packages/services/**`（**尤其 `node.ts`**）、`packages/ui/**`、`packages/desktop/src/scheduler/**`、`packages/desktop/src/host/index.ts`（**A 的文件；注册行由 Wave 2 追加**）、`packages/desktop/src/main/**`

**Files:**

- Modify: `packages/contracts/src/**`（新工具 schema + `SquadPort`）
- Modify: `packages/shared/src/zcode-protocol/index.ts`（`zcodeProtocolMethods` 加两项 + 结果 schema）
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/squad.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/{types.ts,handlers/index.ts}`、`apps/zcode-cli/packages/core/src/runtime/{types.ts,helpers/runtime-tools.ts}`、`apps/zcode-cli/packages/core/src/tool/executor/{impl.ts,call-runner.ts,types.ts}`
- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/squad-port.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`（注入点，照 `:3378` 的 `automationPort` 位置）
- Create（**仅当 Step 0 判定需要**）: `packages/desktop/src/host/squadProtocolMethods.ts`
- Test: `apps/zcode-cli/packages/core/test/squadTools.test.ts`

**Interfaces:**

- Consumes（**已查明的既有先例，照它做，不要另发明通道**）：
  - 工具从 `ToolExecutionContext` 取 port：`apps/zcode-cli/packages/core/src/tool/types.ts:168`（`automationPort?: AutomationPort`）
  - port 类型定义在 `@zcode/contracts`；缺 port 时**响亮抛**：`apps/zcode-cli/packages/core/src/tool/handlers/cron.ts` 的 `assertAutomationPort`（`ConfigurationError`）
  - port 的**实现**在 bootstrap，经 `context.requestClient(zcodeProtocolMethods.<method>, …)` 变成 **CLI → Host 的 JSON-RPC 反向请求**：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts`（`createProtocolAutomationPort`）
  - **方法名常量**：`packages/shared/src/zcode-protocol/index.ts:3644`（`automationCreate: "automation/create"`）
  - **注入点**：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:3378`
  - **工具可见性门控**：`apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts:67`（`includeAutomation: Boolean(deps.automationPort) && …`）——**没有 port 就不注册工具**，同时 handler 里再兜一次（两道，见 `cron.ts`）
  - **executor 透传**：`apps/zcode-cli/packages/core/src/tool/executor/impl.ts:52`、`call-runner.ts:410`、`executor/types.ts:107,213`
  - host 侧 runtime 装配点：`apps/zcode-cli/packages/bootstrap/src/app/{create-app.ts:775,types.ts:182}`
- Produces:
  - `@zcode/contracts`：`SquadPort`（**只有三件事**：`createChildWorkItem` / `assignWorkItem` / `listRoster` 式只读），以及两个工具的 input/output zod schema（含 JSON schema）
  - 两个工具名（**不与既有工具重名**，§14）：`SquadCreateChildWorkItem`、`SquadAssignWorkItem`
  - `zcodeProtocolMethods.squadCreateChildWorkItem` / `zcodeProtocolMethods.squadAssignWorkItem`
  - **不变式**：`SquadPort` **不得暴露任何写工作项状态的方法**（无 `transition` / `setStatus` / `updateStatus`）——唯一写者仍是 `workItemService`（P0/P1 裁定）

- [ ] **Step 0: 侦察（必须先做；**先读、再写码；结论写进任务报告**）**

**已经查明的事实**（上面 Consumes 里逐条带 `file:line`，照它做）：

1. 通路**存在**，形态是 **Port 注入**：core handler 取 `context.<port>` → 缺 port 抛 `ConfigurationError`；port 类型在 `@zcode/contracts`；实现放 bootstrap，经 `context.requestClient(...)` 反向请求 Host。
2. 注入点在 `server-operations.ts:3378`，可见性门控在 `runtime-tools.ts:67`，executor 透传在三处。
3. **工具不可见性**是双保险：门控（不注册）+ handler 内断言（注册了也拒）。

**Step 0 必须查清、且必须写进报告的一件事**：**「Host 侧谁答这个新的 protocol method？」**
`"automation/create"` 这个字符串在**全仓只出现在** `packages/shared/src/zcode-protocol/index.ts:3644` 的常量表里；`packages/desktop/src/**` 里**没有任何手写 handler**（`packages/desktop/out/host/index.js` 里出现该字符串来自**打包依赖**）。⇒ Host 侧的服务方是**生成式或通用桥**，还是某个包里手写的 method 表？

- 若查到**通用/生成式桥**（Host 侧无需手写 handler）⇒ **D 不需要碰 `packages/desktop/**`**（最省事，也最可能的干净结果）。
- 若查到**必须手写 handler** ⇒ D **新增独立文件** `packages/desktop/src/host/squadProtocolMethods.ts`（不在 A 的任何文件里），**方法表注册那一行由 Task 7（Wave 2）追加**（文本见 Task 7 Step 3）；D **本人不得改 `host/index.ts`**。
- **若两种都查不到** ⇒ **停下来报 `NEEDS_CONTEXT`**，把已查过的路径与结论写进报告。**不得**自己发明一套新 RPC / 新通道——那会把本期变成「顺便造一条新通道」。

- [ ] **Step 1: 写失败测试**

**先做一条 smoke（此前无先例：`apps/zcode-cli/**` 零测试、无 test 脚本）**：

```ts
// apps/zcode-cli/packages/core/test/squadTools.test.ts （第一步只有这一条）
import assert from "node:assert/strict";
import test from "node:test";

test("smoke：CLI 工作区能用 tsx --test 跑测试", () => {
  assert.ok(true);
});
```

Run: `pnpm exec tsx --test apps/zcode-cli/packages/core/test/squadTools.test.ts`
若**不通**（`@zcode/contracts` 等 workspace 包解析失败），改从包目录跑：`cd apps/zcode-cli/packages/core && pnpm exec tsx --test test/squadTools.test.ts`。
**两条都不通 ⇒ 报 `NEEDS_CONTEXT`**，把实际错误贴进报告；**不得**在「测试根本跑不起来」的情况下声称验证过。

通过后补齐真正的用例：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createSquadTools } from "../src/tool/handlers/squad.js";

/** 记录 port 调用；**故意不实现任何写状态的方法**（唯一写者不变）。 */
function fakePort() {
  const created: unknown[] = [];
  const assigned: unknown[] = [];
  return {
    created,
    assigned,
    port: {
      async createChildWorkItem(input: { parentId: string; title: string; assignee: unknown }) {
        created.push(input);
        return { workItemId: "wi-child" };
      },
      async assignWorkItem(input: { workItemId: string; agentId: string }) {
        assigned.push(input);
        return { dispatched: true as const };
      },
      async listRoster() {
        return { leaderAgentId: "ta-lead", members: [{ agentId: "ta-a" }] };
      },
    },
  };
}

// 缺 port ⇒ **响亮抛 ConfigurationError**（照 cron.ts 的 assertAutomationPort）：
// 静默 no-op 会让队长以为「派单成功了」，而队员永远不会被唤醒。
test("未注入 squadPort ⇒ 抛 ConfigurationError，不静默返回", async () => {
  const tools = createSquadTools({ squadPort: undefined });
  await assert.rejects(
    () => tools.createChildWorkItem.handler({ parentId: "wi-p", title: "t", assigneeAgentId: "ta-a" }, {} as never),
    /squadPort|ConfigurationError/,
  );
});

test("建子工作项：把父项 id 原样交给 port", async () => {
  const { port, created } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  const out = await tools.createChildWorkItem.handler(
    { parentId: "wi-p", title: "拆解 1", assigneeAgentId: "ta-a" },
    { sessionId: "s1" } as never,
  );
  assert.equal(out.workItemId, "wi-child");
  assert.equal((created[0] as { parentId: string }).parentId, "wi-p");
});

// 派给队员 = 发派发事件（assign），**不是**替调用方写状态。
test("派给队员：只经 port 发派发事件", async () => {
  const { port, assigned } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  await tools.assignWorkItem.handler({ workItemId: "wi-c", agentId: "ta-a" }, {} as never);
  assert.deepEqual(assigned, [{ workItemId: "wi-c", agentId: "ta-a" }]);
});

// 【唯一写者不变 —— 本任务的承重断言】
// SquadPort **不得**暴露任何写工作项状态的方法；一旦有人给它加一个 `transition`，
// 队长就能绕过 workItemService 直写 status（P0/P1 裁定：只有 transition 能写 status），
// 这条断言正是拦它的那道闸。
test("SquadPort 不得暴露任何写工作项状态的方法", () => {
  const { port } = fakePort();
  for (const forbidden of ["transition", "setStatus", "updateStatus", "forceStatus"]) {
    assert.equal(forbidden in port, false, `SquadPort 不得暴露 ${forbidden}（唯一写者是 workItemService）`);
  }
});

// 不可见性双保险的第一道：没有 port ⇒ 工具**不注册**（照 runtime-tools.ts:67 的 includeAutomation）。
test("没有 squadPort 时工具不进工具表", async () => {
  const { includeSquadTools } = await import("../src/runtime/helpers/runtime-tools.js");
  assert.equal(includeSquadTools({}), false);
  assert.equal(includeSquadTools({ squadPort: {} as never }), true);
});

// 派给不存在的队员必须**响亮失败**：静默放行会让工作项挂在一个永远没人做的队员上。
test("派给花名册外的队员 ⇒ 抛", async () => {
  const { port } = fakePort();
  const tools = createSquadTools({ squadPort: port });
  await assert.rejects(
    () => tools.assignWorkItem.handler({ workItemId: "wi-c", agentId: "ta-nobody" }, {} as never),
    /ta-nobody|花名册/,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test apps/zcode-cli/packages/core/test/squadTools.test.ts`
Expected: FAIL（模块 / port / 工具不存在）

- [ ] **Step 3: 最小实现**

1. **`@zcode/contracts`**：`SquadPort` 接口（**只三件事**，无状态写入）+ 两个工具的 `InputSchema`/`OutputSchema` 与 `JsonSchema`，照 `CronCreate*` 的写法。
2. **`packages/shared/src/zcode-protocol/index.ts`**：`zcodeProtocolMethods` 加 `squadCreateChildWorkItem: "squad/create-child-work-item"`、`squadAssignWorkItem: "squad/assign-work-item"`，并加两项结果 schema 与 `clientRequestSchemaMap` 的对应项（照 `automationCreate` 那一项的形状；**只加常量不加映射 ⇒ 请求在入口被丢，静默**）。
3. **core handler** `tool/handlers/squad.ts`：`createSquadTools({ squadPort })` 返回两个 handler；缺 port 时抛 `CoreErrorType.ConfigurationError`（**照抄** `assertAutomationPort` 的形状与文案风格）；`assignWorkItem` 先 `listRoster()` 校验 agentId 在花名册里，不在则抛；`createChildWorkItem` **必须带父项 id**（缺则抛）。
4. **core 接线**：`tool/types.ts` + `executor/types.ts`（两处）+ `executor/impl.ts` + `executor/call-runner.ts` 加 `squadPort` 透传（照 `automationPort` 的四处同形改动）；`runtime/types.ts` 加字段；`runtime-tools.ts` 加 `includeSquadTools` 门控（**与 `includeAutomation` 同一行模式**：`Boolean(deps.squadPort)`）；`handlers/index.ts` 注册。
5. **bootstrap port** `zcode-protocol/squad-port.ts`：`createProtocolSquadPort(context)` → `context.requestClient(zcodeProtocolMethods.squadCreateChildWorkItem, …)`（**照抄** `automation-port.ts` 的结构：schema 解析 + `ProtocolRequestError` 透传 + `-32601` 语义），并在 `server-operations.ts` 的 runnerConfig 里注入 `squadPort: createProtocolSquadPort(context)`（位置照 `:3378`）。
   > **归属隔离**：port 的 `assignWorkItem` 走 protocol → Host → **Wave 0 的 `ISquadRuntimeService` 路径**（Host 侧最终落到唯一写者 `workItemService`/`assignee` 更新）；**CLI 侧绝不直写工作项状态**。
6. **Host 侧**：按 Step 0 的三种结论之一处理（通用桥 ⇒ 不动；手写 ⇒ 新建 `packages/desktop/src/host/squadProtocolMethods.ts`，注册行交 Task 7）。
   > **门禁不在工具侧**（确认 2）：工具**不读** `experimentalAgentSquadsEnabled`。开关关闭时，服务层（`ISquadRuntimeService.createWorkItem` / `assertDispatchEnabled`，Task 2）会**抛** `SquadDispatchDisabledError`；CLI 侧只需把这条错误**原样带回去**给模型（`ProtocolRequestError` 透传），让队长看见「实验功能已关闭」——**不得**吞掉它、也不得自己判一遍（自己判就有了第二份判据，正是本条要消灭的形态）。
7. **`SquadPort` 方法集必须与 §14 的边界注释同在**：文件头写清两个工具与 `Agent` / `SendMessage` / `CronCreate` 的边界（§14 要求「每个工具需在工具文档中写明」），并写明**「汇报 / 请求审查」两个工具留 P2c**。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test apps/zcode-cli/packages/core/test/squadTools.test.ts`
Run: `pnpm --dir apps/zcode-cli/packages/core typecheck`
Run: `pnpm --dir apps/zcode-cli/packages/bootstrap typecheck`
Expected: 全 PASS

- [ ] **Step 4b: 变异验证（必须做，结果写进提交信息）**

1. 给 `SquadPort` 加一个 `transition` 方法 ⇒ **「SquadPort 不得暴露任何写工作项状态的方法」必须变红**。
2. 去掉 `createSquadTools` 的缺 port 抛错（改成静默 no-op）⇒ **「未注入 squadPort ⇒ 抛」必须变红**。
3. 去掉花名册校验 ⇒ **「派给花名册外的队员 ⇒ 抛」必须变红**。
   每次变异后 `git checkout -- <file>` 还原，并确认与基线逐字节一致。

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §14 / §5.1 / §5.7.2 / §3.9 / §4.3 / §13.2）：

- §14：两个工具是否**独立命名、不与 `Agent`/`SendMessage`/`CronCreate` 重名**？是否**只在实验开启时可见**（§13.2「实验关闭时协作工具不可见」）？
- §4.3 / §5.7.2：**唯一写者不变**是否成立——工具是否**只发派发事件 / 建子项**，**没有任何**直写工作项 `status` 的路径？（对应 Step 1 的承重断言 + Step 4b 的变异 1）
- §5.1：工具产出的东西是否**与用户指派走同一形状的派发事件**（不是第二条判据）？
- §3.9：新工具是否带了**运行时校验**（zod schema 进了 `clientRequestSchemaMap`，而不只是加了常量）？
- 缺 port 是否**响亮**（不是静默 no-op）？派给不存在的队员是否**响亮**？
- **`SquadPort` 上是否混进了任何「顺手加的」写状态方法**（这正是本任务最容易被顺手破坏的一处）？

**② 穷举**（先列全集，再逐格给结论）：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| port | 已注入 / 未注入 / 注入但方法抛错 | |
| `createChildWorkItem` | 带父项 / 不带父项 / 父项不存在 / 父项已归档 | |
| `assignWorkItem` | 队员在花名册 / 不在 / 花名册读不到 / 工作项不存在 | |
| 工具可见性 | 实验开 / 实验关（⇒ 服务层抛 `SquadDispatchDisabledError`，工具**原样带回去**）/ port 缺 | |
| protocol | 方法名加了且进了 schema 映射 / **只加常量不进口**（必须能咬红）| |
| Host 侧 | 通用桥 / 手写 handler / 都没有（⇒ NEEDS_CONTEXT） | |
| 唯一写者 | port 无写状态方法 / 有（变异必须咬红） | |
| 重名 | 与 `Agent`/`SendMessage`/`CronCreate` 不重名 | |

逐格写「有测试 / 由类型或代码保证（哪一行）/ 不适用 + 理由」。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/contracts/src packages/shared/src/zcode-protocol \
        apps/zcode-cli/packages/core/src apps/zcode-cli/packages/core/test \
        apps/zcode-cli/packages/bootstrap/src/zcode-protocol
# 若 Step 0 判定需要 Host 侧 handler，再多一个：
# git add packages/desktop/src/host/squadProtocolMethods.ts
git commit -m "feat(squad): 队长派单工具（建子工作项 / 派给队员，经 SquadPort 只发派发事件）"
```

---

### Task 7: 热点收口（启动回收调用点 + 最终接线 + 单点门禁复核）（Wave 2，串行）

> 工作树：`.worktrees/p2b-collect`，分支 `feat/p2b-collect`。**从 A / B / C / D 四条分支合并后的顶端起**（Wave 1 全部 review-clean 之后）。
> 本任务的存在理由：A / B / C 并行时**都不准碰** `packages/services/src/node.ts`，而「把 B 的批次编排挂上事件流」「把启动回收挂上 host 启动」恰恰落在 `node.ts` 与 `host/index.ts` 上——**这两处必须在没人并行的时候做**。

**Owns:** `packages/desktop/src/host/index.ts`（**收口部分**：启动回收调用点、最终装配复核、**D 的 protocol handler 注册行（仅当 D 的 Step 0 判定需要）**）、`packages/services/src/node.ts`（**只允许追加下面逐字给出的两块，不得改动其它任何一行**）、`packages/desktop/test/{squadWiring,squadWorkspaceBinding}.test.ts`（新）

**Must not touch:** Wave 1 已交付且 review-clean 的实现文件（除 `host/index.ts` 与 `node.ts` 的上述追加外）；`packages/services/src/worktree/**`、`packages/services/src/workitem/{squadRunLifecycle,squadOrchestrator}.ts`、`apps/zcode-cli/**`（D 的文件）

**Files:**

- Modify: `packages/services/src/node.ts`（**两块追加，文本见下**）
- Modify: `packages/desktop/src/host/index.ts`（启动回收调用点 + 最终复核 + 可能的 handler 注册行）
- Test: `packages/desktop/test/squadWiring.test.ts`、`packages/desktop/test/squadWorkspaceBinding.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `createSquadRuntime` / `ISquadRuntimeService`（**含单点门禁 `assertDispatchEnabled`**）/ `SquadRuntime.subscribeWorkItemEvents` / `resolveSquadWorkspaceBinding` 的形状；Task 4 的 `createSquadOrchestrator`（`SquadBatchOrchestrator`）；Task 3 的 `HostMessageTypes.SquadWake` / host 分支（**host 只调门禁、不读开关**）；Task 6 的 Step 0 结论（Host 侧是否需要 handler）
- Produces: 装配完成的可运行闭环

- [ ] **Step 1: 写失败测试**

```ts
// packages/desktop/test/squadWiring.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf8");

// 启动回收是 spec §6.4 / §6.6 的**正确性前置**（孤儿占住分支会让重派发撞「分支已存在」）。
// 只写在文档里不算：本用例把「host 启动路径上真的调了它」钉成断言。
test("host 启动路径调用 reapStartupOrphans", () => {
  const host = read("packages/desktop/src/host/index.ts");
  assert.match(host, /reapStartupOrphans/, "host 未调用启动回收；孤儿会占住分支名");
  // 必须是**异步不阻塞 UI** 的调用（spec §11.4「孤儿清理在启动时异步」）
  assert.match(host, /void\s+[\s\S]{0,200}reapStartupOrphans/);
});

// 「子项全完成 ⇒ 整批收尾」这条链只有挂上去才存在。挂点必须是 runtime 的事件出口，
// 不得有第二处轮询（轮询会与事件流并发出两套判据）。
test("批次编排挂在 runtime 的事件出口上", () => {
  const node = read("packages/services/src/node.ts");
  assert.match(node, /createSquadOrchestrator/);
  assert.match(node, /subscribeWorkItemEvents/);
  assert.match(node, /advanceAfterChildrenDone/);
});

// desktop 只能经 `@zcode/services/node` 与 `.` 两个入口取东西（packages/services/package.json#exports）。
// B 的工厂若没被 re-export，host 就够不到它——而编译期不会报错（host 侧是 getOptional 式取用）。
test("node.ts re-export 了 B 的编排工厂", () => {
  const node = read("packages/services/src/node.ts");
  assert.match(node, /export \{ createSquadOrchestrator \} from "\.\/workitem\/squadOrchestrator\.js";/);
});

// 确认 2（**单点门禁**）：判据只有服务层一处，desktop 侧**一处都不许有**。
// 这条检查是本计划里唯一能拦住「判据被复制成第二份」的东西 —— 复制发生时不会有任何编译错。
test("desktop 侧不读开关（门禁判据在服务层）", () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("experimentalAgentSquadsEnabled")) {
        hits.push(full);
      }
    }
  };
  walk(join(repoRoot, "packages", "desktop", "src"));
  assert.deepEqual(hits, [], `门禁判据只能有一处（服务层）：${hits.join(", ")}`);
});

// host 只**调**服务层门禁并按稳定 code 分流；不得自己读设置。
test("host 调服务层门禁并按稳定 code 翻译成 permanent", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const start = host.indexOf("HostMessageTypes.SquadWake");
  assert.ok(start >= 0, "host 里没有 SquadWake 分支");
  const branch = host.slice(start, start + 8000);
  assert.match(branch, /assertDispatchEnabled/);
  assert.match(branch, /SQUAD_DISPATCH_DISABLED_CODE|isSquadDispatchDisabledError/);
  assert.match(branch, /failureKind: "permanent"/);
});
```

- [ ] **Step 1b: 写 workspace 绑定的失败路径测试**

照 **Task 2 Step 3b-2** 给出的三条用例建 `packages/desktop/test/squadWorkspaceBinding.test.ts`（多候选 ⇒ 抛且列出候选 / 唯一候选 ⇒ 绑定 / 无候选 ⇒ 抛）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/desktop/test/squadWiring.test.ts`
Expected: FAIL（三处装配尚未落地）

- [ ] **Step 3: 最小实现**

**（3a）`node.ts` 追加块一 —— re-export（放在 Task 2 已加的 `export { createSquadRuntime } …` 旁边）：**

```ts
export { createSquadOrchestrator } from "./workitem/squadOrchestrator.js";
```

**（3b）`node.ts` 追加块二 —— 装配（放在 `getSquadRuntime` 定义之后、`services.register(ISquadRuntimeService, …)` 之前或紧邻）：**

```ts
   // 批次编排的挂点：**唯一**的事件出口是 runtime.subscribeWorkItemEvents（没有第二处轮询）。
   // 订阅必须在 runtime 第一次建好之后挂一次，故这里包在同一个懒 Promise 里；
   // 重复挂会让同一次 child_completed 被处理两遍（两次 merge 同一分支 ⇒ 第二次撞「分支不存在」）。
   const squadLog = createServiceLogger("squad-runtime");
   let squadBatchWired = false;
   const getSquadRuntimeWithBatch = async (): Promise<SquadRuntime> => {
     const runtime = await getSquadRuntime();
     if (!squadBatchWired) {
       squadBatchWired = true;
       const orchestrator = createSquadOrchestrator({ runtime });
       runtime.subscribeWorkItemEvents((event) => {
         // spec §5.7.3：子项**全部** category ∈ {done, closed} 才触发；判据在编排层内部
         // （areAllChildrenTerminal），此处只做转发，不在这里再判一次（两处判据迟早分叉）。
         if (event.kind !== "workitem.child_completed") return;
         void orchestrator
           .advanceAfterChildrenDone({
             // 用 runtime 的**绑定**身份，不用事件里的值：绑定是本期唯一被校验过的 workspace 口径。
             workspaceKey: runtime.boundWorkspace.identity,
             parentWorkItemId: event.parentId,
           })
           .catch((error) =>
             squadLog.error("小队批次收尾失败", { parentWorkItemId: event.parentId, error }),
           );
       });
     }
     return runtime;
   };
```
（`getSquadRuntime` 仍由 Task 2 定义；本任务新增的是**带批次装配**的那层包装，`ISquadRuntimeService` 的注册仍走 `getSquadRuntime`，避免「只是为了取数就把批次层建起来」。）

**（3c）`node.ts` 的 workspace 绑定（裁定 4：**不许静默取第一个**）**：实现 `resolveSquadWorkspaceBinding(candidates)`（放 `packages/desktop/src/host/` 或与调用点同处的独立小文件，**不进 `host/index.ts`**），语义逐条固定：

```ts
/**
 * 小队运行时绑定哪个 workspace —— **显式，且不许静默取首个**。
 * 静默取首个属我们一路在消灭的那类静默错选：用户看到的是「我没建过小队」，
 * 而真相是我们在另一个 workspace 上读写。候选多于一个时**拒绝并报告候选清单**，
 * 让调用方显式指定（多 workspace 的完整支持登记为 P2c）。
 */
export function resolveSquadWorkspaceBinding(
  candidates: ReadonlyArray<{ path: string; identity: string }>,
): { path: string; identity: string } {
  if (candidates.length === 0) throw new Error("小队运行时未绑定 workspace：没有候选");
  if (candidates.length > 1) {
    throw new Error(
      `小队运行时未绑定 workspace：候选多于一个，必须显式指定（本期不支持多 workspace）→ ` +
        candidates.map((c) => `${c.identity}(${c.path})`).join(" / "),
    );
  }
  return { ...candidates[0]! };
}
```
并把结果传给 `createServiceCollection` 的 `squadWorkspace` 入参（Task 2 step 9 的形状）；**未绑定 ⇒ `ISquadRuntimeService` 的每个方法抛**（Task 2 已落，本任务只接线）。三条路径各有测试（`packages/desktop/test/squadWorkspaceBinding.test.ts`，用例见 Task 2 Step 3b-2）。

**（3f）D 的 protocol handler 注册（**仅当 Task 6 的 Step 0 判定「Host 侧必须手写 handler」**）**：在 `host/index.ts` 的方法表里追加**一行**注册：

```ts
   // 小队派单工具经 CLI 的 SquadPort 反向请求落到这里（Task 6 D）。方法实现**不在本文件**——
   // 它在 packages/desktop/src/host/squadProtocolMethods.ts（D 的独立文件），本处只挂一行，
   // 避免两个执行者同时改 host/index.ts。
   ...squadProtocolMethods,
```
若 Step 0 的结论是「走通用/生成式桥」，则 **3f 整条跳过**，并在报告里写明依据（哪个包/哪个函数承的桥）。

**（3d）`host/index.ts` 追加 —— 启动回收调用点：**

```ts
  // 启动回收（spec §6.4 / §6.6）：**必须**在 database startup ready 之后、且**异步**不阻塞 UI。
  // 为什么必须做：孤儿工作树会**占住分支**，下次同分支再建会失败 —— 清理是重派发的正确性前置。
  // 为什么异步：它要起 git 子进程（worktree list / prune / branch -D），同步跑会顶住启动。
  // 失败只记日志、不阻断启动（best-effort），但**不得静默吞掉**：warn 带原文。
  void (async () => {
    try {
      const squadRuntime = services.getOptional(ISquadRuntimeService);
      if (!squadRuntime) return;
      const outcome = await squadRuntime.reapStartupOrphans();
      logger.info("squad startup reap done", {
        reclaimed: outcome.reclaimed.length,
        reclaimedBranches: outcome.reclaimedBranches.length,
        kept: outcome.kept.length,
        foreign: outcome.foreign.length,
      });
    } catch (error) {
      logger.warn("squad startup reap failed", error);
    }
  })();
```

（`reapStartupOrphans` 在 `ISquadRuntimeService` 上的入参：**不传 workspaceKey**，由服务内部用绑定的 workspace —— 让调用方没有机会传错 workspace。）

**（3e）单点门禁复核（只复核，不改）**（确认 2）：判据是**服务层单点** `ISquadRuntimeService.assertDispatchEnabled`；本任务确认三件事——① `packages/desktop/src/**` **一处都不读**该开关（静态守卫，Step 1 已有）；② host 只调 `assertDispatchEnabled` 并按 `SQUAD_DISPATCH_DISABLED_CODE` 翻译成 `failureKind: "permanent"`；③ **没有任何一处**去取消进行中的 run（spec §5.7.6 的后半句）。任一条不成立 ⇒ **回对应任务（Task 2 / Task 3）单开修复轮**，不在本任务就地补（否则判据会变成第二、第三份）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/desktop/test/squadWiring.test.ts`
Expected: PASS

**（4b）全量验证（本任务必须做，因为它是最后一个写码任务）：**

```bash
pnpm run typecheck
pnpm run lint
pnpm exec tsx --test packages/shared/test/*.test.ts
pnpm exec tsx --test packages/services/test/*.test.ts
pnpm exec tsx --test packages/desktop/test/*.test.ts
pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/*.test.ts
```

Expected: 全绿；输出**干净**（零 `console.log`、零 stray warning、无 `.only` / `skip` / `todo`）。

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §5.7.3 / §5.7.6 / §6.4 / §6.6 / §11.4 / §16 S4 S15）：

- recon.md 缺口 #1–#11 是否**逐条**有落点（对照 recon 的清单逐项打勾，**缺一条就是没落地**）？
- 启动回收是否（a）在 database ready 之后（b）异步（c）best-effort 且**响亮**（warn 带原文）？
- §5.7.6：关闭实验是否只停新派发、进行中的 run 一个字节不动？
- 订阅是否**只挂一次**（重复挂 = 同一次事件被处理两遍 = 第二次 merge 撞「分支不存在」）？
- 全仓 grep：`git branch -D`、`.worktree` 字面量、`schedulerModulePath` 是否有**第二处**？（P2a 的终审纪律）

**② 穷举**：

| 枚举空间 | 全集 | 处理 / 覆盖 |
|---|---|---|
| 启动状态 | 库就绪 / 未就绪 / 无 runtime / reap 抛错 | |
| 事件 | `workitem.status_changed` / `workitem.child_completed` / 其它 | |
| 子项状态 | 全终态 / 部分终态（**不得**触发收尾） | |
| 门禁 | 开 / 关 / 读设置失败 | |
| 装配顺序 | runtime 已建 / 未建（懒建路径） | |
| 重复挂载 | 首次 / 二次（必须只挂一次） | |

逐格写结论。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/node.ts packages/desktop/src/host/index.ts \
        packages/desktop/test/squadWiring.test.ts packages/desktop/test/squadWorkspaceBinding.test.ts
git commit -m "feat(squad): 热点收口（启动回收调用点 + 批次编排装配 + workspace 按需现构 + 单点门禁复核）"
```

---

### Wave 3：集成与端到端验收（**由 controller 做，不在任务编号内**）

1. **合并**四条并行分支（`feat/p2b-scheduler` / `feat/p2b-orchestrator` / `feat/p2b-entry` / `feat/p2b-tools`）到 `feat/p2b-collect`；解冲突时**不许**改 Wave 1 的实现语义（若真需要改，回到对应任务单开修复轮）。
2. **全量测试**：shared / services / desktop / ui 四套 + `pnpm exec tsx --test apps/zcode-cli/packages/core/test/squadTools.test.ts` + `pnpm run typecheck` + `pnpm run verify:pre-push`。
3. **按闭环逐步验收**（每一步都要留下证据，不是「看起来没问题」）：
   | # | 步骤 | 证据 |
   |---|---|---|
   | 1 | 打开设置 ▸ 实验功能 ▸ 多智能体小队开关 | 视图出现；关闭后视图消失 |
   | 2 | 建 1 个队长 agent + 2 个队员 agent；建小队（含 `stopCondition`/`maxRounds`） | 定义落在 `<ws>/.zcode/squad/`；`git status` 不脏 |
   | 3 | 建父工作项，指派给小队 | `squad_runs` 出现队长 run（`is_leader_task=1`、无分支）；队长会话被创建 |
   | 4 | 队长 run 的 prompt | **含三段**：花名册 / 操作协议 / 队长指令 |
   | 5 | **队长自己**调 `SquadCreateChildWorkItem` 建 2 个子项 + `SquadAssignWorkItem` 派给 2 名队员（日志里可见两次工具调用） | 2 个子项由队长 run 产出（**不是**手动建的）；`<ws>/.worktree/<wi>-<ag>` 各一个；`squad_runs` 两条 `open`；两名队员的会话**互不可见** |
   | 6 | 通过子项 1 的审查 | 合入 `squad/integration/<wi>`；主分支**未变** |
   | 7 | 打回子项 2 | 工作树**仍在**、分支**仍在**、台账 `rejected` |
   | 8 | 修复后通过子项 2（两个子项都终态） | 集成分支合回 base；`squad/member/**` 与 `squad/integration/*` **全部消失**；工作树目录清空 |
   | 9 | **崩溃恢复**：在第 5 步之后强杀再启动 | 两个工作树**都存活**（`activeBranches` 含它们）；外来工作树未被碰 |
   | 10 | **关闭实验后再启动** | 不再有新派发；进行中的 run 不被中断；数据保留 |
   | 11 | **多候选 workspace** | 启动即报错并把候选清单写进日志（**不是**静默挑一个） |
4. **手前格式账**（P2a 的教训）：`oxfmt` **不是门**（不在 `verify:pre-push` 里），但本分支**新增**的文件必须 fmt 干净——逐文件探针核实，别把既有脏文件算进来。

---

## 计划的自我审查（Self-Review）

**1. Spec 覆盖**

| spec 位置 | 落点 |
|---|---|
| §3.3 队长简报**三段**（含系统生成的 `protocol`） | Task 2（`leaderDispatch.ts` + `LEADER_PROTOCOL_TEXT` + 渲染），Task 3 用在派发桥 |
| §5.7.1 `eventKey` 唯一构造器与两族 | Task 2（`computeEventKey`，实现 + 穷举测试），Task 3（tick 消费） |
| §5.7.3 `children_done` 用 **category** | Task 4 B‑2（`areAllChildrenTerminal`） |
| §5.7.4 串行合并 / 整批才合回 / 冲突 → `blocked` + Inbox | Task 4 B‑2，Task 2（`reviewMemberRun`） |
| §5.7.6 关闭实验 = 停新派发、不中断进行中的 run | Task 2（**门禁单点 `assertDispatchEnabled` + 三入口共判 + 在途不中断**，确认 2）、Task 3（host 只调门禁）、Task 5（视图隐藏=呈现）、Task 7（静态守卫复核） |
| §6.1 工作树是**本次运行**的属性 | Task 2（`openMemberRun` 在 host 侧按 `isLeaderTask` 决定）、Task 3 |
| §6.2 审查被拒**不提前删** | Task 2（`reviewMemberRun` rejected 分支）、Task 4 B‑2（S5 用例） |
| §6.3 集成分支 / D/F 安全命名 | Task 2（`slugForId` + `planBranches`）、Task 4 B‑2（`finalize` + 两条分支都删） |
| §6.4 / §6.6 启动回收是**重派发正确性前置** | Task 2（`reapStartupOrphans`）、Task 4 B‑0（命名空间限域）、Task 7（调用点） |
| §13 C10 排除清单集中一处 + 同时驱动两半 | Task 4 B‑1（并入 `BUILTIN_IGNORE_LINES`，从唯一来源派生） |
| §17 表：`activeBranches` 语义 / 用户侧排除半边失效 / 三段简报 / 迁移冻结登记 | 硬约束 2（Task 2）、硬约束 3（Task 4 B‑1）、§3.3（Task 2）、Task 1 Step 3b |
| §16 S1 / S4 / S5 / S8 / S9 / S10 / S13 / S15 / S17 | S1 → **Task 6（D 的两个工具）** + Task 3（队长被唤醒）；S4/S5/S17 → Task 4；S8/S9 → Task 5；S10 → Task 2（#9）；S13 → Task 2（`once` 幂等 + `eventKey`）；S15 → Task 2/7 |
| §14 工具集（**前两个**：建子工作项 / 派给队员） | **Task 6（D）**；后两个（汇报 / 请求审查）留 P2c |
| recon.md 缺口总表 11 项 | #1→T1；#2→T2；#3→T2+T5；#4→T3+T6；#5→T5；#6→T3；#7→T3；#8→T2+T4；#9→T2；#10→T1；#11→T3 |

**未覆盖项 → 明确属哪一期**：交付物、成本记账、GitHub PR 集成、完整父子树 UI、评论 / 活动时间线、Inbox 完整语义、渠道、AI 建 agent 向导、**§14 四个协作工具**（⇒ P2c）；多设备 / host 绑定（⇒ 不做）。见「范围」一节的表，**没有一项是漏掉而不是裁掉的**。

**2. 占位符扫描**：无 `TBD` / `TODO` / 「适当处理」类表述。每个代码步骤给的是**可执行**代码或精确命令。四处「先给形状、后由别的任务接上」都**不是占位符**，因为它们的**署名、依赖边与拒绝路径被显式写出**：
（a）`SquadBatchOrchestrator` 在 Task 2 只有**类型**（`squadContracts.ts`），实现由 Task 4 B‑2 给，装配点由 Task 7 给——三处逐字对应；
（b）Task 2 step 9 的 workspace **未绑定 ⇒ 抛**、**候选 > 1 ⇒ 抛并报告**，都是**具名失败路径**（各有断言），不是留白；
（c）`recentFireCount` 用本轮内存计数，是**明确记录的最小实现**并有注释指向 P2c；
（d）Task 6 的 Host 侧 protocol handler **有明确的三分支结论与各自的落点**（通用桥 / 独立新文件 + T7 一行注册 / `NEEDS_CONTEXT`），不是「待定」。
Task 1 Step 3b 里那次「临时写 `"0"` 取真实 checksum」是**取值的操作手段**（写完即删），不是交付物里的占位符。

**3. 类型一致性**（与真实代码逐字核对过，不是凭记忆）：

- `createWorkItemRepo(db: DatabaseSync)`（`workItemRepo.ts:54`）/ `createWakeRuleRepo(db: DatabaseSync)`（`wakeRuleRepo.ts:117`）—— Task 2 用 `taskIndexRepo.openSharedDatabase()` 的 `TasksIndexDatabase`（`InstanceType<typeof DatabaseSync>`，`taskIndexRepo.ts:50`）喂它们，**同一实例**。
- `createWorkItemService({ repo, emit })`（`workItemService.ts:37`）—— Task 2 的 `emit` 派给内部订阅表，`subscribeWorkItemEvents` 是**唯一**出口。
- `createSquadService({ root, teamAgentRoot })`（`squadService.ts:71`）/ `createTeamAgentService({ root })`（`teamAgentService.ts:64`）—— root 用 `resolveSquadDefinitionRoot(ws)` / `resolveSquadAgentRoot(ws)`（`squadStorage.ts:28` / `teamAgentStorage.ts:28`）。
- `createWorktreeManager({ git, repoRoot })`（`worktreeManager.ts:146`）/ `createBranchAllocator({ manager })`（`branchNaming.ts:141`）/ `createIntegrationMerger({ git, repoRoot, base })`（`integrationMerge.ts:65`）/ `createOrphanReaper({ manager, repoRoot, deleteBranch, listBranches })`（`orphanReaper.ts:133`）—— Task 2 的装配按此逐字。
- `planBranches({ workItemSlug, agentSlug })`（`branchNaming.ts:56`）返回 `{ integration, member }`；`memberDirName(plan)`（`:136`）—— Task 2 的 `openMemberRun` 用 `slugForId` 派生两个 slug。
- `planDispatch({ workItem, squad, trigger, ruleId? })`（`leaderDispatch.ts:35`）/ `decideWake({ rule, manual, recentFireCount, chainRepeatCount, hasPendingSameEvent, allInputsFromSelf })`（`wakeGuard.ts:45`）/ `WakeRuleRepo.listReady(now, limit)`（`wakeRuleRepo.ts:103`）/ `casAdvance(id, expectRevision, nextFireAt, fireCount, pausedReason?)`（`:110`）。
- `hostCronRunMessageSchema`（`validation.ts:390`）与 `HostMessageTypes.CronRun`（`channels.ts:556`）是新增消息的**照抄样本**；`dispatchCronRun`（`host/index.ts:873`）与 `HostMessageTypes.CronRun` 分支（`:2452`）是新增分支的样本。
- `createBoundSessionExecutingProbe({ agentService, logWarn })`（`boundSessionBusyGate.ts:84`）返回 `(params)` 探针；抛 `BoundSessionBusyError`（`:31`）在 host 被翻译成 `failureKind: "deferred"`（`:2483`）。
- `IServiceAccessor`（`accessor.ts:46`）+ `ServiceCollection.register`（`collection.ts:15`）+ `exposeOnChannelServer`（`:34`）是 UI 侧的取数链路；`createServiceDescriptor`（`descriptors.ts:15`）是描述符的唯一来源。
- 迁移登记三件套：`definitions`（`migrations.ts:48-77`）、`PINNED_MIGRATION_CHECKSUMS`（`workItemMigration.test.ts:45-50`）、`LATEST_MIGRATION_ARTIFACTS`（`:55-57`）—— Task 1 Step 3b 逐条对上。
- `WORKSPACE_PRODUCT_DIRS` / `WORKSPACE_PRODUCT_TOP_LEVEL_NAMES`（`workspaceProductDirs.ts`）是 C10 的**代码侧唯一来源**；`BUILTIN_IGNORE_LINES`（`workspaceFileIgnore.ts:47`）与仓库根 `.gitignore` 是两半。

**4. Review Focus 落点**：六条隐含失败模式各有归属任务与其测试——弱忙检查（T3 静态守卫 + 纯函数用例）、启动回收吃树（T4 B‑0 用例 + T2 `computeActiveBranches` 用例）、`eventKey` 拼串（T2 穷举 + T3 用例）、只有 dev 生效（T3 `schedulerWiring` 静态守卫）、**开关只是装饰**（T2 的**单点门禁四条用例**：稳定 code / 界面触发被拦 / 规则 tick 被拦 / 在途 run 不中断；T3 与 T7 的**两道静态守卫**：desktop 侧不得出现该字段）、另开 tasks-index 连接（T1 TEMP 表用例）。另加第七、八、九条由本轮裁定产生：**队长工具直写状态**（T6 的 port 方法集断言 + 变异 1）、**workspace 静默错选 / 陈旧**（T2 Step 3b-2 异己 workspaceKey 用例 + T7 `squadWorkspaceBinding` 三条 + 「不缓存」的实现注释）、**门禁判据被复制**（T3/T7 的两道目录级守卫）。

**5. 两法审查已内置**：每个任务（T1–T7）的 Step 5 都拆成 **① 逆推**（对 spec **具体小节**逐条反查）+ **② 穷举**（先列全集矩阵、再逐格给结论），并写明「只有逆推、没有穷举清单视为未完成」。Wave 1 的**四个**任务（A/B/C/D）与 Task 7 逐条点名 recon.md 的**具体缺口编号**，使「落地」可核对而不是可声称。

**6. 四条裁定的落地与遗留给 P2c 的代价**（2026-10-01 controller 裁定，已就地改完）：

1. **B 的 Owns 含 `worktree/orphanReaper.ts`（接受）。** 「在调用方过滤」不是修正判据、只是换个地方漏（第二遍仍会删分支），故维持 B 横跨 `workitem/` + `worktree/`。**已补**：B‑0 要求在源码注释里写下**不变式本身**（归属判据 = 分支命名空间，不是路径；`dirname(path) === root` 只说明「放在我们的目录里」），并给了逐字文本——只改行为不够，行为会被下一个作者照自己的理解改回去。
2. **门禁落服务层单点（确认 2，覆盖先前「归 A」的说法）。** 判据是 `ISquadRuntimeService.assertDispatchEnabled`（**唯一的开关读取点**，Task 2 收口处），`createWorkItem` / `openMemberRun` 的**入口**调**同一个**判据 ⇒ 三个入口（规则 tick / 界面手动触发 / 队长工具）共用一处判据。**理由**：门禁有三个入口，放 host 只盖住①，②③要各自再判 ⇒ 三份判据、改一处漏一处，恰是「关掉实验照旧派发」的形态。**已改**：A 不再有门禁 patch（host 只调服务层门禁并按稳定 code 翻成 `failureKind: "permanent"`）；C 不产出任何后端 patch 文本（只做呈现）；矩阵里「唯一一处由别人代笔」那句已删；F2 里写出了判据签名与语义；Review Focus 第 5 条改为「服务层单点 + 三入口共判测试（至少覆盖界面触发与规则 tick）+ 在途 run 不中断 + desktop 侧不得出现该字段的静态守卫」。**新增的落地物**：`SQUAD_DISPATCH_DISABLED_CODE` 稳定错误码、`SquadRuntimeDeps.readExperimentEnabled`（runtime 侧同步读，**判据只在这里读一次**）、Task 3 的静态守卫用例、Task 7 的递归目录守卫。
3. **§14 前两个工具纳入本期，新增 Wave 1 D（Task 6）。** 已新增任务、矩阵 D 列与 D 的行、Wave 1 改为四路、Wave 2/3 的合并顺序含 D、「已知代价」改写为「本期可演示队长自主派单；汇报 / 请求审查留 P2c」。**D 的 Step 0 侦察结果（已查明，写进计划）**：通路**存在**，形态是 **Port 注入** —— core handler 取 `context.automationPort`（`apps/zcode-cli/packages/core/src/tool/types.ts:168`）→ 缺 port 抛 `ConfigurationError`（`tool/handlers/cron.ts` 的 `assertAutomationPort`）→ 实现放 bootstrap（`bootstrap/src/zcode-protocol/automation-port.ts` 的 `createProtocolAutomationPort`）→ 经 `context.requestClient(zcodeProtocolMethods.automationCreate, …)` 变成 **CLI → Host 的反向 JSON-RPC 请求**（方法名常量 `packages/shared/src/zcode-protocol/index.ts:3644`）→ 注入点 `bootstrap/src/zcode-protocol/server-operations.ts:3378` → 可见性门控 `core/src/runtime/helpers/runtime-tools.ts:67` → executor 透传三处（`tool/executor/{impl.ts:52,call-runner.ts:410,types.ts:107,213}`）。
   **未查明、已变成 D 的 Step 0 必答项**：**Host 侧谁答这个新 method** —— `"automation/create"` 在全仓**只**出现在 shared 的常量表里，`packages/desktop/src/**` 里**没有任何手写 handler**（`desktop/out/host/index.js` 中出现该串来自打包依赖）⇒ 需查清是通用/生成式桥还是某个包里的 method 表。三种结论各有明确处置（通用桥 ⇒ 不碰 desktop；手写 ⇒ D 新增独立文件 `host/squadProtocolMethods.ts`、注册行由 T7 加；都查不到 ⇒ **NEEDS_CONTEXT**，不得自造通道）。
   **未被裁定的残留**：D 的测试是 **CLI 工作区的第一个测试**（`apps/zcode-cli/**` 零测试、无 test 脚本，全仓也没有 `test` script）⇒ Step 1 第一步是一条 **smoke**，先证明 `pnpm exec tsx --test apps/zcode-cli/packages/core/test/squadTools.test.ts` 能跑；两条路径都不通就 `NEEDS_CONTEXT`，**不得**在没有可跑测试的情况下声称验证过。
4. **workspace：按目标现构、不缓存、不静默取首个（确认 3 + 裁定 4）。** runtime **不是长期单例** —— `ISquadRuntimeService` 的**每个方法第一个参数都是 `SquadWorkspaceTarget`**，服务层为该目标现构 runtime、用完即弃（对齐 F1 的 `createSquadRuntime(deps)`）。**理由已写进计划**：缓存要回答「什么时候失效」，而陈旧的表现是**在错的 workspace 上读写**；不缓存 ⇒ **无陈旧、无失效逻辑**。`runtime.boundWorkspace` 记该目标，**内部遇到异己 workspaceKey 一律抛**（带两侧值）；调用方给不出唯一目标时**拒绝并报告候选清单**（`resolveSquadWorkspaceBinding`：0 个 ⇒ 抛，> 1 个 ⇒ 抛并列出候选）。**若实现发现构造含重活**（例如构造 repo 会跑迁移），改按 `workspaceKey` 缓存**并显式登记失效面**，在报告里说明——**不得**静默退化。测试：Task 2 Step 3b-2（异己 workspaceKey / 门禁四条）+ Task 7 `squadWorkspaceBinding.test.ts`（三条）。

**仍留给 P2c 的代价（不是遗漏，是裁掉了）**：多 workspace；§14 的「汇报 / 请求审查」两个工具与审查 agent（本期审查由最小视图按钮触发）；交付物 / 成本记账 / PR 集成 / 完整父子树 UI / 评论与活动时间线 / Inbox 完整语义 / 渠道 / AI 建 agent 向导；多设备与 host 绑定（不做）。



