/**
 * 指引面「手机窄面（极窄档 <360）」的**浏览器行为断言**（卡 #141 / C3-6；E7 §8.2 响应式与触摸
 * 约束）——独立脚本，文件名不含 `.test.`（`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：横向不溢出、槽条行数、二次信息折行、命中区高度都是**真排版**
 * 行为（真 Tailwind 产物 CSS + 真宽度才量得准）；触摸点击路由是真事件链结果。SSR 结构断言
 * 不构成行为证据（同门禁原文）。
 *
 * 覆盖（卡文验收「用户在手机宽度下看到摘要 scan 态、无横向溢出（探针断言）、可点（路由断言）」；
 * 派发口径：320/375 两档 + 触摸点击路由派发；随行登记项 = #138 P3-2 超长角色名处置指引）：
 *   1. 宽档（1400）对照：窄面降级不落到宽面（槽条单行、二次信息同排、行高保持既有紧凑密度）；
 *   2. 320/375 两档：指引面根 / 槽条 / 逐槽 / 计划块 / 计划头计数簇 / 逐队列行横向无溢出；
 *   3. 两档槽条行数 ≤2（#137 收口口径下探到 320 的降级形态）；槽主信息（标签/计数）完整可读、
 *      字号底线不破（标签 ≥12px、主数 ≥14px）——降级不降可读（itw-20261011-9003）；
 *   4. 两档折行形态：计划头计数簇、队列行二次信息组让位折到次行（标题独占首行）；
 *   5. 触摸命中区 ≥44px（槽卡内容高度；队列行折行 + 窄面 `min-h-11` 兜底，含无二次信息行）；
 *   6. 超长角色名防线（#138 P3-2 转来；#181 随动）：徽章隐藏释放行宽后注册长名完整可读 +
 *      全文进原生 title + 超长文本探针实测截断防线仍咬住；
 *   7. 触摸点击路由派发（320 档）：触摸类型指针链点队列行 → 既有卡片弹窗（点哪张弹哪张、关闭
 *      归还焦点）；点「阻塞」槽 → 既有表格落点（含该槽对应卡在场）。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （同 `boardKanbanBrowserLayoutHarness`）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardGuideNarrowBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { guideNarrowDriverSource } from "./boardGuideNarrowBrowserDrivers.js";
import { GUIDE_BOARD } from "./boardGuideFixture.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 窄面单槽量取（卡 #141/C3-6）：主信息（标签/计数）截断与字号、命中区高度、溢出探针。 */
interface NarrowSlotMeasure {
  key: string | null;
  labelText: string | null;
  valueText: string | null;
  labelTruncated: boolean | null;
  valueTruncated: boolean | null;
  labelFontSize: number | null;
  valueFontSize: number | null;
  boxH: number;
  probe: BoardBrowserOverflowProbe | null;
}

/** 窄面队列行量取（卡 #141/C3-6）：二次信息折行形态 + 超长角色名截断防线 + 命中区高度；
 *  #181：`depsBadge` = 依赖已解除徽章锚点在场性（应为 false，恢复即咬）。 */
interface NarrowQueueRowMeasure {
  id: string | null;
  titleText: string | null;
  titleAttr: string | null;
  boxH: number;
  metaOnOwnLine: boolean;
  depsBadge: boolean;
  nextText: string | null;
  nextAttr: string | null;
  nextValue: string | null;
  nextTruncated: boolean | null;
  nextFontSize: number | null;
  /** #181 布局后果随动：徽章隐藏释放行宽后，注册长名不再超宽——用页面内超长文本探针实测
   *  截断防线仍咬住（超长必截断 + 行不溢出；测完即还原）。 */
  truncationProbe: { truncated: boolean | null; probe: BoardBrowserOverflowProbe | null } | null;
  probe: BoardBrowserOverflowProbe | null;
}

/** 窄面计划块量取（卡 #141/C3-6）：头行计数簇折行形态 + 溢出探针。 */
interface NarrowPlanMeasure {
  id: string | null;
  titleText: string | null;
  metaOnOwnLine: boolean;
  metaProbe: BoardBrowserOverflowProbe | null;
  rows: NarrowQueueRowMeasure[];
  probe: BoardBrowserOverflowProbe | null;
}

