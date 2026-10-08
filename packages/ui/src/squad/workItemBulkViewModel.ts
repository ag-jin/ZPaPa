import { parseWorkItemLabels, type WorkItem, type WorkItemPriorityKey } from "@zcode/shared";
import {
  parseWorkItemSurfaceFields,
  workItemSurfaceFieldErrorMessageId,
} from "./workItemPropertiesViewModel.js";
import {
  WORK_ITEM_PRIORITY_CLEAR_VALUE,
  workItemInlineEditUnavailableReason,
} from "./workItemInlineEditViewModel.js";
import { squadEntryErrorFeedback } from "./squadEntryViewModel.js";

/* 工作项**批量工具栏**（阶段二 · T-P2-R5）的纯判据：选择集口径 / 可批量字段 / 结果汇总。

   为什么要有这一层（与 `workItemSurfaceViewModel` / `workItemSurfaceControlsViewModel` 同一理由）：
   本包没有渲染测试设施，判据写进组件就等于不可测；而批量面的坏法全是**静默**的 ——
   ① 选择集在过滤/搜索变化后仍留着用户**看不见的行**（"应用到已选"会改到屏幕外的数据，没人知道）；
   ② 行选择控件的可用判据与行内编辑各写一份（归档行在一处能选、在另一处不能写，两边都不报错）；
   ③ 结果只汇报总数（"成功 3 / 失败 2"看起来一切正常，而**哪两条**失败、为什么失败没人说得出）。

   本文件不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**消息 id**）。
   状态（选择集 / 选择模式）是**会话内**状态，由 `WorkItemsPage` 持有（与 `surface` / `laneDimension`
   同款：控件带渲染在页面的动作行里，取数失败时也要常驻）；本层只做「状态 + 数据 → 结论」的
   纯映射（唯一例外是 `executeWorkItemBulkEdit`：它把**执行次序**（逐条、串行）也钉在这里，
   见该函数的注释）。

   **零键增**（阶段二键目录已冻结）：本层只给消息 id，取值全部落在既有键上。 */

/* ---------------- 可批量写的行 ---------------- */

/**
 * 这一行**给不给**批量写入口：判据**复用**行内编辑那一份（`workItemInlineEditUnavailableReason`
 * → `writeDisabledReason`），本层不写第二份 `archivedAt !== undefined`。
 *
 * 为什么必须是同一份：服务面 `updateWorkItem` 对归档行**响亮抛**（未命中），所以"能不能选"与
 * "能不能写"必须是同一个结论 —— 两处各判一遍，迟早在某一面漏掉一格，而漏掉的表现是
 * 「勾得上、点了必失败」（用户看到的是"操作失败"，不是"这行不能改"）。
 */
export function workItemBulkSelectable(item: Pick<WorkItem, "archivedAt">): boolean {
  return workItemInlineEditUnavailableReason(item) === null;
}

/* ---------------- 可批量字段（闭集） ---------------- */

/**
 * v1 可批量字段（**闭集**：加一枚 ⇒ 类型报错拖出控件与判据的消费点）。
 *
 * 范围由 Q7 裁定：**只做内容型字段**（优先级 / 标签 / 日期）。改派与状态**不在**这里 ——
 * 改派 = **新派发**（会产生 N 次 run / 配额 / 事件，且与实验门禁耦合），批量状态要逐条 CAS
 * （部分命中语义复杂）：两者都要先落独立裁定，不该顺手做。它们各自的单条入口仍在行上。
 */
export type WorkItemBulkField = "priority" | "labels" | "startDate" | "dueDate";

export const WORK_ITEM_BULK_FIELDS: readonly WorkItemBulkField[] = [
  "priority",
  "labels",
  "startDate",
  "dueDate",
];

/** 字段 → 文案键的**穷尽**映射：全部复用既有字段词汇（同一概念一句话；零键增）。 */
export const WORK_ITEM_BULK_FIELD_MESSAGE_IDS: Record<WorkItemBulkField, string> = {
  priority: "squad.workItems.priority",
  labels: "squad.workItems.labels",
  startDate: "squad.workItems.startDate",
  dueDate: "squad.workItems.dueDate",
};

