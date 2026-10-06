import type { Squad, TeamAgent, WorkItem } from "@zcode/shared";
import type {
  AuthorRef,
  MentionRef,
  SquadSnapshot,
  WorkItemActivityKind,
  WorkItemActivityRecord,
  WorkItemCommentReactionRecord,
  WorkItemCommentRecord,
  WorkItemDecisionRecord,
} from "@zcode/services";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";

/* B5.1 轮 1：工作项详情页的**纯投影模型**（设计案 §2.2 / §2.3 / §3.1-§3.3 / §4.2）。

   为什么判据必须留在这里而不是组件里：ui 包没有渲染测试设施（node:test 的源码结构守卫 +
   纯函数逐格是本项目的既定做法，见 workItemsPage.test.ts 的文件头）。设计案 §2.2 明文
   「不在组件内部重新推导领域语义」—— 于是这些语义全部落在这个**纯函数模块**里。

   三条输入纪律：
   · 排序**不重排**：五个数组的口径由 repo 单源给出，本层只做投影（第二份判据会漂移且不报错）；
   · 不读时钟、不碰 i18n（文案键在下面的映射表里，组件再用 intl 翻）；
   · 缺锚不猜：缺锚实体给 link-error 条目，绝不用本地时间把它强插进主序。 */

/** 时间线主序：`WorkItemActivity.sequence ASC`（repo 已按 sequence → occurredAt → id 三键给出）。 */
export type TimelineEntry =
  | { kind: "comment"; key: string; sequence: number; comment: WorkItemCommentRecord }
  | { kind: "decision"; key: string; sequence: number; decision: WorkItemDecisionRecord }
  | { kind: "system"; key: string; sequence: number; activity: WorkItemActivityRecord }
  /**
   * 关联不可用（设计案 §2.2-6）：`sequence` 为 `null` = 该实体**没有任何锚定 Activity**，
   * 位置不可知，只能挂在时间线尾部（绝不按本地时间强插主序）。
   */
  | {
      kind: "link-error";
      key: string;
      sequence: number | null;
      subject: "comment" | "decision";
      id: string;
    };

/**
 * 每枚 Activity kind 的可见短句键（**闭集穷尽**）：`Record<WorkItemActivityKind, string>` 让将来
 * 新增 kind 直接**编译失败**（响亮），而不是界面上少一句话而仍显示。
 * 运行时 key 集合 == `WORK_ITEM_ACTIVITY_KINDS`（UI 测试用服务面导出的同一份闭集 deepEqual）。
 */
export const WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS: Record<WorkItemActivityKind, string> = {
  comment_created: "squad.workItemDetail.activity.kind.comment_created",
  comment_mention_parsed: "squad.workItemDetail.activity.kind.comment_mention_parsed",
  comment_dispatch_requested: "squad.workItemDetail.activity.kind.comment_dispatch_requested",
  comment_dispatch_suppressed: "squad.workItemDetail.activity.kind.comment_dispatch_suppressed",
  comment_deleted: "squad.workItemDetail.activity.kind.comment_deleted",
  comment_resolved: "squad.workItemDetail.activity.kind.comment_resolved",
  comment_reaction_added: "squad.workItemDetail.activity.kind.comment_reaction_added",
  decision_created: "squad.workItemDetail.activity.kind.decision_created",
  status_changed: "squad.workItemDetail.activity.kind.status_changed",
  assignee_changed: "squad.workItemDetail.activity.kind.assignee_changed",
  run_started: "squad.workItemDetail.activity.kind.run_started",
  run_completed: "squad.workItemDetail.activity.kind.run_completed",
  run_failed: "squad.workItemDetail.activity.kind.run_failed",
  run_cancelled: "squad.workItemDetail.activity.kind.run_cancelled",
  worktree_created: "squad.workItemDetail.activity.kind.worktree_created",
  worktree_merged: "squad.workItemDetail.activity.kind.worktree_merged",
  worktree_discarded: "squad.workItemDetail.activity.kind.worktree_discarded",
  wake_rule_fired: "squad.workItemDetail.activity.kind.wake_rule_fired",
};

