/**
 * 表格列选择的会话记忆（卡 #34：「列可配置，选择持久会话内」）。
 *
 * 先例：`boardViewModeMemory`（#33）与 `settings/saved-workflows/automationsPageTabMemory.ts`
 * —— sessionStorage + 不可用即降级；面板切侧边标签会卸载，组件 state 保不住列选择。
 * 存了不认识的值一律回落默认（不猜列）；本模块不做解析判断，只搬运字符串
 * （判据在纯函数 `parseBoardTableColumnVisibility`，便于无 storage 环境单测）。
 */
import {
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  parseBoardTableColumnVisibility,
  serializeBoardTableColumnVisibility,
  type BoardTableColumnVisibility,
} from "./boardTableViewModel.js";

const STORAGE_KEY = "zcode-board-table-columns";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readBoardTableColumnVisibility(): BoardTableColumnVisibility {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY };
    return parseBoardTableColumnVisibility(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY };
  }
}

export function writeBoardTableColumnVisibility(visibility: BoardTableColumnVisibility): void {
  try {
    storage()?.setItem(STORAGE_KEY, serializeBoardTableColumnVisibility(visibility));
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额）就不记：下次打开回到默认列，不影响功能。
  }
}
