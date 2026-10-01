import type { WakeRule } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";

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

// 可空列统一折回 undefined（而不是 null）：WakeRule 的可选字段语义是「未设置」，
// 回传 null 会让调用方多做一层判空，也把「列存了 NULL」误当成「设成了 null」。
function rowToWakeRule(row: WakeRuleRow): WakeRule {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    kind: row.kind as WakeRule["kind"],
    mode: row.mode as WakeRule["mode"],
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
    pausedReason: (row.paused_reason ?? undefined) as WakeRule["pausedReason"],
    expiresAt: row.expires_at ?? undefined,
    onTimeout: (row.on_timeout ?? undefined) as WakeRule["onTimeout"],
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
  /** revision fencing（spec §5.7）：只有 revision 仍等于 expectRevision 才推进，
      命中即 revision+1。**单条条件 UPDATE**——先读后写会与并发派发竞态，
      让「编辑规则」后仍在飞的旧派发覆盖掉新状态。 */
  casAdvance(
    id: string,
    expectRevision: number,
    nextFireAt: number | null,
    fireCount: number,
    pausedReason?: string,
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
    casAdvance(id, expectRevision, nextFireAt, fireCount, pausedReason) {
      const result = db
        .prepare(
          `UPDATE wake_rules SET next_fire_at=?, fire_count=?, paused_reason=?, revision=revision+1, updated_at=?
           WHERE id=? AND revision=?`,
        )
        .run(nextFireAt, fireCount, pausedReason ?? null, Date.now(), id, expectRevision);
      return result.changes === 1;
    },

    listByWorkItem(workItemId) {
      const rows = db
        .prepare(
          "SELECT * FROM wake_rules WHERE work_item_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(workItemId) as unknown as WakeRuleRow[];
      return rows.map(rowToWakeRule);
    },
  };
}
