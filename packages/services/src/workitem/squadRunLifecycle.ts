import { resolveWorkspaceKey } from "@zcode/shared";
import {
  memberDirName,
  planBranches,
  type createBranchAllocator,
} from "../worktree/branchNaming.js";
import type { createIntegrationMerger } from "../worktree/integrationMerge.js";
import type { createOrphanReaper, ReapOutcome } from "../worktree/orphanReaper.js";
import type { WorkItemService } from "./workItemService.js";
import { slugForId } from "./slug.js";
import type { SquadRunRepo } from "./squadRunRepo.js";

/* 小队运行生命周期的**机械半**（spec §6.1–§6.3）：开树 / 收尾 / 审查 / 抛弃 / 启动回收。

   为什么它是独立一层、且只收「自己要用的零件」：`SquadRuntime` 里含 `lifecycle`，
   lifecycle 若反过来收 `SquadRuntime` 就是自引用（构造顺序无解）。装配顺序由
   `createSquadRuntime` 负责（先建零件、再建 lifecycle、最后拼成 runtime）。

   本层**不写工作项状态**（除 `completeMemberRun` 里那一次 by-design 的推进，且走 `workItemService`）：
   唯一写者不变。冲突解不了时的 `blocked` + 进 Inbox 由 Wave 2 的批次层做（它知道整批的上下文），
   本层只把「没合成」这个事实原样报出去。 */

export type MemberRunRequest = {
  runId: string;
  workItemId: string;
  parentWorkItemId: string;
  agentId: string;
  isLeaderTask: boolean;
};

export type OpenMemberRunResult = { branch: string; worktreePath: string };

export type ReviewOutcome =
  | { ok: true; merged: true }
  | { ok: true; merged: false; kept: true }
  | { ok: false; reason: "conflict" | "branch_missing"; detail: string };

export interface SquadRunLifecycle {
  openMemberRun(request: MemberRunRequest): Promise<OpenMemberRunResult>;
  completeMemberRun(input: { runId: string }): Promise<void>;
  /** 硬约束 2 的**唯一**口径来源：未合并的队员分支（含被打回待修的）。 */
  computeActiveBranches(workspaceKey: string): Promise<string[]>;
  reapStartupOrphans(input: { workspaceKey: string }): Promise<ReapOutcome>;
  reviewMemberRun(input: {
    runId: string;
    verdict: "approved" | "rejected";
  }): Promise<ReviewOutcome>;
  discardMemberRun(input: { runId: string }): Promise<void>;
}

