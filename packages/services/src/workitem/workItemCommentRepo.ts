import type { DatabaseSync } from "node:sqlite";

/* 协作域 X0.1：工作项评论的存储面（spec §3.2）。**唯一写者面**——CommentService（X1.2）
   是上层唯一公开入口；导出本 repo 会让调用方绕过幂等/触发语义直接写表。
   只增不改：UPDATE/DELETE 无 API；软删/解决态只写时间戳列，正文/作者/锚点一字不动。 */

export const COMMENT_COMMANDS = ["none", "note"] as const;
export type CommentCommand = (typeof COMMENT_COMMANDS)[number];

export type AuthorRef = {
  kind: "human" | "agent" | "system";
  id: string;
  displayName?: string;
};

export type SourceRunRef = {
  runId: string;
  agentId?: string;
  squadId?: string;
  role: "leader" | "member" | "standalone";
};

export type MentionRef = { type: "agent" | "squad" | "human" | "all"; id: string };

export type InlineAnchor = {
  path: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  baseRevision?: string;
};

export type WorkItemCommentRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  threadId: string;
  parentCommentId: string | null;
  author: AuthorRef;
  sourceRun: SourceRunRef | null;
  initiatedBy: AuthorRef;
  /** 原文（含命令前缀，审计）；创建后不可变。 */
  body: string;
  /** 去前缀正文（展示，§12.1-4）；与 body 同写同存，不靠展示时重解析。 */
  normalizedBody: string;
  mentions: MentionRef[];
  command: CommentCommand;
  inline: InlineAnchor | null;
  clientRequestId: string | null;
  /** 固定为 1（append-only ⇒ 版本不演进；排序由 createdAt+id 单源，§8.2）。 */
  revision: number;
  deletedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AddWorkItemCommentInput = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** 线程根 id：回复 = 父评论的 threadId（由服务层从父评论带过来，§3.2）；缺省 = 本评论 id（根评论）。 */
  threadId?: string;
  parentCommentId?: string;
  author: AuthorRef;
  sourceRun?: SourceRunRef;
  initiatedBy: AuthorRef;
  body: string;
  normalizedBody: string;
  mentions: MentionRef[];
  command?: CommentCommand;
  inline?: InlineAnchor | null;
  clientRequestId?: string;
  createdAt: number;
};

export interface WorkItemCommentRepo {
  /**
   * 追加一条评论。**幂等**（§8.1）：同 (workspace, author, clientRequestId) 的重试
   * 返回既存行（不写第二行、不重复写 Activity——Activity 归 X1.2 的服务层做）。
   * 空白正文拒绝（spec §3.2 body 约束）。
   */
  add(input: AddWorkItemCommentInput): WorkItemCommentRecord;
  get(id: string): WorkItemCommentRecord | null;
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemCommentRecord[];
  listByThread(workspaceKey: string, threadId: string): WorkItemCommentRecord[];
  /**
   * 全 workspace 枚举（§8.4-3 半途事务扫描的反连接读面）。定序与 `listByWorkItem` 同一 ORDER
   * （created_at + id，§8.2 单源）；软删行照样读出——扫描按「有没有对应 Activity」判定，
   * 过滤权不在读面（这里先过滤会让缺 Activity 的已删行永远补不上）。
   */
  listByWorkspace(workspaceKey: string): WorkItemCommentRecord[];
  /** 软删墓碑（§3.2 裁定#3）：只写 deletedAt，正文/作者/锚点一字不动；已删幂等。 */
  softDelete(id: string): void;
  /** 线程解决态（仅线程根，裁定#4）：只写 resolvedAt；置/消各写一次；解决态不影响触发。 */
  setResolved(id: string, resolved: boolean): void;
}

interface CommentRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  thread_id: string;
  parent_comment_id: string | null;
  author_kind: string;
  author_id: string;
  author_display_name: string | null;
  source_run_id: string | null;
  source_run_agent_id: string | null;
  source_run_squad_id: string | null;
  source_run_role: string | null;
  initiated_by_kind: string;
  initiated_by_id: string;
  body: string;
  normalized_body: string;
  mentions_json: string;
  command: string;
  inline_json: string | null;
  client_request_id: string | null;
  revision: number;
  deleted_at: number | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

