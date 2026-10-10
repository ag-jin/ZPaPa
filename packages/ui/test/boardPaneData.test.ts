import assert from "node:assert/strict";
import test from "node:test";
import { loadBoardDocument } from "../src/board/loadBoardDocument.js";
import {
  BOARD_PATH,
  GOLDEN_SHAPED_BOARD,
  LARGE_BOARD_TAIL_TITLE,
  WORKSPACE,
  buildLargeBoard,
} from "./boardTestFixture.js";

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
  assert.equal(card7.blockers.length, 1);
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
  assert.equal(draftTask1.blockers.length, 1);
  assert.equal(draftTask1.lastRun, null);
  assert.equal(draftTask2.blockers.length, 2);

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

test("卡片映射 updatedAt 与 statusRule（列内排序与取消原因的字段基础，卡 #33）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;

  const spec = state.board.features[0];
  assert.ok(spec);
  // 特性级 statusRule：段位溯源（契约 §13.1「每节点必带」）。
  assert.equal(spec.statusRule, "progress.stages.design=active");

  const [card7, card8] = spec.tasks;
  assert.ok(card7 && card8);
  // 卡龄排序的数据基础：卡片 updatedAt 必须映射（契约 §3.5）。
  assert.equal(card7.updatedAt, "2026-10-09T14:05:00+08:00");
  assert.equal(card8.updatedAt, "2026-10-09T14:20:00+08:00");
  // 已取消列的取消原因来自任务级 statusRule；缺省不编造。
  assert.equal(card7.statusRule, "tasks.md checkbox unchecked");
  assert.equal(card8.statusRule, null, "缺 statusRule 的卡不得编造溯源");
});

test("计数映射：只认正整数（小数/负数/非数一律 0，不 trunc 编造计数）——评审 S1 的名实统一", async () => {
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as unknown as {
    features: Record<string, unknown>[];
    attentionSummary: Record<string, unknown>;
  };
  raw.attentionSummary = {
    interviewedNotArranged: 2.5,
    arrangedNotExpanded: -1,
    interruptedResume: "3",
    unmergedWorktree: 4,
  };
  const spec = raw.features[0];
  assert.ok(spec);
  spec.progress = { totalTasks: 3.5, completedTasks: 2 };
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(raw) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.deepEqual(
    state.board.attentionSummary,
    {
      interviewedNotArranged: 0,
      arrangedNotExpanded: 0,
      interruptedResume: 0,
      unmergedWorktree: 4,
    },
    "小数计数不得被 trunc 成「看起来像真的」的计数",
  );
  assert.deepEqual(state.board.features[0]?.progress, { totalTasks: 0, completedTasks: 2 });
});

/* ---------------- 连接门禁（评审 #32-P3：暂时不可读 vs 损坏） ---------------- */

test("连接未就绪：不发读取，呈现「暂时不可读」而不是「损坏」（评审 #32-P3）", async () => {
  let rpcCalls = 0;
  const fileService = {
    checkFilesExist: async () => {
      rpcCalls += 1;
      return [{ path: BOARD_PATH, exists: true }];
    },
    readTextFile: async () => {
      rpcCalls += 1;
      throw new Error("remote workspace disconnected");
    },
  };
  const state = await loadBoardDocument({
    fileService,
    workspacePath: WORKSPACE,
    isRpcReady: () => false,
  });
  assert.equal(state.kind, "unavailable", "断连不是板的错：不给「损坏」空态");
  assert.equal(rpcCalls, 0, "未就绪时一个 RPC 都不发（断连代理的请求都是无效请求）");
});

