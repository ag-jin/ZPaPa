import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* B5.2 独立复验（test-verifier 自建夹具，不经 UI）：四个写入口的**落库事实**逐项直查 SQL，
   期望值全部来自任务卡（§5.2/§5.3/§4.4）与我自己的手写夹具，不消费实现者的测试数据。

   与实现者测试的差异（独立性的来源）：
   · 注入身份用**我自己的值** `verify-human-77`（不是实现里的 `local-user`）——门面若把身份写死，
     这里必红；
   · 断言全部走**裸 SQL**（表/列名来自 schema，不是消费服务返回的包装形状）；
   · create 的重投、三件套动作的「零派发事实」逐入口做 receipt/run/义务三表前后快照；
   · 不读 `//` 之外任何实现者断言。 */

const RUNTIME_WS = { path: "/tmp/b52-recheck/runtime-ws", identity: "b52-recheck-runtime" };
/** 调用方传入的 target 故意与 runtime 绑定值不同：它只用于现构 runtime，不得参与 key 计算。 */
const TARGET_PASSED = { path: "/tmp/b52-recheck/other-ws", identity: "b52-recheck-other" };
/** 我自己的注入身份（非实现里的常量值）。 */
const INJECTED_HUMAN = { kind: "human" as const, id: "verify-human-77" };
const AGENT_ID = "ag-recheck";

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function countRowsWhere(db: DatabaseSync, table: string, where: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

/** §4.4 的「零派发事实」三表快照：receipt / run / 完成重放义务。 */
function dispatchFacts(db: DatabaseSync) {
  return {
    receipts: countRows(db, "comment_dispatch_receipts"),
    runs: countRows(db, "squad_runs"),
    obligations: countRows(db, "squad_run_deferred_dispatches"),
  };
}

function makeFixture(options: { dispatchEnabled?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const decisions = createWorkItemDecisionRepo(db);

  workItemRepo.insert({
    id: "wi-recheck",
    workspaceIdentity: RUNTIME_WS.identity,
    workspacePath: RUNTIME_WS.path,
    title: "复验工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT_ID },
    labels: [],
    properties: {},
    position: 0,
  });

  /** 出口 spy：pending 请求的外发事实（本组合根在真实装配里接的是 hub）。 */
  const published: Array<Record<string, unknown>> = [];
  let seq = 0;
  const commentService = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems: workItemRepo,
    roster: { listAgents: () => [{ id: AGENT_ID, name: "复验队员" }], listSquads: () => [] },
    readDispatchEnabled: () => options.dispatchEnabled ?? true,
    publishDispatchRequest: (request) =>
      published.push(request as unknown as Record<string, unknown>),
    newId: () => `recheck-c-${++seq}`,
    now: () => 1_700_000_000_000 + seq * 1000,
  });

  const runtime = { workItemRepo, boundWorkspace: RUNTIME_WS } as unknown as SquadRuntime;
  const service = createWorkItemCollaborationService({
    createRuntime: async () => runtime,
    getRepos: () => ({ comments, activities, decisions, reactions, receipts }),
    localHumanActor: () => INJECTED_HUMAN,
    createCommentService: () => commentService,
  });

  return { db, service, comments, activities, published };
}

// ---------------------------------------------------------------------------
// 入口 1：createWorkItemComment
// ---------------------------------------------------------------------------

