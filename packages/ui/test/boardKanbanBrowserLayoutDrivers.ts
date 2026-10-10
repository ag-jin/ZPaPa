/**
 * 「看板真实布局缝」断言的页面内驱动（评审 #35-S1 二轮）——被
 * `boardKanbanBrowserLayout.ts` 使用。驱动在真 DOM 上跑量取与真点击，判据（断言）留在被测脚本里。
 *
 * 两个驱动共用一个原语集：`waitFor`（等真渲染/真提交，不 sleep 猜时长）、`rectOf`（几何）、
 * `measureColumn`/`measureRow`（列与行的量取）、`switchToKanban`（真点视图切换，不依赖 storage）。
 * `contentHeightOf` 是本层的**独立量法**：子元素高之和 + 行间距 + padding——不读 `scrollHeight`
 * （列体被撑坏时它会跟着虚高，用它会变成「用坏结果验证坏结果」）。
 */
import { STAGES } from "./boardKanbanBrowserLayoutHarness.js";

/** 页面里共用的量取原语（真 DOM 上跑；内容高用独立量法，不读坏法下会虚高的 scrollHeight）。 */
const DRIVER_PRELUDE = `
  const STAGES = ${JSON.stringify(STAGES)};
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
  const int = (n) => Math.round(n);
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { top: int(r.top), bottom: int(r.bottom), left: int(r.left), right: int(r.right), h: int(r.height), w: int(r.width) };
  };
  const columnOf = (stage) => document.querySelector('[data-board-column="' + stage + '"]');
  const bodyOf = (stage) => { const col = columnOf(stage); return col ? col.querySelector(".overflow-y-auto") : null; };
  const toggleOf = (stage) => { const col = columnOf(stage); return col ? col.querySelector('[data-board-column-toggle="' + stage + '"]') : null; };
  // 独立量法：子元素高之和 + 行间距 + 上下 padding。**不读 body.scrollHeight**——坏法下列体被撑高，scrollHeight 跟着虚高。
  const contentHeightOf = (body) => {
    const style = getComputedStyle(body);
    const gap = parseFloat(style.rowGap || "0") || 0;
    const children = Array.from(body.children);
    const own = children.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
    return int(own + gap * Math.max(children.length - 1, 0) + (parseFloat(style.paddingTop || "0") || 0) + (parseFloat(style.paddingBottom || "0") || 0));
  };
  const measureColumn = (stage) => {
    const col = columnOf(stage);
    if (!col) return { stage: stage, missing: true };
    const body = bodyOf(stage);
    const toggle = toggleOf(stage);
    const header = col.firstElementChild;
    const colBox = rectOf(col);
    const bodyBox = body ? rectOf(body) : null;
    let bodyCanScroll = null;
    let bodyScrolledTo = null;
    if (body) {
      const before = body.scrollTop;
      body.scrollTop = 99999;
      bodyScrolledTo = body.scrollTop;
      body.scrollTop = before;
      bodyCanScroll = body.scrollHeight > body.clientHeight;
    }
    return {
      stage: stage,
      tag: col.tagName,
      display: getComputedStyle(col).display,
      ariaExpanded: toggle ? toggle.getAttribute("aria-expanded") : null,
      headerTag: header ? header.tagName : null,
      headerBox: header ? rectOf(header) : null,
      colBox: colBox,
      bodyBox: bodyBox,
      bodyClientH: body ? body.clientHeight : null,
      bodyScrollH: body ? body.scrollHeight : null,
      bodyCanScroll: bodyCanScroll,
      bodyScrolledTo: bodyScrolledTo,
      contentH: body ? contentHeightOf(body) : null,
      bodyOverflowsBox: bodyBox ? bodyBox.bottom > colBox.bottom + 1 : null,
      cardCount: col.querySelectorAll("[data-board-card]").length,
    };
  };
  const measureRow = () => {
    const anchor = document.querySelector("[data-board-column]");
    const row = anchor ? anchor.parentElement : null;
    if (!row) return { missing: true };
    return { box: rectOf(row), scrollH: row.scrollHeight, clientH: row.clientHeight };
  };
  // 走真实交互切到看板（不依赖 sessionStorage 记忆，页面上点一下最实在）。
  const switchToKanban = async () => {
    await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
    const option = await waitFor(() => document.querySelector('[data-board-view-option="kanban"]'), "视图切换控件");
    option.click();
    await waitFor(() => document.querySelector('[data-board-view="kanban"]'), "看板视图渲染");
  };
`;

