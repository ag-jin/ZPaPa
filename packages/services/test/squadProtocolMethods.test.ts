import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createProtocolSquadHandlers,
  type SquadProtocolResult,
} from "../src/zcode-agent/squadProtocolMethods.js";
import {
  createSquadRuntimeService,
  SQUAD_DISPATCH_DISABLED_CODE,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import type { WorkItemEvent } from "../src/workitem/workItemService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 队长派单三个协议方法的 **handler 层**用例（Task 7 追加范围 item ①）。

   为什么这一层的证据必须在 handler 上而不是只在服务层：服务层的方法早就有用例（squadRuntime.test.ts），
   而本任务要证明的是「三个 `squad/*` 协议方法**各自落到对应服务方法**」，以及「参数不合法 / 门禁关闭
   在 handler 这一层**响亮**（而不是回一个空洞的成功）」。删掉任一分支的服务调用，本文件的对应用例必须变红。

   口径纪律（逐条对应 brief 的硬约束）：
   - 目标 workspace **显式构造**（`target` 由用例给出，handler 不得有隐式默认）；
   - 唯一写者不变：handler 只经 `ISquadRuntimeService`，不碰 repo；
   - 门禁在服务层单点：本文件的替身是**真实** `ISquadRuntimeService`（真实 git + 真实 sqlite），
     不用桩假装 `createWorkItem` / `openMemberRun` 的业务语义。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

async function makeMemoryDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

/** 真实 runtime + 真实服务面（照 squadRuntime.test.ts 的装配法）。门禁可切。 */
async function makeService(options?: { enabled?: boolean }) {
  const repoRoot = await makeRepo();
  const db = await makeMemoryDb();
  const state = { enabled: options?.enabled ?? true };
  /** 记录服务面收到的目标 —— 用来证明 handler 把**调用方给的**目标原样交给服务面。 */
  const seenTargets: string[] = [];
  /** 工作项事件（含派发事件）—— handler 层的 ② 要断言「指派真的发出了派发事件」。
      订阅挂在**每个新构的 runtime** 上，与组合根同形（事件表在实例内，按目标现构 ⇒ 必须逐实例挂）。 */
  const events: WorkItemEvent[] = [];
  /** 响亮留痕（Minor-3 的子项缺失支路）—— 断言「不抛但有留痕」。 */
  const warnings: string[] = [];
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    const runtime = await createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
    runtime.subscribeWorkItemEvents((event) => events.push(event));
    return runtime;
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
    logWarn: (message) => warnings.push(message),
  });
  // handler 拿到的是**服务面的来路**（组合根在装配完成后回填）；测试里直接指向刚建的那一份。
  const handlers = createProtocolSquadHandlers({
    resolveSquadRuntimeService: () => squadRuntimeService,
  });
  const runtime = await createRuntime(target("ws"));
  return {
    repoRoot,
    runtime,
    handlers,
    seenTargets,
    events,
    warnings,
    setEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

/** 造一个父工作项（子项的挂载点）。 */
function makeParent(runtime: Awaited<ReturnType<typeof makeService>>["runtime"], repoRoot: string) {
  return runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "父项",
    assignee: { type: "squad", id: "sq-1" },
  });
}

/** 断言「响亮失败」并取回错误，便于逐字检查文案。 */
function expectRejected(result: SquadProtocolResult<unknown>): {
  code: number;
  message: string;
  data?: unknown;
} {
  assert.equal(result.ok, false, `本应响亮失败，实际成功：${JSON.stringify(result)}`);
  assert.ok(!result.ok);
  return result.error;
}

// ---------- ① 建子工作项 → createWorkItem ----------

