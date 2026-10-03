import {
  WAKE_ON_TIMEOUTS,
  WAKE_PAUSE_REASONS,
  WAKE_RULE_KINDS,
  WAKE_RULE_MODES,
  type WakeRule,
} from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/* 唤醒规则仓库：wake_rules 表的读写。刻意不进 packages/services/src/index.ts——
   调度器（Task 5）才是唯一消费方，导出 Repo 会让调用方绕过调度决策直接改规则状态。 */
interface WakeRuleRow {
  id: string;
  work_item_id: string;
  kind: string;
  mode: string;
  at: number | null;
  interval_seconds: number | null;
  cron_expression: string | null;
  timezone: string | null;
  condition: string | null;
  event_types: string | null;
  filters: string | null;
  next_fire_at: number | null;
  max_fires: number | null;
  fire_count: number;
  paused_reason: string | null;
  expires_at: number | null;
  on_timeout: string | null;
  revision: number;
  enabled: number;
}

/* 4 个枚举列的读回校验器。集合直接取自 shared 的常量（Task 3），两侧共用一处定义——
   若这里各写一份字面量，改枚举时只会改一边，读回校验与域模型就会悄悄对不上。 */
const kindColumn = z.enum(WAKE_RULE_KINDS);
const modeColumn = z.enum(WAKE_RULE_MODES);
const pausedReasonColumn = z.enum(WAKE_PAUSE_REASONS);
const onTimeoutColumn = z.enum(WAKE_ON_TIMEOUTS);

/* DB 读边界的**契约违例断言**（与 `leaderDispatch` 的 default 分支同一裁定：宁可响亮失败，
   也不静默跳过）。枚举列若出现写入路径之外的值——手改库、跨版本残留、或将来某处漏走 schema 的写入——
   调度器的 `switch (rule.kind)` 会走到**无分支**：既不跑也不响，用户看到的是「这条规则不生效」，
   而真正的成因（数据坏了）被完全隐藏。写路径已由 schema 保证合法，这里只拦「绕过 schema 落进库」的行，
   所以非法值一律抛错并点名**表.列 + 实际值**，让人能直接去查那一行。
   注意：这里**不是**在给正常路径加容错分支，而是把契约钉死——与 leaderDispatch 对未知 assignee.type 抛错的理由一致。 */
function enumColumn<T extends string>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
  column: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `wake_rules.${column} 的值「${String(value)}」不在允许集合内（契约违例）：` +
        "该列只允许由 schema 写入，出现枚举外的值说明这一行绕过了 schema，请检查数据库",
    );
  }
  return parsed.data;
}

// 可空列统一折回 undefined（而不是 null）：WakeRule 的可选字段语义是「未设置」，
// 回传 null 会让调用方多做一层判空，也把「列存了 NULL」误当成「设成了 null」。
function rowToWakeRule(row: WakeRuleRow): WakeRule {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    // 4 个枚举列经校验读回（不再 `as` 强转）：非法值抛错而不是带进调度器（见 enumColumn 说明）。
    kind: enumColumn(kindColumn, row.kind, "kind"),
    mode: enumColumn(modeColumn, row.mode, "mode"),
    at: row.at ?? undefined,
    intervalSeconds: row.interval_seconds ?? undefined,
    cronExpression: row.cron_expression ?? undefined,
    timezone: row.timezone ?? undefined,
    condition: row.condition ? (JSON.parse(row.condition) as WakeRule["condition"]) : undefined,
    eventTypes: row.event_types ? (JSON.parse(row.event_types) as string[]) : undefined,
    filters: row.filters ? (JSON.parse(row.filters) as Record<string, unknown>) : undefined,
    nextFireAt: row.next_fire_at ?? undefined,
    maxFires: row.max_fires ?? undefined,
    fireCount: row.fire_count,
    pausedReason:
      row.paused_reason === null
        ? undefined
        : enumColumn(pausedReasonColumn, row.paused_reason, "paused_reason"),
    expiresAt: row.expires_at ?? undefined,
    onTimeout:
      row.on_timeout === null
        ? undefined
        : enumColumn(onTimeoutColumn, row.on_timeout, "on_timeout"),
    revision: row.revision,
    enabled: row.enabled === 1,
  };
}

