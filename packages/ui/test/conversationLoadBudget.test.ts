import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECTORY_HYDRATION_MAX_WINDOW_ROWS,
  LEADING_TURN_AUTOLOAD_MAX_WINDOW_ROWS,
  shouldAutoLoadIncompleteLeadingTurn,
  shouldStopDirectoryHydration,
  withinLeadingTurnAutoloadBudget,
} from "../src/v4/conversationProjectionStore.js";
import {
  shouldHydrateConversationTurnNavigatorDirectory,
  shouldRenderConversationTurnNavigatorRail,
  shouldRequestTurnNavigatorDirectory,
} from "../src/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

/**
 * 长会话「打开/切换要不要等」的加载预算（2026-10-01 实测缺陷）。
 *
 * 实测基线：最长会话（DB 20430 parts）冷开只发布 60 行尾窗，但随后
 *   · pane 侧「首 turn 不完整」逐窗补拉：窄窗口 181 次、跨度 96.7 秒，主线程往返 p50 360ms；
 *   · 宽屏问题目录一次性补拉：一次把 11042 行换进快照，冻结主线程 2.1s，切换会话阻塞 ~4.5s。
 * 用户感知就是「长会话打开/切过去要等一会」。
 *
 * 两条预算：首 turn 补窗有行数上限；目录补拉改为用户伸手才做（rail 保留入口）。
 */

const turnHeader = (turnId: string, rowId: number): ConversationRow =>
  ({ rowId, turnId, kind: "turnHeader" }) as unknown as ConversationRow;
const part = (turnId: string, rowId: number): ConversationRow =>
  ({ rowId, turnId, kind: "assistantText" }) as unknown as ConversationRow;

const snapshotWithWindow = (window: ConversationRow[]): ConversationSnapshot =>
  ({
    rows: { window, firstRowId: 0, totalCount: 99_999 },
  }) as unknown as ConversationSnapshot;

/** 复刻 SessionPane 的接线：不完整 + 预算内才继续补窗。 */
const shouldKeepAutoLoadingLeadingTurn = (
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean =>
  shouldAutoLoadIncompleteLeadingTurn(snapshot, loadingOlder) &&
  withinLeadingTurnAutoloadBudget(snapshot);

test("首 turn 不完整：窗口里没有本轮 header 时才补窗", () => {
  const incomplete = snapshotWithWindow([part("t1", 100), part("t1", 101), part("t2", 102)]);
  const complete = snapshotWithWindow([turnHeader("t1", 100), part("t1", 101)]);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(incomplete, false), true);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(complete, false), false);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(incomplete, true), false, "补拉在途不重入");
});

test("首 turn 补窗有行数预算：巨型 turn 不追到底", () => {
  const underBudget = snapshotWithWindow(
    Array.from({ length: LEADING_TURN_AUTOLOAD_MAX_WINDOW_ROWS - 1 }, (_, i) => part("t1", i + 1)),
  );
  const atBudget = snapshotWithWindow(
    Array.from({ length: LEADING_TURN_AUTOLOAD_MAX_WINDOW_ROWS }, (_, i) => part("t1", i + 1)),
  );
  // 两边的「首 turn 完整性」判定都为真 —— 唯一差别是预算。
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(underBudget, false), true);
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(atBudget, false), true);
  assert.equal(withinLeadingTurnAutoloadBudget(underBudget), true);
  assert.equal(withinLeadingTurnAutoloadBudget(atBudget), false);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(underBudget, false), true);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(atBudget, false), false);
});

test("首 turn 补窗预算：空快照 / 缺失快照一律不补", () => {
  assert.equal(withinLeadingTurnAutoloadBudget(null), false);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(null, false), false);
  assert.equal(shouldKeepAutoLoadingLeadingTurn(snapshotWithWindow([]), false), false);
});

test("目录补拉资格：宽屏 + 可拉 + 非在途 + 有处理器", () => {
  const base = {
    canLoadOlder: true,
    containerWidthPx: 2032,
    hasLoadHandler: true,
    loadingOlder: false,
  };
  assert.equal(shouldHydrateConversationTurnNavigatorDirectory(base), true);
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, canLoadOlder: false }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, loadingOlder: true }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, hasLoadHandler: false }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, containerWidthPx: 628 }),
    false,
    "rail 的宽度资格线：窄于 864px 时 rail 本身不显形",
  );
});

test("rail 显形：目录未补齐时即使没有可导航轮次也要留出入口", () => {
  assert.equal(
    shouldRenderConversationTurnNavigatorRail({ itemCount: 0, directoryIncomplete: true }),
    true,
  );
  assert.equal(
    shouldRenderConversationTurnNavigatorRail({ itemCount: 1, directoryIncomplete: true }),
    true,
  );
  assert.equal(
    shouldRenderConversationTurnNavigatorRail({ itemCount: 5, directoryIncomplete: false }),
    true,
  );
  assert.equal(
    shouldRenderConversationTurnNavigatorRail({ itemCount: 1, directoryIncomplete: false }),
    false,
    "既没有可导航轮次、目录也已补齐 → 不显形（保持既有行为）",
  );
});

test("目录补拉只在伸手时发起：未补齐 + 有处理器 + 非在途", () => {
  const base = { directoryIncomplete: true, hasRequestHandler: true, hydrating: false };
  assert.equal(shouldRequestTurnNavigatorDirectory(base), true);
  assert.equal(shouldRequestTurnNavigatorDirectory({ ...base, directoryIncomplete: false }), false);
  assert.equal(shouldRequestTurnNavigatorDirectory({ ...base, hasRequestHandler: false }), false);
  assert.equal(shouldRequestTurnNavigatorDirectory({ ...base, hydrating: true }), false);
});

test("目录补拉有行数预算：到预算即停，不等「没有更早历史」", () => {
  // 没有更早历史 → 停（既有语义）
  assert.equal(shouldStopDirectoryHydration({ hydratedRows: 0, hasMore: false }), true);
  // 还有更早历史，但已到预算 → 停（本次新增：避免整段历史换进窗口）
  assert.equal(
    shouldStopDirectoryHydration({
      hydratedRows: DIRECTORY_HYDRATION_MAX_WINDOW_ROWS,
      hasMore: true,
    }),
    true,
  );
  assert.equal(
    shouldStopDirectoryHydration({
      hydratedRows: DIRECTORY_HYDRATION_MAX_WINDOW_ROWS - 1,
      hasMore: true,
    }),
    false,
    "预算之内且还有历史 → 继续拉",
  );
  assert.ok(
    DIRECTORY_HYDRATION_MAX_WINDOW_ROWS < 11_042,
    "预算必须显著小于实测最长会话的整段历史（11042 行），否则等于没设",
  );
});
