/**
 * 卡 #58 的**浏览器行为断言**：实验开关（默认关）下的看板入口/面板显隐与开→关即时生效。
 *
 * 独立脚本，文件名不含 `.test.`（与 `boardKanbanBrowserLayout.ts` / `boardV21BrowserScenarios.ts`
 * 同款：`node --test` 常规套件不收它；由本卡验证显式执行）。
 *
 * 为什么 SSR/纯函数不算数：开关的读取通路是**异步 settings store + useEffect 订阅**
 * （`useSettings()` + `platform.onSettingsChanged`），SSR 不跑 effect，只能覆盖「设置未加载」这一格；
 * 「模拟开启 → 入口出现 → 派发真指针序列打开面板 → 再关掉即时消失」只有真引擎 + 真事件量得出来。
 *
 * 两个宿主（同一页两个面板，同一份设置快照）：
 *   ① 无 tab：走「打开标签页」launcher 面（入口零渲染 → 开启后入口出现 → 点击打开面板）；
 *   ② 残留看板 tab（会话恢复形态）：内存里本就有 board tab ⇒ 关闭态不得留下空 tab/面板，
 *      开启后该 tab 恢复可用。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析复用 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardExperimentGateBrowser.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compile } from "@tailwindcss/node";
import { build as esbuild } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { SidePaneOpenTabLauncher } from "../src/app-shell/SidePaneOpenTabLauncher.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";
import {
  HOST_HEIGHT,
  resolveElectronBinary,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

const CLIENT_ENTRY = `
import * as React from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedSidePanePanel } from "./src/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanelGroup } from "./src/components/ui/resizable.js";
import { resolveBoardJsonPath } from "./src/board/loadBoardDocument.js";
import { PlatformProvider } from "./src/hooks/usePlatform.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";

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

/** 真设置通路：settingService + platform.onSettingsChanged ⇒ useSettings() 的刷新订阅。 */
let settings = { experimentalProjectBoardEnabled: false };
const settingsListeners = new Set();
const settingService = {
  get: async () => settings,
  update: async (patch) => {
    settings = { ...settings, ...patch };
    settingsListeners.forEach((listener) => listener());
  },
};
const platform = {
  onSettingsChanged: (callback) => {
    settingsListeners.add(callback);
    return () => settingsListeners.delete(callback);
  },
  syncAppSettings: () => {},
};
const fileService = {
  checkFilesExist: async (params) => params.paths.map((p) => ({ path: p, exists: p === boardPath })),
  readTextFile: async () => slice,
};
const services = { fileService, settingService };

globalThis.__setProjectBoardEnabled = (enabled) => {
  settings = { ...settings, experimentalProjectBoardEnabled: enabled };
  settingsListeners.forEach((listener) => listener());
};

const noop = () => {};
function panelProps(sidePaneState) {
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
    onActivateTab: noop,
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
    onOpenSquadRunSession: noop,
    onRefreshGit: noop,
    onBrowserNavigationRequestHandled: noop,
    onBrowserUrlChange: noop,
    onBrowserPageMetadataChange: noop,
    onSelectGitSource: noop,
  };
}

/** 宿主：面板的 side pane 状态归属宿主（真实 app 里是 useAppPanels 的 registry）。
    「打开看板」= 激活 workspace 级单例看板 tab（与 activateBoardSidePane 同语义）。 */
function Host({ initialSidePaneState }) {
  const [sidePaneState, setSidePaneState] = React.useState(initialSidePaneState);
  const onOpenBoard = () =>
    setSidePaneState((current) => ({
      tabs: current.tabs.some((tab) => tab.id === "board")
        ? current.tabs
        : [...current.tabs, { id: "board", type: "board", openedAt: 1 }],
      activeTabId: "board",
    }));
  const props = { ...panelProps(sidePaneState), onOpenBoard };
  return createElement(ResizablePanelGroup, {
    direction: "horizontal",
    style: { height: "100%" },
    children: createElement(AnimatedSidePanePanel, props),
  });
}

