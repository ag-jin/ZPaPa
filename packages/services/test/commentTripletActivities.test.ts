/* 协作域 X1.3 修复轮（B1/B3 阻塞项）：三件套（软删 / 线程解决态 / 表情回应）的**写入口**验收。
   X1.3 独立验收发现三枚 kind（comment_deleted / comment_resolved / comment_reaction_added）
   只有枚举声明、全仓零写者（报告 §3）。本文件钉住 CommentService 的三个编排方法：
   每枚动作既落存储事实，也落一条 Activity（spec §3.2）；且**永不触发派发**（§4.4）。

   夹具另起一套常量（triplet-* / tr-*），不复用 X1.2（commentService.test.ts）与
   X1.3（commentTriggerMatrix.test.ts）的中间假设；断言期望值只取规格字面量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

const WS = "triplet-ws";
const WSP = "/tmp/triplet-ws";
const HUMAN: AuthorRef = { kind: "human", id: "tr-human", displayName: "人" };
const ANN = "tr-ann";
const CLOCK = 960_000;

type Harness = ReturnType<typeof tripletHarness>;

function tripletHarness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db);
  let seq = 0;
  const service = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems,
    roster: {
      listAgents: () => [{ id: ANN, name: "Ann" }],
      listSquads: () => [],
    },
    readDispatchEnabled: () => true,
    now: () => CLOCK,
    newId: () => `tr-gen-${++seq}`,
  });
  return { db, comments, activities, receipts, reactions, runs, deferred, workItems, service };
}

function putItem(
  h: Harness,
  id: string,
  assignee:
    | { type: "user"; id: string }
    | { type: "agent"; id: string }
    | { type: "squad"; id: string } = { type: "user", id: HUMAN.id },
): void {
  h.workItems.insert({
    id,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: `三件套 ${id}`,
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  });
}

function rowCount(h: Harness, table: string): number {
  return (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function kinds(h: Harness, workItemId: string): string[] {
  return h.activities.listByWorkItem(WS, workItemId).map((activity) => activity.kind);
}

/* ---------- B1：软删除 ---------- */

test("B1｜softDeleteComment：墓碑落盘 + comment_deleted Activity（actor/initiatedBy/commentId/dedupKey），重投幂等且零派发", () => {
  const h = tripletHarness();
  putItem(h, "wi-1");
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-1",
    id: "c-root",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "根评论",
  });
  const deleted = h.service.softDeleteComment({
    commentId: "c-root",
    workspaceKey: WS,
    actor: HUMAN,
  });
  assert.ok(deleted.deletedAt !== null, "软删只置墓碑时间戳");
  assert.equal(deleted.body, "根评论", "正文一字不动");
  assert.deepEqual(deleted.author, HUMAN, "作者一字不动");

  const activity = h.activities
    .listByWorkItem(WS, "wi-1")
    .find((entry) => entry.kind === "comment_deleted");
  assert.ok(activity, "comment_deleted 必须有写者（X1.3 B1）");
  assert.equal(activity.commentId, "c-root");
  assert.deepEqual(activity.actor, HUMAN, "actor = 调用方给的执行者");
  assert.deepEqual(
    activity.initiatedBy,
    { kind: "human", id: HUMAN.id },
    "initiatedBy 缺省同 actor",
  );
  assert.equal(activity.sourceRun, null);
  assert.equal(activity.dedupKey, "comment:c-root:deleted");
  assert.equal(activity.occurredAt, CLOCK);

  // 同评论重复软删：repo 是 no-op，Activity 靠 dedupKey 幂等——不写第二条。
  h.service.softDeleteComment({ commentId: "c-root", workspaceKey: WS, actor: HUMAN });
  assert.equal(
    kinds(h, "wi-1").filter((kind) => kind === "comment_deleted").length,
    1,
    "同事实重投只留一条 Activity（§8.1）",
  );
  // §4.4：软删绝不触发派发。
  assert.equal(rowCount(h, "squad_runs"), 0, "软删不开 run");
  assert.equal(h.receipts.listByWorkItem(WS, "wi-1").length, 0, "软删零 receipt");
  assert.equal(rowCount(h, "squad_run_deferred_dispatches"), 0, "软删零重放义务");
});

/* ---------- B1：线程解决态 ---------- */

