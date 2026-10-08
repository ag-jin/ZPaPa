import {
  WORK_ITEM_PRIORITY_KEYS,
  resolveWorkItemDateOnly,
  resolveWorkItemPriority,
  type WorkItemCreator,
  type WorkItemCreatorKind,
  type WorkItemPriorityKey,
} from "@zcode/shared";

/* 工作项 Surface 新字段（优先级 / 起始-截止日期 / 创建人 / identifier）在 **UI 面的呈现判据**
   （阶段一 · 轮 C，T-P1-R3 的落点）。

   为什么要独立成模块：这些字段的呈现判据（identifier 文本怎么拼、优先级文案映射、日期的
   逐字透传、表单输入怎么归一化）如果写在组件里，就等于不可测 —— 而它们全都是**闭集/形状**
   判据（闭集漏一个值、日期被换算一次，都只在界面上才现形，且不报错）。照本域既定做法
   （`workItemsViewModel` / `workItemPullRequestsViewModel`）：本文件不 import React、不 import
   UI 原语、不碰 i18n 文案正文（只给**消息 id**：文案正文属于 locales，判据属于这里）。

   与 shared 的分工：闭集本身（`WORK_ITEM_PRIORITY_KEYS`）、合法日期（`isWorkItemDateOnly`）与
   归一化（`resolveWorkItemPriority` / `resolveWorkItemDateOnly`）**都在 shared**（两个写入口
   共用同一份，UI 不得复制第二份）。这里只加「UI 怎么显示 / 表单怎么取值」。 */

/**
 * identifier 展示文本的**前缀常量**（用户裁定 Q6：前缀**不入库**，DB 只存整数序号；
 * 展示文本由 UI 单源纯函数生成）。
 *
 * 为什么是常量而不是 workspace 派生 / 入库：前缀入库要新增 workspace 级配置与迁移面，
 * 本阶段不需要；形态可后续单独裁定 —— 到那时**只改这一处**，展示面全跟着走。
 */
export const WORK_ITEM_IDENTIFIER_PREFIX = "#";

/**
 * identifier 的展示文本：`#<序号>`；未设置（`undefined` / `null`）⇒ `null`。
 *
 * 返回 `null` 而不是空串：调用方据此**整块不渲染**（空行是噪音，与「未设置」不是同一件事）。
 * 入参是**整数序号**（`identifierSeq`），不是格式化后的字符串 —— 前缀不在库里，此处是唯一
 * 拼接点；反过来，任何「从字符串里再解析出序号」的写法都没有必要（也没有第二个来源）。
 */
export function workItemIdentifierText(seq: number | null | undefined): string | null {
  if (seq === null || seq === undefined) return null;
  return `${WORK_ITEM_IDENTIFIER_PREFIX}${seq}`;
}

/** 优先级 → 文案 id 的**穷尽**映射（`Record<WorkItemPriorityKey, string>`：闭集加一枚键
    ⇒ 编译期在这里报缺失，而不是界面上多出一个裸 key）。文案正文在 locales（两语成对）。 */
export const WORK_ITEM_PRIORITY_MESSAGE_IDS: Record<WorkItemPriorityKey, string> = {
  urgent: "squad.workItems.priority.urgent",
  high: "squad.workItems.priority.high",
  medium: "squad.workItems.priority.medium",
  low: "squad.workItems.priority.low",
};

/** 优先级键是否属于闭集（消费外来值时的守卫；闭集**只有一份**定义在 shared）。 */
export function isWorkItemPriorityKey(value: string): value is WorkItemPriorityKey {
  return (WORK_ITEM_PRIORITY_KEYS as readonly string[]).includes(value);
}

/**
 * 任意外来优先级值（RPC / 库读回 / 旧数据）⇒ 文案 id；不在闭集内 ⇒ `null`（调用方不渲染
 * 徽标，也不显示一个看不懂的裸 key）。**不猜**：看不懂就当未设置是呈现层的既定姿态
 * （写入口才响亮拒 —— 展示一个陌生标签只会让人以为这是个合法档位）。
 */
export function workItemPriorityMessageId(priority: unknown): string | null {
  if (typeof priority !== "string" || !isWorkItemPriorityKey(priority)) return null;
  return WORK_ITEM_PRIORITY_MESSAGE_IDS[priority];
}

/**
 * 日历日期的**呈现文本**：逐字原样返回，**不做任何时刻换算**（用户裁定 Q5：`YYYY-MM-DD`
 * 是日历日期，不是时刻 —— `new Date("2026-10-08")` 按 UTC 解析，在 UTC 以西的时区读回会
 * **差一天**，且这个差是静默的）。
 *
 * 空串 / 纯空白 ⇒ `null`（未设置）：展示层不把空串渲染成一个空行。trim 只用于**判别是否为空**，
 * 返回的是**原值本身**（不规整用户的写法 —— 规整是写入口的事，读出来什么样就显示什么样）。
 */
export function workItemDateText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().length === 0 ? null : value;
}

