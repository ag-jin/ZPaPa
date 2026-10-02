import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import { slugForId } from "../src/workitem/slug.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* 裁定 1：审查通过 ⇒ **该子工作项**推进到终态，闭合「子项终态 ⇒ `children_done` ⇒ 批次 finalize」的链条。

   为什么这一层必须有独立用例：本裁定补的是**闭环里唯一缺失的写者**，而它落在**服务面**
   （`ISquadRuntimeService.reviewMemberRun`，最小视图的审查按钮走的就是它）。所以用例必须**经服务面**
   走一遍真实链路（真实 git + 真实 sqlite），而不是只断言「某个函数被调用过」：
   ① 「子项读库确实是终态」② 「全部子项终态后父项确实 in_review」③ 「finalize 后父项确实 done
   且主分支确实拿到成果」——三条都是**读库/读 git** 的实体状态断言。

   装配刻意与组合根**同形**（`node.ts` 的 `createSquadRuntimeFor`）：
   · 每个服务调用**现构**一个 runtime（裁定 4：不缓存、不取首个）；
   · 每个新实例上挂一次批次转发（事件出口只有 `subscribeWorkItemEvents` 这一处，回调只 `void` + 留痕
     —— **不得 await**，否则与编排层模块级的同仓库串行队列**自等死锁**，理由见 node.ts 的接线注释）。
   这样才能证明「接线之后闭环真的合上」，而不是测一个恰好能跑的玩具装配。 */

const WS = "ws";

/** 面向单个目录的真 git 调用（与 `squadOrchestrator.batch.test.ts` 的夹具同形）。 */
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
  watch: { parentWorkItemId: string; parentStatusAtFinalize?: string };
  events: WorkItemEvent[];
  chainErrors: unknown[];
  drain: () => Promise<void>;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const target: SquadWorkspaceTarget = { path: repoRoot, identity: WS };
  /** finalize 入口处要读的父项 id，以及那一刻读到的父项状态（② 只能在这一刻读 —— finalize 一返回父项就被推到 done）。 */
  const watch: { parentWorkItemId: string; parentStatusAtFinalize?: string } = {
    parentWorkItemId: "",
  };
  /** 所有工作项事件（② 的证据之一：`to: "in_review"` 那条变迁**确实**发出）。 */
  const events: WorkItemEvent[] = [];
  const chain: Promise<void>[] = [];
  const chainErrors: unknown[] = [];

  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    const runtime = await createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
    });
    // 观测点：批次 finalize 的**入口**。父项此刻应当是 in_review（收尾的前置），随后才会变成 done。
    const realFinalize = runtime.integrationMerger.finalize.bind(runtime.integrationMerger);
    runtime.integrationMerger.finalize = async (input) => {
      if (watch.parentWorkItemId !== "") {
        watch.parentStatusAtFinalize = runtime.workItemRepo.get(watch.parentWorkItemId)?.status;
      }
      return realFinalize(input);
    };
    runtime.subscribeWorkItemEvents((event) => {
      events.push(event);
      if (event.kind !== "workitem.child_completed") return;
      // 与 node.ts 的 `forwardSquadChildCompleted` 同形：只转发，判据在编排层内部（不在这里再判一次）。
      chain.push(
        createSquadOrchestrator({ runtime })
          .advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: event.parentId })
          .catch((error: unknown) => {
            chainErrors.push(error);
          }),
      );
    });
    return runtime;
  };

  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    // 归档转交不是本用例的主题：给一个**响亮抛**的实现，免得用例悄悄依赖它。
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不涉及归档转交");
    },
  });

  const runtime = await createRuntime(target);
  return {
    repoRoot,
    runtime,
    service,
    target,
    watch,
    events,
    chainErrors,
    // 批次收尾是**事件驱动 + 异步**的（回调只 void）：断言前必须把那条链跑完。
    drain: async () => {
      while (chain.length > 0) await chain.shift()!;
    },
  };
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

