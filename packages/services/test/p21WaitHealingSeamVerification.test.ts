/* P2-1 修复轮**独立复验**（test-verifier）：不复用实现者用例的夹具与结论，只按 D6+C1 复验 §7 P2-1
   的执行级复现链重走一遍，逐段核对，并补两格实现者用例没钉住的**机制面**与**误归属窗口**。

   为什么再写一份：
   ① 实现者的用例断言的是**回收器结果**（reclaimed/kept），而修复主张的机制是
      「等待行释放分支占位 ⇒ 分支**离开活跃集**」——`computeActiveBranches` 这一步没人钉
      （它是回收器保留判据的**唯一输入**：口径一断，reclaimed 的那些断言就会因别的理由通过）；
   ② 保守边界「清扫臂不点亮旁证」的判别性：要把**触发条件**也钉住
      （同一对确有别的 run 行 ⇒ 若清扫点亮旁证就会误结算刚开好树的那一行），
      再断言实际未结算 —— 否则用例可能只是「清扫压根没跑到」；
   ③ 实现者 §6.4 自报的残留风险（同对另有行 + 本行自己的活树 ⇒ 判据把它当残行）需要**可达性实测**：
      在服务面把那个状态原样构造出来，看它到底走哪条臂、后果是什么。

   期望值全取契约面：`OpenMemberRunResult` 判别值、`squad_runs` 列、结算 hub 事件、
   `computeActiveBranches`、`WorktreeManager.list`、分支 ref（真 git）、
   `reapStartupOrphans` 的 reclaimed/kept/reclaimedBranches、纯函数判据。不读实现中间量。 */
import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { planBranches, memberDirName } from "../src/worktree/branchNaming.js";
import {
  isAwaitingBranchMemberRun,
  isSettleableResidualMemberRun,
  isTreelessOpenMemberRun,
} from "../src/workitem/squadRunLifecycle.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import { slugForId } from "../src/workitem/slug.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "p21-seam-ws";

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
    name: "p21-seam-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "p21-seam-wi";
  runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "P2-1 复验",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 0,
  });
  /* 第二个工作项（**另一对**：同 agent 不同 workItem）—— 只为观察 agent 级容量口径。 */
  const item2Id = "p21-seam-wi2";
  runtime.workItemRepo.insert({
    id: item2Id,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "P2-1 复验（第二项）",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 1,
  });
  const plan = planBranches({ workItemSlug: slugForId(itemId), agentSlug: slugForId(agent.id) });
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const row = (runId: string) => runtime.squadRunRepo.get(runId);
  const settleOf = (runId: string) => settled.filter((event) => event.runId === runId);
  const openForItem = (runId: string, workItemId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId: workItemId,
      agentId: agent.id,
      isLeaderTask: false,
    });
  const openFor = (runId: string) => openForItem(runId, itemId);
  const trees = () => runtime.worktreeManager.list();
  /** 活工作树的**目录名**视图（与台账 dirName 同一根口径；路径用 basename 取，不重拼）。 */
  const treeNames = async (): Promise<string[]> =>
    (await trees()).map((entry) => basename(entry.path)).sort();
  const branchExists = async (name: string): Promise<boolean> =>
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0;
  const activeBranches = () => runtime.lifecycle.computeActiveBranches(WS);
  const reap = () => runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  /** 外部手工清掉占位（树 + 分支）——只为把下一格构造成「分支空闲」，不是生产动作。 */
  const clearPlaceholder = async () => {
    await runtime.worktreeManager.remove(memberDirName(plan));
    const del = await git(["branch", "-D", plan.member]);
    assert.equal(del.code, 0, `前置清理失败（stderr=${del.stderr}）`);
  };
  return {
    runtime,
    itemId,
    item2Id,
    agent,
    plan,
    treeNames,
    branch: plan.member,
    dirName: memberDirName(plan),
    git,
    row,
    settled,
    settleOf,
    openFor,
    openForItem,
    trees,
    branchExists,
    activeBranches,
    reap,
    clearPlaceholder,
  };
}

