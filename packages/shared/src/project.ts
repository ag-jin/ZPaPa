import { z } from "zod";

/* 项目（`projects`，迁移 0022）的**领域词汇闭集与形状判据**（R-P1 项目绑定 · 服务面轮）。

   为什么与工作项同文件分家：项目是 **workspace 级实体**（multica `server/migrations/034_projects.up.sql:2-14`
   的 ZPaPa 收窄版，证据 `reports/2026-10-09-multica-issue-project-binding.md` A1），它有自己的一组
   闭集（status）与一个本仓加法（short_code —— multica 没有项目短码，它的编号前缀是 workspace 级
   `issue_prefix`；用户裁定「编号换项目短码」）。这些判据被**两个写入口**（服务面 create/update）
   与 **UI 表单**共用，故放 shared 的单一来源 —— 两处各写一遍时会在「小写算不算合法」「闭集漏哪一档」
   上分叉，而分叉只体现在用户看到的编号/状态上（不报错）。

   本文件**不抛**、不做 IO、不依赖 node：错误文本由 `*ErrorMessage` 产出，抛出发生在各自写入口
   （与 `parseWorkItemLabels` / `resolveWorkItemPriority` 同一条纪律）。 */

/* ---------------- status 闭集 ---------------- */

/**
 * 项目状态**闭集**（与 multica `034_projects.up.sql:8-9` 的 CHECK 逐字一致）：
 * `planned | in_progress | paused | completed | cancelled`。
 *
 * 为什么带 `PROJECT_STATUS_DEFAULT`：DDL 与 multica 同款有 `DEFAULT 'planned'`；
 * 「不传状态」在创建时落这一档是**契约**（不是替用户编事实 —— 新建项目默认「计划中」是产品定义），
 * 而 patch 里显式给 `null` 是另一件事（见 `resolveProjectStatus`：一律 invalid，不静默回落默认值）。
 */
export const PROJECT_STATUS_KEYS = [
  "planned",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
] as const;
export type ProjectStatusKey = (typeof PROJECT_STATUS_KEYS)[number];

export const PROJECT_STATUS_DEFAULT: ProjectStatusKey = "planned";

export const projectStatusSchema = z.enum(PROJECT_STATUS_KEYS);

/** status 输入的**解析结论**（判别联合，与 `WorkItemPriorityResolveResult` 同款纪律）。 */
export type ProjectStatusResolveResult =
  | { kind: "ok"; status: ProjectStatusKey }
  | { kind: "invalid"; value: string };

/**
 * 归一化外来 status：闭集内原样收下，其余（含 `undefined` / `null`）一律 `invalid`。
 *
 * 为什么 `undefined` / `null` 也算 invalid 而不是回落到默认档：本函数只回答「这个值是不是闭集内」。
 * 「创建时没给状态 ⇒ 用默认档」是调用方在**建行之前**显式做的决定（`?? PROJECT_STATUS_DEFAULT`）；
 * 若在这里回落，patch 里显式传 `null`（想清空状态）会被静默改成 `planned` —— 用户以为清掉了，
 * 库里却是「计划中」。状态是 NOT NULL 列，没有「清空」这一态，故一律响亮拒。
 */
export function resolveProjectStatus(raw: unknown): ProjectStatusResolveResult {
  if (typeof raw === "string" && (PROJECT_STATUS_KEYS as readonly string[]).includes(raw)) {
    return { kind: "ok", status: raw as ProjectStatusKey };
  }
  return { kind: "invalid", value: typeof raw === "string" ? raw : String(raw) };
}

/** 非 ok 的 status 结论 ⇒ **一条**响亮错误文本（两个写入口与 UI 共用同一句话）。 */
export function projectStatusErrorMessage(
  failure: Exclude<ProjectStatusResolveResult, { kind: "ok" }>,
): string {
  return (
    `项目状态「${failure.value}」不在闭集内（${PROJECT_STATUS_KEYS.join(" / ")}）：拒绝静默折算 —— ` +
    "把看不懂的状态当默认档会让用户的选择凭空消失。"
  );
}

/* ---------------- short_code 形状 ---------------- */

export const PROJECT_SHORT_CODE_MIN_LENGTH = 2;
export const PROJECT_SHORT_CODE_MAX_LENGTH = 8;

/**
 * 短码形状（唯一判据）：`2..8` 位**大写**字母数字。
 *
 * 为什么大写、且不做静默大写化：短码是**编号的可见前缀**（`{短码}-{序号}`），它出现在用户看到的
 * 每一条编号、URL 片段与搜索里。静默把 `plt` 收成 `PLT` 会让「输入什么」与「库里/界面上是什么」
 * 分叉；用户要小写，那是产品决策（要改就改这一处规则 + 迁移），不在解析层悄悄替他们决定。
 * 存储层的 CHECK（0022）是同一形状的最后一道闸。
 */
export const PROJECT_SHORT_CODE_PATTERN = /^[A-Z0-9]{2,8}$/;

export function isProjectShortCode(value: string): boolean {
  return PROJECT_SHORT_CODE_PATTERN.test(value);
}

/** 短码输入的**解析结论**（判别联合；`undefined` / `null` / 非串一律 invalid —— 创建必填）。 */
export type ProjectShortCodeResolveResult =
  | { kind: "ok"; shortCode: string }
  | { kind: "invalid"; value: string };

/**
 * 归一化外来短码：合法原样收下（**不 trim、不大小写归一**），其余一律 `invalid`。
 *
 * 为什么不 trim：`" AB"` 与 `"AB"` 在用户眼里可能就是「我多打了一个空格」，但静默裁剪会让
 * 「表单填的」与「库里记的」不一致；短码进编号，宁可响亮拒（表单侧可以自行提示）。
 */
export function resolveProjectShortCode(raw: unknown): ProjectShortCodeResolveResult {
  if (typeof raw === "string" && isProjectShortCode(raw)) return { kind: "ok", shortCode: raw };
  return { kind: "invalid", value: typeof raw === "string" ? raw : String(raw) };
}

/** 非 ok 的短码结论 ⇒ **一条**响亮错误文本（两个写入口与 UI 共用同一句话）。 */
export function projectShortCodeErrorMessage(
  failure: Exclude<ProjectShortCodeResolveResult, { kind: "ok" }>,
): string {
  return (
    `项目短码「${failure.value}」不合法（须 ${PROJECT_SHORT_CODE_MIN_LENGTH}–` +
    `${PROJECT_SHORT_CODE_MAX_LENGTH} 位大写字母或数字，例如 “PLT”）：它是编号的前缀，` +
    "形状错了每条编号都会跟着错；不接受小写或空白（本层不做静默规整）。"
  );
}
