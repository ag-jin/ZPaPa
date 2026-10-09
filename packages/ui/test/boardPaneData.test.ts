import assert from "node:assert/strict";
import test from "node:test";
import { loadBoardDocument } from "../src/board/loadBoardDocument.js";
import { BOARD_PATH, GOLDEN_SHAPED_BOARD, WORKSPACE } from "./boardTestFixture.js";

/**
 * 项目看板面板的数据读取缝（卡 #32「UI tracer：只读树形视图面板」）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §0/§1/§2（空态 A/B/C 判据）
 * 与 `~/.zcode/skills/zcode-board/assets/samples/board.golden.json`（字段形态）。
 * 这里只经「读取一个文件 + 按契约映射」的缝断言，不触碰任何真相源解析。
 */

type FakeFile = { content: string };

function createFakeFileService(files: Record<string, FakeFile>) {
  let readCount = 0;
  return {
    readCount: () => readCount,
    checkFilesExist: async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({
        path,
        exists: Object.prototype.hasOwnProperty.call(files, path),
      })),
    readTextFile: async ({ path }: { path: string }) => {
      readCount += 1;
      const file = files[path];
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      }
      return {
        path,
        content: file.content,
        offset: 0,
        bytesRead: file.content.length,
        totalBytes: file.content.length,
        truncated: false,
        isBinary: false,
      };
    },
  };
}

test("board.json 不存在 → 空态 A（missing），且不读取内容", async () => {
  const fileService = createFakeFileService({});
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "missing");
  assert.equal(fileService.readCount(), 0, "板文件缺失时不应再尝试读内容");
});

test("board.json 存在但 JSON 解析失败 → 空态 C（damaged）", async () => {
  const fileService = createFakeFileService({ [BOARD_PATH]: { content: "{ not json" } });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "damaged");
});

test("version 主版本不认识 → 空态 C（damaged），不猜测渲染", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify({ version: 3, project: {}, features: [] }) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "damaged");
});

test("features 为空数组 → 空态 B（empty）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: {
      content: JSON.stringify({
        version: 2,
        project: { root: WORKSPACE, name: "ZCode" },
        updatedAt: "2026-10-09T16:05:00+08:00",
        features: [],
        attentionSummary: {},
        diagnostics: [],
      }),
    },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "empty");
});

test("board.json 读取抛非 ENOENT 错误 → 空态 C（damaged，读不到不静默）", async () => {
  const fileService = {
    checkFilesExist: async () => [{ path: BOARD_PATH, exists: true }],
    readTextFile: async () => {
      throw new Error("EACCES: permission denied");
    },
  };
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "damaged");
});

test("golden 形态 board.json → ready，映射特性树与卡片字段", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const board = state.board;

  assert.equal(board.projectName, "ZCode");
  assert.equal(board.projectRoot, WORKSPACE);
  assert.equal(board.features.length, 4);

  const [spec, plan, draftPlan, interview] = board.features;
  assert.ok(spec && plan && draftPlan && interview);

  // 特性节点（第一层）
  assert.equal(spec.no, 1);
  assert.equal(spec.label, "1");
  assert.equal(spec.kind, "spec");
  assert.equal(spec.title, "预览通道（Preview Channel）");
  assert.equal(spec.status, "active");
  assert.equal(spec.stage, "执行中");
  assert.deepEqual(spec.progress, { totalTasks: 4, completedTasks: 1 });
  assert.deepEqual(spec.attention, []);
  assert.equal(spec.tasks.length, 3);

  // 任务卡：lastRun 三形态 + 缺口码 + blockers 计数 + 未领号 + 草案
  const [card7, card8, card9] = spec.tasks;
  assert.ok(card7 && card8 && card9);
  assert.equal(card7.no, 7);
  assert.equal(card7.label, "1.1");
  assert.equal(card7.blockerCount, 1);
  assert.equal(card7.attention.length, 0);
  assert.deepEqual(card7.lastRun, {
    at: "2026-10-09T14:05:00+08:00",
    role: "code-reviewer",
    result: "done",
    stoppedAt: null,
    next: null,
  });
  assert.equal(card7.activeRun, null);
  assert.equal(card7.worktree, null);

  assert.deepEqual(card8.attention, ["interrupted-resume", "unmerged-worktree"]);
  assert.equal(card8.lastRun?.result, "partial");
  assert.equal(card8.lastRun?.stoppedAt, 8);
  assert.equal(card8.lastRun?.next, "补 updater 单测后重新验证");
  assert.deepEqual(card8.activeRun, { role: "implementer", at: "2026-10-09T14:20:00+08:00" });
  assert.equal(card8.worktree, ".zcode/worktrees/task-8");

  assert.equal(card9.status, "completed");
  assert.deepEqual(card9.attention, []);

  // 未领号特性与其草案卡（no/label 缺省是合法缺省形态，不是空态）
  assert.equal(draftPlan.no, null);
  assert.equal(draftPlan.label, null);
  assert.deepEqual(draftPlan.attention, ["arranged-not-expanded"]);
  assert.equal(draftPlan.progress, null);
  assert.equal(draftPlan.tasks.length, 2);
  const [draftTask1, draftTask2] = draftPlan.tasks;
  assert.ok(draftTask1 && draftTask2);
  assert.equal(draftTask1.no, null);
  assert.equal(draftTask1.label, null);
  assert.equal(draftTask1.draft, true);
  assert.equal(draftTask1.blockerCount, 1);
  assert.equal(draftTask1.lastRun, null);
  assert.equal(draftTask2.blockerCount, 2);

  // interview-only 节点同层渲染
  assert.equal(interview.kind, "interview-only");
  assert.deepEqual(interview.attention, ["interviewed-not-arranged"]);
  assert.equal(interview.tasks.length, 0);

  // 计数与诊断
  assert.deepEqual(board.attentionSummary, {
    interviewedNotArranged: 1,
    arrangedNotExpanded: 2,
    interruptedResume: 1,
    unmergedWorktree: 1,
  });
  assert.equal(board.diagnostics.length, 1);
  assert.equal(board.diagnostics[0]?.path, "docs/plans/plan-payment-split.md");
  assert.ok(board.diagnostics[0]?.message.includes("未领号"));
});

test("stage 缺省（无 stage 字段的旧版板）不阻断渲染，也不猜测段位", async () => {
  const boardWithoutStage = structuredClone(GOLDEN_SHAPED_BOARD);
  for (const feature of boardWithoutStage.features) {
    delete (feature as { stage?: string }).stage;
    for (const task of feature.tasks) {
      delete (task as { stage?: string }).stage;
    }
  }
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(boardWithoutStage) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.equal(state.board.features[0]?.stage, null);
  assert.equal(state.board.features[0]?.tasks[0]?.stage, null);
  assert.equal(state.board.features[0]?.tasks[0]?.title, "预览发布通道（workflow）");
});

test("未知缺口码不进徽章渲染（只有四个固定词汇有逐字文案）", async () => {
  const boardWithUnknownCode = structuredClone(GOLDEN_SHAPED_BOARD);
  const targetTask = boardWithUnknownCode.features[0]?.tasks[1];
  assert.ok(targetTask, "夹具里应有第二张卡");
  (targetTask as { attention: string[] }).attention = ["interrupted-resume", "some-future-code"];
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(boardWithUnknownCode) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.deepEqual(state.board.features[0]?.tasks[1]?.attention, ["interrupted-resume"]);
});
