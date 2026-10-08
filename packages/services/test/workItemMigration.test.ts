import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { WORK_ITEM_SCHEMA } from "../src/session/tasksDatabase/schema-v1.js";

function openFreshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function workItemColumns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function workItemIndexes(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_items%'")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}

function ledger(db: DatabaseSync): Array<{ id: string; checksum: string }> {
  return db.prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id").all() as Array<{
    id: string;
    checksum: string;
  }>;
}

const EXPECTED_WORK_ITEM_INDEXES = [
  "idx_work_items_parent",
  "idx_work_items_status",
  "idx_work_items_workspace",
];

// 与已发布数据库的契约：这些 checksum 一旦被改动，老库升级会抛 checksum_mismatch。
// 值是**字面量**，不是「在测试里再用当前代码算一遍」——两侧重算等于什么都没测。
// 这里只登记「已经发布过」的迁移；**最新那一条无需登记**，会被用例自动排除（见下），
// 所以新增迁移不会让本用例假红。
const PINNED_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = {
  "0001_adopt_task_schema": "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17",
  "0002_provider_selection": "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc",
  "0003_official_glm_selection": "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4",
  "0004_work_items": "4624e06f937f4112752c7d24238e78c004eda45400475357231e08c050082d7f",
  "0005_wake_rules": "a2308d0724eae27813d92b5c8742a2de9aad68c5c6429601312483a0bd21b618",
};

// 「最新那条迁移建出了什么」无法从库里反推，故在此显式登记，用来把库退回上一版的样子。
// **新增迁移时同步维护一行**（不维护也能通过：缺登记时只是不 drop 对象，模拟退化一档，
// 因为 DDL 都带 IF NOT EXISTS，重跑不会炸——这是本用例能自适配的关键）。
// 登记行按迁移累加，但用例只读当前最新 id 的那一行（旧行留着是为了让历史痕迹可读，不参与断言）。
const LATEST_MIGRATION_ARTIFACTS: Readonly<Record<string, readonly string[]>> = {
  "0005_wake_rules": ["DROP TABLE wake_rules"],
  "0006_squad_runs": ["DROP TABLE squad_runs"],
  "0007_inbox_items": ["DROP TABLE inbox_items"],
  // 0008 是**列级**追加（不改表）：反向 DDL 是逐列 DROP（SQLite 3.35+ 支持的形态）。
  "0008_squad_run_cause": [
    "ALTER TABLE squad_runs DROP COLUMN dispatch_cause",
    "ALTER TABLE squad_runs DROP COLUMN caused_by_run_id",
  ],
  // 0009（C2 队列）：只加两索引（队列唯一性部分索引 + 容量计数索引）与两张新表（deferred 义务 / 合并明细），
  // 不加列——列集断言（EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008 路径）在 0009 后仍逐字成立。
  "0009_squad_run_queue": [
    "DROP INDEX idx_squad_runs_one_queued_per_item_agent",
    "DROP INDEX idx_squad_runs_agent_capacity",
    "DROP TABLE squad_run_coalesced_details",
    "DROP TABLE squad_run_deferred_dispatches",
  ],
  // 0010（协作域 X0.1）：评论 + 表情回应两张表（Activity/Decision 在 X0.2/0011）。
  "0010_workitem_collaboration": [
    "DROP INDEX idx_work_item_comment_reactions_comment",
    "DROP INDEX idx_work_item_comments_thread",
    "DROP INDEX idx_work_item_comments_item",
    "DROP TABLE work_item_comment_reactions",
    "DROP TABLE work_item_comments",
  ],
  // 0011（协作域 X0.2）：Activity + Decision。
  "0011_workitem_activity_decision": [
    "DROP INDEX idx_work_item_decisions_item",
    "DROP INDEX idx_work_item_activities_item",
    "DROP TABLE work_item_decisions",
    "DROP TABLE work_item_activities",
  ],
  // 0012（协作域 X1.2）：评论派发 receipt（两索引先于表 drop）。
  "0012_comment_dispatch_receipts": [
    "DROP INDEX idx_comment_dispatch_receipts_outcome",
    "DROP INDEX idx_comment_dispatch_receipts_item",
    "DROP TABLE comment_dispatch_receipts",
  ],
  // 0013（协作域 X1.3 修复）：Activity 补 sourceRun 全形状三列 + 义务表加 origin 来源列。
  // 列级追加（不改表），反向 DDL 是逐列 DROP；列名与 0013 的 ALTER 一一对应。
  "0013_collaboration_source_run_and_origin": [
    "ALTER TABLE squad_run_deferred_dispatches DROP COLUMN origin",
    "ALTER TABLE work_item_activities DROP COLUMN source_run_role",
    "ALTER TABLE work_item_activities DROP COLUMN source_run_squad_id",
    "ALTER TABLE work_item_activities DROP COLUMN source_run_agent_id",
  ],
  // 0014（看门狗 W1）：squad_runs 加 `opened_at` / `settle_reason` 两列（列级追加 ⇒ 反向 DDL 逐列 DROP）
  // + 一条回填 UPDATE。反向 DDL 只还原**结构**：行数据由用例自己造（见 0014 的专条用例）。
  "0014_squad_run_watchdog": [
    "ALTER TABLE squad_runs DROP COLUMN settle_reason",
    "ALTER TABLE squad_runs DROP COLUMN opened_at",
  ],
  // 0015（#6 用量记账 CT.1）：squad_runs 加 9 个用量列（列级追加 ⇒ 反向 DDL 逐列 DROP；**零回填**）。
  "0015_squad_run_usage": [
    "ALTER TABLE squad_runs DROP COLUMN usage_recorded_at",
    "ALTER TABLE squad_runs DROP COLUMN usage_model_error_count",
    "ALTER TABLE squad_runs DROP COLUMN usage_model_request_count",
    "ALTER TABLE squad_runs DROP COLUMN usage_cache_read_tokens",
    "ALTER TABLE squad_runs DROP COLUMN usage_cache_creation_tokens",
    "ALTER TABLE squad_runs DROP COLUMN usage_reasoning_tokens",
    "ALTER TABLE squad_runs DROP COLUMN usage_output_tokens",
    "ALTER TABLE squad_runs DROP COLUMN usage_input_tokens",
    "ALTER TABLE squad_runs DROP COLUMN usage_total_tokens",
  ],
};

const EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008 = [
  "run_id",
  "workspace_key",
  "workspace_path",
  "work_item_id",
  "parent_work_item_id",
  "agent_id",
  "is_leader_task",
  "branch",
  "dir_name",
  "status",
  "session_id",
  "created_at",
  "updated_at",
];

function squadRunColumns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(squad_runs)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

/** 0014 之后（= 0015 之前）的完整列集：0006 建表 13 列 + 0008 两列 + 0014 两列。 */
const EXPECTED_SQUAD_RUN_COLUMNS_AFTER_0014 = [
  ...EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008,
  "dispatch_cause",
  "caused_by_run_id",
  "opened_at",
  "settle_reason",
];

/** 0015 的 9 个用量列（追加在末尾；顺序 = `SQUAD_RUN_USAGE_SQL` 的 ALTER 顺序，逐字固定）。
 *  `usage_recorded_at` 是**存在性开关**：NULL = 未记录（与合法值 0「跑过但没消耗」可区分）。 */
const EXPECTED_SQUAD_RUN_USAGE_COLUMNS = [
  "usage_total_tokens",
  "usage_input_tokens",
  "usage_output_tokens",
  "usage_reasoning_tokens",
  "usage_cache_creation_tokens",
  "usage_cache_read_tokens",
  "usage_model_request_count",
  "usage_model_error_count",
  "usage_recorded_at",
];

test("迁移建出 work_items 表与索引", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
    .all();
  assert.equal(tables.length, 1);
  assert.deepEqual(workItemIndexes(db), EXPECTED_WORK_ITEM_INDEXES);
});

