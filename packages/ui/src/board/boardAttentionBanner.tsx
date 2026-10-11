/**
 * 置顶提示条（卡 #90 / A4-4 自 `BoardPaneView` 拆出：面板骨架的新增（epic 弹窗接线）逼近行数上限；
 * 组件语义不变）。契约 §3.1 逐字：四段各自成段（每段按缺口码找落点），分隔符 ` · ` 是文本节点
 * ——全文与单段共用同一张词条表（`BOARD_ATTENTION_SUMMARY_ROWS`），文案一字不改。
 * 有落点的段落是按钮（点即滚动到对应卡 + 高亮）；没有落点（陈旧摘要）是纯文本，不给死按钮。
 */
import { Fragment } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveBoardAttentionJumpTarget, type BoardJumpTarget } from "./boardDialogViewModel.js";
import {
  BOARD_ATTENTION_SUMMARY_ROWS,
  formatAttentionSummarySegment,
} from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";

/**
 * 置顶提示条（契约 §3.1 逐字）：四段各自成段（每段按缺口码找落点），分隔符 ` · ` 是文本节点
 * ——全文与单段共用同一张词条表（`BOARD_ATTENTION_SUMMARY_ROWS`），文案一字不改。
 * 有落点的段落是按钮（点即滚动到对应卡 + 高亮）；没有落点（陈旧摘要）是纯文本，不给死按钮。
 */
export function BoardAttentionBanner({
  board,
  onJumpToCard,
}: {
  board: BoardViewModel;
  onJumpToCard?: (target: BoardJumpTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-board-attention-banner=""
      role="status"
      className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
    >
      {BOARD_ATTENTION_SUMMARY_ROWS.map(([summaryKey, code], index) => {
        const text = formatAttentionSummarySegment(
          code,
          board.attentionSummary[summaryKey],
          intl.formatMessage,
        );
        const target = resolveBoardAttentionJumpTarget(board, code);
        return (
          <Fragment key={code}>
            {index > 0 ? <span aria-hidden="true"> · </span> : null}
            {target && onJumpToCard ? (
              <button
                type="button"
                data-board-attention-jump={code}
                className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:underline"
                onClick={() => onJumpToCard(target)}
              >
                {text}
              </button>
            ) : (
              <span data-board-attention-jump-none={code}>{text}</span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
