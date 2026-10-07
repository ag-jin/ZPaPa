/* oxlint-disable eslint(max-lines) -- squad_runs 台账生命周期的**唯一写者面**：开树 / 收尾 / 审查 /
   抛弃 / 启动回收，以及 C1 的残行判据与结算次序，都必须读同一份状态机（`SQUAD_RUN_ACTIVE_STATUSES`
   与「行还能不能被推进」的判据）。拆文件会把这些次序判断切成几处 —— 而「什么时候可以结算一行」
   一旦出现第二份判据，两条路就会分叉（分叉的表现是「该结算的被当成在进行中」或反之，都不报错），
   与 `squadRunRepo.ts` / `commentService.ts` 的同款例外同一理由。 */
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
import type { DispatchCause } from "./squadDispatchRequests.js";
import type { SquadRunRecord, SquadRunRepo, SquadRunStatusPatch } from "./squadRunRepo.js";
import type { SquadRunSettlementHub } from "./squadRunSettlementHub.js";

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
  /**
   * 本次派发的**成因**（台账 `dispatch_cause` 列，见 `DispatchCause`）。
   *
   * **host 派发桥必须传**（规则 / 队长工具 / UI 改派三路都在那里归并，见 host 的 `runSquadDispatch`；
   * desktop 侧有用例钉住这条接线）。**缺席 = 未知 ⇒ 落 NULL**（遗留行语义）—— 读回**不得猜**
   * （`readDispatchCause` 对枚举外值响亮抛）。刻意做成**可选**：它把「谁该传」写成契约而不是
   * 把「没传」变成不可能——历史调用方（既有用例里的旧形态）不因加列而全体改签名。
   */
  dispatchCause?: DispatchCause;
  /**
   * 本次请求登记的 deferred 义务**来源**（G4/X2.1）：`reassign`（缺省，R2 改派通道）或
   * `comment`（评论派发通道）。
   *
   * 为什么必须由调用方声明而不是在本层推断：条目「由哪条通道登记」是**调用方才知道的事实**
   * （评论派发入口 vs 改派的 openMemberRun 调用点）；在本层按成因/调用者反推就是二次判定，
   * 判错的表现是评论义务被 R2 重放回路认领（它以 assignee 为派发目标重新验证），
   * 而评论目标 ≠ assignee 是常态格 ⇒ 义务被静默丢弃。
   *
   * 缺席 ⇒ `reassign`（列默认值与既有 R2 写入方语义不变，加法）。
   */
  origin?: import("./squadDeferredDispatchRepo.js").DeferredDispatchOrigin;
  /**
   * 派发这条队员 run 的**队长 run**（台账 `caused_by_run_id` 列）：仅当
   * `dispatchCause === "leader_tool"` 且派发时刻该批根工作项上确有活跃队长 run 时，由 host 在
   * **派发时刻**解析并传入（见 `findActiveLeaderRunId`）；其余成因一律缺席 ⇒ 落 NULL（不猜）。
   */
  causedByRunId?: string;
};

/**
 * 开跑结论（C3 起为判别联合；闸在**本方法内部、建树之前**——C0 2.2 裁定）：
 *  - `opened`：照旧派发（台账 open 行 + 工作树）；
 *  - `queued`：该 agent 容量已满 ⇒ 本 runId 落排队行，**未建树、未建会话**（推进在 C4）；
 *  - `coalesced`：该 (workItem,agent) 已有排队行 ⇒ 并入（不另起行），留痕见明细表；
 *  - `already_registered`：同 runId（幂等键 eventKey）重投 ⇒ 台账已有此行，不重复建树/登记，
 *    调用方继续走既有忙探测/绑定会话路径（R5 收口：此前是无条件 INSERT 撞主键）。
 */
export type OpenMemberRunResult =
  | { kind: "opened"; branch: string; worktreePath: string }
  | { kind: "queued"; runId: string }
  | { kind: "coalesced"; targetRunId: string }
  | { kind: "already_registered" }
  /** R2（S6 §12.1-2，2026-10-05 用户裁定）：同 (workItem,agent) 已有活跃 run ⇒ 不开第二条
   *  （撞分支）也不排队（排队等容量、义务等「目标对离开活跃集」），登记完成后重放义务。
   *  `coalescedInto` = 并入的既存义务行（同目标已有义务时）。 */
  | { kind: "deferred"; runId: string; coalescedInto?: string }
  /** C1（§8-P1）/P2-1 修法①：本请求的台账行是**残行**（有行无树），而该分支此刻仍被占着 ——
   *  要么挂着另一棵活工作树（别的 run 未回收的残树），要么只有同名的分支 ref（「残枝」：建树
   *  失败时 git 先把分支建出来了）。两种都不能靠「再建一次」解决（`worktree add -b` 撞名），
   *  也都**不得**直接复用那棵树（可能是别人的，P2a 教训：判定按分支、动作用目录名不成对时
   *  会静默毁掉别人的工作面）。
   *
   *  **P2-1 修法①（自愈回路闭合）**：这种行**结算**（`discarded` 扇出一次：容量与活跃集如实
   *  释放）**并释放分支占位**（同一 runId 回写为「等待分支空出」的 open 行）—— 本行从来就没有树，
   *  它的分支占位只会把**别人的/残留的**占位钉在活跃集里（回收器按「分支在活跃集」保留），
   *  于是「等回收器清掉后重投自愈」永远等不到（修前：重投永远等待型、receipt 永挂 pending）。
   *  释放占位 ⇒ 回收器能收 ⇒ 分支空出后同一条重投重新挂计划 + 建树（`opened`）。
   *  为什么行仍留在 `open`（而不是停在 `discarded`）：结算是终局 ⇒ 补投判据 `own_run_not_open`
   *  会让 receipt 永停未收敛（不可见），而 runId = 请求身份（`receipt.dispatchKey`）不得更换。 */
  | { kind: "residual_blocked"; branch: string };

