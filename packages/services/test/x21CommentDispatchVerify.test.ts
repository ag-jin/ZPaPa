/* X2.1 独立复验回归（test-verifier，2026-10-06；断言取契约面，不读实现中间量）。

   本文件补的是实现者四条服务面用例**没覆盖**的格子（复验任务：逆推 + 穷举抽验）：
   ① receipt 回写口的 **7×7 全矩阵**（既有 outcome × 目标 outcome）：只有 pending/deferred 可认领，
      五个终局一律不被覆写 —— 实现者的用例只抽了 pending→opened、deferred→queued、opened→failed 三格；
   ② `targetOverride` × {名册归档 / 停用 / 两者同时 / 正常 / 名册缺席}：实现者的 #4 用例只走了
      assignee 那一支，**覆盖分支的名册判据没有用例**（分叉的表现正是「改派被拦、评论点名照跑」）；
      并补「归档先判」（两者同时命中时报归档 —— 实现者只各测了单条状态）；
   ③ 评论出口的「同键重投且仍 pending ⇒ 重新外发」这一格（实现者只测了首次 pending 与不发的补集）；
   ④ **§5.2 缺口复现**（登记未决项）：队列状态窗的 deferred 分支忽略 `insertIfAbsent` 的 false 返回
      —— 同对第二条评论的 receipt 停在 deferred，而义务表里只有第一条的 dispatchKey ⇒ 无回写通道。
      本用例落的是**现状事实**（不是期望行为），供 X2.2 简报与验收对表。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import {
  COMMENT_DISPATCH_OUTCOMES,
  COMMENT_DISPATCH_UNSETTLED_OUTCOMES,
  createCommentDispatchReceiptRepo,
  type CommentDispatchReceiptRepo,
} from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CommentService } from "../src/workitem/commentService.js";
import { planDispatch } from "../src/workitem/leaderDispatch.js";
import type { SquadDispatchRequest } from "../src/workitem/squadDispatchRequests.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

const WS = "v21-ws";
const WSP = "/tmp/v21-ws";
const CLOCK = 991_000;

/* ---------- ① receipt 回写口：7×7 全矩阵 ---------- */

/* 期望值**不取自实现**：未收敛集合由契约常量 `COMMENT_DISPATCH_UNSETTLED_OUTCOMES` 给出，
   七值闭集由 `COMMENT_DISPATCH_OUTCOMES` 给出。矩阵断言的是「认领结论只由既存 outcome 决定」、
   「身份列与首写时间戳任何推进都不改写」——两件事都在接口注释里写成硬约束。 */
test("X2.1 回写矩阵（7×7 穷举）：只有未收敛两值可认领；五个终局 outcome 一律不被覆写", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createCommentDispatchReceiptRepo(db);
  const unsettled = new Set<string>(COMMENT_DISPATCH_UNSETTLED_OUTCOMES);
  assert.equal(COMMENT_DISPATCH_OUTCOMES.length, 7, "闭集基数变了：本矩阵的口径要同步复核");

  for (const existing of COMMENT_DISPATCH_OUTCOMES) {
    for (const target of COMMENT_DISPATCH_OUTCOMES) {
      const key = `mx-${existing}-${target}`;
      repo.insertIfAbsent({
        dispatchKey: key,
        workspaceKey: WS,
        workItemId: "wi-mx",
        targetAgentId: "ta-mx",
        commentId: "c-mx",
        threadId: "c-mx",
        source: "mention_agent",
        outcome: existing,
        detail: { seed: existing },
        createdAt: 100,
      });
      const claimed = repo.settleIfUnsettled({
        dispatchKey: key,
        outcome: target,
        detail: { settled: target },
        updatedAt: 200,
      });
      assert.equal(
        claimed,
        unsettled.has(existing),
        `${existing} → ${target}：能否认领只由「既存 outcome 是否未收敛」决定`,
      );
      const row = repo.get(key)!;
      assert.equal(row.outcome, claimed ? target : existing, `${existing} → ${target} 的落定结论`);
      assert.deepEqual(row.detail, claimed ? { settled: target } : { seed: existing });
      assert.equal(row.attemptCount, claimed ? 2 : 1, "只有认领成功才计一次尝试");
      assert.equal(row.updatedAt, claimed ? 200 : 100);
      // 身份列与首写时间戳：任何推进都不得改写（接口注释的硬约束）。
      assert.equal(row.dispatchKey, key);
      assert.equal(row.workspaceKey, WS);
      assert.equal(row.workItemId, "wi-mx");
      assert.equal(row.targetAgentId, "ta-mx");
      assert.equal(row.commentId, "c-mx");
      assert.equal(row.threadId, "c-mx");
      assert.equal(row.source, "mention_agent");
      assert.equal(row.createdAt, 100);
    }
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM comment_dispatch_receipts").get() as {
    n: number;
  };
  assert.equal(count.n, 49, "回写只改行：7×7 次调用后仍是 49 行（不新增、不删除）");
});

