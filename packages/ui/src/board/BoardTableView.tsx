/**
 * 看板表格视图（卡 #34）：列可配置的表格，行点击 → 弹窗；
 * 卡 #46 / 规则书 v2（B4/B6）：**分组行（特性头 + 缩进子行，可折叠）** + 责任管线列
 * 当前执行者加粗变色（`currentAssignee`，A3 交叉推导）。
 *
 * 单一真源：消费契约 §13.5（默认列 + 列可配置）、§13.2 表格列（段位 / `lastRun` / `blockers`
 * 各格要求）、§3.3（最近执行四要素）、派发指令（行点击=打开弹窗；排序复用列表视图语义）。
 * 判据与单元格值全在纯函数层（`boardTableViewModel` / `boardViewsViewModel`），本组件只投影 + 回传意图。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardListFilterControls } from "./BoardListFilterControls.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import {
  BoardAssigneePipeline,
  BoardFeatureGroupHeaderContent,
  BoardNodeNumber,
} from "./boardNodeParts.js";
import {
  BOARD_TABLE_COLUMNS,
  BOARD_TABLE_COLUMN_MESSAGE_IDS,
  boardTableCellText,
  buildBoardTableGroups,
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  toggleBoardTableColumn,
  visibleBoardTableColumns,
  type BoardTableColumnKey,
  type BoardTableColumnVisibility,
} from "./boardTableViewModel.js";
import {
  boardListControlsToQuery,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardListGroup,
  type BoardViewNode,
} from "./boardViewsViewModel.js";
import type { BoardViewModel } from "./boardViewModel.js";

const CELL_CLASS = "whitespace-nowrap px-2 py-1.5 align-top text-foreground";
const HEADER_CLASS =
  "whitespace-nowrap px-2 py-1 text-left text-ui-xs font-medium text-foreground-subtle";

/**
 * 子行缩进（结构深度）：depth=1（分组下行）→ `pl-3`，其后每层再 +3 级距。
 * depth=0（特性行）不走这里——分组头不是行；`pl-0` 仅为越界防御
 * （评审 #46 S-5：注释与实现对齐，不承诺「首层不缩进」）。
 */
const ROW_INDENT_CLASSES = ["pl-0", "pl-3", "pl-6", "pl-9"] as const;

function rowIndentClass(depth: number): string {
  const index = Math.min(Math.max(depth, 0), ROW_INDENT_CLASSES.length - 1);
  return ROW_INDENT_CLASSES[index] ?? "pl-0";
}