/**
 * 与评论同 id 关联、**不另生成主条目**的六枚 kind（设计案 §2.2-4）：它们投影到相应评论的
 * 状态、操作结果或轻量系统注记 —— 一条「@agent 评论」不该是三条相同的视觉事件。
 */
const COMMENT_ATTACHED_ACTIVITY_KINDS: ReadonlySet<WorkItemActivityKind> = new Set([
  "comment_mention_parsed",
  "comment_dispatch_requested",
  "comment_dispatch_suppressed",
  "comment_deleted",
  "comment_resolved",
  "comment_reaction_added",
]);

export function buildWorkItemTimelineEntries(input: {
  comments: WorkItemCommentRecord[];
  activities: WorkItemActivityRecord[];
  decisions: WorkItemDecisionRecord[];
}): TimelineEntry[] {
  const commentsById = new Map(input.comments.map((comment) => [comment.id, comment]));
  const decisionsById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const anchoredCommentIds = new Set<string>();
  const anchoredDecisionIds = new Set<string>();
  const entries: TimelineEntry[] = [];

  for (const activity of input.activities) {
    /* 闭集外的 kind：读回层（repo）本来就会抛；这里再拦一道是因为**猜标签**的下场是界面显示
       一句错话而没有任何错误 —— 响亮抛是唯一不会骗人的处置。 */
    if (!Object.hasOwn(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS, activity.kind)) {
      throw new Error(
        `时间线遇到闭集外的 Activity kind「${String(activity.kind)}」：不猜标签，一律抛。`,
      );
    }
    if (activity.kind === "comment_created") {
      const anchorId = activity.commentId ?? activity.id;
      const comment =
        activity.commentId === null ? undefined : commentsById.get(activity.commentId);
      if (!comment) {
        entries.push({
          kind: "link-error",
          key: `link-error:comment:${anchorId}`,
          sequence: activity.sequence,
          subject: "comment",
          id: anchorId,
        });
        continue;
      }
      anchoredCommentIds.add(comment.id);
      entries.push({
        kind: "comment",
        key: `comment:${comment.id}`,
        sequence: activity.sequence,
        comment,
      });
      continue;
    }
    if (activity.kind === "decision_created") {
      const anchorId = activity.decisionId ?? activity.id;
      const decision =
        activity.decisionId === null ? undefined : decisionsById.get(activity.decisionId);
      if (!decision) {
        entries.push({
          kind: "link-error",
          key: `link-error:decision:${anchorId}`,
          sequence: activity.sequence,
          subject: "decision",
          id: anchorId,
        });
        continue;
      }
      anchoredDecisionIds.add(decision.id);
      entries.push({
        kind: "decision",
        key: `decision:${decision.id}`,
        sequence: activity.sequence,
        decision,
      });
      continue;
    }
    if (COMMENT_ATTACHED_ACTIVITY_KINDS.has(activity.kind)) continue;
    entries.push({
      kind: "system",
      key: `activity:${activity.id}`,
      sequence: activity.sequence,
      activity,
    });
  }

  /* 没有任何锚定 Activity 的实体：位置不可知（sequence=null）⇒ 挂在尾部而不是按本地时间强插。
     尾部次序仍用各自 repo 口径的输入顺序（评论 createdAt ASC / 决定 effectiveAt ASC），确定且可解释。 */
  for (const comment of input.comments) {
    if (anchoredCommentIds.has(comment.id)) continue;
    entries.push({
      kind: "link-error",
      key: `link-error:comment:${comment.id}`,
      sequence: null,
      subject: "comment",
      id: comment.id,
    });
  }
  for (const decision of input.decisions) {
    if (anchoredDecisionIds.has(decision.id)) continue;
    entries.push({
      kind: "link-error",
      key: `link-error:decision:${decision.id}`,
      sequence: null,
      subject: "decision",
      id: decision.id,
    });
  }
  return entries;
}

/* ---------- 正文 / 线程缩进 / reaction 汇总（设计案 §2.3、§3.1、§3.3） ---------- */

