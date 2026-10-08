import type { WorkItem, WorkItemStatusKey } from "@zcode/shared";
import type { UserDispatchCause } from "./squadDispatchRequests.js";
import { SQUAD_RUN_SETTLE_REASON_USER_CANCEL, type SquadRunRecord } from "./squadRunRepo.js";
import type { AddWorkItemActivityInput, WorkItemActivityRepo } from "./workItemActivityRepo.js";
import type { AuthorRef, SourceRunRef } from "./workItemCommentRepo.js";
/* 只取**类型**（`import type` 会被擦除）：交付物存储面值导入 node:fs/node:crypto，
   值导入会把 node 侧带进投影模块的依赖图（本模块被 browserSafeRootEntry 的传递可达检查覆盖）。 */
import type { DeliverableKind } from "./workItemDeliverableRepo.js";

/* C3b.1：执行面向工作项时间线（append-only 事实账本）的**投影深模块**（设计报告 §7）。

   为什么是独立深模块而不是十个写点各自拼一行：
   · 调用方只交「已经拿在手里的行 + 一个意图」，键形状 / payload 组装 / actor / sourceRun / 时间戳
     全在模块内 —— 删掉它，十处调用点各自长出这些判据，复杂度在 N 个调用点重现（模块在赚自己的饭钱）。
   · 幂等键形状**只有这一处**（十一个导出纯函数）：C3b.2 只消费，不得再造第二份形状。

   **依赖集封顶**（结构红线，`workItemActivityProjectionGuards.test.ts` 的 G1/G2 钉住）：
   只有 `activities` + 注入的 `now` / `logWarn`。没有派发面（openMemberRun / planDispatch / …）、
   没有状态机（transition / updateStatus / workItemService）⇒「投影不派发、不改状态」不是靠自觉，
   而是**结构上的不可能**（同 WorkItemDecisionService 的依赖集封顶手法）。

   **这不是 §5.2 的例外，而是它的满足**：spec §3.3 明文要求 `status_changed` 引用既有
   `WorkItemService.transition`；投影是**下行记录**（事实写成功之后的回声），不给任何协作链
   一丝驱动力 —— 与 §5.2 禁的「协作链上行驱动执行面」方向相反。写下这里，是因为「统一走事件总线
   统一投影」的诱惑会复发：本域已拒绝该形态（hub 载荷 (runId, status, reason?) 无法区分
   「该投影的终态」与「不得投影的残行自愈」，且订阅者抛错会把一次已成功的写入翻转成调用方异常）。

   **失败面**：投影是已落地事实之后的回声 ⇒ 写失败**不得**抛（抛出去会把一次成功的状态迁移 /
   改派翻转成响亮失败，而事实不回滚）。catch 后经 `logWarn` 留痕；库级损坏由下一次事实写响亮兜底。
   顺序硬约束与调用点同款：**事实先落、投影随后**。

   **不回填**（设计 §6）：历史行不伪造 —— 新事实起记账。 */

/** 稳定系统主体（spec §3.1「system 使用稳定服务主体 id」）：单源定义，人类归因增强是另立轮次的开放问题。 */
export const SYSTEM_ACTIVITY_ACTOR: AuthorRef = { kind: "system", id: "squad-runtime" };

/**
 * `status_changed` 的幂等键（形状冻结，设计 §5）：`status:<workItemId>:<from>:<to>:<ms>`。
 *
 * **该字符串永不解析**（只作等值与唯一索引）：与 `comment:<id>:created` / `decision:<id>:created`
 * 同族 —— 一旦有人开始解析它，就会重蹈 P1 游标「自己拼的字符串自己读不回」的覆辙。
 * 带 `<ms>` 是为了让「同一工作项两次合法的同向迁移」各留一枚（同毫秒边角已登记接受，设计 §10-5）。
 */
export function computeStatusChangedDedupKey(input: {
  workItemId: string;
  from: WorkItemStatusKey;
  to: WorkItemStatusKey;
  at: number;
}): string {
  return `status:${input.workItemId}:${input.from}:${input.to}:${input.at}`;
}

/**
 * `assignee_changed` 的幂等键（形状冻结，设计 §5）：
 * `assignee:<workItemId>:<fromType>:<fromId>:<toType>:<toId>:<ms>`。
 * 类型位不可省：「agent X」与「squad X」是两个独立 id 空间，同名不算同一对象（同派发事件载荷的理由）。
 */
