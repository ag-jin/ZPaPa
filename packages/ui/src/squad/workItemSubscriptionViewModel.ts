import {
  OPT_OUT_SCOPES,
  type OptOutScope,
  type SetWorkItemSubscriptionRequest,
  type SubscriberReason,
  type WorkItemSubscriberRecord,
} from "@zcode/services";

/* SUB.3a：**订阅面**在 UI 侧的判据单源（详情页控件 + 收件箱行退订共用）。
 *
 * 三件事只有这一处：
 * ① **文案映射**：六 reason → 「我为什么在这里」；两 scope → 「退订到哪一层」。
 *    两张表都是 `Record<闭集, string>`，服务面加一格 ⇒ 这里编译失败（界面上不会出现裸键）；
 * ② **我的那一行**：订阅读面给的是**该工作项的全部主体**（服务层不 filter，见 SUB.1 读模型），
 *    「哪一行是我的」必须由观察者身份判 —— 而观察者身份**只能来自读面**（`viewerActor`，D1-A：
 *    UI 不得自造身份）。本层只做 `(subjectType, subjectId) === (viewer.kind, viewer.id)` 的相等比较，
 *    **不在此处重实现任何 id 归一化**：写路径与读面用的是同一份规范化（组合根注入的本地人类身份），
 *    当前产品里 canonical 是归一化的不动点 ⇒ 两边对得上。自造第二份归一化会在「同一个人两个 id」
 *    时表现成「显示未订阅、退订却退得掉」；
 * ③ **两档退订**：确认态机（未确认 ⇒ 一级都不执行）+ 请求形状（退订必带范围）。
 *    两个入口（详情页、收件箱行）都走这里，于是「有哪些档、确认了哪一档、请求长什么样」各只一份。
 *
 * 与 `inboxViewModel` 的分工：那边管收件箱一行的呈现（kind 文案 / 次要行 / 穿透）；
 * 这边管订阅关系本身，两个面都会用到（详情页 + 收件箱行的「不再通知」）。 */

// ---------- ① 文案映射（两个闭集，穷尽） ----------

/**
 * reason → 文案 id（六格穷尽）。带占位符进 `squad.workItemDetail.subscription.status.subscribed`
 * 的 `{reason}`：界面上就是「关注中（创建者）」。
 */
export const SUBSCRIBER_REASON_MESSAGE_IDS: Record<SubscriberReason, string> = {
  creator: "squad.workItemDetail.subscription.reason.creator",
  assignee: "squad.workItemDetail.subscription.reason.assignee",
  commenter: "squad.workItemDetail.subscription.reason.commenter",
  mentioned: "squad.workItemDetail.subscription.reason.mentioned",
  delegated: "squad.workItemDetail.subscription.reason.delegated",
  manual: "squad.workItemDetail.subscription.reason.manual",
};

/**
 * 退订范围 → 文案 id（两档穷尽）。两档必须各说各话：`issue` = 只此条、`subtree` = 此条及全部子项
 * —— 同一句话会让用户分不清自己退订到哪一层（而后果是「我以为子项也不通知了」）。
 */
export const OPT_OUT_SCOPE_MESSAGE_IDS: Record<OptOutScope, string> = {
  issue: "squad.workItemDetail.subscription.scope.issue",
  subtree: "squad.workItemDetail.subscription.scope.subtree",
};

/** 状态三句 + 动作键（页头标签、订阅 / 退订按钮、两档确认标题）。 */
export const SUBSCRIPTION_STATUS_MESSAGE_IDS = {
  title: "squad.workItemDetail.subscription.title",
  none: "squad.workItemDetail.subscription.status.none",
  subscribed: "squad.workItemDetail.subscription.status.subscribed",
  unsubscribed: "squad.workItemDetail.subscription.status.unsubscribed",
  subscribe: "squad.workItemDetail.subscription.subscribe",
  unsubscribe: "squad.workItemDetail.subscription.unsubscribe",
  unsubscribeTitle: "squad.workItemDetail.subscription.unsubscribeTitle",
  unsubscribeHint: "squad.workItemDetail.subscription.unsubscribeHint",
  tombstoneHint: "squad.workItemDetail.subscription.tombstoneHint",
} as const;

// ---------- ② 我的那一行 → 控件状态三态 ----------

/**
 * 控件状态（判别联合）：
 * · `none`：**没有我的行**（不是「我不在订阅表里」的另一种说法 —— 它就是这一种）；
 * · `subscribed`：活动行（`tombstonedAt === null`），带最近一次事实给出的 `reason`；
 * · `unsubscribed`：**墓碑行**（显式退订），带用户选的 `scope`。
 *
 * 三态各自的文案键不在这里拼：视图层的 `{reason}` / `{scope}` 占位符由调用方填
 * （订阅与退订两句都带占位符，理由见 locales 的注释）。
 */
