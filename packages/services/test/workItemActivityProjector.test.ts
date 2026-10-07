import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { WorkItem } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  computeAssigneeChangedDedupKey,
  computeRunCancelledDedupKey,
  computeRunCompletedDedupKey,
  computeRunFailedDedupKey,
  computeRunStartedDedupKey,
  computeStatusChangedDedupKey,
  computeWorktreeCreatedDedupKey,
  computeWorktreeDiscardedDedupKey,
  computeWorktreeMergedDedupKey,
  createWorkItemActivityProjector,
  runSettleIntentForFailureReason,
} from "../src/workitem/workItemActivityProjector.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";

/* C3b.1：Activity 投影深模块（设计 §5 逐枚表 / §7 模块设计）。

   期望值全部是**手写字面量**（独立真源 = 设计报告 §5 的冻结键形状与 payload 表），不是「拿实现再算一遍」。
   夹具用真库（`:memory:` + 真迁移 + 真 activities repo），只注入时钟与 logWarn 收集器。 */

const WORKSPACE = { path: "/tmp/c3b1-ws", identity: "c3b1-ws" };
const CLOCK = 1_700_000_000_000;

function itemRow(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    title: "标题 wi-1",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u-1" },
    labels: [],
    properties: {},
    position: 0,
    ...overrides,
  };
}

function setup(options: { now?: () => number } = {}) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const activities = createWorkItemActivityRepo(db);
  const warnings: string[] = [];
  const projector = createWorkItemActivityProjector({
    activities,
    now: options.now ?? (() => CLOCK),
    logWarn: (message) => warnings.push(message),
  });
  return { db, activities, projector, warnings };
}

test("status_changed：恰一枚，键 / payload / actor / 工作区锚按冻结形状（字面量断言）", () => {
  const f = setup();
  f.projector.statusChanged({ item: itemRow(), from: "todo", to: "in_progress" });

  const rows = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.equal(rows.length, 1, "一次投影恰一枚");
  const row = rows[0]!;
  assert.equal(row.kind, "status_changed");
  assert.equal(row.dedupKey, "status:wi-1:todo:in_progress:1700000000000");
  assert.equal(row.id, "activity-status-wi-1-todo-in_progress-1700000000000");
  assert.deepEqual(row.payload, { from: "todo", to: "in_progress" });
  assert.deepEqual(row.actor, { kind: "system", id: "squad-runtime" });
  assert.deepEqual(row.initiatedBy, { kind: "system", id: "squad-runtime" });
  assert.equal(row.sourceRun, null, "工作项两枚不带 run 归属（不猜角色）");
  assert.equal(row.occurredAt, CLOCK);
  assert.equal(row.sequence, 1);
  assert.equal(row.workspaceKey, WORKSPACE.identity);
  assert.equal(row.workspacePath, WORKSPACE.path);
  assert.equal(row.commentId, null);
  assert.equal(row.decisionId, null);
  assert.equal(row.dispatchEventId, null);
});

test("assignee_changed：键带双侧类型与 id；cause 只在调用方给出时进 payload（不发明闭集外值）", () => {
  const f = setup();
  f.projector.assigneeChanged({
    item: itemRow(),
    from: { type: "squad", id: "sq-1" },
    to: { type: "agent", id: "ta-9" },
    cause: "user_reassign",
  });
  f.projector.assigneeChanged({
    item: itemRow({ id: "wi-2" }),
    from: { type: "squad", id: "sq-1" },
    to: { type: "agent", id: "ta-9" },
  });

  const withCause = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1")[0]!;
  assert.equal(withCause.kind, "assignee_changed");
  assert.equal(withCause.dedupKey, "assignee:wi-1:squad:sq-1:agent:ta-9:1700000000000");
  assert.deepEqual(withCause.payload, {
    from: { type: "squad", id: "sq-1" },
    to: { type: "agent", id: "ta-9" },
    cause: "user_reassign",
  });
  assert.deepEqual(withCause.actor, { kind: "system", id: "squad-runtime" });
  assert.equal(withCause.sourceRun, null);

  // 归档转交（无 cause）：payload 不带 cause 键 —— 缺省不写，不发明闭集外的值。
  const withoutCause = f.activities.listByWorkItem(WORKSPACE.identity, "wi-2")[0]!;
  assert.deepEqual(withoutCause.payload, {
    from: { type: "squad", id: "sq-1" },
    to: { type: "agent", id: "ta-9" },
  });
  assert.ok(!("cause" in withoutCause.payload), "归档转交不得伪造成因");
});

/* ---------- run / worktree 七枚：键形状本轮冻结（接线在 C3b.2，本轮只消费不到） ---------- */

function runRecord(overrides: Partial<SquadRunRecord> = {}): SquadRunRecord {
  return {
    runId: "run-1",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: "ta-1",
    isLeaderTask: false,
    branch: "squad/member/ta-1",
    dirName: "member-ta-1",
    status: "open",
    sessionId: "sess-1",
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...overrides,
  };
}

