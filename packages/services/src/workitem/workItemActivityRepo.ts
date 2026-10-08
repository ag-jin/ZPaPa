import type { DatabaseSync } from "node:sqlite";
import { SOURCE_RUN_ROLES, type AuthorRef, type SourceRunRef } from "./workItemCommentRepo.js";

/* 协作域 X0.2：工作项活动事实的存储面（spec §3.3）。**唯一写者面**（CommentService 在 X1.2）。
   两条铁律：
   ① sequence = 每 WorkItem 单调（§12.1-6 裁定），生成**写进语句本身**
     （INSERT…SELECT COALESCE(MAX)+1）——多窗口 Host 共用同一 tasks-index 库文件
     （taskIndexRepo.ts:524-533），JS 先查后插/内存 counter 都会在跨连接并发下重号；
   ② 只增不改：本文件结构上不存在 UPDATE/DELETE（负向守卫钉住）。 */

export const WORK_ITEM_ACTIVITY_KINDS = [
  "comment_created",
  "comment_mention_parsed",
  "comment_dispatch_requested",
  "comment_dispatch_suppressed",
  "comment_deleted",
  "comment_resolved",
  "comment_reaction_added",
  "decision_created",
  "status_changed",
  "assignee_changed",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  /* 第 19 枚（2026-10-08 用户裁定）：审查打回曾是时间线唯一不可见的终态 —— settleStatus 的
     rejected 臂此前无意图、零投影，打回只在 run 台账/快照里看得见。设计 §10-2 登记为开放问题，
     本枚即那格的关闭：与 run 族同形（键 `run:<id>:rejected`，payload 带 branch/agentId）。 */
  "run_rejected",
  "worktree_created",
  "worktree_merged",
  "worktree_discarded",
  "wake_rule_fired",
  /* 第 20 枚（#7 交付物 D1a）：一条交付物被登记（自动捕获或人工贴链）。
     为什么它必须是时间线事实：合并后分支即删（spec §6.3），交付物是产出的**唯一留痕**，
     而「谁在什么时候登记了什么」与评论/决定一样是审计链的一环——挂在独立表上只是它的
     存储形态（同 Comment/Decision 先例），不改变它作为时间线回声的身份。
     键形状 `deliverable:<deliverableId>:registered`（由交付物 id 派生，见投影模块）。 */
  "deliverable_registered",
] as const;
export type WorkItemActivityKind = (typeof WORK_ITEM_ACTIVITY_KINDS)[number];

export type WorkItemActivityRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  kind: WorkItemActivityKind;
  sequence: number;
  occurredAt: number;
  actor: AuthorRef;
  sourceRun: SourceRunRef | null;
  initiatedBy: AuthorRef;
  commentId: string | null;
  decisionId: string | null;
  dispatchEventId: string | null;
  payload: Record<string, unknown>;
  dedupKey: string;
  createdAt: number;
  updatedAt: number;
};

export type AddWorkItemActivityInput = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  kind: WorkItemActivityKind;
  occurredAt: number;
  actor: AuthorRef;
  sourceRun?: SourceRunRef;
  initiatedBy: AuthorRef;
  commentId?: string;
  decisionId?: string;
  dispatchEventId?: string;
  payload?: Record<string, unknown>;
  dedupKey: string;
  createdAt: number;
};

export interface WorkItemActivityRepo {
  /**
   * 追加一条活动事实（sequence 由语句内 MAX+1 原子生成）。
   * **dedupKey 幂等**（§8.1）：同键重投返回既存行（INSERT OR IGNORE + 唯一索引，
   * 不先查后插）；既存行**不再补写 comment/decision 等关联列**（事实只增不改）。
   */
  add(input: AddWorkItemActivityInput): WorkItemActivityRecord;
  get(id: string): WorkItemActivityRecord | null;
  /** 时间线口径：sequence ASC → occurredAt ASC → id ASC（§8.2 三键）。 */
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemActivityRecord[];
}

interface ActivityRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  kind: string;
  sequence: number;
  occurred_at: number;
  actor_kind: string;
  actor_id: string;
  actor_display_name: string | null;
  source_run_id: string | null;
  /* 0013 追加的三列：sourceRun 全形状（0011 只存 runId，读回曾硬编码 role="member"——X1.3 B2）。 */
  source_run_agent_id: string | null;
  source_run_squad_id: string | null;
  source_run_role: string | null;
  initiated_by_kind: string;
  initiated_by_id: string;
  comment_id: string | null;
  decision_id: string | null;
  dispatch_event_id: string | null;
  payload_json: string;
  dedup_key: string;
  created_at: number;
  updated_at: number;
}

