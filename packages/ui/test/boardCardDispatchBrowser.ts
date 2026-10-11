/**
 * 卡片引用派发的**浏览器行为断言**（卡 #186）——独立脚本，文件名不含 `.test.`
 * （`node --test` 常规套件不收它；由本卡验证按证据脚本手动跑）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：本卡的验收是「用户点卡 →「派发此卡」→ **会话输入框**出现含
 * 卡号的草稿（可编辑可发送）」。输入框是真 Lexical contenteditable（配置/首次输入/光标语义都在
 * 真引擎里），草稿文本只有真 DOM 量得到；队列行行尾按钮与可点区并列（不是嵌套交互控件）、
 * 点按钮不冒泡开弹窗、重复派发不堆第二份、宽 1400 / 窄 360 不横向溢出——全是真排版与真事件链
 * 结果。SSR 结构断言不构成行为证据。
 *
 * 载体：与 kanban/guide 断言同一条管道（真组件 bundle + 真 Tailwind 产物 CSS + Electron 真引擎），
 * 页面里挂两块：`#composer`（真 `ChatPromptEditor`，会话输入框）+ `#board`（真 `BoardPane` 面板，
 * 复刻真实布局：看板侧面板与聚焦会话同屏）。消费接线复刻 SessionPane 的形状——判定与落地都调
 * **真实单点**（`selectComposerTextInsertRequest` / `applyExternalTextInsertRequestToComposer`），
 * 驱动侧不重算业务判据。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild。
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardCardDispatchBrowser.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { cardDispatchDriverSource } from "./boardCardDispatchBrowserDrivers.js";
import { GUIDE_BOARD_JSON } from "./boardGuideFixture.js";
import {
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 夹具里参与断言的两张卡（独立真源：`boardGuideFixture`，不是页面读回来的 DOM 文本）。 */
const CARD_210 = { no: 210, title: "置顶五槽条" };
const CARD_220 = { no: 220, title: "胶囊形态" };
function buildDispatchPageHtml(params: { css: string; boardJson: string; bundle: string }): string {
  const boardJsonLiteral = JSON.stringify(params.boardJson).replaceAll("<", "\\u003c");
  const bundle = params.bundle.replaceAll("</script", "<\\/script");
  // 两块同屏：上=会话输入框（聚焦会话的 composer），下=看板侧面板（真布局形状）。
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-card-dispatch</title>
<style>${params.css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="host" style="height:760px;display:flex;flex-direction:column;width:1400px;overflow:hidden">
<div id="composer" style="flex:0 0 auto"></div>
<div id="board" style="flex:1 1 auto;min-height:0;display:flex"></div>
</div>
<script>globalThis.__BOARD_JSON__=${boardJsonLiteral};</script>
<script>${bundle}</script>
</body></html>`;
}

interface RowMeasure {
  dispatchIsSiblingOfClickable: boolean;
  clickableRole: string | null;
  clickableTabIndex: string | null;
  rowProbe: BoardBrowserOverflowProbe | null;
  buttonProbe: BoardBrowserOverflowProbe | null;
}

interface DispatchBrowserResult {
  queueRowMeasure: RowMeasure;
  queueClick: { draftText: string | null; dialogOpened: boolean };
  dialogMeasure: {
    cardId: string | null;
    label: string;
    disabled: boolean;
    titleAttr: string | null;
    inStatusRow: boolean;
    inHeaderRow: boolean;
    inBlockerRow: boolean;
    boxProbe: BoardBrowserOverflowProbe | null;
    buttonProbe: BoardBrowserOverflowProbe | null;
  };
  dialogClick: {
    afterFirst: string | null;
    afterSecond: string | null;
    dialogStillOpen: boolean;
    editable: string | null;
  };
  probeState: { requestText: string | null; fileCalls: { reads: number; writes: number } } | null;
  finalDraftText: string | null;
  probes: {
    dialogWide: {
      boxProbe: BoardBrowserOverflowProbe | null;
      buttonProbe: BoardBrowserOverflowProbe | null;
    };
    dialogNarrow: {
      boxProbe: BoardBrowserOverflowProbe | null;
      buttonProbe: BoardBrowserOverflowProbe | null;
    };
    rowWide: BoardBrowserOverflowProbe | null;
    rowNarrow: {
      rowProbe: BoardBrowserOverflowProbe | null;
      buttonProbe: BoardBrowserOverflowProbe | null;
    };
  };
}

/** 弹窗 SSR 类名（弹窗只在打开时进渲染面；产物 CSS 缺类会让溢出探针量到「无样式的宽盒」）。 */
function dialogClassNames(): string[] {
  const outcome = parseBoardJson(GUIDE_BOARD_JSON);
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且可解析");
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(BoardPaneView, {
        state: { kind: "ready", board: outcome.board },
        viewMode: "guide",
        openCardId: "task:210",
        onOpenCard: () => {},
        onDispatchCard: () => {},
      }),
    }),
  );
  const tokens: string[] = [];
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) tokens.push(token);
  }
  return tokens;
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient(
    readFileSync(path.join(UI_DIR, "test", "boardCardDispatchPageEntry.tsx"), "utf8"),
  );
  const css = await compileBoardPaneCss({
    boards: [GUIDE_BOARD_JSON],
    viewModes: ["guide"],
    extraClassNames: dialogClassNames(),
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildDispatchPageHtml({ css, boardJson: GUIDE_BOARD_JSON, bundle }),
    driver: cardDispatchDriverSource(),
    label: "card-dispatch",
  })) as DispatchBrowserResult;

  const reference210 = `#${CARD_210.no} ${CARD_210.title}`;
  const reference220 = `#${CARD_220.no} ${CARD_220.title}`;

  /* 1) 队列行尾快捷：真指针点按钮 → 输入框草稿出现卡引用；不打开弹窗；保留用户已输入内容。 */
  assert.equal(result.queueClick.dialogOpened, false, "点行尾按钮不得打开弹窗（不是行下钻）");
  assert.ok(
    result.queueClick.draftText?.includes(reference210),
    `队列行派发后输入框应含该卡引用 ${reference210}（实测：${result.queueClick.draftText}）`,
  );
  assert.ok(
    result.queueClick.draftText?.includes("先看这张卡"),
    `追加不得覆盖用户已输入内容（实测：${result.queueClick.draftText}）`,
  );
  assert.equal(result.queueRowMeasure.dispatchIsSiblingOfClickable, true, "按钮是兄弟节点");
  assert.equal(result.queueRowMeasure.clickableRole, "button", "行下钻语义不变（role=button）");
  assert.equal(result.queueRowMeasure.clickableTabIndex, "0", "行可键盘到达");

  /* 2) 弹窗主入口：位置（状态行、不与关闭/跳转竞争）+ 文案 + 可点态 + 悬停可见载荷。 */
  assert.equal(result.dialogMeasure.cardId, "task:220", "弹窗是被点的那张卡");
  assert.equal(result.dialogMeasure.label, "派发此卡", "按钮文案走词条");
  assert.equal(result.dialogMeasure.disabled, false, "有稳定号 → 可派发");
  assert.equal(result.dialogMeasure.inStatusRow, true, "入口落在状态行（首屏常量可见）");
  assert.equal(result.dialogMeasure.inHeaderRow, false, "入口不与 × 关闭位同排");
  assert.equal(result.dialogMeasure.inBlockerRow, false, "入口不与跳转按钮同排");
  assert.equal(result.dialogMeasure.titleAttr, reference220, "悬停可见将注入的卡引用全文");

  /* 3) 点弹窗入口 → 草稿追加引用；重复点 → 幂等（不堆第二份）；请求消费后清空。 */
  assert.ok(
    result.dialogClick.afterFirst?.includes(reference220),
    `弹窗派发后输入框应含该卡引用（实测：${result.dialogClick.afterFirst}）`,
  );
  assert.ok(
    result.dialogClick.afterFirst?.includes(reference210),
    "前一次派发的引用仍在（追加语义，不清场）",
  );
  assert.equal(
    result.dialogClick.afterSecond?.split(reference220).length,
    result.dialogClick.afterFirst?.split(reference220).length,
    "同一张卡重复派发不得在输入框里堆第二份",
  );
  assert.equal(result.dialogClick.dialogStillOpen, true, "派发不关弹窗（用户仍在抽查动线上）");
  assert.equal(result.dialogClick.editable, "true", "输入框仍是可编辑态（草稿态可改可发）");
  assert.equal(result.probeState?.requestText, null, "请求应用后被清理（不残留、换面不重放）");

  /* 4) 板文件零写入（金丝雀）+ 只读计数在场。 */
  assert.ok((result.probeState?.fileCalls.reads ?? 0) > 0, "面板照常读板");
  assert.equal(result.probeState?.fileCalls.writes, 0, "派发全程板文件零写入");

  /* 5) 溢出探针：宽 1400 / 窄 360（弹窗盒 + 弹窗按钮 + 队列行 + 行按钮）。 */
  assert.ok(result.probes.dialogWide.boxProbe, "弹窗盒量取在场");
  assertNoHorizontalOverflow(result.probes.dialogWide.boxProbe!, "弹窗盒（宽档）");
  assertNoHorizontalOverflow(result.probes.dialogWide.buttonProbe!, "弹窗派发按钮（宽档）");
  assertNoHorizontalOverflow(result.probes.dialogNarrow.boxProbe!, "弹窗盒（窄档 360）");
  assertNoHorizontalOverflow(result.probes.dialogNarrow.buttonProbe!, "弹窗派发按钮（窄档 360）");
  assertNoHorizontalOverflow(result.probes.rowWide!, "队列行（宽档）");
  assertNoHorizontalOverflow(result.probes.rowNarrow.rowProbe!, "队列行（窄档 360）");
  assertNoHorizontalOverflow(result.probes.rowNarrow.buttonProbe!, "队列行派发按钮（窄档 360）");
  assertNoHorizontalOverflow(result.queueRowMeasure.buttonProbe!, "队列行派发按钮（默认档）");

  console.log("CARD_DISPATCH_BROWSER_OK");
  console.log(
    JSON.stringify(
      {
        queueDraft: result.queueClick.draftText,
        finalDraft: result.finalDraftText,
        dialogLabel: result.dialogMeasure.label,
        fileCalls: result.probeState?.fileCalls,
      },
      null,
      1,
    ),
  );
}

await main();
