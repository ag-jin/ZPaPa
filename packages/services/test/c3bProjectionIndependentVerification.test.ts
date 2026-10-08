import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { WorkItem } from "@zcode/shared";
import { memberDirName, planBranches } from "../src/worktree/branchNaming.js";
import { declaredRunClassFor, planDispatch } from "../src/workitem/leaderDispatch.js";
import { createSquadDispatchRequestHub } from "../src/workitem/squadDispatchRequests.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_WATCHDOG_SETTLE_REASONS,
} from "../src/workitem/squadRunRepo.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { slugForId } from "../src/workitem/slug.js";
import {
  createWorkItemActivityRepo,
  type WorkItemActivityRecord,
  type WorkItemActivityRepo,
} from "../src/workitem/workItemActivityRepo.js";
import {
  computeAssigneeChangedDedupKey,
  computeRunCancelledDedupKey,
  computeRunCompletedDedupKey,
  computeRunFailedDedupKey,
  computeRunRejectedDedupKey,
  computeRunStartedDedupKey,
  computeStatusChangedDedupKey,
  computeWorktreeCreatedDedupKey,
  computeWorktreeDiscardedDedupKey,
  computeWorktreeMergedDedupKey,
  createWorkItemActivityProjector,
  runSettleIntentForFailureReason,
  SYSTEM_ACTIVITY_ACTOR,
} from "../src/workitem/workItemActivityProjector.js";
import { applyWorkItemAssignee } from "../src/workitem/workItemAssignee.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";
import { createProtocolSquadHandlers } from "../src/zcode-agent/squadProtocolMethods.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* C3b（投影线两轮）**独立复验**：本文件是 test-verifier 的独立构造，**不复用**实现者夹具（
   c3bActivityProjectionWiring / c3bRunProjectionWiring / workItemActivityProjector / 守卫文件）。
   期望值来源是设计报告 `.superpowers/sdd/…/reports/2026-10-08-c3b-activity-projection-design.md`
   的 §5 键与 payload 表、§5.2 意图矩阵、§9 两轮验收清单——不是「拿实现再算一遍」。

   与实现者用例的独立构造差别（逐点）：
   · 工作项经**服务面** `create` + `transition` 播种（不是直插 repo 行）；
   · 代理不进名册（A5：无容量闸）⇒ 直开出口不依赖闸，三臂负向场景自造；
   · 在结算 hub 上挂「扇出瞬间」探针：记录**扇出那一刻**时间线已有的 kind —— 这是「记录先于驱动」
     的独立观测面（实现者用例只断言最终行序，证明不了次序本身）；
   · 全链从**协议入口**（`squad/assign-work-item`）经真 hub + 派发桥同形副本驱动出 run；
   · 投影零派发面用**行为面整库对照**（除 activities 外全表行数不变）+ 独立 token 扫描。 */

const WS = "c3b-iv-ws";

// =====================================================================================
// A. 十枚 dedupKey 冻结（独立真源 = 设计 §5 表 + 2026-10-08 第 19 枚裁定）
// =====================================================================================

test("A1｜十枚 dedupKey 形状逐段冻结（我的取值；含「身份段带冒号也不解析」边界）", () => {
  // 工作项两枚：身份 = 工作项 + 事件，尾段毫秒区分两次合法的同向迁移。
  assert.equal(
    computeStatusChangedDedupKey({
      workItemId: "wi-verify-1",
      from: "blocked",
      to: "in_progress",
      at: 1800000000123,
    }),
    "status:wi-verify-1:blocked:in_progress:1800000000123",
  );
  assert.equal(
    computeAssigneeChangedDedupKey({
      workItemId: "wi-verify-2",
      from: { type: "user", id: "u-owner" },
      to: { type: "squad", id: "sq-alpha" },
      at: 1800000000456,
    }),
    "assignee:wi-verify-2:user:u-owner:squad:sq-alpha:1800000000456",
  );

  // run / worktree 八枚：身份 = runId + 事件（一条 run 每类事实至多一枚 ⇒ 无毫秒段）。
  assert.equal(computeRunStartedDedupKey("run-verify-7"), "run:run-verify-7:started");
  assert.equal(computeRunCompletedDedupKey("run-verify-7"), "run:run-verify-7:completed");
  assert.equal(computeRunFailedDedupKey("run-verify-7"), "run:run-verify-7:failed");
  assert.equal(computeRunCancelledDedupKey("run-verify-7"), "run:run-verify-7:cancelled");
  assert.equal(computeRunRejectedDedupKey("run-verify-7"), "run:run-verify-7:rejected");
  assert.equal(computeWorktreeCreatedDedupKey("run-verify-7"), "run:run-verify-7:worktree_created");
  assert.equal(computeWorktreeMergedDedupKey("run-verify-7"), "run:run-verify-7:worktree_merged");
  assert.equal(
    computeWorktreeDiscardedDedupKey("run-verify-7"),
    "run:run-verify-7:worktree_discarded",
  );

  // 形状性质（不是值巧合）：runId 段原样拼接、**永不解析**（P1 游标教训）——
  // runId 自带冒号时键仍按「拼接」而不是「解析身份」存在。
  assert.equal(
    computeRunFailedDedupKey("comment:c9:dispatch_requested"),
    "run:comment:c9:dispatch_requested:failed",
  );
  // 两枚工作项键靠毫秒区分两次合法同向迁移：同毫秒同向会并成一枚（设计 §10-5 已登记的边角）。
  assert.notEqual(
    computeStatusChangedDedupKey({ workItemId: "wi-x", from: "todo", to: "in_progress", at: 1 }),
    computeStatusChangedDedupKey({ workItemId: "wi-x", from: "todo", to: "in_progress", at: 2 }),
  );
  // 纯函数：同输入同输出、不同身份不同键。
  assert.equal(computeRunStartedDedupKey("run-a"), computeRunStartedDedupKey("run-a"));
  assert.notEqual(computeRunStartedDedupKey("run-a"), computeRunStartedDedupKey("run-b"));
});

