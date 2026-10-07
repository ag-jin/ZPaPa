import type { WorkItemDecisionKind, WorkItemDecisionRecord } from "@zcode/services";

/* C3.2：决定面的**纯投影模型**（与 `workItemMentionViewModel.ts` 同款：判据留在纯函数里，组件只组装）。

   为什么单拆一个模块而不是并进 `workItemCollaborationViewModel.ts`：那个文件已经贴着 lint 的
   max-lines（400）硬门槛，而决定面还要加「kind 映射 + 父候选 + 父引用 + 提交判据」四组判据 ——
   借卡片 §5.6 自己的逃生口（「若超 400 行 lint 门槛再拆并在报告登记」）拆出这一层，语义与
   「comment / mention / decision 各自的投影」边界一致。

   三条输入纪律与协作域其余投影同款：不重排（顺序原样来自 repo）、不读时钟、不碰 i18n
   （文案键在下面的映射表里，组件再用 intl 翻）。 */

/**
 * 每枚决定 kind 的可见短句键（**闭集穷尽**）：`Record<WorkItemDecisionKind, string>` 让将来
 * 新增 kind 直接**编译失败**（响亮）。
 *
 * 这是 B5.1 那串 if/else 的替代品：原来的链在最后一个 `else` 回落成「已重新审议」，第 6 个 kind
 * 出现时界面会**静默说错话**（显示一句确定的假话）而不是不显示。映射表 + 下面的访问器把这种
 * 情况变成要么编译失败、要么响亮抛。
 */
export const DECISION_KIND_MESSAGE_IDS: Record<WorkItemDecisionKind, string> = {
  proposal: "squad.workItemDetail.decision.proposal",
  accepted: "squad.workItemDetail.decision.accepted",
  rejected: "squad.workItemDetail.decision.rejected",
  superseded: "squad.workItemDetail.decision.superseded",
  reopened: "squad.workItemDetail.decision.reopened",
};

/** 闭集外的 kind ⇒ **响亮抛**（不猜标签，也不回落成某个具体 kind 的文案）。 */
export function decisionKindMessageId(kind: string): string {
  if (!Object.hasOwn(DECISION_KIND_MESSAGE_IDS, kind)) {
    throw new Error(
      `决定 kind 闭集外「${kind}」：不猜标签，一律抛（猜的下场是界面说一句确定的假话）。`,
    );
  }
  return DECISION_KIND_MESSAGE_IDS[kind as WorkItemDecisionKind];
}

/* ---------- 父规则（与 C3.1 服务面的判据同集；第二份判据只服务可用性） ---------- */

/**
 * 父引用行的前缀键（**闭集穷尽**）：`superseded` / `reopened` 各有专门前缀（「取代了」≠「重新审议」），
 * 其余三键共用「关于」—— 它们的父是**可选**的（v1 表单不给选择器），但读面里已经存在的父链
 * 不能装作没有（那会让「这条决定针对什么」在时间线上凭空消失）。
 */
export const DECISION_PARENT_PREFIX_MESSAGE_IDS: Record<WorkItemDecisionKind, string> = {
  proposal: "squad.workItemDetail.decision.parentRelated",
  accepted: "squad.workItemDetail.decision.parentRelated",
  rejected: "squad.workItemDetail.decision.parentRelated",
  superseded: "squad.workItemDetail.decision.parentSuperseded",
  reopened: "squad.workItemDetail.decision.parentReopened",
};

/**
 * 必须带父决定的 kind：缺父时服务面**响亮拒**（`WorkItemDecisionService` 的同一格）。
 * UI 侧重复一份只是为了「不让用户撞一次必然失败」；判据本体仍在服务面。
 */
const PARENT_REQUIRED_KINDS: ReadonlySet<WorkItemDecisionKind> = new Set([
  "superseded",
  "reopened",
]);

/** `reopened` 的合法父 kind（= 服务面 `REOPENABLE_PARENT_KINDS`）：重开一条仍在提议中的决定没有意义。 */
const REOPENABLE_PARENT_KINDS: ReadonlySet<WorkItemDecisionKind> = new Set([
  "accepted",
  "rejected",
  "superseded",
]);

