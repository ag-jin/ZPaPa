import type { DatabaseSync } from "node:sqlite";

/* 工作项**保存视图**的存储面（`work_item_views`，迁移 0020；R6a 切片 2）。
   本文件只 `import type node:sqlite`（无运行时 node 依赖，照 `squadRunRepo` 的形态）。

   形态取自 multica（`server/pkg/db/queries/issue_view.sql` + `265_issue_view.up.sql`，
   证据 reports/2026-10-09-saved-views-multica-evidence.md §1/§2），四条与 multica 同款的落点：

   ① **读权谓词写进 SQL**：`(owner_kind=? AND owner_id=?) OR visibility='workspace'` 外层再圈
      `workspace_key=?` —— 管理权（改/删只有 owner）不在这里，那是服务面的事；repo 只管
      「一条查询能读到哪些行」。谓词的括号写错时**别的 workspace 的共享视图会被读出来**且不报错，
      故它在用例里被指名钉住（变异：拆掉括号 ⇒ 用例红）。
   ② **列表硬上限 200 + 排序确定**（multica `LIMIT 200` + `ORDER BY created_at ASC`）：
      上限是滥用兜底（每行都带两个 JSON 文档），不是分页。排序补 `id ASC` 做同刻 tie-break ——
      只按 created_at 排，同刻行的次序随存储引擎变化，界面看起来像「有人在动数据」。
   ③ **revision 是 CAS**（multica `UpdateIssueView` 的 `WHERE … AND revision = $8` + `revision + 1`）：
      恰命中一行才算成功；未命中返回 `null`（调用方据此给 409 等价物）。空 patch **直接未命中**：
      一次不 SET 任何列的 UPDATE 没有语义（与 `workItemRepo.updateContent` 同一条纪律）。
   ④ **query/display 是不透明 JSON 文档**：repo **不解释** facet（解释权在客户端 `definition_version`
      契约），只做两件事 —— 写入序列化、读回校验「是 JSON object」。非对象形状（手改库/跨版本残留）
      **读回响亮抛**，不静默交出去（交出去界面会按「视图定义」渲染一份非定义的东西）。

   刻意不进 `packages/services/src/index.ts`：repo 是服务面的内部零件（workItemRepo 同款），
   导出会让调用方绕过权限与配额语义直接写表。 */

export const WORK_ITEM_VIEW_SCOPE_TYPES = ["workspace", "my"] as const;
export type WorkItemViewScopeType = (typeof WORK_ITEM_VIEW_SCOPE_TYPES)[number];

export const WORK_ITEM_VIEW_VISIBILITIES = ["private", "workspace"] as const;
export type WorkItemViewVisibility = (typeof WORK_ITEM_VIEW_VISIBILITIES)[number];

/** 列表硬上限（multica `issue_view.sql` 的 `LIMIT 200`：栏/面板不为超过这个量的行而建）。 */
export const WORK_ITEM_VIEW_LIST_LIMIT = 200;

/**
 * 视图的 owner（`owner_kind` / `owner_id` 两列）。`kind` 用协作文档的 actor 词汇
 * （`human | agent | system`）；本层不建闭集闸 —— 与 `inbox_items.kind` 同一条纪律：
 * 枚举漂移要在代码里响亮，不在 DDL / repo 里静默。owner 身份由组合根注入（见服务面）。
 */
export type WorkItemViewOwner = { kind: string; id: string };

export type WorkItemViewRecord = {
  id: string;
  workspaceKey: string;
  owner: WorkItemViewOwner;
  /** 1..80 个**字符**（码点；与 DDL 的 `length(name)` 同一把尺子）。 */
  name: string;
  scopeType: WorkItemViewScopeType;
  visibility: WorkItemViewVisibility;
  /** 客户端契约版本；服务端只存不解释（multica 同款，客户端恒写 1）。 */
  definitionVersion: number;
  /** 过滤定义（视图的共享身份）：不透明 JSON object。 */
  query: Record<string, unknown>;
  /** 显示定义（布局/分组/排序/列）：不透明 JSON object，只作「首次打开」的种子。 */
  display: Record<string, unknown>;
  /** 乐观并发版本：每次成功改写 +1（写路径 `WHERE revision = expected`）。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
  /**
   * **观察者归属**（T-P2-V §9-2 的修补）：这一行是不是**读它的那个人**建的。
   *
   * 只由**列表读面**（`listVisible`）按注入身份（`owner` 入参 = 组合根的 `localHumanActor`）
   * 现场算出 —— 不是一列、不进存储、`get` 的单行读不带它（那几处调用只落在「本人可管理」的
   * 路径上）。`undefined` = 这个读面没带回归属 ⇒ 消费方按「不可判定」处理（UI 的权限镜像据此
   * 分三态，不猜一个 owner 出来）。
   *
   * 为什么需要一个投影位：管理权（改/删）= owner，但**读权**允许别人共享的视图出现在列表里
   * —— 「看得见」与「改得动」的差别只有归属能表达；少了它，界面只能把所有行都渲染成可管理
   * （T-P2-V 实测：非 owner 的共享视图也渲染可点的编辑/删除，点击才 forbidden）。
   */
  ownedByViewer?: boolean;
};

