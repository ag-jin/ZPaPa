import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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

/* 运行历史分页（#13）**独立穷举复验**（test-verifier，2026-10-07）。

   本文件是独立复验夹具：期望值来自拆解报告 §4.1–§4.3 的裁定（keyset + 不透明游标、
   DESC 呈现口径、`agentId` 下推 SQL、非法输入响亮抛、`nextCursor === null` 表示到底），
   不复用实现轮的用例文件。装配沿用本仓既有先例（真实 git 仓库 + `:memory:` sqlite +
   真实 runtime + 真实服务面），断言读**实体状态**（真 SQL 落盘、真 SQL 读回）。

   三条复验重点（本轮红线）：
   · **假空**：某个 agent 的行全部落在「本 workspace 最近 N 条」之外时，第一页仍必须含它
     —— 独立构造（别人的行全部更新，且**多出 limit 若干倍**）；
   · **翻页并集**：逐页走完，并集 = 全集、无重、严格 DESC（与 repo 的 ORDER BY 同向）；
   · **既有两个口径逐字不变**：`listSquadRuns`（全量 ASC）以**直接 SQL** 为独立基准，
     `getSnapshot().runs`（活跃集）只含 `SQUAD_RUN_ACTIVE_STATUSES` 三态。

   **已知缺口（2026-10-07 独立复验发现，尚未修复，故本文件不把它写成期望）**：
   生产环境的 `runId` = host 的 `eventKey`（`assign:<wi>:<type>:<id>:<uuid>` /
   `comment-dispatch:v1:…`），**含冒号**；而游标格式 `v1:<created_at>:<run_id>` 用 `:` 作分隔、
   解码要求恰好三段 ⇒ 页边界行是这类 id 时，**本实现给出的 nextCursor 自己读不回**（响亮抛
   「游标非法」），「加载更多」在真实台账上失败。修复时应同时补上「含冒号 run_id 的游标往返」
   回归用例（复现脚本见复验报告）。本文件只覆盖游标在**无冒号 id** 上的穷举行为。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });

const WS = target("ws");
const WS_KEY = resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });

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

async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return { db, squadRuntimeService, createRuntime };
}

/** 逐页走完（每页必须返回 ≤ limit 行；游标不推进 ⇒ 响亮失败而不是挂住）。 */
async function walk(
  service: ISquadRuntimeService,
  limit: number,
  agentId?: string,
): Promise<{ ids: string[]; pages: string[][]; cursors: Array<string | null> }> {
  const pages: string[][] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | undefined;
  for (let step = 0; step < 100; step += 1) {
    const page = await service.listSquadRunHistory(WS, {
      limit,
      ...(agentId === undefined ? {} : { agentId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(page.runs.length <= limit, "每页不得超过 limit");
    pages.push(page.runs.map((record) => record.runId));
    cursors.push(page.nextCursor);
    if (page.nextCursor === null) return { ids: pages.flat(), pages, cursors };
    cursor = page.nextCursor;
  }
  throw new Error("游标翻页超过 100 页仍未结束：nextCursor 没有推进");
}

// ---------- ① 假空（红线 1）：窗口外的 agent 行第一页必须看得见 ----------

test("红线｜假空：该 agent 的行全部落在「最新 limit 条」之外 ⇒ 第一页仍是它自己的行", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  // 别人的 40 条全部更新（created_at 1000..1039）；我的 5 条都在窗口之外（created_at 1..5）。
  for (let index = 0; index < 40; index += 1) {
    runtime.squadRunRepo.insert(
      run({ runId: `other-${index}`, agentId: "ta-other", createdAt: 1000 + index }),
    );
  }
  for (let index = 0; index < 5; index += 1) {
    runtime.squadRunRepo.insert(
      run({ runId: `mine-${index}`, agentId: "ta-mine", createdAt: 1 + index }),
    );
  }

  // 反证：**不带** agentId 的第一页（limit=10）里一条我的行都没有 —— 也就是说，若过滤发生在
  // 取数之后（前端过滤），界面在这一页只会看到「空」。
  const unfiltered = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 });
  assert.equal(
    unfiltered.runs.filter((record) => record.agentId === "ta-mine").length,
    0,
    "前提：该 agent 的行确实落在窗口之外（否则这条用例证明不了假空）",
  );

  const first = await service.squadRuntimeService.listSquadRunHistory(WS, {
    agentId: "ta-mine",
    limit: 10,
  });
  assert.deepEqual(
    first.runs.map((record) => record.runId),
    ["mine-4", "mine-3", "mine-2", "mine-1", "mine-0"],
    "过滤在 SQL 内（下推）：第一页就是该 agent 自己的最近 5 条，且最新在前",
  );
  assert.equal(first.nextCursor, null, "它只有 5 条（< limit）⇒ 到底");
});

test("红线｜假空 × 交错：我的行与别人的行**同刻交错**、我的行只占少数 ⇒ 逐页并集仍恰是我的集合", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 60; index += 1) {
    // 每个时刻两条：别人的 + 我的（我的在 created_at 上「插在中间」）。
    runtime.squadRunRepo.insert(
      run({ runId: `other-${index}`, agentId: "ta-other", createdAt: 100 + index * 2 }),
    );
    if (index % 3 === 0) {
      runtime.squadRunRepo.insert(
        run({ runId: `mine-${index}`, agentId: "ta-mine", createdAt: 101 + index * 2 }),
      );
    }
  }
  const expected = Array.from({ length: 20 }, (_, index) => `mine-${index * 3}`).reverse();

  const { ids, pages } = await walk(service.squadRuntimeService, 7, "ta-mine");
  assert.deepEqual(ids, expected, "并集 = 该 agent 的全部行（别人的行不占页、也不漏自己的行）");
  assert.equal(new Set(ids).size, ids.length, "无重复");
  assert.ok(
    pages.every((page) => page.length <= 7),
    "页大小受 limit 约束",
  );
});

