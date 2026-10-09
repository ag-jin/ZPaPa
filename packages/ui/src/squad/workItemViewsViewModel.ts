import type {
  WorkItemViewRecord,
  WorkItemViewScopeType,
  WorkItemViewVisibility,
} from "@zcode/services";
import { WORK_ITEM_VIEW_NAME_MAX_LENGTH } from "@zcode/services";
import {
  WORK_ITEM_COLUMN_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_VALUES,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SORT_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_MESSAGE_IDS,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_VALUES,
  WORK_ITEM_SORT_DIRECTIONS,
  WORK_ITEM_SORT_KEYS,
  WORK_ITEM_SURFACE_COLUMNS,
  WORK_ITEM_VIEW_MODES,
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  workItemSurfaceSearchText,
  type WorkItemPriorityFilterValue,
  type WorkItemSortDirection,
  type WorkItemSortKey,
  type WorkItemStatusFilterValue,
  type WorkItemSurfaceColumnKey,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
  type WorkItemViewMode,
} from "./workItemSurfaceViewModel.js";
import {
  WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS,
  type WorkItemLaneDimension,
} from "./workItemsViewModel.js";

/* 工作项**保存视图**（阶段二 · T-P2-R6b）的纯判据：定义形状 / 首开 seed / baseline / 权限投影。

   为什么必须是纯函数层（与 `workItemSurfaceViewModel` / `workItemSurfaceControlsViewModel` 同一理由）：
   本包没有渲染测试设施，判据写进组件就等于不可测；而保存视图这一面的坏法全是**静默**的 ——
   首开 seed 漏一格（切到视图后列配置/排序还留着上一个视图的值）、本地调整**回写**了定义
   （用户"只是筛了一下"，下次打开却发现视图变成了筛过的那份）、无权视图在条上照样可编辑、
   视图消失后仍停在默认标签上（界面显示一个不存在的视图）。

   形态全部照 multica 先例（`issue_view.go` + `view-baseline-context` + `surface-view-store`，
   证据 reports/2026-10-09-saved-views-multica-evidence.md §1/§3/§5/§8）：

   · **服务端不解释 query/display**（R6a 只校验「是 JSON object」）⇒ 文档的键集与闭集由**本文件**
     单点定义：facet 集 = R1 已有的两维（status / priority），display 子集 = viewMode / grouping /
     sortBy / sortDirection / hiddenColumns。加 facet 只动这里，不动服务端。
   · **搜索词不存**（multica `view-store.ts:267-272` 刻意排除 free-text）⇒ 定义里没有它，
     首开 seed 把它回空（见 `workItemViewSeed` 的注释）。
   · **定义是「首次打开的种子」，不是同步源**（multica `surface-view-store.ts:204-225`）：
     首开灌入、此后本地调整**不回写**；回写只经「保存 / 另存为 / 编辑」三个显式动作（带 revision）。
   · **未知枚举成员丢弃**（multica `baseline.ts:7-31` 的 sanitize 口径）：闭集外的值回落默认，
     不静默交给状态 —— 界面按一个自己不认识的值渲染等于一份没人能解释的状态。

   本文件不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**消息 id**）。 */

/* ---------------- 定义文档（服务端 opaque JSON 的**客户端契约**） ---------------- */

/** 定义的客户端契约版本（multica 客户端恒写 1；服务端只存不解释）。 */
export const WORK_ITEM_VIEW_DEFINITION_VERSION = 1;

/** query 文档的键（**闭集**）：每枚对应 R1 的一个 facet；`all` / 空 = 该维不约束。 */
export const WORK_ITEM_VIEW_QUERY_KEYS = [
  "statusCategory",
  "priority",
  /* R-P2（项目绑定 · UI 轮）加的两枚：项目维是「多选 id 数组 + 独立『无项目』开关」两面
     （与 surface 的过滤状态同形）—— 不写进定义的话，用户存下的项目筛选会在下次打开时**静默消失**。 */
  "projectIds",
  "includeNoProject",
] as const;

