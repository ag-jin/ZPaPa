/**
 * 折叠默认态夹具（卡 #89 / A4-3）。
 *
 * 形态真源：`boardEpicFixture` 同款字段形态（§10.2 epics 登记行 + §10.3 归属对 + 稿/卡行字段）。
 * 期望值由用例独立给出（对照 AD-5 规则与段位词表），不用实现回算。
 *
 * 覆盖形态（每条对应一个判据；缺口分布是**反例**设计——错误规则必咬）：
 *   - KANB1：含执行中成员（A 带缺口）→ 展开；
 *   - KANB2：全终态（已完成 + 已取消）→ 折叠（**全终态组展开必咬**）；
 *   - DONE1：全终态 → 折叠；DONE2：终态成员带缺口（unmerged-worktree）→ 展开
 *     （**缺口组折叠必咬**：缺口不许被折叠组埋掉——OB-2 共洽点）；
 *   - 无归属稿 H（已完成，无缺口）→ 稿层折叠；I（待办）→ 稿层展开（叶级规则）。
 */

function task(no: number, stage: string, attention: string[] = []): Record<string, unknown> {
  return {
    no,
    label: String(no),
    title: `卡 ${no}`,
    details: "",
    status: taskStatus(stage),
    statusRule: "夹具",
    stage,
    draft: false,
    blockers: [],
    attention,
    lastRun: null,
    activeRun: null,
    updatedAt: "2026-10-11T06:00:00+08:00",
  };
}

function taskStatus(stage: string): string {
  if (stage === "已完成") return "completed";
  if (stage === "已取消") return "cancelled";
  if (stage === "待办") return "pending";
  return "active";
}

/** 夹具特性形状（浏览器脚本要按标题加长做溢出压力，title 参与类型面）。 */
export interface FoldFixtureFeature {
  id: string;
  title: string;
  [key: string]: unknown;
}

function feature(
  id: string,
  no: number,
  planCode: string,
  title: string,
  stage: string,
  attention: string[],
  taskNo: number,
  attribution: { epic: string; phase: number } | null,
): FoldFixtureFeature {
  return {
    id,
    no,
    label: String(no),
    planCode,
    kind: id.startsWith("spec:") ? "spec" : "plan",
    ...(attribution ? { epic: attribution.epic, phase: attribution.phase } : {}),
    title,
    details: "",
    status: taskStatus(stage),
    statusRule: "夹具",
    stage,
    stageRule: "夹具",
    origin: { type: "plan-session", planRef: `.zcode/plans/${planCode}.md` },
    progress: null,
    evidence: [],
    createdAt: "2026-10-09T10:00:00+08:00",
    updatedAt: "2026-10-11T06:00:00+08:00",
    currentAssignee: null,
    attention,
    tasks: [task(taskNo, stage)],
  };
}

export const FOLD_BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-11T06:00:00+08:00",
  generatedBy: "zcode-board/0.5.0",
  epics: [
    { code: "KANB", title: "看板系统", status: "active" },
    { code: "DONE", title: "终态史诗", status: "active" },
  ],
  features: [
    // KANB1：含执行中成员（A 带缺口）→ 展开；同组终态成员 B 自己的稿层仍折叠。
    feature(
      "plan:fold-active",
      201,
      "FLA1",
      "带缺口的活跃稿",
      "执行中",
      ["interrupted-resume"],
      301,
      {
        epic: "epic:KANB",
        phase: 1,
      },
    ),
    feature("plan:fold-done-a", 202, "FLB1", "一期已完成稿", "已完成", [], 302, {
      epic: "epic:KANB",
      phase: 1,
    }),
    // KANB2：全终态（已完成 + 已取消）→ 组件折叠。
    feature("plan:fold-done-b", 203, "FLC2", "二期已完成稿", "已完成", [], 303, {
      epic: "epic:KANB",
      phase: 2,
    }),
    feature("plan:fold-cancelled-a", 204, "FLD2", "二期已取消稿", "已取消", [], 304, {
      epic: "epic:KANB",
      phase: 2,
    }),
    // DONE1：全终态 → 折叠；DONE2：终态成员带缺口 → 展开（缺口优先）。
    feature("plan:fold-done-c", 205, "FLE1", "一期已完成稿", "已完成", [], 305, {
      epic: "epic:DONE",
      phase: 1,
    }),
    feature("plan:fold-cancelled-b", 206, "FLF1", "一期已取消稿", "已取消", [], 306, {
      epic: "epic:DONE",
      phase: 1,
    }),
    feature(
      "plan:fold-gap-terminal",
      207,
      "FLG2",
      "二期终态带缺口稿",
      "已完成",
      ["unmerged-worktree"],
      307,
      {
        epic: "epic:DONE",
        phase: 2,
      },
    ),
    // 无归属稿：叶级规则（H 已完成 → 折叠；I 待办 → 展开）。
    feature("spec:fold-done-ungrouped", 208, "FLH0", "无归属已完成稿", "已完成", [], 308, null),
    feature("spec:fold-todo-ungrouped", 209, "FLI0", "无归属待办稿", "待办", [], 309, null),
  ],
  attentionSummary: {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 1,
  },
  diagnostics: [],
};
