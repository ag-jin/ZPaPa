/**
 * 卡片内容区块浏览器断言的**页面内驱动**（卡 #183；与 `boardFoldBrowserDrivers` 同形态：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardCardTextBrowser.ts`）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 场景（真引擎 + 真事件）：
 *   1. 点击路由：树形视图点卡 → 弹窗；卡片内容区块常驻且 `open === false`（默认折叠）；
 *   2. 展开态：真实指针点 summary → `open === true` 且正文几何可见（折叠态不可见是 DOM 事实）；
 *   3. 焦点序列：summary 参与弹窗 Tab 循环（从 summary 派发 Tab 不得被弹窗回绕逻辑吃掉）；
 *   4. 空值反例卡（无三字段）：区块照常在，三行显式「未携带」，无值节点、无他卡正文；
 *   5. 溢出探针：宽 1400 与窄 360 两档，弹窗盒/区块/值节点 `scrollWidth <= clientWidth`。
 */
export function cardTextDialogDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const cardTextOf = (dialog) => dialog.querySelector("[data-board-dialog-card-text]");
  const readDialog = (dialog) => {
    const section = cardTextOf(dialog);
    const summary = section ? section.querySelector("[data-board-dialog-card-text-summary]") : null;
    const body = section ? section.querySelector("div") : null;
    const probe = (node) => (node ? probeOverflow(node) : null);
    return {
      present: !!section,
      open: section ? section.open : null,
      summaryText: summary ? summary.textContent.trim() : null,
      allAbsent: !!(section && section.querySelector("[data-board-dialog-card-text-all-absent]")),
      valueCount: section ? section.querySelectorAll("[data-board-dialog-card-text-value]").length : -1,
      absentCount: section ? section.querySelectorAll("[data-board-dialog-card-text-absent]").length : -1,
      itemTexts: section ? [...section.querySelectorAll("[data-board-dialog-card-text-item]")].map((el) => el.textContent) : [],
      rowsPresent: Object.fromEntries(
        ["goal", "deliverables", "acceptance"].map((key) => [
          key,
          !!(section && section.querySelector('[data-board-dialog-card-text="' + key + '"]')),
        ]),
      ),
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
      dialogHeight: Math.round(dialog.getBoundingClientRect().height),
      text: section ? section.textContent : "",
      dialogOverflow: probe(dialog),
      sectionOverflow: probe(section),
      valueOverflows: section
        ? [...section.querySelectorAll("[data-board-dialog-card-text-value], [data-board-dialog-card-text-item]")].map(probe)
        : [],
    };
  };
  const openCard = async (id) => {
    const card = await waitFor(
      () => document.querySelector('[data-board-view="tree"] [data-board-card="' + id + '"]'),
      "树形卡片 " + id,
    );
    dispatchPointerClick(card);
    return await waitFor(() => document.querySelector('[data-board-dialog="' + id + '"]'), "弹窗 " + id);
  };
  const toggleSummary = async (dialog) => {
    const summary = cardTextOf(dialog).querySelector("[data-board-dialog-card-text-summary]");
    dispatchPointerClick(summary);
    await waitFor(() => cardTextOf(dialog).open === true, "卡片内容展开");
    return cardTextOf(dialog).open;
  };
  const closeDialog = async () => {
    dispatchPointerClick(document.querySelector("[data-board-dialog-close]"));
    await waitFor(() => !document.querySelector("[data-board-dialog]"), "弹窗关闭");
  };

  await switchToView("tree");

  /* 场景 1-3：有数据卡（#301）。 */
  const dialogA = await openCard("task:301");
  const wideBefore = readDialog(dialogA);
  const summaryA = cardTextOf(dialogA).querySelector("[data-board-dialog-card-text-summary]");
  summaryA.focus();
  const summaryFocused = document.activeElement === summaryA;
  const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  summaryA.dispatchEvent(tabEvent);
  const summaryTabPrevented = tabEvent.defaultPrevented;
  const focusAfterSummaryTab = document.activeElement === summaryA ? "summary" : "moved";
  const wideOpenAfterToggle = await toggleSummary(dialogA);
  const wideAfter = readDialog(dialogA);
  await closeDialog();

  /* 场景 4：空值反例卡（#302）。 */
  const dialogB = await openCard("task:302");
  const emptyBefore = readDialog(dialogB);
  const emptyOpenAfterToggle = await toggleSummary(dialogB);
  const emptyAfter = readDialog(dialogB);
  await closeDialog();

  /* 场景 5：窄档 360。 */
  host.style.width = "360px";
  await sleep(200);
  const dialogC = await openCard("task:301");
  const narrowBefore = readDialog(dialogC);
  const narrowOpenAfterToggle = await toggleSummary(dialogC);
  const narrowAfter = readDialog(dialogC);
  await closeDialog();

  return {
    ua: navigator.userAgent,
    summaryFocused,
    summaryTabPrevented,
    focusAfterSummaryTab,
    wide: { before: wideBefore, openAfterToggle: wideOpenAfterToggle, after: wideAfter },
    empty: { before: emptyBefore, openAfterToggle: emptyOpenAfterToggle, after: emptyAfter },
    narrow: { before: narrowBefore, openAfterToggle: narrowOpenAfterToggle, after: narrowAfter },
  };
})()`;
}
