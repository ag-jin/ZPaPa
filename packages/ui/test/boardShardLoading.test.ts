import assert from "node:assert/strict";
import test from "node:test";
import { parseBoardIndex, isBoardIndexShape } from "../src/board/boardIndexViewModel.js";
import {
  applyBoardCardDetails,
  BoardCardDetailCache,
  findBoardTaskByNo,
  loadBoardCardDetail,
  parseCardShard,
} from "../src/board/boardCardDetail.js";
import {
  loadBoardDocument,
  resolveBoardIndexPath,
  resolveBoardJsonPath,
} from "../src/board/loadBoardDocument.js";
import { buildBoardGuideSummary } from "../src/board/boardGuideViewModel.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * #219/D6 索引 + 分片读取的读取缝断言（卡文交付面①索引+分片读取、②缓存失效）。
 *
 * 期望值独立真源：`.zcode/board/board-consumption-contract.md` §15（v3 薄索引面读取契约）与
 * 编译器分片形态（`~/.zcode/skills/zcode-board/assets/compile-board.mjs` 的 `renderCardShard`）。
 * 双形态硬约束：分片卡（cardFile 指针）按指针读分片；扁平卡（cardFile=null）回落旧面 board.json 内联。
 */

const WORKSPACE = "/workspace/ZCode";
const INDEX_PATH = resolveBoardIndexPath(WORKSPACE);
const BOARD_PATH = resolveBoardJsonPath(WORKSPACE);
const SHARD_PATH = `${WORKSPACE}/.zcode/etask/cards/702.md`;

type FakeFile = { content: string; truncated?: boolean };

function createFakeFileService(files: Record<string, FakeFile>) {
  let readCount = 0;
  const reads: string[] = [];
  return {
    readCount: () => readCount,
    reads: () => reads,
    checkFilesExist: async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({
        path,
        exists: Object.prototype.hasOwnProperty.call(files, path),
      })),
    readTextFile: async ({ path }: { path: string }) => {
      readCount += 1;
      reads.push(path);
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
        truncated: file.truncated === true,
        isBinary: false,
      };
    },
  };
}

/** v3 薄索引夹具：一张分片卡（cardFile 指针）+ 一张扁平卡（cardFile=null）+ screen/frontier。 */
const INDEX_FIXTURE = {
  version: 3,
  generatedBy: "zcode-board/0.5.0",
  updatedAt: "2026-10-12T03:02:35+08:00",
  project: { root: WORKSPACE, name: "ZCode" },
  screen: { attention: 17, blocked: 29, running: 1, review: 2, recent: 10 },
  frontier: [
    {
      rank: 1,
      no: 702,
      title: "分片卡",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 2,
      no: 703,
      title: "扁平卡",
      stage: "执行中",
      nextAssignee: "implementer",
      resolvedDeps: [84],
    },
  ],
  features: [
    {
      no: 193,
      label: "193",
      kind: "plan",
      planCode: "FLOW",
      title: "W2 规格",
      status: "pending",
      stage: "待办",
      tasks: [
        {
          no: 702,
          label: "1",
          title: "分片卡",
          status: "pending",
          stage: "待办",
          blockedBy: [84],
          cardFile: ".zcode/etask/cards/702.md",
        },
        {
          no: 703,
          label: "2",
          title: "扁平卡",
          status: "active",
          stage: "执行中",
          blockedBy: [],
          cardFile: null,
        },
      ],
    },
  ],
};

const SHARD_TEXT = [
  "# 702 · 分片卡",
  "",
  "<!-- 机械产出（zcode-board 编译器，#217/D4）：卡文段随计划稿重编译覆盖；执行摘要段保留。 -->",
  "",
  "## 卡文",
  "",
  "- 目标: 让分片卡文按需读",
  "- 交付面全量枚举:",
  "  - 分片解析",
  "  - 缓存失效",
  "- 验收: 分片卡文可见",
  "",
  "## 执行摘要",
  "",
  "<!-- 待收口回写（run 链；#220/D7）。 -->",
  "",
].join("\n");