/**
 * 「有行无树」——这条 run 行**自己**没有（也不会有）工作树（残行的**行级**判据）。
 *
 * 三个行级条件缺一不可：
 * · `isLeaderTask` 为真 ⇒ 不适用：队长行本来就没有树（`branch === null`）；
 * · `status === "open"`：produced/rejected 意味着它已经产出过（树必然存在过），
 *   merged/discarded/queued 都不该有树；
 * · `sessionId === null`：会话是在**建树之后**才建的（host 派发桥的顺序）⇒ 有会话 = 那条派发
 *   至少走过了建树那一步，不是「从未建过树」的残行；
 * · 分支上**没有属于它自己的**活工作树。
 *
 * 最后一条是 P2-1 修法①的判据扩展：活树集合里有这个分支，**不等于**那棵树是本行的 ——
 * 分支计划是 (workItem, agent) 的函数，而每条 run 各写各的台账行、一行一树 ⇒ 有旁证
 * `liveTreeOfOtherRow`（同一对还有别的 run 行，事实的唯一读法在 `hasOtherRunRowForPair`：含
 * 终态行，占位树的主人往往已经失败收口）时，那棵活树另有来路 ⇒ 本行仍是残行。反过来，只有本行
 * 一条 run 行时，那棵树可能是本行崩溃前建好的（会话没来得及绑）⇒ **不是**残行（调用方走既有
 * R5 幂等/绑定会话路径）。
 *
 * 为什么这条旁证是**调用方显式声明**的入参、而不是判据内部自己再查一遍：它只在**动作可逆**的
 * 地方成立。请求自己在场的等待臂（结算 + 释放占位 + 保留请求身份，之后同一条重投能重开）可以
 * 用它；对**别人的行**做**终局**结算的清扫臂（`settlePairResidualRuns`）**不得**用它 —— 那里的
 * 误伤对象正是「刚开好树的那一行」：它在更早的残行眼里也是「别的 run 行」，用它会把一条**活着
 * 且持有自己工作树**的行结算掉（C1 既有用例 `C1 跨调用结算（a）` 钉住的正是这一格）。
 *
 * 反例（为什么不能只看「活树存在」）：这种行为 `open` ⇒ 它的分支进 `computeActiveBranches`，
 * 而回收器的保留判据恰是「分支在活跃集里」⇒ 把「可能属于本行的树」一律当成本行的，会让
 * 占位树/残枝**永不被收**（D6+C1 复验 §7 P2-1 的执行级复现：重投永远等待型、receipt 永挂
 * pending；修前那一格至少是**可见** failed）。
 *
 * 注意它**不是**「可结算后立刻重开」的判据（那只在 `isSettleableResidualMemberRun`）：本行虽
 * 无树，分支却可能还挂着**别人的**活树或自己的残枝 —— 那时结算能释放占位（让回收器收得掉），
 * 但建不出树来。
 */
export function isTreelessOpenMemberRun(
  record: Pick<SquadRunRecord, "status" | "sessionId" | "branch" | "isLeaderTask">,
  facts: { liveTreeBranches: ReadonlySet<string>; liveTreeOfOtherRow: boolean },
): boolean {
  if (record.isLeaderTask) return false;
  if (record.status !== "open") return false;
  if (record.sessionId !== null) return false;
  if (record.branch === null) return false;
  return facts.liveTreeOfOtherRow || !facts.liveTreeBranches.has(record.branch);
}

/**
 * 「**可结算后立刻重开**」的残行（C1，§8-P1 的修法判据）：有行无树（`isTreelessOpenMemberRun`），
 * 且该分支上**没有任何占用** —— 既没有活工作树（**包括不属于本行的**：`worktree add -b` 撞目录/
 * 撞名，建不出树来），也没有同名分支 ref（`branchRefExists`，即那条「残枝」本身）。
 *
 * 为什么必须再要 `branchRefExists` 这一条：`git worktree add -b <branch>` 在**分支已存在**时
 * 必然报「a branch named '…' already exists」（哪怕那条分支没挂在任何工作树上 —— 实测过）。
 * 少了这一条，「结算 + 重开」会在分支名还被残枝占着时白结算一趟：台账被翻成 discarded 又被翻回
 * open，而树照样建不出来（白翻 = 每次扫描都空转一遍，且结算事实会重复扇出）。
 *
 * 与 P2-1 的分工：**这一条判据只回答「能不能立刻建出树」**；建不出树不等于什么都不做 ——
 * 那种行走「结算 + 释放分支占位 + 等回收器」的等待臂（见 `isAwaitingBranchMemberRun`），
 * 判据本体仍是这里的第一个合取项（`isTreelessOpenMemberRun`，单源），只是关掉了
 * 「树另有来路」那一条旁证（有活树占着分支时，重开一定撞名）。
 */
export function isSettleableResidualMemberRun(
  record: Pick<SquadRunRecord, "status" | "sessionId" | "branch" | "isLeaderTask">,
  facts: {
    liveTreeBranches: ReadonlySet<string>;
    branchRefExists: boolean;
    liveTreeOfOtherRow: boolean;
  },
): boolean {
  if (record.branch !== null && facts.liveTreeBranches.has(record.branch)) return false;
  return isTreelessOpenMemberRun(record, facts) && !facts.branchRefExists;
}

/**
 * 「**等待分支空出**」的队员行（P2-1 修法①的落地形态）：结算过（`discarded` 结算事实扇出一次、
 * 容量如实释放）却**保住了请求身份**的行 —— 分支占位已释放（`branch` / `dir_name` 为 NULL），
 * 行仍在 `open`，等回收器把不属于任何活跃行的占位树/残枝收净。
 *
 * 为什么必须同时是「结算过」与「请求身份还在」：结算是终局 ⇒ 若行停在 `discarded`，补投判据
 * `own_run_not_open` 会让 receipt 永停未收敛（而 runId = `receipt.dispatchKey` 不能换）；只清
 * 占位而不结算，容量与活跃集又不会如实释放。
 * 为什么必须**没有**分支占位：`computeActiveBranches` 按 `branch !== null` 投影，占位留着就会把
 * 别人的/残留的树钉在活跃集里（正是回收器的保留判据）—— 回路又断在原地。
 * 判据放这里（而不是调用方各自拼 `=== null`）：它同时被「等待分支空出」与「分支空出后重新挂
 * 计划 + 建树」两处读，写第二份就会在「什么算等待态」上分叉。
 */
export function isAwaitingBranchMemberRun(
  record: Pick<SquadRunRecord, "status" | "sessionId" | "branch" | "isLeaderTask">,
): boolean {
  return (
    !record.isLeaderTask &&
    record.status === "open" &&
    record.sessionId === null &&
    record.branch === null
  );
}

/**
 * 「同一 (workItem, agent) 上还有**别的** run 行」的**唯一读法**（P2-1 判据的行级输入）。
 *
 * 为什么收在一处：这条事实同时喂给「本行是否无树」（清扫/等待面）与「分支上的活树另有来路」
 * 的归属推断；两处各写一份 `some(...)` 迟早漂移，而漂移的表现是「把别人的树当成本行的」
 * （请求永远等待、占位永不被收）或反之（把本行崩溃前建的树当别人的 ⇒ 误判无树）——都不报错。
 *
 * 入参取**全量**台账（含终态行，`listByWorkspace` 口径）：占位树的主人往往已经终态
 * （失败收口后树按 spec §6.6 留给回收器），只看活跃集会漏掉它，把占位判成「无主」而无从归属。
 */
export function hasOtherRunRowForPair(
  rows: readonly SquadRunRecord[],
  input: { runId: string; workItemId: string; agentId: string },
): boolean {
  return rows.some(
    (row) =>
      row.runId !== input.runId &&
      row.workItemId === input.workItemId &&
      row.agentId === input.agentId,
  );
}

/**
 * 队长 run 的**登记**入参（`recordLeaderRun`）。
 *
 * 为什么它比 `MemberRunRequest` 少一个 `isLeaderTask`：本请求只可能是队长 run（方法名即语义），
 * 传一个恒为 `true` 的布尔列反而是「可被传错」的口子（传 `false` 就会写出一行自称队员、
 * 却没有工作树的台账）。`param parentWorkItemId` 可选：台账的 `parent_work_item_id` 是 NOT NULL 列，
 * 缺省取 `workItemId` 自身——与队员 run「无父项」时的既有口径一致（`workItem.parentId ?? workItem.id`）。
 */
