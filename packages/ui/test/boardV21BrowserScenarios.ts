/**
 * 看板 v2.1 的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM + 真事件）——
 * 独立脚本，文件名不含 `.test.`（与 `boardKanbanBrowserLayout.ts` 同款：`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁，2026-10-10 用户批准）：布局（溢出）与点击路由（`<summary>` 默认动作）
 * 只有真实排版与真事件路径量得出来。四条场景（#54 两条；#59 扩两条 + T-1 列体探针）：
 *   1. 溢出探针：w-56 列内分组头行/列盒/**列体 div（#59 T-1）** `scrollWidth <= clientWidth`；
 *      长缺口徽章可折行可截断带 title；**超长假名执行角色徽记**（#59 M3）真截断且不撑宽卡片；
 *   2. 列表组头点击路由：右区（计数/徽章）派发完整指针/点击序列 → `details.open` 变化；
 *      编号+名称区 → 开弹窗且不误触折叠；
 *   3. 表格字号分层（#59 M1）：主阅读列 = text-ui-sm、弱元数据 = text-ui-xs（期望从 `--ui-font-size` 现算）；
 *   4. 弹窗焦点闭环（#59 M4）：autoFocus 落点、Tab/Shift+Tab 首末回绕、Esc 关闭后焦点回到打开者卡片；
 *      顺带量阻碍条目圆角（#59 N1 = rounded-xl）；
 *   5. 列表排序切换 + 会话记忆往返（#65）：真事件改动排序控件 → 真 DOM 行序断言（默认/段位序/
 *      最老未动三视角）；重挂面板（等价切标签再打开）后行序与控件取值从 sessionStorage 读回。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时会自动找到主仓那份）。
 *
 * 复用（#55 S-8）：溢出探针（scrollWidth vs clientWidth）与点击路由序列原语已抽为
 * `test/boardBrowserProbeKit.ts` 的固定导出——后续 UI 卡验证引用同一份，不各自复制。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardV21BrowserScenarios.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import {
  dialogFocusDriverSource,
  listGroupHeaderClickDriverSource,
  listSortDriverSource,
  overflowProbeDriverSource,
  tableTypographyDriverSource,
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
import { SORTING_BOARD } from "./boardSortingFixture.js";

/** #59 M3 的超长假名：真实板里长中文/远端 agent 名的压力形态。 */
const LONG_ROLE =
  "远端协作执行角色-超长名称用于验证徽章截断与不撑列-abcdefghijklmnopqrstuvwxyz-0123456789";

/**
 * 夹具一：在七段位夹具上把首个特性（执行中列，w-56 列内）压上两个长缺口徽章 +
 * 一个长标题——长徽章不得把组头行撑出列盒；并把执行中卡的 activeRun.role 换成超长假名
 * （#59 M3：长 agent 名不得撑宽列/卡片）。
 */
function buildFixtureBoardJson(): string {
  const raw = structuredClone(STAGE_MATRIX_BOARD) as {
    features: Array<Record<string, unknown> & { tasks: Array<Record<string, unknown>> }>;
  };
  const feature = raw.features[0];
  assert.ok(feature, "夹具应有首个特性");
  feature.attention = ["unmerged-worktree", "interrupted-resume"];
  feature.title = "预览通道（Preview Channel）——窄列里的长标题也要能收敛";
  const longRoleCard = feature.tasks[1];
  assert.ok(longRoleCard, "夹具应有执行中卡（#8）");
  longRoleCard.activeRun = { role: LONG_ROLE, at: "2026-10-09T14:20:00+08:00" };
  longRoleCard.currentAssignee = LONG_ROLE;
  return JSON.stringify(raw);
}

