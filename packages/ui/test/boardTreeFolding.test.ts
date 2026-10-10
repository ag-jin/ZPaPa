import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

/**
 * 树形视图折叠与章节子分组的真渲染守卫（卡 #46 / 规则书 v2：B2 + B1 短编号）。
 *
 * 期望值的独立真源：用户 2026-10-10 实测反馈（卡文 B2 逐条）：
 *   - 特性节点 = 可折叠大块（边框/背景，视觉独立于子卡）；
 *   - 有 attention 缺口的特性默认展开；completed 特性默认折叠；折叠态显示 `[N 张卡]` 摘要；
 *   - 计划稿章节（section）作为子分组渲染；
 *   - 同一计划分组内任务编号省略计划码前缀（只显示 1.2）。
 */

const PLAN_FEATURE = {
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
  attention: ["interrupted-resume"],
  tasks: [
    {
      no: 46,
      label: "5",
      title: "章节前条目",
      details: "",
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
    },
    {
      no: 47,
      label: "6",
      title: "UI 期条目",
      details: "",
      section: "UI 期",
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
      tasks: [
        {
          no: 48,
          label: "6.1",
          title: "嵌套子卡",
          details: "",
          section: "UI 期",
          status: "pending",
          statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
          stage: "待办",
          stageRule: "status=pending 且无 activeRun",
          source: { file: ".zcode/plans/plan-zcode-ui.md", selector: "item-7" },
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
    {
      no: 49,
      label: "7",
      title: "梦章节条目",
      details: "",
      section: "梦",
      status: "pending",
      statusRule: "plan 条目未勾选（draft：真相在 plan 文件本身）",
      stage: "待办",
      stageRule: "status=pending 且无 activeRun",
      source: { file: ".zcode/plans/plan-zcode-ui.md", selector: "item-8" },
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
};

const COMPLETED_FEATURE = {
  id: "plan:plan-done",
  no: 60,
  label: "60",
  planCode: "DONE",
  kind: "plan",
  title: "已完成计划",
  details: "",
  status: "completed",
  statusRule: "plan 有勾选记录（§4.3 规则 3）",
  stage: "已完成",
  stageRule: "status=completed（勾选=已合并 6.3 / progress 阶段完成）",
  origin: { type: "plan-session", planRef: ".zcode/plans/plan-done.md" },
  progress: null,
  evidence: [".zcode/plans/plan-done.md"],
  updatedAt: "2026-10-10T08:00:00+08:00",
  currentAssignee: null,
  attention: [],
  tasks: [
    {
      no: 61,
      label: "1",
      title: "归档卡",
      details: "",
      status: "completed",
      statusRule: "plan 条目已勾选（draft：真相在 plan 文件本身）",
      stage: "已完成",
      stageRule: "status=completed（勾选=已合并 6.3 / progress 阶段完成）",
      source: { file: ".zcode/plans/plan-done.md", selector: "item-1" },
      origin: { planRef: ".zcode/plans/plan-done.md" },
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
      createdAt: "2026-10-10T08:00:00+08:00",
      updatedAt: "2026-10-10T08:00:00+08:00",
    },
  ],
};

const BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "ZCode" },
  updatedAt: "2026-10-10T10:00:00+08:00",
  generatedBy: "zcode-board/0.2",
  features: [PLAN_FEATURE, COMPLETED_FEATURE],
  attentionSummary: {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 0,
  },
  diagnostics: [],
};

function renderTree(): string {
  const outcome = parseBoardJson(JSON.stringify(BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const state: BoardPaneLoadState = { kind: "ready", board: outcome.board };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state, viewMode: "tree" }),
    }),
  );
}

/** 特性块切片：从 `data-board-feature-block="<id>"` 所在的 `<details>` 开始到下一个块（渲染序）。 */
function blockSlice(markup: string, featureId: string, nextFeatureId: string | null): string {
  const anchor = markup.indexOf(`data-board-feature-block="${featureId}"`);
  assert.ok(anchor >= 0, `特性块 ${featureId} 应存在：\n${markup.slice(0, 500)}`);
  const start = markup.lastIndexOf("<details", anchor);
  assert.ok(start >= 0 && start < anchor, `特性块 ${featureId} 应是 <details> 大块`);
  const nextAnchor =
    nextFeatureId === null
      ? -1
      : markup.indexOf(`data-board-feature-block="${nextFeatureId}"`, anchor);
  const end = nextFeatureId === null ? markup.length : markup.lastIndexOf("<details", nextAnchor);
  assert.ok(end > anchor, `下一个特性块应在 ${featureId} 之后`);
  return markup.slice(start, end);
}