export type LeaderRunRequest = {
  runId: string;
  workItemId: string;
  agentId: string;
  parentWorkItemId?: string;
  /**
   * 本次派发的**成因**（同 `MemberRunRequest.dispatchCause`；host 派发桥必须传，缺席 = 未知 ⇒ NULL）。
   */
  dispatchCause?: DispatchCause;
  /**
   * 队长 run 的**入边**：批次起点（由规则到点 / 用户指派触发）没有「派发它的队长」，故 host 派发桥
   * **不传**（恒落 NULL）。字段与队员共用同一落台路径、原样透传（本层不做二次判定）——代价是
   * 「误传一个值」也会落台；那由 host 侧守卫钉住（接线用例断言队长那一支不读 `causedByRunId`）。
   */
  causedByRunId?: string;
};

/**
 * 队长行登记的**结论**（§5.7(1)/S13 的存储层不变式：同一工作项至多一条活跃队长行）。
 *
 * `recorded: false` 说明该工作项**已经有一条进行中的队长 run** ⇒ 本次指派被**并入**它
 * （不产生第二行，也不该起第二个会话）。调用方必须据此**跳过本次派发**：
 * 当成功（静默）会让上层以为 run 起了、台账里却没有；当失败会让人去查一个并不存在的错误。
 * 两种误读都与「合并」的语义相反 —— 所以它必须是一个**要处理的返回值**，不是 void、也不是异常。
 */
export type LeaderRunRecordOutcome =
  | { recorded: true }
  | { recorded: false; reason: "in_progress_run_exists" }
  /** C3/A8：无活跃队长行但该 agent 容量已满 ⇒ 落队长排队行（吸收优先于排队：已存在活跃队长行
   *  仍走 `in_progress_run_exists` 吸收，不问容量）。调用方据此**跳过本次派发**（回执 ok + 可见日志）。 */
  | { recorded: false; reason: "capacity_full_queued" };

export type ReviewOutcome =
  | { ok: true; merged: true }
  | { ok: true; merged: false; kept: true }
  | { ok: false; reason: "conflict" | "branch_missing"; detail: string };

/**
 * spec §5.7(1)「队长 run **进行中**时的重复指派**合并**为同一次（不排队堆积）」的**唯一读法**：
 * 该 `workItemId` 此刻是否存在**未终态**（即仍在跑）的**队长**行。
 *
 * 为什么单独抽成函数而不是让调用方各自 `some(...)`：这条投影是「合并还是新起一次」的判据，
 * 而判据一旦被抄成两份，迟早在「算不算队长行」或「活跃集合取哪个」上分叉 —— 分叉的表现是
 * 「该合并的没合并（重复 run 堆积）」或「该新派的被永久吃掉」，**两者都不报错**。故定义只有这一处。
 *
 * **入参必须是活跃集合**（`SquadRunRepo.listActive` / `getSnapshot().runs`）：终态行已被该集合
 * 排除，于是「存在」即「进行中」。传一个含终态行的列表（例如 `listByParent`）会得到恒真的错误答案
 * —— 这正是本方法要防的那种「看起来没问题」。
 *
 * 何时为假：`completeLeaderRun`（成功 ⇒ `merged`）或失败/中止出口（⇒ `discarded`）把它移出活跃集
 * 之后，同一读法必须变假（有用例钉住）—— 否则该判据对该工作项**永远为真**。
 */
export function hasInProgressLeaderRun(
  activeRuns: readonly SquadRunRecord[],
  workItemId: string,
): boolean {
  return activeRuns.some((record) => record.workItemId === workItemId && record.isLeaderTask);
}

/**
 * 「该工作项上**活跃**的队长 run 是**哪一条**」的**唯一读法**（台账 `caused_by_run_id` 列的唯一来源）。
 *
 * 与 `hasInProgressLeaderRun` 是同一份「进行中」投影的两面：邻居回答「有没有」，本函数回答「是哪条」。
 * 放在紧邻位置而不是让调用方各自 `find(...)`：两处若各写一份过滤，迟早在「算不算队长行」或
 * 「读哪个集合」上分叉 —— 而分叉的表现是台账里的 `caused_by_run_id` 指向一条错的 run（或凭空为 null），
 * 时间线据此画出一根错的弧线，**且不报错**。
 *
 * **入参必须是活跃集合**（`SquadRunRepo.listActive` / `getSnapshot().runs`）：终态行已被该集合排除，
 * 于是「命中」即「当时还在跑」。传一个含终态行的列表（例如 `listByParent`）会得到**恒真/错误答案**
 * ——「队长 run 早已收口，却仍被记为派发者」，这正是本函数要防的那种「看起来没问题」。
 *
 * 命中第一行（行序由 repo 的 `ORDER_BY_CREATED` 定死，同刻按 runId）；没有 ⇒ `null`
 * （**不猜**：宁缺毋错 —— 写 NULL 是「未知」的既有语义，写一个猜的值是造事实）。
 */
export function findActiveLeaderRunId(
  activeRuns: readonly SquadRunRecord[],
  workItemId: string,
): string | null {
  const record = activeRuns.find(
    (candidate) => candidate.workItemId === workItemId && candidate.isLeaderTask,
  );
  return record?.runId ?? null;
}

