/**
 * 指引面（guide 面）测试夹具（卡 #136 / C3-1）。
 *
 * 形态真源：`~/.zcode/skills/zcode-board/assets/board.schema.json`（v2 + 四段派生追加键）
 * 与真实板 `.zcode/board/board.json` 的字段形态。本夹具是**形态夹具**，并且刻意构造了
 * 「派生投影 ≠ 按卡字段自算」的差异（禁自算反例的咬点，判据见 `boardGuideView.test.ts`）：
 *   - attentionSummary 合计 4，而节点 attention 码只有 2 条；
 *   - blocked[] 3 行归因（一卡两项），而挂 blockers 的卡只有 2 张；
 *   - active[] 2 张「执行中」（其中一张 status=pending 由 activeRun 派生），
 *     而 status=active 的卡只有 1 张。
 * 任何「按 status/blockers/节点 attention 自算槽位」的实现都会与这些期望值不符。
 */

export const GUIDE_WORKSPACE = "/workspace/ZCode";

/** 稳定的「现在」：相对时间断言不依赖运行时刻。 */
export const GUIDE_NOW = Date.parse("2026-10-11T16:00:00+08:00");

const ISO = "2026-10-11T15:20:00+08:00";

interface TaskSeed {
  no?: number;
  label: string;
  title: string;
  status: string;
  stage: string;
  blockers?: Array<Record<string, unknown>>;
  attention?: string[];
  activeRun?: { role: string; at: string } | null;
  nextAssignee?: string | null;
  currentAssignee?: string | null;
}

function task(seed: TaskSeed): Record<string, unknown> {
  return {
    ...(seed.no !== undefined ? { no: seed.no } : {}),
    label: seed.label,
    title: seed.title,
    details: "",
    status: seed.status,
    statusRule: "夹具",
    stage: seed.stage,
    stageRule: "夹具",
    assignees: ["implementer", "test-verifier", "code-reviewer", "integrator"],
    draft: false,
    blockers: seed.blockers ?? [],
    attention: seed.attention ?? [],
    lastRun: null,
    activeRun: seed.activeRun ?? null,
    worktree: null,
    pr: null,
    updatedAt: ISO,
    currentAssignee: seed.currentAssignee ?? null,
    nextAssignee: seed.nextAssignee ?? null,
  };
}

function planFeature(seed: {
  id: string;
  no: number;
  label: string;
  planCode: string;
  title: string;
  status: string;
  stage: string;
  phase?: number;
  tasks: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    id: seed.id,
    no: seed.no,
    label: seed.label,
    planCode: seed.planCode,
    epic: "epic:KANB",
    ...(seed.phase !== undefined ? { phase: seed.phase } : {}),
    kind: "plan",
    title: seed.title,
    details: "",
    status: seed.status,
    statusRule: "夹具",
    stage: seed.stage,
    stageRule: "夹具",
    origin: { type: "plan-session" },
    progress: null,
    evidence: [],
    createdAt: ISO,
    updatedAt: ISO,
    attention: [],
    currentAssignee: null,
    tasks: seed.tasks,
  };
}

