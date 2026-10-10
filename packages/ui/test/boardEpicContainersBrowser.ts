/**
 * 卡 #87 / A4-1 树形三层容器（epic ⊃ 期次 ⊃ 稿）的**浏览器行为断言**（真引擎 + 真 Tailwind 产物
 * CSS + 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`（与 `boardV21BrowserScenarios.ts` 同款：
 * `node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁，2026-10-10 用户批准）：容器头行的溢出是排版行为；epic/期次章头的
 * 折叠是 `<summary>` 默认动作；「epic 不是卡 → 点章头不落弹窗」是事件路由——三者都只有真引擎量得出。
 * 三条证据（对应卡文验收「浏览器断言（点击/折叠）绿」）：
 *   1. 溢出探针：epic 章头行 / 期次组头行 / 容器盒 / 稿块标题落点 `scrollWidth <= clientWidth`（含
 *      超长标题压力夹具：探针有压力才有意义）；层名与计数片取值一并量回；
 *   2. 折叠路由：epic 章头、期次组头派发完整指针/点击序列 → `<details>.open` 真变化；指示符真旋转
 *      （Tailwind `group-open:rotate-90` 产物类）；折叠态 DOM 不消失；
 *   3. 点击路由：epic/期次章头不落弹窗（退化形态）；期次组内的稿块标题落点照旧开弹窗且不误触折叠。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardEpicContainersBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";
import {
  epicTreeClickDriverSource,
  epicTreeOverflowDriverSource,
} from "./boardEpicContainersBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 溢出压力：真实板里长中文标题 + 长 agent/远端名的形态（层头行不得被撑出横向溢出）。 */
const LONG_EPIC_TITLE =
  "看板系统（KANB）——含三期容器层、跨期长标题与双语展开压测-abcdefghijklmnopqrstuvwxyz-0123456789";
const LONG_FEATURE_TITLE =
  "看板 v2 一期甲稿——三层容器树形落位（窄面板里的超长标题也要能收敛，不得撑破容器头行）";

/** 夹具：在 EPIC_BOARD 上做标题压力改造（数据面不变，只把标题拉长）。 */
function buildFixtureBoardJson(): string {
  const raw = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; title: string }>;
    features: Array<{ id: string; title: string }>;
  };
  const epic = raw.epics[0];
  assert.ok(epic, "夹具应有 KANB 登记行");
  epic.title = LONG_EPIC_TITLE;
  const feature = raw.features.find((entry) => entry.id === "plan:plan-boardv2-a");
  assert.ok(feature, "夹具应有 PLW0 稿（KANB1 成员）");
  feature.title = LONG_FEATURE_TITLE;
  return JSON.stringify(raw);
}

interface OverflowResult {
  ua: string;
  tree: BoardBrowserOverflowProbe | null;
  epic: {
    code: string;
    block: BoardBrowserOverflowProbe | null;
    summary: BoardBrowserOverflowProbe | null;
    layerName: string | null;
    layerNameProbe: BoardBrowserOverflowProbe | null;
    planChip: string | null;
    planChipProbe: BoardBrowserOverflowProbe | null;
    phaseChip: string | null;
    phaseChipProbe: BoardBrowserOverflowProbe | null;
    titleText: string | null;
  };
  layerNames: string[];
  ungroupedFirst: boolean | null;
  phases: Array<{
    name: string | null;
    parentEpic: string | null;
    block: BoardBrowserOverflowProbe | null;
    summary: BoardBrowserOverflowProbe | null;
    layerName: string | null;
    layerNameProbe: BoardBrowserOverflowProbe | null;
    planChip: string | null;
    planChipProbe: BoardBrowserOverflowProbe | null;
    featureIds: string[];
  }>;
  featureTitleRegions: Array<BoardBrowserOverflowProbe | null>;
}

