import type { DatabaseSync } from "node:sqlite";
import type { AuthorRef } from "./workItemCommentRepo.js";

/* #8 D2 的 **PR 关联 + 快照存储面**：`work_item_pull_requests` 表（迁移 0017）的唯一读写口。

   三条立身之本（设计 §4.2，与 multica M1/M2 的移植关系写在 schema-v1 的 SQL 注释里）：
   ① **可变镜像**：与交付物/Activity 的 append-only 相反 —— 快照刷新走 UPDATE、unlink 走 DELETE。
      状态所有权仍单一：本 repo 是这张表唯一的读写者（服务面与同步模块都经它）。
   ② **幂等身份是业务键**（`(workspace_key, work_item_id, owner, name, number)` 唯一索引）：
      同一 PR 挂到同一工作项重投 ⇒ 返回既存行、不产生第二条（INSERT OR IGNORE + 读回）。
   ③ **head-SHA 防陈旧写**（M2 的 CAS，`UPDATE ... WHERE id = ? AND snapshot_head_sha = ?` 的
      SQLite 等价形态）：`replaceSnapshot` 只在「库里的 pin 仍等于本次快照所基于的 head」时写 ——
      一个慢响应（为旧 head 拉的）不得覆盖更新 head 的快照；被丢弃时返回 `false`，**静默丢的是数据
      而不是错误**：调用方（同步模块）必须把它记进 SyncReport（不静默）。

   读回不猜：`state` 闭集外的值一律响亮抛（同交付物 repo 的 kind 双闸）——静默当 `null`
   会把「这行被写坏了」伪装成「还没拉取过」。 */

/** 快照状态闭集（multica M1 口径：`open` / `closed` / `merged` / `draft`）。 */
export const PULL_REQUEST_STATES = ["open", "closed", "merged", "draft"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export type PullRequestRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  title: string;
  htmlUrl: string;
  /** 远端分支名（快照带来；未拉取时 null —— 不猜）。 */
  branch: string | null;
  /** **NULL = 从未拉取过快照**（离线缺省形态：只登记了 URL）。 */
  state: PullRequestState | null;
  /** 远端 merge 时刻（ms，快照带来）；NULL = 未 merge 或未拉取。 */
  mergedAt: number | null;
  /** GitHub 原值：MERGEABLE / CONFLICTING / UNKNOWN。 */
  apiMergeable: string | null;
  /** GitHub 原值：CLEAN / DIRTY / BLOCKED / BEHIND / UNSTABLE / DRAFT / HAS_HOOKS / UNKNOWN。 */
  apiMergeStateStatus: string | null;
  /** 快照 pin：当前快照是为哪个 head 拉的；`''` = 从未拉取（防陈旧写的比较对象）。 */
  snapshotHeadSha: string;
  /** 快照时刻（ms）；NULL = 从未拉取（呈现侧「快照陈旧」判据的原料）。 */
  snapshotFetchedAt: number | null;
  linkedBy: AuthorRef;
  createdAt: number;
  updatedAt: number;
};

/** `replaceSnapshot` 的输入：**全部**取自一次 REST GET 的响应（远端事实的唯一源）。 */
export type PullRequestSnapshot = {
  state: PullRequestState;
  mergedAt: number | null;
  title: string;
  branch: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  headSha: string;
  fetchedAt: number;
};

export type LinkPullRequestInput = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  /** 省略/空白 ⇒ 派生 `owner/name#number`（呈现可读；远端标题归快照，登记时不猜）。 */
  title?: string;
  htmlUrl: string;
  /**
   * **登记时已知的 head 分支**（#8 D3 加法）：自动开 PR 的那条路径（pr-gate 收尾）在创建响应里
   * 就拿到了 head ref —— 那是**已知事实**，不是猜的；落进这一列让「本批那条 PR」可按分支认出来
   * （收尾幂等闸的判据）。人工贴 URL 不给（远端 head 归快照，登记时不知道）。
   * 省略/空白 ⇒ NULL（不猜：NULL 只表示「尚无此事实」）。
   */
  branch?: string;
  linkedBy: AuthorRef;
  createdAt: number;
};