/** 创建人种类 → 文案 id 的**穷尽**映射（`Record<WorkItemCreatorKind, string>`：actor 词汇加一枚
    种类 ⇒ 编译期报缺失）。种类与评论/活动的 actor 词汇**同一套**（`human | agent | system`）。 */
export const WORK_ITEM_CREATOR_KIND_MESSAGE_IDS: Record<WorkItemCreatorKind, string> = {
  human: "squad.workItems.creator.human",
  agent: "squad.workItems.creator.agent",
  system: "squad.workItems.creator.system",
};

export function workItemCreatorKindMessageId(kind: WorkItemCreatorKind): string {
  return WORK_ITEM_CREATOR_KIND_MESSAGE_IDS[kind];
}

/**
 * 创建人的**显示文本**：有留痕的 `displayName` 就用它，否则回落 `id`（actor 的既定口径：
 * 未知名字回落 id，不显示空白）；`undefined` / `null`（存量行没有这个事实）⇒ `null`。
 *
 * **不编造**：没有创建人时既不给「未知」也不给「系统」——那会让「没人记录过」读成
 * 「系统创建的」，是一条假的审计事实（与 `creator_*` 回填 NULL 同一条纪律）。
 */
export function workItemCreatorText(creator: WorkItemCreator | null | undefined): string | null {
  if (creator === null || creator === undefined) return null;
  const displayName = creator.displayName?.trim();
  return displayName !== undefined && displayName.length > 0 ? displayName : creator.id;
}

/** 表单里可编辑的三个 Surface 字段（**闭集**：加字段 ⇒ 类型报错拖出所有消费点）。 */
export type WorkItemSurfaceFieldKey = "priority" | "startDate" | "dueDate";

/** 表单三项的**输入原文**（`""` / 纯空白 = 未设置 —— 与「没提这个字段」不是同一件事）。 */
export type WorkItemSurfaceFieldInput = {
  priority: string;
  startDate: string;
  dueDate: string;
};

/** 归一化后的写入形状：`null` = 未设置 / 清空（服务面把 `null` 读成「设成空」，`undefined` 才是「没提」）。 */
export type WorkItemSurfaceFieldPatch = {
  priority: WorkItemPriorityKey | null;
  startDate: string | null;
  dueDate: string | null;
};

/** 表单预检的**结论**（判别联合，照 `WorkItemLabelsParseResult`：非 ok 必须**指名**是哪个字段）。 */
export type WorkItemSurfaceFieldsParseResult =
  | { kind: "ok"; patch: WorkItemSurfaceFieldPatch }
  | { kind: "invalid"; field: WorkItemSurfaceFieldKey; value: string };

/** 字段 → 错误文案 id 的穷尽映射（文案正文在 locales，两语成对）。 */
export const WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS: Record<WorkItemSurfaceFieldKey, string> = {
  priority: "squad.workItems.priorityInvalid",
  startDate: "squad.workItems.startDateInvalid",
  dueDate: "squad.workItems.dueDateInvalid",
};

export function workItemSurfaceFieldErrorMessageId(field: WorkItemSurfaceFieldKey): string {
  return WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS[field];
}

/** 空白 ⇒ 未设置；否则原文（trim 后的取值）。 */
function surfaceFieldText(value: string): string | null {
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/**
 * 表单三项归一化：**判据单源在 shared**（`resolveWorkItemPriority` / `resolveWorkItemDateOnly`），
 * 本函数只做「空白 ⇒ 未设置」与「哪一项坏了 ⇒ 指名」这两件 UI 侧的事。
 *
 * 为什么空白不能直接丢给 shared：`""` 不是合法值（shared 会响亮判 `invalid`），而表单里
 * 用户把输入框清空表达的正是「清掉这一项」——这一层翻译属于 UI 的取值口径，不属于数据判据。
 * 反过来，**trim 只用于取值**：`"2026-02-30"` 这类坏值原样交给 shared 判，本层不猜、不折算。
 *
 * 次序固定（priority → startDate → dueDate）：三处同时坏时给同一句结论，用户改一处再看到下一处
 * —— 与「随机指一个」相比，行为可复现、可测。
 */
export function parseWorkItemSurfaceFields(
  input: WorkItemSurfaceFieldInput,
): WorkItemSurfaceFieldsParseResult {
  const priorityText = surfaceFieldText(input.priority);
  const priority = resolveWorkItemPriority(priorityText);
  if (priority.kind !== "ok") {
    return { kind: "invalid", field: "priority", value: priority.value };
  }
  const startDate = resolveWorkItemDateOnly(surfaceFieldText(input.startDate));
  if (startDate.kind !== "ok") {
    return { kind: "invalid", field: "startDate", value: startDate.value };
  }
  const dueDate = resolveWorkItemDateOnly(surfaceFieldText(input.dueDate));
  if (dueDate.kind !== "ok") {
    return { kind: "invalid", field: "dueDate", value: dueDate.value };
  }
  return {
    kind: "ok",
    patch: { priority: priority.priority, startDate: startDate.date, dueDate: dueDate.date },
  };
}