interface ClickResult {
  ua: string;
  epicCode: string;
  epicOpen: { before: boolean; after: boolean; again: boolean };
  epicFold: {
    expanded: { transform: string | null; rotate: string | null };
    collapsed: { transform: string | null; rotate: string | null } | null;
  };
  dialogAfterEpicClick: boolean;
  phaseStillInDom: boolean;
  phaseName: string;
  phaseOpen: { before: boolean; after: boolean; again: boolean };
  dialogAfterPhaseClick: boolean;
  featureId: string;
  dialogId: string | null;
  featureOpenBefore: boolean;
  featureOpenAfter: boolean;
}

/** 旋转签名（Tailwind v4 的 rotate 走独立属性）：`none | none` = 未旋转。 */
function rotationSignature(
  style: { transform: string | null; rotate: string | null } | null,
): string {
  if (!style) return "missing";
  return [style.transform, style.rotate].map((value) => (value ? value : "none")).join(" | ");
}

async function runOverflowScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml(params),
    driver: epicTreeOverflowDriverSource(),
    label: "epic-tree-overflow",
  })) as OverflowResult | null;
  console.log(`EPIC_OVERFLOW_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "溢出探针应回传量取结果");

  // 容器结构前提（结构错了溢出探针就没有意义）：层名齐备、无归属稿在前。
  assert.deepEqual(
    result.layerNames,
    ["KANB", "KANB1", "KANB2", "CNCL", "CNCL1"],
    "层名锚点齐备且按登记序/期次序：epic 章（KANB、CNCL）+ 期次组（KANB1/KANB2/CNCL1）",
  );
  assert.equal(result.ungroupedFirst, true, "无归属稿顶层平铺在容器之前（AD-8/board.md 同序）");
  assert.equal(result.epic.layerName, "KANB");
  assert.match(result.epic.planChip ?? "", /^3 稿$/, "epic 层稿数片 = 成员稿数");
  assert.match(result.epic.phaseChip ?? "", /^2 期$/, "epic 层期数片 = 期次数");
  assert.ok(
    (result.epic.titleText ?? "").includes(LONG_EPIC_TITLE),
    "夹具压力：epic 层头标题为超长文本",
  );
  const kanb1 = result.phases.find((phase) => phase.name === "KANB1");
  assert.ok(kanb1, `KANB1 期次组应存在：${JSON.stringify(result.phases.map((p) => p.name))}`);
  assert.match(kanb1.planChip ?? "", /^2 稿$/, "期次层稿数片 = 该期稿数（一期两稿）");
  assert.deepEqual(
    kanb1.featureIds,
    ["plan:plan-boardv2-a", "plan:plan-zcode-ui"],
    "KANB1 组内成员 = 一期两稿（文档序）",
  );

  // 溢出判据（scrollWidth > clientWidth 即红；1px 容差在 kit 内）。
  assert.ok(result.tree, "树形容器盒应在");
  assertNoHorizontalOverflow(result.tree, "树形容器盒");
  assert.ok(result.epic.block && result.epic.summary, "epic 章盒/章头行应在");
  assertNoHorizontalOverflow(result.epic.block, "epic 章盒");
  assertNoHorizontalOverflow(result.epic.summary, `epic 章头行（${result.epic.code}）`);
  assert.ok(result.epic.layerNameProbe, "epic 层名锚点应在");
  assertNoHorizontalOverflow(result.epic.layerNameProbe, "epic 层名");
  assert.ok(result.epic.planChipProbe && result.epic.phaseChipProbe, "epic 层计数片应在");
  assertNoHorizontalOverflow(result.epic.planChipProbe, "epic 层稿数片");
  assertNoHorizontalOverflow(result.epic.phaseChipProbe, "epic 层期数片");
  for (const phase of result.phases) {
    assert.ok(phase.block && phase.summary, `期次组盒/组头行应在：${phase.name}`);
    assertNoHorizontalOverflow(phase.block, `期次组盒（${phase.name}）`);
    assertNoHorizontalOverflow(phase.summary, `期次组头行（${phase.name}）`);
    assert.ok(phase.layerNameProbe && phase.planChipProbe, `期次层名/稿数片应在：${phase.name}`);
    assertNoHorizontalOverflow(phase.layerNameProbe, `期次层名（${phase.name}）`);
    assertNoHorizontalOverflow(phase.planChipProbe, `期次层稿数片（${phase.name}）`);
  }
  assert.ok(result.featureTitleRegions.length > 0, "稿块标题落点应可探（容器内稿层不回归）");
  for (const [index, probe] of result.featureTitleRegions.entries()) {
    assert.ok(probe, `稿块标题落点 #${index} 应在`);
    assertNoHorizontalOverflow(probe, `稿块标题落点 #${index}`);
  }
  console.log(
    `EPIC_OVERFLOW_ASSERTIONS_OK 树形容器 ${result.layerNames.length} 个层头；` +
      `epic 章头宽 ${result.epic.summary.clientW}；期次组 ${result.phases.length} 个；` +
      `稿块标题落点 ${result.featureTitleRegions.length} 个`,
  );
}

