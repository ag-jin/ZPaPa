import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ASSIGNMENT_SUBSCRIBER_REASONS,
  MANUAL_SUBSCRIBER_REASON,
  OPT_OUT_SCOPES,
  SUBSCRIBER_REASONS,
  SUBSCRIBER_SUBJECT_TYPES,
  type OptOutScope,
  type SubscriberReason,
  type SubscriberSubjectType,
} from "./subscriberFacts.js";

/* 订阅表仓库：`work_item_subscribers` 的**唯一**读写处（SUB.1 存储面）。

   三条存储层不变式（不靠调用方的「先查后插」——跨连接并发下两次查都可能看不到对方）：
   ① **唯一键** `(workspace_key, work_item_id, subject_type, subject_id)`：一行 = 一个
      「（工作项, 主体）的当前关系」，故 upsert 走 `INSERT ... ON CONFLICT DO UPDATE`
      （一条语句同时表达插入与改写，且与键冲突的插入不可能写出第二行）；
   ② **tombstone 是自动规则的禁区**：活动 upsert 的 `DO UPDATE` 带
      `WHERE tombstoned_at IS NULL AND reason <> 'manual'` —— 用户说过「不想收」之后，
      任何自动事实都**不可能**复活这行（判据在语句里，缺了它 UI 上的「已退订」会被无声推翻）；
   ③ **自动撤销 = 删行**，且只删「活动 + 非 manual + 负责人关系两格」的行。

   三个枚举列（reason / subject_type / opt_out_scope）**读写双闸**：写路径拒绝闭集外的值
   （绝不落盘），读回对枚举外值**响亮抛**（照 inboxItemRepo / squadRunRepo 的既有裁定：
   手改库或跨版本残留造出的值若被静默按默认处理，「这行为什么在」就没人说得清）。

   刻意不进 `packages/services/src/index.ts` 的**值**导出：本模块值导入 `node:crypto`（id 生成），
   而根入口被 renderer 直接解析（browserSafeRootEntry.test.ts 守这条）。类型走根入口无碍。 */

/** 一行的业务键（唯一键的四个列）。 */
export type WorkItemSubscriberKey = {
  workspaceKey: string;
  workItemId: string;
  subjectType: SubscriberSubjectType;
  subjectId: string;
};

export type WorkItemSubscriberRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  subjectType: SubscriberSubjectType;
  subjectId: string;
  /** 「为什么我在这里」的当前解释（最近事实胜）。 */
  reason: SubscriberReason;
  /** 只在 tombstone 行上有语义（活动行恒 `issue`）。 */
  optOutScope: OptOutScope;
  /** 非空 = **显式退订**（用户意愿，可审计）；自动规则不得复活、不得改写。 */
  tombstonedAt: number | null;
  createdAt: number;
};

/** 活动行 upsert 入参（`id` / `createdAt` 缺省由 repo 生成，测试可钉死）。 */
export type WorkItemSubscriberUpsert = {
  id?: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  subjectType: SubscriberSubjectType;
  subjectId: string;
  reason: SubscriberReason;
  createdAt?: number;
};

/** 退订（tombstone）upsert 入参。 */
export type WorkItemSubscriberTombstoneUpsert = Omit<WorkItemSubscriberUpsert, "reason"> & {
  scope: OptOutScope;
};

export interface WorkItemSubscriberRepo {
  /** 单行读取（`null` = 没有这条关系，不是错误）。 */
  get(key: WorkItemSubscriberKey): WorkItemSubscriberRecord | null;
  /**
   * 本工作项的**全部**订阅行（含 tombstone 行 —— 「已退订」是可观察状态）。
   * 固定排序 `created_at ASC, id ASC`：呈现次序不随存储顺序漂移。
   */
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemSubscriberRecord[];
  /**
   * 一个**主体**在**本 workspace** 的全部订阅行（跨工作项）—— SUB.2 的收件人解析与
   * 「我关注了哪些项」都取这一口。排序同 `listByWorkItem`。
   */
  listBySubject(
    workspaceKey: string,
    subjectType: SubscriberSubjectType,
    subjectId: string,
  ): WorkItemSubscriberRecord[];
  /**
   * 活动行 upsert（**最近事实胜**）：不存在 ⇒ 插入（`opt_out_scope='issue'`、无墓碑）；
   * 已存在活动自动行 ⇒ 只改 `reason`（**不动 `created_at`**：关系从第一次建立算起）；
   * 已 tombstone 或 `reason='manual'` ⇒ 整条语句 no-op（返回 `false`）。
   *
   * 返回 `true` = 本语句真的改了行（新插或改 reason）。同事实重投返回 `false`：幂等由唯一键与
   * 语句内的 `reason <> excluded.reason` 判据共同兜住，调用方**不得**把它当错误。
   */
  upsertActive(input: WorkItemSubscriberUpsert): boolean;
  /**
   * **显式退订**（tombstone upsert）：不存在 ⇒ 建 tombstone 行（`reason` 归 `manual` ——
   * 凭空出现的行只有用户自己这个来源）；已存在 ⇒ 更新 `opt_out_scope`，而 `tombstoned_at`
   * 取 `COALESCE(既有, 新值)`（首次退订时刻不被后来的调用改写）。
   */
  upsertTombstone(input: WorkItemSubscriberTombstoneUpsert): void;
  /**
   * **显式复活**（只有用户手动订阅能作到）：清 `tombstoned_at`、`reason` 归 `manual`、
   * `opt_out_scope` 回 `issue`（活动行恒 issue）。
   * 未命中该键 ⇒ **响亮抛**（静默 no-op 会让界面以为订阅成功了）。
   */
  clearTombstone(key: WorkItemSubscriberKey): void;
  /**
   * **自动撤销**（删行）：只删「活动 + 非 `manual` + 负责人关系两格」的行——这正是「改派后旧负责人
   * 行删除」的实现。返回是否真的删了一行；未命中不抛（撤销是对**事实变化**的响应，
   * 行已被撤销或本就不是负责人关系都是正常结局）。
   */
  revokeAssignment(key: WorkItemSubscriberKey): boolean;
}

