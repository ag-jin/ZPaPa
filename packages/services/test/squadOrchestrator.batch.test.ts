import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* 批次编排（spec §5.7.3 / §5.7.4 / §6.2 / §6.3 / §16 S4 S5 S17）。

   为什么这一层必须单独存在（而不是塞进 Wave 0 的机械半）：这些语义要**同时**读工作项状态与 run 台账
   ——「子项全部 category ∈ {done, closed} 才触发」「串行合并 / 整批通过才合回主分支 / 冲突解不了 →
   blocked + Inbox」「审查未通过前工作树存活」「合并后分支删（队员与集成都删）」。属**策略**。

   全部用例用**真实临时 git 仓库**：本层要断言的是「主分支有没有动、分支还在不在、第二次合并看不看得见
   第一次的成果」——这些只有真 git 能回答（打桩只会自证）。 */

const WS = "ws";

/**
 * 面向单个目录的真 git 调用：夹具的 `realGit(root)` 要求显式给 opts（它的 cwd 缺省只吃 opts 上的值），
 * 所以这里收成一个只吃 args 的薄包装 —— 测试里要断言的正是「git 真的把什么写进了哪个仓库」。
 */
function gitAt(
  cwd: string,
): (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  const git = realGit(cwd);
  return (args) => git(args, {});
}

async function setup(options: { baseBranch?: string } = {}): Promise<{
  repoRoot: string;
  db: DatabaseSync;
  runtime: SquadRuntime;
  orchestrator: ReturnType<typeof createSquadOrchestrator>;
}> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    baseBranch: options.baseBranch,
    readExperimentEnabled: () => true,
  });
  return {
    repoRoot,
    db,
    runtime,
    orchestrator: createSquadOrchestrator({ runtime }),
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 建工作项：父项派给小队、子项派给队员（形状与生产一致，但本层只关心父子关系与状态）。 */
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

/** 队员开树 + 在树里提交一个文件 + 上报完成（→ run produced、子项 in_review）。 */
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
): Promise<{ branch: string; worktreePath: string }> {
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
  return opened;
}

function runStatus(f: Fixture, runId: string): string {
  const record = f.runtime.squadRunRepo.get(runId);
  assert.ok(record, `run ${runId} 应当存在`);
  return record.status;
}

