import type { SquadRunSettlementHub } from "./squadRunSettlementHub.js";
import type { TasksIndexDatabase } from "../session/taskIndexRepo.js";
import type { SquadService } from "../teams/squadService.js";
import type { TeamAgentService } from "../teams/teamAgentService.js";
import type { createBranchAllocator } from "../worktree/branchNaming.js";
import type { GitRunner } from "../worktree/gitRunner.js";
import type { createIntegrationMerger } from "../worktree/integrationMerge.js";
import type { createOrphanReaper } from "../worktree/orphanReaper.js";
import type { WorktreeManager } from "../worktree/worktreeManager.js";
import type { InboxItemRepo } from "./inboxItemRepo.js";
import type { SquadRunLifecycle } from "./squadRunLifecycle.js";
import type { SquadDispatchRequestHub } from "./squadDispatchRequests.js";
import type { SquadRunRepo } from "./squadRunRepo.js";
import type { WakeRuleRepo } from "./wakeRuleRepo.js";
import type { WorkItemEvent, WorkItemService } from "./workItemService.js";
import type { WorkItemRepo } from "./workItemRepo.js";

/* 小队运行时的**类型面**（Wave 0 的冻结接口之一）。
   本文件**只含类型**：`SquadRuntime` 的**值**由 `squadRuntime.ts` 的 `createSquadRuntime` 给出。
   分成两个文件是为了让 Wave 1 B（工作树编排）能只拿类型、不被迫把 node 侧的装配实现拉进自己的依赖图。

   为什么把「runtime 为一个目标 workspace 而构造」写进类型：门禁与工作树都作用在**某一个**工作区上，
   而「选哪个工作区」是最容易静默出错的一格（取错了不会报错，只会读写到别处）。所以目标不是环境变量、
   不是全局默认值，而是 `createSquadRuntime` 的**必填入参**，并原样落在 `boundWorkspace` 上。 */

export type {
  MemberRunRequest,
  OpenMemberRunResult,
  ReviewOutcome,
  SquadRunLifecycle,
} from "./squadRunLifecycle.js";

export type { SquadRunSettlementHub } from "./squadRunSettlementHub.js";

export type SquadRuntimeDeps = {
  /** `taskIndexRepo.openSharedDatabase()` 交出的**同一条**连接。自行另开一条会跳过迁移/回填（recon.md F3）。 */
  db: TasksIndexDatabase;
  /** 目标工作区（git 仓库根）。工作树、分支、工作项与台账都落在这里。 */
  workspacePath: string;
  /** 目标工作区的身份（C14：非空白时优先于 path，作为 `workspace_key`）。 */
  workspaceIdentity: string;
  /** 显式覆盖 base 分支；省略时由本层 `git symbolic-ref --short HEAD` 解析——失败**抛**，不猜 "main"。 */
  baseBranch?: string;
  /**
   * 实验开关的**唯一读取口**（spec §5.7.6 门禁）。由组合根注入（读 `appSettings` 的同步快照），
   * runtime 只在这里读一次并把结论交给 `assertDispatchEnabled` —— **分支/工具/UI 都不读**。
   *
   * 同步（返回 boolean 而不是 Promise）是刻意的：门禁判定在派发路径上，不该变成一条异步 IO 链；
   * 异步账本 + await 会让「谁来判」重新散开成多处。
   */
  readExperimentEnabled: () => boolean;
  /**
   * run 结算事实的扇出 hub（C4，**可选加法**）：生命周期在每个收尾迁移之后 publish，
   * 一次覆盖全部收尾路径（host 订阅闭包 / UI 审查 / 编排器——分散挂会漏，C0 2.4）。
   * 推进/重放的消费方接线在 C4b；不注入 ⇒ 不发布（测试可静默）。
   */
  runSettlementHub?: SquadRunSettlementHub;
  /**
   * 派发请求的**常驻订阅出口**（**加法**，2026-10-02 第 2 轮裁定，落点 ii）。
   *
   * 为什么必需：runtime 是**按目标现构、不缓存**的，其 `subscribeWorkItemEvents` 的订阅表在**实例
   * 内部** ⇒ 常驻侧（host 进程里的组合根）订不到任何实例 ⇒ 「队长派单只发一条
   * `workitem.dispatch_requested`」在当前架构下**驱动不出 run**。组合根建**一份** hub 注入进来，
   * runtime 在发出 `workitem.dispatch_requested` 时一并 `publish`；常驻侧订**一次**即可收到。
   *
   * **可选**（既有调用方不受影响）：未注入时行为与加法前**完全一致**（只走实例级订阅表）。
   */
  dispatchRequestHub?: SquadDispatchRequestHub;
};

