import type { AuthorRef } from "./workItemCommentRepo.js";

/* 协作域 C4.1：协作访问判据（spec §9 的三轴占位 + A2A 顶层人类归因 + Q7 主体规范化单源）。

   为什么是一个**纯模块 + 写者处并列调用**，而不是中间件或门面自建判据（任务卡 §2.1(b) 的三选一）：
   ① 仓内没有中间件层可挂，且三个非创建型写入口只带 commentId（要拿工作项上下文还得多读两跳）；
   ② 门面是浏览器安全模块，不该耦合评论 repo 的读法；
   ③ 判据在门面与写者各写一份时，漂移不报错 ⇒ 判据只有这一处实现，调用点 = 五个写方法（各恰一处，
      全在第一次写之前）+ 门面读面一处。

   **本模块必须保持浏览器安全**：门面（workItemCollaborationService.ts）**值导入**它，而门面经
   packages/services/src/index.ts 出值到 renderer ⇒ 本文件一旦触达 node:*，browserSafeRootEntry 的
   传递可达检查会红（renderer 会在挂载前整包失败）。故本文件零 IO、零 `node:` 值导入、零 `.add(`。

   v1 的**全部**拒绝原因只有三条（闭集；字面值与既有 receipt detail 逐字相同 ⇒ 不产生第二套词汇）：
   这三条今天分散在 commentService（请求面）与 leaderDispatch.planDispatch（执行面），本模块是它们
   在**轴语言**上的单源（请求面接线在 C4.2；执行面的分工不改）。

   单人产品语义（诚实登记，任务卡 §2.1(a)）：canView/canComment 在「单人类 + agent 无写入口」下
   **恒真**——本轮交付的是「判据面位置 + 原因闭集 + 可注入拒绝路径」，不是「拦住谁」。恒真不是做了一半，
   而是单人产品的正确实现（同 §12.1-11「本地稳定人类 id（一机一主）」）；§11.5「权限失败不写半条
   Comment，不留下无来源的派发 receipt」的可测形态 = 注入拒绝策略 ⇒ 五个写入口零写入、零外发。 */

/**
 * 权限主体：与审计身份（§3.1 `AuthorRef`）同形 —— human / agent / **system** 三值都能作为值流过同一条
 * 判据。这里不排除 system 的取值域：本仓既有事实里 system 作者是**可写评论**的（
 * `commentTriggerMatrix.test.ts`「system 作者：评论可写（可审计）」），把它从类型里摘掉会让写闸在缺省
 * 策略下新增一条拒绝路径（既有行为逐格不变这条验收会破）。§9 第 4 条（system 不得以 system 身份绕过
 * canInvoke）的 v1 形态因此不是类型收窄，而是**本模块里没有任何 `system` 分支**：system 只能作为普通
 * 主体流过同一条判据，不存在「system ⇒ allowed」的捷径（结构守卫见测试）。
 */
export type AccessSubject = AuthorRef;

/**
 * 主体解析入参：`actor` 是「这次是谁做的」，`initiatedBy` 是「顶层人类是谁」。
 *
 * 两个入参**都必填**不是装饰：它让「想拿 actor 当主体」在调用点必须显式多写一个字段，
 * 从而被正负对照用例与结构守卫同时逮住（§9 第 3 条的 A2A 红线）。
 */
export type AccessSubjectSource = {
  actor: AuthorRef;
  initiatedBy: AuthorRef;
};

/** 工作项上下文：`null` = 读不到工作项（不是归档）；归档项**照可读可写**（§12.1-12 可审计不可派发）。 */
export type WorkItemAccessContext = { workItemId: string; archivedAt: number | null } | null;

/**
 * v1 的**全部**拒绝原因（闭集）。三值分别对应：
 * · `work_item_archived`——归档项不派发（§12.1-12）；评论/决定等审计事实照写；
 * · `agent_not_in_roster`——目标不可调起（§4.5 的级联只在名册内解析目标）；
 * · `dispatch_disabled`——实验门禁关闭：新的派发被拒（§12.1-12）。
 * **「目标已归档 / 已停用」不在其中**：那是执行面 planDispatch 的 skip 族事实（leaderDispatch.ts 明文
 * 「名册缺席与『已归档 / 已停用』是两种事实，不合并」），评论时的判据刻意不扩那一格（§2.1c）。
 */
