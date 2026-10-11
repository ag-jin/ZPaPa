/**
 * 手机窄面（极窄档 <360）场景的**页面内驱动**（卡 #141 / C3-6；与
 * `boardGuideBrowserDrivers.ts` 同形态：驱动只做真 DOM 上的量取与真事件派发，判据（断言）
 * 留在被测脚本 `boardGuideNarrowBrowser.ts`）。
 *
 * 场景：切到指引面 → 宽档（1400）对照量取 → 375 档与 320 档复量（槽条行数、主信息截断/字号、
 * 计划头与队列行二次信息折行、命中区高度、逐件溢出探针）→ 320 档下**触摸类型**指针点击路由
 * 派发（队列行 → 既有卡片弹窗并关闭归还焦点；槽 → 既有下钻落点）。
 *
 * 触摸链用 `pointerType: "touch"` 的 pointerdown → pointerup + click（Chromium 触摸点的真实
 * 事件序列形态；kit 的 `dispatchPointerClick` 是鼠标链）——本卡断言「触摸输入也走同一条既有
 * 路由」，鼠标链证据由 `boardGuideBrowser.ts` 覆盖，不重复。
 *
 * 折行判据的量法：二次信息组（`data-board-guide-plan-meta` / `data-board-guide-queue-meta`）
 * 顶坐标晚于**标题**顶坐标 10px 以上 = 真换行（相对标题量，避免行高/居中把「零高元素」误判成
 * 独占行；同排时两者顶差 ≤2px，换行后 ≥25px）。真排版量取，不是类名推演。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function guideNarrowDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(240);
  };
  const el = (scope, selector) => (scope ? scope.querySelector(selector) : null);
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const probe = (node) => (node ? probeOverflow(node) : null);
  /* 截断判据（真排版）：内容宽超盒宽 1px 以上 = 省略号截断已生效。 */
  const truncated = (node) => (node ? node.scrollWidth > node.clientWidth + 1 : null);
  const fontSize = (node) => (node ? parseFloat(getComputedStyle(node).fontSize) : null);
  const topOf = (node) => (node ? Math.round(node.getBoundingClientRect().top) : null);
  /* 触摸类型点击链：pointerdown → pointerup → click（pointerType="touch"，真触摸输入形态）。 */
  const dispatchTouchTap = (node) => {
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const pointer = { ...base, pointerId: 11, pointerType: "touch", isPrimary: true, width: 2, height: 2 };
    node.dispatchEvent(new PointerEvent("pointerdown", pointer));
    node.dispatchEvent(new PointerEvent("pointerup", pointer));
    node.dispatchEvent(new MouseEvent("click", base));
  };
  /* 命中测试：中心点上的 elementFromPoint 是否落在该件（或其内部）。 */
  const hitTest = (node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    );
    return !!hit && (hit === node || node.contains(hit));
  };
  /* 一档宽度下的窄面量取：五槽（主信息截断/字号/命中区高度）+ 计划块（头行折行）+ 队列行。 */
  const readTier = (root) => {
    const slotNodes = [...root.querySelectorAll("[data-board-guide-slot]")];
    const slots = slotNodes.map((tile) => {
      const spans = tile.querySelectorAll("span");
      const label = spans[0] || null;
      const value = spans[1] || null;
      return {
        key: attr(tile, "data-board-guide-slot"),
        labelText: label ? label.textContent.trim() : null,
        valueText: value ? value.textContent.trim() : null,
        labelTruncated: truncated(label),
        valueTruncated: truncated(value),
        labelFontSize: fontSize(label),
        valueFontSize: fontSize(value),
        boxH: Math.round(tile.getBoundingClientRect().height),
        probe: probe(tile),
      };
    });
    const plans = [...root.querySelectorAll("[data-board-guide-plan]")].map((plan) => {
      const title = el(plan, "span[title]");
      const meta = el(plan, "[data-board-guide-plan-meta]");
      const rows = [
        ...plan.querySelectorAll("[data-board-guide-plan-queue] [data-board-card]"),
      ].map((row) => {
        const rowTitle = el(row, "span[title]");
        const rowMeta = el(row, "[data-board-guide-queue-meta]");
        const next = el(row, "[data-board-guide-queue-next]");
        const deps = el(row, "[data-board-guide-queue-deps]");
        const titleTop = topOf(rowTitle);
        const metaTop = topOf(rowMeta);
        return {
          id: attr(row, "data-board-card"),
          titleText: rowTitle ? rowTitle.textContent.trim() : null,
          titleAttr: attr(rowTitle, "title"),
          boxH: Math.round(row.getBoundingClientRect().height),
          /* 相对标题量折行（见函数头注）：同排顶差 ≤2px，换行 ≥25px。 */
          metaOnOwnLine: metaTop !== null && titleTop !== null ? metaTop - titleTop > 10 : false,
          depsCount: attr(deps, "data-board-guide-queue-deps"),
          nextText: next ? next.textContent.trim() : null,
          nextAttr: attr(next, "title"),
          nextValue: attr(next, "data-board-guide-queue-next"),
          nextTruncated: truncated(next),
          nextFontSize: fontSize(next),
          probe: probe(row),
        };
      });
      return {
        id: attr(plan, "data-board-guide-plan"),
        titleText: title ? title.textContent.trim() : null,
        metaOnOwnLine: (() => {
          const metaTop = topOf(meta);
          const titleTop = topOf(title);
          return metaTop !== null && titleTop !== null ? metaTop - titleTop > 10 : false;
        })(),
        metaProbe: probe(meta),
        rows,
        probe: probe(plan),
      };
    });
    return {
      slotRows: new Set(
        slotNodes.map((node) => Math.round(node.getBoundingClientRect().top)),
      ).size,
      slots,
      plans,
    };
  };

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  await switchToView("guide");
  const root = await waitFor(
    () => document.querySelector('[data-board-view="guide"]'),
    "指引面渲染",
  );
  await sleep(160);
  /* 宽档对照：窄面降级不得落到宽面（槽条单行/二次信息同排/行高紧凑）。 */
  const wide = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    ...readTier(root),
  };

  /* 375 档（常见手机宽）/ 320 档（极窄下限）：同一批落点复量。 */
  await setHostWidth(375);
  await sleep(220);
  const narrow375 = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    ...readTier(root),
  };
  await setHostWidth(320);
  await sleep(220);
  const narrow320 = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    ...readTier(root),
  };

  /* 触摸点击路由派发（320 档）：① 行 → 既有卡片弹窗（点哪张弹哪张、关闭归还焦点）；
     ② 槽 → 既有下钻落点。落点判据（落到哪个视图/哪张卡）留 Node 侧断言。 */
  const row221 = await waitFor(
    () =>
      root.querySelector(
        '[data-board-guide-plan-queue] [data-board-card="task:221"]',
      ),
    "窄面队列行 task:221",
  );
  row221.scrollIntoView({ block: "center" });
  await sleep(200);
  const rowHit = hitTest(row221);
  dispatchTouchTap(row221);
  const dialog = await waitFor(
    () => document.querySelector('[data-board-dialog="task:221"]'),
    "窄面触摸点击后的卡片弹窗",
  );
  await sleep(80);
  const tap = {
    hitIsRow: rowHit,
    id: attr(dialog, "data-board-dialog"),
    role: attr(dialog, "role"),
    dialogText: dialog.textContent,
    closes: null,
    focusReturned: false,
  };
  dispatchPointerClick(el(dialog, "[data-board-dialog-close]"));
  await sleep(140);
  tap.closes = document.querySelector('[data-board-dialog="task:221"]') === null;
  tap.focusReturned = document.activeElement === row221;

  const slotBlocked = await waitFor(
    () => root.querySelector('[data-board-guide-slot="blocked"]'),
    "窄面阻塞槽",
  );
  slotBlocked.scrollIntoView({ block: "center" });
  await sleep(200);
  const slotHit = hitTest(slotBlocked);
  dispatchTouchTap(slotBlocked);
  await sleep(240);
  const landedView = attr(document.querySelector("[data-board-view]"), "data-board-view");
  const slotRoute = {
    hitIsSlot: slotHit,
    view: landedView,
    cards: landedView
      ? [
          ...document.querySelectorAll(
            '[data-board-view="' + landedView + '"] [data-board-card]',
          ),
        ].map((node) => attr(node, "data-board-card"))
      : [],
  };

  return { ua: navigator.userAgent, wide, narrow375, narrow320, tap, slotRoute };
})();
`;
}
