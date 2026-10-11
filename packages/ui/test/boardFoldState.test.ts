import assert from "node:assert/strict";
import test from "node:test";
import {
  boardEpicFoldId,
  boardFoldDefaultExpanded,
  boardFoldIdsOfCard,
  boardPhaseFoldId,
  resolveBoardFoldOpen,
  withBoardFoldOpen,
} from "../src/board/boardFoldState.js";
import { readBoardFoldState, writeBoardFoldState } from "../src/board/boardFoldMemory.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

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

/**
 * 折叠默认态单点（卡 #89 / A4-3；AD-5）。
 *
 * 期望值的独立真源：裁决包 AD-5 原话「缺口展开 · 含活跃期次展开 · 全完成/全取消折叠（现 B2 规则
 * 递归扩展）」（itw-20261010-5372）与卡文验收「用户首次打开看到缺口与活跃期次展开、全终态组折叠」。
 * 段位词表 = `BOARD_STAGES`（已完成/已取消为终态词）。断言手推自规则，不用实现回算。
 */

test("叶级默认态：缺口展开（缺口优先，即使在终态卡上也不埋）、终态折叠、其余展开", () => {
  // 缺口优先：B2 既有口径「有 attention 缺口 → 展开」——已完成卡上带缺口（如待合并）同样展开。
  assert.equal(
    boardFoldDefaultExpanded({ attention: ["unmerged-worktree"], stage: "已完成" }),
    true,
    "已完成 + 缺口 → 展开（缺口优先，不许被埋）",
  );
  assert.equal(
    boardFoldDefaultExpanded({ attention: ["interrupted-resume"], stage: "已取消" }),
    true,
    "已取消 + 缺口 → 展开（缺口优先于终态）",
  );
  // 无缺口的叶级：终态折叠、其余展开。
  assert.equal(boardFoldDefaultExpanded({ attention: [], stage: "已完成" }), false, "已完成折叠");
  assert.equal(boardFoldDefaultExpanded({ attention: [], stage: "已取消" }), false, "已取消折叠");
  for (const stage of ["待设计", "待办", "执行中", "审核中", "阻塞"]) {
    assert.equal(
      boardFoldDefaultExpanded({ attention: [], stage }),
      true,
      `${stage} → 展开（非终态默认可见）`,
    );
  }
  // 段位缺省（层头无段位）不当作终态：默认可见，不凭空折叠。
  assert.equal(boardFoldDefaultExpanded({ attention: [], stage: null }), true, "无段位 → 展开");
});

test("容器层递归（AD-5 扩展）：含活跃期次展开、全终态折叠、缺口跨层传播（缺口组不许折叠）", () => {
  const done = { attention: [], stage: "已完成" };
  const cancelled = { attention: [], stage: "已取消" };
  const running = { attention: [], stage: "执行中" };
  const todo = { attention: [], stage: "待办" };
  const gap = { attention: ["unmerged-worktree"], stage: "已完成" };

  // 全终态（全完成/全取消）→ 折叠。
  assert.equal(
    boardFoldDefaultExpanded({ attention: [], stage: null, children: [done, cancelled] }),
    false,
    "全完成/全取消的组 → 折叠（次要一扫知大概）",
  );
  // 含活跃/未终态成员 → 展开。
  assert.equal(
    boardFoldDefaultExpanded({ attention: [], stage: null, children: [done, running] }),
    true,
    "含活跃期次 → 展开（重要信息直观展示）",
  );
  assert.equal(
    boardFoldDefaultExpanded({ attention: [], stage: null, children: [done, todo] }),
    true,
    "含待办成员 → 展开（非终态默认可见，与叶级同口径）",
  );
  // 缺口跨层传播：终态成员带缺口 → 本层展开（折叠组不得遮蔽缺口信号——OB-2 共洽点）。
  assert.equal(
    boardFoldDefaultExpanded({ attention: [], stage: null, children: [cancelled, gap] }),
    true,
    "缺口在终态成员上 → 组展开（缺口不许被埋）",
  );
  // 递归：中间层同样按本规则求值（epic ⊃ 期次 ⊃ 稿），缺口在最深处也传上来。
  assert.equal(
    boardFoldDefaultExpanded({
      attention: [],
      stage: null,
      children: [{ attention: [], stage: null, children: [done] }],
    }),
    false,
    "递归：中间层全终态 → 上层折叠（epic ⊃ 期次 ⊃ 稿逐层求值）",
  );
  assert.equal(
    boardFoldDefaultExpanded({
      attention: [],
      stage: null,
      children: [{ attention: [], stage: null, children: [running] }],
    }),
    true,
    "递归：中间层含活跃成员 → 上层展开",
  );
  // 边界：空容器（零成员）没有可藏的东西——不折叠（也不落空集全称命题的假折叠）。
  assert.equal(
    boardFoldDefaultExpanded({ attention: [], stage: null, children: [] }),
    true,
    "零成员容器 → 展开（空壳不折叠，避免空集全称命题）",
  );
});