interface WorkItemSubscriberRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  opt_out_scope: string;
  tombstoned_at: number | null;
  created_at: number;
}

/* 读回枚举列的契约违例断言（表.列 + 实际值都点名）：静默按默认值处理会让「这行为什么在」
   变成没人知道的事，且不报错 —— 照 inboxItemRepo.readKind 的既有口径。 */
function readReason(value: string): SubscriberReason {
  if (!(SUBSCRIBER_REASONS as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_subscribers.reason 读回非法值「${value}」：列被写坏或闭集被改小。` +
        "静默按默认值处理会让「这条订阅为什么在」变成没人知道的事，故一律抛。",
    );
  }
  return value as SubscriberReason;
}

function readSubjectType(value: string): SubscriberSubjectType {
  if (!(SUBSCRIBER_SUBJECT_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_subscribers.subject_type 读回非法值「${value}」：列被写坏或闭集被改小。` +
        "主体类型决定「通知谁」，静默按默认值处理会通知错对象，故一律抛。",
    );
  }
  return value as SubscriberSubjectType;
}

function readOptOutScope(value: string): OptOutScope {
  if (!(OPT_OUT_SCOPES as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_subscribers.opt_out_scope 读回非法值「${value}」：列被写坏或闭集被改小。` +
        "静默按默认值处理会把「此条及子项都静音」读成「只静音此条」，故一律抛。",
    );
  }
  return value as OptOutScope;
}

function rowToRecord(row: WorkItemSubscriberRow): WorkItemSubscriberRecord {
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    subjectType: readSubjectType(row.subject_type),
    subjectId: row.subject_id,
    reason: readReason(row.reason),
    optOutScope: readOptOutScope(row.opt_out_scope),
    tombstonedAt: row.tombstoned_at,
    createdAt: row.created_at,
  };
}

/** 排序口径的单处定义：关系建立先后；同刻按 id 升序（不随存储顺序漂移）。 */
const ORDER_BY_CREATED = "ORDER BY created_at ASC, id ASC";

/** 负责人关系两格写进 SQL 的 IN 列表（值仍取自闭集常量，不在 SQL 文本里另抄一份）。 */
const ASSIGNMENT_REASON_PLACEHOLDERS = ASSIGNMENT_SUBSCRIBER_REASONS.map(() => "?").join(", ");

export function createWorkItemSubscriberRepo(db: DatabaseSync): WorkItemSubscriberRepo {
  const assertSubjectType = (value: SubscriberSubjectType): SubscriberSubjectType => {
    if (!(SUBSCRIBER_SUBJECT_TYPES as readonly string[]).includes(value)) {
      throw new Error(
        `work_item_subscribers.subject_type 拒绝写入非法值「${String(value)}」` +
          "（不在 SUBSCRIBER_SUBJECT_TYPES 内：订阅主体只有 human / agent / squad）。",
      );
    }
    return value;
  };
  const assertScope = (value: OptOutScope): OptOutScope => {
    if (!(OPT_OUT_SCOPES as readonly string[]).includes(value)) {
      throw new Error(
        `work_item_subscribers.opt_out_scope 拒绝写入非法值「${String(value)}」` +
          "（不在 OPT_OUT_SCOPES 内：退订范围只有 issue / subtree）。",
      );
    }
    return value;
  };
  const assertReason = (value: SubscriberReason): SubscriberReason => {
    if (!(SUBSCRIBER_REASONS as readonly string[]).includes(value)) {
      throw new Error(
        `work_item_subscribers.reason 拒绝写入非法值「${String(value)}」` +
          "（不在 SUBSCRIBER_REASONS 内：六 reason 闭集见 spec §7.1）。",
      );
    }
    return value;
  };

  return {
    get(key) {
      const row = db
        .prepare(
          `SELECT * FROM work_item_subscribers
           WHERE workspace_key = ? AND work_item_id = ? AND subject_type = ? AND subject_id = ?`,
        )
        .get(key.workspaceKey, key.workItemId, assertSubjectType(key.subjectType), key.subjectId) as
        | WorkItemSubscriberRow
        | undefined;
      return row ? rowToRecord(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_subscribers
           WHERE workspace_key = ? AND work_item_id = ? ${ORDER_BY_CREATED}`,
        )
        .all(workspaceKey, workItemId) as unknown as WorkItemSubscriberRow[];
      return rows.map(rowToRecord);
    },

    listBySubject(workspaceKey, subjectType, subjectId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_subscribers
           WHERE workspace_key = ? AND subject_type = ? AND subject_id = ? ${ORDER_BY_CREATED}`,
        )
        .all(
          workspaceKey,
          assertSubjectType(subjectType),
          subjectId,
        ) as unknown as WorkItemSubscriberRow[];
      return rows.map(rowToRecord);
    },

    upsertActive(input) {
      const reason = assertReason(input.reason);
      const subjectType = assertSubjectType(input.subjectType);
      /* 一条语句同时表达三条不变式（唯一键 / 墓碑禁区 / manual 保护区）：
         · `ON CONFLICT ... DO UPDATE`：键冲突不可能写出第二行（幂等在存储层，不靠先查后插）；
         · `DO UPDATE ... WHERE` 求值为假 ⇒ 冲突被忽略、**不报错也不写**（sqlite 的 upsert 语义）；
         · `reason <> excluded.reason`：同 reason 重投连一次空写都不发生（不产生新时间戳）。 */
      const result = db
        .prepare(
          `INSERT INTO work_item_subscribers (
             id, workspace_key, workspace_path, work_item_id, subject_type, subject_id,
             reason, opt_out_scope, tombstoned_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issue', NULL, ?)
           ON CONFLICT(workspace_key, work_item_id, subject_type, subject_id) DO UPDATE SET
             reason = excluded.reason
           WHERE work_item_subscribers.tombstoned_at IS NULL
             AND work_item_subscribers.reason <> ?
             AND work_item_subscribers.reason <> excluded.reason`,
        )
        .run(
          input.id ?? randomUUID(),
          input.workspaceKey,
          input.workspacePath,
          input.workItemId,
          subjectType,
          input.subjectId,
          reason,
          input.createdAt ?? Date.now(),
          MANUAL_SUBSCRIBER_REASON,
        );
      return result.changes === 1;
    },

    upsertTombstone(input) {
      const subjectType = assertSubjectType(input.subjectType);
      const scope = assertScope(input.scope);
      const at = input.createdAt ?? Date.now();
      /* 插入支路：凭空退订也建行（`reason` 归 manual）—— tombstone 是关于**未来的意愿**
         （「别再自动把我加回来」），它与「当前有没有自动关系」正交，故不依赖先有一行。
         冲突支路：只改范围，`tombstoned_at` 用 COALESCE 保留**首次**退订时刻。 */
      db.prepare(
        `INSERT INTO work_item_subscribers (
           id, workspace_key, workspace_path, work_item_id, subject_type, subject_id,
           reason, opt_out_scope, tombstoned_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_key, work_item_id, subject_type, subject_id) DO UPDATE SET
           opt_out_scope = excluded.opt_out_scope,
           tombstoned_at = COALESCE(work_item_subscribers.tombstoned_at, excluded.tombstoned_at)`,
      ).run(
        input.id ?? randomUUID(),
        input.workspaceKey,
        input.workspacePath,
        input.workItemId,
        subjectType,
        input.subjectId,
        MANUAL_SUBSCRIBER_REASON,
        scope,
        at,
        at,
      );
    },

    clearTombstone(key) {
      const result = db
        .prepare(
          `UPDATE work_item_subscribers
             SET tombstoned_at = NULL, opt_out_scope = 'issue', reason = ?
           WHERE workspace_key = ? AND work_item_id = ? AND subject_type = ? AND subject_id = ?`,
        )
        .run(
          MANUAL_SUBSCRIBER_REASON,
          key.workspaceKey,
          key.workItemId,
          assertSubjectType(key.subjectType),
          key.subjectId,
        );
      if (result.changes !== 1) {
        throw new Error(
          `work_item_subscribers 没有 (workspace=${key.workspaceKey}, workItem=${key.workItemId}, ` +
            `subject=${key.subjectType}:${key.subjectId}) 的行，无法复活订阅：` +
            "静默 no-op 会让界面以为订阅成功了，故一律抛。",
        );
      }
    },

    revokeAssignment(key) {
      const result = db
        .prepare(
          `DELETE FROM work_item_subscribers
           WHERE workspace_key = ? AND work_item_id = ? AND subject_type = ? AND subject_id = ?
             AND tombstoned_at IS NULL
             AND reason <> ?
             AND reason IN (${ASSIGNMENT_REASON_PLACEHOLDERS})`,
        )
        .run(
          key.workspaceKey,
          key.workItemId,
          assertSubjectType(key.subjectType),
          key.subjectId,
          MANUAL_SUBSCRIBER_REASON,
          ...ASSIGNMENT_SUBSCRIBER_REASONS,
        );
      return result.changes === 1;
    },
  };
}
