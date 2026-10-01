import { isTerminalWorkItemStatus, resolveWorkspaceKey, type WorkItemStatusKey } from "@zcode/shared";
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

/* **同仓库内串行**：以**仓库根**（`boundWorkspace.path`）为键的进程内串行队列。
 *
 * 为什么需要：合并的实现是「检出目标分支 → git merge」，而**整个仓库只有一份主工作树的 HEAD**
 * ——所有 git 动作的 cwd 都是 `runtime.boundWorkspace.path`。争用这个 HEAD 的是**同一个仓库**，
 * 与「哪一批 / 哪个父项」无关。`integrationMerge.ts` 的 doc 已写明「本模块不做锁、串行是调用方
 * 约束」，这里就是那个调用方，必须兜住。
 *
 * 为什么键是**仓库**而不是**父项**（2026-10-01 复审修正）：按父项分键时，两个**不同父项**的批次
 * 各走各的链、并发去 checkout/merge **同一个 HEAD** —— 一条链的 `git checkout` 会把另一条刚检出的
 * 分支挪走、`merge --abort` 会把对方正在进行的合并一起回滚（spec §6.3 要求「串行合并（一次一个）」）。
 * git 拦不住这种**同进程内**的竞态（它只看到两次正常的 checkout），所以只能由本层串行。
 *
 * 键选 `boundWorkspace.path`（仓库根）而不是 `workspaceKey` 的理由：真正被争用的是**那棵主工作树**，
 * 所有 git 命令的 cwd 就是它；`workspaceKey` 是 C14 口径（identity 非空白时优先），同一个仓库可能
 * 因 identity 不同而算出不同的 key，而资源仍是同一个——key 必须命名**资源**，而不是命名**身份**。
 *
 * 为什么放在**模块级**而不是工厂闭包里：runtime 是「按目标现构、不缓存」的，同一仓库在同一进程里
 * 可能同时存在多个 orchestrator 实例；队列若挂在实例上，跨实例的同仓库竞态照样发生（复审点名的正是
 * 「同进程内的竞态」）。
 *
 * **本队列仍只是进程内的**：两个进程同时收尾同一仓库时没有共享锁可拿（那需要文件锁 / 数据库锁，
 * 属另一层），那种情形靠 git 自己的失败响亮报错，不靠本层假装自己是分布式锁。 */
const repoChains = new Map<string, Promise<void>>();