function readKind(value: string): WorkItemActivityKind {
  if (!(WORK_ITEM_ACTIVITY_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_activities.kind 读回非法值「${value}」：列被写坏或闭集被改小，一律抛。`,
    );
  }
  return value as WorkItemActivityKind;
}

function assertKind(kind: WorkItemActivityKind): WorkItemActivityKind {
  if (!(WORK_ITEM_ACTIVITY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`work_item_activities.kind 拒绝写入非法值「${String(kind)}」（不在闭集内）`);
  }
  return kind;
}

function readAuthorKind(value: string): AuthorRef["kind"] {
  if (!["human", "agent", "system"].includes(value)) {
    throw new Error(`work_item_activities.actor_kind 读回非法值「${value}」：一律抛。`);
  }
  return value as AuthorRef["kind"];
}

/* B2 读回纪律：**不猜**。runId 有值就必须有合法角色——缺失（0013 之前的历史行只存了 runId，
   角色无从得知）或枚举外值一律响亮抛；静默按 "member" 处理会把队长 run 的 Activity 读成队员，
   正是 X1.3 独立验收抓到的静默失真。 */
function readSourceRunRole(value: string | null): SourceRunRef["role"] {
  if (value === null || !(SOURCE_RUN_ROLES as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_activities.source_run_role 读回非法值「${value}」：有 source_run_id 就必须有合法角色` +
        "（leader|member|standalone），历史行角色无从得知也不得猜，一律抛。",
    );
  }
  return value as SourceRunRef["role"];
}

function rowToSourceRun(row: ActivityRow): SourceRunRef | null {
  if (row.source_run_id === null) return null;
  return {
    runId: row.source_run_id,
    ...(row.source_run_agent_id !== null ? { agentId: row.source_run_agent_id } : {}),
    ...(row.source_run_squad_id !== null ? { squadId: row.source_run_squad_id } : {}),
    role: readSourceRunRole(row.source_run_role),
  };
}

function rowToActivity(row: ActivityRow): WorkItemActivityRecord {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    throw new Error("work_item_activities.payload_json 读回非法 JSON：一律抛。");
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    kind: readKind(row.kind),
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    actor: {
      kind: readAuthorKind(row.actor_kind),
      id: row.actor_id,
      ...(row.actor_display_name !== null ? { displayName: row.actor_display_name } : {}),
    },
    sourceRun: rowToSourceRun(row),
    initiatedBy: { kind: readAuthorKind(row.initiated_by_kind), id: row.initiated_by_id },
    commentId: row.comment_id,
    decisionId: row.decision_id,
    dispatchEventId: row.dispatch_event_id,
    payload,
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ORDER = "ORDER BY sequence ASC, occurred_at ASC, id ASC";

export function createWorkItemActivityRepo(db: DatabaseSync): WorkItemActivityRepo {
  return {
    add(input) {
      assertKind(input.kind);
      // sequence 生成写进语句（原子）；dedupKey 幂等靠唯一索引 + OR IGNORE。
      const changes = db
        .prepare(
          `INSERT OR IGNORE INTO work_item_activities (
            id, workspace_key, workspace_path, work_item_id, kind, sequence, occurred_at,
            actor_kind, actor_id, actor_display_name, source_run_id,
            source_run_agent_id, source_run_squad_id, source_run_role,
            initiated_by_kind, initiated_by_id,
            comment_id, decision_id, dispatch_event_id, payload_json, dedup_key,
            created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sequence) FROM work_item_activities
                                          WHERE workspace_key = ? AND work_item_id = ?), 0) + 1,  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
        )
        .run(
          input.id,
          input.workspaceKey,
          input.workspacePath,
          input.workItemId,
          input.kind,
          input.workspaceKey,
          input.workItemId,
          input.occurredAt,
          input.actor.kind,
          input.actor.id,
          input.actor.displayName ?? null,
          input.sourceRun?.runId ?? null,
          input.sourceRun?.agentId ?? null,
          input.sourceRun?.squadId ?? null,
          input.sourceRun?.role ?? null,
          input.initiatedBy.kind,
          input.initiatedBy.id,
          input.commentId ?? null,
          input.decisionId ?? null,
          input.dispatchEventId ?? null,
          JSON.stringify(input.payload ?? {}),
          input.dedupKey,
          input.createdAt,
          input.createdAt,
        ).changes;
      void changes; // 幂等重投 changes=0：按 dedupKey 读回既存行返回。
      const row = db
        .prepare("SELECT * FROM work_item_activities WHERE workspace_key = ? AND dedup_key = ?")
        .get(input.workspaceKey, input.dedupKey) as ActivityRow | undefined;
      if (!row) {
        throw new Error(
          `work_item_activities 写入后读不回（id=${input.id}, dedupKey=${input.dedupKey}）：不可达态，须查库。`,
        );
      }
      return rowToActivity(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM work_item_activities WHERE id = ?").get(id) as
        | ActivityRow
        | undefined;
      return row ? rowToActivity(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_activities WHERE workspace_key = ? AND work_item_id = ? ${ORDER}`,
        )
        .all(workspaceKey, workItemId) as unknown as ActivityRow[];
      return rows.map(rowToActivity);
    },
  };
}
