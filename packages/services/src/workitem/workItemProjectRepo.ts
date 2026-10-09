import type { ProjectStatusKey, WorkItemPriorityKey } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";

/* 工作项**项目**的存储面（`projects` 表 + `work_items` 的项目两列，迁移 0022；R-P1 切片 2）。
   本文件只 `import type node:sqlite`（无运行时 node 依赖，照 `workItemViewRepo` / `squadRunRepo` 的形态）。

   形态取自 multica（`server/migrations/034_projects.up.sql:2-14` + `035_project_priority.up.sql:1`
   + `166_project_dates.up.sql:8-10`，证据 `reports/2026-10-09-multica-issue-project-binding.md` A1）。
   本仓四条落点（逐条对应验收）：

   ① **workspace 隔离写进每条 SQL**：`workspace_key` 是 WHERE 的组成部分（不是读出来再比）——
      异己 workspace 的同 id 读不到、也改不动。第二份「先读再比 key」的判据会与 SQL 漂移，
      而漂移不报错（表现为跨 workspace 改到别人家的行）。
   ② **短码唯一由存储层兜底**：唯一索引 `idx_projects_short_code`；`insert` 撞冲突时把错误原样抛，
      由 `isProjectShortCodeConflict` 识别（模式匹配与 `offPeakTaskRepo` 的
      `isOffPeakBoundSessionConflict` 同款）——**不做先查后插**：并发下两次查都会看不到对方。
   ③ **挂接与置空只经本模块**：`work_items.project_id` / `identifier_prefix` 的写有两条路径
      （单条 `bindWorkItem`、删项目时 `remove` 的批量置空）；两者都在这里，服务面/其它 repo
      不得自己拼 `UPDATE work_items SET project_id=...`（第二份写者迟早漂移）。
   ④ **patch 是子集语义**：给了哪个字段才 SET 哪个；`null` 是合法值 = **清回未设置**
      （与「没给」的 `undefined` 不是同一件事）；空 patch 直接未命中（不执行空写）。
      `short_code` **不在 patch 面**：它是编号前缀来源，改它要么重写历史编号要么留陈旧前缀，
      v1 一律不改（登记在交付报告；要改 = 后续轮显式裁定 + 迁移）。

   刻意不进 `packages/services/src/index.ts`：repo 是服务面的内部零件（`workItemViewRepo` 同款），
   导出会让调用方绕过短码校验 / 归属校验直接写表。 */

export type WorkItemProjectRecord = {
  id: string;
  workspaceKey: string;
  name: string;
  /** 2-8 位大写字母数字（workspace 内唯一，编号前缀来源）；迁移 0022 的 CHECK 是最后一道闸。 */
  shortCode: string;
  /** 可空：NULL = 未填写（读回 undefined，「未设置」只有一种形态）。 */
  description?: string;
  icon?: string;
  status: ProjectStatusKey;
  /** 可空：NULL = 未设置；闭集与工作项优先级同源（shared `WORK_ITEM_PRIORITY_KEYS`）。 */
  priority?: WorkItemPriorityKey;
  /** 日历日 `YYYY-MM-DD`（无时刻无时区，与工作项同名两列同一形状）。 */
  startDate?: string;
  dueDate?: string;
  createdAt: number;
  updatedAt: number;
};

/** 新建一行（`status` 由调用方给全 —— 服务面在写之前把缺省折成 `planned`，见 shared 常量的理由）。 */
export type WorkItemProjectInsert = {
  id: string;
  workspaceKey: string;
  name: string;
  shortCode: string;
  description?: string;
  icon?: string;
  status: ProjectStatusKey;
  priority?: WorkItemPriorityKey;
  startDate?: string;
  dueDate?: string;
  createdAt: number;
  updatedAt: number;
};

/** 改写面（`shortCode` / `id` / `workspaceKey` 不在其中：前者是编号前缀来源，v1 不可改）。 */
export type WorkItemProjectPatch = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  status?: ProjectStatusKey;
  priority?: WorkItemPriorityKey | null;
  startDate?: string | null;
  dueDate?: string | null;
};

