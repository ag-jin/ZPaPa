/**
 * 指引面（guide 面）的**浏览器行为断言**（卡 #136 / C3-1；卡 #139 / C3-4 扩展：进度胶囊百分比、
 * 计数胶囊、rollup 缺口徽章；卡 #137 / C3-2 扩展：五槽下钻派发与零槽空态指引——真引擎 +
 * 真 Tailwind 产物 CSS + 真 DOM + 真事件）——独立脚本，文件名不含 `.test.`
 * （`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：横向不溢出是排版行为（真 CSS 产物 + 真宽度才量得准）；
 * 「点计划内卡行 → 既有卡片弹窗 DOM」「点槽 → 落到对应视图/过滤」是点击路由与宿主状态的真事件链
 * 结果；关闭后焦点归还打开者、零槽点击不出视图跳转而给空态指引，只有真 DOM 能看见；
 * 进度胶囊的「计数·百分比+微条」同排、缺口徽章落章的窄面形态也只有真引擎能量。
 *
 * 覆盖（对应卡文验收「打开板第一眼看到正在执行的计划与进度（计数胶囊/微条）；点计划内任一
 * 卡片弹出详情；窄面不溢出」+ C3-2「点某槽跳到对应列表；零 attention 槽点击有明确空态指引」
 * + C3-3/#138「看到可执行前沿清单（哪些卡能立刻做），点行下钻细卡」）：
 *   1. 五槽与计划区块真 DOM 渲染值（与 SSR 判据同源对账：4/3/2/1/5 与 2/4、0/3）+ 槽可点态；
 *   2. 计划级进度胶囊（#139）：百分比文本与微条同排、`[N 张卡]` 计数胶囊与 A4 组头同值；
 *   3. rollup 缺口徽章（#139）：缺口场景板（卡挂 attention 码）落章「缺口 3」，零缺口板不落章；
 *   4. 可执行前沿队列（#138）：行序 = frontier 序、行含处置指引（接手位/依赖计数片）与原生 title、
 *      空态计划给可读文案、行可点态（role=button + tabindex）；
 *   5. 溢出探针：宽 1400 / 窄 360 两档（根面 / 五槽条 / 计划块 / 进度胶囊 / 计数胶囊 /
 *      缺口徽章 / 队列行）+ 窄档槽条行数（P3-4 登记项真量）；
 *   6. 点击路由派发（#138）：真指针点队列行（A 任务 210 / B 任务 221）→ 对应卡片弹窗出现且内容
 *      是点的那张；× 关闭后弹窗消失、焦点归还打开者；
 *   7. 槽下钻派发（#137）：五槽逐个真指针点击（末槽键盘 Enter）→ 落到对应既有视图/过滤，
 *      落点视图根在场；
 *   8. 零槽场景（#137）：全零派生板上点需处理槽 → 空态指引锚点 + 视图不跳；反例=派生为零、
 *      节点仍带 attention 码/blockers（自算会得非零 → 必咬）。
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
import { guideDriverSource, guideZeroDriverSource } from "./boardGuideBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { buildGuideZeroBoard, GUIDE_BOARD, GUIDE_BOARD_JSON } from "./boardGuideFixture.js";

interface SlotMeasure {
  key: string | null;
  value: string | null;
  zero: string | null;
  role: string | null;
  tabIndex: string | null;
  text: string;
  probe: BoardBrowserOverflowProbe | null;
}

/** 槽下钻量取（卡 #137/C3-2）：点一个槽后「落到了哪个视图/过滤」+ 落点里真渲染的卡锚点。 */
interface SlotDrillMeasure {
  key: string | null;
  mode: string;
  view: string | null;
  viewRootPresent: boolean;
  stage: string | null;
  sort: string | null;
  cards: Array<string | null>;
}

/** 可执行前沿队列行量取（#138/C3-3）：处置指引（接手位/依赖计数）与行可点态（L2 下钻锚点）。 */
interface PlanQueueRowMeasure {
  id: string | null;
  title: string | null;
  next: string | null;
  nextValue: string | null;
  deps: string | null;
  depsCount: string | null;
  depsTitle: string | null;
  role: string | null;
  tabIndex: string | null;
  probe: BoardBrowserOverflowProbe | null;
}

