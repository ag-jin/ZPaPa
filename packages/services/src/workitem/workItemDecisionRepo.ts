import type { DatabaseSync } from "node:sqlite";
import type { AuthorRef } from "./workItemCommentRepo.js";

/* 协作域 X0.2：结构化裁决的存储面（spec §3.4）。只增不改：superseded 是**新行**
   （parentDecisionId 指向旧行），旧行永不更新——时间线必须能回答「当时定了什么、后来被什么取代」。
   本 repo 结构上不存在 WorkItem status 列（唯一写者纪律 §5.2：状态只经 WorkItemService.transition）。 */

export const WORK_ITEM_DECISION_KINDS = [
  "proposal",
  "accepted",
  "rejected",
  "superseded",
  "reopened",
] as const;
export type WorkItemDecisionKind = (typeof WORK_ITEM_DECISION_KINDS)[number];

export type WorkItemDecisionRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  threadId: string | null;
  parentDecisionId: string | null;
  author: AuthorRef;
  sourceRunId: string | null;
  initiatedBy: AuthorRef;
  kind: WorkItemDecisionKind;
  subject: string;
  selection: Record<string, unknown>;
  rationale: string | null;
  evidence: unknown[];
  effectiveAt: number;
  dedupKey: string;
  createdAt: number;
  updatedAt: number;
};

export type AddWorkItemDecisionInput = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  threadId?: string;
  parentDecisionId?: string;
  author: AuthorRef;
  sourceRunId?: string;
  initiatedBy: AuthorRef;
  kind: WorkItemDecisionKind;
  subject: string;
  selection?: Record<string, unknown>;
  rationale?: string;
  evidence?: unknown[];
  effectiveAt: number;
  dedupKey: string;
  createdAt: number;
};

export interface WorkItemDecisionRepo {
  /** 追加一条决定；dedupKey 幂等（同键重投返回既存行）。 */
  add(input: AddWorkItemDecisionInput): WorkItemDecisionRecord;
  get(id: string): WorkItemDecisionRecord | null;
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemDecisionRecord[];
}

interface DecisionRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  thread_id: string | null;
  parent_decision_id: string | null;
  author_kind: string;
  author_id: string;
  source_run_id: string | null;
  initiated_by_kind: string;
  initiated_by_id: string;
  kind: string;
  subject: string;
  selection_json: string;
  rationale: string | null;
  evidence_json: string;
  effective_at: number;
  dedup_key: string;
  created_at: number;
  updated_at: number;
}

function readDecisionKind(value: string): WorkItemDecisionKind {
  if (!(WORK_ITEM_DECISION_KINDS as readonly string[]).includes(value)) {
    throw new Error(`work_item_decisions.kind 读回非法值「${value}」：一律抛。`);
  }
  return value as WorkItemDecisionKind;
}

function readAuthorKind(value: string): AuthorRef["kind"] {
  if (!["human", "agent", "system"].includes(value)) {
    throw new Error(`work_item_decisions.author_kind 读回非法值「${value}」：一律抛。`);
  }
  return value as AuthorRef["kind"];
}

function rowToDecision(row: DecisionRow): WorkItemDecisionRecord {
  let selection: Record<string, unknown>;
  let evidence: unknown[];
  try {
    selection = JSON.parse(row.selection_json) as Record<string, unknown>;
    evidence = JSON.parse(row.evidence_json) as unknown[];
  } catch {
    throw new Error("work_item_decisions 的 JSON 列读回非法 JSON：一律抛。");
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    threadId: row.thread_id,
    parentDecisionId: row.parent_decision_id,
    author: { kind: readAuthorKind(row.author_kind), id: row.author_id },
    sourceRunId: row.source_run_id,
    initiatedBy: { kind: readAuthorKind(row.initiated_by_kind), id: row.initiated_by_id },
    kind: readDecisionKind(row.kind),
    subject: row.subject,
    selection,
    rationale: row.rationale,
    evidence,
    effectiveAt: row.effective_at,
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkItemDecisionRepo(db: DatabaseSync): WorkItemDecisionRepo {
  return {
    add(input) {
      if (!(WORK_ITEM_DECISION_KINDS as readonly string[]).includes(input.kind)) {
        throw new Error(`work_item_decisions.kind 拒绝写入非法值「${String(input.kind)}」`);
      }
      db.prepare(
        `INSERT OR IGNORE INTO work_item_decisions (
          id, workspace_key, workspace_path, work_item_id, thread_id, parent_decision_id,
          author_kind, author_id, source_run_id, initiated_by_kind, initiated_by_id,
          kind, subject, selection_json, rationale, evidence_json, effective_at, dedup_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.workspaceKey,
        input.workspacePath,
        input.workItemId,
        input.threadId ?? null,
        input.parentDecisionId ?? null,
        input.author.kind,
        input.author.id,
        input.sourceRunId ?? null,
        input.initiatedBy.kind,
        input.initiatedBy.id,
        input.kind,
        input.subject,
        JSON.stringify(input.selection ?? {}),
        input.rationale ?? null,
        JSON.stringify(input.evidence ?? []),
        input.effectiveAt,
        input.dedupKey,
        input.createdAt,
        input.createdAt,
      );
      const row = db
        .prepare("SELECT * FROM work_item_decisions WHERE workspace_key = ? AND dedup_key = ?")
        .get(input.workspaceKey, input.dedupKey) as DecisionRow | undefined;
      if (!row) {
        throw new Error(
          `work_item_decisions 写入后读不回（id=${input.id}, dedupKey=${input.dedupKey}）：不可达态。`,
        );
      }
      return rowToDecision(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM work_item_decisions WHERE id = ?").get(id) as
        | DecisionRow
        | undefined;
      return row ? rowToDecision(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_decisions WHERE workspace_key = ? AND work_item_id = ?
             ORDER BY effective_at ASC, id ASC`,
        )
        .all(workspaceKey, workItemId) as unknown as DecisionRow[];
      return rows.map(rowToDecision);
    },
  };
}
