/* X1 修复轮（commit dabe1e3）**独立复验**夹具：不复用实现者新增的
   commentTripletActivities.test.ts / commentTriggerMatrix.test.ts 的夹具与常量
   （那两份是「实现方自证」；本文件另起一套 x1f-* 常量与独立断言路径），只使用公开导出面。

   覆盖（按 verification 任务清单穷举）：
   ① origin 闭集：合法两值往返 / 缺省回退（含列默认值）/ 枚举外值写入与读回（find/list/claimDue）；
   ② 三动作 × {receipt, run, deferred} 负向：零副作用（先把评论置于「本会 deferred」的语境内再动作）；
   ③ source_run_role 三态：合法值端到端往返 / 角色缺失但有 runId（响亮抛）/ 非法值（响亮抛）；
   ④ B3：根可置 ✓；回复置/消 ✗（service 与 repo 两条路，失败后不落状态、不写 Activity）；
   ⑤ 迁移 0013 三路径：全新库 / 从 0012 升级（含历史行读回后果）/ 反向退库无残留对象。
   期望值全部取自规格与修复轮声明的契约字面量，不用「拿实现再算一遍」的写法。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCommentRepo,
  SOURCE_RUN_ROLES,
  type AuthorRef,
} from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "x1f-ws";
const WSP = "/tmp/x1f-ws";
const HUMAN: AuthorRef = { kind: "human", id: "x1f-human", displayName: "人" };
const LEAD: AuthorRef = { kind: "agent", id: "x1f-lead", displayName: "队长" };
const ANN = "x1f-ann";
const CLOCK = 1_710_000;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function rows(db: DatabaseSync, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const db = openDb();
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db);
  let seq = 0;
  const service = createCommentService({
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
    newId: () => `x1f-gen-${++seq}`,
  });
  return { db, comments, activities, receipts, reactions, runs, deferred, workItems, service };
}

function putItem(
  h: Harness,
  id: string,
  assignee: { type: "user"; id: string } | { type: "agent"; id: string } = {
    type: "user",
    id: HUMAN.id,
  },
): void {
  h.workItems.insert({
    id,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: `复验 ${id}`,
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  });
}

/** 三动作的负向基线口径：receipt / run / deferred 三张表的行数快照。 */
function dispatchCounts(h: Harness): [number, number, number] {
  return [
    count(h.db, "comment_dispatch_receipts"),
    count(h.db, "squad_runs"),
    count(h.db, "squad_run_deferred_dispatches"),
  ];
}

function kinds(h: Harness, workItemId: string): string[] {
  return h.activities.listByWorkItem(WS, workItemId).map((activity) => activity.kind);
}

/* ---------- ① origin 闭集枚举（G4） ---------- */

