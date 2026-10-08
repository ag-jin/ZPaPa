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
  WORK_ITEMS_SURFACE_BASELINE_DEFAULT,
  WORK_ITEMS_SURFACE_BASELINE_EMPTY,
  WORK_ITEMS_SURFACE_BASELINE_LANES,
} from "./workItemsSurfaceBaseline.js";

/* 「工作项 Surface 宿主 + 共用行模块 + 三视图」（阶段二 · T-P2-R1 接口冻结轮）的**呈现与接线**守卫。

   三件本轮必须成立的事：
   ① **默认路径零回归（承重验收 2）**：`view=board` 且无过滤/搜索/排序时，宿主渲染出的 markup 与
      重构前（抽出共用行模块之前）**逐字节相同** —— 字面量基线在 `workItemsSurfaceBaseline.ts`；
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

function renderSurface(input: {
  workItems: WorkItem[];
  runs?: SquadRunRecord[];
  laneDimension?: WorkItemLaneDimension;
  surface?: WorkItemSurfaceState;
}): string {
  const {
    workItems,
    runs = [],
    laneDimension = "none",
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

// ---------- ① 默认路径逐字节零回归（承重验收 2） ----------

/* 变异（承重）：默认状态里顺手排序 / 过滤，或行模块抽件时改了任何一处 class 或属性顺序
   ⇒ 逐字节对照必红（这是本轮的承重判据）。 */
test("零回归｜默认（board + 无过滤/搜索/排序）：渲染 markup 与重构前逐字节相同", () => {
  assert.equal(
    renderSurface({ workItems: defaultItems, runs: [run("wi-root")] }),
    WORK_ITEMS_SURFACE_BASELINE_DEFAULT,
    "抽出共用行模块 + 引入宿主后，默认路径的 markup 必须与重构前逐字节一致",
  );
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
  const board = renderSurface({ workItems: defaultItems });
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
  assert.ok(
    page.includes("workItemSurfaceDefaultState") && page.includes("applyWorkItemSurfaceIntent"),
    "页面持有 Surface 状态：默认值来自纯函数、意图折叠走纯函数",
  );
  for (const needle of [
    "surface={surface}",
    "onSurfaceIntent={applySurfaceIntent}",
    "onInlineEdit={submitInlineEdit}",
    "laneDimension={laneDimension}",
  ]) {
    assert.ok(page.includes(needle), `页面接线缺 ${needle}`);
  }
  const actions = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    actions.includes('data-testid="work-items-view-mode"') && actions.includes("onSurfaceIntent("),
    "动作行渲染视图切换并只回传意图（控件带由 R4 在同一处扩展）",
  );
});
