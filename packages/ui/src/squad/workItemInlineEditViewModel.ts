import type { WorkItemPriorityKey } from "@zcode/shared";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { writeDisabledReason } from "./workItemCollaborationViewModel.js";
import {
  WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS,
  parseWorkItemSurfaceFields,
  workItemSurfaceFieldErrorMessageId,
} from "./workItemPropertiesViewModel.js";

/* 工作项**行内编辑**（阶段一轮 D，T-P1-R4 的落点）的纯判据。

   为什么要独立成模块：行内编辑最容易漂移的不是控件，而是三个「不报错」的判据 ——
   ① 字段怎么归一化成 patch（标题 trim、空白拒、优先级空白 ⇒ 清回未设置）；
   ② 失败时说什么（哪一种坏法对应哪一句文案）；
   ③ 什么样的行根本不给编辑入口（归档）。
   这三件事写在 `renderRow` 里就等于不可测（本包没有渲染测试设施，见 squadEntryViewModel 的既定做法），
   而它们的坏法全都是静默的：比如把空标题写进库、或给归档行一个点了才失败的入口。

   本文件照本域惯例：不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**消息 id**）。
   与 shared 的分工：合法值判据（优先级闭集 / 日历日期）在 shared，本层只做「UI 取值 ↔ patch」的翻译。

   **接缝复用**（阶段一轮 C 冻结，本轮不得另起一份）：
   · 优先级的判据走 `parseWorkItemSurfaceFields`（空白 ⇒ 未设置、闭集外 ⇒ 指名）；
   · 优先级的失败文案走 `WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS`（同一个字段同一句话）。 */

/** 行内可编辑字段的**闭集**（阶段一轮 D 的首个试点：标题 + 优先级）。加字段 ⇒ 类型报错拖出全部消费点。 */
export type WorkItemInlineEditField = "title" | "priority";

/**
 * 行内编辑的 patch：**判别联合**，一次只改一个字段。
 *
 * 为什么不是「字段 + 值」的宽形状：形状直接就是服务面 `updateWorkItem` 白名单的子集，
 * 页面把它原样并进请求，**中间不再有一次字段名映射** —— 少一次映射就少一次
 * 「界面改 A、请求里发 B」的机会。判别联合还让「一次改两个字段」在类型上不可能。
 */
export type WorkItemInlineEditPatch = { title: string } | { priority: WorkItemPriorityKey | null };

/**
 * 归一化结论（照 `WorkItemLabelsParseResult` / `WorkItemSurfaceFieldsParseResult`：非 ok 必须**指名**）。
 * `value` 原样带回：失败文案里的 `{value}` 要说清是**哪个值**不对。
 */
export type WorkItemInlineEditResolution =
  | { kind: "ok"; patch: WorkItemInlineEditPatch }
  | { kind: "invalid"; field: WorkItemInlineEditField; value: string; messageId: string };

/** 标题的失败文案（档位/日期的失败文案用轮 C 的映射，见下面的优先级 resolver）。 */
export const WORK_ITEM_INLINE_TITLE_REQUIRED_MESSAGE_ID = "squad.workItems.titleRequired";

/**
 * 字段 → 失败文案 id 的**穷尽**映射（`Record<WorkItemInlineEditField, string>`：闭集加一枚字段
 * ⇒ 编译期在这里报缺失）。优先级那一项**引用**轮 C 的映射（不是抄一个同值的字符串：
 * 抄出来的那份与原文各自漂移时，同一件事会说出两句不同的话）。
 */
export const WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS: Record<WorkItemInlineEditField, string> = {
  title: WORK_ITEM_INLINE_TITLE_REQUIRED_MESSAGE_ID,
  priority: WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS.priority,
};

/**
 * 标题 → patch。`trim` 的取值口径与表单**同一个**（`WorkItemDialog` 提交时 `title.trim()`）：
 * 两处各写一遍，迟早一处 trim、一处不 trim，而「标题前后多个空格」这种事不会有人发现。
 *
 * 空白标题 ⇒ 非 ok：**不清行、不写库**，就地留下文案（照标签/表单的「拦在提交之前」姿态）。
 * 静默丢掉这次编辑（关闭编辑器）会让用户以为改成功了，而标题一个字都没变。
 */
export function resolveWorkItemInlineTitleEdit(text: string): WorkItemInlineEditResolution {
  const title = text.trim();
  if (title.length === 0) {
    return {
      kind: "invalid",
      field: "title",
      value: text,
      messageId: WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS.title,
    };
  }
  return { kind: "ok", patch: { title } };
}

/**
 * 优先级（行内 picker 的取原文）→ patch。
 *
 * 判据**单源**在轮 C 的 `parseWorkItemSurfaceFields`（空白 ⇒ 未设置、闭集外 ⇒ 指名是哪一项），
 * 本函数只做两件 UI 侧的事：把结论里的**这一项**取出来、把失败文案换成同一个字段的键。
 *
 * ⚠️ 产出的 patch **只取 priority**：那个函数的入参要凑齐三项（另外两项传空串 = 未设置），
 * 若把它的整体 patch 原样返回，行内改一次优先级就会把用户**没动过**的起始/截止日期清成空
 * —— 这是「行内编辑一次、别处数据丢了」的形态，而且不报错。
 */