export type SquadRuntime = {
  workItemRepo: WorkItemRepo;
  wakeRuleRepo: WakeRuleRepo;
  squadRunRepo: SquadRunRepo;
  /**
   * 收件箱台账（**加法**，P2c）。`inbox_items` 表的唯一读写处（repo 内部是唯一写者）。
   *
   * 为什么给编排器一条**直写通路**：冲突发生在编排器内部、它本来就用同一组 repo
   * （`workItemRepo` / `squadRunRepo`），把「父项 blocked + 登记一条 InboxItem」这两半放在同一层
   * 才不会出现「blocked 了但没人知道」的半程状态。服务面（`ISquadRuntimeService.recordInboxItem`
   * 等）仍是 UI / host 的入口 —— 两条通路共用**这一个** repo（唯一写者不变）。
   */
  inboxItemRepo: InboxItemRepo;
  workItemService: WorkItemService;
  teamAgentService: TeamAgentService;
  squadService: SquadService;
  git: GitRunner;
  worktreeManager: WorktreeManager;
  /**
   * **lazy base 解析的谱面**（2026-10-04 第 50 轮）：base 分支不在构造期解析（非 git 目录上
   * 只读/配置操作必须可用），而是推迟到**首个 git-dependent 动作**，并发调用共享同一个初始化
   * Promise。解析规则一条不动：显式 `deps.baseBranch` > HEAD 解析 > 小队命名空间分支崩溃残留时
   * 用唯一非小队分支（候选不唯一则抛），**绝不猜 "main"**。
   */
  resolveBaseBranch(): Promise<string>;
  /**
   * **测试专用**（`__test-` 前缀）：门面解析后的底层 lifecycle。唯一用途是「按仓库串行」测试
   * 往底层方法打补丁（门面是 Proxy，不可写）。生产代码**不得**用它绕过门面 —— 那等于绕过
   * 「非 git 目录显式报错」这道闸。
   */
  __testUnderlyingLifecycle(): Promise<SquadRunLifecycle>;
  branchAllocator: ReturnType<typeof createBranchAllocator>;
  integrationMerger: ReturnType<typeof createIntegrationMerger>;
  /** 绑定的 workspace 身份（裁定 4 + 确认 3）：runtime **为某一个目标 workspace 而构造**，
   *  内部所有访问都只用它；任何来自外部的异己 workspaceKey 一律抛。 */
  boundWorkspace: { path: string; identity: string };
  /** 门禁的唯一实现（spec §5.7.6）：关闭即抛 SquadDispatchDisabledError；**不中断在途 run**。 */
  assertDispatchEnabled(): Promise<void>;
  lifecycle: SquadRunLifecycle;
  /** 工作项事件的**唯一**出口。新增订阅者只准挂在这里，不得去读 repo 轮询。 */
  subscribeWorkItemEvents(handler: (event: WorkItemEvent) => void): () => void;
  /**
   * 工作项事件的**唯一**入口（`subscribeWorkItemEvents` 的发射侧；**加法**，2026-10-02 裁定
   * Important-1 落地）。为什么必须和订阅走**同一张表**：`workitem.dispatch_requested` 必须与
   * 状态变迁事件同源同形，否则「多路输入、一处写入」会退化成两套事件流（选哪套、谁先到，无人能说清）。
   *
   * `workitem.dispatch_requested` 还会**同时**发给注入的 `dispatchRequestHub`（轮 2 裁定）：
   * 实例级订阅表在 runtime 内部，常驻侧订不到 ⇒ 那一格改由 hub 承载（additive，见 `SquadRuntimeDeps`）。
   */
  emitWorkItemEvent(event: WorkItemEvent): void;
  /** 供组合根在 dispose 时关闭本域自持的东西（repo 句柄由 node.ts 统一登记，不在此重复）。 */
  dispose(): void;
};

/**
 * 整批推进器（spec §6.3 / §6.2）。**本文件只声明类型；实现由 Wave 1 B 落**
 * （`workitem/squadOrchestrator.ts`）——它是全计划里唯一一处明文规定的「只冻结形状」。
 *
 * 为什么它必须与 `SquadRuntime` 的类型放在一起：调用方（队长工具 / 收尾钩子）要同时知道
 * 「我拿到哪些零件」与「整批的两步叫什么」，两个类型分家会让 Wave 1 的三方各自猜名字。
 */
export interface SquadBatchOrchestrator {
  /** 子项全部终态（category ∈ {done, closed}）后：整批 finalize → 逐个抛弃 → 收尾。 */
  advanceAfterChildrenDone(input: {
    workspaceKey: string;
    parentWorkItemId: string;
  }): Promise<void>;
  discardBatch(input: { workspaceKey: string; parentWorkItemId: string }): Promise<void>;
}