// =====================================================================================
// 共用夹具（我自己的构造；真 git 仓库 + `:memory:` 库 + 真 runtime）
// =====================================================================================

async function makeFixture() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const activities = createWorkItemActivityRepo(db);
  const settlementHub = createSquadRunSettlementHub();
  const settled: string[] = [];
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    runSettlementHub: settlementHub,
  });
  /** runId → **扇出那一刻**该 run 已落库的 kind（记录先于驱动的独立观测面）。 */
  const kindsAtFanout = new Map<string, string[]>();
  settlementHub.subscribe((event) => {
    const record = runtime.squadRunRepo.get(event.runId);
    kindsAtFanout.set(
      event.runId,
      record === null
        ? []
        : activities
            .listByWorkItem(WS, record.workItemId)
            .filter((row) => row.sourceRun?.runId === event.runId)
            .map((row) => row.kind),
    );
    settled.push(`${event.runId}:${event.status}`);
  });
  // 不进名册（A5：无名册证据 ⇒ 无容量闸 ⇒ 直开出口；三臂场景自造，不依赖闸）。
  const agent = runtime.teamAgentService.create({
    name: "iv-agent",
    systemPrompt: "s",
    memoryScope: "project",
  });

  const makeItem = (title: string, assignee: WorkItem["assignee"], parentId?: string): WorkItem => {
    const item = runtime.workItemService.create({
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      title,
      body: "",
      assignee,
      ...(parentId !== undefined ? { parentId } : {}),
    });
    // 播种到 in_progress（completeMemberRun 的 CAS 前置）：这一步自己会留一枚 status_changed。
    assert.equal(
      runtime.workItemService.transition(item.id, "in_progress", "todo"),
      true,
      `前置：${item.id} 播种到 in_progress`,
    );
    return item;
  };

  const itemTimeline = (workItemId: string) => activities.listByWorkItem(WS, workItemId);
  const rowsOfRun = (workItemId: string, runId: string) =>
    itemTimeline(workItemId).filter((row) => row.sourceRun?.runId === runId);
  const branchOf = (workItemId: string) =>
    planBranches({
      workItemSlug: slugForId(workItemId),
      agentSlug: slugForId(agent.id),
    });
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const openFor = (runId: string, workItemId: string, parentWorkItemId = workItemId) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId,
      agentId: agent.id,
      isLeaderTask: false,
    });
  const tableCounts = (): Map<string, number> => {
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);
    const counts = new Map<string, number>();
    for (const name of names) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as unknown as {
        count: number;
      };
      counts.set(name, row.count);
    }
    return counts;
  };

  return {
    repoRoot,
    db,
    runtime,
    agent,
    activities,
    settled,
    kindsAtFanout,
    makeItem,
    itemTimeline,
    rowsOfRun,
    branchOf,
    git,
    openFor,
    tableCounts,
  };
}

const kindsOf = (rows: readonly WorkItemActivityRecord[]) => rows.map((row) => row.kind);
const normalizedKey = (key: string) => key.replace(/:\d+$/, ":<ms>");

// =====================================================================================
// B. 三臂负向：内部处置不得进时间线（独立构造，逐臂断言零投影）
// =====================================================================================

test("B1｜三臂负向·清扫臂（settlePairResidualRuns）：别人的无树残行被结算 ⇒ 该 run 零枚行", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-arm-cleanup", { type: "agent", id: f.agent.id });
  const branch = f.branchOf(item.id).member;

  // 前置①：残枝占名 ⇒ 建树失败 ⇒ 台账留 open 行而无树（清扫臂的候选）。
  assert.equal((await f.git(["branch", branch, "main"])).code, 0);
  await assert.rejects(
    () => f.openFor("iv-cleanup-victim", item.id),
    /已被另一工作树占用|already exists/,
  );
  assert.equal(f.runtime.squadRunRepo.get("iv-cleanup-victim")?.status, "open");
  assert.deepEqual(f.rowsOfRun(item.id, "iv-cleanup-victim"), [], "建树失败 ⇒ 开跑事实没发生");

  // 前置②：残枝清掉 ⇒ 分支空闲；新请求（**不同 runId**）进来触发清扫臂。
  assert.equal((await f.git(["branch", "-D", branch])).code, 0);
  assert.equal((await f.openFor("iv-cleanup-fresh", item.id)).kind, "opened");
  assert.ok(
    f.settled.includes("iv-cleanup-victim:discarded"),
    "前置：清扫臂确实结算了残行（结算事实已扇出）",
  );

  // 断言：全时间线只有「播种状态行 + 新请求自己的两枚」，被清扫的行一枚都没有。
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => [row.kind, normalizedKey(row.dedupKey)]),
    [
      ["status_changed", `status:${item.id}:todo:in_progress:<ms>`],
      ["run_started", "run:iv-cleanup-fresh:started"],
      ["worktree_created", "run:iv-cleanup-fresh:worktree_created"],
    ],
  );
  // 独立观测面：清扫的**扇出瞬间**该 run 也没有任何行（记录先于驱动的负向侧）。
  assert.deepEqual(f.kindsAtFanout.get("iv-cleanup-victim"), []);
});

