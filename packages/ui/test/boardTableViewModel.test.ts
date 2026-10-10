import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  BOARD_TABLE_COLUMNS,
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  boardTableCellText,
  parseBoardTableColumnVisibility,
  serializeBoardTableColumnVisibility,
  toggleBoardTableColumn,
  visibleBoardTableColumns,
  type BoardTableColumnVisibility,
} from "../src/board/boardTableViewModel.js";
import {
  buildBoardListRows,
  clearBoardListFilter,
  collectBoardViewNodes,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
} from "../src/board/boardViewsViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 表格视图的列配置纯函数缝（卡 #34）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §13.5「表格列可配置」
 * （默认列：编号/名称/段位/status/assignees/lastRun/updatedAt/blockers/attention；可见性与顺序可配置）
 * + 卡 #34 派发指令（列 = 号 / 名称 / 段位 / 状态 / 最近执行 / 卡龄）。
 * 列集合与默认可见性是**契约文本**，逐条写死在测试里，不由实现回算。
 */

test("表格列闭集：默认列 = 契约 §13.5 九列 + 派发指令的卡龄（顺序即渲染序）", () => {
  assert.deepEqual(
    [...BOARD_TABLE_COLUMNS],
    [
      "no",
      "title",
      "stage",
      "status",
      "assignees",
      "lastRun",
      "updatedAt",
      "age",
      "blockers",
      "attention",
    ],
  );
  assert.deepEqual(
    visibleBoardTableColumns(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY),
    [...BOARD_TABLE_COLUMNS],
    "默认可见 = 全部列（契约默认列 + 卡龄都看得见）",
  );
});

test("列可见性开关：只翻目标列，返回新对象（入参不改写）", () => {
  const before = DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY;
  const toggled = toggleBoardTableColumn(before, "assignees");
  assert.equal(toggled.assignees, false, "目标列被隐藏");
  assert.equal(before.assignees, true, "入参不被就地改写");
  assert.notEqual(toggled, before, "返回新对象");
  assert.deepEqual(
    visibleBoardTableColumns(toggled).filter((key) => key !== "assignees"),
    [...BOARD_TABLE_COLUMNS].filter((key) => key !== "assignees"),
    "其余列的可见性不受影响",
  );
  const hiddenTwo = toggleBoardTableColumn(toggled, "lastRun");
  assert.deepEqual(visibleBoardTableColumns(hiddenTwo), [
    "no",
    "title",
    "stage",
    "status",
    "updatedAt",
    "age",
    "blockers",
    "attention",
  ]);
});

test("可见列序恒为闭集序（配置只管显示/隐藏，列序不因开关而漂移）", () => {
  const visibility: BoardTableColumnVisibility = {
    ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
    no: false,
    title: false,
  };
  assert.deepEqual(visibleBoardTableColumns(visibility), [
    "stage",
    "status",
    "assignees",
    "lastRun",
    "updatedAt",
    "age",
    "blockers",
    "attention",
  ]);
  assert.deepEqual(
    visibleBoardTableColumns({ ...visibility, title: true }),
    [
      "title",
      "stage",
      "status",
      "assignees",
      "lastRun",
      "updatedAt",
      "age",
      "blockers",
      "attention",
    ],
    "重新显示时回到闭集里的本序位（不是追加到末尾）",
  );
});

