import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/* 收件箱仓库：inbox_items 表的**唯一**读写处（「需人介入的事」的机械落点，spec §3.x 实体表）。
   服务面与编排器都不碰裸 SQL；产生点也不自己拼 dedupKey —— 那条规则只有一处实现
   （`inboxItemProducers.computeInboxDedupKey`）。

   为什么可以（且必须）有**直写通路**：冲突发生在编排器内部，它本来就用同一组 repo
   （`workItemRepo` / `squadRunRepo`），再让服务面绕一圈既无必要也会把「登记失败」混进派发路径。
   服务面（`ISquadRuntimeService.recordInboxItem` 等）仍是 UI / host 的入口，两者共用**这一个** repo。

   刻意不进 `packages/services/src/index.ts` 的**值**导出：本模块值导入 `node:crypto`（id 生成），
   而根入口被 renderer 直接解析（browserSafeRootEntry.test.ts 守这条）。类型与纯函数走根入口无碍。 */

/**
 * 一条 InboxItem 是**什么**（回答「这是什么」）。枚举是持久行上的列值，读回时逐个校验（见 readKind）。
 *
 * `kind` 与 `severity` 的分工是用户裁定（2026-10-03）：`kind` 回答「这是什么」，
 * `severity` 只回答「多急」——两者的映射是**唯一来源** `INBOX_SEVERITY_BY_KIND`，
 * 产生点不得各自写字面量（否则「冲突算不算急」会按产生点漂移，且漂移不报错）。
 */
export const INBOX_ITEM_KINDS = [
  /** 集成分支上解不了的合并冲突（父项 `blocked`，等人拍板）。 */
  "merge_conflict",
  /** 队员（或队长）run 的会话终态失败 / 中止（产出没了，等人看一眼）。 */
  "member_failed",
  /** 启动和解收掉的残留 run（宿主已消失、不会有人再把它推向终态）。 */
  "run_orphaned",
  /**
   * 宿主活着、run 卡住（W1 看门狗：探测死会话 / TTL / 探测不可得 / C1 领地 skip 的首见留痕）。
   * 与 `run_orphaned` 的语义分界：`run_orphaned` = 宿主已消失（跨重启和解，含既有队长臂）；
   * 本 kind = 宿主活着而这条 run 停在原地（在线 tick 与启动和解的看门狗段）。
   */
  "run_stalled",
  /** `planDispatch` 的 skip 族：指派给人 / 小队不存在 / 小队已归档 / 目标 agent 已归档或停用（后两类 X2.1-D 起含 targetOverride 点名目标）——skip 不是失败，只是通知等人处理。 */
  "dispatch_skipped",
  /**
   * pr-gate 收尾**降级为本地收尾**（#8 D3）：模式选了 pr-gate，但前置不满足
   * （没 token / 没远端 / 远端不是 GitHub）——批次照常落地，但**不是按用户选的模式**收的尾。
   *
   * 为什么要专门一条：静默降级是最坏的一种（用户以为 PR 已经开了，而实际什么都没推）；
   * 这条记录同时携带**为什么**（`detail.code` 是闭集码值）+ 这次降级涉及的集成分支。
   */
  "pr_gate_degraded",
  /**
   * SUB.2：评论**显式点名**了某个非作者主体（`@agent` / `@squad`，`ParsedMention` 单源）——
   * 「明确要求某人回应/执行」（spec §7.2）。与 `comment_attention` 的分界：本 kind 是**对着某个人说
   * 的一句话**（收件人由点名给定），后者是「我关注的工作项有新动静」（收件人由订阅解析给定）。
   */
  "mention_action_required",
  /** SUB.2：一条决定落库（`decision_created`）且存在非作者的收件人 —— 「需要人作裁决」（spec §7.2）。 */
  "decision_required",
  /**
   * SUB.2：本项（或经祖先链冒泡可达的祖先项）有**非作者的订阅者**，而这条评论没有点名任何人
   * —— 「仅需关注，不要求动作」（spec §7.2）。author 是唯一收件人时**不产生**（自通知问题，
   * 见 `inboxNotificationPolicy`）：单人产品下人类作者恒是自己那条订阅行的主体。
   */
  "comment_attention",
] as const;

/** 一条 InboxItem **多急**（枚举，不是自由文本）——spec §3.x 的三个严重级。 */
export const INBOX_ITEM_SEVERITIES = ["action_required", "attention", "info"] as const;

export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];
export type InboxItemSeverity = (typeof INBOX_ITEM_SEVERITIES)[number];

/**
 * kind → severity 的**唯一来源**（产生点不得各自写字面量）。
 * 冲突要人拍板（`action_required`）；失败与孤儿要人看一眼（`attention`）；skip 只是通知（`info`）。
 */
