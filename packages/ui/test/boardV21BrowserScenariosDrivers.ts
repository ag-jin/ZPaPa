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
 * 场景一：溢出探针——看板分组头行（w-56 列内）、列容器与**列体 div**（#59 T-1）都不得横向溢出；
 * 被截断的长徽章必须带 `title` 全文（截断≠信息丢失）；执行角色徽记（#59 M3）在长 agent 名夹具下
 * 也必须被真截断（内层省略号 span）且不撑宽卡片。
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
  // #59 T-1：列体（[data-board-column] 的直接 div 子元素，即列头行与内容体）也要探。
  const columnBodies = [...document.querySelectorAll("[data-board-column] > div")].map((el) =>
    probeOverflow(el),
  );
  const badges = [...document.querySelectorAll("[data-board-attention]")].map((badge) => {
    const inner = badge.querySelector("[data-board-overflow-ellipsis]");
    return {
      code: badge.getAttribute("data-board-attention"),
      title: badge.getAttribute("title"),
      clientW: badge.clientWidth,
      scrollW: badge.scrollWidth,
      truncated: inner ? inner.scrollWidth > inner.clientWidth + 1 : badge.scrollWidth > badge.clientWidth + 1,
      hasTitle: badge.hasAttribute("title"),
    };
  });
  // #59 M3：执行角色徽记（长 agent 名防线的真排版证据）——量徽章自身、内层省略号与所在卡片。
  const roleBadges = [...document.querySelectorAll("[data-board-active-run]")].map((badge) => {
    const inner = badge.querySelector("[data-board-overflow-ellipsis]");
    const card = badge.closest("[data-board-kanban-card]");
    return {
      role: badge.getAttribute("data-board-active-run"),
      title: badge.getAttribute("title"),
      hasTitle: badge.hasAttribute("title"),
      hasClipGuard: badge.hasAttribute("data-board-overflow-clip"),
      innerTruncated: inner ? inner.scrollWidth > inner.clientWidth + 1 : false,
      card: card ? probeOverflow(card) : null,
    };
  });
  return { ua: navigator.userAgent, groups, columnBodies, badges, roleBadges };
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

/**
 * 场景三（#59 M1）：表格字号分层——主阅读列（标题/状态）text-ui-sm，弱元数据（卡龄/最近执行/
 * 时间戳）text-ui-xs；期望值由页面根上的 `--ui-font-size`（真 Tailwind 产物）现算，不写死。
 */
export function tableTypographyDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("table");
  await waitFor(() => document.querySelector('[data-board-cell="title"]'), "表格任务行");
  await sleep(60);
  const fontSize = (selector) => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).fontSize : null;
  };
  return {
    ua: navigator.userAgent,
    baseFontSize: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim(),
    title: fontSize('[data-board-cell="title"]'),
    status: fontSize('[data-board-cell="status"]'),
    lastRun: fontSize('[data-board-cell="lastRun"]'),
    updatedAt: fontSize('[data-board-cell="updatedAt"]'),
    age: fontSize('[data-board-cell="age"]'),
  };
})()`;
}

/**
 * 场景四（#59 M4）：弹窗焦点闭环——打开落点 = 关闭钮（autoFocus）；Shift+Tab 在首元素回绕到末元素、
 * Tab 在末元素回绕到首元素（合成键事件走 React onKeyDown，浏览器默认焦点移动不参与，观察值即
 * 我们的判定结果）；Esc 关闭后焦点恢复到打开者卡片。顺带量取阻碍条目圆角（#59 N1 = rounded-xl 12px）。
 */
export function dialogFocusDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("list");
  const card = await waitFor(() => document.querySelector('[data-board-card="task:7"]'), "任务卡 task:7");
  dispatchPointerClick(card);
  const dialog = await waitFor(() => document.querySelector("[data-board-dialog]"), "弹窗");
  const dialogId = dialog.getAttribute("data-board-dialog");
  await sleep(80);
  const describe = (el) =>
    el
      ? {
          tag: el.tagName,
          card: el.getAttribute("data-board-card"),
          close: el.hasAttribute("data-board-dialog-close"),
          jump: el.hasAttribute("data-board-dialog-jump"),
        }
      : null;
  const focusables = () =>
    [...dialog.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
  const activeAfterOpen = describe(document.activeElement);
  const list = focusables();
  list[0].focus();
  list[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  const activeAfterShiftTabFromFirst = describe(document.activeElement);
  const listAfter = focusables();
  listAfter[listAfter.length - 1].focus();
  listAfter[listAfter.length - 1].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  const activeAfterTabFromLast = describe(document.activeElement);
  const blockerRow = dialog.querySelector("[data-board-dialog-blocker]");
  const blockerRadius = blockerRow ? getComputedStyle(blockerRow).borderTopLeftRadius : null;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitFor(() => !document.querySelector("[data-board-dialog]"), "弹窗应关闭");
  await sleep(30);
  return {
    ua: navigator.userAgent,
    dialogId,
    focusableCount: list.length,
    activeAfterOpen,
    activeAfterShiftTabFromFirst,
    activeAfterTabFromLast,
    dialogClosed: !document.querySelector("[data-board-dialog]"),
    activeAfterClose: describe(document.activeElement),
    blockerRadius,
  };
})()`;
}

