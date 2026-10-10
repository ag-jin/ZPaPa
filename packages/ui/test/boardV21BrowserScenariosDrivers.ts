/**
 * 卡 #54 两条浏览器断言的**页面内驱动**（与 `boardKanbanBrowserLayoutDrivers.ts` 同形态：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardV21BrowserScenarios.ts`）。
 *
 * 为什么必须真引擎：溢出（scrollWidth > clientWidth）与 `<summary>` 折叠路由都是**排版 + 默认动作**
 * 的行为，SSR 结构断言没有牙（#35-S1 二轮已实测过一次）。
 */

/** 页面里共用的量取与事件原语（真 DOM；不重算业务判据）。 */
const DRIVER_PRELUDE = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, label, timeoutMs) => {
    const limit = Date.now() + (timeoutMs || 15000);
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > limit) throw new Error("等待超时：" + label);
      await sleep(25);
    }
  };
  const switchToView = async (mode) => {
    await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
    const option = await waitFor(
      () => document.querySelector('[data-board-view-option="' + mode + '"]'),
      "视图切换控件 " + mode,
    );
    option.click();
    await waitFor(() => document.querySelector('[data-board-view="' + mode + '"]'), "视图渲染 " + mode);
  };
  // 完整指针/点击序列：真用户路径（pointerdown → mousedown → pointerup → mouseup → click），
  // 不靠 el.click() 一步到位——summary 的默认动作（toggle）与卡片 onClick 都要在这条路径上被真触发。
  const dispatchPointerClick = (el) => {
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  };
`;

/**
 * 场景一：溢出探针——看板分组头行（w-56 列内）与列容器都不得横向溢出；
 * 被截断的长徽章必须带 `title` 全文（截断≠信息丢失）。
 */
export function overflowProbeDriverSource(): string {
  return `(async () => {
${DRIVER_PRELUDE}
  await switchToView("kanban");
  const headers = await waitFor(
    () => {
      const found = [...document.querySelectorAll("[data-board-kanban-group-header]")];
      return found.length > 0 ? found : null;
    },
    "看板分组头",
  );
  await sleep(60);
  const probe = (el) => ({
    clientW: el.clientWidth,
    scrollW: el.scrollWidth,
    overflows: el.scrollWidth > el.clientWidth + 1,
    box: { left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) },
  });
  const groups = headers.map((header) => {
    const column = header.closest("[data-board-column]");
    return {
      featureId: header.getAttribute("data-board-kanban-group-header"),
      stage: column ? column.getAttribute("data-board-column") : null,
      lightweight: header.hasAttribute("data-board-group-lightweight"),
      header: probe(header),
      column: column ? probe(column) : null,
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
 * 且不误触折叠（`preventDefaultOnClick` 的浏览器侧证据）。
 */
export function listGroupHeaderClickDriverSource(): string {
  return `(async () => {
${DRIVER_PRELUDE}
  await switchToView("list");
  const details = await waitFor(() => document.querySelector("[data-board-list-group]"), "列表分组");
  const featureId = details.getAttribute("data-board-list-group");
  const countChip = details.querySelector("[data-board-feature-card-count]");
  const titleRegion = details.querySelector('[data-board-card="' + featureId + '"]');
  if (!countChip || !titleRegion) throw new Error("列表组头的计数区/标题区锚点缺失");
  const openStates = { before: details.open };
  dispatchPointerClick(countChip);
  await waitFor(() => details.open !== openStates.before, "点计数区后 open 态应变化");
  openStates.afterRightRegion = details.open;
  const dialogAfterCollapse = document.querySelector("[data-board-dialog]") !== null;
  dispatchPointerClick(countChip);
  await waitFor(() => details.open !== openStates.afterRightRegion, "再点计数区应回到相反态");
  openStates.afterRightRegionAgain = details.open;
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
  };
})()`;
}
