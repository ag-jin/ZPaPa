import assert from "node:assert/strict";

/**
 * 看板浏览器断言的**可复用探针工具箱**（#55 S-8，承 #54）：溢出探针（scrollWidth vs clientWidth）
 * 与点击路由序列（完整 pointer/mouse 事件链）在这里单点导出——后续 UI 卡验证固定引用同一份，
 * 不各自复制页面内驱动原语（复制件早晚对不上，评审判据也就失去可比性）。
 *
 * 分层沿用既有形态：本模块只提供「页面内驱动原语源码」与「Node 侧断言 helper」；
 * 驱动脚本（量什么、点哪里）在各被测脚本的 Drivers 文件，判据（断言）在被测脚本本身
 * （#59 S-8 指针修正：当前引用方 = test/boardV21BrowserScenarios.ts；boardKanbanBrowserLayout
 * 为独立量法，不引用本 kit）。
 */

/** 元素横向溢出量取结果（页面内量取，Node 侧断言；1px 容差吸收亚像素取整）。 */
export interface BoardBrowserOverflowProbe {
  clientW: number;
  scrollW: number;
  overflows: boolean;
  box: { left: number; right: number };
}

/** 溢出判据单点：scrollWidth 超 clientWidth（1px 容差）即横向溢出。 */
export function assertNoHorizontalOverflow(probe: BoardBrowserOverflowProbe, label: string): void {
  assert.ok(
    probe.scrollW <= probe.clientW + 1,
    `${label}：不得横向溢出（scrollWidth ${probe.scrollW} > clientWidth ${probe.clientW}）`,
  );
}

/**
 * 页面内共用原语（真 DOM；不重算业务判据）：
 * - `waitFor` / `sleep`：等真实渲染与过渡落定；
 * - `switchToView`：经真实视图切换控件进入目标视图；
 * - `dispatchPointerClick`：完整指针/点击序列（pointerdown → mousedown → pointerup → mouseup →
 *   click）——真用户路径，不靠 `el.click()` 一步到位：`<summary>` 的默认动作（toggle）与
 *   卡片 onClick 都要在这条路径上被真触发；
 * - `probeOverflow`：溢出探针（scrollWidth vs clientWidth，字段与 BoardBrowserOverflowProbe 对齐）。
 */
export const BOARD_BROWSER_DRIVER_PRELUDE = `
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
  const switchToView = async (mode) => {
    await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
    const option = await waitFor(
      () => document.querySelector('[data-board-view-option="' + mode + '"]'),
      "视图切换控件 " + mode,
    );
    option.click();
    await waitFor(() => document.querySelector('[data-board-view="' + mode + '"]'), "视图渲染 " + mode);
  };
  // 完整指针/点击序列：真用户路径（pointerdown → mousedown → pointerup → mouseup → click），
  // 不靠 el.click() 一步到位——summary 的默认动作（toggle）与卡片 onClick 都要在这条路径上被真触发。
  const dispatchPointerClick = (el) => {
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  };
  const probeOverflow = (el) => ({
    clientW: el.clientWidth,
    scrollW: el.scrollWidth,
    overflows: el.scrollWidth > el.clientWidth + 1,
    box: { left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) },
  });
`;
