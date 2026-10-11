/* oxlint-disable eslint(max-lines) -- 真引擎驱动脚本 = 客户端入口 + 完整用户路径点击/量取的分步驱动，共享同一份页面内 __settingsSnapshot/__updateCalls 状态，拆分会割裂场景（#202 采纳归档 E2E 补丁后超限；同 src 中同类文件处理）。 */
/**
 * 卡 #62 浏览器断言脚本的**驱动层**（与 `boardV21BrowserScenariosDrivers.ts` 同款分层）：
 * 页面内客户端入口（真组件挂载 + 真设置通路）与页面内驱动脚本（点击序列、量取）在这里单点导出，
 * 断言留在 `boardExperimentsSettingsBrowser.ts`。
 */
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";

export const VIEW_MODES = ["tree", "kanban", "list", "table"] as const;
export const SETTINGS_HOST_ID = "host-settings";
export const PANEL_HOST_ID = "host-panel";

/**
 * 客户端入口：
 *  ① 设置宿主 = 真实 `createSettingsPageConfig()` 输出的导航（`TID_SETTINGS_SECTION_NAV` 锚点与真设置页同源）
 *     + 点开分区后渲染真实 `ExperimentsSection`；
 *  ② 面板宿主 = 真实 `AnimatedSidePanePanel`（空态 launcher 入口 + 打开看板 tab）。
 * 两宿主共享同一份 settingService/platform：开关写读就是产品通路本身（settingService.update
 * → platform.onSettingsChanged → useSettings 刷新）。
 */
export const BOARD_EXPERIMENTS_SETTINGS_CLIENT_ENTRY = `
import * as React from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedSidePanePanel } from "./src/app-shell/AnimatedSidePanePanel.js";
import { ExperimentsSection } from "./src/settings/ExperimentsSection.js";
import { createSettingsPageConfig } from "./src/settings/settingsPageConfig.js";
import { ResizablePanelGroup } from "./src/components/ui/resizable.js";
import { resolveBoardJsonPath } from "./src/board/loadBoardDocument.js";
import { PlatformProvider } from "./src/hooks/usePlatform.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider, useZCodeIntl } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";
import { TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared";

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
let settings = { recentProjects: [], experimentalProjectBoardEnabled: false };
const settingsListeners = new Set();
const updateCalls = [];
const settingService = {
  // 每次都返回一份新的快照对象：读到的东西必须是「重新读出来」的值，不是渲染缓存。
  get: async () => ({ ...settings }),
  update: async (patch) => {
    updateCalls.push(patch);
    settings = { ...settings, ...patch };
    settingsListeners.forEach((listener) => listener());
  },
};
globalThis.__settingsSnapshot = () => ({ ...settings });
globalThis.__updateCalls = () => updateCalls.map((patch) => ({ ...patch }));
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
    onRefreshGit: noop,
    onBrowserNavigationRequestHandled: noop,
    onBrowserUrlChange: noop,
    onBrowserPageMetadataChange: noop,
    onSelectGitSource: noop,
  };
}

/** 设置宿主：导航条目来自真实 createSettingsPageConfig（TID 锚点与真页同源），
    分区内容渲染真实 ExperimentsSection。点导航 = 用户打开分区那一步。 */
function SettingsShell() {
  const { intl } = useZCodeIntl();
  const [activeSection, setActiveSection] = React.useState("general");
  const { settingsSectionGroups } = React.useMemo(() => createSettingsPageConfig(), []);
  const sections = settingsSectionGroups.flatMap((group) => group.sections);
  return createElement("div", { "data-settings-shell": "true", "data-active-section": activeSection,
      className: "flex h-full min-h-0 w-[520px] flex-col gap-2 overflow-auto p-3" },
    createElement("nav", { "data-settings-nav": "true", className: "flex flex-wrap gap-1" },
      sections.map((section) => createElement("button", {
        key: section.id,
        type: "button",
        "data-testid": testId(TID_SETTINGS_SECTION_NAV, section.id),
        className: "rounded-md border px-2 py-1",
        onClick: () => setActiveSection(section.id),
      }, intl.formatMessage({ id: section.titleId }))),
    ),
    activeSection === "experiments"
      ? createElement("section", { "data-settings-section": "experiments" },
          createElement(ExperimentsSection, null))
      : createElement("div", { "data-settings-section": activeSection }),
  );
}

/** 面板宿主：side pane 状态归属宿主（真实 app 里是 useAppPanels 的 registry）。
    「打开看板」= 激活 workspace 级单例看板 tab（与 activateBoardSidePane 同语义）。 */
function PanelHost() {
  const [sidePaneState, setSidePaneState] = React.useState({ tabs: [], activeTabId: "" });
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

createRoot(document.getElementById("${SETTINGS_HOST_ID}")).render(
  createElement(PlatformProvider, { platform, children:
    createElement(ServiceProvider, { services, children:
      createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children:
        createElement(SettingsShell, null),
      }),
    }),
  }),
);
createRoot(document.getElementById("${PANEL_HOST_ID}")).render(
  createElement(PlatformProvider, { platform, children:
    createElement(ServiceProvider, { services, children:
      createElement(TabStoreProvider, { children:
        createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children:
          createElement(PanelHost, null),
        }),
      }),
    }),
  }),
);
`;