function itemStatus(f: Fixture, id: string): string {
  const item = f.runtime.workItemRepo.get(id);
  assert.ok(item, `工作项 ${id} 应当存在`);
  return item.status;
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

function readMainFile(f: Fixture, file: string): Promise<string> {
  return gitAt(f.repoRoot)(["show", `main:${file}`]).then((r) => r.stdout);
}

/** 一条「父项 + 一个子项」的批，子项由一名队员产出；返回该父项与其阵容。 */
async function batchWithOneChild(
  f: Fixture,
  opts: { childId?: string; parentStatus?: "in_review" | "in_progress" } = {},
) {
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  const childId = opts.childId ?? "wi-c";
  createItem(f, {
    id: childId,
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition(childId, "in_progress", "todo");
  if (opts.parentStatus === "in_progress") {
    f.runtime.workItemService.transition(parent.id, "in_progress", "todo");
  } else {
    f.runtime.workItemService.transition(parent.id, "in_review", "todo");
  }
  return { parent, childId };
}

// ── §5.7.3：触发判据 ─────────────────────────────────────────────────────────

// 子项没全终态就动手 = 半批合并：一个还没产出的队员会被无声地跳过，而主分支已经落了一半的活。
// 这条同时钉住「不 finalize」与「一个字节都不动」。
test("子项未全部终态 ⇒ 不做任何事（不半批合并）", async () => {
  const f = await setup();
  const { parent } = await batchWithOneChild(f);
  createItem(f, {
    id: "wi-c2",
    title: "还没做完的子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  // 子项：wi-c 已终态（done），wi-c2 停在 in_review ⇒ 未全部终态。
  await produce(f, {
    runId: "r-a",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition("wi-c", "done", "in_review");
  f.runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  f.runtime.workItemService.transition("wi-c2", "in_review", "in_progress");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(runStatus(f, "r-a"), "produced", "不得被合并（批没齐）");
  assert.equal(await branchExists(f, f.runtime.squadRunRepo.get("r-a")!.branch!), true);
  assert.equal(
    await branchExists(f, `squad/integration/${slugOf(f, "wi-c")}`),
    false,
    "不许提前建集成分支",
  );
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支一个字节都不许动");
  assert.equal(itemStatus(f, parent.id), "in_review", "父项不动");
});

// §5.7.3 的判据是 **category**，不是键名：`cancelled` 是 closed 类，与 done 一样算终态。
// 用键名比较（`=== "done"`）的实现会漏掉这一格 ⇒ 批永远收不了尾且不报错。
test("cancelled 子项也算终态（用 category 判定，不是键名比较）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  createItem(f, {
    id: "wi-c2",
    title: "被取消的子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");
  f.runtime.workItemService.transition("wi-c2", "cancelled", "todo");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n", "整批通过 ⇒ 成果已在主分支");
  assert.equal(runStatus(f, "r-a"), "discarded", "合并后抛弃");
  assert.equal(itemStatus(f, parent.id), "done");
});

// ── §5.7.4 / §16 S17：冲突 ──────────────────────────────────────────────────

// 三件事必须同时成立：父项 blocked（CAS 写 + 经工作项服务发事件 = P2b 的 Inbox 信号）、
// 集成分支保留（未落地的整批成果还在）、主分支一个字节不动。
//
// 本用例的父项**刻意从 `in_progress` 起步**（不是 `in_review`）：这正是接线后的真实形状 ——
// 没有任何别的路径把**父项**推到 `in_review`（机械半推的是子项）。它同时钉住 Important-1 的两件事：
// ① 收尾**先**把父项推进到 `in_review`（事件一的 `to`），② 冲突再把它置 `blocked`（事件二）——
// 两条都是**经唯一事件出口发出的真实变迁**，于是「父项确实变成 blocked 且那条事件确实发出」可断言。
test("冲突 ⇒ 父项 blocked、集成分支保留、主分支不动、立即停手", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f, { parentStatus: "in_progress" });
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2)); // 让 createdAt 严格递增：串行次序可预期
  await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "a.txt",
    content: "B\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  // 「进 Inbox」在 P2b 的机械形态就是「父项被置 blocked 且那条变迁事件发出去」（完整 Inbox 语义属 P2c，
  // 见计划「明确不在本计划」表）。订阅工作项事件的唯一出口来钉住它真的发出去了。
  const events: WorkItemEvent[] = [];
  f.runtime.subscribeWorkItemEvents((event) => events.push(event));

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  // 实体状态断言：读库，不是读返回值。
  assert.equal(itemStatus(f, parent.id), "blocked");
  assert.deepEqual(
    events.filter((e) => e.kind === "workitem.status_changed" && e.id === parent.id),
    [
      // ① 子项全终态 ⇒ 父项被（经唯一写者）推进到 in_review —— 接线后父项停在 in_progress 也能收尾。
      { kind: "workitem.status_changed", id: parent.id, from: "in_progress", to: "in_review" },
      // ② 冲突 ⇒ 父项置 blocked，且这条变迁**确实**经工作项服务的唯一出口发出（P2b 的 Inbox 信号）。
      { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "blocked" },
    ],
  );
  const integration = `squad/integration/${slugOf(f, childId)}`;
  assert.equal(
    await branchExists(f, integration),
    true,
    "集成分支必须保留（未落地的整批成果还在）",
  );
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支不动（整批没通过）");
  // 冲突的队员既没合并也没抛弃：它的活还在，等人（或队长）处理。
  assert.equal(runStatus(f, "r-a"), "merged", "第一个队员已经合进集成分支（顺序：先 a 后 b）");
  assert.equal(runStatus(f, "r-b"), "produced");
  assert.equal(await branchExists(f, f.runtime.squadRunRepo.get("r-b")!.branch!), true);
});

// §6.3：整批通过后**队员分支与集成分支都删**，成果留在 base。
test("整批通过 ⇒ finalize 后两条分支都不存在，成果在 base，父项 done", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await readMainFile(f, "b.txt"), "B\n");
  for (const branch of [a.branch, b.branch, `squad/integration/${slugOf(f, childId)}`]) {
    assert.equal(await branchExists(f, branch), false, `${branch} 合并后必须删掉`);
  }
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(runStatus(f, "r-b"), "discarded");
  assert.equal(itemStatus(f, parent.id), "done");
  // 工作树也要摘掉（抛弃 = 树与分支都收）：只删分支会让下一次同分支派发撞「分支已存在」。
  const live = await f.runtime.worktreeManager.list();
  assert.deepEqual(
    live.filter((e) => e.branch === a.branch || e.branch === b.branch),
    [],
  );
});

// ── §6.2 / §16 S5：被打回待修的队员不进 finalize 的抛弃集合 ─────────────────────

test("被打回待修的队员：不进合并、也不进抛弃集合（工作树存活到修复后重新审核）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const rejected = await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  // 打回：只改台账，工作树一个字节不动（生命周期层的语义，这里只借用它的结论态）。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-b", verdict: "rejected" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  // 被打回的那个：状态仍是 rejected（没被合、也没被抛），树与分支都还在，b.txt 也没进主分支。
  assert.equal(runStatus(f, "r-b"), "rejected");
  assert.equal(await branchExists(f, rejected.branch), true, "被打回待修的分支必须存活");
  assert.ok((await f.runtime.worktreeManager.list()).some((e) => e.branch === rejected.branch));
  assert.equal((await gitAt(f.repoRoot)(["cat-file", "-e", "main:b.txt"])).code !== 0, true);
  // 已产出未打回的那个照常落地，收尾照常完成。
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(await branchExists(f, a.branch), false);
  assert.equal(itemStatus(f, parent.id), "done");
});

