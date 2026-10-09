import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, SquadRunRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import type { WorkItemLaneDimension } from "../src/squad/workItemsViewModel.js";
import {
  WORK_ITEMS_SURFACE_BASELINE_DEFAULT_LANES,
  WORK_ITEMS_SURFACE_BASELINE_EMPTY,
  WORK_ITEMS_SURFACE_BASELINE_LANES,
  WORK_ITEMS_SURFACE_BASELINE_NONE,
} from "./workItemsSurfaceBaseline.js";

/* 「工作项 Surface 宿主 + 共用行模块 + 三视图」（阶段二 · T-P2-R1 接口冻结轮）的**呈现与接线**守卫。

   三件本轮必须成立的事：
   ① **默认路径零回归（承重验收 2）**：`view=board` 且无过滤/搜索/排序时，宿主渲染出的 markup 与
      字面量基线**逐字节相同** —— 基线在 `workItemsSurfaceBaseline.ts`；
      口径更新（用户 2026-10-09 裁定「默认按阶段进行分组」）：那份「无分组」基线改由**显式
      `none`** 态使用，默认态另立一条泳道基线（`..._DEFAULT_LANES`）；
      口径更新之二（2026-10-09 G4 实测 F1/F2 的**结构恒定**裁定）：桌面宿主改为恒定壳
      （`work-items-surface-split` 恒在，peek 未打开只是右列零节点）⇒ 四份基线按新实现的
      真实渲染**机械重捕捉**，自此证明「2026-10-09 之后逐字节不变」（细节见基线文件头注记）；
   ② **行渲染单点（承重验收 5，口径已更新）**：`data-work-item-id` 与聚焦注册各**恰一处**，且三视图
      消费**同一个**模块（从「WorkItemsBoard 内单点」改为「跨三视图共用同一模块」）；
   ③ 三视图分支都真实可达（宿主预置分支，R2/R3 只换视图内部实现，不改宿主）。

   期望值的独立真源：拆解卡 §阶段二 T-P2-R1 的验收 2/5/6 + 重构前的真实渲染输出。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到 `.filter(` / `data-work-item-id` 是**说明**，不是代码本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 与基线捕获脚本**逐字一致**的夹具（改一处就要重新捕获基线，见基线文件头）。 */
function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: "标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

/** 只给 `isSquadBatchRoot` 关心的那一个字段（渲染不读 run 的其它列）。 */
const run = (parentWorkItemId: string) => ({ parentWorkItemId }) as unknown as SquadRunRecord;

function snapshotWith(workItems: WorkItem[], runs: SquadRunRecord[] = []): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [
      {
        id: "ta-1",
        name: "队员",
        systemPrompt: "s",
        skills: [],
        memoryScope: "project",
        enabled: true,
        color: "blue",
      },
    ] as SquadSnapshot["teamAgents"],
    squads: [],
    workItems,
    runs,
    queuedRuns: [],
  };
}

const defaultItems: WorkItem[] = [
  wi({
    id: "wi-root",
    title: "批根标题",
    status: "in_progress",
    priority: "high",
    identifierSeq: 12,
    labels: ["甲", "乙", "丙", "丁"],
    assignee: { type: "agent", id: "ta-1" },
  }),
  wi({ id: "wi-child", parentId: "wi-root", title: "子项标题", archivedAt: 7 }),
  wi({ id: "wi-orphan", parentId: "gone", title: "孤儿标题" }),
];
const laneItems: WorkItem[] = [
  wi({ id: "wi-todo", title: "未开始的一条" }),
  wi({ id: "wi-done", title: "已完成的一条", status: "done" }),
];

/** 用户 2026-10-09 裁定「默认按阶段进行分组」：页面的 `laneDimension` 默认值。
    真源在 `WorkItemsPage` 的 `useState`（字面量一致性由 `workItemsLanes` / `workItemsPage` 的
    页面源码守卫咬住）—— 这里的「默认态」渲染必须用同一个值，否则本文件的默认路径判据会
    悄悄测成一条非默认路径。 */
const DEFAULT_LANE_DIMENSION: WorkItemLaneDimension = "statusCategory";

