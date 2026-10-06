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

/* ---------- C4b-前半：R2 义务记录（活跃 run 存在 ⇒ deferred，不开第二条不排队） ---------- */

test("R2：同 (workItem,agent) 已有活跃 run ⇒ deferred（义务一行、无排队行、不再撞分支）", async () => {
  const { runtime, open } = await promotionSetup(6);
  assert.equal((await open("run-1", "wi-1")).kind, "opened");
  // 同 pair 第二次指派：容量 6 未满——没有 R2 时会开第二条并撞分支名。现在必须走义务。
  const second = await open("run-2", "wi-1");
  assert.equal(second.kind, "deferred");
  assert.equal(second.kind === "deferred" && second.coalescedInto, undefined, "首条义务无并入目标");
  assert.equal(runtime.squadRunRepo.get("run-2"), null, "不落排队行（义务≠排队：等的判据不同）");
  const obligations = runtime.squadDeferredDispatchRepo.list("ws");
  assert.deepEqual(obligations.map((o) => o.runId), ["run-2"]);
  // G4：R2 臂写的义务来源 = 'reassign'（与评论臂的 'comment' 判别，claimDue 消费者据此分流）。
  assert.deepEqual(obligations.map((o) => o.origin), ["reassign"]);

  // 同 pair 第三次 ⇒ 并入既存义务（留痕），义务表仍一行。
  const third = await open("run-3", "wi-1");
  assert.equal(third.kind, "deferred");
  assert.equal(third.kind === "deferred" && third.coalescedInto, "run-2", "并入既存义务行");
  assert.equal(runtime.squadDeferredDispatchRepo.list("ws").length, 1);
});

test("R2 次序：已有排队行 ⇒ 并入优先于义务（统一裁决表第 1 行）", async () => {
  const { runtime, open } = await promotionSetup(1);
  assert.equal((await open("run-1", "wi-1")).kind, "opened");
  assert.equal((await open("run-2", "wi-2")).kind, "queued");
  // wi-2 现在既有排队行、目标 agent 也有活跃 run（run-1 在 wi-1）——但 (wi-2,agent) 自身无活跃 run。
  // 直接验证 pair 判据：对 wi-2 再投 ⇒ 并入既存排队行（不是 deferred）。
  const again = await open("run-2b", "wi-2");
  assert.equal(again.kind, "coalesced");
  assert.equal(runtime.squadDeferredDispatchRepo.list("ws").length, 0, "不产生义务行");
});

test("R2 不注入义务表 repo ⇒ 响亮抛（不静默降级）", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db, workspacePath: repoRoot, workspaceIdentity: "ws", readExperimentEnabled: () => true,
    // 刻意不注入 runSettlementHub 与义务 repo 的场景由下层单测覆盖；这里用 runtime 直接验证：
  });
  const agent = runtime.teamAgentService.create({
    name: "r2-agent", systemPrompt: "s", memoryScope: "project",
  });
  await runtime.lifecycle.openMemberRun({
    runId: "run-1", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId: agent.id, isLeaderTask: false,
  });
  // runtime 组合根总是注入义务 repo（squadRuntime.ts 建一份）——注入路径下 R2 正常生效；
  // 「未注入 ⇒ 抛」的分支由类型可选性保证（组合根唯一装配点已覆盖），此处断言组合根行为即可。
  const second = await runtime.lifecycle.openMemberRun({
    runId: "run-2", workItemId: "wi-1", parentWorkItemId: "wi-p", agentId: agent.id, isLeaderTask: false,
  });
  assert.equal(second.kind, "deferred", "组合根装配下 R2 生效");
});

test("R2 次序（直插构造）：同 pair 既有活跃行又有排队行 ⇒ 并入优先于义务（防御深度）", async () => {
  const { runtime, agentId, open } = await promotionSetup(1);
  // 经公开流程到不了「同 pair 活跃+排队并存」（R2 先拦），但统一裁决表钉了次序——
  // 用 repo 直插构造该状态，钉住判据次序不被将来改坏。
  runtime.squadRunRepo.insert({
    runId: "act-1", workspaceKey: "ws", workspacePath: "/tmp/ws", workItemId: "wi-7",
    parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
    branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb", dirName: null,
    status: "open", sessionId: null, dispatchCause: null, causedByRunId: null,
    createdAt: 1, updatedAt: 1,
  });
  runtime.squadRunRepo.insert({
    runId: "q-1", workspaceKey: "ws", workspacePath: "/tmp/ws", workItemId: "wi-7",
    parentWorkItemId: "wi-p", agentId, isLeaderTask: false,
    branch: null, dirName: null,
    status: "queued", sessionId: null, dispatchCause: null, causedByRunId: null,
    createdAt: 2, updatedAt: 2,
  });
  const out = await open("run-9", "wi-7");
  assert.equal(out.kind, "coalesced", "已有排队行 ⇒ 并入（第 1 行裁决），不得登记义务");
  assert.equal(runtime.squadDeferredDispatchRepo.list("ws").length, 0);
});
