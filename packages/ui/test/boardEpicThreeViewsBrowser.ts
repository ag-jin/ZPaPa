/**
 * 卡 #168 / A4-1b 看板/列表/表格三视图三层容器的**浏览器行为断言**（真引擎 + 真 Tailwind 产物
 * CSS + 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`（与 `boardEpicContainersBrowser.ts`
 * 同款：`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：容器头行的横向溢出是排版行为（宽 1400 / 窄 360 两档）；层头
 * 折叠是 `<summary>` 默认动作；「层不是卡 → 点击不落弹窗」是事件路由；F1 键盘焦点可见性是
 * :focus-visible 计算样式——四者都只有真引擎量得出。三条证据（对应卡文验收「三视图浏览器断言绿」）：
 *   1. 溢出探针：三视图各自的视图根 / 容器盒 / 层头行 / 层名 / 计数片 / 分组头行
 *      `scrollWidth <= clientWidth`（长标题压力夹具；宽窄两档视口）；
 *   2. 折叠路由：列表/看板的 epic、期次组头派发完整指针/点击序列 → `<details>.open` 真变化、
 *      指示符真旋转（`group-open:rotate-90` 产物类）、折叠后子容器仍在 DOM；表格分组折叠按钮
 *      真折叠（子行条件渲染消失 + aria-expanded 同步）；
 *   3. 点击路由：层头点击不落弹窗（退化形态）；三视图的稿组/特性组头落点照旧开弹窗；
 *      F1 焦点探针：层头 summary / role=button 落点聚焦后背景计算样式必须变化（再失焦复原）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardEpicThreeViewsBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";
import {
  epicThreeViewsClickDriverSource,
  epicThreeViewsOverflowDriverSource,
} from "./boardEpicThreeViewsBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 溢出压力：真实板里长中文标题 + 长 agent/远端名的形态（层头行不得被撑出横向溢出）。 */
const LONG_EPIC_TITLE =
  "看板系统（KANB）——含三期容器层、跨期长标题与双语展开压测-abcdefghijklmnopqrstuvwxyz-0123456789";
const LONG_FEATURE_TITLE =
  "看板 v2 一期甲稿——三层容器在三视图落位（窄面板里的超长标题也要能收敛，不得撑破容器头行）";

/** 夹具：在 EPIC_BOARD 上做标题压力改造（数据面不变，只把标题拉长）。 */
function buildFixtureBoardJson(): string {
  const raw = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; title: string }>;
    features: Array<{ id: string; title: string }>;
  };
  const epic = raw.epics[0];
  assert.ok(epic, "夹具应有 KANB 登记行");
  epic.title = LONG_EPIC_TITLE;
  const feature = raw.features.find((entry) => entry.id === "plan:plan-boardv2-a");
  assert.ok(feature, "夹具应有 PLW0 稿（KANB1 成员）");
  feature.title = LONG_FEATURE_TITLE;
  return JSON.stringify(raw);
}

interface LayerProbe {
  code?: string;
  name?: string;
  parentEpic?: string | null;
  id?: string;
  epic?: string | null;
  phase?: string | null;
  block: BoardBrowserOverflowProbe | null;
  row?: BoardBrowserOverflowProbe | null;
  cell?: BoardBrowserOverflowProbe | null;
  summary: BoardBrowserOverflowProbe | null;
  layerName: BoardBrowserOverflowProbe | null;
  planChip: BoardBrowserOverflowProbe | null;
  phaseChip?: BoardBrowserOverflowProbe | null;
  header?: BoardBrowserOverflowProbe | null;
  layerStatus?: string | null;
  titleAttr?: string | null;
}

interface Layers {
  root: BoardBrowserOverflowProbe | null;
  epics: LayerProbe[];
  phases: LayerProbe[];
  groups: LayerProbe[];
}

interface ColumnLayers extends Layers {
  stage: string;
  body: BoardBrowserOverflowProbe | null;
}

interface OverflowResult {
  ua: string;
  wide: {
    kanban: { columns: ColumnLayers[] };
    list: Layers;
    table: Layers & {
      wrapper: BoardBrowserOverflowProbe | null;
      table: BoardBrowserOverflowProbe | null;
    };
  };
  narrow: { list: Layers; table: Layers; kanban: Layers };
}

interface ClickResult {
  ua: string;
  list: {
    epicCode: string | null;
    epicOpen: { before: boolean; after: boolean; again: boolean };
    fold: {
      expanded: { transform: string | null; rotate: string | null };
      collapsed: { transform: string | null; rotate: string | null };
    };
    dialogAfterEpicClick: boolean;
    phaseStillInDom: boolean;
    phaseName: string | null;
    phaseOpen: { before: boolean; after: boolean; again: boolean };
    groupId: string | null;
    dialogId: string | null;
    focus: { focusedBg: string; blurredBg: string; focusVisible: boolean; changed: boolean };
  };
  kanban: ClickResult["list"];
  table: {
    dialogAfterLayerClick: boolean;
    groupId: string | null;
    expanded: { before: string | null; after: string | null; restored: string | null };
    taskCardId: string | null;
    taskRowVisibleBefore: boolean;
    taskRowVisibleAfter: boolean;
    focus: { focusedBg: string; blurredBg: string; focusVisible: boolean; changed: boolean };
  };
}

