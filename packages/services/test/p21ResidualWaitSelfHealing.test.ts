/* P2-1 修复轮：**等待型残行的自愈回路**（D6+C1 复验 §7 P2-1 的执行级复现）。

复验抓到的事实链（修前）：等待行 open ⇒ 它的分支进 `computeActiveBranches` ⇒ 回收器两遍都以
「分支还在活跃集」为保留判据 ⇒ 占位树/残枝一个字节不动 ⇒ 重投永远 `residual_blocked`
⇒ receipt 永挂 pending（修前那一格是**可见** failed —— 不可见比可见更坏）。

修法（主会话裁定 ① 的行级判据 + 落地细化）：
· 判据：**行级**「本行无树」——活树属**别的** run 行时，本行仍是无树残行（不是「可能是我的树」）；
· 动作：这类行**结算**（`discarded` + 结算事实扇出：释放容量）**并释放分支占位**
  （行仍 `open`：请求身份 = runId 不换，`receipt.dispatchKey` 的补投扫描照旧看得见它），
  然后等回收器把不属于任何活跃行的占位/残枝收净；
· 后续重投：分支空出后，同一条 run 行重新挂上分支计划 + 建树（`opened`）—— 回路闭合。

期望值取契约面：`OpenMemberRunResult` 判别值、台账行的 status/branch/sessionId、结算 hub 事件、
`WorktreeManager.list`、分支 ref（真 git）、`reapStartupOrphans` 的 reclaimed/kept/reclaimedBranches。
不读实现中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { planBranches, memberDirName } from "../src/worktree/branchNaming.js";
import { isTreelessOpenMemberRun } from "../src/workitem/squadRunLifecycle.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import { slugForId } from "../src/workitem/slug.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "p21-ws";

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
  const agent = runtime.teamAgentService.create({
    name: "p21-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "p21-wi";
  runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "P2-1 等待型自愈",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 0,
  });
  const plan = planBranches({ workItemSlug: slugForId(itemId), agentSlug: slugForId(agent.id) });
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const row = (runId: string) => runtime.squadRunRepo.get(runId);
  const settleOf = (runId: string) => settled.filter((event) => event.runId === runId);
  const openFor = (runId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId: agent.id,
      isLeaderTask: false,
    });
  const trees = () => runtime.worktreeManager.list();
  const branchExists = async (name: string): Promise<boolean> =>
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0;
  const reap = () => runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  return {
    runtime,
    itemId,
    agent,
    plan,
    branch: plan.member,
    dirName: memberDirName(plan),
    git,
    row,
    settled,
    settleOf,
    openFor,
    trees,
    branchExists,
    reap,
  };
}

test("P2-1 等待型（占位树属别的 run 行）：重投结算本行并释放分支占位 ⇒ 回收器收净 ⇒ 后续重投重开新树", async () => {
  const f = await setup();
  /* ① 别的 run 开了树后失败收口：行离开活跃集，树按 spec §6.6 留给回收器（占位）。 */
  assert.equal((await f.openFor("p21-other")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "p21-other", reason: "p21-fixture" });
  assert.equal(f.row("p21-other")?.status, "discarded", "前置：占树行已终态");

  /* ② 本请求建树失败（目录/分支被占）⇒ 台账留下「有行无树」的残行。 */
  await assert.rejects(() => f.openFor("p21-run"), /已被另一工作树占用|already exists/);
  assert.equal(f.row("p21-run")?.status, "open");
  assert.equal(f.row("p21-run")?.sessionId, null);

  /* ③ 重投：活树占着分支，但**同一对还有别的 run 行** ⇒ 那棵树另有来路（本行从未建出过树）
     ⇒ 按行级判据结算本行（恰一次）+ 释放分支占位，结论仍是等待型（不建会话、不发 prompt）。 */
  assert.deepEqual(await f.openFor("p21-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(
    f.settleOf("p21-run"),
    [{ runId: "p21-run", status: "discarded" }],
    "等待行必须恰结算一次（结算事实扇出：容量释放 + 推进回路被触发）",
  );
  assert.equal(
    f.row("p21-run")?.status,
    "open",
    "请求身份保留：行仍在 open（runId = receipt.dispatchKey）",
  );
  assert.equal(f.row("p21-run")?.branch, null, "分支占位已释放：本行不再把别人的占位钉在活跃集里");
  assert.equal(f.row("p21-run")?.sessionId, null, "仍无会话（没有执行过）");
  assert.equal((await f.trees()).length, 1, "不得复用别人的树、也不得再建一棵");

  /* ④ 分支离开活跃集 ⇒ 回收器能把占位连树带枝收净（修前：等待行钉住 ⇒ kept 不动、一个字节不收）。 */
  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [f.dirName], "占位树进回收面（不再被本行钉住）");
  assert.deepEqual(reaped.reclaimedBranches, [f.branch], "分支名释放（重派发的前置）");
  assert.deepEqual(reaped.kept, [], "没有留在原地的东西");
  assert.equal(await f.branchExists(f.branch), false);

  /* ⑤ 后续重投（同 runId）：分支空出 ⇒ 重新挂上分支计划并建树 ⇒ 请求真正跑起来。 */
  const opened = await f.openFor("p21-run");
  assert.equal(opened.kind, "opened", "回路必须闭合：同一条请求在占位被收净后能开新树");
  assert.equal(opened.kind === "opened" ? opened.branch : "", f.branch);
  assert.equal(f.row("p21-run")?.branch, f.branch, "分支计划重新挂上");
  assert.equal(f.row("p21-run")?.status, "open");
  assert.equal((await f.trees()).length, 1, "恰一棵新树（不重复、不多余）");
  assert.deepEqual(
    f.settleOf("p21-run"),
    [{ runId: "p21-run", status: "discarded" }],
    "重开不再结算（结算只在「释放占位」那一次扇出）",
  );
});

