import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem, WorkItemStatusKey } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import type { WorkItemLaneDimension } from "../src/squad/workItemsViewModel.js";

/* 「看板 multica 形态重排」（2026-10-09 用户裁定「UI 做的不对」的根治轮）的**形态守卫**。

   为什么是渲染态守卫（而不是只读源码）：本轮换的是**看得见的结构** —— 轴（纵堆泳道 →
   横排固定 280px 列）、条目形态（表格行 → 卡片）、列头（纯标签 → 可操作面）、列底色
   （无 → 状态类别底色）。判据因此取真实渲染出来的 markup（与三视图守卫同一做法），
   不做「源码里出现过某个类名」这种自我指涉的断言。

   形态真源：`reports/2026-10-09-multica-board-ui-spec.md` §10-A（形态核心 5 件）与
   ZPaPa 侧两条裁定（登记在实现报告里）：
   · 工作项面放宽 `max-w-4xl`（board 形态必需；只动 squad 域的页面容器）；
   · 列底色**允许**（它编码的正是**状态类别**，不违反「语义色只编码状态」），取 ZPaPa 语义
     token 的低透明变体：未开始/已关闭走中性 `bg-surface`，进行中 `bg-warning/5`，已完成
     `bg-success/5`（本仓主题**没有** `--color-info`；`--color-success` 是 ZPaPa 里「完成」
     那一档语义色）。优先级/标签**保持中性**（不照搬 multica 的优先级语义色）。

   变异（每条用例都写明了）：轴换回纵堆 ⇒ ① 红；卡片丢锚点/丢字段 ⇒ ② 红；列头摘掉图标/
   计数/新建 ⇒ ③ 红；列底色摘除或换成主题里不存在的 token ⇒ ④ 红。 */

// ---------- 夹具 ----------

/** 源码级判据（只有 shell 的容器宽度没有渲染测试设施：与 `workItemsPage` 的 shell 守卫同款读源码）。 */
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到被禁的类名是**说明**，不是代码本身（与风格守卫同一口径）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

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

/** 四条状态类别各一条（unstarted / started / done / closed）—— 列骨架与列底色都按 4 类给。 */
const statusOf: Array<[string, WorkItemStatusKey]> = [
  ["wi-todo", "todo"],
  ["wi-doing", "in_progress"],
  ["wi-done", "done"],
  ["wi-closed", "cancelled"],
];
const categoryItems: WorkItem[] = statusOf.map(([id, status]) =>
  wi({ id, status, title: `标题 ${id}`, priority: "high", identifierSeq: 3, labels: ["甲"] }),
);

function snapshotWith(workItems: WorkItem[]): SquadSnapshot {
  return { enabled: true, teamAgents: [], squads: [], workItems, runs: [], queuedRuns: [] };
}

/** 渲染看板（默认维度 = statusCategory；宿主接线与真机同一份）。 */
function renderBoard(input: {
  workItems: WorkItem[];
  laneDimension?: WorkItemLaneDimension;
  surface?: WorkItemSurfaceState;
  withWriter?: boolean;
}): string {
  const { workItems, laneDimension = "statusCategory", surface, withWriter = false } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot: snapshotWith(workItems),
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension,
        surface: surface ?? workItemSurfaceDefaultState(),
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(withWriter ? { onQuickCreate: async () => null } : {}),
      }),
    }),
  );
}

/** 锚点所在的**开标签**（`<… data-testid="x" …>`）：断言落在元素本身，不落在别处的同名类。 */
function tagOf(markup: string, anchor: string): string {
  const at = markup.indexOf(anchor);
  assert.ok(at >= 0, `渲染结果必须含锚点 ${anchor}`);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

function tagsOf(markup: string, anchor: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const at = markup.indexOf(anchor, from);
    if (at < 0) return tags;
    tags.push(markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1));
    from = at + anchor.length;
  }
}

/** 锚点所在**元素**（`<li …anchor…>…</li>`）：字段/带的断言落在这一条里，不串到邻居。 */
function elementOf(markup: string, anchor: string): string {
  const at = markup.indexOf(anchor);
  assert.ok(at >= 0, `渲染结果必须含锚点 ${anchor}`);
  return markup.slice(markup.lastIndexOf("<li", at), markup.indexOf("</li>", at));
}

