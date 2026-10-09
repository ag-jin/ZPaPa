import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { WORK_ITEM_VIEWS_SQL } from "../src/session/tasksDatabase/schema-v1.js";

/* 迁移 **0020_work_item_views**（saved views 服务面轮 R6a）的直接用例。

   0020 一次建两张表（拆解报告 §T-P2-R6a 卡 + multica 265/268 先例，照抄切分）：
   · `work_item_views` —— 命名视图的结构化列 + 两个不透明 JSON 文档（query / display）；
   · `work_item_view_prefs` —— 每 owner 每 workspace 一行的视图条偏好文档。

   本文件断言**库的原始形状**（PRAGMA / sqlite_master / 裸 SQL），不经 repo 映射 ——
   映射层自己写错列名时读回仍是 `undefined`，只有裸读能抓到。
   对照先例（file:line 取证见 reports/2026-10-09-saved-views-multica-evidence.md §1/§2）：
   · multica `265_issue_view.up.sql:7-35`：结构化列 + `CHAR_LENGTH(name) BETWEEN 1 AND 80` +
     `scope_type/visibility` 闭集 + `query/display` 的 `jsonb_typeof='object'` + `my ⇒ private` 跨列 CHECK；
   · multica `266/267`：owner 查询索引 + `WHERE visibility='workspace'` 部分索引；
   · multica `268`：prefs 表 `PK (workspace_id, user_id, scope_type, scope_id)` + `prefs` JSON object。

   ZPaPa v1 的两处收窄（拆解卡明写）：
   · scope 只两档（`workspace` / `my`），`scope_id` / `scope_variant` 列**保留但恒空**
     （CHECK 钉住；variant 轴与 project 档后置，留列免将来再 ALTER）；
   · 无团队档（multica 答案同）。 */

const VIEW_COLUMNS = [
  "id",
  "workspace_key",
  "owner_kind",
  "owner_id",
  "name",
  "scope_type",
  "scope_id",
  "scope_variant",
  "visibility",
  "definition_version",
  "query",
  "display",
  "revision",
  "created_at",
  "updated_at",
] as const;

const PREFS_COLUMNS = ["workspace_key", "owner_kind", "owner_id", "prefs", "updated_at"] as const;

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

test("0020｜新库：账本 22 条（0022 收尾），两张表按声明序建出、两索引就位", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const ids = ledgerIds(db);
  assert.equal(ids.length, 22, "账本应到 0022（0001–0021 + 0022）");
  assert.equal(ids.at(-1), "0022_projects");
  assert.deepEqual(
    columnNames(db, "work_item_views"),
    [...VIEW_COLUMNS],
    "work_item_views 逐列（列名写错时读回恒 undefined 且不报错）",
  );
  assert.deepEqual(
    columnNames(db, "work_item_view_prefs"),
    [...PREFS_COLUMNS],
    "work_item_view_prefs 逐列",
  );
  assert.deepEqual(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_item_view%'",
        )
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .sort(),
    ["idx_work_item_views_owner", "idx_work_item_views_shared"],
    "两条索引（owner 查询 + shared 部分索引，照 multica 266/267）",
  );
  db.close();
});

test("0020｜shared 部分索引是部分索引：谓词恰是 visibility='workspace'（唯一+列序）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const fact = (name: string) => {
    const info = (
      db.prepare("PRAGMA index_list(work_item_views)").all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>
    ).find((row) => row.name === name);
    const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    return { unique: info?.unique ?? -1, partial: info?.partial ?? -1, columns };
  };
  assert.deepEqual(
    fact("idx_work_item_views_owner"),
    { unique: 0, partial: 0, columns: ["workspace_key", "owner_kind", "owner_id"] },
    "owner 索引是非唯一全表索引（列表的 owner 分支 + 配额计数共用它）",
  );
  assert.deepEqual(
    fact("idx_work_item_views_shared"),
    { unique: 0, partial: 1, columns: ["workspace_key"] },
    "shared 索引必须是 partial（WHERE visibility='workspace'），否则 shared 分支走不到它",
  );
  const sql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_work_item_views_shared'",
      )
      .get() as { sql: string }
  ).sql;
  assert.match(sql, /WHERE\s+visibility\s*=\s*'workspace'/, "谓词逐字：visibility='workspace'");
  db.close();
});

