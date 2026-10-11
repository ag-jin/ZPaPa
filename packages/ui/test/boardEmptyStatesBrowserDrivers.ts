/**
 * 卡 #158 / E1a-1 空态 A 二分 + 未连接保留快照的**页面内驱动**（与
 * `boardFoldBrowserDrivers.ts` 同形态：驱动只做真 DOM 上的量取与真事件派发，判据（断言）
 * 留在被测脚本 `boardEmptyStatesBrowser.ts`）。
 *
 * 页面内共用原语（sleep/waitFor/dispatchPointerClick/probeOverflow）单点在
 * `boardBrowserProbeKit.ts`，本驱动引用同一份，不复制。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/**
 * 空态 A1/A2 渲染路径（板本体缺失的两副面孔）：真引擎里等首读落定 → 量占位态锚点/文案/
 * 溢出 → 真指针点击刷新（点击路由派发）→ 等重读计数增长（刷新真走了读取缝）。
 *
 * 为什么真引擎量：占位态是首读 RPC 回来后的真实渲染结果（SSR 结构断言不构成行为证据）；
 * 刷新按钮是否真触发重读只有经真事件 + 真状态机才看得见；窄档不溢出是排版行为。
 */
export function emptyStateDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(200);
  };
  const readCount = () => globalThis.__E1A_READ_COUNT__;
  const emptyAnchor = () => {
    const node = document.querySelector("[data-board-empty]");
    return node ? node.getAttribute("data-board-empty") : null;
  };
  const emptyText = () => {
    const node = document.querySelector("[data-board-empty]");
    return node ? node.textContent.trim() : null;
  };
  const probes = () => {
    const node = document.querySelector("[data-board-empty]");
    const box = node ? node.parentElement : null;
    return {
      node: node ? probeOverflow(node) : null,
      box: box ? probeOverflow(box) : null,
    };
  };

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  const anchor = await waitFor(() => emptyAnchor(), "空态占位落定");
  const text = emptyText();
  const notice = document.querySelector("[data-board-snapshot-notice]");
  const placeholderProbe = probes();
  const loadingAnchorPresent = document.querySelector("[data-board-loading]") !== null;

  /* 点击路由：真指针序列点刷新 → 必须真触发重读（读取缝计数增长）。 */
  const readsBefore = readCount();
  const refreshButton = await waitFor(() => document.querySelector("[data-board-refresh]"), "刷新按钮");
  dispatchPointerClick(refreshButton);
  await waitFor(() => readCount() > readsBefore, "刷新触发重读");
  await sleep(120);
  const afterRefresh = {
    anchor: emptyAnchor(),
    text: emptyText(),
    readCount: readCount(),
  };

  /* 窄档（360）溢出探针：占位态与状态行都不得横向溢出。 */
  await setHostWidth(360);
  const narrowProbe = probes();

  return {
    ua: navigator.userAgent,
    anchor,
    text,
    noticeText: notice ? notice.textContent.trim() : null,
    placeholderProbe,
    narrowProbe,
    loadingAnchorPresent,
    readsBefore,
    afterRefresh,
    windowWidthAtNarrow: host.clientWidth,
  };
})()`;
}

/**
 * 加载态可观察（#158 验收「unavailable 与加载态可区分」的加载侧）：首读被延迟服务挂住时，
 * 真 DOM 上量加载占位（锚点/文案）→ 首读落定后再量落定态——两态锚点/文案必须互不相同。
 */
export function loadingStateDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  const loadingNode = await waitFor(() => document.querySelector("[data-board-loading]"), "加载占位");
  const loading = {
    text: loadingNode.textContent.trim(),
    probe: probeOverflow(loadingNode),
    emptyAnchorPresent: document.querySelector("[data-board-empty]") !== null,
    refreshPresent: document.querySelector("[data-board-refresh]") !== null,
  };
  const settledNode = await waitFor(() => document.querySelector("[data-board-empty]"), "首读落定");
  const settled = {
    anchor: settledNode.getAttribute("data-board-empty"),
    text: settledNode.textContent.trim(),
    loadingAnchorPresent: document.querySelector("[data-board-loading]") !== null,
  };
  return { ua: navigator.userAgent, loading, settled, hostWidth: host.clientWidth };
})()`;
}

