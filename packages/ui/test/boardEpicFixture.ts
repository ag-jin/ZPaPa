/**
 * epic 三层容器夹具（卡 #87 / A4-1）。
 *
 * 形态真源：`skills/zcode-board/assets/samples/board.golden.json` 的 epic 段——`epics[]` 登记行
 * 三字段（code/title/status，§10.2）与 `features[].epic`/`phase` 归属对（登记 id `epic:<码>` 或
 * 稳定号，§10.3）；稿/卡行字段形态沿用同 golden（planCode/stage/attention/tasks/…）。
 * 期望值由用例独立给出（对照 markers.md §10 与 board.md 渲染口径），不用实现回算。
 *
 * 覆盖形态（每条对应一个判据）：
 *   - 一期两稿（PLW0 与 UI01 同属 epic:KANB phase 1——AD-2：期次只作分组头，一期可含多稿）；
 *   - 二期一稿（UI02 = epic:KANB phase 2——期次序升序成组）；
 *   - 终态 epic（CNCL 登记行 cancelled，成员稿照常呈现——成员活跃/成员状态不复活 epic 终态，§10.5）；
 *   - 无归属稿（spec:preview-channel，epic/phase 双缺省——顶层平铺、不标「未归属」，AD-8/§10.7）；
 *   - 孤儿引用（epic:`epic:NOPE` 无登记行——不造章、顶层平铺，同 board.md `epicCodeOf` 口径）；
 *   - 稳定号引用（epic: 31 正整数——board.json 无登记面映射，渲染层不归组，同 board.md 口径）。
 */

