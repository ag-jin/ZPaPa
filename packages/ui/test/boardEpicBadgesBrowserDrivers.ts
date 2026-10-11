/**
 * 卡 #90 / A4-4 组头徽章 + epic 弹窗的**页面内驱动**（与 `boardFoldBrowserDrivers.ts` 同形态：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardEpicBadgesBrowser.ts`）。
 *
 * 场景：四视图组头徽章（缺口/终态/计数）→ epic 层头标题区点击开弹窗（与折叠分区）→
 * 弹窗内 L2 rollup 与期次指针点击下钻（关弹窗 + 展开祖先 + 高亮落点）→ 关闭路径与焦点归还 →
 * 宽窄两档溢出探针（层头行 + 弹窗盒）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function epicBadgesDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(200);
  };
  const el = (scope, selector) => scope.querySelector(selector);
  const viewOf = (mode) => document.querySelector('[data-board-view="' + mode + '"]');
  const probe = (node) => (node ? probeOverflow(node) : null);
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  /* 组头徽章量取：层头行 / 层名 / 计数片 / 缺口徽章（值 + 文本 + 溢出）逐项。 */
  const epicHeaderRows = (view) =>
    [...view.querySelectorAll("[data-board-epic-summary]")].map((header) => {
      const planCount = el(header, "[data-board-layer-plan-count]");
      const phaseCount = el(header, "[data-board-layer-phase-count]");
      const gap = el(header, "[data-board-layer-gap-count]");
      const status = el(header, "[data-board-layer-status]");
      return {
        code: attr(header, "data-board-epic-summary"),
        planCount: attr(planCount, "data-board-layer-plan-count"),
        phaseCount: attr(phaseCount, "data-board-layer-phase-count"),
        gapCount: attr(gap, "data-board-layer-gap-count"),
        gapText: gap ? gap.textContent.trim() : null,
        status: status ? attr(status, "data-board-layer-status") : null,
        header: probe(header),
        layerName: probe(el(header, "[data-board-layer-name]")),
        planChip: probe(planCount),
        gapBadge: probe(gap),
      };
    });

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);

  /* ---- 1. 四视图组头徽章（真 DOM 值与文本；终态仅非活跃） ---- */
  const headers = {};
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(160);
    headers[mode] = epicHeaderRows(viewOf(mode));
  }

  /* ---- 2. epic 层头标题区点击 → 弹窗（树形；与折叠分区） ---- */
  await switchToView("tree");
  await sleep(160);
  const tree = viewOf("tree");
  const epicBlock = await waitFor(
    () => el(tree, '[data-board-epic-block="KANB"]'),
    "树形 KANB 章",
  );
  const titleRegion = await waitFor(
    () => el(tree, '[data-board-epic-open="KANB"]'),
    "KANB 层头标题区落点",
  );
  const epicOpenBefore = epicBlock.open;
  dispatchPointerClick(titleRegion);
  const dialog = await waitFor(
    () => document.querySelector("[data-board-epic-dialog]"),
    "epic 弹窗出现",
  );
  await sleep(60);
  const dialogBox = {
    code: attr(dialog, "data-board-epic-dialog"),
    role: attr(dialog, "role"),
    ariaModal: attr(dialog, "aria-modal"),
    layerName: attr(el(dialog, "[data-board-layer-name]"), "data-board-layer-name"),
    planCount: attr(el(dialog, "[data-board-layer-plan-count]"), "data-board-layer-plan-count"),
    phaseCount: attr(
      el(dialog, "[data-board-layer-phase-count]"),
      "data-board-layer-phase-count",
    ),
    gapCount: attr(el(dialog, "[data-board-layer-gap-count]"), "data-board-layer-gap-count"),
    status: attr(el(dialog, "[data-board-layer-status]"), "data-board-layer-status"),
    hasStageBadge: el(dialog, "[data-board-stage]") !== null,
    composition: [...dialog.querySelectorAll("[data-board-epic-dialog-stage]")].map((row) => ({
      stage: attr(row, "data-board-epic-dialog-stage"),
      text: row.textContent.trim(),
    })),
    compositionNone: [...dialog.querySelectorAll("[data-board-epic-dialog-stage-none]")].length,
    pointers: [...dialog.querySelectorAll("[data-board-epic-drill]")].map((button) => ({
      name: attr(button, "data-board-epic-drill"),
      label: attr(button, "aria-label"),
      text: button.textContent.trim(),
    })),
    cardDialogPresent: document.querySelector("[data-board-dialog]") !== null,
    epicStillOpen: epicBlock.open,
  };
  /* 关闭路径（×）与打开者焦点归还（#59 M4 纪律：epic 弹窗同款）。 */
  const closeButton = await waitFor(
    () => el(dialog, "[data-board-epic-dialog-close]"),
    "epic 弹窗关闭按钮",
  );
  dispatchPointerClick(closeButton);
  await waitFor(() => document.querySelector("[data-board-epic-dialog]") === null, "× 关弹窗");
  const focusAfterClose =
    document.activeElement === el(viewOf("tree"), '[data-board-epic-open="KANB"]');
  const closedAfterX = document.querySelector("[data-board-epic-dialog]") === null;

  /* ---- 3. 指针下钻：KANB1 指针 → 关弹窗 + 展开祖先 + 期次块高亮落点 ---- */
  /* 先由用户把 KANB1 收起（真点击 summary），下钻必须把两层祖先再展开。 */
  const phase1 = await waitFor(
    () => el(viewOf("tree"), '[data-board-phase-block="KANB1"]'),
    "树形 KANB1 期次块",
  );
  dispatchPointerClick(el(phase1, '[data-board-phase-summary="KANB1"]'));
  await waitFor(() => el(viewOf("tree"), '[data-board-phase-block="KANB1"]').open === false, "用户收起 KANB1");
  dispatchPointerClick(
    await waitFor(() => el(viewOf("tree"), '[data-board-epic-open="KANB"]'), "KANB 标题区（二次）"),
  );
  const dialog2 = await waitFor(
    () => document.querySelector("[data-board-epic-dialog]"),
    "epic 弹窗再次出现",
  );
  const pointerK1 = await waitFor(
    () => el(dialog2, '[data-board-epic-drill="KANB1"]'),
    "KANB1 指针",
  );
  dispatchPointerClick(pointerK1);
  await waitFor(() => document.querySelector("[data-board-epic-dialog]") === null, "下钻关弹窗");
  const phase1AfterDrill = await waitFor(
    () => {
      const block = el(viewOf("tree"), '[data-board-phase-block="KANB1"]');
      return block && block.open ? block : null;
    },
    "下钻展开 KANB1",
  );
  const drill = {
    dialogClosed: document.querySelector("[data-board-epic-dialog]") === null,
    phaseOpen: phase1AfterDrill.open,
    epicOpen: el(viewOf("tree"), '[data-board-epic-block="KANB"]').open,
    highlightedPhase: attr(phase1AfterDrill, "data-board-layer-highlight"),
    otherHighlighted: [...viewOf("tree").querySelectorAll("[data-board-layer-highlight]")].length,
  };

  /* ---- 4. 分区纪律：点 summary（非标题区）仍是折叠；不落弹窗 ---- */
  const epicBlock2 = el(viewOf("tree"), '[data-board-epic-block="KANB"]');
  const openBeforeSummaryClick = epicBlock2.open;
  dispatchPointerClick(el(epicBlock2, '[data-board-epic-summary="KANB"]'));
  await waitFor(() => epicBlock2.open !== openBeforeSummaryClick, "点 summary 折叠切换");
  const partition = {
    folded: epicBlock2.open,
    dialogAfterSummaryClick: document.querySelector("[data-board-epic-dialog]") !== null,
    cardDialogAfterSummaryClick: document.querySelector("[data-board-dialog]") !== null,
  };

  /* ---- 5. 溢出探针：宽 1400 / 窄 360，四视图层头行 + 弹窗盒 ---- */
  const wide = {};
  await setHostWidth(1400);
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(150);
    wide[mode] = epicHeaderRows(viewOf(mode));
  }
  const narrow = {};
  await setHostWidth(360);
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(220);
    narrow[mode] = epicHeaderRows(viewOf(mode));
  }
  /* 弹窗盒窄档探针（弹窗打开时量取：头行 / 指针行 / 盒体）。 */
  await setHostWidth(360);
  await switchToView("tree");
  await sleep(200);
  const titleRegionNarrow = await waitFor(
    () => el(viewOf("tree"), '[data-board-epic-open="KANB"]'),
    "窄档 KANB 标题区",
  );
  dispatchPointerClick(titleRegionNarrow);
  const dialogNarrow = await waitFor(
    () => document.querySelector("[data-board-epic-dialog]"),
    "窄档 epic 弹窗",
  );
  await sleep(80);
  const dialogNarrowProbes = {
    box: probe(dialogNarrow),
    header: probe(el(dialogNarrow, '[data-board-dialog-section="header"]')),
    composition: probe(el(dialogNarrow, '[data-board-dialog-section="composition"]')),
    phases: probe(el(dialogNarrow, '[data-board-dialog-section="phases"]')),
    pointer: probe(el(dialogNarrow, "[data-board-epic-drill]")),
  };

  return {
    ua: navigator.userAgent,
    headers,
    dialogBox,
    closedAfterX,
    focusAfterClose,
    drill,
    partition,
    wide,
    narrow,
    dialogNarrowProbes,
  };
})()`;
}
