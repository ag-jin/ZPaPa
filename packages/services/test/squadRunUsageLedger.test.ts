import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceKey } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRunRecord, SquadRunUsageSnapshot } from "../src/workitem/squadRunRepo.js";
import {
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* #6「按 run 用量记账」的**服务面 + 不变式**（CT.1）：`recordSquadRunUsage` 是 host 三臂捕获
   的落账入口（CT.2 消费），本文件钉住它的契约与三条不变式：

   ① **NULL ≠ 0**：`usage_recorded_at IS NULL` = **未记录**（没有会话 / 补拉没成功），
      与合法值 0（跑过但没消耗）必须可区分——把 NULL 折成 0 会把「没记账」伪装成「没花用量」；
   ② **write-once**：一次落账后二次不同值零改写（来源是会话累计值，重拉只会变大；先到者赢）；
   ③ **只动 usage_\* 9 列 + updated_at**：不碰 status / 身份列（与 bindSession「只写一列」同纪律）。

   另有两道写路径闸：runId 空串（trim 后为空）、数值非负整数——非法值一律响亮抛且**不落盘**。
   repo 层的写入 / 幂等 / 未命中三格在 squadRunRepo.test.ts（那里是真 repo 的直接面）。

   装配：真 git 仓库 + `:memory:` sqlite + 真 runtime + 真服务面（照 squadRunHistoryPaging.test.ts
   的先例）——服务面经 target 现构 runtime，台账行经真 repo / 真 SQL 落盘，不给 repo 塞桩。 */

const target = (identity: string): SquadWorkspaceTarget => ({ path: `/tmp/${identity}`, identity });

const WS = target("ws");
/** 台账 workspace_key 与 runtime 的绑定值同源（C14：identity 非空时优先于 path）。 */
const WS_KEY = resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });

/** 造一条 run 行（只覆写用例关心的字段；9 个用量列缺省 = 未记录）。 */
const row = (over: Partial<SquadRunRecord> = {}): SquadRunRecord => ({
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
  sessionId: "sess-1",
  dispatchCause: null,
  causedByRunId: null,
  openedAt: 1,
  settleReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** 一组独立字面量的用量快照（期望值不按实现的方式重算）。 */
const USAGE: SquadRunUsageSnapshot = {
  totalTokens: 12345,
  inputTokens: 10000,
  outputTokens: 2345,
  reasoningTokens: 678,
  cacheCreationTokens: 111,
  cacheReadTokens: 222,
  modelRequestCount: 7,
  modelErrorCount: 1,
};

/** 「跑过但零消耗」是合法事实（与「未记录」必须可区分）。 */
const ZERO_USAGE: SquadRunUsageSnapshot = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  modelRequestCount: 0,
  modelErrorCount: 0,
};

/** 9 列读回值按固定顺序摊平（NULL 与 0 的对照矩阵用；顺序与列定义一致）。 */
const readUsage = (record: SquadRunRecord): Array<number | null | undefined> => [
  record.usageTotalTokens,
  record.usageInputTokens,
  record.usageOutputTokens,
  record.usageReasoningTokens,
  record.usageCacheCreationTokens,
  record.usageCacheReadTokens,
  record.usageModelRequestCount,
  record.usageModelErrorCount,
  record.usageRecordedAt,
];

/** 真 runtime + 真服务面（照 squadRunHistoryPaging.test.ts 的装配法）。 */
async function makeService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const makeRuntime = (t: SquadWorkspaceTarget): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => true,
    });
  const squadRuntimeService = createSquadRuntimeService({
    createRuntime: makeRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await makeRuntime(t), id),
  });
  return { squadRuntimeService, makeRuntime };
}

test("recordSquadRunUsage：经 target 的 runtime 落账，读回 8 数值列与入参逐一相等", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(row({ runId: "r-usage" }));

  await squadRuntimeService.recordSquadRunUsage(WS, { runId: "r-usage", usage: USAGE });

  const after = runtime.squadRunRepo.get("r-usage")!;
  assert.equal(after.usageTotalTokens, 12345);
  assert.equal(after.usageInputTokens, 10000);
  assert.equal(after.usageOutputTokens, 2345);
  assert.equal(after.usageReasoningTokens, 678);
  assert.equal(after.usageCacheCreationTokens, 111);
  assert.equal(after.usageCacheReadTokens, 222);
  assert.equal(after.usageModelRequestCount, 7);
  assert.equal(after.usageModelErrorCount, 1);
  assert.equal(typeof after.usageRecordedAt, "number", "存在性开关必须落定（NULL = 未记录）");
});