function mountPanel(hostId, initialSidePaneState) {
  createRoot(document.getElementById(hostId)).render(
    createElement(PlatformProvider, { platform, children:
      createElement(ServiceProvider, { services, children:
        createElement(TabStoreProvider, { children:
          createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children:
            createElement(Host, { initialSidePaneState }),
          }),
        }),
      }),
    }),
  );
}
mountPanel("host-empty", { tabs: [], activeTabId: "" });
mountPanel("host-residual", { tabs: [{ id: "board", type: "board", openedAt: 1 }], activeTabId: "board" });
`;

interface GateResult {
  ua: string;
  closed: {
    emptyLauncherWiki: boolean;
    emptyBoardEntry: boolean;
    emptyBoardPane: boolean;
    residualBoardTrigger: boolean;
    residualBoardPane: boolean;
    residualWikiEntry: boolean;
  };
  afterEnable: {
    launcherBoardEntry: boolean;
    clickedOpenedPane: boolean;
    clickedOpenedTabTrigger: boolean;
    residualBoardTrigger: boolean;
    residualBoardPane: boolean;
  };
  afterDisable: {
    launcherBoardEntry: boolean;
    boardPane: boolean;
    boardTrigger: boolean;
    residualBoardPane: boolean;
    residualBoardTrigger: boolean;
    wikiEntry: boolean;
  };
}

function gateDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const empty = document.getElementById("host-empty");
  const residual = document.getElementById("host-residual");
  const queryIn = (root, selector) => (root ? root.querySelector(selector) : null);
  const boardPaneIn = (root) => queryIn(root, "[data-board-pane]");
  const boardEntryIn = (root) => queryIn(root, '[data-side-pane-open-tab-item="board"]');
  const boardTriggerIn = (root) => queryIn(root, '[data-side-pane-tab-id="board"]');
  const wikiEntryIn = (root) => queryIn(root, '[data-side-pane-open-tab-item="wiki"]');
  const waitForGone = async (read, label, timeoutMs) => {
    const limit = Date.now() + (timeoutMs || 15000);
    for (;;) {
      if (!read()) return;
      if (Date.now() > limit) throw new Error("等待超时（应消失）：" + label);
      await sleep(25);
    }
  };

  // ① 关态（设置默认关；两个宿主都已挂载）
  await waitFor(() => wikiEntryIn(residual) && wikiEntryIn(empty), "两个宿主的 launcher");
  await sleep(120);
  const closed = {
    emptyLauncherWiki: !!wikiEntryIn(empty),
    emptyBoardEntry: !!boardEntryIn(empty),
    emptyBoardPane: !!boardPaneIn(empty),
    residualBoardTrigger: !!boardTriggerIn(residual),
    residualBoardPane: !!boardPaneIn(residual),
    residualWikiEntry: !!wikiEntryIn(residual),
  };

  // ② 模拟开启：走真实设置通路（settingService.update → platform.onSettingsChanged → useSettings 刷新）
  globalThis.__setProjectBoardEnabled(true);
  const entry = await waitFor(() => boardEntryIn(empty), "开启后 launcher 里的看板入口");
  const afterEnable = {
    launcherBoardEntry: !!entry,
    clickedOpenedPane: false,
    clickedOpenedTabTrigger: false,
    residualBoardTrigger: !!boardTriggerIn(residual),
    residualBoardPane: !!boardPaneIn(residual),
  };

  // ③ 派发完整指针序列（pointerdown → mousedown → pointerup → mouseup → click）打开面板
  dispatchPointerClick(entry);
  await waitFor(() => boardPaneIn(empty), "点击后看板面板挂载");
  afterEnable.clickedOpenedPane = !!boardPaneIn(empty);
  afterEnable.clickedOpenedTabTrigger = !!boardTriggerIn(empty);

  // ④ 开→关：即时生效，零渲染
  globalThis.__setProjectBoardEnabled(false);
  await waitForGone(
    () => boardEntryIn(empty) || boardPaneIn(empty) || boardTriggerIn(empty) || boardPaneIn(residual) || boardTriggerIn(residual),
    "关闭后看板入口/面板/tab 全部消失",
  );
  await sleep(120);
  const afterDisable = {
    launcherBoardEntry: !!boardEntryIn(empty),
    boardPane: !!boardPaneIn(empty),
    boardTrigger: !!boardTriggerIn(empty),
    residualBoardPane: !!boardPaneIn(residual),
    residualBoardTrigger: !!boardTriggerIn(residual),
    wikiEntry: !!wikiEntryIn(empty),
  };

  return { ua: navigator.userAgent, closed, afterEnable, afterDisable };
})()`;
}