// ── §6.2 / §5.7.4：串行合并（一次一个，后面看得见前面）─────────────────────────

test("串行合并：第二个队员的合并基于第一个的成果（不是各自从 base 重放）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  // 同一文件里**相隔两行**的两处改动（a 改第 1 行、b 改第 3 行）：git 能干净地合起来，于是结果文件
  // 同时带着两份改动 —— 这正是「第二次合并建立在第一次的成果之上」的判据。若实现改成「第二次合并前
  // 把集成分支 reset 回 base」，主分支上只会剩 b 的改动（「1\n2\nC\n」）而不是「A\n2\nC\n」。
  await commitInMain(f, "lines.txt", "1\n2\n3\n");
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "lines.txt",
    content: "A\n2\n3\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2)); // createdAt 严格递增 ⇒ 串行次序可预期
  await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "lines.txt",
    content: "1\n2\nC\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(
    await readMainFile(f, "lines.txt"),
    "A\n2\nC\n",
    "同一文件里两份改动都在 ⇒ 后合者看得见先合者",
  );
  // 次序也钉住：main 那个合并提交的第二父提交就是集成分支顶端，它的 first-parent 链必须是
  // 「先合 a、后合 b」，一路到 base —— 而不是各自独立从 base 分出来的两条线。
  const chain = await gitAt(f.repoRoot)(["log", "--first-parent", "--format=%s", "-2", "main^2"]);
  const slug = slugOf(f, childId);
  assert.deepEqual(chain.stdout.trim().split("\n"), [
    `Merge branch 'squad/member/${slug}/${slugOf(f, "ta-b")}' into squad/integration/${slug}`,
    `Merge branch 'squad/member/${slug}/${slugOf(f, "ta-a")}' into squad/integration/${slug}`,
  ]);
});

/** 往**主工作树**里提交一个文件，作为基准内容（队员的工作树都从 base 派生，看不见彼此）。 */
async function commitInMain(f: Fixture, file: string, content: string): Promise<void> {
  writeFileSync(join(f.repoRoot, file), content);
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", `base: ${file}`],
  ]) {
    const result = await gitAt(f.repoRoot)(args);
    assert.equal(result.code, 0, `${args.join(" ")} 失败: ${result.stderr}`);
  }
}

// ── 契约违例与幂等：不静默、也不把幂等重放变成响亮失败 ──────────────────────────

test("子项已全部终态却仍有队员 run 停在 open ⇒ 响亮抛出（绝不半批合并）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await f.runtime.lifecycle.openMemberRun({
    runId: "r-open",
    workItemId: childId,
    parentWorkItemId: parent.id,
    agentId: "ta-a",
    isLeaderTask: false,
  });
  // 子项被外部（人或队长）标成终态，而队员 run 从没上报完成：状态自相矛盾，且无法判断它的活该不该合。
  f.runtime.workItemService.transition(childId, "done", "in_progress");

  await assert.rejects(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /open/,
  );
});

test("同一批重复收尾（幂等重放）：第二次空转，不因集成分支已被删而抛错", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });
  // 事件可能重复投递（重连 / 重复订阅）：第二次调用不得抛（§5.7.5 的幂等口径），也不得动主分支。
  await assert.doesNotReject(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
  );
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(itemStatus(f, parent.id), "done");
});

// 【Important-1 ②】父项**不在 in_review** 时，收尾先把它推进到 in_review，再按结果落到 done。
// 这条替换了旧的「父项不在 in_review ⇒ CAS 未命中、丢弃不报错」用例：那个口径正是复审点名的缺陷
// （父项停在 in_progress ⇒ 用户看不到 done）。现在前置由**当时状态**读出，于是收尾真的落地。
test("父项停在 in_progress：收尾先推进到 in_review，再落到 done（读库断言）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f, { parentStatus: "in_progress" });
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");
  const events: WorkItemEvent[] = [];
  f.runtime.subscribeWorkItemEvents((event) => events.push(event));

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n", "整批通过 ⇒ 成果已在主分支");
  assert.equal(itemStatus(f, parent.id), "done", "父项确实变成 done（读库，不是读返回字符串）");
  assert.deepEqual(
    events.filter((e) => e.kind === "workitem.status_changed" && e.id === parent.id),
    [
      { kind: "workitem.status_changed", id: parent.id, from: "in_progress", to: "in_review" },
      { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "done" },
    ],
    "两条父项变迁都真实发生：先推进到 in_review，再落到 done",
  );
});

