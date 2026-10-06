/* oxlint-disable eslint(max-lines) -- 触发判据（纯函数）+ 队列状态窗裁决 + 事实写入刻意同文件：
   结构守卫（测试）要能一眼确认「从解析到 receipt 的整条路径」里没有任何生命周期写入口，
   拆文件会把这条路径的证明面切碎。与 squadRunRepo 的 max-lines 例外同款理由。 */
import { randomUUID } from "node:crypto";
import type { WorkItem } from "@zcode/shared";
import {
  parseComment,
  toMentionRefs,
  type ParsedMention,
  type RosterIndex,
} from "./commentParser.js";
import { computeCommentDispatchKey } from "./commentDispatchKey.js";
import type { SquadDispatchRequest } from "./squadDispatchRequests.js";
import type {
  CommentDispatchOutcome,
  CommentDispatchReceiptRecord,
  CommentDispatchReceiptRepo,
  CommentDispatchSource,
} from "./commentDispatchReceiptRepo.js";
import type { SquadDeferredDispatchRepo } from "./squadDeferredDispatchRepo.js";
import type { SquadRunRepo } from "./squadRunRepo.js";
import type { WorkItemActivityRepo } from "./workItemActivityRepo.js";
import type {
  AuthorRef,
  CommentCommand,
  InlineAnchor,
  SourceRunRef,
  WorkItemCommentRecord,
  WorkItemCommentRepo,
} from "./workItemCommentRepo.js";
import type {
  WorkItemCommentReactionRecord,
  WorkItemCommentReactionRepo,
} from "./workItemCommentReactionRepo.js";
import type { WorkItemRepo } from "./workItemRepo.js";

/* 协作域 X1.2：CommentService 的编排层。三半：
   ① `resolveCommentTrigger`——**纯函数**（无 IO/无时钟）的七级隐式路由级联（spec §4.5，命中即止）。
      X1.3/X2.x 复用同一份判据，不得在 receipt 层重写一套。
   ② `createComment`——写评论事实 + Activity + 按队列状态窗裁决落 receipt（本文件下半部）。
   ③ 三件套动作（X1.3 修复轮补）：`softDeleteComment` / `setCommentResolved` / `addCommentReaction`
      ——各自落存储事实 + 一枚 Activity（§3.2），且**永不触发派发**（§4.4）。
   §5.2 明令：本文件**不得**调小队开跑 / 队长登记 / 派发规划等生命周期写入口——评论只产生
   派发**请求事实**，实际开 run 归 X2.1 的 host 接线（结构守卫见测试）。 */

/** 触发目标：谁 + 哪一源（五源闭集，§4.5）。 */
export type CommentTriggerTarget = { agentId: string; source: CommentDispatchSource };

/** 抑制（有明确「不派发」语义，写 comment_dispatch_suppressed Activity）。 */
export type CommentSuppressReason = "note" | "all_mention" | "human_mention";
/** 不触发也不抑制（矩阵里 A 列只有 comment_created 的格子，不写 suppressed Activity）。 */
export type CommentNoTriggerReason = "non_human_author" | "human_to_human" | "no_agent_context";
/** 受限状态（可审计不可派发，§12.1-12）：评论照写、派发被拒并如实上报原因。 */
export type CommentRestrictReason =
  | "dispatch_disabled"
  | "work_item_archived"
  | "agent_not_in_roster";

export type CommentTriggerResolution =
  | { kind: "targets"; targets: CommentTriggerTarget[] }
  | { kind: "suppressed"; reason: CommentSuppressReason }
  | { kind: "none"; reason: CommentNoTriggerReason };

/** 级联只看锚点的作者与墓碑位（传整条记录也结构相容）。 */
export type CommentTriggerAnchor = { author: AuthorRef; deletedAt: number | null };

export type CommentTriggerContext = {
  author: AuthorRef;
  command: CommentCommand;
  mentions: readonly ParsedMention[];
  /** 工作项指派；读不到工作项（服务层已对「不存在」响亮抛）时为 null。归档项仍带 assignee：
      服务层用它解析出「被拒的目标」，再统一落 blocked（§12.1-12）。 */
  assignee: WorkItem["assignee"] | null;
  /** 直接回复的父评论（parentCommentId 指向的行）；顶层评论为 null。 */
  parent: CommentTriggerAnchor | null;
  /** 线程根（根评论 id = threadId；含墓碑行）；父评论被软删时由它判 conversation_continuation。 */
  threadRoot: CommentTriggerAnchor | null;
  /** squadId → leaderAgentId（名册快照；缺席的 squad 无法解析出目标）。 */
  squadLeaders: ReadonlyMap<string, string>;
};