// 「未记录」与「跑过但零消耗」是两个事实，必须双向可区分：这是记账面可信度的底线
//（渲染 0 会把「没记账」伪装成「没消耗」）。
test("NULL ≠ 0 双向：未记录读回 9 列全 NULL；显式记录全 0 ⇒ 读回 0 且 usageRecordedAt 非空", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(row({ runId: "r-usage" }));

  assert.deepEqual(
    readUsage(runtime.squadRunRepo.get("r-usage")!),
    [null, null, null, null, null, null, null, null, null],
    "未记录 ⇒ 9 列全 NULL（不得折成 0 / undefined 混用）",
  );

  await squadRuntimeService.recordSquadRunUsage(WS, { runId: "r-usage", usage: ZERO_USAGE });

  const after = runtime.squadRunRepo.get("r-usage")!;
  assert.deepEqual(
    readUsage(after).slice(0, 8),
    [0, 0, 0, 0, 0, 0, 0, 0],
    "记录全 0 ⇒ 8 列读回 0（合法事实：跑过但没消耗）",
  );
  assert.equal(typeof after.usageRecordedAt, "number", "第 9 位是记账时刻（非空）");
});

test("write-once：二次不同值零改写（读回逐字段等于首次落账）", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(row({ runId: "r-usage" }));

  await squadRuntimeService.recordSquadRunUsage(WS, { runId: "r-usage", usage: USAGE });
  const first = runtime.squadRunRepo.get("r-usage")!;

  await squadRuntimeService.recordSquadRunUsage(WS, {
    runId: "r-usage",
    usage: { ...USAGE, totalTokens: 999999, inputTokens: 888888, modelRequestCount: 999 },
  });

  assert.deepEqual(runtime.squadRunRepo.get("r-usage"), first, "先到者赢：二次值不得覆盖首次值");
});

test("只动 usage_* 9 列 + updated_at：status / 身份列 / settleReason 逐列不变", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(
    row({ runId: "r-usage", status: "produced", settleReason: "watchdog_ttl", openedAt: 42 }),
  );
  const before = runtime.squadRunRepo.get("r-usage")!;

  await squadRuntimeService.recordSquadRunUsage(WS, { runId: "r-usage", usage: USAGE });

  const after = runtime.squadRunRepo.get("r-usage")!;
  assert.equal(after.status, "produced", "用量不是「状态推进」：status 不得被改");
  assert.equal(after.runId, before.runId);
  assert.equal(after.agentId, before.agentId);
  assert.equal(after.workItemId, before.workItemId);
  assert.equal(after.parentWorkItemId, before.parentWorkItemId);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.branch, before.branch);
  assert.equal(after.dirName, before.dirName);
  assert.equal(after.settleReason, "watchdog_ttl");
  assert.equal(after.openedAt, 42);
  assert.equal(after.createdAt, before.createdAt);
  assert.ok(
    after.updatedAt > before.updatedAt,
    "落账必须留下时间痕迹（updated_at 由 repo 自己戳）",
  );
});

test("数值闸：负数 / 小数 / NaN 一律响亮抛且不落盘", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(row({ runId: "r-usage" }));

  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () =>
        squadRuntimeService.recordSquadRunUsage(WS, {
          runId: "r-usage",
          usage: { ...USAGE, totalTokens: bad },
        }),
      /usage_total_tokens/,
      `totalTokens=${String(bad)} 必须响亮抛（点名列名）`,
    );
  }
  assert.deepEqual(
    readUsage(runtime.squadRunRepo.get("r-usage")!),
    [null, null, null, null, null, null, null, null, null],
    "非法值绝不落盘（闸在 SQL 之前）",
  );
});

test("runId 空串 / 纯空白响亮抛且不落盘", async () => {
  const { squadRuntimeService, makeRuntime } = await makeService();
  const runtime = await makeRuntime(WS);
  runtime.squadRunRepo.insert(row({ runId: "r-usage" }));

  for (const bad of ["", "   "]) {
    await assert.rejects(
      () => squadRuntimeService.recordSquadRunUsage(WS, { runId: bad, usage: USAGE }),
      /runId/,
      `runId=「${bad}」必须响亮抛`,
    );
  }
  assert.deepEqual(
    readUsage(runtime.squadRunRepo.get("r-usage")!),
    [null, null, null, null, null, null, null, null, null],
    "空 runId 不落盘",
  );
});

