import {
  WORK_ITEM_STATUS_CATEGORY,
  type Squad,
  type TeamAgent,
  type WorkItem,
  type WorkItemStatusCategory,
  type WorkItemStatusKey,
} from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { assigneeOptionValue, resolveAssigneeName } from "./squadEntryViewModel.js";

/* 「工作项」一级页面（WorkItemsPage）的**纯逻辑**。

   状态机与行动作判据是**面无关**的，已抽到 `squadSurfaceViewModel`（三个面共用**同一份**
   实现）；这里只放工作项面**独有**的判据，让「新建按钮置灰」与「看板怎么排」这两处问的是
   同一个函数（两处各写一遍迟早分叉，而分叉不报错）。照 `squadsViewModel.ts` 的既定做法：
   本文件不 import React、不 import UI 原语 —— ui 包没有渲染测试设施，判断留在组件里
   就等于不可测。 */

/**
 * 看板的一行：工作项 + 它在树里的**缩进深度**（根 = 0，子项 = 父 + 1）。
 *
 * 为什么深度由纯函数算而不是让组件递归渲染：树深上限是 spec 的机制（`WORK_ITEM_MAX_DEPTH`
 * = 5），缩进是它的投影；把「父子关系怎么变成行序 + 深度」放进可被 node:test 钉住的纯函数，
 * 组件只负责照 `depth` 画缩进（组件里递归 = 不可测，且容易写出「子项出现在父项之前」这类
 * 只靠肉眼发现的错序）。
 */
export type WorkItemBoardRow = { item: WorkItem; depth: number };

/**
 * 把工作项森林压平成「行序 + 深度」列表（深度优先**前序**：子项紧随其父）。
 *
 * **根** = `parentId` 缺失，**或父项不在给定集合里**。后者不是边角料：`listByWorkspace`
 * 只列未归档项，父项一旦归档就从集合里消失 —— 若「父不在集合」不当根，它的子项会**整条
 * 从看板上消失**（数据仍在库里，界面却说没有，且不报错）。孤儿当根 = 宁可缩进不对，不可
 * 丢项。
 *
 * **顺序稳定性**：根之间、同胞之间都按 `items` 的给定顺序输出（`listByWorkspace` 已按
 * `position → created_at → id` 排好）；子项紧随其父（前序 DFS），孙项深度继续加深。
 * 同一份数据两次渲染的行序不会漂移 —— 否则界面看起来像「有人在动数据」。
 *
 * **环保护是防御，不是判据**：库里理论上不允许成环（`WorkItemService.validateParent` 沿
 * 父链查环），正常数据走不到下面那条兜底。但纯函数**不得因坏数据死循环**（一个 hover 就能
 * 把界面卡死），所以：`visited` 保证每个 id 至多输出一次（环在第二次遇到时停），处理完所有
 * 根后仍未被访问到的项（坏数据：互指成环、或重复 id 让某个 id 不可达）按给定顺序**当根补足**
 * —— 与其静默丢掉这些行，不如把它们摊平显示（防御动作的取舍：可读性 > 缩进准确性）。
 * 这不是第二份「谁是根」的判据：本函数的根判据只有上面那一条，兜底只在坏数据下才触发。
 */
export function flattenWorkItemBoard(items: WorkItem[]): WorkItemBoardRow[] {
  return walkWorkItemBoardForest(items).map(({ item, depth }) => ({ item, depth }));
}

/** 一棵**树单元**：根行 + 它的全部后代行（DFS 前序，深度自根起算）。 */
export type WorkItemBoardTree = { root: WorkItem; rows: WorkItemBoardRow[] };

/**
 * 树单元投影：按**输入顺序**给出「根 + 该根的子树行」。
 *
 * 为什么留给本文件（而不是让调用方自己分组）：`root` 是 `walkWorkItemBoardForest` 的一个产出
 * （与 `flattenWorkItemBoard` / `groupWorkItemBoard` 共用**同一份** DFS），把它暴露给需要
 * 「哪些行属于同一棵树」的消费方（阶段二 Surface 的整树过滤/排序），才能让「谁是根」只有一份
 * 判据 —— 调用方若自己按 `parentId` 爬链，就是第二份根判据（分叉不报错，表现是某棵树凭空
 * 换了位置或消失）。空输入 ⇒ `[]`。
 */