test("B1｜setCommentResolved：置/消各写一条 comment_resolved Activity，重复置位幂等且零派发（不影响触发）", () => {
  const h = tripletHarness();
  putItem(h, "wi-2");
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-2",
    id: "c-thread",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "线程根",
  });
  const set = h.service.setCommentResolved({
    commentId: "c-thread",
    workspaceKey: WS,
    resolved: true,
    actor: HUMAN,
  });
  assert.ok(set.resolvedAt !== null, "置位只写 resolvedAt");
  assert.equal(set.body, "线程根", "解决态不影响正文");

  const resolvedActivities = (): ReturnType<typeof h.activities.listByWorkItem> =>
    h.activities.listByWorkItem(WS, "wi-2").filter((entry) => entry.kind === "comment_resolved");
  assert.equal(resolvedActivities().length, 1, "置位写一条 comment_resolved（X1.3 B1）");
  const [setActivity] = resolvedActivities();
  assert.equal(setActivity!.commentId, "c-thread");
  assert.deepEqual(setActivity!.payload, { resolved: true });
  assert.equal(setActivity!.dedupKey, "comment:c-thread:resolved:set");
  assert.deepEqual(setActivity!.actor, HUMAN);
  assert.deepEqual(setActivity!.initiatedBy, { kind: "human", id: HUMAN.id });

  // 取消：第二条 Activity（置/消各一条）。
  const cleared = h.service.setCommentResolved({
    commentId: "c-thread",
    workspaceKey: WS,
    resolved: false,
    actor: HUMAN,
  });
  assert.equal(cleared.resolvedAt, null);
  assert.equal(resolvedActivities().length, 2, "取消写第二条");
  assert.deepEqual(resolvedActivities()[1]!.payload, { resolved: false });
  assert.equal(resolvedActivities()[1]!.dedupKey, "comment:c-thread:resolved:cleared");

  // 重复置位：同状态重投不写第三条（dedupKey 幂等，§8.1）。
  h.service.setCommentResolved({
    commentId: "c-thread",
    workspaceKey: WS,
    resolved: false,
    actor: HUMAN,
  });
  assert.equal(resolvedActivities().length, 2, "同状态重投只留一条");
  // §4.4：解决态不触发派发。
  assert.equal(rowCount(h, "squad_runs"), 0);
  assert.equal(h.receipts.listByWorkItem(WS, "wi-2").length, 0);
});

/* ---------- B1：表情回应 ---------- */

test("B1｜addCommentReaction：回应幂等落盘 + comment_reaction_added Activity；永不触发派发（§4.4）", () => {
  const h = tripletHarness();
  putItem(h, "wi-5", { type: "agent", id: ANN }); // agent 语境项：若被误当评论处理就会派发
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-5",
    id: "c-rx",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "被回应的评论",
  });
  const receiptsBefore = h.receipts.listByWorkItem(WS, "wi-5").length;
  assert.equal(receiptsBefore, 1, "前置：评论本身触发了一次兜底派发请求（对照组）");

  const reaction = h.service.addCommentReaction({
    commentId: "c-rx",
    workspaceKey: WS,
    author: HUMAN,
    emoji: "👍",
  });
  assert.equal(reaction.emoji, "👍");
  assert.equal(reaction.author.kind, "human");
  assert.equal(reaction.author.id, HUMAN.id);
  assert.equal(
    reaction.author.displayName,
    undefined,
    "回应表无展示名列（0010 轻实体）：displayName 不是身份键，身份三位照常读回",
  );
  // 同 (comment, author, emoji) 重投：返回既存行（不产生第二行）。
  const retry = h.service.addCommentReaction({
    commentId: "c-rx",
    workspaceKey: WS,
    author: HUMAN,
    emoji: "👍",
  });
  assert.equal(retry.id, reaction.id, "(commentId, author, emoji) 幂等");
  assert.equal(h.reactions.listByComment("c-rx").length, 1);

  const activity = h.activities
    .listByWorkItem(WS, "wi-5")
    .find((entry) => entry.kind === "comment_reaction_added");
  assert.ok(activity, "comment_reaction_added 必须有写者（X1.3 B1）");
  assert.equal(activity.commentId, "c-rx");
  assert.deepEqual(activity.actor, HUMAN, "actor = 回应作者");
  assert.deepEqual(
    activity.initiatedBy,
    { kind: "human", id: HUMAN.id },
    "initiatedBy 缺省沿回应作者",
  );
  assert.equal(activity.sourceRun, null);
  assert.equal(activity.dedupKey, "reaction:c-rx:human:tr-human:👍");
  assert.deepEqual(activity.payload, { emoji: "👍" });
  // 同键重投不写第二条 Activity。
  assert.equal(kinds(h, "wi-5").filter((kind) => kind === "comment_reaction_added").length, 1);
  // §4.4：表情回应永不触发派发——receipt 计数不变、零新 run、零义务。
  assert.equal(h.receipts.listByWorkItem(WS, "wi-5").length, receiptsBefore, "回应不产生 receipt");
  assert.equal(rowCount(h, "squad_runs"), 0, "回应不开 run");
  assert.equal(rowCount(h, "squad_run_deferred_dispatches"), 0, "回应零重放义务");
});