test("P2-1 回路三段①（占位是**别人的**活树）：结算恰一次 → 分支离开活跃集 → 回收器实收 → 同 runId 重投 opened", async () => {
  const f = await setup();
  /* ① 别的 run 开树后失败收口（它的树按 spec §6.6 留给回收器 = 占位）。 */
  assert.equal((await f.openFor("v-other")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "v-other", reason: "seam-fixture" });
  assert.equal(f.row("v-other")?.status, "discarded");
  assert.equal((await f.trees()).length, 1, "前置：占位树还在");

  /* ② 本请求建树失败 ⇒ 残行（open + 无会话 + 有分支计划）。 */
  await assert.rejects(() => f.openFor("v-run"), /已被另一工作树占用|already exists/);

  /* 机制面（第一段）：**修前的钉住**就在这一步 —— 残行的分支进了活跃集，
     而回收器的保留判据恰是「分支在活跃集里」。实现者用例只断言了回收结果，这一格没人钉。 */
  assert.ok(
    (await f.activeBranches()).includes(f.branch),
    "修前形态：残行 open ⇒ 分支在活跃集里 ⇒ 回收器必然 kept（这就是「无自愈出口」的因果起点）",
  );
  const reapedBefore = await f.reap();
  assert.deepEqual(reapedBefore.kept, [f.dirName], "坐实：修前这一格回收器一个字节都不动");
  assert.deepEqual(reapedBefore.reclaimed, []);

  /* ③ 重投 ⇒ 等待臂：结算**恰一次** + 释放分支占位（请求身份保留在同一行、同一 runId）。 */
  assert.deepEqual(await f.openFor("v-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(
    f.settleOf("v-run"),
    [{ runId: "v-run", status: "discarded" }],
    "结算恰一次（hub 计数，不是读实现中间量）",
  );
  assert.deepEqual(
    f.settleOf("v-other"),
    [{ runId: "v-other", status: "discarded" }],
    "别人的行不被二次动",
  );
  const afterRelease = f.row("v-run");
  assert.equal(afterRelease?.status, "open", "请求身份保留（runId = receipt.dispatchKey）");
  assert.equal(afterRelease?.branch, null, "分支占位已释放");
  assert.equal(afterRelease?.dirName, null, "目录名同步释放（判定/动作必须成对）");
  assert.equal(afterRelease?.sessionId, null, "从未执行过：不得凭空绑会话");
  assert.equal((await f.trees()).length, 1, "不得复用别人的树、也不得再建一棵");

  /* 机制面（第二段）：释放后分支确实**离开活跃集** —— 回收器的输入变了。 */
  assert.deepEqual(
    (await f.activeBranches()).includes(f.branch),
    false,
    "释放占位后分支不在活跃集（reclaimed 的断言才有依据）",
  );

  /* 等待态重投幂等（偏离③）：占位没消失之前再重投只读等待，零新结算事实。 */
  assert.deepEqual(await f.openFor("v-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(
    f.settleOf("v-run"),
    [{ runId: "v-run", status: "discarded" }],
    "等待态重投不得重复扇出",
  );

  /* ④ 回收器：占位连树带枝收净。 */
  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [f.dirName], "占位树进回收面");
  assert.deepEqual(reaped.reclaimedBranches, [f.branch], "分支名释放");
  assert.deepEqual(reaped.kept, [], "没有留在原地的东西");
  assert.equal(await f.branchExists(f.branch), false);
  assert.deepEqual(await f.trees(), []);

  /* ⑤ 同 runId 重投 ⇒ 重新挂计划 + 建树（回路闭合），且不再扇出结算事实。 */
  const opened = await f.openFor("v-run");
  assert.equal(opened.kind, "opened", "回路必须闭合：占位收净后同一条请求能开新树");
  assert.equal(opened.kind === "opened" ? opened.branch : "", f.branch);
  assert.equal(
    opened.kind === "opened" ? basename(opened.worktreePath) : "",
    f.dirName,
    "重开的目录名与分支同源（判定按分支、动作用目录名，两者成对）",
  );
  const reopened = f.row("v-run");
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.branch, f.branch, "分支计划重新挂上");
  assert.equal(reopened?.dirName, f.dirName, "目录名与分支同源（重开走的是同一个 pair 的计划）");
  assert.equal((await f.trees()).length, 1, "恰一棵真树");
  assert.equal(await f.branchExists(f.branch), true);
  assert.deepEqual(
    f.settleOf("v-run"),
    [{ runId: "v-run", status: "discarded" }],
    "重开不结算：结算事实仍只有释放占位那一次",
  );
});

