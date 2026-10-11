/**
 * 指引面（guide 面）的**页面内驱动**（卡 #136 / C3-1；卡 #139 / C3-4 含量取进度胶囊百分比、
 * 计数胶囊与 rollup 缺口徽章；与 `boardEpicBadgesBrowserDrivers.ts` 同形态：驱动只做真 DOM 上的
 * 量取与真事件派发，判据（断言）留在被测脚本 `boardGuideBrowser.ts`）。
 *
 * 场景：切到指引面 → 量取五槽/计划区块/进度胶囊/计数胶囊/缺口徽章的渲染值（真 DOM）→
 * 宽 1400 / 窄 360 两档溢出探针 → 真指针点击计划内卡行 → 卡片弹窗 DOM 出现（点击路由派发
 * 后断言 DOM）。
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

  /* 五槽 + 计划区块的渲染值（真 DOM 与 SSR 对账用）。 */
  const readSlots = (root) =>
    [...root.querySelectorAll("[data-board-guide-slot]")].map((slot) => ({
      key: attr(slot, "data-board-guide-slot"),
      value: attr(slot, "data-board-guide-slot-value"),
      zero: attr(slot, "data-board-guide-zero"),
      text: slot.textContent.trim(),
      probe: probe(slot),
    }));
  const readPlans = (root) =>
    [...root.querySelectorAll("[data-board-guide-plan]")].map((plan) => {
      const progress = el(plan, "[data-board-guide-plan-progress]");
      const bar = el(plan, "[data-board-guide-plan-bar]");
      const barValue = attr(bar, "data-board-guide-plan-bar-value");
      const percent = el(plan, "[data-board-guide-plan-percent]");
      const chip = el(plan, "[data-board-guide-plan-card-count]");
      const gap = el(plan, "[data-board-guide-plan-gap-count]");
      const rows = [...plan.querySelectorAll("[data-board-guide-plan-frontier] [data-board-card]")];
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
    slots: readSlots(root),
    plans: readPlans(root),
  };

  /* 窄面（手机宽度档）：同一批落点复量——横向不得溢出。 */
  await setHostWidth(360);
  await sleep(220);
  const narrow = {
    rootProbe: probe(root),
    slotsProbe: probe(el(root, "[data-board-guide-slots]")),
    plans: readPlans(root),
  };
  await setHostWidth(1400);
  await sleep(220);

  /* 点击路由：真指针序列点计划内卡行 → 卡片弹窗 DOM 必须出现（点的是哪张，弹的就是哪张）。 */
  const targetId = "task:210";
  const cardRow = await waitFor(
    () => root.querySelector('[data-board-card="' + targetId + '"]'),
    "计划内卡行",
  );
  dispatchPointerClick(cardRow);
  const dialog = await waitFor(
    () => document.querySelector('[data-board-dialog="' + targetId + '"]'),
    "卡片弹窗出现",
  );
  await sleep(80);
  const dialogState = {
    id: attr(dialog, "data-board-dialog"),
    role: attr(dialog, "role"),
    ariaModal: attr(dialog, "aria-modal"),
    title: dialog.textContent.includes("置顶五槽条"),
    closes: null,
  };
  /* 关闭路径（×）：弹窗消失、焦点归还打开者（既有纪律，指引面走同一宿主链路）。 */
  const closeButton = el(dialog, "[data-board-dialog-close]");
  dispatchPointerClick(closeButton);
  await sleep(120);
  dialogState.closes = document.querySelector('[data-board-dialog="' + targetId + '"]') === null;
  const focusReturned = document.activeElement === cardRow;

  return {
    ua: navigator.userAgent,
    wide,
    narrow,
    dialog: dialogState,
    focusReturned,
  };
})();
`;
}
