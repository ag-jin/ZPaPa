import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { BoardGuideView } from "../src/board/BoardGuideView.js";
import {
  BoardCardDetailCache,
  loadBoardCardDetail,
  resolveBoardCardDetailState,
} from "../src/board/boardCardDetail.js";
import { resolveBoardDialogNode } from "../src/board/boardDialogViewModel.js";
import { collectBoardViewNodes } from "../src/board/boardViewsViewModel.js";
import { parseBoardIndex } from "../src/board/boardIndexViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD, WORKSPACE } from "./boardTestFixture.js";

/**
 * #220/D7 UI 批真渲染守卫（弹窗详情读取态 + 指引面在途未知形）。
 *
 * 期望值独立真源：契约 §15.5（字段面缺口登记——执行详情归分片承载）+ D6 第四绿 ui-review
 * （major①：详情 unavailable 复用「板上未携带」确定性空态；minor①：在途省略与「—」形态不一致）。
 *
 * #220 回炉微修（2026-10-12，三绿 review Spec-1）：补**宿主判据**覆盖——新增的 unavailable/
 * missing 渲染用例此前直接构造 `detailState` 绕过宿主判据；这里的用例经
 * `resolveBoardCardDetailState`（判据纯函数单点）+ 真实数据层结论（`loadBoardCardDetail`）
 * 到达呈现，并覆盖真实板当前形态（薄索引面 + 扁平卡 `cardFile=null`）与旧面载入面。
 */

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: element,
    }),
  );
}

function goldenBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("金样夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function taskNode(board: BoardViewModel, no: number) {
  const node = collectBoardViewNodes(board).find(
    (entry) => entry.no === no && entry.kind === "task",
  );
  if (!node) throw new Error(`找不到任务卡 #${no}`);
  return node;
}

test("BoardCardDialog：unavailable 详情 → 专属「暂不可读」呈现 + 重试入口（不复用「板上未携带」）", () => {
  const board = goldenBoard();
  const node = taskNode(board, 8);
  const markup = render(
    createElement(BoardCardDialog, {
      board,
      node,
      detailState: "unavailable",
      onRetryDetail: () => {},
    }),
  );
  assert.ok(markup.includes('data-board-dialog-detail="unavailable"'), "有 unavailable 锚点");
  assert.ok(markup.includes("详情暂不可读"), "有「暂不可读」文案（不可读 ≠ 板上没有）");
  assert.ok(markup.includes("data-board-dialog-detail-retry"), "有刷新重试入口（同代重试）");
  assert.ok(!markup.includes("板上未携带"), "不复用 #183「板上未携带」确定性空态");
});

test("BoardCardDialog：missing 详情 → 专属「未找到」呈现，无重试", () => {
  const board = goldenBoard();
  const node = taskNode(board, 8);
  const markup = render(createElement(BoardCardDialog, { board, node, detailState: "missing" }));
  assert.ok(markup.includes('data-board-dialog-detail="missing"'), "有 missing 锚点");
  assert.ok(markup.includes("未在板上或分片中找到"), "有「未找到」文案");
  assert.ok(!markup.includes("data-board-dialog-detail-retry"), "missing 无重试入口（确定没有）");
  assert.ok(!markup.includes("板上未携带"), "不复用「板上未携带」");
});

test("BoardCardDialog：无详情读取态（旧面内联/已加载）→ 现形态（卡片内容区在位）", () => {
  const board = goldenBoard();
  const node = taskNode(board, 8);
  const markup = render(createElement(BoardCardDialog, { board, node }));
  assert.ok(markup.includes("data-board-dialog-card-text"), "卡片内容区在位");
  assert.ok(!markup.includes("data-board-dialog-detail="), "无详情读取态提示（现形态不变）");
});