test("0020｜CHECK：scope 闭集 / my ⇒ private（含 UPDATE 路径）/ scope_id 与 variant 恒空", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const insert = (over: Record<string, string | null> = {}) => {
    const row = {
      id: "v1",
      scope_type: "workspace",
      scope_id: null,
      scope_variant: null,
      visibility: "private",
      ...over,
    };
    db.prepare(
      `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
         scope_id, scope_variant, visibility, definition_version, query, display, revision,
         created_at, updated_at)
       VALUES (?, 'ws', 'human', 'u1', '视图', ?, ?, ?, ?, 1, '{}', '{}', 1, 1, 1)`,
    ).run(row.id, row.scope_type, row.scope_id, row.scope_variant, row.visibility);
  };

  insert({ id: "shared-ok", visibility: "workspace" });
  insert({ id: "my-ok", scope_type: "my", visibility: "private" });
  assert.throws(
    () => insert({ id: "my-shared", scope_type: "my", visibility: "workspace" }),
    /CHECK/i,
    "my 档 + shared 必须被存储层拒绝（DB CHECK 是三道闸里的最后一道）",
  );
  assert.throws(
    () => insert({ id: "bad-scope", scope_type: "project" }),
    /CHECK/i,
    "v1 只有 workspace / my 两档（project 档后置）",
  );
  assert.throws(
    () => insert({ id: "bad-visibility", visibility: "team" }),
    /CHECK/i,
    "visibility 闭集 private / workspace",
  );
  assert.throws(
    () => insert({ id: "scoped", scope_id: "some-id" }),
    /CHECK/i,
    "scope_id 恒空（v1 两档都没有 scope id；列保留只为将来免 ALTER）",
  );
  assert.throws(
    () => insert({ id: "variant", scope_variant: "assigned" }),
    /CHECK/i,
    "scope_variant 恒空（v1 无 variant 轴）",
  );
  assert.throws(
    () => db.prepare("UPDATE work_item_views SET visibility='workspace' WHERE id='my-ok'").run(),
    /CHECK/i,
    "UPDATE 路径同样被 CHECK 拦住（patch 不能把 my 档改成 shared）",
  );
  db.close();
});

test("0020｜CHECK：name 1..80 按字符计（80 枚 emoji 合法、81 枚非法）、query/display 必须是 JSON object", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const insert = (id: string, name: string, query = "{}", display = "{}") =>
    db
      .prepare(
        `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
           visibility, definition_version, query, display, revision, created_at, updated_at)
         VALUES (?, 'ws', 'human', 'u1', ?, 'workspace', 'private', 1, ?, ?, 1, 1, 1)`,
      )
      .run(id, name, query, display);

  /* 长度按**码点**计（SQLite length() 不按 UTF-16 计）：80 枚 emoji = 80 个字符。
     服务面必须用同一把尺子（`[...name].length`），否则两条闸对同一个名字结论相反。 */
  insert("emoji80", "😀".repeat(80));
  assert.throws(() => insert("emoji81", "😀".repeat(81)), /CHECK/i, "81 枚 emoji 超限");
  insert("ascii80", "x".repeat(80));
  assert.throws(() => insert("ascii81", "x".repeat(81)), /CHECK/i, "81 个字符超限");
  assert.throws(() => insert("empty", ""), /CHECK/i, "空名必须被拒绝（1..80）");

  for (const [label, blob] of [
    ["数组", "[1,2]"],
    ["标量", "42"],
    ["字符串", '"x"'],
    ["JSON null", "null"],
    ["坏 JSON", "{oops"],
  ] as const) {
    assert.throws(
      () => insert(`q-${label}`, "视图", blob),
      /CHECK/i,
      `query = ${label} 必须被拒绝（multica 同款：jsonb_typeof='object'）`,
    );
    assert.throws(
      () => insert(`d-${label}`, "视图", "{}", blob),
      /CHECK/i,
      `display = ${label} 必须被拒绝`,
    );
  }
  db.close();
});