export function decisionNeedsParent(kind: WorkItemDecisionKind): boolean {
  return PARENT_REQUIRED_KINDS.has(kind);
}

/**
 * 新决定的**合法父候选**：`superseded` ⇒ 全部既有决定；`reopened` ⇒ 仅 {accepted, rejected, superseded}；
 * 其余三键 ⇒ 空（父是可选的，v1 表单不给选择器 —— 给一个可选的父子选择器只会制造两条看起来
 * 一样、语义不同的链路）。
 *
 * 顺序**原样来自输入**（repo 的 `effectiveAt ASC`）：本层不 sort（第二份排序判据与 repo 漂移时不报错）。
 * 「去自身」在本形态下是**结构上不可能**：候选们是新决定的父，而新决定此刻还不存在 id
 * （服务面也把自指响亮拒掉）。
 */
export function decisionParentCandidates(
  kind: WorkItemDecisionKind,
  decisions: WorkItemDecisionRecord[],
): WorkItemDecisionRecord[] {
  if (!PARENT_REQUIRED_KINDS.has(kind)) return [];
  if (kind === "reopened") {
    return decisions.filter((row) => REOPENABLE_PARENT_KINDS.has(row.kind));
  }
  return [...decisions];
}

/** 父引用的呈现结论：`resolved` = 父在读面里；`unresolved` = 只拿得到 id（**不编名字**）。 */
export type DecisionParentReference =
  | { kind: "resolved"; parent: WorkItemDecisionRecord }
  | { kind: "unresolved"; id: string };

/**
 * 一条决定的父引用（时间线的「取代了 / 重新审议」行）。
 * 父不在读面里 ⇒ `unresolved` 且**只给 id**：取第一条或编个名字都是让时间线说假话；
 * `parentDecisionId === null` ⇒ `null`（整行不渲染）。
 */
export function decisionParentReference(
  decision: WorkItemDecisionRecord,
  decisionsById: ReadonlyMap<string, WorkItemDecisionRecord>,
): DecisionParentReference | null {
  const id = decision.parentDecisionId;
  if (id === null) return null;
  const parent = decisionsById.get(id);
  return parent === undefined ? { kind: "unresolved", id } : { kind: "resolved", parent };
}

/* ---------- 提交判据（表单态） ---------- */

export type DecisionFormState = {
  kind: WorkItemDecisionKind;
  subject: string;
  parentDecisionId: string | null;
};

/** 提交判据：`trim` 判据与 C3.1 服务面**同义**（空 subject 服务面必拒）；必填父未选 ⇒ 不可提交。 */
export function canSubmitDecision(form: DecisionFormState): boolean {
  if (form.subject.trim() === "") return false;
  if (PARENT_REQUIRED_KINDS.has(form.kind)) return form.parentDecisionId !== null;
  return true;
}

/**
 * 提交载荷里真正要带的父：**只有必填 kind 才带**。
 *
 * 为什么不让表单态直接落进载荷：用户先在 superseded 下选好父、再把 kind 切成 proposal 时，
 * 那个父选择**从界面上消失了**（字段不再渲染）却仍留在组件状态里 —— 直通就会把一条「关于 X」
 * 写进一条用户以为没有父的决定行。审计事实不接受「界面上看不见的残留选择」。
 */
export function decisionSubmitParentId(
  kind: WorkItemDecisionKind,
  parentDecisionId: string | null,
): string | null {
  return PARENT_REQUIRED_KINDS.has(kind) ? parentDecisionId : null;
}

/* ---------- 幂等键的生成（§8.1） ---------- */

/**
 * `sourceRequestId` 的生成（决定表单里**唯一**造 id 的地方）。
 * `crypto.randomUUID` 在非安全上下文/旧宿主里可能缺席，那时退回「时间戳 + 随机后缀」——
 * 两者都只为「同一次提交动作内的稳定性」服务（提交动作内的沿用由 `resolveSubmitId` 保证），
 * 唯一性只要在本机、本会话内够用（故带随机后缀而不是纯计数器）。
 */
export function newDecisionRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `decision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}
