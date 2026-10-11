/**
 * 卡片引用派发的**页面内驱动**（卡 #186；与 `boardGuideBrowserDrivers.ts` 同形态：驱动只做真 DOM
 * 上的量取与真事件派发，判据（断言）留在被测脚本 `boardCardDispatchBrowser.ts`）。
 *
 * 场景：切到指引面 → 真指针点队列行尾「派发此卡」→ 量输入框草稿（含卡引用、用户已输入内容保留、
 * 且不打开弹窗）→ 点队列行可点区开弹窗 → 量弹窗派发入口的位置/文案/可点态 → 真指针连点两次
 * （幂等：不堆第二份）→ 宽 1400 / 窄 360 两档溢出探针（弹窗盒 / 弹窗按钮 / 队列行 / 行按钮）→
 * 板文件读写计数（零写入金丝雀）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function cardDispatchDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(220);
  };
  const el = (scope, selector) => (scope ? scope.querySelector(selector) : null);
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const probe = (node) => (node ? probeOverflow(node) : null);
  const composerEditable = () => el(document, '[data-dispatch-composer] [contenteditable="true"]');
  const draftText = () => {
    const root = composerEditable();
    return root ? root.textContent : null;
  };
  const countOf = (text, needle) =>
    text && needle ? text.split(needle).length - 1 : 0;
  const queueRowFor = (cardId) =>
    [...document.querySelectorAll("[data-board-guide-queue-row]")].find(
      (row) => row.querySelector('[data-board-card="' + cardId + '"]'),
    ) || null;
  const dialogBox = () => document.querySelector("[data-board-dialog]");

  await switchToView("guide");
  /* 1) 队列行尾快捷：点按钮 → 草稿出现该卡引用（真 DOM 文本），且不打开弹窗。 */
  const row210 = await waitFor(() => queueRowFor("task:210"), "队列行 task:210");
  const rowButton = await waitFor(
    () => el(row210, "[data-board-guide-queue-dispatch]"),
    "队列行派发按钮",
  );
  const clickable = el(row210, "[data-board-card]");
  const queueRowMeasure = {
    dispatchIsSiblingOfClickable: !el(row210, "[data-board-card] [data-board-guide-queue-dispatch]"),
    clickableRole: attr(clickable, "role"),
    clickableTabIndex: attr(clickable, "tabindex"),
    rowProbe: probe(row210),
    buttonProbe: probe(rowButton),
  };
  dispatchPointerClick(rowButton);
  await sleep(300);
  const queueClick = {
    draftText: draftText(),
    dialogOpened: !!dialogBox(),
  };

  /* 2) 弹窗主入口：点可点区开弹窗（行下钻回归）→ 量入口位置/文案/可点态。 */
  const row220 = await waitFor(() => queueRowFor("task:220"), "队列行 task:220");
  dispatchPointerClick(el(row220, "[data-board-card]"));
  const dialogNode = await waitFor(() => dialogBox(), "卡片弹窗");
  const dialogButton = await waitFor(
    () => el(dialogNode, "[data-board-dialog-dispatch]"),
    "弹窗派发按钮",
  );
  const dialogMeasure = {
    cardId: attr(dialogNode, "data-board-dialog"),
    label: dialogButton.textContent.trim(),
    disabled: dialogButton.hasAttribute("disabled"),
    titleAttr: attr(dialogButton, "title"),
    inStatusRow: !!dialogButton.closest('[data-board-dialog-section="status"]'),
    inHeaderRow: !!dialogButton.closest('[data-board-dialog-section="header"]'),
    inBlockerRow: !!dialogButton.closest('[data-board-dialog-blocker]'),
    boxProbe: probe(dialogNode),
    buttonProbe: probe(dialogButton),
  };

  /* 3) 真指针点弹窗入口 → 草稿追加引用；再点一次 → 幂等（不堆第二份）。 */
  dispatchPointerClick(dialogButton);
  await sleep(300);
  const afterFirst = draftText();
  dispatchPointerClick(dialogButton);
  await sleep(300);
  const afterSecond = draftText();
  const dialogClick = {
    afterFirst,
    afterSecond,
    dialogStillOpen: !!dialogBox(),
    editable: attr(composerEditable(), "contenteditable"),
  };

  /* 4) 溢出探针：宽 1400 / 窄 360（弹窗 + 队列行两处入口）。 */
  const dialogWide = { boxProbe: probe(dialogBox()), buttonProbe: probe(el(dialogBox(), "[data-board-dialog-dispatch]")) };
  const rowWide = probe(queueRowFor("task:210"));
  await setHostWidth(360);
  const dialogNarrow = { boxProbe: probe(dialogBox()), buttonProbe: probe(el(dialogBox(), "[data-board-dialog-dispatch]")) };
  const narrowRow = queueRowFor("task:210");
  const rowNarrow = { rowProbe: probe(narrowRow), buttonProbe: probe(el(narrowRow, "[data-board-guide-queue-dispatch]")) };
  await setHostWidth(1400);

  /* 5) 板文件读写计数（零写入金丝雀）+ store 请求残留（消费后应清空）+ 现场文本。 */
  const pageProbe = globalThis.__CARD_DISPATCH_PROBE__
    ? globalThis.__CARD_DISPATCH_PROBE__()
    : null;
  return {
    queueRowMeasure,
    queueClick,
    dialogMeasure,
    dialogClick,
    probeState: pageProbe,
    finalDraftText: draftText(),
    probes: { dialogWide, dialogNarrow, rowWide, rowNarrow },
  };
})()`;
}
