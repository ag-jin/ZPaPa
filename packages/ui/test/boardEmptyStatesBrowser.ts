/**
 * 卡 #158 / E1a-1 空态 A 二分 + 未连接保留快照的**浏览器行为断言**（真引擎 + 真 Tailwind
 * 产物 CSS + 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`（与 `boardFoldBrowser.ts`
 * 同款：`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：三态是首读 RPC 回来后的真实渲染结果；空态 A1/A2 的判据
 * 分别来自真宿主加载链（板本体缺失 × 板产物在场/不在场）；「未连接保留上次快照 / 不发无效
 * RPC / 恢复自动重读」是服务解析与连接门禁的真实状态迁移——只有真宿主 + 真事件链才是行为证据；
 * 窄档不溢出是排版行为。
 *
 * 四组证据（对应卡文验收「三态渲染路径 + 夹具红绿」）：
 *   1. A1 新生（真 DOM 锚点/文案/刷新点击路由/溢出探针）；
 *   2. A2 板文件缺失（同上，锚点与文案必须是另一副面孔）；
 *   3. 加载态与暂时不可读互不混同（锚点与文案分开）；
 *   4. 未连接保留快照（远程会话注册表真迁移：就绪 → 断连 → 未就绪刷新不发无效 RPC → 恢复自动重读）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardEmptyStatesBrowser.ts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build as esbuild } from "esbuild";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import {
  emptyStateDriverSource,
  loadingStateDriverSource,
  unavailableSnapshotDriverSource,
} from "./boardEmptyStatesBrowserDrivers.js";
import {
  compileBoardPaneCss,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

const HOST_HEIGHT = 620;

/* ---------------- 页面：真组件 bundle（宿主 + 假文件服务 + 可驱动远程会话表） ---------------- */

const CLIENT_ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BoardPane } from "./src/board/BoardPane.js";
import { resolveBoardArtifactPaths, resolveBoardJsonPath } from "./src/board/loadBoardDocument.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "./src/store/remoteWorkspaceSessionStore.js";

const WORKSPACE_PATH = "/fake/empty-state-workspace";
const WORKSPACE_IDENTITY = "host:/fake/empty-state-workspace";
const SESSION_ID = "sess-e1a-empty-states";
const scenario = globalThis.__E1A_SCENARIO__ ?? "missing-new";
const boardPath = resolveBoardJsonPath(WORKSPACE_PATH);
const artifactPaths = resolveBoardArtifactPaths(WORKSPACE_PATH);
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
// 场景在册路径：A2 = 只有板产物（board.md）在场；unavailable = 板本体在（先就绪）。
const presentPaths = new Set();
if (scenario === "missing-damaged") presentPaths.add(artifactPaths[0]);
if (scenario === "unavailable") presentPaths.add(boardPath);
globalThis.__E1A_READ_COUNT__ = 0;
const fileService = {
  checkFilesExist: async (params) => {
    // 加载态可观察场景：把首读挂住，真 DOM 上留下「加载占位」这一段。
    if (scenario === "loading" && globalThis.__E1A_READ_COUNT__ === 0) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    globalThis.__E1A_READ_COUNT__ += 1;
    return params.paths.map((path) => ({ path, exists: presentPaths.has(path) }));
  },
  readTextFile: async () => slice,
};
// 远程会话注册表驱动：断连 = 注销会话（连接未就绪）；恢复 = 重新注册 + 绑定 identity。
const registerSession = () => {
  registerRemoteWorkspaceSession({ sessionId: SESSION_ID, services: { fileService } });
  bindRemoteWorkspaceIdentity(WORKSPACE_IDENTITY, SESSION_ID);
};
globalThis.__E1A_DROP__ = () => unregisterRemoteWorkspaceSession(SESSION_ID);
globalThis.__E1A_RECOVER__ = registerSession;
if (scenario === "unavailable") registerSession();

const host = document.getElementById("host");
const paneProps =
  scenario === "unavailable"
    ? { workspacePath: WORKSPACE_PATH, workspaceIdentity: WORKSPACE_IDENTITY, focused: true }
    : { workspacePath: WORKSPACE_PATH, focused: true };
