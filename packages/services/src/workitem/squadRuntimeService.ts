import {
  isTerminalWorkItemStatus,
  resolveWorkspaceKey,
  type Squad,
  type TeamAgent,
  type WorkItem,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CreateSquadInput } from "../teams/squadService.js";
import type { CreateTeamAgentInput } from "../teams/teamAgentService.js";
import type { ReapOutcome } from "../worktree/orphanReaper.js";
import type { SquadBatchOrchestrator, SquadRuntime } from "./squadContracts.js";
import type {
  LeaderRunRecordOutcome,
  LeaderRunRequest,
  MemberRunRequest,
  OpenMemberRunResult,
  ReviewOutcome,
} from "./squadRunLifecycle.js";
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

/** 队长派单「指派」的入参（**加法**，2026-10-02 裁定 Important-1）。 */
export type AssignWorkItemRequest = { workItemId: string; agentId: string };

/** 启动重驱的结论（Important-2）：重驱了哪些父项、哪些失败（失败项要由调用方**响亮**记日志）。 */
export type BatchReplayOutcome = {
  replayed: string[];
  failures: Array<{ parentWorkItemId: string; error: unknown }>;
};

/**
 * 「响亮留痕」的注入形态（Minor-3）：本文件必须**浏览器安全**（`index.ts` 值导入导出它），
 * 不能 import node 侧的 logger，故日志能力由组合根注入（与 `readExperimentEnabled` 同一手法）。
 */
export type SquadRuntimeLogWarn = (message: string, error?: unknown) => void;

/**
 * 「本工作项是一支小队批次的**根**」的**唯一判据**（`packages/services/src/index.ts` 从**值**入口导出，
 * 故纯函数、浏览器安全）。
 *
 * 为什么它必须只有一处定义：这条判据有两个消费方 —— 启动重驱（`replayUnfinalizedBatches` 用它枚举
 * 「可能有未收尾批次的父项」，缺陷 1 的修法）与**最小视图的「放弃整批」入口**（UI 只在批次根上给出
 * 破坏性动作）。两处各写一份「什么是批次根」迟早漂移，而漂移**不报错** —— 表现会是「界面给的按钮
 * 服务层不接受」或反过来「某类批永远看不见入口」。
 *
 * 两条**并列**证据（命中任意一条即为批次根）：
 * (a) 台账里有以它为 `parentWorkItemId` 的 run 行 —— 有队员产出过的批；
 * (b) 本项被**指派给小队**（`assignee.type === "squad"`）—— 小队的批次根，且**空批没有任何 run 行**
 *     （例如唯一子项在派单前被取消）也覆盖得到。
 *
 * 为什么不能用「父项有子项」代替 (b)：这对一个**普通父项**同样为真 —— 那会把无关的父项也认成批次根
 * （重驱会跨过它自己的验收把它推到 `done`；UI 会给它一个会删分支的破坏性入口）。
 *
 * `runParentWorkItemIds` 由调用方从**自己的取数口**给出（服务侧是 `squadRunRepo.listByParent`，
 * UI 侧是快照的活跃 run 集合）：本函数不做 IO，也不去猜该查哪张表。
 */