export interface WorkItemPullRequestRepo {
  /**
   * 登记一条关联（幂等）：同 `(workspace, item, owner, name, number)` 重投返回**既存行**，
   * 列不被改写（登记的是一个地址，不是一次刷新 —— 快照走 `replaceSnapshot`）。
   */
  link(input: LinkPullRequestInput): PullRequestRecord;
  /** 单条；id 不存在返回 null（「没有这条」是正常状态，不是错误）。 */
  get(id: string): PullRequestRecord | null;
  /** 某工作项的关联清单（`created_at ASC, id ASC`；workspace 隔离）。 */
  listByWorkItem(workspaceKey: string, workItemId: string): PullRequestRecord[];
  /** 解除关联（真删）。返回是否删到一行（`false` = 本来就没有 —— 不是错误）。 */
  unlink(id: string): boolean;
  /**
   * 落一份快照（**原子替换**：镜像列 + 快照列一起写，不存在半新半旧）。
   * `expectHeadSha` = **拉取前**读到的行 pin；库里 pin 已变 ⇒ 整条拒写并返回 `false`。
   * id 不存在 ⇒ 也返回 `false`（调用方不得当作写成功）。
   */
  replaceSnapshot(input: {
    id: string;
    expectHeadSha: string;
    snapshot: PullRequestSnapshot;
  }): boolean;
}

interface PullRequestRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  title: string;
  html_url: string;
  branch: string | null;
  state: string | null;
  merged_at: number | null;
  api_mergeable: string | null;
  api_merge_state_status: string | null;
  snapshot_head_sha: string;
  snapshot_fetched_at: number | null;
  linked_by_kind: string;
  linked_by_id: string;
  created_at: number;
  updated_at: number;
}

function readState(value: string | null): PullRequestState | null {
  if (value === null) return null;
  if (!(PULL_REQUEST_STATES as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_pull_requests.state 读回非法值「${value}」：列被写坏或闭集被改小，一律抛。`,
    );
  }
  return value as PullRequestState;
}

function assertState(state: PullRequestState): PullRequestState {
  if (!(PULL_REQUEST_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `work_item_pull_requests.state 拒绝写入非法值「${String(state)}」（不在闭集内）`,
    );
  }
  return state;
}

function readAuthorKind(value: string): AuthorRef["kind"] {
  if (!["human", "agent", "system"].includes(value)) {
    throw new Error(`work_item_pull_requests.linked_by_kind 读回非法值「${value}」：一律抛。`);
  }
  return value as AuthorRef["kind"];
}

/** 形态闸（写入前）：空串/空白进 key 或 URL 位，会让「这条 PR 是什么」在库里无人能答。 */
function assertNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`work_item_pull_requests.${field} 不得为空白（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

function assertPrNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `work_item_pull_requests.pr_number 必须是正整数（收到 ${JSON.stringify(value)}）：` +
        "0/负数/小数都不是 GitHub 的 PR 号，落库即是一条查不回的关联。",
    );
  }
  return value;
}

