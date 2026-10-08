import type { ReactNode } from "react";
import type { SquadSnapshot } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";
import {
  WorkItemLabelChip,
  WorkItemLabelMoreChip,
  WorkItemPriorityBadge,
  WorkItemRowOpenDetailOverlay,
} from "./WorkItemRows.js";
import { AssigneeMarker } from "./workItemRowParts.js";
import {
  workItemCreatorText,
  workItemDateText,
  workItemIdentifierText,
} from "./workItemPropertiesViewModel.js";
import type { WorkItemSurfaceColumnKey } from "./workItemSurfaceViewModel.js";
import {
  workItemLabelChips,
  workItemStatusMessageId,
  type WorkItemBoardRow,
} from "./workItemsViewModel.js";

/* table 视图的**单元格内容**（阶段二 · T-P2-R3）：只读呈现，逐格复用既有单源。
 *
 * 为什么独立成模块（而不是塞进 `WorkItemRows` 或 `WorkItemTableView`）：
 * · 行模块已到 `max-lines` 余量的边缘（400 有效行）——单元格是**列投影**，不是行渲染；
 * · 行元素 / 行锚点 / 聚焦注册 / 动作簇**仍只在 `WorkItemRows`**（本模块不写
 *   `data-work-item-id`、不注册 DOM、不加时间线）：本模块产出的只是 `<td>` 的内容，
 *   由那个唯一的行组件放进它的 `<tr>` 里。
 *
 * 三条纪律：
 * ① **单源**：identifier / 状态 / 优先级 / 指派 / 标签 / 起止 / 创建人全部走既有纯函数与
 *   组件（`workItemIdentifierText` / `workItemStatusMessageId` / `WorkItemPriorityBadge` /
 *    `resolveAssigneeName` / `workItemLabelChips` + `WorkItemLabelChip` / `workItemDateText` /
 *    `workItemCreatorText`）—— 单元格里不许出现第二份格式化（日期尤其：`YYYY-MM-DD`
 *    一经时刻换算就静默差一天）；
 * ② **只读**：单元格不给行内编辑入口（标题/优先级的行内编辑器是行内编辑层的，本阶段不给
 *    单元格版入口），行的写入口仍是动作列上的既有按钮（编辑对话框 / 改派 / 放弃整批）；
 * ③ **未设置 ⇒ 空单元格**：不给「未知 / 未设置」这类占位说法（没有事实 ≠ 有一个空事实）。 */

/** 数据格的样式：与动作格同一套分隔线 / 高度 token（44px 可点目标下限由 `h-11` 给）。 */
const TABLE_CELL_CLASSNAME =
  "h-11 border-b border-border px-3 py-1.5 align-middle text-ui-xs text-foreground-subtle";
/** 标题格：行的身份（主信息用正文层级），缩进落在它身上（`<tr>` 不接受 padding）。 */
const TABLE_TITLE_CELL_CLASSNAME =
  "relative h-11 border-b border-border px-3 py-1.5 align-middle text-ui-base text-foreground";
/* 动作格：与数据格同一套分隔线 / 内边距 / 高度 token（行级入口的宿主格）。
   「格子怎么排」属于表格视图；**动作簇本身**由行模块传进来（见 `actions`），不在这里重写。 */
const TABLE_ACTIONS_CELL_CLASSNAME = "h-11 border-b border-border px-3 py-1.5 align-middle";
/* 勾选格（阶段二 · T-P2-R5）：同样一套分隔线 / 高度 token（44px 行高不下调）；
   列的宽度交给内容（一枚 16px 的勾选件 + 两侧内边距），不写死宽度。 */
const TABLE_SELECT_CELL_CLASSNAME = "h-11 border-b border-border px-3 py-1.5 align-middle";

/**
 * 一行在表格里的内容：（批量模式下的）勾选格 + 标题格 + 按**可见列**顺序的数据格 + 动作格。
 *
 * `columns` 由视图给（= `visibleWorkItemColumns(surface.columns)` 的结论）：本模块不判显隐 ——
 * 判据在 R1 的纯函数里，这里只按给定顺序渲染。`actions` 是行模块交进来的**动作簇**
 * （编辑 / 改派 / 放弃整批 / 时间线）：本模块只给它一个格子，不重写按钮。
 * `select`（阶段二 · T-P2-R5）同理：**行模块产出的勾选件**，本模块只给它首列那个格子
 * （`null` = 未进入批量模式 ⇒ 整格不渲染，不留一个空列）。
 */