test("G4 枚举①：合法两值（reassign|comment）经 insertIfAbsent → find/list/claimDue 原样往返", () => {
  const db = openDb();
  const repo = createSquadDeferredDispatchRepo(db);
  const base = {
    workspaceKey: WS,
    workItemId: "wi-o",
    agentId: ANN,
    dispatchCause: null,
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(repo.insertIfAbsent({ ...base, runId: "obl-c", origin: "comment" }), true);
  assert.equal(
    repo.insertIfAbsent({ ...base, runId: "obl-r", workItemId: "wi-o2", origin: "reassign" }),
    true,
  );
  assert.equal(repo.find(WS, "wi-o", ANN)!.origin, "comment");
  assert.equal(repo.find(WS, "wi-o2", ANN)!.origin, "reassign");
  // list / claimDue 是 X2.1 host 的分流读面：认领时来源必须一起带出（否则消费者只能猜）。
  assert.deepEqual(
    repo.list(WS).map((o) => o.origin),
    ["comment", "reassign"],
  );
  assert.deepEqual(
    repo.claimDue(WS).map((o) => o.origin),
    ["comment", "reassign"],
  );
  assert.equal(
    count(db, "squad_run_deferred_dispatches"),
    0,
    "claimDue 是认领（删除）语义：读回来源后行即被领走",
  );
});

test("G4 枚举②：缺省回退 'reassign'（写入方省略 origin 与「0013 之前写法的裸 SQL」都回退）", () => {
  const db = openDb();
  const repo = createSquadDeferredDispatchRepo(db);
  // 写入方省略 origin（既有 R2 调用点/历史调用方形状）：repo 缺省。
  repo.insertIfAbsent({
    runId: "obl-default",
    workspaceKey: WS,
    workItemId: "wi-d",
    agentId: ANN,
    dispatchCause: null,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(repo.find(WS, "wi-d", ANN)!.origin, "reassign", "缺省 = R2，向后兼容");
  // 列级默认值：模拟「0013 之前就在写这张表」的裸 INSERT（不列 origin）——NOT NULL DEFAULT 必须兜住。
  db.prepare(
    `INSERT INTO squad_run_deferred_dispatches
       (run_id, workspace_key, work_item_id, agent_id, dispatch_cause, created_at, updated_at)
     VALUES ('obl-legacy', ?, 'wi-d2', ?, NULL, 2, 2)`,
  ).run(WS, ANN);
  assert.equal(repo.find(WS, "wi-d2", ANN)!.origin, "reassign", "列默认值兜住老写入方");
  const col = (
    db.prepare("PRAGMA table_info(squad_run_deferred_dispatches)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((entry) => entry.name === "origin")!;
  assert.equal(col.notnull, 1, "origin 必须 NOT NULL（来源不能是「没人知道」）");
  assert.equal(col.dflt_value, "'reassign'", "列默认值与 repo 缺省同源");
});

test("G4 枚举③：枚举外值写入响亮抛且不落库；读回（find/list/claimDue）响亮抛", () => {
  const db = openDb();
  const repo = createSquadDeferredDispatchRepo(db);
  assert.throws(
    () =>
      repo.insertIfAbsent({
        runId: "obl-bad",
        workspaceKey: WS,
        workItemId: "wi-b",
        agentId: ANN,
        dispatchCause: null,
        origin: "bogus" as never,
        createdAt: 1,
        updatedAt: 1,
      }),
    /origin/,
    "写入闸：枚举外值绝不落盘",
  );
  assert.equal(count(db, "squad_run_deferred_dispatches"), 0, "被拒后表内零行");
  // 读回闸：列被写坏（闭集被改小 / 外部写入）时三个读口都不得静默按默认值处理。
  repo.insertIfAbsent({
    runId: "obl-wire",
    workspaceKey: WS,
    workItemId: "wi-b2",
    agentId: ANN,
    dispatchCause: null,
    origin: "comment",
    createdAt: 1,
    updatedAt: 1,
  });
  db.prepare(
    "UPDATE squad_run_deferred_dispatches SET origin = 'bogus' WHERE run_id = 'obl-wire'",
  ).run();
  assert.throws(() => repo.find(WS, "wi-b2", ANN), /origin/);
  assert.throws(() => repo.list(WS), /origin/);
  assert.throws(() => repo.claimDue(WS), /origin/, "认领前必须验来源：不得把坏行交给重放通道");
  // 注意（复验发现 F1，已如实上报，不在此钉成期望）：claimDue 是「先按条件 DELETE、后 rowToRecord」
  // 的顺序 ⇒ 上面的读闸抛出发生在**行已被删掉之后**，该义务既不重放也不留痕（静默蒸发）。
  // 触发前提是库里 origin 已是闭集外值（写闸挡住正常写入方，故只在列被写坏/外部直写时可达），
  // 且该顺序在 0013 之前对 dispatch_cause 就已存在（非本轮引入）。修法：映射/校验先于删除。
});

test("G4 枚举④：commentedSvc 的 deferred 义务在真实写路径上落 'comment'（不是默认值兜出来的）", () => {
  const h = makeHarness();
  putItem(h, "wi-c", { type: "agent", id: ANN });
  // 活跃 run 占树 ⇒ 评论走 deferred 义务（裁决表 §12.1-2）。
  h.runs.insert({
    runId: "run-occupy",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-c",
    parentWorkItemId: "wi-c",
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
    workItemId: "wi-c",
    id: "c-obl",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 处理一下",
  });
  assert.equal(result.dispatches[0]?.outcome, "deferred");
  assert.equal(
    h.deferred.list(WS)[0]!.origin,
    "comment",
    "评论通道来源 = 'comment'（X2.1 据此分流）",
  );
});

test("G4 枚举⑤：R2 通道（squadRunLifecycle 活跃 run 臂）在真实 runtime 上落 'reassign'", async () => {
  const repoRoot = await makeRepo();
  const db = openDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "x1f-r2",
    readExperimentEnabled: () => true,
  });
  const agent = runtime.teamAgentService.create({
    name: "x1f-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 6,
  });
  const open = (runId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: "wi-r2",
      parentWorkItemId: "wi-r2",
      agentId: agent.id,
      isLeaderTask: false,
    });
  assert.equal((await open("run-r2-1")).kind, "opened");
  assert.equal((await open("run-r2-2")).kind, "deferred", "同 pair 已有活跃 run ⇒ R2 义务");
  const obligations = runtime.squadDeferredDispatchRepo.list("x1f-r2");
  assert.deepEqual(
    obligations.map((o) => [o.runId, o.origin]),
    [["run-r2-2", "reassign"]],
    "R2 臂显式标注 'reassign'——与评论臂的 'comment' 可判别",
  );
});

/* ---------- ② 三动作 × {receipt, run, deferred} 负向 ---------- */

test("§4.4 负向：软删/解决态/表情回应三动作对 receipt、run、deferred 零副作用（且正向事实仍落）", () => {
  const h = makeHarness();
  putItem(h, "wi-n", { type: "agent", id: ANN });
  // 语境拉满：目标对已有活跃 run（占树）⇒ 若三动作被误当「评论/派发请求」，deferred 一列必然长出来。
  h.runs.insert({
    runId: "run-busy",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-n",
    parentWorkItemId: "wi-n",
    agentId: ANN,
    isLeaderTask: false,
    branch: "squad/member/n/y",
    dirName: null,
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-n",
    id: "c-neg",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "根评论 @Ann",
  });
  h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-n",
    id: "c-neg-reply",
    parentCommentId: "c-neg",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "回复",
  });
  const before = dispatchCounts(h);
  assert.deepEqual(
    before,
    [1, 1, 1],
    "前置对照：评论本身落了 1 receipt / 1 run（我插入的活跃行）/ 1 义务",
  );

  const afterSoftDelete = (() => {
    h.service.softDeleteComment({ commentId: "c-neg-reply", workspaceKey: WS, actor: HUMAN });
    return dispatchCounts(h);
  })();
  assert.deepEqual(afterSoftDelete, before, "软删零副作用（§4.4）");

  const afterResolve = (() => {
    h.service.setCommentResolved({
      commentId: "c-neg",
      workspaceKey: WS,
      resolved: true,
      actor: HUMAN,
    });
    return dispatchCounts(h);
  })();
  assert.deepEqual(afterResolve, before, "解决态零副作用（§4.4）");

  const afterReaction = (() => {
    h.service.addCommentReaction({
      commentId: "c-neg",
      workspaceKey: WS,
      author: HUMAN,
      emoji: "👍",
    });
    return dispatchCounts(h);
  })();
  assert.deepEqual(afterReaction, before, "表情回应零副作用（§4.4）");

  // 正向面：三动作确实落了各自的事实（否则「零副作用」是空跑——vacuous 防护）。
  const seen = kinds(h, "wi-n");
  for (const kind of ["comment_deleted", "comment_resolved", "comment_reaction_added"]) {
    assert.ok(seen.includes(kind as never), `三动作必须各写一枚 Activity：${kind}（B1）`);
  }
  assert.ok(h.comments.get("c-neg-reply")!.deletedAt !== null);
  assert.ok(h.comments.get("c-neg")!.resolvedAt !== null);
  assert.equal(h.reactions.listByComment("c-neg").length, 1);
  // 幂等键字面量（§8.1：同事实重投只留一条；三类互不吞并）。
  const activities = h.activities.listByWorkItem(WS, "wi-n");
  const byKind = (kind: string) => activities.filter((a) => a.kind === kind).map((a) => a.dedupKey);
  assert.deepEqual(byKind("comment_deleted"), ["comment:c-neg-reply:deleted"]);
  assert.deepEqual(byKind("comment_resolved"), ["comment:c-neg:resolved:set"]);
  assert.deepEqual(byKind("comment_reaction_added"), ["reaction:c-neg:human:x1f-human:👍"]);
  // 重投同一事实：靠 dedupKey 幂等，不写第二条；换 emoji 才是新事实。
  h.service.softDeleteComment({ commentId: "c-neg-reply", workspaceKey: WS, actor: HUMAN });
  h.service.setCommentResolved({
    commentId: "c-neg",
    workspaceKey: WS,
    resolved: true,
    actor: HUMAN,
  });
  h.service.addCommentReaction({
    commentId: "c-neg",
    workspaceKey: WS,
    author: HUMAN,
    emoji: "👍",
  });
  h.service.addCommentReaction({
    commentId: "c-neg",
    workspaceKey: WS,
    author: HUMAN,
    emoji: "🎉",
  });
  const after = kinds(h, "wi-n");
  assert.equal(after.filter((kind) => kind === "comment_deleted").length, 1, "软删重投幂等");
  assert.equal(after.filter((kind) => kind === "comment_resolved").length, 1, "同状态重投幂等");
  assert.equal(
    after.filter((kind) => kind === "comment_reaction_added").length,
    2,
    "换 emoji = 新事实",
  );
  assert.deepEqual(dispatchCounts(h), before, "重投与新增回应依旧零派发副作用（§4.4）");
});

