/**
 * 卡 #175 两条改动的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM + 真事件）——
 * 独立脚本，文件名不含 `.test.`（与 `boardEpicContainersBrowser.ts` / `boardV21BrowserScenarios.ts`
 * 同款：`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁，2026-10-10 用户批准）：弱分隔的「真是一条 1px 弱描边、不撑宽、
 * 不是色块」是排版行为；提示的可见性/字号层级/是否把控件行撑出横向溢出也是排版行为；点击路由
 * 只有真事件路径量得出来。三条证据（对应卡文验收「ui-designer 复核通过；浏览器断言绿」）：
 *   1. 树形完成块弱分隔（#175 ①）：三条分隔线的上下邻接（活卡 → 完成）、1px 描边、无实心底色、
 *      自身与所在组不横向溢出、树形容器不溢出；
 *   2. 点击路由：点分隔线后的已完成卡仍开弹窗（弱分隔不吃卡片点击）；
 *   3. 持久性提示（#175 ②）：列表/表格共用控件组里提示真可见、走 text-ui-xs（弱层级）、
 *      全文进 title、不加实心底色、控件组与所在行不横向溢出。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardTreeDividerSortHintBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { SORTING_BOARD } from "./boardSortingFixture.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { treeDividerSortHintDriverSource } from "./boardTreeDividerSortHintBrowserDrivers.js";

interface DividerMeasurement {
  borderTopWidth: string;
  borderTopColor: string;
  backgroundColor: string;
  display: string;
  box: { w: number; h: number };
  previousCard: string | null;
  nextCard: string | null;
  self: BoardBrowserOverflowProbe;
  parent: BoardBrowserOverflowProbe | null;
}

interface TreeDividerSortHintResult {
  ua: string;
  dividers: DividerMeasurement[];
  treeProbe: BoardBrowserOverflowProbe;
  clickDialogId: string | null;
  controls: {
    probe: BoardBrowserOverflowProbe;
    rowProbe: BoardBrowserOverflowProbe | null;
    hint: {
      text: string | null;
      title: string | null;
      width: number;
      fontSize: string;
      color: string;
      backgroundColor: string;
      probe: BoardBrowserOverflowProbe;
    };
    baseFontSize: string;
  };
}

/** zh 期望逐字（与 SSR 侧 `boardFilterSortPersistenceHint.test.ts` 同一份文案真源）。 */
const ZH_HINT = "排序在本会话保留 · 过滤为临时条件";
const ZH_HINT_TITLE =
  "排序视角按会话记忆保留（切视图或重开面板仍在）；过滤条件为临时状态，关闭面板后回到默认";

/**
 * 期望的分隔线上下邻接（真源同 SSR：夹具 `SORTING_BOARD` 的章节/嵌套结构 + 卡 #65 同级沉底
 * 规则）——三处「活卡 → 完成」边界逐对写死，不由实现回算。
 */
const EXPECTED_BOUNDARIES: Array<[string | null, string | null]> = [
  ["task:77", "task:76"], // #75 的嵌套子卡组：#77（活）→ #76（完成）
  ["task:76", "task:73"], // 阶段一组：活卡块末尾 → 首张已完成
  ["task:82", "task:79"], // 阶段二组：#82（活）→ #79（完成）
];

async function main(): Promise<void> {
  const boardJson = JSON.stringify(SORTING_BOARD);
  const bundle = await bundleBoardPaneClient();
  // 树形场景要树形类名 + 列表控件类名（提示在列表/表格共用控件组里）。
  const css = await compileBoardPaneCss({ boards: [boardJson], viewModes: ["tree", "list"] });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: treeDividerSortHintDriverSource(),
    label: "tree-divider-sort-hint",
  })) as TreeDividerSortHintResult | null;
  console.log(`TREE_DIVIDER_SORT_HINT_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "弱分隔/提示场景应回传量取结果");

  /* ---------------- #175 ①：树形完成块弱分隔 ---------------- */
  assert.deepEqual(
    result.dividers.map((divider) => [divider.previousCard, divider.nextCard]),
    EXPECTED_BOUNDARIES,
    "弱分隔只落在三处「活卡 → 完成」边界（全完成组不插线）",
  );
  for (const [index, divider] of result.dividers.entries()) {
    assert.equal(divider.borderTopWidth, "1px", `分隔线 #${index} 应是真 1px 描边`);
    assert.equal(
      divider.backgroundColor,
      "rgba(0, 0, 0, 0)",
      `分隔线 #${index} 不得有实心底色（大规模填充反例）`,
    );
    assert.equal(divider.display, "block", `分隔线 #${index} 是普通块级细线`);
    assert.ok(
      divider.box.w > 0 && divider.box.h <= 2,
      `分隔线 #${index} 是细线而非色块：${JSON.stringify(divider.box)}`,
    );
    assertNoHorizontalOverflow(divider.self, `分隔线 #${index}`);
    if (divider.parent) {
      assertNoHorizontalOverflow(divider.parent, `分隔线 #${index} 的所在组`);
    }
  }
  assertNoHorizontalOverflow(result.treeProbe, "树形视图根容器");

  /* ---------------- 点击路由：弱分隔不吃卡片点击 ---------------- */
  assert.equal(
    result.clickDialogId,
    "task:73",
    "点分隔线后的已完成卡照常开弹窗（弹窗身份 = 被点卡自身）",
  );

  /* ---------------- #175 ②：排序记忆 vs 过滤临时态提示 ---------------- */
  const base = Number.parseFloat(result.controls.baseFontSize);
  assert.ok(Number.isFinite(base), `页面应暴露 --ui-font-size：${result.controls.baseFontSize}`);
  assert.equal(result.controls.hint.text, ZH_HINT, "提示短文案逐字（zh-CN）");
  assert.equal(result.controls.hint.title, ZH_HINT_TITLE, "提示全文语义进 title");
  assert.ok(result.controls.hint.width > 0, "提示真可见（宽度 > 0）");
  assert.equal(
    result.controls.hint.fontSize,
    `${base - 4}px`,
    "提示走 text-ui-xs（弱层级，不抢控件注意力）",
  );
  assert.equal(
    result.controls.hint.backgroundColor,
    "rgba(0, 0, 0, 0)",
    "提示不得带实心底色（色块反例）",
  );
  assertNoHorizontalOverflow(result.controls.hint.probe, "提示自身");
  assertNoHorizontalOverflow(result.controls.probe, "过滤与排序控件组");
  if (result.controls.rowProbe) {
    assertNoHorizontalOverflow(result.controls.rowProbe, "控件组所在行");
  }
  console.log(
    `TREE_DIVIDER_SORT_HINT_ASSERTIONS_OK 分隔线 ${result.dividers.length} 条（1px 弱描边、无底色）；` +
      `点完成卡开弹窗=${result.clickDialogId}；提示「${result.controls.hint.text}」（${result.controls.hint.fontSize}）；` +
      `控件组宽 ${result.controls.probe.clientW}`,
  );
}

await main();
