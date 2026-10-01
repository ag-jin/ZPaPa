import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

function openFreshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

test("迁移建出 work_items 表与索引", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
    .all();
  assert.equal(tables.length, 1);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_items%'")
    .all();
  assert.ok(indexes.length >= 3);
});

// 迁移必须幂等：重复应用不得报错、不得改动结构（否则老库升级会炸）。
test("迁移可重复应用", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  runTasksDatabaseMigrations(db);
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "status"));
});
