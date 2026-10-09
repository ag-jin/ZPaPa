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
 * 跳转落点的选择器：按 `data-board-card` 锚点精确匹配。
 * id 来自板上字段（label/no），仍显式转义反斜杠与引号——选择器拼装不该由数据决定成败。
 */
export function boardCardSelector(id: string): string {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-board-card="${escaped}"]`;
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
 */
export function boardCardOpenProps(params: {
  id: string;
  onOpenCard?: (id: string) => void;
}): BoardCardOpenProps {
  const { id, onOpenCard } = params;
  if (!onOpenCard) return {};
  return {
    role: "button",
    tabIndex: 0,
    onClick: () => onOpenCard(id),
    onKeyDown: (event: KeyboardEvent) => {
      if (boardCardKeyIntent(event.key) !== "open") return;
      event.preventDefault();
      onOpenCard(id);
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
 * 落点在折叠容器（`<details>`：已完成列 / 访谈汇总子区）里的跳转可见性（评审 #34-P2）：
 * 折叠着就**先展开再滚动**，否则滚到了也看不见。判据在这里一处，DOM 读写在宿主。
 */
export function boardRevealDetailsIntent(details: { open: boolean } | null): "expand" | "none" {
  return details !== null && !details.open ? "expand" : "none";
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
