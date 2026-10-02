import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkItem } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { memberDirName, planBranches } from "../src/worktree/branchNaming.js";
import { canonicalPath, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";
import {
  createSquadDispatchRequestHub,
  type SquadDispatchRequest,
} from "../src/workitem/squadDispatchRequests.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { createSquadRuntimeService, type ISquadRuntimeService, type SquadWorkspaceTarget } from "../src/workitem/squadRuntimeService.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import { makeRepo, realGit } from "./helpers/gitFixture.js";

/* Wave 3 端到端验收：闭环「建小队 → 建工作项指派给小队 → 队员各开工作树 → 审查 → 合并 → 抛弃」。

   为什么这一层必须是**独立于既有单层用例**的整链验收：既有用例各自验证一层（编排 / 生命周期 / 机械半），
   而 spec 的目标是**闭环**——任何一层对、接线错（例如组合根没把 `child_completed` 转给编排器、
   没把派发请求发到常驻 hub）时，单层用例全绿而闭环仍然不成立。本文件按组合根 `node.ts`
   的 `createSquadRuntimeFor` **同形装配**（每个服务调用现构 runtime、逐实例挂事件转发），
   再逐步断言**实体状态**（读 sqlite / 读 git ref / 读工作树目录 / 读主分支文件），不看返回字符串。

   纪律与既有夹具一致：所有建仓库 / 建分支 / 建工作树都发生在 `makeRepo()` 造的**临时 mkdtemp 仓库**
   里，绝不触碰真实工作树；临时目录的清理沿用既有约定（由 OS 的 tmp 机制回收，夹具未注册显式删除）。 */

const WS = "ws";

/** 面向单个目录的真 git 调用（与既有夹具同形）：断言要的正是「git 真把什么写进了哪个仓库」。 */
function gitAt(
  cwd: string,
): (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  const git = realGit(cwd);
  return (args) => git(args, {});
}

type Harness = {
  repoRoot: string;
  db: DatabaseSync;
  service: ISquadRuntimeService;
  target: SquadWorkspaceTarget;
  /** 常驻侧收到的派发请求（组合根同形的 hub）。 */
  dispatched: SquadDispatchRequest[];
  /** 所有实例收到的全部工作项事件（状态变迁 + 派发请求）。 */
  events: WorkItemEvent[];
  /** 非预期的收尾链异常（必须为空）。 */
  chainErrors: unknown[];
  /** 现构一个新 runtime（裁定 4：不缓存、不取首个）。 */
  runtime: () => Promise<SquadRuntime>;
  /** 把事件驱动的那条批次收尾链跑到所有 promise 落定。 */
  drain: () => Promise<void>;
};

/**
 * 装配与组合根同形。
 *
 * `forwardChildCompleted` 默认开（= node.ts 的 `forwardSquadChildCompleted`）：
 * 没有它，「子项终态 ⇒ children_done ⇒ 批次收尾」这条链**断在接线处**，闭环不成立。
 * 崩溃窗口用例（E）刻意关掉它：那样构造出的正是「子项全终态但批次未 finalize 的启动态」。
 */
async function setup(options: { forwardChildCompleted?: boolean } = {}): Promise<Harness> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const target: SquadWorkspaceTarget = { path: repoRoot, identity: WS };

  const dispatched: SquadDispatchRequest[] = [];
  const events: WorkItemEvent[] = [];
  const chain: Promise<void>[] = [];
  const chainErrors: unknown[] = [];
  const hub = createSquadDispatchRequestHub();
  hub.subscribe((request) => dispatched.push(request));

  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    const runtime = await createSquadRuntime({
      db,
      workspacePath: t.path,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
      // 与组合根同形：每个 runtime 都把派发请求 publish 到那一份 hub。
      dispatchRequestHub: hub,
    });
    runtime.subscribeWorkItemEvents((event) => events.push(event));
    if (options.forwardChildCompleted !== false) {
      runtime.subscribeWorkItemEvents((event) => {
        if (event.kind !== "workitem.child_completed") return;
        // 与 node.ts 同形：只 void + 留痕（在这里 await 会与模块级同仓库串行队列自等死锁）。
        chain.push(
          createSquadOrchestrator({ runtime })
            .advanceAfterChildrenDone({
              workspaceKey: WS,
              parentWorkItemId: event.parentId,
            })
            .catch((error: unknown) => {
              chainErrors.push(error);
            }),
        );
      });
    }
    return runtime;
  };

  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => {
      await archiveSquadAndTransfer(await createRuntime(t), id);
    },
    createOrchestrator: createSquadOrchestrator,
    logWarn: () => {},
  });

  return {
    repoRoot,
    db,
    service,
    target,
    dispatched,
    events,
    chainErrors,
    runtime: () => createRuntime(target),
    drain: async () => {
      while (chain.length > 0) await chain.shift()!;
    },
  };
}

type Fixture = Harness;

