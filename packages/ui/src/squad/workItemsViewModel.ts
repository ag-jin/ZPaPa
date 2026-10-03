import type { WorkItem, WorkItemStatusKey } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";

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

  const rows: WorkItemBoardRow[] = [];
  const visited = new Set<string>();

  const walk = (item: WorkItem, depth: number): void => {
    // 重复 id 不再进入：环在第二次遇到时停（防御；见函注）。
    if (visited.has(item.id)) return;
    visited.add(item.id);
    rows.push({ item, depth });
    for (const child of childrenOf.get(item.id) ?? []) {
      walk(child, depth + 1);
    }
  };

  const isRoot = (item: WorkItem): boolean =>
    item.parentId === undefined || !byId.has(item.parentId);
  for (const item of items) {
    if (isRoot(item)) walk(item, 0);
  }
  // 兜底（坏数据才可达）：无根可达的项按给定顺序补足为根 —— 不静默丢行。
  for (const item of items) {
    if (!visited.has(item.id)) walk(item, 0);
  }
  return rows;
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
