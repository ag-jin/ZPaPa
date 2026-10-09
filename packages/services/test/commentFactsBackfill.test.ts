import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  backfillMissingCommentFacts,
  type CommentFactsBackfillDeps,
} from "../src/workitem/commentService.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCommentRepo,
  type AddWorkItemCommentInput,
  type AuthorRef,
} from "../src/workitem/workItemCommentRepo.js";

/* 协作域 G7（§8.4-3）：半途事务扫描补写 —— 崩溃残留回收路径。
   §8.4-3 原文：「扫描缺失关联 Activity 的半成品事务，只允许补写缺失的派生 Activity，不重复 Comment」。
   G8 显式事务把**新**的窗口关掉了，本函数兜的是库里**已经**落下的半条事实（G8 之前的崩溃残留、
   以及未来任何绕过事务的写入面）。

   夹具构造的是**崩溃现场本身**：直接经 repo 写评论行 / receipt 行（= 事实已落库、派生投影没写），
   不经过 createComment —— 那正是「写到一半崩」在库里的样子。

   seam：`backfillMissingCommentFacts(deps, workspaceKey)` 的入参**只有** comments / activities / receipts
   三个读面（类型上拿不到 runs / 义务 / 名册 / 外发口）——「只补缺、只写 Activity、不重跑队列状态窗」
   因此不是纪律，而是依赖图上的不可能；用例从**库**上断言（裸 SQL 行数 + repo 读回）。 */

const HUMAN: AuthorRef = { kind: "human", id: "local-user" };
const WS = { key: "ws-bf", path: "/tmp/ws-bf" };

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runs = createSquadRunRepo(db);
  const deps: CommentFactsBackfillDeps = { comments, activities, receipts };
  return { db, comments, activities, receipts, runs, deps };
}

const commentInput = (over: Partial<AddWorkItemCommentInput> = {}): AddWorkItemCommentInput => ({
  id: "c-1",
  workspaceKey: WS.key,
  workspacePath: WS.path,
  workItemId: "wi-1",
  author: HUMAN,
  initiatedBy: HUMAN,
  body: "原文",
  normalizedBody: "原文",
  mentions: [],
  createdAt: 100,
  ...over,
});

/** 裸 SQL 行数：断言不消费服务返回的包装形状。 */
function tableCounts(db: DatabaseSync): Record<string, number> {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    comments: count("work_item_comments"),
    activities: count("work_item_activities"),
    receipts: count("comment_dispatch_receipts"),
    runs: count("squad_runs"),
  };
}

