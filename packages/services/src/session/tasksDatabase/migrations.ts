import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOMATION_SCHEMA,
  COMMENT_DISPATCH_RECEIPT_SQL,
  INBOX_ITEM_SCHEMA,
  OFF_PEAK_SCHEMA,
  SQUAD_RUN_CAUSE_SQL,
  SQUAD_RUN_QUEUE_SQL,
  SQUAD_RUN_USAGE_SQL,
  SQUAD_RUN_WATCHDOG_SQL,
  WORK_ITEM_COLLABORATION_SQL,
  WORK_ITEM_COLLABORATION_SQL_2,
  WORK_ITEM_COLLABORATION_SQL_3,
  SQUAD_RUN_SCHEMA,
  TASK_INDEX_SCHEMA,
  WAKE_RULE_SCHEMA,
  WORK_ITEM_DELIVERABLE_SQL,
  WORK_ITEM_PULL_REQUEST_SQL,
  WORK_ITEM_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;

// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
const definitions = [
  {
    id: "0001_adopt_task_schema",
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
  {
    id: "0004_work_items",
    checksumInput: [WORK_ITEM_SCHEMA],
  },
  {
    id: "0005_wake_rules",
    checksumInput: [WAKE_RULE_SCHEMA],
  },
  {
    id: "0006_squad_runs",
    checksumInput: [SQUAD_RUN_SCHEMA],
  },
  {
    id: "0007_inbox_items",
    checksumInput: [INBOX_ITEM_SCHEMA],
  },
  /* 0008 只加两列（`ALTER TABLE ADD COLUMN`），**不改既有列/表**：既有库的 checksum 一字不动，
     新库与老库升级后同一形状。SQL 冻结后不得再改（改了老库升级会抛 checksum_mismatch）。 */
  {
    id: "0008_squad_run_cause",
    checksumInput: [SQUAD_RUN_CAUSE_SQL],
  },
  /* 0009 只加索引与新表（队列唯一性 / 容量计数 / deferred 义务 / 并入留痕），不加列不改既有表：
     既有库 checksum 一字不动，SQL 冻结后不得再改（同 0008 纪律）。 */
  {
    id: "0009_squad_run_queue",
    checksumInput: [SQUAD_RUN_QUEUE_SQL],
  },
  /* 0010（协作域 X0.1）：评论 + 表情回应两张表（Activity/Decision 在 X0.2 追加 0011）。
     只加新对象，不改既有表——checksum 纪律同 0008/0009。 */
  {
    id: "0010_workitem_collaboration",
    checksumInput: [WORK_ITEM_COLLABORATION_SQL],
  },
  /* 0011（协作域 X0.2）：Activity（sequence 原子生成）+ Decision。 */
  {
    id: "0011_workitem_activity_decision",
    checksumInput: [WORK_ITEM_COLLABORATION_SQL_2],
  },
  /* 0012（协作域 X1.2）：评论派发 receipt（dispatch_key 主键 + outcome 闭集）。 */
  {
    id: "0012_comment_dispatch_receipts",
    checksumInput: [COMMENT_DISPATCH_RECEIPT_SQL],
  },
  /* 0013（协作域 X1.3 修复）：Activity 补 sourceRun 全形状三列（读回不再硬编码 role="member"）
     + deferred 义务表加 origin 来源判别列（评论义务与 R2 义务分流）。只加列，不改既有列/表。 */
  {
    id: "0013_collaboration_source_run_and_origin",
    checksumInput: [WORK_ITEM_COLLABORATION_SQL_3],
  },
  /* 0014（看门狗 W1）：squad_runs 加 `opened_at`（TTL 起算点）/ `settle_reason`（结算原因）
     两列 + 非 queued 行回填。只加列，不改既有列/表——checksum 纪律同 0008/0009/0013。 */
  {
    id: "0014_squad_run_watchdog",
    checksumInput: [SQUAD_RUN_WATCHDOG_SQL],
  },
  /* 0015（#6 按 run 用量记账 CT.1）：squad_runs 加 9 个用量列（8 数值 + `usage_recorded_at`
     存在性开关；NULL = 未记录 ≠ 0）。只加列、**零回填**（没有会话就没有用量，回填无事实可依），
     不改既有列/表——checksum 纪律同 0008/0009/0013/0014。 */
  {
    id: "0015_squad_run_usage",
    checksumInput: [SQUAD_RUN_USAGE_SQL],
  },
  /* 0016（#7 工作项级交付物 D1a）：建 `work_item_deliverables` 一张新表 + 两索引。
     只加新对象，不改既有列/表——checksum 纪律同 0008/0009/0010/0011/0012。 */
  {
    id: "0016_work_item_deliverables",
    checksumInput: [WORK_ITEM_DELIVERABLE_SQL],
  },
  /* 0017（#8 GitHub PR 集成 D2）：建 `work_item_pull_requests` 一张新表 + 两索引
     （工作项↔PR 关联 + 快照列，head-SHA 防陈旧写）。
     只加新对象，不改既有列/表——checksum 纪律同 0008/0009/0010/0011/0012/0016。 */
  {
    id: "0017_work_item_pull_requests",
    checksumInput: [WORK_ITEM_PULL_REQUEST_SQL],
  },
] as const;

export function runTasksDatabaseMigrations(
  db: DatabaseSync,
  options: {
    transactionOpen?: boolean;
    migration?: DatabaseMigrationFacts;
    onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
  } = {},
): void {
  if (!options.transactionOpen) db.exec("BEGIN IMMEDIATE");
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
  };
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) migrationFacts.kind = inspectTasksMigrationKind(db);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    // 锁内、版本 SQL 之前采集；空账本是 none，异常编号不作为遥测原文发送。
    const baseline = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
      .get();
    migrationFacts.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    for (const migration of definitions) {
      currentMigrationId = migration.id;
      const checksum = createHash("sha256")
        .update(JSON.stringify(migration.checksumInput))
        .digest("hex");
      const applied = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(migration.id);
      if (applied) {
        if (applied.checksum !== checksum)
          throw Object.assign(
            new Error(`Task database migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        continue;
      }
      if (migrationFacts.kind === "none") migrationFacts.kind = "upgrade";
      options.onProgress?.("migrating", { ...migrationFacts });
      if (migration.id === "0001_adopt_task_schema") adoptSchema(db);
      else if (migration.id === "0002_provider_selection") importLegacyAutomationSelections(db);
      else if (migration.id === "0004_work_items") db.exec(WORK_ITEM_SCHEMA);
      else if (migration.id === "0005_wake_rules") db.exec(WAKE_RULE_SCHEMA);
      else if (migration.id === "0006_squad_runs") db.exec(SQUAD_RUN_SCHEMA);
      else if (migration.id === "0007_inbox_items") db.exec(INBOX_ITEM_SCHEMA);
      else if (migration.id === "0008_squad_run_cause") db.exec(SQUAD_RUN_CAUSE_SQL);
      else if (migration.id === "0009_squad_run_queue") db.exec(SQUAD_RUN_QUEUE_SQL);
      else if (migration.id === "0010_workitem_collaboration") db.exec(WORK_ITEM_COLLABORATION_SQL);
      else if (migration.id === "0011_workitem_activity_decision")
        db.exec(WORK_ITEM_COLLABORATION_SQL_2);
      else if (migration.id === "0012_comment_dispatch_receipts")
        db.exec(COMMENT_DISPATCH_RECEIPT_SQL);
      else if (migration.id === "0013_collaboration_source_run_and_origin")
        db.exec(WORK_ITEM_COLLABORATION_SQL_3);
      else if (migration.id === "0014_squad_run_watchdog") db.exec(SQUAD_RUN_WATCHDOG_SQL);
      else if (migration.id === "0015_squad_run_usage") db.exec(SQUAD_RUN_USAGE_SQL);
      else if (migration.id === "0016_work_item_deliverables") db.exec(WORK_ITEM_DELIVERABLE_SQL);
      else if (migration.id === "0017_work_item_pull_requests") db.exec(WORK_ITEM_PULL_REQUEST_SQL);
      else db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL);
      migrationFacts.executedCount++;
      db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    options.onProgress?.("committing", { ...migrationFacts });
    db.exec("COMMIT");
    migrationFacts.committedCount = migrationFacts.executedCount;
  } catch (error) {
    // 回滚也可能因 IO 失败，不能覆盖真正导致迁移失败的异常。
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 调用方关闭连接恢复。 */
    }
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}

/** 交接只复用已完成初始化；每个新连接仍按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(db: DatabaseSync): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  for (const migration of definitions) {
    const row = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get(migration.id);
    if (!row) return false;
    const expected = createHash("sha256")
      .update(JSON.stringify(migration.checksumInput))
      .digest("hex");
    if (row.checksum !== expected)
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
      });
  }
  return true;
}

/** 只读账本的展示预检，不授权执行；迁移 runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const migration of definitions) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(migration.id)
      : undefined;
    if (!row) pending = true;
    else if (
      row.checksum !==
      createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex")
    )
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
        migrationId: migration.id,
      });
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}
