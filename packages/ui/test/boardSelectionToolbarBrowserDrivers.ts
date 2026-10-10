/**
 * 卡 #64 浏览器断言脚本的**驱动层**（与 `boardV21BrowserScenariosDrivers.ts` 同款分层）：
 * 页面内客户端入口（真组件挂载）与页面内驱动脚本（真实 Selection 驱动、量取）在这里单点导出，
 * 断言留在 `boardSelectionToolbarBrowser.ts`。
 *
 * 场景 A = 真侧边面板布局（看板 tab 与文件预览 tab 并存）；场景 B = 判定侧同容器
 * （浮条根容器同时包含普通段落与看板面板）。两场景的取舍与证据分工见被测脚本头部注释。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

/** 页面侧共用原语（真 Selection 驱动；判据在 Node 侧，不重算业务判据）。 */
const SELECTION_PRELUDE = `
  const toolbar = () => document.querySelector("[data-conversation-selection-tooltip]");
  const frames = async (n) => {
    for (let index = 0; index < n; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  };
  // 在 root 内挑一个可选文本节点造真实 Selection（Selection API），并在其宿主元素上派发
  // mouseup（浮条监听在根容器的 mouseup 上）。返回选中文本，便于证据留痕。
  const selectTextIn = (root, minLength) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null;
    let target = null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (text.length < (minLength || 2)) continue;
      if (!(node.parentElement instanceof Element)) continue;
      // 不选控件/对话框内的文本：那两类端点本来就有独立门禁，不是本卡的判据面。
      const excluded = node.parentElement.closest(
        "button, input, textarea, [role='button'], [role='dialog']",
      );
      if (excluded) continue;
      target = node;
      break;
    }
    if (!target) throw new Error("找不到可选文本节点");
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, Math.min(target.textContent.length, 12));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    (target.parentElement || root).dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
    );
    return selection.toString();
  };
  const settleToolbar = async () => {
    // 浮条在 rAF 里由 inspect 结果驱动：等两帧 + 一个宏任务，避免读到上一帧状态。
    await frames(3);
    await sleep(120);
    await frames(3);
  };
`;

/* ---------------- 场景 A：真侧边面板（看板 tab + 文件预览 tab） ---------------- */

export const SIDE_PANE_CLIENT_ENTRY = `
import * as React from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedSidePanePanel } from "./src/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanelGroup } from "./src/components/ui/resizable.js";
import { TooltipProvider } from "./src/components/ui/tooltip.js";
import { resolveBoardJsonPath } from "./src/board/loadBoardDocument.js";
import { PlatformProvider } from "./src/hooks/usePlatform.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";
import { StoreProvider } from "./src/store/StoreProvider.js";
import { Event } from "@zcode/rpc";

const WORKSPACE_PATH = "/fake/watch-workspace";
const boardPath = resolveBoardJsonPath(WORKSPACE_PATH);
const boardJson = globalThis.__BOARD_JSON__ ?? "";
const slice = {
  path: boardPath,
  content: boardJson,
  offset: 0,
  bytesRead: boardJson.length,
  totalBytes: boardJson.length,
  truncated: false,
  isBinary: false,
};
let settings = { recentProjects: [], experimentalProjectBoardEnabled: true };
const settingService = {
  get: async () => ({ ...settings }),
  update: async (patch) => { settings = { ...settings, ...patch }; },
};
const fileService = {
  checkFilesExist: async (params) =>
    params.paths.map((candidate) => ({ path: candidate, exists: candidate === boardPath })),
  readTextFile: async () => slice,
};
const services = { fileService, settingService };
const platform = {
  onSettingsChanged: () => () => {},
  syncAppSettings: () => {},
  getInstalledEditors: async () => [],
  openInEditor: async () => {},
  revealInFileManager: async () => {},
  openExternal: async () => {},
};
const broadcastService = {
  send: async () => {},
  acquireClaim: async () => ({ ok: true }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => true,
  onMessage: Event.None,
};
const noop = () => {};

const MARKDOWN = "# 文件预览标题\\n\\n这是一段用于选择测试的正文文本，包含足够多的字符。\\n\\n第二段正文。\\n";

const initialSidePaneState = {
  tabs: [
    {
      id: "code-viewer:md",
      type: "code-viewer",
      openedAt: 1,
      sourceKey: "notes.md",
      workspaceKey: WORKSPACE_PATH,
      source: {
        type: "text",
        title: "notes.md",
        path: "/fake/watch-workspace/notes.md",
        language: "markdown",
        content: MARKDOWN,
      },
    },
    { id: "board", type: "board", openedAt: 2 },
  ],
  // 初始就是看板 tab：与用户「打开看板后选字」的路径一致。
  activeTabId: "board",
};

function panelProps(sidePaneState, onActivateTab) {
  return {
    services,
    isVisible: true,
    sidePaneState,
    recentClosedSidePaneTabs: [],
    isBrowserOpen: false,
    workspaceAbsPath: WORKSPACE_PATH,
    activeTaskId: null,
    sidePaneOwnerId: null,
    gitState: {},
    activeGitSourceId: "unstaged",
    panelRef: { current: null },
    panelElementRef: { current: null },
    browserNavigationRequest: null,
    browserRestoreUrls: {},
    fileChangeFindActiveIndex: 0,
    fileChangeFindNavigationRequestId: 0,
    fileChangeFindQuery: "",
    onFileChangeFindMatchCountChange: noop,
    onCloseCodeViewer: noop,
    onCloseGit: noop,
    onActivateTab,
    onReorderTab: noop,
    onCloseTab: noop,
    onCloseOtherTabs: noop,
    onCloseAllTabs: noop,
    onReopenClosedTab: noop,
    onOpenBrowserTab: noop,
    onOpenWhiteboard: noop,
    onOpenDeveloperTools: noop,
    onOpenWiki: noop,
    onOpenBoard: noop,
    onOpenFileTree: noop,
    onOpenTerminalTab: noop,
    onOpenReviewTab: noop,
    onOpenSelectionSideConversation: noop,
    onOpenBrowserUrl: noop,
    onOpenCodeViewer: noop,
    onOpenSubagentSession: noop,
    onRefreshGit: noop,
    onBrowserNavigationRequestHandled: noop,
    onBrowserUrlChange: noop,
    onBrowserPageMetadataChange: noop,
    onSelectGitSource: noop,
  };
}

function PanelHost() {
  const [sidePaneState, setSidePaneState] = React.useState(initialSidePaneState);
  // tab 激活与真 app 同语义（受控 Tabs：onActivateTab 更新 activeTabId）。
  const onActivateTab = (tabId) =>
    setSidePaneState((current) => ({ ...current, activeTabId: tabId }));
  return createElement(
    ResizablePanelGroup,
    { direction: "horizontal", style: { height: "100%" } },
    createElement(AnimatedSidePanePanel, panelProps(sidePaneState, onActivateTab)),
  );
}

const tree = createElement(
  PlatformProvider,
  { platform },
  createElement(
    ServiceProvider,
    { services },
    createElement(
      TabStoreProvider,
      null,
      createElement(
        StoreProvider,
        { broadcastService },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(TooltipProvider, null, createElement(PanelHost, null)),
        ),
      ),
    ),
  ),
);
createRoot(document.getElementById("host")).render(tree);
`;