export interface ExperimentsSettingsChainResult {
  ua: string;
  initial: {
    navCount: number;
    navLabel: string;
    sectionRendered: boolean;
    switchRendered: boolean;
    boardEntry: boolean;
    boardPane: boolean;
    settingsValue: boolean;
  };
  afterNav: {
    switchPresent: boolean;
    switchCount: number;
    switchAriaChecked: string | null;
    boardSwitchAriaLabel: string | null;
    flowSwitchAriaLabel: string | null;
    rowText: string;
    noticePresent: boolean;
    boardEntry: boolean;
  };
  afterEnable: {
    settingsValue: boolean;
    updateCalls: Array<Record<string, unknown>>;
    switchAriaChecked: string | null;
    boardEntry: boolean;
    boardPane: boolean;
  };
  views: Record<string, boolean>;
  overflow: { clientW: number; scrollW: number; overflows: boolean };
  afterDisable: {
    settingsValue: boolean;
    updateCalls: Array<Record<string, unknown>>;
    switchAriaChecked: string | null;
    sectionVisible: boolean;
    noticePresent: boolean;
    boardEntry: boolean;
    boardPane: boolean;
    boardTrigger: boolean;
  };
  /** 板关+流开（「来料厂」）：说明行必须出现，且板入口保持零。 */
  afterFlowEnable: {
    settingsValue: boolean;
    updateCalls: Array<Record<string, unknown>>;
    flowSwitchAriaChecked: string | null;
    boardSwitchAriaChecked: string | null;
    flowSwitchAriaLabel: string | null;
    switchCount: number;
    noticePresent: boolean;
    noticeText: string;
    noticeHasSwitch: boolean;
    boardEntry: boolean;
    boardPane: boolean;
    sectionOverflow: {
      clientW: number;
      scrollW: number;
      overflows: boolean;
      box: { left: number; right: number };
    };
    hostOverflow: {
      clientW: number;
      scrollW: number;
      overflows: boolean;
      box: { left: number; right: number };
    };
  };
  /** 回到板关+流关：说明行必须消失（乘积态第三格）。 */
  afterFlowDisable: {
    settingsValue: boolean;
    updateCalls: Array<Record<string, unknown>>;
    flowSwitchAriaChecked: string | null;
    boardSwitchAriaChecked: string | null;
    noticePresent: boolean;
    boardEntry: boolean;
    sectionVisible: boolean;
  };
}

/**
 * 页面内驱动脚本：完整用户路径的点击与量取（判据在 boardExperimentsSettingsBrowser.ts）。
 * 所有点击（导航条目 / 开关 / 面板入口 / 视图切换控件）都走 kit 的 `dispatchPointerClick`
 * 完整指针序列，不用 `el.click()` 一步到位。
 */
