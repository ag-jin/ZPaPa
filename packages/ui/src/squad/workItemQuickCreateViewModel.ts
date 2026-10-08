import type { WorkItem } from "@zcode/shared";
import type { CreateWorkItemRequest } from "@zcode/services";
import {
  squadEntryErrorFeedback,
  WORK_ITEM_USER_ASSIGNEE_ID,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";

/* 「快速创建」（阶段三 · T-P3-R1）的**默认值判据**：视图顶部「输入标题即建」，
   必填仅标题，其余默认；写路径只有一条（宿主注入的 `createWorkItem` 单源）。

   为什么判据放在纯函数层（不是为了好看）：本包没有渲染测试设施，判据写进组件就等于不可测
   （照 `workItemsViewModel` / `workItemSurfaceViewModel` 的既定做法）；而这里的坏法全是**静默**的
   —— 默认值里顺手填一个 `priority: "medium"`（替用户编一个没人决定过的选择，服务面把
   「不传这个键」读成未设置）、哨兵值被当成父项 id 发出去（库里多一条指向 `"__none__"` 的行）、
   纯空格的标题也能建出空标题行。三处都不报错，只有逐格钉住才看得见。

   本文件不 import React、不 import UI 原语，也不碰服务实现（只取 `CreateWorkItemRequest` 类型）。 */

/**
 * 父项下拉的「不选」取值（**UI 取值域的哨兵**，不是领域值）。
 *
 * 为什么需要哨兵：@radix-ui 的下拉把空串保留给「没有选中」的 placeholder
 * （`<SelectItem value="">` 会**直接抛**，与 `WORK_ITEM_PRIORITY_CLEAR_VALUE` 同款理由
 * 见 `workItemInlineEditViewModel`），所以「不挂父项」在 UI 取值域里必须有一个非空取值。
 * 它只活在 UI 侧：请求里是 `parentId: undefined`（= 不传这个键）。
 *
 * 与对话框 `WorkItemDialog` 里的同名哨兵（`SquadCreateDialogs.tsx` 的 `NO_PARENT_VALUE`）
 * 是**两处取值域各自的一份**：两者都活在各自组件的会话内状态里、都不入库、都不出现在请求里
 * （请求里只有 `undefined` 或真实的 `workItem.id`），因此不构成「同一语义两处判据」——
 * 但**不得**把它写进任何请求或落盘路径。
 */
export const WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE = "__none__";

/**
 * 快速创建的请求形状 = **服务面唯一创建入口的入参**（类型从 `CreateWorkItemRequest` 单源转出）。
 *
 * 为什么要转出：消费方（组件）不必为了一个类型去 import `@zcode/services` —— 类型可达性本身就是
 * 一种弱依赖，转出后「组件不碰服务面」在源码层是可断言的（见 `workItemQuickCreate.test.ts` 的守卫）。
 */
export type WorkItemQuickCreateRequest = CreateWorkItemRequest;

/** 快速创建的**标题归一化**（唯一一处 trim）：空白 = 没填。 */
export function workItemQuickCreateTitle(title: string): string {
  return title.trim();
}

/**
 * 父项下拉**当前选中项**的显示（触发器上那行字）—— 三种情形**分开**，不合并成一个字符串。
 *
 * 为什么要单独判据：`missing` 这一格是静默的误报源头 —— 草稿里选着一个父项 id，而快照回读后
 * 那个父项不在了（被归档 / 别处删掉），若显示回落成「无（顶层）」，用户会以为"没挂父项"，
 * 而请求里**仍然带着那个 id**（服务面照旧把它挂上去，或响亮拒绝）。所以显示必须与
 * 「请求里会发生什么」一致：选中了 id ⇒ 显示那个 id（哪怕只剩 id 可显示），绝不显示成"无"。
 *
 * 渲染层按 `kind` 取文案（`none` → `squad.common.parent.none`，`item` → 快照标题，
 * `missing` → 原样 id，与 `resolveAssigneeName` 的未知 id 回落同款）。
 */
export type WorkItemQuickCreateParentDisplay =
  | { kind: "none" }
  | { kind: "item"; title: string }
  | { kind: "missing"; id: string };

export function workItemQuickCreateParentDisplay(
  workItems: readonly Pick<WorkItem, "id" | "title">[],
  parentValue: string,
): WorkItemQuickCreateParentDisplay {
  if (parentValue === WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE) return { kind: "none" };
  const item = workItems.find((candidate) => candidate.id === parentValue);
  return item === undefined
    ? { kind: "missing", id: parentValue }
    : { kind: "item", title: item.title };
}

/**
 * 快速创建表单的**草稿**（会话内状态，只有这两个字段）。
 *
 * 为什么草稿里**没有**列表 / 行 / 新工作项：成功之后要显示的那一条必须来自**服务回读**
 * （宿主 `reload()` → 快照 → 页面投影），草稿里若能塞进"刚建的那条"，界面就会在服务还没
 * 回读之前先说"它存在了"（乐观插入）—— 服务若把它写成别的样子（序号、位置、时间戳），
 * 界面显示的就是一个没人确认过的形状。类型上不给这个位置，比注释里禁止更硬。
 */
export type WorkItemQuickCreateDraft = { title: string; parentValue: string };

/** 空草稿（默认父项 = 不挂父项）。 */
export function workItemQuickCreateEmptyDraft(): WorkItemQuickCreateDraft {
  return { title: "", parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE };
}

/** 父项取值 → `CreateWorkItemRequest.parentId`：哨兵 ⇒ `undefined`（不传这个键）。 */
export function workItemQuickCreateParentId(parentValue: string): string | undefined {
  return parentValue === WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE ? undefined : parentValue;
}

/**
 * 快速创建的请求（**默认值判据的唯一实现**）。
 *
 * 三条口径：
 * 1. **必填仅标题** —— 其余字段一律走服务面的缺省语义（`undefined` = 未设置 / 空），
 *    不在这里造默认值：`priority` 填一个档位就是替用户决定，`labels: []` / `body: ""` 虽等价于
 *    缺省，但会让人以为表单收集过这些字段。
 * 2. **指派 = 本机用户**（`{type:"user", id: WORK_ITEM_USER_ASSIGNEE_ID}`，与对话框
 *    `WorkItemDialog` 的「指派给」初值同源）：快速创建建出的是一条**未派发**的工作项
 *    （指派给小队/智能体 = 新派发，那是服务面 `createWorkItem` 的组装语义，不在快速路径里
 *    替用户选）。身份 id 的常量来自 `squadEntryViewModel`（单源），不另抄字面量。
 * 3. **父项**：选了就原样传 `workItem.id`（是否合法、深度与子项上限是**服务面**的判据 ——
 *    这里不预判、不筛候选）；没选就**不传这个键**。
 */
export function workItemQuickCreateRequest(
  input: WorkItemQuickCreateDraft,
): WorkItemQuickCreateRequest {
  return {
    title: workItemQuickCreateTitle(input.title),
    parentId: workItemQuickCreateParentId(input.parentValue),
    assignee: { type: "user", id: WORK_ITEM_USER_ASSIGNEE_ID },
  };
}

/**
 * 提交钮**可点吗**：标题非空白 且 写面可用 且 没有别的写动作在飞。
 *
 * · 「标题非空白」与请求里那条 trim 走**同一个**归一化（两处各写一份就会漂移：一边让纯空格过、
 *   一边发出空标题）；
 * · `createEnabled` 由宿主经 `workItemCreateEnabled`（本域既有判据）传入 —— 无工作区目标 /
 *   快照未就绪 ⇒ 置灰（「点得开但通往死路」比置灰更糟）；
 * · `busy` = 有写动作在飞（页面的 `busyWorkItemId`）：一次只写一条，重复点不该建出两条。
 */
export function workItemQuickCreateSubmittable(input: {
  title: string;
  createEnabled: boolean;
  busy: boolean;
}): boolean {
  if (!input.createEnabled || input.busy) return false;
  return workItemQuickCreateTitle(input.title).length > 0;
}

/**
 * 一次提交的结论 → 表单草稿的**下一步**（验收 2「失败就地原因 + 保留输入」的唯一判据）。
 *
 * · 成功（`feedback === null`，即接线层写完并**已回读**）：清标题、**保留父项** —— 清标题
 *   才能接着敲下一条（连续创建），保留父项才能在同一个批根下连建多条成员而不用每次重选；
 * · 失败：草稿**原样返回**（含未 trim 的原文）—— 用户重试时不用重打一遍，原因由 feedback
 *   就地显示（不吞错）。
 *
 * 为什么这条也放进纯函数：它决定"用户看得见的输入还在不在"，而组件里写就成了不可测的分支；
 * 且"失败时顺手清空"这类坏法**不报错**，只有逐格钉住才看得见。
 */
export function workItemQuickCreateDraftAfterSubmit(input: {
  draft: WorkItemQuickCreateDraft;
  feedback: SquadEntryFeedback | null;
}): WorkItemQuickCreateDraft {
  if (input.feedback !== null) return input.draft;
  return { title: "", parentValue: input.draft.parentValue };
}

/**
 * 快速创建的一次**执行编排**（注入依赖，可被 node:test 用假实现逐格钉住）：
 * **唯一写入口 → 成功才服务回读 → 结论（`null` = 成功，否则是可就地显示的原因）**。
 *
 * 三条纪律（对应验收 1/2/3）：
 * 1. **无乐观插入**：`reload` 只在 `create` 成功之后调 —— 界面上出现的那一行只能来自
 *    服务回读后的快照投影；本函数的返回值**不携带任何行**（类型上就没有可冒充事实的形状）。
 * 2. **失败不吞**：服务面的拒绝原样翻成 `SquadEntryFeedback`（`detail` = 原始错误消息，
 *    深度 / 子项上限 / 门禁关闭都照实带出，不预判、不改写成"未知错误"）。
 * 3. **失败不回读**：什么都没变就不去回读（不是省一次请求，而是"回读"这个动作本身在说
 *    "刚刚写成了"—— 在失败分支上做它会把这句话说成假话）。
 *
 * 依赖注入（照 `executeSquadDiscard` 的先例）：本函数不 import 服务、不读 store、不碰 React；
 * 真实接线层注入 `createWorkItem` 单源调用与页面的 `reload`（后者按实现不 reject，见其 try/catch）。
 */
export async function executeWorkItemQuickCreate(input: {
  request: WorkItemQuickCreateRequest;
  /** 唯一写路径（接线层：`resolveSquadRuntimeService(services).createWorkItem(target, request)`）。 */
  create: (request: WorkItemQuickCreateRequest) => Promise<unknown>;
  /** 服务回读（接线层：页面的 `reload`）—— **成功后才调**。 */
  reload: () => Promise<void>;
}): Promise<SquadEntryFeedback | null> {
  try {
    await input.create(input.request);
  } catch (error) {
    return squadEntryErrorFeedback(error);
  }
  await input.reload();
  return null;
}