export type WorkItemSubscriptionView =
  | { status: "none" }
  | { status: "subscribed"; reason: SubscriberReason; reasonMessageId: string }
  | { status: "unsubscribed"; scope: OptOutScope; scopeMessageId: string };

/**
 * 判定「我」与这条工作项的订阅关系。
 *
 * 两列都判：**主体类型**与 id（`human:local-user` 与 `agent:local-user` 是两个人；只判 id 会把
 * agent 的行显示成我的，退订时退错人）。`viewerActor` 来自读面（`WorkItemCollaborationRead.viewerActor`），
 * 与写入口用的是组合根注入的**同一份身份** —— UI 从不自己拼一个 id。
 *
 * 找不到我的行 ⇒ `none`（**含**「我只在别的项上被订阅」这种情况：读面按工作项给行）。
 */
export function workItemSubscriptionView(input: {
  subscribers: readonly WorkItemSubscriberRecord[];
  viewerActor: { kind: string; id: string };
}): WorkItemSubscriptionView {
  const mine = input.subscribers.find(
    (row) => row.subjectType === input.viewerActor.kind && row.subjectId === input.viewerActor.id,
  );
  if (mine === undefined) return { status: "none" };
  /* 墓碑行的 `reason` 恒为 `manual`（退订行不承载「为什么订阅」），故两态各读各的列：
     判据是 `tombstonedAt`（活动行两档都可能是 issue，读 `optOutScope` 会把「关注中」显示成「已退订」）。 */
  if (mine.tombstonedAt !== null) {
    return {
      status: "unsubscribed",
      scope: mine.optOutScope,
      scopeMessageId: OPT_OUT_SCOPE_MESSAGE_IDS[mine.optOutScope],
    };
  }
  return {
    status: "subscribed",
    reason: mine.reason,
    reasonMessageId: SUBSCRIBER_REASON_MESSAGE_IDS[mine.reason],
  };
}

// ---------- ③ 两档退订：确认态机 + 请求形状（判据单源） ----------

/** 一次订阅动作的**意图**（用户点的是「订阅」还是「退订（哪一档）」）。 */
export type SubscriptionIntent =
  | { kind: "subscribe" }
  | { kind: "unsubscribe"; scope: OptOutScope };

/** 两档确认态（照 `CommentDeleteConfirmState` 的形态：状态与执行分离）。 */
export type UnsubscribeConfirmState = { pendingScope: OptOutScope | null };

export const UNSUBSCRIBE_CONFIRM_IDLE: UnsubscribeConfirmState = { pendingScope: null };

/** 打开确认：记下用户要退的那一档（这是**唯一**写 `pendingScope` 的入口）。 */
export function requestUnsubscribeConfirm(scope: OptOutScope): UnsubscribeConfirmState {
  return { pendingScope: scope };
}

/**
 * 确认态 → 可执行的那一档。`scope === null` = **没确认过**（一级都不执行）；
 * 状态与执行分离（先把待确认态收回空闲再执行），所以重复点确认不会执行第二次。
 */
export function confirmUnsubscribeScope(state: UnsubscribeConfirmState): {
  scope: OptOutScope | null;
  next: UnsubscribeConfirmState;
} {
  return { scope: state.pendingScope, next: UNSUBSCRIBE_CONFIRM_IDLE };
}

/** 两档的**选项表**（成员来自服务面闭集，顺序由它给出：只此条 → 此条及子项），两个入口共用一份。 */
export function unsubscribeScopeChoices(): { scope: OptOutScope; messageId: string }[] {
  return OPT_OUT_SCOPES.map((scope) => ({ scope, messageId: OPT_OUT_SCOPE_MESSAGE_IDS[scope] }));
}

/**
 * 意图 → 服务面请求（**唯一**产出退订请求的地方）。
 *
 * 为什么不让调用面各自拼：`SetWorkItemSubscriptionRequest` 是判别联合（退订必带范围），
 * 两处各拼一次就多一处「忘了带范围」的机会，而漏掉的表现是服务面拿不到档 —— 只能猜一个默认档，
 * 猜错就是「我退订了，子项还在通知我」。
 */
export function subscriptionRequestFor(
  workItemId: string,
  intent: SubscriptionIntent,
): SetWorkItemSubscriptionRequest {
  return intent.kind === "subscribe"
    ? { workItemId, subscribed: true }
    : { workItemId, subscribed: false, scope: intent.scope };
}