export interface SquadRunLifecycle {
  openMemberRun(request: MemberRunRequest): Promise<OpenMemberRunResult>;
  /**
   * **只登记**一次队长 run 的台账行：**不建工作树、不碰 git、不改工作项状态**。
   *
   * 为什么必须有它（补上「队长 run 完全不进台账」这个缺口）：
   * spec §5.7(1) 要求「队长 run **进行中**时的重复指派**合并**为同一次（不排队堆积）」——
   * 「进行中」这件事**没有记录就无从判定**；同理 `getSnapshot().runs` 也永远看不见队长 run
   * （「谁在被唤醒」这一格失真）。而队长 run 不能借道 `openMemberRun`：那会连工作树一起开
   * （机械半明文如此），而队长直接在目标工作区执行（spec §6.1/§6.2）。
   *
   * 与 `openMemberRun` 的关系：两者是**同一张台账的同一写者**（都只经 `squadRunRepo.insert`），
   * 差别只在「队长不派生分支计划」⇒ `is_leader_task=1`、`branch=null`、`dir_name=null`。
   * 队长行因此对 `computeActiveBranches` **零贡献**（它按 `branch !== null` 投影），
   * 回收器也看不见它（它认的是工作树与分支）—— 既有的活跃集合口径与回收行为都不动。
   *
   * 「进行中」的读法（给重复指派合并用）：**唯一实现是下面导出的 `hasInProgressLeaderRun`**
   * ——`getSnapshot().runs`（= `listActive`，已含队长行且已排除终态）里按 `workItemId` +
   * `isLeaderTask` 过滤，存在即「该工作项有进行中的队长 run」。调用方**不得**各自重写这条投影
   * （重写一份就会与这里漂移，而漂移的表现是「该合并的没合并 / 该新派的被吃掉」，都不报错）。
   *
   * 幂等口径与 `openMemberRun` 一致：同 `runId` 重复登记 ⇒ 台账**主键冲突响亮抛**
   * （静默复用旧行会让两次 run 的成果落进同一个身份里；`runId` 取幂等键 `eventKey`，
   * 故「同一事实重投」本就不该产生第二条 run）。
   */
  recordLeaderRun(request: LeaderRunRequest): Promise<LeaderRunRecordOutcome>;
  /**
   * 队长 run 的**成功终态收口**：把队长行的台账状态从 `open` 移到**终态**（`merged`）。
   *
   * 为什么必须有它（否则 §5.7(1) 的判据被架空）：`recordLeaderRun` 只登记（`open`），而队长 run
   * **没有队员那一步 review/merge**（无分支可合、无树可抛，spec §6.1/§6.2）⇒ 没有任何既有方法会把
   * 这条行移出活跃集（`SQUAD_RUN_ACTIVE_STATUSES` 含 `open`）⇒ **成功的队长行会长驻 `open`** ⇒
   * 「该工作项有没有进行中的队长 run」（`hasInProgressLeaderRun`）**恒为真** ⇒ 重复指派合并会把
   * 该工作项的**所有后续指派永久吃掉**（不报错）。这不是「少一个便利动作」，而是判据失真。
   *
   * 与 `completeMemberRun` 的两点**刻意差异**（对称但不等同）：
   * 1. **不推工作项状态**：spec §5.7(2) 明文「队长 run **不改父项状态**」——`completeMemberRun`
   *    里那句 `transition(..., "in_review", ...)` 套到队长行上会**写坏父项**（凭空把它推进待验收）。
   *    本方法**一个字都不写工作项**。
   * 2. **直接到终态**：队员的产出必须活到「被合并」（`produced` 仍是活跃态，spec §6.2），所以
   *    `completeMemberRun` 只是入账、不是终态；队长没有分支/工作树，run 结束即收口 ⇒ 直接落
   *    `merged`。该行 `branch=null` ⇒ 编排器 `memberRuns`（按 `branch !== null` 投影）与
   *    `discardBatch` 都不会再看它，故 §6.2「队长 run 的终态**不得**影响工作树生命周期」成立。
   *
   * 三条纪律（与 `failMemberRun` / `reviewMemberRun` 同款）：
   * · **唯一写者**：只经 `squadRunRepo.setStatus`；
   * · **前置读当时状态**（从台账读到什么再决定怎么做，**不写死**）；
   * · **未命中 / 跨终态响亮抛**：runId 不存在 ⇒ `requireRun` 抛；已是 `merged` ⇒ **幂等返回**
   *   （同一条「成功」事实被重投一次是可能的，悄悄改写成别的才是问题）；已是 `discarded`
   *   （失败/中止已收口）⇒ **抛** —— 把一条按失败收口的 run 改写成「成功」是跨终态改写，
   *   会掩盖它当初为什么没跑完。
   *
   * **只收队长行**：非队长行（`isLeaderTask` 为假或 `branch` 非空）⇒ **抛**。误用于队员行会把一条
   * **从未合并**的队员分支置 `merged`，编排器随后按「`merged` 且有分支」把它**连树带枝丢弃** ——
   * 成果在没落地的情况下被删，且不报错。
   */
  completeLeaderRun(input: { runId: string }): Promise<void>;
  completeMemberRun(input: { runId: string }): Promise<void>;
  /** 硬约束 2 的**唯一**口径来源：未合并的队员分支（含被打回待修的）。 */
  computeActiveBranches(workspaceKey: string): Promise<string[]>;
  reapStartupOrphans(input: { workspaceKey: string }): Promise<ReapOutcome>;
  reviewMemberRun(input: {
    runId: string;
    verdict: "approved" | "rejected";
  }): Promise<ReviewOutcome>;
  discardMemberRun(input: { runId: string }): Promise<void>;
  /**
   * 会话建立后把 `sessionId` **回写**到该 run 的台账行（Important-4，2026-10-02 裁定）。
   *
   * 为什么必须有这一步：`openMemberRun` 落台账时还不知道 sessionId（会话那时还没建），于是写 `null`；
   * 而忙检查（硬约束 1）与「重投复用同一会话」都从台账读 `sessionId` ⇒ 不回写就**恒为 null**，
   * 强探测与 `deferred` 分支在生产里**永不可达**（代码对、保护为零）。本方法只写 `session_id` 一列
   * （不碰 status —— 见 `SquadRunRepo.bindSession` 的竞态理由）。
   */
  bindMemberRunSession(input: { runId: string; sessionId: string }): Promise<void>;
  /**
   * 失败 run 的**出口**（Important-3，2026-10-02 裁定）：把执行失败的 run 移出**活跃集**。
   *
   * 为什么必须有出口：`open ∈ SQUAD_RUN_ACTIVE_STATUSES` ⇒ 失败的 run 永远算「活跃」⇒ 它的工作树与
   * 分支**永不被回收**（S15 未达）。本方法与 `reviewMemberRun` 同款纪律：**唯一写者**（只经
   * `squadRunRepo.setStatus`）、**前置读当时状态**、**未命中响亮抛**。
   *
   * 只接受 `open`（执行失败 = 从未产出）；`discarded` 幂等返回；其余状态（`produced` / `merged` /
   * `rejected`）**抛**——它们都意味着「已经产出了东西」，当失败丢弃会丢掉队员的活。
   * 本方法**不碰 git**：树的删除留给启动回收器（按「不在活跃集」回收），见 spec §6.6/S15。
   *
   * **方法名里的「Member」是历史命名，契约上它收的是「这条 run」而不是「队员身份」**：队长 run 的
   * 失败/中止出口同样走本方法（队长无树无枝 ⇒ `discarded` 之后不产生任何需要回收的东西，§6.2）。
   * 刻意**不**为队长单开一个 `failLeaderRun`：那会是同一条规则的**第二份实现**，两份迟早分叉，
   * 而分叉的表现是「同样一条失败 run，按哪条路收口结论不同」且不报错。队长与队员唯一的差别在
   * **成功**那一支（队长不收口工作项），那一支才需要自己的写入口：`completeLeaderRun`。
   */
  failMemberRun(input: { runId: string; reason: string }): Promise<void>;
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
  /**
   * 每 agent 并发上限的**唯一读取点**（C3）：返回 undefined = 名册里**没有**该 agent 定义
   * （A5：不套缺省、不排队、照旧派发——闸对不存在的个体不设限）或调用方（测试）未注入。
   * 有定义 ⇒ 返回 `resolveTeamAgentMaxConcurrentRuns(agent)`（显式值或缺省 6）。
   * 计数与判定在 repo 语句内（单一判定实现；host 不写第二份计数投影）。
   */
  resolveAgentMaxConcurrentRuns?: (agentId: string) => number | undefined;
  /** C4：收尾迁移之后的结算事实扇出（不注入 ⇒ 不发布）。 */
  runSettlementHub?: SquadRunSettlementHub;
  /** R2：deferred 重放义务表（不注入 ⇒ 遇到「活跃 run 已存在」时响亮抛，不静默降级）。 */
  squadDeferredDispatchRepo?: import("./squadDeferredDispatchRepo.js").SquadDeferredDispatchRepo;
  /**
   * C1：**此刻活着的**工作树（`WorktreeManager.list` 口径：路径存在、分支可能是 null=detached）。
   *
   * 为什么必须由外部注入而不是本层自己问 git：本层只与 `squad_runs` 台账打交道，工作树的**唯一所有者**
   * 是 `WorktreeManager`（建/删/列都在它那里）。残行判据要回答的是「这条 run 的分支上有没有活树」，
   * 那是 git 事实、不是台账事实 —— 在台账里推断（例如「有没有 sessionId」）会漏掉
   * 「树建好了但会话没绑上」这一格，而那正是残行判据要分辨的另一半。
   */
  listWorktrees: () => Promise<ReadonlyArray<{ path: string; branch: string | null }>>;
  /**
   * C1：分支 ref 是否**已存在**（`refs/heads/<branch>`；「残枝」就是「有分支、没工作树」这一格）。
   *
   * 为什么它不能由 `listWorktrees` 代答：工作树列表只报还活着的树，而 `git worktree add -b`
   * 的失败条件里**还有一条**「同名分支已存在」—— 建树因目录冲突失败时 git 会先把分支建出来，
   * 于是留下一条无工作树的残枝，下一次再挂必然撞它。少了这一格，「结算 + 重开」会在残枝
   * 还没被回收时白翻一趟台账（见 `isSettleableResidualMemberRun`）。
   */
  branchRefExists: (branch: string) => Promise<boolean>;
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

