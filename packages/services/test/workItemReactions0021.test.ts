import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { WORK_ITEM_REACTIONS_SQL } from "../src/session/tasksDatabase/schema-v1.js";

/* 迁移 **0021_work_item_reactions**（阶段三 P3-R5s：工作项级 reactions 服务面半边）的直接用例。

   建**单表** `work_item_reactions`（轻实体）+ 一条查询索引，五元组唯一键复用 ZPaPa 0010 评论
   reactions 的现成模板（`schema-v1.ts` 的 `work_item_comment_reactions`，与 multica `027` 同构）：
   · 五元组 `(workspace_key, work_item_id, author_kind, author_id, emoji)` —— 「同人同 emoji 恰一条」
     由存储层兜底（写路径 `INSERT OR IGNORE` + `changes()` 判真插入，见 repo 用例）；
   · **不加外键**（0010 同款理由：工作项只归档不硬删，外键会让归档路径的写被拒）；
   · **不白名单 emoji**：`CHECK (length(emoji) > 0)` 是唯一的存储层约束（multica 服务端零校验，
     写路径只拒空串）——放开完整 picker 时免迁移，这是刻意的宽松。

   本文件断言**库的原始形状**（PRAGMA / sqlite_master / 裸 SQL），不经 repo 映射 ——
   映射层自己写错列名时读回仍是 `undefined`，只有裸读能抓到。 */

const REACTION_COLUMNS = [
  "id",
  "workspace_key",
  "work_item_id",
  "author_kind",
  "author_id",
  "emoji",
  "created_at",
] as const;

const REACTION_INDEX = "idx_work_item_reactions_item";

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

/** 表上**全部**唯一索引的列序（含 SQLite 为表级 UNIQUE 约束自动建的 `sqlite_autoindex_*`）。 */
function uniqueIndexColumnOrders(db: DatabaseSync, table: string): string[][] {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) =>
      (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
}

/** 裸插入（绕过 repo）：`over` 覆盖默认的五元组/时间戳。 */
function insertReaction(db: DatabaseSync, over: Record<string, string | number> = {}): void {
  const row = {
    id: "r-1",
    workspace_key: "ws",
    work_item_id: "wi-1",
    author_kind: "human",
    author_id: "hu-1",
    emoji: "👍",
    created_at: 100,
    ...over,
  };
  db.prepare(
    `INSERT INTO work_item_reactions (id, workspace_key, work_item_id, author_kind, author_id,
       emoji, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.workspace_key,
    row.work_item_id,
    row.author_kind,
    row.author_id,
    row.emoji,
    row.created_at,
  );
}

test("0021｜新库：账本 21 条（0021 收尾），work_item_reactions 逐列建出、查询索引就位", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const ids = ledgerIds(db);
  assert.equal(ids.length, 21, "账本应到 0021（0001–0020 + 0021）");
  assert.equal(ids.at(-1), "0021_work_item_reactions");
  assert.deepEqual(
    columnNames(db, "work_item_reactions"),
    [...REACTION_COLUMNS],
    "work_item_reactions 逐列（列名写错时读回恒 undefined 且不报错）",
  );
  const index = (
    db.prepare("PRAGMA index_list(work_item_reactions)").all() as Array<{
      name: string;
      unique: number;
    }>
  ).find((row) => row.name === REACTION_INDEX);
  assert.ok(index, `索引 ${REACTION_INDEX} 必须存在`);
  assert.equal(index.unique, 0, "查询索引非唯一（唯一性由五元组约束兜）");
  assert.deepEqual(
    (db.prepare(`PRAGMA index_info(${REACTION_INDEX})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
    ["workspace_key", "work_item_id", "created_at"],
    "索引列序 = 查询口径（按工作项取该行、按插入序排）",
  );
  db.close();
});