/** 队员开树 + 在树里提交一个文件 + 上报完成（→ run produced、子项按机械半的 CAS 结果推进）。 */
async function produce(
  f: Fixture,
  input: {
    runId: string;
    childId: string;
    parentId: string;
    agentId: string;
    file: string;
    content: string;
  },
): Promise<{ branch: string; worktreePath: string; integration: string }> {
  const opened = await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: input.childId,
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
  await f.runtime.lifecycle.completeMemberRun({ runId: input.runId });
  return {
    ...opened,
    integration: `squad/integration/${slugForId(input.childId)}`,
  };
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

/** 主分支的**字节**判据（不是「看起来没变」）：比对提交 sha 与文件内容。 */
async function mainSha(f: Fixture): Promise<string> {
  return (await gitAt(f.repoRoot)(["rev-parse", "main"])).stdout.trim();
}

function readMainFile(f: Fixture, file: string): Promise<string> {
  return gitAt(f.repoRoot)(["show", `main:${file}`]).then((r) => r.stdout);
}

function parentStatusEvents(f: Fixture, parentId: string): WorkItemEvent[] {
  return f.events.filter((e) => e.kind === "workitem.status_changed" && e.id === parentId);
}

// ── 顺序硬约束：第 2 步只合**集成分支**，主分支在第 4 步之前一个字节都不动 ──────────

// 两个子项、各一名队员：只审第一个（第二个不终态 ⇒ 不收尾）⇒ 此刻主分支必须**一个字节都没动**，
// 而队员分支已经合进集成分支。这是「先合集成分支、整批通过才合回主分支」这条契约的机器化证据。
test("审查通过只合集成分支：主分支 sha 不变，且子项未全终态时不触发收尾", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c1",
    title: "子一",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  createItem(f, {
    id: "wi-c2",
    title: "子二",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  f.runtime.workItemService.transition("wi-c1", "in_progress", "todo");
  f.runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: "wi-c1",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await produce(f, {
    runId: "r-b",
    childId: "wi-c2",
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  const shaBefore = await mainSha(f);

  const outcome = await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });

  assert.deepEqual(outcome, { ok: true, merged: true }, "审查通过 ⇒ 合进集成分支");
  // ① 审查通过后**读库**：该子项确实是终态（这是 `children_done` 的唯一触发条件）。
  assert.equal(itemStatus(f, "wi-c1"), "done", "审查通过 ⇒ 子项推进到终态（读库，不是读返回值）");
  // 顺序：只合了集成分支，主分支 sha 与内容都没动。
  assert.equal(await mainSha(f), shaBefore, "主分支必须一个字节都没动（成果还在集成分支上）");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "队员的成果不许出现在主分支上");
  assert.equal(await branchExists(f, a.integration), true, "集成分支必须建出来（成果落在它上面）");
  assert.equal(await branchExists(f, a.branch), true, "队员分支在整批通过前不得被抛弃");
  // 还有子项没终态 ⇒ 不收尾：父项不动、没有批次链、也没有错误。
  assert.equal(itemStatus(f, "wi-c2"), "in_review");
  assert.equal(itemStatus(f, parent.id), "todo", "子项没全终态 ⇒ 父项一个字节都不动");
  assert.equal(f.chainErrors.length, 0);
  assert.deepEqual(parentStatusEvents(f, parent.id), []);
});

// ── 闭环：审查通过 ⇒ 子项终态 ⇒ children_done ⇒ 父项 in_review ⇒ finalize ⇒ 父项 done ──

// 一条批的形状按 Task 4 的裁定取「**一名队员的工作项即批的工作项**」：一个子项、两名队员。
// 审第一个（第二个仍是 produced）⇒ 子项终态 ⇒ `child_completed` ⇒ 批次把剩下的产出串行合上、
// finalize 合回主分支、抛弃工作树、删两条分支、父项 done。整条链一次审查就闭合了。
test("审查通过 ⇒ 子项终态 ⇒ 全部终态 ⇒ 父项 in_review ⇒ finalize ⇒ 父项 done 且主分支拿到成果", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition("wi-c", "in_progress", "todo");
  f.watch.parentWorkItemId = parent.id;
  const a = await produce(f, {
    runId: "r-a",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2)); // createdAt 严格递增 ⇒ 串行次序可预期
  const b = await produce(f, {
    runId: "r-b",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  const shaBefore = await mainSha(f);

  await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });

  // ① 子项读库确实是终态。
  assert.equal(
    itemStatus(f, "wi-c"),
    "done",
    "审查通过 ⇒ 子项终态（唯一触发 `children_done` 的写者）",
  );
  await f.drain();
  assert.deepEqual(f.chainErrors, [], "批次收尾链不得抛");
  // ② 全部子项终态 ⇒ 父项确实 in_review：在 finalize 入口**读库**（这一刻之后父项就会变成 done），
  //    同时那条 `to: "in_review"` 的变迁事件也确实经唯一事件出口发出。
  assert.equal(
    f.watch.parentStatusAtFinalize,
    "in_review",
    "finalize 入口处父项必须是 in_review（收尾的前置，读库断言）",
  );
  assert.deepEqual(
    parentStatusEvents(f, parent.id),
    [
      { kind: "workitem.status_changed", id: parent.id, from: "todo", to: "in_review" },
      { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "done" },
    ],
    "父项两条变迁都真实发生：先推进到 in_review，再落到 done",
  );
  // ③ finalize 后父项确实 done，且主分支确实拿到成果（两位队员的都在）。
  assert.equal(itemStatus(f, parent.id), "done", "父项确实 done（读库）");
  assert.notEqual(await mainSha(f), shaBefore, "第 4 步之后主分支才前进");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await readMainFile(f, "b.txt"), "B\n");
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(runStatus(f, "r-b"), "discarded");
  for (const branch of [a.branch, b.branch, a.integration]) {
    assert.equal(await branchExists(f, branch), false, `${branch} 合并后必须删掉`);
  }
  assert.deepEqual(
    (await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );
});