/* ---------------- 选择集（勾选 / 取消 / 清空 / 收敛） ---------------- */

/**
 * 批量选择在**行内**的投影（宿主透传给行模块；`undefined` = **未进入批量选择模式**）。
 *
 * 为什么要这个形状而不是几个散参数：行模块只该知道「勾选件的三种状态」（勾选态 / 可不可点 /
 * 点它做什么），不该知道"选择集是什么、为什么变" —— 那是页面的会话内状态与收敛判据的事。
 * `undefined` 是**有意义的默认**（不是"忘了接线"）：未进入批量模式时行结构与今天逐槽相同
 * （见 `WorkItemRows` 的结构纪律），而"忘接线"由用例里的接线守卫拦（`selection={…}` 的源码断言）。
 */
export type WorkItemRowSelection = {
  /** 已勾选的行 id（判据与次序由页面持有；这里只做 O(1) 命中）。 */
  selectedIds: ReadonlySet<string>;
  /** 批量写在飞 ⇒ 勾选件置灰（避免"写一半又改选择集"）。 */
  disabled: boolean;
  onToggle: (workItemId: string) => void;
};

/**
 * 勾选一次（**幂等往返**）：未选中 ⇒ 追加到末尾；已选中 ⇒ 移除。
 *
 * 为什么保留**勾选顺序**（不排序、不按行序重排）：呈现与写入都按这个次序走 ——
 * 用户能预期"我勾的第三行"就是逐条结果里的第三行；重排会让结果列表与操作顺序对不上，
 * 而这种错位不会报错。
 */
export function workItemBulkToggleSelection(input: {
  selected: readonly string[];
  workItemId: string;
}): string[] {
  const { selected, workItemId } = input;
  return selected.includes(workItemId)
    ? selected.filter((id) => id !== workItemId)
    : [...selected, workItemId];
}

/** 清空选择集（退出批量模式、点「清除选择」共用这一处结论）。 */
export function workItemBulkClearSelection(): string[] {
  return [];
}

/**
 * 选择集**收敛**到「当前可见集 ∩ 可写行」（承重验收 2 的口径，**显式钉住**）。
 *
 * 为什么是"收敛"而不是"保留"或"整份清空"：
 * · 保留（只按 id 记住）：过滤/搜索把某行移出视野后，"应用到已选"仍会改到**屏幕外的数据**
 *   —— 用户看不见、也没有任何提示，这是批量最危险的一种静默漂移；
 * · 整份清空：快照回读/后台刷新会让可见集**内容相同**（不同数组引用）时也清掉用户刚勾好的一批
 *   （用户得重勾一遍，且不知道为什么），代价同样不合理；
 * · 收敛：选择集恒 ⊆ 可见 ∧ 可写 —— 批量写**永远只作用在用户此刻看得见、且能写的行**上，
 *   这条不变式可以逐格断言（见用例）。
 *
 * 每次可见集变化（过滤 / 搜索 / 排序 / 快照回读）都经它求值一次；顺序沿用选择集自己的次序。
 */
export function workItemBulkReconcileSelection(input: {
  selected: readonly string[];
  /** 当前可见行（宿主投影后的项目；只读 id 与归档位，顺序与行序一致）。 */
  visible: readonly Pick<WorkItem, "id" | "archivedAt">[];
}): string[] {
  const writable = new Set(
    input.visible.filter((item) => workItemBulkSelectable(item)).map((item) => item.id),
  );
  return input.selected.filter((id) => writable.has(id));
}

/**
 * 本次批量写之后**还剩哪些行被选中**：只有**失败**的行留在选择集里。
 *
 * 为什么成功行要移出、失败行要留下：批量写的下一动作通常是"重试失败的那几条"——
 * 成功行留着，用户得先全部取消再勾；失败行被一并清掉，用户得凭记忆重新找出是哪几条
 * （而界面只给过一句"失败 2 项"）。这条口径与结果逐条呈现是同一件事的两面。
 */
export function workItemBulkSelectionAfterApply(input: {
  selected: readonly string[];
  failedIds: readonly string[];
}): string[] {
  const failed = new Set(input.failedIds);
  return input.selected.filter((id) => failed.has(id));
}