export function isSquadBatchRoot(input: {
  workItem: Pick<WorkItem, "id" | "assignee">;
  runParentWorkItemIds: readonly string[];
}): boolean {
  return (
    input.workItem.assignee.type === "squad" ||
    input.runParentWorkItemIds.some((parentId) => parentId === input.workItem.id)
  );
}

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
  /**
   * 登记一次**队长 run**（**加法**，P2b 余项）：**只登记，不执行** —— 不开工作树、不改工作项状态。
   *
   * 缺口与后果：此前 `ISquadRuntimeService` 上没有队长 run 的写入口，而 `openMemberRun` 传
   * `isLeaderTask: true` 会**照样开树**（那是给队员用的）⇒ 队长 run **完全不进台账**。后果是
   * spec §5.7(1)「队长 run **进行中**时的重复指派合并为同一次」**没有判据**（无记录 ⇒ 无从判
   * 「进行中」），且 `getSnapshot().runs` 永远看不见队长 run。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **唯一写者不变**：实现只经 `runtime.lifecycle.recordLeaderRun`（其内部只调
   *    `squadRunRepo.insert`），调用方不得自己 INSERT（那会成为台账的第二个写者）。
   * 2. **不越权**：不建工作树（队长在目标工作区执行，spec §6.1/§6.2）、不写工作项 `status`
   *    （§5.7(2) 队长 run 不改父项状态）—— 见 `SquadRunLifecycle.recordLeaderRun`。
   * 3. **不过门禁**：本方法**只登记一次已经通过门禁、即将发出的 run**，自身不开始任何派发。
   *    门禁的唯一判据仍是 `assertDispatchEnabled`（这里不新增第二处判据）。此处**不**再判一次
   *    也是**有意的**：切换开关与登记之间若恰好翻转，再判一次会把一条**已经在跑**的 run 挡在
   *    台账外（「在跑但无记录」比「多一行记录」更坏 —— 后者至少能被看见）。
   *
   * **可区分**：队长行 `is_leader_task=1`、`branch=null`、`dir_name=null`。用 `is_leader_task`
   * 作身份标记（`branch` 是「有没有可操作的分支」的**操作性**判据，二者不可互替 —— 见
   * `squadOrchestrator.memberRuns` 的注释）。
   *
   * **「进行中」的读法**（给**重复指派合并**用，spec §5.7(1)）：唯一实现是
   * `hasInProgressLeaderRun(runs, workItemId)`（由 `squadRunLifecycle.ts` 导出）——`getSnapshot().runs`
   * 即活跃集合（已含队长行、已排除终态），命中即「该工作项有进行中的队长 run」⇒ 重复指派应合并
   * 而不是新起一次。调用方**不得**自己重写这条投影（第二份定义迟早漂移，而漂移不报错）。
   *
   * **要「真的」可判定还差一半的写者**：登记只写 `open`；队长 run 结束时若不写终态，这条行会长驻
   * 活跃集 ⇒ 读法**恒真**。补上它的正是下面的 `completeLeaderRun`（成功）与 `failMemberRun`（失败/中止）。
   */
  recordLeaderRun(
    target: SquadWorkspaceTarget,
    input: LeaderRunRequest,
  ): Promise<LeaderRunRecordOutcome>;
  /**
   * 队长 run 的**成功终态收口**（**加法**，P2b 余项）：把队长行从 `open` 移到终态（`merged`）。
   *
   * 为什么必须有它：`recordLeaderRun` 只登记，而队长 run **没有队员那一步 review/merge**
   * （无分支可合、无树可抛，spec §6.1/§6.2）⇒ 没有既有方法会把这条行移出活跃集 ⇒ **成功的队长行
   * 长驻 `open`** ⇒ `hasInProgressLeaderRun` **恒为真** ⇒ §5.7(1) 的「重复指派合并」会把该工作项的
   * 所有后续指派**永久吃掉**（且不报错）。这不是「少一个便利动作」，而是判据被架空。
   *
   * 与 `completeMemberRun` 的**刻意差异**（对称但不等同）：**不推工作项状态**（spec §5.7(2)
   * 「队长 run 不改父项状态」——套上 `completeMemberRun` 那句 `in_review` 会写坏父项）、
   * **直接到终态**（队员的产出要活到合并，故 `produced` 仍是活跃态；队长无分支/工作树，run 结束
   * 即收口）。队长行 `branch=null` ⇒ §6.2「终态**不得**影响工作树生命周期」成立。
   *
   * 三条纪律（与 `failMemberRun` 同款）：**唯一写者**（只经 `squadRunRepo.setStatus`）、
   * **前置读当时状态**、**未命中 / 跨终态响亮抛**（已是 `merged` 幂等返回；`discarded` 等跨终态**抛**）。
   * **只收队长行**（非队长行抛 —— 误用于队员行会把从未合并的分支置 `merged`，随后被连树带枝丢弃）。
   * **不过门禁**：收口在途 run 不是「新派发」（与 `completeMemberRun` 同理由）。
   */
  completeLeaderRun(target: SquadWorkspaceTarget, input: { runId: string }): Promise<void>;
  /** run 终态（host 派发桥调用）。**不过门禁**：收尾在途 run 不属「新派发」。 */
  completeMemberRun(target: SquadWorkspaceTarget, input: { runId: string }): Promise<void>;
  /**
   * 审查裁决（最小视图按钮调用）。**不过门禁**：审查既有产出的动作不产生新派发。
   *
   * 通过（approved）时本方法做**两件事**，且次序固定：① 把该队员分支合进**集成分支**（生命周期层）；
   * ② 把**该子工作项**推进到终态（裁定 1，经唯一写者 `workItemService.transition`）—— ② 是
   * 「子项全终态 ⇒ `children_done` ⇒ 批次 finalize」这条链的唯一写者，缺了它整批永不收尾。
   * 打回（rejected）**不写**工作项状态：工作树与分支存活到修复后重新审核（spec §6.2）。
   */
  reviewMemberRun(
    target: SquadWorkspaceTarget,
    input: { runId: string; verdict: "approved" | "rejected" },
  ): Promise<ReviewOutcome>;
  /**
   * 把**既有**工作项指派给某位队员（裁定 Important-1，2026-10-02）：**改负责人 + 发出派发事件**。
   *
   * 语义严格按设计（§5.1「多路输入、一处写入」/ §5.6「`@` ≠ 指派」）：
   * 1. **只经既有唯一写者之路改工作项**：负责人不是 `status`（唯一写者那条约束管的是 `status`），
   *    走 `workItemRepo.updateAssignee` 那一层——repo 仍是内部件，调用方只经本方法；
   * 2. **只发派发事件，不直接开 run**：事件经**唯一出口**（`SquadRuntime.emitWorkItemEvent`
   *    ↔ `subscribeWorkItemEvents` 同一张表）发出；本方法**不调** `openMemberRun`
   *    （开 run 是派发路径的事，不是「指派」的事）；
   * 3. **入口过门禁**（入口③，与 createWorkItem / openMemberRun 同一处判据）：指派 = 新派发。
   */
  assignWorkItem(
    target: SquadWorkspaceTarget,
    input: AssignWorkItemRequest,
  ): Promise<{ assigned: true }>;
  /**
   * 失败 run 的出口（裁定 Important-3）：把执行失败的 run 移出活跃集，使其工作树/分支**可被回收**。
   * **不过门禁**：收口失败 run 不是「新派发」。与 `reviewMemberRun` 同款纪律（唯一写者 / 前置读当时
   * 状态 / 未命中响亮抛），见 `SquadRunLifecycle.failMemberRun`。
   */
  failMemberRun(
    target: SquadWorkspaceTarget,
    input: { runId: string; reason: string },
  ): Promise<void>;
  /**
   * 会话建立后把 `sessionId` 回写该 run 的台账（裁定 Important-4）：让忙检查的**强探测**与
   * `deferred` 分支真正可达（否则台账恒为 `null`，保护为零）。**不过门禁**：不是「新派发」。
   */
  bindMemberRunSession(
    target: SquadWorkspaceTarget,
    input: { runId: string; sessionId: string },
  ): Promise<void>;
  /**
   * 启动**重驱**未收尾的批次（裁定 Important-2）：对「子项全部终态、但该批尚未 finalize」的父项
   * 再跑一次 `advanceAfterChildrenDone`。**幂等**（沿用编排层的 CAS / 前置读当时状态 / 重放闸）；
   * **响亮**（失败逐条留在返回值里，由调用方记日志）。不实现「重发 `child_completed`」——
   * 事件在崩溃后不会再有人重放，所以恢复动作必须是**幂等的重驱**而不是重放事件。
   *
   * **发现判据不得只依赖 run 台账行**（缺陷 1 的修法）：空批（无任何队员 run）在台账里没有行，
   * 只按行找会**永远看不见它** —— 父项永久滞留 `todo`。故枚举用两条并列证据：run 台账行
   * （有产出过的批）**或**父项被指派给小队（批次根；覆盖空批）。见实现内的详注。
   */
  replayUnfinalizedBatches(target: SquadWorkspaceTarget): Promise<BatchReplayOutcome>;
  /** 启动回收（host 启动路径调用，spec §6.4/§6.6）。**不过门禁**：清理是恢复步骤，不是新派发。 */
  reapStartupOrphans(target: SquadWorkspaceTarget): Promise<ReapOutcome>;
  /** 归档小队 + 指派转交队长（#9，spec §3.10/S10）。**先转交后归档**。 */
  archiveSquadAndTransfer(target: SquadWorkspaceTarget, id: string): Promise<void>;
  /**
   * **整批放弃**（spec §6.3「整批可整体放弃」，**加法**）：用户显式取消一个**还没合回主分支**的批 ——
   * 逐个抛弃队员（删分支 + 清工作树，含 `produced` / `rejected`）→ 删集成分支 → 父项置 `cancelled`。
   *
   * 为什么必须补这个入口：机制（`SquadBatchOrchestrator.discardBatch`）早已实现，但此前
   * **没有任何生产调用方** ⇒ 服务面与 host 都够不到 ⇒ §6.3 承诺的「整批可整体放弃」**用户用不了**，
   * 只有「合并后自动抛弃」可达。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **唯一写者不变**：父项状态只经 `workItemService.transition`（编排器内部已如此），本方法不碰 repo。
   * 2. **不过门禁**：放弃**不产生新派发**，与 `reviewMemberRun` / `failMemberRun` 同款 ——
   *    关掉实验开关只停新派发（§5.7.6），若把放弃也拦下，用户就**收不掉**一个已经在跑的批。
   * 3. **显式目标**：第一个参数就是 `SquadWorkspaceTarget`（裁定 4：没有隐式默认 workspace）。
   *
   * **前置条件由编排层响亮拒绝**（全部在任何 git 写动作**之前**）：父项不存在 / 已归档、父项已终态
   * （`done` = 成果已合回主分支；`cancelled` = 已放弃过）、或集成分支已合回 base —— 见
   * `squadOrchestrator.discardBatch` 的详注。**「已合回主分支的批」= 拒绝**（不得静默丢弃已落地成果）。
   *
   * **发现判据**：哪些工作项是批次根由 `isSquadBatchRoot` 给出（与 UI 入口共用同一份定义）。
   */
  discardBatch(target: SquadWorkspaceTarget, input: { parentWorkItemId: string }): Promise<void>;
}