// 承重：删掉 `squadRuntimeService.createWorkItem` 的调用，本用例必红（拿不到真实工作项）。
test("squad/create-child-work-item ⇒ 落到 createWorkItem（真实台账里出现子项）", async () => {
  const { runtime, repoRoot, handlers } = await makeService();
  const parent = makeParent(runtime, repoRoot);

  const result = await handlers.createChildWorkItem(target("ws"), {
    parentId: parent.id,
    title: "拆解 1",
    body: "约束",
    assigneeAgentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  const created = runtime.workItemRepo.get(result.result.workItemId);
  assert.ok(created, "协议回执里的 workItemId 必须是真实落库的那一条");
  assert.equal(created.parentId, parent.id, "子项必须挂在给定的父项下（丢父项会飘出树外）");
  assert.deepEqual(created.assignee, { type: "agent", id: "ta-a" }, "指派给队长指定的队员");
  assert.equal(created.status, "todo");
  assert.equal(created.workspaceIdentity, "ws", "落在 runtime 绑定的 workspace 上");
});

test("squad/create-child-work-item：body 省略也合法（可选字段）", async () => {
  const { runtime, repoRoot, handlers } = await makeService();
  const parent = makeParent(runtime, repoRoot);
  const result = await handlers.createChildWorkItem(target("ws"), {
    parentId: parent.id,
    title: "无 body",
    assigneeAgentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// 参数不合法必须**响亮**（-32602 一族），不得静默建一个空壳子项。
test("squad/create-child-work-item：缺 parentId / 多未知字段 ⇒ 可读的 -32602", async () => {
  const { handlers } = await makeService();
  const missingParent = expectRejected(
    await handlers.createChildWorkItem(target("ws"), {
      title: "t",
      assigneeAgentId: "ta-a",
    }),
  );
  assert.equal(missingParent.code, -32602);
  assert.match(missingParent.message, /parentId/);

  const unknownKey = expectRejected(
    await handlers.createChildWorkItem(target("ws"), {
      parentId: "wi-p",
      title: "t",
      assigneeAgentId: "ta-a",
      status: "done", // 协议面**刻意没有**状态字段（唯一写者不变）
    }),
  );
  assert.equal(unknownKey.code, -32602);
});

// 父项不存在：服务层（workItemService.validateParent）响亮抛，handler 原样带出去 —— 不得吞。
test("squad/create-child-work-item：父项不存在 ⇒ -32603 且点名父项 id", async () => {
  const { handlers } = await makeService();
  const error = expectRejected(
    await handlers.createChildWorkItem(target("ws"), {
      parentId: "no-such-parent",
      title: "t",
      assigneeAgentId: "ta-a",
    }),
  );
  assert.equal(error.code, -32603);
  assert.match(error.message, /no-such-parent/);
});

// ---------- ② 派给队员 → assignWorkItem（改负责人 + 发派发事件，**不**开 run） ----------

/* 裁定 Important-1（2026-10-02）：指派语义 = **改负责人 + 发出派发事件**，**不直接开 run**
   （§5.1「多路输入、一处写入」/ §5.6「`@` ≠ 指派」）。三条断言各自承重：
   ① 读库证明负责人真的改了；② 订阅**唯一出口**证明派发事件真的发了；③ 读库 + 读 git 证明
   **这次调用里没有直接产生 run**（没有台账行、没有工作树）。变异：把实现退回 `openMemberRun`
   ⇒ ③ 必红（本用例就是裁定点名的「未直接产生 run」那条）。 */
test("squad/assign-work-item ⇒ 改负责人 + 发派发事件 + **不**直接产生 run", async () => {
  const { runtime, repoRoot, handlers, events } = await makeService();
  const parent = makeParent(runtime, repoRoot);
  const child = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "子项",
    parentId: parent.id,
    assignee: { type: "squad", id: "sq-1" }, // 先指派给小队；派单把它改派给队员
  });
  events.length = 0;

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: child.id,
    agentId: "ta-a",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.equal(result.result.dispatched, true);

  // ① 负责人**真的**改了（读库实体状态，不是读返回值）。
  assert.deepEqual(
    runtime.workItemRepo.get(child.id)?.assignee,
    { type: "agent", id: "ta-a" },
    "指派必须把负责人改成指定队员",
  );

  // ② 派发事件经**唯一出口**发出，且是具体那一条（工作项 id + 对象都对；载荷是 `assignee`，
  //    类型 + id —— 2026-10-03 从裸 agentId 泛化，小队也能是被派发对象；成因 = 队长派单工具）。
  assert.deepEqual(
    events.filter((event) => event.kind === "workitem.dispatch_requested"),
    [
      {
        kind: "workitem.dispatch_requested",
        workItemId: child.id,
        assignee: { type: "agent", id: "ta-a" },
        cause: "leader_tool",
      },
    ],
    "指派必须发出派发事件（开 run 由派发路径负责，不是这里）",
  );

  // ③ 这次调用**没有**直接产生 run：既没有台账行，也没有工作树（§6.1 的隔离承诺由派发路径负责）。
  assert.deepEqual(runtime.squadRunRepo.listByParent(parent.id), [], "指派不得直接开台账行");
  assert.deepEqual(await runtime.worktreeManager.list(), [], "指派不得直接建工作树");
});

// 指派**只动负责人**这一列：status 与父子结构一个字节不动（唯一写者那条约束管的是 status）。
test("squad/assign-work-item：只改负责人（status 与父子结构不变）", async () => {
  const { runtime, repoRoot, handlers } = await makeService();
  const parent = makeParent(runtime, repoRoot);
  const child = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "子项",
    parentId: parent.id,
    assignee: { type: "agent", id: "ta-a" },
  });
  const before = runtime.workItemRepo.get(child.id);
  assert.ok(before);

  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: child.id,
    agentId: "ta-b",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = runtime.workItemRepo.get(child.id);
  assert.ok(after);
  assert.equal(after.status, before.status, "改负责人不得顺带改 status（唯一写者不变）");
  assert.equal(after.parentId, before.parentId, "改负责人不得动父子结构");
  assert.equal(after.title, before.title);
});

// 工作项不存在 ⇒ **响亮**（这是 CLI 侧「工作项不存在」那一格的 host 侧落点）。
test("squad/assign-work-item：工作项不存在 ⇒ 响亮且点名 id，不静默造行", async () => {
  const { runtime, handlers } = await makeService();
  const error = expectRejected(
    await handlers.assignWorkItem(target("ws"), { workItemId: "ghost", agentId: "ta-a" }),
  );
  assert.match(error.message, /ghost/);
  assert.deepEqual(runtime.squadRunRepo.listActive("ws"), [], "被拒时不得留下任何 run 行");
});

test("squad/assign-work-item：缺 workItemId / agentId ⇒ -32602", async () => {
  const { handlers } = await makeService();
  const missing = expectRejected(await handlers.assignWorkItem(target("ws"), { agentId: "ta-a" }));
  assert.equal(missing.code, -32602);
  assert.match(missing.message, /workItemId/);
});

// 无父项的顶层工作项也能被指派（改负责人 + 发事件），指派不依赖父子结构。
test("squad/assign-work-item：无父项的顶层工作项也能指派（改负责人 + 发事件）", async () => {
  const { runtime, repoRoot, handlers, events } = await makeService();
  const solo = runtime.workItemService.create({
    workspaceIdentity: "ws",
    workspacePath: repoRoot,
    title: "顶层",
    assignee: { type: "agent", id: "ta-a" },
  });
  events.length = 0;
  const result = await handlers.assignWorkItem(target("ws"), {
    workItemId: solo.id,
    agentId: "ta-b",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(runtime.workItemRepo.get(solo.id)?.assignee, { type: "agent", id: "ta-b" });
  assert.equal(events.filter((e) => e.kind === "workitem.dispatch_requested").length, 1);
  assert.deepEqual(runtime.squadRunRepo.listByParent(solo.id), [], "指派不得直接开 run");
});

// ---------- ③ 列花名册 → getSnapshot ----------

test("squad/list-roster ⇒ 落到 getSnapshot（花名册来自真实小队定义）", async () => {
  const { runtime, handlers } = await makeService();
  runtime.squadService.create({
    name: "小队",
    leaderAgentId: "ta-lead",
    members: ["ta-a", "ta-b"],
    instructions: { stopCondition: "全部通过", maxRounds: "3" },
  });
  const result = await handlers.listRoster(target("ws"), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.equal(result.result.leaderAgentId, "ta-lead");
  assert.deepEqual(
    result.result.members.map((member) => member.agentId).sort(),
    ["ta-a", "ta-b"],
    "队员列表不含队长（队长由 leaderAgentId 单列，CLI 侧两者取并集）",
  );
});

// 花名册读不出来时必须**响亮**——静默给一份空名册会让 CLI 的花名册校验把
// 所有队员都判成「不在名册」（把配置问题伪装成「派给了不存在的人」）。
test("squad/list-roster：没有小队 ⇒ 响亮（不静默给空名册）", async () => {
  const { handlers } = await makeService();
  const error = expectRejected(await handlers.listRoster(target("ws"), {}));
  assert.match(error.message, /小队/);
});

test("squad/list-roster：多个小队 ⇒ 响亮并列出候选（不许静默挑一个）", async () => {
  const { runtime, handlers } = await makeService();
  const instructions = { stopCondition: "s", maxRounds: "1" };
  runtime.squadService.create({ name: "A", leaderAgentId: "ta-a", members: [], instructions });
  runtime.squadService.create({ name: "B", leaderAgentId: "ta-b", members: [], instructions });
  const error = expectRejected(await handlers.listRoster(target("ws"), {}));
  assert.match(error.message, /ta-a/);
  assert.match(error.message, /ta-b/);
});

// 已归档的小队不参与候选（归档 = 长期退出，不该让在用小队的解析被它搅乱）。
test("squad/list-roster：已归档的小队不参与候选", async () => {
  const { runtime, handlers } = await makeService();
  const instructions = { stopCondition: "s", maxRounds: "1" };
  const stale = runtime.squadService.create({
    name: "旧",
    leaderAgentId: "ta-old",
    members: [],
    instructions,
  });
  runtime.squadService.archive(stale.id);
  runtime.squadService.create({
    name: "在用",
    leaderAgentId: "ta-lead",
    members: [],
    instructions,
  });
  const result = await handlers.listRoster(target("ws"), {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.equal(result.result.leaderAgentId, "ta-lead");
});

test("squad/list-roster：非法参数（未知字段）⇒ -32602", async () => {
  const { handlers } = await makeService();
  const error = expectRejected(await handlers.listRoster(target("ws"), { squadId: "sq-1" }));
  assert.equal(error.code, -32602);
});

// ---------- 门禁：稳定码原样带回（服务层单点） ----------

// 承重：两个派单动作在开关关闭时必须**原样**带回 `squad_dispatch_disabled`
//（吞掉它或改写成别的形状，队长就看不到唯一可行动的事实）。
test("门禁关闭：两个派单动作都原样带回 squad_dispatch_disabled，且不留派发痕迹", async () => {
  const { runtime, repoRoot, handlers, setEnabled } = await makeService();
  const parent = makeParent(runtime, repoRoot);
  setEnabled(false);

  const createError = expectRejected(
    await handlers.createChildWorkItem(target("ws"), {
      parentId: parent.id,
      title: "t",
      assigneeAgentId: "ta-a",
    }),
  );
  assert.equal(createError.code, -32603);
  assert.match(createError.message, /squad_dispatch_disabled/);
  assert.deepEqual(
    (createError.data as { code?: unknown } | undefined)?.code,
    SQUAD_DISPATCH_DISABLED_CODE,
    "稳定码要落在 data.code 上（跨 RPC 后按码分流，不靠读文案）",
  );

  const assignError = expectRejected(
    await handlers.assignWorkItem(target("ws"), { workItemId: parent.id, agentId: "ta-a" }),
  );
  assert.match(assignError.message, /squad_dispatch_disabled/);
  // 拦在入口：负责人**没有**被改动，也没有新的工作项或 run 行。
  assert.deepEqual(
    runtime.workItemRepo.get(parent.id)?.assignee,
    { type: "squad", id: "sq-1" },
    "门禁关闭时指派必须拦在改负责人之前（半个动作都没有）",
  );
  assert.equal(runtime.workItemRepo.listByWorkspace("ws").length, 1, "只有那个父项");
  assert.deepEqual(runtime.squadRunRepo.listActive("ws"), []);
});

// 补集方向：花名册是**只读**，不属「新派发」⇒ 门禁关闭时仍可用
//（否则队长连「派给谁」都查不了，§5.7.6 只停新派发）。
test("门禁关闭：只读的花名册查询不受影响", async () => {
  const { runtime, handlers, setEnabled } = await makeService();
  runtime.squadService.create({
    name: "小队",
    leaderAgentId: "ta-lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  setEnabled(false);
  const result = await handlers.listRoster(target("ws"), {});
  assert.equal(result.ok, true, JSON.stringify(result));
});

// ---------- 服务面没接上 / 目标无隐式默认 ----------

// 服务面取不到 ⇒ 按方法不存在响亮回执（照 offPeak/* 分支同形）：静默 no-op 会让队长
// 以为派单成功了，而队员永远不会被唤醒。
test("服务面未注册 ⇒ -32601 响亮回执，不静默 no-op", async () => {
  const handlers = createProtocolSquadHandlers({ resolveSquadRuntimeService: () => undefined });
  for (const call of [
    () =>
      handlers.createChildWorkItem(target("ws"), {
        parentId: "p",
        title: "t",
        assigneeAgentId: "a",
      }),
    () => handlers.assignWorkItem(target("ws"), { workItemId: "wi", agentId: "a" }),
    () => handlers.listRoster(target("ws"), {}),
  ]) {
    const error = expectRejected(await call());
    assert.equal(error.code, -32601);
    assert.match(error.message, /unavailable/);
  }
});

// 目标 workspace **显式**且真的被用上（裁定 4 / 确认 3：没有隐式默认、结构上不存在「取首个」）：
// handler 把**调用方给的**目标原样交给服务面（服务面再按它现构 runtime），而不是某个全局默认值。
test("显式目标被原样交给服务面（无隐式默认）", async () => {
  const { handlers, seenTargets } = await makeService();
  seenTargets.length = 0;
  await handlers.listRoster(target("alpha"), {}); // 没有小队 ⇒ 会响亮失败，但目标必须已经落到服务面
  assert.deepEqual(seenTargets, ["/tmp/alpha|alpha"]);
});

// ---------- 静态守卫：门禁判据只有服务层一处 ----------

/* 这三个 handler 是**新的派发入口**，最容易顺手写的就是「在这里再读一次开关」。
   一旦读了，判据就有第二份（改一处漏一处 ⇒ 关掉实验照旧派发），故用源码守卫钉住。 */
test("handler 模块不读实验开关，也不直写工作项状态 / 台账", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/zcode-agent/squadProtocolMethods.ts"),
    "utf8",
  );
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    withoutComments,
    /experimentalAgentSquadsEnabled/,
    "门禁判据只能有服务层一处",
  );
  // 唯一写者不变：handler 不得直写工作项状态，也不得自己 INSERT 台账。
  assert.doesNotMatch(withoutComments, /updateStatus|setStatus|\.insert\(/);
});

// 断言「三个方法各自落到对应服务方法」的**另一方向**：handler 只经服务描述符取数，
// 不得 import repo / workItemService（那是第二个写者与第二套口径的入口）。
//
// 先**剥注释**再匹配：注释里点名这些模块是合法的（它要说明「为什么不去碰它们」，例如
// 「缺的是哪个写入口」），而裸 grep 会把「解释了不 import 谁」判成「import 了谁」——
// 这正是本用例第一次被踩到的形态（一条解释性注释直接把断言变红，与被测事实无关）。
test("handler 模块只依赖服务面（不 import repo / workItemService）", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/zcode-agent/squadProtocolMethods.ts"),
    "utf8",
  );
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /workItemRepo|squadRunRepo|createWorkItemService|createWorkItemRepo/);
});