export const INBOX_SEVERITY_BY_KIND: Record<InboxItemKind, InboxItemSeverity> = {
  merge_conflict: "action_required",
  member_failed: "attention",
  run_orphaned: "attention",
  run_stalled: "attention",
  dispatch_skipped: "info",
  /* pr-gate 降级：没有东西坏掉（批次已按本地形态落地），但**用户选的模式没生效** ——
     要人看一眼（配 token / 换远端 / 或改回 local 模式），故 attention 而不是 info。 */
  pr_gate_degraded: "attention",
  /* SUB.2 三格：点名要人回应、要人裁决 ⇒ action_required；仅需关注 ⇒ info（Q3 裁定）。
     三格都只在这里出现一次 —— 推送档（`inboxNotificationPolicy.resolveInboxDeliveryTier`）
     消费的是本映射的 severity，不另立第二张 kind→推/不推 的表。 */
  mention_action_required: "action_required",
  decision_required: "action_required",
  comment_attention: "info",
};

export type InboxItem = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  kind: InboxItemKind;
  severity: InboxItemSeverity;
  title: string;
  detail: Record<string, unknown>;
  workItemId: string | null;
  runId: string | null;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
};

/**
 * 登记入参。**`severity` 刻意不在入参里**：它由 repo 从 `INBOX_SEVERITY_BY_KIND` 补 —— 产生点只管
 * `kind`，映射只有一处（若让调用方传 severity，「冲突有多急」就会有第二份判据）。
 *
 * `dedupKey` **必须**由 `inboxItemProducers.computeInboxDedupKey` 算（五个 kind 的唯一形状），
 * 产生点不得自己拼串：拼错了不报错，只会表现成「同一件事反复出现在收件箱里」。
 */
export type InboxItemInput = {
  workspaceKey: string;
  workspacePath: string;
  kind: InboxItemKind;
  dedupKey: string;
  title: string;
  detail: Record<string, unknown>;
  workItemId?: string;
  runId?: string;
};

export interface InboxItemRepo {
  /**
   * 登记**一次事实**（`INSERT OR IGNORE`）。
   *
   * 去重是**存储层不变式**（`idx_inbox_items_dedup` 唯一索引），不是「先查后插」：并发下两次查
   * 都可能看不到对方，先查后插会写进两条，而且不报错。冲突时**不写第二行、不改任何列** ——
   * 这正是「已归档不复活」的实现：归档行还占着那个 `(workspace_key, dedup_key)`，
   * 重投被忽略，`archived_at` 原样保留（用户说过「处理完了」，重投不该把它拉回视野）。
   *
   * 返回 `true` = 本次真的插入了新行；`false` = 同 `(workspace_key, dedupKey)` 已有行
   * ⇒ 事实已登记（含已归档那格）。调用方把 `false` 当**结论**（幂等重投），不是错误。
   * `id` 由 repo 生成（`crypto.randomUUID`），`created_at` 取此刻（事实时刻 = 观察时刻）。
   */
  insertIfAbsent(input: InboxItemInput): boolean;
  get(id: string): InboxItem | null;
  /**
   * 全部条目（**跨 workspace** —— 收件箱是用户裁定的跨项目通知面，服务面同理）。
   * 默认**排除已归档**；`includeArchived: true` 才连归档行一起取。
   * 排序固定 `created_at DESC, id ASC`：新的在前（收件箱的主用法），同刻写入的行按 id 定序，
   * 呈现次序不随存储顺序漂移。
   */
  listAll(options?: { includeArchived?: boolean }): InboxItem[];
  /** 单个 workspace 的条目（排序与归档口径同 `listAll`）。 */
  listByWorkspace(workspaceKey: string, options?: { includeArchived?: boolean }): InboxItem[];
  /**
   * 标已读：**只改 `read_at` 一列**（`COALESCE(read_at, ?)` ⇒ 重复调用保留首次时间戳，
   * 「什么时候第一次看到的」不被后来的调用改写）。未命中该 id ⇒ **响亮抛**（照 `setStatus` 的口径）。
   */
  markRead(id: string): void;
  /**
   * 归档：**只改 `archived_at` 一列**（同 `markRead` 的 COALESCE 口径），不碰 `read_at`
   * ——已读与归档是两件正交的事（可读未归档 / 已归档）。未命中该 id ⇒ **响亮抛**。
   */
  archive(id: string): void;
}

interface InboxItemRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  dedup_key: string;
  kind: string;
  severity: string;
  title: string;
  detail_json: string;
  work_item_id: string | null;
  run_id: string | null;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
}

/* 读回枚举列的契约违例断言（与 squadRunRepo.readStatus 同一裁定：宁可响亮失败，也不静默按默认值处理）。
   kind 决定「这条是什么」、severity 决定「多急」——手改库或跨版本残留造出的枚举外值若被静默
   按默认处理，收件箱会给出错的处置建议且不报错，故一律抛并点名 表.列 + 实际值。 */
function readKind(value: string): InboxItemKind {
  if (!(INBOX_ITEM_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `inbox_items.kind 读回非法值「${value}」：列被写坏或枚举被改小。静默按默认值处理会让` +
        "「这条到底是什么事」变成没人知道的事，故一律抛。",
    );
  }
  return value as InboxItemKind;
}

