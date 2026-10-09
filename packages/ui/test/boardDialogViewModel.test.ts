import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_DIALOG_ORIGIN_KEYS,
  boardCardDialogKeyIntent,
  boardJumpRequiresListView,
  buildBoardCardDialog,
  resolveBoardCardJumpTarget,
  resolveBoardDialogNode,
} from "../src/board/boardDialogViewModel.js";
import { collectBoardViewNodes, type BoardViewNode } from "../src/board/boardViewsViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 卡片弹窗的字段映射纯函数缝（卡 #34，契约 §6「弹窗契约」逐字）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §6（各区块与约束）+
 * §6.1（时间线语义：只展示 lastRun，不承诺 activity 全文）+ 勘误 4（弹窗数据全部来自被点卡片自身）。
 * 实例期望逐条写死在本文件（节点 id 见 boardTestFixture 的形态夹具注释），不由实现回算。
 */

function goldenBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function nodeOf(board: BoardViewModel, id: string): BoardViewNode {
  const node = collectBoardViewNodes(board).find((entry) => entry.id === id);
  assert.ok(node, `夹具里应有节点 ${id}`);
  return node;
}

test("弹窗字段映射：编号/名称/状态/细节/最近执行（契约 §6 上三区块）", () => {
  const board = goldenBoard();
  const dialog = buildBoardCardDialog(board, nodeOf(board, "task:8"));
  assert.equal(dialog.id, "task:8", "弹窗身份 = 被点卡片自身（勘误 4：不读其他文件）");
  assert.equal(dialog.no, 8);
  assert.equal(dialog.label, "1.2");
  assert.equal(dialog.title, "让开关立刻生效（核心）");
  assert.equal(dialog.kind, "task");
  assert.equal(dialog.status, "active");
  assert.equal(dialog.stage, "执行中");
  assert.deepEqual(dialog.attention, ["interrupted-resume", "unmerged-worktree"]);
  assert.deepEqual(dialog.activeRun, { role: "implementer", at: "2026-10-09T14:20:00+08:00" });
  assert.equal(
    dialog.details,
    "把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。",
    "细节区块 = details 全文",
  );
  assert.ok(dialog.lastRun, "最近执行区块的数据基础");
  assert.equal(dialog.lastRun?.result, "partial");
  assert.equal(dialog.lastRun?.stoppedAt, 8);
  assert.equal(dialog.updatedAt, "2026-10-09T14:20:00+08:00");
  assert.equal(dialog.createdAt, "2026-10-08T10:00:00+08:00");
  assert.equal(dialog.worktree, ".zcode/worktrees/task-8");
});

test("弹窗字段映射：details 空串 → null（区块隐藏，不渲染空段落）", () => {
  const board = goldenBoard();
  const card7 = buildBoardCardDialog(board, nodeOf(board, "task:7"));
  assert.equal(card7.details, null, "空串 details 不在弹窗里渲染成空区块");
  const plan = buildBoardCardDialog(board, nodeOf(board, "plan:sess_f1a2d0bb"));
  assert.equal(plan.details, null);
  assert.equal(plan.kind, "feature");
  assert.equal(
    plan.id,
    "plan:sess_f1a2d0bb",
    "特性节点走同一模型（kind 只是标记，不另造一套弹窗）",
  );
  assert.equal(plan.showBlockers, false, "特性级的阻拦区块恒隐藏");
});

test("弹窗阻拦区块：external 显示 summary + 证据；特性节点恒隐藏（契约 §6 约束）", () => {
  const board = goldenBoard();
  const card7 = buildBoardCardDialog(board, nodeOf(board, "task:7"));
  assert.equal(card7.showBlockers, true, "任务卡有 blockers → 区块可见");
  assert.equal(card7.blockers.length, 1);
  assert.deepEqual(card7.blockers[0], {
    index: 0,
    kind: "external",
    summary: "dev 污染 atom feed 待验证（决定方案 (a)/(b)）",
    evidence: ["specs/preview-channel/progress.json"],
    target: null,
    targetText: null,
  });
  const card8 = buildBoardCardDialog(board, nodeOf(board, "task:8"));
  assert.equal(card8.showBlockers, false, "blockers 为空 → 区块隐藏");
  assert.deepEqual(card8.blockers, []);

  // 特性节点：即便板上真带了 blockers 字段，也按 §6 约束隐藏（特性级受阻以 status=blocked 表达）。
  const featureNode = nodeOf(board, "spec:preview-channel");
  const featureWithBlockers: BoardViewNode = {
    ...featureNode,
    blockers: [
      { kind: "external", blockedBy: null, summary: "特性级阻拦（不该渲染）", evidence: [] },
    ],
  };
  const featureDialog = buildBoardCardDialog(board, featureWithBlockers);
  assert.equal(featureDialog.showBlockers, false, "特性节点弹窗的阻拦区块必须隐藏");
  assert.deepEqual(featureDialog.blockers, [], "隐藏即不产出阻拦行（视图层无需再判一次）");
});

