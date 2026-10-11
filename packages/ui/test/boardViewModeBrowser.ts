/**
 * 默认视图切换（C3-5/#140 默认视图 tree→guide + 会话记忆）的**浏览器行为断言**
 * （真引擎 + 真 Tailwind 产物 CSS + 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`
 * （`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：首开落点、点击路由派发后的视图 DOM 与「重挂载后记住」是宿主
 * 状态 + sessionStorage 读回 + 真事件链的结果；溢出是排版行为（真 CSS 产物 + 真宽度才量得准）。
 *
 * 覆盖（对应卡 #140 验收「用户首次打开落在指引面，可一键切树形且选择被记住（刷新保持）；
 * 四视图仍可用（入口在）」）：
 *   1. 首开（无会话记忆）落指引面，五入口常驻（指引 + 结构四视图，入口不删）；
 *   2. 真指针点树形入口 → 视图 DOM 换树形且按下态跟随（点击路由派发后断言 DOM）；
 *   3. 卸载重挂载（= 切侧边标签再打开）→ 读回记忆、树形保持；看板同款复验；
 *   4. 无偏好真实路径：清记忆重挂载 → 回落新默认指引面；
 *   5. 溢出探针：宽 1400 / 窄 360 两档（面板根 / 当前视图根 / 视图切换控件）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardViewModeBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { viewModeDriverSource } from "./boardViewModeBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { GUIDE_BOARD_JSON } from "./boardGuideFixture.js";

interface ViewModeSnapshot {
  view: string | null;
  roots: Array<string | null>;
  options: Array<string | null>;
  pressed: Array<string | null>;
  storage: string | null;
}

interface ViewModeProbe {
  paneRoot: BoardBrowserOverflowProbe | null;
  view: BoardBrowserOverflowProbe | null;
  switcher: BoardBrowserOverflowProbe | null;
}

interface ViewModeResult {
  initial: ViewModeSnapshot;
  afterTreeClick: ViewModeSnapshot;
  afterTreeRemount: ViewModeSnapshot;
  afterKanbanClick: ViewModeSnapshot;
  afterKanbanRemount: ViewModeSnapshot;
  afterClear: ViewModeSnapshot;
  wideProbe: ViewModeProbe;
  narrowProbe: ViewModeProbe;
}

/** 视图闭集序（BOARD_VIEW_MODES 的独立真源：指引 + 结构四视图）。 */
const EXPECTED_OPTIONS = ["guide", "tree", "kanban", "list", "table"];

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [GUIDE_BOARD_JSON],
    viewModes: ["guide", "tree", "kanban"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson: GUIDE_BOARD_JSON, bundle }),
    driver: viewModeDriverSource(),
    label: "view-mode",
  })) as ViewModeResult | null;
  console.log(`VIEW_MODE_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "默认视图切换场景应回传量取结果");

  /* 1. 首开（无记忆）：默认落指引面；五入口常驻且序固定；首开不写记忆。 */
  assert.equal(result.initial.view, "guide", "首开默认视图 = 指引面（C3-5/#140）");
  assert.deepEqual(result.initial.roots, ["guide"], "同一时刻恰一个视图根（缺省 = 指引面）");
  assert.deepEqual(
    result.initial.options,
    EXPECTED_OPTIONS,
    "五入口常驻：指引 + 结构四视图（tree/kanban/list/table 入口不删）",
  );
  assert.deepEqual(result.initial.pressed, ["guide"], "缺省按下态在指引入口");
  assert.equal(result.initial.storage, null, "首开无显式选择：不写会话记忆（无偏好不落键）");

  /* 2. 点击路由派发：真指针点树形入口 → 视图 DOM 换树形、按下态跟随、显式选择落记忆。 */
  assert.equal(result.afterTreeClick.view, "tree", "点树形入口后视图 DOM = 树形");
  assert.deepEqual(result.afterTreeClick.roots, ["tree"], "切换后旧视图根不在（至多一个视图根）");
  assert.deepEqual(result.afterTreeClick.pressed, ["tree"], "按下态跟随切换");
  assert.equal(result.afterTreeClick.storage, "tree", "显式选择落会话记忆（同键同格式）");

  /* 3. 重挂载 = 切标签再打开：读回记忆，树形保持（验收：选择被记住、刷新保持）。 */
  assert.equal(result.afterTreeRemount.view, "tree", "重挂载后树形保持（会话记忆读回路径）");
  assert.deepEqual(result.afterTreeRemount.pressed, ["tree"], "重挂载后按下态保持");
  assert.equal(result.afterTreeRemount.storage, "tree", "记忆不被重挂载改写");

  /* 4. 看板同款：切换 → 重挂载 → 保持（保持语义不挑视图，机制一般性）。 */
  assert.equal(result.afterKanbanClick.view, "kanban", "切看板生效");
  assert.equal(result.afterKanbanRemount.view, "kanban", "重挂载后看板保持");

  /* 5. 无偏好真实路径：清记忆重挂载 → 回落新默认指引面（默认只在无显式偏好时生效）。 */
  assert.equal(result.afterClear.view, "guide", "清记忆重挂载回落默认 = 指引面");
  assert.equal(result.afterClear.storage, null, "回落默认不写回记忆（重挂载只读）");
  assert.deepEqual(result.afterClear.pressed, ["guide"], "回落默认后按下态在指引入口");

  /* 6. 溢出探针（scrollWidth ≤ clientWidth + 1px 容差）：宽 1400 / 窄 360。 */
  assertNoHorizontalOverflow(result.wideProbe.paneRoot!, "宽档面板根");
  assertNoHorizontalOverflow(result.wideProbe.view!, "宽档当前视图根");
  assertNoHorizontalOverflow(result.wideProbe.switcher!, "宽档视图切换控件");
  assert.ok((result.narrowProbe.view?.clientW ?? 0) <= 400, "窄档真落 360px 宽度");
  assertNoHorizontalOverflow(result.narrowProbe.view!, "窄档当前视图根");
  assertNoHorizontalOverflow(result.narrowProbe.switcher!, "窄档视图切换控件");
  assertNoHorizontalOverflow(result.narrowProbe.paneRoot!, "窄档面板根");

  console.log(
    "VIEW_MODE_BROWSER_ASSERTIONS_OK 首开=guide；切 tree/kanban 重挂载保持；清记忆回落 guide；宽窄无横向溢出",
  );
}

await main();