// ---------- ② 翻页并集 / 序 / 同刻 tie-break ----------

test("穷举｜25 行 limit=10 ⇒ 3 页（10/10/5），并集 = 全集且严格 DESC", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 25; index += 1) {
    runtime.squadRunRepo.insert(
      run({ runId: `r-${String(index).padStart(2, "0")}`, createdAt: 100 + index }),
    );
  }
  const { ids, pages, cursors } = await walk(service.squadRuntimeService, 10);
  assert.deepEqual(
    pages.map((page) => page.length),
    [10, 10, 5],
  );
  assert.deepEqual(
    cursors.slice(0, 2).every((cursor) => typeof cursor === "string" && cursor.length > 0),
    true,
  );
  assert.equal(cursors[2], null);
  assert.deepEqual(
    ids,
    Array.from({ length: 25 }, (_, index) => `r-${String(24 - index).padStart(2, "0")}`),
    "并集 = 全集且严格 DESC（最新在前）",
  );
});

test("穷举｜同刻 tie-break：5 行 created_at 相同、limit=2 ⇒ 3 页（2/2/1），按 run_id DESC 不漏不重", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (const runId of ["t-a", "t-b", "t-c", "t-d", "t-e"]) {
    runtime.squadRunRepo.insert(run({ runId, createdAt: 500 }));
  }
  const { ids, pages } = await walk(service.squadRuntimeService, 2);
  assert.deepEqual(pages, [["t-e", "t-d"], ["t-c", "t-b"], ["t-a"]]);
  assert.equal(new Set(ids).size, 5);
});

test("穷举｜同刻 tie-break × agentId 过滤：过滤后仍按 (createdAt, runId) DESC 推进", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (const runId of ["m-1", "m-2", "m-3", "o-1", "o-2", "o-3"]) {
    runtime.squadRunRepo.insert(
      run({ runId, agentId: runId.startsWith("m") ? "ta-mine" : "ta-other", createdAt: 900 }),
    );
  }
  const { ids } = await walk(service.squadRuntimeService, 2, "ta-mine");
  assert.deepEqual(ids, ["m-3", "m-2", "m-1"], "同刻下按 run_id DESC，且只含自己的行");
});

