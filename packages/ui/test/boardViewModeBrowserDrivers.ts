/**
 * 默认视图切换（C3-5/#140）的**页面内驱动**（与 `boardGuideBrowserDrivers.ts` 同形态：驱动只做
 * 真 DOM 上的量取与真事件派发，判据（断言）留在被测脚本 `boardViewModeBrowser.ts`）。
 *
 * 场景：首开量取（无记忆 → 默认视图）→ 真指针点树形入口 → 卸载重挂载（= 切标签再打开）读回
 * → 再看板同款复验 → 清记忆重挂载（无偏好真实路径回落新默认）→ 宽 1400 / 窄 360 溢出探针。
 *
 * 页面内共用原语（sleep/waitFor/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export function viewModeDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(220);
  };
  const attr = (node, name) => (node ? node.getAttribute(name) : null);
  const STORAGE_KEY = "zcode-board-view-mode";
  const viewRoot = () => document.querySelector("[data-board-view]");
  const viewRoots = () =>
    [...document.querySelectorAll("[data-board-view]")].map((node) => attr(node, "data-board-view"));
  const options = () =>
    [...document.querySelectorAll("[data-board-view-option]")].map((node) =>
      attr(node, "data-board-view-option"),
    );
  const pressed = () =>
    [...document.querySelectorAll('[data-board-view-option][aria-pressed="true"]')].map((node) =>
      attr(node, "data-board-view-option"),
    );
  // 记忆读回走真实存储（读写骨架 = boardSessionStorage；键与实现同源，驱动不另立第二套）。
  const storage = () => {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const snapshot = () => ({
    view: attr(viewRoot(), "data-board-view"),
    roots: viewRoots(),
    options: options(),
    pressed: pressed(),
    storage: storage(),
  });
  const probe = (node) => (node ? probeOverflow(node) : null);
  // 等价「切侧边标签 → 面板卸载 → 再打开」：重挂载走宿主真实的记忆读回路径（只写不读抓不住缺口）。
  const remount = async () => {
    globalThis.__BOARD_REMOUNT__();
    await waitFor(() => document.querySelector("[data-board-pane]"), "面板重挂载");
    await waitFor(() => document.querySelector("[data-board-view]"), "重挂载视图渲染");
    await sleep(140);
  };
  const clickOption = async (mode) => {
    const option = await waitFor(
      () => document.querySelector('[data-board-view-option="' + mode + '"]'),
      "视图入口 " + mode,
    );
    dispatchPointerClick(option);
    await waitFor(
      () => document.querySelector('[data-board-view="' + mode + '"]'),
      "视图切换渲染 " + mode,
    );
    await sleep(140);
  };

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await waitFor(() => document.querySelector("[data-board-view]"), "首屏视图渲染");
  await setHostWidth(1400);
  await sleep(160);
  /* 1. 首开（本会话无记忆）：默认视图 + 切换控件全集（入口在）。 */
  const initial = snapshot();

  /* 2. 一键切树形（真指针点击路由派发）：视图 DOM 与按下态跟随，选择落会话记忆。 */
  await clickOption("tree");
  const afterTreeClick = snapshot();

  /* 3. 卸载重挂载：读回记忆，树形保持（刷新保持）。 */
  await remount();
  const afterTreeRemount = snapshot();

  /* 4. 再切看板并重挂载：保持不是只对树形成立（记忆机制一般性）。 */
  await clickOption("kanban");
  const afterKanbanClick = snapshot();
  await remount();
  const afterKanbanRemount = snapshot();

  /* 5. 无偏好真实路径：清掉会话记忆后重挂载 → 回落新默认（指引面）。 */
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
  await remount();
  const afterClear = snapshot();

  /* 6. 溢出探针：宽档；窄档（缺省面=指引面下的重挂载形态）复量。 */
  const wideProbe = {
    paneRoot: probe(document.querySelector("[data-board-pane]")),
    view: probe(viewRoot()),
    switcher: probe(document.querySelector("[data-board-view-switcher]")),
  };
  await setHostWidth(360);
  await sleep(260);
  const narrowProbe = {
    paneRoot: probe(document.querySelector("[data-board-pane]")),
    view: probe(viewRoot()),
    switcher: probe(document.querySelector("[data-board-view-switcher]")),
  };
  await setHostWidth(1400);
  await sleep(200);
  return { initial, afterTreeClick, afterTreeRemount, afterKanbanClick, afterKanbanRemount, afterClear, wideProbe, narrowProbe };
})()`;
}
