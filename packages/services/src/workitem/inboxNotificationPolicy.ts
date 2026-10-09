import { WORK_ITEM_MAX_DEPTH } from "@zcode/shared";
import {
  INBOX_SEVERITY_BY_KIND,
  type InboxItemInput,
  type InboxItemKind,
  type InboxItemSeverity,
} from "./inboxItemRepo.js";
import {
  buildCommentAttentionInboxItem,
  buildDecisionRequiredInboxItem,
  buildMentionActionRequiredInboxItem,
} from "./inboxItemProducers.js";
import type { OptOutScope, SubscriberSubject, SubscriberSubjectType } from "./subscriberFacts.js";

/* Subscriber 完整语义线 SUB.2：Inbox 通知策略的**纯判据面**（零 IO、零 `node:` 值导入、
   无时钟无随机）。三件事各一处实现：

   ① **三新 kind 的产生准入**（`planInboxNotificationItem`）：一条评论/决定要不要落一条新条目。
      公共前置是**作者排除**（自己做的事不通知自己）；kind 的优先级与收件人来源也在这一处。
   ② **投递档**（`resolveInboxDeliveryTier`）：推渠道还是只落 Inbox —— 由既有单源
      `INBOX_SEVERITY_BY_KIND` 派生，本模块**不新增第二张 kind→推/不推 的表**。
   ③ **收件人解析**（`resolveInboxRecipients`）：本项订阅者 ∪ 祖先链订阅者（冒泡），再按
      tombstone / `opt_out_scope` 静音过滤。

   为什么三件事必须互相看得见：它们读的是同一批订阅行与同一个事实。「谁收得到」与「要不要产生」
   由两个模块各判一次时，漂移不报错 —— 表现是「订阅有人说收得到，而条目根本没产生」。

   与调用的关系：**本模块只回答结论**，写库仍归唯一写收口（`inboxItemRepo.insertIfAbsent`）。
   订阅面（SUB.1）与 Inbox 面（本模块）都不参与「哪条事实进 Inbox」之外的判定：
   订阅只是同一产生点的收件人面，不是第二消费者。 */

/**
 * 判据读到的一行订阅关系（`workItemSubscriberRepo` 记录的**结构子集**：多出的列不影响判据）。
 * 用记录的子集而不是再造一个投影类型：调用方把 repo 行原样递进来，不会因为字段名对不上而静默读空。
 */
export type InboxSubscriberRow = {
  subjectType: SubscriberSubjectType;
  subjectId: string;
  /** 非空 = **显式退订**（用户意愿）。 */
  tombstonedAt: number | null;
  /** 只在 tombstone 行上有语义（活动行恒 `issue`）。 */
  optOutScope: OptOutScope;
};

/** 一个**收件人**（通知投递的对象）与它怎么被解析出来。 */
export type InboxRecipient = {
  subject: SubscriberSubject;
  /**
   * 命中路径：`direct` = **本项**（事实所在工作项）自身的活动订阅行；
   * `ancestor` = 经祖先链冒泡命中（父子冒泡）。
   */
  via: "direct" | "ancestor";
  /** `direct` 恒等于事实所在工作项；`ancestor` 是**命中订阅的那一级祖先**（最近者优先）。 */
  fromWorkItemId: string;
};

/** 主体的稳定键（行上没有 id 列以外的身份，键只用于去重与集合判断，不解析、不持久化）。 */
function subjectKey(subject: SubscriberSubject): string {
  return `${subject.kind}:${subject.id}`;
}

function rowSubjectKey(row: InboxSubscriberRow): string {
  return `${row.subjectType}:${row.subjectId}`;
}