export interface WakeRuleRepo {
  /** 写入一行。调用方必须已用 validateWakeRule 校验互斥，本层不重复校验。 */
  insert(rule: WakeRule): void;
  get(id: string): WakeRule | null;
  /** 调度器扫表入口：只取 enabled 且已到点（next_fire_at <= now）的规则。
      依赖 idx_wake_rules_ready 部分索引；用 SQL 过滤而不是全表读回后内存筛，
      否则每次 tick 都要把禁用的死规则一并读出来。 */
  listReady(now: number, limit: number): WakeRule[];
  /**
   * **全表读取**（加法，P2b 第二半）：服务面 `listWakeRules` 的取数口 —— `wake_rules` 表没有
   * workspace 列（派发目标由工作项给出），「本 workspace 的规则」只能**全量读出后**按调用方的
   * 工作项 id 集合过滤，故这里不接过滤参数（SQL 不猜 workspace，按工作项过滤是调用方的事）。
   *
   * **排序**：`work_item_id ASC, created_at ASC, id ASC`，三层键全部确定。为什么不用
   * `listReady` 的到点序：本方法服务的是「读完过滤后直接呈现/遍历」，而不是到点批次 ——
   * 到点序在暂停/终态行（next_fire_at 为 NULL）上会先排空值再排活跃值，对「按工作项看规则」
   * 没有意义。取 work_item_id 优先是因为规则按工作项成组（挂在工作项上）；同组内按创建先后
   * （created_at），同刻创建（毫秒级并列）再按 id 兜底 —— 任何一层并列都不会让顺序随
   * 存储顺序漂移。
   */
  listAll(): WakeRule[];
  /** revision fencing（spec §5.7）：只有 revision 仍等于 expectRevision 才推进，
      命中即 revision+1。**单条条件 UPDATE**——先读后写会与并发派发竞态，
      让「编辑规则」后仍在飞的旧派发覆盖掉新状态。 */
  casAdvance(
    id: string,
    expectRevision: number,
    nextFireAt: number | null,
    fireCount: number,
    pausedReason?: string,
    /**
     * **可选**主开关（用户启停，`listReady` 的 `enabled = 1` 条件）：
     * 省略 = 原样保留（`COALESCE(?, enabled)`），给出才改。既有调用方（闸暂停 / 调度推进）不受影响 ——
     * 闸暂停只关排期、不动用户开关。
     */
    enabled?: boolean,
  ): boolean;
  listByWorkItem(workItemId: string): WakeRule[];
}

export function createWakeRuleRepo(db: DatabaseSync): WakeRuleRepo {
  return {
    insert(rule) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO wake_rules (
          id, work_item_id, kind, mode, at, interval_seconds, cron_expression, timezone,
          condition, event_types, filters, next_fire_at, max_fires, fire_count,
          paused_reason, expires_at, on_timeout, revision, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rule.id,
        rule.workItemId,
        rule.kind,
        rule.mode,
        rule.at ?? null,
        rule.intervalSeconds ?? null,
        rule.cronExpression ?? null,
        rule.timezone ?? null,
        rule.condition === undefined ? null : JSON.stringify(rule.condition),
        rule.eventTypes === undefined ? null : JSON.stringify(rule.eventTypes),
        rule.filters === undefined ? null : JSON.stringify(rule.filters),
        rule.nextFireAt ?? null,
        rule.maxFires ?? null,
        rule.fireCount,
        rule.pausedReason ?? null,
        rule.expiresAt ?? null,
        rule.onTimeout ?? null,
        rule.revision,
        rule.enabled ? 1 : 0,
        now,
        now,
      );
    },

    get(id) {
      const row = db.prepare("SELECT * FROM wake_rules WHERE id = ?").get(id) as
        | WakeRuleRow
        | undefined;
      return row ? rowToWakeRule(row) : null;
    },

    // 排序按 next_fire_at、再按 id：到点批次的处理顺序必须确定，
    // 否则同刻到点的规则会随存储顺序漂移，让「谁先被派发」变得不可复现。
    listReady(now, limit) {
      const rows = db
        .prepare(
          `SELECT * FROM wake_rules
          WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
          ORDER BY next_fire_at ASC, id ASC
          LIMIT ?`,
        )
        .all(now, limit) as unknown as WakeRuleRow[];
      return rows.map(rowToWakeRule);
    },

    // CAS 必须是单条条件更新并校验 changes：先读后写会与并发派发竞态。
    casAdvance(id, expectRevision, nextFireAt, fireCount, pausedReason, enabled) {
      const result = db
        .prepare(
          `UPDATE wake_rules SET next_fire_at=?, fire_count=?, paused_reason=?,
             enabled=COALESCE(?, enabled), revision=revision+1, updated_at=?
           WHERE id=? AND revision=?`,
        )
        .run(
          nextFireAt,
          fireCount,
          pausedReason ?? null,
          enabled === undefined ? null : enabled ? 1 : 0,
          Date.now(),
          id,
          expectRevision,
        );
      return result.changes === 1;
    },

    // 全表读取（读取面，非调度扫表）：排序按 work_item_id → created_at → id，三层键全确定 ——
    // 同一批规则的呈现次序不随存储顺序漂移（与 listByWorkItem / listByWorkspace 同一条理由）。
    listAll() {
      const rows = db
        .prepare("SELECT * FROM wake_rules ORDER BY work_item_id ASC, created_at ASC, id ASC")
        .all() as unknown as WakeRuleRow[];
      return rows.map(rowToWakeRule);
    },

    listByWorkItem(workItemId) {
      const rows = db
        .prepare("SELECT * FROM wake_rules WHERE work_item_id = ? ORDER BY created_at ASC, id ASC")
        .all(workItemId) as unknown as WakeRuleRow[];
      return rows.map(rowToWakeRule);
    },
  };
}