/** 两个选择集**逐项同序**吗 —— 页面把状态对齐到「有效选择集」时用它判断要不要改状态
    （每帧都换一个新数组 = 无谓重渲染，且同步 effect 会自激成死循环）。 */
export function workItemBulkSelectionEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/* ---------------- 取值草稿（页面持有；工具栏受控） ---------------- */

/** 批量条的取值草稿：改哪个字段 + 这一字段的**取值原文**（控件收集，判据在 `resolveWorkItemBulkEdit`）。 */
export type WorkItemBulkDraft = { field: WorkItemBulkField; value: string };

/** 草稿意图（闭集）：只有两件事可做 —— 换字段、改取值。 */
export type WorkItemBulkDraftIntent =
  | { kind: "setField"; field: WorkItemBulkField }
  | { kind: "setValue"; value: string };

/** 草稿初值：优先级 + 哨兵（= 未设置）。 */
export function workItemBulkDefaultDraft(): WorkItemBulkDraft {
  return { field: "priority", value: workItemBulkDefaultValue("priority") };
}

/**
 * 意图 → 新草稿（**纯**：不改入参）。
 *
 * 换字段必须**重置取值**（`workItemBulkDefaultValue`）：从「优先级 = 低」切到「标签」时把 `low`
 * 原样带过去，用户会看到自己从没输入过的标签被加到整批行上，而界面没有任何异常。取值只属于
 * **当前字段**，换字段 = 换一份取值（这条口径只有这一处实现 —— 草稿折叠不在组件里）。
 */
export function applyWorkItemBulkDraftIntent(
  draft: WorkItemBulkDraft,
  intent: WorkItemBulkDraftIntent,
): WorkItemBulkDraft {
  switch (intent.kind) {
    case "setField":
      return { field: intent.field, value: workItemBulkDefaultValue(intent.field) };
    case "setValue":
      return { ...draft, value: intent.value };
  }
}

/* ---------------- 取值归一化（判据单源：复用表单/行内编辑那两份纯函数） ---------------- */

/** 批量编辑的**取值原文**（控件收集；本层解析 —— 中间不再有一次字段名映射）。 */
export type WorkItemBulkEdit = { field: WorkItemBulkField; value: string };

/** 归一化结论（判别联合，照 `WorkItemInlineEditResolution`：非 ok 必须**指名**是哪一项）。 */
export type WorkItemBulkEditResolution =
  | { kind: "ok" }
  /** 没有可应用的内容（标签输入为空）：按钮置灰即可 —— 这不是"输入非法"，不该报一句错。 */
  | { kind: "empty" }
  | {
      kind: "invalid";
      field: WorkItemBulkField;
      /** 原文带回：失败文案里的 `{value}` 要说清是**哪个值**不对。 */
      value: string;
      messageId: string;
      /** 文案占位符（例如标签上限的 `{max}`）：由判据层给，视图不重算。 */
      values?: Record<string, string | number>;
    };

/** 标签两枚失败文案（既有键；与对话框同一套词 —— 上限是同一个上限，理由也是同一条）。 */
const WORK_ITEM_BULK_LABELS_TOO_MANY_MESSAGE_ID = "squad.workItems.labelsTooMany";
const WORK_ITEM_BULK_LABELS_TOO_LONG_MESSAGE_ID = "squad.workItems.labelsTooLong";

/** 字段的**初值**：优先级是哨兵（Radix 的 Select 不认空串，且空串 ≠ 未设置），其余是空文本。 */
function workItemBulkDefaultValue(field: WorkItemBulkField): string {
  return field === "priority" ? WORK_ITEM_PRIORITY_CLEAR_VALUE : "";
}

/** 下拉取值（含哨兵）→ 归一化输入原文：哨兵 = 未设置 = 空串（与表单字段同一条规则、同一个常量）。 */
function bulkPriorityInput(value: string): string {
  return value === WORK_ITEM_PRIORITY_CLEAR_VALUE ? "" : value;
}

