import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionService } from "../src/workitem/workItemDecisionService.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* C3.1：Decision 写入服务面（任务卡 §4.3 步骤 1/2/3/4/5/6）。

   期望值全部是**手写字面量**（独立真源：规格 §3.4 / 卡 §2.3 冻结的键形状 / 卡 §4.3 的断言清单），
   不是「拿实现再算一遍」。夹具用真库（`:memory:` + 真迁移 + 真 repo），只注入时钟与 id 生成器。 */

const WORKSPACE = { path: "/tmp/c31-ws-a", identity: "c31-ws-a" };
const OTHER_WORKSPACE = { path: "/tmp/c31-ws-b", identity: "c31-ws-b" };
/** 组合根注入值的同款（测试里的独立真源）。 */
const HUMAN = { kind: "human" as const, id: "local-user" };
const CLOCK = 1_700_000_000_000;

function workItemRow(id: string, workspace = WORKSPACE) {
  return {
    id,
    workspaceIdentity: workspace.identity,
    workspacePath: workspace.path,
    title: `标题 ${id}`,
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function setup(options: { now?: () => number; newId?: () => string } = {}) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const activities = createWorkItemActivityRepo(db);
  workItems.insert(workItemRow("wi-1"));
  let generated = 0;
  const service = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: options.now ?? (() => CLOCK),
    newId: options.newId ?? (() => `dec-${++generated}`),
  });
  return { db, workItems, decisions, activities, service };
}

/* ---------- 步骤 1：写入事实 ---------- */

test("写入事实｜一次 createDecision ⇒ 恰 1 行决定 + 恰 1 枚带 decisionId 锚的 decision_created 活动", () => {
  const f = setup({ newId: () => "dec-1" });
  const decision = f.service.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal",
    subject: "采用方案 B",
    rationale: "成本低",
    author: HUMAN,
    sourceRequestId: "req-1",
  });

  // 决定行：每个字段的期望值都是独立真源（入参 / 规格 / 冻结键形状）。
  assert.equal(decision.id, "dec-1");
  assert.equal(decision.workspaceKey, WORKSPACE.identity);
  assert.equal(decision.workspacePath, WORKSPACE.path);
  assert.equal(decision.workItemId, "wi-1");
  assert.equal(decision.threadId, null, "v1 不传 threadId（恒 null）");
  assert.equal(decision.parentDecisionId, null);
  assert.deepEqual(decision.author, HUMAN);
  assert.deepEqual(decision.initiatedBy, HUMAN, "initiatedBy 缺省 = author（人类直接操作时同体）");
  assert.equal(decision.sourceRunId, null, "人类写入不伪造 run 归属");
  assert.equal(decision.kind, "proposal");
  assert.equal(decision.subject, "采用方案 B");
  assert.deepEqual(decision.selection, {}, "selection 恒 {}（v1 不闭集化、不进表单）");
  assert.equal(decision.rationale, "成本低");
  assert.deepEqual(decision.evidence, [], "evidence 恒 []（v1 不进表单）");
  assert.equal(decision.effectiveAt, CLOCK, "effectiveAt 缺省 = now()");
  assert.equal(decision.createdAt, CLOCK);
  // 卡 §2.3 冻结的写者形状（字面量），不是拿实现再算一遍。
  assert.equal(decision.dedupKey, "decision:wi-1:采用方案 B:human:local-user:req-1");

  // 活动行：恰好一枚，且**锚回决定行**（缺锚 ⇒ UI 静默降级 link-error）。
  const activities = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.equal(activities.length, 1);
  const activity = activities[0]!;
  assert.equal(activity.kind, "decision_created");
  assert.equal(activity.decisionId, decision.id);
  assert.equal(activity.commentId, null);
  assert.equal(activity.dispatchEventId, null);
  assert.equal(activity.sequence, 1, "首枚活动 sequence 从 1 起（语句内 MAX+1 的既有口径）");
  assert.equal(activity.occurredAt, CLOCK);
  assert.deepEqual(activity.actor, HUMAN);
  assert.deepEqual(activity.initiatedBy, HUMAN);
  assert.equal(activity.sourceRun, null);
  assert.equal(activity.workItemId, "wi-1");
  assert.equal(activity.workspaceKey, WORKSPACE.identity);
  assert.equal(activity.workspacePath, WORKSPACE.path);
  assert.equal(activity.dedupKey, "decision:dec-1:created");

  assert.equal(countRows(f.db, "work_item_decisions"), 1);
  assert.equal(countRows(f.db, "work_item_activities"), 1);
});

