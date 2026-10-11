import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { resolveBoardDialogNode } from "../src/board/boardDialogViewModel.js";
import { BoardGuideView } from "../src/board/BoardGuideView.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GUIDE_BOARD, GUIDE_NOW } from "./boardGuideFixture.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 派发入口的渲染断言（卡 #186）：卡片弹窗内主入口 + 指引面队列行尾次入口。
 *
 * 期望值的独立真源：卡文「卡片弹窗/队列行增加「派发此卡」操作」+ 用户原话
 * 「直接引用卡片让会话去安排」+ 视觉准入（入口不打扰抽查动线：按钮位置不与关闭/跳转竞争）+
 * 板只读契约（未领稳定号 → 禁发，不猜号）+ #142 词条纪律（两语键集一致，走词条不硬编码）。
 */

function goldenBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function guideBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(GUIDE_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function render(node: ReturnType<typeof createElement>, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale, children: node }),
  );
}

/**
 * 从 SSR 标记里取出按钮元素的完整标记（含文案与属性）。
 * 锚点按**属性形态**匹配（`<attribute>="…"`）：改名字段/后缀拼接（`…-renamed`）不得被当成命中。
 */
function buttonMarkup(markup: string, attribute: string): string {
  const match = markup.match(
    new RegExp(`<button[^>]*\\s${attribute}="[^"]*"[^>]*>[\\s\\S]*?</button>`),
  );
  assert.ok(match, `标记里应有按钮锚点 ${attribute}`);
  return match[0];
}

/** 从 SSR 标记里取出 `data-*` 元素的完整开标签（属性形态匹配；属性断言用）。 */
function openTag(markup: string, attribute: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*\\s${attribute}="[^"]*"[^>]*>`));
  assert.ok(match, `标记里应有锚点 ${attribute}`);
  return match[0];
}

/** `data-<anchor>` 按钮元素是否带原生 disabled 属性（class 里的 `disabled:` 变体不算）。 */
function hasDisabledAttribute(buttonElement: string): boolean {
  return /\sdisabled(=""|>|\s)/.test(buttonElement);
}

/** 从开标签起点找同名标签的配对闭合下标（SSR 标记是良构 HTML 片段，够用）。 */
function matchingCloseIndex(markup: string, openTagStart: number, tag: string): number {
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  pattern.lastIndex = openTagStart;
  let depth = 0;
  for (let match = pattern.exec(markup); match; match = pattern.exec(markup)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }
  return -1;
}

test("弹窗主入口：状态行行尾渲染「派发此卡」，夹在关闭位与跳转位之外（视觉准入）", () => {
  const board = goldenBoard();
  const node = resolveBoardDialogNode(board, "task:8");
  assert.ok(node);
  const markup = render(
    createElement(BoardCardDialog, { board, node, onClose: () => {}, onDispatchCard: () => {} }),
  );

  const button = buttonMarkup(markup, "data-board-dialog-dispatch");
  assert.ok(button.includes("派发此卡"), `按钮文案走词条：${button}`);
  assert.ok(!hasDisabledAttribute(button), "有稳定号 → 可派发");
  assert.ok(button.includes('title="#8 让开关立刻生效（核心）"'), "悬停可见将注入的卡引用全文");

  // 位置：落在状态行内、且不在标题行（关闭位）里；跳转按钮在阻碍区（本夹具卡在阻碍区之前）。
  const statusRow = markup.indexOf('data-board-dialog-section="status"');
  const headerRow = markup.indexOf('data-board-dialog-section="header"');
  const dispatchAt = markup.indexOf('data-board-dialog-dispatch="button"');
  const jumpAt = markup.indexOf('data-board-dialog-jump=""');
  assert.ok(dispatchAt > statusRow, "派发按钮在状态行内");
  assert.ok(headerRow < statusRow && statusRow < dispatchAt, "不在标题行（不与 × 关闭竞争）");
  assert.ok(jumpAt === -1 || dispatchAt < jumpAt, "排在阻碍区跳转之前（两者不同区块、互不邻接）");
});