  /** 此刻活着的分支（`WorktreeManager.list` 的投影）：残行判据的 git 事实面（`isResidualMemberRun`）。 */
  async function liveBranchSet(): Promise<Set<string>> {
    const entries = await deps.listWorktrees();
    return new Set(
      entries.map((entry) => entry.branch).filter((branch): branch is string => branch !== null),
    );
  }

  /**
   * C1：把同一 (workItem, agent) 上**别的 run** 留下的残行结算掉（`discarded` + 结算事实扇出）。
   *
   * 为什么必须清：残行在活跃集里（`open ∈ SQUAD_RUN_ACTIVE_STATUSES`）⇒ `hasActiveRunForPair` 为真
   * ⇒ 后续同对的派发一律被判成「已有活跃 run」⇒ 登记 deferred 义务（R2）⇒ 义务到期靠「目标对离开
   * 活跃集」，而那条残行的树永远不会自己变出来 ⇒ **请求永远不执行**（既不失败、也不推进）。
   * 结算它才是如实处置：那条 run 已经没有产出可言，它占着的容量与活跃集该释放。
   *
   * 判据用**行级**事实 `isTreelessOpenMemberRun`（本行无树）：这类行不会再产出，与分支上还有没有
   * 同名 ref 无关（那是**别人**要面对的事，不是这行该不该结算的事）。
   *
   * 为什么这里**不点亮** `liveTreeOfOtherRow`（P2-1 判据扩展的那条旁证）：本函数结算的是**别人的
   * 行**，且是**终局**结算。旁证「同一对还有别的 run 行 ⇒ 树另有来路」在请求自己在场、动作可逆的
   * 等待臂里才成立；在这里用它，误伤的正是「刚开好树的那一行」—— 它自己也是更早那条残行眼里的
   * 「别的 run 行」（C1 既有用例「跨调用结算（a）」钉住的正是这一格：新开的行动不得被后来的请求
   * 清扫掉）。清扫只结算**分支上确实没有活树**的行：那类行不持有任何树，结算它一个字节都不会
   * 误伤。
   *
   * 清扫只结算、不重开（那是请求自己的重投面的事：它手里的 runId 才是请求身份），故这里**不回写**
   * 分支占位。
   *
   * 一次为限（防死循环）：本函数一次调用**只扫一轮**、每个候选结算一次；结算后本次新开的新行若
   * 也建树失败（留成残行），不在本次调用里二次结算重试。
   */
  async function settlePairResidualRuns(
    workItemId: string,
    agentId: string,
    ownRunId: string,
  ): Promise<void> {
    /* 先按台账筛候选（零 git 成本）：常态下同对没有别的 open 行 ⇒ 直接返回，不走 git。 */
    const candidates = squadRunRepo
      .listActive(boundWorkspaceKey)
      .filter(
        (row) =>
          row.runId !== ownRunId &&
          row.workItemId === workItemId &&
          row.agentId === agentId &&
          row.status === "open" &&
          row.sessionId === null &&
          row.branch !== null,
      );
    if (candidates.length === 0) return;
    const live = await liveBranchSet();
    for (const row of candidates) {
      if (!isTreelessOpenMemberRun(row, { liveTreeBranches: live, liveTreeOfOtherRow: false }))
        continue;
      // 唯一写者（`settleStatus`）+ 结算事实扇出：容量与活跃集从这里释放（排队行/义务的推进靠它）。
      settleStatus(row.runId, "discarded");
    }
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

  /* C4：唯一写者在每个收尾迁移之后发布结算事实（覆盖 host 闭包/UI 审查/编排器全部路径——
     分散挂会漏，C0 2.4 事实 2）。settled 行读不到（理论不可达）时用绑定 workspaceKey、
     agentId 置空串——发布事实仍要发出（订阅方按 runId 也能定位）。

     0014 起多一个可选 `reason`：写进 `settle_reason`（TTL 审计 / 熔断窗口计数 / 重试预算三处消费）。
     **所有**结算路径都能带（单点纪律不破：不给看门狗开第二道后门）；缺省 ⇒ 不动该列
     （C1 的两处常规结算与审查/合并路径即此格，列保持 NULL = 「常规结算」）。 */
  const settleStatus = (
    runId: string,
    status: "produced" | "rejected" | "merged" | "discarded",
    options?: { patch?: SquadRunStatusPatch; reason?: string },
  ): void => {
    const settled = squadRunRepo.get(runId);
    squadRunRepo.setStatus(runId, status, {
      ...options?.patch,
      ...(options?.reason === undefined ? {} : { settleReason: options.reason }),
    });
    deps.runSettlementHub?.publish({
      runId,
      workspaceKey: settled?.workspaceKey ?? boundWorkspaceKey,
      workspacePath: settled?.workspacePath ?? deps.boundWorkspace.path,
      agentId: settled?.agentId ?? "",
      status,
    });
  };

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

      /* R5 收口（C3）：同 runId（幂等键 eventKey）重投 ⇒ 台账已有此行，**不重复建树/登记**，
         交回 `already_registered` 让调用方走既有忙探测/绑定会话路径。此前是无条件 INSERT，
         重投会撞主键响亮抛——把「同一事实的重复投递」误当调用方 bug。 */
      const existing = squadRunRepo.get(request.runId);
      if (existing !== null) {
        if (existing.status !== "queued") {
          /* P2-1 修法①：**等待分支空出**的队员行（结算过、占位已释放、请求身份保留）。
             分支已空出（既无活树、也无同名 ref）⇒ 重新挂上分支计划 + 建树（同一条 run 行、
             同一个 runId）——这就是「回收器收净之后重投自愈」的落地那一格。
             仍被占着 ⇒ 照旧等待型：**不动状态**（结算事实早已扇出过一次，不得重复）。 */
          if (isAwaitingBranchMemberRun(existing)) {
            const rowPlan = planForRun(existing);
            const live = await liveBranchSet();
            if (live.has(rowPlan.member) || (await deps.branchRefExists(rowPlan.member))) {
              return { kind: "residual_blocked", branch: rowPlan.member };
            }
            squadRunRepo.setStatus(existing.runId, "open", {
              branch: rowPlan.member,
              dirName: memberDirName(rowPlan),
              sessionId: null,
              /* 0014：同 runId 重开 = **新的开跑** ⇒ 起算点跟着重开时刻走（与下面那条结算+重开臂
                 同一条理由：不刷会让下一次 tick 拿旧起算点把刚重开的 run 立刻 TTL 误杀）。 */
              openedAt: Date.now(),
            });
            const { memberPath } = await branchAllocator.allocate(rowPlan, baseBranch);
            return { kind: "opened", branch: rowPlan.member, worktreePath: memberPath };
          }
          /* C1（§8-P1）：本请求的行存在，但**从来没有建出过树**（open + 未绑会话）。
             这正是「台账先行」留下的残行形态（建树失败 / 建树后崩溃），若不处置就会一直撞
             「已登记」幂等臂 ⇒ 调用方手里永远没有工作树 ⇒ 队员 run 被判 permanent 失败，
             而底层原因（分支被残枝占着）往往只是等回收器 —— 一条本可自愈的请求被判死刑。 */
          if (
            !existing.isLeaderTask &&
            existing.status === "open" &&
            existing.sessionId === null &&
            existing.branch !== null
          ) {
            const live = await liveBranchSet();
            const branchIsLive = live.has(existing.branch);
            /* 判据的行级旁证（唯一读法）：同一对**还**有没有别的 run 行 ⇒ 分支上的活树另有来路
               （P2-1 对 `isTreelessOpenMemberRun` 的扩展；这里的动作可逆 —— 结算后同一条重投能
               重开，见下面那条等待臂 —— 故这条旁证在这里成立）。取全量台账：占位树的主人往往已终态。 */
            const liveTreeOfOtherRow = hasOtherRunRowForPair(
              squadRunRepo.listByWorkspace(boundWorkspaceKey),
              {
                runId: existing.runId,
                workItemId: existing.workItemId,
                agentId: existing.agentId,
              },
            );
            const facts = { liveTreeBranches: live, liveTreeOfOtherRow };
            const branchRefExists = branchIsLive
              ? false
              : await deps.branchRefExists(existing.branch);
            if (isSettleableResidualMemberRun(existing, { ...facts, branchRefExists })) {
              /* 残行 + 分支无任何占用 ⇒ 可结算：先结算（释放容量/活跃集，结算事实扇出），
                 再**同一 runId** 重开新树。
                 为什么 runId 不能换（结构事实）：runId = 请求身份（`eventKey` = receipt.dispatchKey），
                 host 的 `bindMemberRunSession` / 终态收口 / 失败出口与补投扫描的「自己的 run 行」
                 查找全按它定位 —— 换一个新 runId 会让 receipt 的 own-run 不再是 open，
                 扫描从此跳过这条请求（请求永远不执行，且没有任何一格报错）。 */
              settleStatus(existing.runId, "discarded");
              squadRunRepo.setStatus(existing.runId, "open", {
                branch: plan.member,
                dirName: memberDirName(plan),
                sessionId: null,
                /* 0014（delta 修正）：同 runId 重开 = **新的开跑** —— 起算点必须跟着重开时刻走。
                   不补刷的话这条重开行带着**旧起算点**回来，下一次看门狗 tick 会立刻按 TTL 把它
                   收掉（表现是「刚重开的 run 凭空消失」，且不报错）。 */
                openedAt: Date.now(),
              });
              /* 重开新树：失败**原样抛**（既有失败出口）。结算与重开在本次调用内**只做一轮**
                 （一次为限）：不得为了「再试一次」而二次结算重试 —— 那会在占用不消失时
                 变成每次扫描都翻一遍台账的空转。 */
              const { memberPath } = await branchAllocator.allocate(plan, baseBranch);
              return { kind: "opened", branch: plan.member, worktreePath: memberPath };
            }
            if (isTreelessOpenMemberRun(existing, facts)) {
              /* P2-1 修法①：分支上的占用**不属于本行** —— 要么是别的 run 未回收的活树
                 （`liveTreeOfOtherRow`：一行一树 ⇒ 那棵树另有来路），要么只剩同名残枝。
                 本行从来就没有树 ⇒ 它的分支占位只会把**别人的/残留的**占位钉在活跃集里
                 （回收器的保留判据恰是「分支在活跃集」）⇒「等回收器清掉后重投自愈」永远等不到：
                 重投永远等待型、receipt 永挂 pending（比修前的**可见** failed 更坏）。
                 处置（裁定 ① 的行级判据 + 落地细化）：**结算本行**（`discarded` 扇出一次：
                 容量与活跃集如实释放）**并释放分支占位**（同一 runId 回写为「等待分支空出」），
                 之后回收器能把占位树/残枝收净；分支空出后同一条重投重新挂计划 + 建树（`opened`）
                 —— 回路闭合。为什么行仍留在 `open`：结算是终局 ⇒ 补投判据 `own_run_not_open`
                 会让 receipt 永停未收敛，而 runId = 请求身份（`receipt.dispatchKey`）不得更换。 */
              settleStatus(existing.runId, "discarded");
              squadRunRepo.setStatus(existing.runId, "open", {
                branch: null,
                dirName: null,
                sessionId: null,
              });
              return { kind: "residual_blocked", branch: plan.member };
            }
            /* 走到这里 = 活树占着分支、且同一对**没有别的** run 行 ⇒ 那棵树可能是本行崩溃前
               建好的（会话没来得及绑）⇒ 保持既有 R5 语义（下面那条 `already_registered`），
               交回调用方走既有忙探测 / 绑定会话路径。 */
          }
          /* R5 收口（C3）：同 runId 重投、「已经跑过」的行（有会话 / 已产出…）⇒ 不重复建树/登记，
             交回 `already_registered` 让调用方走既有忙探测/绑定会话路径。 */
          return { kind: "already_registered" };
        }
        /* C4 推进：排队行的「重放同 runId」就是推进入口（host 收到结算事件后按 runId 重投——
           单一派发实现，不另写建会话+发 prompt 的第二套）。认领（原子 queued→open，容量子查询
           在语句内）成功 ⇒ 建树 + patch branch/dir_name（先认领后建树：建树失败时行已是 open、
           无树——与 openMemberRun 既有「台账先行」崩溃形态一致，失败出口可收口）。
           认领失败（容量仍满/名册缺席）⇒ 照旧返回排队结论，等下一次结算。 */
        const promoteLimit = deps.resolveAgentMaxConcurrentRuns?.(request.agentId);
        if (
          promoteLimit !== undefined &&
          squadRunRepo.claimQueuedRunForPromotion(request.runId, promoteLimit)
        ) {
          const { memberPath } = await branchAllocator.allocate(plan, baseBranch);
          squadRunRepo.setStatus(request.runId, "open", {
            branch: plan.member,
            dirName: memberDirName(plan),
          });
          return { kind: "opened", branch: plan.member, worktreePath: memberPath };
        }
        return { kind: "queued", runId: request.runId };
      }

      /* C1（§8-P1，「该 pair 的 open 行」那一半）：本请求要新开一行之前，先把**同一对**上别的 run
         留下的残行结算掉。不清的话，那条残行会以「已有活跃 run」之名把本次派发钉成 deferred 义务
         （R2），而它的树永远不会出现 ⇒ 义务永远等不到到期条件（「目标对离开活跃集」）⇒ 请求永不执行。
         结算 = `discarded` + 结算事实扇出：容量与活跃集在这里如实释放。
         一次为限：本处**只扫一轮**；本次新开的新行若也建树失败（留成残行），不在本次调用里再结算重试。 */
      await settlePairResidualRuns(request.workItemId, request.agentId, request.runId);

      /* **先落台账、后建树**（顺序不可颠倒）。
         反过来（树建好了而台账里没有这一行）时若在两者之间崩溃：下一次启动的回收
         看不见这条 run ⇒ 分不出「活跃」⇒ 队员**未提交**的成果会被当孤儿连树带枝收掉，
         spec §6.2「审查被拒必须存活到合并」当场落空，且回收过程不报错。
         台账先写、树后建，最坏结果是「台账里有一条 open 行而没有树」——那是可被下一次
         openMemberRun 或人工看到的显式状态，不会静默丢活。
         C3 起：落台账这一步经**并发闸**（容量满 ⇒ 排队/并入，**建树之前**判定——C0 2.2）。
         名册缺席（A5）或未注入解析器 ⇒ 不闸、照旧直开（不得凭空套缺省 6）。 */
      const record: SquadRunRecord = {
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
        // 成因与入边**原样透传**（host 派发桥在派发时刻给的既成事实）：本层不推断、不二次判定；
        // 缺席（历史调用方）⇒ NULL = 遗留行/未知成因，读回不得猜。
        dispatchCause: request.dispatchCause ?? null,
        causedByRunId: request.causedByRunId ?? null,
        // 0014：直开行的起算点 = 登记时刻（同一个 now）；容量满转排队时由 repo 的排队语句写 NULL。
        openedAt: now,
        settleReason: null,
        createdAt: now,
        updatedAt: now,
      };
      const limit = deps.resolveAgentMaxConcurrentRuns?.(request.agentId);
      if (limit === undefined) {
        squadRunRepo.insert(record);
      } else if (
        !squadRunRepo.hasQueuedRunForPair(boundWorkspaceKey, request.workItemId, request.agentId) &&
        squadRunRepo.hasActiveRunForPair(boundWorkspaceKey, request.workItemId, request.agentId)
      ) {
        /* R2：已有活跃 run（占树）⇒ 登记完成后重放义务（原「撞分支名响亮失败」改为排队重放，
           用户 2026-10-05 裁定）。排队行优先于义务（统一裁决表第 1 行 ⇒ 上面的 hasQueued 前置）。 */
        const obligationRepo = deps.squadDeferredDispatchRepo;
        if (obligationRepo === undefined) {
          throw new Error(
            "openMemberRun 遇到「同 (workItem,agent) 已有活跃 run」但未注入义务表 repo：R2 语义要求登记 deferred 义务，" +
              "静默降级（开第二条撞分支 / 排队错语义）都不接受，故响亮抛。",
          );
        }
        const inserted = obligationRepo.insertIfAbsent({
          runId: request.runId,
          workspaceKey: boundWorkspaceKey,
          workItemId: request.workItemId,
          agentId: request.agentId,
          dispatchCause: request.dispatchCause ?? null,
          /* G4/X2.1：义务来源**由调用方声明**（评论派发入口传 'comment'，改派路径缺省 'reassign'）
             —— 分流位必须是事实，不在本层按成因/调用者反推（判错会让评论义务被 R2 通道重放）。 */
          origin: request.origin ?? "reassign",
          createdAt: now,
          updatedAt: now,
        });
        if (inserted) return { kind: "deferred", runId: request.runId };
        const existingObligation = obligationRepo.find(
          boundWorkspaceKey,
          request.workItemId,
          request.agentId,
        );
        squadRunRepo.recordCoalescedRequest(
          request.runId,
          existingObligation?.runId ?? request.runId,
        );
        return { kind: "deferred", runId: request.runId, coalescedInto: existingObligation?.runId };
      } else {
        const outcome = squadRunRepo.insertMemberRunOrQueue(record, limit);
        if (outcome.kind === "queued") {
          return { kind: "queued", runId: outcome.runId };
        }
        if (outcome.kind === "coalesced") {
          return { kind: "coalesced", targetRunId: outcome.targetRunId };
        }
      }

      // 建树失败（分支残枝 / base 不存在 / 目录冲突）**原样抛出**：上面的台账行保留，
      // 那是「这条 run 已经开过」的事实，不该被下面的失败抹掉（台账没有删除路径，也不该有）。
      const { memberPath } = await branchAllocator.allocate(plan, baseBranch);
      return { kind: "opened", branch: plan.member, worktreePath: memberPath };
    },

