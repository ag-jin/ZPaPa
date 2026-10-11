/**
 * 编排视图（`dispatch` 面，#185）的呈现零件与词条 id 单点。
 *
 * 单点纪律：三区键/标题词条、阻塞原因与域文本的词条 id 表都收敛在本文件——视图组件只摆放，
 * 后续编排面扩展（如手机形态、L0 注入复用）不再各写一份。
 *
 * 视觉准入（itw-20261011-9003 高密度信息「分区清晰、一扫可读优先」）：三区各自成节、
 * 节标题 `text-ui-base` 主色；行主文字（卡名/原因/域文本）不缩档——原因与域是运营信息承载；
 * 元数据（区计数、槽位行）用 `text-ui-sm` 档；行留白与窄面触摸命中区沿指引面同一口径
 * （`@max-sm:min-h-11`，≥44px）。
 */
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { BOARD_COUNT_CHIP_CLASS } from "./boardNodeParts.js";

/** 三区键（**闭集**：顺序即呈现顺序——可派清单 → 阻塞归因 → 并发组）。 */
export type BoardDispatchZoneKey = "dispatchable" | "blocked" | "group";

export const BOARD_DISPATCH_ZONE_KEYS: readonly BoardDispatchZoneKey[] = [
  "dispatchable",
  "blocked",
  "group",
];

/** 三区标题词条（Record 穷尽：闭集加值在编译期报缺）。 */
export const BOARD_DISPATCH_ZONE_MESSAGE_IDS: Record<BoardDispatchZoneKey, string> = {
  dispatchable: "board.dispatch.zone.dispatchable",
  blocked: "board.dispatch.zone.blocked",
  group: "board.dispatch.zone.group",
};

/** 三区空态词条（零值也给可读文案，不留空壳——与指引面零槽同款姿态）。 */
export const BOARD_DISPATCH_ZONE_EMPTY_MESSAGE_IDS: Record<BoardDispatchZoneKey, string> = {
  dispatchable: "board.dispatch.empty.dispatchable",
  blocked: "board.dispatch.empty.blocked",
  group: "board.dispatch.empty.group",
};

/** 区节（标题 + 区计数胶囊 + 行/空态槽）：三区共用同一装配，不各写一遍头行。 */
export function BoardDispatchZone({
  zone,
  title,
  count,
  isEmpty,
  emptyText,
  children,
}: {
  zone: BoardDispatchZoneKey;
  title: string;
  count: number;
  isEmpty: boolean;
  emptyText: string;
  children?: ReactNode;
}) {
  return (
    <section data-board-dispatch-zone={zone} className="flex min-w-0 flex-col gap-2">
      <h2 className="flex min-w-0 items-center gap-2 text-ui-base font-medium text-foreground">
        <span className="truncate" title={title}>
          {title}
        </span>
        {/* 区计数 = 该区呈现行数（直取投影，不另算集合）；胶囊形态与既有计数片同点。 */}
        <span
          data-board-dispatch-zone-count={count}
          className={cn(BOARD_COUNT_CHIP_CLASS, "text-ui-sm bg-surface")}
        >
          {count}
        </span>
      </h2>
      {isEmpty ? (
        <div
          data-board-dispatch-empty={zone}
          className="rounded-lg border border-border/50 bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
        >
          {emptyText}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">{children}</div>
      )}
    </section>
  );
}
