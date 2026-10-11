/**
 * 卡详情呈现零件（#220/D7 major①；从 `BoardCardDialog` 抽出——控制弹窗文件行数，零件与外壳分离）。
 *
 * 两类零件：
 *   - 卡片内容区块（#183 卡文交付面②）：目标/交付面/验收——常驻折叠态，缺省显式「未携带」；
 *   - 详情读取态提示（#220/D7）：`missing`（板上/分片里没有这张卡）/ `unavailable`（暂时读不到：
 *     断连 / 板文件超限截断）——**与「板上未携带」确定性空态分开呈现**（不可读不得被表述为
 *     「板上没有」）；`unavailable` 给「刷新重试」入口（同代重试：清缓存重读），`missing` 无重试。
 */
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardFoldIndicator } from "./boardFoldParts.js";
import type { BoardCardDialogModel } from "./boardDialogViewModel.js";

/** 详情读取态提示（#220/D7 major①）：不可读/缺失与「板上未携带」分开成形态。 */
function CardDetailStateNotice({
  state,
  onRetry,
}: {
  state: "missing" | "unavailable";
  onRetry?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <div
      data-board-dialog-detail={state}
      role="status"
      className="flex flex-col gap-1.5 border-t border-border/50 px-3 py-2"
    >
      <span className="text-ui-xs font-medium text-foreground-subtle">
        {t("board.dialog.detailTitle")}
      </span>
      <p className="text-ui-sm text-foreground-subtle">
        {t(
          state === "unavailable"
            ? "board.dialog.detail.unavailable"
            : "board.dialog.detail.missing",
        )}
      </p>
      {state === "unavailable" && onRetry ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          className="self-start"
          data-board-dialog-detail-retry="button"
          onClick={onRetry}
        >
          {t("board.dialog.detail.retry")}
        </Button>
      ) : null}
    </div>
  );
}

/** 卡片正文的「未携带」显式形态（#183）：不硬造内容，也不静默吞掉字段（空值有明确形状）。 */
function CardTextAbsent() {
  const { intl } = useZCodeIntl();
  return (
    <span data-board-dialog-card-text-absent="" className="text-ui-sm text-foreground-subtle">
      {intl.formatMessage({ id: "board.dialog.cardText.absent" })}
    </span>
  );
}

/** 卡片正文单值（目标/验收）：保留段内换行（pre-wrap），长文换行不横向溢出（break-words）。 */
function CardTextValue({ text }: { text: string }) {
  return (
    <p
      data-board-dialog-card-text-value=""
      className="whitespace-pre-wrap break-words text-ui-sm text-foreground"
    >
      {text}
    </p>
  );
}

/**
 * 卡片内容区块（#183；卡文交付面②）：目标 / 交付面 / 验收——这卡要干什么、怎么算完成。
 *
 * 形态判据（卡文 + itw-20261011-9003 密度准入）：
 * - **常驻 + 默认折叠**：区块对卡片弹窗恒在（字段缺省也不消失——空值有明确形态），以原生
 *   `<details>` 收在折叠态（长文不塞满弹窗；展开态承载全文，「长文截断或展开」取展开一路）；
 * - **有值原样渲染、缺省显式「未携带」**：板上没有就显示没有，不猜、不自算、不解析计划稿
 *   （消费契约 §13.6）；字段名与截断口径见 evidence/T183/schema-proposal.txt；
 * - 特性节点与任务卡共用同一形态（卡级字段缺省即空态行，不借子树的值）。
 *
 * #220/D7：详情不可读/缺失（`detailState` 非空）→ 改出「读取态提示」，不落「未携带」假空态。
 */
export function BoardCardTextSection({
  dialog,
  detailState = null,
  onRetryDetail,
}: {
  dialog: BoardCardDialogModel;
  detailState?: "missing" | "unavailable" | null;
  onRetryDetail?: (no: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const no = dialog.no;
  if (detailState === "missing" || detailState === "unavailable") {
    return (
      <CardDetailStateNotice
        state={detailState}
        {...(onRetryDetail && no !== null ? { onRetry: () => onRetryDetail(no) } : {})}
      />
    );
  }
  const allAbsent =
    dialog.goal === null && dialog.deliverables.length === 0 && dialog.acceptance === null;
  return (
    <details
      data-board-dialog-section="cardText"
      data-board-dialog-card-text=""
      className="group border-t border-border/50"
    >
      <summary
        data-board-dialog-card-text-summary=""
        className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 hover:bg-surface-hover"
      >
        <BoardFoldIndicator />
        <span className="text-ui-xs font-medium text-foreground-subtle">
          {t("board.dialog.cardTextTitle")}
        </span>
        {allAbsent ? (
          <span
            data-board-dialog-card-text-all-absent=""
            className="text-ui-xs text-foreground-subtle"
          >
            {t("board.dialog.cardText.absent")}
          </span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-2">
        <div data-board-dialog-card-text="goal" className="flex flex-col gap-0.5">
          <span className="text-ui-xs text-foreground-subtle">
            {t("board.dialog.cardText.goal")}
          </span>
          {dialog.goal !== null ? <CardTextValue text={dialog.goal} /> : <CardTextAbsent />}
        </div>
        <div data-board-dialog-card-text="deliverables" className="flex flex-col gap-0.5">
          <span className="text-ui-xs text-foreground-subtle">
            {t("board.dialog.cardText.deliverables")}
          </span>
          {dialog.deliverables.length > 0 ? (
            <ul data-board-dialog-card-text-value="" className="flex flex-col gap-0.5">
              {dialog.deliverables.map((item, index) => (
                <li
                  key={`${index}:${item}`}
                  data-board-dialog-card-text-item={index}
                  className="whitespace-pre-wrap break-words text-ui-sm text-foreground"
                >
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <CardTextAbsent />
          )}
        </div>
        <div data-board-dialog-card-text="acceptance" className="flex flex-col gap-0.5">
          <span className="text-ui-xs text-foreground-subtle">
            {t("board.dialog.cardText.acceptance")}
          </span>
          {dialog.acceptance !== null ? (
            <CardTextValue text={dialog.acceptance} />
          ) : (
            <CardTextAbsent />
          )}
        </div>
      </div>
    </details>
  );
}