test("弹窗阻拦区块：dependency 显示对方 ID-<label> 与稳定号 #<no>（契约 §6 逐字）", () => {
  const board = goldenBoard();
  const draft = buildBoardCardDialog(board, nodeOf(board, "task:plan:plan-payment-split#0"));
  assert.equal(draft.showBlockers, true);
  assert.equal(draft.blockers.length, 1);
  const dependency = draft.blockers[0];
  assert.ok(dependency);
  assert.equal(dependency.kind, "dependency");
  assert.equal(
    dependency.targetText,
    "ID-1.3 · #9",
    "对方编号按契约：ID-<对方label> + 稳定号 #<对方no>",
  );
  assert.deepEqual(
    dependency.target,
    {
      id: "task:9",
      no: 9,
      label: "1.3",
      title: "通道可见 + 版本序语义",
      stage: "已完成",
    },
    "依赖跳转目标解析到板上的那张卡（目标是节点自身，不是复制一份字段）",
  );
  assert.equal(
    dependency.summary,
    "等待 #9 的通道函数落地后再合并回调路径",
    "summary 原样保留（跳转可用时也照实展示）",
  );
});

test("弹窗阻拦区块：目标不在板上 / blockedBy 缺省 → 跳转禁用（target null），只显示 summary", () => {
  const board = goldenBoard();
  // golden 真实形态：第二条 dependency 没有 blockedBy（空 summary）。
  const draft2 = buildBoardCardDialog(board, nodeOf(board, "task:plan:plan-payment-split#1"));
  assert.equal(draft2.blockers.length, 2);
  const second = draft2.blockers[1];
  assert.ok(second);
  assert.equal(second.kind, "dependency");
  assert.equal(second.target, null, "缺 blockedBy → 无跳转目标（视图层禁用跳转）");
  assert.equal(second.targetText, null, "无目标就不编造对方编号");
  assert.equal(second.summary, null, "summary 也缺省时不编造文案");
  // 目标号在板上不存在（悬空引用）：跳转禁用，summary 照实展示。
  const dangling: BoardViewNode = {
    ...nodeOf(board, "task:8"),
    blockers: [{ kind: "dependency", blockedBy: 404, summary: "等待 #404（悬空）", evidence: [] }],
  };
  const danglingDialog = buildBoardCardDialog(board, dangling);
  assert.equal(danglingDialog.blockers[0]?.target, null);
  assert.equal(danglingDialog.blockers[0]?.targetText, null);
  assert.equal(danglingDialog.blockers[0]?.summary, "等待 #404（悬空）");
});

test("弹窗阻拦区块：不认识的 kind 照实展示 summary（不吞字段、不猜语义）", () => {
  const board = goldenBoard();
  const future: BoardViewNode = {
    ...nodeOf(board, "task:8"),
    blockers: [
      { kind: "future-kind", blockedBy: null, summary: "未来的阻拦形态", evidence: ["a.md"] },
    ],
  };
  const dialog = buildBoardCardDialog(board, future);
  assert.equal(dialog.showBlockers, true);
  assert.equal(dialog.blockers[0]?.kind, "future-kind", "kind 原值透出");
  assert.equal(dialog.blockers[0]?.summary, "未来的阻拦形态");
  assert.deepEqual(dialog.blockers[0]?.evidence, ["a.md"]);
});

test("弹窗来源区块：origin 五键按固定序映射（缺省的键不出现）", () => {
  const board = goldenBoard();
  const card8 = buildBoardCardDialog(board, nodeOf(board, "task:8"));
  assert.deepEqual(card8.origin, [
    { key: "interviewId", value: "itw-20261009-a1b2" },
    { key: "specRoot", value: "specs/preview-channel/" },
  ]);
  const card7 = buildBoardCardDialog(board, nodeOf(board, "task:7"));
  assert.deepEqual(card7.origin, [
    { key: "type", value: "spec-driven-workflow" },
    { key: "specRoot", value: "specs/preview-channel/" },
  ]);
  const card9 = buildBoardCardDialog(board, nodeOf(board, "task:9"));
  assert.deepEqual(card9.origin, [], "缺 origin → 空列表（区块隐藏）");
  assert.deepEqual(
    [...BOARD_DIALOG_ORIGIN_KEYS],
    ["type", "interviewId", "sessionId", "specRoot", "planRef"],
  );
});