test("P2-1 回路三段②（只剩**同名残枝**、无活树）：结算恰一次 → 分支离开活跃集 → 回收器第二遍收枝 → 重投 opened", async () => {
  const f = await setup();
  const made = await f.git(["branch", f.branch, "main"]);
  assert.equal(made.code, 0, `前置：先落一条残枝（stderr=${made.stderr}）`);
  await assert.rejects(() => f.openFor("v-run"), /已被另一工作树占用|already exists/);
  assert.deepEqual(await f.trees(), [], "前置：残枝没有工作树");

  assert.ok(
    (await f.activeBranches()).includes(f.branch),
    "修前形态：残枝挂在 open 行上是活跃分支 ⇒ 回收器第二遍按 active.has(branch) 跳过",
  );

  assert.deepEqual(
    await f.openFor("v-run"),
    { kind: "residual_blocked", branch: f.branch },
    "残枝占着名字 ⇒ 等待臂（`worktree add -b` 必然撞名，重开一定建不出树）",
  );
  assert.deepEqual(f.settleOf("v-run"), [{ runId: "v-run", status: "discarded" }], "结算恰一次");
  assert.equal(f.row("v-run")?.status, "open");
  assert.equal(f.row("v-run")?.branch, null, "占位释放 ⇒ 残枝进回收面");
  assert.deepEqual((await f.activeBranches()).includes(f.branch), false, "分支离开活跃集");

  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [], "残枝没有工作树（第一遍为空）");
  assert.deepEqual(
    reaped.reclaimedBranches,
    [f.branch],
    "第二遍收掉残枝（修前：active.has ⇒ 不收）",
  );
  assert.equal(await f.branchExists(f.branch), false);

  assert.equal((await f.openFor("v-run")).kind, "opened", "残枝清掉后同一条重投必须能开新树");
  assert.equal(f.row("v-run")?.branch, f.branch);
  assert.equal(f.row("v-run")?.dirName, f.dirName);
  assert.equal((await f.trees()).length, 1);
  assert.deepEqual(f.settleOf("v-run"), [{ runId: "v-run", status: "discarded" }], "重开不结算");
});

test("P2-1 保守边界①（**自己的**活树 + 同对无别的行）：不结算、不动行（R5 保真）", async () => {
  const f = await setup();
  assert.equal((await f.openFor("v-own")).kind, "opened");
  assert.equal((await f.trees()).length, 1);

  /* 同 runId 重投：行是 open + 未绑会话 + 有分支，但分支上的活树**可能**是它自己崩溃前建的
     （同一对没有别的行 ⇒ 没有「另有来路」的旁证）⇒ 判据必须判**不是**残行。 */
  assert.deepEqual(await f.openFor("v-own"), { kind: "already_registered" });
  assert.deepEqual(f.settleOf("v-own"), [], "零结算：结算会误报「这条 run 已收口」");
  assert.equal(f.row("v-own")?.branch, f.branch, "分支占位不动");
  assert.equal(f.row("v-own")?.dirName, f.dirName, "目录名不动");
  assert.equal((await f.trees()).length, 1, "不得再建一棵");
  assert.ok((await f.activeBranches()).includes(f.branch), "它的树必须留在活跃集里");

  const reaped = await f.reap();
  assert.deepEqual(reaped.kept, [f.dirName], "回收器不碰进行中 run 的树（硬约束 2）");
  assert.deepEqual(reaped.reclaimed, []);
});

test("P2-1 保守边界②（同对**带会话**的活 run 行）：清扫面外 —— 不清扫、不复用、树保留、请求走义务等待", async () => {
  const f = await setup();
  assert.equal((await f.openFor("v-live")).kind, "opened");
  await f.runtime.lifecycle.bindMemberRunSession({ runId: "v-live", sessionId: "sess-live" });

  assert.deepEqual(
    await f.openFor("v-next"),
    { kind: "deferred", runId: "v-next" },
    "同对已有活跃 run ⇒ R2 义务（不新增行、不动那条行）",
  );
  const live = f.row("v-live");
  assert.equal(live?.status, "open");
  assert.equal(live?.sessionId, "sess-live", "活 run 行一个字节不动");
  assert.equal(live?.branch, f.branch, "分支占位仍是它的");
  assert.deepEqual(f.settled, [], "清扫不得扇出任何结算事实");
  assert.equal((await f.trees()).length, 1);
  assert.ok((await f.activeBranches()).includes(f.branch), "活树必须留在活跃集里");
  assert.equal(f.runtime.squadDeferredDispatchRepo.list(WS).length, 1, "第三条请求由义务表承载");

  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, []);
  assert.deepEqual(reaped.kept, [f.dirName], "带会话的活 run 行在活跃集 ⇒ 树保留");
});

