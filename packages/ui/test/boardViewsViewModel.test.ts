import assert from "node:assert/strict";
import test from "node:test";
import {
  boardAttentionFilterValue,
  boardListControlsToQuery,
  boardSortFilterValue,
  boardStageFilterValue,
  boardStatusFilterValue,
  boardViewNodeKindFilterValue,
  buildBoardKanban,
  buildBoardListRows,
  collectBoardViewNodes,
  EMPTY_BOARD_LIST_CONTROLS,
  sortBoardViewNodes,
  type BoardKanbanColumn,
  type BoardViewNode,
} from "../src/board/boardViewsViewModel.js";
import { BOARD_STAGES, parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 看板视图模型（卡 #33）：列分配 / 待设计聚合 / 排序 / 过滤的**纯函数缝**。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §13.1（七段位与派生）/
 * §13.2（视图矩阵）/ §13.3（待设计列聚合）/ §3.5（排序：attention 置顶 + updatedAt 倒序）
 * 与 §13.4（待合并角标）。夹具形态真源：`board.golden.json`（形态见 boardTestFixture；实例在 boardStageMatrixFixture）。
 * 实例期望（哪张卡落在哪列）逐条写死在本文件，不由实现回算。
 */

function stageMatrixBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(STAGE_MATRIX_BOARD));
  if (outcome.kind !== "ready") throw new Error("七段位夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function nodeIds(nodes: BoardViewNode[]): string[] {
  return nodes.map((node) => node.id);
}

function sortedNodeIds(nodes: BoardViewNode[]): string[] {
  return [...nodeIds(nodes)].sort();
}

function columnOf(columns: BoardKanbanColumn[], stage: string): BoardKanbanColumn {
  const column = columns.find((entry) => entry.stage === stage);
  assert.ok(column, `列 ${stage} 应存在`);
  return column;
}

test("看板列分配：七列固定序（流水序），每列的节点段位与本列一致", () => {
  const { columns, unplacedCount } = buildBoardKanban(stageMatrixBoard());
  assert.deepEqual(
    columns.map((column) => column.stage),
    [...BOARD_STAGES],
    "七列 = 七段位词表序（待设计 → 待办 → 执行中 → 审核中 → 阻塞 → 已完成 → 已取消）",
  );
  assert.equal(unplacedCount, 0, "夹具里每个节点都有段位");
  for (const column of columns) {
    for (const node of column.nodes) {
      assert.equal(node.stage, column.stage, `节点 ${node.id} 不得落在别的段位列`);
    }
  }
});

test("看板列分配：节点集合 = 特性节点 + 任务卡（同 set 同源，特性不在任何列都缺）", () => {
  const board = stageMatrixBoard();
  const { columns } = buildBoardKanban(board);
  // 阻塞段位**仅特性级产出**（契约 §13.1）：该列必须有特性节点，卡列视图不能只看卡。
  assert.deepEqual(nodeIds(columnOf(columns, "阻塞").nodes), ["spec:payment-split"]);
  assert.deepEqual(sortedNodeIds(columnOf(columns, "执行中").nodes), [
    "spec:preview-channel",
    "task:8",
  ]);
  assert.deepEqual(sortedNodeIds(columnOf(columns, "审核中").nodes), ["task:13"]);
  assert.deepEqual(sortedNodeIds(columnOf(columns, "已取消").nodes), ["task:12"]);
  assert.deepEqual(sortedNodeIds(columnOf(columns, "已完成").nodes), ["task:9"]);
});

test("节点投影：任务卡扁平化（嵌套子卡也进集合），带 kind/statusRule/updatedAt", () => {
  const nodes = collectBoardViewNodes(stageMatrixBoard());
  assert.equal(nodes.length, 13, "6 个特性节点 + 7 张任务卡（含嵌套）");
  const card8 = nodes.find((node) => node.id === "task:8");
  assert.ok(card8);
  assert.equal(card8.kind, "task");
  assert.equal(card8.stage, "执行中");
  assert.equal(card8.updatedAt, "2026-10-09T14:20:00+08:00");
  assert.equal(card8.statusRule, "activeRun.role=implementer（干活角色）");
  assert.deepEqual(card8.attention, ["interrupted-resume", "unmerged-worktree"]);
  const plan6 = nodes.find((node) => node.id === "plan:sess_f1a2d0bb");
  assert.ok(plan6);
  assert.equal(plan6.kind, "feature");
  assert.equal(plan6.featureKind, "plan");
});

