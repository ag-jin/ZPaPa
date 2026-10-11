/**
 * 编排视图（`dispatch` 面，#185）的**页面内驱动**（与 `boardGuideBrowserDrivers.ts` 同形态：
 * 驱动只做真 DOM 量取与真事件派发，判据/断言留在被测脚本 `boardDispatchBrowser.ts`）。
 *
 * 场景：切到编排视图 → 量三区（可派清单/阻塞归因/并发组）的真 DOM 值（行序、域文本、原因文本、
 * 槽位计数行、区计数、行可点态）→ 宽 1400 / 窄 360 两档溢出探针（窄档另量行高触摸命中区）→
 * 真指针点可派行与阻塞行、键盘激活阻塞归因行 #107 → 既有卡片弹窗 DOM 必须出现（点的是哪张弹哪张）→
 * × 关闭后弹窗消失、焦点归还打开者。缺失场景（缺 `dispatch` 段）单独一个驱动：未就绪指向在场、
 * 三区零渲染、窄面不溢出。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function dispatchDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(220);
  };
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const probe = (node) => (node ? probeOverflow(node) : null);
  const text = (node) => (node ? node.textContent.trim() : null);
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  await switchToView("dispatch");
  const root = await waitFor(
    () => document.querySelector('[data-board-view="dispatch"]'),
    "编排视图渲染",
  );
  await sleep(160);
  const zoneRoot = (key) => root.querySelector('[data-board-dispatch-zone="' + key + '"]');
  /* 行量取：可派行与阻塞行共用（属性按锚点有无各自取；行高与溢出探针逐行）。 */
  const readRow = (node) => ({
    card: attr(node, "data-board-card"),
    no: attr(node, "data-board-dispatch-row") ?? attr(node, "data-board-dispatch-blocked"),
    kind: attr(node, "data-board-dispatch-blocked-kind"),
    by: attr(node, "data-board-dispatch-blocked-by"),
    targetInFlight: attr(node, "data-board-dispatch-blocked-target-inflight"),
    next: attr(node.querySelector("[data-board-dispatch-next]"), "data-board-dispatch-next"),
    domain: attr(node.querySelector("[data-board-dispatch-domain]"), "data-board-dispatch-domain"),
    domainUnknown: attr(
      node.querySelector("[data-board-dispatch-domain-unknown]"),
      "data-board-dispatch-domain-unknown",
    ),
    reason: text(node.querySelector("[data-board-dispatch-blocked-reason]")),
    title: attr(node.querySelector("span[title]"), "title"),
    role: attr(node, "role"),
    tabIndex: attr(node, "tabindex"),
    height: Math.round(node.getBoundingClientRect().height),
    probe: probe(node),
  });
  const readZone = (key) => {
    const zone = zoneRoot(key);
    const rows = [...zone.querySelectorAll("[data-board-dispatch-row], [data-board-dispatch-blocked]")];
    const members = [...zone.querySelectorAll("[data-board-dispatch-group-member]")];
    const capacity = zone.querySelector("[data-board-dispatch-capacity]");
    return {
      count: attr(zone.querySelector("[data-board-dispatch-zone-count]"), "data-board-dispatch-zone-count"),
      rows: rows.map(readRow),
      members: members.map((member) => ({
        no: attr(member, "data-board-dispatch-group-member"),
        card: attr(member, "data-board-card"),
        role: attr(member, "role"),
        tabIndex: attr(member, "tabindex"),
        probe: probe(member),
      })),
      empty: text(zone.querySelector("[data-board-dispatch-empty]")),
      capacity: capacity
        ? {
            value: attr(capacity, "data-board-dispatch-capacity"),
            inFlight: attr(capacity, "data-board-dispatch-inflight"),
            slotsFree: attr(capacity, "data-board-dispatch-slots-free"),
            text: text(capacity),
          }
        : null,
      probe: probe(zone),
    };
  };
  const readZones = () => ({
    state: attr(root, "data-board-dispatch-state"),
    recompile: !!root.querySelector("[data-board-dispatch-recompile]"),
    dispatchable: readZone("dispatchable"),
    blocked: readZone("blocked"),
    group: readZone("group"),
  });
  const wide = { rootProbe: probe(root), ...readZones() };

  /* 窄面（手机宽度档）：横向不得溢出；行高即触摸命中区（>=44px，UI 卡门禁真量）。 */
  await setHostWidth(360);
  await sleep(220);
  const narrow = { rootProbe: probe(root), ...readZones() };
  await setHostWidth(1400);
  await sleep(220);

  /* 点击路由派发：真指针点行 → 既有卡片弹窗 DOM（点的是哪张弹的就是哪张）；× 关闭 + 焦点归还。 */
  const clickRow = async (selector, label) => {
    const row = await waitFor(() => root.querySelector(selector), label);
    dispatchPointerClick(row);
    const cardId = attr(row, "data-board-card");
    const dialog = await waitFor(
      () => document.querySelector('[data-board-dialog="' + cardId + '"]'),
      "卡片弹窗出现 " + cardId,
    );
    await sleep(80);
    const state = {
      cardId,
      role: attr(dialog, "role"),
      ariaModal: attr(dialog, "aria-modal"),
      dialogText: dialog.textContent.trim().slice(0, 400),
      closes: null,
      focusReturned: false,
    };
    dispatchPointerClick(dialog.querySelector("[data-board-dialog-close]"));
    await sleep(120);
    state.closes = document.querySelector('[data-board-dialog="' + cardId + '"]') === null;
    state.focusReturned = document.activeElement === row;
    return state;
  };
  const dialogDispatchable = await clickRow(
    '[data-board-dispatch-zone="dispatchable"] [data-board-dispatch-row="102"]',
    "可派行 #102",
  );
  const dialogBlocked = await clickRow(
    '[data-board-dispatch-zone="blocked"] [data-board-dispatch-blocked="101"]',
    "阻塞行 #101",
  );

  /* 键盘路：阻塞归因行（同卡唯一锚点）Enter 激活 → 同一弹窗路由。 */
  const blockedRow = await waitFor(
    () => root.querySelector('[data-board-dispatch-zone="blocked"] [data-board-dispatch-blocked="107"]'),
    "阻塞行 #107",
  );
  blockedRow.focus();
  blockedRow.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  const dialogKeyboard = await waitFor(
    () => document.querySelector('[data-board-dialog="task:107"]'),
    "键盘激活弹窗 task:107",
  );
  await sleep(80);
  const keyboardBlocked = {
    cardId: attr(dialogKeyboard, "data-board-dialog"),
    opened: true,
    closes: null,
    focusReturned: false,
  };
  dispatchPointerClick(dialogKeyboard.querySelector("[data-board-dialog-close]"));
  await sleep(120);
  keyboardBlocked.closes = document.querySelector('[data-board-dialog="task:107"]') === null;
  keyboardBlocked.focusReturned = document.activeElement === blockedRow;

  return {
    ua: navigator.userAgent,
    wide,
    narrow,
    dialogDispatchable,
    dialogBlocked,
    keyboardBlocked,
  };
})();
`;
}

/** 缺失场景（缺 `dispatch` 段）：未就绪指向在场、三区零渲染、宽窄两档不溢出。 */
export function dispatchMissingDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const probe = (node) => (node ? probeOverflow(node) : null);
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  host.style.width = "1400px";
  await sleep(220);
  await switchToView("dispatch");
  const root = await waitFor(
    () => document.querySelector('[data-board-view="dispatch"]'),
    "编排视图渲染",
  );
  await sleep(160);
  const read = () => ({
    state: attr(root, "data-board-dispatch-state"),
    recompile: !!root.querySelector("[data-board-dispatch-recompile]"),
    recompileRole: attr(root.querySelector("[data-board-dispatch-recompile]"), "role"),
    recompileText: root.querySelector("[data-board-dispatch-recompile]")
      ? root.querySelector("[data-board-dispatch-recompile]").textContent.trim()
      : null,
    zoneCount: root.querySelectorAll("[data-board-dispatch-zone]").length,
    cardCount: root.querySelectorAll("[data-board-card]").length,
    probe: probe(root),
  });
  const wide = read();
  host.style.width = "360px";
  await sleep(220);
  const narrow = read();
  return { ua: navigator.userAgent, wide, narrow };
})();
`;
}
