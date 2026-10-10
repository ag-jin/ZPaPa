import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BOARD_LIST_SORT,
  readBoardListSort,
  writeBoardListSort,
} from "../src/board/boardListSortMemory.js";
import { BOARD_VIEW_SORTS } from "../src/board/boardViewSorting.js";

/**
 * 列表/表格排序选择的会话记忆（卡 #65：「选择进会话记忆」，复用 `boardViewModeMemory` 形态）。
 *
 * 期望值的独立真源：卡 #65 目标 (2) 与消费契约 §3.5——默认视角 = 契约序（attention 置顶 +
 * `updatedAt` 倒序 + 已完成沉底），用户主动切换的视角（最老未动 / 段位序）在会话内保持。
 * 实现先例：`boardViewModeMemory` / `boardTableColumnMemory`（sessionStorage + 不可用即降级）。
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

test("排序会话记忆（#65）：写什么读回什么（切视图/重开面板不丢），缺省回落契约序", () => {
  const { restore } = installFakeSessionStorage();
  try {
    assert.equal(readBoardListSort(), "recent", "没有记忆时默认 = 契约序");
    assert.equal(DEFAULT_BOARD_LIST_SORT, "recent");
    for (const sort of BOARD_VIEW_SORTS) {
      writeBoardListSort(sort);
      assert.equal(readBoardListSort(), sort, `${sort} 应写什么读回什么`);
    }
  } finally {
    restore();
  }
});

test("排序会话记忆不猜视角：存了不认识的值 → 回落契约序", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    storage.setItem("zcode-board-list-sort", "priority");
    assert.equal(readBoardListSort(), "recent");
  } finally {
    restore();
  }
});

test("无 sessionStorage（纯 node / 隐私模式）时不抛，读回默认值", () => {
  assert.equal(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage, "undefined");
  assert.equal(readBoardListSort(), "recent");
  assert.doesNotThrow(() => writeBoardListSort("stage"));
});
