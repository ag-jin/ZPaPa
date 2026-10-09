/**
 * 看板列表视图（卡 #33）：全卡平铺（不分特性组），过滤（段位/状态/缺口码）+ 排序（updatedAt 卡龄）。
 *
 * 单一真源：消费契约 §13.2「列表」列（行首段位徽章、attention 置顶排序、待合并/受阻角标）+
 * §3.5（排序：attention 置顶 + updatedAt 倒序；「最老未动」第二视角）。判据全在纯函数层
 * （`boardViewsViewModel`），本组件只投影 + 回传意图。
 */
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BoardAttentionBadges,
  BoardBlockerBadge,
  BoardDraftBadge,
  BoardNodeNumber,
  BoardStageBadge,
  BoardStatusDot,
} from "./boardNodeParts.js";
import {
  BOARD_ATTENTION_LABEL_MESSAGE_IDS,
  BOARD_STATUS_MESSAGE_IDS,
  BOARD_STAGE_MESSAGE_IDS,
  formatBoardActiveRunText,
} from "./boardPresentation.js";
import {
  BOARD_ATTENTION_CODES,
  BOARD_STATUS_VALUES,
  BOARD_STAGES,
  type BoardAttentionCode,
  type BoardStage,
  type BoardStatusValue,
  type BoardViewModel,
} from "./boardViewModel.js";
import {
  boardListControlsToQuery,
  buildBoardListRows,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewNode,
  type BoardViewSort,
} from "./boardViewsViewModel.js";

function BoardListRow({ node }: { node: BoardViewNode }) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-board-card={node.id}
      className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 行首段位徽章（§13.2 列表列）。 */}
        <BoardStageBadge stage={node.stage} />
        <BoardNodeNumber no={node.no} label={node.label} />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{node.title}</span>
        {node.draft ? <BoardDraftBadge /> : null}
        <BoardAttentionBadges attention={node.attention} lastRun={node.lastRun} />
        <BoardBlockerBadge count={node.blockerCount} />
        {node.activeRun ? (
          <Badge
            variant="secondary"
            data-board-active-run={node.activeRun.role}
            className="shrink-0"
          >
            {formatBoardActiveRunText(node.activeRun.role, intl.formatMessage)}
          </Badge>
        ) : null}
        <BoardStatusDot status={node.status} />
      </div>
      {node.stage === "已取消" && node.statusRule ? (
        // 取消原因（§13.2 列表列「已取消」行）：只在终态行展示，其余行不铺溯源噪声。
        <div data-board-status-rule="" className="truncate text-ui-xs text-foreground-subtle">
          {node.statusRule}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 最小化过滤行（「过滤 UI 最小化」）：三个闭集下拉（段位/状态/缺口码，各含「全部」）+ 排序下拉。
 * 取值即闭集成员，空串在 onChange 处归一到 null（判据在纯函数层，组件只回传意图）。
 */
function BoardListFilters({
  controls,
  onChange,
}: {
  controls: BoardListControls;
  onChange: (controls: BoardListControls) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const selectClass =
    "h-6 max-w-[8rem] rounded-md border border-border/50 bg-background px-1 text-ui-xs text-foreground";
  const labelClass = "flex items-center gap-1 text-ui-xs text-foreground-subtle";
  return (
    <div
      data-board-list-filters=""
      role="group"
      aria-label={t("board.list.filters")}
      className="flex flex-wrap items-center gap-1.5"
    >
      <label className={labelClass}>
        <span>{t("board.filter.stage")}</span>
        <select
          data-board-filter="stage"
          className={selectClass}
          value={controls.stage ?? ""}
          onChange={(event) =>
            onChange({ ...controls, stage: (event.target.value || null) as BoardStage | null })
          }
        >
          <option value="">{t("board.filter.all")}</option>
          {BOARD_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {t(BOARD_STAGE_MESSAGE_IDS[stage])}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>{t("board.filter.status")}</span>
        <select
          data-board-filter="status"
          className={selectClass}
          value={controls.status ?? ""}
          onChange={(event) =>
            onChange({
              ...controls,
              status: (event.target.value || null) as BoardStatusValue | null,
            })
          }
        >
          <option value="">{t("board.filter.all")}</option>
          {BOARD_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {t(BOARD_STATUS_MESSAGE_IDS[status])}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>{t("board.filter.attention")}</span>
        <select
          data-board-filter="attention"
          className={selectClass}
          value={controls.attention ?? ""}
          onChange={(event) =>
            onChange({
              ...controls,
              attention: (event.target.value || null) as BoardAttentionCode | null,
            })
          }
        >
          <option value="">{t("board.filter.all")}</option>
          {BOARD_ATTENTION_CODES.map((code) => (
            <option key={code} value={code}>
              {t(BOARD_ATTENTION_LABEL_MESSAGE_IDS[code])}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>{t("board.filter.sort")}</span>
        <select
          data-board-filter="sort"
          className={selectClass}
          value={controls.sort}
          onChange={(event) => onChange({ ...controls, sort: event.target.value as BoardViewSort })}
        >
          <option value="recent">{t("board.sort.recent")}</option>
          <option value="oldest">{t("board.sort.oldest")}</option>
        </select>
      </label>
    </div>
  );
}

export interface BoardListViewProps {
  board: BoardViewModel;
  controls?: BoardListControls;
  onControlsChange?: (controls: BoardListControls) => void;
}

export function BoardListView({
  board,
  controls = EMPTY_BOARD_LIST_CONTROLS,
  onControlsChange,
}: BoardListViewProps) {
  const { intl } = useZCodeIntl();
  const rows = buildBoardListRows(board, boardListControlsToQuery(controls));
  return (
    <div data-board-view="list" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/50 px-3 py-2">
        <BoardListFilters controls={controls} onChange={onControlsChange ?? (() => {})} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {rows.length === 0 ? (
          <div data-board-list-empty="" className="px-1 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "board.list.empty" })}
          </div>
        ) : (
          rows.map((node) => <BoardListRow key={node.id} node={node} />)
        )}
      </div>
    </div>
  );
}
