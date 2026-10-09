import { useCallback, useState } from "react";
import type { PullRequestRecord, PullRequestSyncReport } from "@zcode/services";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  EMPTY_PULL_REQUEST_LINK_DRAFT,
  pullRequestLinkDraftProblemId,
  pullRequestRefreshSummary,
  pullRequestRowFacts,
  type PullRequestLinkDraft,
} from "./workItemPullRequestsViewModel.js";

/* #8 D2：详情页**关联 PR 区**（设计 §4.2 的呈现半边；挂在交付物区之后 —— 两者是同一屏上的
   「产出留痕」与「远端镜像」，拆到两屏会让审查来回跳）。

   四条纪律：
   ① **组件不执行任何服务调用**：link / unlink / refresh 三个回调由详情页给（页面是唯一的执行器
      与失败域归属处，与交付物区/时间线同款）；
   ② **离线缺省不是错误**：`provider.available === false` 时用一句说明行呈现「未配置 token，
      只显示手动登记的链接」并**照常列出已登记的 PR**（用户裁定：无 token 时 PR 区不报错）；
   ③ **刷新结果如实分档**：更新 / 陈旧拒写 / 失败 / 未配置各自可见，失败原因**原样**显示；
   ④ 登记入口**存在但可禁用**（归档 / 读取失败时给原因），不静默消失。 */

type RefreshState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; report: PullRequestSyncReport }
  | { status: "failed"; error: string };