/* ---------- 步骤 2：幂等（§8.1） ---------- */

test("幂等｜同 (workItemId, subject, initiatedBy, sourceRequestId) 重投不翻倍；换 subject 或换请求 id ⇒ 新行新活动", () => {
  let clock = CLOCK;
  const f = setup({ now: () => clock });

  const base = {
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal" as const,
    subject: "方案 B",
    author: HUMAN,
    sourceRequestId: "req-1",
  };
  const first = f.service.createDecision(base);
  assert.equal(first.id, "dec-1");

  // 同请求重投（UI 重试沿用同一 sourceRequestId；时钟已前进）⇒ 既存行原样返回，不改写时间戳。
  clock = CLOCK + 5_000;
  const retry = f.service.createDecision({ ...base, rationale: "重投时多写理由也不得改写既存行" });
  assert.equal(retry.id, first.id, "同键重投返回既存行（含原 id）");
  assert.equal(retry.createdAt, CLOCK, "既存事实一字不动（重投不刷新时间戳）");
  assert.equal(countRows(f.db, "work_item_decisions"), 1, "重投不产生第二行决定");
  assert.equal(
    countRows(f.db, "work_item_activities"),
    1,
    "重投不写第二条活动（活动键由既存决定的 id 派生 ⇒ INSERT OR IGNORE）",
  );

  // 换 subject（同请求 id）⇒ 不同裁决的请求：新行 + 新活动。
  const otherSubject = f.service.createDecision({ ...base, subject: "方案 C" });
  assert.notEqual(otherSubject.id, first.id, "不同 subject = 不同裁决 ⇒ 新行");
  let activities = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.deepEqual(
    activities.map((activity) => [activity.sequence, activity.decisionId]),
    [
      [1, first.id],
      [2, otherSubject.id],
    ],
    "两条决定各写一枚活动，sequence 顺延",
  );

  // 换 sourceRequestId（同 subject）⇒ 另一次明确请求：新行 + 新活动。
  const otherRequest = f.service.createDecision({ ...base, sourceRequestId: "req-2" });
  assert.notEqual(otherRequest.id, first.id, "不同请求 id = 另一次明确请求 ⇒ 新行");
  activities = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.deepEqual(
    activities.map((activity) => [activity.sequence, activity.decisionId]),
    [
      [1, first.id],
      [2, otherSubject.id],
      [3, otherRequest.id],
    ],
  );
  assert.equal(countRows(f.db, "work_item_decisions"), 3);
});

/* ---------- 步骤 3：kind 闭集与父规则（§2.2） ---------- */