/* ---------------- 索引解析（N1 结构校验 + 版本门禁） ---------------- */

test("parseBoardIndex：v3 索引 → ready，映射清单/指针/首屏派生", () => {
  const outcome = parseBoardIndex(JSON.stringify(INDEX_FIXTURE));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const board = outcome.board;
  assert.equal(board.projectName, "ZCode");
  assert.equal(board.projectRoot, WORKSPACE);
  assert.equal(board.features.length, 1);
  assert.deepEqual(board.screen, { attention: 17, blocked: 29, running: 1, review: 2, recent: 10 });
  assert.equal(board.frontier?.length, 2);
  assert.equal(board.frontier?.[1]?.resolvedDeps[0], 84);
  // 旧面派生段在索引面恒 null（索引不携带 active/blocked/recent）。
  assert.equal(board.derivedIndex, null);
  assert.equal(board.dispatchIndex, null);

  const feature = board.features[0];
  assert.ok(feature);
  assert.equal(feature.kind, "plan");
  assert.equal(feature.planCode, "FLOW");
  assert.equal(feature.tasks.length, 2);
  const [sharded, flat] = feature.tasks;
  assert.ok(sharded && flat);
  // 分片指针 + 依赖阻塞（blockedBy → dependency 阻拦项，摘要/证据缺省）。
  assert.equal(sharded.cardFile, ".zcode/etask/cards/702.md");
  assert.deepEqual(sharded.blockers, [
    { kind: "dependency", blockedBy: 84, summary: null, evidence: [] },
  ]);
  assert.equal(sharded.goal, null, "索引不携带卡文：目标缺省（点卡时按 cardFile 读分片）");
  assert.deepEqual(sharded.deliverables, []);
  // 扁平卡：cardFile=null（过渡期内联形态）。
  assert.equal(flat.cardFile, null);
  // 稳定号定位（分片读取的入参来源）。
  assert.equal(findBoardTaskByNo(board, 702)?.title, "分片卡");
});

test("parseBoardIndex：版本门禁（过新/过旧/缺失/非有限）独立成态", () => {
  const newer = parseBoardIndex(JSON.stringify({ ...INDEX_FIXTURE, version: 4 }));
  assert.equal(newer.kind, "version-newer");
  if (newer.kind === "version-newer") assert.equal(newer.version, 4);

  const older = parseBoardIndex(JSON.stringify({ ...INDEX_FIXTURE, version: 2 }));
  assert.equal(older.kind, "version-older");

  assert.equal(parseBoardIndex(JSON.stringify({ features: [] })).kind, "damaged");
  assert.equal(parseBoardIndex('{"version": 1e999, "features": []}').kind, "damaged");
  assert.equal(parseBoardIndex("{ not json").kind, "damaged");
});

test("parseBoardIndex：features 为空数组 → empty；特性形态坏 → damaged（N1 消费面自卫）", () => {
  assert.equal(parseBoardIndex(JSON.stringify({ ...INDEX_FIXTURE, features: [] })).kind, "empty");
  // 特性缺 title（最小身份字段）→ 形状校验拒绝（不把半成品索引当完整板渲染）。
  const badFeature = { ...INDEX_FIXTURE, features: [{ no: 1, kind: "plan" }] };
  assert.equal(parseBoardIndex(JSON.stringify(badFeature)).kind, "damaged");
  // features 非数组 → damaged。
  assert.equal(parseBoardIndex(JSON.stringify({ ...INDEX_FIXTURE, features: {} })).kind, "damaged");
  assert.equal(isBoardIndexShape({ version: 3, features: [] }), true);
  assert.equal(isBoardIndexShape({ version: 3, features: [{ title: "x", tasks: "bad" }] }), false);
});

/* ---------------- loadBoardDocument：INDEX 优先 ---------------- */

