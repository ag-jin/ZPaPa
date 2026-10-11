/**
 * 卡 #89 / A4-3 折叠默认态 + 会话记忆的**页面内驱动**（与 `boardEpicGroupOrderBrowserDrivers.ts`
 * 同形态：驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本
 * `boardFoldBrowser.ts`）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 四视图默认态（真 DOM 的 `details.open` / `aria-expanded`）+ 真实指针点击（`<summary>` 默认动作、
 * 表格层折叠按钮的条件渲染）+ 会话记忆读回（`__BOARD_REMOUNT__` =「刷新/重开面板」）+ 宽窄两档
 * 溢出探针（含 tree 的 360 档——OB-1 补测）。
 *
 * 为什么真引擎量：默认态是 `<details>` 的原生属性与条件渲染结果（SSR 结构断言不构成行为证据）；
 * 折叠是 summary 默认动作与用户动作的交互结果；记忆读回必须经真实挂载/卸载。
 */
export function epicFoldDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(200);
  };
  const el = (scope, selector) => scope.querySelector(selector);
  const phaseOpen = (scope, name) => {
    const node = el(scope, '[data-board-phase-block="' + name + '"]');
    return node ? node.open : null;
  };
  const epicOpen = (scope, code) => {
    const node = el(scope, '[data-board-epic-block="' + code + '"]');
    return node ? node.open : null;
  };
  const aria = (scope, attr, id) => {
    const node = el(scope, "[" + attr + '="' + id + '"]');
    return node ? node.getAttribute("aria-expanded") : null;
  };
  const viewOf = (mode) => document.querySelector('[data-board-view="' + mode + '"]');
  /* 溢出探针：视图根 + 层盒 + 层头 + 层名（四视图同一判据；含 tree——OB-1）。 */
  const probe = (node) => (node ? probeOverflow(node) : null);
  const layerProbes = (view) => ({
    root: probe(view),
    phases: [...view.querySelectorAll("[data-board-phase-block]")].map((block) => ({
      name: block.getAttribute("data-board-phase-block"),
      block: probe(block),
      header: probe(el(block, "[data-board-phase-summary]")),
      layerName: probe(el(block, "[data-board-layer-name]")),
    })),
    epics: [...view.querySelectorAll("[data-board-epic-block]")].map((block) => ({
      name: block.getAttribute("data-board-epic-block"),
      block: probe(block),
      header: probe(el(block, "[data-board-epic-summary]")),
      layerName: probe(el(block, "[data-board-layer-name]")),
    })),
    tableRows: [...view.querySelectorAll("[data-board-table-group]")].map((row) => ({
      id: row.getAttribute("data-board-table-group"),
      block: probe(row),
    })),
  });

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  /* ---- 默认态（宽档；tree/list/kanban 是 <details> 原生态；table 走 tableDefaults 的 aria+条件渲染） ---- */
  const defaults = {};
  for (const mode of ["tree", "list", "kanban"]) {
    await switchToView(mode);
    await sleep(160);
    const view = viewOf(mode);
    defaults[mode] = {
      phases: {
        "KANB1": phaseOpen(view, "KANB1"),
        "KANB2": phaseOpen(view, "KANB2"),
        "DONE1": phaseOpen(view, "DONE1"),
        "DONE2": phaseOpen(view, "DONE2"),
      },
      epics: { KANB: epicOpen(view, "KANB"), DONE: epicOpen(view, "DONE") },
    };
  }
  /* 看板列内投影：已完成列的 KANB（承载全终态成员）折叠、DONE（含缺口成员）展开。 */
  await switchToView("kanban");
  const doneColumn = await waitFor(
    () => {
      const column = document.querySelector('[data-board-view="kanban"] [data-board-column="已完成"]');
      return column && column.querySelector("[data-board-epic-block]") ? column : null;
    },
    "已完成列容器",
  );
  const kanbanDoneColumn = {
    KANB: epicOpen(doneColumn, "KANB"),
    DONE: epicOpen(doneColumn, "DONE"),
    DONE1: phaseOpen(doneColumn, "DONE1"),
    DONE2: phaseOpen(doneColumn, "DONE2"),
  };
  /* 表格：层折叠是条件渲染（aria-expanded + 成员行在/不在 DOM）。 */
  await switchToView("table");
  await sleep(160);
  const table = viewOf("table");
  const tableDefaults = {
    kanb2: aria(table, "data-board-layer-toggle", "phase:KANB#2"),
    done1: aria(table, "data-board-layer-toggle", "phase:DONE#1"),
    done2: aria(table, "data-board-layer-toggle", "phase:DONE#2"),
    gapRowRendered: table.querySelector('[data-board-table-group="plan:fold-gap-terminal"]') !== null,
    kanb2RowRendered: table.querySelector('[data-board-table-group="plan:fold-done-b"]') !== null,
    doneUngroupedGroup: aria(table, "data-board-group-toggle", "spec:fold-done-ungrouped"),
    doneUngroupedRowRendered: table.querySelector('[data-board-card="task:308"]') !== null,
  };
  /* ---- 点击路由（真指针序列） ---- */
  /* 记忆快照（逐步留证：用户动作落键、挂载期默认态不落键）。 */
  const memorySteps = [{ label: "挂载+四视图浏览后", stored: sessionStorage.getItem("zcode-board-fold-state") }];
  /* ① 树形：KANB1 期次组头点击 → 收起（<summary> 默认动作）；层不是卡（不落弹窗）。 */
  await switchToView("tree");
  await sleep(140);
  const tree = viewOf("tree");
  const treeK1 = await waitFor(
    () => el(tree, '[data-board-phase-block="KANB1"]'),
    "树形 KANB1 期次组",
  );
  const treeK1Summary = el(treeK1, "[data-board-phase-summary]");
  dispatchPointerClick(treeK1Summary);
  await waitFor(() => treeK1.open === false, "点 KANB1 组头应收起");
  const treeAfterCollapse = {
    kanb1: treeK1.open,
    kanb2: phaseOpen(tree, "KANB2"),
    dialog: document.querySelector("[data-board-dialog]") !== null,
    childStillInDom: el(treeK1, '[data-board-feature-block="plan:fold-active"]') !== null,
  };
  memorySteps.push({ label: "树形收起 KANB1 后", stored: sessionStorage.getItem("zcode-board-fold-state") });
  /* ② 列表：KANB2 期次组头点击 → 展开（默认折叠的组被用户展开）。 */
  await switchToView("list");
  await sleep(140);
  const list = viewOf("list");
  const listK2 = await waitFor(() => el(list, '[data-board-phase-block="KANB2"]'), "列表 KANB2");
  dispatchPointerClick(el(listK2, "[data-board-phase-summary]"));
  await waitFor(() => listK2.open === true, "点 KANB2 组头应展开");
  memorySteps.push({ label: "列表展开 KANB2 后", stored: sessionStorage.getItem("zcode-board-fold-state") });
  /* ③ 表格：DONE1 层折叠按钮点击 → 展开 + 成员行回到 DOM（KANB2 已在列表步展开，避免同键二次翻转）。 */
  await switchToView("table");
  await sleep(140);
  const tableView2 = viewOf("table");
  const done1Toggle = await waitFor(
    () => el(tableView2, '[data-board-layer-toggle="phase:DONE#1"]'),
    "表格 DONE1 层折叠按钮",
  );
  dispatchPointerClick(done1Toggle);
  await waitFor(
    () => tableView2.querySelector('[data-board-table-group="plan:fold-done-c"]') !== null,
    "点表格 DONE1 层折叠按钮应展开并回渲染成员行",
  );
  const tableAfterToggle = {
    done1: aria(tableView2, "data-board-layer-toggle", "phase:DONE#1"),
    rowRendered: tableView2.querySelector('[data-board-table-group="plan:fold-done-c"]') !== null,
    dialog: document.querySelector("[data-board-dialog]") !== null,
  };
  memorySteps.push({ label: "表格展开 DONE1 后", stored: sessionStorage.getItem("zcode-board-fold-state") });
  const storedAfterToggles = sessionStorage.getItem("zcode-board-fold-state");
  /* ---- 跳转揭示：用户折叠含缺口卡的 epic → 提示条跳转先展开祖先层（表格条件渲染下必须走状态） ---- */
  const doneEpicToggle = await waitFor(
    () => el(tableView2, '[data-board-layer-toggle="epic:DONE"]'),
    "表格 DONE epic 层按钮",
  );
  dispatchPointerClick(doneEpicToggle);
  await waitFor(
    () => tableView2.querySelector('[data-board-table-group="plan:fold-gap-terminal"]') === null,
    "用户折叠 DONE 后缺口成员行不渲染",
  );
  const jump = await waitFor(
    () => document.querySelector('[data-board-attention-jump="unmerged-worktree"]'),
    "提示条未合并跳转按钮",
  );
  dispatchPointerClick(jump);
  await waitFor(
    () => tableView2.querySelector('[data-board-table-group="plan:fold-gap-terminal"]') !== null,
    "跳转揭示把祖先层展开，缺口卡回渲染面",
  );
  const reveal = {
    epicExpanded: aria(viewOf("table"), "data-board-layer-toggle", "epic:DONE"),
    phaseExpanded: aria(viewOf("table"), "data-board-layer-toggle", "phase:DONE#2"),
    rowRendered: viewOf("table").querySelector('[data-board-table-group="plan:fold-gap-terminal"]') !== null,
    highlighted:
      viewOf("table").querySelector('[data-board-card-highlight="true"]') !== null,
  };
  /* ---- 会话记忆读回（卸载重挂 = 刷新/重开面板） ---- */
  await setHostWidth(1400);
  globalThis.__BOARD_REMOUNT__();
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板重挂");
  await sleep(220);
  await switchToView("tree");
  await sleep(180);
  const treeAfterRemount = {
    kanb1: phaseOpen(viewOf("tree"), "KANB1"),
    kanb2: phaseOpen(viewOf("tree"), "KANB2"),
    done1: phaseOpen(viewOf("tree"), "DONE1"),
    ungroupedFeature: (() => {
      const node = el(viewOf("tree"), '[data-board-feature-block="spec:fold-done-ungrouped"]');
      return node ? node.open : null;
    })(),
  };
  await switchToView("table");
  await sleep(180);
  const tableAfterRemount = {
    kanb2: aria(viewOf("table"), "data-board-layer-toggle", "phase:KANB#2"),
    done1: aria(viewOf("table"), "data-board-layer-toggle", "phase:DONE#1"),
    done2: aria(viewOf("table"), "data-board-layer-toggle", "phase:DONE#2"),
  };
  /* ---- 溢出探针：宽 1400 与窄 360 两档，四视图（含 tree） ---- */
  const wide = {};
  await setHostWidth(1400);
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(150);
    wide[mode] = layerProbes(viewOf(mode));
  }
  const narrow = {};
  await setHostWidth(360);
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(220);
    narrow[mode] = layerProbes(viewOf(mode));
  }
  return {
    ua: navigator.userAgent,
    defaults,
    kanbanDoneColumn,
    tableDefaults,
    treeAfterCollapse,
    tableAfterToggle,
    storedAfterToggles,
    memorySteps,
    reveal,
    treeAfterRemount,
    tableAfterRemount,
    wide,
    narrow,
  };
})()`;
}