/* 0008 的**直接**用例（老库升级 + 从零建库两条路都要走）：
   · 老库（已有 0001–0007、库里还有行）补跑 0008 ⇒ **只加两列**、既有 13 列一字未动、
     既有行读回两列 = NULL（NULL = 遗留行/未知成因，加列**不猜值**）；
   · 从零建库同样带这两列 ⇒ 新库与老库升级后**同一形状**（否则两边读回同一条 SQL 结果不同）。 */
test("0008：老库补跑只加两列（既有行读回 NULL）；从零建库同一形状", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const fullLedger = ledger(db);
  // 自适配：0008 之后若再添迁移，本用例按同一条路逐条退回「0008 之前」。
  const from008 = fullLedger.findIndex((row) => row.id === "0008_squad_run_cause");
  assert.ok(from008 > 0, "账本里没有 0008（迁移没挂上）");
  /* 逐条退回必须**逆序**（最后应用的最先撤）：0013 这类「往 0009/0011 建的表上加列」的迁移，
     其反向 DDL 引用的表会被 0009/0011 自己的反向 DDL 整表 drop——正序执行会撞 no such table。 */
  for (const row of fullLedger.slice(from008).reverse()) {
    for (const sql of LATEST_MIGRATION_ARTIFACTS[row.id] ?? []) db.exec(sql);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(row.id);
  }
  // 退回「0008 之前」的形状：13 列，且我们真的能按旧列清单写入一条既有行。
  assert.deepEqual(squadRunColumns(db), EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008);
  db.prepare(
    `INSERT INTO squad_runs (run_id, workspace_key, workspace_path, work_item_id,
       parent_work_item_id, agent_id, is_leader_task, branch, dir_name, status, session_id,
       created_at, updated_at)
     VALUES ('legacy-1', 'ws', '/tmp/ws', 'wi-1', 'wi-1', 'ta-a', 0, NULL, NULL, 'open', NULL, 1, 1)`,
  ).run();

  const migrated: Array<string | null> = [];
  runTasksDatabaseMigrations(db, {
    onProgress: (phase, facts) => {
      if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
    },
  });
  // 补跑了两条（0008 + 0009）：`lastAppliedMigrationId` 在循环前只取一次基线，
  // 两条 migrating 回调带的是**同一个基线 id**（B1：0009 落地后本断言必须随之改为 2 条同基线）。
  // 补跑条数 = 从 0008 起的所有迁移（含未来新增——结构性解耦，X0.1 推荐方案落地）。
  const expected = fullLedger.slice(from008).map(() => fullLedger[from008 - 1]?.id ?? null);
  assert.deepEqual(migrated, expected, "补跑 0008 起的全部迁移（基线 id 相同，各出现一次）");
  assert.deepEqual(ledger(db), fullLedger, "补跑后账本与「一开始就完整跑满」逐行一致");
  const columns = squadRunColumns(db);
  /* 本用例只对 0008 的契约负责：既有 13 列**逐字未动**（前缀相等），0008 的两列紧随其后。
     刻意不再断言「总列数 = 15」：0008 之后的新迁移（0014 的 opened_at / settle_reason 即一例）
     可以继续在末尾追加列——把总数写死会让本用例在下一条加法迁移落地时假红，
     而它要守的是「老库升级不得改动既有列」（各条迁移的新增列由各自的专条用例断言）。 */
  assert.deepEqual(
    columns.slice(0, EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008.length),
    EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008,
    "既有 13 列一字未动（前缀逐字相等）",
  );
  assert.deepEqual(
    columns.slice(
      EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008.length,
      EXPECTED_SQUAD_RUN_COLUMNS_BEFORE_0008.length + 2,
    ),
    ["dispatch_cause", "caused_by_run_id"],
    "0008 的两列紧随其后",
  );
  // 既有行读回两列 = NULL：加列不猜值（遗留行语义），读回不得把 NULL 当成某一档成因。
  const legacy = db
    .prepare("SELECT dispatch_cause, caused_by_run_id FROM squad_runs WHERE run_id = 'legacy-1'")
    .get() as { dispatch_cause: string | null; caused_by_run_id: string | null };
  assert.equal(legacy.dispatch_cause, null);
  assert.equal(legacy.caused_by_run_id, null);

  // 从零建库：同一形状（新库不该比老库升级多/少列）。
  const fresh = openFreshDb();
  runTasksDatabaseMigrations(fresh);
  assert.deepEqual(squadRunColumns(fresh), columns);
});