// 【Important-1 的「不得静默继续」】父项已是终态、但批里仍有未结算的队员产出（有人在批结算前把
// 父项标了终态）⇒ **响亮抛**：既不能静默返回（那份活会永远没人管），也不能照常合并（跨过一条已关闭
// 的工作项）。这是「静默未命中不再可能」这条要求的反面证据。
test("父项已是终态但批未结算 ⇒ 响亮抛（不静默、也不跨终态合并）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");
  // 有人抢先把父项收口成 done，而队员 r-a 还停在 produced（没合、没抛）。
  f.runtime.workItemService.transition(parent.id, "done", "in_review");

  await assert.rejects(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /已是终态/,
  );

  assert.equal(runStatus(f, "r-a"), "produced", "产出仍在，等人处理");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "一个字节都不许动");
});

// ── discardBatch：整批放弃（用户取消）────────────────────────────────────────

test("整批放弃：逐个抛弃（含 rejected / produced）→ 父项 cancelled，且集成分支不存在时也不抛", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const produced = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const rejected = await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-b", verdict: "rejected" });

  await f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(runStatus(f, "r-b"), "discarded");
  assert.equal(await branchExists(f, produced.branch), false);
  assert.equal(await branchExists(f, rejected.branch), false);
  assert.deepEqual(
    (await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );
  assert.equal(itemStatus(f, parent.id), "cancelled");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "整批放弃 ⇒ 主分支一个字节都没动过");
});

test("整批放弃：集成分支已存在（有队员合过）时也把它删掉", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const integration = `squad/integration/${slugOf(f, childId)}`;
  // 先单独审一个队员（把集成分支建出来），再整批放弃：集成分支属于本批的未落地成果，必须一起收掉。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  assert.equal(await branchExists(f, integration), true);

  await f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await branchExists(f, integration), false);
  assert.equal(itemStatus(f, parent.id), "cancelled");
});

// 四个父项流转里 `cancelled` 同样不能写死前置：用户可以在批进行到一半（父项停在 in_progress）时
// 整体放弃。旧实现写死 `expect="in_review"` ⇒ 这里会 CAS 未命中、静默丢弃 ⇒ 树与分支都收了、父项却
// 还显示进行中（正是复审 Important-1 的四条之一）。
test("整批放弃：父项停在 in_progress 也能被取消（读库断言，不静默未命中）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f, { parentStatus: "in_progress" });
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  assert.equal(itemStatus(f, parent.id), "in_progress", "夹具前提：父项尚未进入 in_review");

  await f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(
    itemStatus(f, parent.id),
    "cancelled",
    "父项确实变成 cancelled（不是停在 in_progress）",
  );
  assert.equal(runStatus(f, "r-a"), "discarded");
});

// ── discardBatch 的前置闸：**已结算的批不得再被「放弃」**（§5.7.4 的逆否）───────────────
//
// 逆推：§5.7.4 说「未合回的批不得被当已落地」；把这句话反过来就是「**已落地的批不得被当放弃**」。
// §6.3 又只把「放弃」许给**还没合回主分支**的批 ⇒ 因此「已合回后放弃」**必须**被拒绝，且**必须**
// 拒绝在任何不可逆动作（删分支 / 清工作树）之前 —— 否则一次注定失败的调用已经造成了破坏。
test("整批放弃：批**已合回主分支**（父项 done）⇒ 响亮拒绝，且一个字节都没动", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");
  // 正常收尾：整批合回 main、父项 done（这正是「已落地」的形状）。
  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });
  assert.equal(itemStatus(f, parent.id), "done", "夹具前提：这条批已经落地");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");

  await assert.rejects(
    f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id }),
    // **必须**是「已合回主分支」这个理由（不是随便一个失败）：把闸改成静默返回时本断言必红。
    /已经合回主分支/,
  );

  // 实体状态断言：**已落地的成果仍在主分支上**（不许静默丢弃 / 也不许把它标成放弃）。
  assert.equal(itemStatus(f, parent.id), "done", "父项仍是 done（没有被改写成 cancelled）");
  assert.equal(await readMainFile(f, "a.txt"), "A\n", "已落地的成果一个字节都没动");
  assert.equal(runStatus(f, "r-a"), "discarded", "该 run 的终态仍是收尾时的 discarded");
  assert.equal(await branchExists(f, a.branch), false, "收尾后就该没有队员分支（未被复活）");
});

test("整批放弃：重复放弃（父项已 cancelled）⇒ 响亮拒绝，不是静默成功", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });
  assert.equal(itemStatus(f, parent.id), "cancelled");

  // 第二次：放弃是终态动作。给一个「假成功」会让用户以为他曾放弃的是一条别的批 —— 故响亮拒绝。
  await assert.rejects(
    f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /已是终态/,
  );
  assert.equal(itemStatus(f, parent.id), "cancelled");
});

