import { WAKE_MAX_FIRES_MAX, WAKE_MAX_FIRES_MIN, type WakeRule } from "@zcode/shared";
import type { CreateWakeRuleRequest, UpdateWakeRuleRequest } from "@zcode/services";

/* 「唤醒规则」分区（WorkItemsPage 的 `WakeRulesSection` / `CreateWakeRuleDialog`）的**纯逻辑**：
   排期事实投影、行状态机、建 / 编辑规则的入参组装（**校验核心只有一份**：创建与编辑共用
   `buildEditableWakeRuleFields`，两份校验会陆续分叉而分叉不报错）。不 import React、不 import UI
   原语 —— 照 squadEntryViewModel / inboxViewModel 的既定做法（ui 包没有渲染测试设施，判断留在
   组件里就等于不可测）。

   为什么挂载在「工作项」页而不是「自动化」页（已定口径，照此执行）：规则挂在**工作项**上、
   列表按 workspace 的工作项**反查**（`listWakeRules`）⇒ 它的作用域就是「当前项目」；
   spec §5.6 明确 cron 自动化与唤醒规则是两套**分工**的机制（一个管定时跑任务、一个管到点
   唤醒派发），混进「自动化」页会让用户把两套机制读成一套。

   第 39 轮给的**硬约束**（本层与对话框共同遵守，结构守卫钉住）：
   · `timezone` / `expiresAt` **界面不得暴露** —— 服务面透传落盘但调度侧尚未消费（timezone 只
     留存、expiresAt 不被 wakeTick 判过期，见 CreateWakeRuleRequest 的 doc），暴露输入框
     等于让用户以为设了它们会生效；
   · `condition` / `eventTypes` / `filters`（事件型规则）不给入口 —— 需要 spec 未枚举的
     **事件词汇表**，本轮不猜。
   · `mode` **由 kind 推导、不作为独立选择**：`validateWakeRule` 强制 at⇒once、
     every/cron⇒continuous，让用户自由组合会邀请失败。 */

// ---------- ① 排期事实投影（只搬事实、不碰 i18n） ----------

/** 描述一条规则的排期所需的**事实**：kind + 该 kind 自己的那一个排期字段。 */
export type WakeRuleScheduleLine =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "every"; readonly intervalSeconds: number }
  | { readonly kind: "cron"; readonly cronExpression: string };

/**
 * 取一条规则的排期事实；取不到 ⇒ `null`（列表显示中性的「配置缺失」，见 `squad.rules.configMissing`）。
 *
 * **为什么缺字段回 `null` 而不是抛/猜**：缺字段是**坏数据**（`validateWakeRule` 的互斥第 6 条
 * 保证三种排班 kind 各带自己的字段，正常落盘的规则不会缺）——但「读回来一条坏行」这件事在
 * 列表这种只读面上必须有个中性出路：抛会把整段列表炸掉（一条坏行让用户看不见另外 99 条），
 * 猜（例如对 every 缺字段显示「每 0 秒」）会把坏数据渲染成一句**假话**。故 `null` = 渲染不出
 * 排期描述，由行显示「配置缺失」；这与「不静默」同源：用户看得见这条有问题。
 *
 * 同样的理由覆盖三类非缺字段的坏值：非有限数（`Intl.DateTimeFormat.format(NaN)` 会**抛**
 * RangeError，直接把渲染炸掉）、非正的间隔（「每 0 秒」是假话）、空 cron 表达式（空串不是表达式）。
 * `kind` 为 `"event"`（UI 不给入口，但库里的行可能带它）时同样回 `null` —— 本层渲染不出
 * 排期描述，也不编。
 */
export function wakeRuleScheduleParts(
  rule: Pick<WakeRule, "kind" | "at" | "intervalSeconds" | "cronExpression">,
): WakeRuleScheduleLine | null {
  if (rule.kind === "at") {
    if (rule.at === undefined || !Number.isFinite(rule.at)) return null;
    return { kind: "at", at: rule.at };
  }
  if (rule.kind === "every") {
    const seconds = rule.intervalSeconds;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
    return { kind: "every", intervalSeconds: seconds };
  }
  if (rule.kind === "cron") {
    const expression = rule.cronExpression;
    if (expression === undefined || expression.trim() === "") return null;
    return { kind: "cron", cronExpression: expression };
  }
  return null;
}