export const SIDE_PANE_DRIVER = `
(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
${SELECTION_PRELUDE}
  await waitFor(() => document.querySelector("[data-board-pane]"), "看板面板渲染");
  await sleep(300);
  const out = {};

  // ① 看板 tab 活动：看板面板内造选区。
  const boardPane = document.querySelector("[data-board-pane]");
  const boardText = selectTextIn(boardPane, 2);
  await settleToolbar();
  out.board = {
    selectedText: boardText,
    toolbarPresent: !!toolbar(),
    toolbarText: toolbar() ? toolbar().textContent : null,
  };

  // ② 切到文件预览 tab：markdown 预览正文内造选区（对照，不回归）。
  const trigger = await waitFor(
    () => document.querySelector('[data-side-pane-tab-id="code-viewer:md"]'),
    "文件预览 tab 触发器",
  );
  dispatchPointerClick(trigger);
  const markdownRoot = await waitFor(
    () => document.querySelector("[data-markdown-preview]"),
    "markdown 预览渲染",
  );
  await sleep(400);
  const markdownText = selectTextIn(markdownRoot, 2);
  await settleToolbar();
  out.markdown = {
    selectedText: markdownText,
    toolbarPresent: !!toolbar(),
    toolbarText: toolbar() ? toolbar().textContent : null,
  };

  out.ua = navigator.userAgent;
  return out;
})()
`;

/* ---------------- 场景 B：判定侧同容器（浮条根容器包含看板面板） ---------------- */

export const NESTED_CLIENT_ENTRY = `
import * as React from "react";
import { createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BoardPaneView } from "./src/board/BoardPaneView.js";
import { parseBoardJson } from "./src/board/boardViewModel.js";
import { MarkdownSelectionTooltip } from "./src/v4/MarkdownSelectionTooltip.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";

const outcome = parseBoardJson(globalThis.__BOARD_JSON__ ?? "");
if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");

function Root() {
  const rootRef = useRef(null);
  return createElement(
    "div",
    { ref: rootRef, style: { height: "100%", overflow: "auto" } },
    createElement(MarkdownSelectionTooltip, {
      scopeKey: {},
      rootRef,
      sourceKey: "notes.md",
      sourceTitle: "notes.md",
      target: { sessionId: null, workspaceKey: "/fake/watch-workspace" },
    }),
    createElement(
      "p",
      { id: "plain-paragraph" },
      "浮条根容器内的普通段落文本，用于对照：这里的选区照常出现浮条。",
    ),
    createElement(BoardPaneView, {
      state: { kind: "ready", board: outcome.board },
      viewMode: "list",
    }),
  );
}

createRoot(document.getElementById("host")).render(
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(Root, null)),
);
`;

export const NESTED_DRIVER = `
(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
${SELECTION_PRELUDE}
  await waitFor(() => document.querySelector("[data-board-pane]"), "看板面板渲染");
  await sleep(200);
  const out = {};

  // ① 容器内的看板面板里造选区：豁免判据（#64）。
  const boardPane = document.querySelector("[data-board-pane]");
  const boardText = selectTextIn(boardPane, 2);
  await settleToolbar();
  out.board = {
    selectedText: boardText,
    toolbarPresent: !!toolbar(),
    toolbarText: toolbar() ? toolbar().textContent : null,
  };

  // ② 同一容器内的普通段落造选区：浮条照常（豁免不误伤）。
  window.getSelection().removeAllRanges();
  await settleToolbar();
  const paragraph = document.getElementById("plain-paragraph");
  const paragraphText = selectTextIn(paragraph, 2);
  await settleToolbar();
  out.plain = {
    selectedText: paragraphText,
    toolbarPresent: !!toolbar(),
    toolbarText: toolbar() ? toolbar().textContent : null,
  };

  out.ua = navigator.userAgent;
  return out;
})()
`;
