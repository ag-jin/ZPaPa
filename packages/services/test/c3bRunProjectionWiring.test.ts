import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { memberDirName, planBranches } from "../src/worktree/branchNaming.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_WATCHDOG_SETTLE_REASONS,
} from "../src/workitem/squadRunRepo.js";
import { slugForId } from "../src/workitem/slug.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* C3b.2：run / worktree 族的投影**生产接线**（设计 §3.2 逐枚落位 / §5 键与 payload 表 / §9 C3b.2 验收）。

   断言全部落在**已落库的事实**上（`work_item_activities` 行），不读实现中间量；期望值是手写字面量
   （独立真源 = 设计 §5 表 + §5.2 判定矩阵），键形状不经过被实现引用的计算函数。 */

const WS = "c3b2-ws";

/** 真实 git 仓库 + `:memory:` 库 + 真 runtime（与 c1ResidualMemberRun / p21 同款缝合）。 */
async function setup() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const settlements = createSquadRunSettlementHub();
  const settled: string[] = [];
  settlements.subscribe((event) => settled.push(`${event.runId}:${event.status}`));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    runSettlementHub: settlements,
  });
  // 有名册定义 ⇒ openMemberRun 走容量闸（直开 / 排队 / 认领升级三出口都需要它）。
  const agent = runtime.teamAgentService.create({
    name: "c3b2-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const insertItem = (
    id: string,
    status: "todo" | "in_progress" = "in_progress",
    parentId?: string,
  ): void => {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      ...(parentId !== undefined ? { parentId } : {}),
      title: `C3b.2 ${id}`,
      body: "",
      status,
      assignee: { type: "agent", id: agent.id },
      labels: [],
      properties: {},
      position: 0,
    });
  };
  const activities = createWorkItemActivityRepo(db);
  const timeline = (workItemId: string) =>
    activities.listByWorkItem(WS, workItemId).map((row) => ({
      kind: row.kind,
      dedupKey: row.dedupKey,
      payload: row.payload,
      sourceRun: row.sourceRun,
      actor: row.actor,
      occurredAt: row.occurredAt,
    }));
  const openWith = (runId: string, workItemId: string, parentWorkItemId: string, agentId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId,
      agentId,
      isLeaderTask: false,
    });
  const openFor = (runId: string, workItemId: string) =>
    openWith(runId, workItemId, workItemId, agent.id);
  const planFor = (workItemId: string) =>
    planBranches({ workItemSlug: slugForId(workItemId), agentSlug: slugForId(agent.id) });
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const reap = () => runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  return {
    repoRoot,
    runtime,
    agent,
    settled,
    activities,
    timeline,
    insertItem,
    openFor,
    openWith,
    planFor,
    git,
    reap,
  };
}

test("C3b.2-① member 直开 ⇒ run_started + worktree_created 各一枚（字面量）；排队出口零枚；认领升级后两枚", async () => {
  const f = await setup();
  f.insertItem("wi-a");
  f.insertItem("wi-b");
  const branchA = f.planFor("wi-a").member;

  // 直开（容量 1 未满）：run 行 + 树同时发生 ⇒ 两枚事实一起投影。
  const opened = await f.openFor("run-direct", "wi-a");
  assert.equal(opened.kind === "opened" ? opened.branch : null, branchA);
  const direct = f.timeline("wi-a");
  assert.deepEqual(
    direct.map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-direct:started"],
      ["worktree_created", "run:run-direct:worktree_created"],
    ],
  );
  assert.deepEqual(direct[0]!.payload, {
    agentId: f.agent.id,
    isLeaderTask: false,
    branch: branchA,
  });
  assert.deepEqual(direct[1]!.payload, { branch: branchA, agentId: f.agent.id });
  assert.deepEqual(direct[0]!.sourceRun, {
    runId: "run-direct",
    agentId: f.agent.id,
    role: "member",
  });
  assert.deepEqual(direct[0]!.actor, { kind: "system", id: "squad-runtime" });
  assert.equal(direct[0]!.occurredAt, direct[1]!.occurredAt, "同点发生的两枚事实共享时刻");

  // 排队出口（容量已满、另一工作项 ⇒ 不撞活跃/义务臂）：**还没开跑** ⇒ 零枚。
  assert.deepEqual(await f.openFor("run-queued", "wi-b"), { kind: "queued", runId: "run-queued" });
  assert.deepEqual(f.timeline("wi-b"), [], "排队不是「开跑」这条事实：不得投影");

  // 释放容量后同 runId 重投 = 认领升级（queued→open + 建树）⇒ 两枚。
  await f.runtime.lifecycle.failMemberRun({ runId: "run-direct", reason: "c3b2-fixture" });
  const promoted = await f.openFor("run-queued", "wi-b");
  assert.equal(promoted.kind, "opened");
  assert.deepEqual(
    f.timeline("wi-b").map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-queued:started"],
      ["worktree_created", "run:run-queued:worktree_created"],
    ],
    "认领升级也是「开跑」：两枚一起落",
  );
  const branchB = f.planFor("wi-b").member;
  assert.deepEqual(f.timeline("wi-b")[1]!.payload, { branch: branchB, agentId: f.agent.id });
});

