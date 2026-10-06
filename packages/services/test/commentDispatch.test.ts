/* 协作域 X2.1：评论派发接入 host 执行层的**服务面/存储面**用例。
   host 执行体（runSquadDispatch / 重放回路）在 desktop 侧，由 desktop 用例覆盖；本文件钉的是
   服务面契约（接线的那一半）：

   ① CommentService 的评论派发请求出口（`publishDispatchRequest`）：**只有 pending 请求**外发
      —— 队列状态窗已收敛的格（queued/coalesced/deferred/blocked）不得再触发一次执行；
   ② 成因闭集扩展：`DISPATCH_CAUSES` 含 `comment`（§5.2 明文「评论成因必须另行扩展」）；
   ③ deferred 义务来源由调用方声明（评论通道 `origin: "comment"`），默认仍是 R2 的 `reassign`；
   ④ 服务面 receipt 读/回写口（host 评论派发通道的取数与落定面）。

   断言取契约字面量（dispatchKey 由 `computeCommentDispatchKey` 独立构造、origin 闭集值、
   receipt 七值闭集），不读实现的中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CommentService } from "../src/workitem/commentService.js";
import { DISPATCH_CAUSES, type SquadDispatchRequest } from "../src/workitem/squadDispatchRequests.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo, type WorkItemRepo } from "../src/workitem/workItemRepo.js";

const WS = "cd-ws";
const WSP = "/tmp/cd-ws";
const HUMAN: AuthorRef = { kind: "human", id: "cd-human", displayName: "人" };
const ANN = "cd-ann";
const BOB = "cd-bob";
const CLOCK = 881_000;

function harness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db) as WorkItemRepo;
  const published: SquadDispatchRequest[] = [];
  const service: CommentService = createCommentService({
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs,
    deferred,
    workItems,
    roster: {
      listAgents: () => [
        { id: ANN, name: "Ann" },
        { id: BOB, name: "Bob" },
      ],
      listSquads: () => [],
    },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => "cd-gen",
  });
  const itemId = "cd-wi";
  workItems.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "评论派发",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: ANN },
    labels: [],
    properties: {},
    position: 0,
  });
  return { db, receipts, runs, deferred, workItems, service, published, itemId };
}

/* ---------- ① 评论派发请求出口（pending 才外发） ---------- */

test("X2.1 出口：pending 的评论请求外发一条（kind=comment、身份=dispatchKey、目标=点名者）", () => {
  const h = harness();
  const result = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: h.itemId,
    id: "cd-c1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Bob 看一下",
  });
  assert.equal(result.dispatches[0]?.outcome, "pending");
  const key = computeCommentDispatchKey({
    workspaceKey: WS,
    workItemId: h.itemId,
    targetAgentId: BOB,
    commentId: "cd-c1",
  });
  assert.deepEqual(h.published, [
    {
      kind: "comment",
      cause: "comment",
      workItemId: h.itemId,
      dispatchKey: key,
      targetAgentId: BOB,
      workspacePath: WSP,
      workspaceIdentity: WS,
    },
  ]);
});

test("X2.1 出口：队列状态窗已收敛的格不重发执行（deferred / suppressed 都不外发）", () => {
  const h = harness();
  // 活跃 run 占树 ⇒ 评论落 deferred（义务通道负责重放，在线入口不得再发一次）。
  h.runs.insert({
    runId: "cd-active",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: h.itemId,
    parentWorkItemId: h.itemId,
    agentId: ANN,
    isLeaderTask: false,
    branch: "squad/member/x",
    dirName: "x",
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  const deferred = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: h.itemId,
    id: "cd-c2",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 帮忙",
  });
  assert.equal(deferred.dispatches[0]?.outcome, "deferred");
  // @all 抑制：无目标、不产生任何请求。
  const suppressed = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: h.itemId,
    id: "cd-c3",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@all 通知一下",
  });
  assert.deepEqual(suppressed.dispatches, []);
  assert.deepEqual(h.published, [], "非 pending 的格一律不进入 host 执行入口");
});

/* ---------- ② 成因闭集扩展（§5.2：评论成因必须另行扩展） ---------- */

test("X2.1 成因：DISPATCH_CAUSES 含 comment（评论不得伪装成 user_reassign）", () => {
  assert.ok(
    (DISPATCH_CAUSES as readonly string[]).includes("comment"),
    "派发成因闭集必须扩展出 comment（§5.2 明文：评论成因另行扩展）",
  );
});