test("B2｜三臂负向·等待臂（residual_blocked）：残行结算 + 释放分支占位 ⇒ 本行零枚行", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-arm-wait", { type: "agent", id: f.agent.id });
  const plan = f.branchOf(item.id);

  // 前置①：别的 run 开树后失败收口（行离开活跃集，树留给回收器 = 占位）。
  assert.equal((await f.openFor("iv-wait-other", item.id)).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "iv-wait-other", reason: "iv-arm-fixture" });
  // 前置②：本请求建树失败（分支被活树占着）⇒ 残行。
  await assert.rejects(
    () => f.openFor("iv-wait-request", item.id),
    /已被另一工作树占用|already exists/,
  );
  assert.deepEqual(f.rowsOfRun(item.id, "iv-wait-request"), []);

  // 重投 ⇒ 等待臂：结算本行（不投影）+ 释放分支占位（branch=null）⇒ residual_blocked。
  assert.deepEqual(await f.openFor("iv-wait-request", item.id), {
    kind: "residual_blocked",
    branch: plan.member,
  });
  assert.ok(f.settled.includes("iv-wait-request:discarded"), "前置：等待臂确实结算过本行");
  assert.equal(f.runtime.squadRunRepo.get("iv-wait-request")?.branch, null, "前置：占位已释放");

  // 断言：本行零枚；线上只有「播种状态行 + 别的 run 自己的三枚事实」。
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => [row.kind, row.sourceRun?.runId ?? null]),
    [
      ["status_changed", null],
      ["run_started", "iv-wait-other"],
      ["worktree_created", "iv-wait-other"],
      ["run_failed", "iv-wait-other"],
    ],
    "等待臂的结算与占位释放都是内部处置：不得写「这条 run 开过/失败过」",
  );
  assert.deepEqual(f.kindsAtFanout.get("iv-wait-request"), [], "扇出瞬间本行同样零枚");

  // 幂等：等待态再重投一次，仍零枚、不再二次扇出结算事实。
  assert.deepEqual(await f.openFor("iv-wait-request", item.id), {
    kind: "residual_blocked",
    branch: plan.member,
  });
  assert.equal(
    f.settled.filter((entry) => entry === "iv-wait-request:discarded").length,
    1,
    "结算一次为限（重复扇出会让排队推进空转）",
  );
  assert.deepEqual(f.rowsOfRun(item.id, "iv-wait-request"), []);
});

test("B3｜三臂负向·重开臂（同 runId 残行结算 + 重开）：结算零枚、重开恰两枚", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-arm-reopen", { type: "agent", id: f.agent.id });
  const branch = f.branchOf(item.id).member;

  // 残枝占名 ⇒ 建树失败 ⇒ 残行；清残枝 ⇒ 分支空闲。
  assert.equal((await f.git(["branch", branch, "main"])).code, 0);
  await assert.rejects(
    () => f.openFor("iv-reopen-run", item.id),
    /已被另一工作树占用|already exists/,
  );
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => row.kind),
    ["status_changed"],
  );
  assert.equal((await f.git(["branch", "-D", branch])).code, 0);

  // 同一 runId 重投：先结算那条残行（内部处置）、再重开新树（用户可见的开跑）。
  assert.equal((await f.openFor("iv-reopen-run", item.id)).kind, "opened");
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => [row.kind, normalizedKey(row.dedupKey)]),
    [
      ["status_changed", `status:${item.id}:todo:in_progress:<ms>`],
      ["run_started", "run:iv-reopen-run:started"],
      ["worktree_created", "run:iv-reopen-run:worktree_created"],
    ],
    "同一调用内的结算不投影（它只是重开的前置处置），重开才是事实",
  );
  assert.deepEqual(
    f.settled.filter((entry) => entry.startsWith("iv-reopen-run:")),
    ["iv-reopen-run:discarded"],
    "前置：那一次内部结算确实扇出过（但一行都没有）",
  );
  assert.equal(f.runtime.squadRunRepo.get("iv-reopen-run")?.status, "open");
});

test("B4｜排队臂负向（补测缺口）：排队与「容量仍满时重投同一 runId」都零枚，升级后才两枚", async () => {
  const f = await makeFixture();
  // 这条臂需要容量闸：名册里显式给 maxConcurrentRuns=1 的代理。
  const gated = f.runtime.teamAgentService.create({
    name: "iv-gated-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemA = f.makeItem("iv-queue-a", { type: "agent", id: gated.id });
  const itemB = f.makeItem("iv-queue-b", { type: "agent", id: gated.id });
  const open = (runId: string, workItemId: string) =>
    f.runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId: workItemId,
      agentId: gated.id,
      isLeaderTask: false,
    });

  // ① 容量 1/1：A 直开占满，B 落排队行（未建树）。
  assert.equal((await open("iv-q-a", itemA.id)).kind, "opened");
  assert.deepEqual(await open("iv-q-b", itemB.id), { kind: "queued", runId: "iv-q-b" });
  assert.deepEqual(f.rowsOfRun(itemB.id, "iv-q-b"), [], "排队不是「开跑」这条事实：零枚");
  // ② 容量**仍满**时重投同一 runId（host 收到别人的结算事件会重放同 runId 推进入口）：
  //    认领失败 ⇒ 仍排队 ⇒ 仍零枚（这条格只有结构守卫 G6 的计数在守，行为面此前无覆盖）。
  assert.deepEqual(await open("iv-q-b", itemB.id), { kind: "queued", runId: "iv-q-b" });
  assert.deepEqual(f.rowsOfRun(itemB.id, "iv-q-b"), [], "排队重投仍不是开跑：零枚");
  // ③ 释放容量后升级（queued→open + 建树）⇒ 恰两枚。
  await f.runtime.lifecycle.failMemberRun({ runId: "iv-q-a", reason: "iv-queue-fixture" });
  assert.equal((await open("iv-q-b", itemB.id)).kind, "opened");
  assert.deepEqual(
    f.itemTimeline(itemB.id).map((row) => [row.kind, row.sourceRun?.runId ?? null]),
    [
      ["status_changed", null],
      ["run_started", "iv-q-b"],
      ["worktree_created", "iv-q-b"],
    ],
    "认领升级才是开跑：两枚一起落，且不早于升级这一刻",
  );
});