test("C3b.2-② 队长登记 ⇒ 恰一枚 run_started（role=leader、无 branch、零 worktree_created）；被吸收的重复指派零新增", async () => {
  const f = await setup();
  f.insertItem("wi-leader");
  f.insertItem("wi-leader-2");

  // 名册内有定义（带闸的 recorded 出口）。
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "run-leader",
      workItemId: "wi-leader",
      agentId: f.agent.id,
    }),
    { recorded: true },
  );
  const rows = f.timeline("wi-leader");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey]),
    [["run_started", "run:run-leader:started"]],
    "队长 run 无树：只 run_started 一枚，不得写 worktree_created",
  );
  assert.deepEqual(rows[0]!.payload, { agentId: f.agent.id, isLeaderTask: true });
  assert.deepEqual(rows[0]!.sourceRun, {
    runId: "run-leader",
    agentId: f.agent.id,
    role: "leader",
  });

  // 进行中的重复指派 ⇒ 吸收（不产生第二行）⇒ 也不得投影第二枚。
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "run-leader-absorbed",
      workItemId: "wi-leader",
      agentId: f.agent.id,
    }),
    { recorded: false, reason: "in_progress_run_exists" },
  );
  assert.equal(f.timeline("wi-leader").length, 1, "被吸收的指派没有开跑：不得投影");

  // 名册缺席（A5：不闸、照旧登记）⇒ 另一条 recorded 出口同样投影。
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "run-leader-off-roster",
      workItemId: "wi-leader-2",
      agentId: "ta-off-roster",
    }),
    { recorded: true },
  );
  assert.deepEqual(
    f.timeline("wi-leader-2").map((row) => [row.kind, row.sourceRun?.role]),
    [["run_started", "leader"]],
  );
});

test("C3b.2-③ 队员产出入账 ⇒ run_completed(status=produced)；随后工作项推进的 status_changed 同线可见", async () => {
  const f = await setup();
  f.insertItem("wi-done");
  await f.openFor("run-member", "wi-done");
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-member" });

  const rows = f.timeline("wi-done");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey.replace(/:\d+$/, ":<ms>")]),
    [
      ["run_started", "run:run-member:started"],
      ["worktree_created", "run:run-member:worktree_created"],
      ["run_completed", "run:run-member:completed"],
      ["status_changed", "status:wi-done:in_progress:in_review:<ms>"],
    ],
    "收口（produced）与它的工作项推进（in_review）按发生次序落在同一条时间线上",
  );
  const completed = rows[2]!;
  assert.deepEqual(completed.payload, {
    status: "produced",
    agentId: f.agent.id,
    isLeaderTask: false,
  });
  assert.deepEqual(completed.sourceRun, {
    runId: "run-member",
    agentId: f.agent.id,
    role: "member",
  });
  assert.match(rows[3]!.dedupKey, /^status:wi-done:in_progress:in_review:\d+$/);
  assert.deepEqual(rows[3]!.payload, { from: "in_progress", to: "in_review" });
});

