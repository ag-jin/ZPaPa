/**
 * 列表/表格排序选择的会话记忆（卡 #65：「选择进会话记忆」，复用 `boardViewModeMemory` 形态）。
 *
 * 先例：`boardViewModeMemory`（#33）与 `boardTableColumnMemory`（#34）——sessionStorage +
 * 不可用即降级；面板切侧边标签会卸载，组件 state 保不住排序视角。存了不认识的值一律回落
 * **契约默认序**（`recent`：attention 置顶 + updatedAt 倒序 + 已完成沉底），不猜视角。
 * 读写骨架在 `boardSessionStorage`（与视图模式/列选择共用一处，评审 #34-S1）。
 *
 * 与过滤条件的分工：过滤是临时视角（关面板即回到不筛；跳转前还会被清），排序视角是用户显式
 * 选择，跨「切视图 / 关面板再打开」保持——两者共用 `BoardListControls`，但记忆面只有排序。
 */
import { readBoardSessionValue, writeBoardSessionValue } from "./boardSessionStorage.js";
import { isBoardViewSort, type BoardViewSort } from "./boardViewSorting.js";

const STORAGE_KEY = "zcode-board-list-sort";

/** 默认排序视角 = 契约序（§3.5：attention 置顶 + `updatedAt` 倒序 + 已完成沉底）。 */
export const DEFAULT_BOARD_LIST_SORT: BoardViewSort = "recent";

export function readBoardListSort(): BoardViewSort {
  const value = readBoardSessionValue(STORAGE_KEY);
  return isBoardViewSort(value) ? value : DEFAULT_BOARD_LIST_SORT;
}

export function writeBoardListSort(sort: BoardViewSort): void {
  writeBoardSessionValue(STORAGE_KEY, sort);
}