test("复验｜create 落库事实：workspace 取自 runtime 绑定、身份为注入值、sourceRun 空、恰好一条 pending receipt", async () => {
  const f = makeFixture();
  const created = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "复验第一条",
    clientRequestId: "recheck-req-create",
  });

  const row = f.db
    .prepare("SELECT * FROM work_item_comments WHERE id = ?")
    .get(created.comment.id) as Record<string, unknown>;
  assert.ok(row, "评论必须真的落进 work_item_comments（不是只返回了对象）");
  assert.equal(row.workspace_key, RUNTIME_WS.identity, "workspaceKey 来自 runtime 绑定值");
  assert.equal(row.workspace_path, RUNTIME_WS.path, "workspacePath 同源");
  assert.equal(row.author_kind, "human");
  assert.equal(row.author_id, INJECTED_HUMAN.id, "落库作者 = 组合根注入身份（UI 不传）");
  assert.equal(row.initiated_by_id, INJECTED_HUMAN.id, "initiatedBy 缺省 = actor");
  assert.equal(row.source_run_id, null, "人类 composer 不伪造 run 归属");
  assert.equal(row.thread_id, row.id, "顶层评论 threadId = 自身 id");
  assert.equal(row.client_request_id, "recheck-req-create", "幂等键原样落库");
  assert.equal(row.deleted_at, null);
  assert.equal(row.resolved_at, null);

  // 派发事实：一条 pending receipt（隐式路由到指派 agent），零 run、零义务 —— 评论链不自开 run。
  const receipt = f.db
    .prepare("SELECT * FROM comment_dispatch_receipts WHERE comment_id = ?")
    .get(created.comment.id) as Record<string, unknown>;
  assert.ok(receipt, "人类评论按指派隐式路由 ⇒ 必须有 receipt 事实");
  assert.equal(receipt.outcome, "pending");
  assert.equal(receipt.target_agent_id, AGENT_ID);
  assert.equal(receipt.workspace_key, RUNTIME_WS.identity);
  assert.equal(countRows(f.db, "squad_runs"), 0, "门面不得创建 run（§5.2）");
  assert.equal(countRows(f.db, "squad_run_deferred_dispatches"), 0, "门面不得登记义务");

  const kinds = (
    f.db.prepare("SELECT kind FROM work_item_activities ORDER BY sequence").all() as Array<{
      kind: string;
    }>
  ).map((entry) => entry.kind);
  assert.deepEqual(kinds, ["comment_created", "comment_dispatch_requested"]);

  // pending 请求外发一次（X2.1 的组合根那一半）：形状必须带 kind/dispatchKey/目标。
  assert.equal(f.published.length, 1, "pending 必须外发一次（否则永久停在等待派发）");
  assert.equal(f.published[0]!.kind, "comment");
  assert.equal(f.published[0]!.workItemId, "wi-recheck");
  assert.equal(f.published[0]!.targetAgentId, AGENT_ID);
  assert.equal(f.published[0]!.dispatchKey, receipt.dispatch_key);

  // 幂等：同 clientRequestId 重投 ⇒ 一行评论、零第二条 Activity、零第二条 receipt、零 run/义务。
  const again = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "复验第一条",
    clientRequestId: "recheck-req-create",
  });
  assert.equal(again.comment.id, created.comment.id, "同键重投返回既存行（不是第二行）");
  assert.equal(countRows(f.db, "work_item_comments"), 1);
  assert.equal(countRows(f.db, "work_item_activities"), 2, "重投不写第二条 Activity");
  assert.equal(countRows(f.db, "comment_dispatch_receipts"), 1, "重投不写第二条 receipt");
  assert.equal(countRows(f.db, "squad_runs"), 0);
  assert.equal(countRows(f.db, "squad_run_deferred_dispatches"), 0);
});

test("复验｜create 身份不可伪造：请求体多带 actor/author/initiatedBy 字段一律不生效", async () => {
  const f = makeFixture();
  const evil = { kind: "agent", id: "evil-agent" };
  const created = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "伪造身份尝试",
    clientRequestId: "recheck-req-forge",
    // 运行时多带（UI 形状本就没有这些字段）：门面必须仍用注入身份，而不是转发调用方的身份。
    actor: evil,
    author: evil,
    initiatedBy: evil,
    sourceRun: { agentId: "evil-agent", role: "leader" },
  } as never);
  const row = f.db
    .prepare("SELECT * FROM work_item_comments WHERE id = ?")
    .get(created.comment.id) as Record<string, unknown>;
  assert.equal(row.author_kind, "human");
  assert.equal(row.author_id, INJECTED_HUMAN.id);
  assert.equal(row.initiated_by_id, INJECTED_HUMAN.id);
  assert.equal(row.source_run_id, null);
});

test("复验｜create 门禁关闭（边界）：评论照写、receipt blocked（非 failed）、零 run/义务、零外发", async () => {
  const f = makeFixture({ dispatchEnabled: false });
  const created = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "门禁关闭时的评论",
    clientRequestId: "recheck-req-disabled",
  });
  assert.equal(countRows(f.db, "work_item_comments"), 1, "可审计不可派发：评论照写");
  const receipt = f.db
    .prepare("SELECT outcome, detail_json FROM comment_dispatch_receipts WHERE comment_id = ?")
    .get(created.comment.id) as { outcome: string; detail_json: string };
  assert.equal(receipt.outcome, "blocked", "门禁关闭是 blocked 不是 failed");
  assert.equal(
    (JSON.parse(receipt.detail_json) as { reason?: string }).reason,
    "dispatch_disabled",
    "blocked 必须如实带原因",
  );
  assert.equal(f.published.length, 0, "blocked 请求不外发（没有执行者接它）");
  assert.equal(countRows(f.db, "squad_runs"), 0);
  assert.equal(countRows(f.db, "squad_run_deferred_dispatches"), 0);
});

