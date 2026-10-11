/**
 * 编排视图（#185）入口接线断言：视图切换控件第六入口（编排）常驻、选中态不靠颜色表达、
 * 切到 dispatch 视图根真渲染三区（SSR 结构面；点击路由派发与溢出探针在
 * `boardDispatchBrowser.ts`）。
 *
 * 入口形态取舍（卡文「指引面新增区块或独立视图，按信息密度定，报告成文取舍」）已落
 * **独立视图**：本文件断言的是视图集与面板分派的接线（组件缺省参数仍引用单点
 * `DEFAULT_BOARD_VIEW_MODE`，不写字面量）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { BOARD_VIEW_MODES } from "../src/board/boardViewsViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildDispatchFixture, cleanupDispatchFixture } from "./boardDispatchFixture.js";

function readyStateOf(raw: Record<string, unknown>) {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是可渲染的 v2 板");
  if (outcome.kind !== "ready") throw new Error("unreachable");
  return { kind: "ready" as const, board: outcome.board };
}

function render(
  state: ReturnType<typeof readyStateOf>,
  props: { viewMode: (typeof BOARD_VIEW_MODES)[number] },
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state,
        ...props,
        onOpenCard: () => {},
      }),
    }),
  );
}

test("编排视图入口：切换控件含「编排」第六入口；选中该入口时落到 dispatch 视图根（三区在场）", () => {
  const fixture = buildDispatchFixture();
  try {
    const state = readyStateOf(fixture.boardRaw);
    assert.ok(
      BOARD_VIEW_MODES.includes("dispatch" as never),
      "视图闭集含 dispatch（独立视图形态）",
    );
    const markup = render(state, { viewMode: "dispatch" });
    const switcher = /data-board-view-switcher[\s\S]*?<\/div>/.exec(markup)?.[0] ?? "";
    assert.ok(switcher.includes('data-board-view-option="dispatch"'), "切换控件有编排入口");
    assert.ok(
      /data-board-view-option="dispatch"[^>]*data-active="true"|data-active="true"[^>]*data-board-view-option="dispatch"/.test(
        switcher,
      ),
      "编排入口选中态走 aria-pressed/data-active（不靠颜色表达）",
    );
    assert.ok(markup.includes('data-board-view="dispatch"'), "面板分派落到编排视图根");
    assert.ok(markup.includes('data-board-dispatch-zone="dispatchable"'), "可派清单区在场");
    assert.ok(markup.includes('data-board-dispatch-zone="blocked"'), "阻塞归因区在场");
    assert.ok(markup.includes('data-board-dispatch-zone="group"'), "并发组区在场");
  } finally {
    cleanupDispatchFixture(fixture);
  }
});