/**
 * 到点时刻的本地化显示：`Intl.DateTimeFormat`（与 settings/memoryUpdatedAt 同一手法），
 * 时区取**系统本地时区** —— 与调度口径一致（现有排期计算 croner 用本地时区，
 * `timezone` 字段只做落盘留存，见 CreateWakeRuleRequest 的 doc）；显示成别的时区会让
 * 「界面上写的到点时间」与「调度器真的触发时刻」分叉。
 *
 * 年/月/日/时/分显式枚举（不用 dateStyle）：跨平台差异更小，且 `hourCycle: "h23"` 与
 * memoryUpdatedAt 的既有选择一致（24 小时制，无 AM/PM 歧义）。
 */
export function formatWakeRuleTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}

/** 行标题：工作项标题；查不到（已归档 / 快照过期 / 坏数据）回落 id —— 显示空会比显示 id 更糟。 */
export function resolveWorkItemTitle(
  workItems: readonly { id: string; title: string }[],
  workItemId: string,
): string {
  return workItems.find((item) => item.id === workItemId)?.title ?? workItemId;
}

// ---------- ② 行状态机与行动作 ----------

export type WakeRuleRowStatus =
  | "active"
  | "user_paused"
  | "gate_paused"
  | "completed"
  | "unscheduled";

export type WakeRuleRowState = {
  status: WakeRuleRowStatus;
  canPause: boolean;
  canResume: boolean;
};

/**
 * 一行规则的**状态 + 动作可用性**（逐格穷举，优先级自上而下）：
 *
 * 1. `pausedReason` 有值 ⇒ `gate_paused`（**优先级最高**：那是防失控闸停的 —— 闸停时
 *    `enabled` 仍是 true、排期被清空，若先判 enabled 会把它误读成「在跑」）；
 * 2. 否则 `!enabled` ⇒ `user_paused`（服务面口径：用户暂停 = 关主开关 `enabled=false`
 *    + 清排期；闸暂停不写 enabled，两者由此可分辨，见 squadWakeRules 文件头）；
 * 3. 否则 `kind === "at" && fireCount > 0` ⇒ `completed`（一次性规则触发过就不会再触发：
 *    排期已清空、开关未动 —— 真实形态是 enabled=true + nextFireAt 空 + fireCount>0）；
 * 4. 否则 `enabled && nextFireAt === undefined` ⇒ `unscheduled`（**防御格**，不是判据：
 *    本轮服务面保证 create/resume 都会排上首格，这一格只在坏数据 / 人为改库出现 ——
 *    写出来是为了让「调度器扫不到的规则」在界面上有个诚实的呈现，而不是显示成「在跑」）；
 * 5. 其余 ⇒ `active`。
 *
 * 动作口径：
 * · `canPause = status === "active"`：暂停只在「在跑」时给 —— 对已停（两种暂停）给暂停是
 *   幂等空动作（服务面早退），对终态（completed / unscheduled）给暂停更糟：服务面会
 *   因 `enabled` 已经处理过而**静默 no-op**，用户点完看不出任何变化；
 * · `canResume = user_paused || gate_paused`：闸暂停的**复位路径也是 resume**（服务面会清
 *   `pausedReason` 并重排 —— 即「人工复位」；等窗口滑过是另一条路，但界面上最快的出路是它）；
 * · **completed / unscheduled 不给任何动作**：completed 的规则重算无未来排期点（`at` 已过），
 *   服务面 resume 会**响亮抛**「恢复一条永不触发的规则」—— 给按钮 = 邀请一次必然失败；
 *   unscheduled 是坏数据形态，在没有编辑入口的这一轮没有可执行的正解，给动作只会制造假象。
 *   （两者都用状态徽标把「为什么没有动作」说出来。）
 */