export function workItemBoardTrees(items: WorkItem[]): WorkItemBoardTree[] {
  const trees: WorkItemBoardTree[] = [];
  const indexByRootId = new Map<string, number>();
  for (const row of walkWorkItemBoardForest(items)) {
    let index = indexByRootId.get(row.root.id);
    if (index === undefined) {
      index = trees.length;
      indexByRootId.set(row.root.id, index);
      trees.push({ root: row.root, rows: [] });
    }
    trees[index]!.rows.push({ item: row.item, depth: row.depth });
  }
  return trees;
}

/**
 * 森林的**唯一**遍历实现（`flattenWorkItemBoard` 与 `groupWorkItemBoard` 共用它）。
 *
 * 为什么必须共用：根判据（`parentId` 缺失**或**父不在集合里）与环/重复 id 兜底是同一套语义。
 * 分组另抄一份 = 两个投影对「谁是根」的答案可能不同，而分叉**不报错** —— 表现是「某个批次
 * 在泳道视图里凭空换了泳道（或消失）」，只有肉眼能发现。
 *
 * 多返回一个 `root`（该行所属的根行），分组据此把整棵子树归到根所在的那条泳道。
 */
function walkWorkItemBoardForest(
  items: WorkItem[],
): Array<{ item: WorkItem; depth: number; root: WorkItem }> {
  const byId = new Map<string, WorkItem>();
  const childrenOf = new Map<string, WorkItem[]>();
  for (const item of items) {
    // 首次出现为准：重复 id（坏数据）不覆盖已登记的父链，避免同一 id 的两次输出互相矛盾。
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  for (const item of items) {
    const parentId = item.parentId;
    // 父不在集合里的项不挂到任何父下（它自己就是根，见上）；父在集合里的按给定顺序入列表。
    if (parentId === undefined || !byId.has(parentId)) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) {
      siblings.push(item);
    } else {
      childrenOf.set(parentId, [item]);
    }
  }

  const rows: Array<{ item: WorkItem; depth: number; root: WorkItem }> = [];
  const visited = new Set<string>();

  const walk = (item: WorkItem, depth: number, root: WorkItem): void => {
    // 重复 id 不再进入：环在第二次遇到时停（防御；见 flattenWorkItemBoard 的函注）。
    if (visited.has(item.id)) return;
    visited.add(item.id);
    rows.push({ item, depth, root });
    for (const child of childrenOf.get(item.id) ?? []) {
      walk(child, depth + 1, root);
    }
  };

  const isRoot = (item: WorkItem): boolean =>
    item.parentId === undefined || !byId.has(item.parentId);
  for (const item of items) {
    if (isRoot(item)) walk(item, 0, item);
  }
  // 兜底（坏数据才可达）：无根可达的项按给定顺序补足为根 —— 不静默丢行。
  for (const item of items) {
    if (!visited.has(item.id)) walk(item, 0, item);
  }
  return rows;
}

/**
 * 泳道分组维度（**闭集**：加一个维度必须改这个类型 ⇒ 编译期把所有消费点拖出来）。
 * · `none`：不分组（**默认**，看板 DOM 逐字保留现状）；
 * · `statusCategory`：按**根**的状态 category（4 条固定泳道）；
 * · `assignee`：按**根**的指派对象（user 固定第一条，其余按首现顺序）。
 */
export type WorkItemLaneDimension = "none" | "statusCategory" | "assignee";

/** 一条泳道：`key` 是稳定身份（category 值 / `user` / `agent:<id>` / `squad:<id>`），`count` = 行数。 */
export type WorkItemBoardLane = { key: string; count: number; rows: WorkItemBoardRow[] };

/** 状态 category 的泳道名：`Record<WorkItemStatusCategory, string>` **强制穷尽**
    （将来加一个 category 会在编译期失败，而不是界面上多出一个裸 key）。
    它**不替代** 6 键文案（`WORK_ITEM_STATUS_MESSAGE_IDS`）：用途不同 —— 6 键说的是「这一条现在
    是什么状态」，category 说的是「这一组骨架叫什么」，两套词汇并存。 */
