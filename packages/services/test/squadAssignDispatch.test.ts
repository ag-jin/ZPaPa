import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createProtocolSquadHandlers } from "../src/zcode-agent/squadProtocolMethods.js";
import { declaredRunClassFor, planDispatch } from "../src/workitem/leaderDispatch.js";
import { createSquadDispatchRequestHub } from "../src/workitem/squadDispatchRequests.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 队长派单（`squad/assign-work-item`）**真的驱动出 run** 那一格（Task 7 第 2 轮裁定，落点 ii）。

   为什么这一格必须单独有用例：裁定前「指派只发一条 `workitem.dispatch_requested`」，而那条事件的订阅表在
   runtime **实例内部**，常驻侧（host 进程里的组合根）按目标现构、订不到 ⇒ **驱动不出 run**（缺口已被复审
   点名）。修法是把这一格的出口做成**可注入的单例 hub**（`createSquadDispatchRequestHub`），组合根订
   **一次**、转给 host 的派发执行体（`onSquadDispatchRequested` → `runSquadDispatch`）。

   本文件的断言全部是**实体状态**（读库 / 读 git 的工作树列表 / 读磁盘），不是返回值：
   ① 读库证明负责人真的改了；② 读库 + 读 git 证明 run 台账行与工作树**真的出现**；
   ③ 同一调用在**常驻侧未订阅**时不产生任何 run —— 这就是「不是在协议 handler 里直接开出来的」的
   结构证据（handler 侧另有源码守卫：本文件最后一条 `openMemberRun` 不得出现在 handler 里）。

   常驻侧订阅者在本文件里是 **host 派发桥的最小同形副本**（`planDispatch` → `openMemberRun`）：
   `packages/desktop/src/host/index.ts` 有模块级副作用（`process.title` / repo 构造 / 定时器），
   `import` 它会让测试进程根本不结束（本仓已实测），所以 host 那一侧「真的开 run」只能由这段同形副本
   加上落点结构共同钉住。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/**
 * 真实 runtime + 真实服务面 + 组合根同形的派发 hub（`createSquadRuntimeFor` 里注入的是同一件事）。
 * 是否订阅由用例显式决定（不订阅 = 没有常驻侧），于是「请求发了但没人接」与「有人接」两态都能重现。
 */
async function makeHarness(options?: { subscribeResident?: boolean }) {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const hub = createSquadDispatchRequestHub();
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
      // 与组合根同形：每个 runtime 都把派发请求 publish 到**那一份** hub。
      dispatchRequestHub: hub,
    });
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => {
      await archiveSquadAndTransfer(await createRuntime(t), id);
    },
    createOrchestrator: createSquadOrchestrator,
    logWarn: () => {},
  });
  const handlers = createProtocolSquadHandlers({
    resolveSquadRuntimeService: () => squadRuntimeService,
  });
  const runtime = await createRuntime(target("ws"));

  /** 常驻侧执行体（host 派发桥的最小同形副本）：规划 → 队员 run 先开树。 */
  const dispatched: Array<Promise<void>> = [];
  const failures: unknown[] = [];
  if (options?.subscribeResident === true) {
    hub.subscribe((request) => {
      dispatched.push(
        (async () => {
          // 结论只由**唯一一处规划**给（与 host 派发桥同：不在这里自己判该派给谁）。
          const requestTarget = {
            path: request.workspacePath,
            identity: request.workspaceIdentity,
          };
          const snapshot = await squadRuntimeService.getSnapshot(requestTarget);
          const item = snapshot.workItems.find((candidate) => candidate.id === request.workItemId);
          if (!item) throw new Error(`工作项不存在：${request.workItemId}`);
          const squad =
            item.assignee.type === "squad"
              ? (snapshot.squads.find((candidate) => candidate.id === item.assignee.id) ?? null)
              : null;
          // **派发时的事实**（与 host 派发桥同）：本项的父项 —— 它是类别**声明**的校验证据。
          const parent = item.parentId
            ? (snapshot.workItems.find((candidate) => candidate.id === item.parentId) ?? null)
            : null;
          /* 类别**声明**（与 host 派发桥同形，且用**同一个策略** `declaredRunClassFor`，不在这里另写
             一份推导）：类别不再由「有没有父项」推断 —— 漏传父项会把队员静默降级成「直接改主工作区」。
             声明与 `parent` 事实一起交给 `planDispatch`，由它校验并在缺一 / 矛盾时**响亮抛**。 */
          const events = planDispatch({
            workItem: item,
            squad,
            parentWorkItem: parent,
            runClass: declaredRunClassFor({ parentId: item.parentId, parent }),
            trigger: "user",
          });
          const enqueued = events.find((event) => event.kind === "run.enqueued");
          if (enqueued?.kind !== "run.enqueued") return; // skip 不是失败（进 Inbox）
          /* 只有**队员**先开树（spec §6.1 的隔离承诺落点）：台账行与工作树都从这里出现。
             **单独安排的智能体**在这一格**什么都不做** —— 它直接在工作区改（没有工作树、没有合并那一步）。 */
          if (enqueued.runClass !== "member") return;
          await squadRuntimeService.openMemberRun(requestTarget, {
            runId: `assign-run-${item.id}-${enqueued.agentId}`,
            workItemId: item.id,
            parentWorkItemId: item.parentId ?? item.id,
            agentId: enqueued.agentId,
            isLeaderTask: false,
          });
        })().catch((error: unknown) => {
          failures.push(error);
        }),
      );
    });
  }

  const parent = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "父项",
    assignee: { type: "squad", id: "sq-1" },
  });
  const child = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "子项",
    parentId: parent.id,
    assignee: { type: "squad", id: "sq-1" },
  });
  /* **单独安排**的对照项（spec §6.1）：顶层工作项、**没有父项** ⇒ 不在任何小队批次里。
     指派它不会开树、不会产生台账行 —— 这正是复审判词点名的那一类。 */
  const solo = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "单独安排的任务",
    assignee: { type: "agent", id: "ta-solo" },
  });

  return {
    runtime,
    handlers,
    failures,
    parent,
    child,
    solo,
    /** 等常驻侧那条异步链跑完（hub 是同步扇出，执行体是异步的），返回本次收到的请求数。 */
    settle: async () => {
      await Promise.all(dispatched);
      return dispatched.length;
    },
  };
}