test("三件套动作前置守卫：不存在的评论 / 跨 workspace 一律响亮拒绝且零事实", () => {
  const h = tripletHarness();
  putItem(h, "wi-6");
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-6",
    id: "c-guard",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "本 workspace 的评论",
  });
  assert.throws(
    () => h.service.softDeleteComment({ commentId: "c-air", workspaceKey: WS, actor: HUMAN }),
    /不存在/,
  );
  assert.throws(
    () =>
      h.service.setCommentResolved({
        commentId: "c-guard",
        workspaceKey: "other-ws",
        resolved: true,
        actor: HUMAN,
      }),
    /跨 workspace/,
  );
  assert.throws(
    () =>
      h.service.addCommentReaction({
        commentId: "c-guard",
        workspaceKey: "other-ws",
        author: HUMAN,
        emoji: "👍",
      }),
    /跨 workspace/,
  );
  // 三者被拒后：状态与事实面零变化。
  assert.equal(h.comments.get("c-guard")!.resolvedAt, null);
  assert.equal(h.comments.get("c-guard")!.deletedAt, null);
  assert.equal(h.reactions.listByComment("c-guard").length, 0);
  assert.deepEqual(kinds(h, "wi-6"), ["comment_created"], "拒绝不写任何 Activity");
});

/* ---------- G4：评论 deferred 义务的来源判别（与 R2 义务同表） ---------- */

test("G4｜评论 deferred 义务 origin='comment'：与 R2 义务同表但可判别（X2.1 据此分流）", () => {
  const h = tripletHarness();
  putItem(h, "wi-7", { type: "agent", id: ANN });
  // 活跃 run 占树（open/produced/rejected 仍在活跃集）⇒ 评论走 deferred 义务。
  h.runs.insert({
    runId: "run-active",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-7",
    parentWorkItemId: "wi-7",
    agentId: ANN,
    isLeaderTask: false,
    branch: "squad/member/x/y",
    dirName: null,
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  const result = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-7",
    id: "c-deferred",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 请处理",
  });
  assert.equal(result.dispatches[0]?.outcome, "deferred");
  const obligations = h.deferred.list(WS);
  assert.equal(obligations.length, 1, "义务 id = 评论请求身份（一行）");
  assert.equal(
    obligations[0]!.origin,
    "comment",
    "评论义务必须带来源判别（G4）：host 不得把它当 eventKey 重放",
  );
  assert.equal(obligations[0]!.dispatchCause, null, "成因闭集未扩展；本轮判别位是 origin");
});

/* ---------- B3：解决态仅线程根（服务层守卫 + repo 层双保险） ---------- */

function postThread(h: Harness, workItemId: string, rootId: string, replyId: string): void {
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId,
    id: rootId,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "线程根",
  });
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId,
    id: replyId,
    parentCommentId: rootId,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "回复",
  });
}

test("B3｜服务层守卫：对回复置解决态响亮拒绝，且不落状态、不写 Activity（仅根，§3.2）", () => {
  const h = tripletHarness();
  putItem(h, "wi-3");
  postThread(h, "wi-3", "c-root3", "c-reply3");
  assert.throws(
    () =>
      h.service.setCommentResolved({
        commentId: "c-reply3",
        workspaceKey: WS,
        resolved: true,
        actor: HUMAN,
      }),
    /解决态仅线程根/,
    "X1.3 B3：回复行不得被置成已解决",
  );
  assert.equal(h.comments.get("c-reply3")!.resolvedAt, null, "拒绝后不落状态");
  assert.equal(
    kinds(h, "wi-3").filter((kind) => kind === "comment_resolved").length,
    0,
    "拒绝后零 Activity（事实面不脏）",
  );
});

test("B3｜repo 层双保险：setResolved 对回复行响亮抛（照 repo 既有响亮纪律，不静默）", () => {
  const h = tripletHarness();
  putItem(h, "wi-4");
  postThread(h, "wi-4", "c-root4", "c-reply4");
  assert.throws(() => h.comments.setResolved("c-reply4", true), /仅根/);
  assert.equal(h.comments.get("c-reply4")!.resolvedAt, null);
  // 根行照常可用（守卫不误伤）。
  h.comments.setResolved("c-root4", true);
  assert.ok(h.comments.get("c-root4")!.resolvedAt !== null);
});