test("C3b.2-④ 队长成功收口 ⇒ run_completed(status=merged)；不推工作项状态（线上无 status_changed）", async () => {
  const f = await setup();
  f.insertItem("wi-leader-done");
  await f.runtime.lifecycle.recordLeaderRun({
    runId: "run-leader-done",
    workItemId: "wi-leader-done",
    agentId: "ta-off-roster",
  });
  await f.runtime.lifecycle.completeLeaderRun({ runId: "run-leader-done" });

  const rows = f.timeline("wi-leader-done");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-leader-done:started"],
      ["run_completed", "run:run-leader-done:completed"],
    ],
    "队长 run 只有「起点 + 终点」两枚；§5.7(2) 不改父项状态 ⇒ 不得出现 status_changed",
  );
  assert.deepEqual(rows[1]!.payload, {
    status: "merged",
    agentId: "ta-off-roster",
    isLeaderTask: true,
  });
  assert.deepEqual(rows[1]!.sourceRun, {
    runId: "run-leader-done",
    agentId: "ta-off-roster",
    role: "leader",
  });
  assert.equal(f.settled.includes("run-leader-done:merged"), true, "前置：收口事实已扇出");
});

test("C3b.2-⑤ 审查通过 ⇒ worktree_merged（branch + integration 字面量）", async () => {
  const f = await setup();
  f.insertItem("wi-merge");
  await f.openFor("run-merge", "wi-merge");
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-merge" });
  assert.deepEqual(
    await f.runtime.lifecycle.reviewMemberRun({ runId: "run-merge", verdict: "approved" }),
    {
      ok: true,
      merged: true,
    },
  );

  const plan = f.planFor("wi-merge");
  const rows = f.timeline("wi-merge");
  assert.deepEqual(
    rows.slice(2).map((row) => [row.kind, row.dedupKey.replace(/:\d+$/, ":<ms>")]),
    [
      ["run_completed", "run:run-merge:completed"],
      ["status_changed", "status:wi-merge:in_progress:in_review:<ms>"],
      ["worktree_merged", "run:run-merge:worktree_merged"],
    ],
  );
  assert.deepEqual(rows[4]!.payload, {
    branch: plan.member,
    integration: plan.integration,
    agentId: f.agent.id,
  });
  assert.deepEqual(rows[4]!.sourceRun, {
    runId: "run-merge",
    agentId: f.agent.id,
    role: "member",
  });
});

test("C3b.2-⑥ 摘树删分支 ⇒ worktree_discarded（branch + dirName 字面量）；打回 ⇒ 恰一枚 run_rejected", async () => {
  const f = await setup();
  f.insertItem("wi-discard");
  await f.openFor("run-discard", "wi-discard");
  await f.runtime.lifecycle.discardMemberRun({ runId: "run-discard" });

  const plan = f.planFor("wi-discard");
  const rows = f.timeline("wi-discard");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-discard:started"],
      ["worktree_created", "run:run-discard:worktree_created"],
      ["worktree_discarded", "run:run-discard:worktree_discarded"],
    ],
  );
  assert.deepEqual(rows[2]!.payload, { branch: plan.member, dirName: memberDirName(plan) });

  /* 打回臂（2026-10-08 用户裁定：第 19 枚 `run_rejected`，设计 §10-2 登记格就此关闭）：
     打回待修 ⇒ 时间线**恰一枚** `run_rejected`；树一个字节不动（spec §6.2 要活到合并）
     ⇒ 没有 worktree 事实。 */
  f.insertItem("wi-reject");
  await f.openFor("run-reject", "wi-reject");
  const rejectPlan = f.planFor("wi-reject");
  assert.deepEqual(
    await f.runtime.lifecycle.reviewMemberRun({ runId: "run-reject", verdict: "rejected" }),
    {
      ok: true,
      merged: false,
      kept: true,
    },
  );
  assert.equal(
    f.runtime.squadRunRepo.get("run-reject")?.status,
    "rejected",
    "前置：打回是既成事实",
  );
  const rejectRows = f.timeline("wi-reject");
  assert.deepEqual(
    rejectRows.map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-reject:started"],
      ["worktree_created", "run:run-reject:worktree_created"],
      ["run_rejected", "run:run-reject:rejected"],
    ],
    "打回落恰一枚 run_rejected，且排在开跑/建树之后（事实先落、投影随后）",
  );
  assert.deepEqual(rejectRows[2]!.payload, { branch: rejectPlan.member, agentId: f.agent.id });
  assert.deepEqual(rejectRows[2]!.sourceRun, {
    runId: "run-reject",
    agentId: f.agent.id,
    role: "member",
  });
  assert.ok(f.settled.includes("run-reject:rejected"), "结算事实扇出不变（投影只是回声）");
  /* 同一条 run 再被打回一次（重投 / 双路径）：`run:<id>:rejected` 一键一行 ⇒ 不落第二枚。 */
  await f.runtime.lifecycle.reviewMemberRun({ runId: "run-reject", verdict: "rejected" });
  assert.deepEqual(
    f.timeline("wi-reject").map((row) => row.kind),
    ["run_started", "worktree_created", "run_rejected"],
    "同一条 run 的「被打回」事实至多一枚（键身份 = runId，不带毫秒段）",
  );
});

