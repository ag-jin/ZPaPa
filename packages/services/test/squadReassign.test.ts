import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WorkItem } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import {
  createSquadDispatchRequestHub,
  type SquadDispatchRequest,
} from "../src/workitem/squadDispatchRequests.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  SQUAD_DISPATCH_DISABLED_CODE,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 改派（`reassignWorkItem`，2026-10-03 加法）的服务面用例 + `assignWorkItem` 薄包装的回归。

   装配照 `squadRosterManagement.test.ts` / `squadAssignDispatch.test.ts` 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面 + 组合根同形的**单例 hub**（订一次，把请求收进数组
   —— 就是 host 派发桥那个位置的 spy）。断言全部是**实体状态**（读库 / hub 收到的请求原样）与
   **调用事实**（写 spy / seenTargets），不是返回值回声。

   三条纪律的落点：
   · **门禁**在**构造 runtime 之前**过（用 seenTargets 证明：门禁被拒时一个 runtime 都没构造）；
   · **user 不发派发请求**（hub 零调用）——「指派给人 = 等人自己动手」；
   · **同值不动作**（不写、不发、`{assigned:false}`）—— 同一事实重投不产生第二次动作。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });
const WS = target("ws");

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/**
 * 真实 runtime + 真实服务面 + 单例 hub spy（照 `createSquadRuntimeFor` 的注入形态）。
 *
 * `assigneeWrites` 是写调用 spy：把 `runtime.workItemRepo.updateAssignee` 包一层（委托给真实实现）
 * —— 「同值不写」这件事在实体状态上不可观察（值本来就没变），只有调用事实能证明它确实**没写**。
 * 它不替换任何实现（库里的实体状态照旧由真 repo 写），只记录「有没有发生这次写」。
 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime。 */
  const seenTargets: string[] = [];
  /** 常驻侧收到的派发请求（组合根那一份 hub 的订阅 spy）。 */
  const published: SquadDispatchRequest[] = [];
  /** 经**唯一出口**（实例订阅表）收到的事件：成因断言的直接证据（hub 请求的 cause 由它转发而来）。 */
  const events: WorkItemEvent[] = [];
  /** 写调用 spy（见上）。 */
  const assigneeWrites: Array<{ id: string; assignee: WorkItem["assignee"] }> = [];
  const hub = createSquadDispatchRequestHub();
  hub.subscribe((request) => published.push(request));
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    const runtime = await createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
      // 与组合根同形：每个 runtime 都把派发请求 publish 到**那一份** hub。
      dispatchRequestHub: hub,
    });
    runtime.subscribeWorkItemEvents((event) => events.push(event));
    const updateAssignee = runtime.workItemRepo.updateAssignee.bind(runtime.workItemRepo);
    runtime.workItemRepo.updateAssignee = (id, assignee) => {
      assigneeWrites.push({ id, assignee });
      return updateAssignee(id, assignee);
    };
    return runtime;
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
    logWarn: () => {},
  });
  return {
    repoRoot,
    db,
    squadRuntimeService,
    published,
    events,
    assigneeWrites,
    seenTargets,
    /** 现构一个 runtime（造归档行等夹具要用；裁定 4：不缓存、不取首个）。 */
    runtime: () => createRuntime(WS),
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

/** 真装配下建一条工作项（经服务面 createWorkItem，门禁在默认态是按开处理的）。 */
async function createItem(
  service: ISquadRuntimeService,
  assignee: WorkItem["assignee"],
): Promise<WorkItem> {
  return service.createWorkItem(WS, { title: "网关改造", assignee });
}

/** 读库（经服务面快照的唯一取数口）：这条工作项此刻的负责人。 */
async function readAssignee(
  service: ISquadRuntimeService,
  workItemId: string,
): Promise<WorkItem["assignee"] | undefined> {
  const snapshot = await service.getSnapshot(WS);
  return snapshot.workItems.find((item) => item.id === workItemId)?.assignee;
}

// ---------- 改派三态：user / agent / squad ----------

/* 指派给人：**只写负责人、不发派发请求**（hub 零调用）。
   「人不需要被派 run」——`planDispatch` 的 user 支路同样只通知、不排队；若这里发了请求，
   派发路径会为一条指派给人的工作项空转一次（并留下一条不自洽的 run 记录）。 */
test("改派给 user：写库、hub 零调用（指派给人 = 等人自己动手）", async () => {
  const { squadRuntimeService, published, assigneeWrites } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "agent", id: "ta-a" });

  const outcome = await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "user", id: "user" },
  });

  assert.deepEqual(outcome, { assigned: true }, "这是一次真实变更");
  assert.deepEqual(
    assigneeWrites,
    [{ id: item.id, assignee: { type: "user", id: "user" } }],
    "必须恰写一次负责人",
  );
  assert.deepEqual(
    await readAssignee(squadRuntimeService, item.id),
    { type: "user", id: "user" },
    "读库确认负责人真的改了",
  );
  assert.deepEqual(published, [], "指派给**人**不发派发请求（人不排队起 run）");
});

