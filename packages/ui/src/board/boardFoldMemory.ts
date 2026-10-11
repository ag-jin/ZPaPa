/**
 * 折叠态的会话记忆（卡 #89 / A4-3；AD-5「会话记忆复用 boardSessionStorage」）。
 *
 * 边界（卡文口径）：**会话记忆**住在 sessionStorage——面板切侧边标签会卸载、页面刷新会重挂，
 * 组件 state 保不住用户手动折叠过的组；sessionStorage 在**同一标签会话内（含刷新）保持**，
 * 关标签/新会话回默认态。与视图模式（#33）、表格列选择（#34）、排序视角（#65）同一先例与同一
 * 存储骨架（`boardSessionStorage`：读回 null、写静默丢弃，功能照常）。
 *
 * 记的是**用户显式覆盖**（`foldId → 展开态`），不是"所有组的当前态"——默认态由数据（缺口/段位）
 * 派生，只有用户动过的组才落键；数据变化时未动过的组照新默认态走。
 * 不落板文件（消费契约 §7.1：面板不写任何东西）。
 */
import { readBoardSessionValue, writeBoardSessionValue } from "./boardSessionStorage.js";
import {
  parseBoardFoldState,
  serializeBoardFoldState,
  type BoardFoldState,
} from "./boardFoldState.js";

const STORAGE_KEY = "zcode-board-fold-state";

export function readBoardFoldState(): BoardFoldState {
  return parseBoardFoldState(readBoardSessionValue(STORAGE_KEY));
}

export function writeBoardFoldState(state: BoardFoldState): void {
  writeBoardSessionValue(STORAGE_KEY, serializeBoardFoldState(state));
}
