import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
 * 视图切换的会话记忆（卡 #33：「切换状态会话内保持」；卡 #140/C3-5：默认视图 tree→guide + 旧偏好迁移）。
 *
 * 期望值的独立真源：卡 #33 需求 3（面板内切换、切换状态会话内保持）；卡 #140 验收（用户首次打开
 * 落在指引面，可一键切树形且选择被记住、刷新保持；四视图入口不删）与 `.zcode/design/
 * adjudication-board-v2.md` AD-11①（默认视图切指引面，树形保留结构视图）。
 * 旧偏好迁移语义（#140 成文）：记忆只存用户显式选择——键/取值格式不变，存量显式值（含旧默认
 * tree）原样尊重；只有「无记忆」与「坏值」回落新默认，不做一次性覆盖。
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

test("视图切换：写什么读回什么（会话内保持），无记忆回落指引面（C3-5/#140；AD-11①）", () => {
  const { restore } = installFakeSessionStorage();
  try {
    assert.equal(readBoardViewMode(), "guide", "没有记忆时默认指引面（第一眼=正在执行的计划）");
    writeBoardViewMode("tree");
    assert.equal(readBoardViewMode(), "tree", "一键切树形被记住");
    writeBoardViewMode("kanban");
    assert.equal(readBoardViewMode(), "kanban");
    writeBoardViewMode("list");
    assert.equal(readBoardViewMode(), "list");
    writeBoardViewMode("table");
    assert.equal(readBoardViewMode(), "table", "表格视图也记（卡 #34）");
    writeBoardViewMode("dispatch");
    assert.equal(readBoardViewMode(), "dispatch", "编排面也记（#185）");
    writeBoardViewMode("guide");
    assert.equal(readBoardViewMode(), "guide", "切回指引面也记（六态闭集都进记忆）");
  } finally {
    restore();
  }
});

test("会话记忆不猜视图：存了不认识的值 → 回落默认（指引面）", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    storage.setItem("zcode-board-view-mode", "timeline");
    assert.equal(readBoardViewMode(), "guide");
  } finally {
    restore();
  }
});

test("旧偏好迁移（C3-5/#140）：存量显式偏好原样尊重，只有无记忆/坏值才落新默认", () => {
  const { storage, restore } = installFakeSessionStorage();
  try {
    // 键与取值格式自 #33 起未变：升级后存量会话里的显式选择直接读回（无版本位、不覆盖）。
    for (const stored of ["tree", "kanban", "list", "table"] as const) {
      storage.setItem("zcode-board-view-mode", stored);
      assert.equal(readBoardViewMode(), stored, `存量显式偏好 ${stored} 不被新默认覆盖`);
    }
    // 反例：存量「tree」是显式偏好，不是本次默认切换要改写的对象——切新默认后仍读回 tree。
    storage.setItem("zcode-board-view-mode", "tree");
    assert.equal(readBoardViewMode(), "tree", "显式 tree 偏好保持（迁移不静默改用户选择）");
  } finally {
    restore();
  }
});

test("无 sessionStorage（纯 node / 隐私模式）时不抛，读回默认值", () => {
  assert.equal(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage, "undefined");
  assert.equal(readBoardViewMode(), "guide");
  assert.doesNotThrow(() => writeBoardViewMode("kanban"));
});

test("默认视图单点（源码守卫；C3-5/#140）：常量只定义一处，板域生产代码无第二处视图名缺省字面量", () => {
  // #176/S2 同款纪律（默认视角四处手写收敛单常量）：本卡的默认视图也必须单点——
  // 组件缺省参数引用常量，任何人再写回 "tree"/"guide" 字面量本守卫即红（grep 无第二处）。
  const srcDir = new URL("../src/board/", import.meta.url);
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  assert.ok(files.length > 20, `板域生产文件应被扫到（实扫 ${files.length} 个）`);
  const definitions: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, srcDir), "utf8");
    assert.doesNotMatch(
      source,
      /\bviewMode\s*[:=]\s*"(guide|dispatch|tree|kanban|list|table)"/,
      `${file}: 视图缺省不得写视图名字面量（引用 DEFAULT_BOARD_VIEW_MODE）`,
    );
    for (const match of source.matchAll(/export const DEFAULT_BOARD_VIEW_MODE/g)) {
      definitions.push(`${file}:${match.index}`);
    }
  }
  assert.equal(definitions.length, 1, `默认视图常量定义恰一处：${definitions.join(" / ")}`);
});

test("视图闭集与词条 id：zh/en 两语都齐（不出现裸 key）", () => {
  // #136/C3-1 增「指引面」guide 于队首（可选项；缺省切换与旧偏好迁移归 #140/C3-5）；
  // #185 增「编排」dispatch 于 guide 之后（三区：可派清单/阻塞归因/并发组；结构四视图不删）。
  assert.deepEqual([...BOARD_VIEW_MODES], ["guide", "dispatch", "tree", "kanban", "list", "table"]);
  for (const mode of BOARD_VIEW_MODES) {
    const messageId = BOARD_VIEW_MODE_MESSAGE_IDS[mode as BoardViewMode];
    assert.ok(messageId, `${mode} 应有词条 id`);
    assert.ok(zhCN[messageId], `${mode} 缺 zh-CN 词条：${messageId}`);
    assert.ok(enUS[messageId], `${mode} 缺 en-US 词条：${messageId}`);
  }
});
