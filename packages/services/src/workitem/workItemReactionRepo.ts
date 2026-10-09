import type { DatabaseSync } from "node:sqlite";
import type { AuthorRef } from "./workItemCommentRepo.js";

/* 工作项级**表情回应**的存储面（`work_item_reactions`，迁移 0021；P3-R5s 切片 2）。
   本文件只 `import type node:sqlite`（无运行时 node 依赖，照 `workItemCommentReactionRepo` 的形态）。

   形态取自 multica `issue_reaction.sql` 的三条 SQL（`AddIssueReaction` / `RemoveIssueReaction` /
   `ListIssueReactions`，证据 reports/2026-10-09-reactions-multica-evidence.md §1/§2），
   与 ZPaPa 0010 的评论 reactions **同构**：回应是轻实体，一行只是「谁、在哪个工作项上、留了哪个 emoji」。

   四条纪律（逐条对应验收）：
   ① **写路径幂等由存储层兜底**：`INSERT OR IGNORE`（唯一键 = 迁移 0021 的五元组）+
      **`run().changes` 判真插入** —— 「命中冲突 = 无变化」是**显式契约**：调用方拿到
      `inserted:false` 就知道这次没有新事实（multica 的 handler 只在 `IssueRevision > 0` 时广播，
      同一格）。刻意**不用先查后插**：那在并发下两条都「查不到」，第二条撞唯一键会**响亮失败**，
      幂等就此塌掉；`INSERT OR IGNORE` 是原子的。
   ② **删除不存在 = 无变化、不报错**（`removed:false`；multica 的 `changed=false` + `204` 同格）：
      连点撤销、重投取消都不是错误——报错只会让界面把「本来就没反应」显示成「取消失败」。
   ③ **读 = 插入序**（`ORDER BY created_at ASC, id ASC`）：聚合取「先出现的 emoji 排在前面」
      （multica `ListIssueReactions` 同款），不按热度重排、也不按 id 整表重排 —— 后者的表现是
      界面次序随存储引擎/并发写入次序抖动，看起来像「有人在动数据」。同刻行用 `id ASC` 做
      tie-break（插入序在同刻下不可判定，选一条**确定**的规则，不留给引擎）。
   ④ **存储不白名单**：emoji 就是非空字符串（自定义 token / 超长串原样存取），DDL 里唯一的约束是
      迁移 0021 的 `CHECK (length(emoji) > 0)` —— 白名单在 UI 层（快捷表情集是**呈现**），
      写进 DDL 会让「放开完整 emoji picker」变成一次数据迁移。长度护栏在服务面（宽松上限）。
      **这条 CHECK 不是写路径的闸**：正常路径的空串/超长由服务面 `assertEmoji` 在写之前拒
      （零落盘）；而 `INSERT OR IGNORE` **连 CHECK 违规也一起吞**（`changes=0` 静默跳过，不抛
      `CHECK constraint failed`），绕过服务面直插 repo 的空串，由随后按五元组回读为空**响亮抛**兜底
      （真实机制钉在 repo 用例里）。

   主体（`author`）复用协作文档的 `AuthorRef`（`human | agent | system`）：读回非法值**响亮抛**
   ——聚合的第一格判据就是 `author_kind`（`reactedByMe` 必须带 kind 判断），一个无法解释的 kind
   若被静默交出去，界面会把 agent 的同 emoji 误标成「我」（或反之），且任何地方都不报错。

   刻意不进 `packages/services/src/index.ts`：repo 是服务面的内部零件（`workItemRepo` 同款），
   导出会让调用方绕过服务面的 emoji 护栏与工作项归属校验直接写表。 */

export type WorkItemReactionRecord = {
  id: string;
  workspaceKey: string;
  workItemId: string;
  /** 回应主体（kind + id；不存展示名快照 —— 与 0010 同款，名字由 UI 从名册解析）。 */
  author: AuthorRef;
  emoji: string;
  createdAt: number;
};

/** `add` 的结论：`inserted:false` = 命中五元组冲突 ⇒ **无变化**（既存/新行在 `record` 里，二者同形）。 */
export type AddWorkItemReactionResult = {
  inserted: boolean;
  record: WorkItemReactionRecord;
};

export interface WorkItemReactionRepo {
  /** 幂等添加（唯一键 + `INSERT OR IGNORE`）：重投不产生第二行，返回既存行且不重写时间戳。 */
  add(input: {
    id: string;
    workspaceKey: string;
    workItemId: string;
    author: AuthorRef;
    emoji: string;
    createdAt: number;
  }): AddWorkItemReactionResult;
  /** 幂等删除：不存在 ⇒ `false`（无变化、不报错）；恰命中一行 ⇒ `true`。 */
  remove(input: {
    workspaceKey: string;
    workItemId: string;
    author: AuthorRef;
    emoji: string;
  }): boolean;
  /** 本工作项的全部回应行，**插入序**（`created_at ASC, id ASC`）。 */
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemReactionRecord[];
}

