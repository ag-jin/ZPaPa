/**
 * 编排视图（`dispatch` 面，卡 #185）：把编排器逻辑呈现在看板面板——三区一目了然
 * 「接下来可以怎么打」：
 *   ① 可派清单（frontier rank 序扣在途/扣域占后的结论面；每行给接手位与文件域）；
 *   ② 阻塞归因（每张不可派卡一条：域被在途谁占 / blocked-by 谁——在途或未完成）；
 *   ③ 并发组（域不相交、受剩余槽位截断的可并发一路 + 槽位计数行）。
 *
 * 边界（消费契约 §13.6 同纪律；编译器字段提案 = `evidence/T185/schema-proposal.txt`）：
 * - 一切判据归判据权威 `next-dispatch.mjs`（编译器将来与 CLI 共用同一实现）；本组件**零编排判据**，
 *   成员/顺序/计数/域文本/号位全部直取 `boardDispatchViewModel` 的投影（照读，不重排不改判）；
 * - 缺 `dispatch` 段（旧编译器产物）→ 「未就绪 + 重编译」指向，不自行派生兜底（同指引面缺四段姿态）；
 * - 行与并发组成员均可点 → 既有卡片弹窗路由（`task:<no>` 锚点 + `boardCardOpenProps` 单点），
 *   不新造导航/状态。
 *
 * 入口形态取舍（卡文「指引面新增区块或独立视图，按信息密度定，报告成文取舍」）：编排信息量大
 * （三区 + 逐卡归因 + 域文本），故落**独立视图**（第六入口，模式 `dispatch`）——不把高密度信息
 * 塞进指引面首屏，也不改动既有五视图与弹窗内部（域边界纪律）。
 *
 * 视觉准入（itw-20261011-9003：「分区清晰、一扫可读优先」）：三区各自成节；行主文字 >= text-ui-base
 * （卡名/原因/域不缩档），区计数与槽位元数据走 text-ui-sm；窄面（容器 <24rem，`@max-sm`）行触摸
 * 命中区 >=44px，形态与指引面降级同一口径（几何变、字号档不变）。
 */
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardOpenProps } from "./boardCardInteraction.js";
import {
  BoardDispatchZone,
  BOARD_DISPATCH_ZONE_EMPTY_MESSAGE_IDS,
  BOARD_DISPATCH_ZONE_MESSAGE_IDS,
} from "./boardDispatchParts.js";
import {
  buildBoardDispatchSummary,
  type BoardDispatchBlockedRow,
  type BoardDispatchRow,
} from "./boardDispatchViewModel.js";
import { BoardNodeNumber, BOARD_COUNT_CHIP_CLASS } from "./boardNodeParts.js";
import type { BoardViewModel } from "./boardViewModel.js";

export interface BoardDispatchViewProps {
  board: BoardViewModel;
  /** 卡片打开路由（既有弹窗宿主状态；缺省 = 只读渲染，行不可点）。 */
  onOpenCard?: (id: string) => void;
}

/** 域文本（行二次信息）：已知域给「域：文件清单（来源）」；未知给不可猜的显式指引。 */
function useDomainText() {
  const { intl } = useZCodeIntl();
  return (row: BoardDispatchRow): string =>
    row.domainUnknown
      ? intl.formatMessage({ id: "board.dispatch.domainUnknown" })
      : intl.formatMessage(
          { id: "board.dispatch.domain" },
          { files: row.domain.files.join("、"), source: row.domain.source },
        );
}

