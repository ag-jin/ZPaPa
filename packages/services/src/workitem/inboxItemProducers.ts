import type { SquadPrGateDegradeCode } from "@zcode/shared";
import type { InboxItemInput } from "./inboxItemRepo.js";

/* 五个产生点的**纯构建件**（spec §5.7.4 冲突 / §6.2 队员失败 / §6.6 启动和解 / §3.9 四条 skip / W1 看门狗 run_stalled）。

   为什么单独一个文件、且**纯函数**（不碰 IO、不 import node 侧）：
   1. **dedupKey 的唯一形状**在这里（`computeInboxDedupKey`）：产生点各拼一份串，拼错了不报错，
      只会表现成「同一件事反复出现在收件箱里」或「两件事被当成一件」；
   2. `title` / `detail` 的组成规则只有一处：各产生点只回答「事实是什么」，
      不决定「人看到什么」（句式与本地化由 UI 按 `kind` 决定，见下）；
   3. 纯函数 ⇒ 可直接断言（squadInbox.test.ts 的构建件用例），不需要起 git 或库。

   **title 不做本地化**：它填的是**面向人的主体**（工作项标题，拿不到时回落 id）——
   「这是什么」交给 `kind`（枚举），UI 两语由 kind 决定句式。把翻译塞进这里会让
   「一条记录长什么样」按产生点的语言习惯漂移，且写进库的是某个时刻的译文、改不了。 */

/** `merge_conflict` 的两个**不同分支事实**（逐队员合并时冲突 / 整批合回 base 时冲突）。 */
export type MergeConflictFacts =
  | {
      /** 逐队员合并时冲突：谁的分支进不了集成分支。 */
      phase: "member_merge";
      runId: string;
      agentId: string;
      /** 冲突队员的分支名（编排器的 `memberRuns` 只取分支非空的行）。 */
      memberBranch: string;
      integrationBranch: string;
      /** git 给的原文明细（供人归因）。 */
      detail: string;
    }
  | {
      /** 集成分支整批合回 base 时冲突。 */
      phase: "batch_finalize";
      integrationBranch: string;
      /** 落点分支（base）。 */
      targetBranch: string;
      /** git 给的原文明细。 */
      detail: string;
    };

/**
 * 去重键的**唯一形状**（「产生点 + 幂等键的稳定一半」）：
 *
 * · `merge_conflict` ⇒ 按**父工作项**去重：同一批的冲突是**一个事实**（逐队员与整批合回两条路径
 *   都可能对同一条批再报一次；按父项收敛成一条，人才不会看到两条「同一批卡住了」）；
 * · `member_failed` / `run_orphaned` ⇒ 按 **run** 去重：一次 run 的失败/孤儿是一个事实，
 *   重投（重连、重复和解）不得产生第二条；
 * · `dispatch_skipped` ⇒ 按**工作项 + reason 原文**去重：「同一事实」= 同工作项 + 同原因；
 *   原因变了（例如从「已归档」变成「已停用」）就是**新事实**，必须给新的一条
 *   —— 用 reason 原文而不是归一化的枚举，是因为四条文案的每一句都点名了不同的处置方向。
 *
 * 调用方（四个产生点）**不得**自己拼这个串：以上四条形状只有这一处定义。
 */
export type InboxDedupFact =
  | { kind: "merge_conflict"; parentWorkItemId: string }
  | { kind: "member_failed"; runId: string }
  | { kind: "run_orphaned"; runId: string }
  | { kind: "run_stalled"; runId: string }
  | { kind: "dispatch_skipped"; workItemId: string; reason: string }
  /* #8 D3：pr-gate 降级按「父项 + **码值**」去重（同 dispatch_skipped 的「原因变了就是新事实」口径，
     但用**闭集码值**而不是原因原文：码值是稳定判别，原文会随文案改写而漂移）。 */
  | { kind: "pr_gate_degraded"; parentWorkItemId: string; code: SquadPrGateDegradeCode };

export function computeInboxDedupKey(fact: InboxDedupFact): string {
  switch (fact.kind) {
    case "merge_conflict":
      return `merge_conflict:${fact.parentWorkItemId}`;
    case "member_failed":
      return `member_failed:${fact.runId}`;
    case "run_orphaned":
      return `run_orphaned:${fact.runId}`;
    /* W1：按 **run** 去重（与 member_failed / run_orphaned 同款）。看门狗每 tick 都会对同一条卡住的
       run 再产一次决策，若按「原因」或加时间戳去重，收件箱会被同一件事按 tick 刷屏 ——
       而事实自始至终只有一个：这条 run 卡住了。原因变了（探测死会话 → TTL）也仍是同一件事。 */
    case "run_stalled":
      return `run_stalled:${fact.runId}`;
    case "dispatch_skipped":
      return `dispatch_skipped:${fact.workItemId}:${fact.reason}`;
    case "pr_gate_degraded":
      return `pr_gate_degraded:${fact.parentWorkItemId}:${fact.code}`;
  }
}

