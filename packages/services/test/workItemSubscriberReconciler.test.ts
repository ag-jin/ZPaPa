import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { applyWorkItemAssignee } from "../src/workitem/workItemAssignee.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";
import { makeRepo } from "./helpers/gitFixture.js";
import { createWorkItemSubscriberRepo } from "../src/workitem/workItemSubscriberRepo.js";
import {
  AUTOMATIC_SUBSCRIBER_REASONS,
  MANUAL_SUBSCRIBER_REASON,
  createSubscriberFactRecorder,
  mentionedSubscriberSubjects,
  type SubscriberReason,
} from "../src/workitem/subscriberFacts.js";
import {
  reconcileSubscriberFacts,
  type SubscriberFact,
  type SubscriberRowState,
} from "../src/workitem/subscriberReconciler.js";

/* SUB.1 消解规则的**纯矩阵**（唯一 reconciler 的判据面）。

   期望值来源：拆解报告 §2.1 的四条冻结规则 + spec §7.1 的六 reason 表（逐条抄录），
   不在测试里重算实现的分支。矩阵按「六 reason × {无行 / 活动同位 / 活动他位 / 已退订 / manual}」
   逐格走，任何一格漏判都会在这里现形。 */

const SUBJECT = { kind: "human" as const, id: "local-user" };
const AUTOMATIC: readonly SubscriberReason[] = AUTOMATIC_SUBSCRIBER_REASONS;

function state(
  reason: SubscriberReason,
  tombstonedAt: number | null = null,
  optOutScope: SubscriberRowState["optOutScope"] = "issue",
): SubscriberRowState {
  return { reason, tombstonedAt, optOutScope };
}

// ---------------------------------------------------------------------------
// 自动事实（五格）→ subscribe
// ---------------------------------------------------------------------------

test("消解｜自动事实：无行 ⇒ 插入该 reason；同位活动行 ⇒ 不变（幂等）；异位活动行 ⇒ 改写为本次事实", () => {
  for (const reason of AUTOMATIC) {
    assert.deepEqual(
      reconcileSubscriberFacts(null, { kind: "subscribe", reason, subject: SUBJECT }),
      { action: "subscribe", reason },
      `${reason}：无行 ⇒ 插入`,
    );
    assert.deepEqual(
      reconcileSubscriberFacts(state(reason), { kind: "subscribe", reason, subject: SUBJECT }),
      { action: "none", why: "unchanged" },
      `${reason}：同事实重投 ⇒ 不写（不产生新时间戳）`,
    );
    for (const other of AUTOMATIC) {
      if (other === reason) continue;
      assert.deepEqual(
        reconcileSubscriberFacts(state(other), { kind: "subscribe", reason, subject: SUBJECT }),
        { action: "subscribe", reason },
        `${other} ⇒ ${reason}：最近事实胜`,
      );
    }
  }
});