    async recordLeaderRun(request) {
      /* **只登记**（见接口注释）：这里**没有** `branchAllocator` / `planBranches` 的任何调用，
         也没有 `workItemService` / `squadRunRepo.setStatus` 的任何调用 —— 队长 run 不建树、
         不改工作项状态、不改运行状态。它写下的行与队员行同在一张表、同一个写者，只在
         `is_leader_task` / `branch` / `dir_name` 三列上可区分。
         刻意**不**复用 `openMemberRun` 再「事后清掉树」：那会先建一棵树再删，中间任何一步失败
         都会留下一棵无主工作树（而这次 run 本不该有树）。 */
      const now = Date.now();
      const record: SquadRunRecord = {
        runId: request.runId,
        workspaceKey: boundWorkspaceKey,
        workspacePath: deps.boundWorkspace.path,
        workItemId: request.workItemId,
        // 缺省取自身：与队员 run「无父项」时的既有口径一致（见 `LeaderRunRequest` 注释）。
        parentWorkItemId: request.parentWorkItemId ?? request.workItemId,
        agentId: request.agentId,
        isLeaderTask: true,
        branch: null,
        dirName: null,
        status: "open",
        sessionId: null,
        // 同 `openMemberRun`：成因/入边原样透传（队长这一支 host 不传 `causedByRunId` ⇒ NULL）。
        dispatchCause: request.dispatchCause ?? null,
        causedByRunId: request.causedByRunId ?? null,
        // 0014：队长直登行的起算点 = 登记时刻（容量满转排队时由 repo 的排队语句写 NULL）。
        openedAt: now,
        settleReason: null,
        createdAt: now,
        updatedAt: now,
      };
      /* 原子登记（见 `SquadRunRepo.insertLeaderRunIfNotInProgress` 的注释）：前置写在语句里，
         所以两条**并发**派发也只可能有一条活跃队长行 —— 光靠「读一次再写」挡不住那个窗口
         （两次读都可能早于对方的写入），而那正是「同一个工作项起两条队长 run」的来路。
         返回 false = 已有进行中的队长 run ⇒ **本次并入**（§5.7(1)/S13），把结论如实交回调用方。
         C3 起（A8「吸收优先于排队」）：有名册上限时改走 `insertLeaderRunOrQueue`——语句同持
         「无活跃队长行 + 容量未满」两前置；容量满 ⇒ 队长排队行；已有排队行 ⇒ 并入留痕。 */
      const leaderLimit = deps.resolveAgentMaxConcurrentRuns?.(request.agentId);
      if (leaderLimit !== undefined) {
        const gated = squadRunRepo.insertLeaderRunOrQueue(record, leaderLimit);
        if (gated.kind === "recorded") return { recorded: true };
        if (gated.kind === "queued" || gated.kind === "coalesced") {
          return { recorded: false, reason: "capacity_full_queued" };
        }
        // absorbed ⇒ 落到下方与「读一次再决定」窗口同一口径的收口（runId 复用检查 + 吸收结论）。
      } else if (squadRunRepo.insertLeaderRunIfNotInProgress(record)) {
        return { recorded: true };
      }
      /* 走到这里说明**这次没写进去**。先把「runId 复用」这一格翻回**响亮错误**：
         语句的前置（NOT EXISTS 活跃队长行）会先于主键冲突生效，于是同 runId 的重复登记
         会「少一行且不抛」—— 那会把一个调用方 bug 静默成一个「已并入」（两次 run 的成果
         落进同一个身份里）。与 `openMemberRun` 同口径：**复用 runId 必须响亮**。 */
      if (squadRunRepo.get(request.runId) !== null) {
        throw new Error(
          `队长 run 的 runId 已存在（UNIQUE 冲突）：${request.runId}。` +
            "复用 runId 会让两次 run 的成果落进同一个身份里，故拒绝；" +
            "若要重新指派，请等这条 run 收口后再用新的幂等键。",
        );
      }
      return { recorded: false, reason: "in_progress_run_exists" };
    },

