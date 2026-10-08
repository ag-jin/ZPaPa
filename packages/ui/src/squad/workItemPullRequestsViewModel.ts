import {
  normalizeGitHubPullRequestUrl,
  type PullRequestRecord,
  type PullRequestState,
  type PullRequestSyncReport,
} from "@zcode/services";

/* #8 D2：详情页 **PR 区**的纯逻辑（设计 §4.2 的呈现半边）。

   与交付物区同一条分工（组件里不做判断，判据全在纯函数里——ui 包没有 DOM 测试设施）：
   ① 状态徽标映射：`Record<PullRequestState, string>` 的穷尽性让「服务面加一态而界面漏一态」
      直接编译失败；`state === null`（从未拉取）**单独一档**，不是「未知」含糊过去；
   ② 行事实读取：分支/短 sha/快照时刻缺则 null（不猜）——把「没拉过」显示成「open」就是造事实；
   ③ 登记表单的**可提交判据**：判据是**服务面同一个** URL 归一化函数（正则各写一份必然分叉）；
   ④ 刷新结果摘要：四类结局各自计数，失败原因**原样带出**（陈旧拒写单列一档：它不是失败，但必须可见）。

   时间格式化在这里做（组件不做数字/时间格式化，同 J2 的既定纪律）。 */

const PREFIX = "squad.workItemDetail.pullRequests";

/** 四态徽标文案（闭集穷尽映射：服务面加一态 ⇒ 这里编译失败）。 */
export const PULL_REQUEST_STATE_MESSAGE_IDS: Record<PullRequestState, string> = {
  open: `${PREFIX}.state.open`,
  closed: `${PREFIX}.state.closed`,
  merged: `${PREFIX}.state.merged`,
  draft: `${PREFIX}.state.draft`,
};

/** `state === null` 的单独一档：**从未拉取**（离线缺省形态下的常态）。 */
export const PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID = `${PREFIX}.state.notFetched`;

export type PullRequestRowFacts = {
  stateMessageId: string;
  branch: string | null;
  /** 短 head sha（前 7 位）；未拉取 ⇒ null（空 pin 不得显示成一个空 sha）。 */
  headShaShort: string | null;
  /** 快照时刻（按 locale 格式化）；null = 从未拉取。 */
  snapshotAt: string | null;
  neverFetched: boolean;
  url: string;
  title: string;
};

function formatPullRequestSnapshotTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}

export function pullRequestRowFacts(
  record: PullRequestRecord,
  locale: string,
): PullRequestRowFacts {
  const neverFetched = record.snapshotFetchedAt === null;
  return {
    stateMessageId:
      record.state === null
        ? PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID
        : PULL_REQUEST_STATE_MESSAGE_IDS[record.state],
    branch: record.branch !== null && record.branch.trim() !== "" ? record.branch : null,
    headShaShort: record.snapshotHeadSha === "" ? null : record.snapshotHeadSha.slice(0, 7),
    snapshotAt:
      record.snapshotFetchedAt === null
        ? null
        : formatPullRequestSnapshotTime(record.snapshotFetchedAt, locale),
    neverFetched,
    url: record.htmlUrl,
    title: record.title,
  };
}

/** 登记表单草稿（UI 只给「贴哪个地址 / 可选标题」；owner/repo/number 由服务面归一化出来）。 */
export type PullRequestLinkDraft = { url: string; title: string };

export const EMPTY_PULL_REQUEST_LINK_DRAFT: PullRequestLinkDraft = { url: "", title: "" };

/**
 * 可提交判据：返回**首个**问题的文案键（`null` = 可提交）。
 * URL 形态判据复用**服务面同一个**归一化函数（登记表单拦住的东西，服务面一定也拒；
 * 反过来服务面接受的形态这里也一定放行 —— 两处判据不可能分叉）。
 */
export function pullRequestLinkDraftProblemId(draft: PullRequestLinkDraft): string | null {
  const url = draft.url.trim();
  if (url === "") return `${PREFIX}.form.urlRequired`;
  try {
    normalizeGitHubPullRequestUrl(url);
  } catch {
    return `${PREFIX}.form.urlInvalid`;
  }
  return null;
}

/** 一次刷新的摘要（组件按它渲染结果行；四类结局**各自可见**，不合并成「完成」）。 */
export type PullRequestRefreshSummary = {
  updated: number;
  discarded: number;
  unavailable: number;
  failed: number;
  /** 真失败的原因（原样，多条）。 */
  failureReasons: string[];
  /** 陈旧拒写的原因（不是失败，但必须让人看见「这次响应为什么没生效」）。 */
  discardReasons: string[];
};

export function pullRequestRefreshSummary(
  report: PullRequestSyncReport,
): PullRequestRefreshSummary {
  const reasonsOf = (outcome: string) =>
    report.items
      .filter((item) => item.outcome === outcome)
      .flatMap((item) => (item.reason === null ? [] : [item.reason]));
  return {
    updated: report.items.filter((item) => item.outcome === "updated").length,
    discarded: report.items.filter((item) => item.outcome === "discarded_stale").length,
    unavailable: report.items.filter((item) => item.outcome === "unavailable").length,
    failed: report.items.filter((item) => item.outcome === "failed").length,
    failureReasons: reasonsOf("failed"),
    discardReasons: reasonsOf("discarded_stale"),
  };
}
