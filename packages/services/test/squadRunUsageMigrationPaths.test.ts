import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { SQUAD_RUN_USAGE_SQL } from "../src/session/tasksDatabase/schema-v1.js";

/* CT.V（#6 成本记账线整线独立复验）—— **迁移 0015 三路径 + 0014 冻结**（独立夹具）。

   三条路径一次钉住：

   A. **从零建库**：0015 是 9 列的来源 —— 列名/类型/可空/缺省逐列核对，账本行 + checksum 齐全；
   B. **老库升级**：降到 0014 形态（反向 DDL + 删 0015 账本行）+ 造遗留行 ⇒ 跑迁移 ⇒
      列集恰为「升级前 17 列 + 9 个 usage_* 列」（列序、无第三类改动），遗留行既有 17 列逐字不变、
      9 新列全 NULL（零回填），账本 0001–0014 行逐行逐字不变；
   C. **重复跑**：全量账本已就位 ⇒ 再跑一遍零变化（不重放 DDL、不改写入时刻）。

   注意（与 G7 守卫共处）：本文件**不**复制 `squad_runs` 的冻结列集期望值（那是
   `workItemMigration.test.ts` / `squadRunRepo.test.ts` 两处的职责，G7 守卫钉住「恰两处」）；
   这里只做**相对**断言（升级前真实列集 + 0015 的 9 列新增契约）与 0015 专有的列属性断言 ——
   列集读法用表值 pragma（`pragma_table_info`），不引入第三份期望列表。 */

const USAGE_COLUMNS = [
  "usage_total_tokens",
  "usage_input_tokens",
  "usage_output_tokens",
  "usage_reasoning_tokens",
  "usage_cache_creation_tokens",
  "usage_cache_read_tokens",
  "usage_model_request_count",
  "usage_model_error_count",
  "usage_recorded_at",
] as const;

type ColumnFact = { name: string; type: string; not_null: number; dflt_value: string | null };

const columnFacts = (db: DatabaseSync): ColumnFact[] =>
  db
    .prepare(
      `SELECT name, type, "notnull" AS not_null, dflt_value
         FROM pragma_table_info('squad_runs')`,
    )
    .all() as ColumnFact[];

const columnNames = (db: DatabaseSync): string[] => columnFacts(db).map((entry) => entry.name);

const ledger = (db: DatabaseSync): Array<{ id: string; checksum: string; applied: number }> =>
  db
    .prepare("SELECT id, checksum, time_applied AS applied FROM tasks_schema_migration ORDER BY id")
    .all() as Array<{ id: string; checksum: string; applied: number }>;

const rawRow = (db: DatabaseSync, runId: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(
      db.prepare("SELECT * FROM squad_runs WHERE run_id = ?").get(runId) as Record<string, unknown>,
    ).sort(([a], [b]) => a.localeCompare(b)),
  );

const migrateFresh = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
};

/**
 * 降到 0014 形态：逆序移除 9 列 + 删 0015 账本行（不触碰 0001–0014 的任何字节）。
 *
 * 0016（#7 交付物）/ 0017（#8 PR 关联+快照）落地后同步补上它们的反向 DDL：本夹具要模拟的是
 * 「升级前 = 止于 0014 的老库」，只删 0015 会让后两条的表与账本行留在里面、
 * `ledgerBefore.length` 变成 15/16 —— 那时这条用例测的就不是「老库升级」而是另一种形状了
 * （与本仓各条迁移的 artifact 登记同一条纪律）。
 */