/** 正文投影：墓碑只给标记（**不带任何正文字段**，结构上漏不出正文）。 */
export type CommentDisplayBody = { kind: "deleted" } | { kind: "text"; text: string };

/**
 * 评论正文的显示优先级（设计案 §3.1）：`normalizedBody` 非空时优先，为空才回落 `body`。
 * **任何情况下都不在客户端重解析 `/note`** —— 原文只作审计数据，不作默认正文。
 */
export function commentDisplayBody(comment: WorkItemCommentRecord): CommentDisplayBody {
  if (comment.deletedAt !== null) return { kind: "deleted" };
  const normalized = comment.normalizedBody.trim();
  return { kind: "text", text: normalized.length > 0 ? comment.normalizedBody : comment.body };
}

export function indexWorkItemComments(
  comments: WorkItemCommentRecord[],
): Map<string, WorkItemCommentRecord> {
  return new Map(comments.map((comment) => [comment.id, comment]));
}

/** 线程缩进封顶（设计案 §2.3）：深度 ≥3 统一呈现为 3，用「回复给 {author}」补直接父级信息。 */
export const COMMENT_MAX_INDENT = 3;

/**
 * 从根到父**解析链**求深度（不是按相邻项推断，设计案 §2.3）：
 * 父链不可解析（父不在集合里）⇒ 就地停下 —— 不猜深度；成环 ⇒ 第二次遇到即停（不死循环）。
 */
