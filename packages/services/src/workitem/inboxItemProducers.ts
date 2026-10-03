import type { InboxItemInput } from "./inboxItemRepo.js";

/* 四个产生点的**纯构建件**（spec §5.7.4 冲突 / §6.2 队员失败 / §6.6 启动和解 / §3.9 四条 skip）。

   为什么单独一个文件、且**纯函数**（不碰 IO、不 import node 侧）：
   1. **dedupKey 的唯一形状**在这里（`computeInboxDedupKey`）：产生点各拼一份串，拼错了不报错，
      只会表现成「同一件事反复出现在收件箱里」或「两件事被当成一件」；
   2. `title` / `detail` 的组成规则只有一处：四个产生点只回答「事实是什么」，
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
  | { kind: "dispatch_skipped"; workItemId: string; reason: string };

export function computeInboxDedupKey(fact: InboxDedupFact): string {
  switch (fact.kind) {
    case "merge_conflict":
      return `merge_conflict:${fact.parentWorkItemId}`;
    case "member_failed":
      return `member_failed:${fact.runId}`;
    case "run_orphaned":
      return `run_orphaned:${fact.runId}`;
    case "dispatch_skipped":
      return `dispatch_skipped:${fact.workItemId}:${fact.reason}`;
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