    async completeLeaderRun({ runId }) {
      const record = requireRun(runId);
      /* **只收队长行**（见接口注释末段）：误用于队员行会把一条从未合并的分支置 `merged`，
         编排器随后按「`merged` 且有分支」把它连树带枝丢弃 —— 成果未落地就被删，且不报错。
         判据用 `isLeaderTask` + `branch === null` 两个一起：只判身份会漏掉「自称队长却有分支」
         这种被写坏的行，只判分支会漏掉「自称队员却无分支」的行；两者都排除才是「这条行真的没有
         可合并/可抛弃的工作面」。 */
      if (!record.isLeaderTask || record.branch !== null) {
        throw new Error(
          `runId=「${runId}」不是队长 run（isLeaderTask=${String(record.isLeaderTask)}、` +
            `branch=${String(record.branch)}）：completeLeaderRun 只收口队长行。` +
            "误用于队员行会把一条从未合并的分支置 merged，编排器随后会把它连树带枝当已合并丢弃。",
        );
      }
      // 幂等：同一条「成功」事实被重投一次（终态事件重放 / 双路径）不报错、也不再动任何东西。
      if (record.status === "merged") return;
      /* 只接受 `open`：`discarded` 说明这条 run 已经按失败/中止收口过，把它改写成 `merged`
         是**跨终态改写**，会掩盖它当初为什么没跑完；`produced` / `rejected` 对队长行本不该出现
         （队长没有产出/审查这一步），出现即说明有第二处写者动了这条行 —— 一律响亮抛，不做猜测。 */
      if (record.status !== "open") {
        throw new Error(
          `runId=「${runId}」当前状态是「${record.status}」而不是 open，不能收口为成功（跨终态改写）：` +
            "把一条已按失败/中止收口的队长 run 改写成 merged，会掩盖它当初为什么没跑完。",
        );
      }
      // 只动台账状态这一列（队长无工作树、无分支：没有任何东西要动）：**不碰 git、不碰工作项状态**。
      settleStatus(runId, "merged");
    },