export function wakeRuleRowState(
  rule: Pick<WakeRule, "kind" | "mode" | "enabled" | "pausedReason" | "nextFireAt" | "fireCount">,
): WakeRuleRowState {
  let status: WakeRuleRowStatus;
  if (rule.pausedReason !== undefined) {
    status = "gate_paused";
  } else if (!rule.enabled) {
    status = "user_paused";
  } else if (rule.kind === "at" && rule.fireCount > 0) {
    status = "completed";
  } else if (rule.nextFireAt === undefined) {
    status = "unscheduled";
  } else {
    status = "active";
  }
  return {
    status,
    canPause: status === "active",
    canResume: status === "user_paused" || status === "gate_paused",
  };
}

/* 状态 → 文案 id / 徽标配色（`Record` 强制穷尽：加一态时这里编译失败，而不是界面上多出裸 key）。
   配色只用**语义色 token**（spec §11.3：状态只由语义色表达，不是九色板）：
   · active ⇒ success（排期在跑）；
   · user_paused / completed ⇒ 中性 muted（一个是用户自己的选择、一个是终态，都不需要「注意」色）；
   · gate_paused / unscheduled ⇒ warning（闸停需要人知道；unscheduled 是坏数据，同样该被看见）。 */
export const WAKE_RULE_STATUS_MESSAGE_IDS: Record<WakeRuleRowStatus, string> = {
  active: "squad.rules.status.active",
  user_paused: "squad.rules.status.userPaused",
  gate_paused: "squad.rules.status.gatePaused",
  completed: "squad.rules.status.completed",
  unscheduled: "squad.rules.status.unscheduled",
};

export const WAKE_RULE_STATUS_BADGE_CLASSES: Record<WakeRuleRowStatus, string> = {
  active: "bg-success/10 text-success",
  user_paused: "bg-muted text-foreground-subtle",
  gate_paused: "bg-warning/10 text-warning",
  completed: "bg-muted text-foreground-subtle",
  unscheduled: "bg-warning/10 text-warning",
};

// ---------- ③ 建 / 编辑规则的入参组装（**校验核心只有一份**） ----------

/** 规则表单的**可编辑字段**（全是字符串：文本框原样，解析在下面的共用校验核心里）。
    `workItemId` **不在**本形状里：它只在创建时可选（编辑时挂载对象只读、不进 patch）。 */
export type WakeRuleEditableForm = {
  /** 三种排班 kind（类型上就排除 event —— 事件型规则需要未枚举的词汇表）。 */
  kind: "at" | "every" | "cron";
  /** `<input type="datetime-local">` 的原样值（`YYYY-MM-DDTHH:mm[:ss]`，本地时间）。 */
  atLocal: string;
  /** 间隔秒数的文本。 */
  intervalSecondsText: string;
  /** cron 表达式的原样文本。 */
  cronExpression: string;
  /** 触发上限的文本；空白 = 不传（由调度侧按默认执行）。 */
  maxFiresText: string;
};

/** 建规则表单的**原始形状** = 可编辑字段 + 挂载对象（select 的 value）。 */
export type CreateWakeRuleForm = WakeRuleEditableForm & {
  workItemId: string;
};

/** `reasonId` 是**文案 id**（不本地化 —— 本文件不碰 i18n，组件用 `t(reasonId)` 显示）。 */
export type BuildCreateWakeRuleInputResult =
  | { ok: true; input: CreateWakeRuleRequest }
  | { ok: false; reasonId: string };

/** 编辑组装的结果：`patch` 即 `updateWakeRule` 的补丁（**不含 workItemId**）。 */
export type BuildUpdateWakeRuleInputResult =
  | { ok: true; patch: UpdateWakeRuleRequest }
  | { ok: false; reasonId: string };