/* 恰一赢家：同一未收敛行被两条路径（在线入口 / 义务重放）读到 —— 条件更新只允许一个赢家，
   输家拿到 false。 */
test("X2.1 恰一赢家：两条路径争同一条 pending，只有先到的认领成功（后到者 false 且不改写）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createCommentDispatchReceiptRepo(db);
  repo.insertIfAbsent({
    dispatchKey: "race-1",
    workspaceKey: WS,
    workItemId: "wi-race",
    targetAgentId: "ta-race",
    commentId: "c-race",
    threadId: "c-race",
    source: "mention_agent",
    outcome: "pending",
    createdAt: 1,
  });
  const wins = repo.settleIfUnsettled({ dispatchKey: "race-1", outcome: "opened", updatedAt: 10 });
  const loses = repo.settleIfUnsettled({
    dispatchKey: "race-1",
    outcome: "blocked",
    detail: { late: true },
    updatedAt: 11,
  });
  assert.equal(wins, true, "第一个认领成功");
  assert.equal(loses, false, "第二个必须拿到 false（据此留痕，不改写）");
  const row = repo.get("race-1")!;
  assert.equal(row.outcome, "opened", "输家不得把赢家的结论改成 blocked");
  assert.equal(row.attemptCount, 2, "只有赢家那一次计尝试");
  assert.equal(row.updatedAt, 10);
});

/* ---------- ② targetOverride × 名册状态（实现者未覆盖的组合） ---------- */

const overrideItem = (assignee: { type: string; id: string }) =>
  ({
    id: "wi_ov",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  }) as never;

const runOf = (events: ReturnType<typeof planDispatch>) =>
  events.find((event) => event.kind === "run.enqueued");

test("X2.1-D×覆盖：targetOverride 点名的智能体归档/停用 ⇒ skip（非失败），文案可分辨", () => {
  // 覆盖分支的判据必须先于目标起 run；这里用 assignee=user 证明「评论点名不看 assignee」时
  // 也照样受名册闸约束（跨分支一致的判据只在一处）。
  const archived = planDispatch({
    workItem: overrideItem({ type: "user", id: "u_1" }),
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetOverride: { type: "agent", id: "ta_named" },
    targetAgent: { id: "ta_named", enabled: true, archivedAt: 1 } as never,
  });
  assert.equal(runOf(archived), undefined, "点名的智能体已归档 ⇒ 不得起 run（覆盖不得绕过名册闸）");
  const archivedSkip = archived.find((event) => event.kind === "inbox.notified");
  assert.ok(archivedSkip?.kind === "inbox.notified");
  assert.match(archivedSkip.reason, /归档/, "归档文案要能让人知道该去「取消归档」");
  assert.doesNotMatch(archivedSkip.reason, /停用/);

  const disabled = planDispatch({
    workItem: overrideItem({ type: "user", id: "u_1" }),
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetOverride: { type: "agent", id: "ta_named" },
    targetAgent: { id: "ta_named", enabled: false } as never,
  });
  assert.equal(runOf(disabled), undefined, "点名的智能体已停用 ⇒ 不得起 run");
  const disabledSkip = disabled.find((event) => event.kind === "inbox.notified");
  assert.ok(disabledSkip?.kind === "inbox.notified");
  assert.match(disabledSkip.reason, /停用/, "停用是可随时重开的临时开关：文案不得与归档混用");
  assert.doesNotMatch(disabledSkip.reason, /归档/);
});

test("X2.1-D 次序：归档与停用同时命中 ⇒ 报「已归档」（与 squad 分支同口径）", () => {
  const events = planDispatch({
    workItem: overrideItem({ type: "agent", id: "ta_emp" }),
    squad: null,
    trigger: "user",
    runClass: "standalone",
    targetAgent: { id: "ta_emp", enabled: false, archivedAt: 7 } as never,
  });
  const skip = events.find((event) => event.kind === "inbox.notified");
  assert.ok(skip?.kind === "inbox.notified");
  assert.match(skip.reason, /归档/, "两条状态同时命中时报更强的终态结论（归档）");
});