/** 三项 Surface 字段共用一份归一化：只取**这一项**的结论（另外两项传空串 = 未设置）。 */
function resolveBulkSurfaceField(
  field: "priority" | "startDate" | "dueDate",
  value: string,
): WorkItemBulkEditResolution {
  const parsed = parseWorkItemSurfaceFields({
    priority: field === "priority" ? bulkPriorityInput(value) : "",
    startDate: field === "startDate" ? value : "",
    dueDate: field === "dueDate" ? value : "",
  });
  if (parsed.kind !== "ok") {
    return {
      kind: "invalid",
      field: parsed.field,
      value: parsed.value,
      messageId: workItemSurfaceFieldErrorMessageId(parsed.field),
    };
  }
  return { kind: "ok" };
}

/**
 * 取值 → 结论。**判据不在这里重写**：
 * · 优先级 / 日期的闭集与日历日判据走 `parseWorkItemSurfaceFields`（→ shared），失败文案走那一枚穷尽映射；
 * · 标签的切分 / 去重 / 上限走 shared 的 `parseWorkItemLabels`，失败文案复用既有两枚键。
 * 本层只做两件 UI 侧的事：把哨兵译回空串、把结论翻成「ok / empty / invalid」。
 */
export function resolveWorkItemBulkEdit(edit: WorkItemBulkEdit): WorkItemBulkEditResolution {
  if (edit.field === "labels") {
    const parsed = parseWorkItemLabels([edit.value]);
    if (parsed.kind === "too_many") {
      return {
        kind: "invalid",
        field: "labels",
        value: edit.value,
        messageId: WORK_ITEM_BULK_LABELS_TOO_MANY_MESSAGE_ID,
        values: { max: parsed.max, count: parsed.count },
      };
    }
    if (parsed.kind === "too_long") {
      return {
        kind: "invalid",
        field: "labels",
        value: edit.value,
        messageId: WORK_ITEM_BULK_LABELS_TOO_LONG_MESSAGE_ID,
        values: { max: parsed.max },
      };
    }
    return parsed.labels.length === 0 ? { kind: "empty" } : { kind: "ok" };
  }
  return resolveBulkSurfaceField(edit.field, edit.value);
}

/* ---------------- 逐条 patch 规划（写序 = 勾选序；同值行不写） ---------------- */

/**
 * 一条工作项要写的 patch：**判别形状**，直接就是服务面 `updateWorkItem` 白名单的子集
 * （页面把它原样并入请求 —— 少一次映射就少一次「界面改 A、请求里发 B」的机会）。
 */
export type WorkItemBulkPatch =
  | { priority: WorkItemPriorityKey | null }
  | { startDate: string | null }
  | { dueDate: string | null }
  /** 标签是**加**语义的产物：合并去重后的**整份**标签（服务面收的就是整份替换）。 */
  | { labels: string[] };

export type WorkItemBulkTarget = {
  id: string;
  /** 行标题：结果逐条可见时要**指认**是哪一行（标题是数据，不是文案键）。 */
  title: string;
  patch: WorkItemBulkPatch;
};

/**
 * 逐行的**预检**失败（不写库、也不静默丢内容）：目前只有一种 —— 标签合并后越过上限
 * （行上已经有 N 条，再加就把 N+1 条写进去了）。它必须在结果里**逐条**出现，
 * 不能并进"失败 2 项"那种总数里。
 */
export type WorkItemBulkPrecheckFailure = {
  workItemId: string;
  /** 行标题（结果逐条可见时用来指认是哪一行；标题是数据，不是文案键）。 */
  title: string;
  messageId: string;
  values?: Record<string, string | number>;
};

export type WorkItemBulkPlan = {
  /** 真正要写的行（顺序 = 选择集次序）。 */
  targets: WorkItemBulkTarget[];
  /** 本来就已是目标值 ⇒ **不写**（服务面「空 patch ⇒ 响亮抛」，且每次路过都写一次库在日志里与真实修改无别）。 */
  unchangedIds: string[];
  precheckFailures: WorkItemBulkPrecheckFailure[];
};

/** 两份标签**逐项相同**（顺序也相同 —— 标签顺序是用户的书写次序，重排等于替用户改数据）。 */
function sameWorkItemLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

