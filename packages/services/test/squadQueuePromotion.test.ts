import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createSquadRunSettlementHub, type SquadRunSettlement } from "../src/workitem/squadRunSettlementHub.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* C4a：排队行的认领升级（推进入口 = 重放同 runId）与结算事实发布。
   host 侧的「结算事件 → 扫描 → 重投」回路与启动恢复在 C4b 接线。 */

async function makeDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

async function promotionSetup(maxConcurrentRuns = 1) {
  const repoRoot = await makeRepo();
  const db = await makeDb();
  const hub = createSquadRunSettlementHub();
  const settlements: SquadRunSettlement[] = [];
  hub.subscribe((event) => settlements.push(event));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
    runSettlementHub: hub,
  });
  const agent = runtime.teamAgentService.create({
    name: "p-agent", systemPrompt: "s", memoryScope: "project", maxConcurrentRuns,
  });
  const open = (runId: string, workItemId: string) =>
    runtime.lifecycle.openMemberRun({
      runId, workItemId, parentWorkItemId: "wi-p", agentId: agent.id, isLeaderTask: false,
    });
  return { runtime, agentId: agent.id, open, settlements };
}

test("推进：容量释放后重放同 runId ⇒ 认领升级为 opened（建树 + patch 分支）", async () => {
  const { runtime, open } = await promotionSetup(1);
  assert.equal((await open("run-1", "wi-1")).kind, "opened");
  assert.equal((await open("run-2", "wi-2")).kind, "queued");

  // 容量释放（open→produced 只需台账推进；produced 不占容量）。
  runtime.squadRunRepo.setStatus("run-1", "produced");
  const promoted = await open("run-2", "wi-2");
  assert.equal(promoted.kind, "opened", "重放同 runId = 推进入口，认领成功");
  const row = runtime.squadRunRepo.get("run-2")!;
  assert.equal(row.status, "open");
  assert.ok(row.branch !== null && row.branch.startsWith("squad/member/"), "认领后 patch 分支");
  assert.ok(row.dirName !== null, "认领后 patch 目录名");
  assert.ok(
    promoted.kind === "opened" && promoted.branch === row.branch,
    "返回的分支与台账一致（同一 plan）",
  );

  // 推进后重放同 runId ⇒ already_registered（行已是 open，走既有忙探测路径）。
  assert.equal((await open("run-2", "wi-2")).kind, "already_registered");
});

test("认领原子性：容量仍满时重放 ⇒ 仍排队（不偷跑、不建树）", async () => {
  const { runtime, open } = await promotionSetup(1);
  assert.equal((await open("run-1", "wi-1")).kind, "opened");
  assert.equal((await open("run-2", "wi-2")).kind, "queued");
  // 重放（推进入口）：run-1 仍 open 占容量 ⇒ 认领的容量子查询必须不放行。
  const again = await open("run-2", "wi-2");
  assert.equal(again.kind, "queued", "容量仍满 ⇒ 认领不放行（偷跑会超上限并发）");
  const row = runtime.squadRunRepo.get("run-2")!;
  assert.equal(row.status, "queued");
  assert.equal(row.branch, null, "未认领 ⇒ 未建树未 patch");
});

test("结算发布：failMemberRun / completeLeaderRun 之后 hub 收到事实（含 agentId）", async () => {
  const { runtime, agentId, settlements } = await promotionSetup(6);
  await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
  });
  await runtime.lifecycle.failMemberRun({ runId: "run-1", reason: "test" });
  assert.deepEqual(
    settlements.filter((e) => e.runId === "run-1").map((e) => e.status),
    ["discarded"],
    "失败收尾也发布结算事实（释放容量 ⇒ 队列可推进）",
  );
  assert.equal(settlements[0]!.agentId, agentId, "事实带 agentId（推进扫描按 agent 找排队行）");

  await runtime.lifecycle.recordLeaderRun({ runId: "lead-1", workItemId: "wi-2", agentId });
  await runtime.lifecycle.completeLeaderRun({ runId: "lead-1" });
  assert.deepEqual(
    settlements.filter((e) => e.runId === "lead-1").map((e) => e.status),
    ["merged"],
    "队长成功收尾发布 merged（其余收尾路径同经 settleStatus 单点）",
  );
});

test("不注入 hub ⇒ 不发布也不影响收尾（可选加法，向后兼容）", async () => {
  const repoRoot = await makeRepo();
  const db = await makeDb();
  const runtime = await createSquadRuntime({
    db, workspacePath: repoRoot, workspaceIdentity: "ws", readExperimentEnabled: () => true,
  });
  const agent = runtime.teamAgentService.create({
    name: "n-agent", systemPrompt: "s", memoryScope: "project",
  });
  await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId: agent.id, isLeaderTask: false,
  });
  await runtime.lifecycle.failMemberRun({ runId: "run-1", reason: "test" });
  assert.equal(runtime.squadRunRepo.get("run-1")!.status, "discarded");
});