export const ISquadRuntimeService = createServiceDescriptor<ISquadRuntimeService>("squad-runtime");

/**
 * 审查通过 ⇒ 该子工作项推进到**终态**（`done`）——裁定 1：闭合「子项终态 ⇒ `children_done` ⇒ 批次收尾」的链条。
 *
 * 为什么必须补这个写者：`reviewMemberRun(approved)` 把队员分支合进**集成分支**之后就结束了 ——
 * 全仓里 `"done"` 只出现在编排器给**父项**的地方，谁都不写**子项**的终态。于是
 * `workItemService.transition` 内部的 `areAllChildrenTerminal` 永远为假 ⇒ `workitem.child_completed`
 * 永不发出 ⇒ `advanceAfterChildrenDone` 永不运行 ⇒ 整批永不 finalize ⇒ 用户既看不到 `done`，
 * 主分支也永远拿不到成果。这不是「少一个便利动作」，而是闭环断在这里。
 *
 * 三条纪律（逐条对应裁定原文）：
 * 1. **写者不变**：只经 `workItemService.transition`（唯一写者）。本函数不碰 repo 的 `updateStatus`、
 *    不写裸 SQL、不在协议 handler 里写状态。
 * 2. **条件驱动，不是渲染驱动**（spec §4.2 / §4.3）：推进由「审查通过」这个**条件**发生 —— 本函数不读
 *    界面正在显示什么，也不让状态反过来驱动执行。
 * 3. **前置读当时状态、不得写死**：CAS 的 `expect` 必须来自**此刻**读到的子项状态。写死一个前置
 *    （例如 `in_review`）会在子项实际停在别处时**静默未命中**，而 §5.7.5 的「未命中即丢弃」会把那次
 *    结算吞掉 —— 用户既看不到 `done`，也看不到任何报错。这不是假想：机械半 `completeMemberRun` 的
 *    `in_review ← in_progress` 前置就是写死的，而**全仓没有任何路径把子项推到 `in_progress`**
 *    （`workItemService.create` 给的是 `todo`）⇒ 由队长建出的子项事实上停在 `todo`，写死前置必不命中。
 *    故这里先读当时状态再拿它当前置；读到写之间被人改了（真 CAS 未命中）则**响亮抛**，绝不静默丢弃。
 *
 * **次序硬约束**：调用点只能在**合并成功之后**。反序（先标终态、后合并）会让子项终态抢先触发
 * `child_completed` ⇒ 批次在集成分支还缺这份成果时就 finalize —— 半批已经落到主分支上，且回不去。
 *
 * 「子项已是**另一个**终态」（例如用户把它 `cancelled` 了）⇒ **不跨终态改写**，也不抛：
 * · 不改成 `done`：跨终态改写会掩盖这条批是按什么次序结算的；
 * · 不抛：此刻合并**已经落地**，抛出去会把一次成功的合并变成一次响亮失败，而上层拿到失败后
 *   并不会去回滚集成分支 —— 那份产出就悬在那里。这与编排层对「子项被取消」的既有口径一致
 *   （`全 cancelled 子项：仍按 run 台账结算`）：取消子项不代表丢弃它已产出的活。
 * 这条支路有专门用例（断言「不抛、也不改写」），故它是**显式结论**而不是被吞掉的分支。
 *
 * **Minor-3（2026-10-02 裁定）：口径统一。** 「子项不存在/已归档」与上面那条支路处在**同一位置**
 * （都在合并**已落地之后**）⇒ 必须同口径：**不抛 + 响亮留痕**（`logWarn` 带原文）。旧实现这里抛错，
 * 与它自己的论证直接矛盾（README 形态：一次成功的合并被一个「找不到子项」的异常翻成响亮失败，
 * 且上层不会回滚）。留痕经注入的 `logWarn`（本文件必须保持浏览器安全，不能 import node 侧 logger）。
 * 与「runId 算错」严格区分：那是**调用方传参错误**（不是数据状态），继续响亮抛。
 */
