import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORK_ITEM_PULL_REQUEST_SQL } from "../src/session/tasksDatabase/schema-v1.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

/* #8 D2 **独立复验**（test-verifier）：迁移 0017 的**表结构**与**账本**，用 PRAGMA / 裸 SQL 直查，
   不经过 repo 的映射层（repo 的读写闸在别的用例里测）。

   判据来自任务卡（设计 §4.2 的四条）而不是实现：
   ① 三件套的表形状：multica 镜像列（M1）+ 快照列（M2），**单表精简**；
   ② `state` 四值闭集**可空**：NULL = 从未拉取（离线缺省形态下不伪造 open）；
   ③ **不做 checks 汇总列**（`checks_rollup_state` 要 GraphQL statusCheckRollup，v1 走 REST，宁缺不伪造）；
   ④ 幂等身份是业务键**唯一索引** `(workspace_key, work_item_id, repo_owner, repo_name, pr_number)`；
      `snapshot_head_sha` 是防陈旧写的 pin，缺省空串（NOT NULL，不是 NULL）。
      另：0016 的 SQL 一字未动 ⇒ 老库升级的 checksum 不漂移（本文件用**基线提交**算出的确数冻结它）。 */

const HERE = dirname(fileURLToPath(import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function tableInfo(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
}

/* ---------------- ① 表结构（PRAGMA 直查，期望值手写自任务卡，不取自实现常量） ---------------- */

test("0017 表结构｜20 列逐列形状：multica 镜像列 + 快照列；state 可空、pin NOT NULL DEFAULT ''", () => {
  const db = freshDb();
  const columns = tableInfo(db, "work_item_pull_requests");
  assert.deepEqual(
    columns.map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      dflt: column.dflt_value,
      pk: column.pk,
    })),
    [
      { name: "id", type: "TEXT", notnull: 0, dflt: null, pk: 1 },
      { name: "workspace_key", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "workspace_path", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "work_item_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "repo_owner", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "repo_name", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "pr_number", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
      { name: "title", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "html_url", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "branch", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      /* state 可空：NULL = 从未拉取（不是「未知识别成 open」）。 */
      { name: "state", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "merged_at", type: "INTEGER", notnull: 0, dflt: null, pk: 0 },
      { name: "api_mergeable", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "api_merge_state_status", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "snapshot_head_sha", type: "TEXT", notnull: 1, dflt: "''", pk: 0 },
      { name: "snapshot_fetched_at", type: "INTEGER", notnull: 0, dflt: null, pk: 0 },
      { name: "linked_by_kind", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "linked_by_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
    ],
  );

  /* 「宁缺不伪造」负向：v1 不做 checks 汇总（没有这一列），也没有 multica 多租户那两张表的痕迹。 */
  const names = columns.map((column) => column.name);
  for (const forbidden of [
    "checks_rollup_state",
    "checks_rollup",
    "github_installation",
    "issue_pull_request",
    "dedup_key",
  ]) {
    assert.equal(
      names.includes(forbidden),
      false,
      `0017 不该有 ${forbidden} 列（设计 §4.2 的裁剪）`,
    );
  }
  db.close();
});

test("0017 索引｜业务键唯一索引逐列 + 两条具名索引；唯一约束由裸 SQL 拒绝重复（不靠 repo）", () => {
  const db = freshDb();
  const indexes = db
    .prepare("PRAGMA index_list(work_item_pull_requests)")
    .all() as unknown as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  const named = indexes
    .filter((index) => index.name.startsWith("idx_work_item_pull_requests"))
    .map((index) => index.name)
    .sort();
  assert.deepEqual(named, ["idx_work_item_pull_requests_item", "idx_work_item_pull_requests_pr"]);

  const uniqueBusinessKey = indexes.filter((index) => index.unique === 1 && index.origin === "u");
  assert.equal(uniqueBusinessKey.length, 1, "恰一条表级唯一约束（业务键）");
  const columnsOf = (name: string) =>
    (db.prepare(`PRAGMA index_info(${name})`).all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
  assert.deepEqual(
    columnsOf(uniqueBusinessKey[0]!.name),
    ["workspace_key", "work_item_id", "repo_owner", "repo_name", "pr_number"],
    "幂等身份必须是这五列的业务键",
  );
  assert.deepEqual(columnsOf("idx_work_item_pull_requests_item"), [
    "workspace_key",
    "work_item_id",
    "created_at",
    "id",
  ]);
  assert.deepEqual(columnsOf("idx_work_item_pull_requests_pr"), [
    "workspace_key",
    "repo_owner",
    "repo_name",
    "pr_number",
  ]);

  /* 裸 SQL：同一业务键第二次 INSERT 必须抛（唯一索引是幂等的兜底，不是靠 repo 先查后插）。 */
  const insert = (id: string) =>
    db
      .prepare(
        `INSERT INTO work_item_pull_requests (
           id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number,
           title, html_url, snapshot_head_sha, linked_by_kind, linked_by_id, created_at, updated_at
         ) VALUES (?, 'ws', '/w', 'wi-1', 'acme', 'widget', 7, 't', 'u', '', 'human', 'u-1', 1, 1)`,
      )
      .run(id);
  insert("pr-raw-1");
  assert.throws(() => insert("pr-raw-2"), /UNIQUE|constraint/i, "同业务键第二行必须被唯一索引拒");
  /* 业务键任一列不同 ⇒ 是新的一条关联（不同工作项 / 不同 PR 号各自成立）。 */
  db.prepare(
    `INSERT INTO work_item_pull_requests (
       id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number,
       title, html_url, snapshot_head_sha, linked_by_kind, linked_by_id, created_at, updated_at
     ) VALUES ('pr-raw-3', 'ws', '/w', 'wi-2', 'acme', 'widget', 7, 't', 'u', '', 'human', 'u-1', 1, 1)`,
  ).run();
  /* NOT NULL 也由 DDL 兜底（空白不是这里的判据 —— 那是 repo 的形态闸）。 */
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO work_item_pull_requests (
             id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number,
             title, html_url, snapshot_head_sha, linked_by_kind, linked_by_id, created_at, updated_at
           ) VALUES ('pr-raw-4', NULL, '/w', 'wi-3', 'acme', 'widget', 7, 't', 'u', '', 'human', 'u-1', 1, 1)`,
        )
        .run(),
    /NOT NULL|constraint/i,
  );
  db.close();
});

test("0017 缺省态｜裸 INSERT 省略快照列 ⇒ state 为 NULL 而 pin 是空串（「没有快照」与「sha 是空」两件事）", () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO work_item_pull_requests (
       id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number,
       title, html_url, linked_by_kind, linked_by_id, created_at, updated_at
     ) VALUES ('pr-default', 'ws', '/w', 'wi-1', 'acme', 'widget', 7, 't', 'u', 'human', 'u-1', 1, 1)`,
  ).run();
  const row = db.prepare("SELECT * FROM work_item_pull_requests WHERE id = 'pr-default'").get() as
    | Record<string, unknown>
    | undefined;
  assert.ok(row);
  assert.equal(row!.state, null, "从未拉取 ⇒ NULL（不伪造 open）");
  assert.equal(row!.merged_at, null);
  assert.equal(row!.branch, null);
  assert.equal(row!.api_mergeable, null);
  assert.equal(row!.api_merge_state_status, null);
  assert.equal(row!.snapshot_fetched_at, null);
  assert.equal(row!.snapshot_head_sha, "", "pin 缺省是空串（NOT NULL 的哨兵值）");
  db.close();
});

/* ---------------- ② 迁移账本：17 条、0017 就位、0016 checksum 不漂移 ---------------- */

const LEDGER_IDS = [
  "0001_adopt_task_schema",
  "0002_provider_selection",
  "0003_official_glm_selection",
  "0004_work_items",
  "0005_wake_rules",
  "0006_squad_runs",
  "0007_inbox_items",
  "0008_squad_run_cause",
  "0009_squad_run_queue",
  "0010_workitem_collaboration",
  "0011_workitem_activity_decision",
  "0012_comment_dispatch_receipts",
  "0013_collaboration_source_run_and_origin",
  "0014_squad_run_watchdog",
  "0015_squad_run_usage",
  "0016_work_item_deliverables",
  "0017_work_item_pull_requests",
];

/**
 * 0016 的 checksum **确数**：由基线提交 `2ac77ad` 的 `schema-v1.ts` 原文算出
 * （`sha256(JSON.stringify([WORK_ITEM_DELIVERABLE_SQL]))`，独立复验时在仓库外用 node:crypto 复算）。
 * 冻结它的理由：老库的 `tasks_schema_migration` 里记的就是这个值 —— D2 若动了 0016 的 SQL 文本，
 * 老库升级会在 checksum 比对处抛 `checksum_mismatch`，而新库全绿、单测全绿。
 */
const FROZEN_0016_CHECKSUM = "61d1cbe6506fb9deb73e9f84df807feef2e756cba11c1a12fce925b89b756490";

test("账本｜17 条逐条对号；0016 checksum 与基线冻结值一字不差（D2 没动交付物迁移）", () => {
  const db = freshDb();
  const rows = db
    .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id")
    .all() as unknown as Array<{ id: string; checksum: string }>;
  assert.deepEqual(
    rows.map((row) => row.id),
    LEDGER_IDS,
    "账本恰 17 条（D2 只追加 0017，不改既有 id）",
  );
  const byId = new Map(rows.map((row) => [row.id, row.checksum]));
  assert.equal(
    byId.get("0016_work_item_deliverables"),
    FROZEN_0016_CHECKSUM,
    "0016 的 checksum 必须仍等于基线提交算出的确数：动了 SQL 文本 ⇒ 老库升级抛 checksum_mismatch",
  );
  assert.equal(
    byId.get("0017_work_item_pull_requests"),
    createHash("sha256")
      .update(JSON.stringify([WORK_ITEM_PULL_REQUEST_SQL]))
      .digest("hex"),
    "0017 登记的就是它自己的 DDL（账本与实际执行同一来源）",
  );
  db.close();
});

test("升级路径｜把 0017 行与其对象摘掉再跑 ⇒ 恰执行 1 条（kind=upgrade）且既有账本不报 checksum_mismatch", () => {
  const db = freshDb();
  // 模拟「D2 之前建的库」：账本里去掉 0017 行、库里去掉 0017 的两个对象。
  db.exec("DROP TABLE work_item_pull_requests");
  db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0017_work_item_pull_requests'").run();
  const facts = { kind: "none", executedCount: 0, committedCount: 0 } as never;
  runTasksDatabaseMigrations(db, { migration: facts });
  assert.deepEqual(
    {
      kind: (facts as { kind: string }).kind,
      executed: (facts as { executedCount: number }).executedCount,
    },
    { kind: "upgrade", executed: 1 },
    "老库升级只跑 0017（0017 之前的 16 条 checksum 全部命中，未抛 checksum_mismatch）",
  );
  const info = tableInfo(db, "work_item_pull_requests");
  assert.equal(info.length, 20, "升级后表被重建为同一形状");
  const count = db.prepare("SELECT COUNT(*) AS n FROM tasks_schema_migration").get() as {
    n: number;
  };
  assert.equal(count.n, 17);
  db.close();
});

/* ---------------- ③ 迁移定义与 SQL 的表述一致（DDL 是唯一来源，不在别处二次维护） ---------------- */

test("DDL 常量｜schema-v1 里的 0017 SQL 含单表 + 两索引，且没有在别处再写一份 DDL", () => {
  assert.match(WORK_ITEM_PULL_REQUEST_SQL, /CREATE TABLE IF NOT EXISTS work_item_pull_requests/);
  assert.equal(
    (WORK_ITEM_PULL_REQUEST_SQL.match(/CREATE TABLE/g) ?? []).length,
    1,
    "单表（不是 multica 的三表镜像）",
  );
  assert.equal((WORK_ITEM_PULL_REQUEST_SQL.match(/CREATE INDEX/g) ?? []).length, 2);
  const migrations = readFileSync(
    resolve(HERE, "../src/session/tasksDatabase/migrations.ts"),
    "utf8",
  );
  assert.equal(
    (migrations.match(/CREATE TABLE IF NOT EXISTS work_item_pull_requests/g) ?? []).length,
    0,
    "DDL 只在 schema-v1 常量里（migrations 只 exec 它，不复制一份）",
  );
});
