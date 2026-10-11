/**
 * 卡 #175 浏览器断言的**页面内驱动**（与 `boardV21BrowserScenariosDrivers.ts` 同分层：
 * 驱动只做真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本
 * `boardTreeDividerSortHintBrowser.ts`）。
 *
 * 覆盖两条改动的**可见形态**（SSR 结构断言不构成行为证据——UI 卡门禁）：
 *   1. 树形完成块弱分隔（#175 ①）：三条分隔线的真排版量取（border-top 宽度/颜色、底色、
 *      盒尺寸、上下邻接卡片 id、自身与所在组的横向溢出）；
 *   2. 排序记忆 vs 过滤临时态提示（#175 ②）：控件组与提示的可见性/字号/底色/溢出；
 *   3. 点击路由：分隔线插入后，点其后已完成卡照常开弹窗（弱分隔不吃卡片点击）。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function treeDividerSortHintDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await switchToView("tree");
  const tree = await waitFor(
    () => document.querySelector('[data-board-view="tree"]'),
    "树形视图",
  );
  await sleep(80);
  // 沿元素相邻关系找上下最近的任务卡行（分隔线与卡片行是同层兄弟）。
  const siblingCard = (el, step) => {
    const key = step > 0 ? "nextElementSibling" : "previousElementSibling";
    let node = el ? el[key] : null;
    while (node && !node.hasAttribute("data-board-task")) node = node[key];
    return node;
  };
  const dividers = [...tree.querySelectorAll("[data-board-completed-divider]")].map((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const before = siblingCard(el, -1);
    const after = siblingCard(el, 1);
    return {
      borderTopWidth: style.borderTopWidth,
      borderTopColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
      display: style.display,
      box: { w: Math.round(box.width), h: Math.round(box.height) },
      previousCard: before ? before.getAttribute("data-board-task") : null,
      nextCard: after ? after.getAttribute("data-board-task") : null,
      self: probeOverflow(el),
      parent: el.parentElement ? probeOverflow(el.parentElement) : null,
    };
  });
  const treeProbe = probeOverflow(tree);
  // 点击路由（UI 卡门禁）：点分隔线之后的第一张已完成卡 → 真指针序列 → 弹窗身份 = 该卡。
  const afterDivider = await waitFor(
    () => tree.querySelector('[data-board-task="task:73"]'),
    "分隔线之后的已完成卡",
  );
  dispatchPointerClick(afterDivider);
  const dialog = await waitFor(() => document.querySelector("[data-board-dialog]"), "点完成卡应开弹窗");
  const clickDialogId = dialog.getAttribute("data-board-dialog");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitFor(() => !document.querySelector("[data-board-dialog]"), "弹窗应关闭");
  // 提示（#175 ②）：列表视图控件组里真排版下的可见性与溢出。
  await switchToView("list");
  const filters = await waitFor(
    () => document.querySelector("[data-board-list-filters]"),
    "过滤与排序控件组",
  );
  const hint = await waitFor(
    () => filters.querySelector("[data-board-sort-memory-hint]"),
    "排序记忆提示",
  );
  await sleep(40);
  const hintStyle = getComputedStyle(hint);
  const hintBox = hint.getBoundingClientRect();
  return {
    ua: navigator.userAgent,
    dividers,
    treeProbe,
    clickDialogId,
    controls: {
      probe: probeOverflow(filters),
      rowProbe: filters.parentElement ? probeOverflow(filters.parentElement) : null,
      hint: {
        text: hint.textContent,
        title: hint.getAttribute("title"),
        width: Math.round(hintBox.width),
        fontSize: hintStyle.fontSize,
        color: hintStyle.color,
        backgroundColor: hintStyle.backgroundColor,
        probe: probeOverflow(hint),
      },
      baseFontSize: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim(),
    },
  };
})()`;
}
