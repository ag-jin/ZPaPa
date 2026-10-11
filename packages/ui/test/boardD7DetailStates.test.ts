import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { BoardGuideView } from "../src/board/BoardGuideView.js";
import { collectBoardViewNodes } from "../src/board/boardViewsViewModel.js";
import { parseBoardIndex } from "../src/board/boardIndexViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * #220/D7 UI 批真渲染守卫（弹窗详情读取态 + 指引面在途未知形）。
 *
 * 期望值独立真源：契约 §15.5（字段面缺口登记——执行详情归分片承载）+ D6 第四绿 ui-review
 * （major①：详情 unavailable 复用「板上未携带」确定性空态；minor①：在途省略与「—」形态不一致）。
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
