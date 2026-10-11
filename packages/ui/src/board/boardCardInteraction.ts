/**
 * 卡片交互的纯函数 + props 工厂（卡 #34）：四视图的卡片共用同一份「点击 → 弹窗」与
 * 「跳转落点 → 高亮」胶水，避免每个视图各写一遍（判据一处、锚点一处）。
 *
 * 单一真源：契约 §3.1/§3.3（点击节点/卡片 → 弹窗（§8.5 弹窗契约））、§6（`dependency` 跳转：
 * 滚动到目标卡并高亮）；键位判据（Enter/Space 激活）在纯函数里一处判定，组件只消费。
 * 本模块不持有状态、不读数据：`onOpenCard` 缺失时返回空 props（面板仍可只读展示）。
 */
import type { KeyboardEvent, MouseEvent } from "react";

export type BoardCardKeyIntent = "open" | "none";

/** 卡片激活键位（纯函数）：Enter 与 Space 是标准激活键，其余键不触发打开。 */
export function boardCardKeyIntent(key: string): BoardCardKeyIntent {
  return key === "Enter" || key === " " ? "open" : "none";
}

/**
 * 选择器锚点值的转义（单点）：id/码来自板上字段，仍显式转义反斜杠与引号
 * ——选择器拼装不该由数据决定成败（含层名/期次名这类合成文本）。
 */
function escapeBoardAnchor(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 跳转落点的选择器：按 `data-board-card` 锚点精确匹配。
 * id 来自板上字段（label/no），转义走同一份 `escapeBoardAnchor`。
 */
export function boardCardSelector(id: string): string {
  return `[data-board-card="${escapeBoardAnchor(id)}"]`;
}

/**
 * 期次块选择器（#90/A4-4 指针下钻的滚动落点）：按 `data-board-phase-block` 锚点匹配
 * （值 = AD-3 合成层名，如 `KANB1`）。与卡片选择器同款转义。
 */
export function boardPhaseSelector(name: string): string {
  return `[data-board-phase-block="${escapeBoardAnchor(name)}"]`;
}

/**
 * epic 层头落点选择器（#90/A4-4；焦点归还用）：按 `data-board-epic-open` 锚点匹配
 * （值 = epic 码）。epic 不开卡片弹窗，打开者记录因此需要自己的选择器。
 */
export function boardEpicOpenSelector(code: string): string {
  return `[data-board-epic-open="${escapeBoardAnchor(code)}"]`;
}

export interface BoardCardOpenProps {
  role?: "button";
  tabIndex?: 0;
  onClick?: (event: MouseEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * 卡片打开态 props（散到视图层既有的卡片元素上，不改布局、不新增包裹层）：
 * 有 `onOpenCard` 才挂交互；键盘走 `boardCardKeyIntent`，Space 需阻止页面滚动默认行为。
 * `preventDefaultOnClick`：落在 `<summary>`（树形特性折叠块头）里时防一次——点「打开弹窗」
 * 不得再触发折叠切换（事件默认动作 = summary 的 toggle）。
 */
export function boardCardOpenProps(params: {
  id: string;
  onOpenCard?: (id: string) => void;
  preventDefaultOnClick?: boolean;
}): BoardCardOpenProps {
  const { id, onOpenCard, preventDefaultOnClick = false } = params;
  if (!onOpenCard) return {};
  return {
    role: "button",
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      if (preventDefaultOnClick) event.preventDefault();
      onOpenCard(id);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (boardCardKeyIntent(event.key) !== "open") return;
      event.preventDefault();
      onOpenCard(id);
    },
  };
}

/**
 * epic 层头的弹窗落点 props（卡 #90 / A4-4；单点）：epic **不是卡**——不走卡片路由
 * （无稳定号，宿主状态是 epic 码，`boardCardOpenProps` 的 id 语义是卡片 id），但键位判据
 * 与卡片同源（`boardCardKeyIntent`：Enter/Space 激活）。落点在 `<summary>` 里，
 * **固定 preventDefault**：点「开 epic 概览」不得再触发折叠切换（与稿层标题区同款分区纪律）。
 */
export function boardEpicOpenProps(params: {
  code: string;
  onOpenEpic?: (code: string) => void;
}): BoardCardOpenProps {
  const { code, onOpenEpic } = params;
  if (!onOpenEpic) return {};
  return {
    role: "button",
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      onOpenEpic(code);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (boardCardKeyIntent(event.key) !== "open") return;
      event.preventDefault();
      onOpenEpic(code);
    },
  };
}

/**
 * 跳转高亮的宿主状态：**带 nonce**（评审 #34-P2）。
 * 只存 id 的旧形态里，「同目标再跳一次」不产生新状态 → 宿主的滚动/限时 effect 不重跑
 * （用户看到的是「点了没反应」）；nonce 每次自增，同目标重跳也重新起算滚动与高亮时限。
 */
export interface BoardCardHighlightState {
  id: string;
  nonce: number;
}

export function nextBoardCardHighlight(
  previous: BoardCardHighlightState | null,
  id: string,
): BoardCardHighlightState {
  return { id, nonce: (previous?.nonce ?? 0) + 1 };
}

/**
 * 落点在折叠容器（`<details>`：访谈汇总子区，契约 §13.3）里的跳转可见性（评审 #34-P2）：
 * 折叠着就**先展开再滚动**，否则滚到了也看不见。判据在这里一处，DOM 读写在宿主。
 * （看板「已完成」列不再由 `<details>` 承载——见 `boardRevealKanbanColumnIntent`。）
 */
export function boardRevealDetailsIntent(details: { open: boolean } | null): "expand" | "none" {
  return details !== null && !details.open ? "expand" : "none";
}

/**
 * 看板可折叠列的段位（契约 §13.2：「已完成」列 = 可折叠分区；归档前默认展开）。
 * 单一真源：视图层的折叠按钮与宿主侧的跳转揭示共用这一个字面量。
 */
export const BOARD_KANBAN_COLLAPSIBLE_STAGE = "已完成";

/**
 * 落点在**看板可折叠列**（已完成）里的跳转可见性（评审 #35-S1 二轮）：
 * 该列的卡是条件渲染——折叠着就不在 DOM 里，宿主必须先置展开态（与其他状态同一次提交，
 * 滚动 effect 才找得到落点）。判据在这里一处，DOM 读写在宿主。
 */
export function boardRevealKanbanColumnIntent(stage: string | null): "expand" | "none" {
  return stage === BOARD_KANBAN_COLLAPSIBLE_STAGE ? "expand" : "none";
}

/**
 * 跳转落点高亮 props：锚点与**视觉样式**同源一处生成（只有落在 `highlightId` 上的卡片带
 * `data-board-card-highlight` 与高亮类片段）；高亮的时限与清除在宿主。
 * 调用方解构出 `className` 与其余 props 分别落位即可（不要在视图层重写配色）。
 */
export interface BoardCardHighlightProps {
  "data-board-card-highlight"?: "true";
  className?: string;
}

export function boardCardHighlightProps(
  id: string,
  highlightId: string | null | undefined,
  options: { withBorder?: boolean } = {},
): BoardCardHighlightProps {
  if (highlightId === null || highlightId === undefined || highlightId !== id) return {};
  return {
    "data-board-card-highlight": "true",
    // 带边框的面（看板卡）多一道描边；行式卡片（树形/列表/表格）只有底色——既有口径不变。
    className: options.withBorder ? "border-warning bg-warning/15" : "bg-warning/15",
  };
}