/** display 文档的键（**闭集**）：布局 / 分组 / 排序 / 列配置（搜索词有意不在其中）。 */
export const WORK_ITEM_VIEW_DISPLAY_KEYS = [
  "viewMode",
  "grouping",
  "sortBy",
  "sortDirection",
  "hiddenColumns",
] as const;

export type WorkItemViewQueryDocument = {
  statusCategory: WorkItemStatusFilterValue;
  priority: WorkItemPriorityFilterValue;
  /** 项目维（R-P2）：勾选的项目 id（次序 = 勾选次序；空 = 这一维不筛）。 */
  projectIds: string[];
  /** 项目维（R-P2）：「无项目」独立开关（不是一个项目，故不是 ids 里的一枚）。 */
  includeNoProject: boolean;
};

export type WorkItemViewDisplayDocument = {
  viewMode: WorkItemViewMode;
  grouping: WorkItemLaneDimension;
  sortBy: WorkItemSortKey;
  sortDirection: WorkItemSortDirection;
  hiddenColumns: WorkItemSurfaceColumnKey[];
};

/** 当前 surface 状态 ⇒ query 文档（**保存 / 另存为 / 编辑**三个显式动作的输入）。 */
export function workItemViewQueryFromSurface(
  surface: WorkItemSurfaceState,
): WorkItemViewQueryDocument {
  return {
    statusCategory: surface.filter.statusCategory,
    priority: surface.filter.priority,
    projectIds: [...surface.filter.projectIds],
    includeNoProject: surface.filter.includeNoProject,
  };
}

/** 当前 surface 状态 + 分组维度 ⇒ display 文档。 */
export function workItemViewDisplayFromSurface(input: {
  surface: WorkItemSurfaceState;
  laneDimension: WorkItemLaneDimension;
}): WorkItemViewDisplayDocument {
  return {
    viewMode: input.surface.view,
    grouping: input.laneDimension,
    sortBy: input.surface.sort.key,
    sortDirection: input.surface.sort.direction,
    hiddenColumns: [...input.surface.columns.hidden],
  };
}

/** 闭集成员判定（未知 ⇒ 默认值）。三处 sanitize 共用一份口径。 */
function closedValue<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 读回的一份文档里某个键（非 object / 数组 ⇒ 一律当缺项，按默认值处理）。 */
function readDocumentKey(document: unknown, key: string): unknown {
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return undefined;
  return (document as Record<string, unknown>)[key];
}

/** query 文档 ⇒ facet 取值（闭集外的值丢弃，按 `all` 处理）。 */
export function sanitizeWorkItemViewQuery(raw: unknown): WorkItemViewQueryDocument {
  return {
    statusCategory: closedValue(
      readDocumentKey(raw, "statusCategory"),
      WORK_ITEM_STATUS_FILTER_VALUES,
      "all",
    ),
    priority: closedValue(
      readDocumentKey(raw, "priority"),
      WORK_ITEM_PRIORITY_FILTER_VALUES,
      "all",
    ),
    projectIds: sanitizeProjectIds(readDocumentKey(raw, "projectIds")),
    /* 「无项目」只认显式 `true`（其余形态一律按「没开」—— 闭集外的值不静默交给状态）。 */
    includeNoProject: readDocumentKey(raw, "includeNoProject") === true,
  };
}

/** 项目 id 列表的**清洗**：只留非空字符串（去重、保持文档给出的次序）。
 *  为什么不去项目清单里对账：本层是纯函数，拿不到清单；而清单里没有的 id 是**服务面**的判据
 *  （跨版本残留的挂接仍应能被这个视图筛出来，静默丢掉会让「这个视图少了几条」无从解释）。 */
function sanitizeProjectIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