/** `datetime-local` 的合法形状（浏览器原生控件的输出；秒段可选）。 */
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 解析 `datetime-local` ⇒ 本地时区的 epoch ms；解析不出（形状坏 / 日历上不存在的日期）⇒ `null`。
 *
 * 逐段构造 `new Date(year, month - 1, day, …)` 而不是 `new Date(text)`：后者对
 * 「日期段缺时区」的 ISO 形式按**本地时间**解释是引擎行为，而 `new Date("2026-02-30T10:00")`
 * 这类**日历上不存在的日期**各引擎的处置不一致（有的直接滚动到 3 月 2 日）。逐段构造 +
 * **回读校验**（构造出的日期的各段必须与输入逐段相等）让「2 月 30 日」响亮地解析失败，
 * 而不是静默变成另一天 —— 到点时刻差一天是用户看不见的那种错。
 */
function parseDatetimeLocal(text: string): number | null {
  const match = DATETIME_LOCAL_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second ?? "0"].map((part) => Number(part));
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s, 0);
  const exact =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi &&
    date.getSeconds() === s;
  return exact ? date.getTime() : null;
}

/** 十进制正整数（`/^\d+$/`）："1e3" / "0.5" / "1,000" / 负号一律非法 —— 与其猜用户意图，不如让他重输。 */
function parsePositiveInteger(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * **共用校验核心**（创建与编辑**同一份**，不得各写一份 —— 另写一份会让两个表单在字段与校验上
 * 陆续分叉，而分叉不报错）：可编辑字段 ⇒ `UpdateWakeRuleRequest`（= 创建集减去 `workItemId`，
 * 也是编辑 patch 的形状），或一条**可读的** rejection。
 *
 * 为什么 UI 要先做这一层（而不是把表单原样递上去、让服务面拒）：服务面的拒绝是给日志与
 * 接线方看的**中文问题清单**（`validateWakeRule` 原样带出），而用户看到的应该是「哪个字段
 * 怎么改」；且其中几条（到点时刻已过、上限越界）在 UI 上**完全可以先判出来** ——
 * 把必然失败的请求递上去，最好的情况也只是把错误往后挪一层。
 *
 * **kind → mode 推导**（第 39 轮硬约束：mode 不作为独立选择）：
 *   · `at` ⇒ `once`（一次性到点唤醒）；
 *   · `every` / `cron` ⇒ `continuous`（周期性排班）。
 * 这只是把 `validateWakeRule` 互斥第 1 条的**唯一合法组合**照抄成推导 —— 不重写判据
 *（推导结果错误时服务面仍会响亮拒，本层只是不让用户走到那一步）。
 *
 * **产物不含** `timezone` / `expiresAt` / `condition` / `eventTypes` / `filters`（逐字段显式
 * 构造，运行期不可能混进别的键 —— 结构守卫与用例都钉住这一点）。空白可选字段（上限）**不传**：
 * 传一个 `undefined` 键与不传在服务面组装层同义，但「不传」让产物形状与「用户真没填」一致。
 */
function buildEditableWakeRuleFields(
  form: WakeRuleEditableForm,
  now: number,
): { ok: true; fields: UpdateWakeRuleRequest } | { ok: false; reasonId: string } {
  const fields: UpdateWakeRuleRequest = {
    kind: form.kind,
    mode: form.kind === "at" ? "once" : "continuous",
  };

  if (form.kind === "at") {
    const at = parseDatetimeLocal(form.atLocal);
    // 未填 / 解析不出 / 不晚于 now 都归一条：从句式上它们对用户的修法相同（重选一个未来时刻）。
    if (at === null || at <= now) return { ok: false, reasonId: "squad.rules.invalid.at" };
    fields.at = at;
  } else if (form.kind === "every") {
    const intervalSeconds = parsePositiveInteger(form.intervalSecondsText);
    if (intervalSeconds === null) return { ok: false, reasonId: "squad.rules.invalid.interval" };
    fields.intervalSeconds = intervalSeconds;
  } else {
    const cronExpression = form.cronExpression.trim();
    if (cronExpression === "") return { ok: false, reasonId: "squad.rules.invalid.cron" };
    fields.cronExpression = cronExpression;
  }

  // 上限：空白 = 不传；否则必须是 1..1000 的整数（边界取自共享常量，不在这里写第二份 1/1000）。
  const maxFiresText = form.maxFiresText.trim();
  if (maxFiresText !== "") {
    const maxFires = parsePositiveInteger(maxFiresText);
    if (maxFires === null || maxFires < WAKE_MAX_FIRES_MIN || maxFires > WAKE_MAX_FIRES_MAX) {
      return { ok: false, reasonId: "squad.rules.invalid.maxFires" };
    }
    // `once` 没有「上限」语义（validateWakeRule 互斥第 4 条会响亮拒）——同样不把必然失败递上去。
    if (form.kind === "at") return { ok: false, reasonId: "squad.rules.invalid.maxFires" };
    fields.maxFires = maxFires;
  }

  return { ok: true, fields };
}

/** 表单 ⇒ `CreateWakeRuleRequest`（`createWakeRule` 的入参）：宿主校验 + **共用核心**。 */
export function buildCreateWakeRuleInput(
  form: CreateWakeRuleForm,
  now: number,
): BuildCreateWakeRuleInputResult {
  const workItemId = form.workItemId.trim();
  if (workItemId === "") return { ok: false, reasonId: "squad.rules.invalid.workItem" };
  const result = buildEditableWakeRuleFields(form, now);
  if (!result.ok) return result;
  return { ok: true, input: { workItemId, ...result.fields } };
}

/**
 * 表单 ⇒ `UpdateWakeRuleRequest`（`updateWakeRule` 的 patch）：**同一份共用核心**，只是**不含**
 * `workItemId`（挂载对象不可改 —— 改了等于换一条规则的归属，应删旧建新，见对话框的只读行）。
 */
export function buildUpdateWakeRuleInput(
  form: WakeRuleEditableForm,
  now: number,
): BuildUpdateWakeRuleInputResult {
  const result = buildEditableWakeRuleFields(form, now);
  if (!result.ok) return result;
  return { ok: true, patch: result.fields };
}

/** epoch ms ⇒ `datetime-local` 的原样值（**本地时区**，与解析侧对称：`parseDatetimeLocal` 的逆）。 */
function formatDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 一条规则 ⇒ 编辑对话框的初值（`CreateWakeRuleForm` 形状，**只有这一份映射**）。
 *
 * 三种排班 kind 的原值逐字段填回（`timezone` / `expiresAt` / `condition` / `eventTypes` / `filters`
 * **不在表单里** —— 第 39 轮硬约束，编辑同样不暴露；服务面的 `casUpdateConfig` 也不写这些列，
 * 故它们的落盘值原样留存）。`at` 按本地时区格式化（与解析侧同一时区口径）。
 *
 * `kind` 的**防御映射**（登记）：本表单只能表达排班三支（事件型无词汇表、不给入口）。库里若出现
 * `kind=event` 的行（只能来自库外写入 —— 生产 insert 路径给不出它），初值回落 `"at"` 且排期字段留空：
 * 用户必须显式选一种触发方式并填好它才能保存（表单校验会拒绝空字段），不会静默把 event 改写成
 * 某条排班规则。`maxFires` 只在连续 kind（every / cron）上回填 —— `at` 没有上限语义，
 * 回填会留下一个看不见也改不掉的输入（下一次提交必然失败）。
 */
export function wakeRuleDialogInitial(rule: WakeRule): CreateWakeRuleForm {
  const kind: WakeRuleEditableForm["kind"] =
    rule.kind === "every" || rule.kind === "cron" ? rule.kind : "at";
  return {
    workItemId: rule.workItemId,
    kind,
    atLocal: kind === "at" && rule.at !== undefined ? formatDatetimeLocal(rule.at) : "",
    intervalSecondsText:
      kind === "every" && rule.intervalSeconds !== undefined ? String(rule.intervalSeconds) : "",
    cronExpression: kind === "cron" ? (rule.cronExpression ?? "") : "",
    maxFiresText: kind !== "at" && rule.maxFires !== undefined ? String(rule.maxFires) : "",
  };
}
