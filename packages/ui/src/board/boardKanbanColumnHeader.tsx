/**
 * 看板列头（#33 → #89/A4-3 自 BoardKanbanView 拆出）：普通列与可折叠列（已完成）共用同一份
 * 列头内容；列名带 `data-board-column-title` 锚点（评审 #33-S2：测试与定位不绑 CSS 类）。
 * 拆文件理由同 `boardFoldParts`（行数上限；组件语义与锚点不变）。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBoardStageText } from "./boardPresentation.js";
import type { BoardKanbanColumn } from "./boardViewsViewModel.js";

/**
 * 列头内容（列名 = 段位词条 + 计数）：普通列与可折叠列（已完成）共用同一份。
 * 列名带 `data-board-column-title` 锚点（评审 #33-S2：测试与定位不绑 CSS 类）。
 */
function BoardKanbanHeaderContent({ column }: { column: BoardKanbanColumn }) {
  const { intl } = useZCodeIntl();
  const count = column.nodes.length + (column.interview?.nodes.length ?? 0);
  return (
    <>
      <span
        data-board-column-title=""
        className="min-w-0 flex-1 truncate text-ui-sm font-semibold text-foreground"
      >
        {formatBoardStageText(column.stage, intl.formatMessage)}
      </span>
      <span
        data-board-column-count={count}
        className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle"
      >
        {count}
      </span>
    </>
  );
}

export function BoardKanbanHeader({ column }: { column: BoardKanbanColumn }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1">
      <BoardKanbanHeaderContent column={column} />
    </div>
  );
}

/**
 * 可折叠列的列头（评审 #35-S1 二轮）：状态化按钮，`aria-expanded` 表达展开态；
 * 缺省 handler 时按钮不折叠（视图仍可只读展示，与卡片打开态的退化口径一致）。
 */
export function BoardKanbanToggleHeader({
  column,
  expanded,
  onToggle,
}: {
  column: BoardKanbanColumn;
  expanded: boolean;
  onToggle?: (expanded: boolean) => void;
}) {
  return (
    <button
      type="button"
      data-board-column-toggle={column.stage}
      aria-expanded={expanded}
      onClick={() => onToggle?.(!expanded)}
      className="flex items-center gap-1.5 px-1.5 py-1 text-left"
    >
      <BoardKanbanHeaderContent column={column} />
    </button>
  );
}