/** 旋转签名（Tailwind v4 的 rotate 走独立属性）：`none | none` = 未旋转。 */
function rotationSignature(
  style: { transform: string | null; rotate: string | null } | null | undefined,
): string {
  if (!style) return "missing";
  return [style.transform, style.rotate].map((value) => (value ? value : "none")).join(" | ");
}

/** 逐层溢出断言（容器盒 / 层头行 / 层名 / 计数片 / 分组头行都不得横向溢出）。 */
function assertLayersFit(
  layers: Layers,
  label: string,
  options: { requireGroups?: boolean } = {},
): void {
  assert.ok(layers.root, `${label}：视图根可探`);
  assertNoHorizontalOverflow(layers.root, `${label} 视图根`);
  for (const epic of layers.epics) {
    assert.ok(epic.block && epic.summary, `${label}：epic 盒/章头应在（${epic.code}）`);
    assertNoHorizontalOverflow(epic.block, `${label} epic 盒（${epic.code}）`);
    assertNoHorizontalOverflow(epic.summary, `${label} epic 章头行（${epic.code}）`);
    if (epic.row) assertNoHorizontalOverflow(epic.row, `${label} epic 组行（${epic.code}）`);
    if (epic.cell) assertNoHorizontalOverflow(epic.cell, `${label} epic 组行格（${epic.code}）`);
    assert.ok(epic.layerName, `${label}：epic 层名应在（${epic.code}）`);
    assertNoHorizontalOverflow(epic.layerName, `${label} epic 层名（${epic.code}）`);
    assert.ok(epic.planChip, `${label}：epic 稿数片应在（${epic.code}）`);
    assertNoHorizontalOverflow(epic.planChip, `${label} epic 稿数片（${epic.code}）`);
    assert.ok(epic.phaseChip, `${label}：epic 期数片应在（${epic.code}）`);
    assertNoHorizontalOverflow(epic.phaseChip, `${label} epic 期数片（${epic.code}）`);
  }
  for (const phase of layers.phases) {
    assert.ok(phase.block && phase.summary, `${label}：期次盒/组头应在（${phase.name}）`);
    assertNoHorizontalOverflow(phase.block, `${label} 期次盒（${phase.name}）`);
    assertNoHorizontalOverflow(phase.summary, `${label} 期次组头行（${phase.name}）`);
    if (phase.row) assertNoHorizontalOverflow(phase.row, `${label} 期次组行（${phase.name}）`);
    if (phase.cell) assertNoHorizontalOverflow(phase.cell, `${label} 期次组行格（${phase.name}）`);
    assert.ok(phase.layerName, `${label}：期次层名应在（${phase.name}）`);
    assertNoHorizontalOverflow(phase.layerName, `${label} 期次层名（${phase.name}）`);
    assert.ok(phase.planChip, `${label}：期次稿数片应在（${phase.name}）`);
    assertNoHorizontalOverflow(phase.planChip, `${label} 期次稿数片（${phase.name}）`);
  }
  if (options.requireGroups ?? true) {
    assert.ok(layers.groups.length > 0, `${label}：分组头行应可探（容器内稿层不回归）`);
  }
  for (const group of layers.groups) {
    assert.ok(group.header, `${label}：分组头应在（${group.id}）`);
    assertNoHorizontalOverflow(group.header, `${label} 分组头行（${group.id}）`);
  }
}