test("弹窗主入口：未领稳定号 → 禁发（不猜号、不给死引用）+ 词条说明", () => {
  const board = goldenBoard();
  // 夹具里的未领号节点（no 缺省）走同一弹窗模型：无稳定号 → 入口禁发。
  const unnumbered = { ...resolveBoardDialogNode(board, "task:8")!, no: null };
  const markup = render(
    createElement(BoardCardDialog, {
      board,
      node: unnumbered,
      onClose: () => {},
      onDispatchCard: () => {},
    }),
  );

  const button = buttonMarkup(markup, "data-board-dialog-dispatch");
  assert.ok(hasDisabledAttribute(button), "未领号 → 按钮禁用");
  assert.ok(
    button.includes("该卡未领稳定号，无法在会话中引用"),
    `禁用原因可核对（title）：${button}`,
  );
  assert.ok(button.includes("派发此卡"), "禁发也保留词条文案（布局层级不塌）");
});

test("弹窗主入口：只读渲染（无宿主回调）不渲染入口（缺省不上可点态）", () => {
  const board = goldenBoard();
  const node = resolveBoardDialogNode(board, "task:8");
  assert.ok(node);
  const markup = render(createElement(BoardCardDialog, { board, node, onClose: () => {} }));
  assert.ok(!markup.includes('data-board-dialog-dispatch="button"'), "没有派发回调就不渲染按钮");
});

test("队列行次入口：行尾按钮与可点区并列（不嵌套进 role=button），且不抢行内信息", () => {
  const markup = render(
    createElement(BoardGuideView, {
      board: guideBoard(),
      now: GUIDE_NOW,
      onOpenCard: () => {},
      onDispatchCard: () => {},
    }),
  );

  const button = buttonMarkup(markup, "data-board-guide-queue-dispatch");
  assert.ok(button.includes("派发此卡"), `队列行按钮文案走词条：${button}`);

  // 结构：行容器 → [可点区（data-board-card + role=button）] [派发按钮]（兄弟，非嵌套）。
  const rowTag = openTag(markup, "data-board-guide-queue-row");
  const clickableStart = markup.search(/<div[^>]*data-board-card="/);
  const clickableTag = openTag(markup, "data-board-card");
  const clickableClose = matchingCloseIndex(markup, clickableStart, "div");
  const dispatchAt = markup.indexOf('data-board-guide-queue-dispatch="button"');
  assert.ok(clickableTag.includes('role="button"'), "可点区仍是 role=button（行下钻语义不变）");
  assert.ok(
    !rowTag.includes('role="button"'),
    "行容器不再自带 role=button（按钮是并列兄弟，不进 ARIA 按钮子树）",
  );
  assert.ok(clickableClose > 0 && dispatchAt > clickableClose, "按钮在可点区之外（兄弟节点）");
  const clickableBlock = markup.slice(clickableStart, clickableClose);
  assert.ok(clickableBlock.includes("data-board-node-id"), "卡号仍在可点区内");
  assert.ok(clickableBlock.includes("data-board-guide-queue-meta"), "二次信息组仍在可点区内");
  assert.ok(
    !clickableBlock.includes('data-board-guide-queue-dispatch="button"'),
    "派发按钮不得嵌进可点区",
  );
});

test("队列行次入口：只读渲染（无宿主回调）不渲染按钮（与行不可点同款姿态）", () => {
  const markup = render(createElement(BoardGuideView, { board: guideBoard(), now: GUIDE_NOW }));
  assert.ok(
    !markup.includes('data-board-guide-queue-dispatch="button"'),
    "没有派发回调就不渲染按钮",
  );
  assert.ok(markup.includes('data-board-guide-queue-row=""'), "队列行照常渲染（只读）");
});

test("入口词条：两语齐全且逐字（en 侧不回落裸 key）", () => {
  const board = goldenBoard();
  const node = resolveBoardDialogNode(board, "task:8");
  assert.ok(node);
  const en = render(
    createElement(BoardCardDialog, {
      board,
      node,
      onClose: () => {},
      onDispatchCard: () => {},
    }),
    "en-US",
  );
  const button = buttonMarkup(en, "data-board-dialog-dispatch");
  assert.ok(button.includes("Dispatch card"), `en 侧词条：${button}`);
  assert.ok(!button.includes("board.dispatch"), "不得渲染裸 key");
});
