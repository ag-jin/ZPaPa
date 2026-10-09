import type { WorkItemCollaborationRead } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemLabelChip, WorkItemPriorityBadge } from "./WorkItemRows.js";
import { WorkItemReactions } from "./WorkItemReactions.js";
import {
  workItemCreatorKindMessageId,
  workItemCreatorText,
  workItemDateText,
  workItemIdentifierText,
} from "./workItemPropertiesViewModel.js";
import { workItemPropertyValueText, workItemStatusMessageId } from "./workItemsViewModel.js";

/* 工作项详情页**概览区**（T-P1-R2 从 WorkItemDetailPage.tsx 原样搬出：结构、文案、testid 逐字不变）。

   为什么独立成模块：页面是**接线中心**（三区挂载 + 「一次动作一个执行器」runCollaborationAction），
   阶段一还要往属性区加字段（优先级 / 起始-截止 / 创建人 / identifier），概览的呈现细节不该继续
   挤压页面的行数余量（此前已 398/400 靠豁免）。

   三条纪律（与 WorkItemDeliverablesSection / WorkItemPullRequestsSection 同款）：
   ① **纯呈现**：不取服务、不写任何东西 —— 写入只有页面那条执行器一条路
      （**唯一例外**是本轮挂上来的 `WorkItemReactions`：它是**自足**的（自带读/写通路与身份
      取法），概览只把 `workItem` 交给它 —— 页面冻结（399/400）拿不到页面的 target 与读面的
      `viewerActor`，详见该模块的文件头与交付报告的「viewer 身份取法」一段）；
   ② **状态所有者不变**：展开态仍由页面持有，这里只收受控值 `bodyExpanded` + `onToggleBody`；
   ③ **来源不换**：标签 / 自定义属性 / 正文都取自 `state.read.workItem`（协作读模型含**归档行**；
      改从快照取会让归档项的标签凭空消失，且不报错）。 */

