/**
 * 卡 #54 两条浏览器断言的**页面内驱动**（与 `boardKanbanBrowserLayoutDrivers.ts` 同形态：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardV21BrowserScenarios.ts`）。
 *
 * 为什么必须真引擎：溢出（scrollWidth > clientWidth）与 `<summary>` 折叠路由都是**排版 + 默认动作**
 * 的行为，SSR 结构断言没有牙（#35-S1 二轮已实测过一次）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`（#55 S-8）：后续 UI 卡验证固定引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 场景一：溢出探针——看板分组头行（w-56 列内）与列容器都不得横向溢出；
 * 被截断的长徽章必须带 `title` 全文（截断≠信息丢失）。
 */
export function overflowProbeDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("kanban");
  const headers = await waitFor(
    () => {
      const found = [...document.querySelectorAll("[data-board-kanban-group-header]")];
      return found.length > 0 ? found : null;
    },
    "看板分组头",
  );
  await sleep(60);
  const groups = headers.map((header) => {
    const column = header.closest("[data-board-column]");
    return {
      featureId: header.getAttribute("data-board-kanban-group-header"),
      stage: column ? column.getAttribute("data-board-column") : null,
      lightweight: header.hasAttribute("data-board-group-lightweight"),
      header: probeOverflow(header),
      column: column ? probeOverflow(column) : null,
      cardCount: header.querySelector("[data-board-feature-card-count]")
        ? header.querySelector("[data-board-feature-card-count]").textContent
        : null,
      badgeCount: header.querySelectorAll("[data-board-attention]").length,
    };
  });
  const badges = [...document.querySelectorAll("[data-board-attention]")].map((badge) => ({
    code: badge.getAttribute("data-board-attention"),
    title: badge.getAttribute("title"),
    clientW: badge.clientWidth,
    scrollW: badge.scrollWidth,
    truncated: badge.scrollWidth > badge.clientWidth + 1,
    hasTitle: badge.hasAttribute("title"),
  }));
  return { ua: navigator.userAgent, groups, badges };
})()`;
}

/**
 * 场景二：列表组头点击路由——右区（计数/徽章）点击 = 折叠/展开；编号+名称区点击 = 开弹窗
 * 且不误触折叠（`preventDefaultOnClick` 的浏览器侧证据）。顺带量取折叠指示符的
 * computed transform（#55 S-3 的 `group-open:rotate-90` 只有真排版才量得出来）。
 */
export function listGroupHeaderClickDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("list");
  const details = await waitFor(() => document.querySelector("[data-board-list-group]"), "列表分组");
  const featureId = details.getAttribute("data-board-list-group");
  const countChip = details.querySelector("[data-board-feature-card-count]");
  const titleRegion = details.querySelector('[data-board-card="' + featureId + '"]');
  if (!countChip || !titleRegion) throw new Error("列表组头的计数区/标题区锚点缺失");
  const indicator = details.querySelector("[data-board-fold-indicator]");
  if (!indicator) throw new Error("列表折叠摘要应有指示符（#55 S-3）");
  // Tailwind v4 的 rotate-90 走独立 rotate 属性（不是 transform）：两个都量，判据在 Node 侧。
  const foldStyle = (el) => ({
    transform: getComputedStyle(el).transform,
    rotate: getComputedStyle(el).rotate,
  });
  const foldTransform = { initial: foldStyle(indicator), collapsed: null, expanded: null };
  const openStates = { before: details.open };
  dispatchPointerClick(countChip);
  await waitFor(() => details.open !== openStates.before, "点计数区后 open 态应变化");
  openStates.afterRightRegion = details.open;
  await sleep(250);
  foldTransform.collapsed = foldStyle(indicator);
  const dialogAfterCollapse = document.querySelector("[data-board-dialog]") !== null;
  dispatchPointerClick(countChip);
  await waitFor(() => details.open !== openStates.afterRightRegion, "再点计数区应回到相反态");
  openStates.afterRightRegionAgain = details.open;
  await sleep(250);
  foldTransform.expanded = foldStyle(indicator);
  dispatchPointerClick(titleRegion);
  const dialog = await waitFor(() => document.querySelector("[data-board-dialog]"), "点标题区应开弹窗");
  await sleep(60);
  openStates.afterTitleRegion = details.open;
  return {
    ua: navigator.userAgent,
    featureId,
    openStates,
    dialogId: dialog.getAttribute("data-board-dialog"),
    dialogAfterCollapse,
    countChipBox: { w: countChip.getBoundingClientRect().width },
    titleRegionBox: { w: titleRegion.getBoundingClientRect().width },
    foldTransform,
  };
})()`;
}