test("读取途中断连（首探就绪、失败时已未就绪）→ 暂时不可读；连接仍在才判损坏（评审 #32-P3）", async () => {
  let rpcReady = true;
  const flaky = {
    checkFilesExist: async () => [{ path: BOARD_PATH, exists: true }],
    readTextFile: async () => {
      rpcReady = false;
      throw new Error("EACCES: permission denied");
    },
  };
  const interrupted = await loadBoardDocument({
    fileService: flaky,
    workspacePath: WORKSPACE,
    isRpcReady: () => rpcReady,
  });
  assert.equal(interrupted.kind, "unavailable", "读取途中断连按「暂时不可读」呈现");

  const stillReady = await loadBoardDocument({
    fileService: {
      checkFilesExist: async () => [{ path: BOARD_PATH, exists: true }],
      readTextFile: async () => {
        throw new Error("EACCES: permission denied");
      },
    },
    workspacePath: WORKSPACE,
    isRpcReady: () => true,
  });
  assert.equal(stillReady.kind, "damaged", "连接正常时读失败仍是损坏（既有口径不变）");
});

test("黄金路径不受门禁影响：就绪时照常 ready（同一夹具前后对照）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({
    fileService,
    workspacePath: WORKSPACE,
    isRpcReady: () => true,
  });
  assert.equal(state.kind, "ready");
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

test("有稳定号、无 label 的卡：no 保留、label 为 null、id 按号定位（ID-兜底分支的映射面）", async () => {
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as unknown as {
    features: Array<{ tasks: unknown[] }>;
  };
  const spec = raw.features[0];
  assert.ok(spec, "夹具应有第一个特性");
  spec.tasks.push({
    no: 21,
    title: "只有稳定号的卡",
    status: "pending",
    stage: "待办",
    attention: [],
    blockers: [],
    lastRun: null,
    updatedAt: "2026-10-09T12:00:00+08:00",
  });
  const fileService = createFakeFileService({ [BOARD_PATH]: { content: JSON.stringify(raw) } });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const card = state.board.features[0]?.tasks.at(-1);
  assert.ok(card, "新增的卡应映射出来");
  assert.equal(card.no, 21, "稳定号保留");
  assert.equal(card.label, null, "缺 label 是合法缺省（不是编造 label=no）");
  assert.equal(card.id, "task:21", "渲染定位按稳定号（缺 label 不影响 id）");
});

/* ---------------- 弹窗字段映射（卡 #34，契约 §6） ---------------- */

test("弹窗字段映射：details 全文与空串降级（契约 §6「细节」空串 → 隐藏区块）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const spec = state.board.features[0];
  assert.ok(spec);
  assert.equal(
    spec.details,
    "确认 tag 规则 vX.Y.Z-preview.N 与四项实施任务，产物为 plan-sess_e5545aac。",
    "特性 details 应全文映射（≤200 字符，存储即有界）",
  );
  const [card7, card8] = spec.tasks;
  assert.ok(card7 && card8);
  assert.equal(
    card8.details,
    "把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。",
    "卡片 details 应全文映射",
  );
  assert.equal(card7.details, null, "空串 details 归一为 null（由视图层隐藏区块），不渲染空段落");
  assert.equal(state.board.features[1]?.details, null, "plan 夹具的 details 也是空串");
});

test("弹窗字段映射：blockers 结构化（external 与 dependency 两种，含 blockedBy 缺省）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const spec = state.board.features[0];
  const draftPlan = state.board.features[2];
  assert.ok(spec && draftPlan);
  const card7 = spec.tasks[0];
  assert.ok(card7);
  assert.deepEqual(card7.blockers, [
    {
      kind: "external",
      blockedBy: null,
      summary: "dev 污染 atom feed 待验证（决定方案 (a)/(b)）",
      evidence: ["specs/preview-channel/progress.json"],
    },
  ]);
  const [draftTask1, draftTask2] = draftPlan.tasks;
  assert.ok(draftTask1 && draftTask2);
  assert.equal(draftTask1.blockers[0]?.kind, "dependency");
  assert.equal(draftTask1.blockers[0]?.blockedBy, 9, "dependency 的对方稳定号应映射");
  assert.equal(draftTask2.blockers.length, 2);
  assert.equal(draftTask2.blockers[1]?.kind, "dependency");
  assert.equal(
    draftTask2.blockers[1]?.blockedBy,
    null,
    "blockedBy 缺省（golden 真实形态）不编造目标号",
  );
});

