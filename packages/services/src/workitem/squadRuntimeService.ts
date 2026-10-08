/* oxlint-disable eslint(max-lines) -- 小队服务面：ISquadRuntimeService 是冻结接口的聚合入口
   （门禁/快照/台账/花名册/收件箱/队列读取都从这一处出），拆分会在描述符与协议两侧各留一份影子。 */
import {
  isTerminalWorkItemStatus,
  MS_PER_MINUTE,
  parseWorkItemLabels,
  resolveWorkItemDateOnly,
  resolveWorkItemPriority,
  resolveWorkspaceKey,
  SQUAD_BREAKER_WINDOW_MINUTES,
  SQUAD_RETRY_BUDGET,
  workItemDateErrorMessage,
  workItemLabelsErrorMessage,
  workItemPriorityErrorMessage,
  type Squad,
  type TeamAgent,
  type WakeRule,
  type WorkItem,
  type WorkItemCreator,
  type WorkItemPriorityKey,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  CommentDispatchOutcome,
  CommentDispatchReceiptRecord,
  CommentDispatchReceiptRepo,
} from "./commentDispatchReceiptRepo.js";
import type { CreateSquadInput, SquadRosterPatch } from "../teams/squadService.js";
import type { CreateTeamAgentInput, TeamAgentEditablePatch } from "../teams/teamAgentService.js";
import type { ReapOutcome } from "../worktree/orphanReaper.js";
import type { InboxItem, InboxItemInput, InboxItemRepo } from "./inboxItemRepo.js";
import type { SquadBatchOrchestrator, SquadRuntime } from "./squadContracts.js";
import type {
  LeaderRunRecordOutcome,
  LeaderRunRequest,
  MemberRunRequest,
  OpenMemberRunResult,
  ReviewOutcome,
} from "./squadRunLifecycle.js";
import type { SquadRunRecord, SquadRunUsageSnapshot } from "./squadRunRepo.js";
// 用户取消的 `settle_reason` 码值 + 看门狗族（单源；W3 的「取消不计入熔断」判别位与重试触发面）。
// 值导入安全：`squadRunRepo` 只 type-import node:sqlite，值导入链不触达 node:*（本文件必须浏览器安全）。
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_WATCHDOG_SETTLE_REASONS,
} from "./squadRunRepo.js";
// 「改负责人 + 发派发事件」的**唯一实现**（唯一写者纪律 / 同值处置 / 事件出口全在其中）。
// 单拆成文件是为了浏览器安全（本文件被根入口值导出）+ 400 行 lint 门槛，详见该文件的头部注释。
import { applyWorkItemAssignee } from "./workItemAssignee.js";
// 唤醒规则六项（list / create / pause / resume / update / delete）的唯一实现（组装 / 校验 / 排期 /
// CAS 全在其中）。同款拆文件：本文件必须浏览器安全 + 贴着 400 行门槛；门禁口径与「用户暂停」的
// 落库口径见该文件头注释。
import {
  createWakeRuleOps,
  type CreateWakeRuleRequest,
  type UpdateWakeRuleInput,
} from "./squadWakeRules.js";
// 保存视图六件（R6a：list / create / patch / delete + prefs get / put）的唯一实现（名称上限 /
// 闭集 / JSON object 校验 / 权限矩阵 / 配额 / revision CAS 全在其中）。同款拆文件理由见该文件头注释。
import {
  createWorkItemViewOps,
  type CreateWorkItemViewInput,
  type PatchWorkItemViewInput,
  type WorkItemViewPrefsDocument,
} from "./workItemViewService.js";
// 只取类型：`WorkItemViewRecord`（repo 模块只 `import type node:sqlite`，本文件仍保持浏览器安全）。
import type { WorkItemViewRecord } from "./workItemViewRepo.js";
// 工作项级 reactions 两件（P3-R5s）：置上/撤掉 + 本工作项的反应行。同款拆文件（本文件必须浏览器安全
// + 贴着 lint 门槛）；主体身份、emoji 两条闸、工作项归属全在该文件内单源。
import { createWorkItemReactionOps } from "./workItemReactionService.js";
// 只取类型：`WorkItemReactionRecord`（同上，类型擦除，不破坏浏览器安全）。
import type { WorkItemReactionRecord } from "./workItemReactionRepo.js";

/* 小队运行时的**服务面**：UI / host / 工具三处都只经这个描述符取数或触发派发。

   **本文件必须保持浏览器安全**：`packages/services/src/index.ts` 用**值**导入导出它
   （描述符要在 renderer 侧可达），而根入口的运行时依赖一旦触达 `node:*`，整包会在 React 挂载前失败
   （现场是「页面停在启动壳、没有报错浮层」，见 browserSafeRootEntry.test.ts）。
   所以这里对 node 侧模块只用 `import type`，实现函数 `createSquadRuntimeService` 的依赖
   （建 runtime 的工厂、读设置、归档转交）全部由**调用方注入**（node.ts）。
   这与既有约定一致：描述符可从根入口取，实现从 `@zcode/services/node` 取。 */

export type SquadWorkspaceTarget = { path: string; identity: string };

/**
 * `cancelSquadRun` 的入参（**加法**，2026-10-07 裁定；L1 半边）。
 *
 * `reason` 可选 = 写进台账 `settle_reason` 的**码值**（缺省 `SQUAD_RUN_SETTLE_REASON_USER_CANCEL`）。
 * 类型与常量同源出（调用方不得就地抄一份字面量）：它是 W3 的「用户取消不计入熔断窗口 /
 * 不自动重试」的判别位——抄错一个字，一次用户取消会被算成一次看门狗失败，且不报错。
 */
export type CancelSquadRunInput = { runId: string; reason?: string };

/**
 * **看门狗自动重试**的登记结论（W3 §3.5；`registerWatchdogRetry` 的返回）。
 *
 * 三种结论**判别联合**而不是布尔的理由：`false` 会把三件不同的事（预算已用 / 并入既有义务 /
 * 被本方法拒绝）压成一个值，而看门狗的重试是**自动**动作 —— 没人盯着的路径上，「为什么没重试」
 * 必须能从返回值一句话读出来（含被并入到了哪条义务）。
 */
export type WatchdogRetryOutcome =
  /** 新登记一条 `origin="watchdog"` 的义务；`runId` 即重试 run 的身份（新 id，不复用被结算行）。 */
  | { kind: "registered"; runId: string }
  /** 预算已用：同 `(workItem, agent)` 另有**一次**看门狗结算 ⇒ 不再重试（防重试风暴/死循环）。 */
  | { kind: "budget_exhausted" }
  /** 同对已有别的通道的义务（R2/评论）⇒ 并入它（义务表的不变式是「每对至多一行」）。 */
  | { kind: "coalesced"; targetRunId: string };

/**
 * 看门狗判定所需的 **git 事实**（只读口，W1 交付 / W2 的在线 tick 与启动和解臂消费）。
 *
 * 为什么收在服务面：host 侧不得自己碰 git（「UI/host 不直接访问 Repo」的边界纪律，
 * 与 `listSquadRuns` / `listInboxItems` 同款）；而这两项事实的唯一所有者是
 * `WorktreeManager`（活树）与 git（分支 ref）——方法体复用 lifecycle 注入面**同一对调用**，
 * 不新写 git 判据（第二份判据会与 C1 的 `listWorktrees` / `branchRefExists` 注入面漂移）。
 */
export type SquadWatchdogGitFacts = {
  /** 此刻**活着**的工作树分支（`WorktreeManager.list` 投影；detached 树不贡献分支、主工作树不算）。 */
  liveTreeBranches: string[];
  /** 入参 `branches` 里**确有 ref** 的那些（顺序 = 入参顺序；「残枝」= 有 ref 没树）。 */
  existingBranchRefs: string[];
};

export type SquadSnapshot = {
  /** **只读呈现用**（UI 据此隐藏 / 禁用入口）——**它不是门禁**；门禁是下面的 assertDispatchEnabled。 */
  enabled: boolean;
  teamAgents: TeamAgent[];
  squads: Squad[];
  workItems: WorkItem[];
  /** 只列**未合并**的 run（`SquadRunRepo.listActive` 的口径）：最小视图关心的是「还欠收尾的那些」。 */
  runs: SquadRunRecord[];
  /**
   * **排队待开**的 run（C5，`SquadRunRepo.listQueued` 单源、台账序）：排队行无树无分支，
   * 与 `runs` 口径**互斥不得互替**（runs=还欠收尾；queued=还没开跑）。无排队 ⇒ `[]`（非 undefined）。
   */
  queuedRuns: SquadRunRecord[];
};

