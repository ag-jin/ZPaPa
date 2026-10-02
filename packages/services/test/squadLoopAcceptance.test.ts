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
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { slugForId } from "../src/workitem/slug.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import {
  declaredRunClassFor,
  planDispatch,
  type RunClass,
} from "../src/workitem/leaderDispatch.js";
import { hasInProgressLeaderRun } from "../src/workitem/squadRunLifecycle.js";
/* 派发桥的**台账动作查表**（host 侧唯一实现）：验收要断言的正是「哪一类该开树 / 该登记 / 什么都不做」。
   这里**直接调生产实现**而不是在本文件重抄一份 switch —— 抄一份就等于给判据造了第二个定义，
   改了 desktop 那边忘了这里不会有任何编译错，而这正是本次要消灭的「两类 run 长得一样」形态。
   跨包 import 只发生在本测试文件里（`packages/services/src` 不依赖 desktop，架构检查只扫 src 根），
   而 `squadDispatch.ts` 是纯模块（只 import 类型与 `@zcode/services`），无模块级副作用（已实测）。 */
import {
  ledgerActionForRunClass,
  type SquadLedgerAction,
} from "../../desktop/src/host/squadDispatch.js";
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
  /** 派发桥（host `runSquadDispatch` 决策段的最小同形副本）：类别分流与台账动作逐条留痕。 */
  bridge: {
    records: BridgeRecord[];
    /** 常驻侧执行体的异常（响亮拒绝那一格必须非空）。 */
    failures: unknown[];
    /** 直接驱动一次派发（= 调度器那条入口，与人发起入口共用同一个决策段）。 */
    dispatch: (workItemId: string, agentId?: string) => Promise<void>;
  };
  /** 把常驻侧（hub 订阅）那条异步链跑到落定。 */
  drainBridge: () => Promise<void>;
};

/** 派发桥一次决策的留痕：**类别**（`planDispatch` 的结论）与**台账动作**（谁开树 / 谁登记 / 谁不动）。 */
type BridgeRecord = {
  workItemId: string;
  agentId: string;
  runClass: RunClass;
  ledgerAction: SquadLedgerAction;
  runId: string;
};

/**
 * 派发桥的**决策段**（host `runSquadDispatch` 的最小同形副本，与 `squadAssignDispatch.test.ts` 同款）。
 *
 * 为什么验收要自带这一段：Wave 3 之后新增的「三类分流」发生在 host 派发桥里
 * （`packages/desktop/src/host/index.ts` 的 `runSquadDispatch`），而它所在模块有模块级副作用
 * （`process.title` / repo 构造 / 定时器），import 会让测试进程不结束（仓内已实测）。
 * 故只搬**决策段**：本函数不自己判类别（交给 `planDispatch` + `declaredRunClassFor`），
 * 也不自己决定台账动作（交给生产函数 `ledgerActionForRunClass`）—— 两条判据都仍只有生产实现那一份。
 *
 * 台账动作与 `runSquadDispatch` 逐格同形：
 *   · `open_member_run` ⇒ `openMemberRun`（开树 + 登记台账）；
 *   · `record_leader_run` ⇒ `recordLeaderRun`（**只登记**，不开树）；
 *   · `none`（单独安排）⇒ **什么都不做**，但**不是跳过派发** —— 会话照发（落在目标工作区）。
 */
async function runBridgeDispatch(
  service: ISquadRuntimeService,
  target: SquadWorkspaceTarget,
  request: SquadDispatchRequest,
  records: BridgeRecord[],
): Promise<void> {
  const snapshot = await service.getSnapshot(target);
  const item = snapshot.workItems.find((candidate) => candidate.id === request.workItemId);
  if (!item) throw new Error(`工作项不存在：${request.workItemId}`);
  const squad =
    item.assignee.type === "squad"
      ? (snapshot.squads.find((candidate) => candidate.id === item.assignee.id) ?? null)
      : null;
  // 派发时的**事实**（父项）：查不到（归档 / 删除 / 跨 workspace）就是 null —— 与 host 派发桥同源。
  const parent = item.parentId
    ? (snapshot.workItems.find((candidate) => candidate.id === item.parentId) ?? null)
    : null;
  const declared =
    item.assignee.type === "agent"
      ? declaredRunClassFor({ parentId: item.parentId, parent })
      : undefined;
  const events = planDispatch({
    workItem: item,
    squad,
    parentWorkItem: parent,
    ...(declared !== undefined ? { runClass: declared } : {}),
    trigger: "user",
  });
  const enqueued = events.find((event) => event.kind === "run.enqueued");
  if (enqueued?.kind !== "run.enqueued") return; // inbox.notified（指派给人 / 小队不可用）不是失败
  const kind = enqueued.runClass;
  const ledgerAction = ledgerActionForRunClass(kind);
  /* runId 取稳定量（生产取幂等键 `eventKey`）：同一 (工作项, 智能体) 的重复派发会撞台账主键 —— 与生产同形。 */
  const runId = `bridge-${item.id}-${enqueued.agentId}`;
  records.push({
    workItemId: item.id,
    agentId: enqueued.agentId,
    runClass: kind,
    ledgerAction,
    runId,
  });
  if (ledgerAction === "open_member_run") {
    await service.openMemberRun(target, {
      runId,
      workItemId: item.id,
      parentWorkItemId: item.parentId ?? item.id,
      agentId: enqueued.agentId,
      isLeaderTask: false,
    });
  } else if (ledgerAction === "record_leader_run") {
    await service.recordLeaderRun(target, {
      runId,
      workItemId: item.id,
      parentWorkItemId: item.parentId ?? item.id,
      agentId: enqueued.agentId,
    });
  }
}