/** 夹具二（#59 M4）：给任务卡压一个可跳转的 dependency 阻碍——弹窗里 ≥2 个可聚焦元素。 */
function buildDialogFixtureBoardJson(): string {
  const raw = structuredClone(STAGE_MATRIX_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card = raw.features[0]?.tasks[0];
  assert.ok(card, "夹具应有任务卡（#7）");
  card.blockers = [
    { kind: "dependency", blockedBy: 8, summary: "等开关改造落地后再合并回调路径", evidence: [] },
  ];
  return JSON.stringify(raw);
}

type Probe = BoardBrowserOverflowProbe;

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
  /** #59 T-1：`[data-board-column] > div`（列头行 / 列体）逐个探。 */
  columnBodies: Probe[];
  badges: Array<{
    code: string | null;
    title: string | null;
    clientW: number;
    scrollW: number;
    truncated: boolean;
    hasTitle: boolean;
  }>;
  /** #59 M3：执行角色徽记的真排版量取。 */
  roleBadges: Array<{
    role: string | null;
    title: string | null;
    hasTitle: boolean;
    hasClipGuard: boolean;
    innerTruncated: boolean;
    card: Probe | null;
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
  /** 折叠指示符的计算样式（#55 S-3）：折叠态不旋转、展开态 group-open:rotate-90 生效。 */
  foldTransform: {
    initial: FoldStyle | null;
    collapsed: FoldStyle | null;
    expanded: FoldStyle | null;
  };
}

interface FoldStyle {
  transform: string | null;
  rotate: string | null;
}

/** 旋转签名（Tailwind v4 的 rotate 走独立属性）：`none | none` = 未旋转。 */
function rotationSignature(style: FoldStyle | null): string {
  if (!style) return "missing";
  return [style.transform, style.rotate].map((value) => (value ? value : "none")).join(" | ");
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
  // #59 T-1：列体（[data-board-column] > div）也要探——列内卡片行不得把列体撑出横向溢出。
  assert.ok(result.columnBodies.length > 0, "列盒应有直接 div 子元素（列头行/列体）可探");
  for (const [index, body] of result.columnBodies.entries()) {
    assertNoHorizontalOverflow(body, `列体 div#${index}（[data-board-column] > div）`);
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
  // #59 M3：超长假名下执行角色徽记必须真被截断（内层省略号 span 承载），全文进 title，
  // 且所在卡片不得被撑出横向溢出（不撑列）。
  const longRole = result.roleBadges.find((badge) => badge.role === LONG_ROLE);
  assert.ok(longRole, `夹具里应有超长假名执行角色徽记：${JSON.stringify(result.roleBadges)}`);
  assert.ok(longRole.hasTitle, "执行角色徽记应带 title 全文（#59 M3）");
  assert.equal(longRole.title, `${LONG_ROLE} 执行中`, "title = 完整角色文案");
  assert.ok(longRole.hasClipGuard, "执行角色徽记应带截断防线锚点（data-board-overflow-clip）");
  assert.ok(
    longRole.innerTruncated,
    "超长假名应被真截断（内层省略号 span：scrollWidth > clientWidth）",
  );
  if (longRole.card) {
    assertNoHorizontalOverflow(longRole.card, `长角色名所在的看板卡片（${longRole.role}）`);
  }
  const probeHasPressure = result.groups.some((group) => group.badgeCount > 0);
  assert.ok(probeHasPressure, "夹具前提：分组头里应有缺口徽章（探针有压力才有意义）");
  console.log(
    `OVERFLOW_ASSERTIONS_OK 分组头 ${result.groups.length} 个；长徽章 title=${longBadge.title}；` +
      `列盒宽 ${result.groups[0]?.column?.clientW ?? "?"}（宿主高 ${HOST_HEIGHT}）；` +
      `列体 ${result.columnBodies.length} 个；长角色截断=${longRole.innerTruncated}`,
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
  // #55 S-3：指示符是真 Tailwind 产物类（group-open:rotate-90）——只有真排版量得出旋转生效。
  assert.equal(
    rotationSignature(result.foldTransform.collapsed),
    "none | none",
    "折叠态指示符不旋转（computed transform/rotate = none）",
  );
  assert.notEqual(
    rotationSignature(result.foldTransform.expanded),
    "none | none",
    "展开态指示符旋转（group-open:rotate-90 在真 CSS 产物里生效）",
  );
  assert.equal(
    rotationSignature(result.foldTransform.initial),
    rotationSignature(result.foldTransform.expanded),
    "初始（默认展开）与再次展开后指示符姿态一致",
  );
  console.log(
    `LIST_CLICK_ASSERTIONS_OK 分组 ${result.featureId}：open 态 before=${states.before} → 右区=${states.afterRightRegion} → 再点=${states.afterRightRegionAgain}；标题区点击后 open=${states.afterTitleRegion}，弹窗=${result.dialogId}；fold transform=${JSON.stringify(result.foldTransform)}`,
  );
}

interface TypographyResult {
  ua: string;
  baseFontSize: string;
  title: string | null;
  status: string | null;
  lastRun: string | null;
  updatedAt: string | null;
  age: string | null;
}

/** 场景三（#59 M1）：表格字号分层——主阅读列 sm、弱元数据 xs（期望值从 `--ui-font-size` 现算）。 */
async function runTableTypographyScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ ...params, boardJson: params.boardJson }),
    driver: tableTypographyDriverSource(),
    label: "table-typography",
  })) as TypographyResult | null;
  console.log(`TABLE_TYPOGRAPHY_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "表格字号场景应回传量取结果");
  const base = Number.parseFloat(result.baseFontSize);
  assert.ok(Number.isFinite(base), `页面应暴露 --ui-font-size：${result.baseFontSize}`);
  // 真源：styles.css 的 token 定义（--text-ui-sm = ui-font-size - 2px；--text-ui-xs = - 4px）。
  assert.equal(result.title, `${base - 2}px`, "标题列 = text-ui-sm（主阅读）");
  assert.equal(result.status, `${base - 2}px`, "状态列 = text-ui-sm（主阅读）");
  for (const [label, value] of [
    ["最近执行列", result.lastRun],
    ["时间戳列", result.updatedAt],
    ["卡龄列", result.age],
  ] as const) {
    assert.equal(value, `${base - 4}px`, `${label} = text-ui-xs（弱元数据）`);
  }
  console.log(
    `TABLE_TYPOGRAPHY_ASSERTIONS_OK base=${base}px；主阅读列（标题/状态）=${result.title}；弱元数据（卡龄）=${result.age}`,
  );
}

interface DialogFocusResult {
  ua: string;
  dialogId: string | null;
  focusableCount: number;
  activeAfterOpen: { card: string | null; close: boolean; jump: boolean } | null;
  activeAfterShiftTabFromFirst: { card: string | null; close: boolean; jump: boolean } | null;
  activeAfterTabFromLast: { card: string | null; close: boolean; jump: boolean } | null;
  dialogClosed: boolean;
  activeAfterClose: { card: string | null; close: boolean; jump: boolean } | null;
  blockerRadius: string | null;
}

/** 场景四（#59 M4）：弹窗 Tab 循环 / Esc 关闭后焦点恢复；顺带量阻碍条目圆角（N1）。 */
async function runDialogFocusScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ ...params, boardJson: params.boardJson }),
    driver: dialogFocusDriverSource(),
    label: "dialog-focus",
  })) as DialogFocusResult | null;
  console.log(`DIALOG_FOCUS_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "弹窗焦点场景应回传量取结果");
  assert.equal(result.dialogId, "task:7", "打开的是被点卡片自身");
  assert.ok(result.focusableCount >= 2, "夹具弹窗应 ≥2 个可聚焦元素（关闭钮 + 跳转钮）");
  assert.equal(result.activeAfterOpen?.close, true, "打开后焦点落在关闭钮（autoFocus）");
  assert.equal(
    result.activeAfterShiftTabFromFirst?.jump,
    true,
    "首个元素 Shift+Tab → 回绕到末元素（跳转钮）——焦点留在弹窗内（containment）",
  );
  assert.equal(
    result.activeAfterTabFromLast?.close,
    true,
    "末元素 Tab → 回绕到首元素（关闭钮）——焦点留在弹窗内（containment）",
  );
  assert.equal(result.dialogClosed, true, "Esc 关闭弹窗");
  assert.equal(result.activeAfterClose?.card, "task:7", "关闭后焦点恢复到打开者卡片（#59 M4）");
  // #59 N1：弹窗内首个圆角内容容器 = rounded-xl（Tailwind 尺度 0.75rem = 12px）。
  assert.equal(result.blockerRadius, "12px", "阻碍条目圆角 = rounded-xl（N1）");
  console.log(
    `DIALOG_FOCUS_ASSERTIONS_OK 弹窗=${result.dialogId}；焦点闭环 首/末回绕+恢复到打开者；阻碍圆角=${result.blockerRadius}`,
  );
}