export function createRunLifecycle(deps: {
  squadRunRepo: SquadRunRepo;
  workItemService: WorkItemService;
  baseBranch: string;
  branchAllocator: ReturnType<typeof createBranchAllocator>;
  integrationMerger: ReturnType<typeof createIntegrationMerger>;
  orphanReaper: ReturnType<typeof createOrphanReaper>;
  /**
   * 本 lifecycle 绑定的目标 workspace（裁定 4 + 确认 3）。
   *
   * 必须由 deps 给出而不是从入参推：`MemberRunRequest` 里**没有** workspace 字段
   * （冻结接口如此），而台账行需要 `workspace_key` / `workspace_path` 两列，且
   * 「异己 workspaceKey ⇒ 抛」也需要一个**权威的**绑定值来比对。
   */
  boundWorkspace: { path: string; identity: string };
}): SquadRunLifecycle {
  const {
    squadRunRepo,
    workItemService,
    baseBranch,
    branchAllocator,
    integrationMerger,
    orphanReaper,
  } = deps;

  // 台账行的 workspace_key 用与 Task/实时通道**同一处**口径（C14：identity 去空白优先，否则 path）。
  // 自己拼一遍会让「快照按 workspace 过滤」与「run 按 workspace 过滤」悄悄对不上。
  const boundWorkspaceKey = resolveWorkspaceKey({
    workspacePath: deps.boundWorkspace.path,
    workspaceIdentity: deps.boundWorkspace.identity,
  });

  /**
   * 异己 workspaceKey ⇒ **抛**（裁定 4 / 确认 3）。
   *
   * 为什么必须响亮：本 lifecycle 是为**某一个** workspace 构造的，台账里的
   * `workspace_key` 与 git 的仓库根都是它的。传进来另一个 key 时若「按传入值操作」，
   * 就会在**另一个 workspace 上**读写（用户看到的是「我明明没建过」），而两边都不报错。
   * 文案带上**两侧的值**，否则收到错误的人无法判断是哪一层拿错了目标。
   */
  function assertOwnWorkspace(workspaceKey: string): void {
    if (workspaceKey !== boundWorkspaceKey) {
      throw new Error(
        `workspaceKey 不属于本 runtime：本方绑定「${boundWorkspaceKey}」（${deps.boundWorkspace.path}），` +
          `收到「${workspaceKey}」。runtime 为某一个目标 workspace 而构造，任何异己 key 一律拒绝` +
          "（静默按传入值操作 = 在另一个 workspace 上读写）。",
      );
    }
  }

  /** 由 runId 取台账行；取不到就抛（台账无删除路径，行缺失只可能是 runId 算错）。 */
  function requireRun(runId: string) {
    const record = squadRunRepo.get(runId);
    if (!record) {
      throw new Error(
        `squad_runs 没有 runId=「${runId}」的行：调用方传错 runId，或台账被外部改动。` +
          "静默跳过会让这次调用看起来成功了，而那个 run 仍停在旧状态。",
      );
    }
    return record;
  }

  /** 由 run 的 workItemId / agentId 还原分支计划：分支命名规则只有 `planBranches` 一处定义。 */
  function planForRun(record: { workItemId: string; agentId: string }) {
    return planBranches({
      workItemSlug: slugForId(record.workItemId),
      agentSlug: slugForId(record.agentId),
    });
  }

  /**
   * 硬约束 2 的**唯一口径来源**：未合并的队员分支（含被打回待修的 `rejected`）。
   *
   * **禁止旁路**：启动回收、批次收尾、任何「哪些工作树还该活着」的问题都必须经本函数；
   * 另建一套判据（例如「当前有没有在跑的 run」）会让被打回待修的工作树在下次启动被静默回收
   * （spec §6.2 / §16 S5 失效，且不报错）。口径本身由 `SquadRunRepo.listActive`
   * （`SQUAD_RUN_ACTIVE_STATUSES`）定义，本层只做投影。
   */
  async function computeActiveBranches(workspaceKey: string): Promise<string[]> {
    assertOwnWorkspace(workspaceKey);
    return squadRunRepo
      .listActive(workspaceKey)
      .map((record) => record.branch)
      .filter((branch): branch is string => branch !== null && branch !== "");
  }

  return {
    async openMemberRun(request) {
      // `assertSafeSlug` 由 planBranches 的消费方（allocator / memberDirName）负责：
      // 这里刻意不再校验一遍，免得同一道闸在两处各写一份。
      /* `isLeaderTask` 只被**记录**，本层不因它改变动作（brief 的机械半明文如此）：
         「队长 run 不建工作树」（spec §6.1/§6.2）由**调用方**决定要不要调本方法——
         队长 run 直接在目标工作区执行，不经过开树这一步。所以若调用方带着
         `isLeaderTask: true` 进来，本层照样会开一棵树，这是**按契约执行**而不是漏判；
         真要禁止，应在调用方（派发桥）分叉，而不是在这里猜。 */
      const plan = planBranches({
        workItemSlug: slugForId(request.workItemId),
        agentSlug: slugForId(request.agentId),
      });
      const now = Date.now();

      /* **先落台账、后建树**（顺序不可颠倒）。
         反过来（树建好了而台账里没有这一行）时若在两者之间崩溃：下一次启动的回收
         看不见这条 run ⇒ 分不出「活跃」⇒ 队员**未提交**的成果会被当孤儿连树带枝收掉，
         spec §6.2「审查被拒必须存活到合并」当场落空，且回收过程不报错。
         台账先写、树后建，最坏结果是「台账里有一条 open 行而没有树」——那是可被下一次
         openMemberRun 或人工看到的显式状态，不会静默丢活。 */
      squadRunRepo.insert({
        runId: request.runId,
        workspaceKey: boundWorkspaceKey,
        workspacePath: deps.boundWorkspace.path,
        workItemId: request.workItemId,
        parentWorkItemId: request.parentWorkItemId,
        agentId: request.agentId,
        isLeaderTask: request.isLeaderTask,
        branch: plan.member,
        // 目录名从**同一个 plan** 派生（终审 M7：判定用分支、动作用目录名，两者必须同源）。
        dirName: memberDirName(plan),
        status: "open",
        sessionId: null,
        createdAt: now,
        updatedAt: now,
      });

      // 建树失败（分支残枝 / base 不存在 / 目录冲突）**原样抛出**：上面的台账行保留，
      // 那是「这条 run 已经开过」的事实，不该被下面的失败抹掉（台账没有删除路径，也不该有）。
      const { memberPath } = await branchAllocator.allocate(plan, baseBranch);
      return { branch: plan.member, worktreePath: memberPath };
    },

    async completeMemberRun({ runId }) {
      const record = requireRun(runId);
      // 台账状态：产出即 `produced`（该分支从此算「活跃」——已产出未合并，spec §6.2 要求它活到合并）。
      squadRunRepo.setStatus(runId, "produced");
      /* 工作项推进到 `in_review` 走**工作项服务**（唯一写者不变）。
         CAS 未命中**不抛**（spec §5.7 第 5 项「不匹配则丢弃并记事件，不报错」）：
         产物已经产出了，若因为父项状态被别人改过就抛，队员的成果会连状态一起丢掉。 */
      workItemService.transition(record.workItemId, "in_review", "in_progress");
    },

    /**
     * 硬约束 2 的**唯一口径来源**：未合并的队员分支（含被打回待修的 `rejected`）。
     *
     * **禁止旁路**：启动回收、批次收尾、任何「哪些工作树还该活着」的问题都必须经本方法；
     * 另建一套判据（例如「当前有没有在跑的 run」）会让被打回待修的工作树在下次启动被静默回收
     * （spec §6.2 / §16 S5 失效，且不报错）。口径本身由 `SquadRunRepo.listActive`
     * （`SQUAD_RUN_ACTIVE_STATUSES`）定义，本层只做投影。
     */
    computeActiveBranches,

    async reapStartupOrphans({ workspaceKey }) {
      assertOwnWorkspace(workspaceKey);
      // 活跃集合**必须**取自上面那个唯一口径（调同一个函数，而不是在这里重新算一遍）。
      const activeBranches = await computeActiveBranches(workspaceKey);
      return orphanReaper.reap({ activeBranches });
    },

    async reviewMemberRun({ runId, verdict }) {
      const record = requireRun(runId);

      if (verdict === "rejected") {
        /* 打回待修：只改台账状态，**工作树一个字节不动**（spec §6.2「审查被拒时必须存活到合并」）。
           删树/删分支要等到它被合并（或整批被放弃）时，由批次层的 discard 走。 */
        squadRunRepo.setStatus(runId, "rejected");
        return { ok: true, merged: false, kept: true };
      }

      const plan = planForRun(record);
      // 集成分支的创建**隐式**发生在 mergeMember 里（它的派生点只有 base 一处），
      // 这里显式先建一次只为让「集成分支不存在」这类失败与「队员分支不存在」分开报。
      await integrationMerger.ensureIntegration(plan.integration);
      const outcome = await integrationMerger.mergeMember({
        integration: plan.integration,
        member: plan.member,
      });

      if (outcome.ok) {
        squadRunRepo.setStatus(runId, "merged");
        return { ok: true, merged: true };
      }

      /* 冲突 / 分支不存在：台账**保持 `produced`**，本层不写工作项状态。
         「置 blocked + 进 Inbox」需要整批的上下文（§5.7 第 4 项说由队长 run 解决、解不了才 blocked），
         属 Wave 2 的批次层。这里少写一次状态，好过在这里写一个没人能撤销的 blocked。 */
      return { ok: false, reason: outcome.reason, detail: outcome.detail };
    },

    async discardMemberRun({ runId }) {
      const record = requireRun(runId);
      if (record.branch === null || record.dirName === null) {
        throw new Error(
          `runId=「${runId}」没有工作树（队长 run 不建树），无法抛弃：它本来就没有可抛弃的工作面`,
        );
      }
      // 摘树 + 删分支（顺序与配对校验都在 discardMember 内部）。
      await integrationMerger.discardMember({ branch: record.branch, dirName: record.dirName });
      squadRunRepo.setStatus(runId, "discarded");
    },
  };
}