const AUTHOR_KINDS = ["human", "agent", "system"] as const;
/** SourceRunRef.role 的取值域（§3.1 闭集）：评论与 Activity 两面共用同一常量，防止两侧守卫分叉。 */
export const SOURCE_RUN_ROLES = ["leader", "member", "standalone"] as const;
const MENTION_TYPES = ["agent", "squad", "human", "all"] as const;

/* 读回闸（readStatus 纪律）：枚举外值/坏 JSON 响亮抛——静默按默认处理会让
   「这条评论到底说了什么」变成没人知道的事。 */
function parseJson<T>(value: string, column: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`work_item_comments.${column} 读回非法 JSON：列被写坏，一律抛。`);
  }
}

function readAuthorKind(value: string): AuthorRef["kind"] {
  if (!(AUTHOR_KINDS as readonly string[]).includes(value)) {
    throw new Error(`work_item_comments.author_kind 读回非法值「${value}」：一律抛。`);
  }
  return value as AuthorRef["kind"];
}

function readCommand(value: string): CommentCommand {
  if (!(COMMENT_COMMANDS as readonly string[]).includes(value)) {
    throw new Error(`work_item_comments.command 读回非法值「${value}」：一律抛。`);
  }
  return value as CommentCommand;
}

function rowToComment(row: CommentRow): WorkItemCommentRecord {
  const mentions = parseJson<MentionRef[]>(row.mentions_json, "mentions_json");
  for (const mention of mentions) {
    if (!(MENTION_TYPES as readonly string[]).includes(mention.type)) {
      throw new Error(
        `work_item_comments.mentions_json 读回非法 mention 类型「${mention.type}」：一律抛。`,
      );
    }
  }
  const inline =
    row.inline_json === null ? null : parseJson<InlineAnchor>(row.inline_json, "inline_json");
  const sourceRun: SourceRunRef | null =
    row.source_run_id === null
      ? null
      : {
          runId: row.source_run_id,
          ...(row.source_run_agent_id !== null ? { agentId: row.source_run_agent_id } : {}),
          ...(row.source_run_squad_id !== null ? { squadId: row.source_run_squad_id } : {}),
          role: ((): SourceRunRef["role"] => {
            if (!(SOURCE_RUN_ROLES as readonly string[]).includes(row.source_run_role ?? "")) {
              throw new Error(
                `work_item_comments.source_run_role 读回非法值「${row.source_run_role}」：一律抛。`,
              );
            }
            return row.source_run_role as SourceRunRef["role"];
          })(),
        };
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    threadId: row.thread_id,
    parentCommentId: row.parent_comment_id,
    author: {
      kind: readAuthorKind(row.author_kind),
      id: row.author_id,
      ...(row.author_display_name !== null ? { displayName: row.author_display_name } : {}),
    },
    sourceRun,
    initiatedBy: {
      kind: readAuthorKind(row.initiated_by_kind),
      id: row.initiated_by_id,
    },
    body: row.body,
    normalizedBody: row.normalized_body,
    mentions,
    command: readCommand(row.command),
    inline,
    clientRequestId: row.client_request_id,
    revision: row.revision,
    deletedAt: row.deleted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkItemCommentRepo(db: DatabaseSync): WorkItemCommentRepo {
  const ORDER = "ORDER BY created_at ASC, id ASC";
  return {
    add(input) {
      if (input.body.trim().length === 0) {
        throw new Error("评论正文不得为空白（spec §3.2）：空白评论没有可审计的沟通内容。");
      }
      const now = input.createdAt;
      // 根评论 threadId = id（§3.2）；回复的 threadId 由服务层（X1.2）从父评论带过来（input.threadId）。
      const threadId = input.threadId ?? input.id;
      // 幂等（唯一索引 + 存在性返回，§8.1）：重试返回既存行，不写第二行。
      const existing = input.clientRequestId
        ? (db
            .prepare(
              `SELECT * FROM work_item_comments
                WHERE workspace_key = ? AND author_kind = ? AND author_id = ? AND client_request_id = ?`,
            )
            .get(input.workspaceKey, input.author.kind, input.author.id, input.clientRequestId) as
            | CommentRow
            | undefined)
        : undefined;
      if (existing) return rowToComment(existing);

      db.prepare(
        `INSERT INTO work_item_comments (
          id, workspace_key, workspace_path, work_item_id, thread_id, parent_comment_id,
          author_kind, author_id, author_display_name,
          source_run_id, source_run_agent_id, source_run_squad_id, source_run_role,
          initiated_by_kind, initiated_by_id,
          body, normalized_body, mentions_json, command, inline_json,
          client_request_id, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        input.id,
        input.workspaceKey,
        input.workspacePath,
        input.workItemId,
        threadId,
        input.parentCommentId ?? null,
        input.author.kind,
        input.author.id,
        input.author.displayName ?? null,
        input.sourceRun?.runId ?? null,
        input.sourceRun?.agentId ?? null,
        input.sourceRun?.squadId ?? null,
        input.sourceRun?.role ?? null,
        input.initiatedBy.kind,
        input.initiatedBy.id,
        input.body,
        input.normalizedBody,
        JSON.stringify(input.mentions),
        input.command ?? "none",
        input.inline === undefined || input.inline === null ? null : JSON.stringify(input.inline),
        input.clientRequestId ?? null,
        now,
        now,
      );
      return this.get(input.id)!;
    },

    get(id) {
      const row = db.prepare("SELECT * FROM work_item_comments WHERE id = ?").get(id) as
        | CommentRow
        | undefined;
      return row ? rowToComment(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_comments WHERE workspace_key = ? AND work_item_id = ? ${ORDER}`,
        )
        .all(workspaceKey, workItemId) as unknown as CommentRow[];
      return rows.map(rowToComment);
    },

    listByThread(workspaceKey, threadId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_comments WHERE workspace_key = ? AND thread_id = ? ${ORDER}`,
        )
        .all(workspaceKey, threadId) as unknown as CommentRow[];
      return rows.map(rowToComment);
    },

    listByWorkspace(workspaceKey) {
      const rows = db
        .prepare(`SELECT * FROM work_item_comments WHERE workspace_key = ? ${ORDER}`)
        .all(workspaceKey) as unknown as CommentRow[];
      return rows.map(rowToComment);
    },

    softDelete(id) {
      const row = db.prepare("SELECT deleted_at FROM work_item_comments WHERE id = ?").get(id) as
        | { deleted_at: number | null }
        | undefined;
      if (!row) {
        throw new Error(`work_item_comments 没有 id=「${id}」的行，无法软删：一律抛。`);
      }
      if (row.deleted_at !== null) return; // 已删幂等：不重写时间戳。
      db.prepare("UPDATE work_item_comments SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
        Date.now(),
        Date.now(),
        id,
      );
    },

    setResolved(id, resolved) {
      const row = db
        .prepare("SELECT thread_id, resolved_at FROM work_item_comments WHERE id = ?")
        .get(id) as { thread_id: string; resolved_at: number | null } | undefined;
      if (!row) {
        throw new Error(`work_item_comments 没有 id=「${id}」的行，无法置解决态：一律抛。`);
      }
      // §3.2 裁定#4「仅根可置/消」——存储面同步守卫（服务层同款守卫是第一道；直接调 repo 的
      // 调用方（测试/未来入口）也不能把回复置成已解决，否则语义在绕过服务层时静默漂移）。
      if (row.thread_id !== id) {
        throw new Error(
          `work_item_comments 的「${id}」不是线程根（thread_id=${row.thread_id}）：解决态仅根可置/消（§3.2），一律抛。`,
        );
      }
      if (resolved === (row.resolved_at !== null)) return; // 状态已一致 ⇒ no-op。
      db.prepare("UPDATE work_item_comments SET resolved_at = ?, updated_at = ? WHERE id = ?").run(
        resolved ? Date.now() : null,
        Date.now(),
        id,
      );
    },
  };
}
