/**
 * 占位态（空态 A1/A2 二分、B、错误态、暂时不可读、加载中）与未连接快照状态行的**面板级零件**
 * （卡 #158 从 `BoardPaneView` 平移：该文件触及 oxlint `max-lines` 400 上限，零件比骨架先搬。
 * 对外公共面不变——`BoardPlaceholderKind` 仍由 `BoardPaneView` 再导出）。
 *
 * 刷新按钮在**面板级**出现（空态 A1 的文案正指导用户「回来再读」，评审 #32-P5）：任何占位态
 * 都能手动重读；没有刷新回调时不渲染死按钮。
 */
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BoardPlaceholderKind } from "./boardPresentation.js";

/**
 * 看板面板根元素的类名（就绪态与占位态共用）：`relative` 是弹窗 overlay 的定位上下文（#46 B5）。
 * `data-board-pane` 与选区豁免 `data-no-selection-action`（卡 #64）同落在这个根元素上。
 */
export const BOARD_PANE_ROOT_CLASS = "relative flex h-full min-h-0 flex-col";

/** 面板级刷新按钮（`data-board-refresh`）：就绪头部与占位态同一实现（评审 #32-P5）。 */
export function BoardPaneRefreshButton({ onRefresh }: { onRefresh: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-board-refresh=""
      className="shrink-0"
      aria-label={intl.formatMessage({ id: "board.refresh" })}
      onClick={onRefresh}
    >
      <RefreshCwIcon className="size-4" />
    </Button>
  );
}

/** 未连接保留快照的状态行（卡 #158；E7 §7.2「显示暂时不可读，保留上次快照但标陈旧」）。 */
export function BoardSnapshotNotice({ message }: { message: string }) {
  return (
    // 排在提示条之下（提示条仍是第一优先级视觉元素，契约 §4）、陈旧提示行之上（连接状态比板龄更即时）。
    <div className="shrink-0 px-3 pt-3">
      <div
        data-board-snapshot-notice=""
        role="status"
        className="rounded-lg border border-border/50 bg-surface px-3 py-1.5 text-ui-xs text-foreground-subtle"
      >
        {message}
      </div>
    </div>
  );
}

/**
 * 占位态：空态 A1/A2、B、错误态（损坏/版本过新/过旧/文件过大）、暂时不可读与加载中共用同一骨架。
 */
export function BoardPlaceholder({
  kind,
  message,
  onRefresh,
}: {
  kind: BoardPlaceholderKind;
  message: string;
  onRefresh?: () => void;
}) {
  const anchor = kind === "loading" ? { "data-board-loading": "" } : { "data-board-empty": kind };
  return (
    // relative：弹窗 overlay 是**面板容器内 absolute**（#46 B5），不是 fixed 全局遮罩。
    // 占位态同样是看板面板（只读）：与就绪态同一份选区豁免声明（卡 #64）。
    <div data-board-pane="" data-no-selection-action="" className={BOARD_PANE_ROOT_CLASS}>
      {onRefresh ? (
        <div className="flex h-12 shrink-0 items-center justify-end border-b border-border/50 px-3">
          <BoardPaneRefreshButton onRefresh={onRefresh} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
        <div {...anchor} className="max-w-[20rem] text-center text-ui-sm text-foreground-subtle">
          {message}
        </div>
      </div>
    </div>
  );
}