export const EPIC_BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-11T06:00:00+08:00",
  generatedBy: "zcode-board/0.5.0",
  epics: [
    { code: "KANB", title: "看板系统", status: "active" },
    { code: "CNCL", title: "取消史诗", status: "cancelled" },
  ],
  features: [
    // 0. 无归属稿（文档序首位）：顶层平铺，不进任何 epic 章。
    {
      id: "spec:preview-channel",
      no: 1,
      label: "1",
      planCode: "PREV",
      kind: "spec",
      title: "预览通道",
      details: "无 epic 归属的既有稿（AD-8：顶层平铺）。",
      status: "active",
      statusRule: "progress.stages.design=active",
      stage: "执行中",
      stageRule: "status=active（阶段推进）",
      origin: { type: "spec-driven-workflow", specRoot: "specs/preview-channel/" },
      progress: { totalTasks: 1, completedTasks: 0 },
      evidence: ["specs/preview-channel/requirements.md"],
      createdAt: "2026-10-08T10:00:00+08:00",
      updatedAt: "2026-10-09T15:30:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [
        {
          no: 7,
          label: "1.1",
          title: "预览发布通道",
          details: "",
          status: "pending",
          stage: "待办",
          draft: false,
          blockers: [],
          attention: [],
          lastRun: null,
          activeRun: null,
          updatedAt: "2026-10-09T14:05:00+08:00",
        },
      ],
    },
    // 1. KANB 一期第一稿（PLW0）：带 attention 缺口（展开判据）。
    {
      id: "plan:plan-boardv2-a",
      no: 31,
      label: "31",
      planCode: "PLW0",
      kind: "plan",
      epic: "epic:KANB",
      phase: 1,
      title: "看板 v2 一期甲稿",
      details: "KANB1 一期两稿之一。",
      status: "active",
      statusRule: "plan 有勾选记录",
      stage: "执行中",
      stageRule: "status=active",
      origin: { type: "plan-session", sessionId: "sess_3e32a5a2" },
      progress: { totalTasks: 2, completedTasks: 1 },
      evidence: [".zcode/plans/plan-boardv2-a.md"],
      createdAt: "2026-10-09T10:00:00+08:00",
      updatedAt: "2026-10-10T09:00:00+08:00",
      currentAssignee: "implementer",
      attention: ["interrupted-resume"],
      tasks: [
        {
          no: 87,
          label: "1",
          title: "三层容器树形落位",
          details: "",
          status: "active",
          stage: "执行中",
          draft: false,
          blockers: [],
          attention: [],
          lastRun: null,
          activeRun: null,
          updatedAt: "2026-10-11T06:00:00+08:00",
        },
        {
          no: 88,
          label: "2",
          title: "二期条目",
          details: "",
          status: "completed",
          stage: "已完成",
          draft: false,
          blockers: [],
          attention: [],
          lastRun: null,
          activeRun: null,
          updatedAt: "2026-10-10T09:00:00+08:00",
        },
      ],
    },
    // 2. KANB 一期第二稿（UI01）——一期两稿同组头（AD-2）。
    {
      id: "plan:plan-zcode-ui",
      no: 32,
      label: "32",
      planCode: "UI01",
      kind: "plan",
      epic: "epic:KANB",
      phase: 1,
      title: "ZCode 看板 UI 一期稿",
      details: "KANB1 一期两稿之二。",
      status: "active",
      statusRule: "plan 有勾选记录",
      stage: "审核中",
      stageRule: "status=active（审核中）",
      origin: { type: "plan-session", planRef: ".zcode/plans/plan-zcode-ui.md" },
      progress: null,
      evidence: [".zcode/plans/plan-zcode-ui.md"],
      createdAt: "2026-10-09T11:00:00+08:00",
      updatedAt: "2026-10-10T10:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 3. 稳定号引用（epic: 31）：无登记面映射 → 顶层平铺。
    {
      id: "plan:plan-by-number",
      no: 33,
      label: "33",
      planCode: "NUM1",
      kind: "plan",
      epic: 31,
      phase: 1,
      title: "稳定号归属引用稿",
      details: "epic 引用是稳定号：board.json 无登记面映射，渲染层不归组。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", planRef: ".zcode/plans/plan-by-number.md" },
      progress: null,
      evidence: [".zcode/plans/plan-by-number.md"],
      createdAt: "2026-10-09T12:00:00+08:00",
      updatedAt: "2026-10-09T12:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 4. KANB 二期（UI02）：期次序升序的第二组。
    {
      id: "plan:plan-boardv2-b1",
      no: 34,
      label: "34",
      planCode: "UI02",
      kind: "plan",
      epic: "epic:KANB",
      phase: 2,
      title: "看板 v2 二期稿",
      details: "KANB2 单稿。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", planRef: ".zcode/plans/plan-boardv2-b1.md" },
      progress: null,
      evidence: [".zcode/plans/plan-boardv2-b1.md"],
      createdAt: "2026-10-09T13:00:00+08:00",
      updatedAt: "2026-10-09T13:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 5. 孤儿引用（epic:NOPE 无登记行）：不造章、顶层平铺。
    {
      id: "plan:plan-orphan",
      no: 35,
      label: "35",
      planCode: "ORPH",
      kind: "plan",
      epic: "epic:NOPE",
      phase: 1,
      title: "孤儿引用稿",
      details: "引用未登记 epic：照顶层平铺，不为孤儿造章。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", planRef: ".zcode/plans/plan-orphan.md" },
      progress: null,
      evidence: [".zcode/plans/plan-orphan.md"],
      createdAt: "2026-10-09T14:00:00+08:00",
      updatedAt: "2026-10-09T14:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 6. 终态 epic（CNCL）成员稿：登记行 cancelled，成员稿照常呈现（成员活跃不复活 epic 终态，§10.5）。
    {
      id: "plan:plan-cancelled-epic",
      no: 41,
      label: "41",
      planCode: "CNCL",
      kind: "plan",
      epic: "epic:CNCL",
      phase: 1,
      title: "取消史诗成员稿",
      details: "所属 epic 登记行已取消，成员稿自身段位照常呈现。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", planRef: ".zcode/plans/plan-cancelled-epic.md" },
      progress: null,
      evidence: [".zcode/plans/plan-cancelled-epic.md"],
      createdAt: "2026-10-09T15:00:00+08:00",
      updatedAt: "2026-10-09T15:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
  ],
  attentionSummary: {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 0,
  },
  diagnostics: [],
};

/**
 * 零 epic 板（同一文档的 `epics` 键整体移除 + 归属字段清空）：AD-8「零 epic 项目零变化」的判据夹具
 * ——渲染序与既有扁平树逐字一致。
 */
export const EPIC_BOARD_FLAT: Record<string, unknown> = (() => {
  const raw = structuredClone(EPIC_BOARD) as Record<string, unknown>;
  delete raw.epics;
  for (const feature of raw.features as Array<Record<string, unknown>>) {
    delete feature.epic;
    delete feature.phase;
  }
  return raw;
})();