test("整批放弃：集成分支**已合回 base**（父项却未收口）⇒ 响亮拒绝，不把已落地的成果标成放弃", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const integration = `squad/integration/${slugOf(f, childId)}`;
  // 把队员合进集成分支（父项仍停在 in_review —— 收尾的第一步）。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  // 手工做**收尾的最后一步之前**最危险的那件事：整批合回 base（成果此刻已在主分支上）。
  const landed = await f.runtime.integrationMerger.finalize({ integration, target: "main" });
  assert.equal(landed.ok, true, "夹具前提：集成分支已合回 main");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(itemStatus(f, parent.id), "in_review", "夹具前提：父项还没收口（异常半程）");

  await assert.rejects(
    f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /已经合回 main/,
  );

  assert.equal(itemStatus(f, parent.id), "in_review", "父项没有被标成放弃");
  assert.equal(await readMainFile(f, "a.txt"), "A\n", "已在主分支上的成果没被动过");
});

test("整批放弃：父工作项不存在 / 已归档 ⇒ 响亮拒绝（不静默返回）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });

  await assert.rejects(
    f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: "wi-does-not-exist" }),
    /不存在或已归档/,
  );
  // 归档（`get` 对归档项返回 null ⇒ 与「不存在」同一条闸）：先归档再放弃必须同样响亮。
  f.db.prepare("UPDATE work_items SET archived_at = ? WHERE id = ?").run(1, parent.id);
  await assert.rejects(
    f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /不存在或已归档/,
  );
  assert.equal(runStatus(f, "r-a"), "produced", "队员的活仍在（拒绝发生在任何破坏之前）");
});