// ---------- ① 轴换向：纵堆泳道 → 横排固定 280px 列 + 横滚 ----------

/* 形态真源（spec §10-A1）：`board-view.tsx` 的容器是 `flex flex-1 min-h-0 gap-4 overflow-x-auto p-2`，
   每列 `flex shrink-0 flex-col rounded-xl p-2` + 内联 `width: 280px`。
   变异：把容器改回 `flex flex-col gap-3`（纵堆泳道）⇒ 第一、二条必红。 */
test("形态｜轴换向：分组容器是横排 + 横滚，每列固定 280px（不再是纵堆泳道）", () => {
  const markup = renderBoard({ workItems: categoryItems });
  const container = tagOf(markup, 'data-testid="work-items-lanes"');
  assert.ok(container.includes("overflow-x-auto"), "分组容器横向滚动（列排不下就滚，不是换行）");
  assert.ok(container.includes("gap-4"), "列间距 16px（spec 几何）");
  assert.ok(container.includes("p-2"), "容器内边距 8px（spec 几何）");
  assert.ok(!container.includes("flex-col"), "容器不得再是纵堆（轴换向：列沿横轴排）");

  const columns = tagsOf(markup, 'data-testid="work-items-lane"');
  assert.equal(columns.length, 4, "statusCategory 固定 4 列（含空列）");
  for (const column of columns) {
    assert.ok(column.includes("width:280px"), `列宽固定 280px（spec 常量）：${column}`);
    assert.ok(column.includes("shrink-0"), "列不压缩（横滚而非挤压）");
    assert.ok(column.includes("flex-col"), "列内沿纵轴排");
    assert.ok(column.includes("rounded-xl"), "列是圆角容器（12px）");
    assert.ok(column.includes("p-2"), "列内边距 8px");
  }
});

/* 列体（spec §2「列头不滚、列体滚」+ §10-A2 高度链）：卡片区自己纵向滚 ——
   `min-h-[200px]`（列体最小高）+ `overflow-y-auto` + `p-1`（4px）+ 卡片间距 `gap-2`（8px）。
   变异：摘掉 `overflow-y-auto`（列内不自滚）或 `min-h-[200px]`（空列塌成一条）⇒ 本用例必红。 */
test("形态｜列体：卡片区独立纵向滚（min-h 200px + overflow-y-auto + p-1 + 卡片间距 8px）", () => {
  const markup = renderBoard({ workItems: categoryItems });
  const lanes = markup.split('data-testid="work-items-lane"').slice(1);
  assert.equal(lanes.length, 4);
  const [first] = lanes;
  assert.ok(first !== undefined);
  const body = first.slice(0, first.indexOf("</ul>"));
  assert.ok(body.includes("overflow-y-auto"), "列体独立纵向滚（列头不滚）");
  assert.ok(body.includes("min-h-[200px]"), "列体最小高 200px（空列也撑出容器形）");
  assert.ok(body.includes("p-1"), "列体内边距 4px（spec 几何）");
  assert.ok(body.includes("gap-2"), "卡片间距 8px（spec 几何）");
});

test("形态｜「不分组」仍是平铺（不是列容器）：既有单 ul 锚点保留", () => {
  const markup = renderBoard({ workItems: categoryItems, laneDimension: "none" });
  assert.ok(markup.includes('data-testid="work-items-list"'), "不分组 = 平铺列表（既有锚点）");
  assert.ok(!markup.includes('data-testid="work-items-lanes"'), "不分组不出现列壳");
});

// ---------- ② 列头：从「纯标签」升成可操作面（图标 + 粗名 + 计数 + 右侧新建） ----------

/* 形态真源（spec §2 列头 / §10-A4）：左「小图标 + 加粗名称 + 计数」，右「列级动作」。
   ZPaPa 的列级动作本轮只做**新建**（隐藏列面板在 spec §10-B，可后置）：它是 multica 列头 `+`
   的对应物，落到**唯一**写路径上 —— 存在快速创建条时才给（没有写入口 ⇒ 连入口都不渲染）。
   变异：摘掉图标/加粗/计数 ⇒ 第一条必红；没有写路径也给「+」⇒ 第二条必红。 */