/** display 文档 ⇒ 显示取值（闭集外的值丢弃；列配置**逐枚**过闭集，不是整份丢掉）。 */
export function sanitizeWorkItemViewDisplay(raw: unknown): WorkItemViewDisplayDocument {
  const hiddenRaw = readDocumentKey(raw, "hiddenColumns");
  return {
    viewMode: closedValue(readDocumentKey(raw, "viewMode"), WORK_ITEM_VIEW_MODES, "board"),
    /* 分组维度的回落值 = **页面默认**（2026-10-09 用户裁定「默认按阶段进行分组」）：定义缺项 /
       闭集外值 ⇒ 灌出来的界面与默认界面同形（空定义不得变出一份「默认界面之外的界面」）。
       旧视图**显式存的** `none` 仍原样还原 —— 那是用户存下的取值，不是缺项。
       ⚠️ 这一枚与 `WorkItemsPage` 的 useState 默认必须同改：页面在 `max-lines = 400` 的硬线上
       （再进一个常量 import 就超线），故这里以字面量与它同一口径，不共用一个常量。 */
    grouping: closedValue(
      readDocumentKey(raw, "grouping"),
      ["none", "statusCategory", "assignee", "project"] as const,
      "statusCategory",
    ),
    sortBy: closedValue(readDocumentKey(raw, "sortBy"), WORK_ITEM_SORT_KEYS, "manual"),
    sortDirection: closedValue(
      readDocumentKey(raw, "sortDirection"),
      WORK_ITEM_SORT_DIRECTIONS,
      "asc",
    ),
    hiddenColumns: dedupeKnownColumns(hiddenRaw),
  };
}

/** 列配置的闭集过滤：认识的留下（去重、保持文档给出的次序），不认识的丢掉。 */
function dedupeKnownColumns(raw: unknown): WorkItemSurfaceColumnKey[] {
  if (!Array.isArray(raw)) return [];
  const columns: WorkItemSurfaceColumnKey[] = [];
  for (const entry of raw) {
    if (!WORK_ITEM_SURFACE_COLUMNS.includes(entry as WorkItemSurfaceColumnKey)) continue;
    const column = entry as WorkItemSurfaceColumnKey;
    if (!columns.includes(column)) columns.push(column);
  }
  return columns;
}

/* ---------------- 首开 seed（打开视图 = 把定义灌进 surface 状态） ---------------- */

/**
 * **首开 seed**：把视图定义灌进 surface 状态（+ 分组维度），返回**新对象**。
 *
 * 三条与 multica 同款的语义（证据 §3「视图定义是首次打开种子，不是同步源」）：
 * ① **逐格**：定义里有的按定义、没有的按默认（`workItemSurfaceDefaultState`），
 *    缺项**不留**上一个视图的值 —— 那正是"切换视图后列配置还是旧的"这种静默坏法；
 * ② **搜索词回空**：搜索词不存定义（§5）⇒ 打开视图就是一次全新的种子，不带着上一视图的查询；
 * ③ **不回写**：本函数只产出状态；定义的回写只经「保存 / 另存为 / 编辑」三个显式动作。
 */
export function workItemViewSeed(view: WorkItemViewRecord): {
  surface: WorkItemSurfaceState;
  laneDimension: WorkItemLaneDimension;
} {
  const query = sanitizeWorkItemViewQuery(view.query);
  const display = sanitizeWorkItemViewDisplay(view.display);
  const defaults = workItemSurfaceDefaultState();
  return {
    surface: {
      view: display.viewMode,
      search: defaults.search,
      filter: {
        statusCategory: query.statusCategory,
        priority: query.priority,
        projectIds: [...query.projectIds],
        includeNoProject: query.includeNoProject,
      },
      sort: { key: display.sortBy, direction: display.sortDirection },
      columns: { hidden: display.hiddenColumns },
    },
    laneDimension: display.grouping,
  };
}

/* ---------------- baseline（视图基准态：清空筛选回到视图条件 + 固定值锁定 + 增量判定） ---------------- */