test("节点投影：任务卡透传 nextAssignee（v2.3/#53 卡级字段），特性节点与缺省一律 null", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  const card8 = raw.features[0]?.tasks[1] as { nextAssignee?: string };
  assert.ok(card8, "夹具应有 #8");
  card8.nextAssignee = "integrator";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const nodes = collectBoardViewNodes(outcome.board);
  assert.equal(
    nodes.find((node) => node.id === "task:8")?.nextAssignee,
    "integrator",
    "任务卡照实透传（不做管线推导，字段来自编译器）",
  );
  assert.equal(
    nodes.find((node) => node.id === "task:7")?.nextAssignee,
    null,
    "字段缺省 → null（旧板不冒充「有接手人」）",
  );
  assert.equal(
    nodes.find((node) => node.id === "spec:preview-channel")?.nextAssignee,
    null,
    "nextAssignee 是卡级字段（契约 §2 字段表：features[].tasks[]）",
  );
});

test("段位缺省/不认识的节点不落列，也不静默：计入 unplacedCount", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  const feature = raw.features[0] as { stage?: string };
  delete feature.stage;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const { columns, unplacedCount } = buildBoardKanban(outcome.board);
  assert.equal(unplacedCount, 1, "缺段位的节点应被计入未定位数");
  assert.ok(
    columns.every((column) => !nodeIds(column.nodes).includes("spec:preview-channel")),
    "缺段位的节点不得出现在任何段位列",
  );
});

test("待设计列：interview-only 节点聚合为「访谈汇总」子区，安排类节点同列排列（§13.3）", () => {
  const { columns } = buildBoardKanban(stageMatrixBoard());
  const design = columnOf(columns, "待设计");
  assert.ok(design.interview, "待设计列应带访谈汇总子区");
  assert.deepEqual(
    sortedNodeIds(design.interview.nodes),
    ["interview:itw-a", "interview:itw-b"],
    "两张 interview-only 节点进聚合子区",
  );
  assert.deepEqual(
    sortedNodeIds(design.nodes),
    ["plan:sess_1f3c5d7e", "plan:sess_f1a2d0bb"],
    "plan/spec 的安排类节点留在主列，不被聚合",
  );
  assert.equal(design.interview.count, 2, "子区计数 = attentionSummary.interviewedNotArranged");
});

test("访谈汇总子区只在待设计列出现；其余列一律 null（§13.3）", () => {
  const { columns } = buildBoardKanban(stageMatrixBoard());
  for (const column of columns) {
    if (column.stage === "待设计") continue;
    assert.equal(column.interview, null, `列 ${column.stage} 不应有访谈汇总子区`);
  }
});

test("子区计数取 attentionSummary（契约指定来源），不是节点条数的回算", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  raw.attentionSummary.interviewedNotArranged = 5;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const design = columnOf(buildBoardKanban(outcome.board).columns, "待设计");
  assert.equal(design.interview?.count, 5, "计数随板上的汇总字段走，不自算");
  assert.equal(design.interview?.nodes.length, 2, "子区节点仍只列板上真有的 interview-only 节点");
});

test("列内排序：attention 置顶，其余按 updatedAt 倒序（§3.5）", () => {
  const { columns } = buildBoardKanban(stageMatrixBoard());
  // 待办列：#14 带 unmerged-worktree 且 updatedAt 最老 —— 仍必须置顶；
  // 其余 #7（14:05）新于 #10（09:00）。
  assert.deepEqual(nodeIds(columnOf(columns, "待办").nodes), ["task:14", "task:7", "task:10"]);
  // 执行中列：#8 带两个缺口码（14:20）与特性同组（特性自身段位=执行中）——
  // #46 B3 起列内按特性分组渲染：扁平序 = 分组头 + 组内行（组内 attention 置顶）
  assert.deepEqual(nodeIds(columnOf(columns, "执行中").nodes), ["spec:preview-channel", "task:8"]);
});

test("列内排序：无 updatedAt 的节点沉底，不冒充最新（§3.5 卡龄信号缺省）", () => {
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  const newestTodo = raw.features[0]?.tasks[0] as { updatedAt?: string };
  assert.ok(newestTodo, "夹具应有 #7");
  delete newestTodo.updatedAt;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.deepEqual(nodeIds(columnOf(buildBoardKanban(outcome.board).columns, "待办").nodes), [
    "task:14",
    "task:10",
    "task:7",
  ]);
});

test("待设计列：安排类节点与访谈汇总子区都按 updatedAt 倒序（§13.3）", () => {
  const design = columnOf(buildBoardKanban(stageMatrixBoard()).columns, "待设计");
  assert.deepEqual(nodeIds(design.nodes), ["plan:sess_1f3c5d7e", "plan:sess_f1a2d0bb"]);
  assert.deepEqual(nodeIds(design.interview?.nodes ?? []), ["interview:itw-b", "interview:itw-a"]);
});

