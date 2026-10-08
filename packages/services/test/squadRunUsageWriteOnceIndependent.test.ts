import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRunRepo,
  type SquadRunRecord,
  type SquadRunUsageSnapshot,
} from "../src/workitem/squadRunRepo.js";
import {
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* CT.V（#6 成本记账线整线独立复验）—— **write-once 独立穷举**（data plane）。

   本文件由 test-verifier 独立构造：不复用实现者用例的任何夹具 / 字面量 / 断言形态，
   只复用**公开接缝**（`createSquadRunRepo` / 真迁移 / 真 runtime / 真服务面）。

   要钉的四件事实（CT.1 冻结语义）：
   ① 首写生效且**只写 usage_\* 9 列 + updated_at**（身份列/状态列逐列不变）；
   ② 重投（同值/换值）零改写：`{written:false}` 且 raw 行（含 updated_at）逐列不变；
   ③ 未命中 runId 在 repo 与**真服务面**两处都响亮抛（不得静默混同「已记录」）；
   ④ 并发写：两连接顺序先到者赢；单连接**写入窗口内对手先落账**时后写者零改写
     —— 并附探针自检（去掉 `AND usage_recorded_at IS NULL` 的朴素写法会被同一探针抓到），
     证明该用例对「WHERE 守卫被删」这一回归是敏感的。 */

const ROW_CORE = {
  workspaceKey: "ws",
  workspacePath: "/tmp/ws",
  workItemId: "wi-1",
  parentWorkItemId: "wi-1",
  agentId: "ta-1",
  isLeaderTask: false,
  branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
  dirName: "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb",
  sessionId: "sess-1",
  dispatchCause: null,
  causedByRunId: null,
  openedAt: 11,
  settleReason: null,
  createdAt: 111,
  updatedAt: 111,
} as const;

/** 独立夹具：一条终态 run 行（9 个用量列 = 未记录）。 */
const row = (runId: string, over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
  ...ROW_CORE,
  runId,
  status: "merged",
  ...over,
});

/** 独立字面量（期望值不按实现方式重算）；两组装载数值**逐列不同**。 */
const USAGE_FIRST: SquadRunUsageSnapshot = {
  totalTokens: 31337,
  inputTokens: 20000,
  outputTokens: 11337,
  reasoningTokens: 4096,
  cacheCreationTokens: 512,
  cacheReadTokens: 1024,
  modelRequestCount: 9,
  modelErrorCount: 2,
};
const USAGE_SECOND: SquadRunUsageSnapshot = {
  totalTokens: 990099,
  inputTokens: 880088,
  outputTokens: 110011,
  reasoningTokens: 1,
  cacheCreationTokens: 2,
  cacheReadTokens: 3,
  modelRequestCount: 4,
  modelErrorCount: 5,
};

/** raw 行快照（含 updated_at）：sorted 键值对 ⇒ deepEqual 不受键序/原型影响。 */
const rawRow = (db: DatabaseSync, runId: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(
      db.prepare("SELECT * FROM squad_runs WHERE run_id = ?").get(runId) as Record<string, unknown>,
    ).sort(([a], [b]) => a.localeCompare(b)),
  );

const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
};

test("首写：{written:true}，8 数值逐列与入参相等 + recorded_at 落定；状态/身份列逐列不变", () => {
  const db = freshDb();
  const repo = createSquadRunRepo(db);
  repo.insert(row("first-write"));
  const before = repo.get("first-write")!;

  assert.deepEqual(repo.recordUsage("first-write", USAGE_FIRST), { written: true });

  const after = repo.get("first-write")!;
  assert.deepEqual(
    [
      after.usageTotalTokens,
      after.usageInputTokens,
      after.usageOutputTokens,
      after.usageReasoningTokens,
      after.usageCacheCreationTokens,
      after.usageCacheReadTokens,
      after.usageModelRequestCount,
      after.usageModelErrorCount,
    ],
    [31337, 20000, 11337, 4096, 512, 1024, 9, 2],
    "8 个数值列逐列等于入参字面量",
  );
  assert.ok(
    typeof after.usageRecordedAt === "number" && after.usageRecordedAt > 0,
    "存在性开关必须落定（NULL = 未记录）",
  );
  for (const key of [
    "runId",
    "workspaceKey",
    "workspacePath",
    "workItemId",
    "parentWorkItemId",
    "agentId",
    "isLeaderTask",
    "branch",
    "dirName",
    "status",
    "sessionId",
    "dispatchCause",
    "causedByRunId",
    "openedAt",
    "settleReason",
    "createdAt",
  ] as const) {
    assert.deepEqual(after[key], before[key], `${key} 不得被用量写入改动`);
  }
  assert.ok(after.updatedAt >= before.updatedAt, "落账要留下时间痕迹");
});