test("弹窗字段映射：origin/evidence/createdAt/pr/assignees（契约 §6 来源、证据路径、时间戳、PR）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  const spec = state.board.features[0];
  assert.ok(spec);
  const [card7, card8, card9] = spec.tasks;
  assert.ok(card7 && card8 && card9);

  assert.deepEqual(card8.origin, {
    type: null,
    interviewId: "itw-20261009-a1b2",
    sessionId: null,
    specRoot: "specs/preview-channel/",
    planRef: null,
  });
  assert.equal(card7.origin?.type, "spec-driven-workflow");
  assert.deepEqual(spec.origin, {
    type: "spec-driven-workflow",
    interviewId: null,
    sessionId: null,
    specRoot: "specs/preview-channel/",
    planRef: null,
  });
  assert.deepEqual(card8.evidence, [
    "specs/preview-channel/progress.json",
    "ZPaPa/packages/desktop/src/updateStatusModel.ts",
  ]);
  assert.deepEqual(card9.evidence, [], "空 evidence 不编造指针");
  assert.equal(card8.createdAt, "2026-10-08T10:00:00+08:00");
  assert.equal(card7.createdAt, "2026-10-08T10:00:00+08:00");
  assert.deepEqual(card9.pr, { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" });
  assert.equal(card8.pr, null, "pr 缺省 → null（视图层隐藏区块）");
  assert.deepEqual(card8.assignees, [
    "implementer",
    "test-verifier",
    "code-reviewer",
    "integrator",
  ]);
  assert.deepEqual(spec.assignees, [], "特性节点没有 assignees 字段：不借子树的值");
  assert.equal(card9.origin, null, "缺 origin 的卡不编造来源");
  assert.equal(spec.statusRule, "progress.stages.design=active");
});

/* ---------------- P1 回归（第三绿 changes_required）：读取上限 ---------------- */

/**
 * 忠实假件：逐条复刻 `packages/services/src/file/fileService.ts:32-33,55-60,477-521` 的
 * readTextFile 语义 —— `length` 缺省 128 KiB、服务端收敛到 256 KiB 硬上限、超出部分以
 * `truncated` 如实回报。上面的 createFakeFileService 不看 length、整读返回，因此看不见
 * 「调用方未传 length」这类缺陷；本组回归必须用会截断的假件。
 */
const SERVICE_DEFAULT_TEXT_READ_BYTES = 128 * 1024;
const SERVICE_MAX_TEXT_READ_BYTES = 256 * 1024;

function createClampingFakeFileService(files: Record<string, FakeFile>) {
  return {
    checkFilesExist: async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({
        path,
        exists: Object.prototype.hasOwnProperty.call(files, path),
      })),
    readTextFile: async ({
      path,
      offset = 0,
      length,
    }: {
      path: string;
      offset?: number;
      length?: number;
    }) => {
      const file = files[path];
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      }
      const bytes = Buffer.from(file.content, "utf8");
      const start = Math.max(0, Math.trunc(offset));
      const requested = Number.isFinite(length)
        ? Math.trunc(length as number)
        : SERVICE_DEFAULT_TEXT_READ_BYTES;
      const target = Math.min(Math.max(requested, 1), SERVICE_MAX_TEXT_READ_BYTES);
      const readLength = Math.min(target, Math.max(0, bytes.length - start));
      const chunk = bytes.subarray(start, start + readLength);
      return {
        path,
        content: chunk.toString("utf8"),
        offset: start,
        bytesRead: chunk.length,
        totalBytes: bytes.length,
        truncated: start + chunk.length < bytes.length,
        isBinary: false,
      };
    },
  };
}