/** 收件人排序口径的单处定义：主体键升序（呈现在渠道摘要里不随存储顺序漂移）。 */
function compareRecipients(left: InboxRecipient, right: InboxRecipient): number {
  const a = subjectKey(left.subject);
  const b = subjectKey(right.subject);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * **收件人解析**（纯函数）：给定事实所在工作项，读本项与祖先链的订阅行，给出收件人集合。
 *
 * 上溯的**唯一**驱动是注入的两口读（`readSubscribers` / `readParentId`）—— 判据不碰 repo、
 * 不碰树，测试用行集字面量即可逐格走矩阵。上溯在**工作项树自身的深度上界**
 * （`WORK_ITEM_MAX_DEPTH`，含自身）处停下：树比它深已经是坏数据（`WorkItemService.validateParent`
 * 拦创建），这里多走一级只会多读一行不可能存在的祖先；坏父链（环）另由 `visited` 兜住。
 *
 * 静音规则（拆解报告 §2.3/§2.5 逐条）：
 * · **本项**上的 tombstone 行（任一档）= 「这条工作项别再通知我」⇒ 该主体对本项事实静音；
 * · **祖先**上的 tombstone 行**只有 `subtree` 档**静音后代 —— 那是「这一条及其全部后代」；
 *   `issue` 档只退那一条祖先，不干扰子项经冒泡的投递；
 * · **直接订阅 > 祖先静音**：本项自身的活动行不受祖先静音影响（用户对**这一条**明确订阅过）。
 *
 * 由此，「我关注的工作项」= 本项活动行（direct）∪ 祖先活动行（ancestor）减去静音；
 * 返回 `via` / `fromWorkItemId` 让冒泡**可观察**（否则它在单人类下的唯一痕迹只有渠道推送）。
 */
export function resolveInboxRecipients(input: {
  /** 事实所在的工作项（评论/决定挂在它上面）。 */
  workItemId: string;
  /** 读一个工作项的订阅行（**含 tombstone 行**）；调用方绑定到 `repo.listByWorkItem`。 */
  readSubscribers: (workItemId: string) => readonly InboxSubscriberRow[];
  /** 上溯一步（父 id；`null` = 已到根）。调用方绑定到工作项树。 */
  readParentId: (workItemId: string) => string | null;
}): InboxRecipient[] {
  const levels: Array<{ workItemId: string; rows: readonly InboxSubscriberRow[] }> = [];
  const visited = new Set<string>();
  let cursor: string | null = input.workItemId;
  while (cursor !== null && levels.length < WORK_ITEM_MAX_DEPTH && !visited.has(cursor)) {
    visited.add(cursor);
    levels.push({ workItemId: cursor, rows: input.readSubscribers(cursor) });
    cursor = input.readParentId(cursor);
  }

  /* 静音集合**先算完再判**：祖先链是倒着读的（先本项后父），若边读边判，
     命中顺序就会影响「先看到活动行还是先看到墓碑」的结论 —— 同一棵树两种答案。 */
  const muted = new Set<string>();
  levels.forEach((level, index) => {
    for (const row of level.rows) {
      if (row.tombstonedAt === null) continue;
      if (index === 0 || row.optOutScope === "subtree") muted.add(rowSubjectKey(row));
    }
  });

  const recipients = new Map<string, InboxRecipient>();
  levels.forEach((level, index) => {
    for (const row of level.rows) {
      if (row.tombstonedAt !== null) continue;
      const key = rowSubjectKey(row);
      // 近的优先：本项先于祖先；祖先之间先读到的是最近的一级。
      if (recipients.has(key)) continue;
      // 冒泡投递受静音约束；本项的直接订阅不受（「直接订阅 > 祖先静音」）。
      if (index > 0 && muted.has(key)) continue;
      recipients.set(key, {
        subject: { kind: row.subjectType, id: row.subjectId },
        via: index === 0 ? "direct" : "ancestor",
        fromWorkItemId: level.workItemId,
      });
    }
  });

  return [...recipients.values()].sort(compareRecipients);
}

/* ---------- ① 准入：三新 kind 的「要不要产生一条新条目」 ---------- */

/**
 * 一条评论的通知事实（**产生点只报事实**：谁写的、写了哪条、点名了谁）。
 *
 * · `author` 是**已归一**的可通知主体（Q4 单源在 `subscriberFacts`；`system` 作者由调用方排除 ——
 *   它不是可通知对象，也不会成为收件人）；
 * · `mentioned` 是显式点名的**主体**（`@agent` / `@squad`）—— 取值来源是
 *   `subscriberFacts.subscriberFactsForComment` 的 `mentioned` 集合（`@all` 只广播不 fan-out、
 *   `@人名` 名册未接通、`unresolved` 不猜身份，三格在那一处已排除）。本模块**不重判一遍**
 *   「哪种点名算数」：两份判据各自演化时，表现是「订阅表建了行而收件箱没通知」；
 * · `workItemTitle`（拿不到 ⇒ `null`）与两个 workspace 字段原样进条目（title 回落口径在构建件）。
 */
export type CommentNotificationFact = {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  workItemTitle: string | null;
  commentId: string;
  author: SubscriberSubject;
  mentioned: readonly SubscriberSubject[];
};

/** 一条决定的通知事实（决定没有点名面：收件人恒由订阅解析给出）。 */
export type DecisionNotificationFact = {
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  workItemTitle: string | null;
  decisionId: string;
  author: SubscriberSubject;
};

/** 通知事实的判别联合（一条评论 / 一条决定）。 */
export type InboxNotificationFact =
  | ({ kind: "comment" } & CommentNotificationFact)
  | ({ kind: "decision" } & DecisionNotificationFact);

function subjectsExcept(
  subjects: readonly SubscriberSubject[],
  author: SubscriberSubject,
): SubscriberSubject[] {
  const authorKey = subjectKey(author);
  const seen = new Set<string>();
  const others: SubscriberSubject[] = [];
  for (const subject of subjects) {
    const key = subjectKey(subject);
    if (key === authorKey || seen.has(key)) continue;
    seen.add(key);
    others.push(subject);
  }
  return others;
}

/**
 * **三新 kind 的唯一准入**：给定一条事实与两口读，回答「要不要产生条目、产生哪一条」。
 * 返回 `null` = 不产生（唯一原因：**没有非本人的收件人**）。
 *
 * 三条规则（拆解报告 §2.2，逐条落地）：
 *
 * 1. `mention_action_required`：评论命中**显式点名**且被点名者非作者 —— 收件人由点名给定
 *    （不需要任何订阅行：对着某个人说的一句话本身就是通知）。**一条评论至多一条条目**：
 *    点名是更强的事实（`action_required`），故它压过 `comment_attention`；同一句评论在收件箱里
 *    出现两次会是「同一件事两条」（条目按事实去重，而收件人面在这里就已经收窄成一条）。
 * 2. `decision_required`：决定事实且存在非作者的收件人。
 * 3. `comment_attention`：评论且存在非作者的收件人（订阅解析：本项 ∪ 祖先冒泡，见
 *    `resolveInboxRecipients`）。
 *
 * **作者排除是这三格的公共前置**：自己做的事不通知自己 —— 单人产品下人类作者恒是自己那条订阅行
 * 的主体，故这一条同时也是「自通知」的机械解法（本仓没有第二处判「谁不该被通知」）。
 *
 * 点名面**不过静音过滤**（与订阅投递的分界）：退订静音的是「订阅投递」，而显式点名是对着人说的一句话；
 * 把点名也静音会让「有人明确请你回应」无声消失。点名者的退订在**订阅面**照旧生效（SUB.1 的
 * reconciler：墓碑行不被 `mentioned` 复活）。
 *
 * 本函数**不做 IO**：写库仍归唯一写收口（`inboxItemRepo.insertIfAbsent`），返回的是构建件产物。
 */
export function planInboxNotificationItem(input: {
  fact: InboxNotificationFact;
  readSubscribers: (workItemId: string) => readonly InboxSubscriberRow[];
  readParentId: (workItemId: string) => string | null;
}): InboxItemInput | null {
  const { fact } = input;

  if (fact.kind === "comment") {
    const mentioned = subjectsExcept(fact.mentioned, fact.author);
    if (mentioned.length > 0) {
      return buildMentionActionRequiredInboxItem({
        workspaceKey: fact.workspaceKey,
        workspacePath: fact.workspacePath,
        workItemId: fact.workItemId,
        workItemTitle: fact.workItemTitle,
        commentId: fact.commentId,
        author: fact.author,
        mentioned,
      });
    }
  }

  const recipients = resolveInboxRecipients({
    workItemId: fact.workItemId,
    readSubscribers: input.readSubscribers,
    readParentId: input.readParentId,
  })
    .map((recipient) => recipient.subject)
    .filter((subject) => subjectKey(subject) !== subjectKey(fact.author));
  if (recipients.length === 0) return null;

  const common = {
    workspaceKey: fact.workspaceKey,
    workspacePath: fact.workspacePath,
    workItemId: fact.workItemId,
    workItemTitle: fact.workItemTitle,
    author: fact.author,
    recipients,
  };
  return fact.kind === "comment"
    ? buildCommentAttentionInboxItem({ ...common, commentId: fact.commentId })
    : buildDecisionRequiredInboxItem({ ...common, decisionId: fact.decisionId });
}

/* ---------- ② 投递档：推渠道 还是 只落 Inbox ---------- */

/** 一条条目的投递档：`push` = 需人介入（进渠道推送面，投递实现归 SUB.3b）；`inbox_only` = 只落 Inbox。 */
export const INBOX_DELIVERY_TIERS = ["push", "inbox_only"] as const;
export type InboxDeliveryTier = (typeof INBOX_DELIVERY_TIERS)[number];

/**
 * severity → 投递档（**唯一**一处「多急才推」的判据）：要人介入的两级推，`info` 只落 Inbox。
 *
 * 为什么按 severity 而不是按 kind 再列一张表：kind→severity 的单源已经在 `inboxItemRepo`；
 * 若本模块再按 kind 列一张「推/不推」，两处会各自演化且**漂移不报错**（表现是「界面说这事很急，
 * 而渠道从不推它」）。三键 Record 让「severity 加了第四级」变成编译错，而不是默认不推。
 */
const DELIVERY_TIER_BY_SEVERITY: Record<InboxItemSeverity, InboxDeliveryTier> = {
  action_required: "push",
  attention: "push",
  info: "inbox_only",
};

/** 某 kind 的投递档：`severity` 走单源映射，档再走上面那张三键表（链上没有任何第二份 kind 表）。 */
export function resolveInboxDeliveryTier(kind: InboxItemKind): InboxDeliveryTier {
  return DELIVERY_TIER_BY_SEVERITY[INBOX_SEVERITY_BY_KIND[kind]];
}