test("树形：特性节点是可折叠大块（含 open 属性判据与摘要计数）", () => {
  const markup = renderTree();
  const withGap = blockSlice(markup, "plan:plan-zcode-ui", "plan:plan-done");
  assert.ok(
    /^<details[^>]*open/.test(withGap.slice(withGap.indexOf("<details"))),
    "有 attention 缺口的特性默认展开（details open）",
  );
  assert.match(withGap, /data-board-feature-block-summary="plan:plan-zcode-ui"/, "折叠块摘要锚点");
  assert.match(
    withGap,
    /data-board-feature-card-count="4"/,
    "摘要显示卡片数（含嵌套子卡：46/47/48/49）",
  );
  assert.match(withGap, />4 张卡</, "摘要文案 [N 张卡]（逐字）");
  const done = blockSlice(markup, "plan:plan-done", null);
  const detailsTag = done.slice(done.indexOf("<details"), done.indexOf(">"));
  assert.ok(!detailsTag.includes("open"), "completed 特性默认折叠（无 open 属性）");
  assert.match(done, /data-board-feature-card-count="1"/, "折叠态仍显示 [N 张卡] 摘要");
});

test("树形：特性头点击分区与列表一致（#54-4）——编号+名称区=开弹窗，段位/徽章/计数区=折叠", () => {
  const markup = renderTree();
  const withGap = blockSlice(markup, "plan:plan-zcode-ui", "plan:plan-done");
  const summaryStart = withGap.indexOf('data-board-feature-block-summary="plan:plan-zcode-ui"');
  assert.ok(summaryStart >= 0, "特性块摘要应存在");
  const summary = withGap.slice(summaryStart, withGap.indexOf("</summary>", summaryStart));
  const openStart = summary.indexOf('data-board-card="plan:plan-zcode-ui"');
  assert.ok(openStart >= 0, "开弹窗落点锚点应仍在");
  const titleAt = summary.indexOf("ZCode 看板 UI", openStart);
  assert.ok(titleAt > openStart, "落点里应有名称");
  const openRegion = summary.slice(openStart, summary.indexOf("</div>", titleAt));
  assert.ok(openRegion.includes("data-board-node-id"), "落点含编号");
  assert.ok(
    !openRegion.includes("data-board-stage="),
    "段位徽章在落点外（点它 = summary 默认动作，折叠）",
  );
  assert.ok(!openRegion.includes("data-board-badges"), "角标簇在落点外");
  assert.ok(!openRegion.includes("data-board-feature-card-count"), "计数在落点外");
  const outside = summary.slice(summary.indexOf("</div>", titleAt));
  assert.ok(outside.includes("data-board-stage="), "段位徽章留在 summary 内");
  assert.ok(outside.includes("data-board-feature-card-count"), "计数留在 summary 内");
});

test("树形：同计划分组内任务编号省略计划码前缀（只显示层级），完整形态可回溯", () => {
  const markup = renderTree();
  const withGap = blockSlice(markup, "plan:plan-zcode-ui", "plan:plan-done");
  assert.match(withGap, /data-board-node-id="5"/, "计划内顶层任务只显示层级（5）");
  assert.match(withGap, /data-board-node-id="6\.1"/, "嵌套子任务短形态（6.1）");
  assert.match(withGap, /data-board-feature-code="UI01"/, "特性块头显示计划码（完整形态的锚点）");
  const done = blockSlice(markup, "plan:plan-done", null);
  assert.match(done, /data-board-node-id="1"/, "已完成特性内同样省略前缀");
});

test("树形：计划稿章节作为子分组（含章节前条目的无头分组）", () => {
  const markup = renderTree();
  const withGap = blockSlice(markup, "plan:plan-zcode-ui", "plan:plan-done");
  const sectionOrder = [...withGap.matchAll(/data-board-section="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sectionOrder, ["UI 期", "梦"], "章节子分组按文档序渲染（UI 期 → 梦）");
  const plain = withGap.indexOf('data-board-node-id="5"');
  const firstSection = withGap.indexOf('data-board-section="UI 期"');
  assert.ok(plain >= 0 && plain < firstSection, "章节前条目渲染在首个章节分组之前");
  const uiGroup = withGap.slice(firstSection, withGap.indexOf('data-board-section="梦"'));
  assert.match(uiGroup, /data-board-node-id="6"/, "UI 期分组含其条目");
  assert.match(uiGroup, /data-board-node-id="6\.1"/, "嵌套子卡在章节分组内");
});
