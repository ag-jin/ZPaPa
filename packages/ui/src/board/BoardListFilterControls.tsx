/**
 * 列表/表格两视图共用的过滤与排序控件（卡 #34 从 BoardListView 抽出，实现零改动）。
 *
 * 「过滤 UI 最小化」（#33）：四个闭集下拉（段位/状态/缺口码/类型，各含「全部」）+ 排序下拉。
 * 取值即闭集成员，空串与坏值在 `board*FilterValue` 归一函数里归一到 `null`（纯函数层，
 * 视图层不写裸 `as` 断言——判据一处，控件只回传意图）。
 * 单点必要性：列表视图与表格视图共用同一份控件状态（切视图不丢过滤/排序），
 * 控件若各写一份，两份取值口径早晚对不上。
 *
 * 类型筛（kind）的来源：契约 §13.2 表格「待设计」格「可按 attention 与 kind 过滤」。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BOARD_ATTENTION_LABEL_MESSAGE_IDS,
  BOARD_STATUS_MESSAGE_IDS,
  BOARD_STAGE_MESSAGE_IDS,
} from "./boardPresentation.js";
import { BOARD_ATTENTION_CODES, BOARD_STATUS_VALUES, BOARD_STAGES } from "./boardViewModel.js";
import {
  BOARD_VIEW_NODE_KIND_MESSAGE_IDS,
  BOARD_VIEW_NODE_KINDS,
  boardAttentionFilterValue,
  boardStageFilterValue,
  boardStatusFilterValue,
  boardViewNodeKindFilterValue,
  type BoardListControls,
} from "./boardViewsViewModel.js";
import {
  BOARD_VIEW_SORTS,
  BOARD_VIEW_SORT_MESSAGE_IDS,
  boardSortFilterValue,
} from "./boardViewSorting.js";

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
            onChange({ ...controls, stage: boardStageFilterValue(event.target.value) })
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
            onChange({ ...controls, status: boardStatusFilterValue(event.target.value) })
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
            onChange({ ...controls, attention: boardAttentionFilterValue(event.target.value) })
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
        <span>{t("board.filter.kind")}</span>
        <select
          data-board-filter="kind"
          className={selectClass}
          value={controls.kind ?? ""}
          onChange={(event) =>
            onChange({ ...controls, kind: boardViewNodeKindFilterValue(event.target.value) })
          }
        >
          <option value="">{t("board.filter.all")}</option>
          {BOARD_VIEW_NODE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(BOARD_VIEW_NODE_KIND_MESSAGE_IDS[kind])}
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
          onChange={(event) =>
            onChange({ ...controls, sort: boardSortFilterValue(event.target.value) })
          }
        >
          {/* 三视角闭集（#65）：选项与顺序来自 `BOARD_VIEW_SORTS`，不各写一份字面量。 */}
          {BOARD_VIEW_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(BOARD_VIEW_SORT_MESSAGE_IDS[sort])}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