    async completeMemberRun({ runId }) {
      const record = requireRun(runId);
      // 台账状态：产出即 `produced`（该分支从此算「活跃」——已产出未合并，spec §6.2 要求它活到合并）。
      settleStatus(runId, "produced");
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
        settleStatus(runId, "rejected");
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
        settleStatus(runId, "merged");
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
      settleStatus(runId, "discarded");
    },

    async bindMemberRunSession({ runId, sessionId }) {
      // 行缺失 / runId 算错一律响亮抛（与其它方法同一口径：静默会让「这个 run 用哪个会话」无人知道）。
      requireRun(runId);
      squadRunRepo.bindSession(runId, sessionId);
    },

    async failMemberRun({ runId, reason }) {
      // 没有原因就没有可行动的留痕：一条「失败了但不知道为什么」的台账行，事后无法处置。
      if (reason.trim() === "") {
        throw new Error(
          "failMemberRun 必须给出失败原因（reason）：空原因等于把「为什么这条 run 没了」抹掉，" +
            "事后无从处置（台账行只剩一个 discarded）。",
        );
      }
      const record = requireRun(runId);
      // 幂等：已经 discarded ⇒ 重复调用（重投 / 双路径）不报错、也不再动任何东西。
      if (record.status === "discarded") return;
      /* 只接受 `open`：失败的定义是「**从未产出**」。`produced` / `merged` 说明队员交了东西
         （当失败丢弃会丢掉他的活）；`rejected` 说明产出被判待修（要活到修复后合并，spec §6.2）。
         这三种状态走本方法一律**响亮抛**，不做「看起来像失败就丢弃」的猜测。 */
      if (record.status !== "open") {
        throw new Error(
          `runId=「${runId}」当前状态是「${record.status}」而不是 open，不能按失败处置（reason=${reason}）：` +
            "produced/merged/rejected 都意味着已经产出了东西，当失败丢弃会丢掉队员的活，故拒绝。",
        );
      }
      // 只改台账，**不碰 git**：树与分支的清理交给启动回收器（它们已不在活跃集，spec §6.6/S15）。
      // 0014：失败原因**落盘**（`settle_reason`）——它此前被丢弃，而 TTL 审计 / 熔断窗口计数 /
      // 重试预算三处派生判据都读它；看门狗族与 user_cancel 的**码值**单源在 `squadRunRepo.ts`。
      settleStatus(runId, "discarded", { reason });
    },
  };
}