/**
 * 七级隐式路由级联（§4.5），命中即止；五源一次全量。
 *
 * 顺序（仅 human 作者参与隐式级联；agent 评论要显式 @ 才产生请求——§4.2/§4.5）：
 * ① 显式 @agent/@squad（本层对任何作者生效：A2A 显式 @ 是请求）；
 * ② @all ⇒ 抑制；③ @人名 ⇒ 抑制；
 * ④ assignee 为 squad ⇒ 其队长；
 * ⑤ 父评论未软删且作者为 agent ⇒ 该 agent（thread_parent）；
 * ⑥ 父评论被软删 ⇒ 线程根所有者 agent（conversation_continuation）；
 * ⑦ 兜底 assignee 为 agent ⇒ 该 agent。
 * 父/根作者为人类（人回人）⇒ 不触发也不落兜底（§4.5 第 6 条）。
 */
export function resolveCommentTrigger(context: CommentTriggerContext): CommentTriggerResolution {
  // /note 压过一切（§4.2：/note 优先级高于 mention，不得因为 mention 再派发；无作者之分）。
  if (context.command === "note") return { kind: "suppressed", reason: "note" };

  // ① 显式 mention 优先于一切（spec §12.1-3：@all 不吞显式目标——本层先命中即止）。
  const targets: CommentTriggerTarget[] = [];
  for (const mention of context.mentions) {
    if (mention.kind === "agent") {
      targets.push({ agentId: mention.agentId, source: "mention_agent" });
    } else if (mention.kind === "squad") {
      const leaderAgentId = context.squadLeaders.get(mention.squadId);
      // 小队定义已不存在 ⇒ 解析不出目标：不猜、也不占位（继续看后面是否还有可命中的显式项）。
      if (leaderAgentId !== undefined) {
        targets.push({ agentId: leaderAgentId, source: "mention_squad_leader" });
      }
    }
  }
  if (targets.length > 0) return { kind: "targets", targets };

  if (context.author.kind !== "human") return { kind: "none", reason: "non_human_author" };

  // ② @all 抑制隐式路由（@all 本身无副作用：不开 run/不订阅/不通知，§12.1-3）。
  if (context.mentions.some((mention) => mention.kind === "all")) {
    return { kind: "suppressed", reason: "all_mention" };
  }
  // ③ 点名人类成员 ⇒ 说给人听，不惊动 agent（位次在 @all 之后，先 all 后 human）。
  if (context.mentions.some((mention) => mention.kind === "human")) {
    return { kind: "suppressed", reason: "human_mention" };
  }

  // ④ 指派小队 ⇒ 队长（source 仍是 issue_assignee：分位次按 assignee 类型，不新开源）。
  if (context.assignee?.type === "squad") {
    const leaderAgentId = context.squadLeaders.get(context.assignee.id);
    if (leaderAgentId !== undefined) {
      return { kind: "targets", targets: [{ agentId: leaderAgentId, source: "issue_assignee" }] };
    }
    // 小队定义已不存在 ⇒ 解析不出队长：继续往下，不猜。
  }

  // ⑤⑥ 回复锚点：父评论未软删 ⇒ thread_parent；父评论已软删 ⇒ 线程根 owner。
  if (context.parent) {
    if (context.parent.deletedAt === null && context.parent.author.kind === "agent") {
      return {
        kind: "targets",
        targets: [{ agentId: context.parent.author.id, source: "thread_parent" }],
      };
    }
    if (context.parent.deletedAt === null) {
      // 父评论作者不是 agent（人/系统）：人回人 ⇒ 不触发，也不落到指派兜底（§4.5 第 6 条）。
      return { kind: "none", reason: "human_to_human" };
    }
    // 父评论已软删：不算 thread_parent（§4.5 第 5 条），但线程内回复仍是回复 ⇒ 看线程根。
    if (context.threadRoot) {
      if (context.threadRoot.author.kind === "human") {
        return { kind: "none", reason: "human_to_human" };
      }
      if (context.threadRoot.deletedAt === null && context.threadRoot.author.kind === "agent") {
        return {
          kind: "targets",
          targets: [{ agentId: context.threadRoot.author.id, source: "conversation_continuation" }],
        };
      }
      // 根也已软删（或非人非 agent）⇒ 六级不命中，落七级兜底（只有「人类锚点」才拦兜底）。
    }
  }

  // ⑦ 兜底：指派 agent。
  if (context.assignee?.type === "agent") {
    return {
      kind: "targets",
      targets: [{ agentId: context.assignee.id, source: "issue_assignee" }],
    };
  }

  return { kind: "none", reason: "no_agent_context" };
}

/* ---------- CommentService：写事实 + 队列状态窗裁决 + dispatch receipt ---------- */