export function WorkItemDetailOverview({
  workItem,
  assigneeLabel,
  bodyExpanded,
  onToggleBody,
}: {
  /** 协作读模型带回的工作项本体（`state.read.workItem`；不由本模块取数）。 */
  workItem: WorkItemCollaborationRead["workItem"];
  /** 指派显示文案（名册解析的兜底已在页面算好：本模块不碰名册）。 */
  assigneeLabel: string;
  /** 正文展开态（受控：状态属于页面）。 */
  bodyExpanded: boolean;
  /** 切换正文展开态（页面持有 setter）。 */
  onToggleBody: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  /* 四族新字段的呈现判据全在纯函数里（`workItemPropertiesViewModel`）：identifier 文本
     （前缀不入库，**唯一**拼接点）、优先级文案、日期逐字、创建人回落。组件只负责画与不画。 */
  const identifierText = workItemIdentifierText(workItem);
  const startDateText = workItemDateText(workItem.startDate);
  const dueDateText = workItemDateText(workItem.dueDate);
  const creatorText = workItemCreatorText(workItem.creator);
  /* 密度：无值项**整块不渲染**（空行是噪音；存量行没有这些事实是合法状态，不是故障）。 */
  const hasAttributeRow = startDateText !== null || dueDateText !== null || creatorText !== null;
  return (
    <section
      data-testid="work-item-detail-overview"
      className="flex flex-col gap-2 rounded-xl border border-card-border bg-card px-4 py-4"
    >
      <span className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
        {/* identifier（Q6：前缀不入库）走等宽字体（DESIGN：标识符用 font-mono），放在状态**之前**
            —— 它是这条记录的编号，最像「句首」。 */}
        {identifierText === null ? null : (
          <span
            className="font-mono text-foreground-subtlest"
            data-testid="work-item-detail-identifier"
          >
            {identifierText}
          </span>
        )}
        <span>{t(workItemStatusMessageId(workItem.status))}</span>
        {/* 优先级徽标：**中性**外观，与看板行共用同一个组件（DESIGN：语义色只编码状态；
            借用 success/destructive 让某一档「看起来更响」会把档位读成故障）。
            未设置（NULL）⇒ 组件返回 null，也不写「未设置」。 */}
        <WorkItemPriorityBadge priority={workItem.priority} testId="work-item-detail-priority" />
        <span>{assigneeLabel}</span>
        {workItem.archivedAt === undefined ? null : <span>{t("squad.common.archived")}</span>}
      </span>
      <h1 className="text-ui-lg font-medium text-foreground">{workItem.title}</h1>
      {/* 属性带（起止日期 + 创建人）：一行内横排、随宽度换行（`flex-wrap`，窄至 400px 不溢出）。
          每一项都是「有值才画」——空值由**同一个**判据（纯函数返回 null）决定，不在 JSX 里另判。 */}
      {!hasAttributeRow ? null : (
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs"
          data-testid="work-item-detail-attributes"
        >
          {startDateText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-detail-start-date">
              <span className="text-foreground-subtle">{t("squad.workItems.startDate")}</span>
              <span className="text-foreground-subtlest">{startDateText}</span>
            </span>
          )}
          {dueDateText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-detail-due-date">
              <span className="text-foreground-subtle">{t("squad.workItems.dueDate")}</span>
              <span className="text-foreground-subtlest">{dueDateText}</span>
            </span>
          )}
          {creatorText === null ? null : (
            <span className="flex items-center gap-1" data-testid="work-item-detail-creator">
              <span className="text-foreground-subtle">{t("squad.workItems.creator")}</span>
              <span className="text-foreground-subtlest">
                {t(workItemCreatorKindMessageId(workItem.creator!.kind))}·{creatorText}
              </span>
            </span>
          )}
        </span>
      )}
      {/* 标签（#11 v1）：**全量**呈现、不截断（看板行的 3 个上限是行的约束，不是这条记录的约束），
            取自 `state.read.workItem`（协作读模型含归档行 —— 用快照的话归档项的标签会凭空消失）。
            空标签给一句「无标签」而不是整块消失：字段是这一轮新加的，什么都没有会被读成「页面坏了」。 */}
      <span className="flex flex-wrap items-center gap-1" data-testid="work-item-detail-labels">
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
      {/* 自定义属性（#11 v1）：**只读**呈现（零写者字段不做编辑器 —— 值域没有类型契约，
            先造编辑器就是替设计补一个没裁过的决定）。非字符串值原样显示 JSON 文本；
            没有属性则整块不渲染（空行是噪音，与 MCP 徽标同一裁定）。 */}
      {Object.entries(workItem.properties).length === 0 ? null : (
        <span
          className="flex flex-wrap items-center gap-2 text-ui-xs"
          data-testid="work-item-detail-properties"
        >
          <span className="text-foreground-subtle">
            {t("squad.workItemDetail.overview.properties")}
          </span>
          {Object.entries(workItem.properties).map(([key, value]) => (
            <span
              key={key}
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
              data-testid="work-item-detail-property"
            >
              <span className="text-foreground-subtle">{key}</span>
              <span className="text-foreground-subtlest">{workItemPropertyValueText(value)}</span>
            </span>
          ))}
        </span>
      )}
      {workItem.body.trim().length === 0 ? null : (
        <>
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            aria-expanded={bodyExpanded}
            data-testid="work-item-detail-body-toggle"
            onClick={onToggleBody}
          >
            {bodyExpanded
              ? t("squad.workItemDetail.overview.bodyHide")
              : t("squad.workItemDetail.overview.bodyShow")}
          </Button>
          {bodyExpanded ? (
            <p className="text-ui-base text-foreground-subtle whitespace-pre-wrap break-words">
              {workItem.body}
            </p>
          ) : null}
        </>
      )}
      {/* 表情回应（阶段三 · T-P3-R5u）：**概览尾部固定一行**（multica 的 issue-detail 同位：
          描述块正下方）。本模块只把工作项本体交给它 —— 读/写通路、chips 与选择器都在那个自足
          模块里（`WorkItemReactions` 的文件头写明为什么它是自足的：页面是冻结的 399/400，
          概览拿不到读面的 `viewerActor`，身份由写返回学出）。首帧零字节由它保证
          （读没回来就不渲染：本区的逐字节搬件基线因此不受影响）。 */}
      <WorkItemReactions workItem={workItem} viewerActor={null} />
    </section>
  );
}