test("弹窗证据路径与 PR：展示路径文本；pr 缺省 → null（§6 区块隐藏）", () => {
  const board = goldenBoard();
  const card8 = buildBoardCardDialog(board, nodeOf(board, "task:8"));
  assert.deepEqual(card8.evidence, [
    "specs/preview-channel/progress.json",
    "ZPaPa/packages/desktop/src/updateStatusModel.ts",
  ]);
  assert.equal(card8.pr, null);
  const card9 = buildBoardCardDialog(board, nodeOf(board, "task:9"));
  assert.deepEqual(card9.pr, { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" });
  assert.deepEqual(card9.evidence, []);
});

test("跳转目标解析：按稳定号找板上的卡；找不到 / 没号 → null（契约 §6「目标不在当前板 → 禁用跳转」）", () => {
  const board = goldenBoard();
  assert.deepEqual(resolveBoardCardJumpTarget(board, 9), {
    id: "task:9",
    no: 9,
    label: "1.3",
    title: "通道可见 + 版本序语义",
    stage: "已完成",
  });
  assert.deepEqual(
    resolveBoardCardJumpTarget(board, 6)?.id,
    "plan:sess_f1a2d0bb",
    "特性节点也是合法目标",
  );
  assert.equal(resolveBoardCardJumpTarget(board, 404), null, "板上没有这个号 → 无目标");
  assert.equal(resolveBoardCardJumpTarget(board, null), null, "没号就没目标");
  assert.equal(resolveBoardCardJumpTarget(board, 0), null, "0/负数不是稳定号");
});

test("跳转目标解析：目标缺 label 时降级为稳定号 #<no>（不编造 ID-）", () => {
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as unknown as {
    features: { tasks?: Record<string, unknown>[] }[];
  };
  const card9 = raw.features[0]?.tasks?.[2];
  assert.ok(card9, "夹具应有 #9");
  delete card9.label;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const dependency = buildBoardCardDialog(
    outcome.board,
    nodeOf(outcome.board, "task:plan:plan-payment-split#0"),
  ).blockers[0];
  assert.equal(dependency?.target?.id, "task:9", "按稳定号仍能定位到目标卡");
  assert.equal(dependency?.target?.label, null);
  assert.equal(dependency?.targetText, "#9", "缺 label 时不编造 ID-，只给稳定号");
});

test("同一时刻最多一个弹窗：openCardId → 至多一个节点；悬空 id 直接不渲染（不留幽灵）", () => {
  const board = goldenBoard();
  const node = resolveBoardDialogNode(board, "task:8");
  assert.equal(node?.id, "task:8", "命中的 id 返回该节点");
  assert.equal(
    resolveBoardDialogNode(board, "task:404"),
    null,
    "板上没有的 id → null（刷新后自动关窗）",
  );
  assert.equal(resolveBoardDialogNode(board, null), null, "没有打开态 → null（一个都不渲染）");
  assert.equal(
    resolveBoardDialogNode(board, "task:8")?.id,
    resolveBoardDialogNode(board, "task:8")?.id,
    "解析是幂等的（同一 id 不会解析出两个节点）",
  );
});

test("Esc 关窗的键位判据在纯函数（一处判定，宿主只消费）", () => {
  assert.equal(boardCardDialogKeyIntent({ key: "Escape", defaultPrevented: false }), "close");
  assert.equal(
    boardCardDialogKeyIntent({ key: "Escape", defaultPrevented: true }),
    "none",
    "已被内层浮层消费的 Esc 不重复关窗（同 TaskFindDialog 口径）",
  );
  assert.equal(boardCardDialogKeyIntent({ key: "Enter", defaultPrevented: false }), "none");
  assert.equal(boardCardDialogKeyIntent({ key: "a", defaultPrevented: false }), "none");
});

test("跳转降级：看板列视图遇到段位缺省的目标 → 切列表视图（列表全量可见，不静默跳空）", () => {
  const board = goldenBoard();
  const target = resolveBoardCardJumpTarget(board, 9);
  assert.ok(target);
  assert.equal(
    boardJumpRequiresListView("kanban", target),
    false,
    "段位认识的目标在看板列里有位置",
  );
  const stageUnknown = { ...target, stage: null };
  assert.equal(
    boardJumpRequiresListView("kanban", stageUnknown),
    true,
    "无段位目标在看板列里不落任何列",
  );
  assert.equal(
    boardJumpRequiresListView("table", stageUnknown),
    false,
    "表格/列表/树形都渲染全量节点",
  );
  assert.equal(boardJumpRequiresListView("list", stageUnknown), false);
  assert.equal(boardJumpRequiresListView("tree", stageUnknown), false);
});