test("重投零改写（同值 / 换值两组）：{written:false} 且 raw 行含 updated_at 逐列不变", () => {
  const db = freshDb();
  const repo = createSquadRunRepo(db);
  repo.insert(row("re-record"));
  repo.recordUsage("re-record", USAGE_FIRST);
  const rawFirst = rawRow(db, "re-record");
  const readFirst = repo.get("re-record")!;

  assert.deepEqual(
    repo.recordUsage("re-record", USAGE_FIRST),
    { written: false },
    "同值重投 no-op",
  );
  assert.deepEqual(rawRow(db, "re-record"), rawFirst, "同值重投：raw 行逐列不变（含 updated_at）");

  assert.deepEqual(
    repo.recordUsage("re-record", USAGE_SECOND),
    { written: false },
    "换值重投同样是合法重投（先到者赢），不得抛",
  );
  assert.deepEqual(rawRow(db, "re-record"), rawFirst, "换值重投：raw 行逐列不变（含 updated_at）");
  assert.deepEqual(repo.get("re-record"), readFirst, "读回仍等于首写快照");

  // 敏感性：若是「后写覆盖」形态，本断言必须红 —— 用真 stmt 的 changes 直接观察。
  const update = db
    .prepare(
      "UPDATE squad_runs SET usage_total_tokens = ? WHERE run_id = ? AND usage_recorded_at IS NULL",
    )
    .run(1, "re-record");
  assert.equal(update.changes, 0, "已记录行的 guarded UPDATE 必须 affects 0 rows（含 NULL 守卫）");
});

test("未命中 runId：repo 与真服务面两处都响亮抛；库中不产生任何新行", () => {
  const db = freshDb();
  const repo = createSquadRunRepo(db);
  repo.insert(row("existing-row"));
  const rowsBefore = (db.prepare("SELECT count(*) AS n FROM squad_runs").get() as { n: number }).n;

  assert.throws(
    () => repo.recordUsage("no-such-run", USAGE_FIRST),
    /no-such-run/,
    "repo 层未命中必须抛且文案点名 runId",
  );

  const service = createSquadRuntimeService({
    createRuntime: () =>
      createSquadRuntime({
        db,
        workspacePath: "/tmp/ws",
        workspaceIdentity: "ws",
        readExperimentEnabled: () => true,
      }),
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) =>
      archiveSquadAndTransfer(
        await createSquadRuntime({
          db,
          workspacePath: "/tmp/ws",
          workspaceIdentity: t.identity,
          readExperimentEnabled: () => true,
        }),
        id,
      ),
  });
  return service
    .recordSquadRunUsage(
      { path: "/tmp/ws", identity: "ws" },
      { runId: "also-missing", usage: USAGE_FIRST },
    )
    .then(
      () => assert.fail("服务面未命中 runId 必须 reject"),
      (error: unknown) => {
        assert.match(String((error as Error).message), /also-missing/);
        const rowsAfter = (
          db.prepare("SELECT count(*) AS n FROM squad_runs").get() as { n: number }
        ).n;
        assert.equal(rowsAfter, rowsBefore, "失败路径不得留下任何行（新增或改写）");
        assert.deepEqual(
          [repo.get("existing-row")!.usageTotalTokens, repo.get("existing-row")!.usageRecordedAt],
          [null, null],
          "别的行不得被牵连（仍为未记录）",
        );
      },
    );
});

