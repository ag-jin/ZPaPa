import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";

/**
 * 分组呈现夹具（卡 #46 / 规则书 v2）：一个计划（计划码 UI01，执行中 + 待办两卡，其一带缺口与
 * activeRun）+ 一个 spec（待办，无计划码）。独立成文件：三处渲染守卫（看板/列表/表格）共用。
 */

function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    details: "",
    status: "pending",
    statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
    stage: "待办",
    stageRule: "status=pending 且无 activeRun",
    source: { file: ".zcode/plans/plan-zcode-ui.md", selector: "item" },
    origin: { planRef: ".zcode/plans/plan-zcode-ui.md" },
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
    updatedAt: "2026-10-10T09:00:00+08:00",
    ...overrides,
  };
}

const PLAN = {
  id: "plan:plan-zcode-ui",
  no: 31,
  label: "31",
  planCode: "UI01",
  kind: "plan",
  title: "ZCode 看板 UI",
  details: "",
  status: "active",
  statusRule: "plan 有勾选记录（§4.3 规则 3）",
  stage: "执行中",
  stageRule: "status=active（阶段推进/部分勾选，无 run 级 activeRun）",
  origin: { type: "plan-session", planRef: ".zcode/plans/plan-zcode-ui.md" },
  progress: null,
  evidence: [],
  updatedAt: "2026-10-10T09:00:00+08:00",
  currentAssignee: "implementer",
  attention: [],
  tasks: [
    task({
      no: 46,
      label: "5",
      title: "执行中的卡",
      stage: "执行中",
      stageRule: "activeRun.role=implementer（干活角色，§4.5）",
      attention: ["interrupted-resume"],
      lastRun: {
        at: "2026-10-10T09:30:00+08:00",
        role: "implementer",
        result: "partial",
        stoppedAt: 46,
        next: "继续",
      },
      activeRun: { role: "implementer", at: "2026-10-10T09:30:00+08:00" },
      currentAssignee: "implementer",
      updatedAt: "2026-10-10T09:30:00+08:00",
      evidence: [".zcode/board/evidence/T36u/00-baseline-ui-suite.log"],
    }),
    task({
      no: 47,
      label: "6",
      title: "待办卡",
      blockers: [
        {
          kind: "external",
          summary: "外部依赖未定（沙箱凭据缺失）",
          evidence: [".zcode/plans/plan-zcode-ui.md"],
        },
      ],
      evidence: [".zcode/plans/plan-zcode-ui.md"],
    }),
  ],
};

const SPEC = {
  id: "spec:alpha",
  no: 20,
  label: "20",
  planCode: null,
  kind: "spec",
  title: "Alpha 特性",
  details: "",
  status: "active",
  statusRule: "progress.stages.design=active",
  stage: "待办",
  stageRule: "status=active（阶段推进/部分勾选，无 run 级 activeRun）",
  origin: { type: "spec-driven-workflow", specRoot: "specs/alpha/" },
  progress: null,
  evidence: [],
  updatedAt: "2026-10-10T08:00:00+08:00",
  currentAssignee: null,
  attention: [],
  tasks: [task({ no: 21, label: "20.1", title: "规格任务" })],
};

export const GROUPING_BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-10T10:00:00+08:00",
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

/** 夹具 → ready 态（解析失败即抛，防夹具漂移导致断言静默失效）。 */
export function readyGroupingBoard(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return { kind: "ready", board: outcome.board };
}