test("§4.4 负向（结构面）：服务入口闭集仍是 4 个——三动作没有引入派发/生命周期写入口", () => {
  const h = makeHarness();
  assert.deepEqual(Object.keys(h.service).sort(), [
    "addCommentReaction",
    "createComment",
    "setCommentResolved",
    "softDeleteComment",
  ]);
});

/* ---------- ③ source_run_role 三态（B2） ---------- */

test("B2①：合法角色端到端往返——队长 run 的评论与其 comment_created Activity 都读回 leader（不是 member）", () => {
  const h = makeHarness();
  putItem(h, "wi-s");
  const sourceRun = {
    runId: "run-lead",
    agentId: "x1f-lead",
    squadId: "sq-core",
    role: "leader" as const,
  };
  const created = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-s",
    id: "c-lead",
    author: LEAD,
    sourceRun,
    initiatedBy: HUMAN,
    body: "队长汇报",
  });
  // 评论行（0010 起就有全形状列）：往返只是对照——X1.3 B2 的失真点在 Activity。
  assert.deepEqual(created.comment.sourceRun, sourceRun);
  const activity = h.activities
    .listByWorkItem(WS, "wi-s")
    .find((a) => a.kind === "comment_created")!;
  assert.deepEqual(
    activity.sourceRun,
    sourceRun,
    "X1.3 B2：Activity 读回不得把 leader 静默降成 member",
  );
  // 独立于 repo 映射的列级证据：三列真的落库（不是读回时补出来的）。
  const raw = rows(h.db, "SELECT * FROM work_item_activities WHERE id = ?", activity.id)[0]!;
  assert.equal(raw.source_run_role, "leader");
  assert.equal(raw.source_run_agent_id, "x1f-lead");
  assert.equal(raw.source_run_squad_id, "sq-core");
  // 三值闭集逐个往返（leader/member/standalone）。
  for (const role of SOURCE_RUN_ROLES) {
    const id = `c-role-${role}`;
    h.service.createComment({
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: "wi-s",
      id,
      author: LEAD,
      sourceRun: { runId: `run-${role}`, role },
      initiatedBy: HUMAN,
      body: `角色 ${role}`,
    });
    const stored = h.comments.get(id)!.sourceRun!;
    assert.equal(stored.role, role);
    const act = h.activities
      .listByWorkItem(WS, "wi-s")
      .find((a) => a.dedupKey === `comment:${id}:created`)!;
    assert.equal(act.sourceRun!.role, role, `Activity 角色字段必须逐值保真：${role}`);
  }
});

