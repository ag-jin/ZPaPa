import type { TasksIndexDatabase } from "../session/taskIndexRepo.js";
import type { SquadService } from "../teams/squadService.js";
import type { TeamAgentService } from "../teams/teamAgentService.js";
import type { createBranchAllocator } from "../worktree/branchNaming.js";
import type { GitRunner } from "../worktree/gitRunner.js";
import type { createIntegrationMerger } from "../worktree/integrationMerge.js";
import type { createOrphanReaper } from "../worktree/orphanReaper.js";
import type { WorktreeManager } from "../worktree/worktreeManager.js";
import type { SquadRunLifecycle } from "./squadRunLifecycle.js";
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
};

export type SquadRuntime = {
  workItemRepo: WorkItemRepo;
  wakeRuleRepo: WakeRuleRepo;
  squadRunRepo: SquadRunRepo;
  workItemService: WorkItemService;
  teamAgentService: TeamAgentService;
  squadService: SquadService;
  git: GitRunner;
  worktreeManager: WorktreeManager;
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