test("P2-1 清扫臂判别性（M4 对应行为）：同对**刚开好树**的行不被后来请求的清扫结算", async () => {
  const f = await setup();
  /* 构造成「同一对确有别的 run 行」（M4 的触发条件）：老行失败收口后，外部把它的占位清掉，
     于是分支空闲、新行能开出**它自己的**树。 */
  assert.equal((await f.openFor("v-old")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "v-old", reason: "seam-fixture" });
  await f.clearPlaceholder();
  assert.deepEqual(await f.trees(), [], "前置：占位已清（分支空闲）");
  assert.equal(
    (await f.openFor("v-live2")).kind,
    "opened",
    "新行开出自己的树（未绑会话 = 刚开好）",
  );
  assert.deepEqual(await f.treeNames(), [f.dirName]);

  /* 该行确实在清扫的**候选集**里（三个前置逐条成立），所以它没被结算是判据的结论，不是没扫到。 */
  const live2 = f.row("v-live2") as SquadRunRecord;
  assert.equal(live2.status, "open");
  assert.equal(live2.sessionId, null);
  assert.equal(live2.branch, f.branch);
  assert.equal(
    f.runtime.squadRunRepo
      .listByWorkspace(WS)
      .some((r) => r.runId !== "v-live2" && r.workItemId === f.itemId && r.agentId === f.agent.id),
    true,
    "同一对确有别的 run 行（v-old，终态行也算 —— 旁证的读法是全量台账）⇒ 这正是「旁证若被点亮就会误伤」的那个条件",
  );

  /* 后来请求（同对）⇒ 先跑清扫臂：候选里那条**刚开好树**的行必须一动不动。 */
  assert.deepEqual(await f.openFor("v-third"), { kind: "deferred", runId: "v-third" });
  assert.deepEqual(f.settleOf("v-live2"), [], "刚开好树的行不得被清扫结算（M4 变异正是打这一格）");
  assert.deepEqual(
    f.settleOf("v-old"),
    [{ runId: "v-old", status: "discarded" }],
    "老行只被自己的失败出口结算",
  );
  assert.equal(f.row("v-live2")?.status, "open");
  assert.equal(f.row("v-live2")?.branch, f.branch, "分支占位不动");
  assert.equal(f.row("v-live2")?.dirName, f.dirName, "目录名不动");
  assert.equal((await f.trees()).length, 1, "它的树还在");
  assert.ok((await f.activeBranches()).includes(f.branch), "它的树仍在活跃集里（硬约束 2）");
  assert.deepEqual((await f.reap()).kept, [f.dirName], "回收器同样保它");

  /* 判别性证据（不依赖变异源码）：把「旁证」这一个入参翻过来，同一条行会被判成无树残行 ——
     即清扫臂若点亮旁证就会走到结算。实际清扫臂用的那一侧（false）保持不动。 */
  const liveSet = new Set(
    (await f.trees()).map((t) => t.branch).filter((b): b is string => b !== null),
  );
  assert.equal(
    isTreelessOpenMemberRun(live2, { liveTreeBranches: liveSet, liveTreeOfOtherRow: false }),
    false,
    "清扫臂实际用的入参（旁证不点亮）⇒ 不是残行",
  );
  assert.equal(
    isTreelessOpenMemberRun(live2, { liveTreeBranches: liveSet, liveTreeOfOtherRow: true }),
    true,
    "旁证一被点亮同一条行就变成「无树残行」⇒ 清扫臂若有 M4 变异，上一段的结算/延迟断言必红",
  );
});