async function runClickScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml(params),
    driver: epicTreeClickDriverSource(),
    label: "epic-tree-click",
  })) as ClickResult | null;
  console.log(`EPIC_CLICK_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "点击路由场景应回传量取结果");

  // 折叠路由：epic 章头与期次组头都是真 `<summary>` 默认动作。
  assert.equal(result.epicOpen.before, true, "epic 章默认展开（缺口不许被埋）");
  assert.equal(result.epicOpen.after, false, "点 epic 章头 → 折叠（DOM open 变化）");
  assert.equal(result.epicOpen.again, true, "再点 epic 章头 → 展开（默认动作真的在跑）");
  assert.equal(result.phaseStillInDom, true, "epic 折叠后子容器仍在 DOM（折叠不是消失）");
  assert.equal(result.phaseOpen.before, true, "期次组默认展开");
  assert.equal(result.phaseOpen.after, false, "点期次组头 → 折叠");
  assert.equal(result.phaseOpen.again, true, "再点期次组头 → 展开");

  // 指示符真旋转（`group-open:rotate-90` 产物类在树形容器上生效：展开 → 90deg；折叠 → none）。
  assert.notEqual(
    rotationSignature(result.epicFold.expanded),
    "none | none",
    "展开态指示符旋转（group-open:rotate-90 生效）",
  );
  assert.equal(
    rotationSignature(result.epicFold.collapsed),
    "none | none",
    "折叠态指示符不旋转（computed transform/rotate = none）",
  );

  // epic 不是卡：章头点击不落弹窗（epic 弹窗退化形态的容器侧承接）。
  assert.equal(result.dialogAfterEpicClick, false, "点 epic 章头不落弹窗（层不是卡）");
  assert.equal(result.dialogAfterPhaseClick, false, "点期次组头不落弹窗（层不是卡）");

  // 稿层路由不回归：容器内的稿块标题落点照旧开弹窗且不误触折叠。
  assert.equal(result.dialogId, result.featureId, "点稿块标题落点 → 开的是该稿弹窗");
  assert.equal(result.featureOpenBefore, true, "稿块在容器内默认展开");
  assert.equal(result.featureOpenAfter, true, "点标题落点不触发折叠（preventDefaultOnClick）");
  console.log(
    `EPIC_CLICK_ASSERTIONS_OK epic=${result.epicCode} 折叠往返=${result.epicOpen.before}→${result.epicOpen.after}→${result.epicOpen.again}；` +
      `期次=${result.phaseName} 折叠往返=${result.phaseOpen.before}→${result.phaseOpen.after}→${result.phaseOpen.again}；` +
      `稿块弹窗=${result.dialogId}；层头点击弹窗=无`,
  );
}

async function main(): Promise<void> {
  const boardJson = buildFixtureBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({ boards: [boardJson], viewModes: ["tree"] });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  await runOverflowScenario({ css, boardJson, bundle });
  await runClickScenario({ css, boardJson, bundle });
  console.log("BOARD_EPIC_CONTAINERS_BROWSER_ASSERTIONS_OK");
}

await main();
