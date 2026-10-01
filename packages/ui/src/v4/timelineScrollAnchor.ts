// 虚拟滚动核心：v4 timeline 底部锚定状态机（纯函数，无 DOM/React 依赖）。
//
// 语义（scrollAnchor）：
// - 用户位于底部 → following=true，新内容（新行 / 流式 delta / 测高变化）自动贴底；
// - 用户上滚离底 → following=false，流式增量不得拉回阅读位置，出现「回到底部」按钮；
// - 用户手动滚回底部（或点按钮）→ 恢复跟随。
//
// following 表达用户滚动权，不是瞬时几何快照：只有真实用户滚动输入可以改变它；
// 程序化贴底、terminal 折叠和 virtualizer 测高补偿产生的 scroll 事件只更新几何账目。
//

/** 离底判定容差：小于该距离视为「在底部」。取值覆盖亚像素滚动与最后一行 padding。 */
const BOTTOM_ANCHOR_EPSILON_PX = 48;

interface TimelineScrollMetrics {
  /** 滚动容器 scrollTop。 */
  scrollTop: number;
  /** 滚动容器可视高度（clientHeight）。 */
  viewportHeight: number;
  /** 内容总高度（scrollHeight）。 */
  contentHeight: number;
}

/** 距底部的剩余可滚动距离（内容不足一屏时为 0）。 */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/**
 * scroll 事件后的跟随态。规则：落点在底部 ⇔ 跟随。
 * 覆盖三种来源且无需区分：用户上滚（离底 → 解除）、用户滚回（贴底 → 恢复）、
 * 程序化贴底（落点即底部 → 保持）。
 */
function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/**
 * scroll 事件后的滚动权裁决。布局/程序化 scroll 不得改变用户意图；只有用户输入
 * 才按最终落点决定是否跟随。
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/**
 * scroll 来源细化：把「保护窗内没有登记意图、其实是用户上滚」的事件改判为 user。
 *
 * 内容/测高 commit 会开一个 LAYOUT_SCROLL_GUARD_MS 保护窗，把窗口内的无意图 scroll
 * 当成布局补偿。但用户上滚可能恰好落在保护窗里（流式输出期间每一帧都在续窗），
 * 那条路径不会取消 pending restore，回放就在下一个 commit 上把位置又落回去——
 * 用户看到「拉到上面又被弹回来」。
 *
 * 判据只用回放本身不可能做的事：回放只会把 scrollTop 钳到内容边界，因此相对
 * 「已账目」位置明显回退（且不是本组件同帧写入）只可能来自用户输入。
 * 没有待落回放时不改判，保护窗语义原样保留。
 */
export function refineTimelineScrollSource(input: {
  source: TimelineScrollEventSource;
  scrollTop: number;
  lastObservedScrollTop: number;
  programmaticScroll: boolean;
  restorePending: boolean;
  epsilonPx?: number;
}): TimelineScrollEventSource {
  if (input.source !== "layout") return input.source;
  if (!input.restorePending || input.programmaticScroll) return input.source;
  const epsilon = input.epsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX;
  return input.scrollTop < input.lastObservedScrollTop - epsilon ? "user" : input.source;
}

/**
 * 内容变化（新行追加 / 流式 delta 撑高 / 动态测高修正）后的动作：
 * 跟随中 → 贴底；已解除 → 保持阅读位置（绝不拉回）。
 */
export function anchorActionAfterContentChange(
  following: boolean,
  contentWidthChanging: boolean = false,
): "stickToBottom" | "hold" {
  return following && !contentWidthChanging ? "stickToBottom" : "hold";
}

