/**
 * 编排视图（#185）视图模型的断言（SSR 渲染断言在 `boardDispatchRender.test.ts`）。
 *
 * 期望值独立真源：`next-dispatch.mjs --json`（夹具构建器在临时项目根实跑该工具，结论搬进板，
 * 见 `boardDispatchFixture`）。三区呈现的成员/顺序/计数一律对 CLI 结论断言——UI 若自算走样，
 * 本套件即红；反例/突变以「板改判」的第二夹具验证两处同步变。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildBoardDispatchSummary } from "../src/board/boardDispatchViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { buildDispatchFixture, cleanupDispatchFixture } from "./boardDispatchFixture.js";

function readyBoardOf(raw: Record<string, unknown>) {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是可渲染的 v2 板");
  if (outcome.kind !== "ready") throw new Error("unreachable");
  return outcome.board;
}

test("编排视图模型：三区行直取 dispatch 段（可派/阻塞/并发组），与 CLI 结论逐项一致", () => {
  const fixture = buildDispatchFixture();
  try {
    const board = readyBoardOf(fixture.boardRaw);
    const summary = buildBoardDispatchSummary(board);
    const cli = fixture.cli;

    assert.equal(summary.availability, "ready", "含 dispatch 段 → 就绪");
    // 可派清单：号位/顺序 = CLI dispatchable（frontier rank 序扣在途/扣域占，UI 不重排）。
    assert.deepEqual(
      summary.dispatchable.map((row) => row.no),
      cli.dispatchable.map((card) => card.no),
      "可派清单与 CLI 逐项一致（号位与顺序）",
    );
    assert.equal(summary.dispatchable[0]?.id, "task:102", "行身份 = 既有弹窗路由锚点（task:<no>）");
    assert.equal(summary.dispatchable[0]?.nextAssignee, "implementer", "接手位直读");
    assert.deepEqual(
      summary.dispatchable.map((row) => row.domainUnknown),
      cli.dispatchable.map((card) => card.domain.unknown),
      "域未知标记 = CLI needsReview 判据面（照读）",
    );

    // 阻塞归因：逐卡类别/号位/在途标记 = CLI blocked。
    assert.deepEqual(
      summary.blocked.map((row) => ({ no: row.no, kind: row.kind, by: row.by })),
      cli.blocked.map((entry) => ({ no: entry.no, kind: entry.kind, by: entry.by })),
      "阻塞归因与 CLI 逐项一致",
    );
    assert.equal(
      summary.blocked.find((row) => row.no === 105)?.targetInFlight,
      true,
      "依赖在途标记直读（targetInFlight）",
    );
    assert.equal(
      summary.blocked.find((row) => row.no === 107)?.targetInFlight,
      false,
      "依赖未在途标记直读",
    );

    // 并发组：号位/顺序 = CLI parallelGroup；槽位计数 = CLI。
    assert.deepEqual(
      summary.parallelGroup.map((row) => row.no),
      cli.parallelGroup,
      "并发组与 CLI 逐项一致",
    );
    assert.equal(summary.capacity, cli.capacity, "并发上限 = CLI");
    assert.equal(summary.inFlightCount, cli.inFlight.count, "在途计数 = CLI");
    assert.equal(summary.slotsFree, cli.inFlight.slotsFree, "剩余槽位 = CLI");
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排视图模型：缺段 → 未就绪（不得按 frontier/blocked 自算兜底）", () => {
  const fixture = buildDispatchFixture({ withDispatch: false });
  try {
    const board = readyBoardOf(fixture.boardRaw);
    // 反例咬点：夹具板自身 frontier 有 6 张、blocked 有 2 条——自算兜底会渲染出三区行。
    assert.ok((board.derivedIndex?.frontier.length ?? 0) > 0, "夹具 frontier 非空（自算会得非空）");
    const summary = buildBoardDispatchSummary(board);
    assert.equal(summary.availability, "missing", "缺 dispatch 段 → 未就绪");
    assert.deepEqual(summary.dispatchable, [], "未就绪不渲染可派行（不自算）");
    assert.deepEqual(summary.blocked, [], "未就绪不渲染阻塞归因行（不自算）");
    assert.deepEqual(summary.parallelGroup, [], "未就绪不渲染并发组（不自算）");
    assert.equal(summary.capacity, null, "未就绪无并发上限（不猜缺省 12）");
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排视图模型：板改判 → 两处（CLI 与 UI 投影）同步变（反例）", () => {
  const base = buildDispatchFixture({ variant: "base" });
  const mutated = buildDispatchFixture({ variant: "mutated" });
  try {
    const baseSummary = buildBoardDispatchSummary(readyBoardOf(base.boardRaw));
    const mutatedSummary = buildBoardDispatchSummary(readyBoardOf(mutated.boardRaw));

    // CLI 两侧本来就不同（夹具反例的独立性锚点：不是同一份结论被读两遍）。
    assert.notDeepEqual(
      base.cli.dispatchable,
      mutated.cli.dispatchable,
      "夹具反例：CLI 两侧结论不同",
    );
    // UI 投影随板改判同步变：可派面/阻塞面/并发组三区都变。
    assert.notDeepEqual(
      baseSummary.dispatchable.map((row) => row.no),
      mutatedSummary.dispatchable.map((row) => row.no),
      "可派面随改判变",
    );
    assert.deepEqual(
      mutatedSummary.dispatchable.map((row) => row.no),
      mutated.cli.dispatchable.map((c) => c.no),
    );
    assert.deepEqual(
      baseSummary.blocked.map((row) => row.no),
      [101, 105, 107],
      "改判前：域占 + 两条依赖",
    );
    assert.deepEqual(mutatedSummary.blocked, [], "改判后：阻塞段清空（#104 出在途、#107 解除）");
    assert.deepEqual(
      baseSummary.parallelGroup.map((row) => row.no),
      base.cli.parallelGroup,
      "改判前并发组 = CLI",
    );
    assert.deepEqual(
      mutatedSummary.parallelGroup.map((row) => row.no),
      mutated.cli.parallelGroup,
      "改判后并发组 = CLI",
    );
  } finally {
    cleanupDispatchFixture(base);
    cleanupDispatchFixture(mutated);
  }
});