interface WorkItemProjectRow {
  id: string;
  workspace_key: string;
  name: string;
  short_code: string;
  description: string | null;
  icon: string | null;
  status: string;
  priority: string | null;
  start_date: string | null;
  due_date: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `id, workspace_key, name, short_code, description, icon, status, priority,
  start_date, due_date, created_at, updated_at`;

const PROJECT_PRIORITY_KEYS: readonly string[] = ["urgent", "high", "medium", "low"];

/**
 * 读回映射：可空列 NULL ⇒ `undefined`（不落默认值）；闭集外 `priority` **响亮抛** ——
 * 把无法解释的档位当 `undefined` 交出去，界面会把它显示成「未设置」（用户明明设过），
 * 且任何地方都不报错（与 `work_item_reactions.author_kind` 的读回纪律同款）。
 */
function rowToProject(row: WorkItemProjectRow): WorkItemProjectRecord {
  const record: WorkItemProjectRecord = {
    id: row.id,
    workspaceKey: row.workspace_key,
    name: row.name,
    shortCode: row.short_code,
    status: row.status as ProjectStatusKey,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.description !== null) record.description = row.description;
  if (row.icon !== null) record.icon = row.icon;
  if (row.priority !== null) {
    if (!PROJECT_PRIORITY_KEYS.includes(row.priority)) {
      throw new Error(
        `projects.priority 读回非法值「${row.priority}」（行 id=${row.id}）：一律抛。` +
          "闭集只有 urgent/high/medium/low（NULL = 未设置）；静默按未设置交出去会让用户设过的档位凭空消失。",
      );
    }
    record.priority = row.priority as WorkItemPriorityKey;
  }
  if (row.start_date !== null) record.startDate = row.start_date;
  if (row.due_date !== null) record.dueDate = row.due_date;
  return record;
}

/** `INSERT` 撞上 `idx_projects_short_code`（同 workspace 短码重复）—— 服务面据此给稳定错误码。 */
export function isProjectShortCodeConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: projects\.workspace_key, projects\.short_code/.test(error.message)
  );
}

export interface WorkItemProjectRepo {
  /** 写入一行并读回（撞短码唯一键时抛原生 UNIQUE 错误，调用方用 `isProjectShortCodeConflict` 识别）。 */
  insert(project: WorkItemProjectInsert): WorkItemProjectRecord;
  /** 单行读取（`null` = 本 workspace 没有这一行；异 workspace 的同 id 也落空 —— SQL 层租户守卫）。 */
  get(workspaceKey: string, id: string): WorkItemProjectRecord | null;
  /** 本 workspace 的全部项目（`created_at ASC, id ASC`：同刻行次序确定）。 */
  listByWorkspace(workspaceKey: string): WorkItemProjectRecord[];
  /** 子集 patch：命中 ⇒ 返回改写后的行；未命中（id 算错 / 空 patch / 异 workspace）⇒ `null`。 */
  update(input: {
    workspaceKey: string;
    id: string;
    patch: WorkItemProjectPatch;
    updatedAt: number;
  }): WorkItemProjectRecord | null;
  /**
   * **删项目 = 置空挂接 + 删行**（在**同一事务**内，次序固定：先置空、后删行）：
   * `UPDATE work_items SET project_id=NULL` 把本 workspace 内挂到该项目的行全部解绑
   * （`identifier_prefix` 快照**保留** —— 已签发的编号不因项目被删而重写，见迁移 0022 注释）；
   * 再 `DELETE FROM projects`。恰命中一行才算成功（`false` = 行不存在 / 异 workspace）。
   */
  remove(workspaceKey: string, id: string): boolean;
  /**
   * 单条工作项的项目挂接（bind 与 unbind 的唯一写入口；服务面 `setWorkItemProject` 与
   * `createWorkItem` / `updateWorkItem` 的 projectId 都经它）：
   * · `projectId` 与 `identifierPrefix` **同生共死**（挂 ⇒ 两者同写；清 ⇒ 两者同置 NULL）；
   * · 恰命中一行（`id` 存在、属本 workspace、**且未归档**）才算成功；
   *   未命中返回 `false`（调用方响亮抛，不静默 no-op —— 那会让界面以为改成功了）。
   */
  bindWorkItem(input: {
    workspaceKey: string;
    workItemId: string;
    projectId: string | null;
    identifierPrefix: string | null;
  }): boolean;
}