// ── 建面：小队 / 智能体 / 工作项（全部经**服务面**，即 UI 与协议 handler 的唯一入口）──

async function makeSquad(f: Fixture) {
  const leader = await f.service.createTeamAgent(f.target, {
    name: "队长",
    systemPrompt: "协调",
    memoryScope: "project",
  });
  const memberA = await f.service.createTeamAgent(f.target, {
    name: "甲",
    systemPrompt: "干活",
    memoryScope: "project",
  });
  const memberB = await f.service.createTeamAgent(f.target, {
    name: "乙",
    systemPrompt: "干活",
    memoryScope: "project",
  });
  const squad = await f.service.createSquad(f.target, {
    name: "网关组",
    leaderAgentId: leader.id,
    members: [memberA.id, memberB.id],
    instructions: { stopCondition: "全部 done", maxRounds: "5" },
  });
  return { squad, leader, memberA, memberB };
}

function createItem(
  runtime: SquadRuntime,
  f: Fixture,
  input: { id: string; title: string; parentId?: string; assignee: WorkItem["assignee"] },
): WorkItem {
  return runtime.workItemService.create({
    id: input.id,
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: input.title,
    parentId: input.parentId,
    assignee: input.assignee,
  });
}

function itemStatus(runtime: SquadRuntime, id: string): string {
  const item = runtime.workItemRepo.get(id);
  assert.ok(item, `工作项 ${id} 应当存在`);
  return item.status;
}

async function readRunStatus(f: Fixture, runId: string): Promise<string> {
  const runtime = await f.runtime();
  const record = runtime.squadRunRepo.get(runId);
  assert.ok(record, `run ${runId} 应当存在`);
  return record.status;
}

async function branchExists(f: Fixture, branch: string): Promise<boolean> {
  const runtime = await f.runtime();
  return (
    (await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: f.repoRoot }))
      .code === 0
  );
}

async function mainSha(f: Fixture): Promise<string> {
  return (await gitAt(f.repoRoot)(["rev-parse", "main"])).stdout.trim();
}

async function readMainFile(f: Fixture, file: string): Promise<string> {
  const result = await gitAt(f.repoRoot)(["show", `main:${file}`]);
  assert.equal(result.code, 0, `main:${file} 应当存在: ${result.stderr}`);
  return result.stdout;
}

/** 集成分支 / 队员分支 / 目录名都从**生产实现的命名来源**取，测试里不重算命名规则。 */
function planOf(workItemId: string, agentId: string) {
  return planBranches({ workItemSlug: slugForId(workItemId), agentSlug: slugForId(agentId) });
}

