import type { AuthorRef } from "./workItemCommentRepo.js";
import type { WorkItem } from "@zcode/shared";
import { normalizeAccessSubject } from "./collaborationAccessPolicy.js";
import type { ParsedMention } from "./commentParser.js";
import { reconcileSubscriberFacts, type SubscriberFact } from "./subscriberReconciler.js";
import type { WorkItemSubscriberRepo } from "./workItemSubscriberRepo.js";

/* Subscriber 完整语义线 SUB.1：订阅关系的**词汇单源**（三个闭集 + 事实形状 + 唯一的规范化入口）。

   本文件必须保持**浏览器安全**（`workItemCollaborationService` 值导入它，而该门面经
   `packages/services/src/index.ts` 出值到 renderer）：只 `import type`，不触达 `node:*`。

   三个闭集（`SUBSCRIBER_REASONS` / `SUBSCRIBER_SUBJECT_TYPES` / `OPT_OUT_SCOPES`）是
   `work_item_subscribers` 上三个枚举列的**唯一取值来源**（spec §3.7 / §7.1 冻结）：
   写路径与读路径的守卫都取它，不存在「类型加了一档、守卫还认旧集」的静默分叉。

   为什么 `reason` 里**没有** `autopilot` 一类扩展（multica 有）：本仓没有自动接管工作项的形态，
   发明一格会让「谁在替我盯着」变成没有对应事实的悬空枚举。

   主体规范化的**单源**在 `collaborationAccessPolicy.normalizeAccessSubject`（Q4 裁定）——
   本模块只**调用**它（下面两个 `subscriberSubjectOf*` 是订阅侧的入口），不实现第二份。 */

/** 六 reason 闭集（spec §7.1 的六行事实表逐字）。 */
export const SUBSCRIBER_REASONS = [
  "creator",
  "assignee",
  "commenter",
  "mentioned",
  "delegated",
  "manual",
] as const;
export type SubscriberReason = (typeof SUBSCRIBER_REASONS)[number];

/**
 * **自动**五格（= 六 reason 去掉 `manual`）：由事实生产点驱动，可能被后来的事实改写或被撤销。
 * `manual` 是用户自己的意思，自动规则既不删也不改（spec §7.1「不被自动规则删除」）。
 */
export const AUTOMATIC_SUBSCRIBER_REASONS = [
  "creator",
  "assignee",
  "commenter",
  "mentioned",
  "delegated",
] as const;
export type AutomaticSubscriberReason = (typeof AUTOMATIC_SUBSCRIBER_REASONS)[number];

/** 用户手工订阅的 reason（自动规则的禁区；复活后也归它）。 */
export const MANUAL_SUBSCRIBER_REASON = "manual" as const;

/**
 * 负责人关系两格：`assignee`（创建时带负责人 / 用户改派）与 `delegated`（队长派单工具）。
 * 两者都是「我是当前负责人」，故**改派时一起撤销**——只撤一格会让队长派单来的旧负责人
 * 在改派后仍然留在订阅表里（而库里负责人已经换人）。
 */
export const ASSIGNMENT_SUBSCRIBER_REASONS = [
  "assignee",
  "delegated",
] as const satisfies readonly SubscriberReason[];

/** 订阅主体三值（协作者词汇，**不含 system**：system 不是可通知对象，没有对应的订阅行）。 */
export const SUBSCRIBER_SUBJECT_TYPES = ["human", "agent", "squad"] as const;
export type SubscriberSubjectType = (typeof SUBSCRIBER_SUBJECT_TYPES)[number];

/** 退订范围两档（spec §3.7 `optOutScope`）：`issue` = 只此条；`subtree` = 此条及其全部后代。 */
export const OPT_OUT_SCOPES = ["issue", "subtree"] as const;
export type OptOutScope = (typeof OPT_OUT_SCOPES)[number];

/**
 * 订阅主体（`{kind, id}` 的规范化结果）。与 `AccessSubject`（= 评论/决定的审计身份 `AuthorRef`）
 * 同形但不含 `system`：三值闭集是存储列的取值域。
 */