// ---------------------------------------------------------------------------
// 入口 2：softDeleteWorkItemComment
// ---------------------------------------------------------------------------

test("复验｜软删：墓碑只写 deletedAt（正文原样、线程位保留）+ comment_deleted Activity；三张派发表零变化", async () => {
  const f = makeFixture();
  const created = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "软删目标正文",
    clientRequestId: "recheck-req-softdel",
  });
  const before = dispatchFacts(f.db);

  const deleted = await f.service.softDeleteWorkItemComment(TARGET_PASSED, {
    commentId: created.comment.id,
  });
  assert.notEqual(deleted.deletedAt, null, "返回的墓碑必须带 deletedAt");

  const row = f.db
    .prepare("SELECT body, deleted_at, resolved_at FROM work_item_comments WHERE id = ?")
    .get(created.comment.id) as {
    body: string;
    deleted_at: number | null;
    resolved_at: number | null;
  };
  assert.notEqual(row.deleted_at, null, "墓碑写进库（不是只改了返回值）");
  assert.equal(row.body, "软删目标正文", "软删不动正文（审计原文保留）");
  assert.equal(row.resolved_at, null);
  assert.equal(countRows(f.db, "work_item_comments"), 1, "线程位保留：行仍在");

  const activity = f.db
    .prepare(
      "SELECT kind, actor_kind, actor_id, comment_id, payload_json FROM work_item_activities WHERE kind = 'comment_deleted'",
    )
    .get() as { actor_kind: string; actor_id: string; comment_id: string; payload_json: string };
  assert.ok(activity, "软删必须落 comment_deleted Activity");
  assert.equal(activity.actor_kind, "human");
  assert.equal(activity.actor_id, INJECTED_HUMAN.id, "Activity 归因 = 注入身份");
  assert.equal(activity.comment_id, created.comment.id);
  assert.equal(
    (JSON.parse(activity.payload_json) as { deletedAt?: number | null }).deletedAt,
    row.deleted_at,
    "Activity payload 的 deletedAt 与行内一致",
  );

  assert.deepEqual(dispatchFacts(f.db), before, "软删永不触发派发（§4.4：receipt/run/义务全不动）");
});

// ---------------------------------------------------------------------------
// 入口 3：setWorkItemCommentResolved
// ---------------------------------------------------------------------------

test("复验｜解决：根可置/可消（两条 Activity）、回复行被服务面响亮拒绝且零副作用；派发事实零变化", async () => {
  const f = makeFixture();
  const root = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "线程根",
    clientRequestId: "recheck-req-root",
  });
  const reply = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "回复",
    parentCommentId: root.comment.id,
    clientRequestId: "recheck-req-reply",
  });
  assert.equal(reply.comment.threadId, root.comment.id, "回复挂到根线程");
  // 人回人 ⇒ 不触发派发（§4.5 第 6 条），故回复自带零 receipt；这也是三件套动作前的基线。
  assert.equal(
    countRowsWhere(f.db, "comment_dispatch_receipts", `comment_id = '${reply.comment.id}'`),
    0,
  );

  const before = dispatchFacts(f.db);

  const resolved = await f.service.setWorkItemCommentResolved(TARGET_PASSED, {
    commentId: root.comment.id,
    resolved: true,
  });
  assert.notEqual(resolved.resolvedAt, null);
  assert.notEqual(
    (
      f.db
        .prepare("SELECT resolved_at FROM work_item_comments WHERE id = ?")
        .get(root.comment.id) as {
        resolved_at: number | null;
      }
    ).resolved_at,
    null,
    "根解决态真的进了库",
  );

  await assert.rejects(
    () =>
      f.service.setWorkItemCommentResolved(TARGET_PASSED, {
        commentId: reply.comment.id,
        resolved: true,
      }),
    /不是线程根/,
    "回复行必须被服务面拒绝（§3.2 仅根可置/消），门面不得吞异常",
  );
  assert.equal(
    (
      f.db
        .prepare("SELECT resolved_at FROM work_item_comments WHERE id = ?")
        .get(reply.comment.id) as {
        resolved_at: number | null;
      }
    ).resolved_at,
    null,
    "被拒的回复行状态不得被触碰",
  );

  const cleared = await f.service.setWorkItemCommentResolved(TARGET_PASSED, {
    commentId: root.comment.id,
    resolved: false,
  });
  assert.equal(cleared.resolvedAt, null, "根可消（重开）");

  const resolvedActs = f.db
    .prepare(
      "SELECT actor_id, payload_json FROM work_item_activities WHERE kind = 'comment_resolved' ORDER BY sequence",
    )
    .all() as Array<{ actor_id: string; payload_json: string }>;
  assert.equal(resolvedActs.length, 2, "置/消各一条 Activity（回复被拒不产生活动）");
  assert.deepEqual(
    resolvedActs.map((entry) => JSON.parse(entry.payload_json)),
    [{ resolved: true }, { resolved: false }],
  );
  for (const entry of resolvedActs) {
    assert.equal(entry.actor_id, INJECTED_HUMAN.id, "解决动作归因 = 注入身份");
  }

  assert.deepEqual(dispatchFacts(f.db), before, "解决永不触发派发（§4.4）");
});