/** 窄面档位量取（槽条行数 + 逐件形态；宽档对照同形）。 */
interface NarrowTierMeasure {
  rootProbe: BoardBrowserOverflowProbe | null;
  slotsProbe: BoardBrowserOverflowProbe | null;
  slotRows: number;
  slots: NarrowSlotMeasure[];
  plans: NarrowPlanMeasure[];
}

/** 手机窄面（极窄档 <360）场景量取（卡 #141/C3-6）+ 触摸类型点击路由派发结果。 */
interface GuideNarrowResult {
  ua: string;
  wide: NarrowTierMeasure;
  narrow375: NarrowTierMeasure;
  narrow320: NarrowTierMeasure;
  tap: {
    hitIsRow: boolean;
    id: string | null;
    role: string | null;
    dialogText: string;
    closes: boolean | null;
    focusReturned: boolean;
  };
  slotRoute: { hitIsSlot: boolean; view: string | null; cards: Array<string | null> };
}

/**
 * 窄面场景板（#141）：两个派生改判——
 * ① frontier #221 接手位 = 超长角色名（`exhaustive-reverse-auditor`；卡节点字段同步改判，
 *    弹窗 L2 与行内指引同一真值）——极窄档下行内「处置指引」span 必须有截断防线（truncate +
 *    原生 title），否则横向溢出必咬（#138 P3-2 登记项）；
 * ② frontier #220 未指派（`nextAssignee=null`）+ 零依赖——行内二次信息组为空：窄面命中区
 *    只能靠 `min-h` 兜底（折行组为空时行只剩单行），也覆盖 #138 审点的 unassigned 分支缺口。
 */
const NARROW_LONG_ROLE = "exhaustive-reverse-auditor";
function buildNarrowRoleBoardJson(): string {
  const raw = structuredClone(GUIDE_BOARD);
  const entries = raw.frontier as Array<Record<string, unknown>>;
  const entry221 = entries.find((entry) => entry.no === 221);
  assert.ok(entry221, "夹具里应有 frontier #221");
  entry221.nextAssignee = NARROW_LONG_ROLE;
  const entry220 = entries.find((entry) => entry.no === 220);
  assert.ok(entry220, "夹具里应有 frontier #220");
  entry220.nextAssignee = null;
  entry220.resolvedDeps = [];
  const features = raw.features as Array<Record<string, unknown>>;
  const planB = features.find((feature) => feature.id === "plan:plan-guide-b");
  assert.ok(planB, "夹具里应有计划 B");
  const planBTasks = planB.tasks as Array<Record<string, unknown>>;
  for (const no of [220, 221] as const) {
    const card = planBTasks.find((task) => task.no === no);
    assert.ok(card, `夹具里应有卡 #${no}`);
    card.nextAssignee = no === 221 ? NARROW_LONG_ROLE : null;
  }
  return JSON.stringify(raw);
}

function planOf(tier: NarrowTierMeasure, id: string): NarrowPlanMeasure {
  const plan = tier.plans.find((entry) => entry.id === id);
  assert.ok(plan, `计划 ${id} 应渲染`);
  return plan;
}

