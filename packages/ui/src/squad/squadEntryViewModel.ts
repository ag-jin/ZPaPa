import { isTerminalWorkItemStatus, type Squad, type TeamAgent, type WorkItem } from "@zcode/shared";
import {
  SQUAD_DISPATCH_DISABLED_CODE,
  isSquadBatchRoot,
  type ISquadRuntimeServiceShape,
  type ReviewOutcome,
  type SquadRunRecord,
  type SquadRunStatus,
  type SquadSnapshot,
  type SquadWorkspaceTarget,
} from "@zcode/services";

/* 最小入口视图的**纯逻辑**（不 import React、不 import UI 原语）。

   为什么把它单拆一层：ui 包没有渲染测试设施（既有测试全是纯逻辑），把「哪一段为空」「哪个结果
   配哪条提示」「哪些智能体可派发」这类判断留在组件里就等于**不可测**。放这里之后，
   数据面 / 审查动作 / 失败提示三类矩阵格子都能被 node:test 逐格钉住，组件只负责画。 */

// ---------- 数据面 ----------

export type SquadEntrySection<T> = { items: T[]; empty: boolean };

export type SquadEntrySectionState = {
  teamAgents: SquadEntrySection<TeamAgent>;
  squads: SquadEntrySection<Squad>;
  workItems: SquadEntrySection<WorkItem>;
  runs: SquadEntrySection<SquadRunRecord>;
};

function section<T>(items: T[]): SquadEntrySection<T> {
  return { items, empty: items.length === 0 };
}

/**
 * 一次算出四段视图状态。**全量渲染**：本阶段不做分页 / 虚拟化（spec §11.4 的性能条留到 P2c），
 * 快照里有几条就画几条；这也是 `getSnapshot()` 的当前口径（服务侧已经按 workspace 过滤过）。
 */
export function squadEntrySectionState(snapshot: SquadSnapshot): SquadEntrySectionState {
  return {
    teamAgents: section(snapshot.teamAgents),
    squads: section(snapshot.squads),
    workItems: section(snapshot.workItems),
    // 快照里的 runs 只含**未合并**的（`listActive` 口径），正是本视图要「收尾」的那批。
    runs: section(snapshot.runs),
  };
}

/** 可派发的协作智能体：停用或已归档的**不出现在候选里**（spec §16 S10：归档在派发时被 skip，不是失败）。 */
export function isDispatchableAgent(agent: TeamAgent): boolean {
  return agent.enabled && agent.archivedAt === undefined;
}

/** 可派发的小队：同上，停用 / 归档的不给候选 —— 给了再被拒等于替用户制造一次失败。 */
export function isDispatchableSquad(squad: Squad): boolean {
  return squad.enabled && squad.archivedAt === undefined;
}

export function dispatchableTeamAgents(snapshot: SquadSnapshot): TeamAgent[] {
  return snapshot.teamAgents.filter(isDispatchableAgent);
}

/** 建小队时的队员候选：可派发的智能体里**去掉队长本人**（spec §3.3：leader 自动并入 members）。 */
export function squadMemberCandidateAgents(
  snapshot: SquadSnapshot,
  leaderAgentId: string | null,
): TeamAgent[] {
  return dispatchableTeamAgents(snapshot).filter((agent) => agent.id !== leaderAgentId);
}

// ---------- 建工作项时的指派候选 ----------

export type SquadEntryAssigneeOption = {
  /** 稳定编码：`user` / `agent:<id>` / `squad:<id>`（无 id 冲突空间）。 */
  value: string;
  kind: "user" | "agent" | "squad";
  id: string;
  /** 展示名；`user` 为空串，由视图用本地化文案补上（纯函数不碰 i18n）。 */
  name: string;
};

export function workItemAssigneeOptions(snapshot: SquadSnapshot): SquadEntryAssigneeOption[] {
  return [
    { value: "user", kind: "user", id: WORK_ITEM_USER_ASSIGNEE_ID, name: "" },
    ...dispatchableTeamAgents(snapshot).map((agent) => ({
      value: `agent:${agent.id}`,
      kind: "agent" as const,
      id: agent.id,
      name: agent.name,
    })),
    ...snapshot.squads.filter(isDispatchableSquad).map((squad) => ({
      value: `squad:${squad.id}`,
      kind: "squad" as const,
      id: squad.id,
      name: squad.name,
    })),
  ];
}

/** 本机用户作为指派对象时的 id：`assignee.type === "user"` 那一支**不消费** id
    （`leaderDispatch` 只按 type 分流），故用稳定字面量即可，不需要用户身份。 */
export const WORK_ITEM_USER_ASSIGNEE_ID = "user";

/** 把上面选项的 `value` 解回 `assignee`。取不到合法形状就**抛**（用于拦下拼错的取值，
    而不是静默造一个空 id 的指派 —— 空 id 的指派在库里就是一条查不出对象的行）。 */
