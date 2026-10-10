import assert from "node:assert/strict";
import test from "node:test";
import { formatBoardNodeId } from "../src/board/boardPresentation.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { collectBoardViewNodes } from "../src/board/boardViewsViewModel.js";

/**
 * 编号体系与视图节点数据面的守卫（卡 #46 / 规则书 v2：B1 编号显示 + B8 四视图一致性数据面）。
 *
 * 期望值的独立真源：用户 2026-10-10 实测反馈（卡文 10 条）+ 契约 v2.2 §13（计划码-层级格式）：
 *   - 完整形态 `UI01-1.2`（计划码-层级）；树形/列表/表格在同一计划分组内可省略前缀只显示 `1.2`；
 *   - 无计划码（spec 特性）维持 `ID-<label>`；
 *   - 计划码/层级/当前执行者/章节从 board.json 只读映射；任务节点继承所属特性的计划码（显示层）。
 */

const BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-10T10:00:00+08:00",
  generatedBy: "zcode-board/0.2",
  features: [
    {
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
      evidence: [".zcode/plans/plan-zcode-ui.md"],
      updatedAt: "2026-10-10T09:00:00+08:00",
      currentAssignee: "implementer",
      attention: [],
      tasks: [
        {
          no: 46,
          label: "5",
          title: "UI 视觉规则书 v2 全面改造",
          details: "十条变更。",
          section: "UI 期",
          status: "active",
          statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
          stage: "执行中",
          stageRule: "activeRun.role=implementer（干活角色，§4.5）",
          source: { file: ".zcode/plans/plan-zcode-ui.md", selector: "item-5" },
          origin: { planRef: ".zcode/plans/plan-zcode-ui.md" },
          requirements: [],
          evidence: [],
          assignees: ["implementer", "test-verifier", "code-reviewer", "integrator"],
          draft: true,
          blockers: [],
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
          worktree: null,
          pr: null,
          createdAt: "2026-10-10T09:00:00+08:00",
          updatedAt: "2026-10-10T09:30:00+08:00",
          tasks: [
            {
              no: 47,
              label: "5.1",
              title: "编译器侧",
              details: "",
              status: "pending",
              statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
              stage: "待办",
              stageRule: "status=pending 且无 activeRun",
              source: { file: ".zcode/plans/plan-zcode-ui.md", selector: "item-6" },
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
              createdAt: "2026-10-10T09:00:00+08:00",
              updatedAt: "2026-10-10T09:00:00+08:00",
            },
          ],
        },
      ],
    },
    {
      id: "spec:alpha",
      no: 20,
      label: "20",
      kind: "spec",
      title: "Alpha 特性",
      details: "",
      status: "pending",
      statusRule: "spec 无 progress.json 与 tasks.md（§4.3 规则 2 兜底）",
      stage: "待办",
      stageRule: "status=pending 且无 activeRun",
      origin: { type: "spec-driven-workflow", specRoot: "specs/alpha/" },
      progress: null,
      evidence: [],
      updatedAt: "2026-10-10T08:00:00+08:00",
      currentAssignee: null,
      attention: [],
      tasks: [
        {
          no: 21,
          label: "20.1",
          title: "规格任务",
          details: "",
          status: "pending",
          statusRule: "tasks.md checkbox unchecked（仅反映已合并部分，6.3）",
          stage: "待办",
          stageRule: "status=pending 且无 activeRun",
          source: { file: "specs/alpha/tasks.md", selector: "task-1" },
          origin: { specRoot: "specs/alpha/" },
          requirements: [],
          evidence: [],
          assignees: ["implementer", "test-verifier"],
          draft: false,
          blockers: [],
          attention: [],
          lastRun: null,
          activeRun: null,
          currentAssignee: null,
          worktree: null,
          pr: null,
          createdAt: "2026-10-10T08:00:00+08:00",
          updatedAt: "2026-10-10T08:00:00+08:00",
        },
      ],
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

function readyBoard() {
  const outcome = parseBoardJson(JSON.stringify(BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

/* ---------------- 编号格式（B1） ---------------- */

test("编号：完整形态 = 计划码-层级（UI01-1.2）", () => {
  assert.equal(
    formatBoardNodeId({ no: 46, label: "1.2", planCode: "UI01" }),
    "UI01-1.2",
    "有计划码：计划码-层级",
  );
  assert.equal(
    formatBoardNodeId({ no: 21, label: "20.1", planCode: null }),
    "ID-20.1",
    "无计划码（spec）：维持 ID-<label>",
  );
});

test("编号：短形态（树形/列表/表格同计划分组内）省略计划码前缀", () => {
  assert.equal(
    formatBoardNodeId({ no: 46, label: "1.2", planCode: "UI01" }, { short: true }),
    "1.2",
    "有计划码：只显示层级",
  );
  assert.equal(
    formatBoardNodeId({ no: 21, label: "20.1", planCode: null }, { short: true }),
    "ID-20.1",
    "无计划码：没有前缀可省，形态不变",
  );
});

test("编号：降级链 —— 缺 label 用稳定号；未领号返回 null（组件渲染「未领号」角标）", () => {
  assert.equal(
    formatBoardNodeId({ no: 21, label: null, planCode: "UI01" }),
    "ID-21",
    "§2.4 过渡态：有号无 label → ID-<no>",
  );
  assert.equal(formatBoardNodeId({ no: null, label: null, planCode: null }), null, "未领号 → null");
});

/* ---------------- 视图模型数据面（B8/B2/B6） ---------------- */

test("视图模型：planCode / currentAssignee / section / depth 只读映射", () => {
  const board = readyBoard();
  const [uiPlan, alpha] = board.features;
  assert.equal(uiPlan?.planCode, "UI01", "特性 planCode 映射");
  assert.equal(uiPlan?.currentAssignee, "implementer", "特性 currentAssignee 映射");
  assert.equal(uiPlan?.tasks[0]?.currentAssignee, "implementer", "任务 currentAssignee 映射");
  assert.equal(uiPlan?.tasks[0]?.section, "UI 期", "任务 section（计划稿章节）映射");
  assert.equal(alpha?.planCode, null, "无计划码 → null（不编造）");
  assert.equal(alpha?.tasks[0]?.section, null, "spec 任务无 section → null");

  const nodes = collectBoardViewNodes(board);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("plan:plan-zcode-ui")?.depth, 0, "特性节点 depth = 0");
  assert.equal(byId.get("plan:plan-zcode-ui")?.planCode, "UI01", "特性节点带计划码");
  assert.equal(byId.get("task:46")?.depth, 1, "顶层任务 depth = 1（结构深度，不信 label 段数）");
  assert.equal(byId.get("task:47")?.depth, 2, "嵌套子任务 depth = 2");
  assert.equal(byId.get("task:46")?.planCode, "UI01", "任务节点继承所属特性的计划码（显示层）");
  assert.equal(byId.get("task:47")?.planCode, "UI01", "嵌套子任务同样继承计划码");
  assert.equal(byId.get("task:21")?.planCode, null, "spec 任务无计划码");
  assert.equal(byId.get("task:47")?.section, null, "未分节子任务 section = null");
});

test("视图模型：非法 planCode 形态不映射（不猜显示码）", () => {
  const raw = JSON.parse(JSON.stringify(BOARD));
  raw.features[0].planCode = "ui01";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.equal(outcome.board.features[0]?.planCode, null, "小写码非法 → null");
});