test("形态｜列头：状态图标 + 加粗名称 + 计数在左，新建入口（+）在右", () => {
  const markup = renderBoard({ workItems: categoryItems, withWriter: true });
  const lanes = markup.split('data-testid="work-items-lane"').slice(1);
  assert.equal(lanes.length, 4);
  const [first] = lanes;
  assert.ok(first !== undefined);
  const head = first.slice(0, first.indexOf("<ul"));
  const headTag = tagOf(head, 'data-testid="work-items-lane-header"');
  assert.ok(headTag.includes("justify-between"), "列头左右两端（名称 ←→ 动作）");
  assert.ok(headTag.includes("mb-2"), "列头与列体之间留 8px（spec §2 的 mb-2 px-1.5）");
  assert.ok(head.includes("<svg"), "列头有状态图标（类别字形，不是纯文字）");
  assert.ok(head.includes("font-semibold"), "列名加粗（spec §2 的 12px/600）");

  const countTag = tagOf(head, 'data-testid="work-items-lane-count"');
  assert.ok(countTag.includes("bg-surface"), "计数是中性底色胶囊（§10-A4：统一成胶囊）");
  assert.ok(head.includes("1 项"), "计数文案走既有键（未开始列 1 项）");

  const createTag = tagOf(head, 'data-testid="work-items-lane-create"');
  assert.ok(createTag.includes('aria-label="新建工作项"'), "新建钮的可及名称走既有键（零键增）");
  assert.ok(createTag.includes("<svg") || createTag.includes("svg"), "新建钮是 `+` 图标钮");
});

test("形态｜列头新建入口：没有写路径就不给入口（与快速创建条同款纪律）", () => {
  const markup = renderBoard({ workItems: categoryItems });
  assert.ok(
    !markup.includes('data-testid="work-items-lane-create"'),
    "没有 onQuickCreate ⇒ 列头不出现「+」（点得动但写不下去的入口比没有更糟）",
  );
});

// ---------- ③ 卡片化：条目形态从表格行换成卡片（行契约三锚点不丢） ----------

/* 形态真源（spec §3/§10-A3）：条目是**卡片** —— `rounded-lg`(8px) + **0.5px** 发丝边 +
   卡片面（`bg-card`）+ 内边距 `py-3 px-2.5`；标题 2 行截断（`line-clamp-2`）。
   行契约三锚点（`data-work-item-id` / `registerRow` / `useId` 槽位纪律）不丢：卡片仍是**同一个
   `<li>`**（锚点与注册在行模块各恰一处），改的只是行内槽位内容 —— 见下方「三锚点」用例。
   变异：把卡片改回行形态（摘掉 `bg-card`/`border-[0.5px]`）或摘掉标题截断 ⇒ 本用例必红。 */
test("形态｜卡片化：看板分组列的条目是卡片（圆角 8px / 0.5px 边 / 卡片面 / py-3 px-2.5 / 标题 2 行截断）", () => {
  const markup = renderBoard({ workItems: categoryItems });
  for (const [id] of statusOf) {
    const card = elementOf(markup, `data-work-item-id="${id}"`);
    const tag = card.slice(0, card.indexOf(">") + 1);
    for (const token of [
      "rounded-lg",
      "border-[0.5px]",
      "bg-card",
      "py-3",
      "px-2.5",
      "shadow-sm",
      "min-h-11",
    ]) {
      assert.ok(tag.includes(token), `卡片面必须给 ${token}：${tag}`);
    }
    assert.ok(!tag.includes("border-b border-border"), "卡片不是「细分隔线行」（那是列表形态）");
    assert.ok(card.includes("line-clamp-2"), "标题最多 2 行（spec §3 的 line-clamp-2）");
  }
});

/* 卡片化**不得丢字段/入口**（形态换了，能力不换）：编号、优先级 picker、标题编辑入口、
   状态、标签、指派、动作簇（编辑/改派/放弃）在卡片里全部可达。
   变异：卡片只画标题（把其它字段省掉）⇒ 本用例必红。 */