/**
 * virtualizer 动态测高后的滚动补偿裁决。
 * 宽度 resize 会让多条消息在相邻帧分批测高；此时逐条补偿 scrollTop 会形成可见抖动。
 *
 * 「前插行的估计高度被实测高度替换」是同一机制的二次修正：视口上方那一行变高（或变矮）
 * 后必须把差量补进 scrollTop，否则用户正在读的行会被推移。恢复回放期间这项补偿要抑制
 * （回放拥有坐标系），但用户已经上滚接管之后不能继续抑制——那时它是锚点唯一的保护。
 */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
  following: boolean;
  suppressAdjustment: boolean;
  /** 用户已上滚接管阅读位置（回放已让位）：抑制必须解除。 */
  userOwnsScroll?: boolean;
  contentWidthChanging: boolean;
  itemEnd: number;
  scrollTop: number;
}): boolean {
  if (input.following || input.contentWidthChanging) return false;
  if (input.suppressAdjustment && input.userOwnsScroll !== true) return false;
  return input.itemEnd <= input.scrollTop;
}

/** 未观察滚动的判定容差：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。 */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** wheel 的 deltaY 与 scrollTop 同向：负值阅读更早内容，正值靠近底部。 */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** touch 手指位移与 scrollTop 反向：手指下移表示阅读更早内容。 */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/** 键盘滚动意图；输入控件内的光标按键不属于 timeline 滚动。 */
export function timelineKeyboardScrollIntent(input: {
  key: string;
  shiftKey: boolean;
  editableTarget: boolean;
}): TimelineUserScrollIntent {
  if (input.editableTarget) return "none";
  if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") {
    return "awayFromBottom";
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End") {
    return "towardBottom";
  }
  if (input.key === " ") {
    return input.shiftKey ? "awayFromBottom" : "towardBottom";
  }
  return "none";
}

/**
 * 内容变化 commit 贴底前，对账用户滚动意图。
 *
 * 跟随态由 scroll 事件驱动，但 scroll 事件在滚动发生后的下一渲染帧才派发：
 * 用户上滚（wheel）或测试程序化 scrollTop 赋值之后、事件派发之前，若恰好落进一个
 * totalSize/rowCount 变化的 React commit（流式 delta、ResizeObserver 测高修正、
 * composer 尺寸变化引起的窗口重算），贴底 effect 会拿着**过期的 following=true**
 * 把 scrollTop 拽回底部，且回弹落点让随后的 scroll 事件把跟随判回 true——
 * 用户/测试的上滚被整体吞掉（“resize/测量 commit 夺走滚动权”）。
 *
 * 对账规则（在贴底动作之前执行，输入为 commit 时刻的实时指标）：
 * 1. 明确向上滚动 → 立即解除跟随，同帧 terminal/layout commit 也必须让位；
 * 2. 没有用户输入 → 原样保持 following，virtualizer/折叠导致的 scrollTop 回退不算上滚；
 * 3. 方向未知或向下的用户输入 → 落点在底则恢复跟随，明显回退则解除，其余保持。
 */
