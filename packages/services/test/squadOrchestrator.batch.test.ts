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
function gitAt(cwd: string): (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  const git = realGit(cwd);
  return (args) => git(args, {});
}

async function setup(options: { baseBranch?: string } = {}): Promise<{
  repoRoot: string;
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
  return { repoRoot, runtime, orchestrator: createSquadOrchestrator({ runtime }) };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** 建工作项：父项派给小队、子项派给队员（形状与生产一致，但本层只关心父子关系与状态）。 */
function createItem(
  f: Fixture,
  input: { id: string; title: string; parentId?: string; assignee: { type: "squad" | "agent"; id: string } },
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
  input: { runId: string; childId: string; parentId: string; agentId: string; file: string; content: string },
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
  for (const args of [["add", "-A"], ["commit", "-qm", `${input.agentId} work`]]) {
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
  return (await f.runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: f.repoRoot }))
    .code === 0;
}

function readMainFile(f: Fixture, file: string): Promise<string> {
  return gitAt(f.repoRoot)(["show", `main:${file}`]).then((r) => r.stdout);
}

/** 一条「父项 + 一个子项」的批，子项由一名队员产出；返回该父项与其阵容。 */
async function batchWithOneChild(
  f: Fixture,
  opts: { childId?: string; parentStatus?: "in_review" | "in_progress" } = {},
) {
  const parent = createItem(f, { id: "wi-p", title: "计划", assignee: { type: "squad", id: "sq1" } });
  const childId = opts.childId ?? "wi-c";
  createItem(f, { id: childId, title: "子任务", parentId: parent.id, assignee: { type: "agent", id: "ta-a" } });
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
  createItem(f, { id: "wi-c2", title: "还没做完的子任务", parentId: parent.id, assignee: { type: "agent", id: "ta-b" } });
  // 子项：wi-c 已终态（done），wi-c2 停在 in_review ⇒ 未全部终态。
  await produce(f, { runId: "r-a", childId: "wi-c", parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  f.runtime.workItemService.transition("wi-c", "done", "in_review");
  f.runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  f.runtime.workItemService.transition("wi-c2", "in_review", "in_progress");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(runStatus(f, "r-a"), "produced", "不得被合并（批没齐）");
  assert.equal(await branchExists(f, f.runtime.squadRunRepo.get("r-a")!.branch!), true);
  assert.equal(await branchExists(f, `squad/integration/${slugOf(f, "wi-c")}`), false, "不许提前建集成分支");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支一个字节都不许动");
  assert.equal(itemStatus(f, parent.id), "in_review", "父项不动");
});

// §5.7.3 的判据是 **category**，不是键名：`cancelled` 是 closed 类，与 done 一样算终态。
// 用键名比较（`=== "done"`）的实现会漏掉这一格 ⇒ 批永远收不了尾且不报错。
test("cancelled 子项也算终态（用 category 判定，不是键名比较）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  createItem(f, { id: "wi-c2", title: "被取消的子任务", parentId: parent.id, assignee: { type: "agent", id: "ta-b" } });
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
test("冲突 ⇒ 父项 blocked、集成分支保留、主分支不动、立即停手", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  await new Promise((resolve) => setTimeout(resolve, 2)); // 让 createdAt 严格递增：串行次序可预期
  await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "a.txt", content: "B\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  // 「进 Inbox」在 P2b 的机械形态就是「父项被置 blocked 且那条变迁事件发出去」（完整 Inbox 语义属 P2c，
  // 见计划「明确不在本计划」表）。订阅工作项事件的唯一出口来钉住它真的发出去了。
  const events: WorkItemEvent[] = [];
  f.runtime.subscribeWorkItemEvents((event) => events.push(event));

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "blocked");
  assert.deepEqual(
    events.filter((e) => e.kind === "workitem.status_changed" && e.id === parent.id),
    [{ kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "blocked" }],
    "blocked 的变迁必须经工作项服务的唯一出口发出来（P2b 的 Inbox 信号）",
  );
  const integration = `squad/integration/${slugOf(f, childId)}`;
  assert.equal(await branchExists(f, integration), true, "集成分支必须保留（未落地的整批成果还在）");
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
  const a = await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "b.txt", content: "B\n" });
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
  assert.deepEqual(live.filter((e) => e.branch === a.branch || e.branch === b.branch), []);
});