/** 整表快照（逐行逐列）：证「扫描没碰这张表」时比行数强 —— 改写一行不增行数。 */
function snapshot(db: DatabaseSync, table: string): string {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

test("补写①｜有评论无 Activity ⇒ 重放同 id/dedupKey 的 comment_created，comments 行数不变", () => {
  const h = setup();
  // 崩溃现场：评论行在、comment_created 不在（repo.add 只写评论行，Activity 归服务层）。
  h.comments.add(
    commentInput({
      id: "c-1",
      createdAt: 100,
      command: "note",
      sourceRun: { runId: "r-1", role: "member", agentId: "ta-a" },
      mentions: [{ type: "agent", id: "ta-a" }],
    }),
  );
  assert.deepEqual(tableCounts(h.db), {
    comments: 1,
    activities: 0,
    receipts: 0,
    runs: 0,
  });

  const report = backfillMissingCommentFacts(h.deps, WS.key);

  const rows = h.activities.listByWorkItem(WS.key, "wi-1");
  assert.equal(
    rows.length,
    1,
    "只补 comment_created 一枚（mention_parsed 不在 §8.4-3 的补写范围）",
  );
  const created = rows[0]!;
  assert.equal(created.id, "activity-c-1-created");
  assert.equal(created.dedupKey, "comment:c-1:created");
  assert.equal(created.kind, "comment_created");
  assert.equal(created.commentId, "c-1");
  assert.deepEqual(created.actor, HUMAN);
  assert.deepEqual(created.initiatedBy, HUMAN);
  assert.deepEqual(created.sourceRun, { runId: "r-1", agentId: "ta-a", role: "member" });
  assert.deepEqual(created.payload, { command: "note", parentCommentId: null });
  assert.equal(created.occurredAt, 100, "occurredAt 取已持久事实的时刻（评论 created_at）");
  assert.equal(created.createdAt, 100);

  assert.deepEqual(
    tableCounts(h.db),
    { comments: 1, activities: 1, receipts: 0, runs: 0 },
    "红线：绝不重复 Comment（comments 行数不变），也不臆造别的投影",
  );
  assert.deepEqual(report, {
    scannedComments: 1,
    scannedReceipts: 0,
    replayedCommentActivities: 1,
    replayedDispatchActivities: 0,
  });
});

test("补写②｜有 receipt 无派发投影 ⇒ 从已持久事实投影 requested/suppressed，不重跑队列状态窗", () => {
  const h = setup();
  // 现场：评论 c-2 有三条 receipt（pending / opened / blocked），c-3 只有一条 blocked。
  h.comments.add(commentInput({ id: "c-2", createdAt: 200 }));
  h.comments.add(commentInput({ id: "c-3", createdAt: 300 }));
  const receipt = (
    dispatchKey: string,
    over: Partial<Parameters<typeof h.receipts.insertIfAbsent>[0]> = {},
  ): void => {
    void h.receipts.insertIfAbsent({
      dispatchKey,
      workspaceKey: WS.key,
      workItemId: "wi-1",
      targetAgentId: "ta-a",
      commentId: "c-2",
      threadId: "c-2",
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
      createdAt: 200,
      ...over,
    });
  };
  receipt("cd-1");
  receipt("cd-2", {
    targetAgentId: "ta-b",
    source: "issue_assignee",
    outcome: "opened",
    detail: { triggerSource: "issue_assignee", runId: "run-1" },
    createdAt: 201,
  });
  receipt("cd-3", {
    targetAgentId: "ta-c",
    source: "mention_squad_leader",
    outcome: "blocked",
    detail: { triggerSource: "mention_squad_leader", reason: "work_item_archived" },
    createdAt: 202,
  });
  receipt("cd-4", {
    commentId: "c-3",
    threadId: "c-3",
    targetAgentId: "ta-d",
    outcome: "blocked",
    detail: { triggerSource: "mention_agent", reason: "dispatch_disabled" },
    createdAt: 300,
  });
  /* 窗口对照：cd-1 的目标此刻**有**一条排队 run。若扫描重跑队列状态窗，投影会写成 queued；
     从已持久事实投影则恒为 receipt 自己写下的 pending（首写即事实）。 */
  h.runs.insert({
    runId: "queued-ta-a",
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: "ta-a",
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "queued",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 250,
    updatedAt: 250,
  });
  const receiptsBefore = snapshot(h.db, "comment_dispatch_receipts");
  const runsBefore = snapshot(h.db, "squad_runs");

  const report = backfillMissingCommentFacts(h.deps, WS.key);

  const rows = h.activities.listByWorkItem(WS.key, "wi-1");
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "activity-c-2-created",
      "activity-c-3-created",
      "activity-c-2-requested",
      "activity-c-2-dispatch-suppressed",
      "activity-c-3-dispatch-suppressed",
    ],
    "两条扫描各就各位：先补 created（按评论时间线），再补派发投影（按 receipt 时间线）",
  );
  const requested = rows.find((row) => row.id === "activity-c-2-requested")!;
  assert.equal(requested.dedupKey, "comment:c-2:dispatch_requested");
  assert.equal(requested.kind, "comment_dispatch_requested");
  assert.equal(requested.commentId, "c-2");
  assert.equal(requested.occurredAt, 200, "occurredAt 取参与 receipt 的最早 created_at");
  assert.deepEqual(requested.payload, {
    targets: [
      {
        targetAgentId: "ta-a",
        source: "mention_agent",
        outcome: "pending",
        detail: { triggerSource: "mention_agent" },
      },
      {
        targetAgentId: "ta-b",
        source: "issue_assignee",
        outcome: "opened",
        detail: { triggerSource: "issue_assignee", runId: "run-1" },
      },
      {
        targetAgentId: "ta-c",
        source: "mention_squad_leader",
        outcome: "blocked",
        detail: { triggerSource: "mention_squad_leader", reason: "work_item_archived" },
      },
    ],
  });
  assert.equal(
    (requested.payload["targets"] as Array<{ outcome: string }>)[0]!.outcome,
    "pending",
    "排队 run 已在库也不改判：投影只抄 receipt 已写下的裁决结论",
  );
  const suppressed = rows.find((row) => row.id === "activity-c-2-dispatch-suppressed")!;
  assert.equal(suppressed.dedupKey, "comment:c-2:dispatch_suppressed");
  assert.equal(suppressed.kind, "comment_dispatch_suppressed");
  assert.equal(suppressed.occurredAt, 202);
  assert.deepEqual(suppressed.payload, {
    reason: "blocked",
    blocked: [
      { targetAgentId: "ta-c", source: "mention_squad_leader", reason: "work_item_archived" },
    ],
  });
  assert.deepEqual(
    rows.find((row) => row.id === "activity-c-3-dispatch-suppressed")!.payload,
    {
      reason: "blocked",
      blocked: [{ targetAgentId: "ta-d", source: "mention_agent", reason: "dispatch_disabled" }],
    },
    "全 blocked 的评论只有抑制投影、没有 requested（与写侧同一判据）",
  );
  assert.equal(
    rows.length,
    5,
    "c-3 无 requested 投影：五枚 = 2 created + 2 requested/suppressed(c-2) + 1 suppressed(c-3)",
  );

  assert.equal(snapshot(h.db, "comment_dispatch_receipts"), receiptsBefore, "receipt 一字不动");
  assert.equal(snapshot(h.db, "squad_runs"), runsBefore, "扫描不建 run、不推队列");
  assert.deepEqual(report, {
    scannedComments: 2,
    scannedReceipts: 4,
    replayedCommentActivities: 2,
    replayedDispatchActivities: 3,
  });
});