test("并发｜两连接顺序（真文件库）：先到者赢，后写者零改写；两个方向同结论", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctv-usage-2conn-"));
  try {
    const file = join(dir, "tasks.sqlite");
    const connA = new DatabaseSync(file);
    runTasksDatabaseMigrations(connA);
    const connB = new DatabaseSync(file);
    const repoA = createSquadRunRepo(connA);
    const repoB = createSquadRunRepo(connB);

    repoA.insert(row("two-conn-a-first"));
    assert.deepEqual(repoA.recordUsage("two-conn-a-first", USAGE_FIRST), { written: true });
    const rawAfterA = rawRow(connB, "two-conn-a-first");
    assert.deepEqual(
      repoB.recordUsage("two-conn-a-first", USAGE_SECOND),
      { written: false },
      "连接 B 看到的是「已记录」⇒ 幂等 no-op（跨连接可见性是先决条件）",
    );
    assert.deepEqual(rawRow(connB, "two-conn-a-first"), rawAfterA, "B 的尝试零改写");

    repoA.insert(row("two-conn-b-first"));
    assert.deepEqual(repoB.recordUsage("two-conn-b-first", USAGE_SECOND), { written: true });
    const rawAfterB = rawRow(connA, "two-conn-b-first");
    assert.deepEqual(repoA.recordUsage("two-conn-b-first", USAGE_FIRST), { written: false });
    assert.deepEqual(rawRow(connA, "two-conn-b-first"), rawAfterB, "A 的尝试零改写（反向同结论）");

    const readBack = repoA.get("two-conn-b-first")!;
    assert.equal(readBack.usageTotalTokens, 990099, "保留的是先到者（B）的整组值");
    assert.equal(readBack.usageReasoningTokens, 1);
    connA.close();
    connB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写入窗口探针：任何「UPDATE squad_runs SET … usage_total_tokens …」在真正执行前，
 *  先让对手臂（真实 repo，走同一真连接）完成一次落账 —— 模拟「检查与写入之间被打断」的交错。 */
function withRivalInjection(db: DatabaseSync, onWriteWindow: () => void): DatabaseSync {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (!/^UPDATE squad_runs SET[\s\S]*usage_total_tokens/.test(sql)) return stmt;
      return {
        run: (...args: unknown[]) => {
          onWriteWindow();
          return (stmt.run as (...a: unknown[]) => unknown)(...args);
        },
      };
    },
  } as unknown as DatabaseSync;
}

test("并发｜单连接模拟竞态：写入窗口内对手先落账 ⇒ 后写者零改写（探针自检证敏感）", () => {
  const db = freshDb();
  const rival = createSquadRunRepo(db);
  rival.insert(row("race-1"));

  let rivalWonAt: number | null = null;
  const racy = createSquadRunRepo(
    withRivalInjection(db, () => {
      rival.recordUsage("race-1", USAGE_SECOND);
      rivalWonAt = rival.get("race-1")!.usageRecordedAt ?? null;
    }),
  );

  assert.deepEqual(
    racy.recordUsage("race-1", USAGE_FIRST),
    { written: false },
    "对手在窗口内已落账 ⇒ 本次必须得 {written:false}（先读后写形态会返回 {written:true}）",
  );
  const after = rival.get("race-1")!;
  assert.deepEqual(
    [after.usageTotalTokens, after.usageReasoningTokens, after.usageRecordedAt],
    [USAGE_SECOND.totalTokens, USAGE_SECOND.reasoningTokens, rivalWonAt],
    "行内容 = 先到者（对手）整组值，后写者零改写",
  );

  /* ---- 探针自检（not product code）：同一交错下，一条**没有** NULL 守卫的朴素 UPDATE 会被后写者覆盖。
     若实现丢掉 `AND usage_recorded_at IS NULL`，上面的断言必然红 —— 本探针证明该断言对这条回归敏感。 */
  const db2 = freshDb();
  const rival2 = createSquadRunRepo(db2);
  rival2.insert(row("race-2"));
  const naiveDb = withRivalInjection(db2, () => {
    rival2.recordUsage("race-2", USAGE_SECOND);
  });
  const now = Date.now();
  naiveDb
    .prepare(
      `UPDATE squad_runs SET usage_total_tokens = ?, usage_input_tokens = ?, usage_output_tokens = ?,
         usage_reasoning_tokens = ?, usage_cache_creation_tokens = ?, usage_cache_read_tokens = ?,
         usage_model_request_count = ?, usage_model_error_count = ?, usage_recorded_at = ?
       WHERE run_id = ?`,
    )
    .run(
      USAGE_FIRST.totalTokens,
      USAGE_FIRST.inputTokens,
      USAGE_FIRST.outputTokens,
      USAGE_FIRST.reasoningTokens,
      USAGE_FIRST.cacheCreationTokens,
      USAGE_FIRST.cacheReadTokens,
      USAGE_FIRST.modelRequestCount,
      USAGE_FIRST.modelErrorCount,
      now,
      "race-2",
    );
  assert.equal(
    rival2.get("race-2")!.usageTotalTokens,
    USAGE_FIRST.totalTokens,
    "探针自检：无守卫的朴素写法在同一交错下确实会覆盖先到者 ⇒ 主断言对该回归敏感",
  );
});