/** 名册来源（窄端口）：生产接线传 TeamAgentService/SquadService 的 list()，测试可传字面量。 */
export type CommentRosterSource = {
  listAgents(): ReadonlyArray<{ id: string; name: string }>;
  listSquads(): ReadonlyArray<{ id: string; name: string; leaderAgentId: string }>;
};

export type CommentServiceDeps = {
  comments: WorkItemCommentRepo;
  activities: WorkItemActivityRepo;
  receipts: CommentDispatchReceiptRepo;
  /** 表情回应存储面（§3.2 裁定#5；轻实体，永不触发派发——本服务不读它做任何路由）。 */
  reactions: WorkItemCommentReactionRepo;
  runs: SquadRunRepo;
  deferred: SquadDeferredDispatchRepo;
  workItems: WorkItemRepo;
  roster: CommentRosterSource;
  /**
   * 实验门禁的唯一读取口（同步快照，同 SquadRuntimeDeps.readExperimentEnabled）。
   * 关闭时评论照写、派发被拒并落 receipt blocked(dispatch_disabled)（§12.1-12：可审计不可派发）。
   */
  readDispatchEnabled: () => boolean;
  /** 已知人类成员名（@人名抑制的判定输入）；本轮没有人类名册来源，缺省为空集。 */
  humanNames?: ReadonlySet<string>;
  /**
   * **评论派发请求出口**（X2.1 接线）：把「本评论请求某目标 agent 处理」这条**事实**交给常驻侧
   * （组合根注入的派发请求 hub → host 评论派发入口）。
   *
   * 为什么是出口而不是在本服务里执行：§5.2 明令评论链**不得**调用小队开跑 / 队长登记 /
   * 派发规划这几类生命周期写入口 —— 本服务只产生派发**请求事实**，开 run（门禁/幂等/合并/排队）
   * 归 host 的唯一派发实现。**只有 `pending` 的请求外发**：queued/coalesced/deferred/blocked 已被队列状态窗
   * 或义务表收口（再外发一次就是重复执行），pending 才是「还没有东西会执行它」。
   *
   * 缺省（未注入）= 不外发（加法：既有调用方与测试不受影响；缺它的表现是 host 不会收到评论派发，
   * 组合根必须注入 —— 生产装配在 node.ts）。
   */
  publishDispatchRequest?: (request: SquadDispatchRequest) => void;
  /** id 生成（测试可注入确定性 id）；缺省 randomUUID。 */
  newId?: () => string;
  /** 时钟（测试可注入）；缺省 Date.now。 */
  now?: () => number;
};

export type CreateCommentInput = {
  /** 可选预生成 id（UI 乐观更新）；缺省由 newId() 生成。幂等键是 clientRequestId 不是 id。 */
  id?: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  author: AuthorRef;
  sourceRun?: SourceRunRef;
  initiatedBy: AuthorRef;
  body: string;
  inline?: InlineAnchor | null;
  parentCommentId?: string;
  clientRequestId?: string;
};

/** 逐目标如实上报派发结果（§12.1-12：评论已发，但 N 个目标未触发）。 */
export type CommentDispatchReport = {
  targetAgentId: string;
  source: CommentDispatchSource;
  outcome: CommentDispatchOutcome;
  detail: Record<string, unknown>;
};

export type CreateCommentResult = {
  comment: WorkItemCommentRecord;
  /** 本次（或同键重投时既存的）逐目标结论；空 = 无目标（抑制 / 无语境）。 */
  dispatches: CommentDispatchReport[];
};

/** 软删入参（§3.2 裁定#3）：墓碑 + comment_deleted Activity，绝不触发派发（§4.4）。 */
export type SoftDeleteCommentInput = {
  commentId: string;
  workspaceKey: string;
  /** 执行删除的主体（human/agent）：actor 是「谁做了」（§3.1），必填——归因不猜。 */
  actor: AuthorRef;
  /** 顶层人类归因；缺省同 actor（人类直接操作时二者同体）。 */
  initiatedBy?: AuthorRef;
};

/** 线程解决态入参（§3.2 裁定#4）：仅线程根可置/消；置与消各写一条 comment_resolved Activity。 */
export type SetCommentResolvedInput = {
  commentId: string;
  workspaceKey: string;
  resolved: boolean;
  actor: AuthorRef;
  initiatedBy?: AuthorRef;
};

/** 表情回应入参（§3.2 裁定#5）：轻实体幂等落盘 + comment_reaction_added Activity；永不触发派发（§4.4）。 */
export type AddCommentReactionInput = {
  /** 可选预生成 id；幂等键是 (workspace, commentId, author, emoji)，不是 id。 */
  id?: string;
  commentId: string;
  workspaceKey: string;
  /** 回应作者：既进幂等键，也是 Activity 的 actor。 */
  author: AuthorRef;
  emoji: string;
  /** 顶层人类归因；缺省沿回应作者。 */
  initiatedBy?: AuthorRef;
};