test("keyset 抗插入：翻页途中新增**更新**的行不得被看到，也不得挤掉后面的行", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 6; index += 1) {
    runtime.squadRunRepo.insert(run({ runId: `old-${index}`, createdAt: 10 + index }));
  }
  const first = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 3 });
  assert.deepEqual(
    first.runs.map((record) => record.runId),
    ["old-5", "old-4", "old-3"],
  );

  // 台账在运行期持续插入（派发/重试）：新行必然比游标更新。
  runtime.squadRunRepo.insert(run({ runId: "brand-new", createdAt: 999 }));

  const second = await service.squadRuntimeService.listSquadRunHistory(WS, {
    limit: 3,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    second.runs.map((record) => record.runId),
    ["old-2", "old-1", "old-0"],
    "第二页只由游标决定：比游标新的行不出现（offset 分页会在这里重复/漏行），旧行一个不漏",
  );
  assert.ok(
    !second.runs.some((record) => record.runId === "brand-new"),
    "翻页途中新增的更新行不出现在后续页（否则界面会出现重复行）",
  );
});

test("keyset 边界（已裁定语义）：插在**游标之后**的行按 key 序被包含，且不重复、不漏行", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 6; index += 1) {
    runtime.squadRunRepo.insert(run({ runId: `old-${index}`, createdAt: 10 + index }));
  }
  const first = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 3 });
  const cursor = first.nextCursor!; // 指向 (createdAt 12, run_id old-3)

  // 补录一条**落在游标之后**（比游标旧、但比剩余页里的行新）的行：keyset 的语义是
  // 「按 (created_at, run_id) 继续」，所以它会被包含且只包含一次 —— 本用例把这条语义钉住。
  runtime.squadRunRepo.insert(run({ runId: "backfill", createdAt: 11.5 }));

  const { ids, pages } = await walk(service.squadRuntimeService, 3);
  assert.deepEqual(
    pages[1],
    ["old-2", "backfill", "old-1"],
    "落在游标之后的行按 key 序出现在该出现的位置",
  );
  assert.equal(new Set(ids).size, ids.length, "补录不得造成重复行");
  assert.deepEqual(
    [...ids].sort(),
    ["backfill", ...Array.from({ length: 6 }, (_, index) => `old-${index}`)].sort(),
    "并集仍是全集（补录行不漏）",
  );
  // 游标本体不得被后续插入改变（可重放）：同一游标再读一次仍是同一条结论。
  const again = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 3, cursor });
  assert.deepEqual(
    again.runs.map((record) => record.runId),
    pages[1],
    "同一游标重放结论逐字相同",
  );
});

test("穷举｜游标可重放（幂等读）：同一游标读两次得到同一页", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 5; index += 1) {
    runtime.squadRunRepo.insert(run({ runId: `r-${index}`, createdAt: 20 + index }));
  }
  const first = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2 });
  const cursor = first.nextCursor!;
  const a = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2, cursor });
  const b = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2, cursor });
  assert.deepEqual(
    a.runs.map((record) => record.runId),
    b.runs.map((record) => record.runId),
  );
  assert.equal(a.nextCursor, b.nextCursor, "同一游标两次读回同一结论（读操作不留状态）");
});

// ---------- ③ 边界：空 / 恰好 / 多一行 / 页大小上限 ----------

test("穷举｜边界：空台账 ⇒ 空页 + nextCursor null（空不是错误）", async () => {
  const service = await makeService();
  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 });
  assert.deepEqual(page, { runs: [], nextCursor: null });
});

test("穷举｜边界：行数 < limit / == limit / == limit+1 三格（只有第三格给游标）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 7; index += 1) {
    runtime.squadRunRepo.insert(run({ runId: `r-${index}`, createdAt: 30 + index }));
  }
  const under = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 8 });
  assert.equal(under.runs.length, 7);
  assert.equal(under.nextCursor, null, "少于页大小 ⇒ 到底");

  const exact = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 7 });
  assert.equal(exact.runs.length, 7);
  assert.equal(exact.nextCursor, null, "恰好一页 ⇒ 不给一个点不出东西的「加载更多」");

  const plus = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 6 });
  assert.equal(plus.runs.length, 6);
  assert.ok(plus.nextCursor, "多出一行 ⇒ 必须给游标");
  const rest = await service.squadRuntimeService.listSquadRunHistory(WS, {
    limit: 6,
    cursor: plus.nextCursor!,
  });
  assert.deepEqual(
    rest.runs.map((record) => record.runId),
    ["r-0"],
  );
  assert.equal(rest.nextCursor, null);
});

