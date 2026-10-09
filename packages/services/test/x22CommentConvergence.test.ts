/* X2.2 评论回执收敛（实现者轮）：§5.2 源头修 + 未收敛 receipt 的存储/服务读口。

   本文件的期望值取**契约面**（receipt 七值闭集、义务表唯一键语义、并入明细表），
   不读实现中间量：
   ① 同 (workspace, workItem, agent) 第二条评论并入既存义务 ⇒ 该 receipt 落**终局 coalesced**
      （detail.coalescedInto = 既存义务 runId）+ 并入留痕 —— 与排队分支 recordCoalescedRequest 同语义
      （B-3 合并键已定「同键合并 = 一次执行」）。修复前它停在 deferred 且义务表无承载（永停未收敛）。
   ② 未收敛 receipt 的 workspace 级读口（X2.2 新增）：只回 pending/deferred、按 workspace 隔离、
      时间线序 —— host 的补投扫描据此取数。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CommentService } from "../src/workitem/commentService.js";
import type { SquadDispatchRequest } from "../src/workitem/squadDispatchRequests.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

const WS = "x22-ws";
const WSP = "/tmp/x22-ws";
const AGENT = "x22-agent";
const CLOCK = 971_000;
const HUMAN: AuthorRef = { kind: "human", id: "x22-human", displayName: "人" };

function harness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const published: SquadDispatchRequest[] = [];
  const deferred = createSquadDeferredDispatchRepo(db);
  const runs = createSquadRunRepo(db);
  const service: CommentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs,
    deferred,
    workItems,
    roster: { listAgents: () => [{ id: AGENT, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => "x22-gen",
  });
  workItems.insert({
    id: "x22-wi",
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "回执收敛",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  });
  const post = (id: string) =>
    service.createComment({
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: "x22-wi",
      id,
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "@Ann 看一下",
    });
  const keyOf = (commentId: string) =>
    computeCommentDispatchKey({
      workspaceKey: WS,
      workItemId: "x22-wi",
      targetAgentId: AGENT,
      commentId,
    });
  return { db, receipts, published, deferred, runs, post, keyOf };
}

function insertActiveRun(runs: ReturnType<typeof createSquadRunRepo>, runId: string): void {
  runs.insert({
    runId,
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "x22-wi",
    parentWorkItemId: "x22-wi",
    agentId: AGENT,
    isLeaderTask: false,
    branch: `squad/member/${runId}`,
    dirName: runId,
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
}

test("X2.2 §5.2 源头修：同对第二条评论并入既存义务 ⇒ receipt 终局 coalesced + coalescedInto + 并入留痕", () => {
  const h = harness();
  // 目标对已有活跃 run（占树）⇒ 队列状态窗落 deferred 并登记义务（第一条）。
  insertActiveRun(h.runs, "x22-active");
  const first = h.post("x22-c1");
  const k1 = h.keyOf("x22-c1");
  assert.equal(first.dispatches[0]?.outcome, "deferred", "第一条：活跃 run ⇒ deferred 义务");
  assert.deepEqual(
    h.deferred.list(WS).map((row) => row.runId),
    [k1],
    "义务 id = 请求身份",
  );

  // 第二条评论：同 (workspace, workItem, agent) 已有义务 ⇒ insertIfAbsent 返回 false。
  // 契约（B-3 同键合并 = 一次执行）：终局 coalesced + coalescedInto 指向既存义务 + 并入留痕。
  const second = h.post("x22-c2");
  const k2 = h.keyOf("x22-c2");
  assert.notEqual(k2, k1, "两条评论是两个请求身份");
  assert.deepEqual(second.dispatches, [
    {
      targetAgentId: AGENT,
      source: "mention_agent",
      outcome: "coalesced",
      detail: { triggerSource: "mention_agent", coalescedInto: k1 },
    },
  ]);
  assert.equal(h.receipts.get(k2)!.outcome, "coalesced", "首写结论即事实：receipt 落终局");
  assert.deepEqual(h.receipts.get(k2)!.detail, {
    triggerSource: "mention_agent",
    coalescedInto: k1,
  });
  // 义务表不因并入新增（并入 = 执行归既存义务，不另立一条）。
  assert.deepEqual(
    h.deferred.list(WS).map((row) => row.runId),
    [k1],
    "并入不得新增义务行（同键唯一）",
  );
  // 并入留痕（与排队分支 recordCoalescedRequest 同语义同表）。
  const coalescedDetails = (
    h.db
      .prepare("SELECT request_run_id, target_run_id FROM squad_run_coalesced_details")
      .all() as Array<{ request_run_id: string; target_run_id: string }>
  ).map((row) => ({ request_run_id: row.request_run_id, target_run_id: row.target_run_id }));
  assert.deepEqual(coalescedDetails, [{ request_run_id: k2, target_run_id: k1 }]);
  // 终局不可被迟到的重投覆写（收窄到未收敛两值才可认领）。
  assert.equal(
    h.receipts.settleIfUnsettled({ dispatchKey: k2, outcome: "opened", updatedAt: CLOCK + 1 }),
    false,
    "coalesced 是终局：后续回写不得覆写",
  );
  // deferred/coalesced 都不外发（只有 pending 外发）。
  assert.deepEqual(h.published, [], "两条都不外发：等待义务重放，不得重复执行");
});

/* ---------- ② 未收敛 receipt 的 workspace 级读口（X2.2 补投扫描的取数面） ---------- */