// ── §6.2 / §16 S5：被打回待修的队员不进 finalize 的抛弃集合 ─────────────────────

test("被打回待修的队员：不进合并、也不进抛弃集合（工作树存活到修复后重新审核）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  const a = await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "lines.txt", content: "A\n2\n3\n" });
  await new Promise((resolve) => setTimeout(resolve, 2)); // createdAt 严格递增 ⇒ 串行次序可预期
  await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "lines.txt", content: "1\n2\nC\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await readMainFile(f, "lines.txt"), "A\n2\nC\n", "同一文件里两份改动都在 ⇒ 后合者看得见先合者");
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
  for (const args of [["add", "-A"], ["commit", "-qm", `base: ${file}`]]) {
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
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });
  // 事件可能重复投递（重连 / 重复订阅）：第二次调用不得抛（§5.7.5 的幂等口径），也不得动主分支。
  await assert.doesNotReject(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
  );
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(itemStatus(f, parent.id), "done");
});

test("父项不在 in_review 时 CAS 未命中：丢弃、不报错（spec §5.7.5），主分支仍不动", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f, { parentStatus: "in_progress" });
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "a.txt", content: "B\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await assert.doesNotReject(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
  );

  // 冲突已经发生（r-a 合入、r-b 冲突），但父项的期望前置 `in_review` 与实际 `in_progress` 不符 ⇒ CAS 未命中，
  // 按 §5.7.5「丢弃不报错」：父项**保持原状态**。这不是无声漏判，而是规范明文要求的幂等口径
  // （改状态的权力在 CAS 上，不在本层）。
  assert.equal(itemStatus(f, parent.id), "in_progress");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支仍不动");
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
  assert.deepEqual((await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null), []);
  assert.equal(itemStatus(f, parent.id), "cancelled");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "整批放弃 ⇒ 主分支一个字节都没动过");
});

test("整批放弃：集成分支已存在（有队员合过）时也把它删掉", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  const integration = `squad/integration/${slugOf(f, childId)}`;
  // 先单独审一个队员（把集成分支建出来），再整批放弃：集成分支属于本批的未落地成果，必须一起收掉。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  assert.equal(await branchExists(f, integration), true);

  await f.orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(await branchExists(f, integration), false);
  assert.equal(itemStatus(f, parent.id), "cancelled");
});

// ── 穷举矩阵的空缺格：每一格都要有结论（有测试 / 由代码保证 / 不适用）────────────

// 【无子项】`areAllChildrenTerminal` 对零子项返回 false（workItemRepo.ts:166 `rows.length === 0 → false`），
// 所以「没有子项」不是「全终态」——不做任何事，也不得被当成「空批通过 ⇒ 标 done」。
test("无子项：不触发（零子项 ≠ 全终态），一个字节都不动", async () => {
  const f = await setup();
  const parent = createItem(f, { id: "wi-p", title: "没有子项的计划", assignee: { type: "squad", id: "sq1" } });
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "in_review");
  assert.deepEqual((await f.runtime.worktreeManager.list()).filter((e) => e.branch !== null), []);
});

