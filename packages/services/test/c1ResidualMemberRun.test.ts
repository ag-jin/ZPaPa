/* C1 插队轮（§8-P1）：**「有行无树」的残行按可结算处理**。

   缺陷序列（X2.2 复验 §8-P1，复现用例在 x22NoCollisionPipeline.test.ts 第 2 条）：
   建树失败（分支被占 / 目录冲突）时 `openMemberRun` 的**台账先行**会把 open 行留在库里而没有树
   → 同对重放/补投扫描命中「已登记」幂等臂（不再建树）→ host 手里没有工作树 ⇒ 按队员缺树判
   **permanent 失败** ⇒ 评论 receipt 落终局 failed —— 即使回收器随后会清掉残枝，这条请求也永不执行。

   本轮修法（主会话预裁 + 结构事实）：残行（open + 未绑会话 + 该分支上没有任何活工作树）
   ⇒ 先结算（`discarded` + 结算事实扇出：释放容量与活跃集），再**同一 runId** 重开新树。
   同一 runId 不可换（结构事实）：runId = 请求身份（`eventKey` = receipt.dispatchKey），
   host 的 bind / 终态收口 / 失败出口与补投扫描的「自己的 run 行」查找都按它定位；
   换一个新 runId 会让 receipt 的 own-run 查不到（`.status !== "open"` ⇒ 扫描永远跳过）。

   期望值取契约面（`OpenMemberRunResult` 判别值、`SQUAD_RUN_ACTIVE_STATUSES` 活跃口径、
   结算 hub 的 `SquadRunSettlement` 形状），不读实现中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { planBranches } from "../src/worktree/branchNaming.js";
import {
  isSettleableResidualMemberRun,
  isTreelessOpenMemberRun,
} from "../src/workitem/squadRunLifecycle.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import { slugForId } from "../src/workitem/slug.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "c1-ws";

/** 缝合夹具：真实 git 仓库 + 真实 runtime（含真实工作树与台账）。 */
async function setup() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const settlements = createSquadRunSettlementHub();
  const settled: Array<{ runId: string; status: string }> = [];
  settlements.subscribe((event) => settled.push({ runId: event.runId, status: event.status }));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    runSettlementHub: settlements,
  });
  // 有名册定义 ⇒ openMemberRun 走「容量/活跃/义务」裁决（无定义则直开，覆盖不到残行判据）。
  const agent = runtime.teamAgentService.create({
    name: "c1-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "c1-wi";
  runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "残行",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 0,
  });
  const branch = planBranches({
    workItemSlug: slugForId(itemId),
    agentSlug: slugForId(agent.id),
  }).member;
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const row = (runId: string) => runtime.squadRunRepo.get(runId);
  const openFor = (runId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId: agent.id,
      isLeaderTask: false,
    });
  const trees = () => runtime.worktreeManager.list();
  return { runtime, itemId, agent, branch, git, row, openFor, trees, settled };
}

test("C1 自身残行（分支空闲）：结算一次 + 同一 runId 重开新树（不再撞「已登记」而把请求判死）", async () => {
  const f = await setup();

  /* ① 制造残行：先占住分支名（模拟上一次建树留下的残枝）⇒ 建树失败 ⇒ 台账行留在 open 而没有树。 */
  const pre = await f.git(["branch", f.branch, "main"]);
  assert.equal(pre.code, 0, `前置：分支应能建出来（stderr=${pre.stderr}）`);
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.equal(f.row("c1-run")?.status, "open", "台账先行：建树失败不回滚登记");
  assert.equal(f.row("c1-run")?.sessionId, null, "还没到建会话那一步");
  assert.deepEqual(await f.trees(), [], "此刻没有属于它的工作树（有行无树 = 残行）");
  assert.deepEqual(f.settled, [], "残行还没被结算过（前置）");

  /* ② 回收器清掉残枝（不自动删分支：本用例手工模拟回收动作）⇒ 分支重新空闲。 */
  const swept = await f.git(["branch", "-D", f.branch]);
  assert.equal(swept.code, 0, `前置：清残枝（stderr=${swept.stderr}）`);

  /* ③ 重投同一 runId：残行按可结算处理 ⇒ 结算（释放容量+活跃集）后重开新树。 */
  const outcome = await f.openFor("c1-run");
  assert.equal(outcome.kind, "opened", "残行必须被重开成真 run（返回值是「已登记」= 请求被判死）");
  assert.equal(outcome.kind === "opened" ? outcome.branch : "", f.branch, "重开的树挂在该对固有的分支名上");
  assert.deepEqual(
    f.settled,
    [{ runId: "c1-run", status: "discarded" }],
    "结算事实必须扇出（队列推进/活跃集收缩靠它；静默改状态 = 排队行永远等不到推进）",
  );

  /* 终局事实：恰好一棵树、台账仍是同一 runId（请求身份不换）、活跃集一条。 */
  const trees = await f.trees();
  assert.equal(trees.length, 1, "重开恰一棵树（不是两棵、也不是零棵）");
  assert.equal(trees[0]!.branch, f.branch);
  assert.equal(f.row("c1-run")?.status, "open", "重开后台账行回到 open（同一 runId 继续走派发）");
  assert.equal(f.row("c1-run")?.sessionId, null, "会话由 host 在建会话后回写（本层不猜）");
  assert.deepEqual(
    f.runtime.squadRunRepo.listByWorkspace(WS).map((r) => [r.runId, r.status]),
    [["c1-run", "open"]],
    "全量台账只有这一行：不新增第二条 run（runId = 请求身份）",
  );
  assert.deepEqual(
    f.runtime.squadRunRepo.listActive(WS).map((r) => r.runId),
    ["c1-run"],
    "活跃集恰一条（结算 + 重开净效果 = 一条活跃 run）",
  );
});