test("C3b.2-⑦ 失败出口按原因分流：user_cancel ⇒ run_cancelled；看门狗族与其余 ⇒ run_failed（原因原文进 payload）", async () => {
  const f = await setup();
  /* 五条失败各用**一个工作项**（分支计划按 (workItem, agent) 派生）：失败收口不摘树（spec §6.6
     留给回收器）⇒ 同一对再开必然撞分支，故每条 run 换一个工作项。看门狗族三个码值逐条覆盖。 */
  const cases = [
    { runId: "run-cancel", reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL, kind: "run_cancelled" },
    ...SQUAD_RUN_WATCHDOG_SETTLE_REASONS.map((reason, index) => ({
      runId: `run-watchdog-${index}`,
      reason,
      kind: "run_failed",
    })),
    { runId: "run-other", reason: "boom", kind: "run_failed" },
  ] as const;

  for (const entry of cases) {
    const itemId = `wi-fail-${entry.runId}`;
    f.insertItem(itemId);
    assert.equal(
      (await f.openFor(entry.runId, itemId)).kind,
      "opened",
      `前置：${entry.runId} 应直开`,
    );
    await f.runtime.lifecycle.failMemberRun({ runId: entry.runId, reason: entry.reason });

    const rows = f.timeline(itemId);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.dedupKey]),
      [
        ["run_started", `run:${entry.runId}:started`],
        ["worktree_created", `run:${entry.runId}:worktree_created`],
        [
          entry.kind,
          `run:${entry.runId}:${entry.kind === "run_cancelled" ? "cancelled" : "failed"}`,
        ],
      ],
      `失败原因「${entry.reason}」应映射到 ${entry.kind}`,
    );
    const terminal = rows[2]!;
    if (entry.kind === "run_cancelled") {
      assert.deepEqual(terminal.payload, { reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL });
    } else {
      assert.deepEqual(terminal.payload, { reason: entry.reason, agentId: f.agent.id });
    }
  }
});

/* ---------- 三臂负向：内部处置不得进时间线（设计 §5.1/§5.2 的红线格） ----------
   三臂（清扫 `settlePairResidualRuns` / 等待臂释放占位 / 重开臂的结算）与「真弃树」在台账上
   同为 `discarded`、同为无 reason；从 `(status, reason)` 反推必然把这三臂投影成用户可见事实。
   故意图由调用方声明、缺省 = 不投影 —— 下面逐臂钉死「零枚」。 */