test("穷举｜边界：limit=1 逐页走完 7 行（页数与最后游标）；limit=200（上限）合法、201 抛", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  for (let index = 0; index < 7; index += 1) {
    runtime.squadRunRepo.insert(run({ runId: `r-${index}`, createdAt: 40 + index }));
  }
  const walked = await walk(service.squadRuntimeService, 1);
  assert.equal(walked.pages.length, 7, "limit=1 ⇒ 7 页");
  assert.deepEqual(
    walked.pages.map((page) => page[0]),
    ["r-6", "r-5", "r-4", "r-3", "r-2", "r-1", "r-0"],
  );

  const atUpperBound = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 200 });
  assert.equal(atUpperBound.runs.length, 7, "上限值本身合法（≥1 且 ≤200 的整数）");
  assert.equal(atUpperBound.nextCursor, null);
});

test("穷举｜非法 limit 一律响亮抛：0 / -1 / 201 / 1.5 / NaN / ±Infinity / 字符串数字", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "r-0" }));
  for (const limit of [
    0,
    -1,
    -0.5,
    201,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit }),
      /limit/,
      `limit=${String(limit)} 必须抛（静默变成怪查询是最坏的一种）`,
    );
  }
  await assert.rejects(
    // @ts-expect-error 故意传字符串：运行期越界输入也要响亮（不得被当成合法页大小）
    () => service.squadRuntimeService.listSquadRunHistory(WS, { limit: "10" }),
    /limit/,
  );
});

test("穷举｜非法游标一律响亮抛（不回落第一页）：形状 / 版本 / 时间 / 多余段 / 前后空白", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "r-0", createdAt: 1 }));
  const invalid = [
    "",
    "v1",
    "v1:",
    "v1:1",
    "v2:1:r-0",
    "V1:1:r-0",
    "1:r-0",
    "v1:abc:r-0",
    "v1:1.5:r-0",
    "v1:-1:r-0",
    "v1: 1:r-0",
    " v1:1:r-0",
    "v1:1:r-0:extra",
    "v1:01:r-0",
    "v1:1e3:r-0",
    "v1:9007199254740993:r-0",
  ];
  for (const cursor of invalid) {
    await assert.rejects(
      () => service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2, cursor }),
      /游标/,
      `非法游标「${JSON.stringify(cursor)}」必须抛（回落第一页会把分页 bug 伪装成「又刷了一遍」）`,
    );
  }
});

// ---------- ④ 第三口径与既有两口径各自显式（回归，独立基准 = 直接 SQL） ----------

test("回归｜listSquadRuns 与直接 SQL 的全量台账逐行相同（全状态、created_at ASC, run_id ASC）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const statuses = ["open", "queued", "produced", "rejected", "merged", "discarded"] as const;
  statuses.forEach((status, index) => {
    runtime.squadRunRepo.insert(run({ runId: `s-${status}`, status, createdAt: 100 - index }));
  });
  // 同刻两行（验证 tie-break 由 run_id 决定，而不是插入序）。
  runtime.squadRunRepo.insert(run({ runId: "tie-b", status: "merged", createdAt: 200 }));
  runtime.squadRunRepo.insert(run({ runId: "tie-a", status: "open", createdAt: 200 }));
  runtime.squadRunRepo.insert(run({ runId: "别的-ws", workspaceKey: "other-key", createdAt: 1 }));

  const fromRepo = (await service.squadRuntimeService.listSquadRuns(WS)).map(
    (record) => record.runId,
  );
  const fromSql = (
    service.db
      .prepare(
        "SELECT run_id FROM squad_runs WHERE workspace_key = ? ORDER BY created_at ASC, run_id ASC",
      )
      .all(WS_KEY) as Array<{
      run_id: string;
    }>
  ).map((row) => row.run_id);
  assert.deepEqual(
    fromRepo,
    fromSql,
    "全量口径 = 直接 SQL 的基准序（含终态行；别的 workspace 的行不混入）",
  );
  assert.equal(fromRepo.length, 8, "六个状态 + 同刻两行（statuses 6 + tie 2）");
  assert.equal(fromRepo.includes("别的-ws"), false, "workspace 隔离");
});