export function boardExperimentsSettingsDriverSource(): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const settingsHost = document.getElementById("${SETTINGS_HOST_ID}");
  const panelHost = document.getElementById("${PANEL_HOST_ID}");
  const navItem = () => settingsHost.querySelector('[data-testid="settings-section-nav-experiments"]');
  const section = () => settingsHost.querySelector('[data-settings-section="experiments"]');
  const switchEl = () => (section() ? section().querySelector('[role="switch"]') : null);
  const switches = () => (section() ? Array.from(section().querySelectorAll('[role="switch"]')) : []);
  const flowSwitch = () => switches()[1] || null;
  // 乘积态说明行（#202）：按词条原文找承载文本自身的元素；找不到或为零尺寸盒 ⇒ 未显示。
  const noticeEl = () => {
    const s = section();
    const expected = String(globalThis.__ASK_MATT_NOTICE__ || "").trim();
    if (!s || !expected) return null;
    const hit = Array.from(s.querySelectorAll("div")).filter(
      (el) => (el.textContent || "").trim() === expected,
    );
    return (
      hit.find(
        (el) =>
          !Array.from(el.children).some((c) => (c.textContent || "").trim() === expected),
      ) || null
    );
  };
  const noticeVisible = () => {
    const el = noticeEl();
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0 ? el : null;
  };
  const boardEntry = () => panelHost.querySelector('[data-side-pane-open-tab-item="board"]');
  const boardPane = () => panelHost.querySelector("[data-board-pane]");
  const boardTrigger = () => panelHost.querySelector('[data-side-pane-tab-id="board"]');
  const waitForGone = async (read, label, timeoutMs) => {
    const limit = Date.now() + (timeoutMs || 15000);
    for (;;) {
      if (!read()) return;
      if (Date.now() > limit) throw new Error("等待超时（应消失）：" + label);
      await sleep(25);
    }
  };

  // ① 初始态：设置导航已有「实验功能」条目（阳性对照：条目不止一条），
  //    未点开分区 ⇒ 分区内容不渲染；看板开关默认关 ⇒ 侧边面板零看板入口。
  await waitFor(
    () => navItem() && settingsHost.querySelector('[data-testid="settings-section-nav-general"]'),
    "设置导航渲染",
  );
  await sleep(120);
  const initial = {
    navCount: settingsHost.querySelectorAll("nav button").length,
    navLabel: (navItem().textContent || "").trim(),
    sectionRendered: !!section(),
    switchRendered: !!switchEl(),
    boardEntry: !!boardEntry(),
    boardPane: !!boardPane(),
    settingsValue: globalThis.__settingsSnapshot().experimentalProjectBoardEnabled === true,
  };

  // ② 点开分区（真指针序列）：分区行渲染；等设置快照加载完（开关可交互），确认默认关。
  dispatchPointerClick(navItem());
  await waitFor(() => section() && switchEl(), "实验功能分区渲染");
  await waitFor(() => switchEl() && !switchEl().disabled, "开关可交互（设置快照已加载）");
  const row = section();
  const afterNav = {
    switchPresent: !!switchEl(),
    switchCount: switches().length,
    switchAriaChecked: switchEl().getAttribute("aria-checked"),
    boardSwitchAriaLabel: switches()[0] ? switches()[0].getAttribute("aria-label") : null,
    flowSwitchAriaLabel: switches()[1] ? switches()[1].getAttribute("aria-label") : null,
    rowText: (row.textContent || "").trim(),
    noticePresent: !!noticeEl(),
    boardEntry: !!boardEntry(),
  };

  // ③ 拨开（真指针序列点真 Switch）→ 真写 settings，侧边面板看板入口出现。
  dispatchPointerClick(switchEl());
  await waitFor(
    () => globalThis.__settingsSnapshot().experimentalProjectBoardEnabled === true,
    "设置写入 true",
  );
  await waitFor(() => boardEntry(), "看板入口出现");
  const afterEnable = {
    settingsValue: globalThis.__settingsSnapshot().experimentalProjectBoardEnabled === true,
    updateCalls: globalThis.__updateCalls(),
    switchAriaChecked: switchEl().getAttribute("aria-checked"),
    boardEntry: !!boardEntry(),
    boardPane: !!boardPane(),
  };

  // ④ 点入口（真指针序列）→ 面板挂载 → 四视图逐个切换（每次切换都派发真指针序列）。
  dispatchPointerClick(boardEntry());
  await waitFor(() => boardPane(), "看板面板挂载");
  const views = {};
  for (const mode of ${JSON.stringify(VIEW_MODES)}) {
    const option = await waitFor(
      () => boardPane().querySelector('[data-board-view-option="' + mode + '"]'),
      "视图切换控件 " + mode,
    );
    dispatchPointerClick(option);
    await waitFor(
      () => boardPane().querySelector('[data-board-view="' + mode + '"]'),
      "视图渲染 " + mode,
    );
    views[mode] = !!boardPane().querySelector('[data-board-view="' + mode + '"]');
  }
  const overflow = probeOverflow(boardPane());

  // ⑤ 拨关（同一条指针序列点同一个 Switch）→ 设置写回 false，入口/面板/tab 即时消失。
  dispatchPointerClick(switchEl());
  await waitFor(
    () => globalThis.__settingsSnapshot().experimentalProjectBoardEnabled === false,
    "设置写回 false",
  );
  await waitForGone(
    () => boardEntry() || boardPane() || boardTrigger(),
    "关闭后看板入口/面板/tab 全部消失",
  );
  await sleep(120);
  const afterDisable = {
    settingsValue: globalThis.__settingsSnapshot().experimentalProjectBoardEnabled === true,
    updateCalls: globalThis.__updateCalls(),
    switchAriaChecked: switchEl().getAttribute("aria-checked"),
    sectionVisible: !!section(),
    noticePresent: !!noticeEl(),
    boardEntry: !!boardEntry(),
    boardPane: !!boardPane(),
    boardTrigger: !!boardTrigger(),
  };

  // ⑥ 板关+流开（「来料厂」）：拨**第二个**开关（ask-matt 流程），板保持关 ⇒
  //    设置真写入 + 分区出现独立说明行；板入口/面板保持零。
  await waitFor(() => flowSwitch() && !flowSwitch().disabled, "流程开关可交互");
  dispatchPointerClick(flowSwitch());
  await waitFor(
    () => globalThis.__settingsSnapshot().experimentalAskMattFlowEnabled === true,
    "流程设置写入 true",
  );
  await waitFor(() => noticeVisible(), "板关+流开说明行出现");
  await waitFor(() => flowSwitch() && !flowSwitch().disabled, "流程开关可交互（写入后）");
  const afterFlowEnable = {
    settingsValue: globalThis.__settingsSnapshot().experimentalAskMattFlowEnabled === true,
    updateCalls: globalThis.__updateCalls(),
    flowSwitchAriaChecked: flowSwitch().getAttribute("aria-checked"),
    boardSwitchAriaChecked: switches()[0].getAttribute("aria-checked"),
    flowSwitchAriaLabel: flowSwitch().getAttribute("aria-label"),
    switchCount: switches().length,
    noticePresent: !!noticeEl(),
    noticeText: (noticeEl().textContent || "").trim(),
    noticeHasSwitch: !!noticeEl().querySelector('[role="switch"]'),
    boardEntry: !!boardEntry(),
    boardPane: !!boardPane(),
    sectionOverflow: probeOverflow(section()),
    hostOverflow: probeOverflow(settingsHost),
  };

  // ⑦ 拨回关（板保持关）：说明行必须消失，分区仍在。
  await waitFor(() => switches()[1] && !switches()[1].disabled, "流程开关可交互（第 ⑦ 步）");
  dispatchPointerClick(switches()[1]);
  await waitFor(
    () => globalThis.__settingsSnapshot().experimentalAskMattFlowEnabled === false,
    "流程设置写回 false",
  );
  await waitForGone(() => noticeEl(), "关流后说明行消失");
  await waitFor(() => switches()[1] && !switches()[1].disabled, "流程开关可交互（关）");
  await sleep(120);
  const afterFlowDisable = {
    settingsValue: globalThis.__settingsSnapshot().experimentalAskMattFlowEnabled === true,
    updateCalls: globalThis.__updateCalls(),
    flowSwitchAriaChecked: switches()[1].getAttribute("aria-checked"),
    boardSwitchAriaChecked: switches()[0].getAttribute("aria-checked"),
    noticePresent: !!noticeEl(),
    boardEntry: !!boardEntry(),
    sectionVisible: !!section(),
  };

  return {
    ua: navigator.userAgent,
    initial,
    afterNav,
    afterEnable,
    views,
    overflow,
    afterDisable,
    afterFlowEnable,
    afterFlowDisable,
  };
})()`;
}
