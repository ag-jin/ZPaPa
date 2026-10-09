import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  PROJECT_SCHEMA,
  WORK_ITEM_PROJECT_BINDING_SQL,
} from "../src/session/tasksDatabase/schema-v1.js";

/* 迁移 **0022_projects**（工作项项目绑定 · 服务面轮 R-P1）的直接用例。

   本迁移做两件事（取材 `reports/2026-10-09-multica-issue-project-binding.md` A1）：
   ① 建 `projects`（workspace 级实体：name NOT NULL / short_code（2-8 大写字母数字，workspace 内唯一
      —— 编号前缀来源）/ description / icon / status 闭集 / priority / start_date / due_date）；
   ② `work_items` 加两列：`project_id`（**可空** = 「无项目」是显式合法状态）与
      `identifier_prefix`（短码**快照** —— 编号 = 前缀-序号，序号语义不动仍是每 workspace 序列）。

   **不给 project_id 建外键**（同仓纪律：只归档不硬删 / 删项目由服务层把挂接置 NULL，见 repo），
   故删项目不会由存储层级联改行。

   本文件断言**库的原始形状**（PRAGMA / sqlite_master / 裸 SQL），不经 repo 映射 ——
   映射层自己写错列名时读回仍是 `undefined`，只有裸读能抓到。 */

const PROJECT_COLUMNS = [
  "id",
  "workspace_key",
  "name",
  "short_code",
  "description",
  "icon",
  "status",
  "priority",
  "start_date",
  "due_date",
  "created_at",
  "updated_at",
] as const;

const PROJECT_SHORT_CODE_INDEX = "idx_projects_short_code";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function ledgerIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all() as Array<{ id: string }>
  ).map((row) => row.id);
}

