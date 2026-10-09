import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import type { SquadSnapshot, WorkItemCollaborationRead } from "@zcode/services";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { squadWorkspaceTarget } from "./squadRuntimeAccess.js";
import { useWorkItemCollaboration } from "./useWorkItemCollaboration.js";
import { useWorkItemReactionRows, type WorkItemReactionRows } from "./useWorkItemReactionRows.js";
import { workItemDetailAssigneeLabel } from "./workItemCollaborationViewModel.js";
import { AssigneeMarker } from "./workItemRowParts.js";
import { WorkItemLabelChip, WorkItemPriorityBadge } from "./WorkItemRows.js";
import { WorkItemReactionChips } from "./WorkItemReactionChips.js";
import { workItemPeekActivityLines, workItemPeekView } from "./workItemPeekViewModel.js";
import { workItemReactionGroups } from "./workItemReactionsViewModel.js";
import {
  workItemCreatorKindMessageId,
  workItemCreatorText,
  workItemDateText,
  workItemIdentifierText,
} from "./workItemPropertiesViewModel.js";
import { workItemPropertyValueText, workItemStatusMessageId } from "./workItemsViewModel.js";

/* **侧边 peek**（阶段三 · T-P3-R2）：行预览的右侧轻量面板 —— 概览 + 属性 + 标签 + 最近活动摘要 +
   「打开完整详情页」。**只读**：面板里没有任何写入入口（完整面与全部写执行器仍在独立详情页，
   用户裁定 Q8 的并存口径：peek 速览 + 一个通往完整面的稳定入口）。

   五条纪律（每条都有结构守卫，见 `workItemPeek.test.ts`）：
   1. **同一读模型**：取数经 `useWorkItemCollaboration`（详情页那一枚 hook：同一状态机、同一服务
      入口、同一三失败域）；本模块**不**出现第二份取数实现（守卫按全树扫描：`getWorkItemCollaboration(`
      只在 hook 模块里出现一次）。
      T-P3-R5u 追加的例外只有**一处**：表情回应经 `useWorkItemReactionRows` 读（服务面另一个读面，
      协作读模型不带它）—— 仍只挂**读** hook，可写 hook 与写方法在本文件里一个都不出现。
   2. **零写调用**：不 import 任何写方法、不拿服务对象 —— 结构上写不出去（守卫扫写方法名清单）。
   3. **关闭路径**：Esc（判据在 `workItemPeekKeyIntent`，由宿主的键盘层执行）、点击面板外部
      （下面的 pointerdown 监听：面板之外的任何一次按下即关）、头部关闭钮。三条都不写任何东西。
   4. **非模态**：面板**不抢焦点**（它是速览，不是对话框）——用户的位置留在触发行上，
      关闭时由宿主把焦点还回去（验收 ③「焦点回到触发行」）。
   5. **状态呈现**：四态（加载 / 失败 / 不存在 / 有内容）由 `workItemPeekView` 一处判定；
      失败态给就地原因 + 重试（复用详情页的既有文案），刷新失败**不清空**已读到的内容。 */