/** 新建一行（`revision` 不入参：新行恒从 1 起，由 DDL 的 DEFAULT 给）。 */
export type WorkItemViewInsert = {
  id: string;
  workspaceKey: string;
  owner: WorkItemViewOwner;
  name: string;
  scopeType: WorkItemViewScopeType;
  visibility: WorkItemViewVisibility;
  definitionVersion: number;
  query: Record<string, unknown>;
  display: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** 定义式改写（未给的字段不动现值；`revision` / owner / scope 不在这里 —— 它们不是 patch 的面）。 */
export type WorkItemViewDefinitionPatch = {
  name?: string;
  visibility?: WorkItemViewVisibility;
  query?: Record<string, unknown>;
  display?: Record<string, unknown>;
};

interface WorkItemViewRow {
  id: string;
  workspace_key: string;
  owner_kind: string;
  owner_id: string;
  name: string;
  scope_type: string;
  scope_id: string | null;
  scope_variant: string | null;
  visibility: string;
  definition_version: number;
  query: string;
  display: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

/** 定义文档的读回校验（见文件头第 ④ 条）：非 JSON object 一律抛，消息带列名与行 id。 */
function parseDefinition(blob: string, column: "query" | "display", viewId: string): unknown {
  const parsed: unknown = JSON.parse(blob);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `工作项视图「${viewId}」的 ${column} 定义不是 JSON object（读到 ${JSON.stringify(parsed)}）：` +
        "视图定义必须是 JSON object（DDL 的 CHECK 是写入侧的那道闸，读回这一道管手改库/跨版本残留）——" +
        "静默把它交出去，界面会按「视图定义」渲染一份非定义的东西。",
    );
  }
  return parsed;
}

