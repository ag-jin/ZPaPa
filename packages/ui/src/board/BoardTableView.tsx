/**
 * 看板表格视图（卡 #34）：列可配置的表格，行点击 → 弹窗；
 * 卡 #46 / 规则书 v2（B4/B6）：**分组行（特性头 + 缩进子行，可折叠）** + 责任管线列
 * 当前执行者加粗变色（`currentAssignee`，A3 交叉推导）。
 * 卡 #168 / A4-1b：三层容器接线——epic/期次 = **两级 colSpan 组行**（表格无法嵌套
 * `<details>`/`<tbody>`；对齐 B §4.3 L-4a「两级 colSpan 组行，列配置不动」），组行头走
 * `BoardFeatureGroupHeaderContent` 的 `layer` 变体（与 tree/列表/看板同一单点零件）；容器归属走
 * `assembleBoardEpicContainers`（同一归组单点）。无归属分组行照旧平铺在前（AD-8）。
 *
 * 卡 #89 / A4-3：折叠默认态与记忆落三处——①epic/期次组行成为真折叠控件（`BoardFoldToggleButton`
 * 共享零件 + `aria-expanded`；折叠 = 子行条件渲染，不造假 affordance、不用 CSS 藏）；②稿层分组行
 * 默认态改用 B2 单点判据（已完成/已取消折叠）；③三处默认态都走 AD-5 递归单点
 * （`boardFoldState`：缺口展开 · 含活跃期次展开 · 全完成/全取消折叠），用户覆盖由宿主注入。
 *
 * 单一真源：消费契约 §13.5（默认列 + 列可配置）、§13.2 表格列（段位 / `lastRun` / `blockers`
 * 各格要求）、§3.3（最近执行四要素）、派发指令（行点击=打开弹窗；排序复用列表视图语义）。
 * 判据与单元格值全在纯函数层（`boardTableViewModel` / `boardViewsViewModel`），本组件只投影 + 回传意图。
 */
