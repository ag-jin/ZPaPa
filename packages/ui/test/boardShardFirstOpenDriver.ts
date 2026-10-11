/**
 * #221/D8「首开在途窗口」浏览器断言的页面内驱动（与 `boardShardLoadingBrowser.ts` 配对；
 * 拆文件原因：该脚本非 `*.test.*`，受 oxlint `max-lines` 400 行约束）。
 *
 * 驱动只做真 DOM 上的量取：分片读被人为延迟时，点卡后先读弹窗**首帧**读取态（应是独立
 * 「读取中」，不是 #183「板上未携带」假空态），再等分片读落地 → 卡文点亮；判据（断言）留在
 * 被测脚本 `boardShardLoadingBrowser.ts`。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/** 首开窗口驱动量取结果（真渲染首帧 + 落地后）。 */
export interface FirstOpenResult {
  ua: string;
  firstFrame: {
    detailState: string | null;
    text: string;
    hasCardTextBlock: boolean;
    absentNotice: boolean;
  };
  afterSettle: { detailStateExists: boolean; goal: string | null };
}

export function firstOpenDriverSource(params: { targetNo: number }): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await waitFor(() => globalThis.__READS__.length > 0, "首屏读取发生");
  await switchToView("list");
  const targetId = "task:" + String(${params.targetNo});
  const card = await waitFor(
    () => document.querySelector('[data-board-view="list"] [data-board-card="' + targetId + '"]'),
    "目标卡在场",
  );
  dispatchPointerClick(card);
  const dialog = await waitFor(() => document.querySelector('[data-board-dialog="' + targetId + '"]'), "卡片弹窗打开");
  const notice = await waitFor(
    () => dialog.querySelector("[data-board-dialog-detail]"),
    "读取态提示（首开在途）",
  );
  const firstFrame = {
    detailState: notice.getAttribute("data-board-dialog-detail"),
    text: notice.textContent.trim(),
    hasCardTextBlock: !!dialog.querySelector("[data-board-dialog-card-text]"),
    absentNotice: dialog.textContent.includes("板上未携带"),
  };
  const goalValue = await waitFor(() => {
    const el = dialog.querySelector('[data-board-dialog-card-text="goal"] [data-board-dialog-card-text-value]');
    return el ? el.textContent.trim() : null;
  }, "卡文目标（分片按需读）");
  const afterSettle = {
    detailStateExists: !!dialog.querySelector("[data-board-dialog-detail]"),
    goal: goalValue,
  };
  return { ua: navigator.userAgent, firstFrame, afterSettle };
})()`;
}
