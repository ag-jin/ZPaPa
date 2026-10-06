/* oxlint-disable eslint(max-lines) -- 冻结 SQL 累积文件：每条迁移按「只加不改、SQL 冻结」纪律
   在同文件追加 DDL（0012 起过 400 行门槛）。拆文件会改动已发布迁移的 import 路径（迁移账本
   checksum 绑定的是 SQL 文本，与文件位置无关，但拆分的收益只是行数）——本条理由与
   squadRunRepo 的 max-lines 例外同款：文件本身就是按顺序累积的单一对象集。 */
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

// 0007 追加：收件箱（Inbox）实体。只新增，不改既有表/列。
// 这张表是「需人介入的事 → 一条可查的记录」的**机械落点**（spec §3.x 实体表 / §5.7.4 冲突 / §6.2 队员失败 /
// §6.6 启动和解）：此前这些事实只在日志与状态变迁里，没有可查的实体。
// · `dedup_key` + 唯一索引是**存储层的幂等不变式**（见 idx_inbox_items_dedup）：同一事实重投不得产生
//   第二条、已归档不得被重投复活 —— 两条都靠「冲突时不更新任何列」实现，不靠「先查后插」（并发下两次查
//   都可能看不到对方）。
// · `kind` 回答「这是什么」（枚举由 inboxItemRepo 单源定义），`severity` 只回答「多急」。
// · `detail_json` 是结构化事实（分支名 / runId / reason 原文等），不拆列：形状随产生点而变，
//   拆列会把未枚举的字段当未知列拒掉（与 WAKE_RULE_SCHEMA 的 condition/filters 同一条理由）。
// · `read_at` / `archived_at` 可空且**只由专用写入口改**：已读与归档是两件正交的事。
// · 刻意不建指向 work_items / squad_runs 的外键：两者都只归档不硬删，外键会让写入失败
//   （与 WORK_ITEM_SCHEMA / SQUAD_RUN_SCHEMA 同一条理由）。
export const INBOX_ITEM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_items (
    id               TEXT PRIMARY KEY,
    workspace_key    TEXT NOT NULL,
    workspace_path   TEXT NOT NULL,
    dedup_key        TEXT NOT NULL,
    kind             TEXT NOT NULL,
    severity         TEXT NOT NULL,
    title            TEXT NOT NULL,
    detail_json      TEXT NOT NULL,
    work_item_id     TEXT,
    run_id           TEXT,
    created_at       INTEGER NOT NULL,
    read_at          INTEGER,
    archived_at      INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_dedup
    ON inbox_items(workspace_key, dedup_key);
  CREATE INDEX IF NOT EXISTS idx_inbox_items_active
    ON inbox_items(workspace_key, archived_at);
`;

// 0008 追加：给 squad_runs 落「派发成因」两列。只加列，不改既有列/表；NULL = 遗留行/未知成因（读回不得猜）。
export const SQUAD_RUN_CAUSE_SQL = `
  ALTER TABLE squad_runs ADD COLUMN dispatch_cause TEXT;
  ALTER TABLE squad_runs ADD COLUMN caused_by_run_id TEXT;
`;

/* 0009（C2 队列）：只加两索引与两张新表，**不加列**——0008 的列集断言在 0009 后逐字成立。
   · 部分唯一索引 = 「(workspace, workItem,agent) 至多一个待开 Run」的一条 DDL 表达
     （与 multica idx_one_pending_task_per_issue_agent_v2 同法；S6 §12.1-1 队列状态窗）；
   · 容量索引服务闸的 count(open)×agent 计数（C0 十点之 10：produced/rejected 不占容量）；
   · squad_run_deferred_dispatches = 运行中收到的派发请求的重放义务（S6 §12.1-2 deferred，
     资格判据与排队不同故分表）；squad_run_coalesced_details = 并入留痕（INSERT OR IGNORE 幂等）。 */
export const SQUAD_RUN_QUEUE_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_runs_one_queued_per_item_agent
    ON squad_runs(workspace_key, work_item_id, agent_id)
    WHERE status = 'queued';
  CREATE INDEX IF NOT EXISTS idx_squad_runs_agent_capacity
    ON squad_runs(workspace_key, agent_id, status);
  CREATE TABLE IF NOT EXISTS squad_run_deferred_dispatches (
    run_id           TEXT PRIMARY KEY,
    workspace_key    TEXT NOT NULL,
    work_item_id     TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    dispatch_cause   TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (workspace_key, work_item_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS squad_run_coalesced_details (
    request_run_id   TEXT PRIMARY KEY,
    target_run_id    TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
`;

/* 0010（协作域 X0.1）：四张表——work_item_comments（含软删/解决态墓碑、raw+normalized 双正文、
   clientRequestId 幂等键）、work_item_comment_reactions（轻实体，INSERT OR IGNORE 幂等）。
   Activity/Decision 两表在 X0.2 追加（同迁移号内不混轮次——0010 只加本卡的对象）。
   不给 work_items/squad_runs 建外键（只归档不硬删，同 WORK_ITEM_SCHEMA 理由）。 */
export const WORK_ITEM_COLLABORATION_SQL = `
  CREATE TABLE IF NOT EXISTS work_item_comments (
    id                    TEXT PRIMARY KEY,
    workspace_key         TEXT NOT NULL,
    workspace_path        TEXT NOT NULL,
    work_item_id          TEXT NOT NULL,
    thread_id             TEXT NOT NULL,
    parent_comment_id     TEXT,
    author_kind           TEXT NOT NULL,
    author_id             TEXT NOT NULL,
    author_display_name   TEXT,
    source_run_id         TEXT,
    source_run_agent_id   TEXT,
    source_run_squad_id   TEXT,
    source_run_role       TEXT,
    initiated_by_kind     TEXT NOT NULL,
    initiated_by_id       TEXT NOT NULL,
    body                  TEXT NOT NULL,
    normalized_body       TEXT NOT NULL,
    mentions_json         TEXT NOT NULL DEFAULT '[]',
    command               TEXT NOT NULL DEFAULT 'none',
    inline_json           TEXT,
    client_request_id     TEXT,
    revision              INTEGER NOT NULL DEFAULT 1,
    deleted_at            INTEGER,
    resolved_at           INTEGER,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    UNIQUE (workspace_key, author_kind, author_id, client_request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_work_item_comments_item
    ON work_item_comments(workspace_key, work_item_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_work_item_comments_thread
    ON work_item_comments(workspace_key, thread_id, created_at, id);
  CREATE TABLE IF NOT EXISTS work_item_comment_reactions (
    id            TEXT PRIMARY KEY,
    workspace_key TEXT NOT NULL,
    comment_id    TEXT NOT NULL,
    author_kind   TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    emoji         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    UNIQUE (workspace_key, comment_id, author_kind, author_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_work_item_comment_reactions_comment
    ON work_item_comment_reactions(comment_id);
`;

/* 0011（协作域 X0.2）：Activity（每 WorkItem 单调 sequence——INSERT…SELECT COALESCE(MAX)+1 原子生成，
   多窗口 Host 共用同一 tasks-index 库文件，禁止 JS 先查后插/内存 counter）与 Decision（只增不改）。
   不给 work_items 建外键（只归档不硬删，同前）。 */
export const WORK_ITEM_COLLABORATION_SQL_2 = `
  CREATE TABLE IF NOT EXISTS work_item_activities (
    id                TEXT PRIMARY KEY,
    workspace_key     TEXT NOT NULL,
    workspace_path    TEXT NOT NULL,
    work_item_id      TEXT NOT NULL,
    kind              TEXT NOT NULL,
    sequence          INTEGER NOT NULL,
    occurred_at       INTEGER NOT NULL,
    actor_kind        TEXT NOT NULL,
    actor_id          TEXT NOT NULL,
    actor_display_name TEXT,
    source_run_id     TEXT,
    initiated_by_kind TEXT NOT NULL,
    initiated_by_id   TEXT NOT NULL,
    comment_id        TEXT,
    decision_id       TEXT,
    dispatch_event_id TEXT,
    payload_json      TEXT NOT NULL DEFAULT '{}',
    dedup_key         TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (workspace_key, work_item_id, sequence),
    UNIQUE (workspace_key, dedup_key)
  );
  CREATE INDEX IF NOT EXISTS idx_work_item_activities_item
    ON work_item_activities(workspace_key, work_item_id, sequence);
  CREATE TABLE IF NOT EXISTS work_item_decisions (
    id                  TEXT PRIMARY KEY,
    workspace_key       TEXT NOT NULL,
    workspace_path      TEXT NOT NULL,
    work_item_id        TEXT NOT NULL,
    thread_id           TEXT,
    parent_decision_id  TEXT,
    author_kind         TEXT NOT NULL,
    author_id           TEXT NOT NULL,
    source_run_id       TEXT,
    initiated_by_kind   TEXT NOT NULL,
    initiated_by_id     TEXT NOT NULL,
    kind                TEXT NOT NULL,
    subject             TEXT NOT NULL,
    selection_json      TEXT NOT NULL DEFAULT '{}',
    rationale           TEXT,
    evidence_json       TEXT NOT NULL DEFAULT '[]',
    effective_at        INTEGER NOT NULL,
    dedup_key           TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (workspace_key, dedup_key)
  );
  CREATE INDEX IF NOT EXISTS idx_work_item_decisions_item
    ON work_item_decisions(workspace_key, work_item_id, effective_at, id);
`;

/* 0013（协作域 X1.3 修复轮）：
   ① work_item_activities 补 sourceRun 全形状三列——0011 只存了 source_run_id，读回曾硬编码
      role="member"（队长 run 的 Activity 读回变队员，agentId/squadId 一并丢失）：静默失真。
      0011 的 SQL 已发布冻结（checksum 不可改），按 0008/0009 的加法纪律追加新迁移。
   ② squad_run_deferred_dispatches 加 origin（义务来源闭集 'reassign'|'comment'）：评论 deferred
      义务与 R2 义务同表且无来源判别列，claimDue 一视同仁认领后 host 会把评论 dispatchKey
      当 eventKey 重放。NOT NULL DEFAULT 'reassign' ⇒ 历史行与未标注写入方保持 R2 语义（向后兼容）。
   只加列、不改既有列/表；SQL 冻结后不得再改（改了老库升级会抛 checksum_mismatch）。 */
export const WORK_ITEM_COLLABORATION_SQL_3 = `
  ALTER TABLE work_item_activities ADD COLUMN source_run_agent_id TEXT;
  ALTER TABLE work_item_activities ADD COLUMN source_run_squad_id TEXT;
  ALTER TABLE work_item_activities ADD COLUMN source_run_role TEXT;
  ALTER TABLE squad_run_deferred_dispatches ADD COLUMN origin TEXT NOT NULL DEFAULT 'reassign';
`;

/* 0012（协作域 X1.2）：评论派发 receipt 表。一行 = 一次「评论请求某目标 agent」的事实。
   · dispatch_key 是**请求身份**（`computeCommentDispatchKey` 独立构造，§8.1：不复用 eventKey
     拼接格式）；主键唯一 ⇒ 同键重投由存储层兜住，不需要先查后插。
   · outcome 闭集读写双闸（见 commentDispatchReceiptRepo 的 readOutcome/assertOutcome）：
     枚举外值读回/写入一律抛，静默按默认处理会让「这条请求到底派没派出去」变成没人知道的事。
   · 两个索引都服务读路径：item 索引给时间线取某工作项的 receipt；outcome 索引给启动重投
     （§8.4-1 扫描未完成 receipt）按 workspace + 状态取数。
   · 不给 work_items 建外键（只归档不硬删，同前）。 */
export const COMMENT_DISPATCH_RECEIPT_SQL = `
  CREATE TABLE IF NOT EXISTS comment_dispatch_receipts (
    dispatch_key     TEXT PRIMARY KEY,
    workspace_key    TEXT NOT NULL,
    work_item_id     TEXT NOT NULL,
    target_agent_id  TEXT NOT NULL,
    comment_id       TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    source           TEXT NOT NULL,
    outcome          TEXT NOT NULL,
    detail_json      TEXT NOT NULL DEFAULT '{}',
    attempt_count    INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comment_dispatch_receipts_item
    ON comment_dispatch_receipts(workspace_key, work_item_id, created_at, dispatch_key);
  CREATE INDEX IF NOT EXISTS idx_comment_dispatch_receipts_outcome
    ON comment_dispatch_receipts(workspace_key, outcome);
`;