test("0020｜prefs 表：复合主键 (workspace_key, owner_kind, owner_id)、prefs 必须是 JSON object", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const put = (id: string, ws: string, kind: string, prefs: string) =>
    db
      .prepare(
        "INSERT INTO work_item_view_prefs (workspace_key, owner_kind, owner_id, prefs, updated_at) VALUES (?,?,?,?,1)",
      )
      .run(ws, kind, id, prefs);

  put("u1", "ws", "human", '{"hidden":[],"order":[]}');
  assert.throws(
    () => put("u1", "ws", "human", "{}"),
    /UNIQUE|PRIMARY KEY|constraint/i,
    "同键重复插入被拒",
  );
  put("u1", "ws-a", "human", "{}");
  put("u1", "ws", "agent", "{}");
  assert.throws(() => put("u2", "ws", "human", "[1]"), /CHECK/i, "数组不是文档");
  assert.throws(() => put("u3", "ws", "human", "3"), /CHECK/i, "标量不是文档");
  db.close();
});

test("0020｜账本 checksum 与迁移 SQL 同源（改了 SQL 文本 ⇒ 老库升级抛 checksum_mismatch）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const row = db
    .prepare("SELECT checksum FROM tasks_schema_migration WHERE id = '0020_work_item_views'")
    .get() as { checksum: string };
  assert.equal(
    row.checksum,
    createHash("sha256")
      .update(JSON.stringify([WORK_ITEM_VIEWS_SQL]))
      .digest("hex"),
    "0020 的 checksumInput 必须恰是它自己的 DDL 常量",
  );
  db.close();
});

test("0020｜老库升级：摘掉 0020 的两表两索引与账本行 ⇒ 恰补跑 1 条；再跑 no-op", () => {
  const full = openDb();
  runTasksDatabaseMigrations(full);
  const fullLedger = ledgerIds(full);

  const db = openDb();
  runTasksDatabaseMigrations(db);
  db.exec("DROP INDEX IF EXISTS idx_work_item_views_shared");
  db.exec("DROP INDEX IF EXISTS idx_work_item_views_owner");
  db.exec("DROP TABLE IF EXISTS work_item_view_prefs");
  db.exec("DROP TABLE IF EXISTS work_item_views");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0020_work_item_views'").run();

  const migrated: Array<string | null> = [];
  runTasksDatabaseMigrations(db, {
    onProgress: (phase, facts) => {
      if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
    },
  });
  /* 0021（工作项级 reactions）与 0022（项目绑定，R-P1）落地后账本头是 0022：上报值 = 本次执行前的
     账本头（头部只在循环之前采集一次），**不是**「补跑的是那一条」—— 补跑条数由数组长度（恰一条）钉住。 */
  assert.deepEqual(
    migrated,
    ["0022_projects"],
    "老库只补跑 0020 一条（值 = 补跑前的账本头 0022）",
  );
  assert.deepEqual(ledgerIds(db), fullLedger);
  assert.deepEqual(columnNames(db, "work_item_views"), columnNames(full, "work_item_views"));
  assert.deepEqual(
    columnNames(db, "work_item_view_prefs"),
    columnNames(full, "work_item_view_prefs"),
  );

  let again = 0;
  runTasksDatabaseMigrations(db, {
    onProgress: (phase) => {
      if (phase === "migrating") again++;
    },
  });
  assert.equal(again, 0, "已应用后再跑必须 no-op");
  db.close();
});
