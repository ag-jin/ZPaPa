/* X2.2 独立复验（test-verifier）：§5.2 源头修的**并入矩阵** + 不可达态响亮抛。

   本文件不复述实现者用例：期望值全部取**契约面**（receipt 七值闭集、义务表唯一键、
   并入留痕表、出口「只发 pending」四条），输入按「队列状态窗三态 × 同对连续三条评论」
   穷举。三条评论是刻意选的：第二条与第三条走同一条「按 (workspace, workItem, agent) 并入」
   分支，但第三次必须并入**第一次**的义务（不得链式并到第二条上——第二条没有义务行）。

   为什么独立写一份：实现者的 x22CommentConvergence 只覆盖「第二条」，第三条的并入目标
   （k1 而不是 k2）与「义务被履行后归自己 deferred」这两个边界没有实体断言 —— 前者错法
   表现为「并入了一条不存在的执行」，后者错法表现为「把新请求误判成并入、永久不执行」。 */
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

const WS = "vx-ws";
const WSP = "/tmp/vx-ws";
const AGENT = "vx-agent";
const OTHER_WS = "vx-other-ws";
const CLOCK = 842_000;
const HUMAN: AuthorRef = { kind: "human", id: "vx-human", displayName: "人" };

type Harness = ReturnType<typeof harness>;