export function WorkItemPullRequestsSection({
  pullRequests,
  provider,
  registerDisabledReasonMessageId,
  noticeMessageId,
  onLink,
  onUnlink,
  onRefresh,
}: {
  /** 读模型带的关联清单（`runtime.pullRequestRepo.listByWorkItem` 口径，门面零重排）。 */
  pullRequests: PullRequestRecord[];
  /** 读数面可用性（同步判据）：`available: false` ⇒ 未配置 token（说明行，不是错误条）。 */
  provider: { available: boolean; reason: string | null };
  /** 写入口的禁用原因（归档 / 读取失败）；`null` = 可写。 */
  registerDisabledReasonMessageId: string | null;
  /**
   * **pr-gate 状态提示**（#8 D3）：由页面用纯函数算好的文案键（等待 PR 合并 / 未配 token 的降级说明）；
   * `null` ⇒ 连容器都不渲染。组件不自己判（判据在 `pullRequestGateNoticeMessageId`，可独立测）。
   */
  noticeMessageId: string | null;
  onLink: (input: { url: string; title?: string }) => Promise<void>;
  onUnlink: (pullRequestId: string) => Promise<void>;
  onRefresh: () => Promise<PullRequestSyncReport>;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<PullRequestLinkDraft>(EMPTY_PULL_REQUEST_LINK_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingUnlinkId, setPendingUnlinkId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<RefreshState>({ status: "idle" });

  const problemId = pullRequestLinkDraftProblemId(draft);
  const disabledReason =
    registerDisabledReasonMessageId === null ? null : t(registerDisabledReasonMessageId);

  const submit = useCallback(async () => {
    // 判据只有一份（纯函数）：按钮禁用与这里的分支不可能分叉。
    if (pullRequestLinkDraftProblemId(draft) !== null) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const title = draft.title.trim();
      await onLink({ url: draft.url.trim(), ...(title === "" ? {} : { title }) });
      setDraft(EMPTY_PULL_REQUEST_LINK_DRAFT);
      setFormOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [draft, onLink]);

  const unlink = useCallback(
    async (pullRequestId: string) => {
      setPendingUnlinkId(pullRequestId);
      try {
        await onUnlink(pullRequestId);
      } finally {
        setPendingUnlinkId(null);
      }
    },
    [onUnlink],
  );

  const runRefresh = useCallback(async () => {
    setRefresh({ status: "running" });
    try {
      setRefresh({ status: "done", report: await onRefresh() });
    } catch (error) {
      setRefresh({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onRefresh]);

  const summary = refresh.status === "done" ? pullRequestRefreshSummary(refresh.report) : null;

  return (
    <section
      data-testid="work-item-pull-requests"
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {t("squad.workItemDetail.pullRequests.title")}
        </h2>
        <Button
          size="sm"
          variant="outline"
          data-testid="work-item-pull-requests-refresh"
          disabled={refresh.status === "running" || disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => void runRefresh()}
        >
          {t("squad.workItemDetail.pullRequests.refresh")}
        </Button>
      </div>

      {/* 离线缺省（没配 token）：说明行，**不是错误**。已登记的关联照常列出。 */}
      {provider.available ? null : (
        <p
          data-testid="work-item-pull-requests-token-missing"
          className="text-ui-xs text-foreground-subtlest"
        >
          {t("squad.workItemDetail.pullRequests.tokenMissing")}
        </p>
      )}

      {/* #8 D3：pr-gate 状态提示（等待 PR 合并 / 未配 token 的降级说明）。无提示 ⇒ 不渲染容器。 */}
      {noticeMessageId === null ? null : (
        <p
          data-testid="work-item-pull-requests-gate-notice"
          className="text-ui-xs text-foreground-subtle"
        >
          {t(noticeMessageId)}
        </p>
      )}

      {pullRequests.length === 0 ? (
        <p
          data-testid="work-item-pull-requests-empty"
          className="text-ui-xs text-foreground-subtlest"
        >
          {t("squad.workItemDetail.pullRequests.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pullRequests.map((record) => {
            const facts = pullRequestRowFacts(record, locale);
            return (
              <li
                key={record.id}
                data-testid="work-item-pull-request"
                className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="work-item-pull-request-state"
                    className="rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle"
                  >
                    {t(facts.stateMessageId)}
                  </span>
                  <a
                    href={facts.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="work-item-pull-request-link"
                    className="text-ui-sm text-foreground underline"
                  >
                    {facts.title}
                  </a>
                  {facts.branch === null ? null : (
                    <span className="text-ui-xs text-foreground-subtlest">{facts.branch}</span>
                  )}
                  {record.apiMergeStateStatus === null ? null : (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {record.apiMergeStateStatus}
                    </span>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="work-item-pull-request-unlink"
                    disabled={disabledReason !== null || pendingUnlinkId === record.id}
                    title={disabledReason ?? undefined}
                    onClick={() => void unlink(record.id)}
                  >
                    {t("squad.workItemDetail.pullRequests.unlink")}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtlest">
                  {facts.headShaShort === null ? null : <span>{facts.headShaShort}</span>}
                  <span>
                    {facts.snapshotAt === null
                      ? t("squad.workItemDetail.pullRequests.snapshot.never")
                      : t("squad.workItemDetail.pullRequests.snapshot.at", {
                          time: facts.snapshotAt,
                        })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 刷新结果（如实分档）：四类结局各自计数；失败原因原样带出。 */}
      {summary === null ? null : (
        <div
          data-testid="work-item-pull-requests-refresh-result"
          className="flex flex-col gap-1 text-ui-xs text-foreground-subtle"
        >
          <span>
            {t("squad.workItemDetail.pullRequests.refreshResult", {
              updated: summary.updated,
              failed: summary.failed,
              unavailable: summary.unavailable,
              discarded: summary.discarded,
            })}
          </span>
          {summary.discardReasons.map((reason) => (
            <span key={reason} data-testid="work-item-pull-requests-discarded">
              {reason}
            </span>
          ))}
          {summary.failureReasons.map((reason) => (
            <span key={reason} className="text-destructive">
              {reason}
            </span>
          ))}
        </div>
      )}
      {refresh.status === "failed" ? (
        <Alert variant="destructive" data-testid="work-item-pull-requests-refresh-failure">
          <AlertDescription className="text-ui-xs">{refresh.error}</AlertDescription>
        </Alert>
      ) : null}

      {/* 手动登记：入口存在但可禁用并给原因（归档 / 读取失败），不静默消失。 */}
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          data-testid="work-item-pull-request-link-toggle"
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => setFormOpen((previous) => !previous)}
        >
          {t("squad.workItemDetail.pullRequests.form.open")}
        </Button>
        {disabledReason === null ? null : (
          <span className="text-ui-xs text-foreground-subtlest">{disabledReason}</span>
        )}
        {formOpen && disabledReason === null ? (
          <div className="flex flex-col gap-2">
            <Input
              data-testid="work-item-pull-request-link-url"
              value={draft.url}
              placeholder={t("squad.workItemDetail.pullRequests.form.urlPlaceholder")}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, url: event.target.value }))
              }
            />
            <Input
              data-testid="work-item-pull-request-link-title"
              value={draft.title}
              placeholder={t("squad.workItemDetail.pullRequests.form.titlePlaceholder")}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, title: event.target.value }))
              }
            />
            {problemId === null || (draft.url === "" && draft.title === "") ? null : (
              <span className="text-ui-xs text-foreground-subtlest">{t(problemId)}</span>
            )}
            {formError === null ? null : (
              <Alert variant="destructive" data-testid="work-item-pull-request-link-failure">
                <AlertDescription className="text-ui-xs">{formError}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                data-testid="work-item-pull-request-link-submit"
                disabled={problemId !== null || submitting}
                onClick={() => void submit()}
              >
                {t("squad.workItemDetail.pullRequests.form.submit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="work-item-pull-request-link-cancel"
                onClick={() => {
                  setFormOpen(false);
                  setDraft(EMPTY_PULL_REQUEST_LINK_DRAFT);
                  setFormError(null);
                }}
              >
                {t("squad.workItemDetail.pullRequests.form.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