// ③ 的结构证据：**没有常驻订阅者**时，指派只改负责人 + 发请求，不产生 run（读库 + 读 git）。
test("常驻侧未订阅 hub ⇒ 指派不产生 run（负责人改了，台账与工作树都没有）", async () => {
  const { runtime, handlers, parent, child } = await makeHarness();

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: child.id,
    agentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  // ① 负责人真的改了（读库）。
  assert.deepEqual(
    runtime.workItemRepo.get(child.id)?.assignee,
    { type: "agent", id: "ta-a" },
    "指派必须改负责人",
  );
  // ② 没有任何 run：台账为空、工作树为空 —— 说明 run 只能在常驻侧接到请求后开出来。
  assert.deepEqual(runtime.squadRunRepo.listByParent(parent.id), [], "指派本身不得开 run 台账行");
  assert.deepEqual(await runtime.worktreeManager.list(), [], "指派本身不得建工作树");
});

// ② 裁定点名的正面用例：常驻侧订一次 ⇒ 指派**确实驱动出了 run**（读库 / 读 git 的实体状态）。
test("常驻侧订一次 hub ⇒ 指派驱动出 run（台账行 + 工作树，均为实体状态）", async () => {
  const { runtime, handlers, failures, parent, child, settle } = await makeHarness({
    subscribeResident: true,
  });

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: child.id,
    agentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(failures, [], "常驻侧执行体不得抛错");
  assert.equal(await settle(), 1, "指派必须经 hub 恰好驱动一次派发");

  // ① 负责人改了（读库）。
  assert.deepEqual(runtime.workItemRepo.get(child.id)?.assignee, { type: "agent", id: "ta-a" });

  // ② run **真的**开出来了：台账行落在指定队员名下、状态 open（读库实体状态）。
  const runId = `assign-run-${child.id}-ta-a`;
  const row = runtime.squadRunRepo.get(runId);
  assert.ok(row, "指派必须驱动出 run 台账行");
  assert.equal(row.status, "open", "刚开树还是 open（产出入账是之后的事）");
  assert.equal(row.workItemId, child.id);
  assert.equal(row.agentId, "ta-a");
  assert.equal(row.parentWorkItemId, parent.id, "run 挂在子项所属的父项下");
  assert.equal(
    runtime.squadRunRepo.listByParent(parent.id).length,
    1,
    "父项下应有且只有这一条 run",
  );

  // ③ 工作树**真的**建出来了（读 git 的工作树列表 + 读磁盘目录）。
  const worktrees = await runtime.worktreeManager.list();
  assert.equal(worktrees.length, 1, "队员 run 必须先开树（spec §6.1 的隔离承诺）");
  assert.match(worktrees[0]?.branch ?? "", /squad\/member\//, "工作树落在队员分支命名空间");
  assert.ok(existsSync(worktrees[0]!.path), "工作树目录必须真的在磁盘上");
});

// ③ **单独安排的智能体**（spec §6.1，复审判词点名的那一类）：顶层、无父项 ⇒ 不在小队批次里。
// 指派它仍要**驱动一次真实派发**（事件发了、常驻侧也接了），但**不开工作树、不登记台账行** ——
// 这正是本次修掉的缺陷（旧写法「非队长 ⇒ 开树」会给它开一条**永不合并、也永不被回收**的分支）。
test("单独安排的智能体：指派驱动派发，但不开工作树、不产生台账行", async () => {
  const { runtime, handlers, failures, solo, settle } = await makeHarness({
    subscribeResident: true,
  });

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: solo.id,
    agentId: "ta-solo",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(failures, [], "常驻侧执行体不得抛错");
  assert.equal(await settle(), 1, "指派仍要驱动一次派发（会话照发，只是没有工作树）");

  // ① 负责人改了（读库）。
  assert.deepEqual(runtime.workItemRepo.get(solo.id)?.assignee, { type: "agent", id: "ta-solo" });
  // ② **没有台账行**（读库实体状态）：它不在任何小队里，台账也无从收口。
  assert.deepEqual(
    runtime.squadRunRepo.listByWorkItem(solo.id),
    [],
    "单独安排的智能体不得产生任何 run 台账行",
  );
  // ③ **没有工作树**（读 git 的工作树列表）：§6.1「直接在工作区改，没有合并那一步」。
  assert.deepEqual(await runtime.worktreeManager.list(), [], "单独安排的智能体不得建工作树");
});

// 补集方向：hub 只承载**派发请求**。工作项状态变迁不进常驻订阅者 —— 否则每一次状态推进都会被
// 当成一次派发，形态是「莫名其妙多出一堆 run」。
test("hub 只承载派发请求（状态变迁不进常驻订阅者）", async () => {
  const { runtime, child, failures, settle } = await makeHarness({ subscribeResident: true });
  // 走服务面唯一写者那条路推一次状态（这一步不该产生任何派发请求）。
  assert.equal(runtime.workItemService.transition(child.id, "in_progress", "todo"), true);
  assert.equal(await settle(), 0, "状态变迁不得被当成派发请求");
  assert.deepEqual(failures, []);
});

// 源码守卫：协议 handler 这一侧**不得**出现 `openMemberRun`（run 只能由常驻派发路径开出来）。
// 剥注释再匹配：解释性注释里点名它是合法的（它要说明「为什么不去碰它」），裸 grep 会把说明判成事实。
test("协议 handler 不含 openMemberRun（指派不在 handler 里开 run）", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/zcode-agent/squadProtocolMethods.ts"),
    "utf8",
  );
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /openMemberRun/,
    "指派不得在协议 handler 里直接开 run（那会把「指派」与「派发」揉成一步，§5.6）",
  );
});