test("loadBoardDocument：INDEX 在场即读 INDEX（首屏不再读 board.json），绕开读限", async () => {
  const fileService = createFakeFileService({
    [INDEX_PATH]: { content: JSON.stringify(INDEX_FIXTURE) },
    // board.json 故意是超大/损坏内容：INDEX 路径下不得被读。
    [BOARD_PATH]: { content: "{ not json", truncated: true },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  assert.equal(state.board.screen?.attention, 17);
  assert.deepEqual(fileService.reads(), [INDEX_PATH], "首屏只读 INDEX，不读 board.json");
});

test("loadBoardDocument：INDEX 缺席 → 回落旧面 board.json（双写期兼容，行为不变）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") return;
  // 旧面路径：screen/frontier 为 null（详情内联，走旧面四段派生）。
  assert.equal(state.board.screen, null);
  assert.equal(state.board.frontier, null);
  assert.equal(state.board.features.length, 4);
  assert.deepEqual(fileService.reads(), [BOARD_PATH]);
});

test("loadBoardDocument：INDEX 版本过新 → version-newer，supportedVersion=索引面已知版本", async () => {
  const fileService = createFakeFileService({
    [INDEX_PATH]: { content: JSON.stringify({ ...INDEX_FIXTURE, version: 9 }) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "version-newer");
  if (state.kind !== "version-newer") return;
  assert.equal(state.version, 9);
  assert.equal(state.supportedVersion, 3, "过新提示应带索引面已知版本（不是 board.json 的 2）");
});

test("loadBoardDocument：INDEX 结构损坏 → damaged，不回落旧面（索引在即索引为准）", async () => {
  const fileService = createFakeFileService({
    [INDEX_PATH]: { content: "{ not json" },
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardDocument({ fileService, workspacePath: WORKSPACE });
  assert.equal(state.kind, "damaged");
});

/* ---------------- 卡详情按需读（分片 / 扁平回退） ---------------- */

test("loadBoardCardDetail：分片卡按 cardFile 读分片，解析卡文三字段", async () => {
  const fileService = createFakeFileService({ [SHARD_PATH]: { content: SHARD_TEXT } });
  const state = await loadBoardCardDetail({
    fileService,
    workspacePath: WORKSPACE,
    task: { no: 702, cardFile: ".zcode/etask/cards/702.md" },
  });
  assert.equal(state.kind, "loaded");
  if (state.kind !== "loaded") return;
  assert.equal(state.patch.goal, "让分片卡文按需读");
  assert.deepEqual(state.patch.deliverables, ["分片解析", "缓存失效"]);
  assert.equal(state.patch.acceptance, "分片卡文可见");
  assert.deepEqual(fileService.reads(), [SHARD_PATH]);
});

test("loadBoardCardDetail：分片缺失（ENOENT）→ missing（不误报成读到）", async () => {
  const fileService = createFakeFileService({});
  const state = await loadBoardCardDetail({
    fileService,
    workspacePath: WORKSPACE,
    task: { no: 702, cardFile: ".zcode/etask/cards/702.md" },
  });
  assert.equal(state.kind, "missing");
});

test("loadBoardCardDetail：扁平卡（cardFile=null）回落旧面 board.json 内联，整包详情", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  // 金样卡 8 有 details/blockers/lastRun（旧面内联）。
  const state = await loadBoardCardDetail({
    fileService,
    workspacePath: WORKSPACE,
    task: { no: 8, cardFile: null },
  });
  assert.equal(state.kind, "loaded");
  if (state.kind !== "loaded") return;
  assert.equal(
    state.patch.details,
    "把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。",
  );
  assert.equal(state.patch.lastRun?.result, "partial");
  assert.deepEqual(state.patch.attention, ["interrupted-resume", "unmerged-worktree"]);
  assert.deepEqual(fileService.reads(), [BOARD_PATH]);
});

test("loadBoardCardDetail：扁平回退遇旧面过大（截断）→ unavailable（不误报成没有）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: "x", truncated: true },
  });
  const state = await loadBoardCardDetail({
    fileService,
    workspacePath: WORKSPACE,
    task: { no: 8, cardFile: null },
  });
  assert.equal(state.kind, "unavailable");
});

