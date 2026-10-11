/**
 * 卡 #168 / A4-1b 三视图（看板/列表/表格）三层容器的**页面内驱动**（与
 * `boardEpicContainersBrowserDrivers.ts` 同形态：驱动只做真 DOM 上的量取与真事件派发，
 * 判据（断言）留在被测脚本 `boardEpicThreeViewsBrowser.ts`）。
 *
 * 为什么必须真引擎（UI 卡门禁，2026-10-10 用户批准）：
 *   - 容器头行的横向溢出（scrollWidth > clientWidth）是排版行为（宽/窄两档视口都要量）；
 *   - `<summary>` 的折叠默认动作与「层不是卡 → 点击不落弹窗」是事件路由；
 *   - F1（A4-1 第四绿移交）的键盘焦点可见性是 :focus-visible 计算样式行为——SSR 量不到。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`（#55 S-8），本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 场景一：三视图三层容器溢出探针（宽 1400 / 窄 360 两档）+ 结构与层头量取。
 *
 * 结构收集按**文档序区间**（epic 块 → 其下期次块 → 其下分组）而不是 CSS 选择器嵌套：
 * 表格形态的层是 colSpan 组行（`<tbody>` 无法嵌套），文档序区间是四视图通用的判据形态。
 */
export function epicThreeViewsOverflowDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const probeOrNull = (el) => (el ? probeOverflow(el) : null);
  const attrOf = (el, name) => (el ? el.getAttribute(name) : null);
  const collectLayers = (scope) => {
    const els = [...scope.querySelectorAll(
      "[data-board-epic-block], [data-board-phase-block], [data-board-list-group], [data-board-kanban-group], [data-board-table-group]",
    )];
    const epics = [];
    const phases = [];
    const groups = [];
    let currentEpic = null;
    let currentPhase = null;
    for (const el of els) {
      if (el.hasAttribute("data-board-epic-block")) {
        currentEpic = {
          code: el.getAttribute("data-board-epic-block"),
          block: probeOrNull(el),
          row: probeOrNull(el.querySelector("tr")),
          cell: probeOrNull(el.querySelector("td")),
          summary: probeOrNull(el.querySelector("[data-board-epic-summary]")),
          layerName: probeOrNull(el.querySelector("[data-board-layer-name]")),
          planChip: probeOrNull(el.querySelector("[data-board-layer-plan-count]")),
          phaseChip: probeOrNull(el.querySelector("[data-board-layer-phase-count]")),
          layerStatus: attrOf(el.querySelector("[data-board-layer-status]"), "data-board-layer-status"),
          // F2：层头标题的原生 title（截断恢复路径——层不是卡，无弹窗查全文）。
          titleAttr: attrOf(el.querySelector("[data-board-epic-summary] [title]"), "title"),
        };
        epics.push(currentEpic);
        currentPhase = null;
        continue;
      }
      if (el.hasAttribute("data-board-phase-block")) {
        currentPhase = {
          name: el.getAttribute("data-board-phase-block"),
          parentEpic: currentEpic ? currentEpic.code : null,
          block: probeOrNull(el),
          row: probeOrNull(el.querySelector("tr")),
          cell: probeOrNull(el.querySelector("td")),
          summary: probeOrNull(el.querySelector("[data-board-phase-summary]")),
          layerName: probeOrNull(el.querySelector("[data-board-layer-name]")),
          planChip: probeOrNull(el.querySelector("[data-board-layer-plan-count]")),
        };
        phases.push(currentPhase);
        continue;
      }
      const id =
        el.getAttribute("data-board-list-group") ??
        el.getAttribute("data-board-kanban-group") ??
        el.getAttribute("data-board-table-group");
      const header =
        el.querySelector("[data-board-list-group-summary]") ??
        el.querySelector("[data-board-kanban-group-header]") ??
        el.querySelector("tr");
      groups.push({
        id,
        epic: currentEpic ? currentEpic.code : null,
        phase: currentPhase ? currentPhase.name : null,
        header: probeOrNull(header),
      });
    }
    return { root: probeOrNull(scope), epics, phases, groups };
  };
  const measureHostWidth = async (width) => {
    document.getElementById("host").style.width = width + "px";
    await sleep(180);
  };
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await measureHostWidth(1400);
  const wide = {};
  for (const mode of ["kanban", "list", "table"]) {
    await switchToView(mode);
    await sleep(140);
    const view = document.querySelector('[data-board-view="' + mode + '"]');
    if (mode === "kanban") {
      wide.kanban = {
        columns: [...view.querySelectorAll("[data-board-column]")].map((col) => ({
          stage: col.getAttribute("data-board-column"),
          body: probeOrNull(col),
          ...collectLayers(col),
        })),
      };
    } else if (mode === "table") {
      const tableEl = view.querySelector("[data-board-table]");
      wide.table = {
        wrapper: probeOrNull(tableEl ? tableEl.parentElement : null),
        table: probeOrNull(tableEl),
        ...collectLayers(view),
      };
    } else {
      wide.list = collectLayers(view);
    }
  }
  const narrow = {};
  await measureHostWidth(360);
  for (const mode of ["list", "table", "kanban"]) {
    await switchToView(mode);
    await sleep(180);
    narrow[mode] = collectLayers(document.querySelector('[data-board-view="' + mode + '"]'));
  }
  return { ua: navigator.userAgent, wide, narrow };
})()`;
}

/**
 * 场景二：容器头点击/折叠路由 + F1 键盘焦点可见性。
 *
 * - 折叠路由：列表/看板的 epic、期次组头都是真 `<summary>` 默认动作（open 真变化、指示符真旋转、
 *   折叠后子容器仍在 DOM）；层头点击**不落弹窗**（层不是卡）；稿组标题落点照旧开弹窗。
 * - 表格：层行点击不落弹窗；特性分组折叠按钮真折叠（子行条件渲染消失、aria-expanded=false）。
 * - F1：对层头 summary / role=button 落点 `focus({ focusVisible: true })` 后计算背景色必须变化
 *   （全局 reset 清了 outline/box-shadow，焦点指示走背景——见 styles.css 的看板作用域规则）。
 */
export function epicThreeViewsClickDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const foldStyle = (el) => ({
    transform: getComputedStyle(el).transform,
    rotate: getComputedStyle(el).rotate,
  });
  const focusProbe = async (el) => {
    el.focus({ focusVisible: true });
    await sleep(60);
    const focusedBg = getComputedStyle(el).backgroundColor;
    const focusVisible = el.matches(":focus-visible");
    el.blur();
    await sleep(40);
    const blurredBg = getComputedStyle(el).backgroundColor;
    return { focusedBg, blurredBg, focusVisible, changed: focusedBg !== blurredBg };
  };
  const closeDialog = async () => {
    const close = document.querySelector("[data-board-dialog-close]");
    if (close) dispatchPointerClick(close);
    await sleep(80);
  };
  const result = { ua: navigator.userAgent };

  /* ---- 列表：epic/期次折叠往返 + 层头不落弹窗 + 稿组标题开弹窗 + 焦点可见 ---- */
  await switchToView("list");
  const listEpic = await waitFor(
    () => document.querySelector('[data-board-view="list"] [data-board-epic-block]'),
    "列表 epic 章",
  );
  const listEpicSummary = listEpic.querySelector("[data-board-epic-summary]");
  const listIndicator = listEpic.querySelector("[data-board-fold-indicator]");
  if (!listEpicSummary || !listIndicator) throw new Error("列表 epic 章头/指示符缺失");
  const listFocus = await focusProbe(listEpicSummary);
  const listEpicOpen = { before: listEpic.open };
  const listFoldExpanded = foldStyle(listIndicator);
  dispatchPointerClick(listEpicSummary);
  await waitFor(() => listEpic.open !== listEpicOpen.before, "点列表 epic 章头应折叠");
  listEpicOpen.after = listEpic.open;
  await sleep(220);
  const listFoldCollapsed = foldStyle(listIndicator);
  const dialogAfterListEpicClick = document.querySelector("[data-board-dialog]") !== null;
  const listPhaseStillInDom =
    document.querySelector('[data-board-view="list"] [data-board-phase-block]') !== null;
  dispatchPointerClick(listEpicSummary);
  await waitFor(() => listEpic.open === listEpicOpen.before, "再点应恢复展开");
  listEpicOpen.again = listEpic.open;

  const listPhase = document.querySelector('[data-board-view="list"] [data-board-phase-block]');
  const listPhaseSummary = listPhase.querySelector("[data-board-phase-summary]");
  const listPhaseOpen = { before: listPhase.open };
  dispatchPointerClick(listPhaseSummary);
  await waitFor(() => listPhase.open !== listPhaseOpen.before, "点列表期次组头应折叠");
  listPhaseOpen.after = listPhase.open;
  dispatchPointerClick(listPhaseSummary);
  await waitFor(() => listPhase.open === listPhaseOpen.before, "再点应恢复展开");
  listPhaseOpen.again = listPhase.open;

  const listGroupTitle = document.querySelector(
    '[data-board-view="list"] [data-board-list-group-summary] [data-board-card]',
  );
  if (!listGroupTitle) throw new Error("列表稿组标题落点缺失");
  const listGroupId = listGroupTitle.getAttribute("data-board-card");
  dispatchPointerClick(listGroupTitle);
  const listDialog = await waitFor(
    () => document.querySelector("[data-board-dialog]"),
    "点列表稿组标题应开弹窗",
  );
  result.list = {
    epicCode: listEpic.getAttribute("data-board-epic-block"),
    epicOpen: listEpicOpen,
    fold: { expanded: listFoldExpanded, collapsed: listFoldCollapsed },
    dialogAfterEpicClick: dialogAfterListEpicClick,
    phaseStillInDom: listPhaseStillInDom,
    phaseName: listPhase.getAttribute("data-board-phase-block"),
    phaseOpen: listPhaseOpen,
    groupId: listGroupId,
    dialogId: listDialog.getAttribute("data-board-dialog"),
    focus: listFocus,
  };
  await closeDialog();

  /* ---- 看板：epic/期次折叠往返 + 列内层头不落弹窗 + 特性组头开弹窗 + 焦点可见 ---- */
  await switchToView("kanban");
  const kanbanEpic = await waitFor(
    () => document.querySelector('[data-board-view="kanban"] [data-board-epic-block]'),
    "看板列内 epic 章",
  );
  const kanbanEpicSummary = kanbanEpic.querySelector("[data-board-epic-summary]");
  const kanbanIndicator = kanbanEpic.querySelector("[data-board-fold-indicator]");
  if (!kanbanEpicSummary || !kanbanIndicator) throw new Error("看板 epic 章头/指示符缺失");
  const kanbanEpicOpen = { before: kanbanEpic.open };
  const kanbanFoldExpanded = foldStyle(kanbanIndicator);
  dispatchPointerClick(kanbanEpicSummary);
  await waitFor(() => kanbanEpic.open !== kanbanEpicOpen.before, "点看板 epic 章头应折叠");
  kanbanEpicOpen.after = kanbanEpic.open;
  await sleep(220);
  const kanbanFoldCollapsed = foldStyle(kanbanIndicator);
  const dialogAfterKanbanEpicClick = document.querySelector("[data-board-dialog]") !== null;
  const kanbanPhaseStillInDom =
    document.querySelector('[data-board-view="kanban"] [data-board-phase-block]') !== null;
  dispatchPointerClick(kanbanEpicSummary);
  await waitFor(() => kanbanEpic.open === kanbanEpicOpen.before, "再点应恢复展开");
  kanbanEpicOpen.again = kanbanEpic.open;

  const kanbanPhase = document.querySelector('[data-board-view="kanban"] [data-board-phase-block]');
  const kanbanPhaseSummary = kanbanPhase.querySelector("[data-board-phase-summary]");
  const kanbanFocus = await focusProbe(kanbanPhaseSummary);
  const kanbanPhaseOpen = { before: kanbanPhase.open };
  dispatchPointerClick(kanbanPhaseSummary);
  await waitFor(() => kanbanPhase.open !== kanbanPhaseOpen.before, "点看板期次组头应折叠");
  kanbanPhaseOpen.after = kanbanPhase.open;
  dispatchPointerClick(kanbanPhaseSummary);
  await waitFor(() => kanbanPhase.open === kanbanPhaseOpen.before, "再点应恢复展开");
  kanbanPhaseOpen.again = kanbanPhase.open;

  const kanbanGroupHeader = document.querySelector(
    '[data-board-view="kanban"] [data-board-kanban-group-header]',
  );
  if (!kanbanGroupHeader) throw new Error("看板特性组头缺失");
  const kanbanGroupId = kanbanGroupHeader.getAttribute("data-board-kanban-group-header");
  dispatchPointerClick(kanbanGroupHeader);
  const kanbanDialog = await waitFor(
    () => document.querySelector("[data-board-dialog]"),
    "点看板特性组头应开弹窗",
  );
  result.kanban = {
    epicCode: kanbanEpic.getAttribute("data-board-epic-block"),
    epicOpen: kanbanEpicOpen,
    fold: { expanded: kanbanFoldExpanded, collapsed: kanbanFoldCollapsed },
    dialogAfterEpicClick: dialogAfterKanbanEpicClick,
    phaseStillInDom: kanbanPhaseStillInDom,
    phaseName: kanbanPhase.getAttribute("data-board-phase-block"),
    phaseOpen: kanbanPhaseOpen,
    groupId: kanbanGroupId,
    dialogId: kanbanDialog.getAttribute("data-board-dialog"),
    focus: kanbanFocus,
  };
  await closeDialog();

  /* ---- 表格：层行不落弹窗 + 分组折叠按钮真折叠 + role=button 落点焦点可见 ---- */
  await switchToView("table");
  const tableEpicRow = await waitFor(
    () => document.querySelector('[data-board-view="table"] [data-board-epic-summary]'),
    "表格 epic 组行",
  );
  dispatchPointerClick(tableEpicRow);
  await sleep(120);
  const dialogAfterTableLayerClick = document.querySelector("[data-board-dialog]") !== null;
  const tableToggle = document.querySelector('[data-board-view="table"] [data-board-group-toggle]');
  if (!tableToggle) throw new Error("表格分组折叠按钮缺失");
  const tableGroupId = tableToggle.getAttribute("data-board-group-toggle");
  const taskCardBefore = document.querySelector(
    '[data-board-view="table"] [data-board-card^="task:"]',
  );
  const taskCardId = taskCardBefore ? taskCardBefore.getAttribute("data-board-card") : null;
  const expandedBefore = tableToggle.getAttribute("aria-expanded");
  dispatchPointerClick(tableToggle);
  await sleep(120);
  const expandedAfter = tableToggle.getAttribute("aria-expanded");
  const taskCardAfter = taskCardId
    ? document.querySelector('[data-board-view="table"] [data-board-card="' + taskCardId + '"]')
    : null;
  const tableGroupTitle = document.querySelector(
    '[data-board-view="table"] [data-board-card="' + tableGroupId + '"]',
  );
  if (!tableGroupTitle) throw new Error("表格分组标题落点缺失");
  const tableFocus = await focusProbe(tableGroupTitle);
  dispatchPointerClick(tableToggle);
  await sleep(120);
  const expandedRestored = tableToggle.getAttribute("aria-expanded");
  result.table = {
    dialogAfterLayerClick: dialogAfterTableLayerClick,
    groupId: tableGroupId,
    expanded: { before: expandedBefore, after: expandedAfter, restored: expandedRestored },
    taskCardId,
    taskRowVisibleBefore: taskCardBefore !== null,
    taskRowVisibleAfter: taskCardAfter !== null,
    focus: tableFocus,
  };
  return result;
})()`;
}
