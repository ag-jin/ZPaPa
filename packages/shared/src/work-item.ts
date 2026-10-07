import { z } from "zod";

/** 工作项生命周期：4 category / 6 键。category 才是机器判定依据，键只是标签。 */
export const WORK_ITEM_STATUS_KEYS = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type WorkItemStatusKey = (typeof WORK_ITEM_STATUS_KEYS)[number];

export type WorkItemStatusCategory = "unstarted" | "started" | "done" | "closed";

export const WORK_ITEM_STATUS_CATEGORY: Record<WorkItemStatusKey, WorkItemStatusCategory> = {
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

/** 终态：done 与 closed 两类。聚合判定（如 children_done）必须用它，不要比较键名。 */
export function isTerminalWorkItemStatus(key: WorkItemStatusKey): boolean {
  const category = WORK_ITEM_STATUS_CATEGORY[key];
  return category === "done" || category === "closed";
}

export const WORK_ITEM_MAX_DEPTH = 5;
export const WORK_ITEM_MAX_CHILDREN = 50;

/** 工作项标签的条数上限（#11 v1）。上限**不是**静默截断：超限由 `parseWorkItemLabels` 响亮报出。 */
export const WORK_ITEM_LABEL_MAX_COUNT = 10;
/** 工作项标签单条长度上限（同样响亮报出）。长度按 **trim 之后**的值算 —— trim 是解析的一部分。 */
export const WORK_ITEM_LABEL_MAX_LENGTH = 32;

/**
 * 标签输入的**解析结论**（判别联合）。为什么不是 `string[]`：
 * 超限时把「为什么没收下」压成一个空数组 / 截断后的数组，界面只能猜（或者显示"成功了"）——
 * 而「提交 11 个标签、界面只显示 10 个」正是要避免的静默半截写入。让调用方**必须**命名一种结论。
 */
export type WorkItemLabelsParseResult =
  | { kind: "ok"; labels: string[] }
  | { kind: "too_many"; max: number; count: number }
  | { kind: "too_long"; max: number; value: string };

/**
 * 把用户输入的标签原文**归一化**成入库形状（#11 v1 的唯一判据，纯函数、无 i18n、无 Node 依赖）。
 *
 * 两个写入口（建项 / 编辑）与表单预检都调它：三处各写一遍「怎么切、怎么去重、上限多少」
 * 迟早分叉，而分叉的表现是「表单说没问题、写入口拒绝」或反过来 —— 两处都不报错。
 *
 * 规则（逐条可验收）：
 * · 按 `,` 与换行切分 → `trim` → 丢空串；
 * · 去重**保序**（首次出现为准）—— 输出次序是用户的书写次序，不排序（重排会让看板 chip 抖动）；
 * · **大小写敏感、不折叠**：`Bug` 与 `bug` 是两个标签（折叠等于替用户改数据，且原始大小写不可逆）；
 * · 条数上限 `WORK_ITEM_LABEL_MAX_COUNT`、单条长度上限 `WORK_ITEM_LABEL_MAX_LENGTH`，超限**响亮**
 *   返回 `too_many` / `too_long`（**不静默截断**）；去重发生在计数**之前**（重复输入不占额度）；
 * · 两种超限同时命中时 `too_many` 优先（条数是先被看清的事实，且同一份输入永远给同一结论）。
 *
 * 入参是 `readonly string[]`（表单可能按行给、也可能把整段给一个元素）：每一项都参与切分，
 * 顺序即书写顺序。本函数**不**写库、不做第二份存储格式（`labels` 仍是 JSON 文本列）。
 */
export function parseWorkItemLabels(raw: readonly string[]): WorkItemLabelsParseResult {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const chunk of raw) {
    for (const piece of chunk.split(/[,\n]/)) {
      const value = piece.trim();
      if (value.length === 0) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      labels.push(value);
    }
  }
  if (labels.length > WORK_ITEM_LABEL_MAX_COUNT) {
    return { kind: "too_many", max: WORK_ITEM_LABEL_MAX_COUNT, count: labels.length };
  }
  for (const value of labels) {
    if (value.length > WORK_ITEM_LABEL_MAX_LENGTH) {
      return { kind: "too_long", max: WORK_ITEM_LABEL_MAX_LENGTH, value };
    }
  }
  return { kind: "ok", labels };
}

/**
 * 非 ok 的解析结论 ⇒ **一条**响亮错误文本（两个写入口共用同一句话）。
 *
 * 为什么文本也收在这里：解析规则在 shared（唯一判据），而两个写入口（建项 / 编辑）位于
 * `workItemService` 与 `squadRuntimeService` —— 后者必须**浏览器安全**（值导出到根入口，
 * 不得值导入 `node:crypto` 所在的 workItemService），所以两处无法共享一份本地常量。
 * 若各自写一句话，用户看到的「为什么没收下」会随写入口漂移，且漂移不报错。
 * **抛出**仍然发生在各自的写入口：错误契约属于写者，本函数只产出文本。
 */
export function workItemLabelsErrorMessage(
  failure: Exclude<WorkItemLabelsParseResult, { kind: "ok" }>,
): string {
  if (failure.kind === "too_many") {
    return (
      `工作项标签超过条数上限 ${failure.max}（给了 ${failure.count} 条）：拒绝半截写入 —— ` +
      "静默截断会让用户以为全部写进去了。"
    );
  }
  return (
    `工作项标签「${failure.value}」超过单条长度上限 ${failure.max}：拒绝半截写入 —— ` +
    "静默截断会让用户以为全部写进去了。"
  );
}

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_KEYS);

export const workItemAssigneeSchema = z.object({
  type: z.enum(["user", "agent", "squad"]),
  id: z.string().min(1),
});

export const workItemSchema = z.object({
  id: z.string().min(1),
  workspaceIdentity: z.string().min(1),
  workspacePath: z.string().min(1),
  parentId: z.string().min(1).optional(),
  stage: z.number().int().nonnegative().optional(),
  title: z.string(),
  body: z.string(),
  status: workItemStatusSchema,
  assignee: workItemAssigneeSchema,
  labels: z.array(z.string()).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  position: z.number().default(0),
  archivedAt: z.number().int().nonnegative().optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