export function WorkItemTableRowCells({
  row,
  columns,
  snapshot,
  onOpenWorkItemDetail,
  actions,
  select,
}: {
  row: WorkItemBoardRow;
  columns: readonly WorkItemSurfaceColumnKey[];
  snapshot: SquadSnapshot;
  onOpenWorkItemDetail: (workItemId: string) => void;
  /** 行级动作簇（行模块的单点实现，原样放进动作格）。 */
  actions: ReactNode;
  /** 行级勾选件（行模块的单点实现，原样放进首列格）；`null` = 批量模式未开启。 */
  select: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const { item, depth } = row;
  /* 每格的值先经单源纯函数（未设置 ⇒ null ⇒ 空单元格）。 */
  const identifierText = workItemIdentifierText(item.identifierSeq);
  const startDateText = workItemDateText(item.startDate);
  const dueDateText = workItemDateText(item.dueDate);
  const creatorText = workItemCreatorText(item.creator);
  const labelChips = workItemLabelChips(item.labels);
  /* `null` = 指派给当前用户；由本地化文案补上（与行同一份口径，纯函数不碰 i18n）。 */
  const assigneeName =
    resolveAssigneeName(snapshot, item.assignee) ?? t("squad.common.assignee.user");

  const cellValue = (column: WorkItemSurfaceColumnKey): ReactNode => {
    switch (column) {
      case "identifier":
        return identifierText === null ? null : (
          <span className="font-mono text-foreground-subtlest">{identifierText}</span>
        );
      case "status":
        return t(workItemStatusMessageId(item.status));
      case "priority":
        return <WorkItemPriorityBadge priority={item.priority} testId="work-item-table-priority" />;
      case "assignee":
        return (
          <span className="inline-flex items-center gap-1.5">
            <AssigneeMarker snapshot={snapshot} assignee={item.assignee} />
            {assigneeName}
          </span>
        );
      case "labels":
        return labelChips.shown.length === 0 ? null : (
          <span className="flex flex-wrap items-center gap-1">
            {labelChips.shown.map((label) => (
              <WorkItemLabelChip key={label} label={label} />
            ))}
            {labelChips.hiddenCount > 0 ? (
              <WorkItemLabelMoreChip hiddenCount={labelChips.hiddenCount} />
            ) : null}
          </span>
        );
      case "startDate":
        return startDateText;
      case "dueDate":
        return dueDateText;
      case "creator":
        return creatorText;
    }
  };

  return (
    <>
      {/* 勾选格：批量模式下是**首列**（与表头的 `data-column="select"` 对应）；未进入批量模式时
          连这个 `<td>` 都不渲染（空 `<td>` 会占一整列并把列对齐改掉）。 */}
      {select === null ? null : (
        <td data-column="select" className={TABLE_SELECT_CELL_CLASSNAME}>
          {select}
        </td>
      )}
      <td
        data-column="title"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={TABLE_TITLE_CELL_CLASSNAME}
      >
        <span className="relative flex items-center gap-2">
          {/* 行级「打开详情」：与看板/列表**同一个**组件（透明覆盖层一处定义）。 */}
          <WorkItemRowOpenDetailOverlay
            title={item.title}
            onOpen={() => onOpenWorkItemDetail(item.id)}
          />
          <span className="pointer-events-none relative z-10 min-w-0 break-words">
            {item.title}
          </span>
        </span>
      </td>
      {columns.map((column) => (
        <td key={column} data-column={column} className={TABLE_CELL_CLASSNAME}>
          {cellValue(column)}
        </td>
      ))}
      <td data-column="actions" className={TABLE_ACTIONS_CELL_CLASSNAME}>
        <span className="flex items-center justify-end">{actions}</span>
      </td>
    </>
  );
}