/**
 * 把「选择集 + 取值」摊成**逐条**的写入计划。
 *
 * 三条口径：
 * ① **写序 = 勾选序**：结果列表与用户的操作顺序一一对应（重排会让"我勾的第三行"对不上结果第三行）；
 * ② **同值行不写**：走 `unchangedIds`（既不是成功也不是失败 —— 它已经处于目标状态）；
 * ③ 选择集里若有不在 `items` 里的 id（理论不可达：收敛保证 ⊆ 可见集）⇒ **不写**：
 *    宁可不写，也绝不写一行当前看不见的数据。
 *
 * 取值本身没归一化成功（`empty` / `invalid`）⇒ 返回空计划：拦在提交之前（服务面仍会响亮拒，
 * 但界面不该把一个必然失败的请求发出去）。
 */
export function workItemBulkPlan(input: {
  /** 当前可见行（宿主投影后的项目）。 */
  items: readonly WorkItem[];
  /** 收敛后的选择集（勾选顺序）。 */
  selectedIds: readonly string[];
  edit: WorkItemBulkEdit;
}): WorkItemBulkPlan {
  const plan: WorkItemBulkPlan = { targets: [], unchangedIds: [], precheckFailures: [] };
  if (resolveWorkItemBulkEdit(input.edit).kind !== "ok") return plan;
  const byId = new Map(input.items.map((item) => [item.id, item]));
  for (const id of input.selectedIds) {
    const item = byId.get(id);
    if (item === undefined) continue;
    const target = planBulkTarget(item, input.edit);
    if (target === null) continue;
    if (target.kind === "unchanged") plan.unchangedIds.push(id);
    else if (target.kind === "precheck") plan.precheckFailures.push(target.failure);
    else plan.targets.push({ id, title: item.title, patch: target.patch });
  }
  return plan;
}

/** 一行的一种结论：要写 / 同值不写 / 预检失败。 */
type WorkItemBulkRowPlan =
  | { kind: "write"; patch: WorkItemBulkPatch }
  | { kind: "unchanged" }
  | { kind: "precheck"; failure: WorkItemBulkPrecheckFailure };

function planBulkTarget(item: WorkItem, edit: WorkItemBulkEdit): WorkItemBulkRowPlan | null {
  if (edit.field === "labels") {
    const added = parseWorkItemLabels([edit.value]);
    if (added.kind !== "ok") return null; // 取值本身没归一化成功：`workItemBulkPlan` 已提前返回空计划
    const merged = parseWorkItemLabels([...item.labels, ...added.labels]);
    if (merged.kind === "too_many") {
      return {
        kind: "precheck",
        failure: {
          workItemId: item.id,
          title: item.title,
          messageId: WORK_ITEM_BULK_LABELS_TOO_MANY_MESSAGE_ID,
          values: { max: merged.max, count: merged.count },
        },
      };
    }
    if (merged.kind === "too_long") {
      return {
        kind: "precheck",
        failure: {
          workItemId: item.id,
          title: item.title,
          messageId: WORK_ITEM_BULK_LABELS_TOO_LONG_MESSAGE_ID,
          values: { max: merged.max },
        },
      };
    }
    return sameWorkItemLabels(merged.labels, item.labels)
      ? { kind: "unchanged" }
      : { kind: "write", patch: { labels: merged.labels } };
  }
  const parsed = parseWorkItemSurfaceFields({
    priority: edit.field === "priority" ? bulkPriorityInput(edit.value) : "",
    startDate: edit.field === "startDate" ? edit.value : "",
    dueDate: edit.field === "dueDate" ? edit.value : "",
  });
  if (parsed.kind !== "ok") return null;
  if (edit.field === "priority") {
    const priority = parsed.patch.priority;
    if ((item.priority ?? null) === priority) return { kind: "unchanged" };
    return { kind: "write", patch: { priority } };
  }
  if (edit.field === "startDate") {
    const startDate = parsed.patch.startDate;
    if ((item.startDate ?? null) === startDate) return { kind: "unchanged" };
    return { kind: "write", patch: { startDate } };
  }
  const dueDate = parsed.patch.dueDate;
  if ((item.dueDate ?? null) === dueDate) return { kind: "unchanged" };
  return { kind: "write", patch: { dueDate } };
}

/* ---------------- 执行（逐条、串行）与结果汇总（承重验收 1） ---------------- */