/**
 * 合并冲突（父项已 `blocked`）：`merge_conflict` / `action_required`。
 *
 * `parentTitle` 拿不到时回落 `parentWorkItemId`（拿不到标题不阻断登记 —— 一条「父项 xx 冲突」远好过
 * 什么都没记；回落规则放在构建件里，产生点不各自判）。
 */
export function buildMergeConflictInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  parentWorkItemId: string;
  /** 父项标题（调用方从 `workItemRepo.get` 拿）；`null` = 拿不到 ⇒ 回落 id。 */
  parentTitle: string | null;
  conflict: MergeConflictFacts;
}): InboxItemInput {
  const { conflict } = input;
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "merge_conflict",
    dedupKey: computeInboxDedupKey({
      kind: "merge_conflict",
      parentWorkItemId: input.parentWorkItemId,
    }),
    title: input.parentTitle ?? input.parentWorkItemId,
    // detail 形状**固定**（不适用的一律 null）：两条冲突路径的字段不同，但读到的人不必按 phase 猜哪些键在。
    detail: {
      parentWorkItemId: input.parentWorkItemId,
      phase: conflict.phase,
      runId: conflict.phase === "member_merge" ? conflict.runId : null,
      agentId: conflict.phase === "member_merge" ? conflict.agentId : null,
      memberBranch: conflict.phase === "member_merge" ? conflict.memberBranch : null,
      integrationBranch: conflict.integrationBranch,
      targetBranch: conflict.phase === "batch_finalize" ? conflict.targetBranch : null,
      conflictDetail: conflict.detail,
    },
    workItemId: input.parentWorkItemId,
    runId: conflict.phase === "member_merge" ? conflict.runId : undefined,
  };
}

/**
 * run 的会话终态失败 / 中止（host 在 `failMemberRun` 那一支调用）：`member_failed` / `attention`。
 *
 * `branch` 允许 `null`：**队长 run 无分支**（不建工作树），而失败分支是队员与队长**共用**的
 * （两者都是有台账的真实会话）—— 产生点从台账信息可得处取，拿不到（或本来就没有）给 `null`。
 * `sessionId` 同样允许 `null`：**UI 的「打开会话」穿透靠它**（`detail.sessionId` 是唯一来源，
 * 见 ui 的 `inboxItemSessionId`）—— 拿不到就登记 `null`，界面按缺失降级（不给钮），不报错。
 * `title` 拿不到工作项标题时回落 `workItemId`（同 `buildMergeConflictInboxItem` 的回落口径）。
 */
export function buildMemberFailedInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** 工作项标题；`null` = 拿不到 ⇒ 回落 `workItemId`。 */
  workItemTitle: string | null;
  runId: string;
  agentId: string;
  /** 该 run 的分支名；队长 run 无分支 ⇒ `null`（两个 run 类别共用这条失败出口）。 */
  branch: string | null;
  /** 这个 run 的会话 id（host 派发时拿到的是 `task.taskId`）；`null` = 拿不到 ⇒ UI 不给「打开会话」。
      键名与 `buildOrphanedRunInboxItem` 的既有 `sessionId` 一致：两条 run 类条目对 UI 是同一件事。 */
  sessionId: string | null;
  /** 失败原因原文（含会话终态与错误详情）。 */
  reason: string;
}): InboxItemInput {
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "member_failed",
    dedupKey: computeInboxDedupKey({ kind: "member_failed", runId: input.runId }),
    title: input.workItemTitle ?? input.workItemId,
    detail: {
      workItemId: input.workItemId,
      runId: input.runId,
      agentId: input.agentId,
      branch: input.branch,
      sessionId: input.sessionId,
      reason: input.reason,
    },
    workItemId: input.workItemId,
    runId: input.runId,
  };
}

/**
 * 启动和解收掉的残留 run（宿主已消失，没有东西会再把它推向终态）：`run_orphaned` / `attention`。
 *
 * `sessionId` 允许 `null`：未绑会话的历史行同样按「没有东西会推进它」和解（host 的判据如此）。
 * `title` 拿不到工作项标题时回落 `workItemId`（同前两个构建件）。
 */
export function buildOrphanedRunInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** 工作项标题；`null` = 拿不到 ⇒ 回落 `workItemId`。 */
  workItemTitle: string | null;
  runId: string;
  agentId: string;
  sessionId: string | null;
  /** 和解原因原文（与同处 `failMemberRun` 用的那句**同一份来源**）。 */
  reason: string;
}): InboxItemInput {
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "run_orphaned",
    dedupKey: computeInboxDedupKey({ kind: "run_orphaned", runId: input.runId }),
    title: input.workItemTitle ?? input.workItemId,
    detail: {
      workItemId: input.workItemId,
      runId: input.runId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      reason: input.reason,
    },
    workItemId: input.workItemId,
    runId: input.runId,
  };
}