export interface CommentService {
  createComment(input: CreateCommentInput): CreateCommentResult;
  softDeleteComment(input: SoftDeleteCommentInput): WorkItemCommentRecord;
  setCommentResolved(input: SetCommentResolvedInput): WorkItemCommentRecord;
  addCommentReaction(input: AddCommentReactionInput): WorkItemCommentReactionRecord;
}

type BuiltRoster = {
  index: RosterIndex;
  squadLeaders: Map<string, string>;
  knownAgentIds: Set<string>;
};

/** 名册快照 → 解析索引 + 级联所需的 squad→leader 与 agent 存在集（重名不猜：解析为 unresolved）。 */
function buildRoster(source: CommentRosterSource, humanNames?: ReadonlySet<string>): BuiltRoster {
  const agents = source.listAgents();
  const squads = source.listSquads();
  const agentIdsByName = new Map<string, string[]>();
  const knownAgentIds = new Set<string>();
  for (const agent of agents) {
    knownAgentIds.add(agent.id);
    const ids = agentIdsByName.get(agent.name);
    if (ids) ids.push(agent.id);
    else agentIdsByName.set(agent.name, [agent.id]);
  }
  const agentsByName = new Map<string, string>();
  const ambiguousAgentNames = new Set<string>();
  for (const [name, ids] of agentIdsByName) {
    if (ids.length === 1) agentsByName.set(name, ids[0]!);
    else ambiguousAgentNames.add(name);
  }
  const squadIdsByName = new Map<string, string[]>();
  const squadLeaders = new Map<string, string>();
  for (const squad of squads) {
    squadLeaders.set(squad.id, squad.leaderAgentId);
    const ids = squadIdsByName.get(squad.name);
    if (ids) ids.push(squad.id);
    else squadIdsByName.set(squad.name, [squad.id]);
  }
  const squadsByName = new Map<string, string>();
  for (const [name, ids] of squadIdsByName) {
    if (ids.length === 1) squadsByName.set(name, ids[0]!);
  }
  return {
    index: {
      agentsByName,
      ambiguousAgentNames,
      squadsByName,
      humanNames: new Set(humanNames ?? []),
    },
    squadLeaders,
    knownAgentIds,
  };
}

