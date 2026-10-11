/**
 * 编排视图（#185）的 SSR 渲染断言（浏览器行为断言在 `boardDispatchBrowser.ts`）。
 *
 * 期望值独立真源：`next-dispatch.mjs --json`（夹具构建器实跑工具并把结论搬进板夹具）。
 * 本文件断言 DOM 锚点与三区呈现形态；文案只断言**结构化片段**（卡号/文件名/号位），
 * 不逐字抄实现词条——判据锚点才是稳定的公共缝。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardDispatchView } from "../src/board/BoardDispatchView.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { buildDispatchFixture, cleanupDispatchFixture } from "./boardDispatchFixture.js";

function readyBoardOf(raw: Record<string, unknown>) {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是可渲染的 v2 板");
  if (outcome.kind !== "ready") throw new Error("unreachable");
  return outcome.board;
}

function renderDispatch(
  raw: Record<string, unknown>,
  options: { locale?: "zh-CN" | "en-US"; onOpenCard?: (id: string) => void } = {},
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: options.locale ?? ("zh-CN" as const),
      children: createElement(BoardDispatchView, {
        board: readyBoardOf(raw),
        ...(options.onOpenCard ? { onOpenCard: options.onOpenCard } : {}),
      }),
    }),
  );
}

/** 切出某区（`data-board-dispatch-zone`）的标记片段（跨区断言互不串味）。 */
function zoneMarkup(markup: string, zone: string): string {
  const match = new RegExp(
    `data-board-dispatch-zone="${zone}"[\\s\\S]*?(?=data-board-dispatch-zone="|</div>$|$)`,
  ).exec(markup);
  assert.ok(match, `区 ${zone} 应存在`);
  return match[0];
}