/* 0014（看门狗 W1）的**直接**用例：老库补跑 + 从零建库两条路都要走。
   · 老库（已有 0001–0013、库里还有行）补跑 ⇒ 只加 `opened_at` / `settle_reason` 两列，
     既有列一字未动，且**回填** `opened_at = created_at`（非 queued 行：它进过 open，created_at
     是唯一可用的近似起点）；queued 行**恒 NULL**（它还没开跑，起算点不存在——不得拿 created_at
     冒充，否则「排队久」会被 TTL 误判成「跑得久」）；
   · 从零建库同一形状（0014 的 ALTER 是唯一列来源，0006 的建表 SQL 已冻结）。 */
test("0014：老库补跑只加两列并回填 opened_at = created_at（queued 行 NULL）；从零建库同一形状", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const fullLedger = ledger(db);
  const from014 = fullLedger.findIndex((row) => row.id === "0014_squad_run_watchdog");
  assert.ok(from014 > 0, "账本里没有 0014（迁移没挂上）");
  // 逐条退回（逆序）到「0014 之前」：结构与 0013 之后一模一样。
  for (const row of fullLedger.slice(from014).reverse()) {
    for (const sql of LATEST_MIGRATION_ARTIFACTS[row.id] ?? []) db.exec(sql);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(row.id);
  }
  // 造两条遗留行（旧列集可写）：一条直开的 open 行、一条排队行。
  const insertLegacy = (runId: string, status: string, createdAt: number) =>
    db
      .prepare(
        `INSERT INTO squad_runs (run_id, workspace_key, workspace_path, work_item_id,
           parent_work_item_id, agent_id, is_leader_task, branch, dir_name, status, session_id,
           created_at, updated_at, dispatch_cause, caused_by_run_id)
         VALUES (?, 'ws', '/tmp/ws', 'wi-1', 'wi-1', 'ta-a', 0, NULL, NULL, ?, NULL, ?, ?, NULL, NULL)`,
      )
      .run(runId, status, createdAt, createdAt);
  insertLegacy("legacy-open", "open", 111);
  insertLegacy("legacy-queued", "queued", 222);

  runTasksDatabaseMigrations(db);
  assert.deepEqual(ledger(db), fullLedger, "补跑后账本与「一开始就完整跑满」逐行一致");
  /* 本用例只对 0014 的契约负责：既有 15 列**逐字未动**（前缀相等），0014 的两列紧随其后。
     刻意不再断言「总列数 = 17」：0014 之后的新迁移（0015 的 9 个用量列即一例）可以继续在末尾
     追加列——把总数写死会让本用例在下一条加法迁移落地时假红，而它要守的是「老库升级不得改动
     既有列」（各条迁移的新增列由各自的专条用例断言，与 0008 用例同一条纪律）。 */
  assert.deepEqual(
    squadRunColumns(db).slice(0, EXPECTED_SQUAD_RUN_COLUMNS_AFTER_0014.length),
    EXPECTED_SQUAD_RUN_COLUMNS_AFTER_0014,
    "只加两列（在末尾），既有 15 列一字未动（前缀逐字相等）",
  );
  // 回填语义：非 queued ⇒ created_at；queued ⇒ NULL（不猜起算点）；settle_reason 一律 NULL。
  const backfilled = (
    db
      .prepare("SELECT run_id, opened_at, settle_reason FROM squad_runs ORDER BY run_id")
      .all() as Array<{ run_id: string; opened_at: number | null; settle_reason: string | null }>
  ).map((row) => ({ runId: row.run_id, openedAt: row.opened_at, settleReason: row.settle_reason }));
  assert.deepEqual(backfilled, [
    { runId: "legacy-open", openedAt: 111, settleReason: null },
    { runId: "legacy-queued", openedAt: null, settleReason: null },
  ]);

  // 从零建库：同一形状（新库不该比老库升级多/少列）。
  const fresh = openFreshDb();
  runTasksDatabaseMigrations(fresh);
  assert.deepEqual(squadRunColumns(fresh), squadRunColumns(db));
});