/* 指派给 agent：写库 + 请求**原样**到常驻 hub（这就是 host 派发桥接到的那个对象）。
   逐字段断言（workItemId / assignee / workspacePath / workspaceIdentity）：形状对不上，
   派发桥会拿着错的工作项或错的 workspace 去开 run —— 而它**不报错**。 */
test("改派给 agent：写库 + 派发请求原样到 hub（载荷带类型）", async () => {
  const { repoRoot, squadRuntimeService, published } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "user", id: "user" });

  const outcome = await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "agent", id: "ta-b" },
  });

  assert.deepEqual(outcome, { assigned: true });
  assert.deepEqual(await readAssignee(squadRuntimeService, item.id), { type: "agent", id: "ta-b" });
  assert.deepEqual(
    published,
    [
      {
        workItemId: item.id,
        assignee: { type: "agent", id: "ta-b" },
        // 成因：本次派发由**用户在界面上改派**发起（服务面在事件源头分好，hub 原样转发）。
        cause: "user_reassign",
        workspacePath: repoRoot,
        workspaceIdentity: WS.identity,
      },
    ],
    "派发请求必须原样到 hub（assignee 带类型；成因 user_reassign；workspace 取 runtime 的绑定值）",
  );
});

/* 指派给小队：与 agent 同形，只有**载荷类型**不同 —— 这正是「改派」必须走 `assignee` 的理由：
   负责人是 squad ⇒ 派发路径解析出一条**队长 run**（`planDispatch` 从快照重读工作项，请求只用于身份/日志）。 */
test("改派给 squad：写库 + 派发请求载荷类型是 squad", async () => {
  const { repoRoot, squadRuntimeService, published } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "user", id: "user" });

  const outcome = await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "squad", id: "sq-1" },
  });

  assert.deepEqual(outcome, { assigned: true });
  assert.deepEqual(await readAssignee(squadRuntimeService, item.id), { type: "squad", id: "sq-1" });
  assert.deepEqual(published, [
    {
      workItemId: item.id,
      assignee: { type: "squad", id: "sq-1" },
      cause: "user_reassign",
      workspacePath: repoRoot,
      workspaceIdentity: WS.identity,
    },
  ]);
});

// ---------- 同值 / 门禁 / 未命中 ----------

/* 同值改派：**不写、不发请求、返回 `{assigned:false}`**。
   重复指派给同一对象不该再起一次 run（队员 run 会撞工作树/分支名而响亮失败；队长 run 由 §5.7(1)
   合并）——「同一事实重投不产生第二次动作」与 Inbox 的幂等是同一条纪律。
   三条证据齐备：返回值（不动作的结论）+ 写 spy（没有写）+ hub（没有请求）。 */
test("同值改派：不写、不发请求、返回 {assigned:false}", async () => {
  const { squadRuntimeService, published, assigneeWrites } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "agent", id: "ta-a" });
  assigneeWrites.length = 0;

  const outcome = await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "agent", id: "ta-a" },
  });

  assert.deepEqual(outcome, { assigned: false }, "同值必须短路（不得再起一次 run）");
  assert.deepEqual(assigneeWrites, [], "同值不得写库");
  assert.deepEqual(published, [], "同值不得发派发请求");
  assert.deepEqual(await readAssignee(squadRuntimeService, item.id), { type: "agent", id: "ta-a" });
});

