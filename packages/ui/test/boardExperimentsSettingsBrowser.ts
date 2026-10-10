/**
 * 卡 #62 的**浏览器行为断言**：设置 ▸ 实验功能 ▸ 「项目看板」开关的完整用户路径。
 *
 * 独立脚本，文件名不含 `.test.`（与 `boardExperimentGateBrowser.ts` / `boardKanbanBrowserLayout.ts` 同款：
 * `node --test` 常规套件不收它；由本卡验证显式执行）。
 *
 * 为什么 SSR/纯函数不算数：开关的读取通路是**异步 settings store + useEffect 订阅**
 * （`useSettings()` + `platform.onSettingsChanged`），SSR 不跑 effect，只能覆盖「设置未加载」这一格。
 * 本脚本量的是真引擎 + 真事件下的完整链路：
 *   设置导航「实验功能」可见（条目来自真实 createSettingsPageConfig 输出）
 *   → 派发指针序列点开该分区 → 行内开关默认关
 *   → 派发指针序列拨开 → 真写 settings（settingService.update 记录 patch）+ 侧边面板看板入口出现
 *   → 派发指针序列点入口 → 看板面板挂载、四视图（树/看板/列表/表格）逐个可切换
 *   → 拨关 → 入口/面板/tab 即时消失，设置写回 false（写→重读一致）。
 *
 * 边界（诚实声明）：本脚本不挂载整个 SettingsPage 页框（它需要整条 workspace 服务面），
 * 而是用**真实的** `createSettingsPageConfig()` 输出渲染设置导航（`data-testid` 与真页同一套
 * TID_SETTINGS_SECTION_NAV 锚点），分区内容渲染**真实的** `ExperimentsSection`；
 * 侧边面板侧挂真实 `AnimatedSidePanePanel`。两宿主共享同一份 settingService/platform，
 * 因此开关写读就是产品通路本身。页框级接线（activeSection → <ExperimentsSection/>）由
 * test/experimentsSettingsSection.test.ts 的源码守卫覆盖。驱动层见
 * `boardExperimentsSettingsBrowserDrivers.ts`。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析复用 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardExperimentsSettingsBrowser.ts
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
import { ExperimentsSection } from "../src/settings/ExperimentsSection.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import {
  HOST_HEIGHT,
  resolveElectronBinary,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";
import {
  BOARD_EXPERIMENTS_SETTINGS_CLIENT_ENTRY,
  boardExperimentsSettingsDriverSource,
  PANEL_HOST_ID,
  SETTINGS_HOST_ID,
  VIEW_MODES,
  type ExperimentsSettingsChainResult,
} from "./boardExperimentsSettingsBrowserDrivers.js";

/** 页面：两个宿主上下排列，真 Tailwind 产物 CSS（设置壳 + launcher + 面板 + 四视图的真实类名取并集）。 */
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
  const locale = "zh-CN" as const;
  const settingService = {
    get: async () => ({ recentProjects: [], experimentalProjectBoardEnabled: false }),
    update: async () => {},
  };
  const settingsProviders = (children: unknown) =>
    createElement(PlatformProvider, {
      platform: { syncAppSettings: () => {} } as never,
      children: createElement(ServiceProvider, {
        services: { settingService } as never,
        children: createElement(ZCodeIntlProvider, {
          initialLocale: locale,
          children: children as never,
        }),
      }),
    });
  // 设置行（SettingsRow + Switch）：真 SSR 产物取类名。
  collect(renderToStaticMarkup(settingsProviders(createElement(ExperimentsSection, null))));
  collect(
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: locale,
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
  // 四视图各自的真 SSR 产物：确保每个视图的类名都在真 Tailwind 产物里。
  for (const mode of VIEW_MODES) {
    collect(
      renderToStaticMarkup(
        createElement(ZCodeIntlProvider, {
          initialLocale: locale,
          children: createElement(BoardPaneView, {
            state: { kind: "ready" as const, board: outcome.board },
            viewMode: mode,
            onRefresh: () => {},
          }),
        }),
      ),
    );
  }
  // 设置壳自身的锚点类名（无样式，仅保证 nav/button 有可点的盒）。
  collect(
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: locale,
        children: createElement("div", {
          className: "flex h-full min-h-0 w-[520px] flex-col gap-2 overflow-auto p-3",
          children: createElement("nav", {
            className: "flex flex-wrap gap-1",
            children: createElement("button", {
              type: "button",
              className: "rounded-md border px-2 py-1",
            }),
          }),
        }),
      }),
    ),
  );
  const css = compiler.build([...candidates]);
  const bundle = await esbuild({
    stdin: { contents: BOARD_EXPERIMENTS_SETTINGS_CLIENT_ENTRY, resolveDir: UI_DIR, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: path.join(UI_DIR, "tsconfig.json"),
    // 面板宿主依赖整条重组件链：图片资产内联为 data URL、CSS 侧文件视为空（本页样式由
    // 上面编译出的真 Tailwind 产物提供），让「真组件 + 真事件」在页面里跑起来。
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-experiments-settings</title>
<style>${css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="${SETTINGS_HOST_ID}" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1200px;overflow:hidden"></div>
<div id="${PANEL_HOST_ID}" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1200px;overflow:hidden"></div>
<script>globalThis.__BOARD_JSON__=${boardJsonLiteral};</script>
<script>${bundleText.replaceAll("</script", "<\\/script")}</script>
</body></html>`;
}

async function main(): Promise<void> {
  // 真产物前提：Electron 二进制不在就显式报错（UI 卡无浏览器证据不得进待合并）。
  resolveElectronBinary();
  const result = (await runBoardPaneInElectron({
    pageHtml: await buildPage(JSON.stringify(STAGE_MATRIX_BOARD)),
    driver: boardExperimentsSettingsDriverSource(),
    label: "board-experiments-settings",
  })) as ExperimentsSettingsChainResult;

  // ① 初始态：分区条目在设置里可见（阳性对照：导航不止一条）；未点开不渲染分区内容；
  //    开关默认关 ⇒ 面板零入口。
  assert.ok(result.initial.navCount > 1, "阳性对照：设置导航应有多个分区条目");
  assert.equal(result.initial.navLabel, "实验功能", "设置导航应能直接看到「实验功能」条目");
  assert.equal(result.initial.sectionRendered, false, "未点开分区前不应渲染分区内容");
  assert.equal(result.initial.boardEntry, false, "默认关：侧边面板不得有看板入口");
  assert.equal(result.initial.boardPane, false, "默认关：不得挂载看板面板");
  assert.equal(result.initial.settingsValue, false, "默认关：设置值是 false");

  // ② 点开分区：开关行渲染，默认关（aria-checked=false）。
  assert.equal(result.afterNav.switchPresent, true, "点开实验功能分区后应看到开关行");
  assert.equal(result.afterNav.switchAriaChecked, "false", "开关默认关");
  assert.ok(
    result.afterNav.rowText.includes("项目看板"),
    `开关行文案应是「项目看板」：${result.afterNav.rowText}`,
  );
  assert.equal(result.afterNav.boardEntry, false, "仅打开分区不得打开看板入口");

  // ③ 拨开：真写 settings（update 收到 patch=true）+ 入口出现；开关态即时同步。
  assert.equal(result.afterEnable.settingsValue, true, "拨开后设置值应为 true（写→重读一致）");
  assert.deepEqual(
    result.afterEnable.updateCalls,
    [{ experimentalProjectBoardEnabled: true }],
    "拨开必须经既有 settings 通路写入 appSettings.experimentalProjectBoardEnabled",
  );
  assert.equal(result.afterEnable.switchAriaChecked, "true", "拨开后开关态应为开");
  assert.equal(result.afterEnable.boardEntry, true, "拨开后侧边面板看板入口必须出现");
  assert.equal(result.afterEnable.boardPane, false, "未点入口前不得挂载面板");

  // ④ 四视图逐个可用 + 面板不横向溢出（复用 boardBrowserProbeKit 的溢出探针）。
  for (const mode of VIEW_MODES) {
    assert.equal(result.views[mode], true, `看板面板四视图应可用：${mode}`);
  }
  assert.equal(
    result.overflow.overflows,
    false,
    `看板面板不得横向溢出（scrollWidth ${result.overflow.scrollW} > clientWidth ${result.overflow.clientW}）`,
  );

  // ⑤ 拨关：设置写回 false（两次写入按序各一条），入口/面板/tab 即时消失，分区本身仍在。
  assert.equal(result.afterDisable.settingsValue, false, "拨关后设置值应为 false（写→重读一致）");
  assert.deepEqual(
    result.afterDisable.updateCalls,
    [{ experimentalProjectBoardEnabled: true }, { experimentalProjectBoardEnabled: false }],
    "拨开/拨关必须各写一次同一字段（同一通路两个方向）",
  );
  assert.equal(result.afterDisable.switchAriaChecked, "false", "拨关后开关态应为关");
  assert.equal(result.afterDisable.sectionVisible, true, "拨关不影响设置分区本身");
  assert.equal(result.afterDisable.boardEntry, false, "拨关后看板入口必须消失");
  assert.equal(result.afterDisable.boardPane, false, "拨关后看板面板必须卸载");
  assert.equal(result.afterDisable.boardTrigger, false, "拨关后不得留下看板 tab");

  console.log(
    `BOARD_EXPERIMENTS_SETTINGS_ASSERTIONS_OK 初始=${JSON.stringify(result.initial)} 分区=${JSON.stringify(result.afterNav)} 拨开=${JSON.stringify(result.afterEnable)} 视图=${JSON.stringify(result.views)} 拨关=${JSON.stringify(result.afterDisable)}`,
  );
}

await main();
