import { useCallback, useState } from "react";
import type { WorkItemDeliverableDetail, WorkItemDeliverableRecord } from "@zcode/services";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DELIVERABLE_KIND_MESSAGE_IDS,
  EMPTY_DELIVERABLE_LINK_DRAFT,
  deliverableFacts,
  deliverableLinkDraftProblemId,
  type DeliverableLinkDraft,
} from "./workItemDeliverablesViewModel.js";

/* #7 D1b：详情页**交付物区**（设计 §3.4「详情页交付物区」；挂载点在概览与协作之间）。

   为什么它是一块独立分区而不是塞进时间线：交付物是**清单**（可数、可打开正文、可登记），
   而时间线是**流水**。合并后分支即删（spec §6.3），这份清单是产出的唯一可复查面。

   两条纪律（与 WorkItemDecisionRecorder 同款）：
   ① **组件自己不执行任何服务调用**：登记经 `onRegisterLink`、正文读取经 `onLoadContent`，
      两个回调都由详情页给（页面是唯一的执行器/失败域归属处）；
   ② 正文三态**不谎报**：`file` 渲染正文、`missing` 提示「正文缺失」（元数据在库，不重建）、
      `external` 走外链 —— 缺正文时**不显示空框**（空框会被读成「这个 diff 是空的」）。

   diff 条目的正文按需取（点开才取）：清单走库，正文可达 MB 级（设计 §3.2 的存储取舍）。 */

type ContentState =
  | { status: "loading" }
  | { status: "ready"; detail: WorkItemDeliverableDetail | null }
  | { status: "failed"; error: string };