export function createCommentService(deps: CommentServiceDeps): CommentService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());

  return {
    createComment(input) {
      const roster = buildRoster(deps.roster, deps.humanNames);
      // 未知 slash 命令由解析器响亮抛出（不静默降级）——发生在写任何事实之前。
      const parsed = parseComment(input.body, roster.index, input.inline ?? null);
      // 受限状态（§12.1-12）：评论照写，但派发被拒并如实上报原因。
      let restriction: CommentRestrictReason | null = null;
      let workItem = deps.workItems.get(input.workItemId);
      if (!workItem) {
        // get 把归档行当不存在：读含归档拿「归档 vs 根本不存在」的区别（§12.1-12）。
        const anyRow = deps.workItems.getIncludingArchived(input.workItemId);
        if (!anyRow) {
          throw new Error(
            `工作项「${input.workItemId}」不存在：评论必须指向本 workspace 的工作项（§3.2），` +
              "不写指向空气的孤儿评论。",
          );
        }
        if (anyRow.workspaceIdentity !== input.workspaceKey) {
          throw new Error(
            `工作项「${input.workItemId}」属于 workspace「${anyRow.workspaceIdentity}」，` +
              `与传入的「${input.workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
          );
        }
        // 归档：评论照写、派发被拒（可审计不可派发）。归档行的 assignee 仍用来解析目标，
        // 这样 blocked receipt 能如实回答「哪个目标被拒了」——否则「归档」格只有一个空结论。
        workItem = anyRow;
        restriction = "work_item_archived";
      }
      if (workItem.workspaceIdentity !== input.workspaceKey) {
        throw new Error(
          `工作项「${input.workItemId}」属于 workspace「${workItem.workspaceIdentity}」，` +
            `与传入的「${input.workspaceKey}」不一致：跨 workspace 引用一律响亮拒绝（§8.5）。`,
        );
      }
      // 父评论校验在写评论之前（§3.2：必须属于同一 threadId 与工作项）——坏的 parentCommentId
      // 绝不允许留下一条无人可解释的孤儿回复。
      const parent =
        input.parentCommentId !== undefined ? deps.comments.get(input.parentCommentId) : null;
      if (input.parentCommentId !== undefined && parent === null) {
        throw new Error(
          `父评论「${input.parentCommentId}」不存在：回复必须指向已存在的评论（§3.2）。`,
        );
      }
      if (
        parent &&
        (parent.workspaceKey !== input.workspaceKey || parent.workItemId !== input.workItemId)
      ) {
        throw new Error(
          `父评论「${parent.id}」属于 (workspace=${parent.workspaceKey}, workItem=${parent.workItemId})，` +
            `与本次回复的 (workspace=${input.workspaceKey}, workItem=${input.workItemId}) 不一致：一律响亮拒绝（§3.2）。`,
        );
      }
      const timestamp = now();
      const comment = deps.comments.add({
        id: input.id ?? newId(),
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        workItemId: input.workItemId,
        ...(parent !== null ? { threadId: parent.threadId } : {}),
        ...(input.parentCommentId !== undefined ? { parentCommentId: input.parentCommentId } : {}),
        author: input.author,
        ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
        initiatedBy: input.initiatedBy,
        body: input.body,
        normalizedBody: parsed.normalizedBody,
        mentions: toMentionRefs(parsed.mentions),
        command: parsed.command,
        inline: parsed.inline,
        ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}),
        createdAt: timestamp,
      });
      writeCommentActivities(deps, {
        comment,
        parsed,
        timestamp,
        sourceRun: input.sourceRun,
        initiatedBy: input.initiatedBy,
      });
      // 线程根：根评论 threadId = id（§3.2），故按 id 取恒可命中（含墓碑行）。
      const threadRoot = parent !== null ? deps.comments.get(parent.threadId) : null;
      const resolution = resolveCommentTrigger({
        author: comment.author,
        command: comment.command,
        mentions: parsed.mentions,
        assignee: workItem?.assignee ?? null,
        parent: parent === null ? null : { author: parent.author, deletedAt: parent.deletedAt },
        threadRoot:
          threadRoot === null
            ? null
            : { author: threadRoot.author, deletedAt: threadRoot.deletedAt },
        squadLeaders: roster.squadLeaders,
      });
      // 门禁关闭同样是受限状态（工作项更具体的原因优先保留）。
      if (!deps.readDispatchEnabled()) restriction ??= "dispatch_disabled";
      const dispatches = writeDispatchReceipts(deps, {
        comment,
        resolution,
        restriction,
        knownAgentIds: roster.knownAgentIds,
        timestamp,
      });
      return { comment, dispatches };
    },

    softDeleteComment(input) {
      const comment = readCommentForAction(deps, input.commentId, input.workspaceKey);
      deps.comments.softDelete(comment.id); // 墓碑：只写 deletedAt（repo 幂等，正文/作者不动）
      const deleted = deps.comments.get(comment.id)!;
      const timestamp = now();
      deps.activities.add({
        id: `activity-${comment.id}-deleted`,
        workspaceKey: comment.workspaceKey,
        workspacePath: comment.workspacePath,
        workItemId: comment.workItemId,
        kind: "comment_deleted",
        occurredAt: timestamp,
        actor: input.actor,
        initiatedBy: input.initiatedBy ?? input.actor,
        commentId: comment.id,
        payload: { deletedAt: deleted.deletedAt },
        dedupKey: `comment:${comment.id}:deleted`,
        createdAt: timestamp,
      });
      return deleted;
    },

    setCommentResolved(input) {
      const comment = readCommentForAction(deps, input.commentId, input.workspaceKey);
      // §3.2 裁定#4：解决态仅线程根可置/消。回复行也能成功会让「线程是否已解决」变成
      // 每条回复各自一票的漂移语义，故在写任何事实之前响亮拒绝（repo 层另有同款守卫双保险）。
      if (comment.threadId !== comment.id) {
        throw new Error(
          `评论「${comment.id}」不是线程根（threadId=${comment.threadId}）：解决态仅线程根可置/消（§3.2），` +
            "一律响亮拒绝。",
        );
      }
      deps.comments.setResolved(comment.id, input.resolved); // 状态一致时 repo no-op（不重写时间戳）
      const updated = deps.comments.get(comment.id)!;
      const timestamp = now();
      // 置/消各一条：dedupKey 带状态后缀——同键重投不写第二条（§8.1），置↔消互不吞并。
      const state = input.resolved ? "set" : "cleared";
      deps.activities.add({
        id: `activity-${comment.id}-resolved-${state}`,
        workspaceKey: comment.workspaceKey,
        workspacePath: comment.workspacePath,
        workItemId: comment.workItemId,
        kind: "comment_resolved",
        occurredAt: timestamp,
        actor: input.actor,
        initiatedBy: input.initiatedBy ?? input.actor,
        commentId: comment.id,
        payload: { resolved: input.resolved },
        dedupKey: `comment:${comment.id}:resolved:${state}`,
        createdAt: timestamp,
      });
      return updated;
    },

    addCommentReaction(input) {
      const comment = readCommentForAction(deps, input.commentId, input.workspaceKey);
      const timestamp = now();
      // 幂等落盘（INSERT OR IGNORE）：同 (workspace, comment, author, emoji) 返回既存行。
      const reaction = deps.reactions.add({
        id: input.id ?? newId(),
        workspaceKey: comment.workspaceKey,
        commentId: comment.id,
        author: input.author,
        emoji: input.emoji,
        createdAt: timestamp,
      });
      deps.activities.add({
        id: `activity-${comment.id}-reaction-${input.author.kind}-${input.author.id}-${reaction.emoji}`,
        workspaceKey: comment.workspaceKey,
        workspacePath: comment.workspacePath,
        workItemId: comment.workItemId,
        kind: "comment_reaction_added",
        occurredAt: timestamp,
        actor: input.author,
        initiatedBy: input.initiatedBy ?? input.author,
        commentId: comment.id,
        payload: { emoji: reaction.emoji },
        dedupKey: `reaction:${comment.id}:${input.author.kind}:${input.author.id}:${reaction.emoji}`,
        createdAt: timestamp,
      });
      // §4.4：回应永不触发派发——本方法结构上不碰 receipts / runs / deferred（负向断言见测试）。
      return reaction;
    },
  };
}

/** 三件套动作的前置读：不存在 / 跨 workspace 一律响亮拒绝（§3.2 / §8.5）——
    动作不得落在空气上，也不得跨 workspace 引用（workspacePath 不是逻辑身份）。 */
function readCommentForAction(
  deps: CommentServiceDeps,
  commentId: string,
  workspaceKey: string,
): WorkItemCommentRecord {
  const comment = deps.comments.get(commentId);
  if (comment === null) {
    throw new Error(`评论「${commentId}」不存在：动作必须指向已存在的评论（§3.2），一律响亮拒绝。`);
  }
  if (comment.workspaceKey !== workspaceKey) {
    throw new Error(
      `评论「${commentId}」属于 workspace「${comment.workspaceKey}」，与传入的「${workspaceKey}」不一致：` +
        "跨 workspace 引用一律响亮拒绝（§8.5）。",
    );
  }
  return comment;
}

/**
 * 队列状态窗裁决（§12.1-1/2；B-3：唯一性以已落地索引为准，dispatchKey 只作请求身份）：
 * 复用既有闸，**绝不自己开 run**——本服务只回答「这条请求此刻落在哪一格」：
 *  · 已有排队行（同 (workspace, workItem, agent)，部分唯一索引兜底）⇒ 并入 + 留痕 ⇒ coalesced；
 *  · 已有活跃 run（open/produced/rejected 仍占树）⇒ 登记完成重放义务 ⇒ deferred；
 *  · 都没有 ⇒ pending（实际派发由 X2.1 的 host 接线做，本卡不写 squad_runs）。
 */
function adjudicateQueueWindow(
  deps: CommentServiceDeps,
  input: {
    dispatchKey: string;
    workspaceKey: string;
    workItemId: string;
    targetAgentId: string;
    source: CommentDispatchSource;
    timestamp: number;
  },
): { outcome: CommentDispatchOutcome; detail: Record<string, unknown> } {
  const baseDetail: Record<string, unknown> = { triggerSource: input.source };
  if (deps.runs.hasQueuedRunForPair(input.workspaceKey, input.workItemId, input.targetAgentId)) {
    const queued = deps.runs
      .listQueued(input.workspaceKey)
      .find((run) => run.workItemId === input.workItemId && run.agentId === input.targetAgentId);
    if (!queued) {
      throw new Error(
        `hasQueuedRunForPair 命中但 listQueued 找不到 (workspace=${input.workspaceKey}, ` +
          `workItem=${input.workItemId}, agent=${input.targetAgentId}) 的排队行：不可达态，须查库。`,
      );
    }
    deps.runs.recordCoalescedRequest(input.dispatchKey, queued.runId);
    return { outcome: "coalesced", detail: { ...baseDetail, targetRunId: queued.runId } };
  }
  if (deps.runs.hasActiveRunForPair(input.workspaceKey, input.workItemId, input.targetAgentId)) {
    // 运行中不排队不注入：登记完成后重放义务（义务 id = 请求身份，重投不新增义务）。
    // dispatchCause 传 null：评论成因的闭集扩展属 C2（§5.2 明令不得把 @ 伪装成 user_reassign）。
    // G4：origin='comment' 与 R2 义务判别（同一张表两条通道，claimDue 消费者据此分流——X2.1）。
    deps.deferred.insertIfAbsent({
      runId: input.dispatchKey,
      workspaceKey: input.workspaceKey,
      workItemId: input.workItemId,
      agentId: input.targetAgentId,
      dispatchCause: null,
      origin: "comment",
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
    return { outcome: "deferred", detail: baseDetail };
  }
  return { outcome: "pending", detail: baseDetail };
}

/**
 * 按级联结论落 receipt（逐目标）：本卡只做**队列状态窗裁决**（并入 / 义务 / pending），
 * 不写 squad_runs——实际派发归 X2.1 的 host 接线（§5.2 明令：评论服务不得自己开 run）。
 * 返回逐目标结论（§12.1-12：评论响应如实上报「谁被触发、结果如何」）。
 */
function writeDispatchReceipts(
  deps: CommentServiceDeps,
  context: {
    comment: WorkItemCommentRecord;
    resolution: CommentTriggerResolution;
    restriction: CommentRestrictReason | null;
    knownAgentIds: ReadonlySet<string>;
    timestamp: number;
  },
): CommentDispatchReport[] {
  if (context.resolution.kind !== "targets") {
    if (context.resolution.kind === "suppressed") {
      // 抑制事实（@all / @人名 / /note）：不开 run、不产生 receipt——唯一语义是「不派发」并留痕。
      deps.activities.add({
        id: `activity-${context.comment.id}-dispatch-suppressed`,
        workspaceKey: context.comment.workspaceKey,
        workspacePath: context.comment.workspacePath,
        workItemId: context.comment.workItemId,
        kind: "comment_dispatch_suppressed",
        occurredAt: context.timestamp,
        actor: context.comment.author,
        initiatedBy: context.comment.initiatedBy,
        commentId: context.comment.id,
        payload: { reason: context.resolution.reason },
        dedupKey: `comment:${context.comment.id}:dispatch_suppressed`,
        createdAt: context.timestamp,
      });
    }
    return [];
  }
  const dispatches: CommentDispatchReport[] = [];
  /** 未收敛（pending）的请求：循环后经出口外发（含同键重投时仍 pending 的行 —— 它还没有执行者）。 */
  const pendingRequests: SquadDispatchRequest[] = [];
  const blocked: Array<{ targetAgentId: string; source: CommentDispatchSource; reason: string }> =
    [];
  for (const target of context.resolution.targets) {
    const dispatchKey = computeCommentDispatchKey({
      workspaceKey: context.comment.workspaceKey,
      workItemId: context.comment.workItemId,
      targetAgentId: target.agentId,
      commentId: context.comment.id,
    });
    // 同 dispatchKey 已有 receipt ⇒ **首写即事实**：不重裁决队列窗口、不重复登记义务/并入留痕
    // （否则一次重投会在窗口变化后凭空长出一条 deferred 义务，而 receipt 仍写着 pending）。
    const existing = deps.receipts.get(dispatchKey);
    if (existing !== null) {
      // 同键重投且仍停在 pending（host 那一次没执行成 / 桥不可用）⇒ 重新外发：pending 的意义就是
      // 「还没有东西会执行它」。已收敛的行（queued/coalesced/deferred/...）不再外发（首写即事实）。
      if (existing.outcome === "pending") {
        pendingRequests.push(buildCommentDispatchRequest(context.comment, existing));
      }
      dispatches.push({
        targetAgentId: existing.targetAgentId,
        source: existing.source,
        outcome: existing.outcome,
        detail: existing.detail,
      });
      continue;
    }
    // 受限状态（门禁关闭 / 工作项归档）与名册缺席：可审计不可派发——评论已落库，这里只如实回传 blocked。
    const blockedReason: CommentRestrictReason | null =
      context.restriction ??
      (context.knownAgentIds.has(target.agentId) ? null : "agent_not_in_roster");
    let outcome: CommentDispatchOutcome;
    let detail: Record<string, unknown>;
    if (blockedReason !== null) {
      outcome = "blocked";
      detail = { triggerSource: target.source, reason: blockedReason };
      blocked.push({ targetAgentId: target.agentId, source: target.source, reason: blockedReason });
    } else {
      ({ outcome, detail } = adjudicateQueueWindow(deps, {
        dispatchKey,
        workspaceKey: context.comment.workspaceKey,
        workItemId: context.comment.workItemId,
        targetAgentId: target.agentId,
        source: target.source,
        timestamp: context.timestamp,
      }));
    }
    const receipt = deps.receipts.insertIfAbsent({
      dispatchKey,
      workspaceKey: context.comment.workspaceKey,
      workItemId: context.comment.workItemId,
      targetAgentId: target.agentId,
      commentId: context.comment.id,
      threadId: context.comment.threadId,
      source: target.source,
      outcome,
      detail,
      createdAt: context.timestamp,
    });
    if (receipt.outcome === "pending") {
      pendingRequests.push(buildCommentDispatchRequest(context.comment, receipt));
    }
    dispatches.push({
      targetAgentId: target.agentId,
      source: target.source,
      outcome: receipt.outcome,
      detail: receipt.detail,
    });
  }
  if (dispatches.some((report) => report.outcome !== "blocked")) {
    deps.activities.add({
      id: `activity-${context.comment.id}-requested`,
      workspaceKey: context.comment.workspaceKey,
      workspacePath: context.comment.workspacePath,
      workItemId: context.comment.workItemId,
      kind: "comment_dispatch_requested",
      occurredAt: context.timestamp,
      actor: context.comment.author,
      initiatedBy: context.comment.initiatedBy,
      commentId: context.comment.id,
      payload: { targets: dispatches },
      dedupKey: `comment:${context.comment.id}:dispatch_requested`,
      createdAt: context.timestamp,
    });
  }
  if (blocked.length > 0) {
    // 被拒目标进抑制事实（带原因）：评论响应逐目标如实上报，Activity 留审计（§12.1-12）。
    deps.activities.add({
      id: `activity-${context.comment.id}-dispatch-suppressed`,
      workspaceKey: context.comment.workspaceKey,
      workspacePath: context.comment.workspacePath,
      workItemId: context.comment.workItemId,
      kind: "comment_dispatch_suppressed",
      occurredAt: context.timestamp,
      actor: context.comment.author,
      initiatedBy: context.comment.initiatedBy,
      commentId: context.comment.id,
      payload: { reason: "blocked", blocked },
      dedupKey: `comment:${context.comment.id}:dispatch_suppressed`,
      createdAt: context.timestamp,
    });
  }
  /* 请求事实已全部落库（receipt + Activity 之后）才外发：出口的消费者（host 派发入口）读库取事实，
     先发后写会让它读到一条不存在的 receipt。只发 pending（见 deps.publishDispatchRequest 的理由）。 */
  for (const request of pendingRequests) deps.publishDispatchRequest?.(request);
  return dispatches;
}

/** 评论派发请求的形状**只在 buildCommentDispatchRequest 一处拼**（出口/host 两侧读到的身份一致）。 */
function buildCommentDispatchRequest(
  comment: WorkItemCommentRecord,
  receipt: Pick<CommentDispatchReceiptRecord, "dispatchKey" | "targetAgentId">,
): SquadDispatchRequest {
  return {
    kind: "comment",
    // 成因是请求形状本身的事实（§5.2 明文评论成因另行扩展，不得伪装成 user_reassign）。
    cause: "comment",
    workItemId: comment.workItemId,
    dispatchKey: receipt.dispatchKey,
    targetAgentId: receipt.targetAgentId,
    workspacePath: comment.workspacePath,
    workspaceIdentity: comment.workspaceKey,
  };
}

/** comment_created 必写；mention 命中加 comment_mention_parsed（dedupKey 幂等：重投不重复写）。
    id 由 comment id 派生（确定性）：同评论重投连 id 也不新建一行，事实只增不重。 */
function writeCommentActivities(
  deps: CommentServiceDeps,
  context: {
    comment: WorkItemCommentRecord;
    parsed: { mentions: readonly ParsedMention[]; command: CommentCommand };
    timestamp: number;
    sourceRun: SourceRunRef | undefined;
    initiatedBy: AuthorRef;
  },
): void {
  const { comment } = context;
  deps.activities.add({
    id: `activity-${comment.id}-created`,
    workspaceKey: comment.workspaceKey,
    workspacePath: comment.workspacePath,
    workItemId: comment.workItemId,
    kind: "comment_created",
    occurredAt: context.timestamp,
    actor: comment.author,
    ...(context.sourceRun !== undefined ? { sourceRun: context.sourceRun } : {}),
    initiatedBy: context.initiatedBy,
    commentId: comment.id,
    payload: { command: comment.command, parentCommentId: comment.parentCommentId },
    dedupKey: `comment:${comment.id}:created`,
    createdAt: context.timestamp,
  });
  if (context.parsed.mentions.length > 0) {
    deps.activities.add({
      id: `activity-${comment.id}-mention-parsed`,
      workspaceKey: comment.workspaceKey,
      workspacePath: comment.workspacePath,
      workItemId: comment.workItemId,
      kind: "comment_mention_parsed",
      occurredAt: context.timestamp,
      actor: comment.author,
      ...(context.sourceRun !== undefined ? { sourceRun: context.sourceRun } : {}),
      initiatedBy: context.initiatedBy,
      commentId: comment.id,
      payload: { mentions: context.parsed.mentions },
      dedupKey: `comment:${comment.id}:mention_parsed`,
      createdAt: context.timestamp,
    });
  }
}