test("C3b.2-⑧ 负向·清扫臂：别人的无树残行被结算 ⇒ 零活动（内部处置，不是用户可见事实）", async () => {
  const f = await setup();
  f.insertItem("wi-residual");
  const branch = f.planFor("wi-residual").member;

  // ① 造残行：先落一条只有分支 ref 的残枝 ⇒ 建树失败，台账行留在 open 且无树。
  const made = await f.git(["branch", branch, "main"]);
  assert.equal(made.code, 0, `前置：残枝应能建出来（stderr=${made.stderr}）`);
  await assert.rejects(
    () => f.openFor("run-residual", "wi-residual"),
    /已被另一工作树占用|already exists/,
  );
  assert.equal(f.runtime.squadRunRepo.get("run-residual")?.status, "open");
  assert.deepEqual(
    f.timeline("wi-residual"),
    [],
    "建树失败原样抛 ⇒「开跑」这条事实没发生：不得投影",
  );

  // ② 残枝被清 ⇒ 分支空闲；新请求进来 ⇒ 清扫臂把那条**别人的**残行结算掉。
  assert.equal((await f.git(["branch", "-D", branch])).code, 0);
  assert.equal((await f.openFor("run-fresh", "wi-residual")).kind, "opened");
  assert.ok(
    f.settled.includes("run-residual:discarded"),
    "前置：清扫臂确实结算了残行（事实已扇出）",
  );

  assert.deepEqual(
    f.timeline("wi-residual").map((row) => [row.kind, row.sourceRun?.runId]),
    [
      ["run_started", "run-fresh"],
      ["worktree_created", "run-fresh"],
    ],
    "被清扫的残行零枚：投影它等于写「这条 run 开过/失败过」的谎话",
  );
});

test("C3b.2-⑨ 负向·等待臂：残行结算 + 释放分支占位 ⇒ 零活动；占位收净后重投才重开、恰两枚", async () => {
  const f = await setup();
  f.insertItem("wi-wait");
  const plan = f.planFor("wi-wait");

  // ① 别的 run 开树后失败收口：行离开活跃集，树留给回收器（占位）。
  assert.equal((await f.openFor("run-other", "wi-wait")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "run-other", reason: "c3b2-fixture" });
  // ② 本请求建树失败（分支被占）⇒ 残行。
  await assert.rejects(() => f.openFor("run-wait", "wi-wait"), /已被另一工作树占用|already exists/);

  // ③ 重投：活树占着分支且同对另有 run 行 ⇒ 等待臂（结算本行 + 释放占位 + 保留请求身份）。
  assert.deepEqual(await f.openFor("run-wait", "wi-wait"), {
    kind: "residual_blocked",
    branch: plan.member,
  });
  assert.deepEqual(
    f.timeline("wi-wait").map((row) => [row.kind, row.sourceRun?.runId]),
    [
      ["run_started", "run-other"],
      ["worktree_created", "run-other"],
      ["run_failed", "run-other"],
    ],
    "等待臂的结算与占位释放都是内部处置 ⇒ 本行零枚（线上只有别的 run 自己的事实）",
  );
  assert.equal(f.runtime.squadRunRepo.get("run-wait")?.branch, null, "前置：分支占位已释放");

  // ④ 回收器收净占位树与分支 ⇒ 同一条重投重开（awaiting 臂）⇒ 恰两枚。
  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [memberDirName(plan)]);
  assert.deepEqual(reaped.reclaimedBranches, [plan.member]);
  assert.equal((await f.openFor("run-wait", "wi-wait")).kind, "opened");
  assert.deepEqual(
    f
      .timeline("wi-wait")
      .slice(3)
      .map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-wait:started"],
      ["worktree_created", "run:run-wait:worktree_created"],
    ],
    "重开才是「开跑」这条事实：等待臂那一次一枚都不落",
  );
});