function rowToView(row: WorkItemViewRow): WorkItemViewRecord {
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    owner: { kind: row.owner_kind, id: row.owner_id },
    name: row.name,
    scopeType: row.scope_type as WorkItemViewScopeType,
    visibility: row.visibility as WorkItemViewVisibility,
    definitionVersion: row.definition_version,
    query: parseDefinition(row.query, "query", row.id) as Record<string, unknown>,
    display: parseDefinition(row.display, "display", row.id) as Record<string, unknown>,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, workspace_key, owner_kind, owner_id, name, scope_type, scope_id,
  scope_variant, visibility, definition_version, query, display, revision, created_at, updated_at`;

/** `scope_id` / `scope_variant` 两列恒空（v1 无轴与 project 档）：写路径不传、读路径不映射。 */
export interface WorkItemViewRepo {
  insert(view: WorkItemViewInsert): void;
  /** 单行读取（`null` = 本 workspace 没有这一行；异 workspace 的同 id 也落空 —— SQL 层租户守卫）。 */
  get(workspaceKey: string, id: string): WorkItemViewRecord | null;
  /**
   * 本 workspace 内**调用者有权读**的行：owner 本人（含私有）或 `visibility='workspace'` 的共享行。
   * 排序与上限见文件头第 ② 条。每行带**观察者归属** `ownedByViewer`（= 这一行是不是 `owner`
   * 参数本人建的；读权允许别人的共享行出现在这里，「看得见 ≠ 是我的」靠它表达）。
   */
  listVisible(workspaceKey: string, owner: WorkItemViewOwner): WorkItemViewRecord[];
  /** 每 owner 配额计数（multica `CountIssueViewsByOwner`；按 workspace + owner 两列）。 */
  countByOwner(workspaceKey: string, owner: WorkItemViewOwner): number;
  /** CAS 改写：命中 ⇒ 返回改写后的行；未命中（revision 不符 / 空 patch / 异 workspace）⇒ `null`。 */
  update(input: {
    workspaceKey: string;
    id: string;
    expectedRevision: number;
    patch: WorkItemViewDefinitionPatch;
    updatedAt: number;
  }): WorkItemViewRecord | null;
  /** 恰命中一行才算删除（静默 no-op 会让界面以为删掉了而列表里还在）。 */
  remove(workspaceKey: string, id: string): boolean;
}

export function createWorkItemViewRepo(db: DatabaseSync): WorkItemViewRepo {
  const readOne = (workspaceKey: string, id: string): WorkItemViewRecord | null => {
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM work_item_views WHERE id = ? AND workspace_key = ?`)
      .get(id, workspaceKey) as WorkItemViewRow | undefined;
    return row ? rowToView(row) : null;
  };

  return {
    insert(view) {
      db.prepare(
        `INSERT INTO work_item_views (id, workspace_key, owner_kind, owner_id, name, scope_type,
           scope_id, scope_variant, visibility, definition_version, query, display,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        view.id,
        view.workspaceKey,
        view.owner.kind,
        view.owner.id,
        view.name,
        view.scopeType,
        view.visibility,
        view.definitionVersion,
        JSON.stringify(view.query),
        JSON.stringify(view.display),
        view.createdAt,
        view.updatedAt,
      );
    },

    get: readOne,

    /* 读权谓词的**唯一**实现（文件头第 ① 条）：括号必须圈住整个 OR —— 少了它，
       `workspace_key = ? AND owner_kind = ? AND owner_id = ? OR visibility = 'workspace'`
       会把**别的 workspace** 的共享视图读出来（SQL 的 AND 比 OR 紧），且不报错。 */
    listVisible(workspaceKey, owner) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM work_item_views
           WHERE workspace_key = ?
             AND ((owner_kind = ? AND owner_id = ?) OR visibility = 'workspace')
           ORDER BY created_at ASC, id ASC
           LIMIT ${WORK_ITEM_VIEW_LIST_LIMIT}`,
        )
        .all(workspaceKey, owner.kind, owner.id) as unknown as WorkItemViewRow[];
      /* 归属按 **owner 两列**（kind + id）比：`agent:local-user` 与 `human:local-user` 不是同一个人
         （与读权谓词同一份口径 —— 两处若各写一份，某天会在某一处把 agent 读成「我的」）。 */
      return rows.map((row) => ({
        ...rowToView(row),
        ownedByViewer: row.owner_kind === owner.kind && row.owner_id === owner.id,
      }));
    },

    countByOwner(workspaceKey, owner) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM work_item_views
           WHERE workspace_key = ? AND owner_kind = ? AND owner_id = ?`,
        )
        .get(workspaceKey, owner.kind, owner.id) as { n: number };
      return row.n;
    },

    /* 逐字段拼 SET（不给的字段不写、不给的列写不进去）——与 `workItemRepo.updateContent` 同款；
       `revision = revision + 1` 与 CAS 的 `WHERE revision = ?` 一起构成乐观并发（文件头第 ③ 条）。 */
    update(input) {
      const assignments: string[] = [];
      const values: Array<string | null> = [];
      const { patch } = input;
      if (patch.name !== undefined) {
        assignments.push("name=?");
        values.push(patch.name);
      }
      if (patch.visibility !== undefined) {
        assignments.push("visibility=?");
        values.push(patch.visibility);
      }
      if (patch.query !== undefined) {
        assignments.push("query=?");
        values.push(JSON.stringify(patch.query));
      }
      if (patch.display !== undefined) {
        assignments.push("display=?");
        values.push(JSON.stringify(patch.display));
      }
      // 空 patch：不执行「不 SET 任何列」的空写，直接未命中（响亮错误留给调用方）。
      if (assignments.length === 0) return null;
      const result = db
        .prepare(
          `UPDATE work_item_views
             SET ${assignments.join(", ")}, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_key = ? AND revision = ?`,
        )
        .run(...values, input.updatedAt, input.id, input.workspaceKey, input.expectedRevision);
      return result.changes === 1 ? readOne(input.workspaceKey, input.id) : null;
    },

    remove(workspaceKey, id) {
      const result = db
        .prepare("DELETE FROM work_item_views WHERE id = ? AND workspace_key = ?")
        .run(id, workspaceKey);
      return result.changes === 1;
    },
  };
}