/** 队员：开树 → 在树里提交一个文件 → 上报完成（run produced、子项按机械半的 CAS 结果推进）。 */
async function produce(
  f: Fixture,
  input: { runId: string; childId: string; parentId: string; agentId: string; file: string; content: string },
): Promise<{ branch: string; worktreePath: string }> {
  const opened = await f.service.openMemberRun(f.target, {
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
  await f.service.completeMemberRun(f.target, { runId: input.runId });
  return opened;
}

function parentStatusEvents(f: Fixture, parentId: string): WorkItemEvent[] {
  return f.events.filter((e) => e.kind === "workitem.status_changed" && e.id === parentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 上篇：逆推闭环六步，逐步落到「必须为真什么」的实体状态断言
// ═══════════════════════════════════════════════════════════════════════════════

// 步骤 ①+②：建小队（定义落盘）→ 建工作项（指派给小队）→ 指派给队员只**发派发事件**、不直接开 run。
test("闭环S1+S2：建小队落盘、建项指派给小队、指派只发派发事件而不开 run", async () => {
  const f = await setup();
  const { squad, leader, memberA } = await makeSquad(f);
  const runtime = await f.runtime();

  // ① 小队定义落到 <ws>/.zcode/squad/squads（读磁盘目录），成员含队长。
  const squadsDir = join(f.repoRoot, ".zcode", "squad", "squads");
  assert.deepEqual(readdirSync(squadsDir), [`${squad.id}.json`], "小队定义必须落盘到命名空间目录");
  assert.equal(
    squad.members[0]?.agentId,
    leader.id,
    "队长必须被并入 members 且置于首位",
  );
  assert.equal(squad.members[0]?.role, "leader");
  // getSnapshot 能读到（UI 的唯一取数口）。
  const snapshot = await f.service.getSnapshot(f.target);
  assert.ok(snapshot.squads.some((s) => s.id === squad.id), "getSnapshot 必须能读到小队");
  assert.equal(snapshot.enabled, true);

  // ② 建父项（指派给**小队**）+ 子项；形状正确。
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  assert.equal(itemStatus(runtime, child.id), "todo");

  // ② 指派 = 改负责人（读库）+ 发派发事件（经唯一出口 + 常驻 hub），**不直接开 run**。
  const rowsBefore = runtime.squadRunRepo.listByParent(parent.id).length;
  const result = await f.service.assignWorkItem(f.target, { workItemId: child.id, agentId: memberA.id });
  assert.deepEqual(result, { assigned: true });
  const reread = (await f.runtime()).workItemRepo.get(child.id);
  assert.deepEqual(
    reread?.assignee,
    { type: "agent", id: memberA.id },
    "指派必须改负责人（读库，不是读返回值）",
  );
  assert.equal(f.dispatched.length, 1, "指派必须经常驻 hub 恰好发出一条派发请求");
  assert.deepEqual(f.dispatched[0], {
    workItemId: child.id,
    agentId: memberA.id,
    workspacePath: f.repoRoot,
    workspaceIdentity: WS,
  });
  assert.ok(
    f.events.some((e) => e.kind === "workitem.dispatch_requested" && e.workItemId === child.id),
    "派发请求必须经唯一事件出口发出",
  );
  // 关键：指派**不直接开 run**（台账行、工作树都不出现）。
  const after = await f.runtime();
  assert.equal(
    after.squadRunRepo.listByParent(parent.id).length,
    rowsBefore,
    "指派本身不得产生任何 run 台账行",
  );
  assert.deepEqual(await after.worktreeManager.list(), [], "指派本身不得建任何工作树");
});

// 步骤 ③：每个队员 run **各自一条分支**、各自一棵工作树；两条分支不得相同。
test("闭环S3：两名队员各开一条分支/一棵工作树，分支名互不相同", async () => {
  const f = await setup();
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });

  const open = async (runId: string, agentId: string) =>
    f.service.openMemberRun(f.target, {
      runId,
      workItemId: child.id,
      parentWorkItemId: parent.id,
      agentId,
      isLeaderTask: false,
    });
  const a = await open("r-a", memberA.id);
  const b = await open("r-b", memberB.id);

  // 分支命名 = squad/member/<workItemSlug>/<agentSlug>，两条分支不同。
  assert.equal(a.branch, planOf(child.id, memberA.id).member);
  assert.equal(b.branch, planOf(child.id, memberB.id).member);
  assert.notEqual(a.branch, b.branch, "同一分支禁止两树检出（git 会拒），故两条必须不同");
  assert.ok((await branchExists(f, a.branch)) && (await branchExists(f, b.branch)));

  // 工作树落在 <repoRoot>/.worktree/<扁平名>，且目录真实存在。
  const root = resolveWorktreeRoot(await canonicalPath(f.repoRoot));
  assert.equal(a.worktreePath, join(root, memberDirName(planOf(child.id, memberA.id))));
  assert.equal(b.worktreePath, join(root, memberDirName(planOf(child.id, memberB.id))));
  assert.ok(existsSync(a.worktreePath) && existsSync(b.worktreePath), "两棵工作树目录都必须在磁盘上");
  assert.equal(
    basename(a.worktreePath),
    `${slugForId(child.id)}-${slugForId(memberA.id)}`,
    "目录名必须是**扁平**的 <workItemSlug>-<agentSlug>（单层，.worktree/ 只放一层）",
  );
  // 台账两条、各绑自己的分支。
  const runRecords = (await f.runtime()).squadRunRepo.listByParent(parent.id);
  assert.deepEqual(
    runRecords.map((r) => r.branch).sort(),
    [a.branch, b.branch].sort(),
  );
});

// 步骤 ④：审查通过 ⇒ 队员分支合进**集成分支**、主分支一个字节不动、子项 → done；打回 ⇒ 树存活、台账不推进。
test("闭环S4：审查通过只合集成分支（主分支不动）且子项 done；打回则树存活、台账不推进", async () => {
  const f = await setup();
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  // c1 由两名队员产出；c2 保持非终态 ⇒ 批不齐，收尾不会触发（把「只合集成分支」这一瞬钉住）。
  const c1 = createItem(runtime, f, {
    id: "wi-c1",
    title: "子一",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  createItem(runtime, f, {
    id: "wi-c2",
    title: "子二",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(c1.id, "in_progress", "todo");
  runtime.workItemService.transition("wi-c2", "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: c1.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  void a; // 只用来建成果；集成/主分支断言走上面算出的 integration。
  const b = await produce(f, {
    runId: "r-b",
    childId: c1.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  const shaBefore = await mainSha(f);
  const integration = planOf(c1.id, memberA.id).integration;

  // —— approved：合进集成分支 ——
  const outcome = await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });
  assert.deepEqual(outcome, { ok: true, merged: true });
  assert.equal(await readRunStatus(f, "r-a"), "merged");
  assert.equal(await branchExists(f, integration), true, "队员分支必须合进集成分支");
  assert.equal(
    (await gitAt(f.repoRoot)(["show", `${integration}:a.txt`])).stdout,
    "A\n",
    "成果落在集成分支上",
  );
  assert.equal(await mainSha(f), shaBefore, "主分支在整批通过前一个字节都不许动");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "成果不许提前出现在主分支");
  // ④ 子项 → done（读库；这是 children_done 的唯一触发条件）。
  assert.equal(itemStatus(runtime, c1.id), "done", "审查通过 ⇒ 该子工作项推进到终态");
  assert.equal(itemStatus(runtime, "wi-c2"), "in_progress", "第二个子项未终态 ⇒ 批不齐");
  // 批不齐 ⇒ 不收尾、主分支不动。
  await f.drain();
  assert.deepEqual(f.chainErrors, []);
  assert.equal(itemStatus(runtime, parent.id), "todo", "子项没全终态 ⇒ 父项不动");

  // —— rejected：工作树存活、台账停在 rejected（不推进到 merged/discarded）——
  const rejectedOutcome = await f.service.reviewMemberRun(f.target, { runId: "r-b", verdict: "rejected" });
  assert.deepEqual(rejectedOutcome, { ok: true, merged: false, kept: true });
  assert.equal(await readRunStatus(f, "r-b"), "rejected");
  assert.equal(await branchExists(f, b.branch), true, "打回待修的分支必须存活到合并");
  assert.ok(existsSync(b.worktreePath), "打回待修的工作树目录必须存活（不得提前删）");
  assert.equal(
    (await gitAt(f.repoRoot)(["cat-file", "-e", `main:b.txt`])).code !== 0,
    true,
    "被打回的成果不得进主分支",
  );
  assert.equal(await mainSha(f), shaBefore, "打回后主分支依旧一个字节不动");
});

// 步骤 ⑤+⑥：子项全终态 ⇒ 批次收尾把集成分支合回主分支、父项 done；抛弃把队员/集成两条分支与工作树都收干净，
// 且**同一分支可以重新 add**（证明清理是重派发的正确性前置）。
test("闭环S5+S6：批次收尾合回主分支（父项 done）→ 抛弃干净 → 同一分支可重新 add", async () => {
  const f = await setup();
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2)); // createdAt 递增 ⇒ 串行次序确定
  const b = await produce(f, {
    runId: "r-b",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  const shaBefore = await mainSha(f);
  const integration = planOf(child.id, memberA.id).integration;

  // 审第一个：子项终态 ⇒ children_done ⇒ 事件驱动批次收尾（合第二个、finalize、抛弃、父项 done）。
  await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });
  await f.drain();
  assert.deepEqual(f.chainErrors, [], "批次收尾链不得抛");

  // ⑤ 批次收尾：整批成果合回主分支，父项 done。
  assert.notEqual(await mainSha(f), shaBefore, "批次收尾后主分支才前进");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await readMainFile(f, "b.txt"), "B\n");
  assert.equal(itemStatus(runtime, parent.id), "done", "父项确实 done（读库）");
  assert.deepEqual(parentStatusEvents(f, parent.id), [
    { kind: "workitem.status_changed", id: parent.id, from: "todo", to: "in_review" },
    { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "done" },
  ]);

  // ⑥ 抛弃：队员分支与集成分支都被删、工作树目录消失。
  assert.equal(await readRunStatus(f, "r-a"), "discarded");
  assert.equal(await readRunStatus(f, "r-b"), "discarded");
  for (const branch of [a.branch, b.branch, integration]) {
    assert.equal(await branchExists(f, branch), false, `${branch} 合并后必须删掉`);
  }
  assert.equal(existsSync(a.worktreePath), false, "抛弃后工作树目录必须消失");
  assert.equal(existsSync(b.worktreePath), false);
  assert.deepEqual((await runtime.worktreeManager.list()).filter((e) => e.branch !== null), []);

  // ⑥ 清理是正确性前置：同一 (workItem, agent) 的分支名可**重新 add**（清理不彻底时这里会撞「分支已存在」）。
  const reopened = await f.service.openMemberRun(f.target, {
    runId: "r-a2",
    workItemId: child.id,
    parentWorkItemId: parent.id,
    agentId: memberA.id,
    isLeaderTask: false,
  });
  assert.equal(reopened.branch, a.branch, "重新派发复用同一分支名");
  assert.ok((await branchExists(f, reopened.branch)) && existsSync(reopened.worktreePath));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 下篇：穷举 A–F，逐格给结论
// ═══════════════════════════════════════════════════════════════════════════════

// A：`rejected` 单独一格 —— 不建集成分支、不推进子项、树与分支存活、主分支不动。
test("A. 审查判定=rejected：不建集成分支、子项不终态、树/分支存活", async () => {
  const f = await setup();
  const { squad, memberA } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  const shaBefore = await mainSha(f);

  const outcome = await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "rejected" });

  assert.deepEqual(outcome, { ok: true, merged: false, kept: true });
  assert.equal(await readRunStatus(f, "r-a"), "rejected", "台账不推进（停在 rejected）");
  assert.equal(await branchExists(f, planOf(child.id, memberA.id).integration), false, "打回不建集成分支");
  assert.equal(itemStatus(runtime, child.id), "in_review", "被打回的子项不进终态");
  assert.equal(await branchExists(f, a.branch), true);
  assert.ok(existsSync(a.worktreePath));
  assert.equal(await mainSha(f), shaBefore);
  await f.drain();
  assert.deepEqual(parentStatusEvents(f, parent.id), [], "父项不动");
});

// B：内容冲突（两名队员改同一文件同一行）⇒ 父项 blocked、集成分支不留半合并状态、台账不推进、事件确实发出。
test("B. 内容冲突：父项 blocked + status_changed{to:blocked} 事件 + 集成分支无半合并 + 主分支不动", async () => {
  // 关掉事件转发：改用服务的 `replayUnfinalizedBatches` 驱动同一批（等价重驱），
  // 这样能确定性地考察「冲突时的处置」，而不是与事件驱动的时序赛跑。
  const f = await setup({ forwardChildCompleted: false });
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  // 同一文件同一行、内容不同 ⇒ 第二个合并必冲突。
  await produce(f, {
    runId: "r-a",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await produce(f, {
    runId: "r-b",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "a.txt",
    content: "B\n",
  });
  runtime.workItemService.transition(child.id, "done", "in_review");
  const shaBefore = await mainSha(f);
  const integration = planOf(child.id, memberA.id).integration;

  const replay = await f.service.replayUnfinalizedBatches(f.target);

  assert.deepEqual(replay.failures, [], "冲突是处置而不是恢复失败");
  assert.deepEqual(replay.replayed, [parent.id]);
  // 父项 blocked，且那条变迁**确实**经唯一事件出口发出（P2b 的 Inbox 信号）。
  assert.equal(itemStatus(runtime, parent.id), "blocked");
  assert.deepEqual(parentStatusEvents(f, parent.id), [
    { kind: "workitem.status_changed", id: parent.id, from: "todo", to: "in_review" },
    { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "blocked" },
  ]);
  // 集成分支保留既成成果、且**没有半合并状态**（MERGE_HEAD 不存在、主工作树干净、内容只有首个队员）。
  assert.equal(await branchExists(f, integration), true);
  assert.equal(
    (await gitAt(f.repoRoot)(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code !== 0,
    true,
    "冲突后不得留下 MERGE_HEAD（半合并状态）",
  );
  assert.equal(
    (await gitAt(f.repoRoot)(["ls-files", "-u"])).stdout,
    "",
    "冲突后索引里不得留任何未合并条目（半合并状态）",
  );
  assert.equal((await gitAt(f.repoRoot)(["show", `${integration}:a.txt`])).stdout, "A\n");
  // 台账不推进：冲突队员停在 produced，主分支一个字节不动。
  assert.equal(await readRunStatus(f, "r-b"), "produced", "冲突队员保持 produced（等人处理）");
  assert.equal(await readRunStatus(f, "r-a"), "merged");
  assert.equal(await mainSha(f), shaBefore, "整批没通过 ⇒ 主分支一个字节不动");
  assert.equal(await readMainFile(f, "a.txt"), "1\n");
});

// C：run 生命周期 —— produced / merged 已在上面覆盖；这里补**失败 run 必须离开活跃集、其工作树可被回收**。
test("C. 失败 run（failMemberRun）：离开活跃集、工作树与分支可被回收；produced 不许当失败丢弃", async () => {
  const f = await setup();
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  // r-open 从未产出；r-prod 已产出（不许当失败丢弃）。
  const openRun = await f.service.openMemberRun(f.target, {
    runId: "r-open",
    workItemId: child.id,
    parentWorkItemId: parent.id,
    agentId: memberA.id,
    isLeaderTask: false,
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  await produce(f, {
    runId: "r-prod",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });

  // produced 不许按失败处置（会丢掉队员的活）。
  await assert.rejects(
    f.service.failMemberRun(f.target, { runId: "r-prod", reason: "误判" }),
    /produced/,
  );

  await f.service.failMemberRun(f.target, { runId: "r-open", reason: "会话崩溃" });
  assert.equal(await readRunStatus(f, "r-open"), "discarded");
  // 离开活跃集：`activeBranches` 的唯一口径是 listActive（不含 discarded）。
  const active = (await f.runtime()).squadRunRepo.listActive(WS).map((r) => r.runId);
  assert.equal(active.includes("r-open"), false, "失败 run 必须离开活跃集");

  // 工作树与分支可被回收（启动回收器按「不在活跃集」收）。
  const reaped = await f.service.reapStartupOrphans(f.target);
  assert.ok(reaped.reclaimedBranches.includes(openRun.branch), "失败 run 的分支必须被回收");
  assert.equal(await branchExists(f, openRun.branch), false);
  assert.equal(existsSync(openRun.worktreePath), false, "失败 run 的工作树必须被回收");
  // 而已产出的队员（活跃）原封不动。
  assert.equal(await branchExists(f, planOf(child.id, memberB.id).member), true);
});

// D：回收器 × 命名空间 —— 非小队命名空间的工作树（feat/dev-sandbox）原封不动；
// 集成分支不得被回收；未合并（produced / rejected）的队员分支不得被回收；真正的孤儿才被回收。
test("D. 回收器按命名空间限域：dev-sandbox 与集成分支不动，未合并队员分支存活，孤儿被收", async () => {
  const f = await setup();
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });

  // ① 非小队命名空间的工作树（用户自己在 `.worktree/` 下挂的）：必须原封不动。
  const sandboxPath = join(f.repoRoot, ".worktree", "dev-sandbox");
  const add = await gitAt(f.repoRoot)([
    "worktree",
    "add",
    "-b",
    "feat/dev-sandbox",
    sandboxPath,
    "main",
  ]);
  assert.equal(add.code, 0, add.stderr);

  // ② 未合并（produced）与被打回（rejected）的队员：都必须存活。
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  const produced = await produce(f, {
    runId: "r-prod",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  const rejected = await produce(f, {
    runId: "r-rej",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  await f.service.reviewMemberRun(f.target, { runId: "r-rej", verdict: "rejected" });

  // ③ 集成分支（未合回主分支的整批成果）：必须存活。
  const integration = planOf(child.id, memberA.id).integration;
  assert.equal((await gitAt(f.repoRoot)(["branch", integration, "main"])).code, 0);

  const reaped = await f.service.reapStartupOrphans(f.target);

  // 非小队命名空间的工作树：目录与分支都还在，且被记进 `kept`（看见了、但一个字节不动）。
  assert.ok(existsSync(sandboxPath), "非小队工作树目录不得被动");
  assert.equal(
    (await gitAt(f.repoRoot)(["rev-parse", "-q", "--verify", "refs/heads/feat/dev-sandbox"])).code,
    0,
    "非小队分支不得被删",
  );
  assert.ok(reaped.kept.includes("dev-sandbox"), "非小队工作树必须可见（kept），不得静默");
  assert.equal(reaped.reclaimed.includes("dev-sandbox"), false);
  assert.equal(reaped.foreign.includes(sandboxPath), false, "它在我们目录里，只是不归我们管");
  // 集成分支不得被回收（由 discardIntegration 在整批合回后才删）。
  assert.ok(await branchExists(f, integration), "集成分支不得被回收器删掉");
  // 未合并 / 被打回的队员：树与分支都存活。
  for (const run of [produced, rejected]) {
    assert.ok(await branchExists(f, run.branch), `${run.branch} 不得被回收（未合并）`);
    assert.ok(existsSync(run.worktreePath), "未合并的工作树目录不得被回收");
  }
  // 同时证明回收器**真的在工作**：造一条残枝（有分支、无工作树）⇒ 被回收。
  const orphanBranch = "squad/member/orphan/orphan";
  assert.equal((await gitAt(f.repoRoot)(["branch", orphanBranch, "main"])).code, 0);
  const reaped2 = await f.service.reapStartupOrphans(f.target);
  assert.ok(reaped2.reclaimedBranches.includes(orphanBranch), "残枝必须被回收（清理是重派发前置）");
  assert.equal(await branchExists(f, orphanBranch), false);
});

// E：崩溃窗口 —— 子项全终态但批次未 finalize 的启动态，重驱后必须真的收尾；重复重驱幂等。
test("E. 崩溃窗口：replayUnfinalizedBatches 收尾（父项 done、集成合回主分支），重复重驱幂等", async () => {
  // 关掉事件转发 = 模拟「进程在 finalize 之前死掉」：那时没有任何订阅者会重放 `child_completed`。
  const f = await setup({ forwardChildCompleted: false });
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  const b = await produce(f, {
    runId: "r-b",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  const integration = planOf(child.id, memberA.id).integration;
  // 逐个审查通过（子项 ⇒ done、队员 ⇒ merged 进集成分支），但**没人跑批次收尾** ⇒ 崩溃窗口态。
  await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });
  await f.service.reviewMemberRun(f.target, { runId: "r-b", verdict: "approved" });
  assert.equal(itemStatus(runtime, child.id), "done");
  assert.equal(itemStatus(runtime, parent.id), "todo", "崩溃窗口态：父项尚未被推进");
  assert.equal(await branchExists(f, integration), true, "集成分支上躺着整批成果");
  assert.equal(await readMainFile(f, "a.txt"), "1\n", "成果还没合回主分支");

  // 启动重驱：对「子项全终态、但该批尚未 finalize」的父项再跑一次收尾。
  const first = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.replayed, [parent.id]);
  assert.equal(itemStatus(runtime, parent.id), "done", "重驱后父项确实 done（读库）");
  assert.equal(await readMainFile(f, "a.txt"), "A\n");
  assert.equal(await readMainFile(f, "b.txt"), "B\n");
  assert.equal(await readRunStatus(f, "r-a"), "discarded");
  assert.equal(await readRunStatus(f, "r-b"), "discarded");
  for (const branch of [a.branch, b.branch, integration]) {
    assert.equal(await branchExists(f, branch), false, `${branch} 收尾后必须删掉`);
  }
  assert.equal(existsSync(a.worktreePath), false);

  // 幂等：重复重驱不得重复合并（父项已终态 ⇒ 直接跳过，不动 git）。sha 必须逐字节相同。
  const shaAfterFirst = await mainSha(f);
  const second = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(second.replayed, [], "已结算的批不再被重驱");
  assert.deepEqual(second.failures, []);
  assert.equal(await mainSha(f), shaAfterFirst, "重复重驱不得再动主分支（幂等）");
  assert.equal(itemStatus(runtime, parent.id), "done");
});

// F：边界 —— 空批（无队员）收口为 done；`activeBranches` 由 listActive() 派生（禁止用「有没有在跑的 run」）。
test("F. 空批（无队员）⇒ 父项收口 done；activeBranches 严格由 listActive 派生", async () => {
  // 空批：唯一子项在派单前被取消 ⇒ 无任何队员 run，批没有可落地的成果，父项按「批已结算」收口 done。
  const f = await setup();
  const { squad } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  createItem(runtime, f, {
    id: "wi-c",
    title: "派单前被取消的子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  const shaBefore = await mainSha(f);

  // 取消唯一子项 ⇒ 子项全终态 ⇒ 经唯一事件出口发 child_completed ⇒ 批次收尾。
  runtime.workItemService.transition("wi-c", "cancelled", "todo");
  await f.drain();

  assert.equal(itemStatus(runtime, parent.id), "done", "空批按「批已结算」收口（读库）");
  assert.deepEqual((await runtime.worktreeManager.list()).filter((e) => e.branch !== null), []);
  assert.equal(await mainSha(f), shaBefore, "空批不动主分支");

  // activeBranches 的唯一口径 = listActive（含 open / produced / rejected，**不含** merged / discarded）。
  const f2 = await setup();
  const { squad: squad2, memberA, memberB } = await makeSquad(f2);
  const rt = await f2.runtime();
  const p2 = createItem(rt, f2, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad2.id },
  });
  createItem(rt, f2, {
    id: "wi-c",
    title: "子任务",
    parentId: p2.id,
    assignee: { type: "squad", id: squad2.id },
  });
  rt.workItemService.transition("wi-c", "in_progress", "todo");
  const openRun = await f2.service.openMemberRun(f2.target, {
    runId: "r-open",
    workItemId: "wi-c",
    parentWorkItemId: p2.id,
    agentId: memberA.id,
    isLeaderTask: false,
  });
  await produce(f2, {
    runId: "r-prod",
    childId: "wi-c",
    parentId: p2.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  // 把 r-prod 打成 rejected（走审查打回），于是活跃集里同时有 open / rejected。
  await f2.service.reviewMemberRun(f2.target, { runId: "r-prod", verdict: "rejected" });

  const activeOf = async () =>
    (await f2.runtime()).squadRunRepo
      .listActive(WS)
      .map((r) => r.branch)
      .filter((branch): branch is string => branch !== null && branch !== "");
  const derived = await activeOf();
  const computed = await (await f2.runtime()).lifecycle.computeActiveBranches(WS);
  assert.deepEqual([...computed].sort(), [...derived].sort(), "activeBranches 必须严格由 listActive 派生");
  assert.ok(computed.includes(openRun.branch), "open 的分支在活跃集里");
  assert.ok(
    computed.includes(planOf("wi-c", memberB.id).member),
    "rejected 的分支同样在活跃集里（口径是台账，不是「有没有在跑的 run」）",
  );

  // 反证：把 open 的那条按失败丢弃 ⇒ 它**随即**离开活跃集（口径随台账，不随「在不在跑」）。
  await f2.service.failMemberRun(f2.target, { runId: "r-open", reason: "会话崩溃" });
  const afterFail = await activeOf();
  assert.equal(afterFail.includes(openRun.branch), false, "失败 run 的分支必须离开活跃集");
  assert.ok(
    afterFail.includes(planOf("wi-c", memberB.id).member),
    "其它活跃 run 不受影响（口径是逐条的台账状态）",
  );
  assert.equal(afterFail.length, 1, "丢弃一条后活跃集只剩另一条");
});

// C 的补格：failMemberRun 只接受 open（rejected 不许当失败丢弃）—— 与上一条同源纪律的显式断言。
test("C'. failMemberRun 只接受 open：rejected / produced 一律响亮拒绝", async () => {
  const f = await setup();
  const { squad, memberA } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition("wi-c", "in_progress", "todo");
  await produce(f, {
    runId: "r-prod",
    childId: "wi-c",
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  await f.service.reviewMemberRun(f.target, { runId: "r-prod", verdict: "rejected" });

  await assert.rejects(
    f.service.failMemberRun(f.target, { runId: "r-prod", reason: "不该" }),
    /rejected/,
    "rejected 说明产出被判待修，当失败丢弃会丢掉队员的活",
  );
  await assert.rejects(f.service.failMemberRun(f.target, { runId: "nope", reason: "x" }), /nope/);
  await assert.rejects(f.service.failMemberRun(f.target, { runId: "r-prod", reason: "  " }), /原因/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 逆推里「必须为真」但**实测不成立**的两格（如实报，比「通过」更值钱）
// ═══════════════════════════════════════════════════════════════════════════════

// 缺陷 1（崩溃窗口对**空批**不覆盖）：`replayUnfinalizedBatches` 的枚举判据是「台账里有本批的 run 行」
// （`squadRuntimeService.ts:430`，刻意的取舍：否则会把普通父项也当批收口）。于是「空批（无队员 run）」
// 在**没有事件驱动**的启动态下**不会被重驱** —— 若进程死在「取消唯一子项」与「child_completed 转发器
// 跑完」之间，重启后父项永远停在 todo，且没有任何路径会再收它。
test("缺陷1. 空批 + 崩溃窗口：replayUnfinalizedBatches 不重驱（无 run 台账行）⇒ 父项滞留 todo", async () => {
  const f = await setup({ forwardChildCompleted: false });
  const { squad } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  createItem(runtime, f, {
    id: "wi-c",
    title: "空批子项",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  // 唯一子项被取消（子项全终态），但没有事件驱动在本进程里跑（模拟崩溃窗口）。
  runtime.workItemService.transition("wi-c", "cancelled", "todo");

  const replay = await f.service.replayUnfinalizedBatches(f.target);

  // 事实（缺陷证据）：重驱**看不见**这个空批 —— 无 run 台账行 ⇒ 直接跳过。
  assert.deepEqual(replay.replayed, [], "无 run 台账行的空批不在重驱视野内");
  assert.deepEqual(replay.failures, []);
  assert.equal(
    itemStatus(runtime, parent.id),
    "todo",
    "缺陷：空批在崩溃窗口下滞留 todo，没有任何恢复路径会收它（结论如实记录，不放宽实现）",
  );
});

// 缺陷 2（「整批放弃」未接线）：spec 的「抛弃」含**用户显式取消整批**这条语义，实体是
// `SquadBatchOrchestrator.discardBatch`（`squadOrchestrator.ts:388`）。但全仓**没有任何生产调用方**：
// 它既不在 `ISquadRuntimeService` 上（服务面不可达），也不在 host / 协议 handler 里（grep 只命中测试）。
// 故用户目前**无法**放弃一个还没合并的批（被打回/已产出但整批不要了）—— 只有「合并后自动抛弃」可达。
// 本用例给出两条证据：① 结构证据（服务面没有这个方法）；② 机制证据（经真实编排器调用它是成立的）。
test("缺陷2. 整批放弃机制成立，但未接到服务面/组合根（无生产调用方）", async () => {
  const f = await setup({ forwardChildCompleted: false });
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const child = createItem(runtime, f, {
    id: "wi-c",
    title: "子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(child.id, "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: child.id,
    parentId: parent.id,
    agentId: memberA.id,
    file: "a.txt",
    content: "A\n",
  });
  const b = await produce(f, {
    runId: "r-b",
    childId: child.id,
    parentId: parent.id,
    agentId: memberB.id,
    file: "b.txt",
    content: "B\n",
  });
  await f.service.reviewMemberRun(f.target, { runId: "r-b", verdict: "rejected" });
  const shaBefore = await mainSha(f);

  // ① 结构证据：服务面（UI 与协议 handler 的唯一入口）不暴露 discardBatch。
  assert.equal("discardBatch" in f.service, false, "ISquadRuntimeService 不暴露 discardBatch");

  // ② 机制证据：经**真实编排器**调用它是成立的（语义没坏，只是没接线）。
  const orchestrator = createSquadOrchestrator({ runtime: await f.runtime() });
  await orchestrator.discardBatch({ workspaceKey: WS, parentWorkItemId: parent.id });
  assert.equal(itemStatus(runtime, parent.id), "cancelled");
  assert.equal(await readRunStatus(f, "r-a"), "discarded");
  assert.equal(await readRunStatus(f, "r-b"), "discarded");
  assert.equal(await branchExists(f, a.branch), false, "整批放弃 ⇒ 队员分支（含 produced / rejected）都删");
  assert.equal(await branchExists(f, b.branch), false);
  assert.equal(existsSync(a.worktreePath), false);
  assert.ok((await branchExists(f, planOf(child.id, memberA.id).integration)) === false, "集成分支也不留");
  assert.equal(await mainSha(f), shaBefore, "整批放弃 ⇒ 主分支一个字节都没动过");
});
