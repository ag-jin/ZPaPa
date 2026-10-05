import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* C3 派发闸的行为面：容量口径（count(open)）、开树之前判定、并入、already_registered、
   队长「吸收优先于排队」（A8）、A5 名册缺席不闸。闸的存储语句级用例见 squadRunRepo.test.ts。 */

async function makeDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

async function gateSetup(agentInput?: { maxConcurrentRuns?: number }) {
  const repoRoot = await makeRepo();
  const db = await makeDb();
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
  });
  // 名册经唯一写者（teamAgentService）建：有定义 ⇒ 闸生效（显式值或缺省 6）。
  const agent = agentInput
    ? runtime.teamAgentService.create({
        name: "gate-agent",
        systemPrompt: "s",
        memoryScope: "project",
        ...(agentInput.maxConcurrentRuns !== undefined
          ? { maxConcurrentRuns: agentInput.maxConcurrentRuns }
          : {}),
      })
    : null;
  return { runtime, agentId: agent?.id ?? "ta-unknown" };
}

test("闸满：容量 1 ⇒ 第一条直开（有树），第二条排队（无树），第三条并入", async () => {
  const { runtime, agentId } = await gateSetup({ maxConcurrentRuns: 1 });
  const first = await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(first.kind, "opened");
  assert.ok(first.kind === "opened" && first.branch.length > 0, "开跑结论带分支");

  const second = await runtime.lifecycle.openMemberRun({
    runId: "run-2", workItemId: "wi-2", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(second.kind, "queued", "容量满 ⇒ 排队（不开树）");
  const row = runtime.squadRunRepo.get("run-2")!;
  assert.equal(row.status, "queued");
  assert.equal(row.branch, null, "闸满不留树：排队行 branch=NULL");
  assert.equal(row.dirName, null);

  const third = await runtime.lifecycle.openMemberRun({
    runId: "run-3", workItemId: "wi-2", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(third.kind, "coalesced");
  assert.equal(third.targetRunId, "run-2", "并入既存排队行（至多一个待开）");
});

test("容量口径：produced 不占并发容量（占树≠占容量，C0 十点之 10）", async () => {
  const { runtime, agentId } = await gateSetup({ maxConcurrentRuns: 1 });
  await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  runtime.squadRunRepo.setStatus("run-1", "produced");
  const second = await runtime.lifecycle.openMemberRun({
    runId: "run-2", workItemId: "wi-2", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(second.kind, "opened", "produced 仍占树但不占容量 ⇒ 照常开跑");
});

test("A5：名册缺席 ⇒ 不闸照旧派发（不套缺省 6）", async () => {
  const { runtime } = await gateSetup(); // 未建任何 agent
  for (const runId of ["run-1", "run-2"]) {
    const out = await runtime.lifecycle.openMemberRun({
      runId, workItemId: `wi-${runId}`, parentWorkItemId: "wi-p", agentId: "ta-ghost", isLeaderTask: false,
    });
    assert.equal(out.kind, "opened", "名册里没有该 agent ⇒ 不设限（默认值都不套）");
  }
});

test("R5：同 runId 重投 ⇒ already_registered，不重复建树/登记", async () => {
  const { runtime, agentId } = await gateSetup({ maxConcurrentRuns: 1 });
  const first = await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(first.kind, "opened");
  const again = await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  assert.equal(again.kind, "already_registered", "重投不炸主键、不建第二棵树");
  const rows = runtime.squadRunRepo.listByWorkItem("wi-1");
  assert.equal(rows.length, 1, "台账仍只有一行");
});

test("队长：吸收优先于排队（A8）——活跃队长行存在时，即便容量满也吸收不排队", async () => {
  const { runtime, agentId } = await gateSetup({ maxConcurrentRuns: 1 });
  const first = await runtime.lifecycle.recordLeaderRun({ runId: "lead-1", workItemId: "wi-1", agentId });
  assert.deepEqual(first, { recorded: true });
  // 此刻该 agent 的 open 计数=1（队长行）≥ 上限；对同一工作项的重复指派必须**吸收**（S13）而非排队。
  const second = await runtime.lifecycle.recordLeaderRun({ runId: "lead-2", workItemId: "wi-1", agentId });
  assert.deepEqual(
    second,
    { recorded: false, reason: "in_progress_run_exists" },
    "吸收判据优先于容量：不得把重复指派变成排队（那是 S13 明令禁止的第二次 run 形态）",
  );
  // 无活跃队长行（另一工作项）且容量满 ⇒ 队长排队格；再投 ⇒ 并入（仍一个排队行）。
  const queuedElsewhere = await runtime.lifecycle.recordLeaderRun({ runId: "lead-3", workItemId: "wi-9", agentId });
  assert.deepEqual(queuedElsewhere, { recorded: false, reason: "capacity_full_queued" });
  const queuedRow = runtime.squadRunRepo.get("lead-3")!;
  assert.equal(queuedRow.status, "queued");
  assert.equal(queuedRow.isLeaderTask, true);
  assert.equal(queuedRow.branch, null);
  const coalescedLeader = await runtime.lifecycle.recordLeaderRun({ runId: "lead-4", workItemId: "wi-9", agentId });
  assert.deepEqual(coalescedLeader, { recorded: false, reason: "capacity_full_queued" });
  const queuedCount = runtime.squadRunRepo.listQueued("ws");
  assert.equal(queuedCount.length, 1, "队长排队行同样至多一个");
});

test("队长容量放宽：runId 复用仍响亮抛（既有纪律不因闸而松动）", async () => {
  const { runtime, agentId } = await gateSetup({ maxConcurrentRuns: 6 });
  await runtime.lifecycle.recordLeaderRun({ runId: "lead-1", workItemId: "wi-1", agentId });
  await runtime.lifecycle.completeLeaderRun({ runId: "lead-1" });
  // lead-1 已终态：runId 复用不是 already_registered（那是队员 run 的重投语义），队长口径保持响亮抛。
  await assert.rejects(
    () => runtime.lifecycle.recordLeaderRun({ runId: "lead-1", workItemId: "wi-1", agentId }),
    /run_id|runId/,
  );
});