export const WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS: Record<WorkItemStatusCategory, string> = {
  unstarted: "squad.workItems.lane.statusCategory.unstarted",
  started: "squad.workItems.lane.statusCategory.started",
  done: "squad.workItems.lane.statusCategory.done",
  closed: "squad.workItems.lane.statusCategory.closed",
};

/** 指派泳道的泳道名解析：`name` = 显示名（null = 当前用户，由本地化文案补），
    `known` = 这个对象现在还在不在名册里（不在 ⇒ 组件补一句「已不在名册」后缀）。
    名字本身仍走 `resolveAssigneeName` 单源（未知 id 回落 id），这里只是把「回落发生了」也说出来。 */
export function workItemLaneAssigneeName(
  roster: { teamAgents: TeamAgent[]; squads: Squad[] },
  assignee: WorkItem["assignee"],
): { name: string | null; known: boolean } {
  const name = resolveAssigneeName(roster, assignee);
  if (assignee.type === "user") return { name, known: true };
  const known =
    assignee.type === "agent"
      ? roster.teamAgents.some((entry) => entry.id === assignee.id)
      : roster.squads.some((entry) => entry.id === assignee.id);
  return { name, known };
}

/**
 * 看板分组：把工作项森林按维度分成泳道。
 *
 * **只切根、子树整体随根落位**（本轮的硬约束）：分组键取自**根行**，子树的行与深度原样跟着走。
 * 按行自身分组会把一个批次劈到不同泳道（子项状态与根不同时），直接破坏「批」这一既有语义单元
 * —— 批根是时间线展开钮、`isSquadBatchRoot` 判据与「放弃整批」入口的宿主，它必须是**一行**的
 * 视觉单元（拆解 §5.1 的被否决方案）。
 *
 * 三条口径：
 * · `none`：单条（`rows` 与 `flattenWorkItemBoard` **逐格等价**：同一份 DFS）；
 * · `statusCategory`：固定 4 条（`unstarted → started → done → closed`），**空泳道保留**（骨架不随
 *   数据跳动 —— 泳道忽有忽无会让人以为数据在动）；键取自 `WORK_ITEM_STATUS_CATEGORY[root.status]`，
 *   **不认 6 键**（category 才是机器判定依据）；
 * · `assignee`：`user` 固定第一条（本地用户是常路），其余按**首现顺序**（确定性；不按名册名或
 *   locale 排序 —— 那是另一个真相源，且会让泳道顺序随改名漂移）；不产生空泳道（开放集）。
 *
 * 空输入 ⇒ `[]`（任何维度都不造空骨架：空态由看板的空态分支负责，泳道不替它说话）。
 * 输入次序即泳道内次序（repo 已按 `position → created_at → id` 排好），本函数不重排。
 */
export function groupWorkItemBoard(input: {
  items: WorkItem[];
  dimension: WorkItemLaneDimension;
  roster: { teamAgents: TeamAgent[]; squads: Squad[] };
}): WorkItemBoardLane[] {
  const { items, dimension, roster } = input;
  if (items.length === 0) return [];
  const rows = walkWorkItemBoardForest(items).map(({ item, depth, root }) => ({
    item,
    depth,
    root,
  }));

  if (dimension === "none") {
    return [
      { key: "none", count: rows.length, rows: rows.map(({ item, depth }) => ({ item, depth })) },
    ];
  }

  // 泳道顺序：statusCategory 是固定骨架；assignee 是「user 先、其余按首现」。
  const orderedKeys: string[] = [];
  const buckets = new Map<string, WorkItemBoardRow[]>();
  if (dimension === "statusCategory") {
    for (const category of ["unstarted", "started", "done", "closed"] as WorkItemStatusCategory[]) {
      orderedKeys.push(category);
      buckets.set(category, []);
    }
  }
  for (const row of rows) {
    const key =
      dimension === "statusCategory"
        ? WORK_ITEM_STATUS_CATEGORY[row.root.status]
        : assigneeOptionValue(row.root.assignee);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      orderedKeys.push(key);
    }
    buckets.get(key)!.push({ item: row.item, depth: row.depth });
  }
  // `user` 固定第一条：分组键的收集顺序由数据决定，但本地用户是常路，不应被某个 agent 抢到首位。
  const ordered =
    dimension === "assignee" && orderedKeys.includes("user")
      ? ["user", ...orderedKeys.filter((key) => key !== "user")]
      : orderedKeys;
  return ordered.map((key) => {
    const laneRows = buckets.get(key) ?? [];
    return { key, count: laneRows.length, rows: laneRows };
  });
}

