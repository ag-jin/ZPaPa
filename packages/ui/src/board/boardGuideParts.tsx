/**
 * 指引面（guide 面）的呈现零件（卡 #136 / C3-1 起；卡 #139 / C3-4 完整化）：五槽卡片与
 * 计划进度胶囊/微条、计数胶囊、rollup 缺口徽章。
 *
 * 单点纪律：词条 id 表与进度/计数形态都收敛在本文件——#137/#138 复用这一份，不各自复制
 * （派发约束「复用单点」）。零件只做投影呈现：计数/成员都来自 `boardGuideViewModel`
 * （四段派生与板字段），这里不重算任何业务判据；计划卡数与缺口计数直取 A4 组头单点
 * （`countBoardFeatureTasks` / `boardLayerGapCount`，投影直读），计数片/缺口徽章形态复用
 * `boardNodeParts`/`boardBadgeParts` 的共享类（禁二份实现）。
 *
 * 视觉准入（itw-20261011-9003：文字太小/密度太密两条压迫反馈）：
 * - 槽标签与辅助行 `text-ui-sm`（12px，不小于既有正文文档的辅助字号档下限），主数 `text-ui-base`；
 * - 槽卡自带 `p-3` 内边距与 `gap-2` 间距，进度胶囊「计数 · 百分比」收敛为一个信息组（#139）；
 * - 计划卡数胶囊/缺口徽章走 12px 档（胶囊标签下限），主计数 14px。
 */
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BOARD_WARNING_BADGE_CLASS } from "./boardBadgeParts.js";
import { BOARD_COUNT_MESSAGE_IDS, formatBoardCountText } from "./boardPresentation.js";
import { BOARD_COUNT_CHIP_CLASS } from "./boardNodeParts.js";
import type { BoardGuideSlot, BoardGuideSlotKey } from "./boardGuideViewModel.js";

/** 五槽标签词条（**闭集**：Record 穷尽，槽词表加值会在编译期报缺）。 */
export const BOARD_GUIDE_SLOT_MESSAGE_IDS: Record<BoardGuideSlotKey, string> = {
  attention: "board.guide.slot.attention",
  blocked: "board.guide.slot.blocked",
  running: "board.guide.slot.running",
  review: "board.guide.slot.review",
  recent: "board.guide.slot.recent",
};

/** 五槽短解释（非零态的辅助行；E7 §3.1「一个主数 + 一个短解释」）。 */
export const BOARD_GUIDE_SLOT_HINT_MESSAGE_IDS: Record<BoardGuideSlotKey, string> = {
  attention: "board.guide.slotHint.attention",
  blocked: "board.guide.slotHint.blocked",
  running: "board.guide.slotHint.running",
  review: "board.guide.slotHint.review",
  recent: "board.guide.slotHint.recent",
};

/** 五槽零值文案（空槽形态：零 attention 也显示，且给可读文案——不留空壳）。 */
export const BOARD_GUIDE_SLOT_ZERO_MESSAGE_IDS: Record<BoardGuideSlotKey, string> = {
  attention: "board.guide.zero.attention",
  blocked: "board.guide.zero.blocked",
  running: "board.guide.zero.running",
  review: "board.guide.zero.review",
  recent: "board.guide.zero.recent",
};

/** 槽值文本：计数缺省（旧板）= `—`（未知不猜）；0 是显式 0，不是缺省。 */
export function boardGuideSlotValueText(slot: BoardGuideSlot): string {
  return slot.count === null ? "—" : String(slot.count);
}

/**
 * 置顶五槽条的单槽卡（主数 + 短解释；`data-board-guide-slot-value` 是断言/浏览器探针锚点）。
 * `hint` 传值时替换短解释（最近活动槽显示最新一条的相对时间）。
 */
export function BoardGuideSlotTile({ slot, hint }: { slot: BoardGuideSlot; hint?: string }) {
  const { intl } = useZCodeIntl();
  const zero = slot.count === 0;
  const secondary =
    hint ??
    intl.formatMessage({
      id: zero
        ? BOARD_GUIDE_SLOT_ZERO_MESSAGE_IDS[slot.key]
        : BOARD_GUIDE_SLOT_HINT_MESSAGE_IDS[slot.key],
    });
  return (
    <div
      data-board-guide-slot={slot.key}
      data-board-guide-slot-value={boardGuideSlotValueText(slot)}
      {...(zero ? { "data-board-guide-zero": "true" } : {})}
      className="flex min-w-0 flex-1 basis-36 flex-col gap-0.5 rounded-lg border border-border/50 bg-surface px-3 py-2"
    >
      <span className="truncate text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: BOARD_GUIDE_SLOT_MESSAGE_IDS[slot.key] })}
      </span>
      <span className="text-ui-base font-medium tabular-nums text-foreground">
        {boardGuideSlotValueText(slot)}
      </span>
      {secondary ? (
        <span className="truncate text-ui-sm text-foreground-subtle">{secondary}</span>
      ) : null}
    </div>
  );
}

/**
 * 计划进度百分比（**单点口径**，卡 #139 / C3-4）：`completed/total` 四舍五入取整；
 * `total === 0`（未拆解）= null——百分比文本与微条进度值共用这一份判据，不在两处各算一遍。
 */