test("0021｜唯一键恰是五元组：同键第二行被拒，五个分量各自不同则各自成行", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  // 唯一索引恰两条：主键自动索引（id）+ 一条五元组约束 —— 多一条或少一条都要在这里现形。
  assert.deepEqual(
    uniqueIndexColumnOrders(db, "work_item_reactions")
      .map((columns) => columns.join(","))
      .sort(),
    ["id", "workspace_key,work_item_id,author_kind,author_id,emoji"],
    "唯一键恰一条且列序固定（摘掉任一列 ⇒ 「同人同 emoji 恰一条」失效）",
  );
  const pk = (
    db.prepare("PRAGMA table_info(work_item_reactions)").all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((column) => column.pk === 1)
    .map((column) => column.name);
  assert.deepEqual(pk, ["id"], "主键 = id（行身份；唯一键是另一条约束，两者不可互替）");

  insertReaction(db);
  assert.throws(
    () => insertReaction(db, { id: "r-dup" }),
    /UNIQUE|constraint/i,
    "同五元组重复插入必须被存储层拒绝（唯一键是幂等的最后一道闸）",
  );
  // 五个分量逐个不同 ⇒ 各自成行（一人多 emoji / 多人同 emoji / 跨工作项 / 跨 kind）。
  insertReaction(db, { id: "r-emoji", emoji: "🎉" });
  insertReaction(db, { id: "r-author", author_id: "hu-2" });
  insertReaction(db, { id: "r-kind", author_kind: "agent" });
  insertReaction(db, { id: "r-item", work_item_id: "wi-2" });
  insertReaction(db, { id: "r-ws", workspace_key: "ws-2" });
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_reactions").get() as { n: number };
  assert.equal(count.n, 6, "六个不同五元组各自成行");
  db.close();
});

test("0021｜存储不白名单：非空即合法（自定义 token / 超长串都能落库），空串被 CHECK 拒绝", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  // multica `027` 的服务端零校验口径：emoji 就是非空字符串 —— 白名单在 UI 层，不在存储层
  // （写进 DDL 会让「放开完整 picker」变成一次数据迁移）。
  insertReaction(db, { id: "r-custom", emoji: ":custom_party_parrot:" });
  insertReaction(db, { id: "r-long", emoji: "x".repeat(100) });
  assert.throws(
    () => insertReaction(db, { id: "r-empty", emoji: "" }),
    /CHECK/i,
    "空串必须被检查约束拒绝（唯一被存储层拒绝的输入）",
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_reactions").get() as { n: number };
  assert.equal(count.n, 2, "两条非常规 emoji 都在库里（存储层不筛内容）");
  db.close();
});

test("0021｜账本 checksum 与迁移 SQL 同源（改了 SQL 文本 ⇒ 老库升级抛 checksum_mismatch）", () => {
  const db = openDb();
  runTasksDatabaseMigrations(db);
  const row = db
    .prepare("SELECT checksum FROM tasks_schema_migration WHERE id = '0021_work_item_reactions'")
    .get() as { checksum: string };
  assert.equal(
    row.checksum,
    createHash("sha256")
      .update(JSON.stringify([WORK_ITEM_REACTIONS_SQL]))
      .digest("hex"),
    "0021 的 checksumInput 必须恰是它自己的 DDL 常量",
  );
  db.close();
});

test("0021｜老库升级：摘掉 0021 的表/索引与账本行 ⇒ 恰补跑 1 条；再跑 no-op", () => {
  const full = openDb();
  runTasksDatabaseMigrations(full);
  const fullLedger = ledgerIds(full);

  const db = openDb();
  runTasksDatabaseMigrations(db);
  db.exec(`DROP INDEX IF EXISTS ${REACTION_INDEX}`);
  db.exec("DROP TABLE IF EXISTS work_item_reactions");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0021_work_item_reactions'").run();

  const migrated: Array<string | null> = [];
  runTasksDatabaseMigrations(db, {
    onProgress: (phase, facts) => {
      if (phase === "migrating") migrated.push(facts.lastAppliedMigrationId ?? null);
    },
  });
  assert.deepEqual(migrated, ["0020_work_item_views"], "老库只补跑 0021 一条");
  assert.deepEqual(ledgerIds(db), fullLedger);
  assert.deepEqual(
    columnNames(db, "work_item_reactions"),
    columnNames(full, "work_item_reactions"),
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
