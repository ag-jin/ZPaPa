import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { WORK_ITEM_SURFACE_FIELDS_SQL } from "../src/session/tasksDatabase/schema-v1.js";

/* 迁移 **0018_work_item_surface_fields**（工作项 Surface 对齐 · 阶段一 R1）的直接用例。

   0018 给 `work_items` 加 7 列 + 1 个唯一索引，回填纪律分两半（拆解报告 §2.1/§2.2/§2.3）：
   · `priority` / `start_date` / `due_date` / `creator_*` —— **零回填**：存量行没有「谁定过优先级 /
     哪天开始 / 谁按下的创建」这些事实，填默认值就是替用户编一个没人做过的决定
     （`creator=assignee` 尤其：拿指派冒充创建人会**伪造历史**）；
   · `identifier_seq` —— **全量回填**：事实是「顺序」，依据是既有的 `created_at`（`id` 只做同刻并列的
     确定性 tie-break），每 workspace 从 1 编号；归档行**也占号**（identifier 是永久标签）。

   本文件断言的是**库的原始形状**（PRAGMA / sqlite_master / 裸 SQL 读列），不经 repo 映射 ——
   映射层自己写错列名时读回仍是 `undefined`，只有裸读能抓到。 */

const SURFACE_COLUMNS = [
  "priority",
  "start_date",
  "due_date",
  "creator_kind",
  "creator_id",
  "creator_display_name",
  "identifier_seq",
] as const;

/** 0018 之前的行形状（0004 建表的 16 列）：退库与造老数据都用它，列集逐字来自 `WORK_ITEM_SCHEMA`。 */
const LEGACY_INSERT = `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage,
  title, body, status, assignee_type, assignee_id, labels, properties, position, archived_at,
  created_at, updated_at)
  VALUES (?, ?, '/tmp/ws', NULL, NULL, ?, '', 'todo', 'user', 'u1', '[]', '{}', 0, ?, ?, ?)`;

const IDENTIFIER_INDEX = "idx_work_items_identifier";

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

function indexNames(db: DatabaseSync, like: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?")
      .all(like) as Array<{ name: string }>
  ).map((row) => row.name);
}