/**
 * 一条失败的**逐条**记录（绝不折成一个总数）。
 *
 * 三个字段各有来源：`workItemId` / `title` 指认是哪一行；`messageId` + `values` 是「为什么」的
 * 文案（走既有口径）；`detail` 是原始失败细节（仅未知失败带 —— 照页面的拼法一并显示，不吞错）。
 */
export type WorkItemBulkFailure = {
  workItemId: string;
  title: string;
  messageId: string;
  values?: Record<string, string | number>;
  detail?: string;
};

/**
 * 批量写的结果。
 *
 * `okCount` 的语义**显式**是「**目标值已就位**的项数」：写成功 + 本来就已是目标值的行
 * （后者没有写库，但也不需要写）。为什么不用「写成功的行数」：用户关心的是"这一批现在是不是
 * 都成了"，而在一片"本来就已是新值"的行上显示「成功 0 项」只会让人以为什么都没做。
 *
 * `failures` **是逐条的**（类型上没有"失败总数"这种字段）：需要总数时 `failures.length` 现算 ——
 * 存两个数迟早对不上，且"只汇报总数"正是承重验收要禁的形态。
 */
export type WorkItemBulkResult = {
  okCount: number;
  failures: WorkItemBulkFailure[];
};

/** 结果汇总那一行的文案键（`{ok}` / `{failed}`）—— R1 冻结键，本层只给 id。 */
export const WORK_ITEM_BULK_RESULT_MESSAGE_ID = "squad.workItems.bulk.result";

/**
 * 单条**写入口**的形状：页面传进来的就是那一条既有写路径
 * （`(target) => service.updateWorkItem(workspaceTarget, { id: target.id, patch: target.patch })`）。
 *
 * 返回 `Promise<unknown>`（不是 `Promise<void>`）：写入口的返回值不参与判据 ——
 * **成功 = 没有抛**（`updateWorkItem` 回的是服务回读的整条记录，界面不用它，一律以页面 reload
 * 之后的快照为准）。
 *
 * 为什么让页面**注入**而不是本层自己调服务：写路径只有页面一条（本层不 import 服务、不拼请求 ——
 * 与 `useWorkItemInlineEdit` / 行模块同一条纪律）；本层要钉住的只是「**怎么逐条调用它**」。
 */
export type WorkItemBulkWriter = (target: WorkItemBulkTarget) => Promise<unknown>;

/**
 * 逐条执行（**串行**）：一条失败**不中断**其余，全部试过之后逐条归拢结果。
 *
 * 四条口径：
 * ① **逐条 await**（不是 `Promise.all`）：界面上的逐条结果必须与请求次序一一对应，且服务面
 *    （单文件 SQLite 写事务）本来就是串行的 —— 并发只是把"谁先谁后"变成偶然；
 * ② **失败不中断**：前面几条已经写进去了，"整批中止"会让用户以为都没动；
 * ③ 预检失败（写之前就知道的，例如标签超上限）与写失败**同列**在 `failures` 里 — 它们对用户
 *    是同一件事（这条没成、为什么），分成两处迟早一处漏显示；
 * ④ **无乐观更新**：本函数只执行与归拢，成功之后由页面以服务回读刷新（本层不碰任何数据）。
 */
export async function executeWorkItemBulkEdit(input: {
  plan: WorkItemBulkPlan;
  write: WorkItemBulkWriter;
}): Promise<WorkItemBulkResult> {
  const { plan, write } = input;
  const failures: WorkItemBulkFailure[] = plan.precheckFailures.map((failure) => ({
    workItemId: failure.workItemId,
    title: failure.title,
    messageId: failure.messageId,
    ...(failure.values === undefined ? {} : { values: failure.values }),
  }));
  let okCount = plan.unchangedIds.length;
  for (const target of plan.targets) {
    try {
      await write(target);
      okCount += 1;
    } catch (error) {
      const feedback = squadEntryErrorFeedback(error);
      failures.push({
        workItemId: target.id,
        title: target.title,
        messageId: feedback.messageId,
        ...(feedback.detail === undefined ? {} : { detail: feedback.detail }),
      });
    }
  }
  return { okCount, failures };
}