test("形态｜卡片不丢字段与入口：编号 / 优先级 / 标题编辑 / 状态 / 标签 / 指派 / 动作簇都在卡内", () => {
  const markup = renderBoard({ workItems: categoryItems });
  const card = elementOf(markup, 'data-work-item-id="wi-todo"');
  for (const [anchor, why] of [
    ["#3", "编号（identifier）"],
    ['data-testid="work-item-priority-picker"', "优先级入口"],
    ['data-testid="work-item-title-edit"', "标题行内编辑入口"],
    ["待处理", "状态文案（todo 档，与列头类别名「未开始」不是同一个词）"],
    ['data-testid="work-item-label"', "标签 chip"],
    [">我<", "指派（`user` 档的本地化文案）"],
    ['data-testid="work-item-edit"', "编辑钮"],
    ['data-testid="work-item-reassign"', "改派钮"],
    ['data-testid="work-item-row-open-detail"', "整卡「打开详情」覆盖按钮"],
  ] as const) {
    assert.ok(card.includes(anchor), `卡片必须保留${why}`);
  }
});

/* 三锚点（承重）：`data-work-item-id` 每条**恰一个**（卡片是同一个 `<li>`，不是新槽位），
   列表视图的行形态**不跟着卡化**（它保持高密度行 —— list/table 不是看板）。
   变异：卡片另起一份行渲染（多一个锚点）⇒ 第一条必红；把列表视图也卡化 ⇒ 第二条必红。 */
test("形态｜三锚点不丢 + 列表视图不卡化：每条锚点恰一个，list 行仍是高密度行", () => {
  const markup = renderBoard({ workItems: categoryItems });
  assert.equal(
    (markup.match(/data-work-item-id=/g) ?? []).length,
    categoryItems.length,
    "每条工作项恰一个行锚点（卡片复用同一个 li，不是第二份行渲染）",
  );

  const list = renderBoard({
    workItems: categoryItems,
    surface: { ...workItemSurfaceDefaultState(), view: "list" },
  });
  const listRow = elementOf(list, 'data-work-item-id="wi-todo"');
  const listTag = listRow.slice(0, listRow.indexOf(">") + 1);
  assert.ok(listTag.includes("border-b border-border"), "list 视图仍是细分隔线行");
  assert.ok(!listTag.includes("bg-card"), "list 视图不得被卡化（不是看板形态）");
  assert.ok(!listTag.includes("border-[0.5px]"), "list 视图不套卡片发丝边");
});

// ---------- ④ 列底色：只编码**状态类别**（用户 2026-10-09 裁定准入） ----------

test("形态｜列底色按状态类别：未开始/已关闭中性，进行中 warning 5%，已完成 success 5%", () => {
  const markup = renderBoard({ workItems: categoryItems });
  const columnClassOf = (key: string): string => {
    const at = markup.indexOf(`data-lane-key="${key}"`);
    assert.ok(at >= 0, `渲染结果必须含列 ${key}`);
    return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
  };
  for (const [key, columnClass] of [
    ["unstarted", "bg-surface"],
    ["started", "bg-warning/5"],
    ["done", "bg-success/5"],
    ["closed", "bg-surface"],
  ] as const) {
    assert.ok(
      columnClassOf(key).includes(columnClass),
      `列 ${key} 的底色必须是 ${columnClass}（编码状态类别）`,
    );
  }
  assert.notEqual(
    columnClassOf("started"),
    columnClassOf("unstarted"),
    "进行中与未开始的列底色必须可区分（底色是状态类别的编码）",
  );
  assert.notEqual(columnClassOf("done"), columnClassOf("unstarted"), "已完成列底色与未开始不同");

  /* 裁定同时要求**优先级/标签保持中性**（不照搬 multica 的优先级语义色）：卡片上的优先级
     入口仍是中性 chip（`border-border` + `foreground-subtle`），不得借 warning/destructive。 */
  const card = elementOf(markup, 'data-work-item-id="wi-doing"');
  const priorityTag = tagOf(card, 'data-testid="work-item-priority"');
  assert.ok(priorityTag.includes("border-border"), "优先级 chip 保持中性边框");
  for (const borrowed of ["text-warning", "text-destructive", "text-success", "bg-warning"]) {
    assert.ok(!priorityTag.includes(borrowed), `优先级不得借语义色（${borrowed}）`);
  }
});