test("loadBoardCardDetail：未领号扁平卡（no=null）→ missing（无号不可定位旧面）", async () => {
  const fileService = createFakeFileService({
    [BOARD_PATH]: { content: JSON.stringify(GOLDEN_SHAPED_BOARD) },
  });
  const state = await loadBoardCardDetail({
    fileService,
    workspacePath: WORKSPACE,
    task: { no: null, cardFile: null },
  });
  assert.equal(state.kind, "missing");
});

test("parseCardShard：缺「## 卡文」段 → 全缺省（骨架分片不猜）", () => {
  const skeleton = "# 702 · 卡\n\n<!-- note -->\n\n## 执行摘要\n\n<!-- 待收口回写 -->\n";
  assert.deepEqual(parseCardShard(skeleton), { goal: null, deliverables: [], acceptance: null });
});

/* ---------------- 缓存 + 失效 ---------------- */

test("BoardCardDetailCache：同代不清、换代整表失效（同会话内同卡不重复读）", () => {
  const cache = new BoardCardDetailCache();
  assert.equal(cache.begin("ws\u0000t1"), true, "首代 = 换代（清空初值）");
  cache.set(702, { kind: "loaded", patch: { goal: "g" } });
  assert.equal(cache.size, 1);
  assert.equal(cache.begin("ws\u0000t1"), false, "同代不换代、不清空");
  assert.equal(cache.size, 1);
  assert.equal(cache.get(702)?.kind, "loaded");
  assert.equal(cache.begin("ws\u0000t2"), true, "updatedAt 变 → 换代");
  assert.equal(cache.size, 0, "换代即整表失效（旧详情不命中）");
  assert.equal(cache.get(702), undefined);
});

test("applyBoardCardDetails：按稳定号把详情补丁合回视图模型（不命中不动）", () => {
  const board = parseBoardIndex(JSON.stringify(INDEX_FIXTURE));
  assert.equal(board.kind, "ready");
  if (board.kind !== "ready") return;
  const merged = applyBoardCardDetails(
    board.board,
    new Map([[702, { goal: "目标", deliverables: ["A"], acceptance: "验收" }]]),
  );
  const task = findBoardTaskByNo(merged, 702);
  assert.equal(task?.goal, "目标");
  assert.deepEqual(task?.deliverables, ["A"]);
  assert.equal(findBoardTaskByNo(merged, 703)?.goal, null, "未命中卡不动");
  assert.equal(applyBoardCardDetails(board.board, new Map()), board.board, "空补丁返回原对象");
});

test("指引面（薄索引面）：五槽取 screen；在途计数不渲染（null，不拿未知当 0）；前沿队列取 frontier", () => {
  const board = parseBoardIndex(JSON.stringify(INDEX_FIXTURE));
  assert.equal(board.kind, "ready");
  if (board.kind !== "ready") return;
  const summary = buildBoardGuideSummary(board.board);
  assert.equal(summary.indexAvailable, true, "薄索引面有 screen 即视为可用的五槽数据源");
  assert.deepEqual(
    summary.slots.map((slot) => [slot.key, slot.count]),
    [
      ["attention", 17],
      ["blocked", 29],
      ["running", 1],
      ["review", 2],
      ["recent", 10],
    ],
    "五槽计数直取 INDEX screen（不按卡字段自算）",
  );
  const plan = summary.plans[0];
  assert.ok(plan, "应有计划区块");
  assert.equal(
    plan?.activeCount,
    null,
    "active[] 不在索引字段面：在途计数为 null（不渲染，不当 0）",
  );
  assert.equal(plan?.frontierCount, 2, "前沿计数取 INDEX frontier（同形投影）");
  assert.equal(plan?.queue.length, 2, "前沿队列取 INDEX frontier 成员");
});
