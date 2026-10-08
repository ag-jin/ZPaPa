import { useRef, useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import { workItemDetailAssigneeLabel } from "./workItemCollaborationViewModel.js";
import { resolveWorkItemInlineTitleKeyIntent } from "./workItemInlineEditViewModel.js";
import { workItemStatusMessageId } from "./workItemsViewModel.js";
import {
  workItemChildAddDisabledReason,
  workItemChildCreateRequest,
  workItemChildDraftAfterSubmit,
  workItemChildrenView,
} from "./workItemChildrenViewModel.js";
import {
  workItemQuickCreateSubmittable,
  type WorkItemQuickCreateRequest,
} from "./workItemQuickCreateViewModel.js";
import { AssigneeMarker } from "./workItemRowParts.js";

/* 详情页「子项」区（阶段三 · T-P3-R3）：列表（标题 + 状态 + 指派）+ 摘要 + 快速加子项。

   **不新增读面**：清单来自已加载的名册（`snapshot.workItems` 按 `parentId` 过滤），
   不是第二份工作项读、也不是 peek 的活动摘要（那是活动不是子项）。

   四条纪律（每条都有结构守卫，见 `workItemChildren.test.ts`）：
   1. **不造第二棵树**：本区只画**直接**子项的自有轻量行，不 import 看板的行模块 /
      `flattenWorkItemBoard` / `SquadTimelineSection` —— 整棵树与批根时间线仍只在看板行上
      （验收 4：批根行时间线语义零变化）；
   2. **零服务访问**：本组件不 import 服务访问点、不拼请求 —— 请求构造走 P3-R1 那一枚
      纯函数（`workItemChildCreateRequest`），提交经注入的 `onSubmit`（详情页域的唯一写路径）；
   3. **失败不谎报**：名册读不到 ≠ 没有子项（两个状态、两句文案，见 `workItemChildrenView`）；
      提交失败就地显示服务面原文（含上限 / 深度拒绝）并**保留输入**（与 P3-R1 同一实现）；
   4. **无乐观插入**：成功之后只清标题；新行必须来自服务回读（`useWorkItemChildren` 写完
      回读名册），本组件不持有任何工作项列表 state。

   状态所有权：标题草稿 / 就地失败 / 提交中都在本组件（会话内，不入库）；名册与四态由页面
   投影（`snapshot` / `rosterFailure`）；写入由页面注入。 */

export function WorkItemChildrenSection({
  parentId,
  snapshot,
  rosterFailure,
  archived,
  onSubmit,
}: {
  /** 本体的 id（子项的父项；由详情页从读模型带出，组件不猜）。 */
  parentId: string;
  /** 名册（快照）；`null` = 还没读到（loading / 失败由 `rosterFailure` 分）。 */
  snapshot: SquadSnapshot | null;
  /** 名册读取失败的原因；`null` = 没失败（与「零子项」是两个状态）。 */
  rosterFailure: string | null;
  /** 本体是否已归档（归档 ⇒ 添加入口置灰并给原因：服务面 validateParent 必拒）。 */
  archived: boolean;
  /** 唯一写路径（详情页域注入）：**返回失败原因（null = 成功），按契约不 reject**。 */
  onSubmit: (request: WorkItemQuickCreateRequest) => Promise<SquadEntryFeedback | null>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const view = workItemChildrenView({ parentId, snapshot, rosterFailure });
  /** 添加草稿（只有标题：父项就是本体，没有第二个可选项）。 */
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** 最近一次提交的失败（成功 ⇒ `null`）：就地显示，不做 toast（条本身就是它的归宿）。 */
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 输入法组合态（Enter 是候选确认，不是提交；判据复用行内编辑那一枚纯函数）。 */
  const composingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const disabledReason = workItemChildAddDisabledReason({ archived });
  /* 可写 = 名册就绪（写后能回读出新行）且未归档；忙碌 = 本次提交在飞（一次写一条）。 */
  const createEnabled = view.kind === "ready" && disabledReason === null;
  const blocked = !createEnabled || submitting;
  const canSubmit = workItemQuickCreateSubmittable({ title, createEnabled, busy: submitting });

  /** 提交：唯一判据 → 唯一请求构造（复用 P3-R1）→ 注入的唯一写入口；只演进草稿与就地失败。 */
  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    void (async () => {
      let feedback: SquadEntryFeedback | null;
      try {
        feedback = await onSubmit(workItemChildCreateRequest({ title, parentId }));
      } catch (error) {
        /* 接线层按契约不 reject；万一 reject 也不静默 —— 翻成同一条可见提示。 */
        feedback = squadEntryErrorFeedback(error);
      }
      setSubmitting(false);
      setFailure(feedback);
      setTitle((current) => workItemChildDraftAfterSubmit({ title: current, parentId, feedback }));
      // 成功（已清标题）把光标留在输入框：接着敲下一条即连续添加，不用再点一次。
      if (feedback === null) titleRef.current?.focus();
    })();
  };

  return (
    <section
      data-testid="work-item-children"
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {t("squad.workItemDetail.children.title")}
        </h2>
        {view.kind === "ready" ? (
          <span
            data-testid="work-item-children-summary"
            className="text-ui-xs text-foreground-subtlest"
          >
            {t("squad.workItemDetail.children.summary", {
              terminal: view.summary.terminal,
              total: view.summary.total,
            })}
          </span>
        ) : null}
      </div>

      {view.kind === "loading" ? (
        <p data-testid="work-item-children-loading" className="text-ui-xs text-foreground-subtlest">
          {t("squad.workItemDetail.loading")}
        </p>
      ) : view.kind === "unavailable" ? (
        /* 读不到 ≠ 没有：说明行带原始原因（不吞错），清单**不**退化成空态。 */
        <p
          data-testid="work-item-children-roster-unavailable"
          className="text-ui-xs text-foreground-subtlest"
        >
          {t("squad.workItemDetail.children.rosterUnavailable")}：{view.error}
        </p>
      ) : view.children.length === 0 ? (
        <p data-testid="work-item-children-empty" className="text-ui-xs text-foreground-subtlest">
          {t("squad.workItemDetail.children.empty")}
        </p>
      ) : snapshot === null ? null : (
        /* 清单的每一行是**自有轻量行**（不是看板行模块）：只画标题 / 状态 / 指派三件事 ——
           行级动作（编辑 / 改派 / 放弃整批 / 时间线）都留在看板行上，详情页不做第二个动作面。 */
        <ul data-testid="work-item-children-list" className="flex flex-col gap-1">
          {view.children.map((child) => (
            <li
              key={child.id}
              data-testid="work-item-child"
              data-child-work-item-id={child.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="text-ui-sm text-foreground">{child.title}</span>
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {t(workItemStatusMessageId(child.status))}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
                <AssigneeMarker snapshot={snapshot} assignee={child.assignee} />
                {/* `null` = 指派给当前用户；由本地化文案补上（与行/概览/peek 同一份口径）。 */}
                {workItemDetailAssigneeLabel(child, snapshot) ?? t("squad.common.assignee.user")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 快速加子项：入口**常驻**（名册未就绪 / 归档时置灰，归档另给原因行，不静默消失）。 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={titleRef}
          type="text"
          size="sm"
          className="w-56 text-mobile-input-safe md:text-ui-base/relaxed"
          disabled={blocked}
          aria-label={t("squad.common.title")}
          placeholder={t("squad.workItems.quickCreate.placeholder")}
          data-testid="work-item-children-add-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(event) => {
            const intent = resolveWorkItemInlineTitleKeyIntent({
              key: event.key,
              compositionActive: composingRef.current,
              isComposing: event.nativeEvent.isComposing,
            });
            if (intent === "ignore") return;
            event.preventDefault();
            if (intent === "commit") {
              submit();
              return;
            }
            /* Escape = 清掉这条草稿（不写任何东西）+ 收起上一次的失败原因（它说的是那条输入）。 */
            setTitle("");
            setFailure(null);
          }}
        />
        <Button
          size="sm"
          disabled={!canSubmit}
          data-testid="work-item-children-add-submit"
          onClick={submit}
        >
          {t("squad.common.submit")}
        </Button>
        {disabledReason === null ? null : (
          <span
            data-testid="work-item-children-add-disabled"
            className="text-ui-xs text-foreground-subtlest"
          >
            {t(disabledReason)}
          </span>
        )}
        {failure === null ? null : <WorkItemChildAddFailureLine failure={failure} />}
      </div>
    </section>
  );
}

/**
 * 提交失败的就地呈现（**单独导出**：提交是交互后状态，SSR 到不了那里 —— 导出这一行才能在
 * 真渲染里钉住「文案键 + 服务面原文都渲染」，照 `WorkItemPeekContent` 的先例）。
 * 只画不判：有无失败由调用方的会话态决定（`failure === null` ⇒ 整行不渲染）。
 */
export function WorkItemChildAddFailureLine({ failure }: { failure: SquadEntryFeedback }) {
  const { intl } = useZCodeIntl();
  return (
    <p
      role="alert"
      data-testid="work-item-children-add-failure"
      className="w-full text-ui-sm text-destructive"
    >
      {intl.formatMessage({ id: failure.messageId })}
      {failure.detail ? `：${failure.detail}` : ""}
    </p>
  );
}
