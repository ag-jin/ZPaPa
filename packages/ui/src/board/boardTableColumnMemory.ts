/**
 * 表格列选择的会话记忆（卡 #34：「列可配置，选择持久会话内」）。
 *
 * 先例：`boardViewModeMemory`（#33）与 `settings/saved-workflows/automationsPageTabMemory.ts`
 * —— sessionStorage + 不可用即降级；面板切侧边标签会卸载，组件 state 保不住列选择。
 * 存了不认识的值一律回落默认（不猜列）；本模块不做解析判断，只搬运字符串
 * （判据在纯函数 `parseBoardTableColumnVisibility`，便于无 storage 环境单测）。
 * 读写骨架在 `boardSessionStorage`（与视图模式共用一处，评审 #34-S1）。
 */
import { readBoardSessionValue, writeBoardSessionValue } from "./boardSessionStorage.js";
import {
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  parseBoardTableColumnVisibility,
  serializeBoardTableColumnVisibility,
  type BoardTableColumnVisibility,
} from "./boardTableViewModel.js";

const STORAGE_KEY = "zcode-board-table-columns";

export function readBoardTableColumnVisibility(): BoardTableColumnVisibility {
  const raw = readBoardSessionValue(STORAGE_KEY);
  if (raw === null) return { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY };
  try {
    return parseBoardTableColumnVisibility(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY };
  }
}

export function writeBoardTableColumnVisibility(visibility: BoardTableColumnVisibility): void {
  writeBoardSessionValue(STORAGE_KEY, serializeBoardTableColumnVisibility(visibility));
}