export type CreateWorkItemRequest = {
  title: string;
  body?: string;
  parentId?: string;
  assignee: WorkItem["assignee"];
  /**
   * 标签原文（`#11` v1，加法）：**原样透传**给 `workItemService.create` —— 归一化与上限判据的
   * 唯一实现在 shared 的 `parseWorkItemLabels`（本层不写第二份规则，也不在这里预校验：
   * 预校验只是把同一件事做两遍，两遍迟早分叉）。超限 ⇒ 该入口响亮抛且不落盘。
   */
  labels?: readonly string[];
  /* ---- Surface 对齐（0018）：新字段可选，缺省 = 未设置（NULL，不编默认值）---- */
  /** 优先级（闭集 `urgent|high|medium|low`）：原样透传给唯一创建入口，闭集外在那里响亮抛。 */
  priority?: WorkItemPriorityKey | null;
  /** 起始 / 截止：日历日期 `YYYY-MM-DD`（Q5），坏日期在唯一创建入口响亮抛。 */
  startDate?: string | null;
  dueDate?: string | null;
  /* 创建人**刻意不在这里**：身份由组合根注入（`deps.localHumanActor`，见该字段注释）——
     让调用方传身份就等于把「谁按下的创建」交给 UI 自证，而设计案 §12-2 明确
     「不应在 UI 自行决定身份」。 */
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
  /**
   * **运行台账的历史读取面**（**加法**，规格 §11.2 活动时间线）：给了 `parentWorkItemId` ⇒
   * 该批的 run（`listByParent` 口径）；否则 ⇒ 本 workspace **全部** run（`listByWorkspace` 口径，
   * 含 merged / discarded 的终态行）。
   *
   * 为什么必须补它：`getSnapshot().runs` 是 `listActive` 的口径（只列未合并的活跃 run —— 快照
   * 关心「还欠收尾的那些」），而时间线要**历史**：已合并 / 已抛弃的 run 也是一次发生过的活动，
   * 只画活跃 run 会让每一次收尾都把图上的一段**静默抹掉**（用户看到的不是「历史」，是「还在跑的」）。
   * 两个口径的分工见 `SquadRunRepo.listByWorkspace` 的注释：**不得互相替代**。
   *
   * 三条纪律（与冻结面既有形态一致）：
   * 1. **只读**：只经 runtime 的 `squadRunRepo` 读，不写任何行、不碰 git。
   * 2. **不过门禁**（`assertDispatchEnabled`）：读历史不是新派发（§5.7.6 只停新派发），与
   *    `reviewMemberRun` / `listInboxItems` 同款理由 —— 关掉实验开关后，界面仍应能查看已经跑过什么
   *    （那正是收尾在途 run / 复盘所需的视野）。**本层不得写任何第二份开关判据**。
   * 3. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），workspaceKey 取自
   *    runtime 的**绑定值**（与 `getSnapshot` / `createWorkItem` 同一条式子 —— runtime 才是
   *    「为哪个 workspace 而构造」的权威）。过滤与排序都由 repo 单源给出，本层不重写 SQL、
   *    不读回后重排（第二份判据会与 repo 漂移，而漂移不报错）。
   */
  listSquadRuns(
    target: SquadWorkspaceTarget,
    input?: { parentWorkItemId?: string },
  ): Promise<SquadRunRecord[]>;
  /**
   * **呈现用的分页历史**（欠账 #13，2026-10-07 裁定）：**第三个口径**，与上面两个各自显式、
   * **不得互相替代**。
   *
   * · `listSquadRuns(target, {parentWorkItemId?})`：**全量**台账（宿主三处消费 —— 评论补投判据、
   *   补投判据、看门狗 tick 要终态行；批内时间线也要**整批**才画得对）；
   * · `getSnapshot().runs`：`listActive` 的活跃集（还欠收尾）；
   * · 本方法：给界面「一个 agent 最近的运行」的**有界**一页 + 不透明 `nextCursor`。
   *
   * 为什么必须是新方法、而不是给 `listSquadRuns` 加分页参数：把「宿主读全量」与「界面读一页」
   * 揉进同一个名字，正是本仓反复禁止的「两种口径合流」—— 宿主拿到一页会静默漏判（补投少投、
   * 看门狗漏结算），而那不是任何断言能看见的错。
   *
   * `agentId` 过滤**下推 SQL**（由 repo 单源给出）：见 `SquadRunRepo.listHistoryPage` 的「假空」。
   * 游标是不透明字符串（服务面**不解析**、原样带回）；非法游标 / 非法 limit 由 repo **响亮抛**。
   * **只读、不过门禁**（读历史不是新派发，与 `listSquadRuns` 同款理由）。
   */
  listSquadRunHistory(
    target: SquadWorkspaceTarget,
    input: { agentId?: string; limit: number; cursor?: string },
  ): Promise<{ runs: SquadRunRecord[]; nextCursor: string | null }>;
  createTeamAgent(target: SquadWorkspaceTarget, input: CreateTeamAgentInput): Promise<TeamAgent>;
  /**
   * 编辑协作智能体的**可编辑定义字段**（名字 / 系统提示词 / 记忆作用域），返回写盘后的实体
   * （**加法**，2026-10-03：名册的一级入口「智能体」要求编辑可用）。
   *
   * 三条纪律：
   * 1. **唯一写者**：只经注入的 `teamAgentService`（它内部 read-modify-write + 原子写盘）。
   *    调用方**不得**自己写 `<ws>/.zcode/squad/agents/<id>.json` —— 第二份写者迟早漂移，
   *    而漂移的表现是「界面看着改了、盘上没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），写进目标自己的
   *    `<ws>/.zcode/squad/agents`——与 `createTeamAgent` 同款（runtime 按目标现构、不缓存）。
   * 3. **不过门禁**：名册管理不产生新派发（§5.7.6 只停新派发），与 `failMemberRun` /
   *    `reviewMemberRun` 同款理由 —— 关掉实验开关后**不该连改名字都不让**（在途 run 的收尾、
   *    名册的整理都与派发无关）。**本层不得写任何第二份开关判据**；界面侧入口的显隐由
   *    `squadEntryVisible` 负责，那是呈现、不是门禁。
   */
  updateTeamAgent(
    target: SquadWorkspaceTarget,
    input: { id: string; patch: TeamAgentEditablePatch },
  ): Promise<TeamAgent>;
  /**
   * 启用 / 停用协作智能体（**加法**）。**不过门禁**：不产生新派发（与 `updateTeamAgent` 同理由）。
   * **唯一写者**：只经注入的 `teamAgentService.setEnabled`（它保留除 `enabled` 外的全部字段，
   * 含 `archivedAt` —— 停用不是归档，两者互不覆盖）。**目标显式**：同 `updateTeamAgent`。
   */
  setTeamAgentEnabled(
    target: SquadWorkspaceTarget,
    input: { id: string; enabled: boolean },
  ): Promise<void>;
  /**
   * 归档协作智能体（**加法**）：只写 `archivedAt`，定义与记忆都保留（不是硬删）。
   * **不过门禁**：不是「新派发」（与 `updateTeamAgent` 同理由；归档本身正是**减少**派发候选的动作）。
   * **唯一写者**：只经注入的 `teamAgentService.archive`。**目标显式**：同 `updateTeamAgent`。
   */
  archiveTeamAgent(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /** ⑤刀（裁定#2）：恢复已归档智能体（清 archivedAt；服务层同口径幂等）。 */
  restoreTeamAgent(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /** ⑤刀（裁定#2）：恢复已归档小队（清 archivedAt；恢复无转交——转交只发生在归档时）。 */
  restoreSquad(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  createSquad(target: SquadWorkspaceTarget, input: CreateSquadInput): Promise<Squad>;
  /**
   * 编辑小队的**可改定义字段**（名字 / 队长 / 名册 / 指令槽位），返回写盘后的实体
   * （**加法**，2026-10-03：小队的一级入口「小队」要求编辑可用）。
   *
   * 三条纪律（与 `updateTeamAgent` 同款）：
   * 1. **唯一写者**：只经注入的 `squadService.updateRoster`（它内部 read-modify-write + 原子写盘，
   *    且逐字段显式构造 `next`——白名单是**运行期**的墙）。调用方**不得**自己写
   *    `<ws>/.zcode/squad/squads/<id>.json` —— 第二份写者迟早漂移，而漂移的表现是
   *    「界面看着改了、盘上没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），写进目标自己的
   *    `<ws>/.zcode/squad/squads`——与 `createSquad` 同款（runtime 按目标现构、不缓存）。
   * 3. **不过门禁**：名册管理不产生新派发（§5.7.6 只停新派发），与 `updateTeamAgent` 同款理由。
   *    **本层不得写任何第二份开关判据**；界面侧入口的显隐由 `squadEntryVisible` 负责（呈现，不是门禁）。
   *
   * 小队**归档**不在此处新增方法：归档要「先转交工作项、后归档」的组合语义，唯一实现在既有的
   * `archiveSquadAndTransfer`（UI 直接调它，见 `squadRuntime.ts` 的详注）。
   */
  updateSquad(
    target: SquadWorkspaceTarget,
    input: { id: string; patch: SquadRosterPatch },
  ): Promise<Squad>;
  /**
   * 启用 / 停用小队（**加法**）。**不过门禁**：不产生新派发（与 `updateSquad` 同理由）。
   * **唯一写者**：只经注入的 `squadService.update`（保留除 `enabled` 外的全部字段，含 `archivedAt`
   * —— 停用不是归档，两者互不覆盖；`update` 合并后会**重新校验**，非法定义被响亮拒绝——
   * 这是可接受的：本方法不做第二份校验，也不新开第三个写路径）。
   * **目标显式**：同 `updateSquad`。
   */
  setSquadEnabled(
    target: SquadWorkspaceTarget,
    input: { id: string; enabled: boolean },
  ): Promise<void>;
  /** 指派即入队 ⇒ **入口过门禁**（入口② 走这条）。 */
  createWorkItem(target: SquadWorkspaceTarget, input: CreateWorkItemRequest): Promise<WorkItem>;
  /**
   * 本 workspace 的唤醒规则（经工作项反查 —— `wake_rules` 表没有 workspace 列，见调度器注释）。
   *
   * **不过门禁**（只读不是新派发，§5.7.6 只停新派发）：关掉实验开关后仍应能查看有哪些规则
   * —— 那是收尾 / 复盘所需的视野（与 `listSquadRuns` / `listInboxItems` 同款理由）。
   * **本层不得写任何第二份开关判据。**
   *
   * 取数口径（实现见 `squadWakeRules.ts`，过滤判据只有那一处）：
   * 1. `wakeRuleRepo.listAll()` **全量**读出（repo 单源排序，本层不重排），
   * 2. 用本 workspace 的工作项 id 集合（`workItemRepo.listByWorkspace(key)`）过滤 ——
   *    `key` 取自 runtime 的**绑定值**（与 `getSnapshot` / `createWorkItem` 同一条式子：
   *    runtime 才是「为哪个 workspace 而构造」的权威）。
   * 3. **已归档工作项的规则列不出来**（有意登记）：`listByWorkspace` 的口径是「归档行视同不存在」
   *    （repo 既定口径，服务面没有列出归档工作项的取数口，`wake_rules` 也没有 workspace 列可反查）
   *    ⇒ 这类规则**无法归属到任何 workspace**。它们同时**不可派发**（host 对归档工作项一律
   *    解析不到 workspace ⇒ tick 响亮失败），属显式的坏配置而非静默消失；若界面确需展示，
   *    下一轮补一条「含归档的按 workspace 列工作项」的 repo 口再收录（本轮不加取数口、不加 SQL）。
   */
  listWakeRules(target: SquadWorkspaceTarget): Promise<WakeRule[]>;
  /**
   * 建一条唤醒规则（**加法**，P2b 第二半：「规则半边」此前**全仓没有任何创建路径** ——
   * `wakeRuleRepo.insert` 零生产调用方 ⇒ 没有 `next_fire_at` 的规则永远不会被调度器扫到）。
   *
   * **过门禁**（§5.7.6）：规则 = 未来派发的排班表，属「新派发」的准备 —— 与 `createWorkItem`
   * 同一处判据（`assertEnabled`），**次序也同款：门禁在构造 runtime 之前过**（门禁只回答
   * 「现在允不允许新派发」，与目标是不是可用的 git 仓库无关；先建 runtime 会在非 git 目标上
   * 把门禁结论换成「base 分支解析失败」，上层按稳定码分流就分不出来）。关掉开关后**响亮拒绝**。
   *
   * 实现要点（唯一实现在 `squadWakeRules.ts`，此处只把 runtime 工厂与门禁接进去）：
   * 1. 组装：`id` 新生成（`globalThis.crypto.randomUUID`）、`fireCount: 0`、`enabled: true`，
   *    排期字段按 kind 原样透传；`condition` / `eventTypes` / `filters` 类型上就没有入口（见
   *    `CreateWakeRuleRequest` 的形状决定）。
   * 2. `validateWakeRule` **优先**：不过 ⇒ 中文 problems **原样带出**（照 `assertValid` 的既有做法）。
   * 3. 宿主体检：工作项不存在 / 已归档 / 不属于目标 workspace ⇒ 响亮抛（挂不上的规则永不触发）。
   * 4. `nextFireAt = ` 与调度器**同一份**实现算出的首格（`every` 锚点 = 创建时刻 ⇒ 落在未来一个
   *    间隔内；`at` 必须严格晚于创建时刻；`cron` 取表达式在创建时刻之后的下一次命中）。
   *    **无未来命中 ⇒ 响亮抛**（「这条规则建成即永不触发」属死配置 —— 静默落盘正是本半要消灭的
   *    形态：listReady 只取 `next_fire_at <= now`，没有排期点的规则永远不触发且零报错）。
   * 5. `insert` 写盘后**读回**返回（照 `updateRoster` 的读回口径）。
   */
  createWakeRule(target: SquadWorkspaceTarget, input: CreateWakeRuleRequest): Promise<WakeRule>;
  /**
   * 暂停（不清除配置）：`nextFireAt` 置空（不再是到点扫描的候选）。**不过门禁**（停下不是新派发，
   * 与 `failMemberRun` 同款理由 —— 关掉开关后仍应能停掉一条规则）。
   *
   * **落库口径（有意偏离 brief 字面，逐条登记）**：`pausedReason` **不写下任何固定码** ——
   * 该列的读回是**封闭枚举**校验（`wakeRuleRepo.enumColumn`：枚举外值读回即抛，会让调度器
   * 整批扫描炸掉），集合只有 `max_fires | rate | loop` 三个**防失控闸**的码，没有「用户手动暂停」
   * 这一码（shared 本轮冻结）。写任何一个既有码都是**伪造闸原因**（界面会把用户暂停显示成
   * 「被 rate 闸停了」），故本实现只置空 `nextFireAt`（目标语义「不再到点 = 停下来了」完整成立），
   * `pausedReason` 原样保留（闸写下的原因不因用户再点一次 pause 而被抹掉）。
   * 下一轮若要区分「手动暂停」与「闸暂停」，需要给 shared 的 `WAKE_PAUSE_REASONS` 加一码。
   *
   * 前置读当时状态 + CAS（revision fencing，照既有纪律）：已不再到点的规则 ⇒ **幂等早退**
   * （不写盘、不 bump revision）；CAS 未命中（并发改动，如调度器刚推进一格）⇒ **响亮抛**。
   */
  pauseWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 恢复：清 `pausedReason` 并**重算** `nextFireAt`（与 `createWakeRule` 同一份首格排期计算：
   * `every` 锚点 = 恢复时刻、`cron` 取之后下一次命中、`at` 取 `at` 本身并要求仍晚于恢复时刻）。
   * **过门禁**（恢复 = 让未来的派发重新可能，与 `createWakeRule` 同一处判据、同一次序）。
   *
   * 分格口径（写清）：已在排期的规则 ⇒ **幂等早退且不重算**（重算会静默挪动在跑规则的网格，
   * 比报错更坏）；重算后**无未来排期点**（如一次性的 `at` 已过点、或 cron 无未来命中）⇒
   * **响亮抛且不写盘**（死动作：恢复一条永不触发的规则会让用户以为它又开始跑了）。
   * CAS 未命中的处置同 `pauseWakeRule`（前置读当时状态、响亮抛）。
   */
  resumeWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 编辑规则的**配置**（kind + 排期字段 + maxFires；挂载对象不可改）。**过门禁**（编辑让未来派发
   * 变样 —— 规则 = 未来派发的排班表；与 `createWakeRule` 同一处判据、同一次序：门禁在构造
   * runtime 之前过）。**revision +1**（§5.7 fencing：过期 revision 的进行中派发靠它自动作废）；
   * `enabled` / `pausedReason` / `fireCount` 原样保留（编辑不改开关与闸态）。
   *
   * 实现要点（唯一实现在 `squadWakeRules.ts`，复用**同一份**组装与首格排期）：
   * 1. 读现行（不存在 ⇒ 响亮抛）；2. 以 patch 调 `assembleWakeRule` 造新配置实体（旧 kind 的
   * 排期字段不带入 ⇒ 切换即清；**不含** `workItemId` / `timezone` / `expiresAt`，形状见
   * `UpdateWakeRuleRequest`）；3. 抄回 `fireCount` / `enabled` / `pausedReason`；
   * 4. `validateWakeRule` 不过 ⇒ 中文 problems 原样带出；5. 在跑的规则重算 `nextFireAt`
   * （无未来排期点 ⇒ 响亮抛且不写盘）；暂停中（用户暂停 / 闸暂停）编辑 ⇒ 排期保持空；
   * 6. `casUpdateConfig` 写盘，CAS 未命中 ⇒ 响亮抛；读回返回。
   */
  updateWakeRule(target: SquadWorkspaceTarget, input: UpdateWakeRuleInput): Promise<WakeRule>;
  /**
   * 删除规则。**不过门禁**（删掉 = 未来派发**减少**，与 `pauseWakeRule` 同款理由；关掉实验开关后
   * 也要能清配置）。
   *
   * 规则是**配置**（一张挂在工作项上的排班表），删除是它的正常生命周期终点；但**已触发的记录
   * （`fire_count`）随行一起消失、不可撤销** —— 这一点由 UI 的二次确认文案向用户交代
   * （`squad.rules.deleteConfirmDescription`），服务面只保证「恰命中一行才算成功」：
   * 不存在 / 未命中（并发被删）都**响亮抛**，绝不静默 no-op（那会让界面以为删掉了而列表里还在）。
   */
  deleteWakeRule(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * 编辑工作项的**内容字段**（标题 / 正文 / 标签；0018 起并入优先级与起止日期，R6 再并入手工排序位
   * `position`），返回写盘后的实体（**加法**，2026-10-03：工作项看板要求编辑可用；2026-10-07
   * `#11` v1 把标签并进同一条白名单）。
   *
   * 三条纪律（与 `updateTeamAgent` / `updateSquad` 同款）：
   * 1. **唯一写者**：`status` 仍只经 `workItemService.transition`（本条不碰它）；内容经 repo 的
   *    专用写入口 `workItemRepo.updateContent`（同样是「恰命中一行才算成功」的条件更新）——
   *    调用方**不得**自己碰 repo，更不得写裸 SQL：第二份写者迟早漂移，而漂移的表现是
   *    「界面看着改了、库里没改」或反过来，两处都不报错。
   * 2. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），runtime 按目标现构、
   *    不缓存 —— 与 `createWorkItem` 同款。
   * 3. **不过门禁**：改标题 / 正文 / 标签**不产生新派发**（§5.7.6 只停新派发），与 `updateTeamAgent`
   *    同款理由 —— 关掉实验开关后不该连改个字都不让。**本层不得写任何第二份开关判据**；
   *    界面侧入口的显隐由 `squadEntryVisible` 负责（呈现，不是门禁）。
   *
   * **标签归一化**：`patch.labels` 是**原文**，本层先经 shared 的 `parseWorkItemLabels`
   * （去重保序 / 上限 10 条 · 32 字符）再落 patch —— 非 ok ⇒ **在写之前**抛，库里保持上一次的值
   * （不得先写后校验）。规则只有那一处实现，本层不复制。
   *
   * **未命中 / 空 patch ⇒ 响亮抛**（照 `assignWorkItem` 的既有口径）：未命中 = id 算错或该行
   * 已被归档，空 patch = 调用方没给任何要改的字段 —— 静默 no-op 会让界面以为改成功了，
   * 而库里仍是旧标题。写盘后读回返回；读回为空（理论不可达：刚刚命中过同一条件）也响亮抛，
   * 不返回 undefined 让调用方在下一层才炸。
   */
  updateWorkItem(
    target: SquadWorkspaceTarget,
    input: {
      id: string;
      patch: {
        title?: string;
        body?: string;
        labels?: readonly string[];
        /* 0018（Surface 对齐 · 阶段一 R1）：优先级 / 起始 / 截止并入同一条内容白名单。
           判据单源在 shared（`resolveWorkItemPriority` / `resolveWorkItemDateOnly`）：
           闭集外优先级与坏日期在本层**响亮抛且写之前**；`null` = 清回未设置（合法动作，
           与「没给这个字段」的 `undefined` 不是同一件事）。`creator_*` / `identifier_seq`
           刻意**不在**白名单里 —— 它们没有更新面。 */
        priority?: WorkItemPriorityKey | null;
        startDate?: string | null;
        dueDate?: string | null;
        /* R6（看板拖拽改序）：`position` 是**数值**内容字段（REAL，原样落库，不做整数化 / 不做二次
           归一化 —— 它没有闭集或日历形状那样的判据，唯一的规则是「给了就 SET」）。未给（`undefined`）
           = 不动现值，与其余字段同一份 patch 子集语义；建表列是 `REAL NOT NULL DEFAULT 0`，
           故没有「写 NULL 清位」这一态。 */
        position?: number;
      };
    },
  ): Promise<WorkItem>;
  /** C4b：排队行读取口（推进扫描/快照计数共用；ORDER_BY_CREATED）。 */
  listQueuedSquadRuns(target: SquadWorkspaceTarget): Promise<SquadRunRecord[]>;
  /** C4b：排队行丢弃出口（A1 重验不过 / 批次放弃时收口，queued→discarded；只收排队行）。 */
  discardQueuedSquadRun(target: SquadWorkspaceTarget, runId: string): Promise<void>;
  /**
   * C4b：**到期认领** deferred 义务（恰一次；到期 = 目标对已离开活跃集，判据在 DELETE 语句内）。
   * 认领即删除——调用方拿到记录后必须完成重放（或响亮留痕），义务不回滚。
   */
  claimDueSquadDeferredObligations(
    target: SquadWorkspaceTarget,
  ): Promise<import("./squadDeferredDispatchRepo.js").SquadDeferredDispatchRecord[]>;
  /** C4b：deferred 重放义务读取口（推进扫描用；资格判定在推进侧，这里只给事实）。 */
  listSquadDeferredObligations(
    target: SquadWorkspaceTarget,
  ): Promise<import("./squadDeferredDispatchRepo.js").SquadDeferredDispatchRecord[]>;
  /**
   * **X2.1：评论派发 receipt 的取数口**（host 评论派发入口 / 义务重放通道的唯一读法）。
   *
   * 为什么在服务面上：receipt 是本域存储事实（0012），host 不直连 repo（「UI/host 不直接访问
   * Repo」的边界纪律，与 `listSquadRuns` / `listInboxItems` 同款）。为什么**按 dispatchKey 单取**
   * 而不是全量扫描：在线入口（hub 请求携带 dispatchKey）与重放通道（义务 id = dispatchKey）
   * 都**已经带着身份**，按身份取数是「先有事实、再读事实」；扫描未完成 receipt 属 X2.2 的启动重投面。
   *
   * **workspace 隔离**：取到的行必须属于本 target 绑定的 workspace（§8.5）；异己行**响亮抛**
   * （不静默当不存在 —— 那会把「取错了目标」伪装成「没有这条请求」）。未命中 ⇒ `null`。
   */
  getCommentDispatchReceipt(
    target: SquadWorkspaceTarget,
    dispatchKey: string,
  ): Promise<CommentDispatchReceiptRecord | null>;
  /**
   * **X2.2：本 workspace 未收敛 receipt 的读取口**（host 补投扫描的唯一取数面）。
   *
   * 覆盖「重启 / 桥不可用 / transient 失败」留下的 pending 与「等义务重放」的 deferred：
   * host 在结算事件与启动扫描两处按这张表补投（挂进既有 `advanceSquadQueueAfterSettlement`）。
   * 与 `getCommentDispatchReceipt` 一样是**只读**（读不是新派发：关掉实验开关后补投由派发桥
   * 内部的门禁兜底，本层不写第二份开关判据）；workspace 过滤由 repo 单源给出
   * （`listUnsettledByWorkspace`，未收敛集合取 `COMMENT_DISPATCH_UNSETTLED_OUTCOMES` 常量），
   * 本层不重排、不再筛（第二份判据会与 repo 漂移）。
   */
  listUnsettledCommentDispatchReceipts(
    target: SquadWorkspaceTarget,
  ): Promise<CommentDispatchReceiptRecord[]>;
  /**
   * **X2.1：评论派发 receipt 的条件回写口**（host 执行一次派发后落定当时的队列状态窗结论）。
   *
   * 语义由存储面单点给出（`CommentDispatchReceiptRepo.settleIfUnsettled`）：只认领**未收敛**的行
   * （pending/deferred），已终局的行不得被迟到的重投覆写；`changes === 1` 才算认领，返回 `false`
   * = 已被别的路径落定（调用方据此留痕、不改写）。**不新增第二份判据**：服务面只做 workspace 校验
   * 与转发，不做 outcome 映射（映射是 host 派发桥的结论，见 desktop 侧）。
   *
   * 时间戳在服务面边界取（`Date.now()`）：repo 显式收时间戳是为了可测/回放，调用方给时钟。
   */
  settleCommentDispatchReceipt(
    target: SquadWorkspaceTarget,
    input: {
      dispatchKey: string;
      outcome: CommentDispatchOutcome;
      detail?: Record<string, unknown>;
    },
  ): Promise<boolean>;
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
   * 改派（**加法**，2026-10-03）：把**既有**工作项改给 user / agent / squad（UI 的唯一入口）。
   * 返回本次调用是否**真的发生了变更**（`assigned:false` = 对象与现值相同 ⇒ 有意不动作，见第 3 条）。
   *
   * 语义逐条：
   * 1. **入口过门禁**（指派 = 新派发）：与 `assignWorkItem` / `createWorkItem` 同一处判据
   *    （`assertEnabled`）。**次序**：门禁在**构造 runtime 之前**过 —— 与 `createWorkItem` 同款。
   *    门禁要回答的是「现在允不允许新派发」，它与目标 workspace 是不是一个可用的 git 仓库无关；
   *    先建 runtime 会先跑 base 分支解析（构造期解析、失败即抛），于是在**非 git 目标**上关闭开关时，
   *    调用方拿到的是「base 分支解析失败」而不是**门禁结论** —— 上层按稳定码分流
   *    （`SQUAD_DISPATCH_DISABLED_CODE`）就分不出来，界面上会显示成 workspace 坏了。
   *    关掉实验后改派被拒（`SquadDispatchDisabledError` 原样带出）。
   * 2. **工作项不存在 / 已归档 ⇒ 响亮抛**（照 `assignWorkItem` 的口径）：本方法只改**既有**工作项的
   *    负责人；静默建新项会把这次派发挂到一个与调用方所指无关的对象上。
   * 3. **assignee 与现值相同（type 与 id 都相同）⇒ 不写、不发事件、返回 `{assigned:false}`**：
   *    重复指派给同一对象**不该再起一次 run** —— 队员 run 会撞工作树/分支名而响亮失败，队长 run 则由
   *    §5.7(1) 合并；「同一事实重投不产生第二次动作」与 Inbox 的幂等（`insertIfAbsent`）是同一条纪律。
   *    （队长派单工具的 `assignWorkItem` 在这一格**有意不同**：照旧写 + 照旧发事件 —— 那是对同一队员的
   *    **重试**入口，见该方法的注释。）
   * 4. `assignee.type === "user"` ⇒ **只写负责人**（`updateAssignee`），**不发派发事件**：
   *    人不需要被派 run ——「指派给人 = 等人自己动手」（`planDispatch` 的 user 支路同样只通知、不排队）。
   * 5. `assignee.type === "agent" | "squad"` ⇒ 写负责人 + 发 `workitem.dispatch_requested`（经
   *    **唯一出口** `SquadRuntime.emitWorkItemEvent` ↔ `subscribeWorkItemEvents` 同一张表 / 同一个
   *    常驻 hub），**不在这里开 run**（开 run 是派发路径的事，§5.1 一处写入 / §5.6 `@` ≠ 指派）。
   *    载荷是 `assignee`（类型 + id）而非裸 `agentId`：小队也能被指派（负责人是 squad ⇒ 派发路径
   *    解析出队长 run）。
   * 6. **写者纪律**：负责人不是 `status`（唯一写者那条约束管的是 `status`），只经 repo 的专用写入口
   *    `workItemRepo.updateAssignee`（「恰命中一行才算成功」的条件更新）；未命中（写入时已不可写：
   *    被归档 / 删除）⇒ **响亮抛**，不静默 no-op。
   */
  reassignWorkItem(
    target: SquadWorkspaceTarget,
    input: { workItemId: string; assignee: WorkItem["assignee"] },
  ): Promise<{ assigned: boolean }>;
  /**
   * 把**既有**工作项指派给某位队员（裁定 Important-1，2026-10-02）：**改负责人 + 发出派发事件**。
   *
   * **薄包装**（2026-10-03 收口）：内部走 `reassignWorkItem` 的**同一实现**（传
   * `{type:"agent", id: agentId}`），使「改负责人 + 发事件」在服务面**只有一份实现**。对外契约
   * 保持不变：入参形状、返回 `{assigned:true}`、过门禁、只支持 agent。
   *
   * **有意保留的一格差异**：同一队员**重复指派**（对象与现值相同）照旧**写 + 发事件** —— 那是对
   * 该队员的**重试**入口（队员 run 失败后该队员可能仍是负责人，重派一次是正当操作；派发结论的响亮
   * 失败由派发路径给，见 host 的 eventKey 注释），把它静默改成 no-op 会让工具回执「已派发」而实际
   * 什么都没发生 —— 正是本项目一路在消灭的「点了没反应」。服务面实现因此在同值这一格接受两种策略，
   * 由调用面显式选择（见 `applyWorkItemAssignee` 的 `sameAssignee`）。
   *
   * 语义其余部分（门禁在前 / 只改既有项 / 只发事件不开 run / 唯一写者）与 `reassignWorkItem` 完全一致。
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
   * **per-run 用量落账**（0015，#6 按 run 记账 CT.1）：把一次用量快照写进台账的 9 列
   * （`usage_*` + `usage_recorded_at`）。**唯一消费者是 host 的捕获臂**（CT.2：终态 / 看门狗 /
   * 启动和解三臂在收尾后补拉 `getTaskTokenUsage`）；界面读它走既有读取面
   * （`listSquadRunHistory` 已带这 9 列），**不经本方法**。
   *
   * 三条纪律：
   * · **不过门禁**（`assertDispatchEnabled`）：记账不是「新派发」（与 `failMemberRun` /
   *   `bindMemberRunSession` 同款理由——关掉实验开关后，在途 run 的收尾仍应如实记账）；
   * · **薄转发**：只做「现构 runtime → runId 非空闸 → 交 repo 的 `recordUsage`」——
   *   write-once / 幂等（`{written:false}`）/ 未命中抛的判据**只有一处实现**（repo），
   *   本层不得重写第二份；8 个数值的**非负整数闸同在 repo 的写路径**（单点，SQL 之前）；
   * · **write-once 语义由 repo 兜底**：同 run 二次调用不改写（来源是会话累计值，重拉只会变大），
   *   本层对「已记录」不抛（合法重投），对「没有该行」由 repo 响亮抛。
   */
  recordSquadRunUsage(
    target: SquadWorkspaceTarget,
    input: { runId: string; usage: SquadRunUsageSnapshot },
  ): Promise<void>;
  /**
   * **per-run 取消的台账半边（L1）**（设计 §3.4 / W1 卡）：把一条 run 立刻移出活跃集 ——
   * 容量释放 ⇒ 结算事实经 hub 扇出 ⇒ 队列推进 / 义务重放自动发生（不新写一行推进代码）。
   *
   * 分格（按**当时状态**分流，状态读自台账而不是调用方声明）：
   * · `queued` ⇒ `discardQueuedRun`（无会话无树：排队取消 = 丢弃，不是「失败」）；
   * · `open` ⇒ `failMemberRun`（reason = `user_cancel`，落 `settle_reason`）；
   * · `discarded` ⇒ **幂等 no-op**（同 runId 重复取消第二次 = 成功；也涵盖「这条 run 早已失败收口」
   *   —— 取消一个已经不跑的 run 没有可做的事，报错只会让界面把「没事了」显示成「出错了」）；
   * · `produced` / `rejected` / `merged` ⇒ **响亮抛**：它们都意味着**已经产出了东西**（或成果已落地），
   *   按取消丢弃会丢掉队员的活 —— 文案把用户分流到「审查」与「整批放弃」两条正当路径；
   * · runId 不存在 ⇒ **响亮抛**（静默 no-op 会让界面以为取消了，而那条 run 仍在跑）。
   *
   * 三条纪律：**唯一写路径**（只经 `failMemberRun` / `discardQueuedRun`，本层不碰 repo 的状态列）；
   * **不过门禁**（取消是收尾不是新派发，与 `failMemberRun` 同款理由 —— 关掉实验开关后仍必须能取消
   * 在途 run）；**不碰 git**（树的清理交给启动回收器，与 `failMemberRun` 同一条纪律）。
   *
   * L2（对 bound session 发协议 stop）在 host 侧接线（W2）；L1 先落地 ⇒ 无论 L2 成败，
   * 台账都已如实收口（双路径任意次序安全：终态回调再调 `failMemberRun`/`completeMemberRun` 时
   * 前者幂等、后者由 W2 的跨终态守卫拦住）。
   */
  cancelSquadRun(target: SquadWorkspaceTarget, input: CancelSquadRunInput): Promise<void>;
  /**
   * 看门狗判定所需的 **git 事实**（只读口；见 `SquadWatchdogGitFacts` 的形状与理由）。
   *
   * **不过门禁**（只读不是新派发，与 `listSquadRuns` 同款）；`branches` 由调用方按判定候选给出
   * （本层不猜该问哪些分支——那是判定面的事）。入参去重后**按序**逐分支问一次 `rev-parse -q --verify`。
   */
  getSquadWatchdogGitFacts(
    target: SquadWorkspaceTarget,
    input: { branches: readonly string[] },
  ): Promise<SquadWatchdogGitFacts>;
  /**
   * **熔断窗口计数**（W3 §3.6 的唯一读口）：本 workspace 下、最近 `SQUAD_BREAKER_WINDOW_MINUTES`
   * 分钟内**看门狗族**结算（`SQUAD_RUN_WATCHDOG_SETTLE_REASONS`，含空闲宽限摊牌）逐 agent 的条数。
   *
   * 为什么是**数组**而不是 Map：服务面跨 RPC 边界（远端 workspace 的目标服务是代理），Map 不是可
   * 序列化形状 —— 同 `SquadWatchdogGitFacts` 用 `string[]` 的理由。没有命中的 agent **不出现**（缺省 = 0）。
   *
   * 为什么窗口起点在**本层**算：窗口是这条判据的一部分（`SQUAD_BREAKER_WINDOW_MINUTES` 单源在 shared），
   * 让每个消费点各自算 `Date.now() − W × MS_PER_MINUTE` 就是第二份判据；服务面是时间戳边界。
   * **不过门禁**（只读不是新派发，与 `listSquadRuns` 同款）。
   */
  countWatchdogSettlementsByAgent(
    target: SquadWorkspaceTarget,
  ): Promise<Array<{ agentId: string; count: number }>>;
  /**
   * **看门狗结算后的自动重试登记**（W3 §3.5）：给被看门狗结算的 run 的同 `(workItem, agent)` 对
   * 登记一条 `origin="watchdog"` 的 deferred 义务 —— 目标对已离开活跃集 ⇒ 义务立即到期 ⇒
   * 推进臂按既有重放机制用**新 runId** 开一条新 run（重试是新派发决策，见 `WatchdogRetryOutcome`）。
   *
   * 三条纪律：
   * 1. **只由看门狗族结算触发**（`SQUAD_RUN_WATCHDOG_SETTLE_REASONS`）：用户取消 / 普通失败不自动
   *    重试（用户/闸已表态）。调用方拿一条非看门狗结算来登记是**接线 bug** ⇒ **响亮抛**，
   *    不静默 no-op（静默会让「为什么没重试」无人能答）。
   * 2. **预算派生**（零状态）：同对**另有**的看门狗结算数 ≥ `SQUAD_RETRY_BUDGET` ⇒ `budget_exhausted`。
   *    额度是 shared 的**单源常量**（用户 2026-10-07 裁定：阈值类值一处定义、消费点不得写散值），
   *    由本层注入；判据（计数 ≥ 额度）在 repo（`hasOtherWatchdogSettledRunForPair`，排除本次这一行），
   *    本层不重写 SQL、也不得把额度写死在这里（写死 = 改常量静默无效，正是 F1 的形态）。
   * 3. **不过门禁**（登记义务不是新派发，与 `failMemberRun` / `cancelSquadRun` 同款理由）：
   *    门禁只管新派发；重试的派发本身仍走 host 的派发桥（那里过门禁）。
   *
   * 被结算行的 `dispatchCause` **原样继承**（G8：不扩 `DISPATCH_CAUSES` 闭集，纯搬运）——
   * 「这条重试因何而起」与被它重试的那条是同一个成因。
   */
  registerWatchdogRetry(
    target: SquadWorkspaceTarget,
    input: { settledRunId: string },
  ): Promise<WatchdogRetryOutcome>;
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
  /**
   * 登记一条 InboxItem（**加法**，P2c）：host 在「需要人介入」的产生点调用（队员失败 / 启动和解 /
   * 派发 skip）；冲突那一条由**编排器**直写（它本来就用同一组 repo，见 `SquadRuntime.inboxItemRepo`）。
   *
   * 三条纪律（与 `updateTeamAgent` / `updateWorkItem` 同款）：
   * 1. **唯一写者**：只经 runtime 的 `inboxItemRepo.insertIfAbsent`（存储层幂等：唯一索引 +
   *    `INSERT OR IGNORE` —— 同一事实重投不产生第二条、已归档不复活）。调用方不得自己拼 SQL，
   *    也不得绕过本方法直连 repo；`kind → severity` 的映射在 repo 内单源（产生点只表态 kind）。
   * 2. **不过门禁**：登记通知**不是新派发**（§5.7.6 只停新派发），与 `failMemberRun` /
   *    `updateTeamAgent` 同款理由 —— 关掉实验开关后，在途 run 的失败与和解仍必须能落进收件箱
   *    （那正是要「看得见」的东西）。**本层不得写任何第二份开关判据**。
   * 3. **目标显式**：`target` 是**唯一权威**（没有隐式默认 workspace），runtime 按目标现构、不缓存
   *    —— 与 `createWorkItem` 同款。**幂等结论不回传**（`insertIfAbsent` 的 `false` 在本签名上折成
   *    void）：调用点是 best-effort 留痕，不据它分流 ——「重投」与「新登记」对调用方的后续动作没有差别。
   */
  recordInboxItem(target: SquadWorkspaceTarget, input: InboxItemInput): Promise<void>;
  /**
   * 收件箱的**跨项目**读取面（**加法**，P2c）：用户裁定收件箱是**跨 workspace 的通知面**
   * （跨项目一级入口，下一轮落地），故本方法**有意偏离**「目标显式」这条覆盖全文件的纪律 ——
   * **没有** target 参数，也**不得**有人悄悄加一个（加了就退回「一次只能看一个项目」，
   * 而「所有项目里等我处理的事」正是收件箱存在的理由）。
   *
   * 默认**排除已归档**（归档 = 用户说「处理完了」）；`includeArchived: true` 才连归档行一起取。
   * 读取不经任一 runtime（跨 workspace ⇒ 没有唯一目标），走组合根注入的懒取 repo：库未就绪时
   * 它在**调用时**响亮抛，不静默返回空表（空表会把「库没开」伪装成「收件箱是空的」）。
   */
  listInboxItems(options?: { includeArchived?: boolean }): Promise<InboxItem[]>;
  /** 标已读（**加法**）：只改 `read_at` 一列（重复调用保留首次时间戳）。未命中 ⇒ 响亮抛。 */
  markInboxItemRead(id: string): Promise<void>;
  /**
   * 归档（**加法**）：只改 `archived_at` 一列（不碰 `read_at` —— 已读与归档是两件正交的事）。
   * 归档后同一事实的重投**不复活**它（存储层不变式，见 `recordInboxItem` 第 1 条）。未命中 ⇒ 响亮抛。
   */
  archiveInboxItem(id: string): Promise<void>;
  /**
   * **保存视图六件**（R6a，2026-10-09：Q2「v1 会话内」被 multica 取证推翻 —— multica 是**服务端
   * 持久化**视图，按上位裁定「优先 multica 不计成本」重开）。唯一实现在 `workItemViewService.ts`
   * （本文件只把「按目标现构 runtime」与「本机操作者身份」接进去）。存储面 = 迁移 0020 的两张表。
   *
   * **权限形态**（照 multica `issue_view.go`，逐格）：
   * · 读（list / 出现在列表里）：**owner 或 `visibility='workspace'`**；越权读与「不存在」**同码**
   *   （`work_item_view_not_found` —— 私有视图的存在性不泄露，multica 一律 404）；
   * · 管理（patch / delete）：**owner**。multica 的「workspace owner/admin 且 shared」在 ZPaPa v1
   *   没有对应概念（单机单身份，人类名册归 C4）⇒ 非 owner 改/删共享视图 ⇒ `work_item_view_forbidden`
   *   （与「读不到」区分：他看得见这个视图，只是不能改；multica 的 403 同格）。
   * · **列表的观察者归属**：`listWorkItemViews` 每行带 `ownedByViewer`（读时按注入身份
   *   `(kind, id)` 两列算；不是一列、不进存储）—— UI 的权限镜像（他人的共享视图 ⇒ 编辑禁用 /
   *   删除不渲染）以它为唯一判据，UI 侧不再需要「观察者身份」入参（D1-A：UI 不自造身份）。
   *
   * **owner 身份**＝组合根注入的 `localHumanActor`（与 0018 创建人**同一处定义点**）：
   * 调用方**不能**自证身份（设计案 §12-2），故六个方法都没有 owner 入参。未注入 ⇒ 六个方法响亮抛。
   *
   * **my 档强制 private 三处**：create 强制（`visibility` 被改写，multica 同款）、patch 响亮拒绝
   * 非 private（multica 400 "my views are always private"）、DB CHECK（迁移 0020）。
   *
   * **query / display 对服务端不透明**：只校验「合法 JSON object」（`z.record` 同款）+ 128KiB 载荷
   * 上限；facet 集（status / priority 两维 + display 子集）由 UI 层定义（R1 已落），服务面**不枚举** ——
   * 将来加 facet 不需要动服务端。`definitionVersion` 是客户端契约版本（客户端恒写 1）。
   *
   * **revision**（乐观并发）：`patch` 必填 `expectedRevision`（正整数），CAS 未命中 ⇒
   * `work_item_view_revision_conflict`（409 等价物）；`delete` **不带** revision（multica 同款）。
   *
   * **配额**：每 owner 每 workspace 100（`WORK_ITEM_VIEWS_PER_OWNER_MAX`，写之前判 ⇒ 超限不落盘）；
   * 列表硬上限 200（schema 侧单源 `WORK_ITEM_VIEW_LIST_LIMIT`，滥用兜底不是分页）。
   *
   * 六件都**不过门禁**（`assertDispatchEnabled`）：视图与工作项派发无关，关掉实验开关后
   * 保存/切换视图仍必须可用。**本层不写任何第二份开关判据。**
   */
  listWorkItemViews(target: SquadWorkspaceTarget): Promise<WorkItemViewRecord[]>;
  createWorkItemView(
    target: SquadWorkspaceTarget,
    input: CreateWorkItemViewInput,
  ): Promise<WorkItemViewRecord>;
  patchWorkItemView(
    target: SquadWorkspaceTarget,
    input: PatchWorkItemViewInput,
  ): Promise<WorkItemViewRecord>;
  deleteWorkItemView(target: SquadWorkspaceTarget, input: { id: string }): Promise<void>;
  /**
   * **视图条偏好**：无行 ⇒ **空文档 `{}`**（不是错误、不是 404 —— multica `issue_view_preference.go`
   * 的 no-rows 分支同款；文档键集 `{hidden, order}` 由 UI 层定义）。偏好按
   * `(workspace, owner)` 隔离，只有调用者本人那一份。
   */
  getWorkItemViewPrefs(target: SquadWorkspaceTarget): Promise<WorkItemViewPrefsDocument>;
  /**
   * **整文档覆盖写**（last-write-wins、**无 revision** —— 偏好不是共享事实，用不着 fencing；
   * multica PUT 同款）。不是 merge：`{hidden:[]}` 覆盖后旧的 `order` 键必须消失
   * （merge 会把用户明确删掉的条目复活）。校验与 query/display 同一份：JSON object + 载荷上限。
   */
  putWorkItemViewPrefs(
    target: SquadWorkspaceTarget,
    input: { prefs: WorkItemViewPrefsDocument },
  ): Promise<WorkItemViewPrefsDocument>;
  /**
   * **工作项级表情回应 · 置上 / 撤掉**（P3-R5s 服务面半边；唯一实现在 `workItemReactionService.ts`）。
   *
   * `on=true` ⇒ 幂等添加；`on=false` ⇒ 幂等撤销（不存在 = 无变化、**不报错**）。两者都返回
   * **操作后该工作项的全部反应行**（插入序）—— 幂等语义下重复调用**返回同值**
   * （同人同 emoji 由迁移 0021 的五元组唯一键 + `INSERT OR IGNORE` 兜底，不产生第二行）。
   *
   * 为什么返回行而不是聚合分组（`{emoji,count,actors,reactedByMe}`）：聚合归 UI（multica 的
   * `groupReactions` 就在 UI 层），且 `reactedByMe` 要拿「我」与本机名册逐个比 —— 那是 UI 已有的
   * 身份视图；服务面只交事实（原始行），不预先分组、不重排（顺序 = repo 的插入序）。
   *
   * 为什么不给 author 入参：反应行的作者 = 组合根注入的 `localHumanActor`（与 0018 创建人 /
   * 0020 视图 owner **同一处定义点**）—— 「谁按下的表情」不能由调用方自证（设计案 §12-2）；
   * 未注入 ⇒ 响亮抛。
   *
   * 工作项归属（§8.5）：不存在 / 已归档 / 跨 workspace 一律响亮抛且**零写入**（归档行视同不存在）。
   * **emoji 只剩两条闸**：非空 + 宽松长度上限（32 字节）—— **不白名单**（快捷表情集是 UI 的呈现层；
   * 白名单写进服务面会让「放开完整 picker」变成服务端改动 + 数据迁移）。
   * **不过门禁**：reactions 不产生新派发（与 `updateWorkItem` 同款理由，本层不写第二份开关判据）。
   */
  setWorkItemReaction(
    target: SquadWorkspaceTarget,
    input: { workItemId: string; emoji: string; on: boolean },
  ): Promise<WorkItemReactionRecord[]>;
  /**
   * **本工作项的反应行**（原始行、插入序；P3-R5s）：**聚合归 UI**（chip = emoji + count、
   * 「谁反应了」由 UI 用名册解析、`reactedByMe` 必须带 kind 判断）。
   *
   * **只读、不过门禁**（读不是新派发，与 `listWakeRules` / `listWorkItemViews` 同款 ——
   * 关掉实验开关后仍应能看到谁对这条工作项表过态）。归属校验与写路径**同一份实现**：
   * 不存在 / 已归档 / 跨 workspace 一律响亮抛（不静默返回空数组 —— 那会把「id 算错」
   * 或「取错目标」伪装成「这个项还没人反应」）。
   */
  listWorkItemReactions(
    target: SquadWorkspaceTarget,
    input: { workItemId: string },
  ): Promise<WorkItemReactionRecord[]>;
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
  /**
   * 收件箱的**懒取** repo 口（跨 workspace 的读取面用：`listInboxItems` / `markInboxItemRead` /
   * `archiveInboxItem` —— 它们没有唯一目标，故不经 runtime）。
   *
   * 为什么是「一次调用一次的取法」而不是实例：组合根在 `ensureReady()` 之后才拿得到同一条 db
   * （`openSharedDatabase()` 未初始化即抛，见 `createSquadRuntimeFor` 的既有口径），而服务面在库
   * 就绪前就已构造。故注入闭包、调用时才取：未就绪在**调用时响亮抛**（不静默返回空表 —— 空表会把
   * 「库没开」伪装成「收件箱是空的」，与既有「响亮失败优于静默」同款）。
   *
   * **可选**（加法，既有调用方不受影响）：未注入时上面三个方法**响亮抛** —— 缺它说明这一份服务面
   * 根本没接上收件箱台账，静默 no-op 会让界面显示「空收件箱」而库里其实有东西。
   */
  getInboxItemRepo?: () => InboxItemRepo;
  /**
   * 评论派发 receipt 的**懒取 repo 口**（X2.1；与 `getInboxItemRepo` 同款理由与形态）：
   * 组合根在 `ensureReady()` 之后才拿得到同一条（走过迁移的）db 连接，而服务面在库就绪前就已构造。
   * 未注入 ⇒ 两个 receipt 方法**响亮抛**（静默返回 null/false 会把「这份服务面没接 receipt」
   * 伪装成「没有这条请求」/「已被别处落定」——两种误读都会让评论派发静默消失）。
   */
  getCommentDispatchReceiptRepo?: () => CommentDispatchReceiptRepo;
  /**
   * **本机操作者身份**（0018：谁是新建工作项的创建人）。注入形态与协作门面的
   * `localHumanActor` 完全同款（组合根 node.ts 的唯一身份定义点常量），
   * 理由也同款：身份是审计事实，**不能**由 UI/调用方自证，也不能每个入口各造一个
   * （两处身份不一致时，同一个人写下的行会变成两个创建人，而任何地方都不报错）。
   *
   * 为什么在**服务面**注入而不是在 UI：设计案 §12-2「不应在 UI 自行决定权限/身份」；
   * UI 建项走的就是这个方法，故 `createWorkItem` 落下的 `creator_*` 三列 = 组合根定义的那一份身份。
   *
   * **可选**：未注入 ⇒ 创建人三列保持 NULL（= 未知）—— 存量行与「这一份装配没接身份」都如实留空，
   * **绝不**拿 `assignee` 冒充（指派是「派给谁」，创建人是「谁按下的创建」，两件事）。
   */
  localHumanActor?: () => WorkItemCreator;
  /**
   * 服务面边界用的时钟与 id 生成（**仅测试可钉死**，生产不注入）。
   *
   * 为什么留这两个口：反应行的 `created_at` 与 `id` 由服务面取（repo 显式收时间戳以便回放），
   * 而「重复 add **返回同值**」这条幂等契约只有把时钟与 id 钉死才谈得上逐字段对齐 ——
   * 与 `workItemViewService` 的 `now` 同一手法。
   */
  now?: () => number;
  newId?: () => string;
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
   * 跨 workspace 读取面用的懒取 repo（见 `deps.getInboxItemRepo` 的理由）。
   * 未注入 ⇒ **响亮抛**：这不只是「没配」，而是「这一份服务面根本没接上收件箱」——
   * 静默返回空表会让用户看到一个空收件箱，而库里其实有东西。
   */
  const requireInboxItemRepo = (): InboxItemRepo => {
    if (!deps.getInboxItemRepo) {
      throw new Error(
        "收件箱台账未接通：组合根没有注入 getInboxItemRepo（懒取 repo 口）。" +
          "静默返回空结果会把「这份服务面没接收件箱」伪装成「收件箱是空的」，故一律抛。",
      );
    }
    return deps.getInboxItemRepo();
  };

  /** 评论 receipt repo 的懒取（与 `requireInboxItemRepo` 同款：未注入 ⇒ 响亮抛，不静默返回空）。 */
  const requireCommentDispatchReceiptRepo = (): CommentDispatchReceiptRepo => {
    if (!deps.getCommentDispatchReceiptRepo) {
      throw new Error(
        "评论派发 receipt 未接通：组合根没有注入 getCommentDispatchReceiptRepo（懒取 repo 口）。" +
          "静默返回 null/false 会把「这份服务面没接 receipt」伪装成「没有这条请求」/「已被别处落定」，故一律抛。",
      );
    }
    return deps.getCommentDispatchReceiptRepo();
  };

  /**
   * receipt 的 workspace 隔离（§8.5）：行不属于本 target 绑定的 workspace ⇒ **响亮抛**。
   * 不静默当「没有」：那会把「取错了目标（接线 bug）」伪装成「这条请求不存在」（一条正常的返回），
   * 两种情形的处置完全不同（前者要查接线，后者是重投/丢弃的正常分格）。
   */
  const assertReceiptOwnWorkspace = (
    receipt: CommentDispatchReceiptRecord,
    workspaceKey: string,
  ): void => {
    if (receipt.workspaceKey !== workspaceKey) {
      throw new Error(
        `评论派发 receipt「${receipt.dispatchKey}」属于 workspace「${receipt.workspaceKey}」，` +
          `与本次目标的「${workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
      );
    }
  };

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

  /* 唤醒规则六项（**加法**：P2b 第二半 + 收口）：实现全在 `squadWakeRules.ts`
     （组装 / 校验 / 排期 / CAS），这里只把两个依赖接进去 —— ① `deps.createRuntime`（按目标现构，
     不缓存）；② `assertEnabled`（服务侧唯一门禁：create / resume / update 在构造 runtime **之前**
     过它；pause / list / delete 不过）。**这里刻意不写任何第二份开关判据**（门禁的唯一判据就是
     上面的 `assertEnabled`）。 */
  const wakeRuleOps = createWakeRuleOps({
    createRuntime: deps.createRuntime,
    assertEnabled,
  });

  /* 保存视图六件（R6a）：实现全在 `workItemViewService.ts`（名称 / JSON object / 权限 / 配额 /
     revision CAS），这里只把两个依赖接进去 —— ① `deps.createRuntime`（按目标现构，不缓存）；
     ② `deps.localHumanActor`（视图 owner = 与 0018 创建人**同一处定义点**的身份；未注入 ⇒
     六个方法响亮抛，见 ops 内的 `requireActor`）。**都不调 `assertEnabled`**：视图与派发无关，
     关掉实验开关后保存/切换视图仍必须可用（与 `updateWorkItem` 同款理由，本层不写第二份判据）。 */
  const workItemViewOps = createWorkItemViewOps({
    createRuntime: deps.createRuntime,
    ...(deps.localHumanActor === undefined ? {} : { localHumanActor: deps.localHumanActor }),
  });

  /* 工作项级 reactions 两件（P3-R5s）：实现全在 `workItemReactionService.ts`（身份 / emoji 两条闸 /
     工作项归属 / 幂等读写），这里只把依赖接进去 —— ① `deps.createRuntime`（按目标现构，不缓存）；
     ② `deps.localHumanActor`（反应行的作者 = 与 0018 创建人 / 0020 视图 owner **同一处定义点**的
     身份；未注入 ⇒ 两个方法响亮抛，见 ops 内的 `requireActor`）；③ 时钟与 id（测试可钉死）。
     **不调 `assertEnabled`**：reactions 与派发无关，关掉实验开关后照常可用（与 `updateWorkItem`
     同款理由，本层不写第二份判据）。 */
  const workItemReactionOps = createWorkItemReactionOps({
    createRuntime: deps.createRuntime,
    ...(deps.localHumanActor === undefined ? {} : { localHumanActor: deps.localHumanActor }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });

  return {
    // 保存视图六件（R6a）：实现在 `workItemViewService.ts`（本层只接线，见上面 ops 的构造点）。
    ...workItemViewOps,
    // 工作项级 reactions 两件（P3-R5s）：实现在 `workItemReactionService.ts`（同上）。
    ...workItemReactionOps,

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
        queuedRuns: runtime.squadRunRepo.listQueued(keyOf(runtime)),
      };
    },

    /* 历史读取面（**加法**，规格 §11.2 时间线的数据面）。**不过门禁**：读历史不是新派发
       （接口注释里有完整理由），与 `getSnapshot` 不同 —— 后者读 `enabled` 是为了**呈现**，
       本方法连开关值都不需要：图要画的是「发生过什么」，不是「现在允许做什么」。
       两个口径都由 repo 单源给出、原样交回：批次过滤 `listByParent`、全量历史 `listByWorkspace`；
       本层不在这里筛、不在这里重排（第二份判据会与 repo 的排序/过滤漂移，而漂移不报错）。
       `keyOf(runtime)` 取自 runtime 的**绑定值**：runtime 才是「为哪个 workspace 而构造」的权威
       （与 createWorkItem 取 workspace 列同一条纪律）。 */
    async listSquadRuns(target, input) {
      const runtime = await deps.createRuntime(target);
      return input?.parentWorkItemId
        ? runtime.squadRunRepo.listByParent(input.parentWorkItemId)
        : runtime.squadRunRepo.listByWorkspace(keyOf(runtime));
    },

    /* 呈现用分页历史（欠账 #13）：**第三个口径**（见接口注释）。
       纪律与 `listSquadRuns` 同款：不过门禁（读历史不是新派发）、目标显式（`keyOf(runtime)` 取自
       runtime 的绑定值）、过滤与排序由 repo 单源给出 —— 本层**不解析游标、不重排、不加 LIMIT**，
       只把三个入参原样转交、把 repo 的结论原样交回（少一层解释 = 少一处漂移）。 */
    async listSquadRunHistory(target, input) {
      const runtime = await deps.createRuntime(target);
      const page = runtime.squadRunRepo.listHistoryPage(keyOf(runtime), {
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return { runs: page.rows, nextCursor: page.nextCursor };
    },

    async createTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.create(input);
    },

    /* 以下三个名册管理动作（**加法**）都不调 `assertEnabled`：名册管理不产生新派发
       （§5.7.6 只停新派发），与 `failMemberRun` / `reviewMemberRun` 同款理由 ——
       关掉实验开关时名册管理仍应可用（界面侧入口此时本就隐藏，见 `squadEntryVisible`）。
       **这里刻意不写任何第二份开关判据**：门禁的唯一判据是上面的 `assertEnabled`，
       名册这里连"判一下"的必要都没有（不是漏判，是不该判）。
       写者纪律：只经注入的 `teamAgentService`（read-modify-write + 原子写盘在其内部），
       服务面不碰任何文件，也不做第二份拼装。目标 `target` 原样交给 `createRuntime` ——
       它是**唯一权威**（runtime 按目标现构、不缓存，没有隐式默认 workspace）。 */
    async updateTeamAgent(target, input) {
      return (await deps.createRuntime(target)).teamAgentService.update(input.id, input.patch);
    },

    async setTeamAgentEnabled(target, input) {
      await (await deps.createRuntime(target)).teamAgentService.setEnabled(input.id, input.enabled);
    },

    async restoreTeamAgent(target, input) {
      const runtime = await deps.createRuntime(target);
      runtime.teamAgentService.restore(input.id);
    },

    async restoreSquad(target, input) {
      const runtime = await deps.createRuntime(target);
      runtime.squadService.restore(input.id);
    },

    async archiveTeamAgent(target, input) {
      await (await deps.createRuntime(target)).teamAgentService.archive(input.id);
    },

    async createSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.create(input);
    },

    /* 以下两个小队名册管理动作（**加法**）与上面三个智能体的同款：都不调 `assertEnabled`
       —— 名册管理不产生新派发（§5.7.6 只停新派发），关掉实验开关后名册整理仍应可用。
       写者纪律：只经注入的 `squadService`（read-modify-write + 原子写盘在其内部），
       服务面不碰任何文件，也不做第二份拼装。目标 `target` 原样交给 `createRuntime` ——
       它是**唯一权威**（runtime 按目标现构、不缓存，没有隐式默认 workspace）。
       小队归档**刻意不在这里**：归档的「先转交后归档」组合只有一处实现
       （`archiveSquadAndTransfer`），UI 直接调它，本层不再加第三个写入口。 */
    async updateSquad(target, input) {
      return (await deps.createRuntime(target)).squadService.updateRoster(input.id, input.patch);
    },

    async setSquadEnabled(target, input) {
      // 经通用的 `update`（它保留其余字段含 `archivedAt`，并在合并后重新校验）——
      // 不为「改一个 enabled」新开第三个写路径。
      (await deps.createRuntime(target)).squadService.update(input.id, { enabled: input.enabled });
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
        // 标签原样透传：归一化与上限判据的单源在 workItemService.create（它调 shared 的纯函数）。
        labels: input.labels,
        // 0018 的三个新字段同样**原样透传**（闭集 / 日历日期判据的单源在唯一创建入口）。
        priority: input.priority,
        startDate: input.startDate,
        dueDate: input.dueDate,
        /* 创建人 = **组合根注入的本机操作者**（不是入参、不是 assignee）：未注入 ⇒ 不传这个键，
           落 NULL（未知）。这里不做第二份身份判据，也不在缺身份时编一个。 */
        creator: deps.localHumanActor?.() ?? null,
      });
    },

    async listQueuedSquadRuns(target) {
      const runtime = await deps.createRuntime(target);
      // workspaceKey 与台账行同源口径（C14：identity 去空白优先，否则 path）。
      return runtime.squadRunRepo.listQueued(keyOf(runtime));
    },

    async discardQueuedSquadRun(target, runId) {
      const runtime = await deps.createRuntime(target);
      runtime.squadRunRepo.discardQueuedRun(runId);
    },

    async claimDueSquadDeferredObligations(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.squadDeferredDispatchRepo.claimDue(keyOf(runtime));
    },

    async listSquadDeferredObligations(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.squadDeferredDispatchRepo.list(keyOf(runtime));
    },

    /* X2.1 评论派发 receipt 的两个口（见接口注释）：取数与条件回写都经懒取 repo（与收件箱同款）。
       **workspace 校验**在取数口做：异己行响亮抛（§8.5 的既有纪律，不静默当不存在）；
       回写口同样先校验再转发（不同 workspace 的行不得被本 target 的 host 落定）。 */
    async getCommentDispatchReceipt(target, dispatchKey) {
      const runtime = await deps.createRuntime(target);
      const receipt = requireCommentDispatchReceiptRepo().get(dispatchKey);
      if (receipt === null) return null;
      assertReceiptOwnWorkspace(receipt, keyOf(runtime));
      return receipt;
    },

    async listUnsettledCommentDispatchReceipts(target) {
      const runtime = await deps.createRuntime(target);
      // workspace 过滤是查询的一部分（repo 单源）：异己行结构上读不到，不需要逐行比对。
      // keyOf(runtime) 取 runtime 的绑定值 —— 与 getCommentDispatchReceipt 同一条式子。
      return requireCommentDispatchReceiptRepo().listUnsettledByWorkspace(keyOf(runtime));
    },

    async settleCommentDispatchReceipt(target, input) {
      const runtime = await deps.createRuntime(target);
      const receipt = requireCommentDispatchReceiptRepo().get(input.dispatchKey);
      if (receipt === null) return false; // 未命中：不造行（调用方据 false 留痕）
      assertReceiptOwnWorkspace(receipt, keyOf(runtime));
      return requireCommentDispatchReceiptRepo().settleIfUnsettled({
        dispatchKey: input.dispatchKey,
        outcome: input.outcome,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        // 服务面是时间戳边界：repo 显式收时间戳（可测/回放），时钟由调用层给。
        updatedAt: Date.now(),
      });
    },

    async openMemberRun(target, input) {
      // 入口①（队员段）与入口③ 共用的这一道闸（与上面、与 assertDispatchEnabled 是同一个函数）。
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      return runtime.lifecycle.openMemberRun(input);
    },

    /* 工作项**内容**编辑（**加法**）：不调 `assertEnabled` —— 改标题 / 正文 / 标签不产生新派发
       （§5.7.6 只停新派发），与 `updateTeamAgent` / `updateSquad` 同款理由。
       写者纪律：只经 repo 的专用写入口 `workItemRepo.updateContent`（status 的唯一写者仍是
       `workItemService.transition`，本方法不碰它）；调用方不接触 repo。
       未命中（含空 patch：repo 直接 false）⇒ 响亮抛，照 `assignWorkItem` 的既有口径 ——
       静默 no-op 会让界面以为改成功了，而库里仍是旧标题。目标 `target` 原样交给
       `createRuntime`（唯一权威，没有隐式默认 workspace）。
       标签：**写之前**经 shared 的 `parseWorkItemLabels` 归一化（规则单源；`labels: []` 是
       「清空」这个合法动作，不是空 patch）；非 ok ⇒ 抛在写之前，库里保持上一次的值。 */
    async updateWorkItem(target, input) {
      const runtime = await deps.createRuntime(target);
      let patch: {
        title?: string;
        body?: string;
        labels?: string[];
        priority?: WorkItemPriorityKey | null;
        startDate?: string | null;
        dueDate?: string | null;
        position?: number;
      } = {
        title: input.patch.title,
        body: input.patch.body,
        // R6：position 原样透传（没有要过闸的判据，不在这里做第二份判断）；undefined = 不动现值。
        position: input.patch.position,
      };
      if (input.patch.labels !== undefined) {
        const parsed = parseWorkItemLabels(input.patch.labels);
        if (parsed.kind !== "ok") throw new Error(workItemLabelsErrorMessage(parsed));
        patch = { ...patch, labels: parsed.labels };
      }
      /* 0018 的三个内容型新字段：判据（闭集 / 日历日期）单源在 shared 的纯函数，本层只消费；
         非 ok ⇒ **在写之前**抛（先写后校验会留下一条「值被悄悄改过」的行）。`null` 是合法值
         = 清回未设置（与「没给这个字段」区分开：后者是 `undefined`，不参与 SET）。 */
      if (input.patch.priority !== undefined) {
        const parsed = resolveWorkItemPriority(input.patch.priority);
        if (parsed.kind !== "ok") throw new Error(workItemPriorityErrorMessage(parsed));
        patch = { ...patch, priority: parsed.priority };
      }
      if (input.patch.startDate !== undefined) {
        const parsed = resolveWorkItemDateOnly(input.patch.startDate);
        if (parsed.kind !== "ok") throw new Error(workItemDateErrorMessage(parsed));
        patch = { ...patch, startDate: parsed.date };
      }
      if (input.patch.dueDate !== undefined) {
        const parsed = resolveWorkItemDateOnly(input.patch.dueDate);
        if (parsed.kind !== "ok") throw new Error(workItemDateErrorMessage(parsed));
        patch = { ...patch, dueDate: parsed.date };
      }
      if (!runtime.workItemRepo.updateContent(input.id, patch)) {
        throw new Error(
          `编辑工作项失败：工作项「${input.id}」不存在、已归档、或没有给任何要改的字段（空 patch）——` +
            "静默 no-op 会让界面以为改成功了，而库里仍是旧内容。",
        );
      }
      // 读回写盘后的实体返回；理论上刚刚命中过同一条件，读回为 null 不可达 —— 真不可达时也响亮抛，
      // 不返回 undefined 让调用方在下一层才炸。
      const item = runtime.workItemRepo.get(input.id);
      if (!item) {
        throw new Error(
          `编辑工作项失败：工作项「${input.id}」写入成功后读回为空（理论不可达）——` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return item;
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

    async reassignWorkItem(target, input) {
      /* UI 改派（入口③'）。与入口①②③ 共用**同一个**门禁判据（指派 = 新派发）。
         「拦在入口」：半路拦会留下一条已改负责人、却没有派发事件的工作项（看上去成功了一半）。
         **次序**：先门禁、后建 runtime（与 `createWorkItem` 同款）—— 门禁只读开关、只抛错，
         不依赖目标是不是 git 仓库；先建 runtime 会先跑 base 解析，非 git 目标上关开关时调用方
         拿到的是「base 解析失败」而不是门禁结论（稳定码分流就分不出来）。 */
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      // 同值 ⇒ skip：不写、不发事件、返回 `{assigned:false}`（语义 3：重复指派不该再起一次 run）。
      // 成因取 `user_reassign` —— 本次派发由用户在界面上发起（事实由调用面给出，实现只搬运）。
      // 选项做成单行常量而不是内联字面量：本文件贴着 oxlint 的行数门槛（skipComments 口径）。
      const reassignOptions = { sameAssignee: "skip", cause: "user_reassign" } as const;
      return applyWorkItemAssignee(runtime, input, reassignOptions);
    },

    async assignWorkItem(target, input) {
      /* 队长派单工具（入口③）—— **薄包装**：与 `reassignWorkItem` 同一份实现（`applyWorkItemAssignee`），
         差异只有显式两处：① 对象固定为 `{type:"agent", id}`（本方法对外契约只支持 agent，保持不变）；
         ② **同值 ⇒ reapply**（照旧写 + 照旧发事件）：这是对同一队员的**重试**入口，把它静默 no-op 会让
         工具回执「已派发」而实际什么都没发生（见接口注释的取舍说明）。
         门禁同样是构造 runtime **之前**过（与 reassignWorkItem / createWorkItem 同一处判据、同一次序）。 */
      await assertEnabled();
      const runtime = await deps.createRuntime(target);
      applyWorkItemAssignee(
        runtime,
        { workItemId: input.workItemId, assignee: { type: "agent", id: input.agentId } },
        // 成因取 `leader_tool`（本次派发由队长派单工具发起）；与改派那一支各传自己的值。
        { sameAssignee: "reapply", cause: "leader_tool" },
      );
      // 返回形状不变（reapply 恒写 + 恒发；未命中 / 不可写已在实现里响亮抛，走不到这里）。
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

    /* 0015（#6 按 run 记账 CT.1）：host 三臂捕获的落账入口。薄转发 —— write-once / 幂等 /
       未命中抛的判据单源在 repo 的 `recordUsage`，本层只补 runId 非空（空串进 repo 只会命中
       「没有该行」，那里区分不出「调用方传空」与「行不在」，故在入口先拒）。 */
    async recordSquadRunUsage(target, input) {
      if (input.runId.trim().length === 0) {
        throw new Error(
          "记录 run 用量失败：runId 不能为空——空串进台账只会命中「没有该行」，" +
            "文案区分不出「调用方传空」与「行不在」，故在入口先响亮拒绝。",
        );
      }
      const runtime = await deps.createRuntime(target);
      runtime.squadRunRepo.recordUsage(input.runId, input.usage);
    },

    /* W1：per-run 取消的 L1 半边（分格表见接口注释）。按**当时状态**分流；状态写路径只有两条
       （`discardQueuedRun` / `failMemberRun`），本层不碰任何台账列、不碰 git。 */
    async cancelSquadRun(target, input) {
      const runtime = await deps.createRuntime(target);
      const record = runtime.squadRunRepo.get(input.runId);
      if (record === null) {
        throw new Error(
          `取消 run 失败：squad_runs 里没有 runId=「${input.runId}」的行（目标 workspace=${keyOf(runtime)}）。` +
            "静默 no-op 会让界面以为取消了，而那条 run 仍可能停在 open。",
        );
      }
      const reason = input.reason ?? SQUAD_RUN_SETTLE_REASON_USER_CANCEL;
      if (record.status === "queued") {
        // 排队取消 = 丢弃（无会话无树）；同样落用户取消的码值（审计口径一致）。
        runtime.squadRunRepo.discardQueuedRun(input.runId, reason);
        return;
      }
      if (record.status === "open") {
        // L1 台账结算：出活跃集 ⇒ 容量释放 ⇒ 结算事实经 hub 扇出（队列推进零新代码）。
        await runtime.lifecycle.failMemberRun({ runId: input.runId, reason });
        return;
      }
      // `discarded` 幂等早退：重复取消第二次是成功（也涵盖「这条 run 早已失败收口」）。
      if (record.status === "discarded") return;
      throw new Error(
        `取消 run 失败：runId=「${input.runId}」当前状态是「${record.status}」而不是 open/queued —— ` +
          "它已经产出了东西（produced / rejected）或成果已落地（merged），按取消丢弃会丢掉队员的活。" +
          "要退回产出去「审查」（reviewMemberRun），要放弃整批走「整批放弃」（discardBatch）。",
      );
    },

    /* W1：看门狗判定所需的 git 事实（只读口，见 `SquadWatchdogGitFacts`）。与 lifecycle 的
       注入面**同一对调用**（`worktreeManager.list()` + `git rev-parse -q --verify refs/heads/<b>`）：
       看门狗族不得新写 git 判据（第二份判据会与 C1 的注入面漂移，而漂移不报错 —— 表现是
       「看门狗以为分支空闲而 C1 建不出树」或反之）。 */
    async getSquadWatchdogGitFacts(target, input) {
      const runtime = await deps.createRuntime(target);
      const liveTreeBranches = (await runtime.worktreeManager.list())
        .map((entry) => entry.branch)
        .filter((branch): branch is string => branch !== null);
      const existingBranchRefs: string[] = [];
      // 入参去重（同分支问一次即可），保持调用方给的顺序：判定面按它建集合/查表。
      for (const branch of new Set(input.branches)) {
        const result = await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
          cwd: runtime.boundWorkspace.path,
        });
        if (result.code === 0) existingBranchRefs.push(branch);
      }
      return { liveTreeBranches, existingBranchRefs };
    },

    /* W3：熔断窗口计数（唯一读口，见接口注释）。窗口起点在本层算（`SQUAD_BREAKER_WINDOW_MINUTES`
       单源在 shared）：消费点各自算一次就是第二份判据，而窗口算错只会让熔断早/晚一轮生效，
       不报错。过滤与分组由 repo 单源给出（本层不重写 SQL、不读回后重排）。 */
    async countWatchdogSettlementsByAgent(target) {
      const runtime = await deps.createRuntime(target);
      const sinceMs = Date.now() - SQUAD_BREAKER_WINDOW_MINUTES * MS_PER_MINUTE;
      const counts = runtime.squadRunRepo.countWatchdogSettlementsByAgent(keyOf(runtime), sinceMs);
      /* Map → 可序列化数组（服务面跨 RPC 边界）：顺序按 agentId 定序，读两次同一份结果逐字一致
         （服务面的确定性纪律；也免得调用方从一个无序形状里读顺序）。 */
      return [...counts.entries()]
        .map(([agentId, count]) => ({ agentId, count }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId));
    },

    /* W3：自动重试登记（见接口注释的三条纪律）。写路径只有 `insertIfAbsent`（义务表的唯一写者面），
       本层不碰 SQL、不碰 run 台账 —— 重试 run 由 host 的推进臂按义务重放开出来。 */
    async registerWatchdogRetry(target, input) {
      const runtime = await deps.createRuntime(target);
      const settled = runtime.squadRunRepo.get(input.settledRunId);
      if (settled === null) {
        throw new Error(
          `登记看门狗重试失败：squad_runs 里没有 runId=「${input.settledRunId}」的行。` +
            "静默 no-op 会让「这条 run 被结算过、但没人重试」变成没人知道的事。",
        );
      }
      const reason = settled.settleReason ?? null;
      if (
        reason === null ||
        !(SQUAD_RUN_WATCHDOG_SETTLE_REASONS as readonly string[]).includes(reason)
      ) {
        throw new Error(
          `登记看门狗重试被拒：runId=「${settled.runId}」的 settle_reason 是「${reason ?? "（空）"}」，` +
            "不在看门狗族（" +
            `${SQUAD_RUN_WATCHDOG_SETTLE_REASONS.join(" / ")}）内。` +
            "只有看门狗结算才自动重试 —— 用户取消与审查打回都不重试（用户/闸已表态），" +
            "静默登记等于替用户做了一次他没同意的重派发。",
        );
      }
      const workspaceKey = keyOf(runtime);
      if (
        runtime.squadRunRepo.hasOtherWatchdogSettledRunForPair(
          workspaceKey,
          settled.workItemId,
          settled.agentId,
          settled.runId,
          /* 额度取 shared 单源常量（不写死数字）：repo 只回答「同对另有的结算数是否已达额度」，
             改常量一处即调 —— 「预算几次」这个决策只该有一个落点。 */
          SQUAD_RETRY_BUDGET,
        )
      ) {
        // 预算已用（终身口径）：同对已用掉 SQUAD_RETRY_BUDGET 次重试额度 ⇒ 不再登记。
        return { kind: "budget_exhausted" };
      }
      const now = Date.now();
      // 重试 run 的身份在**登记时**铸定（`globalThis.crypto`：本文件必须浏览器安全，不引 node:crypto）。
      const retryRunId = globalThis.crypto.randomUUID();
      const inserted = runtime.squadDeferredDispatchRepo.insertIfAbsent({
        runId: retryRunId,
        workspaceKey,
        workItemId: settled.workItemId,
        agentId: settled.agentId,
        // 成因继承被结算行（G8）：本层不推断、不二次判定。
        dispatchCause: settled.dispatchCause,
        origin: "watchdog",
        createdAt: now,
        updatedAt: now,
      });
      if (inserted) return { kind: "registered", runId: retryRunId };
      /* 同对已有义务（R2 / 评论 / 另一次重试）⇒ 并入它：义务表的不变式是「每对至多一行」，
         重放机制不分来源都能把这一对再派一次，故并入不是丢失 —— 但必须**说出来**（返回值 + host 日志），
         否则「重试登记的 runId 去哪了」就成了无从回答的事。 */
      const existing = runtime.squadDeferredDispatchRepo.find(
        workspaceKey,
        settled.workItemId,
        settled.agentId,
      );
      if (existing === null) {
        // insertIfAbsent=false 却找不到行：与 X2.2 的不可达态同一处置（不得把「找不到」当「没有」）。
        throw new Error(
          `登记看门狗重试不可达态：insertIfAbsent 返回 false，但 (workItem=${settled.workItemId}, ` +
            `agent=${settled.agentId}) 查不到义务行。`,
        );
      }
      return { kind: "coalesced", targetRunId: existing.runId };
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

    /* 收件箱四项（**加法**，P2c）。前三个是目标方法、第四个是**有意的跨项目偏离**：

       `recordInboxItem` 走**目标显式**的既有形态（先按 target 现构 runtime，再由它的 repo 落库）——
       与 `createWorkItem` 同款：runtime 才是「为哪个 workspace 而构造」的权威。
       `listInboxItems` / `markInboxItemRead` / `archiveInboxItem` **没有唯一目标**（跨项目通知面 /
       全局唯一的条目 id），故走组合根注入的懒取 repo —— 这里**不得**给它们补一个 target 参数：
       用户裁定的正是「所有项目里等我处理的事，一次看全」。 */
    async recordInboxItem(target, input) {
      /* **不过门禁**（见接口注释第 2 条）：登记通知不是新派发。这里刻意不调 `assertEnabled`。
         写者纪律：只经 runtime 的 `inboxItemRepo.insertIfAbsent`，本层不碰 SQL、不拼 dedupKey
         （那是 `inboxItemProducers` 的唯一形状）。**不吞错**：登记失败照抛，由 best-effort 的调用方
         记日志（在 host 的失败/收尾路径上，一个抛错不得翻掉主流程 —— 但也不得在这里被静默）。 */
      const runtime = await deps.createRuntime(target);
      runtime.inboxItemRepo.insertIfAbsent(input);
    },

    async listInboxItems(options) {
      // 跨 workspace 的读取面（接口注释里有「有意偏离」的理由）：不经任一 runtime、不挑目标。
      return requireInboxItemRepo().listAll(options);
    },

    async markInboxItemRead(id) {
      // 条目 id 全局唯一 ⇒ 不需要目标。未命中由 repo **响亮抛**（界面不会以为标成功了）。
      requireInboxItemRepo().markRead(id);
    },

    async archiveInboxItem(id) {
      // 同 markInboxItemRead：只改 archived_at 一列；未命中响亮抛。
      requireInboxItemRepo().archive(id);
    },

    /* 唤醒规则六项（**加法**：P2b 第二半 + 收口）：实现与逐条口径全在 `squadWakeRules.ts`
       （见该文件头注释与接口 doc）；上面构造的 `wakeRuleOps` 即那六个方法，原样并进本返回值。 */
    ...wakeRuleOps,
  };
}
