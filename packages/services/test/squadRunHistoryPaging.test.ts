import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRunRecord } from "../src/workitem/squadRunRepo.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 运行台账的**呈现用分页历史**（欠账 #13，2026-10-07 裁定：keyset + 不透明游标）的用例。

   装配照 squadTimelineData.test.ts 的同一先例：真实 git 仓库 + `:memory:` sqlite + 真实
   runtime + 真实服务面 —— 台账行经真 repo 的 `insert` 落盘（真 SQL），不给服务面塞桩。

   本文件钉住的核心问题是**假空**：详情页原来「拉全量 + 前端按 agentId 过滤 + 截断 50」，
   一旦服务面改成有界分页，前端过滤就会在第一页里看不到该 agent 的任何行 ⇒ 界面显示
   「没有运行记录」而库里明明有，且**不报错**。故 `agentId` 必须下推 SQL（变异 P1-1）。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });

const WS = target("ws");
/** 台账 workspace_key 与 runtime 的绑定值同源（C14：identity 非空时优先于 path）。 */
const WS_KEY = resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });

/** 造一条 run 行（只覆写用例关心的字段）。 */
const run = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  runId: "run-1",
  workspaceKey: WS_KEY,
  workspacePath: "/tmp/ws",
  workItemId: "wi-1",
  parentWorkItemId: "wi-1",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: null,
  dirName: null,
  status: "merged",
  sessionId: null,
  dispatchCause: null,
  causedByRunId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** 真实 runtime + 真实服务面（照 squadRosterManagement.test.ts 的装配法）。 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  const seenTargets: string[] = [];
  const makeRuntime = (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    return makeRuntime(t);
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return {
    squadRuntimeService,
    makeRuntime,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

type Service = Awaited<ReturnType<typeof makeService>>;

/** 逐页翻完（页大小 limit），返回每页与游标轨迹。翻页时**必须**用上一页给的 nextCursor。 */
async function readAllPages(
  service: ISquadRuntimeService,
  limit: number,
  agentId?: string,
): Promise<{ pages: string[][]; cursors: Array<string | null> }> {
  const pages: string[][] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | undefined;
  // 上限保护：游标不推进时（bug）用例要**红**而不是挂住。
  for (let step = 0; step < 50; step += 1) {
    const page = await service.listSquadRunHistory(WS, {
      limit,
      ...(agentId === undefined ? {} : { agentId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(page.runs.map((record) => record.runId));
    cursors.push(page.nextCursor);
    if (page.nextCursor === null) return { pages, cursors };
    cursor = page.nextCursor;
  }
  throw new Error("游标翻页超过 50 页仍未结束：nextCursor 没有推进");
}

/** 造 N 条「别人的」行（created_at 递增，newer 全部落在前面 ⇒ 老行的窗口外）。 */
async function seedOtherRuns(service: Service, count: number, base = 1000) {
  const runtime = await service.makeRuntime(WS);
  for (let index = 0; index < count; index += 1) {
    runtime.squadRunRepo.insert(
      run({
        runId: `other-${String(index).padStart(3, "0")}`,
        agentId: "ta-other",
        createdAt: base + index,
        updatedAt: base + index,
      }),
    );
  }
}

// ---------- ① 分页骨架：三页翻完、并集 = 全集、无重复 ----------

test("listSquadRunHistory：25 行 limit=10 ⇒ 3 页，游标递进、并集 = 全集且无重复", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 25);

  const { pages, cursors } = await readAllPages(service.squadRuntimeService, 10);

  assert.deepEqual(
    pages.map((page) => page.length),
    [10, 10, 5],
    "每页页大小",
  );
  assert.equal(cursors[2], null, "末页 nextCursor = null（到底）");
  for (const cursor of cursors.slice(0, 2)) assert.ok(cursor, "非末页必须给游标");
  const ids = pages.flat();
  assert.equal(new Set(ids).size, ids.length, "翻页并集无重复（keyset 不得重读同一行）");
  assert.deepEqual(
    [...ids].sort(),
    Array.from({ length: 25 }, (_, index) => `other-${String(index).padStart(3, "0")}`).sort(),
    "并集 = 全集（不漏行）",
  );
});

/* 变异（P1-3）：把排序改回 ASC（或与 `ORDER_BY_CREATED` 共用前缀）⇒ 本用例必红。
   呈现口径是**最新在前**（与详情页原来的 `.sort(desc)` 一致）。 */
test("listSquadRunHistory：第一页首条是**最新**的一条（DESC 呈现口径）", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 3); // created_at 1000 / 1001 / 1002
  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2 });
  assert.deepEqual(
    page.runs.map((record) => record.runId),
    ["other-002", "other-001"],
  );
});