/* ---------- ③ deferred 义务来源由调用方声明 ---------- */

test("X2.1 义务来源：评论通道声明 origin=comment；R2 路径缺省仍是 reassign", async () => {
  const h = harness();
  const { createSquadRuntime } = await import("../src/workitem/squadRuntime.js");
  const { makeRepo } = await import("./helpers/gitFixture.js");
  const repoRoot = await makeRepo();
  const runtime = await createSquadRuntime({
    db: h.db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  // 真名册（上限 1）：R2 的 deferred 支路只在「该 agent 在名册里」时生效（A5：名册缺席不设限）。
  const agent = runtime.teamAgentService.create({
    name: "Ann",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const item = runtime.workItemService.create({
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "义务来源",
    body: "",
    assignee: { type: "agent", id: agent.id },
  });
  const open = (runId: string, origin?: "reassign" | "comment") =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: item.id,
      parentWorkItemId: item.id,
      agentId: agent.id,
      isLeaderTask: false,
      ...(origin !== undefined ? { origin } : {}),
    });
  assert.equal((await open("cd-occupy")).kind, "opened");
  // 缺省（既有 R2 写入方）：reassign —— 行为不变。
  assert.equal((await open("cd-r2")).kind, "deferred");
  assert.equal(runtime.squadDeferredDispatchRepo.list(WS)[0]?.origin, "reassign");
  runtime.squadDeferredDispatchRepo.fulfill(WS, item.id, agent.id);
  // 评论通道显式声明：comment（分流位是调用方给的事实，不在生命周期层反推）。
  assert.equal((await open("cd-comment", "comment")).kind, "deferred");
  assert.equal(runtime.squadDeferredDispatchRepo.list(WS)[0]?.origin, "comment");
});

/* ---------- ④ 服务面 receipt 取数/回写口（host 评论派发通道的落定面） ---------- */

test("X2.1 服务面：receipt 读口与条件回写口（终局不覆写、异 workspace 不串台）", async () => {
  const { createSquadRuntime } = await import("../src/workitem/squadRuntime.js");
  const { createSquadRuntimeService } = await import("../src/workitem/squadRuntimeService.js");
  const { createSquadOrchestrator } = await import("../src/workitem/squadOrchestrator.js");
  const { archiveSquadAndTransfer } = await import("../src/workitem/squadRuntime.js");
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
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await Promise.resolve(runtime), id),
    createOrchestrator: createSquadOrchestrator,
    getCommentDispatchReceiptRepo: () => receipts,
  });
  const target = { path: repoRoot, identity: WS };
  receipts.insertIfAbsent({
    dispatchKey: "cd-svc-1",
    workspaceKey: WS,
    workItemId: "cd-wi-x",
    targetAgentId: BOB,
    commentId: "cd-c9",
    threadId: "cd-c9",
    source: "mention_agent",
    outcome: "pending",
    detail: { triggerSource: "mention_agent" },
    createdAt: 1,
  });
  const read = await service.getCommentDispatchReceipt(target, "cd-svc-1");
  assert.equal(read?.targetAgentId, BOB);
  assert.equal(read?.outcome, "pending");
  // 回写：pending ⇒ opened 认领成功；detail 原样落回；attempt_count 递增。
  assert.equal(
    await service.settleCommentDispatchReceipt(target, {
      dispatchKey: "cd-svc-1",
      outcome: "opened",
      detail: { triggerSource: "mention_agent", runId: "cd-svc-1" },
    }),
    true,
  );
  const settled = await service.getCommentDispatchReceipt(target, "cd-svc-1");
  assert.equal(settled?.outcome, "opened");
  assert.deepEqual(settled?.detail, { triggerSource: "mention_agent", runId: "cd-svc-1" });
  assert.equal(settled?.attemptCount, 2, "首写算第一次尝试，回写即第二次");
  // 终局不覆写（第二条重投路径只能拿 false，据此留痕）。
  assert.equal(
    await service.settleCommentDispatchReceipt(target, {
      dispatchKey: "cd-svc-1",
      outcome: "failed",
    }),
    false,
  );
  // 未命中 ⇒ null / false（不造行、不静默成功）。
  assert.equal(await service.getCommentDispatchReceipt(target, "cd-none"), null);
  assert.equal(
    await service.settleCommentDispatchReceipt(target, { dispatchKey: "cd-none", outcome: "failed" }),
    false,
  );
});