export function boardGuidePlanPercent(completed: number, total: number): number | null {
  return total > 0 ? Math.round((completed / total) * 100) : null;
}

/**
 * 计划进度微条（E7 §4.2：进度条旁必须有数字，不能只用长度）：
 * 数字由调用方（`data-board-guide-plan-progress` 文本与百分比）给出，本零件只画长度；
 * `className` 供胶囊内联排（缺省 = 独立成行）。
 * 轨道背景覆写为 `bg-border`（F1-139）：共享基件缺省 `bg-muted` 依赖的 `--color-muted`
 * 全仓四主题均无定义（惰性类 → 轨道透明），`bg-border` 四主题已定义（10% 墨轨道）。
 */
export function BoardGuidePlanProgressBar({
  completed,
  total,
  label,
  className = "h-1.5 w-full",
}: {
  completed: number;
  total: number;
  /** 无障碍名（完整语义：已完成/总卡）。 */
  label: string;
  className?: string;
}) {
  return (
    <Progress
      data-board-guide-plan-bar=""
      data-board-guide-plan-bar-value={`${completed}/${total}`}
      value={boardGuidePlanPercent(completed, total) ?? 0}
      aria-label={label}
      className={cn("bg-border", className)}
    />
  );
}

/**
 * 计划级进度胶囊（卡 #139 / C3-4；E7 §4.2 形态「52/59 完成 [====--]」）：
 * 已完成/总卡（既有词条）+ 百分比可读文本 + 微条同一行——「X/Y · Z%」收敛为一个信息组
 * （itw-20261011-9003 密度准入），计数字号 `text-ui-base`(14px)，百分比标签 `text-ui-sm`(12px)；
 * 未拆解（total=0）只给可读文案、不给百分比与微条（不制造未知）。
 */
export function BoardGuidePlanProgressCapsule({
  completed,
  total,
  label,
}: {
  completed: number;
  total: number;
  /** 无障碍名（完整语义：已完成/总卡；给微条零件透传）。 */
  label: string;
}) {
  const { intl } = useZCodeIntl();
  const percent = boardGuidePlanPercent(completed, total);
  return (
    <div
      data-board-guide-plan-progress={`${completed}/${total}`}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 bg-surface px-2 py-1"
    >
      <span className="flex min-w-0 shrink-0 items-baseline gap-1">
        <span className="text-ui-base font-medium tabular-nums text-foreground">
          {percent === null
            ? intl.formatMessage({ id: "board.guide.plan.undesigned" })
            : intl.formatMessage({ id: "board.guide.plan.progress" }, { completed, total })}
        </span>
        {percent === null ? null : (
          <>
            <span aria-hidden="true" className="text-ui-sm text-foreground-subtle">
              ·
            </span>
            <span
              data-board-guide-plan-percent={percent}
              className="text-ui-sm tabular-nums text-foreground-subtle"
            >
              {intl.formatMessage({ id: "board.guide.plan.percent" }, { percent })}
            </span>
          </>
        )}
      </span>
      {percent === null ? null : (
        <BoardGuidePlanProgressBar
          completed={completed}
          total={total}
          label={label}
          className="h-1.5 min-w-0 flex-1"
        />
      )}
    </div>
  );
}

/**
 * 期次/功能级摘要行的规模计数胶囊（卡 #139 / C3-4；AD-6「名 + 计数」、E7 §4.1 计数胶囊）：
 * 计划卡数 = 该计划全部成员卡（含嵌套子卡）——与 A4 组头 `[N 张卡]` 同一单点
 * （`countBoardFeatureTasks`，由投影 `plan.total` 直读）与同一词条；形态复用组头计数片共享类
 * （字号取 12px 档：指引面胶囊标签下限，itw-20261011-9003）。
 */
export function BoardGuidePlanCardCountCapsule({ count }: { count: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span
      data-board-guide-plan-card-count={count}
      className={cn(BOARD_COUNT_CHIP_CLASS, "text-ui-sm bg-surface")}
    >
      {formatBoardCountText(count, BOARD_COUNT_MESSAGE_IDS.featureCardCount, intl.formatMessage)}
    </span>
  );
}

/**
 * 计划 rollup 缺口徽章（卡 #139 / C3-4；AD-6「rollup 缺口计数徽章」）：
 * 计数 = 该计划成员卡的 attention 码条数之和（A4 单点 `boardLayerGapCount`，投影直读）；
 * 形态与 A4 层头缺口徽章同款（`BOARD_WARNING_BADGE_CLASS` 描边 + 省略号防线 + 全文 title），
 * 字号 12px 档（胶囊标签下限）。`0` = 日常零噪声，由调用方不渲染。
 */
export function BoardGuidePlanRollupGapBadge({ gapCount }: { gapCount: number }) {
  const { intl } = useZCodeIntl();
  const text = formatBoardCountText(
    gapCount,
    BOARD_COUNT_MESSAGE_IDS.layerGapCount,
    intl.formatMessage,
  );
  return (
    <Badge
      variant="outline"
      data-board-guide-plan-gap-count={gapCount}
      data-board-overflow-clip=""
      title={text}
      className={cn(BOARD_WARNING_BADGE_CLASS, "text-ui-sm")}
    >
      <span data-board-overflow-ellipsis="" className="min-w-0 truncate">
        {text}
      </span>
    </Badge>
  );
}
