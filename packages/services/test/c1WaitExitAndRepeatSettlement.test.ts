/* C1 插队轮独立复验（test-verifier）：**「等待型」的出口** 与 **跨调用重复结算** 两个判据面。

   本文件只回答三个问题（不重复实现者用例的功能面）：
   ① 等待型（`residual_blocked`）真的是「可自愈」的吗 —— 实现者与用例注释都写
      「等回收器按『不在活跃集』回收它 / 清掉残枝后重投自愈」，这里把**回收器放进这条序列**实测；
   ② 「一次为限」在**跨调用**尺度上的边界：同一行会不会被两次调用各结算一次、后果是什么；
   ③ 矩阵里还没被走到的两格：分支上挂着**本请求自己**的活树（同对无别的 run 行）⇒ R5 保真；
      以及 A5（名册缺席）路径下 C1 的残行臂照旧。

   期望值全部取契约面可观察事实：`OpenMemberRunResult` 判别值、`squad_runs` 行、结算 hub 事件、
   `WorktreeManager.list`、分支 ref（真 git 命令）、`reapStartupOrphans` 的 reclaimed/kept/
   reclaimedBranches。不读实现中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { planBranches, memberDirName } from "../src/worktree/branchNaming.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import { slugForId } from "../src/workitem/slug.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "c1-verify-ws";

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
  /* 有名册定义 ⇒ 走「容量 / 活跃 / 义务」的完整裁决（A5 用例另用不在名册里的 agentId）。 */
  const agent = runtime.teamAgentService.create({
    name: "c1-verify-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "c1-verify-wi";
  runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "C1 复验",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agent.id },
    labels: [],
    properties: {},
    position: 0,
  });
  const planFor = (agentId: string) =>
    planBranches({ workItemSlug: slugForId(itemId), agentSlug: slugForId(agentId) });
  const branch = planFor(agent.id).member;
  const dirName = memberDirName(planFor(agent.id));
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  const row = (runId: string) => runtime.squadRunRepo.get(runId);
  const openId = (runId: string, agentId: string) =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId: itemId,
      parentWorkItemId: itemId,
      agentId,
      isLeaderTask: false,
    });
  const openFor = (runId: string) => openId(runId, agent.id);
  const trees = () => runtime.worktreeManager.list();
  const branchExists = async (name: string): Promise<boolean> =>
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${name}`])).code === 0;
  const ledger = (): Array<[string, string]> =>
    runtime.squadRunRepo.listByWorkspace(WS).map((r) => [r.runId, r.status]);
  return {
    runtime,
    itemId,
    agent,
    branch,
    dirName,
    planFor,
    git,
    row,
    openId,
    openFor,
    trees,
    branchExists,
    ledger,
    settled,
  };
}

test("C1 矩阵（未被走到的格）：分支上挂着**本请求自己**的活树、同对无别的 run 行 ⇒ R5 already_registered，零结算", async () => {
  const f = await setup();
  const opened = await f.openFor("c1-own");
  assert.equal(opened.kind, "opened", "前置：本请求正常开树");

  /* 同 runId 重投：行是 open + 未绑会话，但分支上挂着**它自己的**树 ⇒ 不是残行。 */
  assert.deepEqual(
    await f.openFor("c1-own"),
    { kind: "already_registered" },
    "自己的活树不是「从未建过树」：必须交回 R5 幂等臂（走既有忙探测/绑定会话），不得当成残行",
  );
  assert.deepEqual(f.settled, [], "R5 格不得结算：结算会误导出「这条 run 已经收口了」的结算事实");
  assert.equal(f.row("c1-own")?.status, "open");
  assert.equal((await f.trees()).length, 1, "不得再建一棵树");
  assert.deepEqual(f.ledger(), [["c1-own", "open"]]);
});

test("C1 等待型自愈主张**不成立**（复验登记）：占位是别人的活树时，回收器收不掉它 —— 等待行把分支钉在活跃集里", async () => {
  const f = await setup();
  /* ① 别的 run 开了树后失败收口：行离开活跃集，但树按 spec §6.6 留给启动回收器。 */
  const other = await f.openFor("c1-other");
  assert.equal(other.kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-other", reason: "c1-verify-fixture" });
  assert.equal(f.row("c1-other")?.status, "discarded", "占树行已终态（活跃集里只剩下面的残行）");

  /* ② 本请求建树失败 ⇒ 台账留下「有行无树」的残行。 */
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.equal(f.row("c1-run")?.status, "open");

  /* ③ 重投 ⇒ 等待型（活树占着，且同对还有别的 run 行 ⇒ 不是本行的树）。 */
  assert.deepEqual(await f.openFor("c1-run"), { kind: "residual_blocked", branch: f.branch });

  /* ④ 关键：等待型声称「等回收器清掉占位后重投自愈」——把回收器放进这条序列实测。
     等待行（status=open、branch=f.branch）本身把该分支钉在 `computeActiveBranches` 里
     （SQUAD_RUN_ACTIVE_STATUSES 含 open），而回收器的保留判据恰是「分支在活跃集里」
     ⇒ 占位树与分支一个字节都不会被动。 */
  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reap.kept, [f.dirName], "占位树进 kept（活跃分支）：回收器按设计不碰它");
  assert.deepEqual(reap.reclaimed, [], "回收面为空：没有「不在活跃集」的树");
  assert.equal(await f.branchExists(f.branch), true, "分支也收不掉（第二遍按 active.has(branch) 跳过）");
  assert.ok(
    !reap.reclaimedBranches.includes(f.branch),
    `分支不在回收面（reclaimedBranches=${JSON.stringify(reap.reclaimedBranches)}）`,
  );
  assert.equal((await f.trees()).length, 1, "占位树仍在");
  assert.deepEqual(
    await f.openFor("c1-run"),
    { kind: "residual_blocked", branch: f.branch },
    "回收之后重投仍是等待型：这条回路**不会**自己走通（没有自愈出口）",
  );

  /* ⑤ 唯一能解开钉住的动作是「把那行移出活跃集」——但生产里没有任何角色会对这条等待行做这件事
     （它没有会话 ⇒ 永远等不到终态出口；A2 只兜排队行）。这里只用来证明「钉住」的因果：
     行一离开活跃集，回收器下一轮就把占位收干净。 */
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-run", reason: "c1-verify-only-exit" });
  const reapAfter = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reapAfter.reclaimed, [f.dirName], "行离开活跃集 ⇒ 占位树才进回收面");
  assert.deepEqual(reapAfter.reclaimedBranches, [f.branch], "连带分支一起收（清理是重派发的前置）");
  assert.equal(await f.branchExists(f.branch), false);
});

test("C1 等待型自愈主张**不成立**（复验登记）：只有同名残枝时，回收器第二遍同样按活跃集跳过它", async () => {
  const f = await setup();
  const made = await f.git(["branch", f.branch, "main"]);
  assert.equal(made.code, 0, `前置：先落一条残枝（stderr=${made.stderr}）`);
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.deepEqual(await f.trees(), [], "前置：残枝没有工作树");

  assert.deepEqual(
    await f.openFor("c1-run"),
    { kind: "residual_blocked", branch: f.branch },
    "残枝占着名字 ⇒ 等待型（`worktree add -b` 必然撞名）",
  );
  assert.equal(f.row("c1-run")?.status, "open", "等待行留在活跃集");

  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.equal(await f.branchExists(f.branch), true, "残枝不被回收：该分支挂在一条 open 行上 ⇒ active.has(branch) ⇒ skip");
  assert.ok(!reap.reclaimedBranches.includes(f.branch));
  assert.deepEqual(
    await f.openFor("c1-run"),
    { kind: "residual_blocked", branch: f.branch },
    "下一轮启动重投仍是等待型（自愈回路未闭合）",
  );

  /* 反向半边（把这一格的可解条件钉住）：只有把等待行移出活跃集，残枝才会被清掉。 */
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-run", reason: "c1-verify-only-exit" });
  const reapAfter = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reapAfter.reclaimedBranches, [f.branch], "行离开活跃集 ⇒ 残枝才回收");
  assert.equal(await f.branchExists(f.branch), false);
});

test("C1 跨调用结算（a）：残行被别的请求清扫一次后，不再被第二次结算；同一请求重投只命中 R5", async () => {
  const f = await setup();
  /* ① 别的 run 留下残行：先占名 ⇒ 建树失败 ⇒ 行停在 open 而无树。 */
  await f.git(["branch", f.branch, "main"]);
  await assert.rejects(() => f.openFor("c1-old"));
  assert.equal(f.row("c1-old")?.status, "open");
  assert.equal((await f.git(["branch", "-D", f.branch])).code, 0, "前置：残枝清掉（分支空闲）");

  /* ② 别的请求经同一入口：清扫旧残行**恰一次**，自己照常开树。 */
  assert.equal((await f.openFor("c1-new")).kind, "opened");
  assert.deepEqual(f.settled, [{ runId: "c1-old", status: "discarded" }], "旧残行结算恰一次");

  /* ③ 再来一个请求：旧行已是 discarded（既不在清扫候选里），新行的分支挂着它自己的树
        ⇒ 两格都不得结算；它自己因「已有活跃 run」落 R2 义务（不新增行）。 */
  assert.deepEqual(await f.openFor("c1-third"), { kind: "deferred", runId: "c1-third" });
  assert.deepEqual(f.settled, [{ runId: "c1-old", status: "discarded" }], "跨调用没有第二次结算");
  assert.deepEqual(
    f.ledger(),
    [
      ["c1-old", "discarded"],
      ["c1-new", "open"],
    ],
    "台账不新增第二条 open 行（R2 义务表承载第三条请求）",
  );
  assert.equal((await f.trees()).length, 1, "只有 c1-new 的一棵树");

  /* ④ 被清扫过的请求自己重投：行已终态 ⇒ R5 幂等臂（不复活、也不二次结算）。 */
  assert.deepEqual(await f.openFor("c1-old"), { kind: "already_registered" });
  assert.deepEqual(f.settled, [{ runId: "c1-old", status: "discarded" }]);
  assert.equal(f.row("c1-old")?.status, "discarded");
});

test("C1 跨调用结算（b）：同一 runId 只有**重新回到残行态**才会被再结算一次（每次调用仍是一轮）", async () => {
  const f = await setup();
  /* ① 残行（分支空闲）⇒ 第一轮：结算 + 同一 runId 重开新树。 */
  await f.git(["branch", f.branch, "main"]);
  await assert.rejects(() => f.openFor("c1-run"));
  await f.git(["branch", "-D", f.branch]);
  assert.equal((await f.openFor("c1-run")).kind, "opened");
  assert.equal(f.row("c1-run")?.status, "open");

  /* ② 外部把树与分支都清掉（人工清理 / 别的回收路径）⇒ 这一行**再次**成为「有行无树」。 */
  await f.runtime.worktreeManager.remove(f.dirName);
  assert.equal((await f.git(["branch", "-D", f.branch])).code, 0);
  assert.deepEqual(await f.trees(), [], "前置：树与分支都不在了（行还是 open）");

  /* ③ 同一 runId 重投 ⇒ 第二轮结算 + 重开。这是「跨调用重复结算」唯一可达的形状：
       行在两次之间回到残行态（占用消失）。每次调用仍只结算一轮。 */
  assert.equal((await f.openFor("c1-run")).kind, "opened");
  assert.deepEqual(
    f.settled,
    [
      { runId: "c1-run", status: "discarded" },
      { runId: "c1-run", status: "discarded" },
    ],
    "两次结算各发生在一次调用里（占用清 ⇒ 恰一次；不是同一次调用内的二次重试）",
  );
  assert.deepEqual(f.ledger(), [["c1-run", "open"]], "runId 不换、不新增行（请求身份 = 台账身份）");
  assert.equal((await f.trees()).length, 1, "净效果仍是一条 run / 一棵树");
  /* 目录名是 pair 的确定性函数 ⇒ 重开落在同一个路径上；能证明「重开过」的是分支 ref 被重新建出来。 */
  assert.equal(await f.branchExists(f.branch), true, "重开把分支 ref 重新建出来（旧的是外部删掉的）");
});

test("C1 A5（名册缺席）：残行重开照旧直开 —— 不排队、不落义务、不因 C1 新增闸门", async () => {
  const f = await setup();
  const ghost = "c1-verify-ghost"; // 不在名册里：resolveAgentMaxConcurrentRuns ⇒ undefined（A5）
  const ghostBranch = f.planFor(ghost).member;
  await f.git(["branch", ghostBranch, "main"]);
  await assert.rejects(() => f.openId("c1-ghost-run", ghost), /已被另一工作树占用|already exists/);
  assert.equal(f.row("c1-ghost-run")?.status, "open");
  assert.equal((await f.git(["branch", "-D", ghostBranch])).code, 0);

  assert.equal(
    (await f.openId("c1-ghost-run", ghost)).kind,
    "opened",
    "名册缺席 ⇒ 不闸照旧直开；C1 的残行臂照旧生效（同名 runId 重开）",
  );
  assert.deepEqual(f.settled, [{ runId: "c1-ghost-run", status: "discarded" }]);
  assert.deepEqual(f.ledger(), [["c1-ghost-run", "open"]]);
  assert.equal(f.runtime.squadDeferredDispatchRepo.list(WS).length, 0, "A5 不落义务");
  assert.equal((await f.trees()).length, 1);
});

test("C1 同 runId 重开后的行对 host 的三处出口仍可见：bind 会话 / 成功收口 / 失败出口全按 runId 定位", async () => {
  const f = await setup();
  /* 残行（分支空闲）⇒ 结算 + 同一 runId 重开（host 手里拿到的仍是 receipt.dispatchKey）。 */
  await f.git(["branch", f.branch, "main"]);
  await assert.rejects(() => f.openFor("c1-run"));
  await f.git(["branch", "-D", f.branch]);
  assert.equal((await f.openFor("c1-run")).kind, "opened");

  /* bindMemberRunSession：host 在 createTask 之后按 eventKey 回写会话 —— 换 runId 的写法会在这里抛。 */
  await f.runtime.lifecycle.bindMemberRunSession({ runId: "c1-run", sessionId: "sess-1" });
  assert.equal(f.row("c1-run")?.sessionId, "sess-1");

  /* failMemberRun：失败出口（终态非 succeeded 那一支）——同一条行、同一个 runId。 */
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-run", reason: "c1-verify" });
  assert.equal(f.row("c1-run")?.status, "discarded");

  /* completeMemberRun：成功收口（产出入账）——同样是按 runId 定位的那一族出口。
     前一行的树/分支按 spec §6.6 归回收器，这里手工走一遍回收动作，好让同一对能再开一条。 */
  await f.runtime.worktreeManager.remove(f.dirName);
  assert.equal((await f.git(["branch", "-D", f.branch])).code, 0);
  assert.equal((await f.openFor("c1-second")).kind, "opened");
  await f.runtime.lifecycle.completeMemberRun({ runId: "c1-second" });
  assert.equal(f.row("c1-second")?.status, "produced");
  /* 工作项推进是 CAS（in_progress→in_review）：本夹具的项停在 todo ⇒ 未命中也不抛（§5.7 第 5 项）。 */
  assert.equal(f.runtime.workItemRepo.get(f.itemId)?.status, "todo");
});
