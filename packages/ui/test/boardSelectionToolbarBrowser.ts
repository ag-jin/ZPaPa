/**
 * 卡 #64 的**浏览器行为断言**：看板面板内的选区不得触发「添加到当前任务 / 在辅助对话中提问」
 * 浮条（`SelectionActionMenu`），文件预览（markdown 预览）的选区照常有浮条。
 *
 * 为什么不是 SSR 断言（UI 卡门禁，2026-10-10 用户批准）：浮条的出现/消失由真实 Selection、
 * 真实 rAF 调度与真实 DOM 祖先判定决定，结构断言量不出这条行为。
 *
 * 两个场景（都在真 Electron（应用自己的引擎）+ 真 Tailwind 产物 CSS + 真事件路径上跑；
 * 页面入口与驱动在 `boardSelectionToolbarBrowserDrivers.ts`）：
 *   A. **真侧边面板布局**（`AnimatedSidePanePanel`，看板 tab 与文件预览 tab 并存）：
 *      ① 看板 tab 活动 → 在看板面板内造选区 → 无浮条；
 *      ② 切到 markdown 预览 tab → 在预览正文内造选区 → 浮条在场（对照：文件预览行为不回归）。
 *   B. **判定侧同容器**（浮条根容器同时包含普通段落与看板面板——浮条判定的最小复现形态）：
 *      ① 在容器内的看板面板里造选区 → 无浮条（#64 的豁免判据）；
 *      ② 在同一容器的普通段落里造选区 → 浮条在场（豁免只针对声明了 opt-out 的容器）。
 *
 * 两场景的证据分工（诚实口径）：A 是**真实产品布局**的回归断言，但它量不出 #64 的豁免本身——
 * 现行侧边面板里 markdown 预览在非活动 tab 会走重内容裁剪（`shouldRenderPreviewPaneHeavyContent`），
 * 浮条本就随之卸载，所以 A 在修复前也是绿的。B 把「浮条判定根包含看板面板」这一包含关系
 * 摆在判定层上（浮条组件与看板面板同一容器根），修复前**必然红**——它就是豁免判据的红绿面。
 * 修好判定（共享豁免属性）后两场景四条全绿。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 *（解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时会自动找到主仓那份）。
 *
 * 复用（#55 S-8）：指针/点击序列原语引用 `test/boardBrowserProbeKit.ts`，不复制。
 *
 * 命令（在 `packages/ui` 下）：
 *   pnpm exec tsx --tsconfig tsconfig.json --test test/boardSelectionToolbarBrowser.ts
 */
import assert from "node:assert/strict";
import { build as esbuild } from "esbuild";
import path from "node:path";
import {
  NESTED_CLIENT_ENTRY,
  NESTED_DRIVER,
  SIDE_PANE_CLIENT_ENTRY,
  SIDE_PANE_DRIVER,
} from "./boardSelectionToolbarBrowserDrivers.js";
import {
  buildPageHtml,
  compileBoardPaneCss,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/* ---------------- 量取结果的形状（页面 ↔ Node 的缝） ---------------- */

interface ToolbarProbeResult {
  selectedText: string;
  toolbarPresent: boolean;
  toolbarText: string | null;
}

interface ScenarioResult {
  board: ToolbarProbeResult;
  markdown?: ToolbarProbeResult;
  plain?: ToolbarProbeResult;
  ua?: string;
}

/* ---------------- 真组件 bundle + 真引擎执行 ---------------- */

async function bundleClientEntry(entry: string): Promise<string> {
  const compiled = await esbuild({
    stdin: { contents: entry, resolveDir: UI_DIR, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: path.join(UI_DIR, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    // 场景 A 要挂真侧边面板（含文件预览），静态资源给兜底 loader：多一个图标不至于整包失败。
    loader: {
      ".png": "dataurl",
      ".svg": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".gif": "dataurl",
      ".webp": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
      ".wasm": "dataurl",
    },
    plugins: [
      {
        name: "asset-stub",
        setup(build) {
          build.onResolve({ filter: /\.css$/ }, (args) => ({
            path: args.path,
            namespace: "css-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "css-stub" }, () => ({
            contents: "",
            loader: "js",
          }));
          build.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path,
            namespace: "url-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "url-stub" }, () => ({
            contents: "export default '';",
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  const bundle = compiled.outputFiles?.[0]?.text;
  if (!bundle) throw new Error("esbuild 应产出 bundle");
  return bundle;
}

async function runScenario(params: {
  clientEntry: string;
  driver: string;
  label: string;
  css: string;
  boardJson: string;
}): Promise<ScenarioResult> {
  const bundle = await bundleClientEntry(params.clientEntry);
  const pageHtml = buildPageHtml({ css: params.css, boardJson: params.boardJson, bundle });
  const result = (await runBoardPaneInElectron({
    pageHtml,
    driver: params.driver,
    label: params.label,
  })) as ScenarioResult | undefined;
  assert.ok(result, `${params.label} 应回传量取结果`);
  return result;
}

/* ---------------- 断言（判据集中在脚本里，驱动只量取） ---------------- */

const boardJson = JSON.stringify(STAGE_MATRIX_BOARD);
const css = await compileBoardPaneCss({
  boards: [boardJson],
  viewModes: ["tree", "kanban", "list", "table"],
});

const sidePane = await runScenario({
  clientEntry: SIDE_PANE_CLIENT_ENTRY,
  driver: SIDE_PANE_DRIVER,
  label: "board-selection-toolbar/side-pane",
  css,
  boardJson,
});
console.log(`场景 A 看板选区：${JSON.stringify(sidePane.board)}`);
console.log(`场景 A 预览选区：${JSON.stringify(sidePane.markdown)}`);
assert.ok(sidePane.board.selectedText.length > 0, "场景 A 应真的选中了看板文本");
assert.equal(
  sidePane.board.toolbarPresent,
  false,
  `看板面板内的选区不得出现选择浮条（选中文本：${sidePane.board.selectedText}）`,
);
assert.ok(sidePane.markdown, "场景 A 应有文件预览对照结果");
assert.ok(sidePane.markdown.selectedText.length > 0, "场景 A 预览侧应真的选中了文本");
assert.equal(
  sidePane.markdown.toolbarPresent,
  true,
  "文件预览（markdown）选区必须照常出现选择浮条（对照不回归）",
);

const nested = await runScenario({
  clientEntry: NESTED_CLIENT_ENTRY,
  driver: NESTED_DRIVER,
  label: "board-selection-toolbar/nested",
  css,
  boardJson,
});
console.log(`场景 B 看板选区：${JSON.stringify(nested.board)}`);
console.log(`场景 B 段落选区：${JSON.stringify(nested.plain)}`);
assert.ok(nested.board.selectedText.length > 0, "场景 B 应真的选中了看板文本");
assert.equal(
  nested.board.toolbarPresent,
  false,
  `浮条根容器包含看板面板时，看板内选区仍不得出现浮条（选中文本：${nested.board.selectedText}）`,
);
assert.ok(nested.plain, "场景 B 应有普通段落对照结果");
assert.ok(nested.plain.selectedText.length > 0, "场景 B 段落侧应真的选中了文本");
assert.equal(
  nested.plain.toolbarPresent,
  true,
  "同一容器内的普通段落选区必须照常出现选择浮条（豁免不得误伤）",
);

console.log("看板选择浮条豁免：真 Electron 断言通过（两场景四条）");