test("B2②：有 runId 而角色缺失/非法 ⇒ 读取响亮抛（历史行不猜 member）", () => {
  const db = openDb();
  const repo = createWorkItemActivityRepo(db);
  const agent: AuthorRef = { kind: "agent", id: "x1f-lead" };
  const add = (id: string, dedupKey: string) =>
    repo.add({
      id,
      workspaceKey: WS,
      workspacePath: WSP,
      workItemId: "wi-h",
      kind: "comment_created",
      occurredAt: CLOCK,
      actor: agent,
      sourceRun: { runId: "run-x", role: "standalone" },
      initiatedBy: HUMAN,
      dedupKey,
      createdAt: CLOCK,
    });
  add("a-legacy", "dk-legacy");
  // 缺失（= 0013 之前的历史行：只存了 source_run_id，角色无从得知）。
  db.prepare("UPDATE work_item_activities SET source_run_role = NULL WHERE id = 'a-legacy'").run();
  assert.throws(() => repo.get("a-legacy"), /source_run_role|角色/);
  assert.throws(
    () => repo.listByWorkItem(WS, "wi-h"),
    /source_run_role|角色/,
    "时间线读取同样不得静默",
  );
  // 非法（闭集外值）。
  db.prepare(
    "UPDATE work_item_activities SET source_run_role = 'leaderess' WHERE id = 'a-legacy'",
  ).run();
  assert.throws(() => repo.get("a-legacy"), /source_run_role|角色/);
  // 无 runId 的行不受牵连（role 列本就允许 NULL）。
  add("a-none", "dk-none");
  db.prepare(
    "UPDATE work_item_activities SET source_run_id = NULL, source_run_role = NULL WHERE id = 'a-none'",
  ).run();
  assert.equal(repo.get("a-none")!.sourceRun, null, "人手工事实（无 run）照常可读");
});

