import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, SquadRunRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { squadDiscardableWorkItemIds } from "../src/squad/squadEntryViewModel.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
  type WorkItemViewMode,
} from "../src/squad/workItemSurfaceViewModel.js";

/* 「list 视图：高密度树形行 + 批次子树呈现」（阶段二 · T-P2-R2）的**呈现与结构守卫**。

   本文件盯的四条（卡面验收）：
   ① 行复用共用模块 —— `data-work-item-id` / `rowElementsRef` 各**恰一处**（全 `src` 树扫描）；
   ② 批根入口判据单源 —— 行链上不得出现本地 `"squad"` 判定，判据只经 `isSquadBatchRoot`；
   ③ 收件箱聚焦在 list 视图同样可用 —— 所有行都挂载且经共用行模块注册（漏一条路径 = 静默失效）；
   ④ 零新文案键 —— list 视图自己不产出任何文案（行拥有全部词汇）。

   本包没有渲染测试设施，但**真渲染**（`react-dom/server` + 真 `ZCodeIntlProvider`）是既有先例
   （workItemsSurfaceRender / workItemInlineEditRow 都这么做）：行的行序、深度缩进与批根入口的
   「有 / 无」只有渲染出来才看得见。

   期望值的独立真源：拆解卡 §阶段二 T-P2-R2（扁平树形行、按 depth 缩进、批根保留时间线/放弃入口）
   + 拆解 §3 的深度手法 `depth * 12 + 8`（沿用 WikiCatalogTree）+ 服务面 `isSquadBatchRoot` 的
   两条并列证据（指派给小队 ∥ 台账有以它为 parent 的 run）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 全 `src` 树的源码文件（守卫要的是「全树恰一处」，不是「某个文件里恰一处」）。 */
function listSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC_DIR);
  return files.sort();
}
/** 全 `src` 树只读一次（8 处守卫都在同一份快照上判定：本用例文件不改源码，读一次足够）。 */
let sourceSnapshot: Array<{ file: string; source: string }> | null = null;
const relativeSourceFiles = () =>
  (sourceSnapshot ??= listSourceFiles().map((file) => ({
    file: file.slice(SRC_DIR.length + 1),
    source: stripComments(readFileSync(file, "utf8")),
  })));
/** 命中某根针的文件（去注释后扫）——用于「第二份实现」类守卫。 */
const filesUsing = (needle: string) =>
  relativeSourceFiles()
    .filter((entry) => entry.source.includes(needle))
    .map((entry) => entry.file);
const countIn = (file: string, needle: string) =>
  stripComments(readSource(file)).split(needle).length - 1;

/** 造一条工作项（只给本组用例关心的字段）。 */
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

/**
 * 一棵三层批树 + 两条独立根：覆盖「批根行承载入口」「子项/孙项随批缩进」「不在名册里的父 = 孤儿」
 * 三种行，以及批根判据的**两条并列证据**（`wi-root` 有 run；`wi-squad` 指派给小队且零 run）。
 */
const TREE: WorkItem[] = [
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
  wi({ id: "wi-grandchild", parentId: "wi-child", title: "孙项标题" }),
  wi({
    id: "wi-squad",
    title: "空批根（指派给小队、零 run）",
    assignee: { type: "squad", id: "sq-1" },
  }),
  wi({ id: "wi-orphan", parentId: "gone", title: "孤儿标题" }),
];

function snapshotWith(workItems: WorkItem[], runs: SquadRunRecord[]): SquadSnapshot {
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

/** 经**真宿主**渲染某个视图：走的就是页面 → 宿主 → 视图 → 共用行模块那条链。 */
function renderView(
  view: WorkItemViewMode,
  over: Partial<{
    items: WorkItem[];
    runs: SquadRunRecord[];
    surface: WorkItemSurfaceState;
    /** 项目清单（R-P2）：注入后行上的项目 chip 才有名字可画（缺省 = 还没读到 ⇒ 不画）。 */
    workItemProjects: readonly { id: string; name: string; shortCode: string }[];
  }> = {},
) {
  const items = over.items ?? TREE;
  const runs = over.runs ?? [run("wi-root")];
  const snapshot = snapshotWith(items, runs);
  const surface: WorkItemSurfaceState = over.surface ?? {
    ...workItemSurfaceDefaultState(),
    view,
  };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems: items,
        snapshot,
        // 「放弃整批」的判据**不是测试自己写死**：用页面同一份纯函数由快照推出（单源）。
        discardableIds: squadDiscardableWorkItemIds(snapshot),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface,
        // T-P2-R3：宿主新增意图透传（table 视图的表头排序/列显隐消费它）；本用例只渲染不交互。
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(over.workItemProjects === undefined
          ? {}
          : {
              workItemProjects: {
                projects: over.workItemProjects,
                createProject: async () => ({
                  kind: "failed" as const,
                  feedback: { tone: "error" as const, messageId: "squad.common.operationFailed" },
                }),
                reload: async () => {},
              },
            }),
      }),
    }),
  );
}