/* 0015（#6 按 run 用量记账 CT.1）的**直接**用例：老库补跑 + 从零建库两条路都要走。
   · 老库（已有 0001–0014、库里还有行）补跑 ⇒ 只加 9 个 `usage_*` 列、既有 17 列一字未动；
   · **零回填**：既有行读回 9 列全 NULL —— 没有会话就没有用量，回填无事实可依；填 0 会把
     「没记账」伪装成「没消耗」（列语义见 `SQUAD_RUN_USAGE_SQL` 的注释）；
   · 从零建库同一形状（0015 的 ALTER 是 9 列的**唯一**来源，0006 的建表 SQL 已冻结）。 */
test("0015：老库补跑只加 9 列用量（既有行全 NULL，零回填）；从零建库同一形状", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const fullLedger = ledger(db);
  const from015 = fullLedger.findIndex((row) => row.id === "0015_squad_run_usage");
  assert.ok(from015 > 0, "账本里没有 0015（迁移没挂上）");
  // 逐条退回（逆序）到「0015 之前」：结构与 0014 之后一模一样（17 列）。
  for (const row of fullLedger.slice(from015).reverse()) {
    for (const sql of LATEST_MIGRATION_ARTIFACTS[row.id] ?? []) db.exec(sql);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(row.id);
  }
  assert.deepEqual(squadRunColumns(db), EXPECTED_SQUAD_RUN_COLUMNS_AFTER_0014);
  // 造一条遗留行（0014 的列清单可写）：它没有经过任何用量记账。
  db.prepare(
    `INSERT INTO squad_runs (run_id, workspace_key, workspace_path, work_item_id,
       parent_work_item_id, agent_id, is_leader_task, branch, dir_name, status, session_id,
       created_at, updated_at, dispatch_cause, caused_by_run_id, opened_at, settle_reason)
     VALUES ('legacy-usage-1', 'ws', '/tmp/ws', 'wi-1', 'wi-1', 'ta-a', 0, NULL, NULL, 'open', NULL,
       111, 111, NULL, NULL, 111, NULL)`,
  ).run();

  runTasksDatabaseMigrations(db);
  assert.deepEqual(ledger(db), fullLedger, "补跑后账本与「一开始就完整跑满」逐行一致");
  assert.deepEqual(
    squadRunColumns(db),
    [...EXPECTED_SQUAD_RUN_COLUMNS_AFTER_0014, ...EXPECTED_SQUAD_RUN_USAGE_COLUMNS],
    "0015 只加 9 列（在末尾），既有 17 列一字未动",
  );
  // 零回填 + NULL 语义：既有行 9 列全 NULL（**未记录 ≠ 0**）。
  const legacy = db
    .prepare(
      `SELECT ${EXPECTED_SQUAD_RUN_USAGE_COLUMNS.join(", ")} FROM squad_runs WHERE run_id = 'legacy-usage-1'`,
    )
    .get() as Record<string, number | null>;
  for (const column of EXPECTED_SQUAD_RUN_USAGE_COLUMNS)
    assert.equal(legacy[column], null, `${column} 必须保持 NULL（零回填：没有会话就没有用量）`);

  // 从零建库：同一形状（新库不该比老库升级多/少列）。
  const fresh = openFreshDb();
  runTasksDatabaseMigrations(fresh);
  assert.deepEqual(squadRunColumns(fresh), squadRunColumns(db));
});