function renderSurface(input: {
  workItems: WorkItem[];
  runs?: SquadRunRecord[];
  laneDimension?: WorkItemLaneDimension;
  surface?: WorkItemSurfaceState;
}): string {
  const {
    workItems,
    runs = [],
    laneDimension = DEFAULT_LANE_DIMENSION,
    surface = workItemSurfaceDefaultState(),
  } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot: snapshotWith(workItems, runs),
        discardableIds: new Set(["wi-root"]),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension,
        surface,
        // T-P2-R3：宿主新增意图透传（table 视图的表头排序/列显隐）；逐字节基线只渲染不交互。
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
      }),
    }),
  );
}

// ---------- ① 显式「不分组」逐字节零回归 + 默认态（按阶段分组）基线（承重验收 2） ----------

/* 变异（承重）：不分组分支里顺手排序 / 过滤，或行模块抽件时改了任何一处 class 或属性顺序
   ⇒ 逐字节对照必红（这是本轮的承重判据）。
   口径（用户 2026-10-09 裁定）：`none` 不再是默认值，但「不分组」路径**逐字不变** —— 同一份
   基线改由显式 `laneDimension: "none"` 使用（不逐个把断言改成泳道断言）。
   口径之二（2026-10-09 结构恒定）：字面量含恒定壳；写进壳里的 body 与开关 peek 前的内部
   markup 一致（Radix 标识除外）。 */
test("零回归｜显式「不分组」（laneDimension=none）：渲染 markup 与基线逐字节相同（恒定壳口径）", () => {
  assert.equal(
    renderSurface({ workItems: defaultItems, runs: [run("wi-root")], laneDimension: "none" }),
    WORK_ITEMS_SURFACE_BASELINE_NONE,
    "「不分组」这一条路径的 markup 必须与重构前逐字节一致",
  );
});

/* 用户 2026-10-09 裁定「默认按阶段进行分组」：**默认态**（页面 useState 的默认维度 = statusCategory）
   的真实渲染 = 按阶段分成 4 列（`work-items-lanes` 锚点 + 每列计数），逐字节基线机械捕捉
   （照 R1 的独立真源做法：基线取自真实渲染输出，不手工改写）。
   口径更新（2026-10-09 用户裁定「看板 multica 形态重排」）：分组容器从**纵堆泳道**改为
   **横排固定 280px 列 + 卡片**（spec §10-A），两份看板分组基线按新实现的真实渲染**机械重捕捉**；
   行序/列次序/计数口径不变（本用例的后半段断言仍逐项成立）。「不分组」与「空态」基线未动。
   变异：默认维度改回 `none`（或页面不再按阶段分组）⇒ 本用例 + 两个页面源码守卫必红；
   基线改一字节 ⇒ 必红。 */
test("默认态｜按阶段分组（用户 2026-10-09 裁定）：默认维度渲染 = 4 列（锚点 + 每列计数），与基线逐字节相同", () => {
  /* 先钉「本用例测的真是默认态」：页面 useState 的默认值必须就是本文件的默认维度常量
     （两处不一致 = 下面这条基线描述的已经不是默认态，而是一份没人解释的状态）。 */
  assert.ok(
    stripComments(readSource("squad/WorkItemsPage.tsx")).includes(
      `useState<WorkItemLaneDimension>("${DEFAULT_LANE_DIMENSION}")`,
    ),
    "页面默认维度与本案的默认态常量必须同一（默认改回 none ⇒ 本条必红）",
  );
  const markup = renderSurface({ workItems: defaultItems, runs: [run("wi-root")] });
  assert.equal(
    markup,
    WORK_ITEMS_SURFACE_BASELINE_DEFAULT_LANES,
    "默认态的真实列渲染逐字节对照（锚点 / 4 列键 / 计数 / 卡片内容）",
  );
  /* 每列的计数由夹具语义手算（独立真源）：批根 in_progress ⇒ started（子项随根 = 2 行）、
     孤儿 todo ⇒ unstarted（1 行）、done / closed 空列保留为 0。
     切片窗口 = 从列键到列体（`<ul`）之间：列头带图标（SVG 占几百字符）⇒ 窗口取 1200。 */
  for (const [laneKey, count] of [
    ["unstarted", 1],
    ["started", 2],
    ["done", 0],
    ["closed", 0],
  ] as const) {
    const start = markup.indexOf(`data-lane-key="${laneKey}"`);
    assert.ok(start >= 0, `默认态必须是按 stage 分组的列（缺 ${laneKey}）`);
    const column = markup.slice(start, markup.indexOf("<ul", start));
    assert.ok(column.includes(`${count} 项`), `列 ${laneKey} 的计数必须是 ${count} 项`);
  }
  // 「不分组」保留为 Group by 可选项：显式选它 ⇒ 回平铺（既有单 ul 锚点），不出现泳道壳。
  const flat = renderSurface({
    workItems: defaultItems,
    runs: [run("wi-root")],
    laneDimension: "none",
  });
  assert.ok(flat.includes('data-testid="work-items-list"'), "显式「不分组」仍是单 ul（既有锚点）");
  assert.ok(!flat.includes('data-testid="work-items-lanes"'), "显式「不分组」不得出现泳道壳");
});