test("P2-1 清扫臂正向对照：真正无树的残行仍被后来请求结算（同一次调用的清扫确实在跑）", async () => {
  const f = await setup();
  /* 老残行：先被同名残枝挡住建树（留下 open + 分支计划），再清掉残枝 ⇒ 真·无树（无树、无 ref）。 */
  assert.equal((await f.git(["branch", f.branch, "main"])).code, 0);
  await assert.rejects(() => f.openFor("v-res"), /已被另一工作树占用|already exists/);
  assert.equal((await f.git(["branch", "-D", f.branch])).code, 0);
  assert.deepEqual(await f.trees(), [], "前置：老行确实无树（只有分支计划）");
  assert.equal(f.row("v-res")?.branch, f.branch);

  /* 后来请求：清扫臂把老残行结算掉（容量/活跃集释放），自己照常开树。 */
  assert.equal((await f.openFor("v-new")).kind, "opened");
  assert.deepEqual(
    f.settleOf("v-res"),
    [{ runId: "v-res", status: "discarded" }],
    "真·无树残行被结算恰一次",
  );
  assert.equal(f.row("v-res")?.status, "discarded");
  assert.equal(f.row("v-new")?.status, "open");
  assert.equal(f.row("v-new")?.branch, f.branch);
  assert.deepEqual(await f.treeNames(), [f.dirName], "恰一棵树（新行的）");
  assert.deepEqual(await f.activeBranches(), [f.branch], "活跃集里只有新行的分支");
  assert.deepEqual(f.settleOf("v-new"), [], "新行不被结算");
});

test("P2-1 残留风险窗口（characterization）：同一行**自己的**活树 + 同对有别的行 ⇒ 重投走等待臂（判据把它当残行）", async () => {
  const f = await setup();
  /* 构造：同对先有一条终态行（旁证成立），随后本行开出自己的树、**会话还没绑**。
     生产里这个状态出现在 host 的「建树 → 建会话/回写」窗口内（index.ts：建树后先 createTask、
     再 bindMemberRunSession、最后才 sendPrompt ⇒ 窗口内树是空的、没有 agent 产物），
     以及「sessionId 回写失败（只 warn）」之后（那种情况树里有真产物）。 */
  assert.equal((await f.openFor("v-old")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "v-old", reason: "seam-fixture" });
  await f.clearPlaceholder();
  assert.deepEqual(await f.trees(), [], "前置：分支空闲（活树只可能是本行自己建的）");
  assert.equal((await f.openFor("v-run")).kind, "opened");
  assert.deepEqual(await f.treeNames(), [f.dirName], "这棵树是本行刚建的（上一步断言的闭环）");
  assert.equal(f.row("v-run")?.sessionId, null, "会话未绑 ⇒ 判据里它「从未建出过树」");

  /* 重投（同 runId、同请求身份）⇒ 当前判据把**自己的**树当成「另有来路」的占位：等待臂。 */
  assert.deepEqual(await f.openFor("v-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(
    f.settleOf("v-run"),
    [{ runId: "v-run", status: "discarded" }],
    "本行被结算（当前行为；风险窗口的可见证据）",
  );
  assert.equal(f.row("v-run")?.branch, null, "自己的分支占位被释放 ⇒ 那棵树从此不在活跃集里");
  assert.deepEqual(await f.treeNames(), [f.dirName], "树此刻仍在磁盘上（还没到回收点）");

  /* 后果：下一次启动回收把它当孤儿收掉（树 + 分支），而行仍在 open、随后会「重开」一棵新树。 */
  const reaped = await f.reap();
  assert.deepEqual(reaped.reclaimed, [f.dirName], "本行自己的树进回收面（当前行为）");
  assert.deepEqual(reaped.reclaimedBranches, [f.branch], "连带分支");
  assert.deepEqual(await f.trees(), []);
  assert.equal((await f.openFor("v-run")).kind, "opened", "随后重投能重建（净效果 = 换一棵新树）");
  assert.deepEqual(f.settleOf("v-run"), [{ runId: "v-run", status: "discarded" }], "重开不结算");
});

test("P2-1 措辞核对：等待行**仍占该 agent 的一个容量槽**（结算事实说 discarded，open 计数口径仍算它）", async () => {
  const f = await setup();
  /* 造出等待行：占位属别行 ⇒ 结算 + 释放占位，行留在 open。 */
  assert.equal((await f.openFor("v-other")).kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "v-other", reason: "seam-fixture" });
  await assert.rejects(() => f.openFor("v-run"));
  assert.deepEqual(await f.openFor("v-run"), { kind: "residual_blocked", branch: f.branch });
  assert.equal(f.row("v-run")?.status, "open", "等待行仍在 open");

  /* 另一对（同 agent、容量 1）派发：容量闸按 `status='open'` 计数（squadRunRepo 的语句口径），
     等待行仍被算进去 ⇒ 新请求落排队。即「容量如实释放」只对**分支活跃集**成立，
     对 **agent 级容量**不成立（结算事实说 discarded、计数口径仍算 open —— 两者当前不冲突，
     因为所有判据都走计数口径；但注释里的措辞需要按事实收紧）。 */
  assert.deepEqual(
    await f.openForItem("v-second", f.item2Id),
    { kind: "queued", runId: "v-second" },
    "等待行占着该 agent 的唯一容量槽 ⇒ 别的 pair 落排队（可接受：请求仍在案、稍后随重开一起跑）",
  );
  assert.equal(f.row("v-run")?.status, "open", "槽位持有者就是这条等待行");
  assert.equal((await f.trees()).length, 1, "除占位外没有新树");
});

