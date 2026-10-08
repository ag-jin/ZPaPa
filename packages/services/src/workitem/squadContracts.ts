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
import type { PullRequestProvider } from "./pullRequestProvider.js";
import type { PullRequestSync } from "./pullRequestSync.js";
import type { WorkItemPullRequestRepo } from "./workItemPullRequestRepo.js";
import type { SquadRunLifecycle } from "./squadRunLifecycle.js";
import type { SquadDispatchRequestHub } from "./squadDispatchRequests.js";
import type { SquadRunRepo } from "./squadRunRepo.js";
import type { WakeRuleRepo } from "./wakeRuleRepo.js";
import type { WorkItemActivityProjector } from "./workItemActivityProjector.js";
import type { WorkItemDeliverableRecorder } from "./workItemDeliverableRecorder.js";
import type { WorkItemDeliverableRepo } from "./workItemDeliverableRepo.js";
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
  /**
   * **GitHub PR 快照的 token 读取口**（#8 D2，可选加法）：组合根维护的**单点同步快照**
   * （与 `readExperimentEnabled` 同一手法：`ISettingService` 只有异步 `get()`，而 provider 的
   * `describe()` 是同步判据）。
   *
   * 为什么传**读取函数**而不是 token 值：runtime 按目标现构、不缓存，而 token 是**运行期可改**的设置
   * ——读函数让「设置里刚配好/刚清空」在下一次刷新即生效，不必重建 runtime。
   * 缺省（不注入）⇒ 恒未配置 ⇒ null adapter（离线缺省形态：PR 区只显示手动登记的链接）。
   */
  readGithubPullRequestToken?: () => string | undefined;
  /**
   * GitHub REST 的 **fetch 注入面**（#8 D2，**测试专用**）：缺省 = 全局 fetch（生产形态）。
   * 注入 stub 后可在不联网的前提下断言请求形状（API 地址 / Bearer 头）与全部错误面 ——
   * 真实网络调用不做单测（无真实 token；真网络登记是人工演示项）。
   */
  githubFetch?: typeof fetch;
};

export type SquadRuntime = {
  workItemRepo: WorkItemRepo;
  wakeRuleRepo: WakeRuleRepo;
  squadRunRepo: SquadRunRepo;
  /** R2：deferred 重放义务表（C4b）：服务面读取/推进扫描用；写入唯一入口仍是 lifecycle。 */
  squadDeferredDispatchRepo: import("./squadDeferredDispatchRepo.js").SquadDeferredDispatchRepo;
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
  /**
   * 工作项 Activity 的投影器（**加法**，C3b.1）：状态/负责人两个写者与 runtime 共用**同一份**判据
   * （键形状、payload、actor 全在投影模块内）。为什么放在 runtime 上而不是每处现建：`applyWorkItemAssignee`
   * 与 `archiveSquadAndTransfer` 只拿得到 runtime 这一件东西；投影器本身**拿不到派发面**
   * （依赖集封顶为 activities + 注入），放在这里不会给协作链任何驱动力。
   */
  activityProjector: WorkItemActivityProjector;
  /**
   * **工作项级交付物的存储面**（#7 D1b，`work_item_deliverables` 表，迁移 0016）：服务面的读模型
   * （协作读的 `deliverables` + 单条正文三态）经它取数。
   *
   * 为什么放在 runtime 上：交付物是**按 workspace** 的事实（行里带 `workspace_key/path`，正文文件落
   * `<workspace>/.zcode/squad/deliverables/`），而 runtime 正是「为某一个目标 workspace 现构」的那件
   * 东西 —— 另建一个跨目标的 repo 单例会让读落到别的 workspace 上（与 `squadRunRepo` /
   * `inboxItemRepo` 同一条理由）。
   */
  deliverableRepo: WorkItemDeliverableRepo;
  /**
   * **交付物登记面**（#7 D1b 的接线点）：两个自动捕获点（lifecycle 的 approved 臂 / 编排器的
   * finalize 臂）与手动登记（服务面 link）**共用这一份实现**。
   *
   * 为什么必须由组合根造且只造一个：id/幂等键派生、正文落盘、表登记、第 20 枚回声五件事必须逐字
   * 一致；两处各建一份的表现是「同一次合并产生两条交付物」或「人工登记被记成系统登记」，都不报错。
   * 构造点唯一在组合根（接线钉死测试钉住）—— 调用方只经本字段用，不自建第二份。
   */
  deliverableRecorder: WorkItemDeliverableRecorder;
  /**
   * **PR 关联 + 快照的存储面**（#8 D2，`work_item_pull_requests` 表，迁移 0017）：关联是**按 workspace**
   * 的事实（行里带 `workspace_key/path`），故与 `deliverableRepo` 同一条理由挂在 runtime 上
   * （另建跨目标单例会让读落到别的 workspace）。
   */
  pullRequestRepo: WorkItemPullRequestRepo;
  /**
   * **PR 读数面**（#8 D2 的 seam）：缺省 = 「没配 token」的 null adapter；配了 token ⇒ GitHub PAT
   * adapter。放在 runtime 上是因为它按**这张 workspace 的设置快照**判定可用性（token 读取口由组合根
   * 注入），且 `describe()` 要能同步回答（UI 的「未配置 token」呈现不额外付一次往返）。
   */
  pullRequestProvider: PullRequestProvider;
  /**
   * **PR 快照同步深模块**（#8 D2）：按需刷新一个工作项下的已链接 PR。挂在 runtime 上使
   * 「取哪张 workspace 的行」与其它零件同一口径；D3 的终态驱动消费它报出的 `mergedPullRequests`。
   */
  pullRequestSync: PullRequestSync;
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