test("消解｜自动事实：manual 行受保护（不改写）；已退订行不被复活（两种档位都不复活）", () => {
  for (const reason of AUTOMATIC) {
    assert.deepEqual(
      reconcileSubscriberFacts(state(MANUAL_SUBSCRIBER_REASON), {
        kind: "subscribe",
        reason,
        subject: SUBJECT,
      }),
      { action: "none", why: "manual_protected" },
      `${reason} 不得改写 manual 行（spec §7.1「不被自动规则删除」）`,
    );
    for (const scope of ["issue", "subtree"] as const) {
      // 退订范围只在 tombstone 行上有语义，但两种档位都不阻止「自动规则不得复活」这条总规则。
      assert.deepEqual(
        reconcileSubscriberFacts(state("creator", 1_000, scope), {
          kind: "subscribe",
          reason,
          subject: SUBJECT,
        }),
        { action: "none", why: "tombstoned" },
        `${reason} 不得复活已退订（${scope}）的行`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 自动撤销（改派）→ revoke
// ---------------------------------------------------------------------------

test("消解｜自动撤销：只撤销负责人关系两格的活动行；其它 reason / manual / tombstone / 无行都不适用", () => {
  for (const reason of ["assignee", "delegated"] as const) {
    assert.deepEqual(
      reconcileSubscriberFacts(state(reason), { kind: "revoke", subject: SUBJECT }),
      { action: "revoke" },
      `${reason}：负责人关系结束 ⇒ 撤销`,
    );
  }
  for (const reason of ["creator", "commenter", "mentioned"] as const) {
    assert.deepEqual(
      reconcileSubscriberFacts(state(reason), { kind: "revoke", subject: SUBJECT }),
      { action: "none", why: "revoke_not_applicable" },
      `${reason}：撤销负责人不适用（删了就是静默丢一条仍成立的关系）`,
    );
  }
  assert.deepEqual(
    reconcileSubscriberFacts(state(MANUAL_SUBSCRIBER_REASON), { kind: "revoke", subject: SUBJECT }),
    {
      action: "none",
      why: "manual_protected",
    },
  );
  assert.deepEqual(
    reconcileSubscriberFacts(state("assignee", 1_000), { kind: "revoke", subject: SUBJECT }),
    { action: "none", why: "tombstoned" },
    "已退订行不被自动规则删除（墓碑是用户意愿）",
  );
  assert.deepEqual(reconcileSubscriberFacts(null, { kind: "revoke", subject: SUBJECT }), {
    action: "none",
    why: "revoke_not_applicable",
  });
});

// ---------------------------------------------------------------------------
// 手动订阅 → subscribe(manual) / clear_tombstone
// ---------------------------------------------------------------------------

test("消解｜手动订阅：无行 ⇒ 插入 manual；活动自动行 ⇒ 归 manual（人说的算）；已退订 ⇒ 复活；manual ⇒ 不变", () => {
  assert.deepEqual(reconcileSubscriberFacts(null, { kind: "manual_subscribe", subject: SUBJECT }), {
    action: "subscribe",
    reason: "manual",
  });
  for (const reason of AUTOMATIC) {
    assert.deepEqual(
      reconcileSubscriberFacts(state(reason), { kind: "manual_subscribe", subject: SUBJECT }),
      { action: "subscribe", reason: "manual" },
      `${reason} ⇒ manual：显式订阅覆盖自动原因`,
    );
  }
  assert.deepEqual(
    reconcileSubscriberFacts(state(MANUAL_SUBSCRIBER_REASON), {
      kind: "manual_subscribe",
      subject: SUBJECT,
    }),
    { action: "none", why: "unchanged" },
    "已经是 manual：重投不写",
  );
  assert.deepEqual(
    reconcileSubscriberFacts(state("creator", 1_000), {
      kind: "manual_subscribe",
      subject: SUBJECT,
    }),
    { action: "clear_tombstone" },
    "只有用户手动订阅能复活（spec §7.1）",
  );
});

// ---------------------------------------------------------------------------
// 手动退订 → tombstone(scope)
// ---------------------------------------------------------------------------

test("消解｜手动退订：无行也建墓碑（意愿与「当前有没有自动关系」正交）；换档写新范围；同档不写", () => {
  for (const reason of [...AUTOMATIC, MANUAL_SUBSCRIBER_REASON]) {
    assert.deepEqual(
      reconcileSubscriberFacts(state(reason), {
        kind: "manual_unsubscribe",
        subject: SUBJECT,
        scope: "subtree",
      }),
      { action: "tombstone", scope: "subtree" },
      `活动行（${reason}）⇒ 打墓碑并承载范围`,
    );
  }
  assert.deepEqual(
    reconcileSubscriberFacts(null, {
      kind: "manual_unsubscribe",
      subject: SUBJECT,
      scope: "issue",
    }),
    { action: "tombstone", scope: "issue" },
    "无行：退订也必须落墓碑（否则下一次自动事实会把人又加回来）",
  );
  assert.deepEqual(
    reconcileSubscriberFacts(state("creator", 1_000, "issue"), {
      kind: "manual_unsubscribe",
      subject: SUBJECT,
      scope: "subtree",
    }),
    { action: "tombstone", scope: "subtree" },
    "已退订 + 换档 ⇒ 更新范围（用户改主意：此条改为此条及子项）",
  );
  assert.deepEqual(
    reconcileSubscriberFacts(state("creator", 1_000, "subtree"), {
      kind: "manual_unsubscribe",
      subject: SUBJECT,
      scope: "subtree",
    }),
    { action: "none", why: "unchanged" },
    "已退订 + 同档 ⇒ 不写（不产生新时间戳）",
  );
});

// ---------------------------------------------------------------------------
// 结构：唯一 reconciler 的纯模块（零 IO）
// ---------------------------------------------------------------------------

test("消解｜纯函数：同输入两次调用逐字节相同；模块零 IO（无 node: 值导入、无订阅表 SQL、无派发面）", () => {
  const first = reconcileSubscriberFacts(state("creator"), {
    kind: "subscribe",
    reason: "commenter",
    subject: SUBJECT,
  });
  const second = reconcileSubscriberFacts(state("creator"), {
    kind: "subscribe",
    reason: "commenter",
    subject: SUBJECT,
  });
  assert.deepEqual(first, second, "纯函数：同输入同输出（无时钟、无随机）");
});

// ---------------------------------------------------------------------------
// 事实接线（一）：创建工作项 / 写评论（服务层直构，唯一 reconciler 落库）
// ---------------------------------------------------------------------------

const WS = { key: "ws-facts", path: "/tmp/ws-facts" };
const AGENT = "ag-ann";

/** 订阅行的紧凑投影（`类型:id=reason`）——断言只关心「谁因为什么在册」。 */
function subjectReasons(db: DatabaseSync, workItemId: string): string[] {
  return (
    db
      .prepare(
        `SELECT subject_type, subject_id, reason FROM work_item_subscribers
         WHERE work_item_id = ? ORDER BY subject_type, subject_id`,
      )
      .all(workItemId) as Array<{ subject_type: string; subject_id: string; reason: string }>
  ).map((row) => `${row.subject_type}:${row.subject_id}=${row.reason}`);
}

function createdAtOf(db: DatabaseSync, workItemId: string, subjectId: string): number {
  return (
    db
      .prepare(
        "SELECT created_at FROM work_item_subscribers WHERE work_item_id = ? AND subject_id = ?",
      )
      .get(workItemId, subjectId) as { created_at: number }
  ).created_at;
}

function factsFixture() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const subscriberRepo = createWorkItemSubscriberRepo(db);
  const workItemRepo = createWorkItemRepo(db);
  const workItemService = createWorkItemService({
    repo: workItemRepo,
    emit: () => {},
    subscribers: createSubscriberFactRecorder(subscriberRepo, WS),
  });
  return { db, subscriberRepo, workItemRepo, workItemService };
}

function commentFixture() {
  const base = factsFixture();
  const comments = createWorkItemCommentRepo(base.db);
  const activities = createWorkItemActivityRepo(base.db);
  const commentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments,
    activities,
    receipts: createCommentDispatchReceiptRepo(base.db),
    reactions: createWorkItemCommentReactionRepo(base.db),
    runs: createSquadRunRepo(base.db),
    deferred: createSquadDeferredDispatchRepo(base.db),
    workItems: base.workItemRepo,
    roster: {
      listAgents: () => [{ id: AGENT, name: "Ann" }],
      listSquads: () => [{ id: "sq-1", name: "sq", leaderAgentId: AGENT }],
    },
    humanNames: new Set(["李四"]),
    readDispatchEnabled: () => true,
    subscribers: createSubscriberFactRecorder(base.subscriberRepo, WS),
  });
  return { ...base, commentService };
}

test("接线｜创建事实：creator（human/agent）落 creator；assignee 落 assignee；system 创建不产行；占位 user:user 归一到 human:local-user", () => {
  const f = factsFixture();
  const selfAssigned = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "自建自领",
    assignee: { type: "user", id: "user" },
    creator: { kind: "human", id: "local-user" },
  });
  assert.deepEqual(
    subjectReasons(f.db, selfAssigned.id),
    ["human:local-user=creator"],
    "同一主体的两条同刻事实只长一行：创建人在后 ⇒ reason 落 creator" +
      "（「记录创建者，不因后续改派消失」——spec §7.1）",
  );

  const assigned = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "派给队员",
    assignee: { type: "agent", id: AGENT },
    creator: { kind: "human", id: "local-user" },
  });
  assert.deepEqual(subjectReasons(f.db, assigned.id), [
    `${"agent"}:${AGENT}=assignee`,
    "human:local-user=creator",
  ]);

  const byAgent = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "agent 建",
    assignee: { type: "user", id: "user" },
    creator: { kind: "agent", id: "ag-lead" },
  });
  assert.deepEqual(
    subjectReasons(f.db, byAgent.id),
    ["agent:ag-lead=creator", "human:local-user=assignee"],
    "非本人主体也如实入册（注入式正例：system 之外的三值都是订阅主体）",
  );

  const bySystem = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "system 建",
    assignee: { type: "agent", id: AGENT },
    creator: { kind: "system", id: "sys" },
  });
  assert.deepEqual(
    subjectReasons(f.db, bySystem.id),
    ["agent:ag-ann=assignee"],
    "system 不是可通知主体：不产订阅行（不编造一个没人能接的主体）",
  );

  const noCreator = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "无创建人（存量形态）",
    assignee: { type: "squad", id: "sq-1" },
  });
  assert.deepEqual(
    subjectReasons(f.db, noCreator.id),
    ["squad:sq-1=assignee"],
    "创建人未知（NULL）⇒ 只落负责人一行，不编造创建人",
  );
});