test("C1 同对别的 run 的残行：先结算它（释放活跃集/容量）再开本请求的树，不再被 deferred 钉死", async () => {
  const f = await setup();

  /* ① 别的 run 留下残行：分支先被占 ⇒ 建树失败 ⇒ 它的行留在 open 而没有树。 */
  await f.git(["branch", f.branch, "main"]);
  await assert.rejects(() => f.openFor("c1-old"));
  assert.equal(f.row("c1-old")?.status, "open");
  assert.equal(f.runtime.squadRunRepo.hasActiveRunForPair(WS, f.itemId, f.agent.id), true,
    "前置：残行占着活跃集（不清它 ⇒ 本请求会走 R2 登记义务，而义务永远等不到到期条件）");

  /* ② 回收器清残枝 ⇒ 分支空闲。 */
  await f.git(["branch", "-D", f.branch]);

  /* ③ 新请求（不同 runId）经同一入口：残行先被结算，本请求照常开自己的树。 */
  const outcome = await f.openFor("c1-new");
  assert.equal(outcome.kind, "opened", "残行不该把新请求钉成 deferred（它的树永远不会出现）");
  assert.deepEqual(f.settled, [{ runId: "c1-old", status: "discarded" }], "残行结算事实扇出一次");
  assert.deepEqual(
    f.runtime.squadRunRepo.listByWorkspace(WS).map((r) => [r.runId, r.status]),
    [
      ["c1-old", "discarded"],
      ["c1-new", "open"],
    ],
    "全量台账：残行 discarded、新请求 open（各归各位；行序 = 登记时刻）",
  );
  const trees = await f.trees();
  assert.equal(trees.length, 1, "恰一棵树（属于新请求）");
  assert.equal(trees[0]!.branch, f.branch);
});