function identifierIndexFacts(db: DatabaseSync): { unique: number; columns: string[] } | null {
  const listed = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name = ?")
    .get(IDENTIFIER_INDEX) as { name: string; sql: string | null } | undefined;
  if (!listed) return null;
  const info = db.prepare(`PRAGMA index_list(work_items)`).all() as Array<{
    name: string;
    unique: number;
  }>;
  const unique = info.find((row) => row.name === IDENTIFIER_INDEX)?.unique ?? 0;
  const columns = (
    db.prepare(`PRAGMA index_info(${IDENTIFIER_INDEX})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
  return { unique, columns };
}

/** 退到 0017 形态（老库）：撤掉 0018 的索引与 7 列，并删掉它的账本行。 */
function downgradeTo0017(db: DatabaseSync): void {
  db.exec(`DROP INDEX IF EXISTS ${IDENTIFIER_INDEX}`);
  for (const column of [...SURFACE_COLUMNS].reverse()) {
    db.exec(`ALTER TABLE work_items DROP COLUMN ${column}`);
  }
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0018_work_item_surface_fields'").run();
}

function legacyRow(
  db: DatabaseSync,
  id: string,
  workspaceKey: string,
  createdAt: number,
  archivedAt: number | null = null,
): void {
  db.prepare(LEGACY_INSERT).run(id, workspaceKey, id, archivedAt, createdAt, createdAt);
}

function rowsByWorkspace(
  db: DatabaseSync,
): Array<{ id: string; workspace_key: string; identifier_seq: number | null }> {
  return db
    .prepare("SELECT id, workspace_key, identifier_seq FROM work_items ORDER BY workspace_key, id")
    .all() as unknown as Array<{
    id: string;
    workspace_key: string;
    identifier_seq: number | null;
  }>;
}

test("0018｜新库：账本 18 条（0018 收尾），7 列按 ALTER 序追加，唯一索引就位", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const ids = ledgerIds(db);
  assert.equal(ids.length, 18, "账本应到 0018（0001–0017 + 0018）");
  assert.equal(ids.at(-1), "0018_work_item_surface_fields");
  assert.deepEqual(
    columnNames(db, "work_items").slice(-SURFACE_COLUMNS.length),
    [...SURFACE_COLUMNS],
    "7 列必须按 ALTER 顺序追加在末尾（列名写错时读回恒 undefined 且不报错）",
  );
  assert.deepEqual(indexNames(db, "idx_work_items%").sort(), [
    "idx_work_items_identifier",
    "idx_work_items_parent",
    "idx_work_items_status",
    "idx_work_items_workspace",
  ]);
  assert.deepEqual(
    identifierIndexFacts(db),
    { unique: 1, columns: ["workspace_key", "identifier_seq"] },
    "唯一索引必须是 UNIQUE(workspace_key, identifier_seq) 且不带 archived_at 谓词（归档行也占号）",
  );
  db.close();
});

test("0018｜老库升级：identifier_seq 每 workspace 按 (created_at, id) 从 1 回填（含同刻 tie-break 与归档行）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  downgradeTo0017(db);

  /* 老数据刻意造得「插入序 ≠ 编号序」，且含两条 created_at 相同的行：
     ws-a：c(300) / a(100) / b(200) / 同刻并列 d(200, id 大于 b) / 归档行 old(50)
     期望编号（created_at ASC, id ASC）：old=1, a=2, b=3, d=4, c=5
     —— 归档行也占号（不用 archived_at 谓词），同刻按 id 定序（不靠插入顺序碰运气）。 */
  legacyRow(db, "c", "ws-a", 300);
  legacyRow(db, "a", "ws-a", 100);
  legacyRow(db, "b", "ws-a", 200);
  legacyRow(db, "d", "ws-a", 200);
  legacyRow(db, "old", "ws-a", 50, 999);
  legacyRow(db, "z", "ws-b", 700);
  legacyRow(db, "y", "ws-b", 600);

  runTasksDatabaseMigrations(db);

  assert.deepEqual(
    rowsByWorkspace(db)
      .filter((row) => row.workspace_key === "ws-a")
      .map((row) => [row.id, row.identifier_seq]),
    [
      ["a", 2],
      ["b", 3],
      ["c", 5],
      ["d", 4],
      ["old", 1],
    ],
    "ws-a 必须按 (created_at, id) 编号且归档行占 1 号",
  );
  assert.deepEqual(
    rowsByWorkspace(db)
      .filter((row) => row.workspace_key === "ws-b")
      .map((row) => [row.id, row.identifier_seq]),
    [
      ["y", 1],
      ["z", 2],
    ],
    "序号是**每 workspace** 的：ws-b 从 1 重新起（不是全局单调）",
  );
  db.close();
});

test("0018｜零回填：老库升级后 priority / 日期 / creator 三族全为 NULL（不编造值）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  downgradeTo0017(db);
  legacyRow(db, "legacy", "ws-a", 100);
  runTasksDatabaseMigrations(db);

  const row = db
    .prepare(
      "SELECT priority, start_date, due_date, creator_kind, creator_id, creator_display_name FROM work_items WHERE id = 'legacy'",
    )
    .get() as Record<string, string | null>;
  assert.deepEqual(
    { ...row },
    {
      priority: null,
      start_date: null,
      due_date: null,
      creator_kind: null,
      creator_id: null,
      creator_display_name: null,
    },
  );
  assert.equal(
    (
      db.prepare("SELECT identifier_seq FROM work_items WHERE id='legacy'").get() as {
        identifier_seq: number;
      }
    ).identifier_seq,
    1,
    "同一行里 identifier_seq 已回填：零回填只针对「无事实可依」的三族",
  );
  db.close();
});

test("0018｜升级恰执行 1 条：账本逐行一致、老库与从零建库同形状、再跑 no-op", () => {
  const full = openDb();
  runTasksDatabaseMigrations(full);
  const fullLedger = ledgerIds(full);

  const db = openDb();
  runTasksDatabaseMigrations(db);
  downgradeTo0017(db);
  legacyRow(db, "legacy", "ws-a", 100);

  const migrated: Array<string | null> = [];
  runTasksDatabaseMigrations(db, {
    onProgress: (phase, facts) => {
      if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
    },
  });
  assert.deepEqual(migrated, ["0017_work_item_pull_requests"], "老库升级只补跑 0018 一条");
  assert.deepEqual(ledgerIds(db), fullLedger);
  assert.deepEqual(columnNames(db, "work_items"), columnNames(full, "work_items"));
  assert.deepEqual(identifierIndexFacts(db), identifierIndexFacts(full));

  let again = 0;
  runTasksDatabaseMigrations(db, {
    onProgress: (phase) => {
      if (phase === "migrating") again++;
    },
  });
  assert.equal(again, 0, "已应用后再跑必须 no-op");
  assert.equal(
    (
      db.prepare("SELECT identifier_seq FROM work_items WHERE id='legacy'").get() as {
        identifier_seq: number;
      }
    ).identifier_seq,
    1,
    "回填是一次性的：重跑不得重编号",
  );
  db.close();
});

test("0018｜唯一索引承重：同 workspace 重复序号被拒，不同 workspace 同号互不干扰", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const insertWithSeq = (id: string, workspaceKey: string, seq: number) =>
    db
      .prepare(
        `INSERT INTO work_items (id, workspace_key, workspace_path, title, status, assignee_type,
           assignee_id, created_at, updated_at, identifier_seq) VALUES (?, ?, '/tmp/ws', ?, 'todo', 'user', 'u1', 1, 1, ?)`,
      )
      .run(id, workspaceKey, id, seq);
  insertWithSeq("one", "ws-a", 1);
  assert.throws(
    () => insertWithSeq("dup", "ws-a", 1),
    /UNIQUE|constraint/i,
    "同 workspace 撞号必须由存储层拒绝（写入口的顺序只是第一道防线）",
  );
  assert.doesNotThrow(
    () => insertWithSeq("two", "ws-b", 1),
    "序号是每 workspace 的，异 workspace 同号合法",
  );
  db.close();
});

test("0018｜账本 checksum 与迁移 SQL 同源（改了 SQL 文本 ⇒ 老库升级抛 checksum_mismatch）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const row = db
    .prepare(
      "SELECT checksum FROM tasks_schema_migration WHERE id = '0018_work_item_surface_fields'",
    )
    .get() as { checksum: string };
  assert.equal(
    row.checksum,
    createHash("sha256")
      .update(JSON.stringify([WORK_ITEM_SURFACE_FIELDS_SQL]))
      .digest("hex"),
    "0018 的 checksumInput 必须恰是它自己的 DDL 常量",
  );
  db.close();
});