/* ---------- 结构守卫（G 族）：源码扫描（去注释），防「顺手」破坏上面用行为钉住的纪律 ---------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(TEST_DIR, "../src");
const read = (relative: string) => readFileSync(resolve(SRC_ROOT, relative), "utf8");
/** 去注释（块 + 行）：错误文案 / 注释里的词不算数，只有**代码**里的才算（照 C3 复验同款）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const REPO_CODE = stripComments(read("workitem/squadRunRepo.ts"));
const LIFECYCLE_CODE = stripComments(read("workitem/squadRunLifecycle.ts"));
const SCHEMA_CODE = stripComments(read("session/tasksDatabase/schema-v1.ts"));

// G1：收口形态未被污染——用量是**异步补写**（终端事件之后的一次拉取），而 `settleStatus` 是
// **同步单点**。塞进去会把「同步收尾」变成可能阻塞 / 可能失败的路径（R4），故结构上禁止。
test("G1 守卫｜squadRunLifecycle 不出现 recordUsage / usageRecordedAt（用量不进同步收口）", () => {
  for (const token of ["recordUsage", "usageRecordedAt", "usage_recorded_at"]) {
    assert.equal(
      LIFECYCLE_CODE.includes(token),
      false,
      `squadRunLifecycle.ts 不得出现 ${token}：用量不进 settleStatus 的同步收口（它是异步补写）`,
    );
  }
});

// G2：写 SQL 列白名单——`recordUsage` 只写 usage_* 9 列 + updated_at，不碰 status / 身份列
//（与 bindSession「只写一列」同纪律）。recordUsage 是文件里最后一个方法，尾部只有收尾括号。
test("G2 守卫｜recordUsage 实现体只出现 usage_* 9 列 + updated_at（零 status / 身份列）", () => {
  const start = REPO_CODE.indexOf("recordUsage(runId, usage)");
  assert.ok(start > 0, "找不到 recordUsage 的实现（方法名被改？守卫失效 = 静默无保护）");
  const body = REPO_CODE.slice(start);
  for (const token of [
    "status",
    "workspace_key",
    "workspace_path",
    "work_item_id",
    "parent_work_item_id",
    "agent_id",
    "is_leader_task",
    "branch",
    "dir_name",
    "session_id",
    "dispatch_cause",
    "caused_by_run_id",
    "opened_at",
    "settle_reason",
  ]) {
    assert.equal(body.includes(token), false, `recordUsage 不得更新 ${token}（用量不是状态推进）`);
  }
  for (const column of [
    "usage_total_tokens",
    "usage_input_tokens",
    "usage_output_tokens",
    "usage_reasoning_tokens",
    "usage_cache_creation_tokens",
    "usage_cache_read_tokens",
    "usage_model_request_count",
    "usage_model_error_count",
    "usage_recorded_at",
    "updated_at",
  ]) {
    assert.ok(body.includes(column), `recordUsage 必须写 ${column}`);
  }
  // write-once 的结构证据：前置条件写进语句本身（并发下 READ-then-WRITE 会让两次补拉都写）。
  assert.ok(
    body.includes("run_id = ? AND usage_recorded_at IS NULL"),
    "write-once 的 WHERE 前置必须在语句里（`usage_recorded_at IS NULL`）",
  );
});

// G3：零回填——0015 的 SQL 只有 ALTER，没有 UPDATE（0014 有回填是因为有近似起点 created_at；
// 用量没有近似起点：没有会话就没有用量）。
test("G3 守卫｜SQUAD_RUN_USAGE_SQL 只加列零回填（不含 UPDATE/DELETE）", () => {
  const start = SCHEMA_CODE.indexOf("SQUAD_RUN_USAGE_SQL = `");
  assert.ok(start > 0, "找不到 SQUAD_RUN_USAGE_SQL（迁移常量被改？）");
  const sql = SCHEMA_CODE.slice(start, SCHEMA_CODE.indexOf("`;", start));
  assert.equal(sql.includes("UPDATE"), false, "0015 不得含 UPDATE（零回填：回填无事实可依）");
  assert.equal(sql.includes("DELETE"), false, "0015 不得含 DELETE");
  assert.equal(
    sql.match(/ALTER TABLE squad_runs ADD COLUMN/g)?.length,
    9,
    "0015 恰 9 条 ALTER TABLE ADD COLUMN",
  );
});

// G5：零猜值——用量读回路径不得出现 `?? 0`（NULL = 未记录，折成 0 会把「没记账」伪装成「没消耗」）。
test("G5 守卫｜usage 读回路径零 `?? 0`（NULL 原样透出）", () => {
  assert.equal(
    /usage\w*\s*\?\?\s*0/.test(REPO_CODE),
    false,
    "squadRunRepo.ts 不得把 usage 缺值折成 0（NULL 与 0 是两件事）",
  );
});

// G7：列集断言单源——`squad_runs` 的列集断言只在恰两处测试文件
//（workItemMigration.test.ts 的升级路径 / squadRunRepo.test.ts 的读回路径），不得散成第三处。
test("G7 守卫｜squad_runs 列集断言恰两处测试文件", () => {
  /* 针脚拼接 + **去注释**后扫描：否则本守卫文件**自己**命中针脚（注释里为解释而写的那串字面量），
     扫描集就永远多一个自己 —— 那正是「守卫靠自身豁免」的形态。本文件同样按同口径扫描：
     若它自己长出真断言，这里会当场变红。 */
  const needle = "table_info" + "(squad_runs)";
  const holders = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => stripComments(readFileSync(resolve(TEST_DIR, name), "utf8")).includes(needle))
    .sort();
  assert.deepEqual(holders, ["squadRunRepo.test.ts", "workItemMigration.test.ts"]);
});