/** 页面：两个宿主上下排列，真 Tailwind 产物 CSS（面板 + launcher 的真实类名取并集）。 */
async function buildPage(boardJson: string): Promise<string> {
  const cssSource = readFileSync(path.join(UI_DIR, "src", "styles.css"), "utf8");
  const compiler = await compile(cssSource, {
    base: path.join(UI_DIR, "src"),
    onDependency: () => {},
  });
  const candidates = new Set<string>();
  const collect = (markup: string) => {
    for (const match of markup.matchAll(/class="([^"]*)"/g)) {
      for (const token of (match[1] ?? "").split(/\s+/)) if (token) candidates.add(token);
    }
  };
  collect(
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN" as const,
        children: createElement(SidePaneOpenTabLauncher, {
          items: [
            {
              id: "file-tree" as const,
              label: "文件树",
              icon: (() => null) as never,
              onOpen: () => {},
            },
            { id: "wiki" as const, label: "wiki", icon: (() => null) as never, onOpen: () => {} },
            {
              id: "board" as const,
              label: "项目看板",
              icon: (() => null) as never,
              onOpen: () => {},
            },
          ],
        }),
      }),
    ),
  );
  const outcome = parseBoardJson(boardJson);
  if (outcome.kind !== "ready") {
    throw new Error("夹具必须是可解析的 v2 板");
  }
  const board = outcome.board;
  collect(
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN" as const,
        children: createElement(BoardPaneView, {
          state: { kind: "ready" as const, board },
          viewMode: "kanban",
          onRefresh: () => {},
        }),
      }),
    ),
  );
  const css = compiler.build([...candidates]);
  const bundle = await esbuild({
    stdin: { contents: CLIENT_ENTRY, resolveDir: UI_DIR, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: path.join(UI_DIR, "tsconfig.json"),
    // 面板宿主依赖整条重组件链：图片资产内联为 data URL、CSS 侧文件视为空（本页样式由
    // 下面编译出的真 Tailwind 产物提供），让「真组件 + 真事件」在页面里跑起来。
    loader: {
      ".png": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".gif": "dataurl",
      ".webp": "dataurl",
      ".svg": "dataurl",
      ".css": "empty",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
      ".wasm": "dataurl",
    },
    define: { "process.env.NODE_ENV": '"production"' },
    // 字面 `?url` 资源（pdf worker 等）在浏览器里只当占位串：本场景不碰这些功能面。
    plugins: [
      {
        name: "zcode-url-asset-stub",
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "zcode-url-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "zcode-url-stub" }, () => ({
            contents: "export default '';",
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  const bundleText = bundle.outputFiles?.[0]?.text;
  if (!bundleText) throw new Error("esbuild 应产出 bundle");
  const boardJsonLiteral = JSON.stringify(boardJson).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-experiment-gate</title>
<style>${css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="host-empty" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1200px;overflow:hidden"></div>
<div id="host-residual" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1200px;overflow:hidden"></div>
<script>globalThis.__BOARD_JSON__=${boardJsonLiteral};</script>
<script>${bundleText.replaceAll("</script", "<\\/script")}</script>
</body></html>`;
}

async function main(): Promise<void> {
  // 真产物前提：Electron 二进制不在就显式报错（同上位门禁：UI 卡无浏览器证据不得进待合并）。
  resolveElectronBinary();
  const boardJson = JSON.stringify(STAGE_MATRIX_BOARD);
  const result = (await runBoardPaneInElectron({
    pageHtml: await buildPage(boardJson),
    driver: gateDriverSource(),
    label: "board-experiment-gate",
  })) as GateResult;

  // ① 关态：入口/面板/空 tab 三处零渲染（阳性对照：launcher 与 wiki 入口在场）。
  assert.equal(
    result.closed.emptyLauncherWiki,
    true,
    "阳性对照：关态 launcher 应渲染（wiki 入口）",
  );
  assert.equal(result.closed.emptyBoardEntry, false, "关态 launcher 不得有看板入口");
  assert.equal(result.closed.emptyBoardPane, false, "关态不得挂载看板面板");
  assert.equal(result.closed.residualBoardTrigger, false, "关态残留 tab 不得复活成空 tab");
  assert.equal(result.closed.residualBoardPane, false, "关态残留 tab 不得挂载面板");
  assert.equal(
    result.closed.residualWikiEntry,
    true,
    "阳性对照：残留宿主同样走 launcher（tab 被裁掉后为空）",
  );

  // ② 模拟开启：入口出现（走真实设置通路），残留 tab 也恢复。
  assert.equal(result.afterEnable.launcherBoardEntry, true, "开启后 launcher 必须出现看板入口");
  assert.equal(result.afterEnable.residualBoardTrigger, true, "开启后残留看板 tab 恢复为可见 tab");

  // ③ 派发完整指针序列：面板真的挂载。
  assert.equal(result.afterEnable.clickedOpenedPane, true, "点击入口后看板面板必须挂载");
  assert.equal(result.afterEnable.clickedOpenedTabTrigger, true, "打开后应有对应的活动 tab");

  // ④ 开→关：即时生效、零渲染（入口/面板/tab 全消失，其它入口不受影响）。
  assert.equal(result.afterDisable.launcherBoardEntry, false, "关闭后看板入口必须消失");
  assert.equal(result.afterDisable.boardPane, false, "关闭后看板面板必须卸载");
  assert.equal(result.afterDisable.boardTrigger, false, "关闭后不得留下看板 tab");
  assert.equal(result.afterDisable.residualBoardPane, false, "关闭后残留宿主的面板也必须卸载");
  assert.equal(result.afterDisable.residualBoardTrigger, false, "关闭后残留 tab 也不得显示");
  assert.equal(result.afterDisable.wikiEntry, true, "阳性对照：其它入口不受开关影响");

  console.log(
    `BOARD_EXPERIMENT_GATE_ASSERTIONS_OK 关态=${JSON.stringify(result.closed)} 开启=${JSON.stringify(result.afterEnable)} 复关=${JSON.stringify(result.afterDisable)}`,
  );
}

await main();
