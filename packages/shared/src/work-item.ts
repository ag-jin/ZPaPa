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

/* ---------------- Surface 对齐（0018）：优先级 / 日期 / 创建人 ---------------- */

/**
 * 工作项优先级**闭集**（用户裁定 Q4，2026-10-08）：`urgent / high / medium / low`。
 *
 * 为什么是闭集而不是自由文本：阶段二必须在 list/table 上**排序与过滤**，可比序要求取值可枚举。
 * 为什么 `NULL`（领域模型里 `undefined`）= **未设置**且**不设**一个显式 `none` 键：
 * 「没人定过优先级」与「有人明确选了某一档」是两件事，揉成一态会让过滤/排序替用户编事实。
 */
export const WORK_ITEM_PRIORITY_KEYS = ["urgent", "high", "medium", "low"] as const;
export type WorkItemPriorityKey = (typeof WORK_ITEM_PRIORITY_KEYS)[number];

/**
 * 优先级**排序位次**（越紧急越小）。`Record<…>` 是**穷尽**的：闭集加一枚键 ⇒ 编译期在这里报缺失
 * （与 `WORK_ITEM_STATUS_CATEGORY` 同款纪律；数组式顺序表加键不会报错，只会静默漏排）。
 */
export const WORK_ITEM_PRIORITY_RANK: Record<WorkItemPriorityKey, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * 未设置**没有**位次（`null`）：「未设置排在最前还是最后」是消费方的呈现决定，本层不编造默认位次
 * ——编了就会有一个谁也说不清的默认值被排序悄悄用上。
 */
export function resolveWorkItemPriorityRank(
  priority: WorkItemPriorityKey | null | undefined,
): number | null {
  return priority === null || priority === undefined ? null : WORK_ITEM_PRIORITY_RANK[priority];
}

/** 优先级输入的**解析结论**（判别联合，与 `WorkItemLabelsParseResult` 同款：让调用方必须命名一种结论）。 */
export type WorkItemPriorityResolveResult =
  | { kind: "ok"; priority: WorkItemPriorityKey | null }
  | { kind: "invalid"; value: string };

/**
 * 把**任意外来值**（RPC / 表单 / 库读回）归一化成入库形状：闭集内原样收下，未设置（`undefined`/`null`）
 * 给 `null`，其余一律 `invalid`（**响亮**）——「看不懂就当未设置」会让用户明确选过的值无声消失。
 *
 * 纯函数、无 i18n、无 Node 依赖：两个写入口（建项 / 编辑）共用它，不各写一份校验。
 * **不抛**（抛在写入口，错误契约属于写者），与 `parseWorkItemLabels` 同一条纪律。
 */
export function resolveWorkItemPriority(raw: unknown): WorkItemPriorityResolveResult {
  if (raw === null || raw === undefined) return { kind: "ok", priority: null };
  if (typeof raw === "string" && (WORK_ITEM_PRIORITY_KEYS as readonly string[]).includes(raw)) {
    return { kind: "ok", priority: raw as WorkItemPriorityKey };
  }
  return { kind: "invalid", value: typeof raw === "string" ? raw : String(raw) };
}

/** 非 ok 的优先级解析结论 ⇒ **一条**响亮错误文本（两个写入口共用同一句话，照 `workItemLabelsErrorMessage`）。 */
export function workItemPriorityErrorMessage(
  failure: Exclude<WorkItemPriorityResolveResult, { kind: "ok" }>,
): string {
  return (
    `工作项优先级「${failure.value}」不在闭集内（${WORK_ITEM_PRIORITY_KEYS.join(" / ")}，` +
    "留空 = 未设置）：拒绝静默折算 —— 把看不懂的值当未设置会让用户的选择凭空消失。"
  );
}

export const workItemPrioritySchema = z.enum(WORK_ITEM_PRIORITY_KEYS);

/**
 * 日历日期（起始 / 截止）的**唯一形状**（用户裁定 Q5）：`YYYY-MM-DD`，**不是时刻**。
 *
 * 为什么不用 `INTEGER` 毫秒（与 `created_at/updated_at` 同族的备选）：起始/截止的语义是
 * 「用户选了哪一天」。存成时刻就必须回答「哪一天的零点、哪个时区」——跨时区/跨设备读回会差一天，
 * 且这个差是**静默**的。TEXT 形态天然无时区、字典序 = 时间序，排序与过滤直接可比。
 */
const WORK_ITEM_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 格里高利历闰年判据（独立于任何时刻库：`Date` 的月份/时区语义在这里只会添乱）。 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * 日期字符串是否**既合形状又真实存在**：正则只管形状，天数按月/闰年核对
 * （`2026-02-29`、`2026-04-31` 正则都放行，但它们不是日期）。纯字符串判定，**不做**任何时刻换算。
 */
