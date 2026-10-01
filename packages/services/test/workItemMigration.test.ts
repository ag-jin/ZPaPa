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
};

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