/** 页面内驱动（全流程）：量取 → 真点击折叠/再展开 → 折叠后跳转揭示。 */
export function interactiveDriverSource(params: { targetCardId: string }): string {
  return `(async () => {
${DRIVER_PRELUDE}
  const TARGET_CARD_ID = ${JSON.stringify(params.targetCardId)};
  const snapshot = (label) => ({ label: label, row: measureRow(), columns: STAGES.map(measureColumn) });

  const result = { reveal: null, toggleMissing: false, measurements: [] };
  await switchToKanban();
  await waitFor(() => bodyOf("已完成") !== null && columnOf("已完成").querySelectorAll("[data-board-card]").length > 0, "已完成列与列体");
  await waitFor(() => bodyOf("待办") !== null, "待办列与列体");
  result.measurements.push(snapshot("expanded"));
  // 没有折叠按钮就到此为止：布局断言先说话（先量布局、再量交互，坏实现的失败点才落在布局上）。
  if (toggleOf("已完成") === null) {
    result.toggleMissing = true;
    return result;
  }

  toggleOf("已完成").click();
  await waitFor(() => toggleOf("已完成") && toggleOf("已完成").getAttribute("aria-expanded") === "false" && bodyOf("已完成") === null, "折叠态");
  result.measurements.push(snapshot("collapsed"));

  toggleOf("已完成").click();
  await waitFor(() => toggleOf("已完成") && toggleOf("已完成").getAttribute("aria-expanded") === "true" && bodyOf("已完成") !== null, "再展开");
  result.measurements.push(snapshot("re-expanded"));

  // 折叠后从提示条跳进已完成列：列必须先自动展开，落点才在 DOM 里、才谈得上高亮可见。
  toggleOf("已完成").click();
  await waitFor(() => toggleOf("已完成") && toggleOf("已完成").getAttribute("aria-expanded") === "false", "折叠态（跳转前）");
  const beforeJump = document.querySelector('[data-board-card="' + TARGET_CARD_ID + '"]');
  const jump = await waitFor(() => document.querySelector('[data-board-attention-jump="interrupted-resume"]'), "提示条跳转按钮");
  jump.click();
  await waitFor(() => toggleOf("已完成").getAttribute("aria-expanded") === "true" && document.querySelector('[data-board-card="' + TARGET_CARD_ID + '"]') !== null, "跳转后已完成列自动展开 + 落点回 DOM");
  await sleep(120);
  const card = document.querySelector('[data-board-card="' + TARGET_CARD_ID + '"]');
  const body = bodyOf("已完成");
  const cardBox = rectOf(card);
  const bodyBox = rectOf(body);
  result.reveal = {
    targetInDomWhileCollapsed: beforeJump !== null,
    ariaExpanded: toggleOf("已完成").getAttribute("aria-expanded"),
    highlighted: card.getAttribute("data-board-card-highlight") === "true",
    cardBox: cardBox,
    bodyBox: bodyBox,
    cardInsideBody: cardBox.top >= bodyBox.top - 1 && cardBox.bottom <= bodyBox.bottom + 1,
    cardInViewport:
      cardBox.left >= 0 &&
      cardBox.right <= document.documentElement.clientWidth &&
      cardBox.top >= 0 &&
      cardBox.bottom <= document.documentElement.clientHeight,
    bodyCanScroll: body.scrollHeight > body.clientHeight,
  };
  result.measurements.push(snapshot("after-reveal"));
  return result;
})()`;
}

/** 页面内驱动（只量布局，不交互）：给真实板形态量同一把尺子的数。 */
export function layoutOnlyDriverSource(): string {
  return `(async () => {
${DRIVER_PRELUDE}
  await switchToKanban();
  await waitFor(() => bodyOf("已完成") !== null, "已完成列体");
  return { row: measureRow(), columns: STAGES.map(measureColumn) };
})()`;
}