function harness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const published: SquadDispatchRequest[] = [];
  const service: CommentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments,
    activities,
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs,
    deferred,
    workItems,
    roster: { listAgents: () => [{ id: AGENT, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => "vx-gen",
  });
  workItems.insert({
    id: "vx-wi",
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "并入矩阵",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  });
  const key = (commentId: string): string =>
    computeCommentDispatchKey({
      workspaceKey: WS,
      workItemId: "vx-wi",
      targetAgentId: AGENT,
      commentId,
    });
  const post = (commentId: string) =>
    service.createComment({
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: "vx-wi",
      id: commentId,
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "@Ann 看一下",
    });
  /** 该 (workItem, agent) 的活跃 run（占树）——排队/活跃两态各由本函数与 insertQueuedRun 造。 */
  const insertRun = (runId: string, status: "open" | "queued"): void => {
    runs.insert({
      runId,
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: "vx-wi",
      parentWorkItemId: "vx-wi",
      agentId: AGENT,
      isLeaderTask: false,
      branch: status === "queued" ? null : `squad/member/${runId}`,
      dirName: status === "queued" ? null : runId,
      status,
      sessionId: null,
      dispatchCause: null,
      causedByRunId: null,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
  };
  const coalescedRows = (): Array<{ request_run_id: string; target_run_id: string }> =>
    db
      .prepare(
        "SELECT request_run_id, target_run_id FROM squad_run_coalesced_details ORDER BY request_run_id",
      )
      .all() as unknown as Array<{ request_run_id: string; target_run_id: string }>;
  return {
    db,
    receipts,
    comments,
    activities,
    runs,
    deferred,
    published,
    service,
    post,
    key,
    insertRun,
    coalescedRows,
  };
}

/** 三个队列状态（§12.1-1 队列状态窗：无待开/有排队行/有活跃 run）。 */
const STATES = ["idle", "queued", "active"] as const;
type RunState = (typeof STATES)[number];

function seedState(h: Harness, state: RunState): void {
  if (state === "queued") h.insertRun("vx-queued", "queued");
  if (state === "active") h.insertRun("vx-active", "open");
}

test("X2.2 独立矩阵｜无待开（idle）：三条评论各自 pending、各自外发一次，零义务零并入", () => {
  const h = harness();
  seedState(h, "idle");
  for (const id of ["vx-c1", "vx-c2", "vx-c3"]) {
    const result = h.post(id);
    assert.deepEqual(
      result.dispatches,
      [
        {
          targetAgentId: AGENT,
          source: "mention_agent",
          outcome: "pending",
          detail: { triggerSource: "mention_agent" },
        },
      ],
      `${id}：无执行载体 ⇒ pending（请求身份 = 评论 id 派生键）`,
    );
  }
  assert.deepEqual(h.deferred.list(WS), [], "无活跃 run ⇒ 义务表必须为空");
  assert.deepEqual(h.coalescedRows(), [], "pending 不产生并入留痕");
  assert.deepEqual(
    h.published.map((request) => request.dispatchKey),
    [h.key("vx-c1"), h.key("vx-c2"), h.key("vx-c3")],
    "pending 逐条外发（出口只发 pending）",
  );
  // §4.3-1：每条 Comment 原样落库、每条各写自己的 Activity（三件套 × 3）。
  assert.equal(h.comments.listByWorkItem(WS, "vx-wi").length, 3);
  assert.equal(
    h.activities.listByWorkItem(WS, "vx-wi").length,
    9,
    "3 × (created + mention_parsed + requested)",
  );
});

test("X2.2 独立矩阵｜有排队行（queued）：三条全部并入排队行 ⇒ coalesced(targetRunId)，零义务零外发", () => {
  const h = harness();
  seedState(h, "queued");
  for (const id of ["vx-c1", "vx-c2", "vx-c3"]) {
    const result = h.post(id);
    assert.deepEqual(
      result.dispatches,
      [
        {
          targetAgentId: AGENT,
          source: "mention_agent",
          outcome: "coalesced",
          detail: { triggerSource: "mention_agent", targetRunId: "vx-queued" },
        },
      ],
      `${id}：已有待开行 ⇒ 并入（至多一个待开，§12.1-1）`,
    );
    assert.deepEqual(h.receipts.get(h.key(id))!.detail, {
      triggerSource: "mention_agent",
      targetRunId: "vx-queued",
    });
  }
  assert.deepEqual(h.deferred.list(WS), [], "排队态不登记义务（义务等的是活跃集收尾）");
  assert.deepEqual(
    h.coalescedRows().map((row) => [row.request_run_id, row.target_run_id]),
    [
      [h.key("vx-c1"), "vx-queued"],
      [h.key("vx-c2"), "vx-queued"],
      [h.key("vx-c3"), "vx-queued"],
    ],
    "每条请求各自留痕、并入同一排队行",
  );
  assert.deepEqual(h.published, [], "已收敛的请求都不得外发（否则重复执行）");
});

test("X2.2 独立矩阵｜有活跃 run（active）：第一条 deferred + 义务；第二/三条并入**第一条的义务**", () => {
  const h = harness();
  seedState(h, "active");
  const k1 = h.key("vx-c1");
  const k2 = h.key("vx-c2");
  const k3 = h.key("vx-c3");
  assert.notEqual(k2, k3);

  const first = h.post("vx-c1");
  assert.deepEqual(
    first.dispatches,
    [
      {
        targetAgentId: AGENT,
        source: "mention_agent",
        outcome: "deferred",
        detail: { triggerSource: "mention_agent" },
      },
    ],
    "运行中不排队不注入 ⇒ 登记完成重放义务（§12.1-2）",
  );
  assert.deepEqual(
    h.deferred.list(WS).map((row) => [row.runId, row.origin, row.dispatchCause]),
    [[k1, "comment", null]],
    "义务 id = 请求身份；来源 = comment；评论成因未扩展故 cause 为 NULL",
  );

  // 第二条 / 第三条：同对已有义务 ⇒ 并入（insertIfAbsent=false）。并入目标必须是**第一条**。
  for (const id of ["vx-c2", "vx-c3"]) {
    const result = h.post(id);
    assert.deepEqual(
      result.dispatches,
      [
        {
          targetAgentId: AGENT,
          source: "mention_agent",
          outcome: "coalesced",
          detail: { triggerSource: "mention_agent", coalescedInto: k1 },
        },
      ],
      `${id}：并入既存义务 ⇒ 终局 coalesced（不得停 deferred 等一个不会来的重放）`,
    );
    assert.equal(h.receipts.get(h.key(id))!.outcome, "coalesced", "首写结论即事实");
    // 终局不可被迟到的回写覆写（条件更新只认领未收敛两值）。
    assert.equal(
      h.receipts.settleIfUnsettled({
        dispatchKey: h.key(id),
        outcome: "opened",
        updatedAt: CLOCK + 1,
      }),
      false,
      `${id}：coalesced 是终局`,
    );
  }

  assert.deepEqual(
    h.deferred.list(WS).map((row) => row.runId),
    [k1],
    "并入不新增义务行（第二/三条没有自己的义务）",
  );
  assert.deepEqual(
    h.coalescedRows().map((row) => row.request_run_id),
    [k2, k3].sort(),
    "并入留痕逐条记（request→k1）；第一条是 deferred 不是并入",
  );
  assert.deepEqual(
    h.coalescedRows().map((row) => row.target_run_id),
    [k1, k1],
    "两条并入目标都指向 k1 —— 不得链式并到 k2（k2 没有义务行）",
  );
  assert.deepEqual(h.published, [], "deferred/coalesced 都不外发（出口只发 pending）");
  assert.equal(h.comments.listByWorkItem(WS, "vx-wi").length, 3, "并入不吞评论事实（每条 C 均留）");
  assert.equal(h.activities.listByWorkItem(WS, "vx-wi").length, 9);
  assert.equal(
    h.runs
      .listActive(WS)
      .map((row) => row.runId)
      .join(","),
    "vx-active",
    "§5.2：评论服务不开 run（评论侧只有请求事实）",
  );
});

test("X2.2 独立矩阵｜义务被履行后（不在案）：新评论归自己 deferred（不得误判并入）", () => {
  const h = harness();
  seedState(h, "active");
  h.post("vx-c1");
  assert.equal(h.deferred.list(WS).length, 1);
  // 目标对收尾 ⇒ 义务被认领履行（行删除）。此时窗口仍是「有活跃 run」。
  h.deferred.fulfill(WS, "vx-wi", AGENT);
  assert.deepEqual(h.deferred.list(WS), [], "义务已履行（无承载行）");

  const second = h.post("vx-c2");
  assert.deepEqual(
    second.dispatches,
    [
      {
        targetAgentId: AGENT,
        source: "mention_agent",
        outcome: "deferred",
        detail: { triggerSource: "mention_agent" },
      },
    ],
    "同键没有义务行 ⇒ insertIfAbsent 真登记，归自己 deferred（并入只发生在确有既存义务时）",
  );
  assert.deepEqual(
    h.deferred.list(WS).map((row) => row.runId),
    [h.key("vx-c2")],
    "新义务 = 本次请求身份",
  );
  assert.deepEqual(h.coalescedRows(), [], "本次不是并入，不得留并入痕");
});

test("X2.2 不可达态：insertIfAbsent=false 但 find 找不到 ⇒ 响亮抛且不写 receipt", () => {
  const h = harness();
  seedState(h, "active");
  // 只替换义务表两个方法的返回值：其余（真实库）不动 —— 模拟「义务表说存在、按唯一键查却查不到」。
  const lyingDeferred = {
    ...h.deferred,
    insertIfAbsent: (): boolean => false,
    find: (): null => null,
  };
  const service: CommentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments: h.comments,
    activities: h.activities,
    receipts: h.receipts,
    reactions: createWorkItemCommentReactionRepo(h.db),
    runs: h.runs,
    deferred: lyingDeferred,
    workItems: createWorkItemRepo(h.db),
    roster: { listAgents: () => [{ id: AGENT, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => h.published.push(request),
    now: () => CLOCK,
    newId: () => "vx-gen",
  });
  assert.throws(
    () =>
      service.createComment({
        workspaceKey: WS,
        workspacePath: WSP,
        workItemId: "vx-wi",
        id: "vx-c9",
        author: HUMAN,
        initiatedBy: HUMAN,
        body: "@Ann 看一下",
      }),
    /不可达态/,
    "并入目标找不到必须响亮抛（静默按 deferred 落盘会让这条请求永停未收敛）",
  );
  assert.equal(h.receipts.get(h.key("vx-c9")), null, "抛在写 receipt 之前：不留半条裁决结论");
  assert.deepEqual(h.published, [], "更不得外发（请求事实没有结论）");
});

test("X2.2 读口隔离：异己 workspace 的同 workItemId 未收敛行读不到（同键不同身份不串台）", () => {
  const h = harness();
  h.receipts.insertIfAbsent({
    dispatchKey: "vx-own",
    workspaceKey: WS,
    workItemId: "vx-wi",
    targetAgentId: AGENT,
    commentId: "vx-lc",
    threadId: "vx-lc",
    source: "mention_agent",
    outcome: "pending",
    createdAt: 5,
  });
  h.receipts.insertIfAbsent({
    dispatchKey: "vx-alien",
    workspaceKey: OTHER_WS,
    workItemId: "vx-wi",
    targetAgentId: AGENT,
    commentId: "vx-lc",
    threadId: "vx-lc",
    source: "mention_agent",
    outcome: "pending",
    createdAt: 1,
  });
  assert.deepEqual(
    h.receipts.listUnsettledByWorkspace(WS).map((row) => row.dispatchKey),
    ["vx-own"],
    "补投扫描面只回本 workspace（异己行结构上读不到）",
  );
  assert.deepEqual(
    h.receipts.listUnsettledByWorkspace(OTHER_WS).map((row) => row.dispatchKey),
    ["vx-alien"],
  );
});