test("接线｜评论事实：写成功 ⇒ 作者落 commenter；@agent / @squad 落 mentioned；@all / 人名 / 未解析不产行；system 作者不入册", () => {
  const f = commentFixture();
  const item = f.workItemService.create({
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "评论目标",
    assignee: { type: "user", id: "user" },
    creator: { kind: "human", id: "local-user" },
  });
  const comment = (
    body: string,
    clientRequestId: string,
    author = { kind: "human" as const, id: "local-user" },
  ) =>
    f.commentService.createComment({
      workspaceKey: WS.key,
      workspacePath: WS.path,
      workItemId: item.id,
      author,
      initiatedBy: author,
      body,
      clientRequestId,
    });

  comment("看看 @Ann", "req-1");
  assert.deepEqual(
    subjectReasons(f.db, item.id),
    [`agent:${AGENT}=mentioned`, "human:local-user=commenter"],
    "作者（人）与被点名 agent 各一行：commenter 是「写过」、mentioned 是「被点名」",
  );
  const createdAt = createdAtOf(f.db, item.id, "local-user");
  comment("看看 @Ann", "req-1");
  assert.equal(
    createdAtOf(f.db, item.id, "local-user"),
    createdAt,
    "同 clientRequestId 重投：既存评论照旧，订阅行不产生新时间戳（幂等）",
  );

  comment("@all 大家看一下", "req-2");
  comment("@sq 看一下", "req-3");
  comment("@ghost 在吗", "req-4");
  comment("@李四 你看呢", "req-5");
  assert.deepEqual(
    subjectReasons(f.db, item.id),
    [`agent:${AGENT}=mentioned`, "human:local-user=commenter", "squad:sq-1=mentioned"],
    "@all 只广播不 fan-out（§12.1-3）；未解析与人名不猜身份（Q5 登记人类名册不可达）；@squad 落 squad 主体",
  );

  comment("系统代笔", "req-6", { kind: "system", id: "sys-1" });
  assert.deepEqual(
    subjectReasons(f.db, item.id).filter((entry) => entry.startsWith("system:")),
    [],
    "system 作者不产订阅行（不是可通知对象）",
  );
});