test("P2-1 等待态判据闭包（纯函数 + 台账实测）：只认「结算过、占位已释放的队员行」", async () => {
  const f = await setup();
  const shape = (over: Partial<SquadRunRecord>) =>
    ({
      status: "open",
      sessionId: null,
      branch: null,
      isLeaderTask: false,
      ...over,
    }) as SquadRunRecord;

  assert.equal(isAwaitingBranchMemberRun(shape({})), true, "等待态本形");
  assert.equal(isAwaitingBranchMemberRun(shape({ status: "queued" })), false, "排队行不是等待态");
  assert.equal(isAwaitingBranchMemberRun(shape({ status: "produced" })), false, "已产出不是等待态");
  assert.equal(isAwaitingBranchMemberRun(shape({ status: "discarded" })), false, "终态不是等待态");
  assert.equal(
    isAwaitingBranchMemberRun(shape({ isLeaderTask: true })),
    false,
    "队长行（无树是常态）不适用",
  );
  assert.equal(
    isAwaitingBranchMemberRun(shape({ branch: "squad/member/x/y" })),
    false,
    "还有占位的行不是等待态",
  );
  assert.equal(
    isAwaitingBranchMemberRun(shape({ sessionId: "s-1" })),
    false,
    "有会话的行不是等待态",
  );

  /* 等待态行（branch=null）既不「可结算」、也不是「无树残行」——清扫/等待两条判据都碰不到它，
     于是「结算 + 释放占位」不会被第二次走进（重复扇出结算事实的入口在判据层就是关的）。 */
  assert.equal(
    isSettleableResidualMemberRun(shape({}), {
      liveTreeBranches: new Set([f.branch]),
      branchRefExists: false,
      liveTreeOfOtherRow: true,
    }),
    false,
    "等待态行不是「可结算的残行」（结算由释放占位那一次独占；这条行归重开臂）",
  );
  assert.equal(
    isTreelessOpenMemberRun(shape({}), { liveTreeBranches: new Set(), liveTreeOfOtherRow: true }),
    false,
    "等待态行不是「无树残行」（无分支计划）⇒ 清扫面永远不含它",
  );

  /* 台账实测：队长行（branch=null、open）**不会**被队员请求的重开臂认领。 */
  const leader = await f.runtime.lifecycle.recordLeaderRun({
    runId: "v-leader",
    workItemId: f.itemId,
    agentId: f.agent.id,
  });
  assert.equal(leader.recorded, true, "前置：队长行登记成功");
  assert.deepEqual(
    await f.openFor("v-leader"),
    { kind: "already_registered" },
    "队长行（isLeaderTask）不得被队员重开臂当成「等待中的队员行」",
  );
  assert.equal(f.row("v-leader")?.branch, null, "队长行不动");
  assert.equal(f.row("v-leader")?.isLeaderTask, true);
  assert.deepEqual(await f.trees(), [], "不给队长行建树");
  assert.deepEqual(f.settled, [], "这一路零结算事实");
});
