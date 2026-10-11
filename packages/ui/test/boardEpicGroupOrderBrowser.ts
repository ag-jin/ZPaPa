/**
 * 卡 #88 / A4-2 组序统一比较器（纯期次序）的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS +
 * 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`（与 `boardEpicThreeViewsBrowser.ts` 同款：
 * `node --test` 常规套件不收它）。与 A4-1b 脚本分文件：本文件只含组序场景（单文件 ≤400 行）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：期次组序的可见形态 = 真 DOM 里的**节点顺序**（SSR 结构断言
 * 不构成行为证据）；容器头折叠是 `<summary>` 默认动作、横向溢出是排版行为——三者都只有真引擎
 * 量得出。四条证据（对应卡文验收「用户切换四视图看到 KANB1→KANB2→KANB3 且各视图一致」）：
 *   1. 组序：四视图（tree/list/kanban/table）期次组头文档序 = KANB1→KANB2→KANB3→KANB10
 *      （反例夹具：缺口在 phase 2、文档序乱序、两位数期次——缺口优先/文档序/字典序任一误用即红）；
 *   2. 四视图同序：同一输入的期次文档序逐字相同（tree 为基准）；
 *   3. 溢出探针：新夹具的视图根 / 期次盒 / 期次组头行 / 期次层名，宽 1400 与窄 360 两档
 *      `scrollWidth <= clientWidth`（长标题压力）；
 *   4. 点击路由：列表 KANB2 期次组头派发完整指针序列 → 折叠真发生；折叠后组序不变、KANB10 期次
 *      容器仍在 DOM；层不是卡（不落弹窗）；切视图往返后组序稳定。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardEpicGroupOrderBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { EPIC_BOARD_PHASE_ORDER } from "./boardEpicGroupOrderFixture.js";
import { epicGroupOrderDriverSource } from "./boardEpicGroupOrderBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 溢出压力：真实板里长中文标题形态（期次组头行不得被撑出横向溢出）。 */
const LONG_EPIC_TITLE =
  "看板系统（KANB）——含多期容器层、跨期长标题与双语展开压测-abcdefghijklmnopqrstuvwxyz-0123456789";
const LONG_FEATURE_TITLE =
  "看板 v2 二期缺口稿——组序反例在三视图落位（窄面板里的超长标题也要能收敛，不得撑破容器头行）";

/** 夹具：期次序与缺口分布不动（phase 1/2/3/10，缺口在 phase 2），只把标题拉长做溢出压力。 */
function buildGroupOrderBoardJson(): string {
  const raw = structuredClone(EPIC_BOARD_PHASE_ORDER) as {
    epics: Array<{ code: string; title: string }>;
    features: Array<{ id: string; title: string }>;
  };
  const epic = raw.epics[0];
  assert.ok(epic, "夹具应有 KANB 登记行");
  epic.title = LONG_EPIC_TITLE;
  const feature = raw.features.find((entry) => entry.id === "plan:plan-phase-two-gap");
  assert.ok(feature, "夹具应有 phase 2 缺口稿");
  feature.title = LONG_FEATURE_TITLE;
  return JSON.stringify(raw);
}

interface GroupOrderLayers {
  root: BoardBrowserOverflowProbe | null;
  order: string[];
  rows: Array<{
    name: string | null;
    block: BoardBrowserOverflowProbe | null;
    header: BoardBrowserOverflowProbe | null;
    layerName: BoardBrowserOverflowProbe | null;
  }>;
}

interface GroupOrderResult {
  ua: string;
  wide: Record<"tree" | "list" | "kanban" | "table", GroupOrderLayers>;
  narrow: Record<"list" | "table" | "kanban", GroupOrderLayers>;
  listRecheck: GroupOrderLayers;
  click: {
    openBefore: boolean;
    openAfter: boolean;
    orderAfterCollapse: string[];
    orderAfterExpand: string[];
    phaseStillInDom: boolean;
    dialogAfterLayerClick: boolean;
  };
}

const EXPECTED_ORDER = ["KANB1", "KANB2", "KANB3", "KANB10"];

/** 期次组头文档序 + 期次盒/组头/层名的溢出探针（四视图同一判据）。 */
function assertGroupOrderLayers(layers: GroupOrderLayers, label: string): void {
  assert.deepEqual(
    layers.order,
    EXPECTED_ORDER,
    `${label}：期次组头文档序 = 纯期次序（缺口在 phase 2 不得提组；两位数期次按数字序）`,
  );
  assert.ok(layers.root, `${label}：视图根可探`);
  assertNoHorizontalOverflow(layers.root, `${label} 视图根`);
  for (const row of layers.rows) {
    assert.ok(
      row.block && row.header && row.layerName,
      `${label}：${row.name} 期次盒/组头/层名应在`,
    );
    assertNoHorizontalOverflow(row.block, `${label} 期次盒（${row.name}）`);
    assertNoHorizontalOverflow(row.header, `${label} 期次组头行（${row.name}）`);
    assertNoHorizontalOverflow(row.layerName, `${label} 期次层名（${row.name}）`);
  }
}

async function main(): Promise<void> {
  const boardJson = buildGroupOrderBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["tree", "kanban", "list", "table"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: epicGroupOrderDriverSource(),
    label: "epic-group-order",
  })) as GroupOrderResult | null;
  console.log(`EPIC_GROUP_ORDER_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "组序场景应回传量取结果");

  for (const mode of ["tree", "list", "kanban", "table"] as const) {
    assertGroupOrderLayers(result.wide[mode], `${mode} 视图（宽 1400）`);
  }
  for (const mode of ["list", "kanban", "table"] as const) {
    assert.deepEqual(
      result.wide[mode].order,
      result.wide.tree.order,
      `${mode} 与 tree 同序（真引擎文档序）`,
    );
  }
  for (const mode of ["list", "table", "kanban"] as const) {
    assertGroupOrderLayers(result.narrow[mode], `${mode} 视图（窄 360）`);
  }

  // 点击路由（真指针序列）：KANB2 组头折叠真发生；层不是卡（不落弹窗）；折叠后组序与子容器不变。
  assert.equal(result.click.openBefore, true, "列表 KANB2 期次组默认展开");
  assert.equal(result.click.openAfter, false, "点 KANB2 期次组头 → 折叠（真 <summary> 默认动作）");
  assert.deepEqual(result.click.orderAfterCollapse, EXPECTED_ORDER, "折叠后组序不变");
  assert.deepEqual(result.click.orderAfterExpand, EXPECTED_ORDER, "再展开后组序不变");
  assert.equal(
    result.click.phaseStillInDom,
    true,
    "折叠后 KANB10 期次容器仍在 DOM（折叠不是消失）",
  );
  assert.equal(result.click.dialogAfterLayerClick, false, "点期次层头不落弹窗（层不是卡）");
  assert.deepEqual(
    result.listRecheck.order,
    EXPECTED_ORDER,
    "切视图往返后列表组序稳定（会话内不漂移）",
  );
  console.log(
    `EPIC_GROUP_ORDER_ASSERTIONS_OK tree=${result.wide.tree.order.join(">")} ` +
      `list=${result.wide.list.order.join(">")} kanban=${result.wide.kanban.order.join(">")} ` +
      `table=${result.wide.table.order.join(">")}；折叠=${result.click.openBefore}→${result.click.openAfter}`,
  );
  console.log("BOARD_EPIC_GROUP_ORDER_BROWSER_ASSERTIONS_OK");
}

await main();
