/**
 * 指引面（guide 面）的呈现零件（卡 #136 / C3-1）：五槽卡片与计划进度微条。
 *
 * 单点纪律：词条 id 表与微条形态都收敛在本文件——#139（C3-4 计数胶囊/微条）与 #137/#138
 * 复用这一份，不各自复制（派发约束「复用单点」）。零件只做投影呈现：计数/成员都来自
 * `boardGuideViewModel`（四段派生与板字段），这里不重算任何业务判据。
 *
 * 视觉准入（itw-20261011-9003：文字太小/密度太密两条压迫反馈）：
 * - 槽标签与辅助行 `text-ui-sm`（12px，不小于既有正文文档的辅助字号档下限），主数 `text-ui-base`；
 * - 槽卡自带 `p-3` 内边距与 `gap-2` 间距，微条独立成行——不挤在同一行里堆信息点。
 */
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
 * 计划进度微条（E7 §4.2：进度条旁必须有数字，不能只用长度）：
 * 数字由调用方（`data-board-guide-plan-progress` 文本）给出，本零件只画长度。
 */
export function BoardGuidePlanProgressBar({
  completed,
  total,
  label,
}: {
  completed: number;
  total: number;
  /** 无障碍名（完整语义：已完成/总卡）。 */
  label: string;
}) {
  const value = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <Progress
      data-board-guide-plan-bar=""
      data-board-guide-plan-bar-value={`${completed}/${total}`}
      value={value}
      aria-label={label}
      className="h-1.5 w-full"
    />
  );
}