// 【含 blocked 子项】blocked 属 `started` 类（`@zcode/shared` 的 WORK_ITEM_STATUS_CATEGORY），不是终态。
test("含 blocked 子项：同样不触发（blocked 是 started 类，不是终态）", async () => {
  const f = await setup();
  const { parent, childId } = await batchWithOneChild(f);
  createItem(f, { id: "wi-c2", title: "卡住的子任务", parentId: parent.id, assignee: { type: "agent", id: "ta-b" } });
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
  const a = await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
  const a = await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "b.txt", content: "B\n" });
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
  const a = await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = await produce(f, { runId: "r-b", childId, parentId: parent.id, agentId: "ta-b", file: "a.txt", content: "B\n" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const c = await produce(f, { runId: "r-c", childId, parentId: parent.id, agentId: "ta-c", file: "c.txt", content: "C\n" });
  f.runtime.workItemService.transition(childId, "done", "in_review");

  await f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id });

  assert.equal(itemStatus(f, parent.id), "blocked");
  assert.equal(runStatus(f, "r-b"), "produced", "第 1 个待合的就冲突 ⇒ 停手，它保持 produced");
  assert.equal(runStatus(f, "r-c"), "produced", "后面的成员一个都不许合");
  assert.equal(runStatus(f, "r-a"), "merged", "早先合进集成分支的成果不动");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "主分支不动（整批没通过）");
  assert.equal((await gitAt(f.repoRoot)(["cat-file", "-e", "main:c.txt"])).code !== 0, true, "r-c 的成果不许进主分支");
  // 集成分支保留，且内容是「既成成果 + 没有半吊子」：只有 a 的改动。
  const integrationContent = await gitAt(f.repoRoot)(["show", `squad/integration/${slugOf(f, childId)}:a.txt`]);
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
  await produce(f, { runId: "r-a", childId, parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
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
test("finalize 时 base 分支不存在 ⇒ 响亮抛出（不谎报 done、不冒充冲突）", async () => {
  const f = await setup({ baseBranch: "topic" });
  await gitAt(f.repoRoot)(["branch", "topic", "main"]);
  const parent = createItem(f, { id: "wi-p", title: "计划", assignee: { type: "squad", id: "sq1" } });
  createItem(f, { id: "wi-c", title: "子任务", parentId: parent.id, assignee: { type: "agent", id: "ta-a" } });
  f.runtime.workItemService.transition("wi-c", "in_progress", "todo");
  f.runtime.workItemService.transition(parent.id, "in_review", "todo");
  await produce(f, { runId: "r-a", childId: "wi-c", parentId: parent.id, agentId: "ta-a", file: "a.txt", content: "A\n" });
  // 先经审查把队员合掉：集成分支在这一刻从 base（topic）派生出来，之后的收尾只差 finalize。
  await f.runtime.lifecycle.reviewMemberRun({ runId: "r-a", verdict: "approved" });
  f.runtime.workItemService.transition("wi-c", "done", "in_review");
  // 抹掉 base：主工作树此刻停在集成分支上（队员刚合），所以能删掉 topic。
  const deleted = await gitAt(f.repoRoot)(["branch", "-D", "topic"]);
  assert.equal(deleted.code, 0, deleted.stderr);

  await assert.rejects(
    f.orchestrator.advanceAfterChildrenDone({ workspaceKey: WS, parentWorkItemId: parent.id }),
    /不是冲突/,
  );
  assert.equal(itemStatus(f, parent.id), "in_review", "父项不动（不谎报 done）");
});

// ── workspace 绑定（确认 3）：异己 key 响亮拒绝，绝不在另一个 workspace 上动手 ──

test("异己 workspaceKey ⇒ 抛（带两侧的值），两个入口都不放行", async () => {
  const f = await setup();
  const { parent } = await batchWithOneChild(f);
  for (const call of [
    () => f.orchestrator.advanceAfterChildrenDone({ workspaceKey: "another-ws", parentWorkItemId: parent.id }),
    () => f.orchestrator.discardBatch({ workspaceKey: "another-ws", parentWorkItemId: parent.id }),
  ]) {
    const error = await call().then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, /本方绑定「ws」/);
    assert.match(error.message, /收到「another-ws」/);
  }
});

/** 分支名里那一段 slug：**直接取生产实现**（`slugForId`），测试里不重算命名规则。 */
function slugOf(_f: Fixture, id: string): string {
  return slugForId(id);
}