test("C3b.2-⑩ 负向·重开臂：残行结算与同 runId 重开在一次调用内完成 ⇒ 结算零枚、重开恰两枚", async () => {
  const f = await setup();
  f.insertItem("wi-reopen");
  const branch = f.planFor("wi-reopen").member;

  // ① 残枝占名 ⇒ 建树失败 ⇒ 残行（行在 open、无树）；清残枝 ⇒ 分支空闲。
  assert.equal((await f.git(["branch", branch, "main"])).code, 0);
  await assert.rejects(
    () => f.openFor("run-reopen", "wi-reopen"),
    /已被另一工作树占用|already exists/,
  );
  assert.deepEqual(f.timeline("wi-reopen"), []);
  assert.equal((await f.git(["branch", "-D", branch])).code, 0);

  // ② 同一 runId 重投 ⇒ 先结算那条残行（内部处置）、再重开新树（用户可见的开跑）。
  assert.equal((await f.openFor("run-reopen", "wi-reopen")).kind, "opened");
  assert.deepEqual(
    f.timeline("wi-reopen").map((row) => [row.kind, row.dedupKey]),
    [
      ["run_started", "run:run-reopen:started"],
      ["worktree_created", "run:run-reopen:worktree_created"],
    ],
    "同一调用内的结算不投影：它只是重开的前置处置；重开才是事实",
  );
  assert.deepEqual(f.settled, ["run-reopen:discarded"], "前置：那一次内部结算确实扇出过");
});