/** 工作项状态的文案 id：用 `Record<WorkItemStatusKey, string>` **强制穷尽** ——
    将来给 `WORK_ITEM_STATUS_KEYS` 加一个状态时这里会编译失败，而不是界面上多出一个裸 key。 */
export const WORK_ITEM_STATUS_MESSAGE_IDS: Record<WorkItemStatusKey, string> = {
  todo: "squad.workItems.status.todo",
  in_progress: "squad.workItems.status.in_progress",
  in_review: "squad.workItems.status.in_review",
  blocked: "squad.workItems.status.blocked",
  done: "squad.workItems.status.done",
  cancelled: "squad.workItems.status.cancelled",
};

export function workItemStatusMessageId(status: WorkItemStatusKey): string {
  return WORK_ITEM_STATUS_MESSAGE_IDS[status];
}

/** 看板行上标签 chip 的显示上限：超出的折成「+N」（行是窄的，标签会把状态与指派人挤出去）。 */
export const WORK_ITEM_LABEL_CHIP_MAX = 3;

/**
 * 看板行的标签 chip 投影：`shown` = 前 `max` 个，`hiddenCount` = 被折进「+N」的个数。
 *
 * 为什么截断投影也要在纯函数里：它是**呈现判据**（显示几个、还剩几个），组件里算就等于不可测；
 * 而且它与详情页的「全量呈现」是两件不同的事（详情页不调本函数）—— 两处的差别必须显式。
 * 空数组 ⇒ `{shown: [], hiddenCount: 0}`（调用方据此整块不渲染，不留一个空 chip 行）。
 */
export function workItemLabelChips(
  labels: readonly string[],
  max: number = WORK_ITEM_LABEL_CHIP_MAX,
): { shown: string[]; hiddenCount: number } {
  const shown = labels.slice(0, max);
  return { shown, hiddenCount: labels.length - shown.length };
}

/**
 * `properties` 值的呈现文本（#11 v1 的只读呈现）：字符串**原样**，其余类型原样 `JSON.stringify`
 * （对象 / 数组 / 数字 / 布尔 / null 都读得出来）。
 *
 * 为什么不按类型做控件（数字输入框 / 勾选框 …）：设计说 properties 是「**带类型**的自定义属性」，
 * 而我们的字段是 `Record<string, unknown>` 且**今天没有任何写者**（create 恒写 `{}`）——
 * 先给它造一套类型契约就是替设计补一个没裁过的决定。v1 只做「看得见」，不猜类型。
 */
export function workItemPropertyValueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * 「新建工作项」按钮**可点**吗：有目标 + **已成功取到快照**。
 *
 * 照 `squadCreateEnabled` 的判据形态（有目标 + 已取到快照）：新建对话框的**指派人 / 父项**
 * 两个下拉都**来自快照**（`workItemAssigneeOptions(snapshot)` 与 `snapshot.workItems`）。
 * 取数失败 / 加载中时快照为 null ⇒ 对话框里的候选是空数组 ⇒ 只能建出「无父项 + 指派给用户」
 * 这一种——但那不是因为别的选项不可用，是因为**还没读到**：「点得开但通往死路」比置灰更糟
 * （用户只会读成功能坏了）。置灰 + 上方错误态（带原因与重试）才是既有裁定
 * （2026-10-03 实测教训：「入口常驻、置灰，由状态行说明原因」，不是整块消失）。
 *
 * 注意与「入口常驻」不矛盾：本判据只决定**可不可点**，按钮始终渲染（可见性不依赖取数成功）。
 */
export function workItemCreateEnabled(input: {
  hasTarget: boolean;
  snapshot: SquadSnapshot | null;
}): boolean {
  return input.hasTarget && input.snapshot !== null;
}