/** 薄索引面夹具（screen 非 null → 指引面走 screen 投影；active[] 不在索引字段面）。 */
const THIN_INDEX = {
  version: 3,
  generatedBy: "zcode-board/0.5.0",
  updatedAt: "2026-10-12T03:02:35+08:00",
  project: { root: "/workspace/ZCode", name: "ZCode" },
  screen: { attention: 0, blocked: 0, running: 0, review: 0, recent: 0 },
  frontier: [
    {
      rank: 1,
      no: 901,
      title: "前沿卡",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
  ],
  features: [
    {
      no: 900,
      label: "900",
      kind: "plan",
      planCode: "D7",
      title: "流水化计划稿",
      status: "active",
      stage: "执行中",
      tasks: [
        {
          no: 901,
          label: "1",
          title: "前沿卡",
          status: "pending",
          stage: "待办",
          blockedBy: [],
          cardFile: ".zcode/d7/cards/901.md",
        },
      ],
    },
  ],
};

test("BoardGuideView：薄索引面计划摘要 → 在途显式未知形「在途 —」（minor① 形态统一，不静默省略）", () => {
  const outcome = parseBoardIndex(JSON.stringify(THIN_INDEX));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const markup = render(createElement(BoardGuideView, { board: outcome.board }));
  assert.ok(markup.includes("在途 —"), "在途未知形显式渲染（与五槽「—」同一语言；不拿未知当 0）");
  assert.ok(markup.includes("前沿 1"), "前沿计数照常给数（同面既有形态不受影响）");
});

/**
 * 真实板当前形态夹具（2026-10-12 实测：157 卡全扁平、无 `cards/` 分片）：
 * 薄索引面（`screen` 五槽在场）+ 卡无 `cardFile` 指针（扁平卡）→ 详情经旧面回落读。
 * `screen` 计数取自真实板 INDEX.json（独立真源）。
 */
const FLAT_REAL_INDEX = {
  version: 3,
  generatedBy: "zcode-board/0.5.0",
  updatedAt: "2026-10-12T05:50:16+08:00",
  project: { root: "/workspace/ZCode", name: "ZCode" },
  screen: { attention: 18, blocked: 28, running: 0, review: 1, recent: 10 },
  frontier: [],
  features: [
    {
      no: 900,
      label: "900",
      kind: "plan",
      planCode: "D7",
      title: "流水化计划稿",
      status: "active",
      stage: "执行中",
      tasks: [
        {
          no: 902,
          label: "1",
          title: "扁平卡（详情回落旧面）",
          status: "pending",
          stage: "待办",
          blockedBy: [],
        },
      ],
    },
  ],
};

/** 读取层假件：旧面回落读被硬上限截断（真实板 board.json 超 256 KiB 的同款结论 → unavailable）。 */
const TRUNCATED_BOARD_READ = {
  async checkFilesExist({ paths }: { paths: string[] }) {
    return paths.map((path) => ({ path, exists: true }));
  },
  async readTextFile({ path, length = 128 * 1024 }: { path: string; length?: number }) {
    // 扁平卡详情必须回落读旧面 board.json（不扫目录、不骗一个「不存在」）。
    assert.ok(path.endsWith("/.zcode/board/board.json"), `扁平卡回落读旧面：${path}`);
    // 与真实板同形：文件超服务读限，返回截断片（调用方据此判 unavailable，不解析前缀）。
    return {
      path,
      content: '{"version":2,"features":[]}',
      offset: 0,
      bytesRead: length,
      totalBytes: length + 1,
      truncated: true,
      isBinary: false,
    };
  },
};

test("宿主判据（扁平卡路径）：真实板形态（薄索引 + 扁平卡）经数据层到「暂不可读」呈现 + 重试", async () => {
  const outcome = parseBoardIndex(JSON.stringify(FLAT_REAL_INDEX));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const board = outcome.board;
  const node = resolveBoardDialogNode(board, "task:902");
  assert.ok(node && node.kind === "task" && node.no === 902, "能定位扁平卡节点");
  // 数据层真实结论：扁平卡回落旧面 → 截断 → unavailable（非手工构造态）。
  const detail = await loadBoardCardDetail({
    fileService: TRUNCATED_BOARD_READ,
    workspacePath: WORKSPACE,
    task: { no: 902, cardFile: null },
  });
  assert.equal(detail.kind, "unavailable", "截断读 → 暂不可读（不误报 missing）");
  const cache = new BoardCardDetailCache();
  cache.begin(`${WORKSPACE}\u0000${board.updatedAt ?? ""}`);
  cache.set(902, detail);
  // 宿主判据（#220 微修单点）：同一份缓存结论 → 呈现态。
  const detailState = resolveBoardCardDetailState({
    no: 902,
    cache,
    pendingDetailNos: new Set<number>(),
  });
  assert.equal(detailState, "unavailable", "判据取到读取态（不经 detailState 直填）");
  const markup = render(
    createElement(BoardCardDialog, {
      board,
      node,
      detailState,
      onRetryDetail: () => {},
    }),
  );
  assert.ok(markup.includes("详情暂不可读"), "扁平卡不可读 → 显式「暂不可读」文案");
  assert.ok(markup.includes("data-board-dialog-detail-retry"), "给刷新重试入口（同代重读）");
  assert.ok(!markup.includes("板上未携带"), "不复用 #183「板上未携带」确定性空态");
});

test("宿主判据：板载入面不限定——旧面（screen null）扁平卡 + 已落 unavailable 仍取态", () => {
  const board = goldenBoard();
  assert.equal(board.screen, null, "夹具为旧面（board.json；screen 恒 null）");
  const cache = new BoardCardDetailCache();
  cache.begin("旧面代际");
  cache.set(8, { kind: "unavailable" });
  // 读取态只取「这张卡」的读取结论，不得再按板载入面（screen）限定——真实板扁平卡与分片卡同口径。
  assert.equal(
    resolveBoardCardDetailState({ no: 8, cache, pendingDetailNos: new Set<number>() }),
    "unavailable",
    "旧面载入不豁免读取态呈现",
  );
});

test("宿主判据：missing 取态；loaded/无缓存无在途 → 现形态（null）；重试在途保留「暂不可读」", () => {
  const cache = new BoardCardDetailCache();
  cache.begin("判据代际");
  cache.set(7, { kind: "missing" });
  cache.set(8, { kind: "loaded", patch: { goal: "已读到" } });
  assert.equal(
    resolveBoardCardDetailState({ no: 7, cache, pendingDetailNos: new Set<number>() }),
    "missing",
  );
  assert.equal(
    resolveBoardCardDetailState({ no: 8, cache, pendingDetailNos: new Set<number>() }),
    null,
    "loaded → 弹窗按现形态渲染（不给读取态提示）",
  );
  assert.equal(
    resolveBoardCardDetailState({ no: 9, cache, pendingDetailNos: new Set<number>() }),
    null,
    "无缓存、无在途 → 现形态（不拿「未读」当「不可读」）",
  );
  assert.equal(
    resolveBoardCardDetailState({ no: 9, cache, pendingDetailNos: new Set<number>([9]) }),
    "unavailable",
    "同代重试在途 → 保留「暂不可读」（不闪回假空态）",
  );
});

/**
 * #221/D8 归并（#220 四绿 ui-review minor-1）：首开读取在途窗口。
 * 期望值独立真源：#220 第四绿报告 §1.3（首开按需读 effect 发起期间缓存无项 → 现判据 null →
 * 弹窗落 #183「板上未携带」假空态，读结论落地后才翻面；需独立「读取中」诚实形态，
 * 不映射 unavailable——首开在途未必失败，映射不可读会高估失败）。
 */
test("宿主判据：首开在途（缓存无 + 本卡需按需读→expectsRead）→ 独立 reading（不映射 unavailable、不落假空态）", () => {
  const cache = new BoardCardDetailCache();
  cache.begin("首开代际");
  assert.equal(
    resolveBoardCardDetailState({
      no: 9,
      cache,
      pendingDetailNos: new Set<number>(),
      expectsRead: true,
    }),
    "reading",
    "首开在途 → 读取中（诚实占位，不给确定性断言）",
  );
  assert.equal(
    resolveBoardCardDetailState({
      no: 9,
      cache,
      pendingDetailNos: new Set<number>([9]),
      expectsRead: true,
    }),
    "unavailable",
    "同代重试在途优先保留「暂不可读」（既有语义不回归）",
  );
  assert.equal(
    resolveBoardCardDetailState({
      no: 9,
      cache,
      pendingDetailNos: new Set<number>(),
      expectsRead: false,
    }),
    null,
    "旧面内联（详情已载入、不发起按需读）→ 现形态（不给读取态）",
  );
});

test("BoardCardDialog：reading 详情 → 独立「读取中」呈现（无重试入口、非「板上未携带」）", () => {
  const board = goldenBoard();
  const node = taskNode(board, 8);
  const markup = render(
    createElement(BoardCardDialog, {
      board,
      node,
      detailState: "reading",
      onRetryDetail: () => {},
    }),
  );
  assert.ok(markup.includes('data-board-dialog-detail="reading"'), "有 reading 锚点");
  assert.ok(markup.includes("详情读取中"), "有「读取中」文案（诚实占位）");
  assert.ok(!markup.includes("data-board-dialog-detail-retry"), "读取中无重试入口（尚无失败结论）");
  assert.ok(!markup.includes("板上未携带"), "不落 #183「板上未携带」假空态");
  assert.ok(!markup.includes("详情暂不可读"), "不映射 unavailable（首开在途未必失败）");
});

test("宿主判据（首开路径，真实板形态）：薄索引 + 扁平卡首开窗口 → reading → 读结论落地 → 现形态", () => {
  const outcome = parseBoardIndex(JSON.stringify(FLAT_REAL_INDEX));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const board = outcome.board;
  // 宿主判据输入（与 BoardPane 同口径）：薄索引面（screen 非 null）+ 缓存未命中 → 本卡需按需读。
  const expectsRead = board.screen !== null;
  assert.equal(expectsRead, true, "薄索引面（真实板形态）");
  const cache = new BoardCardDetailCache();
  cache.begin(`${WORKSPACE}\u0000${board.updatedAt ?? ""}`);
  const node = resolveBoardDialogNode(board, "task:902");
  assert.ok(node && node.kind === "task" && node.no === 902, "能定位扁平卡节点");
  const reading = resolveBoardCardDetailState({
    no: 902,
    cache,
    pendingDetailNos: new Set<number>(),
    expectsRead,
  });
  assert.equal(reading, "reading", "首开窗口 → 读取中（不落假空态）");
  const readingMarkup = render(
    createElement(BoardCardDialog, { board, node, detailState: reading }),
  );
  assert.ok(readingMarkup.includes("详情读取中"), "首开窗口渲染「读取中」");
  assert.ok(!readingMarkup.includes("板上未携带"), "不渲染 #183「板上未携带」");
  // 读结论落地（loaded）→ 现形态（卡片内容区在位；不给读取态提示）。
  cache.set(902, { kind: "loaded", patch: { goal: "分片读到的目标" } });
  const settled = resolveBoardCardDetailState({
    no: 902,
    cache,
    pendingDetailNos: new Set<number>(),
    expectsRead,
  });
  assert.equal(settled, null, "loaded → 现形态");
});