/**
 * 视图的**基准态**（multica 的 `baselineFromQuery`，证据 §3）：
 * · `filter` = 视图自己的条件（"清空筛选"回到它，不是回到全空）；
 * · `locked` = 视图**真的约束了**哪几维（固定值 ⇒ 界面勾选且禁用；`all` = 不约束，不算固定）。
 */
export type WorkItemViewBaseline = {
  filter: WorkItemViewQueryDocument;
  locked: { statusCategory: boolean; priority: boolean; project: boolean };
};

export function workItemViewBaseline(view: WorkItemViewRecord): WorkItemViewBaseline {
  const filter = sanitizeWorkItemViewQuery(view.query);
  return {
    filter,
    locked: {
      statusCategory: filter.statusCategory !== "all",
      priority: filter.priority !== "all",
      /* 项目维「固定了」= 勾了至少一个项目，或打开了「无项目」开关（空数组 + 关着 = 不约束）。 */
      project: filter.projectIds.length > 0 || filter.includeNoProject,
    },
  };
}

/**
 * 意图折叠 + 视图语义（**唯一**一处消费 baseline）：只改 `clearQuery` 那一格 —— 有视图打开时
 * "清空筛选"回到视图条件（multica `filter-chips-bar.tsx:580-589` 的"全清回 baseline"同款），
 * 没有视图（`baseline === null`）时逐格走 R1 的原折叠。
 *
 * 为什么不让 clearQuery 直通 R1：全清回 `all` 等于"把视图的条件也清掉了"——用户点的是
 * "去掉我刚加的筛选"，结果视图本身的条件（例如"只看进行中"）也一起没了，而这个视图的**定义**
 * 并没有变 ⇒ 界面显示的与视图定义说的不是一回事。
 */
export function applyWorkItemSurfaceIntentWithBaseline(
  state: WorkItemSurfaceState,
  intent: WorkItemSurfaceIntent,
  baseline: WorkItemViewBaseline | null,
): WorkItemSurfaceState {
  if (baseline === null || intent.kind !== "clearQuery") {
    return applyWorkItemSurfaceIntent(state, intent);
  }
  /* 基线条件是**文档**（可能来自某条视图的内存副本）：复制一层再落状态 —— 状态是可变引用，
     共享同一份数组迟早被某处就地改到（与 `workItemViewSeed` 同一条纪律）。 */
  return {
    ...state,
    search: "",
    filter: { ...baseline.filter, projectIds: [...baseline.filter.projectIds] },
  };
}

/**
 * 当前状态相对视图基准态**有没有增量**（= 用户叠加上去的部分）。
 *
 * 「清除筛选」的可点性、以及（multica 的）chips 条只显增量都问它：视图固定值**不是**增量
 * —— 打开一个视图就算"有查询"，会让"清除筛选"永远亮着，而用户点它什么也不会变。
 */
export function workItemViewHasIncrement(
  state: WorkItemSurfaceState,
  baseline: WorkItemViewBaseline,
): boolean {
  if (workItemSurfaceSearchText(state.search).length > 0) return true;
  return (
    state.filter.statusCategory !== baseline.filter.statusCategory ||
    state.filter.priority !== baseline.filter.priority ||
    state.filter.includeNoProject !== baseline.filter.includeNoProject ||
    /* 项目多选按**集合**比较：勾选次序不是条件（先勾 A 后勾 B 与反过来的筛选结果一样）。 */
    !sameProjectIdSet(state.filter.projectIds, baseline.filter.projectIds)
  );
}

/** 项目 id 集合相等（去重、忽略次序）—— 「有增量吗」的唯一判据之一。 */
function sameProjectIdSet(left: readonly string[], right: readonly string[]): boolean {
  const unique = (ids: readonly string[]) => [...new Set(ids)];
  const a = unique(left);
  const b = unique(right);
  return a.length === b.length && a.every((id) => b.includes(id));
}

