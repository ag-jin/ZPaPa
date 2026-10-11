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

/**
 * 默认视图 = 指引面（C3-5/#140 拍板：AD-11①「默认视图切指引面，树形保留结构视图」，
 * 用户第一眼=正在执行的计划；树形降级为结构视图入口，四视图一枚不删）。
 * **单点常量**：闭集回落、组件缺省参数都取这里，不另写视图名字面量。
 * 旧偏好迁移（同卡成文）：记忆只存显式选择——键/取值格式不变，存量显式值（含旧默认 tree）
 * 原样读回；只有无记忆/坏值才落本默认，不做一次性覆盖。
 */
export const DEFAULT_BOARD_VIEW_MODE: BoardViewMode = "guide";

export function readBoardViewMode(): BoardViewMode {
  const value = readBoardSessionValue(STORAGE_KEY);
  return isBoardViewMode(value) ? value : DEFAULT_BOARD_VIEW_MODE;
}

export function writeBoardViewMode(mode: BoardViewMode): void {
  writeBoardSessionValue(STORAGE_KEY, mode);
}