export const COLLABORATION_ACCESS_DENY_REASONS = [
  "work_item_archived",
  "agent_not_in_roster",
  "dispatch_disabled",
] as const;

export type CollaborationAccessDenyReason = (typeof COLLABORATION_ACCESS_DENY_REASONS)[number];

/** 判据结论：`allowed:false` **必须带原因**——「被拒但不知道为什么」不能进文案与留痕。 */
export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: CollaborationAccessDenyReason };

/** `canComment` 的写入动作闭集（Q2 裁定：决定写与四评论入口并列，**不发明第四轴 canDecide**）。 */
export type CommentAccessAction = "create" | "delete" | "resolve" | "react" | "decide";

/**
 * 调起目标。`kind` 说目标是小队还是单个 agent（小队目标由调用面解析成队长——§4.5 只解析名册内目标，
 * 故这里只带 `inRoster` 而不带名册细节）。
 *
 * `archived` / `enabled` 是**契约形状的占位**：v1 判据**不读它们**（闭集里没有对应原因，见上面
 * `COLLABORATION_ACCESS_DENY_REASONS` 的 doc）——保留它们是为了「目标已归档 / 已停用」将来若真要
 * 进判据时有位置可用，而不是现在就把执行面的 skip 族搬进请求面。
 */
export type InvokeTargetContext = {
  kind: "agent" | "squad";
  id: string;
  inRoster: boolean;
  archived?: boolean;
  enabled?: boolean;
};

/** `canInvoke` 的上下文：门禁开关（同步快照，与 SquadRuntimeDeps.readExperimentEnabled 同一份）。 */
export type InvokeAccessContext = { dispatchEnabled: boolean };

/** 三轴的**具名**判据面（§9：接口必须预留三轴，不能继续用单个 canAccess 代替）。 */
export type CollaborationAccessPolicy = {
  canViewWorkItem(subject: AccessSubject, workItem: WorkItemAccessContext): AccessDecision;
  canCommentWorkItem(
    subject: AccessSubject,
    workItem: WorkItemAccessContext,
    action: CommentAccessAction,
  ): AccessDecision;
  canInvokeTarget(
    subject: AccessSubject,
    workItem: WorkItemAccessContext,
    target: InvokeTargetContext,
    context: InvokeAccessContext,
  ): AccessDecision;
};

/**
 * 本地人类的 **canonical 主体**（审计侧）。
 *
 * Q7 裁定（哪边归一到哪边）：**assignee 侧归一到审计侧**，理由三条——
 * ① §9 的判据输入今天全部来自审计轴（`initiatedBy`）；规范化方向与判据输入同轴，调用点才不需要
 *    各自再映射一次（那正是「双判据」的来源）；
 * ② assignee 侧的 `id` 是**无身份的占位符**（UI 侧常量名即 `WORK_ITEM_USER_ASSIGNEE_ID`，值 `"user"`）：
 *    它不指向任何名册行，第二个人类无法与它区分 ⇒ 拿它当 canonical 会让「同一个人」的 key 依赖一个
 *    没有身份语义的值；
 * ③ 审计侧 id 是稳定且唯一的（§12.1-11「本地稳定人类 id（一机一主）」；组合根注释明文「常量而非
 *    系统用户名」）—— 换机、改名都不该让历史事实换一个主体。
 *
 * 与组合根的漂移由测试钉死（组合根那份本地人类身份常量的 kind/id 必须与这里逐字相同）。
 */
export const LOCAL_HUMAN_SUBJECT: AccessSubject = { kind: "human", id: "local-user" };

/** assignee 侧的人类占位 id（UI 常量 `WORK_ITEM_USER_ASSIGNEE_ID` 的值；模块私有：规则只在下面实现一次）。 */
const WORK_ITEM_USER_ASSIGNEE_ID = "user";

/**
 * **主体规范化单源**（Q7）：把同一个人的两种 id 表示归一到 canonical（审计侧）。
 *
 * 规则（只有这一处实现，不得在别处再判一次）：
 * · `{kind:"human", id:"user"}` —— assignee 侧的人类占位（工作项「指派给人」用的 id）⇒ `LOCAL_HUMAN_SUBJECT`；
 * · 其余原样返回（canonical 是不动点；`{kind:"agent", id:"user"}` 属于另一命名空间，**不**归一）。
 */
export function normalizeAccessSubject(subject: AccessSubject): AccessSubject {
  if (subject.kind === "human" && subject.id === WORK_ITEM_USER_ASSIGNEE_ID) {
    return LOCAL_HUMAN_SUBJECT;
  }
  return subject;
}

