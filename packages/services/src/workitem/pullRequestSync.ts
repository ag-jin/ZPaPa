import type { PullRequestProvider } from "./pullRequestProvider.js";
import type {
  PullRequestRecord,
  PullRequestState,
  WorkItemPullRequestRepo,
} from "./workItemPullRequestRepo.js";

/* #8 D2 的**同步深模块**（设计 §4.2「删掉它：fetch + 快照写 + 终态判定 + 回声在
   『详情页刷新』与『手动刷新』两处各长一份 —— 通过删除测试」）。

   一个方法（`refreshForWorkItem`）：取该工作项已链接 PR → 逐个 fetch → **head-SHA 防陈旧写**
   落快照 → 把每条的结果与**当前库里真正的事实**收进一份 report。

   三条硬约束（结构上钉住，见 pullRequestSync 的结构守卫测试）：
   ① **不做终态判定**（D2 的边界）：本模块拿不到状态机 / 工作项 repo / 派发面 —— PR merged ⇒
      工作项 `done` 是 D3 在**调用点**上做的事（唯一写者仍是 `WorkItemService.transition`）。
      D2 只负责把「哪些 PR 现在是 merged」**读出来**（`mergedPullRequests`），这就是 D3 消费的口。
   ② **不静默**：失败（401/网络/限流）、不可用（没配 token）、陈旧拒写（CAS 输家）三种结局
      都带原因进 report —— 静默的失败与「刷新成功但什么都没变」在界面上分不开。
   ③ **单条失败不阻断其余**：一个 PR 401 不该让同屏另外两个 PR 的快照也刷不动。

   触发面（用户裁定）：**按需** —— 详情页的刷新按钮。没有后台定时器：单机省配额，
   「打开页面/点刷新即新鲜」符合审查场景（设计 §7 的异步行为）。 */

export type PullRequestSyncOutcome =
  /** 快照已写入（镜像列 + 快照列一起更新）。 */
  | "updated"
  /** 快照被**防陈旧写**拒绝：本次响应基于的 head 已被更晚的刷新取代（整条丢弃）。 */
  | "discarded_stale"
  /** 没有可用的读数面（未配 token）——**不是错误**（离线缺省形态）。 */
  | "unavailable"
  /** 真失败：HTTP 错误 / 网络失败 / 响应形态不对。 */
  | "failed";

export type PullRequestSyncItem = {
  pullRequestId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  htmlUrl: string;
  outcome: PullRequestSyncOutcome;
  /** 失败/不可用/陈旧拒写的原因（响亮）；成功为 null。 */
  reason: string | null;
  /** **读回**的当前快照状态（成功=新值；失败/不可用=原有值；陈旧拒写=库里未被覆盖的值）。 */
  state: PullRequestState | null;
  snapshotFetchedAt: number | null;
};

/** D3（终态驱动）消费的口：当前快照里 `state=merged` 的 PR（读自库，不是一次 fetch 的中间值）。 */
export type PullRequestMergedFact = {
  pullRequestId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  htmlUrl: string;
  mergedAt: number | null;
};

export type PullRequestSyncReport = {
  workItemId: string;
  /** 读数面此刻是否可用（未配 token ⇒ false，`items` 全部 unavailable）。 */
  providerAvailable: boolean;
  providerUnavailableReason: string | null;
  items: PullRequestSyncItem[];
  mergedPullRequests: PullRequestMergedFact[];
};

export interface PullRequestSync {
  /** 刷新一个工作项下的全部已链接 PR（按 `created_at, id` 主序，逐条串行）。 */
  refreshForWorkItem(input: { workItemId: string }): Promise<PullRequestSyncReport>;
}

export function createPullRequestSync(deps: {
  provider: PullRequestProvider;
  repo: WorkItemPullRequestRepo;
  /** 本 runtime 绑定的 workspace（关联行按 workspace_key 隔离）。 */
  workspace: { key: string };
}): PullRequestSync {
  const { repo, provider } = deps;

  /** report 里每条都带**库里的现状**（而不是「刚才那次响应说什么」）。 */
  function toItem(
    row: PullRequestRecord,
    outcome: PullRequestSyncOutcome,
    reason: string | null,
  ): PullRequestSyncItem {
    const current = repo.get(row.id) ?? row;
    return {
      pullRequestId: current.id,
      repoOwner: current.repoOwner,
      repoName: current.repoName,
      prNumber: current.prNumber,
      htmlUrl: current.htmlUrl,
      outcome,
      reason,
      state: current.state,
      snapshotFetchedAt: current.snapshotFetchedAt,
    };
  }

  return {
    async refreshForWorkItem({ workItemId }) {
      const status = provider.describe();
      const rows = repo.listByWorkItem(deps.workspace.key, workItemId);
      const items: PullRequestSyncItem[] = [];

      for (const row of rows) {
        const result = await provider.fetchPullRequest(row.htmlUrl);
        if (!result.ok) {
          items.push(
            toItem(row, result.code === "unavailable" ? "unavailable" : "failed", result.reason),
          );
          continue;
        }
        /* 防陈旧写：`expectHeadSha` = **拉取前**读到的 pin。库里的 pin 在此期间被推进
           （更晚的一次刷新先落地）⇒ 本次响应整条丢弃 —— 这不是失败，但**必须可见**
           （否则「刷了但没变」与「被丢弃」分不开）。 */
        const written = repo.replaceSnapshot({
          id: row.id,
          expectHeadSha: row.snapshotHeadSha,
          snapshot: result.snapshot,
        });
        items.push(
          written
            ? toItem(row, "updated", null)
            : toItem(
                row,
                "discarded_stale",
                `本次响应基于 head ${shortSha(row.snapshotHeadSha)}，而库里已被更新的快照取代：` +
                  "按防陈旧写丢弃这次响应（未改动任何一列）。",
              ),
        );
      }

      const mergedPullRequests = repo
        .listByWorkItem(deps.workspace.key, workItemId)
        .filter((row) => row.state === "merged")
        .map((row) => ({
          pullRequestId: row.id,
          repoOwner: row.repoOwner,
          repoName: row.repoName,
          prNumber: row.prNumber,
          htmlUrl: row.htmlUrl,
          mergedAt: row.mergedAt,
        }));

      return {
        workItemId,
        providerAvailable: status.available,
        providerUnavailableReason: status.available ? null : status.reason,
        items,
        mergedPullRequests,
      };
    },
  };
}

/** 呈现与 reasons 里用短 sha（完整 sha 在快照列里，报错文案不需要 40 位）。 */
function shortSha(sha: string): string {
  return sha === "" ? "(未拉取)" : sha.slice(0, 7);
}