export function reconcileFollowingForContentAnchor(input: {
  /** 当前跟随态（scroll 事件驱动的既有值）。 */
  following: boolean;
  /** commit 时刻（贴底动作前）的实时滚动指标。 */
  metrics: TimelineScrollMetrics;
  /** 组件最近一次「已账目」的 scrollTop（scroll 事件读取值或程序化写入后的回读值）。 */
  lastObservedScrollTop: number;
  /** 当前内容 commit 前捕获到的用户滚动意图；省略时按旧的未知来源对账。 */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** 「回到底部」按钮可见性：仅在解除跟随且确实存在内容时展示。 */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
  return !following && rowCount > 0;
}

/** 会话切换 / 首次绑定：重置为跟随（打开会话定位到最新消息）。 */
export function initialFollowing(): boolean {
  return true;
}

// ── loadOlder：prepend 滚动锚定（虚拟滚动前插的经典坑）──
//
// 语义：向窗口顶部前插历史行时，用户正在读的行（锚点）在视口中的位置不得跳动。
// 虚拟列表下前插只改总高度（既有 turn 按 turnId 缓存测量值，不重挂不重测），
// 因此锚定恢复 = scrollTop 平移「前插内容撑高的那段」：
//   scrollTop' = scrollTop + (nextTotalSize - prevTotalSize)
// 前提：既有 render unit key 稳定（getItemKey=turnId）且同一帧内无其它测量修正——
// prepend commit 里新行只有估计高度，后续 ResizeObserver 修正走 virtualizer
// 的常规 shift 逻辑，不再经此函数。

export interface PrependAnchorFrame {
  key: string;
  /** 锚点 measurement 起点相对视口顶部的偏移。 */
  offsetTop: number;
  start: number;
}

export interface PrependVirtualAnchor extends PrependAnchorFrame {
  /**
   * 采集瞬间的虚拟列表总高度。
   *
   * 锚点行被虚拟化卸载、拿不到当帧 measurement 时，只能按「已存起点 + 总高度增量」
   * 推算它的新起点；增量必须以采集瞬间为基准，否则会把采集到本帧之间其它行的
   * 测高修正（估计高度改实测高度）重复计入平移量——实测首帧会偏 ~145px。
   */
  totalSize: number;
}

/**
 * 同一稳定 key 在 prepend 后需要施加的 scrollTop 修正量。
 *
 * 触发 loadOlder 到 rows 提交之间，恢复布局或 virtualizer 可能先改写
 * scrollTop；只叠加 measurement.start 的差值会把这段中间位移重复计入。以触发瞬间
 * 保存的视口偏移计算绝对目标，再减实时 scrollTop，才能稳定恢复原阅读位置。
 */
export function prependVirtualAnchorAdjustment(
  previous: PrependAnchorFrame,
  next: PrependAnchorFrame,
  currentScrollTop: number,
): number | null {
  if (previous.key !== next.key) return null;
  if (
    !Number.isFinite(previous.offsetTop) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(currentScrollTop)
  ) {
    return null;
  }
  return next.start - previous.offsetTop - currentScrollTop;
}

interface PrependAnchorInput {
  /** 上一 commit 的窗口首行 rowId（null = 尚无行）。 */
  prevFirstRowId: number | null;
  /** 本 commit 的窗口首行 rowId（null = 行被清空）。 */
  nextFirstRowId: number | null;
  /** 上一 commit 的虚拟列表总高度。 */
  prevTotalSize: number;
  /** 本 commit 的虚拟列表总高度。 */
  nextTotalSize: number;
}

/**
 * 前插后的 scrollTop 平移量。仅当「首行 rowId 变小」（真前插）时返回正平移；
 * 追加/替换/清空/首帧一律 null（不动滚动位置，交给底部锚定逻辑）。
 */
export function prependScrollAdjustment(input: PrependAnchorInput): number | null {
  if (input.prevFirstRowId === null || input.nextFirstRowId === null) {
    return null;
  }
  if (input.nextFirstRowId >= input.prevFirstRowId) return null;
  const delta = input.nextTotalSize - input.prevTotalSize;
  return delta > 0 ? delta : null;
}

/**
 * 前插平移的完整裁决（三段缺口都在这里补齐）。
 *
 * `prependScrollAdjustment` 的 rowId 增量只在「上一帧有行可比」时成立，遇到
 * 首帧、以及「触发瞬间到本帧之间 scrollTop 被恢复布局/虚拟化改写过」就不够用：
 * 增量会把中间位移重复计入，而且虚拟化把锚点行卸载后连 measurement 都查不到。
 * 这里统一按绝对目标恢复：目标 = 锚点行新起点 − 触发瞬间保存的视口偏移，
 * 平移量 = 目标 − 当前 scrollTop。
 *
 * 首帧（上一帧窗口为空）没有 rowId 可比，且总高度增量等于整段新内容高度，
 * 拿它当平移量会把人推走；只有本帧已经量到锚点行起点时才能按绝对目标恢复。
 */
export interface PrependViewportInput {
  /** 上一 commit 的窗口首行 rowId（null = 尚无行）。 */
  prevFirstRowId: number | null;
  /** 本 commit 的窗口首行 rowId（null = 行被清空）。 */
  nextFirstRowId: number | null;
  /** 上一 commit 的虚拟列表总高度。 */
  prevTotalSize: number;
  /** 本 commit 的虚拟列表总高度。 */
  nextTotalSize: number;
  /** 本 commit 读到的实时 scrollTop。 */
  currentScrollTop: number;
  /** 触发 loadOlder 瞬间保存的锚点；null = 这一帧不是用户滚动触发的前插。 */
  anchor: PrependVirtualAnchor | null;
  /** 锚点行在本 commit 的 measurement 起点；null = 已被虚拟化卸载。 */
  anchorNextStart: number | null;
  /** 待落回放是否拥有本 commit 的坐标系（true = 禁止平移，回放自己会落）。 */
  restoreOwnsAnchor: boolean;
}

export function resolvePrependViewportAdjustment(input: PrependViewportInput): number | null {
  if (input.restoreOwnsAnchor) return null;
  if (input.nextFirstRowId === null) return null;

  const rowIdPrepend =
    input.prevFirstRowId !== null && input.nextFirstRowId < input.prevFirstRowId;
  const firstFramePrepend = input.prevFirstRowId === null;
  if (!rowIdPrepend && !firstFramePrepend) return null;

  const anchor = input.anchor;
  if (anchor) {
    const growth = input.nextTotalSize - anchor.totalSize;
    const nextStart =
      input.anchorNextStart ??
      // 锚点行已被虚拟化卸载：前插只把总高度撑高，用采集瞬间的起点加增量还原
      // 它的新起点。首帧没有可用增量（等于整段新内容高度），只能走实测起点。
      (rowIdPrepend && growth > 0 ? anchor.start + growth : null);
    if (nextStart !== null) {
      const absolute = prependVirtualAnchorAdjustment(
        anchor,
        { key: anchor.key, offsetTop: anchor.offsetTop, start: nextStart },
        input.currentScrollTop,
      );
      if (absolute !== null) return absolute;
    }
  }

  // 无锚点（或锚点行无法定位）时退化为总高度增量；首帧没有这个退化路径。
  if (!rowIdPrepend) return null;
  return prependScrollAdjustment({
    prevFirstRowId: input.prevFirstRowId,
    nextFirstRowId: input.nextFirstRowId,
    prevTotalSize: input.prevTotalSize,
    nextTotalSize: input.nextTotalSize,
  });
}

/** 顶部触发阈值：距顶小于该距离视为「到顶」，自动拉取更早一窗。 */
const LOAD_OLDER_TRIGGER_PX = 64;

/** 提前两个视口补页，网络与渲染应在用户抵达窗口边界前完成。 */
const LOAD_OLDER_PREFETCH_VIEWPORTS = 2;

export function historyPrefetchTriggerPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return LOAD_OLDER_TRIGGER_PX;
  }
  return Math.max(LOAD_OLDER_TRIGGER_PX, viewportHeight * LOAD_OLDER_PREFETCH_VIEWPORTS);
}

/** scroll 事件是否应触发 loadOlder（到顶 + 可拉 + 非在途）。 */
export function shouldTriggerLoadOlder(input: {
  scrollTop: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  triggerPx?: number;
}): boolean {
  return (
    input.canLoadOlder &&
    !input.loadingOlder &&
    input.scrollTop <= (input.triggerPx ?? LOAD_OLDER_TRIGGER_PX)
  );
}

/**
 * 预取来源门：只有真实用户滚动可以触发 loadOlder。
 *
 * 程序化回放与布局补偿不是用户意图。允许它们补页会形成级联：恢复把位置钳在窗口顶部
 * → 预取补一窗 → 下一个 commit 又把位置钳回顶部 → 再预取，一路补到没有更早历史为止，
 * 把整段历史拉进窗口（实测最长的会话从 60 行涨到 11042 行，见会话按需加载回归用例）。
 */
export function shouldTriggerLoadOlderFromScroll(input: {
  source: TimelineScrollEventSource;
  scrollTop: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  triggerPx?: number;
}): boolean {
  if (input.source !== "user") return false;
  return shouldTriggerLoadOlder(input);
}