/* ---------------- 视图条投影（内建锚 + 保存视图同列 + 权限） ---------------- */

/** 内建锚的标签 id（**永不可隐藏、不可删**：默认落地态就是它 —— multica `view-bar.tsx:232`）。 */
export const WORK_ITEM_VIEW_ANCHOR_ID = "builtin:all";

/** 内建锚的文案：复用既有的「全部」（零键增 —— 破例名单里没有锚点这一枚，重复语义不新造词）。 */
export const WORK_ITEM_VIEW_ANCHOR_MESSAGE_ID = "squad.workItems.filter.all";

/** 视图条上的一个标签（内建锚与保存视图**同一列扁平列表**，照 multica `view-bar.tsx:169-176`）。 */
export type WorkItemViewTab = {
  id: string;
  /** 显示名：内建锚没有名字（`""`）；保存视图的名字是用户输入的数据（不是文案键）。 */
  name: string;
  /** 内建锚的文案 id（保存视图为 `null` —— 用户数据不走 i18n）。 */
  nameId: string | null;
  builtin: boolean;
  /** 归属（管理权的**唯一**判据）：取**读面带回的** `ownedByViewer`；读面没带 ⇒ `unknown`
      （不可判定 —— 界面不假装"不是我的"：UI 没有身份链，D1-A 不许自造）。 */
  ownership: WorkItemViewOwnership;
};

/** 归属三态（闭集）：我的 / 别人的 / 不可判定（读面没带回 `ownedByViewer`）。 */
export type WorkItemViewOwnership = "mine" | "other" | "unknown";

/**
 * 归属判定（**唯一**输入 = 读面带回的 `ownedByViewer`）。
 *
 * 判据为什么要从"UI 侧拿身份比 (kind, id)"改成"读面的投影"：UI **没有**身份链 ——
 * R6b 期间只能给 `owner: null`（占位），结果是每一行都落进"不可判定"，别人的共享视图也渲染出
 * 可点的编辑/删除（点下去才 forbidden，T-P2-V §9-2 实测）。服务面的列表读面按注入身份把
 * `(kind, id)` 两列比好、逐行带回真值（`workItemViewRepo.listVisible`），本层只消费它。
 */
export function workItemViewOwnership(view: WorkItemViewRecord): WorkItemViewOwnership {
  if (view.ownedByViewer === undefined) return "unknown";
  return view.ownedByViewer ? "mine" : "other";
}

/** 标签列表：内建锚恒第一枚，保存视图按 repo 给的次序（created_at ASC, id ASC）。 */
export function workItemViewTabs(input: {
  views: readonly WorkItemViewRecord[];
}): WorkItemViewTab[] {
  return [
    {
      id: WORK_ITEM_VIEW_ANCHOR_ID,
      name: "",
      nameId: WORK_ITEM_VIEW_ANCHOR_MESSAGE_ID,
      builtin: true,
      ownership: "unknown",
    },
    ...input.views.map((view) => ({
      id: view.id,
      name: view.name,
      nameId: null,
      builtin: false,
      ownership: workItemViewOwnership(view),
    })),
  ];
}

/**
 * 标签能做什么（**一处判据**：条上的菜单与管理对话框都问它 —— 两处各判一遍迟早分叉）。
 *
 * 三态：`true` = 我的（编辑/删除都给）、`false` = 别人的（编辑**禁用**、删除**不渲染**
 * —— multica `view-bar.tsx:398-416` 同款）、`null` = **不可判定**（身份缺席）⇒ 界面按
 * 「服务面是权威」渲染，服务面拒绝时把 `forbidden` 翻成可见提示（不自造身份，D1-A 纪律）。
 */
export function workItemViewTabActions(tab: WorkItemViewTab): { canManage: boolean | null } {
  if (tab.builtin) return { canManage: false };
  if (tab.ownership === "mine") return { canManage: true };
  if (tab.ownership === "other") return { canManage: false };
  return { canManage: null };
}

