import {
  isTerminalWorkItemStatus,
  type WorkItem,
  type WorkItemCreator,
  type WorkItemPriorityKey,
  type WorkItemStatusKey,
} from "@zcode/shared";
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
  /* 0018（Surface 对齐）追加的 7 列：优先级 / 起始-截止（日历日期文本）/ 创建人三列 /
     每 workspace 序号。前六列可空 = 未设置 / 迁移前未知（不编造值）。 */
  priority: string | null;
  start_date: string | null;
  due_date: string | null;
  creator_kind: string | null;
  creator_id: string | null;
  creator_display_name: string | null;
  identifier_seq: number | null;
  /* 0022（项目绑定）追加的两列：project_id 可空（「无项目」是显式合法状态）；
     identifier_prefix 是短码**快照**（编号 = 前缀-序号；NULL = 无前缀，显示回落 `#N`）。 */
  project_id: string | null;
  identifier_prefix: string | null;
}

export interface WorkItemRepo {
  /**
   * 写入一行，返回语句内生成的 `identifier_seq`。
   * 调用方必须已校验环与深度（WORK_ITEM_MAX_DEPTH / 祖父链），本层不查父链。
   *
   * 序号生成写在 INSERT 语句本身（`COALESCE((SELECT MAX(identifier_seq) …), 0) + 1`，
   * 与 0011 Activity 序号同款）：多窗口 Host 共用同一 tasks-index 库文件，JS 先查后插 /
   * 内存 counter 在跨连接并发下会重号 —— 而重号被唯一索引拒绝时，调用方那次创建已经失败。
   */
  insert(item: WorkItem): number;
  get(id: string): WorkItem | null;
  /**
   * 含归档读回（协作域 §12.1-12：归档工作项仍允许评论写入，但派发必须被拒并**如实上报**）。
   * `get` 把归档行当不存在，调用方拿不到「归档」与「不存在」的区别，也读不到归档行的 assignee——
   * 于是「评论照写 + blocked receipt」里那个被拒的目标就无从谈起。此法只读，不改归档语义。
   * 旧库/归档行仍是同一张表，无迁移。
   */
  getIncludingArchived(id: string): WorkItem | null;
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
  /**
   * 改写工作项**内容**（title / body / labels）—— 不含 `status`（唯一写者是 `WorkItemService` 的
   * `transition`）与 `assignee`（另有 `updateAssignee`）。CAS 式：`id` 存在、未归档、
   * **且给了至少一个字段**才写；恰命中一行返回 `true`。
   *
   * 为什么与 `updateAssignee` 同款「条件更新 + 恰命中一行才算成功」：先读后写会与并发
   * 派发竞态，也会把「这一行已经不存在了」伪装成一次成功的改写 —— 未命中必须返回 `false`
   * 而不是静默 no-op，否则调用方以为「改成功了」而库里仍是旧标题。
   *
   * 为什么空 patch（三个字段都 `undefined`）**直接返回 false**：一次不 SET 任何列的
   * `UPDATE` 没有语义（等于「改了什么？什么都没改」），若放行则调用方传空 patch 会得到
   * 「成功」，把接线错误静默成一次空写。返回 `false` 让空 patch 落到调用方的响亮错误路径。
   * 注意 `labels: []` **不是**空 patch：它是「清空标签」这个合法动作（给了字段就 SET）。
   *
   * SET 子句**逐字段拼接**（patch 里出现哪个字段才 SET 哪个），不做整包展开：运行期多带的
   * 键必须被忽略 —— 否则 `patch` 上恰好同名于别的列（`status` / `archived_at`）的键就能
   * 绕开白名单写到不该写的列上。
   *
   * `labels` 入参是**已归一化**的字符串数组（判据单源 = shared 的 `parseWorkItemLabels`，
   * 由调用方在写之前过闸）：本层不再做第二份去重 / 截断 —— 存储格式照旧是 JSON 文本。
   *
   * 0018 扩到 6 个字段：`priority` / `startDate` / `dueDate` 是**内容型**（与 title/body/labels 同列
   * 白名单）；`null` 是合法值 = **清回未设置**（与 `labels: []` 同款：给了字段就 SET）。`creator_*`
   * 与 `identifier_seq` **不在**白名单里：它们没有更新面（创建人与创建序号是既成事实，不可改）。
   *
   * R6 再加**第 7 个**字段 `position`（看板拖拽改序的服务面半边）：它是 `REAL` 列，数值**原样**
   * 落库 —— 不做整数化（整数化会把「A 与 B 之间」的插入点压成并列，拖拽后的次序不再是用户看到的
   * 次序），也不在这里编排序判据（`manual` 的次序判据是 `ORDER BY position ASC`，三条 list 语句自有）。
   * 注意该列建表时是 `REAL NOT NULL DEFAULT 0`（schema-v1.ts）—— **没有**「写 NULL 清位」这一态；
   * 未给字段（`undefined`）仍是不动现值（patch 子集语义）。
   */
  updateContent(
    id: string,
    patch: {
      title?: string;
      body?: string;
      labels?: string[];
      priority?: WorkItemPriorityKey | null;
      startDate?: string | null;
      dueDate?: string | null;
      position?: number;
    },
  ): boolean;
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
    /* 读回纪律：NULL ⇒ `undefined`（未设置 / 迁移前未知），**不猜**、不落默认值 ——
       `priority: null` 与「显式选了某一档」不是同一态，编一个默认档位就是替用户做决定。 */
    priority: row.priority === null ? undefined : (row.priority as WorkItemPriorityKey),
    startDate: row.start_date ?? undefined,
    dueDate: row.due_date ?? undefined,
    /* 创建人三列是一件事：kind + id 齐备才算有创建人（写入口两者同写；只有一半的行不可达，
       真出现时按「未知」读回，不返回半截对象）。 */
    creator: readCreator(row),
    identifierSeq: row.identifier_seq ?? undefined,
    /* 0022：项目绑定的两列同一条读回纪律（NULL ⇒ undefined，不猜、不落默认值）——
       「无项目」与「项目是空字符串」不是同一态，前缀快照 NULL 时编号显示回落 `#N`。 */
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.identifier_prefix !== null ? { identifierPrefix: row.identifier_prefix } : {}),
  };
}