createRoot(host).render(
  createElement(
    ServiceProvider,
    { services: { fileService } },
    createElement(
      TabStoreProvider,
      null,
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(BoardPane, paneProps),
      }),
    ),
  ),
);
`;

async function bundleScenarioClient(): Promise<string> {
  const build = await esbuild({
    stdin: { contents: CLIENT_ENTRY, resolveDir: UI_DIR, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: `${UI_DIR}/tsconfig.json`,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const output = build.outputFiles?.[0]?.text;
  if (!output) throw new Error("esbuild 应产出 bundle");
  return output;
}

function buildScenarioPage(params: {
  css: string;
  boardJson: string;
  scenario: string;
  bundle: string;
}): string {
  const boardJsonLiteral = JSON.stringify(params.boardJson).replaceAll("<", "\\u003c");
  const scenarioLiteral = JSON.stringify(params.scenario).replaceAll("<", "\\u003c");
  const bundle = params.bundle.replaceAll("</script", "<\\/script");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-empty-states</title>
<style>${params.css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="host" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1400px;overflow:hidden"></div>
<script>globalThis.__BOARD_JSON__=${boardJsonLiteral};globalThis.__E1A_SCENARIO__=${scenarioLiteral};</script>
<script>${bundle}</script>
</body></html>`;
}

/* ---------------- 类名收集（占位态/状态行不在 ready 渲染里） ---------------- */

function collectClassNames(markup: string): string[] {
  const names: string[] = [];
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token) names.push(token);
    }
  }
  return names;
}

/* ---------------- 量取结果形状（驱动 ↔ 断言） ---------------- */

interface EmptyStateScenarioResult {
  ua: string;
  anchor: string | null;
  text: string | null;
  noticeText: string | null;
  placeholderProbe: {
    node: BoardBrowserOverflowProbe | null;
    box: BoardBrowserOverflowProbe | null;
  };
  narrowProbe: { node: BoardBrowserOverflowProbe | null; box: BoardBrowserOverflowProbe | null };
  loadingAnchorPresent: boolean;
  readsBefore: number;
  afterRefresh: { anchor: string | null; text: string | null; readCount: number };
  windowWidthAtNarrow: number;
}

interface LoadingScenarioResult {
  ua: string;
  loading: {
    text: string;
    probe: BoardBrowserOverflowProbe;
    emptyAnchorPresent: boolean;
    refreshPresent: boolean;
  };
  settled: { anchor: string | null; text: string | null; loadingAnchorPresent: boolean };
  hostWidth: number;
}

interface UnavailableScenarioResult {
  ua: string;
  ready: { cardText: string | null; noticeText: string | null; readCount: number };
  dropped: {
    cardText: string | null;
    noticeText: string | null;
    placeholderAnchor: string | null;
    readCount: number;
    noticeProbe: BoardBrowserOverflowProbe | null;
    paneProbe: BoardBrowserOverflowProbe | null;
  };
  afterRefreshWhileDropped: {
    cardText: string | null;
    noticeText: string | null;
    readCount: number;
  };
  recovered: { cardText: string | null; noticeText: string | null; readCount: number };
  narrowProbe: BoardBrowserOverflowProbe | null;
  windowWidthAtNarrow: number;
}

const EMPTY_STATE_COPY = {
  "missing-new": "本项目还没有看板。完成一次访谈登记或创建第一个 spec 后自动生成。",
  "missing-damaged": "板文件缺失（可能被删除或未同步），请在会话中运行编译器重建。",
} as const;

const SNAPSHOT_NOTICE_COPY =
  "连接未就绪：以下为上次读取的快照，可能已过期；连接恢复后会自动重读，也可以点右上角刷新重试。";

const UNREADABLE_COPY =
  "看板暂时不可读（连接未就绪）。连接恢复后会自动重读，也可以点右上角刷新重试。";