export function parseAssigneeValue(value: string): WorkItem["assignee"] {
  if (value === "user") return { type: "user", id: WORK_ITEM_USER_ASSIGNEE_ID };
  const separatorIndex = value.indexOf(":");
  const kind = value.slice(0, separatorIndex);
  const id = value.slice(separatorIndex + 1);
  if (separatorIndex < 0 || !id || (kind !== "agent" && kind !== "squad")) {
    throw new Error(`未知的指派取值「${value}」：只允许 user / agent:<id> / squad:<id>`);
  }
  return { type: kind, id };
}

// ---------- 运行状态文案 ----------

/** 运行状态的文案 id：用 `Record<SquadRunStatus, string>` **强制穷尽** ——
    将来给 `SQUAD_RUN_STATUSES` 加一个状态时这里会编译失败，而不是界面上多出一个裸 key。 */
export const SQUAD_RUN_STATUS_MESSAGE_IDS: Record<SquadRunStatus, string> = {
  open: "settings.experiments.squad.runStatus.open",
  produced: "settings.experiments.squad.runStatus.produced",
  rejected: "settings.experiments.squad.runStatus.rejected",
  merged: "settings.experiments.squad.runStatus.merged",
  discarded: "settings.experiments.squad.runStatus.discarded",
};

export function squadRunStatusMessageId(status: SquadRunStatus): string {
  return SQUAD_RUN_STATUS_MESSAGE_IDS[status];
}

// ---------- 显示名解析 ----------