/** 窄面档位里的取行助手（按卡 id 定位队列行）。 */
function rowOf(plan: NarrowPlanMeasure, id: string): NarrowQueueRowMeasure {
  const row = plan.rows.find((entry) => entry.id === id);
  assert.ok(row, `${plan.id} 应渲染队列行 ${id}`);
  return row;
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const narrowBoardJson = buildNarrowRoleBoardJson();
  const css = await compileBoardPaneCss({
    boards: [narrowBoardJson],
    viewModes: ["guide"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson: narrowBoardJson, bundle }),
    driver: guideNarrowDriverSource(),
    label: "guide-narrow",
  })) as GuideNarrowResult | null;
  console.log(`GUIDE_NARROW_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "窄面场景应回传量取结果");

  /* 1. 宽档对照：窄面降级只发生在窄面（槽条单行、二次信息同排、行高保持既有紧凑密度）。 */
  assertNoHorizontalOverflow(result.wide.rootProbe!, "宽档（窄面场景）指引面根");
  assert.equal(result.wide.slotRows, 1, "宽档五槽单行（降级形态不落到宽面）");
  assert.equal(
    planOf(result.wide, "plan:plan-guide-a").metaOnOwnLine,
    false,
    "宽档计划头计数簇与标题同排",
  );
  const wideRow221 = rowOf(planOf(result.wide, "plan:plan-guide-b"), "task:221");
  assert.equal(wideRow221.metaOnOwnLine, false, "宽档队列行处置指引同排");
  assert.ok(
    wideRow221.boxH < 44,
    `宽档队列行保持既有紧凑密度（实测 ${wideRow221.boxH}px；44px 命中区只在窄面生效）`,
  );
  assert.equal(
    wideRow221.nextTruncated,
    false,
    "宽档超长角色名不截断（全文直接可读；截断防线是窄面兜底）",
  );

  /* 2-6. 320/375 两档：无溢出 + 槽条两行内 + 主信息可读 + 二次信息让位折行 + 命中区 + 截断防线。 */
  const expectation = `下一步：${NARROW_LONG_ROLE}`;
  for (const [label, tier] of [
    ["375", result.narrow375],
    ["320", result.narrow320],
  ] as const) {
    assertNoHorizontalOverflow(tier.rootProbe!, `窄档 ${label} 指引面根`);
    assertNoHorizontalOverflow(tier.slotsProbe!, `窄档 ${label} 五槽条`);
    assert.ok(
      tier.slotRows <= 2,
      `窄档 ${label} 五槽条应两行内（#137 收口口径下探到 320；实测 ${tier.slotRows} 行）`,
    );
    for (const slot of tier.slots) {
      assertNoHorizontalOverflow(slot.probe!, `窄档 ${label} 槽 ${slot.key}`);
      // 降级不降可读（itw-20261011-9003）：主信息（标签/计数）完整可读、字号不降档。
      assert.equal(slot.labelTruncated, false, `窄档 ${label} 槽 ${slot.key} 标签完整可读`);
      assert.equal(slot.valueTruncated, false, `窄档 ${label} 槽 ${slot.key} 计数完整可读`);
      assert.ok(
        (slot.labelFontSize ?? 0) >= 12,
        `窄档 ${label} 槽 ${slot.key} 标签字号 ≥12px（底线不破）：${slot.labelFontSize}`,
      );
      assert.ok(
        (slot.valueFontSize ?? 0) >= 14,
        `窄档 ${label} 槽 ${slot.key} 主数字号 ≥14px（底线不破）：${slot.valueFontSize}`,
      );
      assert.ok(
        slot.boxH >= 44,
        `窄档 ${label} 槽 ${slot.key} 触摸命中区 ≥44px（实测 ${slot.boxH}px）`,
      );
    }
    for (const plan of tier.plans) {
      assertNoHorizontalOverflow(plan.probe!, `窄档 ${label} 计划块 ${plan.id}`);
      assertNoHorizontalOverflow(plan.metaProbe!, `窄档 ${label} 计划头计数簇 ${plan.id}`);
      assert.equal(
        plan.metaOnOwnLine,
        true,
        `窄档 ${label} 计划头计数簇/缺口徽章让位折行（标题独占首行）`,
      );
      for (const row of plan.rows) {
        assertNoHorizontalOverflow(row.probe!, `窄档 ${label} 队列行 ${row.id}`);
        assert.ok(
          row.boxH >= 44,
          `窄档 ${label} 队列行 ${row.id} 触摸命中区 ≥44px（实测 ${row.boxH}px）`,
        );
        // #181：依赖已解除徽章整处移除——含 #221（resolvedDeps 非空）在内的所有队列行都不落锚点。
        assert.equal(
          row.depsBadge,
          false,
          `窄档 ${label} 队列行 ${row.id} 不落依赖已解除徽章（#181）`,
        );
        // 折行只对「有二次信息」的行可判（空二次信息组没有可折行的内容，命中区走 min-h 兜底）。
        if (row.nextValue !== null) {
          assert.equal(
            row.metaOnOwnLine,
            true,
            `窄档 ${label} 队列行 ${row.id} 处置指引折行（标题独占首行）`,
          );
        }
      }
    }
    /* 超长角色名防线（#138 P3-2 转来；#181 布局后果随动）：依赖徽章隐藏释放行宽后，注册的
       26 字符长名在 320/375 档已完整可读（不再截断）——全文仍在原生 title；防线本身用超长
       文本探针实测仍咬住（超长必截断 + 行不溢出，不是「根本没触发」）。 */
    const longRow = rowOf(planOf(tier, "plan:plan-guide-b"), "task:221");
    assert.equal(longRow.nextValue, NARROW_LONG_ROLE, `窄档 ${label} 接手位原值直读 frontier 条目`);
    assert.equal(
      longRow.nextAttr,
      expectation,
      `窄档 ${label} 超长角色名全文进原生 title（截断防线；期望 ${expectation}）`,
    );
    assert.equal(
      longRow.nextTruncated,
      false,
      `窄档 ${label}：#181 后注册长名（26 字符）完整可读（徽章隐藏释放行宽；行内不再截断）`,
    );
    const truncProbe = longRow.truncationProbe;
    assert.ok(truncProbe, `窄档 ${label} 超长文本探针应有量取值`);
    assert.equal(
      truncProbe.truncated,
      true,
      `窄档 ${label} 超长文本仍被截断（truncate + min-w-0 防线咬住）`,
    );
    assert.ok(truncProbe.probe, `窄档 ${label} 超长文本探针应有溢出量取值`);
    assertNoHorizontalOverflow(truncProbe.probe, `窄档 ${label} 超长文本下行不溢出`);
    assert.ok(
      (longRow.nextFontSize ?? 0) >= 12,
      `窄档 ${label} 处置指引字号底线不破（≥12px）：${longRow.nextFontSize}`,
    );
    /* 无二次信息的行（未指派 + 零依赖）：二次信息组为空，命中区只能靠 `@max-sm:min-h-11`
       兜底（折行组为空 → 行只剩单行）；顺手覆盖 #138 审点的 unassigned 分支。 */
    const bareRow = rowOf(planOf(tier, "plan:plan-guide-b"), "task:220");
    assert.equal(bareRow.nextValue, null, `窄档 ${label} 未指派不猜：不落处置指引（#138 口径）`);
    assert.equal(bareRow.depsBadge, false, `窄档 ${label} 零依赖不落依赖徽章（#181）`);
    assert.ok(
      bareRow.boxH >= 44,
      `窄档 ${label} 无二次信息行命中区仍 ≥44px（min-h 兜底；实测 ${bareRow.boxH}px）`,
    );
  }

  /* 7. 触摸点击路由派发（320 档）：行 → 既有卡片弹窗（点哪张弹哪张、关闭归还焦点）；
        槽 → 既有下钻落点（表格 + 该槽对应卡在场）。 */
  assert.equal(result.tap.hitIsRow, true, "触摸命中点落在队列行盒内（命中区成立，无遮挡）");
  assert.equal(result.tap.id, "task:221", "触摸点击队列行 → 弹出被点的那张卡");
  assert.equal(result.tap.role, "dialog", "触摸路由复用既有卡片弹窗（role=dialog）");
  assert.ok(result.tap.dialogText.includes("微条用法"), "弹窗承载被点卡片内容（L2 下钻）");
  assert.equal(result.tap.closes, true, "× 关闭后弹窗消失");
  assert.equal(result.tap.focusReturned, true, "关闭后焦点归还触摸点击的队列行");
  assert.equal(result.slotRoute.hitIsSlot, true, "触摸命中点落在槽卡盒内");
  assert.equal(result.slotRoute.view, "table", "触摸点击「阻塞」槽 → 落到既有表格落点");
  assert.ok(
    result.slotRoute.cards.includes("task:217"),
    "触摸落点渲染该槽对应卡（#217 外部审批等待）",
  );

  console.log(
    "GUIDE_NARROW_BROWSER_ASSERTIONS_OK 宽档对照（单行/同排/紧凑）；320/375 两档无溢出、" +
      "槽条两行内、主信息不截断（字号底线不破）、计划头与队列行二次信息折行、" +
      "触摸命中区 ≥44px（含无二次信息行 min-h 兜底）；超长角色名完整可读+title（#181 行宽释放）、" +
      "超长文本探针下防线仍咬住；触摸点击路由（行→弹窗开闭+焦点归还、槽→表格落点）",
  );
}

await main();