test("「最老未动」第二视角：attention 仍置顶，其余按 updatedAt 升序（§3.5）", () => {
  const { columns } = buildBoardKanban(stageMatrixBoard(), { sort: "oldest" });
  assert.deepEqual(nodeIds(columnOf(columns, "待办").nodes), ["task:14", "task:10", "task:7"]);
  const { columns: recent } = buildBoardKanban(stageMatrixBoard());
  assert.deepEqual(
    nodeIds(columnOf(recent, "待办").nodes),
    ["task:14", "task:7", "task:10"],
    "默认排序不因第二视角存在而改变",
  );
});

test("排序是纯函数：输入数组不被就地改写", () => {
  const nodes = collectBoardViewNodes(stageMatrixBoard());
  const before = [...nodes];
  const sorted = sortBoardViewNodes(nodes, "recent");
  assert.deepEqual(nodes, before, "入参顺序不得被就地改写");
  assert.notEqual(sorted, nodes, "应返回新数组");
});

test("列表 = 全卡平铺：特性节点与卡片同一集合，一个不丢（§13.2 同 set）", () => {
  const rows = buildBoardListRows(stageMatrixBoard());
  assert.equal(rows.length, 13, "6 特性 + 7 卡全部平铺");
  assert.ok(nodeIds(rows).includes("spec:preview-channel"), "特性节点也在列表里");
  assert.ok(nodeIds(rows).includes("task:12"), "已取消卡也在列表里（不隐藏）");
  // 默认排序 = attention 置顶 + updatedAt 倒序（§3.5）。
  const attentionIds = new Set(
    rows.filter((node) => node.attention.length > 0).map((node) => node.id),
  );
  assert.deepEqual(
    new Set(nodeIds(rows).slice(0, attentionIds.size)),
    attentionIds,
    "带缺口的节点应占据列表头部",
  );
  assert.equal(rows[0]?.id, "task:8", "缺口组内最新的 #8 排在首位");
});

test("列表过滤 · 段位：只留该段位节点，其余节点一律不出现（§13.2）", () => {
  const rows = buildBoardListRows(stageMatrixBoard(), { filter: { stage: "审核中" } });
  assert.deepEqual(nodeIds(rows), ["task:13"]);
  const running = buildBoardListRows(stageMatrixBoard(), { filter: { stage: "执行中" } });
  assert.deepEqual(sortedNodeIds(running), ["spec:preview-channel", "task:8"]);
});

test("列表过滤 · 状态：按 status 字段筛，含 v2.1 cancelled 终态", () => {
  const cancelled = buildBoardListRows(stageMatrixBoard(), { filter: { status: "cancelled" } });
  assert.deepEqual(nodeIds(cancelled), ["task:12"]);
  const completed = buildBoardListRows(stageMatrixBoard(), { filter: { status: "completed" } });
  assert.deepEqual(nodeIds(completed), ["task:9"]);
});

test("列表过滤 · 缺口码：只留挂该码的节点（段位/状态不参与该判据）", () => {
  const unmerged = buildBoardListRows(stageMatrixBoard(), {
    filter: { attention: "unmerged-worktree" },
  });
  assert.deepEqual(sortedNodeIds(unmerged), ["task:14", "task:8"]);
  const interviews = buildBoardListRows(stageMatrixBoard(), {
    filter: { attention: "interviewed-not-arranged" },
  });
  assert.deepEqual(sortedNodeIds(interviews), ["interview:itw-a", "interview:itw-b"]);
});

test("列表过滤 · 节点类型（kind）：特性/卡片各自筛（§13.2 表格「待设计」格「可按 attention 与 kind 过滤」）", () => {
  const featuresOnly = buildBoardListRows(stageMatrixBoard(), { filter: { kind: "feature" } });
  assert.deepEqual(sortedNodeIds(featuresOnly), [
    "interview:itw-a",
    "interview:itw-b",
    "plan:sess_1f3c5d7e",
    "plan:sess_f1a2d0bb",
    "spec:payment-split",
    "spec:preview-channel",
  ]);
  const tasksOnly = buildBoardListRows(stageMatrixBoard(), { filter: { kind: "task" } });
  assert.deepEqual(sortedNodeIds(tasksOnly), [
    "task:10",
    "task:12",
    "task:13",
    "task:14",
    "task:7",
    "task:8",
    "task:9",
  ]);
  assert.deepEqual(
    sortedNodeIds(
      buildBoardListRows(stageMatrixBoard(), { filter: { kind: "task", stage: "待办" } }),
    ),
    ["task:10", "task:14", "task:7"],
    "kind 与段位是交集",
  );
  assert.equal(
    buildBoardListRows(stageMatrixBoard(), { filter: { kind: "task" } }).every(
      (node) => node.kind === "task",
    ),
    true,
    "kind 筛后不得夹带特性节点",
  );
});