/**
 * 宿主活着、run 卡住（W1 看门狗的留痕出口）：`run_stalled` / `attention`。
 *
 * 与 `buildOrphanedRunInboxItem` 的分界：`run_orphaned` = 宿主已消失（跨重启和解，没有东西会再推进
 * 它）；本构建件 = 宿主活着而这条 run 停在原地（探测死会话 / TTL / 探测不可得 / C1 领地 skip 的
 * 首见留痕）—— 处置动作不同（前者等人清理残留，后者要人看会话/调阈值/查 C1 的自愈回路）。
 *
 * `sessionId` 允许 `null`（无会话的队长行 / 探测不可得的队员行）；`reason` 用**结算码或判定原文**
 * （看门狗族码值单源在 `squadRunRepo.ts`）。`title` 拿不到工作项标题时回落 `workItemId`（同前三个构建件）。
 */
export function buildRunStalledInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** 工作项标题；`null` = 拿不到 ⇒ 回落 `workItemId`。 */
  workItemTitle: string | null;
  runId: string;
  agentId: string;
  sessionId: string | null;
  /** 判定原因原文（看门狗族的码值 / C1 领地的 c1Case）。 */
  reason: string;
}): InboxItemInput {
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "run_stalled",
    dedupKey: computeInboxDedupKey({ kind: "run_stalled", runId: input.runId }),
    title: input.workItemTitle ?? input.workItemId,
    detail: {
      workItemId: input.workItemId,
      runId: input.runId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      reason: input.reason,
    },
    workItemId: input.workItemId,
    runId: input.runId,
  };
}

/**
 * `planDispatch` 的 skip（指派给人 / 小队不存在 / 已归档 / 已停用）：`dispatch_skipped` / `info`。
 *
 * `reason` **必须用事件原文**（`inbox.notified` 的 `reason` 字段）：去重键含它，
 * 改写成别的文案会让「同事实」判不出来（详见 `computeInboxDedupKey`）。
 * `title` 拿不到工作项标题时回落 `workItemId`（同前）。
 */
export function buildDispatchSkippedInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** 工作项标题；`null` = 拿不到 ⇒ 回落 `workItemId`。 */
  workItemTitle: string | null;
  /** `inbox.notified` 事件的 reason 原文。 */
  reason: string;
}): InboxItemInput {
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "dispatch_skipped",
    dedupKey: computeInboxDedupKey({
      kind: "dispatch_skipped",
      workItemId: input.workItemId,
      reason: input.reason,
    }),
    title: input.workItemTitle ?? input.workItemId,
    detail: {
      workItemId: input.workItemId,
      reason: input.reason,
    },
    workItemId: input.workItemId,
  };
}

/**
 * pr-gate 收尾**降级为本地收尾**（#8 D3）：`pr_gate_degraded` / `attention`。
 *
 * 与 `dispatch_skipped` 的分界：那个是「这条派发没发生」（没有东西被改变）；本构建件是
 * 「**批次已按本地形态收尾**，但用户选的是 pr-gate」—— 有真实产出落地，只是没走用户选的那条路。
 * 三条码值（`SQUAD_PR_GATE_DEGRADE_CODES`）分别对应三档前置不满足；`reason` 是给人看的原文。
 * `title` 拿不到父项标题时回落 id（同前几个构建件）。
 */
export function buildPrGateDegradedInboxItem(input: {
  workspaceKey: string;
  workspacePath: string;
  parentWorkItemId: string;
  /** 父项标题；`null` = 拿不到 ⇒ 回落 `parentWorkItemId`。 */
  parentTitle: string | null;
  code: SquadPrGateDegradeCode;
  /** 降级原因原文（发布面给的哪一句，原样带出 —— 不在这里改写成另一套说法）。 */
  reason: string;
  integrationBranch: string;
  targetBranch: string;
}): InboxItemInput {
  return {
    workspaceKey: input.workspaceKey,
    workspacePath: input.workspacePath,
    kind: "pr_gate_degraded",
    dedupKey: computeInboxDedupKey({
      kind: "pr_gate_degraded",
      parentWorkItemId: input.parentWorkItemId,
      code: input.code,
    }),
    title: input.parentTitle ?? input.parentWorkItemId,
    detail: {
      parentWorkItemId: input.parentWorkItemId,
      code: input.code,
      reason: input.reason,
      integrationBranch: input.integrationBranch,
      targetBranch: input.targetBranch,
    },
    workItemId: input.parentWorkItemId,
  };
}