function readCreator(row: WorkItemRow): WorkItemCreator | undefined {
  if (row.creator_kind === null || row.creator_id === null) return undefined;
  const creator: WorkItemCreator = {
    kind: row.creator_kind as WorkItemCreator["kind"],
    id: row.creator_id,
  };
  // 空串不落列（写入口给 null）：显示名缺失 = 没有这个名字，不是「名字是空字符串」。
  if (row.creator_display_name !== null) creator.displayName = row.creator_display_name;
  return creator;
}

export function createWorkItemRepo(db: DatabaseSync): WorkItemRepo {
  return {
    insert(item) {
      const now = Date.now();
      /* 列集与 16 列版逐字一致（既有列的写入口径不变），只是追加 0018 的 7 列与 0022 的 2 列；
         `identifier_seq` 由 SELECT 里的 `COALESCE(MAX…)+1` **语句内**生成，`RETURNING`
         把刚生成的号在**同一语句**里交回（没有「写入与读回之间」的窗口）——
         参数列表里没有它，调用方结构上无法传号（见接口注释）。
         项目两列（0022）由调用方给（服务面已校验项目属本 workspace）：
         `identifier_prefix` 是绑定时刻的短码快照，不是读时从项目表现算的派生值。 */
      const row = db
        .prepare(
          `INSERT INTO work_items (
          id, workspace_key, workspace_path, parent_id, stage, title, body, status,
          assignee_type, assignee_id, labels, properties, position, archived_at,
          priority, start_date, due_date, creator_kind, creator_id, creator_display_name,
          identifier_seq, project_id, identifier_prefix, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT MAX(identifier_seq) FROM work_items WHERE workspace_key = ?), 0) + 1,
          ?, ?, ?, ?
        RETURNING identifier_seq`,
        )
        .get(
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
          item.priority ?? null,
          item.startDate ?? null,
          item.dueDate ?? null,
          item.creator?.kind ?? null,
          item.creator?.id ?? null,
          item.creator?.displayName ?? null,
          // MAX+1 的作用域参数：workspace_key（序号是每 workspace 的）。
          item.workspaceIdentity,
          item.projectId ?? null,
          item.identifierPrefix ?? null,
          now,
          now,
        ) as { identifier_seq: number } | undefined;
      if (!row) {
        throw new Error(
          `工作项插入未回传 identifier_seq（id=${item.id}）：不可达态，须查库 —— ` +
            "不返回一个猜出来的号（猜出来的号会与库里的真实号分叉）。",
        );
      }
      return row.identifier_seq;
    },

    // 归档行等同不存在：updateStatus / listChildren 都过滤 archived_at IS NULL，
    // get 若不过滤，调用方会读到一条随后永远无法流转的「活行」。
    get(id) {
      const row = db
        .prepare("SELECT * FROM work_items WHERE id = ? AND archived_at IS NULL")
        .get(id) as WorkItemRow | undefined;
      return row ? rowToWorkItem(row) : null;
    },

    getIncludingArchived(id) {
      const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
        | WorkItemRow
        | undefined;
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

    // 与 updateAssignee 同口径的单条条件更新（未命中 = 已归档或 id 算错 ⇒ false）。
    // SET 子句逐字段拼接：patch 里出现哪个字段才 SET 哪个（空 patch 在拼之前就返回 false，
    // 不发「不 SET 任何列」的 UPDATE）；运行期多带的键不参与拼接，故写不到白名单之外的列。
    updateContent(id, patch) {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.title !== undefined) {
        assignments.push("title=?");
        values.push(patch.title);
      }
      if (patch.body !== undefined) {
        assignments.push("body=?");
        values.push(patch.body);
      }
      // labels 是 JSON 文本列：序列化在写入口本来就做（insert 同款），本层不做归一化
      // （规则单源 = shared 的 parseWorkItemLabels，调用方已过闸）；`[]` 是合法值（清空标签）。
      if (patch.labels !== undefined) {
        assignments.push("labels=?");
        values.push(JSON.stringify(patch.labels));
      }
      /* 0018 的三个内容型新字段：`null` 是合法值 = **清回未设置**（给了字段就 SET，不是空 patch）。
         判据（闭集 / 日历日期）在写入口过闸，本层不做第二份校验（同 labels 的纪律）。 */
      if (patch.priority !== undefined) {
        assignments.push("priority=?");
        values.push(patch.priority);
      }
      if (patch.startDate !== undefined) {
        assignments.push("start_date=?");
        values.push(patch.startDate);
      }
      if (patch.dueDate !== undefined) {
        assignments.push("due_date=?");
        values.push(patch.dueDate);
      }
      /* R6：position（REAL）原样进 SET —— 只做「给了就 SET」，不做整数化 / 不编默认序。
         列是 `REAL NOT NULL DEFAULT 0`：数值直接落库（含小数与负数），没有「写 NULL 清位」这条路径。 */
      if (patch.position !== undefined) {
        assignments.push("position=?");
        values.push(patch.position);
      }
      // 空 patch：没有任何要写的列 ⇒ 不执行空 UPDATE，直接未命中（响亮错误留给调用方）。
      if (assignments.length === 0) return false;
      const result = db
        .prepare(
          `UPDATE work_items SET ${assignments.join(", ")}, updated_at=? WHERE id=? AND archived_at IS NULL`,
        )
        .run(...values, Date.now(), id);
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
