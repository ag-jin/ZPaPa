/**
 * 卡 #88 / A4-2 组序（纯期次序）的**页面内驱动**（与 `boardEpicThreeViewsBrowserDrivers.ts`
 * 同形态：驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本
 * `boardEpicGroupOrderBrowser.ts`）。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`（#55 S-8），本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 四视图期次组头的**文档序**（缺口在 phase 2、文档序乱序、含两位数 phase 10 的反例夹具）逐视图
 * 量取；顺手量取同夹具下的容器头溢出（宽 1400 / 窄 360）与层头点击路由（列表 KANB2 组头真折叠；
 * 交互后组序不变、子容器仍在 DOM）。
 *
 * 为什么真引擎量：组序的可见形态 = 真 DOM 里的节点顺序（SSR 结构断言不构成行为证据）；
 * 溢出与 `<summary>` 折叠默认动作同场景一并覆盖（UI 卡门禁）。
 */
export function epicGroupOrderDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const probeOrNull = (el) => (el ? probeOverflow(el) : null);
  const phaseNames = (scope) =>
    [...scope.querySelectorAll("[data-board-phase-block]")].map((el) =>
      el.getAttribute("data-board-phase-block"),
    );
  const collect = (view) => ({
    root: probeOrNull(view),
    order: phaseNames(view),
    rows: [...view.querySelectorAll("[data-board-phase-block]")].map((el) => ({
      name: el.getAttribute("data-board-phase-block"),
      block: probeOrNull(el),
      header: probeOrNull(el.querySelector("[data-board-phase-summary]")),
      layerName: probeOrNull(el.querySelector("[data-board-layer-name]")),
    })),
  });
  const measureHostWidth = async (width) => {
    document.getElementById("host").style.width = width + "px";
    await sleep(180);
  };
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await measureHostWidth(1400);
  const wide = {};
  for (const mode of ["tree", "list", "kanban", "table"]) {
    await switchToView(mode);
    await sleep(140);
    wide[mode] = collect(document.querySelector('[data-board-view="' + mode + '"]'));
  }
  /* ---- 层头点击路由（真指针序列）：折叠真发生、层不是卡（不落弹窗）、组序不因交互改动 ---- */
  await switchToView("list");
  const listK2 = await waitFor(
    () => document.querySelector('[data-board-view="list"] [data-board-phase-block="KANB2"]'),
    "列表 KANB2 期次组",
  );
  const k2Summary = listK2.querySelector("[data-board-phase-summary]");
  if (!k2Summary) throw new Error("KANB2 期次组头缺失");
  const openBefore = listK2.open;
  dispatchPointerClick(k2Summary);
  await waitFor(() => listK2.open !== openBefore, "点 KANB2 组头应折叠");
  const openAfter = listK2.open;
  const orderAfterCollapse = phaseNames(document.querySelector('[data-board-view="list"]'));
  const phaseStillInDom =
    document.querySelector('[data-board-view="list"] [data-board-phase-block="KANB10"]') !== null;
  dispatchPointerClick(k2Summary);
  await waitFor(() => listK2.open === openBefore, "再点应恢复展开");
  const orderAfterExpand = phaseNames(document.querySelector('[data-board-view="list"]'));
  const dialogAfterLayerClick = document.querySelector("[data-board-dialog]") !== null;
  /* ---- 窄视口 360px：容器头不得横向溢出（#89/A4-3 补 tree——OB-1：此前只量 list/table/kanban） ---- */
  const narrow = {};
  await measureHostWidth(360);
  for (const mode of ["tree", "list", "table", "kanban"]) {
    await switchToView(mode);
    await sleep(180);
    narrow[mode] = collect(document.querySelector('[data-board-view="' + mode + '"]'));
  }
  /* ---- 切视图往返后再量一次列表：组序在会话内稳定（不因重挂/切视图漂移） ---- */
  await measureHostWidth(1400);
  await switchToView("list");
  await sleep(140);
  const listRecheck = collect(document.querySelector('[data-board-view="list"]'));
  return {
    ua: navigator.userAgent,
    wide,
    narrow,
    listRecheck,
    click: {
      openBefore,
      openAfter,
      orderAfterCollapse,
      orderAfterExpand,
      phaseStillInDom,
      dialogAfterLayerClick,
    },
  };
})()`;
}