// ── 契约本体：一批只能落到一条集成分支（Important-2）──────────────────────────
//
// 这是化解「一个工作项一个批次」这条机制的**契约本体**（`integrationBranch` 的「多工作项 ⇒ 响亮拒绝」）：
// 队员分属两个工作项时会有两条集成分支，而 `finalize` 只能落一条 —— 先落的那条会让「整批可整体放弃」
// 当场失效（部分成果已在主分支上、且回不去）。所以这种形状**响亮拒绝**，且拒绝必须发生在**任何副作用
// 之前**（不碰 git、不写工作项），否则一次注定失败的调用会留下半程状态。
// controller 裁定：机制 = **一个工作项 = 一个批次**，多工作项输入**响亮拒绝是正确行为**（实现不改行为）。
test("多工作项 ⇒ 响亮拒绝，且零副作用（无 git 动作、无状态写入）", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  // 两个**不同 workItemId** 的子项各由一名队员产出 ⇒ 若照常收尾会算出两条集成分支。
  const c1 = "wi-c1";
  const c2 = "wi-c2";
  createItem(f, {
    id: c1,
    title: "子任务一",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  createItem(f, {
    id: c2,
    title: "子任务二",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  f.runtime.workItemService.transition(c1, "in_progress", "todo");
  f.runtime.workItemService.transition(c2, "in_progress", "todo");
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: c1,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  const b = await produce(f, {
    runId: "r-b",
    childId: c2,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  f.runtime.workItemService.transition(c1, "done", "in_review");
  f.runtime.workItemService.transition(c2, "done", "in_review");

  // 「无 git 动作」的机器化证据：把编排器自己那条 git 通道换成计数器（任何 git 调用都会被记下）。
  const realGit = f.runtime.git;
  let gitCalls = 0;
  f.runtime.git = (args, opts) => {
    gitCalls += 1;
    return realGit(args, opts);
  };

  await assert.rejects(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /一批只能落到一条集成分支/,
  );

  // 零副作用：没有 git 动作、没有工作项写入、两条集成分支都没被建出来、队员成果原样在位。
  assert.equal(gitCalls, 0, "违约形状必须在碰 git 之前就被拒掉");
  assert.equal(itemStatus(f, parent.id), "in_review", "父项不被推进（拒绝发生在写工作项之前）");
  assert.equal(runStatus(f, "r-a"), "produced");
  assert.equal(runStatus(f, "r-b"), "produced");
  assert.equal(await branchExists(f, `squad/integration/${slugOf(f, c1)}`), false, "不建集成分支");
  assert.equal(await branchExists(f, `squad/integration/${slugOf(f, c2)}`), false, "不建集成分支");
  assert.equal(await branchExists(f, a.branch), true);
  assert.equal(await branchExists(f, b.branch), true);
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支一个字节都不动");
});

// ── 串行化的键 = 仓库（Important-3）────────────────────────────────────────────
//
// spec §6.3 要求「串行合并（一次一个）」，而合并的实现是「检出 → merge」，**整个仓库只有一份主工作树
// 的 HEAD** —— 争用它的是**同一个仓库**，与「哪一批 / 哪个父项」无关。旧实现按 `parentWorkItemId` 分链，
// 于是两个**不同父项**的批次会并发去 checkout/merge 同一个 HEAD（一条链的 checkout 挪走另一条刚检出的
// 分支、merge --abort 一起回滚对方），而 git 拦不住这种**同进程内**的竞态。
//
// 顺序断言：把**两条链共用的**「合一个队员」入口（`lifecycle.reviewMemberRun`）挡住第一次调用，
// 若真的按仓库串行，第二条链在第一条结束前**一个合并入口都不该进**。
test("两个不同父项的批次在同一仓库上不并发（按仓库串行）", async () => {
  const f = await setup();
  // 两个批：各自的父项 + 一个子项 + 一名队员产出（不同文件，两个批互不冲突）。
  const p1 = createItem(f, {
    id: "wi-p1",
    title: "计划一",
    assignee: { type: "squad", id: "sq1" },
  });
  const p2 = createItem(f, {
    id: "wi-p2",
    title: "计划二",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c1",
    title: "子一",
    parentId: p1.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  createItem(f, {
    id: "wi-c2",
    title: "子二",
    parentId: p2.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  for (const [child, parent] of [
    ["wi-c1", p1],
    ["wi-c2", p2],
  ] as const) {
    f.runtime.workItemService.transition(child, "in_progress", "todo");
    f.runtime.workItemService.transition(parent.id, "in_review", "todo");
  }
  await produce(f, {
    runId: "r-a",
    childId: "wi-c1",
    parentId: p1.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await produce(f, {
    runId: "r-b",
    childId: "wi-c2",
    parentId: p2.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  f.runtime.workItemService.transition("wi-c1", "done", "in_review");
  f.runtime.workItemService.transition("wi-c2", "done", "in_review");

  // 挡住**第一次**合并入口：它属于第一条链。
  const realReview = f.runtime.lifecycle.reviewMemberRun.bind(f.runtime.lifecycle);
  const entered: string[] = [];
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let heldOnce = false;
  f.runtime.lifecycle.reviewMemberRun = async (input) => {
    entered.push(input.runId);
    if (!heldOnce) {
      heldOnce = true;
      await held;
    }
    return realReview(input);
  };

  const first = f.orchestrator.advanceAfterChildrenDone({
    workspaceKey: WS,
    parentWorkItemId: p1.id,
  });
  const second = f.orchestrator.advanceAfterChildrenDone({
    workspaceKey: WS,
    parentWorkItemId: p2.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // 第一条链还卡在合并入口里：第二条链**不得**进入任何合并（这正是「同仓库串行」的可观察事实）。
  assert.deepEqual(entered, ["r-a"], "第一条链未结束时，第二条链不得开始合并（真正按仓库串行）");

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ["r-a", "r-b"], "第一条链结束后第二条链才接上");
  assert.equal(itemStatus(f, p1.id), "done");
  assert.equal(itemStatus(f, p2.id), "done");
});

// ── 全 rejected：幂等空转（Minor，此前只有「由代码保证」）──────────────────────
//
// 一个批里所有队员都被打回（`rejected`）时：没有待合队员（`rejected` 不是 `produced`）、集成分支
// 也从未建出 ⇒ 收尾走幂等闸空转：不 finalize、不抛弃、不动主分支、也不推进父项（父项停在
// `in_review`，等工作被修复后重新审核）。这条把「由代码保证」变成真断言。
test("全 rejected：幂等空转（不 finalize、不抛弃、父项停在 in_review）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const rejected = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "rejected" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await assert.doesNotReject(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
  );

  assert.equal(runStatus(f, "r-a"), "rejected", "打回的队员一个字节不动（等修复后重新审核）");
  assert.equal(await branchExists(f, rejected.branch), true, "工作树与分支存活到合并（S5）");
  assert.equal(
    await branchExists(f, `squad/integration/${slugOf(f, childId)}`),
    false,
    "集成分支不该被建出",
  );
  assert.equal(itemStatus(f, parent.id), "in_review", "父项停在 in_review（没有可结算的成果）");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支一个字节都不动");
});

// 【空批收口】子项全终态、但本批没有任何队员 run（例如子项在派单前就被取消）：没有可落地的成果，
// 不 finalize（集成分支压根不存在），父项按「批已结算」收口为 done。父项**从 in_progress 起步**：
// 这正是四个静默未命中点之一的「空批 done」——若前置写死，这里也会静默不动。
test("空批（子项全终态但无队员 run）：父项先推进到 in_review 再收口为 done", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: "sq1" },
  });
  createItem(f, {
    id: "wi-c",
    title: "派单前被取消的子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  f.runtime.workItemService.transition("wi-c", "cancelled", "todo");
  f.runtime.workItemService.transition(parent.id, "in_progress", "todo");
  const events: WorkItemEvent[] = [];
  f.runtime.subscribeWorkItemEvents((event) => events.push(event));

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "done", "空批按「批已结算」收口（读库断言）");
  assert.deepEqual(
    events.filter((e) => e.kind === "workitem.status_changed" && e.id === parent.id),
    [
      { kind: "workitem.status_changed", id: parent.id, from: "in_progress", to: "in_review" },
      { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "done" },
    ],
  );
  assert.deepEqual(
    (await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );
});

// ── 穷举矩阵的空缺格：每一格都要有结论（有测试 / 由代码保证 / 不适用）────────────

// 【无子项】`areAllChildrenTerminal` 对零子项返回 false（workItemRepo.ts:166 `rows.length === 0 → false`），
// 所以「没有子项」不是「全终态」——不做任何事，也不得被当成「空批通过 ⇒ 标 done」。
test("无子项：不触发（零子项 ≠ 全终态），一个字节都不动", async () => {
  const f = await setup();
  const parent = createItem(f, {
    id: "wi-p",
    title: "没有子项的计划",
    assignee: { type: "squad", id: "sq1" },
  });
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "in_review");
  assert.deepEqual(
    (await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );
});

// 【含 blocked 子项】blocked 属 `started` 类（`@zcode/shared` 的 WORK_ITEM_STATUS_CATEGORY），不是终态。
test("含 blocked 子项：同样不触发（blocked 是 started 类，不是终态）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  createItem(f, {
    id: "wi-c2",
    title: "卡住的子任务",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");
  f.runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  f.runtime.workItemService.transition("wi-c2", "blocked", "in_progress");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(runStatus(f, "r-a"), "produced", "批没齐，不得合并");
  assert.equal(await readMainFile(f, "a.txt"), "1\n");
  assert.equal(itemStatus(f, parent.id), "in_review");
});

// 【全 cancelled 子项 + 仍有 produced 队员】合并集合由 **run 台账**决定，子项 category 只负责「触不触发」。
// 「子项被取消 ⇒ 它的产出一律丢弃」是一条**更强的策略**，而丢弃队员产出要用户显式走 `discardBatch`
// （那才是「整批放弃」的语义）—— 收尾路径不替用户决定要不要丢掉一份已经产出的活。
test("全 cancelled 子项：仍按 run 台账结算（produced 的成果照常落地）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  f.runtime.workItemService.transition(childId, "cancelled", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(itemStatus(f, parent.id), "done");
});

// 【队员 run 全 merged（最小视图逐个审查通过后再收尾）】收尾仍要 finalize —— 漏掉这一步，集成分支上的
// 成果永远合不回主分支，而 run 已经是 merged，谁也不会再看它一眼。
test("队员 run 全 merged：收尾仍要 finalize（合回主分支）并收干净", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  assert.equal(runStatus(f, "r-a"), "merged");
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(await branchExists(f, a.branch), false);
  assert.equal(await branchExists(f, `squad/integration/${slugOf(f, childId)}`), false);
  assert.equal(itemStatus(f, parent.id), "done");
});

// 【部分 merged】一个先经审查合过、一个刚产出：两个都要在（第二个串行接在第一个后面）、都被抛弃。
test("部分 merged：先审过的与刚产出的都被合、都被抛弃", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "b.txt",
    content: "B\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await readMainFile(f, "b.txt"), "B\n");
  assert.equal(runStatus(f, "r-a"), "discarded");
  assert.equal(runStatus(f, "r-b"), "discarded");
  assert.equal(await branchExists(f, a.branch), false);
  assert.equal(await branchExists(f, b.branch), false);
  assert.equal(itemStatus(f, parent.id), "done");
});

// 【待合队列的第 1 个就冲突】立即停手：后面的成员一个都不许合（否则把一个注定要回滚的批越铺越大）。
// 构造：r-a 已先经审查合进集成分支（改了 a.txt 第 1 行）；r-b 也改 a.txt 第 1 行 ⇒ 它是**第 1 个待合的**
// 成员，一合就冲突；r-c 改的是别的文件（本来能干净合上）⇒ 用来证明「后面的成员不再被合」。
test("第一个待合的队员就冲突：父项 blocked、后面的成员不再合并、集成分支保留既成成果", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, {
    runId: "r-b",
    childId,
    parentId: parent.id,
    agentId: "ta-b",
    file: "a.txt",
    content: "B\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const c = await produce(f, {
    runId: "r-c",
    childId,
    parentId: parent.id,
    agentId: "ta-c",
    file: "c.txt",
    content: "C\n",
  });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "blocked");
  assert.equal(runStatus(f, "r-b"), "produced", "第 1 个待合的就冲突 ⇒ 停手，它保持 produced");
  assert.equal(runStatus(f, "r-c"), "produced", "后面的成员一个都不许合");
  assert.equal(runStatus(f, "r-a"), "merged", "早先合进集成分支的成果不动");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支不动（整批没通过）");
  assert.equal(
    (await gitAt(f.repoRoot)(["cat-file", "-e", "main:c.txt"])).code !== 0,
    true,
    "r-c 的成果不许进主分支",
  );
  // 集成分支保留，且内容是「既成成果 + 没有半吊子」：只有 a 的改动。
  const integrationContent = await gitAt(f.repoRoot)([
    "show",
    `squad/integration/${slugOf(f, childId)}:a.txt`,
  ]);
  assert.equal(integrationContent.stdout, "A\n");
  for (const branch of [a.branch, b.branch, c.branch]) {
    assert.equal(await branchExists(f, branch), true, `${branch} 不得被抛弃（批没过）`);
  }
});

// 【finalize 冲突】集成分支与**已经前进过的 base** 冲突：`finalize` 内部把主工作树回滚到合并前，
// 父项 blocked；主分支停在**它自己那条提交**上（本层不替用户回退别人提交，也不把冲突说成成功）。
test("finalize 冲突：父项 blocked、主分支停在自己的提交、集成分支保留", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, {
    runId: "r-a",
    childId,
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  // 队员合并后主工作树停在集成分支上（integrationMerge 的调用方约束），先回 base 再动它。
  assert.equal((await gitAt(f.repoRoot)(["checkout", "main"])).code, 0);
  await commitInMain(f, "a.txt", "X\n"); // base 前进：与集成分支上的「A」在第 1 行冲突
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "blocked");
  assert.equal(await readMainFile(f, "a.txt"), "X\n", "主分支停在自己的提交上，且不含未落地的成果");
  assert.equal(await branchExists(f, `squad/integration/${slugOf(f, childId)}`), true);
  assert.equal(runStatus(f, "r-a"), "merged", "已合进集成分支的成果留在集成分支上（没丢）");
});

// 【base 分支不存在】既不是冲突，也不是「本批没成果」：不谎报 done、也不误导人去解冲突 ⇒ 响亮抛出。
//
// 本用例同时是 Important-1 ① 的证据：父项**从 `in_progress` 起步**，一次注定失败的 finalize 把
// 「父项已被推进到 in_review」这一瞬**留在库里**，于是可以**读库断言**（而不是读某条返回字符串）。
test("finalize 时 base 分支不存在 ⇒ 响亮抛出（不谎报 done、不冒充冲突）", async () => {
  const f = await setup({ baseBranch: "topic" });
  await gitAt(f.repoRoot)(["branch", "topic", "main"]);
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
  // 父项停在 in_progress（不是 in_review）：接线后的真实形状 —— 没有别的路径把父项推到 in_review。
  f.runtime.workItemService.transition(parent.id, "in_progress", "todo");
  await produce(f, {
    runId: "r-a",
    childId: "wi-c",
    parentId: parent.id,
    agentId: "ta-a",
    file: "a.txt",
    content: "A\n",
  });
  // 先经审查把队员合掉：集成分支在这一刻从 base（topic）派生出来，之后的收尾只差 finalize。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  f.runtime.workItemService.transition("wi-c", "done", "in_review");
  const events: WorkItemEvent[] = [];
  f.runtime.subscribeWorkItemEvents((event) => events.push(event));
  // 抹掉 base：主工作树此刻停在集成分支上（队员刚合），所以能删掉 topic。
  const deleted = await gitAt(f.repoRoot)(["branch", "-D", "topic"]);
  assert.equal(deleted.code, 0, deleted.stderr);

  await assert.rejects(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /不是冲突/,
  );
  // 读库断言：父项确实被推进到了 in_review（不是读返回值、也不是「应该会」）—— 这一步若缺失，
  // finalize 的四条父项流转都会静默未命中（复审 Important-1）。同时那条变迁事件也真实发出。
  assert.equal(itemStatus(f, parent.id), "in_review", "父项已被推进到 in_review（不谎报 done）");
  assert.deepEqual(
    events.filter((e) => e.kind === "workitem.status_changed" && e.id === parent.id),
    [{ kind: "workitem.status_changed", id: parent.id, from: "in_progress", to: "in_review" }],
  );
});

// ── workspace 绑定（确认 3）：异己 key 响亮拒绝，绝不在另一个 workspace 上动手 ──

test("异己 workspaceKey ⇒ 抛（带两侧的值），两个入口都不放行", async () => {
  const f = await setup();
  const { parent } = await batchWithOneChild(f);
  for (const call of [
    () =>
      f.orchestrator.advanceAfterChildrenDone({
        workspaceKey: "another-ws",
        parentWorkItemId: parent.id,
      }),
    () => f.orchestrator.discardBatch({ workspaceKey: "another-ws", parentWorkItemId: parent.id }),
  ]) {
    const error = await call().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /本方绑定「ws」/);
    assert.match(error.message, /收到「another-ws」/);
  }
});

/** 分支名里那一段 slug：**直接取生产实现**（`slugForId`），测试里不重算命名规则。 */
function slugOf(_f: Fixture, id: string): string {
  return slugForId(id);
}