/** 智能体显示名。查不到就原样显示 id：显示空会让「队长是谁」变成未知，比显示 id 更糟。 */
export function resolveTeamAgentName(snapshot: SquadSnapshot, agentId: string): string {
  return snapshot.teamAgents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

/**
 * 工作项的指派显示名。`null` 表示**当前用户**（`type: "user"`），由视图用本地化文案补上
 * —— 纯函数不碰 i18n。其它类型查不到对象时回落到 id（同上：不显示空）。
 */
export function resolveAssigneeName(
  snapshot: SquadSnapshot,
  assignee: WorkItem["assignee"],
): string | null {
  if (assignee.type === "user") return null;
  if (assignee.type === "agent") return resolveTeamAgentName(snapshot, assignee.id);
  return snapshot.squads.find((squad) => squad.id === assignee.id)?.name ?? assignee.id;
}

// ---------- 结果与失败提示 ----------

export type SquadEntryFeedbackTone = "success" | "warning" | "error";

export type SquadEntryFeedback = {
  tone: SquadEntryFeedbackTone;
  messageId: string;
  /** 原始失败细节（仅未知失败带）；视图把它一并显示，**不吞错**。 */
  detail?: string;
};

/**
 * 审查裁决 → 用户可见提示。四种结果各有其词，尤其：
 * **打回 ≠ 完成**（spec §6.2 / §16 S5：工作树保持存活到修复并合并），所以给 warning 且文案说「保留」；
 * 冲突 / 分支缺失是**失败**（spec §5.7 第 4 项：不解 ⇒ 不提前合主分支），必须让用户看到。
 */
export function reviewOutcomeFeedback(outcome: ReviewOutcome): SquadEntryFeedback {
  if (outcome.ok) {
    return outcome.merged
      ? { tone: "success", messageId: "settings.experiments.squad.review.merged" }
      : { tone: "warning", messageId: "settings.experiments.squad.review.rejectedKept" };
  }
  return outcome.reason === "conflict"
    ? { tone: "error", messageId: "settings.experiments.squad.review.conflict" }
    : { tone: "error", messageId: "settings.experiments.squad.review.branchMissing" };
}

/**
 * 任意操作失败 → 提示。
 *
 * **门禁不在这里判**（确认 2）：本函数只把服务层抛出的**稳定码**翻译成可读文案 ——
 * `createWorkItem` 等入口由服务层单点 `assertDispatchEnabled` 拦下并抛
 * `SquadDispatchDisabledError`（带 `SQUAD_DISPATCH_DISABLED_CODE`），这里识别它、
 * 显示「实验已关闭」，既**不吞掉**（吞掉等于让用户以为派发成功）也不自己再判一遍
 * （自己判就有了第二份判据，正是要消灭的形态）。
 */
export function squadEntryErrorFeedback(error: unknown): SquadEntryFeedback {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === SQUAD_DISPATCH_DISABLED_CODE) {
    return { tone: "warning", messageId: "settings.experiments.squad.dispatchDisabled" };
  }
  return {
    tone: "error",
    messageId: "settings.experiments.squad.operationFailed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** 取数通路缺失（`SquadRuntimeServiceUnavailableError`）的单列提示：它跟普通操作失败不是一类事。 */
export function squadServiceUnavailableFeedback(): SquadEntryFeedback {
  return { tone: "error", messageId: "settings.experiments.squad.serviceUnavailable" };
}

// ---------- 整批放弃（spec §6.3「整批可整体放弃」）----------

/**
 * 哪些工作项上给出「**放弃整批**」入口（spec §6.3）。
 *
 * 三条同时成立才给：
 * ① 它是一支小队批次的**根** —— 判据用服务面导出的 `isSquadBatchRoot`（与重驱枚举**同一份定义**）；
 *    这里**不重写**「什么是批次根」，否则「界面给得出、服务层不认」这种漂移不会报错。
 * ② **尚未终态** —— 已结算的批没有可弃之物，服务层会响亮拒绝（§5.7.4）；界面不该先给一个必然失败的按钮。
 * ③ 本批**确实开过队员 run** —— 入口是**破坏性**的（会删分支、清工作树），所以不给空批入口：
 *    对着一条没有任何分支/工作树的批次说「会删掉队员分支与集成分支」会让确认文案本身变成假话。
 *    （服务层对空批的放弃**是**接受的——那等于取消一条还没派过单的批；界面只是不把它做成按钮。）
 */
export function squadDiscardableWorkItemIds(snapshot: SquadSnapshot): Set<string> {
  const runParentWorkItemIds = snapshot.runs.map((run) => run.parentWorkItemId);
  const ids = new Set<string>();
  for (const workItem of snapshot.workItems) {
    if (isTerminalWorkItemStatus(workItem.status)) continue;
    if (!isSquadBatchRoot({ workItem, runParentWorkItemIds })) continue;
    if (!runParentWorkItemIds.includes(workItem.id)) continue;
    ids.add(workItem.id);
  }
  return ids;
}

/**
 * 「放弃整批」的**二次确认**状态（纯逻辑，可被 node:test 钉住）。
 *
 * 为什么把这一步抽出来而不是让组件自己 `useState<string | null>`：本动作**破坏且不可撤销**
 * （删分支 + 清工作树），"未确认就不执行"是它的**正确性**要求，不是样式细节 ——
 * 写成纯函数之后，「点按钮只进入待确认态」「只有确认能产出可执行目标」两件事都能被断言，
 * 而不是只能靠读 JSX 相信它。
 */
export type SquadDiscardConfirmState = { readonly pendingWorkItemId: string | null };

export const SQUAD_DISCARD_CONFIRM_IDLE: SquadDiscardConfirmState = { pendingWorkItemId: null };

/** 用户点「放弃整批」⇒ **只进入待确认态**：本函数拿不到任何服务，结构上不可能执行任何东西。 */
export function requestSquadDiscard(workItemId: string): SquadDiscardConfirmState {
  return { pendingWorkItemId: workItemId };
}

/** 取消 ⇒ 回到空闲（不执行）。 */
export function cancelSquadDiscard(): SquadDiscardConfirmState {
  return SQUAD_DISCARD_CONFIRM_IDLE;
}

/**
 * 确认 ⇒ 给出**唯一**可执行的目标。
 *
 * 返回值与状态分开（`next` 与 `workItemId`）：先把状态收回到空闲、再拿目标去执行，
 * 于是「对话框还开着时重复点确认」不会执行第二次（第二次的输入是空闲态 ⇒ 目标为 `null`）。
 */
export function confirmSquadDiscard(state: SquadDiscardConfirmState): {
  next: SquadDiscardConfirmState;
  workItemId: string | null;
} {
  return { next: SQUAD_DISCARD_CONFIRM_IDLE, workItemId: state.pendingWorkItemId };
}

/**
 * 执行「放弃整批」并把结果翻成**用户可见**的提示（成功/失败都有归宿，不静默吞掉）。
 *
 * 这个函数是 UI 侧**唯一**会调到 `discardBatch` 的地方（组件里连这个名字都不出现，见
 * `squadEntryView.test.ts` 的结构守卫）：于是「执行必须经过确认」这条约束有一个**单一入口**可守 ——
 * 未确认（`workItemId === null`）时**一级都不执行**，并回一条明说「没有删除任何东西」的提示。
 *
 * 为什么未确认也算「一条提示」而不是直接抛：走到这里说明调用方接线错了，但错误的代价可能是
 * 一次不可撤销的删除 —— 宁可给一条「没执行」的提示（用户能看见，代码走查也能看见），
 * 也绝不把它变成一次误删。
 */
export async function executeSquadDiscard(input: {
  service: Pick<ISquadRuntimeServiceShape, "discardBatch">;
  target: SquadWorkspaceTarget;
  decision: ReturnType<typeof confirmSquadDiscard>;
}): Promise<SquadEntryFeedback> {
  if (input.decision.workItemId === null) {
    return { tone: "warning", messageId: "settings.experiments.squad.discard.notConfirmed" };
  }
  try {
    // 目标显式（确认 3：runtime 按目标现构、不缓存，没有隐式默认 workspace）。
    await input.service.discardBatch(input.target, { parentWorkItemId: input.decision.workItemId });
    return { tone: "success", messageId: "settings.experiments.squad.discard.succeeded" };
  } catch (error) {
    // 失败必须能读出来：稳定码翻译（门禁/未接上）+ 未知失败带**原始细节**，见 squadEntryErrorFeedback。
    return squadEntryErrorFeedback(error);
  }
}