test("幂等｜连跑两次 ⇒ 第二次零新增、两类投影逐行不变（幂等键唯一索引兜底）", () => {
  const h = setup();
  h.comments.add(commentInput({ id: "c-1", createdAt: 100 }));
  h.receipts.insertIfAbsent({
    dispatchKey: "cd-1",
    workspaceKey: WS.key,
    workItemId: "wi-1",
    targetAgentId: "ta-a",
    commentId: "c-1",
    threadId: "c-1",
    source: "mention_agent",
    outcome: "pending",
    detail: { triggerSource: "mention_agent" },
    createdAt: 100,
  });

  const first = backfillMissingCommentFacts(h.deps, WS.key);
  const after = snapshot(h.db, "work_item_activities");
  const second = backfillMissingCommentFacts(h.deps, WS.key);

  assert.deepEqual(second, {
    scannedComments: 1,
    scannedReceipts: 1,
    replayedCommentActivities: 0,
    replayedDispatchActivities: 0,
  });
  assert.equal(
    snapshot(h.db, "work_item_activities"),
    after,
    "第二次逐行不变（不是「行数恰好相同」）",
  );
  assert.deepEqual(tableCounts(h.db), { comments: 1, activities: 2, receipts: 1, runs: 0 });
  assert.equal(first.replayedCommentActivities + first.replayedDispatchActivities, 2);
});

test("边界｜receipt 指向的评论行不存在 ⇒ 响亮抛（不静默造一条无归属的投影）", () => {
  const h = setup();
  h.receipts.insertIfAbsent({
    dispatchKey: "cd-orphan",
    workspaceKey: WS.key,
    workItemId: "wi-1",
    targetAgentId: "ta-a",
    commentId: "c-不存在",
    threadId: "c-不存在",
    source: "mention_agent",
    outcome: "pending",
    detail: { triggerSource: "mention_agent" },
    createdAt: 100,
  });

  assert.throws(
    () => backfillMissingCommentFacts(h.deps, WS.key),
    /c-不存在/,
    "投影缺了 actor/initiatedBy 的出处：读不到评论就抛，绝不猜一个作者写进审计列",
  );
  assert.deepEqual(tableCounts(h.db).activities, 0);
});

test("隔离｜只动本 workspace：异己 workspace 的缺行不被补、也不被读串", () => {
  const h = setup();
  h.comments.add(commentInput({ id: "c-mine", workspaceKey: WS.key }));
  h.comments.add(
    commentInput({ id: "c-theirs", workspaceKey: "ws-other", workspacePath: "/tmp/ws-other" }),
  );

  const report = backfillMissingCommentFacts(h.deps, WS.key);

  assert.deepEqual(
    h.activities.listByWorkItem(WS.key, "wi-1").map((row) => row.commentId),
    ["c-mine"],
  );
  assert.deepEqual(h.activities.listByWorkItem("ws-other", "wi-1"), [], "异己 workspace 一行不动");
  assert.equal(report.scannedComments, 1);
});