interface ListSortResult {
  ua: string;
  initial: string[];
  stageRows: string[];
  stageStored: string | null;
  stageSelectValue: string | null;
  oldestRows: string[];
  oldestStored: string | null;
  oldestSelectValue: string | null;
  remountRows: string[];
  remountSelectValue: string | null;
  remountStored: string | null;
}

/**
 * 场景五（#65 卡「完成沉底全视图落实 + 排序切换」）：列表排序切换的真交互（指针序列打到控件 +
 * 真 change 事件）与**会话记忆往返**（重挂面板后行序与控件取值从 sessionStorage 读回）。
 *
 * 期望行序（手推，与 Node 侧 `boardSorting.test.ts` 同一份夹具与同一口径）：
 * - 默认（最近更新）= 契约序：缺口置顶 → 未完成按 updatedAt 倒序 → 已完成沉底；
 * - 段位序：#78（待办 07:30）早于 #82（执行中 08:30）；
 * - 最老未动：#82 与 #78 之后的纯卡龄升序（不沉底）。
 */
async function runListSortScenario(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ ...params, boardJson: params.boardJson }),
    driver: listSortDriverSource(),
    label: "list-sort",
  })) as ListSortResult | null;
  console.log(`LIST_SORT_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "列表排序场景应回传量取结果");
  const RECENT_ROWS = [
    "task:75",
    "task:72",
    "task:77",
    "task:82",
    "task:78",
    "task:73",
    "task:76",
    "task:79",
    "task:74",
    "task:71",
    "task:81",
  ];
  const STAGE_ROWS = [
    "task:75",
    "task:72",
    "task:77",
    "task:78",
    "task:82",
    "task:73",
    "task:76",
    "task:79",
    "task:74",
    "task:71",
    "task:81",
  ];
  const OLDEST_ROWS = [
    "task:75",
    "task:71",
    "task:78",
    "task:74",
    "task:82",
    "task:79",
    "task:77",
    "task:76",
    "task:72",
    "task:73",
    "task:81",
  ];
  assert.deepEqual(result.initial, RECENT_ROWS, "默认序（契约序）：完成沉底的真 DOM 行序");
  assert.deepEqual(result.stageRows, STAGE_ROWS, "选「段位序」后行序按段位流水序重排");
  assert.equal(result.stageStored, "stage", "选择落 sessionStorage（会话记忆的写入路径）");
  assert.equal(result.stageSelectValue, "stage", "控件取值跟随选择");
  assert.deepEqual(result.oldestRows, OLDEST_ROWS, "再选「最老未动」后按卡龄升序（不沉底）");
  assert.equal(result.oldestStored, "oldest", "第二次选择同样落会话记忆");
  assert.equal(result.oldestSelectValue, "oldest", "控件取值跟随选择");
  // 会话记忆往返（读回路径）：重挂后视图模式（list）与排序视角（oldest）都从记忆恢复。
  assert.deepEqual(result.remountRows, OLDEST_ROWS, "重挂后面板按记忆恢复行序（读回路径有牙）");
  assert.equal(result.remountSelectValue, "oldest", "重挂后控件取值 = 记忆里的排序视角");
  assert.equal(result.remountStored, "oldest", "记忆键在重挂后仍为所选视角");
  console.log(
    `LIST_SORT_ASSERTIONS_OK 行序 ${result.initial.length} 行：默认=${result.initial.slice(0, 4).join(",")}…；` +
      `段位序=${result.stageRows.slice(0, 4).join(",")}…；最老未动=${result.oldestRows.slice(0, 4).join(",")}…；` +
      `重挂读回 select=${result.remountSelectValue} stored=${result.remountStored}`,
  );
}

async function main(): Promise<void> {
  const boardJson = buildFixtureBoardJson();
  const dialogBoardJson = buildDialogFixtureBoardJson();
  const sortingBoardJson = JSON.stringify(SORTING_BOARD);
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson, dialogBoardJson, sortingBoardJson],
    // 表格字号场景（#59 M1）需要表格视图类；弹窗夹具走列表视图；排序场景（#65）走列表视图。
    viewModes: ["kanban", "list", "table"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  await runOverflowScenario({ css, boardJson, bundle });
  await runListClickScenario({ css, boardJson, bundle });
  await runTableTypographyScenario({ css, boardJson, bundle });
  await runDialogFocusScenario({ css, boardJson: dialogBoardJson, bundle });
  await runListSortScenario({ css, boardJson: sortingBoardJson, bundle });
  console.log("BOARD_V21_BROWSER_ASSERTIONS_OK");
}

await main();