test("C3b.2-⑪ 幂等：同 run 重投不翻倍（出口早退 + dedupKey 同键重投返回既存行）", async () => {
  const f = await setup();
  f.insertItem("wi-idem");
  await f.openFor("run-idem", "wi-idem");
  await f.runtime.lifecycle.failMemberRun({
    runId: "run-idem",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  const baseline = f.timeline("wi-idem").map((row) => row.kind);
  assert.deepEqual(baseline, ["run_started", "worktree_created", "run_cancelled"]);

  // 同一条失败事实重投（宿主重放 / 双路径）：幂等早退 ⇒ 不翻倍。
  await f.runtime.lifecycle.failMemberRun({
    runId: "run-idem",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  // 同 runId 已登记的重投：already_registered 早退 ⇒ 不翻倍。
  assert.deepEqual(await f.openFor("run-idem", "wi-idem"), { kind: "already_registered" });
  assert.deepEqual(
    f.timeline("wi-idem").map((row) => row.kind),
    baseline,
    "重投不得让时间线增行",
  );

  // dedupKey 幂等本体：同键重投返回既存行（真实库上的唯一索引），不新建、不翻倍。
  const record = f.runtime.squadRunRepo.get("run-idem")!;
  f.runtime.activityProjector.runStarted(record);
  f.runtime.activityProjector.runStarted(record);
  f.runtime.activityProjector.runSettled(record, {
    kind: "run_cancelled",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  assert.deepEqual(
    f.timeline("wi-idem").map((row) => row.kind),
    baseline,
    "run:<id>:started / run:<id>:cancelled 同键重投：行数不变（形状天然幂等）",
  );

  // 队长成功收口同款：已是 merged ⇒ 幂等返回，不写第二枚 run_completed。
  f.insertItem("wi-idem-leader");
  await f.runtime.lifecycle.recordLeaderRun({
    runId: "run-idem-leader",
    workItemId: "wi-idem-leader",
    agentId: "ta-off-roster",
  });
  await f.runtime.lifecycle.completeLeaderRun({ runId: "run-idem-leader" });
  await f.runtime.lifecycle.completeLeaderRun({ runId: "run-idem-leader" });
  assert.deepEqual(
    f.timeline("wi-idem-leader").map((row) => row.kind),
    ["run_started", "run_completed"],
  );
});

test("C3b.2-⑫ 演示终点：派发→开跑→完成→审查合并→清树 后，时间线=完整审计流（真库实体 + 真 git）", async () => {
  const f = await setup();
  f.insertItem("wi-chain");
  const plan = f.planFor("wi-chain");

  assert.equal((await f.openFor("run-chain", "wi-chain")).kind, "opened");
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-chain" });
  assert.deepEqual(
    await f.runtime.lifecycle.reviewMemberRun({ runId: "run-chain", verdict: "approved" }),
    {
      ok: true,
      merged: true,
    },
  );
  await f.runtime.lifecycle.discardMemberRun({ runId: "run-chain" });

  // 真库实体断言：读面是生产读面（`listByWorkItem`），不是内存回声。
  const rows = f.activities.listByWorkItem(WS, "wi-chain");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.dedupKey.replace(/:\d+$/, ":<ms>")]),
    [
      ["run_started", "run:run-chain:started"],
      ["worktree_created", "run:run-chain:worktree_created"],
      ["run_completed", "run:run-chain:completed"],
      ["status_changed", "status:wi-chain:in_progress:in_review:<ms>"],
      ["worktree_merged", "run:run-chain:worktree_merged"],
      ["worktree_discarded", "run:run-chain:worktree_discarded"],
    ],
    "全链后时间线 = 完整审计流（此前只有评论与决定）",
  );
  // 读回纪律抽查：run 族七枚必带合法角色与系统主体；工作项族不带 run 归属。
  for (const row of rows.filter((candidate) => candidate.kind !== "status_changed")) {
    assert.deepEqual(row.sourceRun, { runId: "run-chain", agentId: f.agent.id, role: "member" });
    assert.deepEqual(row.actor, { kind: "system", id: "squad-runtime" });
    assert.deepEqual(row.initiatedBy, { kind: "system", id: "squad-runtime" });
  }
  assert.equal(rows[3]!.sourceRun, null, "状态变迁没有 run 归属：不得猜 role");
  assert.deepEqual(rows[1]!.payload, { branch: plan.member, agentId: f.agent.id });
  assert.deepEqual(rows[4]!.payload, {
    branch: plan.member,
    integration: plan.integration,
    agentId: f.agent.id,
  });
  assert.deepEqual(rows[5]!.payload, { branch: plan.member, dirName: memberDirName(plan) });

  // 链真的走完了（真 git）：树已摘、分支已删、台账终态 discarded。
  assert.deepEqual(await f.runtime.worktreeManager.list(), []);
  assert.notEqual(
    (await f.git(["rev-parse", "-q", "--verify", `refs/heads/${plan.member}`])).code,
    0,
  );
  assert.equal(f.runtime.squadRunRepo.get("run-chain")?.status, "discarded");
});

test("C3b.2-⑬ 整批放弃（编排器 discardBatch）：逐 run worktree_discarded + 父项 status_changed(cancelled)", async () => {
  const f = await setup();
  f.insertItem("wi-parent");
  f.insertItem("wi-child-a", "in_progress", "wi-parent");
  f.insertItem("wi-child-b", "in_progress", "wi-parent");
  const agentB = f.runtime.teamAgentService.create({
    name: "c3b2-agent-b",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });

  // 两名队员（各自的工作项）各开一棵树并产出入账 ⇒ 批进行到一半。
  assert.equal(
    (await f.openWith("run-batch-a", "wi-child-a", "wi-parent", f.agent.id)).kind,
    "opened",
  );
  assert.equal(
    (await f.openWith("run-batch-b", "wi-child-b", "wi-parent", agentB.id)).kind,
    "opened",
  );
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-batch-a" });
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-batch-b" });

  // 用户整批放弃：弃树走 `discardMemberRun`（唯一实现）、父项 cancelled 走 `transition`（唯一写者）。
  await createSquadOrchestrator({ runtime: f.runtime }).discardBatch({
    workspaceKey: WS,
    parentWorkItemId: "wi-parent",
  });

  for (const [runId, itemId] of [
    ["run-batch-a", "wi-child-a"],
    ["run-batch-b", "wi-child-b"],
  ] as const) {
    assert.deepEqual(
      f.timeline(itemId).map((row) => [row.kind, row.sourceRun?.runId ?? null]),
      [
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
    f.timeline("wi-parent").map((row) => [row.kind, row.payload]),
    [["status_changed", { from: "in_progress", to: "cancelled" }]],
    "父项整批放弃的状态流转同线可见（经唯一写者 transition）",
  );
  assert.deepEqual(await f.runtime.worktreeManager.list(), [], "两棵树都已摘（真 git）");
});
