/**
 * `dispatch` 派生段（提案形状 `dispatch/1`）的只读消费测试（卡 #185）。
 *
 * 期望值独立真源：`skills/zcode-board/assets/tools/next-dispatch.mjs --json` 的结论字段
 * （夹具构建器 `boardDispatchFixture` 在临时项目根上实跑该工具并把结论搬进板夹具；
 * 本测试断言 UI 解析层**逐字段照读** CLI 结论——成员/顺序/计数不重排、不改判据）。
 *
 * 未就绪纪律（契约 §13.6 同姿态）：缺段/坏形态 → `dispatchIndex === null`，UI 不猜、不自行派生。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { buildDispatchFixture, cleanupDispatchFixture } from "./boardDispatchFixture.js";

function readyBoardOf(raw: Record<string, unknown>) {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是可渲染的 v2 板");
  if (outcome.kind !== "ready") throw new Error("unreachable");
  return outcome.board;
}

test("编排派生段：缺段/坏形态 → null（未就绪，不猜不自算）", () => {
  const fixture = buildDispatchFixture({ withDispatch: false });
  try {
    // ① 缺段（当前真实板的形态）：四段派生照常在，但编排派生段缺席 → null。
    const missing = readyBoardOf(fixture.boardRaw);
    assert.ok(missing.derivedIndex, "夹具四段齐备（缺的只是 dispatch 段）");
    assert.equal(missing.dispatchIndex, null, "缺 dispatch 段 → 未就绪（不按板字段自算兜底）");

    // ② 坏形态：非对象 / 关键数组缺席 —— 整段按未就绪处置（不部分渲染制造假象）。
    for (const bad of [
      { dispatch: 42 },
      {
        dispatch: {
          capacity: 12,
          inFlight: { count: 0, slotsFree: 12, cards: [] },
          dispatchable: [],
          parallelGroup: [],
          needsReview: [],
        },
      },
      {
        dispatch: {
          capacity: 12,
          inFlight: { count: 0, slotsFree: 12, cards: [] },
          dispatchable: [],
          parallelGroup: [],
          needsReview: [],
          blocked: "nope",
        },
      },
    ]) {
      const board = readyBoardOf({ ...fixture.boardRaw, ...bad });
      assert.equal(
        board.dispatchIndex,
        null,
        `坏形态应按未就绪处置：${JSON.stringify(bad).slice(0, 60)}`,
      );
    }
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排派生段：逐字段照读 CLI 结论（成员/顺序/计数/域/归因类别不重排、不改判据）", () => {
  const fixture = buildDispatchFixture();
  try {
    const board = readyBoardOf(fixture.boardRaw);
    const index = board.dispatchIndex;
    assert.ok(index, "含 dispatch 段（proposal 形状）→ 映射可用");
    const cli = fixture.cli;

    // 可派清单：号位与顺序 = CLI dispatchable（rank 序照读）；域文本照读。
    assert.deepEqual(
      index.dispatchable.map((card) => card.no),
      cli.dispatchable.map((card) => card.no),
      "可派清单号位与顺序 = CLI 结论",
    );
    assert.deepEqual(
      index.dispatchable[0]?.domain,
      cli.dispatchable[0]?.domain,
      "域映射（files/source/confidence/unknown）逐字段照读",
    );
    assert.deepEqual(index.parallelGroup, cli.parallelGroup, "并发组号位与顺序 = CLI");
    assert.deepEqual(index.needsReview, cli.needsReview, "域未知清单 = CLI");

    // 在途：计数/槽位/成员与域（CLI 在途判据的结论面，UI 不重推）。
    assert.equal(index.inFlight.count, cli.inFlight.count, "在途计数 = CLI");
    assert.equal(index.inFlight.slotsFree, cli.inFlight.slotsFree, "剩余槽位 = CLI");
    assert.equal(index.capacity, cli.capacity, "并发上限 = CLI");
    assert.deepEqual(
      index.inFlight.cards.map((card) => card.no),
      cli.inFlight.cards.map((card) => card.no),
      "在途成员与顺序 = CLI（域占随行的主体）",
    );

    // 不可派逐张证据：类别/号位/在途标记/域占细节照读。
    assert.deepEqual(
      index.blocked.map((entry) => ({ no: entry.no, kind: entry.kind, by: entry.by })),
      cli.blocked.map((entry) => ({ no: entry.no, kind: entry.kind, by: entry.by })),
      "不可派条目（卡号/类别/号位）= CLI",
    );
    const domainEntry = index.blocked.find((entry) => entry.kind === "domain");
    assert.equal(domainEntry?.detail[0]?.occupiedBy, 104, "域占细节（占域在途卡号）照读");
    const inFlightTarget = index.blocked.find((entry) => entry.targetInFlight === true);
    assert.equal(inFlightTarget?.no, 105, "dependency 段在途目标标记照读");
    assert.equal(
      index.blocked.find((entry) => entry.no === 107)?.targetInFlight,
      false,
      "未在途目标标记照读（不自算）",
    );
  } finally {
    cleanupDispatchFixture(fixture);
  }
});
