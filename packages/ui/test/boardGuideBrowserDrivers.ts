/**
 * 指引面（guide 面）的**页面内驱动**（卡 #136 / C3-1；卡 #139 / C3-4 含量取进度胶囊百分比、
 * 计数胶囊与 rollup 缺口徽章；卡 #137 / C3-2 增槽下钻派发与零槽空态指引；与
 * `boardEpicBadgesBrowserDrivers.ts` 同形态：驱动只做真 DOM 上的量取与真事件派发，判据
 * （断言）留在被测脚本 `boardGuideBrowser.ts`）。
 *
 * 场景：切到指引面 → 量取五槽（含交互态）/计划区块/进度胶囊/计数胶囊/缺口徽章/可执行前沿队列
 * 行的渲染值（真 DOM）→ 宽 1400 / 窄 360 两档溢出探针（窄档另量槽条行数）→ 真指针点击队列行
 * （#138：两个计划各一张）→ 卡片弹窗 DOM 出现（点击路由派发后断言 DOM）→ 逐槽真指针点击 →
 * 断落到哪个既有视图/过滤（指针与键盘两路）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function guideDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(220);
  };
  const el = (scope, selector) => (scope ? scope.querySelector(selector) : null);
  const probe = (node) => (node ? probeOverflow(node) : null);
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const guide = () => document.querySelector('[data-board-view="guide"]');
  const renderedView = () => attr(document.querySelector("[data-board-view]"), "data-board-view");
  const filterValue = (name) => {
    const control = document.querySelector('[data-board-filter="' + name + '"]');
    return control ? control.value : null;
  };
  /* 槽真指针下钻：切回指引面 → 点槽 → 量「落到了哪个视图/过滤」+ 落点视图根是否真在场。 */
  const drillSlot = async (key, mode) => {
    await switchToView("guide");
    const tile = await waitFor(
      () => document.querySelector('[data-board-guide-slot="' + key + '"]'),
      "槽 " + key,
    );
    if (mode === "keyboard") {
      tile.focus();
      tile.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    } else {
      dispatchPointerClick(tile);
    }
    await sleep(180);
    const view = renderedView();
    return {
      key,
      mode: mode || "pointer",
      view,
      /* 落点锚点在场的独立通道：不是只改了视图切换按钮的激活态。 */
      viewRootPresent: !!document.querySelector('[data-board-view="' + view + '"]'),
      stage: filterValue("stage"),
      sort: filterValue("sort"),
      /* 落点内容：该视图里真渲染出的卡锚点（判据在 Node 侧，对板夹具断言）。 */
      cards: [...document.querySelectorAll('[data-board-view="' + view + '"] [data-board-card]')].map(
        (node) => attr(node, "data-board-card"),
      ),
    };
  };

  /* 五槽 + 计划区块的渲染值（真 DOM 与 SSR 对账用）。 */
  const readSlots = (root) =>
    [...root.querySelectorAll("[data-board-guide-slot]")].map((slot) => ({
      key: attr(slot, "data-board-guide-slot"),
      value: attr(slot, "data-board-guide-slot-value"),
      zero: attr(slot, "data-board-guide-zero"),
      role: attr(slot, "role"),
      tabIndex: attr(slot, "tabindex"),
      text: slot.textContent.trim(),
      probe: probe(slot),
    }));
  /* 窄档槽条行数：按槽卡顶坐标去重（P3-4 登记项的量法；真排版，非推演）。 */
  const readSlotRows = (root) =>
    new Set(
      [...root.querySelectorAll("[data-board-guide-slot]")].map((node) =>
        Math.round(node.getBoundingClientRect().top),
      ),
    ).size;
  const readPlans = (root) =>
    [...root.querySelectorAll("[data-board-guide-plan]")].map((plan) => {
      const progress = el(plan, "[data-board-guide-plan-progress]");
      const bar = el(plan, "[data-board-guide-plan-bar]");
      const barValue = attr(bar, "data-board-guide-plan-bar-value");
      const percent = el(plan, "[data-board-guide-plan-percent]");
      const chip = el(plan, "[data-board-guide-plan-card-count]");
      const gap = el(plan, "[data-board-guide-plan-gap-count]");
      const rows = [...plan.querySelectorAll("[data-board-guide-plan-queue] [data-board-card]")];
      const empty = el(plan, "[data-board-guide-queue-empty]");
      return {
        id: attr(plan, "data-board-guide-plan"),
        progress: attr(progress, "data-board-guide-plan-progress"),
        barValue,
        percent: attr(percent, "data-board-guide-plan-percent"),
        percentText: percent ? percent.textContent.trim() : null,
        cardCount: attr(chip, "data-board-guide-plan-card-count"),
        cardCountText: chip ? chip.textContent.trim() : null,
        gapCount: attr(gap, "data-board-guide-plan-gap-count"),
        gapText: gap ? gap.textContent.trim() : null,
        summary: el(plan, "[data-board-guide-plan-summary]")?.textContent.trim() ?? null,
        cardIds: rows.map((row) => attr(row, "data-board-card")),
        /* 队列行量取（#138）：处置指引（接手位）真 DOM 值 + 行可点态；#181 依赖徽章整处移除
           —— depsBadge = 徽章锚点在场性（应为 false，恢复即咬）。 */
        rows: rows.map((row) => {
          const next = el(row, "[data-board-guide-queue-next]");
          const deps = el(row, "[data-board-guide-queue-deps]");
          return {
            id: attr(row, "data-board-card"),
            title: attr(el(row, "span[title]"), "title"),
            next: next ? next.textContent.trim() : null,
            nextValue: attr(next, "data-board-guide-queue-next"),
            depsBadge: deps !== null,
            role: attr(row, "role"),
            tabIndex: attr(row, "tabindex"),
            probe: probe(row),
          };
        }),
        queueEmpty: empty ? empty.textContent.trim() : null,
        probe: probe(plan),
        capsuleProbe: probe(progress),
        chipProbe: probe(chip),
        gapProbe: probe(gap),
        rowProbes: rows.map((row) => probe(row)),
      };
    });

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  await switchToView("guide");
  const root = await waitFor(guide, "指引面渲染");
  await sleep(160);
  const wide = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    slotRows: readSlotRows(root),
    slots: readSlots(root),
    plans: readPlans(root),
  };

  /* 窄面（手机宽度档）：同一批落点复量——横向不得溢出；槽条行数（P3-4 登记项）真量。 */
  await setHostWidth(360);
  await sleep(220);
  const narrow = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    slotRows: readSlotRows(root),
    plans: readPlans(root),
  };
  await setHostWidth(1400);
  await sleep(220);

  /* 点击路由（#138 队列行 = L2 下钻）：真指针序列点队列行 → 卡片弹窗 DOM 必须出现
     （点的是哪张，弹的就是哪张）；两个计划的队列行各点一张。 */
  const clickQueueRow = async (targetId) => {
    const row = await waitFor(
      () => root.querySelector('[data-board-guide-plan-queue] [data-board-card="' + targetId + '"]'),
      "队列行 " + targetId,
    );
    dispatchPointerClick(row);
    const dialog = await waitFor(
      () => document.querySelector('[data-board-dialog="' + targetId + '"]'),
      "卡片弹窗出现 " + targetId,
    );
    await sleep(80);
    const state = {
      id: attr(dialog, "data-board-dialog"),
      role: attr(dialog, "role"),
      ariaModal: attr(dialog, "aria-modal"),
      title: dialog.textContent.includes(targetId === "task:210" ? "置顶五槽条" : "微条用法"),
      closes: null,
      focusReturned: false,
    };
    /* 关闭路径（×）：弹窗消失、焦点归还打开者（既有纪律，指引面走同一宿主链路）。 */
    dispatchPointerClick(el(dialog, "[data-board-dialog-close]"));
    await sleep(120);
    state.closes = document.querySelector('[data-board-dialog="' + targetId + '"]') === null;
    state.focusReturned = document.activeElement === row;
    return state;
  };
  const dialogA = await clickQueueRow("task:210");
  const dialogB = await clickQueueRow("task:221");

  /* 槽下钻派发（卡 #137）：逐槽真指针点击 → 落到对应既有视图/过滤；末槽再走键盘（Enter）。 */
  const drills = [];
  for (const key of ["attention", "blocked", "running", "review", "recent"]) {
    drills.push(await drillSlot(key, "pointer"));
  }
  drills.push(await drillSlot("review", "keyboard"));

  return {
    ua: navigator.userAgent,
    wide,
    narrow,
    dialog: dialogA,
    dialogB,
    focusReturned: dialogA.focusReturned,
    drills,
  };
})();
`;
}

/**
 * 零槽场景的页面内驱动（卡 #137/C3-2 空态指引 + 反例）：全零派生板（`buildGuideZeroBoard`）
 * 上点**需处理**槽——派生合计为 0、节点自带 attention 码（自算会得非零），点击必须落到
 * 「空态指引」而不是任何视图跳转（视图根保持在 guide）。
 */
export function guideZeroDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  host.style.width = "1400px";
  await sleep(220);
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const renderedView = () => attr(document.querySelector("[data-board-view]"), "data-board-view");
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await switchToView("guide");
  const root = await waitFor(() => document.querySelector('[data-board-view="guide"]'), "指引面渲染");
  await sleep(160);
  const slotValues = [...root.querySelectorAll("[data-board-guide-slot]")].map((slot) => ({
    key: attr(slot, "data-board-guide-slot"),
    value: attr(slot, "data-board-guide-slot-value"),
    zero: attr(slot, "data-board-guide-zero"),
    role: attr(slot, "role"),
  }));
  const viewBefore = renderedView();
  /* 指针路：点需处理槽（派生 0）→ 不跳转、出空态指引。 */
  const attention = await waitFor(
    () => root.querySelector('[data-board-guide-slot="attention"]'),
    "需处理槽",
  );
  dispatchPointerClick(attention);
  await sleep(180);
  const hint = document.querySelector("[data-board-guide-slot-empty]");
  const pointer = {
    view: renderedView(),
    hintKey: attr(hint, "data-board-guide-slot-empty"),
    hintRole: attr(hint, "role"),
    hintText: hint ? hint.textContent.trim() : null,
  };
  /* 键盘路：Enter 激活同款派发（零槽仍不出视图跳转）。 */
  attention.focus();
  attention.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await sleep(160);
  const keyboard = { view: renderedView() };
  /* 非零槽对照同板不可得（全零板）——对照放在主场景，这里只报零态。 */
  return { ua: navigator.userAgent, viewBefore, slotValues, pointer, keyboard };
})();
`;
}
