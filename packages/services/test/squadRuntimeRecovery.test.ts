import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { slugForId } from "../src/workitem/slug.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* Task 7 第 1 轮裁定的**恢复面**用例：Important-2（崩溃窗口的启动重驱）、Important-3（失败 run 的出口）、
   Important-4（会话回写台账使忙检查可达）。

   为什么都在这一层、且都走**服务面**：三条裁定的落地物都长在 `ISquadRuntimeService` 上，而它们的
   正确性只能由**实体状态**证明（读库 / 读 git），不是读源码相信。装配刻意与组合根（`node.ts` 的
   `createSquadRuntimeFor`）同形：每个服务调用**现构** runtime（裁定 4），db 是同一条（同一份台账）。

   ⚠️ 本文件**不挂** `child_completed` 的批次转发器：那正是要模拟的**崩溃窗口** ——
   「末个子项已 `done` 提交」之后、`finalize` 落地之前进程死掉，重启后没有任何事件会被重放。
   所以恢复只能靠 Important-2 的启动重驱（幂等），而不是靠重放事件。 */

const WS = "ws";

function gitAt(
  cwd: string,
): (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  const git = realGit(cwd);
  return (args) => git(args, {});
}

async function setup(): Promise<{
  repoRoot: string;
  runtime: SquadRuntime;
  service: ISquadRuntimeService;
  target: SquadWorkspaceTarget;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const target: SquadWorkspaceTarget = { path: repoRoot, identity: WS };
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
    });
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不涉及归档转交");
    },
    createOrchestrator: createSquadOrchestrator,
    logWarn: () => {},
  });
  const runtime = await createRuntime(target);
  return { repoRoot, runtime, service, target };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

function createItem(
  f: Fixture,
  input: {
    id: string;
    title: string;
    parentId?: string;
    assignee: { type: "squad" | "agent"; id: string };
  },
) {
  return f.runtime.workItemService.create({
    id: input.id,
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: input.title,
    parentId: input.parentId,
    assignee: input.assignee,
  });
}

function itemStatus(f: Fixture, id: string): string {
  const item = f.runtime.workItemRepo.get(id);
  assert.ok(item, `工作项 ${id} 应当存在`);
  return item.status;
}

function runStatus(f: Fixture, runId: string): string {
  const record = f.runtime.squadRunRepo.get(runId);
  assert.ok(record, `run ${runId} 应当存在`);
  return record.status;
}

async function branchExists(f: Fixture, branch: string): Promise<boolean> {
  return (
    (
      await f.runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
        cwd: f.repoRoot,
      })
    ).code === 0
  );
}

/** 开一棵队员工作树 + 在树里提交一个文件（真 git），返回分支与工作树路径。 */
async function openAndCommit(
  f: Fixture,
  input: {
    runId: string;
    workItemId: string;
    parentId: string;
    agentId: string;
    file: string;
    content: string;
  },
): Promise<{ branch: string; worktreePath: string }> {
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: input.workItemId,
    parentWorkItemId: input.parentId,
    agentId: input.agentId,
    isLeaderTask: false,
  });
  writeFileSync(join(opened.worktreePath, input.file), input.content);
  const git = gitAt(opened.worktreePath);
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", `${input.agentId} work`],
  ]) {
    const result = await git(args);
    assert.equal(result.code, 0, `${args.join(" ")} 失败: ${result.stderr}`);
  }
  return opened;
}

// ============================ Important-3：失败 run 的出口 ============================

/* 裁定的核心断言：标记失败后该 run **不在 `listActive`**（读库），因而它的工作树/分支**可被回收**
   （与回收器的既有口径串起来：`activeBranches` 由 `listActive` 派生 ⇒ 不在活跃集 = 可回收）。
   失败出口若被删掉，本用例的 ① 必红；若「标记失败」不写台账，则 ① 与 ② 一起红。 */
