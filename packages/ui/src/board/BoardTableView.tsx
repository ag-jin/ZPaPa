/**
 * 看板表格视图（卡 #34）：列可配置的表格，行点击 → 弹窗。
 *
 * 单一真源：消费契约 §13.5（默认列 + 列可配置）、§13.2 表格列（段位 / `lastRun` / `blockers`
 * 各格要求）、§3.3（最近执行四要素）、派发指令（列 = 号/名称/段位/状态/最近执行/卡龄；
 * 行点击=打开弹窗；排序复用列表视图语义）。判据与单元格值全在纯函数层
 * （`boardTableViewModel`），本组件只投影 + 回传意图。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardListFilterControls } from "./BoardListFilterControls.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import {
  BOARD_TABLE_COLUMNS,
  BOARD_TABLE_COLUMN_MESSAGE_IDS,
  boardTableCellText,
  buildBoardTableRows,
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
  type BoardViewNode,
} from "./boardViewsViewModel.js";
import type { BoardViewModel } from "./boardViewModel.js";

const CELL_CLASS = "whitespace-nowrap px-2 py-1.5 align-top text-foreground";
const HEADER_CLASS =
  "whitespace-nowrap px-2 py-1 text-left text-ui-xs font-medium text-foreground-subtle";

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
      <div className="absolute left-0 z-30 mt-1 flex min-w-[10rem] flex-col gap-1 rounded-lg border border-popover-border bg-popover p-2 shadow-md">
        {BOARD_TABLE_COLUMNS.map((key) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 text-ui-xs">
            <input
              type="checkbox"
              data-board-column-toggle={key}
              checked={columns[key]}
              onChange={() => onChange(toggleBoardTableColumn(columns, key))}
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
  now,
  onOpenCard,
  highlightCardId,
}: {
  node: BoardViewNode;
  columns: BoardTableColumnKey[];
  now: number;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const highlighted = boardCardHighlightProps(node.id, highlightCardId);
  return (
    <tr
      data-board-card={node.id}
      {...highlighted}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn(
        "border-b border-border/40 hover:bg-surface-hover",
        highlighted["data-board-card-highlight"] ? "bg-warning/15" : null,
      )}
    >
      {columns.map((key) => {
        const text = boardTableCellText(node, key, intl.formatMessage, now);
        return (
          <td
            key={key}
            data-board-cell={key}
            className={cn(CELL_CLASS, key === "title" && "max-w-[16rem] whitespace-normal")}
          >
            {text}
          </td>
        );
      })}
    </tr>
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
  onOpenCard,
  highlightCardId = null,
}: BoardTableViewProps) {
  const { intl } = useZCodeIntl();
  const rows = buildBoardTableRows(board, boardListControlsToQuery(controls));
  const visibleColumns = visibleBoardTableColumns(columns);
  const ageBase = now ?? Date.now();
  return (
    <div data-board-view="table" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/50 px-3 py-2">
        <BoardListFilterControls controls={controls} onChange={onControlsChange ?? (() => {})} />
        <BoardTableColumnConfig columns={columns} onChange={onColumnsChange ?? (() => {})} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {rows.length === 0 ? (
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
            <tbody>
              {rows.map((node) => (
                <BoardTableRow
                  key={node.id}
                  node={node}
                  columns={visibleColumns}
                  now={ageBase}
                  {...(onOpenCard ? { onOpenCard } : {})}
                  highlightCardId={highlightCardId}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