export function createWorkItemProjectRepo(db: DatabaseSync): WorkItemProjectRepo {
  const readOne = (workspaceKey: string, id: string): WorkItemProjectRecord | null => {
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ? AND workspace_key = ?`)
      .get(id, workspaceKey) as unknown as WorkItemProjectRow | undefined;
    return row ? rowToProject(row) : null;
  };

  return {
    insert(project) {
      db.prepare(
        `INSERT INTO projects (id, workspace_key, name, short_code, description, icon, status,
           priority, start_date, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        project.id,
        project.workspaceKey,
        project.name,
        project.shortCode,
        project.description ?? null,
        project.icon ?? null,
        project.status,
        project.priority ?? null,
        project.startDate ?? null,
        project.dueDate ?? null,
        project.createdAt,
        project.updatedAt,
      );
      // 读回证明「存的就是你给的」（不把入参原样回抛）。
      const created = readOne(project.workspaceKey, project.id);
      if (!created) {
        throw new Error(
          `项目写入成功后读回为空（id=${project.id}）：不可达态，须查库 —— ` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return created;
    },

    get: readOne,

    listByWorkspace(workspaceKey) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM projects WHERE workspace_key = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceKey) as unknown as WorkItemProjectRow[];
      return rows.map(rowToProject);
    },

    /* 逐字段拼 SET（不给的字段不写、不给的列写不进去）——与 `workItemRepo.updateContent` /
       `workItemViewRepo.update` 同款；空 patch 在拼之前返回 null。 */
    update(input) {
      const assignments: string[] = [];
      const values: Array<string | null> = [];
      const { patch } = input;
      if (patch.name !== undefined) {
        assignments.push("name=?");
        values.push(patch.name);
      }
      if (patch.description !== undefined) {
        assignments.push("description=?");
        values.push(patch.description);
      }
      if (patch.icon !== undefined) {
        assignments.push("icon=?");
        values.push(patch.icon);
      }
      if (patch.status !== undefined) {
        assignments.push("status=?");
        values.push(patch.status);
      }
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
      if (assignments.length === 0) return null;
      const result = db
        .prepare(
          `UPDATE projects SET ${assignments.join(", ")}, updated_at = ?
           WHERE id = ? AND workspace_key = ?`,
        )
        .run(...values, input.updatedAt, input.id, input.workspaceKey);
      return result.changes === 1 ? readOne(input.workspaceKey, input.id) : null;
    },

    /* 置空挂接 + 删行必须同事务：中间崩溃会留下「项目没了、挂接还指着它」的孤儿行
       （读侧按 project_id 反查会得到空，而工作项上仍带着一个不存在的项目 id）。
       事务边界在这里（repo 是这两条 SQL 的唯一所有者），不把 BEGIN/COMMIT 交给调用方。 */
    remove(workspaceKey, id) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE work_items SET project_id = NULL, updated_at = ? WHERE workspace_key = ? AND project_id = ?",
        ).run(Date.now(), workspaceKey, id);
        const result = db
          .prepare("DELETE FROM projects WHERE id = ? AND workspace_key = ?")
          .run(id, workspaceKey);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch (error) {
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } catch {
          /* 回滚也可能 IO 失败：不覆盖真正的原始异常。 */
        }
        throw error;
      }
    },

    bindWorkItem(input) {
      const result = db
        .prepare(
          `UPDATE work_items SET project_id = ?, identifier_prefix = ?, updated_at = ?
           WHERE id = ? AND workspace_key = ? AND archived_at IS NULL`,
        )
        .run(
          input.projectId,
          input.identifierPrefix,
          Date.now(),
          input.workItemId,
          input.workspaceKey,
        );
      return result.changes === 1;
    },
  };
}