test("Important-3：失败 run 离开活跃集，其工作树与分支随后可被启动回收器回收", async () => {
  const f = await setup();
  const root = createItem(f, {
    id: "wi-root",
    title: "批",
    assignee: { type: "squad", id: "sq-1" },
  });
  const opened = await openAndCommit(f, {
    runId: "run-fail",
    workItemId: root.id,
    parentId: root.id,
    agentId: "ta-a",
    file: "x.txt",
    content: "X\n",
  });

  assert.equal(runStatus(f, "run-fail"), "open");
  assert.ok(
    f.runtime.squadRunRepo.listActive(WS).some((record) => record.runId === "run-fail"),
    "前置：open 的 run 落在活跃集里（这正是「永不收缩」的那一格）",
  );

  await f.service.failMemberRun(f.target, {
    runId: "run-fail",
    reason: "派发中途失败：sendPrompt 抛",
  });

  // ① 读库实体状态：状态已到 `discarded`，且**不在**活跃集。
  assert.equal(runStatus(f, "run-fail"), "discarded");
  assert.deepEqual(
    f.runtime.squadRunRepo.listActive(WS),
    [],
    "失败 run 必须离开活跃集（否则它的树/分支永不被回收）",
  );

  // ② 其分支确实**随后可被回收**：走启动回收器的既有口径（activeBranches = listActive 的投影）。
  const reap = await f.runtime.lifecycle.reapStartupOrphans({ workspaceKey: WS });
  assert.ok(
    reap.reclaimedBranches.includes(opened.branch),
    `失败 run 的队员分支应被启动回收，实际 reclaimedBranches=${JSON.stringify(reap.reclaimedBranches)}`,
  );
  assert.equal(await branchExists(f, opened.branch), false, "分支必须已被删掉");
  assert.deepEqual(await f.runtime.worktreeManager.list(), [], "工作树也必须已被摘掉");
});

// 出口的纪律（与 reviewMemberRun 同款）：未命中响亮抛；只有 `open` 可被判失败；空原因不许。
test("Important-3：failMemberRun 的响亮分支（行不存在 / 非 open / 空原因 / 幂等）", async () => {
  const f = await setup();
  const root = createItem(f, { id: "wi-r2", title: "批", assignee: { type: "squad", id: "sq-1" } });

  // 行不存在 ⇒ 响亮（与其它生命周期方法同口径，不静默 no-op）。
  await assert.rejects(
    () => f.service.failMemberRun(f.target, { runId: "ghost", reason: "boom" }),
    /ghost/,
  );
  // 空原因 ⇒ 响亮：一条「失败了但不知道为什么」的台账行事后无法处置。
  await assert.rejects(
    () => f.service.failMemberRun(f.target, { runId: "ghost", reason: "   " }),
    /reason/,
  );

  // 已产出（produced）的 run **不得**被当失败丢弃 —— 那会丢掉队员的活。
  await f.runtime.lifecycle.openMemberRun({
    runId: "run-prod",
    workItemId: root.id,
    parentWorkItemId: root.id,
    agentId: "ta-b",
    isLeaderTask: false,
  });
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-prod" });
  assert.equal(runStatus(f, "run-prod"), "produced");
  await assert.rejects(
    () => f.service.failMemberRun(f.target, { runId: "run-prod", reason: "不该发生" }),
    /produced/,
  );

  // 幂等：已 discarded 的重复调用不报错，也不改变状态（重投 / 双路径都会重复调它）。
  await f.runtime.lifecycle.openMemberRun({
    runId: "run-idem",
    workItemId: root.id,
    parentWorkItemId: root.id,
    agentId: "ta-c",
    isLeaderTask: false,
  });
  await f.service.failMemberRun(f.target, { runId: "run-idem", reason: "第一次失败" });
  await f.service.failMemberRun(f.target, { runId: "run-idem", reason: "第二次（幂等）" });
  assert.equal(runStatus(f, "run-idem"), "discarded");
});

