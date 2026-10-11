/**
 * 卡 #89 / A4-3 折叠默认态 + 会话记忆的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM +
 * 真事件）——独立脚本，文件名不含 `.test.`（与 `boardEpicGroupOrderBrowser.ts` 同款：
 * `node --test` 常规套件不收它）。与既有 A4-1b/A4-2 脚本分文件：本文件只含折叠场景。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：默认态是 `<details>` 的原生 `open` 与表格条件渲染的**真 DOM
 * 事实**；折叠是 `<summary>` 默认动作 / 折叠按钮的真实交互结果；「刷新后保持」只有经真实
 * 卸载重挂（`__BOARD_REMOUNT__`）读回 sessionStorage 才是行为证据；窄档溢出是排版行为。
 * 五组证据（对应卡文验收「首次打开默认态 + 刷新后保持 + 反例必咬」）：
 *   1. 默认态（四视图真 DOM）：含活跃期次展开 · 全终态组折叠（反例：KANB2/DONE1 展开即红）·
 *      缺口组展开（反例：DONE2 折叠即红——缺口不许被埋，OB-2 共洽点）；
 *   2. 看板列内投影：已完成列的 KANB（承载全终态成员）折叠、DONE（含缺口成员）展开；
 *   3. 点击路由（真指针序列）：树形 KANB1 组头收起、列表 KANB2 组头展开、表格 KANB2 层按钮展开
 *      且成员行回到 DOM；层不是卡（不落弹窗）；
 *   4. 会话记忆：用户动过的组经「卸载重挂」（= 刷新/重开面板）照记忆呈现，未动过的组照默认态；
 *   5. 溢出探针：宽 1400 与窄 360 两档四视图（**含 tree**——OB-1 补测）视图根 / 层盒 / 层头 /
 *      层名 / 表格组行 `scrollWidth <= clientWidth`（长标题压力）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardFoldBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { FOLD_BOARD, type FoldFixtureFeature } from "./boardFoldFixture.js";
import { epicFoldDriverSource } from "./boardFoldBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 溢出压力：真实板里长中文标题形态（层头/组行不得被撑出横向溢出）。 */
const LONG_TITLE =
  "看板系统（KANB）——含多期容器层、跨期长标题与折叠默认态压测-abcdefghijklmnopqrstuvwxyz-0123456789";

function buildFoldBoardJson(): string {
  const raw = structuredClone(FOLD_BOARD) as {
    epics: Array<{ title: string }>;
    features: FoldFixtureFeature[];
  };
  for (const epic of raw.epics) epic.title = LONG_TITLE;
  for (const feature of raw.features) feature.title = `${feature.title}——${LONG_TITLE}`;
  return JSON.stringify(raw);
}

interface LayerProbes {
  root: BoardBrowserOverflowProbe | null;
  phases: Array<{
    name: string | null;
    block: BoardBrowserOverflowProbe | null;
    header: BoardBrowserOverflowProbe | null;
    layerName: BoardBrowserOverflowProbe | null;
  }>;
  epics: Array<{
    name: string | null;
    block: BoardBrowserOverflowProbe | null;
    header: BoardBrowserOverflowProbe | null;
    layerName: BoardBrowserOverflowProbe | null;
  }>;
  tableRows: Array<{ id: string | null; block: BoardBrowserOverflowProbe | null }>;
}

interface FoldResult {
  ua: string;
  defaults: Record<
    "tree" | "list" | "kanban",
    {
      phases: Record<string, boolean | null>;
      epics: Record<string, boolean | null>;
    }
  >;
  kanbanDoneColumn: Record<string, boolean | null>;
  tableDefaults: {
    kanb2: string | null;
    done1: string | null;
    done2: string | null;
    gapRowRendered: boolean;
    kanb2RowRendered: boolean;
    doneUngroupedGroup: string | null;
    doneUngroupedRowRendered: boolean;
  };
  treeAfterCollapse: {
    kanb1: boolean | null;
    kanb2: boolean | null;
    dialog: boolean;
    childStillInDom: boolean;
  };
  tableAfterToggle: { done1: string | null; rowRendered: boolean; dialog: boolean };
  storedAfterToggles: string | null;
  memorySteps: Array<{ label: string; stored: string | null }>;
  reveal: {
    epicExpanded: string | null;
    phaseExpanded: string | null;
    rowRendered: boolean;
    highlighted: boolean;
  };
  treeAfterRemount: Record<string, boolean | null>;
  tableAfterRemount: Record<string, string | null>;
  wide: Record<"tree" | "list" | "kanban" | "table", LayerProbes>;
  narrow: Record<"tree" | "list" | "kanban" | "table", LayerProbes>;
}

