import { isTerminalWorkItemStatus, type WorkItem, type WorkItemStatusKey } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";

/* 工作项仓库：work_items 表的读写。刻意不进 packages/services/src/index.ts——
   服务层（workItemService）才是唯一公开入口与唯一写入者，导出 Repo 会让调用方绕过它。 */
interface WorkItemRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  parent_id: string | null;
  stage: number | null;
  title: string;
  body: string;
  status: string;
  assignee_type: string;
  assignee_id: string;
  labels: string;
  properties: string;
  position: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkItemRepo {
  /** 写入一行。调用方必须已校验环与深度（WORK_ITEM_MAX_DEPTH / 祖父链），本层不查父链。 */
  insert(item: WorkItem): void;
  get(id: string): WorkItem | null;
  listChildren(parentId: string): WorkItem[];
  /** 本 workspace 的全部在用工作项（不含归档）**：最小视图快照与「这批子项都完事了吗」的取数口。 */
  listByWorkspace(workspaceKey: string): WorkItem[];
  /** 指派对象反查（归档转交用，spec §3.10/S10）：`assignee = (type, id)` 且未归档。 */
  listByAssignee(type: WorkItem["assignee"]["type"], id: string): WorkItem[];
  /** CAS：仅当前状态等于 expect 且未归档时写入，命中恰一行才返回 true。 */
  updateStatus(id: string, next: WorkItemStatusKey, expect: WorkItemStatusKey): boolean;
  /**
   * 改写**指派**（归档转交：小队归档 → 指派转交队长，spec §3.10/S10）。
   *
   * 它不是「唯一写者」那条约束的例外：唯一写者管的是工作项 **`status`**
   * （只有 `workItemService.transition` 能写），指派是另一个字段。这里仍保持 CAS 式的
   * 「恰命中一行才算成功」：未命中说明该行已被归档或 id 算错，静默 no-op 会让调用方
   * 以为「转交完成了」而库里仍指着旧对象。
   */
  updateAssignee(id: string, assignee: WorkItem["assignee"]): boolean;
  /** 子项是否全部终态。判据是 category（isTerminalWorkItemStatus），不是状态键名。 */
  areAllChildrenTerminal(parentId: string): boolean;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    workspaceIdentity: row.workspace_key,
    workspacePath: row.workspace_path,
    parentId: row.parent_id ?? undefined,
    stage: row.stage ?? undefined,
    title: row.title,
    body: row.body,
    status: row.status as WorkItemStatusKey,
    assignee: { type: row.assignee_type as WorkItem["assignee"]["type"], id: row.assignee_id },
    labels: JSON.parse(row.labels) as string[],
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    position: row.position,
    archivedAt: row.archived_at ?? undefined,
  };
}

export function createWorkItemRepo(db: DatabaseSync): WorkItemRepo {
  return {
    insert(item) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO work_items (
          id, workspace_key, workspace_path, parent_id, stage, title, body, status,
          assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.workspaceIdentity,
        item.workspacePath,
        item.parentId ?? null,
        item.stage ?? null,
        item.title,
        item.body,
        item.status,
        item.assignee.type,
        item.assignee.id,
        JSON.stringify(item.labels),
        JSON.stringify(item.properties),
        item.position,
        item.archivedAt ?? null,
        now,
        now,
      );
    },

    // 归档行等同不存在：updateStatus / listChildren 都过滤 archived_at IS NULL，
    // get 若不过滤，调用方会读到一条随后永远无法流转的「活行」。
    get(id) {
      const row = db
        .prepare("SELECT * FROM work_items WHERE id = ? AND archived_at IS NULL")
        .get(id) as WorkItemRow | undefined;
      return row ? rowToWorkItem(row) : null;
    },

    listChildren(parentId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_items WHERE parent_id = ? AND archived_at IS NULL
          ORDER BY position ASC, created_at ASC, id ASC`,
        )
        .all(parentId) as unknown as WorkItemRow[];
      return rows.map(rowToWorkItem);
    },

    // 与 listChildren 同一条排序口径（position → created_at → id）：同一批项的呈现次序
    // 不随存储顺序漂移，否则 UI 每次刷新都可能换序，看起来像「有人在动数据」。
    listByWorkspace(workspaceKey) {
      const rows = db
        .prepare(
          `SELECT * FROM work_items WHERE workspace_key = ? AND archived_at IS NULL
          ORDER BY position ASC, created_at ASC, id ASC`,
        )
        .all(workspaceKey) as unknown as WorkItemRow[];
      return rows.map(rowToWorkItem);
    },

    // 按 (type, id) 两个字段一起过滤：只按 id 会把「同名的另一类指派」也捞进来
    // （例如某个智能体与某个小队恰好共用 id），转交就会改到不该改的项上。
    listByAssignee(type, id) {
      const rows = db
        .prepare(
          `SELECT * FROM work_items WHERE assignee_type = ? AND assignee_id = ? AND archived_at IS NULL
          ORDER BY position ASC, created_at ASC, id ASC`,
        )
        .all(type, id) as unknown as WorkItemRow[];
      return rows.map(rowToWorkItem);
    },

    // 单条条件更新并校验 changes：与 updateStatus 同一口径（先读后写会与并发派发竞态，
    // 也会把「这一行已经不存在了」伪装成一次成功的改写）。
    updateAssignee(id, assignee) {
      const result = db
        .prepare(
          "UPDATE work_items SET assignee_type=?, assignee_id=?, updated_at=? WHERE id=? AND archived_at IS NULL",
        )
        .run(assignee.type, assignee.id, Date.now(), id);
      return result.changes === 1;
    },

    // CAS 必须是单条条件更新并校验 changes：先读后写会与并发派发竞态。
    updateStatus(id, next, expect) {
      const result = db
        .prepare(
          "UPDATE work_items SET status=?, updated_at=? WHERE id=? AND status=? AND archived_at IS NULL",
        )
        .run(next, Date.now(), id, expect);
      return result.changes === 1;
    },

    // SQL 只取 status，终态判据留在内存的 category 判定里；把状态键名写进 SQL 会让
    // 新增/改名的状态静默漏判（cancelled 这类终态就不再被算作终态）。
    areAllChildrenTerminal(parentId) {
      const rows = db
        .prepare("SELECT status FROM work_items WHERE parent_id=? AND archived_at IS NULL")
        .all(parentId) as unknown as Array<{ status: string }>;
      if (rows.length === 0) return false;
      return rows.every((row) => isTerminalWorkItemStatus(row.status as WorkItemStatusKey));
    },
  };
}