/**
 * 列表回读后的**打开态收敛**：当前打开的视图不在列表里（被删 / 无权 —— list 已在 SQL 层过滤）
 * ⇒ 退回内建锚并报 `missing`（调用方提示一次）。
 *
 * 为什么"打开态"是**页面内存态**（不写进任何存储）：恢复了已删视图的 id 会把用户困在
 * "打开着一个不存在的视图"上（multica `active-view-store.ts:7-17` 的同一条理由）。
 */
export function workItemViewListAfterLoad(input: {
  views: WorkItemViewRecord[];
  activeViewId: string | null;
}): { views: WorkItemViewRecord[]; activeViewId: string | null; missing: boolean } {
  const { views, activeViewId } = input;
  if (activeViewId === null) return { views, activeViewId: null, missing: false };
  if (views.some((view) => view.id === activeViewId))
    return { views, activeViewId, missing: false };
  return { views, activeViewId: null, missing: true };
}

/* ---------------- 手动顺序（Manual）的分组维度可用性 ---------------- */

/**
 * 该分组维度下**可选**的排序档：按指派 / 按项目分组不给 `manual`。
 *
 * 为什么（证据 §6 的形态）：`position` 是**全库一段**的序（不是每视图/每泳道一份快照），
 * 拖拽改序的落点只在「列内」语义下成立 —— statusCategory 分组下"列"= 状态列；
 * 按指派/按项目分组时"列"是同一个位置序的另一段，改它对"这个指派对象 / 这个人项目内部的次序"
 * 没有意义（拖拽本身也只在 statusCategory 开放，见 `workItemBoardReorderEnabled`）。
 */
export function workItemSortKeysForLaneDimension(
  dimension: WorkItemLaneDimension,
): readonly WorkItemSortKey[] {
  if (dimension === "assignee" || dimension === "project") {
    return WORK_ITEM_SORT_KEYS.filter((key) => key !== "manual");
  }
  return WORK_ITEM_SORT_KEYS;
}

/**
 * 手动档不可用时的**回落档**：清单里语义最近的时间档（新的在前）。
 *
 * multica 的回落是 `created_at desc`（`view-store.ts:229-237`）；ZPaPa 的领域对象没有
 * created_at 排序键（R1 冻结的闭集里没有它）⇒ 取 `startDate desc`：同为「新的在前」，
 * 且未设置的项按 R1 的口径恒排最后（回落不会把没定过日期的行提到前面）。
 */
export const WORK_ITEM_SORT_FALLBACK_NO_MANUAL = {
  key: "startDate",
  direction: "desc",
} as const satisfies { key: WorkItemSortKey; direction: WorkItemSortDirection };

/**
 * 分组维度变化时的状态**归一**（hydrate）：当前档位在新维度下不可用 ⇒ 换回落档。
 *
 * 为什么必须归：控件里列不出 `manual` 时仍把 `manual` 留在状态里，下拉会显示一个它自己
 * 没有的选项（读屏念出来的是一个用户选不到的档位），而排序结果也仍是"手动次序"。
 */
export function normalizeWorkItemSurfaceForLaneDimension(
  state: WorkItemSurfaceState,
  dimension: WorkItemLaneDimension,
): WorkItemSurfaceState {
  if (workItemSortKeysForLaneDimension(dimension).includes(state.sort.key)) return state;
  return { ...state, sort: { ...WORK_ITEM_SORT_FALLBACK_NO_MANUAL } };
}

/**
 * 看板拖拽改序的启用判据（**唯一**一处）：看板 + statusCategory 分组 + 手动档 + 有写入口。
 *
 * 四条缺一不可：list/table 没有"列内"渲染（拖了没有落点）、按指派分组不许拖（验收 5）、
 * 非手动档下拖拽会让界面次序与写下的 position 对不上（"拖了看不出变化"）、
 * 页面没接写入口时给把手等于给一个点了没反应的入口。
 */