test("X2.1-D×覆盖：正常名册与名册缺席（null / 未注入）都照旧派给点名者（A5 语义不变）", () => {
  for (const targetAgent of [
    { id: "ta_named", enabled: true },
    { id: "ta_named", enabled: true, archivedAt: undefined },
    null,
    undefined,
  ] as const) {
    const events = planDispatch({
      workItem: overrideItem({ type: "squad", id: "sq_1" }),
      squad: null,
      trigger: "user",
      runClass: "standalone",
      targetOverride: { type: "agent", id: "ta_named" },
      ...(targetAgent !== undefined ? { targetAgent } : {}),
    });
    const run = runOf(events);
    assert.ok(
      run && run.kind === "run.enqueued",
      `targetAgent=${JSON.stringify(targetAgent)} 不得被拦`,
    );
    assert.equal(run.agentId, "ta_named", "负责人是 squad 也照样派给点名者（评论不依赖 assignee）");
    assert.equal(run.isLeaderTask, false);
    assert.equal(run.squadId, undefined, "覆盖目标不得夹带队长标记/简报");
  }
});

/* ---------- ③ 评论出口：同键重投且仍 pending ⇒ 重新外发 ---------- */

type Harness = {
  db: DatabaseSync;
  service: CommentService;
  receipts: CommentDispatchReceiptRepo;
  published: SquadDispatchRequest[];
  itemId: string;
  deferred: ReturnType<typeof createSquadDeferredDispatchRepo>;
  runs: ReturnType<typeof createSquadRunRepo>;
};

const AGENT = "v21-agent";
const HUMAN: AuthorRef = { kind: "human", id: "v21-human", displayName: "人" };

function harness(itemId = "v21-wi"): Harness {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const published: SquadDispatchRequest[] = [];
  const deferred = createSquadDeferredDispatchRepo(db);
  const runs = createSquadRunRepo(db);
  const service = createCommentService({
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
    newId: () => "v21-gen",
  });
  workItems.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "独立复验",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  });
  return { db, service, receipts, published, itemId, deferred, runs };
}

/* 真实的重投形态（§3.2）：UI 预生成 id + clientRequestId —— 评论仓储按 (workspace, author,
   clientRequestId) 幂等返回既存行，于是同一条评论会**再次**走到派发 receipt 的写路径。
   缺了 clientRequestId 的「同 id 再写」会被评论主键挡住（UNIQUE），根本走不到这里。 */
test("X2.1 出口：同一评论重投且 receipt 仍 pending ⇒ 重新外发（pending 的意义就是还没有执行者）", () => {
  const h = harness();
  const post = (id: string) =>
    h.service.createComment({
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: h.itemId,
      id,
      clientRequestId: "v21-req-1",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "@Ann 看一下",
    });
  const first = post("v21-c1");
  assert.equal(first.dispatches[0]?.outcome, "pending");
  assert.equal(h.published.length, 1, "首次 pending 外发一条");
  // 同键重投（同 comment id ⇒ 同 dispatchKey）：receipt 仍 pending ⇒ 必须再外发一次。
  const again = post("v21-c1");
  assert.equal(again.dispatches[0]?.outcome, "pending", "首写即事实：重投不改写 outcome");
  assert.equal(h.published.length, 2, "pending 的重投必须重新外发（否则请求永远等不到执行者）");
  assert.deepEqual(h.published[1], h.published[0], "重投外发的请求形状必须与首发一致");
  // host 已完成（条件认领兑现）后再重投：不再外发（首写即事实的一半）。
  const request = h.published[0]!;
  assert.equal(request.kind, "comment");
  assert.equal(
    h.receipts.settleIfUnsettled({
      dispatchKey: request.kind === "comment" ? request.dispatchKey : "",
      outcome: "opened",
      updatedAt: CLOCK,
    }),
    true,
  );
  post("v21-c1");
  assert.equal(h.published.length, 2, "已终局的 receipt 不再外发（收敛后重投只读回事实）");
});

/* ---------- ④ §5.2 缺口复现（现状事实，供 X2.2 对表） ---------- */