test("九枚 dedupKey 形状一次冻结（字面量独立真源 = 设计 §5 表）", () => {
  // 工作项两枚（身份 = 工作项 + 事件，尾段毫秒区分两次合法同向迁移）
  assert.equal(
    computeStatusChangedDedupKey({
      workItemId: "wi-7",
      from: "todo",
      to: "in_progress",
      at: 1700000000000,
    }),
    "status:wi-7:todo:in_progress:1700000000000",
  );
  assert.equal(
    computeAssigneeChangedDedupKey({
      workItemId: "wi-7",
      from: { type: "squad", id: "sq-1" },
      to: { type: "user", id: "u-1" },
      at: 1700000000000,
    }),
    "assignee:wi-7:squad:sq-1:user:u-1:1700000000000",
  );
  // run / worktree 七枚（身份 = runId + 事件；对一条 run 每类事实至多一枚，故无毫秒段）
  assert.equal(computeRunStartedDedupKey("run-7"), "run:run-7:started");
  assert.equal(computeRunCompletedDedupKey("run-7"), "run:run-7:completed");
  assert.equal(computeRunFailedDedupKey("run-7"), "run:run-7:failed");
  assert.equal(computeRunCancelledDedupKey("run-7"), "run:run-7:cancelled");
  assert.equal(computeWorktreeCreatedDedupKey("run-7"), "run:run-7:worktree_created");
  assert.equal(computeWorktreeMergedDedupKey("run-7"), "run:run-7:worktree_merged");
  assert.equal(computeWorktreeDiscardedDedupKey("run-7"), "run:run-7:worktree_discarded");
});

test("runStarted：member 出口 ⇒ run_started + worktree_created 各一枚（sourceRun.role=member，无 squadId）", () => {
  const f = setup();
  f.projector.runStarted(
    runRecord({ dispatchCause: "leader_tool", causedByRunId: "run-leader-1" }),
  );

  const rows = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.equal(rows.length, 2, "建树与开跑同点发生：两枚（run_started + worktree_created）");
  const started = rows.find((row) => row.kind === "run_started")!;
  const created = rows.find((row) => row.kind === "worktree_created")!;
  assert.equal(started.dedupKey, "run:run-1:started");
  assert.deepEqual(started.payload, {
    agentId: "ta-1",
    isLeaderTask: false,
    branch: "squad/member/ta-1",
    dispatchCause: "leader_tool",
    causedByRunId: "run-leader-1",
  });
  assert.equal(created.dedupKey, "run:run-1:worktree_created");
  assert.deepEqual(created.payload, { branch: "squad/member/ta-1", agentId: "ta-1" });
  for (const row of rows) {
    // squadId 缺省不写（lifecycle 不知道 squad，宁缺毋造）；role 由 isLeaderTask 无歧义映射。
    assert.deepEqual(row.sourceRun, { runId: "run-1", agentId: "ta-1", role: "member" });
    assert.deepEqual(row.actor, { kind: "system", id: "squad-runtime" });
    assert.deepEqual(row.initiatedBy, { kind: "system", id: "squad-runtime" });
    assert.equal(row.occurredAt, CLOCK);
    assert.equal(row.workspaceKey, WORKSPACE.identity);
    assert.equal(row.workspacePath, WORKSPACE.path);
  }
});

test("runStarted：leader（无树）⇒ 只 run_started，role=leader，NULL 的 branch/cause/入边一律不写", () => {
  const f = setup();
  f.projector.runStarted(
    runRecord({ isLeaderTask: true, branch: null, dirName: null, agentId: "ta-leader" }),
  );

  const rows = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.equal(rows.length, 1, "leader 不开树 ⇒ 没有 worktree_created");
  assert.deepEqual(rows[0]!.payload, { agentId: "ta-leader", isLeaderTask: true });
  assert.deepEqual(rows[0]!.sourceRun, { runId: "run-1", agentId: "ta-leader", role: "leader" });
});

