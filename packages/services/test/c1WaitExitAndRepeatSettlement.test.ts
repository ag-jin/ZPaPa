/* C1 插队轮独立复验（test-verifier）：**「等待型」的出口** 与 **跨调用重复结算** 两个判据面。

   本文件只回答三个问题（不重复实现者用例的功能面）：
   ① 等待型（`residual_blocked`）的**自愈出口**在哪里 —— 复验登记时这条回路不成立（等待行把分支
      钉在活跃集里 ⇒ 占位永不被收），**P2-1 修复轮已改写这两条用例**：现在等待行会按**行级判据**
      结算并**释放分支占位**（本行从未建出过树时），占位随之可被回收器收净、同一条重投重开新树；
   ② 「一次为限」在**跨调用**尺度上的边界：同一行会不会被两次调用各结算一次、后果是什么；
   ③ 矩阵里还没被走到的两格：分支上挂着**本请求自己**的活树（同对无别的 run 行）⇒ R5 保真；
      以及 A5（名册缺席）路径下 C1 的残行臂照旧。

   两条带「P2-1（复验改写）」标记的用例是复验登记的「自愈不成立」两格的**改写版**（修法①落地后
   断言新行为）；本文件其余用例的断言一个未动。

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

test("P2-1（复验改写）：占位是别人的活树 ⇒ 重投结算本行并释放占位 ⇒ 回收器收净 ⇒ 后续重投重开新树", async () => {
  const f = await setup();
  /* ① 别的 run 开了树后失败收口：行离开活跃集，但树按 spec §6.6 留给启动回收器（占位）。 */
  const other = await f.openFor("c1-other");
  assert.equal(other.kind, "opened");
  await f.runtime.lifecycle.failMemberRun({ runId: "c1-other", reason: "c1-verify-fixture" });
  assert.equal(f.row("c1-other")?.status, "discarded", "占树行已终态（活跃集里只剩下面的残行）");

  /* ② 本请求建树失败 ⇒ 台账留下「有行无树」的残行。 */
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.equal(f.row("c1-run")?.status, "open");

  /* ③ 重投 ⇒ 等待型；P2-1 修法①：本行**从未建出过树**（同一对还有 c1-other 那条行 ⇒ 挂着的活树
     另有来路）⇒ 结算本行（恰一次）+ **释放分支占位**（行仍在 open：runId = 请求身份，不换）。 */
  assert.deepEqual(await f.openFor("c1-run"), { kind: "residual_blocked", branch: f.branch });
  assert.deepEqual(
    f.settled,
    [
      { runId: "c1-other", status: "discarded" },
      { runId: "c1-run", status: "discarded" },
    ],
    "两条行各结算一次：占树行由失败出口、等待行由「释放占位」那一次扇出",
  );
  assert.equal(f.row("c1-run")?.status, "open", "请求身份保留（runId = receipt.dispatchKey）");
  assert.equal(f.row("c1-run")?.branch, null, "分支占位已释放 ⇒ 分支离开活跃集");

  /* ④ 关键（修前这一段的断言全部相反：kept 不动、一个字节不收）：
     等待行不再把占位钉在活跃集里 ⇒ 回收器能收净占位树与分支。 */
  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reap.reclaimed, [f.dirName], "占位树进回收面");
  assert.deepEqual(reap.reclaimedBranches, [f.branch], "分支连带一起收（清理是重派发的前置）");
  assert.deepEqual(reap.kept, [], "没有留在原地的东西");
  assert.equal(await f.branchExists(f.branch), false);
  assert.deepEqual(await f.trees(), []);

  /* ⑤ 后续重投（同一条行、同一个 runId）：分支空出 ⇒ 重新挂计划 + 建树 ⇒ 回路闭合。 */
  const opened = await f.openFor("c1-run");
  assert.equal(opened.kind, "opened", "占位被收净后同一条重投必须能开新树（自愈出口存在）");
  assert.equal(opened.kind === "opened" ? opened.branch : "", f.branch);
  assert.equal(f.row("c1-run")?.status, "open");
  assert.equal((await f.trees()).length, 1, "恰一棵新树");
  assert.deepEqual(
    f.settled,
    [
      { runId: "c1-other", status: "discarded" },
      { runId: "c1-run", status: "discarded" },
    ],
    "重开不再扇出结算事实（结算只发生在释放占位那一次）",
  );
});

test("P2-1（复验改写）：只有同名残枝 ⇒ 重投结算本行并释放占位 ⇒ 回收器第二遍收掉残枝 ⇒ 后续重投重开新树", async () => {
  const f = await setup();
  const made = await f.git(["branch", f.branch, "main"]);
  assert.equal(made.code, 0, `前置：先落一条残枝（stderr=${made.stderr}）`);
  await assert.rejects(() => f.openFor("c1-run"), /已被另一工作树占用|already exists/);
  assert.deepEqual(await f.trees(), [], "前置：残枝没有工作树");

  /* 残枝占着名字 ⇒ 等待型：结算本行（恰一次）+ 释放分支占位（现在建不出树来，不白重开）。 */
  assert.deepEqual(
    await f.openFor("c1-run"),
    { kind: "residual_blocked", branch: f.branch },
    "残枝占着名字 ⇒ 等待型（`worktree add -b` 必然撞名）",
  );
  assert.deepEqual(
    f.settled,
    [{ runId: "c1-run", status: "discarded" }],
    "等待行按行级判据结算恰一次",
  );
  assert.equal(f.row("c1-run")?.status, "open", "请求身份保留（行仍在 open）");
  assert.equal(f.row("c1-run")?.branch, null, "分支占位已释放");

  /* 关键（修前：残枝挂在 open 行上 ⇒ active.has(branch) ⇒ 第二遍永不被收）。 */
  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.deepEqual(reap.reclaimedBranches, [f.branch], "残枝进回收面并删除");
  assert.equal(await f.branchExists(f.branch), false, "分支名已释放");

  /* 后续重投（同一条行、同一个 runId）：残枝清掉 ⇒ 重开新树。 */
  const opened = await f.openFor("c1-run");
  assert.equal(opened.kind, "opened", "残枝清掉后同一条重投必须能开新树（回路闭合）");
  assert.equal(f.row("c1-run")?.branch, f.branch);
  assert.equal((await f.trees()).length, 1, "恰一棵树");
  assert.deepEqual(f.settled, [{ runId: "c1-run", status: "discarded" }], "重开不再扇出结算事实");
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
  assert.equal(
    await f.branchExists(f.branch),
    true,
    "重开把分支 ref 重新建出来（旧的是外部删掉的）",
  );
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
