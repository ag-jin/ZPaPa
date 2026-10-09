const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

export type OpenTabLauncherItemId =
  | "file-tree"
  | "selection-side-conversation"
  | "review"
  | "terminal"
  | "browser"
  | "developer-tools"
  | "wiki"
  | "board";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = [];

  // 文件树排在「辅助对话」之前：它是布局类入口（看这个项目有什么），
  // 与具体对话无关，和辅助对话这种对话级入口不是同一层级。
  itemIds.push("file-tree");

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  itemIds.push("terminal");

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  // wiki 是 workspace 级产物面板，紧跟在浏览器下方；任何 workspace 都能打开
  // （没有产物时面板内引导生成）。
  itemIds.push("wiki");

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  // 「项目看板」按要求落在「打开标签页」区块之下：排在既有入口之后。
  // workspace 级只读面板，工件缺失时面板内呈现空态，所以入口本身不做条件裁剪。
  itemIds.push("board");

  return itemIds;
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
}: {
  activeTaskId: string | null;
}): boolean {
  return Boolean(activeTaskId);
}

export function resolveAnimatedSidePanePanelLayout() {
  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    maxSize: "65%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isResizeSettling) {
    // 原生 video/audio 进入 HTML fullscreen 时会触发 resize；如果此时卸载
    // 媒体节点，浏览器会因 fullscreen 元素消失而立即退出全屏。
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