export function computeAssigneeChangedDedupKey(input: {
  workItemId: string;
  from: WorkItem["assignee"];
  to: WorkItem["assignee"];
  at: number;
}): string {
  return `assignee:${input.workItemId}:${input.from.type}:${input.from.id}:${input.to.type}:${input.to.id}:${input.at}`;
}

/* run / worktree 八枚的键形状（设计 §5 表；第 19 枚 `run_rejected` 为 2026-10-08 用户裁定的加法，
   与同族逐字同形）：一次冻结后只消费、不得再造第二份形状。八枚都以 runId 为身份（一条 run 的每类
   事实至多一枚），故没有 `<ms>` 段 —— 与工作项两枚的区别正是「事实身份」不同：状态/改派可以合法地
   发生两次（同向迁移，靠毫秒区分），开跑/终态/建树/合树/弃树/打回对一个 runId 是唯一的
   （重复审查打回同一条 run 也只留一枚：同键重投返回既存行）。 */
export function computeRunStartedDedupKey(runId: string): string {
  return `run:${runId}:started`;
}
export function computeRunCompletedDedupKey(runId: string): string {
  return `run:${runId}:completed`;
}
export function computeRunFailedDedupKey(runId: string): string {
  return `run:${runId}:failed`;
}
export function computeRunCancelledDedupKey(runId: string): string {
  return `run:${runId}:cancelled`;
}
export function computeRunRejectedDedupKey(runId: string): string {
  return `run:${runId}:rejected`;
}
export function computeWorktreeCreatedDedupKey(runId: string): string {
  return `run:${runId}:worktree_created`;
}
export function computeWorktreeMergedDedupKey(runId: string): string {
  return `run:${runId}:worktree_merged`;
}
export function computeWorktreeDiscardedDedupKey(runId: string): string {
  return `run:${runId}:worktree_discarded`;
}

/**
 * 第 20 枚 `deliverable_registered` 的**回声键**（#7 交付物 D1a 落键函数、D1b 接线投影臂）：
 * `deliverable:<deliverableId>:registered`（设计 §3.4）。
 *
 * 由**交付物 id** 派生而不是由 runId：一条交付物只登记一次，重投同键由唯一索引咬住
 * （与 `comment:<id>:created` / `decision:<id>:created` 同族）；键**永不解析**（只作等值与唯一索引）。
 * 刻意不带 `<ms>`：与状态/改派两枚的区别是事实身份不同——「同一工作项两次合法的同向迁移」是两件事，
 * 「同一条交付物被登记两次」不是。
 */
export function computeDeliverableRegisteredDedupKey(deliverableId: string): string {
  return `deliverable:${deliverableId}:registered`;
}

/**
 * 第 21 枚 `pr_merged` 的**回声键**（#8 D3）：`pr:<pullRequestId>:merged`（设计 §4.2 的 payload
 * `{prNumber, url}`）。
 *
 * 由**关联行 id** 派生而不是由工作项/PR 号：一条关联只对应一枚「它驱动了终态」的事实，
 * 重投同键由唯一索引咬住（与 `deliverable:<id>:registered` 同族）；键**永不解析**（只作等值与唯一索引）。
 * 带 `<ms>` 的形态在这里是错的：同一条 PR 合并只可能驱动一次终态（工作项一旦 done，后面的刷新
 * 连判定都不做），不需要毫秒位来区分「两次合法的同向迁移」——那是状态/改派两枚的形态。
 */
export function computePullRequestMergedDedupKey(pullRequestId: string): string {
  return `pr:${pullRequestId}:merged`;
}

/**
 * 终态迁移的**投影意图**（调用方声明，不从 `(status, reason)` 反推 —— 反推在残行自愈臂上必然说谎：
 * 那些行同样是 `discarded`+无 reason，却从未开跑、没有树，投影它们就是写谎话）。
 * 判据矩阵见设计 §5.2；缺省 = 不投影（残行三臂依赖它）。
 *
 * `run_rejected` 是 2026-10-08 用户裁定的第六个意图（第 19 枚 kind）：`rejected` 曾是时间线唯一
 * 不可见的终态（settleStatus 的 rejected 臂此前不传意图）。它同样**由调用方声明**而不可反推：
 * 打回待修与「产出入账」在 `(status, reason)` 上分得开（produced vs rejected），但把判据散到
 * 调用点就会与 status 一起分叉；意图位才是那条判据的唯一落点。
 */