interface WorkItemReactionRow {
  id: string;
  workspace_key: string;
  work_item_id: string;
  author_kind: string;
  author_id: string;
  emoji: string;
  created_at: number;
}

const SELECT_COLUMNS = "id, workspace_key, work_item_id, author_kind, author_id, emoji, created_at";

/** 读回映射（见文件头末段：非法 `author_kind` 一律抛，消息带行 id 与原文）。 */
function rowToReaction(row: WorkItemReactionRow): WorkItemReactionRecord {
  if (!["human", "agent", "system"].includes(row.author_kind)) {
    throw new Error(
      `work_item_reactions.author_kind 读回非法值「${row.author_kind}」（行 id=${row.id}）：一律抛。` +
        "聚合的第一格判据就是 author_kind（reactedByMe 必须带 kind 判断），静默交出去会把" +
        "agent 的同 emoji 误标成「我」或反之，且任何地方都不报错。",
    );
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workItemId: row.work_item_id,
    author: { kind: row.author_kind as AuthorRef["kind"], id: row.author_id },
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

export function createWorkItemReactionRepo(db: DatabaseSync): WorkItemReactionRepo {
  /* 五元组读取的**唯一**实现：`add` 的回读与「既存行」判定都用它 —— 入参回抛会把「库里到底
     落了什么」与「调用方给了什么」混为一谈（读回证明「存的就是你给的」，照 repo 既有口径）。 */
  const readOne = (input: {
    workspaceKey: string;
    workItemId: string;
    author: AuthorRef;
    emoji: string;
  }): WorkItemReactionRecord => {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM work_item_reactions
          WHERE workspace_key = ? AND work_item_id = ? AND author_kind = ? AND author_id = ? AND emoji = ?`,
      )
      .get(
        input.workspaceKey,
        input.workItemId,
        input.author.kind,
        input.author.id,
        input.emoji,
      ) as unknown as WorkItemReactionRow | undefined;
    if (!row) {
      /* 兜底闸：`INSERT OR IGNORE` 之后该五元组本该有一行（刚插入的，或冲突命中的既存行）。
         已知的可达路径只有一条——**空 emoji**（见 `add`：IGNORE 连 CHECK 违规一起吞，changes=0），
         本抛即直插 repo 时的响亮兜底；常规写路径不可达（服务面 `assertEmoji` 在写之前就拒，
         消息里的「不可达态」按此口径）。 */
      throw new Error(
        `work_item_reactions 读回为空（workspace=${input.workspaceKey}, workItem=${input.workItemId}, ` +
          `author=${input.author.kind}:${input.author.id}, emoji=「${input.emoji}」）：不可达态，须查库。`,
      );
    }
    return rowToReaction(row);
  };

  return {
    add(input) {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO work_item_reactions (
             id, workspace_key, work_item_id, author_kind, author_id, emoji, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspaceKey,
          input.workItemId,
          input.author.kind,
          input.author.id,
          input.emoji,
          input.createdAt,
        );
      /* `changes===1` 才是真插入；命中唯一键冲突时 `INSERT OR IGNORE` 静默跳过（changes=0）——
         两种情形都回读同一行，差别只在 `inserted`（显式契约，见文件头第 ① 条）。
         空 emoji 不在这里拦：`INSERT OR IGNORE` **连 CHECK 违规也一起忽略**（changes=0，静默跳过、
         不抛 CHECK），随后回读找不到行 ⇒ 由 `readOne` 的「读回为空」响亮抛兜底（用例钉住）。
         正常写路径的空串闸在服务面 `assertEmoji`（写之前拒，零落盘，见文件头第 ④ 条）。 */
      return { inserted: result.changes === 1, record: readOne(input) };
    },

    remove(input) {
      const result = db
        .prepare(
          `DELETE FROM work_item_reactions
            WHERE workspace_key = ? AND work_item_id = ? AND author_kind = ? AND author_id = ? AND emoji = ?`,
        )
        .run(input.workspaceKey, input.workItemId, input.author.kind, input.author.id, input.emoji);
      return result.changes === 1;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM work_item_reactions
            WHERE workspace_key = ? AND work_item_id = ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceKey, workItemId) as unknown as WorkItemReactionRow[];
      return rows.map(rowToReaction);
    },
  };
}