/* 变异（P1-2）：游标谓词只比 created_at（丢掉 run_id tie-break）⇒ 本用例漏/重一行。 */
test("listSquadRunHistory：同刻多行（created_at 相同）靠 run_id 定序，翻页不漏不重", async () => {
  const service = await makeService();
  const runtime = await service.makeRuntime(WS);
  for (const runId of ["run-a", "run-b", "run-c"]) {
    runtime.squadRunRepo.insert(
      run({ runId, isLeaderTask: false, createdAt: 777, updatedAt: 777 }),
    );
  }

  const { pages } = await readAllPages(service.squadRuntimeService, 2);
  assert.deepEqual(
    pages.map((page) => page.length),
    [2, 1],
    "第 2 页恰好补齐第 3 行",
  );
  assert.deepEqual(pages[0], ["run-c", "run-b"], "同刻按 run_id DESC 定序");
  assert.deepEqual(pages[1], ["run-a"]);
});

// 边界：**恰好**一页 ⇒ 不给多余游标（给了会让界面出现一个点不出东西的「加载更多」）。
test("listSquadRunHistory：行数恰好等于 limit ⇒ nextCursor = null（不多不少）", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 3);
  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 3 });
  assert.equal(page.runs.length, 3);
  assert.equal(page.nextCursor, null, "满页但确实到底 ⇒ 不得给非 null 游标");
});

// ---------- ② 非法输入一律响亮（不得静默回落第一页） ----------

/* 变异（P1-4）：非法游标静默回落第一页 ⇒ 本用例必红。
   回落是最坏的一种：分页 bug 会表现成「又刷了一遍第一页」，用户与开发者都看不出。 */
test("listSquadRunHistory：非法游标 / 非法 limit ⇒ 响亮抛", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 2);
  const invalidCursors = [
    "",
    "v1",
    "v1:1",
    "v1:abc:run-a",
    "v2:1:run-a",
    "1:run-a",
    "v1:1:run-a:extra",
  ];
  for (const cursor of invalidCursors) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2, cursor }),
      /游标/,
      `非法游标「${cursor}」必须响亮抛`,
    );
  }
  for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit }),
      /limit|上限/,
      `非法 limit「${String(limit)}」必须响亮抛`,
    );
  }
});

// ---------- ③ agentId 下推 SQL（**核心**：假空） ----------

/* 变异（P1-1，**核心**）：去掉 SQL 的 agent_id 过滤（回到前端过滤）⇒ 本用例必红：
   该 agent 的三条行都在「本 workspace 最近 10 条」之外，第一页会一条都看不到 ——
   界面于是显示「暂无运行记录」，而库里明明有（静默假空）。 */
test("listSquadRunHistory：agentId 过滤下推 SQL —— 该 agent 的行落在窗口之外时第一页仍有它", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 15); // 别人的 15 条都很新（1000..1014）
  const runtime = await service.makeRuntime(WS);
  for (const [index, createdAt] of [3, 2, 1].entries()) {
    runtime.squadRunRepo.insert(
      run({
        runId: `mine-${String(index)}`,
        agentId: "ta-mine",
        createdAt,
        updatedAt: createdAt,
      }),
    );
  }

  const first = await service.squadRuntimeService.listSquadRunHistory(WS, {
    agentId: "ta-mine",
    limit: 10,
  });
  assert.deepEqual(
    first.runs.map((record) => record.runId),
    ["mine-0", "mine-1", "mine-2"],
    "第一页必须是该 agent 自己的最近 3 条（前端过滤会在这一页看到空 = 假空）",
  );
  assert.equal(first.nextCursor, null, "它只有 3 条 ⇒ 到底");
});