test("零回归｜泳道视图（statusCategory）与空态块：同样逐字节相同", () => {
  assert.equal(
    renderSurface({ workItems: laneItems, laneDimension: "statusCategory" }),
    WORK_ITEMS_SURFACE_BASELINE_LANES,
    "泳道分支的 markup 与重构前逐字节一致",
  );
  assert.equal(
    renderSurface({ workItems: [] }),
    WORK_ITEMS_SURFACE_BASELINE_EMPTY,
    "空态块与重构前逐字节一致（空态在宿主里，锚点 work-items-empty 不变）",
  );
});

// ---------- ② 三视图分支可达 + 共用行模块（承重验收 5） ----------

/* 三视图都真实可达：list/table 分支由宿主预置（R2/R3 只换视图内部实现，**不改宿主**）——
   否则「分支已预置」这条前置不成立，并行组就得回头改串行点文件。 */
test("三视图：宿主按视图模式分派（board 锚点保留，list / table 各有独立容器锚点）", () => {
  // 显式「不分组」：本用例钉的是 board 的既有单 ul 锚点（默认态现在是泳道，见上一条）。
  const board = renderSurface({ workItems: defaultItems, laneDimension: "none" });
  assert.ok(board.includes('data-testid="work-items-list"'), "board 仍是既有单 ul 锚点");

  const list = renderSurface({
    workItems: defaultItems,
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "setView",
      view: "list",
    }),
  });
  assert.ok(list.includes('data-testid="work-items-list-view"'), "list 视图有自己的容器锚点");
  assert.ok(!list.includes('data-testid="work-items-lanes"'), "list 不是看板泳道壳");

  const table = renderSurface({
    workItems: defaultItems,
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "setView",
      view: "table",
    }),
  });
  assert.ok(table.includes('data-testid="work-items-table-view"'), "table 视图有自己的容器锚点");

  // 三视图渲染的行集相同（同一份投影 + 同一个行模块）：行锚点计数一致即证明行模块真被共用。
  const rowsOf = (markup: string) => (markup.match(/data-work-item-id=/g) ?? []).length;
  assert.equal(rowsOf(board), 3);
  assert.equal(rowsOf(list), rowsOf(board), "list 与 board 的行集相同（共用同一份投影/行模块）");
  assert.equal(rowsOf(table), rowsOf(board), "table 与 board 的行集相同");
});

test("搜索生效时：三视图都只渲染命中的树，且宿主给「无匹配」态而不是「还没有工作项」", () => {
  const surface = applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
    kind: "setSearch",
    search: "子项",
  });
  const markup = renderSurface({ workItems: defaultItems, surface });
  assert.equal((markup.match(/data-work-item-id=/g) ?? []).length, 2, "子项命中 ⇒ 整棵批树留下");
  assert.ok(markup.includes("wi-root"), "批根仍在（批是行的视觉单元）");
  assert.ok(!markup.includes("wi-orphan"), "未命中的树整体消失");

  const none = renderSurface({
    workItems: defaultItems,
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "setSearch",
      search: "查不到的东西",
    }),
  });
  assert.ok(
    none.includes('data-testid="work-items-filtered-empty"'),
    "有数据但被筛掉 ⇒ 「无匹配」态（与「还没有工作项」分开）",
  );
  assert.ok(
    !none.includes('data-testid="work-items-empty"'),
    "不得同时出现「还没有工作项」—— 两态是分开的分支",
  );
});

/* 承重验收 5（**口径更新**）：行渲染单点从「WorkItemsBoard 单点」改为「跨三视图共用同一模块」。
   判据：行锚点与聚焦注册**各恰一处**且都在 `WorkItemRows.tsx`；三个视图模块都 import 它。
   变异：给 list/table 复制一份行 JSX（或让某视图自己注册 DOM）⇒ 下面的计数/import 断言必红。 */