/* 现象：同对第二条评论的 receipt 停在 deferred，而义务表里只有**第一条**的 dispatchKey。
   为什么无回写通道（三条事实一起断）：
   · 义务表按 (workspace, workItem, agent) 唯一 ⇒ 第二条的 `insertIfAbsent` 返回 false，
     而 `adjudicateQueueWindow` 的 deferred 分支**丢弃了这个返回值**（也没记并入留痕，区别于
     排队分支：那里会 `recordCoalescedRequest`）⇒ 第二条没有自己的义务行；
   · receipt 停在 deferred（不是 pending）⇒ 不外发（出口只发 pending）⇒ host 从没收到过它；
   · 重放通道按义务逐条走（义务 id = dispatchKey）⇒ 第一条重放/落定与第二条无关。
   期望修法（复验建议，二选一）：并入时把 receipt 落 **coalesced**（终局 + detail.coalescedInto，
   与排队分支同语义）—— 比「让启动扫描去补投」更早收敛，也不会在过后凭空多跑一次；或退一步，
   在义务行/并入表留痕，让义务重放时一并落定并入的 dispatchKey。 */
test("§5.2 缺口复现：队列状态窗 deferred 分支的并入被丢弃 ⇒ 第二条评论 receipt 无回写通道", () => {
  const h = harness();
  // 目标对已有活跃 run（占树）⇒ 队列状态窗落 deferred（并对**本条**登记义务）。
  h.runs.insert({
    runId: "v21-active",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: h.itemId,
    parentWorkItemId: h.itemId,
    agentId: AGENT,
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
  const post = (id: string) =>
    h.service.createComment({
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: h.itemId,
      id,
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "@Ann 帮看一眼",
    });
  const k1 = computeCommentDispatchKey({
    workspaceKey: WS,
    workItemId: h.itemId,
    targetAgentId: AGENT,
    commentId: "v21-g1",
  });
  const k2 = computeCommentDispatchKey({
    workspaceKey: WS,
    workItemId: h.itemId,
    targetAgentId: AGENT,
    commentId: "v21-g2",
  });
  assert.notEqual(k1, k2, "两条评论是两个请求身份");
  assert.equal(post("v21-g1").dispatches[0]?.outcome, "deferred");
  assert.equal(post("v21-g2").dispatches[0]?.outcome, "deferred");

  // 事实①：义务表只有第一条的 dispatchKey（第二条的并入被丢弃）。
  const obligations = h.deferred.list(WS);
  assert.deepEqual(
    obligations.map((row) => row.runId),
    [k1],
    "第二条的 insertIfAbsent 返回 false（并入）——义务表里不得出现第二条",
  );
  assert.equal(obligations[0]?.origin, "comment", "评论义务来源必须是 comment（不能落回 R2）");
  // 事实②：两条 receipt 都停在 deferred（未收敛），但只有第一条有义务行可依。
  assert.deepEqual(
    h.receipts.listByWorkItem(WS, h.itemId).map((row) => [row.dispatchKey, row.outcome]),
    [
      [k1, "deferred"],
      [k2, "deferred"],
    ],
  );
  // 事实③：两条都没外发（deferred 不外发）⇒ host 从没见过 k2；k2 也不在并入留痕/run 台账里。
  assert.deepEqual(h.published, [], "deferred 的请求不外发（出口只发 pending）");
  const coalesced = h.db
    .prepare("SELECT request_run_id, target_run_id FROM squad_run_coalesced_details")
    .all() as Array<{ request_run_id: string; target_run_id: string }>;
  assert.deepEqual(coalesced, [], "deferred 分支没有并入留痕（排队分支才有）");
  assert.deepEqual(
    h.runs.listActive(WS).map((row) => row.runId),
    ["v21-active"],
    "评论服务不开 run（§5.2），k2 也没有台账行",
  );

  // 事实④：走一遍**真实的**义务重放通道（占树的 run 离开活跃集 ⇒ claimDue 恰一次认领 ⇒ 回写 receipt）
  // 之后，第二条仍停在 deferred —— 没有任何一格会碰它。
  h.runs.setStatus("v21-active", "discarded"); // 目标对离开活跃集（claimDue 的到期判据）
  const claimed = h.deferred.claimDue(WS);
  assert.deepEqual(
    claimed.map((row) => row.runId),
    [k1],
    "重放通道只认领得到第一条的义务",
  );
  assert.equal(
    h.receipts.settleIfUnsettled({ dispatchKey: k1, outcome: "opened", updatedAt: CLOCK + 1 }),
    true,
    "第一条被重放通道回写终止",
  );
  assert.equal(h.receipts.get(k2)!.outcome, "deferred", "第二条仍在未收敛态，且无义务行承载它");
  assert.deepEqual(
    h.deferred.list(WS),
    [],
    "第一条义务被认领删除后义务表空 —— 第二条没有任何重放载体（只能靠 X2.2 的未收敛扫描）",
  );
  assert.deepEqual(h.runs.listActive(WS), [], "评论服务不开 run；第二条的请求也没有任何台账行");
});