import { Fragment } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardListFilterControls } from "./BoardListFilterControls.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import { assembleBoardEpicContainers } from "./boardEpicContainers.js";
import {
  boardContainerFoldExpanded,
  boardEpicFoldId,
  boardFeatureFoldExpanded,
  boardPhaseFoldId,
  resolveBoardFoldOpen,
  type BoardFoldControls,
} from "./boardFoldState.js";
import { BoardTableEpicRow, BoardTablePhaseRow } from "./boardTableLayerRows.js";
import { BoardFoldToggleButton } from "./boardFoldParts.js";
import {
  BoardActiveRunBadge,
  BoardAssigneePipeline,
  BoardAttentionBadges,
  BoardBlockerBadge,
  BoardFeatureGroupHeaderContent,
  BoardNodeNumber,
  BoardStageBadge,
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
 * 主阅读列（#59 M1）：标题/状态是行内主读信息 → `text-ui-sm`；其余列是弱元数据
 * （号/段位徽章/责任管线/最近执行/时间戳/卡龄/受阻/缺口）→ `text-ui-xs`。
 * 字号不再由表根统一继承（DESIGN.md 禁止把主阅读信息压到最弱刻度）。
 */
function cellTextClass(key: BoardTableColumnKey): string {
  return key === "title" || key === "status" ? "text-ui-sm" : "text-ui-xs";
}

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
            cellTextClass(key),
            key === "title" && "max-w-[16rem] whitespace-normal",
            key === indentKey && rowIndentClass(node.depth),
          )}
        >
          {key === "assignees" ? (
            // 责任管线（#46 B6 / #54-1）：当前执行者加粗变色，done 弱化，下一接手人次强调。
            // 执行角色徽记（#59 M2）与管线同格：契约 §13.5 无独立 activeRun 列，执行角色经
            // 共用徽章零件呈现（与其余三视图同一零件），随「责任管线」列配置出现/消失。
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <BoardAssigneePipeline
                assignees={node.assignees}
                currentAssignee={node.currentAssignee}
                nextAssignee={node.nextAssignee}
              />
              {node.activeRun ? <BoardActiveRunBadge role={node.activeRun.role} /> : null}
            </span>
          ) : key === "no" ? (
            // 号列走共用编号零件（#46 B1 短形态 + data-board-node-id 锚点与其余视图一致）
            <BoardNodeNumber no={node.no} label={node.label} planCode={node.planCode} short />
          ) : key === "stage" ? (
            // 段位/受阻/缺口（#59 M2）：与树形/看板/列表同一组徽章零件，不再降为纯文本；
            // 各格独立装配 → 隐藏列不渲染对应徽章（列配置语义不丢）。
            <BoardStageBadge stage={node.stage} />
          ) : key === "blockers" ? (
            <BoardBlockerBadge count={node.blockers.length} />
          ) : key === "attention" ? (
            <BoardAttentionBadges attention={node.attention} lastRun={node.lastRun} />
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
  expanded,
  onToggle,
  onOpenCard,
  highlightCardId,
}: {
  group: BoardListGroup;
  columns: BoardTableColumnKey[];
  indentKey: BoardTableColumnKey | null;
  now: number;
  /** 展开态（默认态 + 用户覆盖已由调用方解析；#89/A4-3）。 */
  expanded: boolean;
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    group.feature.id,
    highlightCardId,
  );
  return (
    <tbody data-board-table-group={group.feature.id}>
      <tr className="border-b border-border/40 bg-surface/50">
        <td colSpan={columns.length} className="px-2 py-1">
          <div className="flex min-w-0 items-center gap-2">
            <BoardFoldToggleButton
              foldId={group.feature.id}
              name={group.feature.title}
              expanded={expanded}
              {...(onToggle ? { onToggle } : {})}
            />
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
                cardCount={group.totalCards}
              />
            </div>
          </div>
        </td>
      </tr>
      {expanded
        ? group.nodes.map((node) => (
            <BoardTableRow
              key={node.id}
              node={node}
              columns={columns}
              indentKey={indentKey}
              now={now}
              {...(onOpenCard ? { onOpenCard } : {})}
              highlightCardId={highlightCardId}
            />
          ))
        : null}
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
  /**
   * 折叠默认态的用户覆盖与回传（#89/A4-3；宿主持有并做会话记忆）：稿层分组行 + epic/期次层组行
   * 共用一份。缺省 = 只读渲染，按默认态（AD-5 单点规则）。
   */
  fold?: BoardFoldControls;
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
  fold,
  onOpenCard,
  highlightCardId = null,
}: BoardTableViewProps) {
  const { intl } = useZCodeIntl();
  const groups = buildBoardTableGroups(board, boardListControlsToQuery(controls));
  // 三层容器装配（#168 单点）：无归属分组行平铺在前（AD-8），epic/期次 = 两级 colSpan 组行。
  const containers = assembleBoardEpicContainers(board, groups, (group) => group.feature.id);
  const visibleColumns = visibleBoardTableColumns(columns);
  const indentKey = visibleColumns[0] ?? null;
  const ageBase = now ?? Date.now();
  // 折叠态解析单点（#89/A4-3）：默认态 = AD-5 规则（缺口/活跃展开、全终态折叠），用户覆盖优先。
  const resolveOpen = (foldId: string, defaultExpanded: boolean): boolean =>
    fold ? resolveBoardFoldOpen(fold.state, foldId, defaultExpanded) : defaultExpanded;
  const toggle = fold?.onToggle;
  /** 稿层分组行（既有机制）：默认态走 B2 判据单点。 */
  const renderGroup = (group: BoardListGroup) => (
    <BoardTableGroup
      key={group.feature.id}
      group={group}
      columns={visibleColumns}
      indentKey={indentKey}
      now={ageBase}
      expanded={resolveOpen(group.feature.id, boardFeatureFoldExpanded(group.feature))}
      {...(toggle ? { onToggle: toggle } : {})}
      {...(onOpenCard ? { onOpenCard } : {})}
      highlightCardId={highlightCardId}
    />
  );
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
          <table data-board-table="" className="w-full border-collapse">
            <thead>
              <tr>
                {visibleColumns.map((key) => (
                  <th key={key} data-board-column-header={key} className={HEADER_CLASS}>
                    {intl.formatMessage({ id: BOARD_TABLE_COLUMN_MESSAGE_IDS[key] })}
                  </th>
                ))}
              </tr>
            </thead>
            {containers.ungrouped.map((group) => renderGroup(group))}
            {containers.epics.map((container) => {
              // 层折叠 = 子行条件渲染（表格无法嵌套 `<details>`）：折叠的 epic 不渲染期次行，
              // 折叠的期次不渲染成员分组行。默认态按本层实际承载成员算（AD-5 单点规则）。
              const epicOpen = resolveOpen(
                boardEpicFoldId(container.epic.code),
                boardContainerFoldExpanded(container.items.map((group) => group.feature)),
              );
              return (
                <Fragment key={container.epic.code}>
                  <BoardTableEpicRow
                    container={container}
                    columnCount={visibleColumns.length}
                    expanded={epicOpen}
                    {...(toggle ? { onToggle: toggle } : {})}
                  />
                  {epicOpen
                    ? container.phases.map((phase) => {
                        const phaseOpen = resolveOpen(
                          boardPhaseFoldId(container.epic.code, phase.phase),
                          boardContainerFoldExpanded(phase.items.map((group) => group.feature)),
                        );
                        return (
                          <Fragment key={phase.name}>
                            <BoardTablePhaseRow
                              phase={phase}
                              epicCode={container.epic.code}
                              columnCount={visibleColumns.length}
                              expanded={phaseOpen}
                              {...(toggle ? { onToggle: toggle } : {})}
                            />
                            {phaseOpen ? phase.items.map((group) => renderGroup(group)) : null}
                          </Fragment>
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
          </table>
        )}
      </div>
    </div>
  );
}