export function workItemBoardReorderEnabled(input: {
  view: WorkItemViewMode;
  laneDimension: WorkItemLaneDimension;
  sortKey: WorkItemSortKey;
  /** 页面是否接了写入口（`updateWorkItem` 那条唯一写路径）。 */
  hasWriter: boolean;
}): boolean {
  return (
    input.view === "board" &&
    input.laneDimension === "statusCategory" &&
    input.sortKey === "manual" &&
    input.hasWriter
  );
}

/* ---------------- 定义摘要（保存 / 编辑对话框里"我要存的是什么"的逐行投影） ---------------- */

/** 摘要的一行：`labelId` = 行的名字（复用既有词汇键），`valueIds` = 该行的取值（同样全复用既有键）。 */
export type WorkItemViewSummaryEntry = { labelId: string; valueIds: string[] };

/**
 * 定义摘要（**全复用既有键** —— 破例名单里没有摘要文案）：
 * 筛选 / 视图 / 分组 / 排序 / 显示列，逐行给出"这一份定义说的到底是什么"。
 *
 * 为什么必须逐行给：保存对话框上只有名字与一个勾选时，用户看不出自己**正在存什么**
 * （存下去才发现把"只看进行中"也存进去了）。摘要行与取值都取 R1 的闭集映射，
 * 不抄第二份词汇（抄一份 = 将来某一处改了，对话框与控件带说的不是一回事）。
 */
export function workItemViewDefinitionSummary(input: {
  query: WorkItemViewQueryDocument;
  display: WorkItemViewDisplayDocument;
}): WorkItemViewSummaryEntry[] {
  const visibleColumns = WORK_ITEM_SURFACE_COLUMNS.filter(
    (column) => !input.display.hiddenColumns.includes(column),
  );
  return [
    {
      labelId: "squad.workItems.filter.label",
      valueIds: [
        WORK_ITEM_STATUS_FILTER_MESSAGE_IDS[input.query.statusCategory],
        WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS[input.query.priority],
      ],
    },
    {
      labelId: "squad.workItems.view.label",
      valueIds: [WORK_ITEM_VIEW_MODE_MESSAGE_IDS[input.display.viewMode]],
    },
    {
      labelId: "squad.workItems.lane.dimension",
      valueIds: [WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS[input.display.grouping]],
    },
    {
      labelId: "squad.workItems.sort.label",
      valueIds: [
        WORK_ITEM_SORT_MESSAGE_IDS[input.display.sortBy],
        WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS[input.display.sortDirection],
      ],
    },
    {
      labelId: "squad.workItems.columns.label",
      valueIds: visibleColumns.map((column) => WORK_ITEM_COLUMN_MESSAGE_IDS[column]),
    },
  ];
}

/* ---------------- 对话框投影（标题 / 初值 / 可见性是否锁死） ---------------- */

/** 对话框回传的提交：名字 + 是否共享（= 可见性；`my` 档恒私有，故不单独给 scope 控件）。 */
export type WorkItemViewFormSubmit = { name: string; shared: boolean };

/** 打开中的对话框：`draft` 是**打开那一刻**的定义快照（对话框说的与要存的是同一份）。 */
export type WorkItemViewDialog =
  | {
      kind: "create";
      /** 从某条视图「另存为」时带的源（纯记账：复制的是它的定义，不是当前界面状态）。 */
      sourceViewId: string | null;
      draft: { query: WorkItemViewQueryDocument; display: WorkItemViewDisplayDocument };
    }
  | {
      kind: "edit";
      view: WorkItemViewRecord;
      /** 编辑 = 把**当前调整**写回定义 ⇒ 快照取打开那一刻的 surface 状态。 */
      draft: { query: WorkItemViewQueryDocument; display: WorkItemViewDisplayDocument };
    };