export type SubscriberSubject = {
  kind: SubscriberSubjectType;
  id: string;
};

/**
 * 订阅主体的规范化入口：**只对审计三值有定义的那部分**调用 Q4 的那个单源函数
 * （`normalizeAccessSubject` 的取值域是 `AuthorRef` = human / agent / system）。
 *
 * `squad` 不在审计轴里（它不是「谁做了这件事」，而是「哪个队」），没有任何 id 归一规则可言，
 * 故原样通过 —— 这不是第二份判据：**唯一的规则**（`{human,"user"} ⇒ human:local-user`）仍然只在
 * `collaborationAccessPolicy` 里实现，这里只是把调用面的取值域对齐，不用类型断言谎报。
 */
function normalizeSubscriberSubject(subject: SubscriberSubject): SubscriberSubject {
  if (subject.kind === "squad") return subject;
  /* 只取规范化后的 **id**：单源函数唯一的规则就是换 id（`{human,"user"} ⇒ human:local-user`），
     kind 不在它的改写面内 —— 这样调用面不必用类型断言谎报取值域。 */
  const { id } = normalizeAccessSubject({ kind: subject.kind, id: subject.id });
  return { kind: subject.kind, id };
}

/**
 * 评论/决定等**审计身份** → 订阅主体（Q4 规范化单源）。`system` **必须由调用方先排除**
 * （它不是可通知对象）：走到这里说明事实点漏了一格，响亮抛而不是静默跳过 —— 静默会表现为
 * 「账号评论了但没人被订阅」而全链不报错。
 */
export function subscriberSubjectOfActor(actor: AuthorRef): SubscriberSubject {
  if (actor.kind === "system") {
    throw new Error(
      "system 不是订阅主体（订阅表只认 human / agent / squad）：调用方必须在报事实之前排除它。",
    );
  }
  return normalizeSubscriberSubject({ kind: actor.kind, id: actor.id });
}

/**
 * 工作项**负责人** → 订阅主体（Q4）：`type:"user"` 是界面上的占位（`WORK_ITEM_USER_ASSIGNEE_ID`
 * 的值 `"user"`），经 `normalizeAccessSubject` 归到审计侧 canonical（`human:local-user`）——
 * 不归一就会让「同一个人」在库里长成两行（`user:user` 与 `human:local-user`），
 * 而退订只退得掉其中一行。
 */
export function subscriberSubjectOfAssignee(assignee: WorkItem["assignee"]): SubscriberSubject {
  const kind: SubscriberSubjectType = assignee.type === "user" ? "human" : assignee.type;
  return normalizeSubscriberSubject({ kind, id: assignee.id });
}

/** 工作项**创建人** → 订阅主体；`system` 创建不产订阅行（返回 null，由调用方跳过）。 */
export function subscriberSubjectOfCreator(
  creator: { kind: "human" | "agent" | "system"; id: string } | undefined | null,
): SubscriberSubject | null {
  if (!creator || creator.kind === "system") return null;
  return subscriberSubjectOfActor({ kind: creator.kind, id: creator.id });
}

/* ---------- 事实出口：唯一 applier + 权威录制口（事实生产点只碰这两样） ---------- */

/**
 * 事实录制口（**事实生产点唯一能碰的东西**）：只报「哪个工作项 + 哪条事实」，
 * 拿不到 repo、拼不出 SQL、写不出判据 —— 于是「订阅行怎么写」只有一处实现。
 */
export type SubscriberFactRecorder = (input: { workItemId: string; fact: SubscriberFact }) => void;

/**
 * **唯一 applier**：读当前行状态 → 交唯一 reconciler 判 → 恰好一条语句落下结论。
 *
 * 为什么写库要在**这一处**：五条消解规则的组合一旦散到调用面，每处只写自己那条，
 * 组合错误不报错。并发正确性不靠这里的读（见 reconciler 的说明）：存储层语句自带
 * 「墓碑 / manual 保护区」谓词，读到的陈旧值最坏把一次写变成空写。
 */
