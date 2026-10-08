import type { DatabaseSync } from "node:sqlite";
import type { WorkItemViewOwner } from "./workItemViewRepo.js";

/* 工作项**视图条偏好**的存储面（`work_item_view_prefs`，迁移 0020；R6a 切片 4）。
   本文件只 `import type`（无运行时 node 依赖）。

   形态照 multica（`268_issue_view_preference.up.sql` + `issue_view_preference.go:80-155`）：
   一行 = 一个 owner 在一个 workspace 的**整份**偏好文档，客户端自有、服务端只认「JSON object」。
   三条纪律：

   ① **整文档 upsert、last-write-wins、无 revision**：偏好是「我自己怎么看这一栏」，
     不是共享事实（要 fencing 的是视图定义，那是 `work_item_views.revision` 的事）。
     多端同时写 ⇒ 后写者赢 —— mergo 式合并反而会把用户明确删掉的键复活（见用例）。
   ② **无行不是错误**：repo 层如实返回 `null`（「这里没有这行」），服务面把它折成空文档 `{}`
     （multica 的 no-rows 分支就给 `{}`；`{}` 与「文档里恰好没有 hidden/order」在存储上是同一件事）。
   ③ **读回校验顶层形状**：非 JSON object（手改库/跨版本残留）读回**响亮抛** —— 与视图的
     query/display 同一条纪律：交出去会让界面按「偏好文档」渲染一份非文档的东西。 */

export interface WorkItemViewPrefsRepo {
  /** `null` = 没有这行（不是空文档 —— 折成 `{}` 是服务面的决定，repo 不替它猜）。 */
  get(workspaceKey: string, owner: WorkItemViewOwner): Record<string, unknown> | null;
  /** 整文档覆盖写（`INSERT … ON CONFLICT DO UPDATE`：一条语句同时表达插入与替换，不先查后插）。 */
  put(input: {
    workspaceKey: string;
    owner: WorkItemViewOwner;
    prefs: Record<string, unknown>;
    updatedAt: number;
  }): Record<string, unknown>;
}

function parsePrefs(blob: string, workspaceKey: string, owner: WorkItemViewOwner): unknown {
  const parsed: unknown = JSON.parse(blob);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `视图条偏好（workspace「${workspaceKey}」，owner「${owner.kind}:${owner.id}」）不是 JSON object` +
        `（读到 ${JSON.stringify(parsed)}）：DDL 的 CHECK 是写入侧那道闸，读回这一道管手改库/跨版本残留。`,
    );
  }
  return parsed;
}

export function createWorkItemViewPrefsRepo(db: DatabaseSync): WorkItemViewPrefsRepo {
  /** 单行读取（`null` = 没有这行）：`put` 的读回与 `get` 共用这一份，避免两处各写一条 SQL。 */
  const readPrefs = (
    workspaceKey: string,
    owner: WorkItemViewOwner,
  ): Record<string, unknown> | null => {
    const row = db
      .prepare(
        `SELECT prefs FROM work_item_view_prefs
         WHERE workspace_key = ? AND owner_kind = ? AND owner_id = ?`,
      )
      .get(workspaceKey, owner.kind, owner.id) as { prefs: string } | undefined;
    if (!row) return null;
    return parsePrefs(row.prefs, workspaceKey, owner) as Record<string, unknown>;
  };

  return {
    get: readPrefs,

    put(input) {
      db.prepare(
        `INSERT INTO work_item_view_prefs (workspace_key, owner_kind, owner_id, prefs, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_key, owner_kind, owner_id)
         DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
      ).run(
        input.workspaceKey,
        input.owner.kind,
        input.owner.id,
        JSON.stringify(input.prefs),
        input.updatedAt,
      );
      // 读回写盘后的文档（同一语句刚命中过，理论不可达时抛 —— 不返回输入值冒充落盘结果）。
      const stored = readPrefs(input.workspaceKey, input.owner);
      if (!stored) {
        throw new Error(
          `视图条偏好写入后读回为空（workspace「${input.workspaceKey}」，` +
            `owner「${input.owner.kind}:${input.owner.id}」）：不可达态，须查库 —— ` +
            "不返回输入值冒充落盘结果（那会让「写了没落」变成谁都看不见）。",
        );
      }
      return stored;
    },
  };
}