test("行渲染单点（口径更新）：data-work-item-id 与聚焦注册各恰一处，且三视图共用同一模块", () => {
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  assert.equal(
    (rows.match(/data-work-item-id=\{item\.id\}/g) ?? []).length,
    1,
    "行 JSX 只能有一处：复制一份「列表版/表格版行渲染」= 聚焦与高亮在某条路径上静默失效",
  );
  assert.equal(
    (rows.match(/rowElementsRef\.current\.set\(/g) ?? []).length,
    1,
    "行 DOM 引用注册只此一处（三视图共用它）",
  );
  // 三视图都必须真的消费这个模块（不是「各自另写一份看起来一样的行」）。
  for (const file of [
    "squad/WorkItemsBoard.tsx",
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
  ]) {
    const source = stripComments(readSource(file));
    assert.ok(
      source.includes("WorkItemRowList") || source.includes("WorkItemRow"),
      `${file} 必须消费共用行模块（不得自写行渲染）`,
    );
    assert.ok(
      !source.includes("data-work-item-id"),
      `${file} 不得自己写行锚点（那意味着第二份行 JSX）`,
    );
  }
});

test("行模块归属：聚焦钩子与行 DOM 引用只在行模块里（宿主/看板不再自己注册 DOM）", () => {
  for (const file of ["squad/WorkItemsSurface.tsx", "squad/WorkItemsBoard.tsx"]) {
    const source = stripComments(readSource(file));
    assert.ok(
      !source.includes("rowElementsRef") && !source.includes("scrollIntoView("),
      `${file} 不得自带聚焦注册/滚动（聚焦只有行模块那一份实现，漏一条路径就是静默失效）`,
    );
  }
});

/* 承重验收 1：**判据全在纯函数** —— 视图层（宿主/行模块/三视图）不得出现业务 `.filter(`/`.sort(`。
   变异：把过滤写进组件 ⇒ 本条必红。 */
test("判据在纯函数：视图层源码不得出现 .filter( / .sort( 业务判据", () => {
  for (const file of [
    "squad/WorkItemsSurface.tsx",
    "squad/WorkItemRows.tsx",
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
    // T-P2-R3：表格单元格也是视图层（自己排/自己筛 = 第二份投影判据）。
    "squad/WorkItemTableCell.tsx",
    "squad/WorkItemsBoard.tsx",
  ]) {
    const source = stripComments(readSource(file));
    for (const forbidden of [".filter(", ".sort(", "localeCompare("]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} 不得出现 ${forbidden}（投影/过滤/排序的判据在 workItemSurfaceViewModel）`,
      );
    }
  }
});

/* 宿主只接线一次（阶段二 §6.3 的串行点纪律）：页面渲染**宿主**而不是看板；三视图的分支只在宿主里。
   变异：页面直接渲染 WorkItemsBoard ⇒ 下面的第一条必红（那就等于绕开宿主，list/table 不可达）。 */
test("接线：页面渲染宿主一次、把 Surface 状态与意图交给动作行（R4 只加控件、不改宿主）", () => {
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  assert.ok(page.includes("<WorkItemsSurface"), "页面必须渲染 Surface 宿主（唯一接线点）");
  assert.ok(!page.includes("<WorkItemsBoard"), "页面不得直接渲染看板（否则 list/table 不可达）");
  /* T-P2-R6b 口径更新：意图折叠从页面搬到**视图接线层**（`useWorkItemsViewsBridge`，页面的
     max-lines 硬线）—— 判据不变：默认值来自纯函数、意图折叠仍走纯函数，页面仍持有那两份状态。 */
  assert.ok(page.includes("workItemSurfaceDefaultState"), "默认 Surface 状态来自纯函数");
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    bridge.includes("applyWorkItemSurfaceIntentWithBaseline("),
    "意图折叠走纯函数（有视图时 clearQuery 回视图条件）",
  );
  for (const needle of ["surface={surface}", "onSurfaceIntent={viewsBridge.applySurfaceIntent}"]) {
    assert.ok(page.includes(needle), `页面接线缺 ${needle}`);
  }
  assert.ok(
    page.includes("onInlineEdit={submitInlineEdit}") &&
      page.includes("laneDimension={laneDimension}"),
    "页面仍持有行内编辑与分组维度的接线",
  );
  const actions = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    actions.includes('data-testid="work-items-view-mode"') && actions.includes("onSurfaceIntent("),
    "动作行渲染视图切换并只回传意图（控件带由 R4 在同一处扩展）",
  );
});