// ---------------------------------------------------------------------------
// 事实接线（二）：改派 / 归档转交（经真实 runtime，订阅行与投影同源）
// ---------------------------------------------------------------------------

async function runtimeFixture() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const published: unknown[] = [];
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
    dispatchRequestHub: {
      publish: (request) => published.push(request),
      subscribe: () => () => {},
    },
  });
  const events: string[] = [];
  runtime.subscribeWorkItemEvents((event) => events.push(event.kind));
  return { repoRoot, db, runtime, events, published };
}

test("接线｜改派事实：user_reassign ⇒ assignee；leader_tool ⇒ delegated；旧负责人行被撤销；同主体重投不产新行/新时间戳", async () => {
  const { repoRoot, db, runtime } = await runtimeFixture();
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "改派目标",
    assignee: { type: "agent", id: "ag-1" },
    creator: { kind: "human", id: "local-user" },
  });
  assert.deepEqual(subjectReasons(db, item.id), [
    "agent:ag-1=assignee",
    "human:local-user=creator",
  ]);

  applyWorkItemAssignee(
    runtime,
    { workItemId: item.id, assignee: { type: "agent", id: "ag-2" } },
    { sameAssignee: "skip", cause: "user_reassign" },
  );
  assert.deepEqual(
    subjectReasons(db, item.id),
    ["agent:ag-2=assignee", "human:local-user=creator"],
    "用户改派 ⇒ 新负责人（assignee）入册、旧负责人行**撤销**、创建人不动",
  );

  const createdAt = createdAtOf(db, item.id, "ag-2");
  applyWorkItemAssignee(
    runtime,
    { workItemId: item.id, assignee: { type: "agent", id: "ag-2" } },
    { sameAssignee: "reapply", cause: "user_reassign" },
  );
  assert.equal(subjectReasons(db, item.id).length, 2, "重投同一负责人不产第二行");
  assert.equal(createdAtOf(db, item.id, "ag-2"), createdAt, "也不产生新时间戳（幂等）");

  applyWorkItemAssignee(
    runtime,
    { workItemId: item.id, assignee: { type: "agent", id: "ag-3" } },
    { sameAssignee: "skip", cause: "leader_tool" },
  );
  assert.deepEqual(
    subjectReasons(db, item.id),
    ["agent:ag-3=delegated", "human:local-user=creator"],
    "队长派单工具 ⇒ delegated（同一关系、不同来源，两格都在撤销面内）",
  );

  applyWorkItemAssignee(
    runtime,
    { workItemId: item.id, assignee: { type: "user", id: "user" } },
    { sameAssignee: "skip", cause: "user_reassign" },
  );
  assert.deepEqual(
    subjectReasons(db, item.id),
    ["human:local-user=assignee"],
    "改派给人：占位 user:user 归一到 canonical（Q4 单源），与创建人同一行（最近事实胜）",
  );
});