// ── 打回：**不**推进子项终态（工作树与分支存活到修复后重新审核，spec §6.2 / §16 S5）──

test("审查打回 ⇒ 子项停在 in_review（不推进终态）、工作树与分支存活、主分支不动", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition("wi-c", "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.watch.parentWorkItemId = parent.id;
  const shaBefore = await mainSha(f);

  const outcome = await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "rejected" });

  assert.deepEqual(outcome, { ok: true, merged: false, kept: true });
  assert.equal(itemStatus(f, "wi-c"), "in_review", "被打回的子项**不**进终态（否则批会提前收尾）");
  assert.equal(runStatus(f, "r-a"), "rejected");
  assert.equal(await branchExists(f, a.branch), true, "被打回待修的队员分支必须存活");
  assert.equal(await branchExists(f, a.integration), false, "打回不建集成分支");
  assert.equal(await mainSha(f), shaBefore, "主分支一个字节都不动");
  await f.drain();
  assert.deepEqual(parentStatusEvents(f, parent.id), [], "父项不动");
});

// ── 前置必须**读当时状态**（不得写死）：子项停在别处也照样推到终态，而不是静默未命中 ──

// 这一格是真实形状而不是构造：机械半 `completeMemberRun` 的 `in_review ← in_progress` 前置是写死的，
// 而全仓**没有任何路径**把子项推到 `in_progress`（`workItemService.create` 给的是 `todo`）⇒ 由队长建出的
// 子项事实上停在 `todo`。若终态写者也写死前置，这格就**静默未命中**：子项永远不终态 ⇒ 批次永不收尾。
test("子项停在 todo（机械半前置未命中）⇒ 审查通过照样推到 done，不静默未命中", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  // 刻意**不**推 in_progress：子项停在 todo，`completeMemberRun` 的 CAS 因此静默未命中。
  const a = await produce(f, {
    runId: "r-a",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.watch.parentWorkItemId = parent.id;
  assert.equal(itemStatus(f, "wi-c"), "todo", "夹具前提：机械半的前置未命中 ⇒ 子项停在 todo");

  await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });

  assert.equal(itemStatus(f, "wi-c"), "done", "前置取自**当时状态**（todo）⇒ CAS 命中，子项终态");
  await f.drain();
  assert.deepEqual(f.chainErrors, []);
  assert.equal(itemStatus(f, parent.id), "done", "闭环照样合上");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await branchExists(f, a.integration), false, "集成分支合回主分支后被删");
});

// ── 子项已是**另一个**终态：不跨终态改写、也不抛（合并已落地，抛出去会把成功伪装成失败）──

test("子项已被取消（另一终态）⇒ 合并不回退、也不跨终态改写成 done", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c1",
    title: "子一",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  // 第二个子项保持非终态：否则取消第一个就会触发 `children_done`，把批次也一起拉进来。
  createItem(f, {
    id: "wi-c2",
    title: "子二",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  f.runtime.workItemService.transition("wi-c1", "in_progress", "todo");
  f.runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: "wi-c1",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition("wi-c1", "cancelled", "in_review");
  const shaBefore = await mainSha(f);

  const outcome = await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });

  assert.deepEqual(
    outcome,
    { ok: true, merged: true },
    "合并照常落地（取消子项 ≠ 丢弃它已产出的活）",
  );
  assert.equal(itemStatus(f, "wi-c1"), "cancelled", "不跨终态改写成 done");
  assert.equal(runStatus(f, "r-a"), "merged");
  assert.equal(await branchExists(f, a.integration), true);
  assert.equal(await mainSha(f), shaBefore, "主分支一个字节都不动");
  await f.drain();
  assert.deepEqual(f.chainErrors, [], "取消的子项已算终态 ⇒ 不该抛");
});
