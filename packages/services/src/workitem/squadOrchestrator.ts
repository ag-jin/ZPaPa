import { resolveWorkspaceKey } from "@zcode/shared";
import { planBranches } from "../worktree/branchNaming.js";
import { ensureGitRunSucceeded } from "../worktree/gitRunner.js";
import { deleteBranch } from "../worktree/integrationMerge.js";
import type { SquadBatchOrchestrator, SquadRuntime } from "./squadContracts.js";
import type { SquadRunRecord } from "./squadRunRepo.js";
import { slugForId } from "./slug.js";

/* 批次编排（spec §6.3 / §6.2 / §5.7.3 / §5.7.4 / §16 S4 S5 S17）。

   为什么它必须与生命周期机械半（`squadRunLifecycle.ts`）分开：机械半只管**一次 run**（开树 / 上报 /
   审查 / 抛弃），而 spec 的语义几乎**全在批次层** —— 「子项**全部** category ∈ {done, closed} 才触发」
   （§5.7.3）、「**串行**合并 / 整批通过才合回主分支 / 冲突解不了 → `blocked` + 进 Inbox」（§5.7.4）、
   「审查未通过前工作树**存活**」（§6.2）、「合并后分支删（队员与集成**都**删）」（§6.3）。
   这些要**同时**读工作项状态与 run 台账 —— 属**策略**，塞进机械半会让它变成两件事都做的混合体。

   三条本层必须守的边界：
   1. **工作项状态只能经 `workItemService.transition` 写**（唯一写者不变）。本层不碰 repo 的
      `updateStatus`，也不自己拼状态；
   2. **不读实验开关**（门禁的唯一读取点在组合根，服务层单点收口）：本层是「已经允许派发」之后
      的收尾路径，再读一次开关就多一份判据、且会做出「关掉实验就中断在途 run」这种被 spec
      §5.7.6 明文禁止的事；
   3. **不发明「活跃」口径**：哪些工作树还该活着一律走 `SquadRunRepo.listActive`（硬约束 1），
      本层只做「这一批该合哪些、该抛哪些」的判定。 */