test("kind 与父规则｜闭集外/空白 subject/坏父一律响亮拒且零写入；合法 superseded/reopened 落父引用且旧行一字不动", () => {
  const f = setup();
  f.workItems.insert(workItemRow("wi-2"));
  const input = (overrides: Record<string, unknown> = {}) => ({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal" as const,
    subject: "方案 B",
    author: HUMAN,
    sourceRequestId: "req-1",
    ...overrides,
  });

  // 先落一条 accepted 作为合法父（行数基线从此开始；后续合法写入会刷新基线）。
  const accepted = f.service.createDecision(input({ kind: "accepted", sourceRequestId: "req-a" }));
  const baseline = {
    decisions: countRows(f.db, "work_item_decisions"),
    activities: countRows(f.db, "work_item_activities"),
  };
  const refreshBaseline = () => {
    baseline.decisions = countRows(f.db, "work_item_decisions");
    baseline.activities = countRows(f.db, "work_item_activities");
  };
  const assertZeroWrites = (why: string) => {
    assert.equal(countRows(f.db, "work_item_decisions"), baseline.decisions, why);
    assert.equal(countRows(f.db, "work_item_activities"), baseline.activities, why);
  };

  // 闭集外 kind：服务面响亮拒（不指望 repo 兜）。
  assert.throws(
    () => f.service.createDecision(input({ kind: "bogus" as never, sourceRequestId: "req-x" })),
    /kind/,
  );
  assertZeroWrites("非法 kind 不得留下任何事实");

  // subject 空白（trim 后空）⇒ 拒。
  for (const blank of ["", "   ", "\t\n "]) {
    assert.throws(
      () => f.service.createDecision(input({ subject: blank, sourceRequestId: "req-x" })),
      /subject|事项/,
    );
    assertZeroWrites("空白 subject 不得留下任何事实");
  }

  // 工作项不存在 ⇒ 拒（决定不得指向空气）。
  assert.throws(
    () => f.service.createDecision(input({ workItemId: "wi-missing", sourceRequestId: "req-x" })),
    /不存在/,
  );
  assertZeroWrites("不存在的工作项不得留下任何事实");

  // superseded / reopened 缺父 ⇒ 拒（父决定必填）。
  for (const kind of ["superseded", "reopened"] as const) {
    assert.throws(
      () => f.service.createDecision(input({ kind, sourceRequestId: "req-x" })),
      /父|parent/,
      `${kind} 缺 parentDecisionId 必须响亮拒`,
    );
    assertZeroWrites(`${kind} 缺父不得留下任何事实`);
  }

  // 父不存在 ⇒ 拒。
  assert.throws(
    () =>
      f.service.createDecision(
        input({ kind: "superseded", parentDecisionId: "dec-missing", sourceRequestId: "req-x" }),
      ),
    /不存在/,
  );
  assertZeroWrites("父不存在不得留下任何事实");

  // 父属**另一工作项** ⇒ 拒。
  const onWi2 = f.service.createDecision(
    input({ workItemId: "wi-2", subject: "另一项的决定", sourceRequestId: "req-w2" }),
  );
  refreshBaseline();
  assert.throws(
    () =>
      f.service.createDecision(
        input({ kind: "superseded", parentDecisionId: onWi2.id, sourceRequestId: "req-x" }),
      ),
    /工作项|workItem/,
  );
  assertZeroWrites("跨工作项父不得留下任何事实");

  // 父属**另一 workspace** ⇒ 拒（父行走 repo 直接落，绕过服务面的 workspace 校验）。
  const foreign = f.decisions.add({
    id: "dec-foreign",
    workspaceKey: OTHER_WORKSPACE.identity,
    workspacePath: OTHER_WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    kind: "accepted",
    subject: "别人家的决定",
    effectiveAt: CLOCK,
    dedupKey: "decision:foreign",
    createdAt: CLOCK,
  });
  refreshBaseline(); // 直落父行是夹具写入，不属于被测路径 ⇒ 刷新基线
  assert.throws(
    () =>
      f.service.createDecision(
        input({ kind: "superseded", parentDecisionId: foreign.id, sourceRequestId: "req-x" }),
      ),
    /不一致|workspace/,
  );

  // 父 = 自身 id ⇒ 拒（预生成 id 与父同一个）。
  f.decisions.add({
    id: "dec-self",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    kind: "accepted",
    subject: "自指基线",
    effectiveAt: CLOCK,
    dedupKey: "decision:self-baseline",
    createdAt: CLOCK,
  });
  refreshBaseline(); // 同上：夹具写入不算被测路径
  assert.throws(
    () =>
      f.service.createDecision(
        input({
          id: "dec-self",
          kind: "superseded",
          parentDecisionId: "dec-self",
          sourceRequestId: "req-x",
        }),
      ),
    /自身|self|同一个/,
  );

  // reopened 的父必须是已结的决定（accepted/rejected/superseded）；proposal 是死格。
  const pendingProposal = f.service.createDecision(
    input({ kind: "proposal", subject: "还没结的提议", sourceRequestId: "req-p2" }),
  );
  refreshBaseline();
  assert.throws(
    () =>
      f.service.createDecision(
        input({
          kind: "reopened",
          parentDecisionId: pendingProposal.id,
          sourceRequestId: "req-x",
        }),
      ),
    /reopened|已结|proposal/,
  );

  // 合法：superseded → accepted 新行带父引用，旧行逐列读回不变。
  const oldRowBefore = JSON.stringify(
    f.db.prepare("SELECT * FROM work_item_decisions WHERE id = ?").get(accepted.id),
  );
  const superseded = f.service.createDecision(
    input({
      kind: "superseded",
      subject: "方案 B（修订）",
      parentDecisionId: accepted.id,
      sourceRequestId: "req-s",
    }),
  );
  assert.equal(superseded.parentDecisionId, accepted.id);
  assert.equal(superseded.kind, "superseded");
  assert.equal(
    JSON.stringify(f.db.prepare("SELECT * FROM work_item_decisions WHERE id = ?").get(accepted.id)),
    oldRowBefore,
    "旧决定一字不动（§5.1 只增不改）",
  );

  // 合法：reopened → accepted（父 kind ∈ {accepted, rejected, superseded}）。
  const reopened = f.service.createDecision(
    input({
      kind: "reopened",
      subject: "重新审议方案 B",
      parentDecisionId: accepted.id,
      sourceRequestId: "req-r",
    }),
  );
  assert.equal(reopened.parentDecisionId, accepted.id);
  assert.equal(reopened.kind, "reopened");
  assert.deepEqual(
    f.decisions
      .listByWorkItem(WORKSPACE.identity, "wi-1")
      .filter((row) => row.id !== "dec-self") // 夹具基线行（自指用例的父），不属被测路径
      .map((row) => [row.kind, row.parentDecisionId]),
    [
      ["accepted", null],
      ["proposal", null],
      ["superseded", accepted.id],
      ["reopened", accepted.id],
    ],
    "排序口径原样（effectiveAt ASC, id ASC）且两条写入父引用正确",
  );
});