test("接线｜归档转交：小队行撤销、队长落 assignee、其余负责人关系不受影响", async () => {
  const { repoRoot, db, runtime } = await runtimeFixture();
  const leader = runtime.teamAgentService.create({
    name: "L",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const member = runtime.teamAgentService.create({
    name: "M",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const squad = runtime.squadService.create({
    name: "sq",
    leaderAgentId: leader.id,
    members: [member.id],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "小队的活",
    assignee: { type: "squad", id: squad.id },
    creator: { kind: "human", id: "local-user" },
  });
  const untouched = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "别人的活",
    assignee: { type: "agent", id: "ag-other" },
  });

  await archiveSquadAndTransfer(runtime, squad.id);
  assert.deepEqual(
    subjectReasons(db, item.id),
    [`agent:${leader.id}=assignee`, "human:local-user=creator"],
    "归档转交是一次负责人变化：小队行撤销、队长行入册（reason = assignee，不是派发成因）",
  );
  assert.deepEqual(
    subjectReasons(db, untouched.id),
    ["agent:ag-other=assignee"],
    "只动该小队名下的工作项",
  );
});

// ---------------------------------------------------------------------------
// 事实接线（三）：服务面（手动订阅 / 退订 / 复活）+ 读模型 + 跨 workspace + 零派发
// ---------------------------------------------------------------------------

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function rowOf(db: DatabaseSync, workItemId: string, subjectId: string) {
  return db
    .prepare(
      `SELECT reason, opt_out_scope, tombstoned_at FROM work_item_subscribers
       WHERE work_item_id = ? AND subject_id = ?`,
    )
    .get(workItemId, subjectId) as
    | { reason: string; opt_out_scope: string; tombstoned_at: number | null }
    | undefined;
}

test("接线｜服务面：手动订阅落 manual、退订落墓碑（两档）、复活清墓碑；跨 workspace 响亮抛；全链零派发", async () => {
  const { repoRoot, db, runtime, events, published } = await runtimeFixture();
  const service = createWorkItemCollaborationService({
    createRuntime: async () => runtime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(db),
      activities: createWorkItemActivityRepo(db),
      decisions: createWorkItemDecisionRepo(db),
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => ({ kind: "human", id: "local-user" }),
  });
  const target = { path: repoRoot, identity: "ws" };
  const item = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "订阅目标",
    assignee: { type: "user", id: "user" },
    creator: { kind: "human", id: "local-user" },
  });

  // 退订（两档）之前先看自动规则能不能把它拿回来：先显式退订、再报自动事实。
  const unsubscribed = await service.setWorkItemSubscription(target, {
    workItemId: item.id,
    subscribed: false,
    scope: "subtree",
  });
  assert.equal(
    unsubscribed.reason,
    "creator",
    "墓碑保留「这行原本为什么在」（凭空退订才归 manual）—— 信息不因退订而丢掉",
  );
  assert.equal(unsubscribed.optOutScope, "subtree");
  assert.notEqual(unsubscribed.tombstonedAt, null, "退订 = 墓碑行（可审计的用户意愿）");

  runtime.subscriberFacts({
    workItemId: item.id,
    fact: { kind: "subscribe", reason: "commenter", subject: { kind: "human", id: "local-user" } },
  });
  assert.equal(
    rowOf(db, item.id, "local-user")!.tombstoned_at !== null,
    true,
    "自动规则不得复活已退订",
  );
  assert.equal(
    rowOf(db, item.id, "local-user")!.reason,
    "creator",
    "墓碑行的 reason 也不被自动事实改写",
  );

  const revived = await service.setWorkItemSubscription(target, {
    workItemId: item.id,
    subscribed: true,
  });
  assert.equal(revived.tombstonedAt, null, "只有手动订阅能复活");
  assert.equal(revived.reason, "manual", "复活后 reason 归 manual（自动规则此后删不掉它）");
  assert.equal(revived.optOutScope, "issue", "活动行恒 issue（范围只在墓碑行上有语义）");

  // 读模型：`subscribers` 原样来自 repo（含墓碑行），排序 created_at ASC, id ASC。
  const read = await service.getWorkItemCollaboration(target, item.id);
  assert.ok(read);
  assert.deepEqual(
    read.subscribers.map((row) => `${row.subjectType}:${row.subjectId}=${row.reason}`),
    ["human:local-user=manual"],
  );
  assert.equal(
    read.viewerActor.id,
    "local-user",
    "读面同时给出观察者身份（界面据此认领自己那一行）",
  );

  // 跨 workspace：另一张 workspace 的行对本 target **响亮抛**（§8.5 既有纪律）。
  const other = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws-2",
    readExperimentEnabled: () => true,
  });
  const foreign = other.workItemService.create({
    workspaceIdentity: "ws-2",
    workspacePath: repoRoot,
    title: "别人的项",
    assignee: { type: "user", id: "user" },
  });
  await assert.rejects(
    () => service.setWorkItemSubscription(target, { workItemId: foreign.id, subscribed: true }),
    /不一致/,
    "跨 workspace 的订阅写入一律响亮拒绝（不静默写进别人的库）",
  );
  await assert.rejects(() => service.getWorkItemCollaboration(target, foreign.id), /不一致/);

  // 零派发：订阅链（含手动订阅 / 退订 / 复活）不得触碰 run / receipt / 义务，也不得发派发请求。
  assert.equal(countRows(db, "squad_runs"), 0, "订阅链零 run");
  assert.equal(countRows(db, "comment_dispatch_receipts"), 0, "订阅链零派发 receipt");
  assert.equal(countRows(db, "squad_run_deferred_dispatches"), 0, "订阅链零义务");
  assert.equal(published.length, 0, "订阅链零派发请求（hub 一次都没收到）");
  assert.deepEqual(events, [], "订阅链不发工作项事件（订阅不是派发：12-11 / §12.1-12）");
});

