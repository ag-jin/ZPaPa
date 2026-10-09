/**
 * 列表/表格两视图共用的过滤与排序控件（卡 #34 从 BoardListView 抽出，实现零改动）。
 *
 * 「过滤 UI 最小化」（#33）：三个闭集下拉（段位/状态/缺口码，各含「全部」）+ 排序下拉。
 * 取值即闭集成员，空串在 onChange 处归一到 null（判据在纯函数层，组件只回传意图）。
 * 单点必要性：列表视图与表格视图共用同一份控件状态（切视图不丢过滤/排序），
 * 控件若各写一份，两份取值口径早晚对不上。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BOARD_ATTENTION_LABEL_MESSAGE_IDS,
  BOARD_STATUS_MESSAGE_IDS,
  BOARD_STAGE_MESSAGE_IDS,
} from "./boardPresentation.js";
import {
  BOARD_ATTENTION_CODES,
  BOARD_STATUS_VALUES,
  BOARD_STAGES,
  type BoardAttentionCode,
  type BoardStage,
  type BoardStatusValue,
} from "./boardViewModel.js";
import type { BoardListControls, BoardViewSort } from "./boardViewsViewModel.js";

export function BoardListFilterControls({
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