test("listSquadRunHistory：过滤 + 分页的游标在同一 agent 内推进（不跨对象跳）", async () => {
  const service = await makeService();
  const runtime = await service.makeRuntime(WS);
  // 交错插入：别人的行与我的行在同一时间轴上。
  for (let index = 0; index < 8; index += 1) {
    runtime.squadRunRepo.insert(
      run({
        runId: `other-${index}`,
        agentId: "ta-other",
        createdAt: 100 + index,
        updatedAt: 100 + index,
      }),
    );
    runtime.squadRunRepo.insert(
      run({
        runId: `mine-${index}`,
        agentId: "ta-mine",
        createdAt: 100 + index,
        updatedAt: 100 + index,
      }),
    );
  }

  const { pages } = await readAllPages(service.squadRuntimeService, 3, "ta-mine");
  assert.deepEqual(
    pages.map((page) => page.length),
    [3, 3, 2],
    "8 条自己的行 ⇒ 3 页",
  );
  const ids = pages.flat();
  assert.deepEqual(
    ids,
    Array.from({ length: 8 }, (_, index) => `mine-${7 - index}`),
    "只推进自己的行（别人的行不得占页），且 DESC",
  );
});

// ---------- ④ 服务面纪律 ----------

test("listSquadRunHistory：目标显式、workspace 隔离、不用 parentWorkItemId", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 2);
  const runtime = await service.makeRuntime(WS);
  runtime.squadRunRepo.insert(
    run({ runId: "other-ws", workspaceKey: "别的 key", createdAt: 9_999, updatedAt: 9_999 }),
  );
  service.seenTargets.length = 0;

  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "given" };
  const page = await service.squadRuntimeService.listSquadRunHistory(given, { limit: 10 });

  assert.deepEqual(
    service.seenTargets,
    ["/tmp/given-ws|given"],
    "调用必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
  assert.deepEqual(
    page.runs,
    [],
    "另一个 workspace 的行**不得**混进来（按本目标解析出的 workspace_key 过滤；空页不是错误）",
  );
  assert.deepEqual(
    (await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 })).runs.map(
      (record) => record.runId,
    ),
    ["other-001", "other-000"],
    "显式指回本 workspace 时才读得到（且异己 workspace_key 的 other-ws 行始终不在）",
  );
  // 批内口径（parentWorkItemId）**不是**本方法的输入：它只有 agentId / limit / cursor 三个入参。
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/workitem/squadRuntimeService.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    !/listSquadRunHistory[\s\S]{0,120}parentWorkItemId/.test(source),
    "分页历史不得接受 parentWorkItemId（批内读仍是 listSquadRuns 的全量口径）",
  );
});

// 读历史不是新派发：门禁只停「新派发」（§5.7.6），关掉开关后仍应能复盘已经跑过什么。
test("listSquadRunHistory：不过门禁（关掉实验开关仍可读）", async () => {
  const service = await makeService();
  await seedOtherRuns(service, 2);
  service.setExperimentEnabled(false);
  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 });
  assert.equal(page.runs.length, 2);
});

/* 回归钉子（**只加不改**）：新增第三个口径不得动既有两个 ——
   `listSquadRuns`（全量台账，宿主判定用）与 `getSnapshot().runs`（活跃集）逐字不变。 */
test("回归｜listSquadRuns 与 getSnapshot().runs 的输出逐字不变（新方法不改旧口径）", async () => {
  const service = await makeService();
  const runtime = await service.makeRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "active", status: "open", createdAt: 1 }));
  runtime.squadRunRepo.insert(run({ runId: "done", status: "merged", createdAt: 2 }));
  runtime.squadRunRepo.insert(run({ runId: "queued", status: "queued", createdAt: 3 }));

  assert.deepEqual(
    (await service.squadRuntimeService.listSquadRuns(WS)).map((record) => record.runId),
    ["active", "done", "queued"],
    "全量历史：全状态、created_at ASC（与新增分页口径互不替代）",
  );
  assert.deepEqual(
    (await service.squadRuntimeService.getSnapshot(WS)).runs.map((record) => record.runId),
    ["active"],
    "活跃集：只列未合并的 run",
  );
  const paged = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 });
  assert.deepEqual(
    paged.runs.map((record) => record.runId),
    ["queued", "done", "active"],
    "分页口径自带方向：created_at DESC（第三个口径，与上面两个各自显式）",
  );
});