// ---------------------------------------------------------------------------
// 结构守卫（源码扫描，去注释）：唯一 reconciler / reason 单源 / 订阅链零派发 / 存储层谓词在位
// ---------------------------------------------------------------------------

const SRC_WORKITEM = resolve(dirname(fileURLToPath(import.meta.url)), "../src/workitem");
/** 订阅链自己的三个模块（事实映射 + 判据 + 存储）。 */
const SUBSCRIBER_CHAIN_FILES = [
  "subscriberFacts.ts",
  "subscriberReconciler.ts",
  "workItemSubscriberRepo.ts",
];

function sourceOf(name: string): string {
  return readFileSync(resolve(SRC_WORKITEM, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("守卫｜唯一 reconciler：全仓恰一处调用（唯一 applier），判据不在事实点各写一份", () => {
  const files = readdirSync(SRC_WORKITEM).filter((name) => name.endsWith(".ts"));
  const callSites = files.filter(
    (name) =>
      name !== "subscriberReconciler.ts" && sourceOf(name).includes("reconcileSubscriberFacts("),
  );
  assert.deepEqual(
    callSites,
    ["subscriberFacts.ts"],
    "判据只有唯一 applier 调用：各事实点只报事实，不得各自拼 reason / 各自判 tombstone",
  );
  assert.equal(
    (sourceOf("subscriberFacts.ts").match(/reconcileSubscriberFacts\(/g) ?? []).length,
    1,
    "applier 里也只调一次（不重复判）",
  );
  /* 两种拼法都算「自拼 reason」：对象字面量（`reason: "x"`）与比较（`reason === "x"`）。
     只认第一种会从缝里漏掉消费面的比较式 —— SUB.V P3-4 之前 `commentService` 正是这么漏的
     （消费面必须经 `mentionedSubscriberSubjects` 一类具名选择器读结论）。 */
  const literalSpellers = files.filter((name) => {
    const code = sourceOf(name);
    const reasonLiteral = /"(creator|assignee|commenter|mentioned|delegated|manual)"/;
    const objectSpelling = new RegExp(`reason:\\s*${reasonLiteral.source}`);
    const comparisonSpelling = new RegExp(`reason\\s*[!=]==?\\s*${reasonLiteral.source}`);
    return objectSpelling.test(code) || comparisonSpelling.test(code);
  });
  assert.deepEqual(
    literalSpellers,
    ["subscriberFacts.ts"],
    "六 reason 的字面量只在常量模块一处（事实点与门面零字面量 —— spec §7.1「UI 不得猜 reason」的服务端一半）",
  );
});

test("守卫｜订阅链零派发（结构面）：三个新模块不含任何派发词面与生命周期写入口", () => {
  for (const name of SUBSCRIBER_CHAIN_FILES) {
    const code = sourceOf(name);
    for (const forbidden of [
      "publishDispatchRequest",
      "planDispatch",
      "openMemberRun",
      "dispatch_requested",
      "requestedDelivery",
      "squad_runs",
      "comment_dispatch_receipts",
    ]) {
      assert.ok(!code.includes(forbidden), `${name}（去注释）不得出现 ${forbidden}`);
    }
  }
});

test("守卫｜存储层谓词在位：upsert 走唯一键冲突分支；墓碑与 manual 保护写在语句里（不是先查后插）", () => {
  const code = sourceOf("workItemSubscriberRepo.ts");
  assert.ok(
    code.includes("ON CONFLICT(workspace_key, work_item_id, subject_type, subject_id)"),
    "幂等必须落在唯一键的冲突分支上（先查后插在跨连接并发下会写进两行，且不报错）",
  );
  assert.ok(code.includes("tombstoned_at IS NULL"), "活动 upsert 自带墓碑谓词（自动规则不得复活）");
  assert.equal(
    (code.match(/reason <> \?/g) ?? []).length,
    2,
    "manual 保护谓词恰两处（参数化绑定 MANUAL_SUBSCRIBER_REASON，不在 SQL 里另抄字面量）：" +
      "活动 upsert 与自动撤销各一条语句",
  );
  assert.ok(
    sourceOf("subscriberReconciler.ts").length > 0 &&
      !sourceOf("subscriberReconciler.ts").includes("db."),
    "判据模块零 IO（不碰数据库句柄）",
  );
});

test("SUB.1｜点名子集选择器：只取 `mentioned` 的订阅事实主体（作者 / 撤销 / 手动事实都不入选）", () => {
  /* 期望值来源：spec §7.1 事实表 —— 「被 `@agent` 明确点名的主体 ⇒ mentioned」。
     该子集是收件箱通知口的 `mentioned` 入参（「点名压过关注」的判据在策略模块，不在这里）。 */
  const facts: SubscriberFact[] = [
    { kind: "subscribe", reason: "commenter", subject: { kind: "agent", id: "ta-author" } },
    { kind: "subscribe", reason: "mentioned", subject: { kind: "agent", id: "ta-ann" } },
    { kind: "subscribe", reason: "mentioned", subject: { kind: "squad", id: "sq-1" } },
    { kind: "revoke", subject: { kind: "agent", id: "ta-old" } },
    { kind: "manual_subscribe", subject: { kind: "human", id: "local-user" } },
    { kind: "manual_unsubscribe", subject: { kind: "human", id: "local-user" }, scope: "issue" },
  ];
  assert.deepEqual(
    mentionedSubscriberSubjects(facts),
    [
      { kind: "agent", id: "ta-ann" },
      { kind: "squad", id: "sq-1" },
    ],
    "点名子集 = `subscribe` 且 reason 为 `mentioned` 的主体（按事实原序）；commenter 的作者不入选",
  );
  assert.deepEqual(mentionedSubscriberSubjects([]), [], "零事实 ⇒ 空点名集（不是 undefined）");
});