function downgradeTo0014(db: DatabaseSync): void {
  for (const column of [...USAGE_COLUMNS].reverse()) {
    db.exec(`ALTER TABLE squad_runs DROP COLUMN ${column}`);
  }
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0015_squad_run_usage'").run();
  db.exec("DROP INDEX idx_work_item_deliverables_run");
  db.exec("DROP INDEX idx_work_item_deliverables_item");
  db.exec("DROP TABLE work_item_deliverables");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0016_work_item_deliverables'").run();
  db.exec("DROP INDEX idx_work_item_pull_requests_item");
  db.exec("DROP INDEX idx_work_item_pull_requests_pr");
  db.exec("DROP TABLE work_item_pull_requests");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0017_work_item_pull_requests'").run();
  /* 0018（工作项 Surface 对齐 · 阶段一 R1）落地后同样补上它的反向 DDL：本夹具要模拟的是
     「升级前 = 止于 0014 的老库」，留下 0018 的列与账本行会让 `ledgerBefore.length` 变成 15 ——
     那时这条用例测的就不是「0015 的老库升级」而是另一种形状了（同 0016/0017 的登记纪律）。 */
  db.exec("DROP INDEX idx_work_items_identifier");
  db.exec("ALTER TABLE work_items DROP COLUMN identifier_seq");
  db.exec("ALTER TABLE work_items DROP COLUMN creator_display_name");
  db.exec("ALTER TABLE work_items DROP COLUMN creator_id");
  db.exec("ALTER TABLE work_items DROP COLUMN creator_kind");
  db.exec("ALTER TABLE work_items DROP COLUMN due_date");
  db.exec("ALTER TABLE work_items DROP COLUMN start_date");
  db.exec("ALTER TABLE work_items DROP COLUMN priority");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0018_work_item_surface_fields'").run();
  /* 0019（SUB.1 订阅表）落地后同样补上它的反向 DDL：本夹具要模拟的是「升级前 = 止于 0014 的老库」，
     留下 0019 的表与账本行会让 `ledgerBefore.length` 变成 15 —— 那时这条用例测的就不是
     「0015 的老库升级」而是另一种形状了（同 0016/0017/0018 的登记纪律）。 */
  db.exec("DROP INDEX idx_work_item_subscribers_subject");
  db.exec("DROP INDEX idx_work_item_subscribers_unique");
  db.exec("DROP TABLE work_item_subscribers");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0019_work_item_subscribers'").run();
  /* 0020（saved views R6a）落地后同样补上它的反向 DDL：本夹具要模拟的是「升级前 = 止于 0014 的老库」，
     留下 0020 的两表两索引与账本行会让 `ledgerBefore.length` 变成 15 —— 那时这条用例测的就不是
     「0015 的老库升级」而是另一种形状了（同 0016/0017/0018/0019 的登记纪律）。 */
  db.exec("DROP INDEX idx_work_item_views_shared");
  db.exec("DROP INDEX idx_work_item_views_owner");
  db.exec("DROP TABLE work_item_view_prefs");
  db.exec("DROP TABLE work_item_views");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0020_work_item_views'").run();
  /* 0021（工作项级 reactions，P3-R5s）落地后同样补上它的反向 DDL：本夹具要模拟的是
     「升级前 = 止于 0014 的老库」，留下 0021 的一表一索引与账本行会让 `ledgerBefore.length`
     变成 15 —— 那时这条用例测的就不是「0015 的老库升级」而是另一种形状了（同 0016–0020 的登记纪律）。 */
  db.exec("DROP INDEX idx_work_item_reactions_item");
  db.exec("DROP TABLE work_item_reactions");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0021_work_item_reactions'").run();
}

test("路径 A（从零建库）：9 个 usage_* 列按序追加（INTEGER / 可空 / 无缺省）；账本 0015 checksum 等于冻结口径", () => {
  const db = migrateFresh();
  const facts = columnFacts(db);
  assert.deepEqual(
    facts.slice(-9).map((entry) => entry.name),
    [...USAGE_COLUMNS],
    "9 个 usage_* 列必须按序追加在列集末尾（拼错列名时读回恒 null 且不报错）",
  );
  for (const fact of facts.slice(-9)) {
    assert.deepEqual(
      [fact.type, fact.not_null, fact.dflt_value],
      ["INTEGER", 0, null],
      `${fact.name} 必须是可空 INTEGER 且无缺省（NULL = 未记录，不得有 0 缺省）`,
    );
  }
  const entries = ledger(db);
  assert.equal(
    entries.length,
    21,
    "账本 0001–0015 共 15 条 + 0016（#7 交付物）+ 0017（#8 PR）+ 0018（工作项 Surface）+ " +
      "0019（SUB.1 订阅表）+ 0020（saved views）+ 0021（工作项级 reactions）各一条",
  );
  const entry = entries.find((row) => row.id === "0015_squad_run_usage");
  assert.ok(entry, "0015 必须已登记");
  assert.equal(
    entry.checksum,
    createHash("sha256")
      .update(JSON.stringify([SQUAD_RUN_USAGE_SQL]))
      .digest("hex"),
    "0015 的 checksum = runner 的冻结口径（供跨版本比对）",
  );
});