/* 门禁关闭：改派被拒（稳定码跨层可分流），且**一个 runtime 都没构造**、库不变、hub 零调用。
   「门禁在构造 runtime 之前过」在这条用例里由 seenTargets 直接证明：被拒的这次调用**没有**
   出现在见到的目标里 —— 非 git 目标上关开关时，调用方拿到的必须是门禁结论而不是「base 解析失败」。 */
test("门禁关闭：改派被拒（稳定码），且不构造 runtime、不写库、不发请求", async () => {
  const { squadRuntimeService, published, assigneeWrites, seenTargets, setExperimentEnabled } =
    await makeService();
  const item = await createItem(squadRuntimeService, { type: "agent", id: "ta-a" });
  assigneeWrites.length = 0;
  seenTargets.length = 0;
  setExperimentEnabled(false);

  await assert.rejects(
    () =>
      squadRuntimeService.reassignWorkItem(WS, {
        workItemId: item.id,
        assignee: { type: "agent", id: "ta-b" },
      }),
    (error: unknown) => (error as { code?: unknown }).code === SQUAD_DISPATCH_DISABLED_CODE,
    "关掉实验后改派必须被拒（SquadDispatchDisabledError 原样带出，按稳定码可分流）",
  );

  assert.deepEqual(seenTargets, [], "门禁被拒时不得构造 runtime（判据与目标是不是 git 仓库无关）");
  assert.deepEqual(assigneeWrites, [], "被拒时不得写库");
  assert.deepEqual(published, [], "被拒时不得发派发请求");
  assert.deepEqual(await readAssignee(squadRuntimeService, item.id), { type: "agent", id: "ta-a" });
});

/* 不存在 / 已归档：**响亮抛**（未命中不得静默 no-op —— 静默建新项会把派发挂到一个与
   调用方所指无关的对象上），且不写库、不发请求。 */
test("工作项不存在 / 已归档：响亮抛，不写库、不发请求", async () => {
  const { squadRuntimeService, runtime, published, assigneeWrites } = await makeService();

  await assert.rejects(
    () =>
      squadRuntimeService.reassignWorkItem(WS, {
        workItemId: "ghost",
        assignee: { type: "agent", id: "ta-a" },
      }),
    /ghost/,
    "不存在必须响亮且点名 id",
  );

  /* 已归档项：经 repo 落一条归档行（`insert` 明确不查父链、且允许写 `archivedAt`；服务面的
     `create` 只建未归档行 —— 正是那道闸让「归档行」这种数据只能这样重现）。
     `get` / `listByWorkspace` 都过滤归档 ⇒ 对读路径等同不存在。 */
  const archivedId = "wi-archived";
  (await runtime()).workItemRepo.insert({
    id: archivedId,
    workspaceIdentity: WS.identity,
    workspacePath: "/tmp/ws",
    title: "已归档",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: "ta-a" },
    labels: [],
    properties: {},
    position: 0,
    archivedAt: 1,
  });
  await assert.rejects(
    () =>
      squadRuntimeService.reassignWorkItem(WS, {
        workItemId: archivedId,
        assignee: { type: "agent", id: "ta-b" },
      }),
    /wi-archived/,
    "已归档必须响亮（归档行对读路径等同不存在）",
  );

  assert.deepEqual(assigneeWrites, [], "两次拒绝都不得写库");
  assert.deepEqual(published, [], "两次拒绝都不得发派发请求");
});

// ---------- assignWorkItem 回归（薄包装，对外行为不变） ----------

/* 薄包装回归：`assignWorkItem` 与改派**共用同一实现**，但其对外契约不变 ——
   入参形状、返回 `{assigned:true}`、过门禁、只支持 agent；hub 收到的载荷是 `{type:"agent"}`。
   再加一条**有意保留的差异**：同一队员**重复指派**（同值）照旧写 + 照旧发请求（重试入口）——
   把它静默 no-op 会让工具回执「已派发」而实际什么都没发生。 */