test("X2.2 读口：listUnsettledByWorkspace 只回本 workspace 的 pending/deferred，时间线序", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createCommentDispatchReceiptRepo(db);
  const seed = (
    dispatchKey: string,
    workspaceKey: string,
    outcome: string,
    createdAt: number,
  ): void => {
    repo.insertIfAbsent({
      dispatchKey,
      workspaceKey,
      workItemId: "x22-lw",
      targetAgentId: AGENT,
      commentId: "x22-lc",
      threadId: "x22-lc",
      source: "mention_agent",
      outcome: outcome as never,
      createdAt,
    });
  };
  // 两个 workspace、七值全量：只有本 workspace 的 pending/deferred 该被读回。
  seed("k-a1", WS, "pending", 30);
  seed("k-a2", WS, "deferred", 10);
  seed("k-a3", WS, "opened", 20);
  seed("k-a4", WS, "queued", 40);
  seed("k-a5", WS, "coalesced", 50);
  seed("k-a6", WS, "blocked", 60);
  seed("k-a7", WS, "failed", 70);
  seed("k-b1", "x22-other-ws", "pending", 5);

  const rows = repo.listUnsettledByWorkspace(WS);
  assert.deepEqual(
    rows.map((row) => [row.dispatchKey, row.outcome]),
    [
      ["k-a2", "deferred"],
      ["k-a1", "pending"],
    ],
    "只回未收敛两值，且按 created_at ASC（再 dispatch_key ASC）——时间线序",
  );
  assert.equal(rows[0]!.workspaceKey, WS, "identity 列原样读回");
  assert.equal(rows[0]!.targetAgentId, AGENT);
  assert.deepEqual(repo.listUnsettledByWorkspace("x22-empty-ws"), [], "无未收敛 ⇒ 空数组");
});

test("X2.2 服务面：listUnsettledCommentDispatchReceipts 经服务实例读未收敛行（workspace 隔离）", async () => {
  const { createSquadRuntime } = await import("../src/workitem/squadRuntime.js");
  const { createSquadRuntimeService } = await import("../src/workitem/squadRuntimeService.js");
  const { makeRepo } = await import("./helpers/gitFixture.js");
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  const service = createSquadRuntimeService({
    createRuntime: async () => runtime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不触及归档转交");
    },
    getCommentDispatchReceiptRepo: () => receipts,
  });
  const seed = (dispatchKey: string, workspaceKey: string, outcome: string, createdAt: number) =>
    receipts.insertIfAbsent({
      dispatchKey,
      workspaceKey,
      workItemId: "x22-wi",
      targetAgentId: AGENT,
      commentId: "x22-c",
      threadId: "x22-c",
      source: "mention_agent",
      outcome: outcome as never,
      createdAt,
    });
  seed("sv-pending", WS, "pending", 2);
  seed("sv-deferred", WS, "deferred", 1);
  seed("sv-opened", WS, "opened", 3);
  seed("sv-other", "x22-other-ws", "pending", 4);

  const rows = await service.listUnsettledCommentDispatchReceipts({ path: repoRoot, identity: WS });
  assert.deepEqual(
    rows.map((row) => [row.dispatchKey, row.outcome]),
    [
      ["sv-deferred", "deferred"],
      ["sv-pending", "pending"],
    ],
    "未收敛读口：只回本 workspace 的 pending/deferred，时间线序；异己 workspace 不串台",
  );
});
