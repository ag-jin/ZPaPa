/**
 * 卡 #183 卡片内容区块的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM + 真事件）
 * ——独立脚本，文件名不含 `.test.`（`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：默认折叠态是 `<details>.open` 的**真 DOM 事实**；展开是真实
 * 指针点击 summary 后的原生 toggle；折叠不可见是几何量取（closed details 的内容不渲染）；
 * summary 参与 Tab 循环要看真键盘事件在真弹窗上的派发结果；溢出是排版行为（宽 1400 / 窄 360
 * 两档 `scrollWidth <= clientWidth`）。
 *
 * 覆盖（对应卡文交付面③④与门禁）：
 *   1. 点击路由：树形点卡 → 弹窗；卡片内容区块常驻、默认折叠、含目标/交付面/验收全文；
 *   2. 展开态：真指针点 summary → 展开且正文几何可见；
 *   3. 焦点序列：summary 在弹窗可聚焦序列内（从 summary 按 Tab 不被回绕逻辑吃掉）；
 *   4. 空值反例：无三字段的卡显式「板上未携带」×3，无值节点、无他卡正文（不硬造）；
 *   5. 溢出探针：两档三处（弹窗盒/区块/值节点）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardCardTextBrowser.ts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import {
  CARD_TEXT_ACCEPTANCE,
  CARD_TEXT_BOARD,
  CARD_TEXT_DELIVERABLES,
  CARD_TEXT_LONG_GOAL,
} from "./boardCardTextFixture.js";
import { cardTextDialogDriverSource } from "./boardCardTextBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

interface CardTextDialogRead {
  present: boolean;
  open: boolean | null;
  summaryText: string | null;
  allAbsent: boolean;
  valueCount: number;
  absentCount: number;
  itemTexts: Array<string | null>;
  rowsPresent: Record<string, boolean>;
  bodyHeight: number | null;
  dialogHeight: number;
  text: string;
  dialogOverflow: BoardBrowserOverflowProbe;
  sectionOverflow: BoardBrowserOverflowProbe | null;
  valueOverflows: BoardBrowserOverflowProbe[];
}

interface CardTextStep {
  before: CardTextDialogRead;
  openAfterToggle: boolean;
  after: CardTextDialogRead;
}

interface CardTextResult {
  ua: string;
  summaryFocused: boolean;
  summaryTabPrevented: boolean;
  focusAfterSummaryTab: string;
  wide: CardTextStep;
  empty: CardTextStep;
  narrow: CardTextStep;
}

function collectClassNames(markup: string): string[] {
  const names: string[] = [];
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) names.push(token);
  }
  return names;
}

function assertProbes(read: CardTextDialogRead, label: string): void {
  assertNoHorizontalOverflow(read.dialogOverflow, `${label} 弹窗盒`);
  assert.ok(read.sectionOverflow, `${label}：卡片内容区块可探`);
  assertNoHorizontalOverflow(read.sectionOverflow, `${label} 卡片内容区块`);
  assert.ok(read.valueOverflows.length >= 2, `${label}：值节点应可探（目标 + 交付面列表）`);
  read.valueOverflows.forEach((probe, index) => {
    assertNoHorizontalOverflow(probe, `${label} 值节点 ${index}`);
  });
}

async function main(): Promise<void> {
  const boardJson = JSON.stringify(CARD_TEXT_BOARD);
  const outcome = parseBoardJson(boardJson);
  assert.equal(outcome.kind, "ready", "夹具必须是 v2 且 features 非空");
  if (outcome.kind !== "ready") return;

  // 产物 CSS：四视图 SSR 类名之外，补两张卡「弹窗打开态」的 SSR 渲染类名（弹窗不在视图 SSR 里）。
  const extraClassNames: string[] = [];
  for (const openCardId of ["task:301", "task:302"]) {
    extraClassNames.push(
      ...collectClassNames(
        renderToStaticMarkup(
          createElement(ZCodeIntlProvider, {
            initialLocale: "zh-CN" as const,
            children: createElement(BoardPaneView, {
              state: { kind: "ready" as const, board: outcome.board },
              viewMode: "tree" as const,
              openCardId,
            }),
          }),
        ),
      ),
    );
  }
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["tree"],
    extraClassNames,
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );

  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: cardTextDialogDriverSource(),
    label: "card-text",
  })) as CardTextResult | null;
  console.log(`CARD_TEXT_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "卡片内容场景应回传量取结果");

  /* 场景 1：点击路由 + 常驻折叠 + 全文在渲染面。 */
  assert.ok(result.wide.before.present, "点卡开弹窗：卡片内容区块常驻在渲染面");
  assert.equal(result.wide.before.open, false, "默认折叠态（不自动展开抢版面）");
  assert.ok(result.wide.before.summaryText?.includes("卡片内容"), "折叠头带区块标题词条（zh）");
  assert.deepEqual(
    result.wide.before.rowsPresent,
    { goal: true, deliverables: true, acceptance: true },
    "目标/交付面/验收三行都在渲染面",
  );
  assert.ok(result.wide.before.text.includes(CARD_TEXT_LONG_GOAL), "目标全文在渲染面（含换行）");
  assert.ok(result.wide.before.text.includes(CARD_TEXT_ACCEPTANCE), "验收全文在渲染面");
  assert.deepEqual(
    result.wide.before.itemTexts,
    CARD_TEXT_DELIVERABLES,
    "交付面逐项渲染（顺序与文本逐字一致）",
  );
  assert.ok(
    result.wide.before.dialogHeight < result.wide.after.dialogHeight,
    `折叠态弹窗高度小于展开态（不塞满：长文折起；${result.wide.before.dialogHeight} < ${result.wide.after.dialogHeight}）`,
  );
  assertProbes(result.wide.before, "宽档折叠态");

  /* 场景 2：真指针展开 + 几何可见。 */
  assert.equal(result.wide.openAfterToggle, true, "点 summary → 展开");
  assert.ok((result.wide.after.bodyHeight ?? 0) > 0, "展开后正文几何可见（>0 高）");

  /* 场景 3：焦点序列包含 summary（从 summary 按 Tab 不被回绕逻辑吃掉）。 */
  assert.equal(result.summaryFocused, true, "summary 可获得焦点");
  assert.equal(
    result.summaryTabPrevented,
    false,
    "从 summary 派发 Tab 不被弹窗回绕逻辑拦截（summary 在可聚焦序列内）",
  );

  /* 场景 4：空值反例卡（真实板形态）——显式「未携带」，不硬造。 */
  assert.ok(result.empty.before.present, "字段缺省时区块仍常驻（空值有明确形态）");
  assert.equal(result.empty.before.open, false, "空值卡默认折叠");
  assert.equal(result.empty.before.allAbsent, true, "摘要行带「全空」提示");
  assert.equal(result.empty.before.valueCount, 0, "一个值节点都不许有（不硬造）");
  assert.equal(result.empty.before.absentCount, 3, "三字段各有显式「未携带」占位");
  assert.ok(result.empty.before.text.includes("板上未携带"), "空态文案逐字（zh：板上未携带）");
  assert.ok(!result.empty.before.text.includes("拨开关"), "空值卡不得出现他卡正文（不借、不造）");
  assert.equal(result.empty.openAfterToggle, true, "空值卡也可展开（空态可见）");
  assert.ok((result.empty.after.bodyHeight ?? 0) > 0, "空值卡展开后占位行几何可见");

  /* 场景 5：窄档 360（手机 Web）——三处溢出探针。 */
  assert.equal(result.narrow.before.open, false, "窄档默认折叠");
  assertProbes(result.narrow.before, "窄档折叠态");
  assert.equal(result.narrow.openAfterToggle, true, "窄档可展开");
  assert.ok(
    result.narrow.before.dialogHeight < result.narrow.after.dialogHeight,
    `窄档折叠态弹窗高度小于展开态（${result.narrow.before.dialogHeight} < ${result.narrow.after.dialogHeight}）`,
  );
  assertProbes(result.narrow.after, "窄档展开态（长文压力）");

  console.log(`CARD_TEXT_BROWSER_ASSERTIONS_OK（${result.ua}）`);
}

await main();