function settleChildWorkItem(
  runtime: SquadRuntime,
  runId: string,
  logWarn: SquadRuntimeLogWarn,
): void {
  const record = runtime.squadRunRepo.get(runId);
  if (!record) {
    throw new Error(
      `审查通过后推进子项失败：squad_runs 没有 runId=「${runId}」的行。` +
        "静默跳过会让这次审查看起来成功了，而那条子工作项仍停在非终态 —— 整批就此永不收尾。",
    );
  }
  const item = runtime.workItemRepo.get(record.workItemId);
  if (!item) {
    /* 子项不存在 / 已归档：合并**已经落地**（与「已取消」支路同一位置），故**不抛** ——
       抛出去会把一次成功的合并变成响亮失败，而集成分支不会因此回滚。改为**响亮留痕**：
       这条工作项不再参与 `children_done` 判定，是必须让人看见的事实（否则整批永不收尾且无人知道）。 */
    logWarn(
      `审查通过后推进子项失败：子工作项「${record.workItemId}」不存在或已归档（runId=${runId}）。` +
        "本次合并已落地，但该子项不再参与 `children_done` 判定 —— 这一批需要人工收尾。",
    );
    return;
  }
  // 幂等：已是目标态就直接返回（不重复发事件 —— 事件是下游唯一判据，重复发会重复结算）。
  if (item.status === "done") return;
  if (isTerminalWorkItemStatus(item.status)) return;
  if (!runtime.workItemService.transition(item.id, "done", item.status)) {
    throw new Error(
      `子工作项「${item.id}」的终态 CAS 未命中：读到前置「${item.status}」、目标「done」，` +
        "但写入时该行已不是读到的那样（并发改动）。静默丢弃会让这次结算消失得无影无踪（§5.7.5），故响亮抛出。",
    );
  }
}