export function WorkItemDeliverablesSection({
  deliverables,
  registerDisabledReasonMessageId,
  onRegisterLink,
  onLoadContent,
}: {
  /** 协作读模型带的清单（`runtime.deliverableRepo.listByWorkItem` 口径，门面零重排）。 */
  deliverables: WorkItemDeliverableRecord[];
  /** 手动登记的禁用原因（归档 / 读取失败）；`null` = 可写。入口存在但禁用，不静默消失。 */
  registerDisabledReasonMessageId: string | null;
  onRegisterLink: (input: { title: string; url: string }) => Promise<void>;
  onLoadContent: (deliverableId: string) => Promise<WorkItemDeliverableDetail | null>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  /** 展开中的 diff 条目 id（一次只开一条：并行开多条会让正文把清单推走）。 */
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ status: "loading" });
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<DeliverableLinkDraft>(EMPTY_DELIVERABLE_LINK_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const problemId = deliverableLinkDraftProblemId(draft);
  const disabledReason =
    registerDisabledReasonMessageId === null ? null : t(registerDisabledReasonMessageId);

  const openContent = useCallback(
    async (deliverableId: string) => {
      setOpenId(deliverableId);
      setContent({ status: "loading" });
      try {
        const detail = await onLoadContent(deliverableId);
        setContent({ status: "ready", detail });
      } catch (error) {
        setContent({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onLoadContent],
  );

  const toggleContent = useCallback(
    (record: WorkItemDeliverableRecord) => {
      if (openId === record.id) {
        setOpenId(null);
        return;
      }
      void openContent(record.id);
    },
    [openId, openContent],
  );

  const submit = useCallback(async () => {
    // 判据只有一份（纯函数）：按钮禁用与这里的分支不可能分叉。
    if (deliverableLinkDraftProblemId(draft) !== null) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onRegisterLink({ title: draft.title.trim(), url: draft.url.trim() });
      // 成功才清草稿、收表单：失败保留输入（页面另有动作错误条，这里再给一条就地的）。
      setDraft(EMPTY_DELIVERABLE_LINK_DRAFT);
      setFormOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [draft, onRegisterLink]);

  return (
    <section
      data-testid="work-item-deliverables"
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4"
    >
      <h2 className="text-ui-base font-medium text-foreground">
        {t("squad.workItemDetail.deliverables.title")}
      </h2>

      {deliverables.length === 0 ? (
        <p
          data-testid="work-item-deliverables-empty"
          className="text-ui-xs text-foreground-subtlest"
        >
          {t("squad.workItemDetail.deliverables.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {deliverables.map((record) => {
            const facts = deliverableFacts(record);
            return (
              <li
                key={record.id}
                data-testid="work-item-deliverable"
                data-kind={record.kind}
                className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                    {t(DELIVERABLE_KIND_MESSAGE_IDS[record.kind])}
                  </span>
                  <span className="text-ui-sm text-foreground">{record.title}</span>
                  {facts.branch === null ? null : (
                    <span className="text-ui-xs text-foreground-subtlest">{facts.branch}</span>
                  )}
                  {facts.commits === null ? null : (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {t("squad.workItemDetail.deliverables.commits", { count: facts.commits })}
                    </span>
                  )}
                  {facts.size === null ? null : (
                    <span className="text-ui-xs text-foreground-subtlest">{facts.size}</span>
                  )}
                  {/* link：外链直接可点（正文在外部，没有「查看」这一步）。 */}
                  {facts.url === null ? null : (
                    <a
                      href={facts.url}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="work-item-deliverable-link"
                      className="text-ui-xs text-foreground-subtle underline"
                    >
                      {facts.url}
                    </a>
                  )}
                  {record.kind === "link" ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="work-item-deliverable-toggle"
                      aria-expanded={openId === record.id}
                      onClick={() => toggleContent(record)}
                    >
                      {openId === record.id
                        ? t("squad.workItemDetail.deliverables.hide")
                        : t("squad.workItemDetail.deliverables.view")}
                    </Button>
                  )}
                </div>
                {facts.statSummary === null ? null : (
                  <pre className="overflow-x-auto text-ui-xs text-foreground-subtlest">
                    {facts.statSummary}
                  </pre>
                )}
                {openId !== record.id ? null : <DeliverableContent state={content} />}
              </li>
            );
          })}
        </ul>
      )}

      {/* 手动登记（设计 §3.3「手动」）：入口**存在但禁用**并给原因（归档 / 读取失败），不静默消失。 */}
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          data-testid="work-item-deliverable-link-toggle"
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={() => setFormOpen((previous) => !previous)}
        >
          {t("squad.workItemDetail.deliverables.form.open")}
        </Button>
        {disabledReason === null ? null : (
          <span className="text-ui-xs text-foreground-subtlest">{disabledReason}</span>
        )}
        {formOpen && disabledReason === null ? (
          <div className="flex flex-col gap-2">
            <Input
              data-testid="work-item-deliverable-link-title"
              value={draft.title}
              placeholder={t("squad.workItemDetail.deliverables.form.titlePlaceholder")}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, title: event.target.value }))
              }
            />
            <Input
              data-testid="work-item-deliverable-link-url"
              value={draft.url}
              placeholder={t("squad.workItemDetail.deliverables.form.urlPlaceholder")}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, url: event.target.value }))
              }
            />
            {problemId === null || (draft.title === "" && draft.url === "") ? null : (
              <span className="text-ui-xs text-foreground-subtlest">{t(problemId)}</span>
            )}
            {formError === null ? null : (
              <Alert variant="destructive" data-testid="work-item-deliverable-link-failure">
                <AlertDescription className="text-ui-xs">{formError}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                data-testid="work-item-deliverable-link-submit"
                disabled={problemId !== null || submitting}
                onClick={() => void submit()}
              >
                {t("squad.workItemDetail.deliverables.form.submit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFormOpen(false);
                  setDraft(EMPTY_DELIVERABLE_LINK_DRAFT);
                  setFormError(null);
                }}
              >
                {t("squad.workItemDetail.deliverables.form.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** 正文三态（**不谎报**）：可读 / 缺失（不重建、不显示空框）/ 外部引用；另加在途与读取失败两态。 */
function DeliverableContent({ state }: { state: ContentState }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  if (state.status === "loading") {
    return (
      <span className="text-ui-xs text-foreground-subtlest">
        {t("squad.workItemDetail.deliverables.contentLoading")}
      </span>
    );
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-testid="work-item-deliverable-content-failure">
        <AlertDescription className="text-ui-xs">
          {t("squad.workItemDetail.deliverables.contentFailed")} · {state.error}
        </AlertDescription>
      </Alert>
    );
  }
  const detail = state.detail;
  if (detail === null) {
    // 读回 null = 这条交付物在库里不存在（正常状态：读不到就是读不到，不假装有）。
    return (
      <span
        data-testid="work-item-deliverable-content-missing"
        className="text-ui-xs text-foreground-subtlest"
      >
        {t("squad.workItemDetail.deliverables.contentMissing")}
      </span>
    );
  }
  if (detail.content.presence === "file") {
    return (
      <pre
        data-testid="work-item-deliverable-content-text"
        className="max-h-96 overflow-auto rounded border border-border bg-muted/30 px-2 py-1 text-ui-xs text-foreground-subtle"
      >
        {detail.content.text}
      </pre>
    );
  }
  if (detail.content.presence === "missing") {
    /* 用户删了 `.zcode`（或正文被移走）：元数据在库 ⇒ 只报「正文缺失」。
       刻意**不**渲染空 `<pre>`：空框会被读成「这个 diff 是空的」，那是另一种谎话。 */
    return (
      <span
        data-testid="work-item-deliverable-content-missing"
        className="text-ui-xs text-foreground-subtlest"
      >
        {t("squad.workItemDetail.deliverables.contentMissing")}
      </span>
    );
  }
  if (detail.content.presence === "external") {
    return (
      <a
        href={detail.content.url}
        target="_blank"
        rel="noreferrer"
        data-testid="work-item-deliverable-content-external"
        className="text-ui-xs text-foreground-subtle underline"
      >
        {detail.content.url}
      </a>
    );
  }
  /* 不可达（三态穷尽）；留一行显式返回而不是隐式 undefined：组件返回 undefined 在 React 19
     的调用点会变成一个安静的空白块，而这里该发生的事已经全部发生完了。 */
  return null;
}