// ============================ Important-4：会话回写台账 ============================

/* 裁定点：`openMemberRun` 落台账时写 `sessionId: null`，全仓无任何回写 ⇒ 忙检查的强探测与 `deferred`
   分支**永不可达**（代码对、保护为零）。本用例证明回写之后台账**真的带上 sessionId**，
   且 `getSnapshot().runs`（host 取 `boundSessionId` 的那一处）能读到它 ⇒ 强探测分支可达。
   把回写步骤删掉 ⇒ 本用例必红。 */
test("Important-4：会话建立后回写台账（读库；getSnapshot 暴露给 host 的 boundSessionId）", async () => {
  const f = await setup();
  const root = createItem(f, { id: "wi-s", title: "批", assignee: { type: "squad", id: "sq-1" } });
  await f.runtime.lifecycle.openMemberRun({
    runId: "run-s",
    workItemId: root.id,
    parentWorkItemId: root.id,
    agentId: "ta-a",
    isLeaderTask: false,
  });
  assert.equal(
    f.runtime.squadRunRepo.get("run-s")?.sessionId,
    null,
    "前置：开树时还不知道 sessionId（这正是「忙检查恒 null」的成因）",
  );

  await f.service.bindMemberRunSession(f.target, { runId: "run-s", sessionId: "sess-1" });

  // ① 读库：台账真的带上 sessionId。
  assert.equal(f.runtime.squadRunRepo.get("run-s")?.sessionId, "sess-1");
  // ② host 取 `boundSessionId` 的那一处（`getSnapshot().runs`，正是 listActive 的口径）能读到它
  //    ⇒ `if (boundSessionId)` 这一支在生产里**可达**（强探测不再空跑）。
  const snapshot = await f.service.getSnapshot(f.target);
  assert.equal(
    snapshot.runs.find((record) => record.runId === "run-s")?.sessionId,
    "sess-1",
    "host 的 boundSessionId 来自这里；null ⇒ 强探测与 deferred 永不可达",
  );
});

// 回写**不得**回退状态：`produced` 的 run 回写会话后仍是 `produced`（单列更新，不碰 status）。
test("Important-4：回写只动 session_id，不回退 status（produced 仍是 produced）", async () => {
  const f = await setup();
  const root = createItem(f, { id: "wi-s2", title: "批", assignee: { type: "squad", id: "sq-1" } });
  await f.runtime.lifecycle.openMemberRun({
    runId: "run-s2",
    workItemId: root.id,
    parentWorkItemId: root.id,
    agentId: "ta-a",
    isLeaderTask: false,
  });
  await f.runtime.lifecycle.completeMemberRun({ runId: "run-s2" });
  assert.equal(runStatus(f, "run-s2"), "produced");

  await f.service.bindMemberRunSession(f.target, { runId: "run-s2", sessionId: "sess-2" });

  assert.equal(runStatus(f, "run-s2"), "produced", "回写会话不得把状态改回 open");
  assert.equal(f.runtime.squadRunRepo.get("run-s2")?.sessionId, "sess-2");
});

// ============================ Important-2：崩溃窗口的启动重驱 ============================

/* 构造**崩溃窗口**那一格：末个子项已 `done`、成员都已合进集成分支，但**没有** finalize
   （本文件不挂批次转发器 ⇒ 没有任何东西会重放 `child_completed`）。然后走启动重驱。
   断言全是实体状态：父项 `done`、**主分支确实拿到两份成果**、两条分支与集成分支全删。
   去掉启动重驱 ⇒ 本用例必红（父项停在 todo/in_review、主分支拿不到成果）。 */
