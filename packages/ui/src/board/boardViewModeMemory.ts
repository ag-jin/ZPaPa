/**
 * 看板视图模式的会话记忆（卡 #33 需求 3：「切换状态会话内保持」）。
 *
 * 先例：`settings/saved-workflows/automationsPageTabMemory.ts`（sessionStorage + 不可用即降级）。
 * 面板在切换侧边标签时会卸载（`AnimatedSidePanePanel` 按 tab.type 条件渲染），组件内 state
 * 保不住；视图模式是纯视图偏好，不写板文件（契约 §7.1），因此记在 sessionStorage。
 * 存了不认识的值一律回落默认视图 —— 不猜视图。
 * 读写骨架在 `boardSessionStorage`（与表格列选择共用一处，评审 #34-S1）。
 */
import { readBoardSessionValue, writeBoardSessionValue } from "./boardSessionStorage.js";
import { isBoardViewMode, type BoardViewMode } from "./boardViewsViewModel.js";

const STORAGE_KEY = "zcode-board-view-mode";

/** 默认视图 = 树形（tracer 的既有视图，切面板不会突然换形态）。 */
export const DEFAULT_BOARD_VIEW_MODE: BoardViewMode = "tree";

export function readBoardViewMode(): BoardViewMode {
  const value = readBoardSessionValue(STORAGE_KEY);
  return isBoardViewMode(value) ? value : DEFAULT_BOARD_VIEW_MODE;
}

export function writeBoardViewMode(mode: BoardViewMode): void {
  writeBoardSessionValue(STORAGE_KEY, mode);
}