test("NULL ≠ 0：未记录读回恰 null（非 0 / undefined）；记录全 0 ⇒ 读回 0 且 recorded_at 非空", () => {
  const db = freshDb();
  const repo = createSquadRunRepo(db);
  repo.insert(row("null-vs-zero"));
  const never = repo.get("null-vs-zero")!;

  for (const key of [
    "usageTotalTokens",
    "usageInputTokens",
    "usageOutputTokens",
    "usageReasoningTokens",
    "usageCacheCreationTokens",
    "usageCacheReadTokens",
    "usageModelRequestCount",
    "usageModelErrorCount",
    "usageRecordedAt",
  ] as const) {
    assert.strictEqual(never[key], null, `${key} 未记录时必须恰为 null（不得 0 / undefined）`);
  }

  const zero: SquadRunUsageSnapshot = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: 0,
    modelErrorCount: 0,
  };
  assert.deepEqual(repo.recordUsage("null-vs-zero", zero), { written: true });
  const recorded = repo.get("null-vs-zero")!;
  assert.deepEqual(
    [
      recorded.usageTotalTokens,
      recorded.usageInputTokens,
      recorded.usageOutputTokens,
      recorded.usageReasoningTokens,
      recorded.usageCacheCreationTokens,
      recorded.usageCacheReadTokens,
      recorded.usageModelRequestCount,
      recorded.usageModelErrorCount,
    ],
    [0, 0, 0, 0, 0, 0, 0, 0],
    "全 0 是合法事实（跑过但零消耗）",
  );
  assert.ok(typeof recorded.usageRecordedAt === "number", "关键区分位：recorded_at 非空");
});

test("数值闸在 repo 单点：经真服务面传负数/小数/NaN ⇒ 响亮抛且 9 列保持 NULL", async () => {
  const db = freshDb();
  const repo = createSquadRunRepo(db);
  repo.insert(row("gate-row", { workspaceKey: "ws" }));
  const makeRuntime = () =>
    createSquadRuntime({
      db,
      workspacePath: "/tmp/ws",
      workspaceIdentity: "ws",
      readExperimentEnabled: () => true,
    });
  const service = createSquadRuntimeService({
    createRuntime: makeRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await makeRuntime(), id),
  });
  const target: SquadWorkspaceTarget = { path: "/tmp/ws", identity: "ws" };

  for (const bad of [-1, 2.5, Number.NaN]) {
    await assert.rejects(
      () =>
        service.recordSquadRunUsage(target, {
          runId: "gate-row",
          usage: { ...USAGE_FIRST, outputTokens: bad },
        }),
      /usage_output_tokens/,
      `outputTokens=${String(bad)} 必须经服务面直落 repo 的闸（点名列名）`,
    );
  }
  assert.deepEqual(
    [repo.get("gate-row")!.usageTotalTokens, repo.get("gate-row")!.usageRecordedAt],
    [null, null],
    "闸在 SQL 之前：非法值一个也不落盘",
  );
});

test("服务面读回链（listSquadRunHistory）：未记录行 9 列恰 null；落账后逐列可见（UI 的取数面）", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const identity = "ctv-read-ws";
  const target: SquadWorkspaceTarget = { path: repoRoot, identity };
  const makeRuntime = (t: SquadWorkspaceTarget) =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
    });
  const service = createSquadRuntimeService({
    createRuntime: makeRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await makeRuntime(t), id),
  });
  const runtime = await makeRuntime(target);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: repoRoot,
    workspaceIdentity: identity,
  });
  runtime.squadRunRepo.insert(row("history-unrecorded", { workspaceKey, workspacePath: repoRoot }));
  runtime.squadRunRepo.insert(row("history-recorded", { workspaceKey, workspacePath: repoRoot }));
  runtime.squadRunRepo.recordUsage("history-recorded", USAGE_FIRST);

  const first = await service.listSquadRunHistory(target, { limit: 10 });
  const byId = new Map(first.runs.map((entry) => [entry.runId, entry]));
  const unrecorded = byId.get("history-unrecorded")!;
  const recorded = byId.get("history-recorded")!;
  assert.deepEqual(
    [
      unrecorded.usageTotalTokens,
      unrecorded.usageInputTokens,
      unrecorded.usageReasoningTokens,
      unrecorded.usageRecordedAt,
    ],
    [null, null, null, null],
    "读回链不得猜值：未记录行经服务面仍恰为 null",
  );
  assert.deepEqual(
    [recorded.usageTotalTokens, recorded.usageReasoningTokens, typeof recorded.usageRecordedAt],
    [31337, 4096, "number"],
    "已记录行经同一读取面逐列可见（UI 侧无需二次取数）",
  );
});