// ---------- ⑤ 容器宽度：工作项面放宽居中窄栏（只动 squad 域的那一个分支） ----------

/* 裁定（登记在实现报告）：`max-w-4xl`(896px) 只装得下 2–3 列 → **工作项面**改为全宽/近全宽
   （board 形态的结构前提，spec §10-A2/§11 的「唯一硬结构冲突」）。**只动这一个分支** ——
   插件市场 / 收件箱 / 智能体 / 小队 / 工作项详情的居中窄栏逐字保留（工具/阅读面仍是窄栏）。
   变异：把工作项面改回 `max-w-4xl` ⇒ 第一条必红；顺手把别的页也放宽 ⇒ 第二条必红。 */
test("形态｜工作项面容器放宽 max-w-4xl（其余页的居中窄栏逐字不动）", () => {
  const shell = stripComments(readSource("app-shell/WorkspaceShellLayout.tsx"));
  const branchOf = (marker: string): string => {
    const at = shell.indexOf(marker);
    assert.ok(at >= 0, `shell 必须有 ${marker} 分支`);
    return shell.slice(at, shell.indexOf("</AutomationsMainBreadcrumbFrame>", at));
  };
  const workItems = branchOf('workspaceMainView === "work-items" ?');
  assert.ok(workItems.includes("w-full"), "工作项面容器必须撑满可用宽度（w-full）");
  assert.ok(
    !workItems.includes("max-w-4xl") && !workItems.includes("mx-auto"),
    "工作项面不得再套居中窄栏（896px 放不下 280px 列）",
  );
  for (const marker of [
    'workspaceMainView === "plugin-store" ?',
    'workspaceMainView === "inbox" ?',
    'workspaceMainView === "agents" ?',
    'workspaceMainView === "squads" ?',
    'workspaceMainView === "work-item-detail" ?',
  ]) {
    assert.ok(
      branchOf(marker).includes("max-w-4xl"),
      `${marker} 的居中窄栏不得跟着放宽（本轮只动工作项面）`,
    );
  }
});

// ---------- ⑥ 拖拽不回归：轴换向只换「列的排布」，落点入参与 dnd 配置不变 ----------

/* 轴换向后必须核对的四件事（任务书「拖拽不回归」）：
   ① 落点入参形状 = 「每列一个行数组（`{id, position}`）」—— 外层次序只是视觉，`workItemBoardDrop`
      只按 id 找列（纯函数用例在 `workItemPosition.test.ts`，本层钉**形状没变**）；
   ② 列内仍是**纵向**排序策略（横排的是列本身，不是列内的行）；
   ③ 碰撞检测与传感器不变（`closestCenter`；指针 4px 起拖阈值仍由行模块的把手给）；
   ④ 四格判据（看板 + statusCategory + 手动档 + 有写入口 ⇒ 给把手）由 `workItemViewsRender.test.ts`
      的真实渲染兜底，重排后仍逐格成立。
   变异：把 SortableContext 摘掉（或改成横向策略）⇒ 第一条必红。 */
test("形态｜轴换向后 dnd 配置与落点入参形状不变（列内仍纵拖，落点仍按列找行）", () => {
  const board = stripComments(readSource("squad/WorkItemsBoard.tsx"));
  assert.ok(board.includes("lanes.map((boardLane) =>"), "落点入参仍是「列 → 行数组」的映射");
  assert.ok(
    board.includes("({ id: row.item.id, position: row.item.position })"),
    "每行带 id + position（落点值仍由纯函数算，本层不写库）",
  );
  assert.ok(board.includes("<DndContext"), "拖拽上下文仍在（启用时才有，未启用零 DOM 变化）");
  assert.ok(board.includes("<SortableContext"), "每列仍包一层可排序上下文");
  assert.ok(board.includes("verticalListSortingStrategy"), "列内仍是纵向排序策略");
  assert.ok(board.includes("closestCenter"), "碰撞检测不变");
});