async function main(): Promise<void> {
  const boardJson = JSON.stringify(GOLDEN_SHAPED_BOARD);
  const outcome = parseBoardJson(boardJson);
  assert.equal(outcome.kind, "ready", "夹具必须是 v2 且 features 非空");

  // 产物 CSS：ready（树形，保留快照路径）+ 占位/状态行四态取并集。
  const extraClassNames: string[] = [];
  const placeholderStates: BoardPaneLoadState[] = [
    { kind: "missing-new" },
    { kind: "missing-damaged" },
    { kind: "unavailable" },
    { kind: "loading" },
  ];
  for (const state of placeholderStates) {
    extraClassNames.push(
      ...collectClassNames(
        renderToStaticMarkup(
          createElement(ZCodeIntlProvider, {
            initialLocale: "zh-CN" as const,
            children: createElement(BoardPaneView, { state, onRefresh: () => {} }),
          }),
        ),
      ),
    );
  }
  if (outcome.kind === "ready") {
    extraClassNames.push(
      ...collectClassNames(
        renderToStaticMarkup(
          createElement(ZCodeIntlProvider, {
            initialLocale: "zh-CN" as const,
            children: createElement(BoardPaneView, {
              state: { kind: "unavailable" },
              unavailableSnapshot: outcome.board,
            }),
          }),
        ),
      ),
    );
  }
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["tree"],
    extraClassNames,
  });
  const bundle = await bundleScenarioClient();

  /* ---- 场景 1/2：A1 新生 与 A2 板文件缺失（真宿主加载链） ---- */
  for (const scenario of ["missing-new", "missing-damaged"] as const) {
    const result = (await runBoardPaneInElectron({
      pageHtml: buildScenarioPage({ css, boardJson, scenario, bundle }),
      driver: emptyStateDriverSource(),
      label: `empty-${scenario}`,
    })) as EmptyStateScenarioResult;

    assert.equal(result.anchor, scenario, `${scenario}：占位锚点应是本态`);
    assert.equal(result.text, EMPTY_STATE_COPY[scenario], `${scenario}：逐字文案`);
    assert.equal(result.noticeText, null, `${scenario}：不是未连接态，不得带快照状态行`);
    assert.equal(result.loadingAnchorPresent, false, `${scenario}：占位态不得带加载锚点`);
    assert.ok(
      result.afterRefresh.readCount > result.readsBefore,
      `${scenario}：点击刷新必须真触发重读（读取缝计数 ${result.readsBefore} → ${result.afterRefresh.readCount}）`,
    );
    assert.equal(result.afterRefresh.anchor, scenario, `${scenario}：刷新后判定不变`);
    assert.equal(
      result.afterRefresh.text,
      EMPTY_STATE_COPY[scenario],
      `${scenario}：刷新后文案不变`,
    );
    assert.ok(result.placeholderProbe.node, `${scenario}：占位节点应可量`);
    assertNoHorizontalOverflow(result.placeholderProbe.node, `${scenario} 占位（宽档 1400）`);
    assert.equal(result.windowWidthAtNarrow, 360, `${scenario}：窄档宿主宽度应为 360`);
    assert.ok(result.narrowProbe.node, `${scenario}：窄档占位节点应可量`);
    assertNoHorizontalOverflow(result.narrowProbe.node, `${scenario} 占位（窄档 360）`);
    if (result.narrowProbe.box) {
      assertNoHorizontalOverflow(result.narrowProbe.box, `${scenario} 占位容器（窄档 360）`);
    }
    console.log(`[158] ${scenario} 浏览器断言通过（UA ${result.ua}）`);
  }

  /* ---- 场景 3：加载态可观察（延迟首读）与暂时不可读互不混同 ---- */
  const loading = (await runBoardPaneInElectron({
    pageHtml: buildScenarioPage({ css, boardJson, scenario: "loading", bundle }),
    driver: loadingStateDriverSource(),
    label: "loading-state",
  })) as LoadingScenarioResult;

  assert.equal(loading.loading.text, "正在读取看板…", "加载占位逐字");
  assert.notEqual(
    loading.loading.text,
    UNREADABLE_COPY,
    "加载态不得复用「暂时不可读」文案（两态可区分）",
  );
  assert.equal(
    loading.loading.emptyAnchorPresent,
    false,
    "加载态不得带占位/错误锚点（与暂时不可读分开）",
  );
  assert.ok(loading.loading.refreshPresent, "加载态刷新入口常驻（评审 #32-P5）");
  assertNoHorizontalOverflow(loading.loading.probe, "加载占位（宽档 1400）");
  assert.equal(loading.settled.anchor, "missing-new", "延迟首读落定后进入新生占位（加载不是终态）");
  assert.equal(loading.settled.text, EMPTY_STATE_COPY["missing-new"], "落定态文案");
  assert.equal(loading.settled.loadingAnchorPresent, false, "落定后加载锚点消失");
  console.log(`[158] loading-state 浏览器断言通过（UA ${loading.ua}）`);

  /* ---- 场景 4：未连接保留上次快照（远程会话注册表真迁移） ---- */
  const unavailable = (await runBoardPaneInElectron({
    pageHtml: buildScenarioPage({ css, boardJson, scenario: "unavailable", bundle }),
    driver: unavailableSnapshotDriverSource(),
    label: "unavailable-snapshot",
  })) as UnavailableScenarioResult;

  assert.ok(
    unavailable.ready.cardText?.includes("预览发布通道（workflow）"),
    `先决条件：远程会话在场时应先就绪（实测 ${String(unavailable.ready.cardText)}）`,
  );
  assert.equal(unavailable.ready.noticeText, null, "就绪态不得有快照状态行");
  assert.equal(
    unavailable.dropped.placeholderAnchor,
    null,
    "断连但有快照：不落占位态（E7 §7.2 保留上次快照）",
  );
  assert.equal(
    unavailable.dropped.cardText,
    unavailable.ready.cardText,
    "断连不清空版面：内容仍是上次快照",
  );
  assert.equal(unavailable.dropped.noticeText, SNAPSHOT_NOTICE_COPY, "快照状态行逐字");
  assert.equal(
    unavailable.dropped.readCount,
    unavailable.ready.readCount,
    "未就绪时不得发无效 RPC（断连重渲染不计读取）",
  );
  assert.equal(
    unavailable.afterRefreshWhileDropped.readCount,
    unavailable.dropped.readCount,
    "未就绪时点刷新也不发无效 RPC（门禁在读取时刻取值）",
  );
  assert.equal(
    unavailable.afterRefreshWhileDropped.cardText,
    unavailable.ready.cardText,
    "未就绪刷新后快照仍在",
  );
  assert.equal(
    unavailable.afterRefreshWhileDropped.noticeText,
    SNAPSHOT_NOTICE_COPY,
    "未就绪刷新后状态行仍在",
  );
  assert.equal(unavailable.recovered.noticeText, null, "连接恢复后状态行消失");
  assert.ok(
    unavailable.recovered.readCount > unavailable.afterRefreshWhileDropped.readCount,
    "连接恢复必须自动重读（不靠用户手点）",
  );
  assert.equal(unavailable.recovered.cardText, unavailable.ready.cardText, "恢复后内容仍在");
  assert.ok(unavailable.dropped.noticeProbe, "快照状态行应可量");
  assertNoHorizontalOverflow(unavailable.dropped.noticeProbe, "快照状态行（宽档 1400）");
  assert.ok(unavailable.dropped.paneProbe, "面板根应可量");
  assertNoHorizontalOverflow(unavailable.dropped.paneProbe, "面板根（宽档 1400）");
  assert.equal(unavailable.windowWidthAtNarrow, 360, "窄档宿主宽度应为 360");
  assert.ok(unavailable.narrowProbe, "窄档面板根应可量");
  assertNoHorizontalOverflow(unavailable.narrowProbe, "面板根（窄档 360）");
  console.log(`[158] unavailable-snapshot 浏览器断言通过（UA ${unavailable.ua}）`);
}

await main();