/* ---------- ④ B3：解决态仅线程根 ---------- */

function thread(h: Harness, workItemId: string, rootId: string, replyId: string): void {
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

test("B3：根可置/消（各一条 Activity）；回复置/消在 service 与 repo 两条路都响亮拒且零残留", () => {
  const h = makeHarness();
  putItem(h, "wi-b3");
  thread(h, "wi-b3", "c-root", "c-reply");
  const before = kinds(h, "wi-b3");

  // 根：置 → 消，各一条 Activity，互不吞并（dedupKey 带 set/cleared）。
  const set = h.service.setCommentResolved({
    commentId: "c-root",
    workspaceKey: WS,
    resolved: true,
    actor: HUMAN,
  });
  assert.ok(set.resolvedAt !== null);
  const cleared = h.service.setCommentResolved({
    commentId: "c-root",
    workspaceKey: WS,
    resolved: false,
    actor: HUMAN,
  });
  assert.equal(cleared.resolvedAt, null);
  const rootActivities = h.activities
    .listByWorkItem(WS, "wi-b3")
    .filter((a) => a.kind === "comment_resolved");
  assert.deepEqual(
    rootActivities.map((a) => a.dedupKey),
    ["comment:c-root:resolved:set", "comment:c-root:resolved:cleared"],
  );

  // 回复：置位（service）→ 拒；失败后状态与事实面零变化。
  assert.throws(
    () =>
      h.service.setCommentResolved({
        commentId: "c-reply",
        workspaceKey: WS,
        resolved: true,
        actor: HUMAN,
      }),
    /解决态仅线程根/,
  );
  assert.equal(h.comments.get("c-reply")!.resolvedAt, null, "拒后不落状态");
  // 回复：取消（service）→ 同款守卫（方向不影响「仅根」）。
  assert.throws(
    () =>
      h.service.setCommentResolved({
        commentId: "c-reply",
        workspaceKey: WS,
        resolved: false,
        actor: HUMAN,
      }),
    /解决态仅线程根/,
  );
  // 回复：置/消（repo 直调）→ 双保险同样响亮。
  assert.throws(() => h.comments.setResolved("c-reply", true), /仅根/);
  assert.throws(() => h.comments.setResolved("c-reply", false), /仅根/);
  assert.equal(h.comments.get("c-reply")!.resolvedAt, null);
  // 三次被拒后：Activity 一条不多、不写别的 kind。
  assert.deepEqual(
    kinds(h, "wi-b3").filter((kind) => kind === "comment_resolved").length,
    2,
    "只有根的置/消两枚；回复的拒绝不得写 Activity",
  );
  assert.deepEqual(kinds(h, "wi-b3"), [...before, "comment_resolved", "comment_resolved"]);
});

/* ---------- ⑤ 迁移 0013 三路径 ---------- */

/* 本文件只对 0013 负责：`LATEST` 是「本文件关心的那条迁移」，**不是**「全库最后一条」——
   0014（看门狗 W1）之后它后面还有迁移，故断言一律问「0013 在不在账本里 / 恰一行」，
   不问 `at(-1)`（写死「最后一条是谁」会让本用例在下一条迁移落地时假红）。 */
const LATEST = "0013_collaboration_source_run_and_origin";
const REVERSE_0013 = [
  "ALTER TABLE squad_run_deferred_dispatches DROP COLUMN origin",
  "ALTER TABLE work_item_activities DROP COLUMN source_run_role",
  "ALTER TABLE work_item_activities DROP COLUMN source_run_squad_id",
  "ALTER TABLE work_item_activities DROP COLUMN source_run_agent_id",
];

function ledgerIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function objectNames(db: DatabaseSync, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE tbl_name = ? ORDER BY name")
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}

test("0013 路径① 全新库：列/默认值齐备、账本收尾、读写即刻可用", () => {
  const db = openDb();
  assert.equal(ledgerIds(db).filter((id) => id === LATEST).length, 1, "0013 已应用且恰一行");
  assert.deepEqual(
    tableColumns(db, "work_item_activities").filter((name) => name.startsWith("source_run_")),
    ["source_run_id", "source_run_agent_id", "source_run_squad_id", "source_run_role"],
    "0011 只加了三列，原 source_run_id 保持不变（列序 = ALTER 追加序）",
  );
  assert.ok(tableColumns(db, "squad_run_deferred_dispatches").includes("origin"));
  // 即刻可用：写入/读回走一遍（形状对了但写不进同样不算过）。
  const repo = createSquadDeferredDispatchRepo(db);
  repo.insertIfAbsent({
    runId: "obl-fresh",
    workspaceKey: WS,
    workItemId: "wi-f",
    agentId: ANN,
    dispatchCause: null,
    origin: "comment",
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(repo.find(WS, "wi-f", ANN)!.origin, "comment");
});

test("0013 路径② 从 0012 升级：退到 0012 形态 ⇒ 重跑迁移只补 0013；既有数据一字未动", () => {
  const db = openDb();
  // 退到 0012 形态（等价于「老库停在 0012」），再写入 pre-0013 形态的既有数据——用裸 SQL，
  // 因为此刻表上确实没有那三列（用 repo 写会撞列名缺失，恰好说明「老库年代」没有这些列）。
  for (const sql of REVERSE_0013) db.exec(sql);
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(LATEST);
  db.prepare(
    "INSERT INTO work_items (id, workspace_key, workspace_path, stage, title, body, status, assignee_type, assignee_id, labels, properties, position, created_at, updated_at) VALUES ('wi-legacy', ?, ?, NULL, '老项', '', 'todo', 'user', 'u', '[]', '{}', 0, 1, 1)",
  ).run(WS, WSP);
  db.prepare(
    `INSERT INTO work_item_activities (
       id, workspace_key, workspace_path, work_item_id, kind, sequence, occurred_at,
       actor_kind, actor_id, actor_display_name, source_run_id,
       initiated_by_kind, initiated_by_id, comment_id, decision_id, dispatch_event_id,
       payload_json, dedup_key, created_at, updated_at
     ) VALUES ('a-old', ?, ?, 'wi-legacy', 'comment_created', 1, 1, 'human', 'x1f-human', NULL,
       'run-old', 'human', 'x1f-human', NULL, NULL, NULL, '{}', 'dk-old', 1, 1)`,
  ).run(WS, WSP);
  assert.deepEqual(
    tableColumns(db, "work_item_activities").filter((name) => name.startsWith("source_run_")),
    ["source_run_id"],
  );
  assert.ok(!ledgerIds(db).includes(LATEST), "退库后 0013 不在账本里（等价于老库停在 0012）");

  // 升级：只应补跑 0013（其余条目 checksum 未变 ⇒ 不会 checksum_mismatch）。
  runTasksDatabaseMigrations(db);
  assert.equal(ledgerIds(db).filter((id) => id === LATEST).length, 1, "0013 已应用且恰一行");
  assert.deepEqual(
    tableColumns(db, "work_item_activities").filter((name) => name.startsWith("source_run_")),
    ["source_run_id", "source_run_agent_id", "source_run_squad_id", "source_run_role"],
  );
  assert.ok(tableColumns(db, "squad_run_deferred_dispatches").includes("origin"));
  assert.equal(
    (db.prepare("SELECT title FROM work_items WHERE id = 'wi-legacy'").get() as { title: string })
      .title,
    "老项",
    "既有数据一字未动",
  );
  // 历史行读回后果（本次修复的明确取舍）：有 runId 而角色无从得知 ⇒ 响亮抛，不静默当 member。
  // 这条断言把「升级后老 Activity 会炸」钉成显式契约；若未来改为回填/降级，本用例会先红。
  const activities = createWorkItemActivityRepo(db);
  assert.throws(() => activities.get("a-old"), /source_run_role|角色/);
  assert.equal(
    ledgerIds(db).filter((id) => id === LATEST).length,
    1,
    "升级后账本只有一行 0013（不重复登记）",
  );
});

test("0013 路径③ 反向退库：列撤净、无残留对象，再升级可复原", () => {
  const db = openDb();
  const before = {
    activities: objectNames(db, "work_item_activities"),
    deferred: objectNames(db, "squad_run_deferred_dispatches"),
  };
  for (const sql of REVERSE_0013) db.exec(sql);
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(LATEST);
  // 0013 不加索引：撤列后对象清单必须与撤前逐字一致（没有半撤的残留索引/触发器）。
  assert.deepEqual(objectNames(db, "work_item_activities"), before.activities);
  assert.deepEqual(objectNames(db, "squad_run_deferred_dispatches"), before.deferred);
  assert.ok(!tableColumns(db, "work_item_activities").includes("source_run_role"));
  assert.ok(!tableColumns(db, "squad_run_deferred_dispatches").includes("origin"));
  // 1:1 复原。
  runTasksDatabaseMigrations(db);
  assert.ok(ledgerIds(db).includes(LATEST), "再升级后 0013 复原");
  assert.ok(tableColumns(db, "work_item_activities").includes("source_run_role"));
  assert.ok(tableColumns(db, "squad_run_deferred_dispatches").includes("origin"));
});
