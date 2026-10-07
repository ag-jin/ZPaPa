import { useState } from "react";
import type {
  AuthorRef,
  CommentDispatchReceiptRecord,
  WorkItemActivityRecord,
  WorkItemCommentReactionRecord,
  WorkItemCommentRecord,
} from "@zcode/services";
import { Ellipsis, FileCode, CircleCheckBig, SmilePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemCommentDispatchSummary } from "./WorkItemCommentDispatchSummary.js";
import {
  COMMENT_REACTION_EMOJIS,
  commentDisplayBody,
  groupCommentReactions,
  projectMention,
  type MentionRoster,
} from "./workItemCollaborationViewModel.js";

/* B5.1 轮 1 / B5.2 轮 2：单条评论的完整状态空间（设计案 §3.1 / §3.3）。

   轮 2 补上的：reaction 的「我已回应」（`aria-pressed` + 已点禁用，**不做 toggle/remove** ——
   服务面没有移除接口，假装能取消就是把用户的话当成没说过）、回复/解决/删除/回应的**真实动作**
   （全部交给页面的唯一动作执行点，本组件不直接碰服务）、以及条目下方的 **receipt 只读插槽**。

   墓碑（软删）分支是一条**结构上的**分支：正文只经 `commentDisplayBody` 投影拿到，
   墓碑投影**根本没有正文字段**（`{kind:"deleted"}`）—— 组件里拿不到 normalizedBody / body，
   所以「删了还漏出原文」这件事在结构上凑不出来（R3）。

   两条轮 2 的边界：
   · 解决/重开入口的条件仍是 `comment.threadId === comment.id`（根专属，R5）——**动作**也一样；
   · 墓碑条目没有任何动作入口（回复/回应/删除/解决都不渲染）：对一条已删评论「回应」是荒谬的。 */

const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const BODY_CLASSNAME = "text-ui-base text-foreground leading-[1.5] whitespace-pre-wrap break-words";