/** 列配置（显示/隐藏）：闭集全覆盖的复选框列表，默认折叠（窄面板不抢版面）。 */
function BoardTableColumnConfig({
  columns,
  onChange,
}: {
  columns: BoardTableColumnVisibility;
  onChange: (columns: BoardTableColumnVisibility) => void;
}) {
  const { intl } = useZCodeIntl();
  const visibleCount = visibleBoardTableColumns(columns).length;
  return (
    <details data-board-column-config="" className="relative shrink-0">
      <summary className="cursor-pointer rounded-md px-1.5 py-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "board.table.columns" })}
        <span data-board-column-config-count={visibleCount} className="ml-1 tabular-nums">
          {visibleCount}/{BOARD_TABLE_COLUMNS.length}
        </span>
      </summary>
      {/* 列配置浮层 = 菜单 surface（DESIGN.md「Menus, Popovers, Dialogs」：bg-menu / p-1 /
          gap-0.5 / rounded-lg / border-popover-border / shadow-md）—— 评审 #34-S5 的 token 定性。 */}
      <div className="absolute left-0 z-30 mt-1 flex min-w-[10rem] flex-col gap-0.5 rounded-lg border border-popover-border bg-menu p-1 shadow-md">
        {BOARD_TABLE_COLUMNS.map((key) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 text-ui-xs">
            <input
              type="checkbox"
              data-board-column-toggle={key}
              checked={columns[key]}
              onChange={() => onChange(toggleBoardTableColumn(columns, key))}
              // 原生 checkbox 补尺寸/强调色（评审 #34-S4：密集面板里默认 13px 太小、各平台渲染不一）。
              className="size-3.5 shrink-0 accent-primary"
            />
            <span className="text-foreground">
              {intl.formatMessage({ id: BOARD_TABLE_COLUMN_MESSAGE_IDS[key] })}
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

function BoardTableRow({
  node,
  columns,
  indentKey,
  now,
  onOpenCard,
  highlightCardId,
}: {
  node: BoardViewNode;
  columns: BoardTableColumnKey[];
  /** 承载子行缩进的列（行内第一个可见列）。 */
  indentKey: BoardTableColumnKey | null;
  now: number;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    node.id,
    highlightCardId,
  );
  return (
    <tr
      data-board-card={node.id}
      data-board-indent={node.depth}
      {...highlightProps}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn("border-b border-border/40 hover:bg-surface-hover", highlightClassName)}
    >
      {columns.map((key) => (
        <td
          key={key}
          data-board-cell={key}
          className={cn(
            CELL_CLASS,
            key === "title" && "max-w-[16rem] whitespace-normal",
            key === indentKey && rowIndentClass(node.depth),
          )}
        >
          {key === "assignees" ? (
            // 责任管线（#46 B6 / #54-1）：当前执行者加粗变色，done 弱化，下一接手人次强调
            <BoardAssigneePipeline
              assignees={node.assignees}
              currentAssignee={node.currentAssignee}
              nextAssignee={node.nextAssignee}
            />
          ) : key === "no" ? (
            // 号列走共用编号零件（#46 B1 短形态 + data-board-node-id 锚点与其余视图一致）
            <BoardNodeNumber no={node.no} label={node.label} planCode={node.planCode} short />
          ) : (
            boardTableCellText(node, key, intl.formatMessage, now)
          )}
        </td>
      ))}
    </tr>
  );
}

function BoardTableGroup({
  group,
  columns,
  indentKey,
  now,
  collapsed,
  onToggleCollapsed,
  onOpenCard,
  highlightCardId,
}: {
  group: BoardListGroup;
  columns: BoardTableColumnKey[];
  indentKey: BoardTableColumnKey | null;
  now: number;
  collapsed: boolean;
  onToggleCollapsed?: (featureId: string, collapsed: boolean) => void;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    group.feature.id,
    highlightCardId,
  );
  return (
    <tbody data-board-table-group={group.feature.id}>
      <tr className="border-b border-border/40 bg-surface/50">
        <td colSpan={columns.length} className="px-2 py-1">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-board-group-toggle={group.feature.id}
              aria-expanded={!collapsed}
              // 可及名称（#55 S-3）：符号 ▸/▾ 不是名称——动作 + 特性名走词条，状态由 aria-expanded 表达。
              aria-label={intl.formatMessage(
                { id: collapsed ? "board.group.expand" : "board.group.collapse" },
                { name: group.feature.title },
              )}
              onClick={() => onToggleCollapsed?.(group.feature.id, !collapsed)}
              className="shrink-0 cursor-pointer rounded-sm px-1 text-ui-xs text-foreground-subtle"
            >
              {collapsed ? "▸" : "▾"}
            </button>
            <div
              data-board-card={group.feature.id}
              {...highlightProps}
              {...boardCardOpenProps({
                id: group.feature.id,
                ...(onOpenCard ? { onOpenCard } : {}),
                preventDefaultOnClick: true,
              })}
              className={cn("flex min-w-0 flex-1 items-center gap-2", highlightClassName)}
            >
              <BoardFeatureGroupHeaderContent
                feature={group.feature}
                cardCount={group.nodes.length}
              />
            </div>
          </div>
        </td>
      </tr>
      {collapsed
        ? null
        : group.nodes.map((node) => (
            <BoardTableRow
              key={node.id}
              node={node}
              columns={columns}
              indentKey={indentKey}
              now={now}
              {...(onOpenCard ? { onOpenCard } : {})}
              highlightCardId={highlightCardId}
            />
          ))}
    </tbody>
  );
}

export interface BoardTableViewProps {
  board: BoardViewModel;
  /** 过滤/排序：与列表视图**同一份**控件状态（`null` = 不筛；缺省 = 不筛 + 默认排序）。 */
  controls?: BoardListControls;
  onControlsChange?: (controls: BoardListControls) => void;
  /** 列可见性（宿主持有并做会话记忆）；缺省 = 契约默认列 + 卡龄全可见。 */
  columns?: BoardTableColumnVisibility;
  onColumnsChange?: (columns: BoardTableColumnVisibility) => void;
  /** 卡龄基准（毫秒）；缺省取渲染时刻。同一屏内所有行用同一个基准。 */
  now?: number;
  /** 折叠的分组（宿主持有：跳转揭示要先展开；缺省全部展开）。 */
  collapsedFeatureIds?: readonly string[];
  onToggleFeatureCollapsed?: (featureId: string, collapsed: boolean) => void;
  /** 行点击（打开弹窗）；缺省时表格退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该行带高亮锚点）。 */
  highlightCardId?: string | null;
}

export function BoardTableView({
  board,
  controls = EMPTY_BOARD_LIST_CONTROLS,
  onControlsChange,
  columns = DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  onColumnsChange,
  now,
  collapsedFeatureIds = [],
  onToggleFeatureCollapsed,
  onOpenCard,
  highlightCardId = null,
}: BoardTableViewProps) {
  const { intl } = useZCodeIntl();
  const groups = buildBoardTableGroups(board, boardListControlsToQuery(controls));
  const visibleColumns = visibleBoardTableColumns(columns);
  const indentKey = visibleColumns[0] ?? null;
  const ageBase = now ?? Date.now();
  const collapsed = new Set(collapsedFeatureIds);
  return (
    <div data-board-view="table" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/50 px-3 py-2">
        <BoardListFilterControls controls={controls} onChange={onControlsChange ?? (() => {})} />
        <BoardTableColumnConfig columns={columns} onChange={onColumnsChange ?? (() => {})} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {groups.length === 0 ? (
          <div data-board-table-empty="" className="px-1 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "board.list.empty" })}
          </div>
        ) : (
          <table data-board-table="" className="w-full border-collapse text-ui-xs">
            <thead>
              <tr>
                {visibleColumns.map((key) => (
                  <th key={key} data-board-column-header={key} className={HEADER_CLASS}>
                    {intl.formatMessage({ id: BOARD_TABLE_COLUMN_MESSAGE_IDS[key] })}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <BoardTableGroup
                key={group.feature.id}
                group={group}
                columns={visibleColumns}
                indentKey={indentKey}
                now={ageBase}
                collapsed={collapsed.has(group.feature.id)}
                {...(onToggleFeatureCollapsed
                  ? { onToggleCollapsed: onToggleFeatureCollapsed }
                  : {})}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            ))}
          </table>
        )}
      </div>
    </div>
  );
}