/* ---------- 步骤 4：零副作用（§4.4「Decision 被创建 ⇒ 绝不触发」的实体断言） ---------- */

test("零副作用｜决定写入前后 work_items 整行快照逐列相等；runs/receipts/义务零新增；活动集只有 decision_created", () => {
  const f = setup();
  // 先落三张「派发面」表的种子行：让「行数不变」不是空表对空表的空转。
  createSquadRunRepo(f.db).insert({
    runId: "run-seed",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: "ag-1",
    isLeaderTask: false,
    branch: "b/c31",
    dirName: "c31",
    status: "discarded",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  createCommentDispatchReceiptRepo(f.db).insertIfAbsent({
    dispatchKey: "seed-key",
    workspaceKey: WORKSPACE.identity,
    workItemId: "wi-1",
    targetAgentId: "ag-1",
    commentId: "c-seed",
    threadId: "c-seed",
    source: "issue_assignee",
    outcome: "pending",
    createdAt: CLOCK,
  });
  createSquadDeferredDispatchRepo(f.db).insertIfAbsent({
    runId: "seed-key",
    workspaceKey: WORKSPACE.identity,
    workItemId: "wi-1",
    agentId: "ag-2",
    dispatchCause: null,
    origin: "comment",
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });

  const workItemsBefore = JSON.stringify(f.db.prepare("SELECT * FROM work_items").all());
  const dispatchFactsBefore = [
    countRows(f.db, "squad_runs"),
    countRows(f.db, "comment_dispatch_receipts"),
    countRows(f.db, "squad_run_deferred_dispatches"),
  ];
  assert.deepEqual(dispatchFactsBefore, [1, 1, 1], "种子行就位（否则下面的不变式是空转）");

  f.service.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "accepted",
    subject: "方案 B",
    author: HUMAN,
    sourceRequestId: "req-1",
  });

  assert.equal(
    JSON.stringify(f.db.prepare("SELECT * FROM work_items").all()),
    workItemsBefore,
    "决定绝不写 WorkItem（整行快照逐列相等——status/assignee 一字不动，§5.2）",
  );
  assert.deepEqual(
    [
      countRows(f.db, "squad_runs"),
      countRows(f.db, "comment_dispatch_receipts"),
      countRows(f.db, "squad_run_deferred_dispatches"),
    ],
    dispatchFactsBefore,
    "决定绝不派发：run 台账 / 派发回执 / 完成重放义务三表零新增（§4.4）",
  );
  assert.deepEqual(
    f.activities.listByWorkItem(WORKSPACE.identity, "wi-1").map((activity) => activity.kind),
    ["decision_created"],
    "活动集只有 decision_created：不产生 comment_* / status_changed / 任何派发事实",
  );
});

/* ---------- 步骤 5：读面闭合（时间线锚定的服务面合同） ---------- */