/** 打开 testid 元素的整个开标签（用来断言「锚点挂在哪个元素上」）。 */
function openingTagOf(markup: string, testId: string): string {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0] ?? "";
}

/** 逐行的 (id, depth, paddingLeft)：行序与缩进**从渲染结果里读**，不从实现里抄。 */
function rowFacts(markup: string): Array<[string, number, number]> {
  return [
    ...markup.matchAll(
      /data-work-item-id="([^"]+)" data-depth="(\d+)" style="padding-left:(\d+)px"/g,
    ),
  ].map((match) => [match[1]!, Number(match[2]), Number(match[3])]);
}

/** 把 markup 按行切开（每行 = 从它的 `data-work-item-id` 到下一行的起点）：行内有没有某个入口。 */
function rowSegments(markup: string): Array<{ id: string; markup: string }> {
  const starts = [...markup.matchAll(/data-work-item-id="([^"]+)"/g)];
  return starts.map((match, index) => ({
    id: match[1]!,
    markup: markup.slice(match.index, starts[index + 1]?.index ?? markup.length),
  }));
}

// ---------- ① 列表容器（扁平、单一、锚点自有） ----------

test("list 视图容器：锚点保留在列表视图自己的容器上，并带 data-view=list 标记", () => {
  const list = renderView("list");
  const container = openingTagOf(list, "work-items-list-view");
  assert.ok(container.length > 0, "锚点保留：list 容器仍以 work-items-list-view 定位");
  assert.ok(
    container.includes('data-view="list"'),
    "list 视图的容器带 data-view=list（看板的单 ul 与 list 的容器在 DOM 上因此可区分）",
  );
  assert.ok(
    !renderView("board").includes("data-view="),
    "看板容器不带 data-view 标记（默认看板 DOM 零变化）",
  );
});

// ---------- ② 批次子树呈现：按深度缩进、单列扁平 ----------

test("list 视图：整棵批次子树按深度缩进（DFS 前序，子项/孙项紧随其父），单一容器不做分组", () => {
  const list = renderView("list");
  assert.equal(
    (list.match(/<ul /g) ?? []).length,
    1,
    "只有一个行容器：把每棵树包成容器/分组 = 拆解 §3.1 否决的「批次分组」（第三份根投影）",
  );
  assert.equal(
    (list.match(/<li /g) ?? []).length,
    TREE.length,
    "全部行都挂在这一个列表里（含子项与孙项 —— 漏挂 = 聚焦注册漏一条路径）",
  );
  assert.deepEqual(
    rowFacts(list),
    [
      ["wi-root", 0, 8],
      ["wi-child", 1, 20],
      ["wi-grandchild", 2, 32],
      ["wi-squad", 0, 8],
      ["wi-orphan", 0, 8],
    ],
    "行序 = flattenWorkItemBoard 的 DFS 前序；缩进 = depth*12+8（拆解 §3 的既有手法）",
  );
});

// ---------- ③ 批根行入口：时间线 / 放弃整批仍在批根**行**上 ----------

/* 判据是服务面唯一实现 `isSquadBatchRoot`（两条并列证据：指派给小队 ∥ 台账有以它为 parent 的 run）。
   夹具刻意两条各来一个：`wi-root`（有 run）与 `wi-squad`（指派给小队、零 run）—— 只认其中一条
   的实现会让另一个静默少一个入口，而「少一个入口」不报错。
   「放弃整批」是**独立判据**（`squadDiscardableWorkItemIds`：批根 ∧ 未终态 ∧ **确有 run**）：
   `wi-squad` 是批根但零 run ⇒ 不该给破坏性入口。 */
