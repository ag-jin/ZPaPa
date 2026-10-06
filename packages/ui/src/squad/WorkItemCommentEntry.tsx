import type { WorkItemCommentReactionRecord, WorkItemCommentRecord } from "@zcode/services";
import { FileCode, CircleCheckBig } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  commentDisplayBody,
  groupCommentReactions,
  projectMention,
  type MentionRoster,
} from "./workItemCollaborationViewModel.js";

/* B5.1 轮 1：单条评论的完整**只读状态空间**（设计案 §3.1 / §3.3）。

   本轮渲染但不执行任何写入：解决/重开入口（仅线程根）与回复入口都在，但前者是**明确不可用**
   （写面未接通，轮 2 落盘），后者只切换 composer 的回复上下文（本地草稿态，不是写入）。

   墓碑（软删）分支是一条**结构上的**分支：正文只经 `commentDisplayBody` 投影拿到，
   墓碑投影**根本没有正文字段**（`{kind:"deleted"}`）—— 组件里拿不到 normalizedBody / body，
   所以「删了还漏出原文」这件事在结构上凑不出来（R3）。 */

const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const BODY_CLASSNAME = "text-ui-base text-foreground leading-[1.5] whitespace-pre-wrap break-words";

export function WorkItemCommentEntry({
  comment,
  reactions,
  indent,
  parent,
  roster,
  onReply,
}: {
  comment: WorkItemCommentRecord;
  /** 本条评论的回应（由页面按评论分组后传入；分组是纯函数 `groupCommentReactions` 的活）。 */
  reactions: WorkItemCommentReactionRecord[];
  /** 由 `commentIndentLevel` 算好的层级（0..3，≥3 封顶）——组件不推断深度。 */
  indent: number;
  /** 直接父评论（「回复给 {name}」的输入；不可解析时为 null）。 */
  parent: WorkItemCommentRecord | null;
  roster: MentionRoster;
  /** 点「回复」：交给页面切回复上下文（本层不持有 composer 状态）。 */
  onReply: (comment: WorkItemCommentRecord) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const displayBody = commentDisplayBody(comment);
  const deleted = displayBody.kind === "deleted";
  // 解决态只属于**线程根**（设计案 §2.3：子回复不各自显示解决开关）。
  const isThreadRoot = comment.threadId === comment.id;
  /* 轮 1 无本地人类身份（D1/C5）⇒ `viewer = null` ⇒ `mine` 不可判定，界面不渲染 aria-pressed。
     回应在本轮是**只读聚合**（emoji + 计数），添加回应的菜单归轮 2。 */
  const reactionGroups = deleted ? [] : groupCommentReactions(reactions, null);

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
                <li
                  key={group.emoji}
                  className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-ui-xs text-foreground-subtle"
                >
                  <span aria-hidden>{group.emoji}</span>
                  <span>{group.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              data-testid="work-item-comment-reply"
              onClick={() => onReply(comment)}
            >
              {t("squad.workItemDetail.comment.reply")}
            </Button>
            {isThreadRoot ? (
              /* 解决/重开：根专属入口在轮 1 **渲染**（§7.1）但不可用 —— 写面未接通，
                 不给一个点了没反应的按钮（原因经 title/aria 说清，轮 2 接线）。 */
              <Button
                size="xs"
                variant="outline"
                disabled
                data-testid="work-item-comment-resolve"
                title={t("squad.workItemDetail.comment.disabled.writeUnavailable")}
              >
                {comment.resolvedAt === null
                  ? t("squad.workItemDetail.comment.resolve")
                  : t("squad.workItemDetail.comment.reopen")}
              </Button>
            ) : null}
          </div>
        </>
      )}
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