function serializeOnRepo<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = repoChains.get(repoRoot) ?? Promise.resolve();
  const current = previous.then(task);
  // 队列里存「不会 reject」的那一份：一次失败不该毒化后续调用（否则后续调用会继承一个 rejected
  // 前驱，`then(task)` 直接跳过 task，调用方拿到上一个错误 —— 一个与它无关的失败）。
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  repoChains.set(repoRoot, settled);
  void settled.then(() => {
    // 链尾清账：不留永久增长的 Map（每个仓库一条，收尾完成后即删）。
    if (repoChains.get(repoRoot) === settled) repoChains.delete(repoRoot);
  });
  return current;
}

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

  /* **内存串行队列**（同一个**仓库**一条链，见文件顶 `repoChains` 的说明）。
     同一 runtime 绑定的仓库根就是唯一被争用的资源：两批（不论父项是否相同）并发收尾会互踩主工作树
     的 HEAD，所以这里用**仓库根**而不是父项做键。 */
  const serializeRepo = <T>(task: () => Promise<T>): Promise<T> =>
    serializeOnRepo(runtime.boundWorkspace.path, task);

  /**
   * 读父项的**当时**状态；取不到（不存在或已归档）就响亮抛。
   *
   * 为什么不能静默当成某个默认状态：CAS 的前置必须来自**当时的真实值**。猜一个前置（例如写死
   * `in_review`）会在父项实际停在别处时让 CAS 永远不命中，而 §5.7.5 的「未命中即丢弃」会把那次
   * 结算吞掉 —— 用户既看不到 `done`，也看不到冲突的 `blocked`（复审：冲突「没有任何可观察的东西」）。
   */
  function requireParentStatus(parentWorkItemId: string): WorkItemStatusKey {
    const parent = workItemRepo.get(parentWorkItemId);
    if (!parent) {
      throw new Error(
        `父工作项不存在或已归档：${parentWorkItemId}。批次收尾需要一个可写的父项；` +
          "静默按某个默认状态处理会让后续 CAS 永远不命中，批与工作项状态就此分叉而无人知道。",
      );
    }
    return parent.status;
  }

  /**
   * 父项流转的**唯一**写法（spec §5.7.2「父项状态由工作项服务按条件推进」+ §5.7.5 CAS）。
   *
   * 为什么前置不再写死 `in_review`：那是**前置假设**，不是**当时事实**。父项停在 `todo`/`in_progress`
   * 时，写死的前置会让 CAS 静默未命中（正是复审 Important-1）。故这里**先读当时状态**、拿它作 CAS
   * 前置；未命中（读到写之间被人改了）**响亮抛**，绝不再落回「丢弃不报错而无人知道」。
   *
   * 终态纪律：已是目标态 ⇒ 幂等返回（不重复发事件）；已是**另一个**终态 ⇒ 抛（不得把 `cancelled`
   * 覆盖成 `done` 这类跨终态改写，那会掩盖「这条批是被谁、按什么顺序结算的」）。
   */
  function transitionParent(parentWorkItemId: string, next: WorkItemStatusKey, what: string): void {
    const current = requireParentStatus(parentWorkItemId);
    if (current === next) return;
    if (isTerminalWorkItemStatus(current)) {
      throw new Error(
        `父项 ${parentWorkItemId} 已是终态「${current}」，不能再推进到「${next}」（${what}）：` +
          "跨终态改写会掩盖这条批的结算次序，故拒绝。",
      );
    }
    if (!workItemService.transition(parentWorkItemId, next, current)) {
      throw new Error(
        `父项 ${parentWorkItemId} 的「${what}」CAS 未命中：读到前置「${current}」、目标「${next}」，` +
          "但写入时该行已不是读到的那样（并发改动）。静默丢弃会让这次结算消失得无影无踪，故响亮抛出。",
      );
    }
  }

  /**
   * 把父项推进到 `in_review` —— 批次收尾的**前置条件**（spec §5.7.2）。
   *
   * 为什么必须有这一步：编排器自身四处父项流转（`done` / `blocked`×2 / 空批 `done`）都要求父项正
   * 处于 `in_review`；而全仓**没有别的路径**把**父项**推到 `in_review`（机械半的 `completeMemberRun`
   * 推的是**子项**，`squadRunLifecycle.ts:188`）。缺了这一步，接线后父项停在 `todo`/`in_progress`
   * ⇒ 四次 CAS 全部静默未命中 ⇒ 用户既看不到 `done`，也看不到冲突的 `blocked` 信号。
   *
   * 返回 `false` ⇒ 父项已是终态、且本批确实已结算干净 ⇒ 调用方**直接返回**（幂等重放 / 用户已取消），
   * 不再触碰 git。父项终态但批里仍有未结算的队员 run 时**抛**（见实现里的理由）。
   */
  function establishParentInReview(
    parentWorkItemId: string,
    runs: readonly SquadRunRecord[],
  ): boolean {
    const status = requireParentStatus(parentWorkItemId);
    if (status === "in_review") return true;

    if (isTerminalWorkItemStatus(status)) {
      /* 父项已终态 = 这条批**已经被结算过**。两种来路都**不得**再动 git：
         (a) 本方法上一次成功收尾（父项 `done`、集成分支已删、队员 run 全 `discarded`）⇒ 幂等重放；
         (b) 用户走 `discardBatch` 取消整批（父项 `cancelled`、成果已全抛）⇒ 再合并就是**复活被取消的活**。
         判据是「批里还有没有未结算的 run」：还有 ⇒ 有人在批未结算时把父项标了终态（契约违例），
         既不静默返回（那份活会永远没人管）、也不照常合并（跨过一条已关闭的工作项）⇒ **响亮抛**。 */
      const unsettled = runs.filter((record) => record.status !== "discarded");
      if (unsettled.length > 0) {
        throw new Error(
          `父项 ${parentWorkItemId} 已是终态「${status}」，但本批仍有未结算的队员 run` +
            `（${unsettled.map((record) => `${record.runId}=${record.status}`).join(" / ")}）：` +
            "有人在批结算前把父项标成了终态。静默返回会让这些产出永远没人管，故响亮抛出。",
        );
      }
      return false;
    }

    // `todo` / `in_progress` / `blocked`：按 §5.7.2 由工作项服务推进到 `in_review`（本层不直写 repo）。
    // `blocked` 也一并推进：它多半是本方法上一次冲突留下的，而这次收尾要么把它送进 `done`、
    // 要么再判一次冲突重新置 `blocked` —— 留着一个不会再被推进的 `blocked` 只会让批卡死。
    transitionParent(parentWorkItemId, "in_review", "子项全终态 ⇒ 父项进入待验收");
    return true;
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
   * 2. **先做纯校验**（只读、零副作用）：`open` 的队员 run、多工作项（一批一条集成分支）都在这里
   *    响亮拒绝 —— 违约形状必须在碰 git 与写工作项**之前**拒绝，否则一次注定失败的调用会留下
   *    「父项被推进了、批却没结算」的半程状态；
   * 3. **前置条件**（spec §5.7.2）：把父项推进到 `in_review`，之后本方法四处父项流转的 CAS 才成立；
   * 4. 逐个队员**串行**合并（`reviewMemberRun(approved)` 是「合一个队员进集成分支」的**唯一实现**，
   *    本层不重写一份 `ensureIntegration + mergeMember + setStatus`）；
   * 5. 任一次冲突 → 父项 `blocked`（CAS 写）+ 停手（后面的成员不再合，主分支一个字节不动）；
   * 6. 全通过 → `finalize`（整批一次性合回主分支）→ 抛弃已 merged 的队员 → 删集成分支 → 父项 `done`。
   */
  async function advanceAfterChildrenDone(input: {
    workspaceKey: string;
    parentWorkItemId: string;
  }): Promise<void> {
    assertOwnWorkspace(input.workspaceKey);
    // §5.7.3 的判据在 repo 层（`areAllChildrenTerminal` 内部按 **category** 判，不是键名比较）：
    // 本层只消费它，不在这里再判一次（两处判据迟早分叉，而分叉的表现就是「批永远收不了尾」）。
    if (!workItemRepo.areAllChildrenTerminal(input.parentWorkItemId)) return;

    await serializeRepo(async () => {
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

      /* 集成分支名（纯计算，不动 git）。多工作项在这里**响亮拒绝**（`integrationBranch` 内部），
         且发生在任何 git 动作与工作项写入之前 —— 「一批只能落到一条集成分支」这条契约的零副作用拒绝。 */
      const integration = runs.length === 0 ? null : integrationBranch(runs);
      const pending = runs.filter((record) => record.status === "produced");

      /* 幂等重放闸：本批没有待合队员、且集成分支已经不在（上一次收尾把它删了）⇒ 已经收过尾，空转返回。
         为什么必须有它：`child_completed` 是**事件驱动**的（host 订阅后转发），同一事实重复投递
         （重连 / 重复挂订阅 / 调用方重试）会让本方法被同一批调用两次；第二次若照旧走 `finalize`，
         会拿到「集成分支不存在」而抛 —— 把一次幂等重放变成一次响亮失败，与 §5.7.5 的幂等口径相反。
         纯读（branchExists 只问 ref），故放在写工作项之前。 */
      if (integration !== null && pending.length === 0 && !(await branchExists(integration))) return;

      /* **前置条件**（spec §5.7.2）：父项推进到 `in_review`。这一步必须在任何父项流转**之前**，
         否则写死的前置 `in_review` 会因父项实际停在 `todo`/`in_progress` 而**静默未命中**。
         返回 false ⇒ 父项已终态且本批已结算干净（幂等重放 / 已被取消）⇒ 直接返回，一个字节不动。 */
      if (!establishParentInReview(input.parentWorkItemId, runs)) return;

      /* 本批没有任何队员产出（例如子项都在派单前被取消）：`integration` 为 null ⇔ 本批无队员 run
         （`integrationBranch` 只在有 run 时才有名字）—— 没有可落地的成果。
         不调 `finalize`（集成分支压根不存在，那会报「分支不存在」），直接把父项按「批已结算」收口。
         为什么是 `done` 而不是 `cancelled`：「父项该不该被放弃」是另一个语义（谁有权判定计划被放弃），
         不由本层从子项 category 反推 —— 那会把一个策略决定藏进收尾路径。 */
      if (integration === null) {
        transitionParent(input.parentWorkItemId, "done", "空批收口（无队员产出）");
        return;
      }

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
             前置从**当时状态**读（`transitionParent`），不是写死 `in_review`。 */
          transitionParent(input.parentWorkItemId, "blocked", "集成分支冲突（队员合并）");
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
          transitionParent(input.parentWorkItemId, "blocked", "集成分支冲突（整批合回）");
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
      transitionParent(input.parentWorkItemId, "done", "整批合回主分支");
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
   *
   * ——调用方义务（P2b 唯一未加闸的集成分支删除点，必须遵守）——
   * 本方法是全仓**唯一**用 `deleteBranch` 直删集成分支的地方（`discardIntegration` 的那道
   * 「集成必须是 target 的祖先」闸在这里被**刻意绕过**，理由见下）。因此它**只可用于用户显式发起的
   * 「整批取消」**：调用方必须是用户取消动作的直达路径，且**同一次调用里连队员分支一起丢弃**
   * （本方法就是这么做的）。**不得**从任何自动路径（看门狗 / 崩溃恢复 / 定时回收 / 派发重试）调用它 ——
   * 那些路径要清集成分支时必须走 `discardIntegration`（它的祖先闸正是防「丢掉未落地成果」的那道）。
   */
  async function discardBatch(input: { workspaceKey: string; parentWorkItemId: string }): Promise<void> {
    assertOwnWorkspace(input.workspaceKey);

    await serializeRepo(async () => {
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

      transitionParent(input.parentWorkItemId, "cancelled", "整批放弃（用户取消）");
    });
  }

  return { advanceAfterChildrenDone, discardBatch };
}
