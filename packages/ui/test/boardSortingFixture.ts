import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";

/**
 * 排序/沉底夹具（卡 #65）：一张**混合板**——已完成与未完成同章节、带缺口卡、嵌套子卡、
 * 各不相同的 `updatedAt`，以及一个整体已完成的特性块。
 *
 * 期望值的独立真源：消费契约 §3.5（attention 置顶 + `updatedAt` 倒序 + 已完成沉底）与
 * 卡 #65 验收（三视角：最近更新 / 最老未动 / 段位序）。**期望行序逐条写在测试里**，
 * 不由实现回算——本夹具只提供数据。
 *
 * 覆盖点（每张卡的用途）：
 * - #71 `阶段零/已完成`：整个章节只有已完成卡 → 章节位置不动的口径（结构序不重排区块）；
 * - #72 待办（12:00）与 #73 已完成（13:00，**更新**）：默认序里完成必须沉底，不许按时间抢位；
 * - #74 已完成（08:00）：完成组内的相对序（倒序）；
 * - #75 执行中 + 缺口（07:00，最老）：attention 置顶恒在（三种排序都置顶）；
 * - #76 已完成（11:00）/ #77 待办（10:00）：#75 的嵌套子卡——同级沉底在每一层生效；
 * - #78 待办（07:30）/ #82 执行中（08:30）：**区分「最近更新」与「段位序」的关键对**——
 *   时间序里 #82 在前（更新），段位序里 #78 在前（待办在流水序上早于执行中）；
 * - #79 已完成（09:30）：第二章节内沉底；
 * - `spec:spec-done` + #81：整体已完成的特性块（块位置按文档序不动，块内卡片沉底）。
 */

function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    details: "",
    status: "pending",
    statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
    stage: "待办",
    stageRule: "status=pending 且无 activeRun",
    source: { file: ".zcode/plans/plan-sort.md", selector: "item" },
    origin: { planRef: ".zcode/plans/plan-sort.md" },
    requirements: [],
    evidence: [],
    assignees: ["implementer", "test-verifier", "code-reviewer", "integrator"],
    draft: true,
    blockers: [],
    attention: [],
    lastRun: null,
    activeRun: null,
    currentAssignee: null,
    worktree: null,
    pr: null,
    createdAt: "2026-10-10T05:00:00+08:00",
    updatedAt: "2026-10-10T09:00:00+08:00",
    ...overrides,
  };
}

const PLAN = {
  id: "plan:plan-sort",
  no: 70,
  label: "70",
  planCode: "SORT",
  kind: "plan",
  title: "排序与沉底",
  details: "",
  status: "active",
  statusRule: "plan 有勾选记录（§4.3 规则 3）",
  stage: "执行中",
  stageRule: "status=active（阶段推进/部分勾选，无 run 级 activeRun）",
  origin: { type: "plan-session", planRef: ".zcode/plans/plan-sort.md" },
  progress: null,
  evidence: [],
  updatedAt: "2026-10-10T09:50:00+08:00",
  currentAssignee: null,
  attention: [],
  tasks: [
    task({
      no: 71,
      label: "1",
      title: "阶段零的已完成卡",
      section: "阶段零",
      status: "completed",
      stage: "已完成",
      updatedAt: "2026-10-10T06:45:00+08:00",
    }),
    task({
      no: 72,
      label: "2",
      title: "待办卡（较新）",
      section: "阶段一",
      updatedAt: "2026-10-10T12:00:00+08:00",
    }),
    task({
      no: 73,
      label: "3",
      title: "已完成卡（最新）",
      section: "阶段一",
      status: "completed",
      stage: "已完成",
      updatedAt: "2026-10-10T13:00:00+08:00",
    }),
    task({
      no: 74,
      label: "4",
      title: "已完成卡（较老）",
      section: "阶段一",
      status: "completed",
      stage: "已完成",
      updatedAt: "2026-10-10T08:00:00+08:00",
    }),
    task({
      no: 75,
      label: "5",
      title: "执行中卡（带缺口）",
      section: "阶段一",
      stage: "执行中",
      stageRule: "activeRun.role=implementer（干活角色，§4.5）",
      attention: ["interrupted-resume"],
      updatedAt: "2026-10-10T07:00:00+08:00",
      // 嵌套子卡在 board.json 里就是父卡的 `tasks`（解析器：`node.tasks` → children）。
      tasks: [
        task({
          no: 76,
          label: "5.1",
          title: "嵌套已完成卡",
          section: "阶段一",
          status: "completed",
          stage: "已完成",
          updatedAt: "2026-10-10T11:00:00+08:00",
        }),
        task({
          no: 77,
          label: "5.2",
          title: "嵌套待办卡",
          section: "阶段一",
          updatedAt: "2026-10-10T10:00:00+08:00",
        }),
      ],
    }),
    task({
      no: 78,
      label: "7",
      title: "阶段二待办卡",
      section: "阶段二",
      updatedAt: "2026-10-10T07:30:00+08:00",
    }),
    task({
      no: 82,
      label: "9",
      title: "阶段二执行中卡",
      section: "阶段二",
      stage: "执行中",
      stageRule: "activeRun.role=implementer（干活角色，§4.5）",
      updatedAt: "2026-10-10T08:30:00+08:00",
    }),
    task({
      no: 79,
      label: "8",
      title: "阶段二已完成卡",
      section: "阶段二",
      status: "completed",
      stage: "已完成",
      updatedAt: "2026-10-10T09:30:00+08:00",
    }),
  ],
};

const SPEC = {
  id: "spec:spec-done",
  no: 80,
  label: "80",
  planCode: null,
  kind: "spec",
  title: "已完成的规格特性",
  details: "",
  status: "completed",
  statusRule: "progress 阶段全部完成",
  stage: "已完成",
  stageRule: "status=completed（勾选=已合并 6.3 / progress 阶段完成）",
  origin: { type: "spec-driven-workflow", specRoot: "specs/sort-done/" },
  progress: null,
  evidence: [],
  updatedAt: "2026-10-10T06:00:00+08:00",
  currentAssignee: null,
  attention: [],
  tasks: [
    task({
      no: 81,
      label: "80.1",
      title: "规格已完成卡",
      status: "completed",
      stage: "已完成",
      updatedAt: "2026-10-10T05:30:00+08:00",
    }),
  ],
};

export const SORTING_BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-10T14:00:00+08:00",
  generatedBy: "zcode-board/0.2",
  features: [PLAN, SPEC],
  attentionSummary: {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 0,
  },
  diagnostics: [],
};

/** 夹具 → 视图模型（解析失败即抛，防夹具漂移导致断言静默失效）。 */
export function sortingBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(SORTING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

/** 夹具 → 面板状态（渲染断言用）。 */
export function readySortingBoard(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(SORTING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return { kind: "ready", board: outcome.board };
}