/**
 * 对话框打开的**投影**（标题 / 名字初值 / 可见性初值 / 可见性是否锁死）—— **唯一**一处判据，
 * 组件只投影它、用例逐格钉它。
 *
 * 三条：① 标题随入口变（菜单「新建」= `new`；从某条视图「另存为」= `saveAs`；编辑 = `edit`）；
 * ② `my` 档（我的视角）恒私有 ⇒ 可见性控件**不渲染**（服务面 patch 会响亮拒绝非 private）；
 * ③ 编辑态的名字初值 = 这条视图的名字（不回填 = 一编辑就改名，且不报错）。
 */
export function workItemViewDialogProjection(dialog: WorkItemViewDialog): {
  titleId: string;
  initialName: string;
  initialShared: boolean;
  visibilityLocked: boolean;
} {
  if (dialog.kind === "create") {
    return {
      titleId:
        dialog.sourceViewId === null ? "squad.workItems.views.new" : "squad.workItems.views.saveAs",
      initialName: "",
      initialShared: false,
      visibilityLocked: false,
    };
  }
  const shared = workItemViewSharedOf(dialog.view.visibility);
  return {
    titleId: "squad.workItems.views.edit",
    initialName: dialog.view.name,
    initialShared: shared,
    visibilityLocked: workItemViewVisibilityLocked({
      scopeType: dialog.view.scopeType,
      shared,
    }),
  };
}

/* ---------------- 表单判据（名字 / 可见性）与管理面板投影 ---------------- */

/**
 * 表单的名字 ⇒ 可提交的名字（`null` = 不可提交）。**trim 后按码点**取 1..80 ——
 * 与服务面（`assertName` 与 DDL 的 `length(name)`）同一把尺子，不在界面这层另立一套长度口径。
 *
 * 为什么要 trim：首尾空白是**输入噪音**，不是名字的一部分；用户看不出自己"多打了一个空格"，
 * 却会在服务面被拒（或存下一个眼睛看不出来的名字）。
 */
export function workItemViewNameSubmitValue(raw: string): string | null {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > WORK_ITEM_VIEW_NAME_MAX_LENGTH) return null;
  return name;
}

/** 勾选（是否共享）⇒ 可见性。勾 = `workspace`（工作区可见）、不勾 = `private`（服务端缺省同值）。 */
export function workItemViewVisibilityOf(shared: boolean): WorkItemViewVisibility {
  return shared ? "workspace" : "private";
}

/** 可见性 ⇒ 勾选（表单初值）。 */
export function workItemViewSharedOf(visibility: WorkItemViewVisibility): boolean {
  return visibility === "workspace";
}

/**
 * 可见性控件要不要**锁死**（不渲染 / 置灰）：`my` 档（"我的视角"）恒私有 ——
 * 服务面在 create 强制、patch **响亮拒绝**，DB 还有 CHECK ⇒ 界面不该先给一个必然被拒的开关
 * （"给得出、然后报错"比"不给"更糟：用户以为可以共享，试了才知道不行）。
 */
export function workItemViewVisibilityLocked(input: {
  scopeType: WorkItemViewScopeType;
  shared: boolean;
}): boolean {
  return input.scopeType === "my" && !input.shared;
}

/** 管理面板的一行：记录 + 它那枚标签 + 管理权（三处共用同一份判据：条上菜单 / 面板 / 删除确认）。 */
export type WorkItemViewManageRow = {
  view: WorkItemViewRecord;
  tab: WorkItemViewTab;
  canManage: boolean | null;
};

export function workItemViewManageRows(input: {
  views: readonly WorkItemViewRecord[];
}): WorkItemViewManageRow[] {
  return input.views.map((view) => {
    const tab = workItemViewTabs({ views: [view] })[1]!;
    return { view, tab, canManage: workItemViewTabActions(tab).canManage };
  });
}