/**
 * 未连接保留上次快照（E7 §7.2）：真宿主 + 真远程会话注册表——先就绪（远程会话在场）→
 * 注销会话（连接未就绪）→ 断言快照保留 + 状态行 + 未就绪时刷新不发无效 RPC →
 * 重新注册（连接恢复）→ 自动重读、状态行消失。
 *
 * 为什么真引擎量：断连/恢复是服务解析与连接门禁的真实状态迁移；「保留快照、不发无效 RPC、
 * 恢复自动重读」三条都只有经真宿主 + 真事件链才看得见（SSR 注入状态不算行为证据）。
 */
export function unavailableSnapshotDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const host = document.getElementById("host");
  const setHostWidth = async (width) => {
    host.style.width = width + "px";
    await sleep(200);
  };
  const readCount = () => globalThis.__E1A_READ_COUNT__;
  const firstCardText = () => {
    const node = document.querySelector("[data-board-task]");
    return node ? node.textContent.trim() : null;
  };
  const noticeText = () => {
    const node = document.querySelector("[data-board-snapshot-notice]");
    return node ? node.textContent.trim() : null;
  };

  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await setHostWidth(1400);
  /* 阶段 1：就绪（远程会话在场）。 */
  await waitFor(() => document.querySelector("[data-board-task]"), "就绪态内容渲染");
  const ready = {
    cardText: firstCardText(),
    noticeText: noticeText(),
    readCount: readCount(),
  };

  /* 阶段 2：断连（注销远程会话）→ 直接呈现「暂时不可读」，但保留上次快照 + 状态行。 */
  globalThis.__E1A_DROP__();
  await waitFor(() => noticeText(), "断连后快照状态行");
  const dropped = {
    cardText: firstCardText(),
    noticeText: noticeText(),
    placeholderAnchor: (() => {
      const node = document.querySelector("[data-board-empty]");
      return node ? node.getAttribute("data-board-empty") : null;
    })(),
    readCount: readCount(),
    noticeProbe: (() => {
      const node = document.querySelector("[data-board-snapshot-notice]");
      return node ? probeOverflow(node) : null;
    })(),
    paneProbe: (() => {
      const node = document.querySelector("[data-board-pane]");
      return node ? probeOverflow(node) : null;
    })(),
  };

  /* 阶段 3：未就绪时点刷新（真指针序列）→ 不发无效 RPC（读取计数不涨），版面不变。 */
  const refreshButton = await waitFor(() => document.querySelector("[data-board-refresh]"), "刷新按钮");
  dispatchPointerClick(refreshButton);
  await sleep(220);
  const afterRefreshWhileDropped = {
    cardText: firstCardText(),
    noticeText: noticeText(),
    readCount: readCount(),
  };

  /* 阶段 4：连接恢复（重新注册会话）→ 自动重读、状态行消失。 */
  const readsBeforeRecover = readCount();
  globalThis.__E1A_RECOVER__();
  await waitFor(() => !noticeText(), "恢复后状态行消失");
  await waitFor(() => readCount() > readsBeforeRecover, "恢复自动重读");
  await sleep(120);
  const recovered = {
    cardText: firstCardText(),
    noticeText: noticeText(),
    readCount: readCount(),
  };

  /* 窄档溢出探针（状态行已消失，探面板根）。 */
  await setHostWidth(360);
  const narrowProbe = (() => {
    const node = document.querySelector("[data-board-pane]");
    return node ? probeOverflow(node) : null;
  })();

  return {
    ua: navigator.userAgent,
    ready,
    dropped,
    afterRefreshWhileDropped,
    recovered,
    narrowProbe,
    windowWidthAtNarrow: host.clientWidth,
  };
})()`;
}