export function applySubscriberFact(
  repo: WorkItemSubscriberRepo,
  workspace: { key: string; path: string },
  workItemId: string,
  fact: SubscriberFact,
): void {
  const key = {
    workspaceKey: workspace.key,
    workItemId,
    subjectType: fact.subject.kind,
    subjectId: fact.subject.id,
  };
  const current = repo.get(key);
  const decision = reconcileSubscriberFacts(
    current === null
      ? null
      : {
          reason: current.reason,
          tombstonedAt: current.tombstonedAt,
          optOutScope: current.optOutScope,
        },
    fact,
  );
  switch (decision.action) {
    case "none":
      return;
    case "subscribe":
      repo.upsertActive({ ...key, workspacePath: workspace.path, reason: decision.reason });
      return;
    case "tombstone":
      repo.upsertTombstone({ ...key, workspacePath: workspace.path, scope: decision.scope });
      return;
    case "clear_tombstone":
      repo.clearTombstone(key);
      return;
    case "revoke":
      repo.revokeAssignment(key);
      return;
  }
}

/**
 * 事实生产点用的**权威录制口**（把 repo + 本次 workspace 收窄成「只报事实」）。
 *
 * **失败面**：订阅行是**已落地事实的派生投影**（创建人/负责人/评论都是 durable 事实，
 * 订阅表可由它们重建），故登记失败**不得抛**——抛出去会把一次成功的建项/评论翻转成响亮失败，
 * 而主事实不回滚（与 `workItemActivityProjector` 的失败面同一条裁定）。失败经 `logWarn` 留痕，
 * 绝不静默；库级损坏由下一次事实写响亮兜底。
 */
export function createSubscriberFactRecorder(
  repo: WorkItemSubscriberRepo,
  workspace: { key: string; path: string },
  logWarn: (message: string, error?: unknown) => void = (message) => console.warn(message),
): SubscriberFactRecorder {
  return ({ workItemId, fact }) => {
    try {
      applySubscriberFact(repo, workspace, workItemId, fact);
    } catch (error) {
      logWarn(
        `订阅事实落库失败（workItem=${workItemId}, fact=${fact.kind}, ` +
          `subject=${fact.subject.kind}:${fact.subject.id}）：` +
          "订阅行是事实落地之后的派生投影，失败只留痕、不改判——已落地的事实不因投影缺失而回滚。",
        error,
      );
    }
  };
}

/* ---------- 事实 → 事实对象（生产点不自拼 reason 的**唯一**映射处） ---------- */

/**
 * 创建工作项产出的两个事实（拆解报告 §2.1 的事实表：`creator` 与创建时的 `assignee`）。
 *
 * **次序是语义**：先报负责人（创建时的初始指派），后报创建人。两条同刻事实落在**同一主体**时
 * （单人产品最常见：人建项并指派给自己），`reason` 因此落 `creator` —— spec §7.1 明文
 * 「记录创建者，**不因后续改派消失**」：若落 `assignee`，此后一次改派就会把这条行当作
 * 「旧负责人关系」撤销掉，创建人从此不在册（而库里没有任何地方记着这件事）。
 */
export function subscriberFactsForCreatedWorkItem(input: {
  assignee: WorkItem["assignee"];
  creator?: { kind: "human" | "agent" | "system"; id: string } | null;
}): SubscriberFact[] {
  const facts: SubscriberFact[] = [
    { kind: "subscribe", reason: "assignee", subject: subscriberSubjectOfAssignee(input.assignee) },
  ];
  const creator = subscriberSubjectOfCreator(input.creator);
  if (creator !== null) facts.push({ kind: "subscribe", reason: "creator", subject: creator });
  return facts;
}