test("C1+P2-1 分支被别的 run 的活树占着：结算本行并释放分支占位（不结算别人的活树、不复用、不建第二行）", async () => {
  const f = await setup();

  /* ① 别的 run 开了树后失败（树未回收 = 占位），本请求随后建树失败 ⇒ 本请求留下残行。 */
  const other = await f.openFor("c1-other");
  assert.equal(other.kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-other", reason: "c1-fixture" });
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.equal(f.row("c1-run")?.status, "open");
  assert.equal((await f.trees()).length, 1, "前置：那棵树是 c1-other 的（未回收）");

  /* ② 重投：分支上仍挂着活树 ⇒ 等待型；但本行**从未建出过树**（同一对还有 c1-other 那条行 ⇒
     那棵活树另有来路）⇒ P2-1 修法①：结算本行 + 释放分支占位（请求身份保留在 open 行上）。 */
  const outcome = await f.openFor("c1-run");
  assert.deepEqual(
    outcome,
    { kind: "residual_blocked", branch: f.branch },
    "等待型结论必须如实指出被占的分支：把它翻成 permanent 失败正是本卡要修的「请求被判死」",
  );
  assert.deepEqual(
    f.settled.filter((event) => event.runId === "c1-run"),
    [{ runId: "c1-run", status: "discarded" }],
    "等待行结算恰一次（容量与活跃集如实释放；修前这里不结算 ⇒ 占位永不被收）",
  );
  assert.deepEqual(
    f.settled.filter((event) => event.runId === "c1-other"),
    [{ runId: "c1-other", status: "discarded" }],
    "别人的行只被它自己的失败出口结算一次（清扫不得二次动它）",
  );
  assert.equal(f.row("c1-run")?.branch, null, "分支占位已释放（本行不持有任何树 ⇒ 不再钉住别人的占位）");
  assert.equal(f.row("c1-run")?.status, "open", "请求身份保留：行仍在 open（runId = 请求身份，不换）");
  assert.equal((await f.trees()).length, 1, "不得复用别人的树、也不得再建一棵");
  assert.deepEqual(
    f.runtime.squadRunRepo.listByWorkspace(WS).map((r) => [r.runId, r.status]),
    [
      ["c1-other", "discarded"],
      ["c1-run", "open"],
    ],
    "全量台账不新增行（runId = 请求身份，不换）",
  );
});

test("C1+P2-1 只有同名残枝（无活树）：结算一次并释放占位；之后再重投只读等待，不重复扇出结算事实", async () => {
  const f = await setup();

  /* ① 残枝占着分支名（先建分支、再让它挡住建树）⇒ 本请求留下残行。 */
  await f.git(["branch", f.branch, "main"]);
  await assert.rejects(() => f.openFor("c1-run"));
  assert.deepEqual(await f.trees(), [], "前置：残枝没有工作树（只有分支 ref）");

  /* ② 残枝还在 ⇒ 等待型：结算本行（恰一次）+ 释放分支占位（不白翻台账：结算后不重开，
        因为现在一定建不出树来 —— 等回收器把残枝收掉）。 */
  assert.deepEqual(
    await f.openFor("c1-run"),
    { kind: "residual_blocked", branch: f.branch },
    "分支名被残枝占着 ⇒ 等待型（回收器第二遍按「不在活跃集」把残枝收掉）",
  );
  assert.deepEqual(
    f.settled,
    [{ runId: "c1-run", status: "discarded" }],
    "结算一次为限（重复扇出会让排队推进空转）",
  );
  assert.equal(f.row("c1-run")?.branch, null);
  assert.equal(f.row("c1-run")?.status, "open");

  /* ③ 占位没消失之前再重投：只读等待（同一行、同一结论、零新结算）。 */
  assert.deepEqual(await f.openFor("c1-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(f.settled, [{ runId: "c1-run", status: "discarded" }], "等待态重投幂等");

  /* ④ 回收器清掉残枝（本行已不钉住它）⇒ 重投自愈：结算 + 同一 runId 重开新树。 */
  const reaped = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reaped.reclaimedBranches, [f.branch], "残枝进回收面（修前被等待行钉住 ⇒ 不收）");
  const healed = await f.openFor("c1-run");
  assert.equal(healed.kind, "opened", "残枝清掉后同一条重投必须自愈（不再停留等待型）");
  assert.equal((await f.trees()).length, 1, "恰一棵树");
});

test("C1+P2-1 判据（纯函数）：有行无树的四条件 + 「活树另有来路」的扩展 + 「可结算后立刻重开」还要分支无占用", async () => {
  const live = new Set(["squad/member/wi/a"]);
  const row = (over: Record<string, unknown> = {}) =>
    ({ status: "open", sessionId: null, branch: "squad/member/wi/a", isLeaderTask: false, ...over }) as never;

  assert.equal(
    isTreelessOpenMemberRun(row(), { liveTreeBranches: live, liveTreeOfOtherRow: false }),
    false,
    "只有本行一条 run 行时，分支挂着活树 ⇒ 可能是本行崩溃前建的树 ⇒ 不是「从未建过树」",
  );
  assert.equal(
    isTreelessOpenMemberRun(row(), { liveTreeBranches: live, liveTreeOfOtherRow: true }),
    true,
    "P2-1 扩展：同一对还有别的 run 行 ⇒ 那棵活树另有来路（一行一树）⇒ 本行仍是无树残行",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ branch: "squad/member/wi/free" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: false,
    }),
    true,
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ sessionId: "s-1", branch: "squad/member/wi/free" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "有会话 = 至少走过了建树那一步（「别的行」这条旁证翻不动它）",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ status: "produced", branch: "squad/member/wi/free" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "produced 意味着产出过（树必然存在过）",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ isLeaderTask: true, branch: null }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "队长行本来就没有树（branch=null），不适用本判据",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ branch: null }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "没有分支计划的行不是残行",
  );

  const free = row({ branch: "squad/member/wi/free" });
  assert.equal(
    isSettleableResidualMemberRun(free, {
      liveTreeBranches: live,
      branchRefExists: false,
      liveTreeOfOtherRow: false,
    }),
    true,
    "无活树 + 无同名分支 ⇒ 结算后重开一定建得出树",
  );
  assert.equal(
    isSettleableResidualMemberRun(free, {
      liveTreeBranches: live,
      branchRefExists: true,
      liveTreeOfOtherRow: false,
    }),
    false,
    "只剩残枝也算占用：`worktree add -b` 撞名 ⇒ 白结算一趟",
  );
  assert.equal(
    isSettleableResidualMemberRun(row(), {
      liveTreeBranches: live,
      branchRefExists: false,
      liveTreeOfOtherRow: false,
    }),
    false,
    "活树占着 ⇒ 不可「结算后立刻重开」（复用/删除别人工作面的风险都在这一格）",
  );
  assert.equal(
    isSettleableResidualMemberRun(row(), {
      liveTreeBranches: live,
      branchRefExists: false,
      liveTreeOfOtherRow: true,
    }),
    false,
    "即便活树另有来路（本行确实无树），分支上还挂着树 ⇒ 建不出树来 ⇒ 走「结算 + 释放占位 + 等待」那条臂",
  );
});
