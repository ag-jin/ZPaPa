/**
 * 组序反例夹具（卡 #88 / A4-2；AD-4 改判 = 纯期次序）——与 `boardEpicFixture.ts`（A4-1/A4-1b 三层
 * 容器夹具）分文件：本夹具只服务组序断言，形态真源同 `board.golden.json` 的 epic 段。
 *
 * 期次组序只由期次序数字升序决定，四条**被拒绝的排序依据**同时嵌在夹具里，任一条被误用都会让
 * 断言失败（反例必咬）：
 *   - 缺口优先（被改判否掉的「缺口优先 + 期次序混合」）：带缺口（`attention`）的稿在 **phase 2**
 *     （中间期），缺口优先会把 KANB2 提到最前；
 *   - 文档序/成员登记序优先：features[] 故意乱序（phase 2 → 3 → 1 → 10 → 1），
 *     按文档序或首个成员序会得到 KANB2/KANB3/KANB1/KANB10；
 *   - 显示名字典序：含 **phase 10**（`KANB10`），字典序会排成 KANB1 → KANB10 → KANB2 → KANB3
 *     （纯期次序是数字升序：1 → 2 → 3 → 10）；
 *   - 完成度/段位优先：成员全为「待办」（pending），不引入段位差异（看板同列承载全部四期，
 *     四视图文档序可直接对照）。
 * 独立真源：markers.md §10.1/§10.3（`phase` = 单值正整数期次序，1,2,3…）与 AD-4 拍板原句
 * （纯期次序）。期望值手推自本夹具，不用实现回算。
 */
export const EPIC_BOARD_PHASE_ORDER = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-11T06:00:00+08:00",
  generatedBy: "zcode-board/0.5.0",
  epics: [{ code: "KANB", title: "看板系统", status: "active" }],
  features: [
    // 0. phase 2（缺口稿）：文档序首位 + 带 attention——「缺口优先」会把它排到最前。
    {
      id: "plan:plan-phase-two-gap",
      no: 92,
      label: "92",
      planCode: "PH2G",
      kind: "plan",
      epic: "epic:KANB",
      phase: 2,
      title: "二期次缺口稿",
      details: "组序反例：缺口在中间期，纯期次序下 KANB2 仍居中。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", sessionId: "sess_phase_two" },
      progress: null,
      evidence: [".zcode/plans/plan-phase-two-gap.md"],
      createdAt: "2026-10-09T10:00:00+08:00",
      updatedAt: "2026-10-10T09:00:00+08:00",
      currentAssignee: null,
      attention: ["interrupted-resume"],
      tasks: [],
    },
    // 1. phase 3：文档序第二，期次序第三。
    {
      id: "plan:plan-phase-three",
      no: 93,
      label: "93",
      planCode: "PH3X",
      kind: "plan",
      epic: "epic:KANB",
      phase: 3,
      title: "三期次稿",
      details: "组序反例：文档序在 phase 1 之前。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", sessionId: "sess_phase_three" },
      progress: null,
      evidence: [".zcode/plans/plan-phase-three.md"],
      createdAt: "2026-10-09T11:00:00+08:00",
      updatedAt: "2026-10-10T10:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 2. phase 1 甲稿：文档序第三，期次序第一。
    {
      id: "plan:plan-phase-one-a",
      no: 90,
      label: "90",
      planCode: "PH1A",
      kind: "plan",
      epic: "epic:KANB",
      phase: 1,
      title: "一期次甲稿",
      details: "一期两稿之一（AD-2 期次只作分组头）。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", sessionId: "sess_phase_one_a" },
      progress: null,
      evidence: [".zcode/plans/plan-phase-one-a.md"],
      createdAt: "2026-10-09T12:00:00+08:00",
      updatedAt: "2026-10-09T12:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 3. phase 10：两位数期次（显示名 KANB10）——字典序会把它错排到 KANB2 之前。
    {
      id: "plan:plan-phase-ten",
      no: 95,
      label: "95",
      planCode: "PH10",
      kind: "plan",
      epic: "epic:KANB",
      phase: 10,
      title: "十期次稿",
      details: "组序反例：两位数期次，排序须按数字不按显示名字典序。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", sessionId: "sess_phase_ten" },
      progress: null,
      evidence: [".zcode/plans/plan-phase-ten.md"],
      createdAt: "2026-10-09T13:00:00+08:00",
      updatedAt: "2026-10-09T13:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [],
    },
    // 4. phase 1 乙稿：一期两稿同组（成员保持文档序：甲稿在前）。
    {
      id: "plan:plan-phase-one-b",
      no: 91,
      label: "91",
      planCode: "PH1B",
      kind: "plan",
      epic: "epic:KANB",
      phase: 1,
      title: "一期次乙稿",
      details: "一期两稿之二。",
      status: "pending",
      statusRule: "plan 无勾选记录",
      stage: "待办",
      stageRule: "status=pending",
      origin: { type: "plan-session", sessionId: "sess_phase_one_b" },
      progress: null,
      evidence: [".zcode/plans/plan-phase-one-b.md"],
      createdAt: "2026-10-09T14:00:00+08:00",
      updatedAt: "2026-10-09T14:00:00+08:00",
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
