import assert from "node:assert/strict";
import test from "node:test";
import {
  readBoardTableColumnVisibility,
  writeBoardTableColumnVisibility,
} from "../src/board/boardTableColumnMemory.js";
import {
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  toggleBoardTableColumn,
  visibleBoardTableColumns,
} from "../src/board/boardTableViewModel.js";

/**
 * 列选择的会话记忆（卡 #34：「列可配置，选择持久会话内」）。
 *
 * 期望值的独立真源：派发指令（列可配置 + 选择持久会话内；与 #33 视图模式同 sessionStorage 先例）
 * 与 `#33 boardViewModeMemory` 的既有口径（不可用即降级、存了不认识的值回落默认）。
 */

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function installFakeSessionStorage(): { storage: StorageLike; restore: () => void } {
  const memory = new Map<string, string>();
  const holder = globalThis as { sessionStorage?: unknown };
  const before = holder.sessionStorage;
  holder.sessionStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  };
  return {
    storage: holder.sessionStorage as StorageLike,
    restore: () => {
      if (before === undefined) delete holder.sessionStorage;
      else holder.sessionStorage = before;
    },
  };
}

test("列选择写什么读回什么（会话内保持），且与视图模式各用各的键", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    assert.deepEqual(
      visibleBoardTableColumns(readBoardTableColumnVisibility()),
      visibleBoardTableColumns(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY),
      "没有记忆时 = 默认列（全可见）",
    );
    const hidden = toggleBoardTableColumn(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, "assignees");
    writeBoardTableColumnVisibility(hidden);
    assert.deepEqual(readBoardTableColumnVisibility(), hidden, "隐藏状态读回来一致");
    assert.equal(
      storage.getItem("zcode-board-view-mode"),
      null,
      "列选择不借视图模式的键（两份会话偏好互不覆盖）",
    );
  } finally {
    restore();
  }
});

test("会话记忆不猜列：坏 JSON / 存了不认识的列 → 回落默认（不半渲染）", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    storage.setItem("zcode-board-table-columns", "{ not json");
    assert.deepEqual(readBoardTableColumnVisibility(), {
      ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
    });
    storage.setItem("zcode-board-table-columns", JSON.stringify(["stage", "future-column"]));
    assert.deepEqual(visibleBoardTableColumns(readBoardTableColumnVisibility()), ["stage"]);
  } finally {
    restore();
  }
});

test("无 sessionStorage（纯 node / 隐私模式）时不抛，读回默认值", () => {
  assert.equal(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage, "undefined");
  assert.deepEqual(readBoardTableColumnVisibility(), { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY });
  assert.doesNotThrow(() =>
    writeBoardTableColumnVisibility(
      toggleBoardTableColumn(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, "age"),
    ),
  );
});