export function WorkItemCommentEntry({
  comment,
  reactions,
  receipts,
  activities,
  indent,
  parent,
  roster,
  viewerActor,
  pending,
  onReply,
  onDelete,
  onResolve,
  onReact,
}: {
  comment: WorkItemCommentRecord;
  /** 本条评论的回应（由页面按评论分组后传入；分组是纯函数 `groupCommentReactions` 的活）。 */
  reactions: WorkItemCommentReactionRecord[];
  /** 本条评论的派发 receipt（只读插槽的输入；空 ⇒ 不渲染插槽）。 */
  receipts: CommentDispatchReceiptRecord[];
  /** 本工作项的全部活动（抑制注记按 commentId 取本条的那几枚）。 */
  activities: WorkItemActivityRecord[];
  /** 由 `commentIndentLevel` 算好的层级（0..3，≥3 封顶）——组件不推断深度。 */
  indent: number;
  /** 直接父评论（「回复给 {name}」的输入；不可解析时为 null）。 */
  parent: WorkItemCommentRecord | null;
  roster: MentionRoster;
  /** 本地人类身份（D1-A 注入，读面带回）：`mine` 的判据；缺席时不渲染 `aria-pressed`。 */
  viewerActor: AuthorRef | null;
  /** 本条评论有一次写在途（禁用动作，避免重复提交）。 */
  pending: boolean;
  /** 点「回复」：交给页面切回复上下文（本层不持有 composer 状态）。 */
  onReply: (comment: WorkItemCommentRecord) => void;
  /** 点「删除评论」：交给页面进入**确认态**（本层不执行任何写入）。 */
  onDelete: (comment: WorkItemCommentRecord) => void;
  /** 点「解决/重开」：`resolved` 是**目标态**（根专属动作）。 */
  onResolve: (comment: WorkItemCommentRecord, resolved: boolean) => void;
  /** 添加回应：`emoji` 是选中的那一枚（移除回应这一轮不存在）。 */
  onReact: (comment: WorkItemCommentRecord, emoji: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [reactMenuOpen, setReactMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const displayBody = commentDisplayBody(comment);
  const deleted = displayBody.kind === "deleted";
  // 解决态只属于**线程根**（设计案 §2.3：子回复不各自显示解决开关）。
  const isThreadRoot = comment.threadId === comment.id;
  /* `viewer = null`（身份缺席）⇒ `mine` 不可判定 ⇒ 不渲染 `aria-pressed`（C5）。
     回应是**只增**的：已回应项禁用并显示「已回应」，不实现 toggle/remove（设计案 §3.3）。 */
  const reactionGroups = deleted ? [] : groupCommentReactions(reactions, viewerActor);
  const reactedEmojis = new Set(
    reactionGroups.filter((group) => group.mine === true).map((group) => group.emoji),
  );
  const closeMenus = () => {
    setReactMenuOpen(false);
    setMoreMenuOpen(false);
  };

  return (
    <article
      data-testid={`work-item-comment-${comment.id}`}
      style={{ paddingLeft: `${indent * 12}px` }}
      className={cn(
        "flex flex-col gap-1 border-t border-border py-3 first:border-t-0",
        // 线程连线低于普通 border（设计案 §6 的 thread rail `--color-workflow-rule`）：
        // 只表达「这是某条回复的缩进」，不编码任何状态。
        indent > 0 && "border-l border-workflow-rule pl-3",
      )}
      onKeyDown={(event) => {
        // Escape 先收菜单（不丢草稿、不改变任何提交态）——设计案 §9 的键盘顺序。
        if (event.key === "Escape") closeMenus();
      }}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="size-6 shrink-0 rounded-full bg-secondary" aria-hidden />
        <span className="text-ui-base font-medium text-foreground">
          {comment.author.displayName ?? comment.author.id}
        </span>
        <span className={BADGE_CLASSNAME}>
          {comment.author.kind === "human"
            ? t("squad.workItemDetail.comment.author.human")
            : t("squad.workItemDetail.comment.author.agent")}
        </span>
        {comment.sourceRun ? (
          <span className={BADGE_CLASSNAME}>
            {comment.sourceRun.role === "leader"
              ? t("squad.workItemDetail.comment.sourceRole.leader")
              : comment.sourceRun.role === "member"
                ? t("squad.workItemDetail.comment.sourceRole.member")
                : t("squad.workItemDetail.comment.sourceRole.standalone")}
          </span>
        ) : null}
        {comment.command === "note" ? (
          <span className={BADGE_CLASSNAME} title={t("squad.workItemDetail.comment.noteHint")}>
            {t("squad.workItemDetail.comment.note")}
          </span>
        ) : null}
        {isThreadRoot && comment.resolvedAt !== null ? (
          <span
            data-testid="work-item-comment-resolved"
            className="flex items-center gap-1 text-ui-xs text-success"
          >
            <CircleCheckBig aria-hidden className="size-3.5" />
            {t("squad.workItemDetail.comment.resolved")}
          </span>
        ) : null}
        <time
          className={cn(BADGE_CLASSNAME, "ml-auto")}
          dateTime={new Date(comment.createdAt).toISOString()}
          title={new Date(comment.createdAt).toISOString()}
        >
          {new Date(comment.createdAt).toLocaleString()}
        </time>
      </header>

      {deleted ? (
        <p
          data-testid="work-item-comment-deleted"
          className="text-ui-base italic text-foreground-subtle"
        >
          {t("squad.workItemDetail.comment.deleted")}
        </p>
      ) : (
        <>
          {indent >= 3 && parent ? (
            <p className={BADGE_CLASSNAME}>
              {t("squad.workItemDetail.comment.replyingTo", {
                name: parent.author.displayName ?? parent.author.id,
              })}
            </p>
          ) : null}
          <p className={BODY_CLASSNAME}>{displayBody.text}</p>
          {comment.mentions.length > 0 ? (
            <ul className="flex flex-wrap items-center gap-2">
              {comment.mentions.map((mention, index) => (
                <MentionChip
                  // mention 快照没有稳定 id（同一目标可出现两次），键用位置 + 目标。
                  key={`${mention.type}:${mention.id}:${index}`}
                  mention={mention}
                  roster={roster}
                />
              ))}
            </ul>
          ) : null}
          {comment.inline ? (
            <p className="flex items-center gap-1 text-ui-xs text-foreground-subtle">
              <FileCode aria-hidden className="size-3.5" />
              <span className="truncate">
                {`${comment.inline.path}:${comment.inline.startLine}${
                  comment.inline.endLine === undefined ? "" : `-${comment.inline.endLine}`
                }`}
              </span>
              {/* 本轮没有可用的文件定位通路 ⇒ 保留灰色路径文本 + 明确说明（设计案 §3.1）。 */}
              <span className="text-foreground-subtlest">
                {t("squad.workItemDetail.inline.unavailable")}
              </span>
            </p>
          ) : null}

          {reactionGroups.length > 0 ? (
            <ul
              data-testid="work-item-comment-reactions"
              className="flex flex-wrap items-center gap-1"
            >
              {reactionGroups.map((group) => (
                <li key={group.emoji}>
                  <button
                    type="button"
                    /* 已回应 = 禁用（服务面没有移除接口 ⇒ 不做 toggle 的假动作）。
                       `aria-pressed` 只在 `mine` 可判定时给出（身份缺席时不假装「不是我」）。 */
                    aria-pressed={group.mine === null ? undefined : group.mine}
                    disabled={group.mine === true || pending}
                    title={
                      group.mine === true
                        ? t("squad.workItemDetail.comment.reacted")
                        : t("squad.workItemDetail.comment.react")
                    }
                    data-testid={`work-item-comment-reaction-${group.emoji}`}
                    onClick={() => onReact(comment, group.emoji)}
                    className={cn(
                      "flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border px-2 text-ui-xs transition-colors",
                      group.mine === true
                        ? "border-border-hover bg-selected text-foreground"
                        : "border-border text-foreground-subtle hover:border-border-hover",
                    )}
                  >
                    <span aria-hidden>{group.emoji}</span>
                    <span>{group.count}</span>
                    {group.mine === true ? (
                      <span className="text-foreground-subtlest">
                        {t("squad.workItemDetail.comment.reacted")}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              data-testid="work-item-comment-reply"
              onClick={() => onReply(comment)}
            >
              {t("squad.workItemDetail.comment.reply")}
            </Button>
            {/* 身份缺席时连菜单都不给：回应要落到某个作者名下，没有作者就没有回应可加。 */}
            {viewerActor === null ? null : (
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={reactMenuOpen}
                aria-haspopup="listbox"
                disabled={pending}
                data-testid="work-item-comment-react-menu"
                title={t("squad.workItemDetail.comment.react")}
                onClick={() => {
                  setMoreMenuOpen(false);
                  setReactMenuOpen((previous) => !previous);
                }}
              >
                <SmilePlus aria-hidden className="size-3.5" />
                {t("squad.workItemDetail.comment.react")}
              </Button>
            )}
            {isThreadRoot ? (
              /* 解决/重开：根专属（R5），动作直达服务面（轮 2 起不再是「点了没反应」的占位）。 */
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                data-testid="work-item-comment-resolve"
                onClick={() => onResolve(comment, comment.resolvedAt === null)}
              >
                {comment.resolvedAt === null
                  ? t("squad.workItemDetail.comment.resolve")
                  : t("squad.workItemDetail.comment.reopen")}
              </Button>
            ) : null}
            {/* 删除入口收在溢出菜单里（设计案 §3.3：不用 hover-only 入口、不直接删除）。 */}
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={moreMenuOpen}
              aria-haspopup="menu"
              disabled={pending}
              data-testid="work-item-comment-more"
              title={t("squad.workItemDetail.comment.delete")}
              onClick={() => {
                setReactMenuOpen(false);
                setMoreMenuOpen((previous) => !previous);
              }}
            >
              <Ellipsis aria-hidden className="size-3.5" />
            </Button>
          </div>

          {reactMenuOpen ? (
            <ul
              role="listbox"
              aria-label={t("squad.workItemDetail.comment.react")}
              className="flex flex-wrap items-center gap-1"
            >
              {COMMENT_REACTION_EMOJIS.map((emoji) => {
                const already = reactedEmojis.has(emoji);
                return (
                  <li key={emoji}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={already}
                      disabled={already || pending}
                      title={
                        already
                          ? t("squad.workItemDetail.comment.reacted")
                          : t("squad.workItemDetail.comment.react")
                      }
                      data-testid={`work-item-comment-react-option-${emoji}`}
                      onClick={() => {
                        closeMenus();
                        onReact(comment, emoji);
                      }}
                      className={cn(
                        "flex h-7 items-center justify-center rounded-md border px-2 text-ui-sm",
                        already
                          ? "border-border-hover bg-selected text-foreground"
                          : "border-border text-foreground-subtle hover:border-border-hover",
                      )}
                    >
                      <span aria-hidden>{emoji}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {moreMenuOpen ? (
            <div role="menu" className="flex flex-col items-start gap-1">
              <button
                type="button"
                role="menuitem"
                /* 点它只**进入确认态**（页面的对话框）；真正的写入只在确认分支发生。 */
                data-testid="work-item-comment-delete"
                onClick={() => {
                  closeMenus();
                  onDelete(comment);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-ui-xs text-destructive hover:bg-destructive/10"
              >
                <Trash2 aria-hidden className="size-3.5" />
                {t("squad.workItemDetail.comment.delete")}
              </button>
            </div>
          ) : null}
        </>
      )}

      {/* receipt 插槽（轮 2 落地）：无 receipt、无抑制事实 ⇒ 组件自己返回 null（不留空壳）。 */}
      <WorkItemCommentDispatchSummary
        commentId={comment.id}
        receipts={receipts}
        activities={activities}
        roster={roster}
      />
    </article>
  );
}

/** 一条持久化 mention 的呈现（权威是存储的 mentions 快照，不拿当前文本重新判定）。 */
function MentionChip({
  mention,
  roster,
}: {
  mention: WorkItemCommentRecord["mentions"][number];
  roster: MentionRoster;
}) {
  const { intl } = useZCodeIntl();
  const presentation = projectMention(mention, roster);
  if (presentation.kind === "all") {
    return (
      <li
        className="text-ui-xs text-foreground-subtle"
        title={intl.formatMessage({ id: "squad.workItemDetail.mention.allHint" })}
      >
        {intl.formatMessage({ id: "squad.workItemDetail.mention.all" })}
      </li>
    );
  }
  if (presentation.kind === "agent") {
    return (
      <li className="flex items-center gap-1 text-ui-xs text-foreground">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", presentation.colorClass)} />
        <span>{`@${presentation.name}`}</span>
      </li>
    );
  }
  if (presentation.kind === "squad") {
    return (
      <li className="flex items-center gap-1 text-ui-xs text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full border border-foreground-subtlest"
        />
        <span>{`@${presentation.name}`}</span>
        <span className="text-foreground-subtlest">
          {intl.formatMessage({ id: "squad.workItemDetail.comment.sourceRole.leader" })}
        </span>
      </li>
    );
  }
  if (presentation.kind === "human") {
    /* 类型完备的防御分支（写者当前不产出 human mention，C2）：普通高对比文本 token，
       **不链接、不着色、不加 `?`** —— 它不是「解析失败」，只是人类。
       永远不因为展示失败把文本静默转成另一个 agent 链接。 */
    return <li className="text-ui-xs text-foreground">{`@${presentation.id}`}</li>;
  }
  // unresolved：名册里已不存在（含存储的未解析快照）⇒ 普通文本 + `?` 说明，绝不静默指向别的目标。
  return (
    <li
      className="flex items-center gap-1 text-ui-xs text-foreground-subtle"
      title={intl.formatMessage({ id: "squad.workItemDetail.mention.unresolved" })}
    >
      <span aria-hidden>?</span>
      <span>{`@${presentation.id}`}</span>
    </li>
  );
}