test("list 视图：批根行保留时间线展开钮（两条并列证据各一例），非批根行不给", () => {
  const segments = rowSegments(renderView("list"));
  const withTimeline = segments.filter((row) =>
    row.markup.includes('data-testid="work-item-timeline-toggle"'),
  );
  assert.deepEqual(
    withTimeline.map((row) => row.id),
    ["wi-root", "wi-squad"],
    "时间线钮只在批根行：有 run 的根 与 指派给小队的空根 各一例；子项/孙项/孤儿都没有",
  );
  for (const row of segments) {
    if (row.id !== "wi-root" && row.id !== "wi-squad") {
      assert.ok(
        !row.markup.includes('data-testid="work-item-timeline-toggle"'),
        `${row.id} 不是批根，不得给时间线入口`,
      );
    }
  }
});

test("list 视图：放弃整批入口只给「批根 ∧ 未终态 ∧ 确有 run」的行（零 run 的空批根不给）", () => {
  const segments = rowSegments(renderView("list"));
  const withDiscard = segments.filter((row) =>
    row.markup.includes('data-testid="work-item-discard"'),
  );
  assert.deepEqual(
    withDiscard.map((row) => row.id),
    ["wi-root"],
    "判据来自 squadDiscardableWorkItemIds（快照推出，不是测试写死）：空批根 wi-squad 不给破坏性入口",
  );
});

// ---------- ④ 聚焦（收件箱「打开工作项」）在 list 视图同样可用 ----------

/* 渲染证据：聚焦靠的是「行挂载时注册进 `rowElementsRef`」，所以**每条可见项都必须有行锚点**；
   漏挂的表现是「滚动 + 高亮什么也没发生」且**不报错**（拆解 §3.1 否决批次分组的第 3 条理由）。
   搜索命中孙项 ⇒ 整棵批树留下（R1 的树单元口径）⇒ 孙项也必须有行 —— 这正是聚焦深节点的路径。 */
test("聚焦（渲染证据）｜list 视图下每条可见项都有行锚点（投影后整棵树都挂载，含深节点）", () => {
  assert.deepEqual(
    rowFacts(renderView("list")).map(([id]) => id),
    TREE.map((item) => item.id),
    "全量视图：逐条挂载，注册表键集 = 可见集",
  );
  const filtered = renderView("list", {
    surface: { ...workItemSurfaceDefaultState(), view: "list", search: "孙项" },
  });
  assert.deepEqual(
    rowFacts(filtered).map(([id]) => id),
    ["wi-root", "wi-child", "wi-grandchild"],
    "命中孙项 ⇒ 整棵批树留下：聚焦深节点时它的行确实在注册表里（不能只留下命中的那一条）",
  );
});

// ---------- ⑤ 项目 chip（R-P2：list 行是**静态文字** chip，不是 picker） ----------

/* 形态真源：multica `list-row.tsx:172-177`（列表行的项目是静态文字，不是 picker）——
   本仓 v1 的绑定入口只在创建流（快速创建条 / 新建对话框），行上不引入第二个写路径。
   变异：给某一行的 chip 加按钮/下拉 ⇒ 第三条必红；无项目也画一个空 chip ⇒ 第二条必红。 */
test("list 行项目 chip：有项目才有（静态文字、带项目名、无按钮），无项目整块不渲染", () => {
  const bound = wi({ id: "wi-bound", title: "挂了项目", projectId: "proj-alpha" });
  const free = wi({ id: "wi-free", title: "无项目" });
  const markup = renderView("list", {
    items: [bound, free],
    runs: [],
    workItemProjects: [{ id: "proj-alpha", name: "阿尔法", shortCode: "ALP" }],
  });
  const segments = rowSegments(markup);
  const boundRow = segments.find((row) => row.id === "wi-bound")!;
  const freeRow = segments.find((row) => row.id === "wi-free")!;
  const chipTag =
    /<[a-z]+[^>]*data-testid="work-item-project-chip"[^>]*>/.exec(boundRow.markup)?.[0] ?? "";
  assert.ok(chipTag.length > 0, "挂了项目的行有 chip");
  assert.ok(
    chipTag.startsWith("<span"),
    "chip 是**静态文字**元素（不是按钮/下拉 = 第二个项目写路径）",
  );
  assert.ok(!chipTag.includes('role="button"'), "chip 不可点（绑定入口只在创建流）");
  assert.ok(boundRow.markup.includes("阿尔法"), "chip 显示项目名（不是 id）");
  assert.ok(
    !freeRow.markup.includes('data-testid="work-item-project-chip"'),
    "无项目 ⇒ 整块不渲染（空 chip 是噪音）",
  );
});