test("P1 回归：≥128 KiB 的合法板必须读全，不因服务默认读取上限误判空态 C", async () => {
  const board = buildLargeBoard({ minBytes: SERVICE_DEFAULT_TEXT_READ_BYTES });
  assert.ok(
    board.bytes > SERVICE_DEFAULT_TEXT_READ_BYTES,
    `夹具前提：板应超过服务默认上限（实测 ${board.bytes} B）`,
  );
  assert.ok(
    board.bytes <= SERVICE_MAX_TEXT_READ_BYTES,
    `夹具前提：板应落在服务硬上限内（实测 ${board.bytes} B）`,
  );
  assert.ok(
    board.tailByteOffset > SERVICE_DEFAULT_TEXT_READ_BYTES,
    `夹具前提：尾哨兵应在默认上限之后（实测偏移 ${board.tailByteOffset} B）`,
  );

  const fileService = createClampingFakeFileService({ [BOARD_PATH]: { content: board.content } });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });

  assert.equal(
    state.kind,
    "ready",
    "合法且可读全的板必须是 ready（空态 C 只留给读不到/读不全/版本不认识）",
  );
  if (state.kind !== "ready") return;
  assert.equal(state.board.features.length, board.featureCount);
  assert.equal(
    state.board.features.at(-1)?.title,
    LARGE_BOARD_TAIL_TITLE,
    "尾哨兵在 128 KiB 之后：它出现即证明读全，而不是拿截断前缀当完整的板",
  );
});

test("P1 残余限制：读取被 256 KiB 硬上限截断 → 空态 C，不部分渲染", async () => {
  // 情形 1：板本身超过硬上限（截断点落在 JSON 正文中间）——前缀不可解析。
  const oversized = buildLargeBoard({ minBytes: SERVICE_MAX_TEXT_READ_BYTES + 16 * 1024 });
  assert.ok(
    oversized.bytes > SERVICE_MAX_TEXT_READ_BYTES,
    `夹具前提：板应超过服务硬上限（实测 ${oversized.bytes} B）`,
  );
  assert.throws(
    () =>
      JSON.parse(
        Buffer.from(oversized.content, "utf8")
          .subarray(0, SERVICE_MAX_TEXT_READ_BYTES)
          .toString("utf8"),
      ),
    "夹具前提：硬上限处的前缀应不是合法 JSON（截断落在正文中间）",
  );
  const oversizedState = await loadBoardDocument({
    fileService: createClampingFakeFileService({ [BOARD_PATH]: { content: oversized.content } }),
    workspacePath: WORKSPACE,
  });
  assert.equal(oversizedState.kind, "damaged", "超硬上限的板读不全，按空态 C 呈现");

  // 情形 2：硬上限处的前缀恰好是一份完整合法 JSON（余下是空白填充）——不显式看 truncated
  // 就会把这个前缀当成 ready 渲染，等于把「没读全的板」静默当完整板展示（漏节点不报警）。
  const paddedContent = `${JSON.stringify(GOLDEN_SHAPED_BOARD)}${" ".repeat(SERVICE_MAX_TEXT_READ_BYTES)}`;
  const paddedBytes = Buffer.from(paddedContent, "utf8");
  assert.ok(
    paddedBytes.length > SERVICE_MAX_TEXT_READ_BYTES,
    `夹具前提：文本应超过服务硬上限（实测 ${paddedBytes.length} B）`,
  );
  assert.doesNotThrow(
    () => JSON.parse(paddedBytes.subarray(0, SERVICE_MAX_TEXT_READ_BYTES).toString("utf8")),
    "夹具前提：硬上限处的前缀应是合法 JSON（本条红的判据）",
  );
  const paddedState = await loadBoardDocument({
    fileService: createClampingFakeFileService({ [BOARD_PATH]: { content: paddedContent } }),
    workspacePath: WORKSPACE,
  });

  // 残余限制（如实留痕，不发明词条）：>256 KiB 的板不在本期契约 §2 的三空态词条内，
  // 这里借空态 C 兜底；测试把结果钉住，供后续「板过大」词条立项时替换。
  assert.equal(
    paddedState.kind,
    "damaged",
    "读取被截断就不允许按部分内容渲染（哪怕前缀恰好能解析）",
  );
});