test("runSettled：五个意图各映射一枚，payload 按冻结表（status 由 isLeaderTask 定）", () => {
  const f = setup();
  f.projector.runSettled(runRecord({ runId: "run-member", status: "produced" }), {
    kind: "run_completed",
  });
  f.projector.runSettled(
    runRecord({
      runId: "run-leader",
      agentId: "ta-L",
      isLeaderTask: true,
      branch: null,
      status: "merged",
    }),
    { kind: "run_completed" },
  );
  f.projector.runSettled(runRecord({ runId: "run-fail", status: "discarded" }), {
    kind: "run_failed",
    reason: "watchdog_ttl",
  });
  f.projector.runSettled(runRecord({ runId: "run-cancel", status: "discarded" }), {
    kind: "run_cancelled",
    reason: "user_cancel",
  });
  f.projector.runSettled(runRecord({ runId: "run-merge", status: "merged" }), {
    kind: "worktree_merged",
    integration: "squad/integration/batch-1",
  });
  f.projector.runSettled(runRecord({ runId: "run-discard", status: "discarded" }), {
    kind: "worktree_discarded",
  });

  const byRow = (runId: string) => {
    const rows = f.activities
      .listByWorkItem(WORKSPACE.identity, "wi-1")
      .filter((row) => row.sourceRun?.runId === runId);
    assert.equal(rows.length, 1, `run ${runId} 恰一枚`);
    return rows[0]!;
  };

  const completed = byRow("run-member");
  assert.equal(completed.kind, "run_completed");
  assert.equal(completed.dedupKey, "run:run-member:completed");
  assert.deepEqual(completed.payload, { status: "produced", agentId: "ta-1", isLeaderTask: false });

  const leaderDone = byRow("run-leader");
  assert.deepEqual(leaderDone.payload, { status: "merged", agentId: "ta-L", isLeaderTask: true });

  const failed = byRow("run-fail");
  assert.equal(failed.kind, "run_failed");
  assert.equal(failed.dedupKey, "run:run-fail:failed");
  assert.deepEqual(failed.payload, { reason: "watchdog_ttl", agentId: "ta-1" });

  const cancelled = byRow("run-cancel");
  assert.equal(cancelled.kind, "run_cancelled");
  assert.equal(cancelled.dedupKey, "run:run-cancel:cancelled");
  assert.deepEqual(cancelled.payload, { reason: "user_cancel" });

  const merged = byRow("run-merge");
  assert.equal(merged.kind, "worktree_merged");
  assert.equal(merged.dedupKey, "run:run-merge:worktree_merged");
  assert.deepEqual(merged.payload, {
    branch: "squad/member/ta-1",
    integration: "squad/integration/batch-1",
    agentId: "ta-1",
  });

  const discarded = byRow("run-discard");
  assert.equal(discarded.kind, "worktree_discarded");
  assert.equal(discarded.dedupKey, "run:run-discard:worktree_discarded");
  assert.deepEqual(discarded.payload, { branch: "squad/member/ta-1", dirName: "member-ta-1" });
});

test("失败原因 → 意图的映射单源：user_cancel ⇒ cancelled；看门狗族与其余 ⇒ failed（码值引用而非内联）", () => {
  assert.deepEqual(runSettleIntentForFailureReason("user_cancel"), {
    kind: "run_cancelled",
    reason: "user_cancel",
  });
  for (const reason of [
    "watchdog_dead_session",
    "watchdog_ttl",
    "watchdog_idle_stop_grace_expired",
    "会话异常退出",
  ]) {
    assert.deepEqual(runSettleIntentForFailureReason(reason), { kind: "run_failed", reason });
  }
});

test("幂等重投：同一事实重投不翻倍（dedupKey 唯一索引兜底 + id 由键确定性派生）", () => {
  const f = setup();
  const item = itemRow();
  const record = runRecord();

  f.projector.statusChanged({ item, from: "todo", to: "in_progress" });
  f.projector.statusChanged({ item, from: "todo", to: "in_progress" });
  f.projector.runStarted(record);
  f.projector.runStarted(record);
  f.projector.runSettled(record, { kind: "run_completed" });
  f.projector.runSettled(record, { kind: "run_completed" });

  const rows = f.activities.listByWorkItem(WORKSPACE.identity, "wi-1");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey]),
    [
      ["status_changed", "status:wi-1:todo:in_progress:1700000000000"],
      ["run_started", "run:run-1:started"],
      ["worktree_created", "run:run-1:worktree_created"],
      ["run_completed", "run:run-1:completed"],
    ],
    "重投返回既存行：一枚事实一行，sequence 也不长",
  );
  assert.deepEqual(
    rows.map((row) => row.sequence),
    [1, 2, 3, 4],
    "sequence 连号：重投没有偷偷占号",
  );
});

test("失败面：投影写失败只留痕、不抛（已落地的事实不被回声丢失翻转成异常）", () => {
  const warnings: Array<{ message: string; error: unknown }> = [];
  const broken = {
    add() {
      throw new Error("库坏了");
    },
    get: () => null,
    listByWorkItem: () => [],
  };
  const projector = createWorkItemActivityProjector({
    activities: broken,
    now: () => CLOCK,
    logWarn: (message, error) => warnings.push({ message, error }),
  });

  assert.doesNotThrow(() =>
    projector.statusChanged({ item: itemRow(), from: "todo", to: "in_progress" }),
  );
  assert.equal(warnings.length, 1, "恰留一次痕（不静默）");
  assert.match(warnings[0]!.message, /status_changed/, "痕里带得上 kind");
  assert.match(warnings[0]!.message, /status:wi-1:todo:in_progress:1700000000000/, "痕里带得上键");
  assert.match(String((warnings[0]!.error as Error).message), /库坏了/, "痕里带得上原始错误");
});