// =====================================================================================
// C. settleStatus 意图矩阵：9 调用点 × 意图有无逐格（打回原为登记格，2026-10-08 裁定后带意图）
// =====================================================================================
test("C1｜五处非打回带意图调用点 ⇒ 各落对应 kind（leader/member 完成、审查合并、弃树、失败分流全码值；打回见 C2）", async () => {
  const f = await makeFixture();

  // ① completeLeaderRun：merged（leader 无树）⇒ run_completed，payload.status = merged。
  const wiLeader = f.makeItem("iv-m-leader", { type: "agent", id: f.agent.id });
  await f.runtime.lifecycle.recordLeaderRun({
    runId: "iv-leader",
    workItemId: wiLeader.id,
    agentId: f.agent.id,
  });
  await f.runtime.lifecycle.completeLeaderRun({ runId: "iv-leader" });
  assert.deepEqual(
    f.itemTimeline(wiLeader.id).map((row) => row.kind),
    ["status_changed", "run_started", "run_completed"],
  );
  const leaderDone = f.rowsOfRun(wiLeader.id, "iv-leader").at(-1)!;
  assert.deepEqual(leaderDone.payload, {
    status: "merged",
    agentId: f.agent.id,
    isLeaderTask: true,
  });

  // ② completeMemberRun：produced ⇒ run_completed + 工作项推进 in_review。
  const wiMember = f.makeItem("iv-m-member", { type: "agent", id: f.agent.id });
  await f.openFor("iv-member", wiMember.id);
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-member" });
  const memberDone = f.rowsOfRun(wiMember.id, "iv-member").at(-1)!;
  assert.equal(memberDone.kind, "run_completed");
  assert.deepEqual(memberDone.payload, {
    status: "produced",
    agentId: f.agent.id,
    isLeaderTask: false,
  });

  // ③ reviewMemberRun approved ⇒ worktree_merged（integration 原样给）。
  const wiMerge = f.makeItem("iv-m-merge", { type: "agent", id: f.agent.id });
  await f.openFor("iv-merge", wiMerge.id);
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-merge" });
  assert.deepEqual(
    await f.runtime.lifecycle.reviewMemberRun({ runId: "iv-merge", verdict: "approved" }),
    { ok: true, merged: true },
  );
  const merged = f.rowsOfRun(wiMerge.id, "iv-merge").at(-1)!;
  const mergePlan = f.branchOf(wiMerge.id);
  assert.equal(merged.kind, "worktree_merged");
  assert.deepEqual(merged.payload, {
    branch: mergePlan.member,
    integration: mergePlan.integration,
    agentId: f.agent.id,
  });

  // ④ discardMemberRun ⇒ worktree_discarded（branch + dirName）。
  const wiDiscard = f.makeItem("iv-m-discard", { type: "agent", id: f.agent.id });
  await f.openFor("iv-discard", wiDiscard.id);
  await f.runtime.lifecycle.discardMemberRun({ runId: "iv-discard" });
  const discarded = f.rowsOfRun(wiDiscard.id, "iv-discard").at(-1)!;
  const discardPlan = f.branchOf(wiDiscard.id);
  assert.equal(discarded.kind, "worktree_discarded");
  assert.deepEqual(discarded.payload, {
    branch: discardPlan.member,
    dirName: memberDirName(discardPlan),
  });

  // ⑤ failMemberRun 原因分流：user_cancel ⇒ run_cancelled；看门狗三码与其余 ⇒ run_failed。
  const failCases = [
    { runId: "iv-fail-cancel", reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL, kind: "run_cancelled" },
    ...SQUAD_RUN_WATCHDOG_SETTLE_REASONS.map((reason, index) => ({
      runId: `iv-fail-watchdog-${index}`,
      reason,
      kind: "run_failed" as const,
    })),
    { runId: "iv-fail-other", reason: "会话异常退出", kind: "run_failed" as const },
  ];
  for (const entry of failCases) {
    const item = f.makeItem(`iv-item-${entry.runId}`, { type: "agent", id: f.agent.id });
    await f.openFor(entry.runId, item.id);
    await f.runtime.lifecycle.failMemberRun({ runId: entry.runId, reason: entry.reason });
    const terminal = f.rowsOfRun(item.id, entry.runId).at(-1)!;
    assert.equal(terminal.kind, entry.kind, `reason=「${entry.reason}」应落 ${entry.kind}`);
    assert.deepEqual(
      terminal.payload,
      entry.kind === "run_cancelled"
        ? { reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL }
        : { reason: entry.reason, agentId: f.agent.id },
    );
  }
});

test("C2｜矩阵原登记格·打回（第六个带意图调用点）⇒ 恰一枚 run_rejected（真库 + 扇出瞬间已在库）", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-reject", { type: "agent", id: f.agent.id });
  await f.openFor("iv-reject-run", item.id);
  const before = f.itemTimeline(item.id).map((row) => row.kind);
  assert.deepEqual(before, ["status_changed", "run_started", "worktree_created"]);

  assert.deepEqual(
    await f.runtime.lifecycle.reviewMemberRun({ runId: "iv-reject-run", verdict: "rejected" }),
    {
      ok: true,
      merged: false,
      kept: true,
    },
  );
  assert.equal(
    f.runtime.squadRunRepo.get("iv-reject-run")?.status,
    "rejected",
    "前置：打回是既成事实",
  );
  /* 2026-10-08 用户裁定：第 19 枚 `run_rejected`（原 C2 的「零投影登记格」就此关闭）。
     真库行序断言：打回**恰一枚**，落在开跑/建树之后，且分支/agent 与 worktree 族同形。 */
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => [row.kind, row.sourceRun?.runId ?? null]),
    [
      ["status_changed", null],
      ["run_started", "iv-reject-run"],
      ["worktree_created", "iv-reject-run"],
      ["run_rejected", "iv-reject-run"],
    ],
  );
  const rejected = f.rowsOfRun(item.id, "iv-reject-run").at(-1)!;
  assert.equal(rejected.dedupKey, "run:iv-reject-run:rejected");
  assert.equal(rejected.actor.kind, "system");
  assert.equal(rejected.payload.agentId, f.agent.id);
  assert.equal(rejected.payload.branch, f.branchOf(item.id).member);
  assert.equal("reason" in rejected.payload, false, "打回没有原因原文 ⇒ payload 不造 reason 键");
  assert.ok(f.settled.includes("iv-reject-run:rejected"), "前置：结算事实确实扇出过");
  // 记录先于驱动：hub 扇出那一刻 run_rejected 已在库（与 C3 的五个带意图臂同一观测面）。
  assert.ok(
    f.kindsAtFanout.get("iv-reject-run")?.includes("run_rejected"),
    "扇出前必须已落 run_rejected",
  );
  // 同一条 run 再打回：一键一行 ⇒ 不落第二枚。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "iv-reject-run", verdict: "rejected" });
  assert.deepEqual(
    kindsOf(f.rowsOfRun(item.id, "iv-reject-run")),
    ["run_started", "worktree_created", "run_rejected"],
    "重投不翻倍：打回事实对一条 run 至多一枚",
  );
});