test("读面闭合｜经门面写入后读回：decisions 含新行、activities 的 decisionId 指得回那一行（UI 的 link-error 分支不可达）", async () => {
  const f = setup();
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ workItemRepo: f.workItems, boundWorkspace: WORKSPACE }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(f.db),
      activities: f.activities,
      decisions: f.decisions,
      reactions: createWorkItemCommentReactionRepo(f.db),
      receipts: createCommentDispatchReceiptRepo(f.db),
    }),
    localHumanActor: () => HUMAN,
    createDecisionService: () => f.service,
  });

  const written = await service.createWorkItemDecision(WORKSPACE, {
    workItemId: "wi-1",
    kind: "proposal",
    subject: "采用方案 B",
    sourceRequestId: "req-1",
  });

  const read = await service.getWorkItemCollaboration(WORKSPACE, "wi-1");
  assert.ok(read !== null);
  assert.deepEqual(
    read.decisions.map((row) => row.id),
    [written.id],
    "读面 decisions 含刚写入的那一行",
  );
  const anchored = read.activities.filter((activity) => activity.kind === "decision_created");
  assert.deepEqual(
    anchored.map((activity) => activity.decisionId),
    [written.id],
    "decision_created 的 decisionId 指回决定行（缺锚 ⇒ UI 静默降级成「关联活动不可用」）",
  );
});

/* ---------- 步骤 6：workspace 隔离 ---------- */

test("workspace 隔离｜异己 key 传同 workItemId 响亮拒且零写入；两个 workspace 各写一条各自只见自己", () => {
  const f = setup();
  f.workItems.insert(workItemRow("wi-b", OTHER_WORKSPACE));

  const before = countRows(f.db, "work_item_decisions");
  assert.throws(
    () =>
      f.service.createDecision({
        workspaceKey: OTHER_WORKSPACE.identity, // 拿 b 的 key 指 wi-1（a 的工作项）
        workspacePath: OTHER_WORKSPACE.path,
        workItemId: "wi-1",
        kind: "proposal",
        subject: "越界",
        author: HUMAN,
        sourceRequestId: "req-x",
      }),
    /不一致/,
    "跨 workspace 引用必须响亮拒（不静默写进「别人家」的库）",
  );
  assert.equal(countRows(f.db, "work_item_decisions"), before);
  assert.equal(countRows(f.db, "work_item_activities"), 0);

  const inA = f.service.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal",
    subject: "a 的决定",
    author: HUMAN,
    sourceRequestId: "req-a",
  });
  const inB = f.service.createDecision({
    workspaceKey: OTHER_WORKSPACE.identity,
    workspacePath: OTHER_WORKSPACE.path,
    workItemId: "wi-b",
    kind: "proposal",
    subject: "b 的决定",
    author: HUMAN,
    sourceRequestId: "req-b",
  });

  assert.deepEqual(
    f.decisions.listByWorkItem(WORKSPACE.identity, "wi-1").map((row) => [row.id, row.subject]),
    [[inA.id, "a 的决定"]],
  );
  assert.deepEqual(
    f.decisions
      .listByWorkItem(OTHER_WORKSPACE.identity, "wi-b")
      .map((row) => [row.id, row.subject]),
    [[inB.id, "b 的决定"]],
  );
  assert.equal(
    f.activities.listByWorkItem(WORKSPACE.identity, "wi-1").length,
    1,
    "活动也按 workspace 隔离（b 的决定不在 a 的时间线上）",
  );
});

/* ---------- 归档项（主会话裁定 Q4：服务面允许 + UI 禁用；本轮只做服务面 = 允许） ---------- */

test("归档项｜服务面允许写入决定且 activity 照写（写事实不因归档被拒，与评论「可审计不可派发」同族）", () => {
  const f = setup();
  f.workItems.insert({ ...workItemRow("wi-arch"), archivedAt: CLOCK });

  const decision = f.service.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-arch",
    kind: "accepted",
    subject: "归档项的裁决",
    author: HUMAN,
    sourceRequestId: "req-arch",
  });

  assert.equal(decision.workItemId, "wi-arch");
  assert.equal(countRows(f.db, "work_item_decisions"), 1);
  const activities = f.activities.listByWorkItem(WORKSPACE.identity, "wi-arch");
  assert.deepEqual(
    activities.map((activity) => [activity.kind, activity.decisionId]),
    [["decision_created", decision.id]],
    "归档项的决定同样落锚定活动（否则归档时间线看不到这条裁决）",
  );
  // 服务面走含归档读口（归档行对 get 不可见——这正是「允许写」必须显式经 getIncludingArchived 的原因）。
  assert.equal(f.workItems.get("wi-arch"), null);
  assert.notEqual(f.workItems.getIncludingArchived("wi-arch"), null);
});
