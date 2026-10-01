import { resolveWorkspaceKey, type Squad, type TeamAgent, type WorkItem } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CreateSquadInput } from "../teams/squadService.js";
import type { CreateTeamAgentInput } from "../teams/teamAgentService.js";
import type { ReapOutcome } from "../worktree/orphanReaper.js";
import type { SquadRuntime } from "./squadContracts.js";
import type { MemberRunRequest, OpenMemberRunResult, ReviewOutcome } from "./squadRunLifecycle.js";
import type { SquadRunRecord } from "./squadRunRepo.js";

/* 小队运行时的**服务面**：UI / host / 工具三处都只经这个描述符取数或触发派发。

   **本文件必须保持浏览器安全**：`packages/services/src/index.ts` 用**值**导入导出它
   （描述符要在 renderer 侧可达），而根入口的运行时依赖一旦触达 `node:*`，整包会在 React 挂载前失败
   （现场是「页面停在启动壳、没有报错浮层」，见 browserSafeRootEntry.test.ts）。
   所以这里对 node 侧模块只用 `import type`，实现函数 `createSquadRuntimeService` 的依赖
   （建 runtime 的工厂、读设置、归档转交）全部由**调用方注入**（node.ts）。
   这与既有约定一致：描述符可从根入口取，实现从 `@zcode/services/node` 取。 */

export type SquadWorkspaceTarget = { path: string; identity: string };

export type SquadSnapshot = {
  /** **只读呈现用**（UI 据此隐藏 / 禁用入口）——**它不是门禁**；门禁是下面的 assertDispatchEnabled。 */
  enabled: boolean;
  teamAgents: TeamAgent[];
  squads: Squad[];
  workItems: WorkItem[];
  /** 只列**未合并**的 run（`SquadRunRepo.listActive` 的口径）：最小视图关心的是「还欠收尾的那些」。 */
  runs: SquadRunRecord[];
};

export type CreateWorkItemRequest = {
  title: string;
  body?: string;
  parentId?: string;
  assignee: WorkItem["assignee"];
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
  openMemberRun(
    target: SquadWorkspaceTarget,
    input: MemberRunRequest,
  ): Promise<OpenMemberRunResult>;
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

/**
 * 服务实现。依赖全部由组合根注入（本文件不得 import node 侧的值）。
 *
 * 关于「读开关」的纪律（确认 2）：门禁的判据**只有** `runtime.assertDispatchEnabled` 一处；
 * 这里注入的 `readExperimentEnabled` **只服务 `getSnapshot().enabled`**（UI 呈现用），
 * 它就算读到相反的值也不构成门禁。反过来，`assertDispatchEnabled` / `createWorkItem` /
 * `openMemberRun` 三处都调**同一个** runtime 方法，所以「改一处漏一处」在结构上不成立。
 */
export function createSquadRuntimeService(deps: {
  /** 按目标现构 runtime（裁定 4 + 确认 3：不缓存、不取首个）。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /** 只读呈现用（UI 据此隐藏 / 禁用入口）。**不是门禁**，门禁是 runtime.assertDispatchEnabled。 */
  readExperimentEnabled: () => Promise<boolean>;
  /**
   * 归档 + 指派转交（组合逻辑在 `squadRuntime.ts`：它要用 workItemRepo，而描述符这一侧必须浏览器安全，
   * 不能值导入那个模块）。由组合根注入。
   */
  archiveSquadAndTransfer: (target: SquadWorkspaceTarget, id: string) => Promise<void>;
}): ISquadRuntimeService {
  /** 本 runtime 的 `workspace_key`（C14 口径）：台账与快照都按它过滤。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

  return {
    async assertDispatchEnabled(target) {
      // 唯一判据的转发：判定逻辑在 runtime 里，这里不再读任何设置。
      await (await deps.createRuntime(target)).assertDispatchEnabled();
    },

    async getSnapshot(target) {
      const runtime = await deps.createRuntime(target);
      return {
        enabled: (await deps.readExperimentEnabled()) === true,
        teamAgents: runtime.teamAgentService.list(),
        squads: runtime.squadService.list(),
        workItems: runtime.workItemRepo.listByWorkspace(keyOf(runtime)),
        runs: runtime.squadRunRepo.listActive(keyOf(runtime)),
      };
    },

    async createTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.create(input);
    },

    async createSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.create(input);
    },

    async createWorkItem(target, input) {
      const runtime = await deps.createRuntime(target);
      // 入口② 的闸：**先**判门禁，再建项（拦在入口，不是拦在半路——半路拦会留下一条已入队的工作项）。
      await runtime.assertDispatchEnabled();
      // workspace 列取自 runtime 的绑定值而不是入参 target：runtime 才是「为哪个 workspace 而构造」的权威。
      return runtime.workItemService.create({
        workspaceIdentity: runtime.boundWorkspace.identity,
        workspacePath: runtime.boundWorkspace.path,
        title: input.title,
        body: input.body,
        parentId: input.parentId,
        assignee: input.assignee,
      });
    },

    async openMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      // 入口①（队员段）与入口③ 共用的这一道闸。
      await runtime.assertDispatchEnabled();
      return runtime.lifecycle.openMemberRun(input);
    },

    // 以下三个**不过门禁**：收尾 / 审查 / 回收都不是「新派发」。
    // 关掉开关时若把它们也拦下，正在跑的那批 run 会卡在中间状态（spec §5.7.6 只停新派发）。
    async completeMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.completeMemberRun({ runId: input.runId });
    },

    async reviewMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.reviewMemberRun({ runId: input.runId, verdict: input.verdict });
    },

    async reapStartupOrphans(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.reapStartupOrphans({ workspaceKey: keyOf(runtime) });
    },

    async archiveSquadAndTransfer(target, id) {
      await deps.archiveSquadAndTransfer(target, id);
    },
  };
}
