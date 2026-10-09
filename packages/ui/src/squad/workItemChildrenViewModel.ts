import type { SquadSnapshot } from "@zcode/services";
import { isTerminalWorkItemStatus, type WorkItem } from "@zcode/shared";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";
import { workItemProjectSelectValue } from "./workItemProjectViewModel.js";
import {
  workItemQuickCreateDraftAfterSubmit,
  workItemQuickCreateRequest,
  type WorkItemQuickCreateRequest,
} from "./workItemQuickCreateViewModel.js";

/* 详情页「子项」区（阶段三 · T-P3-R3）的**纯判据**：子项清单怎么来、摘要怎么数、四态怎么分、
   「添加子项」能不能写、请求长什么样。

   为什么判据独立成模块（不是为了好看）：本包没有交互测试设施（照 `workItemsViewModel` /
   `workItemQuickCreateViewModel` 的既定做法），判据写进组件就等于不可测；而这一区的坏法全是
   **静默**的 —— 名册读不到时画成「还没有子项」（把故障说成事实）、终态按**键名**比较（`cancelled`
   是 closed 类终态却数不进「已收尾」）、子项另排一次序（与看板的同胞次序漂移）、自己爬 parentId
   链当第二棵树遍历。四处都不报错，只有逐格钉住才看得见。

   本文件不 import React、不 import UI 原语、不碰服务实现（类型除外）。 */

/**
 * 本体的**子项清单**：名册按 `parentId` 过滤出**直接**子项，次序**原样**（不重排）。
 *
 * 为什么次序原样就是「复用既有 position 口径」：名册（`snapshot.workItems`）来自
 * `listByWorkspace`，SQL 已按 `position ASC, created_at ASC, id ASC` 排好；同 position 的
 * tie-break 只有那份 SQL 知道（`created_at` / `id` 不在传入的投影语义里）。在这里再排一次 =
 * 第二份排序判据 —— 与看板同层同胞的次序迟早漂移，而漂移不报错（表现是「详情页的子项次序
 * 与看板上不一样，但没人能说出哪个对」）。
 *
 * 为什么只取**直接**子项（不递归后代）：本区是「这一条的子项」，不是第二棵批次树 ——
 * 整棵树的遍历（根判据 / 深度 / 环兜底）只有看板那一份 `flattenWorkItemBoard`。
 * 父项不在名册里也不影响本函数（过滤按值比较，不查父链）：判据只有一条。
 */
export function workItemChildren(input: {
  /** 名册工作项（快照的 `workItems`，repo 次序）。 */
  workItems: readonly WorkItem[];
  /** 本体的 id（子项 = `parentId === 它`）。 */
  parentId: string;
}): WorkItem[] {
  return input.workItems.filter((item) => item.parentId === input.parentId);
}

/**
 * 子项摘要：`total` = 全部子项，`terminal` = 终态子项数 —— 终态判定复用 shared 的
 * `isTerminalWorkItemStatus`（**category** 口径：`done` 与 `cancelled` 都算收尾）。
 *
 * 为什么不比较键名（`status === "done"`）：六键只是标签，category 才是机器判定依据
 * （`work-item.ts` 的明文纪律）。比较键名会把「已取消的子项」说成没结束 —— 摘要与看板泳道
 * （`WORK_ITEM_STATUS_CATEGORY`）对同一批数据的说法不一致，且这句错话界面上看不出来。
 */
export function workItemChildrenSummary(children: readonly WorkItem[]): {
  total: number;
  terminal: number;
} {
  return {
    total: children.length,
    terminal: children.filter((child) => isTerminalWorkItemStatus(child.status)).length,
  };
}

/**
 * 子项区的**呈现态**（判别联合：四格里没有一格是「空清单冒充故障」）。
 *
 * 三格判据（各自对应一条既有纪律）：
 * · `rosterFailure !== null` ⇒ `unavailable`（**故障**，原因原样带出；名册读不到时**不允许**
 *   画成 `ready + []` —— 那会把「读不到」说成「没有」，用户看到的是界面上最像答案的那句假话）；
 * · `snapshot === null`（且没失败）⇒ `loading`（首帧 / 换 workspace 重读中；不能提前宣布读不到）；
 * · 否则 `ready`：`children` 与 `summary` 都由上面两个纯函数产出，零子项是**合法事实**
 *   （与 `unavailable` 是不同的 kind，调用方想合并都合并不了）。
 *
 * 页面侧的不变式（接线层保证）：成功读取会清 `rosterFailure`、失败会清 `snapshot` ——
 * 两格不会同时有值；万一同时有值，**故障优先**（说了读不到就不该再摆一份可能过期的清单）。
 */