test("列表过滤：三条件是交集；条件为空即全量（清过滤回到全卡平铺）", () => {
  const both = buildBoardListRows(stageMatrixBoard(), {
    filter: { stage: "执行中", attention: "unmerged-worktree" },
  });
  assert.deepEqual(nodeIds(both), ["task:8"], "段位∩缺口码");
  const empty = buildBoardListRows(stageMatrixBoard(), {
    filter: { stage: "阻塞", status: "cancelled" },
  });
  assert.deepEqual(nodeIds(empty), [], "无交集即空结果（由视图层给空态文案）");
  assert.equal(buildBoardListRows(stageMatrixBoard(), { filter: {} }).length, 13, "空条件 = 全量");
});

test("过滤控件状态 → 查询：null = 不筛；各项各自映射（UI 取值是闭集）", () => {
  assert.deepEqual(boardListControlsToQuery(EMPTY_BOARD_LIST_CONTROLS), {
    filter: {},
    sort: "recent",
  });
  const query = boardListControlsToQuery({
    stage: "审核中",
    status: "pending",
    attention: "interrupted-resume",
    kind: "task",
    sort: "oldest",
  });
  assert.deepEqual(query, {
    filter: { stage: "审核中", status: "pending", attention: "interrupted-resume", kind: "task" },
    sort: "oldest",
  });
  assert.deepEqual(
    nodeIds(buildBoardListRows(stageMatrixBoard(), query)),
    ["task:13"],
    "控件状态直接喂给列表行（端到端一条链）",
  );
});

test("过滤控件取值归一：空串/不认识的值一律 null，排序坏值回落默认（评审 S4：UI 不裸 as 断言）", () => {
  assert.equal(boardStageFilterValue(""), null);
  assert.equal(boardStageFilterValue("第八段位"), null);
  assert.equal(boardStageFilterValue("审核中"), "审核中");
  assert.equal(boardStatusFilterValue(""), null);
  assert.equal(boardStatusFilterValue("future-status"), null);
  assert.equal(boardStatusFilterValue("cancelled"), "cancelled");
  assert.equal(boardAttentionFilterValue(""), null);
  assert.equal(boardAttentionFilterValue("future-code"), null);
  assert.equal(boardAttentionFilterValue("unmerged-worktree"), "unmerged-worktree");
  assert.equal(boardViewNodeKindFilterValue(""), null);
  assert.equal(
    boardViewNodeKindFilterValue("interview-only"),
    null,
    "视图节点类型只有 feature/task",
  );
  assert.equal(boardViewNodeKindFilterValue("task"), "task");
  assert.equal(boardSortFilterValue(""), "recent", "排序是闭集二选一，坏值回落默认视角");
  assert.equal(boardSortFilterValue("future-sort"), "recent");
  assert.equal(boardSortFilterValue("oldest"), "oldest");
});

test("列表默认排序：已完成段位沉底（§13.2 列表列），但 attention 置顶优先", () => {
  const rows = buildBoardListRows(stageMatrixBoard());
  const ids = nodeIds(rows);
  // #9（已完成，15:30）比 #7（待办，14:05）新；沉底后 #7 必须在前。
  assert.ok(ids.indexOf("task:7") < ids.indexOf("task:9"), `已完成应沉底：${ids.join(",")}`);
  // 已完成 + 带缺口：置顶优先于沉底（缺口不许被埋，§3.5「attention 项置顶」）。
  const raw = structuredClone(STAGE_MATRIX_BOARD);
  const doneCard = raw.features[0]?.tasks[2] as { attention?: string[] };
  assert.ok(doneCard, "夹具应有 #9");
  doneCard.attention = ["unmerged-worktree"];
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const pinnedIds = nodeIds(buildBoardListRows(outcome.board));
  assert.ok(
    pinnedIds.indexOf("task:9") < pinnedIds.indexOf("spec:preview-channel"),
    "带缺口的已完成卡仍在置顶组",
  );
});

test("「最老未动」视角不做沉底（第二视角的语义就是最老在前，§3.5）", () => {
  const rows = buildBoardListRows(stageMatrixBoard(), { sort: "oldest" });
  const ids = nodeIds(rows);
  assert.ok(ids.includes("task:9"), "已完成的卡仍在列表里（沉底不等于隐藏）");
  assert.ok(
    ids.indexOf("task:12") < ids.indexOf("task:7"),
    "非置顶组内最老的 #12（08:00）应排在 #7（14:05）之前",
  );
  assert.equal(ids.at(-1), "task:9", "非置顶组内最新的 #9（15:30）垫底（升序）");
});