/**
 * 改派产出的两个事实：新负责人入册（`cause` 决定 `assignee` / `delegated`）+ 旧负责人关系撤销。
 *
 * `cause` 是**调用面的事实**（队长工具 / 用户改派 / 归档转交），本函数只做映射（reason 字面量
 * 只在这里出现一次）。同主体改派（重投同一负责人）**不产撤销事实**：撤销是「关系结束」，
 * 而这里关系没结束（否则会把刚写下的行删掉）。
 */
export const ASSIGNMENT_CHANGE_REASONS = {
  leader_tool: "delegated",
  user_reassign: "assignee",
  /** 小队归档 ⇒ 负责人转交队长：同样「换成这个 agent」，但它是转交不是派发（不发明派发成因）。 */
  squad_archived_transfer: "assignee",
} as const satisfies Record<string, AutomaticSubscriberReason>;

export type AssignmentChangeCause = keyof typeof ASSIGNMENT_CHANGE_REASONS;

export function subscriberFactsForAssigneeChange(input: {
  from: WorkItem["assignee"];
  to: WorkItem["assignee"];
  cause: AssignmentChangeCause;
}): SubscriberFact[] {
  const facts: SubscriberFact[] = [];
  const next = subscriberSubjectOfAssignee(input.to);
  const previous = subscriberSubjectOfAssignee(input.from);
  facts.push({ kind: "subscribe", reason: ASSIGNMENT_CHANGE_REASONS[input.cause], subject: next });
  if (previous.kind !== next.kind || previous.id !== next.id) {
    facts.push({ kind: "revoke", subject: previous });
  }
  return facts;
}

/**
 * 写评论产出的订阅事实：作者落 `commenter`（**写成功才报**——「不能仅因浏览评论订阅」，spec §7.1），
 * 显式点名落 `mentioned`。
 *
 * 三格**不产**订阅行，且都不是「待办」而是**定义**：
 * · `@all`：只广播，不 fan-out（spec §12.1-3 明文「不开 run、不建订阅、不产生通知」）；
 * · `human` 点名：人类名册未接通（Q5 登记不可达）——没有名字来源就不猜身份；
 * · `unresolved`：名册缺席 / 重名，本就不猜身份；
 * 另外 `system` 作者不是可通知对象，同样不入册。
 */
export function subscriberFactsForComment(input: {
  author: AuthorRef;
  mentions: readonly ParsedMention[];
}): SubscriberFact[] {
  const facts: SubscriberFact[] = [];
  if (input.author.kind !== "system") {
    facts.push({
      kind: "subscribe",
      reason: "commenter",
      subject: subscriberSubjectOfActor(input.author),
    });
  }
  for (const mention of input.mentions) {
    if (mention.kind === "agent") {
      facts.push({
        kind: "subscribe",
        reason: "mentioned",
        subject: normalizeSubscriberSubject({ kind: "agent", id: mention.agentId }),
      });
    } else if (mention.kind === "squad") {
      facts.push({
        kind: "subscribe",
        reason: "mentioned",
        subject: normalizeSubscriberSubject({ kind: "squad", id: mention.squadId }),
      });
    }
  }
  return facts;
}

/**
 * 从一批订阅事实里取**点名**子集（`@人名` 命中的订阅主体）：收件箱通知口的 `mentioned` 入参。
 *
 * 为什么给具名选择器而不是让消费面自拼 `fact.reason === "mentioned"`：六 reason 的拼写只在
 * 本模块（词表单源），消费面按名字取结论 —— 闭集加档 / 改名时不必去消费面搜字符串。
 * 只认 `subscribe` 且 reason 命中：作者那条 `commenter`、负责人撤销、手动两向都不入选
 * （「点名压过关注」的判据在 `inboxNotificationPolicy` 一处，不在这里重判）。
 */
export function mentionedSubscriberSubjects(facts: readonly SubscriberFact[]): SubscriberSubject[] {
  return facts.flatMap((fact) =>
    fact.kind === "subscribe" && fact.reason === "mentioned" ? [fact.subject] : [],
  );
}