test("P2-1 等待型（只有同名残枝、无活树）：重投结算并释放占位 ⇒ 回收器第二遍收掉残枝 ⇒ 后续重投重开新树", async () => {
  const f = await setup();
  const made = await f.git(["branch", f.branch, "main"]);
  assert.equal(made.code, 0, `前置：先落一条残枝（stderr=${made.stderr}）`);
  await assert.rejects(() => f.openFor("p21-run"), /已被另一工作树占用|already exists/);
  assert.deepEqual(await f.trees(), [], "前置：残枝没有工作树（只有分支 ref）");

  assert.deepEqual(
    await f.openFor("p21-run"),
    { kind: "residual_blocked", branch: f.branch },
    "残枝占着名字 ⇒ 等待型（`worktree add -b` 必然撞名）",
  );
  assert.deepEqual(
    f.settleOf("p21-run"),
    [{ runId: "p21-run", status: "discarded" }],
    "残枝型同样按行级判据结算恰一次（本行无树 ⇒ 不为它钉住任何东西）",
  );
  assert.equal(f.row("p21-run")?.branch, null, "释放分支占位 ⇒ 残枝进回收面");

  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [], "残枝没有工作树（第一遍为空）");
  assert.deepEqual(
    reaped.reclaimedBranches,
    [f.branch],
    "残枝被第二遍收掉（修前：挂在本行的活跃分支上，不收）",
  );
  assert.equal(await f.branchExists(f.branch), false);

  const opened = await f.openFor("p21-run");
  assert.equal(opened.kind, "opened", "残枝清掉后同一条请求必须能开新树（自愈回路闭合）");
  assert.equal(f.row("p21-run")?.branch, f.branch);
  assert.equal((await f.trees()).length, 1);
});

test("P2-1 保守边界：同对**带会话**的进行中 run 行不在清扫面（不结算、不复用、树保留、请求走义务等待）", async () => {
  const f = await setup();
  /* 进行中的 run：open + 已绑会话 + 活树。它是「活 run 行」——判据（sessionId===null）把它挡在清扫面外。 */
  assert.equal((await f.openFor("p21-live")).kind, "opened");
  await f.runtime.lifecycle.bindMemberRunSession({ runId: "p21-live", sessionId: "sess-live" });
  assert.equal((await f.trees()).length, 1);

  /* 同对再来一条请求：分派被「已有活跃 run」挡成 deferred 义务（排队重放），不新增行、不动那棵树。 */
  assert.deepEqual(await f.openFor("p21-next"), { kind: "deferred", runId: "p21-next" });
  assert.equal(f.row("p21-live")?.status, "open");
  assert.equal(f.row("p21-live")?.sessionId, "sess-live", "活 run 行一个字节不动");
  assert.equal(f.row("p21-live")?.branch, f.branch, "分支占位仍是它的（活树必须留在活跃集里）");
  assert.deepEqual(f.settled, [], "清扫不得扇出任何结算事实");

  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [], "回收器不碰进行中 run 的树");
  assert.deepEqual(reaped.kept, [f.dirName], "带会话的活 run 行仍在活跃集 ⇒ 树保留（硬约束 2）");
  assert.equal((await f.trees()).length, 1);
});

test("P2-1 行级判据（纯函数）：活树属**别的** run 行时本行仍算「有行无树」", async () => {
  const live = new Set(["squad/member/wi/a"]);
  const row = (over: Record<string, unknown> = {}) =>
    ({
      status: "open",
      sessionId: null,
      branch: "squad/member/wi/a",
      isLeaderTask: false,
      ...over,
    }) as never;

  assert.equal(
    isTreelessOpenMemberRun(row(), { liveTreeBranches: live, liveTreeOfOtherRow: false }),
    false,
    "只有本行一条 run 行时：分支上挂着活树 ⇒ 可能是本行崩溃前建的树 ⇒ 不是残行",
  );
  assert.equal(
    isTreelessOpenMemberRun(row(), { liveTreeBranches: live, liveTreeOfOtherRow: true }),
    true,
    "同一对还有别的 run 行 ⇒ 那棵树另有来路（一行一树）⇒ 本行仍是无树残行（P2-1 的判据扩展）",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ branch: "squad/member/wi/free" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: false,
    }),
    true,
    "分支上没有活树 ⇒ 残行（原判据不变）",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ sessionId: "s-1" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "有会话 = 已走过建树那一步：判据不看「别的行」，任何情况下都不动它",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ isLeaderTask: true }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "队长行没有树（不适用本判据）",
  );
  assert.equal(
    isTreelessOpenMemberRun(row({ status: "produced" }), {
      liveTreeBranches: live,
      liveTreeOfOtherRow: true,
    }),
    false,
    "produced 意味着产出过（树必然存在过）",
  );
});