test("list 行项目 chip：清单还没读到（projects=null）⇒ 不画（不显示 uuid）", () => {
  const markup = renderView("list", {
    items: [wi({ id: "wi-bound", projectId: "proj-alpha" })],
    runs: [],
  });
  assert.ok(!markup.includes('data-testid="work-item-project-chip"'));
  assert.ok(!markup.includes("proj-alpha"), "清单缺席时连 id 都不画（读面回来后才画名字）");
});

/* R-P2：项目过滤在**真宿主**上生效（判据在纯函数，这里钉「视图真的吃到了它」）——
   只勾「无项目」⇒ 有项目的行消失；勾一个项目 ⇒ 只有它的行留下。 */
test("list 行项目过滤（R-P2）：只勾「无项目」只留无项目行；勾项目只留它的行", () => {
  const items = [
    wi({ id: "wi-a", title: "甲", projectId: "proj-alpha" }),
    wi({ id: "wi-b", title: "乙", projectId: "proj-beta" }),
    wi({ id: "wi-free", title: "丙" }),
  ];
  const idsOf = (markup: string) =>
    [...markup.matchAll(/data-work-item-id="([^"]+)"/g)].map((m) => m[1]);
  const noneOnly = renderView("list", {
    items,
    runs: [],
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "toggleNoProjectFilter",
    }),
  });
  assert.deepEqual(idsOf(noneOnly), ["wi-free"], "只勾「无项目」⇒ 隐藏所有有项目项");
  const oneProject = renderView("list", {
    items,
    runs: [],
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "toggleProjectFilter",
      projectId: "proj-beta",
    }),
  });
  assert.deepEqual(idsOf(oneProject), ["wi-b"], "勾一个项目 ⇒ 只留它里面的行");
  const both = renderView("list", {
    items,
    runs: [],
    surface: applyWorkItemSurfaceIntent(
      applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
        kind: "toggleProjectFilter",
        projectId: "proj-alpha",
      }),
      { kind: "toggleNoProjectFilter" },
    ),
  });
  assert.deepEqual(idsOf(both), ["wi-a", "wi-free"], "项目 + 无项目一起勾 ⇒ 并集");
});

// ---------- ⑥ 结构守卫（全 src 树扫描） ----------

/* 验收 1（行复用共用模块）：`data-work-item-id` 与聚焦注册**全树各恰一处**，且都在共用行模块。
   变异（M-复制行）：把行 JSX 复制给某个视图/分支（哪怕只多一个 `data-work-item-id` 或一句
   `rowElementsRef.current.set(`）⇒ 下面的文件集与计数必红。 */
test("守卫｜行渲染单点（全 src 树）：行锚点与聚焦注册各恰一处，且都在 WorkItemRows", () => {
  assert.deepEqual(
    filesUsing("data-work-item-id"),
    ["squad/WorkItemRows.tsx"],
    "行锚点只能出现在共用行模块里（第二处 = 有人复制了行渲染）",
  );
  assert.equal(
    countIn("squad/WorkItemRows.tsx", "data-work-item-id={item.id}"),
    1,
    "行锚点在行模块里恰一处",
  );
  assert.deepEqual(
    filesUsing("rowElementsRef.current.set("),
    ["squad/WorkItemRows.tsx"],
    "行 DOM 引用注册只能出现在共用行模块里",
  );
  assert.equal(
    countIn("squad/WorkItemRows.tsx", "rowElementsRef.current.set("),
    1,
    "注册只此一句（漏一条路径 = 聚焦在该视图静默失效）",
  );
  assert.deepEqual(
    filesUsing("function WorkItemRowList"),
    ["squad/WorkItemRows.tsx"],
    "行列表实现只有一份（视图只能消费，不能自带一份）",
  );
});