export function resolveWorkItemInlinePriorityEdit(value: string): WorkItemInlineEditResolution {
  // picker 的「未设置」是哨兵值（见 WORK_ITEM_PRIORITY_CLEAR_VALUE）：先翻译回空串再交给判据，
  // 让 shared 那一份「空白 ⇒ 未设置」的口径保持是唯一的翻译点。
  const text = value === WORK_ITEM_PRIORITY_CLEAR_VALUE ? "" : value;
  const parsed = parseWorkItemSurfaceFields({ priority: text, startDate: "", dueDate: "" });
  if (parsed.kind !== "ok") {
    return {
      kind: "invalid",
      field: "priority",
      value: parsed.value,
      messageId: workItemSurfaceFieldErrorMessageId(parsed.field),
    };
  }
  return { kind: "ok", patch: { priority: parsed.patch.priority } };
}

/**
 * 标题输入框在**编辑态**里的键盘意图（**闭集**：加一种意图 ⇒ 类型报错拖出全部消费点）。
 * · `commit` = Enter（提交这次编辑）；`cancel` = Escape（恢复原值，不写库）；`ignore` = 不吃这个键。
 */
export type WorkItemInlineTitleKeyIntent = "commit" | "cancel" | "ignore";

/**
 * 编辑态按键 → 意图的**唯一判据**（T-P1-V 缺口 1 的补丁）。
 *
 * 为什么从 hook 里抽到本模块：IME 组合闸原先写在 `useWorkItemInlineEdit` 的
 * `handleTitleKeyDown` 里，而本包没有渲染测试设施 ⇒ 这条判据**零测试覆盖**（复验实测：
 * `isImeComposingKeyEvent` 在全部 test 目录引用数 0，M5「摘掉组合期早退块」整包不咬）。
 * 抽成纯函数后可以逐格钉：组合期（任一来源）一律 `ignore`、非组合期 Enter ⇒ commit、
 * Escape ⇒ cancel、其余键 ⇒ ignore —— 中文输入法的 Enter 是**候选确认**，不是提交，
 * 这条语义此前只有源码阅读担保。
 *
 * 组合判据仍走 `isImeComposingKeyEvent` 单源（不在这里再写一份 `isComposing` 或链）：
 * 两处各写一份的坏法是静默的 —— 一处认组合态、另一处不认，行为随调用路径漂移。
 */
export function resolveWorkItemInlineTitleKeyIntent(input: {
  key: string;
  compositionActive: boolean;
  isComposing?: boolean;
}): WorkItemInlineTitleKeyIntent {
  if (
    isImeComposingKeyEvent({
      compositionActive: input.compositionActive,
      isComposing: input.isComposing,
    })
  ) {
    return "ignore";
  }
  if (input.key === "Enter") return "commit";
  if (input.key === "Escape") return "cancel";
  return "ignore";
}

/**
 * 这一行**给不给**行内编辑入口：`null` = 给；非 null = 不可用的原因文案 id（归档行不给）。
 *
 * 判据**复用**详情写面的 `writeDisabledReason`（只换面名）：归档 = 只读是本仓一条全局口径，
 * 各面各写一份 `archivedAt !== undefined` 迟早在某一面漏掉一格 —— 而漏掉的表现是
 * 「入口亮着、点了必失败」，不报错。
 *
 * `refreshFailure` 传 `null`：看板不是取数面（取数失败由页面的状态横幅表达），
 * 这里要回答的只有「这一行能不能改」。
 */
export function workItemInlineEditUnavailableReason(workItem: {
  archivedAt?: number;
}): string | null {
  return writeDisabledReason("inlineEdit", workItem, null);
}

/**
 * 行内 picker 里「未设置」那一项的取值：**哨兵值**（`null` 才是领域里的「清回未设置」）。
 *
 * 为什么不是空串：@radix-ui 的下拉/选择把空串保留给「没有选中」的 placeholder
 * （`<Select.Item value="">` 会**直接抛**），所以 UI 取值域里的「未设置」必须有一个非空取值。
 * 它只活在 UI 侧：patch 里是 `null`（服务面把 `null` 读成「清回未设置」）。
 */
export const WORK_ITEM_PRIORITY_CLEAR_VALUE = "__unset__";

/** 领域值 → picker 取值（`undefined` / `null` ⇒ 哨兵）。 */
export function workItemInlinePrioritySelectValue(
  priority: WorkItemPriorityKey | null | undefined,
): string {
  return priority ?? WORK_ITEM_PRIORITY_CLEAR_VALUE;
}

/**
 * 这次提交**有没有真的改动**（同值提交不写库）。
 *
 * 为什么需要它：blur 就是提交 —— 点进标题、改主意、点走，会走到提交路径；不判同值就等于
 * 「每次路过都写一次库 + 整页重载」，而这类写入在日志里看起来与真实修改一模一样。
 * 只比**被编辑的那一个字段**：拿整条条目去比，改优先级会被标题的差异干扰（反之亦然）。
 */
export function workItemInlineEditUnchanged(
  item: { title: string; priority?: WorkItemPriorityKey },
  patch: WorkItemInlineEditPatch,
): boolean {
  if ("title" in patch) return patch.title === item.title;
  return (item.priority ?? null) === patch.priority;
}