test("列配置的会话记忆形态：序列化/解析（只认闭集成员，坏值回落默认）", () => {
  const visibility = toggleBoardTableColumn(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, "attention");
  const serialized = serializeBoardTableColumnVisibility(visibility);
  assert.deepEqual(
    parseBoardTableColumnVisibility(JSON.parse(serialized)),
    visibility,
    "写什么读回什么（会话内保持）",
  );
  assert.deepEqual(
    parseBoardTableColumnVisibility(["stage", "no", "future-column"]),
    {
      no: true,
      title: false,
      stage: true,
      status: false,
      assignees: false,
      lastRun: false,
      updatedAt: false,
      age: false,
      blockers: false,
      attention: false,
    },
    "认识的字面量进，不认识的字面量丢（不猜新列）",
  );
  assert.deepEqual(
    parseBoardTableColumnVisibility(null),
    { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY },
    "没有记忆 → 默认列",
  );
  assert.deepEqual(
    parseBoardTableColumnVisibility({ stage: true }),
    { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY },
    "非数组（坏形态）→ 默认列，不猜",
  );
  assert.deepEqual(
    parseBoardTableColumnVisibility([]),
    {
      no: false,
      title: false,
      stage: false,
      status: false,
      assignees: false,
      lastRun: false,
      updatedAt: false,
      age: false,
      blockers: false,
      attention: false,
    },
    "空数组 = 用户把所有列都关了（合法取值，不等于坏值）",
  );
});

/* ---------------- 单元格值（列 → 文本） ---------------- */

function formatterWith(messages: Record<string, string>) {
  return (descriptor: { id: string }, values?: Record<string, string | number>) => {
    let message = messages[descriptor.id] ?? descriptor.id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  };
}

const t = formatterWith(zhCN);