export type RunSettleIntent =
  | { kind: "run_completed" }
  | { kind: "run_failed"; reason: string }
  | { kind: "run_cancelled"; reason: string }
  | { kind: "run_rejected" }
  | { kind: "worktree_merged"; integration: string }
  | { kind: "worktree_discarded" };

/**
 * 失败原因 → 投影意图的**映射单源**（设计 §5.2 表：`reason = user_cancel` ⇒ cancelled，其余 ⇒ failed）。
 * 放在投影模块而不是 lifecycle：看门狗族码值属于同一条判定链（`squadRunRepo` 的码值常量），
 * 若在 lifecycle 内联比较，同一判据就有两份、漂移不报错。
 */
export function runSettleIntentForFailureReason(
  reason: string,
): Extract<RunSettleIntent, { kind: "run_failed" } | { kind: "run_cancelled" }> {
  return reason === SQUAD_RUN_SETTLE_REASON_USER_CANCEL
    ? { kind: "run_cancelled", reason }
    : { kind: "run_failed", reason };
}

/** 台账行 → `sourceRun`：role 由 `isLeaderTask` 无歧义映射（standalone 不进台账，故无第三种）；
    `squadId` 缺省不写 —— lifecycle 不知道 squad，宁缺毋造（活动读回纪律要求「有 runId 就必须有合法角色」）。 */
function sourceRunOf(record: SquadRunRecord): SourceRunRef {
  return {
    runId: record.runId,
    agentId: record.agentId,
    role: record.isLeaderTask ? "leader" : "member",
  };
}

export interface WorkItemActivityProjector {
  /** `transition` 的 CAS **命中**之后调用（未命中 = 事实未发生 = 不得投影）。 */
  statusChanged(input: { item: WorkItem; from: WorkItemStatusKey; to: WorkItemStatusKey }): void;
  /**
   * `assignee` 的**两个**既有写者都在写成功后调用：`applyWorkItemAssignee`（带成因）与
   * `archiveSquadAndTransfer`（**不带**成因 —— 归档转交不是派发，不得伪造成因）。
   * 两处写者、一份判据：键形状与 payload 组装只在这里。
   */
  assigneeChanged(input: {
    item: WorkItem;
    from: WorkItem["assignee"];
    to: WorkItem["assignee"];
    cause?: UserDispatchCause;
  }): void;
  /**
   * 开跑出口（C3b.2 接线：`openMemberRun` 的四个 `opened` 出口 + `recordLeaderRun` 的 `recorded:true`）：
   * member 建树即写 `worktree_created`；leader 无树不写。`queued/coalesced/deferred/...` 出口不调用它
   * —— 还没开跑 / 重投，不是「开跑」这条事实。
   */
  runStarted(record: SquadRunRecord): void;
  /**
   * 终态收口（C3b.2 接线：`settleStatus` 之后由调用方声明意图）：**意图由调用方给**，
   * 不从 `(status, reason)` 反推（残行自愈臂与真弃树同形，反推必然说谎）。
   */
  runSettled(record: SquadRunRecord, intent: RunSettleIntent): void;
  /**
   * 第 20 枚 `deliverable_registered`（#7 D1b 接线：交付物**已落库**之后由登记面调用）。
   *
   * **actor 原样取交付物行的 actor**，不做系统主体兜底：自动捕获的行是 `system(squad-runtime)`，
   * 手动登记的行是操作者 —— 回声若一律记成 system，时间线上就分不出「谁登记的」，
   * 而「人工贴的链接被记成系统产物」正是审计链最不该有的那种失真。
   */
  deliverableRegistered(input: {
    workspaceKey: string;
    workspacePath: string;
    workItemId: string;
    deliverableId: string;
    kind: DeliverableKind;
    title: string;
    /** NULL = 不挂 run（手动登记 / 批级 diff）。 */
    runId: string | null;
    actor: AuthorRef;
  }): void;
  /**
   * 第 21 枚 `pr_merged`（#8 D3 接线：`workItemPullRequestEntry.refresh` 的终态驱动在
   * `transition` **命中**之后调用）。
   *
   * **只在 CAS 命中时调用**：这条回声是「这枚 PR 的合并驱动了本工作项的终态」的证据，
   * 不是「这条 PR merged」的复述（复述由快照列如实承载）—— 未命中的那次不该留下它。
   * actor = 系统主体（外部信号驱动，不是某个人的动作）；不挂 `sourceRun`（合并发生在远端，
   * 没有任何一条本机 run 是它的来源）。
   */
  pullRequestMerged(input: {
    workspaceKey: string;
    workspacePath: string;
    workItemId: string;
    /** 关联行 id（回声键由它派生：同一枚 PR 只留一条）。 */
    pullRequestId: string;
    prNumber: number;
    url: string;
  }): void;
}