/**
 * 场景五（#65）：列表排序切换 + 会话记忆往返（真 DOM + 真事件 + 真 sessionStorage）。
 *
 * 为什么这么驱动：
 * - 排序控件是原生 `<select>`：真实「点开下拉再选一项」的弹层由操作系统/UA 实现，
 *   脚本无法合成那一次选择；因此**指针序列只用于打到控件本身（聚焦/点击的真路径）**，
 *   选择动作按浏览器标准路径落地：`select.value = …` + 派发 `change`（React 的 onChange 收到
 *   的就是这一个事件）——判据仍在 Node 侧（行序期望由夹具手推，不在页面里重算）。
 * - 会话记忆往返：`__BOARD_REMOUNT__`（harness 提供的重挂钩子）等价于「切侧边标签 → 面板卸载 →
 *   再打开」；重挂后视图模式与排序视角都从 sessionStorage 读回，行序必须与选择后一致。
 */
export function listSortDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("list");
  const rowIds = () =>
    [...document.querySelectorAll('[data-board-view="list"] [data-board-indent]')].map((row) =>
      row.getAttribute("data-board-card"),
    );
  await waitFor(() => rowIds().length > 0, "列表行");
  const select = () =>
    document.querySelector('[data-board-filter="sort"]');
  const initial = rowIds();
  let previousRows = initial;
  const selectSort = async (value) => {
    const el = select();
    if (!el) throw new Error("找不到排序控件");
    // 真用户先点到控件上（聚焦/点击路径）；再由 change 落地选择值（原生下拉弹层不可脚本合成）。
    dispatchPointerClick(el);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => select() && select().value === value, "排序控件取值 " + value);
    await waitFor(() => rowIds().join("|") !== previousRows.join("|"), "排序切换后行序应变化");
    await sleep(30);
    previousRows = rowIds();
    return {
      rows: previousRows,
      selectValue: select().value,
      stored: sessionStorage.getItem("zcode-board-list-sort"),
    };
  };
  const stage = await selectSort("stage");
  const oldest = await selectSort("oldest");
  // 重挂 = 面板卸载再打开（视图模式 list + 排序视角 oldest 都从会话记忆读回）。
  globalThis.__BOARD_REMOUNT__();
  await waitFor(() => document.querySelector('[data-board-view="list"]'), "重挂后应回到列表视图");
  await waitFor(() => rowIds().length > 0, "重挂后列表行");
  await sleep(30);
  return {
    ua: navigator.userAgent,
    initial,
    stageRows: stage.rows,
    stageStored: stage.stored,
    stageSelectValue: stage.selectValue,
    oldestRows: oldest.rows,
    oldestStored: oldest.stored,
    oldestSelectValue: oldest.selectValue,
    remountRows: rowIds(),
    remountSelectValue: select() ? select().value : null,
    remountStored: sessionStorage.getItem("zcode-board-list-sort"),
  };
})()`;
}
