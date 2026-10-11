/**
 * 指引面（guide 面）的**浏览器行为断言**（卡 #136 / C3-1；真引擎 + 真 Tailwind 产物 CSS +
 * 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`（`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：横向不溢出是排版行为（真 CSS 产物 + 真宽度才量得准）；
 * 「点计划内卡行 → 既有卡片弹窗 DOM」是点击路由与宿主状态的真事件链结果；关闭后焦点归还
 * 打开者只有真 DOM 能看见。
 *
 * 覆盖（对应卡文验收「打开板第一眼看到正在执行的计划与进度（计数+微条）；点计划内任一卡片
 * 弹出详情；窄面不溢出」）：
 *   1. 五槽与计划区块真 DOM 渲染值（与 SSR 判据同源对账：4/3/2/1/5 与 2/4、0/3）；
 *   2. 溢出探针：宽 1400 / 窄 360 两档（根面 / 五槽条 / 计划块 / 计划内卡行）；
 *   3. 点击路由派发：真指针点计划内卡行 → `data-board-dialog="task:210"` 弹窗出现且内容是点的那张；
 *      × 关闭后弹窗消失、焦点归还打开者。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardGuideBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { guideDriverSource } from "./boardGuideBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { GUIDE_BOARD_JSON } from "./boardGuideFixture.js";

interface SlotMeasure {
  key: string | null;
  value: string | null;
  zero: string | null;
  text: string;
  probe: BoardBrowserOverflowProbe | null;
}

interface PlanMeasure {
  id: string | null;
  progress: string | null;
  barValue: string | null;
  summary: string | null;
  cardIds: Array<string | null>;
  probe: BoardBrowserOverflowProbe | null;
  rowProbes: Array<BoardBrowserOverflowProbe | null>;
}

interface GuideResult {
  ua: string;
  wide: {
    rootProbe: BoardBrowserOverflowProbe;
    slotsProbe: BoardBrowserOverflowProbe;
    slots: SlotMeasure[];
    plans: PlanMeasure[];
  };
  narrow: {
    rootProbe: BoardBrowserOverflowProbe;
    slotsProbe: BoardBrowserOverflowProbe;
    plans: PlanMeasure[];
  };
  dialog: {
    id: string | null;
    role: string | null;
    ariaModal: string | null;
    title: boolean;
    closes: boolean | null;
  };
  focusReturned: boolean;
}

function planOf(plans: PlanMeasure[], id: string): PlanMeasure {
  const plan = plans.find((entry) => entry.id === id);
  assert.ok(plan, `计划 ${id} 应渲染`);
  return plan;
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [GUIDE_BOARD_JSON],
    viewModes: ["guide", "tree"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson: GUIDE_BOARD_JSON, bundle }),
    driver: guideDriverSource(),
    label: "guide-view",
  })) as GuideResult | null;
  console.log(`GUIDE_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "指引面场景应回传量取结果");

  /* 1. 五槽与计划区块的真 DOM 渲染值（四段派生投影；与夹具独立真源对账）。 */
  const slotValues = Object.fromEntries(result.wide.slots.map((slot) => [slot.key, slot.value]));
  assert.deepEqual(
    slotValues,
    { attention: "4", blocked: "3", running: "2", review: "1", recent: "5" },
    "五槽计数 = 派生投影/板字段（禁自算）",
  );
  for (const slot of result.wide.slots) {
    assert.equal(slot.zero, null, `${slot.key} 非零槽不落空槽标记`);
    assert.ok(slot.text.length > 0, `${slot.key} 槽有可读文本`);
    assertNoHorizontalOverflow(slot.probe!, `五槽条 ${slot.key} 槽`);
  }
  const planA = planOf(result.wide.plans, "plan:plan-guide-a");
  assert.equal(planA.progress, "2/4", "计划 A 进度计数 2/4");
  assert.equal(planA.barValue, "2/4", "微条与计数同源");
  assert.deepEqual(planA.cardIds, ["task:210", "task:213"], "卡行 = frontier 序 → active 序");
  const planD = planOf(result.wide.plans, "plan:plan-guide-d");
  assert.equal(planD.progress, "0/0", "未拆解计划计数锚点 0/0");
  assert.ok(planD.summary !== null, "未拆解计划仍有摘要行");

  /* 2. 宽窄两档溢出探针（scrollWidth ≤ clientWidth）。 */
  assertNoHorizontalOverflow(result.wide.rootProbe, "宽档指引面根");
  assertNoHorizontalOverflow(result.wide.slotsProbe, "宽档五槽条");
  for (const plan of result.wide.plans) {
    assertNoHorizontalOverflow(plan.probe!, `宽档计划块 ${plan.id}`);
    for (const [index, rowProbe] of plan.rowProbes.entries()) {
      assertNoHorizontalOverflow(rowProbe!, `宽档计划块 ${plan.id} 第 ${index + 1} 行`);
    }
  }
  assert.ok((result.narrow.rootProbe.clientW ?? 0) <= 400, "窄档真落 360px 宽度");
  assertNoHorizontalOverflow(result.narrow.rootProbe, "窄档指引面根");
  assertNoHorizontalOverflow(result.narrow.slotsProbe, "窄档五槽条");
  for (const plan of result.narrow.plans) {
    assertNoHorizontalOverflow(plan.probe!, `窄档计划块 ${plan.id}`);
    for (const [index, rowProbe] of plan.rowProbes.entries()) {
      assertNoHorizontalOverflow(rowProbe!, `窄档计划块 ${plan.id} 第 ${index + 1} 行`);
    }
  }

  /* 3. 点击路由派发 → 弹窗 DOM（点的是哪张，弹的就是哪张；关闭与焦点闭环走同一宿主链路）。 */
  assert.equal(result.dialog.id, "task:210", "弹窗身份 = 被点的计划内卡行");
  assert.equal(result.dialog.role, "dialog", "弹窗 role");
  assert.equal(result.dialog.ariaModal, "true", "弹窗 aria-modal");
  assert.equal(result.dialog.title, true, "弹窗承载被点卡片内容");
  assert.equal(result.dialog.closes, true, "× 关闭后弹窗消失");
  assert.equal(result.focusReturned, true, "关闭后焦点归还打开者（计划内卡行）");

  console.log(
    "GUIDE_BROWSER_ASSERTIONS_OK 五槽 4/3/2/1/5；计划 2/4 微条 2/4；窄 360 无溢出；点 task:210 弹窗开闭+焦点归还",
  );
}

await main();