function rowToRecord(row: PullRequestRow): PullRequestRecord {
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    title: row.title,
    htmlUrl: row.html_url,
    branch: row.branch,
    state: readState(row.state),
    mergedAt: row.merged_at,
    apiMergeable: row.api_mergeable,
    apiMergeStateStatus: row.api_merge_state_status,
    snapshotHeadSha: row.snapshot_head_sha,
    snapshotFetchedAt: row.snapshot_fetched_at,
    linkedBy: { kind: readAuthorKind(row.linked_by_kind), id: row.linked_by_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 缺省标题：`owner/name#number`（登记时只知地址，标题归快照；不猜远端标题）。 */
function defaultPullRequestTitle(input: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
}): string {
  return `${input.repoOwner}/${input.repoName}#${input.prNumber}`;
}

/**
 * 关联行的 id：由**业务键**确定性派生（`pr-<workItemId>-<owner>-<name>-<number>`）。
 *
 * 为什么不是随机 id（与手动交付物登记相反的取舍）：同一 PR 挂到同一工作项**就是同一条关联**
 * （唯一索引是它的判据，登记是幂等的），确定性 id 让「unlink 后重新登记」回到同一行 id，
 * 也让日志/报错里的 id 一眼能读出它指哪条关联。真正的唯一性仍由 `UNIQUE` 索引保证
 * （不同工作项/不同 owner 的组合自然不同；id 只作句柄）。
 */
export function pullRequestLinkId(input: {
  workItemId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
}): string {
  return `pr-${input.workItemId}-${input.repoOwner}-${input.repoName}-${input.prNumber}`;
}

const ORDER = "ORDER BY created_at ASC, id ASC";

export function createWorkItemPullRequestRepo(db: DatabaseSync): WorkItemPullRequestRepo {
  function readByBusinessKey(input: {
    workspaceKey: string;
    workItemId: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
  }): PullRequestRecord | null {
    const row = db
      .prepare(
        `SELECT * FROM work_item_pull_requests
          WHERE workspace_key = ? AND work_item_id = ? AND repo_owner = ? AND repo_name = ?
            AND pr_number = ?`,
      )
      .get(input.workspaceKey, input.workItemId, input.repoOwner, input.repoName, input.prNumber) as
      | PullRequestRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  return {
    link(input) {
      const repoOwner = assertNonBlank(input.repoOwner, "repo_owner");
      const repoName = assertNonBlank(input.repoName, "repo_name");
      const htmlUrl = assertNonBlank(input.htmlUrl, "html_url");
      const prNumber = assertPrNumber(input.prNumber);
      const title = input.title?.trim() ? input.title.trim() : defaultPullRequestTitle(input);
      // 登记时已知的 head 分支（D3 加法）：空白视同没给（NULL 不猜）。
      const branch = input.branch !== undefined && input.branch.trim() !== "" ? input.branch : null;
      const key = {
        workspaceKey: input.workspaceKey,
        workItemId: input.workItemId,
        repoOwner,
        repoName,
        prNumber,
      };
      // 幂等：重投返回既存行（不先查后插的老问题由唯一索引兜底，INSERT OR IGNORE 后统一读回）。
      db.prepare(
        `INSERT OR IGNORE INTO work_item_pull_requests (
           id, workspace_key, workspace_path, work_item_id, repo_owner, repo_name, pr_number,
           title, html_url, branch, state, merged_at, api_mergeable, api_merge_state_status,
           snapshot_head_sha, snapshot_fetched_at, linked_by_kind, linked_by_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', NULL, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.workspaceKey,
        input.workspacePath,
        input.workItemId,
        repoOwner,
        repoName,
        prNumber,
        title,
        htmlUrl,
        branch,
        input.linkedBy.kind,
        input.linkedBy.id,
        input.createdAt,
        input.createdAt,
      );
      const row = readByBusinessKey(key);
      if (!row) {
        throw new Error(
          `work_item_pull_requests 写入后读不回（id=${input.id}, ${repoOwner}/${repoName}#${prNumber}）：` +
            "不可达态，须查库。",
        );
      }
      return row;
    },

    get(id) {
      const row = db.prepare("SELECT * FROM work_item_pull_requests WHERE id = ?").get(id) as
        | PullRequestRow
        | undefined;
      return row ? rowToRecord(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_pull_requests WHERE workspace_key = ? AND work_item_id = ? ${ORDER}`,
        )
        .all(workspaceKey, workItemId) as unknown as PullRequestRow[];
      return rows.map(rowToRecord);
    },

    unlink(id) {
      const result = db.prepare("DELETE FROM work_item_pull_requests WHERE id = ?").run(id);
      return Number(result.changes) > 0;
    },

    replaceSnapshot({ id, expectHeadSha, snapshot }) {
      const state = assertState(snapshot.state);
      const headSha = assertNonBlank(snapshot.headSha, "snapshot_head_sha");
      /* head-SHA 防陈旧写（M2 的 CAS）：`WHERE id = ? AND snapshot_head_sha = ?`。
         · pin 已变（另一个刷新先落地）⇒ 0 行更新 ⇒ 本次响应整条丢弃；
         · id 不存在 ⇒ 同样 0 行（调用方看 false）。
         一次 UPDATE 写全镜像列 + 快照列：不存在「新 state 配旧 head」的半新半旧行。 */
      const result = db
        .prepare(
          `UPDATE work_item_pull_requests
              SET title = ?, branch = ?, state = ?, merged_at = ?, api_mergeable = ?,
                  api_merge_state_status = ?, snapshot_head_sha = ?, snapshot_fetched_at = ?,
                  updated_at = ?
            WHERE id = ? AND snapshot_head_sha = ?`,
        )
        .run(
          snapshot.title,
          snapshot.branch,
          state,
          snapshot.mergedAt,
          snapshot.mergeable,
          snapshot.mergeStateStatus,
          headSha,
          snapshot.fetchedAt,
          snapshot.fetchedAt,
          id,
          expectHeadSha,
        );
      return Number(result.changes) > 0;
    },
  };
}