/** 裸插入（绕过 repo）：`over` 覆盖默认值。 */
function insertProject(db: DatabaseSync, over: Record<string, string | number | null> = {}): void {
  const row = {
    id: "p-1",
    workspace_key: "ws",
    name: "平台重构",
    short_code: "PLT",
    description: null,
    icon: null,
    status: "planned",
    priority: null,
    start_date: null,
    due_date: null,
    created_at: 100,
    updated_at: 100,
    ...over,
  };
  db.prepare(
    `INSERT INTO projects (id, workspace_key, name, short_code, description, icon, status,
       priority, start_date, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.workspace_key,
    row.name,
    row.short_code,
    row.description,
    row.icon,
    row.status,
    row.priority,
    row.start_date,
    row.due_date,
    row.created_at,
    row.updated_at,
  );
}

test("0022｜新库：账本 22 条（0022 收尾），projects 逐列建出、唯一索引就位、work_items 追加两列", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const ids = ledgerIds(db);
  assert.equal(ids.length, 22, "账本应到 0022（0001–0021 + 0022）");
  assert.equal(ids.at(-1), "0022_projects");
  assert.deepEqual(
    columnNames(db, "projects"),
    [...PROJECT_COLUMNS],
    "projects 逐列（列名写错时读回恒 undefined 且不报错）",
  );
  // work_items 的两列**按 ALTER 序追加在末尾**：老库升级与从零建库同形状。
  assert.deepEqual(
    columnNames(db, "work_items").slice(-2),
    ["project_id", "identifier_prefix"],
    "work_items 末尾追加 project_id / identifier_prefix（顺序即 ALTER 序）",
  );
  const index = (
    db.prepare("PRAGMA index_list(projects)").all() as Array<{
      name: string;
      unique: number;
    }>
  ).find((row) => row.name === PROJECT_SHORT_CODE_INDEX);
  assert.ok(index, `索引 ${PROJECT_SHORT_CODE_INDEX} 必须存在`);
  assert.equal(index.unique, 1, "短码索引是唯一索引（workspace 内唯一）");
  assert.deepEqual(
    (
      db.prepare(`PRAGMA index_info(${PROJECT_SHORT_CODE_INDEX})`).all() as Array<{ name: string }>
    ).map((row) => row.name),
    ["workspace_key", "short_code"],
    "唯一键 = (workspace_key, short_code)：跨 workspace 可同名、同 workspace 不可重复",
  );
  db.close();
});

test("0022｜老库升级：摘掉 0022 的表/索引/两列与账本行 ⇒ 恰补跑 1 条；再跑 no-op", () => {
  const full = openDb();
  runTasksDatabaseMigrations(full);
  const fullLedger = ledgerIds(full);

  const db = openDb();
  runTasksDatabaseMigrations(db);
  // 退库到 0021 形态：先撤索引/表与两列（列上若有索引须先撤，本迁移没有列索引）。
  db.exec(`DROP INDEX IF EXISTS ${PROJECT_SHORT_CODE_INDEX}`);
  db.exec("DROP TABLE IF EXISTS projects");
  db.exec("ALTER TABLE work_items DROP COLUMN identifier_prefix");
  db.exec("ALTER TABLE work_items DROP COLUMN project_id");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0022_projects'").run();

  const migrated: Array<string | null> = [];
  runTasksDatabaseMigrations(db, {
    onProgress: (phase, facts) => {
      if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
    },
  });
  assert.deepEqual(migrated, ["0021_work_item_reactions"], "老库只补跑 0022 一条");
  assert.deepEqual(ledgerIds(db), fullLedger);
  assert.deepEqual(columnNames(db, "projects"), columnNames(full, "projects"));
  assert.deepEqual(columnNames(db, "work_items"), columnNames(full, "work_items"));

  let again = 0;
  runTasksDatabaseMigrations(db, {
    onProgress: (phase) => {
      if (phase === "migrating") again++;
    },
  });
  assert.equal(again, 0, "已应用后再跑必须 no-op");
  db.close();
});

test("0022｜零回填 + 无外键：存量工作项两列读回 NULL，删项目不由存储层级联", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  // 存量行（迁移前就有的工作项）在升级后两列都是 NULL：没有项目事实就不编造前缀。
  db.prepare(
    `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage, title, body,
       status, assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
     VALUES ('legacy-wi', 'ws', '/tmp/ws', NULL, NULL, '老项', '', 'todo', 'user', 'hu-1', '[]', '{}', 0, NULL, 1, 1)`,
  ).run();
  const row = db
    .prepare("SELECT project_id, identifier_prefix FROM work_items WHERE id = 'legacy-wi'")
    .get() as { project_id: string | null; identifier_prefix: string | null };
  assert.equal(row.project_id, null, "存量行 project_id = NULL（零回填，「无项目」是初始真相）");
  assert.equal(row.identifier_prefix, null, "存量行 identifier_prefix = NULL（不编造前缀）");

  // 无外键（同仓纪律）：删 projects 行不会由存储层改动 work_items（挂接置 NULL 是服务层的事）。
  insertProject(db, { id: "p-del" });
  db.prepare(
    "UPDATE work_items SET project_id = 'p-del', identifier_prefix = 'DEL' WHERE id = 'legacy-wi'",
  ).run();
  db.prepare("DELETE FROM projects WHERE id = 'p-del'").run();
  const after = db
    .prepare("SELECT project_id, identifier_prefix FROM work_items WHERE id = 'legacy-wi'")
    .get() as { project_id: string | null; identifier_prefix: string | null };
  // node:sqlite 的行是 null-prototype 对象：逐字段断言（deepEqual 会因原型不同而误报）。
  assert.equal(after.project_id, "p-del", "删项目行不级联改工作项的 project_id（无外键）");
  assert.equal(
    after.identifier_prefix,
    "DEL",
    "已签发的编号前缀快照保留（删项目不改既有编号；挂接置 NULL 由服务层显式做）",
  );
  assert.deepEqual(
    db.prepare("PRAGMA foreign_key_list(work_items)").all(),
    [],
    "work_items 上没有任何外键（贯穿全仓的既有纪律）",
  );
  db.close();
});

test("0022｜账本 checksum 与迁移 SQL 同源（改了 SQL 文本 ⇒ 老库升级抛 checksum_mismatch）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const row = db
    .prepare("SELECT checksum FROM tasks_schema_migration WHERE id = '0022_projects'")
    .get() as { checksum: string };
  assert.equal(
    row.checksum,
    createHash("sha256")
      .update(JSON.stringify([PROJECT_SCHEMA, WORK_ITEM_PROJECT_BINDING_SQL]))
      .digest("hex"),
    "0022 的 checksumInput 必须恰是它的两个 DDL 常量（投影表 + 挂接两列）",
  );
  db.close();
});

test("0022｜存储层三闸：短码形状 CHECK、status 闭集 CHECK、name NOT NULL", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  // 短码形状（2-8 大写字母数字）在存储层也有闸：服务面是响亮的第一道，DDL 是最后一道。
  insertProject(db, { id: "p-ok-2", short_code: "AB" });
  insertProject(db, { id: "p-ok-8", short_code: "ABCD1234" });
  assert.throws(
    () => insertProject(db, { id: "p-short", short_code: "A" }),
    /CHECK/i,
    "单字符短码必须被拒（2..8）",
  );
  assert.throws(
    () => insertProject(db, { id: "p-long", short_code: "ABCDEFGHI" }),
    /CHECK/i,
    "九字符短码必须被拒（2..8）",
  );
  assert.throws(
    () => insertProject(db, { id: "p-lower", short_code: "abc" }),
    /CHECK/i,
    "小写短码必须被拒（大写字母数字）",
  );
  assert.throws(
    () => insertProject(db, { id: "p-dash", short_code: "AB-1" }),
    /CHECK/i,
    "含连字符的短码必须被拒（字母数字）",
  );
  assert.throws(
    () => insertProject(db, { id: "p-status", status: "archived" }),
    /CHECK/i,
    "status 闭集外一律拒（planned/in_progress/paused/completed/cancelled）",
  );
  assert.throws(
    () => insertProject(db, { id: "p-name", name: null }),
    /NOT NULL|constraint/i,
    "name 是 NOT NULL（项目没有名字就没有可读标识）",
  );
  // DDL 默认值：status 缺省 planned（写入口不传时落什么，读回必须逐字可预期）。
  db.prepare(
    `INSERT INTO projects (id, workspace_key, name, short_code, created_at, updated_at)
     VALUES ('p-default', 'ws', '缺省状态', 'DEF', 1, 1)`,
  ).run();
  const status = db.prepare("SELECT status FROM projects WHERE id = 'p-default'").get() as {
    status: string;
  };
  assert.equal(status.status, "planned", "status 缺省 planned（DDL DEFAULT）");
  db.close();
});