interface PlanMeasure {
  id: string | null;
  progress: string | null;
  barValue: string | null;
  percent: string | null;
  percentText: string | null;
  cardCount: string | null;
  cardCountText: string | null;
  gapCount: string | null;
  gapText: string | null;
  summary: string | null;
  cardIds: Array<string | null>;
  rows: PlanQueueRowMeasure[];
  queueEmpty: string | null;
  probe: BoardBrowserOverflowProbe | null;
  capsuleProbe: BoardBrowserOverflowProbe | null;
  chipProbe: BoardBrowserOverflowProbe | null;
  gapProbe: BoardBrowserOverflowProbe | null;
  rowProbes: Array<BoardBrowserOverflowProbe | null>;
}

interface GuideResult {
  ua: string;
  wide: {
    rootProbe: BoardBrowserOverflowProbe;
    slotsProbe: BoardBrowserOverflowProbe;
    /** 宽档槽条行数（应保持单行——F1-137 换行基准收窄不得改宽面排版）。 */
    slotRows: number;
    slots: SlotMeasure[];
    plans: PlanMeasure[];
  };
  narrow: {
    rootProbe: BoardBrowserOverflowProbe;
    slotsProbe: BoardBrowserOverflowProbe;
    /** 窄档槽条行数（顶坐标去重；P3-4 登记项：交互改造后应为两行内）。 */
    slotRows: number;
    plans: PlanMeasure[];
  };
  dialog: {
    id: string | null;
    role: string | null;
    ariaModal: string | null;
    title: boolean;
    closes: boolean | null;
    focusReturned: boolean;
  };
  /** 第二个计划队列行的下钻弹窗（#138：点行=弹细卡，两计划各点一张）。 */
  dialogB: {
    id: string | null;
    title: boolean;
    closes: boolean | null;
    focusReturned: boolean;
  };
  focusReturned: boolean;
  drills: SlotDrillMeasure[];
}

/** 零槽场景量取（卡 #137/C3-2：空态指引 + 反例「派生为零、自算非零」）。 */
interface GuideZeroResult {
  ua: string;
  viewBefore: string | null;
  slotValues: Array<{ key: string | null; value: string | null; zero: string | null }>;
  pointer: {
    view: string | null;
    hintKey: string | null;
    hintRole: string | null;
    hintText: string | null;
  };
  keyboard: { view: string | null };
}

function planOf(plans: PlanMeasure[], id: string): PlanMeasure {
  const plan = plans.find((entry) => entry.id === id);
  assert.ok(plan, `计划 ${id} 应渲染`);
  return plan;
}

/**
 * 缺口场景板（#139）：计划 A 的成员卡挂 attention 码（顶层 #211 一条 + #210 嵌套子卡两条），
 * rollup 缺口真值 = 3——真 DOM 里徽章必须落章、文案与锚点同值、窄面不溢出。
 */
