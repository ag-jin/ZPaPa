/**
 * 编排视图（`dispatch` 面，#185）的**浏览器行为断言**——独立脚本，文件名不含 `.test.`
 * （`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：横向不溢出是排版行为（真 CSS 产物 + 真宽度才量得准）；
 * 「点行 → 既有卡片弹窗 DOM」「× 关闭后焦点归还打开者」「键盘 Enter 打开」是点击路由与宿主
 * 状态的真事件链结果；窄面行高（触摸命中区 >=44px）也只有真引擎能量。
 *
 * 覆盖（对应卡文验收「用户打开编排视图即知：哪些卡就绪、哪张卡着谁、哪几路可并发」）：
 *   1. 三区真 DOM 值（行序/域文本/原因文本/区计数/槽位行）与 CLI 结论对账（与 SSR 判据同源）；
 *   2. 溢出探针：宽 1400 / 窄 360 两档（根面 / 三区 / 逐行 / 并发组成员）；
 *   3. 窄档行触摸命中区（每行高度 >=44px，`@max-sm:min-h-11` 真量）；
 *   4. 点击路由派发：真指针点可派行 #102 与阻塞行 #101 → 对应卡片弹窗出现且内容是被点的那张；
 *      × 关闭后弹窗消失、焦点归还打开者；
 *   5. 键盘路：并发组成员 #108 focus + Enter → 同一弹窗路由；
 *   6. 缺失场景（缺 `dispatch` 段）：未就绪指向在场、三区零渲染（禁自算兜底）、宽窄不溢出。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild /
 * `skills/zcode-board/assets/tools/next-dispatch.mjs`（夹具判据权威，生成板夹具）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardDispatchBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import {
  dispatchDriverSource,
  dispatchMissingDriverSource,
} from "./boardDispatchBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { buildDispatchFixture, cleanupDispatchFixture } from "./boardDispatchFixture.js";

interface RowMeasure {
  card: string | null;
  no: string | null;
  kind: string | null;
  by: string | null;
  targetInFlight: string | null;
  next: string | null;
  domain: string | null;
  domainUnknown: string | null;
  reason: string | null;
  title: string | null;
  role: string | null;
  tabIndex: string | null;
  height: number;
  probe: BoardBrowserOverflowProbe | null;
}

interface ZoneMeasure {
  count: string | null;
  rows: RowMeasure[];
  members: Array<{
    no: string | null;
    card: string | null;
    role: string | null;
    tabIndex: string | null;
    probe: BoardBrowserOverflowProbe | null;
  }>;
  empty: string | null;
  capacity: {
    value: string | null;
    inFlight: string | null;
    slotsFree: string | null;
    text: string | null;
  } | null;
  probe: BoardBrowserOverflowProbe | null;
}

interface DispatchSnapshot {
  state: string | null;
  recompile: boolean;
  dispatchable: ZoneMeasure;
  blocked: ZoneMeasure;
  group: ZoneMeasure;
  rootProbe: BoardBrowserOverflowProbe;
}

interface DialogMeasure {
  cardId: string | null;
  role: string | null;
  ariaModal: string | null;
  dialogText: string;
  closes: boolean | null;
  focusReturned: boolean;
}

interface DispatchResult {
  ua: string;
  wide: DispatchSnapshot;
  narrow: DispatchSnapshot;
  dialogDispatchable: DialogMeasure;
  dialogBlocked: DialogMeasure;
  keyboardBlocked: {
    cardId: string | null;
    opened: boolean;
    closes: boolean | null;
    focusReturned: boolean;
  };
}

interface MissingResult {
  ua: string;
  wide: {
    state: string | null;
    recompile: boolean;
    recompileRole: string | null;
    recompileText: string | null;
    zoneCount: number;
    cardCount: number;
    probe: BoardBrowserOverflowProbe;
  };
  narrow: {
    state: string | null;
    recompile: boolean;
    recompileRole: string | null;
    recompileText: string | null;
    zoneCount: number;
    cardCount: number;
    probe: BoardBrowserOverflowProbe;
  };
}

async function main(): Promise<void> {
  const fixture = buildDispatchFixture();
  const missingFixture = buildDispatchFixture({ withDispatch: false });
  try {
    const bundle = await bundleBoardPaneClient();
    const css = await compileBoardPaneCss({
      boards: [fixture.boardJson, missingFixture.boardJson],
      viewModes: ["dispatch"],
    });
    console.log(
      `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
    );

    const result = (await runBoardPaneInElectron({
      pageHtml: buildPageHtml({ css, boardJson: fixture.boardJson, bundle }),
      driver: dispatchDriverSource(),
      label: "dispatch-view",
    })) as DispatchResult | null;
    console.log(`DISPATCH_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
    assert.ok(result, "编排视图场景应回传量取结果");

    const cli = fixture.cli;
    const wide = result.wide;
    const narrow = result.narrow;

    /* 1. 三区真 DOM 值 = CLI 结论（同源对账；SSR 判据在 boardDispatchRender.test.ts）。 */
    assert.equal(wide.state, "ready", "含派生段 → 就绪态");
    assert.deepEqual(
      wide.dispatchable.rows.map((row) => row.no),
      cli.dispatchable.map((card) => String(card.no)),
      "可派行序 = CLI dispatchable（真 DOM）",
    );
    assert.deepEqual(
      wide.dispatchable.rows.map((row) => row.card),
      cli.dispatchable.map((card) => `task:${card.no}`),
      "可派行身份 = 既有弹窗路由锚点",
    );
    assert.equal(
      wide.dispatchable.rows[0]?.domain,
      "assets/independent.mjs",
      "域文本 = 声明面（真 DOM）",
    );
    assert.equal(
      wide.dispatchable.rows[1]?.domainUnknown,
      String(cli.dispatchable[1]?.no),
      "域未知行带标记（需人工确认）",
    );
    assert.equal(wide.dispatchable.rows[0]?.next, "implementer", "接手位锚点直读");

    assert.deepEqual(
      wide.blocked.rows.map((row) => row.no),
      cli.blocked.map((entry) => String(entry.no)),
      "阻塞归因行序 = CLI blocked（真 DOM）",
    );
    const domainRow = wide.blocked.rows.find((row) => row.no === "101");
    assert.equal(domainRow?.kind, "domain", "域占类别");
    assert.equal(domainRow?.by, "104", "域占者号位");
    assert.ok(
      (domainRow?.reason ?? "").includes("assets/shared.mjs") &&
        (domainRow?.reason ?? "").includes("104"),
      `域占原因可读（点名文件与占域卡）：${domainRow?.reason}`,
    );
    assert.equal(
      wide.blocked.rows.find((row) => row.no === "105")?.targetInFlight,
      "true",
      "依赖在途标记落锚点",
    );
    assert.equal(
      wide.blocked.rows.find((row) => row.no === "107")?.targetInFlight,
      "false",
      "依赖未在途标记落锚点",
    );
    assert.ok(
      (wide.blocked.rows.find((row) => row.no === "107")?.reason ?? "").includes("108"),
      "依赖未在途原因点名目标号",
    );

    assert.deepEqual(
      wide.group.members.map((member) => member.no),
      cli.parallelGroup.map(String),
      "并发组成员序 = CLI parallelGroup（真 DOM）",
    );
    assert.equal(wide.group.capacity?.value, String(cli.capacity), "并发上限 = CLI");
    assert.equal(wide.group.capacity?.inFlight, String(cli.inFlight.count), "在途计数 = CLI");
    assert.equal(wide.group.capacity?.slotsFree, String(cli.inFlight.slotsFree), "剩余槽位 = CLI");

    /* 2. 溢出探针：宽窄两档（根面/三区/逐行/组成员）——scrollWidth > clientWidth 即红。 */
    for (const setup of [
      { label: "宽档 1400", snapshot: wide },
      { label: "窄档 360", snapshot: narrow },
    ]) {
      assertNoHorizontalOverflow(setup.snapshot.rootProbe, `${setup.label} 编排视图根`);
      for (const zone of ["dispatchable", "blocked", "group"] as const) {
        assertNoHorizontalOverflow(setup.snapshot[zone].probe!, `${setup.label} 区 ${zone}`);
        for (const [index, row] of setup.snapshot[zone].rows.entries()) {
          assertNoHorizontalOverflow(row.probe!, `${setup.label} 区 ${zone} 第 ${index + 1} 行`);
        }
        for (const [index, member] of setup.snapshot[zone].members.entries()) {
          assertNoHorizontalOverflow(
            member.probe!,
            `${setup.label} 区 ${zone} 组成员 ${index + 1}`,
          );
        }
      }
    }
    assert.ok((narrow.rootProbe.clientW ?? 0) <= 400, "窄档真落 360px 宽度");

    /* 3. 窄档触摸命中区：行高 >=44px（含可派行/阻塞行/组成员）——真排版量取。 */
    for (const zone of ["dispatchable", "blocked", "group"] as const) {
      for (const [index, row] of narrow[zone].rows.entries()) {
        assert.ok(
          row.height >= 44,
          `窄档 ${zone} 第 ${index + 1} 行触摸命中区 >=44px（实测 ${row.height}）`,
        );
      }
    }

    /* 4. 点击路由派发（真指针）：可派行 #102 与阻塞行 #101 → 弹窗身份/内容/关闭/焦点闭环。 */
    for (const [dialog, expectedId, expectedTitle] of [
      [result.dialogDispatchable, "task:102", "X1-2 独立域卡"],
      [result.dialogBlocked, "task:101", "X1-1 改共享域"],
    ] as const) {
      assert.equal(dialog.cardId, expectedId, `弹窗身份 = 被点的卡（${expectedId}）`);
      assert.equal(dialog.role, "dialog", "弹窗 role");
      assert.equal(dialog.ariaModal, "true", "弹窗 aria-modal");
      assert.ok(
        dialog.dialogText.includes(expectedTitle),
        `弹窗承载被点卡片内容（${expectedTitle}）`,
      );
      assert.equal(dialog.closes, true, "× 关闭后弹窗消失");
      assert.equal(dialog.focusReturned, true, "关闭后焦点归还打开者");
    }

    /* 5. 键盘路：阻塞归因行 Enter → 同一弹窗路由（键盘可达）。 */
    assert.equal(result.keyboardBlocked.cardId, "task:107", "键盘打开 = 被激活的阻塞行卡");
    assert.equal(result.keyboardBlocked.opened, true, "键盘激活打开弹窗");
    assert.equal(result.keyboardBlocked.closes, true, "关闭后弹窗消失");
    assert.equal(result.keyboardBlocked.focusReturned, true, "关闭后焦点归还阻塞行");

    /* 6. 缺失场景：未就绪指向在场、三区零渲染、宽窄不溢出（禁自算兜底的真 DOM 证据）。 */
    const missing = (await runBoardPaneInElectron({
      pageHtml: buildPageHtml({ css, boardJson: missingFixture.boardJson, bundle }),
      driver: dispatchMissingDriverSource(),
      label: "dispatch-missing",
    })) as MissingResult | null;
    console.log(`DISPATCH_MISSING_MEASUREMENTS=${JSON.stringify(missing, null, 1)}`);
    assert.ok(missing, "缺失场景应回传量取结果");
    for (const [label, snapshot] of [
      ["宽档 1400", missing.wide],
      ["窄档 360", missing.narrow],
    ] as const) {
      assert.equal(snapshot.state, "missing", `${label}：缺 dispatch 段 → 未就绪态`);
      assert.equal(snapshot.recompile, true, `${label}：重编译指向在场`);
      assert.equal(snapshot.recompileRole, "status", `${label}：未就绪可感知（role=status）`);
      assert.equal(snapshot.zoneCount, 0, `${label}：三区零渲染（不自算兜底）`);
      assert.equal(snapshot.cardCount, 0, `${label}：无任何卡片锚点`);
      assertNoHorizontalOverflow(snapshot.probe, `${label} 未就绪面`);
    }

    console.log(
      "DISPATCH_BROWSER_ASSERTIONS_OK 三区=[102,103,108]/[101,105,107]/[102,108]（域/原因/槽位行直读 CLI）；" +
        "宽窄两档无溢出；窄档行高>=44px；点 #102/#101 弹窗开闭+焦点归还；阻塞行 #107 键盘打开；" +
        "缺段未就绪 + 三区零渲染",
    );
  } finally {
    cleanupDispatchFixture(fixture);
    cleanupDispatchFixture(missingFixture);
  }
}

await main();