// 迁移必须幂等：老库升级与重放都不能报错、不能改动结构。
// 注意账本会短路——runner 读到已应用就 continue（migrations.ts 的 applied 分支），
// 所以第二次 runTasksDatabaseMigrations 根本不会重跑 DDL，证明不了 DDL 自身幂等。
// 要证明 IF NOT EXISTS 生效，必须绕开账本直接把 WORK_ITEM_SCHEMA 再执行一遍。
test("迁移可重复应用", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  runTasksDatabaseMigrations(db);
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "status"));
  const beforeColumns = workItemColumns(db);
  const beforeIndexes = workItemIndexes(db);

  assert.doesNotThrow(
    () => db.exec(WORK_ITEM_SCHEMA),
    "WORK_ITEM_SCHEMA 不可重复应用（缺 IF NOT EXISTS 时会在这里抛 already exists）",
  );
  assert.deepEqual(workItemColumns(db), beforeColumns);
  assert.deepEqual(workItemIndexes(db), beforeIndexes);
});

// 老库升级回归：**自适配**——「上一版发布」是哪一版由账本动态切出，测试里不写任何版本号列表，
// 也不写账本头串；新增迁移后本用例无需改动仍应通过。
// 语义：已发布库（除最新一条外的全部迁移已应用）再跑迁移，只能补跑最新那一条，
// 且不能因 checksum 变动而抛 checksum_mismatch。
test("老库升级只补跑最新一条迁移", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);

  // 动态发现边界：账本按 id 升序，最后一行即「最新一条」。
  const fullLedger = ledger(db);
  const latest = fullLedger.at(-1);
  assert.ok(latest, "账本为空，迁移根本没跑");
  const published = fullLedger.slice(0, -1); // 除最新之外的全部 = 上一版发布的样子
  assert.ok(published.length > 0, "账本至少要两条迁移，否则模拟不出「老库」");

  // 冻结契约（字面量钉法）：已登记的每条必须逐一命中字面量，防「有人改冻结声明」。
  // 未登记项（刚新增的迁移）不判红；反过来，登记表不得留下库里已不存在的 id，防边界漂移。
  for (const row of published) {
    const pinned = PINNED_MIGRATION_CHECKSUMS[row.id];
    if (pinned !== undefined)
      assert.equal(
        row.checksum,
        pinned,
        `${row.id} 的冻结 checksum 被改动（老库升级会抛 checksum_mismatch）`,
      );
  }
  for (const id of Object.keys(PINNED_MIGRATION_CHECKSUMS))
    assert.ok(
      published.some((row) => row.id === id),
      `冻结表登记了不再属于「已发布」集合的迁移：${id}`,
    );

  // 退回上一版发布的样子：drop 掉最新迁移建出的对象（若已登记），删掉它的账本行。
  for (const sql of LATEST_MIGRATION_ARTIFACTS[latest.id] ?? []) db.exec(sql);
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(latest.id);
  assert.deepEqual(ledger(db), published, "退库后账本应只剩已发布的那几条");

  const migrated: Array<string | null> = [];
  const committedExecutedCounts: number[] = [];
  assert.doesNotThrow(
    () =>
      runTasksDatabaseMigrations(db, {
        onProgress: (phase, facts) => {
          if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
          else committedExecutedCounts.push(facts.executedCount);
        },
      }),
    "冻结的 checksumInput 被改动后，老库升级会抛 checksum_mismatch",
  );
  // 只补跑了一条：执行时账本头就是「上一版最新的那条」，被执行的只能是它之后的那一条。
  assert.equal(migrated.length, 1, "老库升级只能补跑一条迁移");
  assert.deepEqual(migrated, [published.at(-1)?.id]);
  assert.deepEqual(committedExecutedCounts, [1]);

  // 纯追加：补跑后账本应与「一开始就完整跑满」逐行一致，且既有 work_items 结构一行未动。
  assert.deepEqual(ledger(db), fullLedger);
  assert.deepEqual(workItemIndexes(db), EXPECTED_WORK_ITEM_INDEXES);
  assert.ok(workItemColumns(db).includes("status"));

  // 升级完再跑一次必须是 no-op：不执行任何迁移、不报错。
  let executedAgain = 0;
  runTasksDatabaseMigrations(db, {
    onProgress: (phase) => {
      if (phase === "migrating") executedAgain++;
    },
  });
  assert.equal(executedAgain, 0);
  assert.deepEqual(ledger(db), fullLedger);
});