// ---------- ⑤ 结构守卫（口径分离 / 游标单源 / 零迁移） ----------

const SERVICES_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const REPO_ROOT = resolve(SERVICES_SRC, "../../..");
const readRepoFile = (relativePath: string) =>
  readFileSync(resolve(REPO_ROOT, relativePath), "utf8");

/* 呈现口径**不得**成为宿主数据面：宿主三处读台账都要**全量**（评论补投判据 / 补投判据 /
   看门狗 tick 要终态行）。宿主若改用分页口径，会静默漏判（少补投、漏结算）—— 而那些错
   没有断言看得见，只有这一条结构守卫能拦。 */
test("守卫｜宿主（desktop）零命中分页口径，三处全量读仍在", () => {
  const hostFiles = [
    "packages/desktop/src/host/index.ts",
    "packages/desktop/src/host/squadDispatch.ts",
    "packages/desktop/src/host/squadWatchdogTick.ts",
  ];
  for (const file of hostFiles) {
    const source = readRepoFile(file);
    assert.ok(
      !source.includes("listSquadRunHistory"),
      `${file} 不得用呈现分页口径当数据面（宿主判定要全量台账）`,
    );
  }
  assert.ok(readRepoFile(hostFiles[0]!).includes("listSquadRuns("), "评论补投仍走全量口径");
  assert.ok(readRepoFile(hostFiles[2]!).includes("listSquadRuns("), "看门狗 tick 仍走全量口径");
});

/* 游标编解码只有 repo 一处实现（服务面与界面都不得解析）：解析 = 第二份判据，且格式一改
   两边就漂移（漂移的表现是「翻页偶尔漏一行」，没人看得出来）。 */
test("守卫｜游标的不透明契约：服务面与 UI 都不解析游标内容", () => {
  for (const file of ["workitem/squadRuntimeService.ts"]) {
    const source = readFileSync(resolve(SERVICES_SRC, file), "utf8");
    assert.ok(!source.includes("decodeRunHistoryCursor"), `${file} 不得解析游标`);
    assert.ok(!source.includes(`${"v1"}:`), `${file} 不得知道游标格式`);
  }
  const uiPage = readRepoFile("packages/ui/src/squad/SquadAgentDetailPage.tsx");
  assert.ok(!uiPage.includes("decodeRunHistoryCursor"), "详情页不得解析游标");
  assert.ok(!uiPage.includes(`${"v1"}:`), "详情页不得知道游标格式（原样带回即可）");
  const uiViewModel = readRepoFile("packages/ui/src/squad/squadRunHistoryViewModel.ts");
  assert.ok(!uiViewModel.includes(`${"v1"}:`), "UI 视图模型不得知道游标格式");
});

/* 默认方案是**零迁移**（拆解 §4.6）：分页只改读路径。
   原断言「迁移栈末位仍是 0014」是**当时状态**的代理，0015 落地后即失效——0015 已由主会话
   **排他分配**给 #6 用量记账（CT.1，见 `reports/2026-10-08-cost-tier-breakdown.md` §2.5），
   故「栈里出现新迁移」不再等价于「分页轮加了迁移」。这里改钉**真实意图**：迁移栈里不得出现
   分页轮自己的迁移对象（分页读路径不依赖新列 / 新索引），并保留「分页索引迁移必须另开号」的负向断言。 */
test("守卫｜零迁移：迁移栈无分页轮自己的迁移（分页只改读路径，不加列也不加索引）", () => {
  const migrations = readRepoFile("packages/services/src/session/tasksDatabase/migrations.ts");
  const ids = [...migrations.matchAll(/id: "(00\d\d_[a-z_]+)"/g)].map((match) => match[1]!);
  for (const id of ids) assert.ok(!id.includes("history"), `分页轮不得自带迁移：${id}`);
  assert.ok(
    !ids.includes("0015_squad_run_history_indexes"),
    "分页索引迁移仍未开轮（0015 由 #6 用量记账占用）",
  );
});