export function isWorkItemDateOnly(value: string): boolean {
  if (!WORK_ITEM_DATE_ONLY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  // 月天数表按下标取；越界下标不可达（month 已限 1..12），真出现时按非法日期拒（不编天数）。
  const daysInMonth = DAYS_IN_MONTH[month - 1];
  if (daysInMonth === undefined) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : daysInMonth;
  return day <= maxDay;
}

/** 日期的**解析结论**（判别联合，同 `WorkItemPriorityResolveResult` 的纪律）。 */
export type WorkItemDateResolveResult =
  | { kind: "ok"; date: string | null }
  | { kind: "invalid"; value: string };

/**
 * 归一化外来日期值：合法 ⇒ 原样收下（**逐字**透传，不做时区/格式规整），`undefined`/`null` ⇒ 未设置，
 * 其余 ⇒ `invalid`（响亮）。两个写入口共用；**不抛**（抛在写入口）。
 */
export function resolveWorkItemDateOnly(raw: unknown): WorkItemDateResolveResult {
  if (raw === null || raw === undefined) return { kind: "ok", date: null };
  if (typeof raw === "string" && isWorkItemDateOnly(raw)) return { kind: "ok", date: raw };
  return { kind: "invalid", value: typeof raw === "string" ? raw : String(raw) };
}

/** 非 ok 的日期解析结论 ⇒ **一条**响亮错误文本（两个写入口共用同一句话）。 */
export function workItemDateErrorMessage(
  failure: Exclude<WorkItemDateResolveResult, { kind: "ok" }>,
): string {
  return (
    `工作项日期「${failure.value}」不是合法日历日期（形状 YYYY-MM-DD，且必须是真实存在的一天）：` +
    "拒绝静默落成未设置 —— 不存在的日期进了库，只会在排序/展示时才现形。"
  );
}

export const workItemDateOnlySchema = z.string().refine(isWorkItemDateOnly, {
  message: "工作项日期必须是 YYYY-MM-DD 的真实日历日期",
});

/**
 * 创建人（`creator_kind` / `creator_id` / `creator_display_name` 三列的领域形状）。
 *
 * 为什么复用作协域 actor 词汇 `human | agent | system`：创建人与评论/活动的「谁」是同一件事
 * （审计事实「谁做的」）。为什么**不**复用 `assignee` 的 `user | agent | squad`：创建人是
 * 「谁按下了创建」，指派是「派给谁」——**两件事**，拿 assignee 冒充创建人会伪造历史
 * （存量行没有这个事实时留 NULL，不编）。
 */
export const WORK_ITEM_CREATOR_KINDS = ["human", "agent", "system"] as const;
export type WorkItemCreatorKind = (typeof WORK_ITEM_CREATOR_KINDS)[number];

export const workItemCreatorSchema = z.object({
  kind: z.enum(WORK_ITEM_CREATOR_KINDS),
  id: z.string().min(1),
  displayName: z.string().optional(),
});
export type WorkItemCreator = z.infer<typeof workItemCreatorSchema>;

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
  /* ---- Surface 对齐（0018，全部可选 = 缺省即未设置，NULL 语义保真）---- */
  /** 闭集键；缺省 = **未设置**（与显式值不是同一态）。 */
  priority: workItemPrioritySchema.optional(),
  /** 起始 / 截止：日历日期 `YYYY-MM-DD`（Q5），`undefined` = 未设置。 */
  startDate: workItemDateOnlySchema.optional(),
  dueDate: workItemDateOnlySchema.optional(),
  /** 创建人（谁按下创建）；缺省 = 未知（存量行**不**拿 assignee 冒充）。 */
  creator: workItemCreatorSchema.optional(),
  /** 每 workspace 单调序号（写入口用 SQL 原子生成；编号文本由 `formatWorkItemIdentifier` 单源拼接）。 */
  identifierSeq: z.number().int().positive().optional(),
  /* ---- 项目绑定（0022；R-P1 服务面轮）---- */
  /**
   * 所属项目（`work_items.project_id`，可空）：**缺省 = 无项目**（显式合法状态，不是脏数据
   * —— multica 同款：过滤/看板/选择器三层都显式表达「无项目」）。写入口校验项目属于本 workspace。
   */
  projectId: z.string().min(1).optional(),
  /**
   * 编号前缀**快照**（`work_items.identifier_prefix`）：绑定/改绑时落项目的 `short_code`，
   * 清绑时置 NULL。它是**既成事实**（已签发的编号不因项目后续变动而重写），
   * 读模型原样带出，不经项目表二次解析。
   */
  identifierPrefix: z.string().min(1).optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;

/* ------------------------------------------------------------------------ */
/* 编号显示（R-P1 项目绑定轮）                                                */
/* ------------------------------------------------------------------------ */

/** 无项目时的编号前缀：保持本仓既有 `#N` 形态（不因项目维度上线而改既有编号）。 */
const NO_PROJECT_IDENTIFIER_PREFIX = "#";

/**
 * 工作项**编号文本**的唯一纯函数：`{短码}-{序号}`（有项目）或 `#{序号}`（无项目）。
 *
 * 为什么在 shared 而不是 UI：两个消费面（UI 的列/卡片/详情，服务侧的读模型与回声）必须同源 ——
 * 两处各拼一遍时，某天会在「前缀是不是去空白」「分隔符是不是连字符」上分叉，而分叉只体现在
 * 用户看到的编号上（不报错）。函数是纯函数、无 i18n、不抛：两个运行环境（浏览器 / node）都可用。
 *
 * 两个入参都来自**库里的行**（`identifier_prefix` 快照与 `identifier_seq`），不是实时项目：
 * · `prefix` 非空 ⇒ `{prefix}-{seq}`；空串 / `null` / `undefined` ⇒ 按「无前缀」渲染 `#{seq}`。
 *   空串是手改库/跨版本残留的坏值 —— 拼成 `-12` 这种残形比回落到既有形态更坏；渲染不抛。
 * · `seq` 为 `null` / `undefined` ⇒ 返回 `null`（存量行没有号）：调用方据此**整块不渲染**，
 *   空串会让「未设置」看起来像「编号是空的」。
 */
export function formatWorkItemIdentifier(input: {
  prefix?: string | null;
  seq?: number | null;
}): string | null {
  if (input.seq === null || input.seq === undefined) return null;
  const prefix = input.prefix ?? "";
  return prefix === "" ? `${NO_PROJECT_IDENTIFIER_PREFIX}${input.seq}` : `${prefix}-${input.seq}`;
}
