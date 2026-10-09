/* 侧边 peek（阶段三 · T-P3-R2）的**纯判据**：面板自身的关闭键位、协作读模型状态 → 面板视图的映射、
   最近活动摘要的投影。

   为什么独立成模块：peek 是**只读速览** —— 它的全部判据都是「读模型怎么摆、按哪个键关、摘要取哪几条」，
   写进组件就等于不可测（ui 包没有交互测试设施，本仓既有做法：判据纯函数 + 组件只画）。本文件
   不 import React、不 import 服务访问点（数据只从参数来，见 `WorkItemPeek` 的取数单源守卫）。 */

import type {
  AuthorRef,
  WorkItemActivityRecord,
  WorkItemCollaborationRead,
  WorkItemCommentRecord,
  WorkItemDecisionRecord,
} from "@zcode/services";
import {
  WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS,
  buildWorkItemTimelineEntries,
  commentDisplayBody,
} from "./workItemCollaborationViewModel.js";
import type { WorkItemCollaborationState } from "./useWorkItemCollaboration.js";

/**
 * 关闭键位 → 意图（**唯一一处**）：`Escape` ⇒ `close`，其余键一律 `none`。
 *
 * 为什么不像快速创建/行内编辑那样带 IME 组合闸：peek 里**没有任何输入件**（它是只读速览），
 * 组合态根本到不了这里；照抄那枚判据反而会让「没有输入却有组合态」成为一个看不懂的分支。
 */
export function workItemPeekKeyIntent(key: string): "close" | "none" {
  return key === "Escape" ? "close" : "none";
}

/** 面板视图：协作读模型的四态 → 面板要画哪一支（判别联合，`ready` 支**带回**读模型本身）。 */
export type WorkItemPeekView =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "missing" }
  | { kind: "ready"; read: WorkItemCollaborationRead };

/**
 * 读模型状态 → 面板视图（**唯一一处**）。
 *
 * 三条判据，各自对应一条既有纪律：
 * ① `failed` 只在**没有数据**时出现（状态机自身如此）⇒ 失败态；有数据时的刷新失败仍走 `ready`
 *    （旧数据照常可读 —— 把已读到的正文整片抹掉才是更大的错）；
 * ② `ready` + `read === null` ⇒ `missing`：与详情页同一个 not-found 语义（不是故障）；
 * ③ `ready` 但读回的**不是当前条目**（`read.workItem.id !== workItemId`）⇒ 按加载中呈现：
 *    读模型在换条目时会保留**上一条**的数据（refreshing=true），直接画出来就是把上一条的标题/
 *    标签放在新条目名下 —— 静默错位，界面上没有任何错误可看。
 */
export function workItemPeekView(
  state: WorkItemCollaborationState,
  workItemId: string,
): WorkItemPeekView {
  if (state.status === "failed") return { kind: "failed", error: state.error };
  if (state.status !== "ready") return { kind: "loading" };
  if (state.read === null) return { kind: "missing" };
  if (state.read.workItem.id !== workItemId) return { kind: "loading" };
  return { kind: "ready", read: state.read };
}

/* ---------- 最近活动摘要 ---------- */

/**
 * 摘要条数上限（**轻量速览 ≠ 完整时间线**）：peek 只回答「最近发生了什么」，完整活动在详情页
 * （那里是同一个投影的全量渲染）。写死在这里而不是让调用方各给一个数：上限只有一个来源。
 */
export const WORK_ITEM_PEEK_ACTIVITY_LIMIT = 5;

/** 摘要的一行：谁 + 做了什么（**既有**活动 kind 文案）+ 一句话正文（系统活动没有正文）。 */
export type WorkItemPeekActivityLine = {
  /** 与时间线条目同一个 key（同一条事实在两面是同一个身份）。 */
  key: string;
  /** 文案键（活动 kind / 「关联活动不可用」；**全部复用既有键**，不新造摘要词汇）。 */
  messageId: string;
  /** 一句话正文：评论取显示正文首行、决定取事项首行；系统活动与不可用关联为 `null`。 */
  text: string | null;
  /** 谁做的（`displayName`，缺席回落 id）；不可用关联为 `null`（没有事实可指认）。 */
  actorLabel: string | null;
};

/** 首行正文：多行正文进摘要只取第一行（「摘要」不是把整段搬过来）。 */
function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

function actorLabelOf(actor: AuthorRef): string {
  const displayName = actor.displayName?.trim();
  return displayName !== undefined && displayName.length > 0 ? displayName : actor.id;
}

/**
 * 最近活动摘要：**同一份**混排投影（`buildWorkItemTimelineEntries`，详情页时间线用的那个）的
 * 主序**尾部** N 条 —— 不重排、不新造摘要词汇（"最近"由主序本身回答：尾部就是最近）。
 *
 * 正文取「显示正文」的既有判据（`commentDisplayBody`）：墓碑评论只给标记、**不漏正文**
 * （结构上拿不到正文，见那个函数的返回类型）。
 */
export function workItemPeekActivityLines(input: {
  comments: WorkItemCommentRecord[];
  activities: WorkItemActivityRecord[];
  decisions: WorkItemDecisionRecord[];
}): WorkItemPeekActivityLine[] {
  return buildWorkItemTimelineEntries(input)
    .slice(-WORK_ITEM_PEEK_ACTIVITY_LIMIT)
    .map((entry) => {
      if (entry.kind === "comment") {
        const body = commentDisplayBody(entry.comment);
        return {
          key: entry.key,
          messageId: WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS.comment_created,
          text: body.kind === "text" ? firstLine(body.text) : null,
          actorLabel: actorLabelOf(entry.comment.author),
        };
      }
      if (entry.kind === "decision") {
        return {
          key: entry.key,
          messageId: WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS.decision_created,
          text: firstLine(entry.decision.subject),
          actorLabel: actorLabelOf(entry.decision.author),
        };
      }
      if (entry.kind === "link-error") {
        return {
          key: entry.key,
          messageId: "squad.workItemDetail.activity.linkUnavailable",
          text: null,
          actorLabel: null,
        };
      }
      return {
        key: entry.key,
        messageId: WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS[entry.activity.kind],
        text: null,
        actorLabel: actorLabelOf(entry.activity.actor),
      };
    });
}