/**
 * 装配与组合根同形。
 *
 * `forwardChildCompleted` 默认开（= node.ts 的 `forwardSquadChildCompleted`）：
 * 没有它，「子项终态 ⇒ children_done ⇒ 批次收尾」这条链**断在接线处**，闭环不成立。
 * 崩溃窗口用例（E）刻意关掉它：那样构造出的正是「子项全终态但批次未 finalize 的启动态」。
 */
async function setup(
  options: { forwardChildCompleted?: boolean; residentBridge?: boolean } = {},
): Promise<Harness> {
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

  /* 派发桥的最小同形副本：`dispatch` 直接驱动一次（= 调度器那条入口）；`residentBridge` 打开时
     hub 上的每条派发请求（= 人发起那条入口，经服务面 `assignWorkItem` 发出）也转给它。
     两条入口汇进同一段决策 —— 与生产 `runSquadDispatch` 的两路入口同形。 */
  const bridgeRecords: BridgeRecord[] = [];
  const bridgeFailures: unknown[] = [];
  const bridgeChain: Promise<void>[] = [];
  const bridge: Harness["bridge"] = {
    records: bridgeRecords,
    failures: bridgeFailures,
    dispatch: async (workItemId, agentId = "") => {
      await runBridgeDispatch(
        service,
        target,
        { workItemId, agentId, workspacePath: repoRoot, workspaceIdentity: WS },
        bridgeRecords,
      );
    },
  };
  if (options.residentBridge === true) {
    hub.subscribe((request) => {
      bridgeChain.push(
        runBridgeDispatch(service, target, request, bridgeRecords).catch((error: unknown) => {
          bridgeFailures.push(error);
        }),
      );
    });
  }

  return {
    repoRoot,
    db,
    service,
    target,
    dispatched,
    events,
    chainErrors,
    bridge,
    runtime: () => createRuntime(target),
    drain: async () => {
      while (chain.length > 0) await chain.shift()!;
    },
    drainBridge: async () => {
      while (bridgeChain.length > 0) await bridgeChain.shift()!;
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
    (
      await runtime.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], {
        cwd: f.repoRoot,
      })
    ).code === 0
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

/** 本仓库 `refs/heads/` 下的短分支名（排序）：用来断言「一个分支都没建 / 只多出预期那些」。 */
async function localBranches(f: Fixture): Promise<string[]> {
  const result = await gitAt(f.repoRoot)([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

/** 带分支的工作树条目（= 队员 run 的产物；队长行与单独安排都没有工作面）。 */
async function worktreeBranches(f: Fixture): Promise<string[]> {
  return (await (await f.runtime()).worktreeManager.list())
    .filter((entry) => entry.branch !== null)
    .map((entry) => entry.branch as string)
    .sort();
}

/** 读一条 run 台账行（缺失即断言失败）。 */
async function requireRun(f: Fixture, runId: string) {
  const record = (await f.runtime()).squadRunRepo.get(runId);
  assert.ok(record, `run ${runId} 必须存在于台账`);
  return record;
}

/** 集成分支 / 队员分支 / 目录名都从**生产实现的命名来源**取，测试里不重算命名规则。 */
function planOf(workItemId: string, agentId: string) {
  return planBranches({ workItemSlug: slugForId(workItemId), agentSlug: slugForId(agentId) });
}

/** 队员：开树 → 在树里提交一个文件 → 上报完成（run produced、子项按机械半的 CAS 结果推进）。 */
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
  const opened = await f.service.openMemberRun(f.target, {
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
  assert.equal(squad.members[0]?.agentId, leader.id, "队长必须被并入 members 且置于首位");
  assert.equal(squad.members[0]?.role, "leader");
  // getSnapshot 能读到（UI 的唯一取数口）。
  const snapshot = await f.service.getSnapshot(f.target);
  assert.ok(
    snapshot.squads.some((s) => s.id === squad.id),
    "getSnapshot 必须能读到小队",
  );
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
  const result = await f.service.assignWorkItem(f.target, {
    workItemId: child.id,
    agentId: memberA.id,
  });
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
  assert.ok(
    existsSync(a.worktreePath) && existsSync(b.worktreePath),
    "两棵工作树目录都必须在磁盘上",
  );
  assert.equal(
    basename(a.worktreePath),
    `${slugForId(child.id)}-${slugForId(memberA.id)}`,
    "目录名必须是**扁平**的 <workItemSlug>-<agentSlug>（单层，.worktree/ 只放一层）",
  );
  // 台账两条、各绑自己的分支。
  const runRecords = (await f.runtime()).squadRunRepo.listByParent(parent.id);
  assert.deepEqual(runRecords.map((r) => r.branch).sort(), [a.branch, b.branch].sort());
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
  const rejectedOutcome = await f.service.reviewMemberRun(f.target, {
    runId: "r-b",
    verdict: "rejected",
  });
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
  assert.deepEqual(
    (await runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );

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
  assert.equal(
    await branchExists(f, planOf(child.id, memberA.id).integration),
    false,
    "打回不建集成分支",
  );
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
  assert.deepEqual(
    (await runtime.worktreeManager.list()).filter((e) => e.branch !== null),
    [],
  );
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
  assert.deepEqual(
    [...computed].sort(),
    [...derived].sort(),
    "activeBranches 必须严格由 listActive 派生",
  );
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
  await assert.rejects(
    f.service.failMemberRun(f.target, { runId: "r-prod", reason: "  " }),
    /原因/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 逆推里被验收点名的两格缺陷：缺陷 1 已**修复**（下条用例守住），缺陷 2 仍**未接线**（如实报）
// ═══════════════════════════════════════════════════════════════════════════════

// 缺陷 1 修复（崩溃窗口对**空批**的覆盖）：`replayUnfinalizedBatches` 的枚举判据**不再只依赖 run 台账行**
// —— 补上「父项被指派给小队」这条**并列证据**（`squadRuntimeService.ts` 枚举处）。于是「空批（无队员 run）」
// 在**没有事件驱动**的启动态下也会被重驱收尾：若进程死在「取消唯一子项」与「`child_completed` 转发器
// 跑完收尾」之间，重启后父项不再滞留 `todo`（此前无任何恢复路径会收它）。
test("缺陷1 修复：空批（无 run 台账行）+ 崩溃窗口 ⇒ 重驱收尾（父项 done），重复重驱幂等", async () => {
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
  // 崩溃窗口态：唯一子项被取消（子项全终态）⇒ 空批；但没有事件驱动在本进程里跑。
  runtime.workItemService.transition("wi-c", "cancelled", "todo");
  // 先钉住前置：此刻确实**没有任何** run 台账行 —— 否则本用例证明的不是「空批」那条路径。
  assert.equal(
    runtime.squadRunRepo.listByParent(parent.id).length,
    0,
    "空批必须没有任何 run 台账行",
  );
  assert.equal(itemStatus(runtime, parent.id), "todo", "崩溃窗口态：父项尚未被推进");
  const shaBefore = await mainSha(f);

  // 重驱：空批**必须**被发现并收尾（读库；这是缺陷 1 的判据）。
  const first = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.replayed, [parent.id], "无 run 行的空批必须进入重驱视野");
  assert.equal(itemStatus(runtime, parent.id), "done", "重驱后父项确实到终态（读库）");
  // 空批没有可落地的成果：不动 git、不建树。
  assert.equal(await mainSha(f), shaBefore, "空批收尾不动主分支（无成果可合）");
  assert.deepEqual(
    (await runtime.worktreeManager.list()).filter((entry) => entry.branch !== null),
    [],
    "空批收尾不建任何工作树",
  );
  // 两条父项变迁事件真实发出（与事件驱动路径同形），证明走的是同一个唯一写者出口。
  assert.deepEqual(parentStatusEvents(f, parent.id), [
    { kind: "workitem.status_changed", id: parent.id, from: "todo", to: "in_review" },
    { kind: "workitem.status_changed", id: parent.id, from: "in_review", to: "done" },
  ]);

  // 幂等：重复重驱不再动它（父项已终态 ⇒ 枚举处直接跳过），也不重复发事件 / 重复推进。
  const eventsAfterFirst = parentStatusEvents(f, parent.id).length;
  const second = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(second.replayed, [], "已结算的批不再被重驱");
  assert.deepEqual(second.failures, []);
  assert.equal(itemStatus(runtime, parent.id), "done");
  assert.equal(
    parentStatusEvents(f, parent.id).length,
    eventsAfterFirst,
    "重复重驱不得再发父项变迁事件（幂等）",
  );
  assert.equal(await mainSha(f), shaBefore);
});

// 重驱发现判据的**穷举表**（同一崩溃窗口态里放四种形状，一次跑清）：
//  ② 有 run 行的未 finalize 批次（回归：原有视野不得丢）；
//  ① 空批（无 run 行）—— 缺陷 1 修法纳入的新格子；
//  ③/④ 重复重驱幂等 + 已 finalize 的批不被重驱（不误伤、不重复合并）。
test("重驱穷举：有 run 行的未 finalize 批仍被发现（回归）+ 空批被收尾 + 重复重驱无副作用", async () => {
  const f = await setup({ forwardChildCompleted: false });
  const { squad, memberA, memberB } = await makeSquad(f);
  const runtime = await f.runtime();

  // —— 批 P1：有 run 台账行、子项已全终态，但没跑过收尾（崩溃窗口）——
  const p1 = createItem(runtime, f, {
    id: "wi-p1",
    title: "有产出批",
    assignee: { type: "squad", id: squad.id },
  });
  const c1 = createItem(runtime, f, {
    id: "wi-c1",
    title: "子一",
    parentId: p1.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition(c1.id, "in_progress", "todo");
  const a = await produce(f, {
    runId: "r-a",
    childId: c1.id,
    parentId: p1.id,
    agentId: memberA.id,
    file: "a1.txt",
    content: "A1\n",
  });
  const b = await produce(f, {
    runId: "r-b",
    childId: c1.id,
    parentId: p1.id,
    agentId: memberB.id,
    file: "b1.txt",
    content: "B1\n",
  });
  const integration = planOf(c1.id, memberA.id).integration;
  await f.service.reviewMemberRun(f.target, { runId: "r-a", verdict: "approved" });
  await f.service.reviewMemberRun(f.target, { runId: "r-b", verdict: "approved" });
  assert.equal(itemStatus(runtime, c1.id), "done");
  assert.equal(itemStatus(runtime, p1.id), "todo", "崩溃窗口态：P1 尚未被推进");

  // —— 批 P2：空批（无任何 run 台账行），子项在派单前被取消 ——
  const p2 = createItem(runtime, f, {
    id: "wi-p2",
    title: "空批",
    assignee: { type: "squad", id: squad.id },
  });
  createItem(runtime, f, {
    id: "wi-c2",
    title: "空批子项",
    parentId: p2.id,
    assignee: { type: "squad", id: squad.id },
  });
  runtime.workItemService.transition("wi-c2", "cancelled", "todo");
  assert.equal(runtime.squadRunRepo.listByParent(p2.id).length, 0, "P2 是空批：零 run 行");

  // —— 第一次重驱：两条批都必须被看见 ——
  const first = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(
    [...first.replayed].sort(),
    ["wi-p1", "wi-p2"],
    "有 run 行的批（回归）与空批（缺陷 1 修法）都必须进入重驱视野",
  );
  // P1：整批合回主分支、父项 done、队员/集成分支与工作树全清。
  assert.equal(itemStatus(runtime, p1.id), "done", "有 run 行的批重驱后父项 done");
  assert.equal(await readMainFile(f, "a1.txt"), "A1\n");
  assert.equal(await readMainFile(f, "b1.txt"), "B1\n");
  assert.equal(await readRunStatus(f, "r-a"), "discarded");
  assert.equal(await readRunStatus(f, "r-b"), "discarded");
  for (const branch of [a.branch, b.branch, integration]) {
    assert.equal(await branchExists(f, branch), false, `${branch} 收尾后必须删掉`);
  }
  assert.equal(existsSync(a.worktreePath), false);
  // P2：空批按「批已结算」收口 done，一个字节都不动 git。
  assert.equal(itemStatus(runtime, p2.id), "done", "空批重驱后父项 done");

  // —— 第二次重驱：两条批都已终态 ⇒ 全空（幂等：不重复合并 / 不重复推进；也已 finalize 不被误伤）——
  const shaAfterFirst = await mainSha(f);
  const second = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(second.replayed, [], "已 finalize 的批（含空批）不再被重驱");
  assert.deepEqual(second.failures, []);
  assert.equal(await mainSha(f), shaAfterFirst, "重复重驱不得再动主分支（幂等）");
  assert.equal(itemStatus(runtime, p1.id), "done");
  assert.equal(itemStatus(runtime, p2.id), "done");
});

// 「重驱失败**可见**」（要求 1 的响亮格）：子项已全终态、但队员 run 仍停在 `open`（完成上报丢失的残局）
// —— 收尾会（正确地）拒绝半批。重驱**不得静默**：该批进 `failures`（逐条带原文），父项**不**被推进
// （「永远不动」不等于「合法丢弃」—— 滞留必须可见，不能悄悄 done）。host 侧对每条 failure 记 error。
test("重驱失败响亮：子项全终态但队员 run 停在 open ⇒ failures 逐条带原文、父项不静默推进", async () => {
  const f = await setup({ forwardChildCompleted: false });
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
  // 开了 run（台账停在 open），但**完成上报丢失**；子项却被直接标了终态 ⇒ 状态自相矛盾（半批的形状）。
  await f.service.openMemberRun(f.target, {
    runId: "r-open",
    workItemId: child.id,
    parentWorkItemId: parent.id,
    agentId: memberA.id,
    isLeaderTask: false,
  });
  runtime.workItemService.transition(child.id, "done", "todo");
  assert.equal(runtime.squadRunRepo.listByParent(parent.id).length, 1, "本批只有一条 open 的 run");

  const replay = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(replay.replayed, [], "半批（队员 run 停在 open）不得被收尾");
  assert.equal(replay.failures.length, 1, "失败必须逐条可见（不静默吞掉）");
  assert.equal(replay.failures[0]?.parentWorkItemId, parent.id);
  const error = replay.failures[0]?.error;
  assert.ok(error instanceof Error, "失败必须带**原文**（原错误对象），交调用方记日志");
  assert.match(error.message, /open/, "原文必须指出是哪条 run 卡在 open");
  assert.equal(
    itemStatus(runtime, parent.id),
    "todo",
    "重驱失败 ⇒ 父项**不**被静默推进（滞留可见，不是悄悄 done）",
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
  assert.equal(
    await branchExists(f, a.branch),
    false,
    "整批放弃 ⇒ 队员分支（含 produced / rejected）都删",
  );
  assert.equal(await branchExists(f, b.branch), false);
  assert.equal(existsSync(a.worktreePath), false);
  assert.ok(
    (await branchExists(f, planOf(child.id, memberA.id).integration)) === false,
    "集成分支也不留",
  );
  assert.equal(await mainSha(f), shaBefore, "整批放弃 ⇒ 主分支一个字节都没动过");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 第三篇：Wave 3 **之后**新增/改变的路径（队长台账 / 三类分流 / 单独安排 / 响亮拒绝 / 空批恢复）
//
// 验收方式 = **逆推 + 穷举**：每条先写「由 spec 哪一条，因此**必须**观察到什么」，再落到
// 实体状态断言（读 sqlite / 读 git ref / 读工作树目录 / 读主分支内容），不看返回字符串。
// 逐格穷举表（{队长 / 队员 / 单独安排} × {工作树 / 分支 / 台账行 / 活动集贡献 / 终态收口}）
// 与「由代码或类型保证」的格子，见 `.superpowers/sdd/2026-10-01-multi-agent-squad-p2b/task-acceptance-extension-report.md`。
// ═══════════════════════════════════════════════════════════════════════════════

// ── G：队长路径（spec §5.7(1) 队长在跑的判定、§6.1/§6.2 不开隔离、§5.7(2) 不改父项状态）──
//
// 逆推：§5.7(1) 要求「队长 run **进行中**时的重复指派合并为同一次」⇒ 因此**必须**有可判「进行中」的
// 记录 ⇒ 队长 run 必须**登记**一行台账；而 §6.1/§6.2 说队长在目标工作区执行 ⇒ 因此那行**必须**
// branch 为空、且**必须**零工作树；§5.7(1) 又说终态后不得再算「进行中」⇒ 因此收口后同一读法**必须**为假。
test("G. 队长 run：登记一行（branch 为空）+ 零工作树；hasInProgressLeaderRun 真 → 收口后假", async () => {
  const f = await setup();
  const { squad } = await makeSquad(f);
  const runtime = await f.runtime();
  // 队长的唤醒入口 = 一条**指派给小队**的工作项被派发（spec §3.3：由小队指派驱动）。
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const statusBefore = itemStatus(runtime, parent.id);
  const branchesBefore = await localBranches(f);
  const treesBefore = (await runtime.worktreeManager.list()).length;

  // 经派发桥的决策段（与 host `runSquadDispatch` 同形）：planDispatch 判类别 ⇒ 台账动作查表 ⇒ 登记。
  await f.bridge.dispatch(parent.id);

  // 类别判别 + 台账动作（穷举表的「队长」行）：runClass=leader ⇒ record_leader_run。
  assert.deepEqual(
    f.bridge.records.map((record) => [record.runClass, record.ledgerAction]),
    [["leader", "record_leader_run"]],
  );
  const runId = f.bridge.records[0]!.runId;

  // §5.7(1) ⇒ 因此必须观察到：台账里有一条**队长行**（「进行中」的唯一记录）。
  const row = await requireRun(f, runId);
  assert.equal(row.isLeaderTask, true, "队长行以 is_leader_task 作身份标记（与队员行可区分）");
  assert.equal(row.branch, null, "队长 run 不开工作树 ⇒ branch 必须为空");
  assert.equal(row.dirName, null);
  assert.equal(row.status, "open");
  assert.equal(row.workItemId, parent.id);
  assert.equal(row.parentWorkItemId, parent.id, "无父项时缺省取自身（与队员 run 同口径）");

  // §6.1/§6.2 ⇒ 因此必须观察到：**零工作树、零新分支**（队长在目标工作区执行）。
  assert.deepEqual(await localBranches(f), branchesBefore, "队长 run 不得建任何分支");
  assert.equal((await runtime.worktreeManager.list()).length, treesBefore, "队长 run 不得建工作树");

  // §5.7(1) 的读法（唯一实现 hasInProgressLeaderRun，按 listActive 投影）：登记后「进行中」为真。
  const activeSnapshot = await f.service.getSnapshot(f.target);
  assert.ok(
    activeSnapshot.runs.some((record) => record.runId === runId),
    "getSnapshot().runs 必须看得见队长 run",
  );
  assert.equal(hasInProgressLeaderRun(activeSnapshot.runs, parent.id), true, "登记后即「进行中」");
  // §6.2 ⇒ 队长行对 activeBranches 零贡献（按 branch !== null 投影）。
  assert.deepEqual(await runtime.lifecycle.computeActiveBranches(WS), [], "队长行对活跃分支零贡献");
  // §5.7(2) ⇒ 队长 run 不改工作项状态。
  assert.equal(itemStatus(runtime, parent.id), statusBefore, "§5.7(2)：队长 run 不改父项状态");

  // ── 成功终态收口（completeLeaderRun）：队长没有队员那一步 review/merge，跑完即收口到终态 ──
  await f.service.completeLeaderRun(f.target, { runId });
  assert.equal((await requireRun(f, runId)).status, "merged", "队长 run 成功 ⇒ 终态");
  const afterSnapshot = await f.service.getSnapshot(f.target);
  assert.equal(
    hasInProgressLeaderRun(afterSnapshot.runs, parent.id),
    false,
    "终态之后「进行中」必须为假 —— 否则该工作项的后续指派被永久合并（spec §5.7(1)）",
  );
  assert.equal(
    afterSnapshot.runs.some((record) => record.runId === runId),
    false,
    "终态的队长行必须离开活跃集",
  );
  assert.equal(itemStatus(runtime, parent.id), statusBefore, "§5.7(2)：收口也不改父项状态");
  assert.deepEqual(await localBranches(f), branchesBefore, "收口后依然零分支");
  assert.equal((await runtime.worktreeManager.list()).length, treesBefore, "收口后依然零工作树");

  // 幂等：同一条「成功」事实重投不报错、也不再动任何东西（终态事件重放 / 双路径）。
  await f.service.completeLeaderRun(f.target, { runId });
  assert.equal((await requireRun(f, runId)).status, "merged");
});

// ── G2：队长行的**失败出口**与**只收队长行**（spec §6.2 终态不得影响工作树 / 未命中响亮）──
test("G2. 队长行走失败出口 ⇒ discarded；跨终态响亮抛；completeLeaderRun 只收队长行", async () => {
  const f = await setup();
  const { squad, memberA } = await makeSquad(f);
  const runtime = await f.runtime();
  const parent = createItem(runtime, f, {
    id: "wi-p",
    title: "计划",
    assignee: { type: "squad", id: squad.id },
  });
  const statusBefore = itemStatus(runtime, parent.id);
  const treesBefore = (await runtime.worktreeManager.list()).length;

  // 失败/中止 ⇒ 有归宿：离开活跃集（discarded），且行仍可查（台账没有删除路径）。
  await f.service.recordLeaderRun(f.target, {
    runId: "r-lead-fail",
    workItemId: parent.id,
    agentId: squad.leaderAgentId,
  });
  assert.equal(
    hasInProgressLeaderRun((await f.service.getSnapshot(f.target)).runs, parent.id),
    true,
  );
  await f.service.failMemberRun(f.target, { runId: "r-lead-fail", reason: "队长会话终态=failed" });
  assert.equal((await requireRun(f, "r-lead-fail")).status, "discarded");
  assert.equal(
    hasInProgressLeaderRun((await f.service.getSnapshot(f.target)).runs, parent.id),
    false,
    "失败收口后「进行中」必须为假（否则判据恒真）",
  );
  assert.equal(
    (await runtime.squadRunRepo.listByWorkItem(parent.id)).length,
    1,
    "行仍可查（留痕不丢）",
  );

  // 跨终态：已按失败收口的 run 不得被改写成「成功」（会掩盖它当初为什么没跑完）。
  await f.service.recordLeaderRun(f.target, {
    runId: "r-lead-cross",
    workItemId: parent.id,
    agentId: squad.leaderAgentId,
  });
  await f.service.failMemberRun(f.target, { runId: "r-lead-cross", reason: "先失败" });
  await assert.rejects(
    () => f.service.completeLeaderRun(f.target, { runId: "r-lead-cross" }),
    /不是 open|跨终态/,
  );
  assert.equal((await requireRun(f, "r-lead-cross")).status, "discarded", "跨终态改写被拒且不落盘");

  // 只收队长行：对**队员行**调用 completeLeaderRun ⇒ 响亮抛，且队员行一个字节不动。
  // 防的是最坏形态：把一条从未合并的队员分支置 merged，编排器随后连树带枝当「已合并」丢弃。
  const memberRun = await f.service.openMemberRun(f.target, {
    runId: "r-member-for-leader-guard",
    workItemId: parent.id,
    parentWorkItemId: parent.id,
    agentId: memberA.id,
    isLeaderTask: false,
  });
  await assert.rejects(
    () => f.service.completeLeaderRun(f.target, { runId: "r-member-for-leader-guard" }),
    /不是队长 run/,
  );
  assert.equal(
    (await requireRun(f, "r-member-for-leader-guard")).status,
    "open",
    "队员行不得被改写",
  );
  assert.ok(await branchExists(f, memberRun.branch), "队员分支仍在");
  // 未命中 runId ⇒ 响亮抛（静默 no-op 会让调用方以为收口成功）。
  await assert.rejects(
    () => f.service.completeLeaderRun(f.target, { runId: "no-such-run" }),
    /没有 runId/,
  );
  // 全程工作项状态不变（队长收口不碰父项）；只有队员那条派发生成了一棵工作树（回归：队长行零工作面）。
  assert.equal(itemStatus(runtime, parent.id), statusBefore);
  assert.equal(
    (await runtime.worktreeManager.list()).length,
    treesBefore + 1,
    "队长行不派生工作面：唯一一棵树来自那条队员 run",
  );
});

// ── H：三类分流（spec §6.1）—— 队员有树有分支有台账；队长只台账；单独安排**三无**但会话照发 ──
//
// 逆推：§6.1「是否开工作树是**本次运行**的属性」⇒ 派发必须按**类别**（不是「非队长 ⇒ 开树」）分流 ⇒
// 因此**必须**观察到：队员派生工作面、队长与单独安排不派生；且这个判据来自生产实现
// `ledgerActionForRunClass`（本用例经它驱动，不是测试里另抄一份 switch）。
test("H. 三类分流：队员（树+分支+台账）/ 队长（只台账）/ 单独安排（三无，派发照走）", async () => {
  const f = await setup({ residentBridge: true });
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
  // 单独安排的对照项：顶层工作项、无父项 ⇒ 不在任何小队批次里（§6.1 那一类）。
  const solo = createItem(runtime, f, {
    id: "wi-solo",
    title: "单独安排的任务",
    assignee: { type: "agent", id: memberA.id },
  });
  const treesBefore = (await runtime.worktreeManager.list()).length;
  const branchesBefore = await localBranches(f);

  // 经**服务面唯一入口**（assignWorkItem ⇒ 唯一事件出口 ⇒ 常驻 hub ⇒ 派发桥）。
  await f.service.assignWorkItem(f.target, { workItemId: child.id, agentId: memberA.id });
  await f.drainBridge();
  await f.service.assignWorkItem(f.target, { workItemId: solo.id, agentId: memberA.id });
  await f.drainBridge();

  assert.deepEqual(f.bridge.failures, [], "两条派发都不得抛");
  const byItem = new Map(f.bridge.records.map((record) => [record.workItemId, record]));
  assert.deepEqual(
    [byItem.get(child.id)?.runClass, byItem.get(child.id)?.ledgerAction],
    ["member", "open_member_run"],
    "父项被指派给小队 ⇒ 队员（§6.4 开独立工作树）",
  );
  assert.deepEqual(
    [byItem.get(solo.id)?.runClass, byItem.get(solo.id)?.ledgerAction],
    ["standalone", "none"],
    "顶层无父项 ⇒ 单独安排（§6.1 直接在工作区改）",
  );

  // 队员实体状态：台账一行（带队员分支）、工作树 + 分支各一。
  const memberRow = await requireRun(f, byItem.get(child.id)!.runId);
  assert.equal(memberRow.isLeaderTask, false);
  assert.equal(memberRow.branch, planOf(child.id, memberA.id).member, "队员行带自己的分支名");
  assert.equal(memberRow.status, "open");
  assert.deepEqual(await worktreeBranches(f), [memberRow.branch!], "队员有一棵工作树（带分支）");
  assert.ok(await branchExists(f, memberRow.branch!), "队员分支真的存在于 refs/heads");
  assert.equal((await runtime.worktreeManager.list()).length, treesBefore + 1);
  assert.deepEqual(
    await runtime.lifecycle.computeActiveBranches(WS),
    [memberRow.branch],
    "队员分支进活跃集（活跃集合由 listActive 派生）",
  );
  assert.equal(
    hasInProgressLeaderRun((await f.service.getSnapshot(f.target)).runs, child.id),
    false,
    "队员行不是队长行（isLeaderTask=false）",
  );

  // 单独安排实体状态：**三无** —— 无台账行、无分支、无工作树（§6.1「没有合并那一步」）。
  assert.deepEqual(
    await runtime.squadRunRepo.listByWorkItem(solo.id),
    [],
    "单独安排的智能体不得有台账行（台账是小队台账）",
  );
  assert.equal(
    (await f.service.getSnapshot(f.target)).runs.some((record) => record.workItemId === solo.id),
    false,
    "单独安排不进活跃集（它不在任何小队里）",
  );
  assert.deepEqual(
    await localBranches(f),
    [...branchesBefore, memberRow.branch!].sort(),
    "除队员那条外不得多出任何分支",
  );
  assert.equal(
    (await runtime.worktreeManager.list()).length,
    treesBefore + 1,
    "单独安排不得建工作树",
  );
  // **对照的核心**：单独安排**不是「跳过派发」** —— 它仍经唯一出口驱动了一次派发（会话照发，落目标工作区）。
  const soloRequests = f.dispatched.filter((request) => request.workItemId === solo.id);
  assert.equal(soloRequests.length, 1, "单独安排仍要经 hub 发出派发请求（会话照发）");
  assert.deepEqual(soloRequests[0], {
    workItemId: solo.id,
    agentId: memberA.id,
    workspacePath: f.repoRoot,
    workspaceIdentity: WS,
  });
});

// ── I：响亮拒绝（spec §6.1 的反面）—— 声明 member 却给不出父项证据 ⇒ 抛，且拒绝在建任何东西之前 ──
//
// 逆推：§6.1 的隔离承诺是「队员必须在独立工作树里干活」⇒ 当**无法证明**本项不在小队批次里时
// （有 parentId 却取不到父项：归档 / 删除 / 跨 workspace），按 standalone 放行 = 静默取消隔离，
// 按 member 放行 = 凭空开树；两条都不能静默选 ⇒ 因此**必须**响亮失败，且**必须**不建树、不登记台账。
// 这一格在服务面**可构造**（assignWorkItem 是三个入口之一，派发桥的类别声明走生产策略 declaredRunClassFor）。
test("I. 声明 member 却给不出父项证据：派发桥响亮失败，且不建树、不登记台账、不建分支", async () => {
  const f = await setup({ residentBridge: true });
  const { squad } = await makeSquad(f);
  const runtime = await f.runtime();

  /* 归档父项 + 挂在它下面的**活跃**子项：只经 repo 落库（`insert` 不查父链、允许写 archivedAt；
     服务面的 `create` 会按「父工作项不存在或已归档」拒掉 —— 正是那道闸让这种数据只能这样重现）。 */
  runtime.workItemRepo.insert({
    id: "wi-arch-p",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "已归档的批次父项",
    body: "",
    status: "todo",
    assignee: { type: "squad", id: squad.id },
    labels: [],
    properties: {},
    position: 0,
    archivedAt: 1,
  });
  runtime.workItemRepo.insert({
    id: "wi-arch-c",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    parentId: "wi-arch-p",
    title: "归档父项下的子项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: "ta-x" },
    labels: [],
    properties: {},
    position: 0,
  });

  // 前置（夹具必须有区分力）：本项有 parentId，但父项对**读路径**等同不存在 ⇒ 唯一策略声明 member。
  const snapshot = await f.service.getSnapshot(f.target);
  const child = snapshot.workItems.find((item) => item.id === "wi-arch-c");
  assert.ok(child, "活跃子项必须可读");
  assert.equal(child.parentId, "wi-arch-p");
  assert.equal(
    snapshot.workItems.some((item) => item.id === "wi-arch-p"),
    false,
    "归档父项对读路径等同不存在",
  );
  assert.equal(
    declaredRunClassFor({ parentId: child.parentId, parent: null }),
    "member",
    "「有 parentId 却拿不到父项」那一格**故意**声明 member，好让 planDispatch 响亮拒绝",
  );

  const treesBefore = (await runtime.worktreeManager.list()).length;
  const branchesBefore = await localBranches(f);
  await f.service.assignWorkItem(f.target, { workItemId: "wi-arch-c", agentId: "ta-x" });
  await f.drainBridge();

  // §6.1 ⇒ 因此必须观察到：这次派发**响亮失败**（不是静默落成 standalone = 静默取消隔离）。
  assert.equal(f.bridge.failures.length, 1, "父项已归档必须响亮失败，不得静默按单独安排放行");
  assert.match(String(f.bridge.failures[0]), /没有可用的父项事实/, "错误必须点明缺的是父项事实");
  // 拒绝发生在建任何东西之前：零台账行、零工作树、零分支。
  assert.deepEqual(runtime.squadRunRepo.listByWorkItem("wi-arch-c"), [], "不得产生台账行");
  assert.equal((await runtime.worktreeManager.list()).length, treesBefore, "不得建工作树");
  assert.deepEqual(await localBranches(f), branchesBefore, "不得建分支");
  // 负责人确实改了（指派这一半已成立）—— 响亮失败只针对「派发」这一半，不是整条指派回滚。
  assert.deepEqual(runtime.workItemRepo.get("wi-arch-c")?.assignee, { type: "agent", id: "ta-x" });
});

// ── J：空批恢复（spec §6.2 崩溃窗口）—— 无 run 行的空批也能被重驱收尾；主分支不动；连跑两次幂等 ──
//
// 逆推：进程死在「子项转终态」与「child_completed 转发器跑完收尾」之间时，重启后**没有任何
// run 台账行**；若重驱只看台账行，这个父项**永久**停在 todo（不是报错，是永远不动）⇒
// 因此发现判据**必须**含第二条并列证据「父项被指派给小队」；而空批无成果可合 ⇒ **必须**不动主分支；
// 恢复动作是幂等的重驱 ⇒ **必须**连跑两次无副作用。
test("J. 空批恢复（无 run 行）：重驱 ⇒ 父项 done、主分支内容逐字节不变；连跑两次幂等", async () => {
  // 关掉事件转发 = 模拟进程在收尾前死掉：没有订阅者会重放 child_completed。
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
    title: "派单前被取消的子任务",
    parentId: parent.id,
    assignee: { type: "squad", id: squad.id },
  });
  // 崩溃窗口态：唯一子项被取消（子项全终态）⇒ 空批；但没有事件驱动在本进程里跑。
  runtime.workItemService.transition("wi-c", "cancelled", "todo");
  // 前置：确实**没有任何** run 台账行 —— 否则本用例证明的不是「空批」那条路径。
  assert.equal(runtime.squadRunRepo.listByParent(parent.id).length, 0, "空批必须零 run 台账行");
  assert.equal(itemStatus(runtime, parent.id), "todo", "崩溃窗口态：父项尚未被推进");
  const shaBefore = await mainSha(f);
  const fileBefore = await readMainFile(f, "a.txt");

  const first = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(
    first.replayed,
    [parent.id],
    "无 run 行的空批必须进入重驱视野（含「父项指派给小队」证据）",
  );
  assert.equal(itemStatus(runtime, parent.id), "done", "重驱后父项确实到终态（读库）");
  assert.equal(await mainSha(f), shaBefore, "空批无成果可合 ⇒ 主分支一个字节不动");
  assert.equal(await readMainFile(f, "a.txt"), fileBefore, "主分支内容逐字节不变");
  assert.deepEqual(await worktreeBranches(f), [], "空批收尾不建工作树");
  const eventsAfterFirst = parentStatusEvents(f, parent.id).length;

  // 幂等：连跑第二次无副作用（不重复合并 / 不重复推进 / 不重复发事件）。
  const second = await f.service.replayUnfinalizedBatches(f.target);
  assert.deepEqual(second.replayed, [], "已结算的批不再被重驱");
  assert.deepEqual(second.failures, []);
  assert.equal(await mainSha(f), shaBefore, "重复重驱不得再动主分支（幂等）");
  assert.equal(await readMainFile(f, "a.txt"), fileBefore);
  assert.equal(itemStatus(runtime, parent.id), "done");
  assert.equal(
    parentStatusEvents(f, parent.id).length,
    eventsAfterFirst,
    "重复重驱不得再发父项变迁事件（幂等）",
  );
});