export type WorkItemChildrenView =
  | { kind: "loading" }
  | { kind: "unavailable"; error: string }
  | { kind: "ready"; children: WorkItem[]; summary: { total: number; terminal: number } };

export function workItemChildrenView(input: {
  parentId: string;
  /** 已读到的名册；`null` = 还没有（loading / 失败）。 */
  snapshot: SquadSnapshot | null;
  /** 名册读取失败的原因；`null` = 没失败。 */
  rosterFailure: string | null;
}): WorkItemChildrenView {
  if (input.rosterFailure !== null) return { kind: "unavailable", error: input.rosterFailure };
  if (input.snapshot === null) return { kind: "loading" };
  const children = workItemChildren({
    workItems: input.snapshot.workItems,
    parentId: input.parentId,
  });
  return { kind: "ready", children, summary: workItemChildrenSummary(children) };
}

/* ---------- 「添加子项」（复用 P3-R1 的判据与编排，不写第二份） ---------- */

/**
 * 「添加子项」的**禁用原因**（`null` = 可写）：入口常驻、归档时置灰并给原因。
 *
 * 为什么只有一格（归档）：父项已归档 ⇒ 服务面 `validateParent` 必拒（`父工作项不存在或已归档`）——
 * 说得出原因就不该让用户撞一次墙；其余情形（名册没就绪 / 有写成在飞）是**暂时**态，
 * 由子项区自己的四态说明行与提交判据表达，各自说各自的话（不混成一个「不能写」）。
 */
export function workItemChildAddDisabledReason(input: { archived: boolean }): string | null {
  return input.archived ? "squad.workItemDetail.children.disabled.archived" : null;
}

/**
 * 子项添加的请求 = **P3-R1 快速创建那一枚请求构造**（`workItemQuickCreateRequest`）的调用：
 * 标题 trim + `parentId` = 本体 id + 默认指派本机用户，其余键一律不传。
 *
 * 为什么把父项固定在这里（而不是像视图顶部那样给一个父项下拉）：本区的位置就已经说明了父项
 * （「这一条的子项」），再给一个可改的下拉等于在详情页里开第二个「在别处建项」的入口。
 */
export function workItemChildCreateRequest(input: {
  title: string;
  parentId: string;
  /** 父项的项目（R-P2）：子项**继承**父项的项目（与快速创建条同一条判据与语义）。 */
  parentProjectId?: string;
}): WorkItemQuickCreateRequest {
  return workItemQuickCreateRequest({
    title: input.title,
    parentValue: input.parentId,
    projectValue: workItemProjectSelectValue(input.parentProjectId),
  });
}

/**
 * 提交之后标题草稿的下一步：成功 ⇒ 清标题（可连续加）、失败 ⇒ **原样保留**（不用重打）。
 *
 * 实现**直接委托** P3-R1 的 `workItemQuickCreateDraftAfterSubmit`（父项在本区是常量，原样带回）：
 * 「成功清、失败留」只有一处实现 —— 两处各写一份的漂移不报错，表现是「一个入口失败后清空了
 * 用户输入、另一个没有」。
 */
export function workItemChildDraftAfterSubmit(input: {
  title: string;
  parentId: string;
  /** 父项的项目（R-P2）：与请求同一条继承口径（父项固定，故成功路径不重算）。 */
  parentProjectId?: string;
  feedback: SquadEntryFeedback | null;
}): string {
  return workItemQuickCreateDraftAfterSubmit({
    draft: {
      title: input.title,
      parentValue: input.parentId,
      projectValue: workItemProjectSelectValue(input.parentProjectId),
    },
    feedback: input.feedback,
    /* 父项在本区是常量（本体）⇒ 成功路径不需要候选重算项目继承（值是现成带进来的）。 */
    workItems: [],
  }).title;
}
