// 0001 接管已有分散建表；发布后保持声明不变，后续变更新增 migration。
export const TASK_INDEX_SCHEMA = `
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        task_status TEXT,
        provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        model TEXT,
        migration_source TEXT,
        forked_from_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workspace_key, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_archived_updated
      ON tasks (workspace_key, archived, updated_at DESC)
      WHERE deleted = 0;

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_pinned_updated
      ON tasks (workspace_key, pinned, updated_at DESC)
      WHERE deleted = 0;

      CREATE TABLE IF NOT EXISTS task_groups (
        group_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_group_members (
        group_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        sort_order INTEGER,
        added_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, task_id),
        FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_group_view_node_orders (
        node_type TEXT NOT NULL,
        node_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (node_type, node_key)
      );

      CREATE TABLE IF NOT EXISTS task_group_workspace_bootstraps (
        workspace_key TEXT PRIMARY KEY,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_group_members_group_order
      ON task_group_members (group_id, sort_order, added_at);

      CREATE INDEX IF NOT EXISTS idx_task_group_view_node_orders_order
      ON task_group_view_node_orders (sort_order, created_at);
    `;

export const AUTOMATION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS automations (
        automation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        mode TEXT,
        thought_level TEXT,
        model_selection TEXT,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        target_task_id TEXT,
        bot_delivery_target TEXT,
        location_kind TEXT NOT NULL DEFAULT 'local',
        recurring INTEGER NOT NULL DEFAULT 1,
        max_runs INTEGER,
        end_at INTEGER,
        schedule_rule TEXT,
        schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        scheduled_run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        next_run_at INTEGER,
        last_run_at INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        dispatch_status TEXT NOT NULL DEFAULT 'idle',
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_due
      ON automations (enabled, next_run_at);

      CREATE INDEX IF NOT EXISTS idx_automations_retry
      ON automations (enabled, retry_at);

      CREATE INDEX IF NOT EXISTS idx_automations_workspace
      ON automations (workspace_key);

      CREATE TABLE IF NOT EXISTS automation_runs (
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        scheduled_at INTEGER,
        trigger TEXT NOT NULL DEFAULT 'schedule',
        model_selection TEXT,
        dispatch_status TEXT NOT NULL DEFAULT 'claimed',
        outcome TEXT,
        session_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_by_automation
      ON automation_runs (automation_id, created_at DESC);
    `;

export const OFF_PEAK_SCHEMA = `
      CREATE TABLE IF NOT EXISTS off_peak_tasks (
        off_peak_task_id   TEXT PRIMARY KEY,
        server_ticket_id   TEXT,
        title              TEXT NOT NULL DEFAULT '',
        conversation_id    TEXT,
        session_id         TEXT,
        prompt             TEXT NOT NULL,
        permission_mode    TEXT NOT NULL,
        model              TEXT,
        thought_level      TEXT,
        model_selection    TEXT,
        workspace_key      TEXT NOT NULL,
        workspace_path     TEXT NOT NULL,
        workspace_identity TEXT,
        status             TEXT NOT NULL,
        queued_at          INTEGER NOT NULL,
        started_at         INTEGER,
        ended_at           INTEGER,
        failure_reason     TEXT,
        files_changed      INTEGER,
        settled_at         INTEGER,
        history_deleted_at INTEGER,
        registered_at      INTEGER,
        schedulable        INTEGER NOT NULL DEFAULT 0,
        queue_position     INTEGER,
        next_poll_at       INTEGER,
        claim_running      INTEGER NOT NULL DEFAULT 0,
        claimed_at         INTEGER,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_off_peak_pick
      ON off_peak_tasks (status, queued_at);

      CREATE INDEX IF NOT EXISTS idx_off_peak_ws
      ON off_peak_tasks (workspace_key, status);
    `;

// 0004 追加：工作项表。只新增，不改既有表/列，老库升级安全（IF NOT EXISTS 可重复应用）。
// assignee_type 不建外键：归档对象长期保留（只归档不硬删），外键会让写入失败。
export const WORK_ITEM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_items (
    id                 TEXT PRIMARY KEY,
    workspace_key      TEXT NOT NULL,
    workspace_path     TEXT NOT NULL,
    parent_id          TEXT,
    stage              INTEGER,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL,
    assignee_type      TEXT NOT NULL,
    assignee_id        TEXT NOT NULL,
    labels             TEXT NOT NULL DEFAULT '[]',
    properties         TEXT NOT NULL DEFAULT '{}',
    position           REAL NOT NULL DEFAULT 0,
    archived_at        INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_items_parent
    ON work_items(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_work_items_status
    ON work_items(workspace_key, status) WHERE archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_work_items_workspace
    ON work_items(workspace_key, updated_at DESC);
`;

// 0005 追加：唤醒规则表。同样只新增。列与 WakeRule 域模型**逐字段对齐**（见 @zcode/shared
// wakeRuleSchema）：少一列不会报错，只会在落盘/读回时静默丢字段，故两者必须同步增删。
// condition/filters/eventTypes 是结构化值，域模型没有固定形状（spec §3.5 未枚举），
// 故按文本 JSON 存取而不是拆列——拆列会把未枚举的参数当未知列拒掉。
export const WAKE_RULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wake_rules (
    id               TEXT PRIMARY KEY,
    work_item_id     TEXT NOT NULL,
    kind             TEXT NOT NULL,
    mode             TEXT NOT NULL,
    at               INTEGER,
    interval_seconds INTEGER,
    cron_expression  TEXT,
    timezone         TEXT,
    condition        TEXT,
    event_types      TEXT,
    filters          TEXT,
    next_fire_at     INTEGER,
    max_fires        INTEGER,
    fire_count       INTEGER NOT NULL DEFAULT 0,
    paused_reason    TEXT,
    expires_at       INTEGER,
    on_timeout       TEXT,
    revision         INTEGER NOT NULL DEFAULT 0,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wake_rules_ready
    ON wake_rules(next_fire_at) WHERE enabled=1 AND next_fire_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wake_rules_work_item
    ON wake_rules(work_item_id);
`;

// 0006 追加：小队运行台账。只新增，不改既有表/列。
// 这张表是硬约束 2 的落点：启动回收的「活跃集合」必须**跨重启存活**——
// 内存里的「当前有没有在跑的 run」既活不过重启，也会把「已产出但未合并」漏在外面。
// branch / dir_name 可空：队长 run 不建工作树（spec §6.1「是否开工作树是本次运行的属性」）。
// 刻意不建指向 work_items 的外键：工作项只归档不硬删，外键会让写入失败（与 WORK_ITEM_SCHEMA 同一条理由）。
export const SQUAD_RUN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS squad_runs (
    run_id               TEXT PRIMARY KEY,
    workspace_key        TEXT NOT NULL,
    workspace_path       TEXT NOT NULL,
    work_item_id         TEXT NOT NULL,
    parent_work_item_id  TEXT NOT NULL,
    agent_id             TEXT NOT NULL,
    is_leader_task       INTEGER NOT NULL,
    branch               TEXT,
    dir_name             TEXT,
    status               TEXT NOT NULL,
    session_id           TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_squad_runs_active
    ON squad_runs(workspace_key, status);
  CREATE INDEX IF NOT EXISTS idx_squad_runs_work_item
    ON squad_runs(work_item_id);
`;