test("C3｜记录先于驱动：六处带意图的收口，hub 扇出那一刻终止行已在库里", async () => {
  const f = await makeFixture();

  // ① 队员完成（produced ⇒ run_completed）
  const wiA = f.makeItem("iv-ord-a", { type: "agent", id: f.agent.id });
  await f.openFor("iv-ord-a", wiA.id);
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-ord-a" });
  assert.ok(
    f.kindsAtFanout.get("iv-ord-a")?.includes("run_completed"),
    "扇出前必须已落 run_completed",
  );

  // ② 队长完成（merged ⇒ run_completed）
  const wiB = f.makeItem("iv-ord-b", { type: "agent", id: f.agent.id });
  await f.runtime.lifecycle.recordLeaderRun({
    runId: "iv-ord-b",
    workItemId: wiB.id,
    agentId: f.agent.id,
  });
  await f.runtime.lifecycle.completeLeaderRun({ runId: "iv-ord-b" });
  assert.ok(f.kindsAtFanout.get("iv-ord-b")?.includes("run_completed"));

  // ③ 审查通过（⇒ worktree_merged）
  const wiC = f.makeItem("iv-ord-c", { type: "agent", id: f.agent.id });
  await f.openFor("iv-ord-c", wiC.id);
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-ord-c" });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "iv-ord-c", verdict: "approved" });
  assert.ok(f.kindsAtFanout.get("iv-ord-c")?.includes("worktree_merged"));

  // ④ 弃树（⇒ worktree_discarded）
  const wiD = f.makeItem("iv-ord-d", { type: "agent", id: f.agent.id });
  await f.openFor("iv-ord-d", wiD.id);
  await f.runtime.lifecycle.discardMemberRun({ runId: "iv-ord-d" });
  assert.ok(f.kindsAtFanout.get("iv-ord-d")?.includes("worktree_discarded"));

  // ⑤ 失败分流（user_cancel ⇒ run_cancelled）
  const wiE = f.makeItem("iv-ord-e", { type: "agent", id: f.agent.id });
  await f.openFor("iv-ord-e", wiE.id);
  await f.runtime.lifecycle.failMemberRun({
    runId: "iv-ord-e",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  assert.ok(f.kindsAtFanout.get("iv-ord-e")?.includes("run_cancelled"));

  // ⑥ 打回（第 19 枚 ⇒ run_rejected；2026-10-08 裁定后不再是零投影格）
  const wiF = f.makeItem("iv-ord-f", { type: "agent", id: f.agent.id });
  await f.openFor("iv-ord-f", wiF.id);
  await f.runtime.lifecycle.reviewMemberRun({ runId: "iv-ord-f", verdict: "rejected" });
  assert.ok(f.kindsAtFanout.get("iv-ord-f")?.includes("run_rejected"));
});

test("C4｜失败原因 → 意图的映射单源（行为面）：user_cancel / 看门狗三码 / 其余逐格", () => {
  assert.deepEqual(runSettleIntentForFailureReason(SQUAD_RUN_SETTLE_REASON_USER_CANCEL), {
    kind: "run_cancelled",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  for (const reason of [...SQUAD_RUN_WATCHDOG_SETTLE_REASONS, "boom", ""]) {
    assert.deepEqual(runSettleIntentForFailureReason(reason), { kind: "run_failed", reason });
  }
});

test("C5｜工作项族同样「记录先于驱动」：订阅者抛错也不丢 status_changed 回声", async () => {
  const f = await makeFixture();
  const item = f.runtime.workItemService.create({
    workspaceIdentity: WS,
    workspacePath: "/tmp/iv-c5",
    title: "记录先于驱动",
    body: "",
    assignee: { type: "user", id: "u-owner" },
  });
  // 订阅表是同步扇出、不做异常隔离（设计事实 6）：订阅者抛错会传给 transition 调用者。
  const unsubscribe = f.runtime.subscribeWorkItemEvents((event) => {
    if (event.kind === "workitem.status_changed") throw new Error("订阅者抛错：iv-c5");
  });
  assert.throws(
    () => f.runtime.workItemService.transition(item.id, "in_progress", "todo"),
    /订阅者抛错/,
    "前置：订阅者异常确实会冒到调用者",
  );
  unsubscribe();

  assert.equal(f.runtime.workItemRepo.get(item.id)?.status, "in_progress", "状态已落盘");
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => [row.kind, row.payload]),
    [["status_changed", { from: "todo", to: "in_progress" }]],
    "回声先于驱动：订阅者炸了，时间线仍留下这次变迁（次序反过来就会丢记录）",
  );
});

// =====================================================================================
// D. 全链演示 + 批次级联（独立走）
// =====================================================================================

/** 组合根同形的派发链：真 hub + 真服务面 + 真协议入口；常驻侧执行体是 host 派发桥的最小同形副本。 */
async function makeDispatchChain() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const hub = createSquadDispatchRequestHub();
  const target: SquadWorkspaceTarget = { path: repoRoot, identity: WS };
  const createRuntime = async (workspaceTarget: SquadWorkspaceTarget) =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: workspaceTarget.identity,
      readExperimentEnabled: () => true,
      dispatchRequestHub: hub,
    });
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (workspaceTarget, squadId) => {
      await archiveSquadAndTransfer(await createRuntime(workspaceTarget), squadId);
    },
    createOrchestrator: createSquadOrchestrator,
    logWarn: () => {},
  });
  const handlers = createProtocolSquadHandlers({ resolveSquadRuntimeService: () => service });
  const runtime = await createRuntime(target);
  const activities = createWorkItemActivityRepo(db);
  const plans: Promise<void>[] = [];
  const failures: unknown[] = [];
  const opened: string[] = [];
  /** 派发请求**发布那一刻**该工作项已有的 kind（指派族「记录先于驱动」的独立观测面）。 */
  const kindsAtDispatch = new Map<string, string[]>();
  hub.subscribe((request) => {
    kindsAtDispatch.set(
      request.workItemId,
      activities
        .listByWorkItem(request.workspaceIdentity, request.workItemId)
        .map((row) => row.kind),
    );
    plans.push(
      (async () => {
        const requestTarget: SquadWorkspaceTarget = {
          path: request.workspacePath,
          identity: request.workspaceIdentity,
        };
        const snapshot = await service.getSnapshot(requestTarget);
        const item = snapshot.workItems.find((candidate) => candidate.id === request.workItemId);
        assert.ok(item, `前置：派发请求指向的工作项应存在（${request.workItemId}）`);
        const squad =
          item.assignee.type === "squad"
            ? (snapshot.squads.find((candidate) => candidate.id === item.assignee.id) ?? null)
            : null;
        const parent = item.parentId
          ? (snapshot.workItems.find((candidate) => candidate.id === item.parentId) ?? null)
          : null;
        const events = planDispatch({
          workItem: item,
          squad,
          parentWorkItem: parent,
          runClass: declaredRunClassFor({ parentId: item.parentId, parent }),
          trigger: "user",
        });
        const enqueued = events.find((event) => event.kind === "run.enqueued");
        if (enqueued?.kind !== "run.enqueued" || enqueued.runClass !== "member") return;
        const runId = `chain-${item.id}`;
        opened.push(runId);
        await service.openMemberRun(requestTarget, {
          runId,
          workItemId: item.id,
          parentWorkItemId: item.parentId ?? item.id,
          agentId: enqueued.agentId,
          isLeaderTask: false,
          // host 派发桥同形：成因原样搬运（缺席 = 未知 ⇒ 落 NULL，读回不得猜）。
          dispatchCause: request.kind === "comment" ? "comment" : request.cause,
        });
      })().catch((error: unknown) => {
        failures.push(error);
      }),
    );
  });
  return {
    repoRoot,
    db,
    runtime,
    service,
    handlers,
    target,
    activities,
    opened,
    failures,
    kindsAtDispatch,
    settle: async () => {
      await Promise.all(plans);
      assert.deepEqual(failures, [], "派发桥同形副本不得有未捕获异常");
    },
  };
}