test("回归｜getSnapshot().runs = 活跃三态（open/produced/rejected），paging 口径不得影响它", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  const statuses = ["open", "queued", "produced", "rejected", "merged", "discarded"] as const;
  statuses.forEach((status, index) => {
    runtime.squadRunRepo.insert(run({ runId: `s-${status}`, status, createdAt: 10 + index }));
  });
  const before = (await service.squadRuntimeService.getSnapshot(WS)).runs.map(
    (record) => record.runId,
  );
  assert.deepEqual(
    before,
    ["s-open", "s-produced", "s-rejected"],
    "活跃集 = SQUAD_RUN_ACTIVE_STATUSES 三态",
  );

  // 走一遍分页：不得改动活跃集、也不得改动台账（只读）。
  await walk(service.squadRuntimeService, 2);
  const after = (await service.squadRuntimeService.getSnapshot(WS)).runs.map(
    (record) => record.runId,
  );
  assert.deepEqual(after, before, "分页读不得改变活跃集口径");
  const rows = service.db.prepare("SELECT count(*) AS n FROM squad_runs").get() as { n: number };
  assert.equal(rows.n, statuses.length, "分页是只读的：台账行数不变");
});

test("口径分离｜分页口径是全状态 DESC 且有界；三个口径互不替代（同一份台账逐条对照）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "a-open", status: "open", createdAt: 1 }));
  runtime.squadRunRepo.insert(run({ runId: "b-merged", status: "merged", createdAt: 2 }));
  runtime.squadRunRepo.insert(run({ runId: "c-queued", status: "queued", createdAt: 3 }));

  assert.deepEqual(
    (await service.squadRuntimeService.listSquadRuns(WS)).map((record) => record.runId),
    ["a-open", "b-merged", "c-queued"],
    "口径一：全量 ASC（宿主判定与批内时间线要全集）",
  );
  assert.deepEqual(
    (await service.squadRuntimeService.getSnapshot(WS)).runs.map((record) => record.runId),
    ["a-open"],
    "口径二：活跃集（还欠收尾）",
  );
  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 2 });
  assert.deepEqual(
    page.runs.map((record) => record.runId),
    ["c-queued", "b-merged"],
    "口径三：有界（limit 生效）+ DESC（呈现最新在前）",
  );
});

test("口径分离｜分页口径不吃 parentWorkItemId：不同父项的行一起出现（批内读仍是 listSquadRuns）", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "wi-1-run", parentWorkItemId: "wi-1", createdAt: 1 }));
  runtime.squadRunRepo.insert(run({ runId: "wi-2-run", parentWorkItemId: "wi-2", createdAt: 2 }));
  runtime.squadRunRepo.insert(
    run({ runId: "leader-run", isLeaderTask: true, parentWorkItemId: "wi-1", createdAt: 3 }),
  );

  const page = await service.squadRuntimeService.listSquadRunHistory(WS, { limit: 10 });
  assert.deepEqual(
    page.runs.map((record) => record.runId),
    ["leader-run", "wi-2-run", "wi-1-run"],
    "该口径只有 agentId / limit / cursor 三个输入：批内过滤不属于它",
  );
});

test("回归｜workspace 隔离与目标显式：异己 workspace_key 的行在任何一页都读不到", async () => {
  const service = await makeService();
  const runtime = await service.createRuntime(WS);
  runtime.squadRunRepo.insert(run({ runId: "mine", createdAt: 1 }));
  for (let index = 0; index < 5; index += 1) {
    runtime.squadRunRepo.insert(
      run({ runId: `other-ws-${index}`, workspaceKey: "other-key", createdAt: 100 + index }),
    );
  }
  const { ids } = await walk(service.squadRuntimeService, 3);
  assert.deepEqual(ids, ["mine"], "只读本目标解析出的 workspace_key 的行");
});