async function runOverflowScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml(params),
    driver: epicThreeViewsOverflowDriverSource(),
    label: "epic-three-views-overflow",
  })) as OverflowResult | null;
  console.log(`EPIC_THREE_VIEWS_OVERFLOW_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "溢出探针应回传量取结果");

  /* ---- 列表：结构 + 层头取值 + 溢出 ---- */
  const list = result.wide.list;
  assert.deepEqual(
    list.epics.map((epic) => epic.code),
    ["KANB", "CNCL"],
    "列表 epic 章按登记序",
  );
  assert.deepEqual(
    list.phases.map((phase) => [phase.name, phase.parentEpic]),
    [
      ["KANB1", "KANB"],
      ["KANB2", "KANB"],
      ["CNCL1", "CNCL"],
    ],
    "列表期次组升序且归属正确",
  );
  assert.equal(list.epics[0]?.titleAttr, LONG_EPIC_TITLE, "F2：epic 层头长标题进原生 title");
  assert.equal(list.epics[1]?.layerStatus, "cancelled", "终态登记行落标注（CNCL）");
  const plw0Group = list.groups.find((group) => group.id === "plan:plan-boardv2-a");
  assert.deepEqual(
    [plw0Group?.epic, plw0Group?.phase],
    ["KANB", "KANB1"],
    "列表稿组落在 KANB1 容器内（跨视图同一归属）",
  );
  assertLayersFit(list, "列表（宽 1400）");

  /* ---- 表格：两级 colSpan 组行 + 溢出 ---- */
  const table = result.wide.table;
  assert.deepEqual(
    table.epics.map((epic) => epic.code),
    ["KANB", "CNCL"],
    "表格 epic 组行按登记序",
  );
  assert.deepEqual(
    table.phases.map((phase) => [phase.name, phase.parentEpic]),
    [
      ["KANB1", "KANB"],
      ["KANB2", "KANB"],
      ["CNCL1", "CNCL"],
    ],
    "表格期次组行升序且归属正确",
  );
  assert.equal(table.epics[0]?.titleAttr, LONG_EPIC_TITLE, "F2：表格层头长标题进原生 title");
  assert.ok(table.wrapper && table.table, "表格横滚容器与表格本体应可探");
  assertLayersFit(table, "表格（宽 1400）");

  /* ---- 看板：按列投影的层结构与计数 ---- */
  const columnExpectation: Record<string, { epics: string[]; phases: Array<[string, string]> }> = {
    待设计: { epics: [], phases: [] },
    待办: {
      epics: ["KANB", "CNCL"],
      phases: [
        ["KANB2", "KANB"],
        ["CNCL1", "CNCL"],
      ],
    },
    执行中: { epics: ["KANB"], phases: [["KANB1", "KANB"]] },
    审核中: { epics: ["KANB"], phases: [["KANB1", "KANB"]] },
    阻塞: { epics: [], phases: [] },
    已完成: { epics: ["KANB"], phases: [["KANB1", "KANB"]] },
    已取消: { epics: [], phases: [] },
  };
  assert.deepEqual(
    result.wide.kanban.columns.map((column) => column.stage),
    ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"],
    "七列骨架不变（容器只是列内装配）",
  );
  for (const column of result.wide.kanban.columns) {
    const expected = columnExpectation[column.stage];
    assert.ok(expected, `列 ${column.stage} 应在期望表内`);
    assert.deepEqual(
      column.epics.map((epic) => epic.code),
      expected.epics,
      `看板 ${column.stage} 列 epic 容器`,
    );
    assert.deepEqual(
      column.phases.map((phase) => [phase.name, phase.parentEpic]),
      expected.phases,
      `看板 ${column.stage} 列期次容器`,
    );
    assertLayersFit(
      { root: column.body, epics: column.epics, phases: column.phases, groups: column.groups },
      `看板 ${column.stage}（宽 1400）`,
      // 空列（无容器）合法：分组头行只在有承载的列要求可探（骨架七列恒在）。
      { requireGroups: expected.epics.length > 0 },
    );
  }
  const running = result.wide.kanban.columns.find((column) => column.stage === "执行中");
  assert.ok(running, "执行中列应在");
  assert.match(running.epics[0]?.titleAttr ?? "", /看板系统/, "F2：列内层头长标题进原生 title");
  const todo = result.wide.kanban.columns.find((column) => column.stage === "待办");
  assert.ok(todo);
  assert.equal(todo.epics[1]?.layerStatus, "cancelled", "列内终态标注（CNCL）");

  /* ---- 窄视口 360px：三视图容器头不得横向溢出（F5 探针补档） ---- */
  assertLayersFit(result.narrow.list, "列表（窄 360）");
  assertLayersFit(result.narrow.table, "表格（窄 360）");
  assertLayersFit(result.narrow.kanban, "看板（窄 360）");
  console.log(
    `EPIC_THREE_VIEWS_OVERFLOW_ASSERTIONS_OK 列表层头 ${list.epics.length + list.phases.length}；` +
      `表格层头 ${table.epics.length + table.phases.length}；` +
      `看板 ${result.wide.kanban.columns.length} 列（分层 ${result.wide.kanban.columns
        .map((column) => `${column.stage}:${column.epics.length}/${column.phases.length}`)
        .join(" ")}）`,
  );
}

async function runClickScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml(params),
    driver: epicThreeViewsClickDriverSource(),
    label: "epic-three-views-click",
    // F1 焦点可见性探针需要文档真有焦点（:focus-visible 才算数）——窗口显式置前。
    focusWindow: true,
  })) as ClickResult | null;
  console.log(`EPIC_THREE_VIEWS_CLICK_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "点击路由场景应回传量取结果");

  // 列表：epic/期次折叠往返 + 层头不落弹窗 + 稿组标题开弹窗 + 焦点可见（F1）。
  assert.equal(result.list.epicOpen.before, true, "列表 epic 章默认展开");
  assert.equal(result.list.epicOpen.after, false, "点列表 epic 章头 → 折叠（open 真变化）");
  assert.equal(result.list.epicOpen.again, true, "再点 → 展开（默认动作真的在跑）");
  assert.notEqual(
    rotationSignature(result.list.fold.expanded),
    "none | none",
    "列表展开态指示符旋转（group-open:rotate-90 产物类生效）",
  );
  assert.equal(
    rotationSignature(result.list.fold.collapsed),
    "none | none",
    "列表折叠态指示符不旋转",
  );
  assert.equal(result.list.dialogAfterEpicClick, false, "点列表层头不落弹窗（层不是卡）");
  assert.equal(result.list.phaseStillInDom, true, "折叠后子容器仍在 DOM（折叠不是消失）");
  assert.equal(result.list.phaseOpen.before, true, "列表期次组默认展开");
  assert.equal(result.list.phaseOpen.after, false, "点列表期次组头 → 折叠");
  assert.equal(result.list.phaseOpen.again, true, "再点 → 展开");
  assert.equal(result.list.dialogId, result.list.groupId, "点列表稿组标题 → 开的是该稿弹窗");

  // 看板：列内 epic/期次折叠往返 + 层头不落弹窗 + 特性组头开弹窗 + 焦点可见（F1）。
  assert.equal(result.kanban.epicOpen.before, true, "看板列内 epic 章默认展开");
  assert.equal(result.kanban.epicOpen.after, false, "点看板层头 → 折叠");
  assert.equal(result.kanban.epicOpen.again, true, "再点 → 展开");
  assert.equal(result.kanban.dialogAfterEpicClick, false, "点看板层头不落弹窗（层不是卡）");
  assert.equal(result.kanban.phaseStillInDom, true, "折叠后期次组仍在 DOM");
  assert.equal(result.kanban.phaseOpen.before, true, "看板期次组默认展开");
  assert.equal(result.kanban.phaseOpen.after, false, "点看板期次组头 → 折叠");
  assert.equal(result.kanban.phaseOpen.again, true, "再点 → 展开");
  assert.equal(result.kanban.dialogId, result.kanban.groupId, "点看板特性组头 → 开的是该稿弹窗");

  // 表格：层行不落弹窗；分组折叠按钮真折叠（子行条件渲染消失 + aria-expanded 同步）。
  assert.equal(result.table.dialogAfterLayerClick, false, "点表格层行不落弹窗（层不是卡）");
  assert.equal(result.table.expanded.before, "true", "表格分组默认展开");
  assert.equal(result.table.expanded.after, "false", "点分组折叠按钮 → aria-expanded=false");
  assert.equal(result.table.taskRowVisibleBefore, true, "折叠前组内任务行可见（对照组）");
  assert.equal(result.table.taskRowVisibleAfter, false, "折叠后子行条件渲染消失（不是 CSS 藏）");
  assert.equal(result.table.expanded.restored, "true", "再点 → 恢复展开（折叠往返可逆）");

  // F1（A4-1 第四绿移交）：键盘焦点可见性——聚焦后背景计算样式必须变化，失焦复原。
  for (const [label, probe] of [
    ["列表层头", result.list.focus],
    ["看板期次组头", result.kanban.focus],
    ["表格 role=button 落点", result.table.focus],
  ] as const) {
    assert.equal(probe.focusVisible, true, `${label}：聚焦后匹配 :focus-visible`);
    assert.equal(probe.changed, true, `${label}：焦点指示可见（背景变化，非 none 静默）`);
    assert.notEqual(probe.focusedBg, probe.blurredBg, `${label}：失焦复原（无残留焦点样式）`);
  }
  console.log(
    `EPIC_THREE_VIEWS_CLICK_ASSERTIONS_OK 列表 epic=${result.list.epicCode} ` +
      `折叠=${result.list.epicOpen.before}→${result.list.epicOpen.after}→${result.list.epicOpen.again}；` +
      `看板 epic=${result.kanban.epicCode} 折叠=${result.kanban.epicOpen.before}→${result.kanban.epicOpen.after}→${result.kanban.epicOpen.again}；` +
      `表格折叠=${result.table.expanded.before}→${result.table.expanded.after}→${result.table.expanded.restored}；` +
      `焦点可见=${result.list.focus.changed}/${result.kanban.focus.changed}/${result.table.focus.changed}`,
  );
}

async function main(): Promise<void> {
  const boardJson = buildFixtureBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["kanban", "list", "table"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  await runOverflowScenario({ css, boardJson, bundle });
  await runClickScenario({ css, boardJson, bundle });
  console.log("BOARD_EPIC_THREE_VIEWS_BROWSER_ASSERTIONS_OK");
}

await main();