/** 按序取锚点的属性值（行序断言用）。 */
function anchorValues(markup: string, anchor: string): string[] {
  return [...markup.matchAll(new RegExp(`${anchor}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

test("编排视图渲染：三区（可派/阻塞归因/并发组）锚点与行序 = CLI 结论；行可点（弹窗路由）", () => {
  const fixture = buildDispatchFixture();
  try {
    const markup = renderDispatch(fixture.boardRaw, { onOpenCard: () => {} });
    assert.ok(markup.includes('data-board-view="dispatch"'), "视图根带 dispatch 锚点");
    assert.ok(markup.includes('data-board-dispatch-state="ready"'), "含派生段 → 就绪态");

    // 可派清单：行序 = CLI dispatchable（不重排）。
    const dispatchable = zoneMarkup(markup, "dispatchable");
    assert.deepEqual(
      anchorValues(dispatchable, "data-board-dispatch-row"),
      fixture.cli.dispatchable.map((card) => String(card.no)),
      "可派行序 = CLI 结论",
    );
    assert.deepEqual(
      anchorValues(dispatchable, "data-board-card"),
      fixture.cli.dispatchable.map((card) => `task:${card.no}`),
      "行身份 = 既有弹窗路由锚点",
    );
    assert.ok(dispatchable.includes("assets/independent.mjs"), "域文本呈现（文件清单）");
    assert.ok(dispatchable.includes('data-board-dispatch-domain-unknown="103"'), "域未知行带标记");
    assert.equal(
      anchorValues(dispatchable, "data-board-dispatch-next")[0],
      "implementer",
      "接手位锚点直读",
    );
    assert.ok(dispatchable.includes('role="button"'), "行可点（有 onOpenCard 时）");
    assert.ok(dispatchable.includes('tabindex="0"'), "行可键盘聚焦");

    // 阻塞归因：行序 = CLI blocked；类别/号位/域占细节/在途标记逐项落锚点。
    const blocked = zoneMarkup(markup, "blocked");
    assert.deepEqual(
      anchorValues(blocked, "data-board-dispatch-blocked"),
      fixture.cli.blocked.map((entry) => String(entry.no)),
      "阻塞归因行序 = CLI 结论",
    );
    assert.ok(blocked.includes('data-board-dispatch-blocked-kind="domain"'), "域占类别");
    assert.ok(blocked.includes('data-board-dispatch-blocked-by="104"'), "域占者号位");
    assert.ok(blocked.includes("assets/shared.mjs"), "域占细节（文件名）可读");
    assert.ok(
      blocked.includes('data-board-dispatch-blocked-target-inflight="true"'),
      "依赖在途标记（targetInFlight）落锚点",
    );
    assert.ok(
      blocked.includes('data-board-dispatch-blocked-target-inflight="false"'),
      "依赖未在途标记（false）落锚点",
    );

    // 并发组：成员序 = CLI parallelGroup；槽位计数行直读。
    const group = zoneMarkup(markup, "group");
    assert.deepEqual(
      anchorValues(group, "data-board-dispatch-group-member"),
      fixture.cli.parallelGroup.map(String),
      "并发组成员序 = CLI 结论",
    );
    assert.ok(
      group.includes(`data-board-dispatch-capacity="${fixture.cli.capacity}"`),
      "并发上限锚点直读",
    );
    assert.ok(
      group.includes(`data-board-dispatch-slots-free="${fixture.cli.inFlight.slotsFree}"`),
      "剩余槽位锚点直读",
    );
    assert.ok(
      group.includes(`data-board-dispatch-inflight="${fixture.cli.inFlight.count}"`),
      "在途计数锚点直读",
    );
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排视图渲染：缺 dispatch 段 → 未就绪指向（重编译），三区零渲染（禁自算兜底）", () => {
  const fixture = buildDispatchFixture({ withDispatch: false });
  try {
    const markup = renderDispatch(fixture.boardRaw, { onOpenCard: () => {} });
    assert.ok(markup.includes('data-board-dispatch-state="missing"'), "缺段 → 未就绪态");
    assert.ok(markup.includes('data-board-dispatch-recompile=""'), "给重编译指向");
    assert.ok(markup.includes('role="status"'), "未就绪是可感知状态（读屏可达）");
    // 反例咬点：夹具板有 frontier 6 张、blocked 2 条——自算兜底会落行锚点。
    assert.equal(anchorValues(markup, "data-board-dispatch-row").length, 0, "未就绪不渲染可派行");
    assert.equal(
      anchorValues(markup, "data-board-dispatch-blocked").length,
      0,
      "未就绪不渲染阻塞行",
    );
    assert.equal(
      anchorValues(markup, "data-board-dispatch-group-member").length,
      0,
      "未就绪不渲染并发组",
    );
    assert.ok(!markup.includes("data-board-card"), "未就绪不渲染任何卡片锚点（不自算）");
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排视图渲染：可派 0 路（全阻塞）→ 三区各自空态文案（不留空壳）", () => {
  const fixture = buildDispatchFixture({ variant: "all-blocked" });
  try {
    assert.equal(fixture.cli.dispatchable.length, 0, "夹具确实全阻塞（CLI 结论）");
    const markup = renderDispatch(fixture.boardRaw);
    assert.ok(markup.includes('data-board-dispatch-empty="dispatchable"'), "可派区空态锚点");
    assert.ok(
      markup.includes('data-board-dispatch-empty="blocked"') === false,
      "阻塞区有行（不空）",
    );
    assert.ok(markup.includes('data-board-dispatch-empty="group"'), "并发组空态锚点");
    const blocked = zoneMarkup(markup, "blocked");
    assert.deepEqual(
      anchorValues(blocked, "data-board-dispatch-blocked"),
      fixture.cli.blocked.map((entry) => String(entry.no)),
      "全阻塞板仍逐张给归因（201 域占 / 203 依赖在途）",
    );
  } finally {
    cleanupDispatchFixture(fixture);
  }
});

test("编排视图渲染：两语无裸 key；en-US 走英文词条（i18n 收口）", () => {
  const fixture = buildDispatchFixture();
  try {
    const zh = renderDispatch(fixture.boardRaw);
    const en = renderDispatch(fixture.boardRaw, { locale: "en-US" });
    for (const markup of [zh, en]) {
      assert.ok(!markup.includes("board.dispatch."), "不得泄露裸词条 key");
    }
    assert.notEqual(zh, en, "两语渲染应不同（词条真实生效）");
    assert.ok(en.includes("Dispatch"), "en 侧用英文视图名");
  } finally {
    cleanupDispatchFixture(fixture);
  }
});
