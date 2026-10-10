/**
 * 卡 #54 的两条**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM + 真事件）——
 * 独立脚本，文件名不含 `.test.`（与 `boardKanbanBrowserLayout.ts` 同款：`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁，2026-10-10 用户批准）：布局（溢出）与点击路由（`<summary>` 默认动作）
 * 只有真实排版与真事件路径量得出来。两条场景：
 *   1. 溢出探针：w-56 列内分组头行 `scrollWidth <= clientWidth`（长徽章折行 + 截断带 title）；
 *   2. 列表组头点击路由：右区（计数/徽章）派发完整指针/点击序列 → `details.open` 变化；
 *      编号+名称区 → 开弹窗且不误触折叠。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时会自动找到主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardV21BrowserScenarios.ts
 */
import assert from "node:assert/strict";
import {
  listGroupHeaderClickDriverSource,
  overflowProbeDriverSource,
} from "./boardV21BrowserScenariosDrivers.js";
import {
  bundleBoardPaneClient,
  buildPageHtml,
  compileBoardPaneCss,
  HOST_HEIGHT,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 夹具：在七段位夹具上把首个特性（执行中列，w-56 列内）压上两个长缺口徽章 +
 * 一个长标题——长徽章不得把组头行撑出列盒。
 */
function buildFixtureBoardJson(): string {
  const raw = structuredClone(STAGE_MATRIX_BOARD) as {
    features: Array<Record<string, unknown>>;
  };
  const feature = raw.features[0];
  assert.ok(feature, "夹具应有首个特性");
  feature.attention = ["unmerged-worktree", "interrupted-resume"];
  feature.title = "预览通道（Preview Channel）——窄列里的长标题也要能收敛";
  return JSON.stringify(raw);
}

interface Probe {
  clientW: number;
  scrollW: number;
  overflows: boolean;
  box: { left: number; right: number };
}

interface OverflowResult {
  ua: string;
  groups: Array<{
    featureId: string | null;
    stage: string | null;
    lightweight: boolean;
    header: Probe;
    column: Probe | null;
    cardCount: string | null;
    badgeCount: number;
  }>;
  badges: Array<{
    code: string | null;
    title: string | null;
    clientW: number;
    scrollW: number;
    truncated: boolean;
    hasTitle: boolean;
  }>;
}

interface ListClickResult {
  ua: string;
  featureId: string | null;
  openStates: {
    before: boolean;
    afterRightRegion: boolean;
    afterRightRegionAgain: boolean;
    afterTitleRegion: boolean;
  };
  dialogId: string | null;
  dialogAfterCollapse: boolean;
  countChipBox: { w: number };
  titleRegionBox: { w: number };
}

function assertNoHorizontalOverflow(probe: Probe, label: string): void {
  assert.ok(
    probe.scrollW <= probe.clientW + 1,
    `${label}：不得横向溢出（scrollWidth ${probe.scrollW} > clientWidth ${probe.clientW}）`,
  );
}

async function runOverflowScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({
      css: params.css,
      boardJson: params.boardJson,
      bundle: params.bundle,
    }),
    driver: overflowProbeDriverSource(),
    label: "overflow",
  })) as OverflowResult | null;
  console.log(`OVERFLOW_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "溢出探针应回传量取结果");
  assert.ok(result.groups.length > 0, "看板上应有分组头（否则本场景无意义）");

  for (const group of result.groups) {
    assertNoHorizontalOverflow(
      group.header,
      `分组头 ${group.featureId}（${group.stage}${group.lightweight ? "/轻量" : ""}）`,
    );
    if (group.column) {
      assertNoHorizontalOverflow(group.column, `列容器 ${group.stage}（分组头所在列）`);
    }
  }
  // 长徽章必须被真实量到「超过可视盒」（否则本场景没有施加压力）或全文可见；
  // 且被截断的徽章必须带 title 全文（截断不丢信息）。
  const longBadge = result.badges.find(
    (badge) => badge.code === "unmerged-worktree" && badge.title !== null,
  );
  assert.ok(longBadge, "夹具里应有带 title 的待合并徽章");
  for (const badge of result.badges) {
    assert.ok(badge.hasTitle, `缺口徽章 ${badge.code} 应带 title 全文`);
    if (badge.truncated) {
      assert.ok(
        badge.title !== null && badge.title.length > 0,
        `截断徽章 ${badge.code} 的 title 不得为空`,
      );
    }
  }
  const probeHasPressure = result.groups.some((group) => group.badgeCount > 0);
  assert.ok(probeHasPressure, "夹具前提：分组头里应有缺口徽章（探针有压力才有意义）");
  console.log(
    `OVERFLOW_ASSERTIONS_OK 分组头 ${result.groups.length} 个；长徽章 title=${longBadge.title}；` +
      `列盒宽 ${result.groups[0]?.column?.clientW ?? "?"}（宿主高 ${HOST_HEIGHT}）`,
  );
}

async function runListClickScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({
      css: params.css,
      boardJson: params.boardJson,
      bundle: params.bundle,
    }),
    driver: listGroupHeaderClickDriverSource(),
    label: "list-header-click",
  })) as ListClickResult | null;
  console.log(`LIST_CLICK_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "列表点击场景应回传量取结果");
  const states = result.openStates;
  assert.equal(states.before, true, "列表分组默认展开（<details open>）");
  assert.equal(states.afterRightRegion, false, "点右区（计数/徽章）→ 应折叠");
  assert.equal(states.afterRightRegionAgain, true, "再点右区 → 应展开（默认动作真的在跑）");
  assert.equal(result.dialogAfterCollapse, false, "点右区只折叠，不误开弹窗");
  assert.equal(
    states.afterTitleRegion,
    true,
    "点编号+名称区 → 不触发折叠（preventDefaultOnClick）",
  );
  assert.equal(
    result.dialogId,
    result.featureId,
    "点编号+名称区 → 开的是该特性弹窗（弹窗身份 = 被点卡片自身）",
  );
  console.log(
    `LIST_CLICK_ASSERTIONS_OK 分组 ${result.featureId}：open 态 before=${states.before} → 右区=${states.afterRightRegion} → 再点=${states.afterRightRegionAgain}；标题区点击后 open=${states.afterTitleRegion}，弹窗=${result.dialogId}`,
  );
}

async function main(): Promise<void> {
  const boardJson = buildFixtureBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["kanban", "list"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  await runOverflowScenario({ css, boardJson, bundle });
  await runListClickScenario({ css, boardJson, bundle });
  console.log("BOARD_V21_BROWSER_ASSERTIONS_OK");
}

await main();
