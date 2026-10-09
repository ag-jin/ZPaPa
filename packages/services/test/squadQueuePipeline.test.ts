import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRunSettlementHub,
  type SquadRunSettlement,
} from "../src/workitem/squadRunSettlementHub.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* T8 落地项①：队列链**行为级闭环**的常驻回归（源自 2026-10-06 T8 验证的 /tmp 一次性脚本，42/42）。
   各环节已有单元测试；本文件的价值是把整链**按发生顺序**一次走通——任何一环的判据漂移
   （闸口径/认领条件/到期判据/事件时序）都会在这里先红。host 侧推进回路（结算→扫描→重投→会话）
   的行为级验证仍登记为专项缺口（台账第 87 轮）。 */

test("队列链闭环：闸→排队→并入→R2 义务→结算→推进→恰一次认领→再派回排队", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const settlements: SquadRunSettlement[] = [];
  const hub = createSquadRunSettlementHub();
  hub.subscribe((event) => settlements.push(event));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: "ws",
    readExperimentEnabled: () => true,
    runSettlementHub: hub,
  });
  const agent = runtime.teamAgentService.create({
    name: "pipeline",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const open = (runId: string, workItemId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId: "wi-p",
      agentId: agent.id,
      isLeaderTask: false,
    });

  // ① 闸未满 ⇒ 直开（真实树）。
  assert.equal((await open("run-1", "wi-1")).kind, "opened");
  // ② 容量满（1/1）且异工作项 ⇒ 排队（无树）。
  assert.equal((await open("run-2", "wi-2")).kind, "queued");
  assert.equal(runtime.squadRunRepo.get("run-2")!.branch, null);
  // ③ 同 (workItem,agent) 再派 ⇒ 并入既存排队行（留痕；至多一个待开）。
  const coalesced = await open("run-2b", "wi-2");
  assert.equal(coalesced.kind, "coalesced");
  assert.equal(coalesced.targetRunId, "run-2");
  // ④ R2：同 (workItem,agent) 有活跃 run（run-1 在 wi-1 开着）⇒ 不开不排，登记义务。
  const deferred = await open("run-3", "wi-1");
  assert.equal(deferred.kind, "deferred");
  assert.equal(runtime.squadDeferredDispatchRepo.list("ws").length, 1);

  // ⑤ 结算 run-1（失败收尾）：事实发布、容量释放。
  await runtime.lifecycle.failMemberRun({ runId: "run-1", reason: "pipeline-test" });
  assert.deepEqual(
    settlements.filter((e) => e.runId === "run-1").map((e) => e.status),
    ["discarded"],
  );

  // ⑥ 推进：重放 run-2 同 runId ⇒ 认领升级（真实树 + 分支 patch）。
  const promoted = await open("run-2", "wi-2");
  assert.equal(promoted.kind, "opened");
  const promotedRow = runtime.squadRunRepo.get("run-2")!;
  assert.equal(promotedRow.status, "open");
  assert.ok(promotedRow.branch !== null && promotedRow.branch.startsWith("squad/member/"));

  // ⑦ 义务恰一次：run-1 已终态 ⇒ (wi-1,agent) 离开活跃集 ⇒ 认领一次；重复认领为空。
  const claimed = runtime.squadDeferredDispatchRepo.claimDue("ws");
  assert.deepEqual(
    claimed.map((o) => o.runId),
    ["run-3"],
  );
  assert.deepEqual(runtime.squadDeferredDispatchRepo.claimDue("ws"), []);
  // ⑧ 认领后的重放走真实派发：此刻容量又被 run-2 占满 ⇒ 回到排队（义务已履行，事实入队）。
  assert.equal((await open("run-3", "wi-1")).kind, "queued");

  // 终态对表：活跃=[run-2(open)]；排队=[run-3]；义务空；并入留痕一条；结算事件一条。
  assert.deepEqual(
    runtime.squadRunRepo.listActive("ws").map((r) => r.runId),
    ["run-2"],
  );
  assert.deepEqual(
    runtime.squadRunRepo.listQueued("ws").map((r) => r.runId),
    ["run-3"],
  );
  const details = db
    .prepare("SELECT request_run_id, target_run_id FROM squad_run_coalesced_details")
    .all() as Array<{ request_run_id: string; target_run_id: string }>;
  assert.deepEqual(
    details.map((d) => [d.request_run_id, d.target_run_id]),
    [["run-2b", "run-2"]],
  );
  assert.equal(settlements.length, 1, "仅 run-1 收尾；promote/open 不是结算");
});
