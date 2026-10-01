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
  return db
    .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id")
    .all() as Array<{ id: string; checksum: string }>;
}

const EXPECTED_WORK_ITEM_INDEXES = [
  "idx_work_items_parent",
  "idx_work_items_status",
  "idx_work_items_workspace",
];

// 与已发布数据库的契约：这三条 checksum 一旦被改动，老库升级会抛 checksum_mismatch。
// 写成冻结字面量，而不是「再用当前代码算一遍」——否则改了 checksumInput 时期望值与
// 实际值会一起变，回归就测不出来。
const FROZEN_CHECKSUMS_0001_0003 = [
  ["0001_adopt_task_schema", "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17"],
  ["0002_provider_selection", "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc"],
  ["0003_official_glm_selection", "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4"],
] as const;

test("迁移建出 work_items 表与索引", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
    .all();
  assert.equal(tables.length, 1);
  assert.deepEqual(workItemIndexes(db), EXPECTED_WORK_ITEM_INDEXES);
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

// 老库升级回归：0001–0003 已应用、0004 未应用的库再跑迁移，只能新增 0004。
// 下面的冻结字面量是已发布库的账本契约：改动既有 checksumInput 会让这条断言先炸
// （即便侥幸绕过，runTasksDatabaseMigrations 也会抛 checksum_mismatch）。
test("老库（0001–0003 已应用）升级只执行 0004", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  // 退回「上一版发布」的样子：新表不存在、0004 未记账。
  db.exec("DROP TABLE work_items");
  db.exec("DELETE FROM tasks_schema_migration WHERE id = '0004_work_items'");
  assert.deepEqual(
    ledger(db).map((row) => [row.id, row.checksum]),
    FROZEN_CHECKSUMS_0001_0003.map((row) => [...row]),
  );

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
  // 只执行了一条，且当时账本头是 0003 —— 被执行的只能是 0004。
  assert.deepEqual(migrated, ["0003_official_glm_selection"]);
  assert.deepEqual(committedExecutedCounts, [1]);
  assert.deepEqual(workItemIndexes(db), EXPECTED_WORK_ITEM_INDEXES);
  assert.ok(workItemColumns(db).includes("status"));
  assert.equal(ledger(db).length, 4);

  // 升级完再跑一次必须是 no-op：不执行任何迁移、不报错。
  let executedAgain = 0;
  runTasksDatabaseMigrations(db, {
    onProgress: (phase) => {
      if (phase === "migrating") executedAgain++;
    },
  });
  assert.equal(executedAgain, 0);
  assert.equal(ledger(db).length, 4);
});
