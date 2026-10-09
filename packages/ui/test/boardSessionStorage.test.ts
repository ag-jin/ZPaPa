import assert from "node:assert/strict";
import test from "node:test";
import { readBoardSessionValue, writeBoardSessionValue } from "../src/board/boardSessionStorage.js";

/**
 * 看板面板会话偏好（sessionStorage）的共享骨架（评审 #34-S1：三处 try/catch 各写一份）。
 *
 * 期望值的独立真源：仓库既有先例（`settings/saved-workflows/automationsPageTabMemory.ts`）
 * 与 #33/#34 两份记忆模块的既有口径——**不可用即降级、不抛**：
 * 隐私模式 / 配额 / 纯 node 环境下，读回 null、写静默丢弃，功能照常。
 */

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function installFakeSessionStorage(impl: StorageLike): () => void {
  const holder = globalThis as { sessionStorage?: unknown };
  const before = holder.sessionStorage;
  holder.sessionStorage = impl;
  return () => {
    if (before === undefined) delete holder.sessionStorage;
    else holder.sessionStorage = before;
  };
}

test("读：无 sessionStorage（纯 node / 隐私模式）返回 null，不抛", () => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  assert.equal(readBoardSessionValue("zcode-board-test"), null);
});

test("写读往返：写入的值读回来一致", () => {
  const memory = new Map<string, string>();
  const restore = installFakeSessionStorage({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  });
  try {
    writeBoardSessionValue("zcode-board-test", "kanban");
    assert.equal(readBoardSessionValue("zcode-board-test"), "kanban");
    assert.equal(readBoardSessionValue("zcode-board-other"), null, "键各自独立");
  } finally {
    restore();
  }
});

test("storage 自身抛错（配额/被禁用）时读写都不冒泡", () => {
  const restore = installFakeSessionStorage({
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  });
  try {
    assert.equal(readBoardSessionValue("zcode-board-test"), null);
    assert.doesNotThrow(() => writeBoardSessionValue("zcode-board-test", "list"));
  } finally {
    restore();
  }
});
