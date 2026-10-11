/**
 * 超长角色名**触屏全文载体**的页面内驱动（卡 #142 / C3-7 随行登记项，转自 #141 F3-141；
 * 判据（断言）留在 `boardGuideTapCarrierBrowser.ts`）。
 *
 * 场景（两个队列行，同一计划 B；#141/#138 的同一真值形态）：
 *   - 生产形态：`frontier[].nextAssignee` = 七角色词表里最长的 `refactoring-optimizer`，
 *     且卡面 `assignees` 管线含该角色（编译器构造 + 校验器强制：nextAssignee ∈ assignees）；
 *   - 词表外形态：`exhaustive-reverse-auditor`（#141 夹具合成名，不在词表、不在管线）。
 * 每个宽度（320/375）对两行各做一次**触摸类型**点击链（pointerdown → pointerup → click），
 * 量取：行内可见文案（截断/全文 title）+ 弹窗（role/title/管线角色节点逐项文本与截断/接手位标记）。
 *
 * 量法说明：角色节点「未截断」判据 = scrollWidth <= clientWidth + 1（真排版；弹窗是宽面，
 * 生产词表最长角色应完整可读——不得依赖 hover title）。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function guideTapCarrierDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(240);
  };
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const textOf = (node) => (node ? (node.textContent || "").trim() : null);
  const truncated = (node) => (node ? node.scrollWidth > node.clientWidth + 1 : null);
  const dispatchTouchTap = (node) => {
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const pointer = { ...base, pointerId: 21, pointerType: "touch", isPrimary: true, width: 2, height: 2 };
    node.dispatchEvent(new PointerEvent("pointerdown", pointer));
    node.dispatchEvent(new PointerEvent("pointerup", pointer));
    node.dispatchEvent(new MouseEvent("click", base));
  };
  /* 打开弹窗 → 量取 → 关闭（触摸链；与 #141 同一交互路径）。 */
  const tapAndRead = async (row) => {
    row.scrollIntoView({ block: "center" });
    await sleep(200);
    const next = row.querySelector("[data-board-guide-queue-next]");
    const rowNext = {
      text: textOf(next),
      truncated: truncated(next),
      title: attr(next, "title"),
    };
    const rowId = attr(row, "data-board-card");
    dispatchTouchTap(row);
    const dialog = await waitFor(
      () => document.querySelector('[data-board-dialog="' + rowId + '"]'),
      "触摸点击后的卡片弹窗 " + rowId,
    );
    await sleep(120);
    const roles = [...dialog.querySelectorAll("[data-board-pipeline-role]")].map((node) => ({
      role: attr(node, "data-board-pipeline-role"),
      text: textOf(node),
      truncated: truncated(node),
      title: attr(node, "title"),
      next: attr(node, "data-board-pipeline-next"),
      /* 接手位标记（「下一个」徽记 = 节点内子 span；文本含标记前缀，判全名用 includes）。 */
      marker: node.querySelector("[data-board-pipeline-next-marker]") !== null,
    }));
    const measured = {
      rowId,
      rowNext,
      dialogRole: attr(dialog, "role"),
      dialogText: (dialog.textContent || "").trim().slice(0, 200),
      pipelineRoles: roles,
      pipelineNext: attr(dialog.querySelector("[data-board-pipeline-next]"), "data-board-pipeline-next"),
    };
    dispatchPointerClick(dialog.querySelector("[data-board-dialog-close]"));
    await waitFor(
      () => document.querySelector('[data-board-dialog="' + rowId + '"]') === null,
      "弹窗关闭 " + rowId,
    );
    return measured;
  };

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await switchToView("guide");
  const root = await waitFor(
    () => document.querySelector('[data-board-view="guide"]'),
    "指引面渲染",
  );

  const tiers = [];
  for (const width of [320, 375]) {
    await setHostWidth(width);
    const productionRow = await waitFor(
      () => root.querySelector('[data-board-guide-plan-queue] [data-board-card="task:221"]'),
      "生产形态队列行 task:221",
    );
    const production = await tapAndRead(productionRow);
    const foreignRow = await waitFor(
      () => root.querySelector('[data-board-guide-plan-queue] [data-board-card="task:220"]'),
      "词表外形态队列行 task:220",
    );
    const foreign = await tapAndRead(foreignRow);
    tiers.push({ width, production, foreign });
  }

  return { ua: navigator.userAgent, tiers };
})();
`;
}
