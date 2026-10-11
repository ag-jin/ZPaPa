/**
 * 折叠控件单点（#55 S-3 → #89/A4-3 收口）：`<details>` 形态的装饰性 chevron 指示符，与表格形态
 * 的真折叠按钮（`aria-expanded` + 词条可及名称）。**为什么单列一个模块**：三个 details 视图
 * （树/列表/看板容器头）与表格（两级组行 + 稿层分组行）共用同一份折叠控件；零件本体留在
 * `boardNodeParts` 会把该文件推过行数上限（#89 拆出一份，语义不拆）。
 */
import type { MouseEvent } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BoardFoldControls } from "./boardFoldState.js";

/**
 * 折叠指示符（#55 S-3；#87 起树形容器头/稿块使用；#168/A4-1b 起看板/列表容器头共用同一份
 * ——BoardListView 的内联件已收口，CR-S3 结案）：原生 `<details>/<summary>`
 * 已向辅助技术暴露展开态，缺的是**视觉**指示符——装饰性 chevron（`aria-hidden`，`group-open:`
 * 旋转），不写伪 `aria-expanded`、不夺由内容构成的可及名称。宿主 `<details>` 必须带 `group` 类。
 */
export function BoardFoldIndicator() {
  return (
    <span
      aria-hidden="true"
      data-board-fold-indicator=""
      className="shrink-0 text-ui-xs text-foreground-subtle transition-transform group-open:rotate-90"
    >
      ▸
    </span>
  );
}

/**
 * 表格折叠按钮（#55 S-3 可及名称口径；#89/A4-3 收口成单点）：表格无法嵌套 `<details>`——
 * 展开态由 `aria-expanded` 表达，可及名称走既有词条（动作 + 对象：`board.group.expand` /
 * `board.group.collapse`），字形 ▸/▾ 由状态给出。调用面：稿层分组行（`data-board-group-toggle`，
 * #46/B4 既有锚点）与 epic/期次层组行（`data-board-layer-toggle`，#89 新增）——两处同一份零件，
 * 不各写一遍按钮。
 */
export function BoardFoldToggleButton({
  foldId,
  name,
  expanded,
  onToggle,
  layer = false,
}: {
  /** 折叠 id（会话记忆键；也作锚点值）。 */
  foldId: string;
  /** 可及名称里的对象（稿名 / 层名如 `KANB`、`KANB1`）。 */
  name: string;
  expanded: boolean;
  /** 用户切换（宿主持有 + 会话记忆）；缺省 = 只读渲染（按钮无动作，与既有只读口径一致）。 */
  onToggle?: ((foldId: string, open: boolean) => void) | undefined;
  /** 层组行（epic/期次）用 `data-board-layer-toggle`；稿层分组行保持既有 `data-board-group-toggle`。 */
  layer?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      {...(layer ? { "data-board-layer-toggle": foldId } : { "data-board-group-toggle": foldId })}
      aria-expanded={expanded}
      aria-label={intl.formatMessage(
        { id: expanded ? "board.group.collapse" : "board.group.expand" },
        { name },
      )}
      onClick={() => onToggle?.(foldId, !expanded)}
      className="shrink-0 cursor-pointer rounded-sm px-1 text-ui-xs text-foreground-subtle"
    >
      {expanded ? "▾" : "▸"}
    </button>
  );
}

/**
 * `<summary>` 点击 → 折叠控制回传（单点）。**为什么不用 `onToggle`**：浏览器实测（#89 第一绿，
 * Electron 41/Chromium 146）两处坑——① `toggle` 事件在 open 属性被加上/移除时都会排队（含挂载期
 * 的初值应用），直接回传会把「默认展开」的组在挂载时全部写成显式覆盖，记忆被污染、默认态被冻结；
 * ② 用户路径（含真实指针序列）的 `<summary>` 点击并不保证送达 `toggle`（同一批事件里挂载期事件
 * 到齐、点击那一发缺失），折叠发生了却记不下。
 *
 * 判据改挂在**点击**上：React 的委托 `onClick` 在默认动作（`<details>` 切换）之前执行，因此
 * `!currentOpen` 就是这次点击将产生的展开态。落点内点击（稿层标题区开弹窗）已 `preventDefault`
 * → 不记（那一下不折叠）。挂载期属性应用不产生点击 → 天然不落键。宿主状态更新后重渲染把 `open`
 * 属性写成同一值，视觉零跳变。
 */
export function boardFoldSummaryClickHandler(
  fold: BoardFoldControls,
  foldId: string,
  currentOpen: boolean,
): (event: MouseEvent<HTMLElement>) => void {
  return (event) => {
    if (event.defaultPrevented) return;
    fold.onToggle(foldId, !currentOpen);
  };
}