/** 夹具真源（boardStageMatrixFixture 注释逐条写死）：#8 = 执行中/active/两个缺口码/#14 = 待办。 */
function matrixBoard() {
  const outcome = parseBoardJson(JSON.stringify(STAGE_MATRIX_BOARD));
  if (outcome.kind !== "ready") throw new Error("七段位夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function matrixNodes() {
  return collectBoardViewNodes(matrixBoard());
}

function nodeById(nodes: ReturnType<typeof matrixNodes>, id: string) {
  const node = nodes.find((entry) => entry.id === id);
  assert.ok(node, `夹具里应有节点 ${id}`);
  return node;
}

const NOW_2026_10_12 = Date.parse("2026-10-12T09:00:00+08:00");

test("号列降级链：ID-<label> → #<no>（无 label）→ 未领号（契约 §13.5 + 派发指令）", () => {
  const nodes = matrixNodes();
  assert.equal(boardTableCellText(nodeById(nodes, "task:7"), "no", t, NOW_2026_10_12), "ID-1.1");
  const raw = structuredClone(STAGE_MATRIX_BOARD) as unknown as {
    features: Record<string, unknown>[];
  };
  raw.features.push({
    id: "plan:no-label",
    no: 21,
    kind: "plan",
    title: "只有稳定号的节点",
    status: "pending",
    stage: "待办",
    attention: [],
    tasks: [],
  });
  raw.features.push({
    id: "plan:unassigned",
    kind: "plan",
    title: "未领号节点",
    status: "pending",
    stage: "待办",
    attention: [],
    tasks: [],
  });
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const withUnassigned = collectBoardViewNodes(outcome.board);
  assert.equal(
    boardTableCellText(nodeById(withUnassigned, "plan:no-label"), "no", t, NOW_2026_10_12),
    "#21",
    "缺 label 时降级为稳定号 #N",
  );
  assert.equal(
    boardTableCellText(nodeById(withUnassigned, "plan:unassigned"), "no", t, NOW_2026_10_12),
    "未领号",
    "no/label 都缺 → 未领号（合法缺省形态，不是空单元格）",
  );
});

test("段位/状态列走词条；未知取值原样透出（不吞字段、不自造词）", () => {
  const nodes = matrixNodes();
  const card8 = nodeById(nodes, "task:8");
  assert.equal(boardTableCellText(card8, "stage", t, NOW_2026_10_12), "执行中");
  assert.equal(boardTableCellText(card8, "status", t, NOW_2026_10_12), "进行中");
  assert.equal(boardTableCellText(nodeById(nodes, "plan:sess_f1a2d0bb"), "stage", t, 0), "待设计");
  const unknown = { ...card8, stage: "第八段位", status: "future-status" };
  assert.equal(boardTableCellText(unknown, "stage", t, NOW_2026_10_12), "第八段位");
  assert.equal(boardTableCellText(unknown, "status", t, NOW_2026_10_12), "future-status");
  assert.equal(
    boardTableCellText({ ...card8, stage: null }, "stage", t, 0),
    null,
    "段位缺省 = 空单元格",
  );
});

test("最近执行与卡龄列：四要素文本；卡龄 = updatedAt 距今天数（floor，未来按 0）", () => {
  const nodes = matrixNodes();
  const card8 = nodeById(nodes, "task:8");
  const lastRunText = boardTableCellText(card8, "lastRun", t, NOW_2026_10_12);
  assert.ok(lastRunText?.includes("partial"), `最近执行列应含 result：${lastRunText}`);
  assert.ok(lastRunText?.includes("停在 #8"), `最近执行列应含断点：${lastRunText}`);
  assert.ok(lastRunText?.includes("补 updater 单测后重新验证"), "最近执行列应含下一步摘要");
  assert.equal(
    boardTableCellText(nodeById(nodes, "task:10"), "lastRun", t, 0),
    null,
    "无 run → 空单元格",
  );
  // #8 updatedAt=2026-10-09T14:20+08:00，now=2026-10-12T09:00+08:00 → 差 2 天 18 小时 40 分 → 2 天。
  assert.equal(boardTableCellText(card8, "age", t, NOW_2026_10_12), "2 天");
  assert.equal(
    boardTableCellText(
      nodeById(nodes, "task:10"),
      "age",
      t,
      Date.parse("2026-10-09T09:00:00+08:00"),
    ),
    "0 天",
    "同刻 → 0 天",
  );
  assert.equal(
    boardTableCellText(card8, "age", t, Date.parse("2026-10-01T00:00:00+08:00")),
    "0 天",
    "时钟回拨/未来时间 → 0 天，不出现负数",
  );
  assert.equal(
    boardTableCellText({ ...card8, updatedAt: null }, "age", t, NOW_2026_10_12),
    null,
    "缺 updatedAt → 空单元格（没有卡龄信号不编造）",
  );
});

test("责任管线列按管线序渲染；缺省不编造标准管线（契约 §13.5）", () => {
  const nodes = matrixNodes();
  const card8 = nodeById(nodes, "task:8");
  assert.equal(
    boardTableCellText(card8, "assignees", t, NOW_2026_10_12),
    "implementer → test-verifier → code-reviewer → integrator",
  );
  assert.equal(
    boardTableCellText(nodeById(nodes, "task:13"), "assignees", t, NOW_2026_10_12),
    "debugger → test-verifier",
    "非标准管线按板上顺序渲染（不改序、不补全）",
  );
  assert.equal(
    boardTableCellText(nodeById(nodes, "plan:sess_f1a2d0bb"), "assignees", t, 0),
    null,
    "没有该字段 → 空单元格，不编造标准管线",
  );
});

test("阻碍/缺口列：计数与短标签摘要；空值 → 空单元格", () => {
  const nodes = matrixNodes();
  const card7 = nodeById(nodes, "task:7");
  assert.equal(boardTableCellText(card7, "blockers", t, NOW_2026_10_12), "受阻 1");
  assert.equal(boardTableCellText(card7, "attention", t, NOW_2026_10_12), null, "#7 无缺口码");
  const card8 = nodeById(nodes, "task:8");
  assert.equal(
    boardTableCellText(card8, "attention", t, NOW_2026_10_12),
    "执行中断可续 · 待合并（未回流）",
    "多码摘要按闭集序（§4 词表序），不是零散拼接",
  );
  assert.equal(boardTableCellText(card8, "blockers", t, NOW_2026_10_12), null, "#8 无阻拦");
  assert.equal(boardTableCellText(card7, "title", t, NOW_2026_10_12), "预览发布通道（workflow）");
});

test("表格行 = 列表视图同一管线：字面 id 序列写死（契约 §3.5 排序规则的手推样例）", () => {
  // 期望值是**手推的**：先缺口置顶组（attention 非空，按 updatedAt 倒序、同刻按 id 字典序），
  // 再其余组（updatedAt 倒序，已完成沉底到组尾）。
  assert.deepEqual(
    buildBoardListRows(matrixBoard(), { filter: { stage: "执行中" } }).map((node) => node.id),
    ["task:8", "spec:preview-channel"],
    "执行中 = #8（带缺口，置顶）→ 特性（15:30）",
  );
  assert.deepEqual(
    buildBoardListRows(matrixBoard()).map((node) => node.id),
    [
      "task:8", // 缺口组：14:20
      "plan:sess_1f3c5d7e", // 13:10（与 #13 同刻，id 字典序在前）
      "task:13", // 13:10
      "interview:itw-b", // 11:00
      "interview:itw-a", // 10:00
      "task:14", // 08:00
      "plan:sess_f1a2d0bb", // 10-01 10:42
      "spec:preview-channel", // 非缺口组：15:30
      "task:7", // 14:05
      "spec:payment-split", // 09:00（与 #10 同刻，id 字典序在前）
      "task:10", // 09:00
      "task:12", // 08:00
      "task:9", // 已完成沉底（§13.2 列表列）
    ],
    "默认排序（attention 置顶 + updatedAt 倒序 + 已完成沉底）",
  );
  assert.equal(buildBoardListRows(matrixBoard()).length, 13, "全卡平铺：6 特性 + 7 卡一个不丢");
});

test("表格行 = 列表视图同一管线（同一集合/过滤/排序语义，派发指令「复用」）", () => {
  const rows = buildBoardListRows(matrixBoard(), { filter: { stage: "执行中" } });
  assert.deepEqual(
    rows.map((node) => node.id),
    buildBoardListRows(matrixBoard(), { filter: { stage: "执行中" } }).map((node) => node.id),
    "过滤后行序与列表视图逐位一致",
  );
  assert.deepEqual(
    buildBoardListRows(matrixBoard()).map((node) => node.id),
    buildBoardListRows(matrixBoard()).map((node) => node.id),
    "默认排序逐位一致",
  );
});

test("跳转前清过滤：只清四个筛子，保留排序视角（第二视角不被跳转重置）", () => {
  const controls: BoardListControls = {
    stage: "执行中",
    status: "active",
    attention: "unmerged-worktree",
    kind: "task",
    sort: "oldest",
  };
  const cleared = clearBoardListFilter(controls);
  assert.deepEqual(cleared, {
    stage: null,
    status: null,
    attention: null,
    kind: null,
    sort: "oldest",
  });
  // 幂等要有判据（评审 T1：`清(常量) == 常量` 那种自比自的字面量换不来信息）：
  // ① 再清一次结果不变；② 入参不被就地改写；③ 返回新对象（React 依赖引用变化）。
  assert.deepEqual(clearBoardListFilter(cleared), cleared, "幂等：再清一次结果一致");
  assert.deepEqual(
    controls,
    {
      stage: "执行中",
      status: "active",
      attention: "unmerged-worktree",
      kind: "task",
      sort: "oldest",
    },
    "入参对象不得被就地改写",
  );
  assert.notEqual(cleared, controls, "返回新对象（供 React 依赖比较）");
  assert.deepEqual(
    clearBoardListFilter(EMPTY_BOARD_LIST_CONTROLS),
    EMPTY_BOARD_LIST_CONTROLS,
    "本来就无过滤 → 值原样（但仍是新对象）",
  );
  assert.notEqual(
    clearBoardListFilter(EMPTY_BOARD_LIST_CONTROLS),
    EMPTY_BOARD_LIST_CONTROLS,
    "常量本身不被返回（冻结常量不可被调用方改写）",
  );
});