// ---------------------------------------------------------------------------
// 入口 4：addWorkItemCommentReaction
// ---------------------------------------------------------------------------

test("复验｜回应：同 (comment, 作者, emoji) 幂等一行、异 emoji 第二行；永不触发派发（§4.4）", async () => {
  const f = makeFixture();
  const root = await f.service.createWorkItemComment(TARGET_PASSED, {
    workItemId: "wi-recheck",
    body: "被回应的评论",
    clientRequestId: "recheck-req-react",
  });
  const before = dispatchFacts(f.db);

  const first = await f.service.addWorkItemCommentReaction(TARGET_PASSED, {
    commentId: root.comment.id,
    emoji: "🚀",
  });
  const again = await f.service.addWorkItemCommentReaction(TARGET_PASSED, {
    commentId: root.comment.id,
    emoji: "🚀",
  });
  assert.equal(again.id, first.id, "同键重投返回既存行");
  assert.equal(countRows(f.db, "work_item_comment_reactions"), 1, "幂等：不产生第二行");
  assert.equal(
    countRowsWhere(f.db, "work_item_activities", "kind = 'comment_reaction_added'"),
    1,
    "同键重投不写第二条 Activity",
  );

  const second = await f.service.addWorkItemCommentReaction(TARGET_PASSED, {
    commentId: root.comment.id,
    emoji: "🔥",
  });
  assert.notEqual(second.id, first.id, "不同 emoji 是新的事实");
  assert.equal(countRows(f.db, "work_item_comment_reactions"), 2);

  const row = f.db
    .prepare(
      "SELECT author_kind, author_id, comment_id, emoji FROM work_item_comment_reactions WHERE id = ?",
    )
    .get(first.id) as { author_kind: string; author_id: string; comment_id: string; emoji: string };
  assert.equal(row.author_kind, "human");
  assert.equal(row.author_id, INJECTED_HUMAN.id, "回应作者 = 注入身份");
  assert.equal(row.comment_id, root.comment.id);
  assert.equal(row.emoji, "🚀");

  assert.deepEqual(dispatchFacts(f.db), before, "回应永不触发派发（§4.4）");
});

// ---------------------------------------------------------------------------
// 门面结构负向（我自己的扫描式判据，独立于实现者测试）
// ---------------------------------------------------------------------------

const FACADE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/workitem/workItemCollaborationService.ts",
);
/** 去掉注释再扫（文件头注释里引用了 `.add(` / `UPDATE` 这两个词作为「不得出现」的说明）。 */
const FACADE_CODE = readFileSync(FACADE_PATH, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("复验结构｜门面写路径只经 CommentService 四个方法：零生命周期写接口、零 SQL、零第二写口", () => {
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "settleCommentDispatchReceipt",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    ".add(",
  ]) {
    assert.ok(!FACADE_CODE.includes(forbidden), `门面源码（去注释）不得出现 ${forbidden}`);
  }
  const called = [...FACADE_CODE.matchAll(/requireCommentService\(runtime\)\.(\w+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(called)].sort(),
    ["addCommentReaction", "createComment", "setCommentResolved", "softDeleteComment"],
    "门面对写面的全部调用必须恰好是 CommentService 的四个方法（没有第五个写口）",
  );
});