function assertNoLayerOverflow(layers: LayerProbes, label: string): void {
  assert.ok(layers.root, `${label}：视图根可探`);
  assertNoHorizontalOverflow(layers.root, `${label} 视图根`);
  for (const row of [...layers.phases, ...layers.epics]) {
    assert.ok(row.block && row.header && row.layerName, `${label}：${row.name} 层盒/层头/层名应在`);
    assertNoHorizontalOverflow(row.block, `${label} 层盒（${row.name}）`);
    assertNoHorizontalOverflow(row.header, `${label} 层头（${row.name}）`);
    assertNoHorizontalOverflow(row.layerName, `${label} 层名（${row.name}）`);
  }
  for (const row of layers.tableRows) {
    assert.ok(row.block, `${label}：${row.id} 表组行可探`);
    assertNoHorizontalOverflow(row.block, `${label} 表组行（${row.id}）`);
  }
}

async function main(): Promise<void> {
  const boardJson = buildFoldBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["tree", "kanban", "list", "table"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: epicFoldDriverSource(),
    label: "epic-fold",
  })) as FoldResult | null;
  console.log(`EPIC_FOLD_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "折叠场景应回传量取结果");

  /* 1. 默认态（四视图真 DOM）：含活跃展开、全终态折叠、缺口组展开（两组反例）。 */
  for (const mode of ["tree", "list"] as const) {
    const phases: Record<string, boolean | null> = result.defaults[mode].phases;
    assert.equal(phases.KANB1, true, `${mode}：KANB1 含活跃成员 → 默认展开`);
    assert.equal(phases.KANB2, false, `${mode}：KANB2 全终态 → 默认折叠（全终态组展开必咬）`);
    assert.equal(phases.DONE1, false, `${mode}：DONE1 全终态 → 默认折叠`);
    assert.equal(phases.DONE2, true, `${mode}：DONE2 终态成员带缺口 → 默认展开（缺口组折叠必咬）`);
    assert.equal(result.defaults[mode].epics.KANB, true, `${mode}：KANB 含活跃期次 → 展开`);
    assert.equal(result.defaults[mode].epics.DONE, true, `${mode}：DONE 缺口跨层传播 → 展开`);
  }
  assert.equal(
    result.defaults.kanban.phases.KANB1,
    true,
    "看板执行中列：KANB1 承载活跃成员 → 展开（列内投影）",
  );
  /* 2. 看板列内投影：已完成列按本列承载成员算默认态。 */
  assert.equal(result.kanbanDoneColumn.KANB, false, "看板已完成列：KANB 承载全终态 → 折叠");
  assert.equal(result.kanbanDoneColumn.DONE, true, "看板已完成列：DONE 含缺口成员 → 展开");
  assert.equal(result.kanbanDoneColumn.DONE1, false, "看板已完成列：DONE1 折叠");
  assert.equal(result.kanbanDoneColumn.DONE2, true, "看板已完成列：DONE2 展开");
  /* 3. 表格两级组行的条件渲染事实。 */
  assert.equal(result.tableDefaults.kanb2, "false", "表格 KANB2 层按钮 aria-expanded=false");
  assert.equal(result.tableDefaults.done1, "false", "表格 DONE1 层按钮 aria-expanded=false");
  assert.equal(result.tableDefaults.done2, "true", "表格 DONE2 层按钮 aria-expanded=true");
  assert.equal(result.tableDefaults.gapRowRendered, true, "缺口成员行在渲染面（缺口不许被埋）");
  assert.equal(result.tableDefaults.kanb2RowRendered, false, "折叠层成员行不在渲染面");
  assert.equal(
    result.tableDefaults.doneUngroupedGroup,
    "false",
    "表格稿层：无归属已完成稿分组行折叠",
  );
  assert.equal(result.tableDefaults.doneUngroupedRowRendered, false, "表格稿层：折叠组子行不渲染");
  /* 4. 点击路由（真指针序列）：折叠真发生、层不是卡。 */
  assert.equal(result.treeAfterCollapse.kanb1, false, "点树形 KANB1 组头 → 收起");
  assert.equal(result.treeAfterCollapse.kanb2, false, "其余组状态不动");
  assert.equal(result.treeAfterCollapse.dialog, false, "点层头不落弹窗（层不是卡）");
  assert.equal(
    result.treeAfterCollapse.childStillInDom,
    true,
    "details 折叠不是消失（子块仍在 DOM，原生语义）",
  );
  assert.equal(result.tableAfterToggle.done1, "true", "点表格 DONE1 层按钮 → 展开");
  assert.equal(result.tableAfterToggle.rowRendered, true, "展开后成员行回到渲染面");
  assert.equal(result.tableAfterToggle.dialog, false, "点层按钮不落弹窗（层不是卡）");
  /* 5. 会话记忆：写入落 sessionStorage；卸载重挂后照记忆读回（未动过的组照默认态）。 */
  assert.ok(result.storedAfterToggles, "用户动作应落会话记忆（sessionStorage）");
  const stored = JSON.parse(result.storedAfterToggles) as Record<string, boolean>;
  // 记忆只记用户动过的那三层：挂载期的默认态属性应用不得落键（否则默认态被冻结——实测踩过）。
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["phase:DONE#1", "phase:KANB#1", "phase:KANB#2"],
    "记忆只落用户动过的组（挂载期默认态不落键）",
  );
  assert.equal(stored["phase:KANB#1"], false, "树形收起 KANB1 → 记忆落 phase:KANB#1=false");
  assert.equal(stored["phase:KANB#2"], true, "列表展开 KANB2 → 记忆落 phase:KANB#2=true");
  assert.equal(stored["phase:DONE#1"], true, "表格展开 DONE1 → 记忆落 phase:DONE#1=true");
  assert.equal(
    result.treeAfterRemount.kanb1,
    false,
    "重挂后：用户收起的组照记忆收起（刷新后保持）",
  );
  assert.equal(result.treeAfterRemount.kanb2, true, "重挂后：用户展开的组照记忆展开（同键跨视图）");
  assert.equal(result.treeAfterRemount.done1, true, "重挂后：表格里展开过的层在树形同样展开");
  assert.equal(
    result.treeAfterRemount.ungroupedFeature,
    false,
    "重挂后：未动过的组照默认态折叠（默认态未被记忆冻结）",
  );
  assert.equal(result.tableAfterRemount.kanb2, "true", "重挂后表格层照记忆展开");
  assert.equal(result.tableAfterRemount.done1, "true", "重挂后表格用户展开层照记忆展开");
  assert.equal(result.tableAfterRemount.done2, "true", "重挂后表格缺口层照默认态展开（未动过）");
  /* 5b. 跳转揭示（用户折叠过的组 + 提示条真点击）：祖先层被展开、缺口卡回渲染面并带高亮锚点。 */
  assert.equal(result.reveal.epicExpanded, "true", "跳转揭示展开用户折叠的 epic 层");
  assert.equal(result.reveal.phaseExpanded, "true", "跳转揭示展开命中的期次层");
  assert.equal(result.reveal.rowRendered, true, "缺口卡（跳转落点）回渲染面");
  assert.equal(result.reveal.highlighted, true, "落点带高亮锚点（滚动可见的落点事实）");
  /* 6. 溢出探针：宽 1400 / 窄 360，四视图（含 tree）。 */
  for (const mode of ["tree", "list", "kanban", "table"] as const) {
    assertNoLayerOverflow(result.wide[mode], `${mode} 视图（宽 1400）`);
  }
  for (const mode of ["tree", "list", "kanban", "table"] as const) {
    assertNoLayerOverflow(result.narrow[mode], `${mode} 视图（窄 360）`);
  }
  console.log(`EPIC_FOLD_MEMORY_STEPS=${JSON.stringify(result.memorySteps)}`);
  console.log(
    `EPIC_FOLD_ASSERTIONS_OK tree=${JSON.stringify(result.defaults.tree.phases)} ` +
      `table=${JSON.stringify(result.tableDefaults)} 记忆键=${Object.keys(stored).join(",")} ` +
      `揭示=${JSON.stringify(result.reveal)} ` +
      `窄档 tree 组数=${result.narrow.tree.phases.length}`,
  );
  console.log("BOARD_EPIC_FOLD_BROWSER_ASSERTIONS_OK");
}

await main();