test("Important-2：崩溃窗口态启动重驱 ⇒ 父项 done 且集成分支合回主分支；重复重驱无副作用", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "父项",
    assignee: { type: "squad", id: "sq-1" },
  });
  const child = createItem(f, {
    id: "wi-c",
    title: "子项",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });

  // 两名队员在**同一条**子工作项上产出（一批 = 一个工作项 = 一条集成分支），各自经审查合进集成分支；
  // 每次审查通过都会经裁定 1 的写者把子项推到终态，但**没有人**触发整批 finalize（模拟崩溃）。
  const first = await openAndCommit(f, {
    runId: "run-c1",
    workItemId: child.id,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const merged1 = await f.service.reviewMemberRun(f.target, {
    runId: "run-c1",
    verdict: "approved",
  });
  assert.equal(merged1.ok, true, JSON.stringify(merged1));
  const second = await openAndCommit(f, {
    runId: "run-c2",
    workItemId: child.id,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  const merged2 = await f.service.reviewMemberRun(f.target, {
    runId: "run-c2",
    verdict: "approved",
  });
  assert.equal(merged2.ok, true, JSON.stringify(merged2));

  const integration = `squad/integration/${slugForId(child.id)}`;
  // 前置事实：子项全终态、父项**未**终态、集成分支在、成员都在 `merged`（不在活跃集）。
  assert.equal(itemStatus(f, child.id), "done", "前置：末个子项已终态");
  assert.notEqual(itemStatus(f, parent.id), "done", "前置：父项尚未收尾（崩溃窗口）");
  assert.equal(await branchExists(f, integration), true, "前置：集成分支还在（没合回主分支）");
  assert.deepEqual(
    f.runtime.squadRunRepo.listActive(WS),
    [],
    "前置：两条成员 run 都 merged（不在活跃集）—— 这正是「集成分支不归回收器管」的危险形状",
  );

  const outcome = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(outcome.replayed, [parent.id], JSON.stringify(outcome));
  assert.deepEqual(outcome.failures, []);

  // 实体状态：父项确实 done。
  assert.equal(itemStatus(f, parent.id), "done");
  // 实体状态：主分支**确实**拿到两份成果（读文件，不是读返回值）。
  assert.equal(readFileSync(join(f.repoRoot, "a.txt"), "utf8"), "A\n");
  assert.equal(readFileSync(join(f.repoRoot, "b.txt"), "utf8"), "B\n");
  // 收尾的收口：集成分支与队员分支全删、工作树摘净。
  assert.equal(await branchExists(f, integration), false);
  assert.equal(await branchExists(f, first.branch), false);
  assert.equal(await branchExists(f, second.branch), false);
  assert.deepEqual(await f.runtime.worktreeManager.list(), []);

  // **幂等**：再重驱一次不出问题，也不再动任何东西（父项已终态 ⇒ 跳过；主分支 sha 不变）。
  const headBefore = (
    await f.runtime.git(["rev-parse", "HEAD"], { cwd: f.repoRoot })
  ).stdout.trim();
  const again = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(again.replayed, [], "已收尾的批不得被重复重驱");
  assert.deepEqual(again.failures, []);
  assert.equal(
    (await f.runtime.git(["rev-parse", "HEAD"], { cwd: f.repoRoot })).stdout.trim(),
    headBefore,
    "重复重驱不得再动主分支",
  );
});

// 重驱只吃「有批的父项」：一个**普通**父项（没有 squad run 行）不该被收尾推到 done。
test("Important-2：重驱不碰没有批次 run 行的普通父项", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-only",
    title: "普通父项",
    assignee: { type: "user", id: "u1" },
  });
  createItem(f, {
    id: "wi-only-child",
    title: "子项",
    parentId: parent.id,
    assignee: { type: "user", id: "u1" },
  });
  // 子项推到终态 ⇒ 一个「子项全终态、但根本不是批」的父项。
  assert.equal(f.runtime.workItemService.transition("wi-only-child", "done", "todo"), true);

  const outcome = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(outcome.replayed, [], "没有批的父项不得被重驱收尾");
  assert.equal(itemStatus(f, parent.id), "todo", "普通父项的状态一个字节都不该动");
});
