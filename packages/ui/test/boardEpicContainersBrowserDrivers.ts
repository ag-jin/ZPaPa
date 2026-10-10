/**
 * 卡 #87 / A4-1 树形三层容器的**页面内驱动**（与 `boardV21BrowserScenariosDrivers.ts` 同形态：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardEpicContainersBrowser.ts`）。
 *
 * 为什么必须真引擎（UI 卡门禁）：容器头行的横向溢出（scrollWidth > clientWidth）是排版行为；
 * `<summary>` 的折叠默认动作与「epic 章头不是卡 → 点击不落弹窗」是**默认动作 + 事件路由**行为
 * ——SSR 结构断言没有牙。
 *
 * 页面内共用原语（sleep/waitFor/switchToView/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`（#55 S-8），本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 场景一：三层容器溢出探针——epic 章头行、期次组头行、容器盒（epic/期次）与稿块标题落点
 * 都不得横向溢出；层名/计数片取值一并量回（结构真值由 Node 侧判）。
 */
export function epicTreeOverflowDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("tree");
  const epic = await waitFor(() => document.querySelector("[data-board-epic-block]"), "epic 章");
  await sleep(80);
  const probeOrNull = (el) => (el ? probeOverflow(el) : null);
  const epicCode = epic.getAttribute("data-board-epic-block");
  const epicSummary = epic.querySelector("[data-board-epic-summary]");
  const epicLayerName = epic.querySelector("[data-board-layer-name]");
  const epicPlanChip = epic.querySelector("[data-board-layer-plan-count]");
  const epicPhaseChip = epic.querySelector("[data-board-layer-phase-count]");
  const phases = [...document.querySelectorAll("[data-board-phase-block]")].map((phase) => {
    const summary = phase.querySelector("[data-board-phase-summary]");
    const layerName = phase.querySelector("[data-board-layer-name]");
    const planChip = phase.querySelector("[data-board-layer-plan-count]");
    const parentEpic = phase.closest("[data-board-epic-block]");
    const featureIds = [...phase.querySelectorAll("[data-board-feature-block]")].map((block) =>
      block.getAttribute("data-board-feature-block"),
    );
    return {
      name: phase.getAttribute("data-board-phase-block"),
      parentEpic: parentEpic ? parentEpic.getAttribute("data-board-epic-block") : null,
      block: probeOrNull(phase),
      summary: probeOrNull(summary),
      layerName: layerName ? layerName.getAttribute("data-board-layer-name") : null,
      layerNameProbe: probeOrNull(layerName),
      planChip: planChip ? planChip.textContent : null,
      planChipProbe: probeOrNull(planChip),
      featureIds,
    };
  });
  const featureTitleRegions = [...document.querySelectorAll("[data-board-feature-block]")].map((block) => {
    const id = block.getAttribute("data-board-feature-block");
    return probeOrNull(block.querySelector('[data-board-card="' + id + '"]'));
  });
  return {
    ua: navigator.userAgent,
    tree: probeOrNull(document.querySelector('[data-board-view="tree"]')),
    epic: {
      code: epicCode,
      block: probeOrNull(epic),
      summary: probeOrNull(epicSummary),
      layerName: epicLayerName ? epicLayerName.getAttribute("data-board-layer-name") : null,
      layerNameProbe: probeOrNull(epicLayerName),
      // 计数片锚点不存在时给 null（判据在 Node 侧：缺片必须显式暴露成失败，不静默）。
      planChip: epicPlanChip ? epicPlanChip.textContent : null,
      planChipProbe: probeOrNull(epicPlanChip),
      phaseChip: epicPhaseChip ? epicPhaseChip.textContent : null,
      phaseChipProbe: probeOrNull(epicPhaseChip),
      titleText: epicSummary ? epicSummary.textContent : null,
    },
    layerNames: [...document.querySelectorAll("[data-board-layer-name]")].map((el) =>
      el.getAttribute("data-board-layer-name"),
    ),
    ungroupedFirst: (() => {
      const anchors = [...document.querySelectorAll("[data-board-feature-block], [data-board-epic-block]")].map(
        (el) =>
          el.hasAttribute("data-board-epic-block") ? "epic" : "feature",
      );
      const firstEpic = anchors.indexOf("epic");
      return firstEpic < 0 ? null : anchors.slice(0, firstEpic).every((kind) => kind === "feature");
    })(),
    phases,
    featureTitleRegions,
  };
})()`;
}

/**
 * 场景二：容器头点击/折叠路由——epic 章头与期次组头派发完整指针/点击序列后 `<details>.open`
 * 真变化（DOM 变化）；折叠指示符真旋转（Tailwind `group-open:rotate-90` 产物类）；**epic 不是卡**：
 * 点章头不落弹窗（退化形态）；稿块标题落点照旧开弹窗且不误触折叠（preventDefaultOnClick）。
 */
export function epicTreeClickDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("tree");
  const foldStyle = (el) => ({
    transform: getComputedStyle(el).transform,
    rotate: getComputedStyle(el).rotate,
  });
  const epic = await waitFor(() => document.querySelector("[data-board-epic-block]"), "epic 章");
  const epicSummary = epic.querySelector("[data-board-epic-summary]");
  const epicIndicator = epic.querySelector("[data-board-fold-indicator]");
  if (!epicSummary || !epicIndicator) throw new Error("epic 章头/折叠指示符锚点缺失");
  const epicOpen = { before: epic.open };
  const epicFold = { expanded: foldStyle(epicIndicator), collapsed: null };
  dispatchPointerClick(epicSummary);
  await waitFor(() => epic.open !== epicOpen.before, "点 epic 章头后 open 态应变化");
  epicOpen.after = epic.open;
  await sleep(250);
  epicFold.collapsed = foldStyle(epicIndicator);
  const dialogAfterEpicClick = document.querySelector("[data-board-dialog]") !== null;
  const phaseStillInDom = document.querySelector("[data-board-phase-block]") !== null;
  dispatchPointerClick(epicSummary);
  await waitFor(() => epic.open !== epicOpen.after, "再点 epic 章头应回到相反态");
  epicOpen.again = epic.open;

  const phase = await waitFor(() => document.querySelector("[data-board-phase-block]"), "期次组");
  const phaseSummary = phase.querySelector("[data-board-phase-summary]");
  if (!phaseSummary) throw new Error("期次组头锚点缺失");
  const phaseOpen = { before: phase.open };
  dispatchPointerClick(phaseSummary);
  await waitFor(() => phase.open !== phaseOpen.before, "点期次组头后 open 态应变化");
  phaseOpen.after = phase.open;
  const dialogAfterPhaseClick = document.querySelector("[data-board-dialog]") !== null;
  dispatchPointerClick(phaseSummary);
  await waitFor(() => phase.open !== phaseOpen.after, "再点期次组头应回到相反态");
  phaseOpen.again = phase.open;

  // 稿层路由（容器内）：编号 + 名称区 → 开弹窗且不折叠（与列表/树形既有口径一致）。
  const featureBlock = await waitFor(
    () => document.querySelector("[data-board-phase-block] [data-board-feature-block]"),
    "期次组内的稿块",
  );
  const featureId = featureBlock.getAttribute("data-board-feature-block");
  const titleRegion = featureBlock.querySelector('[data-board-card="' + featureId + '"]');
  if (!titleRegion) throw new Error("稿块标题落点缺失");
  const featureOpenBefore = featureBlock.open;
  dispatchPointerClick(titleRegion);
  const dialog = await waitFor(() => document.querySelector("[data-board-dialog]"), "点标题区应开弹窗");
  await sleep(60);
  return {
    ua: navigator.userAgent,
    epicCode: epic.getAttribute("data-board-epic-block"),
    epicOpen,
    epicFold,
    dialogAfterEpicClick,
    phaseStillInDom,
    phaseName: phase.getAttribute("data-board-phase-block"),
    phaseOpen,
    dialogAfterPhaseClick,
    featureId,
    dialogId: dialog.getAttribute("data-board-dialog"),
    featureOpenBefore,
    featureOpenAfter: featureBlock.open,
  };
})()`;
}