export function commentIndentLevel(
  comment: WorkItemCommentRecord,
  commentsById: ReadonlyMap<string, WorkItemCommentRecord>,
): number {
  let depth = 0;
  let current = comment;
  const seen = new Set([comment.id]);
  while (current.parentCommentId !== null && depth < COMMENT_MAX_INDENT) {
    const parent = commentsById.get(current.parentCommentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/** 直接父评论（「回复给 {author}」的输入；父链不可解析 ⇒ `null`，界面不编一个名字出来）。 */
export function commentReplyParent(
  comment: WorkItemCommentRecord,
  commentsById: ReadonlyMap<string, WorkItemCommentRecord>,
): WorkItemCommentRecord | null {
  if (comment.parentCommentId === null) return null;
  return commentsById.get(comment.parentCommentId) ?? null;
}

export type CommentReactionGroup = {
  emoji: string;
  count: number;
  /** `null` = viewer 不可判定（无本地人类身份）⇒ 界面不渲染 `aria-pressed`、不显示「已回应」。 */
  mine: boolean | null;
  /** 首次回应时间（分组排序键）。 */
  firstAt: number;
};

/**
 * `(emoji, count)` 按**首次回应时间**稳定排序（设计案 §3.3）。
 * `mine` 只有在给了 `viewer` 时才可判定 —— 身份缺席（D1/C5）时返回 `null`，
 * 由界面决定不渲染 `aria-pressed`（**不得**假装「不是我」）。
 */
export function groupCommentReactions(
  reactions: WorkItemCommentReactionRecord[],
  viewer: AuthorRef | null,
): CommentReactionGroup[] {
  const groups = new Map<string, CommentReactionGroup>();
  for (const reaction of reactions) {
    const existing = groups.get(reaction.emoji);
    if (!existing) {
      groups.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        mine: viewer === null ? null : sameAuthor(reaction.author, viewer),
        firstAt: reaction.createdAt,
      });
      continue;
    }
    existing.count += 1;
    if (reaction.createdAt < existing.firstAt) existing.firstAt = reaction.createdAt;
    if (existing.mine === false && viewer !== null && sameAuthor(reaction.author, viewer)) {
      existing.mine = true;
    }
  }
  return [...groups.values()].sort(
    (left, right) => left.firstAt - right.firstAt || left.emoji.localeCompare(right.emoji),
  );
}

function sameAuthor(left: AuthorRef, right: AuthorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/* ---------- mention 呈现 / 指派文案（设计案 §3.2、§2.1） ---------- */

/** 名册的**来源快照**（同一 workspace 的 `SquadSnapshot.teamAgents` + `squads`，§4.2）。 */
export type MentionRoster = { agents: TeamAgent[]; squads: Squad[] };

/**
 * 一条持久化 mention 的呈现结论（设计案 §3.2）。权威是**存储的 mentions 快照**，
 * 不是拿当前文本重新判定 —— 本函数只做投影，不生成新提及、不改写存储的 mentions。
 */
export type MentionPresentation =
  | { kind: "agent"; id: string; name: string; colorClass: string; linkable: true }
  | { kind: "squad"; id: string; name: string; leaderName: string | null; linkable: true }
  | { kind: "all" }
  /** human：类型允许、写者当前不产出（C2）—— 普通文本、不链接、不着色（类型完备的防御分支）。 */
  | { kind: "human"; id: string }
  /** 名册里已不存在（含 unresolved 快照）：普通文本 + `?` 说明，**绝不**静默指向另一个 agent。 */
  | { kind: "unresolved"; type: MentionRef["type"]; id: string };

export function projectMention(mention: MentionRef, roster: MentionRoster): MentionPresentation {
  if (mention.type === "all") return { kind: "all" };
  if (mention.type === "human") return { kind: "human", id: mention.id };
  if (mention.type === "agent") {
    const agent = roster.agents.find((entry) => entry.id === mention.id);
    if (!agent) return { kind: "unresolved", type: "agent", id: mention.id };
    return {
      kind: "agent",
      id: agent.id,
      name: agent.name,
      // 身份色点（只编码身份，不编码状态）；未设色按名字稳定取一个（照 SquadAgentsList 的既有手法）。
      colorClass: SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
      linkable: true,
    };
  }
  const squad = roster.squads.find((entry) => entry.id === mention.id);
  if (!squad) return { kind: "unresolved", type: "squad", id: mention.id };
  const leader = roster.agents.find((entry) => entry.id === squad.leaderAgentId);
  return {
    kind: "squad",
    id: squad.id,
    name: squad.name,
    leaderName: leader?.name ?? null,
    linkable: true,
  };
}

/**
 * 详情页概览的指派文案：**委托** `resolveAssigneeName` 的既有唯一实现（与看板同一口径）。
 * 本函数只是详情页的命名入口，不写第二份「指派是谁」的判据 —— 第二份判据与第一份不一致时不报错。
 * `null` = 指派给当前用户，由界面用 `squad.common.assignee.user` 补文案。
 */
export function workItemDetailAssigneeLabel(
  workItem: WorkItem,
  snapshot: SquadSnapshot,
): string | null {
  return resolveAssigneeName(snapshot, workItem.assignee);
}

/* ---------- `/note` 显式模式（设计案 §4.3） ---------- */

const NOTE_PREFIX = "/note";

/**
 * 草稿是否已是 `/note` 模式：**以前缀为准**（用户手打 `/note` 时开关跟着亮），
 * 不靠开关自己记住 —— 两处状态各自记忆迟早分叉（开关说关、草稿其实带前缀）。
 * `/notes` 这类同前缀的别的词不算（必须是词边界）。
 */
export function draftHasNotePrefix(draft: string): boolean {
  return draft === NOTE_PREFIX || draft.startsWith(`${NOTE_PREFIX} `);
}

/**
 * 开关的二态动作：开启时在**未加前缀的**草稿开头插入 `/note `；关闭时**只移除自己插入的**开头前缀
 * （用户自己敲的正文一字不动）。已是开启态再点开启 ⇒ 只补一个空格，不重复插入前缀。
 */
export function toggleNotePrefix(draft: string, nextOn: boolean): string {
  if (!nextOn) {
    if (draft === NOTE_PREFIX) return "";
    return draft.startsWith(`${NOTE_PREFIX} `) ? draft.slice(NOTE_PREFIX.length + 1) : draft;
  }
  if (draft === NOTE_PREFIX) return `${NOTE_PREFIX} `;
  return draftHasNotePrefix(draft) ? draft : `${NOTE_PREFIX} ${draft}`;
}