/* 验收 1/3（三视图 + 看板两分支都真的走同一个行列表）：本视图是**扁平单列表**（恰一处
   `<WorkItemRowList`），且把 `flattenWorkItemBoard(items)` 整份交给它 —— 行序/深度是唯一 DFS 给的，
   视图不自己挑行（自己挑 = 漏挂）。变异（M-漏路径）：只渲染根行（丢掉子项）⇒ 上一条渲染证据 +
   本条的 `rows=` 断言必红。 */
test("守卫｜四个消费点全走共用行列表：list 平铺整棵森林，看板两分支各一处，table 一处", () => {
  assert.equal(
    countIn("squad/WorkItemListView.tsx", "<WorkItemRowList"),
    1,
    "list 视图恰一个行容器（批次子树不做分组/嵌套容器）",
  );
  assert.ok(
    stripComments(readSource("squad/WorkItemListView.tsx")).includes(
      "rows={flattenWorkItemBoard(items)}",
    ),
    "list 把整棵森林（含子项/孙项）交给共用行列表 —— 不在视图里挑行、不重排",
  );
  assert.equal(
    countIn("squad/WorkItemsBoard.tsx", "<WorkItemRowList"),
    2,
    "看板的不分组与泳道两个分支共用同一个列表组件",
  );
  assert.equal(countIn("squad/WorkItemTableView.tsx", "<WorkItemRowList"), 1, "table 一处");
  assert.deepEqual(
    filesUsing("export function WorkItemListView"),
    ["squad/WorkItemListView.tsx"],
    "list 视图实现只有一份",
  );
});

/* 验收 3（聚焦注册的接线）：注册表由**宿主**创建恰一次（三视图共用），行模块是唯一注册点，
   视图链（含 list）不得自持 DOM 引用或自己滚动 —— 自己再注册一份就是「换视图后聚焦静默失效」。
   变异（M-聚焦漏路径）：在 list 视图里自己 `registerRow`／`scrollIntoView` ⇒ 本条必红。 */