/** 阻塞原因文案（结构化字段 → 词条；不复制 CLI 的汉化 evidence 文本，两语各自可读）。 */
function useBlockedReasonText() {
  const { intl } = useZCodeIntl();
  return (row: BoardDispatchBlockedRow): string => {
    if (row.kind === "domain") {
      const hit = row.detail[0];
      if (hit) {
        return intl.formatMessage(
          { id: "board.dispatch.domainOccupied" },
          { file: hit.file, occupant: hit.occupiedBy },
        );
      }
      return intl.formatMessage(
        { id: "board.dispatch.domainOccupiedNoFile" },
        { cards: row.by.join("、") },
      );
    }
    if (row.kind === "dependency") {
      const target = row.by[0];
      if (target === undefined) {
        return intl.formatMessage({ id: "board.dispatch.blockedByMissing" });
      }
      return row.targetInFlight
        ? intl.formatMessage({ id: "board.dispatch.blockedByInFlight" }, { target })
        : intl.formatMessage({ id: "board.dispatch.blockedByPending" }, { target });
    }
    // 未知归因类别（提案闭集外的值）：原样点名类别，不猜、不吞。
    return intl.formatMessage({ id: "board.dispatch.blockedByUnknown" }, { kind: row.kind });
  };
}

/** 卡片行骨架（可派行与阻塞归因行共用）：号 + 标题 + 二次信息行 + 既有弹窗路由。 */
function DispatchCardRow({
  row,
  anchor,
  secondary,
  tags,
  onOpenCard,
  children,
}: {
  row: { id: string; no: number; label: string | null; planCode: string | null; title: string };
  anchor: Record<string, string | number>;
  /** 二次信息（可派 = 域文本；阻塞 = 原因文本）：独立成行，截断防线进原生 title。 */
  secondary: { text: string; extra?: Record<string, string | number> };
  tags?: Record<string, string | number>;
  onOpenCard?: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <div
      data-board-card={row.id}
      {...anchor}
      {...tags}
      {...boardCardOpenProps({ id: row.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      // 触摸命中区（与指引面队列行同口径）：窄容器（`@max-sm` <24rem）下限高 44px。
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/50 bg-surface px-2.5 py-1.5 @max-sm:min-h-11 hover:bg-surface-hover"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <BoardNodeNumber no={row.no} label={row.label} planCode={row.planCode} short />
        <span title={row.title} className="min-w-0 flex-1 truncate text-ui-base text-foreground">
          {row.title}
        </span>
        {children}
      </div>
      <span
        {...secondary.extra}
        title={secondary.text}
        className="min-w-0 truncate text-ui-base text-foreground-subtle"
      >
        {secondary.text}
      </span>
    </div>
  );
}

export function BoardDispatchView({ board, onOpenCard }: BoardDispatchViewProps) {
  const { intl } = useZCodeIntl();
  const zoneTitle = (zone: keyof typeof BOARD_DISPATCH_ZONE_MESSAGE_IDS) =>
    intl.formatMessage({ id: BOARD_DISPATCH_ZONE_MESSAGE_IDS[zone] });
  const zoneEmpty = (zone: keyof typeof BOARD_DISPATCH_ZONE_EMPTY_MESSAGE_IDS) =>
    intl.formatMessage({ id: BOARD_DISPATCH_ZONE_EMPTY_MESSAGE_IDS[zone] });
  const domainText = useDomainText();
  const blockedReasonText = useBlockedReasonText();
  const summary = buildBoardDispatchSummary(board);

  if (summary.availability === "missing") {
    // 缺段（旧编译器产物/未重编译）：指名重编译——视图侧不自行派生兜底（契约 §13.6 同姿态）。
    return (
      <div
        data-board-view="dispatch"
        data-board-dispatch=""
        data-board-dispatch-state="missing"
        className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-3 pb-4"
      >
        <div
          data-board-dispatch-recompile=""
          role="status"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
        >
          {intl.formatMessage({ id: "board.dispatch.recompile" })}
        </div>
      </div>
    );
  }

  const capacityText =
    summary.capacity === null
      ? ""
      : intl.formatMessage(
          { id: "board.dispatch.capacity" },
          {
            capacity: summary.capacity,
            inFlight: summary.inFlightCount,
            slotsFree: summary.slotsFree,
          },
        );

  return (
    <div
      data-board-view="dispatch"
      data-board-dispatch=""
      data-board-dispatch-state="ready"
      // 窄面容条件上下文（与指引面同口径）：按面板可用宽判定降级，不用 viewport 媒体查询。
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-3 pb-4"
    >
      <BoardDispatchZone
        zone="dispatchable"
        title={zoneTitle("dispatchable")}
        count={summary.dispatchable.length}
        isEmpty={summary.dispatchable.length === 0}
        emptyText={
          // 空态分流（直读 summary.frontier）：前沿本就为空 vs 前沿被占/前置未完成。
          summary.frontierCount === 0
            ? intl.formatMessage({ id: "board.dispatch.empty.frontier" })
            : zoneEmpty("dispatchable")
        }
      >
        {summary.dispatchable.map((row) => (
          <DispatchCardRow
            key={row.id}
            row={row}
            anchor={{ "data-board-dispatch-row": row.no }}
            secondary={{
              text: domainText(row),
              extra: {
                "data-board-dispatch-domain": row.domain.files.join("、"),
                ...(row.domainUnknown ? { "data-board-dispatch-domain-unknown": row.no } : {}),
              },
            }}
            {...(onOpenCard ? { onOpenCard } : {})}
          >
            {row.nextAssignee !== null ? (
              // 处置指引（下一步接手位；与指引面队列行同词条同形态口径）。
              <span
                data-board-dispatch-next={row.nextAssignee}
                title={intl.formatMessage(
                  { id: "board.guide.queue.next" },
                  { role: row.nextAssignee },
                )}
                className="min-w-0 max-w-full truncate text-ui-base text-foreground-subtle"
              >
                {intl.formatMessage({ id: "board.guide.queue.next" }, { role: row.nextAssignee })}
              </span>
            ) : null}
          </DispatchCardRow>
        ))}
      </BoardDispatchZone>

      <BoardDispatchZone
        zone="blocked"
        title={zoneTitle("blocked")}
        count={summary.blocked.length}
        isEmpty={summary.blocked.length === 0}
        emptyText={zoneEmpty("blocked")}
      >
        {summary.blocked.map((row, index) => (
          <DispatchCardRow
            key={`${row.id}:${row.kind}:${index}`}
            row={row}
            anchor={{
              "data-board-dispatch-blocked": row.no,
              "data-board-dispatch-blocked-kind": row.kind,
              "data-board-dispatch-blocked-by": row.by.join(","),
              ...(row.kind === "dependency"
                ? { "data-board-dispatch-blocked-target-inflight": String(row.targetInFlight) }
                : {}),
            }}
            secondary={{
              text: blockedReasonText(row),
              extra: { "data-board-dispatch-blocked-reason": "" },
            }}
            {...(onOpenCard ? { onOpenCard } : {})}
          />
        ))}
      </BoardDispatchZone>

      <BoardDispatchZone
        zone="group"
        title={zoneTitle("group")}
        count={summary.parallelGroup.length}
        isEmpty={summary.parallelGroup.length === 0}
        emptyText={zoneEmpty("group")}
      >
        {summary.capacity !== null ? (
          // 槽位计数行（并发上限/在途/剩余槽位）：数字直读 dispatch 段，不自算。
          <div
            data-board-dispatch-capacity={summary.capacity}
            data-board-dispatch-inflight={summary.inFlightCount}
            data-board-dispatch-slots-free={summary.slotsFree}
            className="truncate px-0.5 text-ui-sm text-foreground-subtle"
          >
            {capacityText}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {summary.parallelGroup.map((row) => (
            // 组成员是**摘要标签**（哪几路可并发），不做第二份弹窗锚点：同一张卡在上方可派区
            // 已有唯一 `data-board-card` 行入口——重复锚点会让宿主的「焦点归还打开者」
            //（按选择器取首个匹配）指错元素；下钻统一走行入口，不在此再造一条交互面。
            <div
              key={row.id}
              data-board-dispatch-group-member={row.no}
              title={row.title}
              className={cn(BOARD_COUNT_CHIP_CLASS, "text-ui-base")}
            >
              <BoardNodeNumber no={row.no} label={row.label} planCode={row.planCode} short />
            </div>
          ))}
        </div>
      </BoardDispatchZone>
    </div>
  );
}