/**
 * 服务实现。依赖全部由组合根注入（本文件不得 import node 侧的值）。
 *
 * 关于「读开关」的纪律（确认 2）：服务侧**唯一**的判据是下面的私有 `assertEnabled()`；
 * `assertDispatchEnabled` / `createWorkItem` / `openMemberRun` 三个入口都调它，没有第二处判断。
 * 它读的就是组合根注入的 `readExperimentEnabled`（node.ts 里是门禁用的那份同步快照）。
 * 同一个 `readExperimentEnabled` 也被 `getSnapshot().enabled` 用于 UI 呈现 —— 那是**同一份值**的
 * 第二个用途，不是第二个判据：呈现读到相反的值既不会放行、也不会拦截任何派发。
 * `SquadRuntime.assertDispatchEnabled`（冻结签名）是 host 走「规则 tick」入口的形态，
 * 它读的是组合根注入给 runtime 的**同一个闭包**（两处同源 ⇒ 不可能漂移）。
 */
export function createSquadRuntimeService(deps: {
  /** 按目标现构 runtime（裁定 4 + 确认 3：不缓存、不取首个）。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /**
   * 读实验开关：**门禁（服务侧唯一判据）与 UI 呈现共用这一份结论**。
   * 组合根注入的是门禁用的那份同步快照，故它与注入给 runtime 的是同一份值。
   */
  readExperimentEnabled: () => Promise<boolean>;
  /**
   * 归档 + 指派转交（组合逻辑在 `squadRuntime.ts`：它要用 workItemRepo，而描述符这一侧必须浏览器安全，
   * 不能值导入那个模块）。由组合根注入。
   */
  archiveSquadAndTransfer: (target: SquadWorkspaceTarget, id: string) => Promise<void>;
  /**
   * 批次编排工厂（`createSquadOrchestrator`）。**注入**：编排器模块 import 了 node 侧依赖
   * （`node:crypto` 等），本文件值导入它会破坏浏览器安全不变量（见文件头注释）。
   *
   * 可选以保持**既有调用方不受影响**（加法）：未注入时 `replayUnfinalizedBatches` **响亮抛**
   * ——缺工厂就说明这一份 runtime 的服务面根本没接上批次层，静默 no-op 会让崩溃窗口永久卡死。
   */
  createOrchestrator?: (deps: { runtime: SquadRuntime }) => SquadBatchOrchestrator;
  /**
   * 响亮留痕（Minor-3 的子项缺失支路要用）。同样**可选**：未注入时回落到 `console.warn`
   * （本文件必须浏览器安全，不能值导入 node 侧 logger；`console` 是两侧都有的最小交底）。
   */
  logWarn?: SquadRuntimeLogWarn;
}): ISquadRuntimeService {
  /** 本 runtime 的 `workspace_key`（C14 口径）：台账与快照都按它过滤。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

  /** 响亮留痕的唯一去处（Minor-3）：注入优先，否则回落 console（见 deps.logWarn 的理由）。 */
  const logWarn: SquadRuntimeLogWarn = deps.logWarn ?? ((message) => console.warn(message));

  /**
   * 门禁的**唯一判据**（spec §5.7.6 / 确认 2）。三个入口（`assertDispatchEnabled` 自身、
   * `createWorkItem`、`openMemberRun`）都调**这一个**函数。
   *
   * 为什么在这里读注入的开关、而不是「先建 runtime 再问 runtime」：门禁要回答的问题是
   * 「现在允不允许新派发」，它与目标 workspace 是不是一个**可用的 git 仓库**无关。
   * 先建 runtime 会先跑 `git symbolic-ref` 解析 base 分支（构造期解析、失败即抛），
   * 于是在**非 git 目标**上关闭开关时，调用方拿到的是「base 分支解析失败」而不是**门禁结论** ——
   * 上层据错误码分流（`SQUAD_DISPATCH_DISABLED_CODE`）就分不出来，界面上会显示成 workspace 坏了。
   * 判据的值只有一处来源：组合根注入的 `readExperimentEnabled`（node.ts 里就是门禁用的那份
   * `squadsEnabled` 同步快照，与注入给 runtime 的是**同一个**闭包 ⇒ 两处不可能漂移）。
   * `SquadRuntime.assertDispatchEnabled`（冻结签名）仍是 host 走「规则 tick」那条入口的形态，
   * 它读的是同一个来源；本函数是服务侧三个入口的形态。
   */
  const assertEnabled = async (): Promise<void> => {
    if ((await deps.readExperimentEnabled()) !== true) {
      throw new SquadDispatchDisabledError();
    }
  };

  return {
    async assertDispatchEnabled(_target) {
      // 只答门禁问题：**不构造 runtime**（也就不依赖 git 解析），只读设置、只抛错。
      await assertEnabled();
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
      // 入口② 的闸：**先**判门禁（用的是服务侧唯一判据，不需要先建 runtime），再建项。
      // 「拦在入口而不是半路」：半路拦会留下一条已入队的工作项，看上去像是派发成功了一半。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
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
      // 入口①（队员段）与入口③ 共用的这一道闸（与上面、与 assertDispatchEnabled 是同一个函数）。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.openMemberRun(input);
    },

    /**
     * 队长 run 的登记：**只登记不执行**（门禁理由见接口注释第 3 条 —— 本方法不过门禁）。
     * 委托给 `lifecycle.recordLeaderRun`：台账的写入口只有生命周期这一处，服务面不做第二份拼装。
     */
    async recordLeaderRun(target, input) {
      const runtime = await deps.createRuntime(target);
      // 结论**原样交回**（`recorded: false` = 本次并入进行中的那次，§5.7(1)/S13）：服务面不替调用方
      // 消化这个结论 —— 谁能起会话只有它自己知道，在服务面「当成功吞掉」会让上层以为 run 起了。
      return runtime.lifecycle.recordLeaderRun(input);
    },

    /**
     * 队长 run 的成功收口：**只把台账行移到终态**（门禁理由与 `completeMemberRun` 同 —— 不过门禁）。
     * 委托给 `lifecycle.completeLeaderRun`（唯一写者是生命周期层，服务面不做第二份动作；
     * 也**不在这一层**碰任何工作项状态 —— §5.7(2) 队长 run 不改父项状态）。
     */
    async completeLeaderRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.completeLeaderRun({ runId: input.runId });
    },

    // 以下三个**不过门禁**：收尾 / 审查 / 回收都不是「新派发」。
    // 关掉开关时若把它们也拦下，正在跑的那批 run 会卡在中间状态（spec §5.7.6 只停新派发）。
    async completeMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.completeMemberRun({ runId: input.runId });
    },

    async reviewMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      const outcome = await runtime.lifecycle.reviewMemberRun({
        runId: input.runId,
        verdict: input.verdict,
      });
      /* 裁定 1（闭环的第三环）：审查**通过** ⇒ 该子工作项推进到终态。
         顺序不可反：这里在**合并成功之后**才写（先写会让子项终态抢先触发 `child_completed`，
         批在集成分支还缺这份成果时就 finalize —— 半批落到主分支上，回不去）。
         `rejected` 走不到这一支（`merged === false`）：被打回待修的子项**保持 `in_review`**，
         工作树存活到修复后重新审核（spec §6.2 / §16 S5）。 */
      if (outcome.ok && outcome.merged === true) {
        settleChildWorkItem(runtime, input.runId, logWarn);
      }
      return outcome;
    },

    async assignWorkItem(target, input) {
      /* 入口③（队长派单工具）与入口①② 共用**同一个**门禁判据（指派 = 新派发）。
         「拦在入口」：半路拦会留下一条已改负责人、却没有派发事件的工作项（看上去成功了一半）。 */
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      const item = runtime.workItemRepo.get(input.workItemId);
      if (!item) {
        // 响亮：本方法只改**既有**工作项的负责人（用 `createWorkItem` 会重建一条，丢掉 id 与已有子项）。
        throw new Error(
          `指派失败：工作项「${input.workItemId}」不存在或已归档。本方法只改既有工作项的负责人，` +
            "静默建新项会让这条派发挂到一个与调用方所指无关的对象上。",
        );
      }
      // 负责人不是 status（唯一写者那条约束管的是 status）；走 repo 的专用写入口（同样是
      // 「恰命中一行才算成功」的条件更新），不在这里拼 SQL，也不把 repo 暴露给调用方。
      if (!runtime.workItemRepo.updateAssignee(item.id, { type: "agent", id: input.agentId })) {
        throw new Error(
          `指派失败：工作项「${item.id}」在写入时已不可写（被归档或删除）——` +
            "静默 no-op 会让调用方以为派单成功了，而库里仍指着旧负责人。",
        );
      }
      /* **只发派发事件，不在这里开 run**（§5.1 一处写入 / §5.6 `@` ≠ 指派）。
         事件经唯一出口发出：与状态变迁事件是**同一张订阅表**（`SquadRuntime.emitWorkItemEvent`
         ↔ `subscribeWorkItemEvents`），消费方按 `kind` 分流。开 run 由派发路径负责，不由此处代劳。 */
      runtime.emitWorkItemEvent({
        kind: "workitem.dispatch_requested",
        workItemId: item.id,
        agentId: input.agentId,
      });
      return { assigned: true };
    },

    async failMemberRun(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.failMemberRun({ runId: input.runId, reason: input.reason });
    },

    async bindMemberRunSession(target, input) {
      const runtime = await deps.createRuntime(target);
      await runtime.lifecycle.bindMemberRunSession({
        runId: input.runId,
        sessionId: input.sessionId,
      });
    },

    async replayUnfinalizedBatches(target) {
      const runtime = await deps.createRuntime(target);
      const workspaceKey = keyOf(runtime);
      if (!deps.createOrchestrator) {
        // 缺工厂 = 这一份服务面没接上批次层：响亮抛（静默 no-op 会让崩溃窗口永久卡死一批）。
        throw new Error(
          "replayUnfinalizedBatches 无法执行：组合根没有注入 createOrchestrator（批次编排工厂）。" +
            "缺它就没有能重驱收尾的编排器 —— 静默返回空结果会把「这批没恢复」伪装成「本来就没待恢复的批」。",
        );
      }
      const orchestrator = deps.createOrchestrator({ runtime });
      const replayed: string[] = [];
      const failures: Array<{ parentWorkItemId: string; error: unknown }> = [];
      /* 枚举「可能有未收尾批次」的父项 —— 判据**不得只依赖 run 台账行**（缺陷 1 的修法）。
         两条并列的「这是一条小队批次的根」证据，命中**任意一条**即纳入重驱：
         (a) 台账里有本批的 run 行（`listByParent` 非空）：有队员产出过的批（**原有视野**，回归保持）；
         (b) 本项被**指派给小队**（`assignee.type === "squad"`）：小队批次的根 —— **空批没有任何 run 行**
             （例如唯一子项在派单前被取消）。只按 (a) 找会永远看不见它：进程死在「子项转终态」与
             「`child_completed` 转发器跑完收尾」之间时，重启后父项**永久**停在 `todo`，
             没有任何路径会再收它（不是报错，是**永远不动**）。
         为什么 (b) 用「被指派给小队」而不是「父项有子项」：全仓对「本项在一支小队批次里」的判据正是
         「父项负责人是小队」（`leaderDispatch.isSquadBatchChild`）。「子项全终态」对一个**普通父项**
         同样为真，但收尾它会把一个无关的父项跨过自己的验收直接推到 `done` —— 必须用小队指派把它排除。
         （普通父项只靠 `child_completed` 事件的**驱动**才会被收尾；它是事件驱动、要求「有子项**本进程内**
         转过终态」，而重驱是**状态扫描**，会捞到历史遗留的全终态普通父项 —— 二者的差别正在这里。）
         为什么不给空批补一条**假 run 行**：那是伪造事实，会污染 `listActive` / 活跃分支口径与回收判据
         （一条从不存在的 run 被当成真的在跑）。缺证据时补的是**发现判据**，不是**编造台账**。
         这两条证据已收敛成**一处实现**（`isSquadBatchRoot`）：最小视图的「放弃整批」入口也用同一份
         判据（UI 侧传快照的活跃 run 集合），因此不存在「界面认得出、服务层认不出」的第二份口径。 */
      for (const item of runtime.workItemRepo.listByWorkspace(workspaceKey)) {
        const parentRunItems = runtime.squadRunRepo.listByParent(item.id);
        if (
          !isSquadBatchRoot({
            workItem: item,
            runParentWorkItemIds: parentRunItems.map((record) => record.parentWorkItemId),
          })
        ) {
          continue;
        }
        // 已终态 = 已结算（`done`）或已被用户取消（`cancelled`）⇒ 幂等重放应直接跳过，不动 git。
        if (isTerminalWorkItemStatus(item.status)) continue;
        // 子项没全终态 ⇒ 半批，收尾会（正确地）拒绝：这里不重驱，等下一次 `child_completed`。
        if (!runtime.workItemRepo.areAllChildrenTerminal(item.id)) continue;
        try {
          /* 幂等：`advanceAfterChildrenDone` 内部有重放闸（无待合队员且集成分支已不在 ⇒ 空转）与
             「前置读当时状态」的 CAS，重复重驱不会重复合并 / 重复推进。回调里不得 await 的那条约束
             在此**不适用**：这里不是事件回调，是启动恢复路径（没有外层链在等本层）。 */
          await orchestrator.advanceAfterChildrenDone({
            workspaceKey,
            parentWorkItemId: item.id,
          });
          replayed.push(item.id);
        } catch (error) {
          // 逐条收集而不是首错即断：一条坏批不该让其它批的恢复也停下（响亮交给调用方逐条记）。
          failures.push({ parentWorkItemId: item.id, error });
        }
      }
      return { replayed, failures };
    },

    async reapStartupOrphans(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.reapStartupOrphans({ workspaceKey: keyOf(runtime) });
    },

    async archiveSquadAndTransfer(target, id) {
      await deps.archiveSquadAndTransfer(target, id);
    },

    /**
     * 整批放弃（§6.3「整批可整体放弃」）：**只做一件事** —— 把显式目标与 `workspaceKey` 交给编排器。
     *
     * 门禁理由（不过门禁）：放弃是**收尾/取消**动作，不产生新派发，与 `reviewMemberRun` /
     * `failMemberRun` 同款（§5.7.6 只停新派发）。若在这里也判一次开关，用户就**收不掉**一个
     * 开关关闭前已经开跑的批 —— 而放弃恰恰是「把这个批停掉」的那条路。
     *
     * `workspaceKey` 取自 runtime 的**绑定值**（与 `createWorkItem` 取 workspace 列、重驱逐
     * 同一条纪律）：runtime 才是「为哪个 workspace 而构造」的权威；编排层还会再比一次
     * （`assertOwnWorkspace`），异己 key 一律响亮拒绝，不会静默动作在别处。
     *
     * 前置条件（父项存在 / 未终态 / 集成分支未合回 base）由编排层**在任何 git 写动作之前**响亮拒绝
     * —— 见 `squadOrchestrator.discardBatch`，本层不重写一遍（那就是第二份判据）。
     */
    async discardBatch(target, input) {
      const runtime = await deps.createRuntime(target);
      if (!deps.createOrchestrator) {
        // 缺工厂 = 这一份服务面没接上批次层：响亮抛（静默 no-op 会让用户以为「整批已放弃」，
        // 而分支与工作树一个都没被收 —— 那正是本次要消灭的「点了没反应」形态）。
        throw new Error(
          "discardBatch 无法执行：组合根没有注入 createOrchestrator（批次编排工厂）。" +
            "缺它就没有能执行「整批放弃」的编排器 —— 静默返回会把「一个字节都没动」伪装成「已放弃」。",
        );
      }
      const orchestrator = deps.createOrchestrator({ runtime });
      await orchestrator.discardBatch({
        workspaceKey: keyOf(runtime),
        parentWorkItemId: input.parentWorkItemId,
      });
    },
  };
}