test("守卫｜聚焦注册：宿主创建一次并交给行模块，视图链不自持 DOM 引用/滚动", () => {
  assert.deepEqual(
    filesUsing("useWorkItemRowFocus({"),
    ["squad/WorkItemsSurface.tsx"],
    "注册表只有宿主创建（三视图共用同一份：各建一份 = 换视图后聚焦静默失效）",
  );
  assert.ok(
    stripComments(readSource("squad/WorkItemsSurface.tsx")).includes("items: visibleItems"),
    "待消费的聚焦意图在**投影后的可见集**上重试（换视图/换查询后仍能定位）",
  );
  /* T-P2-R3 口径微调（**强度不降**）：禁的针从裸 `ring-brand` 收窄为**行高亮的那一组**
     （`ring-2 ring-brand`）。理由：`focus-visible:ring-brand` 是全仓通用的**键盘焦点环**
     （Navigation.tsx 等既有先例），视图层的原生按钮需要它才算键盘可达；裸针会把
     「焦点可见」误判成「自持高亮」。行高亮的判据改为：那一组字面量在全 `src` 树**恰一处**
     （行模块），视图层不得出现（见下方新增断言）。变异（M-高亮漂移）仍必红。 */
  for (const file of [
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
    "squad/WorkItemsBoard.tsx",
    "squad/WorkItemsSurface.tsx",
  ]) {
    const source = stripComments(readSource(file));
    for (const forbidden of [
      "rowElementsRef",
      "scrollIntoView(",
      "registerRow",
      "ring-2 ring-brand",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} 不得自持 ${forbidden}（聚焦只有行模块一份实现）`,
      );
    }
  }
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  assert.ok(rows.includes('scrollIntoView({ block: "nearest" })'), "行模块负责把目标行滚进视野");
  assert.ok(rows.includes("ring-brand"), "高亮用语义色 token（brand 环）");
  assert.equal(
    (rows.match(/ring-2 ring-brand/g) ?? []).length,
    1,
    "行高亮（`ring-2 ring-brand`）恰一处：三视图共用同一份高亮实现",
  );
  assert.match(
    rows,
    /onFocusConsumed\?\.\(\);/,
    "消费是 effect 的最后一步（目标不在列表也消费：不留悬挂意图）",
  );
  /* 注册的**接线**也要钉住：注册表存在 ≠ 行会进注册表。`registerRow` 只有在行元素上被
     `ref` 调过，map 才有那条（M-漏接线：删掉 `<li>` 的 ref 回调 —— 只数
     `rowElementsRef.current.set(` 是数不出来的，它仍在 `registerRow` 里活着）。
     T-P2-R3 口径微调（**强度不降**，assert 不删）：表格视图落地后行的容器元素在 `<li>`/`<tr>`
     之间参数化，联合标签让 TS 无法上下文推断 ref 参数 ⇒ 回调**显式标注** `HTMLElement | null`
     （`registerRow` 的类型同步放宽到 `HTMLElement`）。断言的实质不变：ref 回调把**行元素**交给
     `registerRow`，且注册接线恰一处。变异（M-漏接线）仍必红。 */
  assert.match(
    rows,
    /ref=\{\(element: HTMLElement \| null\) => \{[\s\S]{0,80}rowFocus\.registerRow\(item\.id, element\);/,
    "行的 ref 回调用行元素调 registerRow（少了这一步，聚焦在**所有**视图里静默失败）",
  );
  assert.equal(
    countIn("squad/WorkItemRows.tsx", "rowFocus.registerRow("),
    1,
    "注册接线恰一处（行渲染单点的一部分）",
  );
});

/* 验收 2（批根判据单源）：行链上的「什么是批根」只经服务面 `isSquadBatchRoot`；
   行链文件里**不得出现任何 `"squad"` 字面量**（本地重写判据的第一特征）。
   变异（M-本地判据）：在 list 视图写 `item.assignee.type === "squad"` ⇒ 本条必红。 */
test("守卫｜批根判据单源：行链零 squad 字面量，isSquadBatchRoot 只从服务面值入口取一次", () => {
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  assert.ok(
    rows.includes('import { isSquadBatchRoot } from "@zcode/services"'),
    "判据必须来自服务面的**值**入口（唯一实现，UI 不另写一份「什么是批」）",
  );
  assert.equal(countIn("squad/WorkItemRows.tsx", "isSquadBatchRoot({"), 1, "判据消费恰一处");
  for (const file of [
    "squad/WorkItemRows.tsx",
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
    "squad/WorkItemsBoard.tsx",
    "squad/WorkItemsSurface.tsx",
    "squad/WorkItemsPage.tsx",
  ]) {
    assert.ok(
      !stripComments(readSource(file)).includes('"squad"'),
      `${file} 不得出现 "squad" 字面量（批根判据只经 isSquadBatchRoot，本地判据会让入口与服务面漂移）`,
    );
  }
  assert.deepEqual(
    filesUsing("export function squadDiscardableWorkItemIds"),
    ["squad/squadEntryViewModel.ts"],
    "「放弃整批」判据同样只有一份实现",
  );
  assert.deepEqual(
    filesUsing("squadDiscardableWorkItemIds("),
    ["squad/WorkItemsPage.tsx", "squad/squadEntryViewModel.ts"],
    "消费点只有页面一处（+ 定义自身）：入口的显隐判据不在视图里重算",
  );
});

/* 验收 4（零新文案键）：list 视图**自己不产出任何文案** —— 行拥有全部词汇（标题/标签/状态/
   优先级/指派人/按钮名都来自共用行模块）。视图里出现 `formatMessage` 或 `squad.` 键字面量
   = 有人在本视图就地加话（阶段二键目录已冻结）。变异：在 list 视图写一枚新键 ⇒ 本条必红。 */
test("守卫｜零新文案键：list 视图不取 i18n、不引用任何文案键", () => {
  const list = stripComments(readSource("squad/WorkItemListView.tsx"));
  for (const forbidden of ["formatMessage", "useZCodeIntl", "squad.workItems.", "intl."]) {
    assert.ok(!list.includes(forbidden), `list 视图不得出现 ${forbidden}`);
  }
});