export function createSquadOrchestrator(deps: { runtime: SquadRuntime }): SquadBatchOrchestrator {
  const { runtime } = deps;
  const { workItemRepo, workItemService, squadRunRepo, lifecycle, integrationMerger, baseBranch } = runtime;

  /* 本 runtime 绑定的 `workspace_key`（C14 口径，与生命周期/快照同一处算法），以及异己 key 的**响亮拒绝**。
     为什么必须拒绝而不是「按传入值操作」：本层会用这个 key 判归属、也会按它去动 git；在**另一个**
     workspace 上读写时用户看到的是「我没建过这条」，而两边都不报错（裁定 4 / 确认 3）。 */
  const boundWorkspaceKey = resolveWorkspaceKey({
    workspacePath: runtime.boundWorkspace.path,
    workspaceIdentity: runtime.boundWorkspace.identity,
  });

  function assertOwnWorkspace(workspaceKey: string): void {
    if (workspaceKey !== boundWorkspaceKey) {
      throw new Error(
        `workspaceKey 不属于本 runtime：本方绑定「${boundWorkspaceKey}」（${runtime.boundWorkspace.path}），` +
          `收到「${workspaceKey}」。批次编排为某一个目标 workspace 而构造，任何异己 key 一律拒绝。`,
      );
    }
  }

  /* **内存串行队列**（同一个父项一条链）。
     为什么需要：合并的实现是「检出集成分支 → git merge」，而主工作树的 HEAD 只有一份 —— 同批两次
     `advanceAfterChildrenDone` 并发进来会互相踩（检出被对方挪走、`merge --abort` 把对方的合并一起回滚）。
     `integrationMerge.ts` 的 doc 已写明「本模块不做锁、串行是调用方约束」，这里就是那个调用方，
     所以本层必须兜住。
     **本层不做跨进程锁**（也不该做）：两个进程同时收尾同一批时，正确性靠 git 自己的失败
     （第二次 `merge` / `branch -D` 会在 git 侧响亮报错），而不是靠本层假装自己是分布式锁。 */
  const chains = new Map<string, Promise<void>>();

  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const current = previous.then(task);
    // 队列里存「不会 reject」的那一份：一次失败不该毒化后续调用（否则后续调用会继承一个 rejected
    // 前驱，`then(task)` 直接跳过 task，调用方拿到上一个错误 —— 一个与它无关的失败）。
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
      // 链尾清账：不留永久增长的 Map（每个父项一条，收尾完成后即删）。
      if (chains.get(key) === settled) chains.delete(key);
    });
    return current;
  }

  /**
   * 本批的**队员** run（按 `createdAt` 升序 —— 串行次序必须确定，否则「谁先被合并」会随存储顺序漂移）。
   *
   * 只取 `branch !== null` 的：队长 run 也写台账（`is_leader_task=1`），但它不建树、不产分支，
   * 既没有可合并的成果，也没有可抛弃的工作面（spec §6.1：队长 run 直接在目标工作区执行）。
   * 判据用 `branch` 而不是 `isLeaderTask`：本层要的是「有没有可操作的分支」这件事实，
   * 而不是「谁发起的」这个身份。
   */
  function memberRuns(parentWorkItemId: string): SquadRunRecord[] {
    return squadRunRepo
      .listByParent(parentWorkItemId)
      .filter((record) => record.branch !== null)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * 本批的集成分支名。命名规则的唯一来源是 `planBranches`：**不从 `INTEGRATION_NAMESPACE`
   * 直接拼 slug** —— 那等于把 `planBranches` 的定义抄第二份，命名规则一改就会出现两处判据。
   * `agentSlug` 只用于满足入参形状（`integration` 只取决于 `workItemSlug`），取本批某个队员的 slug。
   *
   * **一批只能有一条集成分支**：整批通过才合回主分支的前提是「主分支上要么整批都在、要么一个都不在」。
   * 队员分属两个工作项时会有两条集成分支，而 `finalize` 只能落一条 —— 先落的那条会让
   * 「整批可整体放弃」当场失效（部分成果已在主分支上，且回不去）。故这种形状**响亮拒绝**，
   * 而不是挑一条落一半（静默的半批）。变通方向在派单侧：一名队员的工作项即批的工作项。
   */
  function integrationBranch(runs: readonly SquadRunRecord[]): string {
    const workItemIds = [...new Set(runs.map((record) => record.workItemId))];
    const [only] = workItemIds;
    if (only === undefined) {
      throw new Error("本批没有任何队员 run：调用方应当先判有无成员，而不是在这里猜集成分支");
    }
    if (workItemIds.length > 1) {
      throw new Error(
        `本批的队员分属 ${workItemIds.length} 个工作项（${workItemIds.join(" / ")}）：一批只能落到一条集成分支。`,
      );
    }
    return planBranches({
      workItemSlug: slugForId(only),
      agentSlug: slugForId(runs[0]!.agentId),
    }).integration;
  }

  /** 分支是否存在的**只读**判断（不动 git 的任何登记/引用）。 */
  async function branchExists(branch: string): Promise<boolean> {
    const result = await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
      cwd: runtime.boundWorkspace.path,
    });
    return result.code === 0;
  }

  /**
   * 让**主工作树**别再检出 `branch`（本题里特指集成分支）。
   *
   * 为什么整体放弃时必须做这一步：`git branch -D` 拒绝删除正被工作树检出的分支
   * （实测 `error: Cannot delete branch '…' checked out at '…'`），而集成分支**大概率正被主工作树检出**
   * —— 队员合并就是在主工作树上做的（`integrationMerge` 的调用方约束写明「合并会挪走主工作树的 HEAD」，
   * 它内部 `git checkout` 的是集成分支）。整体放弃要删的恰恰是这条「还没合回主分支」的集成分支，
   * 所以先把 HEAD 挪回 base，再删。
   *
   * 只在 HEAD 真指着它时才动：无关时去 `checkout` 是凭空的副作用（会把用户的工作面换成 base 的内容）。
   */
  async function detachFromHead(branch: string): Promise<void> {
    const head = await runtime.git(["symbolic-ref", "--short", "HEAD"], {
      cwd: runtime.boundWorkspace.path,
    });
    if (head.code !== 0 || head.stdout.trim() !== branch) return;
    ensureGitRunSucceeded(
      `git checkout ${baseBranch}（整体放弃前把主工作树挪回 base）`,
      await runtime.git(["checkout", baseBranch], { cwd: runtime.boundWorkspace.path }),
    );
  }

  /**
   * 子项全部终态后收尾整批（spec §5.7.3 / §5.7.4 / §6.3）。
   *
   * 次序与理由：
   * 1. 子项没全终态 → **直接返回**（不做半批：一个还没产出的队员会被无声跳过，而主分支已经落了一半的活）；
   * 2. 逐个队员**串行**合并（`reviewMemberRun(approved)` 是「合一个队员进集成分支」的**唯一实现**，
   *    本层不重写一份 `ensureIntegration + mergeMember + setStatus`）；
   * 3. 任一次冲突 → 父项 `blocked`（CAS 写）+ 停手（后面的成员不再合，主分支一个字节不动）；
   * 4. 全通过 → `finalize`（整批一次性合回主分支）→ 抛弃已 merged 的队员 → 删集成分支 → 父项 `done`。
   */
  async function advanceAfterChildrenDone(input: {
    workspaceKey: string;
    parentWorkItemId: string;
  }): Promise<void> {
    assertOwnWorkspace(input.workspaceKey);
    // §5.7.3 的判据在 repo 层（`areAllChildrenTerminal` 内部按 **category** 判，不是键名比较）：
    // 本层只消费它，不在这里再判一次（两处判据迟早分叉，而分叉的表现就是「批永远收不了尾」）。
    if (!workItemRepo.areAllChildrenTerminal(input.parentWorkItemId)) return;

    await serialize(input.parentWorkItemId, async () => {
      const runs = memberRuns(input.parentWorkItemId);

      /* `open` 的队员 run 与「子项全部终态」自相矛盾：要么队员还没上报完成（子项不该是终态），
         要么上报丢了。此时**无法判断它的活该不该合**，所以既不静默跳过（会丢一个队员的成果、
         还不报错），也不半批合并 —— 响亮抛出，交给调用方（host 会记 error）。
         注：`rejected` 不在此列，它是**已产出、被审查打回**的合法状态（见下面 S5 的处理）。 */
      const stillRunning = runs.filter((record) => record.status === "open");
      if (stillRunning.length > 0) {
        throw new Error(
          `子项已全部终态，但队员 run 仍停在 open（${stillRunning.map((r) => r.runId).join(" / ")}）：` +
            "状态自相矛盾，无法判断这份产出该不该合，拒绝半批合并。",
        );
      }

      /* 本批没有任何队员产出（例如子项都在派单前被取消）：没有可落地的成果。
         不调 `finalize`（集成分支压根不存在，那会报「分支不存在」），直接把父项按「批已结算」收口。
         为什么是 `done` 而不是 `cancelled`：「父项该不该被放弃」是另一个语义（谁有权判定计划被放弃），
         不由本层从子项 category 反推 —— 那会把一个策略决定藏进收尾路径。 */
      if (runs.length === 0) {
        workItemService.transition(input.parentWorkItemId, "done", "in_review");
        return;
      }

      const integration = integrationBranch(runs);
      const pending = runs.filter((record) => record.status === "produced");

      /* 幂等重放闸：本批没有待合队员、且集成分支已经不在（上一次收尾把它删了）⇒ 已经收过尾，空转返回。
         为什么必须有它：`child_completed` 是**事件驱动**的（host 订阅后转发），同一事实重复投递
         （重连 / 重复挂订阅 / 调用方重试）会让本方法被同一批调用两次；第二次若照旧走 `finalize`，
         会拿到「集成分支不存在」而抛 —— 把一次幂等重放变成一次响亮失败，与 §5.7.5 的幂等口径相反。 */
      if (pending.length === 0 && !(await branchExists(integration))) return;

      /* **串行合并**（一次一个，次序 = createdAt 升序）。合并目标与判定都在
         `lifecycle.reviewMemberRun` 里（唯一的「合一个队员」实现）：
         - `produced` → 合进集成分支；首次合并时集成分支**从 base 隐式派生**；
         - 冲突 → 台账保持 `produced`（本层不许回退它），由下面的分支决定父项处置。 */
      for (const record of pending) {
        const outcome = await lifecycle.reviewMemberRun({ runId: record.runId, verdict: "approved" });
        if (outcome.ok) continue;

        if (outcome.reason === "conflict") {
          /* spec §5.7.4 / §16 S17：解不了的冲突 → 父项 `blocked` + 进 Inbox，**且不提前合回主分支**。
             P2b 里「进 Inbox」的机械形态就是这条 `blocked` 变迁本身：它经 `workItemService.transition`
             发 `workitem.status_changed{to:"blocked"}`（工作项事件的**唯一**出口），人据此看到「这条卡住了」。
             （完整 Inbox 语义——已读 / 归档 / 严重级 / 订阅者——明属 P2c，见计划「明确不在本计划」表。）
             CAS 未命中（父项不在 `in_review`）时**丢弃且不报错**（§5.7.5）：改状态的权力在 CAS 上。 */
          workItemService.transition(input.parentWorkItemId, "blocked", "in_review");
          return; // 立即停手：后面的成员不再合，主分支一个字节都没动
        }

        /* `branch_missing` 不是冲突：队员分支不存在说明清理/派单出了问题（或有人在脚下动了 git），
           把它当冲突处置会让用户去「解一个不存在的冲突」。响亮抛出，原样交给调用方。 */
        throw new Error(
          `队员分支不存在，无法合入集成分支（这**不是**冲突）：${outcome.detail}（runId=${record.runId}）`,
        );
      }

      const landed = await integrationMerger.finalize({ integration, target: baseBranch });
      if (!landed.ok) {
        if (landed.reason === "conflict") {
          // 与逐队员冲突同一处置：父项 blocked + 停手（`finalize` 内部已把主工作树回滚到合并前）。
          workItemService.transition(input.parentWorkItemId, "blocked", "in_review");
          return;
        }
        // 集成分支 / base 分支不存在：既不是「冲突」也不是「本批没成果」，属环境或次序被破坏。
        // 把父项标 done 是谎报（成果没落地），标 blocked 会误导人去解冲突 —— 响亮抛出。
        throw new Error(`整批合回 ${baseBranch} 失败（不是冲突）：${landed.detail}`);
      }

      /* 抛弃集合 = **已 merged 的**（含本批刚合的与更早经审查合过的）。
         不抛 `rejected`：spec §6.2 / §16 S5 要求被打回待修的工作树**存活到修复并合并**，
         提前删就是丢掉一个队员的活（而它的产出不在集成分支上，删了也换不回任何东西）。
         `discarded` 早已无树无枝，跳过即可。 */
      for (const record of await squadRunRepo.listByParent(input.parentWorkItemId)) {
        if (record.branch !== null && record.status === "merged") {
          await lifecycle.discardMemberRun({ runId: record.runId });
        }
      }
      // 集成分支的删除**只在整批合回主分支之后**（§6.3）：`discardIntegration` 内部会验证
      // 「集成是 target 的祖先」，所以它自己就是那道闸，本层不重复判定。
      await integrationMerger.discardIntegration({ integration, target: baseBranch });
      workItemService.transition(input.parentWorkItemId, "done", "in_review");
    });
  }

  /**
   * 整批放弃（用户取消，spec §6.3「整批可整体放弃」）：逐个抛弃队员 → 删集成分支 → 父项 `cancelled`。
   *
   * 与 `advanceAfterChildrenDone` 的刻意差异：
   * 1. **不要求子项终态**：用户可以在批进行到一半时整体放弃 —— 那正是「主分支干净」换来的能力。
   * 2. **抛弃集合含 `rejected` / `produced`**（本次不再保留任何未落地的活）；`open` 也抛
   *    （它的树与分支都在，正是要收的东西）。已 `discarded` 的跳过（无树无枝）。
   * 3. 集成分支**允许多条**：这里只删不合并，删两条不会造成「部分成果落在主分支」，
   *    所以不做 `integrationBranch` 的「一批一条」那条限制，而是逐条（存在才删、直接 `-D`）。
   */
  async function discardBatch(input: { workspaceKey: string; parentWorkItemId: string }): Promise<void> {
    assertOwnWorkspace(input.workspaceKey);

    await serialize(input.parentWorkItemId, async () => {
      const runs = memberRuns(input.parentWorkItemId);

      for (const record of runs) {
        if (record.status === "discarded") continue; // 无树无枝，再抛一次只会撞「分支不存在」
        await lifecycle.discardMemberRun({ runId: record.runId });
      }

      /* 集成分支：**存在才删**，且这里**刻意不调 `discardIntegration`**、直接用 `deleteBranch`
         （全仓唯一那份 `git branch -D` 实现，与 lifecycle 的 `discardMember` 同源）。
         为什么：`discardIntegration` 的立身之本是那道**「必须是 target 的祖先」**的闸（防止把未落地的
         整批成果删掉）—— 而「用户取消整批」要删的**恰恰是一条没合回主分支的集成分支**，那道闸会
         一律拒绝（实测：`集成分支尚未合回 main，拒绝删除`）。这与「整批可整体放弃」直接冲突。
         更不能留它不删：`ensureIntegration` 对已存在的集成分支**什么都不做**（它不敢 reset，怕丢成果），
         所以残留的集成分支会带着**旧的 base**继续吃掉下一批的合并 —— 一批从未落地的成果悄悄混进来。
         存在性先读一次：从没合并过任何队员时它根本不存在，而 `deleteBranch` 对不存在的分支是**抛**。 */
      for (const integration of new Set(
        runs.map(
          (record) =>
            planBranches({
              workItemSlug: slugForId(record.workItemId),
              agentSlug: slugForId(record.agentId),
            }).integration,
        ),
      )) {
        if (await branchExists(integration)) {
          await detachFromHead(integration);
          await deleteBranch(runtime.git, runtime.boundWorkspace.path, integration);
        }
      }

      workItemService.transition(input.parentWorkItemId, "cancelled", "in_review");
    });
  }

  return { advanceAfterChildrenDone, discardBatch };
}