test("D1｜全链（真派发驱动）：协议入口 → hub → 桥开跑 → 完成 → 合并 → 清树，行序逐枚独立期望", async () => {
  const f = await makeDispatchChain();
  const leader = f.runtime.teamAgentService.create({
    name: "iv-leader-agent",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const member = f.runtime.teamAgentService.create({
    name: "iv-member-agent",
    systemPrompt: "s",
    memoryScope: "project",
  });
  const squad = f.runtime.squadService.create({
    name: "iv-squad",
    leaderAgentId: leader.id,
    members: [member.id],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const parent = f.runtime.workItemService.create({
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "iv-parent",
    body: "",
    assignee: { type: "squad", id: squad.id },
  });
  const child = f.runtime.workItemService.create({
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "iv-child",
    body: "",
    parentId: parent.id,
    assignee: { type: "user", id: "u-owner" },
  });
  assert.equal(f.runtime.workItemService.transition(child.id, "in_progress", "todo"), true);

  // 真派发：协议入口（队长派单工具）→ 负责人改写 + 派发请求 → hub → 桥开树。
  const assigned = await f.handlers.assignWorkItem(f.target, {
    workItemId: child.id,
    agentId: member.id,
  });
  assert.deepEqual(assigned, { ok: true, result: { dispatched: true } });
  await f.settle();
  assert.deepEqual(f.opened, [`chain-${child.id}`], "桥只为本子项开了一条队员 run");
  assert.ok(
    f.kindsAtDispatch.get(child.id)?.includes("assignee_changed"),
    "指派族同样是「记录先于驱动」：派发请求发布那一刻，assignee_changed 已落库",
  );

  const runId = `chain-${child.id}`;
  const plan = planBranches({
    workItemSlug: slugForId(child.id),
    agentSlug: slugForId(member.id),
  });
  await f.runtime.lifecycle.completeMemberRun({ runId });
  assert.deepEqual(await f.runtime.lifecycle.reviewMemberRun({ runId, verdict: "approved" }), {
    ok: true,
    merged: true,
  });
  await f.runtime.lifecycle.discardMemberRun({ runId });

  // 行序：逐枚独立期望（key 里只有毫秒段做占位归一）。
  const rows = f.activities.listByWorkItem(WS, child.id);
  assert.deepEqual(
    rows.map((row) => [row.kind, normalizedKey(row.dedupKey)]),
    [
      ["status_changed", `status:${child.id}:todo:in_progress:<ms>`],
      ["assignee_changed", `assignee:${child.id}:user:u-owner:agent:${member.id}:<ms>`],
      ["run_started", `run:${runId}:started`],
      ["worktree_created", `run:${runId}:worktree_created`],
      ["run_completed", `run:${runId}:completed`],
      ["status_changed", `status:${child.id}:in_progress:in_review:<ms>`],
      ["worktree_merged", `run:${runId}:worktree_merged`],
      ["worktree_discarded", `run:${runId}:worktree_discarded`],
    ],
    "全链后时间线 = 完整审计流（此前的写者只有评论/决定族）",
  );

  // 逐枚 payload（设计 §5 表）。
  assert.deepEqual(rows[1]!.payload, {
    from: { type: "user", id: "u-owner" },
    to: { type: "agent", id: member.id },
    cause: "leader_tool",
  });
  assert.deepEqual(rows[2]!.payload, {
    agentId: member.id,
    isLeaderTask: false,
    branch: plan.member,
    dispatchCause: "leader_tool",
  });
  assert.deepEqual(rows[3]!.payload, { branch: plan.member, agentId: member.id });
  assert.deepEqual(rows[4]!.payload, {
    status: "produced",
    agentId: member.id,
    isLeaderTask: false,
  });
  assert.deepEqual(rows[5]!.payload, { from: "in_progress", to: "in_review" });
  assert.deepEqual(rows[6]!.payload, {
    branch: plan.member,
    integration: plan.integration,
    agentId: member.id,
  });
  assert.deepEqual(rows[7]!.payload, { branch: plan.member, dirName: memberDirName(plan) });

  // 排序与时刻：sequence 连号且严格递增；occurredAt 非降。
  assert.deepEqual(
    rows.map((row) => row.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(rows[index]!.occurredAt >= rows[index - 1]!.occurredAt, "occurredAt 不得倒流");
  }

  // 角色读回：run 族行 sourceRun 恰三字段（无 squadId），工作项族行 null。
  for (const row of rows) {
    const runFamily = [
      "run_started",
      "worktree_created",
      "run_completed",
      "worktree_merged",
      "worktree_discarded",
    ].includes(row.kind);
    if (runFamily) {
      assert.deepEqual(row.sourceRun, { runId, agentId: member.id, role: "member" });
      assert.deepEqual(Object.keys(row.sourceRun ?? {}).sort(), ["agentId", "role", "runId"]);
    } else {
      assert.equal(row.sourceRun, null, `${row.kind} 没有 run 归属：不得猜 role`);
    }
    assert.deepEqual(row.actor, SYSTEM_ACTIVITY_ACTOR);
    assert.deepEqual(row.initiatedBy, SYSTEM_ACTIVITY_ACTOR);
  }

  // 父项时间线隔离：子项事实不得串到父项。
  assert.deepEqual(f.activities.listByWorkItem(WS, parent.id), []);

  // 链真的走完（真 git + 真台账）。
  assert.deepEqual(await f.runtime.worktreeManager.list(), []);
  assert.notEqual(
    (
      await f.runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${plan.member}`], {
        cwd: f.repoRoot,
      })
    ).code,
    0,
    "队员分支已被删",
  );
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded");
});

test("D2｜批次级联：整批放弃 ⇒ 逐 run worktree_discarded + 父项 status_changed(cancelled)", async () => {
  const f = await makeFixture();
  const parent = f.makeItem("iv-batch-parent", { type: "agent", id: f.agent.id });
  const childA = f.makeItem("iv-batch-a", { type: "agent", id: f.agent.id }, parent.id);
  const childB = f.makeItem("iv-batch-b", { type: "agent", id: f.agent.id }, parent.id);

  assert.equal((await f.openFor("iv-batch-run-a", childA.id, parent.id)).kind, "opened");
  assert.equal((await f.openFor("iv-batch-run-b", childB.id, parent.id)).kind, "opened");
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-batch-run-a" });
  await f.runtime.lifecycle.completeMemberRun({ runId: "iv-batch-run-b" });

  await createSquadOrchestrator({ runtime: f.runtime }).discardBatch({
    workspaceKey: WS,
    parentWorkItemId: parent.id,
  });

  for (const [runId, itemId] of [
    ["iv-batch-run-a", childA.id],
    ["iv-batch-run-b", childB.id],
  ] as const) {
    assert.deepEqual(
      f.itemTimeline(itemId).map((row) => [row.kind, row.sourceRun?.runId ?? null]),
      [
        ["status_changed", null],
        ["run_started", runId],
        ["worktree_created", runId],
        ["run_completed", runId],
        ["status_changed", null],
        ["worktree_discarded", runId],
      ],
      `${runId}：弃树必须逐 run 落在它自己工作项的时间线上`,
    );
  }
  assert.deepEqual(
    f.itemTimeline(parent.id).map((row) => [row.kind, row.payload]),
    [
      ["status_changed", { from: "todo", to: "in_progress" }],
      ["status_changed", { from: "in_progress", to: "cancelled" }],
    ],
    "父项整批放弃的状态流转同线可见（经唯一写者 transition）",
  );
  assert.deepEqual(await f.runtime.worktreeManager.list(), [], "两棵树都已摘（真 git）");
  assert.equal(f.runtime.squadRunRepo.get("iv-batch-run-a")?.status, "discarded");
  assert.equal(f.runtime.squadRunRepo.get("iv-batch-run-b")?.status, "discarded");
});

// =====================================================================================
// E. 零派发面（行为面 + 结构面）与失败面（装配级）
// =====================================================================================

test("E1｜投影零派发面（行为面）：直接调投影器只增长 activities 表，其余全表零变化、零工作树", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-zero-face", { type: "agent", id: f.agent.id });
  const runItem = f.makeItem("iv-zero-run-item", { type: "agent", id: f.agent.id });
  const leaderItem = f.makeItem("iv-zero-leader", { type: "agent", id: f.agent.id });
  assert.equal((await f.openFor("iv-zero-run", runItem.id)).kind, "opened");
  await f.runtime.lifecycle.recordLeaderRun({
    runId: "iv-zero-leader",
    workItemId: leaderItem.id,
    agentId: f.agent.id,
  });
  const memberRecord = f.runtime.squadRunRepo.get("iv-zero-run")!;
  const leaderRecord = f.runtime.squadRunRepo.get("iv-zero-leader")!;
  assert.ok(
    memberRecord.branch !== null && leaderRecord.branch === null,
    "前置：member 有树 / leader 无树",
  );

  const before = f.tableCounts();
  const treesBefore = await f.runtime.worktreeManager.list();
  const runsBefore = f.runtime.squadRunRepo.listByWorkspace(WS).length;

  // 直接调用投影面（不经任何事实写者）：九种形态各一发。
  f.runtime.activityProjector.statusChanged({ item, from: "blocked", to: "done" });
  f.runtime.activityProjector.assigneeChanged({
    item,
    from: { type: "agent", id: f.agent.id },
    to: { type: "user", id: "u-owner" },
  });
  f.runtime.activityProjector.runStarted(memberRecord);
  f.runtime.activityProjector.runSettled(memberRecord, { kind: "run_completed" });
  f.runtime.activityProjector.runSettled(memberRecord, { kind: "run_failed", reason: "iv" });
  f.runtime.activityProjector.runSettled(memberRecord, {
    kind: "run_cancelled",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  f.runtime.activityProjector.runSettled(memberRecord, {
    kind: "worktree_merged",
    integration: "squad/integration/iv",
  });
  f.runtime.activityProjector.runSettled(memberRecord, { kind: "worktree_discarded" });
  f.runtime.activityProjector.runSettled(leaderRecord, { kind: "run_completed" });

  // ① 全表对照：除 activities 外一张表都不许动（尤其 squad_runs / work_items）。
  const after = f.tableCounts();
  assert.ok(
    before.has("work_item_activities") && before.has("squad_runs"),
    "前置：对照表在全表清单里",
  );
  for (const [table, count] of before) {
    if (table === "work_item_activities") continue;
    assert.equal(after.get(table), count, `投影不得改动 ${table}（零派发面 = 行为面证据）`);
  }
  // ② 唯一切实增长的是 activities：+8（工作项面 2 枚 + member 的 5 枚终态 + leader 的 1 枚；
  //    runStarted 的 2 枚与真实开跑同键 ⇒ 幂等返回既存行，不新增）。
  assert.equal(
    after.get("work_item_activities")! - before.get("work_item_activities")!,
    8,
    "投影只写 activities（同键重投连行都不新建）",
  );
  // ③ 逐项行形状（读回真库）。
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => row.kind),
    ["status_changed", "status_changed", "assignee_changed"],
  );
  assert.deepEqual(
    f.itemTimeline(runItem.id).map((row) => row.kind),
    [
      "status_changed",
      "run_started",
      "worktree_created",
      "run_completed",
      "run_failed",
      "run_cancelled",
      "worktree_merged",
      "worktree_discarded",
    ],
  );
  assert.deepEqual(
    f.itemTimeline(leaderItem.id).map((row) => row.kind),
    ["status_changed", "run_started", "run_completed"],
  );
  // ④ 零建树 / 零台账行（投影不派发、不开 run）。
  assert.deepEqual(await f.runtime.worktreeManager.list(), treesBefore, "投影零建树");
  assert.equal(f.runtime.squadRunRepo.listByWorkspace(WS).length, runsBefore, "投影零台账行");
});

test("E2｜投影模块结构负向（独立 token 扫描）：无派发面 / 无状态机 / 无台账 / 无 SQL 直写", () => {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../src/workitem/workItemActivityProjector.ts",
    ),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const token of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "publishDispatchRequest",
    "discardBatch",
    "transition",
    "updateStatus",
    "createSquadRunRepo",
    "runSettlementHub",
    "createWorkItemService",
    "db.prepare",
    "INSERT INTO",
  ]) {
    assert.ok(!code.includes(token), `投影模块不得出现 ${token}（结构上拿不到执行面）`);
  }
});

test("E3｜失败面（装配级）：投影写失败只留痕不抛，事实不回滚、状态仍前进", async () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createWorkItemRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const warnings: string[] = [];
  const brokenActivities = {
    add() {
      throw new Error("库坏了：本用例的注入面");
    },
    get: () => null,
    listByWorkItem: () => [],
  } as unknown as WorkItemActivityRepo;
  const projector = createWorkItemActivityProjector({
    activities: brokenActivities,
    logWarn: (message) => warnings.push(message),
  });
  const service = createWorkItemService({ repo, emit: () => {}, activityProjector: projector });
  const item = service.create({
    workspaceIdentity: WS,
    workspacePath: "/tmp/iv-e3",
    title: "失败面",
    body: "",
    assignee: { type: "user", id: "u-owner" },
  });

  assert.equal(
    service.transition(item.id, "in_progress", "todo"),
    true,
    "投影失败不得翻转已落地的事实",
  );
  assert.equal(repo.get(item.id)?.status, "in_progress", "状态真的落了盘");
  assert.deepEqual(activities.listByWorkItem(WS, item.id), [], "回声没落库（留痕代替）");
  assert.equal(warnings.length, 1, "恰留一次痕（不静默）");
  assert.match(warnings[0]!, /status_changed/);
});

test("E4｜C3b.1 两写者失败面（装配级）：指派写者用坏投影器 ⇒ 指派仍成功、负责人真的改了", async () => {
  const f = await makeFixture();
  const item = f.makeItem("iv-e4", { type: "agent", id: f.agent.id });
  const warnings: string[] = [];
  const brokenActivities = {
    add() {
      throw new Error("库坏了：本用例的注入面");
    },
    get: () => null,
    listByWorkItem: () => [],
  } as unknown as WorkItemActivityRepo;
  const hostileRuntime = {
    ...f.runtime,
    activityProjector: createWorkItemActivityProjector({
      activities: brokenActivities,
      logWarn: (message) => warnings.push(message),
    }),
  };

  const outcome = applyWorkItemAssignee(
    hostileRuntime,
    { workItemId: item.id, assignee: { type: "squad", id: "sq-archive" } },
    { sameAssignee: "skip", cause: "user_reassign" },
  );
  assert.deepEqual(outcome, { assigned: true });
  assert.deepEqual(f.runtime.workItemRepo.get(item.id)?.assignee, {
    type: "squad",
    id: "sq-archive",
  });
  assert.equal(warnings.length, 1, "改派的回声丢失只留痕");
  assert.deepEqual(
    f.itemTimeline(item.id).map((row) => row.kind),
    ["status_changed"],
    "坏投影器一行都写不进去（事实仍在）",
  );
});