/* **父项已归档那一格**（本轮**显式决定**：**响亮拒绝** —— 既不静默按单独安排放行，也不凭空开树）。

   `workItemRepo` 的读路径一律过滤归档行（`archived_at IS NULL`，注释原文「归档行等同不存在」）⇒ 父项
   一旦归档，派发时的 `parentWorkItem` 就是 `null`（与「被删 / 落在别的 workspace」同形）。此时**无法
   证明**子项不在批次里：按 standalone 放行 = 把一名可能的队员**静默**放进主工作区（§6.1 落空）；
   按 member 放行又没有证据可校验（等于凭空开树）。两条都不能静默选 ⇒ 由
   `declaredRunClassFor` **故意**声明 member（有 `parentId` 却拿不到父项那一格）触发 `planDispatch`
   的响亮抛，宿主按 permanent 收口并留痕。
   这一格**区分于**「顶层、无父项」（后者是**确定**不在批次里 ⇒ standalone，见上面那条用例）：
   区别只看本项的 `parentId` 有没有 ── 有 `parentId` 就必须能给出父项，给不出就拒绝。 */
test("父项已归档：派发响亮拒绝（不开树、不登记台账，绝不是静默的单独安排）", async () => {
  const { runtime, handlers, failures, settle } = await makeHarness({ subscribeResident: true });

  /* 归档父项 + 挂在它下面的**活跃**子项：只经 repo 落库（`insert` 明确不查父链、且允许写 `archivedAt`；
     服务面的 `create` 会按「父工作项不存在或已归档」拒掉 —— 正是那道闸让这种数据只能这样重现）。 */
  const archivedParentId = "wi-archived-parent";
  runtime.workItemRepo.insert({
    id: archivedParentId,
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "已归档的批次父项",
    body: "",
    status: "todo",
    assignee: { type: "squad", id: "sq-1" },
    labels: [],
    properties: {},
    position: 0,
    archivedAt: 1,
  });
  const childId = "wi-child-of-archived";
  runtime.workItemRepo.insert({
    id: childId,
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    parentId: archivedParentId,
    title: "归档父项下的子项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: "ta-a" },
    labels: [],
    properties: {},
    position: 0,
  });

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: childId,
    agentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await settle(), 1, "指派仍要经 hub 驱动一次派发");

  // **响亮**：常驻侧执行体抛了 —— 这一格不许留默认，静默的话就是「什么都不做、也不吭声」。
  assert.equal(failures.length, 1, "父项已归档必须响亮失败，不得静默按单独安排放行");
  assert.match(String(failures[0]), /没有可用的父项事实/, "错误必须点明缺的是父项事实");
  // 两条「拒绝发生在建任何东西之前」的实体状态断言：既不悄悄改主工作区（standalone 的后果），也不开树。
  assert.deepEqual(runtime.squadRunRepo.listByWorkItem(childId), [], "不得产生台账行");
  assert.deepEqual(
    await runtime.worktreeManager.list(),
    [],
    "不得建工作树（拒绝，而不是凭空开树）",
  );
});