/**
 * 注入面 = 依赖集封顶（改这个类型即编译错）：`activities` 是唯一存储写口，`now` 是时间源，
 * `logWarn` 是失败留痕口（缺省回落 `console.warn`，与 `squadRuntimeService` 的既有手法一致）。
 * `newId` **不在**注入面：十枚投影的 id 都由 dedupKey 确定性派生（`activity-<键>`）——
 * 重投连 id 都不新建行，也就不需要（更不该有）一个随机 id 源。
 */
export function createWorkItemActivityProjector(deps: {
  activities: WorkItemActivityRepo;
  now?: () => number;
  logWarn?: (message: string, error?: unknown) => void;
}): WorkItemActivityProjector {
  const now = deps.now ?? (() => Date.now());
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));

  /**
   * 唯一的落库口：组装完整行 + **失败不抛**。id 与 dedupKey 同源（`activity-<键，冒号换连字符>`）——
   * 同 CommentService 的 `activity-<commentId>-created` 手法：同事实重投连 id 都不新建行。
   */
  function append(input: {
    kind: AddWorkItemActivityInput["kind"];
    workspaceKey: string;
    workspacePath: string;
    workItemId: string;
    occurredAt: number;
    payload: Record<string, unknown>;
    dedupKey: string;
    sourceRun?: SourceRunRef;
    /** 缺省 = 系统主体（其余十枚投影的既有 actor）；只有交付物回声按行取 actor（见接口注释）。 */
    actor?: AuthorRef;
  }): void {
    const actor = input.actor ?? SYSTEM_ACTIVITY_ACTOR;
    try {
      deps.activities.add({
        id: `activity-${input.dedupKey.replaceAll(":", "-")}`,
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        workItemId: input.workItemId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        actor,
        ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
        initiatedBy: actor,
        payload: input.payload,
        dedupKey: input.dedupKey,
        createdAt: input.occurredAt,
      });
    } catch (error) {
      logWarn(
        `工作项活动投影写入失败（kind=${input.kind}, dedupKey=${input.dedupKey}）：` +
          "投影是事实落地之后的回声，失败只留痕、不改判——已落地的事实不因回声丢失而回滚。",
        error,
      );
    }
  }

  return {
    statusChanged({ item, from, to }) {
      const at = now();
      append({
        kind: "status_changed",
        workspaceKey: item.workspaceIdentity,
        workspacePath: item.workspacePath,
        workItemId: item.id,
        occurredAt: at,
        payload: { from, to },
        dedupKey: computeStatusChangedDedupKey({ workItemId: item.id, from, to, at }),
      });
    },
    assigneeChanged({ item, from, to, cause }) {
      const at = now();
      append({
        kind: "assignee_changed",
        workspaceKey: item.workspaceIdentity,
        workspacePath: item.workspacePath,
        workItemId: item.id,
        occurredAt: at,
        // 成因**原样透传**（缺省不写）：它是调用面的既成事实，投影不二次判定、不发明闭集外的值。
        payload: {
          from: { type: from.type, id: from.id },
          to: { type: to.type, id: to.id },
          ...(cause !== undefined ? { cause } : {}),
        },
        dedupKey: computeAssigneeChangedDedupKey({ workItemId: item.id, from, to, at }),
      });
    },
    runStarted(record) {
      const at = now();
      const sourceRun = sourceRunOf(record);
      append({
        kind: "run_started",
        workspaceKey: record.workspaceKey,
        workspacePath: record.workspacePath,
        workItemId: record.workItemId,
        occurredAt: at,
        sourceRun,
        // branch/cause/入边：NULL 一律**不写**（不猜：NULL 只表示「不知道」，不表示任何具体值）。
        payload: {
          agentId: record.agentId,
          isLeaderTask: record.isLeaderTask,
          ...(record.branch !== null ? { branch: record.branch } : {}),
          ...(record.dispatchCause !== null ? { dispatchCause: record.dispatchCause } : {}),
          ...(record.causedByRunId !== null ? { causedByRunId: record.causedByRunId } : {}),
        },
        dedupKey: computeRunStartedDedupKey(record.runId),
      });
      // 建树与开跑同点发生（allocate → return opened）：member 出口才有树。
      if (record.branch !== null) {
        append({
          kind: "worktree_created",
          workspaceKey: record.workspaceKey,
          workspacePath: record.workspacePath,
          workItemId: record.workItemId,
          occurredAt: at,
          sourceRun,
          payload: { branch: record.branch, agentId: record.agentId },
          dedupKey: computeWorktreeCreatedDedupKey(record.runId),
        });
      }
    },
    runSettled(record, intent) {
      const at = now();
      const base = {
        workspaceKey: record.workspaceKey,
        workspacePath: record.workspacePath,
        workItemId: record.workItemId,
        occurredAt: at,
        sourceRun: sourceRunOf(record),
      };
      switch (intent.kind) {
        case "run_completed":
          /* status 由 isLeaderTask 定（leader run 收口 = merged，member = produced）：两个调用方
             （completeLeaderRun / completeMemberRun）与这条映射一一对应，故不需要第三个输入位。 */
          append({
            ...base,
            kind: "run_completed",
            payload: {
              status: record.isLeaderTask ? "merged" : "produced",
              agentId: record.agentId,
              isLeaderTask: record.isLeaderTask,
            },
            dedupKey: computeRunCompletedDedupKey(record.runId),
          });
          return;
        case "run_failed":
          append({
            ...base,
            kind: "run_failed",
            payload: { reason: intent.reason, agentId: record.agentId },
            dedupKey: computeRunFailedDedupKey(record.runId),
          });
          return;
        case "run_cancelled":
          append({
            ...base,
            kind: "run_cancelled",
            payload: { reason: intent.reason },
            dedupKey: computeRunCancelledDedupKey(record.runId),
          });
          return;
        case "run_rejected":
          /* 打回待修（spec §6.2：工作树必须存活到合并）：payload 与 worktree_* 族同形 ——
             branch 由行取（NULL 不写，同族手法）、agentId 同族携带；**不带 reason**：
             `reviewMemberRun` 的入参里没有原因，宁缺毋造（有原文才加）。 */
          append({
            ...base,
            kind: "run_rejected",
            payload: {
              ...(record.branch !== null ? { branch: record.branch } : {}),
              agentId: record.agentId,
            },
            dedupKey: computeRunRejectedDedupKey(record.runId),
          });
          return;
        case "worktree_merged":
          append({
            ...base,
            kind: "worktree_merged",
            payload: {
              ...(record.branch !== null ? { branch: record.branch } : {}),
              integration: intent.integration,
              agentId: record.agentId,
            },
            dedupKey: computeWorktreeMergedDedupKey(record.runId),
          });
          return;
        case "worktree_discarded":
          append({
            ...base,
            kind: "worktree_discarded",
            payload: {
              ...(record.branch !== null ? { branch: record.branch } : {}),
              ...(record.dirName !== null ? { dirName: record.dirName } : {}),
            },
            dedupKey: computeWorktreeDiscardedDedupKey(record.runId),
          });
          return;
      }
    },
    deliverableRegistered(input) {
      append({
        kind: "deliverable_registered",
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        workItemId: input.workItemId,
        occurredAt: now(),
        /* payload 按设计 §3.4：`{kind, title, deliverableId, runId?}`。
           `runId` 缺省不写（手动登记 / 批级 diff 本就不挂 run，写 null 会被读成「挂了一个空 run」）；
           `sourceRun` 也不写：投影手里只有 runId 一个字符串，凑一个 role/agentId 出来就是造事实
           （活动读回纪律要求「有 runId 就必须有合法角色」）。 */
        payload: {
          kind: input.kind,
          title: input.title,
          deliverableId: input.deliverableId,
          ...(input.runId !== null ? { runId: input.runId } : {}),
        },
        dedupKey: computeDeliverableRegisteredDedupKey(input.deliverableId),
        // actor **按行取**（见接口注释）：人工登记与自动捕获在时间线上必须分得开。
        actor: input.actor,
      });
    },
    pullRequestMerged(input) {
      append({
        kind: "pr_merged",
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        workItemId: input.workItemId,
        occurredAt: now(),
        /* payload 按设计 §4.2：`{prNumber, url}`。不写 mergedAt：调用点是**快照刷新之后**，
           这里多带一个时刻只是把快照列里已有的事实抄第二份（两份迟早对不上）。 */
        payload: { prNumber: input.prNumber, url: input.url },
        dedupKey: computePullRequestMergedDedupKey(input.pullRequestId),
        // actor 缺省 = 系统主体（外部信号驱动，不是某人的动作）——见接口注释。
      });
    },
  };
}