function readSeverity(value: string): InboxItemSeverity {
  if (!(INBOX_ITEM_SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(
      `inbox_items.severity 读回非法值「${value}」：列被写坏或枚举被改小。静默按默认值处理会让` +
        "「这条有多急」变成没人知道的事，故一律抛。",
    );
  }
  return value as InboxItemSeverity;
}

/** 写路径的同一道闸：产生点只准传 INBOX_ITEM_KINDS 里的值（非法值绝不落盘，别把失败推迟到读回）。 */
function assertKind(kind: InboxItemKind): InboxItemKind {
  if (!(INBOX_ITEM_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `inbox_items.kind 拒绝写入非法值「${String(kind)}」（不在 INBOX_ITEM_KINDS 内）`,
    );
  }
  return kind;
}

/* `detail` 读回时 JSON.parse；坏 JSON ⇒ **抛**（不静默 {}）。静默成空对象会把「结构化的原始事实」
   悄悄抹掉，而这条记录的意义就是留痕 —— 读的人会以为「当时没记细节」，而不是「JSON 坏了」。 */
function readDetail(row: InboxItemRow): Record<string, unknown> {
  try {
    return JSON.parse(row.detail_json) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `inbox_items.detail_json 不是合法 JSON（id=${row.id}）：「${row.detail_json}」——` +
        "静默按空对象处理会抹掉这条记录的原始事实，故一律抛。",
      { cause: error },
    );
  }
}

function rowToInboxItem(row: InboxItemRow): InboxItem {
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    kind: readKind(row.kind),
    severity: readSeverity(row.severity),
    title: row.title,
    detail: readDetail(row),
    workItemId: row.work_item_id,
    runId: row.run_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    archivedAt: row.archived_at,
  };
}

// 排序口径的单处定义：新的在前；同刻写入的行按 id 升序（不随存储顺序漂移）。
const ORDER_BY_CREATED = "ORDER BY created_at DESC, id ASC";

export function createInboxItemRepo(db: DatabaseSync): InboxItemRepo {
  return {
    insertIfAbsent(input) {
      const kind = assertKind(input.kind);
      // severity 从这里补（唯一映射），不走入参：产生点只管 kind。
      const severity = INBOX_SEVERITY_BY_KIND[kind];
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO inbox_items (
            id, workspace_key, workspace_path, dedup_key, kind, severity, title, detail_json,
            work_item_id, run_id, created_at, read_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          randomUUID(),
          input.workspaceKey,
          input.workspacePath,
          input.dedupKey,
          kind,
          severity,
          input.title,
          JSON.stringify(input.detail),
          input.workItemId ?? null,
          input.runId ?? null,
          Date.now(),
        );
      // changes === 0 ⇔ 唯一索引拦下了这次插入（同一事实已登记，含已归档那格）：不写第二行、不改任何列。
      return result.changes === 1;
    },

    get(id) {
      const row = db.prepare("SELECT * FROM inbox_items WHERE id = ?").get(id) as
        | InboxItemRow
        | undefined;
      return row ? rowToInboxItem(row) : null;
    },

    listAll(options) {
      const where = options?.includeArchived === true ? "" : "WHERE archived_at IS NULL";
      const rows = db
        .prepare(`SELECT * FROM inbox_items ${where} ${ORDER_BY_CREATED}`)
        .all() as unknown as InboxItemRow[];
      return rows.map(rowToInboxItem);
    },

    listByWorkspace(workspaceKey, options) {
      const includeArchived = options?.includeArchived === true ? "" : "AND archived_at IS NULL";
      const rows = db
        .prepare(
          `SELECT * FROM inbox_items WHERE workspace_key = ? ${includeArchived} ${ORDER_BY_CREATED}`,
        )
        .all(workspaceKey) as unknown as InboxItemRow[];
      return rows.map(rowToInboxItem);
    },

    markRead(id) {
      // COALESCE：重复调用保留**首次**时间戳（后一次调用不改写「什么时候第一次看到的」）。
      const result = db
        .prepare("UPDATE inbox_items SET read_at = COALESCE(read_at, ?) WHERE id = ?")
        .run(Date.now(), id);
      if (result.changes !== 1) {
        throw new Error(
          `inbox_items 没有 id=「${id}」的行，无法标已读：调用方传错 id，或条目已被删除。` +
            "静默 no-op 会让界面以为标成功了，故一律抛。",
        );
      }
    },

    archive(id) {
      // 与 markRead 同款：单列更新 + COALESCE（首次归档时间不被重写）+ 未命中响亮抛。
      const result = db
        .prepare("UPDATE inbox_items SET archived_at = COALESCE(archived_at, ?) WHERE id = ?")
        .run(Date.now(), id);
      if (result.changes !== 1) {
        throw new Error(
          `inbox_items 没有 id=「${id}」的行，无法归档：调用方传错 id，或条目已被删除。` +
            "静默 no-op 会让界面以为归档完成了，故一律抛。",
        );
      }
    },
  };
}