test("路径 B（老库升级）：列集 = 升级前 + 9 列（无第三类改动）、遗留行 17 列逐字不变、9 新列 NULL、0001–0014 账本不变", () => {
  const db = migrateFresh();
  downgradeTo0014(db);
  const columnsBefore = columnNames(db);
  assert.equal(columnsBefore.length, 17, "降级形态 = 0014 的 17 列");
  assert.deepEqual(columnsBefore.slice(-4), [
    "dispatch_cause",
    "caused_by_run_id",
    "opened_at",
    "settle_reason",
  ]);

  // 一条 0014 形态的遗留行：17 列全部给哨兵值（回填若发生，必然改掉其中一列或新增的 9 列）。
  db.prepare(
    `INSERT INTO squad_runs (run_id, workspace_key, workspace_path, work_item_id,
       parent_work_item_id, agent_id, is_leader_task, branch, dir_name, status, session_id,
       created_at, updated_at, dispatch_cause, caused_by_run_id, opened_at, settle_reason)
     VALUES ('legacy-0015', 'ws', '/tmp/ws', 'wi-1', 'wi-1', 'ta-a', 0, 'squad/x', 'dir-x',
       'discarded', 'sess-legacy', 777, 888, NULL, NULL, 777, 'watchdog_ttl')`,
  ).run();
  const rowBefore = rawRow(db, "legacy-0015");
  const ledgerBefore = ledger(db);
  assert.equal(ledgerBefore.length, 14, "升级前账本止于 0014");

  runTasksDatabaseMigrations(db);

  assert.deepEqual(
    columnNames(db),
    [...columnsBefore, ...USAGE_COLUMNS],
    "升级只追加 9 列（在末尾），既有 17 列一字未动、无其它结构改动",
  );
  const rowAfter = rawRow(db, "legacy-0015");
  const usageColumnSet = new Set<string>(USAGE_COLUMNS);
  assert.deepEqual(
    Object.keys(rowAfter).filter((key) => !usageColumnSet.has(key)),
    Object.keys(rowBefore),
    "既有列键集不变（新增键恰为 9 个 usage_*，无第三类结构改动）",
  );
  assert.deepEqual(
    Object.keys(rowAfter)
      .filter((key) => usageColumnSet.has(key))
      .sort(),
    [...USAGE_COLUMNS].sort(),
    "新增键逐字等于 0015 的 9 个列名（拼错列名会在这里现形）",
  );
  for (const [column, value] of Object.entries(rowBefore)) {
    assert.deepEqual(rowAfter[column], value, `既有列 ${column} 必须逐字不变（含哨兵值）`);
  }
  for (const column of USAGE_COLUMNS) {
    assert.strictEqual(
      rowAfter[column],
      null,
      `${column} 必须保持 NULL —— 零回填：没有会话就没有用量，填 0 会把「没记账」伪装成「没消耗」`,
    );
  }
  const ledgerAfter = ledger(db);
  assert.deepEqual(
    ledgerAfter.slice(0, 14),
    ledgerBefore,
    "0001–0014 账本行（id/checksum/time_applied）逐行逐字不变（checksum 冻结的运行期证据）",
  );
  assert.equal(
    ledgerAfter.length,
    21,
    "升级恰好追加 0015 + 0016 + 0017 + 0018 + 0019 + 0020 + 0021 七条（降级夹具把七者都退回，补跑时一起装回）",
  );
});

test("路径 C（重复跑）：账本已就位 ⇒ 再跑零变化（不重放 DDL、不改 time_applied / 行内容）", () => {
  const db = migrateFresh();
  db.prepare(
    `INSERT INTO squad_runs (run_id, workspace_key, workspace_path, work_item_id,
       parent_work_item_id, agent_id, is_leader_task, branch, dir_name, status, session_id,
       created_at, updated_at, dispatch_cause, caused_by_run_id, opened_at, settle_reason)
     VALUES ('rerun-0015', 'ws', '/tmp/ws', 'wi-1', 'wi-1', 'ta-a', 0, NULL, NULL,
       'merged', NULL, 1, 1, NULL, NULL, 1, NULL)`,
  ).run();
  const columnsBefore = columnNames(db);
  const ledgerBefore = ledger(db);
  const rowBefore = rawRow(db, "rerun-0015");

  runTasksDatabaseMigrations(db);
  runTasksDatabaseMigrations(db);

  assert.deepEqual(columnNames(db), columnsBefore, "重复跑不得再改结构");
  assert.deepEqual(ledger(db), ledgerBefore, "重复跑不得改写账本（含 time_applied）");
  assert.deepEqual(rawRow(db, "rerun-0015"), rowBefore, "重复跑不得改行内容");
  assert.deepEqual(
    USAGE_COLUMNS.map((column) => rawRow(db, "rerun-0015")[column]),
    [null, null, null, null, null, null, null, null, null],
    "仍在未记录态（NULL）",
  );
});