function buildGapScenarioBoardJson(): string {
  const raw = structuredClone(GUIDE_BOARD);
  const features = raw.features as Array<Record<string, unknown>>;
  const planA = features.find((feature) => feature.id === "plan:plan-guide-a");
  assert.ok(planA, "夹具里应有计划 A");
  const tasks = planA.tasks as Array<Record<string, unknown>>;
  const card211 = tasks.find((task) => task.no === 211);
  const card210 = tasks.find((task) => task.no === 210);
  assert.ok(card211 && card210, "夹具里应有卡 #210/#211");
  card211.attention = ["interrupted-resume"];
  card210.tasks = [
    {
      label: "1.1.1",
      title: "子卡",
      status: "pending",
      stage: "待办",
      attention: ["unmerged-worktree", "interrupted-resume"],
    },
  ];
  return JSON.stringify(raw);
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const gapBoardJson = buildGapScenarioBoardJson();
  const zeroBoardJson = JSON.stringify(buildGuideZeroBoard());
  const css = await compileBoardPaneCss({
    boards: [GUIDE_BOARD_JSON, gapBoardJson, zeroBoardJson],
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
    // 槽可点态（卡 #137/C3-2）：与看板卡行同款 `role=button` + `tabindex`（键盘可达；
    // `[data-board-pane] :is(summary, button, [role=button]):focus-visible` 规则同款覆盖）。
    assert.equal(slot.role, "button", `${slot.key} 槽声明 button 角色`);
    assert.equal(slot.tabIndex, "0", `${slot.key} 槽可键盘 Tab 聚焦`);
    assertNoHorizontalOverflow(slot.probe!, `五槽条 ${slot.key} 槽`);
  }
  const planA = planOf(result.wide.plans, "plan:plan-guide-a");
  assert.equal(planA.progress, "2/4", "计划 A 进度计数 2/4");
  assert.equal(planA.barValue, "2/4", "微条与计数同源");
  assert.deepEqual(
    planA.cardIds,
    ["task:210"],
    "队列行 = 该计划 frontier 成员（#138 完整队列；在途卡 #213 不入队列）",
  );
  const planD = planOf(result.wide.plans, "plan:plan-guide-d");
  assert.equal(planD.progress, "0/0", "未拆解计划计数锚点 0/0");
  assert.ok(planD.summary !== null, "未拆解计划仍有摘要行");
  assert.equal(planD.queueEmpty, "暂无可立即执行的卡", "零前沿计划给队列空态文案（不留空壳）");

  /* 1b. 可执行前沿队列（#138/C3-3）：真 DOM 行序 = frontier 序；行含处置指引 + 计数片 + 可点态。 */
  const planB = planOf(result.wide.plans, "plan:plan-guide-b");
  assert.deepEqual(
    planB.cardIds,
    ["task:220", "task:221"],
    "计划 B 队列 = frontier 序 220→221（全量）",
  );
  assert.equal(planB.queueEmpty, null, "有队列行的计划不落空态");
  const row220 = planB.rows[0];
  const row221 = planB.rows[1];
  assert.equal(row220?.nextValue, "implementer", "处置指引锚点 = 接手位原值（直读 frontier 条目）");
  assert.equal(row220?.next, "下一步：implementer", "处置指引可读文案（真 DOM）");
  assert.equal(row220?.depsCount, null, "无已解除依赖 → 不落计数片");
  assert.equal(row221?.depsCount, "1", "依赖计数片 = resolvedDeps 条数（1）");
  assert.equal(row221?.deps, "依赖已解除 1", "依赖计数可读文案（真 DOM）");
  assert.equal(row221?.depsTitle, "#210", "计数片 title 带依赖号明细");
  assert.equal(row221?.title, "微条用法", "行标题进原生 title（截断防线）");
  for (const row of [...planA.rows, ...planB.rows]) {
    assert.equal(row.role, "button", `队列行 ${row.id} 声明 button 角色（L2 下钻落点）`);
    assert.equal(row.tabIndex, "0", `队列行 ${row.id} 可键盘聚焦`);
  }

  /* 2. 进度胶囊 / 计数胶囊（#139）：真 DOM 值 = SSR 判据，窄面同排不溢出。 */
  assert.equal(planA.percent, "50", "计划 A 百分比 50（锚点）");
  assert.equal(planA.percentText, "50%", "百分比为可读文本（E7 §4.2）");
  assert.equal(planA.cardCount, "4", "规模计数胶囊 = 全部成员卡 4（countBoardFeatureTasks）");
  assert.equal(planA.cardCountText, "4 张卡", "规模胶囊文案走 A4 组头同一词条");
  assert.equal(planD.percent, null, "未拆解不给百分比（不制造未知）");
  assert.equal(planD.cardCount, "0", "未拆解显式 0 张卡（与组头口径一致）");
  assert.equal(planA.gapCount, null, "零缺口板不落缺口徽章（日常零噪声）");
  for (const plan of [...result.wide.plans, ...result.narrow.plans]) {
    assertNoHorizontalOverflow(plan.capsuleProbe!, `进度胶囊 ${plan.id}`);
    assertNoHorizontalOverflow(plan.chipProbe!, `计数胶囊 ${plan.id}`);
  }

  /* 3. 缺口场景板（#139）：rollup 缺口徽章落章，文案与锚点同值，窄面不溢出。 */
  const gapResult = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson: gapBoardJson, bundle }),
    driver: guideDriverSource(),
    label: "guide-view-gap",
  })) as GuideResult | null;
  assert.ok(gapResult, "缺口场景应回传量取结果");
  console.log(`GUIDE_GAP_MEASUREMENTS=${JSON.stringify(gapResult, null, 1)}`);
  const gapPlanA = planOf(gapResult.wide.plans, "plan:plan-guide-a");
  assert.equal(gapPlanA.gapCount, "3", "缺口 = 成员卡 attention 码条数之和（1+2）");
  assert.equal(gapPlanA.gapText, "缺口 3", "缺口徽章文案（A4 层头同一词条）");
  assert.equal(gapPlanA.cardCount, "5", "规模计数含新增嵌套子卡（4+1，与组头同单点）");
  assertNoHorizontalOverflow(gapPlanA.gapProbe!, "缺口徽章（宽档）");
  const gapPlanANarrow = planOf(gapResult.narrow.plans, "plan:plan-guide-a");
  assertNoHorizontalOverflow(gapPlanANarrow.gapProbe!, "缺口徽章（窄档 360）");
  assertNoHorizontalOverflow(gapPlanANarrow.probe!, "缺口场景计划块（窄档 360）");

  /* 4. 宽窄两档溢出探针（scrollWidth ≤ clientWidth）。 */
  assertNoHorizontalOverflow(result.wide.rootProbe, "宽档指引面根");
  assertNoHorizontalOverflow(result.wide.slotsProbe, "宽档五槽条");
  assert.equal(result.wide.slotRows, 1, "宽档五槽单行（换行基准收窄只影响窄面换行形态）");
  for (const plan of result.wide.plans) {
    assertNoHorizontalOverflow(plan.probe!, `宽档计划块 ${plan.id}`);
    for (const [index, rowProbe] of plan.rowProbes.entries()) {
      assertNoHorizontalOverflow(rowProbe!, `宽档计划块 ${plan.id} 第 ${index + 1} 行`);
    }
  }
  assert.ok((result.narrow.rootProbe.clientW ?? 0) <= 400, "窄档真落 360px 宽度");
  assertNoHorizontalOverflow(result.narrow.rootProbe, "窄档指引面根");
  assertNoHorizontalOverflow(result.narrow.slotsProbe, "窄档五槽条");
  // P3-4（#136 登记、#137 收口）：槽条在 360px 档不得超过两行——槽位交互态不改变排版契约，
  // 且三行会把窄首屏主体区下推（登记原文）。行数按真排版顶坐标去重，不是算术推演。
  assert.ok(
    result.narrow.slotRows <= 2,
    `窄档 360px 五槽条应为两行内（实测 ${result.narrow.slotRows} 行）`,
  );
  for (const plan of result.narrow.plans) {
    assertNoHorizontalOverflow(plan.probe!, `窄档计划块 ${plan.id}`);
    for (const [index, rowProbe] of plan.rowProbes.entries()) {
      assertNoHorizontalOverflow(rowProbe!, `窄档计划块 ${plan.id} 第 ${index + 1} 行`);
    }
  }

  /* 5. 点击路由派发 → 弹窗 DOM（点的是哪张，弹的就是哪张；关闭与焦点闭环走同一宿主链路）。
        #138：两个计划的队列行各点一张（task:210 / task:221）——队列行 = L2 下钻落点。 */
  assert.equal(result.dialog.id, "task:210", "弹窗身份 = 被点的计划 A 队列行");
  assert.equal(result.dialog.role, "dialog", "弹窗 role");
  assert.equal(result.dialog.ariaModal, "true", "弹窗 aria-modal");
  assert.equal(result.dialog.title, true, "弹窗承载被点卡片内容");
  assert.equal(result.dialog.closes, true, "× 关闭后弹窗消失");
  assert.equal(result.focusReturned, true, "关闭后焦点归还打开者（队列行）");
  assert.equal(
    result.dialogB.id,
    "task:221",
    "弹窗身份 = 被点的计划 B 队列行（第二个计划同款下钻）",
  );
  assert.equal(result.dialogB.title, true, "计划 B 弹窗承载被点卡片内容");
  assert.equal(result.dialogB.closes, true, "计划 B 弹窗关闭后消失");
  assert.equal(result.dialogB.focusReturned, true, "计划 B 关闭后焦点归还打开者（队列行）");

  /* 6. 槽下钻派发（卡 #137/C3-2）：五槽真指针点击 + 一次键盘 Enter → 落到对应既有视图/过滤。
        期望值 = 派发落点口径（需处理→看板列 / 阻塞→受阻清单形态 / 运行·待收口→对应列表态 /
        最近活动→最近视图），独立于实现抄写；落点视图根必须在场（不是只改了激活态）。 */
  const expectedDrills: Record<
    string,
    { view: string; stage: string | null; sort: string | null; card: string }
  > = {
    attention: { view: "kanban", stage: null, sort: null, card: "task:218" },
    blocked: { view: "table", stage: "", sort: "recent", card: "task:217" },
    running: { view: "list", stage: "执行中", sort: "recent", card: "task:213" },
    review: { view: "list", stage: "审核中", sort: "recent", card: "task:216" },
    recent: { view: "list", stage: "", sort: "recent", card: "task:210" },
  };
  assert.equal(result.drills.length, 6, "五槽各点一次 + 一次键盘激活");
  for (const drill of result.drills) {
    const want = expectedDrills[drill.key ?? ""];
    assert.ok(want, `槽 ${drill.key} 的落点期望值必须存在（闭集穷尽）`);
    const label = `槽 ${drill.key}（${drill.mode}）`;
    assert.equal(drill.view, want.view, `${label}：落到对应视图`);
    assert.equal(drill.viewRootPresent, true, `${label}：落点视图根真在场（非仅切换按钮激活态）`);
    assert.equal(drill.stage, want.stage, `${label}：段位筛 = 槽对应集合的既有筛子`);
    assert.equal(drill.sort, want.sort, `${label}：排序视角 = 槽对应视角`);
    // 内容对账（独立真源 = 夹具四段/卡数据）：落点里必须真渲染出该槽对应的卡——
    // 只断言控件取值会漏掉「视图换了但内容不对应」。
    assert.ok(
      drill.cards.includes(want.card),
      `${label}：落点渲染该槽对应的卡 ${want.card}（实测 ${drill.cards.join(",")}）`,
    );
  }

  /* 7. 溢出探针：槽卡进入可点态后仍不得横向溢出（交互态不改变排版契约）。 */
  for (const slot of result.wide.slots) {
    assertNoHorizontalOverflow(slot.probe!, `五槽条 ${slot.key} 槽（可点态）`);
  }

  /* 8. 零槽场景（卡 #137/C3-2 空态指引 + 反例必咬）：全零派生板上点需处理槽——派生 0、
        节点自带 attention 码/blockers（自算会得非零）；点击必须给空态指引且不落任何视图跳转。 */
  const zeroResult = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson: zeroBoardJson, bundle }),
    driver: guideZeroDriverSource(),
    label: "guide-view-zero",
  })) as GuideZeroResult | null;
  assert.ok(zeroResult, "零槽场景应回传量取结果");
  console.log(`GUIDE_ZERO_MEASUREMENTS=${JSON.stringify(zeroResult, null, 1)}`);
  assert.deepEqual(
    zeroResult.slotValues.map((slot) => [slot.key, slot.value, slot.zero]),
    [
      ["attention", "0", "true"],
      ["blocked", "0", "true"],
      ["running", "0", "true"],
      ["review", "0", "true"],
      ["recent", "0", "true"],
    ],
    "零槽板五槽显式 0 + 空槽标记（禁自算：节点仍带 attention 码/blockers）",
  );
  assert.equal(zeroResult.pointer.view, "guide", "零槽点击不落视图跳转（不落死跳转）");
  assert.equal(zeroResult.pointer.hintKey, "attention", "空态指引锚定被点的槽");
  assert.equal(zeroResult.pointer.hintRole, "status", "空态指引是可感知状态（role=status）");
  assert.ok(
    (zeroResult.pointer.hintText ?? "").includes("需处理"),
    `空态指引指名槽位（可读）：${zeroResult.pointer.hintText}`,
  );
  assert.equal(zeroResult.keyboard.view, "guide", "键盘激活零槽同款：不落视图跳转");

  console.log(
    "GUIDE_BROWSER_ASSERTIONS_OK 五槽 4/3/2/1/5；计划 2/4 · 50% 微条 2/4 · [4 张卡]；" +
      "缺口场景 [缺口 3] 落章；宽窄两档胶囊/徽章/队列行无溢出；" +
      "队列 A[210] B[220,221]（处置指引+依赖计数片）；点 task:210/task:221 弹窗开闭+焦点归还；" +
      "五槽下钻→看板/表格/列表(执行中/审核中/最近)；零槽空态指引不下跳",
  );
}

await main();