export function WorkItemPeek({
  workItemId,
  workspacePath,
  workspaceIdentity,
  snapshot,
  onClose,
  onOpenDetail,
  className,
}: {
  /** 当前预览的工作项（宿主持有打开态；`null` 不渲染本组件）。 */
  workItemId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 快照只用于**指派显示**（名册解析；与详情页同一个纯函数）——不是第二份工作项来源。 */
  snapshot: SquadSnapshot;
  onClose: () => void;
  /** 「打开完整详情页」：交回宿主的导航回调（本层不持有导航意图）。 */
  onOpenDetail: () => void;
  /** 面板外壳的**附加**类（T-P3-R4 的接缝）：窄屏抽屉里传 `w-full ...` 让面板铺满并摘掉分栏卡片
      的外框；缺省 ⇒ 桌面分栏那一套逐字不变（`cn` 合并，宽度类冲突时后者胜 —— 两份宽度类同时
      留着的话谁生效取决于 CSS 顺序，那是不可判的形态）。 */
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const panelRef = useRef<HTMLElement | null>(null);
  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );
  /* **同一读模型**（纪律 1）：与详情页同一个 hook —— 状态机、服务入口、过期响应丢弃、失败域全共用。 */
  const { state, reload } = useWorkItemCollaboration({ target, workItemId });
  /* 表情回应：**只读**的第二条读数通路（T-P3-R5u；reactions 是服务面另一个读面，协作读模型
     不带它）。本模块只挂读 hook —— 可写 hook / 写方法在本文件里一个都不出现（零写纪律按模块
     咬住：见结构守卫）。归档行不读：服务面把归档视同不存在（读也抛）。 */
  const archived = state.status === "ready" && state.read?.workItem.archivedAt !== undefined;
  const reactions = useWorkItemReactionRows({
    target,
    workItemId: archived ? null : workItemId,
  });

  /* 点击外部关闭（纪律 3）：面板之外的任何一次按下即关。用 `contains` 判内外（不拼选择器、
     不比较坐标）；面板内的事件（含内部滚动/选择文本）不关。 */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node) === true) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const view = workItemPeekView(state, workItemId);
  return (
    <aside
      ref={panelRef}
      data-testid="work-item-peek"
      aria-label={t("squad.workItems.peek.title")}
      className={cn(
        "flex w-80 shrink-0 flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-xs text-foreground-subtlest">
          {t("squad.workItems.peek.title")}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="work-item-peek-open-detail"
            onClick={onOpenDetail}
          >
            {t("squad.workItems.peek.openDetail")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="work-item-peek-close"
            aria-label={t("squad.workItems.peek.close")}
            onClick={onClose}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </span>
      </div>
      {view.kind === "loading" ? (
        <p data-testid="work-item-peek-loading" className="text-ui-sm text-foreground-subtlest">
          {t("squad.workItemDetail.loading")}
        </p>
      ) : view.kind === "failed" ? (
        <Alert variant="destructive" data-testid="work-item-peek-failed">
          <AlertTitle>{t("squad.workItemDetail.loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="text-ui-xs">{view.error}</span>
            <Button size="sm" variant="outline" onClick={reload}>
              {t("squad.workItemDetail.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : view.kind === "missing" ? (
        <p data-testid="work-item-peek-missing" className="text-ui-sm text-foreground-subtlest">
          {t("squad.workItemDetail.notFound")}
        </p>
      ) : (
        <WorkItemPeekContent
          read={view.read}
          snapshot={snapshot}
          reactionRows={reactions.rows}
          reactionsFailure={reactions.failure}
        />
      )}
    </aside>
  );
}

/**
 * 面板**内容**（有内容那一支的纯呈现）：概览 + 属性带 + 标签 + 自定义属性 + 最近活动摘要。
 *
 * 与详情页概览（`WorkItemDetailOverview`）的关系：**同一份词汇、不同的面** —— identifier / 状态 /
 * 优先级 / 指派 / 起止日期 / 创建人 / 标签 chip 全部走既有单源组件与纯函数（谁也不自带第二份
 * 格式化：日期尤其，`YYYY-MM-DD` 一经时刻换算就静默差一天）。
 *
 * 与详情页概览的**刻意差异**（轻量速览的取舍，登记在交付报告）：不做正文展开、不做属性编辑器、
 * 不截断标签；活动只画**最近 N 条**（完整时间线在详情页）。
 */
export function WorkItemPeekContent({
  read,
  snapshot,
  reactionRows,
  reactionsFailure,
}: {
  /** 协作读模型（`workItemPeekView` 的 `ready` 支带回的同一条本体）。 */
  read: WorkItemCollaborationRead;
  /** 名册（只用于指派显示）。 */
  snapshot: SquadSnapshot;
  /** 本工作项的反应行（宿主经 `useWorkItemReactionRows` 读回；**缺省/`null` = 还没读到**）。 */
  reactionRows?: WorkItemReactionRows | null;
  /** 反应读失败的原因（原样带出）；缺省 = 没失败。 */
  reactionsFailure?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const workItem = read.workItem;
  /* 呈现判据全在纯函数里（`workItemPropertiesViewModel` / `workItemsViewModel`）：本层只负责画与不画。 */
  const identifierText = workItemIdentifierText(workItem.identifierSeq);
  const startDateText = workItemDateText(workItem.startDate);
  const dueDateText = workItemDateText(workItem.dueDate);
  const creatorText = workItemCreatorText(workItem.creator);
  const hasAttributeRow = startDateText !== null || dueDateText !== null || creatorText !== null;
  /* `null` = 指派给当前用户；由本地化文案补上（与行/详情概览同一份口径）。 */
  const assigneeLabel =
    workItemDetailAssigneeLabel(workItem, snapshot) ?? t("squad.common.assignee.user");
  const activityLines = workItemPeekActivityLines({
    comments: read.comments,
    activities: read.activities,
    decisions: read.decisions,
  });
  const properties = Object.entries(workItem.properties);
  return (
    <div className="flex flex-col gap-3">
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
          {identifierText === null ? null : (
            <span
              className="font-mono text-foreground-subtlest"
              data-testid="work-item-peek-identifier"
            >
              {identifierText}
            </span>
          )}
          <span>{t(workItemStatusMessageId(workItem.status))}</span>
          <WorkItemPriorityBadge priority={workItem.priority} testId="work-item-peek-priority" />
          <span className="flex items-center gap-1.5" data-testid="work-item-peek-assignee">
            <AssigneeMarker snapshot={snapshot} assignee={workItem.assignee} />
            {assigneeLabel}
          </span>
          {workItem.archivedAt === undefined ? null : <span>{t("squad.common.archived")}</span>}
        </span>
        <h2
          className="break-words text-ui-base font-medium text-foreground"
          data-testid="work-item-peek-title"
        >
          {workItem.title}
        </h2>
      </span>
      {/* 属性带（起止日期 + 创建人）：**有值才画**（空值由纯函数返回 null 决定，不在 JSX 里另判）。 */}
      {!hasAttributeRow ? null : (
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs"
          data-testid="work-item-peek-attributes"
        >
          {startDateText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-peek-start-date">
              <span className="text-foreground-subtle">{t("squad.workItems.startDate")}</span>
              <span className="text-foreground-subtlest">{startDateText}</span>
            </span>
          )}
          {dueDateText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-peek-due-date">
              <span className="text-foreground-subtle">{t("squad.workItems.dueDate")}</span>
              <span className="text-foreground-subtlest">{dueDateText}</span>
            </span>
          )}
          {creatorText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-peek-creator">
              <span className="text-foreground-subtle">{t("squad.workItems.creator")}</span>
              <span className="text-foreground-subtlest">
                {t(workItemCreatorKindMessageId(workItem.creator!.kind))}·{creatorText}
              </span>
            </span>
          )}
        </span>
      )}
      {/* 标签：**全量**（行的 3 枚上限是行的约束）；空标签给一句「无标签」而不是整块消失。 */}
      <span className="flex flex-wrap items-center gap-1" data-testid="work-item-peek-labels">
        <span className="text-ui-xs text-foreground-subtle">
          {t("squad.workItemDetail.overview.labels")}
        </span>
        {workItem.labels.length === 0 ? (
          <span className="text-ui-xs text-foreground-subtlest">
            {t("squad.workItemDetail.overview.labelsEmpty")}
          </span>
        ) : (
          workItem.labels.map((label) => <WorkItemLabelChip key={label} label={label} />)
        )}
      </span>
      {/* 表情回应（阶段三 · T-P3-R5u）：**只读**挂在标签块之后（卡面口径）。
          三条判据：①0 反应 / 还没读到 ⇒ 整块不渲染（速览不摆空壳，也不预判「没有人反应」）；
          ②只画 chip、**不传 `onToggle`** —— 组件本身就是无按钮形态，写不出去；
          ③读失败给一行原因（键 + 服务面原文）：不把「读不到」说成「没有人反应」。 */}
      {reactionRows === undefined || reactionRows === null ? (
        reactionsFailure === undefined || reactionsFailure === null ? null : (
          <span
            data-testid="work-item-peek-reactions-failure"
            className="flex flex-col gap-0.5 text-ui-xs"
          >
            <span className="text-foreground-subtle">
              {t("squad.workItemDetail.reactions.readFailed")}
            </span>
            <span className="break-words text-foreground-subtlest">{reactionsFailure}</span>
          </span>
        )
      ) : reactionRows.length === 0 ? null : (
        <WorkItemReactionChips
          groups={workItemReactionGroups({ rows: reactionRows, viewerActor: read.viewerActor })}
        />
      )}
      {/* 自定义属性：只读呈现（零写者字段不给编辑器）；没有属性 ⇒ 整块不渲染。 */}
      {properties.length === 0 ? null : (
        <span
          className="flex flex-wrap items-center gap-2 text-ui-xs"
          data-testid="work-item-peek-properties"
        >
          <span className="text-foreground-subtle">
            {t("squad.workItemDetail.overview.properties")}
          </span>
          {properties.map(([key, value]) => (
            <span
              key={key}
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
            >
              <span className="text-foreground-subtle">{key}</span>
              <span className="text-foreground-subtlest">{workItemPropertyValueText(value)}</span>
            </span>
          ))}
        </span>
      )}
      <section className="flex flex-col gap-1" data-testid="work-item-peek-activity">
        <span className="text-ui-xs text-foreground-subtle">
          {t("squad.workItems.peek.activity")}
        </span>
        {activityLines.length === 0 ? (
          <span
            className="text-ui-xs text-foreground-subtlest"
            data-testid="work-item-peek-activity-empty"
          >
            {t("squad.workItemDetail.activity.empty")}
          </span>
        ) : (
          <ol className="flex flex-col gap-1">
            {activityLines.map((line) => (
              <li
                key={line.key}
                data-testid="work-item-peek-activity-line"
                className="flex flex-wrap items-baseline gap-1.5 text-ui-xs"
              >
                {line.actorLabel === null ? null : (
                  <span className="text-foreground-subtle">{line.actorLabel}</span>
                )}
                <span className="text-foreground-subtle">{t(line.messageId)}</span>
                {line.text === null ? null : (
                  <span className="line-clamp-2 min-w-0 break-words text-foreground-subtlest">
                    {line.text}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
