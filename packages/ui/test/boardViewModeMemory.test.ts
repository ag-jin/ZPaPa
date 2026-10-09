import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { readBoardViewMode, writeBoardViewMode } from "../src/board/boardViewModeMemory.js";
import {
  BOARD_VIEW_MODES,
  BOARD_VIEW_MODE_MESSAGE_IDS,
  type BoardViewMode,
} from "../src/board/boardViewsViewModel.js";

/**
 * 视图切换的会话记忆（卡 #33：「切换状态会话内保持」）。
 *
 * 期望值的独立真源：任务卡 #33 需求 3（面板内 树形/看板/列表 三态切换、切换状态会话内保持）
 * 与消费契约 §13.2（四视图共用同一份板数据，视图差异只在呈现层）。
 * 实现先例：`settings/saved-workflows/automationsPageTabMemory.ts`（sessionStorage + 不可用即降级）。
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

test("视图切换：写什么读回什么（会话内保持），缺省回落树形（tracer 的既有视图）", () => {
  const { restore } = installFakeSessionStorage();
  try {
    assert.equal(readBoardViewMode(), "tree", "没有记忆时默认树形");
    writeBoardViewMode("kanban");
    assert.equal(readBoardViewMode(), "kanban");
    writeBoardViewMode("list");
    assert.equal(readBoardViewMode(), "list");
    writeBoardViewMode("tree");
    assert.equal(readBoardViewMode(), "tree");
  } finally {
    restore();
  }
});

test("会话记忆不猜视图：存了不认识的值 → 回落树形", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    storage.setItem("zcode-board-view-mode", "timeline");
    assert.equal(readBoardViewMode(), "tree");
  } finally {
    restore();
  }
});

test("无 sessionStorage（纯 node / 隐私模式）时不抛，读回默认值", () => {
  assert.equal(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage, "undefined");
  assert.equal(readBoardViewMode(), "tree");
  assert.doesNotThrow(() => writeBoardViewMode("kanban"));
});

test("三视图闭集与词条 id：zh/en 两语都齐（不出现裸 key）", () => {
  assert.deepEqual([...BOARD_VIEW_MODES], ["tree", "kanban", "list"]);
  for (const mode of BOARD_VIEW_MODES) {
    const messageId = BOARD_VIEW_MODE_MESSAGE_IDS[mode as BoardViewMode];
    assert.ok(messageId, `${mode} 应有词条 id`);
    assert.ok(zhCN[messageId], `${mode} 缺 zh-CN 词条：${messageId}`);
    assert.ok(enUS[messageId], `${mode} 缺 en-US 词条：${messageId}`);
  }
});