test("assignWorkItem 回归：返回形状不变、写库、hub 载荷是 agent assignee；同值重指派照旧写+发", async () => {
  const { repoRoot, squadRuntimeService, published, assigneeWrites } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "squad", id: "sq-1" });
  assigneeWrites.length = 0;

  const result = await squadRuntimeService.assignWorkItem(WS, {
    workItemId: item.id,
    agentId: "ta-a",
  });
  assert.deepEqual(result, { assigned: true }, "返回形状保持不变");
  assert.deepEqual(await readAssignee(squadRuntimeService, item.id), { type: "agent", id: "ta-a" });
  assert.deepEqual(published, [
    {
      workItemId: item.id,
      assignee: { type: "agent", id: "ta-a" },
      // 队长派单工具发起 ⇒ 成因 `leader_tool`（与 UI 改派的 `user_reassign` 是两档事实）。
      cause: "leader_tool",
      workspacePath: repoRoot,
      workspaceIdentity: WS.identity,
    },
  ]);

  // 同一队员再来一次：**照旧写 + 照旧发**（reapply 语义 —— 对同一队员的重试入口）。
  assigneeWrites.length = 0;
  published.length = 0;
  const repeat = await squadRuntimeService.assignWorkItem(WS, {
    workItemId: item.id,
    agentId: "ta-a",
  });
  assert.deepEqual(repeat, { assigned: true });
  assert.equal(assigneeWrites.length, 1, "同值重指派必须照旧写（重试入口，不得静默 no-op）");
  assert.equal(published.length, 1, "同值重指派必须照旧发派发请求");
});

/* 成因（`cause`）落在**事件载荷**上：两条调用面各传自己的值（队长工具 ⇒ `leader_tool`、
   UI 改派 ⇒ `user_reassign`）—— 服务面只搬运，不在这里反推。成因是台账 `dispatch_cause` 的源头，
   断言在**事件**这一层（不是只看 hub 转发后的副本）：漏传/传错的表现是「谁派的」在库里永久失真，
   而下游（hub → host → 台账）一路都不报错。 */
test("成因：reassignWorkItem ⇒ 事件 cause=user_reassign；assignWorkItem ⇒ leader_tool", async () => {
  const { squadRuntimeService, events } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "user", id: "user" });
  events.length = 0;

  await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  assert.deepEqual(
    events.filter((event) => event.kind === "workitem.dispatch_requested"),
    [
      {
        kind: "workitem.dispatch_requested",
        workItemId: item.id,
        assignee: { type: "agent", id: "ta-b" },
        cause: "user_reassign",
      },
    ],
    "UI 改派发出的派发事件必须带成因 user_reassign",
  );

  events.length = 0;
  await squadRuntimeService.assignWorkItem(WS, { workItemId: item.id, agentId: "ta-b" });
  assert.deepEqual(
    events.filter((event) => event.kind === "workitem.dispatch_requested"),
    [
      {
        kind: "workitem.dispatch_requested",
        workItemId: item.id,
        assignee: { type: "agent", id: "ta-b" },
        cause: "leader_tool",
      },
    ],
    "队长派单工具发出的派发事件必须带成因 leader_tool（同值 reapply 也照发）",
  );

  // 同值 skip 短路：不写、不发事件 ⇒ 也谈不上成因（回归：成因不得让 skip 多发一次事件）。
  events.length = 0;
  const skipped = await squadRuntimeService.reassignWorkItem(WS, {
    workItemId: item.id,
    assignee: { type: "agent", id: "ta-b" },
  });
  assert.deepEqual(skipped, { assigned: false });
  assert.deepEqual(events, [], "同值 skip 不得发事件（成因只随真实派发走）");
});

// ---------- 目标纪律 ----------

/* 目标显式（裁定 4）：改派把**调用方给的**目标原样交给 runtime（不挑不猜、没有隐式默认 workspace）。 */
test("目标纪律：reassignWorkItem 把调用方给的目标原样交给 runtime", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  const item = await createItem(squadRuntimeService, { type: "agent", id: "ta-a" });
  seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  await squadRuntimeService.reassignWorkItem(given, {
    workItemId: item.id,
    assignee: { type: "agent", id: "ta-b" },
  });

  assert.deepEqual(seenTargets, ["/tmp/given-ws|given"], "必须带着调用方显式给的目标（原样透传）");
});