/** canView 轴：单人产品下恒真（本模块只提供**可寻址的具名判据**与可注入的拒绝路径，§2.1(a)）。 */
export function canViewWorkItem(
  _subject: AccessSubject,
  _workItem: WorkItemAccessContext,
): AccessDecision {
  return { allowed: true };
}

/** canComment 轴：单人产品下恒真；`action` 进签名是为了让「决定写」与四评论入口共用同一判据面（Q2）。 */
export function canCommentWorkItem(
  _subject: AccessSubject,
  _workItem: WorkItemAccessContext,
  _action: CommentAccessAction,
): AccessDecision {
  return { allowed: true };
}

/**
 * 目标可调性判据（= multica `canInvokeAgent`「可见 ≠ 可运行」的对应物）。
 *
 * **接线在 C4.2**（接线点 = commentService 的逐目标裁决处）；本卡交付函数与矩阵。
 * 优先级与既有实现逐格同序（`commentService.ts` 的 `restriction ?? 名册`）：
 * 工作项归档 > 门禁关闭 > 名册缺席。
 */
export function canInvokeTarget(
  subject: AccessSubject,
  workItem: WorkItemAccessContext,
  target: InvokeTargetContext,
  context: InvokeAccessContext,
): AccessDecision {
  if (workItem !== null && workItem.archivedAt !== null) {
    return { allowed: false, reason: "work_item_archived" };
  }
  if (!context.dispatchEnabled) return { allowed: false, reason: "dispatch_disabled" };
  if (!target.inRoster) return { allowed: false, reason: "agent_not_in_roster" };
  return { allowed: true };
}

/**
 * A2A 归因单源（§9 第 3 条）：主体**恒**取顶层人类 `initiatedBy`，永不取 `actor` ——
 * 人 U 触发 agent A、A 再 `@B` 时，权限按 U 能不能 invoke B 判定，不能按 A 的权限绕过允许名单。
 *
 * 实现体只读 `initiatedBy`（结构守卫 G1：函数体内连 `actor` 这个词都不出现）；入参签名强制给两个字段
 * （见 `AccessSubjectSource` 的 doc）。返回前过唯一一次规范化（Q7）：同一个人在两条 id 命名体系下
 * 落到同一个主体。
 */
export function resolveAccessSubject(input: AccessSubjectSource): AccessSubject {
  return normalizeAccessSubject(input.initiatedBy);
}

/** 拒绝文案**单源**（照既有先例：文本在纯模块、抛出在写者）。原因的解释文案在下面这张表里各一份。 */
const DENY_REASON_DETAILS: Record<CollaborationAccessDenyReason, string> = {
  work_item_archived: "工作项已归档：归档项不派发（§12.1-12「可审计不可派发」），审计事实照写",
  agent_not_in_roster: "目标不在名册：不可调起（§4.5 的级联只在名册内解析目标）",
  dispatch_disabled: "派发实验门禁已关闭：新的派发请求被拒（§12.1-12）",
};

/** 拒绝文案：必含原因 token 与主体 id（拒绝要能回答「谁被拒了、为什么」）。 */
export function collaborationAccessDeniedMessage(
  reason: CollaborationAccessDenyReason,
  subject: AccessSubject,
): string {
  return (
    `协作访问判据拒绝（原因=${reason}）：${DENY_REASON_DETAILS[reason]}。` +
    `被拒主体：${subject.kind}:${subject.id}。` +
    "写者必须响亮抛：权限失败不写半条 Comment、不留无来源的派发 receipt（§11.5）。"
  );
}

/**
 * 单人产品策略（缺省策略）：canView/canComment 恒放行，canInvoke 判目标与门禁。
 *
 * 为什么缺省是「放行策略」而不是「未注入 ⇒ 响亮抛」（与 `localHumanActor` 必填的口径不同）：
 * 缺省值在这里是**当前产品的正确策略**（单人下人类恒可读可写），不是「没接线的占位」——
 * 必填只会把产品状态伪装成装配错误。测试注入替代策略是本卡唯一的拒绝路径来源（§11.5 的测法）。
 */
export const SINGLE_USER_ACCESS_POLICY: CollaborationAccessPolicy = {
  canViewWorkItem,
  canCommentWorkItem,
  canInvokeTarget,
};