/** 指引面板板：两计划在跑 + 一未拆解计划 + 一已取消计划 + 一 spec 特性。 */
export const GUIDE_BOARD: Record<string, unknown> = {
  version: 2,
  project: { root: GUIDE_WORKSPACE, name: "指引面夹具" },
  updatedAt: ISO,
  generatedBy: "zcode-board/test",
  epics: [{ code: "KANB", title: "看板二期", status: "active" }],
  features: [
    planFeature({
      id: "plan:plan-guide-a",
      no: 201,
      label: "201",
      planCode: "GUIA",
      title: "指引面骨架计划",
      status: "active",
      stage: "执行中",
      phase: 1,
      tasks: [
        task({
          no: 210,
          label: "1.1",
          title: "置顶五槽条",
          status: "pending",
          stage: "待办",
          nextAssignee: "implementer",
        }),
        task({
          no: 211,
          label: "1.2",
          title: "计划区块骨架",
          status: "completed",
          stage: "已完成",
        }),
        task({
          no: 212,
          label: "1.3",
          title: "卡片点击接线",
          status: "completed",
          stage: "已完成",
        }),
        task({
          no: 213,
          label: "1.4",
          title: "溢出探针",
          status: "pending",
          stage: "执行中",
          activeRun: { role: "implementer", at: ISO },
          currentAssignee: "implementer",
          nextAssignee: "test-verifier",
        }),
      ],
    }),
    {
      id: "spec:guide-spec",
      no: 204,
      label: "204",
      kind: "spec",
      title: "规格特性（不入计划区块）",
      details: "",
      status: "active",
      statusRule: "夹具",
      stage: "执行中",
      stageRule: "夹具",
      origin: { type: "spec-driven-workflow" },
      progress: null,
      evidence: [],
      createdAt: ISO,
      updatedAt: ISO,
      attention: ["interviewed-not-arranged"],
      currentAssignee: null,
      tasks: [
        task({ no: 215, label: "204.1", title: "规格卡一", status: "active", stage: "执行中" }),
        task({
          no: 216,
          label: "204.2",
          title: "规格卡二",
          status: "pending",
          stage: "审核中",
          activeRun: { role: "test-verifier", at: ISO },
        }),
        task({
          no: 218,
          label: "204.3",
          title: "规格卡三（双依赖受阻）",
          status: "pending",
          stage: "待办",
          blockers: [
            { kind: "dependency", blockedBy: 112, summary: "依赖 #112" },
            { kind: "dependency", blockedBy: 113, summary: "依赖 #113" },
          ],
          attention: ["interrupted-resume"],
        }),
      ],
    },
    planFeature({
      id: "plan:plan-guide-b",
      no: 202,
      label: "202",
      planCode: "GUIB",
      title: "进度胶囊零件计划",
      status: "pending",
      stage: "待办",
      phase: 2,
      tasks: [
        task({
          no: 220,
          label: "1.1",
          title: "胶囊形态",
          status: "pending",
          stage: "待办",
          nextAssignee: "implementer",
        }),
        task({
          no: 221,
          label: "1.2",
          title: "微条用法",
          status: "pending",
          stage: "待办",
          nextAssignee: "implementer",
        }),
        task({
          no: 217,
          label: "1.3",
          title: "外部审批等待",
          status: "pending",
          stage: "待办",
          blockers: [{ kind: "external", summary: "等待外部审批" }],
        }),
      ],
    }),
    planFeature({
      id: "plan:plan-guide-d",
      no: 205,
      label: "205",
      planCode: "GUID",
      title: "未拆解计划",
      status: "pending",
      stage: "待设计",
      tasks: [],
    }),
    planFeature({
      id: "plan:plan-guide-c",
      no: 203,
      label: "203",
      planCode: "GUIC",
      title: "已取消计划（不入区块）",
      status: "cancelled",
      stage: "已取消",
      tasks: [],
    }),
  ],
  frontier: [
    {
      rank: 1,
      no: 210,
      title: "置顶五槽条",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 2,
      no: 220,
      title: "胶囊形态",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 3,
      no: 221,
      title: "微条用法",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [210],
    },
  ],
  active: [
    {
      no: 213,
      title: "溢出探针",
      stage: "执行中",
      currentAssignee: "implementer",
      activeRun: { role: "implementer", at: ISO },
      nextAssignee: "test-verifier",
    },
    {
      no: 215,
      title: "规格卡一",
      stage: "执行中",
      currentAssignee: null,
      activeRun: { role: "implementer", at: ISO },
      nextAssignee: null,
    },
    {
      no: 216,
      title: "规格卡二",
      stage: "审核中",
      currentAssignee: null,
      activeRun: { role: "test-verifier", at: ISO },
      nextAssignee: null,
    },
  ],
  blocked: [
    {
      no: 217,
      title: "外部审批等待",
      stage: "待办",
      blockerKind: "external",
      targetId: null,
      summary: "等待外部审批",
    },
    {
      no: 218,
      title: "规格卡三（双依赖受阻）",
      stage: "待办",
      blockerKind: "dependency",
      targetId: 112,
      summary: "依赖 #112",
    },
    {
      no: 218,
      title: "规格卡三（双依赖受阻）",
      stage: "待办",
      blockerKind: "dependency",
      targetId: 113,
      summary: "依赖 #113",
    },
  ],
  recent: [
    {
      no: 210,
      title: "置顶五槽条",
      at: ISO,
      role: "implementer",
      result: "done",
      stoppedAt: null,
      next: null,
    },
    {
      no: 211,
      title: "计划区块骨架",
      at: ISO,
      role: "test-verifier",
      result: "done",
      stoppedAt: null,
      next: null,
    },
    {
      no: 213,
      title: "溢出探针",
      at: ISO,
      role: "debugger",
      result: "partial",
      stoppedAt: 213,
      next: "续跑探针",
    },
    {
      no: 215,
      title: "规格卡一",
      at: ISO,
      role: "implementer",
      result: "done",
      stoppedAt: null,
      next: null,
    },
    {
      no: 220,
      title: "胶囊形态",
      at: ISO,
      role: "implementer",
      result: "done",
      stoppedAt: null,
      next: null,
    },
  ],
  attentionSummary: {
    interviewedNotArranged: 2,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 1,
  },
  diagnostics: [],
};

/**
 * 计划内卡号（fixture 里 task 对象默认不带 no，四段投影的卡号与计划内卡的对应
 * 由该表承载：真实编译器会给每张卡 `no`；夹具只在计划 A 的卡上落 `no`，
 * 其余卡仅用于计数/投影字段本体的形态覆盖。
 */
export const GUIDE_PLAN_A_CARD_NOS = { frontier: 210, active: 213 } as const;

/** 零 attention 板：五槽全 0（空槽形态）+ 计划区块仍有内容。 */
export function buildGuideZeroBoard(): Record<string, unknown> {
  const raw = structuredClone(GUIDE_BOARD);
  raw.attentionSummary = {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 0,
    unmergedWorktree: 0,
  };
  raw.frontier = [];
  raw.active = [];
  raw.blocked = [];
  raw.recent = [];
  return raw;
}

/** 旧版编译器产物：四段键整体缺省（视图侧不得自算兜底，只许指名重编译）。 */
export function buildGuideLegacyBoard(): Record<string, unknown> {
  const raw = structuredClone(GUIDE_BOARD);
  delete raw.frontier;
  delete raw.active;
  delete raw.blocked;
  delete raw.recent;
  return raw;
}

/** 无计划特性的板（spec-only 项目）：计划区块必须给明确空态，不留空白。 */
export function buildGuideNoPlansBoard(): Record<string, unknown> {
  const raw = structuredClone(GUIDE_BOARD);
  raw.features = (raw.features as Array<Record<string, unknown>>).filter(
    (feature) => feature.kind !== "plan",
  );
  raw.frontier = [];
  raw.active = [];
  raw.blocked = [];
  raw.recent = [];
  return raw;
}

export const GUIDE_BOARD_JSON = JSON.stringify(GUIDE_BOARD);