test("会话记忆（boardSessionStorage 复用）：写什么读回什么；坏值/无存储一律回落空覆盖（= 默认态）", () => {
  // 真源：卡文「会话记忆复用 boardSessionStorage」+ AD-5 影响面。先例（视图模式/表格列/排序）：
  // 存了不认识的值一律回落默认，不猜；storage 不可用降级到空覆盖（面板照常按默认态渲染）。
  const { restore } = installFakeSessionStorage();
  try {
    assert.deepEqual(readBoardFoldState(), {}, "没有记忆时 = 空覆盖（一切按默认态）");
    writeBoardFoldState({ "epic:KANB": false, "plan:plan-boardv2-a": true });
    assert.deepEqual(
      readBoardFoldState(),
      { "epic:KANB": false, "plan:plan-boardv2-a": true },
      "写什么读回什么（会话内保持，刷新后同款）",
    );
    writeBoardFoldState({});
    assert.deepEqual(readBoardFoldState(), {}, "覆盖可清空（回默认态）");
  } finally {
    restore();
  }
  const broken = installFakeSessionStorage();
  try {
    broken.storage.setItem("zcode-board-fold-state", "{ not json");
    assert.deepEqual(readBoardFoldState(), {}, "坏 JSON → 空覆盖（不猜）");
    broken.storage.setItem("zcode-board-fold-state", '["epic:KANB"]');
    assert.deepEqual(readBoardFoldState(), {}, "非对象 → 空覆盖（不把数组当映射）");
    broken.storage.setItem(
      "zcode-board-fold-state",
      '{"epic:KANB":false,"plan:x":"yes","plan:y":1,"plan:z":true}',
    );
    assert.deepEqual(
      readBoardFoldState(),
      { "epic:KANB": false, "plan:z": true },
      "非布尔值逐条丢弃（读了不认识的值不猜语义）",
    );
  } finally {
    broken.restore();
  }
});

test("无 sessionStorage（纯 node / 隐私模式）时不抛，读回空覆盖", () => {
  assert.equal(typeof (globalThis as { sessionStorage?: unknown }).sessionStorage, "undefined");
  assert.deepEqual(readBoardFoldState(), {});
  assert.doesNotThrow(() => writeBoardFoldState({ "epic:KANB": false }));
});

test("覆盖解析与折叠 id：用户显式态优先于默认态；id 分层稳定（epic/期次/稿）", () => {
  // 真源：卡文「用户首次打开看到缺口与活跃期次展开、全终态组折叠；刷新后保持（记忆）」——
  // 记忆记的是用户动过的那一层，默认态仍由规则派生。
  assert.equal(resolveBoardFoldOpen({}, "epic:KANB", false), false, "未覆盖 → 默认态");
  assert.equal(
    resolveBoardFoldOpen({ "epic:KANB": true }, "epic:KANB", false),
    true,
    "显式展开优先",
  );
  assert.equal(
    resolveBoardFoldOpen({ "epic:KANB": false }, "epic:KANB", true),
    false,
    "显式折叠优先（缺口组的用户折叠同样是用户动作）",
  );
  const before = { "epic:KANB": false };
  const after = withBoardFoldOpen(before, "epic:KANB", true);
  assert.deepEqual(after, { "epic:KANB": true }, "覆盖写入走纯函数（返回新表）");
  assert.deepEqual(before, { "epic:KANB": false }, "不改动入参");
  assert.deepEqual(
    withBoardFoldOpen({}, "phase:KANB#2", false),
    { "phase:KANB#2": false },
    "期次层独立成键",
  );
  assert.equal(boardEpicFoldId("KANB"), "epic:KANB", "epic 层 id = 登记 id 形态");
  assert.equal(boardPhaseFoldId("KANB", 2), "phase:KANB#2", "期次层 id = 码 + 期次序");
  assert.notEqual(boardEpicFoldId("KANB"), boardPhaseFoldId("KANB", 1), "两层 id 不撞键");
});

test("跳转揭示判据：卡片 → 祖先折叠 id 集（稿 → 期次 → epic 自内向外；无归属稿只回稿层）", () => {
  // 真源：消费契约 §13.7 B2「跳转落点在折叠块内时宿主先展开再滚动」+ 表格条件渲染（折叠组的行
  // 不在 DOM 里）：揭示要先展开目标所在的三层容器，否则跳了个寂寞。
  const board = readyBoard(EPIC_BOARD);
  assert.deepEqual(
    boardFoldIdsOfCard(board, "task:87"),
    ["plan:plan-boardv2-a", "epic:KANB", "phase:KANB#1"],
    "卡号（嵌套任务）→ 所属稿 + 期次 + epic 三层",
  );
  assert.deepEqual(
    boardFoldIdsOfCard(board, "plan:plan-boardv2-a"),
    ["plan:plan-boardv2-a", "epic:KANB", "phase:KANB#1"],
    "稿 id 自身同样回三层（稿层折叠块也是落点容器）",
  );
  assert.deepEqual(
    boardFoldIdsOfCard(board, "spec:preview-channel"),
    ["spec:preview-channel"],
    "无归属稿：只回稿层（不造不存在的容器）",
  );
  assert.deepEqual(
    boardFoldIdsOfCard(board, "plan:plan-by-number"),
    ["plan:plan-by-number"],
    "稳定号引用稿不归组：只回稿层",
  );
  assert.deepEqual(
    boardFoldIdsOfCard(board, "plan:plan-cancelled-epic"),
    ["plan:plan-cancelled-epic", "epic:CNCL", "phase:CNCL#1"],
    "终态 epic 成员照常回三层（登记行终态不影响归属）",
  );
  assert.deepEqual(boardFoldIdsOfCard(board, "task:404"), [], "板上没有的卡 → 空集（不猜）");
});
